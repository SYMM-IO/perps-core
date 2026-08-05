/**
 * Generate upgrade transactions for Safe multisig networks.
 *
 * Loads pre-deployed facets from output/deployed-facets.json (or FACETS_FILE),
 * builds the diamondCut against the live diamond, and outputs:
 *   1. safe-batch.json            -- human-readable Safe Transaction Builder JSON (non-diamondCut)
 *   2. diamondcut-calldata.json   -- raw diamondCut calldata chunks
 *   3. upgrade-details.json       -- selector changes + transaction breakdown
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/generateSafeBatch.ts --network arbitrum
 *
 *   # Custom facets file
 *   FACETS_FILE=./path/to/deployed-facets.json \
 *     npx hardhat run scripts/upgrade/generateSafeBatch.ts --network arbitrum
 *
 * Config: scripts/upgrade/config/upgrade.json
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { verifyMuonVerifierSafeBatch, type LoadedContext } from "./utils/batchVerifier.js"
import { loadDeploymentState } from "./utils/deploymentState.js"
import {
	buildTemplateTransactions,
	buildSymbolManagerWiringTransactions,
	buildWiringTransactions,
	filterUnregisteredPartyBs,
} from "./utils/peripheralHelpers.js"
import { resolveConfigFile } from "./utils/sharedConfig.js"
import {
	buildDiamondCut,
	buildUpgradeTransactions,
	loadDeployedFacets,
	toHumanReadableSafeTxFromIface,
	type NewV085Parameters,
	type SafeBatch,
} from "./utils/upgradeHelpers.js"

type Config = {
	diamondAddress?: string
	protocolAdmin?: string
	safeAddress?: string
	migrationRunner?: string
	diamondCutChunkSize?: number
	accountLayerDiamondAddress?: string
	instantLayerAddress?: string
	symbolManagerAddress?: string
	setupInstantLayerTemplates?: boolean
	newV085Parameters?: NewV085Parameters
}

// Matches output of deployPeripherals.ts
type DeployedPeripherals = {
	accountLayer?: { diamond?: string }
	instantLayer?: { address?: string }
	symbolManager?: { address?: string }
	signatureVerifier?: string
}

const OUTPUT_DIR = "./scripts/upgrade/output"

function loadConfig(networkName: string): Config {
	const configFile = resolveConfigFile("upgrade", networkName, process.env.UPGRADE_CONFIG_FILE)
	if (!fs.existsSync(configFile)) return {}
	return JSON.parse(fs.readFileSync(configFile, "utf-8")) as Config
}

function assertMuonVerifierSafeBatch(check: ReturnType<typeof verifyMuonVerifierSafeBatch>): void {
	const summary = (check as typeof check & { summary?: string }).summary
	if (check.ok) {
		console.log(`\nGenerated Safe batch verification: ${check.label}${summary ? ` (${summary})` : ""}`)
		return
	}

	console.error(`\nGenerated Safe batch verification failed: ${check.label}`)
	for (const issue of check.issues) {
		console.error(`  - ${issue}`)
	}
	throw new Error(`Generated ${path.basename(check.file)} failed Muon verifier permission verification`)
}

async function main() {
	const networkName = connection.networkName
	const config = loadConfig(networkName)

	const CHAIN_ID = process.env.CHAIN_ID ?? String(Number((await ethers.provider.getNetwork()).chainId))
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
	const PROTOCOL_ADMIN = process.env.PROTOCOL_ADMIN ?? process.env.ADMIN_ADDRESS ?? config.protocolAdmin
	const MIGRATION_RUNNER = process.env.MIGRATION_RUNNER ?? config.migrationRunner ?? PROTOCOL_ADMIN
	const safeRaw = process.env.SAFE_ADDRESS ?? config.safeAddress
	const SAFE_ADDRESS = safeRaw ? ethers.getAddress(safeRaw) : undefined
	const DIAMOND_CUT_CHUNK_SIZE = Number(process.env.DIAMOND_CUT_CHUNK_SIZE ?? config.diamondCutChunkSize ?? 6)
	const newParams = config.newV085Parameters ?? {}

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("DIAMOND_ADDRESS is required (env var or config file)")
	}
	if (!PROTOCOL_ADMIN || !ethers.isAddress(PROTOCOL_ADMIN)) {
		throw new Error("PROTOCOL_ADMIN is required -- the address that receives operational roles (PAUSER, UNPAUSER, etc.) and owns peripherals")
	}
	if (!SAFE_ADDRESS) {
		throw new Error("SAFE_ADDRESS is required for Safe batch generation (env var or config file)")
	}
	if (!MIGRATION_RUNNER || !ethers.isAddress(MIGRATION_RUNNER)) {
		throw new Error("MIGRATION_RUNNER must be a valid address")
	}

	console.log(`Diamond:          ${DIAMOND_ADDRESS}`)
	console.log(`Protocol admin:   ${PROTOCOL_ADMIN}`)
	console.log(`Safe:             ${SAFE_ADDRESS}`)
	console.log(`Migration runner: ${MIGRATION_RUNNER}`)
	console.log(`Chain ID:         ${CHAIN_ID}`)
	console.log()

	// Load deployed facets
	const FACETS_FILE = process.env.FACETS_FILE ?? path.join(OUTPUT_DIR, `deployed-facets-${networkName}.json`)
	const deploymentStateContext = { networkName, chainId: Number(CHAIN_ID), diamondAddress: DIAMOND_ADDRESS }
	const facetData = loadDeployedFacets(FACETS_FILE, deploymentStateContext)
	console.log()

	// Build diamond cut
	console.log("Building diamond cut...")
	console.log("Diamond cut chunk size:", DIAMOND_CUT_CHUNK_SIZE)
	const { diamondCut, selectorChanges } = await buildDiamondCut(DIAMOND_ADDRESS, facetData.facets, facetData.selectorSignatures)
	const actionCounts = { add: 0, replace: 0, remove: 0 }
	for (const change of selectorChanges) actionCounts[change.action] += 1
	console.log(`Selector changes: ${selectorChanges.length} (add=${actionCounts.add}, replace=${actionCounts.replace}, remove=${actionCounts.remove})`)
	console.log()

	// Build transactions
	console.log("Building upgrade transactions...")
	const result = buildUpgradeTransactions(
		DIAMOND_ADDRESS,
		PROTOCOL_ADMIN,
		MIGRATION_RUNNER,
		diamondCut,
		selectorChanges,
		DIAMOND_CUT_CHUNK_SIZE,
		newParams,
	)

	// Load deployed peripherals (written by deployPeripherals.ts)
	const PERIPHERALS_FILE = process.env.PERIPHERALS_FILE ?? path.join(OUTPUT_DIR, `deployed-peripherals-${networkName}.json`)
	let peripherals: DeployedPeripherals = {}
	if (fs.existsSync(PERIPHERALS_FILE)) {
		peripherals = loadDeploymentState<DeployedPeripherals>(PERIPHERALS_FILE, deploymentStateContext)
		console.log(`Loaded peripherals from ${PERIPHERALS_FILE}`)
	}

	// Resolve addresses: env > config > deployed-peripherals.json
	const AL_ADDRESS = process.env.ACCOUNT_LAYER_ADDRESS ?? (config.accountLayerDiamondAddress || peripherals.accountLayer?.diamond)
	const IL_ADDRESS = process.env.INSTANT_LAYER_ADDRESS ?? (config.instantLayerAddress || peripherals.instantLayer?.address)
	const SM_ADDRESS = process.env.SYMBOL_MANAGER_ADDRESS ?? (config.symbolManagerAddress || peripherals.symbolManager?.address)

	// Load PartyB list for Diamond + InstantLayer registration from partyBList.json.
	// Each target has its own gate: registerOnSymmioCore, registerOnInstantLayer.
	// Both default to true when the list file exists.
	const PARTYB_LIST_FILE = resolveConfigFile("partyBList", networkName, process.env.PARTYB_LIST_FILE)
	let partyBsFromConfig: string[] = []
	let registerOnSymmioCore = true
	let registerOnInstantLayer = true
	// Declared here (not inside the wiring block below) because the verifier context
	// at the end of main() reads them; a block-scoped declaration would be out of scope.
	let partyBsForDiamond: string[] = []
	let partyBsForInstantLayer: string[] = []
	if (fs.existsSync(PARTYB_LIST_FILE)) {
		const listConfig = JSON.parse(fs.readFileSync(PARTYB_LIST_FILE, "utf-8")) as {
			partyBs?: Record<string, string[]>
			registerOnSymmioCore?: boolean
			registerOnInstantLayer?: boolean
		}
		partyBsFromConfig = Object.values(listConfig.partyBs ?? {})
			.flat()
			.filter(a => ethers.isAddress(a))
		registerOnSymmioCore = listConfig.registerOnSymmioCore !== false
		registerOnInstantLayer = listConfig.registerOnInstantLayer !== false
	}

	if (AL_ADDRESS && IL_ADDRESS && ethers.isAddress(AL_ADDRESS) && ethers.isAddress(IL_ADDRESS)) {
		console.log("\nBuilding peripheral wiring transactions...")
		console.log(`  AccountLayerDiamond: ${AL_ADDRESS}`)
		console.log(`  InstantLayer:        ${IL_ADDRESS}`)

		// Pre-filter PartyBs against current on-chain state. Emitting a registration
		// tx for an already-registered PartyB would revert the whole Safe batch on
		// execution. Do this query before emitting the wiring txs so re-runs are safe.
		if (partyBsFromConfig.length > 0) {
			console.log(`  PartyBs in config:    ${partyBsFromConfig.length} (from ${PARTYB_LIST_FILE})`)
			console.log(`  Register on Core:     ${registerOnSymmioCore}`)
			console.log(`  Register on IL:       ${registerOnInstantLayer}`)
			const filtered = await filterUnregisteredPartyBs(ethers.provider, DIAMOND_ADDRESS, IL_ADDRESS, partyBsFromConfig, {
				registerOnSymmioCore,
				registerOnInstantLayer,
			})
			partyBsForDiamond = filtered.partyBsForDiamond
			partyBsForInstantLayer = filtered.partyBsForInstantLayer

			if (registerOnSymmioCore) {
				console.log("  Diamond registration state:")
				for (const s of filtered.states) {
					const mark = s.onDiamond === null ? "? skipped" : s.onDiamond ? "⏭ already registered" : "＋ will register"
					console.log(`    ${mark.padEnd(22)} ${s.address}`)
				}
			}
			if (registerOnInstantLayer) {
				console.log("  InstantLayer registration state:")
				for (const s of filtered.states) {
					const mark = s.onInstantLayer === null ? "? skipped" : s.onInstantLayer ? "⏭ already registered" : "＋ will register"
					console.log(`    ${mark.padEnd(22)} ${s.address}`)
				}
			}
			if (registerOnSymmioCore) console.log(`  → registering on Diamond:      ${partyBsForDiamond.length}`)
			if (registerOnInstantLayer) console.log(`  → registering on InstantLayer: ${partyBsForInstantLayer.length}`)
		}

		const wiringTxs = buildWiringTransactions(DIAMOND_ADDRESS, AL_ADDRESS, IL_ADDRESS, PROTOCOL_ADMIN, partyBsForDiamond, partyBsForInstantLayer)

		for (const tx of wiringTxs) {
			result.safeTxs.push(toHumanReadableSafeTxFromIface(tx.iface, tx.to, tx.methodName, tx.args))
			result.breakdown.push(`${result.breakdown.length + 1}. [wiring] ${tx.description}`)
		}
		console.log(`  Added ${wiringTxs.length} wiring transactions`)

		// InstantLayer templates
		if (config.setupInstantLayerTemplates !== false) {
			const templateTxs = buildTemplateTransactions(IL_ADDRESS)
			for (const tx of templateTxs) {
				result.safeTxs.push(toHumanReadableSafeTxFromIface(tx.iface, tx.to, tx.methodName, tx.args))
				result.breakdown.push(`${result.breakdown.length + 1}. [template] ${tx.description}`)
			}
			console.log(`  Added ${templateTxs.length} template transactions`)
		}
		// Accept AccountLayer ownership (two-step: deployPeripherals called transferOwnership, Safe must acceptOwnership)
		if (SAFE_ADDRESS) {
			const acceptOwnershipIface = new ethers.Interface(["function acceptOwnership()"])
			result.safeTxs.push(toHumanReadableSafeTxFromIface(acceptOwnershipIface, AL_ADDRESS, "acceptOwnership", []))
			result.breakdown.push(`${result.breakdown.length + 1}. [ownership] acceptOwnership() on AccountLayer`)
			console.log(`  Added acceptOwnership transaction`)
		}
	} else if (AL_ADDRESS || IL_ADDRESS) {
		console.log("\nWARN: Both accountLayerDiamondAddress and instantLayerAddress must be set for wiring. Skipping.")
	} else {
		console.log("\nNo AccountLayer/InstantLayer addresses provided. Wiring transactions will not be generated.")
		console.log("  Set accountLayerDiamondAddress and instantLayerAddress in config after deploying them.")
	}

	// SymbolManager wiring (independent of AccountLayer/InstantLayer)
	if (SM_ADDRESS && ethers.isAddress(SM_ADDRESS)) {
		console.log("\nBuilding SymbolManager wiring transactions...")
		console.log(`  SymmioSymbolManager: ${SM_ADDRESS}`)
		const smWiringTxs = buildSymbolManagerWiringTransactions(DIAMOND_ADDRESS, SM_ADDRESS)
		for (const tx of smWiringTxs) {
			result.safeTxs.push(toHumanReadableSafeTxFromIface(tx.iface, tx.to, tx.methodName, tx.args))
			result.breakdown.push(`${result.breakdown.length + 1}. [wiring] ${tx.description}`)
		}
		console.log(`  Added ${smWiringTxs.length} SymbolManager wiring transactions`)
	} else if (SM_ADDRESS) {
		console.log("\nWARN: symbolManagerAddress is not a valid address. Skipping SymbolManager wiring.")
	}

	// Write output files
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

	// 1. Pause batch (standalone — execute before diamondCut)
	const pauseFile = path.join(OUTPUT_DIR, `pause-safe-batch-${networkName}.json`)
	const pauseBatch: SafeBatch = {
		version: "1.0",
		chainId: CHAIN_ID,
		createdAt: Date.now(),
		meta: {
			name: "Symmio v0.8.5 — Pause",
			description: "Generated by scripts/upgrade/generateSafeBatch.ts",
			txBuilderVersion: "1.18.0",
			createdFromSafeAddress: SAFE_ADDRESS,
			createdFromOwnerAddress: "",
		},
		transactions: result.pauseSafeTxs,
	}
	fs.writeFileSync(pauseFile, JSON.stringify(pauseBatch, null, 2))
	console.log(`\nPause batch:              ${pauseFile}`)

	// 2. Safe batch JSON (post-diamondCut: roles, params, wiring)
	const batchFile = path.join(OUTPUT_DIR, `safe-batch-${networkName}.json`)
	const batch: SafeBatch = {
		version: "1.0",
		chainId: CHAIN_ID,
		createdAt: Date.now(),
		meta: {
			name: "Symmio v0.8.5 — Post-DiamondCut (roles + params + wiring)",
			description: "Generated by scripts/upgrade/generateSafeBatch.ts",
			txBuilderVersion: "1.18.0",
			createdFromSafeAddress: SAFE_ADDRESS,
			createdFromOwnerAddress: "",
		},
		transactions: result.safeTxs,
	}
	fs.writeFileSync(batchFile, JSON.stringify(batch, null, 2))
	console.log(`Safe batch:               ${batchFile}`)

	const verifierContext: LoadedContext = {
		networkName,
		outputDir: OUTPUT_DIR,
		diamondAddress: ethers.getAddress(DIAMOND_ADDRESS),
		protocolAdmin: ethers.getAddress(PROTOCOL_ADMIN),
		safeAddress: SAFE_ADDRESS,
		migrationRunner: ethers.getAddress(MIGRATION_RUNNER),
		diamondCutChunkSize: DIAMOND_CUT_CHUNK_SIZE,
		setupInstantLayerTemplates: config.setupInstantLayerTemplates !== false,
		newParams,
		partyBsToRegister: partyBsFromConfig.map(address => ethers.getAddress(address)),
		registerOnSymmioCore,
		registerOnInstantLayer,
		partyBsForDiamond,
		partyBsForInstantLayer,
		templates: [],
		accountLayerAddress: AL_ADDRESS && ethers.isAddress(AL_ADDRESS) ? ethers.getAddress(AL_ADDRESS) : undefined,
		instantLayerAddress: IL_ADDRESS && ethers.isAddress(IL_ADDRESS) ? ethers.getAddress(IL_ADDRESS) : undefined,
		symbolManagerAddress: SM_ADDRESS && ethers.isAddress(SM_ADDRESS) ? ethers.getAddress(SM_ADDRESS) : undefined,
		signatureVerifierAddress:
			newParams.signatureVerifierAddress && ethers.isAddress(newParams.signatureVerifierAddress)
				? ethers.getAddress(newParams.signatureVerifierAddress)
				: peripherals.signatureVerifier,
		deployedFacets: facetData.facets,
		selectorSignatures: facetData.selectorSignatures,
		files: {
			pauseSafeBatch: pauseFile,
			safeBatch: batchFile,
			diamondCutCalldata: path.join(OUTPUT_DIR, `diamondcut-calldata-${networkName}.json`),
			timelockSchedule: [],
			timelockExecute: [],
			postMigrationSafeBatch: path.join(OUTPUT_DIR, `post-migration-safe-batch-${networkName}.json`),
			postMigrationTransactions: path.join(OUTPUT_DIR, `post-migration-transactions-${networkName}.json`),
			grantSymbolRoleSafeBatch: path.join(OUTPUT_DIR, `grant-symbol-role-safe-batch-${networkName}.json`),
			revokeSymbolRoleSafeBatch: path.join(OUTPUT_DIR, `revoke-symbol-role-safe-batch-${networkName}.json`),
			addTemplatesSafeBatch: path.join(OUTPUT_DIR, `add-templates-safe-batch-${networkName}.json`),
		},
	}
	assertMuonVerifierSafeBatch(verifyMuonVerifierSafeBatch(verifierContext))

	// 2. Diamond cut calldata (separate)
	const diamondCutFile = path.join(OUTPUT_DIR, `diamondcut-calldata-${networkName}.json`)
	fs.writeFileSync(
		diamondCutFile,
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				diamondAddress: DIAMOND_ADDRESS,
				chunks: result.diamondCutCalldataChunks,
			},
			null,
			2,
		),
	)
	console.log(`DiamondCut calldata:      ${diamondCutFile}`)

	// 3. Details file
	const detailsFile = path.join(OUTPUT_DIR, `upgrade-details-${networkName}.json`)
	fs.writeFileSync(
		detailsFile,
		JSON.stringify(
			{
				diamondAddress: DIAMOND_ADDRESS,
				protocolAdmin: PROTOCOL_ADMIN,
				safeAddress: SAFE_ADDRESS,
				migrationRunner: MIGRATION_RUNNER,
				chainId: CHAIN_ID,
				safeBatchTransactionCount: result.safeTxs.length,
				diamondCutChunks: result.diamondCutCalldataChunks.length,
				chunkSize: DIAMOND_CUT_CHUNK_SIZE,
				breakdown: result.breakdown,
				selectorChanges: result.selectorChanges,
			},
			null,
			2,
		),
	)
	console.log(`Details:                  ${detailsFile}`)

	console.log(`\nPause batch breakdown (${result.pauseBreakdown.length} txs):`)
	for (const line of result.pauseBreakdown) {
		console.log(`  ${line}`)
	}

	console.log(`\nPost-diamondCut batch breakdown (${result.breakdown.length} txs):`)
	for (const line of result.breakdown) {
		console.log(`  ${line}`)
	}

	console.log("\nExecution order:")
	console.log(`  1. Import pause-safe-batch-${networkName}.json → execute from Safe (pause system)`)
	console.log(`  2. Execute diamondCut from diamondcut-calldata-${networkName}.json (via timelock or direct)`)
	console.log(`  3. Import safe-batch-${networkName}.json → execute from Safe (roles + params + wiring + accept AL ownership)`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
