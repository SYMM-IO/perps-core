/**
 * Grant Symmio core roles from a network-specific JSON config.
 *
 * The script uses the core diamond's custom argument order:
 *   grantRole(address user, bytes32 role)
 *
 * Config resolution:
 *   GRANT_ROLES_CONFIG_FILE (when set)
 *   scripts/upgrade/config/grantRoles-<network>.json
 *   scripts/upgrade/config/grantRoles.json
 *
 * Dry run is the default. Set DRY_RUN=false and USE_KEYSTORE=true to submit.
 *
 * Usage:
 *   USE_KEYSTORE=false npx hardhat run scripts/upgrade/grantRoles.ts --network hyperevm
 *   USE_KEYSTORE=true KEYSTORE_DEPLOYER_KEY=NEW_DEPLOYER npx hardhat run scripts/upgrade/grantRoles.ts --network hyperevm
 *   USE_KEYSTORE=true KEYSTORE_DEPLOYER_KEY=NEW_DEPLOYER DRY_RUN=false npx hardhat run scripts/upgrade/grantRoles.ts --network hyperevm
 */
import fs from "node:fs"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { log } from "./utils/log.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { resolveConfigFile } from "./utils/sharedConfig.js"

type GrantConfigEntry = {
	account: string
	roles: string[]
}

type GrantRolesConfig = {
	chainId: number
	diamondAddress: string
	grants: GrantConfigEntry[]
}

type PlannedGrant = {
	account: string
	role: string
	roleHash: string
	alreadyGranted: boolean
	signerIsAdmin: boolean
	calldata: string
}

const CORE_ROLE_ABI = [
	"function owner() view returns (address)",
	"function hasRole(address user, bytes32 role) view returns (bool)",
	"function isRoleAdmin(address user, bytes32 role) view returns (bool)",
	"function grantRole(address user, bytes32 role)",
]

function loadConfig(file: string): GrantRolesConfig {
	if (!fs.existsSync(file)) {
		throw new Error(`Role grant config not found: ${file}`)
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf-8"))
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`Invalid JSON in ${file}: ${message}`)
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Role grant config must be a JSON object")
	}

	const config = parsed as Partial<GrantRolesConfig>
	if (!Number.isSafeInteger(config.chainId) || Number(config.chainId) <= 0) {
		throw new Error("Config chainId must be a positive integer")
	}
	if (!config.diamondAddress || !ethers.isAddress(config.diamondAddress) || config.diamondAddress === ethers.ZeroAddress) {
		throw new Error(`Invalid diamondAddress: ${config.diamondAddress ?? "<missing>"}`)
	}
	if (!Array.isArray(config.grants) || config.grants.length === 0) {
		throw new Error("Config grants must contain at least one entry")
	}

	const grants = config.grants.map((entry, entryIndex) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`grants[${entryIndex}] must be an object`)
		}
		if (!ethers.isAddress(entry.account) || entry.account === ethers.ZeroAddress) {
			throw new Error(`Invalid grants[${entryIndex}].account: ${entry.account ?? "<missing>"}`)
		}
		if (!Array.isArray(entry.roles) || entry.roles.length === 0) {
			throw new Error(`grants[${entryIndex}].roles must contain at least one role`)
		}
		for (const [roleIndex, role] of entry.roles.entries()) {
			if (typeof role !== "string" || role.trim().length === 0) {
				throw new Error(`grants[${entryIndex}].roles[${roleIndex}] must be a non-empty string`)
			}
		}
		return {
			account: ethers.getAddress(entry.account),
			roles: entry.roles.map(role => role.trim()),
		}
	})

	return {
		chainId: Number(config.chainId),
		diamondAddress: ethers.getAddress(config.diamondAddress),
		grants,
	}
}

function resolveRoleHash(role: string): string {
	if (role.startsWith("0x")) {
		if (!ethers.isHexString(role, 32)) {
			throw new Error(`Role hash must be exactly 32 bytes: ${role}`)
		}
		return role.toLowerCase()
	}
	return ethers.id(role)
}

function expandGrants(config: GrantRolesConfig): Array<{ account: string; role: string; roleHash: string }> {
	const expanded: Array<{ account: string; role: string; roleHash: string }> = []
	const seen = new Set<string>()

	for (const grant of config.grants) {
		for (const role of grant.roles) {
			const roleHash = resolveRoleHash(role)
			const key = `${grant.account.toLowerCase()}:${roleHash}`
			if (seen.has(key)) {
				throw new Error(`Duplicate role grant for ${grant.account}: ${role}`)
			}
			seen.add(key)
			expanded.push({ account: grant.account, role, roleHash })
		}
	}

	return expanded
}

