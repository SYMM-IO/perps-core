/**
 * Register/onboard PartyB solver addresses on Symmio core.
 *
 * Default mode writes a Safe Transaction Builder batch and a report only.
 *
 * Run:
 *   npx hardhat run scripts/upgrade/registerPartyB.ts --network <network>
 *
 * Direct execution:
 *   EXECUTE=true npx hardhat run scripts/upgrade/registerPartyB.ts --network <network>
 *
 * Safe Transaction Service proposal:
 *   SUBMIT_SAFE_PROPOSAL=true SAFE_MULTISEND_ADDRESS=<multisend> \
 *     SAFE_SUBMITTER_ADDRESS=<owner-or-delegate> SAFE_SUBMITTER_PRIVATE_KEY=<key> \
 *     npx hardhat run scripts/upgrade/registerPartyB.ts --network <network>
 *
 * Config:
 *   scripts/upgrade/config/partyBRegistration-<network>.json
 *   scripts/upgrade/config/upgrade-<network>.json for shared diamond/safe/InstantLayer fields.
 */
import fs from "fs"
import { configVariable } from "hardhat/config"
import path from "path"
import { stdin as input, stdout as output } from "process"
import { createInterface } from "readline/promises"

import connection, { ethers, hre } from "../../test/helpers/hardhat-connection.js"
import { loadUpgradeConfigShared, resolveConfigFile } from "./utils/sharedConfig.js"
import { toHumanReadableSafeTxFromIface, type SafeBatch, type SafeTransaction } from "./utils/upgradeHelpers.js"

type Numberish = string | number | bigint

type EntityMetadataConfig = {
	name?: string
	brandColor?: string
	metadata?: string
}

type PartyBConfigEntry = {
	address: string
	name?: string
	registerOnCore?: boolean
	setBindable?: boolean
	bindable?: boolean
	metadata?: EntityMetadataConfig | false
	symbolTypes?: Numberish[]
	symbolIds?: Numberish[]
	registerOnInstantLayer?: boolean
}

type PartyBRegistrationConfig = {
	diamondAddress?: string
	safeAddress?: string
	instantLayerAddress?: string
	safeTxCreatorAddress?: string
	safeSubmitterAddress?: string
	safeServiceUrl?: string
	safeMultiSendAddress?: string
	defaults?: {
		registerOnCore?: boolean
		setBindable?: boolean
		bindable?: boolean
		symbolTypes?: Numberish[]
		symbolIds?: Numberish[]
		registerOnInstantLayer?: boolean
	}
	partyBs?: Array<string | PartyBConfigEntry> | Record<string, string[]>
}

type EntityMetadata = Required<EntityMetadataConfig>

type SourceValue<T> = {
	value: T
	source: string
}

type PartyBPlan = {
	address: string
	label: string
	registerOnCore: boolean
	setBindable: boolean
	bindable: boolean
	metadata?: EntityMetadata
	symbolTypes: bigint[]
	symbolIds: bigint[]
	registerOnInstantLayer: boolean
}

type CurrentState = {
	isPartyB?: boolean
	isBindable?: boolean
	metadata?: EntityMetadata
	whitelistedSymbolTypes: Record<string, boolean | undefined>
	registeredOnInstantLayer?: boolean
	errors: string[]
}

type PlannedCall = {
	label: string
	toLabel: string
	to: string
	iface: typeof diamondIface
	methodName: string
	args: any[]
	safeTx: SafeTransaction
	partyB?: string
	skipReason?: string
}

type SafeProposalTx = {
	to: string
	value: string
	data: string
	operation: number
	multiSendData?: string
}

type SafeInfo = {
	nonce?: number
	owners?: string[]
}

const OUTPUT_DIR = process.env.PARTYB_REGISTRATION_OUTPUT_DIR || "./scripts/upgrade/output"
const SAFE_TX_BUILDER_VERSION = "1.18.0"
const SAFE_SERVICE_SLUG_BY_CHAIN_ID: Record<string, string> = {
	"1": "mainnet",
	"56": "bnb",
	"146": "sonic",
	"999": "hyper",
	"5000": "mantle",
	"8453": "base",
	"42161": "arb1",
	"80094": "berachain",
	"9745": "plasma",
}

const diamondIface = new ethers.Interface([
	"function registerPartyB(address partyB)",
	"function setPartyBBindable(address partyB, bool bindable)",
	"function setPartyBMetadata(address partyB, tuple(string name,string brandColor,string metadata) metadata)",
	"function whitelistSymbolType(address partyB, uint256 symbolType)",
	"function whitelistSymbols(address partyB, uint256[] symbolIds)",
	"function isPartyB(address user) view returns (bool)",
	"function isBindable(address partyB) view returns (bool)",
	"function getEntityMetadata(address entity) view returns (tuple(string name,string brandColor,string metadata))",
	"function isWhitelistedSymbolType(address partyB, uint256 symbolType) view returns (bool)",
])
const instantLayerIface = new ethers.Interface([
	"function registerPartyBs(address[] partyBs)",
	"function registeredPartyBs(address partyB) view returns (bool)",
])
const safeIface = new ethers.Interface([
	"function nonce() view returns (uint256)",
	"function getOwners() view returns (address[])",
	"function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce) view returns (bytes32)",
])
const multiSendIface = new ethers.Interface(["function multiSend(bytes transactions)"])
const SAFE_TX_TYPES = {
	SafeTx: [
		{ name: "to", type: "address" },
		{ name: "value", type: "uint256" },
		{ name: "data", type: "bytes" },
		{ name: "operation", type: "uint8" },
		{ name: "safeTxGas", type: "uint256" },
		{ name: "baseGas", type: "uint256" },
		{ name: "gasPrice", type: "uint256" },
		{ name: "gasToken", type: "address" },
		{ name: "refundReceiver", type: "address" },
		{ name: "nonce", type: "uint256" },
	],
}

