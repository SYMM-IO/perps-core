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
 *   USE_KEYSTORE=true SUBMIT_SAFE_PROPOSAL=true \
 *     npx hardhat run --no-compile scripts/upgrade/registerPartyB.ts --network <network>
 *
 * In proposal mode Hardhat loads signer[0] from TEAM_PROPOSER by default. Override with
 * SAFE_SUBMITTER_ADDRESS/SAFE_SUBMITTER_KEY_NAME only when you need a different Safe owner/delegate.
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

type HumanReadablePlannedCall = {
	label: string
	to: string
	value: string
	operation: string
	method: string
	args: string[]
	contractMethod?: SafeTransaction["contractMethod"]
	contractInputsValues?: SafeTransaction["contractInputsValues"]
	calldata: string
}

type SafeProposalTx = {
	to: string
	value: string
	data: string
	operation: number
	multiSendData?: string
	multiSendAddressSource?: string
}

type SafeInfo = {
	nonce?: number
	owners?: string[]
	threshold?: number
	version?: string
}

type DelegateInfo = {
	delegate?: string
	delegator?: string
}

type SafeDelegatesResult = {
	delegates: string[]
	fetched: boolean
	error?: string
}

type SafeDeployment = {
	version: string
	contracts: Array<{
		contractName: string
		address: string
	}>
}

type SafeDecodedParameter = {
	name?: string
	type?: string
	value?: string
	valueDecoded?: unknown
}

type SafeDecodedData = {
	method?: string
	parameters?: SafeDecodedParameter[]
}

type SafeDecodedInnerTransaction = {
	operation?: number
	to?: string
	value?: string
	data?: string
	dataDecoded?: SafeDecodedData | null
}

type SafeFrontDecodeCallCheck = {
	label: string
	to: string
	expectedMethod: string
	decodedMethod?: string
	decoded: boolean
	issue?: string
}

type SafeFrontDecodeCheck = {
	checked: boolean
	ok: boolean
	serviceUrl: string
	proposalTarget: string
	proposalMethod?: string
	importBatchFile?: string
	calls: SafeFrontDecodeCallCheck[]
	issues: string[]
	note: string
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
	"function getThreshold() view returns (uint256)",
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

const COLOR_ENABLED = boolEnv("FORCE_COLOR") || (!process.env.NO_COLOR && output.isTTY)
const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
}

const paint = {
	bold: (value: string) => color(ANSI.bold, value),
	dim: (value: string) => color(ANSI.dim, value),
	red: (value: string) => color(ANSI.red, value),
	green: (value: string) => color(ANSI.green, value),
	yellow: (value: string) => color(ANSI.yellow, value),
	blue: (value: string) => color(ANSI.blue, value),
	cyan: (value: string) => color(ANSI.cyan, value),
	gray: (value: string) => color(ANSI.gray, value),
}

function color(code: string, value: string): string {
	return COLOR_ENABLED ? `${code}${value}${ANSI.reset}` : value
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) return value.trim()
	}
	return undefined
}

function firstStringWithSource(...entries: Array<[unknown, string]>): SourceValue<string | undefined> {
	for (const [value, source] of entries) {
		if (typeof value === "string" && value.trim().length > 0) return { value: value.trim(), source }
	}
	return { value: undefined, source: "not set" }
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

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "")
}

function visibleLength(value: string): number {
	return stripAnsi(value).length
}

function padCell(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleLength(value)))
}

function renderTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, index) => Math.max(visibleLength(header), ...rows.map(row => visibleLength(row[index] ?? ""))))
	const border = `+${widths.map(width => "-".repeat(width + 2)).join("+")}+`
	const renderRow = (cells: string[]) => `| ${cells.map((cell, index) => padCell(cell, widths[index])).join(" | ")} |`
	return [
		paint.gray(border),
		renderRow(headers.map(header => paint.bold(header))),
		paint.gray(border),
		...rows.map(renderRow),
		paint.gray(border),
	].join("\n")
}

function section(title: string): void {
	console.log("")
	console.log(paint.bold(paint.cyan(title)))
	console.log(paint.gray("-".repeat(title.length)))
}

function formatAddress(address: string | undefined): string {
	return address ? paint.cyan(address) : paint.dim("(missing)")
}

function formatMaybe(value: string | undefined): string {
	return value ? paint.cyan(value) : paint.dim("(not set)")
}

function formatBool(value: boolean | undefined, options: { trueLabel?: string; falseLabel?: string; falseIsBad?: boolean } = {}): string {
	if (value === undefined) return paint.yellow("unknown")
	if (value) return paint.green(options.trueLabel ?? "true")
	return options.falseIsBad ? paint.red(options.falseLabel ?? "false") : paint.dim(options.falseLabel ?? "false")
}

function formatMatch(value: boolean | "unknown"): string {
	if (value === "unknown") return paint.yellow("unknown")
	return value ? paint.green("matches") : paint.red("differs")
}

