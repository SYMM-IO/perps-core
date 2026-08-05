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

// ---- Parameters without getters: recover from Set* events -----------------------------
const eventAbis = [
	"event SetSettlementCooldown(uint256 o,uint256 n)",
	"event SetLiquidatorShare(uint256 o,uint256 n)",
	"event SetLiquidationTimeout(uint256 o,uint256 n)",
	"event SetForceCloseCooldowns(uint256 o1,uint256 n1,uint256 o2,uint256 n2)",
	"event SetForceCancelCooldown(uint256 o,uint256 n)",
	"event SetForceCancelCloseCooldown(uint256 o,uint256 n)",
	"event SetPendingQuotesValidLength(uint256 o,uint256 n)",
	"event SetMaxPartyAConnectionLimit(uint256 v)",
]
const iface = new ethers.Interface(eventAbis)
const eventNames = eventAbis.map(e => e.match(/event (\w+)/)![1])
const recovered: Record<string, string[]> = {}

const latestBlock = await ethers.provider.getBlockNumber()
const chunk = Number(process.env.LOG_CHUNK || 45000)
const maxScan = Number(process.env.LOG_MAX_SCAN || 5_000_000)

console.log(`\nScanning back up to ${maxScan} blocks for setter events (chunk ${chunk})...`)
let to = latestBlock
let scanned = 0
let logsWorked = false

while (to > 0 && scanned < maxScan && Object.keys(recovered).length < eventNames.length) {
	const from = Math.max(0, to - chunk + 1)
	try {
		const logs = await ethers.provider.getLogs({
			address: SYMMIO,
			fromBlock: from,
			toBlock: to,
			topics: [eventNames.map(n => iface.getEvent(n)!.topicHash)],
		})
		logsWorked = true
		for (const log of logs) {
			const parsed = iface.parseLog({ topics: [...log.topics], data: log.data })
			if (!parsed || recovered[parsed.name]) continue // newest wins; we scan newest-first
			recovered[parsed.name] = parsed.args.map((a: any) => a.toString())
		}
	} catch {
		// endpoint refused this range — keep going, report at the end
	}
	to = from - 1
	scanned += chunk
}

if (!logsWorked) {
	console.log("  ⚠ This RPC served no historical logs. Re-run against an archive endpoint to recover these.")
}
console.log("\nRecovered from events:")
for (const n of eventNames) {
	console.log(`  ${n.padEnd(32)} ${recovered[n] ? JSON.stringify(recovered[n]) : "NOT FOUND — keeping default"}`)
}

/** Setter events emit (old, new); the current value is the last element. */
const latestValue = (name: string): string | undefined => {
	const v = recovered[name]
	return v ? v[v.length - 1] : undefined
}

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
		parametersNotRecovered: eventNames.filter(n => !recovered[n]),
	},
	parameters: {
		balanceLimitPerUser: readable.getBalanceLimitPerUser,
		maxWithdrawParts: num(readable.getMaxWithdrawParts, 10),
		deallocateCooldown: num(readable.getMinWithdrawCooldown, 120),
		settlementCooldown: num(latestValue("SetSettlementCooldown"), 300),
		deallocateDebounceTime: num(readable.getDeallocateDebounceTime, 120),
		liquidatorShare: latestValue("SetLiquidatorShare") ?? "100000000000000000",
		liquidationTimeout: num(latestValue("SetLiquidationTimeout"), 100),
		forceCloseCooldowns: recovered.SetForceCloseCooldowns
			? [Number(recovered.SetForceCloseCooldowns[1]), Number(recovered.SetForceCloseCooldowns[3])]
			: [300, 120],
		forceCancelCooldown: num(latestValue("SetForceCancelCooldown"), 300),
		forceCancelCloseCooldown: num(latestValue("SetForceCancelCloseCooldown"), 300),
		pendingQuotesValidLength: num(latestValue("SetPendingQuotesValidLength"), 10),
		maxPartyAConnectionLimit: num(latestValue("SetMaxPartyAConnectionLimit"), 5),
	},
	instantLayerTemplates: templates,
}

const outPath = `./tasks/config/protocol-${targetChainId}.json`
fs.mkdirSync("./tasks/config", { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(out, null, "\t") + "\n")
console.log(`\nWrote ${outPath}`)
if (out._provenance.parametersNotRecovered.length > 0) {
	console.log(`⚠ These kept built-in defaults and should be confirmed: ${out._provenance.parametersNotRecovered.join(", ")}`)
}
