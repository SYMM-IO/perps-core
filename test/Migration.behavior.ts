import { loadFixture } from "./helpers/network-helpers.js"
import { expect } from "chai"
import { ZeroAddress, toUtf8Bytes } from "ethers"

import { initializeFixture } from "./Initialize.fixture.js"
import { RunContext } from "./models/RunContext.js"
import { Hedger } from "./models/Hedger.js"
import { User } from "./models/User.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { decimal } from "./utils/Common.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { getDummyLiquidationSig, getDummyPairUpnlAndPricesSig, getDummySingleUpnlSig } from "./utils/SignatureUtils.js"
import { QuoteStatus } from "./models/Enums.js"

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
			await expect(
				context.migrationFacet.connect(context.signers.user).migrateQuotes([1])
			).to.be.revertedWith("Accessibility: Must has role")

			// Admin should be able to call it
			await expect(
				context.migrationFacet.connect(context.signers.admin).migrateQuotes([])
			).to.not.be.reverted
		})

		it("Should emit QuotesMigrated event", async function () {
			await expect(
				context.migrationFacet.connect(context.signers.admin).migrateQuotes([])
			).to.emit(context.migrationFacet, "QuotesMigrated").withArgs(0, 0)
		})

		it("Should skip non-existent quote IDs", async function () {
			// Try to migrate non-existent quote IDs
			await expect(
				context.migrationFacet.connect(context.signers.admin).migrateQuotes([999, 1000, 1001])
			).to.emit(context.migrationFacet, "QuotesMigrated").withArgs(3, 0)
		})

		it("Should return false for non-migrated quotes", async function () {
			expect(await context.migrationFacet.isQuoteMigrated(1)).to.equal(false)
			expect(await context.migrationFacet.isQuoteMigrated(999)).to.equal(false)
		})
	})

	describe("migrateMasterAccountLockedValues", function () {
		it("Should allow only MIGRATION_ROLE to call migrateMasterAccountLockedValues", async function () {
			const partyB = await hedger.getAddress()

			await expect(
				context.migrationFacet.connect(context.signers.user).migrateMasterAccountLockedValues(partyB, [])
			).to.be.revertedWith("Accessibility: Must has role")

			// Admin should be able to call it
			await expect(
				context.migrationFacet.connect(context.signers.admin).migrateMasterAccountLockedValues(partyB, [])
			).to.not.be.reverted
		})

		it("Should emit MasterAccountLockedValuesMigrated event", async function () {
			const partyB = await hedger.getAddress()

			await expect(
				context.migrationFacet.connect(context.signers.admin).migrateMasterAccountLockedValues(partyB, [])
			).to.emit(context.migrationFacet, "MasterAccountLockedValuesMigrated").withArgs(partyB, 0)
		})

		it("Should prevent double migration of partyB locked values", async function () {
			const partyB = await hedger.getAddress()

			// First migration should succeed
			await context.migrationFacet.connect(context.signers.admin).migrateMasterAccountLockedValues(partyB, [])

			// Second migration should fail
			await expect(
				context.migrationFacet.connect(context.signers.admin).migrateMasterAccountLockedValues(partyB, [])
			).to.be.revertedWith("MigrationFacet: Already migrated")
		})

		it("Should aggregate partyA balances to master bucket", async function () {
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
			await context.migrationFacet.connect(context.signers.admin).migrateMasterAccountLockedValues(partyB, [partyA1, partyA2])

			// Verify master bucket has aggregated balances
			const masterBalance = await context.viewFacet.balanceInfoOfPartyBMasterAccount(partyB)
			expect(masterBalance[0]).to.equal(allocateA1 + allocateA2)
		})

		it("Should correctly track migration status", async function () {
			const partyB = await hedger.getAddress()

			expect(await context.migrationFacet.isPartyBLockedValuesMigrated(partyB)).to.equal(false)

			await context.migrationFacet.connect(context.signers.admin).migrateMasterAccountLockedValues(partyB, [])

			expect(await context.migrationFacet.isPartyBLockedValuesMigrated(partyB)).to.equal(true)
		})
	})

	describe("setPartyBMasterAccountMode", function () {
		beforeEach(async function () {
			// Enable master account feature globally
			await context.controlFacet.connect(context.signers.admin).setMasterAccountEnabled(true)
		})

		it("Should allow only MIGRATION_ROLE to call setPartyBMasterAccountMode", async function () {
			const partyB = await hedger.getAddress()

			await expect(
				context.controlFacet.connect(context.signers.user).setPartyBMasterAccountMode(partyB, true)
			).to.be.revertedWith("Accessibility: Must has role")

			// Admin should be able to call it (has MIGRATION_ROLE)
			await expect(
				context.controlFacet.connect(context.signers.admin).setPartyBMasterAccountMode(partyB, true)
			).to.not.be.reverted
		})

		it("Should require master account feature to be enabled", async function () {
			const partyB = await hedger.getAddress()

			// Disable master account feature
			await context.controlFacet.connect(context.signers.admin).setMasterAccountEnabled(false)

			await expect(
				context.controlFacet.connect(context.signers.admin).setPartyBMasterAccountMode(partyB, true)
			).to.be.revertedWith("ControlFacet: Master account feature disabled")
		})

		it("Should require partyB to be registered", async function () {
			await expect(
				context.controlFacet.connect(context.signers.admin).setPartyBMasterAccountMode(context.signers.user.address, true)
			).to.be.revertedWith("ControlFacet: Address is not PartyB")
		})

		it("Should emit SetPartyBMasterAccountMode event", async function () {
			const partyB = await hedger.getAddress()

			await expect(
				context.controlFacet.connect(context.signers.admin).setPartyBMasterAccountMode(partyB, true)
			).to.emit(context.controlFacet, "SetPartyBMasterAccountMode").withArgs(partyB, true)
		})

		it("Should only allow allocations to master bucket after master mode is enabled", async function () {
			const partyB = await hedger.getAddress()
			const allocateAmount = decimal(200n)

			// Enable master account mode
			await context.controlFacet.connect(context.signers.admin).setPartyBMasterAccountMode(partyB, true)

			// Allocating to a specific partyA should fail
			await expect(
				context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateAmount, context.signers.user.address)
			).to.be.revertedWith("PartyBFacet: Master account mode is active")

			// Allocating to master bucket (address(0)) should succeed
			await expect(
				context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateAmount, ZeroAddress)
			).to.not.be.reverted
		})
	})

	describe("beginMigration and finalizeMigration", function () {
		it("Should allow only MIGRATION_ROLE to call beginMigration", async function () {
			const partyB = await hedger.getAddress()

			await expect(
				context.migrationFacet.connect(context.signers.user).beginMigration(partyB)
			).to.be.revertedWith("Accessibility: Must has role")

			await expect(
				context.migrationFacet.connect(context.signers.admin).beginMigration(partyB)
			).to.not.be.reverted
		})

		it("Should require partyB to be registered", async function () {
			await expect(
				context.migrationFacet.connect(context.signers.admin).beginMigration(context.signers.user.address)
			).to.be.revertedWith("MigrationFacet: Address is not PartyB")
		})

		it("Should prevent double begin migration", async function () {
			const partyB = await hedger.getAddress()

			await context.migrationFacet.connect(context.signers.admin).beginMigration(partyB)

			await expect(
				context.migrationFacet.connect(context.signers.admin).beginMigration(partyB)
			).to.be.revertedWith("MigrationFacet: Migration already in progress")
		})

		it("Should pause partyB actions during migration", async function () {
			const partyB = await hedger.getAddress()
			const allocateAmount = decimal(100n)

			// Begin migration
			await context.migrationFacet.connect(context.signers.admin).beginMigration(partyB)

			// partyB should be paused and unable to allocate
			await expect(
				context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateAmount, context.signers.user.address)
			).to.be.revertedWith("Pausable: PartyB migration paused")
		})

		it("Should emit MigrationBegun event", async function () {
			const partyB = await hedger.getAddress()

			await expect(
				context.migrationFacet.connect(context.signers.admin).beginMigration(partyB)
			).to.emit(context.migrationFacet, "MigrationBegun").withArgs(partyB)
		})

		it("Should require migration to be in progress for finalize", async function () {
			const partyB = await hedger.getAddress()

			await expect(
				context.migrationFacet.connect(context.signers.admin).finalizeMigration(partyB, false)
			).to.be.revertedWith("MigrationFacet: Migration not in progress")
		})

		it("Should require locked values migrated before enabling master mode", async function () {
			const partyB = await hedger.getAddress()

			await context.controlFacet.connect(context.signers.admin).setMasterAccountEnabled(true)
			await context.migrationFacet.connect(context.signers.admin).beginMigration(partyB)

			await expect(
				context.migrationFacet.connect(context.signers.admin).finalizeMigration(partyB, true)
			).to.be.revertedWith("MigrationFacet: Locked values not migrated")
		})

		it("Should unpause partyB after finalize without master mode", async function () {
			const partyB = await hedger.getAddress()
			const allocateAmount = decimal(100n)

			// Begin migration
			await context.migrationFacet.connect(context.signers.admin).beginMigration(partyB)

			// Finalize without enabling master mode
			await context.migrationFacet.connect(context.signers.admin).finalizeMigration(partyB, false)

			// partyB should be able to allocate again
			await expect(
				context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateAmount, context.signers.user.address)
			).to.not.be.reverted
		})

		it("Should emit MigrationFinalized event", async function () {
			const partyB = await hedger.getAddress()

			await context.migrationFacet.connect(context.signers.admin).beginMigration(partyB)

			await expect(
				context.migrationFacet.connect(context.signers.admin).finalizeMigration(partyB, false)
			).to.emit(context.migrationFacet, "MigrationFinalized").withArgs(partyB, false)
		})

		it("Should track migration in progress status", async function () {
			const partyB = await hedger.getAddress()

			expect(await context.migrationFacet.isPartyBMigrationInProgress(partyB)).to.equal(false)

			await context.migrationFacet.connect(context.signers.admin).beginMigration(partyB)
			expect(await context.migrationFacet.isPartyBMigrationInProgress(partyB)).to.equal(true)

			await context.migrationFacet.connect(context.signers.admin).finalizeMigration(partyB, false)
			expect(await context.migrationFacet.isPartyBMigrationInProgress(partyB)).to.equal(false)
		})
	})

	describe("Full migration flow with pause", function () {
		it("Should complete full migration flow: begin -> migrate -> finalize with master mode", async function () {
			const partyB = await hedger.getAddress()
			const partyA1 = context.signers.user.address
			const partyA2 = context.signers.user2.address
			const allocateA1 = decimal(200n)
			const allocateA2 = decimal(150n)

			// Enable master account feature globally
			await context.controlFacet.connect(context.signers.admin).setMasterAccountEnabled(true)

			// Set up allocations
			await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateA1, partyA1)
			await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateA2, partyA2)

			// Step 1: Begin migration (pause partyB)
			await context.migrationFacet.connect(context.signers.admin).beginMigration(partyB)

			// Verify partyB is paused
			expect(await context.migrationFacet.isPartyBMigrationInProgress(partyB)).to.equal(true)

			// Step 2: Migrate locked values
			await context.migrationFacet.connect(context.signers.admin).migrateMasterAccountLockedValues(partyB, [partyA1, partyA2])

			// Verify master bucket has aggregated balances
			const masterBalance = await context.viewFacet.balanceInfoOfPartyBMasterAccount(partyB)
			expect(masterBalance[0]).to.equal(allocateA1 + allocateA2)

			// Step 3: Finalize migration (enable master mode and unpause)
			await context.migrationFacet.connect(context.signers.admin).finalizeMigration(partyB, true)

			// Verify master account mode is enabled
			expect(await context.viewFacet.isInMasterAccountMode(partyB)).to.equal(true)

			// Verify partyB is unpaused
			expect(await context.migrationFacet.isPartyBMigrationInProgress(partyB)).to.equal(false)

			// Per-partyA allocations should now fail (master mode active)
			await expect(
				context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(decimal(100n), partyA1)
			).to.be.revertedWith("PartyBFacet: Master account mode is active")

			// Master bucket allocations should work
			await expect(
				context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(decimal(100n), ZeroAddress)
			).to.not.be.reverted
		})
	})

	describe("Master bucket tracking correctness", function () {
		let user2: User, hedger2: Hedger

		beforeEach(async function () {
			user2 = new User(context, context.signers.user2)
			await user2.setup()
			await user2.setBalances(decimal(2000n), decimal(1000n), decimal(500n))

			hedger2 = new Hedger(context, context.signers.hedger2)
			await hedger2.setup()
			await hedger2.setBalances(decimal(2000n), decimal(1000n))
		})

		describe("Master bucket sync during position lifecycle", function () {
			it("Should update master bucket locked values when opening a position", async function () {
				const partyA = await user.getAddress()
				const partyB = await hedger.getAddress()

				// Get initial master bucket state
				const masterBalanceBefore = await hedger.getBalanceInfoMasterAccount()
				expect(masterBalanceBefore.totalLockedPartyB).to.equal(0n)

				// Send quote and lock
				await user.sendQuote(
					limitQuoteRequestBuilder()
						.partyBWhiteList([partyB])
						.build()
				)
				const quoteId = await context.viewFacetQuote.getNextQuoteId()
				await hedger.lockQuote(quoteId)

				// Check pending locked values in master bucket after lock
				const masterBalanceAfterLock = await hedger.getBalanceInfoMasterAccount()
				const perPartyAAfterLock = await hedger.getBalanceInfo(partyA)

				// Master bucket pending locked should equal per-partyA pending locked
				expect(masterBalanceAfterLock.pendingLockedCva).to.equal(perPartyAAfterLock.pendingLockedCva)
				expect(masterBalanceAfterLock.pendingLockedLf).to.equal(perPartyAAfterLock.pendingLockedLf)
				expect(masterBalanceAfterLock.pendingLockedMmPartyB).to.equal(perPartyAAfterLock.pendingLockedMmPartyB)

				// Open position
				const quote = await context.viewFacetQuote.getQuote(quoteId)
				const upnlSig = await getDummyPairUpnlAndPricesSig([quote.requestedOpenPrice], [1n])
				await context.partyBBatchActionsFacet.connect(hedger.signer).openPositions([quoteId], [decimal(100n)], [quote.requestedOpenPrice], upnlSig)

				// After open, master bucket locked should equal per-partyA locked
				const masterBalanceAfterOpen = await hedger.getBalanceInfoMasterAccount()
				const perPartyAAfterOpen = await hedger.getBalanceInfo(partyA)

				expect(masterBalanceAfterOpen.lockedCva).to.equal(perPartyAAfterOpen.lockedCva)
				expect(masterBalanceAfterOpen.lockedLf).to.equal(perPartyAAfterOpen.lockedLf)
				expect(masterBalanceAfterOpen.lockedMmPartyB).to.equal(perPartyAAfterOpen.lockedMmPartyB)
				expect(masterBalanceAfterOpen.pendingLockedCva).to.equal(0n)
				expect(masterBalanceAfterOpen.pendingLockedLf).to.equal(0n)
			})

			it("Should update master bucket locked values when closing a position", async function () {
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
				const masterBalanceAfterOpen = await hedger.getBalanceInfoMasterAccount()
				const perPartyAAfterOpen = await hedger.getBalanceInfo(partyA)

				expect(masterBalanceAfterOpen.totalLockedPartyB).to.be.greaterThan(0n)
				expect(masterBalanceAfterOpen.totalLockedPartyB).to.equal(perPartyAAfterOpen.totalLockedPartyB)

				// Request close and fill it
				await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().build())
				await hedger.fillCloseRequest(quoteId, limitFillCloseRequestBuilder().filledAmount(decimal(100n)).build())

				// After full close, master bucket locked should be zero (equal to per-partyA)
				const masterBalanceAfterClose = await hedger.getBalanceInfoMasterAccount()
				const perPartyAAfterClose = await hedger.getBalanceInfo(partyA)

				expect(masterBalanceAfterClose.totalLockedPartyB).to.equal(0n)
				expect(masterBalanceAfterClose.totalLockedPartyB).to.equal(perPartyAAfterClose.totalLockedPartyB)
			})

			it("Should track master bucket correctly with multiple partyAs", async function () {
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

				// Master bucket should equal sum of both per-partyA locked values
				const masterBalance = await hedger.getBalanceInfoMasterAccount()
				const perPartyA1 = await hedger.getBalanceInfo(partyA1)
				const perPartyA2 = await hedger.getBalanceInfo(partyA2)

				expect(masterBalance.lockedCva).to.equal(perPartyA1.lockedCva + perPartyA2.lockedCva)
				expect(masterBalance.lockedLf).to.equal(perPartyA1.lockedLf + perPartyA2.lockedLf)
				expect(masterBalance.lockedMmPartyB).to.equal(perPartyA1.lockedMmPartyB + perPartyA2.lockedMmPartyB)

				// Close position with user1
				await user.requestToClosePosition(quoteId1, limitCloseRequestBuilder().build())
				await hedger.fillCloseRequest(quoteId1, limitFillCloseRequestBuilder().filledAmount(decimal(100n)).build())

				// Master bucket should now equal only user2's locked values
				const masterBalanceAfterClose = await hedger.getBalanceInfoMasterAccount()
				const perPartyA1AfterClose = await hedger.getBalanceInfo(partyA1)
				const perPartyA2AfterClose = await hedger.getBalanceInfo(partyA2)

				expect(perPartyA1AfterClose.totalLockedPartyB).to.equal(0n)
				expect(masterBalanceAfterClose.lockedCva).to.equal(perPartyA1AfterClose.lockedCva + perPartyA2AfterClose.lockedCva)
				expect(masterBalanceAfterClose.lockedLf).to.equal(perPartyA1AfterClose.lockedLf + perPartyA2AfterClose.lockedLf)
				expect(masterBalanceAfterClose.lockedMmPartyB).to.equal(perPartyA1AfterClose.lockedMmPartyB + perPartyA2AfterClose.lockedMmPartyB)
			})
		})

		describe("Master bucket sync during partyB liquidation", function () {
			it("Should zero master bucket locked values when partyB is liquidated", async function () {
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

				// Verify master bucket has locked values
				const masterBalanceBefore = await hedger.getBalanceInfoMasterAccount()
				expect(masterBalanceBefore.totalLockedPartyB).to.be.greaterThan(0n)

				// Liquidate partyB with large negative upnl
				await context.partyBLiquidationFacet
					.connect(context.signers.liquidator)
					.liquidatePartyB(partyB, partyA, await getDummySingleUpnlSig(decimal(-100n)))

				// After liquidation, per-partyA locked should be zero
				const perPartyAAfterLiq = await hedger.getBalanceInfo(partyA)
				expect(perPartyAAfterLiq.totalLockedPartyB).to.equal(0n)
				expect(perPartyAAfterLiq.totalPendingLockedPartyB).to.equal(0n)

				// Master bucket should also be zero (was synced before zeroing per-partyA)
				const masterBalanceAfter = await hedger.getBalanceInfoMasterAccount()
				expect(masterBalanceAfter.totalLockedPartyB).to.equal(0n)
				expect(masterBalanceAfter.totalPendingLockedPartyB).to.equal(0n)
			})

			it("Should correctly handle master bucket when partyB has positions with multiple partyAs and one is liquidated", async function () {
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
				const masterBalanceBefore = await hedger.getBalanceInfoMasterAccount()

				// Master bucket should equal sum of both
				expect(masterBalanceBefore.totalLockedPartyB).to.equal(
					perPartyA1Before.totalLockedPartyB + perPartyA2Before.totalLockedPartyB
				)

				// Liquidate partyB for partyA1 only
				await context.partyBLiquidationFacet
					.connect(context.signers.liquidator)
					.liquidatePartyB(partyB, partyA1, await getDummySingleUpnlSig(decimal(-100n)))

				// After liquidation:
				// - perPartyA1 locked should be zero
				// - perPartyA2 locked should be unchanged
				// - master bucket should equal perPartyA2 (= original - partyA1's values)
				const perPartyA1After = await hedger.getBalanceInfo(partyA1)
				const perPartyA2After = await hedger.getBalanceInfo(partyA2)
				const masterBalanceAfter = await hedger.getBalanceInfoMasterAccount()

				expect(perPartyA1After.totalLockedPartyB).to.equal(0n)
				expect(perPartyA2After.totalLockedPartyB).to.equal(perPartyA2Before.totalLockedPartyB)
				expect(masterBalanceAfter.totalLockedPartyB).to.equal(perPartyA2After.totalLockedPartyB)
			})
		})

		describe("Master bucket sync during partyA liquidation", function () {
			it("Should update master bucket when partyA pending quotes are liquidated", async function () {
				const partyA = await user.getAddress()
				const partyB = await hedger.getAddress()

				// Send quote and lock (creates pending locked values)
				await user.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB]).build())
				const quoteId = await context.viewFacetQuote.getNextQuoteId()
				await hedger.lockQuote(quoteId)

				// Verify pending locked values exist in master bucket
				const masterBalanceBefore = await hedger.getBalanceInfoMasterAccount()
				expect(masterBalanceBefore.totalPendingLockedPartyB).to.be.greaterThan(0n)

				// Liquidate partyA
				const allocatedBalance = decimal(500n)
				const liquidationSig = await getDummyLiquidationSig("0x01", -decimal(600n), [1n], [decimal(1n)], -decimal(600n), allocatedBalance)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePartyA(partyA, liquidationSig)

				// Liquidate pending positions
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePendingPositionsPartyA(partyA)

				// After liquidation, pending locked should be zero for both per-partyA and master bucket
				const perPartyAAfter = await hedger.getBalanceInfo(partyA)
				const masterBalanceAfter = await hedger.getBalanceInfoMasterAccount()

				expect(perPartyAAfter.totalPendingLockedPartyB).to.equal(0n)
				expect(masterBalanceAfter.totalPendingLockedPartyB).to.equal(0n)
			})

			it("Should update master bucket when partyA opened positions are liquidated", async function () {
				const partyA = await user.getAddress()
				const partyB = await hedger.getAddress()

				// Open a position
				await user.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB]).build())
				const quoteId = await context.viewFacetQuote.getNextQuoteId()
				await hedger.lockQuote(quoteId)
				const quote = await context.viewFacetQuote.getQuote(quoteId)
				const upnlSig = await getDummyPairUpnlAndPricesSig([quote.requestedOpenPrice], [1n])
				await context.partyBBatchActionsFacet.connect(hedger.signer).openPositions([quoteId], [decimal(100n)], [quote.requestedOpenPrice], upnlSig)

				// Verify locked values exist in master bucket
				const masterBalanceBefore = await hedger.getBalanceInfoMasterAccount()
				expect(masterBalanceBefore.totalLockedPartyB).to.be.greaterThan(0n)

				// Liquidate partyA
				const allocatedBalance = decimal(500n)
				const liquidationSig = await getDummyLiquidationSig("0x01", -decimal(600n), [1n], [decimal(1n)], -decimal(600n), allocatedBalance)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePartyA(partyA, liquidationSig)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).setSymbolsPrice(partyA, liquidationSig)

				// Liquidate positions
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePositionsPartyA(partyA, [quoteId])

				// After liquidation, locked values should be zero for both per-partyA and master bucket
				const perPartyAAfter = await hedger.getBalanceInfo(partyA)
				const masterBalanceAfter = await hedger.getBalanceInfoMasterAccount()

				expect(perPartyAAfter.totalLockedPartyB).to.equal(0n)
				expect(masterBalanceAfter.totalLockedPartyB).to.equal(0n)
			})
		})

		describe("Master bucket nonce tracking", function () {
			it("Should increment master bucket nonce when position is opened", async function () {
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