function formatMetadataValue(value: string | undefined): string {
	if (value === undefined) return paint.yellow("unavailable")
	if (value.length === 0) return paint.dim("(empty)")
	return value
}

function formatList(values: Array<string | bigint>): string {
	return values.length > 0 ? values.map(value => String(value)).join(", ") : paint.dim("(none)")
}

function formatMethod(call: PlannedCall): string {
	return `${call.methodName}(${call.args.map(formatArg).join(", ")})`
}

function describeSafeOperation(operation: number): string {
	return operation === 1 ? "delegatecall (MultiSend)" : "call"
}

function describePlannedCall(call: PlannedCall): HumanReadablePlannedCall {
	return {
		label: call.label,
		to: call.to,
		value: call.safeTx.value,
		operation: describeSafeOperation(0),
		method: call.methodName,
		args: call.args.map(formatArg),
		contractMethod: call.safeTx.contractMethod,
		contractInputsValues: call.safeTx.contractInputsValues,
		calldata: call.safeTx.data,
	}
}

function buildSafeDataDecodedFromCall(call: HumanReadablePlannedCall) {
	return {
		method: call.method,
		parameters: (call.contractMethod?.inputs ?? []).map(input => ({
			name: input.name,
			type: input.type,
			value: call.contractInputsValues?.[input.name] ?? "",
			components: input.components,
		})),
	}
}

function buildProposalDataDecoded(proposalTx: SafeProposalTx, humanReadableCalls: HumanReadablePlannedCall[]) {
	if (proposalTx.operation === 1) {
		return {
			method: "multiSend",
			target: proposalTx.to,
			operation: describeSafeOperation(proposalTx.operation),
			parameters: [
				{
					name: "transactions",
					type: "bytes",
					value: proposalTx.multiSendData,
					valueDecoded: humanReadableCalls.map(call => ({
						operation: 0,
						operationName: call.operation,
						to: call.to,
						value: call.value,
						data: call.calldata,
						dataDecoded: buildSafeDataDecodedFromCall(call),
					})),
				},
			],
		}
	}

	const call = humanReadableCalls[0]
	return {
		target: proposalTx.to,
		operation: describeSafeOperation(proposalTx.operation),
		...buildSafeDataDecodedFromCall(call),
	}
}

function stripRawCalldata(call: HumanReadablePlannedCall) {
	const { calldata: _calldata, ...decodedCall } = call
	return decodedCall
}

function getDecodedInnerTransactions(dataDecoded: SafeDecodedData | undefined): SafeDecodedInnerTransaction[] {
	const transactions = dataDecoded?.parameters?.find(param => param.name === "transactions")?.valueDecoded
	return Array.isArray(transactions) ? (transactions as SafeDecodedInnerTransaction[]) : []
}

async function decodeWithSafeService(safeServiceUrl: string, to: string, data: string): Promise<{ decoded?: SafeDecodedData; error?: string }> {
	try {
		return {
			decoded: await fetchJson<SafeDecodedData>(`${safeServiceUrl}/data-decoder/`, {
				method: "POST",
				body: JSON.stringify({ to, data }),
			}),
		}
	} catch (err) {
		return { error: getErrorMessage(err) }
	}
}

async function checkSafeFrontDecode(params: {
	safeServiceUrl: string
	proposalTx: SafeProposalTx
	calls: PlannedCall[]
	safeBatchFile?: string
}): Promise<SafeFrontDecodeCheck> {
	const issues: string[] = []
	const proposalDecode = await decodeWithSafeService(params.safeServiceUrl, params.proposalTx.to, params.proposalTx.data)
	if (proposalDecode.error) issues.push(`Safe decoder could not decode proposal transaction: ${proposalDecode.error}`)

	const proposalDecoded = proposalDecode.decoded
	const innerTransactions = params.proposalTx.operation === 1 ? getDecodedInnerTransactions(proposalDecoded) : []
	const callChecks = params.calls.map((call, index): SafeFrontDecodeCallCheck => {
		const decoded = params.proposalTx.operation === 1 ? innerTransactions[index]?.dataDecoded : proposalDecoded
		const decodedMethod = decoded?.method
		const methodMatches = decodedMethod === call.methodName
		const issue = methodMatches
			? undefined
			: decodedMethod
				? `Safe decoder returned ${decodedMethod}, expected ${call.methodName}`
				: "Safe decoder returned no method; Safe Front may show raw calldata for this call"
		if (issue) issues.push(`${call.label}: ${issue}`)
		return {
			label: call.label,
			to: call.to,
			expectedMethod: call.methodName,
			decodedMethod,
			decoded: methodMatches,
			issue,
		}
	})

	if (params.proposalTx.operation === 1 && proposalDecoded?.method !== "multiSend") {
		issues.push(`Safe decoder returned proposal method ${proposalDecoded?.method ?? "(none)"}, expected multiSend`)
	}

	return {
		checked: true,
		ok: issues.length === 0,
		serviceUrl: params.safeServiceUrl,
		proposalTarget: params.proposalTx.to,
		proposalMethod: proposalDecoded?.method,
		importBatchFile: params.safeBatchFile,
		calls: callChecks,
		issues,
		note: "Safe Front decodes API-submitted transactions from the Safe decoder service. The Transaction Builder batch remains the human-readable Safe Front import artifact.",
	}
}

