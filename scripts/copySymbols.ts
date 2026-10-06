/**
 * Copies symbols from a source Symmio Diamond on one chain to a target Symmio
 * Diamond on another chain. Designed for the Arbitrum v0.8.4 -> Polygon v0.8.5
 * migration but the constants below can be changed for other pairs.
 *
 * Rules:
 *   - Dedupe source symbols by `name`, preferring entries where `isValid=true`.
 *     Names whose entries are all invalid are dropped.
 *   - All copied symbols are inserted with symbolType = 1 on the target.
 *   - The target contract assigns fresh sequential symbolIds; the source ids
 *     are discarded.
 *
 * Usage (flags are env vars — hardhat 3 `run` does not pass CLI args through):
 *   RPC_ARBITRUM=<url> NEW_DEPLOYER=<pk> [DRY_RUN=true] [TARGET=core|manager] \
 *   [BATCH_SIZE=25] npx hardhat run scripts/copySymbols.ts --network polygon
 *
 * Env vars:
 *   RPC_ARBITRUM  Source RPC (required).
 *   DRY_RUN       "true"/"1" — no txs sent; prints the batches that would
 *                 be submitted.
 *   TARGET        "core" — call SymbolControlFacet on the target diamond
 *                 (deployer must hold SYMBOL_MANAGER_ROLE on target).
 *                 "manager" — call SymmioSymbolManager.addSymbolsWithType
 *                 (deployer must hold SYMBOL_ADDER_ROLE on the manager,
 *                 capped by its daily limit — default 25/day).
 *                 If unset, the script prompts interactively.
 *   BATCH_SIZE    Symbols per tx (default 25).
 */
import { configVariable } from "hardhat/config"
import { stdin, stdout } from "node:process"
import readline from "node:readline/promises"

import { ethers as hhEthers, hre } from "../test/helpers/hardhat-connection.js"

// Resolves a configVariable() token through the same hook chain hardhat uses
// internally for config resolution, so keystore/plugin-based sources work too.
async function resolveVar(name: string): Promise<string> {
	const variable = configVariable(name)
	return (hre as any).hooks.runHandlerChain("configurationVariables", "fetchValue", [variable], async (_ctx: unknown, v: { name: string }) => {
		const val = process.env[v.name]
		if (typeof val !== "string" || val.length === 0) {
			throw new Error(`Configuration variable '${v.name}' is not set`)
		}
		return val
	})
}

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------

const SOURCE = {
	label: "Arbitrum v0.8.4",
	rpcEnvVar: "RPC_ARBITRUM",
	diamond: "0x8F06459f184553e5d04F07F868720BDaCAB39395",
	expectedChainId: 42161n,
}

const TARGET = {
	label: "Polygon v0.8.5",
	diamond: "0x5733103aA8cf26DAf49E87e9d24ca8AB66abe1e7",
	symbolManager: "0x25995f8e106a43264658bd649e2C8323FA22317c",
	expectedChainId: 137n,
}

const SYMBOL_TYPE = 1n
const PAGE_SIZE = 200 // paginated reads from source
const DEFAULT_BATCH_SIZE = 25 // writes per tx on target

// --------------------------------------------------------------------------
// Env config (hardhat 3 `run` swallows CLI flags, so options come from env)
// --------------------------------------------------------------------------

const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? "")
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? DEFAULT_BATCH_SIZE)
let targetChoice = process.env.TARGET?.toLowerCase() // "core" | "manager" | undefined

// --------------------------------------------------------------------------
// ABI fragments (minimal — struct layouts unchanged between v0.8.4 and v0.8.5)
// --------------------------------------------------------------------------

const SYMBOL_TUPLE =
	"tuple(uint256 symbolId,string name,bool isValid,uint256 minAcceptableQuoteValue,uint256 minAcceptablePortionLF,uint256 tradingFee,uint256 maxLeverage,uint256 fundingRateEpochDuration,uint256 fundingRateWindowTime)"

