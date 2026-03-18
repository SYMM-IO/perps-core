import fs from "fs"
import path from "path"

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
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

	const facetsOutFile = path.join(OUTPUT_DIR, "deployed-facets.json")
	console.log("Deploying v0.8.5 facets + libraries...")
	const facetData = await deployFacets(facetsOutFile)
	console.log(`\nDeployed ${Object.keys(facetData.facets).length} facets.`)
	console.log(`Facet addresses saved to ${facetsOutFile}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