function printSafeFrontDecodeCheck(check: SafeFrontDecodeCheck) {
	section("Safe Front decode check")
	console.log(
		renderTable(
			["#", "Action", "Expected", "Safe decoder", "Result"],
			check.calls.map((call, index) => [
				paint.bold(String(index + 1)),
				paint.bold(call.label),
				call.expectedMethod,
				call.decodedMethod ?? paint.dim("(not decoded)"),
				call.decoded ? paint.green("human-readable") : paint.red("raw in Safe Front"),
			]),
		),
	)
	if (check.importBatchFile) {
		console.log(`Safe Transaction Builder import: ${check.importBatchFile}`)
	}
	if (!check.ok) {
		console.log(paint.yellow("Safe Front may show one or more inner calls as raw calldata for this API proposal."))
	}
}

function printConfigOverview(params: {
	networkName: string
	chainId: bigint
	upgradeConfigFile: string
	partyBConfigFile: string
	diamond: SourceValue<string | undefined>
	safe: SourceValue<string | undefined>
	safeTxCreator: SourceValue<string | undefined>
	safeSubmitter: SourceValue<string | undefined>
	instantLayer: SourceValue<string | undefined>
	safeServiceUrl?: string
	safeMultiSend: SourceValue<string | undefined>
	execute: boolean
	submitSafeProposal: boolean
	skipPreflight: boolean
	force: boolean
	partyBs: PartyBPlan[]
}) {
	section("PartyB Registration Config Overview")
	console.log(
		renderTable(
			["Field", "Value", "Source"],
			[
				["Network", `${paint.blue(params.networkName)} ${paint.dim(`(chainId ${params.chainId})`)}`, "hardhat"],
				[
					"Upgrade config",
					`${params.upgradeConfigFile} ${fs.existsSync(params.upgradeConfigFile) ? paint.green("(found)") : paint.yellow("(missing)")}`,
					"resolved",
				],
				["PartyB config", params.partyBConfigFile, "resolved"],
				["Diamond", formatAddress(params.diamond.value), params.diamond.source],
				["Safe", formatAddress(params.safe.value), params.safe.source],
				["Safe tx creator", formatAddress(params.safeTxCreator.value), params.safeTxCreator.source],
				["Safe proposer/sender", formatAddress(params.safeSubmitter.value), params.safeSubmitter.source],
				["InstantLayer", formatAddress(params.instantLayer.value), params.instantLayer.source],
				["Safe service URL", params.safeServiceUrl ? paint.cyan(params.safeServiceUrl) : paint.dim("(auto/unused)"), "config/env"],
				["Safe MultiSend", formatMaybe(params.safeMultiSend.value), params.safeMultiSend.source],
				[
					"Mode",
					params.execute
						? paint.yellow("direct execution")
						: params.submitSafeProposal
							? paint.yellow("Safe proposal")
							: paint.green("generate files only"),
					"env",
				],
				["Preflight", params.skipPreflight ? paint.yellow("skipped") : paint.green("enabled"), "env"],
				["Force include calls", formatBool(params.force), "env"],
				["PartyBs in config", paint.bold(String(params.partyBs.length)), "config"],
			],
		),
	)

	console.log("")
	console.log(
		renderTable(
			["PartyB", "Address", "Core", "Bindable", "Metadata", "Symbol types", "Symbol IDs", "InstantLayer"],
			params.partyBs.map(partyB => [
				paint.bold(partyB.label),
				paint.cyan(partyB.address),
				formatBool(partyB.registerOnCore),
				partyB.setBindable ? formatBool(partyB.bindable) : paint.dim("(unchanged)"),
				formatBool(Boolean(partyB.metadata)),
				formatList(partyB.symbolTypes),
				formatList(partyB.symbolIds),
				formatBool(partyB.registerOnInstantLayer),
			]),
		),
	)
}

