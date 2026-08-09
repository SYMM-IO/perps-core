/**
 * Generate a Safe batch to whitelist one symbol type for all configured PartyBs.
 *
 * Use this when the Safe/protocolAdmin has PARTY_B_MANAGER_ROLE and the migration
 * runner does not. It reads PartyBs from partyBList-<network>.json and symbolType
 * from upgrade-<network>.json, then emits Safe Transaction Builder JSON.
 *
 * Usage:
 *   CHAIN_ID=8453 ./node_modules/.bin/hardhat run --no-compile scripts/upgrade/generateWhitelistSymbolTypesSafeBatch.ts --network base
 *
 * Optional env overrides:
 *   DIAMOND_ADDRESS, SAFE_ADDRESS, CHAIN_ID, SYMBOL_TYPE, WHITELIST_CONFIG_FILE
 *   SKIP_ALREADY_WHITELISTED=1 to query and skip PartyBs already whitelisted
 *
 * Output:
 *   scripts/upgrade/output/whitelist-symbol-types-safe-batch-<network>.json
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { baseNetworkName, loadUpgradeConfigShared, resolveConfigFile } from "./utils/sharedConfig.js"
import { toHumanReadableSafeTxFromIface, type SafeBatch } from "./utils/upgradeHelpers.js"

type PartyBListConfig = {
	partyBs?: Record<string, string[]>
}

const OUTPUT_DIR = "./scripts/upgrade/output"

function uniqueAddresses(addresses: string[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const address of addresses) {
		if (!ethers.isAddress(address) || address === ethers.ZeroAddress) {
			throw new Error(`Invalid PartyB address: ${address}`)
		}
		const normalized = ethers.getAddress(address)
		const key = normalized.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		out.push(normalized)
	}
	return out
}

async function resolveChainId(): Promise<string> {
	if (process.env.CHAIN_ID) return process.env.CHAIN_ID
	return String(Number((await ethers.provider.getNetwork()).chainId))
}

async function main() {
	const networkName = connection.networkName
	const networkSuffix = baseNetworkName(networkName)
	const shared = loadUpgradeConfigShared(networkSuffix)
	const configFile = resolveConfigFile("partyBList", networkSuffix, process.env.WHITELIST_CONFIG_FILE)

	const CHAIN_ID = await resolveChainId()
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	const SAFE_ADDRESS = process.env.SAFE_ADDRESS ?? shared.safeAddress
	const SYMBOL_TYPE = Number(process.env.SYMBOL_TYPE ?? shared.newV085Parameters?.symbolType ?? 1)
	const SKIP_ALREADY_WHITELISTED = process.env.SKIP_ALREADY_WHITELISTED === "1"

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("DIAMOND_ADDRESS is required (upgrade config or DIAMOND_ADDRESS env)")
	}
	if (!SAFE_ADDRESS || !ethers.isAddress(SAFE_ADDRESS)) {
		throw new Error("SAFE_ADDRESS is required (upgrade config or SAFE_ADDRESS env)")
	}
	if (!Number.isInteger(SYMBOL_TYPE) || SYMBOL_TYPE <= 0) {
		throw new Error(`Invalid SYMBOL_TYPE: ${SYMBOL_TYPE}`)
	}
	if (!fs.existsSync(configFile)) {
		throw new Error(`PartyB list config not found: ${configFile}`)
	}

	const rawConfig = JSON.parse(fs.readFileSync(configFile, "utf-8")) as PartyBListConfig
	const partyBs = uniqueAddresses(Object.values(rawConfig.partyBs ?? {}).flat())
	if (partyBs.length === 0) throw new Error(`No PartyBs found in ${configFile}`)

	const diamond = ethers.getAddress(DIAMOND_ADDRESS)
	const safe = ethers.getAddress(SAFE_ADDRESS)
	let targets = partyBs

	if (SKIP_ALREADY_WHITELISTED) {
		const view = await ethers.getContractAt(["function isWhitelistedSymbolType(address partyB, uint256 symbolType) view returns (bool)"], diamond)
		targets = []
		for (const partyB of partyBs) {
			const alreadyWhitelisted = await view.isWhitelistedSymbolType(partyB, BigInt(SYMBOL_TYPE))
			if (alreadyWhitelisted) {
				console.log(`  already whitelisted: ${partyB}`)
			} else {
				targets.push(partyB)
			}
		}
	}

	console.log(`Network:     ${networkName}`)
	console.log(`Chain ID:    ${CHAIN_ID}`)
	console.log(`Diamond:     ${diamond}`)
	console.log(`Safe:        ${safe}`)
	console.log(`Symbol type: ${SYMBOL_TYPE}`)
	console.log(`Config:      ${configFile}`)
	console.log(`PartyBs:     ${partyBs.length}`)
	console.log(`To include:  ${targets.length}`)
	console.log()

	if (targets.length === 0) {
		console.log("Nothing to whitelist - all configured PartyBs are already whitelisted.")
		return
	}

	const iface = new ethers.Interface(["function whitelistSymbolType(address partyB, uint256 symbolType)"])
	const safeTxs = targets.map(partyB => toHumanReadableSafeTxFromIface(iface, diamond, "whitelistSymbolType", [partyB, BigInt(SYMBOL_TYPE)]))

	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	const outFile = path.join(OUTPUT_DIR, `whitelist-symbol-types-safe-batch-${networkName}.json`)
	const batch: SafeBatch = {
		version: "1.0",
		chainId: CHAIN_ID,
		createdAt: Date.now(),
		meta: {
			name: "Symmio core - whitelist PartyB symbol types",
			description: `Whitelists symbolType=${SYMBOL_TYPE} for ${targets.length} PartyB(s) on Symmio Diamond ${diamond}`,
			txBuilderVersion: "1.18.0",
			createdFromSafeAddress: safe,
			createdFromOwnerAddress: "",
		},
		transactions: safeTxs,
	}
	fs.writeFileSync(outFile, JSON.stringify(batch, null, 2))

	console.log(`Wrote ${safeTxs.length} transaction(s) to: ${outFile}`)
	for (let i = 0; i < targets.length; i++) {
		console.log(`  ${i + 1}. whitelistSymbolType(${targets[i]}, ${SYMBOL_TYPE})`)
	}
	console.log()
	console.log(`Import ${path.basename(outFile)} into the Safe Transaction Builder and execute it from ${safe}.`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
