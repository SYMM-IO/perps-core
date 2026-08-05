import { expect } from "chai"
import { ZeroAddress } from "ethers"

import type { UnifiedQuoteSettlementDataStruct } from "../src/types/facets/Settlement/ISettlementFacet.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { PositionType } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal } from "./utils/Common.js"
import { migratePartyBToCross } from "./utils/CrossPartyB.js"
import { getDummySingleUpnlSig, getDummyUnifiedSettlementSig } from "./utils/SignatureUtils.js"

/**
 * Tests for the cross-mode PartyB settlement shortfall fix.
 *
 * Scenario setup:
 *   quoteA: user LONG with hedger2 (isolated), qty=1000 → user's big loss when price drops
 *   quoteB: user SHORT with hedger (cross), qty=100  → user's gain creates settleAmount > 0
 *   quoteC: user2 LONG with hedger (cross), qty=100  → hedger's uPNL source for settlement
 *
 * At liquidation price 0.5:
 *   user uPNL: LONG loss = -500, SHORT gain = +50, net = -450 → insolvent
 *   hedger settleAmount = +50 (must pay user's profit from quoteB)
 *   hedger2 settleAmount = -500 (receives user's loss from quoteA)
 *
 * In the shortfall scenario, hedger deallocates to the CVA/LF backing floor and price falls to 0.1:
 *   After CVA return (22), hedger balance = 72 < settleAmount (90) → shortfall
 *   The new require reverts, forcing liquidator to call settlePartyBUpnlForLiquidation first.
 */
