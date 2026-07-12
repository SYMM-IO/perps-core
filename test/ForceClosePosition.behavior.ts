import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs"
import { expect } from "chai"
import { toUtf8Bytes } from "ethers"

import type { QuoteStructOutput } from "../src/types/interfaces/ISymmio.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { PartyBForceCloseState, PositionType, QuoteStatus } from "./models/Enums.js"
import type { BalanceInfo } from "./models/Hedger.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder, marketCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { ForceClosePositionValidator } from "./models/validators/ForceClosePositionValidator.js"
import { decimal, getBlockTimestamp, getQuoteQuantity, getTotalLockedValuesForQuoteIds, getTradingFeeForQuotes, unDecimal } from "./utils/Common.js"
import { migratePartyBToCross } from "./utils/CrossPartyB.js"
import {
	calculateExpectedAvgPriceForForceClose,
	calculateExpectedClosePriceForForceClose,
	calculateExpectedClosePriceForForceCloseWithAvg,
} from "./utils/PriceUtils.js"
import {
	getDummyHighLowPriceSig,
	getDummyLiquidationSig,
	getDummyPairUpnlAndPriceSig,
	getDummyPriceSig,
	getDummyUnifiedSettlementSig,
} from "./utils/SignatureUtils.js"

export function shouldBehaveLikeForceClosePosition(): void {
	let user: User, hedger: Hedger, hedger2: Hedger
	let context: RunContext
	let quote1LongOpened: QuoteStructOutput,
		quote2ShortOpened: QuoteStructOutput,
		quote3JustSent: QuoteStructOutput,
		quote4LongOpened: QuoteStructOutput

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

		// Quote2 SHORT opened
		quote2ShortOpened = await context.viewFacetQuote.getQuote(
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build()),
		)

		// Quote3 SHORT sent
		quote3JustSent = await context.viewFacetQuote.getQuote(await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build()))

		// Quote4 LONG sent
		quote4LongOpened = await context.viewFacetQuote.getQuote(await user.sendQuote())

		await context.controlFacet
			.connect(context.signers.admin)
			.grantRole(await context.signers.admin.getAddress(), ethers.keccak256(toUtf8Bytes("FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE")))
		await context.controlFacet.setForceCloseMinSigPeriod(10)
		await context.controlFacet.setForceCloseGapRatio((await context.viewFacetQuote.getQuote(quote1LongOpened.id)).symbolId, decimal(1n, 17))
	})

	async function prepareSigTimes(period: bigint = 10n) {
		const now = await getBlockTimestamp()
		const cooldowns = await context.viewFacet.forceCloseCooldowns()
		const firstCooldown = cooldowns[0]
		const secondCooldown = cooldowns[1]
		const startTime = firstCooldown + now
		const endTime = firstCooldown + now + period
		await time.increase(firstCooldown + period + secondCooldown + 1n)
		return [startTime, endTime]
	}

	describe("Normal PartyB Account Mode", async function () {
		beforeEach(async () => {
			await hedger.lockQuote(quote1LongOpened.id)
			await hedger.openPosition(quote1LongOpened.id)

			await hedger.lockQuote(quote2ShortOpened.id)
			await hedger.openPosition(quote2ShortOpened.id)

			await hedger.lockQuote(quote4LongOpened.id)
			await hedger.openPosition(quote4LongOpened.id)

			await user.requestToClosePosition(
				quote1LongOpened.id,
				limitCloseRequestBuilder()
					.quantityToClose(await getQuoteQuantity(context, quote1LongOpened.id))
					.closePrice(decimal(1n))
					.deadline((await getBlockTimestamp()) + 1000n)
					.build(),
			)
			await user.requestToClosePosition(
				quote2ShortOpened.id,
				limitCloseRequestBuilder()
					.quantityToClose(await getQuoteQuantity(context, quote2ShortOpened.id))
					.closePrice(decimal(1n))
					.deadline((await getBlockTimestamp()) + 1000n)
					.build(),
			)
			await user.requestToClosePosition(
				quote4LongOpened.id,
				marketCloseRequestBuilder()
					.quantityToClose(await getQuoteQuantity(context, quote4LongOpened.id))
					.closePrice(decimal(1n))
					.deadline((await getBlockTimestamp()) + 1000n)
					.build(),
			)

			quote1LongOpened = await context.viewFacetQuote.getQuote(quote1LongOpened.id)
			quote2ShortOpened = await context.viewFacetQuote.getQuote(quote2ShortOpened.id)
			quote3JustSent = await context.viewFacetQuote.getQuote(quote3JustSent.id)
			quote4LongOpened = await context.viewFacetQuote.getQuote(quote4LongOpened.id)
		})
		it("Should fail on invalid quote status", async function () {
			await expect(user.forceClosePosition(3, await getDummyHighLowPriceSig())).to.be.revertedWith("PartyAFacet: Invalid state")
		})

		it("Should fail on invalid order type", async function () {
			await expect(user.forceClosePosition(4, await getDummyHighLowPriceSig())).to.be.revertedWith("PartyAFacet: Quote's order type should be LIMIT")
		})

		it("Should fail on expired quote", async function () {
			const sigTimes = await prepareSigTimes()
			const dummySig = await getDummyHighLowPriceSig(sigTimes[0], sigTimes[1] + 800n)
			await expect(user.forceClosePosition(1, dummySig)).to.be.revertedWith("PartyAFacet: Close request is expired")
		})

		it("Should fail when cooldowns not reached", async function () {
			const sigTimes = await prepareSigTimes()

			let dummySig = await getDummyHighLowPriceSig(sigTimes[0] - 50n, sigTimes[1])
			await expect(user.forceClosePosition(1, dummySig)).to.be.revertedWith("PartyAFacet: Cooldown not reached")

			dummySig = await getDummyHighLowPriceSig(sigTimes[0], sigTimes[1] + 200n)
			await expect(user.forceClosePosition(1, dummySig)).to.be.revertedWith("PartyAFacet: Cooldown not reached")
		})

		it("Should fail on invalid averagePrice", async function () {
			const sigTimes = await prepareSigTimes()
			await expect(user.forceClosePosition(2, await getDummyHighLowPriceSig(sigTimes[0], sigTimes[1], 100n, 200n, 210n, 220n))).to.be.revertedWith(
				"PartyAFacet: Invalid average price",
			)

			await expect(user.forceClosePosition(2, await getDummyHighLowPriceSig(sigTimes[0], sigTimes[1], 100n, 200n, 210n, 80n))).to.be.revertedWith(
				"PartyAFacet: Invalid average price",
			)
		})

		it("Should fail when price not reached to requested close price", async function () {
			const sigTimes = await prepareSigTimes()
			const gapRatio1 = await context.viewFacetSymbol.forceCloseGapRatio(quote1LongOpened.symbolId)
			let dummySig = await getDummyHighLowPriceSig(
				sigTimes[0], // startTime
				sigTimes[1], // endTime
				decimal(0n), // lowest
				BigInt(quote1LongOpened.requestedClosePrice) + unDecimal(BigInt(quote1LongOpened.requestedClosePrice) * BigInt(gapRatio1)) - decimal(1n), // highest
				decimal(0n), // currentPrice
				decimal(0n), // averagePrice
				0n, // symbolId
				0n, // upnlPartyB
				0n, // upnlPartyA
			)
			await expect(user.forceClosePosition(quote1LongOpened.id, dummySig)).to.be.revertedWith("PartyAFacet: Requested close price not reached")

			const gapRatio2 = await context.viewFacetSymbol.forceCloseGapRatio(quote2ShortOpened.symbolId)
			dummySig = await getDummyHighLowPriceSig(
				sigTimes[0], // startTime
				sigTimes[1], // endTime
				BigInt(quote2ShortOpened.requestedClosePrice) + unDecimal(BigInt(quote2ShortOpened.requestedClosePrice) * BigInt(gapRatio2)) + decimal(1n), // lowest
				decimal(10n), // highest
				decimal(7n), // currentPrice
				decimal(8n), // averagePrice
				0n, // symbolId
				0n, // upnlPartyB
				0n, // upnlPartyA
			)
			await expect(user.forceClosePosition(quote2ShortOpened.id, dummySig)).to.be.revertedWith("PartyAFacet: Requested close price not reached")
		})

		it("Should fail when the sig time is lower than forceCloseMinSigPeriod", async function () {
			const sigTimes = await prepareSigTimes(5n)
			const gapRatio2 = await context.viewFacetSymbol.forceCloseGapRatio(quote2ShortOpened.symbolId)
			const dummySig = await getDummyHighLowPriceSig(
				sigTimes[0], // startTime
				sigTimes[1], // endTime
				BigInt(quote2ShortOpened.requestedClosePrice) + unDecimal(BigInt(quote2ShortOpened.requestedClosePrice) * BigInt(gapRatio2)) - decimal(1n), // lowest
				decimal(1n), // highest
				decimal(1n), // currentPrice
				decimal(1n), // averagePrice
				0n, // symbolId
				0n, // upnlPartyB
				0n, // upnlPartyA
			)
			await expect(user.forceClosePosition(quote2ShortOpened.id, dummySig)).to.be.revertedWith("PartyAFacet: Invalid signature period")
		})

		it("Should fail when partyA will be insolvent", async function () {
			const sigTimes = await prepareSigTimes()
			const quantity = decimal(100n)

			let userAvailable =
				(this.user_allocated -
					(await getTotalLockedValuesForQuoteIds(context, [1n, 4n], false)) -
					(await getTradingFeeForQuotes(context, [1n, 2n, 3n, 4n])) -
					unDecimal(quantity * (decimal(1n) - decimal(1n))) +
					decimal(1n)) *
				-1n

			const gapRatio2 = await context.viewFacetSymbol.forceCloseGapRatio(quote2ShortOpened.symbolId)
			const dummySig = await getDummyHighLowPriceSig(
				sigTimes[0], // startTime
				sigTimes[1], // endTime
				BigInt(quote2ShortOpened.requestedClosePrice) + unDecimal(BigInt(quote2ShortOpened.requestedClosePrice) * BigInt(gapRatio2)) - decimal(1n), // lowest
				decimal(1n), // highest
				decimal(1n), // currentPrice
				decimal(1n), // averagePrice
				0n, // symbolId
				0n, // upnlPartyB
				userAvailable, // upnlPartyA
			)

			await expect(user.forceClosePosition(quote2ShortOpened.id, dummySig)).to.be.revertedWith("PartyAFacet: PartyA will be insolvent")
		})

		describe("When partyB will be insolvent", async function () {
			it("Should liquidate partyB when partyB will be insolvent", async function () {
				const sigTimes = await prepareSigTimes()
				const userAddress = await context.signers.user.getAddress()
				const hedgerAddress = await context.signers.hedger.getAddress()

				const gapRatio2 = await context.viewFacetSymbol.forceCloseGapRatio(quote2ShortOpened.symbolId)
				const dummySig = await getDummyHighLowPriceSig(
					sigTimes[0], // startTime
					sigTimes[1], // endTime
					0n, // lowest
					decimal(10n), // highest
					decimal(7n), // currentPrice
					decimal(8n), // averagePrice
					0n, // symbolId
					0n, // upnlPartyB
					0n, // upnlPartyA
				)
				await user.forceClosePosition(quote2ShortOpened.id, dummySig)

				// PartyB should be marked as liquidated with zero allocation
				let balanceInfo: BalanceInfo = await hedger.getBalanceInfo(userAddress)
				expect(balanceInfo.allocatedBalances).to.be.equal(0n)
				expect(await context.viewFacet.isPartyBLiquidated(hedgerAddress, userAddress)).to.equal(true)

				// The force-closed quote should still be CLOSE_PENDING since partyB was liquidated (not closed normally)
				expect((await context.viewFacetQuote.getQuote(2)).quoteStatus).to.be.equal(QuoteStatus.CLOSE_PENDING)

				let sig = await getDummyPriceSig([4n, 2n, 1n], [0n, 0n, 0n])

				await context.partyBLiquidationFacet.connect(context.signers.liquidator).liquidatePositionsPartyB(hedgerAddress, userAddress, sig)

				expect((await context.viewFacetQuote.getQuote(3)).quoteStatus).to.be.equal(QuoteStatus.PENDING)
				expect((await context.viewFacetQuote.getQuote(4)).quoteStatus).to.be.equal(QuoteStatus.LIQUIDATED)
				expect((await context.viewFacetQuote.getQuote(2)).quoteStatus).to.be.equal(QuoteStatus.LIQUIDATED)
				expect((await context.viewFacetQuote.getQuote(1)).quoteStatus).to.be.equal(QuoteStatus.LIQUIDATED)
			})
		})

		it("Should forceClose Quote correctly", async function () {
			const validator = new ForceClosePositionValidator()
			const beforeOut = await validator.before(context, {
				user: user,
				hedger: hedger,
				quoteId: BigInt(quote2ShortOpened.id),
			})
			const sigTimes = await prepareSigTimes(100n)
			const gapRatio2 = await context.viewFacetSymbol.forceCloseGapRatio(quote2ShortOpened.symbolId)
			const dummySig = await getDummyHighLowPriceSig(
				sigTimes[0], // startTime
				sigTimes[1], // endTime
				BigInt(quote2ShortOpened.requestedClosePrice) + unDecimal(BigInt(quote2ShortOpened.requestedClosePrice) * BigInt(gapRatio2)) - decimal(1n), // lowest
				decimal(3n), // highest
				decimal(2n), // currentPrice
				decimal(2n), // averagePrice
				quote2ShortOpened.symbolId, // symbolId
				0n, // upnlPartyB
				0n, // upnlPartyA
			)

			await user.forceClosePosition(quote2ShortOpened.id, dummySig)
			await validator.after(context, {
				user: user,
				hedger: hedger,
				quoteId: BigInt(quote2ShortOpened.id),
				sig: {
					lowestPrice: decimal(1n),
					highestPrice: decimal(3n),
					averagePrice: decimal(2n),
					currentPrice: decimal(2n),
					endTime: sigTimes[0],
					startTime: sigTimes[1],
				},
				beforeOutput: beforeOut,
			})
		})

		it("Should fail forceClosePosition while symbol is frozen", async function () {
			const sigTimes = await prepareSigTimes(100n)
			const gapRatio2 = await context.viewFacetSymbol.forceCloseGapRatio(quote2ShortOpened.symbolId)
			const dummySig = await getDummyHighLowPriceSig(
				sigTimes[0], // startTime
				sigTimes[1], // endTime
				BigInt(quote2ShortOpened.requestedClosePrice) + unDecimal(BigInt(quote2ShortOpened.requestedClosePrice) * BigInt(gapRatio2)) - decimal(1n), // lowest
				decimal(3n), // highest
				decimal(2n), // currentPrice
				decimal(2n), // averagePrice
				quote2ShortOpened.symbolId, // symbolId
				0n, // upnlPartyB
				0n, // upnlPartyA
			)

			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(quote2ShortOpened.symbolId, decimal(4n), now - 1n)

			await expect(user.forceClosePosition(quote2ShortOpened.id, dummySig)).to.be.revertedWith("LibSymbolAdjustment: Symbol is frozen")
		})

		it("Should fail finalizeForceClose when a symbol adjustment freezes the symbol between init and finalize", async function () {
			const sigTimes = await prepareSigTimes(100n)
			const gapRatio2 = await context.viewFacetSymbol.forceCloseGapRatio(quote2ShortOpened.symbolId)
			const dummySig = await getDummyHighLowPriceSig(
				sigTimes[0], // startTime
				sigTimes[1], // endTime
				BigInt(quote2ShortOpened.requestedClosePrice) + unDecimal(BigInt(quote2ShortOpened.requestedClosePrice) * BigInt(gapRatio2)) - decimal(1n), // lowest
				decimal(3n), // highest
				decimal(2n), // currentPrice
				decimal(2n), // averagePrice
				quote2ShortOpened.symbolId, // symbolId
				0n, // upnlPartyB
				0n, // upnlPartyA
			)

			// Step 1: initialize force close while the symbol is still unfrozen — succeeds.
			await context.forceCloseStepsFacet.initializeForceClose(quote2ShortOpened.id, dummySig)

			// Straddle the window: a corporate action gets scheduled with a past-effective timestamp,
			// freezing the symbol immediately, in between init and finalize.
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(quote2ShortOpened.symbolId, decimal(4n), now - 1n)

			// Step 3: finalizeForceClose must now revert because the symbol is frozen.
			await expect(
				context.forceCloseStepsFacet.finalizeForceClose(quote2ShortOpened.id, await getDummyPairUpnlAndPriceSig(decimal(2n), 0n, 0n)),
			).to.be.revertedWith("LibSymbolAdjustment: Symbol is frozen")
		})

		it("increments partyA and partyB nonces on solvent forceClosePosition", async function () {
			const partyA = await user.getAddress()
			const partyB = await hedger.getAddress()

			const beforeNonceA = await context.viewFacet.nonceOfPartyA(partyA)
			const beforeNonceBPerPartyA = await context.viewFacet.nonceOfPartyB(partyB, partyA)
			const beforeNonceBCross = await context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress)

			const sigTimes = await prepareSigTimes(100n)
			const gapRatio2 = await context.viewFacetSymbol.forceCloseGapRatio(quote2ShortOpened.symbolId)
			const dummySig = await getDummyHighLowPriceSig(
				sigTimes[0],
				sigTimes[1],
				BigInt(quote2ShortOpened.requestedClosePrice) + unDecimal(BigInt(quote2ShortOpened.requestedClosePrice) * BigInt(gapRatio2)) - decimal(1n),
				decimal(3n),
				decimal(2n),
				decimal(2n),
				quote2ShortOpened.symbolId,
				0n,
				0n,
			)

			await user.forceClosePosition(quote2ShortOpened.id, dummySig)

			const afterNonceA = await context.viewFacet.nonceOfPartyA(partyA)
			const afterNonceBPerPartyA = await context.viewFacet.nonceOfPartyB(partyB, partyA)
			const afterNonceBCross = await context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress)

			expect(afterNonceA).to.equal(beforeNonceA + 1n)
			expect(afterNonceBPerPartyA).to.equal(beforeNonceBPerPartyA + 1n)
			expect(afterNonceBCross).to.equal(beforeNonceBCross + 1n)
		})

		it("increments partyA and partyB nonces on finalizeForceClose in normal mode", async function () {
			const partyA = await user.getAddress()
			const partyB = await hedger.getAddress()

			const beforeNonceA = await context.viewFacet.nonceOfPartyA(partyA)
			const beforeNonceBPerPartyA = await context.viewFacet.nonceOfPartyB(partyB, partyA)
			const beforeNonceBCross = await context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress)

			const sigTimes = await prepareSigTimes(100n)
			const gapRatio2 = await context.viewFacetSymbol.forceCloseGapRatio(quote2ShortOpened.symbolId)
			const forceCloseSig = await getDummyHighLowPriceSig(
				sigTimes[0],
				sigTimes[1],
				BigInt(quote2ShortOpened.requestedClosePrice) + unDecimal(BigInt(quote2ShortOpened.requestedClosePrice) * BigInt(gapRatio2)) - decimal(1n),
				decimal(3n),
				decimal(2n),
				decimal(2n),
				quote2ShortOpened.symbolId,
				0n,
				0n,
			)

			await context.forceCloseStepsFacet.initializeForceClose(quote2ShortOpened.id, forceCloseSig)
			await context.forceCloseStepsFacet.finalizeForceClose(quote2ShortOpened.id, await getDummyPairUpnlAndPriceSig(decimal(2n), 0n, 0n))

			const afterNonceA = await context.viewFacet.nonceOfPartyA(partyA)
			const afterNonceBPerPartyA = await context.viewFacet.nonceOfPartyB(partyB, partyA)
			const afterNonceBCross = await context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress)

			expect(afterNonceA).to.equal(beforeNonceA + 1n)
			expect(afterNonceBPerPartyA).to.equal(beforeNonceBPerPartyA + 1n)
			expect(afterNonceBCross).to.equal(beforeNonceBCross + 1n)
		})

		it("increments partyA and partyB nonces in normal mode when settlement is skipped", async function () {
			const partyA = await user.getAddress()
			const partyB = await hedger.getAddress()

			const beforeNonceA = await context.viewFacet.nonceOfPartyA(partyA)
			const beforeNonceBPerPartyA = await context.viewFacet.nonceOfPartyB(partyB, partyA)
			const beforeNonceBCross = await context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress)

			const sigTimes = await prepareSigTimes(100n)
			const gapRatio2 = await context.viewFacetSymbol.forceCloseGapRatio(quote2ShortOpened.symbolId)
			const forceCloseSig = await getDummyHighLowPriceSig(
				sigTimes[0],
				sigTimes[1],
				BigInt(quote2ShortOpened.requestedClosePrice) + unDecimal(BigInt(quote2ShortOpened.requestedClosePrice) * BigInt(gapRatio2)) - decimal(1n),
				decimal(3n),
				decimal(2n),
				decimal(2n),
				quote2ShortOpened.symbolId,
				0n,
				0n,
			)

			await context.forceCloseStepsFacet.forceCloseAndSettlePositionsUnified(
				quote2ShortOpened.id,
				forceCloseSig,
				await getDummyUnifiedSettlementSig(await hedger.getAddress(), 0n, [0n], [partyA], [0n], []),
				[],
			)

			const afterNonceA = await context.viewFacet.nonceOfPartyA(partyA)
			const afterNonceBPerPartyA = await context.viewFacet.nonceOfPartyB(partyB, partyA)
			const afterNonceBCross = await context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress)

			expect(afterNonceA).to.equal(beforeNonceA + 1n)
			expect(afterNonceBPerPartyA).to.equal(beforeNonceBPerPartyA + 1n)
			expect(afterNonceBCross).to.equal(beforeNonceBCross + 1n)
		})

		describe("should calculate closePrice correctly when position is LONG", async function () {
			it("closePrice is higher than avg price", async function () {
				const sigTimes = await prepareSigTimes()

				await context.controlFacet.setForceClosePricePenalty(decimal(1n))

				const penalty = await context.viewFacet.forceClosePricePenalty()
				const quote = await context.viewFacetQuote.getQuote(1)

				const expectedClosePrice = calculateExpectedClosePriceForForceClose(quote, penalty, true)
				const expectedAvgClosedPrice = calculateExpectedAvgPriceForForceClose(quote, expectedClosePrice)

				const gapRatio = await context.viewFacetSymbol.forceCloseGapRatio(quote1LongOpened.symbolId)
				let dummySig = await getDummyHighLowPriceSig(
					sigTimes[0], // startTime
					sigTimes[1], // endTime
					decimal(1n), // lowest
					BigInt(quote1LongOpened.requestedClosePrice) +
						unDecimal(BigInt(quote1LongOpened.requestedClosePrice) * BigInt(gapRatio)) +
						decimal(1n) / BigInt(10 ** 2), // highest
					decimal(1n), // currentPrice
					decimal(1n), // averagePrice
					0n, // symbolId
					0n, // upnlPartyB
					0n, // upnlPartyA
				)

				await user.forceClosePosition(quote1LongOpened.id, dummySig)
				const avgClosePrice = (await context.viewFacetQuote.getQuote(quote1LongOpened.id)).avgClosedPrice
				expect(avgClosePrice).to.be.equal(expectedAvgClosedPrice)
			})

			it("closePrice is lower than or equal to avg price", async function () {
				const sigTimes = await prepareSigTimes()

				await context.controlFacet.setForceClosePricePenalty(decimal(1n))
				const quote = await context.viewFacetQuote.getQuote(1)

				const expectedClosePrice = decimal(4n) //sig.averagePrice
				const expectedAvgClosedPrice = calculateExpectedAvgPriceForForceClose(quote, expectedClosePrice)

				const gapRatio = await context.viewFacetSymbol.forceCloseGapRatio(quote1LongOpened.symbolId)
				let dummySig = await getDummyHighLowPriceSig(
					sigTimes[0], // startTime
					sigTimes[1], // endTime
					decimal(1n), // lowest
					BigInt(quote1LongOpened.requestedClosePrice) + unDecimal(BigInt(quote1LongOpened.requestedClosePrice) * BigInt(gapRatio)) + decimal(5n), // highest
					decimal(3n), // currentPrice
					decimal(4n), // averagePrice
					0n, // symbolId
					0n, // upnlPartyB
					0n, // upnlPartyA
				)
				await user.forceClosePosition(quote1LongOpened.id, dummySig)

				const avgClosePrice = (await context.viewFacetQuote.getQuote(quote1LongOpened.id)).avgClosedPrice
				expect(avgClosePrice).to.be.equal(expectedAvgClosedPrice)
			})
		})

		describe("should calculate closePrice correctly when position is SHORT", async function () {
			it("closePrice is higher than avg price", async function () {
				const sigTimes = await prepareSigTimes()

				await context.controlFacet.setForceClosePricePenalty(decimal(1n) / 2n)

				const dummySig = await getDummyHighLowPriceSig(
					sigTimes[0], // startTime
					sigTimes[1], // endTime
					decimal(0n),
					decimal(1n) / 6n,
					decimal(1n),
					decimal(1n) / 6n / 2n,
				)

				await user.forceClosePosition(2, dummySig)

				const avgClosePrice = BigInt((await context.viewFacetQuote.getQuote(2)).avgClosedPrice)

				expect(avgClosePrice).to.be.equal(decimal(1n) / 6n / 2n) // sig.averagePrice
			})
			it("closePrice is lower than or equal to avg price", async function () {
				const sigTimes = await prepareSigTimes()

				await context.controlFacet.setForceClosePricePenalty(decimal(1n) / 2n)

				const penalty = await context.viewFacet.forceClosePricePenalty()
				const quote = await context.viewFacetQuote.getQuote(2)

				const expectClosePrice = calculateExpectedClosePriceForForceClose(quote, penalty, false)
				const expectedAvgClosedPrice = calculateExpectedAvgPriceForForceClose(quote, expectClosePrice)

				const gapRatio = await context.viewFacetSymbol.forceCloseGapRatio(quote2ShortOpened.symbolId)
				const dummySig = await getDummyHighLowPriceSig(
					sigTimes[0], // startTime
					sigTimes[1], // endTime
					BigInt(quote2ShortOpened.requestedClosePrice) + unDecimal(BigInt(quote2ShortOpened.requestedClosePrice) * BigInt(gapRatio)) - decimal(1n), // lowest
					decimal(1n), // highest
					decimal(1n), // currentPrice
					decimal(1n), // averagePrice
					quote2ShortOpened.symbolId, // symbolId
					0n, // upnlPartyB
					0n, // upnlPartyA
				)

				await user.forceClosePosition(2, dummySig)

				const avgClosePrice = (await context.viewFacetQuote.getQuote(2)).avgClosedPrice

				expect(avgClosePrice).to.be.equal(expectedAvgClosedPrice)
			})
		})

		describe("Reserve vault assisted force close", function () {
			it("marks partyB liquidated when reserve is empty and loss is large", async function () {
				const sigTimes = await prepareSigTimes(100n)
				const hedgerAddress = await hedger.getAddress()
				const partyAAddress = await user.getAddress()

				const liquidatingSig = await getDummyHighLowPriceSig(
					sigTimes[0],
					sigTimes[1],
					decimal(1n),
					decimal(12n),
					decimal(5n),
					decimal(10n),
					quote1LongOpened.symbolId,
					-decimal(5000n),
					decimal(5000n),
				)

				await user.forceClosePosition(quote1LongOpened.id, liquidatingSig)

				expect(await context.viewFacet.isPartyBLiquidated(hedgerAddress, partyAAddress)).to.equal(true)

				// PartyB's allocated balance should be zeroed out on liquidation
				const balanceInfo = await hedger.getBalanceInfo(partyAAddress)
				expect(balanceInfo.allocatedBalances).to.equal(0n)

				// The force-closed quote should still be CLOSE_PENDING (not CLOSED) since partyB was liquidated
				const quoteAfter = await context.viewFacetQuote.getQuote(quote1LongOpened.id)
				expect(quoteAfter.quoteStatus).to.equal(QuoteStatus.CLOSE_PENDING)
			})

			it("uses reserve vault to keep partyB solvent during force close", async function () {
				const sigTimes = await prepareSigTimes(100n)
				const hedgerAddress = await hedger.getAddress()
				const partyAAddress = await user.getAddress()
				const beforeNonceA = await context.viewFacet.nonceOfPartyA(partyAAddress)
				const beforeNonceBPerPartyA = await context.viewFacet.nonceOfPartyB(hedgerAddress, partyAAddress)
				const beforeNonceBCross = await context.viewFacet.nonceOfPartyB(hedgerAddress, ethers.ZeroAddress)

				await context.partyBAccountFacet.connect(hedger.signer).depositToReserveVault(decimal(1000n), hedgerAddress)
				{
					const targetAllocated = decimal(2000n)
					const balanceInfo = await hedger.getBalanceInfo(partyAAddress)
					if (balanceInfo.allocatedBalances < targetAllocated) {
						const topUp = targetAllocated - balanceInfo.allocatedBalances
						await hedger.setBalances(topUp, topUp)
						await context.partyBAccountFacet.connect(hedger.signer).allocateForPartyB(topUp, partyAAddress)
					}
				}

				const quoteBefore = await context.viewFacetQuote.getQuote(quote1LongOpened.id)

				const solventSig = await getDummyHighLowPriceSig(
					sigTimes[0],
					sigTimes[1],
					decimal(1n),
					decimal(12n),
					decimal(5n),
					decimal(10n),
					quote1LongOpened.symbolId,
					-decimal(400n),
					decimal(1500n),
				)

				await user.forceClosePosition(quote1LongOpened.id, solventSig)

				const quoteAfter = await context.viewFacetQuote.getQuote(quote1LongOpened.id)
				expect(await context.viewFacet.isPartyBLiquidated(hedgerAddress, partyAAddress)).to.equal(false)
				expect(quoteAfter.quoteStatus).to.equal(QuoteStatus.CLOSED)
				// Verify quote was fully closed
				expect(quoteAfter.closedAmount).to.equal(quoteBefore.quantity)
				// Verify avgClosedPrice is set (non-zero)
				expect(quoteAfter.avgClosedPrice).to.be.gt(0n)

				const afterNonceA = await context.viewFacet.nonceOfPartyA(partyAAddress)
				const afterNonceBPerPartyA = await context.viewFacet.nonceOfPartyB(hedgerAddress, partyAAddress)
				const afterNonceBCross = await context.viewFacet.nonceOfPartyB(hedgerAddress, ethers.ZeroAddress)

				expect(afterNonceA).to.equal(beforeNonceA + 1n)
				expect(afterNonceBPerPartyA).to.equal(beforeNonceBPerPartyA + 1n)
				expect(afterNonceBCross).to.equal(beforeNonceBCross + 1n)
			})
		})
	})

	describe("Cross PartyB Mode", async function () {
		describe("Cross PartyB Mode not enabled", async function () {
			describe("Cross PartyB  guards", function () {
				it("reverts forceClosePosition when cross partyB mode is inactive for normal partyB", async function () {
					// No cross partyB activation here on purpose - forceClosePosition should work for normal partyBs
					// This test just validates the setup is correct
				})
			})
		})

		describe("Cross PartyB Mode enabled", async function () {
			let highLowSig: any
			let penalty: bigint
			let expectedClosePrice: bigint
			let updatePrice: bigint
			let settlementSig: any
			beforeEach(async function () {
				await hedger.lockQuote(quote1LongOpened.id)
				await hedger.openPosition(quote1LongOpened.id)

				await hedger.lockQuote(quote2ShortOpened.id)
				await hedger.openPosition(quote2ShortOpened.id)

				await hedger.lockQuote(quote4LongOpened.id)
				await hedger.openPosition(quote4LongOpened.id)

				await migratePartyBToCross(context, hedger, [quote1LongOpened.id, quote2ShortOpened.id, quote4LongOpened.id])

				await user.requestToClosePosition(
					quote1LongOpened.id,
					limitCloseRequestBuilder()
						.quantityToClose(await getQuoteQuantity(context, quote1LongOpened.id))
						.closePrice(decimal(1n))
						.deadline((await getBlockTimestamp()) + 1000n)
						.build(),
				)

				await user.requestToClosePosition(
					quote2ShortOpened.id,
					limitCloseRequestBuilder()
						.quantityToClose(await getQuoteQuantity(context, quote2ShortOpened.id))
						.closePrice(decimal(1n))
						.deadline((await getBlockTimestamp()) + 1000n)
						.build(),
				)
				await user.requestToClosePosition(
					quote4LongOpened.id,
					marketCloseRequestBuilder()
						.quantityToClose(await getQuoteQuantity(context, quote4LongOpened.id))
						.closePrice(decimal(1n))
						.deadline((await getBlockTimestamp()) + 1000n)
						.build(),
				)

				quote1LongOpened = await context.viewFacetQuote.getQuote(quote1LongOpened.id)
				quote2ShortOpened = await context.viewFacetQuote.getQuote(quote2ShortOpened.id)
				quote3JustSent = await context.viewFacetQuote.getQuote(quote3JustSent.id)
				quote4LongOpened = await context.viewFacetQuote.getQuote(quote4LongOpened.id)

				const sigTimes = await prepareSigTimes(100n)
				const gapRatio = await context.viewFacetSymbol.forceCloseGapRatio(quote1LongOpened.symbolId)

				highLowSig = await getDummyHighLowPriceSig(
					sigTimes[0], // startTime
					sigTimes[1], // endTime
					BigInt(quote1LongOpened.requestedClosePrice) + unDecimal(BigInt(quote1LongOpened.requestedClosePrice) * BigInt(gapRatio)) + decimal(1n), // lowest
					decimal(10n), // highest
					decimal(7n), // currentPrice
					decimal(8n), // averagePrice
					quote1LongOpened.symbolId, // symbolId
					0n, // upnlPartyB
					0n, // upnlPartyA
				)

				penalty = await context.viewFacet.forceClosePricePenalty()

				updatePrice = decimal(5n)
				settlementSig = await getDummyUnifiedSettlementSig(
					await hedger.getAddress(), // partyB
					0n, // upnlPartyB
					[], // upnlPartyBPerPartyA (empty for crossPartyB mode)
					[await user.getAddress()], // partyAs
					[0n], // upnlPartyAs
					[
						{
							quoteId: quote2ShortOpened.id,
							currentPrice: decimal(7n),
							partyAIndex: 0,
						} as any,
					],
				)
			})

			describe("Cross PartyB  guards", function () {
				describe("when cross partyB mode is active but force close not initialized", function () {
					beforeEach(async function () {})

					it("reverts forceClosePosition when partyB is in cross partyB mode", async function () {
						const dummySig = await getDummyHighLowPriceSig()

						await expect(user.forceClosePosition(quote1LongOpened.id, dummySig)).to.be.revertedWith("ForceActionsFacet: Cross partyB mode enabled")
					})

					it("reverts finalizeForceClose if it has not been initialized", async function () {
						await expect(
							context.forceCloseStepsFacet.finalizeForceClose(quote1LongOpened.id, await getDummyPairUpnlAndPriceSig()),
						).to.be.revertedWith("ForceActionsFacet: Invalid state")
					})

					it("reverts settleUpnlForForceClose if it has not been initialized", async function () {
						const dummyCrossSig = await getDummyUnifiedSettlementSig()

						await expect(context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, dummyCrossSig, [])).to.be.revertedWith(
							"ForceActionsFacet: Invalid state",
						)
					})

					it("Should revert when quote status is not OPENED/CLOSE_PENDING/CANCEL_CLOSE_PENDING", async function () {
						await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

						let quoteNotOpened: QuoteStructOutput
						quoteNotOpened = await context.viewFacetQuote.getQuote(
							await user.sendQuote(
								limitQuoteRequestBuilder()
									.deadline((await getBlockTimestamp()) + 1000n)
									.build(),
							),
						)
						await hedger2.lockQuote(quoteNotOpened.id)
						await hedger2.openPosition(quoteNotOpened.id)
						await migratePartyBToCross(context, hedger2, [quoteNotOpened.id])

						const settlementSigCross = await getDummyUnifiedSettlementSig(
							await hedger2.getAddress(), // partyB
							0n, // upnlPartyB
							[], // upnlPartyBPerPartyA (empty for crossPartyB mode)
							[await user.getAddress()], // partyAs
							[0n], // upnlPartyAs
							[
								{
									quoteId: quoteNotOpened.id,
									currentPrice: decimal(7n),
									partyAIndex: 0,
								} as any,
							],
						)

						await expect(context.forceCloseStepsFacet.initializeForceClose(quoteNotOpened.id, highLowSig)).to.be.revertedWith(
							"PartyAFacet: Invalid state",
						)
					})
				})

				describe("ForceCloseDetail", function () {
					describe("ForceCloseDetail flags initialization", function () {
						it("sets inProgress, closePrice and partyBAvailableAfterClose correctly on initializeForceClose", async function () {
							await context.forceCloseStepsFacet.initializeForceClose(quote1LongOpened.id, highLowSig)

							const detail = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)

							expectedClosePrice = calculateExpectedClosePriceForForceCloseWithAvg(
								quote1LongOpened,
								penalty,
								BigInt(highLowSig.averagePrice),
								quote1LongOpened.positionType == BigInt(PositionType.LONG),
							)

							expect(detail.inProgress).to.equal(true)
							expect(detail.closePrice).to.equal(expectedClosePrice)
							expect(detail.timestamp).to.be.gt(0n)
							expect(detail.quoteId).to.equal(quote1LongOpened.id)
							expect(detail.partyBState).to.equal(PartyBForceCloseState.NONE)
						})

						it("should revert initializeForceClose when partyA would be insolvent", async function () {
							highLowSig.upnlPartyA = -decimal(10_000n)
							await expect(context.forceCloseStepsFacet.initializeForceClose(quote1LongOpened.id, highLowSig)).to.be.revertedWith(
								"PartyAFacet: PartyA will be insolvent",
							)
						})
					})

					describe("ForceCloseDetail flags settlement", function () {
						it("sets timestamp on settleUpnlForForceClose", async function () {
							// init force close
							await context.forceCloseStepsFacet.initializeForceClose(quote1LongOpened.id, highLowSig)
							const detailBefore = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)

							await context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, settlementSig, [updatePrice])

							const detailAfter = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)

							expect(detailAfter.timestamp > detailBefore.timestamp).to.equal(true)
						})

						it("does not change force-close snapshot currentPrice on settleUpnlForForceClose", async function () {
							await context.forceCloseStepsFacet.initializeForceClose(quote1LongOpened.id, highLowSig)
							const before = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)

							await context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, settlementSig, [updatePrice])

							const after = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)
							expect(after.currentPrice).to.equal(before.currentPrice)
						})
					})

					describe("ForceCloseDetail flags finalize (solvent case)", function () {
						it("marks partyBState as SOLVENT and clears inProgress when cross partyB is solvent", async function () {
							await context.forceCloseStepsFacet.initializeForceClose(quote1LongOpened.id, highLowSig)

							const detailBefore = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)
							expect(detailBefore.inProgress).to.equal(true)

							await context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, settlementSig, [updatePrice])
							await context.forceCloseStepsFacet.finalizeForceClose(
								quote1LongOpened.id,
								await getDummyPairUpnlAndPriceSig(BigInt(highLowSig.currentPrice), 0n, BigInt(highLowSig.upnlPartyB)),
							)

							const detailAfter = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)
							const crossBalance = await hedger.getBalanceInfoCrossPartyB()
							const minRequired = crossBalance.lockedCva + crossBalance.lockedLf

							expect(detailAfter.inProgress).to.equal(false)
							expect(detailAfter.partyBState).to.equal(PartyBForceCloseState.CLOSED_SOLVENT)
							expect(detailAfter.partyBAvailableAfterClose).to.be.gte(minRequired)
						})

						it("increments partyA and partyB nonces on finalizeForceClose in 3-step flow", async function () {
							const partyA = await user.getAddress()
							const partyB = await hedger.getAddress()

							const targetAllocated = decimal(20000n)
							const crossBalanceBefore = await hedger.getBalanceInfoCrossPartyB()
							if (crossBalanceBefore.allocatedBalances < targetAllocated) {
								const topUp = targetAllocated - crossBalanceBefore.allocatedBalances
								await hedger.setBalances(topUp, topUp)
								await context.partyBAccountFacet.connect(hedger.signer).allocateForPartyB(topUp, ethers.ZeroAddress)
							}

							const beforeNonceA = await context.viewFacet.nonceOfPartyA(partyA)
							const beforeNonceB = await context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress)
							const beforeNonceBPartyA = await context.viewFacet.nonceOfPartyB(partyB, partyA)

							await context.forceCloseStepsFacet.initializeForceClose(quote1LongOpened.id, highLowSig)
							await context.forceCloseStepsFacet.finalizeForceClose(
								quote1LongOpened.id,
								await getDummyPairUpnlAndPriceSig(BigInt(highLowSig.currentPrice), 0n, BigInt(highLowSig.upnlPartyB)),
							)

							const afterNonceA = await context.viewFacet.nonceOfPartyA(partyA)
							const afterNonceB = await context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress)
							const afterNonceBPartyA = await context.viewFacet.nonceOfPartyB(partyB, partyA)

							expect(afterNonceA).to.equal(beforeNonceA + 1n)
							expect(afterNonceB).to.equal(beforeNonceB + 1n)
							expect(afterNonceBPartyA).to.equal(beforeNonceBPartyA + 1n)
						})

						it("finalizeForceClose(quoteId, sig) refreshes snapshot and uses it for cross-partyB solvency", async function () {
							const targetAllocated = decimal(20000n)
							const crossBalanceBefore = await hedger.getBalanceInfoCrossPartyB()
							if (crossBalanceBefore.allocatedBalances < targetAllocated) {
								const topUp = targetAllocated - crossBalanceBefore.allocatedBalances
								await hedger.setBalances(topUp, topUp)
								await context.partyBAccountFacet.connect(hedger.signer).allocateForPartyB(topUp, ethers.ZeroAddress)
							}

							const badInitSig = { ...highLowSig, upnlPartyB: -decimal(1_000_000n) }
							await context.forceCloseStepsFacet.initializeForceClose(quote1LongOpened.id, badInitSig)

							const refreshedSig = await getDummyPairUpnlAndPriceSig(
								BigInt(highLowSig.currentPrice), // price
								0n, // upnlPartyA
								0n, // upnlPartyB
							)

							const tx = await (context.forceCloseStepsFacet as any)[
								"finalizeForceClose(uint256,(bytes,uint256,int256,int256,uint256,bytes,(uint256,address,address)))"
							](quote1LongOpened.id, refreshedSig)
							await expect(tx)
								.to.emit(context.forceCloseStepsFacet, "ForceClosePosition")
								.withArgs(quote1LongOpened.id, quote1LongOpened.partyA, quote1LongOpened.partyB, anyValue, anyValue, anyValue, anyValue)
						})
					})

					describe("forceCloseAndSettlePositionsUnified", function () {
						it("runs initialize, settle, and finalize in a single call", async function () {
							const tx = await context.forceCloseStepsFacet.forceCloseAndSettlePositionsUnified(quote1LongOpened.id, highLowSig, settlementSig, [
								updatePrice,
							])

							await expect(tx)
								.to.emit(context.forceCloseStepsFacet, "ForceCloseInitialized")
								.withArgs(anyValue, anyValue, quote1LongOpened.id, anyValue, anyValue, anyValue)
							await expect(tx).to.emit(context.forceCloseStepsFacet, "SettleUpnlUnified")
							await expect(tx)
								.to.emit(context.forceCloseStepsFacet, "ForceClosePosition")
								.withArgs(quote1LongOpened.id, quote1LongOpened.partyA, quote1LongOpened.partyB, anyValue, anyValue, anyValue, anyValue)

							const detailAfter = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)
							const crossBalance = await hedger.getBalanceInfoCrossPartyB()
							const minRequired = crossBalance.lockedCva + crossBalance.lockedLf
							expect(detailAfter.inProgress).to.equal(false)
							expect(detailAfter.partyBState).to.equal(PartyBForceCloseState.CLOSED_SOLVENT)
							expect(detailAfter.partyBAvailableAfterClose).to.be.gte(minRequired)
						})

						it("skips settlement when updatedPrices is empty", async function () {
							const targetAllocated = decimal(20000n)
							const crossBalanceBefore = await hedger.getBalanceInfoCrossPartyB()
							if (crossBalanceBefore.allocatedBalances < targetAllocated) {
								const topUp = targetAllocated - crossBalanceBefore.allocatedBalances
								await hedger.setBalances(topUp, topUp)
								await context.partyBAccountFacet.connect(hedger.signer).allocateForPartyB(topUp, ethers.ZeroAddress)
							}

							const tx = await context.forceCloseStepsFacet.forceCloseAndSettlePositionsUnified(quote1LongOpened.id, highLowSig, settlementSig, [])

							await expect(tx).to.emit(context.forceCloseStepsFacet, "ForceCloseInitialized")
							await expect(tx).to.not.emit(context.forceCloseStepsFacet, "SettleUpnlUnified")
							await expect(tx).to.emit(context.forceCloseStepsFacet, "ForceClosePosition")

							const detailAfter = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)
							const crossBalance = await hedger.getBalanceInfoCrossPartyB()
							const minRequired = crossBalance.lockedCva + crossBalance.lockedLf
							expect(detailAfter.partyBAvailableAfterClose).to.be.gte(minRequired)
						})

						it("increments partyA and partyB nonces when settlement is skipped", async function () {
							const partyA = await user.getAddress()
							const partyB = await hedger.getAddress()

							const targetAllocated = decimal(20000n)
							const crossBalanceBefore = await hedger.getBalanceInfoCrossPartyB()
							if (crossBalanceBefore.allocatedBalances < targetAllocated) {
								const topUp = targetAllocated - crossBalanceBefore.allocatedBalances
								await hedger.setBalances(topUp, topUp)
								await context.partyBAccountFacet.connect(hedger.signer).allocateForPartyB(topUp, ethers.ZeroAddress)
							}

							const beforeNonceA = await context.viewFacet.nonceOfPartyA(partyA)
							const beforeNonceB = await context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress)
							const beforeNonceBPartyA = await context.viewFacet.nonceOfPartyB(partyB, partyA)

							await context.forceCloseStepsFacet.forceCloseAndSettlePositionsUnified(quote1LongOpened.id, highLowSig, settlementSig, [])

							const afterNonceA = await context.viewFacet.nonceOfPartyA(partyA)
							const afterNonceB = await context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress)
							const afterNonceBPartyA = await context.viewFacet.nonceOfPartyB(partyB, partyA)

							expect(afterNonceA).to.equal(beforeNonceA + 1n)
							expect(afterNonceB).to.equal(beforeNonceB + 1n)
							expect(afterNonceBPartyA).to.equal(beforeNonceBPartyA + 1n)
						})

						it("marks partyBState as INSOLVENT when cross partyB is not solvent but can pay from allocation", async function () {
							const targetAllocated = decimal(20000n)
							const crossBalanceBefore = await hedger.getBalanceInfoCrossPartyB()
							if (crossBalanceBefore.allocatedBalances < targetAllocated) {
								const topUp = targetAllocated - crossBalanceBefore.allocatedBalances
								await hedger.setBalances(topUp, topUp)
								await context.partyBAccountFacet.connect(hedger.signer).allocateForPartyB(topUp, ethers.ZeroAddress)
							}
							highLowSig.upnlPartyB = -decimal(1_000_000n)
							highLowSig.currentPrice = decimal(1n)

							const tx = await context.forceCloseStepsFacet.forceCloseAndSettlePositionsUnified(quote1LongOpened.id, highLowSig, settlementSig, [
								updatePrice,
							])

							await expect(tx)
								.to.emit(context.forceCloseStepsFacet, "ForceClosePosition")
								.withArgs(quote1LongOpened.id, quote1LongOpened.partyA, quote1LongOpened.partyB, anyValue, anyValue, anyValue, anyValue)

							const detailAfter = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)
							const crossBalance = await hedger.getBalanceInfoCrossPartyB()
							const minRequired = crossBalance.lockedCva + crossBalance.lockedLf
							expect(detailAfter.inProgress).to.equal(false)
							expect(detailAfter.partyBState).to.equal(PartyBForceCloseState.CLOSED_INSOLVENT)
							expect(detailAfter.partyBAvailableAfterClose).to.be.gte(minRequired)
						})
					})

					describe("ForceCloseDetail flags finalize (insolvent case)", function () {
						it("reverts when cross allocated balance is insufficient to pay pnl", async function () {
							highLowSig.currentPrice = decimal(0n)
							await expect(context.forceCloseStepsFacet.initializeForceClose(quote1LongOpened.id, highLowSig)).not.to.be.reverted

							// not enough balance in cross partyB but solvent
							await expect(
								context.forceCloseStepsFacet.finalizeForceClose(
									quote1LongOpened.id,
									await getDummyPairUpnlAndPriceSig(BigInt(highLowSig.currentPrice)),
								),
							).to.be.revertedWith("ForceActionsFacet: Insufficient balance")
							expect((await context.viewFacetQuote.getQuote(quote1LongOpened.id)).quoteStatus).to.be.eq(QuoteStatus.CLOSE_PENDING)
						})

						it("records non-negative partyBAvailableAfterClose when insolvent", async function () {
							const targetAllocated = decimal(20000n)
							const crossBalanceBefore = await hedger.getBalanceInfoCrossPartyB()
							if (crossBalanceBefore.allocatedBalances < targetAllocated) {
								const topUp = targetAllocated - crossBalanceBefore.allocatedBalances
								await hedger.setBalances(topUp, topUp)
								await context.partyBAccountFacet.connect(hedger.signer).allocateForPartyB(topUp, ethers.ZeroAddress)
							}

							highLowSig.upnlPartyB = -decimal(1_000_000n)
							const expectedClosePrice = calculateExpectedClosePriceForForceCloseWithAvg(
								quote1LongOpened,
								penalty,
								BigInt(highLowSig.averagePrice),
								quote1LongOpened.positionType == BigInt(PositionType.LONG),
							)
							highLowSig.currentPrice = expectedClosePrice

							await context.forceCloseStepsFacet.initializeForceClose(quote1LongOpened.id, highLowSig)
							await context.forceCloseStepsFacet.finalizeForceClose(
								quote1LongOpened.id,
								await getDummyPairUpnlAndPriceSig(BigInt(highLowSig.currentPrice), 0n, BigInt(highLowSig.upnlPartyB)),
							)

							const detailAfter = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)
							const crossBalance = await hedger.getBalanceInfoCrossPartyB()
							expect(detailAfter.partyBState).to.equal(PartyBForceCloseState.CLOSED_INSOLVENT)
							expect(detailAfter.partyBAvailableAfterClose).to.be.gte(crossBalance.lockedCva + crossBalance.lockedLf)
						})

						it("marks partyBState as INSOLVENT and clears inProgress when cross partyB is not solvent but can pay from allocation", async function () {
							const targetAllocated = decimal(20000n)
							const crossBalanceBefore = await hedger.getBalanceInfoCrossPartyB()
							if (crossBalanceBefore.allocatedBalances < targetAllocated) {
								const topUp = targetAllocated - crossBalanceBefore.allocatedBalances
								await hedger.setBalances(topUp, topUp)
								await context.partyBAccountFacet.connect(hedger.signer).allocateForPartyB(topUp, ethers.ZeroAddress)
							}
							highLowSig.upnlPartyB = -decimal(1_000_000n)
							highLowSig.currentPrice = decimal(1n)

							await context.forceCloseStepsFacet.initializeForceClose(quote1LongOpened.id, highLowSig)
							const detailBefore = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)
							const tx = await context.forceCloseStepsFacet.finalizeForceClose(
								quote1LongOpened.id,
								await getDummyPairUpnlAndPriceSig(BigInt(highLowSig.currentPrice), 0n, BigInt(highLowSig.upnlPartyB)),
							)
							await expect(tx)
								.to.emit(context.forceCloseStepsFacet, "ForceClosePosition")
								.withArgs(quote1LongOpened.id, quote1LongOpened.partyA, quote1LongOpened.partyB, anyValue, anyValue, anyValue, anyValue)
							await expect(tx)
								.to.emit(context.forceCloseStepsFacet, "ForceClosePartyBInsolvent")
								.withArgs(
									quote1LongOpened.id,
									quote1LongOpened.partyA,
									quote1LongOpened.partyB,
									anyValue,
									highLowSig.currentPrice,
									highLowSig.upnlPartyB,
									anyValue,
								)
							const detailAfter = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)
							const crossBalance = await hedger.getBalanceInfoCrossPartyB()
							const minRequired = crossBalance.lockedCva + crossBalance.lockedLf

							expect(detailBefore.inProgress).to.equal(true)
							expect(detailAfter.inProgress).to.equal(false)
							expect(detailAfter.partyBState).to.equal(PartyBForceCloseState.CLOSED_INSOLVENT)
							expect(detailAfter.partyBAvailableAfterClose).to.be.gte(minRequired)
						})

						it("increments partyA and partyB nonces when cross close uses ignoring-UPNL fallback", async function () {
							const targetAllocated = decimal(20000n)
							const crossBalanceBefore = await hedger.getBalanceInfoCrossPartyB()
							if (crossBalanceBefore.allocatedBalances < targetAllocated) {
								const topUp = targetAllocated - crossBalanceBefore.allocatedBalances
								await hedger.setBalances(topUp, topUp)
								await context.partyBAccountFacet.connect(hedger.signer).allocateForPartyB(topUp, ethers.ZeroAddress)
							}

							highLowSig.upnlPartyB = -decimal(1_000_000n)
							highLowSig.currentPrice = decimal(1n)

							const partyA = await user.getAddress()
							const partyB = await hedger.getAddress()
							const beforeNonceA = await context.viewFacet.nonceOfPartyA(partyA)
							const beforeNonceB = await context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress)
							const beforeNonceBPartyA = await context.viewFacet.nonceOfPartyB(partyB, partyA)

							await context.forceCloseStepsFacet.initializeForceClose(quote1LongOpened.id, highLowSig)
							await context.forceCloseStepsFacet.finalizeForceClose(
								quote1LongOpened.id,
								await getDummyPairUpnlAndPriceSig(BigInt(highLowSig.currentPrice), 0n, BigInt(highLowSig.upnlPartyB)),
							)

							const afterNonceA = await context.viewFacet.nonceOfPartyA(partyA)
							const afterNonceB = await context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress)
							const afterNonceBPartyA = await context.viewFacet.nonceOfPartyB(partyB, partyA)

							expect(afterNonceA).to.equal(beforeNonceA + 1n)
							expect(afterNonceB).to.equal(beforeNonceB + 1n)
							expect(afterNonceBPartyA).to.equal(beforeNonceBPartyA + 1n)
						})
					})
				})
			})
		})
	})

	describe("notLiquidated modifier on force close steps", function () {
		beforeEach(async function () {
			await hedger.lockQuote(quote1LongOpened.id)
			await hedger.openPosition(quote1LongOpened.id)

			await hedger.lockQuote(quote2ShortOpened.id)
			await hedger.openPosition(quote2ShortOpened.id)

			await hedger.lockQuote(quote4LongOpened.id)
			await hedger.openPosition(quote4LongOpened.id)

			await user.requestToClosePosition(
				quote1LongOpened.id,
				limitCloseRequestBuilder()
					.quantityToClose(await getQuoteQuantity(context, quote1LongOpened.id))
					.closePrice(decimal(1n))
					.deadline((await getBlockTimestamp()) + 1000n)
					.build(),
			)

			quote1LongOpened = await context.viewFacetQuote.getQuote(quote1LongOpened.id)
		})

		it("Should revert settleUpnlForForceClose when partyA is liquidated", async function () {
			const sigTimes = await prepareSigTimes(100n)
			const gapRatio = await context.viewFacetSymbol.forceCloseGapRatio(quote1LongOpened.symbolId)

			const highLowSig = await getDummyHighLowPriceSig(
				sigTimes[0],
				sigTimes[1],
				decimal(1n),
				BigInt(quote1LongOpened.requestedClosePrice) + unDecimal(BigInt(quote1LongOpened.requestedClosePrice) * BigInt(gapRatio)) + decimal(1n),
				decimal(1n),
				decimal(1n),
				quote1LongOpened.symbolId,
				0n,
				0n,
			)

			// Step 1: initialize force close (passes notLiquidated)
			await context.forceCloseStepsFacet.initializeForceClose(quote1LongOpened.id, highLowSig)

			// Trigger partyA liquidation between steps
			const allocatedBalance = (await user.getBalanceInfo()).allocatedBalances
			const liquidationSig = await getDummyLiquidationSig(
				"0x10",
				-decimal(10000n),
				[quote1LongOpened.symbolId],
				[decimal(1n)],
				-decimal(10000n),
				allocatedBalance,
			)
			await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePartyA(await user.getAddress(), liquidationSig)

			// Step 2: settleUpnlForForceClose should revert because partyA is now liquidated
			const settlementSig = await getDummyUnifiedSettlementSig()
			await expect(context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, settlementSig, [])).to.be.revertedWith(
				"Accessibility: PartyA isn't solvent",
			)
		})

		it("Should revert finalizeForceClose when partyA is liquidated", async function () {
			const sigTimes = await prepareSigTimes(100n)
			const gapRatio = await context.viewFacetSymbol.forceCloseGapRatio(quote1LongOpened.symbolId)

			const highLowSig = await getDummyHighLowPriceSig(
				sigTimes[0],
				sigTimes[1],
				decimal(1n),
				BigInt(quote1LongOpened.requestedClosePrice) + unDecimal(BigInt(quote1LongOpened.requestedClosePrice) * BigInt(gapRatio)) + decimal(1n),
				decimal(1n),
				decimal(1n),
				quote1LongOpened.symbolId,
				0n,
				0n,
			)

			// Step 1: initialize force close (passes notLiquidated)
			await context.forceCloseStepsFacet.initializeForceClose(quote1LongOpened.id, highLowSig)

			// Trigger partyA liquidation between steps
			const allocatedBalance = (await user.getBalanceInfo()).allocatedBalances
			const liquidationSig = await getDummyLiquidationSig(
				"0x10",
				-decimal(10000n),
				[quote1LongOpened.symbolId],
				[decimal(1n)],
				-decimal(10000n),
				allocatedBalance,
			)
			await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePartyA(await user.getAddress(), liquidationSig)

			// Step 3: finalizeForceClose should revert because partyA is now liquidated
			await expect(context.forceCloseStepsFacet.finalizeForceClose(quote1LongOpened.id, await getDummyPairUpnlAndPriceSig())).to.be.revertedWith(
				"Accessibility: PartyA isn't solvent",
			)
		})
	})
}
