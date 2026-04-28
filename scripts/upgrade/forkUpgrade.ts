import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { getImpersonatedAdmin, impersonateAndFund } from "./utils/forkHelpers.js"
import { log } from "./utils/log.js"
import { deployAccountLayerDiamond, deployInstantLayer, wireAccountLayerInstantLayer, setupInstantLayerTemplates } from "./utils/peripheralHelpers.js"
import { runPreflight } from "./utils/preflight.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { baseNetworkName, resolveConfigFile } from "./utils/sharedConfig.js"
import { createStepReporter } from "./utils/stepReporter.js"
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
	protocolAdmin?: string
	diamondCutChunkSize?: number
	subgraphEndpoint?: string
	spotCheckCount?: number
	symmioFeeReceiver?: string
	setupInstantLayerTemplates?: boolean
	newV085Parameters?: NewV085Parameters
}

type StepResult = {
	name: string
	status: "ok" | "error"
	startedAt?: string
	finishedAt?: string
	durationMs?: number
	details?: Record<string, unknown>
}

type ForkUpgradeReport = {
	status: "running" | "success" | "failed"
	startedAt: string
	finishedAt?: string
	durationMs?: number
	diamondAddress?: string
	protocolAdmin?: string
	steps: StepResult[]
	error?: string
}

function loadConfig(networkName?: string): ForkUpgradeConfig {
	const CONFIG_FILE = resolveConfigFile("upgrade", baseNetworkName(networkName), process.env.UPGRADE_CONFIG_FILE)
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
		log.error(`Failed to write report: ${formatError(error)}`)
	}
}

function printStepTimings(steps: StepResult[], totalMs: number): void {
	const timed = steps.filter(s => typeof s.durationMs === "number")
	if (timed.length === 0) return
	console.log("")
	console.log("  Step timings:")
	const rows: Array<[string, string | number]> = timed.map(s => {
		const label = `${s.name}${s.status === "error" ? " (error)" : ""}`
		const pct = totalMs > 0 ? ((s.durationMs! / totalMs) * 100).toFixed(1) : "0.0"
		return [label, `${log.formatMs(s.durationMs!)}  (${pct}%)`]
	})
	rows.push(["total", log.formatMs(totalMs)])
	log.stats(rows)
}