export function shouldBehaveLikeSettlePartyBUpnlForLiquidation(): void {
	let context: RunContext
	let user: User, user2: User
	let hedger: Hedger, hedger2: Hedger
	let quoteA: bigint, quoteB: bigint, quoteC: bigint

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)

		// --- PartyA setup ---
		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(5000n), decimal(1000n), decimal(300n))

		user2 = new User(context, context.signers.user2)
		await user2.setup()
		await user2.setBalances(decimal(5000n), decimal(3000n), decimal(2000n))

		// --- PartyB setup ---
		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(10000n), decimal(10000n))

		hedger2 = new Hedger(context, context.signers.hedger2)
		await hedger2.setup()
		await hedger2.setBalances(decimal(10000n), decimal(10000n))

		// --- Position setup ---
		const hedger2Addr = await hedger2.getAddress()

		// quoteA: user LONG with hedger2, qty=1000, opened at 1e18
		// At price 0.5: user loss = (0.5-1.0)*1000 = -500
		quoteA = await user.sendQuote(limitQuoteRequestBuilder().quantity(decimal(1000n)).partyBWhiteList([hedger2Addr]).build())
		await hedger2.lockQuote(quoteA)
		await hedger2.openPosition(quoteA, limitOpenRequestBuilder().filledAmount(decimal(1000n)).price(decimal(1n)).build())

		// quoteB: user SHORT with hedger, qty=100, opened at 1e18
		// At price 0.5: user gain = (1.0-0.5)*100 = +50 → settleAmount > 0 for hedger
		quoteB = await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
		await hedger.lockQuote(quoteB)
		await hedger.openPosition(quoteB)

		// quoteC: user2 LONG with hedger, qty=100, opened at 1e18
		// Hedger is SHORT → profits when price drops → uPNL source for settlement
		quoteC = await user2.sendQuote()
		await hedger.lockQuote(quoteC)
		await hedger.openPosition(quoteC)

		// Migrate hedger to cross mode
		await migratePartyBToCross(context, hedger, [quoteB, quoteC])
	})

	describe("settlePartyBUpnlForLiquidation", function () {
		describe("Access control", function () {
			it("Should fail when called by non-liquidator", async function () {
				const sig = await getDummyUnifiedSettlementSig()
				await expect(context.settlementFacet.connect(context.signers.user).settlePartyBUpnlForLiquidation(await user.getAddress(), sig, [])).to.be
					.reverted
			})

			it("Should fail when liquidation is paused", async function () {
				await context.pauseControlFacet.connect(context.signers.admin).pauseLiquidation()
				const sig = await getDummyUnifiedSettlementSig()
				await expect(
					context.settlementFacet.connect(context.signers.liquidator).settlePartyBUpnlForLiquidation(await user.getAddress(), sig, []),
				).to.be.revertedWith("Pausable: Liquidation paused")
			})
		})

		describe("Validation", function () {
			it("Should fail when partyA is not in liquidation", async function () {
				const sig = await getDummyUnifiedSettlementSig(await hedger.getAddress(), 0n, [], [await user2.getAddress()], [0n], [])
				await expect(
					context.settlementFacet.connect(context.signers.liquidator).settlePartyBUpnlForLiquidation(await user.getAddress(), sig, []),
				).to.be.revertedWith("SettlementFacet: PartyA not in liquidation")
			})

			it("Should fail when partyB is not cross-mode", async function () {
				// Liquidate user (no deallocation, so no dispute)
				await user.liquidateAndSetSymbolPrices([1n], [decimal(5n, 17)], [quoteA, quoteB])
				await user.liquidatePositions([quoteA, quoteB])

				// hedger2 is isolated, should fail
				const sig = await getDummyUnifiedSettlementSig(await hedger2.getAddress(), 0n, [], [await user2.getAddress()], [0n], [])
				await expect(
					context.settlementFacet.connect(context.signers.liquidator).settlePartyBUpnlForLiquidation(await user.getAddress(), sig, []),
				).to.be.revertedWith("SettlementFacet: PartyB not cross-mode")
			})

			it("Should fail when no pending settlement exists", async function () {
				// Liquidate user but DON'T liquidate positions → no settlement pending
				await user.liquidateAndSetSymbolPrices([1n], [decimal(5n, 17)], [quoteA, quoteB])

				const sig = await getDummyUnifiedSettlementSig(await hedger.getAddress(), 0n, [], [await user2.getAddress()], [0n], [])
				await expect(
					context.settlementFacet.connect(context.signers.liquidator).settlePartyBUpnlForLiquidation(await user.getAddress(), sig, []),
				).to.be.revertedWith("SettlementFacet: No pending settlement")
			})

			it("Should fail when trying to settle with the liquidated partyA", async function () {
				// Liquidate user (no deallocation, so no dispute)
				await user.liquidateAndSetSymbolPrices([1n], [decimal(5n, 17)], [quoteA, quoteB])
				await user.liquidatePositions([quoteA, quoteB])

				const sig = await getDummyUnifiedSettlementSig(
					await hedger.getAddress(),
					0n,
					[],
					[await user.getAddress()], // liquidated partyA — should fail
					[0n],
					[{ quoteId: quoteC, currentPrice: decimal(5n, 17), partyAIndex: 0n }],
				)
				await expect(
					context.settlementFacet.connect(context.signers.liquidator).settlePartyBUpnlForLiquidation(await user.getAddress(), sig, [decimal(5n, 17)]),
				).to.be.revertedWith("SettlementFacet: Cannot settle with liquidated partyA")
			})
		})

		describe("Cross-mode settlement shortfall", function () {
			let userAddr: string, hedgerAddr: string, hedger2Addr: string, user2Addr: string

			beforeEach(async function () {
				userAddr = await user.getAddress()
				hedgerAddr = await hedger.getAddress()
				hedger2Addr = await hedger2.getAddress()
				user2Addr = await user2.getAddress()

				// Deallocate only the amount above the mandatory CVA/LF backing floor.
				const crossBalanceInfo = await hedger.getBalanceInfoCrossPartyB()
				const requiredBacking =
					crossBalanceInfo.lockedCva + crossBalanceInfo.lockedLf + crossBalanceInfo.pendingLockedCva + crossBalanceInfo.pendingLockedLf
				const maxDeallocate = crossBalanceInfo.allocatedBalances - requiredBacking
				if (maxDeallocate > 0n) {
					await context.partyBAccountFacet
						.connect(hedger.signer)
						.deallocateForPartyB(maxDeallocate, ZeroAddress, await getDummySingleUpnlSig(decimal(50000n)))
				}

				// Verify the protected backing remains allocated.
				const afterDealloc = (await hedger.getBalanceInfoCrossPartyB()).allocatedBalances
				expect(afterDealloc).to.equal(requiredBacking)

				// At price 0.1, the 90-unit receivable still exceeds backing plus returned CVA.
				await user.liquidateAndSetSymbolPrices([1n], [decimal(1n, 17)], [quoteA, quoteB])
				await user.liquidatePositions([quoteA, quoteB])

				// Resolve the dispute (admin confirms correct amounts, clears disputed flag)
				// hedger settleAmount = +90e18, hedger2 settleAmount = -900e18
				await context.partyALiquidationFacet
					.connect(context.signers.admin)
					.resolveLiquidationDispute(userAddr, [hedgerAddr, hedger2Addr], [decimal(90n), -decimal(900n)], false)
			})

			it("Should revert settlePartyALiquidation when cross partyB has insufficient balance", async function () {
				// Settle hedger2 (isolated, receives 500) — succeeds
				await context.partyALiquidationFacet.connect(context.signers.liquidator).settlePartyALiquidation(userAddr, [hedger2Addr])

				// Settle hedger (cross) — should REVERT
				// hedger balance = 50, after CVA return = 72, but settleAmount = 90 → 72 < 90
				await expect(
					context.partyALiquidationFacet.connect(context.signers.liquidator).settlePartyALiquidation(userAddr, [hedgerAddr]),
				).to.be.revertedWith("LiquidationFacet: Settle cross partyB uPNL first")
			})

			it("Should complete settlement after calling settlePartyBUpnlForLiquidation", async function () {
				// Settle hedger2 first (isolated)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).settlePartyALiquidation(userAddr, [hedger2Addr])

				// Verify cross hedger settlement reverts
				await expect(
					context.partyALiquidationFacet.connect(context.signers.liquidator).settlePartyALiquidation(userAddr, [hedgerAddr]),
				).to.be.revertedWith("LiquidationFacet: Settle cross partyB uPNL first")

				// Realize hedger's uPNL from quoteC (user2 LONG, hedger SHORT)
				// At price 0.1: hedger profits 90 from this position
				// upnlPartyB = +90e18 (hedger's total cross uPNL from quoteC)
				const quoteData: UnifiedQuoteSettlementDataStruct[] = [{ quoteId: quoteC, currentPrice: decimal(1n, 17), partyAIndex: 0n }]
				const sig = await getDummyUnifiedSettlementSig(hedgerAddr, decimal(90n), [], [user2Addr], [0n], quoteData)
				await context.settlementFacet.connect(context.signers.liquidator).settlePartyBUpnlForLiquidation(userAddr, sig, [decimal(1n, 17)])

				// Verify hedger's cross balance increased
				const crossBalanceAfterSettle = (await hedger.getBalanceInfoCrossPartyB()).allocatedBalances
				expect(crossBalanceAfterSettle).to.be.gt(0n)

				// Settlement now succeeds
				await context.partyALiquidationFacet.connect(context.signers.liquidator).settlePartyALiquidation(userAddr, [hedgerAddr])

				// Verify liquidation is fully resolved
				expect(await context.viewFacet.isPartyALiquidated(userAddr)).to.equal(false)
			})

			it("Should emit SettlePartyBUpnlForLiquidation event", async function () {
				const quoteData: UnifiedQuoteSettlementDataStruct[] = [{ quoteId: quoteC, currentPrice: decimal(5n, 17), partyAIndex: 0n }]
				const sig = await getDummyUnifiedSettlementSig(hedgerAddr, decimal(50n), [], [user2Addr], [0n], quoteData)

				await expect(
					context.settlementFacet.connect(context.signers.liquidator).settlePartyBUpnlForLiquidation(userAddr, sig, [decimal(5n, 17)]),
				).to.emit(context.settlementFacet, "SettlePartyBUpnlForLiquidation")
			})
		})
	})
}
