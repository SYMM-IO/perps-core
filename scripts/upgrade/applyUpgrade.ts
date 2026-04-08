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

import { log } from "./utils/log.js"
import { buildDiamondCut, applyDiamondCut, loadDeployedFacets } from "./utils/upgradeHelpers.js"

const CONFIG_FILE = process.env.UPGRADE_CONFIG_FILE ?? "./scripts/upgrade/config/upgrade.json"
const OUTPUT_DIR = "./scripts/upgrade/output"

function loadConfig(): { diamondAddress?: string } {
	if (!fs.existsSync(CONFIG_FILE)) return {}
	return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"))
}

async function main() {
	const config = loadConfig()
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
	if (!DIAMOND_ADDRESS) throw new Error("DIAMOND_ADDRESS required (env or config)")

	const FACETS_FILE = process.env.FACETS_FILE ?? `${OUTPUT_DIR}/deployed-facets.json`
	const facetData = loadDeployedFacets(FACETS_FILE)

	log.header("Apply Diamond Cut")
	log.kv("Diamond", log.addr(DIAMOND_ADDRESS))
	log.kv("Facets loaded", String(Object.keys(facetData.facets).length))

	// Build diamond cut
	log.setSteps(2)
	let t = log.step("Build diamond cut")
	const { diamondCut, selectorChanges } = await buildDiamondCut(DIAMOND_ADDRESS, facetData.facets, facetData.selectorSignatures)

	const counts = { add: 0, replace: 0, remove: 0 }
	for (const c of selectorChanges) counts[c.action]++
	log.info("Selector changes:")
	log.stats([
		["Add", counts.add],
		["Replace", counts.replace],
		["Remove", counts.remove],
		["Total", selectorChanges.length],
	])

	if (diamondCut.length === 0) {
		log.ok("Nothing to cut — diamond is already up to date")
		return
	}

	// Write details
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	const detailsFile = `${OUTPUT_DIR}/upgrade-details.json`
	fs.writeFileSync(detailsFile, JSON.stringify({ diamondAddress: DIAMOND_ADDRESS, selectorChanges }, null, 2))
	log.ok(`Details written to ${detailsFile}`)
	log.stepDone(t)

	// Apply in a single transaction
	t = log.step("Apply diamond cut")
	log.info(`${diamondCut.length} cuts in 1 transaction...`)
	await applyDiamondCut(DIAMOND_ADDRESS, diamondCut, undefined, diamondCut.length)
	log.ok("Diamond cut applied")
	log.stepDone(t)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
