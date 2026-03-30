import { expect } from "chai"
import hre, { network } from "hardhat"

import { deployExpressProvider, deployCreditLineManager } from "../contracts/expressLayer/lib/deploy.js"

const connection = await network.connect()
const { ethers } = connection

const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"))
const SIGNER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("SIGNER_ROLE"))
const LOCKER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LOCKER_ROLE"))
const UNLOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UNLOCK_ROLE"))

export function shouldBehaveLikeExpressLayerFlows(): void {
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

		// Deploy MockMuonSignatureVerifier for CreditLineManager
		const muonVerifier = await ethers.deployContract("MockMuonSignatureVerifier")

		// Deploy CreditLineManager (UUPS proxy) for the affiliate
		const creditLineManager = await deployCreditLineManager(hre, connection, {
			admin: deployer.address,
			symmio: await symmio.getAddress(),
			expressProvider: await expressProvider.getAddress(),
			signatureVerifier: await muonVerifier.getAddress(),
			muonAppId: 1n,
		})

		// Register providers on mock SYMMIO
		await symmio.registerExpressProvider(await expressProvider.getAddress())

		// Configure ExpressProvider via roles
		await expressProvider.grantRole(SIGNER_ROLE, botSigner.address)
		await expressProvider.grantRole(OPERATOR_ROLE, operator.address)
		await expressProvider.grantRole(LOCKER_ROLE, locker.address)
		await expressProvider.grantRole(UNLOCK_ROLE, unlocker.address)
		const affiliate = affiliateOwner.address

		// Register credit line manager on express provider
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
		creditDataRaw?: string,
	): string {
		const muf = maxUserFee ?? fee + operatorFee
		const optionData = ethers.AbiCoder.defaultAbiCoder().encode(
			["uint256", "uint8", "uint256", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "bytes"],
			[nonce, optionType, availableAt, affiliate, affiliateAmount, creditAmount, fee, operatorFee, muf, deadline, signature],
		)
		const validatorData = ethers.AbiCoder.defaultAbiCoder().encode(
			["bytes[]", "uint256[]", "uint256"],
			[validatorSignatures ?? [], validatorTimestamps ?? [], 0],
		)
		return ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "bytes", "bytes"], [optionData, validatorData, creditDataRaw ?? "0x"])
	}

	// Helper: build credit data for CreditLineManager Muon signature verification
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

	// Helper: accept an INSTANT withdrawal and return parts + requestId
	async function acceptInstant(fixture: any, opts?: { withdrawAmount?: bigint; affiliateAmount?: bigint; creditAmount?: bigint }) {
		const { botSigner, user, receiver, expressProvider, symmio, affiliate } = fixture
		const withdrawAmount = opts?.withdrawAmount ?? 500n * 10n ** 6n
		const affiliateAmount = opts?.affiliateAmount ?? 0n
		const creditAmount = opts?.creditAmount ?? 0n
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
			affiliateAmount,
			creditAmount,
			fee: 0n,
			operatorFee: 0n,
			partsHash,
			deadline,
		})

		const providerData = encodeProviderData(nonce, 1, 0, affiliate, affiliateAmount, creditAmount, 0n, 0n, deadline, signature)

		const now = (await ethers.provider.getBlock("latest"))!.timestamp
		await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
		await symmio.mockInitiateWithdraw(user.address, parts, providerData)

		const requestId = await symmio.lastWithdrawRequestId(user.address)
		return { parts, requestId, withdrawAmount, affiliateAmount }
	}

	// Helper: accept a STANDARD withdrawal
	async function acceptStandard(fixture: any, opts?: { withdrawAmount?: bigint; creditAmount?: bigint }) {
		const { botSigner, user, receiver, expressProvider, symmio, affiliate } = fixture
		const withdrawAmount = opts?.withdrawAmount ?? 500n * 10n ** 6n
		const creditAmount = opts?.creditAmount ?? 0n
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
		const deadline = now + 3600 * 24
		const nonce = await expressProvider.nonces(user.address)

		const signature = await signWithdrawOption(expressProvider, botSigner, {
			user: user.address,
			nonce,
			optionType: 2,
			availableAt: 0,
			affiliate,
			affiliateAmount: 0n,
			creditAmount,
			fee: 0n,
			operatorFee: 0n,
			partsHash,
			deadline,
		})

		const providerData = encodeProviderData(nonce, 2, 0, affiliate, 0n, creditAmount, 0n, 0n, deadline, signature)

		await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
		await symmio.mockInitiateWithdraw(user.address, parts, providerData)

		const requestId = await symmio.lastWithdrawRequestId(user.address)
		return { parts, requestId, withdrawAmount }
	}

	// Helper: finalize a STANDARD withdrawal (mint tokens to SYMMIO, advance time, finalize)
	async function finalizeStandard(fixture: any, requestId: bigint, amount: bigint) {
		const { symmio, collateral, user } = fixture
		await collateral.mint(await symmio.getAddress(), amount)
		await ethers.provider.send("evm_increaseTime", [12 * 3600])
		await ethers.provider.send("evm_mine", [])
		await symmio.finalizeWithdrawRequest(user.address, requestId)
	}

	// ═══════════════════════════════════════════════════════════════════
	//                           ACCEPTANCE
	// ═══════════════════════════════════════════════════════════════════

	describe("Acceptance", function () {
		it("should accept valid INSTANT withdrawal and verify pool locks", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, affiliate } = fixture
			const affiliateAmount = 200n * 10n ** 6n
			const { withdrawAmount, requestId } = await acceptInstant(fixture, { affiliateAmount })

			// Pool balances locked
			expect(await expressProvider.lockedGeneralBalance()).to.equal(withdrawAmount - affiliateAmount)
			expect(await expressProvider.lockedAffiliateBalances(affiliate)).to.equal(affiliateAmount)

			// WithdrawInfo stored
			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(1n) // ACCEPTED
			expect(info.optionType).to.equal(1n) // INSTANT
			expect(info.expressAmount).to.equal(withdrawAmount)
			expect(info.generalAmount).to.equal(withdrawAmount - affiliateAmount)
			expect(info.affiliateAmount).to.equal(affiliateAmount)
		})

		it("should accept valid STANDARD withdrawal and verify no pool locks", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, generalFunding } = fixture
			const { requestId } = await acceptStandard(fixture)

			// No pool locks for STANDARD
			expect(await expressProvider.lockedGeneralBalance()).to.equal(0n)
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(1n) // ACCEPTED
			expect(info.optionType).to.equal(2n) // STANDARD
		})

		it("should reject invalid signer", async function () {
			const fixture = await deployFixture()
			const { deployer, user, receiver, expressProvider, symmio, affiliate } = fixture
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
			const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600

			// Sign with deployer (not a SIGNER_ROLE holder)
			const signature = await signWithdrawOption(expressProvider, deployer, {
				user: user.address,
				nonce: 0n,
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

			const providerData = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, 0n, 0n, deadline, signature)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(expressProvider, "InvalidSigner")
		})

		it("should reject insufficient general balance (INSTANT)", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, symmio, affiliate } = fixture
			const withdrawAmount = 20_000n * 10n ** 6n // more than 10,000 general pool
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
				nonce: 0n,
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

			const providerData = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, 0n, 0n, deadline, signature)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"InsufficientGeneralBalance",
			)
		})

		it("should reject expired option deadline", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, symmio, affiliate } = fixture
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
			// Set deadline in the past
			const deadline = (await ethers.provider.getBlock("latest"))!.timestamp - 1

			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
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

			const providerData = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, 0n, 0n, deadline, signature)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(expressProvider, "OptionExpired")
		})

		it("should reject invalid nonce (wrong nonce)", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, symmio, affiliate } = fixture
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
			const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600

			// Use nonce 5 instead of 0
			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 5n,
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

			const providerData = encodeProviderData(5n, 1, 0, affiliate, 0n, 0n, 0n, 0n, deadline, signature)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(expressProvider, "InvalidNonce")
		})

		it("should reject nonce replay (resubmit same nonce after consumption)", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, symmio, affiliate } = fixture

			// First: accept a valid withdrawal (consumes nonce 0)
			await acceptInstant(fixture)
			expect(await expressProvider.nonces(user.address)).to.equal(1n)

			// Second: try to replay with nonce 0
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
			const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600

			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n, // already consumed
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

			const providerData = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, 0n, 0n, deadline, signature)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(expressProvider, "InvalidNonce")
		})

		it("should reject nonce skip (use nonce+2 instead of nonce+1)", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, symmio, affiliate } = fixture

			// Accept first withdrawal (consumes nonce 0, next expected is 1)
			await acceptInstant(fixture)
			expect(await expressProvider.nonces(user.address)).to.equal(1n)

			// Try to use nonce 2 (skipping 1)
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
			const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600

			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 2n, // skipping 1
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

			const providerData = encodeProviderData(2n, 1, 0, affiliate, 0n, 0n, 0n, 0n, deadline, signature)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(expressProvider, "InvalidNonce")
		})

		it("should reject invalid optionType > 2 (reverts with Panic due to enum out of range)", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, symmio, affiliate } = fixture
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
			const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600

			// optionType = 3 (invalid, enum only has 0,1,2)
			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 3,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const providerData = encodeProviderData(0n, 3, 0, affiliate, 0n, 0n, 0n, 0n, deadline, signature)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			// Solidity 0.8+ reverts with Panic(0x21) for invalid enum conversion
			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revert(ethers)
		})

		it("should revert with AffiliateExceedsExpress when affiliateAmount > expressAmount", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, symmio, affiliate } = fixture
			const withdrawAmount = 500n * 10n ** 6n
			const affiliateAmount = 600n * 10n ** 6n // exceeds expressAmount
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
				affiliateAmount,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const providerData = encodeProviderData(nonce, 1, 0, affiliate, affiliateAmount, 0n, 0n, 0n, deadline, signature)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"FundingSplitExceedsExpress",
			)
		})

		it("should succeed when affiliateAmount == expressAmount (boundary)", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider } = fixture
			const withdrawAmount = 500n * 10n ** 6n
			const affiliateAmount = withdrawAmount
			const { requestId } = await acceptInstant(fixture, { withdrawAmount, affiliateAmount })

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(1n)
			expect(info.generalAmount).to.equal(0n)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                           PROCESSING
	// ═══════════════════════════════════════════════════════════════════

	describe("Processing", function () {
		it("INSTANT: process after securityWindow by operator", async function () {
			const fixture = await deployFixture()
			const { operator, user, receiver, expressProvider, collateral } = fixture
			const { parts, requestId, withdrawAmount } = await acceptInstant(fixture)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])

			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(3n) // PROCESSED
		})

		it("INSTANT: reject before securityWindow (TooEarly)", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider } = fixture
			const { parts, requestId } = await acceptInstant(fixture)

			// Do not advance time - still within 20s security window
			await expect(expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"TooEarly",
			)
		})

		it("INSTANT: permissionless processing after securityWindow + tolerancePeriod", async function () {
			const fixture = await deployFixture()
			const { user, receiver, expressProvider, collateral } = fixture
			const { parts, requestId, withdrawAmount } = await acceptInstant(fixture)

			// Advance past securityWindow (20) + tolerancePeriod (60) = 80s
			await ethers.provider.send("evm_increaseTime", [81])
			await ethers.provider.send("evm_mine", [])

			// user (non-operator) can process
			await expressProvider.connect(user).processWithdraw(user.address, requestId, parts)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)
		})

		it("INSTANT: reject permissionless before tolerance expires", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider } = fixture
			const { parts, requestId } = await acceptInstant(fixture)

			// Advance 30s: past securityWindow (20) but not past securityWindow + tolerancePeriod (80)
			await ethers.provider.send("evm_increaseTime", [30])
			await ethers.provider.send("evm_mine", [])

			await expect(expressProvider.connect(user).processWithdraw(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"TooEarly",
			)
		})

		it("INSTANT: process at exact securityWindow boundary", async function () {
			const fixture = await deployFixture()
			const { operator, user, receiver, expressProvider, collateral } = fixture
			const { parts, requestId, withdrawAmount } = await acceptInstant(fixture)

			// Advance exactly 20s (securityWindow)
			await ethers.provider.send("evm_increaseTime", [20])
			await ethers.provider.send("evm_mine", [])

			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)
		})

		it("STANDARD: reject before finalization (NotFinalized)", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider } = fixture
			const { parts, requestId } = await acceptStandard(fixture)

			await ethers.provider.send("evm_increaseTime", [100])
			await ethers.provider.send("evm_mine", [])

			await expect(expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"NotFinalized",
			)
		})

		it("STANDARD: process immediately after finalization by operator", async function () {
			const fixture = await deployFixture()
			const { operator, user, receiver, expressProvider, collateral } = fixture
			const { parts, requestId, withdrawAmount } = await acceptStandard(fixture)

			await finalizeStandard(fixture, requestId, withdrawAmount)

			// Operator can process immediately after finalization
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)
		})

		it("STANDARD: permissionless after finalization + tolerancePeriod", async function () {
			const fixture = await deployFixture()
			const { user, receiver, expressProvider, collateral } = fixture
			const { parts, requestId, withdrawAmount } = await acceptStandard(fixture)

			await finalizeStandard(fixture, requestId, withdrawAmount)

			// Non-operator must wait tolerancePeriod (60s) after finalization
			await expect(expressProvider.connect(user).processWithdraw(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"TooEarly",
			)

			await ethers.provider.send("evm_increaseTime", [61])
			await ethers.provider.send("evm_mine", [])

			await expressProvider.connect(user).processWithdraw(user.address, requestId, parts)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)
		})

		it("STANDARD: reject permissionless before tolerance after finalization", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider } = fixture
			const { parts, requestId, withdrawAmount } = await acceptStandard(fixture)

			await finalizeStandard(fixture, requestId, withdrawAmount)

			// Advance only 30s (need 60s for tolerance)
			await ethers.provider.send("evm_increaseTime", [30])
			await ethers.provider.send("evm_mine", [])

			await expect(expressProvider.connect(user).processWithdraw(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"TooEarly",
			)
		})

		it("should reject double processWithdraw (second call reverts)", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider } = fixture
			const { parts, requestId } = await acceptInstant(fixture)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])

			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			// Second call: status is PROCESSED, not ACCEPTED
			await expect(expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"NotAccepted",
			)
		})

		it("should reject processWithdraw with parts mismatch", async function () {
			const fixture = await deployFixture()
			const { operator, user, receiver, expressProvider } = fixture
			const { requestId } = await acceptInstant(fixture)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])

			// Create different parts (different amount)
			const wrongParts = [
				{
					id: 0n,
					amount: 999n * 10n ** 6n, // wrong amount
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: await expressProvider.getAddress(),
				},
			]

			await expect(expressProvider.connect(operator).processWithdraw(user.address, requestId, wrongParts)).to.be.revertedWithCustomError(
				expressProvider,
				"PartsMismatch",
			)
		})

		it("securityWindow minimum allows near-immediate operator processing", async function () {
			const fixture = await deployFixture()
			const { operator, user, receiver, expressProvider, collateral } = fixture

			// Set securityWindow to minimum (10s)
			await expressProvider.setSecurityWindow(10)

			const { parts, requestId, withdrawAmount } = await acceptInstant(fixture)

			// Advance past the 10s securityWindow
			await ethers.provider.send("evm_increaseTime", [11])
			await ethers.provider.send("evm_mine", [])

			// Operator can process after minimum securityWindow
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)
		})

		it("securityWindow rejects values below minimum", async function () {
			const fixture = await deployFixture()
			const { expressProvider } = fixture
			await expect(expressProvider.setSecurityWindow(0)).to.be.revertedWithCustomError(expressProvider, "SecurityWindowTooLow")
			await expect(expressProvider.setSecurityWindow(9)).to.be.revertedWithCustomError(expressProvider, "SecurityWindowTooLow")
		})

		it("tolerancePeriod minimum allows near-immediate permissionless processing after securityWindow", async function () {
			const fixture = await deployFixture()
			const { user, receiver, expressProvider, collateral } = fixture

			// Set tolerancePeriod to minimum (10s)
			await expressProvider.setTolerancePeriod(10)

			const { parts, requestId, withdrawAmount } = await acceptInstant(fixture)

			// Advance past securityWindow (20s) + tolerancePeriod (10s)
			await ethers.provider.send("evm_increaseTime", [31])
			await ethers.provider.send("evm_mine", [])

			// Non-operator can process after securityWindow + tolerancePeriod
			await expressProvider.connect(user).processWithdraw(user.address, requestId, parts)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)
		})

		it("tolerancePeriod rejects values below minimum", async function () {
			const fixture = await deployFixture()
			const { expressProvider } = fixture
			await expect(expressProvider.setTolerancePeriod(0)).to.be.revertedWithCustomError(expressProvider, "TolerancePeriodTooLow")
			await expect(expressProvider.setTolerancePeriod(9)).to.be.revertedWithCustomError(expressProvider, "TolerancePeriodTooLow")
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                          FINALIZATION
	// ═══════════════════════════════════════════════════════════════════

	describe("Finalization", function () {
		it("INSTANT: replenish pools after cooldown", async function () {
			const fixture = await deployFixture()
			const { operator, user, receiver, expressProvider, symmio, collateral, generalFunding } = fixture
			const affiliateAmount = 200n * 10n ** 6n
			const { parts, requestId, withdrawAmount } = await acceptInstant(fixture, { affiliateAmount })

			// Process
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			// After processing, pools are reduced
			expect(await expressProvider.generalBalance()).to.equal(generalFunding - (withdrawAmount - affiliateAmount))

			// Mint tokens to SYMMIO and finalize
			await collateral.mint(await symmio.getAddress(), withdrawAmount)
			await ethers.provider.send("evm_increaseTime", [12 * 3600])
			await ethers.provider.send("evm_mine", [])
			await symmio.finalizeWithdrawRequest(user.address, requestId)

			// Pools replenished
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)
			expect(await expressProvider.affiliateBalances(fixture.affiliate)).to.equal(fixture.affiliateFunding)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(4n) // FINALIZED
		})

		it("STANDARD: onWithdrawComplete sets FINALIZED (no pool replenishment)", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, generalFunding } = fixture
			const { requestId, withdrawAmount } = await acceptStandard(fixture)

			await finalizeStandard(fixture, requestId, withdrawAmount)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(4n) // FINALIZED

			// Pool balances unchanged (STANDARD never fronts from pools)
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)
		})

		it("STANDARD: onWithdrawComplete while LOCKED preserves LOCKED status", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, locker } = fixture
			const { requestId, withdrawAmount } = await acceptStandard(fixture)

			// Lock during cooldown
			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)
			let info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(2n) // LOCKED

			// Finalize (SYMMIO sends tokens)
			await finalizeStandard(fixture, requestId, withdrawAmount)

			// Status stays LOCKED (not overwritten to FINALIZED)
			info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(2n) // Still LOCKED
			expect(info.finalizedAt).to.be.greaterThan(0n) // But finalizedAt recorded
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                          CANCELLATION
	// ═══════════════════════════════════════════════════════════════════

	describe("Cancellation", function () {
		it("should cancel INSTANT before processing", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, symmio, generalFunding, affiliateFunding, affiliate } = fixture
			const affiliateAmount = 200n * 10n ** 6n
			const { requestId } = await acceptInstant(fixture, { affiliateAmount })

			await symmio.mockCancelWithdraw(user.address, requestId)

			// Pool balances fully restored
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)
			expect(await expressProvider.lockedGeneralBalance()).to.equal(0n)
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateFunding)
			expect(await expressProvider.lockedAffiliateBalances(affiliate)).to.equal(0n)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(5n) // CANCELLED
		})

		it("should reject cancel INSTANT after processing", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, symmio } = fixture
			const { parts, requestId } = await acceptInstant(fixture)

			// Process first
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			// Cancel after processing should fail (status is PROCESSED, MockSymmio's cancel
			// also updates its own status which requires PROVIDER_ACCEPTED)
			await expect(symmio.mockCancelWithdraw(user.address, requestId)).to.be.revert(ethers)
		})

		it("should cancel STANDARD before finalization", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, symmio, generalFunding } = fixture
			const { requestId } = await acceptStandard(fixture)

			await symmio.mockCancelWithdraw(user.address, requestId)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(5n) // CANCELLED
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)
		})

		it("should reject cancel STANDARD after finalization", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, symmio } = fixture
			const { parts, requestId, withdrawAmount } = await acceptStandard(fixture)

			// Finalize
			await finalizeStandard(fixture, requestId, withdrawAmount)

			// Process
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			// Cancel after finalization+processing should fail
			await expect(symmio.mockCancelWithdraw(user.address, requestId)).to.be.revert(ethers)
		})

		it("should force cancel on any status (ACCEPTED instant)", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, symmio, generalFunding } = fixture
			const { requestId } = await acceptInstant(fixture)

			await symmio.mockForceCancelWithdraw(user.address, requestId)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(5n) // CANCELLED
			expect(await expressProvider.lockedGeneralBalance()).to.equal(0n)
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)
		})

		it("should force cancel LOCKED instant withdrawal", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, symmio, generalFunding, locker } = fixture
			const { requestId } = await acceptInstant(fixture)

			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)
			await symmio.mockForceCancelWithdraw(user.address, requestId)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(5n) // CANCELLED
			expect(await expressProvider.lockedGeneralBalance()).to.equal(0n)
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)
		})

		it("should force cancel INSTANT after processing (rollback)", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, symmio } = fixture
			const { parts, requestId } = await acceptInstant(fixture)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			// In credit line model, force cancel after processing does rollback (not revert)
			await symmio.mockForceCancelWithdraw(user.address, requestId)
			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(5n) // CANCELLED
		})

		it("should reject force cancel on LOCKED STANDARD after finalization", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, symmio, locker } = fixture
			const { requestId, withdrawAmount } = await acceptStandard(fixture)

			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)
			await finalizeStandard(fixture, requestId, withdrawAmount)

			await expect(symmio.mockForceCancelWithdraw(user.address, requestId)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidStatusForForceCancel",
			)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                           SUSPENSION
	// ═══════════════════════════════════════════════════════════════════

	describe("Suspension", function () {
		it("should suspend ACCEPTED INSTANT (unlock pools)", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, symmio, generalFunding } = fixture
			const { requestId, withdrawAmount } = await acceptInstant(fixture)

			// Verify pools are locked
			expect(await expressProvider.lockedGeneralBalance()).to.equal(withdrawAmount)

			await symmio.mockSuspendWithdraw(user.address, requestId)

			// Pools unlocked
			expect(await expressProvider.lockedGeneralBalance()).to.equal(0n)
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(6n) // SUSPENDED
		})

		it("should suspend LOCKED withdrawal", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, symmio, generalFunding, locker } = fixture
			const { requestId } = await acceptInstant(fixture)

			// Lock first
			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)
			let info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(2n) // LOCKED

			// Suspend
			await symmio.mockSuspendWithdraw(user.address, requestId)

			// Pools unlocked
			expect(await expressProvider.lockedGeneralBalance()).to.equal(0n)
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)

			info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(6n) // SUSPENDED
		})

		it("should suspend PROCESSED INSTANT (rollback)", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, symmio } = fixture
			const { parts, requestId } = await acceptInstant(fixture)

			// Process
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			// In credit line model, suspend on PROCESSED does rollback (not revert)
			await symmio.mockSuspendWithdraw(user.address, requestId)
			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(6n) // SUSPENDED
		})

		it("should revert suspend on FINALIZED", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, symmio, collateral } = fixture
			const { parts, requestId, withdrawAmount } = await acceptInstant(fixture)

			// Process
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			// Finalize
			await collateral.mint(await symmio.getAddress(), withdrawAmount)
			await ethers.provider.send("evm_increaseTime", [12 * 3600])
			await ethers.provider.send("evm_mine", [])
			await symmio.finalizeWithdrawRequest(user.address, requestId)

			// Suspend after finalization should fail
			await expect(symmio.mockSuspendWithdraw(user.address, requestId)).to.be.revert(ethers)
		})

		it("should reject suspend on LOCKED STANDARD after finalization", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, symmio, locker } = fixture
			const { requestId, withdrawAmount } = await acceptStandard(fixture)

			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)
			await finalizeStandard(fixture, requestId, withdrawAmount)

			await expect(symmio.mockSuspendWithdraw(user.address, requestId)).to.be.revertedWithCustomError(expressProvider, "InvalidStatusForSuspend")
		})

		it("should revert suspend on already CANCELLED", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, symmio } = fixture
			const { requestId } = await acceptInstant(fixture)

			// Cancel first
			await symmio.mockCancelWithdraw(user.address, requestId)
			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(5n) // CANCELLED

			// Suspend after cancel: lockedGeneralBalance already 0, would underflow
			await expect(symmio.mockSuspendWithdraw(user.address, requestId)).to.be.revert(ethers)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                           RISK LOCK
	// ═══════════════════════════════════════════════════════════════════

	describe("Risk Lock", function () {
		it("should lock ACCEPTED withdrawal", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, locker } = fixture
			const { requestId } = await acceptInstant(fixture)

			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(2n) // LOCKED
		})

		it("should reject lock on already LOCKED", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, locker } = fixture
			const { requestId } = await acceptInstant(fixture)

			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)

			await expect(expressProvider.connect(locker).lockWithdraw(user.address, requestId)).to.be.revertedWithCustomError(
				expressProvider,
				"NotAccepted",
			)
		})

		it("should reject lock on PROCESSED", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, locker } = fixture
			const { parts, requestId } = await acceptInstant(fixture)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			await expect(expressProvider.connect(locker).lockWithdraw(user.address, requestId)).to.be.revertedWithCustomError(
				expressProvider,
				"NotAccepted",
			)
		})

		it("should reject lock on FINALIZED", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, locker } = fixture
			const { requestId, withdrawAmount } = await acceptStandard(fixture)

			await finalizeStandard(fixture, requestId, withdrawAmount)

			await expect(expressProvider.connect(locker).lockWithdraw(user.address, requestId)).to.be.revertedWithCustomError(
				expressProvider,
				"NotAccepted",
			)
		})

		it("should reject lock on CANCELLED", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, symmio, locker } = fixture
			const { requestId } = await acceptInstant(fixture)

			await symmio.mockCancelWithdraw(user.address, requestId)

			await expect(expressProvider.connect(locker).lockWithdraw(user.address, requestId)).to.be.revertedWithCustomError(
				expressProvider,
				"NotAccepted",
			)
		})

		it("should unlockAndProcess on LOCKED INSTANT", async function () {
			const fixture = await deployFixture()
			const { user, receiver, expressProvider, collateral, locker, unlocker } = fixture
			const { parts, requestId, withdrawAmount } = await acceptInstant(fixture)

			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)

			// Unlock and process
			await expressProvider.connect(unlocker).unlockAndProcess(user.address, requestId, parts)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(3n) // PROCESSED
		})

		it("should unlockAndProcess on LOCKED STANDARD (after finalization)", async function () {
			const fixture = await deployFixture()
			const { user, receiver, expressProvider, collateral, locker, unlocker } = fixture
			const { parts, requestId, withdrawAmount } = await acceptStandard(fixture)

			// Lock during cooldown
			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)

			// Finalize (tokens arrive but status stays LOCKED)
			await finalizeStandard(fixture, requestId, withdrawAmount)

			let info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(2n) // Still LOCKED

			// unlockAndProcess forwards the tokens
			await expressProvider.connect(unlocker).unlockAndProcess(user.address, requestId, parts)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)

			info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(3n) // PROCESSED
		})

		it("should reject unlockAndProcess on STANDARD before finalization when contract lacks tokens", async function () {
			const fixture = await deployFixture()
			const { user, receiver, expressProvider, collateral, locker, unlocker } = fixture

			// Use a large amount that exceeds the contract's total token balance.
			// The contract has 15,000 USDC (10k general + 5k affiliate). Request 20,000.
			const withdrawAmount = 20_000n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			// Fund more to general pool to allow acceptance (STANDARD doesn't lock pools)
			const extraFund = 15_000n * 10n ** 6n
			await collateral.mint(fixture.deployer.address, extraFund)
			await collateral.approve(expressAddr, extraFund)
			await expressProvider.depositToGeneral(extraFund)

			const { parts, requestId } = await acceptStandard(fixture, { withdrawAmount })

			// Lock (status becomes LOCKED)
			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)

			// Withdraw most of the general pool so the contract doesn't have enough tokens
			// to transfer the full 20,000 USDC. We need to leave less than 20,000 in the contract.
			const generalUnlocked = (await expressProvider.generalBalance()) - (await expressProvider.lockedGeneralBalance())
			await expressProvider.withdrawFromGeneral(generalUnlocked)
			const frontendUnlocked =
				(await expressProvider.affiliateBalances(fixture.affiliate)) - (await expressProvider.lockedAffiliateBalances(fixture.affiliate))
			await expressProvider.withdrawFromAffiliate(fixture.affiliate, frontendUnlocked)

			await expect(expressProvider.connect(unlocker).unlockAndProcess(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"NotFinalized",
			)
		})

		it("should reject unlockAndProcess on non-LOCKED (ACCEPTED)", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, unlocker } = fixture
			const { parts, requestId } = await acceptInstant(fixture)

			await expect(expressProvider.connect(unlocker).unlockAndProcess(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"NotLocked",
			)
		})

		it("should reject unlockAndProcess on PROCESSED", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, unlocker } = fixture
			const { parts, requestId } = await acceptInstant(fixture)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			await expect(expressProvider.connect(unlocker).unlockAndProcess(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"NotLocked",
			)
		})

		it("should reject double unlockAndProcess", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, locker, unlocker } = fixture
			const { parts, requestId } = await acceptInstant(fixture)

			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)
			await expressProvider.connect(unlocker).unlockAndProcess(user.address, requestId, parts)

			// Second call: status is PROCESSED, not LOCKED
			await expect(expressProvider.connect(unlocker).unlockAndProcess(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"NotLocked",
			)
		})

		it("should processWithdraw on LOCKED INSTANT after cooldown", async function () {
			const fixture = await deployFixture()
			const { user, receiver, expressProvider, collateral, locker } = fixture
			const { parts, requestId, withdrawAmount } = await acceptInstant(fixture)

			// Lock the withdrawal
			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)
			let info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(2n) // LOCKED

			// acceptInstant uses deallocateTimestamp = now - 13h, so cooldownEndTime = now.
			// Advance past securityWindow + tolerancePeriod so anyone can call processWithdraw.
			await ethers.provider.send("evm_increaseTime", [81])
			await ethers.provider.send("evm_mine", [])

			// Permissionless processWithdraw succeeds on LOCKED after cooldown
			await expressProvider.connect(user).processWithdraw(user.address, requestId, parts)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)

			info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(3n) // PROCESSED
		})

		it("should processWithdraw on LOCKED STANDARD after cooldown (finalizes from SYMMIO)", async function () {
			const fixture = await deployFixture()
			const { operator, user, receiver, expressProvider, symmio, collateral, locker } = fixture
			const { parts, requestId, withdrawAmount } = await acceptStandard(fixture)

			// Lock the withdrawal
			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)
			let info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(2n) // LOCKED

			// Mint tokens to SYMMIO so finalization can succeed
			await collateral.mint(await symmio.getAddress(), withdrawAmount)

			// acceptStandard uses deallocateTimestamp = now - 13h, so cooldownEndTime = now.
			// Advance 12h so SYMMIO finalization succeeds, then past tolerancePeriod.
			await ethers.provider.send("evm_increaseTime", [12 * 3600 + 61])
			await ethers.provider.send("evm_mine", [])

			// Finalize on SYMMIO first (tokens arrive at express provider)
			await symmio.finalizeWithdrawRequest(user.address, requestId)

			// processWithdraw succeeds on LOCKED after cooldown
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)

			info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(3n) // PROCESSED
		})

		it("should reject processWithdraw on LOCKED INSTANT before cooldown", async function () {
			const fixture = await deployFixture()
			const { botSigner, operator, user, receiver, expressProvider, symmio, affiliate, locker } = fixture
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
			const deadline = now + 3600
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

			// Use deallocateTimestamp = now so cooldownEndTime = now + 12h (cooldown NOT expired)
			await symmio.setDeallocateTimestamp(user.address, now)
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			const requestId = await symmio.lastWithdrawRequestId(user.address)

			// Lock the withdrawal
			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)

			// Advance past securityWindow but NOT past cooldownEndTime (12h away)
			await ethers.provider.send("evm_increaseTime", [100])
			await ethers.provider.send("evm_mine", [])

			// processWithdraw should revert because LOCKED and cooldown not expired
			await expect(expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"NotAccepted",
			)
		})

		it("lockWithdraw should reject double-lock (nonReentrant protection)", async function () {
			const fixture = await deployFixture()
			const { locker, user, expressProvider } = fixture

			const { requestId } = await acceptInstant(fixture)
			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(2n) // LOCKED

			await expect(expressProvider.connect(locker).lockWithdraw(user.address, requestId)).to.be.revertedWithCustomError(
				expressProvider,
				"NotAccepted",
			)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                    CREDIT LINE INTEGRATION
	// ═══════════════════════════════════════════════════════════════════

	describe("Credit Line Integration", function () {
		it("should reserve credit on INSTANT acceptance", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, symmio, affiliate, creditLineManager, collateral } = fixture
			const expressAddr = await expressProvider.getAddress()
			const withdrawAmount = 500n * 10n ** 6n
			const creditAmount = 200n * 10n ** 6n

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
				creditDataRaw,
			)

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			// Mint collateral to symmio for advanceWithdraw
			await collateral.mint(await symmio.getAddress(), creditAmount)
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			// Credit should be reserved
			expect(await creditLineManager.reservedDebt()).to.equal(creditAmount)
			expect(await creditLineManager.activeDebt()).to.equal(0n)
		})

		it("should activate credit and advance collateral on processing", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, operator, user, receiver, symmio, affiliate, creditLineManager, collateral } = fixture
			const expressAddr = await expressProvider.getAddress()
			const withdrawAmount = 500n * 10n ** 6n
			const creditAmount = 200n * 10n ** 6n

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
				creditDataRaw,
			)

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await collateral.mint(await symmio.getAddress(), creditAmount)
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			// Process
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, 1n, parts)

			// Credit should now be active (moved from reserved to active)
			expect(await creditLineManager.reservedDebt()).to.equal(0n)
			expect(await creditLineManager.activeDebt()).to.equal(creditAmount)
		})

		it("should settle credit on finalization", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, operator, user, receiver, symmio, affiliate, creditLineManager, collateral } = fixture
			const expressAddr = await expressProvider.getAddress()
			const withdrawAmount = 500n * 10n ** 6n
			const creditAmount = 200n * 10n ** 6n

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
				creditDataRaw,
			)

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await collateral.mint(await symmio.getAddress(), creditAmount)
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			// Process
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, 1n, parts)

			// Finalize (mint remaining express amount to symmio, advance 12h)
			const remainingAmount = withdrawAmount - creditAmount
			await collateral.mint(await symmio.getAddress(), remainingAmount)
			await ethers.provider.send("evm_increaseTime", [12 * 3600])
			await ethers.provider.send("evm_mine", [])
			await symmio.finalizeWithdrawRequest(user.address, 1n)

			// Credit should be fully settled
			expect(await creditLineManager.reservedDebt()).to.equal(0n)
			expect(await creditLineManager.activeDebt()).to.equal(0n)
			expect(await creditLineManager.totalDebt()).to.equal(0n)
		})

		it("should cancel credit reservation on cancel before processing", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, symmio, affiliate, creditLineManager, collateral } = fixture
			const expressAddr = await expressProvider.getAddress()
			const withdrawAmount = 500n * 10n ** 6n
			const creditAmount = 200n * 10n ** 6n

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
				creditDataRaw,
			)

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await collateral.mint(await symmio.getAddress(), creditAmount)
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			expect(await creditLineManager.reservedDebt()).to.equal(creditAmount)

			// Cancel
			await symmio.mockCancelWithdraw(user.address, 1n)

			// Credit reservation should be released
			expect(await creditLineManager.reservedDebt()).to.equal(0n)
			expect(await creditLineManager.totalDebt()).to.equal(0n)
		})

		it("should cover loss from affiliate pool on post-payout force cancel", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, operator, user, receiver, symmio, affiliate, creditLineManager, collateral, affiliateFunding } = fixture
			const expressAddr = await expressProvider.getAddress()
			const withdrawAmount = 500n * 10n ** 6n
			const creditAmount = 200n * 10n ** 6n

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
				creditDataRaw,
			)

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await collateral.mint(await symmio.getAddress(), creditAmount)
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			// Process
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, 1n, parts)

			const affiliateBefore = await expressProvider.affiliateBalances(affiliate)

			// Force cancel after processing - should cover loss from affiliate pool
			await symmio.mockForceCancelWithdraw(user.address, 1n)

			// Affiliate pool should be reduced by creditAmount
			const affiliateAfter = await expressProvider.affiliateBalances(affiliate)
			expect(affiliateBefore - affiliateAfter).to.equal(creditAmount)

			// Credit should be settled
			expect(await creditLineManager.totalDebt()).to.equal(0n)
		})

		it("should reject credit for STANDARD withdrawals", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, symmio, affiliate, collateral } = fixture
			const expressAddr = await expressProvider.getAddress()
			const withdrawAmount = 500n * 10n ** 6n
			const creditAmount = 100n * 10n ** 6n

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
				optionType: 2,
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
				2,
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
				creditDataRaw,
			)

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await collateral.mint(await symmio.getAddress(), creditAmount)
			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revert(ethers) // CreditNotSupportedForStandard
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                    STATE MACHINE INVARIANTS
	// ═══════════════════════════════════════════════════════════════════

	describe("Liquidity Race Conditions", function () {
		it("second user's INSTANT withdrawal should revert when first depletes pool", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, symmio, affiliate } = fixture

			const signers = await ethers.getSigners()
			const user2 = signers[8]

			// General pool has 10,000 USDC. Both users try to withdraw 8,000.
			const withdrawAmount = 8_000n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			// User 1 signs and submits
			const parts1 = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			const partsHash1 = computePartsHash(parts1)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600

			const sig1 = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash: partsHash1,
				deadline,
			})
			const pd1 = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, 0n, 0n, deadline, sig1)
			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await symmio.mockInitiateWithdraw(user.address, parts1, pd1)

			// User 1 accepted — 8,000 locked. Only 2,000 unlocked remaining.
			expect(await expressProvider.lockedGeneralBalance()).to.equal(withdrawAmount)

			// User 2 tries same amount — should fail (only 2,000 available)
			const parts2 = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			const partsHash2 = computePartsHash(parts2)

			const sig2 = await signWithdrawOption(expressProvider, botSigner, {
				user: user2.address,
				nonce: 0n,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash: partsHash2,
				deadline,
			})
			const pd2 = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, 0n, 0n, deadline, sig2)
			await symmio.setDeallocateTimestamp(user2.address, now - 13 * 3600)

			await expect(symmio.mockInitiateWithdraw(user2.address, parts2, pd2)).to.be.revertedWithCustomError(
				expressProvider,
				"InsufficientGeneralBalance",
			)
		})

		it("second user succeeds if first user's withdrawal is cancelled (pool freed)", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, symmio, affiliate } = fixture

			const signers = await ethers.getSigners()
			const user2 = signers[8]

			const withdrawAmount = 8_000n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			// User 1 accepts
			const parts1 = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			const partsHash1 = computePartsHash(parts1)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600

			const sig1 = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash: partsHash1,
				deadline,
			})
			const pd1 = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, 0n, 0n, deadline, sig1)
			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await symmio.mockInitiateWithdraw(user.address, parts1, pd1)

			// User 1 cancels — pool freed
			await symmio.mockCancelWithdraw(user.address, 1)
			expect(await expressProvider.lockedGeneralBalance()).to.equal(0n)

			// User 2 now succeeds with 8,000
			const parts2 = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			const partsHash2 = computePartsHash(parts2)
			const deadline2 = (await ethers.provider.getBlock("latest"))!.timestamp + 3600

			const sig2 = await signWithdrawOption(expressProvider, botSigner, {
				user: user2.address,
				nonce: 0n,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash: partsHash2,
				deadline: deadline2,
			})
			const pd2 = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, 0n, 0n, deadline2, sig2)
			const now2 = (await ethers.provider.getBlock("latest"))!.timestamp
			await symmio.setDeallocateTimestamp(user2.address, now2 - 13 * 3600)

			await symmio.mockInitiateWithdraw(user2.address, parts2, pd2)
			expect(await symmio.acceptedRequests(user2.address, 1)).to.be.true
		})

		it("two IMMEDIATE withdrawals racing — second reverts on insufficient pool", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, symmio, affiliate, collateral } = fixture

			const VALIDATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("VALIDATOR_ROLE"))
			const signers = await ethers.getSigners()
			const user2 = signers[8]
			const validator1 = signers[9]
			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.setMinValidatorSignatures(1)

			const withdrawAmount = 8_000n * 10n ** 6n
			const expressAddr = await expressProvider.getAddress()

			async function signValApproval(u: string, nonce: bigint, amount: bigint, ts: number) {
				const domain = { name: "ExpressProvider", version: "1", chainId: 31337, verifyingContract: expressAddr }
				const types = {
					ValidatorApproval: [
						{ name: "user", type: "address" },
						{ name: "nonce", type: "uint256" },
						{ name: "amount", type: "uint256" },
						{ name: "timestamp", type: "uint256" },
						{ name: "symmioNonce", type: "uint256" },
					],
				}
				return validator1.signTypedData(domain, types, { user: u, nonce, amount, timestamp: ts, symmioNonce: 0n })
			}

			// User 1: IMMEDIATE (8,000 USDC)
			const parts1 = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			const partsHash1 = computePartsHash(parts1)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600

			const sig1 = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 0,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash: partsHash1,
				deadline,
			})
			const valSig1 = await signValApproval(user.address, 0n, withdrawAmount, now)
			const pd1 = encodeProviderData(0n, 0, 0, affiliate, 0n, 0n, 0n, 0n, deadline, sig1, undefined, [valSig1], [now])
			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			// User 1 gets funds immediately
			await symmio.mockInitiateWithdraw(user.address, parts1, pd1)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)

			// Pool deducted: 10,000 - 8,000 = 2,000 remaining
			expect(await expressProvider.generalBalance()).to.equal(2_000n * 10n ** 6n)

			// User 2: IMMEDIATE (8,000 USDC) — should fail
			const parts2 = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			const partsHash2 = computePartsHash(parts2)

			const sig2 = await signWithdrawOption(expressProvider, botSigner, {
				user: user2.address,
				nonce: 0n,
				optionType: 0,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash: partsHash2,
				deadline,
			})
			const valSig2 = await signValApproval(user2.address, 0n, withdrawAmount, now)
			const pd2 = encodeProviderData(0n, 0, 0, affiliate, 0n, 0n, 0n, 0n, deadline, sig2, undefined, [valSig2], [now])
			await symmio.setDeallocateTimestamp(user2.address, now - 13 * 3600)

			await expect(symmio.mockInitiateWithdraw(user2.address, parts2, pd2)).to.be.revertedWithCustomError(
				expressProvider,
				"InsufficientGeneralBalance",
			)
		})
	})

	// ═══════════════════════════════════════════════════════════════════

	describe("State Machine Invariants", function () {
		it("after processWithdraw, status is PROCESSED", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider } = fixture
			const { parts, requestId } = await acceptInstant(fixture)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(3n) // PROCESSED
		})

		it("after finalization, status is FINALIZED", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, symmio, collateral } = fixture
			const { parts, requestId, withdrawAmount } = await acceptInstant(fixture)

			// Process
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			// Finalize
			await collateral.mint(await symmio.getAddress(), withdrawAmount)
			await ethers.provider.send("evm_increaseTime", [12 * 3600])
			await ethers.provider.send("evm_mine", [])
			await symmio.finalizeWithdrawRequest(user.address, requestId)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(4n) // FINALIZED
		})

		it("after cancel, status is CANCELLED", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, symmio } = fixture
			const { requestId } = await acceptInstant(fixture)

			await symmio.mockCancelWithdraw(user.address, requestId)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(5n) // CANCELLED
		})

		it("after suspend, status is SUSPENDED", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, symmio } = fixture
			const { requestId } = await acceptInstant(fixture)

			await symmio.mockSuspendWithdraw(user.address, requestId)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(6n) // SUSPENDED
		})

		it("nonce incremented on acceptance", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider } = fixture

			expect(await expressProvider.nonces(user.address)).to.equal(0n)

			await acceptInstant(fixture)
			expect(await expressProvider.nonces(user.address)).to.equal(1n)

			await acceptInstant(fixture)
			expect(await expressProvider.nonces(user.address)).to.equal(2n)

			await acceptStandard(fixture)
			expect(await expressProvider.nonces(user.address)).to.equal(3n)
		})
	})

	describe("IMMEDIATE (same-tx transfer)", function () {
		const VALIDATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("VALIDATOR_ROLE"))

		async function signValidatorApproval(
			expressProvider: any,
			validator: any,
			params: { user: string; nonce: bigint; amount: bigint; timestamp: number; symmioNonce: bigint },
		) {
			const domain = { name: "ExpressProvider", version: "1", chainId: 31337, verifyingContract: await expressProvider.getAddress() }
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

		it("should transfer funds to user in the same tx as acceptance", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, symmio, affiliate, collateral } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[8]
			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.setMinValidatorSignatures(1)

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
			const deadline = now + 3600

			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 0,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const valSig = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce: 0n,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
			})

			const providerData = encodeProviderData(0n, 0, 0, affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			// Before: user has no funds
			expect(await collateral.balanceOf(receiver.address)).to.equal(0n)

			// Single tx: initiateWithdraw → onWithdrawRequest → funds transferred
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			// User has funds immediately (same tx)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)

			// Status is PROCESSED (skipped ACCEPTED)
			const info = await expressProvider.getWithdrawInfo(user.address, 1)
			expect(info.status).to.equal(3n) // PROCESSED
		})

		it("should reject IMMEDIATE without validators enabled", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, symmio, affiliate } = fixture

			// Validators NOT enabled (minValidatorSignatures = 0)
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
			const deadline = now + 3600

			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 0,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const providerData = encodeProviderData(0n, 0, 0, affiliate, 0n, 0n, 0n, 0n, deadline, signature)
			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			await expect(symmio.mockInitiateWithdraw(user.address, parts, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"ValidatorsRequiredForImmediate",
			)
		})

		it("should deduct fees during same-tx transfer", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, symmio, affiliate, collateral } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[8]
			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.setMinValidatorSignatures(1)
			await expressProvider.setAffiliateConfig(affiliate, 100, 1_000_000n) // 1% fee rate + 1 USDC operator fee

			const withdrawAmount = 500n * 10n ** 6n
			const fee = 5n * 10n ** 6n
			const opFee = 1_000_000n
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
			const deadline = now + 3600

			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 0,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee,
				operatorFee: opFee,
				partsHash,
				deadline,
			})

			const valSig = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce: 0n,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
			})

			const providerData = encodeProviderData(0n, 0, 0, affiliate, 0n, 0n, fee, opFee, deadline, signature, undefined, [valSig], [now])

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			// User gets amount minus fees
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount - fee - opFee)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee)
			expect(await expressProvider.collectedOperatorFees(affiliate)).to.equal(opFee)
		})

		it("should replenish pools on finalization (same as INSTANT)", async function () {
			const fixture = await deployFixture()
			const { deployer, botSigner, user, receiver, expressProvider, symmio, affiliate, collateral } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[8]
			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.setMinValidatorSignatures(1)

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
			const deadline = now + 3600

			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 0,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const valSig = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce: 0n,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
			})

			const providerData = encodeProviderData(0n, 0, 0, affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)

			const generalBefore = await expressProvider.generalBalance()
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)
			const generalAfter = await expressProvider.generalBalance()

			// Pool deducted
			expect(generalBefore - generalAfter).to.equal(withdrawAmount)

			// Finalize (12h later) — replenish pools
			await collateral.mint(await symmio.getAddress(), withdrawAmount)
			await ethers.provider.send("evm_increaseTime", [12 * 3600 + 1])
			await ethers.provider.send("evm_mine", [])
			await symmio.finalizeWithdrawRequest(user.address, 1)

			expect(await expressProvider.generalBalance()).to.equal(generalBefore)
			const info = await expressProvider.getWithdrawInfo(user.address, 1)
			expect(info.status).to.equal(4n) // FINALIZED
		})

		it("should not allow processWithdraw on IMMEDIATE (already PROCESSED)", async function () {
			const fixture = await deployFixture()
			const { botSigner, operator, user, receiver, expressProvider, symmio, affiliate } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[8]
			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.setMinValidatorSignatures(1)

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
			const deadline = now + 3600

			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 0,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const valSig = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce: 0n,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
			})

			const providerData = encodeProviderData(0n, 0, 0, affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			// processWithdraw should fail — already PROCESSED
			await expect(expressProvider.connect(operator).processWithdraw(user.address, 1, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"NotAccepted",
			)
		})

		it("should force cancel IMMEDIATE after payment (rollback)", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, symmio, affiliate } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[8]
			await expressProvider.grantRole(VALIDATOR_ROLE, validator1.address)
			await expressProvider.setMinValidatorSignatures(1)

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
			const deadline = now + 3600

			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 0,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const valSig = await signValidatorApproval(expressProvider, validator1, {
				user: user.address,
				nonce: 0n,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
			})

			const providerData = encodeProviderData(0n, 0, 0, affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			await symmio.setDeallocateTimestamp(user.address, now - 13 * 3600)
			await symmio.mockInitiateWithdraw(user.address, parts, providerData)

			expect(await fixture.collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)
			// In credit line model, force cancel after PROCESSED does rollback
			await symmio.mockForceCancelWithdraw(user.address, 1)
			const info = await expressProvider.getWithdrawInfo(user.address, 1)
			expect(info.status).to.equal(5n) // CANCELLED
		})
	})
}
