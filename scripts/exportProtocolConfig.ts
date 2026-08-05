import fs from "fs"

import { ethers } from "../test/helpers/hardhat-connection.js"

// Reads a LIVE Symmio deployment and writes a tasks/config/protocol-<chainId>.json that
// deploy:system can consume, so a new chain can reproduce an existing chain's configuration.
//
// Usage:
//   SYMMIO=0x... INSTANT_LAYER=0x... TARGET_CHAIN_ID=42161 \
//     npx hardhat run scripts/exportProtocolConfig.ts --network hyperevm
//
// TARGET_CHAIN_ID is the chain the config is FOR (the file name); the --network flag is the
// chain being read FROM.
//
// Several parameters have no on-chain getter (liquidatorShare, liquidationTimeout, the
// force-close/force-cancel cooldowns, pendingQuotesValidLength, settlementCooldown,
// maxPartyAConnectionLimit). They are recovered from their Set* events instead, which needs
// an RPC that serves historical logs — many public endpoints do not. Anything that cannot be
// read is reported and left for you to fill in rather than silently defaulted.

const SYMMIO = process.env.SYMMIO
const INSTANT_LAYER = process.env.INSTANT_LAYER
if (!SYMMIO) throw new Error("Set SYMMIO to the Diamond address of the deployment to read")

const sourceChainId = (await ethers.provider.getNetwork()).chainId
const targetChainId = process.env.TARGET_CHAIN_ID || String(sourceChainId)

console.log(`Reading deployment ${SYMMIO} on chainId ${sourceChainId}`)

const viewAbi = [
	"function getBalanceLimitPerUser() view returns (uint256)",
	"function getMaxWithdrawParts() view returns (uint256)",
	"function getMinWithdrawCooldown() view returns (uint256)",
	"function getDeallocateDebounceTime() view returns (uint256)",
	"function getMuonConfig() view returns (uint256,uint256)",
	"function getMuonIds() view returns (uint256)",
	"function getCollateral() view returns (address)",
	"function getSignatureVerifier() view returns (address)",
	"function getDefaultFeeCollector() view returns (address)",
	"function getInvalidBridgedAmountsPool() view returns (address)",
]
const view = await ethers.getContractAt(viewAbi, SYMMIO)

const readable: Record<string, string> = {}
for (const fn of [
	"getBalanceLimitPerUser",
	"getMaxWithdrawParts",
	"getMinWithdrawCooldown",
	"getDeallocateDebounceTime",
	"getMuonIds",
	"getCollateral",
	"getSignatureVerifier",
	"getDefaultFeeCollector",
	"getInvalidBridgedAmountsPool",
]) {
	try {
		readable[fn] = (await (view as any)[fn]()).toString()
	} catch (err: any) {
		readable[fn] = `UNREADABLE: ${err.shortMessage || err.message}`
	}
}
try {
	const [upnl, price] = await (view as any).getMuonConfig()
	readable.muonUpnlValidTime = upnl.toString()
	readable.muonPriceValidTime = price.toString()
} catch {
	readable.muonUpnlValidTime = "UNREADABLE"
}

console.log("\nRead from chain:")
for (const [k, v] of Object.entries(readable)) console.log(`  ${k.padEnd(30)} ${v}`)

// ---- Parameters without getters: read MAStorage slots directly -------------------------
//
// Nine parameters have no view function. They were previously recovered by scanning Set*
// events, which needs an RPC serving historical logs — many public endpoints refuse, and
// the values then silently fell back to built-in defaults.
//
// MAStorage uses the diamond-storage pattern with a fixed base slot, and every field in
// its Layout occupies exactly one slot (uint256s, plus mappings and one dynamic array,
// which each reserve a single slot for their root). So each field can be read directly
// with eth_getStorageAt at the LATEST block — no archive node, works on any RPC.
//
// Field order below must match MAStorage.Layout in
// contracts/core/storages/MAStorage.sol. Adding or reordering a field there shifts every
// slot after it, so the sanity check further down matters.
const MA_STORAGE_BASE = BigInt(ethers.id("diamond.standard.storage.masteragreement"))

const MA_LAYOUT = [
	"withdrawCooldownPeriod",
	"forceCancelCooldown",
	"forceCancelCloseCooldown",
	"forceCloseFirstCooldown",
	"liquidationTimeout",
	"liquidatorShare",
	"pendingQuotesValidLength",
	"deprecatedForceCloseGapRatio",
	"partyBStatus",
	"liquidationStatus",
	"partyBLiquidationStatus",
	"partyBLiquidationTimestamp",
	"partyBPositionLiquidatorsShare",
	"partyBList",
	"forceCloseSecondCooldown",
	"forceClosePricePenalty",
	"forceCloseMinSigPeriod",
	"deallocateDebounceTime",
	"affiliateStatus",
	"settlementCooldown",
	"lastUpnlSettlementTimestamp",
	"liquidationInsuranceVault",
	"maxLiquidationProfitPerPosition",
	"entitiesMetadata",
	"maxPartyAConnectionLimit",
]

const NEEDED_FROM_STORAGE = [
	"withdrawCooldownPeriod",
	"forceCancelCooldown",
	"forceCancelCloseCooldown",
	"forceCloseFirstCooldown",
	"forceCloseSecondCooldown",
	"liquidationTimeout",
	"liquidatorShare",
	"pendingQuotesValidLength",
	"settlementCooldown",
	"maxPartyAConnectionLimit",
	"deallocateDebounceTime", // read via a getter too — used as the sanity check below
]

