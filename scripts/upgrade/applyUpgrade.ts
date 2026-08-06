/**
 * Apply diamond cut directly from deployed-facets.json.
 *
 * Reads pre-deployed facet addresses, diffs against the live diamond,
 * and executes a single diamondCut transaction from the connected signer.
 *
 * Usage:
 *   ./node_modules/.bin/hardhat run scripts/upgrade/applyUpgrade.ts --network arbitrum
 *   EXECUTE=true CONFIRM_CHAIN_ID=42161 ./node_modules/.bin/hardhat run scripts/upgrade/applyUpgrade.ts --network arbitrum
 *
 * Env overrides:
 *   DIAMOND_ADDRESS   -- override config diamondAddress
 *   FACETS_FILE       -- override default deployed-facets.json path
 */
import fs from "fs"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { requireExecutionConfirmation } from "./utils/executionGuard.js"
import { resolveConfiguredSigner } from "./utils/hardwareSigner.js"
import { log } from "./utils/log.js"
import { DIAMOND_OWNER_ABI, readDiamondOwner } from "./utils/ownership.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { loadUpgradeConfigShared } from "./utils/sharedConfig.js"
import { buildDiamondCut, applyDiamondCut, loadDeployedFacets } from "./utils/upgradeHelpers.js"

const OUTPUT_DIR = "./scripts/upgrade/output"

function writeJsonAtomic(filePath: string, value: unknown): void {
	const temporaryPath = `${filePath}.${process.pid}.tmp`
	fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2))
	fs.renameSync(temporaryPath, filePath)
}

async function main() {
	await verifyRpc()
	const shared = loadUpgradeConfigShared(connection.networkName)
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS) || DIAMOND_ADDRESS === ethers.ZeroAddress) {
		throw new Error(`DIAMOND_ADDRESS required and must be non-zero (received ${DIAMOND_ADDRESS ?? "missing"})`)
	}
	if ((await ethers.provider.getCode(DIAMOND_ADDRESS)) === "0x") throw new Error(`No Diamond code at ${DIAMOND_ADDRESS}`)

	const networkName = connection.networkName
	const connectedChainId = (await ethers.provider.getNetwork()).chainId
	const chainId = Number(connectedChainId)
	const execute = requireExecutionConfirmation(connectedChainId)
	const FACETS_FILE = process.env.FACETS_FILE ?? `${OUTPUT_DIR}/deployed-facets-${networkName}.json`
	const facetData = loadDeployedFacets(FACETS_FILE, { networkName, chainId, diamondAddress: DIAMOND_ADDRESS })

	log.header("Apply Diamond Cut")
	log.kv("Diamond", log.addr(DIAMOND_ADDRESS))
	log.kv("Facets loaded", String(Object.keys(facetData.facets).length))
	log.kv("Mode", execute ? "EXECUTE" : "PLAN ONLY")

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
	const detailsFile = `${OUTPUT_DIR}/upgrade-details-${networkName}.json`
	writeJsonAtomic(detailsFile, { diamondAddress: DIAMOND_ADDRESS, chainId, selectorChanges })
	log.ok(`Details written to ${detailsFile}`)
	log.stepDone(t)
	if (!execute) {
		log.warn(`Plan only: no transaction was sent. Review the details file, then rerun with EXECUTE=true CONFIRM_CHAIN_ID=${chainId}.`)
		return
	}

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
	} else {
		signer = await ethers.provider.getSigner()
	}
	const signerAddress = ethers.getAddress(await signer.getAddress())
	const ownership = new ethers.Contract(DIAMOND_ADDRESS, DIAMOND_OWNER_ABI, ethers.provider)
	const owner = await readDiamondOwner(ownership)
	if (!owner) throw new Error(`Could not read diamond owner at ${DIAMOND_ADDRESS}`)
	if (owner !== signerAddress) throw new Error(`Diamond owner is ${owner}, but the selected signer is ${signerAddress}`)

	// Apply in a single transaction
	t = log.step("Apply diamond cut")
	log.info(`${diamondCut.length} cuts in 1 transaction...`)
	await applyDiamondCut(DIAMOND_ADDRESS, diamondCut, signer, diamondCut.length)
	const residual = await buildDiamondCut(DIAMOND_ADDRESS, facetData.facets, facetData.selectorSignatures)
	if (residual.diamondCut.length > 0)
		throw new Error(`Diamond cut post-verification found ${residual.selectorChanges.length} residual selector changes`)
	log.ok("Diamond cut applied")
	log.stepDone(t)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
