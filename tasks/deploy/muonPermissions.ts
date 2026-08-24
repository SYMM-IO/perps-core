/**
 * Canonical Muon permission metadata. The order and indices must stay aligned with
 * MuonFunction in contracts/core/interfaces/IMuonSignatureVerifier.sol.
 */
export const MUON_FUNCTIONS = [
	{ name: "Trading", index: 0 },
	{ name: "AccountManagement", index: 1 },
	{ name: "Settlement", index: 2 },
	{ name: "ForceClose", index: 3 },
	{ name: "Funding", index: 4 },
	{ name: "LiquidationPartyA", index: 5 },
	{ name: "LiquidationPartyB", index: 6 },
	{ name: "RemoveMargin", index: 7 },
	{ name: "ExpressCredit", index: 8 },
] as const

export type MuonFunctionDefinition = (typeof MUON_FUNCTIONS)[number]
export type MuonFunctionName = MuonFunctionDefinition["name"]
export type MuonFunctionIndex = MuonFunctionDefinition["index"]

export const MUON_FUNCTION_NAMES: readonly MuonFunctionName[] = MUON_FUNCTIONS.map(({ name }) => name)
export const MUON_FUNCTION_INDICES: readonly MuonFunctionIndex[] = MUON_FUNCTIONS.map(({ index }) => index)

const MUON_FUNCTION_BY_NAME = new Map<string, MuonFunctionDefinition>(MUON_FUNCTIONS.map(definition => [definition.name, definition]))

// Express credit uses its own freshness window in the Express Provider. It is a
// verifier authorization category, not a Core UPNL-validity category.
const MUON_UPNL_FUNCTIONS = MUON_FUNCTIONS.filter(({ name }) => name !== "ExpressCredit")
const MUON_UPNL_FUNCTION_NAMES = MUON_UPNL_FUNCTIONS.map(({ name }) => name)
const MUON_UPNL_FUNCTION_BY_NAME = new Map<string, MuonFunctionDefinition>(MUON_UPNL_FUNCTIONS.map(definition => [definition.name, definition]))

export type MuonPublicKey = {
	x: string | bigint
	parity: number
}

export interface MuonAuthorizationReader {
	isPublicKeyAuthorized(publicKey: MuonPublicKey, functionIndex: MuonFunctionIndex): Promise<boolean>
	isGatewaySignerAuthorized(signer: string, functionIndex: MuonFunctionIndex): Promise<boolean>
}

export type MuonPermissionAuthorization = MuonFunctionDefinition & {
	authorized: boolean
}

export type MuonPublicKeyAuthorization = {
	publicKey: MuonPublicKey
	permissions: MuonPermissionAuthorization[]
	missingPermissions: MuonFunctionName[]
	fullyAuthorized: boolean
}

export type MuonGatewaySignerAuthorization = {
	signer: string
	permissions: MuonPermissionAuthorization[]
	missingPermissions: MuonFunctionName[]
	fullyAuthorized: boolean
}

export type MuonPermissionInspection = {
	permissions: MuonFunctionDefinition[]
	publicKeys: MuonPublicKeyAuthorization[]
	gatewaySigners: MuonGatewaySignerAuthorization[]
	missingAuthorizationCount: number
	fullyAuthorized: boolean
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve an already-tokenized permission list. Names are exact and case-sensitive;
 * surrounding whitespace, empty entries, duplicates, and unknown names are rejected.
 */
export function resolveMuonFunctionPermissions(permissionNames: readonly string[], label = "Muon function permissions"): MuonFunctionDefinition[] {
	if (!Array.isArray(permissionNames) || permissionNames.length === 0) {
		throw new Error(`${label} must contain at least one MuonFunction name`)
	}

	const seen = new Set<MuonFunctionName>()
	const resolved: MuonFunctionDefinition[] = []

	for (const [index, rawName] of permissionNames.entries()) {
		if (typeof rawName !== "string" || rawName.length === 0) {
			throw new Error(`${label}[${index}] must be a non-empty MuonFunction name`)
		}
		if (rawName.trim() !== rawName) {
			throw new Error(`${label}[${index}] must not contain surrounding whitespace: ${JSON.stringify(rawName)}`)
		}

		const definition = MUON_FUNCTION_BY_NAME.get(rawName)
		if (!definition) {
			throw new Error(`Unknown MuonFunction in ${label}: ${rawName}. Valid values: ${MUON_FUNCTION_NAMES.join(", ")}`)
		}
		if (seen.has(definition.name)) {
			throw new Error(`Duplicate MuonFunction in ${label}: ${definition.name}`)
		}

		seen.add(definition.name)
		resolved.push(definition)
	}

	return resolved
}

/** Parse a comma-delimited environment/CLI value into validated definitions. */
export function parseMuonFunctionPermissions(rawValue: string, label = "MUON_FUNCTION_PERMISSIONS"): MuonFunctionDefinition[] {
	if (typeof rawValue !== "string" || rawValue.trim() === "") {
		throw new Error(`${label} must be a non-empty comma-separated list of MuonFunction names`)
	}

	const rawEntries = rawValue.split(",")
	const names = rawEntries.map((entry, index) => {
		const name = entry.trim()
		if (name === "") throw new Error(`${label} contains an empty entry at position ${index + 1}`)
		return name
	})

	return resolveMuonFunctionPermissions(names, label)
}

export type MuonFunctionUpnlValidTime = MuonFunctionDefinition & {
	upnlValidTime: string
}

const UINT256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1)

