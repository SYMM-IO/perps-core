/**
 * Apply diamond cut directly from deployed-facets.json.
 *
 * Reads pre-deployed facet addresses, diffs against the live diamond,
 * and executes a single diamondCut transaction from the connected signer.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/applyUpgrade.ts --network arbitrum
 *
 * Env overrides:
 *   DIAMOND_ADDRESS   -- override config diamondAddress
 *   FACETS_FILE       -- override default deployed-facets.json path
 */

import fs from "fs"

import { buildDiamondCut, applyDiamondCut, loadDeployedFacets } from "./utils/upgradeHelpers.js"

const CONFIG_FILE = process.env.UPGRADE_CONFIG_FILE ?? "./scripts/upgrade/config/upgrade.json"
const OUTPUT_DIR = "./scripts/upgrade/output"

function loadConfig(): { diamondAddress?: string } {
	if (!fs.existsSync(CONFIG_FILE)) return {}
	return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"))
}

async function main() {
	const { ethers } = await import("../../test/helpers/hardhat-connection.js")

	const config = loadConfig()
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
	if (!DIAMOND_ADDRESS) throw new Error("DIAMOND_ADDRESS required (env or config)")

	const FACETS_FILE = process.env.FACETS_FILE ?? `${OUTPUT_DIR}/deployed-facets.json`
	const facetData = loadDeployedFacets(FACETS_FILE)

	console.log(`Diamond: ${DIAMOND_ADDRESS}`)
	console.log(`Facets:  ${Object.keys(facetData.facets).length}`)
	console.log()

	// Build diamond cut
	console.log("Building diamond cut...")
	const { diamondCut, selectorChanges } = await buildDiamondCut(DIAMOND_ADDRESS, facetData.facets, facetData.selectorSignatures)

	const counts = { add: 0, replace: 0, remove: 0 }
	for (const c of selectorChanges) counts[c.action]++
	console.log(`Selector changes: ${selectorChanges.length} (add=${counts.add}, replace=${counts.replace}, remove=${counts.remove})`)

	if (diamondCut.length === 0) {
		console.log("Nothing to cut — diamond is already up to date.")
		return
	}

	// Write details for review
	const detailsFile = `${OUTPUT_DIR}/upgrade-details.json`
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	fs.writeFileSync(detailsFile, JSON.stringify({ diamondAddress: DIAMOND_ADDRESS, selectorChanges }, null, 2))
	console.log(`Details written to ${detailsFile}`)

	// Apply in a single transaction (all cuts in one chunk)
	console.log(`\nApplying diamond cut (${diamondCut.length} cuts in 1 transaction)...`)
	await applyDiamondCut(DIAMOND_ADDRESS, diamondCut, undefined, diamondCut.length)
	console.log("Diamond cut applied successfully.")
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
