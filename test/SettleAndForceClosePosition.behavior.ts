import { expect } from "chai"
import { toUtf8Bytes } from "ethers"
import {loadFixture, time} from "./helpers/network-helpers"

import type {
	HighLowPriceSigStruct,
	MasterAccountQuoteSettlementDataStructOutput,
	MasterAccountSettlementSigStruct,
	QuoteSettlementDataStructOutput,
	QuoteStructOutput,
	SettlementSigStruct,
} from "../src/types/contracts/interfaces/ISymmio"
import { initializeFixture } from "./Initialize.fixture"
import { PositionType, QuoteStatus } from "./models/Enums"
import { Hedger } from "./models/Hedger"
import { RunContext } from "./models/RunContext"
import { User } from "./models/User"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest"
import { decimal, getBlockTimestamp, getQuoteQuantity, unDecimal } from "./utils/Common"
import {
	getDummyCrossLiquidationSig,
	getDummyCrossSettlementSig,
	getDummyHighLowPriceSig,
	getDummySettlementSig
} from "./utils/SignatureUtils"
import {initializeFixture} from "./Initialize.fixture"
import {ethers} from "./helpers/hardhat-connection"
import {toUtf8Bytes} from "ethers"
import {PositionType, QuoteStatus} from "./models/Enums"
import {Hedger} from "./models/Hedger"
import {RunContext} from "./models/RunContext"
import {User} from "./models/User"
import {limitCloseRequestBuilder} from "./models/requestModels/CloseRequest"
import {limitQuoteRequestBuilder} from "./models/requestModels/QuoteRequest"
import {decimal, getBlockTimestamp, getQuoteQuantity,} from "./utils/Common"
import {getDummyHighLowPriceSig, getDummySettlementSig} from "./utils/SignatureUtils"
import type { QuoteStructOutput} from "../src/types/contracts/interfaces/ISymmio"
import {limitOpenRequestBuilder} from "./models/requestModels/OpenRequest"
import type { QuoteSettlementDataStructOutput} from "../src/types/contracts/facets/Settlement/ISettlementFacet"
import {expect} from "chai"

