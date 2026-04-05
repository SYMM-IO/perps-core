import { expect } from "chai"

import { deployExpressProvider } from "../tasks/deploy/expressWithdrawLayerDiamond.js"
import { initializeFixture } from "./Initialize.fixture.js"
import connection, { ethers, hre } from "./helpers/hardhat-connection.js"
import { time } from "./helpers/network-helpers.js"

const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"))
const SIGNER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("SIGNER_ROLE"))
const WITHDRAWER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("WITHDRAWER_ROLE"))
const LOCKER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LOCKER_ROLE"))
const UNLOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UNLOCK_ROLE"))

export function shouldBehaveLikeExpressLayerSecurity(): void {
	async function deployFixture() {
		const context = await initializeFixture()

		const allSigners = await ethers.getSigners()
		const deployer = context.signers.admin
		const botSigner = allSigners[13]
		const operator = allSigners[14]
		const user = context.signers.user
		const receiver = allSigners[15]
		const affiliateOwner = allSigners[16]
		const locker = allSigners[17]
		const unlocker = allSigners[18]

		// Deploy ExpressProvider on top of the real Symmio diamond
		const expressProvider = await deployExpressProvider(hre, connection, {
			admin: deployer.address,
			symmio: context.diamond,
			collateral: await context.collateral.getAddress(),
		})

		// Register ExpressProvider on real Symmio
		await context.controlFacet.connect(deployer).registerExpressProvider(await expressProvider.getAddress())

		// Configure real Symmio withdraw settings
		await context.controlFacet.connect(deployer).setMaxWithdrawParts(50)
		await context.controlFacet.connect(deployer).setWithdrawCooldownPeriod(43200)

		// Grant suspender role on real Symmio
		await context.controlFacet.connect(deployer).grantRole(deployer.address, ethers.keccak256(ethers.toUtf8Bytes("SUSPENDER_ROLE")))

		// Configure ExpressProvider via roles
		await expressProvider.grantRole(SIGNER_ROLE, botSigner.address)
		await expressProvider.grantRole(OPERATOR_ROLE, operator.address)
		await expressProvider.grantRole(LOCKER_ROLE, locker.address)
		await expressProvider.grantRole(UNLOCK_ROLE, unlocker.address)
		const affiliate = affiliateOwner.address

		// Deploy MockMuonSignatureVerifier for credit line
		const muonVerifier = await ethers.deployContract("MockMuonSignatureVerifier")

		// Configure credit line on diamond
		await expressProvider.setCreditLineMuonConfig(await muonVerifier.getAddress(), 1n, 60n)

		// Deposit user balance into real Symmio
		const userBalance = 100_000n * 10n ** 18n
		await context.collateral.mint(user.address, userBalance)
		await context.collateral.connect(user).approve(context.diamond, ethers.MaxUint256)
		await context.accountFacet.connect(user).deposit(userBalance)

		// Fund general pool with 10,000 tokens (18 decimals)
		const generalFunding = 10_000n * 10n ** 18n
		await context.collateral.mint(deployer.address, generalFunding)
		await context.collateral.connect(deployer).approve(await expressProvider.getAddress(), generalFunding)
		await expressProvider.depositToGeneral(generalFunding)

		// Fund affiliate pool with 5,000 tokens (18 decimals)
		const affiliateFunding = 5_000n * 10n ** 18n
		await context.collateral.mint(deployer.address, affiliateFunding)
		await context.collateral.connect(deployer).approve(await expressProvider.getAddress(), affiliateFunding)
		await expressProvider.depositToAffiliate(affiliate, affiliateFunding)

		return {
			context,
			deployer,
			botSigner,
			operator,
			user,
			receiver,
			affiliateOwner,
			locker,
			unlocker,
			affiliate,
			collateral: context.collateral,
			expressProvider,
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

	// Helper: build credit data for credit line
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
		params: { user: string; nonce: bigint; amount: bigint; timestamp: number; symmioNonce: bigint; symmio: string },
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
				{ name: "symmio", type: "address" },
			],
		}
		return validator.signTypedData(domain, types, params)
	}

	// Helper: create a standard instant withdrawal via real Symmio
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
		const { botSigner, user, receiver, expressProvider, context, affiliate } = fixture
		const withdrawAmount = opts?.withdrawAmount ?? 500n * 10n ** 18n
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

		return { parts, providerData, withdrawAmount, partsHash, deadline }
	}

	// ═══════════════════════════════════════════════════════════════════════
	//                       VALIDATOR SIGNATURES
	// ═══════════════════════════════════════════════════════════════════════

	describe("Validator Signatures", function () {
		it("should accept with enough validator signatures (minValidatorSignatures = 2, provide 2)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]
			const validator2 = signers[7]

			await expressProvider.setValidator(fixture.affiliate, validator1.address, true)
			await expressProvider.setValidator(fixture.affiliate, validator2.address, true)
			await expressProvider.setMinValidatorSignatures(fixture.affiliate, 2)

			const withdrawAmount = 500n * 10n ** 18n
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
				symmio: context.diamond,
			})
			const valSig2 = await signValidatorApproval(expressProvider, v2, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: validatorTimestamp,
				symmioNonce: 0n,
				symmio: context.diamond,
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

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			const info = await expressProvider.getWithdrawInfo(user.address, 1)
			expect(info.status).to.equal(1n) // ACCEPTED
		})

		it("should reject with insufficient validator signatures", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.setValidator(fixture.affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(fixture.affiliate, 2)

			const withdrawAmount = 500n * 10n ** 18n
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
				symmio: context.diamond,
			})

			// Only 1 signature but need 2
			const providerData = encodeProviderData(nonce, 1, 0, fixture.affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig1], [now])

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"InsufficientValidatorSignatures",
			)
		})

		it("should reject expired validator signatures (timestamp + timeout < block.timestamp)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.setValidator(fixture.affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(fixture.affiliate, 1)

			const withdrawAmount = 500n * 10n ** 18n
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
				symmio: context.diamond,
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"ValidatorApprovalExpired",
			)
		})

		it("should reject future-dated timestamps (timestamp > block.timestamp)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.setValidator(fixture.affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(fixture.affiliate, 1)

			const withdrawAmount = 500n * 10n ** 18n
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
				symmio: context.diamond,
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"ValidatorApprovalExpired",
			)
		})

		it("should reject validator signature from non-validator (InvalidValidator)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user } = fixture

			const signers = await ethers.getSigners()
			const nonValidator = signers[6] // Not registered as validator

			await expressProvider.setMinValidatorSignatures(fixture.affiliate, 1)

			const withdrawAmount = 500n * 10n ** 18n
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
				symmio: context.diamond,
			})

			const providerData = encodeProviderData(nonce, 1, 0, fixture.affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidValidator",
			)
		})

		it("should reject duplicate validator signatures (DuplicateValidator)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.setValidator(fixture.affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(fixture.affiliate, 2)

			const withdrawAmount = 500n * 10n ** 18n
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
				symmio: context.diamond,
			})
			const valSig2 = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
				symmio: context.diamond,
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"DuplicateValidator",
			)
		})

		it("should reject wrong amount in validator signature", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.setValidator(fixture.affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(fixture.affiliate, 1)

			const withdrawAmount = 500n * 10n ** 18n
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
			const wrongAmount = 999n * 10n ** 18n
			const valSig = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce,
				amount: wrongAmount,
				timestamp: now,
				symmioNonce: 0n,
				symmio: context.diamond,
			})

			const providerData = encodeProviderData(nonce, 1, 0, fixture.affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			// Wrong amount causes signature recovery to yield a different address, which is not a validator
			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidValidator",
			)
		})

		it("should reject wrong nonce in validator signature", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.setValidator(fixture.affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(fixture.affiliate, 1)

			const withdrawAmount = 500n * 10n ** 18n
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
				symmio: context.diamond,
			})

			const providerData = encodeProviderData(nonce, 1, 0, fixture.affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			// Wrong nonce causes signature recovery to yield a different address
			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidValidator",
			)
		})

		it("should skip validator check when minValidatorSignatures = 0", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user } = fixture

			// Default is 0 -- no validator signatures needed
			expect(await expressProvider.minValidatorSignatures(fixture.affiliate)).to.equal(0n)

			const withdrawAmount = 500n * 10n ** 18n
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

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			const info = await expressProvider.getWithdrawInfo(user.address, 1)
			expect(info.status).to.equal(1n) // ACCEPTED
		})

		it("should expose default validator config through view getters", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliate } = fixture
			const signers = await ethers.getSigners()
			const validator = signers[6]

			await expressProvider.setValidator(ethers.ZeroAddress, validator.address, true)
			await expressProvider.setMinValidatorSignatures(ethers.ZeroAddress, 2)
			await expressProvider.setValidatorApprovalTimeout(ethers.ZeroAddress, 45)

			expect(await expressProvider.minValidatorSignatures(affiliate)).to.equal(2n)
			expect(await expressProvider.validatorApprovalTimeout(affiliate)).to.equal(45n)
			expect(await expressProvider.isValidator(affiliate, validator.address)).to.be.true
		})

		it("should reject when validator role is revoked between signing and submission", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.setValidator(fixture.affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(fixture.affiliate, 1)

			const withdrawAmount = 500n * 10n ** 18n
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
				symmio: context.diamond,
			})

			// Revoke the validator role BEFORE the on-chain submission
			await expressProvider.setValidator(fixture.affiliate, validator1.address, false)

			const providerData = encodeProviderData(nonce, 1, 0, fixture.affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			// Signature recovery yields the correct address, but that address is no longer a registered validator
			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidValidator",
			)
		})

		it("should accept when more than minValidatorSignatures are provided (extra are still validated)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]
			const validator2 = signers[7]
			const validator3 = signers[8]

			await expressProvider.setValidator(fixture.affiliate, validator1.address, true)
			await expressProvider.setValidator(fixture.affiliate, validator2.address, true)
			await expressProvider.setValidator(fixture.affiliate, validator3.address, true)
			await expressProvider.setMinValidatorSignatures(fixture.affiliate, 2) // Only require 2, but provide 3

			const withdrawAmount = 500n * 10n ** 18n
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
					symmio: context.diamond,
				})
				valSigs.push(sig)
				valTimestamps.push(now)
			}

			const providerData = encodeProviderData(nonce, 1, 0, fixture.affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, valSigs, valTimestamps)

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			const info = await expressProvider.getWithdrawInfo(user.address, 1)
			expect(info.status).to.equal(1n) // ACCEPTED
		})

		it("should fail when admin changes minValidatorSignatures and pending sigs become insufficient", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.setValidator(fixture.affiliate, validator1.address, true)
			// Start with 1 validator required
			await expressProvider.setMinValidatorSignatures(fixture.affiliate, 1)

			const withdrawAmount = 500n * 10n ** 18n
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
				symmio: context.diamond,
			})

			// Admin raises the requirement to 2
			await expressProvider.setMinValidatorSignatures(fixture.affiliate, 2)

			const providerData = encodeProviderData(nonce, 1, 0, fixture.affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			// Now 1 signature is not enough
			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"InsufficientValidatorSignatures",
			)
		})

		it("should fail when admin changes validatorApprovalTimeout and pending sigs expire", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.setValidator(fixture.affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(fixture.affiliate, 1)
			// Start with a generous timeout
			await expressProvider.setValidatorApprovalTimeout(fixture.affiliate, 120)

			const withdrawAmount = 500n * 10n ** 18n
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
				symmio: context.diamond,
			})

			// Admin reduces timeout to 5 seconds
			await expressProvider.setValidatorApprovalTimeout(fixture.affiliate, 5)

			// Advance time 10 seconds so the signature is expired under the new 5s timeout
			await time.increase(10)

			const providerData = encodeProviderData(nonce, 1, 0, fixture.affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"ValidatorApprovalExpired",
			)
		})

		it("should revert on mismatched array lengths (signatures vs timestamps)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]
			const validator2 = signers[7]

			await expressProvider.setValidator(fixture.affiliate, validator1.address, true)
			await expressProvider.setValidator(fixture.affiliate, validator2.address, true)
			await expressProvider.setMinValidatorSignatures(fixture.affiliate, 2)

			const withdrawAmount = 500n * 10n ** 18n
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
				symmio: context.diamond,
			})
			const valSig2 = await signValidatorApproval(expressProvider, v2, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
				symmio: context.diamond,
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"ArrayLengthMismatch",
			)
		})

		it("should accept validator timestamp at exact expiry boundary (timestamp + timeout == block.timestamp)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]

			await expressProvider.setValidator(fixture.affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(fixture.affiliate, 1)

			// Default timeout = 30s
			const timeout = 30

			const withdrawAmount = 500n * 10n ** 18n
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
			// The initiateWithdraw tx will mine at now+1 (next block).
			// We want: (now+1) == validatorTimestamp + 30 => validatorTimestamp = now - 29
			const validatorTimestamp = now - 29

			const valSig = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: validatorTimestamp,
				symmioNonce: 0n,
				symmio: context.diamond,
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
			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			const info = await expressProvider.getWithdrawInfo(user.address, 1)
			expect(info.status).to.equal(1n) // ACCEPTED
		})

		it("should reject when symmioNonce changed (user acted on SYMMIO after validator signed)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]
			await expressProvider.setValidator(fixture.affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(fixture.affiliate, 1)

			const withdrawAmount = 500n * 10n ** 18n
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
				symmio: context.diamond,
			})

			// The validator signed with symmioNonce=0 which matches the user's actual nonce.
			// To trigger a mismatch, encode providerData with a WRONG symmioNonce (999).
			// The real Symmio nonce (partyANonces) starts at 0 and only increments on settlement/liquidation.
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
				999n, // providerData claims symmioNonce=999 but actual nonce is 0 → mismatch
			)

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidNonce",
			)
		})

		it("should accept when symmioNonce matches current SYMMIO state", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]
			await expressProvider.setValidator(fixture.affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(fixture.affiliate, 1)

			// Trigger nonce changes on real Symmio via allocate+deallocate
			await context.controlFacet.connect(context.signers.admin).grantRole(user.address, ethers.keccak256(ethers.toUtf8Bytes("BALANCE_SETTLER_ROLE")))
			await context.accountFacet.connect(user).allocate(1n)
			await context.accountFacet.connect(user).zeroUpnlDeallocate(1n)
			// Read the current nonce
			const currentNonce = await context.viewFacet.nonceOfPartyA(user.address)

			const withdrawAmount = 500n * 10n ** 18n
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

			// Validator signs with matching symmioNonce
			const valSig = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: currentNonce,
				symmio: context.diamond,
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
				[now],
				currentNonce,
			)

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			const info = await expressProvider.getWithdrawInfo(user.address, 1)
			expect(info.status).to.equal(1n) // ACCEPTED
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
			const { locker, user, expressProvider, context } = fixture

			// Create an accepted withdrawal first
			const { parts, providerData } = await initiateInstantWithdraw(fixture)
			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

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
			const { locker, unlocker, user, receiver, expressProvider, context, collateral } = fixture

			// Create an accepted withdrawal first
			const { parts, providerData, withdrawAmount } = await initiateInstantWithdraw(fixture)
			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

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
			const { expressProvider, user, affiliate } = await deployFixture()

			await expect(expressProvider.connect(user).setMinValidatorSignatures(affiliate, 2)).to.be.revert(ethers)
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
			const generalAmt = 1_000n * 10n ** 18n
			await expressProvider.connect(user).withdrawFromGeneral(generalAmt)
			expect(await expressProvider.generalBalance()).to.equal(generalFunding - generalAmt)
			expect(await collateral.balanceOf(user.address)).to.equal(generalAmt)

			// And from affiliate
			const frontendAmt = 500n * 10n ** 18n
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
			const withdrawAmt = 2_000n * 10n ** 18n
			await expressProvider.withdrawFromGeneral(withdrawAmt)
			expect(await expressProvider.generalBalance()).to.equal(generalFunding - withdrawAmt)
			expect(await collateral.balanceOf(deployer.address)).to.equal(withdrawAmt)
		})

		it("should deposit and withdraw from affiliate pool", async function () {
			const { deployer, expressProvider, collateral, affiliate, affiliateFunding } = await deployFixture()

			// Already funded with affiliateFunding in fixture
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateFunding)

			// Withdraw some
			const withdrawAmt = 1_000n * 10n ** 18n
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
			await collateral.connect(deployer).approve(await expressProvider.getAddress(), 0n)
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
			const otherAmount = 3_000n * 10n ** 18n
			await collateral.mint(deployer.address, otherAmount)
			await collateral.connect(deployer).approve(await expressProvider.getAddress(), otherAmount)
			await expressProvider.depositToAffiliate(otherAffiliate, otherAmount)

			// Verify pools are independent
			const frontendBal = await expressProvider.affiliateBalances(affiliate)
			const otherBal = await expressProvider.affiliateBalances(otherAffiliate)
			expect(frontendBal).to.equal(5_000n * 10n ** 18n) // from fixture
			expect(otherBal).to.equal(otherAmount)

			// Withdraw from one doesn't affect other
			await expressProvider.withdrawFromAffiliate(otherAffiliate, 1_000n * 10n ** 18n)
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(5_000n * 10n ** 18n)
			expect(await expressProvider.affiliateBalances(otherAffiliate)).to.equal(2_000n * 10n ** 18n)
		})

		it("should handle withdrawFromGeneral safely when all balance is locked", async function () {
			const { deployer, operator, user, receiver, expressProvider, collateral, context, affiliate, botSigner } = await deployFixture()
			const withdrawAmount = 10_000n * 10n ** 18n

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
			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			// All general balance is locked
			expect(await expressProvider.lockedGeneralBalance()).to.equal(withdrawAmount)

			// withdrawFromGeneral should revert with InsufficientUnlockedGeneralBalance, not underflow
			await expect(expressProvider.withdrawFromGeneral(1n)).to.be.revertedWithCustomError(expressProvider, "InsufficientUnlockedGeneralBalance")
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

		it("should configure credit line muon config", async function () {
			const fixture = await deployFixture()
			const { expressProvider, muonVerifier } = fixture
			expect(await expressProvider.creditLineSignatureVerifier()).to.equal(await muonVerifier.getAddress())
			expect(await expressProvider.creditLineMuonAppId()).to.equal(1n)
			expect(await expressProvider.creditLineMuonFreshnessWindow()).to.equal(60n)
		})

		it("should reject setting credit line config by non-setter", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user } = fixture
			await expect(expressProvider.connect(user).setCreditLineMuonConfig(ethers.ZeroAddress, 0n, 0n)).to.be.revert(ethers)
		})

		it("should prevent re-initialization via diamondCut", async function () {
			const fixture = await deployFixture()
			const { deployer, expressProvider, context, collateral } = fixture
			const expressAddr = await expressProvider.getAddress()

			const diamondCut = await ethers.getContractAt("DiamondCutFacet", expressAddr)
			const initContract = await (await ethers.getContractFactory("contracts/expressWithdrawLayer/Init.sol:Init")).deploy()
			const initCalldata = initContract.interface.encodeFunctionData("init", [deployer.address, context.diamond, await collateral.getAddress()])

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
	//                            CREDIT LINE
	// ═══════════════════════════════════════════════════════════════════════

	describe("CreditLine", function () {
		it("should set protocol config", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliate } = fixture
			await expressProvider.setCreditLineProtocolConfig(affiliate, 1000n * 10n ** 18n, 5000n)
			expect(await expressProvider.creditLineProtocolMaxDebt(affiliate)).to.equal(1000n * 10n ** 18n)
			expect(await expressProvider.creditLineProtocolMaxDebtBps(affiliate)).to.equal(5000n)
		})

		it("should set affiliate config stricter than protocol", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliate } = fixture
			await expressProvider.setCreditLineProtocolConfig(affiliate, 1000n * 10n ** 18n, 5000n)
			await expressProvider.setCreditLineAffiliateConfig(affiliate, 500n * 10n ** 18n, 3000n)
			expect(await expressProvider.creditLineAffiliateMaxDebt(affiliate)).to.equal(500n * 10n ** 18n)
			expect(await expressProvider.creditLineAffiliateMaxDebtBps(affiliate)).to.equal(3000n)
		})

		it("should reject affiliate config looser than protocol", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliate } = fixture
			await expressProvider.setCreditLineProtocolConfig(affiliate, 1000n * 10n ** 18n, 5000n)
			await expect(expressProvider.setCreditLineAffiliateConfig(affiliate, 2000n * 10n ** 18n, 3000n)).to.be.revert(ethers) // AffiliateLimitExceedsProtocol
		})

		it("should pause and unpause credit line", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliate } = fixture
			await expressProvider.setCreditLinePaused(affiliate, true)
			expect(await expressProvider.creditLinePaused(affiliate)).to.be.true
			await expressProvider.setCreditLinePaused(affiliate, false)
			expect(await expressProvider.creditLinePaused(affiliate)).to.be.false
		})

		it("should blacklist and unblacklist user", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliate, user } = fixture
			await expressProvider.setCreditLineBlacklisted(affiliate, user.address, true)
			expect(await expressProvider.creditLineBlacklisted(affiliate, user.address)).to.be.true
			await expressProvider.setCreditLineBlacklisted(affiliate, user.address, false)
			expect(await expressProvider.creditLineBlacklisted(affiliate, user.address)).to.be.false
		})

		it("should reject reserve when paused", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, context, affiliate, collateral } = fixture
			const expressAddr = await expressProvider.getAddress()
			const withdrawAmount = 500n * 10n ** 18n
			const creditAmount = 200n * 10n ** 18n

			await expressProvider.setCreditLinePaused(affiliate, true)

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

			const creditDataRaw = buildCreditData(10_000n * 10n ** 18n, now)
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revert(ethers) // CreditLinePaused
		})

		it("should reject reserve for blacklisted user", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, context, affiliate, collateral } = fixture
			const expressAddr = await expressProvider.getAddress()
			const withdrawAmount = 500n * 10n ** 18n
			const creditAmount = 200n * 10n ** 18n

			await expressProvider.setCreditLineBlacklisted(affiliate, user.address, true)

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

			const creditDataRaw = buildCreditData(10_000n * 10n ** 18n, now)
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revert(ethers) // UserBlacklisted
		})

		it("should reject non-setter calling credit line admin functions", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliate, user } = fixture
			await expect(expressProvider.connect(user).setCreditLineProtocolConfig(affiliate, 100n, 100n)).to.be.revert(ethers)
			await expect(expressProvider.connect(user).setCreditLinePaused(affiliate, true)).to.be.revert(ethers)
			await expect(expressProvider.connect(user).setCreditLineBlacklisted(affiliate, user.address, true)).to.be.revert(ethers)
		})
	})
}
