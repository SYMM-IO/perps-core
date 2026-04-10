/**
 * Local end-to-end test for the v0.8.5 upgrade and migration pipeline.
 *
 * Deploys a fresh Symmio system, creates test positions across PENDING /
 * LOCKED / OPENED states, then runs the full upgrade pipeline and migrates —
 * all against the in-process Hardhat network (no RPC, no subgraph, no files).
 *
 * What is exercised:
 *   deployFacets()                   deploy all 29 core facets fresh
 *   buildDiamondCut()                diff live diamond vs new facets
 *   applyDiamondCut()                apply cut (all selectors → Replace actions)
 *   deployAccountLayerDiamond()      deploy fresh AccountLayer diamond
 *   deployInstantLayer()             deploy fresh InstantLayer
 *   wireAccountLayerInstantLayer()   wire the new peripherals
 *   setupInstantLayerTemplates()     register templates
 *   migrate()                        migrateQuotes + migrateCrossLockedValues
 *   post-upgrade verification        selectors, hook, roles, quote states
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/localE2ETest.ts
 */
import { FacetNames } from "../../tasks/deploy/constants.js"
import { initializeFixture } from "../../test/Initialize.fixture.js"
import { ethers } from "../../test/helpers/hardhat-connection.js"
import { QuoteStatus } from "../../test/models/Enums.js"
import { Hedger } from "../../test/models/Hedger.js"
import { User } from "../../test/models/User.js"
import { limitOpenRequestBuilder } from "../../test/models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "../../test/models/requestModels/QuoteRequest.js"
import { decimal } from "../../test/utils/Common.js"
import { migrate, type MigrationInput, type PartyBMigrationTask } from "./migrate.js"
import { deployAccountLayerDiamond, deployInstantLayer, wireAccountLayerInstantLayer, setupInstantLayerTemplates } from "./utils/peripheralHelpers.js"
import { applyDiamondCut, buildDiamondCut, deployFacets, type FacetInfo } from "./utils/upgradeHelpers.js"

// =============================================================================
// Test result tracking
// =============================================================================

type TestResult = {
	name: string
	passed: boolean
	error?: string
}

const results: TestResult[] = []

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
	try {
		await fn()
		results.push({ name, passed: true })
		console.log(`  ✓ ${name}`)
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		results.push({ name, passed: false, error: msg })
		console.error(`  ✗ ${name}: ${msg}`)
	}
}

function section(title: string) {
	console.log(`\n${"─".repeat(60)}`)
	console.log(` ${title}`)
	console.log("─".repeat(60))
}

// =============================================================================
// Main
// =============================================================================