function boolEnv(name: string, fallback = false): boolean {
	const value = process.env[name]
	if (value === undefined) return fallback
	return /^(1|true|yes)$/i.test(value)
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) return value.trim()
	}
	return undefined
}

function readJsonIfExists<T>(file: string): T | undefined {
	if (!fs.existsSync(file)) return undefined
	return JSON.parse(fs.readFileSync(file, "utf-8")) as T
}

function writeJson(file: string, data: object): void {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify(data, jsonReplacer, 2))
}

function jsonReplacer(_key: string, value: unknown): unknown {
	if (typeof value === "bigint") return value.toString()
	return value
}

function sanitizeSuffix(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "-")
}

function getErrorMessage(err: any): string {
	return err?.shortMessage || err?.reason || err?.message?.split("\n")[0] || String(err)
}

function parseAddress(value: string, label: string): string {
	try {
		const address = ethers.getAddress(value)
		if (address === ethers.ZeroAddress) throw new Error("zero address")
		return address
	} catch {
		throw new Error(`${label} is not a valid non-zero address: ${value}`)
	}
}

function parseOptionalAddress(value: string | undefined, label: string): string | undefined {
	if (!value) return undefined
	return parseAddress(value, label)
}

function parseBigIntValue(value: Numberish, label: string): bigint {
	try {
		const parsed = BigInt(value)
		if (parsed < 0n) throw new Error("must be non-negative")
		return parsed
	} catch (err: any) {
		throw new Error(`${label} must be a non-negative integer: ${getErrorMessage(err)}`)
	}
}

function uniqueBigInts(values: Numberish[] | undefined, label: string): bigint[] {
	const seen = new Set<string>()
	const result: bigint[] = []
	for (const value of values ?? []) {
		const parsed = parseBigIntValue(value, label)
		const key = parsed.toString()
		if (!seen.has(key)) {
			seen.add(key)
			result.push(parsed)
		}
	}
	return result
}

function normalizeMetadata(metadata: EntityMetadataConfig | undefined, fallbackName = ""): EntityMetadata | undefined {
	if (!metadata) return undefined
	return {
		name: metadata.name ?? fallbackName,
		brandColor: metadata.brandColor ?? "",
		metadata: metadata.metadata ?? "",
	}
}

function normalizeMetadataResult(raw: any): EntityMetadata {
	return {
		name: String(raw.name ?? raw[0] ?? ""),
		brandColor: String(raw.brandColor ?? raw[1] ?? ""),
		metadata: String(raw.metadata ?? raw[2] ?? ""),
	}
}

function metadataEquals(left: EntityMetadata | undefined, right: EntityMetadata | undefined): boolean {
	if (!left || !right) return false
	return left.name === right.name && left.brandColor === right.brandColor && left.metadata === right.metadata
}

function normalizePartyBEntries(config: PartyBRegistrationConfig): PartyBPlan[] {
	const defaults = config.defaults ?? {}
	const rawPartyBs = config.partyBs
	if (!rawPartyBs) throw new Error("partyBRegistration config must define partyBs")

	const entries: Array<string | PartyBConfigEntry> = Array.isArray(rawPartyBs)
		? rawPartyBs
		: Object.entries(rawPartyBs).flatMap(([name, addresses]) => addresses.map(address => ({ name, address })))

	const seen = new Set<string>()
	return entries.map((entry, index) => {
		const asEntry: PartyBConfigEntry = typeof entry === "string" ? { address: entry } : entry
		const address = parseAddress(asEntry.address, `partyBs[${index}].address`)
		if (seen.has(address.toLowerCase())) throw new Error(`Duplicate PartyB address in config: ${address}`)
		seen.add(address.toLowerCase())

		const label = asEntry.name || `PartyB ${index + 1}`
		const metadata = asEntry.metadata === false ? undefined : normalizeMetadata(asEntry.metadata, label)

		return {
			address,
			label,
			registerOnCore: asEntry.registerOnCore ?? defaults.registerOnCore ?? true,
			setBindable: asEntry.setBindable ?? defaults.setBindable ?? (asEntry.bindable !== undefined || defaults.bindable !== undefined),
			bindable: asEntry.bindable ?? defaults.bindable ?? true,
			metadata,
			symbolTypes: uniqueBigInts(asEntry.symbolTypes ?? defaults.symbolTypes, `${label}.symbolTypes`),
			symbolIds: uniqueBigInts(asEntry.symbolIds ?? defaults.symbolIds, `${label}.symbolIds`),
			registerOnInstantLayer: asEntry.registerOnInstantLayer ?? defaults.registerOnInstantLayer ?? false,
		}
	})
}

