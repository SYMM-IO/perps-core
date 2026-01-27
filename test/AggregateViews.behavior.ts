import { loadFixture, time } from "./helpers/network-helpers.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { decimal, getBlockTimestamp, getQuoteQuantity, unDecimal } from "./utils/Common.js"
import { getDummyPairUpnlSig, getDummyLiquidationSig, getDummySettlementSig, getDummyCrossLiquidationSig, getDummyPriceSig, getDummyHighLowPriceSig } from "./utils/SignatureUtils.js"
import { migratePartyBToMaster } from "./utils/MasterAccount.js"
import { ethers, ZeroAddress } from "ethers"
import { QuoteStatus } from "./models/Enums.js"
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

	// ============================================================================
	// SECTION 1: ACTIVE SYMBOLS TRACKING
	// Tests for tracking which symbols have open positions
	// ============================================================================

	describe("Active Symbols Tracking", function () {
		beforeEach(async function () {
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])
		})

		it("should have empty active symbols list initially", async function () {
			const activeSymbols = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(activeSymbols.length).to.equal(0)

			const partyBActiveSymbols = await context.viewFacetAggregate.getPartyBActiveSymbolsPerPartyA(await hedger.getAddress(), await user.getAddress(), 0, 1000)
			expect(partyBActiveSymbols.length).to.equal(0)

			const partyBGlobalActiveSymbols = await context.viewFacetAggregate.getPartyBActiveSymbols(await hedger.getAddress(), 0, 1000)
			expect(partyBGlobalActiveSymbols.length).to.equal(0)
		})

		it("should add symbol to active list when position opens", async function () {
			const quoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

			const partyAActiveSymbols = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(partyAActiveSymbols.length).to.equal(1)
			expect(partyAActiveSymbols[0]).to.equal(1n)

			const partyBActiveSymbols = await context.viewFacetAggregate.getPartyBActiveSymbolsPerPartyA(await hedger.getAddress(), await user.getAddress(), 0, 1000)
			expect(partyBActiveSymbols.length).to.equal(1)
			expect(partyBActiveSymbols[0]).to.equal(1n)

			const partyBGlobalActiveSymbols = await context.viewFacetAggregate.getPartyBActiveSymbols(await hedger.getAddress(), 0, 1000)
			expect(partyBGlobalActiveSymbols.length).to.equal(1)
			expect(partyBGlobalActiveSymbols[0]).to.equal(1n)
		})

		it("should not duplicate symbol when opening multiple positions in same symbol", async function () {
			// Open two positions in symbol 1
			const firstQuoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(firstQuoteId)
			await hedger.openPosition(firstQuoteId)

			const secondQuoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(secondQuoteId)
			await hedger.openPosition(secondQuoteId)

			const partyAActiveSymbols = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(partyAActiveSymbols.length).to.equal(1) // Still only 1 symbol
		})

		it("should remove symbol from active list when all positions close", async function () {
			const quoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

			let partyAActiveSymbols = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(partyAActiveSymbols.length).to.equal(1)

			await user.requestToClosePosition(quoteId)
			await hedger.fillCloseRequest(quoteId)

			partyAActiveSymbols = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(partyAActiveSymbols.length).to.equal(0)

			const partyBActiveSymbols = await context.viewFacetAggregate.getPartyBActiveSymbolsPerPartyA(await hedger.getAddress(), await user.getAddress(), 0, 1000)
			expect(partyBActiveSymbols.length).to.equal(0)

			const partyBGlobalActiveSymbols = await context.viewFacetAggregate.getPartyBActiveSymbols(await hedger.getAddress(), 0, 1000)
			expect(partyBGlobalActiveSymbols.length).to.equal(0)
		})

		it("should keep symbol when closing one of many positions with a symbol", async function () {
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

			const partyAActiveSymbols = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(partyAActiveSymbols.length).to.equal(1) // Still has symbol 1

			const partyBActiveSymbols = await context.viewFacetAggregate.getPartyBActiveSymbolsPerPartyA(await hedger.getAddress(), await user.getAddress(), 0, 1000)
			expect(partyBActiveSymbols.length).to.equal(1)

			const partyBGlobalActiveSymbols = await context.viewFacetAggregate.getPartyBActiveSymbols(await hedger.getAddress(), 0, 1000)
			expect(partyBGlobalActiveSymbols.length).to.equal(1)
		})

		it("should keep symbol when only partial positions close", async function () {
			// Open two positions
			const firstQuoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
			const firstQuote = await context.viewFacetQuote.getQuote(firstQuoteId)
			await hedger.lockQuote(firstQuoteId)
			await hedger.openPosition(firstQuoteId)
			await user.requestToClosePosition(firstQuoteId, limitCloseRequestBuilder().quantityToClose(firstQuote.quantity / 2n).build())
			await hedger.fillCloseRequest(firstQuoteId, limitFillCloseRequestBuilder().filledAmount(firstQuote.quantity / 2n).build())

			const partyAActiveSymbols = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(partyAActiveSymbols.length).to.equal(1) // Still has symbol 1

			const partyBActiveSymbols = await context.viewFacetAggregate.getPartyBActiveSymbolsPerPartyA(await hedger.getAddress(), await user.getAddress(), 0, 1000)
			expect(partyBActiveSymbols.length).to.equal(1)

			const partyBGlobalActiveSymbols = await context.viewFacetAggregate.getPartyBActiveSymbols(await hedger.getAddress(), 0, 1000)
			expect(partyBGlobalActiveSymbols.length).to.equal(1)
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

			const partyAActiveSymbols = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(partyAActiveSymbols.length).to.equal(2)
			expect(partyAActiveSymbols).to.include(1n)
			expect(partyAActiveSymbols).to.include(2n)

			const partyBActiveSymbols = await context.viewFacetAggregate.getPartyBActiveSymbolsPerPartyA(await hedger.getAddress(), await user.getAddress(), 0, 1000)
			expect(partyBActiveSymbols.length).to.equal(2)
			expect(partyBActiveSymbols).to.include(1n)
			expect(partyBActiveSymbols).to.include(2n)

			const partyBGlobalActiveSymbols = await context.viewFacetAggregate.getPartyBActiveSymbols(await hedger.getAddress(), 0, 1000)
			expect(partyBGlobalActiveSymbols.length).to.equal(2)
			expect(partyBGlobalActiveSymbols).to.include(1n)
			expect(partyBGlobalActiveSymbols).to.include(2n)
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

			const partyAActiveSymbols = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(partyAActiveSymbols.length).to.equal(2)
			expect(partyAActiveSymbols).to.include(2n)
			expect(partyAActiveSymbols).to.include(3n)
			expect(partyAActiveSymbols).to.not.include(1n)

			const partyBActiveSymbols = await context.viewFacetAggregate.getPartyBActiveSymbolsPerPartyA(await hedger.getAddress(), await user.getAddress(), 0, 1000)
			expect(partyBActiveSymbols.length).to.equal(2)
			expect(partyBActiveSymbols).to.include(2n)
			expect(partyBActiveSymbols).to.include(3n)
			expect(partyBActiveSymbols).to.not.include(1n)

			const partyBGlobalActiveSymbols = await context.viewFacetAggregate.getPartyBActiveSymbols(await hedger.getAddress(), 0, 1000)
			expect(partyBGlobalActiveSymbols.length).to.equal(2)
			expect(partyBGlobalActiveSymbols).to.include(2n)
			expect(partyBGlobalActiveSymbols).to.include(3n)
			expect(partyBGlobalActiveSymbols).to.not.include(1n)
		})

		it("should maintain index consistency after complex add/remove sequences", async function () {
			// Add symbols 2, 3, 4, 5
			for (let i = 2; i <= 5; i++) {
				await context.symbolControlFacet.connect(context.signers.admin)
					.addSymbol(`SYMBOL${i}`, decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
			}
			await context.symbolControlFacet.connect(context.signers.admin).setSymbolTypes([2, 3, 4, 5], [1, 1, 1, 1])
			await context.fundingRateFacet.connect(context.signers.hedger)
				.setEpochDurations([1, 2, 3, 4, 5], [EightHourInSec, EightHourInSec, EightHourInSec, EightHourInSec, EightHourInSec])

			// Open positions in symbols 1, 2, 3, 4, 5
			const quoteIds: Map<number, bigint> = new Map()
			for (let symbolId = 1; symbolId <= 5; symbolId++) {
				const quoteId = await user.sendQuote(limitQuoteRequestBuilder().symbolId(symbolId).maxFundingRate(decimal(1n)).build())
				await hedger.lockQuote(quoteId)
				await hedger.openPosition(quoteId)
				quoteIds.set(symbolId, quoteId)
			}

			// Verify all 5 symbols are active
			let activeSymbols = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(activeSymbols.length).to.equal(5)

			// Close symbol 2 (middle of array - triggers swap)
			await user.requestToClosePosition(quoteIds.get(2)!)
			await hedger.fillCloseRequest(quoteIds.get(2)!)

			// Verify symbol 2 is removed, others remain
			activeSymbols = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(activeSymbols.length).to.equal(4)
			expect(activeSymbols.map(s => Number(s))).to.not.include(2)
			expect(activeSymbols.map(s => Number(s))).to.include.members([1, 3, 4, 5])

			// Open a new position in symbol 2 (re-add)
			const newQuote2 = await user.sendQuote(limitQuoteRequestBuilder().symbolId(2).maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(newQuote2)
			await hedger.openPosition(newQuote2)
			quoteIds.set(2, newQuote2)

			// Verify symbol 2 is back
			activeSymbols = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(activeSymbols.length).to.equal(5)
			expect(activeSymbols.map(s => Number(s))).to.include.members([1, 2, 3, 4, 5])

			// Close symbol 1 (first in array)
			await user.requestToClosePosition(quoteIds.get(1)!)
			await hedger.fillCloseRequest(quoteIds.get(1)!)

			// Verify symbol 1 is removed
			activeSymbols = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(activeSymbols.length).to.equal(4)
			expect(activeSymbols.map(s => Number(s))).to.not.include(1)

			// Close symbol 5 (could be last)
			await user.requestToClosePosition(quoteIds.get(5)!)
			await hedger.fillCloseRequest(quoteIds.get(5)!)

			// Verify only 2, 3, 4 remain
			activeSymbols = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(activeSymbols.length).to.equal(3)
			expect(activeSymbols.map(s => Number(s))).to.include.members([2, 3, 4])

			// Pagination should work correctly
			const page1 = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 2)
			const page2 = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 2, 2)
			expect(page1.length).to.equal(2)
			expect(page2.length).to.equal(1)

			// All paginated symbols should be unique
			const allPaginated = [...page1, ...page2].map(s => Number(s))
			const uniquePaginated = new Set(allPaginated)
			expect(uniquePaginated.size).to.equal(3)
		})
	})

	// ============================================================================
	// SECTION 2: AGGREGATE FUNDING
	// Tests for funding rate tracking and debt calculations
	// ============================================================================

	describe("Aggregate Funding", function () {
		describe("Tracking on Position Open", function () {
			it("should initialize aggregate funding to zero for new symbol/position type", async function () {
				// Check initial state before any positions
				const partyAFunding = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
					await user.getAddress(),
					await hedger.getAddress(),
					1,
					PositionType.LONG
				)
				expect(partyAFunding).to.equal(0)

				const partyBFunding = await context.viewFacetAggregate.getPartyBAggregatedFundingPerPartyA(
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
				const partyAFunding = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
					await user.getAddress(),
					await hedger.getAddress(),
					1,
					PositionType.LONG
				)
				const expectedFunding = getWeightedPaidFunding(quote)
				expect(partyAFunding).to.equal(expectedFunding)

				const partyBFunding = await context.viewFacetAggregate.getPartyBAggregatedFundingPerPartyA(
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
				const fundingAfterFirst = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
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

				const fundingAfterSecond = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
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
				const longFunding = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
					await user.getAddress(),
					await hedger.getAddress(),
					1,
					PositionType.LONG
				)
				const shortFunding = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
					await user.getAddress(),
					await hedger.getAddress(),
					1,
					PositionType.SHORT
				)

				expect(longFunding).to.equal(getWeightedPaidFunding(longQuote))
				expect(shortFunding).to.equal(getWeightedPaidFunding(shortQuote))
			})
		})

		describe("Updates on Quote Funding Value Sync", function () {
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
				const fundingBefore = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
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
				const fundingAfter = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
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
				const partyAFundingBefore = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
					await user.getAddress(),
					await hedger.getAddress(),
					1,
					PositionType.LONG
				)
				const partyBFundingBefore = await context.viewFacetAggregate.getPartyBAggregatedFundingPerPartyA(
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
				const partyAFundingAfter = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
					await user.getAddress(),
					await hedger.getAddress(),
					1,
					PositionType.LONG
				)
				const partyBFundingAfter = await context.viewFacetAggregate.getPartyBAggregatedFundingPerPartyA(
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

		describe("Removal on Position Close", function () {
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
				const fundingBeforeClose = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
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

				const fundingAfterClose = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
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

				const fundingBeforeClose = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
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

				const fundingAfterClose = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
					await user.getAddress(),
					await hedger.getAddress(),
					1,
					PositionType.LONG
				)

				expect(fundingAfterClose).to.equal(fundingBeforeClose - closeContribution)
				expect(fundingAfterClose).to.be.gt(0n)
			})
		})

		describe("Consistency with Per-Quote Funding Debt Calculation", function () {
			it("should return zero funding debt when no positions exist", async function () {
				await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
				await context.fundingRateFacet
					.connect(context.signers.hedger)
					.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])
				const debt = await context.viewFacetAggregate.getPartyAAggregateFundingDebt(
					await user.getAddress(),
					await hedger.getAddress(),
					1,
					PositionType.LONG
				)
				expect(debt).to.equal(0)
			})

			it("should give consistent total funding debt when compared to per-quote calculation", async function () {
				// Setup funding rates
				await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
				await context.fundingRateFacet
					.connect(context.signers.hedger)
					.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

				const quoteIds: bigint[] = []
				// Open multiple positions
				for (let i = 0; i < 3; i++) {
					const quoteId = await user.sendQuote(
						limitQuoteRequestBuilder()
							.maxFundingRate(decimal(1n))
							.build()
					)
					quoteIds.push(quoteId)
					await hedger.lockQuote(quoteId)
					await hedger.openPosition(quoteId)
					await time.increase(EightHourInSec) // Wait between positions
				}

				// Wait for more funding to accumulate
				await time.increase(EightHourInSec * 2)

				// Get aggregate funding debt
				const aggregateFundingDebt = await context.viewFacetAggregate.getPartyAAggregateFundingDebt(
					await user.getAddress(),
					await hedger.getAddress(),
					1,
					PositionType.LONG
				)

				expect(aggregateFundingDebt).to.equal(await context.viewFacetQuote.getSumQuoteFundingDebts(quoteIds))

				// Verify partyB debt is opposite
				const partyBAggregateFundingDebt = await context.viewFacetAggregate.getPartyBAggregateFundingDebt(
					await hedger.getAddress(),
					await user.getAddress(),
					1,
					PositionType.LONG
				)
				expect(partyBAggregateFundingDebt).to.equal(-aggregateFundingDebt)
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
				const debt = await context.viewFacetAggregate.getPartyAAggregateFundingDebt(
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
				const debt = await context.viewFacetAggregate.getPartyAAggregateFundingDebt(
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
				const debt = await context.viewFacetAggregate.getPartyAAggregateFundingDebt(
					await user.getAddress(),
					await hedger.getAddress(),
					1,
					PositionType.LONG
				)

				// Debt could be negative (partyA is owed) since rate is negative
				expect(debt).to.be.lt(0)
				expect(debt).to.be.eq(await context.viewFacetQuote.getSumQuoteFundingDebts([quoteId]))
			})

			describe("Multi-Hedger", function () {
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
					const fundingHedger1 = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
						await user.getAddress(),
						await hedger.getAddress(),
						1,
						PositionType.LONG
					)
					const fundingHedger2 = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
						await user.getAddress(),
						await hedger2.getAddress(),
						1,
						PositionType.LONG
					)

					// Each hedger's aggregate should only contain that hedger's positions
					expect(fundingHedger1).to.equal(getWeightedPaidFunding(quote1))
					expect(fundingHedger2).to.equal(getWeightedPaidFunding(quote2))

					// They should be different because they have different funding rates
					expect(fundingHedger1).to.not.equal(fundingHedger2)

					const fundingHedger1PartyB = await context.viewFacetAggregate.getPartyBAggregatedFundingPerPartyA(
						await hedger.getAddress(),
						await user.getAddress(),
						1,
						PositionType.LONG
					)
					const fundingHedger2PartyB = await context.viewFacetAggregate.getPartyBAggregatedFundingPerPartyA(
						await hedger2.getAddress(),
						await user.getAddress(),
						1,
						PositionType.LONG
					)

					expect(fundingHedger1PartyB).to.equal(getWeightedPaidFunding(quote1))
					expect(fundingHedger2PartyB).to.equal(getWeightedPaidFunding(quote2))

					expect(fundingHedger1PartyB).to.not.equal(fundingHedger2PartyB)

					expect(fundingHedger1PartyB).to.be.eq(fundingHedger1)
					expect(fundingHedger2PartyB).to.be.eq(fundingHedger2)
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
					const debtWithHedger1 = await context.viewFacetAggregate.getPartyAAggregateFundingDebt(
						await user.getAddress(),
						await hedger.getAddress(),
						1,
						PositionType.LONG
					)
					const debtWithHedger2 = await context.viewFacetAggregate.getPartyAAggregateFundingDebt(
						await user.getAddress(),
						await hedger2.getAddress(),
						1,
						PositionType.LONG
					)

					// Debts should be different because hedgers have different funding rates
					expect(debtWithHedger1).to.not.equal(0)
					expect(debtWithHedger2).to.not.equal(0)
					expect(debtWithHedger2).to.be.eq(2n * debtWithHedger1)
				})

				it("should correctly update aggregate funding when charging per hedger (syncing quote funding value)", async function () {
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
					const fundingBefore = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
						await user.getAddress(),
						await hedger.getAddress(),
						1,
						PositionType.LONG
					)

					const fundingHedger2Before = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
						await user.getAddress(),
						await hedger2.getAddress(),
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

					const fundingAfter = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
						await user.getAddress(),
						await hedger.getAddress(),
						1,
						PositionType.LONG
					)

					let fundingHedger2After = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
						await user.getAddress(),
						await hedger2.getAddress(),
						1,
						PositionType.LONG
					)

					// Hedger1's aggregate should have changed
					expect(fundingAfter).to.not.equal(fundingBefore)

					// Hedger2's aggregate should remain unchanged
					expect(fundingHedger2After).to.equal(fundingHedger2Before)

					// Charge funding for hedger2 now
					await context.fundingRateFacet
						.connect(context.signers.hedger2)
						.chargeAccumulatedFundingFee(
							await user.getAddress(),
							await hedger2.getAddress(),
							[quoteId2],
							await getDummyPairUpnlSig()
						)

					fundingHedger2After = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
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
					const activeSymbolsHedger1 = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(
						await user.getAddress(),
						await hedger.getAddress(),
						0,
						1000
					)
					const activeSymbolsHedger2 = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(
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
					const allActiveSymbols = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
					expect(allActiveSymbols.length).to.equal(1)
					expect(allActiveSymbols[0]).to.equal(1n)
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
					const { longPosition: pos2Before } = await context.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(
						await user.getAddress(),
						await hedger2.getAddress(),
						1
					)

					// Close position with hedger1
					await user.requestToClosePosition(quoteId1)
					await hedger.fillCloseRequest(quoteId1)

					// Hedger1's aggregate should be zero
					const { longPosition: pos1After } = await context.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(
						await user.getAddress(),
						await hedger.getAddress(),
						1
					)
					expect(pos1After.aggregatedOpenAmount).to.equal(0n)

					// Hedger2's aggregate should be unchanged
					const { longPosition: pos2After } = await context.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(
						await user.getAddress(),
						await hedger2.getAddress(),
						1
					)
					expect(pos2After.aggregatedOpenAmount).to.equal(pos2Before.aggregatedOpenAmount)
				})
			})

			describe("Funding Debt Consistency Through Liquidation", function () {
				it("should maintain funding aggregates through partyA liquidation", async function () {
					// Setup
					await context.pauseControlFacet.connect(context.signers.admin).enableNewFundingFee()
					await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
					await context.fundingRateFacet
						.connect(context.signers.hedger)
						.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

					// Open position
					const quoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
					await hedger.lockQuote(quoteId)
					await hedger.openPosition(quoteId)

					// Verify position is open
					const quote = await context.viewFacetQuote.getQuote(quoteId)
					expect(quote.quantity - quote.closedAmount).to.be.gt(0n)

					// Verify position aggregates after open
					const { longPosition: posAfterOpen } = await context.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(
						await user.getAddress(),
						await hedger.getAddress(),
						1
					)
					expect(posAfterOpen.aggregatedOpenAmount).to.be.gt(0n)

					// Wait for funding to accumulate
					await time.increase(EightHourInSec * 3)

					// Get debt before liquidation (should be non-zero because time passed)
					const debtBefore = await context.viewFacetAggregate.getPartyAAggregateFundingDebt(
						await user.getAddress(),
						await hedger.getAddress(),
						1,
						PositionType.LONG
					)
					expect(debtBefore).to.not.equal(0n)

					// Liquidate partyA (without charging funding first - this is the design)
					const liquidator = context.signers.liquidator
					const sig = await getDummyLiquidationSig("0x10", -decimal(1_000_000n), [1n], [decimal(1n)], decimal(1_000_000n), 0n)

					await context.partyALiquidationFacet.connect(liquidator).liquidatePartyA(await user.getAddress(), sig)
					await context.partyALiquidationFacet.connect(liquidator).setSymbolsPrice(await user.getAddress(), sig)
					await context.partyALiquidationFacet.connect(liquidator).liquidatePendingPositionsPartyA(await user.getAddress())
					await context.partyALiquidationFacet.connect(liquidator).liquidatePositionsPartyA(await user.getAddress(), [quoteId])

					// After liquidation, position and funding aggregates should be zeroed
					const { longPosition: posAfter } = await context.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(
						await user.getAddress(),
						await hedger.getAddress(),
						1
					)
					expect(posAfter.aggregatedOpenAmount).to.equal(0n)

					const fundingAfter = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
						await user.getAddress(),
						await hedger.getAddress(),
						1,
						PositionType.LONG
					)
					const debtAfter = await context.viewFacetAggregate.getPartyAAggregateFundingDebt(
						await user.getAddress(),
						await hedger.getAddress(),
						1,
						PositionType.LONG
					)

					// Funding aggregates should be cleared (position closed)
					expect(fundingAfter).to.equal(0n)
					// Debt should be zero since no positions remain
					expect(debtAfter).to.equal(0n)
				})
			})

			describe("Precision Edge Cases", function () {
				it("should handle standard position amounts correctly", async function () {
					// Setup
					await context.pauseControlFacet.connect(context.signers.admin).enableNewFundingFee()
					await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
					await context.fundingRateFacet
						.connect(context.signers.hedger)
						.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

					// Open position with standard quantity (default is 100)
					const quoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
					await hedger.lockQuote(quoteId)
					await hedger.openPosition(quoteId)

					const quote = await context.viewFacetQuote.getQuote(quoteId)
					const openAmount = quote.quantity - quote.closedAmount

					// Verify aggregates handle amounts correctly
					const { longPosition } = await context.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(
						await user.getAddress(),
						await hedger.getAddress(),
						1
					)
					expect(longPosition.aggregatedOpenAmount).to.equal(openAmount)
					// avgOpenPrice should match the quote's opened price exactly for single position
					expect(longPosition.avgOpenPrice).to.equal(quote.openedPrice)
				})

				it("should handle funding debt calculation without overflow", async function () {
					// Setup
					await context.pauseControlFacet.connect(context.signers.admin).enableNewFundingFee()
					await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
					await context.fundingRateFacet
						.connect(context.signers.hedger)
						.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

					// Open position with standard quantity
					const quoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
					await hedger.lockQuote(quoteId)
					await hedger.openPosition(quoteId)

					const quote = await context.viewFacetQuote.getQuote(quoteId)

					// Verify aggregates handle amounts
					const { longPosition } = await context.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(
						await user.getAddress(),
						await hedger.getAddress(),
						1
					)
					expect(longPosition.aggregatedOpenAmount).to.equal(quote.quantity - quote.closedAmount)

					// Wait and verify funding debt doesn't overflow
					await time.increase(EightHourInSec * 10)

					const debt = await context.viewFacetAggregate.getPartyAAggregateFundingDebt(
						await user.getAddress(),
						await hedger.getAddress(),
						1,
						PositionType.LONG
					)
					// Should be a reasonable positive value, not wrapped around
					expect(debt).to.be.gt(0n)
					expect(debt).to.be.lt(decimal(1_000_000_000n)) // Sanity check
				})

				it("should accumulate aggregates correctly with multiple positions", async function () {
					// Setup
					await context.pauseControlFacet.connect(context.signers.admin).enableNewFundingFee()
					await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
					await context.fundingRateFacet
						.connect(context.signers.hedger)
						.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

					// Open first position: 100 units at price 1.0 (default)
					const quote1Id = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
					await hedger.lockQuote(quote1Id)
					await hedger.openPosition(quote1Id)

					const quote1 = await context.viewFacetQuote.getQuote(quote1Id)
					const amount1 = quote1.quantity - quote1.closedAmount
					const price1 = quote1.openedPrice

					// Verify first position aggregate
					let { longPosition } = await context.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(
						await user.getAddress(),
						await hedger.getAddress(),
						1
					)
					expect(longPosition.aggregatedOpenAmount).to.equal(amount1)
					expect(longPosition.avgOpenPrice).to.equal(price1)

					// Open second position: also 100 units at price 1.0
					const quote2Id = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
					await hedger.lockQuote(quote2Id)
					await hedger.openPosition(quote2Id)

					const quote2 = await context.viewFacetQuote.getQuote(quote2Id)
					const amount2 = quote2.quantity - quote2.closedAmount
					const price2 = quote2.openedPrice

					// Get final aggregates
					const result = await context.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(
						await user.getAddress(),
						await hedger.getAddress(),
						1
					)
					longPosition = result.longPosition

					// Total amount should be sum of both positions
					expect(longPosition.aggregatedOpenAmount).to.equal(amount1 + amount2)

					// Weighted average calculation: (amount1 * price1 + amount2 * price2) / (amount1 + amount2)
					// With same prices: avgPrice = price
					const expectedNotional = unDecimal(amount1 * price1) + unDecimal(amount2 * price2)
					const expectedAvgPrice = expectedNotional * decimal(1n) / (amount1 + amount2)
					expect(longPosition.avgOpenPrice).to.equal(expectedAvgPrice)

					// Also verify partyB side matches
					const { longPosition: partyBLong } = await context.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(
						await hedger.getAddress(),
						await user.getAddress(),
						1
					)
					expect(partyBLong.aggregatedOpenAmount).to.equal(longPosition.aggregatedOpenAmount)
					expect(partyBLong.avgOpenPrice).to.equal(longPosition.avgOpenPrice)
				})
			})
		})
	})

	// ============================================================================
	// SECTION 3: AGGREGATED POSITION VIEWS
	// Tests for position aggregation (amount, notional, avg price)
	// ============================================================================

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

				const { longPosition, shortPosition } = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, symbolId)
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

				const { longPosition, shortPosition } = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
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

				const { longPosition, shortPosition } = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 2)
				expect(longPosition.aggregatedOpenAmount).to.equal(0n)
				expect(shortPosition.aggregatedOpenAmount).to.equal(0n)
				expect(longPosition.avgOpenPrice).to.equal(0n)
				expect(shortPosition.avgOpenPrice).to.equal(0n)
			})

			it("returns zero for partyB with no position history", async function () {
				const { longPosition, shortPosition } = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger2.address, posUser.address, 1)
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
				const hedgerTotals = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
				const hedger2Totals = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger2.address, posUser.address, 1)

				// posHedger has 2 LONGs and 1 SHORT
				expect(hedgerTotals.longPosition.aggregatedOpenAmount).to.be.gt(0n)
				expect(hedgerTotals.shortPosition.aggregatedOpenAmount).to.be.gt(0n)

				// posHedger2 has 1 LONG only
				expect(hedger2Totals.longPosition.aggregatedOpenAmount).to.equal(user2Quote.quantity)
				expect(hedger2Totals.shortPosition.aggregatedOpenAmount).to.equal(0n)
			})

			it("updates totals correctly after opening new position", async function () {
				const before = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)

				// Open another LONG
				await posUser.setBalances(decimal(1000n), decimal(1000n), decimal(1000n))
				const newQuote = await posContext.viewFacetQuote.getQuote(await posUser.sendQuote())
				await posHedger.lockQuote(newQuote.id)
				await posHedger.openPosition(newQuote.id)

				const after = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)

				expect(after.longPosition.aggregatedOpenAmount).to.equal(before.longPosition.aggregatedOpenAmount + newQuote.quantity)
				expect(after.shortPosition.aggregatedOpenAmount).to.equal(before.shortPosition.aggregatedOpenAmount)
			})

			it("decreases totals after partial close via fillCloseRequest", async function () {
				const before = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
				const closeQuantity = (await getQuoteQuantity(posContext, quote1LongOpened.id)) / 2n

				await posUser.requestToClosePosition(
					quote1LongOpened.id,
					limitCloseRequestBuilder().quantityToClose(closeQuantity).closePrice(decimal(1n)).build(),
				)
				await posHedger.fillCloseRequest(quote1LongOpened.id, limitFillCloseRequestBuilder().filledAmount(closeQuantity).closedPrice(decimal(1n)).build())

				const after = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)

				expect(after.longPosition.aggregatedOpenAmount).to.equal(before.longPosition.aggregatedOpenAmount - closeQuantity)
				expect(after.shortPosition.aggregatedOpenAmount).to.equal(before.shortPosition.aggregatedOpenAmount)
			})

			it("removes position from totals after full close via fillCloseRequest", async function () {
				const before = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
				const fullQuantity = await getQuoteQuantity(posContext, quote1LongOpened.id)

				await posUser.requestToClosePosition(quote1LongOpened.id, limitCloseRequestBuilder().quantityToClose(fullQuantity).closePrice(decimal(1n)).build())
				await posHedger.fillCloseRequest(quote1LongOpened.id, limitFillCloseRequestBuilder().filledAmount(fullQuantity).closedPrice(decimal(1n)).build())

				const after = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)

				expect(after.longPosition.aggregatedOpenAmount).to.equal(before.longPosition.aggregatedOpenAmount - fullQuantity)
			})

			it("resets totals after full liquidation flow", async function () {
				const liquidator = posContext.signers.liquidator
				const sig = await getDummyLiquidationSig("0x10", -decimal(1_000_000n), [1n], [decimal(1n)], decimal(1_000_000n), 0n)

				await posContext.partyALiquidationFacet.connect(liquidator).liquidatePartyA(await posUser.getAddress(), sig)
				await posContext.partyALiquidationFacet.connect(liquidator).setSymbolsPrice(await posUser.getAddress(), sig)
				await posContext.partyALiquidationFacet.connect(liquidator).liquidatePendingPositionsPartyA(await posUser.getAddress())
				await posContext.partyALiquidationFacet
					.connect(liquidator)
					.liquidatePositionsPartyA(await posUser.getAddress(), [quote1LongOpened.id, quote2ShortOpened.id, quote3LongOpened.id])

				const { longPosition, shortPosition } = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
				expect(longPosition.aggregatedOpenAmount).to.equal(0n)
				expect(shortPosition.aggregatedOpenAmount).to.equal(0n)
			})

			it("updates averages after settlement adjustments", async function () {
				const before = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
				const updatedPrice = decimal(5n, 17)

				const settlementEntry = Object.assign([quote1LongOpened.id, updatedPrice, 0n], {
					quoteId: quote1LongOpened.id,
					currentPrice: updatedPrice,
					partyBUpnlIndex: 0n,
				}) as QuoteSettlementDataStructOutput
				const settlementSig = await getDummySettlementSig(0n, [0n], [settlementEntry])

				await posHedger.settleUpnl(await posContext.signers.user.getAddress(), [updatedPrice], settlementSig)

				const after = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
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

			// Helper function for partyA-specific totals
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

				const { longPosition, shortPosition } = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, partyA, 1)

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

				const userTotals = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, partyA1, 1)
				const user2Totals = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, partyA2, 1)

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

				const { longPosition, shortPosition } = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbol(posHedger.address, 1)

				expect(longPosition.aggregatedOpenAmount).to.equal(globalLongAmount)
				expect(longPosition.avgOpenPrice).to.equal(globalLongAmount === 0n ? 0n : globalLongNotional / globalLongAmount)
				expect(shortPosition.aggregatedOpenAmount).to.equal(globalShortAmount)
				expect(shortPosition.avgOpenPrice).to.equal(globalShortAmount === 0n ? 0n : globalShortNotional / globalShortAmount)
			})

			it("returns zero for partyB with no positions", async function () {
				const { longPosition, shortPosition } = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbol(posHedger2.address, 1)
				expect(longPosition.aggregatedOpenAmount).to.equal(0n)
				expect(shortPosition.aggregatedOpenAmount).to.equal(0n)
			})

			it("updates global totals when positions close", async function () {
				const before = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbol(posHedger.address, 1)

				// Close one position partially (quote1LongOpened is a LONG position)
				const closeAmount = decimal(50n, 17)
				await posUser.requestToClosePosition(
					quote1LongOpened.id,
					limitCloseRequestBuilder().quantityToClose(closeAmount).closePrice(decimal(1n)).deadline(getBlockTimestamp(10000n)).build(),
				)
				await posHedger.fillCloseRequest(quote1LongOpened.id, limitFillCloseRequestBuilder().filledAmount(closeAmount).closedPrice(decimal(1n)).build())

				const after = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbol(posHedger.address, 1)

				// LONG position aggregate should decrease (stored by quote.positionType)
				expect(after.longPosition.aggregatedOpenAmount).to.equal(before.longPosition.aggregatedOpenAmount - closeAmount)
			})
		})

		describe("getPartyAAggregatedPositionBySymbolPerPartyB", function () {
			it("updates totals after opening new position", async function () {
				const before = await posContext.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(posUser.address, posHedger.address, 1)

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

				const { longPosition, shortPosition } = await posContext.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(posUser.address, posHedger.address, 1)

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

				const { longPosition, shortPosition } = await posContext.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(posUser.address, posHedger.address, 1)

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

				const { longPosition, shortPosition } = await posContext.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(posUser.address, posHedger.address, 1)

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

				const { longPosition, shortPosition } = await posContext.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(posUser.address, posHedger.address, 1)

				expect(newQuote.openedPrice).to.equal(unDecimal(oldQuote.openedPrice * (decimal(1n) + rate)))
				expect(longPosition.aggregatedOpenAmount).to.equal(longAmount)
				expect(longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
				expect(shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
				expect(shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
			})

			it("resets totals after full liquidation flow", async function () {
				const liquidator = posContext.signers.liquidator
				const sig = await getDummyLiquidationSig("0x10", -decimal(1_000_000n), [1n], [decimal(1n)], decimal(1_000_000n), 0n)

				await posContext.partyALiquidationFacet.connect(liquidator).liquidatePartyA(await posUser.getAddress(), sig)
				await posContext.partyALiquidationFacet.connect(liquidator).setSymbolsPrice(await posUser.getAddress(), sig)
				await posContext.partyALiquidationFacet.connect(liquidator).liquidatePendingPositionsPartyA(await posUser.getAddress())
				await posContext.partyALiquidationFacet
					.connect(liquidator)
					.liquidatePositionsPartyA(await posUser.getAddress(), [quote1LongOpened.id, quote2ShortOpened.id, quote3LongOpened.id])

				const { longPosition, shortPosition } = await posContext.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(posUser.address, posHedger.address, 1)
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

				const { longPosition, shortPosition } = await posContext.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(posUser.address, posHedger.address, 1)

				expect(longPosition.aggregatedOpenAmount).to.equal(longAmount)
				expect(longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
				expect(shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
				expect(shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
			})
		})

		describe("Global PartyB Active Symbols", function () {
			let symbol2: bigint

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
			})

			it("getPartyBActiveSymbolsCount returns correct count", async function () {
				// posHedger has positions in symbol 1 from beforeEach
				const countBefore = await posContext.viewFacetAggregate.getPartyBActiveSymbolsCount(posHedger.address)
				expect(countBefore).to.equal(1n)

				// Open a position in symbol2
				await posUser.setBalances(decimal(1000n), decimal(1000n), decimal(1000n))
				const sym2QuoteId = await posUser.sendQuote(limitQuoteRequestBuilder().symbolId(symbol2).positionType(PositionType.SHORT).build())
				const sym2Quote = await posContext.viewFacetQuote.getQuote(sym2QuoteId)
				await posHedger.lockQuote(sym2Quote.id)
				await posHedger.openPosition(sym2Quote.id)

				const countAfter = await posContext.viewFacetAggregate.getPartyBActiveSymbolsCount(posHedger.address)
				expect(countAfter).to.equal(2n)
			})

			it("getPartyBActiveSymbols returns paginated list", async function () {
				// Open a position in symbol2
				await posUser.setBalances(decimal(1000n), decimal(1000n), decimal(1000n))
				const sym2QuoteId = await posUser.sendQuote(limitQuoteRequestBuilder().symbolId(symbol2).positionType(PositionType.SHORT).build())
				const sym2Quote = await posContext.viewFacetQuote.getQuote(sym2QuoteId)
				await posHedger.lockQuote(sym2Quote.id)
				await posHedger.openPosition(sym2Quote.id)

				const allSymbols = await posContext.viewFacetAggregate.getPartyBActiveSymbols(posHedger.address, 0, 1000)
				expect(allSymbols.length).to.equal(2)
				expect(allSymbols.map((s: bigint) => Number(s))).to.include.members([1, 2])

				// Test pagination
				const firstPage = await posContext.viewFacetAggregate.getPartyBActiveSymbols(posHedger.address, 0, 1)
				expect(firstPage.length).to.equal(1)

				const secondPage = await posContext.viewFacetAggregate.getPartyBActiveSymbols(posHedger.address, 1, 1)
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
				const aggregates = await posContext.viewFacetAggregate.getPartyBAggregatedPositionsByActiveSymbols(posHedger.address, 0, 1000)

				// Should have entries for both symbols
				const sym1Entry = aggregates.find((entry: any) => BigInt(entry.symbolId) === 1n)
				const sym2Entry = aggregates.find((entry: any) => BigInt(entry.symbolId) === symbol2)

				expect(sym1Entry).to.not.be.undefined
				expect(sym2Entry).to.not.be.undefined

				// Verify symbol 1 has the global totals (from posUser's positions)
				const sym1Totals = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbol(posHedger.address, 1)
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

				const countBefore = await posContext.viewFacetAggregate.getPartyBActiveSymbolsCount(posHedger.address)
				expect(countBefore).to.equal(2n)

				// Close the position in symbol2 completely
				const openAmount = sym2Quote.quantity - sym2Quote.closedAmount
				await posUser.requestToClosePosition(
					sym2Quote.id,
					limitCloseRequestBuilder().quantityToClose(openAmount).closePrice(decimal(1n)).deadline(getBlockTimestamp(10000n)).build(),
				)
				await posHedger.fillCloseRequest(sym2Quote.id, limitFillCloseRequestBuilder().filledAmount(openAmount).closedPrice(decimal(1n)).build())

				const countAfter = await posContext.viewFacetAggregate.getPartyBActiveSymbolsCount(posHedger.address)
				expect(countAfter).to.equal(1n)

				const symbols = await posContext.viewFacetAggregate.getPartyBActiveSymbols(posHedger.address, 0, 1000)
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
				const count = await posContext.viewFacetAggregate.getPartyBActiveSymbolsCount(posHedger.address)
				expect(count).to.equal(2n) // symbol 1 from posUser, symbol 2 from user2

				const symbols = await posContext.viewFacetAggregate.getPartyBActiveSymbols(posHedger.address, 0, 1000)
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
				const sym1Totals = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
				const sym2Totals = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, Number(symbol2))

				const aggregates = await posContext.viewFacetAggregate.getPartyBAggregatedPositionsByActiveSymbolsPerPartyA(posHedger.address, posUser.address, 0, 1000)

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
				const result = await posContext.viewFacetAggregate.getPartyBAggregatedPositionsByActiveSymbolsPerPartyA(posHedger2.address, posUser.address, 0, 1000)
				expect(result.length).to.equal(0)
			})

			it("returns active symbols for a specific partyA", async function () {
				const partyA = await posUser.getAddress()
				const sym1Totals = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, partyA, 1)
				const sym2Totals = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, partyA, Number(symbol2))

				const aggregates = await posContext.viewFacetAggregate.getPartyBAggregatedPositionsByActiveSymbolsPerPartyA(posHedger.address, partyA, 0, 1000)

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

				const result = await posContext.viewFacetAggregate.getPartyBAggregatedPositionsByActiveSymbolsPerPartyA(posHedger.address, await user2.getAddress(), 0, 1000)
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
				const sym1Totals = await posContext.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(posUser.address, posHedger.address, 1)
				const sym2Totals = await posContext.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(posUser.address, posHedger.address, Number(symbol2))

				const aggregates = await posContext.viewFacetAggregate.getPartyAAggregatedPositionsByActiveSymbolsPerPartyB(posUser.address, posHedger.address, 0, 1000)

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

				const result = await posContext.viewFacetAggregate.getPartyAAggregatedPositionsByActiveSymbolsPerPartyB(await user2.getAddress(), posHedger.address, 0, 1000)
				expect(result.length).to.equal(0)
			})
		})

		describe("emergency close impact on aggregated positions", function () {
			it("reduces totals after emergency close", async function () {
				const before = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
				const quoteQuantity = await getQuoteQuantity(posContext, quote1LongOpened.id)

				// Enable emergency mode for partyB
				await posContext.pauseControlFacet.connect(posContext.signers.admin).setPartyBEmergencyStatus([posHedger.address], true)

				// Emergency close the position
				await posHedger.emergencyClosePosition(quote1LongOpened.id, emergencyCloseRequestBuilder().build())

				const after = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)

				// Verify totals are reduced
				expect(after.longPosition.aggregatedOpenAmount).to.equal(before.longPosition.aggregatedOpenAmount - quoteQuantity)
			})
		})

		describe("funding fee impact on avg open price", function () {
			describe("accumulated funding fee (new method)", function () {
				it("keeps totals consistent after funding accrual and charge", async function () {
					const before = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)

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

					const after = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
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

					const after = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
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

					const after = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
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

					const after = await posContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(posHedger.address, posUser.address, 1)
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

		describe("ClearingHouse Cross-Liquidation", function () {
			let clearingContext: RunContext
			let clearingUser: User, clearingUser2: User, clearingHedger: Hedger
			let openedQuoteIds: bigint[]

			beforeEach(async function () {
				clearingContext = await loadFixture(initializeFixture)

				clearingUser = new User(clearingContext, clearingContext.signers.user)
				await clearingUser.setup()
				await clearingUser.setBalances(decimal(5000n), decimal(3000n), decimal(2000n))

				clearingUser2 = new User(clearingContext, clearingContext.signers.user2)
				await clearingUser2.setup()
				await clearingUser2.setBalances(decimal(5000n), decimal(3000n), decimal(2000n))

				clearingHedger = new Hedger(clearingContext, clearingContext.signers.hedger)
				await clearingHedger.setup()
				await clearingHedger.setBalances(decimal(10000n), decimal(5000n))

				// Grant CLEARING_HOUSE_ROLE to liquidator
				await clearingContext.controlFacet.grantRole(
					clearingContext.signers.liquidator.address,
					ethers.keccak256(ethers.toUtf8Bytes("CLEARING_HOUSE_ROLE"))
				)

				// Enable new funding fee system
				await clearingContext.pauseControlFacet.connect(clearingContext.signers.admin).enableNewFundingFee()
				await clearingContext.fundingRateFacet.connect(clearingContext.signers.hedger).setEpochDurations([1], [EightHourInSec])
				await clearingContext.fundingRateFacet
					.connect(clearingContext.signers.hedger)
					.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

				openedQuoteIds = []

				// Open positions with user1
				const quote1Id = await clearingUser.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
				await clearingHedger.lockQuote(quote1Id)
				await clearingHedger.openPosition(quote1Id)
				openedQuoteIds.push(quote1Id)

				const quote2Id = await clearingUser.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).maxFundingRate(decimal(1n)).build())
				await clearingHedger.lockQuote(quote2Id)
				await clearingHedger.openPosition(quote2Id)
				openedQuoteIds.push(quote2Id)

				// Open position with user2
				const quote3Id = await clearingUser2.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
				await clearingHedger.lockQuote(quote3Id)
				await clearingHedger.openPosition(quote3Id)
				openedQuoteIds.push(quote3Id)

				// Allocate for master account mode
				await clearingContext.partyBAccountFacet.connect(clearingContext.signers.hedger).allocateForPartyB(decimal(3000n), ZeroAddress)

				// Migrate to master account mode
				await migratePartyBToMaster(clearingContext, clearingHedger, openedQuoteIds)
			})

			it("should update aggregates correctly during cross liquidation", async function () {
				// Get aggregates before liquidation
				const { longPosition: longBefore, shortPosition: shortBefore } = await clearingContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbol(
					await clearingHedger.getAddress(),
					1
				)
				expect(longBefore.aggregatedOpenAmount).to.be.gt(0n)
				expect(shortBefore.aggregatedOpenAmount).to.be.gt(0n)

				const activeSymbolsBefore = await clearingContext.viewFacetAggregate.getPartyBActiveSymbolsCount(await clearingHedger.getAddress())
				expect(activeSymbolsBefore).to.equal(1n)

				// Note: Funding aggregates (weightedPaidFunding) start at 0 and only accumulate
				// when chargeAccumulatedFundingFee is called. We verify they remain zero
				// after liquidation to ensure no stale data remains.

				// Initiate cross liquidation
				await clearingContext.clearingHouseFacet
					.connect(clearingContext.signers.liquidator)
					.liquidateCrossPartyB(
						await clearingHedger.getAddress(),
						await getDummyCrossLiquidationSig(undefined, BigInt("-999999999999999999999999999999"))
					)

				// Liquidate positions
				const priceSig = await getDummyPriceSig(openedQuoteIds, openedQuoteIds.map(() => decimal(1n)))
				await clearingContext.clearingHouseFacet
					.connect(clearingContext.signers.liquidator)
					.liquidatePositionsForCrossLiquidation(await clearingHedger.getAddress(), priceSig)

				// Verify position aggregates are zeroed
				const { longPosition: longAfter, shortPosition: shortAfter } = await clearingContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbol(
					await clearingHedger.getAddress(),
					1
				)
				expect(longAfter.aggregatedOpenAmount).to.equal(0n)
				expect(longAfter.avgOpenPrice).to.equal(0n)
				expect(shortAfter.aggregatedOpenAmount).to.equal(0n)
				expect(shortAfter.avgOpenPrice).to.equal(0n)

				// Verify funding aggregates are zeroed
				const fundingLongAfter = await clearingContext.viewFacetAggregate.getPartyBAggregatedFunding(
					await clearingHedger.getAddress(),
					1,
					PositionType.LONG
				)
				const fundingShortAfter = await clearingContext.viewFacetAggregate.getPartyBAggregatedFunding(
					await clearingHedger.getAddress(),
					1,
					PositionType.SHORT
				)
				expect(fundingLongAfter).to.equal(0n)
				expect(fundingShortAfter).to.equal(0n)

				// Verify active symbols list is empty
				const activeSymbolsAfter = await clearingContext.viewFacetAggregate.getPartyBActiveSymbolsCount(await clearingHedger.getAddress())
				expect(activeSymbolsAfter).to.equal(0n)
			})

			it("should update per-partyA aggregates correctly during cross liquidation", async function () {
				// Get per-partyA aggregates before
				const { longPosition: user1LongBefore } = await clearingContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(
					await clearingHedger.getAddress(),
					await clearingUser.getAddress(),
					1
				)
				const { longPosition: user2LongBefore } = await clearingContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(
					await clearingHedger.getAddress(),
					await clearingUser2.getAddress(),
					1
				)
				expect(user1LongBefore.aggregatedOpenAmount).to.be.gt(0n)
				expect(user2LongBefore.aggregatedOpenAmount).to.be.gt(0n)

				// Liquidate
				await clearingContext.clearingHouseFacet
					.connect(clearingContext.signers.liquidator)
					.liquidateCrossPartyB(
						await clearingHedger.getAddress(),
						await getDummyCrossLiquidationSig(undefined, BigInt("-999999999999999999999999999999"))
					)

				const priceSig = await getDummyPriceSig(openedQuoteIds, openedQuoteIds.map(() => decimal(1n)))
				await clearingContext.clearingHouseFacet
					.connect(clearingContext.signers.liquidator)
					.liquidatePositionsForCrossLiquidation(await clearingHedger.getAddress(), priceSig)

				// Verify per-partyA aggregates are zeroed
				const { longPosition: user1LongAfter, shortPosition: user1ShortAfter } = await clearingContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(
					await clearingHedger.getAddress(),
					await clearingUser.getAddress(),
					1
				)
				const { longPosition: user2LongAfter, shortPosition: user2ShortAfter } = await clearingContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(
					await clearingHedger.getAddress(),
					await clearingUser2.getAddress(),
					1
				)
				expect(user1LongAfter.aggregatedOpenAmount).to.equal(0n)
				expect(user1ShortAfter.aggregatedOpenAmount).to.equal(0n)
				expect(user2LongAfter.aggregatedOpenAmount).to.equal(0n)
				expect(user2ShortAfter.aggregatedOpenAmount).to.equal(0n)
			})
		})

		describe("ForceClosePosition Impact on Aggregates", function () {
			it("should update aggregates correctly after forceClosePosition", async function () {
				// Create fresh context to avoid interference from posContext
				const forceCloseContext = await loadFixture(initializeFixture)
				const forceCloseUser = new User(forceCloseContext, forceCloseContext.signers.user)
				await forceCloseUser.setup()
				await forceCloseUser.setBalances(decimal(5000n), decimal(5000n), decimal(5000n))

				const forceCloseHedger = new Hedger(forceCloseContext, forceCloseContext.signers.hedger)
				await forceCloseHedger.setBalances(decimal(5000n), decimal(5000n))

				// Setup funding
				await forceCloseContext.pauseControlFacet.connect(forceCloseContext.signers.admin).enableNewFundingFee()
				await forceCloseContext.fundingRateFacet.connect(forceCloseContext.signers.hedger).setEpochDurations([1], [EightHourInSec])
				await forceCloseContext.fundingRateFacet
					.connect(forceCloseContext.signers.hedger)
					.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

				// Grant force close roles and set parameters
				await forceCloseContext.controlFacet
					.connect(forceCloseContext.signers.admin)
					.grantRole(await forceCloseContext.signers.admin.getAddress(), ethers.keccak256(ethers.toUtf8Bytes("FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE")))
				await forceCloseContext.controlFacet.setForceCloseMinSigPeriod(10)
				await forceCloseContext.controlFacet.setForceCloseGapRatio(1, decimal(1n, 17))

				const quoteId = await forceCloseUser.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
				await forceCloseHedger.lockQuote(quoteId)
				await forceCloseHedger.openPosition(quoteId)

				const quote = await forceCloseContext.viewFacetQuote.getQuote(quoteId)
				const openAmount = quote.quantity - quote.closedAmount

				// Get aggregates before
				const { longPosition: longBefore } = await forceCloseContext.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(
					await forceCloseUser.getAddress(),
					await forceCloseHedger.getAddress(),
					1
				)
				expect(longBefore.aggregatedOpenAmount).to.equal(openAmount)

				// Request close with deadline in the future
				const now = await getBlockTimestamp()
				await forceCloseUser.requestToClosePosition(quoteId, limitCloseRequestBuilder().deadline(now + 1000n).build())

				// Calculate proper timing for force close
				const cooldowns = await forceCloseContext.viewFacet.forceCloseCooldowns()
				const firstCooldown = cooldowns[0]
				const secondCooldown = cooldowns[1]
				const period = 10n

				const startTime = firstCooldown + now
				const endTime = firstCooldown + now + period

				// Advance time past cooldowns
				await time.increase(firstCooldown + period + secondCooldown + 1n)

				// Force close with proper signature times
				const highLowSig = await getDummyHighLowPriceSig(
					startTime, // startTime
					endTime, // endTime
					decimal(9n, 17), // lowest
					decimal(11n, 17), // highest
					decimal(1n), // currentPrice
					decimal(1n), // averagePrice
					1n, // symbolId
					0n, // upnlPartyB
					0n // upnlPartyA
				)
				await forceCloseUser.forceClosePosition(quoteId, highLowSig)

				// Verify position aggregates are zeroed
				const { longPosition: longAfter } = await forceCloseContext.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(
					await forceCloseUser.getAddress(),
					await forceCloseHedger.getAddress(),
					1
				)
				expect(longAfter.aggregatedOpenAmount).to.equal(0n)
				expect(longAfter.avgOpenPrice).to.equal(0n)

				// Verify funding aggregates are zeroed
				const fundingAfter = await forceCloseContext.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
					await forceCloseUser.getAddress(),
					await forceCloseHedger.getAddress(),
					1,
					PositionType.LONG
				)
				expect(fundingAfter).to.equal(0n)

				// Verify partyB side is also zeroed
				const { longPosition: partyBLongAfter } = await forceCloseContext.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(
					await forceCloseHedger.getAddress(),
					await forceCloseUser.getAddress(),
					1
				)
				expect(partyBLongAfter.aggregatedOpenAmount).to.equal(0n)

				// Verify active symbols
				const activeSymbols = await forceCloseContext.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(
					await forceCloseUser.getAddress(),
					await forceCloseHedger.getAddress(),
					0,
					1000
				)
				expect(activeSymbols.length).to.equal(0)
			})
		})

		describe("ExpireQuote Aggregates Invariant", function () {
			it("should NOT modify aggregates when expiring CLOSE_PENDING quote", async function () {
				// Create fresh context to avoid interference from posContext
				const expireContext = await loadFixture(initializeFixture)
				const expireUser = new User(expireContext, expireContext.signers.user)
				await expireUser.setup()
				await expireUser.setBalances(decimal(5000n), decimal(5000n), decimal(5000n))

				const expireHedger = new Hedger(expireContext, expireContext.signers.hedger)
				await expireHedger.setBalances(decimal(5000n), decimal(5000n))

				// Setup funding
				await expireContext.pauseControlFacet.connect(expireContext.signers.admin).enableNewFundingFee()
				await expireContext.fundingRateFacet.connect(expireContext.signers.hedger).setEpochDurations([1], [EightHourInSec])
				await expireContext.fundingRateFacet
					.connect(expireContext.signers.hedger)
					.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

				const quoteId = await expireUser.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
				await expireHedger.lockQuote(quoteId)
				await expireHedger.openPosition(quoteId)

				// Get aggregates after open
				const { longPosition: positionAfterOpen } = await expireContext.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(
					await expireUser.getAddress(),
					await expireHedger.getAddress(),
					1
				)
				const openAmount = positionAfterOpen.aggregatedOpenAmount
				const avgPriceBefore = positionAfterOpen.avgOpenPrice
				expect(openAmount).to.be.gt(0n)
				expect(avgPriceBefore).to.be.gt(0n)

				// Get funding aggregate before
				const fundingBefore = await expireContext.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
					await expireUser.getAddress(),
					await expireHedger.getAddress(),
					1,
					PositionType.LONG
				)

				// Request close with short deadline
				await expireUser.requestToClosePosition(quoteId, limitCloseRequestBuilder().deadline(getBlockTimestamp(10n)).build())

				// Verify position is CLOSE_PENDING
				let quote = await expireContext.viewFacetQuote.getQuote(quoteId)
				expect(quote.quoteStatus).to.equal(BigInt(QuoteStatus.CLOSE_PENDING))

				// Wait for deadline to pass
				await time.increase(100)

				// Expire the quote
				await expireContext.partyAFacet.connect(expireContext.signers.user).expireQuote([quoteId])

				// Verify quote is back to OPENED
				quote = await expireContext.viewFacetQuote.getQuote(quoteId)
				expect(quote.quoteStatus).to.equal(BigInt(QuoteStatus.OPENED))

				// Verify position aggregates are UNCHANGED
				const { longPosition: positionAfterExpire } = await expireContext.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(
					await expireUser.getAddress(),
					await expireHedger.getAddress(),
					1
				)
				expect(positionAfterExpire.aggregatedOpenAmount).to.equal(openAmount)
				expect(positionAfterExpire.avgOpenPrice).to.equal(avgPriceBefore)

				// Verify funding aggregates are UNCHANGED
				const fundingAfter = await expireContext.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
					await expireUser.getAddress(),
					await expireHedger.getAddress(),
					1,
					PositionType.LONG
				)
				expect(fundingAfter).to.equal(fundingBefore)

				// Active symbols should still contain symbol 1
				const activeSymbols = await expireContext.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(
					await expireUser.getAddress(),
					await expireHedger.getAddress(),
					0,
					1000
				)
				expect(activeSymbols.length).to.equal(1)
				expect(activeSymbols[0]).to.equal(1n)
			})
		})

		describe("Global PartyB Funding (master account mode)", function () {
			const EightHourInSec = 8 * 60 * 60

			beforeEach(async function () {
				// Enable new funding fee system and setup funding rates for the hedger
				await posContext.pauseControlFacet.enableNewFundingFee()
				await posContext.symbolControlFacet.connect(posContext.signers.admin).setSymbolFundingState(1, EightHourInSec, 1200)
				await posContext.fundingRateFacet.connect(posContext.signers.hedger).setEpochDurations([1], [EightHourInSec])
				await posContext.fundingRateFacet
					.connect(posContext.signers.hedger)
					.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])
			})

			it("getPartyBAggregatedFunding returns global weighted paid funding", async function () {
				// Wait for some funding to accumulate
				await time.increase(EightHourInSec * 2)

				// Charge funding
				await posContext.fundingRateFacet
					.connect(posContext.signers.hedger)
					.chargeAccumulatedFundingFee(
						await posContext.signers.user.getAddress(),
						await posContext.signers.hedger.getAddress(),
						[quote1LongOpened.id],
						await getDummyPairUpnlSig(),
					)

				// Get global funding
				const globalFunding = await posContext.viewFacetAggregate.getPartyBAggregatedFunding(
					posHedger.address,
					1,
					PositionType.LONG
				)

				// Get per-partyA funding
				const perPartyAFunding = await posContext.viewFacetAggregate.getPartyBAggregatedFundingPerPartyA(
					posHedger.address,
					posUser.address,
					1,
					PositionType.LONG
				)

				// With only one partyA, global should equal per-partyA
				expect(globalFunding).to.equal(perPartyAFunding)
			})

			it("getPartyBGlobalAggregateFundingDebt returns global funding debt", async function () {
				// Wait for funding to accumulate
				await time.increase(EightHourInSec * 2)

				// Get global funding debt
				const globalDebt = await posContext.viewFacetAggregate.getPartyBGlobalAggregateFundingDebt(
					posHedger.address,
					1,
					PositionType.LONG
				)

				// Get per-partyA funding debt
				const perPartyADebt = await posContext.viewFacetAggregate.getPartyBAggregateFundingDebt(
					posHedger.address,
					posUser.address,
					1,
					PositionType.LONG
				)

				// With only one partyA, global should equal per-partyA
				expect(globalDebt).to.equal(perPartyADebt)
			})

			it("getPartyBGlobalAggregateFundingDebtByActiveSymbols returns global debts by symbol", async function () {
				// Wait for funding to accumulate
				await time.increase(EightHourInSec * 2)

				// Get global funding debts by active symbols
				const results = await posContext.viewFacetAggregate.getPartyBGlobalAggregateFundingDebtByActiveSymbols(
					posHedger.address,
					0,
					1000
				)

				// Should have entries for symbol 1 (the only active symbol)
				expect(results.length).to.be.gt(0)

				const longEntry = results.find((r: any) => BigInt(r.symbolId) === 1n && BigInt(r.positionType) === BigInt(PositionType.LONG))
				const shortEntry = results.find((r: any) => BigInt(r.symbolId) === 1n && BigInt(r.positionType) === BigInt(PositionType.SHORT))

				// Get individual debt for comparison
				const longDebt = await posContext.viewFacetAggregate.getPartyBGlobalAggregateFundingDebt(posHedger.address, 1, PositionType.LONG)
				const shortDebt = await posContext.viewFacetAggregate.getPartyBGlobalAggregateFundingDebt(posHedger.address, 1, PositionType.SHORT)

				if (longEntry) {
					expect(longEntry.fundingDebt).to.equal(longDebt)
				}
				if (shortEntry) {
					expect(shortEntry.fundingDebt).to.equal(shortDebt)
				}
			})

			it("global funding tracks across multiple partyAs", async function () {
				// Create a second user
				const user2 = new User(posContext, posContext.signers.user2)
				await user2.setup()
				await user2.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

				// user2 opens a position with the same hedger
				const user2Quote = await posContext.viewFacetQuote.getQuote(
					await user2.sendQuote(limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()),
				)
				await posHedger.lockQuote(user2Quote.id)
				await posHedger.openPosition(user2Quote.id)

				// Wait for funding to accumulate
				await time.increase(EightHourInSec * 2)

				// Charge funding for both users
				await posContext.fundingRateFacet
					.connect(posContext.signers.hedger)
					.chargeAccumulatedFundingFee(
						await posContext.signers.user.getAddress(),
						await posContext.signers.hedger.getAddress(),
						[quote1LongOpened.id],
						await getDummyPairUpnlSig(),
					)
				await posContext.fundingRateFacet
					.connect(posContext.signers.hedger)
					.chargeAccumulatedFundingFee(
						await user2.getAddress(),
						await posContext.signers.hedger.getAddress(),
						[user2Quote.id],
						await getDummyPairUpnlSig(),
					)

				// Get global funding
				const globalFunding = await posContext.viewFacetAggregate.getPartyBAggregatedFunding(
					posHedger.address,
					1,
					PositionType.LONG
				)

				// Get per-partyA funding for both users
				const user1Funding = await posContext.viewFacetAggregate.getPartyBAggregatedFundingPerPartyA(
					posHedger.address,
					posUser.address,
					1,
					PositionType.LONG
				)
				const user2Funding = await posContext.viewFacetAggregate.getPartyBAggregatedFundingPerPartyA(
					posHedger.address,
					await user2.getAddress(),
					1,
					PositionType.LONG
				)

				// Global should be sum of per-partyA funding
				expect(globalFunding).to.equal(user1Funding + user2Funding)
			})

			it("global funding debt aggregates across multiple partyAs", async function () {
				// Create a second user
				const user2 = new User(posContext, posContext.signers.user2)
				await user2.setup()
				await user2.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

				// user2 opens a position with the same hedger
				const user2Quote = await posContext.viewFacetQuote.getQuote(
					await user2.sendQuote(limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()),
				)
				await posHedger.lockQuote(user2Quote.id)
				await posHedger.openPosition(user2Quote.id)

				// Wait for funding to accumulate
				await time.increase(EightHourInSec * 2)

				// Get global funding debt
				const globalDebt = await posContext.viewFacetAggregate.getPartyBGlobalAggregateFundingDebt(
					posHedger.address,
					1,
					PositionType.LONG
				)

				// Get per-partyA funding debts
				const user1Debt = await posContext.viewFacetAggregate.getPartyBAggregateFundingDebt(
					posHedger.address,
					posUser.address,
					1,
					PositionType.LONG
				)
				const user2Debt = await posContext.viewFacetAggregate.getPartyBAggregateFundingDebt(
					posHedger.address,
					await user2.getAddress(),
					1,
					PositionType.LONG
				)

				// Global debt should equal sum of per-partyA debts
				expect(globalDebt).to.equal(user1Debt + user2Debt)
			})

			it("returns zero for partyB with no positions", async function () {
				const globalFunding = await posContext.viewFacetAggregate.getPartyBAggregatedFunding(
					posHedger2.address,
					1,
					PositionType.LONG
				)
				expect(globalFunding).to.equal(0)

				const globalDebt = await posContext.viewFacetAggregate.getPartyBGlobalAggregateFundingDebt(
					posHedger2.address,
					1,
					PositionType.LONG
				)
				expect(globalDebt).to.equal(0)

				const results = await posContext.viewFacetAggregate.getPartyBGlobalAggregateFundingDebtByActiveSymbols(
					posHedger2.address,
					0,
					1000
				)
				expect(results.length).to.equal(0)
			})
		})
	})

	// ============================================================================
	// SECTION 4: BATCH VIEWS BY ACTIVE SYMBOLS & PAGINATION
	// Tests for batch retrieval of positions and funding debt by active symbols
	// ============================================================================

	describe("Batch Views by Active Symbols", function () {
		beforeEach(async function () {
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])
		})

		it("should return empty array when no positions", async function () {
			const positions = await context.viewFacetAggregate.getPartyAAggregatedPositionsByActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(positions.length).to.equal(0)
		})

		it("should return correct aggregated positions", async function () {
			const quoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1n)).build())
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

			const positions = await context.viewFacetAggregate.getPartyAAggregatedPositionsByActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
			expect(positions.length).to.equal(1)
			expect(positions[0].symbolId).to.equal(1n)
			const { longPosition } = await context.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(await user.getAddress(), await hedger.getAddress(), 1)
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

			const positions = await context.viewFacetAggregate.getPartyAAggregatedPositionsByActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 1000)
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

			const fundingDebts = await context.viewFacetAggregate.getPartyAAggregateFundingDebtByActiveSymbols(
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

			const partyADebts = await context.viewFacetAggregate.getPartyAAggregateFundingDebtByActiveSymbols(
				await user.getAddress(), await hedger.getAddress(), 0, 1000
			)
			const partyBDebts = await context.viewFacetAggregate.getPartyBAggregateFundingDebtByActiveSymbols(
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

			const partyBPositions = await context.viewFacetAggregate.getPartyBAggregatedPositionsByActiveSymbolsPerPartyA(await hedger.getAddress(), await user.getAddress(), 0, 1000)
			expect(partyBPositions.length).to.equal(1)

			const partyBPerPartyA = await context.viewFacetAggregate.getPartyBAggregatedPositionsByActiveSymbolsPerPartyA(
				await hedger.getAddress(), await user.getAddress(), 0, 1000
			)
			expect(partyBPerPartyA.length).to.equal(1)
		})

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
				const partyACount = await context.viewFacetAggregate.getPartyAActiveSymbolsCountPerPartyB(await user.getAddress(), await hedger.getAddress())
				expect(partyACount).to.equal(4n)

				const partyBCount = await context.viewFacetAggregate.getPartyBActiveSymbolsCountPerPartyA(await hedger.getAddress(), await user.getAddress())
				expect(partyBCount).to.equal(4n)
			})

			it("should paginate active symbols correctly", async function () {
				const firstPage = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 2)
				expect(firstPage.length).to.equal(2)

				const secondPage = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 2, 2)
				expect(secondPage.length).to.equal(2)

				// All 4 symbols should be unique across pages
				const allSymbols = [...firstPage, ...secondPage]
				const uniqueSymbols = new Set(allSymbols.map(s => s.toString()))
				expect(uniqueSymbols.size).to.equal(4)
			})

			it("should return empty when start exceeds length", async function () {
				const result = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 100, 10)
				expect(result.length).to.equal(0)
			})

			it("should return empty when size is zero", async function () {
				const result = await context.viewFacetAggregate.getPartyAAggregatedPositionsByActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 0)
				expect(result.length).to.equal(0)
			})

			it("should cap size to remaining elements", async function () {
				// Request 100 starting at index 2, only 2 remain
				const result = await context.viewFacetAggregate.getPartyAActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 2, 100)
				expect(result.length).to.equal(2)
			})

			it("should paginate aggregated positions correctly", async function () {
				const firstPage = await context.viewFacetAggregate.getPartyAAggregatedPositionsByActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 0, 2)
				expect(firstPage.length).to.equal(2) // 2 symbols, 1 position each

				const secondPage = await context.viewFacetAggregate.getPartyAAggregatedPositionsByActiveSymbolsPerPartyB(await user.getAddress(), await hedger.getAddress(), 2, 2)
				expect(secondPage.length).to.equal(2)

				// All 4 symbols covered
				const allSymbolIds = [...firstPage, ...secondPage].map(p => p.symbolId)
				const uniqueSymbolIds = new Set(allSymbolIds.map(s => s.toString()))
				expect(uniqueSymbolIds.size).to.equal(4)
			})

			it("should paginate funding debt correctly", async function () {
				await time.increase(EightHourInSec)

				const firstPage = await context.viewFacetAggregate.getPartyAAggregateFundingDebtByActiveSymbols(
					await user.getAddress(), await hedger.getAddress(), 0, 2
				)
				expect(firstPage.length).to.equal(2)

				const secondPage = await context.viewFacetAggregate.getPartyAAggregateFundingDebtByActiveSymbols(
					await user.getAddress(), await hedger.getAddress(), 2, 2
				)
				expect(secondPage.length).to.equal(2)

				// All should have non-zero debt
				for (const debt of [...firstPage, ...secondPage]) {
					expect(debt.fundingDebt).to.not.equal(0)
				}
			})
		})
	})

	// ============================================================================
	// SECTION 5: UPNL DATA VIEW METHODS
	// Tests for getting all data needed for off-chain UPNL calculation
	// ============================================================================

	describe("UPNL Data View Methods", function () {
		const NUM_SYMBOLS_FOR_PAGINATION = 20 // Use 20 symbols to test pagination

		beforeEach(async function () {
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])
		})

		// Helper to create multiple symbols
		async function createSymbols(count: number): Promise<void> {
			const symbolIds: number[] = []
			const epochDurations: number[] = []
			const symbolTypes: number[] = []
			const longRates: bigint[] = []
			const shortRates: bigint[] = []
			const prices: bigint[] = []

			for (let i = 2; i <= count + 1; i++) {
				await context.symbolControlFacet
					.connect(context.signers.admin)
					.addSymbol(`SYMBOL${i}`, decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
				symbolIds.push(i)
				epochDurations.push(EightHourInSec)
				symbolTypes.push(1)
				longRates.push(decimal(1n, 14))
				shortRates.push(-decimal(1n, 14))
				prices.push(decimal(1n))
			}

			await context.symbolControlFacet.connect(context.signers.admin).setSymbolTypes(symbolIds, symbolTypes)
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations(symbolIds, epochDurations)
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.updateAccumulatedFundingFee(symbolIds, longRates, shortRates, prices)
		}

		// Helper to open a position and return quote ID
		async function openPosition(symbolId: number, positionType: PositionType): Promise<bigint> {
			const quoteId = await user.sendQuote(
				limitQuoteRequestBuilder()
					.symbolId(symbolId)
					.positionType(positionType)
					.maxFundingRate(decimal(1n))
					.build()
			)
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)
			return quoteId
		}

		describe("getPartyAUpnlData", function () {
			it("single LONG position", async function () {
				const quoteId = await openPosition(1, PositionType.LONG)
				await time.increase(EightHourInSec * 2)

				const quote = await context.viewFacetQuote.getQuote(quoteId)
				const upnlData = await context.viewFacetAggregate.getPartyAUpnlData(
					await user.getAddress(),
					await hedger.getAddress(),
					0,
					1000
				)

				expect(upnlData.length).to.equal(1)
				expect(upnlData[0].symbolId).to.equal(1n)
				expect(upnlData[0].positionType).to.equal(PositionType.LONG)
				expect(upnlData[0].aggregatedAmount).to.equal(quote.quantity)
				expect(upnlData[0].avgOpenPrice).to.equal(quote.openedPrice)

				// Verify funding debt matches getSumQuoteFundingDebts
				const expectedFundingDebt = await context.viewFacetQuote.getSumQuoteFundingDebts([quoteId])
				expect(upnlData[0].fundingDebt).to.equal(expectedFundingDebt)
			})

			it("single SHORT position", async function () {
				const quoteId = await openPosition(1, PositionType.SHORT)
				await time.increase(EightHourInSec * 2)

				const quote = await context.viewFacetQuote.getQuote(quoteId)
				const upnlData = await context.viewFacetAggregate.getPartyAUpnlData(
					await user.getAddress(),
					await hedger.getAddress(),
					0,
					1000
				)

				expect(upnlData.length).to.equal(1)
				expect(upnlData[0].symbolId).to.equal(1n)
				expect(upnlData[0].positionType).to.equal(PositionType.SHORT)
				expect(upnlData[0].aggregatedAmount).to.equal(quote.quantity)
				expect(upnlData[0].avgOpenPrice).to.equal(quote.openedPrice)

				// Verify funding debt matches getSumQuoteFundingDebts
				const expectedFundingDebt = await context.viewFacetQuote.getSumQuoteFundingDebts([quoteId])
				expect(upnlData[0].fundingDebt).to.equal(expectedFundingDebt)
			})

			it("combination of LONG and SHORT with 1 symbol", async function () {
				const longQuoteId = await openPosition(1, PositionType.LONG)
				const shortQuoteId = await openPosition(1, PositionType.SHORT)
				await time.increase(EightHourInSec * 2)

				const longQuote = await context.viewFacetQuote.getQuote(longQuoteId)
				const shortQuote = await context.viewFacetQuote.getQuote(shortQuoteId)

				const upnlData = await context.viewFacetAggregate.getPartyAUpnlData(
					await user.getAddress(),
					await hedger.getAddress(),
					0,
					1000
				)

				expect(upnlData.length).to.equal(2)

				const longData = upnlData.find(d => Number(d.positionType) === PositionType.LONG)
				const shortData = upnlData.find(d => Number(d.positionType) === PositionType.SHORT)

				expect(longData).to.not.be.undefined
				expect(longData!.symbolId).to.equal(1n)
				expect(longData!.aggregatedAmount).to.equal(longQuote.quantity)
				expect(longData!.avgOpenPrice).to.equal(longQuote.openedPrice)

				expect(shortData).to.not.be.undefined
				expect(shortData!.symbolId).to.equal(1n)
				expect(shortData!.aggregatedAmount).to.equal(shortQuote.quantity)
				expect(shortData!.avgOpenPrice).to.equal(shortQuote.openedPrice)

				// Verify funding debts
				const longFundingDebt = await context.viewFacetQuote.getSumQuoteFundingDebts([longQuoteId])
				const shortFundingDebt = await context.viewFacetQuote.getSumQuoteFundingDebts([shortQuoteId])
				expect(longData!.fundingDebt).to.equal(longFundingDebt)
				expect(shortData!.fundingDebt).to.equal(shortFundingDebt)
			})

			it("combination of LONG and SHORT with many symbols", async function () {
				// Create 4 additional symbols (total 5)
				await createSymbols(4)

				// Open positions across different symbols
				const quoteIds: Map<number, { long?: bigint; short?: bigint }> = new Map()

				// Symbol 1: LONG only
				quoteIds.set(1, { long: await openPosition(1, PositionType.LONG) })

				// Symbol 2: SHORT only
				quoteIds.set(2, { short: await openPosition(2, PositionType.SHORT) })

				// Symbol 3: Both LONG and SHORT
				quoteIds.set(3, {
					long: await openPosition(3, PositionType.LONG),
					short: await openPosition(3, PositionType.SHORT),
				})

				// Symbol 4: LONG only
				quoteIds.set(4, { long: await openPosition(4, PositionType.LONG) })

				// Symbol 5: SHORT only
				quoteIds.set(5, { short: await openPosition(5, PositionType.SHORT) })

				await time.increase(EightHourInSec * 2)

				const upnlData = await context.viewFacetAggregate.getPartyAUpnlData(
					await user.getAddress(),
					await hedger.getAddress(),
					0,
					1000
				)

				// Should have 6 entries: 3 LONGs (symbols 1,3,4) + 3 SHORTs (symbols 2,3,5)
				expect(upnlData.length).to.equal(6)

				// Verify each symbol's data
				for (const [symbolId, ids] of quoteIds) {
					if (ids.long) {
						const longData = upnlData.find(
							d => Number(d.symbolId) === symbolId && Number(d.positionType) === PositionType.LONG
						)
						expect(longData).to.not.be.undefined
						const quote = await context.viewFacetQuote.getQuote(ids.long)
						expect(longData!.aggregatedAmount).to.equal(quote.quantity)
						expect(longData!.avgOpenPrice).to.equal(quote.openedPrice)

						const expectedFunding = await context.viewFacetQuote.getSumQuoteFundingDebts([ids.long])
						expect(longData!.fundingDebt).to.equal(expectedFunding)
					}
					if (ids.short) {
						const shortData = upnlData.find(
							d => Number(d.symbolId) === symbolId && Number(d.positionType) === PositionType.SHORT
						)
						expect(shortData).to.not.be.undefined
						const quote = await context.viewFacetQuote.getQuote(ids.short)
						expect(shortData!.aggregatedAmount).to.equal(quote.quantity)
						expect(shortData!.avgOpenPrice).to.equal(quote.openedPrice)

						const expectedFunding = await context.viewFacetQuote.getSumQuoteFundingDebts([ids.short])
						expect(shortData!.fundingDebt).to.equal(expectedFunding)
					}
				}
			})

			it("pagination with many symbols", async function () {
				// Create many symbols to test pagination
				await createSymbols(NUM_SYMBOLS_FOR_PAGINATION - 1) // -1 because symbol 1 already exists

				// Open positions in all symbols
				const quoteIds: bigint[] = []
				for (let i = 1; i <= NUM_SYMBOLS_FOR_PAGINATION; i++) {
					quoteIds.push(await openPosition(i, PositionType.LONG))
				}

				await time.increase(EightHourInSec)

				// Get total count
				const totalActiveSymbols = await context.viewFacetAggregate.getPartyAActiveSymbolsCountPerPartyB(
					await user.getAddress(),
					await hedger.getAddress()
				)
				expect(totalActiveSymbols).to.equal(BigInt(NUM_SYMBOLS_FOR_PAGINATION))

				// Test pagination with page size of 10
				const pageSize = 10
				const allData: any[] = []

				for (let start = 0; start < NUM_SYMBOLS_FOR_PAGINATION; start += pageSize) {
					const page = await context.viewFacetAggregate.getPartyAUpnlData(
						await user.getAddress(),
						await hedger.getAddress(),
						start,
						pageSize
					)
					allData.push(...page)
				}

				// Should have all symbols
				expect(allData.length).to.equal(NUM_SYMBOLS_FOR_PAGINATION)

				// All symbol IDs should be unique
				const symbolIds = allData.map(d => Number(d.symbolId))
				const uniqueSymbolIds = new Set(symbolIds)
				expect(uniqueSymbolIds.size).to.equal(NUM_SYMBOLS_FOR_PAGINATION)

				// Verify funding debt for a few samples
				for (let i = 0; i < 5; i++) {
					const data = allData[i]
					const symbolId = Number(data.symbolId)
					const quoteId = quoteIds[symbolId - 1]
					const expectedFunding = await context.viewFacetQuote.getSumQuoteFundingDebts([quoteId])
					expect(data.fundingDebt).to.equal(expectedFunding)
				}
			})
		})

		describe("getPartyBUpnlData", function () {
			it("single LONG position", async function () {
				const quoteId = await openPosition(1, PositionType.LONG)
				await time.increase(EightHourInSec * 2)

				const quote = await context.viewFacetQuote.getQuote(quoteId)
				const upnlData = await context.viewFacetAggregate.getPartyBUpnlData(
					await hedger.getAddress(),
					await user.getAddress(),
					0,
					1000
				)

				expect(upnlData.length).to.equal(1)
				expect(upnlData[0].symbolId).to.equal(1n)
				expect(upnlData[0].positionType).to.equal(PositionType.LONG)
				expect(upnlData[0].aggregatedAmount).to.equal(quote.quantity)
				expect(upnlData[0].avgOpenPrice).to.equal(quote.openedPrice)

				// PartyB funding debt is opposite to partyA's
				const partyAFundingDebt = await context.viewFacetQuote.getSumQuoteFundingDebts([quoteId])
				expect(upnlData[0].fundingDebt).to.equal(-partyAFundingDebt)
			})

			it("single SHORT position", async function () {
				const quoteId = await openPosition(1, PositionType.SHORT)
				await time.increase(EightHourInSec * 2)

				const quote = await context.viewFacetQuote.getQuote(quoteId)
				const upnlData = await context.viewFacetAggregate.getPartyBUpnlData(
					await hedger.getAddress(),
					await user.getAddress(),
					0,
					1000
				)

				expect(upnlData.length).to.equal(1)
				expect(upnlData[0].symbolId).to.equal(1n)
				expect(upnlData[0].positionType).to.equal(PositionType.SHORT)
				expect(upnlData[0].aggregatedAmount).to.equal(quote.quantity)
				expect(upnlData[0].avgOpenPrice).to.equal(quote.openedPrice)

				// PartyB funding debt is opposite to partyA's
				const partyAFundingDebt = await context.viewFacetQuote.getSumQuoteFundingDebts([quoteId])
				expect(upnlData[0].fundingDebt).to.equal(-partyAFundingDebt)
			})

			it("combination of LONG and SHORT with 1 symbol", async function () {
				const longQuoteId = await openPosition(1, PositionType.LONG)
				const shortQuoteId = await openPosition(1, PositionType.SHORT)
				await time.increase(EightHourInSec * 2)

				const longQuote = await context.viewFacetQuote.getQuote(longQuoteId)
				const shortQuote = await context.viewFacetQuote.getQuote(shortQuoteId)

				const upnlData = await context.viewFacetAggregate.getPartyBUpnlData(
					await hedger.getAddress(),
					await user.getAddress(),
					0,
					1000
				)

				expect(upnlData.length).to.equal(2)

				const longData = upnlData.find(d => Number(d.positionType) === PositionType.LONG)
				const shortData = upnlData.find(d => Number(d.positionType) === PositionType.SHORT)

				expect(longData).to.not.be.undefined
				expect(longData!.aggregatedAmount).to.equal(longQuote.quantity)
				expect(longData!.avgOpenPrice).to.equal(longQuote.openedPrice)

				expect(shortData).to.not.be.undefined
				expect(shortData!.aggregatedAmount).to.equal(shortQuote.quantity)
				expect(shortData!.avgOpenPrice).to.equal(shortQuote.openedPrice)

				// Verify funding debts are opposite to partyA's
				const longFundingDebt = await context.viewFacetQuote.getSumQuoteFundingDebts([longQuoteId])
				const shortFundingDebt = await context.viewFacetQuote.getSumQuoteFundingDebts([shortQuoteId])
				expect(longData!.fundingDebt).to.equal(-longFundingDebt)
				expect(shortData!.fundingDebt).to.equal(-shortFundingDebt)
			})

			it("combination of LONG and SHORT with many symbols", async function () {
				await createSymbols(4)

				const quoteIds: Map<number, { long?: bigint; short?: bigint }> = new Map()
				quoteIds.set(1, { long: await openPosition(1, PositionType.LONG) })
				quoteIds.set(2, { short: await openPosition(2, PositionType.SHORT) })
				quoteIds.set(3, {
					long: await openPosition(3, PositionType.LONG),
					short: await openPosition(3, PositionType.SHORT),
				})
				quoteIds.set(4, { long: await openPosition(4, PositionType.LONG) })
				quoteIds.set(5, { short: await openPosition(5, PositionType.SHORT) })

				await time.increase(EightHourInSec * 2)

				const upnlData = await context.viewFacetAggregate.getPartyBUpnlData(
					await hedger.getAddress(),
					await user.getAddress(),
					0,
					1000
				)

				expect(upnlData.length).to.equal(6)

				// Verify funding debts are opposite
				for (const [symbolId, ids] of quoteIds) {
					if (ids.long) {
						const longData = upnlData.find(
							d => Number(d.symbolId) === symbolId && Number(d.positionType) === PositionType.LONG
						)
						const partyAFunding = await context.viewFacetQuote.getSumQuoteFundingDebts([ids.long])
						expect(longData!.fundingDebt).to.equal(-partyAFunding)
					}
					if (ids.short) {
						const shortData = upnlData.find(
							d => Number(d.symbolId) === symbolId && Number(d.positionType) === PositionType.SHORT
						)
						const partyAFunding = await context.viewFacetQuote.getSumQuoteFundingDebts([ids.short])
						expect(shortData!.fundingDebt).to.equal(-partyAFunding)
					}
				}
			})

			it("pagination with many symbols", async function () {
				await createSymbols(NUM_SYMBOLS_FOR_PAGINATION - 1)

				const quoteIds: bigint[] = []
				for (let i = 1; i <= NUM_SYMBOLS_FOR_PAGINATION; i++) {
					quoteIds.push(await openPosition(i, PositionType.LONG))
				}

				await time.increase(EightHourInSec)

				const totalActiveSymbols = await context.viewFacetAggregate.getPartyBActiveSymbolsCountPerPartyA(
					await hedger.getAddress(),
					await user.getAddress()
				)
				expect(totalActiveSymbols).to.equal(BigInt(NUM_SYMBOLS_FOR_PAGINATION))

				const pageSize = 10
				const allData: any[] = []

				for (let start = 0; start < NUM_SYMBOLS_FOR_PAGINATION; start += pageSize) {
					const page = await context.viewFacetAggregate.getPartyBUpnlData(
						await hedger.getAddress(),
						await user.getAddress(),
						start,
						pageSize
					)
					allData.push(...page)
				}

				expect(allData.length).to.equal(NUM_SYMBOLS_FOR_PAGINATION)

				const symbolIds = allData.map(d => Number(d.symbolId))
				const uniqueSymbolIds = new Set(symbolIds)
				expect(uniqueSymbolIds.size).to.equal(NUM_SYMBOLS_FOR_PAGINATION)

				// Verify funding debt is opposite for samples
				for (let i = 0; i < 5; i++) {
					const data = allData[i]
					const symbolId = Number(data.symbolId)
					const quoteId = quoteIds[symbolId - 1]
					const partyAFunding = await context.viewFacetQuote.getSumQuoteFundingDebts([quoteId])
					expect(data.fundingDebt).to.equal(-partyAFunding)
				}
			})
		})

		describe("getPartyBGlobalUpnlData", function () {
			it("single LONG position", async function () {
				const quoteId = await openPosition(1, PositionType.LONG)
				await time.increase(EightHourInSec * 2)

				const quote = await context.viewFacetQuote.getQuote(quoteId)
				const upnlData = await context.viewFacetAggregate.getPartyBGlobalUpnlData(
					await hedger.getAddress(),
					0,
					1000
				)

				expect(upnlData.length).to.equal(1)
				expect(upnlData[0].symbolId).to.equal(1n)
				expect(upnlData[0].positionType).to.equal(PositionType.LONG)
				expect(upnlData[0].aggregatedAmount).to.equal(quote.quantity)
				expect(upnlData[0].avgOpenPrice).to.equal(quote.openedPrice)

				// Global funding debt should be opposite to partyA's
				const partyAFundingDebt = await context.viewFacetQuote.getSumQuoteFundingDebts([quoteId])
				expect(upnlData[0].fundingDebt).to.equal(-partyAFundingDebt)
			})

			it("single SHORT position", async function () {
				const quoteId = await openPosition(1, PositionType.SHORT)
				await time.increase(EightHourInSec * 2)

				const quote = await context.viewFacetQuote.getQuote(quoteId)
				const upnlData = await context.viewFacetAggregate.getPartyBGlobalUpnlData(
					await hedger.getAddress(),
					0,
					1000
				)

				expect(upnlData.length).to.equal(1)
				expect(upnlData[0].symbolId).to.equal(1n)
				expect(upnlData[0].positionType).to.equal(PositionType.SHORT)
				expect(upnlData[0].aggregatedAmount).to.equal(quote.quantity)
				expect(upnlData[0].avgOpenPrice).to.equal(quote.openedPrice)

				const partyAFundingDebt = await context.viewFacetQuote.getSumQuoteFundingDebts([quoteId])
				expect(upnlData[0].fundingDebt).to.equal(-partyAFundingDebt)
			})

			it("combination of LONG and SHORT with 1 symbol", async function () {
				const longQuoteId = await openPosition(1, PositionType.LONG)
				const shortQuoteId = await openPosition(1, PositionType.SHORT)
				await time.increase(EightHourInSec * 2)

				const longQuote = await context.viewFacetQuote.getQuote(longQuoteId)
				const shortQuote = await context.viewFacetQuote.getQuote(shortQuoteId)

				const upnlData = await context.viewFacetAggregate.getPartyBGlobalUpnlData(
					await hedger.getAddress(),
					0,
					1000
				)

				expect(upnlData.length).to.equal(2)

				const longData = upnlData.find(d => Number(d.positionType) === PositionType.LONG)
				const shortData = upnlData.find(d => Number(d.positionType) === PositionType.SHORT)

				expect(longData).to.not.be.undefined
				expect(longData!.aggregatedAmount).to.equal(longQuote.quantity)

				expect(shortData).to.not.be.undefined
				expect(shortData!.aggregatedAmount).to.equal(shortQuote.quantity)

				// Verify funding debts
				const longFundingDebt = await context.viewFacetQuote.getSumQuoteFundingDebts([longQuoteId])
				const shortFundingDebt = await context.viewFacetQuote.getSumQuoteFundingDebts([shortQuoteId])
				expect(longData!.fundingDebt).to.equal(-longFundingDebt)
				expect(shortData!.fundingDebt).to.equal(-shortFundingDebt)
			})

			it("combination of LONG and SHORT with many symbols", async function () {
				await createSymbols(4)

				const quoteIds: Map<number, { long?: bigint; short?: bigint }> = new Map()
				quoteIds.set(1, { long: await openPosition(1, PositionType.LONG) })
				quoteIds.set(2, { short: await openPosition(2, PositionType.SHORT) })
				quoteIds.set(3, {
					long: await openPosition(3, PositionType.LONG),
					short: await openPosition(3, PositionType.SHORT),
				})
				quoteIds.set(4, { long: await openPosition(4, PositionType.LONG) })
				quoteIds.set(5, { short: await openPosition(5, PositionType.SHORT) })

				await time.increase(EightHourInSec * 2)

				const upnlData = await context.viewFacetAggregate.getPartyBGlobalUpnlData(
					await hedger.getAddress(),
					0,
					1000
				)

				expect(upnlData.length).to.equal(6)

				// Verify funding debts
				for (const [symbolId, ids] of quoteIds) {
					if (ids.long) {
						const longData = upnlData.find(
							d => Number(d.symbolId) === symbolId && Number(d.positionType) === PositionType.LONG
						)
						const partyAFunding = await context.viewFacetQuote.getSumQuoteFundingDebts([ids.long])
						expect(longData!.fundingDebt).to.equal(-partyAFunding)
					}
					if (ids.short) {
						const shortData = upnlData.find(
							d => Number(d.symbolId) === symbolId && Number(d.positionType) === PositionType.SHORT
						)
						const partyAFunding = await context.viewFacetQuote.getSumQuoteFundingDebts([ids.short])
						expect(shortData!.fundingDebt).to.equal(-partyAFunding)
					}
				}
			})

			it("pagination with many symbols", async function () {
				await createSymbols(NUM_SYMBOLS_FOR_PAGINATION - 1)

				const quoteIds: bigint[] = []
				for (let i = 1; i <= NUM_SYMBOLS_FOR_PAGINATION; i++) {
					quoteIds.push(await openPosition(i, PositionType.LONG))
				}

				await time.increase(EightHourInSec)

				const totalActiveSymbols = await context.viewFacetAggregate.getPartyBActiveSymbolsCount(
					await hedger.getAddress()
				)
				expect(totalActiveSymbols).to.equal(BigInt(NUM_SYMBOLS_FOR_PAGINATION))

				const pageSize = 10
				const allData: any[] = []

				for (let start = 0; start < NUM_SYMBOLS_FOR_PAGINATION; start += pageSize) {
					const page = await context.viewFacetAggregate.getPartyBGlobalUpnlData(
						await hedger.getAddress(),
						start,
						pageSize
					)
					allData.push(...page)
				}

				expect(allData.length).to.equal(NUM_SYMBOLS_FOR_PAGINATION)

				const symbolIds = allData.map(d => Number(d.symbolId))
				const uniqueSymbolIds = new Set(symbolIds)
				expect(uniqueSymbolIds.size).to.equal(NUM_SYMBOLS_FOR_PAGINATION)

				// Verify funding debt is opposite for samples
				for (let i = 0; i < 5; i++) {
					const data = allData[i]
					const symbolId = Number(data.symbolId)
					const quoteId = quoteIds[symbolId - 1]
					const partyAFunding = await context.viewFacetQuote.getSumQuoteFundingDebts([quoteId])
					expect(data.fundingDebt).to.equal(-partyAFunding)
				}
			})

			it("aggregates across multiple partyAs", async function () {
				// Setup second user
				const user2 = new User(context, context.signers.user2)
				await user2.setup()
				await user2.setBalances(decimal(5000n), decimal(5000n), decimal(5000n))

				// Open position with user1
				const quote1Id = await openPosition(1, PositionType.LONG)

				// Open position with user2 (same symbol, same hedger)
				const quote2Id = await user2.sendQuote(
					limitQuoteRequestBuilder()
						.positionType(PositionType.LONG)
						.maxFundingRate(decimal(1n))
						.build()
				)
				await hedger.lockQuote(quote2Id)
				await hedger.openPosition(quote2Id)

				await time.increase(EightHourInSec * 2)

				const quote1 = await context.viewFacetQuote.getQuote(quote1Id)
				const quote2 = await context.viewFacetQuote.getQuote(quote2Id)

				const globalUpnlData = await context.viewFacetAggregate.getPartyBGlobalUpnlData(
					await hedger.getAddress(),
					0,
					1000
				)

				expect(globalUpnlData.length).to.equal(1)
				// Should aggregate both users' positions
				expect(globalUpnlData[0].aggregatedAmount).to.equal(quote1.quantity + quote2.quantity)
				expect(globalUpnlData[0].avgOpenPrice).to.equal(quote1.openedPrice)

				// Global funding debt should be sum of individual funding debts (negated)
				const totalFunding = await context.viewFacetQuote.getSumQuoteFundingDebts([quote1Id, quote2Id])
				expect(globalUpnlData[0].fundingDebt).to.equal(-totalFunding)
			})
		})
	})
}