const SYMBOL_WITH_TYPE_TUPLE =
	"tuple(uint256 symbolId,string name,bool isValid,uint256 minAcceptableQuoteValue,uint256 minAcceptablePortionLF,uint256 tradingFee,uint256 maxLeverage,uint256 fundingRateEpochDuration,uint256 fundingRateWindowTime,uint256 symbolType)"

const SOURCE_READ_ABI = [`function getSymbols(uint256 start, uint256 size) view returns (${SYMBOL_TUPLE}[])`]

const CORE_WRITE_ABI = [`function addSymbolsWithType(${SYMBOL_WITH_TYPE_TUPLE}[] symbolsWithType)`]

const MANAGER_WRITE_ABI = [`function addSymbolsWithType(${SYMBOL_WITH_TYPE_TUPLE}[] symbolsWithType)`]

type SourceSymbol = {
	symbolId: bigint
	name: string
	isValid: boolean
	minAcceptableQuoteValue: bigint
	minAcceptablePortionLF: bigint
	tradingFee: bigint
	maxLeverage: bigint
	fundingRateEpochDuration: bigint
	fundingRateWindowTime: bigint
}

type TargetSymbol = SourceSymbol & { symbolType: bigint }

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function banner(title: string) {
	const bar = "─".repeat(Math.max(10, title.length))
	console.log(`\n${bar}\n${title}\n${bar}`)
}

function fmtSymbol(s: SourceSymbol): string {
	return `#${s.symbolId} ${s.name} valid=${s.isValid} fee=${s.tradingFee} maxLev=${s.maxLeverage}`
}

async function prompt(q: string): Promise<string> {
	const rl = readline.createInterface({ input: stdin, output: stdout })
	try {
		return (await rl.question(q)).trim()
	} finally {
		rl.close()
	}
}

// --------------------------------------------------------------------------
// 1. Read source symbols from Arbitrum
// --------------------------------------------------------------------------

banner(`Copy symbols: ${SOURCE.label} -> ${TARGET.label}`)

let sourceRpc: string
try {
	sourceRpc = await resolveVar(SOURCE.rpcEnvVar)
} catch (err: any) {
	console.error(`Failed to resolve ${SOURCE.rpcEnvVar}: ${err.message ?? err}`)
	process.exit(1)
}

const sourceProvider = new hhEthers.JsonRpcProvider(sourceRpc)
const sourceNet = await sourceProvider.getNetwork()
if (sourceNet.chainId !== SOURCE.expectedChainId) {
	console.error(`Source RPC chainId ${sourceNet.chainId} != expected ${SOURCE.expectedChainId}`)
	process.exit(1)
}
console.log(`Source RPC: [${SOURCE.rpcEnvVar}] (chainId ${sourceNet.chainId})`)

const sourceDiamond = new hhEthers.Contract(SOURCE.diamond, SOURCE_READ_ABI, sourceProvider)

console.log(`\nFetching symbols from ${SOURCE.diamond}...`)
const allSource: SourceSymbol[] = []
let offset = 0
while (true) {
	const page: any[] = await sourceDiamond.getSymbols(offset, PAGE_SIZE)
	if (page.length === 0) break
	for (const s of page) {
		allSource.push({
			symbolId: s.symbolId,
			name: s.name,
			isValid: s.isValid,
			minAcceptableQuoteValue: s.minAcceptableQuoteValue,
			minAcceptablePortionLF: s.minAcceptablePortionLF,
			tradingFee: s.tradingFee,
			maxLeverage: s.maxLeverage,
			fundingRateEpochDuration: s.fundingRateEpochDuration,
			fundingRateWindowTime: s.fundingRateWindowTime,
		})
	}
	console.log(`  fetched ${allSource.length} (page +${page.length})`)
	if (page.length < PAGE_SIZE) break
	offset += PAGE_SIZE
}
console.log(`Total source symbols: ${allSource.length}`)