function resolveString(
	envValue: string | undefined,
	configValue: string | undefined,
	sharedValue: string | undefined,
	envName: string,
	configName: string,
	sharedName: string,
): SourceValue<string | undefined> {
	const value = firstString(envValue, configValue, sharedValue)
	const source = envValue ? `env:${envName}` : configValue ? `partyBRegistration.${configName}` : sharedValue ? `upgrade.${sharedName}` : "not set"
	return { value, source }
}

async function readCurrentState(
	partyB: PartyBPlan,
	diamondAddress: string,
	instantLayerAddress: string | undefined,
	skipPreflight: boolean,
): Promise<CurrentState> {
	const state: CurrentState = { whitelistedSymbolTypes: {}, errors: [] }
	if (skipPreflight) {
		state.errors.push("preflight skipped")
		return state
	}

	const diamond = new ethers.Contract(diamondAddress, diamondIface, ethers.provider)
	await Promise.all([
		diamond
			.isPartyB(partyB.address)
			.then((value: boolean) => {
				state.isPartyB = value
			})
			.catch((err: any) => state.errors.push(`isPartyB: ${getErrorMessage(err)}`)),
		diamond
			.isBindable(partyB.address)
			.then((value: boolean) => {
				state.isBindable = value
			})
			.catch((err: any) => state.errors.push(`isBindable: ${getErrorMessage(err)}`)),
		diamond
			.getEntityMetadata(partyB.address)
			.then((value: any) => {
				state.metadata = normalizeMetadataResult(value)
			})
			.catch((err: any) => state.errors.push(`getEntityMetadata: ${getErrorMessage(err)}`)),
		...partyB.symbolTypes.map(symbolType =>
			diamond
				.isWhitelistedSymbolType(partyB.address, symbolType)
				.then((value: boolean) => {
					state.whitelistedSymbolTypes[symbolType.toString()] = value
				})
				.catch((err: any) => {
					state.whitelistedSymbolTypes[symbolType.toString()] = undefined
					state.errors.push(`isWhitelistedSymbolType(${symbolType}): ${getErrorMessage(err)}`)
				}),
		),
	])

	if (instantLayerAddress && partyB.registerOnInstantLayer) {
		const instantLayer = new ethers.Contract(instantLayerAddress, instantLayerIface, ethers.provider)
		await instantLayer
			.registeredPartyBs(partyB.address)
			.then((value: boolean) => {
				state.registeredOnInstantLayer = value
			})
			.catch((err: any) => state.errors.push(`registeredPartyBs: ${getErrorMessage(err)}`))
	}

	return state
}

function buildCall(
	label: string,
	toLabel: string,
	to: string,
	iface: typeof diamondIface,
	methodName: string,
	args: any[],
	partyB?: string,
	skipReason?: string,
): PlannedCall {
	return {
		label,
		toLabel,
		to,
		iface,
		methodName,
		args,
		partyB,
		skipReason,
		safeTx: toHumanReadableSafeTxFromIface(iface, to, methodName, args),
	}
}

function buildPlannedCalls(
	partyB: PartyBPlan,
	state: CurrentState,
	diamondAddress: string,
	instantLayerAddress: string | undefined,
	force: boolean,
): { included: PlannedCall[]; skipped: PlannedCall[] } {
	const included: PlannedCall[] = []
	const skipped: PlannedCall[] = []
	const push = (call: PlannedCall) => (call.skipReason ? skipped : included).push(call)

	if (partyB.registerOnCore) {
		push(
			buildCall(
				`${partyB.label}: register PartyB on core`,
				"Symmio core diamond",
				diamondAddress,
				diamondIface,
				"registerPartyB",
				[partyB.address],
				partyB.address,
				!force && state.isPartyB === true ? "already registered on core" : undefined,
			),
		)
	}

	if (partyB.setBindable) {
		push(
			buildCall(
				`${partyB.label}: set bindable=${partyB.bindable}`,
				"Symmio core diamond",
				diamondAddress,
				diamondIface,
				"setPartyBBindable",
				[partyB.address, partyB.bindable],
				partyB.address,
				!force && state.isBindable === partyB.bindable ? `already bindable=${partyB.bindable}` : undefined,
			),
		)
	}

	if (partyB.metadata) {
		const metadataTuple = [partyB.metadata.name, partyB.metadata.brandColor, partyB.metadata.metadata]
		push(
			buildCall(
				`${partyB.label}: set metadata`,
				"Symmio core diamond",
				diamondAddress,
				diamondIface,
				"setPartyBMetadata",
				[partyB.address, metadataTuple],
				partyB.address,
				!force && metadataEquals(state.metadata, partyB.metadata) ? "metadata already matches" : undefined,
			),
		)
	}

	for (const symbolType of partyB.symbolTypes) {
		push(
			buildCall(
				`${partyB.label}: whitelist symbolType=${symbolType}`,
				"Symmio core diamond",
				diamondAddress,
				diamondIface,
				"whitelistSymbolType",
				[partyB.address, symbolType],
				partyB.address,
				!force && state.whitelistedSymbolTypes[symbolType.toString()] === true ? `symbolType=${symbolType} already whitelisted` : undefined,
			),
		)
	}

	if (partyB.symbolIds.length > 0) {
		push(
			buildCall(
				`${partyB.label}: whitelist ${partyB.symbolIds.length} explicit symbol(s)`,
				"Symmio core diamond",
				diamondAddress,
				diamondIface,
				"whitelistSymbols",
				[partyB.address, partyB.symbolIds],
				partyB.address,
			),
		)
	}

	if (partyB.registerOnInstantLayer) {
		if (!instantLayerAddress) {
			throw new Error(`${partyB.label} requested registerOnInstantLayer but INSTANT_LAYER_ADDRESS/upgrade.instantLayerAddress is missing`)
		}
		push(
			buildCall(
				`${partyB.label}: register on InstantLayer`,
				"InstantLayer",
				instantLayerAddress,
				instantLayerIface,
				"registerPartyBs",
				[[partyB.address]],
				partyB.address,
				!force && state.registeredOnInstantLayer === true ? "already registered on InstantLayer" : undefined,
			),
		)
	}

	return { included, skipped }
}

