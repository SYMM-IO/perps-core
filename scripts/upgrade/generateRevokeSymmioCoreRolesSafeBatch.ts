/**
 * Generate a Safe multisig batch that revokes a set of roles from one or more
 * contracts on the Symmio core Diamond (e.g. deprecated SymmioSymbolManager
 * versions that still hold SYMBOL_MANAGER_ROLE / FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE /
 * any legacy role).
 *
 * Batch is meant to be executed from the Safe that has admin authority over the
 * roles being revoked (typically DEFAULT_ADMIN_ROLE on the Diamond).
 *
 * Config file (resolved via resolveConfigFile):
 *   scripts/upgrade/config/revokeSymmioCoreRoles-<network>.json, falls back to
 *   scripts/upgrade/config/revokeSymmioCoreRoles.json
 *
 * Config shape:
 *   {
 *     "diamondAddress": "0x...",   // optional, falls back to upgrade-<network>.json
 *     "targets": [
 *       {
 *         "address": "0xOldContract",
 *         "roles": ["SYMBOL_MANAGER_ROLE", "SETTER_ROLE"]
 *         // roles may be plain names (hashed with keccak256) OR raw 0x-prefixed bytes32 hashes
 *       }
 *     ]
 *   }
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/generateRevokeSymmioCoreRolesSafeBatch.ts --network mantle
 *
 * Optional env overrides:
 *   DIAMOND_ADDRESS, SAFE_ADDRESS, CHAIN_ID,
 *   REVOKE_ROLES_FILE (absolute path, skips resolveConfigFile lookup),
 *   SKIP_NOT_GRANTED=1 to query ViewFacet.hasRole and drop no-op revokes.
 *
 * Output: scripts/upgrade/output/revoke-symmio-core-roles-safe-batch-<network>.json
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { resolveConfigFile } from "./utils/sharedConfig.js"
import { toHumanReadableSafeTxFromIface, type SafeBatch } from "./utils/upgradeHelpers.js"

type TargetEntry = { address: string; roles: string[] }
type RevokeConfig = { diamondAddress?: string; targets?: TargetEntry[] }
type UpgradeConfig = { diamondAddress?: string; safeAddress?: string }

const OUTPUT_DIR = "./scripts/upgrade/output"
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/

function resolveRoleHash(role: string): { hash: string; display: string } {
	if (BYTES32_RE.test(role)) return { hash: role.toLowerCase(), display: role }
	// Note: on the Symmio Diamond, even DEFAULT_ADMIN_ROLE is keccak256("DEFAULT_ADMIN_ROLE")
	// (see LibAccessibility.sol), not bytes32(0) like OZ's AccessControl uses. So we hash
	// every name uniformly — no special cases.
	return { hash: ethers.id(role), display: role }
}

function loadRevokeConfig(networkName: string): RevokeConfig {
	const file = resolveConfigFile("revokeSymmioCoreRoles", networkName, process.env.REVOKE_ROLES_FILE)
	if (!fs.existsSync(file)) {
		throw new Error(`Revoke config not found: ${file}. Copy revokeSymmioCoreRoles.sample.json and fill it in.`)
	}
	console.log(`Revoke config: ${file}`)
	return JSON.parse(fs.readFileSync(file, "utf-8")) as RevokeConfig
}

function loadUpgradeConfig(networkName: string): UpgradeConfig {
	const file = resolveConfigFile("upgrade", networkName, process.env.UPGRADE_CONFIG_FILE)
	if (!fs.existsSync(file)) return {}
	return JSON.parse(fs.readFileSync(file, "utf-8")) as UpgradeConfig
}

async function main() {
	const networkName = connection.networkName
	const revokeConfig = loadRevokeConfig(networkName)
	const upgradeConfig = loadUpgradeConfig(networkName)

	const CHAIN_ID = process.env.CHAIN_ID ?? String(Number((await ethers.provider.getNetwork()).chainId))
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? revokeConfig.diamondAddress ?? upgradeConfig.diamondAddress
	const SAFE_ADDRESS = process.env.SAFE_ADDRESS ?? upgradeConfig.safeAddress
	const SKIP_NOT_GRANTED = process.env.SKIP_NOT_GRANTED === "1"

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("diamondAddress is required (revoke config, upgrade config, or DIAMOND_ADDRESS env)")
	}
	if (!SAFE_ADDRESS || !ethers.isAddress(SAFE_ADDRESS)) {
		throw new Error("safeAddress is required (upgrade config or SAFE_ADDRESS env)")
	}
	const targets = revokeConfig.targets ?? []
	if (targets.length === 0) throw new Error("targets list is empty")

	const diamond = ethers.getAddress(DIAMOND_ADDRESS)
	const safe = ethers.getAddress(SAFE_ADDRESS)

	console.log(`Network:   ${networkName}`)
	console.log(`Chain ID:  ${CHAIN_ID}`)
	console.log(`Diamond:   ${diamond}`)
	console.log(`Safe:      ${safe}`)
	console.log(`Targets:   ${targets.length}`)
	console.log()

	// Build (target, role) task list, deduped per (target, roleHash).
	type Task = { target: string; roleDisplay: string; roleHash: string }
	const seen = new Set<string>()
	const tasks: Task[] = []

	for (const entry of targets) {
		if (!entry.address || !ethers.isAddress(entry.address)) {
			throw new Error(`Invalid target address: ${JSON.stringify(entry.address)}`)
		}
		const target = ethers.getAddress(entry.address)
		if (!Array.isArray(entry.roles) || entry.roles.length === 0) {
			throw new Error(`Target ${target} has no roles`)
		}
		for (const role of entry.roles) {
			const { hash, display } = resolveRoleHash(role)
			const key = `${target}:${hash}`
			if (seen.has(key)) continue
			seen.add(key)
			tasks.push({ target, roleDisplay: display, roleHash: hash })
		}
	}

	// Optional: prune revokes for roles the target doesn't actually hold.
	let kept: Task[] = tasks
	if (SKIP_NOT_GRANTED) {
		const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", diamond)
		const filtered: Task[] = []
		for (const t of tasks) {
			const has = await viewFacet.hasRole(t.target, t.roleHash)
			if (!has) {
				console.log(`  ⏭ ${t.target} does not hold ${t.roleDisplay} — skipping`)
			} else {
				filtered.push(t)
			}
		}
		kept = filtered
	}

	if (kept.length === 0) {
		console.log("Nothing to revoke — none of the requested roles are currently granted.")
		return
	}

	// ControlFacet.revokeRole(address user, bytes32 role) — same arg order as grantRole
	// on the Diamond (opposite of OZ AccessControl, which is (role, account)).
	const iface = new ethers.Interface(["function revokeRole(address user, bytes32 role)"])
	const safeTxs = kept.map(t => toHumanReadableSafeTxFromIface(iface, diamond, "revokeRole", [t.target, t.roleHash]))

	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	const outFile = path.join(OUTPUT_DIR, `revoke-symmio-core-roles-safe-batch-${networkName}.json`)
	const uniqueTargets = new Set(kept.map(t => t.target)).size
	const batch: SafeBatch = {
		version: "1.0",
		chainId: CHAIN_ID,
		createdAt: Date.now(),
		meta: {
			name: "Symmio core — revoke legacy roles",
			description: `Revokes ${kept.length} role(s) across ${uniqueTargets} contract(s) on Symmio Diamond ${diamond}`,
			txBuilderVersion: "1.18.0",
			createdFromSafeAddress: safe,
			createdFromOwnerAddress: "",
		},
		transactions: safeTxs,
	}
	fs.writeFileSync(outFile, JSON.stringify(batch, null, 2))

	console.log(`\nWrote ${safeTxs.length} transaction(s) to: ${outFile}`)
	for (let i = 0; i < kept.length; i++) {
		const t = kept[i]
		console.log(`  ${i + 1}. revokeRole(${t.target}, ${t.roleDisplay})`)
	}
	console.log(`\nImport this file into the Safe Transaction Builder and execute from the Safe that has admin authority over these roles on ${diamond}.`)
}

main().catch(err => {
	console.error(err)
	process.exitCode = 1
})
