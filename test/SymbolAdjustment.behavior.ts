import { expect } from "chai"

import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { emergencyCloseRequestBuilder } from "./models/requestModels/EmergencyCloseRequest.js"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp } from "./utils/Common.js"
import { migratePartyBToCross } from "./utils/CrossPartyB.js"
import { getDummyPairUpnlSig } from "./utils/SignatureUtils.js"

export function shouldBehaveLikeSymbolAdjustment(): void {
	let context: RunContext
	const SYMBOL_ID = 1

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
	})

	describe("registry lifecycle", function () {
		it("should schedule an adjustment and freeze at effective time", async function () {
			const now = await getBlockTimestamp()
			await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now + 1000n))
				.to.emit(context.symbolAdjustmentFacet, "AdjustmentScheduled")
				.withArgs(SYMBOL_ID, 0, decimal(4n), now + 1000n)
			expect(await context.symbolAdjustmentFacet.isSymbolFrozen(SYMBOL_ID)).to.be.false
			await time.increase(1001)
			expect(await context.symbolAdjustmentFacet.isSymbolFrozen(SYMBOL_ID)).to.be.true
		})

		it("should freeze immediately for a past effective time", async function () {
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now - 10n)
			expect(await context.symbolAdjustmentFacet.isSymbolFrozen(SYMBOL_ID)).to.be.true
		})

		it("should confirm price adjustment, activate factor, and unfreeze", async function () {
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now)
			expect(await context.symbolAdjustmentFacet.getCumulativeFactor(SYMBOL_ID)).to.equal(decimal(1n))
			expect(await context.symbolAdjustmentFacet.getProspectiveCumulativeFactor(SYMBOL_ID)).to.equal(decimal(4n))
			await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID))
				.to.emit(context.symbolAdjustmentFacet, "PriceAdjustmentConfirmed")
				.withArgs(SYMBOL_ID, 0, decimal(4n))
			expect(await context.symbolAdjustmentFacet.isSymbolFrozen(SYMBOL_ID)).to.be.false
			expect(await context.symbolAdjustmentFacet.getCumulativeFactor(SYMBOL_ID)).to.equal(decimal(4n))
		})

		it("should compound cumulative factor across steps", async function () {
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(11n, 17), now)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)
			expect(await context.symbolAdjustmentFacet.getCumulativeFactor(SYMBOL_ID)).to.equal(decimal(44n, 17))
		})

		it("should cancel a scheduled step even after effective time (unfreezes)", async function () {
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now - 10n)
			expect(await context.symbolAdjustmentFacet.isSymbolFrozen(SYMBOL_ID)).to.be.true
			await context.symbolAdjustmentFacet.connect(context.signers.admin).cancelAdjustment(SYMBOL_ID)
			expect(await context.symbolAdjustmentFacet.isSymbolFrozen(SYMBOL_ID)).to.be.false
			expect(await context.symbolAdjustmentFacet.getCumulativeFactor(SYMBOL_ID)).to.equal(decimal(1n))
		})

		it("should reject a second in-flight step", async function () {
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now + 1000n)
			await expect(
				context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(2n), now + 2000n),
			).to.be.revertedWith("SymbolAdjustmentFacet: Adjustment already in flight")
		})

		it("should enforce factor bounds and reject 1e18", async function () {
			const now = await getBlockTimestamp()
			for (const factor of [0n, decimal(1n, 15), decimal(1n), decimal(101n)]) {
				await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, factor, now)).to.be.revertedWith(
					"SymbolAdjustmentFacet: Invalid factor",
				)
			}
		})

		it("should reject unknown symbol and missing role", async function () {
			const now = await getBlockTimestamp()
			await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(999, decimal(4n), now)).to.be.revertedWith(
				"SymbolAdjustmentFacet: Invalid symbolId",
			)
			await expect(context.symbolAdjustmentFacet.connect(context.signers.user).scheduleAdjustment(SYMBOL_ID, decimal(4n), now)).to.be.revertedWith(
				"Accessibility: Must have role",
			)
		})

		it("should not confirm before effective time", async function () {
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now + 1000n)
			await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)).to.be.revertedWith(
				"SymbolAdjustmentFacet: Not effective yet",
			)
		})

		it("should reject a confirm that would floor the cumulative factor to 0", async function () {
			// MIN_FACTOR (0.01x) is allowed per-step, but compounding it repeatedly underflows
			// the cumulative factor to 0 via integer division well before overflow limits kick in.
			// 1e18 * (0.01)^9 = 1 (wei-level); the 10th 0.01x step floors 1 -> 0.
			for (let i = 0; i < 9; i++) {
				const now = await getBlockTimestamp()
				await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(1n, 16), now)
				await context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)
			}
			expect(await context.symbolAdjustmentFacet.getCumulativeFactor(SYMBOL_ID)).to.equal(1n)

			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(1n, 16), now)
			await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)).to.be.revertedWith(
				"SymbolAdjustmentFacet: Cumulative factor underflow",
			)
		})
	})

	describe("freeze gates — trading", function () {
		let user: User, hedger: Hedger

		beforeEach(async function () {
			this.user_allocated = decimal(500n)
			this.hedger_allocated = decimal(4000n)

			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

			hedger = new Hedger(context, context.signers.hedger)
			await hedger.setup()
			await hedger.setBalances(this.hedger_allocated, this.hedger_allocated)
		})

		async function freezeSymbol(symbolId = SYMBOL_ID) {
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(symbolId, decimal(4n), now - 1n)
		}

		async function openPositionForUser(): Promise<bigint> {
			const quoteId = await user.sendQuote(limitQuoteRequestBuilder().build())
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)
			return quoteId
		}

		it("should allow sendQuote between scheduling and effective time, blocking only while frozen", async function () {
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now + 1000n)
			await user.sendQuote(limitQuoteRequestBuilder().build())
			await time.increase(1001)
			await expect(user.sendQuote(limitQuoteRequestBuilder().build())).to.be.revertedWith("LibSymbolAdjustment: Symbol is frozen")
			await context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)
			await user.sendQuote(limitQuoteRequestBuilder().build())
		})

		it("should block open fill while frozen", async function () {
			const quoteId = await user.sendQuote(limitQuoteRequestBuilder().build())
			await hedger.lockQuote(quoteId)
			await freezeSymbol()
			await expect(hedger.openPosition(quoteId)).to.be.revertedWith("LibSymbolAdjustment: Symbol is frozen")
		})

		it("should block close fill while frozen", async function () {
			const quoteId = await openPositionForUser()
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().build())
			await freezeSymbol()
			await expect(hedger.fillCloseRequest(quoteId, limitFillCloseRequestBuilder().build())).to.be.revertedWith(
				"LibSymbolAdjustment: Symbol is frozen",
			)
		})

		it("should block emergency close while frozen", async function () {
			const quoteId = await openPositionForUser()
			await context.symbolControlFacet.connect(context.signers.admin).setSymbolValidationState(SYMBOL_ID, false)
			await freezeSymbol()
			await expect(hedger.emergencyClosePosition(quoteId, emergencyCloseRequestBuilder().build())).to.be.revertedWith(
				"LibSymbolAdjustment: Symbol is frozen",
			)
		})

		it("should unfreeze after confirmPriceAdjusted and allow close fill again", async function () {
			const quoteId = await openPositionForUser()
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().build())
			await freezeSymbol()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)
			await hedger.fillCloseRequest(quoteId, limitFillCloseRequestBuilder().build())
		})

		describe("cancelPendingQuotes", function () {
			it("should force-expire a pending quote on a frozen symbol and refund the trading fee", async function () {
				const quoteId = await user.sendQuote(limitQuoteRequestBuilder().build())
				const balanceBefore = (await user.getBalanceInfo()).allocatedBalances
				await freezeSymbol()
				await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).cancelPendingQuotes([quoteId]))
					.to.emit(context.symbolAdjustmentFacet, "PendingQuoteCancelledByAdjustment")
					.withArgs(quoteId, SYMBOL_ID)
				expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(9) // EXPIRED
				expect((await user.getBalanceInfo()).allocatedBalances).to.be.gt(balanceBefore) // fee refunded + locks released
			})

			it("should refuse on an unfrozen symbol and on OPENED quotes", async function () {
				const pendingId = await user.sendQuote(limitQuoteRequestBuilder().build())
				await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).cancelPendingQuotes([pendingId])).to.be.revertedWith(
					"SymbolAdjustmentFacet: Symbol not frozen",
				)
				const openedId = await openPositionForUser()
				await freezeSymbol()
				await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).cancelPendingQuotes([openedId])).to.be.revertedWith(
					"SymbolAdjustmentFacet: Invalid quote state",
				)
			})
		})

		describe("freeze gates — funding", function () {
			it("should block chargeFundingRate while frozen", async function () {
				const quoteId = await openPositionForUser()
				await freezeSymbol()
				await expect(hedger.chargeFundingRate(await user.getAddress(), [quoteId], [decimal(1n, 16)], await getDummyPairUpnlSig())).to.be.revertedWith(
					"LibSymbolAdjustment: Symbol is frozen",
				)
			})

			it("should block setFundingFee for a frozen symbol", async function () {
				await context.pauseControlFacet.connect(context.signers.admin).activateAccumulatedFunding()
				await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([SYMBOL_ID], [28800])
				await freezeSymbol()
				await expect(
					context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([SYMBOL_ID], [decimal(1n, 16)], [decimal(1n, 16)], [decimal(1000n)]),
				).to.be.revertedWith("LibSymbolAdjustment: Symbol is frozen")
			})
		})
	})

	describe("restatement window", function () {
		it("should start directly from an effective scheduled adjustment without activating the trading factor", async function () {
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now)

			await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).startRestatement(SYMBOL_ID))
				.to.emit(context.symbolAdjustmentFacet, "RestatementStarted")
				.withArgs(SYMBOL_ID, 1, decimal(4n))

			const adjustment = await context.symbolAdjustmentFacet.getSymbolAdjustment(SYMBOL_ID)
			expect(adjustment.state).to.equal(1) // SCHEDULED: the Muon trading factor was never confirmed
			expect(adjustment.restatementFactor).to.equal(decimal(4n))
			expect(await context.symbolAdjustmentFacet.getCumulativeFactor(SYMBOL_ID)).to.equal(decimal(1n))
			expect(await context.symbolAdjustmentFacet.getProspectiveCumulativeFactor(SYMBOL_ID)).to.equal(decimal(4n))
			expect(await context.symbolAdjustmentFacet.isSymbolFrozen(SYMBOL_ID)).to.be.true

			await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)).to.be.revertedWith(
				"SymbolAdjustmentFacet: Restatement in progress",
			)
			await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).cancelAdjustment(SYMBOL_ID)).to.be.revertedWith(
				"SymbolAdjustmentFacet: Restatement in progress",
			)

			await context.symbolAdjustmentFacet.connect(context.signers.admin).finalizeRestatement(SYMBOL_ID)
			const finalized = await context.symbolAdjustmentFacet.getSymbolAdjustment(SYMBOL_ID)
			expect(finalized.state).to.equal(3) // APPLIED
			expect(finalized.restatementFactor).to.equal(0n)
			expect(await context.symbolAdjustmentFacet.getCumulativeFactor(SYMBOL_ID)).to.equal(decimal(1n))
			expect(await context.symbolAdjustmentFacet.isSymbolFrozen(SYMBOL_ID)).to.be.false
		})

		it("should not start direct restatement before the scheduled adjustment is effective", async function () {
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now + 1000n)
			await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).startRestatement(SYMBOL_ID)).to.be.revertedWith(
				"SymbolAdjustmentFacet: Not effective yet",
			)
		})

		it("should fold existing active factors and the scheduled factor into one direct restatement factor", async function () {
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(2n), now)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(3n), now)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).startRestatement(SYMBOL_ID)

			const adjustment = await context.symbolAdjustmentFacet.getSymbolAdjustment(SYMBOL_ID)
			expect(adjustment.restatementFactor).to.equal(decimal(6n))
			expect(await context.symbolAdjustmentFacet.getCumulativeFactor(SYMBOL_ID)).to.equal(decimal(2n))
			expect(await context.symbolAdjustmentFacet.getProspectiveCumulativeFactor(SYMBOL_ID)).to.equal(decimal(6n))
		})

		it("should abort a mutation-free direct window back to the scheduled freeze", async function () {
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).startRestatement(SYMBOL_ID)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).abortRestatement(SYMBOL_ID)

			const adjustment = await context.symbolAdjustmentFacet.getSymbolAdjustment(SYMBOL_ID)
			expect(adjustment.state).to.equal(1) // SCHEDULED
			expect(adjustment.restating).to.be.false
			expect(adjustment.restatementFactor).to.equal(0n)
			expect(await context.symbolAdjustmentFacet.getCumulativeFactor(SYMBOL_ID)).to.equal(decimal(1n))
			expect(await context.symbolAdjustmentFacet.isSymbolFrozen(SYMBOL_ID)).to.be.true

			await context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)
			expect(await context.symbolAdjustmentFacet.getCumulativeFactor(SYMBOL_ID)).to.equal(decimal(4n))
			expect(await context.symbolAdjustmentFacet.isSymbolFrozen(SYMBOL_ID)).to.be.false
		})

		it("should open and close a restatement window", async function () {
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)
			await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).startRestatement(SYMBOL_ID))
				.to.emit(context.symbolAdjustmentFacet, "RestatementStarted")
				.withArgs(SYMBOL_ID, 1, decimal(4n))
			expect(await context.symbolAdjustmentFacet.isSymbolFrozen(SYMBOL_ID)).to.be.true
			await context.symbolAdjustmentFacet.connect(context.signers.admin).finalizeRestatement(SYMBOL_ID)
			expect(await context.symbolAdjustmentFacet.isSymbolFrozen(SYMBOL_ID)).to.be.false
			expect(await context.symbolAdjustmentFacet.getCumulativeFactor(SYMBOL_ID)).to.equal(decimal(1n))
			const adjustment = await context.symbolAdjustmentFacet.getSymbolAdjustment(SYMBOL_ID)
			expect(adjustment.state).to.equal(3) // APPLIED
			expect(adjustment.scheduledCount).to.equal(1)
		})

		it("should refuse restatement without a scheduled or active factor", async function () {
			await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).startRestatement(SYMBOL_ID)).to.be.revertedWith(
				"SymbolAdjustmentFacet: No adjustment factor",
			)
		})

		it("should allow abort before a mutation and preserve the active factor", async function () {
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).startRestatement(SYMBOL_ID)
			expect((await context.symbolAdjustmentFacet.getSymbolAdjustment(SYMBOL_ID)).restatementMutated).to.be.false
			await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).abortRestatement(SYMBOL_ID))
				.to.emit(context.symbolAdjustmentFacet, "RestatementAborted")
				.withArgs(SYMBOL_ID, 1)
			expect(await context.symbolAdjustmentFacet.isSymbolFrozen(SYMBOL_ID)).to.be.false
			expect(await context.symbolAdjustmentFacet.getCumulativeFactor(SYMBOL_ID)).to.equal(decimal(4n))

			await context.symbolAdjustmentFacet.connect(context.signers.admin).startRestatement(SYMBOL_ID)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).finalizeRestatement(SYMBOL_ID)
		})

		it("should refuse scheduling while restating", async function () {
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).startRestatement(SYMBOL_ID)
			await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(2n), now)).to.be.revertedWith(
				"SymbolAdjustmentFacet: Restatement in progress",
			)
		})
	})

	describe("applyAdjustment", function () {
		let user: User, hedger: Hedger

		beforeEach(async function () {
			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(decimal(2000n), decimal(1000n), decimal(500n))

			hedger = new Hedger(context, context.signers.hedger)
			await hedger.setup()
			await hedger.setBalances(decimal(4000n), decimal(4000n))
		})

		async function openPositionForUser(): Promise<bigint> {
			const quoteId = await user.sendQuote(limitQuoteRequestBuilder().build())
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)
			return quoteId
		}

		async function activateFactorAndStartRestatement(factor = decimal(4n)) {
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, factor, now)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).startRestatement(SYMBOL_ID)
		}

		it("should return venue-unit quotes without changing raw stored values", async function () {
			const quoteId = await openPositionForUser()
			const storedBefore = await context.viewFacetQuote.getQuote(quoteId)
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)

			const venueView = await context.viewFacetQuote.getQuoteInVenueUnits(quoteId)
			const storedAfter = await context.viewFacetQuote.getQuote(quoteId)
			expect(venueView.factorApplied).to.equal(decimal(4n))
			expect(venueView.restatementEpoch).to.equal(0n)
			expect(venueView.storedInVenueUnits).to.be.false
			expect(venueView.symbolFrozen).to.be.false
			expect(venueView.quote.quantity).to.equal(storedBefore.quantity * 4n)
			expect(venueView.quote.openedPrice).to.equal(storedBefore.openedPrice / 4n)
			expect(storedAfter.quantity).to.equal(storedBefore.quantity)
			expect(storedAfter.openedPrice).to.equal(storedBefore.openedPrice)
		})

		it("should normalize restated and unrestated quotes consistently in one batch", async function () {
			const restatedId = await openPositionForUser()
			const unrestatedId = await openPositionForUser()
			const restatedBefore = await context.viewFacetQuote.getQuote(restatedId)
			const unrestatedBefore = await context.viewFacetQuote.getQuote(unrestatedId)
			await activateFactorAndStartRestatement(decimal(4n))
			await context.symbolAdjustmentFacet.connect(context.signers.hedger).applyAdjustment(SYMBOL_ID, [restatedId])

			const venueViews = await context.viewFacetQuote.getQuotesInVenueUnits([restatedId, unrestatedId])
			expect(venueViews[0].factorApplied).to.equal(decimal(1n))
			expect(venueViews[0].storedInVenueUnits).to.be.true
			expect(venueViews[0].symbolFrozen).to.be.true
			expect(venueViews[0].restatementEpoch).to.equal(1n)
			expect(venueViews[0].quote.quantity).to.equal(restatedBefore.quantity * 4n)
			expect(venueViews[0].quote.openedPrice).to.equal(restatedBefore.openedPrice / 4n)

			expect(venueViews[1].factorApplied).to.equal(decimal(4n))
			expect(venueViews[1].storedInVenueUnits).to.be.false
			expect(venueViews[1].symbolFrozen).to.be.true
			expect(venueViews[1].restatementEpoch).to.equal(1n)
			expect(venueViews[1].quote.quantity).to.equal(unrestatedBefore.quantity * 4n)
			expect(venueViews[1].quote.openedPrice).to.equal(unrestatedBefore.openedPrice / 4n)

			await context.symbolAdjustmentFacet.connect(context.signers.hedger).applyAdjustment(SYMBOL_ID, [unrestatedId])
			await context.symbolAdjustmentFacet.connect(context.signers.admin).finalizeRestatement(SYMBOL_ID)
			const finalizedView = await context.viewFacetQuote.getQuoteInVenueUnits(unrestatedId)
			expect(finalizedView.factorApplied).to.equal(decimal(1n))
			expect(finalizedView.storedInVenueUnits).to.be.true
			expect(finalizedView.symbolFrozen).to.be.false
		})

		it("should normalize a mixed book during direct restatement without activating the Muon factor", async function () {
			const restatedId = await openPositionForUser()
			const unrestatedId = await openPositionForUser()
			const restatedBefore = await context.viewFacetQuote.getQuote(restatedId)
			const unrestatedBefore = await context.viewFacetQuote.getQuote(unrestatedId)
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now)

			expect(await context.symbolAdjustmentFacet.getCumulativeFactor(SYMBOL_ID)).to.equal(decimal(1n))
			expect((await context.symbolAdjustmentFacet.previewQuoteAdjustment(SYMBOL_ID, restatedId)).factor).to.equal(decimal(4n))
			await context.symbolAdjustmentFacet.connect(context.signers.admin).startRestatement(SYMBOL_ID)
			await context.symbolAdjustmentFacet.connect(context.signers.hedger).applyAdjustment(SYMBOL_ID, [restatedId])

			const venueViews = await context.viewFacetQuote.getQuotesInVenueUnits([restatedId, unrestatedId])
			expect(venueViews[0].factorApplied).to.equal(decimal(1n))
			expect(venueViews[0].storedInVenueUnits).to.be.true
			expect(venueViews[0].quote.quantity).to.equal(restatedBefore.quantity * 4n)
			expect(venueViews[0].quote.openedPrice).to.equal(restatedBefore.openedPrice / 4n)

			expect(venueViews[1].factorApplied).to.equal(decimal(4n))
			expect(venueViews[1].storedInVenueUnits).to.be.false
			expect(venueViews[1].symbolFrozen).to.be.true
			expect(venueViews[1].quote.quantity).to.equal(unrestatedBefore.quantity * 4n)
			expect(venueViews[1].quote.openedPrice).to.equal(unrestatedBefore.openedPrice / 4n)

			await context.symbolAdjustmentFacet.connect(context.signers.hedger).applyAdjustment(SYMBOL_ID, [unrestatedId])
			await context.symbolAdjustmentFacet.connect(context.signers.admin).finalizeRestatement(SYMBOL_ID)
			expect(await context.symbolAdjustmentFacet.getCumulativeFactor(SYMBOL_ID)).to.equal(decimal(1n))
			expect(await context.symbolAdjustmentFacet.isSymbolFrozen(SYMBOL_ID)).to.be.false
		})

		it("should scale quantity x4 and openedPrice /4 preserving notional and locked values", async function () {
			const quoteId = await openPositionForUser()
			const before = await context.viewFacetQuote.getQuote(quoteId)
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)
			const preview = await context.symbolAdjustmentFacet.previewQuoteAdjustment(SYMBOL_ID, quoteId)
			expect(preview.quantity).to.equal(before.quantity * 4n)
			expect(preview.openedPrice).to.equal(before.openedPrice / 4n)
			expect(preview.initialOpenedPrice).to.equal(before.initialOpenedPrice / 4n)
			expect(preview.requestedOpenPrice).to.equal(before.requestedOpenPrice / 4n)
			expect(preview.marketPrice).to.equal(before.marketPrice / 4n)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).startRestatement(SYMBOL_ID)
			await context.symbolAdjustmentFacet.connect(context.signers.hedger).applyAdjustment(SYMBOL_ID, [quoteId])
			const after = await context.viewFacetQuote.getQuote(quoteId)
			expect(after.quantity).to.equal(before.quantity * 4n)
			expect(after.quantity * after.openedPrice).to.equal(before.quantity * before.openedPrice) // exact for a clean 4x
			expect(after.initialOpenedPrice).to.equal(preview.initialOpenedPrice)
			expect(after.requestedOpenPrice).to.equal(preview.requestedOpenPrice)
			expect(after.marketPrice).to.equal(preview.marketPrice)
			expect(after.lockedValues.cva).to.equal(before.lockedValues.cva)
			expect(after.lockedValues.lf).to.equal(before.lockedValues.lf)
			expect(after.lockedValues.partyAmm).to.equal(before.lockedValues.partyAmm)
			expect(after.lockedValues.partyBmm).to.equal(before.lockedValues.partyBmm)
		})

		it("should bound notional drift to dust for an ugly factor (1.1x)", async function () {
			const quoteId = await openPositionForUser()
			const before = await context.viewFacetQuote.getQuote(quoteId)
			await activateFactorAndStartRestatement(decimal(11n, 17))
			await context.symbolAdjustmentFacet.connect(context.signers.hedger).applyAdjustment(SYMBOL_ID, [quoteId])
			const after = await context.viewFacetQuote.getQuote(quoteId)
			const oldNotional = before.quantity * before.openedPrice
			const newNotional = after.quantity * after.openedPrice
			expect(oldNotional - newNotional).to.be.gte(0n)
			expect(oldNotional - newNotional).to.be.lt(after.quantity) // < 1 wei of price per unit
		})

		it("should scale CLOSE_PENDING fields", async function () {
			const quoteId = await openPositionForUser()
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().build())
			const before = await context.viewFacetQuote.getQuote(quoteId)
			await activateFactorAndStartRestatement()
			await context.symbolAdjustmentFacet.connect(context.signers.hedger).applyAdjustment(SYMBOL_ID, [quoteId])
			const after = await context.viewFacetQuote.getQuote(quoteId)
			expect(after.quantityToClose).to.equal(before.quantityToClose * 4n)
			expect(after.requestedClosePrice).to.equal(before.requestedClosePrice / 4n)
		})

		it("should reject a reverse split that rounds a pending close amount to zero", async function () {
			const quoteId = await openPositionForUser()
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(1n).build())
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(1n, 16), now)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)

			await expect(context.symbolAdjustmentFacet.previewQuoteAdjustment(SYMBOL_ID, quoteId)).to.be.revertedWith(
				"SymbolAdjustmentFacet: Close amount underflow",
			)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).startRestatement(SYMBOL_ID)
			await expect(context.symbolAdjustmentFacet.connect(context.signers.hedger).applyAdjustment(SYMBOL_ID, [quoteId])).to.be.revertedWith(
				"SymbolAdjustmentFacet: Close amount underflow",
			)
		})

		it("should require zero accumulated-funding rates and freeze epoch-duration changes", async function () {
			const quoteId = await openPositionForUser()
			await context.pauseControlFacet.connect(context.signers.admin).activateAccumulatedFunding()
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([SYMBOL_ID], [28800])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.setFundingFee([SYMBOL_ID], [decimal(1n, 16)], [decimal(1n, 16)], [decimal(1000n)])

			await activateFactorAndStartRestatement()
			await expect(context.symbolAdjustmentFacet.connect(context.signers.hedger).applyAdjustment(SYMBOL_ID, [quoteId])).to.be.revertedWith(
				"SymbolAdjustmentFacet: Funding rate not zero",
			)
			await expect(context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([SYMBOL_ID], [14400])).to.be.revertedWith(
				"LibSymbolAdjustment: Symbol is frozen",
			)

			await context.symbolAdjustmentFacet.connect(context.signers.admin).abortRestatement(SYMBOL_ID)
			await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([SYMBOL_ID], [0], [0], [decimal(250n)])
			await context.symbolAdjustmentFacet.connect(context.signers.admin).startRestatement(SYMBOL_ID)
			await context.symbolAdjustmentFacet.connect(context.signers.hedger).applyAdjustment(SYMBOL_ID, [quoteId])
		})

		it("should mark a pending-inventory removal and prevent abort", async function () {
			const pendingId = await user.sendQuote(limitQuoteRequestBuilder().build())
			await activateFactorAndStartRestatement()
			expect((await context.symbolAdjustmentFacet.getSymbolAdjustment(SYMBOL_ID)).restatementMutated).to.be.false
			await user.requestToCancelQuote(pendingId)
			expect((await context.symbolAdjustmentFacet.getSymbolAdjustment(SYMBOL_ID)).restatementMutated).to.be.true
			await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).abortRestatement(SYMBOL_ID)).to.be.revertedWith(
				"SymbolAdjustmentFacet: Restatement already mutated",
			)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).finalizeRestatement(SYMBOL_ID)
		})

		it("should scale a partially closed quote consistently", async function () {
			const quoteId = await openPositionForUser()
			// partially close half the position first
			const opened = await context.viewFacetQuote.getQuote(quoteId)
			await user.requestToClosePosition(
				quoteId,
				limitCloseRequestBuilder()
					.quantityToClose(opened.quantity / 2n)
					.closePrice(opened.openedPrice)
					.build(),
			)
			await hedger.fillCloseRequest(
				quoteId,
				limitFillCloseRequestBuilder()
					.filledAmount(opened.quantity / 2n)
					.closedPrice(opened.openedPrice)
					.build(),
			)
			const before = await context.viewFacetQuote.getQuote(quoteId)
			await activateFactorAndStartRestatement()
			await context.symbolAdjustmentFacet.connect(context.signers.hedger).applyAdjustment(SYMBOL_ID, [quoteId])
			const after = await context.viewFacetQuote.getQuote(quoteId)
			expect(after.closedAmount).to.equal(before.closedAmount * 4n)
			expect(after.closedAmount * after.avgClosedPrice).to.equal(before.closedAmount * before.avgClosedPrice)
			expect(after.quantity - after.closedAmount).to.equal((before.quantity - before.closedAmount) * 4n)
		})

		it("should be idempotent per epoch and reject foreign partyB", async function () {
			const quoteId = await openPositionForUser()
			await activateFactorAndStartRestatement()
			await expect(context.symbolAdjustmentFacet.connect(context.signers.user).applyAdjustment(SYMBOL_ID, [quoteId])).to.be.revertedWith(
				"SymbolAdjustmentFacet: Not partyB of quote",
			)
			await context.symbolAdjustmentFacet.connect(context.signers.hedger).applyAdjustment(SYMBOL_ID, [quoteId])
			await expect(context.symbolAdjustmentFacet.connect(context.signers.admin).abortRestatement(SYMBOL_ID)).to.be.revertedWith(
				"SymbolAdjustmentFacet: Restatement already mutated",
			)
			await expect(context.symbolAdjustmentFacet.connect(context.signers.hedger).applyAdjustment(SYMBOL_ID, [quoteId])).to.be.revertedWith(
				"SymbolAdjustmentFacet: Already restated",
			)
		})

		it("should allow fully closing a restated position (aggregates stay consistent)", async function () {
			const quoteId = await openPositionForUser()
			await activateFactorAndStartRestatement()
			await context.symbolAdjustmentFacet.connect(context.signers.hedger).applyAdjustment(SYMBOL_ID, [quoteId])
			await context.symbolAdjustmentFacet.connect(context.signers.admin).finalizeRestatement(SYMBOL_ID)
			// close the whole restated quantity at the restated price — underflows in aggregate
			// bookkeeping would revert here if step 2/4 amounts were wrong
			const after = await context.viewFacetQuote.getQuote(quoteId)
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(after.quantity).closePrice(after.openedPrice).build())
			await hedger.fillCloseRequest(quoteId, limitFillCloseRequestBuilder().filledAmount(after.quantity).closedPrice(after.openedPrice).build())
			expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(7) // CLOSED
		})
	})

	describe("CRWD 4:1 replay", function () {
		let user: User, hedger: Hedger

		beforeEach(async function () {
			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(decimal(2000n), decimal(1000n), decimal(500n))

			hedger = new Hedger(context, context.signers.hedger)
			await hedger.setup()
			await hedger.setBalances(decimal(4000n), decimal(4000n))
		})

		async function openPositionForUser(): Promise<bigint> {
			const quoteId = await user.sendQuote(limitQuoteRequestBuilder().build())
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)
			return quoteId
		}

		it("should run the full split lifecycle: schedule -> freeze -> confirm -> restate -> finalize", async function () {
			const openedId = await openPositionForUser()
			const closePendingId = await openPositionForUser()
			await user.requestToClosePosition(closePendingId, limitCloseRequestBuilder().build())
			const pendingId = await user.sendQuote(limitQuoteRequestBuilder().build())

			// 1) venue announces 4:1; ops schedules
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now + 100n)
			const pendingId2 = await user.sendQuote(limitQuoteRequestBuilder().build()) // quoting continues until the effective time

			// 2) effective time passes -> frozen; fills and new quotes blocked
			await time.increase(101)
			await expect(user.sendQuote(limitQuoteRequestBuilder().build())).to.be.revertedWith("LibSymbolAdjustment: Symbol is frozen")
			await expect(hedger.fillCloseRequest(closePendingId, limitFillCloseRequestBuilder().build())).to.be.revertedWith(
				"LibSymbolAdjustment: Symbol is frozen",
			)

			// 3) ops confirms oracle factor -> unfrozen, factor 4e18
			await context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)
			expect(await context.symbolAdjustmentFacet.getCumulativeFactor(SYMBOL_ID)).to.equal(decimal(4n))

			// 4) later: restatement window
			await context.symbolAdjustmentFacet.connect(context.signers.admin).startRestatement(SYMBOL_ID)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).cancelPendingQuotes([pendingId, pendingId2])
			const beforeOpened = await context.viewFacetQuote.getQuote(openedId)
			await context.symbolAdjustmentFacet.connect(context.signers.hedger).applyAdjustment(SYMBOL_ID, [openedId, closePendingId])
			await context.symbolAdjustmentFacet.connect(context.signers.admin).finalizeRestatement(SYMBOL_ID)

			// 5) invariants: factor reset, quantities x4, notional preserved, trading works again
			expect(await context.symbolAdjustmentFacet.getCumulativeFactor(SYMBOL_ID)).to.equal(decimal(1n))
			const afterOpened = await context.viewFacetQuote.getQuote(openedId)
			expect(afterOpened.quantity).to.equal(beforeOpened.quantity * 4n)
			expect(afterOpened.quantity * afterOpened.openedPrice).to.equal(beforeOpened.quantity * beforeOpened.openedPrice)
			const closePendingAfter = await context.viewFacetQuote.getQuote(closePendingId)
			await hedger.fillCloseRequest(
				closePendingId,
				limitFillCloseRequestBuilder().filledAmount(closePendingAfter.quantityToClose).closedPrice(closePendingAfter.requestedClosePrice).build(),
			)
			expect((await context.viewFacetQuote.getQuote(closePendingId)).quoteStatus).to.equal(7) // CLOSED
		})

		it("should run the full split lifecycle for a cross-mode (ClearingHouse) affiliate", async function () {
			const openedId = await openPositionForUser()
			const closePendingId = await openPositionForUser()
			await user.requestToClosePosition(closePendingId, limitCloseRequestBuilder().build())
			const pendingId = await user.sendQuote(limitQuoteRequestBuilder().build())

			// migrate hedger to cross partyB mode once both positions are open
			await migratePartyBToCross(context, hedger, [openedId, closePendingId])

			// 1) venue announces 4:1; ops schedules
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(SYMBOL_ID, decimal(4n), now + 100n)
			const pendingId2 = await user.sendQuote(limitQuoteRequestBuilder().build()) // quoting continues until the effective time

			// 2) effective time passes -> frozen; fills and new quotes blocked
			await time.increase(101)
			await expect(user.sendQuote(limitQuoteRequestBuilder().build())).to.be.revertedWith("LibSymbolAdjustment: Symbol is frozen")
			await expect(hedger.fillCloseRequest(closePendingId, limitFillCloseRequestBuilder().build())).to.be.revertedWith(
				"LibSymbolAdjustment: Symbol is frozen",
			)

			// 3) ops confirms oracle factor -> unfrozen, factor 4e18
			await context.symbolAdjustmentFacet.connect(context.signers.admin).confirmPriceAdjusted(SYMBOL_ID)
			expect(await context.symbolAdjustmentFacet.getCumulativeFactor(SYMBOL_ID)).to.equal(decimal(4n))

			// 4) later: restatement window
			await context.symbolAdjustmentFacet.connect(context.signers.admin).startRestatement(SYMBOL_ID)
			await context.symbolAdjustmentFacet.connect(context.signers.admin).cancelPendingQuotes([pendingId, pendingId2])
			const beforeOpened = await context.viewFacetQuote.getQuote(openedId)
			await context.symbolAdjustmentFacet.connect(context.signers.hedger).applyAdjustment(SYMBOL_ID, [openedId, closePendingId])
			await context.symbolAdjustmentFacet.connect(context.signers.admin).finalizeRestatement(SYMBOL_ID)

			// 5) invariants: factor reset, quantities x4, notional preserved, trading (and aggregate bookkeeping) works again
			expect(await context.symbolAdjustmentFacet.getCumulativeFactor(SYMBOL_ID)).to.equal(decimal(1n))
			const afterOpened = await context.viewFacetQuote.getQuote(openedId)
			expect(afterOpened.quantity).to.equal(beforeOpened.quantity * 4n)
			expect(afterOpened.quantity * afterOpened.openedPrice).to.equal(beforeOpened.quantity * beforeOpened.openedPrice)
			const closePendingAfter = await context.viewFacetQuote.getQuote(closePendingId)
			// if applyAdjustment mishandled the cross aggregate bookkeeping, this fill underflows
			await hedger.fillCloseRequest(
				closePendingId,
				limitFillCloseRequestBuilder().filledAmount(closePendingAfter.quantityToClose).closedPrice(closePendingAfter.requestedClosePrice).build(),
			)
			expect((await context.viewFacetQuote.getQuote(closePendingId)).quoteStatus).to.equal(7) // CLOSED
		})
	})
}
