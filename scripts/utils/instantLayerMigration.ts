/**
 * Pure planning helpers for replacing a deployed InstantLayer.
 *
 * The InstantLayer is not upgradeable, so a redeploy means: replay the old layer's configuration
 * onto a fresh contract (deployer-side, before the handover), then re-point every contract that
 * holds the old address (Safe-side). Everything here is deterministic and chain-free so the plan
 * and the Safe batches can be unit-tested and reviewed before anything is broadcast.
 */
import { Interface, ZeroAddress, ZeroHash, getAddress, keccak256, toUtf8Bytes } from "ethers"

export interface TemplateOperation {
	insertionPoints: bigint[]
	sourceIndices: bigint[]
	sourceOffsets: bigint[]
}

export interface TemplateSnapshot {
	id: bigint
	name: string
	active: boolean
	instantOpenMode: boolean
	operations: TemplateOperation[]
}

export type InstantLayerRoleName = "DEFAULT_ADMIN_ROLE" | "SETTER_ROLE" | "OPERATOR_ROLE" | "REVOKER_ROLE"
export const INSTANT_LAYER_ROLE_NAMES: readonly InstantLayerRoleName[] = ["DEFAULT_ADMIN_ROLE", "SETTER_ROLE", "OPERATOR_ROLE", "REVOKER_ROLE"]

export interface InstantLayerSnapshot {
	address: string
	symmio: string
	accountLayer: string
	revocationCooldown: bigint
	transientContextEnabled: boolean
	whitelistedTargets: string[]
	registeredPartyBs: string[]
	templates: TemplateSnapshot[]
	roles: Record<InstantLayerRoleName, string[]>
}

export type ReplayActionKind =
	| "setAccountLayer"
	| "setTargetWhitelist"
	| "registerPartyBs"
	| "addTemplate"
	| "setTemplateInstantOpenMode"
	| "setTemplateActive"
	| "setRevocationCooldown"
	| "setTransientContextEnabled"
	| "grantRole"

export interface ReplayAction {
	kind: ReplayActionKind
	args: unknown[]
	description: string
}

export interface SafeAction {
	to: string
	value: "0"
	data: string
	description: string
}

// Values the InstantLayer constructor already establishes; replaying them would be a no-op.
const CONSTRUCTOR_REVOCATION_COOLDOWN = 600n
const CONSTRUCTOR_TRANSIENT_CONTEXT_ENABLED = true

export const roleHash = (name: string): string => (name === "DEFAULT_ADMIN_ROLE" ? ZeroHash : keccak256(toUtf8Bytes(name)))

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * Build the deployer-side actions that make a fresh InstantLayer configured like `snapshot`.
 * Templates are replayed in id order because off-chain services address templates by id.
 * Role holders other than the Safe, the deployer, and registered PartyBs are replicated; the
 * Safe's own roles are granted during the handover, PartyBs receive OPERATOR_ROLE from
 * registerPartyBs.
 */
