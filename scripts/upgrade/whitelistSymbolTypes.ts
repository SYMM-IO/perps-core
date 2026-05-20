/**
 * Whitelist a symbol type for a list of PartyBs on the Symmio diamond.
 *
 * Reads PartyB addresses from a config file and symbolType from upgrade.json,
 * then calls whitelistSymbolType() for each PartyB. Requires PARTY_B_MANAGER_ROLE
 * or the PartyB itself.
 *
 * Run:
 *   npx hardhat run scripts/upgrade/whitelistSymbolTypes.ts --network <network>
 *
 *   # Dry run (log without submitting)
 *   DRY_RUN=true npx hardhat run scripts/upgrade/whitelistSymbolTypes.ts --network <network>
 *
 * Config:
 *   scripts/upgrade/config/upgrade.json                    -- diamondAddress, symbolType
 *   scripts/upgrade/config/partyBList.json  -- partyBs list
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { resolveConfiguredSigner } from "./utils/hardwareSigner.js"
import { log } from "./utils/log.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { baseNetworkName, loadUpgradeConfigShared, resolveConfigFile } from "./utils/sharedConfig.js"
import { writeTxOverrides } from "./utils/txOverrides.js"

type WhitelistConfig = {
	partyBs: Record<string, string[]>
}

const NETWORK_SUFFIX = baseNetworkName(connection.networkName)
const CONFIG_FILE = resolveConfigFile("partyBList", NETWORK_SUFFIX, process.env.WHITELIST_CONFIG_FILE)
const OUTPUT_DIR = "./scripts/upgrade/output"

async function main() {
	const shared = loadUpgradeConfigShared(NETWORK_SUFFIX)

	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	const SYMBOL_TYPE = Number(process.env.SYMBOL_TYPE ?? shared.newV085Parameters?.symbolType ?? 1)
	const WHITELIST_SIGNER_ROLE = (process.env.WHITELIST_SIGNER_ROLE ?? "upgradeOperator").trim()
	const DRY_RUN = process.env.DRY_RUN === "true"

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("DIAMOND_ADDRESS is required (env var or upgrade.json)")
	}
	if (!fs.existsSync(CONFIG_FILE)) {
		throw new Error(`Config file not found: ${CONFIG_FILE}\nCreate it with a "partyBs" array.`)
	}

	const config: WhitelistConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"))
	const partyBs = Object.values(config.partyBs ?? {}).flat()

	if (!partyBs || partyBs.length === 0) {
		throw new Error("No partyBs defined in config file")
	}

	for (const addr of partyBs) {
		if (!ethers.isAddress(addr) || addr === ethers.ZeroAddress) {
			throw new Error(`Invalid PartyB address: ${addr}`)
		}
	}

	log.info(`Diamond:     ${DIAMOND_ADDRESS}`)
	log.info(`Symbol type: ${SYMBOL_TYPE}`)
	log.info(`Signer role: ${WHITELIST_SIGNER_ROLE}`)
	log.info(`PartyBs:     ${partyBs.length}`)
	log.info(`Dry run:     ${DRY_RUN}`)
	log.info(`Config:      ${CONFIG_FILE}`)
	log.info("")

	for (const addr of partyBs) log.info(`  ${addr}`)
	log.info("")

	if (DRY_RUN) {
		log.warn("DRY RUN — no transactions submitted")
		return
	}

	await verifyRpc()

	const signerConfig = resolveWhitelistSigner(shared, WHITELIST_SIGNER_ROLE)
	const signer = await resolveConfiguredSigner({
		role: signerConfig.role,
		expectedAddress: signerConfig.expectedAddress,
		envPrefix: signerConfig.envPrefix,
		allowDefault: !signerConfig.expectedAddress,
	})
	log.info(`Signer: ${await signer.getAddress()}`)

	const diamond = await ethers.getContractAt(["function whitelistSymbolType(address partyB, uint256 symbolType)"], DIAMOND_ADDRESS, signer)

	let success = 0
	for (const partyB of partyBs) {
		log.info(`Whitelisting symbolType=${SYMBOL_TYPE} for ${partyB}...`)
		const tx = await diamond.whitelistSymbolType(partyB, BigInt(SYMBOL_TYPE), writeTxOverrides())
		const receipt = await tx.wait()
		log.ok(`  tx: ${receipt.hash} (gas: ${receipt.gasUsed})`)
		success++
	}

	log.ok(`\nWhitelisted symbolType=${SYMBOL_TYPE} for ${success}/${partyBs.length} PartyBs`)

	// Write report
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	const reportFile = path.join(
		OUTPUT_DIR,
		NETWORK_SUFFIX ? `whitelist-symbol-types-report-${NETWORK_SUFFIX}.json` : "whitelist-symbol-types-report.json",
	)
	fs.writeFileSync(
		reportFile,
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				diamondAddress: DIAMOND_ADDRESS,
				symbolType: SYMBOL_TYPE,
				partyBs,
				success,
			},
			null,
			2,
		),
	)
	log.ok(`Report: ${reportFile}`)
}

function resolveWhitelistSigner(shared: ReturnType<typeof loadUpgradeConfigShared>, rawRole: string) {
	const normalized = rawRole.toLowerCase()
	if (["upgradeoperator", "upgrade-operator", "operator", "partybmanager", "party-b-manager"].includes(normalized)) {
		return {
			role: "upgradeOperator",
			expectedAddress: shared.upgradeOperator,
			envPrefix: "UPGRADE_OPERATOR",
		}
	}
	if (["migrationrunner", "migration-runner", "migrator"].includes(normalized)) {
		return {
			role: "migrationRunner",
			expectedAddress: shared.migrationRunner,
			envPrefix: "MIGRATION_RUNNER",
		}
	}
	if (["default", "deployer"].includes(normalized)) {
		return {
			role: "default",
			expectedAddress: undefined,
			envPrefix: undefined,
		}
	}
	throw new Error(`Invalid WHITELIST_SIGNER_ROLE: ${rawRole}. Use upgradeOperator, migrationRunner, or default.`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
