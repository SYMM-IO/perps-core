import { Interface, getAddress, ZeroAddress } from "ethers"

import { withDigest, verifyDigest } from "./symbolSync.js"

export const LF_BTC_ETH = "30000000000000000"
export const LF_OTHER = "40000000000000000"
export const LF_ROLE_NAME = "SYMBOL_MIN_ACCEPTABLE_VALUES_MANAGER_ROLE"
export const LF_SYMBOL_TUPLE =
	"tuple(uint256 symbolId,string name,bool isValid,uint256 minAcceptableQuoteValue,uint256 minAcceptablePortionLF,uint256 tradingFee,uint256 maxLeverage,uint256 fundingRateEpochDuration,uint256 fundingRateWindowTime)"
export const LF_CORE_ABI = [
	`function getSymbols(uint256 start,uint256 size) view returns (${LF_SYMBOL_TUPLE}[])`,
	`function getSymbolsWithType(uint256 start,uint256 size) view returns (${LF_SYMBOL_TUPLE.slice(0, -1)},uint256 symbolType)[])`,
	"function hasRole(address account,bytes32 role) view returns(bool)",
	"function facetAddress(bytes4 selector) view returns(address)",
	"function setSymbolAcceptableValues(uint256 symbolId,uint256 minAcceptableQuoteValue,uint256 minAcceptablePortionLF)",
]
const OPERATIONS =
	"uint256 symbolAddition,uint256 tradingFee,uint256 validationState,uint256 maxLeverage,uint256 acceptableValues,uint256 fundingState,uint256 forceCloseGapRatio"
