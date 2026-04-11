import { expect } from "chai"

import { deployExpressProvider } from "../tasks/deploy/expressWithdrawLayerDiamond.js"
import { initializeFixture } from "./Initialize.fixture.js"
import connection, { ethers, hre } from "./helpers/hardhat-connection.js"
import { RunContext } from "./models/RunContext.js"

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
const OPT_IMMEDIATE = 0n
const OPT_INSTANT = 1n
const OPT_STANDARD = 2n

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
			partsHash: string
			deadline: number
		},
	) {
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
			availableAt: 0,
			affiliate: params.affiliate,
			affiliateAmount: params.affiliateAmount,
			creditAmount: params.creditAmount,
			fee: 0n,
			operatorFee: 0n,
			maxUserFee: 0n,
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
	): string {
		const offerData = ethers.AbiCoder.defaultAbiCoder().encode(
			["uint256", "uint8", "uint256", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "bytes"],
			[nonce, optionType, 0n, affiliate, affiliateAmount, creditAmount, 0n, 0n, 0n, deadline, signature],
		)
		const validatorData = ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]", "uint256[]", "uint256"], [[], [], 0])
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
			partsHash: string
			deadline: number
		},
	) {
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
				{ name: "partsHash", type: "bytes32" },
				{ name: "deadline", type: "uint256" },
			],
		}
		return signer.signTypedData(domain, types, params)
	}

	function encodeAccelerateOfferData(nonce: bigint, affiliateAmount: bigint, creditAmount: bigint, deadline: number, signature: string): string {
		return ethers.AbiCoder.defaultAbiCoder().encode(
			["tuple(uint256 nonce, uint256 affiliateAmount, uint256 creditAmount, uint256 deadline, bytes signature)"],
			[{ nonce, affiliateAmount, creditAmount, deadline, signature }],
		)
	}

	// Bump the user's core deallocate timestamp to now so cooldownEndTime = now + 12h.
	// Without this, cooldownEndTime = now (floor), and accelerate's timing guard fires immediately.
	async function triggerRecentDeallocate(fixture: any) {
		const { context, user, deployer } = fixture
		await context.controlFacet.connect(deployer).grantRole(user.address, ethers.keccak256(ethers.toUtf8Bytes("BALANCE_SETTLER_ROLE")))
		await context.accountFacet.connect(user).allocate(1n)
		await context.accountFacet.connect(user).zeroUpnlDeallocate(1n)
	}

	// Accept a STANDARD withdrawal — the precondition for acceleration.
	async function acceptStandard(fixture: any, opts?: { withdrawAmount?: bigint; skipDeallocate?: boolean }) {
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
			partsHash,
			deadline,
		})

		const providerData = encodeWithdrawProviderData(nonce, 2, affiliate, 0n, 0n, deadline, signature)
		await context.withdrawFacet.connect(user).initiateWithdraw(parts, false, providerData)

		const requestId: bigint = await context.viewFacet.getLastWithdrawRequestId(user.address)
		return { parts, requestId, withdrawAmount, partsHash }
	}

	// Accept an INSTANT withdrawal — used to pre-consume credit cap for retry tests.
	async function acceptInstantWithCredit(fixture: any, opts: { withdrawAmount: bigint; creditAmount: bigint }) {
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
			partsHash: opts.partsHash,
			deadline,
		})

		const offerData = encodeAccelerateOfferData(opts.nonce, opts.affiliateAmount, opts.creditAmount, deadline, sig)
		const creditDataRaw = opts.creditAmount > 0n ? buildCreditData(10_000n * 10n ** 18n, now) : "0x"

		return { offerData, creditDataRaw, deadline }
	}

	// ═══════════════════════════════════════════════════════════════════
	//                            HAPPY PATH
	// ═══════════════════════════════════════════════════════════════════

	describe("Happy Path", function () {
		it("accelerates STANDARD → INSTANT: random caller submits bot-signed offer, user paid", async function () {
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

			const tx = await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw)
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
			expect(info.optionType).to.equal(OPT_INSTANT)
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
			expect(await collateral.balanceOf(receiver.address)).to.equal(receiverBefore + withdrawAmount)

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

			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw)

			// Pools untouched
			expect(await expressProvider.generalBalance()).to.equal(generalBefore)
			expect(await expressProvider.affiliateBalances(affiliate)).to.equal(affiliateBefore)
			// Credit carries the whole request
			expect(await expressProvider.creditLineActiveDebt(affiliate)).to.equal(withdrawAmount)
			// User paid
			expect(await collateral.balanceOf(receiver.address)).to.equal(receiverBefore + withdrawAmount)
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

			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw)

			// No credit touched
			expect(await expressProvider.creditLineActiveDebt(affiliate)).to.equal(0n)
			expect(await expressProvider.creditLineReservedDebt(affiliate)).to.equal(0n)
			// User paid
			expect(await collateral.balanceOf(receiver.address)).to.equal(receiverBefore + withdrawAmount)
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
			await expressProvider.connect(user).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw)
			expect(await collateral.balanceOf(receiver.address)).to.equal(before + withdrawAmount)
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
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw),
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
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw),
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
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "DebtExceedsAbsoluteCap")

			// Frontend raises affiliate cap
			await expressProvider.setCreditLineAffiliateConfig(affiliate, 500n * 10n ** 18n, 0n)

			// Same signature now succeeds (nonce was not bumped)
			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw)

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
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw),
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
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "AccelerateOfferExpired")
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
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw),
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
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw),
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

			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw)

			// Replay — status is no longer ACCEPTED, so preconditions fail first
			await expect(
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw),
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
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, badParts, offerData, creditDataRaw),
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
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "InvalidAccelerateNonce")
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                         WRONG STATE
	// ═══════════════════════════════════════════════════════════════════

	describe("Wrong-State Guards", function () {
		it("reverts AccelerateOnlyFromStandardAccepted when target is INSTANT", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, randomCaller } = fixture

			const { parts, requestId } = await acceptInstantWithCredit(fixture, {
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
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw),
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
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw),
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
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "FundingSplitExceedsExpress")
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                         POOL FUNDING
	// ═══════════════════════════════════════════════════════════════════

	describe("Pool Funding Guards", function () {
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
				expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw),
			).to.be.revertedWithCustomError(expressProvider, "InsufficientAffiliateBalance")
		})
	})

	// ═══════════════════════════════════════════════════════════════════
	//                  POST-ACCELERATION LIFECYCLE PARITY
	// ═══════════════════════════════════════════════════════════════════

	describe("Post-Acceleration Lifecycle", function () {
		it("on core finalization: settles credit and credits pools back (parity with native INSTANT)", async function () {
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

			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw)

			const generalAfterAccel = await expressProvider.generalBalance()

			// Advance past cooldown and finalize via core → onWithdrawComplete runs INSTANT branch
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

		it("fee invariance: sponsorCoverage and info.fee preserved through acceleration", async function () {
			const fixture = await deployFixture()
			const { expressProvider, user, requestId: _unused, randomCaller } = fixture as any
			void _unused

			const { parts, requestId, partsHash } = await acceptStandard(fixture)

			const infoBefore = await expressProvider.getWithdrawInfo(user.address, requestId)

			const { offerData, creditDataRaw } = await buildAccelerateCall(fixture, {
				user: user.address,
				requestId,
				parts,
				nonce: 0n,
				affiliateAmount: 0n,
				creditAmount: 100n * 10n ** 18n,
				partsHash,
			})

			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw)

			const infoAfter = await expressProvider.getWithdrawInfo(user.address, requestId)
			expect(infoAfter.fee).to.equal(infoBefore.fee)
			expect(infoAfter.sponsorCoverage).to.equal(infoBefore.sponsorCoverage)
			expect(infoAfter.expressAmount).to.equal(infoBefore.expressAmount)
			expect(infoAfter.cooldownEndTime).to.equal(infoBefore.cooldownEndTime)
			expect(infoAfter.acceptedAt).to.equal(infoBefore.acceptedAt)
			expect(infoAfter.partsHash).to.equal(infoBefore.partsHash)
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

			await expressProvider.connect(randomCaller).accelerateWithdraw(user.address, requestId, parts, offerData, creditDataRaw)

			expect(await expressProvider.nonces(user.address)).to.equal(mainNonceBefore)
			expect(await expressProvider.accelerateNonce(user.address, requestId)).to.equal(1n)
		})
	})
}
