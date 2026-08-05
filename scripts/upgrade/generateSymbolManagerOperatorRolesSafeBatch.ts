/**
 * Generate a Safe multisig batch that grants per-operator roles on the deployed
 * SymmioSymbolManager. Each operator can receive a different set of roles.
 *
 * The batch is meant to be executed from the Safe that holds DEFAULT_ADMIN_ROLE
 * on the SymbolManager (i.e. the admin passed to its constructor, or a later
 * grantee of DEFAULT_ADMIN_ROLE).
 *
 * Config file (resolved via resolveConfigFile):
 *   scripts/upgrade/config/symbolManagerOperators-<network>.json, falls back to
 *   scripts/upgrade/config/symbolManagerOperators.json
 *
 * Config shape:
 *   {
 *     "symbolManagerAddress": "0x...",         // optional, falls back to upgrade-<network>.json:symbolManagerAddress or env
 *     "operators": [
 *       { "address": "0x...", "roles": ["SYMBOL_ADDER_ROLE", "SYMBOL_REMOVER_ROLE"] },
 *       { "address": "0x...", "roles": ["SYMBOL_TRADING_FEE_MANAGER_ROLE"] }
 *     ]
 *   }
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/generateSymbolManagerOperatorRolesSafeBatch.ts --network mantle
 *
 * Optional env overrides:
 *   SYMBOL_MANAGER_ADDRESS, SAFE_ADDRESS, CHAIN_ID,
 *   OPERATORS_FILE (absolute path, skips resolveConfigFile lookup),
 *   SKIP_GRANTED=1 to query hasRole and drop already-granted roles from the batch.
 *
 * Output: scripts/upgrade/output/symbolmanager-operator-roles-safe-batch-<network>.json
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { resolveConfigFile } from "./utils/sharedConfig.js"
import { toHumanReadableSafeTxFromIface, type SafeBatch } from "./utils/upgradeHelpers.js"

// Role names declared in SymmioSymbolManager.sol. Kept explicit so a typo in the
// config file fails loudly instead of silently granting a hash that maps to nothing.
const KNOWN_ROLES = [
	"SYMBOL_ADDER_ROLE",
	"SYMBOL_REMOVER_ROLE",
	"SYMBOL_TRADING_FEE_MANAGER_ROLE",
	"SYMBOL_MAX_LEVERAGE_MANAGER_ROLE",
	"SYMBOL_FUNDING_STATE_MANAGER_ROLE",
	"SYMBOL_MIN_ACCEPTABLE_VALUES_MANAGER_ROLE",
	"SYMBOL_FORCE_CLOSE_GAP_RATIO_MANAGER_ROLE",
	"SETTER_ROLE",
	"PAUSER_ROLE",
	"UNPAUSER_ROLE",
	"DEFAULT_ADMIN_ROLE",
] as const
type RoleName = (typeof KNOWN_ROLES)[number]

const DEFAULT_ADMIN_ROLE = "0x" + "00".repeat(32)

type OperatorEntry = { address: string; roles: string[] }
type OperatorsConfig = {
	symbolManagerAddress?: string
	operators?: OperatorEntry[]
}
type UpgradeConfig = { safeAddress?: string; symbolManagerAddress?: string }

const OUTPUT_DIR = "./scripts/upgrade/output"

function roleHash(role: RoleName): string {
	if (role === "DEFAULT_ADMIN_ROLE") return DEFAULT_ADMIN_ROLE
	return ethers.id(role)
}

function loadOperatorsConfig(networkName: string): OperatorsConfig {
	const file = resolveConfigFile("symbolManagerOperators", networkName, process.env.OPERATORS_FILE)
	if (!fs.existsSync(file)) {
		throw new Error(`Operators config not found: ${file}. Copy symbolManagerOperators.sample.json and fill it in.`)
	}
	console.log(`Operators config: ${file}`)
	return JSON.parse(fs.readFileSync(file, "utf-8")) as OperatorsConfig
}

function loadUpgradeConfig(networkName: string): UpgradeConfig {
	const file = resolveConfigFile("upgrade", networkName, process.env.UPGRADE_CONFIG_FILE)
	if (!fs.existsSync(file)) return {}
	return JSON.parse(fs.readFileSync(file, "utf-8")) as UpgradeConfig
}

async function main() {
	const networkName = connection.networkName
	const operatorsConfig = loadOperatorsConfig(networkName)
	const upgradeConfig = loadUpgradeConfig(networkName)

	const CHAIN_ID = process.env.CHAIN_ID ?? String(Number((await ethers.provider.getNetwork()).chainId))
	const SAFE_ADDRESS = process.env.SAFE_ADDRESS ?? upgradeConfig.safeAddress
	const SM_ADDRESS = process.env.SYMBOL_MANAGER_ADDRESS ?? operatorsConfig.symbolManagerAddress ?? upgradeConfig.symbolManagerAddress
	const SKIP_GRANTED = process.env.SKIP_GRANTED === "1"

	if (!SM_ADDRESS || !ethers.isAddress(SM_ADDRESS)) {
		throw new Error("symbolManagerAddress is required (operators config, upgrade config, or SYMBOL_MANAGER_ADDRESS env)")
	}
	if (!SAFE_ADDRESS || !ethers.isAddress(SAFE_ADDRESS)) {
		throw new Error("safeAddress is required (upgrade config or SAFE_ADDRESS env)")
	}
	const operators = operatorsConfig.operators ?? []
	if (operators.length === 0) throw new Error("operators list is empty")

	const sm = ethers.getAddress(SM_ADDRESS)
	const safe = ethers.getAddress(SAFE_ADDRESS)

	console.log(`Network:        ${networkName}`)
	console.log(`Chain ID:       ${CHAIN_ID}`)
	console.log(`SymbolManager:  ${sm}`)
	console.log(`Safe:           ${safe}`)
	console.log(`Operators:      ${operators.length}`)
	console.log()

	// Validate entries and build the (operator, role) task list. Dedupe per
	// (operator, roleHash) since the same tx appearing twice in a Safe batch just
	// wastes gas/review time.
	type Task = { operator: string; role: RoleName; roleHash: string }
	const seen = new Set<string>()
	const tasks: Task[] = []

	for (const entry of operators) {
		if (!entry.address || !ethers.isAddress(entry.address)) {
			throw new Error(`Invalid operator address: ${JSON.stringify(entry.address)}`)
		}
		const operator = ethers.getAddress(entry.address)
		if (!Array.isArray(entry.roles) || entry.roles.length === 0) {
			throw new Error(`Operator ${operator} has no roles`)
		}
		for (const role of entry.roles) {
			if (!KNOWN_ROLES.includes(role as RoleName)) {
				throw new Error(`Unknown role "${role}" for ${operator}. Known roles: ${KNOWN_ROLES.join(", ")}`)
			}
			const rh = roleHash(role as RoleName)
			const key = `${operator}:${rh}`
			if (seen.has(key)) continue
			seen.add(key)
			tasks.push({ operator, role: role as RoleName, roleHash: rh })
		}
	}

	// Optional: prune tasks that are already granted. Keeps the batch minimal on
	// re-runs. Uses a single eth_call per task — fine for typical operator counts.
	let kept: Task[] = tasks
	if (SKIP_GRANTED) {
		const smContract = await ethers.getContractAt("SymmioSymbolManager", sm)
		const filtered: Task[] = []
		for (const t of tasks) {
			const already = await smContract.hasRole(t.roleHash, t.operator)
			if (already) {
				console.log(`  ⏭ ${t.role} already granted to ${t.operator}`)
			} else {
				filtered.push(t)
			}
		}
		kept = filtered
	}

	if (kept.length === 0) {
		console.log("Nothing to grant — all requested roles are already in place.")
		return
	}

	// AccessControl.grantRole signature is (bytes32 role, address account) — note
	// this differs from the Diamond's ControlFacet which is (address, bytes32).
	const iface = new ethers.Interface(["function grantRole(bytes32 role, address account)"])
	const safeTxs = kept.map(t => toHumanReadableSafeTxFromIface(iface, sm, "grantRole", [t.roleHash, t.operator]))

	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	const outFile = path.join(OUTPUT_DIR, `symbolmanager-operator-roles-safe-batch-${networkName}.json`)
	const batch: SafeBatch = {
		version: "1.0",
		chainId: CHAIN_ID,
		createdAt: Date.now(),
		meta: {
			name: "SymmioSymbolManager — grant operator roles",
			description: `Grants ${kept.length} operator role(s) across ${new Set(kept.map(t => t.operator)).size} address(es) on SymmioSymbolManager ${sm}`,
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
		console.log(`  ${i + 1}. grantRole(${t.role}, ${t.operator})`)
	}
	console.log(`\nImport this file into the Safe Transaction Builder and execute from the Safe that holds DEFAULT_ADMIN_ROLE on ${sm}.`)
}

main().catch(err => {
	console.error(err)
	process.exitCode = 1
})
