import fs from "fs"
import path from "path"

import { ethers } from "../test/helpers/hardhat-connection.js"
import { deployFacets, buildDiamondCut, applyDiamondCut, captureState, compareStates, discoverPartiesFromQuotes } from "./upgradeTest.js"
import { getImpersonatedAdmin } from "./utils/forkHelpers.js"

/**
 * Fork Upgrade Script (upgrade only, no migration)
 *
 * Impersonates the on-chain diamond owner and runs the v0.8.4 -> v0.8.5
 * upgrade on a forked network. Migration is a separate step -- run
 * prepareMigrationInput.ts then migrateOnDemand.ts after this completes.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... npx hardhat run scripts/forkUpgrade.ts --network localhost
 *
 * Config:
 *   cp scripts/config/forkUpgrade.sample.json scripts/config/forkUpgrade.json
 *   # edit scripts/config/forkUpgrade.json
 */

type ForkUpgradeConfig = {
	diamondAddress?: string
	adminAddress?: string
	diamondCutChunkSize?: number
	quoteScanLimit?: number
	newV085Parameters?: {
		maxPartyAConnectionLimit?: number
		settlementCooldown?: number
		deallocateDebounceTime?: number
	}
	verbose?: boolean
}

type StepResult = {
	name: string
	status: "ok" | "error"
	details?: Record<string, unknown>
}

type ForkUpgradeReport = {
	status: "running" | "success" | "failed"
	startedAt: string
	finishedAt?: string
	durationMs?: number
	diamondAddress?: string
	adminAddress?: string
	steps: StepResult[]
	error?: string
}

const CONFIG_FILE = process.env.FORK_UPGRADE_CONFIG_FILE ?? "./scripts/config/forkUpgrade.json"

function loadConfig(): ForkUpgradeConfig {
	if (!fs.existsSync(CONFIG_FILE)) return {}
	const raw = fs.readFileSync(CONFIG_FILE, "utf-8")
	const data = JSON.parse(raw)
	if (!data || typeof data !== "object") throw new Error("Config must be a JSON object.")
	return data as ForkUpgradeConfig
}

function parseBool(value: string | boolean | undefined, fallback: boolean): boolean {
	if (value === undefined || value === null || value === "") return fallback
	if (typeof value === "boolean") return value
	const normalized = (value as string).toLowerCase()
	if (normalized === "true" || normalized === "1") return true
	if (normalized === "false" || normalized === "0") return false
	throw new Error(`Invalid boolean value: ${value}`)
}

function formatError(error: unknown): string {
	if (error instanceof Error && error.stack) return error.stack
	if (error instanceof Error && error.message) return error.message
	return String(error)
}

function ensureParentDir(filePath: string): void {
	const dir = path.dirname(filePath)
	if (dir && dir !== "." && !fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true })
	}
}

