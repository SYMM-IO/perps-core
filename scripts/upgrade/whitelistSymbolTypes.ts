/**
 * Whitelist a symbol type for a list of PartyBs on the Symmio diamond.
 *
 * Reads PartyB addresses from a config file and symbolType from upgrade.json,
 * then calls whitelistSymbolType() for each PartyB. Requires PARTY_B_MANAGER_ROLE
 * or the PartyB itself.
 *
 * Plan (default):
 *   ./node_modules/.bin/hardhat run scripts/upgrade/whitelistSymbolTypes.ts --network <network>
 *
 * Execute only after reviewing the plan:
 *   EXECUTE=true CONFIRM_CHAIN_ID=<chainId> ./node_modules/.bin/hardhat run scripts/upgrade/whitelistSymbolTypes.ts --network <network>
 *
 * Config:
 *   scripts/upgrade/config/upgrade.json                    -- diamondAddress, symbolType
 *   scripts/upgrade/config/partyBList.json  -- partyBs list
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { exactBooleanEnv, requireExecutionConfirmation } from "./utils/executionGuard.js"
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
const PARTY_B_MANAGER_ROLE = ethers.id("PARTY_B_MANAGER_ROLE")

type RoleCheck = {
	address: string
	roleHash: string
	hasRole: boolean
}

async function hasPartyBManagerRole(diamondAddress: string, account: string): Promise<boolean> {
	const viewFacet = await ethers.getContractAt(["function hasRole(address user, bytes32 role) view returns (bool)"], diamondAddress)
	return viewFacet.hasRole(account, PARTY_B_MANAGER_ROLE)
}

async function checkPartyBManagerRole(diamondAddress: string, account: string, required: boolean): Promise<RoleCheck> {
	const normalized = ethers.getAddress(account)
	const hasRole = await hasPartyBManagerRole(diamondAddress, normalized)
	log.kv("PARTY_B_MANAGER_ROLE", hasRole ? `yes (${log.addr(normalized)})` : `no (${log.addr(normalized)})`)
	if (!hasRole) {
		const message =
			`${normalized} does not have PARTY_B_MANAGER_ROLE on ${diamondAddress}. ` +
			"Execute the Safe role-grant batch before whitelisting symbol types."
		if (required) {
			throw new Error(`${message} Set SKIP_PARTY_B_MANAGER_ROLE_CHECK=true only if you are intentionally bypassing this preflight.`)
		}
		log.warn(`${message} Dry run will continue because no transactions are submitted.`)
	}
	return { address: normalized, roleHash: PARTY_B_MANAGER_ROLE, hasRole }
}

function roleCheckSummary(roleCheck: RoleCheck | undefined, skipped: boolean): string | undefined {
	if (roleCheck) return `${roleCheck.hasRole ? "yes" : "no"} (${log.addr(roleCheck.address)})`
	if (skipped) return "skipped"
	return undefined
}

function logRunSummary(
	title: string,
	diamondAddress: string,
	roleCheck: RoleCheck | undefined,
	roleCheckSkipped: boolean,
	partyBsCount: number,
	success: number,
	dryRun: boolean,
	reportFile: string,
): void {
	const summary: Array<[string, string]> = [["Diamond", diamondAddress]]
	const roleSummary = roleCheckSummary(roleCheck, roleCheckSkipped)
	if (roleSummary) summary.push(["PARTY_B_MANAGER_ROLE", roleSummary])
	summary.push(["PartyBs", String(partyBsCount)], ["Whitelisted", String(success)], ["Dry run", String(dryRun)], ["Report", reportFile])
	log.success(title, summary)
}

async function main() {
	const shared = loadUpgradeConfigShared(NETWORK_SUFFIX)

	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	const SYMBOL_TYPE = Number(process.env.SYMBOL_TYPE ?? shared.newV085Parameters?.symbolType ?? 1)
	const WHITELIST_SIGNER_ROLE = (process.env.WHITELIST_SIGNER_ROLE ?? "upgradeOperator").trim()
	const SKIP_PARTY_B_MANAGER_ROLE_CHECK = exactBooleanEnv("SKIP_PARTY_B_MANAGER_ROLE_CHECK")

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("DIAMOND_ADDRESS is required (env var or upgrade.json)")
	}
	if (!Number.isSafeInteger(SYMBOL_TYPE) || SYMBOL_TYPE < 0)
		throw new Error(`SYMBOL_TYPE must be a non-negative safe integer; received ${SYMBOL_TYPE}`)
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

	await verifyRpc()
	const chainId = (await ethers.provider.getNetwork()).chainId
	const EXECUTE = requireExecutionConfirmation(chainId)
	const DRY_RUN = !EXECUTE

	const signerConfig = resolveWhitelistSigner(shared, WHITELIST_SIGNER_ROLE)
	let signer: Awaited<ReturnType<typeof resolveConfiguredSigner>> | undefined
	let signerAddress: string
	if (DRY_RUN && signerConfig.expectedAddress && ethers.isAddress(signerConfig.expectedAddress)) {
		signerAddress = ethers.getAddress(signerConfig.expectedAddress)
		log.info(`Signer: ${signerAddress} (configured ${signerConfig.role}; dry run uses no signer)`)
	} else {
		signer = await resolveConfiguredSigner({
			role: signerConfig.role,
			expectedAddress: signerConfig.expectedAddress,
			envPrefix: signerConfig.envPrefix,
			allowDefault: !signerConfig.expectedAddress,
		})
		signerAddress = await signer.getAddress()
		log.info(`Signer: ${signerAddress}`)
	}

	let roleCheck: RoleCheck | undefined
	if (SKIP_PARTY_B_MANAGER_ROLE_CHECK) {
		log.warn("Skipping PARTY_B_MANAGER_ROLE preflight because SKIP_PARTY_B_MANAGER_ROLE_CHECK=true")
	} else {
		roleCheck = await checkPartyBManagerRole(DIAMOND_ADDRESS, signerAddress, !DRY_RUN)
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
		const reportFile = writeReport(DIAMOND_ADDRESS, SYMBOL_TYPE, partyBs, 0, true, roleCheck)
		logRunSummary(
			"Whitelist symbolType dry run completed successfully",
			DIAMOND_ADDRESS,
			roleCheck,
			SKIP_PARTY_B_MANAGER_ROLE_CHECK,
			partyBs.length,
			0,
			true,
			reportFile,
		)
		return
	}

	if (!signer) throw new Error("Signer was not resolved for live whitelist execution")

	const diamond = await ethers.getContractAt(["function whitelistSymbolType(address partyB, uint256 symbolType)"], DIAMOND_ADDRESS, signer)
	const symbolView = await ethers.getContractAt(
		["function isWhitelistedSymbolType(address partyB, uint256 symbolType) view returns (bool)"],
		DIAMOND_ADDRESS,
	)

	let success = 0
	for (const partyB of partyBs) {
		log.info(`Whitelisting symbolType=${SYMBOL_TYPE} for ${partyB}...`)
		await diamond.whitelistSymbolType.staticCall(partyB, BigInt(SYMBOL_TYPE), writeTxOverrides())
		const tx = await diamond.whitelistSymbolType(partyB, BigInt(SYMBOL_TYPE), writeTxOverrides())
		log.info(`  submitted: ${tx.hash} (nonce: ${tx.nonce})`)
		const receipt = await tx.wait()
		if (!receipt?.status) throw new Error(`whitelistSymbolType transaction failed: ${tx.hash}`)
		if (!(await symbolView.isWhitelistedSymbolType(partyB, BigInt(SYMBOL_TYPE)))) {
			throw new Error(`Whitelist post-state mismatch for PartyB ${partyB}, symbolType ${SYMBOL_TYPE}`)
		}
		log.ok(`  tx: ${receipt.hash} (gas: ${receipt.gasUsed})`)
		success++
	}

	log.ok(`\nWhitelisted symbolType=${SYMBOL_TYPE} for ${success}/${partyBs.length} PartyBs`)
	const reportFile = writeReport(DIAMOND_ADDRESS, SYMBOL_TYPE, partyBs, success, false, roleCheck)
	logRunSummary(
		"Symbol type whitelist updated successfully",
		DIAMOND_ADDRESS,
		roleCheck,
		SKIP_PARTY_B_MANAGER_ROLE_CHECK,
		partyBs.length,
		success,
		false,
		reportFile,
	)
}

function writeReport(diamondAddress: string, symbolType: number, partyBs: string[], success: number, dryRun: boolean, roleCheck?: RoleCheck): string {
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
				diamondAddress,
				symbolType,
				dryRun,
				roleChecks: roleCheck
					? {
							partyBManagerRole: roleCheck,
						}
					: undefined,
				partyBs,
				success,
			},
			null,
			2,
		),
	)
	log.ok(`Report: ${reportFile}`)
	return reportFile
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
