/**
 * Verify all deployed upgrade contracts on block explorer (Etherscan/Blockscout).
 *
 * Reads contract addresses dynamically from:
 *   - output/deployed-facets.json      (libraries + core facets)
 *   - output/deployed-peripherals.json (AccountLayer + InstantLayer + SymmioPartyB)
 *   - config/upgrade.json              (diamondAddress, protocolAdmin, signatureVerifierAddress)
 *
 * If deployed-facets.json has no library addresses, the script auto-detects them
 * from on-chain bytecode (same technique as verifyDeploy.ts).
 *
 * Uses `npx hardhat verify` CLI under the hood — the programmatic verifyContract()
 * API has a source-name resolution bug in Hardhat 3 that causes HHE100 for all
 * new verifications.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/verifyContracts.ts --network <network>
 *   SKIP=5 npx hardhat run scripts/upgrade/verifyContracts.ts --network <network>
 */
import { execSync } from "child_process"
import fs from "fs"
import path from "path"

// Import to initialize the hardhat connection (needed for auto-detect)
import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { log } from "./utils/log.js"
import { FacetLibraryDependencies } from "./utils/upgradeHelpers.js"

// ============================================================================
// Constants
// ============================================================================

const OUTPUT_DIR = "./scripts/upgrade/output"
const FACETS_FILE = path.join(OUTPUT_DIR, "deployed-facets.json")
const PERIPHERALS_FILE = path.join(OUTPUT_DIR, "deployed-peripherals.json")
const CONFIG_FILE = process.env.UPGRADE_CONFIG_FILE ?? "./scripts/upgrade/config/upgrade.json"

// Inter-library dependencies (mirrors deployLibraries() in upgradeHelpers.ts)
const CoreLibraryDependencies: Record<string, string[]> = {
	LibQuoteClose: ["LibQuoteFunding"],
	LibForceActions: ["LibQuoteClose"],
}

// Core facets needing --contract for CLI disambiguation
const CoreFacetContractPaths: Record<string, string> = {
	ControlFacet: "contracts/core/facets/Control/ControlFacet.sol:ControlFacet",
	ViewFacet: "contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet",
}

// AccountLayer facets needing --contract for CLI disambiguation
const AccountLayerFacetContractPaths: Record<string, string> = {
	CoreFacet: "contracts/accountLayer/facets/Core/CoreFacet.sol:CoreFacet",
	MarginFacet: "contracts/accountLayer/facets/Margin/MarginFacet.sol:MarginFacet",
	SymmioHookFacet: "contracts/accountLayer/facets/SymmioHook/SymmioHookFacet.sol:SymmioHookFacet",
	ControlFacet: "contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet",
	ViewFacet: "contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet",
	AffiliateFacet: "contracts/accountLayer/facets/Affiliate/AffiliateFacet.sol:AffiliateFacet",
}

// AccountLayer facets that need library linking
const AccountLayerFacetLibraryDependencies: Record<string, string[]> = {
	CoreFacet: ["LibQuoteParams"],
}

// Library source FQNs for --libraries-path (Hardhat 3 format: "source:name" → address)
const CoreLibrarySourcePaths: Record<string, string> = {
	LibQuoteFunding: "contracts/core/libraries/LibQuoteFunding.sol:LibQuoteFunding",
	LibQuoteClose: "contracts/core/libraries/LibQuoteClose.sol:LibQuoteClose",
	LibForceActions: "contracts/core/libraries/LibForceActions.sol:LibForceActions",
	LibSettlement: "contracts/core/libraries/LibSettlement.sol:LibSettlement",
}

const AccountLayerLibrarySourcePaths: Record<string, string> = {
	LibQuoteParams: "contracts/accountLayer/libraries/LibQuoteParams.sol:LibQuoteParams",
}

// ============================================================================
// Types
// ============================================================================

type DeployedFacets = {
	libraries: Record<string, string>
	facets: Record<string, { address: string; selectors: string[] }>
}

type DeployedPeripherals = {
	accountLayer: {
		diamondCutFacet: string
		diamond: string
		init: string
		libraries: Record<string, string>
		facets: Record<string, string>
	}
	instantLayer: { address: string }
	symmioPartyBImplementation: string
}

type UpgradeConfig = {
	diamondAddress?: string
	protocolAdmin?: string
	newV085Parameters?: {
		signatureVerifierAddress?: string
	}
}

type ContractToVerify = {
	name: string
	address: string
	constructorArgs: string[]
	libraries: Record<string, string> // FQN → address for --libraries-path
	contract?: string // --contract flag for CLI
}

// ============================================================================
// Helpers
// ============================================================================

function loadJSON<T>(filePath: string): T {
	if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
	return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T
}