// --------------------------------------------------------------------------
// 2. Dedupe: group by name, drop names with no valid entries, pick one valid
//    (highest symbolId) per remaining name.
// --------------------------------------------------------------------------

const byName = new Map<string, SourceSymbol[]>()
for (const s of allSource) {
	const arr = byName.get(s.name) ?? []
	arr.push(s)
	byName.set(s.name, arr)
}

const kept: SourceSymbol[] = []
const droppedNames: string[] = []
const duplicateGroups: { name: string; entries: SourceSymbol[] }[] = []

for (const [name, entries] of byName) {
	const valid = entries.filter(e => e.isValid)
	if (valid.length === 0) {
		droppedNames.push(name)
		continue
	}
	valid.sort((a, b) => (a.symbolId < b.symbolId ? 1 : a.symbolId > b.symbolId ? -1 : 0))
	kept.push(valid[0])
	if (entries.length > 1) duplicateGroups.push({ name, entries })
}

kept.sort((a, b) => (a.symbolId < b.symbolId ? -1 : a.symbolId > b.symbolId ? 1 : 0))

banner("Dedup summary")
console.log(`Unique names: ${byName.size}`)
console.log(`Names with duplicates: ${duplicateGroups.length}`)
console.log(`Dropped (no valid entry): ${droppedNames.length}`)
console.log(`Kept for copy: ${kept.length}`)

if (duplicateGroups.length > 0) {
	console.log("\nDuplicate-name groups (picked entry marked ✔):")
	for (const g of duplicateGroups) {
		console.log(`  ${g.name}:`)
		const pickedId = kept.find(k => k.name === g.name)!.symbolId
		for (const e of g.entries) {
			const mark = e.symbolId === pickedId ? "✔" : " "
			console.log(`    ${mark} ${fmtSymbol(e)}`)
		}
	}
}
if (droppedNames.length > 0) {
	console.log(`\nDropped names: ${droppedNames.join(", ")}`)
}

if (kept.length === 0) {
	console.log("\nNothing to copy. Exiting.")
	process.exit(0)
}

// --------------------------------------------------------------------------
// 3. Choose the tradingFee to apply on the target.
//    Trading fees on Symmio are scaled by 1e18 (so 0.001e18 = 0.1% = 10 bps).
//    Group the kept symbols by their on-Arbitrum tradingFee and let the
//    runner pick one value (or keep per-symbol originals, or type a custom).
// --------------------------------------------------------------------------

function fmtFeeBps(fee: bigint): string {
	// basis points with 2 decimals: fee/1e18 * 10000
	const bpsX100 = (fee * 1_000_000n) / 10n ** 18n // bps * 100
	const whole = bpsX100 / 100n
	const frac = bpsX100 % 100n
	return `${whole}.${frac.toString().padStart(2, "0")} bps`
}

type FeeGroup = { fee: bigint; count: number; examples: string[] }
const feeMap = new Map<string, FeeGroup>()
for (const s of kept) {
	const key = s.tradingFee.toString()
	const g = feeMap.get(key) ?? { fee: s.tradingFee, count: 0, examples: [] }
	g.count++
	if (g.examples.length < 3) g.examples.push(s.name)
	feeMap.set(key, g)
}
const feeGroups = Array.from(feeMap.values()).sort((a, b) => b.count - a.count)

banner("Trading fee options (from Arbitrum)")
for (let i = 0; i < feeGroups.length; i++) {
	const g = feeGroups[i]
	console.log(`  ${i + 1}) ${g.fee}  (${fmtFeeBps(g.fee)})  — ${g.count} symbol(s)  e.g. ${g.examples.join(", ")}`)
}
console.log(`  k) keep each symbol's original fee`)
console.log(`  (or just type a raw 18-decimal fee, e.g. 800000000000000)`)

