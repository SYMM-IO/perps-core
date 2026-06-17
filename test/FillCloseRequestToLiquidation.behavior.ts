import { expect } from "chai"

import type { QuoteStructOutput } from "../src/types/interfaces/ISymmio.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { PositionType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, getQuoteQuantity, getTotalLockedValuesForQuoteIds, getTradingFeeForQuotes, unDecimal } from "./utils/Common.js"

const WAD = 10n ** 18n
const WAD_36 = 10n ** 36n

export function shouldBehaveLikeFillCloseRequestToLiquidation(): void {
	let user: User, hedger: Hedger
	let context: RunContext
	let quote1LongOpened: QuoteStructOutput

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

		// Quote1 LONG opened
		quote1LongOpened = await context.viewFacetQuote.getQuote(await user.sendQuote())
		await hedger.lockQuote(quote1LongOpened.id)
		await hedger.openPosition(quote1LongOpened.id)
	})

	describe("Close Fee Edge Cases", function () {
		it("Should include close fee for SHORT positions in solvency check", async function () {
			// Create a SHORT position
			const quoteId = await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
			const quoteShort = await context.viewFacetQuote.getQuote(quoteId)
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

			const quantity = await getQuoteQuantity(context, quoteId)
			const closePrice = decimal(1n)
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(quantity).closePrice(closePrice).build())

			const quote = await context.viewFacetQuote.getQuote(quoteId)
			const marketPrice = decimal(1n, 17) // Market price lower than close price - partyA loses on SHORT close

			// Calculate close fee
			const closeFee = (quantity * closePrice * quote.closeFee) / WAD_36

			// For SHORT: PartyA loses when closedPrice > marketPrice
			const pnlLoss = unDecimal(quantity * (closePrice - marketPrice))

			const userAvailableWithFee =
				this.user_allocated -
				(await getTotalLockedValuesForQuoteIds(context, [1n], false)) - // Quote 1 is still open
				(await getTradingFeeForQuotes(context, [1n, quoteId])) -
				pnlLoss -
				closeFee

			// Set upnl to make available balance exactly 0 after close with fee
			const exactUpnl = userAvailableWithFee * -1n

			// Should fail with slightly worse upnl
			await expect(
				hedger.fillCloseRequest(
					quoteId,
					limitFillCloseRequestBuilder()
						.filledAmount(quantity)
						.closedPrice(closePrice)
						.upnlPartyA(exactUpnl - decimal(1n))
						.price(marketPrice)
						.build(),
				),
			).to.be.revertedWith("LibSolvency: Available balance is lower than zero")

			// Should pass with exact upnl (balance = 0 is acceptable)
			await hedger.fillCloseRequest(
				quoteId,
				limitFillCloseRequestBuilder().filledAmount(quantity).closedPrice(closePrice).upnlPartyA(exactUpnl).price(marketPrice).build(),
			)

			const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
			expect(quoteAfter.quoteStatus).to.equal(BigInt(QuoteStatus.CLOSED))
			expect(quoteAfter.closedAmount).to.equal(quoteShort.quantity)
		})
	})

	describe("fillCloseRequestToLiquidation", function () {
		beforeEach(async function () {
			// Request to close quote1
			const quantity = await getQuoteQuantity(context, 1n)
			await user.requestToClosePosition(1, limitCloseRequestBuilder().quantityToClose(quantity).closePrice(decimal(1n)).build())
		})

		it("Should fill entire close request when partyA is solvent", async function () {
			const quote = await context.viewFacetQuote.getQuote(1n)
			const quantityBefore = quote.quantityToClose
			const closePrice = decimal(11n, 17)
			const marketPrice = closePrice

			const userBalanceBefore = await user.getBalanceInfo()

			const filledAmount = await hedger.fillCloseRequestToLiquidation(
				1,
				limitFillCloseRequestBuilder().closedPrice(closePrice).upnlPartyA(0n).price(marketPrice).build(),
			)

			expect(filledAmount).to.equal(quantityBefore)

			const quoteAfter = await context.viewFacetQuote.getQuote(1n)
			expect(quoteAfter.quoteStatus).to.equal(BigInt(QuoteStatus.CLOSED))
			expect(quoteAfter.closedAmount).to.equal(quote.quantity)
			expect(quoteAfter.avgClosedPrice).to.be.gt(0n)
		})

		it("Should only work with LIMIT orders", async function () {
			// Create a new position and request market close
			const quoteId = await user.sendQuote()
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

			const quantity = await getQuoteQuantity(context, quoteId)
			// Request market close
			await context.partyAFacet.connect(user.signer).requestToClosePosition(
				quoteId,
				decimal(1n),
				quantity,
				1n, // OrderType.MARKET
				BigInt(Math.floor(Date.now() / 1000) + 1000),
			)

			await expect(
				hedger.fillCloseRequestToLiquidation(
					quoteId,
					limitFillCloseRequestBuilder().closedPrice(decimal(1n)).upnlPartyA(0n).price(decimal(1n)).build(),
				),
			).to.be.revertedWith("PartyBFacet: Only LIMIT orders supported")
		})

		it("Should check PartyB solvency after close", async function () {
			const closePrice = decimal(1n)
			const marketPrice = decimal(11n, 17)

			// Set PartyB to be insolvent after close
			await expect(
				hedger.fillCloseRequestToLiquidation(
					1,
					limitFillCloseRequestBuilder().closedPrice(closePrice).upnlPartyB(decimal(-4000n)).price(marketPrice).build(),
				),
			).to.be.revertedWith("LibSolvency: Available balance is lower than zero")
		})
	})

	describe("Partial close when totalRate < 0", function () {
		// This tests the core use case: closing is HARMFUL to PartyA's balance
		// (fees + PnL loss > unlock benefit), so we need to limit the close amount

		it("Should return partial close amount when closing is harmful (LONG position)", async function () {
			// Use the existing quote1 LONG position
			// Request to close the full amount
			const quantity = await getQuoteQuantity(context, 1n)
			await user.requestToClosePosition(1, limitCloseRequestBuilder().quantityToClose(quantity).closePrice(decimal(1n)).build())

			const quote = await context.viewFacetQuote.getQuote(1n)
			const quantityToClose = quote.quantityToClose
			const openAmount = quote.quantity - quote.closedAmount

			// closedPrice = 1 (the LONG close price that PartyA requests)
			// marketPrice > closedPrice means PartyA loses on the close
			// This makes totalRate negative (harmful closing)
			const closePrice = decimal(1n)
			const marketPrice = decimal(2n) // Market is at 2, but closing at 1 - big loss for LONG

			// Calculate the expected components to verify partial close
			const unlockRate = ((quote.lockedValues.cva + quote.lockedValues.lf) * WAD) / openAmount

			// For LONG: closedPrice < marketPrice means PartyA loses
			const pnlRate = -(marketPrice - closePrice) // Negative (loss)

			const feeRate = (closePrice * quote.closeFee) / WAD

			// totalRate = unlockRate + pnlRate - feeRate
			// With marketPrice >> closePrice, pnlRate is very negative, making totalRate negative
			const totalRate = BigInt(unlockRate) + pnlRate - BigInt(feeRate)

			// Verify totalRate is negative (closing is harmful)
			expect(totalRate).to.be.lessThan(0n)

			// Set a negative upnl that makes PartyA barely solvent before close but insolvent after full close
			// currentBalance = allocatedBalance - (cva + lf) + upnl = 500 - 25 + upnl
			// balanceAfterFullClose = currentBalance + unlock - pnlLoss - fee = currentBalance + 25 - 100 - 1 = currentBalance - 76
			// For partial close: need balanceAfterFullClose < 0, so currentBalance < 76
			// currentBalance < 76 means 475 + upnl < 76, so upnl < -399
			// Also need currentBalance > 0 for partial close (otherwise returns 0), so upnl > -475
			const upnlPartyA = decimal(-450n) // Makes currentBalance = 25, balanceAfterFullClose = -51

			const filledAmount = await hedger.fillCloseRequestToLiquidation(
				1,
				limitFillCloseRequestBuilder().closedPrice(closePrice).upnlPartyA(upnlPartyA).price(marketPrice).build(),
			)

			// Should be a partial fill, not the full amount
			// Since full close makes PartyA insolvent but partial close keeps them at 0
			expect(filledAmount).to.be.lessThan(quantityToClose)
			expect(filledAmount).to.be.greaterThan(0n)

			const quoteAfter = await context.viewFacetQuote.getQuote(1n)
			// Should be partially closed - quote remains open with close pending since only partially filled
			expect(quoteAfter.closedAmount).to.equal(quote.closedAmount + filledAmount)
			// avgClosedPrice should be set
			expect(quoteAfter.avgClosedPrice).to.be.gt(0n)
		})

		it("Should return 0 when PartyA is already insolvent and closing is harmful", async function () {
			// Request to close quote1
			const quantity = await getQuoteQuantity(context, 1n)
			await user.requestToClosePosition(1, limitCloseRequestBuilder().quantityToClose(quantity).closePrice(decimal(1n)).build())

			const closePrice = decimal(1n)
			const marketPrice = decimal(2n) // Closing at loss for LONG

			// Set upnl to make PartyA insolvent before close (currentBalance <= 0)
			// currentBalance = 500 - 25 + upnl, so need upnl <= -475
			const upnlPartyA = decimal(-500n) // Makes currentBalance = -25 (already insolvent)

			await expect(
				hedger.fillCloseRequestToLiquidation(
					1,
					limitFillCloseRequestBuilder().closedPrice(closePrice).upnlPartyA(upnlPartyA).price(marketPrice).build(),
				),
			).to.be.revertedWith("PartyBFacet: Cannot close any amount")
		})

		it("Should revert when full close still leaves PartyA insolvent (beneficial closing)", async function () {
			// Request to close quote1
			const quantity = await getQuoteQuantity(context, 1n)
			await user.requestToClosePosition(1, limitCloseRequestBuilder().quantityToClose(quantity).closePrice(decimal(1n)).build())

			// closedPrice > marketPrice for LONG means PartyA profits
			// But even with profit, if upnl is very negative, full close might not be enough
			const closePrice = decimal(15n, 17) // 1.5
			const marketPrice = decimal(1n) // Market at 1, closing at 1.5 - profit for LONG

			// Very negative upnl - even profitable close won't be enough
			const upnlPartyA = decimal(-1000n)

			// Full close still leaves PartyA insolvent, should revert
			await expect(
				hedger.fillCloseRequestToLiquidation(
					1,
					limitFillCloseRequestBuilder().closedPrice(closePrice).upnlPartyA(upnlPartyA).price(marketPrice).build(),
				),
			).to.be.revertedWith("LibSolvency: Full close keeps PartyA insolvent")
		})
	})

	describe("Partial close for SHORT positions", function () {
		it("Should return partial close amount when closing is harmful (SHORT position)", async function () {
			// Create a SHORT position
			const quoteShortId = await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
			await hedger.lockQuote(quoteShortId)
			await hedger.openPosition(quoteShortId)

			// Request to close SHORT position
			const quantity = await getQuoteQuantity(context, quoteShortId)
			// For SHORT, requestedClosePrice is the maximum price PartyA accepts
			await user.requestToClosePosition(quoteShortId, limitCloseRequestBuilder().quantityToClose(quantity).closePrice(decimal(1n)).build())

			const quote = await context.viewFacetQuote.getQuote(quoteShortId)
			const quantityToClose = quote.quantityToClose
			const openAmount = quote.quantity - quote.closedAmount

			// For SHORT: closedPrice > marketPrice means PartyA loses
			// closePrice = 1, marketPrice = 0.5 means PartyA loses 0.5 per unit
			const closePrice = decimal(1n)
			const marketPrice = decimal(5n, 17) // 0.5 - lower market price

			// Calculate components:
			// unlockRate = (cva + lf) * 1e18 / openAmount = 25e18 * 1e18 / 100e18 = 0.25e18
			// pnlRate for SHORT when closedPrice > marketPrice = -(closedPrice - marketPrice) = -(1 - 0.5) = -0.5e18
			// feeRate = closePrice * closeFee / 1e18 = 1e18 * 0.01e18 / 1e18 = 0.01e18
			// totalRate = 0.25 - 0.5 - 0.01 = -0.26e18 (negative, harmful)

			// PartyA has quote1 (LONG) locked + quoteShort locked
			// Total locked (cva+lf) = 25 + 25 = 50
			// currentBalance = 500 - 50 + upnl = 450 + upnl
			// balanceAfterFullClose = currentBalance + 25 - 50 - 1 = currentBalance - 26

			// For partial close: need balanceAfterFullClose < 0 and currentBalance > 0
			// currentBalance - 26 < 0 means currentBalance < 26, so 450 + upnl < 26, upnl < -424
			// currentBalance > 0 means 450 + upnl > 0, so upnl > -450
			const upnlPartyA = decimal(-440n) // Makes currentBalance = 10, balanceAfterFullClose = -16

			const filledAmount = await hedger.fillCloseRequestToLiquidation(
				quoteShortId,
				limitFillCloseRequestBuilder().closedPrice(closePrice).upnlPartyA(upnlPartyA).price(marketPrice).build(),
			)

			// Should be a partial fill due to harmful closing (fees + loss > unlock)
			expect(filledAmount).to.be.lessThan(quantityToClose)
			expect(filledAmount).to.be.greaterThan(0n)

			const quoteAfter = await context.viewFacetQuote.getQuote(quoteShortId)
			expect(quoteAfter.closedAmount).to.equal(quote.closedAmount + filledAmount)
			expect(quoteAfter.avgClosedPrice).to.be.gt(0n)
		})
	})
}
