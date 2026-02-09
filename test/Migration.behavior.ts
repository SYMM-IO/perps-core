import { expect } from "chai"
import { ZeroAddress, toUtf8Bytes } from "ethers"

import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal } from "./utils/Common.js"
import { getDummyLiquidationSig, getDummyPairUpnlAndPricesSig, getDummySingleUpnlSig } from "./utils/SignatureUtils.js"

export function shouldBehaveLikeMigration(): void {
	let context: RunContext
	let hedger: Hedger
	let user: User

	const BALANCES = {
		INITIAL_COLLATERAL: decimal(1000n),
		DEPOSIT_AMOUNT: decimal(600n),
		ALLOCATE_AMOUNT: decimal(400n),
	}

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		const partyB = await hedger.getAddress()
		if (!(await context.viewFacet.isPartyB(partyB))) {
			await hedger.register()
		}
		await hedger.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.DEPOSIT_AMOUNT)

		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(2000n), decimal(1000n), decimal(500n))
	})

	describe("migrateQuotes", function () {
		it("Should allow only MIGRATION_ROLE to call migrateQuotes", async function () {
			// Grant MIGRATION_ROLE to admin (already done in initializeFixture)
			await expect(context.migrationFacet.connect(context.signers.user).migrateQuotes([1])).to.be.revertedWith("Accessibility: Must have role")

			// Admin should be able to call it
			await expect(context.migrationFacet.connect(context.signers.admin).migrateQuotes([])).to.not.be.reverted
		})

		it("Should emit QuotesMigrated event", async function () {
			await expect(context.migrationFacet.connect(context.signers.admin).migrateQuotes([]))
				.to.emit(context.migrationFacet, "QuotesMigrated")
				.withArgs(0, 0)
		})

		it("Should skip non-existent quote IDs", async function () {
			// Try to migrate non-existent quote IDs
			await expect(context.migrationFacet.connect(context.signers.admin).migrateQuotes([999, 1000, 1001]))
				.to.emit(context.migrationFacet, "QuotesMigrated")
				.withArgs(3, 0)
		})

		it("Should return false for non-migrated quotes", async function () {
			expect(await context.migrationFacet.isQuoteMigrated(1)).to.equal(false)
			expect(await context.migrationFacet.isQuoteMigrated(999)).to.equal(false)
		})
	})

	describe("migrateCrossLockedValues", function () {
		it("Should allow only MIGRATION_ROLE to call migrateCrossLockedValues", async function () {
			const partyB = await hedger.getAddress()

			await expect(context.migrationFacet.connect(context.signers.user).migrateCrossLockedValues(partyB, [])).to.be.revertedWith(
				"Accessibility: Must have role",
			)

			// Admin should be able to call it
			await expect(context.migrationFacet.connect(context.signers.admin).migrateCrossLockedValues(partyB, [])).to.not.be.reverted
		})

		it("Should emit CrossLockedValuesMigrated event", async function () {
			const partyB = await hedger.getAddress()

			await expect(context.migrationFacet.connect(context.signers.admin).migrateCrossLockedValues(partyB, []))
				.to.emit(context.migrationFacet, "CrossLockedValuesMigrated")
				.withArgs(partyB, 0)
		})

		it("Should prevent double migration of partyB locked values", async function () {
			const partyB = await hedger.getAddress()

			// First migration should succeed
			await context.migrationFacet.connect(context.signers.admin).migrateCrossLockedValues(partyB, [])

			// Second migration should fail
			await expect(context.migrationFacet.connect(context.signers.admin).migrateCrossLockedValues(partyB, [])).to.be.revertedWith(
				"MigrationFacet: Already migrated",
			)
		})

		it("Should aggregate partyA balances to cross bucket", async function () {
			const partyB = await hedger.getAddress()
			const partyA1 = context.signers.user.address
			const partyA2 = context.signers.user2.address
			const allocateA1 = decimal(200n)
			const allocateA2 = decimal(150n)

			// Set up allocations
			await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateA1, partyA1)
			await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateA2, partyA2)

			// Verify initial state
			expect(await context.viewFacet.allocatedBalanceOfPartyB(partyB, partyA1)).to.equal(allocateA1)
			expect(await context.viewFacet.allocatedBalanceOfPartyB(partyB, partyA2)).to.equal(allocateA2)

			// Migrate
			await context.migrationFacet.connect(context.signers.admin).migrateCrossLockedValues(partyB, [partyA1, partyA2])

			// Verify cross bucket has aggregated balances
			const crossBalance = await context.viewFacet.balanceInfoOfCrossPartyB(partyB)
			expect(crossBalance[0]).to.equal(allocateA1 + allocateA2)
		})

		it("Should correctly track migration status", async function () {
			const partyB = await hedger.getAddress()

			expect(await context.migrationFacet.isPartyBLockedValuesMigrated(partyB)).to.equal(false)

			await context.migrationFacet.connect(context.signers.admin).migrateCrossLockedValues(partyB, [])

			expect(await context.migrationFacet.isPartyBLockedValuesMigrated(partyB)).to.equal(true)
		})
	})

	describe("setCrossPartyB", function () {
		beforeEach(async function () {
			// Enable cross partyB feature globally
			await context.controlFacet.connect(context.signers.admin).setCrossPartyBModeActivated(true)
		})

		it("Should allow only MIGRATION_ROLE to call setCrossPartyB", async function () {
			const partyB = await hedger.getAddress()

			await expect(context.controlFacet.connect(context.signers.user).setCrossPartyB(partyB, true)).to.be.revertedWith(
				"Accessibility: Must have role",
			)

			// Admin should be able to call it (has MIGRATION_ROLE)
			await expect(context.controlFacet.connect(context.signers.admin).setCrossPartyB(partyB, true)).to.not.be.reverted
		})

		it("Should require cross partyB feature to be enabled", async function () {
			const partyB = await hedger.getAddress()

			// Disable cross partyB feature
			await context.controlFacet.connect(context.signers.admin).setCrossPartyBModeActivated(false)

			await expect(context.controlFacet.connect(context.signers.admin).setCrossPartyB(partyB, true)).to.be.revertedWith(
				"ControlFacet: Cross feature disabled",
			)
		})

		it("Should require partyB to be registered", async function () {
			await expect(context.controlFacet.connect(context.signers.admin).setCrossPartyB(context.signers.user.address, true)).to.be.revertedWith(
				"ControlFacet: Address is not PartyB",
			)
		})

		it("Should emit SetCrossPartyB event", async function () {
			const partyB = await hedger.getAddress()

			await expect(context.controlFacet.connect(context.signers.admin).setCrossPartyB(partyB, true))
				.to.emit(context.controlFacet, "SetCrossPartyB")
				.withArgs(partyB, true)
		})

		it("Should only allow allocations to cross bucket after cross mode is enabled", async function () {
			const partyB = await hedger.getAddress()
			const allocateAmount = decimal(200n)

			// Enable cross partyB mode
			await context.controlFacet.connect(context.signers.admin).setCrossPartyB(partyB, true)

			// Allocating to a specific partyA should fail
			await expect(
				context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateAmount, context.signers.user.address),
			).to.be.revertedWith("PartyBFacet: Cross partyB mode is active")

			// Allocating to cross bucket (address(0)) should succeed
			await expect(context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateAmount, ZeroAddress)).to.not.be.reverted
		})
	})

	describe("Full migration flow", function () {
		it("Should complete full migration flow: migrate -> enable cross mode", async function () {
			const partyB = await hedger.getAddress()
			const partyA1 = context.signers.user.address
			const partyA2 = context.signers.user2.address
			const allocateA1 = decimal(200n)
			const allocateA2 = decimal(150n)

			// Enable cross partyB feature globally
			await context.controlFacet.connect(context.signers.admin).setCrossPartyBModeActivated(true)

			// Set up allocations
			await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateA1, partyA1)
			await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateA2, partyA2)

			// Migrate locked values to cross bucket
			await context.migrationFacet.connect(context.signers.admin).migrateCrossLockedValues(partyB, [partyA1, partyA2])

			// Verify cross bucket has aggregated balances
			const crossBalance = await context.viewFacet.balanceInfoOfCrossPartyB(partyB)
			expect(crossBalance[0]).to.equal(allocateA1 + allocateA2)

			// Enable cross partyB mode
			await context.controlFacet.connect(context.signers.admin).setCrossPartyB(partyB, true)

			// Verify cross partyB mode is enabled
			expect(await context.viewFacet.isCrossPartyB(partyB)).to.equal(true)

			// Per-partyA allocations should now fail (cross mode active)
			await expect(context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(decimal(100n), partyA1)).to.be.revertedWith(
				"PartyBFacet: Cross partyB mode is active",
			)

			// Cross bucket allocations should work
			await expect(context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(decimal(100n), ZeroAddress)).to.not.be.reverted
		})
	})

	describe("Cross bucket tracking correctness", function () {
		let user2: User, hedger2: Hedger

		beforeEach(async function () {
			user2 = new User(context, context.signers.user2)
			await user2.setup()
			await user2.setBalances(decimal(2000n), decimal(1000n), decimal(500n))

			hedger2 = new Hedger(context, context.signers.hedger2)
			await hedger2.setup()
			await hedger2.setBalances(decimal(2000n), decimal(1000n))
		})

		describe("Cross bucket sync during position lifecycle", function () {
			it("Should update cross bucket locked values when opening a position", async function () {
				const partyA = await user.getAddress()
				const partyB = await hedger.getAddress()

				// Get initial cross bucket state
				const crossBalanceBefore = await hedger.getBalanceInfoCrossPartyB()
				expect(crossBalanceBefore.totalLockedPartyB).to.equal(0n)

				// Send quote and lock
				await user.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB]).build())
				const quoteId = await context.viewFacetQuote.getNextQuoteId()
				await hedger.lockQuote(quoteId)

				// Check pending locked values in cross bucket after lock
				const crossBalanceAfterLock = await hedger.getBalanceInfoCrossPartyB()
				const perPartyAAfterLock = await hedger.getBalanceInfo(partyA)

				// Cross bucket pending locked should equal per-partyA pending locked
				expect(crossBalanceAfterLock.pendingLockedCva).to.equal(perPartyAAfterLock.pendingLockedCva)
				expect(crossBalanceAfterLock.pendingLockedLf).to.equal(perPartyAAfterLock.pendingLockedLf)
				expect(crossBalanceAfterLock.pendingLockedMmPartyB).to.equal(perPartyAAfterLock.pendingLockedMmPartyB)

				// Open position
				const quote = await context.viewFacetQuote.getQuote(quoteId)
				const upnlSig = await getDummyPairUpnlAndPricesSig([quote.requestedOpenPrice], [1n])
				await context.partyBBatchActionsFacet.connect(hedger.signer).openPositions([quoteId], [decimal(100n)], [quote.requestedOpenPrice], upnlSig)

				// After open, cross bucket locked should equal per-partyA locked
				const crossBalanceAfterOpen = await hedger.getBalanceInfoCrossPartyB()
				const perPartyAAfterOpen = await hedger.getBalanceInfo(partyA)

				expect(crossBalanceAfterOpen.lockedCva).to.equal(perPartyAAfterOpen.lockedCva)
				expect(crossBalanceAfterOpen.lockedLf).to.equal(perPartyAAfterOpen.lockedLf)
				expect(crossBalanceAfterOpen.lockedMmPartyB).to.equal(perPartyAAfterOpen.lockedMmPartyB)
				expect(crossBalanceAfterOpen.pendingLockedCva).to.equal(0n)
				expect(crossBalanceAfterOpen.pendingLockedLf).to.equal(0n)
			})

			it("Should update cross bucket locked values when closing a position", async function () {
				const partyA = await user.getAddress()
				const partyB = await hedger.getAddress()

				// Open a position first
				await user.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB]).build())
				const quoteId = await context.viewFacetQuote.getNextQuoteId()
				await hedger.lockQuote(quoteId)
				const quote = await context.viewFacetQuote.getQuote(quoteId)
				const upnlSig = await getDummyPairUpnlAndPricesSig([quote.requestedOpenPrice], [1n])
				await context.partyBBatchActionsFacet.connect(hedger.signer).openPositions([quoteId], [decimal(100n)], [quote.requestedOpenPrice], upnlSig)

				// Get locked values after open
				const crossBalanceAfterOpen = await hedger.getBalanceInfoCrossPartyB()
				const perPartyAAfterOpen = await hedger.getBalanceInfo(partyA)

				expect(crossBalanceAfterOpen.totalLockedPartyB).to.be.greaterThan(0n)
				expect(crossBalanceAfterOpen.totalLockedPartyB).to.equal(perPartyAAfterOpen.totalLockedPartyB)

				// Request close and fill it
				await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().build())
				await hedger.fillCloseRequest(quoteId, limitFillCloseRequestBuilder().filledAmount(decimal(100n)).build())

				// After full close, cross bucket locked should be zero (equal to per-partyA)
				const crossBalanceAfterClose = await hedger.getBalanceInfoCrossPartyB()
				const perPartyAAfterClose = await hedger.getBalanceInfo(partyA)

				expect(crossBalanceAfterClose.totalLockedPartyB).to.equal(0n)
				expect(crossBalanceAfterClose.totalLockedPartyB).to.equal(perPartyAAfterClose.totalLockedPartyB)
			})

			it("Should track cross bucket correctly with multiple partyAs", async function () {
				const partyA1 = await user.getAddress()
				const partyA2 = await user2.getAddress()
				const partyB = await hedger.getAddress()

				// Open position with user1
				await user.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB]).build())
				const quoteId1 = await context.viewFacetQuote.getNextQuoteId()
				await hedger.lockQuote(quoteId1)
				const quote1 = await context.viewFacetQuote.getQuote(quoteId1)
				let upnlSig = await getDummyPairUpnlAndPricesSig([quote1.requestedOpenPrice], [1n])
				await context.partyBBatchActionsFacet.connect(hedger.signer).openPositions([quoteId1], [decimal(100n)], [quote1.requestedOpenPrice], upnlSig)

				// Open position with user2
				await user2.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB]).build())
				const quoteId2 = await context.viewFacetQuote.getNextQuoteId()
				await hedger.lockQuote(quoteId2)
				const quote2 = await context.viewFacetQuote.getQuote(quoteId2)
				upnlSig = await getDummyPairUpnlAndPricesSig([quote2.requestedOpenPrice], [1n])
				await context.partyBBatchActionsFacet.connect(hedger.signer).openPositions([quoteId2], [decimal(100n)], [quote2.requestedOpenPrice], upnlSig)

				// Cross bucket should equal sum of both per-partyA locked values
				const crossBalance = await hedger.getBalanceInfoCrossPartyB()
				const perPartyA1 = await hedger.getBalanceInfo(partyA1)
				const perPartyA2 = await hedger.getBalanceInfo(partyA2)

				expect(crossBalance.lockedCva).to.equal(perPartyA1.lockedCva + perPartyA2.lockedCva)
				expect(crossBalance.lockedLf).to.equal(perPartyA1.lockedLf + perPartyA2.lockedLf)
				expect(crossBalance.lockedMmPartyB).to.equal(perPartyA1.lockedMmPartyB + perPartyA2.lockedMmPartyB)

				// Close position with user1
				await user.requestToClosePosition(quoteId1, limitCloseRequestBuilder().build())
				await hedger.fillCloseRequest(quoteId1, limitFillCloseRequestBuilder().filledAmount(decimal(100n)).build())

				// Cross bucket should now equal only user2's locked values
				const crossBalanceAfterClose = await hedger.getBalanceInfoCrossPartyB()
				const perPartyA1AfterClose = await hedger.getBalanceInfo(partyA1)
				const perPartyA2AfterClose = await hedger.getBalanceInfo(partyA2)

				expect(perPartyA1AfterClose.totalLockedPartyB).to.equal(0n)
				expect(crossBalanceAfterClose.lockedCva).to.equal(perPartyA1AfterClose.lockedCva + perPartyA2AfterClose.lockedCva)
				expect(crossBalanceAfterClose.lockedLf).to.equal(perPartyA1AfterClose.lockedLf + perPartyA2AfterClose.lockedLf)
				expect(crossBalanceAfterClose.lockedMmPartyB).to.equal(perPartyA1AfterClose.lockedMmPartyB + perPartyA2AfterClose.lockedMmPartyB)
			})
		})

		describe("Cross bucket sync during partyB liquidation", function () {
			it("Should zero cross bucket locked values when partyB is liquidated", async function () {
				const partyA = await user.getAddress()
				const partyB = await hedger.getAddress()

				// Open a position with minimal allocation to make liquidation possible
				await user.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB]).build())
				const quoteId = await context.viewFacetQuote.getNextQuoteId()

				// Allocate bare minimum for partyB
				await context.partyBAccountFacet.connect(hedger.signer).allocateForPartyB(decimal(65n), partyA)
				await hedger.lockQuote(quoteId, 0n, null) // null = don't auto-allocate

				const quote = await context.viewFacetQuote.getQuote(quoteId)
				const upnlSig = await getDummyPairUpnlAndPricesSig([quote.requestedOpenPrice], [1n])
				await context.partyBBatchActionsFacet.connect(hedger.signer).openPositions([quoteId], [decimal(100n)], [quote.requestedOpenPrice], upnlSig)

				// Verify cross bucket has locked values
				const crossBalanceBefore = await hedger.getBalanceInfoCrossPartyB()
				expect(crossBalanceBefore.totalLockedPartyB).to.be.greaterThan(0n)

				// Liquidate partyB with large negative upnl
				await context.partyBLiquidationFacet
					.connect(context.signers.liquidator)
					.liquidatePartyB(partyB, partyA, await getDummySingleUpnlSig(decimal(-100n)))

				// After liquidation, per-partyA locked should be zero
				const perPartyAAfterLiq = await hedger.getBalanceInfo(partyA)
				expect(perPartyAAfterLiq.totalLockedPartyB).to.equal(0n)
				expect(perPartyAAfterLiq.totalPendingLockedPartyB).to.equal(0n)

				// Cross bucket should also be zero (was synced before zeroing per-partyA)
				const crossBalanceAfter = await hedger.getBalanceInfoCrossPartyB()
				expect(crossBalanceAfter.totalLockedPartyB).to.equal(0n)
				expect(crossBalanceAfter.totalPendingLockedPartyB).to.equal(0n)
			})

			it("Should correctly handle cross bucket when partyB has positions with multiple partyAs and one is liquidated", async function () {
				const partyA1 = await user.getAddress()
				const partyA2 = await user2.getAddress()
				const partyB = await hedger.getAddress()

				// Open position with user1 (minimal allocation for liquidation)
				await user.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB]).build())
				const quoteId1 = await context.viewFacetQuote.getNextQuoteId()
				await context.partyBAccountFacet.connect(hedger.signer).allocateForPartyB(decimal(65n), partyA1)
				await hedger.lockQuote(quoteId1, 0n, null)
				const quote1 = await context.viewFacetQuote.getQuote(quoteId1)
				let upnlSig = await getDummyPairUpnlAndPricesSig([quote1.requestedOpenPrice], [1n])
				await context.partyBBatchActionsFacet.connect(hedger.signer).openPositions([quoteId1], [decimal(100n)], [quote1.requestedOpenPrice], upnlSig)

				// Open position with user2 (normal allocation)
				await user2.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB]).build())
				const quoteId2 = await context.viewFacetQuote.getNextQuoteId()
				await hedger.lockQuote(quoteId2)
				const quote2 = await context.viewFacetQuote.getQuote(quoteId2)
				upnlSig = await getDummyPairUpnlAndPricesSig([quote2.requestedOpenPrice], [1n])
				await context.partyBBatchActionsFacet.connect(hedger.signer).openPositions([quoteId2], [decimal(100n)], [quote2.requestedOpenPrice], upnlSig)

				// Get locked values before liquidation
				const perPartyA1Before = await hedger.getBalanceInfo(partyA1)
				const perPartyA2Before = await hedger.getBalanceInfo(partyA2)
				const crossBalanceBefore = await hedger.getBalanceInfoCrossPartyB()

				// Cross bucket should equal sum of both
				expect(crossBalanceBefore.totalLockedPartyB).to.equal(perPartyA1Before.totalLockedPartyB + perPartyA2Before.totalLockedPartyB)

				// Liquidate partyB for partyA1 only
				await context.partyBLiquidationFacet
					.connect(context.signers.liquidator)
					.liquidatePartyB(partyB, partyA1, await getDummySingleUpnlSig(decimal(-100n)))

				// After liquidation:
				// - perPartyA1 locked should be zero
				// - perPartyA2 locked should be unchanged
				// - cross bucket should equal perPartyA2 (= original - partyA1's values)
				const perPartyA1After = await hedger.getBalanceInfo(partyA1)
				const perPartyA2After = await hedger.getBalanceInfo(partyA2)
				const crossBalanceAfter = await hedger.getBalanceInfoCrossPartyB()

				expect(perPartyA1After.totalLockedPartyB).to.equal(0n)
				expect(perPartyA2After.totalLockedPartyB).to.equal(perPartyA2Before.totalLockedPartyB)
				expect(crossBalanceAfter.totalLockedPartyB).to.equal(perPartyA2After.totalLockedPartyB)
			})
		})

		describe("Cross bucket sync during partyA liquidation", function () {
			it("Should update cross bucket when partyA pending quotes are liquidated", async function () {
				const partyA = await user.getAddress()
				const partyB = await hedger.getAddress()

				// First open a position (required for liquidation)
				await user.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB]).build())
				const openedQuoteId = await context.viewFacetQuote.getNextQuoteId()
				await hedger.lockQuote(openedQuoteId)
				const openedQuote = await context.viewFacetQuote.getQuote(openedQuoteId)
				const upnlSig = await getDummyPairUpnlAndPricesSig([openedQuote.requestedOpenPrice], [1n])
				await context.partyBBatchActionsFacet
					.connect(hedger.signer)
					.openPositions([openedQuoteId], [decimal(100n)], [openedQuote.requestedOpenPrice], upnlSig)

				// Send another quote and lock (creates pending locked values)
				await user.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB]).build())
				const pendingQuoteId = await context.viewFacetQuote.getNextQuoteId()
				await hedger.lockQuote(pendingQuoteId)

				// Verify pending locked values exist in cross bucket
				const crossBalanceBefore = await hedger.getBalanceInfoCrossPartyB()
				expect(crossBalanceBefore.totalPendingLockedPartyB).to.be.greaterThan(0n)

				// Liquidate partyA
				const allocatedBalance = decimal(500n)
				const liquidationSig = await getDummyLiquidationSig("0x01", -decimal(600n), [1n], [decimal(1n)], -decimal(600n), allocatedBalance)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePartyA(partyA, liquidationSig)

				// Liquidate pending positions
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePendingPositionsPartyA(partyA)

				// After liquidation, pending locked should be zero for both per-partyA and cross bucket
				const perPartyAAfter = await hedger.getBalanceInfo(partyA)
				const crossBalanceAfter = await hedger.getBalanceInfoCrossPartyB()

				expect(perPartyAAfter.totalPendingLockedPartyB).to.equal(0n)
				expect(crossBalanceAfter.totalPendingLockedPartyB).to.equal(0n)
			})

			it("Should update cross bucket when partyA opened positions are liquidated", async function () {
				const partyA = await user.getAddress()
				const partyB = await hedger.getAddress()

				// Open a position
				await user.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB]).build())
				const quoteId = await context.viewFacetQuote.getNextQuoteId()
				await hedger.lockQuote(quoteId)
				const quote = await context.viewFacetQuote.getQuote(quoteId)
				const upnlSig = await getDummyPairUpnlAndPricesSig([quote.requestedOpenPrice], [1n])
				await context.partyBBatchActionsFacet.connect(hedger.signer).openPositions([quoteId], [decimal(100n)], [quote.requestedOpenPrice], upnlSig)

				// Verify locked values exist in cross bucket
				const crossBalanceBefore = await hedger.getBalanceInfoCrossPartyB()
				expect(crossBalanceBefore.totalLockedPartyB).to.be.greaterThan(0n)

				// Liquidate partyA
				const allocatedBalance = decimal(500n)
				const liquidationSig = await getDummyLiquidationSig("0x01", -decimal(600n), [1n], [decimal(1n)], -decimal(600n), allocatedBalance)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePartyA(partyA, liquidationSig)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).setSymbolsPrice(partyA, liquidationSig)

				// Liquidate positions
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePositionsPartyA(partyA, [quoteId])

				// After liquidation, locked values should be zero for both per-partyA and cross bucket
				const perPartyAAfter = await hedger.getBalanceInfo(partyA)
				const crossBalanceAfter = await hedger.getBalanceInfoCrossPartyB()

				expect(perPartyAAfter.totalLockedPartyB).to.equal(0n)
				expect(crossBalanceAfter.totalLockedPartyB).to.equal(0n)
			})
		})

		describe("Cross bucket nonce tracking", function () {
			it("Should increment cross bucket nonce when position is opened", async function () {
				const partyA = await user.getAddress()
				const partyB = await hedger.getAddress()

				const nonceBefore = await context.viewFacet.nonceOfPartyB(partyB, ZeroAddress)

				// Open a position
				await user.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB]).build())
				const quoteId = await context.viewFacetQuote.getNextQuoteId()
				await hedger.lockQuote(quoteId)
				const quote = await context.viewFacetQuote.getQuote(quoteId)
				const upnlSig = await getDummyPairUpnlAndPricesSig([quote.requestedOpenPrice], [1n])
				await context.partyBBatchActionsFacet.connect(hedger.signer).openPositions([quoteId], [decimal(100n)], [quote.requestedOpenPrice], upnlSig)

				const nonceAfter = await context.viewFacet.nonceOfPartyB(partyB, ZeroAddress)
				const perPartyANonce = await context.viewFacet.nonceOfPartyB(partyB, partyA)

				// Both nonces should have been incremented
				expect(nonceAfter).to.be.greaterThan(nonceBefore)
				expect(nonceAfter).to.equal(perPartyANonce)
			})
		})
	})
}
