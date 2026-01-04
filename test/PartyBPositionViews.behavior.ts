import { expect } from "chai"

import type { QuoteSettlementDataStructOutput } from "../src/types/facets/Settlement/ISettlementFacet.js"
import type { QuoteStructOutput } from "../src/types/interfaces/ISymmio.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { PositionType } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, getQuoteQuantity, unDecimal } from "./utils/Common.js"
import { getDummyLiquidationSig, getDummyPairUpnlSig, getDummySettlementSig } from "./utils/SignatureUtils.js"

export function shouldBehaveLikePartyBPositionViews(): void {
	let user: User, hedger: Hedger, hedger2: Hedger
	let context: RunContext
	let quote1LongOpened: QuoteStructOutput, quote2ShortOpened: QuoteStructOutput, quote3LongOpened: QuoteStructOutput
	const getExpectedTotals = async (quoteIds: bigint[]) => {
		let longAmount = 0n
		let longNotional = 0n
		let shortAmount = 0n
		let shortNotional = 0n

		for (const quoteId of quoteIds) {
			const quote = await context.viewFacetQuote.getQuote(quoteId)
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
		context = await loadFixture(initializeFixture)
		this.user_allocated = decimal(500n)
		this.hedger_allocated = decimal(4000n)

		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(this.hedger_allocated, this.hedger_allocated)

		hedger2 = new Hedger(context, context.signers.hedger2)
		await hedger2.setup()
		await hedger2.setBalances(this.hedger_allocated, this.hedger_allocated)

		// Quote1 LONG opened
		quote1LongOpened = await context.viewFacetQuote.getQuote(await user.sendQuote())
		await hedger.lockQuote(quote1LongOpened.id)
		await hedger.openPosition(quote1LongOpened.id)

		// Quote2 SHORT opened
		quote2ShortOpened = await context.viewFacetQuote.getQuote(
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build()),
		)
		await hedger.lockQuote(quote2ShortOpened.id)
		await hedger.openPosition(quote2ShortOpened.id)

		// Quote3 LONG opened
		quote3LongOpened = await context.viewFacetQuote.getQuote(await user.sendQuote())
		await hedger.lockQuote(quote3LongOpened.id)
		await hedger.openPosition(quote3LongOpened.id)
	})

	describe("getPartyBAggregatedPositionBySymbol", function () {
		it("returns correct totals and average prices for LONG and SHORT positions", async function () {
			const symbolId = quote1LongOpened.symbolId
			const quoteIds = [quote1LongOpened.id, quote2ShortOpened.id, quote3LongOpened.id]
			let expectedLongOpenAmount = 0n
			let expectedShortOpenAmount = 0n
			let expectedLongNotional = 0n
			let expectedShortNotional = 0n

			for (const quoteId of quoteIds) {
				const quote = await context.viewFacetQuote.getQuote(quoteId)
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

			const { longPosition, shortPosition } = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, symbolId)
			expect(longPosition.positionType).to.equal(BigInt(PositionType.LONG))
			expect(longPosition.aggregatedOpenAmount).to.equal(expectedLongOpenAmount)
			expect(longPosition.avgOpenPrice).to.equal(expectedLongOpenAmount === 0n ? 0n : expectedLongNotional / expectedLongOpenAmount)
			expect(shortPosition.positionType).to.equal(BigInt(PositionType.SHORT))
			expect(shortPosition.aggregatedOpenAmount).to.equal(expectedShortOpenAmount)
			expect(shortPosition.avgOpenPrice).to.equal(expectedShortOpenAmount === 0n ? 0n : expectedShortNotional / expectedShortOpenAmount)
		})

		it("computes weighted averages across multiple fills at different prices", async function () {
			await user.setBalances(decimal(1000n), decimal(1000n), decimal(1000n))

			// open an extra LONG at a different price to shift the average
			const extraLongQuoteId = await user.sendQuote(limitQuoteRequestBuilder().build())
			const extraLongQuote = await context.viewFacetQuote.getQuote(extraLongQuoteId)
			await hedger.lockQuote(extraLongQuote.id)
			await hedger.openPosition(extraLongQuote.id, limitOpenRequestBuilder().openPrice(decimal(5n, 17)).build())

			const quoteIds = [quote1LongOpened.id, quote3LongOpened.id, quote2ShortOpened.id, extraLongQuote.id]
			let longAmount = 0n
			let longNotional = 0n
			let shortAmount = 0n
			let shortNotional = 0n

			for (const qid of quoteIds) {
				const q = await context.viewFacetQuote.getQuote(qid)
				const amount = q.quantity - q.closedAmount
				if (q.positionType === BigInt(PositionType.LONG)) {
					longAmount += amount
					longNotional += amount * q.openedPrice
				} else {
					shortAmount += amount
					shortNotional += amount * q.openedPrice
				}
			}

			const { longPosition, shortPosition } = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, 1)
			expect(longPosition.aggregatedOpenAmount).to.equal(longAmount)
			expect(longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
			expect(shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
			expect(shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
		})

		it("returns zero entries when no positions exist for symbol", async function () {
			// Add a new symbol that has no positions
			await context.symbolControlFacet
				.connect(context.signers.admin)
				.addSymbol("EMPTY_SYMBOL", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
			await context.symbolControlFacet.connect(context.signers.admin).setSymbolTypes([2], [1])

			const { longPosition, shortPosition } = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, 2)
			expect(longPosition.aggregatedOpenAmount).to.equal(0n)
			expect(shortPosition.aggregatedOpenAmount).to.equal(0n)
			expect(longPosition.avgOpenPrice).to.equal(0n)
			expect(shortPosition.avgOpenPrice).to.equal(0n)
		})

		it("returns zero for partyB with no position history", async function () {
			const { longPosition, shortPosition } = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger2.address, 1)
			expect(longPosition.aggregatedOpenAmount).to.equal(0n)
			expect(shortPosition.aggregatedOpenAmount).to.equal(0n)
			expect(longPosition.avgOpenPrice).to.equal(0n)
			expect(shortPosition.avgOpenPrice).to.equal(0n)
		})

		it("isolates totals between different partyBs", async function () {
			// hedger2 opens a position with user
			const newQuoteId = await user.sendQuote()
			const user2Quote = await context.viewFacetQuote.getQuote(newQuoteId)
			await hedger2.lockQuote(user2Quote.id)
			await hedger2.openPosition(user2Quote.id) // Use default price

			// hedger should still have their original totals
			const hedgerTotals = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, 1)
			const hedger2Totals = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger2.address, 1)

			// hedger has 2 LONGs and 1 SHORT
			expect(hedgerTotals.longPosition.aggregatedOpenAmount).to.be.gt(0n)
			expect(hedgerTotals.shortPosition.aggregatedOpenAmount).to.be.gt(0n)

			// hedger2 has 1 LONG only
			expect(hedger2Totals.longPosition.aggregatedOpenAmount).to.equal(user2Quote.quantity)
			expect(hedger2Totals.shortPosition.aggregatedOpenAmount).to.equal(0n)
		})

		it("updates totals correctly after opening new position", async function () {
			const before = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, 1)

			// Open another LONG
			await user.setBalances(decimal(1000n), decimal(1000n), decimal(1000n))
			const newQuote = await context.viewFacetQuote.getQuote(await user.sendQuote())
			await hedger.lockQuote(newQuote.id)
			await hedger.openPosition(newQuote.id)

			const after = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, 1)

			expect(after.longPosition.aggregatedOpenAmount).to.equal(before.longPosition.aggregatedOpenAmount + newQuote.quantity)
			expect(after.shortPosition.aggregatedOpenAmount).to.equal(before.shortPosition.aggregatedOpenAmount)
		})

		it("decreases totals after partial close via fillCloseRequest", async function () {
			const before = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, 1)
			const closeQuantity = (await getQuoteQuantity(context, quote1LongOpened.id)) / 2n

			await user.requestToClosePosition(
				quote1LongOpened.id,
				limitCloseRequestBuilder().quantityToClose(closeQuantity).closePrice(decimal(1n)).build(),
			)
			await hedger.fillCloseRequest(quote1LongOpened.id, limitFillCloseRequestBuilder().filledAmount(closeQuantity).closedPrice(decimal(1n)).build())

			const after = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, 1)

			expect(after.longPosition.aggregatedOpenAmount).to.equal(before.longPosition.aggregatedOpenAmount - closeQuantity)
			expect(after.shortPosition.aggregatedOpenAmount).to.equal(before.shortPosition.aggregatedOpenAmount)
		})

		it("removes position from totals after full close via fillCloseRequest", async function () {
			const before = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, 1)
			const fullQuantity = await getQuoteQuantity(context, quote1LongOpened.id)

			await user.requestToClosePosition(quote1LongOpened.id, limitCloseRequestBuilder().quantityToClose(fullQuantity).closePrice(decimal(1n)).build())
			await hedger.fillCloseRequest(quote1LongOpened.id, limitFillCloseRequestBuilder().filledAmount(fullQuantity).closedPrice(decimal(1n)).build())

			const after = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, 1)

			expect(after.longPosition.aggregatedOpenAmount).to.equal(before.longPosition.aggregatedOpenAmount - fullQuantity)
		})

		it("resets totals after full liquidation flow", async function () {
			const liquidator = context.signers.liquidator
			const sig = await getDummyLiquidationSig("0x10", -decimal(1_000_000n), [1n], [decimal(1n)], decimal(1_000_000n), 0n)

			await context.liquidationFacet.connect(liquidator).liquidatePartyA(await user.getAddress(), sig)
			await context.liquidationFacet.connect(liquidator).setSymbolsPrice(await user.getAddress(), sig)
			await context.liquidationFacet.connect(liquidator).liquidatePendingPositionsPartyA(await user.getAddress())
			await context.liquidationFacet
				.connect(liquidator)
				.liquidatePositionsPartyA(await user.getAddress(), [quote1LongOpened.id, quote2ShortOpened.id, quote3LongOpened.id])

			const { longPosition, shortPosition } = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, 1)
			expect(longPosition.aggregatedOpenAmount).to.equal(0n)
			expect(shortPosition.aggregatedOpenAmount).to.equal(0n)
		})

		it("updates averages after settlement adjustments", async function () {
			const before = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, 1)
			const updatedPrice = decimal(5n, 17)

			const settlementEntry = Object.assign([quote1LongOpened.id, updatedPrice, 0n], {
				quoteId: quote1LongOpened.id,
				currentPrice: updatedPrice,
				partyBUpnlIndex: 0n,
			}) as QuoteSettlementDataStructOutput
			const settlementSig = await getDummySettlementSig(0n, [0n], [settlementEntry])

			await hedger.settleUpnl(await context.signers.user.getAddress(), [updatedPrice], settlementSig)

			const after = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, 1)
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

	describe("getPartyBAggregatedPositionBySymbolPerPartyA", function () {
		const getExpectedPartyBTotalsByPartyA = async (quoteIds: bigint[], partyA: string) => {
			let longAmount = 0n
			let longNotional = 0n
			let shortAmount = 0n
			let shortNotional = 0n

			for (const quoteId of quoteIds) {
				const quote = await context.viewFacetQuote.getQuote(quoteId)
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
			const partyA = await user.getAddress()
			const { longAmount, longNotional, shortAmount, shortNotional } = await getExpectedPartyBTotalsByPartyA(
				[quote1LongOpened.id, quote2ShortOpened.id, quote3LongOpened.id],
				partyA,
			)

			const { longPosition, shortPosition } = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(hedger.address, partyA, 1)

			expect(longPosition.aggregatedOpenAmount).to.equal(longAmount)
			expect(longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
			expect(shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
			expect(shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
		})

		it("isolates totals between different partyAs for same partyB", async function () {
			const user2 = new User(context, context.signers.user2)
			await user2.setup()
			await user2.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

			const user2Quote = await context.viewFacetQuote.getQuote(await user2.sendQuote())
			await hedger.lockQuote(user2Quote.id)
			await hedger.openPosition(user2Quote.id)

			const partyA1 = await user.getAddress()
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

			const userTotals = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(hedger.address, partyA1, 1)
			const user2Totals = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(hedger.address, partyA2, 1)

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

	describe("getPartyAAggregatedPositionBySymbol", function () {
		it("updates totals after opening new position", async function () {
			const before = await context.viewFacetQuote.getPartyAAggregatedPositionBySymbol(user.address, 1)

			await user.setBalances(decimal(1000n), decimal(1000n), decimal(1000n))
			const newQuote = await context.viewFacetQuote.getQuote(await user.sendQuote())
			await hedger.lockQuote(newQuote.id)
			await hedger.openPosition(newQuote.id)

			const { longAmount, longNotional, shortAmount, shortNotional } = await getExpectedTotals([
				quote1LongOpened.id,
				quote2ShortOpened.id,
				quote3LongOpened.id,
				newQuote.id,
			])

			const { longPosition, shortPosition } = await context.viewFacetQuote.getPartyAAggregatedPositionBySymbol(user.address, 1)

			expect(longPosition.aggregatedOpenAmount).to.equal(longAmount)
			expect(longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
			expect(shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
			expect(shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
			expect(longPosition.aggregatedOpenAmount + shortPosition.aggregatedOpenAmount).to.equal(
				before.longPosition.aggregatedOpenAmount + before.shortPosition.aggregatedOpenAmount + newQuote.quantity,
			)
		})

		it("updates totals after partial close via fillCloseRequest", async function () {
			const closeQuantity = (await getQuoteQuantity(context, quote1LongOpened.id)) / 2n

			await user.requestToClosePosition(
				quote1LongOpened.id,
				limitCloseRequestBuilder().quantityToClose(closeQuantity).closePrice(decimal(1n)).build(),
			)
			await hedger.fillCloseRequest(quote1LongOpened.id, limitFillCloseRequestBuilder().filledAmount(closeQuantity).closedPrice(decimal(1n)).build())

			const { longAmount, longNotional, shortAmount, shortNotional } = await getExpectedTotals([
				quote1LongOpened.id,
				quote2ShortOpened.id,
				quote3LongOpened.id,
			])

			const { longPosition, shortPosition } = await context.viewFacetQuote.getPartyAAggregatedPositionBySymbol(user.address, 1)

			expect(longPosition.aggregatedOpenAmount).to.equal(longAmount)
			expect(longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
			expect(shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
			expect(shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
		})

		it("removes position from totals after full close via fillCloseRequest", async function () {
			const fullQuantity = await getQuoteQuantity(context, quote1LongOpened.id)

			await user.requestToClosePosition(quote1LongOpened.id, limitCloseRequestBuilder().quantityToClose(fullQuantity).closePrice(decimal(1n)).build())
			await hedger.fillCloseRequest(quote1LongOpened.id, limitFillCloseRequestBuilder().filledAmount(fullQuantity).closedPrice(decimal(1n)).build())

			const { longAmount, longNotional, shortAmount, shortNotional } = await getExpectedTotals([
				quote1LongOpened.id,
				quote2ShortOpened.id,
				quote3LongOpened.id,
			])

			const { longPosition, shortPosition } = await context.viewFacetQuote.getPartyAAggregatedPositionBySymbol(user.address, 1)

			expect(longPosition.aggregatedOpenAmount).to.equal(longAmount)
			expect(longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
			expect(shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
			expect(shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
		})

		it("updates averages after funding rate adjustments", async function () {
			const symbol = await context.viewFacetSymbol.getSymbol(1)
			const duration = symbol.fundingRateEpochDuration
			const window = symbol.fundingRateWindowTime
			const currentEpoch = (BigInt(await time.latest()) / duration) * duration
			const targetTime = duration * 2n + window - 1n + currentEpoch

			const oldQuote = await context.viewFacetQuote.getQuote(quote1LongOpened.id)

			const rate = decimal(1n, 16) // 1% funding rate
			await time.setNextBlockTimestamp(targetTime)
			await hedger.chargeFundingRate(await context.signers.user.getAddress(), [quote1LongOpened.id], [rate], await getDummyPairUpnlSig())

			const newQuote = await context.viewFacetQuote.getQuote(quote1LongOpened.id)
			const { longAmount, longNotional, shortAmount, shortNotional } = await getExpectedTotals([
				quote1LongOpened.id,
				quote2ShortOpened.id,
				quote3LongOpened.id,
			])

			const { longPosition, shortPosition } = await context.viewFacetQuote.getPartyAAggregatedPositionBySymbol(user.address, 1)

			expect(newQuote.openedPrice).to.equal(unDecimal(oldQuote.openedPrice * (decimal(1n) + rate)))
			expect(longPosition.aggregatedOpenAmount).to.equal(longAmount)
			expect(longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
			expect(shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
			expect(shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
		})

		it("resets totals after full liquidation flow", async function () {
			const liquidator = context.signers.liquidator
			const sig = await getDummyLiquidationSig("0x10", -decimal(1_000_000n), [1n], [decimal(1n)], decimal(1_000_000n), 0n)

			await context.liquidationFacet.connect(liquidator).liquidatePartyA(await user.getAddress(), sig)
			await context.liquidationFacet.connect(liquidator).setSymbolsPrice(await user.getAddress(), sig)
			await context.liquidationFacet.connect(liquidator).liquidatePendingPositionsPartyA(await user.getAddress())
			await context.liquidationFacet
				.connect(liquidator)
				.liquidatePositionsPartyA(await user.getAddress(), [quote1LongOpened.id, quote2ShortOpened.id, quote3LongOpened.id])

			const { longPosition, shortPosition } = await context.viewFacetQuote.getPartyAAggregatedPositionBySymbol(user.address, 1)
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

			await hedger.settleUpnl(await context.signers.user.getAddress(), [updatedPrice], settlementSig)

			const { longAmount, longNotional, shortAmount, shortNotional } = await getExpectedTotals([
				quote1LongOpened.id,
				quote2ShortOpened.id,
				quote3LongOpened.id,
			])

			const { longPosition, shortPosition } = await context.viewFacetQuote.getPartyAAggregatedPositionBySymbol(user.address, 1)

			expect(longPosition.aggregatedOpenAmount).to.equal(longAmount)
			expect(longPosition.avgOpenPrice).to.equal(longAmount === 0n ? 0n : longNotional / longAmount)
			expect(shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
			expect(shortPosition.avgOpenPrice).to.equal(shortAmount === 0n ? 0n : shortNotional / shortAmount)
		})
	})

	describe("getPartyBAggregatedPosition (paginated)", function () {
		let symbol2: bigint
		let symbol3: bigint

		beforeEach(async function () {
			// add two extra symbols and map them to the already whitelisted type 1
			await context.symbolControlFacet
				.connect(context.signers.admin)
				.addSymbol("SYMBOL2", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
			await context.symbolControlFacet
				.connect(context.signers.admin)
				.addSymbol("SYMBOL3", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
			await context.symbolControlFacet.connect(context.signers.admin).setSymbolTypes([2, 3], [1, 1])

			symbol2 = 2n
			symbol3 = 3n

			// Top up PartyA so the extra quote on the new symbol can be sent
			await user.setBalances(decimal(1000n), decimal(1000n), decimal(1000n))

			// Open a SHORT on the second symbol, leave the third untouched
			const sym2QuoteId = await user.sendQuote(limitQuoteRequestBuilder().symbolId(symbol2).positionType(PositionType.SHORT).build())
			const sym2Quote = await context.viewFacetQuote.getQuote(sym2QuoteId)
			await hedger.lockQuote(sym2Quote.id)
			await hedger.openPosition(sym2Quote.id)
		})

		it("returns non-zero symbols with pagination and omits empty symbols", async function () {
			const sym1Totals = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, 1)
			const sym2Totals = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, Number(symbol2))

			const aggregates = await context.viewFacetQuote.getPartyBAggregatedPosition(hedger.address, 0, 5)

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

		it("returns empty for offsets past the last symbol", async function () {
			const tooFar = await context.viewFacetQuote.getPartyBAggregatedPosition(hedger.address, 10, 5)
			expect(tooFar.length).to.equal(0)
		})

		it("returns empty for zero limit", async function () {
			const zeroLimit = await context.viewFacetQuote.getPartyBAggregatedPosition(hedger.address, 0, 0)
			expect(zeroLimit.length).to.equal(0)
		})

		it("returns mid-range pagination slices", async function () {
			// slice starting at symbol2 with limit 1 should only include that symbol
			const slice = await context.viewFacetQuote.getPartyBAggregatedPosition(hedger.address, 1, 1)
			expect(slice.length).to.equal(1)
			expect(BigInt(slice[0].symbolId)).to.equal(symbol2)
			expect(BigInt(slice[0].positionType)).to.equal(BigInt(PositionType.SHORT))
		})

		it("handles offset + limit exceeding total symbols", async function () {
			// We have 3 symbols, requesting offset=2, limit=5 should only return symbol3's entries (which are empty)
			const slice = await context.viewFacetQuote.getPartyBAggregatedPosition(hedger.address, 2, 5)
			// symbol3 has no positions, so should be empty
			expect(slice.length).to.equal(0)
		})

		it("returns empty for partyB with no positions", async function () {
			const result = await context.viewFacetQuote.getPartyBAggregatedPosition(hedger2.address, 0, 5)
			expect(result.length).to.equal(0)
		})
	})

	describe.only("getPartyAAggregatedPosition (paginated)", function () {
		let symbol2: bigint
		let symbol3: bigint

		beforeEach(async function () {
			// add two extra symbols and map them to the already whitelisted type 1
			await context.symbolControlFacet
				.connect(context.signers.admin)
				.addSymbol("PARTY_A_SYMBOL2", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
			await context.symbolControlFacet
				.connect(context.signers.admin)
				.addSymbol("PARTY_A_SYMBOL3", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
			await context.symbolControlFacet.connect(context.signers.admin).setSymbolTypes([2, 3], [1, 1])

			symbol2 = 2n
			symbol3 = 3n

			await user.setBalances(decimal(1000n), decimal(1000n), decimal(1000n))

			// Open a SHORT on the second symbol, leave the third untouched
			const sym2QuoteId = await user.sendQuote(limitQuoteRequestBuilder().symbolId(symbol2).positionType(PositionType.SHORT).build())
			const sym2Quote = await context.viewFacetQuote.getQuote(sym2QuoteId)
			await hedger.lockQuote(sym2Quote.id)
			await hedger.openPosition(sym2Quote.id)
		})

		it("returns non-zero symbols with pagination and omits empty symbols", async function () {
			const sym1Totals = await context.viewFacetQuote.getPartyAAggregatedPositionBySymbol(user.address, 1)
			const sym2Totals = await context.viewFacetQuote.getPartyAAggregatedPositionBySymbol(user.address, Number(symbol2))

			const aggregates = await context.viewFacetQuote.getPartyAAggregatedPosition(user.address, 0, 5)

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

		it("returns empty for offsets past the last symbol", async function () {
			const tooFar = await context.viewFacetQuote.getPartyAAggregatedPosition(user.address, 10, 5)
			expect(tooFar.length).to.equal(0)
		})

		it("returns empty for zero limit", async function () {
			const zeroLimit = await context.viewFacetQuote.getPartyAAggregatedPosition(user.address, 0, 0)
			expect(zeroLimit.length).to.equal(0)
		})

		it("returns mid-range pagination slices", async function () {
			// slice starting at symbol2 with limit 1 should only include that symbol
			const slice = await context.viewFacetQuote.getPartyAAggregatedPosition(user.address, 1, 1)
			expect(slice.length).to.equal(1)
			expect(BigInt(slice[0].symbolId)).to.equal(symbol2)
			expect(BigInt(slice[0].positionType)).to.equal(BigInt(PositionType.SHORT))
		})

		it("handles offset + limit exceeding total symbols", async function () {
			const slice = await context.viewFacetQuote.getPartyAAggregatedPosition(user.address, 2, 5)
			expect(slice.length).to.equal(0)
		})

		it("returns empty for partyA with no positions", async function () {
			const user2 = new User(context, context.signers.user2)
			await user2.setup()
			await user2.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

			const result = await context.viewFacetQuote.getPartyAAggregatedPosition(await user2.getAddress(), 0, 5)
			expect(result.length).to.equal(0)
		})
	})

	describe("getPartyBAggregatedPositionPerPartyA (paginated)", function () {
		let symbol2: bigint

		beforeEach(async function () {
			await context.symbolControlFacet
				.connect(context.signers.admin)
				.addSymbol("PER_PARTY_A_SYMBOL2", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
			await context.symbolControlFacet.connect(context.signers.admin).setSymbolTypes([2], [1])

			symbol2 = 2n

			await user.setBalances(decimal(1000n), decimal(1000n), decimal(1000n))
			const sym2QuoteId = await user.sendQuote(limitQuoteRequestBuilder().symbolId(symbol2).positionType(PositionType.SHORT).build())
			const sym2Quote = await context.viewFacetQuote.getQuote(sym2QuoteId)
			await hedger.lockQuote(sym2Quote.id)
			await hedger.openPosition(sym2Quote.id)
		})

		it("returns non-zero symbols for a specific partyA", async function () {
			const partyA = await user.getAddress()
			const sym1Totals = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(hedger.address, partyA, 1)
			const sym2Totals = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(hedger.address, partyA, Number(symbol2))

			const aggregates = await context.viewFacetQuote.getPartyBAggregatedPositionPerPartyA(hedger.address, partyA, 0, 5)

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
			const user2 = new User(context, context.signers.user2)
			await user2.setup()
			await user2.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

			const result = await context.viewFacetQuote.getPartyBAggregatedPositionPerPartyA(hedger.address, await user2.getAddress(), 0, 5)
			expect(result.length).to.equal(0)
		})
	})

	describe("funding fee impact on avg open price", function () {
		describe("accumulated funding fee (new method)", function () {
			it("keeps totals consistent after funding accrual and charge", async function () {
				const before = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, 1)

				await context.pauseControlFacet.enableNewFundingFee()
				await context.symbolControlFacet.connect(context.signers.admin).setSymbolFundingState(1, 3600, 1200)
				await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [3600])
				await context.fundingRateFacet
					.connect(context.signers.hedger)
					.updateAccumulatedFundingFee([1], [decimal(2n, 14)], [-decimal(2n, 14)], [decimal(1n)])

				await time.increase(7200)

				await context.fundingRateFacet
					.connect(context.signers.hedger)
					.chargeAccumulatedFundingFee(
						await context.signers.user.getAddress(),
						await context.signers.hedger.getAddress(),
						[quote1LongOpened.id],
						await getDummyPairUpnlSig(),
					)

				const after = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, 1)
				// Accumulated funding doesn't change openedPrice, so avgOpenPrice stays the same
				expect(after.longPosition.aggregatedOpenAmount).to.equal(before.longPosition.aggregatedOpenAmount)
				expect(after.longPosition.avgOpenPrice).to.equal(before.longPosition.avgOpenPrice)
				expect(after.shortPosition.aggregatedOpenAmount).to.equal(before.shortPosition.aggregatedOpenAmount)
				expect(after.shortPosition.avgOpenPrice).to.equal(before.shortPosition.avgOpenPrice)
			})
		})

		describe("iterative funding fee (old method - changes openedPrice)", function () {
			it("changes individual quote openedPrice and updates aggregate view", async function () {
				const symbol = await context.viewFacetSymbol.getSymbol(1)
				const duration = symbol.fundingRateEpochDuration
				const window = symbol.fundingRateWindowTime
				const currentEpoch = (BigInt(await time.latest()) / duration) * duration
				const targetTime = duration * 2n + window - 1n + currentEpoch

				const oldQuote = await context.viewFacetQuote.getQuote(quote1LongOpened.id)

				const rate = decimal(1n, 16) // 1% funding rate
				await time.setNextBlockTimestamp(targetTime)
				await hedger.chargeFundingRate(await context.signers.user.getAddress(), [quote1LongOpened.id], [rate], await getDummyPairUpnlSig())

				const after = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, 1)
				const newQuote = await context.viewFacetQuote.getQuote(quote1LongOpened.id)
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
				const symbol = await context.viewFacetSymbol.getSymbol(1)
				const duration = symbol.fundingRateEpochDuration
				const window = symbol.fundingRateWindowTime
				const currentEpoch = (BigInt(await time.latest()) / duration) * duration
				const targetTime = duration * 2n + window - 1n + currentEpoch

				const oldQuote = await context.viewFacetQuote.getQuote(quote2ShortOpened.id)

				const rate = decimal(1n, 16) // 1% funding rate
				await time.setNextBlockTimestamp(targetTime)
				await hedger.chargeFundingRate(await context.signers.user.getAddress(), [quote2ShortOpened.id], [rate], await getDummyPairUpnlSig())

				const after = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, 1)
				const newQuote = await context.viewFacetQuote.getQuote(quote2ShortOpened.id)
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
				const symbol = await context.viewFacetSymbol.getSymbol(1)
				const duration = symbol.fundingRateEpochDuration
				const window = symbol.fundingRateWindowTime
				const currentEpoch = (BigInt(await time.latest()) / duration) * duration
				const targetTime = duration * 2n + window - 1n + currentEpoch

				const oldQuote1 = await context.viewFacetQuote.getQuote(quote1LongOpened.id)
				const oldQuote3 = await context.viewFacetQuote.getQuote(quote3LongOpened.id)

				const rate = decimal(1n, 16) // 1% funding rate
				await time.setNextBlockTimestamp(targetTime)
				// Charge both LONG positions
				await hedger.chargeFundingRate(
					await context.signers.user.getAddress(),
					[quote1LongOpened.id, quote3LongOpened.id],
					[rate, rate],
					await getDummyPairUpnlSig(),
				)

				const after = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(hedger.address, 1)
				const newQuote1 = await context.viewFacetQuote.getQuote(quote1LongOpened.id)
				const newQuote3 = await context.viewFacetQuote.getQuote(quote3LongOpened.id)
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
}
