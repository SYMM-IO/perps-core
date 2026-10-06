/**
 * Direct Etherscan V2 API verification for contracts that failed hardhat-verify.
 *
 * With via-ir, bytecode depends on the number of files in the compilation unit.
 * This script keeps real source for the import chain and stubs all other files
 * to preserve file count while shrinking the payload from ~1.6MB to ~50-300KB.
 *
 * Usage:
 *   npx tsx scripts/verify-etherscan-api.ts --api-key KEY [--only Diamond] [--dry-run]
 */
import { ethers } from "ethers"
import fs from "fs"

// ── Config ─────────────────────────────────────────────────────────────────────

const API_URL = "https://api.etherscan.io/v2/api"
const CHAIN_ID = "999" // HyperEVM
const COMPILER_VERSION = "v0.8.18+commit.87f61d96"
const BUILD_INFO_FILE = "artifacts/build-info/solc-0_8_18-d19af9e7da2739279ac4d00030e8de97f950c50f.json"
const POLL_INTERVAL_MS = 10_000
const MAX_POLL_ATTEMPTS = 60

const STUB = "// SPDX-License-Identifier: MIT\npragma solidity >=0.8.18;\n"

interface ContractEntry {
	name: string
	sourcePath: string
	contractId: string
	address: string
	constructorArgs: string[]
	libraries?: Record<string, string> // "path:Name" -> address
}

const CONTRACTS: ContractEntry[] = [
	{
		name: "DiamondCutFacet (core)",
		sourcePath: "project/contracts/diamond/facets/DiamondCut/DiamondCutFacet.sol",
		contractId: "DiamondCutFacet",
		address: "0xe9d7B5e7208Cdac06A40A23b15818124a31c77Bd",
		constructorArgs: [],
	},
	{
		name: "Diamond (core)",
		sourcePath: "project/contracts/diamond/Diamond.sol",
		contractId: "Diamond",
		address: "0x5733105334c03B3DdDA0b5AF2bD129E06DB58E32",
		constructorArgs: ["0xf12239317e985f6772F86407608B166EfA3E2f05", "0xe9d7B5e7208Cdac06A40A23b15818124a31c77Bd"],
	},
	{
		name: "LibForceActions",
		sourcePath: "project/contracts/core/libraries/LibForceActions.sol",
		contractId: "LibForceActions",
		address: "0x9f7a08BaE11Fc3F92a423a2227523491B9345951",
		constructorArgs: [],
		libraries: {
			"project/contracts/core/libraries/LibQuoteClose.sol:LibQuoteClose": "0xc23BFC52100f7E81c08a063Dca04369978E3F935",
		},
	},
	{
		name: "PartyBPositionActionsFacet",
		sourcePath: "project/contracts/core/facets/PartyBPositionActions/PartyBPositionActionsFacet.sol",
		contractId: "PartyBPositionActionsFacet",
		address: "0x603F5dB5585778AB9ec26Da7743DA33aFa1E0453",
		constructorArgs: [],
		libraries: {
			"project/contracts/core/libraries/LibQuoteClose.sol:LibQuoteClose": "0xc23BFC52100f7E81c08a063Dca04369978E3F935",
			"project/contracts/core/libraries/LibQuoteFunding.sol:LibQuoteFunding": "0xEcD1D9dC751316831D893B1ab3Ef0d36392b20dB",
		},
	},
	{
		name: "PartyBBatchActionsFacet",
		sourcePath: "project/contracts/core/facets/PartyBBatchActions/PartyBBatchActionsFacet.sol",
		contractId: "PartyBBatchActionsFacet",
		address: "0x4339F007daD2C3160a5F1873b6C34a02093D8ae6",
		constructorArgs: [],
		libraries: {
			"project/contracts/core/libraries/LibQuoteClose.sol:LibQuoteClose": "0xc23BFC52100f7E81c08a063Dca04369978E3F935",
			"project/contracts/core/libraries/LibQuoteFunding.sol:LibQuoteFunding": "0xEcD1D9dC751316831D893B1ab3Ef0d36392b20dB",
		},
	},
	{
		name: "DiamondCutFacet (account layer)",
		sourcePath: "project/contracts/diamond/facets/DiamondCut/DiamondCutFacet.sol",
		contractId: "DiamondCutFacet",
		address: "0x8A8126818125E64cC329E21591790dB8938FC514",
		constructorArgs: [],
	},
	{
		name: "Diamond (account layer)",
		sourcePath: "project/contracts/diamond/Diamond.sol",
		contractId: "Diamond",
		address: "0x340B34a537EC5AfD39cD41A17525Ae9b2Fb4873a",
		constructorArgs: ["0xf12239317e985f6772F86407608B166EfA3E2f05", "0x8A8126818125E64cC329E21591790dB8938FC514"],
	},
]

