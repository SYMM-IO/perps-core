/**
 * EOA Upgrade Script — deploy facets, apply diamond cut, set parameters.
 *
 * Runs the full v0.8.4 -> v0.8.5 upgrade from the connected EOA signer.
 * Migration is a separate step — run prepareMigrationInput.ts then
 * runMigration.ts after this completes.
 *
 * Steps:
 *   1. Deploy v0.8.5 facets + libraries
 *   2. Build diamond cut (diff current vs new)
 *   3. Pause system
 *   4. Apply diamond cut
 *   5. Set new v0.8.5 parameters
 *   6. Deploy AccountLayer + InstantLayer and wire them
 *   7. Grant migration role
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/eoaUpgrade.ts --network localhost
 *   npx hardhat run scripts/upgrade/eoaUpgrade.ts --network arbitrum
 *
 * Config: scripts/upgrade/config/upgrade.json
 */
import fs from "fs"
import path from "path"

import { ethers } from "../../test/helpers/hardhat-connection.js"
import {
	deployAccountLayerDiamond,
	deployInstantLayer,
	wireAccountLayerInstantLayer,
	setupInstantLayerTemplates,
} from "./utils/deployAccountLayerInstantLayer.js"
import { deployFacets, buildDiamondCut, applyDiamondCut, setV085Parameters, type NewV085Parameters } from "./utils/upgradeHelpers.js"

type Config = {
	diamondAddress?: string
	adminAddress?: string
	migrationRunner?: string
	symmioFeeReceiver?: string
	setupInstantLayerTemplates?: boolean
	newV085Parameters?: NewV085Parameters
}

const CONFIG_FILE = process.env.UPGRADE_CONFIG_FILE ?? "./scripts/upgrade/config/upgrade.json"
const OUTPUT_DIR = "./scripts/upgrade/output"

function loadConfig(): Config {
	if (!fs.existsSync(CONFIG_FILE)) return {}
	return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Config
}

async function main() {
	const config = loadConfig()
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
	if (!DIAMOND_ADDRESS) throw new Error("DIAMOND_ADDRESS required (env or config)")

	const MIGRATION_RUNNER = config.migrationRunner ?? config.adminAddress
	const newParams = config.newV085Parameters ?? {}

	console.log(`Diamond: ${DIAMOND_ADDRESS}`)
	console.log()

	// Step 1: Deploy facets
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	const facetsOutFile = path.join(OUTPUT_DIR, "deployed-facets.json")

	console.log("=== Step 1: Deploy v0.8.5 facets ===")
	const { facets: newFacets, selectorSignatures } = await deployFacets(facetsOutFile)
	console.log(`Deployed ${Object.keys(newFacets).length} facets.\n`)

	// Step 2: Build diamond cut
	console.log("=== Step 2: Build diamond cut ===")
	const { diamondCut, selectorChanges } = await buildDiamondCut(DIAMOND_ADDRESS, newFacets, selectorSignatures)
	const counts = { add: 0, replace: 0, remove: 0 }
	for (const c of selectorChanges) counts[c.action]++
	console.log(`Selector changes: ${selectorChanges.length} (add=${counts.add}, replace=${counts.replace}, remove=${counts.remove})`)

	if (diamondCut.length === 0) {
		console.log("Nothing to cut -- diamond is already up to date.")
		return
	}
	console.log()

	// Step 3: Pause system
	console.log("=== Step 3: Pause system ===")
	const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", DIAMOND_ADDRESS)
	const signer = await ethers.provider.getSigner()
	const signerAddress = await signer.getAddress()
	await (await controlFacet.setAdmin(signerAddress)).wait()
	await (await controlFacet.grantRole(signerAddress, ethers.id("PAUSER_ROLE"))).wait()
	await (await controlFacet.grantRole(signerAddress, ethers.id("UNPAUSER_ROLE"))).wait()

	// Use minimal ABI for pauseState/pauseGlobal to stay compatible with
	// both v0.8.4 (7 return bools) and v0.8.5 (8 return bools) diamonds.
	const pauseHelper = new ethers.Contract(
		DIAMOND_ADDRESS,
		["function pauseState() view returns (bool globalPaused, bool, bool, bool, bool, bool, bool)", "function pauseGlobal() external"],
		signer,
	)
	const pauseResult = await pauseHelper.pauseState()
	if (!pauseResult.globalPaused) {
		await (await pauseHelper.pauseGlobal()).wait()
		console.log("System paused.\n")
	} else {
		console.log("System already paused.\n")
	}

	// Step 4: Apply diamond cut
	console.log("=== Step 4: Apply diamond cut ===")
	await applyDiamondCut(DIAMOND_ADDRESS, diamondCut)
	console.log("Diamond cut applied.\n")

	// Step 5: Set v0.8.5 parameters
	console.log("=== Step 5: Set v0.8.5 parameters ===")
	if (Object.keys(newParams).length > 0) {
		await setV085Parameters(DIAMOND_ADDRESS, newParams)
	} else {
		console.log("  (no parameters configured)")
	}
	console.log()

	// Step 6: Deploy AccountLayer + InstantLayer
	console.log("=== Step 6: Deploy AccountLayer + InstantLayer ===")
	const symmioFeeReceiver = config.symmioFeeReceiver || signerAddress
	const alilStateFile = path.join(OUTPUT_DIR, "deployed-accountlayer-instantlayer.json")

	const alResult = await deployAccountLayerDiamond(signerAddress, symmioFeeReceiver, alilStateFile)
	const ilResult = await deployInstantLayer(DIAMOND_ADDRESS, signerAddress, alilStateFile)

	console.log("\nWiring contracts together...")
	await wireAccountLayerInstantLayer(DIAMOND_ADDRESS, alResult.diamondAddress, ilResult.address, signer)

	if (config.setupInstantLayerTemplates !== false) {
		await setupInstantLayerTemplates(ilResult.address, signer)
	}
	console.log(`AccountLayer Diamond: ${alResult.diamondAddress}`)
	console.log(`InstantLayer: ${ilResult.address}\n`)

	// Step 7: Grant migration role
	console.log("=== Step 7: Grant migration role ===")
	if (MIGRATION_RUNNER) {
		await (await controlFacet.grantRole(MIGRATION_RUNNER, ethers.id("MIGRATION_ROLE"))).wait()
		console.log(`Migration role granted to ${MIGRATION_RUNNER}`)
	} else {
		console.log("No migration runner configured, skipping.")
	}

	console.log("\n=== Upgrade complete ===")
	console.log("System remains paused. Next steps:")
	console.log("  1. Run prepareMigrationInput.ts to fetch + validate migration data")
	console.log("  2. Run runMigration.ts with the validated input file")
	console.log("  3. Unpause the system after migration is complete")
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
