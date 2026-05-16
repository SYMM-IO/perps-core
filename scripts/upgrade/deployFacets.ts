import fs from "fs"
import path from "path"

import connection from "../../test/helpers/hardhat-connection.js"
import { log } from "./utils/log.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { loadUpgradeConfigShared } from "./utils/sharedConfig.js"
import { deployFacets } from "./utils/upgradeHelpers.js"

/**
 * Deploy v0.8.5 facets and libraries.
 *
 * Deploys all facet contracts and their library dependencies, saving
 * addresses to output/deployed-facets-{network}.json. Supports incremental
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

	const networkName = connection.networkName
	await verifyRpc()
	log.header("Deploy v0.8.5 Facets")
	const shared = loadUpgradeConfigShared(networkName)
	const diamondAddress = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	if (!diamondAddress) throw new Error("DIAMOND_ADDRESS required (env or upgrade config) so deployed-facets state can be bound to a diamond.")
	const facetsOutFile = path.join(OUTPUT_DIR, `deployed-facets-${networkName}.json`)
	const facetData = await deployFacets(facetsOutFile, { networkName, diamondAddress })

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
