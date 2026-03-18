import fs from "fs"
import path from "path"

import { ethers } from "../../test/helpers/hardhat-connection.js"
import { getImpersonatedAdmin } from "./utils/forkHelpers.js"
import { buildDiamondCut, buildUpgradeTransactions, loadDeployedFacets, type CalldataTransaction } from "./utils/upgradeHelpers.js"

/**
 * Generate upgrade transactions for EOA (externally owned account) networks.
 *
 * Loads pre-deployed facets from output/deployed-facets.json (or FACETS_FILE),
 * builds the diamondCut against the live diamond, and outputs:
 *   1. eoa-transactions.json      -- raw calldata for all txs except diamondCut
 *   2. diamondcut-calldata.json   -- raw diamondCut calldata chunks
 *   3. upgrade-details.json       -- selector changes + transaction breakdown
 *
 * Supports EXECUTE=true for fork testing (executes all txs including diamondCut).
 *
 * Usage:
 *   # Generate only
 *   npx hardhat run scripts/upgrade/generateEoaUpgradeTxs.ts --network arbitrum
 *
 *   # Generate + execute on fork
 *   EXECUTE=true npx hardhat run scripts/upgrade/generateEoaUpgradeTxs.ts --network localhost
 *
 *   # Custom facets file
 *   FACETS_FILE=./path/to/deployed-facets.json \
 *     npx hardhat run scripts/upgrade/generateEoaUpgradeTxs.ts --network arbitrum
 *
 * Config: scripts/upgrade/config/upgrade.json
 */

type Config = {
	diamondAddress?: string
	adminAddress?: string
	migrationRunner?: string
	diamondCutChunkSize?: number
	execute?: boolean
	newV085Parameters?: {
		maxPartyAConnectionLimit?: number
		signatureVerifierAddress?: string
		liquidationInsuranceVault?: string
		maxLiquidationProfitPerPosition?: string
		softLiquidationPenaltyCollector?: string
		minAffiliateFee?: string
		unbindCooldown?: number
		maxWithdrawParts?: number
		minWithdrawCooldown?: number
	}
}

function parseBool(value: string | boolean | undefined, fallback: boolean): boolean {
	if (value === undefined || value === null || value === "") return fallback
	if (typeof value === "boolean") return value
	const normalized = String(value).toLowerCase()
	if (normalized === "true" || normalized === "1") return true
	if (normalized === "false" || normalized === "0") return false
	throw new Error(`Invalid boolean value: ${value}`)
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
	const DIAMOND_CUT_CHUNK_SIZE = Number(process.env.DIAMOND_CUT_CHUNK_SIZE ?? config.diamondCutChunkSize ?? 6)
	const EXECUTE = parseBool(process.env.EXECUTE, config.execute ?? false)
	const newParams = config.newV085Parameters ?? {}

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("DIAMOND_ADDRESS is required (env var or config file)")
	}
	if (!ADMIN_ADDRESS || !ethers.isAddress(ADMIN_ADDRESS)) {
		throw new Error("ADMIN_ADDRESS is required -- the address that will execute upgrade transactions")
	}
	if (!MIGRATION_RUNNER || !ethers.isAddress(MIGRATION_RUNNER)) {
		throw new Error("MIGRATION_RUNNER must be a valid address")
	}

	console.log(`Diamond:          ${DIAMOND_ADDRESS}`)
	console.log(`Admin:            ${ADMIN_ADDRESS}`)
	console.log(`Migration runner: ${MIGRATION_RUNNER}`)
	console.log(`Chain ID:         ${CHAIN_ID}`)
	console.log(`Execute:          ${EXECUTE}`)
	console.log()

	// Load deployed facets
	const FACETS_FILE = process.env.FACETS_FILE ?? path.join(OUTPUT_DIR, "deployed-facets.json")
	const facetData = loadDeployedFacets(FACETS_FILE)
	console.log()

	// Build diamond cut
	console.log("Building diamond cut...")
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

	// Write output files
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

	// 1. EOA transactions (raw calldata, non-diamondCut)
	const txFile = path.join(OUTPUT_DIR, "eoa-transactions.json")
	fs.writeFileSync(
		txFile,
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				diamondAddress: DIAMOND_ADDRESS,
				adminAddress: ADMIN_ADDRESS,
				migrationRunner: MIGRATION_RUNNER,
				chainId: CHAIN_ID,
				transactions: result.calldataTxs,
			},
			null,
			2,
		),
	)
	console.log(`\nEOA transactions:         ${txFile}`)

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
				migrationRunner: MIGRATION_RUNNER,
				chainId: CHAIN_ID,
				eoaTransactionCount: result.calldataTxs.length,
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

	console.log("\nUse eoa-transactions.json calldata to execute from any wallet.")
	console.log("Execute diamondCut calldata from diamondcut-calldata.json separately.")

	// Execute on-chain (fork testing)
	if (EXECUTE) {
		console.log("\n" + "=".repeat(70))
		console.log(" Executing transactions on-chain")
		console.log("=".repeat(70))

		const admin = await getImpersonatedAdmin(DIAMOND_ADDRESS)
		const ownerAddress = await admin.getAddress()

		// Bootstrap roles for fork testing
		console.log(`\nBootstrapping roles for diamond owner...`)
		const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", DIAMOND_ADDRESS, admin)
		await (await controlFacet.setAdmin(ownerAddress)).wait()
		console.log(`  DEFAULT_ADMIN_ROLE granted via setAdmin()`)

		const bootstrapRoles = ["PAUSER_ROLE", "UNPAUSER_ROLE", "PROTOCOL_CONFIG_ROLE", "COOLDOWN_ADMIN_ROLE", "FEE_ADMIN_ROLE", "MIGRATION_ROLE"]
		for (const role of bootstrapRoles) {
			await (await controlFacet.grantRole(ownerAddress, ethers.id(role))).wait()
			console.log(`  ${role} granted`)
		}
		console.log(`  Done.`)

		// Build execution-ordered list: pre-cut txs, diamondCut chunks, post-cut txs
		const preCutTxs = result.calldataTxs.slice(0, result.diamondCutInsertionIndex)
		const postCutTxs = result.calldataTxs.slice(result.diamondCutInsertionIndex)
		const diamondCutTxs: CalldataTransaction[] = result.diamondCutCalldataChunks.map(chunk => ({
			to: DIAMOND_ADDRESS,
			value: "0",
			calldata: chunk.calldata,
			description: chunk.description,
		}))

		const allTxs: CalldataTransaction[] = [...preCutTxs, ...diamondCutTxs, ...postCutTxs]

		for (let i = 0; i < allTxs.length; i++) {
			const tx = allTxs[i]
			console.log(`\n[${i + 1}/${allTxs.length}] ${tx.description}`)
			const response = await admin.sendTransaction({
				to: tx.to,
				value: tx.value,
				data: tx.calldata,
			})
			const receipt = await response.wait(1)
			console.log(`  tx: ${receipt.hash} (gas: ${receipt.gasUsed.toString()})`)
		}

		console.log(`\nAll ${allTxs.length} transactions executed successfully.`)
	}
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
