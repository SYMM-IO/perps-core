import fs from "fs"
import { fileURLToPath } from "node:url"
import path from "path"

// Protocol parameters and InstantLayer templates used to be hardcoded inline in
// deployAll.ts, so every chain got the same values and there was no way to reproduce an
// existing deployment's configuration. They live here instead, overridable per chain via
// tasks/config/protocol-<chainId>.json.
//
// Template ORDER is significant: templates are addressed by the id assigned at creation
// (0, 1, 2, ...) and hedgers reference those ids. Reordering this array on a chain that is
// already live changes what each id means.

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const CONFIG_DIR = path.join(PROJECT_ROOT, "tasks", "config")

export interface TemplateOperation {
	insertionPoints: number[]
	sourceIndices: number[]
	sourceOffsets: number[]
}

export interface TemplateConfig {
	name: string
	/** Enables instantOpenMode for this template — skips pending-balance round-trips. */
	instantOpenMode?: boolean
	operations: TemplateOperation[]
}

export interface ProtocolParameters {
	/** Max collateral a single user may hold, in collateral-token units (wei-scaled). */
	balanceLimitPerUser: string
	maxWithdrawParts: number
	/** Sets minWithdrawCooldown on-chain (the setter is still named setDeallocateCooldown). */
	deallocateCooldown: number
	settlementCooldown: number
	deallocateDebounceTime: number
	/** 1e18-scaled share of remaining LF paid to the liquidation initiator. */
	liquidatorShare: string
	liquidationTimeout: number
	/** [forceCloseFirstCooldown, forceCloseSecondCooldown] */
	forceCloseCooldowns: [number, number]
	forceCancelCooldown: number
	forceCancelCloseCooldown: number
	pendingQuotesValidLength: number
	maxPartyAConnectionLimit: number
}

export interface ProtocolConfig {
	/** Free-text note describing where these values came from. */
	description?: string
	parameters: ProtocolParameters
	instantLayerTemplates: TemplateConfig[]
}

function normalizeNumberishArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null
	try {
		return value.map(entry => BigInt(entry as any).toString())
	} catch {
		return null
	}
}

/** Return precise differences between an on-chain InstantLayer template and its config. */
export function templateConfigMismatches(templateId: number, actual: any, expected: TemplateConfig, instantOpenMode?: boolean): string[] {
	const prefix = `template ${templateId} (${expected.name})`
	const mismatches: string[] = []
	if (!actual || actual.name !== expected.name)
		mismatches.push(`${prefix} name: expected ${JSON.stringify(expected.name)}, got ${JSON.stringify(actual?.name)}`)
	if (actual?.active !== true) mismatches.push(`${prefix} active: expected true, got ${String(actual?.active)}`)

	const actualOperations = Array.isArray(actual?.operations) ? actual.operations : []
	if (actualOperations.length !== expected.operations.length) {
		mismatches.push(`${prefix} operation count: expected ${expected.operations.length}, got ${actualOperations.length}`)
	}
	for (let operationIndex = 0; operationIndex < Math.min(actualOperations.length, expected.operations.length); operationIndex++) {
		const actualOperation = actualOperations[operationIndex]
		const expectedOperation = expected.operations[operationIndex]
		for (const field of ["insertionPoints", "sourceIndices", "sourceOffsets"] as const) {
			const actualValues = normalizeNumberishArray(actualOperation?.[field])
			const expectedValues = expectedOperation[field].map(value => BigInt(value).toString())
			if (!actualValues || actualValues.length !== expectedValues.length || actualValues.some((value, index) => value !== expectedValues[index])) {
				mismatches.push(
					`${prefix} operation ${operationIndex} ${field}: expected [${expectedValues.join(",")}], got [${actualValues?.join(",") ?? "invalid"}]`,
				)
			}
		}
	}

	if (instantOpenMode !== undefined && instantOpenMode !== Boolean(expected.instantOpenMode)) {
		mismatches.push(`${prefix} instantOpenMode: expected ${Boolean(expected.instantOpenMode)}, got ${instantOpenMode}`)
	}
	return mismatches
}

/** Decide whether a resumable deployment must add or recover one ordered template. */
export function resolveTemplateAddResumeAction(
	templateId: number,
	nextTemplateId: bigint,
	actual: any | undefined,
	expected: TemplateConfig,
	checkpointComplete: boolean,
): "add" | "present" {
	if (nextTemplateId < BigInt(templateId)) {
		throw new Error(`InstantLayer nextTemplateId is ${nextTemplateId}, but template ${templateId} is next in the reviewed config`)
	}
	if (nextTemplateId > BigInt(templateId)) {
		const mismatches = templateConfigMismatches(templateId, actual, expected)
		if (mismatches.length > 0) throw new Error(`Refusing to resume over an unexpected InstantLayer template:\n- ${mismatches.join("\n- ")}`)
		return "present"
	}
	if (checkpointComplete) {
		throw new Error(`Checkpoint marks template ${templateId} complete, but InstantLayer nextTemplateId is only ${nextTemplateId}`)
	}
	return "add"
}

