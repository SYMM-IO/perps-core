import {
	AbstractSigner,
	Interface,
	Signature,
	Transaction,
	copyRequest,
	getBytes,
	hexlify,
	resolveAddress,
	resolveProperties,
	type Provider,
	type Signer,
	type TransactionLike,
	type TransactionRequest,
	type TransactionResponse,
	type TypedDataDomain,
	type TypedDataField,
} from "ethers"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { stdin as input, stdout as output } from "node:process"
import { createInterface } from "node:readline/promises"

import connection, { ethers } from "../../../test/helpers/hardhat-connection.js"
import { log } from "./log.js"
import { baseNetworkName, resolveConfigFile } from "./sharedConfig.js"

type LedgerModules = {
	transport: any
	eth: any
}

type ResolveSignerOptions = {
	role: string
	expectedAddress?: string
	envPrefix?: string
	allowDefault?: boolean
}

type HardwareDiscoveryOptions = {
	expectedAddress?: string
	role?: string
	envPrefix?: string
}

type LedgerConfigEntry = {
	address?: string
	path: string
	role?: string
	roles?: string[]
	envPrefix?: string
	envPrefixes?: string[]
	label?: string
}

type LedgerConfigValue =
	| string
	| {
			address?: string
			path: string
	  }

type LedgerConfig = {
	accounts?: LedgerConfigEntry[]
	pathsByAddress?: Record<string, string>
	roles?: Record<string, LedgerConfigValue>
	envPrefixes?: Record<string, LedgerConfigValue>
	defaultPath?: string
	paths?: string[]
}

type LedgerPathMatch = {
	path: string
	source: string
}

const EXTERNAL_RPC_ENV_NAMES = ["HARDWARE_WALLET_RPC_URL", "HW_WALLET_RPC_URL", "EXTERNAL_WALLET_RPC_URL"]
const requireFromProject = createRequire(`${process.cwd()}/package.json`)
const EXPLORER_TX_URL_BY_CHAIN_ID: Record<string, string> = {
	"56": "https://bscscan.com/tx/",
	"137": "https://polygonscan.com/tx/",
	"999": "https://hyperevmscan.io/tx/",
	"1101": "https://zkevm.polygonscan.com/tx/",
	"5000": "https://mantlescan.xyz/tx/",
	"8453": "https://basescan.org/tx/",
	"8822": "https://explorer.evm.iota.org/tx/",
	"34443": "https://modescan.io/tx/",
	"42161": "https://arbiscan.io/tx/",
	"81457": "https://blastscan.io/tx/",
	"146": "https://sonicscan.org/tx/",
	"9745": "https://plasmascan.to/tx/",
	"80094": "https://berascan.com/tx/",
	"2632500": "https://mainnet.cotiscan.io/tx/",
}
const KNOWN_ROLE_NAMES = [
	"DEFAULT_ADMIN_ROLE",
	"PAUSER_ROLE",
	"UNPAUSER_ROLE",
	"PROTOCOL_CONFIG_ROLE",
	"COOLDOWN_ADMIN_ROLE",
	"FEE_ADMIN_ROLE",
	"INTEGRATION_ADMIN_ROLE",
	"PARTY_B_MANAGER_ROLE",
	"MIGRATION_ROLE",
	"SYMBOL_MANAGER_ROLE",
	"FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE",
	"SETTER_ROLE",
	"OPERATOR_ROLE",
	"REVOKER_ROLE",
	"TRUSTED_ROLE",
	"MANAGER_ROLE",
	"SIGNER_ADMIN_ROLE",
	"AFFILIATE_MANAGER_ROLE",
	"BALANCE_SETTLER_ROLE",
	"INSTANT_LAYER_ROLE",
	"SIGNER_SETTER_ROLE",
]
const ROLE_NAME_BY_HASH = new Map<string, string>([
	[ethers.ZeroHash.toLowerCase(), "DEFAULT_ADMIN_ROLE (0x00)"],
	...KNOWN_ROLE_NAMES.map(name => [ethers.id(name).toLowerCase(), name] as const),
])