// ── Import tracer ──────────────────────────────────────────────────────────────

type Sources = Record<string, { content: string }>

function parseImports(content: string): string[] {
	const imports: string[] = []
	const re = /import\s+(?:{[^}]*}\s+from\s+)?["']([^"']+)["']/g
	let m
	while ((m = re.exec(content)) !== null) imports.push(m[1])
	return imports
}

function resolveImport(imp: string, from: string, remappings: string[], allPaths: Set<string>): string | null {
	for (const remap of remappings) {
		const eq = remap.indexOf("=")
		if (eq < 0) continue
		const prefix = remap.slice(0, eq)
		const target = remap.slice(eq + 1)
		const colon = prefix.indexOf(":")
		const match = colon >= 0 ? prefix.slice(colon + 1) : prefix
		if (imp.startsWith(match)) {
			const resolved = target + imp.slice(match.length)
			if (allPaths.has(resolved)) return resolved
		}
	}
	if (allPaths.has(imp)) return imp
	const dir = from.slice(0, from.lastIndexOf("/"))
	const parts = `${dir}/${imp}`.split("/")
	const norm: string[] = []
	for (const p of parts) {
		if (p === "..") norm.pop()
		else if (p !== ".") norm.push(p)
	}
	const rel = norm.join("/")
	if (allPaths.has(rel)) return rel
	return null
}

function traceImports(root: string, sources: Sources, remappings: string[]): Set<string> {
	const allPaths = new Set(Object.keys(sources))
	const visited = new Set<string>()
	const queue = [root]
	while (queue.length > 0) {
		const cur = queue.pop()!
		if (visited.has(cur)) continue
		visited.add(cur)
		const src = sources[cur]
		if (!src) continue
		for (const imp of parseImports(src.content)) {
			const r = resolveImport(imp, cur, remappings, allPaths)
			if (r && !visited.has(r)) queue.push(r)
		}
	}
	return visited
}

/**
 * Build a stubbed standard-json-input: real content for the import chain,
 * one-line stubs for everything else. Same file count as original build.
 */
function buildStubbedInput(entry: ContractEntry, buildInput: { language: string; sources: Sources; settings: any }): string {
	const remappings: string[] = [...new Set(buildInput.settings.remappings as string[])]
	const needed = traceImports(entry.sourcePath, buildInput.sources, remappings)

	const sources: Sources = {}
	let stubIdx = 0
	for (const path of Object.keys(buildInput.sources)) {
		if (needed.has(path)) {
			sources[path] = { content: buildInput.sources[path].content }
		} else {
			// Each stub defines a unique dummy contract so the via-ir optimizer
			// sees the same total contract count as the original full build
			sources[path] = { content: `pragma solidity >=0.8.18; contract S${stubIdx++} {}` }
		}
	}

	// Convert libraries from "path:Name" -> addr to standard-json format
	const libraries: Record<string, Record<string, string>> = {}
	if (entry.libraries) {
		for (const [qualifiedName, addr] of Object.entries(entry.libraries)) {
			const [filePath, libName] = qualifiedName.split(":")
			if (!libraries[filePath]) libraries[filePath] = {}
			libraries[filePath][libName] = addr
		}
	}

	return JSON.stringify({
		language: buildInput.language,
		sources,
		settings: {
			...buildInput.settings,
			remappings,
			libraries,
			outputSelection: {
				[entry.sourcePath]: {
					[entry.contractId]: ["abi", "evm.bytecode", "evm.deployedBytecode"],
				},
			},
		},
	})
}

// ── API ────────────────────────────────────────────────────────────────────────

function encodeConstructorArgs(args: string[]): string {
	if (args.length === 0) return ""
	const coder = ethers.AbiCoder.defaultAbiCoder()
	const types = args.map(() => "address")
	return coder.encode(types, args).slice(2)
}

