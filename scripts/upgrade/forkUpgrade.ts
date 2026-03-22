import fs from "fs"
import path from "path"

import { ethers } from "../../test/helpers/hardhat-connection.js"
import { getImpersonatedAdmin } from "./utils/forkHelpers.js"
import { deployAccountLayerDiamond, deployInstantLayer, wireAccountLayerInstantLayer, setupInstantLayerTemplates } from "./utils/peripheralHelpers.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { fetchOpenQuotes, fetchPartyBBalances } from "./utils/subgraphHelpers.js"
import { deployFacets, buildDiamondCut, applyDiamondCut, setV085Parameters, type NewV085Parameters } from "./utils/upgradeHelpers.js"

const DEFAULT_SUBGRAPH_ENDPOINT = "https://api.goldsky.com/api/public/project_cm1hfr4527p0f01u85mz499u8/subgraphs/arbitrum_analytics/stage/gn"

/**
 * Fork Upgrade Script (upgrade only, no migration)
 *
 * Impersonates the on-chain diamond owner and runs the v0.8.4 -> v0.8.5
 * upgrade on a forked network. Migration is a separate step -- run
 * prepareMigrationInput.ts then runMigration.ts after this completes.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... npx hardhat run scripts/upgrade/forkUpgrade.ts --network localhost
 *
 * Config:
 *   cp scripts/upgrade/config/samples/upgrade.sample.json scripts/upgrade/config/upgrade.json
 *   # edit scripts/upgrade/config/upgrade.json
 */