let chosenFee: bigint | "keep"
const envFee = process.env.TRADING_FEE?.trim()
if (envFee) {
	if (envFee.toLowerCase() === "keep") chosenFee = "keep"
	else {
		try {
			chosenFee = BigInt(envFee)
		} catch {
			console.error(`TRADING_FEE must be 'keep' or a bigint, got '${envFee}'`)
			process.exit(1)
		}
	}
	console.log(`\nTRADING_FEE env var set -> ${chosenFee === "keep" ? "keep per-symbol originals" : chosenFee}`)
} else {
	const ans = (await prompt("\nChoose fee (menu number, 'k' to keep, or a raw 18-decimal fee): ")).trim()
	if (ans.toLowerCase() === "k") {
		chosenFee = "keep"
	} else if (ans.toLowerCase() === "c") {
		const raw = (await prompt("Enter fee as 18-decimal integer: ")).trim()
		try {
			chosenFee = BigInt(raw)
		} catch {
			console.error(`Invalid bigint: ${raw}`)
			process.exit(1)
		}
	} else if (/^\d+$/.test(ans)) {
		// Numeric input: small values in menu range -> menu pick, larger -> raw fee.
		const asBig = BigInt(ans)
		if (asBig >= 1n && asBig <= BigInt(feeGroups.length)) {
			chosenFee = feeGroups[Number(asBig) - 1].fee
		} else {
			chosenFee = asBig
			console.log(`(interpreted as raw 18-decimal fee: ${asBig} = ${fmtFeeBps(asBig)})`)
		}
	} else {
		console.error(`Invalid choice: ${ans}`)
		process.exit(1)
	}
}

console.log(
	chosenFee === "keep" ? `\nUsing per-symbol original fees` : `\nUsing fee ${chosenFee} (${fmtFeeBps(chosenFee)}) for all ${kept.length} symbols`,
)

// --------------------------------------------------------------------------
// 4. Build target-shape structs (symbolType = 1). symbolId is ignored by the
//    target contract (it assigns fresh sequential ids) so we zero it out.
// --------------------------------------------------------------------------

const targetSymbols: TargetSymbol[] = kept.map(s => ({
	symbolId: 0n,
	name: s.name,
	isValid: true,
	minAcceptableQuoteValue: s.minAcceptableQuoteValue,
	minAcceptablePortionLF: s.minAcceptablePortionLF,
	tradingFee: chosenFee === "keep" ? s.tradingFee : chosenFee,
	maxLeverage: s.maxLeverage,
	fundingRateEpochDuration: s.fundingRateEpochDuration,
	fundingRateWindowTime: s.fundingRateWindowTime,
	symbolType: SYMBOL_TYPE,
}))

// --------------------------------------------------------------------------
// 4. Pick target (core vs manager), verify target chain, show plan.
// --------------------------------------------------------------------------

if (!targetChoice) {
	console.log(`\nChoose target on ${TARGET.label}:`)
	console.log(`  1) core     -> call SymbolControlFacet on diamond ${TARGET.diamond}`)
	console.log(`                 (requires SYMBOL_MANAGER_ROLE on diamond; no daily cap)`)
	console.log(`  2) manager  -> call SymmioSymbolManager ${TARGET.symbolManager}`)
	console.log(`                 (requires SYMBOL_ADDER_ROLE; capped at ~25 adds/day by default)`)
	const ans = await prompt("Enter 1 or 2 (or 'core'/'manager'): ")
	if (ans === "1" || ans.toLowerCase() === "core") targetChoice = "core"
	else if (ans === "2" || ans.toLowerCase() === "manager") targetChoice = "manager"
	else {
		console.error(`Unrecognised choice: ${ans}`)
		process.exit(1)
	}
}

if (targetChoice !== "core" && targetChoice !== "manager") {
	console.error(`TARGET must be 'core' or 'manager', got '${targetChoice}'`)
	process.exit(1)
}

const targetAddress = targetChoice === "core" ? TARGET.diamond : TARGET.symbolManager
const targetAbi = targetChoice === "core" ? CORE_WRITE_ABI : MANAGER_WRITE_ABI

