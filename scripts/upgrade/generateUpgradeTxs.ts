import fs from "fs"
import path from "path"

import { ethers } from "../../test/helpers/hardhat-connection.js"
import { getImpersonatedAdmin } from "./utils/forkHelpers.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { deployFacets, buildDiamondCut, type FacetInfo } from "./utils/upgradeHelpers.js"

/**
 * Generate upgrade transactions for the v0.8.5 upgrade.
 *
 * Deploys facets (or loads pre-deployed addresses), builds the diamondCut
 * against the live diamond, then outputs:
 *   1. Raw calldata transactions (universal, works with any wallet/multisig/script)
 *   2. Safe Transaction Builder JSON batch (optional, when SAFE_ADDRESS is provided)
 *
 * Usage:
 *   # Raw calldata only (no Safe)
 *   DIAMOND_ADDRESS=0x... ADMIN_ADDRESS=0x... npx hardhat run scripts/upgrade/generateUpgradeTxs.ts --network arbitrum
 *
 *   # Raw calldata + Safe batch
 *   DIAMOND_ADDRESS=0x... ADMIN_ADDRESS=0x... SAFE_ADDRESS=0x... npx hardhat run scripts/upgrade/generateUpgradeTxs.ts --network arbitrum
 *
 *   # Deploy + generate + execute on a fork (local testing)
 *   DIAMOND_ADDRESS=0x... ADMIN_ADDRESS=0x... EXECUTE=true \
 *     npx hardhat run scripts/upgrade/generateUpgradeTxs.ts --network localhost
 *
 *   # Load pre-deployed facets (skip deployment)
 *   DIAMOND_ADDRESS=0x... ADMIN_ADDRESS=0x... FACETS_FILE=./scripts/upgrade/output/deployed-facets.json \
 *     npx hardhat run scripts/upgrade/generateUpgradeTxs.ts --network arbitrum
 *
 * Config: scripts/upgrade/config/upgrade.json
 *
 * Output:
 *   scripts/upgrade/output/upgrade-transactions.json  -- Raw calldata transactions (always)
 *   scripts/upgrade/output/safe-batch.json            -- Safe Transaction Builder JSON (if SAFE_ADDRESS set)
 *   scripts/upgrade/output/deployed-facets.json       -- Deployed addresses (if deploying)
 *   scripts/upgrade/output/upgrade-details.json       -- Selector changes + transaction breakdown
 */

// =============================================================================
// Types
// =============================================================================

type CalldataTransaction = {
	to: string
	value: string
	calldata: string
	description: string
}

type AbiInput = {
	internalType: string
	name: string
	type: string
	components?: AbiInput[]
}

type SafeTransaction = {
	to: string
	value: string
	data: string | null
	contractMethod?: {
		inputs: AbiInput[]
		name: string
		payable: boolean
	}
	contractInputsValues?: Record<string, string>
}

type SafeBatch = {
	version: string
	chainId: string
	createdAt: number
	meta: {
		name: string
		description: string
		txBuilderVersion: string
		createdFromSafeAddress: string
		createdFromOwnerAddress: string
	}
	transactions: SafeTransaction[]
}

type Config = {
	diamondAddress?: string
	adminAddress?: string
	safeAddress?: string
	migrationRunner?: string
	diamondCutChunkSize?: number
	execute?: boolean
	newV085Parameters?: {
		maxPartyAConnectionLimit?: number
		signatureVerifierAddress?: string
		liquidationInsuranceVault?: string
		maxLiquidationProfitPerPosition?: string
		softLiquidationPenaltyCollector?: string
		minAffiliateFee?: string
		unbindCooldown?: number
		maxWithdrawParts?: number
		minWithdrawCooldown?: number
	}
}

type DeployedFacets = {
	facets: Record<string, FacetInfo>
	selectorSignatures: Record<string, string>
}

function parseBool(value: string | boolean | undefined, fallback: boolean): boolean {
	if (value === undefined || value === null || value === "") return fallback
	if (typeof value === "boolean") return value
	const normalized = String(value).toLowerCase()
	if (normalized === "true" || normalized === "1") return true
	if (normalized === "false" || normalized === "0") return false
	throw new Error(`Invalid boolean value: ${value}`)
}

