import { expect } from "chai"
import { ethers, toUtf8Bytes } from "ethers"
import {loadFixture, time} from "./helpers/network-helpers.js"

import type {
	HighLowPriceSigStruct,
	QuoteSettlementDataStructOutput,
	QuoteStructOutput,
	SettlementSigStruct,
} from "../src/types/interfaces/ISymmio.js"
import type { UnifiedSettlementSigStruct } from "../src/types/facets/Settlement/ISettlementFacet.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { PositionType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp, getQuoteQuantity, unDecimal } from "./utils/Common.js"
import {
	getDummyHighLowPriceSig,
	getDummyPairUpnlAndPriceSig,
	getDummySettlementSig,
	getDummyUnifiedSettlementSig
} from "./utils/SignatureUtils.js"
import { migratePartyBToCross } from "./utils/CrossPartyB.js"

export function shouldBehaveLikeSettleAndForceClosePosition(): void {
	let user: User, hedger: Hedger, hedger2: Hedger, user2: User
	let context: RunContext
	let quote1LongOpened: QuoteStructOutput, quote2ShortOpened: QuoteStructOutput
	let quantityShort: bigint

	let sigTimes,
		highLowSig: HighLowPriceSigStruct,
		settlementSig: SettlementSigStruct,
		settlementSigCross: UnifiedSettlementSigStruct,
		updatePrice: bigint

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

	beforeEach(async function () {
		this.user_allocated = decimal(500n)
		this.hedger_allocated = decimal(300n)

		context = await loadFixture(initializeFixture)

		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(this.hedger_allocated, this.hedger_allocated)

		hedger2 = new Hedger(context, context.signers.hedger2)
		await hedger2.setup()
		await hedger2.setBalances(this.hedger_allocated, this.hedger_allocated)

		// Quote1 LONG sent
		quote1LongOpened = await context.viewFacetQuote.getQuote(await user.sendQuote())
		// Quote2 SHORT sent
		quantityShort = decimal(75n)
		quote2ShortOpened = await context.viewFacetQuote.getQuote(
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).quantity(quantityShort).build()),
		)

		// main force close setups
		await context.controlFacet.setForceCloseMinSigPeriod(10)
		await context.controlFacet.setForceCloseGapRatio((await context.viewFacetQuote.getQuote(quote1LongOpened.id)).symbolId, decimal(1n, 17))
	})

	describe("Normal Account", async function () {
		beforeEach(async function () {
			// Quote1 LONG locked
			await hedger.lockQuote(quote1LongOpened.id)
			await hedger.openPosition(quote1LongOpened.id)

			// Quote2 SHORT locked
			await hedger.lockQuote(quote2ShortOpened.id)
			await hedger.openPosition(quote2ShortOpened.id, limitOpenRequestBuilder().filledAmount(quantityShort).build())

			await user.requestToClosePosition(
				quote1LongOpened.id,
				limitCloseRequestBuilder()
					.quantityToClose(await getQuoteQuantity(context, quote1LongOpened.id))
					.closePrice(decimal(5n))
					.deadline((await getBlockTimestamp()) + 1000n)
					.build(),
			)
			await user.requestToClosePosition(
				quote2ShortOpened.id,
				limitCloseRequestBuilder()
					.quantityToClose(await getQuoteQuantity(context, quote2ShortOpened.id))
					.closePrice(decimal(5n))
					.deadline((await getBlockTimestamp()) + 1000n)
					.build(),
			)
			quote1LongOpened = await context.viewFacetQuote.getQuote(quote1LongOpened.id)
			quote2ShortOpened = await context.viewFacetQuote.getQuote(quote2ShortOpened.id)

			settlementSig = await getDummySettlementSig(
				0n,
				[150n],
				[
					{
						quoteId: quote2ShortOpened.id,
						currentPrice: decimal(7n),
						partyBUpnlIndex: 0n,
					} as QuoteSettlementDataStructOutput,
				],
			)
		})

		it("Should settle and forceClose the quote", async function () {
			const sigTimes = await prepareSigTimes(100n)
			const highLowSig = await getDummyHighLowPriceSig(
				sigTimes[0], // startTime
				sigTimes[1], // endTime
				0n, // lowest
				decimal(8n), // highest
				decimal(6n), // currentPrice
				decimal(5n), // averagePrice
				quote1LongOpened.symbolId, // symbolId
				decimal(150n), // upnlPartyB
				0n, // upnlPartyA
			)
			const settlementSigWithoutData = await getDummySettlementSig(0n, [150n], [])

			await expect(user.forceClosePosition(quote1LongOpened.id, highLowSig)).to.be.revertedWith(
				"LibQuote: PartyA should first exit its positions that are incurring losses",
			)

			await user.settleAndForceClosePosition(quote1LongOpened.id, highLowSig, settlementSig, [decimal(5n)])

			expect((await context.viewFacetQuote.getQuote(quote1LongOpened.id)).quoteStatus).to.be.eq(QuoteStatus.CLOSED)
			expect((await context.viewFacetQuote.getQuote(quote2ShortOpened.id)).openedPrice).to.be.eq(decimal(5n))
		})

		it("Should settle partyAs as expected", async function () {
			const sigTimes = await prepareSigTimes(100n)

			const updatePrice = decimal(5n)

			const balanceInfoBBefore = await hedger.getBalanceInfo(await user.getAddress())

			await context.settlementFacet.connect(hedger.signer).settleUpnl(settlementSig, [updatePrice], await user.getAddress())
			expect((await context.viewFacetQuote.getQuote(quote2ShortOpened.id)).openedPrice).to.be.eq(updatePrice)

			const balanceInfoBAfter = await hedger.getBalanceInfo(await user.getAddress())

			const settledUpnl = unDecimal((updatePrice - quote2ShortOpened.openedPrice) * quote2ShortOpened.quantity)
			expect(balanceInfoBAfter.allocatedBalances - balanceInfoBBefore.allocatedBalances).to.be.equal(settledUpnl)
		})

		describe("Settlement partyB restrictions (3-step flow)", function () {
			let quoteUser2WithHedger: QuoteStructOutput
			let quoteUserWithHedger2: QuoteStructOutput

			beforeEach(async function () {
				// Set up user2 with a quote against hedger
				user2 = new User(context, context.signers.user2)
				await user2.setup()
				await user2.setBalances(decimal(2000n), decimal(1000n), decimal(500n))

				// Give hedger and hedger2 additional funds for the new quotes
				await hedger.setBalances(decimal(500n), decimal(500n))
				await hedger2.setBalances(decimal(500n), decimal(500n))

				quoteUser2WithHedger = await context.viewFacetQuote.getQuote(
					await user2.sendQuote(
						limitQuoteRequestBuilder()
							.deadline((await getBlockTimestamp()) + 1000n)
							.build(),
					),
				)
				await hedger.lockQuote(quoteUser2WithHedger.id)
				await hedger.openPosition(
					quoteUser2WithHedger.id,
					limitOpenRequestBuilder().filledAmount(quoteUser2WithHedger.quantity).openPrice(quoteUser2WithHedger.requestedOpenPrice).build(),
				)

				// Set up a quote for user against hedger2
				quoteUserWithHedger2 = await context.viewFacetQuote.getQuote(
					await user.sendQuote(
						limitQuoteRequestBuilder()
							.deadline((await getBlockTimestamp()) + 1000n)
							.build(),
					),
				)
				await hedger2.lockQuote(quoteUserWithHedger2.id)
				await hedger2.openPosition(
					quoteUserWithHedger2.id,
					limitOpenRequestBuilder().filledAmount(quoteUserWithHedger2.quantity).openPrice(quoteUserWithHedger2.requestedOpenPrice).build(),
				)

				// Initialize force close on quote1 (user <-> hedger)
				const sigTimes = await prepareSigTimes(100n)
				const highLowSig = await getDummyHighLowPriceSig(
					sigTimes[0],
					sigTimes[1],
					0n,
					decimal(8n),
					decimal(6n),
					decimal(5n),
					quote1LongOpened.symbolId,
					decimal(150n),
					0n,
				)
				await context.forceCloseStepsFacet.initializeForceClose(quote1LongOpened.id, highLowSig)
			})

			it("Should revert when settling same non-cross partyB with multiple partyAs", async function () {
				// sig.partyB == hedger (same as force close quote), hedger is non-cross
				// sig.partyAs has 2 entries → reverts because non-cross requires exactly 1 partyA
				const sig = await getDummyUnifiedSettlementSig(
					await hedger.getAddress(),
					0n,
					[0n, 0n],
					[await user.getAddress(), await user2.getAddress()],
					[0n, 0n],
					[{ quoteId: quoteUser2WithHedger.id, currentPrice: decimal(7n), partyAIndex: 1 } as any],
				)
				await expect(
					context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, sig, [decimal(5n)]),
				).to.be.revertedWith("ForceActionsFacet: Non-cross partyB can only settle with forceClose partyA")
			})

			it("Should revert when settling same non-cross partyB with wrong single partyA", async function () {
				// sig.partyB == hedger (same as force close quote), hedger is non-cross
				// sig.partyAs[0] == user2 (not the force close quote's partyA) → reverts
				const sig = await getDummyUnifiedSettlementSig(
					await hedger.getAddress(),
					0n,
					[0n],
					[await user2.getAddress()],
					[0n],
					[{ quoteId: quoteUser2WithHedger.id, currentPrice: decimal(7n), partyAIndex: 0 } as any],
				)
				await expect(
					context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, sig, [decimal(5n)]),
				).to.be.revertedWith("ForceActionsFacet: Invalid partyA for non-cross settlement")
			})

			it("Should allow settling same non-cross partyB with correct partyA", async function () {
				// sig.partyB == hedger (same as force close quote), hedger is non-cross
				// sig.partyAs[0] == user (matches force close quote's partyA) → allowed
				const sig = await getDummyUnifiedSettlementSig(
					await hedger.getAddress(),
					0n,
					[0n],
					[await user.getAddress()],
					[0n],
					[{ quoteId: quote2ShortOpened.id, currentPrice: decimal(7n), partyAIndex: 0 } as any],
				)
				await expect(
					context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, sig, [decimal(5n)]),
				).not.to.be.reverted
			})

			it("Should allow settling a different partyB to fund partyA", async function () {
				// sig.partyB == hedger2 (different from force close quote's partyB = hedger)
				// isSamePartyB is false → no restriction, partyA is free to settle with other partyBs
				const sig = await getDummyUnifiedSettlementSig(
					await hedger2.getAddress(),
					0n,
					[0n],
					[await user.getAddress()],
					[0n],
					[{ quoteId: quoteUserWithHedger2.id, currentPrice: decimal(12n, 17), partyAIndex: 0 } as any],
				)
				await expect(
					context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, sig, [decimal(11n, 17)]),
				).not.to.be.reverted
			})
		})
	})

	describe("Cross PartyB", async function () {
		beforeEach(async function () {
			// prepare quotes and positions

			// prepare update prices
			updatePrice = decimal(5n)

			// Quote1 LONG opened
			await hedger.lockQuote(quote1LongOpened.id)
			await hedger.openPosition(quote1LongOpened.id)

			// Quote2 SHORT opened
			const quantityShort = decimal(75n)
			await hedger.lockQuote(quote2ShortOpened.id)
			await hedger.openPosition(quote2ShortOpened.id, limitOpenRequestBuilder().filledAmount(quantityShort).build())

			await migratePartyBToCross(context, hedger, [quote1LongOpened.id, quote2ShortOpened.id])

			await user.requestToClosePosition(
				quote1LongOpened.id,
				limitCloseRequestBuilder()
					.quantityToClose(await getQuoteQuantity(context, quote1LongOpened.id))
					.closePrice(decimal(5n))
					.deadline((await getBlockTimestamp()) + 1000n)
					.build(),
			)
			await user.requestToClosePosition(
				quote2ShortOpened.id,
				limitCloseRequestBuilder()
					.quantityToClose(await getQuoteQuantity(context, quote2ShortOpened.id))
					.closePrice(decimal(5n))
					.deadline((await getBlockTimestamp()) + 1000n)
					.build(),
			)
			quote1LongOpened = await context.viewFacetQuote.getQuote(quote1LongOpened.id)
			quote2ShortOpened = await context.viewFacetQuote.getQuote(quote2ShortOpened.id)

			sigTimes = await prepareSigTimes(100n)
			highLowSig = await getDummyHighLowPriceSig(
				sigTimes[0], // startTime
				sigTimes[1], // endTime
				0n, // lowest
				decimal(8n), // highest
				decimal(5n), // currentPrice
				decimal(5n), // averagePrice
				quote1LongOpened.symbolId, // symbolId
				decimal(150n), // upnlPartyB
				0n, // upnlPartyA
			)

			settlementSigCross = await getDummyUnifiedSettlementSig(
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

			// It can make a dead lock, where Party A want money to close position for B and B wants money to close position for A
			await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)
			await expect(await context.forceCloseStepsFacet.initializeForceClose(quote1LongOpened.id, highLowSig)).not.to.reverted
		})

		describe("Settlement guards", function () {
			it("Should revert settleUpnlForForceClose when partyB is in cross liquidation process", async function () {
				// Put partyB into cross liquidation "inProgress"
				await context.controlFacet.grantRole(context.signers.liquidator.address, ethers.keccak256(toUtf8Bytes("CLEARING_HOUSE_ROLE")))
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(await hedger.getAddress(), "0x", BigInt("-999999999999999999999999999999"), await getBlockTimestamp())

					await expect(context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, settlementSigCross, [updatePrice])).to.be.revertedWith(
						"LibSettlement: PartyB is in cross liquidation process",
					)
				})

			it("Should revert when quotesSettlementsData is empty or length mismatched", async function () {
				const sigEmpty = await getDummyUnifiedSettlementSig(await hedger.getAddress(), 0n, [], [await user.getAddress()], [0n], [])
				await expect(context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, sigEmpty, [])).to.be.revertedWith(
					"LibSettlement: Empty quotes array",
				)

				const sigOne = await getDummyUnifiedSettlementSig(
					await hedger.getAddress(),
					0n,
					[],
					[await user.getAddress()],
					[0n],
					[{ quoteId: quote2ShortOpened.id, currentPrice: decimal(7n), partyAIndex: 0 } as any],
				)
				await expect(context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, sigOne, [updatePrice, updatePrice])).to.be.revertedWith(
					"LibSettlement: Invalid prices length",
				)
			})

			it("Should revert when signature partyB does not match quote.partyB", async function () {
				await migratePartyBToCross(context, hedger2, [])

				// Wrong partyB inside sig (use any other address)
				const wrongPartyB = await hedger2.getAddress()

				const sig = await getDummyUnifiedSettlementSig(
					wrongPartyB, // <-- wrong
					0n,
					[],
					[await user.getAddress()],
					[0n],
					[{ quoteId: quote2ShortOpened.id, currentPrice: decimal(7n), partyAIndex: 0 } as any],
				)

				await expect(context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, sig, [updatePrice])).to.be.revertedWith(
					"LibSettlement: Invalid partyB for quote",
				)
			})
		})

		describe("Update Price", function () {
			it("Should revert when updatedPrice is out of allowed range", async function () {
				// Choose a currentPrice that is below openedPrice (so branch openedPrice > currentPrice)
				const currentPrice = quote2ShortOpened.openedPrice - decimal(1n)
				const sig = await getDummyUnifiedSettlementSig(
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
				// invalid: updatedPrice < currentPrice
				await expect(context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, sig, [currentPrice])).to.be.revertedWith(
					"LibSettlement: Updated price is out of range",
				)

				// invalid: updatedPrice >= openedPrice
				await expect(context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, sig, [quote2ShortOpened.openedPrice])).to.be.revertedWith(
					"LibSettlement: Updated price is out of range",
				)
			})
		})

		describe("Solvency Checks", function () {
			it("Should revert when PartyA is insolvent", async function () {
				const partyA = await user.getAddress()

				// Make PartyA insolvent: easiest is to set allocated very low then use a very negative uPnL in sig.
				// If your dummy sig helper interprets upnlPartyAs as int256, pass a big negative.
				const insolventUpnlA = BigInt("-999999999999999999999999999999")

				const sigInsolventA = await getDummyUnifiedSettlementSig(
					await hedger.getAddress(), // partyB
					0n, // upnlPartyB
					[], // upnlPartyBPerPartyA (empty for crossPartyB mode)
					[partyA], // partyAs
					[insolventUpnlA], // upnlPartyAs
					[
						{
							quoteId: quote2ShortOpened.id,
							currentPrice: decimal(7n),
							partyAIndex: 0,
						} as any,
					],
				)

				await expect(context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, sigInsolventA, [updatePrice])).to.be.revertedWith(
					"LibSettlement: PartyA is insolvent",
				)
			})
		})

		it("settles multiple quotes across two partyAs in cross partyB mode", async function () {
			user2 = new User(context, context.signers.user2)
			await user2.setup()
			await user2.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

			const extraQuoteUser2 = await context.viewFacetQuote.getQuote(
				await user2.sendQuote(
					limitQuoteRequestBuilder()
						.quantity(decimal(50n))
						.deadline((await getBlockTimestamp()) + 1000n)
						.build(),
				),
			)
			await hedger.lockQuote(extraQuoteUser2.id)
			await hedger.openPosition(
				extraQuoteUser2.id,
				limitOpenRequestBuilder().filledAmount(extraQuoteUser2.quantity).openPrice(extraQuoteUser2.requestedOpenPrice).build(),
			)

			const quote1 = await context.viewFacetQuote.getQuote(quote1LongOpened.id)
			const quote2 = await context.viewFacetQuote.getQuote(quote2ShortOpened.id)
			const quote3 = await context.viewFacetQuote.getQuote(extraQuoteUser2.id)

			const updatePrice1 = decimal(11n, 17) // price up for long
			const updatePrice2 = decimal(9n, 17) // price down for short
			const updatePrice3 = decimal(12n, 17) // price up for user2 long

			const settlementSigMulti = await getDummyUnifiedSettlementSig(
				await hedger.getAddress(), // partyB
				0n, // upnlPartyB
				[], // upnlPartyBPerPartyA (empty for crossPartyB mode)
				[await user.getAddress(), await user2.getAddress()], // partyAs
				[0n, 0n], // upnlPartyAs
				[
					{ quoteId: quote1LongOpened.id, currentPrice: updatePrice1, partyAIndex: 0 } as any,
					{ quoteId: quote2ShortOpened.id, currentPrice: updatePrice2, partyAIndex: 0 } as any,
					{ quoteId: extraQuoteUser2.id, currentPrice: updatePrice3, partyAIndex: 1 } as any,
				],
			)

			const crossBalanceBefore = await hedger.getBalanceInfo(ethers.ZeroAddress)
			const partyABalanceBefore = await user.getBalanceInfo()
			const partyABalanceBefore2 = await user2.getBalanceInfo()

			await expect(
				context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, settlementSigMulti, [updatePrice1, updatePrice2, updatePrice3]),
			).not.to.be.reverted

			const crossBalanceAfter = await hedger.getBalanceInfo(ethers.ZeroAddress)
			const partyABalanceAfter = await user.getBalanceInfo()
			const partyABalanceAfter2 = await user2.getBalanceInfo()

			const expectedSettle1 = unDecimal((updatePrice1 - quote1.openedPrice) * quote1.quantity)
			const expectedSettle2 = unDecimal((quote2.openedPrice - updatePrice2) * quote2.quantity)
			const expectedSettle3 = unDecimal((updatePrice3 - quote3.openedPrice) * quote3.quantity)
			const totalPayout = expectedSettle1 + expectedSettle2 + expectedSettle3

			expect(partyABalanceAfter.allocatedBalances - partyABalanceBefore.allocatedBalances).to.equal(expectedSettle1 + expectedSettle2)
			expect(partyABalanceAfter2.allocatedBalances - partyABalanceBefore2.allocatedBalances).to.equal(expectedSettle3)
			expect(crossBalanceBefore.allocatedBalances - crossBalanceAfter.allocatedBalances).to.equal(totalPayout)

			expect((await context.viewFacetQuote.getQuote(quote1LongOpened.id)).openedPrice).to.equal(updatePrice1)
			expect((await context.viewFacetQuote.getQuote(quote2ShortOpened.id)).openedPrice).to.equal(updatePrice2)
			expect((await context.viewFacetQuote.getQuote(extraQuoteUser2.id)).openedPrice).to.equal(updatePrice3)
		})

		it("increments partyA and cross partyB nonces on settleUpnlForForceClose", async function () {
			const partyA = await user.getAddress()
			const partyB = await hedger.getAddress()

			const beforeNonceA = await context.viewFacet.nonceOfPartyA(partyA)
			const beforeNonceB = await context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress)
			const beforeNonceBPartyA = await context.viewFacet.nonceOfPartyB(partyB, partyA)

			await expect(context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, settlementSigCross, [updatePrice])).not.to.be.reverted

			const afterNonceA = await context.viewFacet.nonceOfPartyA(partyA)
			const afterNonceB = await context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress)
			const afterNonceBPartyA = await context.viewFacet.nonceOfPartyB(partyB, partyA)

			expect(afterNonceA).to.equal(beforeNonceA + 1n)
			expect(afterNonceB).to.equal(beforeNonceB + 1n)
			expect(afterNonceBPartyA).to.equal(beforeNonceBPartyA + 1n)
		})

		it("Should settle and forceClose the quote in cross partyB mode", async function () {
			const balanceInfoCrossB = await hedger.getBalanceInfo(ethers.ZeroAddress)
			const balanceInfoUserBefore = await user.getBalanceInfo()

			await expect(context.forceCloseStepsFacet.settleUpnlForForceClose(quote1LongOpened.id, settlementSigCross, [updatePrice])).not.to.be.reverted

			const balanceInfoSettlementCrossSettledB = await hedger.getBalanceInfo(ethers.ZeroAddress)
			const balanceInfoUserAfter = await user.getBalanceInfo()

			// settlement amount check
			const settledAmount = unDecimal((updatePrice - quote2ShortOpened.openedPrice) * quote2ShortOpened.quantity)
			expect(balanceInfoSettlementCrossSettledB.allocatedBalances - balanceInfoCrossB.allocatedBalances).to.be.equal(settledAmount)
			expect(balanceInfoUserBefore.allocatedBalances - balanceInfoUserAfter.allocatedBalances).to.be.equal(settledAmount)
			expect((await context.viewFacetQuote.getQuote(quote2ShortOpened.id)).openedPrice).to.be.eq(updatePrice)

			// force close
			await expect(context.forceCloseStepsFacet.finalizeForceClose(quote1LongOpened.id, await getDummyPairUpnlAndPriceSig(decimal(5n), 0n, decimal(150n)))).not.to.be.reverted
			expect((await context.viewFacetQuote.getQuote(quote1LongOpened.id)).quoteStatus).to.be.eq(QuoteStatus.CLOSED)
		})
	})
}