function buildLibraryMap(deps: string[], addresses: Record<string, string>, sourcePaths: Record<string, string>): Record<string, string> {
	const map: Record<string, string> = {}
	for (const dep of deps) {
		const addr = addresses[dep]
		const fqn = sourcePaths[dep]
		if (addr && fqn) {
			map[fqn] = addr
		}
	}
	return map
}

// ============================================================================
// Library auto-detection (same technique as verifyDeploy.ts)
// ============================================================================

const FACET_DIR_MAP: Record<string, string> = {
	DiamondLoupeFacet: "diamond/facets/DiamondLoup",
}

function facetArtifactPath(facetName: string): string {
	if (FACET_DIR_MAP[facetName]) {
		return path.join("artifacts", "contracts", `${FACET_DIR_MAP[facetName]}/${facetName}.sol/${facetName}.json`)
	}
	const artifactsDir = path.join("artifacts", "contracts")
	const dirName = facetName.replace(/Facet$/, "")
	const primary = path.join(artifactsDir, `core/facets/${dirName}/${facetName}.sol/${facetName}.json`)
	if (fs.existsSync(primary)) return primary
	return path.join(artifactsDir, `core/facets/${facetName}/${facetName}.sol/${facetName}.json`)
}

async function detectLibraryAddresses(facetsData: DeployedFacets): Promise<Record<string, string>> {
	const detected: Record<string, string> = {}

	for (const [facetName, deps] of Object.entries(FacetLibraryDependencies)) {
		if (deps.every(d => detected[d])) continue

		const facetAddress = facetsData.facets[facetName]?.address
		if (!facetAddress) continue

		const artifactFile = facetArtifactPath(facetName)
		if (!fs.existsSync(artifactFile)) continue

		const artifact = JSON.parse(fs.readFileSync(artifactFile, "utf-8"))
		const compiledHex: string = (artifact.deployedBytecode || "").replace(/^0x/, "").toLowerCase()
		if (!compiledHex) continue

		const linkRefs: Record<string, Record<string, Array<{ length: number; start: number }>>> = artifact.linkReferences || {}
		const hashToLib: Record<string, string> = {}
		for (const [file, libs] of Object.entries(linkRefs)) {
			for (const libName of Object.keys(libs)) {
				const fqn = `${file}:${libName}`
				const hash = ethers.keccak256(ethers.toUtf8Bytes(fqn)).slice(2, 36)
				hashToLib[hash] = libName
			}
		}

		const placeholderRegex = /__\$([a-f0-9]{34})\$__/g
		const placeholders: Array<{ hash: string; offset: number }> = []
		let match
		while ((match = placeholderRegex.exec(compiledHex)) !== null) {
			placeholders.push({ hash: match[1], offset: match.index })
		}
		if (placeholders.length === 0) continue

		let deployedHex: string
		try {
			const code = await ethers.provider.getCode(facetAddress)
			deployedHex = code.replace(/^0x/, "").toLowerCase()
		} catch {
			continue
		}

		if (compiledHex.length !== deployedHex.length) continue

		const candidates: Record<string, string> = {}
		for (const p of placeholders) {
			const addrHex = deployedHex.slice(p.offset, p.offset + 40)
			if (candidates[p.hash] && candidates[p.hash] !== addrHex) break
			candidates[p.hash] = addrHex
		}

		let linked = compiledHex
		for (const [hash, addr] of Object.entries(candidates)) {
			linked = linked.replace(new RegExp(`__\\$${hash}\\$__`, "g"), addr)
		}

		if (linked !== deployedHex) continue

		for (const [hash, addrHex] of Object.entries(candidates)) {
			const libName = hashToLib[hash]
			if (libName && !detected[libName]) {
				detected[libName] = ethers.getAddress("0x" + addrHex)
				log.detail(`${libName}: ${detected[libName]} (from ${facetName})`)
			}
		}
	}

	return detected
}

// ============================================================================
// Contract list builder
// ============================================================================