export const LF_MANAGER_ABI = [
	"function setSymbolAcceptableValuesBatch(uint256[] symbolIds,uint256[] minAcceptableQuoteValues,uint256[] minAcceptablePortionLFs)",
	"function symmioAddress() view returns(address)",
	"function paused() view returns(bool)",
	"function hasRole(bytes32 role,address account) view returns(bool)",
	`function ${LF_ROLE_NAME}() view returns(bytes32)`,
	`function dailyLimits() view returns(${OPERATIONS})`,
	`function dailyOperations() view returns(${OPERATIONS})`,
	"function lastResetTimestamp() view returns(uint256)",
]
export type LfSymbol = {
	symbolId: string
	name: string
	isValid: boolean
	minAcceptableQuoteValue: string
	minAcceptablePortionLF: string
	tradingFee: string
	maxLeverage: string
	fundingRateEpochDuration: string
	fundingRateWindowTime: string
	symbolType?: string
}
export type LfConfig = {
	network: string
	chainId: number
	core: string
	symbolManager: string
	authority: string
	batchSize: number
	announcementReference: string
	enforcementAt: string
}
export function parseLfConfig(value: any): LfConfig {
	if (!value || typeof value !== "object") throw new Error("LF configuration is required")
	if (!/^[a-z][a-z0-9-]*$/.test(value.network)) throw new Error("Invalid LF network")
	if (!Number.isSafeInteger(value.chainId) || value.chainId <= 0) throw new Error("Invalid LF chain ID")
	if (!Number.isInteger(value.batchSize) || value.batchSize < 1 || value.batchSize > 50) throw new Error("LF batch size must be 1–50")
	const addresses = Object.fromEntries(
		["core", "symbolManager", "authority"].map(field => {
			const address = getAddress(value[field])
			if (address === ZeroAddress) throw new Error(`${field} must not be zero`)
			return [field, address]
		}),
	) as Pick<LfConfig, "core" | "symbolManager" | "authority">
	if (typeof value.announcementReference !== "string" || !value.announcementReference.trim())
		throw new Error("Record the solver announcement reference")
	if (
		typeof value.enforcementAt !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.enforcementAt) ||
		!Number.isFinite(Date.parse(value.enforcementAt))
	) {
		throw new Error("Enforcement time must be UTC: YYYY-MM-DDTHH:mm:ssZ")
	}
	return {
		...addresses,
		network: value.network,
		chainId: value.chainId,
		batchSize: value.batchSize,
		announcementReference: value.announcementReference.trim(),
		enforcementAt: value.enforcementAt,
	}
}
export function serializeLfSymbol(value: any): LfSymbol {
	const result: any = {}
	for (const key of [
		"symbolId",
		"name",
		"isValid",
		"minAcceptableQuoteValue",
		"minAcceptablePortionLF",
		"tradingFee",
		"maxLeverage",
		"fundingRateEpochDuration",
		"fundingRateWindowTime",
		"symbolType",
	]) {
		if (key === "symbolType" && value[key] === undefined) continue
		result[key] = key === "name" ? String(value[key]) : key === "isValid" ? Boolean(value[key]) : BigInt(value[key]).toString()
	}
	return result
}
export function assertLfCatalog(symbols: LfSymbol[]): void {
	if (!symbols.length) throw new Error("Empty symbol catalog; refusing an empty rollout")
	for (const [index, symbol] of symbols.entries()) {
		if (symbol.symbolId !== String(index + 1)) throw new Error("LF catalog IDs must be contiguous from 1")
		if (!symbol.name.trim()) throw new Error(`Symbol ${symbol.symbolId} has no name`)
	}
}
export function classifyLfSymbols(symbols: LfSymbol[]): { btcEthIds: string[]; ambiguousIds: string[] } {
	const btcEthIds: string[] = [],
		ambiguousIds: string[] = []
	for (const symbol of symbols) {
		const name = symbol.name.trim().toUpperCase()
		if (/^(BTC|ETH)(?:\/?(?:USDT|USDC|USD))?(?:_[A-Z0-9]+)*$/.test(name)) btcEthIds.push(symbol.symbolId)
		else if (/BTC|ETH/.test(name)) ambiguousIds.push(symbol.symbolId)
	}
	return { btcEthIds, ambiguousIds }
}
export function parseLfIds(text: string, symbols: LfSymbol[]): string[] {
	const ids = text.trim() ? text.split(",").map(id => id.trim()) : []
	const available = new Set(symbols.map(symbol => symbol.symbolId))
	if (new Set(ids).size !== ids.length) throw new Error("BTC/ETH IDs contain a duplicate")
	for (const id of ids) if (!/^[1-9]\d*$/.test(id) || !available.has(id)) throw new Error(`BTC/ETH ID ${id} is unknown`)
	return ids.sort((a, b) => Number(a) - Number(b))
}
export function lfTarget(symbolId: string, btcEthIds: string[]): string {
	return btcEthIds.includes(symbolId) ? LF_BTC_ETH : LF_OTHER
}
export type LfFundingChange = {
	symbolId: string
	name: string
	field: "fundingRateEpochDuration" | "fundingRateWindowTime"
	before: string
	after: string
}
export function analyzeLfState(
	baseline: LfSymbol[],
	current: LfSymbol[],
	btcEthIds: string[],
): {
	pending: LfSymbol[]
	complete: number
	fundingChanges: LfFundingChange[]
} {
	if (baseline.length !== current.length) throw new Error("Symbol catalog changed; create and review a new LF plan")
	const pending: LfSymbol[] = []
	const fundingChanges: LfFundingChange[] = []
	for (const [index, before] of baseline.entries()) {
		const now = current[index]
		for (const field of Object.keys(before) as Array<keyof LfSymbol>) {
			// The acceptable-values setter cannot write either funding field. Preserve live
			// schedules and report their drift separately from the reviewed LF/quote inputs.
			if (field === "fundingRateEpochDuration" || field === "fundingRateWindowTime") {
				if (before[field] !== now[field])
					fundingChanges.push({ symbolId: before.symbolId, name: before.name, field, before: before[field], after: now[field] })
				continue
			}
			if (field !== "minAcceptablePortionLF" && before[field] !== now[field])
				throw new Error(`Symbol ${before.symbolId} ${field} changed; review a new plan`)
		}
		const target = lfTarget(before.symbolId, btcEthIds)
		if (now.minAcceptablePortionLF === target) continue
		if (now.minAcceptablePortionLF !== before.minAcceptablePortionLF)
			throw new Error(`Symbol ${before.symbolId} LF changed unexpectedly; review a new plan`)
		pending.push(now)
	}
	return { pending, complete: current.length - pending.length, fundingChanges }
}
export function lfCapacity(limit: string, used: string, lastReset: string, timestamp: string) {
	const resetAt = BigInt(lastReset) + 86400n,
		resetDue = BigInt(timestamp) >= resetAt
	const remaining = BigInt(limit) - (resetDue ? 0n : BigInt(used))
	return {
		remaining: Number(remaining < 0n ? 0n : remaining > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : remaining),
		resetDue,
		resetAt: resetAt.toString(),
	}
}
export function buildLfAction(manager: string, symbols: LfSymbol[], btcEthIds: string[]) {
	if (!symbols.length) throw new Error("Cannot build an empty LF batch")
	const symbolIds = symbols.map(s => s.symbolId),
		minAcceptableQuoteValues = symbols.map(s => s.minAcceptableQuoteValue),
		minAcceptablePortionLFs = symbols.map(s => lfTarget(s.symbolId, btcEthIds))
	const data = new Interface(LF_MANAGER_ABI).encodeFunctionData("setSymbolAcceptableValuesBatch", [
		symbolIds,
		minAcceptableQuoteValues,
		minAcceptablePortionLFs,
	])
	return { id: `lf-${symbolIds.join("-")}`, to: manager, value: "0", data, symbolIds, minAcceptableQuoteValues, minAcceptablePortionLFs }
}
export function createLfPlan(snapshot: any, idsText: string) {
	verifyDigest(snapshot, "LF snapshot")
	if (snapshot.apiVersion !== "operations.symm.io/lf-snapshot-v1") throw new Error("Unsupported LF snapshot")
	const config = parseLfConfig(snapshot.config),
		symbols: LfSymbol[] = snapshot.symbols
	assertLfCatalog(symbols)
	const btcEthIds = parseLfIds(idsText, symbols)
	const rows = symbols.map(symbol => ({ ...symbol, targetLF: lfTarget(symbol.symbolId, btcEthIds) }))
	const pending = rows.filter(row => row.minAcceptablePortionLF !== row.targetLF)
	const actions = []
	for (let i = 0; i < pending.length; i += config.batchSize)
		actions.push(buildLfAction(config.symbolManager, pending.slice(i, i + config.batchSize), btcEthIds))
	return withDigest({ apiVersion: "operations.symm.io/lf-plan-v1", snapshot, btcEthIds, rows, actions })
}
export type LfPlan = ReturnType<typeof createLfPlan>
