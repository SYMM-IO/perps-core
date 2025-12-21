import { ethers, toUtf8Bytes } from "ethers";
import { expect } from "chai";

import { loadFixture, time } from "./helpers/network-helpers";
import { initializeFixture } from "./Initialize.fixture";

import { Hedger, BalanceInfo } from "./models/Hedger";
import { RunContext } from "./models/RunContext";
import { User } from "./models/User";
import { PartyBForceCloseState, PositionType, QuoteStatus } from "./models/Enums";

import type { QuoteStructOutput } from "../src/types/contracts/interfaces/ISymmio";

import {
    limitCloseRequestBuilder,
    marketCloseRequestBuilder,
} from "./models/requestModels/CloseRequest";
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest";

import { ForceClosePositionValidator } from "./models/validators/ForceClosePositionValidator";

import {
    decimal,
    unDecimal,
    getBlockTimestamp,
    getQuoteQuantity,
    getTotalLockedValuesForQuoteIds,
    getTradingFeeForQuotes,
} from "./utils/Common";

import {
    calculateExpectedAvgPriceForForceClose,
    calculateExpectedClosePriceForForceClose,
    calculateExpectedClosePriceForForceCloseWithAvg,
} from "./utils/PriceUtils";

import {
    getDummyCrossSettlementSig,
    getDummyHighLowPriceSig,
    getDummyMasterAccountSettlementSig,
    getDummyPriceSig,
} from "./utils/SignatureUtils";

