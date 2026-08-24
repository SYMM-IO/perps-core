import { expect } from "chai"

import { deployExpressProvider } from "../tasks/deploy/expressWithdrawLayerDiamond.js"
import { initializeFixture } from "./Initialize.fixture.js"
import connection, { ethers, hre } from "./helpers/hardhat-connection.js"
import { RunContext } from "./models/RunContext.js"
import { buildSignedExpressCreditData, deterministicMuonKey, EXPRESS_CREDIT_MUON_FUNCTION } from "./utils/MuonSignature.js"

const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"))
const SIGNER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("SIGNER_ROLE"))
const LOCKER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LOCKER_ROLE"))
const UNLOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UNLOCK_ROLE"))

// WithdrawInfo.status values
const STATUS_ACCEPTED = 1n
const STATUS_LOCKED = 2n
const STATUS_PROCESSED = 3n
const STATUS_FINALIZED = 4n
const STATUS_CANCELLED = 5n
const STATUS_SUSPENDED = 6n

// WithdrawInfo.optionType values
const OPT_SAME_TX = 0n
const OPT_WINDOWED = 1n
const OPT_STANDARD = 2n
const DEFAULT_ACCELERATION_FEE = 1n

export function shouldBehaveLikeExpressLayerAccelerate(): void {
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
		const randomCaller = allSigners[19]

		const collateral = context.collateral

		const expressProvider = await deployExpressProvider(hre, connection, {
			admin: deployer.address,
			symmio: context.diamond,
			collateral: await collateral.getAddress(),
		})

		const muonVerifier = await ethers.deployContract("MockMuonSignatureVerifier")

		await context.controlFacet.connect(deployer).registerExpressProvider(await expressProvider.getAddress())

		await context.controlFacet.connect(deployer).setMaxWithdrawParts(50)
		await context.controlFacet.connect(deployer).setWithdrawCooldownPeriod(43200)

		await context.controlFacet.connect(deployer).grantRole(deployer.address, ethers.keccak256(ethers.toUtf8Bytes("SUSPENDER_ROLE")))

		await expressProvider.grantRole(SIGNER_ROLE, botSigner.address)
		await expressProvider.grantRole(OPERATOR_ROLE, operator.address)
		await expressProvider.grantRole(LOCKER_ROLE, locker.address)
		await expressProvider.grantRole(UNLOCK_ROLE, unlocker.address)
		const affiliate = affiliateOwner.address

		await expressProvider.setCreditLineMuonConfig(await muonVerifier.getAddress(), 1n, 60n)

		// User balance in Symmio
		const userBalance = 100_000n * 10n ** 18n
		await collateral.mint(user.address, userBalance)
		await collateral.connect(user).approve(context.diamond, ethers.MaxUint256)
		await context.accountFacet.connect(user).deposit(userBalance)

		// General pool 10_000
		const generalFunding = 10_000n * 10n ** 18n
		await collateral.mint(deployer.address, generalFunding)
		await collateral.approve(await expressProvider.getAddress(), generalFunding)
		await expressProvider.depositToGeneral(generalFunding)

		// Affiliate pool 5_000
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
			randomCaller,
			affiliate,
			collateral,
			expressProvider,
			muonVerifier,
			generalFunding,
			affiliateFunding,
		}
	}

	// ── Helpers ──

	function computePartsHash(parts: any[]): string {
		const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
			["tuple(uint256 id, uint256 amount, int256 chainId, bytes receiver, address virtualProvider, address expressProvider)[]"],
			[parts],
		)
		return ethers.keccak256(encoded)
	}

	function buildCreditData(eligibleBase: bigint, timestamp: number): string {
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

	async function signWithdrawOption(
		expressProvider: any,
		signer: any,
		params: {
			user: string
			nonce: bigint
			optionType: number
			affiliate: string
			affiliateAmount: bigint
			creditAmount: bigint
			fee?: bigint
			operatorFee?: bigint
			maxUserFee?: bigint
			partsHash: string
			deadline: number
			maxAccelerationFee?: bigint
		},
	) {
		const fee = params.fee ?? 0n
		const operatorFee = params.operatorFee ?? 0n
		const maxUserFee = params.maxUserFee ?? fee + operatorFee
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
			availableAt: 0,
			affiliate: params.affiliate,
			affiliateAmount: params.affiliateAmount,
			creditAmount: params.creditAmount,
			fee,
			operatorFee,
			maxUserFee,
			maxAccelerationFee,
			partsHash: params.partsHash,
			deadline: params.deadline,
		}
		return signer.signTypedData(domain, types, value)
	}

	function encodeWithdrawProviderData(
		nonce: bigint,
		optionType: number,
		affiliate: string,
		affiliateAmount: bigint,
		creditAmount: bigint,
		deadline: number,
		signature: string,
		creditDataRaw?: string,
		maxAccelerationFee = 0n,
		fee = 0n,
		operatorFee = 0n,
		maxUserFee = fee + operatorFee,
	): string {
		const offerData = ethers.AbiCoder.defaultAbiCoder().encode(
			["uint256", "uint8", "uint256", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "bytes"],
			[nonce, optionType, 0n, affiliate, affiliateAmount, creditAmount, fee, operatorFee, maxUserFee, maxAccelerationFee, deadline, signature],
		)
		const validatorData = ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]", "uint256[]"], [[], []])
		return ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "bytes", "bytes"], [offerData, validatorData, creditDataRaw ?? "0x"])
	}

	async function signAccelerateOffer(
		expressProvider: any,
		signer: any,
		params: {
			user: string
			requestId: bigint
			nonce: bigint
			affiliateAmount: bigint
			creditAmount: bigint
			accelerationFee?: bigint
			partsHash: string
			deadline: number
		},
	) {
		const accelerationFee = params.accelerationFee ?? 0n
		const domain = {
			name: "ExpressProvider",
			version: "1",
			chainId: 31337,
			verifyingContract: await expressProvider.getAddress(),
		}
		const types = {
			AccelerateOffer: [
				{ name: "user", type: "address" },
				{ name: "requestId", type: "uint256" },
				{ name: "nonce", type: "uint256" },
				{ name: "affiliateAmount", type: "uint256" },
				{ name: "creditAmount", type: "uint256" },
				{ name: "accelerationFee", type: "uint256" },
				{ name: "partsHash", type: "bytes32" },
				{ name: "deadline", type: "uint256" },
			],
		}
		return signer.signTypedData(domain, types, { ...params, accelerationFee })
	}

	function encodeAccelerateOfferData(
		nonce: bigint,
		affiliateAmount: bigint,
		creditAmount: bigint,
		accelerationFee: bigint,
		deadline: number,
		signature: string,
	): string {
		return ethers.AbiCoder.defaultAbiCoder().encode(
			["tuple(uint256 nonce, uint256 affiliateAmount, uint256 creditAmount, uint256 accelerationFee, uint256 deadline, bytes signature)"],
			[{ nonce, affiliateAmount, creditAmount, accelerationFee, deadline, signature }],
		)
	}

	// Bump the user's core deallocate timestamp to now so cooldownEndTime = now + 12h.
	// Without this, cooldownEndTime = now (floor), and accelerate's timing guard fires at once.
	async function triggerRecentDeallocate(fixture: any) {
		const { context, user, deployer } = fixture
		await context.controlFacet.connect(deployer).grantRole(user.address, ethers.keccak256(ethers.toUtf8Bytes("BALANCE_SETTLER_ROLE")))
		await context.accountFacet.connect(user).allocate(1n)
		await context.accountFacet.connect(user).zeroUpnlDeallocate(1n)
	}

	// Accept a STANDARD withdrawal — the precondition for acceleration.
	async function acceptStandard(
		fixture: any,
		opts?: {
			withdrawAmount?: bigint
			skipDeallocate?: boolean
			maxAccelerationFee?: bigint
			fee?: bigint
			operatorFee?: bigint
			maxUserFee?: bigint
		},
	) {
		const { botSigner, user, receiver, expressProvider, context, affiliate } = fixture
		if (!opts?.skipDeallocate) await triggerRecentDeallocate(fixture)
		const withdrawAmount = opts?.withdrawAmount ?? 500n * 10n ** 18n
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
		const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 24 * 3600
		const nonce = await expressProvider.nonces(user.address)

		const signature = await signWithdrawOption(expressProvider, botSigner, {
			user: user.address,
			nonce,
			optionType: 2,
			affiliate,
			affiliateAmount: 0n,
			creditAmount: 0n,
			fee: opts?.fee,
			operatorFee: opts?.operatorFee,
			maxUserFee: opts?.maxUserFee,
			partsHash,
			deadline,
			maxAccelerationFee: opts?.maxAccelerationFee ?? DEFAULT_ACCELERATION_FEE,
		})

		const providerData = encodeWithdrawProviderData(
			nonce,
			2,
			affiliate,
			0n,
			0n,
			deadline,
			signature,
			undefined,
			opts?.maxAccelerationFee ?? DEFAULT_ACCELERATION_FEE,
			opts?.fee ?? 0n,
			opts?.operatorFee ?? 0n,
			opts?.maxUserFee,
		)
		await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

		const requestId: bigint = await context.viewFacet.getLastWithdrawRequestId(user.address)
		return { parts, requestId, withdrawAmount, partsHash }
	}

	// Accept a WINDOWED withdrawal — used to pre-consume credit cap for retry tests.
	async function acceptWindowedWithCredit(fixture: any, opts: { withdrawAmount: bigint; creditAmount: bigint }) {
		const { botSigner, user, receiver, expressProvider, context, affiliate } = fixture
		const expressAddr = await expressProvider.getAddress()

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

		const partsHash = computePartsHash(parts)
		const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600
		const now = (await ethers.provider.getBlock("latest"))!.timestamp
		const nonce = await expressProvider.nonces(user.address)

		const signature = await signWithdrawOption(expressProvider, botSigner, {
			user: user.address,
			nonce,
			optionType: 1,
			affiliate,
			affiliateAmount: 0n,
			creditAmount: opts.creditAmount,
			partsHash,
			deadline,
		})

		const creditDataRaw = buildCreditData(10_000n * 10n ** 18n, now)
		const providerData = encodeWithdrawProviderData(nonce, 1, affiliate, 0n, opts.creditAmount, deadline, signature, creditDataRaw)

		await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)
		const requestId: bigint = await context.viewFacet.getLastWithdrawRequestId(user.address)
		return { parts, requestId }
	}

	async function buildAccelerateCall(
		fixture: any,
		opts: {
			user: string
			requestId: bigint
			parts: any[]
			nonce: bigint
			affiliateAmount: bigint
			creditAmount: bigint
			accelerationFee?: bigint
			partsHash: string
			signer?: any
			deadlineOffset?: number
		},
	) {
		const { expressProvider, botSigner } = fixture
		const signer = opts.signer ?? botSigner
		const now = (await ethers.provider.getBlock("latest"))!.timestamp
		const deadline = now + (opts.deadlineOffset ?? 3600)

		const sig = await signAccelerateOffer(expressProvider, signer, {
			user: opts.user,
			requestId: opts.requestId,
			nonce: opts.nonce,
			affiliateAmount: opts.affiliateAmount,
			creditAmount: opts.creditAmount,
			accelerationFee: opts.accelerationFee ?? DEFAULT_ACCELERATION_FEE,
			partsHash: opts.partsHash,
			deadline,
		})

		const offerData = encodeAccelerateOfferData(
			opts.nonce,
			opts.affiliateAmount,
			opts.creditAmount,
			opts.accelerationFee ?? DEFAULT_ACCELERATION_FEE,
			deadline,
			sig,
		)
		const creditDataRaw = opts.creditAmount > 0n ? buildCreditData(10_000n * 10n ** 18n, now) : "0x"

		return { offerData, creditDataRaw, deadline }
	}

	// ═══════════════════════════════════════════════════════════════════
	//                            HAPPY PATH
	// ═══════════════════════════════════════════════════════════════════

	describe("Happy Path", function () {
		it("requires ExpressCredit signer permissions when accelerating with credit", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, affiliate, randomCaller, deployer, context } = fixture
			const gatewaySigner = (await ethers.getSigners())[12]
			const realVerifier = await ethers.deployContract("MuonSignatureVerifier", [deployer.address])
			const muonKey = deterministicMuonKey()

			await realVerifier.addPublicKey(muonKey.publicKey)
			await realVerifier.addGatewaySigner(gatewaySigner.address)
			await realVerifier.setPublicKeyPermissions(muonKey.publicKey, [0], true)
			await realVerifier.setGatewaySignerPermissions(gatewaySigner.address, [EXPRESS_CREDIT_MUON_FUNCTION], true)
			await expressProvider.setCreditLineMuonConfig(await realVerifier.getAddress(), 1n, 60n)

			const withdrawAmount = 500n * 10n ** 18n
			const creditAmount = 200n * 10n ** 18n
			const { parts, requestId, partsHash } = await acceptStandard(fixture, { withdrawAmount })
			const { offerData } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount,
				partsHash,
			})
			const timestamp = BigInt((await ethers.provider.getBlock("latest"))!.timestamp)
			const { encoded: creditDataRaw } = await buildSignedExpressCreditData({
				appId: 1n,
				affiliate,
				eligibleBase: 10_000n * 10n ** 18n,
				timestamp,
				chainId: (await ethers.provider.getNetwork()).chainId,
				expressProvider: await expressProvider.getAddress(),
				symmio: context.diamond,
				muonKey,
				gatewaySigner,
			})

			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWith("MuonSignatureVerifier: Key not authorized for function")

			await realVerifier.setPublicKeyPermissions(muonKey.publicKey, [EXPRESS_CREDIT_MUON_FUNCTION], true)
			await realVerifier.setGatewaySignerPermissions(gatewaySigner.address, [EXPRESS_CREDIT_MUON_FUNCTION], false)
			await realVerifier.setGatewaySignerPermissions(gatewaySigner.address, [0], true)
			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWith("MuonSignatureVerifier: Gateway not authorized for function")

			await realVerifier.setGatewaySignerPermissions(gatewaySigner.address, [EXPRESS_CREDIT_MUON_FUNCTION], true)
			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw)
			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(STATUS_PROCESSED)
			expect(await expressProvider.creditLineActiveDebt(affiliate)).to.equal(creditAmount)
		})

		it("accelerates STANDARD → WINDOWED: random caller submits bot-signed offer, user paid", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, affiliate, randomCaller, receiver, collateral } = fixture

			const withdrawAmount = 500n * 10n ** 18n
			const creditAmount = 200n * 10n ** 18n
			const affiliateAmount = 50n * 10n ** 18n

			const { parts, requestId, partsHash } = await acceptStandard(fixture, { withdrawAmount })

			// Pool balances before acceleration
			const generalBefore = await expressProvider.generalBalance()
			const affiliateBefore = await expressProvider.affiliateBalances(affiliate)
			const receiverBefore = await collateral.balanceOf(receiver.address)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount,
				creditAmount,
				partsHash,
			})

			const tx = await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw)
			const receipt = await tx.wait()

			// Events
			const accelEvent = receipt!.logs.find((l: any) => {
				try {
					return expressProvider.interface.parseLog(l)?.name === "WithdrawAccelerated"
				} catch {
					return false
				}
			})
			expect(accelEvent).to.not.be.undefined

			const procEvent = receipt!.logs.find((l: any) => {
				try {
					return expressProvider.interface.parseLog(l)?.name === "WithdrawProcessed"
				} catch {
					return false
				}
			})
			expect(procEvent).to.not.be.undefined

			// Info mutated
			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(STATUS_PROCESSED)
			expect(info.optionType).to.equal(OPT_WINDOWED)
			expect(info.creditAmount).to.equal(creditAmount)
			expect(info.affiliateAmount).to.equal(affiliateAmount)
			expect(info.generalAmount).to.equal(withdrawAmount - creditAmount - affiliateAmount)
			expect(info.expressAmount).to.equal(withdrawAmount)

			// Pool deductions
			expect(await expressProvider.generalBalance()).to.equal(generalBefore - (withdrawAmount - creditAmount - affiliateAmount))
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateBefore - affiliateAmount)
			expect(await expressProvider.lockedGeneralBalance()).to.equal(0n)
			expect(await expressProvider.lockedAffiliateBalances(affiliate)).to.equal(0n)

			// Debt activated
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(0n)
			expect(await expressProvider.creditLineActiveDebt(affiliate)).to.equal(creditAmount)

			// User paid
			expect(await collateral.balanceOf(receiver.address)).to.equal(receiverBefore + withdrawAmount - DEFAULT_ACCELERATION_FEE)

			// Nonce bumped
			expect(await expressProvider.accelerateNonce(user.address, requestId)).to.equal(1n)
		})

		it("accelerates with creditAmount = expressAmount (all-credit, pools untouched)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, affiliate, randomCaller, receiver, collateral } = fixture

			const withdrawAmount = 500n * 10n ** 18n
			const { parts, requestId, partsHash } = await acceptStandard(fixture, { withdrawAmount })

			const generalBefore = await expressProvider.generalBalance()
			const affiliateBefore = await expressProvider.affiliateBalances(affiliate)
			const receiverBefore = await collateral.balanceOf(receiver.address)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: withdrawAmount,
				partsHash,
			})

			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw)

			// Pools untouched
			expect(await expressProvider.generalBalance()).to.equal(generalBefore)
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateBefore)
			// Credit carries the whole request
			expect(await expressProvider.creditLineActiveDebt(affiliate)).to.equal(withdrawAmount)
			// User paid
			expect(await collateral.balanceOf(receiver.address)).to.equal(receiverBefore + withdrawAmount - DEFAULT_ACCELERATION_FEE)
		})

		it("accelerates with creditAmount = 0 (pool-only, no credit)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, affiliate, randomCaller, receiver, collateral } = fixture

			const withdrawAmount = 500n * 10n ** 18n
			const affiliateAmount = 100n * 10n ** 18n
			const { parts, requestId, partsHash } = await acceptStandard(fixture, { withdrawAmount })

			const receiverBefore = await collateral.balanceOf(receiver.address)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount,
				creditAmount: 0n,
				partsHash,
			})

			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw)

			// No credit touched
			expect(await expressProvider.creditLineActiveDebt(affiliate)).to.equal(0n)
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(0n)
			// User paid
			expect(await collateral.balanceOf(receiver.address)).to.equal(receiverBefore + withdrawAmount - DEFAULT_ACCELERATION_FEE)
		})

		it("accelerates with affiliateAmount = 0 AND creditAmount = 0 (all general)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, affiliate, randomCaller, receiver, collateral, generalFunding } = fixture

			const withdrawAmount = 500n * 10n ** 18n
			const { parts, requestId, partsHash } = await acceptStandard(fixture, { withdrawAmount })

			const receiverBefore = await collateral.balanceOf(receiver.address)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 0n,
				partsHash,
			})

			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(STATUS_PROCESSED)
			expect(info.optionType).to.equal(OPT_WINDOWED)
			expect(info.generalAmount).to.equal(withdrawAmount)
			expect(info.affiliateAmount).to.equal(0n)
			expect(info.creditAmount).to.equal(0n)

			expect(await expressProvider.generalBalance()).to.equal(generalFunding - withdrawAmount)
			expect(await expressProvider.lockedGeneralBalance()).to.equal(0n)
			// Credit & affiliate pool untouched
			expect(await expressProvider.creditLineActiveDebt(affiliate)).to.equal(0n)
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(0n)
			// User paid
			expect(await collateral.balanceOf(receiver.address)).to.equal(receiverBefore + withdrawAmount - DEFAULT_ACCELERATION_FEE)
		})

		it("accelerate callable by user themselves (permissionless)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, receiver, collateral } = fixture

			const withdrawAmount = 500n * 10n ** 18n
			const { parts, requestId, partsHash } = await acceptStandard(fixture, { withdrawAmount })

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 200n * 10n ** 18n,
				partsHash,
			})

			const before = await collateral.balanceOf(receiver.address)
			await expressProvider.connect(user).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw)
			expect(await collateral.balanceOf(receiver.address)).to.equal(before + withdrawAmount - DEFAULT_ACCELERATION_FEE)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                        CAP / RETRY BEHAVIOR
	// ═══════════════════════════════════════════════════════════════════

	describe("Cap Retry Behavior", function () {
		it("reverts DebtExceedsAbsoluteCap when cap is full; STANDARD state untouched", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, affiliate, randomCaller } = fixture

			// Set hard cap at 300
			await expressProvider.setCreditLineProtocolConfig(affiliate, 300n * 10n ** 18n, 0n)

			const withdrawAmount = 500n * 10n ** 18n
			const { parts, requestId, partsHash } = await acceptStandard(fixture, { withdrawAmount })

			// Try to accelerate with creditAmount = 400 > 300
			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 400n * 10n ** 18n,
				partsHash,
			})

			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "DebtExceedsAbsoluteCap")

			// State unchanged
			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(STATUS_ACCEPTED)
			expect(info.optionType).to.equal(OPT_STANDARD)
			expect(await expressProvider.accelerateNonce(user.address, requestId)).to.equal(0n)
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(0n)
			expect(await expressProvider.lockedGeneralBalance()).to.equal(0n)
		})

		it("reverts DebtExceedsPercentCap when bps cap is exceeded", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, affiliate, randomCaller } = fixture

			// bps cap = 100 (1%), eligibleBase in buildCreditData = 10_000 * 1e18
			// → effective bps cap = 10_000e18 * 100 / 10_000 = 100e18
			await expressProvider.setCreditLineProtocolConfig(affiliate, 0n, 100n)

			const withdrawAmount = 500n * 10n ** 18n
			const { parts, requestId, partsHash } = await acceptStandard(fixture, { withdrawAmount })

			// creditAmount = 200e18 > bps cap (100e18)
			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 200n * 10n ** 18n,
				partsHash,
			})
			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "DebtExceedsPercentCap")
		})

		it("succeeds after cap is widened (simulates frontend raising affiliateMaxDebt)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, affiliate, randomCaller } = fixture

			await expressProvider.setCreditLineProtocolConfig(affiliate, 1000n * 10n ** 18n, 0n)
			await expressProvider.setCreditLineAffiliateConfig(affiliate, 100n * 10n ** 18n, 0n)

			const withdrawAmount = 500n * 10n ** 18n
			const { parts, requestId, partsHash } = await acceptStandard(fixture, { withdrawAmount })

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 300n * 10n ** 18n,
				partsHash,
			})

			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "DebtExceedsAbsoluteCap")

			// Frontend raises affiliate cap
			await expressProvider.setCreditLineAffiliateConfig(affiliate, 500n * 10n ** 18n, 0n)

			// Same signature now succeeds (nonce was not bumped)
			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(STATUS_PROCESSED)
			expect(await expressProvider.creditLineActiveDebt(affiliate)).to.equal(300n * 10n ** 18n)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                            TIMING
	// ═══════════════════════════════════════════════════════════════════

	describe("Timing Guards", function () {
		it("reverts AccelerateCooldownElapsed once core cooldown has passed", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, randomCaller } = fixture

			const { parts, requestId, partsHash } = await acceptStandard(fixture)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
				deadlineOffset: 13 * 3600,
			})

			// Advance past cooldownEndTime
			await ethers.provider.send("evm_increaseTime", [12 * 3600 + 1])
			await ethers.provider.send("evm_mine", [])

			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "AccelerateCooldownElapsed")
		})

		it("reverts AccelerateOfferExpired when offer deadline has passed", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, randomCaller } = fixture

			const { parts, requestId, partsHash } = await acceptStandard(fixture)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
				deadlineOffset: 60,
			})

			// Advance past offer deadline but still within cooldown
			await ethers.provider.send("evm_increaseTime", [120])
			await ethers.provider.send("evm_mine", [])

			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "AccelerateOfferExpired")
		})

		it("reverts AccelerateCooldownElapsed at the exact cooldownEndTime boundary (>= check)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, randomCaller } = fixture

			const { parts, requestId, partsHash } = await acceptStandard(fixture)
			const info = await expressProvider.getWithdrawInfo(user.address, requestId)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 0n,
				partsHash,
				deadlineOffset: 13 * 3600,
			})

			await ethers.provider.send("evm_setNextBlockTimestamp", [Number(info.cooldownEndTime)])

			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "AccelerateCooldownElapsed")
		})

		it("succeeds at cooldownEndTime - 1 (just under the boundary)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, randomCaller } = fixture

			const { parts, requestId, partsHash } = await acceptStandard(fixture)
			const info = await expressProvider.getWithdrawInfo(user.address, requestId)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 0n,
				partsHash,
				deadlineOffset: 13 * 3600,
			})

			await ethers.provider.send("evm_setNextBlockTimestamp", [Number(info.cooldownEndTime) - 1])
			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw)

			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(STATUS_PROCESSED)
		})

		it("succeeds when offer.deadline == block.timestamp (strict > check)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, botSigner, user, randomCaller } = fixture

			const { parts, requestId, partsHash } = await acceptStandard(fixture)

			const nextTs = (await ethers.provider.getBlock("latest"))!.timestamp + 30
			const sig = await signAccelerateOffer(expressProvider, botSigner, {
				user: user.address,
				requestId,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				accelerationFee: DEFAULT_ACCELERATION_FEE,
				partsHash,
				deadline: nextTs,
			})
			const offerData = encodeAccelerateOfferData(0n, 0n, 100n * 10n ** 18n, DEFAULT_ACCELERATION_FEE, nextTs, sig)
			const creditDataRaw = buildCreditData(10_000n * 10n ** 18n, nextTs)

			await ethers.provider.send("evm_setNextBlockTimestamp", [nextTs])
			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw)

			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(STATUS_PROCESSED)
		})

		it("rejects after core finalization (status check fires first)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user, randomCaller } = fixture

			const { parts, requestId, partsHash } = await acceptStandard(fixture)

			// Advance past cooldown and finalize on core; SymmioHookFacet flips status → FINALIZED
			await ethers.provider.send("evm_increaseTime", [12 * 3600 + 1])
			await ethers.provider.send("evm_mine", [])
			await context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
			})

			// After finalize the status is FINALIZED, so the first precondition fires.
			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "AccelerateOnlyFromStandardAccepted")
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                     SIGNATURE / REPLAY GUARDS
	// ═══════════════════════════════════════════════════════════════════

	describe("Signature and Replay Guards", function () {
		it("reverts InvalidAccelerateSigner when signer lacks SIGNER_ROLE", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, deployer, randomCaller } = fixture

			const { parts, requestId, partsHash } = await acceptStandard(fixture)

			// Sign with deployer (no SIGNER_ROLE)
			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
				signer: deployer,
			})

			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "InvalidAccelerateSigner")
		})

		it("reverts InvalidAccelerateNonce on replay after successful acceleration", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, randomCaller } = fixture

			const { parts, requestId, partsHash } = await acceptStandard(fixture)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
			})

			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw)

			// Replay — status is no longer ACCEPTED, so preconditions fail first
			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "AccelerateOnlyFromStandardAccepted")
		})

		it("reverts PartsMismatch when parts array doesn't match stored hash", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, randomCaller, receiver } = fixture
			const expressAddr = await expressProvider.getAddress()

			const { parts, requestId, partsHash } = await acceptStandard(fixture)

			// Tamper parts
			const badParts = [
				{
					id: 0n,
					amount: 999n * 10n ** 18n,
					chainId: 31337n,
					receiver: receiver.address,
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressAddr,
				},
			]

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
			})

			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, badParts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "PartsMismatch")
		})

		it("reverts InvalidAccelerateNonce when the offer uses a stale nonce", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, randomCaller } = fixture

			const { parts, requestId, partsHash } = await acceptStandard(fixture)

			// Sign with nonce = 5 (stale — chain is at 0)
			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 5n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
			})

			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "InvalidAccelerateNonce")
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                         WRONG STATE
	// ═══════════════════════════════════════════════════════════════════

	describe("Wrong-State Guards", function () {
		it("reverts AccelerateOnlyFromStandardAccepted when target is WINDOWED", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, randomCaller } = fixture

			const { parts, requestId } = await acceptWindowedWithCredit(fixture, {
				withdrawAmount: 500n * 10n ** 18n,
				creditAmount: 100n * 10n ** 18n,
			})

			const partsHash = computePartsHash(parts)
			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 50n * 10n ** 18n,
				partsHash,
			})

			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "AccelerateOnlyFromStandardAccepted")
		})

		it("reverts AccelerateOnlyFromStandardAccepted when target is LOCKED", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, randomCaller, locker } = fixture

			const { parts, requestId, partsHash } = await acceptStandard(fixture)
			await expressProvider.connect(locker).lockWithdraw(user.address, requestId)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
			})

			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "AccelerateOnlyFromStandardAccepted")
		})

		it("reverts AccelerateOnlyFromStandardAccepted when target is PROCESSED (post-acceleration replay)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, randomCaller } = fixture

			const { parts, requestId, partsHash } = await acceptStandard(fixture)

			const first = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
			})
			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, first.offerData, "0x", first.creditDataRaw)

			const second = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 1n,
				affiliateAmount: 0n,
				creditAmount: 50n * 10n ** 18n,
				partsHash,
			})
			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, second.offerData, "0x", second.creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "AccelerateOnlyFromStandardAccepted")
		})

		it("reverts AccelerateOnlyFromStandardAccepted when target is CANCELLED", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, context, randomCaller } = fixture

			const { parts, requestId, partsHash } = await acceptStandard(fixture)
			await context.withdrawFacet.connect(user).requestCancelWithdraw(requestId)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
			})
			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "AccelerateOnlyFromStandardAccepted")
		})

		it("reverts AccelerateOnlyFromStandardAccepted when target is SUSPENDED", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, context, randomCaller } = fixture

			const { parts, requestId, partsHash } = await acceptStandard(fixture)
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
			await context.withdrawFacet.connect(context.signers.admin).suspendWithdrawRequest(user.address, requestId)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
			})
			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "AccelerateOnlyFromStandardAccepted")
		})

		it("reverts FundingSplitExceedsExpress when affiliate + credit > expressAmount", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, randomCaller } = fixture

			const withdrawAmount = 500n * 10n ** 18n
			const { parts, requestId, partsHash } = await acceptStandard(fixture, { withdrawAmount })

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 300n * 10n ** 18n,
				creditAmount: 300n * 10n ** 18n,
				partsHash,
			})

			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "FundingSplitExceedsExpress")
		})

		it("succeeds when affiliateAmount + creditAmount == expressAmount (exact boundary)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, randomCaller, affiliate } = fixture

			const withdrawAmount = 500n * 10n ** 18n
			const { parts, requestId, partsHash } = await acceptStandard(fixture, { withdrawAmount })

			const affiliateAmount = 200n * 10n ** 18n
			const creditAmount = withdrawAmount - affiliateAmount // exactly fills expressAmount

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount,
				creditAmount,
				partsHash,
			})

			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(STATUS_PROCESSED)
			expect(info.generalAmount).to.equal(0n)
			expect(info.affiliateAmount).to.equal(affiliateAmount)
			expect(info.creditAmount).to.equal(creditAmount)
			expect(await expressProvider.creditLineActiveDebt(affiliate)).to.equal(creditAmount)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                         POOL FUNDING
	// ═══════════════════════════════════════════════════════════════════

	describe("Pool Funding Guards", function () {
		it("reverts InsufficientGeneralBalance when general pool lacks capacity", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, affiliate, randomCaller, deployer, generalFunding } = fixture

			const WITHDRAWER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("WITHDRAWER_ROLE"))
			await expressProvider.connect(deployer).grantRole(WITHDRAWER_ROLE, deployer.address)

			const withdrawAmount = 500n * 10n ** 18n
			const drain = generalFunding - (withdrawAmount - 1n)
			await expressProvider.connect(deployer).withdrawFromGeneral(drain)

			const { parts, requestId, partsHash } = await acceptStandard(fixture, { withdrawAmount })

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 0n,
				partsHash,
			})

			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "InsufficientGeneralBalance")

			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(STATUS_ACCEPTED)
			expect(await expressProvider.accelerateNonce(user.address, requestId)).to.equal(0n)
		})

		it("reverts InsufficientAffiliateBalance when affiliate pool is drained", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, affiliate, randomCaller, deployer } = fixture

			// Drain affiliate pool (5000 funded, leave only 10)
			const WITHDRAWER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("WITHDRAWER_ROLE"))
			await expressProvider.connect(deployer).grantRole(WITHDRAWER_ROLE, deployer.address)
			await expressProvider.connect(deployer).withdrawFromAffiliate(affiliate, 4990n * 10n ** 18n)

			const withdrawAmount = 500n * 10n ** 18n
			const { parts, requestId, partsHash } = await acceptStandard(fixture, { withdrawAmount })

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 100n * 10n ** 18n,
				creditAmount: 0n,
				partsHash,
			})

			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "InsufficientAffiliateBalance")
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                  POST-ACCELERATION LIFECYCLE PARITY
	// ═══════════════════════════════════════════════════════════════════

	describe("Post-Acceleration Lifecycle", function () {
		it("on core finalization: settles credit and credits pools back (parity with native WINDOWED)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user, affiliate, randomCaller } = fixture

			const withdrawAmount = 500n * 10n ** 18n
			const creditAmount = 200n * 10n ** 18n
			const { parts, requestId, partsHash } = await acceptStandard(fixture, { withdrawAmount })

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount,
				partsHash,
			})

			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw)

			const generalAfterAccel = await expressProvider.generalBalance()

			// Advance past cooldown and finalize via core → onWithdrawComplete runs WINDOWED branch
			await ethers.provider.send("evm_increaseTime", [12 * 3600 + 1])
			await ethers.provider.send("evm_mine", [])
			await context.withdrawFacet.finalizeWithdrawRequest(user.address, requestId)

			const info = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(info.status).to.equal(STATUS_FINALIZED)

			// Credit settled
			expect(await expressProvider.creditLineTotalDebt(affiliate)).to.equal(0n)

			// General pool credited back (generalAmount returned from core, minus the creditAmount which core withheld)
			const expectedReimbursement = withdrawAmount - creditAmount
			expect(await expressProvider.generalBalance()).to.equal(generalAfterAccel + expectedReimbursement)
		})

		it("charges the bot-signed acceleration fee when STANDARD is accelerated", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, requestId: _unused, randomCaller, receiver, collateral } = fixture as any
			void _unused

			const maxAccelerationFee = 7n * 10n ** 18n
			const accelerationFee = 3n * 10n ** 18n
			const { parts, requestId, partsHash, withdrawAmount } = await acceptStandard(fixture, {
				maxAccelerationFee,
			})

			const infoBefore = await expressProvider.getWithdrawInfo(user.address, requestId)
			const receiverBefore = await collateral.balanceOf(receiver.address)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				accelerationFee,
				partsHash,
			})

			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw)

			const infoAfter = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(infoAfter.fee).to.equal(infoBefore.fee)
			expect(infoAfter.accelerationFee).to.equal(accelerationFee)
			expect(infoAfter.expressAmount).to.equal(infoBefore.expressAmount)
			expect(infoAfter.cooldownEndTime).to.equal(infoBefore.cooldownEndTime)
			expect(infoAfter.acceptedAt).to.equal(infoBefore.acceptedAt)
			expect(infoAfter.partsHash).to.equal(infoBefore.partsHash)
			expect(await expressProvider.pendingFees(user.address, requestId)).to.equal(accelerationFee)
			expect(await collateral.balanceOf(receiver.address)).to.equal(receiverBefore + withdrawAmount - accelerationFee)
		})

		it("reverts when acceleration fee exceeds the user's STANDARD authorization", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, randomCaller } = fixture

			const { parts, requestId, partsHash } = await acceptStandard(fixture, {
				maxAccelerationFee: 5n * 10n ** 18n,
			})

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				accelerationFee: 6n * 10n ** 18n,
				partsHash,
			})

			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "AccelerationFeeExceedsMaximum")
		})

		it("allows zero-fee acceleration when the bot signs zero and the user authorized zero max acceleration fee", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, randomCaller, receiver, collateral } = fixture

			const { parts, requestId, partsHash, withdrawAmount } = await acceptStandard(fixture, {
				maxAccelerationFee: 0n,
			})
			const receiverBefore = await collateral.balanceOf(receiver.address)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 0n,
				accelerationFee: 0n,
				partsHash,
			})

			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw)

			const infoAfter = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(infoAfter.status).to.equal(STATUS_PROCESSED)
			expect(infoAfter.accelerationFee).to.equal(0n)
			expect(await expressProvider.pendingFees(user.address, requestId)).to.equal(0n)
			expect(await collateral.balanceOf(receiver.address)).to.equal(receiverBefore + withdrawAmount)
		})

		it("rejects a STANDARD option whose base fees plus max acceleration fee exceed the express amount", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliate, deployer } = fixture

			const withdrawAmount = 100n * 10n ** 18n
			const fee = 80n * 10n ** 18n
			const operatorFee = 10n * 10n ** 18n
			await expressProvider.connect(deployer).setAffiliateConfig(affiliate, 8000, operatorFee)

			await expect(
				acceptStandard(fixture, {
					withdrawAmount,
					fee,
					operatorFee,
					maxAccelerationFee: 20n * 10n ** 18n,
				}),
			).to.be.revertedWithCustomError(expressProvider, "FeesExceedExpressAmount")
		})

		it("rejects an impossible operator fee envelope", async function () {
			const fixture = await deployFixture()
			const { expressProvider, affiliate, deployer } = fixture

			const withdrawAmount = 100n * 10n ** 18n
			const operatorFee = ethers.MaxUint256
			await expressProvider.connect(deployer).setAffiliateConfig(affiliate, 0, operatorFee)

			await expect(
				acceptStandard(fixture, {
					withdrawAmount,
					operatorFee,
					maxAccelerationFee: 0n,
				}),
			).to.be.revertedWithCustomError(expressProvider, "FeesExceedExpressAmount")
		})

		it("binds accelerationFee into the accelerate offer signature", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, randomCaller, botSigner } = fixture

			const { parts, requestId, partsHash } = await acceptStandard(fixture, {
				maxAccelerationFee: 10n * 10n ** 18n,
			})
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const deadline = now + 3600
			const signedFee = 3n * 10n ** 18n
			const tamperedFee = 4n * 10n ** 18n
			const signature = await signAccelerateOffer(expressProvider, botSigner, {
				user: user.address,
				requestId,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 0n,
				accelerationFee: signedFee,
				partsHash,
				deadline,
			})
			const offerData = encodeAccelerateOfferData(0n, 0n, 0n, tamperedFee, deadline, signature)

			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", "0x"),
			).to.be.revertedWithCustomError(expressProvider, "InvalidAccelerateSigner")
		})

		it("binds maxAccelerationFee into the initial withdraw option signature", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, receiver, context, affiliate, botSigner } = fixture

			await triggerRecentDeallocate(fixture)
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
			const deadline = now + 24 * 3600
			const nonce = await expressProvider.nonces(user.address)
			const signedMaxAccelerationFee = 5n * 10n ** 18n
			const tamperedMaxAccelerationFee = 6n * 10n ** 18n
			const signature = await signWithdrawOption(expressProvider, botSigner, {
				user: user.address,
				nonce,
				optionType: 2,
				affiliate,
				affiliateAmount: 0n,
				creditAmount: 0n,
				fee: 0n,
				operatorFee: 0n,
				maxUserFee: 0n,
				maxAccelerationFee: signedMaxAccelerationFee,
				partsHash,
				deadline,
			})
			const providerData = encodeWithdrawProviderData(nonce, 2, affiliate, 0n, 0n, deadline, signature, undefined, tamperedMaxAccelerationFee)

			await expect(context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)).to.be.revertedWithCustomError(
				expressProvider,
				"InvalidSigner",
			)
		})

		it("main offer nonce (g.nonces[user]) is not touched by acceleration", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, randomCaller } = fixture

			const { parts, requestId, partsHash } = await acceptStandard(fixture)
			const mainNonceBefore = await expressProvider.nonces(user.address)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
			})

			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw)

			expect(await expressProvider.nonces(user.address)).to.equal(mainNonceBefore)
			expect(await expressProvider.accelerateNonce(user.address, requestId)).to.equal(1n)
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                        VALIDATOR GATING
	// ═══════════════════════════════════════════════════════════════════

	describe("Validator Gating", function () {
		async function signValidatorAccelerateApproval(
			expressProvider: any,
			validator: any,
			params: { user: string; requestId: bigint; partsHash: string; timestamp: number; symmio: string },
		) {
			const domain = { name: "ExpressProvider", version: "1", chainId: 31337, verifyingContract: await expressProvider.getAddress() }
			const types = {
				ValidatorAccelerateApproval: [
					{ name: "user", type: "address" },
					{ name: "requestId", type: "uint256" },
					{ name: "partsHash", type: "bytes32" },
					{ name: "timestamp", type: "uint256" },
					{ name: "symmio", type: "address" },
				],
			}
			return validator.signTypedData(domain, types, params)
		}

		function encodeValidatorData(signatures: string[], timestamps: number[]): string {
			return ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]", "uint256[]"], [signatures, timestamps])
		}

		it("accelerates with a valid validator quorum when minValidatorSignatures > 0", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user, affiliate, randomCaller } = fixture

			const validator1 = (await ethers.getSigners())[6]
			await expressProvider.setValidator(affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(affiliate, 1)

			const { parts, requestId, partsHash } = await acceptStandard(fixture)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
			})

			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const valSig = await signValidatorAccelerateApproval(expressProvider, validator1, {
				user: user.address,
				requestId,
				partsHash,
				timestamp: now,
				symmio: context.diamond,
			})

			await expressProvider
				.connect(randomCaller)
				.accelerateWithdraw(user.address, requestId, parts, offerData, encodeValidatorData([valSig], [now]), creditDataRaw)

			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(STATUS_PROCESSED)
		})

		it("rejects acceleration without validator signatures when minValidatorSignatures > 0", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, affiliate, randomCaller } = fixture

			const validator1 = (await ethers.getSigners())[6]
			await expressProvider.setValidator(affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(affiliate, 1)

			const { parts, requestId, partsHash } = await acceptStandard(fixture)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
			})

			await expect(
				expressProvider
					.connect(randomCaller)
					.accelerateWithdraw(user.address, requestId, parts, offerData, encodeValidatorData([], []), creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "InsufficientValidatorSignatures")
		})

		it("rejects approvals signed before a later balance credit (StaleValidatorApproval)", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user, affiliate, randomCaller } = fixture

			const validator1 = (await ethers.getSigners())[6]
			await expressProvider.setValidator(affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(affiliate, 1)

			const { parts, requestId, partsHash } = await acceptStandard(fixture)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
			})

			// Validator attests to the current state ...
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const valSig = await signValidatorAccelerateApproval(expressProvider, validator1, {
				user: user.address,
				requestId,
				partsHash,
				timestamp: now,
				symmio: context.diamond,
			})

			// ... then PnL lands in the withdrawable balance before the permissionless accelerate tx.
			// The advance must not go out against a state no validator ever saw.
			await context.accountFacet.connect(user).allocate(1n)
			await context.accountFacet.connect(user).zeroUpnlDeallocate(1n)

			await expect(
				expressProvider
					.connect(randomCaller)
					.accelerateWithdraw(user.address, requestId, parts, offerData, encodeValidatorData([valSig], [now]), creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "StaleValidatorApproval")
		})

		it("rejects expired validator approvals on acceleration", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user, affiliate, randomCaller } = fixture

			const validator1 = (await ethers.getSigners())[6]
			await expressProvider.setValidator(affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(affiliate, 1)

			const { parts, requestId, partsHash } = await acceptStandard(fixture)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
			})

			// Default validatorApprovalTimeout = 30s — sign 60s in the past
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const expiredTs = now - 60
			const valSig = await signValidatorAccelerateApproval(expressProvider, validator1, {
				user: user.address,
				requestId,
				partsHash,
				timestamp: expiredTs,
				symmio: context.diamond,
			})

			await expect(
				expressProvider
					.connect(randomCaller)
					.accelerateWithdraw(user.address, requestId, parts, offerData, encodeValidatorData([valSig], [expiredTs]), creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "ValidatorApprovalExpired")
		})

		it("rejects approvals signed by a non-validator", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user, affiliate, randomCaller } = fixture

			const signers = await ethers.getSigners()
			const validator1 = signers[6]
			const intruder = signers[7]
			await expressProvider.setValidator(affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(affiliate, 1)

			const { parts, requestId, partsHash } = await acceptStandard(fixture)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
			})

			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const valSig = await signValidatorAccelerateApproval(expressProvider, intruder, {
				user: user.address,
				requestId,
				partsHash,
				timestamp: now,
				symmio: context.diamond,
			})

			await expect(
				expressProvider
					.connect(randomCaller)
					.accelerateWithdraw(user.address, requestId, parts, offerData, encodeValidatorData([valSig], [now]), creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "InvalidValidator")
		})

		it("rejects approvals bound to a different requestId", async function () {
			const fixture = await deployFixture()
			const { expressProvider, context, user, affiliate, randomCaller } = fixture

			const validator1 = (await ethers.getSigners())[6]
			await expressProvider.setValidator(affiliate, validator1.address, true)
			await expressProvider.setMinValidatorSignatures(affiliate, 1)

			const { parts, requestId, partsHash } = await acceptStandard(fixture)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
			})

			// Signed over requestId + 1 — recovers to a different signer on-chain
			const now = (await ethers.provider.getBlock("latest"))!.timestamp
			const valSig = await signValidatorAccelerateApproval(expressProvider, validator1, {
				user: user.address,
				requestId: requestId + 1n,
				partsHash,
				timestamp: now,
				symmio: context.diamond,
			})

			await expect(
				expressProvider
					.connect(randomCaller)
					.accelerateWithdraw(user.address, requestId, parts, offerData, encodeValidatorData([valSig], [now]), creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "InvalidValidator")
		})

		it("does not require validator signatures when minValidatorSignatures = 0", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, randomCaller } = fixture

			const { parts, requestId, partsHash } = await acceptStandard(fixture)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
			})

			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, "0x", creditDataRaw)

			expect((await expressProvider.getWithdrawInfo(user.address, requestId)).status).to.equal(STATUS_PROCESSED)
		})
	})
}
