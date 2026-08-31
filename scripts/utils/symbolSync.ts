import { getAddress, isAddress, ZeroAddress } from "ethers"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export const SYMBOL_SYNC_CONFIG_API = "operations.symm.io/symbol-sync-config-v1"
export const SYMBOL_SYNC_SNAPSHOT_API = "operations.symm.io/symbol-sync-snapshot-v1"
export const SYMBOL_SYNC_ASSIGNMENT_API = "operations.symm.io/symbol-sync-assignment-v1"

export const SYMBOL_FIELDS = [
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
] as const

export type SerializedSymbol = {
	symbolId: string
	name: string
	isValid: boolean
	minAcceptableQuoteValue: string
	minAcceptablePortionLF: string
	tradingFee: string
	maxLeverage: string
	fundingRateEpochDuration: string
	fundingRateWindowTime: string
	symbolType: string
}

export type SymbolSyncConfig = {
	apiVersion: typeof SYMBOL_SYNC_CONFIG_API
	name: string
	source: {
		network: string
		chainId: string
		core: string
	}
	target: {
		network: string
		chainId: string
		core: string
		symbolManager: string
	}
	execution: {
		batchSize: number
		preserveValidation: true
	}
	output: {
		snapshot: string
		assignmentReport: string
	}
}

export type SymbolSyncAnalysis = {
	status: "blocked" | "ready" | "complete"
	exactCount: number
	additions: SerializedSymbol[]
	activate: SerializedSymbol[]
	deactivate: SerializedSymbol[]
	conflicts: string[]
}

export type DailyOperationValues = {
	symbolAddition: bigint
	validationState: bigint
}

export type EffectiveDailyCapacity = {
	additionRemaining: bigint
	validationRemaining: bigint
	resetAt: bigint
	resetDue: boolean
}