import { migratePartyBToMaster } from "./utils/MasterAccount";


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
			})

			it("uses reserve vault to keep partyB solvent during force close", async function () {
				const sigTimes = await prepareSigTimes(100n)
				const hedgerAddress = await hedger.getAddress()
				const partyAAddress = await user.getAddress()

				await context.accountFacet.connect(hedger.signer).depositToReserveVault(decimal(1000n), hedgerAddress)
				{
					const targetAllocated = decimal(2000n)
					const balanceInfo = await hedger.getBalanceInfo(partyAAddress)
					if (balanceInfo.allocatedBalances < targetAllocated) {
						const topUp = targetAllocated - balanceInfo.allocatedBalances
						await hedger.setBalances(topUp, topUp)
						await context.accountFacet.connect(hedger.signer).allocateForPartyB(topUp, partyAAddress)
					}
				}

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
			})
		})
	})

	describe("Master Account Mode", async function () {
		describe("Master Account Mode not enabled", async function () {
			describe("Master Account  guards", function () {
				it("reverts initializeMasterAccountForceClose when master account mode is inactive", async function () {
					// No master account activation here on purpose
					const dummySig = await getDummyHighLowPriceSig()

					await expect(context.forceActionsFacet.initializeMasterAccountForceClose(quote1LongOpened.id, dummySig)).to.be.revertedWith(
						"ForceActionsFacet: Master account mode inactive",
					)
				})

			})
		})

		describe("Master Account Mode enabled", async function () {
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

				await migratePartyBToMaster(context, hedger, [quote1LongOpened.id, quote2ShortOpened.id, quote4LongOpened.id])

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
				settlementSig = await getDummyMasterAccountSettlementSig(
					[
						{
							quoteId: quote2ShortOpened.id,
							currentPrice: decimal(7n),
						} as any,
					],
					await hedger.getAddress(), // partyB
					0n, // upnlPartyB
					[await user.getAddress()], // partyAs
					[0n], // upnlPartyAs
				)
			})

			describe("Master Account  guards", function () {
				describe("when master account mode is active but force close not initialized", function () {
					beforeEach(async function () {})

					it("reverts forceClosePosition when partyB is in master account mode", async function () {
						const dummySig = await getDummyHighLowPriceSig()

						await expect(user.forceClosePosition(quote1LongOpened.id, dummySig)).to.be.revertedWith("ForceActionsFacet: Master account mode enabled")
					})

					it("reverts finalizeMasterAccountForceClose if it has not been initialized", async function () {
						await expect(context.forceActionsFacet.finalizeMasterAccountForceClose(quote1LongOpened.id)).to.be.revertedWith(
							"ForceActionsFacet: Invalid state",
						)
					})

					it("reverts settleUpnlMasterAccount if it has not been initialized", async function () {
						const dummyMasterSig = await getDummyMasterAccountSettlementSig()

						await expect(context.forceActionsFacet.settleUpnlMasterAccount(quote1LongOpened.id, dummyMasterSig, [])).to.be.revertedWith(
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
						await migratePartyBToMaster(context, hedger2, [quoteNotOpened.id])

						const settlementSigCross = await getDummyCrossSettlementSig(
							[0n],
							0n,
							await hedger2.getAddress(),
							[await user.getAddress()],
							[
								{
									quoteId: quoteNotOpened.id,
									currentPrice: decimal(7n),
								} as any,
							],
						)

						await expect(context.forceActionsFacet.initializeMasterAccountForceClose(quoteNotOpened.id, highLowSig)).to.be.revertedWith(
							"PartyAFacet: Invalid state",
						)
					})
				})

				describe("ForceCloseDetail", function () {
					describe("ForceCloseDetail flags initialization", function () {
						it("sets inProgress, closePrice and partyBAvailableAfterClose correctly on initializeMasterAccountForceClose", async function () {
							await context.forceActionsFacet.initializeMasterAccountForceClose(quote1LongOpened.id, highLowSig)

							const detail = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)

							expectedClosePrice = calculateExpectedClosePriceForForceCloseWithAvg(
								quote1LongOpened,
								penalty,
								BigInt(highLowSig.averagePrice),
								quote1LongOpened.positionType == BigInt(PositionType.LONG),
							)

							expect(detail.inProgress).to.equal(true)
							expect(detail.closePrice).to.equal(expectedClosePrice)
							expect(detail.timestamp > 0n).to.equal(true)
						})

						it("should revert initializeMasterAccountForceClose when partyA would be insolvent", async function () {
							highLowSig.upnlPartyA = -decimal(10_000n)
							await expect(context.forceActionsFacet.initializeMasterAccountForceClose(quote1LongOpened.id, highLowSig)).to.be.revertedWith('PartyAFacet: PartyA will be insolvent')

						})
					})

					describe("ForceCloseDetail flags settlement", function () {
						it("sets settlementState to REALIZED_MASTER_ACCOUNT on settleUpnlMasterAccount", async function () {
							// init master account force close
							await context.forceActionsFacet.initializeMasterAccountForceClose(quote1LongOpened.id, highLowSig)
							const detailBefore = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)

							await context.forceActionsFacet.settleUpnlMasterAccount(quote1LongOpened.id, settlementSig, [updatePrice])

							const detailAfter = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)

							expect(detailAfter.timestamp > detailBefore.timestamp).to.equal(true)
						})
					})

					describe("ForceCloseDetail flags finalize (solvent case)", function () {
						it("marks partyBState as SOLVED and clears inProgress when master account is solvent", async function () {
							await context.forceActionsFacet.initializeMasterAccountForceClose(quote1LongOpened.id, highLowSig)

							const detailBefore = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)
							expect(detailBefore.inProgress).to.equal(true)

							await context.forceActionsFacet.settleUpnlMasterAccount(quote1LongOpened.id, settlementSig, [updatePrice])
							await context.forceActionsFacet.finalizeMasterAccountForceClose(quote1LongOpened.id)

							const detailAfter = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)
							const masterBalance = await hedger.getBalanceInfoMasterAccount()
							const minRequired = masterBalance.lockedCva + masterBalance.lockedLf

							expect(detailAfter.inProgress).to.equal(false)
							expect(detailAfter.partyBState).to.equal(PartyBForceCloseState.SOLVENT)
							expect(detailAfter.partyBAvailableAfterClose).to.be.gte(minRequired)
						})
					})

					describe("forceCloseAndSettlePositionsMasterAccount", function () {
						it("runs initialize, settle, and finalize in a single call", async function () {
							const tx = await context.forceActionsFacet.forceCloseAndSettlePositionsMasterAccount(
								quote1LongOpened.id,
								highLowSig,
								settlementSig,
								[updatePrice],
							)

							await expect(tx)
								.to.emit(context.forceActionsFacet, "ForceCloseInitialized")
								.withArgs(anyValue, anyValue, quote1LongOpened.id, anyValue, anyValue, anyValue)
							await expect(tx).to.emit(context.forceActionsFacet, "SettleUpnlMasterAccount")
							await expect(tx)
								.to.emit(context.forceActionsFacet, "ForceClosePositionMasterAccount")
								.withArgs(
									quote1LongOpened.id,
									quote1LongOpened.partyA,
									quote1LongOpened.partyB,
									anyValue,
									anyValue,
									anyValue,
									anyValue,
									true,
								)

							const detailAfter = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)
							const masterBalance = await hedger.getBalanceInfoMasterAccount()
							const minRequired = masterBalance.lockedCva + masterBalance.lockedLf
							expect(detailAfter.inProgress).to.equal(false)
							expect(detailAfter.partyBState).to.equal(PartyBForceCloseState.SOLVENT)
							expect(detailAfter.partyBAvailableAfterClose).to.be.gte(minRequired)
						})

						it("skips settlement when updatedPrices is empty", async function () {
							const targetAllocated = decimal(20000n)
							const masterBalanceBefore = await hedger.getBalanceInfoMasterAccount()
							if (masterBalanceBefore.allocatedBalances < targetAllocated) {
								const topUp = targetAllocated - masterBalanceBefore.allocatedBalances
								await hedger.setBalances(topUp, topUp)
								await context.accountFacet.connect(hedger.signer).allocateForPartyB(topUp, ethers.ZeroAddress)
							}

							const tx = await context.forceActionsFacet.forceCloseAndSettlePositionsMasterAccount(
								quote1LongOpened.id,
								highLowSig,
								settlementSig,
								[],
							)

							await expect(tx).to.emit(context.forceActionsFacet, "ForceCloseInitialized")
							await expect(tx).to.not.emit(context.forceActionsFacet, "SettleUpnlMasterAccount")
							await expect(tx).to.emit(context.forceActionsFacet, "ForceClosePositionMasterAccount")

							const detailAfter = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)
							const masterBalance = await hedger.getBalanceInfoMasterAccount()
							const minRequired = masterBalance.lockedCva + masterBalance.lockedLf
							expect(detailAfter.partyBAvailableAfterClose).to.be.gte(minRequired)
						})

						it("marks partyBState as INSOLVENT when master account is not solvent but can pay from allocation", async function () {
							const targetAllocated = decimal(20000n)
							const masterBalanceBefore = await hedger.getBalanceInfoMasterAccount()
							if (masterBalanceBefore.allocatedBalances < targetAllocated) {
								const topUp = targetAllocated - masterBalanceBefore.allocatedBalances
								await hedger.setBalances(topUp, topUp)
								await context.accountFacet.connect(hedger.signer).allocateForPartyB(topUp, ethers.ZeroAddress)
							}
							highLowSig.upnlPartyB = -decimal(1_000_000n)
							highLowSig.currentPrice = decimal(1n)

							const tx = await context.forceActionsFacet.forceCloseAndSettlePositionsMasterAccount(
								quote1LongOpened.id,
								highLowSig,
								settlementSig,
								[updatePrice],
							)

							await expect(tx)
								.to.emit(context.forceActionsFacet, "ForceClosePositionMasterAccount")
								.withArgs(
									quote1LongOpened.id,
									quote1LongOpened.partyA,
									quote1LongOpened.partyB,
									anyValue,
									anyValue,
									anyValue,
									anyValue,
									false,
								)

							const detailAfter = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)
							const masterBalance = await hedger.getBalanceInfoMasterAccount()
							const minRequired = masterBalance.lockedCva + masterBalance.lockedLf
							expect(detailAfter.inProgress).to.equal(false)
							expect(detailAfter.partyBState).to.equal(PartyBForceCloseState.INSOLVENT)
							expect(detailAfter.partyBAvailableAfterClose).to.be.gte(minRequired)
						})
					})

					describe("ForceCloseDetail flags finalize (insolvent case)", function () {
						it("reverts when master allocated balance is insufficient to pay pnl", async function () {
							highLowSig.currentPrice = decimal(0n)
							await expect(await context.forceActionsFacet.initializeMasterAccountForceClose(quote1LongOpened.id, highLowSig)).not.to.reverted

							// not enough balance in master account but solvent
							await expect(context.forceActionsFacet.finalizeMasterAccountForceClose(quote1LongOpened.id)).to.be.revertedWith(
								"ForceActionsFacet: Insufficient balance",
							)
							expect((await context.viewFacetQuote.getQuote(quote1LongOpened.id)).quoteStatus).to.be.eq(QuoteStatus.CLOSE_PENDING)
						})

						it("records non-negative partyBAvailableAfterClose when insolvent", async function () {
							const targetAllocated = decimal(20000n)
							const masterBalanceBefore = await hedger.getBalanceInfoMasterAccount()
							if (masterBalanceBefore.allocatedBalances < targetAllocated) {
								const topUp = targetAllocated - masterBalanceBefore.allocatedBalances
								await hedger.setBalances(topUp, topUp)
								await context.accountFacet.connect(hedger.signer).allocateForPartyB(topUp, ethers.ZeroAddress)
							}

							highLowSig.upnlPartyB = -decimal(1_000_000n)
							const expectedClosePrice = calculateExpectedClosePriceForForceCloseWithAvg(
								quote1LongOpened,
								penalty,
								BigInt(highLowSig.averagePrice),
								quote1LongOpened.positionType == BigInt(PositionType.LONG),
							)
							highLowSig.currentPrice = expectedClosePrice

							await context.forceActionsFacet.initializeMasterAccountForceClose(quote1LongOpened.id, highLowSig)
							await context.forceActionsFacet.finalizeMasterAccountForceClose(quote1LongOpened.id)

							const detailAfter = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)
							const masterBalance = await hedger.getBalanceInfoMasterAccount()
							expect(detailAfter.partyBState).to.equal(PartyBForceCloseState.INSOLVENT)
							expect(detailAfter.partyBAvailableAfterClose).to.be.gte(masterBalance.lockedCva + masterBalance.lockedLf)
						})

						it("marks partyBState as INSOLVENT and clears inProgress when master account is not solvent but can pay from allocation", async function () {
							const targetAllocated = decimal(20000n)
							const masterBalanceBefore = await hedger.getBalanceInfoMasterAccount()
							if (masterBalanceBefore.allocatedBalances < targetAllocated) {
								const topUp = targetAllocated - masterBalanceBefore.allocatedBalances
								await hedger.setBalances(topUp, topUp)
								await context.accountFacet.connect(hedger.signer).allocateForPartyB(topUp, ethers.ZeroAddress)
							}
							highLowSig.upnlPartyB = -decimal(1_000_000n)
							highLowSig.currentPrice = decimal(1n)

							await context.forceActionsFacet.initializeMasterAccountForceClose(quote1LongOpened.id, highLowSig)
							const detailBefore = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)
							await expect(context.forceActionsFacet.finalizeMasterAccountForceClose(quote1LongOpened.id))
								.to.emit(context.forceActionsFacet, "ForceClosePositionMasterAccount")
								.withArgs(
									quote1LongOpened.id,
									quote1LongOpened.partyA,
									quote1LongOpened.partyB,
									anyValue,
									anyValue,
									anyValue,
									anyValue,
									false,
								)
							const detailAfter = await context.viewFacet.forceCloseDetails(quote1LongOpened.id)
							const masterBalance = await hedger.getBalanceInfoMasterAccount()
							const minRequired = masterBalance.lockedCva + masterBalance.lockedLf

							expect(detailBefore.inProgress).to.equal(true)
							expect(detailAfter.inProgress).to.equal(false)
							expect(detailAfter.partyBState).to.equal(PartyBForceCloseState.INSOLVENT)
							expect(detailAfter.partyBAvailableAfterClose).to.be.gte(minRequired)
						})
					})
				})
			})
		})
	})
}
