/**
 * Chain-facing half of the InstantLayer migration: snapshot the old layer, deploy and configure
 * the replacement as the deployer, deploy the GaslessLayer implementation that can be re-pointed,
 * hand the new layer to the Safe, and report the wiring state of any layer.
 *
 * Every mutating step checks on-chain state first, so an interrupted run can simply be re-run
 * with the recorded `state` and it continues where it stopped.
 */
import { ZeroAddress, getAddress, isAddress } from "ethers"
import fs from "node:fs"
import path from "node:path"

import { confirmDeployment, send } from "../../tasks/deploy/tx.js"
import { gaslessLayerFactoryOptions, type GaslessLayerLibraryAddresses } from "../gaslessLayer/layer-libraries.js"
import {
	INSTANT_LAYER_ROLE_NAMES,
	buildCutoverSafeActions,
	buildDecommissionSafeActions,
	buildInstantLayerReplayPlan,
	compareInstantLayerConfiguration,
	mergePartyBCandidates,
	roleHash,
	type InstantLayerRoleName,
	type InstantLayerSnapshot,
	type ReplayAction,
	type SafeAction,
	type TemplateSnapshot,
} from "./instantLayerMigration.js"

type Log = (message: string) => void

export interface MigrationState {
	newInstantLayer?: string
	newGaslessImplementation?: string
}

export interface MigrateInstantLayerOptions {
	ethers: any
	deployer: any
	oldInstantLayer: string
	safe: string
	gaslessLayer: string
	gaslessLibraries: GaslessLayerLibraryAddresses
	state?: MigrationState
	fromBlock?: number
	partyBCandidates?: string[]
	whitelistedTargetCandidates?: string[]
	/** A layer with no registered PartyB is almost always a discovery failure; opt in explicitly. */
	allowNoPartyBs?: boolean
	/** Templates to add after the replayed ones, ids continuing from the old layer's count. */
	additionalTemplates?: TemplateSnapshot[]
	log?: Log
}

