/**
 * Verify the on-chain diamond state matches deployed-facets.json.
 *
 * Reads the live diamond selectors and compares against the expected
 * post-upgrade state. Run after applying the diamond cut to confirm
 * everything landed correctly.
 *
 * This is a localhost testing tool — run it after eoaUpgrade.ts (or
 * deployFacets.ts + applyUpgrade.ts) on a local Hardhat node to
 * validate the upgrade before production. Not used in the production
 * upgrade flow.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/verifyUpgrade.ts --network localhost
 *
 * Env overrides:
 *   DIAMOND_ADDRESS   -- override config diamondAddress
 *   FACETS_FILE       -- override default deployed-facets.json path
 */
import fs from "fs"

import { verifyAgainstArtifacts } from "./utils/verifyUpgrade.js"

const CONFIG_FILE = process.env.UPGRADE_CONFIG_FILE ?? "./scripts/upgrade/config/upgrade.json"

function loadConfig(): { diamondAddress?: string } {
	if (!fs.existsSync(CONFIG_FILE)) return {}
	return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"))
}

async function main() {
	const config = loadConfig()
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
	if (!DIAMOND_ADDRESS) throw new Error("DIAMOND_ADDRESS required (env or config)")

	console.log(`Diamond: ${DIAMOND_ADDRESS}\n`)

	console.log("Verifying on-chain diamond against compiled artifacts...")
	await verifyAgainstArtifacts(DIAMOND_ADDRESS)

	console.log("\nVerification complete.")
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