type CalldataDecoder = {
	iface: Interface
	source: string
}

type DecodedArgument = {
	index: number
	name: string
	type: string
	value: unknown
	decoded?: string
}

type DecodedCalldata = {
	function: string
	name: string
	selector: string
	abiSource: string
	arguments: DecodedArgument[]
}

let calldataDecoders: CalldataDecoder[] | undefined
let ledgerConfigCache: { file: string; config: LedgerConfig } | undefined | null

function optionalEnvNames(envPrefix: string | undefined, suffix: string): string[] {
	return envPrefix ? [`${envPrefix}_${suffix}`] : []
}

function firstEnv(names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name]
		if (value && value.trim()) return value.trim()
	}
	return undefined
}

function normalizeAddress(address: string | undefined): string | undefined {
	if (!address) return undefined
	if (!ethers.isAddress(address)) throw new Error(`Invalid expected signer address: ${address}`)
	return ethers.getAddress(address)
}

function matchesAddress(actual: string, expected: string): boolean {
	return actual.toLowerCase() === expected.toLowerCase()
}

function normalizeOptionalConfigAddress(address: string | undefined): string | undefined {
	if (!address) return undefined
	if (!ethers.isAddress(address)) throw new Error(`Invalid Ledger config address: ${address}`)
	return ethers.getAddress(address)
}

function normalizeRoleName(role: string | undefined): string | undefined {
	return role?.trim().toLowerCase()
}

function normalizeEnvPrefix(envPrefix: string | undefined): string | undefined {
	return envPrefix?.trim().toUpperCase()
}

function loadLedgerConfig(): { file: string; config: LedgerConfig } | undefined {
	if (ledgerConfigCache !== undefined) return ledgerConfigCache ?? undefined

	const networkSuffix = baseNetworkName(connection.networkName)
	const file = resolveConfigFile("ledger", networkSuffix, process.env.LEDGER_CONFIG_FILE)
	if (!fs.existsSync(file)) {
		ledgerConfigCache = null
		return undefined
	}

	ledgerConfigCache = {
		file,
		config: JSON.parse(fs.readFileSync(file, "utf-8")) as LedgerConfig,
	}
	return ledgerConfigCache
}

function ledgerConfigValuePath(
	value: LedgerConfigValue | undefined,
	expectedAddress: string | undefined,
	source: string,
): LedgerPathMatch | undefined {
	if (!value) return undefined
	if (typeof value === "string") return { path: value, source }
	const configuredAddress = normalizeOptionalConfigAddress(value.address)
	if (configuredAddress && expectedAddress && !matchesAddress(configuredAddress, expectedAddress)) return undefined
	return { path: value.path, source }
}