function buildContractList(
	facetsData: DeployedFacets,
	libraries: Record<string, string>,
	peripheralsData: DeployedPeripherals | null,
	config: UpgradeConfig,
): ContractToVerify[] {
	const contracts: ContractToVerify[] = []

	// ── Core Libraries (ordered: deps first) ────────────────────────────
	const libOrder = ["LibQuoteFunding", "LibSettlement", "LibQuoteClose", "LibForceActions"]
	for (const name of libOrder) {
		const address = libraries[name]
		if (!address) continue
		const deps = CoreLibraryDependencies[name] ?? []
		contracts.push({
			name,
			address,
			constructorArgs: [],
			libraries: buildLibraryMap(deps, libraries, CoreLibrarySourcePaths),
		})
	}

	// ── Core Facets ─────────────────────────────────────────────────────
	for (const [name, info] of Object.entries(facetsData.facets)) {
		const deps = FacetLibraryDependencies[name] ?? []
		contracts.push({
			name,
			address: info.address,
			constructorArgs: [],
			libraries: buildLibraryMap(deps, libraries, CoreLibrarySourcePaths),
			contract: CoreFacetContractPaths[name],
		})
	}

	// ── MuonSignatureVerifier (constructor: admin) ─────────────────────
	const verifierAddress = config.newV085Parameters?.signatureVerifierAddress
	if (verifierAddress) {
		contracts.push({
			name: "MuonSignatureVerifier",
			address: verifierAddress,
			constructorArgs: [config.protocolAdmin!],
			libraries: {},
			contract: "contracts/helpers/verification/SymmioSignatureVerifier.sol:MuonSignatureVerifier",
		})
	}

	if (!peripheralsData) return contracts

	// ── AccountLayer DiamondCutFacet ────────────────────────────────────
	contracts.push({
		name: "AL DiamondCutFacet",
		address: peripheralsData.accountLayer.diamondCutFacet,
		constructorArgs: [],
		libraries: {},
	})

	// ── AccountLayer Diamond (constructor: owner, diamondCutFacet) ──────
	const owner = config.protocolAdmin
	if (!owner) throw new Error("protocolAdmin required in config for AccountLayer Diamond constructor args")
	contracts.push({
		name: "AL Diamond",
		address: peripheralsData.accountLayer.diamond,
		constructorArgs: [owner, peripheralsData.accountLayer.diamondCutFacet],
		libraries: {},
	})

	// ── AccountLayer Init ──────────────────────────────────────────────
	contracts.push({
		name: "AL Init",
		address: peripheralsData.accountLayer.init,
		constructorArgs: [],
		libraries: {},
		contract: "contracts/accountLayer/Init.sol:Init",
	})

	// ── AccountLayer Libraries ─────────────────────────────────────────
	for (const [name, address] of Object.entries(peripheralsData.accountLayer.libraries)) {
		contracts.push({
			name: `AL ${name}`,
			address,
			constructorArgs: [],
			libraries: {},
			contract: `contracts/accountLayer/libraries/${name}.sol:${name}`,
		})
	}

	// ── AccountLayer Facets ────────────────────────────────────────────
	for (const [name, address] of Object.entries(peripheralsData.accountLayer.facets)) {
		const deps = AccountLayerFacetLibraryDependencies[name] ?? []
		contracts.push({
			name: `AL ${name}`,
			address,
			constructorArgs: [],
			libraries: buildLibraryMap(deps, peripheralsData.accountLayer.libraries, AccountLayerLibrarySourcePaths),
			contract: AccountLayerFacetContractPaths[name],
		})
	}

	// ── InstantLayer (constructor: symmio, admin) ──────────────────────
	const diamond = config.diamondAddress
	if (!diamond) throw new Error("diamondAddress required in config for InstantLayer constructor args")
	contracts.push({
		name: "InstantLayer",
		address: peripheralsData.instantLayer.address,
		constructorArgs: [diamond, owner],
		libraries: {},
	})

	// ── SymmioPartyB implementation (no constructor args) ──────────────
	if (peripheralsData.symmioPartyBImplementation) {
		contracts.push({
			name: "SymmioPartyB",
			address: peripheralsData.symmioPartyBImplementation,
			constructorArgs: [],
			libraries: {},
		})
	}

	return contracts
}

// ============================================================================
// CLI verify runner
// ============================================================================

const LIBRARIES_TMP_FILE = path.join(OUTPUT_DIR, ".tmp-libraries.json")

function buildVerifyCommand(networkName: string, c: ContractToVerify): string {
	const parts = ["npx hardhat verify", `--network ${networkName}`]

	if (c.contract) {
		parts.push(`--contract ${c.contract}`)
	}

	if (Object.keys(c.libraries).length > 0) {
		fs.writeFileSync(LIBRARIES_TMP_FILE, JSON.stringify(c.libraries, null, 2))
		parts.push(`--libraries-path ${LIBRARIES_TMP_FILE}`)
	}

	parts.push(c.address)

	for (const arg of c.constructorArgs) {
		parts.push(`"${arg}"`)
	}

	return parts.join(" ")
}

