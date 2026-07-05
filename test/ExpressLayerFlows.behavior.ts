import { expect } from "chai"

import { deployExpressProvider } from "../tasks/deploy/expressWithdrawLayerDiamond.js"
import { initializeFixture } from "./Initialize.fixture.js"
import connection, { ethers, hre } from "./helpers/hardhat-connection.js"
import { WithdrawStatus } from "./models/Enums.js"
import { RunContext } from "./models/RunContext.js"

const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"))
const SIGNER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("SIGNER_ROLE"))
const LOCKER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LOCKER_ROLE"))
const UNLOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UNLOCK_ROLE"))

export function shouldBehaveLikeExpressLayerFlows(): void {
	async function deployFixture() {
		const context: RunContext = await initializeFixture()

		const allSigners = await ethers.getSigners()
		const deployer = context.signers.admin
		const user = context.signers.user
		const botSigner = allSigners[13]
		const operator = allSigners[14]
		const receiver = allSigners[15]
		const affiliateOwner = allSigners[16]
		const locker = allSigners[17]
		const unlocker = allSigners[18]

		const collateral = context.collateral

		// Deploy ExpressProvider diamond on top of real Symmio
		const expressProvider = await deployExpressProvider(hre, connection, {
			admin: deployer.address,
			symmio: context.diamond,
			collateral: await collateral.getAddress(),
		})

		// Deploy MockMuonSignatureVerifier for credit line
		const muonVerifier = await ethers.deployContract("MockMuonSignatureVerifier")

		// Register express provider on real Symmio
		await context.controlFacet.connect(deployer).registerExpressProvider(await expressProvider.getAddress())

		// Configure real Symmio for withdraw tests
		await context.controlFacet.connect(deployer).setMaxWithdrawParts(50)
		await context.controlFacet.connect(deployer).setWithdrawCooldownPeriod(43200)

		// Grant SUSPENDER_ROLE to admin on real Symmio
		await context.controlFacet.connect(deployer).grantRole(deployer.address, ethers.keccak256(ethers.toUtf8Bytes("SUSPENDER_ROLE")))

		// Configure ExpressProvider via roles
		await expressProvider.grantRole(SIGNER_ROLE, botSigner.address)
		await expressProvider.grantRole(OPERATOR_ROLE, operator.address)
		await expressProvider.grantRole(LOCKER_ROLE, locker.address)
		await expressProvider.grantRole(UNLOCK_ROLE, unlocker.address)
		const affiliate = affiliateOwner.address

		// Configure credit line on diamond
		await expressProvider.setCreditLineMuonConfig(await muonVerifier.getAddress(), 1n, 60n)

		// Set up user's balance in real Symmio
		const userBalance = 100_000n * 10n ** 18n
		await collateral.mint(user.address, userBalance)
		await collateral.connect(user).approve(context.diamond, ethers.MaxUint256)
		await context.accountFacet.connect(user).deposit(userBalance)

		// Fund general pool with 10,000 tokens
		const generalFunding = 10_000n * 10n ** 18n
		await collateral.mint(deployer.address, generalFunding)
		await collateral.approve(await expressProvider.getAddress(), generalFunding)
		await expressProvider.depositToGeneral(generalFunding)

		// Fund affiliate pool with 5,000 tokens
		const affiliateFunding = 5_000n * 10n ** 18n
		await collateral.mint(deployer.address, affiliateFunding)
		await collateral.approve(await expressProvider.getAddress(), affiliateFunding)
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
			collateral,
			expressProvider,
			muonVerifier,
			generalFunding,
			affiliateFunding,
		}
	}

	// Helper: trigger a recent deallocate so cooldownEndTime = now + 43200 (future)
	async function triggerRecentDeallocate(fixture: any) {
		const { context, user } = fixture
		await context.controlFacet.connect(context.signers.admin).grantRole(user.address, ethers.keccak256(ethers.toUtf8Bytes("BALANCE_SETTLER_ROLE")))
		await context.accountFacet.connect(user).allocate(1n)
		await context.accountFacet.connect(user).zeroUpnlDeallocate(1n)
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
			maxAccelerationFee?: bigint
			partsHash: string
			deadline: number
		},
	) {
		const maxUserFee = params.maxUserFee ?? params.fee + params.operatorFee
		const maxAccelerationFee = params.maxAccelerationFee ?? 0n
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
				{ name: "maxAccelerationFee", type: "uint256" },
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
			maxAccelerationFee,
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

	// Helper: encode provider data for initiateWithdraw (nested: offerData + validatorData + creditData)
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
		maxAccelerationFee?: bigint,
	): string {
		const muf = maxUserFee ?? fee + operatorFee
		const maf = maxAccelerationFee ?? 0n
		const offerData = ethers.AbiCoder.defaultAbiCoder().encode(
			["uint256", "uint8", "uint256", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "bytes"],
			[nonce, optionType, availableAt, affiliate, affiliateAmount, creditAmount, fee, operatorFee, muf, maf, deadline, signature],
		)
		const validatorData = ethers.AbiCoder.defaultAbiCoder().encode(
			["bytes[]", "uint256[]", "uint256"],
			[validatorSignatures ?? [], validatorTimestamps ?? [], 0],
		)
		return ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "bytes", "bytes"], [offerData, validatorData, creditDataRaw ?? "0x"])
	}

	// Helper: build credit data for Muon signature verification
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

	// Helper: accept a WINDOWED withdrawal and return parts + requestId
	async function acceptWindowed(fixture: any, opts?: { withdrawAmount?: bigint; affiliateAmount?: bigint; creditAmount?: bigint }) {
		const { botSigner, user, receiver, expressProvider, context, affiliate } = fixture
		const withdrawAmount = opts?.withdrawAmount ?? 500n * 10n ** 18n
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

		await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

		const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)
		return { parts, requestId, withdrawAmount, affiliateAmount }
	}

	// Helper: accept a STANDARD withdrawal
	async function acceptStandard(fixture: any, opts?: { withdrawAmount?: bigint; creditAmount?: bigint }) {
		const { botSigner, user, receiver, expressProvider, context, affiliate } = fixture
		const withdrawAmount = opts?.withdrawAmount ?? 500n * 10n ** 18n
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

		await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

		const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)
		return { parts, requestId, withdrawAmount }
	}

	// Helper: finalize a STANDARD withdrawal (advance time past cooldown, finalize)
	async function finalizeStandard(fixture: any, requestId: bigint, _amount: bigint) {
		const { context, user } = fixture
		await ethers.provider.send("evm_increaseTime", [12 * 3600])
		await ethers.provider.send("evm_mine", [])
		await context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)
	}

	// ═══════════════════════════════════════════════════════════════════
	//                           ACCEPTANCE
	// ═══════════════════════════════════════════════════════════════════

	describe("Acceptance", function () {
		it("should accept valid WINDOWED withdrawal and verify pool locks", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, affiliate } = fixture
			const affiliateAmount = 200n * 10n ** 18n
			const { withdrawAmount, requestId } = await acceptWindowed(fixture, { affiliateAmount })

			// Pool balances locked
			expect(await expressProvider.lockedGeneralBalance()).to.equal(withdrawAmount - affiliateAmount)
			expect(await expressProvider.lockedAffiliateBalances(affiliate)).to.equal(affiliateAmount)

			// WithdrawInfo stored
			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(1n) // ACCEPTED
			expect(info.optionType).to.equal(1n) // WINDOWED
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
			const { deployer, user, receiver, expressProvider, context, affiliate } = fixture
			const withdrawAmount = 500n * 10n ** 18n
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidSigner",
			)
		})

		it("should reject insufficient general balance (WINDOWED)", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, context, affiliate } = fixture
			const withdrawAmount = 20_000n * 10n ** 18n // more than 10,000 general pool
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"InsufficientGeneralBalance",
			)
		})

		it("should reject expired option deadline", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, context, affiliate } = fixture
			const withdrawAmount = 500n * 10n ** 18n
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"OfferExpired",
			)
		})

		it("should reject invalid nonce (wrong nonce)", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, context, affiliate } = fixture
			const withdrawAmount = 500n * 10n ** 18n
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidNonce",
			)
		})

		it("should reject nonce replay (resubmit same nonce after consumption)", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, context, affiliate } = fixture

			// First: accept a valid withdrawal (consumes nonce 0)
			await acceptWindowed(fixture)
			expect(await expressProvider.nonces(user.address)).to.equal(1n)

			// Second: try to replay with nonce 0
			const withdrawAmount = 500n * 10n ** 18n
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidNonce",
			)
		})

		it("should reject nonce skip (use nonce+2 instead of nonce+1)", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, context, affiliate } = fixture

			// Accept first withdrawal (consumes nonce 0, next expected is 1)
			await acceptWindowed(fixture)
			expect(await expressProvider.nonces(user.address)).to.equal(1n)

			// Try to use nonce 2 (skipping 1)
			const withdrawAmount = 300n * 10n ** 18n
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidNonce",
			)
		})

		it("should reject invalid optionType > 2 (reverts with Panic due to enum out of range)", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, context, affiliate } = fixture
			const withdrawAmount = 500n * 10n ** 18n
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

			// Solidity 0.8+ reverts with Panic(0x21) for invalid enum conversion
			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revert(ethers)
		})

		it("should revert with AffiliateExceedsExpress when affiliateAmount > expressAmount", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, context, affiliate } = fixture
			const withdrawAmount = 500n * 10n ** 18n
			const affiliateAmount = 600n * 10n ** 18n // exceeds expressAmount
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"FundingSplitExceedsExpress",
			)
		})

		it("should succeed when affiliateAmount == expressAmount (boundary)", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider } = fixture
			const withdrawAmount = 500n * 10n ** 18n
			const affiliateAmount = withdrawAmount
			const { requestId } = await acceptWindowed(fixture, { withdrawAmount, affiliateAmount })

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(1n)
			expect(info.generalAmount).to.equal(0n)
		})

		it("parts with expressProvider == 0 do not count toward expressAmount", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, context, affiliate } = fixture
			const expressAddr = await expressProvider.getAddress()

			const expressShare = 400n * 10n ** 18n
			const directShare = 600n * 10n ** 18n
			const affiliateAmount = 100n * 10n ** 18n

			const parts = [
				{
					id: 0n,
					amount: expressShare,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
				{
					id: 0n,
					amount: directShare,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: ethers.ZeroAddress,
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

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)
			const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.expressAmount).to.equal(expressShare)
			expect(info.affiliateAmount).to.equal(affiliateAmount)
			expect(info.generalAmount).to.equal(expressShare - affiliateAmount)

			expect(await expressProvider.lockedGeneralBalance()).to.equal(expressShare - affiliateAmount)
			expect(await expressProvider.lockedAffiliateBalances(affiliate)).to.equal(affiliateAmount)
		})

		it("should revert FundingSplitExceedsExpress when affiliate+credit exceeds express-only share", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, context, affiliate } = fixture
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: 300n * 10n ** 18n,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
				{
					id: 0n,
					amount: 500n * 10n ** 18n,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: ethers.ZeroAddress,
				},
			]
			const affiliateAmount = 400n * 10n ** 18n

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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"FundingSplitExceedsExpress",
			)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                           PROCESSING
	// ═══════════════════════════════════════════════════════════════════

	describe("Processing", function () {
		it("WINDOWED: process after securityWindow by operator", async function () {
			const fixture = await deployFixture()
			const { operator, user, receiver, expressProvider, collateral } = fixture
			const { parts, requestId, withdrawAmount } = await acceptWindowed(fixture)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])

			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(3n) // PROCESSED
		})

		it("WINDOWED: reject before securityWindow (TooEarly)", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider } = fixture
			const { parts, requestId } = await acceptWindowed(fixture)

			// Do not advance time - still within 20s security window
			await expect(expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"TooEarly",
			)
		})

		it("WINDOWED: permissionless processing after securityWindow + tolerancePeriod", async function () {
			const fixture = await deployFixture()
			const { user, receiver, expressProvider, collateral } = fixture
			const { parts, requestId, withdrawAmount } = await acceptWindowed(fixture)

			// Advance past securityWindow (20) + tolerancePeriod (60) = 80s
			await ethers.provider.send("evm_increaseTime", [81])
			await ethers.provider.send("evm_mine", [])

			// user (non-operator) can process
			await expressProvider.connect(user).processWithdraw(user.address, requestId, parts)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)
		})

		it("WINDOWED: reject permissionless before tolerance expires", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider } = fixture
			const { parts, requestId } = await acceptWindowed(fixture)

			// Advance 30s: past securityWindow (20) but not past securityWindow + tolerancePeriod (80)
			await ethers.provider.send("evm_increaseTime", [30])
			await ethers.provider.send("evm_mine", [])

			await expect(expressProvider.connect(user).processWithdraw(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"TooEarly",
			)
		})

		it("WINDOWED: process at exact securityWindow boundary", async function () {
			const fixture = await deployFixture()
			const { operator, user, receiver, expressProvider, collateral } = fixture
			const { parts, requestId, withdrawAmount } = await acceptWindowed(fixture)

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

		it("STANDARD: process right after finalization by operator", async function () {
			const fixture = await deployFixture()
			const { operator, user, receiver, expressProvider, collateral } = fixture
			const { parts, requestId, withdrawAmount } = await acceptStandard(fixture)

			await finalizeStandard(fixture, requestId, withdrawAmount)

			// Operator can process right after finalization
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
			const { parts, requestId } = await acceptWindowed(fixture)

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
			const { requestId } = await acceptWindowed(fixture)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])

			// Create different parts (different amount)
			const wrongParts = [
				{
					id: 0n,
					amount: 999n * 10n ** 18n, // wrong amount
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

		it("should reject processWithdraw on CANCELLED (NotAccepted)", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, context } = fixture
			const { parts, requestId } = await acceptWindowed(fixture)

			await context.withdrawFacet.connect(user).requestCancelWithdraw(requestId)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])

			await expect(expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"NotAccepted",
			)
		})

		it("should reject processWithdraw on SUSPENDED (NotAccepted)", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, context } = fixture
			const { parts, requestId } = await acceptWindowed(fixture)

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])

			await expect(expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"NotAccepted",
			)
		})

		it("should revert InvalidAddressBytesLength when receiver is 19 bytes", async function () {
			const fixture = await deployFixture()
			const { botSigner, operator, user, expressProvider, context, affiliate } = fixture
			const withdrawAmount = 300n * 10n ** 18n
			const expressAddr = await expressProvider.getAddress()

			const shortReceiver = "0x" + "ab".repeat(19)
			const parts = [
				{
					id: 0n,
					amount: withdrawAmount,
					chainId: 31337n,
					receiver: shortReceiver,
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
			const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])

			await expect(expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidAddressBytesLength",
			)

			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(1n)
		})

		it("should revert InvalidAddressBytesLength when receiver is 21 bytes", async function () {
			const fixture = await deployFixture()
			const { botSigner, operator, user, expressProvider, context, affiliate } = fixture
			const expressAddr = await expressProvider.getAddress()

			const longReceiver = "0x" + "cd".repeat(21)
			const parts = [
				{
					id: 0n,
					amount: 100n * 10n ** 18n,
					chainId: 31337n,
					receiver: longReceiver,
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
			const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])

			await expect(expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidAddressBytesLength",
			)
		})

		it("securityWindow minimum allows near-zero-delay operator processing", async function () {
			const fixture = await deployFixture()
			const { operator, user, receiver, expressProvider, collateral } = fixture

			// Set securityWindow to minimum (10s)
			await expressProvider.setSecurityWindow(10)

			const { parts, requestId, withdrawAmount } = await acceptWindowed(fixture)

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

		it("tolerancePeriod minimum allows near-zero-delay permissionless processing after securityWindow", async function () {
			const fixture = await deployFixture()
			const { user, receiver, expressProvider, collateral } = fixture

			// Set tolerancePeriod to minimum (10s)
			await expressProvider.setTolerancePeriod(10)

			const { parts, requestId, withdrawAmount } = await acceptWindowed(fixture)

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
		it("WINDOWED: replenish pools after cooldown", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, context, collateral, generalFunding } = fixture
			const affiliateAmount = 200n * 10n ** 18n
			const { parts, requestId, withdrawAmount } = await acceptWindowed(fixture, { affiliateAmount })

			// Process
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			// After processing, pools are reduced
			expect(await expressProvider.generalBalance()).to.equal(generalFunding - (withdrawAmount - affiliateAmount))

			// Finalize (advance past cooldown)
			await ethers.provider.send("evm_increaseTime", [12 * 3600])
			await ethers.provider.send("evm_mine", [])
			await context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)

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

			// Finalize (Symmio sends tokens)
			await finalizeStandard(fixture, requestId, withdrawAmount)

			// Status stays LOCKED (not overwritten to FINALIZED)
			info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(2n) // Still LOCKED
			expect(info.finalizedAt).to.be.greaterThan(0n) // But finalizedAt recorded
		})

		it("STANDARD ACCEPTED + cooldown elapsed reverts NotFinalized (processWithdraw does not auto-finalize)", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider } = fixture
			const { parts, requestId } = await acceptStandard(fixture)

			await ethers.provider.send("evm_increaseTime", [12 * 3600 + 1])
			await ethers.provider.send("evm_mine", [])

			await expect(expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"NotFinalized",
			)
			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(1n)
		})

		it("STANDARD LOCKED processWithdraw succeeds at exact cooldownEndTime boundary", async function () {
			const fixture = await deployFixture()
			const { operator, user, receiver, expressProvider, collateral, locker } = fixture

			await triggerRecentDeallocate(fixture)
			const { parts, requestId, withdrawAmount } = await acceptStandard(fixture)

			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			await ethers.provider.send("evm_setNextBlockTimestamp", [Number(info.cooldownEndTime)])

			const receiverBefore = await collateral.balanceOf(receiver.address)
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(3n)
			expect(await collateral.balanceOf(receiver.address)).to.equal(receiverBefore + withdrawAmount)
		})
	})

	describe("onWithdrawComplete status guards", function () {
		it("finalize before process reverts for WINDOWED and leaves state recoverable", async function () {
			const fixture = await deployFixture()
			const { user, operator, expressProvider, context, generalFunding, affiliateFunding, affiliate } = fixture

			const affiliateAmount = 200n * 10n ** 18n
			const { parts, requestId, withdrawAmount } = await acceptWindowed(fixture, { affiliateAmount })

			const generalAfterAccept = await expressProvider.generalBalance()
			const affiliateAfterAccept = await expressProvider.affiliateBalances(affiliate)
			const lockedGeneralAfterAccept = await expressProvider.lockedGeneralBalance()
			const lockedAffiliateAfterAccept = await expressProvider.lockedAffiliateBalances(affiliate)
			expect(generalAfterAccept).to.equal(generalFunding)
			expect(affiliateAfterAccept).to.equal(affiliateFunding)
			expect(lockedGeneralAfterAccept).to.equal(withdrawAmount - affiliateAmount)
			expect(lockedAffiliateAfterAccept).to.equal(affiliateAmount)

			await ethers.provider.send("evm_increaseTime", [12 * 3600 + 1])
			await ethers.provider.send("evm_mine", [])

			await expect(context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidStatusForComplete",
			)

			expect(await expressProvider.generalBalance()).to.equal(generalAfterAccept)
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateAfterAccept)
			expect(await expressProvider.lockedGeneralBalance()).to.equal(lockedGeneralAfterAccept)
			expect(await expressProvider.lockedAffiliateBalances(affiliate)).to.equal(lockedAffiliateAfterAccept)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(1n)

			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)
			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(3n)

			await context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)
			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(4n)

			expect(await expressProvider.generalBalance()).to.equal(generalFunding)
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateFunding)
			expect(await expressProvider.lockedGeneralBalance()).to.equal(0n)
			expect(await expressProvider.lockedAffiliateBalances(affiliate)).to.equal(0n)
		})

		it("finalize on CANCELLED WINDOWED reverts (core blocks before express hook)", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context } = fixture
			const { requestId } = await acceptWindowed(fixture)

			await context.withdrawFacet.connect(user).requestCancelWithdraw(requestId)

			await ethers.provider.send("evm_increaseTime", [12 * 3600])
			await ethers.provider.send("evm_mine", [])

			await expect(context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)).to.be.revert(ethers)

			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(5n)
		})

		it("finalize on SUSPENDED WINDOWED (pre-process) reverts (core suspender gate fires first)", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context } = fixture
			const { requestId } = await acceptWindowed(fixture)

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			await ethers.provider.send("evm_increaseTime", [12 * 3600])
			await ethers.provider.send("evm_mine", [])

			await expect(context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)).to.be.revert(ethers)

			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(6n)
		})

		it("finalize on LOCKED WINDOWED reverts and keeps the lock", async function () {
			const fixture = await deployFixture()
			const { user, locker, unlocker, expressProvider, context } = fixture

			const affiliateAmount = 200n * 10n ** 18n
			const { parts, requestId } = await acceptWindowed(fixture, { affiliateAmount })

			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)
			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(2n)

			await ethers.provider.send("evm_increaseTime", [12 * 3600 + 1])
			await ethers.provider.send("evm_mine", [])

			await expect(context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidStatusForComplete",
			)

			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(2n)

			await expressProvider.connect(unlocker).unlockAndProcess(user.address, requestId, parts)
			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(3n)

			await context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)
			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(4n)
		})

		it("process then finalize restores pools for WINDOWED", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, generalFunding, affiliateFunding, affiliate } = fixture

			const affiliateAmount = 200n * 10n ** 18n
			const { parts, requestId } = await acceptWindowed(fixture, { affiliateAmount })

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(fixture.operator).processWithdraw(user.address, requestId, parts)

			await ethers.provider.send("evm_increaseTime", [12 * 3600])
			await ethers.provider.send("evm_mine", [])
			await context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)

			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(4n)
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateFunding)
		})

		it("suspend after advance refunds non-advanced portion only", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, affiliate } = fixture

			const affiliateAmount = 200n * 10n ** 18n
			const creditAmount = 100n * 10n ** 18n
			const withdrawAmount = 500n * 10n ** 18n
			const expressAddr = await expressProvider.getAddress()
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600

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

			const signature = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce: 0n,
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
			const creditDataRaw = buildCreditData(10_000n * 10n ** 18n, now)
			const providerData = encodeProviderData(
				0n,
				1,
				0,
				affiliate,
				affiliateAmount,
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

			const userBalanceBefore = await context.viewFacet.balanceOf(user.address)
			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)
			const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(fixture.operator).processWithdraw(user.address, requestId, parts)

			const req = await context.viewFacet.getWithdrawRequests(user.address, requestId)
			expect(req.advancedAmount).to.equal(creditAmount)

			const lockedBefore = await context.viewFacet.getWithdrawLockedBalance()
			const balanceBeforeSuspend = await context.viewFacet.balanceOf(user.address)

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			const lockedAfter = await context.viewFacet.getWithdrawLockedBalance()
			const balanceAfter = await context.viewFacet.balanceOf(user.address)

			expect(lockedBefore - lockedAfter).to.equal(withdrawAmount - creditAmount)
			expect(balanceAfter - balanceBeforeSuspend).to.equal(withdrawAmount - creditAmount)
			expect(userBalanceBefore - balanceAfter).to.equal(creditAmount)
		})

		it("SAME_TX with credit advances from core in the same tx", async function () {
			const fixture = await deployFixture()
			const { user, receiver, botSigner, expressProvider, context, affiliate, collateral } = fixture

			const allSigners = await ethers.getSigners()
			const validator1 = allSigners[19]
			await expressProvider.setValidator(affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(affiliate, 1)

			const withdrawAmount = 500n * 10n ** 18n
			const creditAmount = 100n * 10n ** 18n
			const affiliateAmount = 200n * 10n ** 18n
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
				affiliateAmount,
				creditAmount,
				fee: 0n,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const domain = { name: "ExpressProvider", version: "1", chainId: 31337, verifyingContract: expressAddr }
			const valTypes = {
				ValidatorApproval: [
					{ name: "user", type: "address" },
					{ name: "nonce", type: "uint256" },
					{ name: "amount", type: "uint256" },
					{ name: "timestamp", type: "uint256" },
					{ name: "symmioNonce", type: "uint256" },
					{ name: "symmio", type: "address" },
				],
			}
			const valSig = await validator1.signTypedData(domain, valTypes, {
				user: user.address,
				nonce: 0n,
				amount: withdrawAmount,
				timestamp: now,
				symmioNonce: 0n,
				symmio: context.diamond,
			})

			const creditDataRaw = buildCreditData(10_000n * 10n ** 18n, now)
			const providerData = encodeProviderData(
				0n,
				0,
				0,
				affiliate,
				affiliateAmount,
				creditAmount,
				0n,
				0n,
				deadline,
				signature,
				undefined,
				[valSig],
				[now],
				creditDataRaw,
			)

			const receiverBalBefore = await collateral.balanceOf(receiver.address)
			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)
			const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(3n)
			expect(info.creditAmount).to.equal(creditAmount)

			const req = await context.viewFacet.getWithdrawRequests(user.address, requestId)
			expect(req.advancedAmount).to.equal(creditAmount)

			expect(await collateral.balanceOf(receiver.address)).to.equal(receiverBalBefore + withdrawAmount)
		})

		it("provider cannot call advanceWithdraw from inside onWithdrawComplete", async function () {
			const fixture = await deployFixture()
			const { context, collateral, deployer } = fixture

			const allSigners = await ethers.getSigners()
			const userA = allSigners[10]
			const userB = allSigners[11]
			const userBalance = 100_000n * 10n ** 18n
			for (const u of [userA, userB]) {
				await collateral.mint(u.address, userBalance)
				await collateral.connect(u).approve(context.diamond, ethers.MaxUint256)
				await context.accountFacet.connect(u).deposit(userBalance)
			}

			const Mal = await ethers.getContractFactory("contracts/core/test/MaliciousAdvanceProvider.sol:MaliciousAdvanceProvider")
			const mal = await Mal.deploy(context.diamond)
			await mal.waitForDeployment()
			const malAddr = await mal.getAddress()
			await context.controlFacet.connect(deployer).registerExpressProvider(malAddr)

			// Concurrent withdrawal so withdrawLockedBalance has slack for the attack to hit.
			const benignAmount = 1000n * 10n ** 18n
			const benignParts = [
				{
					id: 0n,
					amount: benignAmount,
					chainId: 31337n,
					receiver: ethers.solidityPacked(["address"], [userB.address]),
					virtualProvider: ethers.ZeroAddress,
					expressProvider: malAddr,
				},
			]
			await context.withdrawFacet.connect(userB).initiateWithdraw(benignParts, false, "0x")

			const aAmount = 500n * 10n ** 18n
			const aParts = [
				{
					id: 0n,
					amount: aAmount,
					chainId: 31337n,
					receiver: ethers.solidityPacked(["address"], [userA.address]),
					virtualProvider: ethers.ZeroAddress,
					expressProvider: malAddr,
				},
			]
			await context.withdrawFacet.connect(userA).initiateWithdraw(aParts, false, "0x")
			const aReqId = await context.viewFacet.getLastWithdrawRequestId(userA.address)

			await mal.setAttack(true, aAmount)

			await ethers.provider.send("evm_increaseTime", [12 * 3600 + 1])
			await ethers.provider.send("evm_mine", [])

			const malBalanceBefore = await collateral.balanceOf(malAddr)

			await expect(context.withdrawFacet.finalizeWithdrawRequest(userA.address, aReqId)).to.be.reverted

			expect(await collateral.balanceOf(malAddr)).to.equal(malBalanceBefore)
			expect(await mal.extraExtracted()).to.equal(0n)

			await mal.setAttack(false, 0n)
			await context.withdrawFacet.finalizeWithdrawRequest(userA.address, aReqId)
			expect(await collateral.balanceOf(malAddr)).to.equal(malBalanceBefore + aAmount)
		})

		it("second finalize on STANDARD LOCKED reverts", async function () {
			const fixture = await deployFixture()
			const { user, locker, expressProvider, context } = fixture
			const { requestId, withdrawAmount } = await acceptStandard(fixture)

			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)

			await finalizeStandard(fixture, requestId, withdrawAmount)
			const info1 = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info1.status).to.equal(2n)
			expect(info1.finalizedAt).to.be.greaterThan(0n)

			await expect(context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)).to.be.reverted
		})

		it("coverLoss preserves lockedAffiliateBalances <= affiliateBalances invariant", async function () {
			const fixture = await deployFixture()
			const { user, botSigner, expressProvider, context, affiliate, collateral, receiver } = fixture

			const allSigners = await ethers.getSigners()
			const userB = allSigners[10]
			const userBalance = 100_000n * 10n ** 18n
			await collateral.mint(userB.address, userBalance)
			await collateral.connect(userB).approve(context.diamond, ethers.MaxUint256)
			await context.accountFacet.connect(userB).deposit(userBalance)

			const expressAddr = await expressProvider.getAddress()
			const user1Amount = 4000n * 10n ** 18n
			const user1Affiliate = 2000n * 10n ** 18n
			const user1Credit = 2000n * 10n ** 18n
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600

			const user1Parts = [
				{
					id: 0n,
					amount: user1Amount,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			const user1Sig = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount: user1Affiliate,
				creditAmount: user1Credit,
				fee: 0n,
				operatorFee: 0n,
				partsHash: computePartsHash(user1Parts),
				deadline,
			})
			const creditDataRaw = buildCreditData(10_000n * 10n ** 18n, now)
			const user1ProviderData = encodeProviderData(
				0n,
				1,
				0,
				affiliate,
				user1Affiliate,
				user1Credit,
				0n,
				0n,
				deadline,
				user1Sig,
				undefined,
				undefined,
				undefined,
				creditDataRaw,
			)

			await context.withdrawFacet.connect(user).initiateWithdraw(user1Parts, false, user1ProviderData)
			const user1Req = await context.viewFacet.getLastWithdrawRequestId(user.address)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(fixture.operator).processWithdraw(user.address, user1Req, user1Parts)

			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(3000n * 10n ** 18n)

			const user2Amount = 3000n * 10n ** 18n
			const user2Parts = [
				{
					id: 0n,
					amount: user2Amount,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			const user2Sig = await signWithdrawOption(expressProvider, botSigner, {
				user: userB.address,
				nonce: 0n,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount: user2Amount,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash: computePartsHash(user2Parts),
				deadline,
			})
			const user2ProviderData = encodeProviderData(0n, 1, 0, affiliate, user2Amount, 0n, 0n, 0n, deadline, user2Sig)
			await context.withdrawFacet.connect(userB).initiateWithdraw(user2Parts, false, user2ProviderData)
			const user2Req = await context.viewFacet.getLastWithdrawRequestId(userB.address)

			expect(await expressProvider.lockedAffiliateBalances(affiliate)).to.equal(3000n * 10n ** 18n)

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, user1Req)

			const balanceAfter = await expressProvider.affiliateBalances(affiliate)
			const lockedAfter = await expressProvider.lockedAffiliateBalances(affiliate)
			expect(balanceAfter).to.equal(3000n * 10n ** 18n)
			expect(lockedAfter).to.equal(3000n * 10n ** 18n)
			expect(balanceAfter).to.be.gte(lockedAfter)
			expect(await expressProvider.creditLineBadDebt(affiliate)).to.equal(user1Credit)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(fixture.operator).processWithdraw(userB.address, user2Req, user2Parts)
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(0n)
			expect(await expressProvider.lockedAffiliateBalances(affiliate)).to.equal(0n)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                          CANCELLATION
	// ═══════════════════════════════════════════════════════════════════

	describe("Cancellation", function () {
		it("should cancel WINDOWED before processing", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, generalFunding, affiliateFunding, affiliate } = fixture
			const affiliateAmount = 200n * 10n ** 18n
			const { requestId } = await acceptWindowed(fixture, { affiliateAmount })

			await context.withdrawFacet.connect(user).requestCancelWithdraw(requestId)

			// Pool balances fully restored
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)
			expect(await expressProvider.lockedGeneralBalance()).to.equal(0n)
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateFunding)
			expect(await expressProvider.lockedAffiliateBalances(affiliate)).to.equal(0n)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(5n) // CANCELLED
		})

		it("should reject cancel WINDOWED after processing", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, context } = fixture
			const { parts, requestId } = await acceptWindowed(fixture)

			// Process first
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			// Cancel after processing should fail (express provider's internal status is PROCESSED,
			// onWithdrawCancelRequest checks NotAccepted)
			await expect(context.withdrawFacet.connect(user).requestCancelWithdraw(requestId)).to.be.revert(ethers)
		})

		it("should cancel STANDARD before finalization", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, generalFunding } = fixture
			const { requestId } = await acceptStandard(fixture)

			await context.withdrawFacet.connect(user).requestCancelWithdraw(requestId)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(5n) // CANCELLED
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)
		})

		it("should reject cancel STANDARD after finalization", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, context } = fixture
			const { parts, requestId, withdrawAmount } = await acceptStandard(fixture)

			// Finalize
			await finalizeStandard(fixture, requestId, withdrawAmount)

			// Process
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			// Cancel after finalization+processing should fail
			await expect(context.withdrawFacet.connect(user).requestCancelWithdraw(requestId)).to.be.revert(ethers)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                           SUSPENSION
	// ═══════════════════════════════════════════════════════════════════

	describe("Suspension", function () {
		it("should suspend ACCEPTED WINDOWED (unlock pools)", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, generalFunding } = fixture
			const { requestId, withdrawAmount } = await acceptWindowed(fixture)

			// Verify pools are locked
			expect(await expressProvider.lockedGeneralBalance()).to.equal(withdrawAmount)

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			// Pools unlocked
			expect(await expressProvider.lockedGeneralBalance()).to.equal(0n)
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(6n) // SUSPENDED
		})

		it("should suspend LOCKED withdrawal", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, generalFunding, locker } = fixture
			const { requestId } = await acceptWindowed(fixture)

			// Lock first
			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)
			let info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(2n) // LOCKED

			// Suspend
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			// Pools unlocked
			expect(await expressProvider.lockedGeneralBalance()).to.equal(0n)
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)

			info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(6n) // SUSPENDED
		})

		it("should revert suspend on FINALIZED", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, context, collateral } = fixture
			const { parts, requestId, withdrawAmount } = await acceptWindowed(fixture)

			// Process
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			// Finalize
			await ethers.provider.send("evm_increaseTime", [12 * 3600])
			await ethers.provider.send("evm_mine", [])
			await context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)

			// Suspend after finalization should fail
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await expect(context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)).to.be.revert(ethers)
		})

		it("should reject suspend on LOCKED STANDARD after finalization", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, locker } = fixture
			const { requestId, withdrawAmount } = await acceptStandard(fixture)

			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)
			await finalizeStandard(fixture, requestId, withdrawAmount)

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await expect(context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)).to.be.revert(ethers)
		})

		it("should revert suspend on already CANCELLED", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context } = fixture
			const { requestId } = await acceptWindowed(fixture)

			// Cancel first
			await context.withdrawFacet.connect(user).requestCancelWithdraw(requestId)
			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(5n) // CANCELLED

			// Suspend after cancel: lockedGeneralBalance already 0, would underflow
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await expect(context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)).to.be.revert(ethers)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                           RISK LOCK
	// ═══════════════════════════════════════════════════════════════════

	describe("Risk Lock", function () {
		it("should lock ACCEPTED withdrawal", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, locker } = fixture
			const { requestId } = await acceptWindowed(fixture)

			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(2n) // LOCKED
		})

		it("should lock STANDARD ACCEPTED without touching pool locks", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, locker, affiliate, generalFunding, affiliateFunding } = fixture
			const { requestId } = await acceptStandard(fixture)

			expect(await expressProvider.lockedGeneralBalance()).to.equal(0n)
			expect(await expressProvider.lockedAffiliateBalances(affiliate)).to.equal(0n)

			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)
			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(2n)

			expect(await expressProvider.lockedGeneralBalance()).to.equal(0n)
			expect(await expressProvider.lockedAffiliateBalances(affiliate)).to.equal(0n)
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateFunding)
		})

		it("should reject lock on already LOCKED", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, locker } = fixture
			const { requestId } = await acceptWindowed(fixture)

			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)

			await expect(expressProvider.connect(locker).lockWithdraw(user.address, requestId)).to.be.revertedWithCustomError(
				expressProvider,
				"NotAccepted",
			)
		})

		it("should reject lock on PROCESSED", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, locker } = fixture
			const { parts, requestId } = await acceptWindowed(fixture)

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
			const { user, expressProvider, context, locker } = fixture
			const { requestId } = await acceptWindowed(fixture)

			await context.withdrawFacet.connect(user).requestCancelWithdraw(requestId)

			await expect(expressProvider.connect(locker).lockWithdraw(user.address, requestId)).to.be.revertedWithCustomError(
				expressProvider,
				"NotAccepted",
			)
		})

		it("should unlockAndProcess on LOCKED WINDOWED", async function () {
			const fixture = await deployFixture()
			const { user, receiver, expressProvider, collateral, locker, unlocker } = fixture
			const { parts, requestId, withdrawAmount } = await acceptWindowed(fixture)

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
			const { user, expressProvider, collateral, locker, unlocker } = fixture

			// Use a large amount that exceeds the contract's total token balance.
			// The contract has 15,000 (10k general + 5k affiliate). Request 20,000.
			const withdrawAmount = 20_000n * 10n ** 18n
			const expressAddr = await expressProvider.getAddress()

			// Fund more to general pool to allow acceptance (STANDARD doesn't lock pools)
			const extraFund = 15_000n * 10n ** 18n
			await collateral.mint(fixture.deployer.address, extraFund)
			await collateral.approve(expressAddr, extraFund)
			await expressProvider.depositToGeneral(extraFund)

			const { parts, requestId } = await acceptStandard(fixture, { withdrawAmount })

			// Lock (status becomes LOCKED)
			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)

			// Withdraw most of the general pool so the contract doesn't have enough tokens
			// to transfer the full 20,000. We need to leave less than 20,000 in the contract.
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
			const { parts, requestId } = await acceptWindowed(fixture)

			await expect(expressProvider.connect(unlocker).unlockAndProcess(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"NotLocked",
			)
		})

		it("should reject unlockAndProcess on PROCESSED", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, unlocker } = fixture
			const { parts, requestId } = await acceptWindowed(fixture)

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
			const { parts, requestId } = await acceptWindowed(fixture)

			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)
			await expressProvider.connect(unlocker).unlockAndProcess(user.address, requestId, parts)

			// Second call: status is PROCESSED, not LOCKED
			await expect(expressProvider.connect(unlocker).unlockAndProcess(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"NotLocked",
			)
		})

		it("should reject unlockAndProcess on CANCELLED", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, unlocker, context } = fixture
			const { parts, requestId } = await acceptWindowed(fixture)

			await context.withdrawFacet.connect(user).requestCancelWithdraw(requestId)

			await expect(expressProvider.connect(unlocker).unlockAndProcess(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"NotLocked",
			)
		})

		it("should reject unlockAndProcess on SUSPENDED after LOCKED→SUSPEND", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, locker, unlocker, context } = fixture
			const { parts, requestId } = await acceptWindowed(fixture)

			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			await expect(expressProvider.connect(unlocker).unlockAndProcess(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"NotLocked",
			)
		})

		it("should reject unlockAndProcess on FINALIZED WINDOWED", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, unlocker, context } = fixture
			const { parts, requestId } = await acceptWindowed(fixture)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			await ethers.provider.send("evm_increaseTime", [12 * 3600])
			await ethers.provider.send("evm_mine", [])
			await context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)

			await expect(expressProvider.connect(unlocker).unlockAndProcess(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"NotLocked",
			)
		})

		it("should processWithdraw on LOCKED WINDOWED after cooldown", async function () {
			const fixture = await deployFixture()
			const { user, receiver, expressProvider, collateral, locker } = fixture
			const { parts, requestId, withdrawAmount } = await acceptWindowed(fixture)

			// Lock the withdrawal
			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)
			let info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(2n) // LOCKED

			// deallocateTimestamp = 0, so cooldownEndTime = now (already expired).
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
			const { operator, user, receiver, expressProvider, context, collateral, locker } = fixture
			const { parts, requestId, withdrawAmount } = await acceptStandard(fixture)

			// Lock the withdrawal
			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)
			let info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(2n) // LOCKED

			// deallocateTimestamp = 0, so cooldownEndTime = now (already expired).
			// Advance 12h so SYMMIO finalization succeeds, then past tolerancePeriod.
			await ethers.provider.send("evm_increaseTime", [12 * 3600 + 61])
			await ethers.provider.send("evm_mine", [])

			// Finalize on SYMMIO first (tokens arrive at express provider)
			await context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)

			// processWithdraw succeeds on LOCKED after cooldown
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)

			info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(3n) // PROCESSED
		})

		it("should reject processWithdraw on LOCKED WINDOWED before cooldown", async function () {
			const fixture = await deployFixture()
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, locker } = fixture
			const withdrawAmount = 500n * 10n ** 18n
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

			// Trigger recent deallocate so cooldownEndTime = now + 43200 (cooldown NOT expired)
			await triggerRecentDeallocate(fixture)
			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)

			// Lock the withdrawal
			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)

			// Advance past securityWindow but NOT past cooldownEndTime (43200s away)
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

			const { requestId } = await acceptWindowed(fixture)
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
		it("should reserve credit on WINDOWED acceptance", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, context, affiliate } = fixture
			const expressAddr = await expressProvider.getAddress()
			const withdrawAmount = 500n * 10n ** 18n
			const creditAmount = 200n * 10n ** 18n

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
				creditDataRaw,
			)

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			// Credit should be reserved
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(creditAmount)
			expect(await expressProvider.creditLineActiveDebt(affiliate)).to.equal(0n)
		})

		it("should activate credit and advance collateral on processing", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, operator, user, receiver, context, affiliate } = fixture
			const expressAddr = await expressProvider.getAddress()
			const withdrawAmount = 500n * 10n ** 18n
			const creditAmount = 200n * 10n ** 18n

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
				creditDataRaw,
			)

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			// Process
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, 1n, parts)

			// Credit should now be active (moved from reserved to active)
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(0n)
			expect(await expressProvider.creditLineActiveDebt(affiliate)).to.equal(creditAmount)
		})

		it("should settle credit on finalization", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, operator, user, receiver, context, affiliate } = fixture
			const expressAddr = await expressProvider.getAddress()
			const withdrawAmount = 500n * 10n ** 18n
			const creditAmount = 200n * 10n ** 18n

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
				creditDataRaw,
			)

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			// Process
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, 1n, parts)

			// Finalize (advance past cooldown)
			await ethers.provider.send("evm_increaseTime", [12 * 3600])
			await ethers.provider.send("evm_mine", [])
			await context.withdrawFacet.finalizeWithdrawRequest(user.address, 1n)

			// Credit should be fully settled
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(0n)
			expect(await expressProvider.creditLineActiveDebt(affiliate)).to.equal(0n)
			expect(await expressProvider.creditLineTotalDebt(affiliate)).to.equal(0n)
		})

		it("should cancel credit reservation on cancel before processing", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, context, affiliate } = fixture
			const expressAddr = await expressProvider.getAddress()
			const withdrawAmount = 500n * 10n ** 18n
			const creditAmount = 200n * 10n ** 18n

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
				creditDataRaw,
			)

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(creditAmount)

			// Cancel
			await context.withdrawFacet.connect(user).requestCancelWithdraw(1n)

			// Credit reservation should be released
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(0n)
			expect(await expressProvider.creditLineTotalDebt(affiliate)).to.equal(0n)
		})

		it("should revert reserveDebt when signatureVerifier is unconfigured", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, context, affiliate, deployer } = fixture
			const expressAddr = await expressProvider.getAddress()

			await expressProvider.connect(deployer).setCreditLineMuonConfig(ethers.ZeroAddress, 1n, 60n)

			const withdrawAmount = 300n * 10n ** 18n
			const creditAmount = 100n * 10n ** 18n

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
			const creditDataRaw = buildCreditData(100_000n * 10n ** 18n, now)
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"CreditLineNotConfigured",
			)
			expect(await expressProvider.nonces(user.address)).to.equal(0n)
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(0n)
		})

		it("should revert MuonSignatureExpired when data.timestamp is older than freshness window", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, context, affiliate } = fixture
			const expressAddr = await expressProvider.getAddress()

			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const staleTs = now - 120

			const withdrawAmount = 300n * 10n ** 18n
			const creditAmount = 100n * 10n ** 18n

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
			const deadline = now + 3600

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
			const creditDataRaw = buildCreditData(100_000n * 10n ** 18n, staleTs)
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"MuonSignatureExpired",
			)
			expect(await expressProvider.nonces(user.address)).to.equal(0n)
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(0n)
		})

		it("should revert MuonSignatureExpired when data.timestamp is in the future", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, context, affiliate } = fixture
			const expressAddr = await expressProvider.getAddress()

			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const futureTs = now + 60

			const withdrawAmount = 300n * 10n ** 18n
			const creditAmount = 100n * 10n ** 18n

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
			const deadline = now + 3600

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
			const creditDataRaw = buildCreditData(100_000n * 10n ** 18n, futureTs)
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"MuonSignatureExpired",
			)
			expect(await expressProvider.nonces(user.address)).to.equal(0n)
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(0n)
		})

		it("should succeed at the exact absolute cap boundary (newTotalDebt == effectiveMaxDebt)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, context, affiliate, deployer } = fixture
			const expressAddr = await expressProvider.getAddress()

			const cap = 800n * 10n ** 18n
			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliate, cap, 0)

			const withdrawAmount = 900n * 10n ** 18n
			const creditAmount = cap // exactly the cap

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
			const creditDataRaw = buildCreditData(100_000n * 10n ** 18n, now)
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

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(cap)
			expect(await expressProvider.creditLineRequestDebt(affiliate, user.address, 1n)).to.equal(cap)
		})

		it("should revert DebtExceedsAbsoluteCap when newTotalDebt exceeds cap by 1 wei", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, context, affiliate, deployer } = fixture
			const expressAddr = await expressProvider.getAddress()

			const cap = 800n * 10n ** 18n
			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliate, cap, 0)

			const creditAmount = cap + 1n

			const parts = [
				{
					id: 0n,
					amount: 900n * 10n ** 18n,
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
			const creditDataRaw = buildCreditData(100_000n * 10n ** 18n, now)
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"DebtExceedsAbsoluteCap",
			)
			expect(await expressProvider.nonces(user.address)).to.equal(0n)
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(0n)
		})

		it("should succeed at the exact bps cap boundary (newTotalDebt == eligibleBase * bps / 10000)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, context, affiliate, deployer } = fixture
			const expressAddr = await expressProvider.getAddress()

			// 10% cap against a 1_000 eligibleBase ⇒ max debt = 100.
			const bps = 1000n
			const eligibleBase = 1_000n * 10n ** 18n
			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliate, 0, bps)

			const creditAmount = (eligibleBase * bps) / 10000n

			const parts = [
				{
					id: 0n,
					amount: 500n * 10n ** 18n,
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
			const creditDataRaw = buildCreditData(eligibleBase, now)
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

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(creditAmount)
			expect(await expressProvider.creditLineRequestDebt(affiliate, user.address, 1n)).to.equal(creditAmount)
		})

		it("should enforce the stricter cap when protocol < affiliate (protocol wins)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, context, affiliate, deployer } = fixture
			const expressAddr = await expressProvider.getAddress()

			// set affiliate under a loose protocol, then tighten protocol below the stored affiliate cap
			const protocolCap = 300n * 10n ** 18n
			const affiliateCap = 1000n * 10n ** 18n
			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliate, 5000n * 10n ** 18n, 0)
			await expressProvider.connect(deployer).setCreditLineAffiliateConfig(affiliate, affiliateCap, 0)
			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliate, protocolCap, 0)

			const creditAmount = protocolCap + 1n
			const parts = [
				{
					id: 0n,
					amount: 900n * 10n ** 18n,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const sig = await signWithdrawOption(expressProvider, botSigner, {
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
			const creditDataRaw = buildCreditData(100_000n * 10n ** 18n, now)
			const pd = encodeProviderData(0n, 1, 0, affiliate, 0n, creditAmount, 0n, 0n, deadline, sig, undefined, undefined, undefined, creditDataRaw)

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, pd)).to.be.revertedWithCustomError(
				expressProvider,
				"DebtExceedsAbsoluteCap",
			)
		})

		it("should enforce the stricter cap when affiliate < protocol (affiliate wins)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, context, affiliate, deployer } = fixture
			const expressAddr = await expressProvider.getAddress()

			const protocolCap = 1000n * 10n ** 18n
			const affiliateCap = 300n * 10n ** 18n
			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliate, protocolCap, 0)
			await expressProvider.connect(deployer).setCreditLineAffiliateConfig(affiliate, affiliateCap, 0)

			const creditAmount = affiliateCap + 1n
			const parts = [
				{
					id: 0n,
					amount: 900n * 10n ** 18n,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const sig = await signWithdrawOption(expressProvider, botSigner, {
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
			const creditDataRaw = buildCreditData(100_000n * 10n ** 18n, now)
			const pd = encodeProviderData(0n, 1, 0, affiliate, 0n, creditAmount, 0n, 0n, deadline, sig, undefined, undefined, undefined, creditDataRaw)

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, pd)).to.be.revertedWithCustomError(
				expressProvider,
				"DebtExceedsAbsoluteCap",
			)
		})

		it("should revert DebtExceedsPercentCap when bps cap is set and eligibleBase is zero", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, context, affiliate, deployer } = fixture
			const expressAddr = await expressProvider.getAddress()

			// 0 * bps / 10000 == 0 so any non-zero credit exceeds the bps cap
			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliate, 0, 1000n)
			const creditAmount = 1n

			const parts = [
				{
					id: 0n,
					amount: 500n * 10n ** 18n,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			const partsHash = computePartsHash(parts)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const sig = await signWithdrawOption(expressProvider, botSigner, {
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
			const creditDataRaw = buildCreditData(0n, now)
			const pd = encodeProviderData(0n, 1, 0, affiliate, 0n, creditAmount, 0n, 0n, deadline, sig, undefined, undefined, undefined, creditDataRaw)

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, pd)).to.be.revertedWithCustomError(
				expressProvider,
				"DebtExceedsPercentCap",
			)
		})

		it("should isolate credit-line debt aggregates across affiliates", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, context, affiliate: affiliateA, deployer, collateral } = fixture
			const expressAddr = await expressProvider.getAddress()

			const affiliateB = "0x000000000000000000000000000000000000B1B2"

			await collateral.mint(deployer.address, 5_000n * 10n ** 18n)
			await collateral.connect(deployer).approve(expressAddr, 5_000n * 10n ** 18n)
			await expressProvider.connect(deployer).depositToAffiliate(affiliateB, 5_000n * 10n ** 18n)

			const creditA = 100n * 10n ** 18n
			const partsA = [
				{
					id: 0n,
					amount: 300n * 10n ** 18n,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const sigA = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 1,
				availableAt: 0,
				affiliate: affiliateA,
				affiliateAmount: 0n,
				creditAmount: creditA,
				fee: 0n,
				operatorFee: 0n,
				partsHash: computePartsHash(partsA),
				deadline,
			})
			const creditDataA = buildCreditData(100_000n * 10n ** 18n, now)
			const pdA = encodeProviderData(0n, 1, 0, affiliateA, 0n, creditA, 0n, 0n, deadline, sigA, undefined, undefined, undefined, creditDataA)
			await context.withdrawFacet.connect(user).initiateWithdraw(partsA, false, pdA)

			const creditB = 200n * 10n ** 18n
			const partsB = [
				{
					id: 0n,
					amount: 400n * 10n ** 18n,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			const sigB = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 1n,
				optionType: 1,
				availableAt: 0,
				affiliate: affiliateB,
				affiliateAmount: 0n,
				creditAmount: creditB,
				fee: 0n,
				operatorFee: 0n,
				partsHash: computePartsHash(partsB),
				deadline,
			})
			const creditDataB = buildCreditData(100_000n * 10n ** 18n, now)
			const pdB = encodeProviderData(1n, 1, 0, affiliateB, 0n, creditB, 0n, 0n, deadline, sigB, undefined, undefined, undefined, creditDataB)
			await context.withdrawFacet.connect(user).initiateWithdraw(partsB, false, pdB)

			expect(await expressProvider.creditLineReservedDebt(affiliateA)).to.equal(creditA)
			expect(await expressProvider.creditLineReservedDebt(affiliateB)).to.equal(creditB)
			expect(await expressProvider.creditLineRequestDebt(affiliateA, user.address, 1n)).to.equal(creditA)
			expect(await expressProvider.creditLineRequestDebt(affiliateB, user.address, 2n)).to.equal(creditB)
			expect(await expressProvider.creditLineRequestDebt(affiliateA, user.address, 2n)).to.equal(0n)
			expect(await expressProvider.creditLineRequestDebt(affiliateB, user.address, 1n)).to.equal(0n)
		})

		it("should reject credit for STANDARD withdrawals", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, receiver, context, affiliate } = fixture
			const expressAddr = await expressProvider.getAddress()
			const withdrawAmount = 500n * 10n ** 18n
			const creditAmount = 100n * 10n ** 18n

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

			const creditDataRaw = buildCreditData(10_000n * 10n ** 18n, now)
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revert(ethers) // CreditNotSupportedForStandard
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                    STATE MACHINE INVARIANTS
	// ═══════════════════════════════════════════════════════════════════

	describe("Liquidity Race Conditions", function () {
		it("second user's WINDOWED withdrawal should revert when first depletes pool", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, context, affiliate } = fixture

			const allSigners = await ethers.getSigners()
			const user2 = allSigners[19]

			// Set up user2's balance in real Symmio
			const user2Balance = 100_000n * 10n ** 18n
			await context.collateral.mint(user2.address, user2Balance)
			await context.collateral.connect(user2).approve(context.diamond, ethers.MaxUint256)
			await context.accountFacet.connect(user2).deposit(user2Balance)

			// General pool has 10,000 tokens. Both users try to withdraw 8,000.
			const withdrawAmount = 8_000n * 10n ** 18n
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
			await context.withdrawFacet.connect(user).initiateWithdraw(parts1, false, pd1)

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

			await expect(context.withdrawFacet.connect(user2).initiateWithdraw(parts2, false, pd2)).to.be.revertedWithCustomError(
				expressProvider,
				"InsufficientGeneralBalance",
			)
		})

		it("second user succeeds if first user's withdrawal is cancelled (pool freed)", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, context, affiliate } = fixture

			const allSigners = await ethers.getSigners()
			const user2 = allSigners[19]

			// Set up user2's balance in real Symmio
			const user2Balance = 100_000n * 10n ** 18n
			await context.collateral.mint(user2.address, user2Balance)
			await context.collateral.connect(user2).approve(context.diamond, ethers.MaxUint256)
			await context.accountFacet.connect(user2).deposit(user2Balance)

			const withdrawAmount = 8_000n * 10n ** 18n
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
			await context.withdrawFacet.connect(user).initiateWithdraw(parts1, false, pd1)

			// User 1 cancels — pool freed
			await context.withdrawFacet.connect(user).requestCancelWithdraw(1n)
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

			await context.withdrawFacet.connect(user2).initiateWithdraw(parts2, false, pd2)
			// Verify request was created
			const requestId = await context.viewFacet.getLastWithdrawRequestId(user2.address)
			expect(requestId).to.equal(1n)
		})

		it("two SAME_TX withdrawals racing — second reverts on insufficient pool", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, context, affiliate, collateral } = fixture

			const allSigners = await ethers.getSigners()
			const user2 = allSigners[19]

			// Set up user2's balance in real Symmio
			const user2Balance = 100_000n * 10n ** 18n
			await collateral.mint(user2.address, user2Balance)
			await collateral.connect(user2).approve(context.diamond, ethers.MaxUint256)
			await context.accountFacet.connect(user2).deposit(user2Balance)

			const validator1 = allSigners[19]
			await expressProvider.setValidator(affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(affiliate, 1)

			const withdrawAmount = 8_000n * 10n ** 18n
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
						{ name: "symmio", type: "address" },
					],
				}
				return validator1.signTypedData(domain, types, { user: u, nonce, amount, timestamp: ts, symmioNonce: 0n, symmio: context.diamond })
			}

			// User 1: SAME_TX (8,000 tokens)
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

			// User 1 gets funds right away
			await context.withdrawFacet.connect(user).initiateWithdraw(parts1, false, pd1)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)

			// Pool deducted: 10,000 - 8,000 = 2,000 remaining
			expect(await expressProvider.generalBalance()).to.equal(2_000n * 10n ** 18n)

			// User 2: SAME_TX (8,000 tokens) — should fail
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

			await expect(context.withdrawFacet.connect(user2).initiateWithdraw(parts2, false, pd2)).to.be.revertedWithCustomError(
				expressProvider,
				"InsufficientGeneralBalance",
			)
		})
	})

	// ═══════════════════════════════════════════════════════════════════

	describe("State Machine Invariants", function () {
		it("after processWithdraw, status is PROCESSED", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, context } = fixture
			const { parts, requestId } = await acceptWindowed(fixture)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(3n) // PROCESSED

			const coreRequest = await context.viewFacet.getWithdrawRequests(user.address, requestId)
			expect(coreRequest.status).to.equal(WithdrawStatus.PROVIDER_ACCEPTED)
		})

		it("after finalization, status is FINALIZED", async function () {
			const fixture = await deployFixture()
			const { operator, user, expressProvider, context } = fixture
			const { parts, requestId, withdrawAmount } = await acceptWindowed(fixture)

			// Process
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			// Finalize
			await ethers.provider.send("evm_increaseTime", [12 * 3600])
			await ethers.provider.send("evm_mine", [])
			await context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(4n) // FINALIZED
		})

		it("after cancel, status is CANCELLED", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context } = fixture
			const { requestId } = await acceptWindowed(fixture)

			await context.withdrawFacet.connect(user).requestCancelWithdraw(requestId)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(5n) // CANCELLED
		})

		it("after suspend, status is SUSPENDED", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context } = fixture
			const { requestId } = await acceptWindowed(fixture)

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(6n) // SUSPENDED
		})

		it("nonce incremented on acceptance", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider } = fixture

			expect(await expressProvider.nonces(user.address)).to.equal(0n)

			await acceptWindowed(fixture)
			expect(await expressProvider.nonces(user.address)).to.equal(1n)

			await acceptWindowed(fixture)
			expect(await expressProvider.nonces(user.address)).to.equal(2n)

			await acceptStandard(fixture)
			expect(await expressProvider.nonces(user.address)).to.equal(3n)
		})
	})

	describe("SAME_TX (same-tx transfer)", function () {
		async function signValidatorApproval(
			expressProvider: any,
			validator: any,
			params: { user: string; nonce: bigint; amount: bigint; timestamp: number; symmioNonce: bigint; symmio: string },
		) {
			const domain = { name: "ExpressProvider", version: "1", chainId: 31337, verifyingContract: await expressProvider.getAddress() }
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

		it("should transfer funds to user in the same tx as acceptance", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, context, affiliate, collateral } = fixture

			const allSigners = await ethers.getSigners()
			const validator1 = allSigners[19]
			await expressProvider.setValidator(affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(affiliate, 1)

			const withdrawAmount = 500n * 10n ** 18n
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
				symmio: context.diamond,
			})

			const providerData = encodeProviderData(0n, 0, 0, affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			// Before: user has no funds
			expect(await collateral.balanceOf(receiver.address)).to.equal(0n)

			// Single tx: initiateWithdraw -> onWithdrawRequest -> funds transferred
			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			// User has funds in the same transaction (same tx)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)

			// Status is PROCESSED (skipped ACCEPTED)
			const info = await expressProvider.getWithdrawInfo(user.address, 1)
			expect(info.status).to.equal(3n) // PROCESSED

			const coreRequest = await context.viewFacet.getWithdrawRequests(user.address, 1)
			expect(coreRequest.status).to.equal(WithdrawStatus.PROVIDER_ACCEPTED)
		})

		it("should reject SAME_TX without validators enabled", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, context, affiliate } = fixture

			// Validators NOT enabled (minValidatorSignatures = 0)
			const withdrawAmount = 500n * 10n ** 18n
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

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"ValidatorsRequiredForSameTx",
			)
		})

		it("should deduct fees during same-tx transfer", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, context, affiliate, collateral } = fixture

			const allSigners = await ethers.getSigners()
			const validator1 = allSigners[19]
			await expressProvider.setValidator(affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(affiliate, 1)
			await expressProvider.setAffiliateConfig(affiliate, 100, 1n * 10n ** 18n) // 1% fee rate + 1 token operator fee

			const withdrawAmount = 500n * 10n ** 18n
			const fee = 5n * 10n ** 18n
			const opFee = 1n * 10n ** 18n
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
				symmio: context.diamond,
			})

			const providerData = encodeProviderData(0n, 0, 0, affiliate, 0n, 0n, fee, opFee, deadline, signature, undefined, [valSig], [now])

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)
			const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)

			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount - fee - opFee)

			expect(await expressProvider.pendingFees(user.address, requestId)).to.equal(fee)
			expect(await expressProvider.pendingOperatorFees(user.address, requestId)).to.equal(opFee)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(0n)
			expect(await expressProvider.collectedOperatorFees(affiliate)).to.equal(0n)

			await ethers.provider.send("evm_increaseTime", [12 * 3600])
			await ethers.provider.send("evm_mine", [])
			await context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)

			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee)
			expect(await expressProvider.collectedOperatorFees(affiliate)).to.equal(opFee)
			expect(await expressProvider.pendingFees(user.address, requestId)).to.equal(0n)
			expect(await expressProvider.pendingOperatorFees(user.address, requestId)).to.equal(0n)
		})

		it("should replenish pools on finalization (same as WINDOWED)", async function () {
			const fixture = await deployFixture()
			const { botSigner, user, receiver, expressProvider, context, affiliate, collateral } = fixture

			const allSigners = await ethers.getSigners()
			const validator1 = allSigners[19]
			await expressProvider.setValidator(affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(affiliate, 1)

			const withdrawAmount = 500n * 10n ** 18n
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
				symmio: context.diamond,
			})

			const providerData = encodeProviderData(0n, 0, 0, affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			const generalBefore = await expressProvider.generalBalance()
			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)
			const generalAfter = await expressProvider.generalBalance()

			// Pool deducted
			expect(generalBefore - generalAfter).to.equal(withdrawAmount)

			// Finalize (12h later) — replenish pools
			await ethers.provider.send("evm_increaseTime", [12 * 3600 + 1])
			await ethers.provider.send("evm_mine", [])
			await context.withdrawFacet.finalizeWithdrawRequest(user.address, 1)

			expect(await expressProvider.generalBalance()).to.equal(generalBefore)
			const info = await expressProvider.getWithdrawInfo(user.address, 1)
			expect(info.status).to.equal(4n) // FINALIZED
		})

		it("should not allow processWithdraw on SAME_TX (already PROCESSED)", async function () {
			const fixture = await deployFixture()
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate } = fixture

			const allSigners = await ethers.getSigners()
			const validator1 = allSigners[19]
			await expressProvider.setValidator(affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(affiliate, 1)

			const withdrawAmount = 500n * 10n ** 18n
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
				symmio: context.diamond,
			})

			const providerData = encodeProviderData(0n, 0, 0, affiliate, 0n, 0n, 0n, 0n, deadline, signature, undefined, [valSig], [now])

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			// processWithdraw should fail — already PROCESSED
			await expect(expressProvider.connect(operator).processWithdraw(user.address, 1, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"NotAccepted",
			)
		})
	})

	describe("Credit loss coverage", function () {
		async function setupProcessedWithCredit(fixture: any, affiliateAmount: bigint, creditAmount: bigint, withdrawAmount: bigint) {
			const { user, botSigner, receiver, expressProvider, context, affiliate } = fixture
			const expressAddr = await expressProvider.getAddress()
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600

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
			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount,
				creditAmount,
				fee: 0n,
				operatorFee: 0n,
				partsHash: computePartsHash(parts),
				deadline,
			})
			const creditDataRaw = buildCreditData(100_000n * 10n ** 18n, now)
			const providerData = encodeProviderData(
				0n,
				1,
				0,
				affiliate,
				affiliateAmount,
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

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)
			const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(fixture.operator).processWithdraw(user.address, requestId, parts)

			return { parts, requestId }
		}

		it("post-processed suspend accrues bad debt when affiliate pool cannot fully cover credit", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, affiliate, affiliateFunding } = fixture

			const affiliateAmount = 3000n * 10n ** 18n
			const creditAmount = 3000n * 10n ** 18n
			const withdrawAmount = 7000n * 10n ** 18n
			const { requestId } = await setupProcessedWithCredit(fixture, affiliateAmount, creditAmount, withdrawAmount)

			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateFunding - affiliateAmount)
			expect(await expressProvider.creditLineBadDebt(affiliate)).to.equal(0n)

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(0n)
			const expectedBadDebt = creditAmount - (affiliateFunding - affiliateAmount)
			expect(await expressProvider.creditLineBadDebt(affiliate)).to.equal(expectedBadDebt)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(6n)

			expect(await expressProvider.creditLineRequestDebt(affiliate, user.address, requestId)).to.equal(0n)
			expect(await expressProvider.creditLineActiveDebt(affiliate)).to.equal(0n)
		})

		it("post-processed suspend deducts in full and leaves no bad debt when pool covers", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, affiliate, affiliateFunding } = fixture

			const affiliateAmount = 1000n * 10n ** 18n
			const creditAmount = 1000n * 10n ** 18n
			const withdrawAmount = 5000n * 10n ** 18n
			const { requestId } = await setupProcessedWithCredit(fixture, affiliateAmount, creditAmount, withdrawAmount)

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateFunding - affiliateAmount - creditAmount)
			expect(await expressProvider.creditLineBadDebt(affiliate)).to.equal(0n)
		})

		it("complete after post-processed suspend reverts and leaves pools and debt untouched", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, affiliate } = fixture

			const affiliateAmount = 500n * 10n ** 18n
			const creditAmount = 500n * 10n ** 18n
			const withdrawAmount = 3000n * 10n ** 18n
			const { requestId } = await setupProcessedWithCredit(fixture, affiliateAmount, creditAmount, withdrawAmount)

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			const generalBefore = await expressProvider.generalBalance()
			const affiliateBefore = await expressProvider.affiliateBalances(affiliate)
			const activeDebtBefore = await expressProvider.creditLineActiveDebt(affiliate)

			await expect(context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)).to.be.reverted

			expect(await expressProvider.generalBalance()).to.equal(generalBefore)
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateBefore)
			expect(await expressProvider.creditLineActiveDebt(affiliate)).to.equal(activeDebtBefore)
			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(6n)
		})
	})

	describe("Emergency rescue", function () {
		it("rescues arbitrary ERC20 tokens held by the diamond", async function () {
			const fixture = await deployFixture()
			const { expressProvider, collateral, deployer, receiver } = fixture

			const stuck = 1_234n * 10n ** 18n
			await collateral.mint(deployer.address, stuck)
			await collateral.connect(deployer).transfer(await expressProvider.getAddress(), stuck)

			const before = await collateral.balanceOf(receiver.address)
			await expressProvider.connect(deployer).rescueTokens(await collateral.getAddress(), receiver.address, stuck)
			expect(await collateral.balanceOf(receiver.address)).to.equal(before + stuck)
		})

		it("rejects rescueTokens from a non-owner caller", async function () {
			const fixture = await deployFixture()
			const { expressProvider, collateral, user, receiver } = fixture
			await expect(expressProvider.connect(user).rescueTokens(await collateral.getAddress(), receiver.address, 1n)).to.be.reverted
		})

		it("reverts when rescueTokens amount exceeds diamond balance", async function () {
			const fixture = await deployFixture()
			const { expressProvider, collateral, deployer, receiver } = fixture
			const expressAddr = await expressProvider.getAddress()

			const held = await collateral.balanceOf(expressAddr)
			await expect(expressProvider.connect(deployer).rescueTokens(await collateral.getAddress(), receiver.address, held + 1n)).to.be.reverted

			expect(await collateral.balanceOf(expressAddr)).to.equal(held)
		})

		it("recovers tokens stranded after STANDARD finalize when the configured receiver is unusable", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, collateral, deployer, locker } = fixture

			const { requestId, withdrawAmount } = await acceptStandard(fixture)
			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)
			await finalizeStandard(fixture, requestId, withdrawAmount)

			const rescueRecipient = fixture.affiliateOwner
			const before = await collateral.balanceOf(rescueRecipient.address)
			await expressProvider.connect(deployer).rescueTokens(await collateral.getAddress(), rescueRecipient.address, withdrawAmount)
			expect(await collateral.balanceOf(rescueRecipient.address)).to.equal(before + withdrawAmount)
		})
	})

	describe("Post payout rollback bookkeeping", function () {
		async function setupWindowedWithSponsor(
			fixture: any,
			opts: { sponsorAmount: bigint; fee: bigint; affiliateAmount: bigint; creditAmount: bigint },
		) {
			const { user, botSigner, receiver, expressProvider, context, affiliate, deployer, collateral } = fixture
			await expressProvider.connect(deployer).setAffiliateConfig(affiliate, 200, 0)

			await collateral.mint(deployer.address, opts.sponsorAmount)
			await collateral.connect(deployer).approve(await expressProvider.getAddress(), opts.sponsorAmount)
			await expressProvider.connect(deployer).depositSponsorBalance(affiliate, opts.sponsorAmount)

			const withdrawAmount = 500n * 10n ** 18n
			const expressAddr = await expressProvider.getAddress()
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
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
			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount: opts.affiliateAmount,
				creditAmount: opts.creditAmount,
				fee: opts.fee,
				operatorFee: 0n,
				maxUserFee: opts.fee,
				partsHash: computePartsHash(parts),
				deadline,
			})
			const creditDataRaw = buildCreditData(100_000n * 10n ** 18n, now)
			const providerData = encodeProviderData(
				0n,
				1,
				0,
				affiliate,
				opts.affiliateAmount,
				opts.creditAmount,
				opts.fee,
				0n,
				deadline,
				signature,
				opts.fee,
				undefined,
				undefined,
				creditDataRaw,
			)
			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)
			const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(fixture.operator).processWithdraw(user.address, requestId, parts)
			return { requestId, withdrawAmount }
		}

		it("restores sponsor balance from pending fee escrow on post-processed suspend", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, affiliate } = fixture

			const fee = 10n * 10n ** 18n
			const sponsorAmount = 100n * 10n ** 18n
			const { requestId } = await setupWindowedWithSponsor(fixture, {
				sponsorAmount,
				fee,
				affiliateAmount: 100n * 10n ** 18n,
				creditAmount: 100n * 10n ** 18n,
			})

			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount - fee)
			expect(await expressProvider.pendingFees(user.address, requestId)).to.equal(fee)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(0n)

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount)
			expect(await expressProvider.pendingFees(user.address, requestId)).to.equal(0n)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(0n)
			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).sponsorCoverage).to.equal(0n)
		})

		it("sponsor restoration drains collected operator fees when affiliate fee is zero", async function () {
			const fixture = await deployFixture()
			const { user, botSigner, receiver, expressProvider, context, affiliate, deployer, collateral } = fixture

			const operatorFee = 10n * 10n ** 18n
			await expressProvider.connect(deployer).setAffiliateConfig(affiliate, 0, operatorFee)

			const sponsorAmount = 100n * 10n ** 18n
			await collateral.mint(deployer.address, sponsorAmount)
			await collateral.connect(deployer).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(deployer).depositSponsorBalance(affiliate, sponsorAmount)

			const withdrawAmount = 500n * 10n ** 18n
			const expressAddr = await expressProvider.getAddress()
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
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
			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount: 100n * 10n ** 18n,
				creditAmount: 50n * 10n ** 18n,
				fee: 0n,
				operatorFee,
				maxUserFee: 0n,
				partsHash: computePartsHash(parts),
				deadline,
			})
			const creditDataRaw = buildCreditData(100_000n * 10n ** 18n, now)
			const providerData = encodeProviderData(
				0n,
				1,
				0,
				affiliate,
				100n * 10n ** 18n,
				50n * 10n ** 18n,
				0n,
				operatorFee,
				deadline,
				signature,
				0n,
				undefined,
				undefined,
				creditDataRaw,
			)
			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)
			const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(fixture.operator).processWithdraw(user.address, requestId, parts)

			expect(await expressProvider.pendingOperatorFees(user.address, requestId)).to.equal(operatorFee)
			expect(await expressProvider.collectedOperatorFees(affiliate)).to.equal(0n)

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount)
			expect(await expressProvider.pendingOperatorFees(user.address, requestId)).to.equal(0n)
			expect(await expressProvider.collectedOperatorFees(affiliate)).to.equal(0n)
		})

		it("sponsor restoration is unaffected by an attempted claimFees before the rollback", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, affiliate, deployer } = fixture

			const fee = 10n * 10n ** 18n
			const sponsorAmount = 100n * 10n ** 18n
			const { requestId } = await setupWindowedWithSponsor(fixture, {
				sponsorAmount,
				fee,
				affiliateAmount: 100n * 10n ** 18n,
				creditAmount: 100n * 10n ** 18n,
			})

			await expect(expressProvider.connect(deployer).claimFees(affiliate, deployer.address)).to.be.revertedWithCustomError(
				expressProvider,
				"NoFeesToClaim",
			)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(0n)
			expect(await expressProvider.pendingFees(user.address, requestId)).to.equal(fee)

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount)
			expect(await expressProvider.pendingFees(user.address, requestId)).to.equal(0n)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(0n)
			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).sponsorCoverage).to.equal(0n)
		})

		it("accumulates generalBadDebt equal to the lost generalAmount on post-processed suspend", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context } = fixture

			const affiliateAmount = 100n * 10n ** 18n
			const creditAmount = 50n * 10n ** 18n
			const withdrawAmount = 500n * 10n ** 18n
			const expectedGeneralAmount = withdrawAmount - affiliateAmount - creditAmount

			expect(await expressProvider.generalBadDebt()).to.equal(0n)

			const { requestId } = await (async () => {
				const { botSigner, receiver, affiliate } = fixture
				const expressAddr = await expressProvider.getAddress()
				const now = (await ethers.provider.getBlock("latest"))!.timestamp
				const deadline = now + 3600
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
				const sig = await signWithdrawOption(expressProvider, botSigner, {
					user: user.address,
					nonce: 0n,
					optionType: 1,
					availableAt: 0,
					affiliate,
					affiliateAmount,
					creditAmount,
					fee: 0n,
					operatorFee: 0n,
					partsHash: computePartsHash(parts),
					deadline,
				})
				const creditDataRaw = buildCreditData(100_000n * 10n ** 18n, now)
				const pd = encodeProviderData(
					0n,
					1,
					0,
					affiliate,
					affiliateAmount,
					creditAmount,
					0n,
					0n,
					deadline,
					sig,
					undefined,
					undefined,
					undefined,
					creditDataRaw,
				)
				await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, pd)
				const id = await context.viewFacet.getLastWithdrawRequestId(user.address)
				await ethers.provider.send("evm_increaseTime", [21])
				await ethers.provider.send("evm_mine", [])
				await expressProvider.connect(fixture.operator).processWithdraw(user.address, id, parts)
				return { requestId: id }
			})()

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			expect(await expressProvider.generalBadDebt()).to.equal(expectedGeneralAmount)
		})

		it("generalBadDebt stays zero when the withdrawal has no general portion", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, botSigner, receiver, affiliate } = fixture

			const withdrawAmount = 500n * 10n ** 18n
			const affiliateAmount = 300n * 10n ** 18n
			const creditAmount = 200n * 10n ** 18n
			const expressAddr = await expressProvider.getAddress()
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
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
			const sig = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount,
				creditAmount,
				fee: 0n,
				operatorFee: 0n,
				partsHash: computePartsHash(parts),
				deadline,
			})
			const creditDataRaw = buildCreditData(100_000n * 10n ** 18n, now)
			const pd = encodeProviderData(
				0n,
				1,
				0,
				affiliate,
				affiliateAmount,
				creditAmount,
				0n,
				0n,
				deadline,
				sig,
				undefined,
				undefined,
				undefined,
				creditDataRaw,
			)
			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, pd)
			const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(fixture.operator).processWithdraw(user.address, requestId, parts)

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			expect(await expressProvider.generalBadDebt()).to.equal(0n)
		})
	})

	describe("Global pause kill switch", function () {
		const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"))

		it("setPaused flips the flag and emits PausedUpdated", async function () {
			const fixture = await deployFixture()
			const { expressProvider, deployer } = fixture
			expect(await expressProvider.paused()).to.equal(false)

			await expect(expressProvider.connect(deployer).setPaused(true)).to.emit(expressProvider, "PausedUpdated").withArgs(true)
			expect(await expressProvider.paused()).to.equal(true)

			await expect(expressProvider.connect(deployer).setPaused(false)).to.emit(expressProvider, "PausedUpdated").withArgs(false)
			expect(await expressProvider.paused()).to.equal(false)
		})

		it("setPaused rejects callers without PAUSER_ROLE", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider } = fixture
			await expect(expressProvider.connect(user).setPaused(true)).to.be.revertedWithCustomError(expressProvider, "AccessDenied")
			expect(await expressProvider.paused()).to.equal(false)
		})

		it("setPaused emits PausedUpdated on every call (no idempotency check)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, deployer } = fixture

			await expect(expressProvider.connect(deployer).setPaused(false)).to.emit(expressProvider, "PausedUpdated").withArgs(false)
			expect(await expressProvider.paused()).to.equal(false)

			await expect(expressProvider.connect(deployer).setPaused(true)).to.emit(expressProvider, "PausedUpdated").withArgs(true)
			expect(await expressProvider.paused()).to.equal(true)

			await expect(expressProvider.connect(deployer).setPaused(true)).to.emit(expressProvider, "PausedUpdated").withArgs(true)
			expect(await expressProvider.paused()).to.equal(true)
		})

		it("PAUSER_ROLE can be granted to and revoked from non-admin accounts", async function () {
			const fixture = await deployFixture()
			const { expressProvider, deployer, affiliateOwner } = fixture

			await expect(expressProvider.connect(affiliateOwner).setPaused(true)).to.be.revertedWithCustomError(expressProvider, "AccessDenied")

			await expressProvider.connect(deployer).grantRole(PAUSER_ROLE, affiliateOwner.address)
			await expressProvider.connect(affiliateOwner).setPaused(true)
			expect(await expressProvider.paused()).to.equal(true)

			await expressProvider.connect(deployer).revokeRole(PAUSER_ROLE, affiliateOwner.address)
			await expect(expressProvider.connect(affiliateOwner).setPaused(false)).to.be.revertedWithCustomError(expressProvider, "AccessDenied")
			expect(await expressProvider.paused()).to.equal(true)
		})

		it("pause blocks onWithdrawRequest; user's core balance is fully restored by the revert", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, deployer, botSigner, receiver, affiliate } = fixture

			const userBalBefore = await context.viewFacet.balanceOf(user.address)
			const lockedBefore = await context.viewFacet.getWithdrawLockedBalance()

			await expressProvider.connect(deployer).setPaused(true)

			const withdrawAmount = 500n * 10n ** 18n
			const expressAddr = await expressProvider.getAddress()
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
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
			const sig = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				partsHash: computePartsHash(parts),
				deadline,
			})
			const pd = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, 0n, 0n, deadline, sig)

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, pd)).to.be.reverted

			expect(await context.viewFacet.balanceOf(user.address)).to.equal(userBalBefore)
			expect(await context.viewFacet.getWithdrawLockedBalance()).to.equal(lockedBefore)
			expect(await expressProvider.nonces(user.address)).to.equal(0n)
		})

		it("pause blocks processWithdraw, lockWithdraw, and unlockAndProcess", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, deployer, locker, unlocker, operator } = fixture

			const { parts: parts1, requestId: id1 } = await acceptWindowed(fixture)
			const { parts: parts2, requestId: id2 } = await acceptWindowed(fixture)
			await expressProvider.connect(locker).lockWithdraw(user.address, id2)

			await expressProvider.connect(deployer).setPaused(true)

			await expect(expressProvider.connect(operator).processWithdraw(user.address, id1, parts1)).to.be.revertedWithCustomError(
				expressProvider,
				"Paused",
			)
			await expect(expressProvider.connect(locker).lockWithdraw(user.address, id1)).to.be.revertedWithCustomError(expressProvider, "Paused")
			await expect(expressProvider.connect(unlocker).unlockAndProcess(user.address, id2, parts2)).to.be.revertedWithCustomError(
				expressProvider,
				"Paused",
			)

			expect((await expressProvider.getWithdrawInfo(user.address, id1)).status).to.equal(1n)
			expect((await expressProvider.getWithdrawInfo(user.address, id2)).status).to.equal(2n)
		})

		it("pause blocks accelerateWithdraw", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, deployer } = fixture
			const { parts, requestId } = await acceptStandard(fixture)

			await expressProvider.connect(deployer).setPaused(true)

			await expect(expressProvider.connect(user).accelerateWithdraw(user.address, requestId, parts, "0x", "0x")).to.be.revertedWithCustomError(
				expressProvider,
				"Paused",
			)
		})

		it("pause blocks all ControlFacet pool and fee mutations", async function () {
			const fixture = await deployFixture()
			const { expressProvider, deployer, collateral, affiliate, receiver } = fixture

			await collateral.mint(deployer.address, 100n * 10n ** 18n)
			await collateral.connect(deployer).approve(await expressProvider.getAddress(), 100n * 10n ** 18n)

			await expressProvider.connect(deployer).setPaused(true)

			await expect(expressProvider.connect(deployer).depositToGeneral(1n)).to.be.revertedWithCustomError(expressProvider, "Paused")
			await expect(expressProvider.connect(deployer).depositToAffiliate(affiliate, 1n)).to.be.revertedWithCustomError(expressProvider, "Paused")
			await expect(expressProvider.connect(deployer).withdrawFromGeneral(1n)).to.be.revertedWithCustomError(expressProvider, "Paused")
			await expect(expressProvider.connect(deployer).withdrawFromAffiliate(affiliate, 1n)).to.be.revertedWithCustomError(expressProvider, "Paused")
			await expect(expressProvider.connect(deployer).depositSponsorBalance(affiliate, 1n)).to.be.revertedWithCustomError(expressProvider, "Paused")
			await expect(expressProvider.connect(deployer).withdrawSponsorBalance(affiliate, 1n, receiver.address)).to.be.revertedWithCustomError(
				expressProvider,
				"Paused",
			)
			await expect(expressProvider.connect(deployer).claimFees(affiliate, receiver.address)).to.be.revertedWithCustomError(expressProvider, "Paused")
			await expect(expressProvider.connect(deployer).claimOperatorFees(affiliate, receiver.address)).to.be.revertedWithCustomError(
				expressProvider,
				"Paused",
			)
		})

		it("pause blocks self-service setMyCreditLineConfig", async function () {
			const fixture = await deployFixture()
			const { expressProvider, deployer, affiliateOwner } = fixture

			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliateOwner.address, 1000n * 10n ** 18n, 0)
			await expressProvider.connect(deployer).setPaused(true)

			await expect(expressProvider.connect(affiliateOwner).setMyCreditLineConfig(500n * 10n ** 18n, 0)).to.be.revertedWithCustomError(
				expressProvider,
				"Paused",
			)
		})

		it("pause allows onWithdrawCancelRequest — in-flight WINDOWED can still cancel via core", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, deployer, generalFunding, affiliateFunding, affiliate } = fixture

			const affiliateAmount = 200n * 10n ** 18n
			const { requestId } = await acceptWindowed(fixture, { affiliateAmount })

			await expressProvider.connect(deployer).setPaused(true)

			await context.withdrawFacet.connect(user).requestCancelWithdraw(requestId)

			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(5n)
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)
			expect(await expressProvider.lockedGeneralBalance()).to.equal(0n)
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateFunding)
			expect(await expressProvider.lockedAffiliateBalances(affiliate)).to.equal(0n)
		})

		it("pause allows onWithdrawSuspend — PROCESSED WINDOWED can still suspend with coverLoss", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, deployer, affiliate, affiliateFunding } = fixture

			const affiliateAmount = 200n * 10n ** 18n
			const creditAmount = 100n * 10n ** 18n
			const withdrawAmount = 1000n * 10n ** 18n
			const expressAddr = await expressProvider.getAddress()
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
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
			const sig = await signWithdrawOption(expressProvider, fixture.botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount,
				creditAmount,
				fee: 0n,
				operatorFee: 0n,
				partsHash: computePartsHash(parts),
				deadline,
			})
			const creditDataRaw = buildCreditData(100_000n * 10n ** 18n, now)
			const pd = encodeProviderData(
				0n,
				1,
				0,
				affiliate,
				affiliateAmount,
				creditAmount,
				0n,
				0n,
				deadline,
				sig,
				undefined,
				undefined,
				undefined,
				creditDataRaw,
			)
			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, pd)
			const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(fixture.operator).processWithdraw(user.address, requestId, parts)

			await expressProvider.connect(deployer).setPaused(true)

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(6n)
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateFunding - affiliateAmount - creditAmount)
			expect(await expressProvider.creditLineActiveDebt(affiliate)).to.equal(0n)
			expect(await expressProvider.generalBadDebt()).to.equal(withdrawAmount - affiliateAmount - creditAmount)
		})

		it("pause allows onWithdrawComplete — STANDARD can still finalize from core", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, deployer } = fixture

			const { requestId } = await acceptStandard(fixture)
			await ethers.provider.send("evm_increaseTime", [12 * 3600])
			await ethers.provider.send("evm_mine", [])

			await expressProvider.connect(deployer).setPaused(true)

			await context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)
			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(4n)
			expect(info.finalizedAt).to.be.greaterThan(0n)
		})

		it("pause allows onWithdrawComplete for PROCESSED WINDOWED — pools replenished and debt settled", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, deployer, operator, affiliate, generalFunding, affiliateFunding } = fixture

			const affiliateAmount = 200n * 10n ** 18n
			const { parts, requestId } = await acceptWindowed(fixture, { affiliateAmount })

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)

			await expressProvider.connect(deployer).setPaused(true)

			await ethers.provider.send("evm_increaseTime", [12 * 3600])
			await ethers.provider.send("evm_mine", [])
			await context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)

			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(4n)
			expect(await expressProvider.generalBalance()).to.equal(generalFunding)
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateFunding)
		})

		it("unpausing resumes normal operations end-to-end", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, deployer, operator, receiver, collateral } = fixture

			const { parts, requestId, withdrawAmount } = await acceptWindowed(fixture)
			const receiverBefore = await collateral.balanceOf(receiver.address)

			await expressProvider.connect(deployer).setPaused(true)
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expect(expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)).to.be.revertedWithCustomError(
				expressProvider,
				"Paused",
			)

			await expressProvider.connect(deployer).setPaused(false)
			expect(await expressProvider.paused()).to.equal(false)

			await expressProvider.connect(operator).processWithdraw(user.address, requestId, parts)
			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(3n)
			expect(await collateral.balanceOf(receiver.address)).to.equal(receiverBefore + withdrawAmount)
		})

		it("owner recovery tools (rescueTokens, clearRequestDebt) remain available under pause", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, context, deployer, collateral, affiliate, botSigner, receiver } = fixture

			const creditAmount = 400n * 10n ** 18n
			const withdrawAmount = 1500n * 10n ** 18n
			const expressAddr = await expressProvider.getAddress()
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
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
			const sig = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount,
				fee: 0n,
				operatorFee: 0n,
				partsHash: computePartsHash(parts),
				deadline,
			})
			const creditDataRaw = buildCreditData(100_000n * 10n ** 18n, now)
			const pd = encodeProviderData(0n, 1, 0, affiliate, 0n, creditAmount, 0n, 0n, deadline, sig, undefined, undefined, undefined, creditDataRaw)
			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, pd)
			const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)

			await expressProvider.connect(deployer).setPaused(true)

			const stuck = 555n * 10n ** 18n
			await collateral.mint(deployer.address, stuck)
			await collateral.connect(deployer).transfer(expressAddr, stuck)
			const rescueBalBefore = await collateral.balanceOf(receiver.address)
			await expressProvider.connect(deployer).rescueTokens(await collateral.getAddress(), receiver.address, stuck)
			expect(await collateral.balanceOf(receiver.address)).to.equal(rescueBalBefore + stuck)

			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(creditAmount)
			await expressProvider.connect(deployer).clearRequestDebt(affiliate, user.address, requestId)
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(0n)
		})

		it("pause does not affect view functions", async function () {
			const fixture = await deployFixture()
			const { expressProvider, deployer, affiliate } = fixture

			await expressProvider.connect(deployer).setPaused(true)

			expect(await expressProvider.generalBalance()).to.be.a("bigint")
			expect(await expressProvider.lockedGeneralBalance()).to.be.a("bigint")
			expect(await expressProvider.affiliateBalances(affiliate)).to.be.a("bigint")
			expect(await expressProvider.paused()).to.equal(true)
		})
	})

	describe("Owner clearRequestDebt", function () {
		it("clears reserved debt and decrements reservedDebt aggregate", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, affiliate, deployer } = fixture

			const creditAmount = 800n * 10n ** 18n
			const { requestId } = await (async () => {
				const { botSigner, receiver, context } = fixture
				const expressAddr = await expressProvider.getAddress()
				const now = (await ethers.provider.getBlock("latest"))!.timestamp
				const deadline = now + 3600
				const parts = [
					{
						id: 0n,
						amount: 2000n * 10n ** 18n,
						chainId: 31337n,
						receiver: receiver.address,
						virtualProvider: ethers.ZeroAddress,
						expressProvider: expressAddr,
					},
				]
				const sig = await signWithdrawOption(expressProvider, botSigner, {
					user: user.address,
					nonce: 0n,
					optionType: 1,
					availableAt: 0,
					affiliate,
					affiliateAmount: 0n,
					creditAmount,
					fee: 0n,
					operatorFee: 0n,
					partsHash: computePartsHash(parts),
					deadline,
				})
				const creditDataRaw = buildCreditData(100_000n * 10n ** 18n, now)
				const pd = encodeProviderData(0n, 1, 0, affiliate, 0n, creditAmount, 0n, 0n, deadline, sig, undefined, undefined, undefined, creditDataRaw)
				await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, pd)
				return { requestId: await context.viewFacet.getLastWithdrawRequestId(user.address) }
			})()

			expect(await expressProvider.creditLineRequestDebt(affiliate, user.address, requestId)).to.equal(creditAmount)
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(creditAmount)

			await expressProvider.connect(deployer).clearRequestDebt(affiliate, user.address, requestId)

			expect(await expressProvider.creditLineRequestDebt(affiliate, user.address, requestId)).to.equal(0n)
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(0n)
			expect(await expressProvider.creditLineRequestActivated(affiliate, user.address, requestId)).to.equal(false)
		})

		it("clears activated debt and decrements activeDebt aggregate", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, affiliate, deployer, context } = fixture

			const creditAmount = 500n * 10n ** 18n
			const { requestId } = await (async () => {
				const { botSigner, receiver } = fixture
				const expressAddr = await expressProvider.getAddress()
				const now = (await ethers.provider.getBlock("latest"))!.timestamp
				const deadline = now + 3600
				const parts = [
					{
						id: 0n,
						amount: 1500n * 10n ** 18n,
						chainId: 31337n,
						receiver: receiver.address,
						virtualProvider: ethers.ZeroAddress,
						expressProvider: expressAddr,
					},
				]
				const sig = await signWithdrawOption(expressProvider, botSigner, {
					user: user.address,
					nonce: 0n,
					optionType: 1,
					availableAt: 0,
					affiliate,
					affiliateAmount: 0n,
					creditAmount,
					fee: 0n,
					operatorFee: 0n,
					partsHash: computePartsHash(parts),
					deadline,
				})
				const creditDataRaw = buildCreditData(100_000n * 10n ** 18n, now)
				const pd = encodeProviderData(0n, 1, 0, affiliate, 0n, creditAmount, 0n, 0n, deadline, sig, undefined, undefined, undefined, creditDataRaw)
				await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, pd)
				const id = await context.viewFacet.getLastWithdrawRequestId(user.address)
				await ethers.provider.send("evm_increaseTime", [21])
				await ethers.provider.send("evm_mine", [])
				await expressProvider.connect(fixture.operator).processWithdraw(user.address, id, parts)
				return { requestId: id }
			})()

			expect(await expressProvider.creditLineActiveDebt(affiliate)).to.equal(creditAmount)
			expect(await expressProvider.creditLineRequestActivated(affiliate, user.address, requestId)).to.equal(true)

			await expressProvider.connect(deployer).clearRequestDebt(affiliate, user.address, requestId)

			expect(await expressProvider.creditLineActiveDebt(affiliate)).to.equal(0n)
			expect(await expressProvider.creditLineRequestDebt(affiliate, user.address, requestId)).to.equal(0n)
		})

		it("is a no-op when no debt exists for the (affiliate, user, requestId) key", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, affiliate, deployer } = fixture
			await expressProvider.connect(deployer).clearRequestDebt(affiliate, user.address, 999n)
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(0n)
			expect(await expressProvider.creditLineActiveDebt(affiliate)).to.equal(0n)
		})

		it("rejects non-owner callers", async function () {
			const fixture = await deployFixture()
			const { user, expressProvider, affiliate } = fixture
			await expect(expressProvider.connect(user).clearRequestDebt(affiliate, user.address, 1n)).to.be.reverted
		})
	})

	describe("Credit bad debt accounting", function () {
		async function accrueBadDebt(fixture: any, opts: { affiliateAmount: bigint; creditAmount: bigint; withdrawAmount: bigint }): Promise<bigint> {
			const { user, botSigner, receiver, expressProvider, context, affiliate } = fixture
			const expressAddr = await expressProvider.getAddress()
			const nonce = await expressProvider.nonces(user.address)
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600

			const parts = [
				{
					id: 0n,
					amount: opts.withdrawAmount,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			const sig = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount: opts.affiliateAmount,
				creditAmount: opts.creditAmount,
				fee: 0n,
				operatorFee: 0n,
				partsHash: computePartsHash(parts),
				deadline,
			})
			const creditDataRaw = buildCreditData(100_000n * 10n ** 18n, now)
			const pd = encodeProviderData(
				nonce,
				1,
				0,
				affiliate,
				opts.affiliateAmount,
				opts.creditAmount,
				0n,
				0n,
				deadline,
				sig,
				undefined,
				undefined,
				undefined,
				creditDataRaw,
			)
			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, pd)
			const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(fixture.operator).processWithdraw(user.address, requestId, parts)

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			await context.pauseControlFacet.connect(context.signers.admin).unsuspendedAddress(user.address)

			return await expressProvider.creditLineBadDebt(affiliate)
		}

		// Build credit-backed WINDOWED provider data without submitting it yet.
		async function buildCreditWithdraw(fixture: any, opts: { creditAmount: bigint; withdrawAmount: bigint; nonceOverride?: bigint }) {
			const { user, botSigner, receiver, expressProvider, affiliate } = fixture
			const expressAddr = await expressProvider.getAddress()
			const nonce = opts.nonceOverride ?? (await expressProvider.nonces(user.address))
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600

			const parts = [
				{
					id: 0n,
					amount: opts.withdrawAmount,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			const sig = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: opts.creditAmount,
				fee: 0n,
				operatorFee: 0n,
				partsHash: computePartsHash(parts),
				deadline,
			})
			const creditDataRaw = buildCreditData(100_000n * 10n ** 18n, now)
			const pd = encodeProviderData(
				nonce,
				1,
				0,
				affiliate,
				0n,
				opts.creditAmount,
				0n,
				0n,
				deadline,
				sig,
				undefined,
				undefined,
				undefined,
				creditDataRaw,
			)
			return { parts, providerData: pd }
		}

		it("badDebt counts toward absolute cap; new reservation past cap - badDebt reverts", async function () {
			const fixture = await deployFixture()
			const { expressProvider, deployer, affiliate, user, context } = fixture

			const cap = 1500n * 10n ** 18n
			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliate, cap, 0)

			// affiliate pool = 5000 (from fixture). Drain so that an 800-credit suspend leaves a deficit.
			// withdrawAmount = 7000 → expressAmount = 7000. affiliateAmount = 4500, creditAmount = 1500.
			// On accept: pool locks 4500 → unlocked = 500. On process: pool decreases by 4500 → balance = 500.
			// On post-payout suspend: coverLoss tries to cover 1500 from unlocked = 500. badDebt = 1000.
			const badDebt = await accrueBadDebt(fixture, {
				affiliateAmount: 4500n * 10n ** 18n,
				creditAmount: cap, // exactly at cap; activeDebt = cap then suspends → badDebt accrues
				withdrawAmount: 7000n * 10n ** 18n,
			})
			expect(badDebt).to.be.gt(0n)
			expect(badDebt).to.be.lte(cap)

			// remaining capacity is cap - badDebt; one wei over must revert
			const remaining = cap - badDebt
			const tooMuch = remaining + 1n
			const overOffer = await buildCreditWithdraw(fixture, { creditAmount: tooMuch, withdrawAmount: 8000n * 10n ** 18n })
			await expect(
				context.withdrawFacet.connect(user).initiateWithdraw(overOffer.parts, false, overOffer.providerData),
			).to.be.revertedWithCustomError(expressProvider, "DebtExceedsAbsoluteCap")

			// At the boundary it must succeed (only matters if remaining > 0)
			if (remaining > 0n) {
				const exactOffer = await buildCreditWithdraw(fixture, { creditAmount: remaining, withdrawAmount: 8000n * 10n ** 18n })
				await context.withdrawFacet.connect(user).initiateWithdraw(exactOffer.parts, false, exactOffer.providerData)
				expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(remaining)
			}
		})

		it("badDebt counts toward bps cap as well", async function () {
			const fixture = await deployFixture()
			const { expressProvider, deployer, affiliate, user, context } = fixture

			// Accrue badDebt first (still uncapped at this point)
			const badDebt = await accrueBadDebt(fixture, {
				affiliateAmount: 4500n * 10n ** 18n,
				creditAmount: 1500n * 10n ** 18n,
				withdrawAmount: 7000n * 10n ** 18n,
			})
			expect(badDebt).to.be.gt(0n)

			const eligibleBase = 100_000n * 10n ** 18n
			const bps = (badDebt * 10000n) / eligibleBase
			expect(bps).to.be.gt(0n)
			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliate, 0, bps)

			const overOffer = await buildCreditWithdraw(fixture, { creditAmount: 1n, withdrawAmount: 8000n * 10n ** 18n })
			await expect(
				context.withdrawFacet.connect(user).initiateWithdraw(overOffer.parts, false, overOffer.providerData),
			).to.be.revertedWithCustomError(expressProvider, "DebtExceedsPercentCap")
		})

		it("repayCreditBadDebt restores capacity and credits the affiliate pool", async function () {
			const fixture = await deployFixture()
			const { expressProvider, deployer, affiliate, collateral, context, user } = fixture

			const cap = 1500n * 10n ** 18n
			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliate, cap, 0)

			const badDebt = await accrueBadDebt(fixture, {
				affiliateAmount: 4500n * 10n ** 18n,
				creditAmount: cap,
				withdrawAmount: 7000n * 10n ** 18n,
			})
			expect(badDebt).to.be.gt(0n)

			const expressAddr = await expressProvider.getAddress()
			const poolBefore = await expressProvider.affiliateBalances(affiliate)
			const diamondBalBefore = await collateral.balanceOf(expressAddr)

			// Fund the deployer to act as the repayer
			await collateral.mint(deployer.address, badDebt)
			await collateral.connect(deployer).approve(expressAddr, badDebt)

			await expect(expressProvider.connect(deployer).repayCreditBadDebt(affiliate, badDebt))
				.to.emit(expressProvider, "CreditBadDebtRepaid")
				.withArgs(affiliate, deployer.address, badDebt)

			// Bad debt cleared; pool credited; tokens received
			expect(await expressProvider.creditLineBadDebt(affiliate)).to.equal(0n)
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(poolBefore + badDebt)
			expect(await collateral.balanceOf(expressAddr)).to.equal(diamondBalBefore + badDebt)

			// Capacity fully restored — a fresh reservation up to `cap` succeeds
			const fullOffer = await buildCreditWithdraw(fixture, { creditAmount: cap, withdrawAmount: 8000n * 10n ** 18n })
			await context.withdrawFacet.connect(user).initiateWithdraw(fullOffer.parts, false, fullOffer.providerData)
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(cap)
		})

		it("partial repayment restores partial capacity", async function () {
			const fixture = await deployFixture()
			const { expressProvider, deployer, affiliate, collateral, context, user } = fixture

			const cap = 2000n * 10n ** 18n
			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliate, cap, 0)

			const badDebt = await accrueBadDebt(fixture, {
				affiliateAmount: 4500n * 10n ** 18n,
				creditAmount: cap,
				withdrawAmount: 7000n * 10n ** 18n,
			})
			expect(badDebt).to.be.gt(0n)

			const half = badDebt / 2n
			expect(half).to.be.gt(0n)

			const expressAddr = await expressProvider.getAddress()
			await collateral.mint(deployer.address, half)
			await collateral.connect(deployer).approve(expressAddr, half)
			await expressProvider.connect(deployer).repayCreditBadDebt(affiliate, half)

			expect(await expressProvider.creditLineBadDebt(affiliate)).to.equal(badDebt - half)

			// Available capacity = cap - remaining badDebt
			const remaining = cap - (badDebt - half)
			const exactOffer = await buildCreditWithdraw(fixture, { creditAmount: remaining, withdrawAmount: 8000n * 10n ** 18n })
			await context.withdrawFacet.connect(user).initiateWithdraw(exactOffer.parts, false, exactOffer.providerData)
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(remaining)
		})

		it("cap check sums reservedDebt + badDebt + new reservation correctly", async function () {
			const fixture = await deployFixture()
			const { expressProvider, deployer, affiliate, context, user } = fixture

			const cap = 2000n * 10n ** 18n
			await expressProvider.connect(deployer).setCreditLineProtocolConfig(affiliate, cap, 0)

			const badDebt = await accrueBadDebt(fixture, {
				affiliateAmount: 4500n * 10n ** 18n,
				creditAmount: cap,
				withdrawAmount: 7000n * 10n ** 18n,
			})
			expect(badDebt).to.be.gt(0n)

			// Reserve up to remaining capacity. withdrawAmount == creditAmount so generalAmount = 0
			// and the general pool isn't locked by this fresh request.
			const remaining = cap - badDebt
			expect(remaining).to.be.gt(0n)
			const fillOffer = await buildCreditWithdraw(fixture, { creditAmount: remaining, withdrawAmount: remaining })
			await context.withdrawFacet.connect(user).initiateWithdraw(fillOffer.parts, false, fillOffer.providerData)
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(remaining)

			// reservedDebt = remaining, badDebt = badDebt, cap full. A 1 wei credit reservation
			// must revert because reserved + badDebt + 1 > cap.
			const overOffer = await buildCreditWithdraw(fixture, { creditAmount: 1n, withdrawAmount: 1n })
			await expect(
				context.withdrawFacet.connect(user).initiateWithdraw(overOffer.parts, false, overOffer.providerData),
			).to.be.revertedWithCustomError(expressProvider, "DebtExceedsAbsoluteCap")
		})

		it("repayCreditBadDebt rejects zero or > badDebt amounts", async function () {
			const fixture = await deployFixture()
			const { expressProvider, deployer, affiliate } = fixture

			// With no badDebt yet, even repaying 1 wei must revert
			await expect(expressProvider.connect(deployer).repayCreditBadDebt(affiliate, 0n)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidRepayAmount",
			)
			await expect(expressProvider.connect(deployer).repayCreditBadDebt(affiliate, 1n)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidRepayAmount",
			)

			const badDebt = await accrueBadDebt(fixture, {
				affiliateAmount: 4500n * 10n ** 18n,
				creditAmount: 1500n * 10n ** 18n,
				withdrawAmount: 7000n * 10n ** 18n,
			})

			await expect(expressProvider.connect(deployer).repayCreditBadDebt(affiliate, 0n)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidRepayAmount",
			)
			await expect(expressProvider.connect(deployer).repayCreditBadDebt(affiliate, badDebt + 1n)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidRepayAmount",
			)
		})

		it("repayCreditBadDebt is permissionless (any account can pay)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, deployer, affiliate, collateral, user } = fixture

			const badDebt = await accrueBadDebt(fixture, {
				affiliateAmount: 4500n * 10n ** 18n,
				creditAmount: 1500n * 10n ** 18n,
				withdrawAmount: 7000n * 10n ** 18n,
			})

			const allSigners = await ethers.getSigners()
			const stranger = allSigners[19]
			expect(await expressProvider.hasRole(ethers.keccak256(ethers.toUtf8Bytes("WITHDRAWER_ROLE")), stranger.address)).to.equal(false)

			await collateral.mint(stranger.address, badDebt)
			await collateral.connect(stranger).approve(await expressProvider.getAddress(), badDebt)

			await expect(expressProvider.connect(stranger).repayCreditBadDebt(affiliate, badDebt))
				.to.emit(expressProvider, "CreditBadDebtRepaid")
				.withArgs(affiliate, stranger.address, badDebt)
			expect(await expressProvider.creditLineBadDebt(affiliate)).to.equal(0n)
		})

		it("repayCreditBadDebt is blocked while paused", async function () {
			const fixture = await deployFixture()
			const { expressProvider, deployer, affiliate } = fixture

			await accrueBadDebt(fixture, {
				affiliateAmount: 4500n * 10n ** 18n,
				creditAmount: 1500n * 10n ** 18n,
				withdrawAmount: 7000n * 10n ** 18n,
			})

			await expressProvider.connect(deployer).setPaused(true)

			await expect(expressProvider.connect(deployer).repayCreditBadDebt(affiliate, 1n)).to.be.revertedWithCustomError(expressProvider, "Paused")
		})
	})

	describe("Per-request fee escrow", function () {
		async function acceptWindowedWithFees(fixture: any, opts: { fee: bigint; operatorFee: bigint; sponsorAmount?: bigint }) {
			const { user, botSigner, receiver, expressProvider, context, affiliate, deployer, collateral } = fixture

			const feeRate = (opts.fee * 10000n) / (500n * 10n ** 18n)
			await expressProvider.connect(deployer).setAffiliateConfig(affiliate, feeRate, opts.operatorFee)

			if (opts.sponsorAmount && opts.sponsorAmount > 0n) {
				await collateral.mint(deployer.address, opts.sponsorAmount)
				await collateral.connect(deployer).approve(await expressProvider.getAddress(), opts.sponsorAmount)
				await expressProvider.connect(deployer).depositSponsorBalance(affiliate, opts.sponsorAmount)
			}

			const withdrawAmount = 500n * 10n ** 18n
			const expressAddr = await expressProvider.getAddress()
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
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
			const nonce = await expressProvider.nonces(user.address)
			const sig = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: opts.fee,
				operatorFee: opts.operatorFee,
				partsHash,
				deadline,
			})
			const pd = encodeProviderData(nonce, 1, 0, affiliate, 0n, 0n, opts.fee, opts.operatorFee, deadline, sig)
			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, pd)
			const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(fixture.operator).processWithdraw(user.address, requestId, parts)

			return { parts, requestId, withdrawAmount }
		}

		it("WINDOWED process puts fees in pending; finalize promotes to claimable", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, affiliate, context } = fixture

			const fee = 5n * 10n ** 18n
			const operatorFee = 1n * 10n ** 18n
			const { requestId } = await acceptWindowedWithFees(fixture, { fee, operatorFee })

			expect(await expressProvider.pendingFees(user.address, requestId)).to.equal(fee)
			expect(await expressProvider.pendingOperatorFees(user.address, requestId)).to.equal(operatorFee)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(0n)
			expect(await expressProvider.collectedOperatorFees(affiliate)).to.equal(0n)

			await ethers.provider.send("evm_increaseTime", [12 * 3600])
			await ethers.provider.send("evm_mine", [])
			await context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)

			expect(await expressProvider.pendingFees(user.address, requestId)).to.equal(0n)
			expect(await expressProvider.pendingOperatorFees(user.address, requestId)).to.equal(0n)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee)
			expect(await expressProvider.collectedOperatorFees(affiliate)).to.equal(operatorFee)
		})

		it("claimFees reverts on a fully-pending affiliate (escrow not yet promoted)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, deployer, affiliate, user } = fixture

			const fee = 5n * 10n ** 18n
			const { requestId } = await acceptWindowedWithFees(fixture, { fee, operatorFee: 0n })

			expect(await expressProvider.pendingFees(user.address, requestId)).to.equal(fee)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(0n)

			await expect(expressProvider.connect(deployer).claimFees(affiliate, deployer.address)).to.be.revertedWithCustomError(
				expressProvider,
				"NoFeesToClaim",
			)
		})

		it("post-payout suspend with no sponsor: leftover pending promotes to claimable", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, affiliate, context } = fixture

			const fee = 5n * 10n ** 18n
			const operatorFee = 1n * 10n ** 18n
			const { requestId } = await acceptWindowedWithFees(fixture, { fee, operatorFee })

			expect(await expressProvider.pendingFees(user.address, requestId)).to.equal(fee)
			expect(await expressProvider.pendingOperatorFees(user.address, requestId)).to.equal(operatorFee)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(0n)
			expect(await expressProvider.collectedOperatorFees(affiliate)).to.equal(0n)

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee)
			expect(await expressProvider.collectedOperatorFees(affiliate)).to.equal(operatorFee)
			expect(await expressProvider.pendingFees(user.address, requestId)).to.equal(0n)
			expect(await expressProvider.pendingOperatorFees(user.address, requestId)).to.equal(0n)
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(0n)
		})

		it("post-payout suspend with partial sponsor: sponsor refunded in full, leftover promoted", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, affiliate, context, deployer, collateral } = fixture

			const fee = 5n * 10n ** 18n
			const operatorFee = 5n * 10n ** 18n
			const totalFee = fee + operatorFee
			const sponsorAmount = 100n * 10n ** 18n
			await expressProvider.connect(deployer).setSponsorConfig(affiliate, 4n * 10n ** 18n, 0)

			await collateral.mint(deployer.address, sponsorAmount)
			await collateral.connect(deployer).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(deployer).depositSponsorBalance(affiliate, sponsorAmount)

			const { requestId } = await acceptWindowedWithFees(fixture, { fee, operatorFee })

			const sponsorCoverage = (await expressProvider.getWithdrawInfo(user.address, requestId)).sponsorCoverage
			expect(sponsorCoverage).to.equal(4n * 10n ** 18n)

			expect(await expressProvider.pendingFees(user.address, requestId)).to.equal(fee)
			expect(await expressProvider.pendingOperatorFees(user.address, requestId)).to.equal(operatorFee)
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount - sponsorCoverage)

			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			// Drain order is pendingFees first, then pendingOperatorFees:
			//   pf=5 - takeAff=4 = 1  → collectedFees     += 1
			//   pof=5 - takeOp=0 = 5  → collectedOperatorFees += 5
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount)
			expect(await expressProvider.pendingFees(user.address, requestId)).to.equal(0n)
			expect(await expressProvider.pendingOperatorFees(user.address, requestId)).to.equal(0n)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee - sponsorCoverage)
			expect(await expressProvider.collectedOperatorFees(affiliate)).to.equal(operatorFee)
			expect(totalFee - sponsorCoverage).to.equal(
				(await expressProvider.collectedFees(affiliate)) + (await expressProvider.collectedOperatorFees(affiliate)),
			)
		})

		it("STANDARD process credits collectedFees directly (skips escrow)", async function () {
			const fixture = await deployFixture()
			const { user, botSigner, receiver, expressProvider, context, affiliate, deployer } = fixture

			const fee = 5n * 10n ** 18n
			const feeRate = (fee * 10000n) / (500n * 10n ** 18n)
			await expressProvider.connect(deployer).setAffiliateConfig(affiliate, feeRate, 0)

			await triggerRecentDeallocate(fixture)

			const withdrawAmount = 500n * 10n ** 18n
			const expressAddr = await expressProvider.getAddress()
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 24 * 3600
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
			const nonce = await expressProvider.nonces(user.address)
			const sig = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce,
				optionType: 2,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee,
				operatorFee: 0n,
				partsHash,
				deadline,
			})
			const pd = encodeProviderData(nonce, 2, 0, affiliate, 0n, 0n, fee, 0n, deadline, sig)
			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, pd)
			const requestId = await context.viewFacet.getLastWithdrawRequestId(user.address)

			await finalizeStandard(fixture, requestId, withdrawAmount)
			await expressProvider.connect(fixture.operator).processWithdraw(user.address, requestId, parts)

			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee)
			expect(await expressProvider.pendingFees(user.address, requestId)).to.equal(0n)
		})
	})
}
