import {loadFixture, time} from "@nomicfoundation/hardhat-network-helpers"
import {expect} from "chai"

import {initializeFixture} from "./Initialize.fixture"
import {PositionType, QuoteStatus} from "./models/Enums"
import {BalanceInfo, Hedger} from "./models/Hedger"
import {RunContext} from "./models/RunContext"
import {User} from "./models/User"
import {limitCloseRequestBuilder, marketCloseRequestBuilder} from "./models/requestModels/CloseRequest"
import {limitQuoteRequestBuilder} from "./models/requestModels/QuoteRequest"
import {
	decimal,
	getBlockTimestamp,
	getQuoteQuantity,
	getTotalLockedValuesForQuoteIds,
	getTradingFeeForQuotes,
	unDecimal,
} from "./utils/Common"
import {getDummyHighLowPriceSig, getDummyPriceSig} from "./utils/SignatureUtils"
import {ForceClosePositionValidator} from "./models/validators/ForceClosePositionValidator"
import {calculateExpectedAvgPriceForForceClose, calculateExpectedClosePriceForForceClose} from "./utils/PriceUtils"
import {QuoteSettlementDataStruct, QuoteStructOutput, SettlementSigStruct} from "../src/types/contracts/interfaces/ISymmio"
import { ZeroAddress } from "ethers"