function formatArg(value: any): string {
	if (typeof value === "bigint") return value.toString()
	if (Array.isArray(value)) return `[${value.map(formatArg).join(", ")}]`
	if (typeof value === "object" && value !== null) return JSON.stringify(value, jsonReplacer)
	return String(value)
}

function printConfigOverview(params: {
	networkName: string
	chainId: bigint
	upgradeConfigFile: string
	partyBConfigFile: string
	diamond: SourceValue<string | undefined>
	safe: SourceValue<string | undefined>
	instantLayer: SourceValue<string | undefined>
	safeServiceUrl?: string
	safeMultiSendAddress?: string
	execute: boolean
	submitSafeProposal: boolean
	skipPreflight: boolean
	force: boolean
	partyBs: PartyBPlan[]
}) {
	console.log("")
	console.log("PartyB Registration Config Overview")
	console.log("-----------------------------------")
	console.log(`Network:              ${params.networkName} (chainId ${params.chainId})`)
	console.log(`Upgrade config:       ${params.upgradeConfigFile} (${fs.existsSync(params.upgradeConfigFile) ? "found" : "missing"})`)
	console.log(`PartyB config:        ${params.partyBConfigFile}`)
	console.log(`Diamond:              ${params.diamond.value || "(missing)"} (${params.diamond.source})`)
	console.log(`Safe:                 ${params.safe.value || "(missing)"} (${params.safe.source})`)
	console.log(`InstantLayer:         ${params.instantLayer.value || "(missing)"} (${params.instantLayer.source})`)
	console.log(`Safe service URL:     ${params.safeServiceUrl || "(auto/unused)"}`)
	console.log(`Safe MultiSend:       ${params.safeMultiSendAddress || "(not set)"}`)
	console.log(`Mode:                 ${params.execute ? "direct execution" : params.submitSafeProposal ? "Safe proposal" : "generate files only"}`)
	console.log(`Preflight:            ${params.skipPreflight ? "skipped" : "enabled"}`)
	console.log(`Force include calls:  ${params.force}`)
	console.log(`PartyBs in config:    ${params.partyBs.length}`)
	for (const partyB of params.partyBs) {
		console.log(`  - ${partyB.label}: ${partyB.address}`)
		console.log(
			`    core=${partyB.registerOnCore}, bindable=${partyB.setBindable ? partyB.bindable : "(unchanged)"}, metadata=${Boolean(
				partyB.metadata,
			)}, symbolTypes=[${partyB.symbolTypes.join(", ")}], symbolIds=[${partyB.symbolIds.join(", ")}], instantLayer=${partyB.registerOnInstantLayer}`,
		)
	}
	console.log("")
}

function printStateOverview(partyBs: PartyBPlan[], states: Map<string, CurrentState>) {
	console.log("Current On-chain State")
	console.log("----------------------")
	for (const partyB of partyBs) {
		const state = states.get(partyB.address)!
		console.log(`- ${partyB.label}: ${partyB.address}`)
		console.log(`  isPartyB: ${state.isPartyB === undefined ? "unknown" : state.isPartyB}`)
		console.log(`  isBindable: ${state.isBindable === undefined ? "unknown" : state.isBindable}`)
		if (partyB.metadata) {
			const match = metadataEquals(state.metadata, partyB.metadata)
			console.log(`  metadata matches desired: ${state.metadata ? match : "unknown"}`)
		}
		for (const symbolType of partyB.symbolTypes) {
			const value = state.whitelistedSymbolTypes[symbolType.toString()]
			console.log(`  symbolType ${symbolType} whitelisted: ${value === undefined ? "unknown" : value}`)
		}
		if (partyB.registerOnInstantLayer) {
			console.log(`  registeredOnInstantLayer: ${state.registeredOnInstantLayer === undefined ? "unknown" : state.registeredOnInstantLayer}`)
		}
		for (const error of state.errors) console.log(`  warning: ${error}`)
	}
	console.log("")
}