function printStateOverview(partyBs: PartyBPlan[], states: Map<string, CurrentState>) {
	section("Current On-chain State")
	console.log(
		renderTable(
			["PartyB", "Address", "isPartyB", "Bindable", "Metadata", "Symbol types", "InstantLayer", "Warnings"],
			partyBs.map(partyB => {
				const state = states.get(partyB.address)!
				const metadataMatch = partyB.metadata ? metadataEquals(state.metadata, partyB.metadata) : "unknown"
				const symbolTypes =
					partyB.symbolTypes.length === 0
						? paint.dim("(none)")
						: partyB.symbolTypes
								.map(symbolType => {
									const value = state.whitelistedSymbolTypes[symbolType.toString()]
									return `${symbolType}:${formatBool(value, { trueLabel: "yes", falseLabel: "no", falseIsBad: true })}`
								})
								.join(", ")
				return [
					paint.bold(partyB.label),
					paint.cyan(partyB.address),
					formatBool(state.isPartyB, { trueLabel: "yes", falseLabel: "no", falseIsBad: partyB.registerOnCore }),
					formatBool(state.isBindable, { trueLabel: "yes", falseLabel: "no", falseIsBad: partyB.setBindable && partyB.bindable }),
					partyB.metadata ? formatMatch(metadataMatch) : paint.dim("(not checked)"),
					symbolTypes,
					partyB.registerOnInstantLayer
						? formatBool(state.registeredOnInstantLayer, { trueLabel: "yes", falseLabel: "no", falseIsBad: true })
						: paint.dim("(not checked)"),
					state.errors.length > 0 ? paint.yellow(state.errors.join("; ")) : paint.green("none"),
				]
			}),
		),
	)

	const metadataRows = partyBs
		.map(partyB => {
			const state = states.get(partyB.address)!
			if (!state.metadata) return undefined
			return [
				paint.bold(partyB.label),
				paint.cyan(partyB.address),
				formatMetadataValue(state.metadata.name),
				formatMetadataValue(state.metadata.brandColor),
				formatMetadataValue(state.metadata.metadata),
			]
		})
		.filter((row): row is string[] => row !== undefined)
	if (metadataRows.length > 0) {
		console.log("")
		console.log(paint.bold("On-chain metadata"))
		console.log(renderTable(["PartyB", "Address", "On-chain name", "On-chain brand color", "On-chain metadata"], metadataRows))
	}
}

function printHumanReadableCalls(title: string, calls: PlannedCall[]) {
	section(title)
	if (calls.length === 0) {
		console.log(paint.green("No calls."))
		return
	}

	const hasSkipReason = calls.some(call => call.skipReason)
	console.log(
		renderTable(
			hasSkipReason ? ["#", "Action", "Target", "Method", "Skip"] : ["#", "Action", "Target", "Method"],
			calls.map((call, index) => {
				const row = [
					paint.bold(String(index + 1)),
					call.skipReason ? paint.dim(call.label) : paint.bold(call.label),
					`${call.toLabel} ${paint.dim(`(${call.to})`)}`,
					formatMethod(call),
				]
				if (hasSkipReason) row.push(call.skipReason ? paint.yellow(call.skipReason) : paint.green("included"))
				return row
			}),
		),
	)

	console.log("")
	console.log(paint.bold("Calldata"))
	for (const [index, call] of calls.entries()) {
		console.log(`${paint.bold(`${index + 1}.`)} ${paint.gray(call.safeTx.data)}`)
	}
}

function printSafeDecodedPreview(title: string, calls: PlannedCall[]) {
	section(title)
	console.log(
		renderTable(
			["#", "Action", "Target", "Decoded method", "Decoded inputs"],
			calls.map((call, index) => [
				paint.bold(String(index + 1)),
				paint.bold(call.label),
				`${call.toLabel} ${paint.dim(`(${call.to})`)}`,
				call.methodName,
				JSON.stringify(call.safeTx.contractInputsValues ?? {}, jsonReplacer),
			]),
		),
	)
}

