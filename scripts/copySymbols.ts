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
 * Plan (default; flags are env vars because Hardhat 3 `run` does not pass args through):
 *   RPC_ARBITRUM=<url> [TARGET=core|manager] [BATCH_SIZE=25] \
 *     ./node_modules/.bin/hardhat run scripts/copySymbols.ts --network polygon
 *
 * Execution requires explicit chain-bound source and target contracts; the built-in
 * historical addresses are display-only plan defaults.
 *
 * Env vars:
 *   RPC_ARBITRUM  Source RPC (required).
 *   EXECUTE       Must be exactly "true" to submit transactions.
 *   CONFIRM_CHAIN_ID Must exactly match the target eth_chainId when executing.
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
import { exactBooleanEnv, requireExecutionConfirmation } from "./upgrade/utils/executionGuard.js"
import { buildSymbolCopyPlan, symbolKey } from "./utils/copySymbolsPlan.js"

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

const EXECUTE_REQUESTED = exactBooleanEnv("EXECUTE")
const sourceChainId = BigInt(process.env.SOURCE_CHAIN_ID ?? "42161")
const targetChainId = BigInt(process.env.TARGET_CHAIN_ID ?? "137")

if (EXECUTE_REQUESTED) {
	for (const name of ["SOURCE_DIAMOND", "SOURCE_CHAIN_ID", "TARGET_DIAMOND", "TARGET_SYMBOL_MANAGER", "TARGET_CHAIN_ID"]) {
		if (!process.env[name]) throw new Error(`EXECUTE=true requires explicit ${name}; embedded historical targets are plan-only`)
	}
}

const SOURCE = {
	label: "Arbitrum v0.8.4",
	rpcEnvVar: "RPC_ARBITRUM",
	diamond: hhEthers.getAddress(process.env.SOURCE_DIAMOND ?? "0x8F06459f184553e5d04F07F868720BDaCAB39395"),
	expectedChainId: sourceChainId,
}

const TARGET = {
	label: "Polygon v0.8.5",
	diamond: hhEthers.getAddress(process.env.TARGET_DIAMOND ?? "0x5733103aA8cf26DAf49E87e9d24ca8AB66abe1e7"),
	symbolManager: hhEthers.getAddress(process.env.TARGET_SYMBOL_MANAGER ?? "0x25995f8e106a43264658bd649e2C8323FA22317c"),
	expectedChainId: targetChainId,
}

const SYMBOL_TYPE = 1n
const PAGE_SIZE = 200 // paginated reads from source
const DEFAULT_BATCH_SIZE = 25 // writes per tx on target

// --------------------------------------------------------------------------
// Env config (hardhat 3 `run` swallows CLI flags, so options come from env)
// --------------------------------------------------------------------------

const DRY_RUN = !EXECUTE_REQUESTED
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? DEFAULT_BATCH_SIZE)
if (!Number.isSafeInteger(BATCH_SIZE) || BATCH_SIZE < 1 || BATCH_SIZE > PAGE_SIZE) {
	throw new Error(`BATCH_SIZE must be a safe integer between 1 and ${PAGE_SIZE}; received ${process.env.BATCH_SIZE ?? DEFAULT_BATCH_SIZE}`)
}
let targetChoice = process.env.TARGET?.toLowerCase() // "core" | "manager" | undefined

// --------------------------------------------------------------------------
// ABI fragments (minimal — struct layouts unchanged between v0.8.4 and v0.8.5)
// --------------------------------------------------------------------------

const SYMBOL_TUPLE =
	"tuple(uint256 symbolId,string name,bool isValid,uint256 minAcceptableQuoteValue,uint256 minAcceptablePortionLF,uint256 tradingFee,uint256 maxLeverage,uint256 fundingRateEpochDuration,uint256 fundingRateWindowTime)"

const SYMBOL_WITH_TYPE_TUPLE =
	"tuple(uint256 symbolId,string name,bool isValid,uint256 minAcceptableQuoteValue,uint256 minAcceptablePortionLF,uint256 tradingFee,uint256 maxLeverage,uint256 fundingRateEpochDuration,uint256 fundingRateWindowTime,uint256 symbolType)"