const ONE = BigInt(1)
const ONE_18 = BigInt("1000000000000000000")
const UINT256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1)

function configError(source: string, field: string, message: string): never {
	throw new Error(`${source}: ${field} ${message}`)
}

function requireObject(value: unknown, source: string, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) configError(source, field, "must be an object")
	return value as Record<string, unknown>
}

function requireInteger(value: unknown, source: string, field: string, minimum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		configError(source, field, `must be a safe integer >= ${minimum}`)
	}
	return value
}

function requireUintString(value: unknown, source: string, field: string, options: { min?: bigint; max?: bigint } = {}): string {
	if (typeof value !== "string" || !/^\d+$/.test(value)) configError(source, field, "must be an unsigned base-10 integer string")
	const parsed = BigInt(value)
	if (options.min !== undefined && parsed < options.min) configError(source, field, `must be >= ${options.min}`)
	if (options.max !== undefined && parsed > options.max) configError(source, field, `must be <= ${options.max}`)
	return value
}

/**
 * Validate every value consumed by deploy:system before the first transaction is sent.
 *
 * Template source indices may only point to an earlier operation: when operation N runs,
 * InstantLayer has exactly N results available. A forward/self reference is guaranteed to
 * revert at execution time even though addTemplate itself accepts it.
 */
export function validateProtocolConfig(value: unknown, source = "protocol config"): asserts value is ProtocolConfig {
	const config = requireObject(value, source, "config")
	if (config.description !== undefined && typeof config.description !== "string") {
		configError(source, "description", "must be a string when provided")
	}
	const parameters = requireObject(config.parameters, source, "parameters")

	requireUintString(parameters.balanceLimitPerUser, source, "parameters.balanceLimitPerUser", { min: ONE, max: UINT256_MAX })
	requireInteger(parameters.maxWithdrawParts, source, "parameters.maxWithdrawParts", 1)
	requireInteger(parameters.deallocateCooldown, source, "parameters.deallocateCooldown", 1)
	requireInteger(parameters.settlementCooldown, source, "parameters.settlementCooldown", 1)
	// Zero is a deliberate, supported value on Arbitrum.
	requireInteger(parameters.deallocateDebounceTime, source, "parameters.deallocateDebounceTime", 0)
	requireUintString(parameters.liquidatorShare, source, "parameters.liquidatorShare", { min: ONE, max: ONE_18 })
	requireInteger(parameters.liquidationTimeout, source, "parameters.liquidationTimeout", 1)
	requireInteger(parameters.forceCancelCooldown, source, "parameters.forceCancelCooldown", 1)
	requireInteger(parameters.forceCancelCloseCooldown, source, "parameters.forceCancelCloseCooldown", 1)
	requireInteger(parameters.pendingQuotesValidLength, source, "parameters.pendingQuotesValidLength", 1)
	requireInteger(parameters.maxPartyAConnectionLimit, source, "parameters.maxPartyAConnectionLimit", 1)

	if (!Array.isArray(parameters.forceCloseCooldowns) || parameters.forceCloseCooldowns.length !== 2) {
		configError(source, "parameters.forceCloseCooldowns", "must be a two-item tuple")
	}
	requireInteger(parameters.forceCloseCooldowns[0], source, "parameters.forceCloseCooldowns[0]", 1)
	requireInteger(parameters.forceCloseCooldowns[1], source, "parameters.forceCloseCooldowns[1]", 1)

	if (!Array.isArray(config.instantLayerTemplates) || config.instantLayerTemplates.length === 0) {
		configError(source, "instantLayerTemplates", "must be a non-empty array")
	}

	const names = new Set<string>()
	for (const [templateIndex, rawTemplate] of config.instantLayerTemplates.entries()) {
		const templateField = `instantLayerTemplates[${templateIndex}]`
		const template = requireObject(rawTemplate, source, templateField)
		if (typeof template.name !== "string" || template.name.trim() === "" || template.name !== template.name.trim()) {
			configError(source, `${templateField}.name`, "must be a non-empty trimmed string")
		}
		if (names.has(template.name)) configError(source, `${templateField}.name`, `duplicates template name "${template.name}"`)
		names.add(template.name)

		if (template.instantOpenMode !== undefined && typeof template.instantOpenMode !== "boolean") {
			configError(source, `${templateField}.instantOpenMode`, "must be a boolean when provided")
		}
		if (!Array.isArray(template.operations) || template.operations.length === 0) {
			configError(source, `${templateField}.operations`, "must be a non-empty array")
		}

		for (const [operationIndex, rawOperation] of template.operations.entries()) {
			const operationField = `${templateField}.operations[${operationIndex}]`
			const operation = requireObject(rawOperation, source, operationField)
			const arrayNames = ["insertionPoints", "sourceIndices", "sourceOffsets"] as const

			for (const arrayName of arrayNames) {
				const entries = operation[arrayName]
				if (!Array.isArray(entries)) configError(source, `${operationField}.${arrayName}`, "must be an array")
				for (const [entryIndex, entry] of entries.entries()) {
					requireInteger(entry, source, `${operationField}.${arrayName}[${entryIndex}]`, 0)
				}
			}

			const insertionPoints = operation.insertionPoints as number[]
			const sourceIndices = operation.sourceIndices as number[]
			const sourceOffsets = operation.sourceOffsets as number[]
			if (insertionPoints.length !== sourceIndices.length || insertionPoints.length !== sourceOffsets.length) {
				configError(source, operationField, "must have equal insertionPoints, sourceIndices, and sourceOffsets lengths")
			}
			for (const [entryIndex, sourceIndex] of sourceIndices.entries()) {
				if (sourceIndex >= operationIndex) {
					configError(source, `${operationField}.sourceIndices[${entryIndex}]`, `must reference an earlier operation (index < ${operationIndex})`)
				}
			}
		}
	}
}

