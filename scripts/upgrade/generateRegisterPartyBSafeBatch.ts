/**
 * Generate a Safe multisig batch that registers PartyB addresses on the Symmio
 * core Diamond (ControlFacet.registerPartyB) and, optionally, on the peripheral
 * InstantLayer (InstantLayer.registerPartyBs).
 *
 * Use after the v0.8.5 upgrade has been applied, so the new PartyBs can be
 * registered on both the core and InstantLayer from a single Safe batch.
 *
 * Config files (resolved via resolveConfigFile):
 *   scripts/upgrade/config/partyBList-<network>.json    -- PartyB list grouped by label
 *   scripts/upgrade/config/upgrade-<network>.json       -- diamondAddress, safeAddress, instantLayerAddress
 *
 * partyBList config shape:
 *   {
 *     "partyBs": {
 *       "PerpsHub": ["0x...", "0x..."],
 *       "Carbon":   ["0x..."]
 *     },
 *     "registerOnSymmioCore":   true,  // default true — register on core Diamond
 *     "registerOnInstantLayer": true   // default true — register on InstantLayer
 *   }
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/generateRegisterPartyBSafeBatch.ts --network base
 *
 * Optional env overrides:
 *   DIAMOND_ADDRESS, SAFE_ADDRESS, INSTANT_LAYER_ADDRESS, CHAIN_ID,
 *   PARTYB_LIST_FILE (absolute path, skips resolveConfigFile lookup),
 *   REGISTER_ON_SYMMIO_CORE=1|0 (overrides config),
 *   REGISTER_ON_INSTANT_LAYER=1|0 (overrides config),
 *   CHECK_ON_CHAIN=0 to skip reading current registration state (default: on)
 *
 * Output: scripts/upgrade/output/register-partybs-safe-batch-<network>.json
 *
 * Required roles on the executing Safe:
 *   - PARTY_B_MANAGER_ROLE on the Diamond (for registerPartyB)
 *   - SETTER_ROLE on the InstantLayer  (for registerPartyBs)
 * The script prints a warning if the Safe is missing either role.
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { baseNetworkName, loadUpgradeConfigShared, resolveConfigFile } from "./utils/sharedConfig.js"
import { toHumanReadableSafeTxFromIface, type SafeBatch, type SafeTransaction } from "./utils/upgradeHelpers.js"

type PartyBListConfig = {
	partyBs?: Record<string, string[]>
	registerOnSymmioCore?: boolean
	registerOnInstantLayer?: boolean
}

const OUTPUT_DIR = "./scripts/upgrade/output"

const diamondIface = new ethers.Interface(["function registerPartyB(address partyB)"])

const instantLayerIface = new ethers.Interface([
	"function registerPartyBs(address[] partyBs)",
	"function registeredPartyBs(address) view returns (bool)",
	"function hasRole(bytes32 role, address account) view returns (bool)",
])

// Diamond uses a non-standard AccessControl signature on ViewFacet:
//   hasRole(address user, bytes32 role)  — arg order inverted vs OpenZeppelin.
const viewFacetIface = new ethers.Interface([
	"function isPartyB(address user) view returns (bool)",
	"function hasRole(address user, bytes32 role) view returns (bool)",
])

function loadPartyBListConfig(networkSuffix: string | undefined): { file: string; config: PartyBListConfig } {
	const file = resolveConfigFile("partyBList", networkSuffix, process.env.PARTYB_LIST_FILE)
	if (!fs.existsSync(file)) {
		throw new Error(`PartyB list config not found: ${file}`)
	}
	const config = JSON.parse(fs.readFileSync(file, "utf-8")) as PartyBListConfig
	return { file, config }
}

function resolveInstantLayerAddress(networkName: string, shared: { instantLayerAddress?: string }): string | undefined {
	if (process.env.INSTANT_LAYER_ADDRESS) return process.env.INSTANT_LAYER_ADDRESS
	if (shared.instantLayerAddress) return shared.instantLayerAddress

	const peripheralsFile = path.join(OUTPUT_DIR, `deployed-peripherals-${networkName}.json`)
	if (fs.existsSync(peripheralsFile)) {
		try {
			const peripherals = JSON.parse(fs.readFileSync(peripheralsFile, "utf-8"))
			if (peripherals.instantLayer?.address) return peripherals.instantLayer.address
		} catch {
			/* fall through */
		}
	}

	const alilFile = path.join(OUTPUT_DIR, "deployed-accountlayer-instantlayer.json")
	if (fs.existsSync(alilFile)) {
		try {
			const alil = JSON.parse(fs.readFileSync(alilFile, "utf-8"))
			if (alil.instantLayer?.address) return alil.instantLayer.address
		} catch {
			/* fall through */
		}
	}
	return undefined
}