const CONFIG_FILE = process.env.UPGRADE_CONFIG_FILE ?? "./scripts/upgrade/config/upgrade.json"
const OUTPUT_DIR = "./scripts/upgrade/output"

function loadConfig(): Config {
	if (!fs.existsSync(CONFIG_FILE)) return {}
	return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Config
}

function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

// =============================================================================
// ABI Fragments for calldata encoding
// =============================================================================

const DIAMOND_ABI = [
	"function grantRole(address user, bytes32 role)",
	"function pauseGlobal()",
	"function diamondCut(tuple(address facetAddress, uint8 action, bytes4[] functionSelectors)[] _diamondCut, address _init, bytes _calldata)",
	"function setMaxPartyAConnectionLimit(uint256 maxLimit)",
	"function setSignatureVerifierAddress(address signatureVerifier)",
	"function setLiquidationInsuranceVaultParams(address insuranceVault, uint256 maxLiquidationProfit)",
	"function setSoftLiquidationPenaltyCollector(address softLiquidationPenaltyCollector)",
	"function setMinAffiliateFee(uint256 minAffiliateFee)",
	"function setUnbindCooldown(uint256 unbindCooldown)",
	"function setMaxWithdrawParts(uint256 _maxWithdrawParts)",
	"function setMinWithdrawCooldown(uint256 cooldown)",
]

const diamondIface = new ethers.Interface(DIAMOND_ABI)

// =============================================================================
// Calldata builders
// =============================================================================

function encodeGrantRole(user: string, roleName: string): string {
	return diamondIface.encodeFunctionData("grantRole", [user, ethers.id(roleName)])
}

function encodePauseGlobal(): string {
	return diamondIface.encodeFunctionData("pauseGlobal")
}

function encodeDiamondCut(chunk: any[]): string {
	const cutTuples = chunk.map((cut: any) => [cut.facetAddress, cut.action, cut.functionSelectors])
	return diamondIface.encodeFunctionData("diamondCut", [cutTuples, ethers.ZeroAddress, "0x"])
}

function encodeSetParam(funcName: string, value: number): string {
	return diamondIface.encodeFunctionData(funcName, [value])
}

// =============================================================================
// Safe Transaction builders (for optional Safe batch output)
// =============================================================================

function toSafeTx(tx: CalldataTransaction): SafeTransaction {
	return {
		to: tx.to,
		value: tx.value,
		data: tx.calldata,
	}
}

// =============================================================================
// Main
// =============================================================================