function configuredLedgerPathFromConfig(expectedAddress?: string, envPrefix?: string, role?: string): LedgerPathMatch | undefined {
	const loaded = loadLedgerConfig()
	if (!loaded) return undefined

	const expected = expectedAddress ? ethers.getAddress(expectedAddress) : undefined
	const roleKey = normalizeRoleName(role)
	const envKey = normalizeEnvPrefix(envPrefix)
	const { config, file } = loaded

	if (expected && config.pathsByAddress) {
		for (const [address, ledgerPath] of Object.entries(config.pathsByAddress)) {
			if (matchesAddress(ethers.getAddress(address), expected)) {
				return { path: ledgerPath, source: `${file}:pathsByAddress.${ethers.getAddress(address)}` }
			}
		}
	}

	if (roleKey && config.roles) {
		for (const [configuredRole, value] of Object.entries(config.roles)) {
			if (normalizeRoleName(configuredRole) === roleKey) {
				const match = ledgerConfigValuePath(value, expected, `${file}:roles.${configuredRole}`)
				if (match) return match
			}
		}
	}

	if (envKey && config.envPrefixes) {
		for (const [configuredPrefix, value] of Object.entries(config.envPrefixes)) {
			if (normalizeEnvPrefix(configuredPrefix) === envKey) {
				const match = ledgerConfigValuePath(value, expected, `${file}:envPrefixes.${configuredPrefix}`)
				if (match) return match
			}
		}
	}

	for (const [index, account] of (config.accounts ?? []).entries()) {
		const configuredAddress = normalizeOptionalConfigAddress(account.address)
		const addressMatches = !configuredAddress || !expected || matchesAddress(configuredAddress, expected)
		if (!addressMatches) continue

		const roles = [account.role, ...(account.roles ?? [])].map(normalizeRoleName).filter(Boolean)
		const envPrefixes = [account.envPrefix, ...(account.envPrefixes ?? [])].map(normalizeEnvPrefix).filter(Boolean)
		if (!configuredAddress && roles.length === 0 && envPrefixes.length === 0) continue

		const roleMatches = !roleKey || roles.length === 0 || roles.includes(roleKey)
		const envMatches = !envKey || envPrefixes.length === 0 || envPrefixes.includes(envKey)
		const addressSpecific = configuredAddress && expected && matchesAddress(configuredAddress, expected)

		if (addressSpecific || (roleMatches && envMatches)) {
			return { path: account.path, source: `${file}:accounts[${index}]${account.label ? ` (${account.label})` : ""}` }
		}
	}

	if (config.defaultPath) return { path: config.defaultPath, source: `${file}:defaultPath` }

	return undefined
}

async function findHardhatSigner(expectedAddress: string): Promise<Signer | undefined> {
	const signers = await ethers.getSigners()
	for (const signer of signers) {
		const address = ethers.getAddress(await signer.getAddress())
		if (matchesAddress(address, expectedAddress)) return signer
	}
	return undefined
}

async function resolveExternalRpcSigner(expectedAddress: string, envPrefix?: string): Promise<Signer | undefined> {
	const rpcUrl = firstEnv([...optionalEnvNames(envPrefix, "RPC_URL"), ...EXTERNAL_RPC_ENV_NAMES])
	if (!rpcUrl) return undefined

	const walletProvider = new ethers.JsonRpcProvider(rpcUrl)
	const [scriptNetwork, walletNetwork] = await Promise.all([ethers.provider.getNetwork(), walletProvider.getNetwork()])
	if (scriptNetwork.chainId !== walletNetwork.chainId) {
		throw new Error(
			`External wallet RPC chain mismatch: script is on chain ${scriptNetwork.chainId}, wallet RPC is on chain ${walletNetwork.chainId}. ` +
				`Switch the wallet RPC to the target chain or use a matching RPC URL.`,
		)
	}

	const accounts = ((await walletProvider.send("eth_accounts", [])) as string[]).map(a => ethers.getAddress(a))
	for (const account of accounts) {
		if (matchesAddress(account, expectedAddress)) {
			log.ok(`Resolved ${log.addr(expectedAddress)} from external wallet RPC`)
			return await walletProvider.getSigner(account)
		}
	}

	log.warn(
		`External wallet RPC is configured but did not expose ${expectedAddress}. ` +
			`Available accounts: ${accounts.length > 0 ? accounts.map(log.addr).join(", ") : "(none)"}`,
	)
	return undefined
}

function wantsLedger(envPrefix?: string, expectedAddress?: string, role?: string): boolean {
	const mode = firstEnv([...optionalEnvNames(envPrefix, "WALLET"), "HARDWARE_WALLET", "HW_WALLET"])
	if (mode && mode.toLowerCase() === "ledger") return true
	if (process.env.LEDGER === "true" || process.env.HW_LEDGER === "true") return true
	if (firstEnv([...optionalEnvNames(envPrefix, "LEDGER_PATH"), "LEDGER_PATH", "HW_LEDGER_PATH"])) return true
	if (process.env.LEDGER_SCAN === "true" || process.env.HW_LEDGER_SCAN === "true") return true
	if (configuredLedgerPathFromConfig(expectedAddress, envPrefix, role)) return true
	return false
}

