import fs from "fs"

import { ethers } from "../../test/helpers/hardhat-connection.js"
import { verifyRpc } from "./utils/rpcCheck.js"

/**
 * Generate post-migration transactions for the v0.8.5 upgrade.
 *
 * Outputs raw calldata to unpause the system and enable cross-PartyB mode.
 * Run after migration-report.json shows "status": "success".
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... npx hardhat run scripts/upgrade/generatePostMigrationBatch.ts --network arbitrum
 *
 *   # With Safe batch output
 *   DIAMOND_ADDRESS=0x... SAFE_ADDRESS=0x... npx hardhat run scripts/upgrade/generatePostMigrationBatch.ts --network arbitrum
 *
 * Config: scripts/upgrade/config/postMigration.json
 *
 * Output:
 *   scripts/upgrade/output/post-migration-transactions.json  -- Raw calldata (always)
 *   scripts/upgrade/output/post-migration-safe-batch.json    -- Safe batch (if SAFE_ADDRESS set)
 */

type CalldataTransaction = {
	to: string
	value: string
	calldata: string
	description: string
}

type Config = {
	diamondAddress?: string
	safeAddress?: string
	partyBs?: string[]
}

const CONFIG_FILE = process.env.POST_MIGRATION_CONFIG_FILE ?? "./scripts/upgrade/config/postMigration.json"
const OUTPUT_DIR = "./scripts/upgrade/output"

function loadConfig(): Config {
	if (!fs.existsSync(CONFIG_FILE)) return {}
	return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Config
}

function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

const DIAMOND_ABI = [
	"function unpauseGlobal()",
	"function setCrossPartyBModeActivated(bool activated)",
	"function setCrossPartyB(address partyB, bool enabled)",
]

const diamondIface = new ethers.Interface(DIAMOND_ABI)

async function main() {
	await verifyRpc()
	const config = loadConfig()
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
	const SAFE_ADDRESS = process.env.SAFE_ADDRESS ?? config.safeAddress
	const partyBs = config.partyBs ?? []

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("DIAMOND_ADDRESS is required")
	}

	console.log(`Diamond: ${DIAMOND_ADDRESS}`)
	console.log(`PartyBs: ${partyBs.length}`)

	for (const addr of partyBs) {
		if (!ethers.isAddress(addr) || addr === ethers.ZeroAddress) {
			throw new Error(`Invalid PartyB address: ${addr}`)
		}
	}

	const transactions: CalldataTransaction[] = []

	// 1. Unpause
	transactions.push({
		to: DIAMOND_ADDRESS,
		value: "0",
		calldata: diamondIface.encodeFunctionData("unpauseGlobal"),
		description: "unpauseGlobal()",
	})

	// 2. Enable cross-PartyB mode (global feature flag)
	if (partyBs.length > 0) {
		transactions.push({
			to: DIAMOND_ADDRESS,
			value: "0",
			calldata: diamondIface.encodeFunctionData("setCrossPartyBModeActivated", [true]),
			description: "setCrossPartyBModeActivated(true)",
		})

		// 3. Enable cross mode per PartyB
		for (const partyB of partyBs) {
			transactions.push({
				to: DIAMOND_ADDRESS,
				value: "0",
				calldata: diamondIface.encodeFunctionData("setCrossPartyB", [partyB, true]),
				description: `setCrossPartyB(${partyB}, true)`,
			})
		}
	}

	// Write output
	ensureDir(OUTPUT_DIR)

	const txsFile = `${OUTPUT_DIR}/post-migration-transactions.json`
	fs.writeFileSync(txsFile, JSON.stringify(transactions, null, 2))
	console.log(`\nWrote ${transactions.length} transactions to ${txsFile}`)

	// Optional Safe batch
	if (SAFE_ADDRESS && ethers.isAddress(SAFE_ADDRESS)) {
		const CHAIN_ID = String(Number((await ethers.provider.getNetwork()).chainId))
		const safeBatch = {
			version: "1.0",
			chainId: CHAIN_ID,
			createdAt: Date.now(),
			meta: {
				name: "Symmio v0.8.5 Post-Migration",
				description: "Unpause + enable cross-PartyB mode",
				txBuilderVersion: "1.16.5",
				createdFromSafeAddress: SAFE_ADDRESS,
				createdFromOwnerAddress: "",
			},
			transactions: transactions.map(tx => ({
				to: tx.to,
				value: tx.value,
				data: tx.calldata,
			})),
		}
		const safeFile = `${OUTPUT_DIR}/post-migration-safe-batch.json`
		fs.writeFileSync(safeFile, JSON.stringify(safeBatch, null, 2))
		console.log(`Wrote Safe batch to ${safeFile}`)
	}

	// Summary
	console.log("\nTransaction breakdown:")
	transactions.forEach((tx, i) => {
		console.log(`  ${i + 1}. ${tx.description}`)
	})
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
