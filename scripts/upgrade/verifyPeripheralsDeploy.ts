/**
 * Bytecode verification: deployed peripherals vs local compiled artifacts.
 *
 * Fetches on-chain bytecode for each peripheral contract address in
 * deployed-peripherals.json and compares against locally compiled Hardhat
 * artifacts. Handles Solidity library linking and immutable variable masking.
 *
 * Usage:
 *   RPC_URL=https://rpc.mantle.xyz npx ts-node scripts/upgrade/verifyPeripheralsDeploy.ts
 *
 * Env overrides:
 *   RPC_URL          -- RPC endpoint (required)
 *   PERIPHERALS_FILE -- path to deployed-peripherals.json (default: output/deployed-peripherals.json)
 */
import { ethers } from "ethers"
import fs from "fs"
import path from "path"

const OUTPUT_DIR = "./scripts/upgrade/output"

// --- Config ---
const rpcUrl = process.env.RPC_URL
if (!rpcUrl) {
	console.error("RPC_URL env var is required")
	console.error("Usage: RPC_URL=https://rpc.mantle.xyz npx ts-node scripts/upgrade/verifyPeripheralsDeploy.ts")
	process.exit(1)
}

const peripheralsFile = process.env.PERIPHERALS_FILE ?? path.join(OUTPUT_DIR, "deployed-peripherals.json")
const upgradeConfigFile = process.env.UPGRADE_CONFIG_FILE ?? "./scripts/upgrade/config/upgrade.json"

if (!fs.existsSync(peripheralsFile)) {
	console.error(`Missing deployed-peripherals.json at ${peripheralsFile}`)
	process.exit(1)
}

const provider = new ethers.JsonRpcProvider(rpcUrl)

interface ContractInfo {
	name: string
	path: string
}

interface Placeholder {
	hash: string
	offset: number
}

interface LibInfo {
	file: string
	libName: string
	fqn: string
	offsets: Array<{ length: number; start: number }>
}

interface LinkResult {
	match: boolean
	reason?: string
	libs?: Record<string, { address: string; name: string }>
	linked?: string
	deployed?: string
}

interface ImmutableRef {
	length: number
	start: number
}

interface DeployedPeripherals {
	accountLayer: {
		diamondCutFacet: string
		diamond: string
		init: string
		libraries: Record<string, string>
		facets: Record<string, string>
		diamondCutComplete: boolean
	}
	instantLayer: {
		address: string
	}
	symmioPartyBImplementation: string
}

// --- Load deployed addresses and build contract map ---
const deployed: DeployedPeripherals = JSON.parse(fs.readFileSync(peripheralsFile, "utf8"))

const CONTRACTS: Record<string, ContractInfo> = {}

// AccountLayer facets
for (const [name, address] of Object.entries(deployed.accountLayer.facets)) {
	if (name === "DiamondLoupeFacet") {
		CONTRACTS[address] = { name: `AL:${name}`, path: "diamond/facets/DiamondLoup/DiamondLoupeFacet.sol/DiamondLoupeFacet.json" }
	} else {
		CONTRACTS[address] = { name: `AL:${name}`, path: `accountLayer/facets/${name.replace("Facet", "")}/${name}.sol/${name}.json` }
	}
}

// AccountLayer DiamondCutFacet
CONTRACTS[deployed.accountLayer.diamondCutFacet] = {
	name: "AL:DiamondCutFacet",
	path: "diamond/facets/DiamondCut/DiamondCutFacet.sol/DiamondCutFacet.json",
}

// AccountLayer Init
CONTRACTS[deployed.accountLayer.init] = {
	name: "AL:Init",
	path: "accountLayer/Init.sol/Init.json",
}

// InstantLayer
CONTRACTS[deployed.instantLayer.address] = {
	name: "InstantLayer",
	path: "instantLayer/InstantLayer.sol/InstantLayer.json",
}