export function shouldBehaveLikeForceClosePosition(): void {
	let user: User, hedger: Hedger, hedger2: Hedger
	let context: RunContext
	let quote1LongOpened: QuoteStructOutput, quote2ShortOpened: QuoteStructOutput, quote3JustSent: QuoteStructOutput,
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
		await hedger.lockQuote(quote1LongOpened.id)
		await hedger.openPosition(quote1LongOpened.id)

		// Quote2 SHORT opened
		quote2ShortOpened = await context.viewFacetQuote.getQuote(await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build()))
		await hedger.lockQuote(quote2ShortOpened.id)
		await hedger.openPosition(quote2ShortOpened.id)

		// Quote3 SHORT sent
		quote3JustSent = await context.viewFacetQuote.getQuote(await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build()))

		// Quote4 LONG sent
		quote4LongOpened = await context.viewFacetQuote.getQuote(await user.sendQuote())
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

		await context.controlFacet.setForceCloseMinSigPeriod(10)
		await context.controlFacet.setForceCloseGapRatio((await context.viewFacetQuote.getQuote(quote1LongOpened.id)).symbolId, decimal(1n, 17))

		quote1LongOpened = await context.viewFacetQuote.getQuote(quote1LongOpened.id)
		quote2ShortOpened = await context.viewFacetQuote.getQuote(quote2ShortOpened.id)
		quote3JustSent = await context.viewFacetQuote.getQuote(quote3JustSent.id)
		quote4LongOpened = await context.viewFacetQuote.getQuote(quote4LongOpened.id)
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

	it("Should fail on invalid quote status", async function () {
		await expect(user.forceClosePosition(3, await getDummyHighLowPriceSig())).to.be.revertedWith("PartyAFacet: Invalid state")
	})

	it("Should fail on invalid order type", async function () {
		await expect(user.forceClosePosition(4, await getDummyHighLowPriceSig())).to.be.revertedWith("PartyBFacet: Quote's order type should be LIMIT")
	})

	it("Should fail on expired quote", async function () {
		const sigTimes = await prepareSigTimes()
		const dummySig = await getDummyHighLowPriceSig(sigTimes[0], sigTimes[1] + 800n)
		await expect(user.forceClosePosition(1, dummySig)).to.be.revertedWith("PartyBFacet: Close request is expired")
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
			decimal(0n),  // lowest
			BigInt(quote1LongOpened.requestedClosePrice) + unDecimal(BigInt(quote1LongOpened.requestedClosePrice) * BigInt(gapRatio1)) - decimal(1n),  // highest
			decimal(0n),  // currentPrice
			decimal(0n),  // averagePrice
			0n,           // symbolId
			0n,           // upnlPartyB
			0n            // upnlPartyA
		)
		await expect(user.forceClosePosition(quote1LongOpened.id, dummySig)).to.be.revertedWith("PartyAFacet: Requested close price not reached")

		const gapRatio2 = await context.viewFacetSymbol.forceCloseGapRatio(quote2ShortOpened.symbolId)
		dummySig = await getDummyHighLowPriceSig(
			sigTimes[0], // startTime
			sigTimes[1], // endTime
			BigInt(quote2ShortOpened.requestedClosePrice) + unDecimal(BigInt(quote2ShortOpened.requestedClosePrice) * BigInt(gapRatio2)) + decimal(1n),  // lowest
			decimal(10n), // highest
			decimal(7n),  // currentPrice
			decimal(8n),  // averagePrice
			0n,           // symbolId
			0n,           // upnlPartyB
			0n            // upnlPartyA
		)
		await expect(user.forceClosePosition(quote2ShortOpened.id, dummySig)).to.be.revertedWith("PartyAFacet: Requested close price not reached")
	})

	it("Should fail when the sig time is lower than forceCloseMinSigPeriod", async function () {
		const sigTimes = await prepareSigTimes(5n)
		const gapRatio2 = await context.viewFacetSymbol.forceCloseGapRatio(quote2ShortOpened.symbolId)
		const dummySig = await getDummyHighLowPriceSig(
			sigTimes[0], // startTime
			sigTimes[1], // endTime
			BigInt(quote2ShortOpened.requestedClosePrice) + unDecimal(BigInt(quote2ShortOpened.requestedClosePrice) * BigInt(gapRatio2)) - decimal(1n),  // lowest
			decimal(1n), // highest
			decimal(1n),  // currentPrice
			decimal(1n),  // averagePrice
			0n,           // symbolId
			0n,           // upnlPartyB
			0n            // upnlPartyA
		)
		await expect(user.forceClosePosition(quote2ShortOpened.id, dummySig)).to.be.revertedWith("PartyAFacet: Invalid signature period")
	})

	it("Should fail when partyA will be insolvent", async function () {
		const sigTimes = await prepareSigTimes()
		const quantity = decimal(100n)

		let userAvailable = (this.user_allocated
			- (await getTotalLockedValuesForQuoteIds(context, [1n, 4n], false))
			- (await getTradingFeeForQuotes(context, [1n, 2n, 3n, 4n]))
			- (unDecimal(quantity * (decimal(1n) - decimal(1n))))
			+ (decimal(1n))
		) * (-1n)

		const gapRatio2 = await context.viewFacetSymbol.forceCloseGapRatio(quote2ShortOpened.symbolId)
		const dummySig = await getDummyHighLowPriceSig(
			sigTimes[0],  // startTime
			sigTimes[1],  // endTime
			BigInt(quote2ShortOpened.requestedClosePrice) + unDecimal(BigInt(quote2ShortOpened.requestedClosePrice) * BigInt(gapRatio2)) - decimal(1n),  // lowest
			decimal(1n),  // highest
			decimal(1n),   // currentPrice
			decimal(1n),   // averagePrice
			0n,            // symbolId
			0n,            // upnlPartyB
			userAvailable  // upnlPartyA
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
				sigTimes[0],   // startTime
				sigTimes[1],   // endTime
				0n,            // lowest
				decimal(10n),  // highest
				decimal(7n),   // currentPrice
				decimal(8n),   // averagePrice
				0n,            // symbolId
				0n,            // upnlPartyB
				0n             // upnlPartyA
			)
			await user.forceClosePosition(quote2ShortOpened.id, dummySig)

			let balanceInfo: BalanceInfo = await hedger.getBalanceInfo(userAddress)
			expect(balanceInfo.allocatedBalances.toString()).to.be.equal("0")

			let sig = await getDummyPriceSig([4n, 2n, 1n], [0n, 0n, 0n])

			await context.liquidationFacet.connect(context.signers.liquidator).liquidatePositionsPartyB(hedgerAddress, userAddress, sig)

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
			sigTimes[0],  // startTime
			sigTimes[1],  // endTime
			BigInt(quote2ShortOpened.requestedClosePrice) + unDecimal(BigInt(quote2ShortOpened.requestedClosePrice) * BigInt(gapRatio2)) - decimal(1n),  // lowest
			decimal(3n),  // highest
			decimal(2n),   // currentPrice
			decimal(2n),   // averagePrice
			quote2ShortOpened.symbolId, // symbolId
			0n,            // upnlPartyB
			0n             // upnlPartyA
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

	describe("should calculate closePrice correctly when position is LONG", async function () {
		it("closePrice is higher than avg price", async function () {
			const sigTimes = await prepareSigTimes()

			await context.controlFacet.setForceClosePricePenalty(decimal(1n))

			const penalty = await context.viewFacet.forceClosePricePenalty()
			const quote = await context.viewFacetQuote.getQuote(1)

			console.log("quote.avgClosedPrice", quote.avgClosedPrice)
			console.log("quote.closedAmount", quote.closedAmount)
			console.log("quote.quantityToClose", quote.quantityToClose)
			

			const expectedClosePrice = calculateExpectedClosePriceForForceClose(quote, penalty, true)
			const expectedAvgClosedPrice = calculateExpectedAvgPriceForForceClose(quote, expectedClosePrice)

			const gapRatio = await context.viewFacetSymbol.forceCloseGapRatio(quote1LongOpened.symbolId)
			let dummySig = await getDummyHighLowPriceSig(
				sigTimes[0], // startTime
				sigTimes[1], // endTime
				decimal(1n),  // lowest
				BigInt(quote1LongOpened.requestedClosePrice) + unDecimal(BigInt(quote1LongOpened.requestedClosePrice) * BigInt(gapRatio)) + decimal(1n) / BigInt(10 ** 2),  // highest
				decimal(1n),  // currentPrice
				decimal(1n),  // averagePrice
				0n,           // symbolId
				0n,           // upnlPartyB
				0n            // upnlPartyA
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
				decimal(1n),  // lowest
				BigInt(quote1LongOpened.requestedClosePrice) + unDecimal(BigInt(quote1LongOpened.requestedClosePrice) * BigInt(gapRatio)) + decimal(5n),  // highest
				decimal(3n),  // currentPrice
				decimal(4n),  // averagePrice
				0n,           // symbolId
				0n,           // upnlPartyB
				0n            // upnlPartyA
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
				decimal(1n) / 6n / 2n
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
				sigTimes[0],  // startTime
				sigTimes[1],  // endTime
				BigInt(quote2ShortOpened.requestedClosePrice) + unDecimal(BigInt(quote2ShortOpened.requestedClosePrice) * BigInt(gapRatio)) - decimal(1n),  // lowest
				decimal(1n),  // highest
				decimal(1n),  // currentPrice
				decimal(1n),  // averagePrice
				quote2ShortOpened.symbolId, // symbolId
				0n,           // upnlPartyB
				0n            // upnlPartyA
			)

			await user.forceClosePosition(2, dummySig)

			const avgClosePrice = (await context.viewFacetQuote.getQuote(2)).avgClosedPrice

			expect(avgClosePrice).to.be.equal(expectedAvgClosedPrice)
		})
	})

	describe("settleAndForceClosePosition", function () {
		/**
		 * Builds a minimal valid SettlementSig for a single quote/price.
		 * You can replace this later with your own getDummySettlementSig helper
		 * if you already have one.
		 */
		async function buildSimpleSettlementSig(
			context: RunContext,
			quoteId: bigint,
			currentPrice: bigint,
			upnlPartyA: bigint,
			upnlPartyB: bigint,
			partyBUpnlIndex: number = 0,
		): Promise<SettlementSigStruct> {
			const quote = await context.viewFacet.getQuote(quoteId)
			const data: QuoteSettlementDataStruct = {
				quoteId,
				currentPrice,
				partyBUpnlIndex,
			}

			const settlementSig: SettlementSigStruct = {
				reqId: "0x11", // dummy
				timestamp: BigInt(await getBlockTimestamp()),
				quotesSettlementsData: [data],
				upnlPartyBs: [upnlPartyB],
				upnlPartyA,
				gatewaySignature: "0x", // dummy, Muon verifier in tests usually accepts this
				sigs: {
					signature: 0n,
					owner: await context.signers.liquidator.getAddress(),
					nonce:ZeroAddress,
				},
			}

			return settlementSig
		}

		it("should settle UPNL and then force close when updatedPrices is non-empty and partyB stays solvent", async function () {
			// Use quote2ShortOpened which is OPEN + CLOSE_PENDING in your beforeEach
			const quoteId = BigInt(quote2ShortOpened.id)
			const sigTimes = await prepareSigTimes(100n)
			const gapRatio = await context.viewFacet.forceCloseGapRatio(quote2ShortOpened.symbolId)

			// Choose updated price between openedPrice and currentPrice to satisfy LibSettlement range check
			const quote = await context.viewFacet.getQuote(quoteId)
			const openedPrice = BigInt(quote.openedPrice)

			// Use something modestly above openedPrice for SHORT
			const newPrice = openedPrice + decimal(1n) / 10n

			const highLowSig = await getDummyHighLowPriceSig(
				sigTimes[0], // start
				sigTimes[1], // end
				BigInt(quote.requestedClosePrice) + unDecimal(BigInt(quote.requestedClosePrice) * BigInt(gapRatio)) - decimal(1n), // lowest
				decimal(3n), // highest
				newPrice, // currentPrice
				newPrice, // averagePrice
				quote2ShortOpened.symbolId,
				0n,
				0n,
			)

			const settlementSig = await buildSimpleSettlementSig(
				context,
				quoteId,
				newPrice, // market Price
				0n, // upnlPartyA
				0n, // upnlPartyB
			)

			const updatedPrices = [newPrice]

			// Expect SettleUpnl + ForceClosePosition to solve or LiquidatePartyB.
			// We can assert that:
			//   - quote is no longer CLOSE_PENDING
			//   - openedPrice has been updated by settlement structure
			await context.forceActionsFacet.connect(user.getSigner).settleAndForceClosePosition(quoteId, highLowSig, settlementSig, updatedPrices)

			const closedQuote = await context.viewFacet.getQuote(quoteId)
			expect(closedQuote.quoteStatus).to.not.equal(QuoteStatus.CLOSE_PENDING)
			expect(BigInt(closedQuote.openedPrice)).to.equal(newPrice)
		})

		it("should revert LibSettlement: Invalid length when updatedPrices length does not match quotesSettlementsData", async function () {
			const quoteId = BigInt(quote2ShortOpened.id)
			const sigTimes = await prepareSigTimes(100n)

			const highLowSig = await getDummyHighLowPriceSig(
				sigTimes[0],
				sigTimes[1],
				decimal(0n),
				decimal(10n),
				decimal(5n),
				decimal(5n),
				quote2ShortOpened.symbolId,
				0n,
				0n,
			)

			const settlementSig = await buildSimpleSettlementSig(context, quoteId, decimal(5n), 0n, 0n)

			await expect(
				context.forceActionsFacet.connect(context.signers.user).settleAndForceClosePosition(quoteId, highLowSig, settlementSig, []),
			).to.be.revertedWith("LibSettlement: Invalid length")
		})
	})
}
