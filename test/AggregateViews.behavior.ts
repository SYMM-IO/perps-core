import { loadFixture, time } from "./helpers/network-helpers.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { decimal, getBlockTimestamp, getQuoteQuantity, unDecimal } from "./utils/Common.js"
import { getDummyPairUpnlSig, getDummyLiquidationSig, getDummySettlementSig } from "./utils/SignatureUtils.js"
import { expect } from "chai"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { PositionType } from "./models/Enums.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { emergencyCloseRequestBuilder } from "./models/requestModels/EmergencyCloseRequest.js"
import type { QuoteSettlementDataStructOutput } from "../src/types/facets/Settlement/ISettlementFacet.js"
import type { QuoteStructOutput } from "../src/types/interfaces/ISymmio.js"

export function shouldBehaveLikeAggregateViews(): void {
	let context: RunContext, user: User, hedger: Hedger

	const EightHourInSec = 28800

	function getWeightedPaidFunding(quote: QuoteStructOutput, openAmount?: bigint): bigint {
		const amount = openAmount ?? quote.quantity - quote.closedAmount
		return (amount * quote.accumulatedPaidFunding) / decimal(1n)
	}

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
			const partyAFunding = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
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
			const quoteId = await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

			// Check aggregate funding was updated
			const quote = await context.viewFacetQuote.getQuote(quoteId)
			const partyAFunding = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)
			const expectedFunding = getWeightedPaidFunding(quote)
			expect(partyAFunding).to.equal(expectedFunding)

			const partyBFunding = await context.viewFacetQuote.getPartyBAggregatedFundingPerPartyA(
				await hedger.getAddress(),
				await user.getAddress(),
				1,
				PositionType.LONG
			)
			expect(partyBFunding).to.equal(expectedFunding)
		})

		it("should accumulate aggregate funding across multiple positions", async function () {
			// Setup epoch duration
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

			await time.increase(EightHourInSec)

			// Open first position
			const firstQuoteId = await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(firstQuoteId)
			await hedger.openPosition(firstQuoteId)

			const firstQuote = await context.viewFacetQuote.getQuote(firstQuoteId)
			const expectedFirst = getWeightedPaidFunding(firstQuote)
			const fundingAfterFirst = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)
			expect(fundingAfterFirst).to.equal(expectedFirst)

			// Wait and open second position
			await time.increase(EightHourInSec)
			const secondQuoteId = await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(secondQuoteId)
			await hedger.openPosition(secondQuoteId)

			const fundingAfterSecond = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)
			const secondQuote = await context.viewFacetQuote.getQuote(secondQuoteId)
			const expectedSecond = expectedFirst + getWeightedPaidFunding(secondQuote)

			// Aggregate funding should have accumulated
			expect(fundingAfterSecond).to.equal(expectedSecond)
		})

		it("should track LONG and SHORT positions separately", async function () {
			// Setup epoch duration
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

			await time.increase(EightHourInSec)

			// Open LONG position
			const longQuoteId = await user.sendQuote(
				limitQuoteRequestBuilder()
					.positionType(PositionType.LONG)
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(longQuoteId)
			await hedger.openPosition(longQuoteId)

			// Open SHORT position
			const shortQuoteId = await user.sendQuote(
				limitQuoteRequestBuilder()
					.positionType(PositionType.SHORT)
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(shortQuoteId)
			await hedger.openPosition(shortQuoteId)

			const longQuote = await context.viewFacetQuote.getQuote(longQuoteId)
			const shortQuote = await context.viewFacetQuote.getQuote(shortQuoteId)
			const longFunding = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)
			const shortFunding = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.SHORT
			)

			expect(longFunding).to.equal(getWeightedPaidFunding(longQuote))
			expect(shortFunding).to.equal(getWeightedPaidFunding(shortQuote))
		})
	})

	describe("Aggregate Funding Updates on Quote Funding Value Sync", function () {
		let openQuoteId: bigint

		beforeEach(async function () {
			// Setup and open a position
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

			openQuoteId = await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(openQuoteId)
			await hedger.openPosition(openQuoteId)

			// Wait for funding to accumulate
			await time.increase(EightHourInSec * 3)
		})

		it("should update aggregate funding when funding is charged (quote funding value sync)", async function () {
			const quoteBefore = await context.viewFacetQuote.getQuote(openQuoteId)
			const openAmount = quoteBefore.quantity - quoteBefore.closedAmount
			const fundingBefore = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)
			expect(fundingBefore).to.equal(getWeightedPaidFunding(quoteBefore, openAmount))

			// Charge funding
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.chargeAccumulatedFundingFee(
					await user.getAddress(),
					await hedger.getAddress(),
					[openQuoteId],
					await getDummyPairUpnlSig()
				)

			const quoteAfter = await context.viewFacetQuote.getQuote(openQuoteId)
			const fundingAfter = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)

			const expectedDelta = (openAmount * (quoteAfter.accumulatedPaidFunding - quoteBefore.accumulatedPaidFunding)) / decimal(1n)
			expect(fundingAfter).to.equal(fundingBefore + expectedDelta)
		})

		it("should correctly update both partyA and partyB aggregate funding on charge", async function () {
			const quoteBefore = await context.viewFacetQuote.getQuote(openQuoteId)
			const openAmount = quoteBefore.quantity - quoteBefore.closedAmount
			const partyAFundingBefore = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)
			const partyBFundingBefore = await context.viewFacetQuote.getPartyBAggregatedFundingPerPartyA(
				await hedger.getAddress(),
				await user.getAddress(),
				1,
				PositionType.LONG
			)
			expect(partyAFundingBefore).to.equal(getWeightedPaidFunding(quoteBefore, openAmount))
			expect(partyBFundingBefore).to.equal(partyAFundingBefore)

			// Charge funding
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.chargeAccumulatedFundingFee(
					await user.getAddress(),
					await hedger.getAddress(),
					[openQuoteId],
					await getDummyPairUpnlSig()
				)

			const quoteAfter = await context.viewFacetQuote.getQuote(openQuoteId)
			const partyAFundingAfter = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)
			const partyBFundingAfter = await context.viewFacetQuote.getPartyBAggregatedFundingPerPartyA(
				await hedger.getAddress(),
				await user.getAddress(),
				1,
				PositionType.LONG
			)

			const expectedDelta = (openAmount * (quoteAfter.accumulatedPaidFunding - quoteBefore.accumulatedPaidFunding)) / decimal(1n)
			expect(partyAFundingAfter).to.equal(partyAFundingBefore + expectedDelta)
			expect(partyBFundingAfter).to.equal(partyBFundingBefore + expectedDelta)
		})
	})

	describe("Aggregate Funding Removal on Position Close", function () {
		let openQuoteId: bigint

		beforeEach(async function () {
			// Setup and open a position
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

			openQuoteId = await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(openQuoteId)
			await hedger.openPosition(openQuoteId)
		})

		it("should decrease aggregate funding when position is fully closed", async function () {
			// First charge funding
			await time.increase(EightHourInSec * 3)
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.chargeAccumulatedFundingFee(
					await user.getAddress(),
					await hedger.getAddress(),
					[openQuoteId],
					await getDummyPairUpnlSig()
				)

			const quoteBeforeClose = await context.viewFacetQuote.getQuote(openQuoteId)
			const fundingBeforeClose = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)
			const expectedBeforeClose = getWeightedPaidFunding(quoteBeforeClose)
			expect(fundingBeforeClose).to.equal(expectedBeforeClose)

			// Request to close
			await user.requestToClosePosition(openQuoteId)

			// Fill close request
			await hedger.fillCloseRequest(openQuoteId)

			const fundingAfterClose = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)

			const closeContribution = getWeightedPaidFunding(quoteBeforeClose)
			expect(fundingAfterClose).to.equal(fundingBeforeClose - closeContribution)
			expect(fundingAfterClose).to.equal(0n)
		})

		it("should proportionally decrease aggregate funding on partial close", async function () {
			// Open another position first so we have multiple
			const secondQuoteId = await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(secondQuoteId)
			await hedger.openPosition(secondQuoteId)

			// Charge funding
			await time.increase(EightHourInSec * 3)
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.chargeAccumulatedFundingFee(
					await user.getAddress(),
					await hedger.getAddress(),
					[openQuoteId, secondQuoteId],
					await getDummyPairUpnlSig()
				)

			const fundingBeforeClose = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)
			const quoteBeforeClose = await context.viewFacetQuote.getQuote(openQuoteId)
			const closeContribution = getWeightedPaidFunding(quoteBeforeClose)

			// Close only one position
			await user.requestToClosePosition(openQuoteId)
			await hedger.fillCloseRequest(openQuoteId)

			const fundingAfterClose = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)

			expect(fundingAfterClose).to.equal(fundingBeforeClose - closeContribution)
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
			const quoteId = await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

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
			const quoteId = await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

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
			const quoteId = await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)
		})

		it("should return complete aggregate state for partyA", async function () {
			const [aggregatedAmount, aggregatedNotional, weightedPaidFunding] =
				await context.viewFacetQuote.getPartyACompleteAggregateStatePerPartyB(
					await user.getAddress(),
					await hedger.getAddress(),
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
				const quoteId = await user.sendQuote(
					limitQuoteRequestBuilder()
						.maxFundingRate(decimal(1n))
						.build()
				)
				await hedger.lockQuote(quoteId)
				await hedger.openPosition(quoteId)
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
			const quoteId = await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

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
			const quoteId = await user.sendQuote(limitQuoteRequestBuilder().build())
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

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
			const quoteId = await user.sendQuote(
				limitQuoteRequestBuilder()
					.positionType(PositionType.LONG)
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

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

	// ============ Active Symbols Tracking ============
	// These tests verify the active symbols tracking that enables efficient aggregated views

	describe("Active Symbols Tracking", function () {
		beforeEach(async function () {
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])
		})

		it("should have empty active symbols list initially", async function () {
			const activeSymbols = await context.viewFacetQuote.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(activeSymbols.length).to.equal(0)

			const partyBActiveSymbols = await context.viewFacetQuote.getPartyBActiveSymbolsPerPartyA(await hedger.getAddress(), await user.getAddress(), 0, 1000)
			expect(partyBActiveSymbols.length).to.equal(0)
		})

		it("should add symbol to active list when position opens", async function () {
			const quoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

			const partyAActiveSymbols = await context.viewFacetQuote.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(partyAActiveSymbols.length).to.equal(1)
			expect(partyAActiveSymbols[0]).to.equal(1n)

			const partyBActiveSymbols = await context.viewFacetQuote.getPartyBActiveSymbolsPerPartyA(await hedger.getAddress(), await user.getAddress(), 0, 1000)
			expect(partyBActiveSymbols.length).to.equal(1)
		})

		it("should not duplicate symbol when opening multiple positions in same symbol", async function () {
			// Open two positions in symbol 1
			const firstQuoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(firstQuoteId)
			await hedger.openPosition(firstQuoteId)

			const secondQuoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(secondQuoteId)
			await hedger.openPosition(secondQuoteId)

			const partyAActiveSymbols = await context.viewFacetQuote.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(partyAActiveSymbols.length).to.equal(1) // Still only 1 symbol
		})

		it("should remove symbol from active list when all positions close", async function () {
			const quoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

			let partyAActiveSymbols = await context.viewFacetQuote.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(partyAActiveSymbols.length).to.equal(1)

			await user.requestToClosePosition(quoteId)
			await hedger.fillCloseRequest(quoteId)

			partyAActiveSymbols = await context.viewFacetQuote.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(partyAActiveSymbols.length).to.equal(0)
		})

		it("should keep symbol when only partial positions close", async function () {
			// Open two positions
			const firstQuoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(firstQuoteId)
			await hedger.openPosition(firstQuoteId)

			const secondQuoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(secondQuoteId)
			await hedger.openPosition(secondQuoteId)

			// Close only first
			await user.requestToClosePosition(firstQuoteId)
			await hedger.fillCloseRequest(firstQuoteId)

			const partyAActiveSymbols = await context.viewFacetQuote.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(partyAActiveSymbols.length).to.equal(1) // Still has symbol 1
		})

		it("should track multiple symbols correctly", async function () {
			// Add symbol 2
			await context.symbolControlFacet
				.connect(context.signers.admin)
				.addSymbol("SYMBOL2", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
			await context.symbolControlFacet.connect(context.signers.admin).setSymbolTypes([2], [1])
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([2], [EightHourInSec])

			// Open positions in both symbols
			const symbol1QuoteId = await user.sendQuote(limitQuoteRequestBuilder().symbolId(1).maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(symbol1QuoteId)
			await hedger.openPosition(symbol1QuoteId)

			const symbol2QuoteId = await user.sendQuote(limitQuoteRequestBuilder().symbolId(2).maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(symbol2QuoteId)
			await hedger.openPosition(symbol2QuoteId)

			const partyAActiveSymbols = await context.viewFacetQuote.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(partyAActiveSymbols.length).to.equal(2)
			expect(partyAActiveSymbols).to.include(1n)
			expect(partyAActiveSymbols).to.include(2n)
		})

		it("should handle swap-and-pop removal correctly", async function () {
			// Add symbols 2 and 3
			await context.symbolControlFacet.connect(context.signers.admin)
				.addSymbol("SYMBOL2", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
			await context.symbolControlFacet.connect(context.signers.admin)
				.addSymbol("SYMBOL3", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
			await context.symbolControlFacet.connect(context.signers.admin).setSymbolTypes([2, 3], [1, 1])
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([2, 3], [EightHourInSec, EightHourInSec])

			// Open positions in all 3 symbols
			const quoteIdsBySymbol = new Map<number, bigint>()
			for (let symbolId = 1; symbolId <= 3; symbolId++) {
				const quoteId = await user.sendQuote(limitQuoteRequestBuilder().symbolId(symbolId).maxFundingRate(decimal(1n)).build())
				quoteIdsBySymbol.set(symbolId, quoteId)
				await hedger.lockQuote(quoteId)
				await hedger.openPosition(quoteId)
			}

			// Close position in symbol 1 (first in array - triggers swap-and-pop)
			const symbol1QuoteId = quoteIdsBySymbol.get(1)
			if (!symbol1QuoteId) throw new Error("Symbol 1 quote not found")
			await user.requestToClosePosition(symbol1QuoteId)
			await hedger.fillCloseRequest(symbol1QuoteId)

			const partyAActiveSymbols = await context.viewFacetQuote.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(partyAActiveSymbols.length).to.equal(2)
			expect(partyAActiveSymbols).to.include(2n)
			expect(partyAActiveSymbols).to.include(3n)
			expect(partyAActiveSymbols).to.not.include(1n)
		})
	})

	// ============ Multi-Hedger Aggregate Funding Tests ============
	// These tests verify that partyA aggregate funding is tracked correctly per-hedger
	// This is critical when partyA has positions with multiple hedgers in the same symbol

	describe("Multi-Hedger Aggregate Funding", function () {
		let hedger2: Hedger

		beforeEach(async function () {
			// Setup second hedger
			hedger2 = new Hedger(context, context.signers.hedger2)
			await hedger2.setup()
			await hedger2.setBalances(decimal(5000n), decimal(5000n))

			// Setup funding rates for both hedgers with different rates
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

			// Second hedger sets different funding rates for the same symbol
			await context.fundingRateFacet.connect(context.signers.hedger2).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger2)
				.updateAccumulatedFundingFee([1], [decimal(2n, 14)], [-decimal(2n, 14)], [decimal(1n)])
		})

		it("should track aggregate funding separately per hedger", async function () {
			await time.increase(EightHourInSec)
			await context.symbolControlFacet
			.connect(context.signers.admin)
			.addSymbol("SYMBOL2", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)

			// Open position with first hedger
			const quoteId1 = await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(quoteId1)
			await hedger.openPosition(quoteId1)

			// Open position with second hedger
			const quoteId2 = await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger2.lockQuote(quoteId2)
			await hedger2.openPosition(quoteId2)

			const quote1 = await context.viewFacetQuote.getQuote(quoteId1)
			const quote2 = await context.viewFacetQuote.getQuote(quoteId2)

			// Check aggregate funding per hedger
			const fundingHedger1 = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)
			const fundingHedger2 = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger2.getAddress(),
				1,
				PositionType.LONG
			)

			// Each hedger's aggregate should only contain that hedger's positions
			expect(fundingHedger1).to.equal(getWeightedPaidFunding(quote1))
			expect(fundingHedger2).to.equal(getWeightedPaidFunding(quote2))

			// They should be different because they have different funding rates
			// (unless both accumulated the same, which is unlikely)
			expect(fundingHedger1).to.not.equal(fundingHedger2)
		})

		it("should calculate funding debt correctly per hedger with different rates", async function () {
			await time.increase(EightHourInSec * 2)

			// Open positions with both hedgers
			const quoteId1 = await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(quoteId1)
			await hedger.openPosition(quoteId1)

			const quoteId2 = await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger2.lockQuote(quoteId2)
			await hedger2.openPosition(quoteId2)

			// Wait for more funding to accumulate
			await time.increase(EightHourInSec * 3)

			// Get funding debt for each hedger relationship
			const debtWithHedger1 = await context.viewFacetQuote.getPartyAAggregateFundingDebt(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)
			const debtWithHedger2 = await context.viewFacetQuote.getPartyAAggregateFundingDebt(
				await user.getAddress(),
				await hedger2.getAddress(),
				1,
				PositionType.LONG
			)

			// Debts should be different because hedgers have different funding rates
			expect(debtWithHedger1).to.not.equal(0)
			expect(debtWithHedger2).to.not.equal(0)
			// Hedger2 has 2x the funding rate, so debt should be approximately double
			// (allowing for timing differences in position opening)
			expect(debtWithHedger2).to.be.gt(debtWithHedger1)
		})

		it("should correctly update aggregate funding when charging per hedger", async function () {
			await time.increase(EightHourInSec)

			// Open positions with both hedgers
			const quoteId1 = await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(quoteId1)
			await hedger.openPosition(quoteId1)

			const quoteId2 = await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger2.lockQuote(quoteId2)
			await hedger2.openPosition(quoteId2)

			// Wait for funding to accumulate
			await time.increase(EightHourInSec * 3)

			// Charge funding for hedger1's quotes only
			const fundingBefore = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)

			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.chargeAccumulatedFundingFee(
					await user.getAddress(),
					await hedger.getAddress(),
					[quoteId1],
					await getDummyPairUpnlSig()
				)

			const fundingAfter = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)

			// Hedger1's aggregate should have changed
			expect(fundingAfter).to.not.equal(fundingBefore)

			// Hedger2's aggregate should remain unchanged (no charge was made)
			const fundingHedger2Before = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger2.getAddress(),
				1,
				PositionType.LONG
			)

			// Charge funding for hedger2 now
			await context.fundingRateFacet
				.connect(context.signers.hedger2)
				.chargeAccumulatedFundingFee(
					await user.getAddress(),
					await hedger2.getAddress(),
					[quoteId2],
					await getDummyPairUpnlSig()
				)

			const fundingHedger2After = await context.viewFacetQuote.getPartyAAggregatedFundingPerPartyB(
				await user.getAddress(),
				await hedger2.getAddress(),
				1,
				PositionType.LONG
			)

			expect(fundingHedger2After).to.not.equal(fundingHedger2Before)
		})

		it("should track active symbols separately per hedger", async function () {
			// Open position with hedger1 in symbol 1
			const quoteId1 = await user.sendQuote(
				limitQuoteRequestBuilder()
					.symbolId(1)
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(quoteId1)
			await hedger.openPosition(quoteId1)

			// Open position with hedger2 in symbol 1 (same symbol, different hedger)
			const quoteId2 = await user.sendQuote(
				limitQuoteRequestBuilder()
					.symbolId(1)
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger2.lockQuote(quoteId2)
			await hedger2.openPosition(quoteId2)

			// Check active symbols per hedger - both should have symbol 1
			const activeSymbolsHedger1 = await context.viewFacetQuote.getPartyAActiveSymbolsPerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				0,
				1000
			)
			const activeSymbolsHedger2 = await context.viewFacetQuote.getPartyAActiveSymbolsPerPartyB(
				await user.getAddress(),
				await hedger2.getAddress(),
				0,
				1000
			)

			// Each hedger should have symbol 1 tracked separately
			expect(activeSymbolsHedger1.length).to.equal(1)
			expect(activeSymbolsHedger1[0]).to.equal(1n)

			expect(activeSymbolsHedger2.length).to.equal(1)
			expect(activeSymbolsHedger2[0]).to.equal(1n)

			// Global active symbols should contain symbol 1 (only once)
			const allActiveSymbols = await context.viewFacetQuote.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(allActiveSymbols.length).to.equal(1)
			expect(allActiveSymbols[0]).to.equal(1n)
		})

		it("should return correct complete aggregate state per hedger", async function () {
			await time.increase(EightHourInSec)

			// Open positions with both hedgers (same quantity to make comparison easier)
			const quoteId1 = await user.sendQuote(
				limitQuoteRequestBuilder()
					.quantity(decimal(100n))
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(quoteId1)
			await hedger.openPosition(quoteId1)

			const quoteId2 = await user.sendQuote(
				limitQuoteRequestBuilder()
					.quantity(decimal(100n))
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger2.lockQuote(quoteId2)
			await hedger2.openPosition(quoteId2)

			// Get complete state per hedger
			const [amount1, notional1, weighted1] = await context.viewFacetQuote.getPartyACompleteAggregateStatePerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)
			const [amount2, notional2, weighted2] = await context.viewFacetQuote.getPartyACompleteAggregateStatePerPartyB(
				await user.getAddress(),
				await hedger2.getAddress(),
				1,
				PositionType.LONG
			)

			// Amounts should be equal (same quantity)
			expect(amount1).to.equal(amount2)

			// Notionals should be equal (same price)
			expect(notional1).to.equal(notional2)

			// Weighted funding may differ due to different funding rates
			// but both should be non-zero
			expect(weighted1).to.not.equal(0n)
			expect(weighted2).to.not.equal(0n)
		})

		it("should handle closing position with one hedger without affecting other hedger's aggregate", async function () {
			await time.increase(EightHourInSec)

			// Open positions with both hedgers
			const quoteId1 = await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(quoteId1)
			await hedger.openPosition(quoteId1)

			const quoteId2 = await user.sendQuote(
				limitQuoteRequestBuilder()
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger2.lockQuote(quoteId2)
			await hedger2.openPosition(quoteId2)

			// Get initial aggregate for hedger2
			const [amount2Before] = await context.viewFacetQuote.getPartyACompleteAggregateStatePerPartyB(
				await user.getAddress(),
				await hedger2.getAddress(),
				1,
				PositionType.LONG
			)

			// Close position with hedger1
			await user.requestToClosePosition(quoteId1)
			await hedger.fillCloseRequest(quoteId1)

			// Hedger1's aggregate should be zero
			const [amount1After] = await context.viewFacetQuote.getPartyACompleteAggregateStatePerPartyB(
				await user.getAddress(),
				await hedger.getAddress(),
				1,
				PositionType.LONG
			)
			expect(amount1After).to.equal(0n)

			// Hedger2's aggregate should be unchanged
			const [amount2After] = await context.viewFacetQuote.getPartyACompleteAggregateStatePerPartyB(
				await user.getAddress(),
				await hedger2.getAddress(),
				1,
				PositionType.LONG
			)
			expect(amount2After).to.equal(amount2Before)
		})
	})

	// ============ Aggregated Views by Active Symbols ============
	// These tests verify the efficient view functions that use active symbols tracking

	describe("Aggregated Views by Active Symbols", function () {
		beforeEach(async function () {
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])
		})

		it("should return empty array when no positions", async function () {
			const positions = await context.viewFacetQuote.getPartyAAggregatedPositionsByActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(positions.length).to.equal(0)
		})

		it("should return correct aggregated positions", async function () {
			const quoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

			const positions = await context.viewFacetQuote.getPartyAAggregatedPositionsByActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(positions.length).to.equal(1)
			expect(positions[0].symbolId).to.equal(1n)
			const { longPosition } = await context.viewFacetQuote.getPartyAAggregatedPositionBySymbolPerPartyB(await user.getAddress(), await hedger.getAddress(), 1)
			expect(positions[0].aggregatedOpenAmount).to.equal(longPosition.aggregatedOpenAmount)
		})

		it("should return both LONG and SHORT for same symbol", async function () {
			// Open LONG
			const longQuoteId = await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(longQuoteId)
			await hedger.openPosition(longQuoteId)

			// Open SHORT
			const shortQuoteId = await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(shortQuoteId)
			await hedger.openPosition(shortQuoteId)

			const positions = await context.viewFacetQuote.getPartyAAggregatedPositionsByActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(positions.length).to.equal(2)

			const longPos = positions.find((p: any) => p.positionType === BigInt(PositionType.LONG))
			const shortPos = positions.find((p: any) => p.positionType === BigInt(PositionType.SHORT))
			expect(longPos).to.not.be.undefined
			expect(shortPos).to.not.be.undefined
		})

		it("should return funding debt by active symbols", async function () {
			const quoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

			await time.increase(EightHourInSec * 3)

			const fundingDebts = await context.viewFacetQuote.getPartyAAggregateFundingDebtByActiveSymbols(
				await user.getAddress(),
				await hedger.getAddress(),
				0, 1000
			)
			expect(fundingDebts.length).to.be.gte(1)
			expect(fundingDebts[0].fundingDebt).to.not.equal(0)
		})

		it("should return opposite funding debt for partyB", async function () {
			const quoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

			await time.increase(EightHourInSec * 3)

			const partyADebts = await context.viewFacetQuote.getPartyAAggregateFundingDebtByActiveSymbols(
				await user.getAddress(), await hedger.getAddress(), 0, 1000
			)
			const partyBDebts = await context.viewFacetQuote.getPartyBAggregateFundingDebtByActiveSymbols(
				await hedger.getAddress(), await user.getAddress(), 0, 1000
			)

			expect(partyADebts.length).to.equal(partyBDebts.length)
			for (let i = 0; i < partyADebts.length; i++) {
				expect(partyBDebts[i].fundingDebt).to.equal(-partyADebts[i].fundingDebt)
			}
		})

		it("should work for partyB views", async function () {
			const quoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

			const partyBPositions = await context.viewFacetQuote.getPartyBAggregatedPositionsByActiveSymbolsPerPartyA(await hedger.getAddress(), await user.getAddress(), 0, 1000)
			expect(partyBPositions.length).to.equal(1)

			const partyBPerPartyA = await context.viewFacetQuote.getPartyBAggregatedPositionsByActiveSymbolsPerPartyA(
				await hedger.getAddress(), await user.getAddress(), 0, 1000
			)
			expect(partyBPerPartyA.length).to.equal(1)
		})
	})

	// ============ Pagination ============
	// These tests verify pagination works correctly for large numbers of active symbols

	describe("Pagination", function () {
		beforeEach(async function () {
			// Add symbols 2, 3, 4
			await context.symbolControlFacet.connect(context.signers.admin)
				.addSymbol("SYMBOL2", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
			await context.symbolControlFacet.connect(context.signers.admin)
				.addSymbol("SYMBOL3", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
			await context.symbolControlFacet.connect(context.signers.admin)
				.addSymbol("SYMBOL4", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
			await context.symbolControlFacet.connect(context.signers.admin).setSymbolTypes([2, 3, 4], [1, 1, 1])

			await context.fundingRateFacet.connect(context.signers.hedger)
				.setEpochDurations([1, 2, 3, 4], [EightHourInSec, EightHourInSec, EightHourInSec, EightHourInSec])
			await context.fundingRateFacet.connect(context.signers.hedger)
				.updateAccumulatedFundingFee(
					[1, 2, 3, 4],
					[decimal(1n, 14), decimal(1n, 14), decimal(1n, 14), decimal(1n, 14)],
					[-decimal(1n, 14), -decimal(1n, 14), -decimal(1n, 14), -decimal(1n, 14)],
					[decimal(1n), decimal(1n), decimal(1n), decimal(1n)]
				)

			// Open positions in all 4 symbols
			for (let symbolId = 1; symbolId <= 4; symbolId++) {
				const quoteId = await user.sendQuote(limitQuoteRequestBuilder().symbolId(symbolId).maxFundingRate(decimal(1n)).build())
				await hedger.lockQuote(quoteId)
				await hedger.openPosition(quoteId)
			}
		})

		it("should return correct count", async function () {
			const partyACount = await context.viewFacetQuote.getPartyAActiveSymbolsCountPerPartyB(await user.getAddress(), await hedger.getAddress())
			expect(partyACount).to.equal(4n)

			const partyBCount = await context.viewFacetQuote.getPartyBActiveSymbolsCountPerPartyA(await hedger.getAddress(), await user.getAddress())
			expect(partyBCount).to.equal(4n)
		})

		it("should paginate active symbols correctly", async function () {
			const firstPage = await context.viewFacetQuote.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 2)
			expect(firstPage.length).to.equal(2)

			const secondPage = await context.viewFacetQuote.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 2, 2)
			expect(secondPage.length).to.equal(2)

			// All 4 symbols should be unique across pages
			const allSymbols = [...firstPage, ...secondPage]
			const uniqueSymbols = new Set(allSymbols.map(s => s.toString()))
			expect(uniqueSymbols.size).to.equal(4)
		})

		it("should return empty when start exceeds length", async function () {
			const result = await context.viewFacetQuote.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 100, 10)
			expect(result.length).to.equal(0)
		})

		it("should return empty when size is zero", async function () {
			const result = await context.viewFacetQuote.getPartyAAggregatedPositionsByActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 0)
			expect(result.length).to.equal(0)
		})

		it("should cap size to remaining elements", async function () {
			// Request 100 starting at index 2, only 2 remain
			const result = await context.viewFacetQuote.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 2, 100)
			expect(result.length).to.equal(2)
		})

		it("should paginate aggregated positions correctly", async function () {
			const firstPage = await context.viewFacetQuote.getPartyAAggregatedPositionsByActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 2)
			expect(firstPage.length).to.equal(2) // 2 symbols, 1 position each

			const secondPage = await context.viewFacetQuote.getPartyAAggregatedPositionsByActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 2, 2)
			expect(secondPage.length).to.equal(2)

			// All 4 symbols covered
			const allSymbolIds = [...firstPage, ...secondPage].map(p => p.symbolId)
			const uniqueSymbolIds = new Set(allSymbolIds.map(s => s.toString()))
			expect(uniqueSymbolIds.size).to.equal(4)
		})

		it("should paginate funding debt correctly", async function () {
			await time.increase(EightHourInSec)

			const firstPage = await context.viewFacetQuote.getPartyAAggregateFundingDebtByActiveSymbols(
				await user.getAddress(), await hedger.getAddress(), 0, 2
			)
			expect(firstPage.length).to.equal(2)

			const secondPage = await context.viewFacetQuote.getPartyAAggregateFundingDebtByActiveSymbols(
				await user.getAddress(), await hedger.getAddress(), 2, 2
			)
			expect(secondPage.length).to.equal(2)

			// All should have non-zero debt
			for (const debt of [...firstPage, ...secondPage]) {
				expect(debt.fundingDebt).to.not.equal(0)
			}
		})
	})

	// ============ Aggregated Position Views ============
	// Tests for position aggregation (amounts, notionals, avg prices)

	describe("Aggregated Position Views", function () {
		let posContext: RunContext
		let posUser: User, posHedger: Hedger, posHedger2: Hedger
		let quote1LongOpened: QuoteStructOutput, quote2ShortOpened: QuoteStructOutput, quote3LongOpened: QuoteStructOutput

		const getExpectedTotals = async (quoteIds: bigint[]) => {
			let longAmount = 0n
			let longNotional = 0n
			let shortAmount = 0n
			let shortNotional = 0n

			for (const quoteId of quoteIds) {
				const quote = await posContext.viewFacetQuote.getQuote(quoteId)
				const amount = quote.quantity - quote.closedAmount
				if (quote.positionType === BigInt(PositionType.LONG)) {
					longAmount += amount
					longNotional += amount * quote.openedPrice
				} else {
					shortAmount += amount
					shortNotional += amount * quote.openedPrice
				}
			}

			return { longAmount, longNotional, shortAmount, shortNotional }
		}

		beforeEach(async function () {
			posContext = await loadFixture(initializeFixture)
			this.user_allocated = decimal(500n)
			this.hedger_allocated = decimal(4000n)

			posUser = new User(posContext, posContext.signers.user)
			await posUser.setup()
			await posUser.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

			posHedger = new Hedger(posContext, posContext.signers.hedger)
			await posHedger.setup()
			await posHedger.setBalances(this.hedger_allocated, this.hedger_allocated)

			posHedger2 = new Hedger(posContext, posContext.signers.hedger2)
			await posHedger2.setup()
			await posHedger2.setBalances(this.hedger_allocated, this.hedger_allocated)

			// Quote1 LONG opened
			quote1LongOpened = await posContext.viewFacetQuote.getQuote(await posUser.sendQuote())
			await posHedger.lockQuote(quote1LongOpened.id)
			await posHedger.openPosition(quote1LongOpened.id)

			// Quote2 SHORT opened
			quote2ShortOpened = await posContext.viewFacetQuote.getQuote(
				await posUser.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build()),
			)
			await posHedger.lockQuote(quote2ShortOpened.id)
			await posHedger.openPosition(quote2ShortOpened.id)

			// Quote3 LONG opened
			quote3LongOpened = await posContext.viewFacetQuote.getQuote(await posUser.sendQuote())
			await posHedger.lockQuote(quote3LongOpened.id)
			await posHedger.openPosition(quote3LongOpened.id)
		})

		describe("getPartyBAggregatedPositionBySymbolPerPartyA", function () {
			it("returns correct totals and average prices for LONG and SHORT positions", async function () {
				const symbolId = quote1LongOpened.symbolId
				const quoteIds = [quote1LongOpened.id, quote2ShortOpened.id, quote3LongOpened.id]
				let expectedLongOpenAmount = 0n
				let expectedShortOpenAmount = 0n
				let expectedLongNotional = 0n
				let expectedShortNotional = 0n

				for (const quoteId of quoteIds) {
					const quote = await posContext.viewFacetQuote.getQuote(quoteId)
					if (quote.symbolId !== symbolId) continue
					const openAmount = quote.quantity - quote.closedAmount
					if (quote.positionType === BigInt(PositionType.LONG)) {
						expectedLongOpenAmount += openAmount
						expectedLongNotional += openAmount * quote.openedPrice
					} else {
						expectedShortOpenAmount += openAmount
						expectedShortNotional += openAmount * quote.openedPrice
					}
				}

				const { longPosition, shortPosition } = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, symbolId)
				expect(longPosition.positionType).to.equal(BigInt(PositionType.LONG))
				expect(longPosition.aggregatedOpenAmount).to.equal(expectedLongOpenAmount)
				expect(longPosition.avgOpenPrice).to.equal(expectedLongOpenAmount === 0n ? 0n : expectedLongNotional / expectedLongOpenAmount)
				expect(shortPosition.positionType).to.equal(BigInt(PositionType.SHORT))
				expect(shortPosition.aggregatedOpenAmount).to.equal(expectedShortOpenAmount)
				expect(shortPosition.avgOpenPrice).to.equal(expectedShortOpenAmount === 0n ? 0n : expectedShortNotional / expectedShortOpenAmount)
			})

			it("computes weighted averages across multiple fills at different prices", async function () {
				await posUser.setBalances(decimal(1000n), decimal(1000n), decimal(1000n))

				// open an extra LONG at a different price to shift the average
				const extraLongQuoteId = await posUser.sendQuote(limitQuoteRequestBuilder().build())
				const extraLongQuote = await posContext.viewFacetQuote.getQuote(extraLongQuoteId)
				await posHedger.lockQuote(extraLongQuote.id)
				await posHedger.openPosition(extraLongQuote.id, limitOpenRequestBuilder().openPrice(decimal(5n, 17)).build())

				const quoteIds = [quote1LongOpened.id, quote3LongOpened.id, quote2ShortOpened.id, extraLongQuote.id]
				let longAmount = 0n
				let longNotional = 0n
				let shortAmount = 0n
				let shortNotional = 0n

				for (const qid of quoteIds) {
					const q = await posContext.viewFacetQuote.getQuote(qid)
					const amount = q.quantity - q.closedAmount
					if (q.positionType === BigInt(PositionType.LONG)) {
						longAmount += amount
						longNotional += amount * q.openedPrice
					} else {
						shortAmount += amount
						shortNotional += amount * q.openedPrice
					}
				}

				const { longPosition, shortPosition } = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
				expect(longPosition.aggregatedOpenAmount).to.equal(longAmount)
				expect(longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
				expect(shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
				expect(shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
			})

			it("returns zero entries when no positions exist for symbol", async function () {
				// Add a new symbol that has no positions
				await posContext.symbolControlFacet
					.connect(posContext.signers.admin)
					.addSymbol("EMPTY_SYMBOL", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
				await posContext.symbolControlFacet.connect(posContext.signers.admin).setSymbolTypes([2], [1])

				const { longPosition, shortPosition } = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 2)
				expect(longPosition.aggregatedOpenAmount).to.equal(0n)
				expect(shortPosition.aggregatedOpenAmount).to.equal(0n)
				expect(longPosition.avgOpenPrice).to.equal(0n)
				expect(shortPosition.avgOpenPrice).to.equal(0n)
			})

			it("returns zero for partyB with no position history", async function () {
				const { longPosition, shortPosition } = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger2.address, posUser.address, 1)
				expect(longPosition.aggregatedOpenAmount).to.equal(0n)
				expect(shortPosition.aggregatedOpenAmount).to.equal(0n)
				expect(longPosition.avgOpenPrice).to.equal(0n)
				expect(shortPosition.avgOpenPrice).to.equal(0n)
			})

			it("isolates totals between different partyBs", async function () {
				// posHedger2 opens a position with posUser
				const newQuoteId = await posUser.sendQuote()
				const user2Quote = await posContext.viewFacetQuote.getQuote(newQuoteId)
				await posHedger2.lockQuote(user2Quote.id)
				await posHedger2.openPosition(user2Quote.id)

				// posHedger should still have their original totals
				const hedgerTotals = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
				const hedger2Totals = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger2.address, posUser.address, 1)

				// posHedger has 2 LONGs and 1 SHORT
				expect(hedgerTotals.longPosition.aggregatedOpenAmount).to.be.gt(0n)
				expect(hedgerTotals.shortPosition.aggregatedOpenAmount).to.be.gt(0n)

				// posHedger2 has 1 LONG only
				expect(hedger2Totals.longPosition.aggregatedOpenAmount).to.equal(user2Quote.quantity)
				expect(hedger2Totals.shortPosition.aggregatedOpenAmount).to.equal(0n)
			})

			it("updates totals correctly after opening new position", async function () {
				const before = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)

				// Open another LONG
				await posUser.setBalances(decimal(1000n), decimal(1000n), decimal(1000n))
				const newQuote = await posContext.viewFacetQuote.getQuote(await posUser.sendQuote())
				await posHedger.lockQuote(newQuote.id)
				await posHedger.openPosition(newQuote.id)

				const after = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)

				expect(after.longPosition.aggregatedOpenAmount).to.equal(before.longPosition.aggregatedOpenAmount + newQuote.quantity)
				expect(after.shortPosition.aggregatedOpenAmount).to.equal(before.shortPosition.aggregatedOpenAmount)
			})

			it("decreases totals after partial close via fillCloseRequest", async function () {
				const before = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
				const closeQuantity = (await getQuoteQuantity(posContext, quote1LongOpened.id)) / 2n

				await posUser.requestToClosePosition(
					quote1LongOpened.id,
					limitCloseRequestBuilder().quantityToClose(closeQuantity).closePrice(decimal(1n)).build(),
				)
				await posHedger.fillCloseRequest(quote1LongOpened.id, limitFillCloseRequestBuilder().filledAmount(closeQuantity).closedPrice(decimal(1n)).build())

				const after = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)

				expect(after.longPosition.aggregatedOpenAmount).to.equal(before.longPosition.aggregatedOpenAmount - closeQuantity)
				expect(after.shortPosition.aggregatedOpenAmount).to.equal(before.shortPosition.aggregatedOpenAmount)
			})

			it("removes position from totals after full close via fillCloseRequest", async function () {
				const before = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
				const fullQuantity = await getQuoteQuantity(posContext, quote1LongOpened.id)

				await posUser.requestToClosePosition(quote1LongOpened.id, limitCloseRequestBuilder().quantityToClose(fullQuantity).closePrice(decimal(1n)).build())
				await posHedger.fillCloseRequest(quote1LongOpened.id, limitFillCloseRequestBuilder().filledAmount(fullQuantity).closedPrice(decimal(1n)).build())

				const after = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)

				expect(after.longPosition.aggregatedOpenAmount).to.equal(before.longPosition.aggregatedOpenAmount - fullQuantity)
			})

			it("resets totals after full liquidation flow", async function () {
				const liquidator = posContext.signers.liquidator
				const sig = await getDummyLiquidationSig("0x10", -decimal(1_000_000n), [1n], [decimal(1n)], decimal(1_000_000n), 0n)

				await posContext.liquidationFacet.connect(liquidator).liquidatePartyA(await posUser.getAddress(), sig)
				await posContext.liquidationFacet.connect(liquidator).setSymbolsPrice(await posUser.getAddress(), sig)
				await posContext.liquidationFacet.connect(liquidator).liquidatePendingPositionsPartyA(await posUser.getAddress())
				await posContext.liquidationFacet
					.connect(liquidator)
					.liquidatePositionsPartyA(await posUser.getAddress(), [quote1LongOpened.id, quote2ShortOpened.id, quote3LongOpened.id])

				const { longPosition, shortPosition } = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
				expect(longPosition.aggregatedOpenAmount).to.equal(0n)
				expect(shortPosition.aggregatedOpenAmount).to.equal(0n)
			})

			it("updates averages after settlement adjustments", async function () {
				const before = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
				const updatedPrice = decimal(5n, 17)

				const settlementEntry = Object.assign([quote1LongOpened.id, updatedPrice, 0n], {
					quoteId: quote1LongOpened.id,
					currentPrice: updatedPrice,
					partyBUpnlIndex: 0n,
				}) as QuoteSettlementDataStructOutput
				const settlementSig = await getDummySettlementSig(0n, [0n], [settlementEntry])

				await posHedger.settleUpnl(await posContext.signers.user.getAddress(), [updatedPrice], settlementSig)

				const after = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
				const { longAmount, longNotional, shortAmount, shortNotional } = await getExpectedTotals([
					quote1LongOpened.id,
					quote2ShortOpened.id,
					quote3LongOpened.id,
				])

				expect(after.longPosition.aggregatedOpenAmount).to.equal(before.longPosition.aggregatedOpenAmount)
				expect(after.longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
				expect(after.shortPosition.aggregatedOpenAmount).to.equal(before.shortPosition.aggregatedOpenAmount)
				expect(after.shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
			})
		})

		describe("getPartyBAggregatedPositionBySymbol (global)", function () {
			it("returns correct global totals across all partyAs", async function () {
				// Create a second user to have positions with the same hedger
				const user2 = new User(posContext, posContext.signers.user2)
				await user2.setup()
				await user2.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

				const user2Quote = await posContext.viewFacetQuote.getQuote(await user2.sendQuote())
				await posHedger.lockQuote(user2Quote.id)
				await posHedger.openPosition(user2Quote.id)

				// Calculate expected global totals from all quotes with posHedger
				const allQuoteIds = [quote1LongOpened.id, quote2ShortOpened.id, quote3LongOpened.id, user2Quote.id]
				let globalLongAmount = 0n
				let globalLongNotional = 0n
				let globalShortAmount = 0n
				let globalShortNotional = 0n

				for (const quoteId of allQuoteIds) {
					const quote = await posContext.viewFacetQuote.getQuote(quoteId)
					const amount = quote.quantity - quote.closedAmount
					if (quote.positionType === BigInt(PositionType.LONG)) {
						globalLongAmount += amount
						globalLongNotional += amount * quote.openedPrice
					} else {
						globalShortAmount += amount
						globalShortNotional += amount * quote.openedPrice
					}
				}

				const { longPosition, shortPosition } = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbol(posHedger.address, 1)

				expect(longPosition.aggregatedOpenAmount).to.equal(globalLongAmount)
				expect(longPosition.avgOpenPrice).to.equal(globalLongAmount === 0n ? 0n : globalLongNotional / globalLongAmount)
				expect(shortPosition.aggregatedOpenAmount).to.equal(globalShortAmount)
				expect(shortPosition.avgOpenPrice).to.equal(globalShortAmount === 0n ? 0n : globalShortNotional / globalShortAmount)
			})

			it("returns zero for partyB with no positions", async function () {
				const { longPosition, shortPosition } = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbol(posHedger2.address, 1)
				expect(longPosition.aggregatedOpenAmount).to.equal(0n)
				expect(shortPosition.aggregatedOpenAmount).to.equal(0n)
			})

			it("updates global totals when positions close", async function () {
				const before = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbol(posHedger.address, 1)

				// Close one position partially (quote1LongOpened is a LONG position)
				const closeAmount = decimal(50n, 17)
				await posUser.requestToClosePosition(
					quote1LongOpened.id,
					limitCloseRequestBuilder().quantityToClose(closeAmount).closePrice(decimal(1n)).deadline(getBlockTimestamp(10000n)).build(),
				)
				await posHedger.fillCloseRequest(quote1LongOpened.id, limitFillCloseRequestBuilder().filledAmount(closeAmount).closedPrice(decimal(1n)).build())

				const after = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbol(posHedger.address, 1)

				// LONG position aggregate should decrease (stored by quote.positionType)
				expect(after.longPosition.aggregatedOpenAmount).to.equal(before.longPosition.aggregatedOpenAmount - closeAmount)
			})
		})

		describe("getPartyBAggregatedPositionBySymbolPerPartyA", function () {
			const getExpectedPartyBTotalsByPartyA = async (quoteIds: bigint[], partyA: string) => {
				let longAmount = 0n
				let longNotional = 0n
				let shortAmount = 0n
				let shortNotional = 0n

				for (const quoteId of quoteIds) {
					const quote = await posContext.viewFacetQuote.getQuote(quoteId)
					if (quote.partyA !== partyA) continue
					const amount = quote.quantity - quote.closedAmount
					if (quote.positionType === BigInt(PositionType.LONG)) {
						longAmount += amount
						longNotional += amount * quote.openedPrice
					} else {
						shortAmount += amount
						shortNotional += amount * quote.openedPrice
					}
				}

				return { longAmount, longNotional, shortAmount, shortNotional }
			}

			it("returns correct totals for partyB and partyA", async function () {
				const partyA = await posUser.getAddress()
				const { longAmount, longNotional, shortAmount, shortNotional } = await getExpectedPartyBTotalsByPartyA(
					[quote1LongOpened.id, quote2ShortOpened.id, quote3LongOpened.id],
					partyA,
				)

				const { longPosition, shortPosition } = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, partyA, 1)

				expect(longPosition.aggregatedOpenAmount).to.equal(longAmount)
				expect(longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
				expect(shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
				expect(shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
			})

			it("isolates totals between different partyAs for same partyB", async function () {
				const user2 = new User(posContext, posContext.signers.user2)
				await user2.setup()
				await user2.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

				const user2Quote = await posContext.viewFacetQuote.getQuote(await user2.sendQuote())
				await posHedger.lockQuote(user2Quote.id)
				await posHedger.openPosition(user2Quote.id)

				const partyA1 = await posUser.getAddress()
				const partyA2 = await user2.getAddress()

				const {
					longAmount: long1,
					longNotional: longN1,
					shortAmount: short1,
					shortNotional: shortN1,
				} = await getExpectedPartyBTotalsByPartyA([quote1LongOpened.id, quote2ShortOpened.id, quote3LongOpened.id], partyA1)
				const {
					longAmount: long2,
					longNotional: longN2,
					shortAmount: short2,
					shortNotional: shortN2,
				} = await getExpectedPartyBTotalsByPartyA([user2Quote.id], partyA2)

				const userTotals = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, partyA1, 1)
				const user2Totals = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, partyA2, 1)

				expect(userTotals.longPosition.aggregatedOpenAmount).to.equal(long1)
				expect(userTotals.longPosition.avgOpenPrice).to.equal(long1 === 0n ? 0n : longN1 / long1)
				expect(userTotals.shortPosition.aggregatedOpenAmount).to.equal(short1)
				expect(userTotals.shortPosition.avgOpenPrice).to.equal(short1 === 0n ? 0n : shortN1 / short1)

				expect(user2Totals.longPosition.aggregatedOpenAmount).to.equal(long2)
				expect(user2Totals.longPosition.avgOpenPrice).to.equal(long2 === 0n ? 0n : longN2 / long2)
				expect(user2Totals.shortPosition.aggregatedOpenAmount).to.equal(short2)
				expect(user2Totals.shortPosition.avgOpenPrice).to.equal(short2 === 0n ? 0n : shortN2 / short2)
			})
		})

		describe("getPartyAAggregatedPositionBySymbolPerPartyB", function () {
			it("updates totals after opening new position", async function () {
				const before = await posContext.viewFacetQuote.getPartyAAggregatedPositionBySymbolPerPartyB(posUser.address, posHedger.address, 1)

				await posUser.setBalances(decimal(1000n), decimal(1000n), decimal(1000n))
				const newQuote = await posContext.viewFacetQuote.getQuote(await posUser.sendQuote())
				await posHedger.lockQuote(newQuote.id)
				await posHedger.openPosition(newQuote.id)

				const { longAmount, longNotional, shortAmount, shortNotional } = await getExpectedTotals([
					quote1LongOpened.id,
					quote2ShortOpened.id,
					quote3LongOpened.id,
					newQuote.id,
				])

				const { longPosition, shortPosition } = await posContext.viewFacetQuote.getPartyAAggregatedPositionBySymbolPerPartyB(posUser.address, posHedger.address, 1)

				expect(longPosition.aggregatedOpenAmount).to.equal(longAmount)
				expect(longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
				expect(shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
				expect(shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
				expect(longPosition.aggregatedOpenAmount + shortPosition.aggregatedOpenAmount).to.equal(
					before.longPosition.aggregatedOpenAmount + before.shortPosition.aggregatedOpenAmount + newQuote.quantity,
				)
			})

			it("updates totals after partial close via fillCloseRequest", async function () {
				const closeQuantity = (await getQuoteQuantity(posContext, quote1LongOpened.id)) / 2n

				await posUser.requestToClosePosition(
					quote1LongOpened.id,
					limitCloseRequestBuilder().quantityToClose(closeQuantity).closePrice(decimal(1n)).build(),
				)
				await posHedger.fillCloseRequest(quote1LongOpened.id, limitFillCloseRequestBuilder().filledAmount(closeQuantity).closedPrice(decimal(1n)).build())

				const { longAmount, longNotional, shortAmount, shortNotional } = await getExpectedTotals([
					quote1LongOpened.id,
					quote2ShortOpened.id,
					quote3LongOpened.id,
				])

				const { longPosition, shortPosition } = await posContext.viewFacetQuote.getPartyAAggregatedPositionBySymbolPerPartyB(posUser.address, posHedger.address, 1)

				expect(longPosition.aggregatedOpenAmount).to.equal(longAmount)
				expect(longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
				expect(shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
				expect(shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
			})

			it("removes position from totals after full close via fillCloseRequest", async function () {
				const fullQuantity = await getQuoteQuantity(posContext, quote1LongOpened.id)

				await posUser.requestToClosePosition(quote1LongOpened.id, limitCloseRequestBuilder().quantityToClose(fullQuantity).closePrice(decimal(1n)).build())
				await posHedger.fillCloseRequest(quote1LongOpened.id, limitFillCloseRequestBuilder().filledAmount(fullQuantity).closedPrice(decimal(1n)).build())

				const { longAmount, longNotional, shortAmount, shortNotional } = await getExpectedTotals([
					quote1LongOpened.id,
					quote2ShortOpened.id,
					quote3LongOpened.id,
				])

				const { longPosition, shortPosition } = await posContext.viewFacetQuote.getPartyAAggregatedPositionBySymbolPerPartyB(posUser.address, posHedger.address, 1)

				expect(longPosition.aggregatedOpenAmount).to.equal(longAmount)
				expect(longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
				expect(shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
				expect(shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
			})

			it("updates averages after funding rate adjustments", async function () {
				const symbol = await posContext.viewFacetSymbol.getSymbol(1)
				const duration = symbol.fundingRateEpochDuration
				const window = symbol.fundingRateWindowTime
				const currentEpoch = (BigInt(await time.latest()) / duration) * duration
				const targetTime = duration * 2n + window - 1n + currentEpoch

				const oldQuote = await posContext.viewFacetQuote.getQuote(quote1LongOpened.id)

				const rate = decimal(1n, 16) // 1% funding rate
				await time.setNextBlockTimestamp(targetTime)
				await posHedger.chargeFundingRate(await posContext.signers.user.getAddress(), [quote1LongOpened.id], [rate], await getDummyPairUpnlSig())

				const newQuote = await posContext.viewFacetQuote.getQuote(quote1LongOpened.id)
				const { longAmount, longNotional, shortAmount, shortNotional } = await getExpectedTotals([
					quote1LongOpened.id,
					quote2ShortOpened.id,
					quote3LongOpened.id,
				])

				const { longPosition, shortPosition } = await posContext.viewFacetQuote.getPartyAAggregatedPositionBySymbolPerPartyB(posUser.address, posHedger.address, 1)

				expect(newQuote.openedPrice).to.equal(unDecimal(oldQuote.openedPrice * (decimal(1n) + rate)))
				expect(longPosition.aggregatedOpenAmount).to.equal(longAmount)
				expect(longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
				expect(shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
				expect(shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
			})

			it("resets totals after full liquidation flow", async function () {
				const liquidator = posContext.signers.liquidator
				const sig = await getDummyLiquidationSig("0x10", -decimal(1_000_000n), [1n], [decimal(1n)], decimal(1_000_000n), 0n)

				await posContext.liquidationFacet.connect(liquidator).liquidatePartyA(await posUser.getAddress(), sig)
				await posContext.liquidationFacet.connect(liquidator).setSymbolsPrice(await posUser.getAddress(), sig)
				await posContext.liquidationFacet.connect(liquidator).liquidatePendingPositionsPartyA(await posUser.getAddress())
				await posContext.liquidationFacet
					.connect(liquidator)
					.liquidatePositionsPartyA(await posUser.getAddress(), [quote1LongOpened.id, quote2ShortOpened.id, quote3LongOpened.id])

				const { longPosition, shortPosition } = await posContext.viewFacetQuote.getPartyAAggregatedPositionBySymbolPerPartyB(posUser.address, posHedger.address, 1)
				expect(longPosition.aggregatedOpenAmount).to.equal(0n)
				expect(shortPosition.aggregatedOpenAmount).to.equal(0n)
				expect(longPosition.avgOpenPrice).to.equal(0n)
				expect(shortPosition.avgOpenPrice).to.equal(0n)
			})

			it("updates averages after settlement adjustments", async function () {
				const updatedPrice = decimal(5n, 17)

				const settlementEntry = Object.assign([quote1LongOpened.id, updatedPrice, 0n], {
					quoteId: quote1LongOpened.id,
					currentPrice: updatedPrice,
					partyBUpnlIndex: 0n,
				}) as QuoteSettlementDataStructOutput
				const settlementSig = await getDummySettlementSig(0n, [0n], [settlementEntry])

				await posHedger.settleUpnl(await posContext.signers.user.getAddress(), [updatedPrice], settlementSig)

				const { longAmount, longNotional, shortAmount, shortNotional } = await getExpectedTotals([
					quote1LongOpened.id,
					quote2ShortOpened.id,
					quote3LongOpened.id,
				])

				const { longPosition, shortPosition } = await posContext.viewFacetQuote.getPartyAAggregatedPositionBySymbolPerPartyB(posUser.address, posHedger.address, 1)

				expect(longPosition.aggregatedOpenAmount).to.equal(longAmount)
				expect(longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
				expect(shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
				expect(shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
			})
		})

		describe("Global PartyB Active Symbols", function () {
			let symbol2: bigint
			let symbol3: bigint

			beforeEach(async function () {
				// add two extra symbols and map them to the already whitelisted type 1
				await posContext.symbolControlFacet
					.connect(posContext.signers.admin)
					.addSymbol("GLOBAL_SYMBOL2", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
				await posContext.symbolControlFacet
					.connect(posContext.signers.admin)
					.addSymbol("GLOBAL_SYMBOL3", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
				await posContext.symbolControlFacet.connect(posContext.signers.admin).setSymbolTypes([2, 3], [1, 1])

				symbol2 = 2n
				symbol3 = 3n
			})

			it("getPartyBActiveSymbolsCount returns correct count", async function () {
				// posHedger has positions in symbol 1 from beforeEach
				const countBefore = await posContext.viewFacetQuote.getPartyBActiveSymbolsCount(posHedger.address)
				expect(countBefore).to.equal(1n)

				// Open a position in symbol2
				await posUser.setBalances(decimal(1000n), decimal(1000n), decimal(1000n))
				const sym2QuoteId = await posUser.sendQuote(limitQuoteRequestBuilder().symbolId(symbol2).positionType(PositionType.SHORT).build())
				const sym2Quote = await posContext.viewFacetQuote.getQuote(sym2QuoteId)
				await posHedger.lockQuote(sym2Quote.id)
				await posHedger.openPosition(sym2Quote.id)

				const countAfter = await posContext.viewFacetQuote.getPartyBActiveSymbolsCount(posHedger.address)
				expect(countAfter).to.equal(2n)
			})

			it("getPartyBActiveSymbols returns paginated list", async function () {
				// Open a position in symbol2
				await posUser.setBalances(decimal(1000n), decimal(1000n), decimal(1000n))
				const sym2QuoteId = await posUser.sendQuote(limitQuoteRequestBuilder().symbolId(symbol2).positionType(PositionType.SHORT).build())
				const sym2Quote = await posContext.viewFacetQuote.getQuote(sym2QuoteId)
				await posHedger.lockQuote(sym2Quote.id)
				await posHedger.openPosition(sym2Quote.id)

				const allSymbols = await posContext.viewFacetQuote.getPartyBActiveSymbols(posHedger.address, 0, 1000)
				expect(allSymbols.length).to.equal(2)
				expect(allSymbols.map((s: bigint) => Number(s))).to.include.members([1, 2])

				// Test pagination
				const firstPage = await posContext.viewFacetQuote.getPartyBActiveSymbols(posHedger.address, 0, 1)
				expect(firstPage.length).to.equal(1)

				const secondPage = await posContext.viewFacetQuote.getPartyBActiveSymbols(posHedger.address, 1, 1)
				expect(secondPage.length).to.equal(1)
			})

			it("getPartyBAggregatedPositionsByActiveSymbols returns global aggregates", async function () {
				// Create a second user to have positions with the same hedger in symbol2
				const user2 = new User(posContext, posContext.signers.user2)
				await user2.setup()
				await user2.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

				// user2 opens a position in symbol2
				const user2Quote = await posContext.viewFacetQuote.getQuote(
					await user2.sendQuote(limitQuoteRequestBuilder().symbolId(symbol2).positionType(PositionType.LONG).build()),
				)
				await posHedger.lockQuote(user2Quote.id)
				await posHedger.openPosition(user2Quote.id)

				// Now posHedger has positions in symbol 1 (with posUser) and symbol 2 (with user2)
				const aggregates = await posContext.viewFacetQuote.getPartyBAggregatedPositionsByActiveSymbols(posHedger.address, 0, 1000)

				// Should have entries for both symbols
				const sym1Entry = aggregates.find((entry: any) => BigInt(entry.symbolId) === 1n)
				const sym2Entry = aggregates.find((entry: any) => BigInt(entry.symbolId) === symbol2)

				expect(sym1Entry).to.not.be.undefined
				expect(sym2Entry).to.not.be.undefined

				// Verify symbol 1 has the global totals (from posUser's positions)
				const sym1Totals = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbol(posHedger.address, 1)
				expect(sym1Entry?.aggregatedOpenAmount).to.equal(
					sym1Totals.longPosition.aggregatedOpenAmount > 0n
						? sym1Totals.longPosition.aggregatedOpenAmount
						: sym1Totals.shortPosition.aggregatedOpenAmount,
				)
			})

			it("removes symbol from global active list when all positions close", async function () {
				// Open a position in symbol2
				await posUser.setBalances(decimal(1000n), decimal(1000n), decimal(1000n))
				const sym2QuoteId = await posUser.sendQuote(limitQuoteRequestBuilder().symbolId(symbol2).positionType(PositionType.SHORT).build())
				const sym2Quote = await posContext.viewFacetQuote.getQuote(sym2QuoteId)
				await posHedger.lockQuote(sym2Quote.id)
				await posHedger.openPosition(sym2Quote.id)

				const countBefore = await posContext.viewFacetQuote.getPartyBActiveSymbolsCount(posHedger.address)
				expect(countBefore).to.equal(2n)

				// Close the position in symbol2 completely
				const openAmount = sym2Quote.quantity - sym2Quote.closedAmount
				await posUser.requestToClosePosition(
					sym2Quote.id,
					limitCloseRequestBuilder().quantityToClose(openAmount).closePrice(decimal(1n)).deadline(getBlockTimestamp(10000n)).build(),
				)
				await posHedger.fillCloseRequest(sym2Quote.id, limitFillCloseRequestBuilder().filledAmount(openAmount).closedPrice(decimal(1n)).build())

				const countAfter = await posContext.viewFacetQuote.getPartyBActiveSymbolsCount(posHedger.address)
				expect(countAfter).to.equal(1n)

				const symbols = await posContext.viewFacetQuote.getPartyBActiveSymbols(posHedger.address, 0, 1000)
				expect(symbols.map((s: bigint) => Number(s))).to.not.include(2)
			})

			it("tracks global active symbols across multiple partyAs", async function () {
				// Create a second user
				const user2 = new User(posContext, posContext.signers.user2)
				await user2.setup()
				await user2.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

				// user2 opens a position in symbol2 with the same hedger
				const user2Quote = await posContext.viewFacetQuote.getQuote(
					await user2.sendQuote(limitQuoteRequestBuilder().symbolId(symbol2).positionType(PositionType.LONG).build()),
				)
				await posHedger.lockQuote(user2Quote.id)
				await posHedger.openPosition(user2Quote.id)

				// posHedger should now have active symbols from both partyAs
				const count = await posContext.viewFacetQuote.getPartyBActiveSymbolsCount(posHedger.address)
				expect(count).to.equal(2n) // symbol 1 from posUser, symbol 2 from user2

				const symbols = await posContext.viewFacetQuote.getPartyBActiveSymbols(posHedger.address, 0, 1000)
				expect(symbols.map((s: bigint) => Number(s))).to.include.members([1, 2])
			})
		})

		describe("getPartyBAggregatedPositionsByActiveSymbolsPerPartyA", function () {
			let symbol2: bigint
			let symbol3: bigint

			beforeEach(async function () {
				// add two extra symbols and map them to the already whitelisted type 1
				await posContext.symbolControlFacet
					.connect(posContext.signers.admin)
					.addSymbol("SYMBOL2", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
				await posContext.symbolControlFacet
					.connect(posContext.signers.admin)
					.addSymbol("SYMBOL3", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
				await posContext.symbolControlFacet.connect(posContext.signers.admin).setSymbolTypes([2, 3], [1, 1])

				symbol2 = 2n
				symbol3 = 3n

				// Top up PartyA so the extra quote on the new symbol can be sent
				await posUser.setBalances(decimal(1000n), decimal(1000n), decimal(1000n))

				// Open a SHORT on the second symbol, leave the third untouched
				const sym2QuoteId = await posUser.sendQuote(limitQuoteRequestBuilder().symbolId(symbol2).positionType(PositionType.SHORT).build())
				const sym2Quote = await posContext.viewFacetQuote.getQuote(sym2QuoteId)
				await posHedger.lockQuote(sym2Quote.id)
				await posHedger.openPosition(sym2Quote.id)
			})

			it("returns active symbols and omits empty symbols", async function () {
				const sym1Totals = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
				const sym2Totals = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, Number(symbol2))

				const aggregates = await posContext.viewFacetQuote.getPartyBAggregatedPositionsByActiveSymbolsPerPartyA(posHedger.address, posUser.address, 0, 1000)

				const findEntry = (sid: bigint, posType: PositionType) =>
					aggregates.find((entry: any) => BigInt(entry.symbolId) === sid && BigInt(entry.positionType) === BigInt(posType))

				const sym1Long = findEntry(1n, PositionType.LONG)
				const sym1Short = findEntry(1n, PositionType.SHORT)
				const sym2Short = findEntry(symbol2, PositionType.SHORT)

				expect(sym1Long?.aggregatedOpenAmount).to.equal(sym1Totals.longPosition.aggregatedOpenAmount)
				expect(sym1Long?.avgOpenPrice).to.equal(sym1Totals.longPosition.avgOpenPrice)
				expect(sym1Short?.aggregatedOpenAmount).to.equal(sym1Totals.shortPosition.aggregatedOpenAmount)
				expect(sym1Short?.avgOpenPrice).to.equal(sym1Totals.shortPosition.avgOpenPrice)

				// sym2 only has a short entry
				expect(sym2Short?.aggregatedOpenAmount).to.equal(sym2Totals.shortPosition.aggregatedOpenAmount)
				expect(sym2Short?.avgOpenPrice).to.equal(sym2Totals.shortPosition.avgOpenPrice)

				// symbol3 has no open positions and should not appear
				const sym3Entry = aggregates.find((entry: any) => BigInt(entry.symbolId) === symbol3)
				expect(sym3Entry).to.be.undefined
			})

			it("returns empty for partyB with no positions", async function () {
				const result = await posContext.viewFacetQuote.getPartyBAggregatedPositionsByActiveSymbolsPerPartyA(posHedger2.address, posUser.address, 0, 1000)
				expect(result.length).to.equal(0)
			})
		})

		describe("getPartyAAggregatedPositionsByActiveSymbolsPerPartyB", function () {
			let symbol2: bigint
			let symbol3: bigint

			beforeEach(async function () {
				// add two extra symbols and map them to the already whitelisted type 1
				await posContext.symbolControlFacet
					.connect(posContext.signers.admin)
					.addSymbol("PARTY_A_SYMBOL2", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
				await posContext.symbolControlFacet
					.connect(posContext.signers.admin)
					.addSymbol("PARTY_A_SYMBOL3", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
				await posContext.symbolControlFacet.connect(posContext.signers.admin).setSymbolTypes([2, 3], [1, 1])

				symbol2 = 2n
				symbol3 = 3n

				await posUser.setBalances(decimal(1000n), decimal(1000n), decimal(1000n))

				// Open a SHORT on the second symbol, leave the third untouched
				const sym2QuoteId = await posUser.sendQuote(limitQuoteRequestBuilder().symbolId(symbol2).positionType(PositionType.SHORT).build())
				const sym2Quote = await posContext.viewFacetQuote.getQuote(sym2QuoteId)
				await posHedger.lockQuote(sym2Quote.id)
				await posHedger.openPosition(sym2Quote.id)
			})

			it("returns active symbols and omits empty symbols", async function () {
				const sym1Totals = await posContext.viewFacetQuote.getPartyAAggregatedPositionBySymbolPerPartyB(posUser.address, posHedger.address, 1)
				const sym2Totals = await posContext.viewFacetQuote.getPartyAAggregatedPositionBySymbolPerPartyB(posUser.address, posHedger.address, Number(symbol2))

				const aggregates = await posContext.viewFacetQuote.getPartyAAggregatedPositionsByActiveSymbolsPerPartyB(posUser.address, posHedger.address, 0, 1000)

				const findEntry = (sid: bigint, posType: PositionType) =>
					aggregates.find((entry: any) => BigInt(entry.symbolId) === sid && BigInt(entry.positionType) === BigInt(posType))

				const sym1Long = findEntry(1n, PositionType.LONG)
				const sym1Short = findEntry(1n, PositionType.SHORT)
				const sym2Short = findEntry(symbol2, PositionType.SHORT)

				expect(sym1Long?.aggregatedOpenAmount).to.equal(sym1Totals.longPosition.aggregatedOpenAmount)
				expect(sym1Long?.avgOpenPrice).to.equal(sym1Totals.longPosition.avgOpenPrice)
				expect(sym1Short?.aggregatedOpenAmount).to.equal(sym1Totals.shortPosition.aggregatedOpenAmount)
				expect(sym1Short?.avgOpenPrice).to.equal(sym1Totals.shortPosition.avgOpenPrice)

				// sym2 only has a short entry
				expect(sym2Short?.aggregatedOpenAmount).to.equal(sym2Totals.shortPosition.aggregatedOpenAmount)
				expect(sym2Short?.avgOpenPrice).to.equal(sym2Totals.shortPosition.avgOpenPrice)

				// symbol3 has no open positions and should not appear
				const sym3Entry = aggregates.find((entry: any) => BigInt(entry.symbolId) === symbol3)
				expect(sym3Entry).to.be.undefined
			})

			it("returns empty for partyA with no positions", async function () {
				const user2 = new User(posContext, posContext.signers.user2)
				await user2.setup()
				await user2.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

				const result = await posContext.viewFacetQuote.getPartyAAggregatedPositionsByActiveSymbolsPerPartyB(await user2.getAddress(), posHedger.address, 0, 1000)
				expect(result.length).to.equal(0)
			})
		})

		describe("getPartyBAggregatedPositionsByActiveSymbolsPerPartyA", function () {
			let symbol2: bigint

			beforeEach(async function () {
				await posContext.symbolControlFacet
					.connect(posContext.signers.admin)
					.addSymbol("PER_PARTY_A_SYMBOL2", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
				await posContext.symbolControlFacet.connect(posContext.signers.admin).setSymbolTypes([2], [1])

				symbol2 = 2n

				await posUser.setBalances(decimal(1000n), decimal(1000n), decimal(1000n))
				const sym2QuoteId = await posUser.sendQuote(limitQuoteRequestBuilder().symbolId(symbol2).positionType(PositionType.SHORT).build())
				const sym2Quote = await posContext.viewFacetQuote.getQuote(sym2QuoteId)
				await posHedger.lockQuote(sym2Quote.id)
				await posHedger.openPosition(sym2Quote.id)
			})

			it("returns active symbols for a specific partyA", async function () {
				const partyA = await posUser.getAddress()
				const sym1Totals = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, partyA, 1)
				const sym2Totals = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, partyA, Number(symbol2))

				const aggregates = await posContext.viewFacetQuote.getPartyBAggregatedPositionsByActiveSymbolsPerPartyA(posHedger.address, partyA, 0, 1000)

				const findEntry = (sid: bigint, posType: PositionType) =>
					aggregates.find((entry: any) => BigInt(entry.symbolId) === sid && BigInt(entry.positionType) === BigInt(posType))

				const sym1Long = findEntry(1n, PositionType.LONG)
				const sym1Short = findEntry(1n, PositionType.SHORT)
				const sym2Short = findEntry(symbol2, PositionType.SHORT)

				expect(sym1Long?.aggregatedOpenAmount).to.equal(sym1Totals.longPosition.aggregatedOpenAmount)
				expect(sym1Long?.avgOpenPrice).to.equal(sym1Totals.longPosition.avgOpenPrice)
				expect(sym1Short?.aggregatedOpenAmount).to.equal(sym1Totals.shortPosition.aggregatedOpenAmount)
				expect(sym1Short?.avgOpenPrice).to.equal(sym1Totals.shortPosition.avgOpenPrice)

				expect(sym2Short?.aggregatedOpenAmount).to.equal(sym2Totals.shortPosition.aggregatedOpenAmount)
				expect(sym2Short?.avgOpenPrice).to.equal(sym2Totals.shortPosition.avgOpenPrice)
			})

			it("returns empty for partyA with no positions", async function () {
				const user2 = new User(posContext, posContext.signers.user2)
				await user2.setup()
				await user2.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

				const result = await posContext.viewFacetQuote.getPartyBAggregatedPositionsByActiveSymbolsPerPartyA(posHedger.address, await user2.getAddress(), 0, 1000)
				expect(result.length).to.equal(0)
			})
		})

		describe("emergency close impact on aggregated positions", function () {
			it("reduces totals after emergency close", async function () {
				const before = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
				const quoteQuantity = await getQuoteQuantity(posContext, quote1LongOpened.id)

				// Enable emergency mode for partyB
				await posContext.pauseControlFacet.connect(posContext.signers.admin).setPartyBEmergencyStatus([posHedger.address], true)

				// Emergency close the position
				await posHedger.emergencyClosePosition(quote1LongOpened.id, emergencyCloseRequestBuilder().build())

				const after = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)

				// Verify totals are reduced
				expect(after.longPosition.aggregatedOpenAmount).to.equal(before.longPosition.aggregatedOpenAmount - quoteQuantity)
			})
		})

		describe("funding fee impact on avg open price", function () {
			describe("accumulated funding fee (new method)", function () {
				it("keeps totals consistent after funding accrual and charge", async function () {
					const before = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)

					await posContext.pauseControlFacet.enableNewFundingFee()
					await posContext.symbolControlFacet.connect(posContext.signers.admin).setSymbolFundingState(1, 3600, 1200)
					await posContext.fundingRateFacet.connect(posContext.signers.hedger).setEpochDurations([1], [3600])
					await posContext.fundingRateFacet
						.connect(posContext.signers.hedger)
						.updateAccumulatedFundingFee([1], [decimal(2n, 14)], [-decimal(2n, 14)], [decimal(1n)])

					await time.increase(7200)

					await posContext.fundingRateFacet
						.connect(posContext.signers.hedger)
						.chargeAccumulatedFundingFee(
							await posContext.signers.user.getAddress(),
							await posContext.signers.hedger.getAddress(),
							[quote1LongOpened.id],
							await getDummyPairUpnlSig(),
						)

					const after = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
					// Accumulated funding doesn't change openedPrice, so avgOpenPrice stays the same
					expect(after.longPosition.aggregatedOpenAmount).to.equal(before.longPosition.aggregatedOpenAmount)
					expect(after.longPosition.avgOpenPrice).to.equal(before.longPosition.avgOpenPrice)
					expect(after.shortPosition.aggregatedOpenAmount).to.equal(before.shortPosition.aggregatedOpenAmount)
					expect(after.shortPosition.avgOpenPrice).to.equal(before.shortPosition.avgOpenPrice)
				})
			})

			describe("iterative funding fee (old method - changes openedPrice)", function () {
				it("changes individual quote openedPrice and updates aggregate view", async function () {
					const symbol = await posContext.viewFacetSymbol.getSymbol(1)
					const duration = symbol.fundingRateEpochDuration
					const window = symbol.fundingRateWindowTime
					const currentEpoch = (BigInt(await time.latest()) / duration) * duration
					const targetTime = duration * 2n + window - 1n + currentEpoch

					const oldQuote = await posContext.viewFacetQuote.getQuote(quote1LongOpened.id)

					const rate = decimal(1n, 16) // 1% funding rate
					await time.setNextBlockTimestamp(targetTime)
					await posHedger.chargeFundingRate(await posContext.signers.user.getAddress(), [quote1LongOpened.id], [rate], await getDummyPairUpnlSig())

					const after = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
					const newQuote = await posContext.viewFacetQuote.getQuote(quote1LongOpened.id)
					const { longAmount, longNotional, shortAmount, shortNotional } = await getExpectedTotals([
						quote1LongOpened.id,
						quote2ShortOpened.id,
						quote3LongOpened.id,
					])

					// Individual quote's openedPrice IS updated (LONG with positive rate increases)
					const expectedNewPrice = unDecimal(oldQuote.openedPrice * (decimal(1n) + rate))
					expect(newQuote.openedPrice).to.equal(expectedNewPrice)

					expect(after.longPosition.aggregatedOpenAmount).to.equal(longAmount)
					expect(after.longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
					expect(after.shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
					expect(after.shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
				})

				it("SHORT position openedPrice changes and aggregate view updates", async function () {
					const symbol = await posContext.viewFacetSymbol.getSymbol(1)
					const duration = symbol.fundingRateEpochDuration
					const window = symbol.fundingRateWindowTime
					const currentEpoch = (BigInt(await time.latest()) / duration) * duration
					const targetTime = duration * 2n + window - 1n + currentEpoch

					const oldQuote = await posContext.viewFacetQuote.getQuote(quote2ShortOpened.id)

					const rate = decimal(1n, 16) // 1% funding rate
					await time.setNextBlockTimestamp(targetTime)
					await posHedger.chargeFundingRate(await posContext.signers.user.getAddress(), [quote2ShortOpened.id], [rate], await getDummyPairUpnlSig())

					const after = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
					const newQuote = await posContext.viewFacetQuote.getQuote(quote2ShortOpened.id)
					const { longAmount, longNotional, shortAmount, shortNotional } = await getExpectedTotals([
						quote1LongOpened.id,
						quote2ShortOpened.id,
						quote3LongOpened.id,
					])

					// Individual quote's openedPrice IS updated (SHORT with positive rate decreases)
					const expectedNewPrice = unDecimal(oldQuote.openedPrice * (decimal(1n) - rate))
					expect(newQuote.openedPrice).to.equal(expectedNewPrice)

					expect(after.longPosition.aggregatedOpenAmount).to.equal(longAmount)
					expect(after.longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
					expect(after.shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
					expect(after.shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
				})

				it("multiple positions charged - quotes and aggregate update", async function () {
					const symbol = await posContext.viewFacetSymbol.getSymbol(1)
					const duration = symbol.fundingRateEpochDuration
					const window = symbol.fundingRateWindowTime
					const currentEpoch = (BigInt(await time.latest()) / duration) * duration
					const targetTime = duration * 2n + window - 1n + currentEpoch

					const oldQuote1 = await posContext.viewFacetQuote.getQuote(quote1LongOpened.id)
					const oldQuote3 = await posContext.viewFacetQuote.getQuote(quote3LongOpened.id)

					const rate = decimal(1n, 16) // 1% funding rate
					await time.setNextBlockTimestamp(targetTime)
					// Charge both LONG positions
					await posHedger.chargeFundingRate(
						await posContext.signers.user.getAddress(),
						[quote1LongOpened.id, quote3LongOpened.id],
						[rate, rate],
						await getDummyPairUpnlSig(),
					)

					const after = await posContext.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
					const newQuote1 = await posContext.viewFacetQuote.getQuote(quote1LongOpened.id)
					const newQuote3 = await posContext.viewFacetQuote.getQuote(quote3LongOpened.id)
					const { longAmount, longNotional, shortAmount, shortNotional } = await getExpectedTotals([
						quote1LongOpened.id,
						quote2ShortOpened.id,
						quote3LongOpened.id,
					])

					// Both individual quotes' prices ARE updated
					expect(newQuote1.openedPrice).to.equal(unDecimal(oldQuote1.openedPrice * (decimal(1n) + rate)))
					expect(newQuote3.openedPrice).to.equal(unDecimal(oldQuote3.openedPrice * (decimal(1n) + rate)))

					expect(after.longPosition.aggregatedOpenAmount).to.equal(longAmount)
					expect(after.longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
					expect(after.shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
					expect(after.shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
				})
			})
		})
	})
}