function printHumanReadableCalls(title: string, calls: PlannedCall[]) {
	console.log(title)
	console.log("-".repeat(title.length))
	if (calls.length === 0) {
		console.log("No calls.")
		console.log("")
		return
	}

	calls.forEach((call, index) => {
		console.log(`${index + 1}. ${call.label}`)
		console.log(`   Target:   ${call.toLabel} (${call.to})`)
		console.log(`   Method:   ${call.methodName}(${call.args.map(formatArg).join(", ")})`)
		if (call.skipReason) console.log(`   Skip:     ${call.skipReason}`)
		console.log(`   Calldata: ${call.safeTx.data}`)
	})
	console.log("")
}

async function requireConfirmation(action: string, calls: PlannedCall[]) {
	printHumanReadableCalls(`Human-readable calldata before ${action}`, calls)
	if (boolEnv("SKIP_CONFIRMATION") || boolEnv("YES")) {
		console.log("Skipping confirmation because SKIP_CONFIRMATION/YES is true.")
		return
	}
	if (!input.isTTY) {
		throw new Error(`Interactive confirmation is required before ${action}; rerun in a terminal or set SKIP_CONFIRMATION=true after review`)
	}

	const rl = createInterface({ input, output })
	try {
		const answer = await rl.question(`Type CONFIRM to ${action}: `)
		if (answer.trim() !== "CONFIRM") throw new Error(`${action} aborted by user`)
	} finally {
		rl.close()
	}
}

async function getExecutorSigner(executorAddress?: string) {
	const signers = await ethers.getSigners()
	if (!executorAddress) return signers[0] ?? ethers.provider.getSigner()

	const expected = ethers.getAddress(executorAddress)
	for (const signer of signers) {
		const actual = ethers.getAddress(await signer.getAddress())
		if (actual.toLowerCase() === expected.toLowerCase()) return signer
	}
	throw new Error(`No configured Hardhat signer matched EXECUTOR_ADDRESS ${expected}`)
}

async function executeCalls(calls: PlannedCall[], executorAddress?: string) {
	const signer = await getExecutorSigner(executorAddress)
	const signerAddress = ethers.getAddress(await signer.getAddress())
	console.log(`Executing ${calls.length} transaction(s) with signer ${signerAddress}`)
	const receipts: Array<{ label: string; hash: string; gasUsed: string }> = []

	for (const call of calls) {
		console.log(`Submitting: ${call.label}`)
		const contract = new ethers.Contract(call.to, call.iface, signer)
		const tx = await contract.getFunction(call.methodName)(...call.args)
		const receipt = await tx.wait()
		console.log(`  tx: ${receipt.hash} (gas: ${receipt.gasUsed})`)
		receipts.push({ label: call.label, hash: receipt.hash, gasUsed: receipt.gasUsed.toString() })
	}
	return receipts
}

function buildSafeBatch(chainId: bigint, safeAddress: string, ownerAddress: string, calls: PlannedCall[], networkName: string): SafeBatch {
	return {
		version: "1.0",
		chainId: chainId.toString(),
		createdAt: Date.now(),
		meta: {
			name: "Symmio core - PartyB registration",
			description: `PartyB onboarding on ${networkName}: ${calls.length} transaction(s)`,
			txBuilderVersion: SAFE_TX_BUILDER_VERSION,
			createdFromSafeAddress: safeAddress,
			createdFromOwnerAddress: ownerAddress,
		},
		transactions: calls.map(call => call.safeTx),
	}
}

function encodeMultiSendTransactions(transactions: SafeTransaction[]): string {
	return ethers.concat(
		transactions.map(tx => {
			const data = ethers.getBytes(tx.data)
			return ethers.solidityPacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, tx.to, BigInt(tx.value), BigInt(data.length), tx.data])
		}),
	)
}

function buildSafeProposalTx(calls: PlannedCall[], safeMultiSendAddress?: string): SafeProposalTx {
	if (calls.length === 1) {
		const tx = calls[0].safeTx
		return { to: tx.to, value: tx.value, data: tx.data, operation: 0 }
	}
	if (!safeMultiSendAddress) {
		throw new Error("SAFE_MULTISEND_ADDRESS or partyBRegistration.safeMultiSendAddress is required to submit multiple calls as one Safe proposal")
	}

	const multiSendData = encodeMultiSendTransactions(calls.map(call => call.safeTx))
	return {
		to: safeMultiSendAddress,
		value: "0",
		data: multiSendIface.encodeFunctionData("multiSend", [multiSendData]),
		operation: 1,
		multiSendData,
	}
}

function getSafeServiceUrl(chainId: bigint, override?: string): string {
	if (override) return override.replace(/\/$/, "")
	const slug = SAFE_SERVICE_SLUG_BY_CHAIN_ID[chainId.toString()]
	if (!slug) throw new Error(`No Safe Transaction Service slug configured for chainId ${chainId}; set SAFE_SERVICE_URL`)
	return `https://api.safe.global/tx-service/${slug}/api/v1`
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, {
		...init,
		headers: {
			"Content-Type": "application/json",
			...(init?.headers || {}),
		},
	})
	if (!response.ok) {
		const body = await response.text().catch(() => "")
		throw new Error(`${response.status} ${response.statusText}${body ? `: ${body}` : ""}`)
	}
	return (await response.json()) as T
}

async function resolveConfigVar(name: string): Promise<string> {
	const variable = configVariable(name)
	return (hre as any).hooks.runHandlerChain("configurationVariables", "fetchValue", [variable], async (_ctx: unknown, v: { name: string }) => {
		const value = process.env[v.name]
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(`Configuration variable '${v.name}' is not set`)
		}
		return value
	})
}