export interface MigrateInstantLayerResult {
	newInstantLayer: string
	newGaslessImplementation: string
	/** The old snapshot plus the additional templates: what the new layer is expected to match. */
	expectedSnapshot: InstantLayerSnapshot
	cutoverActions: SafeAction[]
	decommissionActions: SafeAction[]
	transactionsSent: number
	state: MigrationState
	snapshot: InstantLayerSnapshot
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const unique = (values: string[]) => [...new Map(values.map(v => [v.toLowerCase(), getAddress(v)])).values()]

/** First block at which `address` has code, by binary search over getCode; works on any RPC. */
export async function findDeploymentBlock(provider: any, address: string, latest?: number): Promise<number> {
	let high = latest ?? (await provider.getBlockNumber())
	if ((await provider.getCode(address, high)) === "0x") throw new Error(`No code at ${address} at block ${high}`)
	let low = 0
	while (low < high) {
		const mid = Math.floor((low + high) / 2)
		if ((await provider.getCode(address, mid)) === "0x") low = mid + 1
		else high = mid
	}
	return low
}

/** queryFilter in bounded windows so providers with log-range limits (and forks of them) still answer. */
async function queryLogsChunked(contract: any, filter: any, fromBlock: number, toBlock: number, initialChunk = 50_000): Promise<any[]> {
	const logs: any[] = []
	let chunk = initialChunk
	let start = fromBlock
	while (start <= toBlock) {
		const end = Math.min(start + chunk - 1, toBlock)
		try {
			logs.push(...(await contract.queryFilter(filter, start, end)))
			start = end + 1
		} catch (error) {
			if (chunk <= 1_000) throw error
			chunk = Math.floor(chunk / 2)
		}
	}
	return logs
}

/**
 * Collect the current member set of an added/removed event pair. Providers differ in what they
 * allow: a full-range query is tried first (cheap where permitted), then bounded windows from the
 * layer's deployment block (needs historical state for the binary search), then an explicit
 * `fromBlock` if the caller gave one.
 */
async function collectAddressesFromEvents(
	provider: any,
	contract: any,
	added: string,
	removed: string | undefined,
	toBlock: number,
	fromBlock: number | undefined,
	log: Log,
): Promise<string[]> {
	const address = await contract.getAddress()
	const query = async (start: number, chunked: boolean) => {
		const fetch = (filter: any) => (chunked ? queryLogsChunked(contract, filter, start, toBlock) : contract.queryFilter(filter, start, toBlock))
		const addedLogs = await fetch(contract.filters[added]())
		const removedLogs = removed ? await fetch(contract.filters[removed]()) : []
		return { addedLogs, removedLogs }
	}
	let result: { addedLogs: any[]; removedLogs: any[] } | undefined
	if (fromBlock !== undefined) {
		result = await query(fromBlock, true)
	} else {
		try {
			result = await query(0, false)
		} catch (fullRangeError: any) {
			log(
				`full-range ${added} scan refused (${(fullRangeError?.shortMessage || fullRangeError?.message || "").slice(0, 80)}); locating deployment block`,
			)
			const deploymentBlock = await findDeploymentBlock(provider, address, toBlock)
			result = await query(deploymentBlock, true)
		}
	}
	const events = [...result.addedLogs.map((l: any) => ({ l, add: true })), ...result.removedLogs.map((l: any) => ({ l, add: false }))].sort(
		(a, b) => a.l.blockNumber - b.l.blockNumber || a.l.index - b.l.index,
	)
	const current = new Map<string, string>()
	for (const { l, add } of events) {
		const value = getAddress(l.args[0])
		if (add) current.set(value.toLowerCase(), value)
		else current.delete(value.toLowerCase())
	}
	return [...current.values()]
}

export interface SnapshotOptions {
	/** First block to scan for events; defaults to the layer's deployment block (binary search). */
	fromBlock?: number
	/** Additional PartyB addresses to confirm on chain (deployment records, operator input). */
	partyBCandidates?: string[]
	/** Skip the whitelist event scan and confirm exactly these targets instead. */
	whitelistedTargetCandidates?: string[]
	log?: Log
}

/** Read everything a replacement InstantLayer needs to reproduce from the old one. */
export async function snapshotInstantLayer(ethers: any, address: string, options: SnapshotOptions = {}): Promise<InstantLayerSnapshot> {
	const log = options.log ?? (() => {})
	const il = await ethers.getContractAt("InstantLayer", getAddress(address))
	const symmio = getAddress(await il.symmio())
	const accountLayer = getAddress(await il.accountLayer())

	const templates: TemplateSnapshot[] = []
	const nextTemplateId = BigInt(await il.nextTemplateId())
	for (let id = 0n; id < nextTemplateId; id++) {
		const template = await il.getTemplate(id)
		templates.push({
			id,
			name: template.name,
			active: template.active,
			instantOpenMode: await il.templateInstantOpenMode(id),
			operations: template.operations.map((op: any) => ({
				insertionPoints: [...op.insertionPoints].map(BigInt),
				sourceIndices: [...op.sourceIndices].map(BigInt),
				sourceOffsets: [...op.sourceOffsets].map(BigInt),
			})),
		})
	}

	const roles = {} as Record<InstantLayerRoleName, string[]>
	for (const name of INSTANT_LAYER_ROLE_NAMES) {
		const hash = roleHash(name)
		const count = Number(await il.getRoleMemberCount(hash))
		const members: string[] = []
		for (let i = 0; i < count; i++) members.push(getAddress(await il.getRoleMember(hash, i)))
		roles[name] = members
	}

	const latest = await ethers.provider.getBlockNumber()

	// Whitelisted targets: a mapping without enumeration. Rebuild from events and confirm each
	// against storage; an explicit candidate list replaces the scan entirely.
	const whitelistCandidates = options.whitelistedTargetCandidates
		? unique([symmio, accountLayer, ...options.whitelistedTargetCandidates])
		: unique([
				symmio,
				accountLayer,
				...(await collectAddressesFromEvents(ethers.provider, il, "TargetWhitelistUpdated", undefined, latest, options.fromBlock, log)),
			])
	const whitelistChecks = await Promise.all(whitelistCandidates.map(async target => [target, await il.whitelistedTargets(target)] as const))
	const whitelistedTargets = whitelistChecks.filter(([, allowed]) => allowed).map(([target]) => target)

	// Registered PartyBs: every registered PartyB holds OPERATOR_ROLE (registerPartyBs grants it,
	// unregisterPartyB revokes it), so the enumerable role members are the primary source; events
	// and caller-supplied candidates only add to it. Each candidate is confirmed against storage.
	let eventPartyBs: string[] = []
	try {
		eventPartyBs = await collectAddressesFromEvents(ethers.provider, il, "PartyBRegistered", "PartyBUnregistered", latest, options.fromBlock, log)
	} catch (error: any) {
		log(
			`warn: PartyBRegistered log scan failed (${(error?.shortMessage || error?.message || String(error)).slice(0, 120)}); relying on OPERATOR_ROLE members`,
		)
	}
	const partyBCandidates = mergePartyBCandidates(roles.OPERATOR_ROLE, eventPartyBs, options.partyBCandidates || [])
	const partyBChecks = await Promise.all(partyBCandidates.map(async partyB => [partyB, await il.registeredPartyBs(partyB)] as const))
	const registeredPartyBs = partyBChecks.filter(([, registered]) => registered).map(([partyB]) => partyB)

	return {
		address: getAddress(address),
		symmio,
		accountLayer,
		revocationCooldown: BigInt(await il.revocationCooldown()),
		transientContextEnabled: await il.transientContextEnabled(),
		whitelistedTargets,
		registeredPartyBs,
		templates,
		roles,
	}
}

async function hasCode(ethers: any, address: string | undefined): Promise<boolean> {
	return Boolean(address) && (await ethers.provider.getCode(address)) !== "0x"
}

/** Apply one replay action unless the new layer already reflects it. Returns true when a tx was sent. */
async function applyReplayAction(il: any, action: ReplayAction, log: Log): Promise<boolean> {
	const a = action.args as any[]
	switch (action.kind) {
		case "setAccountLayer":
			if (same(await il.accountLayer(), a[0])) return false
			await send(il.setAccountLayer(a[0]), action.description)
			return true
		case "setTargetWhitelist":
			if ((await il.whitelistedTargets(a[0])) === a[1]) return false
			await send(il.setTargetWhitelist(a[0], a[1]), action.description)
			return true
		case "registerPartyBs": {
			const missing: string[] = []
			for (const partyB of a[0] as string[]) if (!(await il.registeredPartyBs(partyB))) missing.push(partyB)
			if (missing.length === 0) return false
			await send(il.registerPartyBs(missing), `registerPartyBs([${missing.join(", ")}])`)
			return true
		}
		case "addTemplate": {
			const [name, operations] = a as [string, unknown[]]
			const nextId = BigInt(await il.nextTemplateId())
			const expectedId = BigInt(action.description.match(/addTemplate\((\d+):/)![1])
			if (nextId > expectedId) {
				const existing = await il.getTemplate(expectedId)
				if (existing.name !== name || existing.operations.length !== operations.length) {
					throw new Error(`Template ${expectedId} on the new InstantLayer is "${existing.name}", expected "${name}"; refusing to continue`)
				}
				return false
			}
			if (nextId !== expectedId) throw new Error(`Template order broken: next id is ${nextId}, expected ${expectedId}`)
			await send(il.addTemplate(name, operations), action.description)
			return true
		}
		case "setTemplateInstantOpenMode":
			if ((await il.templateInstantOpenMode(a[0])) === a[1]) return false
			await send(il.setTemplateInstantOpenMode(a[0], a[1]), action.description)
			return true
		case "setTemplateActive":
			if ((await il.getTemplate(a[0])).active === a[1]) return false
			await send(il.setTemplateActive(a[0], a[1]), action.description)
			return true
		case "setRevocationCooldown":
			if (BigInt(await il.revocationCooldown()) === a[0]) return false
			await send(il.setRevocationCooldown(a[0]), action.description)
			return true
		case "setTransientContextEnabled":
			if ((await il.transientContextEnabled()) === a[0]) return false
			await send(il.setTransientContextEnabled(a[0]), action.description)
			return true
		case "grantRole":
			if (await il.hasRole(a[0], a[1])) return false
			await send(il.grantRole(a[0], a[1]), action.description)
			return true
		default:
			log(`skipping unknown action ${(action as ReplayAction).kind}`)
			return false
	}
}

export async function migrateInstantLayer(options: MigrateInstantLayerOptions): Promise<MigrateInstantLayerResult> {
	const { ethers, deployer } = options
	const log = options.log ?? (() => {})
	const deployerAddress = getAddress(await deployer.getAddress())
	const safe = getAddress(options.safe)
	const gaslessLayer = getAddress(options.gaslessLayer)
	const state: MigrationState = { ...(options.state || {}) }
	let transactionsSent = 0

	const snapshot = await snapshotInstantLayer(ethers, options.oldInstantLayer, {
		fromBlock: options.fromBlock,
		partyBCandidates: options.partyBCandidates,
		whitelistedTargetCandidates: options.whitelistedTargetCandidates,
		log,
	})
	if (snapshot.registeredPartyBs.length === 0 && !options.allowNoPartyBs) {
		throw new Error(`No registered PartyB found on ${snapshot.address}; pass partyBCandidates (PARTY_BS) or allowNoPartyBs to proceed`)
	}
	const additional = options.additionalTemplates || []
	additional.forEach((template, index) => {
		if (template.id !== BigInt(snapshot.templates.length + index)) {
			throw new Error(`Additional template "${template.name}" has id ${template.id}, expected ${snapshot.templates.length + index}`)
		}
	})
	const expectedSnapshot: InstantLayerSnapshot = { ...snapshot, templates: [...snapshot.templates, ...additional] }
	const plan = buildInstantLayerReplayPlan(expectedSnapshot, { deployer: deployerAddress, safe })

	const gateway = await ethers.getContractAt("GaslessLayer", gaslessLayer)
	if (!same(await gateway.instantLayer(), snapshot.address)) {
		log(`warn: GaslessLayer ${gaslessLayer} currently points at ${await gateway.instantLayer()}, not the old InstantLayer ${snapshot.address}`)
	}

	// 1. Replacement InstantLayer, deployer as temporary admin
	let il: any
	if (await hasCode(ethers, state.newInstantLayer)) {
		il = (await ethers.getContractAt("InstantLayer", state.newInstantLayer)).connect(deployer)
		log(`reusing new InstantLayer ${state.newInstantLayer}`)
	} else {
		const factory = await ethers.getContractFactory("InstantLayer", deployer)
		const deployed = await factory.deploy(snapshot.symmio, deployerAddress)
		state.newInstantLayer = await confirmDeployment(deployed, "InstantLayer")
		transactionsSent++
		il = (await ethers.getContractAt("InstantLayer", state.newInstantLayer)).connect(deployer)
		log(`deployed new InstantLayer ${state.newInstantLayer}`)
	}
	if (!same(await il.symmio(), snapshot.symmio)) throw new Error(`New InstantLayer ${state.newInstantLayer} is bound to a different core`)

	// 2. Replay the old configuration
	for (const action of plan) {
		if (await applyReplayAction(il, action, log)) {
			transactionsSent++
			log(`applied ${action.description}`)
		}
	}

	// 3. GaslessLayer implementation that exposes setInstantLayer (linked against the existing libraries)
	if (await hasCode(ethers, state.newGaslessImplementation)) {
		log(`reusing GaslessLayer implementation ${state.newGaslessImplementation}`)
	} else {
		for (const [name, address] of Object.entries(options.gaslessLibraries)) {
			if (!(await hasCode(ethers, address))) throw new Error(`GaslessLayer library ${name} has no code at ${address}`)
		}
		const factory = await ethers.getContractFactory("GaslessLayer", gaslessLayerFactoryOptions(options.gaslessLibraries, deployer))
		const deployed = await factory.deploy()
		state.newGaslessImplementation = await confirmDeployment(deployed, "GaslessLayer implementation")
		transactionsSent++
		log(`deployed GaslessLayer implementation ${state.newGaslessImplementation}`)
	}

	// 4. Handover: Safe receives every role, then the deployer renounces its own (admin last)
	for (const name of INSTANT_LAYER_ROLE_NAMES) {
		if (!(await il.hasRole(roleHash(name), safe))) {
			await send(il.grantRole(roleHash(name), safe), `grantRole(${name}, Safe ${safe})`)
			transactionsSent++
		}
	}
	for (const name of ["SETTER_ROLE", "OPERATOR_ROLE", "REVOKER_ROLE", "DEFAULT_ADMIN_ROLE"] as const) {
		if (await il.hasRole(roleHash(name), deployerAddress)) {
			await send(il.renounceRole(roleHash(name), deployerAddress), `renounceRole(${name}, deployer)`)
			transactionsSent++
		}
	}

	const newInstantLayer = state.newInstantLayer!
	const newGaslessImplementation = state.newGaslessImplementation!
	return {
		newInstantLayer,
		newGaslessImplementation,
		expectedSnapshot,
		cutoverActions: buildCutoverSafeActions({
			core: snapshot.symmio,
			accountLayer: snapshot.accountLayer,
			partyBs: snapshot.registeredPartyBs,
			gaslessLayer,
			newGaslessImplementation,
			newInstantLayer,
		}),
		decommissionActions: buildDecommissionSafeActions({
			core: snapshot.symmio,
			accountLayer: snapshot.accountLayer,
			partyBs: snapshot.registeredPartyBs,
			oldInstantLayer: snapshot.address,
		}),
		transactionsSent,
		state,
		snapshot,
	}
}

export interface WiringTargets {
	core: string
	accountLayer: string
	partyBs: string[]
	gaslessLayer: string
	instantLayer: string
}

export interface WiringBinding {
	label: string
	ok: boolean
	detail: string
}

export interface WiringReport {
	instantLayer: string
	ok: boolean
	bindings: WiringBinding[]
}

/** Report which contracts currently treat `instantLayer` as the live InstantLayer. */
export async function checkInstantLayerWiring(ethers: any, targets: WiringTargets): Promise<WiringReport> {
	const il = getAddress(targets.instantLayer)
	const diamondAbi = ["function hasRole(address user, bytes32 role) view returns (bool)"]
	const core = await ethers.getContractAt(diamondAbi, getAddress(targets.core))
	const accountLayer = await ethers.getContractAt(diamondAbi, getAddress(targets.accountLayer))
	const gateway = await ethers.getContractAt("GaslessLayer", getAddress(targets.gaslessLayer))
	const layer = await ethers.getContractAt("InstantLayer", il)

	const bindings: WiringBinding[] = []
	const push = (label: string, ok: boolean, detail: string) => bindings.push({ label, ok, detail })

	push("core.INSTANT_LAYER_ROLE", await core.hasRole(il, roleHash("INSTANT_LAYER_ROLE")), `core ${targets.core}`)
	push("accountLayer.SIGNER_SETTER_ROLE", await accountLayer.hasRole(il, roleHash("SIGNER_SETTER_ROLE")), `accountLayer ${targets.accountLayer}`)
	for (const partyBAddress of targets.partyBs.map(getAddress)) {
		const partyB = await ethers.getContractAt("SymmioPartyB", partyBAddress)
		push(`partyB.TRUSTED_ROLE[${partyBAddress}]`, await partyB.hasRole(roleHash("TRUSTED_ROLE"), il), `partyB ${partyBAddress}`)
		push(`partyB.multicastWhitelist[${partyBAddress}]`, await partyB.multicastWhitelist(il), `partyB ${partyBAddress}`)
	}
	const pointedAt = getAddress(await gateway.instantLayer())
	push("gasless.instantLayer", same(pointedAt, il), `GaslessLayer points at ${pointedAt}`)
	const operator = await layer.hasRole(roleHash("OPERATOR_ROLE"), getAddress(targets.gaslessLayer))
	push(
		"gasless.operatorRole",
		same(pointedAt, il) && operator,
		operator ? "gateway holds OPERATOR_ROLE on this layer" : "gateway lacks OPERATOR_ROLE on this layer",
	)

	return { instantLayer: il, ok: bindings.every(b => b.ok), bindings }
}

export interface SafeSimulation {
	description: string
	ok: boolean
	error?: string
}

/** eth_call every action from the Safe against current chain state; nothing is broadcast. */
export async function simulateSafeActions(ethers: any, safe: string, actions: SafeAction[]): Promise<SafeSimulation[]> {
	const from = getAddress(safe)
	const results: SafeSimulation[] = []
	for (const action of actions) {
		try {
			await ethers.provider.call({ from, to: action.to, data: action.data, value: BigInt(action.value) })
			results.push({ description: action.description, ok: true })
		} catch (error: any) {
			const message: string = error?.shortMessage || error?.message || String(error)
			results.push({ description: action.description, ok: false, error: message.slice(0, 200) })
		}
	}
	return results
}

/**
 * Send every action from `signer` (the governance admin when it is an EOA). Each action is
 * simulated first so a partially applied batch stops at the first real problem; the actions
 * themselves are idempotent, so re-running after an interruption is safe.
 */
export async function executeSafeActions(ethers: any, signer: any, actions: SafeAction[], log: Log = () => {}): Promise<number> {
	const from = getAddress(await signer.getAddress())
	let sent = 0
	for (const action of actions) {
		await ethers.provider.call({ from, to: action.to, data: action.data, value: BigInt(action.value) })
		await send(signer.sendTransaction({ to: action.to, data: action.data, value: BigInt(action.value) }), action.description)
		sent++
		log(`executed ${action.description}`)
	}
	return sent
}

export interface ReplacementVerification {
	ok: boolean
	findings: string[]
	replacementSnapshot: InstantLayerSnapshot
}

/**
 * Prove the replacement is a faithful, fully handed-over copy of the old layer: identical
 * configuration, the Safe holding every role, the deployer holding none, and the gateway able to
 * relay through it.
 */
export async function verifyInstantLayerReplacement(
	ethers: any,
	input: { oldSnapshot: InstantLayerSnapshot; newInstantLayer: string; safe: string; deployer?: string; gaslessLayer: string; fromBlock?: number },
): Promise<ReplacementVerification> {
	const replacementSnapshot = await snapshotInstantLayer(ethers, input.newInstantLayer, {
		partyBCandidates: input.oldSnapshot.registeredPartyBs,
		whitelistedTargetCandidates: input.oldSnapshot.whitelistedTargets,
	})
	const findings = compareInstantLayerConfiguration(input.oldSnapshot, replacementSnapshot)
	const il = await ethers.getContractAt("InstantLayer", getAddress(input.newInstantLayer))
	for (const name of INSTANT_LAYER_ROLE_NAMES) {
		if (!(await il.hasRole(roleHash(name), getAddress(input.safe)))) findings.push(`Safe ${input.safe} lacks ${name} on the new layer`)
		if (input.deployer && (await il.hasRole(roleHash(name), getAddress(input.deployer)))) {
			findings.push(`deployer ${input.deployer} still holds ${name} on the new layer`)
		}
	}
	if (!(await il.hasRole(roleHash("OPERATOR_ROLE"), getAddress(input.gaslessLayer)))) {
		findings.push(`GaslessLayer ${input.gaslessLayer} lacks OPERATOR_ROLE on the new layer`)
	}
	for (const partyB of input.oldSnapshot.registeredPartyBs) {
		if (!(await il.hasRole(roleHash("OPERATOR_ROLE"), getAddress(partyB)))) findings.push(`PartyB ${partyB} lacks OPERATOR_ROLE on the new layer`)
	}
	return { ok: findings.length === 0, findings, replacementSnapshot }
}

export interface MigrationDefaults {
	oldInstantLayer: string
	gaslessLayer: string
	safe: string
	core: string
	accountLayer: string
	libraries: GaslessLayerLibraryAddresses
}

export const GASLESS_LIBRARY_NAMES: ReadonlyArray<keyof GaslessLayerLibraryAddresses> = [
	"GaslessNativeGasTopUpLib",
	"GaslessOperationalFeeLib",
	"GaslessWalletDeployerLib",
	"GaslessWalletExecutionLib",
]

function optionalEnvAddress(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name]
	if (!value) return undefined
	if (!isAddress(value) || value === ZeroAddress) throw new Error(`${name} must be a non-zero address when provided`)
	return getAddress(value)
}

function readJsonFile<T>(file: string): T | undefined {
	return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : undefined
}

/**
 * Addresses for a migration on `chainId`: tasks/data/<chainId>/deployment-report.json and
 * gaslesslayer.json provide the defaults, environment variables override each one.
 */
export function loadMigrationDefaults(chainId: bigint | number, env: NodeJS.ProcessEnv = process.env): MigrationDefaults {
	const dataDir = path.resolve("tasks/data", chainId.toString())
	const report = readJsonFile<{ addresses?: Record<string, string>; config?: { admin?: string } }>(path.join(dataDir, "deployment-report.json"))
	const gaslessRecords = readJsonFile<Array<{ name: string; address: string }>>(path.join(dataDir, "gaslesslayer.json")) || []
	const libraries = {} as GaslessLayerLibraryAddresses
	for (const name of GASLESS_LIBRARY_NAMES) {
		const address = optionalEnvAddress(env, `GASLESS_LIB_${name}`) || gaslessRecords.find(record => record.name.endsWith(`:${name}`))?.address
		if (!address) throw new Error(`No address for ${name}: set GASLESS_LIB_${name} or add it to ${path.join(dataDir, "gaslesslayer.json")}`)
		libraries[name] = getAddress(address)
	}
	const pick = (envName: string, reportValue: string | undefined, label: string) => {
		const value = optionalEnvAddress(env, envName) || reportValue
		if (!value) throw new Error(`No ${label}: set ${envName} or provide it in ${path.join(dataDir, "deployment-report.json")}`)
		return getAddress(value)
	}
	return {
		oldInstantLayer: pick("OLD_INSTANT_LAYER", report?.addresses?.instantLayer, "old InstantLayer address"),
		gaslessLayer: pick("GASLESS_LAYER", report?.addresses?.gaslessLayer, "GaslessLayer proxy address"),
		safe: pick("SAFE_ADDRESS", report?.config?.admin, "Safe (governance admin) address"),
		core: pick("CORE_ADDRESS", report?.addresses?.diamond, "core diamond address"),
		accountLayer: pick("ACCOUNT_LAYER_ADDRESS", report?.addresses?.accountLayerDiamond, "AccountLayer diamond address"),
		libraries,
	}
}

export { ZeroAddress }