async function main() {
	console.log("=".repeat(60))
	console.log(" Symmio v0.8.5 Local E2E Test")
	console.log("=".repeat(60))

	// =========================================================================
	// Phase 1: Set up fresh system
	// =========================================================================
	section("Phase 1: System setup")

	const context = await initializeFixture()
	const diamondAddress = context.diamond
	console.log(`  Diamond:    ${diamondAddress}`)

	await check("initializeFixture completes", () => {
		if (!diamondAddress || !ethers.isAddress(diamondAddress)) throw new Error("Diamond address invalid")
	})

	// =========================================================================
	// Phase 2: Create test positions
	// =========================================================================
	section("Phase 2: Create test positions")

	const user = new User(context, context.signers.user)
	const hedger = new Hedger(context, context.signers.hedger)
	await user.setup()
	await hedger.setup()

	await user.setBalances(decimal(10000n), decimal(5000n), decimal(3000n))
	await hedger.setBalances(decimal(10000n), decimal(5000n))

	await check("accounts funded", async () => {
		// balanceOf returns free (non-allocated) balance; allocate(3000) from deposit(5000) leaves 2000 free
		const userBal = await context.viewFacet.balanceOf(context.signers.user.address)
		if (userBal < decimal(1000n)) throw new Error(`User free balance too low: ${userBal}`)
	})

	let pendingQuoteId = 0n
	let lockedQuoteId = 0n
	let openedQuoteId = 0n

	await check("send PENDING quote", async () => {
		pendingQuoteId = BigInt(await user.sendQuote(limitQuoteRequestBuilder().build()))
		const quote = await context.viewFacetQuote.getQuote(pendingQuoteId)
		if (Number(quote.quoteStatus) !== QuoteStatus.PENDING) throw new Error(`Expected PENDING, got ${quote.quoteStatus}`)
		console.log(`    quoteId=${pendingQuoteId} status=PENDING`)
	})

	await check("send + lock LOCKED quote", async () => {
		lockedQuoteId = BigInt(await user.sendQuote(limitQuoteRequestBuilder().build()))
		await hedger.lockQuote(lockedQuoteId)
		const quote = await context.viewFacetQuote.getQuote(lockedQuoteId)
		if (Number(quote.quoteStatus) !== QuoteStatus.LOCKED) throw new Error(`Expected LOCKED, got ${quote.quoteStatus}`)
		console.log(`    quoteId=${lockedQuoteId} status=LOCKED`)
	})

	await check("send + lock + open OPENED position", async () => {
		openedQuoteId = BigInt(await user.sendQuote(limitQuoteRequestBuilder().build()))
		await hedger.lockQuote(openedQuoteId)
		await hedger.openPosition(openedQuoteId, limitOpenRequestBuilder().build())
		const quote = await context.viewFacetQuote.getQuote(openedQuoteId)
		if (Number(quote.quoteStatus) !== QuoteStatus.OPENED) throw new Error(`Expected OPENED, got ${quote.quoteStatus}`)
		console.log(`    quoteId=${openedQuoteId} status=OPENED`)
	})

	// =========================================================================
	// Phase 3: Pause
	// =========================================================================
	section("Phase 3: Pause system")

	await check("grant PAUSER_ROLE and pauseGlobal", async () => {
		const admin = context.signers.admin
		await (await context.controlFacet.connect(admin).grantRole(admin.address, ethers.id("PAUSER_ROLE"))).wait()
		await (await context.pauseControlFacet.connect(admin).pauseGlobal()).wait()
		const [globalPaused] = await (context.viewFacet as any).pauseState()
		if (!globalPaused) throw new Error("System should be paused")
		console.log("    globallyPaused = true")
	})

	// =========================================================================
	// Phase 4: Deploy new facets
	// =========================================================================
	section("Phase 4: Deploy new facets")

	let newFacets: { facets: Record<string, FacetInfo>; selectorSignatures: Record<string, string> } = {
		facets: {},
		selectorSignatures: {},
	}

	await check(`deploy ${FacetNames.length} facets (no state file)`, async () => {
		// No outputFile → no disk I/O, deploy everything fresh in memory
		newFacets = await deployFacets(undefined)
		const count = Object.keys(newFacets.facets).length
		if (count !== FacetNames.length) throw new Error(`Expected ${FacetNames.length} facets, got ${count}`)
		console.log(`    deployed ${count} facets`)
	})

	// =========================================================================
	// Phase 5: Build and apply diamond cut
	// =========================================================================
	section("Phase 5: Apply diamond cut")

	await check("buildDiamondCut produces Replace actions (self-upgrade)", async () => {
		const { selectorChanges } = await buildDiamondCut(diamondAddress, newFacets.facets, newFacets.selectorSignatures)
		const byAction = { add: 0, replace: 0, remove: 0 }
		for (const c of selectorChanges) byAction[c.action]++
		console.log(`    selectors: ${byAction.replace} replace, ${byAction.add} add, ${byAction.remove} remove`)
		if (byAction.replace === 0) throw new Error("Expected at least some Replace actions")
	})

	await check("applyDiamondCut succeeds", async () => {
		const { diamondCut } = await buildDiamondCut(diamondAddress, newFacets.facets, newFacets.selectorSignatures)
		await applyDiamondCut(diamondAddress, diamondCut, context.signers.admin, 6)
		console.log(`    diamond cut applied`)
	})

	await check("new facet addresses registered in live diamond", async () => {
		const loupeFacet = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress)
		const liveFacets = await loupeFacet.facets()
		const liveAddrs = new Set(liveFacets.map((f: any) => (f.facetAddress as string).toLowerCase()))
		const missing: string[] = []
		for (const [name, info] of Object.entries(newFacets.facets)) {
			if (!liveAddrs.has(info.address.toLowerCase())) missing.push(name)
		}
		if (missing.length > 0) throw new Error(`Missing facets after cut: ${missing.join(", ")}`)
		console.log(`    all ${Object.keys(newFacets.facets).length} new facet addresses registered`)
	})

	// =========================================================================
	// Phase 6: Deploy + wire peripherals
	// =========================================================================
	section("Phase 6: Deploy and wire peripherals")

	const admin = context.signers.admin
	const adminAddress = await admin.getAddress()
	const feeReceiverAddress = context.signers.symmioFeeReceiver.address

	let newAlAddress = ""
	let newIlAddress = ""

	await check("deployAccountLayerDiamond", async () => {
		const result = await deployAccountLayerDiamond(adminAddress, feeReceiverAddress)
		newAlAddress = result.diamondAddress
		console.log(`    AccountLayer: ${newAlAddress}`)
		if (!ethers.isAddress(newAlAddress)) throw new Error("Invalid AccountLayer address")
	})

	await check("deployInstantLayer", async () => {
		const result = await deployInstantLayer(diamondAddress, adminAddress)
		newIlAddress = result.address
		console.log(`    InstantLayer: ${newIlAddress}`)
		if (!ethers.isAddress(newIlAddress)) throw new Error("Invalid InstantLayer address")
	})

	await check("wireAccountLayerInstantLayer", async () => {
		await wireAccountLayerInstantLayer(diamondAddress, newAlAddress, newIlAddress, admin)
		console.log("    wired successfully")
	})

	await check("setupInstantLayerTemplates", async () => {
		await setupInstantLayerTemplates(newIlAddress, admin)
		console.log("    templates registered")
	})

	// =========================================================================
	// Phase 7: Build migration input from on-chain state (no subgraph)
	// =========================================================================
	section("Phase 7: Build migration input (on-chain, no subgraph)")

	let migrationInput: MigrationInput = { quoteIds: [], partyBTasks: [] }

	await check("collect LOCKED/OPENED quotes from chain", async () => {
		const viewFacetQuote = await ethers.getContractAt("ViewFacetQuote", diamondAddress)
		// getNextQuoteId() returns the LAST assigned ID (despite the name), so loop id <= lastId
		const lastId: bigint = await viewFacetQuote.getNextQuoteId()

		const activeQuoteIds: bigint[] = []
		// partyB (checksummed) → Set<partyA (checksummed)>
		const partyBToPartyAs = new Map<string, Set<string>>()

		for (let id = 1n; id <= lastId; id++) {
			const quote = await viewFacetQuote.getQuote(id)
			const status = Number(quote.quoteStatus)
			if (status === QuoteStatus.LOCKED || status === QuoteStatus.OPENED) {
				activeQuoteIds.push(id)
				const pb: string = quote.partyB
				if (pb.toLowerCase() !== ethers.ZeroAddress.toLowerCase()) {
					const pbCheck = ethers.getAddress(pb)
					if (!partyBToPartyAs.has(pbCheck)) partyBToPartyAs.set(pbCheck, new Set())
					partyBToPartyAs.get(pbCheck)!.add(ethers.getAddress(quote.partyA as string))
				}
			}
		}

		const partyBTasks: PartyBMigrationTask[] = []
		for (const [partyB, partyASet] of partyBToPartyAs) {
			partyBTasks.push({ partyB, partyAs: [...partyASet] })
		}

		migrationInput = { quoteIds: activeQuoteIds, partyBTasks }
		console.log(`    active quotes: ${activeQuoteIds.length} (ids: ${activeQuoteIds.join(", ")})`)
		console.log(`    partyB tasks:  ${partyBTasks.length}`)

		if (activeQuoteIds.length < 2) throw new Error(`Expected at least 2 active quotes (LOCKED + OPENED), got ${activeQuoteIds.length}`)
	})

	// =========================================================================
	// Phase 8: Run migration
	// =========================================================================
	section("Phase 8: Run migration")

	await check("grant MIGRATION_ROLE to admin", async () => {
		// initializeFixture already grants this, but grant again to be explicit
		await (await context.controlFacet.connect(admin).grantRole(adminAddress, ethers.id("MIGRATION_ROLE"))).wait()
	})

	await check("migrate() completes with status=success", async () => {
		const migrationFacet = await ethers.getContractAt("MigrationFacet", diamondAddress, admin)
		const viewFacetQuoteLocal = await ethers.getContractAt("ViewFacetQuote", diamondAddress)
		const report = await migrate(migrationFacet as any, viewFacetQuoteLocal as any, migrationInput, {
			chunkSize: 50,
			progressFile: null, // no file I/O
		})
		if (report.status !== "success") throw new Error(`Migration status: ${report.status}`)
		console.log(`    quotes migrated: ${report.quotesMigrated}/${report.quotesTotal}`)
		console.log(`    partyBs migrated: ${report.partyBsMigrated}/${report.partyBsTotal}`)
	})

	await check("isQuoteMigrated returns true for all active quotes", async () => {
		const migrationFacet = await ethers.getContractAt("MigrationFacet", diamondAddress)
		for (const id of migrationInput.quoteIds) {
			const migrated: boolean = await (migrationFacet as any).isQuoteMigrated(id)
			if (!migrated) throw new Error(`Quote ${id} not marked as migrated`)
		}
		console.log(`    all ${migrationInput.quoteIds.length} quotes verified as migrated`)
	})

	// =========================================================================
	// Phase 9: Set symbol types
	// =========================================================================
	section("Phase 9: Set symbol types")

	await check("grant SYMBOL_MANAGER_ROLE to admin", async () => {
		await (await context.controlFacet.connect(admin).grantRole(adminAddress, ethers.id("SYMBOL_MANAGER_ROLE"))).wait()
	})

	await check("setSymbolTypes is idempotent on existing symbol", async () => {
		const symbolControlFacet = await ethers.getContractAt("SymbolControlFacet", diamondAddress, admin)
		// Symbol 1 (BTCUSDT) already has symbolType=1 from initializeFixture; calling again is a no-op
		await (await symbolControlFacet.setSymbolTypes([1n], [1n])).wait()
		// symbolType is not in the Symbol struct — use getSymbolWithType which includes it
		const symWithType = await context.viewFacetSymbol.getSymbolWithType(1n)
		if (Number(symWithType.symbolType) !== 1) throw new Error(`Expected symbolType=1, got ${symWithType.symbolType}`)
		console.log("    symbol 1 symbolType = 1 ✓")
	})

	// =========================================================================
	// Phase 10: Verify diamond and peripherals
	// =========================================================================
	section("Phase 10: Verify diamond and peripherals")

	await check("all new facet addresses present in live diamond", async () => {
		const loupeFacet = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress)
		const liveFacets = await loupeFacet.facets()
		const liveAddrs = new Set(liveFacets.map((f: any) => (f.facetAddress as string).toLowerCase()))
		const missing = Object.entries(newFacets.facets)
			.filter(([, info]) => !liveAddrs.has(info.address.toLowerCase()))
			.map(([name]) => name)
		if (missing.length > 0) throw new Error(`Missing facets: ${missing.join(", ")}`)
		console.log(`    ${Object.keys(newFacets.facets).length} facets verified in live diamond`)
	})

	await check("new AccountLayer registered as system hook on diamond", async () => {
		// System hook is affiliateHooks[address(0)]
		const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", diamondAddress)
		const hook: string = await (viewFacet as any).getAffiliateHook(ethers.ZeroAddress)
		if (hook.toLowerCase() !== newAlAddress.toLowerCase()) {
			throw new Error(`Expected system hook=${newAlAddress}, got ${hook}`)
		}
		console.log(`    systemHook = ${hook}`)
	})

	await check("InstantLayer has SIGNER_SETTER_ROLE on AccountLayer", async () => {
		// hasRole is on AccountLayer ViewFacet (not ControlFacet)
		const alViewFacet = await ethers.getContractAt("contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet", newAlAddress)
		const hasRole: boolean = await (alViewFacet as any).hasRole(newIlAddress, ethers.id("SIGNER_SETTER_ROLE"))
		if (!hasRole) throw new Error("InstantLayer missing SIGNER_SETTER_ROLE on AccountLayer")
		console.log("    SIGNER_SETTER_ROLE ✓")
	})

	await check("Diamond whitelisted on AccountLayer", async () => {
		const alViewFacet = await ethers.getContractAt("contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet", newAlAddress)
		const whitelisted: boolean = await (alViewFacet as any).isWhitelistedSymmioCore(diamondAddress)
		if (!whitelisted) throw new Error("Diamond not whitelisted on AccountLayer")
		console.log("    isWhitelistedSymmioCore ✓")
	})

	await check("InstantLayer templates registered (nextTemplateId >= 3)", async () => {
		const il = await ethers.getContractAt("InstantLayer", newIlAddress)
		// nextTemplateId increments for each addTemplate call
		const nextId: bigint = await (il as any).nextTemplateId()
		if (nextId < 3n) throw new Error(`Expected at least 3 templates, got nextTemplateId=${nextId}`)
		console.log(`    nextTemplateId = ${nextId} (${nextId} templates added)`)
	})

	await check("Diamond is still paused", async () => {
		const [globalPaused] = await (context.viewFacet as any).pauseState()
		if (!globalPaused) throw new Error("Diamond should still be paused")
	})

	// =========================================================================
	// Phase 11: Revoke migration roles and unpause
	// =========================================================================
	section("Phase 11: Revoke roles and unpause")

	await check("revoke MIGRATION_ROLE from admin", async () => {
		await (await context.controlFacet.connect(admin).revokeRole(adminAddress, ethers.id("MIGRATION_ROLE"))).wait()
	})

	await check("revoke SYMBOL_MANAGER_ROLE from admin", async () => {
		await (await context.controlFacet.connect(admin).revokeRole(adminAddress, ethers.id("SYMBOL_MANAGER_ROLE"))).wait()
	})

	await check("grant UNPAUSER_ROLE and unpauseGlobal", async () => {
		await (await context.controlFacet.connect(admin).grantRole(adminAddress, ethers.id("UNPAUSER_ROLE"))).wait()
		await (await context.pauseControlFacet.connect(admin).unpauseGlobal()).wait()
		const [paused] = await (context.viewFacet as any).pauseState()
		if (paused) throw new Error("System should be unpaused")
		console.log("    globallyPaused = false")
	})

	// =========================================================================
	// Phase 12: Post-upgrade smoke test
	// =========================================================================
	section("Phase 12: Post-upgrade smoke test")

	await check("PENDING quote accessible and still PENDING after upgrade", async () => {
		if (!pendingQuoteId) throw new Error("pendingQuoteId not set")
		const quote = await context.viewFacetQuote.getQuote(pendingQuoteId)
		if (Number(quote.quoteStatus) !== QuoteStatus.PENDING) throw new Error(`Expected PENDING, got ${quote.quoteStatus}`)
	})

	await check("LOCKED quote accessible and still LOCKED after upgrade", async () => {
		if (!lockedQuoteId) throw new Error("lockedQuoteId not set")
		const quote = await context.viewFacetQuote.getQuote(lockedQuoteId)
		if (Number(quote.quoteStatus) !== QuoteStatus.LOCKED) throw new Error(`Expected LOCKED, got ${quote.quoteStatus}`)
	})

	await check("OPENED position accessible and still OPENED after upgrade", async () => {
		if (!openedQuoteId) throw new Error("openedQuoteId not set")
		const quote = await context.viewFacetQuote.getQuote(openedQuoteId)
		if (Number(quote.quoteStatus) !== QuoteStatus.OPENED) throw new Error(`Expected OPENED, got ${quote.quoteStatus}`)
	})

	await check("can send new quote after upgrade (system functional)", async () => {
		const user2 = new User(context, context.signers.user2)
		await user2.setup()
		await user2.setBalances(decimal(10000n), decimal(5000n), decimal(3000n))
		const newQuoteId = BigInt(await user2.sendQuote(limitQuoteRequestBuilder().build()))
		const quote = await context.viewFacetQuote.getQuote(newQuoteId)
		if (Number(quote.quoteStatus) !== QuoteStatus.PENDING) throw new Error("New quote not in PENDING state")
		console.log(`    new quote id=${newQuoteId} ✓`)
	})

	// =========================================================================
	// Summary
	// =========================================================================
	console.log(`\n${"=".repeat(60)}`)
	console.log(" TEST SUMMARY")
	console.log("=".repeat(60))

	const passed = results.filter(r => r.passed)
	const failed = results.filter(r => !r.passed)

	for (const r of results) {
		console.log(`  ${r.passed ? "✓" : "✗"} ${r.name}${r.passed ? "" : `: ${r.error}`}`)
	}

	console.log(`\n  Passed: ${passed.length} / ${results.length}`)

	if (failed.length > 0) {
		console.error(`  Failed: ${failed.length}`)
		process.exitCode = 1
	} else {
		console.log("  ALL TESTS PASSED ✓")
	}

	console.log("=".repeat(60))
}

main().catch(error => {
	console.error("Fatal error:", error)
	process.exitCode = 1
})