async function getSafeSubmitterSigner(safeSubmitterAddress: string, safeSubmitterPrivateKey?: string, safeSubmitterKeyName = "TEAM_PROPOSER") {
	const expected = ethers.getAddress(safeSubmitterAddress)
	const signers = await ethers.getSigners()
	for (const signer of signers) {
		const actual = ethers.getAddress(await signer.getAddress())
		if (actual.toLowerCase() === expected.toLowerCase()) return signer
	}

	const privateKey = safeSubmitterPrivateKey || (await resolveConfigVar(safeSubmitterKeyName))
	const wallet = new ethers.Wallet(privateKey, ethers.provider)
	if (wallet.address.toLowerCase() !== expected.toLowerCase()) {
		throw new Error(`Loaded Safe submitter ${wallet.address}, but expected ${expected}`)
	}
	return wallet
}

async function getSafeInfo(safeAddress: string, serviceUrl: string): Promise<SafeInfo> {
	const safe = new ethers.Contract(safeAddress, safeIface, ethers.provider)
	const [onChainNonce, onChainOwners, serviceInfo] = await Promise.all([
		safe.nonce().then((value: bigint) => Number(value)),
		safe.getOwners().then((owners: string[]) => owners.map(owner => ethers.getAddress(owner))),
		fetchJson<SafeInfo>(`${serviceUrl}/safes/${safeAddress}/`).catch(() => undefined),
	])
	return {
		nonce: serviceInfo?.nonce ?? onChainNonce,
		owners: (serviceInfo?.owners ?? onChainOwners).map((owner: string) => ethers.getAddress(owner)),
	}
}

