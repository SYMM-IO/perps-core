import fs from "fs"
import path from "path"

// Protocol parameters and InstantLayer templates used to be hardcoded inline in
// deployAll.ts, so every chain got the same values and there was no way to reproduce an
// existing deployment's configuration. They live here instead, overridable per chain via
// tasks/config/protocol-<chainId>.json.
//
// Template ORDER is significant: templates are addressed by the id assigned at creation
// (0, 1, 2, ...) and hedgers reference those ids. Reordering this array on a chain that is
// already live changes what each id means.

const CONFIG_DIR = "./tasks/config"

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
		{
			// Gas-optimized open via _callWithMargin + lockAndOpenPosition. Op 0 targets the
			// AccountLayer directly, so its raw result is the abi-encoded bytes[] return value:
			// [0x20][len=1][0x20][elemLen=32][quoteId] — the quoteId sits at byte offset 128.
			name: "InstantOpenCompact",
			instantOpenMode: true,
			operations: [
				{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // _callWithMargin([sendQuote]) on AccountLayer
				{ sourceIndices: [0], insertionPoints: [0], sourceOffsets: [128] }, // lockAndOpenPosition - quoteId from op 0
			],
		},
	],
}

export function protocolConfigPath(chainId: number | bigint): string {
	return path.join(CONFIG_DIR, `protocol-${Number(chainId)}.json`)
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
		return DEFAULT_PROTOCOL_CONFIG
	}

	let parsed: ProtocolConfig
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as ProtocolConfig
	} catch (err) {
		throw new Error(`Failed to parse ${configPath}: ${err}`)
	}

	if (!parsed.parameters) throw new Error(`${configPath} is missing a "parameters" object`)
	if (!Array.isArray(parsed.instantLayerTemplates)) {
		throw new Error(`${configPath} is missing an "instantLayerTemplates" array`)
	}

	const missing = (Object.keys(DEFAULT_PROTOCOL_CONFIG.parameters) as Array<keyof ProtocolParameters>).filter(k => parsed.parameters[k] === undefined)
	if (missing.length > 0) {
		throw new Error(`${configPath} is missing parameters: ${missing.join(", ")}`)
	}

	console.log(`  Loaded protocol config from ${configPath}`)
	if (parsed.description) console.log(`    ${parsed.description}`)
	return parsed
}
