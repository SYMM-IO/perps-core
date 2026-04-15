/**
 * Generate Safe batches to grant/revoke SYMBOL_MANAGER_ROLE for setSymbolTypes.
 *
 * Use when symbol types were not set during the migration window and the system
 * is already unpaused. Produces two files:
 *   1. grant-symbol-role-safe-batch.json   -- Grant SYMBOL_MANAGER_ROLE to migrationRunner
 *   2. revoke-symbol-role-safe-batch.json  -- Revoke SYMBOL_MANAGER_ROLE from migrationRunner
 *
 * Flow:
 *   1. Execute grant batch via Safe
 *   2. Run: npx hardhat run scripts/upgrade/setSymbolTypes.ts --network <network>
 *   3. Execute revoke batch via Safe
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/generateSymbolTypeRoleBatch.ts --network <network>
 *
 * Config: scripts/upgrade/config/upgrade.json
 */
import fs from "fs"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { loadUpgradeConfigShared } from "./utils/sharedConfig.js"
import { toHumanReadableSafeTxFromIface, type SafeBatch } from "./utils/upgradeHelpers.js"

const OUTPUT_DIR = "./scripts/upgrade/output"

const DIAMOND_ABI = ["function grantRole(address user, bytes32 role)", "function revokeRole(address user, bytes32 role)"]

const diamondIface = new ethers.Interface(DIAMOND_ABI)

async function main() {
	const shared = loadUpgradeConfigShared()

	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	const SAFE_ADDRESS = process.env.SAFE_ADDRESS ?? shared.safeAddress
	const MIGRATION_RUNNER = process.env.MIGRATION_RUNNER ?? shared.migrationRunner

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("DIAMOND_ADDRESS is required")
	}
	if (!SAFE_ADDRESS || !ethers.isAddress(SAFE_ADDRESS)) {
		throw new Error("SAFE_ADDRESS is required")
	}
	if (!MIGRATION_RUNNER || !ethers.isAddress(MIGRATION_RUNNER)) {
		throw new Error("MIGRATION_RUNNER is required")
	}

	const CHAIN_ID = String(Number((await ethers.provider.getNetwork()).chainId))
	const SYMBOL_MANAGER_ROLE = ethers.id("SYMBOL_MANAGER_ROLE")

	console.log(`Diamond:          ${DIAMOND_ADDRESS}`)
	console.log(`Safe:             ${SAFE_ADDRESS}`)
	console.log(`Migration runner: ${MIGRATION_RUNNER}`)
	console.log(`Chain ID:         ${CHAIN_ID}`)
	console.log(`Role hash:        ${SYMBOL_MANAGER_ROLE}`)
	console.log()

	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	const networkName = connection.networkName

	// 1. Grant batch
	const grantTx = toHumanReadableSafeTxFromIface(diamondIface, DIAMOND_ADDRESS, "grantRole", [MIGRATION_RUNNER, SYMBOL_MANAGER_ROLE])
	const grantBatch: SafeBatch = {
		version: "1.0",
		chainId: CHAIN_ID,
		createdAt: Date.now(),
		meta: {
			name: "Symmio v0.8.5 — Grant SYMBOL_MANAGER_ROLE",
			description: `Grant SYMBOL_MANAGER_ROLE to ${MIGRATION_RUNNER} for setSymbolTypes`,
			txBuilderVersion: "1.18.0",
			createdFromSafeAddress: SAFE_ADDRESS,
			createdFromOwnerAddress: "",
		},
		transactions: [grantTx],
	}
	const grantFile = `${OUTPUT_DIR}/grant-symbol-role-safe-batch-${networkName}.json`
	fs.writeFileSync(grantFile, JSON.stringify(grantBatch, null, 2))
	console.log(`Grant batch:  ${grantFile}`)

	// 2. Revoke batch
	const revokeTx = toHumanReadableSafeTxFromIface(diamondIface, DIAMOND_ADDRESS, "revokeRole", [MIGRATION_RUNNER, SYMBOL_MANAGER_ROLE])
	const revokeBatch: SafeBatch = {
		version: "1.0",
		chainId: CHAIN_ID,
		createdAt: Date.now(),
		meta: {
			name: "Symmio v0.8.5 — Revoke SYMBOL_MANAGER_ROLE",
			description: `Revoke SYMBOL_MANAGER_ROLE from ${MIGRATION_RUNNER} after setSymbolTypes`,
			txBuilderVersion: "1.18.0",
			createdFromSafeAddress: SAFE_ADDRESS,
			createdFromOwnerAddress: "",
		},
		transactions: [revokeTx],
	}
	const revokeFile = `${OUTPUT_DIR}/revoke-symbol-role-safe-batch-${networkName}.json`
	fs.writeFileSync(revokeFile, JSON.stringify(revokeBatch, null, 2))
	console.log(`Revoke batch: ${revokeFile}`)

	console.log("\nExecution order:")
	console.log(`  1. Import grant-symbol-role-safe-batch-${networkName}.json into Safe → execute`)
	console.log("  2. Run: npx hardhat run scripts/upgrade/setSymbolTypes.ts --network <network>")
	console.log(`  3. Import revoke-symbol-role-safe-batch-${networkName}.json into Safe → execute`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