async function submitVerification(sourceCode: string, entry: ContractEntry, apiKey: string): Promise<string | null> {
	const body = new URLSearchParams({
		module: "contract",
		action: "verifysourcecode",
		apikey: apiKey,
		contractaddress: entry.address,
		sourceCode,
		codeformat: "solidity-standard-json-input",
		contractname: `${entry.sourcePath}:${entry.contractId}`,
		compilerversion: COMPILER_VERSION,
		constructorArguements: encodeConstructorArgs(entry.constructorArgs),
	})

	// Libraries are passed inside the standard-json-input settings, not as API params

	const res = await fetch(`${API_URL}?chainid=${CHAIN_ID}`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	})

	const json = await res.json()
	if (json.status === "1") return json.result
	console.error(`  Submit failed: ${json.result || json.message}`)
	return null
}

async function checkStatus(guid: string, apiKey: string): Promise<{ done: boolean; success: boolean; message: string }> {
	const url = `${API_URL}?chainid=${CHAIN_ID}&module=contract&action=checkverifystatus&guid=${guid}&apikey=${apiKey}`
	const res = await fetch(url)
	const json = await res.json()
	if (json.result === "Pending in queue") return { done: false, success: false, message: "Pending" }
	if (json.result === "Pass - Verified") return { done: true, success: true, message: "Verified!" }
	if (json.result === "Already Verified") return { done: true, success: true, message: "Already verified" }
	return { done: true, success: false, message: json.result || json.message }
}

async function pollStatus(guid: string, apiKey: string): Promise<boolean> {
	for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
		await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
		try {
			const status = await checkStatus(guid, apiKey)
			if (status.done) {
				console.log(status.success ? ` ✓ ${status.message}` : ` ✗ ${status.message}`)
				return status.success
			}
			process.stdout.write(".")
		} catch {
			process.stdout.write("!")
		}
	}
	console.log(` ✗ Timed out`)
	return false
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
	const args = process.argv.slice(2)
	const dryRun = args.includes("--dry-run")
	const apiKeyIdx = args.indexOf("--api-key")
	const apiKey = apiKeyIdx >= 0 ? args[apiKeyIdx + 1] : process.env.ETHERSCAN_APIKEY || ""
	const onlyIdx = args.indexOf("--only")
	const onlyFilter = onlyIdx >= 0 ? args[onlyIdx + 1] : ""

	if (!apiKey) {
		console.error("API key required. Use --api-key KEY or set ETHERSCAN_APIKEY env var.")
		process.exit(1)
	}

	console.log("=".repeat(70))
	console.log("ETHERSCAN V2 API — STUBBED STANDARD-JSON-INPUT VERIFICATION")
	console.log("=".repeat(70))
	console.log(`API:      ${API_URL}?chainid=${CHAIN_ID}`)
	console.log(`Compiler: ${COMPILER_VERSION}`)
	console.log(`API Key:  ${apiKey.slice(0, 8)}...`)
	if (dryRun) console.log(`Mode:     DRY RUN`)
	console.log()

	console.log("Loading build info...")
	const buildInfo = JSON.parse(fs.readFileSync(BUILD_INFO_FILE, "utf8"))
	const totalFiles = Object.keys(buildInfo.input.sources).length
	console.log(`Build: ${totalFiles} source files`)
	console.log()

	let contracts = CONTRACTS
	if (onlyFilter) {
		contracts = contracts.filter(c => c.name.toLowerCase().includes(onlyFilter.toLowerCase()))
		console.log(`Filtered to ${contracts.length} contract(s) matching "${onlyFilter}"`)
		console.log()
	}

	let verified = 0
	let failed = 0

	for (const entry of contracts) {
		console.log(`[${entry.name}]`)
		console.log(`  Address:  ${entry.address}`)
		console.log(`  Contract: ${entry.sourcePath}:${entry.contractId}`)

		if (entry.constructorArgs.length > 0) {
			console.log(`  Args:     0x${encodeConstructorArgs(entry.constructorArgs)}`)
		}

		const sourceCode = buildStubbedInput(entry, buildInfo.input)
		console.log(`  Payload:  ${(sourceCode.length / 1024).toFixed(0)} KB (real imports + ${totalFiles} file stubs)`)

		if (dryRun) {
			console.log("  (dry run)")
			console.log()
			continue
		}

		console.log("  Submitting...")
		const guid = await submitVerification(sourceCode, entry, apiKey)
		if (!guid) {
			failed++
			console.log()
			continue
		}

		console.log(`  GUID: ${guid}`)
		process.stdout.write("  Polling")
		const success = await pollStatus(guid, apiKey)
		if (success) verified++
		else failed++
		console.log()
	}

	console.log("=".repeat(70))
	console.log(`Done. Verified: ${verified}, Failed: ${failed}`)
	console.log("=".repeat(70))
}

main().catch(err => {
	console.error(err)
	process.exit(1)
})
