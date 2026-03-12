import fs from "fs"
import path from "path"

import { ethers } from "../../test/helpers/hardhat-connection.js"
import { deployFacets, buildDiamondCut, type FacetInfo } from "./utils/upgradeHelpers.js"

/**
 * Generate a Safe Transaction Builder JSON batch for the v0.8.5 upgrade.
 *
 * Deploys facets (or loads pre-deployed addresses), builds the diamondCut
 * against the live diamond, then outputs a batch JSON that the multisig
 * imports into Safe Transaction Builder.
 *
 * Usage:
 *   # Deploy facets + generate batch (on target network)
 *   DIAMOND_ADDRESS=0x... SAFE_ADDRESS=0x... npx hardhat run scripts/upgrade/generateSafeBatch.ts --network arbitrum
 *
 *   # Load pre-deployed facets (skip deployment)
 *   DIAMOND_ADDRESS=0x... SAFE_ADDRESS=0x... FACETS_FILE=./scripts/upgrade/output/deployed-facets.json \
 *     npx hardhat run scripts/upgrade/generateSafeBatch.ts --network arbitrum
 *
 *   # Different migration runner than Safe
 *   DIAMOND_ADDRESS=0x... SAFE_ADDRESS=0x... MIGRATION_RUNNER=0x... \
 *     npx hardhat run scripts/upgrade/generateSafeBatch.ts --network arbitrum
 *
 * Config: scripts/upgrade/config/upgrade.json (diamondAddress, safeAddress, migrationRunner, diamondCutChunkSize, newV085Parameters)
 *
 * Output:
 *   scripts/upgrade/output/safe-batch.json          — Safe Transaction Builder JSON
 *   scripts/upgrade/output/deployed-facets.json     — Deployed addresses (if deploying)
 *   scripts/upgrade/output/safe-batch-details.json  — Selector changes + transaction breakdown
 */

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
	safeAddress?: string
	migrationRunner?: string
	diamondCutChunkSize?: number
	newV085Parameters?: {
		maxPartyAConnectionLimit?: number
		settlementCooldown?: number
		deallocateDebounceTime?: number
	}
}