async function main() {
	await verifyRpc()
	const config = loadConfig()

	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
	const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS ?? config.adminAddress
	const SAFE_ADDRESS = process.env.SAFE_ADDRESS ?? config.safeAddress
	const MIGRATION_RUNNER = process.env.MIGRATION_RUNNER ?? config.migrationRunner ?? ADMIN_ADDRESS
	const FACETS_FILE = process.env.FACETS_FILE
	const CHAIN_ID = process.env.CHAIN_ID ?? String(Number((await ethers.provider.getNetwork()).chainId))
	const DIAMOND_CUT_CHUNK_SIZE = Number(process.env.DIAMOND_CUT_CHUNK_SIZE ?? config.diamondCutChunkSize ?? 6)
	const EXECUTE = parseBool(process.env.EXECUTE, config.execute ?? false)
	const newParams = config.newV085Parameters ?? {}

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("DIAMOND_ADDRESS is required (env var or config file)")
	}
	if (!ADMIN_ADDRESS || !ethers.isAddress(ADMIN_ADDRESS)) {
		throw new Error("ADMIN_ADDRESS is required -- the address that will execute upgrade transactions")
	}
	if (!MIGRATION_RUNNER || !ethers.isAddress(MIGRATION_RUNNER)) {
		throw new Error("MIGRATION_RUNNER must be a valid address")
	}

	console.log(`Diamond:          ${DIAMOND_ADDRESS}`)
	console.log(`Admin:            ${ADMIN_ADDRESS}`)
	if (SAFE_ADDRESS) {
		console.log(`Safe:             ${SAFE_ADDRESS}`)
	}
	console.log(`Migration runner: ${MIGRATION_RUNNER}`)
	console.log(`Chain ID:         ${CHAIN_ID}`)
	console.log(`Execute:          ${EXECUTE}`)
	console.log()

	// Step 1: Get facet data (deploy or load pre-deployed)
	let facetData: DeployedFacets

	if (FACETS_FILE) {
		console.log(`Loading pre-deployed facets from ${FACETS_FILE}...`)
		if (!fs.existsSync(FACETS_FILE)) {
			throw new Error(`Facets file not found: ${FACETS_FILE}`)
		}
		facetData = JSON.parse(fs.readFileSync(FACETS_FILE, "utf-8")) as DeployedFacets
		console.log(`Loaded ${Object.keys(facetData.facets).length} facets.`)
	} else {
		console.log("Deploying v0.8.5 facets + libraries...")
		facetData = await deployFacets()
		console.log(`\nDeployed ${Object.keys(facetData.facets).length} facets.`)

		ensureDir(OUTPUT_DIR)
		const facetsOutFile = path.join(OUTPUT_DIR, "deployed-facets.json")
		fs.writeFileSync(facetsOutFile, JSON.stringify(facetData, null, 2))
		console.log(`Facet addresses saved to ${facetsOutFile}`)
	}
	console.log()

	// Step 2: Build diamond cut against live diamond
	console.log("Building diamond cut...")
	const { diamondCut, selectorChanges } = await buildDiamondCut(DIAMOND_ADDRESS, facetData.facets, facetData.selectorSignatures)
	const actionCounts = { add: 0, replace: 0, remove: 0 }
	for (const change of selectorChanges) actionCounts[change.action] += 1
	console.log(`Selector changes: ${selectorChanges.length} (add=${actionCounts.add}, replace=${actionCounts.replace}, remove=${actionCounts.remove})`)

	const chunks: any[][] = []
	for (let i = 0; i < diamondCut.length; i += DIAMOND_CUT_CHUNK_SIZE) {
		chunks.push(diamondCut.slice(i, i + DIAMOND_CUT_CHUNK_SIZE))
	}
	console.log(`Diamond cut chunks: ${chunks.length} (chunk size ${DIAMOND_CUT_CHUNK_SIZE})`)
	console.log()

	// Step 3: Build transactions with raw calldata
	console.log("Building upgrade transactions...")
	const transactions: CalldataTransaction[] = []
	const breakdown: string[] = []
	let txIdx = 1

	// Phase 1: Pre-upgrade pause
	transactions.push({
		to: DIAMOND_ADDRESS,
		value: "0",
		calldata: encodeGrantRole(ADMIN_ADDRESS, "PAUSER_ROLE"),
		description: `grantRole(PAUSER_ROLE) -> ${ADMIN_ADDRESS}`,
	})
	breakdown.push(`${txIdx++}. grantRole(PAUSER_ROLE) -> ${ADMIN_ADDRESS}`)

	transactions.push({
		to: DIAMOND_ADDRESS,
		value: "0",
		calldata: encodeGrantRole(ADMIN_ADDRESS, "UNPAUSER_ROLE"),
		description: `grantRole(UNPAUSER_ROLE) -> ${ADMIN_ADDRESS}`,
	})
	breakdown.push(`${txIdx++}. grantRole(UNPAUSER_ROLE) -> ${ADMIN_ADDRESS}`)

	transactions.push({
		to: DIAMOND_ADDRESS,
		value: "0",
		calldata: encodePauseGlobal(),
		description: "pauseGlobal()",
	})
	breakdown.push(`${txIdx++}. pauseGlobal()`)

	// Phase 2: Diamond cut (chunked)
	for (let i = 0; i < chunks.length; i++) {
		const selectorCount = chunks[i].reduce((sum: number, cut: any) => sum + cut.functionSelectors.length, 0)
		const desc = `diamondCut chunk ${i + 1}/${chunks.length} (${chunks[i].length} cuts, ${selectorCount} selectors)`
		transactions.push({
			to: DIAMOND_ADDRESS,
			value: "0",
			calldata: encodeDiamondCut(chunks[i]),
			description: desc,
		})
		breakdown.push(`${txIdx++}. ${desc}`)
	}

	// Phase 3: Post-upgrade parameter config -- grant required roles
	transactions.push({
		to: DIAMOND_ADDRESS,
		value: "0",
		calldata: encodeGrantRole(ADMIN_ADDRESS, "PROTOCOL_CONFIG_ROLE"),
		description: `grantRole(PROTOCOL_CONFIG_ROLE) -> ${ADMIN_ADDRESS}`,
	})
	breakdown.push(`${txIdx++}. grantRole(PROTOCOL_CONFIG_ROLE) -> ${ADMIN_ADDRESS}`)

	transactions.push({
		to: DIAMOND_ADDRESS,
		value: "0",
		calldata: encodeGrantRole(ADMIN_ADDRESS, "COOLDOWN_ADMIN_ROLE"),
		description: `grantRole(COOLDOWN_ADMIN_ROLE) -> ${ADMIN_ADDRESS}`,
	})
	breakdown.push(`${txIdx++}. grantRole(COOLDOWN_ADMIN_ROLE) -> ${ADMIN_ADDRESS}`)

	const needsFeeAdminRole =
		(newParams.liquidationInsuranceVault && newParams.maxLiquidationProfitPerPosition) ||
		newParams.softLiquidationPenaltyCollector ||
		newParams.minAffiliateFee

	if (needsFeeAdminRole) {
		transactions.push({
			to: DIAMOND_ADDRESS,
			value: "0",
			calldata: encodeGrantRole(ADMIN_ADDRESS, "FEE_ADMIN_ROLE"),
			description: `grantRole(FEE_ADMIN_ROLE) -> ${ADMIN_ADDRESS}`,
		})
		breakdown.push(`${txIdx++}. grantRole(FEE_ADMIN_ROLE) -> ${ADMIN_ADDRESS}`)
	}

	// Phase 3a: Existing v0.8.5 parameters
	if (newParams.maxPartyAConnectionLimit && newParams.maxPartyAConnectionLimit > 0) {
		transactions.push({
			to: DIAMOND_ADDRESS,
			value: "0",
			calldata: encodeSetParam("setMaxPartyAConnectionLimit", newParams.maxPartyAConnectionLimit),
			description: `setMaxPartyAConnectionLimit(${newParams.maxPartyAConnectionLimit})`,
		})
		breakdown.push(`${txIdx++}. setMaxPartyAConnectionLimit(${newParams.maxPartyAConnectionLimit})`)
	}

	// Phase 3b: Signature verifier (DEFAULT_ADMIN_ROLE -- admin already has this)
	if (newParams.signatureVerifierAddress && ethers.isAddress(newParams.signatureVerifierAddress)) {
		transactions.push({
			to: DIAMOND_ADDRESS,
			value: "0",
			calldata: diamondIface.encodeFunctionData("setSignatureVerifierAddress", [newParams.signatureVerifierAddress]),
			description: `setSignatureVerifierAddress(${newParams.signatureVerifierAddress})`,
		})
		breakdown.push(`${txIdx++}. setSignatureVerifierAddress(${newParams.signatureVerifierAddress})`)
	}

	// Phase 3c: Liquidation insurance (FEE_ADMIN_ROLE)
	if (newParams.liquidationInsuranceVault && newParams.maxLiquidationProfitPerPosition) {
		if (!ethers.isAddress(newParams.liquidationInsuranceVault)) {
			throw new Error(`Invalid liquidationInsuranceVault address: ${newParams.liquidationInsuranceVault}`)
		}
		const desc = `setLiquidationInsuranceVaultParams(${newParams.liquidationInsuranceVault}, ${newParams.maxLiquidationProfitPerPosition})`
		transactions.push({
			to: DIAMOND_ADDRESS,
			value: "0",
			calldata: diamondIface.encodeFunctionData("setLiquidationInsuranceVaultParams", [
				newParams.liquidationInsuranceVault,
				newParams.maxLiquidationProfitPerPosition,
			]),
			description: desc,
		})
		breakdown.push(`${txIdx++}. ${desc}`)
	}

	// Phase 3d: Soft liquidation penalty collector (FEE_ADMIN_ROLE)
	if (newParams.softLiquidationPenaltyCollector && ethers.isAddress(newParams.softLiquidationPenaltyCollector)) {
		transactions.push({
			to: DIAMOND_ADDRESS,
			value: "0",
			calldata: diamondIface.encodeFunctionData("setSoftLiquidationPenaltyCollector", [newParams.softLiquidationPenaltyCollector]),
			description: `setSoftLiquidationPenaltyCollector(${newParams.softLiquidationPenaltyCollector})`,
		})
		breakdown.push(`${txIdx++}. setSoftLiquidationPenaltyCollector(${newParams.softLiquidationPenaltyCollector})`)
	}

	// Phase 3e: Min affiliate fee (FEE_ADMIN_ROLE)
	if (newParams.minAffiliateFee) {
		transactions.push({
			to: DIAMOND_ADDRESS,
			value: "0",
			calldata: diamondIface.encodeFunctionData("setMinAffiliateFee", [newParams.minAffiliateFee]),
			description: `setMinAffiliateFee(${newParams.minAffiliateFee})`,
		})
		breakdown.push(`${txIdx++}. setMinAffiliateFee(${newParams.minAffiliateFee})`)
	}

	// Phase 3f: Cooldown params (COOLDOWN_ADMIN_ROLE -- already granted)
	if (newParams.unbindCooldown !== undefined && newParams.unbindCooldown > 0) {
		transactions.push({
			to: DIAMOND_ADDRESS,
			value: "0",
			calldata: encodeSetParam("setUnbindCooldown", newParams.unbindCooldown),
			description: `setUnbindCooldown(${newParams.unbindCooldown})`,
		})
		breakdown.push(`${txIdx++}. setUnbindCooldown(${newParams.unbindCooldown})`)
	}
	if (newParams.minWithdrawCooldown !== undefined && newParams.minWithdrawCooldown > 0) {
		transactions.push({
			to: DIAMOND_ADDRESS,
			value: "0",
			calldata: encodeSetParam("setMinWithdrawCooldown", newParams.minWithdrawCooldown),
			description: `setMinWithdrawCooldown(${newParams.minWithdrawCooldown})`,
		})
		breakdown.push(`${txIdx++}. setMinWithdrawCooldown(${newParams.minWithdrawCooldown})`)
	}

	// Phase 3g: Withdraw params (PROTOCOL_CONFIG_ROLE -- already granted)
	if (newParams.maxWithdrawParts !== undefined && newParams.maxWithdrawParts > 0) {
		transactions.push({
			to: DIAMOND_ADDRESS,
			value: "0",
			calldata: encodeSetParam("setMaxWithdrawParts", newParams.maxWithdrawParts),
			description: `setMaxWithdrawParts(${newParams.maxWithdrawParts})`,
		})
		breakdown.push(`${txIdx++}. setMaxWithdrawParts(${newParams.maxWithdrawParts})`)
	}

	// Phase 4: Migration role grant
	transactions.push({
		to: DIAMOND_ADDRESS,
		value: "0",
		calldata: encodeGrantRole(MIGRATION_RUNNER, "MIGRATION_ROLE"),
		description: `grantRole(MIGRATION_ROLE) -> ${MIGRATION_RUNNER}`,
	})
	breakdown.push(`${txIdx++}. grantRole(MIGRATION_ROLE) -> ${MIGRATION_RUNNER}`)

	// Step 4: Write output files
	ensureDir(OUTPUT_DIR)

	// Always write raw calldata transactions
	const txFile = path.join(OUTPUT_DIR, "upgrade-transactions.json")
	fs.writeFileSync(
		txFile,
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				diamondAddress: DIAMOND_ADDRESS,
				adminAddress: ADMIN_ADDRESS,
				migrationRunner: MIGRATION_RUNNER,
				chainId: CHAIN_ID,
				transactions,
			},
			null,
			2,
		),
	)
	console.log(`\nRaw calldata transactions: ${txFile}`)

	// Optionally write Safe batch JSON
	if (SAFE_ADDRESS && ethers.isAddress(SAFE_ADDRESS)) {
		const batchFile = path.join(OUTPUT_DIR, "safe-batch.json")
		const batch: SafeBatch = {
			version: "1.0",
			chainId: CHAIN_ID,
			createdAt: Date.now(),
			meta: {
				name: "Symmio v0.8.5 Upgrade",
				description: "Generated by scripts/upgrade/generateUpgradeTxs.ts",
				txBuilderVersion: "1.18.0",
				createdFromSafeAddress: SAFE_ADDRESS,
				createdFromOwnerAddress: "",
			},
			transactions: transactions.map(toSafeTx),
		}
		fs.writeFileSync(batchFile, JSON.stringify(batch, null, 2))
		console.log(`Safe batch:               ${batchFile}`)
	}

	// Write details file
	const detailsFile = path.join(OUTPUT_DIR, "upgrade-details.json")
	fs.writeFileSync(
		detailsFile,
		JSON.stringify(
			{
				diamondAddress: DIAMOND_ADDRESS,
				adminAddress: ADMIN_ADDRESS,
				safeAddress: SAFE_ADDRESS ?? null,
				migrationRunner: MIGRATION_RUNNER,
				chainId: CHAIN_ID,
				transactionCount: transactions.length,
				breakdown,
				selectorChanges,
				diamondCutChunks: chunks.length,
				chunkSize: DIAMOND_CUT_CHUNK_SIZE,
			},
			null,
			2,
		),
	)
	console.log(`Details:                  ${detailsFile}`)

	console.log(`\nTransaction breakdown (${transactions.length} total):`)
	for (const line of breakdown) {
		console.log(`  ${line}`)
	}

	if (SAFE_ADDRESS) {
		console.log("\nImport safe-batch.json into Safe Transaction Builder to review and execute.")
	} else {
		console.log("\nUse upgrade-transactions.json calldata to execute from any wallet or multisig.")
	}

	// Optionally execute transactions on-chain (for local/fork testing)
	if (EXECUTE) {
		console.log("\n" + "=".repeat(70))
		console.log(" Executing transactions on-chain")
		console.log("=".repeat(70))

		// Impersonate the actual diamond owner (may differ from ADMIN_ADDRESS)
		const admin = await getImpersonatedAdmin(DIAMOND_ADDRESS)
		const ownerAddress = await admin.getAddress()

		// In production, the Safe already has DEFAULT_ADMIN_ROLE and all needed roles.
		// On a fork, the diamond owner has neither — bootstrap them before executing.
		console.log(`\nBootstrapping roles for diamond owner...`)
		const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", DIAMOND_ADDRESS, admin)
		await (await controlFacet.setAdmin(ownerAddress)).wait()
		console.log(`  DEFAULT_ADMIN_ROLE granted via setAdmin()`)

		const bootstrapRoles = ["PAUSER_ROLE", "UNPAUSER_ROLE", "PROTOCOL_CONFIG_ROLE", "COOLDOWN_ADMIN_ROLE", "FEE_ADMIN_ROLE", "MIGRATION_ROLE"]
		for (const role of bootstrapRoles) {
			await (await controlFacet.grantRole(ownerAddress, ethers.id(role))).wait()
			console.log(`  ${role} granted`)
		}
		console.log(`  Done.`)

		for (let i = 0; i < transactions.length; i++) {
			const tx = transactions[i]
			console.log(`\n[${i + 1}/${transactions.length}] ${tx.description}`)
			const response = await admin.sendTransaction({
				to: tx.to,
				value: tx.value,
				data: tx.calldata,
			})
			const receipt = await response.wait(1)
			console.log(`  tx: ${receipt.hash} (gas: ${receipt.gasUsed.toString()})`)
		}

		console.log(`\nAll ${transactions.length} transactions executed successfully.`)
	}
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