// MuonSignatureVerifier (address from upgrade.json)
if (fs.existsSync(upgradeConfigFile)) {
	const upgradeConfig = JSON.parse(fs.readFileSync(upgradeConfigFile, "utf8"))
	const sigVerifierAddr = upgradeConfig?.newV085Parameters?.signatureVerifierAddress
	if (sigVerifierAddr) {
		CONTRACTS[sigVerifierAddr] = {
			name: "MuonSignatureVerifier",
			path: "helpers/verification/SymmioSignatureVerifier.sol/MuonSignatureVerifier.json",
		}
	}
}

// SymmioPartyB implementation
CONTRACTS[deployed.symmioPartyBImplementation] = {
	name: "SymmioPartyB",
	path: "helpers/accounts/SymmioPartyB.sol/SymmioPartyB.json",
}

function extractLibraryPlaceholders(artifact: any): { placeholders: Placeholder[]; hashToLib: Record<string, LibInfo> } {
	const compiled: string = artifact.deployedBytecode || ""
	const hex = compiled.startsWith("0x") ? compiled.slice(2) : compiled
	const placeholders: Placeholder[] = []
	const regex = /__\$([a-f0-9]{34})\$__/g
	let match
	while ((match = regex.exec(hex)) !== null) {
		placeholders.push({ hash: match[1], offset: match.index })
	}

	const hashToLib: Record<string, LibInfo> = {}
	const linkRefs: Record<string, Record<string, Array<{ length: number; start: number }>>> = artifact.linkReferences || {}
	for (const [file, libs] of Object.entries(linkRefs)) {
		for (const [libName, offsets] of Object.entries(libs)) {
			const fqn = `${file}:${libName}`
			const hash = ethers.keccak256(ethers.toUtf8Bytes(fqn)).slice(2, 36)
			hashToLib[hash] = { file, libName, fqn, offsets }
		}
	}

	return { placeholders, hashToLib }
}

function maskImmutables(
	compiledHex: string,
	deployedHex: string,
	immutableRefs: Record<string, ImmutableRef[]>,
): { maskedCompiled: string; maskedDeployed: string; extractedValues: Record<string, string> } {
	let maskedCompiled = compiledHex
	let maskedDeployed = deployedHex
	const extractedValues: Record<string, string> = {}

	for (const [id, refs] of Object.entries(immutableRefs)) {
		for (const ref of refs) {
			const hexStart = ref.start * 2
			const hexLen = ref.length * 2
			const deployedValue = deployedHex.slice(hexStart, hexStart + hexLen)
			const zeros = "0".repeat(hexLen)

			if (!extractedValues[id]) extractedValues[id] = deployedValue

			maskedCompiled = maskedCompiled.slice(0, hexStart) + zeros + maskedCompiled.slice(hexStart + hexLen)
			maskedDeployed = maskedDeployed.slice(0, hexStart) + zeros + maskedDeployed.slice(hexStart + hexLen)
		}
	}

	return { maskedCompiled, maskedDeployed, extractedValues }
}

function linkAndCompare(compiledHex: string, deployedHex: string, placeholders: Placeholder[], hashToLib: Record<string, LibInfo>): LinkResult {
	if (compiledHex.length !== deployedHex.length) {
		return { match: false, reason: `Size mismatch: compiled=${compiledHex.length / 2} deployed=${deployedHex.length / 2}` }
	}

	const libAddresses: Record<string, string> = {}
	let linked = compiledHex

	for (const p of placeholders) {
		const addrFromDeployed = deployedHex.slice(p.offset, p.offset + 40)
		if (libAddresses[p.hash] && libAddresses[p.hash] !== addrFromDeployed) {
			return { match: false, reason: `Library ${p.hash} has inconsistent addresses: ${libAddresses[p.hash]} vs ${addrFromDeployed}` }
		}
		libAddresses[p.hash] = addrFromDeployed
	}

	for (const [hash, addr] of Object.entries(libAddresses)) {
		const placeholder = `__\\$${hash}\\$__`
		linked = linked.replace(new RegExp(placeholder, "g"), addr)
	}

	if (linked === deployedHex) {
		const libs: Record<string, { address: string; name: string }> = {}
		for (const [hash, addr] of Object.entries(libAddresses)) {
			const info = hashToLib[hash]
			libs[hash] = {
				address: "0x" + addr,
				name: info ? info.fqn : `unknown(${hash})`,
			}
		}
		return { match: true, libs }
	}

	let divergeAt = -1
	for (let i = 0; i < linked.length; i++) {
		if (linked[i] !== deployedHex[i]) {
			divergeAt = i
			break
		}
	}

	return {
		match: false,
		reason: `Bytecode differs at hex offset ${divergeAt} (byte ${Math.floor(divergeAt / 2)}) after library linking`,
		linked: linked.slice(Math.max(0, divergeAt - 20), divergeAt + 40),
		deployed: deployedHex.slice(Math.max(0, divergeAt - 20), divergeAt + 40),
	}
}

