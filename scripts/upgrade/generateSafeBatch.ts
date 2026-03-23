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

import { ethers } from "../../test/helpers/hardhat-connection.js"
import { buildWiringTransactions } from "./utils/peripheralHelpers.js"
import { buildDiamondCut, buildUpgradeTransactions, loadDeployedFacets, type NewV085Parameters, type SafeBatch } from "./utils/upgradeHelpers.js"

type Config = {
	diamondAddress?: string
	adminAddress?: string
	safeAddress?: string
	migrationRunner?: string
	diamondCutChunkSize?: number
	accountLayerDiamondAddress?: string
	instantLayerAddress?: string
	symmioPartyBAddress?: string
	symmioPartyBImplementation?: string
	newV085Parameters?: NewV085Parameters
}

// Matches output of deployPeripherals.ts
type DeployedPeripherals = {
	accountLayer?: { diamond?: string }
	instantLayer?: { address?: string }
	symmioPartyBImplementation?: string
}

const CONFIG_FILE = process.env.UPGRADE_CONFIG_FILE ?? "./scripts/upgrade/config/upgrade.json"
const OUTPUT_DIR = "./scripts/upgrade/output"

function loadConfig(): Config {
	if (!fs.existsSync(CONFIG_FILE)) return {}
	return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Config
}

