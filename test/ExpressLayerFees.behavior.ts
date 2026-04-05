import { expect } from "chai"

import { deployExpressProvider } from "../tasks/deploy/expressWithdrawLayerDiamond.js"
import { initializeFixture } from "./Initialize.fixture.js"
import connection, { ethers, hre } from "./helpers/hardhat-connection.js"
import { time } from "./helpers/network-helpers.js"

const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"))
const SIGNER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("SIGNER_ROLE"))
const LOCKER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LOCKER_ROLE"))
const UNLOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UNLOCK_ROLE"))

export function shouldBehaveLikeExpressLayerFees(): void {
	async function deployFixture() {
		const context = await initializeFixture()

		const allSigners = await ethers.getSigners()
		const deployer = context.signers.admin
		const botSigner = allSigners[13]
		const operator = allSigners[14]
		const receiver = allSigners[15]
		const affiliateOwner = allSigners[16]
		const sponsor = allSigners[17]
		const user = context.signers.user
		const user2 = context.signers.user2
		const locker = allSigners[18]
		const unlocker = allSigners[19]
		const receiver2 = context.signers.others[0]

		const collateral = context.collateral

		// Deploy ExpressProvider diamond
		const expressProvider = await deployExpressProvider(hre, connection, {
			admin: deployer.address,
			symmio: context.diamond,
			collateral: await collateral.getAddress(),
		})

		// Register ExpressProvider on real Symmio
		await context.controlFacet.connect(deployer).registerExpressProvider(await expressProvider.getAddress())

		// Configure real Symmio withdraw settings
		await context.controlFacet.connect(deployer).setMaxWithdrawParts(50)
		await context.controlFacet.connect(deployer).setWithdrawCooldownPeriod(43200)

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

		// Set up user balance in real Symmio
		const userBalance = 100_000n * 10n ** 18n
		await collateral.mint(user.address, userBalance)
		await collateral.connect(user).approve(context.diamond, ethers.MaxUint256)
		await context.accountFacet.connect(user).deposit(userBalance)

		// Set up user2 balance in real Symmio
		const user2Balance = 100_000n * 10n ** 18n
		await collateral.mint(user2.address, user2Balance)
		await collateral.connect(user2).approve(context.diamond, ethers.MaxUint256)
		await context.accountFacet.connect(user2).deposit(user2Balance)

		// Fund general pool with 10,000 tokens (18 decimals)
		const generalFunding = 10_000n * 10n ** 18n
		await collateral.mint(deployer.address, generalFunding)
		await collateral.connect(deployer).approve(await expressProvider.getAddress(), generalFunding)
		await expressProvider.depositToGeneral(generalFunding)

		// Fund affiliate pool with 5,000 tokens (18 decimals)
		const affiliateFunding = 5_000n * 10n ** 18n
		await collateral.mint(deployer.address, affiliateFunding)
		await collateral.connect(deployer).approve(await expressProvider.getAddress(), affiliateFunding)
		await expressProvider.depositToAffiliate(affiliate, affiliateFunding)

		return {
			deployer,
			botSigner,
			operator,
			user,
			receiver,
			affiliateOwner,
			affiliate,
			sponsor,
			user2,
			receiver2,
			locker,
			unlocker,
			collateral,
			context,
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
	): string {
		const muf = maxUserFee ?? fee + operatorFee
		const offerData = ethers.AbiCoder.defaultAbiCoder().encode(
			["uint256", "uint8", "uint256", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "bytes"],
			[nonce, optionType, availableAt, affiliate, affiliateAmount, creditAmount, fee, operatorFee, muf, deadline, signature],
		)
		const validatorData = ethers.AbiCoder.defaultAbiCoder().encode(
			["bytes[]", "uint256[]", "uint256"],
			[validatorSignatures ?? [], validatorTimestamps ?? [], 0],
		)
		return ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "bytes", "bytes"], [offerData, validatorData, creditDataRaw ?? "0x"])
	}

	// Helper: full withdrawal cycle (initiate, advance, process)
	async function doWithdraw(opts: {
		expressProvider: any
		botSigner: any
		operator: any
		user: any
		receiver: any
		context: any
		affiliate: string
		affiliateAmount: bigint
		withdrawAmount: bigint
		fee: bigint
		operatorFee: bigint
		nonce?: bigint
		maxUserFee?: bigint
		creditAmount?: bigint
		expressAddr?: string
		skipProcess?: boolean
	}) {
		const {
			expressProvider,
			botSigner,
			operator,
			user,
			receiver,
			context,
			affiliate,
			affiliateAmount,
			withdrawAmount,
			fee,
			operatorFee,
			skipProcess,
		} = opts
		const nonce = opts.nonce ?? 0n
		const expressAddr = opts.expressAddr ?? (await expressProvider.getAddress())
		const creditAmount = opts.creditAmount ?? 0n

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
			nonce,
			optionType: 1,
			availableAt: 0,
			affiliate,
			affiliateAmount,
			creditAmount,
			fee,
			operatorFee,
			maxUserFee: opts.maxUserFee,
			partsHash,
			deadline,
		})

		const providerData = encodeProviderData(
			nonce,
			1,
			0,
			affiliate,
			affiliateAmount,
			creditAmount,
			fee,
			operatorFee,
			deadline,
			signature,
			opts.maxUserFee,
		)

		await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

		if (!skipProcess) {
			// Advance time past security window
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])

			// Process withdrawal as operator
			await expressProvider.connect(operator).processWithdraw(user.address, nonce + 1n, parts)
		}

		return { parts, partsHash, deadline, signature, providerData, requestId: nonce + 1n }
	}

	// Helper: initiate but do not process (for cancel/suspend tests)
	async function initiateWithdraw(opts: {
		expressProvider: any
		botSigner: any
		user: any
		receiver: any
		context: any
		affiliate: string
		affiliateAmount: bigint
		withdrawAmount: bigint
		fee: bigint
		operatorFee: bigint
		nonce?: bigint
		maxUserFee?: bigint
		creditAmount?: bigint
		parts?: any[]
	}) {
		const { expressProvider, botSigner, user, receiver, context, affiliate, affiliateAmount, withdrawAmount, fee, operatorFee } = opts
		const nonce = opts.nonce ?? 0n
		const expressAddr = await expressProvider.getAddress()
		const creditAmount = opts.creditAmount ?? 0n

		const parts = opts.parts ?? [
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
			nonce,
			optionType: 1,
			availableAt: 0,
			affiliate,
			affiliateAmount,
			creditAmount,
			fee,
			operatorFee,
			maxUserFee: opts.maxUserFee,
			partsHash,
			deadline,
		})

		const providerData = encodeProviderData(
			nonce,
			1,
			0,
			affiliate,
			affiliateAmount,
			creditAmount,
			fee,
			operatorFee,
			deadline,
			signature,
			opts.maxUserFee,
		)

		await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

		return { parts, partsHash, requestId: nonce + 1n }
	}

	// ═══════════════════════════════════════════════════════════════════
	//                     AFFILIATE FEE CONFIG
	// ═══════════════════════════════════════════════════════════════════

	describe("Affiliate Fee Config", function () {
		it("should set affiliate config (feeRate = 50 bps)", async function () {
			const { deployer, expressProvider, affiliate } = await deployFixture()

			await expressProvider.setAffiliateConfig(affiliate, 50, 0)
			const [feeRate] = await expressProvider.affiliateConfigs(affiliate)
			expect(feeRate).to.equal(50n)
		})

		it("should reject feeRate > 10000 (FeeRateExceeds100Percent)", async function () {
			const { expressProvider, affiliate } = await deployFixture()

			await expect(expressProvider.setAffiliateConfig(affiliate, 10001, 0)).to.be.revertedWithCustomError(expressProvider, "FeeRateExceeds100Percent")
		})

		it("should set feeRate = 10000 (100% boundary, should succeed)", async function () {
			const { expressProvider, affiliate } = await deployFixture()

			await expressProvider.setAffiliateConfig(affiliate, 10000, 0)
			const [feeRate] = await expressProvider.affiliateConfigs(affiliate)
			expect(feeRate).to.equal(10000n)
		})

		it("should set feeRate = 0", async function () {
			const { expressProvider, affiliate } = await deployFixture()

			// First set to non-zero
			await expressProvider.setAffiliateConfig(affiliate, 100, 0)
			// Then reset to 0
			await expressProvider.setAffiliateConfig(affiliate, 0, 0)
			const [feeRate] = await expressProvider.affiliateConfigs(affiliate)
			expect(feeRate).to.equal(0n)
		})

		it("should reject non-admin setting config", async function () {
			const { expressProvider, affiliate, user } = await deployFixture()

			await expect(expressProvider.connect(user).setAffiliateConfig(affiliate, 50, 0)).to.be.revert(ethers)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                  ON-CHAIN FEE VERIFICATION
	// ═══════════════════════════════════════════════════════════════════

	describe("On-Chain Fee Verification", function () {
		it("should revert with FeeMismatch when bot fee differs from on-chain config", async function () {
			const { botSigner, user, receiver, expressProvider, context, affiliate } = await deployFixture()

			const withdrawAmount = 1000n * 10n ** 18n
			const wrongFee = 30n * 10n ** 18n // bot says 30

			// feeRate = 200 (2%) => expected fee = 1000 * 200 / 10000 = 20, not 30
			await expressProvider.setAffiliateConfig(affiliate, 200, 0)

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
				fee: wrongFee,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const providerData = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, wrongFee, 0n, deadline, signature)

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"FeeMismatch",
			)
		})

		it("should revert with OperatorFeeMismatch when bot operatorFee differs from config", async function () {
			const { botSigner, user, receiver, expressProvider, context, affiliate } = await deployFixture()

			const withdrawAmount = 1000n * 10n ** 18n
			const fee = 20n * 10n ** 18n
			const wrongOpFee = 2n * 10n ** 18n // bot says 2
			const configOpFee = 1n * 10n ** 18n // config says 1

			// feeRate = 200 (2%) => expected fee = 1000 * 200 / 10000 = 20 (matches)
			await expressProvider.setAffiliateConfig(affiliate, 200, configOpFee)

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
				fee,
				operatorFee: wrongOpFee,
				partsHash,
				deadline,
			})

			const providerData = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, fee, wrongOpFee, deadline, signature)

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"OperatorFeeMismatch",
			)
		})

		it("should accept withdrawal when fee matches on-chain config exactly", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral } = await deployFixture()

			const withdrawAmount = 1000n * 10n ** 18n
			const fee = 20n * 10n ** 18n

			// feeRate = 200 (2%) => expected fee = 1000 * 200 / 10000 = 20 (exact match)
			await expressProvider.setAffiliateConfig(affiliate, 200, 0)

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount,
				fee,
				operatorFee: 0n,
			})

			// Receiver gets withdrawAmount - fee
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount - fee)
			// Fee collected
			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                    FEE DEDUCTION - INSTANT
	// ═══════════════════════════════════════════════════════════════════

	describe("Fee Deduction - INSTANT", function () {
		it("should deduct fee from single express-only part", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral } = await deployFixture()

			const withdrawAmount = 500n * 10n ** 18n
			const fee = 5n * 10n ** 18n // 5 fee

			// feeRate = 5 * 10000 / 500 = 100 (1%)
			await expressProvider.setAffiliateConfig(affiliate, 100, 0)

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount,
				fee,
				operatorFee: 0n,
			})

			// Receiver gets withdrawAmount - fee
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount - fee)
			// Fee collected
			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee)
		})

		it("should deduct fee from STANDARD withdrawal", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral } = await deployFixture()

			const withdrawAmount = 500n * 10n ** 18n
			const fee = 10n * 10n ** 18n

			// feeRate = 10 * 10000 / 500 = 200 (2%)
			await expressProvider.setAffiliateConfig(affiliate, 200, 0)

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

			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
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

			const providerData = encodeProviderData(0n, 2, 0, affiliate, 0n, 0n, fee, 0n, deadline, signature)

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			// Finalize STANDARD
			await ethers.provider.send("evm_increaseTime", [12 * 3600])
			await ethers.provider.send("evm_mine", [])
			await context.withdrawFacet.finalizeWithdrawRequest(user.address, 1)

			// Process
			await expressProvider.connect(operator).processWithdraw(user.address, 1, parts)

			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount - fee)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee)
		})

		it("should transfer full amount when fee = 0 (backward compatibility)", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral } = await deployFixture()

			const withdrawAmount = 500n * 10n ** 18n

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount,
				fee: 0n,
				operatorFee: 0n,
			})

			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(0n)
		})

		it("should allow fee equals entire withdrawal amount (user gets zero)", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral } = await deployFixture()

			const withdrawAmount = 100n * 10n ** 18n
			const fee = 100n * 10n ** 18n // fee == entire amount

			// feeRate = 100 * 10000 / 100 = 10000 (100%)
			await expressProvider.setAffiliateConfig(affiliate, 10000, 0)

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount,
				fee,
				operatorFee: 0n,
			})

			// Receiver gets nothing
			expect(await collateral.balanceOf(receiver.address)).to.equal(0n)
			// Full amount collected as fee
			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee)
		})

		it("should revert when fee + operatorFee exceeds express + virtual amount (FeesExceedExpressAmount)", async function () {
			const { botSigner, user, receiver, expressProvider, context, affiliate } = await deployFixture()

			const withdrawAmount = 100n * 10n ** 18n
			const fee = 80n * 10n ** 18n
			const opFee = 30n * 10n ** 18n // fee + opFee = 110 > 100

			// feeRate = 80 * 10000 / 100 = 8000 (80%), operatorFee = 30
			await expressProvider.setAffiliateConfig(affiliate, 8000, opFee)

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
				fee,
				operatorFee: opFee,
				partsHash,
				deadline,
			})

			const providerData = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, fee, opFee, deadline, signature)

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"FeesExceedExpressAmount",
			)
		})

		it("should deduct fee on unlockAndProcess", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral, locker, unlocker } = await deployFixture()

			const withdrawAmount = 500n * 10n ** 18n
			const fee = 10n * 10n ** 18n

			// feeRate = 10 * 10000 / 500 = 200 (2%)
			await expressProvider.setAffiliateConfig(affiliate, 200, 0)

			const { parts, requestId } = await initiateWithdraw({
				expressProvider,
				botSigner,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount,
				fee,
				operatorFee: 0n,
			})

			// Lock due to risk
			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)

			// Unlock and process
			await expressProvider.connect(unlocker).unlockAndProcess(user.address, requestId, parts)

			// Fee deducted
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount - fee)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                   MULTI-PART FEE DEDUCTION
	// ═══════════════════════════════════════════════════════════════════

	describe("Multi-Part Fee Deduction", function () {
		it("should distribute fee across two express-only parts", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral } = await deployFixture()

			const amount1 = 300n * 10n ** 18n
			const amount2 = 200n * 10n ** 18n
			const fee = 50n * 10n ** 18n // 50, less than part1

			// feeBasis = 300 + 200 = 500, feeRate = 50 * 10000 / 500 = 1000 (10%)
			await expressProvider.setAffiliateConfig(affiliate, 1000, 0)

			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: amount1,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
				{
					id: 1n,
					amount: amount2,
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
				fee,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const providerData = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, fee, 0n, deadline, signature)

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, 1, parts)

			// Receiver gets total - fee (fee taken from first part only since 50 < 300)
			expect(await collateral.balanceOf(receiver.address)).to.equal(amount1 + amount2 - fee)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee)
		})

		it("should cascade fee to second part when it exceeds first part", async function () {
			const { botSigner, operator, user, receiver, receiver2, expressProvider, context, affiliate, collateral } = await deployFixture()

			const amount1 = 100n * 10n ** 18n
			const amount2 = 400n * 10n ** 18n
			const fee = 150n * 10n ** 18n // exceeds first part (100), cascades 50 to second

			// feeBasis = 100 + 400 = 500, feeRate = 150 * 10000 / 500 = 3000 (30%)
			await expressProvider.setAffiliateConfig(affiliate, 3000, 0)

			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: amount1,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
				{
					id: 1n,
					amount: amount2,
					chainId: 31337n,
					receiver: receiver2.address,
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
				fee,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const providerData = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, fee, 0n, deadline, signature)

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, 1, parts)

			// First receiver: 100 - 100 = 0 (fee consumes entire first part)
			expect(await collateral.balanceOf(receiver.address)).to.equal(0n)
			// Second receiver: 400 - 50 = 350 (remaining 50 from fee cascaded)
			expect(await collateral.balanceOf(receiver2.address)).to.equal(amount2 - (fee - amount1))
		})

		it("should handle fee exactly equaling first part (first receiver gets zero, second gets full)", async function () {
			const { botSigner, operator, user, receiver, receiver2, expressProvider, context, affiliate, collateral } = await deployFixture()

			const amount1 = 200n * 10n ** 18n
			const amount2 = 300n * 10n ** 18n
			const fee = 200n * 10n ** 18n // exactly equals first part

			// feeBasis = 200 + 300 = 500, feeRate = 200 * 10000 / 500 = 4000 (40%)
			await expressProvider.setAffiliateConfig(affiliate, 4000, 0)

			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: amount1,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
				{
					id: 1n,
					amount: amount2,
					chainId: 31337n,
					receiver: receiver2.address,
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
				fee,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const providerData = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, fee, 0n, deadline, signature)

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, 1, parts)

			// First receiver: 0
			expect(await collateral.balanceOf(receiver.address)).to.equal(0n)
			// Second receiver: full 300
			expect(await collateral.balanceOf(receiver2.address)).to.equal(amount2)
		})

		it("should handle mixed express-only + credit-backed parts with fee", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral } = await deployFixture()

			// feeBasis = 300 + 200 = 500, feeRate = 50 * 10000 / 500 = 1000 (10%)
			await expressProvider.setAffiliateConfig(affiliate, 1000, 0)

			const expressAmount = 300n * 10n ** 18n
			const creditBackedAmount = 200n * 10n ** 18n
			const fee = 50n * 10n ** 18n // taken from express-only part first
			const expressAddr = await expressProvider.getAddress()

			const parts = [
				{
					id: 0n,
					amount: expressAmount,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
				{
					id: 1n,
					amount: creditBackedAmount,
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
				fee,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const providerData = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, fee, 0n, deadline, signature)

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])
			await expressProvider.connect(operator).processWithdraw(user.address, 1, parts)

			// Fee was taken from express part: receiver gets (300-50) + 200 = 450
			expect(await collateral.balanceOf(receiver.address)).to.equal(expressAmount + creditBackedAmount - fee)
		})

		it("should deduct fee from credit-backed withdrawal", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral } = await deployFixture()

			// feeBasis = 500, feeRate = 50 * 10000 / 500 = 1000 (10%)
			await expressProvider.setAffiliateConfig(affiliate, 1000, 0)

			// Single express-only part (credit amount reduces general pool deduction, not the part structure)
			const withdrawAmount = 500n * 10n ** 18n
			const fee = 50n * 10n ** 18n
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
				fee,
				operatorFee: 0n,
				partsHash,
				deadline,
			})

			const providerData = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, fee, 0n, deadline, signature)

			await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])

			await expressProvider.connect(operator).processWithdraw(user.address, 1, parts)

			// Receiver gets withdrawAmount - fee
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount - fee)
			// Fee is tracked in collectedFees
			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                        OPERATOR FEE
	// ═══════════════════════════════════════════════════════════════════

	describe("Operator Fee", function () {
		it("should deduct operator fee only (affiliate fee = 0)", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral } = await deployFixture()

			const withdrawAmount = 500n * 10n ** 18n
			const opFee = 2n * 10n ** 18n

			// Set operator fee on contract
			await expressProvider.setAffiliateConfig(affiliate, 0, opFee)

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount,
				fee: 0n,
				operatorFee: opFee,
			})

			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount - opFee)
			expect(await expressProvider.collectedOperatorFees(affiliate)).to.equal(opFee)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(0n)
		})

		it("should deduct both affiliate + operator fees", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral } = await deployFixture()

			const withdrawAmount = 500n * 10n ** 18n
			const fee = 5n * 10n ** 18n
			const opFee = 2n * 10n ** 18n

			// feeRate = 5 * 10000 / 500 = 100 (1%)
			await expressProvider.setAffiliateConfig(affiliate, 100, opFee)

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount,
				fee,
				operatorFee: opFee,
			})

			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount - fee - opFee)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee)
			expect(await expressProvider.collectedOperatorFees(affiliate)).to.equal(opFee)
		})

		it("should claimOperatorFees with accumulated fees", async function () {
			const { botSigner, operator, deployer, user, receiver, expressProvider, context, affiliate, collateral } = await deployFixture()

			const withdrawAmount = 500n * 10n ** 18n
			const opFee = 3n * 10n ** 18n
			await expressProvider.setAffiliateConfig(affiliate, 0, opFee)

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount,
				fee: 0n,
				operatorFee: opFee,
			})

			const balBefore = await collateral.balanceOf(deployer.address)
			await expressProvider.claimOperatorFees(affiliate, deployer.address)
			const balAfter = await collateral.balanceOf(deployer.address)

			expect(balAfter - balBefore).to.equal(opFee)
			expect(await expressProvider.collectedOperatorFees(affiliate)).to.equal(0n)
		})

		it("should revert claimOperatorFees with zero balance (NoOperatorFeesToClaim)", async function () {
			const { deployer, expressProvider, affiliate } = await deployFixture()

			await expect(expressProvider.claimOperatorFees(affiliate, deployer.address)).to.be.revertedWithCustomError(
				expressProvider,
				"NoOperatorFeesToClaim",
			)
		})

		it("should revert claimOperatorFees by non-admin", async function () {
			const { expressProvider, user, affiliate } = await deployFixture()

			await expect(expressProvider.connect(user).claimOperatorFees(affiliate, user.address)).to.be.revert(ethers)
		})

		it("should accumulate operator fees across multiple withdrawals", async function () {
			const { botSigner, operator, deployer, user, receiver, expressProvider, context, affiliate, collateral } = await deployFixture()

			const opFee = 1n * 10n ** 18n
			await expressProvider.setAffiliateConfig(affiliate, 0, opFee)

			// First withdrawal
			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 100n * 10n ** 18n,
				fee: 0n,
				operatorFee: opFee,
				nonce: 0n,
			})

			// Second withdrawal
			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 200n * 10n ** 18n,
				fee: 0n,
				operatorFee: opFee,
				nonce: 1n,
			})

			expect(await expressProvider.collectedOperatorFees(affiliate)).to.equal(opFee * 2n)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                       FEE COLLECTION
	// ═══════════════════════════════════════════════════════════════════

	describe("Fee Collection", function () {
		it("should claimFees with accumulated fees (admin receives tokens)", async function () {
			const { botSigner, operator, deployer, user, receiver, expressProvider, context, affiliate, collateral } = await deployFixture()

			const fee = 10n * 10n ** 18n

			// feeRate = 10 * 10000 / 500 = 200 (2%)
			await expressProvider.setAffiliateConfig(affiliate, 200, 0)

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 500n * 10n ** 18n,
				fee,
				operatorFee: 0n,
			})

			const balBefore = await collateral.balanceOf(deployer.address)
			await expressProvider.claimFees(affiliate, deployer.address)
			const balAfter = await collateral.balanceOf(deployer.address)

			expect(balAfter - balBefore).to.equal(fee)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(0n)
		})

		it("should revert claimFees with zero balance (NoFeesToClaim)", async function () {
			const { deployer, expressProvider, affiliate } = await deployFixture()

			await expect(expressProvider.claimFees(affiliate, deployer.address)).to.be.revertedWithCustomError(expressProvider, "NoFeesToClaim")
		})

		it("should revert claimFees by non-admin", async function () {
			const { expressProvider, affiliate, user } = await deployFixture()

			await expect(expressProvider.connect(user).claimFees(affiliate, user.address)).to.be.revert(ethers)
		})

		it("should revert double claim (second reverts)", async function () {
			const { deployer, botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral } = await deployFixture()

			const fee = 10n * 10n ** 18n

			// feeRate = 10 * 10000 / 500 = 200 (2%)
			await expressProvider.setAffiliateConfig(affiliate, 200, 0)

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 500n * 10n ** 18n,
				fee,
				operatorFee: 0n,
			})

			await expressProvider.claimFees(affiliate, deployer.address)

			await expect(expressProvider.claimFees(affiliate, deployer.address)).to.be.revertedWithCustomError(expressProvider, "NoFeesToClaim")
		})

		it("should accumulate fees from multiple withdrawals", async function () {
			const { botSigner, operator, deployer, user, receiver, expressProvider, context, affiliate, collateral } = await deployFixture()

			const fee = 5n * 10n ** 18n

			// feeRate = 5 * 10000 / 500 = 100 (1%)
			await expressProvider.setAffiliateConfig(affiliate, 100, 0)

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 500n * 10n ** 18n,
				fee,
				operatorFee: 0n,
				nonce: 0n,
			})

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 500n * 10n ** 18n,
				fee,
				operatorFee: 0n,
				nonce: 1n,
			})

			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee * 2n)

			const balBefore = await collateral.balanceOf(deployer.address)
			await expressProvider.claimFees(affiliate, deployer.address)
			const balAfter = await collateral.balanceOf(deployer.address)
			expect(balAfter - balBefore).to.equal(fee * 2n)
		})

		it("should isolate fees per affiliate (affiliate A vs B)", async function () {
			const { botSigner, operator, deployer, user, receiver, expressProvider, context, affiliate, collateral, user2 } = await deployFixture()

			const fee = 5n * 10n ** 18n

			// feeRate for affiliate A = 5 * 10000 / 500 = 100 (1%)
			await expressProvider.setAffiliateConfig(affiliate, 100, 0)

			// Frontend A (existing affiliate)
			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 500n * 10n ** 18n,
				fee,
				operatorFee: 0n,
				nonce: 0n,
			})

			// Frontend B (use user2's address as a different affiliate)
			const frontendB = user2.address
			// feeRate for frontendB = 10 * 10000 / 500 = 200 (2%)
			await expressProvider.setAffiliateConfig(frontendB, 200, 0)
			// Fund general pool more for the second withdraw
			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate: frontendB,
				affiliateAmount: 0n,
				withdrawAmount: 500n * 10n ** 18n,
				fee: fee * 2n,
				operatorFee: 0n,
				nonce: 1n,
			})

			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee)
			expect(await expressProvider.collectedFees(frontendB)).to.equal(fee * 2n)

			// Claim from affiliate A
			await expressProvider.claimFees(affiliate, deployer.address)
			// Frontend B still intact
			expect(await expressProvider.collectedFees(frontendB)).to.equal(fee * 2n)
		})

		it("should keep operator fees separate from affiliate fees", async function () {
			const { botSigner, operator, deployer, user, receiver, expressProvider, context, affiliate, collateral } = await deployFixture()

			const fee = 5n * 10n ** 18n
			const opFee = 2n * 10n ** 18n
			// feeRate = 5 * 10000 / 500 = 100 (1%)
			await expressProvider.setAffiliateConfig(affiliate, 100, opFee)

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 500n * 10n ** 18n,
				fee,
				operatorFee: opFee,
			})

			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee)
			expect(await expressProvider.collectedOperatorFees(affiliate)).to.equal(opFee)

			// Claim affiliate fees only
			await expressProvider.claimFees(affiliate, deployer.address)
			expect(await expressProvider.collectedFees(affiliate)).to.equal(0n)
			// Operator fees untouched
			expect(await expressProvider.collectedOperatorFees(affiliate)).to.equal(opFee)

			// Claim operator fees
			await expressProvider.claimOperatorFees(affiliate, deployer.address)
			expect(await expressProvider.collectedOperatorFees(affiliate)).to.equal(0n)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                      SPONSOR BALANCE
	// ═══════════════════════════════════════════════════════════════════

	describe("Sponsor Balance", function () {
		it("should deposit sponsor balance", async function () {
			const { expressProvider, affiliate, sponsor, collateral } = await deployFixture()

			const amount = 1_000n * 10n ** 18n
			await collateral.mint(sponsor.address, amount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), amount)

			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, amount)

			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(amount)
			expect(await expressProvider.sponsors(affiliate)).to.equal(sponsor.address)
		})

		it("should fully cover fee when sponsor has enough balance (user gets full amount)", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral, sponsor } = await deployFixture()

			const fee = 10n * 10n ** 18n
			const withdrawAmount = 500n * 10n ** 18n

			// feeRate = 10 * 10000 / 500 = 200 (2%)
			await expressProvider.setAffiliateConfig(affiliate, 200, 0)

			// Deposit sponsor balance
			const sponsorAmount = 100n * 10n ** 18n
			await collateral.mint(sponsor.address, sponsorAmount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, sponsorAmount)

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount,
				fee,
				operatorFee: 0n,
				maxUserFee: 0n, // user expects to pay nothing
			})

			// User gets full amount (sponsor covered the fee)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)
			// Sponsor balance reduced
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount - fee)
			// Fee still collected
			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee)
		})

		it("should partially cover fee when sponsor balance insufficient (user pays remainder)", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral, sponsor } = await deployFixture()

			const fee = 10n * 10n ** 18n
			const withdrawAmount = 500n * 10n ** 18n
			const sponsorAmount = 4n * 10n ** 18n // only 4

			// feeRate = 10 * 10000 / 500 = 200 (2%)
			await expressProvider.setAffiliateConfig(affiliate, 200, 0)

			await collateral.mint(sponsor.address, sponsorAmount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, sponsorAmount)

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount,
				fee,
				operatorFee: 0n,
				maxUserFee: fee - sponsorAmount, // user pays 6
			})

			// User pays the remainder (10 - 4 = 6)
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount - (fee - sponsorAmount))
			// Sponsor drained
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(0n)
		})

		it("should make user pay full fee when sponsor balance = 0", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral } = await deployFixture()

			const fee = 10n * 10n ** 18n
			const withdrawAmount = 500n * 10n ** 18n

			// feeRate = 10 * 10000 / 500 = 200 (2%)
			await expressProvider.setAffiliateConfig(affiliate, 200, 0)

			// No sponsor deposit
			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount,
				fee,
				operatorFee: 0n,
			})

			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount - fee)
		})

		it("should refund sponsor on cancel", async function () {
			const { botSigner, user, receiver, expressProvider, context, affiliate, collateral, sponsor } = await deployFixture()

			const fee = 10n * 10n ** 18n
			const withdrawAmount = 200n * 10n ** 18n
			const sponsorAmount = 50n * 10n ** 18n

			// feeRate = 10 * 10000 / 200 = 500 (5%)
			await expressProvider.setAffiliateConfig(affiliate, 500, 0)

			await collateral.mint(sponsor.address, sponsorAmount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, sponsorAmount)

			const { requestId } = await initiateWithdraw({
				expressProvider,
				botSigner,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount,
				fee,
				operatorFee: 0n,
				maxUserFee: 0n,
			})

			// Sponsor balance was locked (reduced)
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount - fee)

			// Cancel
			await context.withdrawFacet.connect(user).requestCancelWithdraw(requestId)

			// Sponsor balance fully restored
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount)
		})

		it("should refund sponsor on suspend", async function () {
			const { botSigner, user, receiver, expressProvider, context, affiliate, collateral, sponsor } = await deployFixture()

			const fee = 10n * 10n ** 18n
			const withdrawAmount = 200n * 10n ** 18n
			const sponsorAmount = 50n * 10n ** 18n

			// feeRate = 10 * 10000 / 200 = 500 (5%)
			await expressProvider.setAffiliateConfig(affiliate, 500, 0)

			await collateral.mint(sponsor.address, sponsorAmount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, sponsorAmount)

			const { requestId } = await initiateWithdraw({
				expressProvider,
				botSigner,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount,
				fee,
				operatorFee: 0n,
				maxUserFee: 0n,
			})

			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount - fee)

			// Suspend
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			// Sponsor balance restored
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount)
		})

		it("should allow admin to withdraw sponsor balance to sponsor", async function () {
			const { expressProvider, affiliate, sponsor, collateral } = await deployFixture()

			const amount = 1_000n * 10n ** 18n
			await collateral.mint(sponsor.address, amount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), amount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, amount)

			const balBefore = await collateral.balanceOf(sponsor.address)
			await expressProvider.withdrawSponsorBalance(affiliate, amount, sponsor.address)
			const balAfter = await collateral.balanceOf(sponsor.address)

			expect(balAfter - balBefore).to.equal(amount)
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(0n)
		})

		it("should allow admin to withdraw sponsor balance to self", async function () {
			const { deployer, expressProvider, affiliate, sponsor, collateral } = await deployFixture()

			const amount = 1_000n * 10n ** 18n
			await collateral.mint(sponsor.address, amount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), amount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, amount)

			const balBefore = await collateral.balanceOf(deployer.address)
			await expressProvider.withdrawSponsorBalance(affiliate, amount, deployer.address)
			const balAfter = await collateral.balanceOf(deployer.address)

			expect(balAfter - balBefore).to.equal(amount)
		})

		it("should reject withdraw by non-admin", async function () {
			const { expressProvider, affiliate, sponsor, collateral, user } = await deployFixture()

			const amount = 1_000n * 10n ** 18n
			await collateral.mint(sponsor.address, amount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), amount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, amount)

			await expect(expressProvider.connect(user).withdrawSponsorBalance(affiliate, amount, user.address)).to.be.revert(ethers)
		})

		it("should reject withdraw more than balance (InsufficientSponsorBalance)", async function () {
			const { deployer, expressProvider, affiliate, sponsor, collateral } = await deployFixture()

			const amount = 100n * 10n ** 18n
			await collateral.mint(sponsor.address, amount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), amount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, amount)

			await expect(expressProvider.withdrawSponsorBalance(affiliate, amount + 1n, deployer.address)).to.be.revertedWithCustomError(
				expressProvider,
				"InsufficientSponsorBalance",
			)
		})

		it("should NOT let second depositor override sponsor address", async function () {
			const { expressProvider, affiliate, sponsor, user2, collateral } = await deployFixture()

			// First sponsor deposits
			const amount1 = 100n * 10n ** 18n
			await collateral.mint(sponsor.address, amount1)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), amount1)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, amount1)

			expect(await expressProvider.sponsors(affiliate)).to.equal(sponsor.address)

			// Second depositor
			const amount2 = 50n * 10n ** 18n
			await collateral.mint(user2.address, amount2)
			await collateral.connect(user2).approve(await expressProvider.getAddress(), amount2)
			await expressProvider.connect(user2).depositSponsorBalance(affiliate, amount2)

			// Sponsor address NOT overridden -- stays as original sponsor
			expect(await expressProvider.sponsors(affiliate)).to.equal(sponsor.address)
			// Balances accumulated
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(amount1 + amount2)
		})

		it("should allow deposit of zero amount", async function () {
			const { expressProvider, affiliate, sponsor, collateral } = await deployFixture()

			// Deposit zero -- should not revert
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, 0n)
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(0n)
			expect(await expressProvider.sponsors(affiliate)).to.equal(sponsor.address)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                       SPONSOR CONFIG
	// ═══════════════════════════════════════════════════════════════════

	describe("Sponsor Config", function () {
		it("should cap coverage with maxFeePerWithdraw", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral, sponsor } = await deployFixture()

			const fee = 20n * 10n ** 18n
			const sponsorAmount = 100n * 10n ** 18n
			const maxFeePerWithdraw = 5n * 10n ** 18n // sponsor caps at 5 per withdraw

			// feeRate = 20 * 10000 / 500 = 400 (4%)
			await expressProvider.setAffiliateConfig(affiliate, 400, 0)

			await collateral.mint(sponsor.address, sponsorAmount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, sponsorAmount)
			await expressProvider.setSponsorConfig(affiliate, maxFeePerWithdraw, 0n)

			// User pays fee - maxFeePerWithdraw = 15
			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 500n * 10n ** 18n,
				fee,
				operatorFee: 0n,
				maxUserFee: fee - maxFeePerWithdraw,
			})

			expect(await collateral.balanceOf(receiver.address)).to.equal(500n * 10n ** 18n - (fee - maxFeePerWithdraw))
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount - maxFeePerWithdraw)
		})

		it("should apply no limit when maxFeePerWithdraw = 0", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral, sponsor } = await deployFixture()

			const fee = 20n * 10n ** 18n
			const sponsorAmount = 100n * 10n ** 18n

			// feeRate = 20 * 10000 / 500 = 400 (4%)
			await expressProvider.setAffiliateConfig(affiliate, 400, 0)

			await collateral.mint(sponsor.address, sponsorAmount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, sponsorAmount)
			await expressProvider.setSponsorConfig(affiliate, 0n, 0n) // no limit

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 500n * 10n ** 18n,
				fee,
				operatorFee: 0n,
				maxUserFee: 0n, // sponsor covers all
			})

			// User gets full amount
			expect(await collateral.balanceOf(receiver.address)).to.equal(500n * 10n ** 18n)
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount - fee)
		})

		it("should not limit when maxFeePerWithdraw > totalFee", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral, sponsor } = await deployFixture()

			const fee = 10n * 10n ** 18n
			const sponsorAmount = 100n * 10n ** 18n
			const maxFeePerWithdraw = 50n * 10n ** 18n // much larger than fee

			// feeRate = 10 * 10000 / 500 = 200 (2%)
			await expressProvider.setAffiliateConfig(affiliate, 200, 0)

			await collateral.mint(sponsor.address, sponsorAmount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, sponsorAmount)
			await expressProvider.setSponsorConfig(affiliate, maxFeePerWithdraw, 0n)

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 500n * 10n ** 18n,
				fee,
				operatorFee: 0n,
				maxUserFee: 0n,
			})

			// Sponsor only charged actual fee, not maxFeePerWithdraw
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount - fee)
			expect(await collateral.balanceOf(receiver.address)).to.equal(500n * 10n ** 18n)
		})

		it("should handle maxFeePerWithdraw == totalFee (exact boundary)", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral, sponsor } = await deployFixture()

			const fee = 10n * 10n ** 18n
			const sponsorAmount = 100n * 10n ** 18n

			// feeRate = 10 * 10000 / 500 = 200 (2%)
			await expressProvider.setAffiliateConfig(affiliate, 200, 0)

			await collateral.mint(sponsor.address, sponsorAmount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, sponsorAmount)
			await expressProvider.setSponsorConfig(affiliate, fee, 0n)

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 500n * 10n ** 18n,
				fee,
				operatorFee: 0n,
				maxUserFee: 0n,
			})

			expect(await collateral.balanceOf(receiver.address)).to.equal(500n * 10n ** 18n)
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount - fee)
		})

		it("should skip sponsor for large withdrawals (maxWithdrawAmount)", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral, sponsor } = await deployFixture()

			const fee = 10n * 10n ** 18n
			const sponsorAmount = 100n * 10n ** 18n
			const maxWithdrawAmount = 200n * 10n ** 18n

			// feeRate = 10 * 10000 / 500 = 200 (2%)
			await expressProvider.setAffiliateConfig(affiliate, 200, 0)

			await collateral.mint(sponsor.address, sponsorAmount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, sponsorAmount)
			await expressProvider.setSponsorConfig(affiliate, 0n, maxWithdrawAmount)

			// Withdraw 500 > maxWithdrawAmount (200) -- sponsor skipped
			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 500n * 10n ** 18n,
				fee,
				operatorFee: 0n,
				// maxUserFee defaults to fee (user pays full)
			})

			// User pays the full fee
			expect(await collateral.balanceOf(receiver.address)).to.equal(500n * 10n ** 18n - fee)
			// Sponsor balance unchanged
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount)
		})

		it("should skip sponsor for large express withdrawals (maxWithdrawAmount)", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral, sponsor } = await deployFixture()

			const fee = 10n * 10n ** 18n
			const sponsorAmount = 100n * 10n ** 18n
			const maxWithdrawAmount = 200n * 10n ** 18n
			const withdrawAmount = 500n * 10n ** 18n

			// feeRate = 10 * 10000 / 500 = 200 (2%)
			await expressProvider.setAffiliateConfig(affiliate, 200, 0)

			await collateral.mint(sponsor.address, sponsorAmount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, sponsorAmount)
			await expressProvider.setSponsorConfig(affiliate, 0n, maxWithdrawAmount)

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount,
				fee,
				operatorFee: 0n,
			})

			// User pays the full fee because the withdrawal size exceeded the cap.
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount - fee)
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount)
		})

		it("should apply no limit when maxWithdrawAmount = 0", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral, sponsor } = await deployFixture()

			const fee = 10n * 10n ** 18n
			const sponsorAmount = 100n * 10n ** 18n

			// feeRate = 10 * 10000 / 5000 = 20 (0.2%)
			await expressProvider.setAffiliateConfig(affiliate, 20, 0)

			await collateral.mint(sponsor.address, sponsorAmount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, sponsorAmount)
			await expressProvider.setSponsorConfig(affiliate, 0n, 0n)

			// Any size withdrawal is sponsored
			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 5000n * 10n ** 18n,
				fee,
				operatorFee: 0n,
				maxUserFee: 0n,
			})

			expect(await collateral.balanceOf(receiver.address)).to.equal(5000n * 10n ** 18n)
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount - fee)
		})

		it("should sponsor when maxWithdrawAmount == expressAmount (exact boundary)", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral, sponsor } = await deployFixture()

			const fee = 10n * 10n ** 18n
			const sponsorAmount = 100n * 10n ** 18n
			const withdrawAmount = 200n * 10n ** 18n

			// feeRate = 10 * 10000 / 200 = 500 (5%)
			await expressProvider.setAffiliateConfig(affiliate, 500, 0)

			await collateral.mint(sponsor.address, sponsorAmount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, sponsorAmount)
			await expressProvider.setSponsorConfig(affiliate, 0n, withdrawAmount)

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount,
				fee,
				operatorFee: 0n,
				maxUserFee: 0n,
			})

			// expressAmount == maxWithdrawAmount: sponsor covers
			expect(await collateral.balanceOf(receiver.address)).to.equal(withdrawAmount)
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount - fee)
		})

		it("should handle both caps set simultaneously", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral, sponsor } = await deployFixture()

			const fee = 20n * 10n ** 18n
			const sponsorAmount = 100n * 10n ** 18n
			const maxFeePerWithdraw = 8n * 10n ** 18n
			const maxWithdrawAmount = 600n * 10n ** 18n

			// feeRate = 20 * 10000 / 500 = 400 (4%)
			await expressProvider.setAffiliateConfig(affiliate, 400, 0)

			await collateral.mint(sponsor.address, sponsorAmount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, sponsorAmount)
			await expressProvider.setSponsorConfig(affiliate, maxFeePerWithdraw, maxWithdrawAmount)

			// withdrawAmount (500) <= maxWithdrawAmount (600): sponsor eligible
			// fee (20) capped by maxFeePerWithdraw (8): sponsor covers 8
			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 500n * 10n ** 18n,
				fee,
				operatorFee: 0n,
				maxUserFee: fee - maxFeePerWithdraw, // user pays 12
			})

			expect(await collateral.balanceOf(receiver.address)).to.equal(500n * 10n ** 18n - (fee - maxFeePerWithdraw))
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount - maxFeePerWithdraw)
		})

		it("should allow setSponsorConfig by setter", async function () {
			const { deployer, expressProvider, affiliate, sponsor, collateral } = await deployFixture()

			// Register a sponsor first
			await collateral.mint(sponsor.address, 10n * 10n ** 18n)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), 10n * 10n ** 18n)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, 10n * 10n ** 18n)

			// Deployer has SETTER_ROLE
			await expressProvider.setSponsorConfig(affiliate, 3n * 10n ** 18n, 500n * 10n ** 18n)

			const config = await expressProvider.sponsorConfigs(affiliate)
			expect(config.maxFeePerWithdraw).to.equal(3n * 10n ** 18n)
			expect(config.maxWithdrawAmount).to.equal(500n * 10n ** 18n)
		})

		it("should reject setSponsorConfig by non-setter", async function () {
			const { expressProvider, affiliate, sponsor, collateral, user } = await deployFixture()

			// Register sponsor
			await collateral.mint(sponsor.address, 10n * 10n ** 18n)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), 10n * 10n ** 18n)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, 10n * 10n ** 18n)

			await expect(expressProvider.connect(user).setSponsorConfig(affiliate, 1n, 1n)).to.be.revert(ethers)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                        maxUserFee
	// ═══════════════════════════════════════════════════════════════════

	describe("maxUserFee", function () {
		it("should pass when maxUserFee = fee + operatorFee, no sponsor (user pays full)", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral } = await deployFixture()

			const fee = 10n * 10n ** 18n
			const opFee = 2n * 10n ** 18n
			// feeRate = 10 * 10000 / 500 = 200 (2%)
			await expressProvider.setAffiliateConfig(affiliate, 200, opFee)

			// maxUserFee = fee + opFee (no sponsor, user pays full)
			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 500n * 10n ** 18n,
				fee,
				operatorFee: opFee,
				maxUserFee: fee + opFee,
			})

			expect(await collateral.balanceOf(receiver.address)).to.equal(500n * 10n ** 18n - fee - opFee)
		})

		it("should pass when maxUserFee = 0 with full sponsor coverage", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral, sponsor } = await deployFixture()

			const fee = 10n * 10n ** 18n
			const sponsorAmount = 100n * 10n ** 18n

			// feeRate = 10 * 10000 / 500 = 200 (2%)
			await expressProvider.setAffiliateConfig(affiliate, 200, 0)

			await collateral.mint(sponsor.address, sponsorAmount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, sponsorAmount)

			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 500n * 10n ** 18n,
				fee,
				operatorFee: 0n,
				maxUserFee: 0n,
			})

			expect(await collateral.balanceOf(receiver.address)).to.equal(500n * 10n ** 18n)
		})

		it("should revert when maxUserFee < totalFee and insufficient sponsor (UserFeeExceedsMaximum)", async function () {
			const { botSigner, user, receiver, expressProvider, context, affiliate } = await deployFixture()

			const fee = 10n * 10n ** 18n

			// feeRate = 10 * 10000 / 500 = 200 (2%)
			await expressProvider.setAffiliateConfig(affiliate, 200, 0)

			const expressAddr = await expressProvider.getAddress()

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
			const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600

			// maxUserFee = 5 but no sponsor, so actualUserFee = 10 > 5
			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce: 0n,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee,
				operatorFee: 0n,
				maxUserFee: 5n * 10n ** 18n,
				partsHash,
				deadline,
			})

			const providerData = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, fee, 0n, deadline, signature, 5n * 10n ** 18n)

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"UserFeeExceedsMaximum",
			)
		})

		it("should pass when actualUserFee == maxUserFee (exact boundary)", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral, sponsor } = await deployFixture()

			const fee = 10n * 10n ** 18n
			const sponsorAmount = 6n * 10n ** 18n

			// feeRate = 10 * 10000 / 500 = 200 (2%)
			await expressProvider.setAffiliateConfig(affiliate, 200, 0)

			await collateral.mint(sponsor.address, sponsorAmount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, sponsorAmount)

			// sponsor covers 6, user pays 4, maxUserFee = 4 (exact boundary)
			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 500n * 10n ** 18n,
				fee,
				operatorFee: 0n,
				maxUserFee: 4n * 10n ** 18n,
			})

			expect(await collateral.balanceOf(receiver.address)).to.equal(500n * 10n ** 18n - 4n * 10n ** 18n)
		})

		it("should revert when sponsor is drained between sign and tx (second user's withdrawal fails)", async function () {
			const { botSigner, user, user2, receiver, receiver2, expressProvider, context, affiliate, collateral, sponsor } = await deployFixture()

			const fee = 10n * 10n ** 18n
			const sponsorAmount = 10n * 10n ** 18n // exactly enough for one withdrawal

			// feeRate = 10 * 10000 / 200 = 500 (5%)
			await expressProvider.setAffiliateConfig(affiliate, 500, 0)

			await collateral.mint(sponsor.address, sponsorAmount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, sponsorAmount)

			// First user's withdrawal succeeds -- drains the sponsor
			await initiateWithdraw({
				expressProvider,
				botSigner,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 200n * 10n ** 18n,
				fee,
				operatorFee: 0n,
				nonce: 0n,
				maxUserFee: 0n,
			})

			// Sponsor is now drained
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(0n)

			// Second user tries to withdraw with maxUserFee=0 expecting sponsor coverage
			const expressAddr = await expressProvider.getAddress()
			const parts2 = [
				{
					id: 0n,
					amount: 200n * 10n ** 18n,
					chainId: 31337n,
					receiver: receiver2.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const partsHash2 = computePartsHash(parts2)
			const deadline2 = (await ethers.provider.getBlock("latest"))!.timestamp + 3600

			const signature2 = await signWithdrawOption(expressProvider, botSigner, {
				user: user2.address,
				nonce: 0n,
				optionType: 1,
				availableAt: 0,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee,
				operatorFee: 0n,
				maxUserFee: 0n, // expects sponsor to cover everything
				partsHash: partsHash2,
				deadline: deadline2,
			})

			const providerData2 = encodeProviderData(0n, 1, 0, affiliate, 0n, 0n, fee, 0n, deadline2, signature2, 0n)

			// This should revert because sponsor is drained and maxUserFee=0
			await expect(context.withdrawFacet.connect(user2).initiateWithdraw(parts2, false, providerData2)).to.be.revertedWithCustomError(
				expressProvider,
				"UserFeeExceedsMaximum",
			)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                  SPONSOR COVERAGE PRIORITY
	// ═══════════════════════════════════════════════════════════════════

	describe("Sponsor Coverage Priority", function () {
		it("should cover operator fee first, then affiliate fee from sponsor", async function () {
			const { botSigner, operator, user, receiver, expressProvider, context, affiliate, collateral, sponsor } = await deployFixture()

			const fee = 10n * 10n ** 18n
			const opFee = 5n * 10n ** 18n
			const totalFee = fee + opFee
			const sponsorAmount = 100n * 10n ** 18n

			// feeRate = 10 * 10000 / 500 = 200 (2%)
			await expressProvider.setAffiliateConfig(affiliate, 200, opFee)

			await collateral.mint(sponsor.address, sponsorAmount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, sponsorAmount)

			// Full sponsor coverage
			await doWithdraw({
				expressProvider,
				botSigner,
				operator,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 500n * 10n ** 18n,
				fee,
				operatorFee: opFee,
				maxUserFee: 0n,
			})

			// User gets full amount
			expect(await collateral.balanceOf(receiver.address)).to.equal(500n * 10n ** 18n)

			// Both fees collected
			expect(await expressProvider.collectedFees(affiliate)).to.equal(fee)
			expect(await expressProvider.collectedOperatorFees(affiliate)).to.equal(opFee)

			// Sponsor charged for both
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(sponsorAmount - totalFee)
		})

		it("should lock sponsor deterministically at acceptance (multiple concurrent withdrawals)", async function () {
			const { botSigner, operator, user, user2, receiver, receiver2, expressProvider, context, affiliate, collateral, sponsor } =
				await deployFixture()

			const fee = 10n * 10n ** 18n
			const sponsorAmount = 15n * 10n ** 18n // not enough for two full fees

			// feeRate = 10 * 10000 / 200 = 500 (5%)
			await expressProvider.setAffiliateConfig(affiliate, 500, 0)

			await collateral.mint(sponsor.address, sponsorAmount)
			await collateral.connect(sponsor).approve(await expressProvider.getAddress(), sponsorAmount)
			await expressProvider.connect(sponsor).depositSponsorBalance(affiliate, sponsorAmount)

			// First withdrawal: user1 -- sponsor covers full fee (10)
			await initiateWithdraw({
				expressProvider,
				botSigner,
				user,
				receiver,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 200n * 10n ** 18n,
				fee,
				operatorFee: 0n,
				nonce: 0n,
				maxUserFee: 0n,
			})

			// After first acceptance, sponsor has 15 - 10 = 5 left
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(5n * 10n ** 18n)

			// Second withdrawal: user2 -- sponsor covers only 5 of 10, user pays 5
			await initiateWithdraw({
				expressProvider,
				botSigner,
				user: user2,
				receiver: receiver2,
				context,
				affiliate,
				affiliateAmount: 0n,
				withdrawAmount: 200n * 10n ** 18n,
				fee,
				operatorFee: 0n,
				nonce: 0n,
				maxUserFee: 5n * 10n ** 18n, // user2 pays 5
			})

			// Sponsor fully drained
			expect(await expressProvider.sponsorBalances(affiliate)).to.equal(0n)

			// Process both -- deterministic fee deduction
			await ethers.provider.send("evm_increaseTime", [21])
			await ethers.provider.send("evm_mine", [])

			const expressAddr = await expressProvider.getAddress()

			// Process user1's withdrawal
			const parts1 = [
				{
					id: 0n,
					amount: 200n * 10n ** 18n,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			await expressProvider.connect(operator).processWithdraw(user.address, 1, parts1)

			// Process user2's withdrawal
			const parts2 = [
				{
					id: 0n,
					amount: 200n * 10n ** 18n,
					chainId: 31337n,
					receiver: receiver2.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]
			await expressProvider.connect(operator).processWithdraw(user2.address, 1, parts2)

			// User1 gets full amount (sponsor covered 10)
			expect(await collateral.balanceOf(receiver.address)).to.equal(200n * 10n ** 18n)
			// User2 pays 5 (sponsor only covered 5 of 10)
			expect(await collateral.balanceOf(receiver2.address)).to.equal(200n * 10n ** 18n - 5n * 10n ** 18n)
		})
	})
}