export type SymbolSyncWindow = {
	additions: SerializedSymbol[]
	activateExisting: SerializedSymbol[]
	deactivateExisting: SerializedSymbol[]
	deactivateAdded: SerializedSymbol[]
	capacity: EffectiveDailyCapacity
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`)
	return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
	return value.trim()
}

function positiveIntegerString(value: unknown, label: string): string {
	const result = requiredString(value, label)
	if (!/^[1-9]\d*$/.test(result)) throw new Error(`${label} must be a positive integer encoded as a string`)
	return BigInt(result).toString()
}

function networkName(value: unknown, label: string): string {
	const result = requiredString(value, label)
	if (!/^[a-z][a-z0-9-]*$/.test(result)) throw new Error(`${label} must be a lowercase Hardhat network name`)
	return result
}

function address(value: unknown, label: string): string {
	const result = requiredString(value, label)
	if (!isAddress(result) || getAddress(result) === ZeroAddress) throw new Error(`${label} must be a non-zero EVM address`)
	return getAddress(result)
}

function outputPath(value: unknown, label: string): string {
	const result = requiredString(value, label)
	if (path.isAbsolute(result)) throw new Error(`${label} must be repository-relative`)
	const normalized = path.normalize(result)
	if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error(`${label} must stay inside the repository`)
	if (!normalized.endsWith(".json")) throw new Error(`${label} must end in .json`)
	return normalized
}

export function parseSymbolSyncConfig(value: unknown): SymbolSyncConfig {
	const root = requiredObject(value, "symbol-sync config")
	if (root.apiVersion !== SYMBOL_SYNC_CONFIG_API) {
		throw new Error(`symbol-sync config apiVersion must be ${SYMBOL_SYNC_CONFIG_API}`)
	}
	const source = requiredObject(root.source, "source")
	const target = requiredObject(root.target, "target")
	const execution = requiredObject(root.execution, "execution")
	const output = requiredObject(root.output, "output")
	const batchSize = Number(execution.batchSize)
	if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 25) {
		throw new Error("execution.batchSize must be an integer between 1 and the Symbol Manager daily default of 25")
	}
	if (execution.preserveValidation !== true) throw new Error("execution.preserveValidation must be true for exact-ID synchronization")

	return {
		apiVersion: SYMBOL_SYNC_CONFIG_API,
		name: requiredString(root.name, "name"),
		source: {
			network: networkName(source.network, "source.network"),
			chainId: positiveIntegerString(source.chainId, "source.chainId"),
			core: address(source.core, "source.core"),
		},
		target: {
			network: networkName(target.network, "target.network"),
			chainId: positiveIntegerString(target.chainId, "target.chainId"),
			core: address(target.core, "target.core"),
			symbolManager: address(target.symbolManager, "target.symbolManager"),
		},
		execution: { batchSize, preserveValidation: true },
		output: {
			snapshot: outputPath(output.snapshot, "output.snapshot"),
			assignmentReport: outputPath(output.assignmentReport, "output.assignmentReport"),
		},
	}
}

export function readSymbolSyncConfig(file: string): SymbolSyncConfig {
	let parsed: unknown
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"))
	} catch (error) {
		throw new Error(`Failed to read symbol-sync config ${file}: ${error instanceof Error ? error.message : String(error)}`)
	}
	return parseSymbolSyncConfig(parsed)
}

export function serializeSymbol(value: any): SerializedSymbol {
	return {
		symbolId: BigInt(value.symbolId).toString(),
		name: String(value.name),
		isValid: Boolean(value.isValid),
		minAcceptableQuoteValue: BigInt(value.minAcceptableQuoteValue).toString(),
		minAcceptablePortionLF: BigInt(value.minAcceptablePortionLF).toString(),
		tradingFee: BigInt(value.tradingFee).toString(),
		maxLeverage: BigInt(value.maxLeverage).toString(),
		fundingRateEpochDuration: BigInt(value.fundingRateEpochDuration).toString(),
		fundingRateWindowTime: BigInt(value.fundingRateWindowTime).toString(),
		symbolType: BigInt(value.symbolType).toString(),
	}
}

export function assertContiguousSymbols(symbols: readonly SerializedSymbol[], label: string): void {
	for (let index = 0; index < symbols.length; index++) {
		const expected = BigInt(index + 1)
		if (BigInt(symbols[index].symbolId) !== expected) {
			throw new Error(`${label} symbol IDs must be contiguous from 1; index ${index} contains ID ${symbols[index].symbolId}`)
		}
	}
}

export function symbolMismatch(actual: SerializedSymbol, expected: SerializedSymbol, options: { ignoreValidation?: boolean } = {}): string | null {
	for (const field of SYMBOL_FIELDS) {
		if (options.ignoreValidation && field === "isValid") continue
		if (actual[field] !== expected[field]) return `${field}: target=${String(actual[field])} source=${String(expected[field])}`
	}
	return null
}

export function analyzeExactIdSync(source: readonly SerializedSymbol[], target: readonly SerializedSymbol[]): SymbolSyncAnalysis {
	assertContiguousSymbols(source, "Source")
	assertContiguousSymbols(target, "Target")
	const conflicts: string[] = []
	if (target.length > source.length) conflicts.push(`Target has ${target.length} symbols while source has only ${source.length}`)

	const activate: SerializedSymbol[] = []
	const deactivate: SerializedSymbol[] = []
	let exactCount = 0
	for (let index = 0; index < Math.min(source.length, target.length); index++) {
		const expected = source[index]
		const actual = target[index]
		const mismatch = symbolMismatch(actual, expected, { ignoreValidation: true })
		if (mismatch) {
			conflicts.push(`Symbol ID ${expected.symbolId} conflicts (${mismatch})`)
			continue
		}
		if (actual.isValid === expected.isValid) exactCount++
		else if (expected.isValid) activate.push(expected)
		else deactivate.push(expected)
	}

	const additions = conflicts.length === 0 ? source.slice(target.length) : []
	const status = conflicts.length > 0 ? "blocked" : additions.length || activate.length || deactivate.length ? "ready" : "complete"
	return { status, exactCount, additions, activate, deactivate, conflicts }
}

export function effectiveDailyCapacity(
	limits: DailyOperationValues,
	operations: DailyOperationValues,
	lastResetTimestamp: bigint,
	blockTimestamp: bigint,
): EffectiveDailyCapacity {
	const resetAt = lastResetTimestamp + 86_400n
	const resetDue = blockTimestamp >= resetAt
	const additionUsed = resetDue ? 0n : operations.symbolAddition
	const validationUsed = resetDue ? 0n : operations.validationState
	return {
		additionRemaining: limits.symbolAddition > additionUsed ? limits.symbolAddition - additionUsed : 0n,
		validationRemaining: limits.validationState > validationUsed ? limits.validationState - validationUsed : 0n,
		resetAt,
		resetDue,
	}
}

export function buildSymbolSyncWindow(
	analysis: SymbolSyncAnalysis,
	limits: DailyOperationValues,
	operations: DailyOperationValues,
	lastResetTimestamp: bigint,
	blockTimestamp: bigint,
	batchSize: number,
): SymbolSyncWindow {
	if (analysis.conflicts.length > 0) throw new Error(`Cannot build a synchronization window with conflicts: ${analysis.conflicts.join("; ")}`)
	if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a positive safe integer")
	const capacity = effectiveDailyCapacity(limits, operations, lastResetTimestamp, blockTimestamp)
	let validationRemaining = capacity.validationRemaining

	const deactivateExisting = analysis.deactivate.slice(0, Number(validationRemaining))
	validationRemaining -= BigInt(deactivateExisting.length)
	const activateExisting = analysis.activate.slice(0, Number(validationRemaining))
	validationRemaining -= BigInt(activateExisting.length)

	const additions: SerializedSymbol[] = []
	const deactivateAdded: SerializedSymbol[] = []
	const additionLimit = Number(capacity.additionRemaining < BigInt(batchSize) ? capacity.additionRemaining : BigInt(batchSize))
	for (const symbol of analysis.additions) {
		if (additions.length >= additionLimit) break
		if (!symbol.isValid && BigInt(deactivateAdded.length) >= validationRemaining) break
		additions.push(symbol)
		if (!symbol.isValid) deactivateAdded.push(symbol)
	}

	return { additions, activateExisting, deactivateExisting, deactivateAdded, capacity }
}

function stableValue(value: unknown): unknown {
	if (typeof value === "bigint") return value.toString()
	if (value === undefined) return "[undefined]"
	if (value === null || typeof value !== "object") return value
	if (Array.isArray(value)) return value.map(stableValue)
	return Object.fromEntries(
		Object.keys(value as Record<string, unknown>)
			.sort()
			.map(key => [key, stableValue((value as Record<string, unknown>)[key])]),
	)
}

export function digestJson(value: unknown): string {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(stableValue(value)))
		.digest("hex")}`
}

export function withDigest<T extends Record<string, unknown>>(value: T): T & { digest: string } {
	return { ...value, digest: digestJson(value) }
}

export function verifyDigest(value: Record<string, unknown>, label: string): string {
	const digest = value.digest
	if (typeof digest !== "string") throw new Error(`${label} is missing its digest`)
	const { digest: _ignored, ...unsigned } = value
	const actual = digestJson(unsigned)
	if (digest !== actual) throw new Error(`${label} digest mismatch: recorded ${digest}, calculated ${actual}`)
	return digest
}

export function atomicWriteJson(file: string, value: unknown): void {
	const resolved = path.resolve(file)
	fs.mkdirSync(path.dirname(resolved), { recursive: true })
	const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry), 2)}\n`, {
			mode: 0o600,
		})
		fs.renameSync(temporary, resolved)
	} catch (error) {
		try {
			fs.unlinkSync(temporary)
		} catch {}
		throw error
	}
}
