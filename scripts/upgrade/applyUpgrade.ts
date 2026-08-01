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
 *   DIAMOND_SCOPE     -- core (default) or accountLayer
 *   FACETS_FILE       -- override default deployed-facets.json path
 */
import fs from "fs"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import type { DiamondScope } from "../../utils/deploymentManifest.js"
import { resolveConfiguredSigner } from "./utils/hardwareSigner.js"
import { log } from "./utils/log.js"
import { loadUpgradeConfigShared } from "./utils/sharedConfig.js"
import { buildDiamondCut, applyDiamondCut, loadDeployedFacets } from "./utils/upgradeHelpers.js"

const OUTPUT_DIR = "./scripts/upgrade/output"

async function main() {
	const shared = loadUpgradeConfigShared(connection.networkName)
	const scope = (process.env.DIAMOND_SCOPE ?? "core") as DiamondScope
	if (scope !== "core" && scope !== "accountLayer") throw new Error(`Invalid DIAMOND_SCOPE: ${scope}`)
	const DIAMOND_ADDRESS =
		process.env.DIAMOND_ADDRESS ??
		(scope === "accountLayer" ? (process.env.ACCOUNT_LAYER_DIAMOND_ADDRESS ?? shared.accountLayerDiamondAddress) : shared.diamondAddress)
	if (!DIAMOND_ADDRESS) throw new Error("DIAMOND_ADDRESS required (env or config)")

	const networkName = connection.networkName
	const chainId = Number((await ethers.provider.getNetwork()).chainId)
	const prefix = scope === "core" ? "deployed-facets" : "deployed-accountlayer-facets"
	const FACETS_FILE = process.env.FACETS_FILE ?? `${OUTPUT_DIR}/${prefix}-${networkName}.json`
	const facetData = loadDeployedFacets(FACETS_FILE, { networkName, chainId, diamondAddress: DIAMOND_ADDRESS })

	log.header(`Apply ${scope} diamond cut`)
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
	const detailsFile = `${OUTPUT_DIR}/${scope}-upgrade-details-${networkName}.json`
	fs.writeFileSync(detailsFile, JSON.stringify({ scope, diamondAddress: DIAMOND_ADDRESS, selectorChanges }, null, 2))
	log.ok(`Details written to ${detailsFile}`)
	log.stepDone(t)

	// Resolve protocolAdmin signer. Supports Hardhat-managed keys, external wallet
	// RPCs, and Ledger path scanning.
	let signer
	const protocolAdminAddress = shared.protocolAdmin
	if (protocolAdminAddress) {
		signer = await resolveConfiguredSigner({
			role: "protocolAdmin",
			expectedAddress: protocolAdminAddress,
			envPrefix: "PROTOCOL_ADMIN",
		})
	}

	// Apply in a single transaction
	t = log.step("Apply diamond cut")
	log.info(`${diamondCut.length} cuts in 1 transaction...`)
	await applyDiamondCut(DIAMOND_ADDRESS, diamondCut, signer, diamondCut.length)
	log.ok("Diamond cut applied")
	log.stepDone(t)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