function printSafeProposalOverview(params: {
	networkName: string
	chainId: bigint
	safeAddress: string
	safeInfo: SafeInfo
	safeDelegates: SafeDelegatesResult
	safeServiceUrl: string
	safeTxCreatorAddress: string
	safeSubmitterAddress: string
	safeSubmitterSource: string
	safeNonce: number
	safeTxHash: string
	proposalTx: SafeProposalTx
	calls: PlannedCall[]
}) {
	const owners = params.safeInfo.owners ?? []
	const delegates = params.safeDelegates.delegates
	const submitterIsOwner = owners.some(owner => owner.toLowerCase() === params.safeSubmitterAddress.toLowerCase())
	const submitterIsDelegate = delegates.some(delegate => delegate.toLowerCase() === params.safeSubmitterAddress.toLowerCase())
	const submitterCanSubmit = submitterIsOwner || submitterIsDelegate
	const eligibility = submitterCanSubmit
		? paint.green("yes")
		: params.safeDelegates.fetched
			? paint.red("no")
			: paint.yellow(`unknown (${params.safeDelegates.error ?? "delegate lookup failed"})`)
	const target =
		params.proposalTx.operation === 1
			? `Safe MultiSend ${paint.dim(`(${params.proposalTx.to})`)}`
			: `${params.calls[0]?.toLabel ?? "Target"} ${paint.dim(`(${params.proposalTx.to})`)}`
	const txShape =
		params.proposalTx.operation === 1
			? `single Safe tx wrapping ${params.calls.length} inner call(s)`
			: `single Safe tx calling ${params.calls[0]?.methodName ?? "target"}`

	section("Safe Proposal Overview")
	console.log(
		renderTable(
			["Field", "Value"],
			[
				["Network", `${paint.blue(params.networkName)} ${paint.dim(`(chainId ${params.chainId})`)}`],
				["Safe", paint.cyan(params.safeAddress)],
				["Safe version", params.safeInfo.version ? paint.cyan(params.safeInfo.version) : paint.yellow("unknown")],
				["Safe service", paint.cyan(params.safeServiceUrl)],
				["Nonce", paint.bold(String(params.safeNonce))],
				["Threshold", params.safeInfo.threshold === undefined ? paint.yellow("unknown") : paint.bold(String(params.safeInfo.threshold))],
				["Owners", owners.length > 0 ? paint.bold(String(owners.length)) : paint.yellow("unknown")],
				["Delegates", params.safeDelegates.fetched ? paint.bold(String(delegates.length)) : paint.yellow("lookup failed")],
				["Safe tx creator", paint.cyan(params.safeTxCreatorAddress)],
				["Safe proposer/sender", paint.cyan(params.safeSubmitterAddress)],
				["Proposer source", params.safeSubmitterSource],
				["Proposer is owner", formatBool(submitterIsOwner)],
				["Proposer is delegate", params.safeDelegates.fetched ? formatBool(submitterIsDelegate) : paint.yellow("unknown")],
				["Can submit proposal", eligibility],
				["Target", target],
				["Operation", params.proposalTx.operation === 1 ? paint.yellow(describeSafeOperation(1)) : paint.green(describeSafeOperation(0))],
				["Transaction shape", paint.bold(txShape)],
				[
					"MultiSend source",
					params.proposalTx.operation === 1 ? (params.proposalTx.multiSendAddressSource ?? paint.yellow("unknown")) : paint.dim("(not used)"),
				],
				["Safe tx hash", paint.cyan(params.safeTxHash)],
			],
		),
	)

	if (owners.length > 0) {
		console.log("")
		console.log(paint.bold("Safe owners"))
		console.log(
			renderTable(
				["#", "Owner", "Proposer"],
				owners.map((owner, index) => [
					paint.bold(String(index + 1)),
					paint.cyan(owner),
					owner.toLowerCase() === params.safeSubmitterAddress.toLowerCase() ? paint.green("yes") : paint.dim("no"),
				]),
			),
		)
	}

	if (delegates.length > 0) {
		console.log("")
		console.log(paint.bold("Safe delegates"))
		console.log(
			renderTable(
				["#", "Delegate", "Proposer"],
				delegates.map((delegate, index) => [
					paint.bold(String(index + 1)),
					paint.cyan(delegate),
					delegate.toLowerCase() === params.safeSubmitterAddress.toLowerCase() ? paint.green("yes") : paint.dim("no"),
				]),
			),
		)
	}
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

function normalizeSafeVersion(version: string | undefined): string | undefined {
	return version?.match(/^\d+\.\d+\.\d+/)?.[0]
}

async function resolveSafeMultiSendAddress(params: {
	chainId: bigint
	safeAddress: string
	safeServiceUrl: string
	override?: SourceValue<string | undefined>
}): Promise<SourceValue<string | undefined>> {
	if (params.override?.value) {
		return {
			value: parseAddress(params.override.value, "safeMultiSendAddress"),
			source: params.override.source,
		}
	}

	const safeInfo = await getSafeInfo(params.safeAddress, params.safeServiceUrl)
	const safeVersion = normalizeSafeVersion(safeInfo.version)
	const query = new URLSearchParams({ contract: "MultiSend" })
	if (safeVersion) query.set("version", safeVersion)

	const deployments = await fetchJson<SafeDeployment[]>(`${params.safeServiceUrl}/about/deployments/?${query.toString()}`)
	const candidates = deployments.flatMap(deployment =>
		deployment.contracts
			.filter(contract => contract.contractName === "MultiSend" && ethers.isAddress(contract.address))
			.map(contract => ({
				address: ethers.getAddress(contract.address),
				version: deployment.version,
			})),
	)
	if (candidates.length === 0) {
		throw new Error(
			`Could not discover Safe MultiSend for chainId ${params.chainId}${safeVersion ? ` and Safe version ${safeVersion}` : ""}; set SAFE_MULTISEND_ADDRESS or partyBRegistration.safeMultiSendAddress`,
		)
	}

	const selected = candidates[0]
	const code = await ethers.provider.getCode(selected.address)
	if (code === "0x") {
		throw new Error(`Safe service returned MultiSend ${selected.address}, but no bytecode exists at that address on chainId ${params.chainId}`)
	}

	return {
		value: selected.address,
		source: `Safe service deployment ${selected.version}${safeInfo.version ? ` for Safe ${safeInfo.version}` : ""}`,
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

function buildSafeProposalTx(calls: PlannedCall[], safeMultiSend: SourceValue<string | undefined>): SafeProposalTx {
	if (calls.length === 1) {
		const tx = calls[0].safeTx
		return { to: tx.to, value: tx.value, data: tx.data, operation: 0 }
	}
	if (!safeMultiSend.value) {
		throw new Error("Safe MultiSend address is required to submit multiple calls as one Safe proposal")
	}

	const multiSendData = encodeMultiSendTransactions(calls.map(call => call.safeTx))
	return {
		to: safeMultiSend.value,
		value: "0",
		data: multiSendIface.encodeFunctionData("multiSend", [multiSendData]),
		operation: 1,
		multiSendData,
		multiSendAddressSource: safeMultiSend.source,
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

async function resolveSafeSubmitterAddress(params: {
	configuredAddress?: string
	configuredSource?: string
	submitSafeProposal: boolean
	safeSubmitterPrivateKey?: string
	safeSubmitterKeyName: string
}): Promise<SourceValue<string | undefined>> {
	if (params.configuredAddress) {
		const configured = parseAddress(params.configuredAddress, "safeSubmitterAddress")
		if (params.submitSafeProposal) {
			const signer = (await ethers.getSigners())[0]
			if (signer) {
				const signerAddress = ethers.getAddress(await signer.getAddress())
				const signerSource = `hardhat signer[0] (${params.safeSubmitterKeyName})`
				return {
					value: configured,
					source:
						signerAddress.toLowerCase() === configured.toLowerCase()
							? `${params.configuredSource ?? "config/env"}; matches ${signerSource}`
							: `${params.configuredSource ?? "config/env"}; ${signerSource} is ${signerAddress}`,
				}
			}
		}
		return {
			value: configured,
			source: params.configuredSource ?? "config/env",
		}
	}
	if (!params.submitSafeProposal) return { value: undefined, source: "not set" }

	const signers = await ethers.getSigners()
	const signer = signers[0]
	if (signer) {
		return {
			value: ethers.getAddress(await signer.getAddress()),
			source: `hardhat signer[0] (${params.safeSubmitterKeyName})`,
		}
	}

	const privateKey = params.safeSubmitterPrivateKey || (await resolveConfigVar(params.safeSubmitterKeyName))
	return {
		value: ethers.getAddress(new ethers.Wallet(privateKey).address),
		source: `config variable ${params.safeSubmitterKeyName}`,
	}
}

async function getSafeInfo(safeAddress: string, serviceUrl: string): Promise<SafeInfo> {
	const safe = new ethers.Contract(safeAddress, safeIface, ethers.provider)
	const [onChainNonce, onChainOwners, onChainThreshold, serviceInfo] = await Promise.all([
		safe.nonce().then((value: bigint) => Number(value)),
		safe.getOwners().then((owners: string[]) => owners.map(owner => ethers.getAddress(owner))),
		safe.getThreshold().then((value: bigint) => Number(value)),
		fetchJson<SafeInfo>(`${serviceUrl}/safes/${safeAddress}/`).catch(() => undefined),
	])
	return {
		nonce: serviceInfo?.nonce ?? onChainNonce,
		owners: (serviceInfo?.owners ?? onChainOwners).map((owner: string) => ethers.getAddress(owner)),
		threshold: serviceInfo?.threshold ?? onChainThreshold,
		version: serviceInfo?.version,
	}
}

async function getSafeDelegates(safeAddress: string, serviceUrl: string): Promise<SafeDelegatesResult> {
	try {
		const response = await fetchJson<{ results?: DelegateInfo[] }>(`${serviceUrl}/delegates/?safe=${safeAddress}&limit=100`)
		const delegates = (response.results ?? [])
			.map(delegate => delegate.delegate)
			.filter((delegate): delegate is string => Boolean(delegate))
			.map(delegate => ethers.getAddress(delegate))
		return { delegates, fetched: true }
	} catch (err) {
		return { delegates: [], fetched: false, error: getErrorMessage(err) }
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
	safeSubmitterSource: string
	safeSubmitterPrivateKey?: string
	safeSubmitterKeyName: string
	safeServiceUrl: string
	safeNonceOverride?: number
	calls: PlannedCall[]
	proposalTx: SafeProposalTx
	submitSafeProposal: boolean
	proposalFile: string
	safeBatchFile?: string
}) {
	const safe = new ethers.Contract(params.safeAddress, safeIface, ethers.provider)
	const [safeInfo, safeDelegates] = await Promise.all([
		getSafeInfo(params.safeAddress, params.safeServiceUrl),
		getSafeDelegates(params.safeAddress, params.safeServiceUrl),
	])
	const safeNonce = params.safeNonceOverride ?? safeInfo.nonce ?? Number(await safe.nonce())
	const submitterIsOwner = Boolean(safeInfo.owners?.some(owner => owner.toLowerCase() === params.safeSubmitterAddress.toLowerCase()))
	const submitterIsDelegate = safeDelegates.delegates.some(delegate => delegate.toLowerCase() === params.safeSubmitterAddress.toLowerCase())
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
	const humanReadableCalls = params.calls.map(describePlannedCall)
	const decodedCalls = humanReadableCalls.map(stripRawCalldata)
	const dataDecoded = buildProposalDataDecoded(params.proposalTx, humanReadableCalls)

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
		submitterSource: params.safeSubmitterSource,
		submitterKeyName: params.safeSubmitterKeyName,
		submitSafeProposal: params.submitSafeProposal,
		submitted: false,
		proposal,
		safePreview: {
			to: proposal.to,
			value: proposal.value,
			operation: {
				value: proposal.operation,
				label: describeSafeOperation(proposal.operation),
			},
			nonce: safeNonce,
			safeTxHash,
			data: dataDecoded,
			calls: decodedCalls,
		},
		safeTx: {
			...proposal,
			gasToken: ethers.ZeroAddress,
			refundReceiver: ethers.ZeroAddress,
			dataDecoded,
		},
		dataDecoded,
		multiSend:
			params.proposalTx.operation === 1
				? {
						to: params.proposalTx.to,
						addressSource: params.proposalTx.multiSendAddressSource,
						transactionsData: params.proposalTx.multiSendData,
						decodedCalls,
					}
				: undefined,
		owners: safeInfo.owners,
		threshold: safeInfo.threshold,
		delegates: safeDelegates.delegates,
		delegatesFetched: safeDelegates.fetched,
		delegateFetchError: safeDelegates.error,
		submitterIsOwner,
		submitterIsDelegate,
		submitterCanSubmit: submitterIsOwner || submitterIsDelegate,
		humanReadableCalls,
	}
	const shouldCheckSafeFrontDecode = boolEnv("CHECK_SAFE_FRONT_DECODE", params.submitSafeProposal)
	if (shouldCheckSafeFrontDecode) {
		report.safeFrontDecodeCheck = await checkSafeFrontDecode({
			safeServiceUrl: params.safeServiceUrl,
			proposalTx: params.proposalTx,
			calls: params.calls,
			safeBatchFile: params.safeBatchFile,
		})
		printSafeFrontDecodeCheck(report.safeFrontDecodeCheck)
	}
	writeJson(params.proposalFile, report)

	if (!params.submitSafeProposal) {
		report.submissionSkippedReason = "SUBMIT_SAFE_PROPOSAL is not true"
		writeJson(params.proposalFile, report)
		return report
	}
	if (report.safeFrontDecodeCheck && !report.safeFrontDecodeCheck.ok) {
		report.safeFrontDecodeWarning =
			"Safe Front decoder did not decode every inner call. Review the Transaction Builder import batch and local decoded preview before confirming."
		console.log(paint.yellow(report.safeFrontDecodeWarning))
		writeJson(params.proposalFile, report)
	}
	if (
		report.safeFrontDecodeCheck &&
		!report.safeFrontDecodeCheck.ok &&
		boolEnv("REQUIRE_SAFE_FRONT_DECODE") &&
		!boolEnv("ALLOW_UNDECODED_SAFE_FRONT")
	) {
		report.submissionSkippedReason =
			"Safe Front decode check failed and REQUIRE_SAFE_FRONT_DECODE=true; set ALLOW_UNDECODED_SAFE_FRONT=true only after reviewing the Transaction Builder import batch."
		writeJson(params.proposalFile, report)
		throw new Error(
			"Safe Front cannot decode every call in this proposal. Review/import the Safe Transaction Builder batch or set ALLOW_UNDECODED_SAFE_FRONT=true after manual review.",
		)
	}

	printSafeProposalOverview({
		networkName: params.networkName,
		chainId: params.chainId,
		safeAddress: params.safeAddress,
		safeInfo,
		safeDelegates,
		safeServiceUrl: params.safeServiceUrl,
		safeTxCreatorAddress: params.safeTxCreatorAddress,
		safeSubmitterAddress: params.safeSubmitterAddress,
		safeSubmitterSource: params.safeSubmitterSource,
		safeNonce,
		safeTxHash,
		proposalTx: params.proposalTx,
		calls: params.calls,
	})
	printSafeDecodedPreview("Safe decoded call preview", params.calls)

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
	const safeSubmitterPrivateKey = firstString(
		process.env.SAFE_SUBMITTER_PRIVATE_KEY,
		process.env.SAFE_SIGNER_PRIVATE_KEY,
		process.env.SAFE_PROPOSER_PRIVATE_KEY,
	)
	const safeSubmitterKeyName =
		process.env.SAFE_SUBMITTER_KEY_NAME || process.env.SAFE_SIGNER_KEY_NAME || process.env.SAFE_PROPOSER_KEY_NAME || "TEAM_PROPOSER"
	const safeTxCreatorRaw = firstStringWithSource(
		[process.env.SAFE_TX_CREATOR_ADDRESS, "env:SAFE_TX_CREATOR_ADDRESS"],
		[process.env.SAFE_PROPOSER_ADDRESS, "env:SAFE_PROPOSER_ADDRESS"],
		[config.safeTxCreatorAddress, "partyBRegistration.safeTxCreatorAddress"],
	)
	const safeTxCreator: SourceValue<string | undefined> = {
		value: parseOptionalAddress(safeTxCreatorRaw.value, "safeTxCreatorAddress"),
		source: safeTxCreatorRaw.source,
	}
	const safeSubmitterRaw = firstStringWithSource(
		[process.env.SAFE_SUBMITTER_ADDRESS, "env:SAFE_SUBMITTER_ADDRESS"],
		[process.env.SAFE_SIGNER_ADDRESS, "env:SAFE_SIGNER_ADDRESS"],
		[config.safeSubmitterAddress, "partyBRegistration.safeSubmitterAddress"],
	)
	const safeSubmitter = await resolveSafeSubmitterAddress({
		configuredAddress: safeSubmitterRaw.value,
		configuredSource: safeSubmitterRaw.source,
		submitSafeProposal,
		safeSubmitterPrivateKey,
		safeSubmitterKeyName,
	})
	const safeServiceUrlOverride = firstString(process.env.SAFE_SERVICE_URL, config.safeServiceUrl)
	const safeServiceUrl = submitSafeProposal ? getSafeServiceUrl(chainId, safeServiceUrlOverride) : safeServiceUrlOverride
	const safeMultiSendOverride = resolveString(
		process.env.SAFE_MULTISEND_ADDRESS,
		config.safeMultiSendAddress,
		undefined,
		"SAFE_MULTISEND_ADDRESS",
		"safeMultiSendAddress",
		"safeMultiSendAddress",
	)
	let safeMultiSend = {
		value: parseOptionalAddress(safeMultiSendOverride.value, "safeMultiSendAddress"),
		source: safeMultiSendOverride.source,
	}
	if (submitSafeProposal) {
		if (!safeAddress) throw new Error("SAFE_ADDRESS or safeAddress is required for SUBMIT_SAFE_PROPOSAL=true")
		safeMultiSend = await resolveSafeMultiSendAddress({
			chainId,
			safeAddress,
			safeServiceUrl: safeServiceUrl!,
			override: safeMultiSend,
		})
	}

	printConfigOverview({
		networkName,
		chainId,
		upgradeConfigFile,
		partyBConfigFile: configFile,
		diamond: { ...diamond, value: diamondAddress },
		safe: { ...safe, value: safeAddress },
		safeTxCreator,
		safeSubmitter,
		instantLayer: { ...instantLayer, value: instantLayerAddress },
		safeServiceUrl,
		safeMultiSend,
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
		const safeBatch = buildSafeBatch(chainId, safeAddress, safeTxCreator.value ?? safeSubmitter.value ?? "", included, networkName)
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
		safeTxCreatorAddress: safeTxCreator.value,
		safeTxCreatorSource: safeTxCreator.source,
		safeSubmitterAddress: safeSubmitter.value,
		safeSubmitterSource: safeSubmitter.source,
		safeSubmitterKeyName,
		instantLayerAddress,
		safeMultiSendAddress: safeMultiSend.value,
		safeMultiSendSource: safeMultiSend.source,
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
		if (!safeSubmitter.value) throw new Error("Could not resolve Safe proposer/sender address from config/env or Hardhat signer[0]")
		const proposalTx = buildSafeProposalTx(included, safeMultiSend)
		report.safeProposal = await buildAndMaybeSubmitSafeProposal({
			chainId,
			networkName,
			safeAddress,
			safeTxCreatorAddress: safeTxCreator.value ?? safeSubmitter.value,
			safeSubmitterAddress: safeSubmitter.value,
			safeSubmitterSource: safeSubmitter.source,
			safeSubmitterPrivateKey,
			safeSubmitterKeyName,
			safeServiceUrl: safeServiceUrl!,
			safeNonceOverride: parseSafeNonceOverride(firstString(process.env.SAFE_NONCE, process.env.SAFE_TX_NONCE)),
			calls: included,
			proposalTx,
			submitSafeProposal,
			proposalFile,
			safeBatchFile: safeAddress ? safeBatchFile : undefined,
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