/**
 * Resolve per-function UPNL validity overrides into canonical Solidity enum order.
 *
 * On-chain, zero is the unset value: setMuonFunctionUpnlValidTime(func, 0) deletes the
 * override and falls back to the global window. A recipe therefore expresses "no override"
 * by omitting the function, and a zero value is rejected as ambiguous.
 */
export function resolveMuonFunctionUpnlValidTimes(
	entries: Readonly<Record<string, string>>,
	label = "Muon per-function UPNL validity",
): MuonFunctionUpnlValidTime[] {
	if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
		throw new Error(`${label} must be an object keyed by MuonFunction name`)
	}

	const resolved = new Map<MuonFunctionName, MuonFunctionUpnlValidTime>()

	for (const [rawName, rawValue] of Object.entries(entries)) {
		const definition = MUON_UPNL_FUNCTION_BY_NAME.get(rawName)
		if (!definition) {
			throw new Error(`Unknown UPNL MuonFunction in ${label}: ${rawName}. Valid values: ${MUON_UPNL_FUNCTION_NAMES.join(", ")}`)
		}
		if (resolved.has(definition.name)) throw new Error(`Duplicate MuonFunction in ${label}: ${definition.name}`)

		if (typeof rawValue !== "string" || !/^(0|[1-9]\d*)$/.test(rawValue)) {
			throw new Error(`${label}.${definition.name} must be a canonical unsigned base-10 integer string; received ${JSON.stringify(rawValue)}`)
		}
		const seconds = BigInt(rawValue)
		if (seconds === BigInt(0)) {
			throw new Error(`${label}.${definition.name} must be >= 1; omit the entry to fall back to the global UPNL validity`)
		}
		if (seconds > UINT256_MAX) throw new Error(`${label}.${definition.name} must fit in uint256`)

		resolved.set(definition.name, { ...definition, upnlValidTime: seconds.toString() })
	}

	// Canonical enum order keeps the write sequence and the report deterministic.
	return MUON_UPNL_FUNCTIONS.filter(({ name }) => resolved.has(name)).map(({ name }) => resolved.get(name)!)
}

/** Parse a `Name=seconds,Name=seconds` environment/CLI value into validated overrides. */
export function parseMuonFunctionUpnlValidTimes(rawValue: string, label = "MUON_FUNCTION_UPNL_VALID_TIMES"): MuonFunctionUpnlValidTime[] {
	if (typeof rawValue !== "string" || rawValue.trim() === "") return []

	const entries: Record<string, string> = {}
	for (const [index, rawEntry] of rawValue.split(",").entries()) {
		const entry = rawEntry.trim()
		if (entry === "") throw new Error(`${label} contains an empty entry at position ${index + 1}`)

		const separator = entry.indexOf("=")
		if (separator <= 0 || separator === entry.length - 1) {
			throw new Error(`${label} entry at position ${index + 1} must use the form MuonFunction=seconds; received ${JSON.stringify(entry)}`)
		}

		const name = entry.slice(0, separator).trim()
		if (Object.prototype.hasOwnProperty.call(entries, name)) throw new Error(`Duplicate MuonFunction in ${label}: ${name}`)
		entries[name] = entry.slice(separator + 1).trim()
	}

	return resolveMuonFunctionUpnlValidTimes(entries, label)
}

/** Project validated overrides back into the `Name=seconds,...` transport form. */
export function formatMuonFunctionUpnlValidTimes(overrides: readonly MuonFunctionUpnlValidTime[]): string {
	return overrides.map(({ name, upnlValidTime }) => `${name}=${upnlValidTime}`).join(",")
}

/**
 * General production deployments exercise every Muon category. This validation
 * deliberately rejects partial permission profiles before any transaction is sent
 * and returns the canonical Solidity enum order for writes and verification reads.
 */