async function loadLedgerModules(): Promise<LedgerModules> {
	try {
		// Avoid the USB event binding from the main transport; plain HID is enough for scripted signing.
		let transportModule
		try {
			transportModule = requireFromProject("@ledgerhq/hw-transport-node-hid-noevents")
		} catch {
			transportModule = requireFromProject("@ledgerhq/hw-transport-node-hid")
		}
		const ethModule = requireFromProject("@ledgerhq/hw-app-eth")
		return {
			transport: transportModule.default ?? transportModule,
			eth: ethModule.default ?? ethModule,
		}
	} catch (error) {
		throw new Error(
			`Ledger support requires @ledgerhq/hw-transport-node-hid and @ledgerhq/hw-app-eth. ` +
				`Install them or use an external wallet RPC. Original error: ${(error as Error).message}`,
		)
	}
}

function configuredLedgerPath(envPrefix?: string, expectedAddress?: string, role?: string): LedgerPathMatch | undefined {
	const envPath = firstEnv([...optionalEnvNames(envPrefix, "LEDGER_PATH"), "LEDGER_PATH", "HW_LEDGER_PATH"])
	if (envPath) return { path: envPath, source: envPrefix ? `${envPrefix}_LEDGER_PATH/env` : "LEDGER_PATH/env" }
	return configuredLedgerPathFromConfig(expectedAddress, envPrefix, role)
}

function configuredLedgerPathList(envPrefix?: string): LedgerPathMatch[] {
	const raw = firstEnv([...optionalEnvNames(envPrefix, "LEDGER_PATHS"), "LEDGER_PATHS", "HW_LEDGER_PATHS"])
	const paths = raw
		? raw
				.split(",")
				.map(p => p.trim())
				.filter(Boolean)
				.map(path => ({ path, source: envPrefix ? `${envPrefix}_LEDGER_PATHS/env` : "LEDGER_PATHS/env" }))
		: []
	const loaded = loadLedgerConfig()
	if (loaded) {
		for (const path of loaded.config.paths ?? []) {
			paths.push({ path, source: `${loaded.file}:paths` })
		}
	}
	return paths
}

function ledgerScanRange(envPrefix: string | undefined, key: string, fallback: number): number {
	const value = firstEnv([...optionalEnvNames(envPrefix, key), `HW_LEDGER_${key}`, `LEDGER_${key}`])
	if (!value) return fallback
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid ${key}: ${value}`)
	return parsed
}

export function buildLedgerCandidatePaths(envPrefix?: string, expectedAddress?: string, role?: string): string[] {
	const paths: string[] = []
	const add = (path: string) => {
		if (!paths.includes(path)) paths.push(path)
	}

	for (const match of configuredLedgerPathList(envPrefix)) add(match.path)
	const explicitPath = configuredLedgerPath(envPrefix, expectedAddress, role)
	if (explicitPath) add(explicitPath.path)

	const accountCount = ledgerScanRange(envPrefix, "ACCOUNT_COUNT", 10)
	const addressCount = ledgerScanRange(envPrefix, "ADDRESS_COUNT", 20)

	for (let account = 0; account < accountCount; account++) {
		add(`m/44'/60'/${account}'/0/0`)
	}
	for (let index = 0; index < addressCount; index++) {
		add(`m/44'/60'/0'/0/${index}`)
	}
	for (let index = 0; index < addressCount; index++) {
		add(`m/44'/60'/0'/${index}`)
	}

	return paths
}

function ensureHex(value: string): string {
	return value.startsWith("0x") ? value : `0x${value}`
}

function ledgerV(value: string | number): bigint | number {
	if (typeof value === "number") return value
	const hex = ensureHex(value)
	const parsed = BigInt(hex)
	return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : parsed
}

function isLockedDeviceError(error: unknown): boolean {
	const err = error as { statusText?: string; id?: string; statusCode?: number; message?: string }
	return err.statusText === "LOCKED_DEVICE" || err.id === "LockedDevice" || err.statusCode === 0x5515 || /locked device/i.test(err.message ?? "")
}