type DeployedFacets = {
	facets: Record<string, FacetInfo>
	selectorSignatures: Record<string, string>
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

// --- Transaction builders ---

function grantRoleTx(diamond: string, user: string, roleName: string): SafeTransaction {
	return {
		to: diamond,
		value: "0",
		data: null,
		contractMethod: {
			inputs: [
				{ internalType: "address", name: "user", type: "address" },
				{ internalType: "bytes32", name: "role", type: "bytes32" },
			],
			name: "grantRole",
			payable: false,
		},
		contractInputsValues: {
			user,
			role: ethers.id(roleName),
		},
	}
}

function setAdminTx(diamond: string, admin: string): SafeTransaction {
	return {
		to: diamond,
		value: "0",
		data: null,
		contractMethod: {
			inputs: [{ internalType: "address", name: "user", type: "address" }],
			name: "setAdmin",
			payable: false,
		},
		contractInputsValues: { user: admin },
	}
}

function pauseGlobalTx(diamond: string): SafeTransaction {
	return {
		to: diamond,
		value: "0",
		data: null,
		contractMethod: {
			inputs: [],
			name: "pauseGlobal",
			payable: false,
		},
		contractInputsValues: {},
	}
}

function diamondCutTx(diamond: string, chunk: any[]): SafeTransaction {
	// Format as [facetAddress, action, [selectors]] tuples for Safe TX Builder decoding
	const cutArray = chunk.map((cut: any) => [cut.facetAddress, cut.action, cut.functionSelectors])

	return {
		to: diamond,
		value: "0",
		data: null,
		contractMethod: {
			inputs: [
				{
					internalType: "struct IDiamondCut.FacetCut[]",
					name: "_diamondCut",
					type: "tuple[]",
					components: [
						{ internalType: "address", name: "facetAddress", type: "address" },
						{ internalType: "enum IDiamondCut.FacetCutAction", name: "action", type: "uint8" },
						{ internalType: "bytes4[]", name: "functionSelectors", type: "bytes4[]" },
					],
				},
				{ internalType: "address", name: "_init", type: "address" },
				{ internalType: "bytes", name: "_calldata", type: "bytes" },
			],
			name: "diamondCut",
			payable: false,
		},
		contractInputsValues: {
			_diamondCut: JSON.stringify(cutArray),
			_init: ethers.ZeroAddress,
			_calldata: "0x",
		},
	}
}

function setParamTx(diamond: string, funcName: string, paramName: string, value: number): SafeTransaction {
	return {
		to: diamond,
		value: "0",
		data: null,
		contractMethod: {
			inputs: [{ internalType: "uint256", name: paramName, type: "uint256" }],
			name: funcName,
			payable: false,
		},
		contractInputsValues: { [paramName]: value.toString() },
	}
}

async function main() {
	const config = loadConfig()

	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
	const SAFE_ADDRESS = process.env.SAFE_ADDRESS ?? config.safeAddress
	const MIGRATION_RUNNER = process.env.MIGRATION_RUNNER ?? config.migrationRunner ?? SAFE_ADDRESS
	const FACETS_FILE = process.env.FACETS_FILE
	const CHAIN_ID = process.env.CHAIN_ID ?? String(Number((await ethers.provider.getNetwork()).chainId))
	const DIAMOND_CUT_CHUNK_SIZE = Number(process.env.DIAMOND_CUT_CHUNK_SIZE ?? config.diamondCutChunkSize ?? 6)
	const newParams = config.newV085Parameters ?? {}

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("DIAMOND_ADDRESS is required (env var or config file)")
	}
	if (!SAFE_ADDRESS || !ethers.isAddress(SAFE_ADDRESS)) {
		throw new Error("SAFE_ADDRESS is required (env var)")
	}
	if (!MIGRATION_RUNNER || !ethers.isAddress(MIGRATION_RUNNER)) {
		throw new Error("MIGRATION_RUNNER must be a valid address")
	}

	console.log(`Diamond:          ${DIAMOND_ADDRESS}`)
	console.log(`Safe:             ${SAFE_ADDRESS}`)
	console.log(`Migration runner: ${MIGRATION_RUNNER}`)
	console.log(`Chain ID:         ${CHAIN_ID}`)
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

	// Step 3: Build Safe batch transactions
	console.log("Building Safe batch...")
	const transactions: SafeTransaction[] = []
	const breakdown: string[] = []
	let txIdx = 1

	// Phase 1: Pre-upgrade admin setup + pause
	transactions.push(setAdminTx(DIAMOND_ADDRESS, SAFE_ADDRESS))
	breakdown.push(`${txIdx++}. setAdmin(${SAFE_ADDRESS})`)

	transactions.push(grantRoleTx(DIAMOND_ADDRESS, SAFE_ADDRESS, "PAUSER_ROLE"))
	breakdown.push(`${txIdx++}. grantRole(PAUSER_ROLE) -> ${SAFE_ADDRESS}`)

	transactions.push(grantRoleTx(DIAMOND_ADDRESS, SAFE_ADDRESS, "UNPAUSER_ROLE"))
	breakdown.push(`${txIdx++}. grantRole(UNPAUSER_ROLE) -> ${SAFE_ADDRESS}`)

	transactions.push(pauseGlobalTx(DIAMOND_ADDRESS))
	breakdown.push(`${txIdx++}. pauseGlobal()`)

	// Phase 2: Diamond cut (chunked)
	for (let i = 0; i < chunks.length; i++) {
		transactions.push(diamondCutTx(DIAMOND_ADDRESS, chunks[i]))
		const selectorCount = chunks[i].reduce((sum: number, cut: any) => sum + cut.functionSelectors.length, 0)
		breakdown.push(`${txIdx++}. diamondCut chunk ${i + 1}/${chunks.length} (${chunks[i].length} cuts, ${selectorCount} selectors)`)
	}

	// Phase 3: Post-upgrade parameter config
	transactions.push(grantRoleTx(DIAMOND_ADDRESS, SAFE_ADDRESS, "PROTOCOL_CONFIG_ROLE"))
	breakdown.push(`${txIdx++}. grantRole(PROTOCOL_CONFIG_ROLE) -> ${SAFE_ADDRESS}`)

	transactions.push(grantRoleTx(DIAMOND_ADDRESS, SAFE_ADDRESS, "COOLDOWN_ADMIN_ROLE"))
	breakdown.push(`${txIdx++}. grantRole(COOLDOWN_ADMIN_ROLE) -> ${SAFE_ADDRESS}`)

	if (newParams.maxPartyAConnectionLimit && newParams.maxPartyAConnectionLimit > 0) {
		transactions.push(setParamTx(DIAMOND_ADDRESS, "setMaxPartyAConnectionLimit", "maxLimit", newParams.maxPartyAConnectionLimit))
		breakdown.push(`${txIdx++}. setMaxPartyAConnectionLimit(${newParams.maxPartyAConnectionLimit})`)
	}
	if (newParams.settlementCooldown !== undefined && newParams.settlementCooldown > 0) {
		transactions.push(setParamTx(DIAMOND_ADDRESS, "setSettlementCooldown", "settlementCooldown", newParams.settlementCooldown))
		breakdown.push(`${txIdx++}. setSettlementCooldown(${newParams.settlementCooldown})`)
	}
	if (newParams.deallocateDebounceTime !== undefined && newParams.deallocateDebounceTime > 0) {
		transactions.push(setParamTx(DIAMOND_ADDRESS, "setDeallocateDebounceTime", "deallocateDebounceTime", newParams.deallocateDebounceTime))
		breakdown.push(`${txIdx++}. setDeallocateDebounceTime(${newParams.deallocateDebounceTime})`)
	}

	// Phase 4: Migration role grant
	transactions.push(grantRoleTx(DIAMOND_ADDRESS, MIGRATION_RUNNER, "MIGRATION_ROLE"))
	breakdown.push(`${txIdx++}. grantRole(MIGRATION_ROLE) -> ${MIGRATION_RUNNER}`)

	// Step 4: Write Safe batch JSON
	ensureDir(OUTPUT_DIR)
	const batchFile = path.join(OUTPUT_DIR, "safe-batch.json")
	const batch: SafeBatch = {
		version: "1.0",
		chainId: CHAIN_ID,
		createdAt: Date.now(),
		meta: {
			name: "Symmio v0.8.5 Upgrade",
			description: "Generated by scripts/generateSafeBatch.ts",
			txBuilderVersion: "1.18.0",
			createdFromSafeAddress: SAFE_ADDRESS,
			createdFromOwnerAddress: "",
		},
		transactions,
	}
	fs.writeFileSync(batchFile, JSON.stringify(batch, null, 2))

	// Write details file (selector changes + breakdown)
	const detailsFile = path.join(OUTPUT_DIR, "safe-batch-details.json")
	fs.writeFileSync(
		detailsFile,
		JSON.stringify(
			{
				diamondAddress: DIAMOND_ADDRESS,
				safeAddress: SAFE_ADDRESS,
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

	console.log(`\nSafe batch: ${batchFile}`)
	console.log(`Details:    ${detailsFile}`)
	console.log(`\nTransaction breakdown (${transactions.length} total):`)
	for (const line of breakdown) {
		console.log(`  ${line}`)
	}
	console.log("\nImport safe-batch.json into Safe Transaction Builder to review and execute.")
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
