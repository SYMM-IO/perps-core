import fs from "fs"

import { ethers } from "../../test/helpers/hardhat-connection.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { loadUpgradeConfigShared } from "./utils/sharedConfig.js"
import { toHumanReadableSafeTxFromIface, type SafeBatch, type SafeTransaction } from "./utils/upgradeHelpers.js"

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
	methodName: string
	args: any[]
}

type Config = {
	diamondAddress?: string
	safeAddress?: string
	migrationRunner?: string
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
	"function revokeRole(address user, bytes32 role)",
	"function unpauseGlobal()",
	"function setCrossPartyBModeActivated(bool activated)",
	"function setCrossPartyB(address partyB, bool enabled)",
]

const diamondIface = new ethers.Interface(DIAMOND_ABI)

async function main() {
	await verifyRpc()
	const config = loadConfig()
	const shared = loadUpgradeConfigShared()
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress ?? shared.diamondAddress
	const SAFE_ADDRESS = process.env.SAFE_ADDRESS ?? config.safeAddress ?? shared.safeAddress
	const MIGRATION_RUNNER = process.env.MIGRATION_RUNNER ?? config.migrationRunner ?? shared.migrationRunner
	const partyBs = config.partyBs ?? []

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("DIAMOND_ADDRESS is required")
	}
	if (!MIGRATION_RUNNER || !ethers.isAddress(MIGRATION_RUNNER)) {
		throw new Error("MIGRATION_RUNNER is required for role revocation (env var, postMigration.json, or upgrade.json)")
	}

	console.log(`Diamond:          ${DIAMOND_ADDRESS}`)
	console.log(`Migration runner: ${MIGRATION_RUNNER}`)
	console.log(`PartyBs:          ${partyBs.length}`)

	for (const addr of partyBs) {
		if (!ethers.isAddress(addr) || addr === ethers.ZeroAddress) {
			throw new Error(`Invalid PartyB address: ${addr}`)
		}
	}

	const transactions: CalldataTransaction[] = []

	const addTx = (methodName: string, args: any[], description: string) => {
		transactions.push({
			to: DIAMOND_ADDRESS,
			value: "0",
			calldata: diamondIface.encodeFunctionData(methodName, args),
			description,
			methodName,
			args,
		})
	}

	// 1. Revoke migration roles before unpause
	addTx("revokeRole", [MIGRATION_RUNNER, ethers.id("MIGRATION_ROLE")], `revokeRole(MIGRATION_ROLE) <- ${MIGRATION_RUNNER}`)
	addTx("revokeRole", [MIGRATION_RUNNER, ethers.id("SYMBOL_MANAGER_ROLE")], `revokeRole(SYMBOL_MANAGER_ROLE) <- ${MIGRATION_RUNNER}`)

	// 2. Unpause
	addTx("unpauseGlobal", [], "unpauseGlobal()")

	// 3. Enable cross-PartyB mode (global feature flag)
	if (partyBs.length > 0) {
		addTx("setCrossPartyBModeActivated", [true], "setCrossPartyBModeActivated(true)")

		// 4. Enable cross mode per PartyB
		for (const partyB of partyBs) {
			addTx("setCrossPartyB", [partyB, true], `setCrossPartyB(${partyB}, true)`)
		}
	}

	// Write output
	ensureDir(OUTPUT_DIR)

	const txsFile = `${OUTPUT_DIR}/post-migration-transactions.json`
	const rawTxs = transactions.map(({ to, value, calldata, description }) => ({ to, value, calldata, description }))
	fs.writeFileSync(txsFile, JSON.stringify(rawTxs, null, 2))
	console.log(`\nWrote ${transactions.length} transactions to ${txsFile}`)

	// Optional Safe batch
	if (SAFE_ADDRESS && ethers.isAddress(SAFE_ADDRESS)) {
		const CHAIN_ID = String(Number((await ethers.provider.getNetwork()).chainId))
		const safeTxs: SafeTransaction[] = transactions.map(tx => toHumanReadableSafeTxFromIface(diamondIface, tx.to, tx.methodName, tx.args))
		const safeBatch: SafeBatch = {
			version: "1.0",
			chainId: CHAIN_ID,
			createdAt: Date.now(),
			meta: {
				name: "Symmio v0.8.5 Post-Migration",
				description: "Unpause + enable cross-PartyB mode",
				txBuilderVersion: "1.18.0",
				createdFromSafeAddress: SAFE_ADDRESS,
				createdFromOwnerAddress: "",
			},
			transactions: safeTxs,
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