function formatOptionalBigInt(value: bigint | null): string {
	return value == null ? "(none)" : value.toString()
}

function formatTxData(data: string): string {
	if (!data || data === "0x") return "0x"
	return data
}

function artifactFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return []
	const files: string[] = []
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name)
		if (entry.isDirectory()) files.push(...artifactFiles(fullPath))
		else if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".dbg.json")) files.push(fullPath)
	}
	return files
}

function loadCalldataDecoders(): CalldataDecoder[] {
	if (calldataDecoders) return calldataDecoders

	const root = path.resolve(process.cwd(), "artifacts/contracts")
	calldataDecoders = []
	for (const file of artifactFiles(root)) {
		try {
			const artifact = JSON.parse(fs.readFileSync(file, "utf-8")) as { abi?: unknown[] }
			if (!Array.isArray(artifact.abi) || !artifact.abi.some(item => (item as { type?: string }).type === "function")) continue
			calldataDecoders.push({
				iface: new ethers.Interface(artifact.abi),
				source: path.relative(process.cwd(), file),
			})
		} catch {
			// Ignore malformed or non-standard artifact files; this is best-effort review output.
		}
	}
	return calldataDecoders
}

function formatDecodedValue(value: unknown): unknown {
	if (typeof value === "bigint") return value.toString()
	if (typeof value === "string") return ethers.isAddress(value) ? ethers.getAddress(value) : value
	if (Array.isArray(value)) return value.map(formatDecodedValue)
	if (value && typeof value === "object") {
		const entries = Object.entries(value).filter(([key]) => Number.isNaN(Number(key)))
		if (entries.length === 0) return String(value)
		return Object.fromEntries(entries.map(([key, item]) => [key, formatDecodedValue(item)]))
	}
	return value
}

function roleNameFor(inputName: string, inputType: string, value: unknown): string | undefined {
	if (inputType !== "bytes32" || typeof value !== "string") return undefined
	if (inputName.toLowerCase() !== "role" && !inputName.toLowerCase().endsWith("role")) return undefined
	return ROLE_NAME_BY_HASH.get(value.toLowerCase())
}

function decodeCalldata(data: string): DecodedCalldata | undefined {
	if (!data || data === "0x" || data.length < 10) return undefined
	const selector = data.slice(0, 10)
	for (const decoder of loadCalldataDecoders()) {
		try {
			const parsed = decoder.iface.parseTransaction({ data, value: 0 })
			if (!parsed) continue
			return {
				function: parsed.signature,
				name: parsed.name,
				selector,
				abiSource: decoder.source,
				arguments: parsed.fragment.inputs.map((input, index) => {
					const value = formatDecodedValue(parsed.args[index])
					const arg: DecodedArgument = {
						index,
						name: input.name || `arg${index}`,
						type: input.type,
						value,
					}
					const roleName = roleNameFor(arg.name, input.type, value)
					if (roleName) arg.decoded = roleName
					return arg
				}),
			}
		} catch {
			// Try the next artifact; selectors are matched by Interface.parseTransaction.
		}
	}
	return undefined
}

async function promptLedger(action: string): Promise<void> {
	log.warn(`Unlock Ledger and open the Ethereum app, then review and approve ${action} on the device.`)
	if (!input.isTTY || process.env.LEDGER_CONFIRM_PROMPT === "false") return

	const rl = createInterface({ input, output })
	try {
		await rl.question("Press Enter when the Ledger is unlocked and ready...")
	} finally {
		rl.close()
	}
}

async function withLedgerPrompt<T>(action: string, run: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		await promptLedger(action)
		try {
			return await run()
		} catch (error) {
			if (!isLockedDeviceError(error) || attempt >= 3) throw error
			log.warn("Ledger is still locked. Unlock it and try again.")
		}
	}
}

