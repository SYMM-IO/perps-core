import { expect } from "chai"
import { ethers, toUtf8Bytes, ZeroAddress } from "ethers"

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
 * Tests for cross-mode PartyB settlement reserve.
 *
 * Vulnerability: After liquidatePositionsPartyA closes positions with a cross-mode PartyB,
 * the PartyB's cross bucket locked balances decrease immediately but the settlement PnL is
 * deferred. This inflates the available balance, allowing PartyB to deallocate funds that
 * are owed to the pending liquidation settlement.
 *
 * Fix: Track a conservative reserve = max(0, actualAmount) across pending liquidation
 * settlements. Subtract this reserve from effective available balance during deallocation.
 */
export function shouldBehaveLikeCrossPartyBSettlementReserve(): void {
	let context: RunContext
	let user: User, user2: User
	let hedger: Hedger, hedger2: Hedger
	let quoteA: bigint, quoteB: bigint, quoteC: bigint

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)

		// PartyA setup
		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(5000n), decimal(1000n), decimal(300n))

		user2 = new User(context, context.signers.user2)
		await user2.setup()
		await user2.setBalances(decimal(5000n), decimal(3000n), decimal(2000n))

		// PartyB setup
		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(10000n), decimal(10000n))

		hedger2 = new Hedger(context, context.signers.hedger2)
		await hedger2.setup()
		await hedger2.setBalances(decimal(10000n), decimal(10000n))

		const hedger2Addr = await hedger2.getAddress()

		// quoteA: user LONG with hedger2 (isolated), qty=1000
		// At price 0.5: user loss = (0.5-1)*1000 = -500
		quoteA = await user.sendQuote(limitQuoteRequestBuilder().quantity(decimal(1000n)).partyBWhiteList([hedger2Addr]).build())
		await hedger2.lockQuote(quoteA)
		await hedger2.openPosition(quoteA, limitOpenRequestBuilder().filledAmount(decimal(1000n)).price(decimal(1n)).build())

		// quoteB: user SHORT with hedger (will be cross), qty=100
		// At price 0.5: user gain = (1-0.5)*100 = +50 -> hedger OWES 50
		quoteB = await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
		await hedger.lockQuote(quoteB)
		await hedger.openPosition(quoteB)

		// quoteC: user2 LONG with hedger (will be cross), qty=100
		// Hedger is SHORT -> profits when price drops -> uPNL source for settlement
		quoteC = await user2.sendQuote()
		await hedger.lockQuote(quoteC)
		await hedger.openPosition(quoteC)

		// Migrate hedger to cross mode
		await migratePartyBToCross(context, hedger, [quoteB, quoteC])
	})

	describe("Cross-mode PartyB settlement reserve", function () {
		let userAddr: string, hedgerAddr: string, hedger2Addr: string, user2Addr: string

		beforeEach(async function () {
			userAddr = await user.getAddress()
			hedgerAddr = await hedger.getAddress()
			hedger2Addr = await hedger2.getAddress()
			user2Addr = await user2.getAddress()

			// Liquidate user at price=0.5e18 and close positions
			await user.liquidateAndSetSymbolPrices([1n], [decimal(5n, 17)], [quoteA, quoteB])
			await user.liquidatePositions([quoteA, quoteB])
		})

		it("Should set reserve to max(0, actualAmount) after liquidation", async function () {
			const reserve = await context.viewFacet.getPartyBLiquidationSettlementReserve(hedgerAddr)
			// hedger owes 50 (user gained from SHORT position) → reserve = 50
			expect(reserve).to.equal(decimal(50n))
		})

		it("Should not create reserve for isolated-mode PartyB", async function () {
			// hedger2 (isolated) also has a settlement with user, but no reserve
			const reserve = await context.viewFacet.getPartyBLiquidationSettlementReserve(hedger2Addr)
			expect(reserve).to.equal(0n)
		})

		it("Should prevent cross-mode PartyB from deallocating reserved settlement funds", async function () {
			// available = 225, reserve = 50, effective available = 175
			// Deallocating 200 should fail because effective available (175) < 200
			await expect(
				context.partyBAccountFacet.connect(hedger.signer).deallocateForPartyB(decimal(200n), ZeroAddress, await getDummySingleUpnlSig(decimal(50n))),
			).to.be.revertedWith("AccountFacet: Will be liquidatable")
		})

		it("Should allow cross-mode PartyB to deallocate funds above the reserve", async function () {
			// effective available = 175, so deallocating 170 should succeed
			await expect(
				context.partyBAccountFacet.connect(hedger.signer).deallocateForPartyB(decimal(170n), ZeroAddress, await getDummySingleUpnlSig(decimal(50n))),
			).to.not.be.reverted
		})

		it("Should clear reserve after settlement completes", async function () {
			// Settle hedger2 first (isolated)
			await context.partyALiquidationFacet.connect(context.signers.liquidator).settlePartyALiquidation(userAddr, [hedger2Addr])

			// Realize hedger's uPNL via settlePartyBUpnlForLiquidation
			const quoteData: UnifiedQuoteSettlementDataStruct[] = [{ quoteId: quoteC, currentPrice: decimal(5n, 17), partyAIndex: 0n }]
			const sig = await getDummyUnifiedSettlementSig(hedgerAddr, decimal(50n), [], [user2Addr], [0n], quoteData)
			await context.settlementFacet.connect(context.signers.liquidator).settlePartyBUpnlForLiquidation(userAddr, sig, [decimal(5n, 17)])

			// Settle hedger (cross) -- completes the liquidation
			await context.partyALiquidationFacet.connect(context.signers.liquidator).settlePartyALiquidation(userAddr, [hedgerAddr])

			// Reserve should be cleared
			const reserve = await context.viewFacet.getPartyBLiquidationSettlementReserve(hedgerAddr)
			expect(reserve).to.equal(0n)

			// Verify deallocation works with full available balance
			const crossBalance = await hedger.getBalanceInfoCrossPartyB()
			const safeAmount = crossBalance.allocatedBalances - crossBalance.totalLockedPartyB
			if (safeAmount > 0n) {
				await expect(
					context.partyBAccountFacet.connect(hedger.signer).deallocateForPartyB(safeAmount, ZeroAddress, await getDummySingleUpnlSig(decimal(50n))),
				).to.not.be.reverted
			}
		})
	})

	describe("PartyA takeover clears settlement reserve", function () {
		let userAddr: string, hedgerAddr: string, hedger2Addr: string

		beforeEach(async function () {
			userAddr = await user.getAddress()
			hedgerAddr = await hedger.getAddress()
			hedger2Addr = await hedger2.getAddress()

			// Grant CLEARING_HOUSE_ROLE to liquidator
			await context.controlFacet.grantRole(context.signers.liquidator.address, ethers.keccak256(toUtf8Bytes("CLEARING_HOUSE_ROLE")))

			// Liquidate user at price=0.5 and close positions (normal flow)
			await user.liquidateAndSetSymbolPrices([1n], [decimal(5n, 17)], [quoteA, quoteB])
			await user.liquidatePositions([quoteA, quoteB])
		})

		it("Should still block deallocation after takeover begins", async function () {
			const reserveBefore = await context.viewFacet.getPartyBLiquidationSettlementReserve(hedgerAddr)
			expect(reserveBefore).to.equal(decimal(50n))

			// CH takes over
			await context.clearingHouseFacet.connect(context.signers.liquidator).takeoverPartyALiquidation(userAddr)

			// Reserve still in effect — deallocation of 200 should still fail
			await expect(
				context.partyBAccountFacet.connect(hedger.signer).deallocateForPartyB(decimal(200n), ZeroAddress, await getDummySingleUpnlSig(decimal(50n))),
			).to.be.revertedWith("AccountFacet: Will be liquidatable")
		})

		it("Should clear reserve when settlePartyATakeover is called with settledPartyBs", async function () {
			// CH takes over
			await context.clearingHouseFacet.connect(context.signers.liquidator).takeoverPartyALiquidation(userAddr)

			// settlePartyATakeover clears settlement states and reserve for provided partyBs
			await context.clearingHouseFacet.connect(context.signers.liquidator).settlePartyATakeover(userAddr, [hedgerAddr, hedger2Addr])

			// Reserve should be 0
			const reserve = await context.viewFacet.getPartyBLiquidationSettlementReserve(hedgerAddr)
			expect(reserve).to.equal(0n)

			// Full deallocation should now work
			await expect(
				context.partyBAccountFacet.connect(hedger.signer).deallocateForPartyB(decimal(170n), ZeroAddress, await getDummySingleUpnlSig(decimal(50n))),
			).to.not.be.reverted
		})
	})

	describe("Multiple concurrent PartyA liquidations accumulate reserve", function () {
		/**
		 * Two PartyAs are liquidated against the same cross hedger.
		 * Each creates a positive actualAmount → reserve accumulates.
		 * Settling one reduces reserve; only after both settle is reserve fully cleared.
		 *
		 * Setup:
		 *   user:  LONG hedger2 (isolated, qty=1000) + SHORT hedger (cross, qty=100) → actualAmount +50
		 *   user2: LONG hedger2 (isolated, qty=1000) + SHORT hedger (cross, qty=100) → actualAmount +50
		 *   user3 (others[0]): LONG hedger (cross, qty=100) → uPNL source for settlement
		 *   Total reserve after both liquidations = 100
		 */
		let user3: User
		let quoteD: bigint, quoteE: bigint, quoteF: bigint, quoteG: bigint, quoteH: bigint
		let userAddr: string, user2Addr: string, user3Addr: string, hedgerAddr: string, hedger2Addr: string

		beforeEach(async function () {
			// Re-initialize with fresh fixture for this scenario
			context = await loadFixture(initializeFixture)

			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(decimal(5000n), decimal(1000n), decimal(300n))

			user2 = new User(context, context.signers.user2)
			await user2.setup()
			await user2.setBalances(decimal(5000n), decimal(1000n), decimal(300n))

			user3 = new User(context, context.signers.others[0])
			await user3.setup()
			await user3.setBalances(decimal(5000n), decimal(3000n), decimal(2000n))

			hedger = new Hedger(context, context.signers.hedger)
			await hedger.setup()
			await hedger.setBalances(decimal(20000n), decimal(20000n))

			hedger2 = new Hedger(context, context.signers.hedger2)
			await hedger2.setup()
			await hedger2.setBalances(decimal(20000n), decimal(20000n))

			hedger2Addr = await hedger2.getAddress()
			hedgerAddr = await hedger.getAddress()
			userAddr = await user.getAddress()
			user2Addr = await user2.getAddress()
			user3Addr = await user3.getAddress()

			// quoteD: user LONG with hedger2 (isolated), qty=1000 -> makes user insolvent
			quoteD = await user.sendQuote(limitQuoteRequestBuilder().quantity(decimal(1000n)).partyBWhiteList([hedger2Addr]).build())
			await hedger2.lockQuote(quoteD)
			await hedger2.openPosition(quoteD, limitOpenRequestBuilder().filledAmount(decimal(1000n)).price(decimal(1n)).build())

			// quoteE: user SHORT with hedger (will be cross), qty=100
			// At price 0.5: user gain +50 -> hedger owes +50
			quoteE = await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
			await hedger.lockQuote(quoteE)
			await hedger.openPosition(quoteE)

			// quoteF: user2 LONG with hedger2 (isolated), qty=1000 -> makes user2 insolvent
			quoteF = await user2.sendQuote(limitQuoteRequestBuilder().quantity(decimal(1000n)).partyBWhiteList([hedger2Addr]).build())
			await hedger2.lockQuote(quoteF)
			await hedger2.openPosition(quoteF, limitOpenRequestBuilder().filledAmount(decimal(1000n)).price(decimal(1n)).build())

			// quoteG: user2 SHORT with hedger (will be cross), qty=100
			// At price 0.5: user2 gain +50 -> hedger owes +50
			quoteG = await user2.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
			await hedger.lockQuote(quoteG)
			await hedger.openPosition(quoteG)

			// quoteH: user3 LONG with hedger (will be cross), qty=100
			// uPNL source for settlement — hedger profits when price drops
			quoteH = await user3.sendQuote()
			await hedger.lockQuote(quoteH)
			await hedger.openPosition(quoteH)

			// Migrate hedger to cross mode
			await migratePartyBToCross(context, hedger, [quoteE, quoteG, quoteH])
		})

		it("Should accumulate reserve across two PartyA liquidations", async function () {
			// Liquidate user
			await user.liquidateAndSetSymbolPrices([1n], [decimal(5n, 17)], [quoteD, quoteE])
			await user.liquidatePositions([quoteD, quoteE])

			const reserveAfterFirst = await context.viewFacet.getPartyBLiquidationSettlementReserve(hedgerAddr)
			expect(reserveAfterFirst).to.equal(decimal(50n))

			// Liquidate user2
			await user2.liquidateAndSetSymbolPrices([1n], [decimal(5n, 17)], [quoteF, quoteG])
			await user2.liquidatePositions([quoteF, quoteG])

			const reserveAfterBoth = await context.viewFacet.getPartyBLiquidationSettlementReserve(hedgerAddr)
			expect(reserveAfterBoth).to.equal(decimal(100n))
		})

		it("Should partially reduce reserve when one PartyA settles", async function () {
			// Liquidate both
			await user.liquidateAndSetSymbolPrices([1n], [decimal(5n, 17)], [quoteD, quoteE])
			await user.liquidatePositions([quoteD, quoteE])
			await user2.liquidateAndSetSymbolPrices([1n], [decimal(5n, 17)], [quoteF, quoteG])
			await user2.liquidatePositions([quoteF, quoteG])

			expect(await context.viewFacet.getPartyBLiquidationSettlementReserve(hedgerAddr)).to.equal(decimal(100n))

			// Settle user's liquidation (hedger2 first, then realize hedger uPNL, then hedger)
			await context.partyALiquidationFacet.connect(context.signers.liquidator).settlePartyALiquidation(userAddr, [hedger2Addr])
			const quoteData: UnifiedQuoteSettlementDataStruct[] = [{ quoteId: quoteH, currentPrice: decimal(5n, 17), partyAIndex: 0n }]
			const sig = await getDummyUnifiedSettlementSig(hedgerAddr, decimal(50n), [], [user3Addr], [0n], quoteData)
			await context.settlementFacet.connect(context.signers.liquidator).settlePartyBUpnlForLiquidation(userAddr, sig, [decimal(5n, 17)])
			await context.partyALiquidationFacet.connect(context.signers.liquidator).settlePartyALiquidation(userAddr, [hedgerAddr])

			// user's +50 cleared, user2's +50 still pending
			const reserveAfterFirstSettle = await context.viewFacet.getPartyBLiquidationSettlementReserve(hedgerAddr)
			expect(reserveAfterFirstSettle).to.equal(decimal(50n))
		})

		it("Should fully clear reserve after both PartyA liquidations settle", async function () {
			// Liquidate both
			await user.liquidateAndSetSymbolPrices([1n], [decimal(5n, 17)], [quoteD, quoteE])
			await user.liquidatePositions([quoteD, quoteE])
			await user2.liquidateAndSetSymbolPrices([1n], [decimal(5n, 17)], [quoteF, quoteG])
			await user2.liquidatePositions([quoteF, quoteG])

			// Settle user's liquidation
			await context.partyALiquidationFacet.connect(context.signers.liquidator).settlePartyALiquidation(userAddr, [hedger2Addr])
			const quoteData1: UnifiedQuoteSettlementDataStruct[] = [{ quoteId: quoteH, currentPrice: decimal(5n, 17), partyAIndex: 0n }]
			const sig1 = await getDummyUnifiedSettlementSig(hedgerAddr, decimal(50n), [], [user3Addr], [0n], quoteData1)
			await context.settlementFacet.connect(context.signers.liquidator).settlePartyBUpnlForLiquidation(userAddr, sig1, [decimal(5n, 17)])
			await context.partyALiquidationFacet.connect(context.signers.liquidator).settlePartyALiquidation(userAddr, [hedgerAddr])

			// Settle user2's liquidation
			// hedger already has sufficient cross allocated balance (quoteH was realized above,
			// and hedger started with plenty of allocation), so no uPNL settlement needed
			await context.partyALiquidationFacet.connect(context.signers.liquidator).settlePartyALiquidation(user2Addr, [hedger2Addr])
			await context.partyALiquidationFacet.connect(context.signers.liquidator).settlePartyALiquidation(user2Addr, [hedgerAddr])

			// Reserve fully cleared
			const reserve = await context.viewFacet.getPartyBLiquidationSettlementReserve(hedgerAddr)
			expect(reserve).to.equal(0n)
		})
	})
}