function flattenPartyBs(grouped: Record<string, string[]> | undefined): { address: string; label: string }[] {
	if (!grouped) return []
	const entries: { address: string; label: string }[] = []
	const seen = new Set<string>()
	for (const [label, addresses] of Object.entries(grouped)) {
		for (const raw of addresses) {
			if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) {
				throw new Error(`Invalid PartyB address ${JSON.stringify(raw)} under "${label}"`)
			}
			const addr = ethers.getAddress(raw)
			if (seen.has(addr)) continue
			seen.add(addr)
			entries.push({ address: addr, label })
		}
	}
	return entries
}

async function main() {
	const networkName = connection.networkName
	const networkSuffix = baseNetworkName(networkName)
	const shared = loadUpgradeConfigShared(networkSuffix)

	const { file: listFile, config: listConfig } = loadPartyBListConfig(networkSuffix)

	const CHAIN_ID = process.env.CHAIN_ID ?? String(Number((await ethers.provider.getNetwork()).chainId))
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	const SAFE_ADDRESS = process.env.SAFE_ADDRESS ?? shared.safeAddress
	const IL_ADDRESS = resolveInstantLayerAddress(networkName, shared)

	const registerOnCore = process.env.REGISTER_ON_SYMMIO_CORE
		? process.env.REGISTER_ON_SYMMIO_CORE === "1"
		: (listConfig.registerOnSymmioCore ?? true)
	const registerOnIL = process.env.REGISTER_ON_INSTANT_LAYER
		? process.env.REGISTER_ON_INSTANT_LAYER === "1"
		: (listConfig.registerOnInstantLayer ?? false)

	const CHECK_ON_CHAIN = process.env.CHECK_ON_CHAIN !== "0"

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("diamondAddress is required (upgrade config or DIAMOND_ADDRESS env)")
	}
	if (!SAFE_ADDRESS || !ethers.isAddress(SAFE_ADDRESS)) {
		throw new Error("safeAddress is required (upgrade config or SAFE_ADDRESS env)")
	}
	if (registerOnIL && (!IL_ADDRESS || !ethers.isAddress(IL_ADDRESS))) {
		throw new Error(
			"instantLayerAddress is required when registerOnInstantLayer=true (upgrade config, deployed-peripherals-*.json, or INSTANT_LAYER_ADDRESS env)",
		)
	}
	if (!registerOnCore && !registerOnIL) {
		throw new Error("Both registerOnSymmioCore and registerOnInstantLayer are false — nothing to do.")
	}

	const diamond = ethers.getAddress(DIAMOND_ADDRESS)
	const safe = ethers.getAddress(SAFE_ADDRESS)
	const il = IL_ADDRESS ? ethers.getAddress(IL_ADDRESS) : undefined

	const partyBs = flattenPartyBs(listConfig.partyBs)
	if (partyBs.length === 0) throw new Error(`No PartyBs in ${listFile}`)

	console.log(`Network:          ${networkName}`)
	console.log(`Chain ID:         ${CHAIN_ID}`)
	console.log(`Diamond:          ${diamond}`)
	console.log(`InstantLayer:     ${il ?? "(not used)"}`)
	console.log(`Safe:             ${safe}`)
	console.log(`PartyB list:      ${listFile}`)
	console.log(`PartyBs:          ${partyBs.length}`)
	console.log(`Register on Core: ${registerOnCore}`)
	console.log(`Register on IL:   ${registerOnIL}`)
	console.log(`Check on-chain:   ${CHECK_ON_CHAIN}`)
	console.log()

	let registerOnDiamond = registerOnCore ? partyBs : []
	let registerOnInstantLayer = registerOnIL ? partyBs : []

	if (CHECK_ON_CHAIN) {
		if (registerOnCore) {
			const viewFacet = new ethers.Contract(diamond, viewFacetIface, ethers.provider)
			const diamondNew: typeof partyBs = []
			const diamondStates: { pb: (typeof partyBs)[number]; registered: boolean }[] = []
			for (const pb of partyBs) {
				const isReg: boolean = await viewFacet.isPartyB(pb.address)
				diamondStates.push({ pb, registered: isReg })
				if (!isReg) diamondNew.push(pb)
			}
			registerOnDiamond = diamondNew

			console.log("Diamond registration state:")
			for (const { pb, registered } of diamondStates) {
				const mark = registered ? "⏭ already registered" : "＋ will register"
				console.log(`  ${mark.padEnd(22)} ${pb.address} (${pb.label})`)
			}
		}

		if (registerOnIL && il) {
			const ilContract = new ethers.Contract(il, instantLayerIface, ethers.provider)
			const ilNew: typeof partyBs = []
			const ilStates: { pb: (typeof partyBs)[number]; registered: boolean }[] = []
			for (const pb of partyBs) {
				const isReg: boolean = await ilContract.registeredPartyBs(pb.address)
				ilStates.push({ pb, registered: isReg })
				if (!isReg) ilNew.push(pb)
			}
			registerOnInstantLayer = ilNew

			console.log(registerOnCore ? "\nInstantLayer registration state:" : "InstantLayer registration state:")
			for (const { pb, registered } of ilStates) {
				const mark = registered ? "⏭ already registered" : "＋ will register"
				console.log(`  ${mark.padEnd(22)} ${pb.address} (${pb.label})`)
			}
		}
		console.log()

		// Role preflight — warn (not fail) so users can still generate a batch
		// for review even if the Safe doesn't yet hold the required roles.
		if (registerOnCore && registerOnDiamond.length > 0) {
			const viewFacetCtl = new ethers.Contract(diamond, viewFacetIface, ethers.provider)
			const hasPartyBManager: boolean = await viewFacetCtl.hasRole(safe, ethers.id("PARTY_B_MANAGER_ROLE"))
			if (!hasPartyBManager) {
				console.log(`  ⚠ Safe ${safe} does NOT hold PARTY_B_MANAGER_ROLE on Diamond — grant it before executing this batch.`)
			}
		}
		if (registerOnIL && il && registerOnInstantLayer.length > 0) {
			const ilContract = new ethers.Contract(il, instantLayerIface, ethers.provider)
			const hasSetter: boolean = await ilContract.hasRole(ethers.id("SETTER_ROLE"), safe)
			if (!hasSetter) {
				console.log(`  ⚠ Safe ${safe} does NOT hold SETTER_ROLE on InstantLayer — grant it before executing this batch.`)
			}
		}
	}

	const safeTxs: SafeTransaction[] = []
	const lines: string[] = []

	// 1. One registerPartyB(address) per PartyB on the Diamond. ControlFacet has
	//    no batch variant, so we emit one tx per address.
	for (const pb of registerOnDiamond) {
		safeTxs.push(toHumanReadableSafeTxFromIface(diamondIface, diamond, "registerPartyB", [pb.address]))
		lines.push(`Diamond.registerPartyB(${pb.address})  // ${pb.label}`)
	}

	// 2. InstantLayer.registerPartyBs(address[]) — single call for the whole set.
	if (registerOnIL && il && registerOnInstantLayer.length > 0) {
		const addresses = registerOnInstantLayer.map(p => p.address)
		safeTxs.push(toHumanReadableSafeTxFromIface(instantLayerIface, il, "registerPartyBs", [addresses]))
		lines.push(`InstantLayer.registerPartyBs([${registerOnInstantLayer.length} addresses])`)
	}

	if (safeTxs.length === 0) {
		console.log("\nNothing to do — every PartyB is already registered where required.")
		return
	}

	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	const outFile = path.join(OUTPUT_DIR, `register-partybs-safe-batch-${networkName}.json`)

	const batch: SafeBatch = {
		version: "1.0",
		chainId: CHAIN_ID,
		createdAt: Date.now(),
		meta: {
			name: "Register PartyBs — Diamond + InstantLayer",
			description:
				`Registers ${registerOnDiamond.length} PartyB(s) on Diamond ${diamond}` +
				(registerOnIL && il && registerOnInstantLayer.length > 0 ? ` and ${registerOnInstantLayer.length} on InstantLayer ${il}` : ""),
			txBuilderVersion: "1.18.0",
			createdFromSafeAddress: safe,
			createdFromOwnerAddress: "",
		},
		transactions: safeTxs,
	}
	fs.writeFileSync(outFile, JSON.stringify(batch, null, 2))

	console.log(`\nWrote ${safeTxs.length} transaction(s) to: ${outFile}`)
	for (let i = 0; i < lines.length; i++) console.log(`  ${i + 1}. ${lines[i]}`)
	console.log(`\nImport this file into the Safe Transaction Builder and execute from ${safe}.`)
}

main().catch(err => {
	console.error(err)
	process.exitCode = 1
})