function parseSafeNonceOverride(value: string | undefined): number | undefined {
	if (!value) return undefined
	const parsed = Number(BigInt(value))
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid SAFE_NONCE/SAFE_TX_NONCE: ${value}`)
	return parsed
}

async function buildAndMaybeSubmitSafeProposal(params: {
	chainId: bigint
	networkName: string
	safeAddress: string
	safeTxCreatorAddress: string
	safeSubmitterAddress: string
	safeSubmitterPrivateKey?: string
	safeSubmitterKeyName: string
	safeServiceUrl: string
	safeNonceOverride?: number
	calls: PlannedCall[]
	proposalTx: SafeProposalTx
	submitSafeProposal: boolean
	proposalFile: string
}) {
	const safe = new ethers.Contract(params.safeAddress, safeIface, ethers.provider)
	const safeInfo = await getSafeInfo(params.safeAddress, params.safeServiceUrl)
	const safeNonce = params.safeNonceOverride ?? safeInfo.nonce ?? Number(await safe.nonce())
	const safeTx = {
		to: params.proposalTx.to,
		value: BigInt(params.proposalTx.value),
		data: params.proposalTx.data,
		operation: params.proposalTx.operation,
		safeTxGas: 0n,
		baseGas: 0n,
		gasPrice: 0n,
		gasToken: ethers.ZeroAddress,
		refundReceiver: ethers.ZeroAddress,
		nonce: BigInt(safeNonce),
	}
	const safeTxHash = await safe.getTransactionHash(
		safeTx.to,
		safeTx.value,
		safeTx.data,
		safeTx.operation,
		safeTx.safeTxGas,
		safeTx.baseGas,
		safeTx.gasPrice,
		safeTx.gasToken,
		safeTx.refundReceiver,
		safeTx.nonce,
	)
	const typedDataHash = ethers.TypedDataEncoder.hash({ chainId: params.chainId, verifyingContract: params.safeAddress }, SAFE_TX_TYPES, safeTx)
	if (typedDataHash.toLowerCase() !== safeTxHash.toLowerCase()) {
		throw new Error(`Safe typed-data hash ${typedDataHash} did not match on-chain getTransactionHash ${safeTxHash}`)
	}

	const proposal = {
		to: safeTx.to,
		value: params.proposalTx.value,
		data: safeTx.data,
		operation: safeTx.operation,
		safeTxGas: 0,
		baseGas: 0,
		gasPrice: "0",
		gasToken: null,
		refundReceiver: null,
		nonce: safeNonce,
		contractTransactionHash: safeTxHash,
		sender: params.safeSubmitterAddress,
		origin: `Symmio PartyB registration on ${params.networkName}`,
	}
	const report: any = {
		network: params.networkName,
		chainId: params.chainId.toString(),
		safe: params.safeAddress,
		serviceUrl: params.safeServiceUrl,
		safeNonce,
		safeTxHash,
		typedDataHash,
		creatorAddress: params.safeTxCreatorAddress,
		submitterAddress: params.safeSubmitterAddress,
		submitterKeyName: params.safeSubmitterKeyName,
		submitSafeProposal: params.submitSafeProposal,
		submitted: false,
		proposal,
		safeTx: {
			...proposal,
			gasToken: ethers.ZeroAddress,
			refundReceiver: ethers.ZeroAddress,
		},
		multiSend: params.proposalTx.operation === 1 ? { to: params.proposalTx.to, transactionsData: params.proposalTx.multiSendData } : undefined,
		owners: safeInfo.owners,
		humanReadableCalls: params.calls.map(call => ({
			label: call.label,
			to: call.to,
			method: call.methodName,
			args: call.args.map(formatArg),
			calldata: call.safeTx.data,
		})),
	}
	writeJson(params.proposalFile, report)

	if (!params.submitSafeProposal) {
		report.submissionSkippedReason = "SUBMIT_SAFE_PROPOSAL is not true"
		writeJson(params.proposalFile, report)
		return report
	}

	console.log("")
	console.log("Safe proposal transaction")
	console.log("-------------------------")
	console.log(`Safe:      ${params.safeAddress}`)
	console.log(`Target:    ${params.proposalTx.to}`)
	console.log(`Operation: ${params.proposalTx.operation === 1 ? "delegatecall" : "call"}`)
	console.log(`Nonce:     ${safeNonce}`)
	console.log(`Safe hash: ${safeTxHash}`)
	console.log(`Calldata:  ${params.proposalTx.data}`)
	if (params.proposalTx.multiSendData) console.log(`MultiSend inner data: ${params.proposalTx.multiSendData}`)
	console.log("")

	await requireConfirmation("submit Safe proposal", params.calls)
	const signer = await getSafeSubmitterSigner(params.safeSubmitterAddress, params.safeSubmitterPrivateKey, params.safeSubmitterKeyName)
	const signerAddress = ethers.getAddress(await signer.getAddress())
	const signature = await signer.signTypedData({ chainId: params.chainId, verifyingContract: params.safeAddress }, SAFE_TX_TYPES, safeTx)
	const payload = {
		...proposal,
		sender: signerAddress,
		signature,
	}
	report.payload = payload

	try {
		report.submitResponse = await fetchJson(`${params.safeServiceUrl}/safes/${params.safeAddress}/multisig-transactions/`, {
			method: "POST",
			body: JSON.stringify(payload),
		})
		report.submitted = true
	} catch (err) {
		report.submitError = getErrorMessage(err)
		report.submissionSkippedReason = "Safe Transaction Service rejected the proposal submission"
	}
	writeJson(params.proposalFile, report)
	return report
}

async function main() {
	const networkName = connection.networkName || "unknown"
	const chainId = (await ethers.provider.getNetwork()).chainId
	const outputSuffix = sanitizeSuffix(process.env.PARTYB_REGISTRATION_OUTPUT_SUFFIX || networkName || `chain-${chainId}`)
	const upgradeConfigFile = resolveConfigFile("upgrade", networkName, process.env.UPGRADE_CONFIG_FILE)
	const configFile = resolveConfigFile("partyBRegistration", networkName, process.env.PARTYB_REGISTRATION_CONFIG_FILE)
	const config = readJsonIfExists<PartyBRegistrationConfig>(configFile)
	if (!config) {
		throw new Error(`PartyB registration config not found: ${configFile}\nCopy scripts/upgrade/config/samples/partyBRegistration.sample.json first.`)
	}
	const shared = loadUpgradeConfigShared(networkName)

	const execute = boolEnv("EXECUTE")
	const submitSafeProposal = boolEnv("SUBMIT_SAFE_PROPOSAL")
	if (execute && submitSafeProposal) throw new Error("Use either EXECUTE=true or SUBMIT_SAFE_PROPOSAL=true, not both")
	const skipPreflight = boolEnv("SKIP_PREFLIGHT")
	const force = boolEnv("FORCE")

	const diamond = resolveString(
		process.env.DIAMOND_ADDRESS,
		config.diamondAddress,
		shared.diamondAddress,
		"DIAMOND_ADDRESS",
		"diamondAddress",
		"diamondAddress",
	)
	const safe = resolveString(process.env.SAFE_ADDRESS, config.safeAddress, shared.safeAddress, "SAFE_ADDRESS", "safeAddress", "safeAddress")
	const instantLayer = resolveString(
		process.env.INSTANT_LAYER_ADDRESS,
		config.instantLayerAddress,
		shared.instantLayerAddress,
		"INSTANT_LAYER_ADDRESS",
		"instantLayerAddress",
		"instantLayerAddress",
	)

	if (!diamond.value) throw new Error("DIAMOND_ADDRESS or partyBRegistration/upgrade diamondAddress is required")
	const diamondAddress = parseAddress(diamond.value, "diamondAddress")
	const safeAddress = parseOptionalAddress(safe.value, "safeAddress")
	const instantLayerAddress = parseOptionalAddress(instantLayer.value, "instantLayerAddress")
	const partyBs = normalizePartyBEntries(config)
	const safeTxCreatorAddress = parseOptionalAddress(
		firstString(process.env.SAFE_TX_CREATOR_ADDRESS, process.env.SAFE_PROPOSER_ADDRESS, config.safeTxCreatorAddress),
		"safeTxCreatorAddress",
	)
	const safeSubmitterAddress = parseOptionalAddress(
		firstString(process.env.SAFE_SUBMITTER_ADDRESS, process.env.SAFE_SIGNER_ADDRESS, config.safeSubmitterAddress, safeTxCreatorAddress),
		"safeSubmitterAddress",
	)
	const safeServiceUrlOverride = firstString(process.env.SAFE_SERVICE_URL, config.safeServiceUrl)
	const safeMultiSendAddress = parseOptionalAddress(
		firstString(process.env.SAFE_MULTISEND_ADDRESS, config.safeMultiSendAddress),
		"safeMultiSendAddress",
	)

	printConfigOverview({
		networkName,
		chainId,
		upgradeConfigFile,
		partyBConfigFile: configFile,
		diamond: { ...diamond, value: diamondAddress },
		safe: { ...safe, value: safeAddress },
		instantLayer: { ...instantLayer, value: instantLayerAddress },
		safeServiceUrl: safeServiceUrlOverride,
		safeMultiSendAddress,
		execute,
		submitSafeProposal,
		skipPreflight,
		force,
		partyBs,
	})

	const states = new Map<string, CurrentState>()
	for (const partyB of partyBs) {
		states.set(partyB.address, await readCurrentState(partyB, diamondAddress, instantLayerAddress, skipPreflight))
	}
	printStateOverview(partyBs, states)

	const included: PlannedCall[] = []
	const skipped: PlannedCall[] = []
	for (const partyB of partyBs) {
		const plan = buildPlannedCalls(partyB, states.get(partyB.address)!, diamondAddress, instantLayerAddress, force)
		included.push(...plan.included)
		skipped.push(...plan.skipped)
	}

	printHumanReadableCalls("Calls to include", included)
	printHumanReadableCalls("Calls skipped", skipped)

	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	const safeBatchFile = path.join(OUTPUT_DIR, `partyb-registration-safe-batch-${outputSuffix}.json`)
	const reportFile = path.join(OUTPUT_DIR, `partyb-registration-report-${outputSuffix}.json`)
	const proposalFile = path.join(OUTPUT_DIR, `partyb-registration-safe-proposal-${outputSuffix}.json`)

	if (safeAddress) {
		const safeBatch = buildSafeBatch(chainId, safeAddress, safeTxCreatorAddress ?? "", included, networkName)
		writeJson(safeBatchFile, safeBatch)
		console.log(`Safe batch: ${safeBatchFile}`)
	} else {
		console.log("Safe batch skipped because no Safe address was configured.")
	}

	const report: any = {
		generatedAt: new Date().toISOString(),
		network: networkName,
		chainId: chainId.toString(),
		configFile,
		upgradeConfigFile,
		diamondAddress,
		safeAddress,
		instantLayerAddress,
		execute,
		submitSafeProposal,
		skipPreflight,
		force,
		partyBs,
		currentState: Object.fromEntries(states),
		includedCalls: included.map(call => ({
			label: call.label,
			to: call.to,
			methodName: call.methodName,
			args: call.args.map(formatArg),
			calldata: call.safeTx.data,
		})),
		skippedCalls: skipped.map(call => ({
			label: call.label,
			methodName: call.methodName,
			skipReason: call.skipReason,
		})),
		outputs: {
			safeBatchFile: safeAddress ? safeBatchFile : undefined,
			reportFile,
			proposalFile: submitSafeProposal ? proposalFile : undefined,
		},
	}
	writeJson(reportFile, report)
	console.log(`Report: ${reportFile}`)

	if (included.length === 0) {
		console.log("Nothing to submit or execute.")
		return
	}

	if (execute) {
		await requireConfirmation("execute direct transactions", included)
		report.executedTransactions = await executeCalls(included, process.env.EXECUTOR_ADDRESS)
		writeJson(reportFile, report)
		return
	}

	if (submitSafeProposal) {
		if (!safeAddress) throw new Error("SAFE_ADDRESS or safeAddress is required for SUBMIT_SAFE_PROPOSAL=true")
		if (!safeSubmitterAddress) throw new Error("SAFE_SUBMITTER_ADDRESS/SAFE_SIGNER_ADDRESS or safeSubmitterAddress is required")
		const safeServiceUrl = getSafeServiceUrl(chainId, safeServiceUrlOverride)
		const proposalTx = buildSafeProposalTx(included, safeMultiSendAddress)
		report.safeProposal = await buildAndMaybeSubmitSafeProposal({
			chainId,
			networkName,
			safeAddress,
			safeTxCreatorAddress: safeTxCreatorAddress ?? safeSubmitterAddress,
			safeSubmitterAddress,
			safeSubmitterPrivateKey: firstString(
				process.env.SAFE_SUBMITTER_PRIVATE_KEY,
				process.env.SAFE_SIGNER_PRIVATE_KEY,
				process.env.SAFE_PROPOSER_PRIVATE_KEY,
			),
			safeSubmitterKeyName:
				process.env.SAFE_SUBMITTER_KEY_NAME || process.env.SAFE_SIGNER_KEY_NAME || process.env.SAFE_PROPOSER_KEY_NAME || "TEAM_PROPOSER",
			safeServiceUrl,
			safeNonceOverride: parseSafeNonceOverride(firstString(process.env.SAFE_NONCE, process.env.SAFE_TX_NONCE)),
			calls: included,
			proposalTx,
			submitSafeProposal,
			proposalFile,
		})
		writeJson(reportFile, report)
		console.log(`Safe proposal report: ${proposalFile}`)
		return
	}

	console.log(
		"Generation complete. Review the human-readable calldata and import the Safe batch, or rerun with EXECUTE=true / SUBMIT_SAFE_PROPOSAL=true.",
	)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
