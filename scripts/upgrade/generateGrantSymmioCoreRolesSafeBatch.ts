/**
 * Generate a Safe multisig batch that grants Symmio core Diamond roles.
 *
 * Defaults to the post-upgrade migration recovery case:
 *   - target: migrationRunner from upgrade-<network>.json
 *   - roles: MIGRATION_ROLE,SYMBOL_MANAGER_ROLE,PARTY_B_MANAGER_ROLE
 *
 * Batch is meant to be executed from the Safe that has admin authority over the
 * roles being granted, typically the protocolAdmin / Safe with DEFAULT_ADMIN_ROLE
 * on the Symmio core Diamond.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/generateGrantSymmioCoreRolesSafeBatch.ts --network base
 *
 * Optional env overrides:
 *   DIAMOND_ADDRESS, SAFE_ADDRESS, CHAIN_ID
 *   GRANT_ROLE_TARGET or TARGET_ADDRESS or MIGRATION_RUNNER
 *   GRANT_ROLES=MIGRATION_ROLE,SYMBOL_MANAGER_ROLE,PARTY_B_MANAGER_ROLE
 *   SKIP_GRANTED=1 to query ViewFacet.hasRole and drop already-granted roles
 *
 * Output:
 *   scripts/upgrade/output/grant-symmio-core-roles-safe-batch-<network>.json
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { loadUpgradeConfigShared } from "./utils/sharedConfig.js"
import { toHumanReadableSafeTxFromIface, type SafeBatch } from "./utils/upgradeHelpers.js"

const OUTPUT_DIR = "./scripts/upgrade/output"
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/
const DEFAULT_ROLES = ["MIGRATION_ROLE", "SYMBOL_MANAGER_ROLE", "PARTY_B_MANAGER_ROLE"]

type RoleTask = {
	target: string
	roleDisplay: string
	roleHash: string
}

function parseList(value: string | undefined, fallback: string[]): string[] {
	if (!value || value.trim() === "") return fallback
	const parsed = value
		.split(",")
		.map(item => item.trim())
		.filter(Boolean)
	return parsed.length > 0 ? parsed : fallback
}

function resolveRoleHash(role: string): { hash: string; display: string } {
	if (BYTES32_RE.test(role)) return { hash: role.toLowerCase(), display: role }
	// Symmio Core uses keccak256("ROLE_NAME"), including DEFAULT_ADMIN_ROLE.
	return { hash: ethers.id(role), display: role }
}

async function resolveChainId(): Promise<string> {
	if (process.env.CHAIN_ID) return process.env.CHAIN_ID
	return String(Number((await ethers.provider.getNetwork()).chainId))
}

async function main() {
	const networkName = connection.networkName
	const shared = loadUpgradeConfigShared(networkName)

	const CHAIN_ID = await resolveChainId()
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	const SAFE_ADDRESS = process.env.SAFE_ADDRESS ?? shared.safeAddress
	const targetRaw = process.env.GRANT_ROLE_TARGET ?? process.env.TARGET_ADDRESS ?? process.env.MIGRATION_RUNNER ?? shared.migrationRunner
	const roleNames = parseList(process.env.GRANT_ROLES, DEFAULT_ROLES)
	const SKIP_GRANTED = process.env.SKIP_GRANTED === "1"

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("DIAMOND_ADDRESS is required (upgrade config or DIAMOND_ADDRESS env)")
	}
	if (!SAFE_ADDRESS || !ethers.isAddress(SAFE_ADDRESS)) {
		throw new Error("SAFE_ADDRESS is required (upgrade config or SAFE_ADDRESS env)")
	}
	if (!targetRaw || !ethers.isAddress(targetRaw)) {
		throw new Error("Grant target is required (GRANT_ROLE_TARGET, TARGET_ADDRESS, MIGRATION_RUNNER, or upgrade config migrationRunner)")
	}

	const diamond = ethers.getAddress(DIAMOND_ADDRESS)
	const safe = ethers.getAddress(SAFE_ADDRESS)
	const target = ethers.getAddress(targetRaw)

	const seen = new Set<string>()
	const tasks: RoleTask[] = []
	for (const role of roleNames) {
		const { hash, display } = resolveRoleHash(role)
		const key = `${target}:${hash}`
		if (seen.has(key)) continue
		seen.add(key)
		tasks.push({ target, roleDisplay: display, roleHash: hash })
	}
	if (tasks.length === 0) throw new Error("No roles requested")

	console.log(`Network:   ${networkName}`)
	console.log(`Chain ID:  ${CHAIN_ID}`)
	console.log(`Diamond:   ${diamond}`)
	console.log(`Safe:      ${safe}`)
	console.log(`Target:    ${target}`)
	console.log(`Roles:     ${tasks.map(t => t.roleDisplay).join(", ")}`)
	console.log()

	let kept = tasks
	if (SKIP_GRANTED) {
		const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", diamond)
		kept = []
		for (const task of tasks) {
			const has = await viewFacet.hasRole(task.target, task.roleHash)
			if (has) {
				console.log(`  already granted: ${task.roleDisplay} -> ${task.target}`)
			} else {
				kept.push(task)
			}
		}
	}

	if (kept.length === 0) {
		console.log("Nothing to grant - all requested roles are already present.")
		return
	}

	const iface = new ethers.Interface(["function grantRole(address user, bytes32 role)"])
	const safeTxs = kept.map(task => toHumanReadableSafeTxFromIface(iface, diamond, "grantRole", [task.target, task.roleHash]))

	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	const outFile = path.join(OUTPUT_DIR, `grant-symmio-core-roles-safe-batch-${networkName}.json`)
	const batch: SafeBatch = {
		version: "1.0",
		chainId: CHAIN_ID,
		createdAt: Date.now(),
		meta: {
			name: "Symmio core - grant roles",
			description: `Grants ${kept.length} role(s) to ${target} on Symmio Diamond ${diamond}`,
			txBuilderVersion: "1.18.0",
			createdFromSafeAddress: safe,
			createdFromOwnerAddress: "",
		},
		transactions: safeTxs,
	}
	fs.writeFileSync(outFile, JSON.stringify(batch, null, 2))

	console.log(`Wrote ${safeTxs.length} transaction(s) to: ${outFile}`)
	for (let i = 0; i < kept.length; i++) {
		const task = kept[i]
		console.log(`  ${i + 1}. grantRole(${task.target}, ${task.roleDisplay})`)
		console.log(`     role hash: ${task.roleHash}`)
	}
	console.log()
	console.log(`Import ${path.basename(outFile)} into the Safe Transaction Builder and execute it from ${safe}.`)
}

main().catch(err => {
	console.error(err)
	process.exitCode = 1
})