const SOURCE_READ_ABI = [`function getSymbols(uint256 start, uint256 size) view returns (${SYMBOL_TUPLE}[])`]
const TARGET_READ_ABI = [`function getSymbolsWithType(uint256 start, uint256 size) view returns (${SYMBOL_WITH_TYPE_TUPLE}[])`]

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

function toTargetSymbol(s: any): TargetSymbol {
	return {
		symbolId: s.symbolId,
		name: s.name,
		isValid: s.isValid,
		minAcceptableQuoteValue: s.minAcceptableQuoteValue,
		minAcceptablePortionLF: s.minAcceptablePortionLF,
		tradingFee: s.tradingFee,
		maxLeverage: s.maxLeverage,
		fundingRateEpochDuration: s.fundingRateEpochDuration,
		fundingRateWindowTime: s.fundingRateWindowTime,
		symbolType: s.symbolType,
	}
}

function symbolMismatch(actual: TargetSymbol, expected: TargetSymbol): string | null {
	for (const field of [
		"name",
		"isValid",
		"minAcceptableQuoteValue",
		"minAcceptablePortionLF",
		"tradingFee",
		"maxLeverage",
		"fundingRateEpochDuration",
		"fundingRateWindowTime",
		"symbolType",
	] as const) {
		if (actual[field] !== expected[field]) return `${field}: on-chain=${actual[field]} expected=${expected[field]}`
	}
	return null
}