export function assertGeneralDeploymentMuonPermissions(
	permissionNames: readonly string[],
	label = "Muon function permissions",
): MuonFunctionDefinition[] {
	const resolved = resolveMuonFunctionPermissions(permissionNames, label)
	const configuredNames = new Set(resolved.map(({ name }) => name))
	const missing = MUON_FUNCTION_NAMES.filter(name => !configuredNames.has(name))

	if (missing.length > 0) {
		throw new Error(`${label} is incomplete for a general system deployment; missing: ${missing.join(", ")}`)
	}

	return [...MUON_FUNCTIONS]
}

async function inspectPublicKey(
	reader: MuonAuthorizationReader,
	publicKey: MuonPublicKey,
	permissions: readonly MuonFunctionDefinition[],
): Promise<MuonPublicKeyAuthorization> {
	const authorization = await Promise.all(
		permissions.map(async definition => {
			try {
				return { ...definition, authorized: Boolean(await reader.isPublicKeyAuthorized(publicKey, definition.index)) }
			} catch (error) {
				throw new Error(
					`Failed to inspect Muon public key x=${String(publicKey.x)}, parity=${publicKey.parity} for ${definition.name} ` +
						`(${definition.index}): ${describeError(error)}`,
				)
			}
		}),
	)
	const missingPermissions = authorization.filter(({ authorized }) => !authorized).map(({ name }) => name)

	return {
		publicKey,
		permissions: authorization,
		missingPermissions,
		fullyAuthorized: missingPermissions.length === 0,
	}
}

async function inspectGatewaySigner(
	reader: MuonAuthorizationReader,
	signer: string,
	permissions: readonly MuonFunctionDefinition[],
): Promise<MuonGatewaySignerAuthorization> {
	const authorization = await Promise.all(
		permissions.map(async definition => {
			try {
				return { ...definition, authorized: Boolean(await reader.isGatewaySignerAuthorized(signer, definition.index)) }
			} catch (error) {
				throw new Error(`Failed to inspect Muon gateway signer ${signer} for ${definition.name} (${definition.index}): ${describeError(error)}`)
			}
		}),
	)
	const missingPermissions = authorization.filter(({ authorized }) => !authorized).map(({ name }) => name)

	return {
		signer,
		permissions: authorization,
		missingPermissions,
		fullyAuthorized: missingPermissions.length === 0,
	}
}

/** Inspect every configured key and gateway against every configured permission. */
export async function inspectConfiguredMuonPermissions(
	reader: MuonAuthorizationReader,
	config: {
		publicKeys?: readonly MuonPublicKey[]
		gatewaySigners?: readonly string[]
		permissionNames: readonly string[]
	},
): Promise<MuonPermissionInspection> {
	const permissions = resolveMuonFunctionPermissions(config.permissionNames)
	const publicKeys = config.publicKeys ?? []
	const gatewaySigners = config.gatewaySigners ?? []

	const publicKeyIdentities = publicKeys.map(key => `${String(key.x)}:${key.parity}`)
	if (new Set(publicKeyIdentities).size !== publicKeyIdentities.length) {
		throw new Error("Configured Muon public keys must not contain duplicates")
	}
	const normalizedGatewaySigners = gatewaySigners.map(signer => signer.toLowerCase())
	if (new Set(normalizedGatewaySigners).size !== normalizedGatewaySigners.length) {
		throw new Error("Configured Muon gateway signers must not contain duplicate addresses")
	}

	const publicKeyResults: MuonPublicKeyAuthorization[] = []
	for (const publicKey of publicKeys) publicKeyResults.push(await inspectPublicKey(reader, publicKey, permissions))

	const gatewaySignerResults: MuonGatewaySignerAuthorization[] = []
	for (const signer of gatewaySigners) gatewaySignerResults.push(await inspectGatewaySigner(reader, signer, permissions))

	const missingAuthorizationCount = [...publicKeyResults, ...gatewaySignerResults].reduce(
		(total, result) => total + result.missingPermissions.length,
		0,
	)

	return {
		permissions,
		publicKeys: publicKeyResults,
		gatewaySigners: gatewaySignerResults,
		missingAuthorizationCount,
		fullyAuthorized: missingAuthorizationCount === 0,
	}
}

/** Turn an inspection report into a fail-closed deployment assertion. */
export function assertConfiguredMuonPermissionsAuthorized(inspection: MuonPermissionInspection, label = "MuonSignatureVerifier"): void {
	if (inspection.fullyAuthorized) return

	const problems = [
		...inspection.publicKeys
			.filter(result => !result.fullyAuthorized)
			.map(
				result => `public key x=${String(result.publicKey.x)}, parity=${result.publicKey.parity} is missing ${result.missingPermissions.join(", ")}`,
			),
		...inspection.gatewaySigners
			.filter(result => !result.fullyAuthorized)
			.map(result => `gateway signer ${result.signer} is missing ${result.missingPermissions.join(", ")}`),
	]

	throw new Error(`${label} permission verification failed:\n  - ${problems.join("\n  - ")}`)
}