async function main() {
	const networkName = connection.networkName
	const configFile = resolveConfigFile("grantRoles", networkName, process.env.GRANT_ROLES_CONFIG_FILE)
	const dryRun = process.env.DRY_RUN !== "false"
	const config = loadConfig(configFile)
	const grants = expandGrants(config)

	log.header("Symmio Core Role Grants")
	log.setSteps(3)

	const rpcTimer = log.step("Verify RPC and configuration")
	await verifyRpc(config.chainId)

	const code = await ethers.provider.getCode(config.diamondAddress)
	if (code === "0x") {
		throw new Error(`No contract deployed at diamondAddress ${config.diamondAddress}`)
	}

	const [signer] = await ethers.getSigners()
	if (!signer) {
		throw new Error("No signer configured")
	}
	const signerAddress = await signer.getAddress()
	const diamond = await ethers.getContractAt(CORE_ROLE_ABI, config.diamondAddress, signer)
	const owner = await diamond.owner()

	log.info(`Network:  ${networkName} (${config.chainId})`)
	log.info(`Config:   ${configFile}`)
	log.info(`Diamond:  ${config.diamondAddress}`)
	log.info(`Owner:    ${owner}`)
	log.info(`Signer:   ${signerAddress}`)
	log.info(`Dry run:  ${dryRun}`)
	log.stepDone(rpcTimer)

	const preflightTimer = log.step("Inspect grants and permissions")
	const planned: PlannedGrant[] = []

	for (const grant of grants) {
		const alreadyGranted = await diamond.hasRole(grant.account, grant.roleHash)
		const signerIsAdmin = await diamond.isRoleAdmin(signerAddress, grant.roleHash)
		const calldata = diamond.interface.encodeFunctionData("grantRole", [grant.account, grant.roleHash])

		planned.push({
			...grant,
			alreadyGranted,
			signerIsAdmin,
			calldata,
		})

		log.info(`${grant.role} (${grant.roleHash})`)
		log.info(`  Account: ${grant.account}`)
		log.info(`  State:   ${alreadyGranted ? "already granted" : "missing"}`)
		log.info(`  Signer:  ${signerIsAdmin ? "authorized role admin" : "not a role admin"}`)
		log.info(`  Calldata: ${calldata}`)
	}

	const pending = planned.filter(grant => !grant.alreadyGranted)
	const unauthorized = pending.filter(grant => !grant.signerIsAdmin)

	if (unauthorized.length === 0) {
		for (const grant of pending) {
			await diamond.grantRole.staticCall(grant.account, grant.roleHash)
		}
		if (pending.length > 0) {
			log.ok(`Static-call preflight passed for ${pending.length} pending grant(s)`)
		}
	} else {
		log.warn(`Signer is not authorized for ${unauthorized.length} pending grant(s)`)
	}
	log.stepDone(preflightTimer)

	const executeTimer = log.step(dryRun ? "Dry-run summary" : "Submit grants")
	if (dryRun) {
		log.warn("DRY RUN — no transactions submitted")
		log.info(`Already granted: ${planned.length - pending.length}`)
		log.info(`Pending:         ${pending.length}`)
		log.info(`Unauthorized:    ${unauthorized.length}`)
		log.info("Set USE_KEYSTORE=true and select the admin key with KEYSTORE_DEPLOYER_KEY for an authenticated preflight.")
		log.info("Set DRY_RUN=false only after the authenticated preflight succeeds.")
		log.stepDone(executeTimer)
		return
	}

	if (process.env.USE_KEYSTORE !== "true") {
		throw new Error("Live role grants require USE_KEYSTORE=true")
	}
	if (unauthorized.length > 0) {
		const details = unauthorized.map(grant => `${grant.role} -> ${grant.account}`).join(", ")
		throw new Error(`Configured signer is not a role admin for: ${details}`)
	}

	for (const grant of pending) {
		log.info(`Granting ${grant.role} to ${grant.account}...`)
		const transaction = await diamond.grantRole(grant.account, grant.roleHash)
		const receipt = await transaction.wait()
		if (!receipt) {
			throw new Error(`No receipt returned for ${grant.role} -> ${grant.account}`)
		}
		const confirmed = await diamond.hasRole(grant.account, grant.roleHash)
		if (!confirmed) {
			throw new Error(`Post-transaction role check failed for ${grant.role} -> ${grant.account}`)
		}
		log.ok(`tx: ${receipt.hash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`)
	}

	if (pending.length === 0) {
		log.ok("All configured roles were already granted; no transactions submitted")
	} else {
		log.ok(`Granted and verified ${pending.length} role(s)`)
	}
	log.stepDone(executeTimer)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
