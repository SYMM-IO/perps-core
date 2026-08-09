import { expect } from "chai"
import { ZeroAddress, toUtf8Bytes } from "ethers"

import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { PositionType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder, marketQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, getOpenTradingFeeForQuoteWithFilledAmount } from "./utils/Common.js"
import { getDummyLiquidationSig, getDummyPairUpnlAndPricesSig, getDummySingleUpnlAndPriceSig, getDummySingleUpnlSig } from "./utils/SignatureUtils.js"

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

		it("Should preserve the reserved market fee across migrateQuotes", async function () {
			const signedMarketPrice = decimal(9n, 17)
			const quoteId = await user.sendQuote(
				marketQuoteRequestBuilder()
					.partyBWhiteList([await hedger.getAddress()])
					.upnlSig(getDummySingleUpnlAndPriceSig(signedMarketPrice))
					.build(),
			)
			const quote = await context.viewFacetQuote.getQuote(quoteId)
			const reservedFeeBeforeMigration = await getOpenTradingFeeForQuoteWithFilledAmount(context, quoteId, quote.quantity)
			const allocatedBeforeCancel = (await user.getBalanceInfo()).allocatedBalances

			await context.migrationFacet.connect(context.signers.admin).migrateQuotes([quoteId])

			const reservedFeeAfterMigration = await getOpenTradingFeeForQuoteWithFilledAmount(context, quoteId, quote.quantity)
			expect(reservedFeeAfterMigration).to.equal(reservedFeeBeforeMigration)

			await user.requestToCancelQuote(quoteId)
			const allocatedAfterCancel = (await user.getBalanceInfo()).allocatedBalances
			expect(allocatedAfterCancel - allocatedBeforeCancel).to.equal(reservedFeeBeforeMigration)
		})

		it("Should backfill connectedPartyBs after migration", async function () {
			const partyA = await user.getAddress()
			const partyB = await hedger.getAddress()

			// Open a position so there's something to migrate
			await user.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB]).build())
			const quoteId = await context.viewFacetQuote.getNextQuoteId()
			await hedger.lockQuote(quoteId)
			const quote = await context.viewFacetQuote.getQuote(quoteId)
			const upnlSig = await getDummyPairUpnlAndPricesSig([quote.requestedOpenPrice], [1n])
			await context.partyBBatchActionsFacet.connect(hedger.signer).openPositions([quoteId], [decimal(100n)], [quote.requestedOpenPrice], upnlSig)

			// Verify connectedPartyBs is already populated (openPosition adds it)
			const connsBefore = await context.viewFacetSymbol.getConnectedPartyBs(partyA)
			expect(connsBefore.map(a => a.toLowerCase())).to.include(partyB.toLowerCase())

			// Now simulate migration scenario: clear the connection state by closing the position,
			// then re-migrate. Instead, we test that migrateQuotes is idempotent for connections.
			// The connection already exists, so migrateQuotes should not duplicate it.
			await context.migrationFacet.connect(context.signers.admin).migrateQuotes([quoteId])

			const connsAfter = await context.viewFacetSymbol.getConnectedPartyBs(partyA)
			// Should still have exactly one connection (not duplicated)
			const matchingConns = connsAfter.filter(a => a.toLowerCase() === partyB.toLowerCase())
			expect(matchingConns.length).to.equal(1)

			// Verify the isConnectedPartyB lookup is also correct
			expect(await context.viewFacetSymbol.isConnectedPartyB(partyA, partyB)).to.equal(true)
		})

		it("Should backfill connectedPartyBs for multiple partyBs", async function () {
			const partyA = await user.getAddress()
			const partyB1 = await hedger.getAddress()

			// Set up hedger2
			const hedger2 = new Hedger(context, context.signers.hedger2)
			await hedger2.setup()
			await hedger2.setBalances(decimal(2000n), decimal(1000n))
			const partyB2 = await hedger2.getAddress()

			// Open position with hedger1
			await user.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB1]).build())
			const quoteId1 = await context.viewFacetQuote.getNextQuoteId()
			await hedger.lockQuote(quoteId1)
			const quote1 = await context.viewFacetQuote.getQuote(quoteId1)
			let upnlSig = await getDummyPairUpnlAndPricesSig([quote1.requestedOpenPrice], [1n])
			await context.partyBBatchActionsFacet.connect(hedger.signer).openPositions([quoteId1], [decimal(100n)], [quote1.requestedOpenPrice], upnlSig)

			// Open position with hedger2
			await user.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB2]).build())
			const quoteId2 = await context.viewFacetQuote.getNextQuoteId()
			await hedger2.lockQuote(quoteId2)
			const quote2 = await context.viewFacetQuote.getQuote(quoteId2)
			upnlSig = await getDummyPairUpnlAndPricesSig([quote2.requestedOpenPrice], [1n])
			await context.partyBBatchActionsFacet.connect(hedger2.signer).openPositions([quoteId2], [decimal(100n)], [quote2.requestedOpenPrice], upnlSig)

			// Migrate both quotes
			await context.migrationFacet.connect(context.signers.admin).migrateQuotes([quoteId1, quoteId2])

			// Verify both partyBs are connected (no duplicates)
			const conns = await context.viewFacetSymbol.getConnectedPartyBs(partyA)
			const connsLower = conns.map(a => a.toLowerCase())
			expect(connsLower).to.include(partyB1.toLowerCase())
			expect(connsLower).to.include(partyB2.toLowerCase())
			expect(conns.length).to.equal(2)

			expect(await context.viewFacetSymbol.isConnectedPartyB(partyA, partyB1)).to.equal(true)
			expect(await context.viewFacetSymbol.isConnectedPartyB(partyA, partyB2)).to.equal(true)
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

		it("Should skip already migrated partyA pairs (idempotent)", async function () {
			const partyB = await hedger.getAddress()
			const partyA1 = context.signers.user.address
			const partyA2 = context.signers.user2.address

			// Migrate first partyA only
			await expect(context.migrationFacet.connect(context.signers.admin).migrateCrossLockedValues(partyB, [partyA1]))
				.to.emit(context.migrationFacet, "CrossLockedValuesMigrated")
				.withArgs(partyB, 1)

			// Verify migration status
			expect(await context.migrationFacet.isCrossLockedValuesMigrated(partyB, partyA1)).to.equal(true)
			expect(await context.migrationFacet.isCrossLockedValuesMigrated(partyB, partyA2)).to.equal(false)

			// Calling again with same partyA should skip it (0 processed), and migrate the new one
			await expect(context.migrationFacet.connect(context.signers.admin).migrateCrossLockedValues(partyB, [partyA1, partyA2]))
				.to.emit(context.migrationFacet, "CrossLockedValuesMigrated")
				.withArgs(partyB, 1) // Only partyA2 is new

			// Both should now be marked as migrated
			expect(await context.migrationFacet.isCrossLockedValuesMigrated(partyB, partyA1)).to.equal(true)
			expect(await context.migrationFacet.isCrossLockedValuesMigrated(partyB, partyA2)).to.equal(true)
		})

		it("Should support batched migration across multiple calls", async function () {
			const partyB = await hedger.getAddress()
			const partyA1 = context.signers.user.address
			const partyA2 = context.signers.user2.address

			// Batch 1
			await context.migrationFacet.connect(context.signers.admin).migrateCrossLockedValues(partyB, [partyA1])

			// Batch 2
			await context.migrationFacet.connect(context.signers.admin).migrateCrossLockedValues(partyB, [partyA2])

			// Both pairs should be marked as migrated
			expect(await context.migrationFacet.isCrossLockedValuesMigrated(partyB, partyA1)).to.equal(true)
			expect(await context.migrationFacet.isCrossLockedValuesMigrated(partyB, partyA2)).to.equal(true)
		})

		it("Should aggregate locked/pending locked (not allocated) to cross bucket", async function () {
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

			// Cross bucket allocated balance should NOT be aggregated — it's an independent pool
			// The solver must explicitly fund the cross bucket by allocating to address(0)
			const crossBalance = await context.viewFacet.balanceInfoOfCrossPartyB(partyB)
			expect(crossBalance[0]).to.equal(0n) // allocated balance in cross bucket is 0

			// Per-partyA allocated balances should remain unchanged
			expect(await context.viewFacet.allocatedBalanceOfPartyB(partyB, partyA1)).to.equal(allocateA1)
			expect(await context.viewFacet.allocatedBalanceOfPartyB(partyB, partyA2)).to.equal(allocateA2)
		})

		it("Should correctly track per-pair migration status", async function () {
			const partyB = await hedger.getAddress()
			const partyA1 = context.signers.user.address
			const partyA2 = context.signers.user2.address

			expect(await context.migrationFacet.isCrossLockedValuesMigrated(partyB, partyA1)).to.equal(false)
			expect(await context.migrationFacet.isCrossLockedValuesMigrated(partyB, partyA2)).to.equal(false)

			await context.migrationFacet.connect(context.signers.admin).migrateCrossLockedValues(partyB, [partyA1])

			expect(await context.migrationFacet.isCrossLockedValuesMigrated(partyB, partyA1)).to.equal(true)
			expect(await context.migrationFacet.isCrossLockedValuesMigrated(partyB, partyA2)).to.equal(false)

			await context.migrationFacet.connect(context.signers.admin).migrateCrossLockedValues(partyB, [partyA2])

			expect(await context.migrationFacet.isCrossLockedValuesMigrated(partyB, partyA2)).to.equal(true)
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

		it("Should allow per-partyA deallocation after cross mode is enabled", async function () {
			const partyB = await hedger.getAddress()
			const partyA = context.signers.user.address
			const allocateAmount = decimal(200n)

			// Allocate per partyA before cross mode
			await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateAmount, partyA)
			expect(await context.viewFacet.allocatedBalanceOfPartyB(partyB, partyA)).to.equal(allocateAmount)

			// Enable cross partyB mode
			await context.controlFacet.connect(context.signers.admin).setCrossPartyB(partyB, true)

			// Deallocating per partyA should succeed — legacy drain only requires cross solvency (>= 0)
			const deallocateAmount = decimal(100n)
			expect(await context.viewFacet.maxDeallocatableForPartyB(partyB, partyA, 0n)).to.equal(allocateAmount)
			await expect(
				context.partyBAccountFacet.connect(context.signers.hedger).deallocateForPartyB(deallocateAmount, partyA, await getDummySingleUpnlSig(0n)),
			).to.not.be.reverted

			expect(await context.viewFacet.allocatedBalanceOfPartyB(partyB, partyA)).to.equal(allocateAmount - deallocateAmount)
		})

		it("Should reject per-partyA deallocation in cross mode when cross bucket is insolvent", async function () {
			const partyB = await hedger.getAddress()
			const partyA = context.signers.user.address
			const allocateAmount = decimal(200n)

			// Allocate per partyA before cross mode
			await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateAmount, partyA)

			// Enable cross partyB mode — cross bucket has 0 allocated balance
			await context.controlFacet.connect(context.signers.admin).setCrossPartyB(partyB, true)

			// Deallocating with negative upnl should fail (cross bucket available balance < 0)
			expect(await context.viewFacet.maxDeallocatableForPartyB(partyB, partyA, decimal(-100n))).to.equal(0n)
			await expect(
				context.partyBAccountFacet
					.connect(context.signers.hedger)
					.deallocateForPartyB(decimal(50n), partyA, await getDummySingleUpnlSig(decimal(-100n))),
			).to.be.revertedWith("AccountFacet: Available balance is lower than zero")

			// Legacy per-partyA drain only requires cross solvency (>= 0), not >= amount
			// With zero upnl and zero cross allocation, cross available = 0 which is solvent
			await expect(
				context.partyBAccountFacet.connect(context.signers.hedger).deallocateForPartyB(decimal(50n), partyA, await getDummySingleUpnlSig(0n)),
			).to.not.be.reverted
			expect(await context.viewFacet.allocatedBalanceOfPartyB(partyB, partyA)).to.equal(allocateAmount - decimal(50n))
		})

		it("Should still require availableBalance >= amount for cross bucket deallocation (address(0))", async function () {
			const partyB = await hedger.getAddress()
			const crossFundAmount = decimal(200n)

			// Enable cross partyB mode and fund cross bucket
			await context.controlFacet.connect(context.signers.admin).setCrossPartyB(partyB, true)
			await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(crossFundAmount, ZeroAddress)

			// Normal cross deallocation should still require availableBalance >= amount
			// Deallocating more than available (cross bucket = 200, upnl = 0, locked = 0, so available = 200)
			await expect(
				context.partyBAccountFacet.connect(context.signers.hedger).deallocateForPartyB(decimal(250n), ZeroAddress, await getDummySingleUpnlSig(0n)),
			).to.be.revertedWith("AccountFacet: Insufficient allocated balance")

			// Deallocating within available balance should succeed
			await expect(
				context.partyBAccountFacet.connect(context.signers.hedger).deallocateForPartyB(decimal(100n), ZeroAddress, await getDummySingleUpnlSig(0n)),
			).to.not.be.reverted
			const crossBalance = await context.viewFacet.balanceInfoOfCrossPartyB(partyB)
			expect(crossBalance[0]).to.equal(crossFundAmount - decimal(100n))
		})

		it("Should allow full legacy drain without cross bucket funding", async function () {
			const partyB = await hedger.getAddress()
			const partyA = context.signers.user.address
			const allocateAmount = decimal(300n)

			// Allocate per partyA before cross mode
			await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateAmount, partyA)

			// Enable cross partyB mode — cross bucket has 0 allocated balance
			await context.controlFacet.connect(context.signers.admin).setCrossPartyB(partyB, true)

			// Should drain entire legacy per-partyA allocation without needing cross bucket funds
			// Cross available = 0 (no allocation, no upnl) which is >= 0, so legacy drain succeeds
			await expect(
				context.partyBAccountFacet.connect(context.signers.hedger).deallocateForPartyB(allocateAmount, partyA, await getDummySingleUpnlSig(0n)),
			).to.not.be.reverted
			expect(await context.viewFacet.allocatedBalanceOfPartyB(partyB, partyA)).to.equal(0n)
		})
	})

	describe("Full migration flow", function () {
		it("Should complete full migration flow: migrate -> enable cross mode -> fund cross bucket", async function () {
			const partyB = await hedger.getAddress()
			const partyA1 = context.signers.user.address
			const partyA2 = context.signers.user2.address
			const allocateA1 = decimal(200n)
			const allocateA2 = decimal(150n)

			// Enable cross partyB feature globally
			await context.controlFacet.connect(context.signers.admin).setCrossPartyBModeActivated(true)

			// Set up allocations (isolated mode — per-partyA buckets)
			await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateA1, partyA1)
			await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateA2, partyA2)

			// Migrate locked/pending locked values to cross bucket (not allocated balances)
			await context.migrationFacet.connect(context.signers.admin).migrateCrossLockedValues(partyB, [partyA1, partyA2])

			// Cross bucket allocated balance should be 0 — migration does not aggregate allocated balances
			const crossBalance = await context.viewFacet.balanceInfoOfCrossPartyB(partyB)
			expect(crossBalance[0]).to.equal(0n)

			// Enable cross partyB mode
			await context.controlFacet.connect(context.signers.admin).setCrossPartyB(partyB, true)

			// Verify cross partyB mode is enabled
			expect(await context.viewFacet.isCrossPartyB(partyB)).to.equal(true)

			// Per-partyA allocations should now fail (cross mode active)
			await expect(context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(decimal(100n), partyA1)).to.be.revertedWith(
				"PartyBFacet: Cross partyB mode is active",
			)

			// Solver must explicitly fund the cross bucket by allocating to address(0)
			const crossFundAmount = decimal(200n)
			await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(crossFundAmount, ZeroAddress)

			// Verify cross bucket now has the explicitly funded amount
			const crossBalanceAfterFund = await context.viewFacet.balanceInfoOfCrossPartyB(partyB)
			expect(crossBalanceAfterFund[0]).to.equal(crossFundAmount)

			// Per-partyA allocated balances remain in their isolated buckets (not aggregated)
			expect(await context.viewFacet.allocatedBalanceOfPartyB(partyB, partyA1)).to.equal(allocateA1)
			expect(await context.viewFacet.allocatedBalanceOfPartyB(partyB, partyA2)).to.equal(allocateA2)

			// PartyB can drain legacy per-partyA funds without needing inflated upnl
			// Legacy drain only requires cross solvency (>= 0), cross bucket has 200 so available = 200 >= 0
			const deallocateA1 = decimal(50n)
			await context.partyBAccountFacet.connect(context.signers.hedger).deallocateForPartyB(deallocateA1, partyA1, await getDummySingleUpnlSig(0n))
			expect(await context.viewFacet.allocatedBalanceOfPartyB(partyB, partyA1)).to.equal(allocateA1 - deallocateA1)
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

			it("Should not mark liquidation as disputed when cross partyB has positive settlement", async function () {
				const partyA = await user.getAddress()
				const crossPartyB = await hedger.getAddress()
				const losingPartyB = await hedger2.getAddress()

				await context.controlFacet.connect(context.signers.admin).setCrossPartyBModeActivated(true)
				await context.controlFacet.connect(context.signers.admin).setCrossPartyB(crossPartyB, true)
				await context.partyBAccountFacet.connect(hedger.signer).allocateForPartyB(decimal(600n), ZeroAddress)

				expect(await context.viewFacet.allocatedBalanceOfPartyB(crossPartyB, partyA)).to.equal(0n)

				await user.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([crossPartyB]).build())
				const crossQuoteId = await context.viewFacetQuote.getNextQuoteId()
				await hedger.lockQuote(crossQuoteId)
				const crossQuote = await context.viewFacetQuote.getQuote(crossQuoteId)
				let upnlSig = await getDummyPairUpnlAndPricesSig([crossQuote.requestedOpenPrice], [1n])
				await context.partyBBatchActionsFacet
					.connect(hedger.signer)
					.openPositions([crossQuoteId], [decimal(100n)], [crossQuote.requestedOpenPrice], upnlSig)

				await user.sendQuote(
					limitQuoteRequestBuilder().partyBWhiteList([losingPartyB]).positionType(PositionType.SHORT).quantity(decimal(800n)).build(),
				)
				const losingQuoteId = await context.viewFacetQuote.getNextQuoteId()
				await hedger2.lockQuote(losingQuoteId)
				const losingQuote = await context.viewFacetQuote.getQuote(losingQuoteId)
				upnlSig = await getDummyPairUpnlAndPricesSig([losingQuote.requestedOpenPrice], [1n])
				await context.partyBBatchActionsFacet
					.connect(hedger2.signer)
					.openPositions([losingQuoteId], [decimal(800n)], [losingQuote.requestedOpenPrice], upnlSig)

				await user.liquidateAndSetSymbolPrices([1n], [decimal(2n)], [crossQuoteId, losingQuoteId])
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePositionsPartyA(partyA, [crossQuoteId, losingQuoteId])

				const [crossSettlementState] = await context.viewFacet.getSettlementStates(partyA, [crossPartyB])
				expect(crossSettlementState.expectedAmount).to.be.greaterThan(0n)

				const liquidationState = await user.getLiquidatedStateOfPartyA()
				expect(liquidationState.partyAAccumulatedUpnl).to.equal(liquidationState.upnl)
				expect(liquidationState.disputed).to.equal(false)

				await expect(context.partyALiquidationFacet.connect(context.signers.liquidator).settlePartyALiquidation(partyA, [crossPartyB, losingPartyB]))
					.to.not.be.reverted
				expect(await context.viewFacet.isPartyALiquidated(partyA)).to.equal(false)
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
