import path from "path"

import { parseDiamondScope, updateFacet, validateAddress } from "./utils/facetUpdater.js"
import { verifyRpc } from "./utils/rpcCheck.js"

/**
 * Add or replace one facet on a core or AccountLayer diamond.
 *
 * Core:
 *   DIAMOND_ADDRESS=0x... FACET_NAME=PartyAFacet \
 *     npx hardhat run ./scripts/upgrade/updateFacet.ts --network localhost
 *
 * AccountLayer:
 *   DIAMOND_SCOPE=accountLayer DIAMOND_ADDRESS=0x... FACET_NAME=CoreFacet \
 *     npx hardhat run ./scripts/upgrade/updateFacet.ts --network localhost
 *
 * Optional:
 *   FACET_ADDRESS=0x...       # use an already linked and deployed facet
 *   UPDATE_STATE_FILE=...    # library/facet resume file
 *   UPDATE_REPORT_FILE=...   # machine-readable result
 */

async function main() {
	await verifyRpc()
	const diamondAddress = validateAddress("DIAMOND_ADDRESS", process.env.DIAMOND_ADDRESS)
	const scope = parseDiamondScope(process.env.DIAMOND_SCOPE)
	const facetName = process.env.FACET_NAME ?? "PartyAFacet"
	const facetAddress = process.env.FACET_ADDRESS
	if (facetAddress) validateAddress("FACET_ADDRESS", facetAddress)

	const outputDir = "./scripts/upgrade/output"
	const report = await updateFacet({
		diamondAddress,
		scope,
		facetName,
		facetAddress,
		stateFile: process.env.UPDATE_STATE_FILE ?? path.join(outputDir, `update-facet-${scope}.json`),
		reportFile: process.env.UPDATE_REPORT_FILE ?? path.join(outputDir, `update-facet-${scope}-report.json`),
	})

	console.log(`${report.facetName}: ${report.facetAddress}`)
	console.log(
		`Facet update complete. Added ${report.selectorsToAdd.length}, replaced ${report.selectorsToReplace.length}, removed ${report.selectorsToRemove.length}.`,
	)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