async function main() {
	const scriptTimer = log.timer()
	await verifyRpc()
	const startedAtMs = Date.now()
	const config = loadConfig(connection.networkName)

	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
	const ADMIN_ADDRESS = process.env.PROTOCOL_ADMIN ?? process.env.ADMIN_ADDRESS ?? (config.protocolAdmin || undefined)
	const DIAMOND_CUT_CHUNK_SIZE = Number(process.env.DIAMOND_CUT_CHUNK_SIZE ?? config.diamondCutChunkSize ?? 6)
	const SUBGRAPH_ENDPOINT = process.env.SUBGRAPH_ENDPOINT || config.subgraphEndpoint || DEFAULT_SUBGRAPH_ENDPOINT
	const newParams = config.newV085Parameters ?? {}

	const outputDir = "./scripts/upgrade/output"
	// Suffix output artifacts with the base chain name (e.g. fork-base -> base) so
	// running this against different chains doesn't clobber or mix state files.
	const networkSuffix = baseNetworkName(connection.networkName)
	const withSuffix = (baseName: string, ext = "json"): string => networkSuffix ? `${baseName}-${networkSuffix}.${ext}` : `${baseName}.${ext}`
	const reportFile = `${outputDir}/${withSuffix("forkUpgrade-report")}`

	const report: ForkUpgradeReport = {
		status: "running",
		startedAt: new Date(startedAtMs).toISOString(),
		steps: [],
	}
	tryWriteReport(reportFile, report)
	let currentStep: string | null = null

	const { finish: finishStep } = createStepReporter(report.steps)

	// Variables that need to survive across steps for the summary
	let accountLayerAddress = ""
	let instantLayerAddress = ""

	try {
		// ── Preflight ────────────────────────────────────────────────────
		// Fail early with a clear message before any impersonation or on-chain
		// side effects. See utils/preflight.ts for the checklist.
		currentStep = "preflight"
		await runPreflight(connection.networkName, {
			diamondAddress: DIAMOND_ADDRESS,
			signatureVerifierAddress: newParams.signatureVerifierAddress,
			subgraphEndpoint: SUBGRAPH_ENDPOINT,
			stateFiles: [
				`${outputDir}/${withSuffix("deployed-facets")}`,
				`${outputDir}/${withSuffix("deployed-peripherals")}`,
				`${outputDir}/${withSuffix("deployed-accountlayer-instantlayer")}`,
			],
		})
		report.steps.push({ name: "preflight", status: "ok" })
		currentStep = null
		tryWriteReport(reportFile, report)

		// ── Validate inputs ──────────────────────────────────────────────
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

		log.header("Symmio v0.8.5 Fork Upgrade")
		log.kv("Diamond", log.addr(DIAMOND_ADDRESS))
		log.kv("Subgraph", SUBGRAPH_ENDPOINT)

		log.setSteps(11)

		// ── Step 1: Resolve + impersonate admin ──────────────────────────
		let t = log.step("Resolve and impersonate admin")
		currentStep = "impersonate_admin"
		const admin = await getImpersonatedAdmin(DIAMOND_ADDRESS, ADMIN_ADDRESS)
		const adminAddress = await admin.getAddress()
		report.protocolAdmin = adminAddress
		report.steps.push({ name: "impersonate_admin", status: "ok", details: { adminAddress } })
		currentStep = null
		tryWriteReport(reportFile, report)
		finishStep(t)

		// ── Step 2: Connect facets ───────────────────────────────────────
		t = log.step("Connect to existing facets")
		currentStep = "connect_facets"
		const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", DIAMOND_ADDRESS, admin)
		const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", DIAMOND_ADDRESS, admin)
		const pauseControlFacet = await ethers.getContractAt(
			"contracts/core/facets/PauseControl/PauseControlFacet.sol:PauseControlFacet",
			DIAMOND_ADDRESS,
			admin,
		)
		log.ok("ViewFacet, ControlFacet, PauseControlFacet connected")
		report.steps.push({ name: "connect_facets", status: "ok" })
		currentStep = null
		tryWriteReport(reportFile, report)
		finishStep(t)

		// ── Step 3: Fetch subgraph data ──────────────────────────────────
		t = log.step("Fetch subgraph data")
		currentStep = "fetch_subgraph"
		const [quotesResult, balancesResult] = await Promise.all([fetchOpenQuotes(SUBGRAPH_ENDPOINT), fetchPartyBBalances(SUBGRAPH_ENDPOINT)])
		const partyAs = quotesResult.partyAs
		const partyBs = quotesResult.partyBs
		log.stats([
			["Open quotes", quotesResult.quotes.length],
			["Unique partyAs", partyAs.length],
			["Unique partyBs", partyBs.length],
			["Balance entries", balancesResult.entries.length],
		])
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
		finishStep(t)

		// ── Step 4: Capture pre-upgrade snapshot ─────────────────────────
		t = log.step("Capture pre-upgrade on-chain snapshot")
		currentStep = "capture_pre_snapshot"
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

		log.info(`Sampling ${quotesSample.length} quotes + ${balanceSample.length} balances from on-chain...`)

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

		log.ok(`Snapshot captured: ${preQuoteSnapshots.length} quotes + ${preBalanceSnapshots.length} balances`)
		report.steps.push({
			name: "capture_pre_snapshot",
			status: "ok",
			details: { quotes: preQuoteSnapshots.length, balances: preBalanceSnapshots.length },
		})
		currentStep = null
		tryWriteReport(reportFile, report)
		finishStep(t)

		// ── Step 5: Pause system ─────────────────────────────────────────
		t = log.step("Pause system")
		currentStep = "pause_system"
		await (await controlFacet.setAdmin(adminAddress)).wait()
		log.ok("Admin set")
		await (await controlFacet.grantRole(adminAddress, ethers.id("PAUSER_ROLE"))).wait()
		log.ok("PAUSER_ROLE granted")
		await (await controlFacet.grantRole(adminAddress, ethers.id("UNPAUSER_ROLE"))).wait()
		log.ok("UNPAUSER_ROLE granted")

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
			log.ok("System paused (pauseGlobal)")
		} else {
			log.ok("System already paused")
		}
		report.steps.push({ name: "pause_system", status: "ok", details: { pausedByScript } })
		currentStep = null
		tryWriteReport(reportFile, report)
		finishStep(t)

		// ── Step 6: Deploy v0.8.5 facets ─────────────────────────────────
		t = log.step("Deploy v0.8.5 facets")
		currentStep = "deploy_facets"
		const facetsOutFile = `${outputDir}/${withSuffix("deployed-facets")}`
		const { facets: newFacets, selectorSignatures } = await deployFacets(facetsOutFile)
		log.ok(`${Object.keys(newFacets).length} facets ready`)
		report.steps.push({
			name: "deploy_facets",
			status: "ok",
			details: { facetCount: Object.keys(newFacets).length },
		})
		currentStep = null
		tryWriteReport(reportFile, report)
		finishStep(t)

		// ── Step 7: Build + apply diamond cut ────────────────────────────
		t = log.step("Build and apply diamond cut")
		currentStep = "build_diamond_cut"
		const { diamondCut, selectorChanges } = await buildDiamondCut(DIAMOND_ADDRESS, newFacets, selectorSignatures)
		const actionCounts = { add: 0, replace: 0, remove: 0 }
		for (const change of selectorChanges) {
			actionCounts[change.action] += 1
		}
		log.info("Selector changes:")
		log.stats([
			["Add", actionCounts.add],
			["Replace", actionCounts.replace],
			["Remove", actionCounts.remove],
			["Total", selectorChanges.length],
		])
		// Catches: operator ran forkUpgrade against an already-upgraded diamond (e.g.
		// pointing at a chain that's already on v0.8.5). The diff shows zero changes,
		// so the diamondCut would be a no-op — but downstream steps (role grants,
		// peripheral deploys, parameter sets) would still fire. Abort early so the
		// operator realizes they picked the wrong chain rather than re-paying those costs.
		if (selectorChanges.length === 0) {
			throw new Error(
				`Diamond at ${DIAMOND_ADDRESS} already exposes every v0.8.5 selector — nothing to upgrade. ` +
					`If you intended to rehearse migration only, skip forkUpgrade.ts and run the migration scripts directly.`,
			)
		}
		report.steps.push({
			name: "build_diamond_cut",
			status: "ok",
			details: { totalChanges: selectorChanges.length, ...actionCounts },
		})
		currentStep = null
		tryWriteReport(reportFile, report)

		currentStep = "apply_diamond_cut"
		await applyDiamondCut(DIAMOND_ADDRESS, diamondCut, admin, DIAMOND_CUT_CHUNK_SIZE)
		log.ok("Diamond cut applied")
		report.steps.push({ name: "apply_diamond_cut", status: "ok" })
		currentStep = null
		tryWriteReport(reportFile, report)
		finishStep(t)

		// ── Step 8: Set new v0.8.5 parameters ───────────────────────────
		t = log.step("Set v0.8.5 parameters")
		currentStep = "set_v085_parameters"
		await (await controlFacet.setAdmin(adminAddress)).wait()

		// Fork-only: grant SETTER_ROLE on the existing MuonSignatureVerifier to our
		// impersonated signer. On production the Safe already holds this role; on a fork
		// the diamond owner (often a timelock) does not, so the seeding calls revert.
		if (newParams.signatureVerifierAddress && ethers.isAddress(newParams.signatureVerifierAddress)) {
			const verifierAccess = await ethers.getContractAt(
				[
					"function SETTER_ROLE() view returns (bytes32)",
					"function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
					"function hasRole(bytes32,address) view returns (bool)",
					"function getRoleMember(bytes32,uint256) view returns (address)",
					"function grantRole(bytes32,address)",
				],
				newParams.signatureVerifierAddress,
				admin,
			)
			const setterRole = await verifierAccess.SETTER_ROLE()
			if (!(await verifierAccess.hasRole(setterRole, adminAddress))) {
				const defaultAdminRole = await verifierAccess.DEFAULT_ADMIN_ROLE()
				const verifierAdmin = await verifierAccess.getRoleMember(defaultAdminRole, 0)
				const verifierAdminSigner = await impersonateAndFund(verifierAdmin)
				await (await verifierAccess.connect(verifierAdminSigner).grantRole(setterRole, adminAddress)).wait()
				log.ok(`Fork patch: SETTER_ROLE granted to ${log.addr(adminAddress)} on verifier (via ${log.addr(verifierAdmin)})`)
			}
		}

		await setV085Parameters(DIAMOND_ADDRESS, newParams, admin)
		if (Object.keys(newParams).length === 0) {
			log.info("(no parameters configured)")
		}
		report.steps.push({ name: "set_v085_parameters", status: "ok", details: { ...newParams } })
		currentStep = null
		tryWriteReport(reportFile, report)
		finishStep(t)

		// ── Step 9: Deploy AccountLayer + InstantLayer ───────────────────
		t = log.step("Deploy AccountLayer + InstantLayer")
		currentStep = "deploy_account_instant_layer"
		const symmioFeeReceiver = config.symmioFeeReceiver || adminAddress
		const alilStateFile = `${outputDir}/${withSuffix("deployed-accountlayer-instantlayer")}`

		const alResult = await deployAccountLayerDiamond(adminAddress, symmioFeeReceiver, alilStateFile, admin)
		const ilResult = await deployInstantLayer(DIAMOND_ADDRESS, adminAddress, alilStateFile)
		accountLayerAddress = alResult.diamondAddress
		instantLayerAddress = ilResult.address

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
		finishStep(t)

		// ── Step 10: Register PartyBs on Diamond + InstantLayer ─────────
		t = log.step("Register PartyBs on Diamond + InstantLayer")
		currentStep = "register_partybs"
		const PARTYB_LIST_FILE = resolveConfigFile("partyBList", baseNetworkName(connection.networkName), process.env.PARTYB_LIST_FILE)
		const registeredOnDiamond: string[] = []
		const registeredOnInstantLayer: string[] = []

		if (fs.existsSync(PARTYB_LIST_FILE)) {
			const listConfig = JSON.parse(fs.readFileSync(PARTYB_LIST_FILE, "utf-8")) as {
				partyBs?: Record<string, string[]>
				registerOnSymmioCore?: boolean
				registerOnInstantLayer?: boolean
			}
			const partyBsToRegister = Object.values(listConfig.partyBs ?? {})
				.flat()
				.filter((a: string) => ethers.isAddress(a))
			const registerOnSymmioCore = listConfig.registerOnSymmioCore !== false

			if (partyBsToRegister.length > 0 && registerOnSymmioCore) {
				// Diamond registration — needs PARTY_B_MANAGER_ROLE. Admin is DEFAULT_ADMIN
				// so grant-to-self is safe and idempotent.
				await (await controlFacet.grantRole(adminAddress, ethers.id("PARTY_B_MANAGER_ROLE"))).wait()
				log.ok("PARTY_B_MANAGER_ROLE granted")
				for (const partyB of partyBsToRegister) {
					const isRegistered = await viewFacet.isPartyB(partyB)
					if (!isRegistered) {
						await (await controlFacet.registerPartyB(partyB)).wait()
						log.ok(`Registered ${log.addr(partyB)} on Diamond`)
						registeredOnDiamond.push(partyB)
					} else {
						log.ok(`${log.addr(partyB)} already registered on Diamond`)
					}
				}
			} else if (!registerOnSymmioCore) {
				log.ok("registerOnSymmioCore is false — skipping Diamond registration")
			}

			if (listConfig.registerOnInstantLayer) {
				const il = await ethers.getContractAt("InstantLayer", ilResult.address, admin)
				for (const partyB of partyBsToRegister) {
					const isRegistered = await il.registeredPartyBs(partyB)
					if (!isRegistered) {
						await (await il.registerPartyBs([partyB])).wait()
						log.ok(`Registered ${log.addr(partyB)} on InstantLayer`)
						registeredOnInstantLayer.push(partyB)
					} else {
						log.ok(`${log.addr(partyB)} already registered on InstantLayer`)
					}
				}
			} else {
				log.ok("registerOnInstantLayer is false — skipping IL registration")
			}
		} else {
			log.warn(`${PARTYB_LIST_FILE} not found — skipping PartyB registration`)
		}

		report.steps.push({
			name: "register_partybs",
			status: "ok",
			details: {
				registeredOnDiamond,
				registeredOnInstantLayer,
			},
		})
		currentStep = null
		tryWriteReport(reportFile, report)
		finishStep(t)

		// ── Step 11: Verify upgrade integrity ────────────────────────────
		t = log.step("Verify upgrade integrity")
		currentStep = "verify_upgrade"
		const verifyErrors: string[] = []

		// Use v0.8.5 ViewFacetQuote ABI for getQuote (registered after diamondCut)
		const viewFacetQuote = await ethers.getContractAt(
			"contracts/core/facets/ViewFacetQuote/ViewFacetQuote.sol:ViewFacetQuote",
			DIAMOND_ADDRESS,
			admin,
		)

		log.info(`Verifying ${preQuoteSnapshots.length} quotes...`)
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

		log.info(`Verifying ${preBalanceSnapshots.length} balances...`)
		for (const pre of preBalanceSnapshots) {
			const post = await viewFacet.allocatedBalanceOfPartyB(pre.partyB, pre.partyA)
			if (post.toString() !== pre.balance) {
				verifyErrors.push(`PartyB ${pre.partyB} / PartyA ${pre.partyA}: balance changed (pre=${pre.balance}, post=${post.toString()})`)
			}
		}

		if (verifyErrors.length > 0) {
			throw new Error(`Upgrade integrity check failed:\n${verifyErrors.join("\n")}`)
		}
		log.ok(`${preQuoteSnapshots.length} quotes + ${preBalanceSnapshots.length} balances verified — all match`)
		report.steps.push({
			name: "verify_upgrade",
			status: "ok",
			details: { quotesChecked: preQuoteSnapshots.length, balancesChecked: preBalanceSnapshots.length },
		})
		currentStep = null
		tryWriteReport(reportFile, report)
		finishStep(t)

		// ── Grant migration role ─────────────────────────────────────────
		currentStep = "grant_migration_role"
		await (await controlFacet.grantRole(adminAddress, ethers.id("MIGRATION_ROLE"))).wait()
		log.ok(`MIGRATION_ROLE granted to ${log.addr(adminAddress)}`)
		report.steps.push({ name: "grant_migration_role", status: "ok" })
		currentStep = null
		tryWriteReport(reportFile, report)

		report.status = "success"

		// ── Summary ──────────────────────────────────────────────────────
		printStepTimings(report.steps, scriptTimer.ms())
		log.success("Fork upgrade completed successfully", [
			["Diamond", DIAMOND_ADDRESS],
			["AccountLayer", accountLayerAddress],
			["InstantLayer", instantLayerAddress],
			["Duration", scriptTimer.fmt()],
		])
		log.nextSteps([
			"Run prepareMigrationInput.ts to fetch + validate migration data from subgraph",
			"Run runMigration.ts with the validated input file",
			"Unpause the system after migration is complete",
		])
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
		printStepTimings(report.steps, scriptTimer.ms())
		log.failure("Fork upgrade failed", `Step: ${currentStep ?? "unknown"}\n  ${formatError(error)}`)
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