function logLedgerTransactionReview(path: string, signerAddress: string | undefined, tx: Transaction): void {
	const data = formatTxData(tx.data)
	const decoded = decodeCalldata(data)
	log.header("Ledger Transaction Review")
	log.kv("Ledger path", path)
	if (signerAddress) log.kv("Expected signer", log.addr(signerAddress))
	log.kv("Chain ID", tx.chainId.toString())
	log.kv("Nonce", tx.nonce.toString())
	log.kv("To", tx.to ?? "(contract creation)")
	log.kv("Value", tx.value.toString())
	log.kv("Type", tx.type === null ? "(legacy/default)" : tx.type.toString())
	log.kv("Gas limit", tx.gasLimit.toString())
	log.kv("Gas price", formatOptionalBigInt(tx.gasPrice))
	log.kv("Max fee per gas", formatOptionalBigInt(tx.maxFeePerGas))
	log.kv("Max priority fee", formatOptionalBigInt(tx.maxPriorityFeePerGas))
	log.kv("Data bytes", String(data === "0x" ? 0 : (data.length - 2) / 2))
	log.kv("Selector", data.length >= 10 ? data.slice(0, 10) : "(none)")
	log.kv("Unsigned hash", tx.unsignedHash)
	log.info("Decoded calldata:")
	if (decoded) log.info(JSON.stringify(decoded, null, 2))
	else log.info(data === "0x" ? "(empty calldata)" : "(no local ABI match found)")
	log.info("Calldata:")
	log.info(data)
}

function logLedgerMessageReview(path: string, signerAddress: string | undefined, message: string | Uint8Array): void {
	const bytes = typeof message === "string" ? getBytes(ethers.toUtf8Bytes(message)) : getBytes(message)
	log.header("Ledger Message Review")
	log.kv("Ledger path", path)
	if (signerAddress) log.kv("Expected signer", log.addr(signerAddress))
	log.kv("Bytes", String(bytes.length))
	log.kv("Message hex", hexlify(bytes))
	if (typeof message === "string") {
		log.info("Message text:")
		log.info(message)
	}
}

function explorerTxUrl(chainId: bigint, hash: string): string | undefined {
	const prefix = EXPLORER_TX_URL_BY_CHAIN_ID[chainId.toString()]
	return prefix ? `${prefix}${hash}` : undefined
}

async function logSubmittedTransaction(provider: Provider, response: TransactionResponse): Promise<void> {
	const network = await provider.getNetwork()
	const url = explorerTxUrl(network.chainId, response.hash)
	log.header("Transaction Submitted")
	log.kv("Hash", response.hash)
	if (url) log.kv("Explorer", url)
	else log.kv("Explorer", `(no explorer configured for chain ${network.chainId.toString()})`)
}

class LedgerSigner extends AbstractSigner<Provider> {
	private cachedAddress?: string

	constructor(
		private readonly path: string,
		provider: Provider,
		private readonly app: any,
		expectedAddress?: string,
	) {
		super(provider)
		this.cachedAddress = expectedAddress ? ethers.getAddress(expectedAddress) : undefined
	}

	connect(provider: null | Provider): Signer {
		if (!provider) throw new Error("LedgerSigner requires a provider")
		return new LedgerSigner(this.path, provider, this.app, this.cachedAddress)
	}

	async getAddress(): Promise<string> {
		if (this.cachedAddress) return this.cachedAddress
		const result = await this.app.getAddress(this.path, false)
		const address = ethers.getAddress(result.address)
		this.cachedAddress = address
		return address
	}

	private async verifyLedgerAddress(): Promise<string> {
		const result = await this.app.getAddress(this.path, false)
		const address = ethers.getAddress(result.address)
		if (this.cachedAddress && address.toLowerCase() !== this.cachedAddress.toLowerCase()) {
			throw new Error(`Ledger path ${this.path} returned ${address}, expected ${this.cachedAddress}`)
		}
		this.cachedAddress = address
		return address
	}