export function shouldBehaveLikeSettleAndForceClosePosition(): void {
	let user: User, hedger: Hedger, hedger2: Hedger, user2: User
	let context: RunContext
	let quote1LongOpened: QuoteStructOutput, quote2ShortOpened: QuoteStructOutput
	let quantityShort: bigint

	let sigTimes,
		highLowSig: HighLowPriceSigStruct,
		settlementSig: SettlementSigStruct,
		settlementSigCross: MasterAccountSettlementSigStruct,
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
	})

	describe("Master Account", async function () {
		beforeEach(async function () {
			// switch hedger to master account mode
			await context.controlFacet.setMasterAccountEnabled(true)
			await context.accountFacet.connect(hedger.signer).activateMasterAccountMode()

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

			settlementSigCross = await getDummyCrossSettlementSig(
				[0n],
				0n,
				await hedger.getAddress(),
				[await user.getAddress()],
				[
					{
						quoteId: quote2ShortOpened.id,
						currentPrice: decimal(7n),
					} as MasterAccountQuoteSettlementDataStructOutput,
				],
			)

			// It can make a dead lock, where Party A want money to close position for B and B wants money to close position for A
			await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)
			await expect(await context.forceActionsFacet.initializeMasterAccountForceClose(quote1LongOpened.id, highLowSig)).not.to.reverted
		})

		describe("Settlement guards", function () {
			it("Should revert settleUpnlMasterAccount when partyB is in cross liquidation process", async function () {
				// Put partyB into cross liquidation "inProgress"
				await context.controlFacet.grantRole(context.signers.liquidator.address, ethers.keccak256(toUtf8Bytes("CLEARING_HOUSE_ROLE")))
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(await hedger.getAddress(), await getDummyCrossLiquidationSig(undefined, BigInt("-999999999999999999999999999999")))

					await expect(context.forceActionsFacet.settleUpnlMasterAccount(quote1LongOpened.id, settlementSigCross, [updatePrice])).to.be.revertedWith(
						"LibSettlement: PartyB is in cross liquidation process",
					)
				})

				it("Should revert when quotesSettlementsData is empty or length mismatched", async function () {
					const sigEmpty = await getDummyCrossSettlementSig([0n], 0n, await hedger.getAddress(), [await user.getAddress()], [])
					await expect(context.forceActionsFacet.settleUpnlMasterAccount(quote1LongOpened.id, sigEmpty, [])).to.be.revertedWith(
						"LibSettlement: Invalid length",
					)

					const sigOne = await getDummyCrossSettlementSig(
						[0n],
						0n,
						await hedger.getAddress(),
						[await user.getAddress()],
						[{ quoteId: quote2ShortOpened.id, currentPrice: decimal(7n) } as any],
					)
					await expect(context.forceActionsFacet.settleUpnlMasterAccount(quote1LongOpened.id, sigOne, [updatePrice, updatePrice])).to.be.revertedWith(
						"LibSettlement: Invalid length",
					)
				})

				it("Should revert when signature partyB does not match quote.partyB", async function () {
					await context.accountFacet.connect(hedger2.signer).activateMasterAccountMode()

					// Wrong partyB inside sig (use any other address)
					const wrongPartyB = await hedger2.getAddress()

					const sig = await getDummyCrossSettlementSig(
						[0n],
						0n,
						wrongPartyB, // <-- wrong
						[await user.getAddress()],
						[{ quoteId: quote2ShortOpened.id, currentPrice: decimal(7n) } as any],
					)

					await expect(context.forceActionsFacet.settleUpnlMasterAccount(quote1LongOpened.id, sig, [updatePrice])).to.be.revertedWith(
						"LibSettlement: Invalid quote",
					)
				})


			it("Should revert when quotesSettlementsData is empty or length mismatched", async function () {
				const sigEmpty = await getDummyCrossSettlementSig([0n], 0n, await hedger.getAddress(), [await user.getAddress()], [])
				await expect(context.forceActionsFacet.settleUpnlMasterAccount(quote1LongOpened.id, sigEmpty, [])).to.be.revertedWith(
					"LibSettlement: Invalid length",
				)

				const sigOne = await getDummyCrossSettlementSig(
					[0n],
					0n,
					await hedger.getAddress(),
					[await user.getAddress()],
					[{ quoteId: quote2ShortOpened.id, currentPrice: decimal(7n) } as any],
				)
				await expect(context.forceActionsFacet.settleUpnlMasterAccount(quote1LongOpened.id, sigOne, [updatePrice, updatePrice])).to.be.revertedWith(
					"LibSettlement: Invalid length",
				)
			})

			it("Should revert when signature partyB does not match quote.partyB", async function () {
				await context.accountFacet.connect(hedger2.signer).activateMasterAccountMode()

				// Wrong partyB inside sig (use any other address)
				const wrongPartyB = await hedger2.getAddress()

				const sig = await getDummyCrossSettlementSig(
					[0n],
					0n,
					wrongPartyB, // <-- wrong
					[await user.getAddress()],
					[{ quoteId: quote2ShortOpened.id, currentPrice: decimal(7n) } as any],
				)

				await expect(context.forceActionsFacet.settleUpnlMasterAccount(quote1LongOpened.id, sig, [updatePrice])).to.be.revertedWith(
					"LibSettlement: Invalid quote",
				)
			})
		})

		describe("Update Price", function () {
			it("Should revert when updatedPrice is out of allowed range", async function () {
				// Choose a currentPrice that is below openedPrice (so branch openedPrice > currentPrice)
				const currentPrice = quote2ShortOpened.openedPrice - decimal(1n)
				const sig = await getDummyCrossSettlementSig(
					[0n],
					0n,
					await hedger.getAddress(),
					[await user.getAddress()],
					[
						{
							quoteId: quote2ShortOpened.id,
							currentPrice: decimal(7n),
						} as MasterAccountQuoteSettlementDataStructOutput,
					],
				)
				// invalid: updatedPrice < currentPrice
				await expect(context.forceActionsFacet.settleUpnlMasterAccount(quote1LongOpened.id, sig, [currentPrice])).to.be.revertedWith(
					"LibSettlement: Updated price is out of range",
				)

				// invalid: updatedPrice >= openedPrice
				await expect(context.forceActionsFacet.settleUpnlMasterAccount(quote1LongOpened.id, sig, [quote2ShortOpened.openedPrice])).to.be.revertedWith(
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

				const sigInsolventA = await getDummyCrossSettlementSig(
					[insolventUpnlA],
					0n,
					await hedger.getAddress(),
					[partyA],
					[
						{
							quoteId: quote2ShortOpened.id,
							currentPrice: decimal(7n),
						} as MasterAccountQuoteSettlementDataStructOutput,
					],
				)

				await expect(context.forceActionsFacet.settleUpnlMasterAccount(quote1LongOpened.id, sigInsolventA, [updatePrice])).to.be.revertedWith(
					"LibSettlement: PartyA is insolvent",
				)
			})
		})

		it("settles multiple quotes across two partyAs in master account mode", async function () {
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

			const settlementSigMulti = await getDummyCrossSettlementSig(
				[0n, 0n],
				0n,
				await hedger.getAddress(),
				[await user.getAddress(), await user2.getAddress()],
				[
					{ quoteId: quote1LongOpened.id, currentPrice: updatePrice1 } as MasterAccountQuoteSettlementDataStructOutput,
					{ quoteId: quote2ShortOpened.id, currentPrice: updatePrice2 } as MasterAccountQuoteSettlementDataStructOutput,
					{ quoteId: extraQuoteUser2.id, currentPrice: updatePrice3 } as MasterAccountQuoteSettlementDataStructOutput,
				],
			)

			const masterBalanceBefore = await hedger.getBalanceInfo(ethers.ZeroAddress)
			const partyABalanceBefore = await user.getBalanceInfo()
			const partyABalanceBefore2 = await user2.getBalanceInfo()

			await expect(
				context.forceActionsFacet.settleUpnlMasterAccount(quote1LongOpened.id, settlementSigMulti, [updatePrice1, updatePrice2, updatePrice3]),
			).not.to.be.reverted

			const masterBalanceAfter = await hedger.getBalanceInfo(ethers.ZeroAddress)
			const partyABalanceAfter = await user.getBalanceInfo()
			const partyABalanceAfter2 = await user2.getBalanceInfo()

			const expectedSettle1 = unDecimal((updatePrice1 - quote1.openedPrice) * quote1.quantity)
			const expectedSettle2 = unDecimal((quote2.openedPrice - updatePrice2) * quote2.quantity)
			const expectedSettle3 = unDecimal((updatePrice3 - quote3.openedPrice) * quote3.quantity)
			const totalPayout = expectedSettle1 + expectedSettle2 + expectedSettle3

			expect(partyABalanceAfter.allocatedBalances - partyABalanceBefore.allocatedBalances).to.equal(expectedSettle1 + expectedSettle2)
			expect(partyABalanceAfter2.allocatedBalances - partyABalanceBefore2.allocatedBalances).to.equal(expectedSettle3)
			expect(masterBalanceBefore.allocatedBalances - masterBalanceAfter.allocatedBalances).to.equal(totalPayout)

			expect((await context.viewFacetQuote.getQuote(quote1LongOpened.id)).openedPrice).to.equal(updatePrice1)
			expect((await context.viewFacetQuote.getQuote(quote2ShortOpened.id)).openedPrice).to.equal(updatePrice2)
			expect((await context.viewFacetQuote.getQuote(extraQuoteUser2.id)).openedPrice).to.equal(updatePrice3)
		})

		it("increments partyA and master partyB nonces on settleUpnlMasterAccount", async function () {
			const partyA = await user.getAddress()
			const partyB = await hedger.getAddress()

			const beforeNonceA = await context.viewFacet.nonceOfPartyA(partyA)
			const beforeNonceB = await context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress)
			const beforeNonceBPartyA = await context.viewFacet.nonceOfPartyB(partyB, partyA)

			await expect(context.forceActionsFacet.settleUpnlMasterAccount(quote1LongOpened.id, settlementSigCross, [updatePrice])).not.to.be.reverted

			const afterNonceA = await context.viewFacet.nonceOfPartyA(partyA)
			const afterNonceB = await context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress)
			const afterNonceBPartyA = await context.viewFacet.nonceOfPartyB(partyB, partyA)

			expect(afterNonceA).to.equal(beforeNonceA + 1n)
			expect(afterNonceB).to.equal(beforeNonceB + 1n)
			expect(afterNonceBPartyA).to.equal(beforeNonceBPartyA + 1n)
		})

		it("Should settle and forceClose the quote in master account mode", async function () {
			const balanceInfoMasterB = await hedger.getBalanceInfo(ethers.ZeroAddress)
			const balanceInfoUserBefore = await user.getBalanceInfo()

			await expect(context.forceActionsFacet.settleUpnlMasterAccount(quote1LongOpened.id, settlementSigCross, [updatePrice])).not.to.be.reverted

			const balanceInfoSettlementMasterSettledB = await hedger.getBalanceInfo(ethers.ZeroAddress)
			const balanceInfoUserAfter = await user.getBalanceInfo()

			// settlement amount check
			const settledAmount = unDecimal((updatePrice - quote2ShortOpened.openedPrice) * quote2ShortOpened.quantity)
			expect(balanceInfoSettlementMasterSettledB.allocatedBalances - balanceInfoMasterB.allocatedBalances).to.be.equal(settledAmount)
			expect(balanceInfoUserBefore.allocatedBalances - balanceInfoUserAfter.allocatedBalances).to.be.equal(settledAmount)
			expect((await context.viewFacetQuote.getQuote(quote2ShortOpened.id)).openedPrice).to.be.eq(updatePrice)

			// force close
			await expect(context.forceActionsFacet.finalizeMasterAccountForceClose(quote1LongOpened.id)).not.to.be.reverted
			expect((await context.viewFacetQuote.getQuote(quote1LongOpened.id)).quoteStatus).to.be.eq(QuoteStatus.CLOSED)
		})
	})
}