async function main() {
	const config = loadConfig()

	const CHAIN_ID = process.env.CHAIN_ID ?? String(Number((await ethers.provider.getNetwork()).chainId))
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
	const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS ?? config.adminAddress
	const MIGRATION_RUNNER = process.env.MIGRATION_RUNNER ?? config.migrationRunner ?? ADMIN_ADDRESS
	const safeRaw = process.env.SAFE_ADDRESS ?? config.safeAddress
	const SAFE_ADDRESS = safeRaw ? ethers.getAddress(safeRaw) : undefined
	const DIAMOND_CUT_CHUNK_SIZE = Number(process.env.DIAMOND_CUT_CHUNK_SIZE ?? config.diamondCutChunkSize ?? 6)
	const newParams = config.newV085Parameters ?? {}

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("DIAMOND_ADDRESS is required (env var or config file)")
	}
	if (!ADMIN_ADDRESS || !ethers.isAddress(ADMIN_ADDRESS)) {
		throw new Error("ADMIN_ADDRESS is required -- the address that will execute upgrade transactions")
	}
	if (!SAFE_ADDRESS) {
		throw new Error("SAFE_ADDRESS is required for Safe batch generation (env var or config file)")
	}
	if (!MIGRATION_RUNNER || !ethers.isAddress(MIGRATION_RUNNER)) {
		throw new Error("MIGRATION_RUNNER must be a valid address")
	}

	console.log(`Diamond:          ${DIAMOND_ADDRESS}`)
	console.log(`Admin:            ${ADMIN_ADDRESS}`)
	console.log(`Safe:             ${SAFE_ADDRESS}`)
	console.log(`Migration runner: ${MIGRATION_RUNNER}`)
	console.log(`Chain ID:         ${CHAIN_ID}`)
	console.log()

	// Load deployed facets
	const FACETS_FILE = process.env.FACETS_FILE ?? path.join(OUTPUT_DIR, "deployed-facets.json")
	const facetData = loadDeployedFacets(FACETS_FILE)
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
		ADMIN_ADDRESS,
		MIGRATION_RUNNER,
		diamondCut,
		selectorChanges,
		DIAMOND_CUT_CHUNK_SIZE,
		newParams,
	)

	// Load deployed peripherals (written by deployPeripherals.ts)
	const PERIPHERALS_FILE = process.env.PERIPHERALS_FILE ?? path.join(OUTPUT_DIR, "deployed-peripherals.json")
	let peripherals: DeployedPeripherals = {}
	if (fs.existsSync(PERIPHERALS_FILE)) {
		peripherals = JSON.parse(fs.readFileSync(PERIPHERALS_FILE, "utf-8"))
		console.log(`Loaded peripherals from ${PERIPHERALS_FILE}`)
	}

	// Resolve addresses: env > config > deployed-peripherals.json
	const AL_ADDRESS = process.env.ACCOUNT_LAYER_ADDRESS ?? (config.accountLayerDiamondAddress || peripherals.accountLayer?.diamond)
	const IL_ADDRESS = process.env.INSTANT_LAYER_ADDRESS ?? (config.instantLayerAddress || peripherals.instantLayer?.address)

	const PARTYB_ADDRESS = process.env.SYMMIO_PARTYB_ADDRESS ?? config.symmioPartyBAddress
	const PARTYB_IMPL = process.env.SYMMIO_PARTYB_IMPLEMENTATION ?? (config.symmioPartyBImplementation || peripherals.symmioPartyBImplementation)

	if (AL_ADDRESS && IL_ADDRESS && ethers.isAddress(AL_ADDRESS) && ethers.isAddress(IL_ADDRESS)) {
		console.log("\nBuilding peripheral wiring transactions...")
		console.log(`  AccountLayerDiamond: ${AL_ADDRESS}`)
		console.log(`  InstantLayer:        ${IL_ADDRESS}`)
		if (PARTYB_ADDRESS) console.log(`  SymmioPartyB:        ${PARTYB_ADDRESS}`)
		const wiringTxs = buildWiringTransactions(DIAMOND_ADDRESS, AL_ADDRESS, IL_ADDRESS, ADMIN_ADDRESS, PARTYB_ADDRESS, PARTYB_IMPL)

		// SymmioPartyB UUPS proxy upgrade (if address and new implementation provided)
		if (PARTYB_ADDRESS && PARTYB_IMPL) {
			const uupsIface = new ethers.Interface(["function upgradeTo(address newImplementation)"])
			wiringTxs.unshift({
				to: PARTYB_ADDRESS,
				value: "0",
				calldata: uupsIface.encodeFunctionData("upgradeTo", [PARTYB_IMPL]),
				description: `upgradeTo(new SymmioPartyB implementation)`,
			})
		}

		for (const tx of wiringTxs) {
			result.safeTxs.push({ to: tx.to, value: tx.value, data: tx.calldata })
			result.breakdown.push(`${result.breakdown.length + 1}. [wiring] ${tx.description}`)
		}
		console.log(`  Added ${wiringTxs.length} wiring transactions`)
	} else if (AL_ADDRESS || IL_ADDRESS) {
		console.log("\nWARN: Both accountLayerDiamondAddress and instantLayerAddress must be set for wiring. Skipping.")
	} else {
		console.log("\nNo AccountLayer/InstantLayer addresses provided. Wiring transactions will not be generated.")
		console.log("  Set accountLayerDiamondAddress and instantLayerAddress in config after deploying them.")
	}

	// Write output files
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

	// 1. Safe batch JSON (human-readable, non-diamondCut)
	const batchFile = path.join(OUTPUT_DIR, "safe-batch.json")
	const batch: SafeBatch = {
		version: "1.0",
		chainId: CHAIN_ID,
		createdAt: Date.now(),
		meta: {
			name: "Symmio v0.8.5 Upgrade",
			description: "Generated by scripts/upgrade/generateSafeBatch.ts",
			txBuilderVersion: "1.18.0",
			createdFromSafeAddress: SAFE_ADDRESS,
			createdFromOwnerAddress: "",
		},
		transactions: result.safeTxs,
	}
	fs.writeFileSync(batchFile, JSON.stringify(batch, null, 2))
	console.log(`\nSafe batch:               ${batchFile}`)

	// 2. Diamond cut calldata (separate)
	const diamondCutFile = path.join(OUTPUT_DIR, "diamondcut-calldata.json")
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
	const detailsFile = path.join(OUTPUT_DIR, "upgrade-details.json")
	fs.writeFileSync(
		detailsFile,
		JSON.stringify(
			{
				diamondAddress: DIAMOND_ADDRESS,
				adminAddress: ADMIN_ADDRESS,
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

	console.log(`\nTransaction breakdown (${result.breakdown.length} total):`)
	for (const line of result.breakdown) {
		console.log(`  ${line}`)
	}

	console.log("\n1. Execute diamondCut calldata from diamondcut-calldata.json (via lock contract or direct)")
	console.log("2. Import safe-batch.json into Safe Transaction Builder to review and execute")
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
