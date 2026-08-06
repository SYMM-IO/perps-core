/**
 * Generate a Safe multisig batch that wires an already-deployed SymmioSymbolManager
 * to the Symmio core Diamond. Produces the two grantRole transactions:
 *   1. grantRole(symbolManager, SYMBOL_MANAGER_ROLE)
 *   2. grantRole(symbolManager, FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE)
 *
 * Usage:
 *   SYMBOL_MANAGER_ADDRESS=0x... \
 *     ./node_modules/.bin/hardhat run scripts/upgrade/generateSymbolManagerSafeBatch.ts --network mantle
 *
 * Optional env overrides (otherwise taken from scripts/upgrade/config/upgrade-<network>.json):
 *   DIAMOND_ADDRESS, SAFE_ADDRESS, CHAIN_ID
 *
 * Output: scripts/upgrade/output/symbolmanager-safe-batch-<network>.json
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { buildSymbolManagerWiringTransactions } from "./utils/peripheralHelpers.js"
import { resolveConfigFile } from "./utils/sharedConfig.js"
import { toHumanReadableSafeTxFromIface, type SafeBatch } from "./utils/upgradeHelpers.js"

type Config = {
	diamondAddress?: string
	safeAddress?: string
	symbolManagerAddress?: string
}

const OUTPUT_DIR = "./scripts/upgrade/output"

function loadConfig(networkName: string): Config {
	const configFile = resolveConfigFile("upgrade", networkName, process.env.UPGRADE_CONFIG_FILE)
	if (!fs.existsSync(configFile)) return {}
	return JSON.parse(fs.readFileSync(configFile, "utf-8")) as Config
}

async function main() {
	const networkName = connection.networkName
	const config = loadConfig(networkName)

	const CHAIN_ID = process.env.CHAIN_ID ?? String(Number((await ethers.provider.getNetwork()).chainId))
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
	const SAFE_ADDRESS = process.env.SAFE_ADDRESS ?? config.safeAddress
	const SM_ADDRESS = process.env.SYMBOL_MANAGER_ADDRESS ?? config.symbolManagerAddress

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("DIAMOND_ADDRESS is required (env var or upgrade config file)")
	}
	if (!SM_ADDRESS || !ethers.isAddress(SM_ADDRESS)) {
		throw new Error("SYMBOL_MANAGER_ADDRESS is required (env var or symbolManagerAddress in upgrade config file)")
	}
	if (!SAFE_ADDRESS || !ethers.isAddress(SAFE_ADDRESS)) {
		throw new Error("SAFE_ADDRESS is required (env var or safeAddress in upgrade config file)")
	}

	const diamond = ethers.getAddress(DIAMOND_ADDRESS)
	const sm = ethers.getAddress(SM_ADDRESS)
	const safe = ethers.getAddress(SAFE_ADDRESS)

	console.log(`Network:        ${networkName}`)
	console.log(`Chain ID:       ${CHAIN_ID}`)
	console.log(`Diamond:        ${diamond}`)
	console.log(`SymbolManager:  ${sm}`)
	console.log(`Safe:           ${safe}`)
	console.log()

	const wiringTxs = buildSymbolManagerWiringTransactions(diamond, sm)
	const safeTxs = wiringTxs.map(tx => toHumanReadableSafeTxFromIface(tx.iface, tx.to, tx.methodName, tx.args))

	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

	const outFile = path.join(OUTPUT_DIR, `symbolmanager-safe-batch-${networkName}.json`)
	const batch: SafeBatch = {
		version: "1.0",
		chainId: CHAIN_ID,
		createdAt: Date.now(),
		meta: {
			name: "SymmioSymbolManager wiring (grant Diamond roles)",
			description: "Grants SYMBOL_MANAGER_ROLE and FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE on the Symmio Diamond to the deployed SymmioSymbolManager",
			txBuilderVersion: "1.18.0",
			createdFromSafeAddress: safe,
			createdFromOwnerAddress: "",
		},
		transactions: safeTxs,
	}
	fs.writeFileSync(outFile, JSON.stringify(batch, null, 2))

	console.log(`Wrote ${safeTxs.length} transactions to: ${outFile}`)
	for (let i = 0; i < wiringTxs.length; i++) {
		console.log(`  ${i + 1}. ${wiringTxs[i].description}`)
	}
	console.log()
	console.log("Import this file into the Safe Transaction Builder and execute from the Safe that holds Diamond admin.")
}

main().catch(err => {
	console.error(err)
	process.exitCode = 1
})
