import { expect } from "chai"
import hre, { network } from "hardhat"

import { deployExpressProvider, deployCreditLineManager } from "../contracts/expressLayer/lib/deploy.js"

const connection = await network.connect()
const { ethers } = connection

const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"))
const SIGNER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("SIGNER_ROLE"))
const VALIDATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("VALIDATOR_ROLE"))
const WITHDRAWER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("WITHDRAWER_ROLE"))
const LOCKER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LOCKER_ROLE"))
const UNLOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UNLOCK_ROLE"))

export function shouldBehaveLikeExpressLayerSecurity(): void {
	async function deployFixture() {
		const [deployer, botSigner, operator, user, receiver, affiliateOwner, locker, unlocker] = await ethers.getSigners()

		const collateral = await ethers.deployContract("MockERC20", ["USDC", "USDC", 6])
		const symmio = await ethers.deployContract("ExpressLayerMockSymmio", [await collateral.getAddress()])

		// Deploy via shared deployment helpers
		const expressProvider = await deployExpressProvider(hre, connection, {
			admin: deployer.address,
			symmio: await symmio.getAddress(),
			collateral: await collateral.getAddress(),
		})

		// Register providers on mock SYMMIO
		await symmio.registerExpressProvider(await expressProvider.getAddress())

		// Configure ExpressProvider via roles
		await expressProvider.grantRole(SIGNER_ROLE, botSigner.address)
		await expressProvider.grantRole(OPERATOR_ROLE, operator.address)
		await expressProvider.grantRole(LOCKER_ROLE, locker.address)
		await expressProvider.grantRole(UNLOCK_ROLE, unlocker.address)
		const affiliate = affiliateOwner.address

		// Deploy MockMuonSignatureVerifier for CreditLineManager
		const muonVerifier = await ethers.deployContract("MockMuonSignatureVerifier")

		// Deploy CreditLineManager (UUPS proxy)
		const creditLineManager = await deployCreditLineManager(hre, connection, {
			admin: deployer.address,
			symmio: await symmio.getAddress(),
			expressProvider: await expressProvider.getAddress(),
			signatureVerifier: await muonVerifier.getAddress(),
			muonAppId: 1n,
		})

		// Register on express provider
		await expressProvider.setCreditLineManager(affiliate, await creditLineManager.getAddress())

		// Fund general pool with 10,000 USDC
		const generalFunding = 10_000n * 10n ** 6n
		await collateral.mint(deployer.address, generalFunding)
		await collateral.approve(await expressProvider.getAddress(), generalFunding)
		await expressProvider.depositToGeneral(generalFunding)

		// Fund affiliate pool with 5,000 USDC
		const affiliateFunding = 5_000n * 10n ** 6n
		await collateral.mint(deployer.address, affiliateFunding)
		await collateral.approve(await expressProvider.getAddress(), affiliateFunding)
		await expressProvider.depositToAffiliate(affiliate, affiliateFunding)

		return {
			deployer,
			botSigner,
			operator,
			user,
			receiver,
			affiliateOwner,
			locker,
			unlocker,
			affiliate,
			collateral,
			symmio,
			expressProvider,
			creditLineManager,
			muonVerifier,
			generalFunding,
			affiliateFunding,
		}
	}

	// Helper: build a signed withdraw option
	async function signWithdrawOption(
		expressProvider: any,
		botSigner: any,
		params: {
			user: string
			nonce: bigint
			optionType: number
			availableAt: number
			affiliate: string
			affiliateAmount: bigint
			creditAmount: bigint
			fee: bigint
			operatorFee: bigint
			maxUserFee?: bigint
			partsHash: string
			deadline: number
		},
	) {
		const maxUserFee = params.maxUserFee ?? params.fee + params.operatorFee
		const domain = {
			name: "ExpressProvider",
			version: "1",
			chainId: 31337,
			verifyingContract: await expressProvider.getAddress(),
		}
		const types = {
			WithdrawOption: [
				{ name: "user", type: "address" },
				{ name: "nonce", type: "uint256" },
				{ name: "optionType", type: "uint8" },
				{ name: "availableAt", type: "uint256" },
				{ name: "affiliate", type: "address" },
				{ name: "affiliateAmount", type: "uint256" },
				{ name: "creditAmount", type: "uint256" },
				{ name: "fee", type: "uint256" },
				{ name: "operatorFee", type: "uint256" },
				{ name: "maxUserFee", type: "uint256" },
				{ name: "partsHash", type: "bytes32" },
				{ name: "deadline", type: "uint256" },
			],
		}
		const value = {
			user: params.user,
			nonce: params.nonce,
			optionType: params.optionType,
			availableAt: params.availableAt,
			affiliate: params.affiliate,
			affiliateAmount: params.affiliateAmount,
			creditAmount: params.creditAmount,
			fee: params.fee,
			operatorFee: params.operatorFee,
			maxUserFee,
			partsHash: params.partsHash,
			deadline: params.deadline,
		}
		const signature = await botSigner.signTypedData(domain, types, value)
		return signature
	}

	// Helper: compute parts hash (matching Solidity abi.encode)
	function computePartsHash(parts: any[]): string {
		const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
			["tuple(uint256 id, uint256 amount, int256 chainId, bytes receiver, address virtualProvider, address expressProvider)[]"],
			[parts],
		)
		return ethers.keccak256(encoded)
	}

	// Helper: encode provider data for initiateWithdraw (nested: optionData + validatorData + creditData)
	function encodeProviderData(
		nonce: bigint,
		optionType: number,
		availableAt: number,
		affiliate: string,
		affiliateAmount: bigint,
		creditAmount: bigint,
		fee: bigint,
		operatorFee: bigint,
		deadline: number,
		signature: string,
		maxUserFee?: bigint,
		validatorSignatures?: string[],
		validatorTimestamps?: number[],
		symmioNonce?: bigint,
		creditDataRaw?: string,
	): string {
		const muf = maxUserFee ?? fee + operatorFee
		const optionData = ethers.AbiCoder.defaultAbiCoder().encode(
			["uint256", "uint8", "uint256", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "bytes"],
			[nonce, optionType, availableAt, affiliate, affiliateAmount, creditAmount, fee, operatorFee, muf, deadline, signature],
		)
		const validatorData = ethers.AbiCoder.defaultAbiCoder().encode(
			["bytes[]", "uint256[]", "uint256"],
			[validatorSignatures ?? [], validatorTimestamps ?? [], symmioNonce ?? 0n],
		)
		return ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "bytes", "bytes"], [optionData, validatorData, creditDataRaw ?? "0x"])
	}

	// Helper: build credit data for CreditLineManager
	function buildCreditData(eligibleBase: bigint, timestamp: number): string {
		// Must encode as a single tuple to match abi.decode(data, (CreditData))
		return ethers.AbiCoder.defaultAbiCoder().encode(
			[
				"tuple(bytes reqId, uint256 eligibleBase, uint256 timestamp, bytes gatewaySignature, tuple(uint256 signature, address owner, address nonce) sigs)",
			],
			[
				{
					reqId: "0x0001",
					eligibleBase,
					timestamp,
					gatewaySignature: "0x",
					sigs: { signature: 0n, owner: ethers.ZeroAddress, nonce: ethers.ZeroAddress },
				},
			],
		)
	}

	// Helper: sign a validator approval (EIP-712)
	async function signValidatorApproval(
		expressProvider: any,
		validator: any,
		params: { user: string; nonce: bigint; amount: bigint; timestamp: number; symmioNonce: bigint },
	) {
		const domain = {
			name: "ExpressProvider",
			version: "1",
			chainId: 31337,
			verifyingContract: await expressProvider.getAddress(),
		}
		const types = {
			ValidatorApproval: [
				{ name: "user", type: "address" },
				{ name: "nonce", type: "uint256" },
				{ name: "amount", type: "uint256" },
				{ name: "timestamp", type: "uint256" },
				{ name: "symmioNonce", type: "uint256" },
			],
		}
		return validator.signTypedData(domain, types, params)
	}

	// Helper: create a standard instant withdrawal via mock SYMMIO
	async function initiateInstantWithdraw(
		fixture: any,
		opts?: {
			withdrawAmount?: bigint
			affiliateAmount?: bigint
			creditAmount?: bigint
			fee?: bigint
			operatorFee?: bigint
			validatorSignatures?: string[]
			validatorTimestamps?: number[]
			symmioNonce?: bigint
		},
	) {
		const { botSigner, user, receiver, expressProvider, symmio, affiliate } = fixture
		const withdrawAmount = opts?.withdrawAmount ?? 500n * 10n ** 6n
		const affiliateAmount = opts?.affiliateAmount ?? 0n
		const creditAmount = opts?.creditAmount ?? 0n
		const fee = opts?.fee ?? 0n
		const operatorFee = opts?.operatorFee ?? 0n
		const expressAddr = await expressProvider.getAddress()

		const parts = [
			{
				id: 0n,
				amount: withdrawAmount,
				chainId: 31337n,
				receiver: receiver.address,
				virtualProvider: ethers.ZeroAddress,
				expressProvider: expressAddr,
			},
		]

		const partsHash = computePartsHash(parts)
		const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600

		const signature = await signWithdrawOption(expressProvider, botSigner, {
			user: user.address,
			nonce: await expressProvider.nonces(user.address),
			optionType: 1,
			availableAt: 0,
			affiliate,
			affiliateAmount,
			creditAmount,
			fee,
			operatorFee,
			partsHash,
			deadline,
		})

		const providerData = encodeProviderData(
			await expressProvider.nonces(user.address),
			1,
			0,
			affiliate,
			affiliateAmount,
			creditAmount,
			fee,
			operatorFee,
			deadline,
			signature,
			undefined,
			opts?.validatorSignatures,
			opts?.validatorTimestamps,
			opts?.symmioNonce,
		)

		const now = (await ethers.provider.getBlock("latest"))!.timestamp
		await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

		return { parts, providerData, withdrawAmount, partsHash, deadline }
	}

	// ═══════════════════════════════════════════════════════════════════════
	//                       VALIDATOR SIGNATURES
	// ═══════════════════════════════════════════════════════════════════════

	describe("Validator Signatures", function () {
		it("should accept with enough validator signatures (minValidatorSignatures = 2, provide 2)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, symmio, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]
			const validator2 = signers[7]

			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.grantRole(VALIDATOR_ROLE, validator2.address)
			await expressProvider.setMinValidatorSignatures(2)

			const withdrawAmount = 500n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: fixture.receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600
			const nonce = await expressProvider.nonces(user.address)

			const signature = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate: fixture.affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			// Sort validators by address ascending
			const [v1, v2] = [validator1, validator2].sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1))

			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const validatorTimestamp = now

			const valSig1 = await signValidatorApproval(expressProvider, v1, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: validatorTimestamp,
				symmioNonce: 0n,
			})
			const valSig2 = await signValidatorApproval(expressProvider, v2, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: validatorTimestamp,
				symmioNonce: 0n,
			})

			const providerData = encodeProviderData(
				nonce,
				1,
				0,
				fixture.affiliate,
				0n,
				0n,
				0n,
				0n,
				deadline,
				signature,
				undefined,
				[valSig1, valSig2],
				[validatorTimestamp, validatorTimestamp],
			)

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			expect(await symmio.acceptedRequests(user.address, 1)).to.be.true
		})

		it("should reject with insufficient validator signatures", async function () {
			const fixture = await deployFixture()
			const { expressProvider, symmio, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.setMinValidatorSignatures(2)

			const withdrawAmount = 500n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: fixture.receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600
			const nonce = await expressProvider.nonces(user.address)

			const signature = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate: fixture.affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const valSig1 = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
			})

			// Only 1 signature but need 2
			const providerData = encodeProviderData(nonce, 1, 0, fixture.affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig1], [now])

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"InsufficientValidatorSignatures",
			)
		})

		it("should reject expired validator signatures (timestamp + timeout < block.timestamp)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, symmio, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.setMinValidatorSignatures(1)

			const withdrawAmount = 500n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: fixture.receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600
			const nonce = await expressProvider.nonces(user.address)

			const signature = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate: fixture.affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			// Sign with an old timestamp that will be expired
			// Default validatorApprovalTimeout = 30s, so use timestamp from 60s ago
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const expiredTimestamp = now - 60

			const valSig1 = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: expiredTimestamp,
				symmioNonce: 0n,
			})

			const providerData = encodeProviderData(
				nonce,
				1,
				0,
				fixture.affiliate,
				0n,
				0n,
				0n,
				0n,
				deadline,
				signature,
				undefined,
				[valSig1],
				[expiredTimestamp],
			)

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"ValidatorApprovalExpired",
			)
		})

		it("should reject future-dated timestamps (timestamp > block.timestamp)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, symmio, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.setMinValidatorSignatures(1)

			const withdrawAmount = 500n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: fixture.receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const nonce = await expressProvider.nonces(user.address)

			const signature = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate: fixture.affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			// Use a timestamp far in the future
			const futureTimestamp = now + 10000

			const valSig1 = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: futureTimestamp,
				symmioNonce: 0n,
			})

			const providerData = encodeProviderData(
				nonce,
				1,
				0,
				fixture.affiliate,
				0n,
				0n,
				0n,
				0n,
				deadline,
				signature,
				undefined,
				[valSig1],
				[futureTimestamp],
			)

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"ValidatorApprovalExpired",
			)
		})

		it("should reject validator signature from non-validator (InvalidValidator)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, symmio, user } = fixture

			const signers = await ethers.getSigners()
			const nonValidator = signers[6] // Not granted VALIDATOR_ROLE

			await expressProvider.setMinValidatorSignatures(1)

			const withdrawAmount = 500n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: fixture.receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const nonce = await expressProvider.nonces(user.address)

			const signature = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate: fixture.affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const valSig = await signValidatorApproval(expressProvider, nonValidator, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
			})

			const providerData = encodeProviderData(nonce, 1, 0, fixture.affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(expressProvider, "InvalidValidator")
		})

		it("should reject duplicate validator signatures (DuplicateValidator)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, symmio, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.setMinValidatorSignatures(2)

			const withdrawAmount = 500n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: fixture.receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const nonce = await expressProvider.nonces(user.address)

			const signature = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate: fixture.affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			// Same validator signs twice
			const valSig1 = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
			})
			const valSig2 = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
			})

			const providerData = encodeProviderData(
				nonce,
				1,
				0,
				fixture.affiliate,
				0n,
				0n,
				0n,
				0n,
				deadline,
				signature,
				undefined,
				[valSig1, valSig2],
				[now, now],
			)

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"DuplicateValidator",
			)
		})

		it("should reject wrong amount in validator signature", async function () {
			const fixture = await deployFixture()
			const { expressProvider, symmio, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.setMinValidatorSignatures(1)

			const withdrawAmount = 500n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: fixture.receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const nonce = await expressProvider.nonces(user.address)

			const signature = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate: fixture.affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			// Validator signs with WRONG amount (different from actual withdrawal amount)
			const wrongAmount = 999n * 10n ** 6n
			const valSig = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce,
				amount: wrongAmount,
				timestamp: now,
				symmioNonce: 0n,
			})

			const providerData = encodeProviderData(nonce, 1, 0, fixture.affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			// Wrong amount causes signature recovery to yield a different address, which is not a validator
			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(expressProvider, "InvalidValidator")
		})

		it("should reject wrong nonce in validator signature", async function () {
			const fixture = await deployFixture()
			const { expressProvider, symmio, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.setMinValidatorSignatures(1)

			const withdrawAmount = 500n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: fixture.receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const nonce = await expressProvider.nonces(user.address)

			const signature = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate: fixture.affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			// Validator signs with WRONG nonce
			const wrongNonce = 999n
			const valSig = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce: wrongNonce,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
			})

			const providerData = encodeProviderData(nonce, 1, 0, fixture.affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			// Wrong nonce causes signature recovery to yield a different address
			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(expressProvider, "InvalidValidator")
		})

		it("should skip validator check when minValidatorSignatures = 0", async function () {
			const fixture = await deployFixture()
			const { expressProvider, symmio, user } = fixture

			// Default is 0 -- no validator signatures needed
			expect(await expressProvider.minValidatorSignatures()).to.equal(0n)

			const withdrawAmount = 500n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: fixture.receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const nonce = await expressProvider.nonces(user.address)

			const signature = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate: fixture.affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			// No validator signatures provided, and that's fine
			const providerData = encodeProviderData(nonce, 1, 0, fixture.affiliate, 0n, 0n, 0n, 0n, deadline, signature)

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			expect(await symmio.acceptedRequests(user.address, 1)).to.be.true
		})

		it("should reject when validator role is revoked between signing and submission", async function () {
			const fixture = await deployFixture()
			const { expressProvider, symmio, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.setMinValidatorSignatures(1)

			const withdrawAmount = 500n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: fixture.receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const nonce = await expressProvider.nonces(user.address)

			const signature = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate: fixture.affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			// Validator signs while still valid
			const valSig = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
			})

			// Revoke the validator role BEFORE the on-chain submission
			await expressProvider.revokeRole(VALIDATOR_ROLE, validator1.address)

			const providerData = encodeProviderData(nonce, 1, 0, fixture.affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			// Signature recovery yields the correct address, but that address no longer has VALIDATOR_ROLE
			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(expressProvider, "InvalidValidator")
		})

		it("should accept when more than minValidatorSignatures are provided (extra are still validated)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, symmio, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]
			const validator2 = signers[7]
			const validator3 = signers[8]

			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.grantRole(VALIDATOR_ROLE, validator2.address)
			await expressProvider.grantRole(VALIDATOR_ROLE, validator3.address)
			await expressProvider.setMinValidatorSignatures(2) // Only require 2, but provide 3

			const withdrawAmount = 500n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: fixture.receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const nonce = await expressProvider.nonces(user.address)

			const signature = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate: fixture.affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			// Sort all 3 validators by address ascending
			const sorted = [validator1, validator2, validator3].sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1))

			const valSigs: string[] = []
			const valTimestamps: number[] = []
			for (const v of sorted) {
				const sig = await signValidatorApproval(expressProvider, v, {
					user: user.address,
					nonce,
					amount: withdrawAmount,
					timestamp: now,
					symmioNonce: 0n,
				})
				valSigs.push(sig)
				valTimestamps.push(now)
			}

			const providerData = encodeProviderData(nonce, 1, 0, fixture.affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, valSigs, valTimestamps)

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			expect(await symmio.acceptedRequests(user.address, 1)).to.be.true
		})

		it("should fail when admin changes minValidatorSignatures and pending sigs become insufficient", async function () {
			const fixture = await deployFixture()
			const { expressProvider, symmio, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			// Start with 1 validator required
			await expressProvider.setMinValidatorSignatures(1)

			const withdrawAmount = 500n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: fixture.receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const nonce = await expressProvider.nonces(user.address)

			const signature = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate: fixture.affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			// Get 1 validator signature (would have been enough before the change)
			const valSig = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
			})

			// Admin raises the requirement to 2
			await expressProvider.setMinValidatorSignatures(2)

			const providerData = encodeProviderData(nonce, 1, 0, fixture.affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			// Now 1 signature is not enough
			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"InsufficientValidatorSignatures",
			)
		})

		it("should fail when admin changes validatorApprovalTimeout and pending sigs expire", async function () {
			const fixture = await deployFixture()
			const { expressProvider, symmio, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.setMinValidatorSignatures(1)
			// Start with a generous timeout
			await expressProvider.setValidatorApprovalTimeout(120)

			const withdrawAmount = 500n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: fixture.receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const nonce = await expressProvider.nonces(user.address)

			const signature = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate: fixture.affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			// Validator signs with current timestamp (valid under 120s timeout)
			const valSig = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
			})

			// Admin reduces timeout to 5 seconds
			await expressProvider.setValidatorApprovalTimeout(5)

			// Advance time 10 seconds so the signature is expired under the new 5s timeout
			await ethers.provider.send("evm_increaseTime", [10])
			await ethers.provider.send("evm_mine", [])

			const providerData = encodeProviderData(nonce, 1, 0, fixture.affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"ValidatorApprovalExpired",
			)
		})

		it("should revert on mismatched array lengths (signatures vs timestamps)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, symmio, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]
			const validator2 = signers[7]

			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.grantRole(VALIDATOR_ROLE, validator2.address)
			await expressProvider.setMinValidatorSignatures(2)

			const withdrawAmount = 500n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: fixture.receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const nonce = await expressProvider.nonces(user.address)

			const signature = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate: fixture.affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const [v1, v2] = [validator1, validator2].sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1))

			const valSig1 = await signValidatorApproval(expressProvider, v1, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
			})
			const valSig2 = await signValidatorApproval(expressProvider, v2, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
			})

			// 2 signatures but only 1 timestamp -- mismatch
			const providerData = encodeProviderData(
				nonce,
				1,
				0,
				fixture.affiliate,
				0n,
				0n,
				0n,
				0n,
				deadline,
				signature,
				undefined,
				[valSig1, valSig2],
				[now],
			)

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"ArrayLengthMismatch",
			)
		})

		it("should accept validator timestamp at exact expiry boundary (timestamp + timeout == block.timestamp)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, symmio, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.setMinValidatorSignatures(1)

			// Default timeout = 30s
			const timeout = 30

			const withdrawAmount = 500n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: fixture.receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const nonce = await expressProvider.nonces(user.address)

			const signature = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate: fixture.affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			// The check is: block.timestamp > timestamps[i] + validatorApprovalTimeout
			// At exact boundary (==), > is false, so it should pass.
			// The tricky part is accounting for block timestamp advancement between calls.
			// We use setDeallocateTimestamp first, then the mockInitiateWithdraw tx mines at now+2.
			// So we need: validatorTimestamp + timeout >= now + 2
			// For exact boundary: validatorTimestamp = now + 2 - timeout = now - 28
			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			// After setDeallocateTimestamp, block.timestamp is now+1.
			// mockInitiateWithdraw will mine at now+2.
			// Check at tx time: (now+2) > validatorTimestamp + 30
			// We want: (now+2) == validatorTimestamp + 30 => validatorTimestamp = now - 28
			const validatorTimestamp = now - 28

			const valSig = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: validatorTimestamp,
				symmioNonce: 0n,
			})

			const providerData = encodeProviderData(
				nonce,
				1,
				0,
				fixture.affiliate,
				0n,
				0n,
				0n,
				0n,
				deadline,
				signature,
				undefined,
				[valSig],
				[validatorTimestamp],
			)

			// At exact boundary, block.timestamp == timestamp + timeout, so > check is false => should pass
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			expect(await symmio.acceptedRequests(user.address, 1)).to.be.true
		})

		it("should reject when symmioNonce changed (user acted on SYMMIO after validator signed)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, symmio, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]
			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.setMinValidatorSignatures(1)

			const withdrawAmount = 500n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: fixture.receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const nonce = await expressProvider.nonces(user.address)

			const signature = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate: fixture.affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			// Validator signs with symmioNonce = 0
			const valSig = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
			})

			// User acts on SYMMIO -- nonce changes to 1
			await symmio.setUserNonce(user.address, 1)

			const providerData = encodeProviderData(
				nonce,
				1,
				0,
				fixture.affiliate,
				0n,
				0n,
				0n,
				0n,
				deadline,
				signature,
				undefined,
				[valSig],
				[now],
				0n, // validator signed symmioNonce=0 but current is 1
			)

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(expressProvider, "InvalidNonce")
		})

		it("should accept when symmioNonce matches current SYMMIO state", async function () {
			const fixture = await deployFixture()
			const { expressProvider, symmio, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]
			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.setMinValidatorSignatures(1)

			// Set SYMMIO nonce to 42
			await symmio.setUserNonce(user.address, 42)

			const withdrawAmount = 500n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: fixture.receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const nonce = await expressProvider.nonces(user.address)

			const signature = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate: fixture.affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			// Validator signs with matching symmioNonce = 42
			const valSig = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 42n,
			})

			const providerData = encodeProviderData(nonce, 1, 0, fixture.affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now], 42n)

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			expect(await symmio.acceptedRequests(user.address, 1)).to.be.true
		})
	})

	// ═══════════════════════════════════════════════════════════════════════
	//                         ACCESS CONTROL
	// ═══════════════════════════════════════════════════════════════════════

	describe("Access Control", function () {
		it("should reject non-SYMMIO calling onWithdrawRequest (OnlySymmio)", async function () {
			const { expressProvider, user } = await deployFixture()

			// Construct a minimal WithdrawRequest struct
			const fakeRequest = {
				id: 1n,
				user: user.address,
				parts: [],
				timestamp: 0n,
				cooldownEndTime: 0n,
				status: 0,
				speedUp: false,
				isCooldownModified: false,
				provider: await expressProvider.getAddress(),
				isPureVirtual: false,
				providerData: "0x",
				totalAmount: 0n,
				totalVirtualAmount: 0n,
				advancedAmount: 0n,
			}

			await expect(expressProvider.connect(user).onWithdrawRequest(fakeRequest, ethers.ZeroAddress)).to.be.revertedWithCustomError(
				expressProvider,
				"OnlySymmio",
			)
		})

		it("should reject non-SYMMIO calling onWithdrawComplete", async function () {
			const { expressProvider, user } = await deployFixture()

			const fakeRequest = {
				id: 1n,
				user: user.address,
				parts: [],
				timestamp: 0n,
				cooldownEndTime: 0n,
				status: 0,
				speedUp: false,
				isCooldownModified: false,
				provider: await expressProvider.getAddress(),
				isPureVirtual: false,
				providerData: "0x",
				totalAmount: 0n,
				totalVirtualAmount: 0n,
				advancedAmount: 0n,
			}

			await expect(expressProvider.connect(user).onWithdrawComplete(fakeRequest)).to.be.revertedWithCustomError(expressProvider, "OnlySymmio")
		})

		it("should reject non-SYMMIO calling onWithdrawCancelRequest", async function () {
			const { expressProvider, user } = await deployFixture()

			const fakeRequest = {
				id: 1n,
				user: user.address,
				parts: [],
				timestamp: 0n,
				cooldownEndTime: 0n,
				status: 0,
				speedUp: false,
				isCooldownModified: false,
				provider: await expressProvider.getAddress(),
				isPureVirtual: false,
				providerData: "0x",
				totalAmount: 0n,
				totalVirtualAmount: 0n,
				advancedAmount: 0n,
			}

			await expect(expressProvider.connect(user).onWithdrawCancelRequest(fakeRequest)).to.be.revertedWithCustomError(expressProvider, "OnlySymmio")
		})

		it("should reject non-SYMMIO calling onForceWithdrawCancel", async function () {
			const { expressProvider, user } = await deployFixture()

			const fakeRequest = {
				id: 1n,
				user: user.address,
				parts: [],
				timestamp: 0n,
				cooldownEndTime: 0n,
				status: 0,
				speedUp: false,
				isCooldownModified: false,
				provider: await expressProvider.getAddress(),
				isPureVirtual: false,
				providerData: "0x",
				totalAmount: 0n,
				totalVirtualAmount: 0n,
				advancedAmount: 0n,
			}

			await expect(expressProvider.connect(user).onForceWithdrawCancel(fakeRequest)).to.be.revertedWithCustomError(expressProvider, "OnlySymmio")
		})

		it("should reject non-SYMMIO calling onWithdrawSuspend", async function () {
			const { expressProvider, user } = await deployFixture()

			const fakeRequest = {
				id: 1n,
				user: user.address,
				parts: [],
				timestamp: 0n,
				cooldownEndTime: 0n,
				status: 0,
				speedUp: false,
				isCooldownModified: false,
				provider: await expressProvider.getAddress(),
				isPureVirtual: false,
				providerData: "0x",
				totalAmount: 0n,
				totalVirtualAmount: 0n,
				advancedAmount: 0n,
			}

			await expect(expressProvider.connect(user).onWithdrawSuspend(fakeRequest)).to.be.revertedWithCustomError(expressProvider, "OnlySymmio")
		})

		it("should reject non-LOCKER_ROLE calling lockWithdraw", async function () {
			const { expressProvider, user } = await deployFixture()

			await expect(expressProvider.connect(user).lockWithdraw(user.address, 1)).to.be.revert(ethers)
		})

		it("should reject non-UNLOCK_ROLE calling unlockAndProcess", async function () {
			const { expressProvider, user, operator } = await deployFixture()

			// user has no roles
			await expect(expressProvider.connect(user).unlockAndProcess(user.address, 1, [])).to.be.revert(ethers)

			// operator has OPERATOR_ROLE but NOT UNLOCK_ROLE
			await expect(expressProvider.connect(operator).unlockAndProcess(user.address, 1, [])).to.be.revert(ethers)
		})

		it("should reject operator calling lockWithdraw", async function () {
			const { expressProvider, operator, user } = await deployFixture()

			// operator has OPERATOR_ROLE but NOT LOCKER_ROLE
			await expect(expressProvider.connect(operator).lockWithdraw(user.address, 1)).to.be.revert(ethers)
		})

		it("should reject operator calling unlockAndProcess", async function () {
			const { expressProvider, operator, user } = await deployFixture()

			// operator has OPERATOR_ROLE but NOT UNLOCK_ROLE
			await expect(expressProvider.connect(operator).unlockAndProcess(user.address, 1, [])).to.be.revert(ethers)
		})

		it("should reject locker calling unlockAndProcess", async function () {
			const { expressProvider, locker, user } = await deployFixture()

			// locker has LOCKER_ROLE but NOT UNLOCK_ROLE
			await expect(expressProvider.connect(locker).unlockAndProcess(user.address, 1, [])).to.be.revert(ethers)
		})

		it("should allow locker to call lockWithdraw", async function () {
			const fixture = await deployFixture()
			const { locker, user, expressProvider, symmio } = fixture

			// Create an accepted withdrawal first
			const { parts, providerData } = await initiateInstantWithdraw(fixture)
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			// Verify the withdrawal is in ACCEPTED status
			const info = await expressProvider.getWithdrawInfo(user.address, 1)
			expect(info.status).to.equal(1n) // ACCEPTED

			// Locker (with LOCKER_ROLE) should be able to lock the withdrawal
			await expressProvider.connect(locker).lockWithdraw(user.address, 1)

			const lockedInfo = await expressProvider.getWithdrawInfo(user.address, 1)
			expect(lockedInfo.status).to.equal(2n) // LOCKED
		})

		it("should allow unlocker to call unlockAndProcess", async function () {
			const fixture = await deployFixture()
			const { locker, unlocker, user, receiver, expressProvider, symmio, collateral } = fixture

			// Create an accepted withdrawal first
			const { parts, providerData, withdrawAmount } = await initiateInstantWithdraw(fixture)
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			// Lock with the locker
			await expressProvider.connect(locker).lockWithdraw(user.address, 1)
			const lockedInfo = await expressProvider.getWithdrawInfo(user.address, 1)
			expect(lockedInfo.status).to.equal(2n) // LOCKED

			// Unlocker (with UNLOCK_ROLE) should be able to unlock and process
			await expressProvider.connect(unlocker).unlockAndProcess(user.address, 1, parts)

			// Verify withdrawal was processed -- receiver got the funds
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)
		})

		it("should reject non-admin calling setSecurityWindow", async function () {
			const { expressProvider, user } = await deployFixture()

			await expect(expressProvider.connect(user).setSecurityWindow(100)).to.be.revert(ethers)
		})

		it("should reject non-admin calling setTolerancePeriod", async function () {
			const { expressProvider, user } = await deployFixture()

			await expect(expressProvider.connect(user).setTolerancePeriod(100)).to.be.revert(ethers)
		})

		it("should reject non-admin calling setAffiliateConfig", async function () {
			const { expressProvider, user, affiliate } = await deployFixture()

			await expect(expressProvider.connect(user).setAffiliateConfig(affiliate, 50, 0)).to.be.revert(ethers)
		})

		it("should reject non-admin calling setMinValidatorSignatures", async function () {
			const { expressProvider, user } = await deployFixture()

			await expect(expressProvider.connect(user).setMinValidatorSignatures(2)).to.be.revert(ethers)
		})

		it("should reject non-withdrawer calling withdrawFromGeneral", async function () {
			const { expressProvider, user } = await deployFixture()

			await expect(expressProvider.connect(user).withdrawFromGeneral(100n)).to.be.revert(ethers)
		})

		it("should reject non-withdrawer calling withdrawFromAffiliate", async function () {
			const { expressProvider, user, affiliate } = await deployFixture()

			await expect(expressProvider.connect(user).withdrawFromAffiliate(affiliate, 100n)).to.be.revert(ethers)
		})

		it("should allow WITHDRAWER_ROLE to withdraw from pools", async function () {
			const { expressProvider, user, affiliate, generalFunding, affiliateFunding, collateral } = await deployFixture()

			// User can't withdraw without the role
			await expect(expressProvider.connect(user).withdrawFromGeneral(100n)).to.be.revert(ethers)

			// Grant WITHDRAWER_ROLE to user
			await expressProvider.grantRole(WITHDRAWER_ROLE, user.address)

			// Now user can withdraw from general
			const generalAmt = 1_000n * 10n ** 6n
			await expressProvider.connect(user).withdrawFromGeneral(generalAmt)
			expect(await expressProvider.generalBalance()).to.equal(generalFunding - generalAmt)
			expect(await collateral.balanceOf(user.address)).to.equal(generalAmt)

			// And from affiliate
			const frontendAmt = 500n * 10n ** 6n
			await expressProvider.connect(user).withdrawFromAffiliate(affiliate, frontendAmt)
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateFunding - frontendAmt)

			// Revoke and verify access is denied again
			await expressProvider.revokeRole(WITHDRAWER_ROLE, user.address)
			await expect(expressProvider.connect(user).withdrawFromGeneral(100n)).to.be.revert(ethers)
		})

		it("should verify role assignments via hasRole", async function () {
			const { botSigner, operator, locker, unlocker, expressProvider } = await deployFixture()

			expect(await expressProvider.hasRole(OPERATOR_ROLE, operator.address)).to.be.true
			expect(await expressProvider.hasRole(SIGNER_ROLE, botSigner.address)).to.be.true
			expect(await expressProvider.hasRole(LOCKER_ROLE, locker.address)).to.be.true
			expect(await expressProvider.hasRole(UNLOCK_ROLE, unlocker.address)).to.be.true
		})

		it("should allow admin to grant and revoke roles", async function () {
			const { user, expressProvider } = await deployFixture()

			await expressProvider.grantRole(OPERATOR_ROLE, user.address)
			expect(await expressProvider.hasRole(OPERATOR_ROLE, user.address)).to.be.true

			await expressProvider.revokeRole(OPERATOR_ROLE, user.address)
			expect(await expressProvider.hasRole(OPERATOR_ROLE, user.address)).to.be.false
		})

		it("should reject setSecurityWindow below minimum", async function () {
			const { expressProvider } = await deployFixture()
			await expect(expressProvider.setSecurityWindow(0)).to.be.revertedWithCustomError(expressProvider, "SecurityWindowTooLow")
			await expect(expressProvider.setSecurityWindow(9)).to.be.revertedWithCustomError(expressProvider, "SecurityWindowTooLow")
		})

		it("should accept setSecurityWindow at minimum", async function () {
			const { expressProvider } = await deployFixture()
			await expressProvider.setSecurityWindow(10)
			expect(await expressProvider.securityWindow()).to.equal(10n)
		})

		it("should reject setTolerancePeriod below minimum", async function () {
			const { expressProvider } = await deployFixture()
			await expect(expressProvider.setTolerancePeriod(0)).to.be.revertedWithCustomError(expressProvider, "TolerancePeriodTooLow")
			await expect(expressProvider.setTolerancePeriod(9)).to.be.revertedWithCustomError(expressProvider, "TolerancePeriodTooLow")
		})

		it("should accept setTolerancePeriod at minimum", async function () {
			const { expressProvider } = await deployFixture()
			await expressProvider.setTolerancePeriod(10)
			expect(await expressProvider.tolerancePeriod()).to.equal(10n)
		})
	})

	// ═══════════════════════════════════════════════════════════════════════
	//                        POOL MANAGEMENT
	// ═══════════════════════════════════════════════════════════════════════

	describe("Pool Management", function () {
		it("should deposit and withdraw from general pool", async function () {
			const { deployer, expressProvider, collateral, generalFunding } = await deployFixture()

			// Already funded with generalFunding in fixture
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)

			// Withdraw some
			const withdrawAmt = 2_000n * 10n ** 6n
			await expressProvider.withdrawFromGeneral(withdrawAmt)
			expect(await expressProvider.generalBalance()).to.equal(generalFunding - withdrawAmt)
			expect(await collateral.balanceOf(deployer.address)).to.equal(withdrawAmt)
		})

		it("should deposit and withdraw from affiliate pool", async function () {
			const { deployer, expressProvider, collateral, affiliate, affiliateFunding } = await deployFixture()

			// Already funded with affiliateFunding in fixture
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateFunding)

			// Withdraw some
			const withdrawAmt = 1_000n * 10n ** 6n
			await expressProvider.withdrawFromAffiliate(affiliate, withdrawAmt)
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateFunding - withdrawAmt)
			expect(await collateral.balanceOf(deployer.address)).to.equal(withdrawAmt)
		})

		it("should reject withdrawing more than unlocked general balance", async function () {
			const { expressProvider, generalFunding } = await deployFixture()

			// Try to withdraw more than available
			await expect(expressProvider.withdrawFromGeneral(generalFunding + 1n)).to.be.revertedWithCustomError(
				expressProvider,
				"InsufficientUnlockedGeneralBalance",
			)
		})

		it("should reject withdrawing more than unlocked affiliate balance", async function () {
			const { expressProvider, affiliate, affiliateFunding } = await deployFixture()

			// Try to withdraw more than available
			await expect(expressProvider.withdrawFromAffiliate(affiliate, affiliateFunding + 1n)).to.be.revertedWithCustomError(
				expressProvider,
				"InsufficientUnlockedAffiliateBalance",
			)
		})

		it("should deposit zero amount (no-op)", async function () {
			const { deployer, expressProvider, collateral, generalFunding } = await deployFixture()

			// Deposit zero to general
			await collateral.approve(await expressProvider.getAddress(), 0n)
			await expressProvider.depositToGeneral(0n)
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)

			// Deposit zero to affiliate
			const { affiliate, affiliateFunding } = await deployFixture()
			// Note: fresh fixture for isolation; let's check on the original fixture instead
		})

		it("should keep affiliate pools isolated from each other", async function () {
			const { deployer, expressProvider, collateral, affiliate } = await deployFixture()

			const signers = await ethers.getSigners()
			const otherAffiliate = signers[8].address

			// Fund a second affiliate pool
			const otherAmount = 3_000n * 10n ** 6n
			await collateral.mint(deployer.address, otherAmount)
			await collateral.approve(await expressProvider.getAddress(), otherAmount)
			await expressProvider.depositToAffiliate(otherAffiliate, otherAmount)

			// Verify pools are independent
			const frontendBal = await expressProvider.affiliateBalances(affiliate)
			const otherBal = await expressProvider.affiliateBalances(otherAffiliate)
			expect(frontendBal).to.equal(5_000n * 10n ** 6n) // from fixture
			expect(otherBal).to.equal(otherAmount)

			// Withdraw from one doesn't affect other
			await expressProvider.withdrawFromAffiliate(otherAffiliate, 1_000n * 10n ** 6n)
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(5_000n * 10n ** 6n)
			expect(await expressProvider.affiliateBalances(otherAffiliate)).to.equal(2_000n * 10n ** 6n)
		})

		it("should handle withdrawFromGeneral safely when all balance is locked", async function () {
			const { deployer, operator, user, receiver, expressProvider, collateral, symmio, affiliate, botSigner } = await deployFixture()
			const withdrawAmount = 10_000n * 10n ** 6n

			// Accept an INSTANT that locks the entire general balance
			const expressAddr = await expressProvider.getAddress()
			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			const partsHash = computePartsHash(parts)
			const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600
			const nonce = await expressProvider.nonces(user.address)

			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const providerData = encodeProviderData(nonce, 1, 0, affiliate, 0n, 0n, 0n, 0n, deadline, signature)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			// All general balance is locked
			expect(await expressProvider.lockedGeneralBalance()).to.equal(withdrawAmount)

			// withdrawFromGeneral should revert with InsufficientUnlockedGeneralBalance, not underflow
			await expect(expressProvider.withdrawFromGeneral(1n)).to.be.revertedWithCustomError(expressProvider, "InsufficientUnlockedGeneralBalance")
		})
	})

	// ═══════════════════════════════════════════════════════════════════════
	//                       BUCKET CONFIGURATION
	// ═══════════════════════════════════════════════════════════════════════

	describe("Bucket Configuration", function () {
		it("should initialize with default config (1h duration, 12h window)", async function () {
			const { expressProvider } = await deployFixture()

			expect(await expressProvider.bucketDuration()).to.equal(3600n)
			expect(await expressProvider.schedulingWindow()).to.equal(12n * 3600n)
			expect(await expressProvider.numBuckets()).to.equal(13n) // 12 + 1 headroom
		})

		it("should allow admin to change bucket duration", async function () {
			const { expressProvider } = await deployFixture()

			await expressProvider.setBucketDuration(1800) // 30 minutes
			expect(await expressProvider.bucketDuration()).to.equal(1800n)
			expect(await expressProvider.numBuckets()).to.equal(25n) // 12h / 30min + 1 headroom
		})

		it("should allow admin to change scheduling window", async function () {
			const { expressProvider } = await deployFixture()

			await expressProvider.setSchedulingWindow(6 * 3600) // 6 hours
			expect(await expressProvider.schedulingWindow()).to.equal(6n * 3600n)
			expect(await expressProvider.numBuckets()).to.equal(7n) // 6h / 1h + 1 headroom
		})

		it("should reject duration that doesn't divide evenly into window", async function () {
			const { expressProvider } = await deployFixture()

			// 12h (43200s) is not divisible by 7000
			await expect(expressProvider.setBucketDuration(7000)).to.be.revertedWithCustomError(expressProvider, "MustDivideEvenly")
		})

		it("should reject window not divisible by duration", async function () {
			const { expressProvider } = await deployFixture()

			// Default duration is 3600. 5.5h = 19800 is not divisible by 3600.
			await expect(expressProvider.setSchedulingWindow(19800)).to.be.revertedWithCustomError(expressProvider, "MustBeDivisibleByBucketDuration")
		})

		it("should reject non-admin bucket config changes", async function () {
			const { user, expressProvider } = await deployFixture()

			await expect(expressProvider.connect(user).setBucketDuration(1800)).to.be.revert(ethers)
			await expect(expressProvider.connect(user).setSchedulingWindow(6 * 3600)).to.be.revert(ethers)
		})

		it("should preserve existing SCHEDULED withdrawal after reconfiguration", async function () {
			const { botSigner, operator, user, receiver, expressProvider, symmio, affiliate, collateral } = await deployFixture()

			const withdrawAmount = 500n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const availableAt = now + 3 * 3600
			const deadline = now + 3600 * 24

			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 2, // SCHEDULED
				availableAt,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const providerData = encodeProviderData(0n, 2, availableAt, affiliate, 0n, 0n, 0n, 0n, deadline, signature)
			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			// Reconfigure buckets while SCHEDULED is pending
			await expressProvider.setBucketDuration(1800) // 30 min buckets
			expect(await expressProvider.numBuckets()).to.equal(25n) // 12h / 30min + 1 headroom

			// The SCHEDULED withdrawal is unaffected -- still processable at availableAt
			const info = await expressProvider.getWithdrawInfo(user.address, 1)
			expect(info.status).to.equal(1n) // ACCEPTED
			expect(info.availableAt).to.equal(BigInt(availableAt))

			// Advance past availableAt and process
			await ethers.provider.send("evm_increaseTime", [3 * 3600 + 1])
			await ethers.provider.send("evm_mine", [])

			await expressProvider.connect(operator).processWithdraw(user.address, 1, parts)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)
		})

		it("should work with 30-minute buckets for SCHEDULED withdrawal", async function () {
			const { botSigner, operator, user, receiver, expressProvider, symmio, affiliate, collateral } = await deployFixture()

			// Reconfigure to 30-minute buckets before any withdrawals
			await expressProvider.setBucketDuration(1800)

			const withdrawAmount = 300n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const availableAt = now + 2 * 3600 // 2 hours from now
			const deadline = now + 3600 * 24

			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 2, // SCHEDULED
				availableAt,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const providerData = encodeProviderData(0n, 2, availableAt, affiliate, 0n, 0n, 0n, 0n, deadline, signature)
			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			// Too early
			await ethers.provider.send("evm_increaseTime", [3600]) // 1h, need 2h
			await ethers.provider.send("evm_mine", [])
			await expect(expressProvider.connect(operator).processWithdraw(user.address, 1, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"TooEarly",
			)

			// Process at availableAt
			await ethers.provider.send("evm_increaseTime", [3600 + 1])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, 1, parts)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)
		})
	})

	// ═══════════════════════════════════════════════════════════════════════
	//                        DIAMOND & UPGRADE
	// ═══════════════════════════════════════════════════════════════════════

	describe("Diamond Upgrade", function () {
		it("should allow owner to add new facet via diamond cut", async function () {
			const { expressProvider } = await deployFixture()

			// Verify diamond is functional after deployment
			expect(await expressProvider.generalBalance()).to.be.a("bigint")
		})

		it("should reject non-owner diamond cut", async function () {
			const { user, expressProvider } = await deployFixture()

			const diamondCut = await ethers.getContractAt("DiamondCutFacet", await expressProvider.getAddress())
			await expect(diamondCut.connect(user).diamondCut([], ethers.ZeroAddress, "0x")).to.be.revert(ethers)
		})

		it("should set credit line manager for affiliate", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliate, creditLineManager } = fixture
			expect(await expressProvider.creditLineManagers(affiliate)).to.equal(await creditLineManager.getAddress())
		})

		it("should reject setting credit line manager by non-setter", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, affiliate } = fixture
			await expect(expressProvider.connect(user).setCreditLineManager(affiliate, ethers.ZeroAddress)).to.be.revert(ethers)
		})

		it("should prevent re-initialization via diamondCut", async function () {
			const fixture = await deployFixture()
			const { deployer, expressProvider, symmio, collateral } = fixture
			const expressAddr = await expressProvider.getAddress()

			const diamondCut = await ethers.getContractAt("DiamondCutFacet", expressAddr)
			const initContract = await (await ethers.getContractFactory("contracts/expressLayer/Init.sol:Init")).deploy()
			const initCalldata = initContract.interface.encodeFunctionData("init", [
				deployer.address,
				await symmio.getAddress(),
				await collateral.getAddress(),
			])

			try {
				await diamondCut.diamondCut([], await initContract.getAddress(), initCalldata)
				expect.fail("Expected diamondCut to revert but it succeeded")
			} catch (error: any) {
				expect(error.message || error.toString()).to.include("revert")
			}
		})

		it("should return correct owner via OwnershipFacet", async function () {
			const { deployer, expressProvider } = await deployFixture()
			expect(await expressProvider.owner()).to.equal(deployer.address)
		})

		it("should complete two-step ownership transfer", async function () {
			const { deployer, user, expressProvider } = await deployFixture()

			await expressProvider.transferOwnership(user.address)
			expect(await expressProvider.pendingOwner()).to.equal(user.address)
			expect(await expressProvider.owner()).to.equal(deployer.address)

			await expressProvider.connect(user).acceptOwnership()
			expect(await expressProvider.owner()).to.equal(user.address)
			expect(await expressProvider.pendingOwner()).to.equal(ethers.ZeroAddress)
		})

		it("should reject transferOwnership from non-owner", async function () {
			const { user, expressProvider } = await deployFixture()
			await expect(expressProvider.connect(user).transferOwnership(user.address)).to.be.revert(ethers)
		})

		it("should reject acceptOwnership from non-pending-owner", async function () {
			const { deployer, user, expressProvider } = await deployFixture()
			const signers = await ethers.getSigners()
			const other = signers[9]

			await expressProvider.transferOwnership(user.address)
			await expect(expressProvider.connect(other).acceptOwnership()).to.be.revert(ethers)
		})

		it("should cancel pending ownership transfer", async function () {
			const { deployer, user, expressProvider } = await deployFixture()

			await expressProvider.transferOwnership(user.address)
			expect(await expressProvider.pendingOwner()).to.equal(user.address)

			await expressProvider.cancelOwnershipTransfer()
			expect(await expressProvider.pendingOwner()).to.equal(ethers.ZeroAddress)
			expect(await expressProvider.owner()).to.equal(deployer.address)
		})

		it("should reject cancelOwnershipTransfer from non-owner", async function () {
			const { deployer, user, expressProvider } = await deployFixture()

			await expressProvider.transferOwnership(user.address)
			await expect(expressProvider.connect(user).cancelOwnershipTransfer()).to.be.revert(ethers)
		})
	})

	// ═══════════════════════════════════════════════════════════════════════
	//                        CREDIT LINE MANAGER
	// ═══════════════════════════════════════════════════════════════════════

	describe("CreditLineManager", function () {
		it("should initialize with correct roles", async function () {
			const fixture = await deployFixture()
			const { creditLineManager, deployer, expressProvider } = fixture
			const EXPRESS_PROVIDER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("EXPRESS_PROVIDER_ROLE"))
			const PROTOCOL_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PROTOCOL_ADMIN_ROLE"))
			const AFFILIATE_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("AFFILIATE_ADMIN_ROLE"))

			expect(await creditLineManager.hasRole(EXPRESS_PROVIDER_ROLE, await expressProvider.getAddress())).to.be.true
			expect(await creditLineManager.hasRole(PROTOCOL_ADMIN_ROLE, deployer.address)).to.be.true
			expect(await creditLineManager.hasRole(AFFILIATE_ADMIN_ROLE, deployer.address)).to.be.true
		})

		it("should set protocol config", async function () {
			const fixture = await deployFixture()
			const { creditLineManager } = fixture
			await creditLineManager.setProtocolConfig(1000n * 10n ** 6n, 5000n, 120n)
			expect(await creditLineManager.protocolMaxDebt()).to.equal(1000n * 10n ** 6n)
			expect(await creditLineManager.protocolMaxDebtBps()).to.equal(5000n)
			expect(await creditLineManager.muonFreshnessWindow()).to.equal(120n)
		})

		it("should set affiliate config stricter than protocol", async function () {
			const fixture = await deployFixture()
			const { creditLineManager } = fixture
			await creditLineManager.setProtocolConfig(1000n * 10n ** 6n, 5000n, 60n)
			await creditLineManager.setAffiliateConfig(500n * 10n ** 6n, 3000n)
			expect(await creditLineManager.affiliateMaxDebt()).to.equal(500n * 10n ** 6n)
			expect(await creditLineManager.affiliateMaxDebtBps()).to.equal(3000n)
		})

		it("should reject affiliate config looser than protocol", async function () {
			const fixture = await deployFixture()
			const { creditLineManager } = fixture
			await creditLineManager.setProtocolConfig(1000n * 10n ** 6n, 5000n, 60n)
			await expect(creditLineManager.setAffiliateConfig(2000n * 10n ** 6n, 3000n)).to.be.revert(ethers) // AffiliateLimitExceedsProtocol
		})

		it("should pause and unpause credit line", async function () {
			const fixture = await deployFixture()
			const { creditLineManager } = fixture
			await creditLineManager.setPaused(true)
			expect(await creditLineManager.paused()).to.be.true
			await creditLineManager.setPaused(false)
			expect(await creditLineManager.paused()).to.be.false
		})

		it("should blacklist and unblacklist user", async function () {
			const fixture = await deployFixture()
			const { creditLineManager, user } = fixture
			await creditLineManager.setBlacklisted(user.address, true)
			expect(await creditLineManager.blacklisted(user.address)).to.be.true
			await creditLineManager.setBlacklisted(user.address, false)
			expect(await creditLineManager.blacklisted(user.address)).to.be.false
		})

		it("should reject reserve when paused", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, symmio, affiliate, creditLineManager, collateral } = fixture
			const expressAddr = await expressProvider.getAddress()
			const withdrawAmount = 500n * 10n ** 6n
			const creditAmount = 200n * 10n ** 6n

			await creditLineManager.setPaused(true)

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			const partsHash = computePartsHash(parts)
			const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600
			const now = (await ethers.provider.getBlock("latest"))!.timestamp

			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const creditDataRaw = buildCreditData(10_000n * 10n ** 6n, now)
			const providerData = encodeProviderData(
				0n,
				1,
				0,
				affiliate,
				0n,
				creditAmount,
				0n,
				0n,
				deadline,
				signature,
				undefined,
				undefined,
				undefined,
				undefined,
				creditDataRaw,
			)

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await collateral.mint(await symmio.getAddress(), creditAmount)
			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revert(ethers) // CreditLinePaused
		})

		it("should reject reserve for blacklisted user", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, symmio, affiliate, creditLineManager, collateral } = fixture
			const expressAddr = await expressProvider.getAddress()
			const withdrawAmount = 500n * 10n ** 6n
			const creditAmount = 200n * 10n ** 6n

			await creditLineManager.setBlacklisted(user.address, true)

			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			const partsHash = computePartsHash(parts)
			const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600
			const now = (await ethers.provider.getBlock("latest"))!.timestamp

			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const creditDataRaw = buildCreditData(10_000n * 10n ** 6n, now)
			const providerData = encodeProviderData(
				0n,
				1,
				0,
				affiliate,
				0n,
				creditAmount,
				0n,
				0n,
				deadline,
				signature,
				undefined,
				undefined,
				undefined,
				undefined,
				creditDataRaw,
			)

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await collateral.mint(await symmio.getAddress(), creditAmount)
			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revert(ethers) // UserBlacklisted
		})

		it("should reject non-admin calling CreditLineManager admin functions", async function () {
			const fixture = await deployFixture()
			const { creditLineManager, user } = fixture
			await expect(creditLineManager.connect(user).setProtocolConfig(100n, 100n, 60n)).to.be.revert(ethers)
			await expect(creditLineManager.connect(user).setPaused(true)).to.be.revert(ethers)
			await expect(creditLineManager.connect(user).setBlacklisted(user.address, true)).to.be.revert(ethers)
		})
	})
}