	async signTransaction(tx: TransactionRequest): Promise<string> {
		const request = copyRequest(tx)
		const { to, from } = await resolveProperties({
			to: request.to ? resolveAddress(request.to, this) : undefined,
			from: request.from ? resolveAddress(request.from, this) : undefined,
		})

		if (to != null) request.to = to
		if (from != null) request.from = from
		if (request.from != null) {
			const signerAddress = this.cachedAddress ?? (await this.getAddress())
			if (ethers.getAddress(String(request.from)) !== signerAddress) {
				throw new Error(`Transaction from address mismatch: ${request.from} is not ${signerAddress}`)
			}
			delete request.from
		}

		const txObj = Transaction.from(request as TransactionLike<string>)
		logLedgerTransactionReview(this.path, this.cachedAddress, txObj)
		const signature = await withLedgerPrompt("this transaction", async () => {
			await this.verifyLedgerAddress()
			return this.app.signTransaction(this.path, txObj.unsignedSerialized.slice(2), null)
		})
		txObj.signature = Signature.from({
			r: ensureHex(signature.r),
			s: ensureHex(signature.s),
			v: ledgerV(signature.v),
		})
		return txObj.serialized
	}

	async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
		const response = await super.sendTransaction(tx)
		await logSubmittedTransaction(this.provider, response)
		return response
	}

	async signMessage(message: string | Uint8Array): Promise<string> {
		const bytes = typeof message === "string" ? getBytes(ethers.toUtf8Bytes(message)) : getBytes(message)
		logLedgerMessageReview(this.path, this.cachedAddress, message)
		const signature = await withLedgerPrompt("this message", async () => {
			await this.verifyLedgerAddress()
			return this.app.signPersonalMessage(this.path, hexlify(bytes).slice(2))
		})
		return Signature.from({
			r: ensureHex(signature.r),
			s: ensureHex(signature.s),
			v: ledgerV(signature.v),
		}).serialized
	}

	async signTypedData(_domain: TypedDataDomain, _types: Record<string, Array<TypedDataField>>, _value: Record<string, any>): Promise<string> {
		throw new Error("Ledger typed-data signing is not implemented in this upgrade helper")
	}
}

async function openLedgerApp(): Promise<any> {
	const modules = await loadLedgerModules()
	const transport = typeof modules.transport.open === "function" ? await modules.transport.open(undefined) : await modules.transport.create()
	return new modules.eth(transport)
}

async function resolveLedgerSigner(expectedAddress: string, envPrefix?: string, role?: string): Promise<Signer | undefined> {
	if (!wantsLedger(envPrefix, expectedAddress, role)) return undefined

	const app = await openLedgerApp()
	const explicitPath = configuredLedgerPath(envPrefix, expectedAddress, role)
	if (explicitPath) {
		log.ok(`Resolved ${log.addr(expectedAddress)} from configured Ledger path ${explicitPath.path}`)
		log.info(`  source: ${explicitPath.source}`)
		return new LedgerSigner(explicitPath.path, ethers.provider, app, expectedAddress)
	}

	const paths = buildLedgerCandidatePaths(envPrefix, expectedAddress, role)
	log.info(`Scanning Ledger derivation paths (${paths.length}) for ${log.addr(expectedAddress)}...`)

	for (const path of paths) {
		const result = await app.getAddress(path, false)
		const address = ethers.getAddress(result.address)
		if (matchesAddress(address, expectedAddress)) {
			log.ok(`Resolved ${log.addr(expectedAddress)} from Ledger path ${path}`)
			return new LedgerSigner(path, ethers.provider, app, address)
		}
	}

	throw new Error(
		`Ledger is connected, but ${expectedAddress} was not found in scanned paths. ` +
			`Set LEDGER_PATH or scripts/upgrade/config/ledger-${baseNetworkName(connection.networkName) ?? connection.networkName}.json if you know it, ` +
			`or increase LEDGER_ACCOUNT_COUNT / LEDGER_ADDRESS_COUNT.`,
	)
}

