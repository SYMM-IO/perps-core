import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs"
import { expect } from "chai"
import { ethers } from "ethers"

import type { QuoteStructOutput } from "../src/types/interfaces/ISymmio.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { OrderType, PositionType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder, marketBestEffortCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp, getQuoteQuantity, getTotalLockedValuesForQuoteIds, getTradingFeeForQuotes, unDecimal } from "./utils/Common.js"
import { getDummyPairUpnlAndPriceSig, getDummySingleUpnlSig } from "./utils/SignatureUtils.js"

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

		it("Should reject ordinary MARKET orders", async function () {
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
			).to.be.revertedWith("PartyBFacet: Only LIMIT or MARKET_BEST_EFFORT orders supported")
		})

		it("Should fully fill a solvent best-effort close", async function () {
			const quoteId = await user.sendQuote()
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

			const quantity = await getQuoteQuantity(context, quoteId)
			await user.requestToClosePosition(quoteId, marketBestEffortCloseRequestBuilder().quantityToClose(quantity).closePrice(decimal(1n)).build())

			const filledAmount = await hedger.fillCloseRequestToLiquidation(
				quoteId,
				limitFillCloseRequestBuilder().filledAmount(quantity).closedPrice(decimal(1n)).price(decimal(1n)).build(),
			)
			const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)

			expect(filledAmount).to.equal(quantity)
			expect(quoteAfter.quoteStatus).to.equal(QuoteStatus.CLOSED)
			expect(quoteAfter.closedAmount).to.equal(quantity)
		})

		it("Should fully fill a solvent best-effort SHORT close", async function () {
			const quoteId = await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

			const quantity = await getQuoteQuantity(context, quoteId)
			await user.requestToClosePosition(quoteId, marketBestEffortCloseRequestBuilder().quantityToClose(quantity).closePrice(decimal(1n)).build())

			const filledAmount = await hedger.fillCloseRequestToLiquidation(
				quoteId,
				limitFillCloseRequestBuilder().closedPrice(decimal(1n)).upnlPartyA(0n).price(decimal(1n)).build(),
			)
			const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)

			expect(filledAmount).to.equal(quantity)
			expect(quoteAfter.quoteStatus).to.equal(QuoteStatus.CLOSED)
			expect(quoteAfter.closedAmount).to.equal(quantity)
			expect(quoteAfter.quantityToClose).to.equal(0n)
		})

		it("Should completely fill a best-effort request through ordinary fillCloseRequest", async function () {
			const quoteId = await user.sendQuote()
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

			const quantity = await getQuoteQuantity(context, quoteId)
			await user.requestToClosePosition(quoteId, marketBestEffortCloseRequestBuilder().quantityToClose(quantity).closePrice(decimal(1n)).build())

			await hedger.fillCloseRequest(
				quoteId,
				limitFillCloseRequestBuilder().filledAmount(quantity).closedPrice(decimal(1n)).upnlPartyA(0n).price(decimal(1n)).build(),
			)
			const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)

			expect(quoteAfter.quoteStatus).to.equal(QuoteStatus.CLOSED)
			expect(quoteAfter.closedAmount).to.equal(quantity)
			expect(quoteAfter.quantityToClose).to.equal(0n)
			expect(quoteAfter.requestedClosePrice).to.equal(0n)
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

		it("Should atomically cancel the remainder of a liquidation-limited best-effort close", async function () {
			const quantity = await getQuoteQuantity(context, 1n)
			await user.requestToClosePosition(1, marketBestEffortCloseRequestBuilder().quantityToClose(quantity).closePrice(decimal(1n)).build())

			const quoteBefore = await context.viewFacetQuote.getQuote(1n)
			const closePrice = decimal(1n)
			const marketPrice = decimal(2n)
			const upnlPartyA = decimal(-450n)

			const filledAmount = await hedger.fillCloseRequestToLiquidation(
				1,
				limitFillCloseRequestBuilder().closedPrice(closePrice).upnlPartyA(upnlPartyA).price(marketPrice).build(),
			)

			expect(filledAmount).to.be.greaterThan(0n)
			expect(filledAmount).to.be.lessThan(quoteBefore.quantityToClose)

			const quoteAfter = await context.viewFacetQuote.getQuote(1n)
			expect(quoteAfter.closedAmount).to.equal(quoteBefore.closedAmount + filledAmount)
			expect(quoteAfter.quoteStatus).to.equal(QuoteStatus.OPENED)
			expect(quoteAfter.quantityToClose).to.equal(0n)
			expect(quoteAfter.requestedClosePrice).to.equal(0n)

			await expect(
				hedger.fillCloseRequest(
					1,
					limitFillCloseRequestBuilder().filledAmount(1n).closedPrice(closePrice).upnlPartyA(upnlPartyA).price(marketPrice).build(),
				),
			).to.be.revertedWith("PartyBFacet: Invalid state")

			const remainingAmount = quoteAfter.quantity - quoteAfter.closedAmount
			await expect(
				context.partyAFacet
					.connect(user.signer)
					.requestToClosePosition(1, closePrice, remainingAmount, OrderType.MARKET_BEST_EFFORT, await getBlockTimestamp(500n)),
			)
				.to.emit(context.partyAFacet, "RequestToClosePosition")
				.withArgs(
					await user.getAddress(),
					await hedger.getAddress(),
					1n,
					closePrice,
					remainingAmount,
					OrderType.MARKET_BEST_EFFORT,
					anyValue,
					QuoteStatus.CLOSE_PENDING,
					2n,
				)
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

	describe("Per-solver liquidation overshoot", function () {
		const FIVE_BPS = 5n * 10n ** 14n
		const LARGE_CUSHION = WAD

		function remainingLockedValue(quote: QuoteStructOutput, filledAmount: bigint): bigint {
			const openAmount = quote.quantity - quote.closedAmount
			return (
				quote.lockedValues.cva -
				(quote.lockedValues.cva * filledAmount) / openAmount +
				quote.lockedValues.lf -
				(quote.lockedValues.lf * filledAmount) / openAmount +
				quote.lockedValues.partyAmm -
				(quote.lockedValues.partyAmm * filledAmount) / openAmount
			)
		}

		it("closes 5 bps into the post-close CVA plus LF threshold without exceeding the allowance", async function () {
			const quoteId = 1n
			const quantity = await getQuoteQuantity(context, quoteId)
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(quantity).closePrice(decimal(1n)).build())

			const quote = await context.viewFacetQuote.getQuote(quoteId)
			const closePrice = decimal(1n)
			const marketPrice = decimal(2n)
			// Available before the close is $45.60, making the zero-rate close release almost exactly $15
			// and leave a $10 CVA + LF liquidation threshold.
			const upnlPartyA = decimal(-428n) - decimal(4n, 17)
			const balanceBefore = await user.getBalanceInfo()

			const [zeroRateAmount] = await context.viewFacetQuote.getMaxCloseAmountToLiquidation(quoteId, closePrice, marketPrice, upnlPartyA)
			const openAmount = quote.quantity - quote.closedAmount
			const zeroRateThreshold =
				balanceBefore.lockedCva +
				balanceBefore.lockedLf -
				(quote.lockedValues.cva * zeroRateAmount) / openAmount -
				(quote.lockedValues.lf * zeroRateAmount) / openAmount
			expect(zeroRateThreshold).to.equal(decimal(10n))
			expect((zeroRateThreshold * FIVE_BPS) / WAD).to.equal(decimal(5n, 15))

			await context.symbolControlFacet.connect(context.signers.admin).setPartyBLiquidationOvershootRate(await hedger.getAddress(), 0n, FIVE_BPS)
			const [overshootAmount, canCloseAll] = await context.viewFacetQuote.getMaxCloseAmountToLiquidation(quoteId, closePrice, marketPrice, upnlPartyA)
			expect(canCloseAll).to.equal(false)
			expect(overshootAmount).to.be.greaterThan(zeroRateAmount)

			const unlockedCva = (quote.lockedValues.cva * overshootAmount) / openAmount
			const unlockedLf = (quote.lockedValues.lf * overshootAmount) / openAmount
			const postCloseThreshold = balanceBefore.lockedCva + balanceBefore.lockedLf - unlockedCva - unlockedLf
			const allowedShortfall = (postCloseThreshold * FIVE_BPS) / WAD
			const pnlAdjustment = (overshootAmount * (closePrice - marketPrice)) / WAD
			const closeFee = (overshootAmount * closePrice * quote.closeFee) / WAD_36
			const calculatedBalance =
				balanceBefore.allocatedBalances -
				balanceBefore.lockedCva -
				balanceBefore.lockedLf +
				upnlPartyA +
				unlockedCva +
				unlockedLf +
				pnlAdjustment -
				closeFee
			expect(calculatedBalance).to.be.lessThan(0n)
			const actualShortfall = -calculatedBalance
			expect(actualShortfall).to.be.at.most(allowedShortfall)

			const sig = await getDummyPairUpnlAndPriceSig(marketPrice, upnlPartyA, 0n)
			await expect(context.partyBPositionActionsFacet.connect(hedger.signer).fillCloseRequestToLiquidation(quoteId, closePrice, sig))
				.to.emit(context.partyBPositionActionsFacet, "PartyALiquidationOvershootUsed")
				.withArgs(quoteId, await user.getAddress(), await hedger.getAddress(), 1n, FIVE_BPS, allowedShortfall, actualShortfall)

			// A favorable move smaller than the selected overshoot still leaves PartyA below the threshold.
			expect(calculatedBalance + actualShortfall - 1n).to.be.lessThan(0n)
		})

		it("falls back to the zero-rate amount when the overshoot amount enters the invalid remaining-value band", async function () {
			const quoteId = 1n
			const quantity = await getQuoteQuantity(context, quoteId)
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(quantity).closePrice(decimal(1n)).build())

			const quote = await context.viewFacetQuote.getQuote(quoteId)
			const closePrice = decimal(1n)
			const marketPrice = decimal(2n)
			const upnlPartyA = decimal(-428n) - decimal(4n, 17)
			const [zeroRateAmount] = await context.viewFacetQuote.getMaxCloseAmountToLiquidation(quoteId, closePrice, marketPrice, upnlPartyA)

			await context.symbolControlFacet.connect(context.signers.admin).setPartyBLiquidationOvershootRate(await hedger.getAddress(), 0n, LARGE_CUSHION)
			const [overshootAmount] = await context.viewFacetQuote.getMaxCloseAmountToLiquidation(quoteId, closePrice, marketPrice, upnlPartyA)
			expect(overshootAmount).to.be.greaterThan(zeroRateAmount)

			const zeroRateRemainder = remainingLockedValue(quote, zeroRateAmount)
			const overshootRemainder = remainingLockedValue(quote, overshootAmount)
			const minAcceptableQuoteValue = (zeroRateRemainder + overshootRemainder) / 2n
			const symbol = await context.viewFacetSymbol.getSymbol(quote.symbolId)
			await context.symbolControlFacet
				.connect(context.signers.admin)
				.setSymbolAcceptableValues(quote.symbolId, minAcceptableQuoteValue, symbol.minAcceptablePortionLF)

			const [previewAmount] = await context.viewFacetQuote.getMaxCloseAmountToLiquidation(quoteId, closePrice, marketPrice, upnlPartyA)
			expect(previewAmount).to.equal(zeroRateAmount)

			const filledAmount = await hedger.fillCloseRequestToLiquidation(
				quoteId,
				limitFillCloseRequestBuilder().closedPrice(closePrice).upnlPartyA(upnlPartyA).price(marketPrice).build(),
			)
			expect(filledAmount).to.equal(zeroRateAmount)
		})

		it("preserves the existing remaining-value revert when the overshoot and zero-rate amounts are both invalid", async function () {
			const quoteId = 1n
			const quantity = await getQuoteQuantity(context, quoteId)
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(quantity).closePrice(decimal(1n)).build())

			const quote = await context.viewFacetQuote.getQuote(quoteId)
			const closePrice = decimal(1n)
			const marketPrice = decimal(2n)
			const upnlPartyA = decimal(-428n) - decimal(4n, 17)
			const [zeroRateAmount] = await context.viewFacetQuote.getMaxCloseAmountToLiquidation(quoteId, closePrice, marketPrice, upnlPartyA)
			const symbol = await context.viewFacetSymbol.getSymbol(quote.symbolId)
			await context.symbolControlFacet
				.connect(context.signers.admin)
				.setSymbolAcceptableValues(quote.symbolId, remainingLockedValue(quote, zeroRateAmount) + 1n, symbol.minAcceptablePortionLF)
			await context.symbolControlFacet.connect(context.signers.admin).setPartyBLiquidationOvershootRate(await hedger.getAddress(), 0n, LARGE_CUSHION)

			await expect(context.viewFacetQuote.getMaxCloseAmountToLiquidation(quoteId, closePrice, marketPrice, upnlPartyA)).to.be.revertedWith(
				"PartyBFacet: Remaining quote value is low",
			)
			await expect(
				hedger.fillCloseRequestToLiquidation(
					quoteId,
					limitFillCloseRequestBuilder().closedPrice(closePrice).upnlPartyA(upnlPartyA).price(marketPrice).build(),
				),
			).to.be.revertedWith("PartyBFacet: Remaining quote value is low")
		})

		it("allows a full close because its remaining value is zero", async function () {
			const quoteId = 1n
			const quantity = await getQuoteQuantity(context, quoteId)
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(quantity).closePrice(decimal(1n)).build())
			const symbol = await context.viewFacetSymbol.getSymbol(1n)
			await context.symbolControlFacet.connect(context.signers.admin).setSymbolAcceptableValues(1n, ethers.MaxUint256, symbol.minAcceptablePortionLF)

			const filledAmount = await hedger.fillCloseRequestToLiquidation(
				quoteId,
				limitFillCloseRequestBuilder().closedPrice(decimal(1n)).upnlPartyA(0n).price(decimal(1n)).build(),
			)
			expect(filledAmount).to.equal(quantity)
		})

		it("handles the maximum 1e18 rate and a tiny post-close threshold", async function () {
			const quoteId = 1n
			const quantity = await getQuoteQuantity(context, quoteId)
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(quantity).closePrice(decimal(1n)).build())
			const symbol = await context.viewFacetSymbol.getSymbol(1n)
			await context.symbolControlFacet.connect(context.signers.admin).setSymbolAcceptableValues(1n, 0n, symbol.minAcceptablePortionLF)
			await context.symbolControlFacet.connect(context.signers.admin).setPartyBLiquidationOvershootRate(await hedger.getAddress(), 0n, 10n ** 18n)

			const closePrice = decimal(1n)
			const marketPrice = decimal(2n)
			const upnlPartyA = decimal(-428n) - decimal(4n, 17)
			const [previewAmount, canCloseAll] = await context.viewFacetQuote.getMaxCloseAmountToLiquidation(quoteId, closePrice, marketPrice, upnlPartyA)
			expect(canCloseAll).to.equal(false)
			// With the maximum rate, the boundary sits where the shortfall equals the remaining account CVA+LF.
			expect(previewAmount).to.equal(69900990099009900990n)

			const filledAmount = await hedger.fillCloseRequestToLiquidation(
				quoteId,
				limitFillCloseRequestBuilder().closedPrice(closePrice).upnlPartyA(upnlPartyA).price(marketPrice).build(),
			)
			expect(filledAmount).to.equal(previewAmount)
		})

		it("uses the account-level threshold for a harmful SHORT close when another quote remains open", async function () {
			const quoteId = await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)
			const quantity = await getQuoteQuantity(context, quoteId)
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(quantity).closePrice(decimal(1n)).build())

			const quote = await context.viewFacetQuote.getQuote(quoteId)
			const balanceBefore = await user.getBalanceInfo()
			const closePrice = decimal(1n)
			const marketPrice = decimal(5n, 17)
			const targetAvailable = decimal(10n)
			const upnlPartyA = targetAvailable - (balanceBefore.allocatedBalances - balanceBefore.lockedCva - balanceBefore.lockedLf)
			const [zeroRateAmount] = await context.viewFacetQuote.getMaxCloseAmountToLiquidation(quoteId, closePrice, marketPrice, upnlPartyA)
			await context.symbolControlFacet.connect(context.signers.admin).setPartyBLiquidationOvershootRate(await hedger.getAddress(), 1n, FIVE_BPS)
			const [overshootAmount] = await context.viewFacetQuote.getMaxCloseAmountToLiquidation(quoteId, closePrice, marketPrice, upnlPartyA)
			expect(overshootAmount).to.be.greaterThan(zeroRateAmount)

			const openAmount = quote.quantity - quote.closedAmount
			const unlockedCva = (quote.lockedValues.cva * overshootAmount) / openAmount
			const unlockedLf = (quote.lockedValues.lf * overshootAmount) / openAmount
			const postCloseThreshold = balanceBefore.lockedCva + balanceBefore.lockedLf - unlockedCva - unlockedLf
			const allowance = (postCloseThreshold * FIVE_BPS) / WAD
			const closeFee = (overshootAmount * closePrice * quote.closeFee) / WAD_36
			const pnlAdjustment = (overshootAmount * (marketPrice - closePrice)) / WAD
			const calculatedBalance = targetAvailable + unlockedCva + unlockedLf + pnlAdjustment - closeFee
			expect(calculatedBalance).to.be.lessThan(0n)
			expect(-calculatedBalance).to.be.at.most(allowance)

			const filledAmount = await hedger.fillCloseRequestToLiquidation(
				quoteId,
				limitFillCloseRequestBuilder().closedPrice(closePrice).upnlPartyA(upnlPartyA).price(marketPrice).build(),
			)
			expect(filledAmount).to.equal(overshootAmount)
			// Quote 1 remains open, so the account-level threshold is larger than this quote's own remainder.
			expect(postCloseThreshold).to.be.greaterThan(quote.lockedValues.cva + quote.lockedValues.lf - unlockedCva - unlockedLf)
		})

		it("makes PartyA immediately liquidatable under the same market snapshot", async function () {
			const quoteId = 1n
			const quantity = await getQuoteQuantity(context, quoteId)
			const closePrice = decimal(4n, 16) // $0.04
			const marketPrice = decimal(3n, 17) // $0.30, so the harmful close is still executable at PartyA's limit
			const targetAllocatedBalance = decimal(955n, 17) // $95.50
			const balanceBeforeDeallocation = await user.getBalanceInfo()
			await context.accountFacet
				.connect(user.signer)
				.deallocate(balanceBeforeDeallocation.allocatedBalances - targetAllocatedBalance, await getDummySingleUpnlSig(decimal(100n)))
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(quantity).closePrice(closePrice).build())

			const upnlPartyA = await user.getUpnl(async () => marketPrice)
			const balanceBefore = await user.getBalanceInfo()
			const availableBefore = balanceBefore.allocatedBalances - balanceBefore.lockedCva - balanceBefore.lockedLf + upnlPartyA
			expect(availableBefore).to.equal(decimal(5n, 17))

			await context.symbolControlFacet.connect(context.signers.admin).setPartyBLiquidationOvershootRate(await hedger.getAddress(), 0n, FIVE_BPS)
			const filledAmount = await hedger.fillCloseRequestToLiquidation(
				quoteId,
				limitFillCloseRequestBuilder().closedPrice(closePrice).upnlPartyA(upnlPartyA).price(marketPrice).build(),
			)
			expect(filledAmount).to.be.greaterThan(0n)
			expect(filledAmount).to.be.lessThan(quantity)

			const balanceAfter = await user.getBalanceInfo()
			const remainingUpnl = await user.getUpnl(async () => marketPrice)
			const availableAfter = balanceAfter.allocatedBalances - balanceAfter.lockedCva - balanceAfter.lockedLf + remainingUpnl
			expect(availableAfter).to.be.lessThan(0n)

			await expect(user.liquidateAndSetSymbolPrices([1n], [marketPrice], [quoteId])).to.not.be.reverted
		})

		it("can intentionally produce an OVERDUE liquidation with the maximum rate and a further adverse move", async function () {
			const quoteId = 1n
			const remainingQuoteId = await user.sendQuote()
			await hedger.lockQuote(remainingQuoteId)
			await hedger.openPosition(remainingQuoteId)
			const quantity = await getQuoteQuantity(context, quoteId)
			const closePrice = decimal(2n, 17)
			const marketPrice = decimal(8n, 17)
			// The 1e18 rate cap bounds the shortfall by the post-close CVA+LF, so leave just enough available
			// balance that the full close fits inside that allowance.
			const targetAllocatedBalance = decimal(1005n, 17)
			const balanceBeforeDeallocation = await user.getBalanceInfo()
			await context.accountFacet
				.connect(user.signer)
				.deallocate(balanceBeforeDeallocation.allocatedBalances - targetAllocatedBalance, await getDummySingleUpnlSig(decimal(200n)))
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(quantity).closePrice(closePrice).build())
			await context.symbolControlFacet.connect(context.signers.admin).setPartyBLiquidationOvershootRate(await hedger.getAddress(), 0n, 10n ** 18n)

			const upnlPartyA = await user.getUpnl(async () => marketPrice)
			const balanceBefore = await user.getBalanceInfo()
			expect(balanceBefore.allocatedBalances - balanceBefore.lockedCva - balanceBefore.lockedLf + upnlPartyA).to.equal(decimal(105n, 17))
			const filledAmount = await hedger.fillCloseRequestToLiquidation(
				quoteId,
				limitFillCloseRequestBuilder().closedPrice(closePrice).upnlPartyA(upnlPartyA).price(marketPrice).build(),
			)
			expect(filledAmount).to.equal(quantity)

			// The capped shortfall alone stays within CVA+LF; the market moving further against the remaining
			// position is what pushes the liquidation past the LATE band into OVERDUE.
			await user.liquidateAndSetSymbolPrices([1n], [decimal(7n, 17)], [remainingQuoteId])
			const liquidationState = await user.getLiquidatedStateOfPartyA()
			expect(liquidationState.liquidationType).to.equal(3n) // LiquidationType.OVERDUE
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

		it("Should cancel the remainder of a liquidation-limited best-effort SHORT close", async function () {
			const quoteId = await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

			const quantity = await getQuoteQuantity(context, quoteId)
			await user.requestToClosePosition(quoteId, marketBestEffortCloseRequestBuilder().quantityToClose(quantity).closePrice(decimal(1n)).build())
			const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
			const filledAmount = await hedger.fillCloseRequestToLiquidation(
				quoteId,
				limitFillCloseRequestBuilder().closedPrice(decimal(1n)).upnlPartyA(decimal(-440n)).price(decimal(5n, 17)).build(),
			)
			const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)

			expect(filledAmount).to.be.greaterThan(0n)
			expect(filledAmount).to.be.lessThan(quoteBefore.quantityToClose)
			expect(quoteAfter.closedAmount).to.equal(filledAmount)
			expect(quoteAfter.quoteStatus).to.equal(QuoteStatus.OPENED)
			expect(quoteAfter.quantityToClose).to.equal(0n)
			expect(quoteAfter.requestedClosePrice).to.equal(0n)
		})
	})

	describe("MARKET_BEST_EFFORT guardrails", function () {
		async function requestBestEffort(deadline?: bigint) {
			const quantity = await getQuoteQuantity(context, 1n)
			const builder = marketBestEffortCloseRequestBuilder().quantityToClose(quantity).closePrice(decimal(1n))
			if (deadline !== undefined) builder.deadline(deadline)
			await user.requestToClosePosition(1, builder.build())
			return context.viewFacetQuote.getQuote(1n)
		}

		it("Should reject a zero closeable amount without changing the request", async function () {
			const quoteBefore = await requestBestEffort()
			await expect(
				hedger.fillCloseRequestToLiquidation(
					1,
					limitFillCloseRequestBuilder().closedPrice(decimal(1n)).upnlPartyA(decimal(-500n)).price(decimal(2n)).build(),
				),
			).to.be.revertedWith("PartyBFacet: Cannot close any amount")

			const quoteAfter = await context.viewFacetQuote.getQuote(1n)
			expect(quoteAfter.quoteStatus).to.equal(QuoteStatus.CLOSE_PENDING)
			expect(quoteAfter.quantityToClose).to.equal(quoteBefore.quantityToClose)
			expect(quoteAfter.closedAmount).to.equal(quoteBefore.closedAmount)
		})

		it("Should preserve the remaining-position dust guard", async function () {
			const quoteBefore = await requestBestEffort()
			const symbol = await context.viewFacetSymbol.getSymbol(quoteBefore.symbolId)
			await context.symbolControlFacet
				.connect(context.signers.admin)
				.setSymbolAcceptableValues(quoteBefore.symbolId, decimal(80n), symbol.minAcceptablePortionLF)

			await expect(
				hedger.fillCloseRequestToLiquidation(
					1,
					limitFillCloseRequestBuilder().closedPrice(decimal(1n)).upnlPartyA(decimal(-450n)).price(decimal(2n)).build(),
				),
			).to.be.revertedWith("PartyBFacet: Remaining quote value is low")
		})

		it("Should preserve locked-value slice guards and roll back the prepared cancellation state", async function () {
			const quoteBefore = await requestBestEffort()
			const balanceInfo = await user.getBalanceInfo()
			const baseAvailable = balanceInfo.allocatedBalances - balanceInfo.lockedCva - balanceInfo.lockedLf

			await expect(
				hedger.fillCloseRequestToLiquidation(
					1,
					limitFillCloseRequestBuilder()
						.closedPrice(decimal(1n))
						.upnlPartyA(-baseAvailable + 1n)
						.price(decimal(2n))
						.build(),
				),
			).to.be.revertedWith("LibQuote: Low filled amount")

			const quoteAfter = await context.viewFacetQuote.getQuote(1n)
			expect(quoteAfter.quoteStatus).to.equal(QuoteStatus.CLOSE_PENDING)
			expect(quoteAfter.quantityToClose).to.equal(quoteBefore.quantityToClose)
			expect(quoteAfter.closedAmount).to.equal(quoteBefore.closedAmount)
		})

		it("Should preserve price and expiry validation", async function () {
			await requestBestEffort((await getBlockTimestamp()) + 2n)
			await expect(
				hedger.fillCloseRequestToLiquidation(1, limitFillCloseRequestBuilder().closedPrice(decimal(9n, 17)).price(decimal(2n)).build()),
			).to.be.revertedWith("PartyBFacet: Closed price isn't valid")

			await time.increase(3n)
			await expect(
				hedger.fillCloseRequestToLiquidation(1, limitFillCloseRequestBuilder().closedPrice(decimal(1n)).price(decimal(2n)).build()),
			).to.be.revertedWith("PartyBFacet: Quote is expired")
		})
	})
}