type ForkUpgradeConfig = {
	diamondAddress?: string
	adminAddress?: string
	diamondCutChunkSize?: number
	subgraphEndpoint?: string
	spotCheckCount?: number
	symmioFeeReceiver?: string
	setupInstantLayerTemplates?: boolean
	newV085Parameters?: NewV085Parameters
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

const CONFIG_FILE = process.env.UPGRADE_CONFIG_FILE ?? "./scripts/upgrade/config/upgrade.json"

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
	await verifyRpc()
	const startedAtMs = Date.now()
	const config = loadConfig()

	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
	const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS ?? (config.adminAddress || undefined)
	const DIAMOND_CUT_CHUNK_SIZE = Number(process.env.DIAMOND_CUT_CHUNK_SIZE ?? config.diamondCutChunkSize ?? 6)
	const SUBGRAPH_ENDPOINT = process.env.SUBGRAPH_ENDPOINT || config.subgraphEndpoint || DEFAULT_SUBGRAPH_ENDPOINT
	const newParams = config.newV085Parameters ?? {}

	const outputDir = "./scripts/upgrade/output"
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
		const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", DIAMOND_ADDRESS, admin)
		const pauseControlFacet = await ethers.getContractAt(
			"contracts/core/facets/PauseControl/PauseControlFacet.sol:PauseControlFacet",
			DIAMOND_ADDRESS,
			admin,
		)
		report.steps.push({ name: "connect_facets", status: "ok" })
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 4: Fetch subgraph data (pre-upgrade reference)
		currentStep = "fetch_subgraph"
		console.log("\nFetching data from subgraph...")
		const [quotesResult, balancesResult] = await Promise.all([fetchOpenQuotes(SUBGRAPH_ENDPOINT), fetchPartyBBalances(SUBGRAPH_ENDPOINT)])
		const partyAs = quotesResult.partyAs
		const partyBs = quotesResult.partyBs
		console.log(
			`Subgraph: ${quotesResult.quotes.length} open quotes, ${partyAs.length} partyAs, ${partyBs.length} partyBs, ${balancesResult.entries.length} balance entries`,
		)
		report.steps.push({
			name: "fetch_subgraph",
			status: "ok",
			details: {
				openQuotes: quotesResult.quotes.length,
				partyAs: partyAs.length,
				partyBs: partyBs.length,
				balanceEntries: balancesResult.entries.length,
			},
		})
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 5: Capture pre-upgrade snapshot (on-chain, small sample for integrity check)
		currentStep = "capture_pre_snapshot"
		console.log("Capturing pre-upgrade on-chain snapshot...")
		const spotCheckCount = Number(process.env.SPOT_CHECK_COUNT ?? config.spotCheckCount ?? 20)

		// Use v0.8.4-compatible ABI for getQuote (same selector, works on both versions)
		const quoteReader = new ethers.Contract(
			DIAMOND_ADDRESS,
			[
				"function getQuote(uint256) view returns (tuple(uint256 id,address[] partyBsWhiteList,uint256 symbolId,uint8 positionType,uint8 orderType,uint256 openedPrice,uint256 initialOpenedPrice,uint256 requestedOpenPrice,uint256 marketPrice,uint256 quantity,uint256 closedAmount,tuple(uint256 cva,uint256 lf,uint256 partyAmm,uint256 partyBmm) initialLockedValues,tuple(uint256 cva,uint256 lf,uint256 partyAmm,uint256 partyBmm) lockedValues,uint256 maxFundingRate,address partyA,address partyB,uint8 quoteStatus,uint256 avgClosedPrice,uint256 requestedClosePrice,uint256 quantityToClose,uint256 parentId,uint256 createTimestamp,uint256 statusModifyTimestamp,uint256 lastFundingPaymentTimestamp,uint256 deadline,uint256 tradingFee,address affiliate))",
			],
			admin,
		)

		// Pick random sample of quote IDs from subgraph
		const quotesSample =
			quotesResult.quotes.length <= spotCheckCount
				? quotesResult.quotes
				: quotesResult.quotes.sort(() => Math.random() - 0.5).slice(0, spotCheckCount)

		// Pick random sample of balance entries from subgraph
		const balanceSample =
			balancesResult.entries.length <= spotCheckCount
				? balancesResult.entries
				: balancesResult.entries.sort(() => Math.random() - 0.5).slice(0, spotCheckCount)

		// Read pre-upgrade values from the fork
		const preQuoteSnapshots: { quoteId: string; status: number; partyA: string; partyB: string }[] = []
		for (const sq of quotesSample) {
			const q = await quoteReader.getQuote(BigInt(sq.quoteId))
			preQuoteSnapshots.push({
				quoteId: sq.quoteId,
				status: Number(q.quoteStatus),
				partyA: q.partyA.toLowerCase(),
				partyB: q.partyB.toLowerCase(),
			})
		}

		const preBalanceSnapshots: { partyB: string; partyA: string; balance: string }[] = []
		for (const entry of balanceSample) {
			const bal = await viewFacet.allocatedBalanceOfPartyB(entry.account, entry.counterParty)
			preBalanceSnapshots.push({
				partyB: entry.account,
				partyA: entry.counterParty,
				balance: bal.toString(),
			})
		}

		console.log(`Snapshot: ${preQuoteSnapshots.length} quotes + ${preBalanceSnapshots.length} balances`)
		report.steps.push({
			name: "capture_pre_snapshot",
			status: "ok",
			details: { quotes: preQuoteSnapshots.length, balances: preBalanceSnapshots.length },
		})
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 6: Pause system
		currentStep = "pause_system"
		console.log("\nGranting admin roles and pausing system...")
		await (await controlFacet.setAdmin(adminAddress)).wait()
		await (await controlFacet.grantRole(adminAddress, ethers.id("PAUSER_ROLE"))).wait()
		await (await controlFacet.grantRole(adminAddress, ethers.id("UNPAUSER_ROLE"))).wait()

		// Use v0.8.4-compatible ABI for pauseState (v0.8.4 returns 7 bools, v0.8.5 returns 8)
		const pauseChecker = new ethers.Contract(
			DIAMOND_ADDRESS,
			["function pauseState() view returns (bool globalPaused, bool, bool, bool, bool, bool, bool)"],
			admin,
		)
		const pauseResult = await pauseChecker.pauseState()
		let pausedByScript = false
		if (!pauseResult.globalPaused) {
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
		const facetsOutFile = `${outputDir}/deployed-facets.json`
		const { facets: newFacets, selectorSignatures } = await deployFacets(facetsOutFile)
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
		await (await controlFacet.setAdmin(adminAddress)).wait()
		await setV085Parameters(DIAMOND_ADDRESS, newParams, admin)
		report.steps.push({ name: "set_v085_parameters", status: "ok", details: { ...newParams } })
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 9: Deploy AccountLayer + InstantLayer and wire them
		currentStep = "deploy_account_instant_layer"
		console.log("\nDeploying AccountLayer + InstantLayer...")
		const symmioFeeReceiver = config.symmioFeeReceiver || adminAddress
		const alilStateFile = `${outputDir}/deployed-accountlayer-instantlayer.json`

		const alResult = await deployAccountLayerDiamond(adminAddress, symmioFeeReceiver, alilStateFile)
		const ilResult = await deployInstantLayer(DIAMOND_ADDRESS, adminAddress, alilStateFile)

		console.log("\nWiring contracts together...")
		await wireAccountLayerInstantLayer(DIAMOND_ADDRESS, alResult.diamondAddress, ilResult.address, admin)

		if (config.setupInstantLayerTemplates !== false) {
			await setupInstantLayerTemplates(ilResult.address, admin)
		}

		report.steps.push({
			name: "deploy_account_instant_layer",
			status: "ok",
			details: {
				accountLayerDiamond: alResult.diamondAddress,
				instantLayer: ilResult.address,
			},
		})
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 10: Verify upgrade integrity (compare pre vs post on-chain snapshot)
		currentStep = "verify_upgrade"
		console.log("\nVerifying upgrade integrity (pre vs post on-chain)...")
		const verifyErrors: string[] = []

		// Use v0.8.5 ViewFacetQuote ABI for getQuote (registered after diamondCut)
		const viewFacetQuote = await ethers.getContractAt(
			"contracts/core/facets/ViewFacetQuote/ViewFacetQuote.sol:ViewFacetQuote",
			DIAMOND_ADDRESS,
			admin,
		)

		for (const pre of preQuoteSnapshots) {
			const post = await viewFacetQuote.getQuote(BigInt(pre.quoteId))
			if (Number(post.quoteStatus) !== pre.status) {
				verifyErrors.push(`Quote ${pre.quoteId}: status changed (pre=${pre.status}, post=${post.quoteStatus})`)
			}
			if (post.partyA.toLowerCase() !== pre.partyA) {
				verifyErrors.push(`Quote ${pre.quoteId}: partyA changed`)
			}
			if (post.partyB.toLowerCase() !== pre.partyB) {
				verifyErrors.push(`Quote ${pre.quoteId}: partyB changed`)
			}
		}

		for (const pre of preBalanceSnapshots) {
			const post = await viewFacet.allocatedBalanceOfPartyB(pre.partyB, pre.partyA)
			if (post.toString() !== pre.balance) {
				verifyErrors.push(`PartyB ${pre.partyB} / PartyA ${pre.partyA}: balance changed (pre=${pre.balance}, post=${post.toString()})`)
			}
		}

		if (verifyErrors.length > 0) {
			throw new Error(`Upgrade integrity check failed:\n${verifyErrors.join("\n")}`)
		}
		console.log(`Verified ${preQuoteSnapshots.length} quotes + ${preBalanceSnapshots.length} balances: OK`)
		report.steps.push({
			name: "verify_upgrade",
			status: "ok",
			details: { quotesChecked: preQuoteSnapshots.length, balancesChecked: preBalanceSnapshots.length },
		})
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 10: Grant migration role for the next step
		currentStep = "grant_migration_role"
		await (await controlFacet.grantRole(adminAddress, ethers.id("MIGRATION_ROLE"))).wait()
		console.log("\nMigration role granted. System remains paused.")
		console.log("Next steps:")
		console.log("  1. Run prepareMigrationInput.ts to fetch + validate migration data from subgraph")
		console.log("  2. Run runMigration.ts with the validated input file")
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