async function main() {
	console.log("=".repeat(100))
	console.log("PERIPHERAL BYTECODE VERIFICATION: Deployed vs Compiled (local) — with library linking")
	console.log(`RPC:         ${rpcUrl}`)
	console.log(`Peripherals: ${peripheralsFile}`)
	console.log("=".repeat(100))
	console.log()

	const artifactsDir = path.join("artifacts", "contracts")
	const addresses = Object.keys(CONTRACTS)

	console.log(`Fetching deployed bytecodes for ${addresses.length} peripheral addresses...`)
	const deployedCodes: Record<string, string> = {}
	const batchSize = 5
	for (let i = 0; i < addresses.length; i += batchSize) {
		const batch = addresses.slice(i, i + batchSize)
		const results = await Promise.all(batch.map(async addr => ({ addr, code: await provider.getCode(addr) })))
		for (const r of results) deployedCodes[r.addr] = r.code
		process.stdout.write(`  Fetched ${Math.min(i + batchSize, addresses.length)}/${addresses.length}\r`)
	}
	console.log("\n")

	let exactMatch = 0,
		linkedMatch = 0,
		mismatch = 0,
		errors = 0
	const allLibs: Record<string, string> = {}

	for (const [address, info] of Object.entries(CONTRACTS)) {
		const artifactPath = path.join(artifactsDir, info.path)
		if (!fs.existsSync(artifactPath)) {
			console.log(`❌ ${info.name.padEnd(30)} | Artifact not found: ${info.path}`)
			errors++
			continue
		}

		const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"))
		const compiledBytecode: string = artifact.deployedBytecode
		if (!compiledBytecode || compiledBytecode === "0x") {
			console.log(`❌ ${info.name.padEnd(30)} | No deployedBytecode in artifact`)
			errors++
			continue
		}

		const deployedCode = deployedCodes[address]
		if (!deployedCode || deployedCode === "0x") {
			console.log(`❌ ${info.name.padEnd(30)} | No code at ${address}`)
			errors++
			continue
		}

		let compiledHex = (compiledBytecode.startsWith("0x") ? compiledBytecode.slice(2) : compiledBytecode).toLowerCase()
		let deployedHex = (deployedCode.startsWith("0x") ? deployedCode.slice(2) : deployedCode).toLowerCase()

		// Mask immutable references if present
		const immutableRefs: Record<string, ImmutableRef[]> = artifact.immutableReferences || {}
		const hasImmutables = Object.keys(immutableRefs).length > 0
		let immutableInfo: Record<string, string> | null = null
		if (hasImmutables) {
			const masked = maskImmutables(compiledHex, deployedHex, immutableRefs)
			compiledHex = masked.maskedCompiled
			deployedHex = masked.maskedDeployed
			immutableInfo = masked.extractedValues
		}

		const immutableCount = hasImmutables ? Object.keys(immutableRefs).length : 0
		const immutableTag = hasImmutables ? ` + ${immutableCount} immutable(s) masked` : ""

		if (compiledHex === deployedHex) {
			console.log(`✅ ${info.name.padEnd(30)} | EXACT MATCH (${deployedHex.length / 2} bytes${immutableTag})`)
			if (immutableInfo) {
				const vals = Object.entries(immutableInfo)
					.map(([id, val]) => `  id=${id} => 0x${val.replace(/^0+/, "") || "0"}`)
					.join(", ")
				console.log(`   Immutables: ${vals}`)
			}
			exactMatch++
			continue
		}

		const { placeholders, hashToLib } = extractLibraryPlaceholders(artifact)

		if (placeholders.length === 0) {
			const minLen = Math.min(compiledHex.length, deployedHex.length)
			let divergeAt = -1
			for (let i = 0; i < minLen; i++) {
				if (compiledHex[i] !== deployedHex[i]) {
					divergeAt = i
					break
				}
			}
			if (divergeAt === -1) divergeAt = minLen
			console.log(`❌ ${info.name.padEnd(30)} | MISMATCH (no libraries, genuine difference${immutableTag})`)
			console.log(`   Sizes: deployed=${deployedHex.length / 2} compiled=${compiledHex.length / 2}`)
			console.log(`   First diff at byte ${Math.floor(divergeAt / 2)}`)
			mismatch++
			continue
		}

		const result = linkAndCompare(compiledHex, deployedHex, placeholders, hashToLib)

		if (result.match) {
			const libNames = Object.values(result.libs!)
				.map(l => `${l.name.split(":").pop()} @ ${l.address}`)
				.join(", ")
			console.log(
				`✅ ${info.name.padEnd(30)} | MATCH after linking ${placeholders.length} library refs (${deployedHex.length / 2} bytes${immutableTag})`,
			)
			console.log(`   Libraries: ${libNames}`)
			if (immutableInfo) {
				const vals = Object.entries(immutableInfo)
					.map(([id, val]) => `  id=${id} => 0x${val.replace(/^0+/, "") || "0"}`)
					.join(", ")
				console.log(`   Immutables: ${vals}`)
			}
			for (const [hash, lib] of Object.entries(result.libs!)) {
				const shortName = lib.name.split(":").pop()!
				if (allLibs[shortName] && allLibs[shortName] !== lib.address) {
					console.log(`   ⚠️  ${shortName} address inconsistency: ${allLibs[shortName]} vs ${lib.address}`)
				}
				allLibs[shortName] = lib.address
			}
			linkedMatch++
		} else {
			console.log(`❌ ${info.name.padEnd(30)} | MISMATCH after linking`)
			console.log(`   ${result.reason}`)
			if (result.linked) {
				console.log(`   Linked:   ...${result.linked}...`)
				console.log(`   Deployed: ...${result.deployed}...`)
			}
			mismatch++
		}
	}

	console.log()
	console.log("=".repeat(100))
	console.log("SUMMARY")
	console.log("=".repeat(100))
	console.log(`  Exact match:         ${exactMatch}`)
	console.log(`  Match after linking: ${linkedMatch}`)
	console.log(`  Mismatch:            ${mismatch}`)
	console.log(`  Errors:              ${errors}`)
	console.log(`  Total:               ${addresses.length}`)
	console.log()

	if (Object.keys(allLibs).length > 0) {
		console.log("LINKED LIBRARIES (deployed addresses):")
		for (const [name, addr] of Object.entries(allLibs)) {
			console.log(`  ${name.padEnd(30)} => ${addr}`)
		}
		console.log()
	}

	if (mismatch === 0 && errors === 0) {
		console.log("✅ ALL deployed peripherals match the compiled source code.")
	} else {
		if (mismatch > 0) console.log(`⚠️  ${mismatch} contract(s) have bytecode mismatches that need investigation.`)
		if (errors > 0) console.log(`⚠️  ${errors} contract(s) had errors (missing artifacts/code).`)
	}
}

main().catch(console.error)
