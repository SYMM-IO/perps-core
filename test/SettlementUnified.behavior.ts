import { loadFixture } from "./helpers/network-helpers.js"

import { initializeFixture } from "./Initialize.fixture.js"
import { PositionType } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, unDecimal } from "./utils/Common.js"
import { expect } from "chai"
import { getDummySingleUpnlSig, getDummyUnifiedSettlementSig } from "./utils/SignatureUtils.js"
import type { UnifiedQuoteSettlementDataStruct } from "../src/types/facets/Settlement/ISettlementFacet.js"
import { migratePartyBToMaster } from "./utils/MasterAccount.js"

export function shouldBehaveLikeSettlementUnified(): void {
	let context: RunContext, user: User, user2: User, hedger: Hedger, hedger2: Hedger
	let longHedger1: bigint, shortHedger1: bigint, shortHedger2: bigint, shortClosePending: bigint,
		longClosed: bigint, longHedger1User2: bigint

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

	describe("Normal Mode (non-masterAccount)", function () {
		it("Should fail when partyB actions paused", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pausePartyBActions()
			const sig = await getDummyUnifiedSettlementSig(
				await hedger.getAddress(),
				0n,
				[0n],
				[await user.getAddress()],
				[0n],
				[]
			)
			await expect(hedger.settleUpnlUnified([], sig)).to.be.revertedWith("Pausable: PartyB actions paused")
		})

		it("Should fail when quotes array is empty", async function () {
			const sig = await getDummyUnifiedSettlementSig(
				await hedger.getAddress(),
				0n,
				[0n],
				[await user.getAddress()],
				[0n],
				[]
			)
			await expect(hedger.settleUpnlUnified([], sig)).to.be.revertedWith("LibSettlement: Empty quotes array")
		})

		it("Should fail when partyAs array is empty", async function () {
			const sig = await getDummyUnifiedSettlementSig(
				await hedger.getAddress(),
				0n,
				[],
				[],
				[],
				[{ quoteId: longHedger1, currentPrice: decimal(5n, 17), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct]
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
				[{ quoteId: longHedger1, currentPrice: decimal(5n, 17), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct]
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
				[{ quoteId: longHedger1, currentPrice: decimal(5n, 17), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct]
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
				[{ quoteId: shortHedger1, currentPrice: 0n, partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct]
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
				[{ quoteId: longHedger1User2, currentPrice: decimal(5n, 17), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct]
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
				[{ quoteId: shortHedger2, currentPrice: 0n, partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct] // But quote belongs to hedger2
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
				[{ quoteId: longHedger1, currentPrice: decimal(5n, 17), partyAIndex: 5n } as UnifiedQuoteSettlementDataStruct] // Index 5 but only 1 partyA
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
				[{ quoteId: longClosed, currentPrice: decimal(5n, 17), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct]
			)
			await expect(hedger.settleUpnlUnified([decimal(6n, 17)], sig)).to.be.revertedWith("LibSettlement: Invalid quote state")
		})

		it("Should fail when updated price is out of range", async function () {
			const sig = await getDummyUnifiedSettlementSig(
				await hedger.getAddress(),
				0n,
				[0n],
				[await user.getAddress()],
				[0n],
				[{ quoteId: longHedger1, currentPrice: decimal(2n), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct]
			)
			await expect(hedger.settleUpnlUnified([decimal(0n)], sig)).to.be.revertedWith("LibSettlement: Updated price is out of range")
		})

		it("Should fail when partyB is in liquidation process", async function () {
			await hedger.liquidate(await user.getAddress(), await getDummySingleUpnlSig(decimal(10000n) * -1n) as any)
			const sig = await getDummyUnifiedSettlementSig(
				await hedger.getAddress(),
				0n,
				[0n],
				[await user.getAddress()],
				[0n],
				[{ quoteId: longHedger1, currentPrice: decimal(5n, 17), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct]
			)
			await expect(hedger.settleUpnlUnified([decimal(6n, 17)], sig)).to.be.revertedWith("LibSettlement: PartyB is in liquidation with partyA")
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
				[{ quoteId: longHedger1, currentPrice: decimal(5n, 17), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct]
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

			const sig = await getDummyUnifiedSettlementSig(
				partyB,
				0n,
				[0n, 0n], // Per-partyA UPNLs for normal mode
				[partyA1, partyA2],
				[0n, 0n],
				[
					{ quoteId: shortHedger1, currentPrice: 0n, partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct,
					{ quoteId: longHedger1User2, currentPrice: decimal(5n, 17), partyAIndex: 1n } as UnifiedQuoteSettlementDataStruct
				]
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
		})
	})

	describe("Master Account Mode", function () {
		beforeEach(async function () {
			// Migrate hedger to master account mode
			await migratePartyBToMaster(context, hedger, [longHedger1, shortHedger1, shortClosePending, longHedger1User2])
		})

		it("Should settle successfully for single partyA in master account mode", async function () {
			const partyA = await user.getAddress()
			const partyB = await hedger.getAddress()
			const quoteBefore = await context.viewFacetQuote.getQuote(longHedger1)
			const updatedPrice = decimal(6n, 17)

			// In master account mode, use aggregated UPNL (upnlPartyB), not per-partyA
			const sig = await getDummyUnifiedSettlementSig(
				partyB,
				0n, // Aggregated UPNL for partyB
				[], // Empty for master account mode
				[partyA],
				[0n],
				[{ quoteId: longHedger1, currentPrice: decimal(5n, 17), partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct]
			)

			const partyABalanceBefore = await user.getBalanceInfo()
			const partyBBalanceBefore = await hedger.getBalanceInfoMasterAccount()

			await hedger.settleUpnlUnified([updatedPrice], sig)

			const partyABalanceAfter = await user.getBalanceInfo()
			const partyBBalanceAfter = await hedger.getBalanceInfoMasterAccount()

			const expectedLoss = unDecimal((quoteBefore.openedPrice - updatedPrice) * quoteBefore.quantity)
			expect(partyABalanceBefore.allocatedBalances - partyABalanceAfter.allocatedBalances).to.be.eq(expectedLoss)
			// In master account mode, balance is at address(0)
			expect(partyBBalanceAfter.allocatedBalances - partyBBalanceBefore.allocatedBalances).to.be.eq(expectedLoss)
			expect((await context.viewFacetQuote.getQuote(longHedger1)).openedPrice).to.be.eq(updatedPrice)
		})

		it("Should settle successfully for multiple partyAs in master account mode", async function () {
			const partyA1 = await user.getAddress()
			const partyA2 = await user2.getAddress()
			const partyB = await hedger.getAddress()

			const beforeMasterNonce = await context.viewFacet.nonceOfPartyB(partyB, "0x0000000000000000000000000000000000000000")
			const beforeNoncePartyB_A1 = await context.viewFacet.nonceOfPartyB(partyB, partyA1)
			const beforeNoncePartyB_A2 = await context.viewFacet.nonceOfPartyB(partyB, partyA2)

			const partyBBalanceBefore = await hedger.getBalanceInfoMasterAccount()

			const sig = await getDummyUnifiedSettlementSig(
				partyB,
				0n, // Aggregated UPNL for master account
				[], // Empty for master account mode
				[partyA1, partyA2],
				[0n, 0n],
				[
					{ quoteId: shortHedger1, currentPrice: 0n, partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct,
					{ quoteId: longHedger1User2, currentPrice: decimal(5n, 17), partyAIndex: 1n } as UnifiedQuoteSettlementDataStruct
				]
			)

			await hedger.settleUpnlUnified([decimal(5n, 17), decimal(6n, 17)], sig)

			// In master account mode, master nonce is incremented once per partyA
			expect(await context.viewFacet.nonceOfPartyB(partyB, "0x0000000000000000000000000000000000000000")).to.be.eq(beforeMasterNonce + 2n)
			expect(await context.viewFacet.nonceOfPartyB(partyB, partyA1)).to.be.eq(beforeNoncePartyB_A1 + 1n)
			expect(await context.viewFacet.nonceOfPartyB(partyB, partyA2)).to.be.eq(beforeNoncePartyB_A2 + 1n)

			// Verify prices updated
			expect((await context.viewFacetQuote.getQuote(shortHedger1)).openedPrice).to.be.eq(decimal(5n, 17).toString())
			expect((await context.viewFacetQuote.getQuote(longHedger1User2)).openedPrice).to.be.eq(decimal(6n, 17).toString())

			// Verify master account balance updated
			const partyBBalanceAfter = await hedger.getBalanceInfoMasterAccount()
			// Balance should have changed (all settlements go to/from address(0) bucket)
			expect(partyBBalanceAfter.allocatedBalances).to.not.eq(partyBBalanceBefore.allocatedBalances)
		})

		it("Should fail when partyB is insolvent in master account mode", async function () {
			const sig = await getDummyUnifiedSettlementSig(
				await hedger.getAddress(),
				decimal(10000n) * -1n, // Large negative aggregated UPNL
				[],
				[await user.getAddress()],
				[0n],
				[{ quoteId: shortHedger1, currentPrice: 0n, partyAIndex: 0n } as UnifiedQuoteSettlementDataStruct]
			)
			await expect(hedger.settleUpnlUnified([decimal(5n, 17)], sig)).to.be.revertedWith("LibSettlement: PartyB is insolvent")
		})
	})
}
