import fs from "fs"
import path from "path"

import { log } from "./utils/log.js"
import { deployFacets } from "./utils/upgradeHelpers.js"

/**
 * Deploy v0.8.5 facets and libraries.
 *
 * Deploys all facet contracts and their library dependencies, saving
 * addresses to output/deployed-facets.json. Supports incremental
 * deployment -- if the output file already exists, previously deployed
 * contracts are skipped.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/deployFacets.ts --network arbitrum
 *   npx hardhat run scripts/upgrade/deployFacets.ts --network localhost
 */

const OUTPUT_DIR = "./scripts/upgrade/output"

async function main() {
	const t = log.timer()
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

	log.header("Deploy v0.8.5 Facets")
	const facetsOutFile = path.join(OUTPUT_DIR, "deployed-facets.json")
	const facetData = await deployFacets(facetsOutFile)

	log.success("Facet deployment complete", [
		["Facets", String(Object.keys(facetData.facets).length)],
		["Output", facetsOutFile],
		["Duration", t.fmt()],
	])
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
