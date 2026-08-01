import fs from "fs"
import path from "path"

import connection from "../../test/helpers/hardhat-connection.js"
import type { DiamondScope } from "../../utils/deploymentManifest.js"
import { log } from "./utils/log.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { loadUpgradeConfigShared } from "./utils/sharedConfig.js"
import { deployFacets } from "./utils/upgradeHelpers.js"

/**
 * Deploy a complete core or AccountLayer facet set and its libraries.
 *
 * Deploys all facet contracts and their library dependencies, saving
 * addresses to output/deployed-facets-{network}.json. Supports incremental
 * deployment -- if the output file already exists, previously deployed
 * contracts are skipped.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/deployFacets.ts --network arbitrum
 *   DIAMOND_SCOPE=accountLayer npx hardhat run scripts/upgrade/deployFacets.ts --network arbitrum
 */

const OUTPUT_DIR = "./scripts/upgrade/output"

async function main() {
	const t = log.timer()
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

	const networkName = connection.networkName
	const scope = (process.env.DIAMOND_SCOPE ?? "core") as DiamondScope
	if (scope !== "core" && scope !== "accountLayer") throw new Error(`Invalid DIAMOND_SCOPE: ${scope}`)
	await verifyRpc()
	log.header(`Deploy ${scope} facets`)
	const shared = loadUpgradeConfigShared(networkName)
	const diamondAddress =
		process.env.DIAMOND_ADDRESS ??
		(scope === "accountLayer" ? (process.env.ACCOUNT_LAYER_DIAMOND_ADDRESS ?? shared.accountLayerDiamondAddress) : shared.diamondAddress)
	if (!diamondAddress) throw new Error("DIAMOND_ADDRESS required (env or upgrade config) so deployed-facets state can be bound to a diamond.")
	const prefix = scope === "core" ? "deployed-facets" : "deployed-accountlayer-facets"
	const facetsOutFile = path.join(OUTPUT_DIR, `${prefix}-${networkName}.json`)
	const facetData = await deployFacets(facetsOutFile, scope, { networkName, diamondAddress })

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