const [signer] = await hhEthers.getSigners()
const targetNet = await hhEthers.provider.getNetwork()
if (targetNet.chainId !== TARGET.expectedChainId) {
	console.error(`Target (hardhat) chainId ${targetNet.chainId} != expected ${TARGET.expectedChainId}`)
	console.error(`Re-run with --network polygon`)
	process.exit(1)
}

console.log(`\nTarget chain: ${TARGET.label} (chainId ${targetNet.chainId})`)
console.log(`Target route: ${targetChoice} @ ${targetAddress}`)
console.log(`Signer: ${signer.address}`)
console.log(`Batch size: ${BATCH_SIZE}`)
console.log(`Total batches: ${Math.ceil(targetSymbols.length / BATCH_SIZE)}`)

// --------------------------------------------------------------------------
// 5. Build batches; print or send.
// --------------------------------------------------------------------------

type Batch = { index: number; symbols: TargetSymbol[] }
const batches: Batch[] = []
for (let i = 0, idx = 0; i < targetSymbols.length; i += BATCH_SIZE, idx++) {
	batches.push({ index: idx, symbols: targetSymbols.slice(i, i + BATCH_SIZE) })
}

if (DRY_RUN) {
	banner("DRY RUN — no transactions will be sent")
	for (const b of batches) {
		console.log(`\nBatch ${b.index + 1}/${batches.length} (${b.symbols.length} symbols):`)
		for (const s of b.symbols) {
			console.log(
				`  ${s.name}  fee=${s.tradingFee}  maxLev=${s.maxLeverage}  ` +
					`minQuote=${s.minAcceptableQuoteValue}  minPortionLF=${s.minAcceptablePortionLF}  ` +
					`epoch=${s.fundingRateEpochDuration}  window=${s.fundingRateWindowTime}  ` +
					`type=${s.symbolType}`,
			)
		}
		const iface = new hhEthers.Interface(targetAbi)
		const data = iface.encodeFunctionData("addSymbolsWithType", [
			b.symbols.map(s => [
				s.symbolId,
				s.name,
				s.isValid,
				s.minAcceptableQuoteValue,
				s.minAcceptablePortionLF,
				s.tradingFee,
				s.maxLeverage,
				s.fundingRateEpochDuration,
				s.fundingRateWindowTime,
				s.symbolType,
			]),
		])
		console.log(`  encoded calldata (${data.length / 2 - 1} bytes): ${data.slice(0, 66)}...`)
	}
	console.log(`\nDry run complete. ${targetSymbols.length} symbols across ${batches.length} batches.`)
	process.exit(0)
}

// --------------------------------------------------------------------------
// 6. Send
// --------------------------------------------------------------------------

const confirm = await prompt(`\nSend ${batches.length} tx(s) from ${signer.address}? (yes/no): `)
if (confirm.toLowerCase() !== "yes" && confirm.toLowerCase() !== "y") {
	console.log("Aborted.")
	process.exit(0)
}

const targetContract = new hhEthers.Contract(targetAddress, targetAbi, signer)

for (const b of batches) {
	console.log(`\nSending batch ${b.index + 1}/${batches.length} (${b.symbols.length} symbols)...`)
	const tx = await targetContract.addSymbolsWithType(
		b.symbols.map(s => [
			s.symbolId,
			s.name,
			s.isValid,
			s.minAcceptableQuoteValue,
			s.minAcceptablePortionLF,
			s.tradingFee,
			s.maxLeverage,
			s.fundingRateEpochDuration,
			s.fundingRateWindowTime,
			s.symbolType,
		]),
	)
	console.log(`  tx: ${tx.hash}`)
	const receipt = await tx.wait()
	console.log(`  confirmed in block ${receipt?.blockNumber}, gas used ${receipt?.gasUsed}`)
}

console.log(`\nDone. Copied ${targetSymbols.length} symbols to ${TARGET.label}.`)
