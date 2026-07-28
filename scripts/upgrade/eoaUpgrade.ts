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
 *   7. Deploy SymmioPartyB implementation + register
 *   8. Deploy SymmioSymbolManager and wire it
 *   9. Grant migration role
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/eoaUpgrade.ts --network localhost
 *   npx hardhat run scripts/upgrade/eoaUpgrade.ts --network arbitrum
 *
 * Config: scripts/upgrade/config/upgrade.json
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { log } from "./utils/log.js"
import {
	deployAccountLayerDiamond,
	deployInstantLayer,
	deploySymbolManager,
	wireAccountLayerInstantLayer,
	wireSymbolManager,
	setupInstantLayerTemplates,
} from "./utils/peripheralHelpers.js"
import { resolveConfigFile } from "./utils/sharedConfig.js"
import { deployFacets, buildDiamondCut, applyDiamondCut, setV085Parameters, type NewV085Parameters } from "./utils/upgradeHelpers.js"

type Config = {
	diamondAddress?: string
	protocolAdmin?: string
	adminAddress?: string
	migrationRunner?: string
	symmioFeeReceiver?: string
	setupInstantLayerTemplates?: boolean
	newV085Parameters?: NewV085Parameters
}

const OUTPUT_DIR = "./scripts/upgrade/output"

function loadConfig(): Config {
	const CONFIG_FILE = resolveConfigFile("upgrade", connection.networkName, process.env.UPGRADE_CONFIG_FILE)
	if (!fs.existsSync(CONFIG_FILE)) return {}
	return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Config
}