function runVerify(networkName: string, c: ContractToVerify): "verified" | "already" | "failed" {
	const cmd = buildVerifyCommand(networkName, c)
	try {
		const output = execSync(cmd, {
			encoding: "utf-8",
			timeout: 120_000,
			env: { ...process.env, FORCE_COLOR: "0" },
			stdio: ["pipe", "pipe", "pipe"],
		})
		if (output.includes("already been verified")) {
			return "already"
		}
		return "verified"
	} catch (err: any) {
		const output = (err.stdout ?? "") + (err.stderr ?? "")
		if (output.includes("already been verified") || output.includes("Already Verified")) {
			return "already"
		}
		log.error(
			output
				.split("\n")
				.filter((l: string) => l.includes("HHE") || l.includes("Error"))
				.slice(0, 2)
				.join(" | ") || output.slice(0, 150),
		)
		return "failed"
	}
}

// ============================================================================
// Main
// ============================================================================

async function main() {
	const t = log.timer()
	log.header("Verify Deployed Contracts on Block Explorer")

	const networkName = connection.networkName
	if (!networkName) throw new Error("Could not determine network name. Make sure to pass --network <name>.")

	// Load deployed data
	const facetsData = loadJSON<DeployedFacets>(FACETS_FILE)

	// Resolve library addresses
	let libraries = facetsData.libraries ?? {}
	const envFile = process.env.LIBRARIES_FILE
	if (envFile) {
		libraries = loadJSON<Record<string, string>>(envFile)
		log.ok(`Loaded ${Object.keys(libraries).length} library addresses from ${envFile}`)
	}

	// Auto-detect missing library addresses from deployed bytecode
	const allRequiredLibs = new Set<string>()
	for (const deps of Object.values(FacetLibraryDependencies)) {
		for (const dep of deps) allRequiredLibs.add(dep)
	}
	const missingLibs = [...allRequiredLibs].filter(lib => !libraries[lib])
	if (missingLibs.length > 0) {
		log.info(`Detecting ${missingLibs.length} missing library addresses from on-chain bytecode...`)
		const detected = await detectLibraryAddresses(facetsData)
		libraries = { ...libraries, ...detected }
		const stillMissing = missingLibs.filter(lib => !libraries[lib])
		if (stillMissing.length > 0) {
			log.warn(`Could not detect: ${stillMissing.join(", ")}`)
		}
	}

	log.ok(`Loaded ${Object.keys(facetsData.facets).length} facets + ${Object.keys(libraries).length} libraries`)

	let peripheralsData: DeployedPeripherals | null = null
	if (fs.existsSync(PERIPHERALS_FILE)) {
		peripheralsData = loadJSON<DeployedPeripherals>(PERIPHERALS_FILE)
		log.ok(`Loaded peripherals from deployed-peripherals.json`)
	} else {
		log.warn("deployed-peripherals.json not found — skipping peripheral verification")
	}

	// Load config
	let config: UpgradeConfig = {}
	if (fs.existsSync(CONFIG_FILE)) {
		config = loadJSON<UpgradeConfig>(CONFIG_FILE)
	} else if (peripheralsData) {
		throw new Error(`Config file not found: ${CONFIG_FILE} (required for peripheral constructor args)`)
	}

	// Build contract list
	let contracts = buildContractList(facetsData, libraries, peripheralsData, config)
	log.info(`Total contracts to verify: ${contracts.length}`)

	// Skip support
	const skip = parseInt(process.env.SKIP ?? "0", 10)
	if (skip > 0) {
		log.info(`Skipping first ${skip} contracts`)
		contracts = contracts.slice(skip)
	}
	log.blank()

	// Verify each contract via CLI
	let verified = 0
	let alreadyVerified = 0
	let failed = 0

	for (let i = 0; i < contracts.length; i++) {
		const c = contracts[i]
		const idx = skip + i + 1
		const libCount = Object.keys(c.libraries).length
		const libInfo = libCount > 0 ? ` (${libCount} libs)` : ""
		log.info(`[${idx}/${skip + contracts.length}] ${c.name} at ${c.address}${libInfo}`)

		const result = runVerify(networkName, c)
		switch (result) {
			case "verified":
				verified++
				log.ok("Verified")
				break
			case "already":
				alreadyVerified++
				log.detail("Already verified")
				break
			case "failed":
				failed++
				break
		}
	}

	// Cleanup temp file
	if (fs.existsSync(LIBRARIES_TMP_FILE)) fs.unlinkSync(LIBRARIES_TMP_FILE)

	// Summary
	const entries: Array<[string, string]> = [
		["Verified", String(verified)],
		["Already verified", String(alreadyVerified)],
	]
	if (failed > 0) entries.push(["Failed", String(failed)])
	entries.push(["Duration", t.fmt()])

	if (failed > 0) {
		log.failure("Verification completed with failures", `${failed} contract(s) failed`)
		log.info(`To resume: SKIP=${skip + verified + alreadyVerified} npx hardhat run scripts/upgrade/verifyContracts.ts --network <network>`)
	} else {
		log.success("All contracts verified", entries)
	}
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