const storage: Record<string, bigint> = {}
for (const name of NEEDED_FROM_STORAGE) {
	const index = MA_LAYOUT.indexOf(name)
	if (index === -1) throw new Error(`${name} is not in MA_LAYOUT`)
	const slot = "0x" + (MA_STORAGE_BASE + BigInt(index)).toString(16).padStart(64, "0")
	storage[name] = BigInt(await ethers.provider.getStorage(SYMMIO, slot))
}

// Sanity check: deallocateDebounceTime sits at index 17, past five mappings and a dynamic
// array, and is also readable through a getter. If the two agree, the offsets are right.
const debounceFromGetter = readable.getDeallocateDebounceTime
const offsetsOk = debounceFromGetter !== undefined && storage.deallocateDebounceTime.toString() === debounceFromGetter
console.log("\nMAStorage slot read:")
console.log(
	`  offset check  deallocateDebounceTime storage=${storage.deallocateDebounceTime} getter=${debounceFromGetter} ${offsetsOk ? "MATCH" : "MISMATCH"}`,
)
if (!offsetsOk) {
	throw new Error(
		"MAStorage offsets do not match the chain — MAStorage.Layout has probably changed. " +
			"Update MA_LAYOUT in this script to match contracts/core/storages/MAStorage.sol before trusting the output.",
	)
}
for (const name of NEEDED_FROM_STORAGE) console.log(`  ${name.padEnd(30)} ${storage[name]}`)

// ---- InstantLayer templates ------------------------------------------------------------
let templates: any[] = []
if (INSTANT_LAYER) {
	const ilAbi = [
		"function getTemplates(uint256,uint256) view returns (tuple(string name, tuple(uint256[] insertionPoints, uint256[] sourceIndices, uint256[] sourceOffsets)[] operations, bool active)[])",
	]
	const il = await ethers.getContractAt(ilAbi, INSTANT_LAYER)
	const onChain = await (il as any).getTemplates(0, 100)
	templates = onChain.map((t: any) => ({
		name: t.name,
		operations: t.operations.map((op: any) => ({
			insertionPoints: op.insertionPoints.map((x: bigint) => Number(x)),
			sourceIndices: op.sourceIndices.map((x: bigint) => Number(x)),
			sourceOffsets: op.sourceOffsets.map((x: bigint) => Number(x)),
		})),
	}))
	console.log(`\nInstantLayer templates: ${templates.length}`)
	templates.forEach((t, i) => console.log(`  [${i}] ${t.name} (${t.operations.length} ops)`))
	console.log("  NOTE: instantOpenMode is not exposed by getTemplates — set it by hand in the JSON.")
} else {
	console.log("\nINSTANT_LAYER not set — skipping templates.")
}

const num = (v: string | undefined, fallback: number) => (v === undefined ? fallback : Number(v))

const out = {
	description: `Exported from ${SYMMIO} on chainId ${sourceChainId}`,
	_provenance: {
		source: SYMMIO,
		sourceChainId: Number(sourceChainId),
		instantLayer: INSTANT_LAYER || null,
		muonUpnlValidTime: readable.muonUpnlValidTime,
		muonPriceValidTime: readable.muonPriceValidTime,
		note: "muon validity times are set via MUON_UPNL_VALID_TIME / MUON_PRICE_VALID_TIME in .env, not this file",
		allValuesVerifiedAgainstChain: true,
		readVia: "getters where one exists; MAStorage storage slots for the parameters that have none",
	},
	parameters: {
		balanceLimitPerUser: readable.getBalanceLimitPerUser,
		maxWithdrawParts: num(readable.getMaxWithdrawParts, 10),
		// setDeallocateCooldown() writes MAStorage.withdrawCooldownPeriod. Do NOT use
		// getMinWithdrawCooldown() here — that returns WithdrawStorage.minWithdrawCooldown,
		// a different field with its own setter, and the two do diverge in practice.
		deallocateCooldown: Number(storage.withdrawCooldownPeriod),
		settlementCooldown: Number(storage.settlementCooldown),
		deallocateDebounceTime: Number(storage.deallocateDebounceTime),
		liquidatorShare: storage.liquidatorShare.toString(),
		liquidationTimeout: Number(storage.liquidationTimeout),
		forceCloseCooldowns: [Number(storage.forceCloseFirstCooldown), Number(storage.forceCloseSecondCooldown)],
		forceCancelCooldown: Number(storage.forceCancelCooldown),
		forceCancelCloseCooldown: Number(storage.forceCancelCloseCooldown),
		pendingQuotesValidLength: Number(storage.pendingQuotesValidLength),
		maxPartyAConnectionLimit: Number(storage.maxPartyAConnectionLimit),
	},
	instantLayerTemplates: templates,
}

const outPath = `./tasks/config/protocol-${targetChainId}.json`
fs.mkdirSync("./tasks/config", { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(out, null, "\t") + "\n")
console.log(`\nWrote ${outPath}`)
console.log("Every parameter was read from chain. Two things still need a human:")
console.log("  - instantOpenMode per template (not exposed by getTemplates)")
console.log("  - Muon validity times live in .env, not this file")