async function main() {
	const scriptTimer = log.timer()
	const config = loadConfig()
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
	if (!DIAMOND_ADDRESS) throw new Error("DIAMOND_ADDRESS required (env or config)")

	const MIGRATION_RUNNER = config.migrationRunner ?? config.protocolAdmin ?? config.adminAddress
	const newParams = config.newV085Parameters ?? {}

	log.header("Symmio v0.8.5 EOA Upgrade")
	log.kv("Diamond", log.addr(DIAMOND_ADDRESS))

	log.setSteps(9)

	// Step 1: Deploy facets
	let t = log.step("Deploy v0.8.5 facets")
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	const facetsOutFile = path.join(OUTPUT_DIR, `deployed-facets-${connection.networkName}.json`)
	const { facets: newFacets, selectorSignatures } = await deployFacets(facetsOutFile)
	log.ok(`${Object.keys(newFacets).length} facets ready`)
	log.stepDone(t)

	// Step 2: Build diamond cut
	t = log.step("Build diamond cut")
	const { diamondCut, selectorChanges } = await buildDiamondCut(DIAMOND_ADDRESS, newFacets, selectorSignatures)
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
	log.stepDone(t)

	// Step 3: Pause system
	t = log.step("Pause system")
	let signer
	const protocolAdminAddress = config.protocolAdmin ?? config.adminAddress
	if (protocolAdminAddress) {
		const signers = await ethers.getSigners()
		for (const s of signers) {
			if ((await s.getAddress()).toLowerCase() === protocolAdminAddress.toLowerCase()) {
				signer = s
				break
			}
		}
		if (!signer) throw new Error(`No signer found for protocolAdmin ${protocolAdminAddress}. Add TEAM_DEPLOYER to the Hardhat keystore.`)
	} else {
		signer = await ethers.provider.getSigner()
	}
	const signerAddress = await signer.getAddress()
	const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", DIAMOND_ADDRESS, signer)
	await (await controlFacet.setAdmin(signerAddress)).wait()
	log.ok("Admin set")
	await (await controlFacet.grantRole(signerAddress, ethers.id("PAUSER_ROLE"))).wait()
	log.ok("PAUSER_ROLE granted")
	await (await controlFacet.grantRole(signerAddress, ethers.id("UNPAUSER_ROLE"))).wait()
	log.ok("UNPAUSER_ROLE granted")

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
		log.ok("System paused (pauseGlobal)")
	} else {
		log.ok("System already paused")
	}
	log.stepDone(t)

	// Step 4: Apply diamond cut
	t = log.step("Apply diamond cut")
	await applyDiamondCut(DIAMOND_ADDRESS, diamondCut, signer)
	log.ok("Diamond cut applied")
	log.stepDone(t)

	// Step 5: Set v0.8.5 parameters
	t = log.step("Set v0.8.5 parameters")
	if (Object.keys(newParams).length > 0) {
		await setV085Parameters(DIAMOND_ADDRESS, newParams, signer)
	} else {
		log.info("(no parameters configured)")
	}
	log.stepDone(t)

	// Step 6: Deploy AccountLayer + InstantLayer
	t = log.step("Deploy AccountLayer + InstantLayer")
	const symmioFeeReceiver = config.symmioFeeReceiver || signerAddress
	const alilStateFile = path.join(OUTPUT_DIR, "deployed-accountlayer-instantlayer.json")

	const alResult = await deployAccountLayerDiamond(signerAddress, symmioFeeReceiver, alilStateFile)
	const ilResult = await deployInstantLayer(DIAMOND_ADDRESS, signerAddress, alilStateFile)

	await wireAccountLayerInstantLayer(DIAMOND_ADDRESS, alResult.diamondAddress, ilResult.address, signer)

	if (config.setupInstantLayerTemplates !== false) {
		await setupInstantLayerTemplates(ilResult.address, signer)
	}
	log.stepDone(t)

	// Step 7: Deploy SymmioPartyB implementation + register PartyBs on InstantLayer
	t = log.step("Deploy SymmioPartyB + register PartyBs")
	const SymmioPartyBFactory = await ethers.getContractFactory("SymmioPartyB")
	const symmioPartyBImpl = await SymmioPartyBFactory.deploy()
	await symmioPartyBImpl.waitForDeployment()
	log.deployed("Implementation", await symmioPartyBImpl.getAddress())

	// Register PartyBs on InstantLayer (from partyBList.json)
	const PARTYB_LIST_FILE = resolveConfigFile("partyBList", connection.networkName, process.env.PARTYB_LIST_FILE)
	if (fs.existsSync(PARTYB_LIST_FILE)) {
		const listConfig = JSON.parse(fs.readFileSync(PARTYB_LIST_FILE, "utf-8")) as {
			partyBs?: Record<string, string[]>
			registerOnInstantLayer?: boolean
		}
		if (listConfig.registerOnInstantLayer) {
			const partyBsToRegister = Object.values(listConfig.partyBs ?? {})
				.flat()
				.filter(a => ethers.isAddress(a))
			const il = await ethers.getContractAt("InstantLayer", ilResult.address, signer)
			for (const partyB of partyBsToRegister) {
				const isRegistered = await il.registeredPartyBs(partyB)
				if (!isRegistered) {
					await (await il.registerPartyBs([partyB])).wait()
					log.ok(`Registered ${log.addr(partyB)} on InstantLayer`)
				} else {
					log.ok(`${log.addr(partyB)} already registered on InstantLayer`)
				}
			}
		} else {
			log.ok("registerOnInstantLayer is false — skipping IL registration")
		}
	} else {
		log.warn(`${PARTYB_LIST_FILE} not found — skipping IL registration`)
	}
	log.stepDone(t)

	// Step 8: Deploy SymmioSymbolManager and wire it
	t = log.step("Deploy SymmioSymbolManager")
	const smStateFile = path.join(OUTPUT_DIR, "deployed-symbolmanager.json")
	const smResult = await deploySymbolManager(DIAMOND_ADDRESS, signerAddress, smStateFile)
	await wireSymbolManager(DIAMOND_ADDRESS, smResult.address, signer)
	log.stepDone(t)

	// Step 9: Grant migration role
	t = log.step("Grant migration role")
	if (MIGRATION_RUNNER) {
		await (await controlFacet.grantRole(MIGRATION_RUNNER, ethers.id("MIGRATION_ROLE"))).wait()
		log.ok(`MIGRATION_ROLE granted to ${log.addr(MIGRATION_RUNNER)}`)
	} else {
		log.warn("No migration runner configured — skipping")
	}
	log.stepDone(t)

	// Summary
	log.success("EOA upgrade completed successfully", [
		["Diamond", DIAMOND_ADDRESS],
		["AccountLayer", alResult.diamondAddress],
		["InstantLayer", ilResult.address],
		["SymbolManager", smResult.address],
		["Duration", scriptTimer.fmt()],
	])
	log.nextSteps([
		"Run prepareMigrationInput.ts to fetch + validate migration data",
		"Run runMigration.ts with the validated input file",
		"Unpause the system after migration is complete",
	])
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