async function readAllTargetSymbols(targetDiamond: string): Promise<TargetSymbol[]> {
	const reader = new hhEthers.Contract(targetDiamond, TARGET_READ_ABI, hhEthers.provider)
	const symbols: TargetSymbol[] = []
	for (let start = 0; ; start += PAGE_SIZE) {
		const page: any[] = await reader.getSymbolsWithType(start, PAGE_SIZE)
		for (const symbol of page) symbols.push(toTargetSymbol(symbol))
		if (page.length < PAGE_SIZE) break
	}
	return symbols
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
if ((await sourceProvider.getCode(SOURCE.diamond)) === "0x") throw new Error(`No source diamond code at ${SOURCE.diamond}`)
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

const { kept, droppedNames, duplicateGroups, uniqueNameCount } = buildSymbolCopyPlan(allSource)

banner("Dedup summary")
console.log(`Unique names: ${uniqueNameCount}`)
console.log(`Names with duplicates: ${duplicateGroups.length}`)
console.log(`Dropped (no valid entry): ${droppedNames.length}`)
console.log(`Kept for copy: ${kept.length}`)

if (duplicateGroups.length > 0) {
	console.log("\nDuplicate-name groups (picked entry marked ✔):")
	for (const g of duplicateGroups) {
		console.log(`  ${g.name}:`)
		for (const e of g.entries) {
			const mark = e.symbolId === g.pickedId ? "✔" : " "
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
		if (chosenFee < 0n) throw new Error("TRADING_FEE must be non-negative")
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
		if (chosenFee < 0n) throw new Error("Trading fee must be non-negative")
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

const targetNet = await hhEthers.provider.getNetwork()
if (targetNet.chainId !== TARGET.expectedChainId) {
	console.error(`Target (hardhat) chainId ${targetNet.chainId} != expected ${TARGET.expectedChainId}`)
	console.error(`Re-run with --network polygon`)
	process.exit(1)
}
const execute = requireExecutionConfirmation(targetNet.chainId)
if (execute !== EXECUTE_REQUESTED) throw new Error("Execution mode changed while the symbol-copy process was starting")
const [signer] = execute ? await hhEthers.getSigners() : []
if (execute && !signer) throw new Error("No target signer is configured")
const plannedSignerAddress = process.env.SIGNER_ADDRESS ? hhEthers.getAddress(process.env.SIGNER_ADDRESS) : undefined
const signerAddress = signer?.address ?? plannedSignerAddress
if ((await hhEthers.provider.getCode(TARGET.diamond)) === "0x") throw new Error(`No target diamond code at ${TARGET.diamond}`)
if (targetChoice === "manager") {
	if ((await hhEthers.provider.getCode(TARGET.symbolManager)) === "0x") throw new Error(`No SymbolManager code at ${TARGET.symbolManager}`)
	const manager = new hhEthers.Contract(TARGET.symbolManager, ["function symmioAddress() view returns (address)"], hhEthers.provider)
	const managerCore = hhEthers.getAddress(await manager.symmioAddress())
	if (managerCore !== hhEthers.getAddress(TARGET.diamond)) {
		throw new Error(`SymbolManager points to ${managerCore}; expected target diamond ${TARGET.diamond}`)
	}
}

const existingTargetSymbols = await readAllTargetSymbols(TARGET.diamond)
const existingByName = new Map<string, TargetSymbol[]>()
for (const symbol of existingTargetSymbols) {
	const key = symbolKey(symbol.name)
	const group = existingByName.get(key) ?? []
	group.push(symbol)
	existingByName.set(key, group)
}
const targetSymbolsToAdd: TargetSymbol[] = []
let alreadyMatching = 0
for (const desired of targetSymbols) {
	const matches = existingByName.get(symbolKey(desired.name)) ?? []
	if (matches.length > 1)
		throw new Error(`Target contains ${matches.length} symbols matching normalized name "${desired.name}"; manual review required`)
	if (matches.length === 0) {
		targetSymbolsToAdd.push(desired)
		continue
	}
	const mismatch = symbolMismatch(matches[0], desired)
	if (mismatch)
		throw new Error(`Target symbol "${desired.name}" already exists with different configuration (${mismatch}); refusing to create a duplicate`)
	alreadyMatching++
}
if (targetSymbolsToAdd.length > 0 && targetChoice === "manager") {
	const roleReader = new hhEthers.Contract(
		TARGET.symbolManager,
		["function SYMBOL_ADDER_ROLE() view returns (bytes32)", "function hasRole(bytes32,address) view returns (bool)"],
		hhEthers.provider,
	)
	const symbolAdderRole = await roleReader.SYMBOL_ADDER_ROLE()
	if (signerAddress && !(await roleReader.hasRole(symbolAdderRole, signerAddress))) {
		const message = `Signer ${signerAddress} is missing SYMBOL_ADDER_ROLE on ${TARGET.symbolManager}`
		if (execute) throw new Error(message)
		console.warn(`Plan warning: ${message}`)
	} else if (!signerAddress) {
		console.warn("Plan warning: signer role was not checked; set SIGNER_ADDRESS to include it in the read-only plan")
	}
	const limitsReader = new hhEthers.Contract(
		TARGET.symbolManager,
		[
			"function dailyLimits() view returns (uint256 symbolAddition,uint256 tradingFee,uint256 validationState,uint256 maxLeverage,uint256 acceptableValues,uint256 fundingState,uint256 forceCloseGapRatio)",
			"function dailyOperations() view returns (uint256 symbolAddition,uint256 tradingFee,uint256 validationState,uint256 maxLeverage,uint256 acceptableValues,uint256 fundingState,uint256 forceCloseGapRatio)",
			"function lastResetTimestamp() view returns (uint256)",
		],
		hhEthers.provider,
	)
	const [limits, operations, lastResetTimestamp, latestBlock] = await Promise.all([
		limitsReader.dailyLimits(),
		limitsReader.dailyOperations(),
		limitsReader.lastResetTimestamp(),
		hhEthers.provider.getBlock("latest"),
	])
	if (!latestBlock) throw new Error("Could not read latest target block for SymbolManager daily-limit preflight")
	const used = BigInt(latestBlock.timestamp) >= lastResetTimestamp + 86_400n ? 0n : operations.symbolAddition
	const remaining = limits.symbolAddition > used ? limits.symbolAddition - used : 0n
	if (BigInt(targetSymbolsToAdd.length) > remaining) {
		throw new Error(
			`SymbolManager daily addition limit has ${remaining} slot(s) remaining, but ${targetSymbolsToAdd.length} symbols are missing. ` +
				"Wait for the daily reset or use TARGET=core with a signer holding SYMBOL_MANAGER_ROLE.",
		)
	}
} else if (targetSymbolsToAdd.length > 0) {
	const roleReader = new hhEthers.Contract(TARGET.diamond, ["function hasRole(address,bytes32) view returns (bool)"], hhEthers.provider)
	const symbolManagerRole = hhEthers.id("SYMBOL_MANAGER_ROLE")
	if (signerAddress && !(await roleReader.hasRole(signerAddress, symbolManagerRole))) {
		const message = `Signer ${signerAddress} is missing SYMBOL_MANAGER_ROLE on ${TARGET.diamond}`
		if (execute) throw new Error(message)
		console.warn(`Plan warning: ${message}`)
	} else if (!signerAddress) {
		console.warn("Plan warning: signer role was not checked; set SIGNER_ADDRESS to include it in the read-only plan")
	}
}

console.log(`\nTarget chain: ${TARGET.label} (chainId ${targetNet.chainId})`)
console.log(`Target route: ${targetChoice} @ ${targetAddress}`)
console.log(`Signer: ${signerAddress ?? "(not configured; role check skipped in plan)"}`)
console.log(`Mode: ${execute ? "EXECUTE" : "PLAN ONLY"}`)
console.log(`Batch size: ${BATCH_SIZE}`)
console.log(`Target symbols already matching: ${alreadyMatching}`)
console.log(`Target symbols to add: ${targetSymbolsToAdd.length}`)
console.log(`Total batches: ${Math.ceil(targetSymbolsToAdd.length / BATCH_SIZE)}`)

// --------------------------------------------------------------------------
// 5. Build batches; print or send.
// --------------------------------------------------------------------------

type Batch = { index: number; symbols: TargetSymbol[] }
const batches: Batch[] = []
for (let i = 0, idx = 0; i < targetSymbolsToAdd.length; i += BATCH_SIZE, idx++) {
	batches.push({ index: idx, symbols: targetSymbolsToAdd.slice(i, i + BATCH_SIZE) })
}

if (batches.length === 0) {
	console.log("\nTarget already contains every desired symbol with exact parameters. Nothing to send.")
	process.exit(0)
}

if (DRY_RUN) {
	banner("PLAN ONLY — no transactions will be sent")
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
	console.log(`\nPlan complete. ${targetSymbolsToAdd.length} missing symbols across ${batches.length} batches.`)
	console.log(`Rerun with explicit source/target values, EXECUTE=true, and CONFIRM_CHAIN_ID=${targetNet.chainId}.`)
	process.exit(0)
}

// --------------------------------------------------------------------------
// 6. Send
// --------------------------------------------------------------------------

if (!signer) throw new Error("Execution signer disappeared before submission")
const confirm = await prompt(`\nSend ${batches.length} tx(s) from ${signer.address}? (yes/no): `)
if (confirm.toLowerCase() !== "yes" && confirm.toLowerCase() !== "y") {
	console.log("Aborted.")
	process.exit(0)
}

const targetContract = new hhEthers.Contract(targetAddress, targetAbi, signer)

for (const b of batches) {
	console.log(`\nSending batch ${b.index + 1}/${batches.length} (${b.symbols.length} symbols)...`)
	const encodedSymbols = b.symbols.map(s => [
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
	])
	await targetContract.addSymbolsWithType.staticCall(encodedSymbols)
	const tx = await targetContract.addSymbolsWithType(encodedSymbols)
	console.log(`  submitted tx: ${tx.hash} (nonce: ${tx.nonce})`)
	const receipt = await tx.wait()
	if (!receipt?.status) throw new Error(`Batch ${b.index + 1} transaction ${tx.hash} failed`)
	console.log(`  confirmed in block ${receipt?.blockNumber}, gas used ${receipt?.gasUsed}`)
	const refreshed = await readAllTargetSymbols(TARGET.diamond)
	const refreshedByName = new Map(refreshed.map(symbol => [symbolKey(symbol.name), symbol]))
	for (const expected of b.symbols) {
		const actual = refreshedByName.get(symbolKey(expected.name))
		if (!actual) throw new Error(`Post-state verification failed: target is missing ${expected.name}`)
		const mismatch = symbolMismatch(actual, expected)
		if (mismatch) throw new Error(`Post-state verification failed for ${expected.name}: ${mismatch}`)
	}
}

console.log(`\nDone. Added and verified ${targetSymbolsToAdd.length} symbols on ${TARGET.label}; ${alreadyMatching} were already exact matches.`)