export async function resolveConfiguredSigner(options: ResolveSignerOptions): Promise<Signer> {
	const expectedAddress = normalizeAddress(options.expectedAddress)
	if (!expectedAddress) {
		if (options.allowDefault) {
			log.warn(`${options.role}: no expected address configured; using default provider signer`)
			return await ethers.provider.getSigner()
		}
		throw new Error(`${options.role}: expected address is required to resolve a signer`)
	}

	const hardhatSigner = await findHardhatSigner(expectedAddress)
	if (hardhatSigner) {
		log.ok(`${options.role}: resolved ${log.addr(expectedAddress)} from Hardhat signers`)
		return hardhatSigner
	}

	const externalRpcSigner = await resolveExternalRpcSigner(expectedAddress, options.envPrefix)
	if (externalRpcSigner) return externalRpcSigner

	const ledgerSigner = await resolveLedgerSigner(expectedAddress, options.envPrefix, options.role)
	if (ledgerSigner) return ledgerSigner

	throw new Error(
		`${options.role}: no signer found for ${expectedAddress}.\n` +
			`Options:\n` +
			`  - Set TEAM_DEPLOYER / TEAM_UPGRADE_OPERATOR / TEAM_MIGRATOR or USE_KEYSTORE=true if this is a managed key.\n` +
			`  - Use an external wallet RPC that exposes the hardware account: HARDWARE_WALLET_RPC_URL=http://127.0.0.1:<port>.\n` +
			`  - Use direct Ledger scanning: HW_WALLET=ledger LEDGER_SCAN=true, or set LEDGER_PATH once known.`,
	)
}

export async function printHardwareWalletDiscovery(options: HardwareDiscoveryOptions = {}): Promise<void> {
	const expectedAddress = normalizeAddress(options.expectedAddress)
	const label = options.role ?? "hardware wallet"
	const rpcUrl = firstEnv([...optionalEnvNames(options.envPrefix, "RPC_URL"), ...EXTERNAL_RPC_ENV_NAMES])
	const ledgerConfig = loadLedgerConfig()
	const configuredPath = configuredLedgerPath(options.envPrefix, expectedAddress, options.role)

	log.header("Hardware Wallet Discovery")
	if (expectedAddress) log.kv("Expected", `${log.addr(expectedAddress)} (${label})`)
	if (ledgerConfig) log.kv("Ledger config", ledgerConfig.file)
	if (configuredPath) {
		log.kv("Configured Ledger path", configuredPath.path)
		log.kv("Ledger path source", configuredPath.source)
	}

	if (rpcUrl) {
		const provider = new ethers.JsonRpcProvider(rpcUrl)
		const accounts = ((await provider.send("eth_accounts", [])) as string[]).map(a => ethers.getAddress(a))
		log.info(`External wallet RPC: ${rpcUrl}`)
		if (accounts.length === 0) log.warn("  No accounts exposed by external wallet RPC")
		for (const account of accounts) {
			const mark = expectedAddress && matchesAddress(account, expectedAddress) ? "MATCH" : "account"
			log.info(`  ${mark.padEnd(7)} ${account}`)
		}
		log.blank()
	}

	if (wantsLedger(options.envPrefix, expectedAddress, options.role)) {
		const app = await openLedgerApp()
		const paths = configuredPath ? [configuredPath.path] : buildLedgerCandidatePaths(options.envPrefix, expectedAddress, options.role)
		log.info(`Ledger paths scanned: ${paths.length}`)
		for (const path of paths) {
			const result = await app.getAddress(path, false)
			const address = ethers.getAddress(result.address)
			const mark = expectedAddress && matchesAddress(address, expectedAddress) ? "MATCH" : "account"
			log.info(`  ${mark.padEnd(7)} ${address}  ${path}`)
			if (expectedAddress && matchesAddress(address, expectedAddress)) break
		}
		return
	}

	if (!rpcUrl) {
		log.info("No external wallet source configured.")
		log.info("Use HARDWARE_WALLET_RPC_URL for a wallet bridge, or HW_WALLET=ledger LEDGER_SCAN=true for direct Ledger scanning.")
	}
}