export function buildInstantLayerReplayPlan(snapshot: InstantLayerSnapshot, context: { deployer: string; safe: string }): ReplayAction[] {
	const deployer = getAddress(context.deployer)
	const safe = getAddress(context.safe)
	for (const name of INSTANT_LAYER_ROLE_NAMES) {
		if ((snapshot.roles[name] || []).some(holder => same(holder, deployer))) {
			throw new Error(`The migration deployer ${deployer} still holds ${name} on the old InstantLayer; use a deployer that was fully revoked`)
		}
	}

	const plan: ReplayAction[] = []
	if (snapshot.accountLayer && snapshot.accountLayer !== ZeroAddress) {
		plan.push({ kind: "setAccountLayer", args: [getAddress(snapshot.accountLayer)], description: `setAccountLayer(${snapshot.accountLayer})` })
	}
	for (const target of snapshot.whitelistedTargets) {
		if (same(target, snapshot.symmio)) continue // whitelisted by the constructor
		plan.push({ kind: "setTargetWhitelist", args: [getAddress(target), true], description: `setTargetWhitelist(${target}, true)` })
	}
	if (snapshot.registeredPartyBs.length > 0) {
		const partyBs = snapshot.registeredPartyBs.map(getAddress)
		plan.push({ kind: "registerPartyBs", args: [partyBs], description: `registerPartyBs([${partyBs.join(", ")}])` })
	}
	const orderedTemplates = [...snapshot.templates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
	orderedTemplates.forEach((template, index) => {
		if (template.id !== BigInt(index)) throw new Error(`Template ids are not contiguous: expected ${index}, found ${template.id}`)
		plan.push({ kind: "addTemplate", args: [template.name, template.operations], description: `addTemplate(${template.id}: ${template.name})` })
		if (template.instantOpenMode) {
			plan.push({ kind: "setTemplateInstantOpenMode", args: [template.id, true], description: `setTemplateInstantOpenMode(${template.id}, true)` })
		}
		if (!template.active) {
			plan.push({ kind: "setTemplateActive", args: [template.id, false], description: `setTemplateActive(${template.id}, false)` })
		}
	})
	if (snapshot.revocationCooldown !== CONSTRUCTOR_REVOCATION_COOLDOWN) {
		plan.push({
			kind: "setRevocationCooldown",
			args: [snapshot.revocationCooldown],
			description: `setRevocationCooldown(${snapshot.revocationCooldown})`,
		})
	}
	if (snapshot.transientContextEnabled !== CONSTRUCTOR_TRANSIENT_CONTEXT_ENABLED) {
		plan.push({
			kind: "setTransientContextEnabled",
			args: [snapshot.transientContextEnabled],
			description: `setTransientContextEnabled(${snapshot.transientContextEnabled})`,
		})
	}
	const partyBs = snapshot.registeredPartyBs.map(getAddress)
	for (const name of INSTANT_LAYER_ROLE_NAMES) {
		for (const holder of snapshot.roles[name] || []) {
			const account = getAddress(holder)
			if (same(account, safe) || same(account, deployer)) continue
			if (name === "OPERATOR_ROLE" && partyBs.some(p => same(p, account))) continue
			plan.push({ kind: "grantRole", args: [roleHash(name), account], description: `grantRole(${name}, ${account})` })
		}
	}
	return plan
}

const DIAMOND_ROLES = new Interface(["function grantRole(address user, bytes32 role)", "function revokeRole(address user, bytes32 role)"])
const PARTY_B = new Interface([
	"function grantRole(bytes32 role, address account)",
	"function revokeRole(bytes32 role, address account)",
	"function setMulticastWhitelist(address addr, bool state)",
])
const GASLESS = new Interface(["function upgradeToAndCall(address newImplementation, bytes data)", "function setInstantLayer(address instantLayer_)"])

export interface CutoverTargets {
	core: string
	accountLayer: string
	partyBs: string[]
	gaslessLayer: string
	newGaslessImplementation: string
	newInstantLayer: string
}

/** Safe-side actions that make the new InstantLayer live. The old layer keeps its bindings. */
export function buildCutoverSafeActions(t: CutoverTargets): SafeAction[] {
	const il = getAddress(t.newInstantLayer)
	const actions: SafeAction[] = [
		{
			to: getAddress(t.core),
			value: "0",
			data: DIAMOND_ROLES.encodeFunctionData("grantRole", [il, roleHash("INSTANT_LAYER_ROLE")]),
			description: `Core: grant INSTANT_LAYER_ROLE to new InstantLayer ${il}`,
		},
		{
			to: getAddress(t.accountLayer),
			value: "0",
			data: DIAMOND_ROLES.encodeFunctionData("grantRole", [il, roleHash("SIGNER_SETTER_ROLE")]),
			description: `AccountLayer: grant SIGNER_SETTER_ROLE to new InstantLayer ${il}`,
		},
	]
	for (const partyB of t.partyBs.map(getAddress)) {
		actions.push(
			{
				to: partyB,
				value: "0",
				data: PARTY_B.encodeFunctionData("grantRole", [roleHash("TRUSTED_ROLE"), il]),
				description: `SymmioPartyB ${partyB}: grant TRUSTED_ROLE to new InstantLayer`,
			},
			{
				to: partyB,
				value: "0",
				data: PARTY_B.encodeFunctionData("setMulticastWhitelist", [il, true]),
				description: `SymmioPartyB ${partyB}: whitelist new InstantLayer for multicast`,
			},
		)
	}
	actions.push({
		to: getAddress(t.gaslessLayer),
		value: "0",
		data: GASLESS.encodeFunctionData("upgradeToAndCall", [
			getAddress(t.newGaslessImplementation),
			GASLESS.encodeFunctionData("setInstantLayer", [il]),
		]),
		description: `GaslessLayer: upgrade to ${getAddress(t.newGaslessImplementation)} and setInstantLayer(${il})`,
	})
	return actions
}

export interface DecommissionTargets {
	core: string
	accountLayer: string
	partyBs: string[]
	oldInstantLayer: string
}

/** Safe-side actions that retire the old InstantLayer once the transition window is over. */
export function buildDecommissionSafeActions(t: DecommissionTargets): SafeAction[] {
	const il = getAddress(t.oldInstantLayer)
	const actions: SafeAction[] = [
		{
			to: getAddress(t.core),
			value: "0",
			data: DIAMOND_ROLES.encodeFunctionData("revokeRole", [il, roleHash("INSTANT_LAYER_ROLE")]),
			description: `Core: revoke INSTANT_LAYER_ROLE from old InstantLayer ${il}`,
		},
		{
			to: getAddress(t.accountLayer),
			value: "0",
			data: DIAMOND_ROLES.encodeFunctionData("revokeRole", [il, roleHash("SIGNER_SETTER_ROLE")]),
			description: `AccountLayer: revoke SIGNER_SETTER_ROLE from old InstantLayer ${il}`,
		},
	]
	for (const partyB of t.partyBs.map(getAddress)) {
		actions.push(
			{
				to: partyB,
				value: "0",
				data: PARTY_B.encodeFunctionData("revokeRole", [roleHash("TRUSTED_ROLE"), il]),
				description: `SymmioPartyB ${partyB}: revoke TRUSTED_ROLE from old InstantLayer`,
			},
			{
				to: partyB,
				value: "0",
				data: PARTY_B.encodeFunctionData("setMulticastWhitelist", [il, false]),
				description: `SymmioPartyB ${partyB}: remove old InstantLayer from multicast whitelist`,
			},
		)
	}
	return actions
}

export interface SafeTransactionBuilderBatch {
	version: "1.0"
	chainId: string
	createdAt: number
	meta: {
		name: string
		description: string
		txBuilderVersion: string
		createdFromSafeAddress: string
		createdFromOwnerAddress: string
		checksum: string
	}
	transactions: Array<{ to: string; value: string; data: string; contractMethod: null; contractInputsValues: null }>
}

// Mirrors the Safe Transaction Builder's own checksum: sorted-key serialization with meta.name blanked.
function serializeSorted(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(serializeSorted).join(",")}]`
	if (value && typeof value === "object") {
		const entries = Object.keys(value as Record<string, unknown>)
			.sort()
			.map(key => `"${key}":${serializeSorted((value as Record<string, unknown>)[key])}`)
		return `{${entries.join(",")}}`
	}
	return JSON.stringify(value)
}

export function buildSafeTransactionBuilderBatch(input: {
	chainId: bigint | number
	safe: string
	name: string
	description: string
	actions: SafeAction[]
	createdAt?: number
}): SafeTransactionBuilderBatch {
	const batch = {
		version: "1.0" as const,
		chainId: BigInt(input.chainId).toString(),
		createdAt: input.createdAt ?? Date.now(),
		meta: {
			name: input.name,
			description: input.description,
			txBuilderVersion: "1.18.0",
			createdFromSafeAddress: getAddress(input.safe),
			createdFromOwnerAddress: "",
		},
		transactions: input.actions.map(action => ({
			to: getAddress(action.to),
			value: action.value,
			data: action.data,
			contractMethod: null,
			contractInputsValues: null,
		})),
	}
	const checksum = keccak256(toUtf8Bytes(serializeSorted({ ...batch, meta: { ...batch.meta, name: null } })))
	return { ...batch, meta: { ...batch.meta, checksum } }
}

const normalizedSet = (values: string[]) => [...new Set(values.map(v => v.toLowerCase()))].sort()
const sameSet = (a: string[], b: string[]) => JSON.stringify(normalizedSet(a)) === JSON.stringify(normalizedSet(b))
const describeSet = (values: string[]) => (values.length ? values.map(getAddress).join(", ") : "none")
const sameOperations = (a: TemplateOperation[], b: TemplateOperation[]) =>
	JSON.stringify(a.map(o => [o.insertionPoints, o.sourceIndices, o.sourceOffsets].map(v => v.map(String)))) ===
	JSON.stringify(b.map(o => [o.insertionPoints, o.sourceIndices, o.sourceOffsets].map(v => v.map(String))))

/**
 * Differences between the old layer and its replacement after the handover. Empty means the
 * replacement reproduces the old configuration exactly: same core and AccountLayer, same
 * whitelist and PartyB sets, identical templates by id, same cooldown and transient flag, and
 * the same holders of every role.
 */
export function compareInstantLayerConfiguration(old: InstantLayerSnapshot, replacement: InstantLayerSnapshot): string[] {
	const differences: string[] = []
	if (!same(old.symmio, replacement.symmio)) differences.push(`symmio: old ${old.symmio}, new ${replacement.symmio}`)
	if (!same(old.accountLayer, replacement.accountLayer)) differences.push(`accountLayer: old ${old.accountLayer}, new ${replacement.accountLayer}`)
	if (old.revocationCooldown !== replacement.revocationCooldown) {
		differences.push(`revocationCooldown: old ${old.revocationCooldown}, new ${replacement.revocationCooldown}`)
	}
	if (old.transientContextEnabled !== replacement.transientContextEnabled) {
		differences.push(`transientContextEnabled: old ${old.transientContextEnabled}, new ${replacement.transientContextEnabled}`)
	}
	if (!sameSet(old.whitelistedTargets, replacement.whitelistedTargets)) {
		differences.push(`whitelistedTargets: old ${describeSet(old.whitelistedTargets)}, new ${describeSet(replacement.whitelistedTargets)}`)
	}
	if (!sameSet(old.registeredPartyBs, replacement.registeredPartyBs)) {
		differences.push(`registeredPartyBs: old ${describeSet(old.registeredPartyBs)}, new ${describeSet(replacement.registeredPartyBs)}`)
	}
	const count = Math.max(old.templates.length, replacement.templates.length)
	for (let i = 0; i < count; i++) {
		const a = old.templates[i]
		const b = replacement.templates[i]
		if (!a || !b) {
			differences.push(`template ${i}: ${a ? "missing on the new layer" : "only exists on the new layer"}`)
			continue
		}
		if (a.name !== b.name) differences.push(`template ${i}: name old "${a.name}", new "${b.name}"`)
		if (a.active !== b.active) differences.push(`template ${i}: active old ${a.active}, new ${b.active}`)
		if (a.instantOpenMode !== b.instantOpenMode) differences.push(`template ${i}: instantOpenMode old ${a.instantOpenMode}, new ${b.instantOpenMode}`)
		if (!sameOperations(a.operations, b.operations)) differences.push(`template ${i}: operations differ`)
	}
	for (const name of INSTANT_LAYER_ROLE_NAMES) {
		if (!sameSet(old.roles[name] || [], replacement.roles[name] || [])) {
			differences.push(`${name}: old ${describeSet(old.roles[name] || [])}, new ${describeSet(replacement.roles[name] || [])}`)
		}
	}
	return differences
}

/**
 * Registered PartyBs cannot be enumerated from storage, but registerPartyBs grants OPERATOR_ROLE
 * and unregisterPartyB revokes it, so every registered PartyB is an OPERATOR_ROLE member. Merge
 * those members with any other candidates (event scan, deployment records); the caller confirms
 * each one against `registeredPartyBs` on chain.
 */
export function mergePartyBCandidates(operatorMembers: string[], ...extra: string[][]): string[] {
	const merged = new Map<string, string>()
	for (const list of [operatorMembers, ...extra]) {
		for (const value of list) if (value && value !== ZeroAddress) merged.set(value.toLowerCase(), getAddress(value))
	}
	return [...merged.values()]
}

export interface RecipeTemplate {
	name: string
	instantOpenMode?: boolean
	operations: Array<{
		insertionPoints: Array<number | string | bigint>
		sourceIndices: Array<number | string | bigint>
		sourceOffsets: Array<number | string | bigint>
	}>
}

function recipeTemplateToSnapshot(id: bigint, template: RecipeTemplate): TemplateSnapshot {
	return {
		id,
		name: template.name,
		active: true,
		instantOpenMode: Boolean(template.instantOpenMode),
		operations: template.operations.map(op => ({
			insertionPoints: op.insertionPoints.map(BigInt),
			sourceIndices: op.sourceIndices.map(BigInt),
			sourceOffsets: op.sourceOffsets.map(BigInt),
		})),
	}
}

/**
 * Templates the replacement must carry beyond what the old layer has. The recipe's template list
 * is authoritative for ids: its leading entries must match the old layer's templates one for one
 * (hedgers address templates by id), and only the entries past that point are new.
 */
export function planAdditionalTemplates(existing: TemplateSnapshot[], recipeTemplates: RecipeTemplate[]): TemplateSnapshot[] {
	const ordered = [...existing].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
	if (recipeTemplates.length < ordered.length) {
		throw new Error(
			`Recipe lists ${recipeTemplates.length} template(s) but the old layer has ${ordered.length}; the recipe must include every deployed template first`,
		)
	}
	ordered.forEach((deployed, index) => {
		const fromRecipe = recipeTemplateToSnapshot(deployed.id, recipeTemplates[index])
		const drift = compareInstantLayerConfiguration(
			{ ...EMPTY_SNAPSHOT, templates: [deployed] },
			{ ...EMPTY_SNAPSHOT, templates: [{ ...fromRecipe, active: deployed.active }] },
		)
		if (drift.length > 0)
			throw new Error(`Recipe template ${index} does not match the deployed template ${deployed.id} (${deployed.name}): ${drift.join("; ")}`)
	})
	return recipeTemplates.slice(ordered.length).map((template, offset) => recipeTemplateToSnapshot(BigInt(ordered.length + offset), template))
}

const EMPTY_SNAPSHOT: InstantLayerSnapshot = {
	address: ZeroAddress,
	symmio: ZeroAddress,
	accountLayer: ZeroAddress,
	revocationCooldown: 0n,
	transientContextEnabled: true,
	whitelistedTargets: [],
	registeredPartyBs: [],
	templates: [],
	roles: { DEFAULT_ADMIN_ROLE: [], SETTER_ROLE: [], OPERATOR_ROLE: [], REVOKER_ROLE: [] },
}