function writeJson(filePath: string, value: unknown): void {
	if (!filePath) return
	ensureParentDir(filePath)
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function tryWriteReport(filePath: string, report: ForkUpgradeReport): void {
	try {
		writeJson(filePath, report)
	} catch (error) {
		console.error(`Failed to write report: ${formatError(error)}`)
	}
}

async function main() {
	const startedAtMs = Date.now()
	const config = loadConfig()

	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
	const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS ?? (config.adminAddress || undefined)
	const DIAMOND_CUT_CHUNK_SIZE = Number(process.env.DIAMOND_CUT_CHUNK_SIZE ?? config.diamondCutChunkSize ?? 6)
	const QUOTE_SCAN_LIMIT = process.env.QUOTE_SCAN_LIMIT ? Number(process.env.QUOTE_SCAN_LIMIT) : (config.quoteScanLimit ?? null)
	const newParams = config.newV085Parameters ?? {}

	const outputDir = "./scripts/output"
	const reportFile = `${outputDir}/forkUpgrade-report.json`

	const report: ForkUpgradeReport = {
		status: "running",
		startedAt: new Date(startedAtMs).toISOString(),
		steps: [],
	}
	tryWriteReport(reportFile, report)
	let currentStep: string | null = null

	try {
		// Step 1: Validate inputs
		currentStep = "validate_inputs"
		if (!DIAMOND_ADDRESS) {
			throw new Error("DIAMOND_ADDRESS is required (env var or config file).")
		}
		if (!ethers.isAddress(DIAMOND_ADDRESS) || DIAMOND_ADDRESS === ethers.ZeroAddress) {
			throw new Error(`Invalid DIAMOND_ADDRESS: ${DIAMOND_ADDRESS}`)
		}
		report.diamondAddress = DIAMOND_ADDRESS
		report.steps.push({ name: "validate_inputs", status: "ok", details: { diamondAddress: DIAMOND_ADDRESS } })
		currentStep = null
		tryWriteReport(reportFile, report)

		console.log(`\nDiamond: ${DIAMOND_ADDRESS}`)

		// Step 2: Resolve + impersonate admin
		currentStep = "impersonate_admin"
		const admin = await getImpersonatedAdmin(DIAMOND_ADDRESS, ADMIN_ADDRESS)
		const adminAddress = await admin.getAddress()
		report.adminAddress = adminAddress
		report.steps.push({ name: "impersonate_admin", status: "ok", details: { adminAddress } })
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 3: Connect facets
		currentStep = "connect_facets"
		const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", DIAMOND_ADDRESS, admin)
		const viewFacetQuote = await ethers.getContractAt(
			"contracts/core/facets/ViewFacetQuote/ViewFacetQuote.sol:ViewFacetQuote",
			DIAMOND_ADDRESS,
			admin,
		)
		const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", DIAMOND_ADDRESS, admin)
		const pauseControlFacet = await ethers.getContractAt(
			"contracts/core/facets/PauseControl/PauseControlFacet.sol:PauseControlFacet",
			DIAMOND_ADDRESS,
			admin,
		)
		report.steps.push({ name: "connect_facets", status: "ok" })
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 4: Discover parties + capture pre-upgrade state
		currentStep = "discover_parties"
		console.log("\nDiscovering parties from on-chain quotes...")
		const discovered = await discoverPartiesFromQuotes(viewFacetQuote, DIAMOND_ADDRESS, QUOTE_SCAN_LIMIT)
		const partyAs = discovered.partyAs
		const partyBs = discovered.partyBs
		console.log(`Found ${partyAs.length} PartyAs, ${partyBs.length} PartyBs`)
		report.steps.push({
			name: "discover_parties",
			status: "ok",
			details: { partyAsCount: partyAs.length, partyBsCount: partyBs.length },
		})
		currentStep = null
		tryWriteReport(reportFile, report)

		currentStep = "capture_pre_state"
		console.log("Capturing pre-upgrade state...")
		const preState = await captureState(viewFacet, viewFacetQuote, partyAs, partyBs)
		report.steps.push({
			name: "capture_pre_state",
			status: "ok",
			details: { partyAsCount: partyAs.length, partyBsCount: partyBs.length },
		})
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 5: Pause system
		currentStep = "pause_system"
		console.log("\nGranting admin roles and pausing system...")
		await (await controlFacet.setAdmin(adminAddress)).wait()
		await (await controlFacet.grantRole(adminAddress, ethers.id("PAUSER_ROLE"))).wait()
		await (await controlFacet.grantRole(adminAddress, ethers.id("UNPAUSER_ROLE"))).wait()

		const pauseState = await viewFacet.pauseState()
		let pausedByScript = false
		if (!pauseState.globalPaused) {
			await (await pauseControlFacet.pauseGlobal()).wait()
			pausedByScript = true
			console.log("System paused.")
		} else {
			console.log("System already paused.")
		}
		report.steps.push({ name: "pause_system", status: "ok", details: { pausedByScript } })
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 6: Deploy v0.8.5 facets (uses signers[0], no admin needed)
		currentStep = "deploy_facets"
		console.log("\nDeploying v0.8.5 facets...")
		const { facets: newFacets, selectorSignatures } = await deployFacets()
		console.log(`Deployed ${Object.keys(newFacets).length} facets.`)
		report.steps.push({
			name: "deploy_facets",
			status: "ok",
			details: { facetCount: Object.keys(newFacets).length },
		})
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 7: Build + apply diamond cut (needs admin signer)
		currentStep = "build_diamond_cut"
		console.log("\nBuilding diamond cut...")
		const { diamondCut, selectorChanges } = await buildDiamondCut(DIAMOND_ADDRESS, newFacets, selectorSignatures)
		const actionCounts = { add: 0, replace: 0, remove: 0 }
		for (const change of selectorChanges) {
			actionCounts[change.action] += 1
		}
		console.log(
			`Diamond cut: ${selectorChanges.length} selector changes (add=${actionCounts.add}, replace=${actionCounts.replace}, remove=${actionCounts.remove})`,
		)
		report.steps.push({
			name: "build_diamond_cut",
			status: "ok",
			details: { totalChanges: selectorChanges.length, ...actionCounts },
		})
		currentStep = null
		tryWriteReport(reportFile, report)

		currentStep = "apply_diamond_cut"
		console.log("Applying diamond cut...")
		await applyDiamondCut(DIAMOND_ADDRESS, diamondCut, admin, DIAMOND_CUT_CHUNK_SIZE)
		console.log("Diamond cut applied.")
		report.steps.push({ name: "apply_diamond_cut", status: "ok" })
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 8: Set new v0.8.5 parameters
		currentStep = "set_v085_parameters"
		console.log("\nSetting new v0.8.5 parameters...")
		const paramsSet: Record<string, unknown> = {}

		// Grant roles needed for parameter setting
		await (await controlFacet.grantRole(adminAddress, ethers.id("PROTOCOL_CONFIG_ROLE"))).wait()
		await (await controlFacet.grantRole(adminAddress, ethers.id("COOLDOWN_ADMIN_ROLE"))).wait()

		if (newParams.maxPartyAConnectionLimit && newParams.maxPartyAConnectionLimit > 0) {
			await (await controlFacet.setMaxPartyAConnectionLimit(newParams.maxPartyAConnectionLimit)).wait()
			paramsSet.maxPartyAConnectionLimit = newParams.maxPartyAConnectionLimit
			console.log(`  maxPartyAConnectionLimit = ${newParams.maxPartyAConnectionLimit}`)
		}
		if (newParams.settlementCooldown !== undefined && newParams.settlementCooldown > 0) {
			await (await controlFacet.setSettlementCooldown(newParams.settlementCooldown)).wait()
			paramsSet.settlementCooldown = newParams.settlementCooldown
			console.log(`  settlementCooldown = ${newParams.settlementCooldown}`)
		}
		if (newParams.deallocateDebounceTime !== undefined && newParams.deallocateDebounceTime > 0) {
			await (await controlFacet.setDeallocateDebounceTime(newParams.deallocateDebounceTime)).wait()
			paramsSet.deallocateDebounceTime = newParams.deallocateDebounceTime
			console.log(`  deallocateDebounceTime = ${newParams.deallocateDebounceTime}`)
		}

		if (Object.keys(paramsSet).length === 0) {
			console.log("  (no parameters configured)")
		}
		report.steps.push({ name: "set_v085_parameters", status: "ok", details: paramsSet })
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 9: Capture post-upgrade state + compare
		currentStep = "capture_post_state"
		console.log("\nCapturing post-upgrade state...")
		const postState = await captureState(viewFacet, viewFacetQuote, partyAs, partyBs)
		report.steps.push({ name: "capture_post_state", status: "ok" })
		currentStep = null
		tryWriteReport(reportFile, report)

		currentStep = "compare_states"
		compareStates(preState, postState)
		console.log("State comparison: OK (upgrade preserved existing data)")
		report.steps.push({ name: "compare_states", status: "ok" })
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 10: Grant migration role for the next step
		currentStep = "grant_migration_role"
		await (await controlFacet.grantRole(adminAddress, ethers.id("MIGRATION_ROLE"))).wait()
		console.log("\nMigration role granted. System remains paused.")
		console.log("Next steps:")
		console.log("  1. Run prepareMigrationInput.ts to fetch + validate migration data from subgraph")
		console.log("  2. Run migrateOnDemand.ts with the validated input file")
		report.steps.push({ name: "grant_migration_role", status: "ok" })
		currentStep = null
		tryWriteReport(reportFile, report)

		console.log("\nFork upgrade completed successfully.")
		report.status = "success"
	} catch (error) {
		if (currentStep) {
			report.steps.push({
				name: currentStep,
				status: "error",
				details: { error: formatError(error) },
			})
		}
		report.status = "failed"
		report.error = formatError(error)
		tryWriteReport(reportFile, report)
		throw error
	} finally {
		report.finishedAt = new Date().toISOString()
		report.durationMs = Date.now() - startedAtMs
		tryWriteReport(reportFile, report)
	}
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
