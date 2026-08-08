import { expect } from "chai"
import { ZeroAddress } from "ethers"

import type { UnifiedQuoteSettlementDataStruct } from "../src/types/facets/Settlement/ISettlementFacet.js"
import { ISymmio__factory } from "../src/types/factories/core/interfaces/ISymmio__factory.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { PositionType } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp, unDecimal } from "./utils/Common.js"
import { migratePartyBToCross } from "./utils/CrossPartyB.js"
import { getDummySingleUpnlSig, getDummyUnifiedSettlementSig } from "./utils/SignatureUtils.js"

// SharedEvents.BalanceChangeType.SETTLEMENT_PNL_IN
const SETTLEMENT_PNL_IN = 18n

export function shouldBehaveLikeSettlementUnified(): void {
	let context: RunContext, user: User, user2: User, hedger: Hedger, hedger2: Hedger
	let longHedger1: bigint, shortHedger1: bigint, shortHedger2: bigint, shortClosePending: bigint, longClosed: bigint, longHedger1User2: bigint

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		this.user_allocated = decimal(700n)
		this.hedger_allocated = decimal(4000n)

		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

		user2 = new User(context, context.signers.user2)
		await user2.setup()
		await user2.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(this.hedger_allocated, this.hedger_allocated)

		hedger2 = new Hedger(context, context.signers.hedger2)
		await hedger2.setup()
		await hedger2.setBalances(this.hedger_allocated, this.hedger_allocated)

		longHedger1 = await user.sendQuote()
		await hedger.lockQuote(longHedger1)
		await hedger.openPosition(longHedger1)

		longHedger1User2 = await user2.sendQuote()
		await hedger.lockQuote(longHedger1User2)
		await hedger.openPosition(longHedger1User2)

		shortHedger1 = await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
		await hedger.lockQuote(shortHedger1)
		await hedger.openPosition(shortHedger1)

		shortHedger2 = await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
		await hedger2.lockQuote(shortHedger2)
		await hedger2.openPosition(shortHedger2)

		shortClosePending = await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
		await hedger.lockQuote(shortClosePending)
		await hedger.openPosition(shortClosePending)
		await user.requestToClosePosition(shortClosePending)

		longClosed = await user.sendQuote()
		await hedger.lockQuote(longClosed)
		await hedger.openPosition(longClosed)
		await user.requestToClosePosition(longClosed)
		await hedger.fillCloseRequest(longClosed)
	})

	describe("Normal Mode (non-crossPartyB)", function () {
		it("Should fail when partyB actions paused", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pausePartyBActions()
			const sig = await getDummyUnifiedSettlementSig(await hedger.getAddress(), 0n, [0n], [await user.getAddress()], [0n], [])
			await expect(hedger.settleUpnlUnified([], sig)).to.be.revertedWith("Pausable: PartyB actions paused")
		})

		it("Should fail when quotes array is empty", async function () {
			const sig = await getDummyUnifiedSettlementSig(await hedger.getAddress(), 0n, [0n], [await user.getAddress()], [0n], [])
			await expect(hedger.settleUpnlUnified([], sig)).to.be.revertedWith("LibSettlement: Empty quotes array")
		})

		it("Should fail to settle a quote whose symbol is frozen", async function () {
			const partyA = await user.getAddress()
			const partyB = await hedger.getAddress()
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(1, decimal(4n), now - 1n)

			const sig = await getDummyUnifiedSettlementSig(
				partyB,
				0n,
				[0n],
				[partyA],
				[0n],
				[{ quoteId: longHedger1, currentPrice: decimal(5n, 17), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct],
			)
			await expect(hedger.settleUpnlUnified([decimal(6n, 17)], sig)).to.be.revertedWith("LibSymbolAdjustment: Symbol is frozen")
		})

		it("Should fail when partyAs array is empty", async function () {
			const sig = await getDummyUnifiedSettlementSig(
				await hedger.getAddress(),
				0n,
				[],
				[],
				[],
				[{ quoteId: longHedger1, currentPrice: decimal(5n, 17), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct],
			)
			await expect(hedger.settleUpnlUnified([decimal(6n, 17)], sig)).to.be.revertedWith("LibSettlement: Empty partyAs array")
		})

		it("Should fail when upnlPartyBPerPartyA length doesn't match partyAs length in normal mode", async function () {
			const sig = await getDummyUnifiedSettlementSig(
				await hedger.getAddress(),
				0n,
				[], // Empty - should have same length as partyAs
				[await user.getAddress()],
				[0n],
				[{ quoteId: longHedger1, currentPrice: decimal(5n, 17), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct],
			)
			await expect(hedger.settleUpnlUnified([decimal(6n, 17)], sig)).to.be.revertedWith("LibSettlement: Invalid upnlPartyBPerPartyA length")
		})

		it("Should fail when partyA is insolvent", async function () {
			const sig = await getDummyUnifiedSettlementSig(
				await hedger.getAddress(),
				0n,
				[0n],
				[await user.getAddress()],
				[decimal(600n) * -1n], // PartyA has large negative UPNL
				[{ quoteId: longHedger1, currentPrice: decimal(5n, 17), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct],
			)
			await expect(hedger.settleUpnlUnified([decimal(6n, 17)], sig)).to.be.revertedWith("LibSettlement: PartyA is insolvent")
		})

		it("Should fail when partyB is insolvent", async function () {
			const sig = await getDummyUnifiedSettlementSig(
				await hedger.getAddress(),
				0n,
				[decimal(10000n) * -1n], // PartyB has large negative UPNL
				[await user.getAddress()],
				[0n],
				[{ quoteId: shortHedger1, currentPrice: 0n, partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct],
			)
			await expect(hedger.settleUpnlUnified([decimal(5n, 17)], sig)).to.be.revertedWith("LibSettlement: PartyB is insolvent for partyA")
		})

		it("Should fail when sender doesn't have position with any partyA", async function () {
			const sig = await getDummyUnifiedSettlementSig(
				await hedger.getAddress(),
				0n,
				[0n],
				[await user2.getAddress()],
				[0n],
				[{ quoteId: longHedger1User2, currentPrice: decimal(5n, 17), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct],
			)
			// hedger2 has no position with user2 for this quote (quote belongs to hedger)
			await expect(hedger2.settleUpnlUnified([decimal(6n, 17)], sig)).to.be.revertedWith("LibSettlement: Sender should have a position with partyA")
		})

		it("Should fail when quote belongs to different partyB", async function () {
			const sig = await getDummyUnifiedSettlementSig(
				await hedger.getAddress(), // Signature says partyB is hedger
				0n,
				[0n],
				[await user.getAddress()],
				[0n],
				[{ quoteId: shortHedger2, currentPrice: 0n, partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct], // But quote belongs to hedger2
			)
			await expect(hedger.settleUpnlUnified([decimal(5n, 17)], sig)).to.be.revertedWith("LibSettlement: Invalid partyB for quote")
		})

		it("Should fail when partyAIndex is out of bounds", async function () {
			const sig = await getDummyUnifiedSettlementSig(
				await hedger.getAddress(),
				0n,
				[0n],
				[await user.getAddress()],
				[0n],
				[{ quoteId: longHedger1, currentPrice: decimal(5n, 17), partyAIndex: 5n } as UnifiedQuoteSettlementDataStruct], // Index 5 but only 1 partyA
			)
			await expect(hedger.settleUpnlUnified([decimal(6n, 17)], sig)).to.be.revertedWith("LibSettlement: Invalid partyAIndex")
		})

		it("Should fail when quote has invalid state (closed)", async function () {
			const sig = await getDummyUnifiedSettlementSig(
				await hedger.getAddress(),
				0n,
				[0n],
				[await user.getAddress()],
				[0n],
				[{ quoteId: longClosed, currentPrice: decimal(5n, 17), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct],
			)
			await expect(hedger.settleUpnlUnified([decimal(6n, 17)], sig)).to.be.revertedWith("LibQuote: Invalid state")
		})

		it("Should fail when updated price is out of range", async function () {
			const sig = await getDummyUnifiedSettlementSig(
				await hedger.getAddress(),
				0n,
				[0n],
				[await user.getAddress()],
				[0n],
				[{ quoteId: longHedger1, currentPrice: decimal(2n), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct],
			)
			await expect(hedger.settleUpnlUnified([decimal(0n)], sig)).to.be.revertedWith("LibSettlement: Updated price is out of range")
		})

		it("Should fail when partyB is in liquidation process", async function () {
			await hedger.liquidate(await user.getAddress(), (await getDummySingleUpnlSig(decimal(10000n) * -1n)) as any)
			const sig = await getDummyUnifiedSettlementSig(
				await hedger.getAddress(),
				0n,
				[0n],
				[await user.getAddress()],
				[0n],
				[{ quoteId: longHedger1, currentPrice: decimal(5n, 17), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct],
			)
			await expect(hedger.settleUpnlUnified([decimal(6n, 17)], sig)).to.be.revertedWith("PartyBState: PartyB is in liquidation")
		})

		it("Should settle successfully for single partyA", async function () {
			const partyA = await user.getAddress()
			const partyB = await hedger.getAddress()
			const quoteBefore = await context.viewFacetQuote.getQuote(longHedger1)
			const updatedPrice = decimal(6n, 17)

			const sig = await getDummyUnifiedSettlementSig(
				partyB,
				0n,
				[0n],
				[partyA],
				[0n],
				[{ quoteId: longHedger1, currentPrice: decimal(5n, 17), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct],
			)

			const partyABalanceBefore = await user.getBalanceInfo()
			const partyBBalanceBefore = await hedger.getBalanceInfo(partyA)

			await hedger.settleUpnlUnified([updatedPrice], sig)

			const partyABalanceAfter = await user.getBalanceInfo()
			const partyBBalanceAfter = await hedger.getBalanceInfo(partyA)

			const expectedLoss = unDecimal((quoteBefore.openedPrice - updatedPrice) * quoteBefore.quantity)
			expect(partyABalanceBefore.allocatedBalances - partyABalanceAfter.allocatedBalances).to.be.eq(expectedLoss)
			expect(partyBBalanceAfter.allocatedBalances - partyBBalanceBefore.allocatedBalances).to.be.eq(expectedLoss)
			expect((await context.viewFacetQuote.getQuote(longHedger1)).openedPrice).to.be.eq(updatedPrice)
		})

		it("Should settle successfully for multiple partyAs", async function () {
			const partyA1 = await user.getAddress()
			const partyA2 = await user2.getAddress()
			const partyB = await hedger.getAddress()

			const beforeNoncePartyA1 = await context.viewFacet.nonceOfPartyA(partyA1)
			const beforeNoncePartyA2 = await context.viewFacet.nonceOfPartyA(partyA2)
			const beforeNoncePartyB_A1 = await context.viewFacet.nonceOfPartyB(partyB, partyA1)
			const beforeNoncePartyB_A2 = await context.viewFacet.nonceOfPartyB(partyB, partyA2)

			const quote1 = await context.viewFacetQuote.getQuote(shortHedger1)
			const quote2 = await context.viewFacetQuote.getQuote(longHedger1User2)

			const partyA1BalanceBefore = await user.getBalanceInfo()
			const partyA2BalanceBefore = await user2.getBalanceInfo()
			const partyBBalanceA1Before = await hedger.getBalanceInfo(partyA1)
			const partyBBalanceA2Before = await hedger.getBalanceInfo(partyA2)

			const sig = await getDummyUnifiedSettlementSig(
				partyB,
				0n,
				[0n, 0n], // Per-partyA UPNLs for normal mode
				[partyA1, partyA2],
				[0n, 0n],
				[
					{ quoteId: shortHedger1, currentPrice: 0n, partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct,
					{ quoteId: longHedger1User2, currentPrice: decimal(5n, 17), partyAIndex: 1n } as UnifiedQuoteSettlementDataStruct,
				],
			)

			await hedger.settleUpnlUnified([decimal(5n, 17), decimal(6n, 17)], sig)

			// Verify nonces updated for both partyAs
			expect(await context.viewFacet.nonceOfPartyA(partyA1)).to.be.eq(beforeNoncePartyA1 + 1n)
			expect(await context.viewFacet.nonceOfPartyA(partyA2)).to.be.eq(beforeNoncePartyA2 + 1n)
			expect(await context.viewFacet.nonceOfPartyB(partyB, partyA1)).to.be.eq(beforeNoncePartyB_A1 + 1n)
			expect(await context.viewFacet.nonceOfPartyB(partyB, partyA2)).to.be.eq(beforeNoncePartyB_A2 + 1n)

			// Verify prices updated
			expect((await context.viewFacetQuote.getQuote(shortHedger1)).openedPrice).to.be.eq(decimal(5n, 17).toString())
			expect((await context.viewFacetQuote.getQuote(longHedger1User2)).openedPrice).to.be.eq(decimal(6n, 17).toString())

			// Verify balance changes for partyA1 (short quote settles from 1e18 to 0.5e18 -> partyA gains)
			// SHORT settlement: (openedPrice - updatedPrice) * openAmount / 1e18 = (1e18 - 0.5e18) * 100e18 / 1e18 = 50e18
			const expectedSettleA1 = unDecimal((quote1.openedPrice - decimal(5n, 17)) * quote1.quantity)
			const partyA1BalanceAfter = await user.getBalanceInfo()
			expect(partyA1BalanceAfter.allocatedBalances - partyA1BalanceBefore.allocatedBalances).to.be.eq(expectedSettleA1)

			// Verify balance changes for partyA2 (long quote settles from 1e18 to 0.6e18 -> partyA2 loses)
			// LONG settlement: (updatedPrice - openedPrice) * openAmount / 1e18 = (0.6e18 - 1e18) * 100e18 / 1e18 = -40e18
			const expectedSettleA2 = unDecimal((decimal(6n, 17) - quote2.openedPrice) * quote2.quantity)
			const partyA2BalanceAfter = await user2.getBalanceInfo()
			expect(partyA2BalanceAfter.allocatedBalances - partyA2BalanceBefore.allocatedBalances).to.be.eq(expectedSettleA2)

			// Verify partyB balance changes per partyA
			const partyBBalanceA1After = await hedger.getBalanceInfo(partyA1)
			expect(partyBBalanceA1Before.allocatedBalances - partyBBalanceA1After.allocatedBalances).to.be.eq(expectedSettleA1)
			const partyBBalanceA2After = await hedger.getBalanceInfo(partyA2)
			expect(partyBBalanceA2Before.allocatedBalances - partyBBalanceA2After.allocatedBalances).to.be.eq(expectedSettleA2)
		})

		it("Allows a different partyB caller to settle for another partyB (partyA funding without legacy settleUpnl)", async function () {
			const partyA = await user.getAddress()

			const quoteBefore = await context.viewFacetQuote.getQuote(shortHedger2)
			const updatedPrice = decimal(5n, 17) // 0.5

			const sig = await getDummyUnifiedSettlementSig(
				await hedger2.getAddress(), // settle for hedger2
				0n,
				[0n], // normal-mode requires per-partyA uPNL
				[partyA],
				[0n],
				[{ quoteId: shortHedger2, currentPrice: 0n, partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct],
			)

			const partyABalanceBefore = await user.getBalanceInfo()
			const partyB2BalanceBefore = await hedger2.getBalanceInfo(partyA)

			// Caller is hedger (different from sig.partyB=hedger2) but hedger has positions with partyA, so this should succeed.
			await hedger.settleUpnlUnified([updatedPrice], sig)

			const partyABalanceAfter = await user.getBalanceInfo()
			const partyB2BalanceAfter = await hedger2.getBalanceInfo(partyA)

			const expectedProfitForPartyA = unDecimal((quoteBefore.openedPrice - updatedPrice) * quoteBefore.quantity)
			expect(partyABalanceAfter.allocatedBalances - partyABalanceBefore.allocatedBalances).to.eq(expectedProfitForPartyA)
			expect(partyB2BalanceBefore.allocatedBalances - partyB2BalanceAfter.allocatedBalances).to.eq(expectedProfitForPartyA)
			expect((await context.viewFacetQuote.getQuote(shortHedger2)).openedPrice).to.eq(updatedPrice)
		})
	})

	describe("Cross PartyB Mode", function () {
		beforeEach(async function () {
			// Migrate hedger to cross partyB mode
			await migratePartyBToCross(context, hedger, [longHedger1, shortHedger1, shortClosePending, longHedger1User2])
		})

		it("Should settle successfully for single partyA in cross partyB mode", async function () {
			const partyA = await user.getAddress()
			const partyB = await hedger.getAddress()
			const quoteBefore = await context.viewFacetQuote.getQuote(longHedger1)
			const updatedPrice = decimal(6n, 17)

			// In cross partyB mode, use aggregated UPNL (upnlPartyB), not per-partyA
			const sig = await getDummyUnifiedSettlementSig(
				partyB,
				0n, // Aggregated UPNL for partyB
				[], // Empty for cross partyB mode
				[partyA],
				[0n],
				[{ quoteId: longHedger1, currentPrice: decimal(5n, 17), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct],
			)

			const partyABalanceBefore = await user.getBalanceInfo()
			const partyBBalanceBefore = await hedger.getBalanceInfoCrossPartyB()
			const expectedLoss = unDecimal((quoteBefore.openedPrice - updatedPrice) * quoteBefore.quantity)
			const symmio = ISymmio__factory.connect(await context.settlementFacet.getAddress(), context.signers.hedger)

			await expect(context.settlementFacet.connect(context.signers.hedger).settleUpnlUnified(sig, [updatedPrice]))
				.to.emit(symmio, "BalanceChangePartyB")
				.withArgs(partyB, ZeroAddress, expectedLoss, SETTLEMENT_PNL_IN)

			const partyABalanceAfter = await user.getBalanceInfo()
			const partyBBalanceAfter = await hedger.getBalanceInfoCrossPartyB()

			expect(partyABalanceBefore.allocatedBalances - partyABalanceAfter.allocatedBalances).to.be.eq(expectedLoss)
			// In cross partyB mode, balance is at address(0)
			expect(partyBBalanceAfter.allocatedBalances - partyBBalanceBefore.allocatedBalances).to.be.eq(expectedLoss)
			expect((await context.viewFacetQuote.getQuote(longHedger1)).openedPrice).to.be.eq(updatedPrice)
		})

		it("Should settle successfully for multiple partyAs in cross partyB mode", async function () {
			const partyA1 = await user.getAddress()
			const partyA2 = await user2.getAddress()
			const partyB = await hedger.getAddress()

			const beforeCrossNonce = await context.viewFacet.nonceOfPartyB(partyB, "0x0000000000000000000000000000000000000000")
			const beforeNoncePartyB_A1 = await context.viewFacet.nonceOfPartyB(partyB, partyA1)
			const beforeNoncePartyB_A2 = await context.viewFacet.nonceOfPartyB(partyB, partyA2)

			const quote1 = await context.viewFacetQuote.getQuote(shortHedger1)
			const quote2 = await context.viewFacetQuote.getQuote(longHedger1User2)

			const partyA1BalanceBefore = await user.getBalanceInfo()
			const partyA2BalanceBefore = await user2.getBalanceInfo()
			const partyBBalanceBefore = await hedger.getBalanceInfoCrossPartyB()

			const sig = await getDummyUnifiedSettlementSig(
				partyB,
				0n, // Aggregated UPNL for cross partyB
				[], // Empty for cross partyB mode
				[partyA1, partyA2],
				[0n, 0n],
				[
					{ quoteId: shortHedger1, currentPrice: 0n, partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct,
					{ quoteId: longHedger1User2, currentPrice: decimal(5n, 17), partyAIndex: 1n } as UnifiedQuoteSettlementDataStruct,
				],
			)

			await hedger.settleUpnlUnified([decimal(5n, 17), decimal(6n, 17)], sig)

			// In cross partyB mode, cross nonce is incremented once per partyA
			expect(await context.viewFacet.nonceOfPartyB(partyB, "0x0000000000000000000000000000000000000000")).to.be.eq(beforeCrossNonce + 2n)
			expect(await context.viewFacet.nonceOfPartyB(partyB, partyA1)).to.be.eq(beforeNoncePartyB_A1 + 1n)
			expect(await context.viewFacet.nonceOfPartyB(partyB, partyA2)).to.be.eq(beforeNoncePartyB_A2 + 1n)

			// Verify prices updated
			expect((await context.viewFacetQuote.getQuote(shortHedger1)).openedPrice).to.be.eq(decimal(5n, 17).toString())
			expect((await context.viewFacetQuote.getQuote(longHedger1User2)).openedPrice).to.be.eq(decimal(6n, 17).toString())

			// Verify partyA balance changes
			// SHORT quote1: (openedPrice - updatedPrice) * openAmount / 1e18 -> partyA1 gains
			const expectedSettleA1 = unDecimal((quote1.openedPrice - decimal(5n, 17)) * quote1.quantity)
			const partyA1BalanceAfter = await user.getBalanceInfo()
			expect(partyA1BalanceAfter.allocatedBalances - partyA1BalanceBefore.allocatedBalances).to.be.eq(expectedSettleA1)

			// LONG quote2: (updatedPrice - openedPrice) * openAmount / 1e18 -> partyA2 loses
			const expectedSettleA2 = unDecimal((decimal(6n, 17) - quote2.openedPrice) * quote2.quantity)
			const partyA2BalanceAfter = await user2.getBalanceInfo()
			expect(partyA2BalanceAfter.allocatedBalances - partyA2BalanceBefore.allocatedBalances).to.be.eq(expectedSettleA2)

			// Verify cross partyB balance: all settlements go to/from address(0) bucket
			// Net partyB change = -expectedSettleA1 - expectedSettleA2 (partyB loses what partyAs gain, gains what they lose)
			const partyBBalanceAfter = await hedger.getBalanceInfoCrossPartyB()
			const expectedPartyBChange = -expectedSettleA1 - expectedSettleA2
			expect(partyBBalanceAfter.allocatedBalances - partyBBalanceBefore.allocatedBalances).to.be.eq(expectedPartyBChange)
		})

		it("Should fail when partyB is insolvent in cross partyB mode", async function () {
			const sig = await getDummyUnifiedSettlementSig(
				await hedger.getAddress(),
				decimal(10000n) * -1n, // Large negative aggregated UPNL
				[],
				[await user.getAddress()],
				[0n],
				[{ quoteId: shortHedger1, currentPrice: 0n, partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct],
			)
			await expect(hedger.settleUpnlUnified([decimal(5n, 17)], sig)).to.be.revertedWith("LibSettlement: PartyB is insolvent")
		})
	})

	describe("Cross PartyB Settlement Ordering", function () {
		// Scenario: cross partyB has balance 240, settles with two partyAs.
		// Settlement with partyA1 (LONG): partyB loses 300 (> balance of 240)
		// Settlement with partyA2 (SHORT): partyB gains 200
		// Net: partyB loses 100 — solvent, but intermediate underflow if losses processed first.
		let crossCtx: RunContext, partyA1: User, partyA2: User, crossHedger: Hedger
		let longQuoteId: bigint, shortQuoteId: bigint

		beforeEach(async function () {
			crossCtx = await loadFixture(initializeFixture)

			partyA1 = new User(crossCtx, crossCtx.signers.user)
			await partyA1.setup()
			await partyA1.setBalances(decimal(2000n), decimal(1000n), decimal(700n))

			partyA2 = new User(crossCtx, crossCtx.signers.user2)
			await partyA2.setup()
			await partyA2.setBalances(decimal(2000n), decimal(1000n), decimal(700n))

			crossHedger = new Hedger(crossCtx, crossCtx.signers.hedger)
			await crossHedger.setup()
			await crossHedger.setBalances(decimal(500n), decimal(500n))

			// LONG position with partyA1 (openedPrice=1e18, qty=100e18)
			longQuoteId = await partyA1.sendQuote()
			await crossHedger.lockQuote(longQuoteId)
			await crossHedger.openPosition(longQuoteId)

			// SHORT position with partyA2
			shortQuoteId = await partyA2.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
			await crossHedger.lockQuote(shortQuoteId)
			await crossHedger.openPosition(shortQuoteId)

			// Migrate hedger to cross mode — cross balance = 240 (120 per partyA from lockQuote allocations)
			await migratePartyBToCross(crossCtx, crossHedger, [longQuoteId, shortQuoteId])
		})

		it("Should settle cross partyB with favorable ordering (gains first)", async function () {
			const addr1 = await partyA1.getAddress()
			const addr2 = await partyA2.getAddress()
			const partyBAddr = await crossHedger.getAddress()

			const balanceBefore = await crossHedger.getBalanceInfoCrossPartyB()

			// Order: [partyA2, partyA1] — partyB gains 200 from partyA2 first, then loses 300 to partyA1
			const sig = await getDummyUnifiedSettlementSig(
				partyBAddr,
				0n,
				[],
				[addr2, addr1],
				[0n, 0n],
				[
					{ quoteId: shortQuoteId, currentPrice: decimal(3n), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct,
					{ quoteId: longQuoteId, currentPrice: decimal(4n), partyAIndex: 1n } as UnifiedQuoteSettlementDataStruct,
				],
			)

			await crossHedger.settleUpnlUnified([decimal(3n), decimal(4n)], sig)

			// Net: partyB loses 100
			const balanceAfter = await crossHedger.getBalanceInfoCrossPartyB()
			expect(balanceBefore.allocatedBalances - balanceAfter.allocatedBalances).to.eq(decimal(100n))
		})

		it("Should settle cross partyB with unfavorable ordering (losses first)", async function () {
			const addr1 = await partyA1.getAddress()
			const addr2 = await partyA2.getAddress()
			const partyBAddr = await crossHedger.getAddress()

			const balanceBefore = await crossHedger.getBalanceInfoCrossPartyB()

			// Order: [partyA1, partyA2] — partyB loses 300 to partyA1 first (300 > cross balance of 240)
			const sig = await getDummyUnifiedSettlementSig(
				partyBAddr,
				0n,
				[],
				[addr1, addr2],
				[0n, 0n],
				[
					{ quoteId: longQuoteId, currentPrice: decimal(4n), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct,
					{ quoteId: shortQuoteId, currentPrice: decimal(3n), partyAIndex: 1n } as UnifiedQuoteSettlementDataStruct,
				],
			)

			await crossHedger.settleUpnlUnified([decimal(4n), decimal(3n)], sig)

			// Same net result: partyB loses 100
			const balanceAfter = await crossHedger.getBalanceInfoCrossPartyB()
			expect(balanceBefore.allocatedBalances - balanceAfter.allocatedBalances).to.eq(decimal(100n))
		})
	})
}