/**
 * Defaults preserve the values that were previously hardcoded in deployAll.ts, so a chain
 * with no config file behaves exactly as before.
 */
export const DEFAULT_PROTOCOL_CONFIG: ProtocolConfig = {
	description: "Built-in defaults (previously hardcoded in deployAll.ts)",
	parameters: {
		balanceLimitPerUser: "10000000000000000000000", // 10_000e18
		maxWithdrawParts: 10,
		deallocateCooldown: 120,
		settlementCooldown: 300,
		deallocateDebounceTime: 120,
		liquidatorShare: "100000000000000000", // 0.1e18
		liquidationTimeout: 100,
		forceCloseCooldowns: [300, 120],
		forceCancelCooldown: 300,
		forceCancelCloseCooldown: 300,
		pendingQuotesValidLength: 10,
		maxPartyAConnectionLimit: 5,
	},
	instantLayerTemplates: [
		{
			name: "InstantOpen",
			instantOpenMode: true,
			operations: [
				{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // addMarginToNextVA
				{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // sendQuote
				{ sourceIndices: [1], insertionPoints: [0], sourceOffsets: [0] }, // lockQuote
				{ sourceIndices: [1], insertionPoints: [0], sourceOffsets: [0] }, // openPosition
			],
		},
		{
			name: "InstantClose",
			operations: [
				{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // requestToClosePosition
				{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // fillCloseRequest
			],
		},
		{
			name: "InstantCloseWithAllocation",
			operations: [
				{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] },
				{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] },
				{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] },
			],
		},
		{
			name: "InstantOpenWithCustomVA",
			operations: [
				{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // create custom VA
				{ sourceIndices: [0], insertionPoints: [0], sourceOffsets: [0] }, // addMargin
				{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // sendQuote
				{ sourceIndices: [2], insertionPoints: [0], sourceOffsets: [0] }, // lockQuote
				{ sourceIndices: [2], insertionPoints: [0], sourceOffsets: [0] }, // openPosition
			],
		},
		{
			name: "InstantCloseWithParentAllocation",
			operations: [
				{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // request close
				{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // fill close
				{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // balanceOf(parent)
				{ sourceIndices: [2], insertionPoints: [0], sourceOffsets: [0] }, // allocate
			],
		},
	],
}

export function protocolConfigPath(chainId: number | bigint): string {
	return path.join(CONFIG_DIR, `protocol-${Number(chainId)}.json`)
}

export function hasChainProtocolConfig(chainId: number | bigint): boolean {
	return fs.existsSync(protocolConfigPath(chainId))
}

/**
 * Load the protocol config for a chain, falling back to the built-in defaults.
 * A malformed file is a hard error — silently deploying default parameters onto a chain
 * that was meant to mirror another deployment is exactly the kind of quiet wrong that is
 * expensive to discover later.
 */
export function loadProtocolConfig(chainId: number | bigint): ProtocolConfig {
	const configPath = protocolConfigPath(chainId)
	if (!fs.existsSync(configPath)) {
		console.log(`  No ${configPath} — using built-in default protocol parameters and templates.`)
		validateProtocolConfig(DEFAULT_PROTOCOL_CONFIG, "built-in protocol config")
		return DEFAULT_PROTOCOL_CONFIG
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf8"))
	} catch (err) {
		throw new Error(`Failed to parse ${configPath}: ${err}`)
	}

	validateProtocolConfig(parsed, configPath)

	console.log(`  Loaded protocol config from ${configPath}`)
	if (parsed.description) console.log(`    ${parsed.description}`)
	return parsed
}
