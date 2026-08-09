import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { requireExecutionConfirmation } from "./utils/executionGuard.js"
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
 * Plan (default):
 *   ./node_modules/.bin/hardhat run scripts/upgrade/deployFacets.ts --network arbitrum
 * Execute:
 *   EXECUTE=true CONFIRM_CHAIN_ID=42161 ./node_modules/.bin/hardhat run scripts/upgrade/deployFacets.ts --network arbitrum
 */

const OUTPUT_DIR = "./scripts/upgrade/output"

async function main() {
	const t = log.timer()
	const networkName = connection.networkName
	await verifyRpc()
	const chainId = (await ethers.provider.getNetwork()).chainId
	const execute = requireExecutionConfirmation(chainId)
	log.header("Deploy v0.8.5 Facets")
	const shared = loadUpgradeConfigShared(networkName)
	const diamondAddress = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	if (!diamondAddress || !ethers.isAddress(diamondAddress) || diamondAddress === ethers.ZeroAddress) {
		throw new Error("DIAMOND_ADDRESS required and must be non-zero (env or upgrade config) so deployed-facets state can be bound to a diamond.")
	}
	const facetsOutFile = path.join(OUTPUT_DIR, `deployed-facets-${networkName}.json`)
	log.kv("Network", `${networkName} (${chainId})`)
	log.kv("Diamond", log.addr(diamondAddress))
	log.kv("Output", facetsOutFile)
	log.kv("Mode", execute ? "EXECUTE" : "PLAN ONLY")
	if (!execute) {
		log.warn(`Plan only: no contracts were deployed. Rerun with EXECUTE=true CONFIRM_CHAIN_ID=${chainId}.`)
		return
	}
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
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
