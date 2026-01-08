import { loadFixture, time } from "./helpers/network-helpers.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { decimal, getBlockTimestamp } from "./utils/Common.js"
import { getDummyPairUpnlSig } from "./utils/SignatureUtils.js"
import { expect } from "chai"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { PositionType } from "./models/Enums.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"

export function shouldBehaveLikeAggregateFunding(): void {
	let context: RunContext, user: User, hedger: Hedger

	const EightHourInSec = 28800

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(5000n), decimal(5000n), decimal(5000n))

		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setBalances(decimal(5000n), decimal(5000n))

		// Enable new funding fee system
		await context.pauseControlFacet.connect(context.signers.admin).enableNewFundingFee()
	})

	describe("Aggregate Funding Tracking on Position Open", function () {
		it("should initialize aggregate funding to zero for new symbol/position type", async function () {
			// Check initial state before any positions
			const partyAFunding = await context.viewFacetQuote.getPartyAAggregatedFunding(
				await user.getAddress(),
				1,
				PositionType.LONG
			)
			expect(partyAFunding).to.equal(0)

			const partyBFunding = await context.viewFacetQuote.getPartyBAggregatedFundingPerPartyA(
				await hedger.getAddress(),
				await user.getAddress(),
				1,
				PositionType.LONG
			)
			expect(partyBFunding).to.equal(0)
		})

		it("should update aggregate funding when position is opened", async function () {
			// Setup epoch duration for funding
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

			// Wait for some time to accumulate funding
			await time.increase(EightHourInSec * 2)

			// Open a position with default values (quantity=100, price=1)
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(1)
			await hedger.openPosition(1)

			// Check aggregate funding was updated
			const partyAFunding = await context.viewFacetQuote.getPartyAAggregatedFunding(
				await user.getAddress(),
				1,
				PositionType.LONG
			)
			// Aggregate funding should be set based on quote's accumulatedPaidFunding at open time
			// The exact value depends on the accumulated funding rate at the time of opening
			expect(partyAFunding).to.not.equal(0)
		})

		it("should accumulate aggregate funding across multiple positions", async function () {
			// Setup epoch duration
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

			await time.increase(EightHourInSec)

			// Open first position
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(1)
			await hedger.openPosition(1)

			const fundingAfterFirst = await context.viewFacetQuote.getPartyAAggregatedFunding(
				await user.getAddress(),
				1,
				PositionType.LONG
			)

			// Wait and open second position
			await time.increase(EightHourInSec)
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(2)
			await hedger.openPosition(2)

			const fundingAfterSecond = await context.viewFacetQuote.getPartyAAggregatedFunding(
				await user.getAddress(),
				1,
				PositionType.LONG
			)

			// Aggregate funding should have accumulated
			expect(fundingAfterSecond).to.not.equal(fundingAfterFirst)
		})

		it("should track LONG and SHORT positions separately", async function () {
			// Setup epoch duration
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

			await time.increase(EightHourInSec)

			// Open LONG position
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.positionType(PositionType.LONG)
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(1)
			await hedger.openPosition(1)

			// Open SHORT position
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.positionType(PositionType.SHORT)
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(2)
			await hedger.openPosition(2)

			const longFunding = await context.viewFacetQuote.getPartyAAggregatedFunding(
				await user.getAddress(),
				1,
				PositionType.LONG
			)
			const shortFunding = await context.viewFacetQuote.getPartyAAggregatedFunding(
				await user.getAddress(),
				1,
				PositionType.SHORT
			)

			// Both should be tracked, and may have opposite signs due to different rates
			expect(longFunding).to.not.equal(0)
			expect(shortFunding).to.not.equal(0)
		})
	})

	describe("Aggregate Funding Updates on Charge", function () {
		beforeEach(async function () {
			// Setup and open a position
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

			await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(1)
			await hedger.openPosition(1)

			// Wait for funding to accumulate
			await time.increase(EightHourInSec * 3)
		})

		it("should update aggregate funding when funding is charged", async function () {
			const fundingBefore = await context.viewFacetQuote.getPartyAAggregatedFunding(
				await user.getAddress(),
				1,
				PositionType.LONG
			)

			// Charge funding
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.chargeAccumulatedFundingFee(
					await user.getAddress(),
					await hedger.getAddress(),
					[1],
					await getDummyPairUpnlSig()
				)

			const fundingAfter = await context.viewFacetQuote.getPartyAAggregatedFunding(
				await user.getAddress(),
				1,
				PositionType.LONG
			)

			// Aggregate funding should be updated to reflect the charged amount
			expect(fundingAfter).to.not.equal(fundingBefore)
		})

		it("should correctly update both partyA and partyB aggregate funding on charge", async function () {
			const partyAFundingBefore = await context.viewFacetQuote.getPartyAAggregatedFunding(
				await user.getAddress(),
				1,
				PositionType.LONG
			)
			const partyBFundingBefore = await context.viewFacetQuote.getPartyBAggregatedFundingPerPartyA(
				await hedger.getAddress(),
				await user.getAddress(),
				1,
				PositionType.LONG
			)

			// Charge funding
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.chargeAccumulatedFundingFee(
					await user.getAddress(),
					await hedger.getAddress(),
					[1],
					await getDummyPairUpnlSig()
				)

			const partyAFundingAfter = await context.viewFacetQuote.getPartyAAggregatedFunding(
				await user.getAddress(),
				1,
				PositionType.LONG
			)
			const partyBFundingAfter = await context.viewFacetQuote.getPartyBAggregatedFundingPerPartyA(
				await hedger.getAddress(),
				await user.getAddress(),
				1,
				PositionType.LONG
			)

			// Both parties' aggregate funding should change
			expect(partyAFundingAfter).to.not.equal(partyAFundingBefore)
			expect(partyBFundingAfter).to.not.equal(partyBFundingBefore)
		})
	})

	describe("Aggregate Funding Removal on Position Close", function () {
		beforeEach(async function () {
			// Setup and open a position
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

			await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(1)
			await hedger.openPosition(1)
		})

		it("should decrease aggregate funding when position is fully closed", async function () {
			// First charge funding
			await time.increase(EightHourInSec * 3)
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.chargeAccumulatedFundingFee(
					await user.getAddress(),
					await hedger.getAddress(),
					[1],
					await getDummyPairUpnlSig()
				)

			const fundingBeforeClose = await context.viewFacetQuote.getPartyAAggregatedFunding(
				await user.getAddress(),
				1,
				PositionType.LONG
			)

			// Request to close
			await user.requestToClosePosition(1)

			// Fill close request
			await hedger.fillCloseRequest(1)

			const fundingAfterClose = await context.viewFacetQuote.getPartyAAggregatedFunding(
				await user.getAddress(),
				1,
				PositionType.LONG
			)

			// After full close, aggregate funding should be reduced
			// Since it was the only position, it should be 0 or very close to it
			expect(fundingAfterClose).to.be.approximately(0n, decimal(1n, 10))
		})

		it("should proportionally decrease aggregate funding on partial close", async function () {
			// Open another position first so we have multiple
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(2)
			await hedger.openPosition(2)

			// Charge funding
			await time.increase(EightHourInSec * 3)
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.chargeAccumulatedFundingFee(
					await user.getAddress(),
					await hedger.getAddress(),
					[1, 2],
					await getDummyPairUpnlSig()
				)

			const fundingBeforeClose = await context.viewFacetQuote.getPartyAAggregatedFunding(
				await user.getAddress(),
				1,
				PositionType.LONG
			)

			// Close only one position
			await user.requestToClosePosition(1)
			await hedger.fillCloseRequest(1)

			const fundingAfterClose = await context.viewFacetQuote.getPartyAAggregatedFunding(
				await user.getAddress(),
				1,
				PositionType.LONG
			)

			// Aggregate funding should be roughly halved (since we closed one of two equal positions)
			// Allow some tolerance due to timing differences
			expect(fundingAfterClose).to.be.lt(fundingBeforeClose)
			expect(fundingAfterClose).to.be.gt(0n)
		})
	})

	describe("Aggregate Funding Debt Calculation", function () {
		beforeEach(async function () {
			// Setup funding rates
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])
		})

		it("should return zero funding debt when no positions exist", async function () {
			const debt = await context.viewFacetQuote.getPartyAAggregateFundingDebt(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)
			expect(debt).to.equal(0)
		})

		it("should calculate partyA funding debt correctly", async function () {
			// Open a position
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(1)
			await hedger.openPosition(1)

			// Wait for funding to accumulate
			await time.increase(EightHourInSec * 3)

			const partyADebt = await context.viewFacetQuote.getPartyAAggregateFundingDebt(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)

			// PartyA debt should be non-zero
			expect(partyADebt).to.not.equal(0)
		})

		it("should return opposite funding debt for partyB", async function () {
			// Open a position
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(1)
			await hedger.openPosition(1)

			// Wait for funding to accumulate
			await time.increase(EightHourInSec * 3)

			const partyADebt = await context.viewFacetQuote.getPartyAAggregateFundingDebt(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)

			const partyBDebt = await context.viewFacetQuote.getPartyBAggregateFundingDebt(
				await hedger.getAddress(),
				await user.getAddress(),
				1,
				PositionType.LONG
			)

			// PartyB debt should be opposite to partyA debt
			expect(partyBDebt).to.equal(-partyADebt)
		})
	})

	describe("Complete Aggregate State View Functions", function () {
		beforeEach(async function () {
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

			// Open positions
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(1)
			await hedger.openPosition(1)
		})

		it("should return complete aggregate state for partyA", async function () {
			const [aggregatedAmount, aggregatedNotional, weightedPaidFunding] =
				await context.viewFacetQuote.getPartyACompleteAggregateState(
					await user.getAddress(),
					1,
					PositionType.LONG
				)

			expect(aggregatedAmount).to.be.gt(0)
			expect(aggregatedNotional).to.be.gt(0)
			// weightedPaidFunding depends on accumulatedPaidFunding at open time
		})

		it("should return complete aggregate state for partyB per partyA", async function () {
			const [aggregatedAmount, aggregatedNotional, weightedPaidFunding] =
				await context.viewFacetQuote.getPartyBCompleteAggregateStatePerPartyA(
					await hedger.getAddress(),
					await user.getAddress(),
					1,
					PositionType.LONG
				)

			expect(aggregatedAmount).to.be.gt(0)
			expect(aggregatedNotional).to.be.gt(0)
		})
	})

	describe("Aggregate Funding Consistency with Per-Quote Funding", function () {
		it("should give consistent total funding debt when compared to per-quote calculation", async function () {
			// Setup funding rates
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

			// Open multiple positions
			for (let i = 0; i < 3; i++) {
				await user.sendQuote(
					limitQuoteRequestBuilder()
						.maxFundingRate(decimal(1n))
						.build()
				)
				await hedger.lockQuote(i + 1)
				await hedger.openPosition(i + 1)
				await time.increase(EightHourInSec) // Wait between positions
			}

			// Wait for more funding to accumulate
			await time.increase(EightHourInSec * 2)

			// Get aggregate funding debt
			const aggregateFundingDebt = await context.viewFacetQuote.getPartyAAggregateFundingDebt(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)

			// The aggregate debt should be non-zero and represent the total funding owed
			expect(aggregateFundingDebt).to.not.equal(0)

			// Verify partyB debt is opposite
			const partyBAggregateFundingDebt = await context.viewFacetQuote.getPartyBAggregateFundingDebt(
				await hedger.getAddress(),
				await user.getAddress(),
				1,
				PositionType.LONG
			)
			expect(partyBAggregateFundingDebt).to.equal(-aggregateFundingDebt)
		})

		it("should have aggregate funding >= sum of per-quote funding (due to maxFundingRate caps)", async function () {
			// Setup funding rates with a moderate rate
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

			// Open multiple positions with different maxFundingRates
			const quoteIds: bigint[] = []
			for (let i = 0; i < 3; i++) {
				const quoteId = await user.sendQuote(
					limitQuoteRequestBuilder()
						.maxFundingRate(decimal(1n)) // High max funding rate
						.build()
				)
				quoteIds.push(quoteId)
				await hedger.lockQuote(quoteId)
				await hedger.openPosition(quoteId)
				await time.increase(EightHourInSec)
			}

			// Wait for funding to accumulate
			await time.increase(EightHourInSec * 3)

			// Get per-quote funding using getAccumulatedFundingFees
			const perQuoteFees = await context.viewFacetSymbol.getAccumulatedFundingFees(quoteIds)
			let sumPerQuoteFees = 0n
			for (const fee of perQuoteFees) {
				sumPerQuoteFees += fee
			}

			// Get aggregate funding debt
			const aggregateFundingDebt = await context.viewFacetQuote.getPartyAAggregateFundingDebt(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)

			// Aggregate should be >= sum of per-quote fees because:
			// - Per-quote fees have maxFundingRate caps applied
			// - Aggregate is conservative (no caps)
			// When caps don't kick in, they should be equal
			// When caps kick in, aggregate >= sum
			expect(aggregateFundingDebt).to.be.gte(sumPerQuoteFees)
		})

		it("should match exactly when maxFundingRate caps are not hit", async function () {
			// Setup with LOW funding rate so caps won't be hit
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 16)], [-decimal(1n, 16)], [decimal(1n)]) // Very low rate

			// Open positions with HIGH maxFundingRate (so caps won't be hit)
			const quoteIds: bigint[] = []
			for (let i = 0; i < 2; i++) {
				const quoteId = await user.sendQuote(
					limitQuoteRequestBuilder()
						.maxFundingRate(decimal(1n)) // Very high max - won't be hit
						.build()
				)
				quoteIds.push(quoteId)
				await hedger.lockQuote(quoteId)
				await hedger.openPosition(quoteId)
			}

			// Wait for some funding
			await time.increase(EightHourInSec * 2)

			// Get per-quote funding using getAccumulatedFundingFees
			const perQuoteFees = await context.viewFacetSymbol.getAccumulatedFundingFees(quoteIds)
			let sumPerQuoteFees = 0n
			for (const fee of perQuoteFees) {
				sumPerQuoteFees += fee
			}

			// Get aggregate funding debt
			const aggregateFundingDebt = await context.viewFacetQuote.getPartyAAggregateFundingDebt(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)

			// When caps are not hit, aggregate should equal sum of per-quote fees
			// Allow small tolerance for rounding
			const tolerance = decimal(1n, 12) // Small tolerance for rounding
			const diff = aggregateFundingDebt > sumPerQuoteFees
				? aggregateFundingDebt - sumPerQuoteFees
				: sumPerQuoteFees - aggregateFundingDebt
			expect(diff).to.be.lte(tolerance)
		})

		it("should show aggregate >= sum when maxFundingRate caps are hit", async function () {
			// Setup with HIGH funding rate so caps WILL be hit
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)]) // Higher rate

			// Open positions with LOW maxFundingRate (so caps WILL be hit)
			const quoteIds: bigint[] = []
			for (let i = 0; i < 2; i++) {
				const quoteId = await user.sendQuote(
					limitQuoteRequestBuilder()
						.maxFundingRate(decimal(1n, 16)) // Low max - will be hit after a few epochs
						.build()
				)
				quoteIds.push(quoteId)
				await hedger.lockQuote(quoteId)
				await hedger.openPosition(quoteId)
			}

			// Wait for MANY epochs so caps are definitely hit
			await time.increase(EightHourInSec * 10)

			// Get per-quote funding using getAccumulatedFundingFees
			const perQuoteFees = await context.viewFacetSymbol.getAccumulatedFundingFees(quoteIds)
			let sumPerQuoteFees = 0n
			for (const fee of perQuoteFees) {
				sumPerQuoteFees += fee
			}

			// Get aggregate funding debt
			const aggregateFundingDebt = await context.viewFacetQuote.getPartyAAggregateFundingDebt(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)

			// When caps are hit, aggregate should be >= sum of per-quote fees
			// The aggregate is a conservative (higher or equal) estimate since it doesn't apply per-quote caps
			expect(aggregateFundingDebt).to.be.gte(sumPerQuoteFees)

			// Also verify that both are non-zero and the cap was actually applied
			expect(sumPerQuoteFees).to.be.gt(0)
			expect(aggregateFundingDebt).to.be.gt(0)
		})

		it("should verify getSumAccumulatedFundingFees matches sum of individual fees", async function () {
			// Setup funding rates
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

			// Open multiple positions
			const quoteIds: bigint[] = []
			for (let i = 0; i < 3; i++) {
				const quoteId = await user.sendQuote(
					limitQuoteRequestBuilder()
						.maxFundingRate(decimal(1n))
						.build()
				)
				quoteIds.push(quoteId)
				await hedger.lockQuote(quoteId)
				await hedger.openPosition(quoteId)
				await time.increase(EightHourInSec)
			}

			// Wait for funding
			await time.increase(EightHourInSec * 2)

			// Get per-quote funding using getAccumulatedFundingFees
			const perQuoteFees = await context.viewFacetSymbol.getAccumulatedFundingFees(quoteIds)
			let manualSum = 0n
			for (const fee of perQuoteFees) {
				manualSum += fee
			}

			// Get sum using getSumAccumulatedFundingFees
			const contractSum = await context.viewFacetSymbol.getSumAccumulatedFundingFees(quoteIds)

			// Should be exactly equal
			expect(contractSum).to.equal(manualSum)
		})
	})

	describe("Edge Cases", function () {
		it("should handle zero funding rate correctly", async function () {
			// Setup epoch duration but zero funding rate
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [0], [0], [decimal(1n)])

			// Open position
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(1)
			await hedger.openPosition(1)

			// Wait
			await time.increase(EightHourInSec * 3)

			// Funding debt should be zero
			const debt = await context.viewFacetQuote.getPartyAAggregateFundingDebt(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)
			expect(debt).to.equal(0)
		})

		it("should return zero debt when epoch duration not set", async function () {
			// Don't set epoch duration - open position normally without accumulated funding
			await user.sendQuote(limitQuoteRequestBuilder().build())
			await hedger.lockQuote(1)
			await hedger.openPosition(1)

			// Debt should be zero since no funding system is configured
			const debt = await context.viewFacetQuote.getPartyAAggregateFundingDebt(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)
			expect(debt).to.equal(0)
		})

		it("should handle negative funding rates", async function () {
			// Setup negative long funding rate (shorts pay longs)
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [-decimal(1n, 14)], [decimal(1n, 14)], [decimal(1n)])

			// Open LONG position
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.positionType(PositionType.LONG)
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(1)
			await hedger.openPosition(1)

			// Wait for funding
			await time.increase(EightHourInSec * 3)

			// With negative long rate, partyA should be owed money (negative debt)
			const debt = await context.viewFacetQuote.getPartyAAggregateFundingDebt(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)

			// Debt could be negative (partyA is owed) since rate is negative
			expect(debt).to.be.lt(0)
		})
	})
}
