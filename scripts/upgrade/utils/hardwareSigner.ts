import {
	AbstractSigner,
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

import { ethers } from "../../../test/helpers/hardhat-connection.js"
import { log } from "./log.js"

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

const EXTERNAL_RPC_ENV_NAMES = ["HARDWARE_WALLET_RPC_URL", "HW_WALLET_RPC_URL", "EXTERNAL_WALLET_RPC_URL"]

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

function wantsLedger(envPrefix?: string): boolean {
	const mode = firstEnv([...optionalEnvNames(envPrefix, "WALLET"), "HARDWARE_WALLET", "HW_WALLET"])
	if (mode && mode.toLowerCase() === "ledger") return true
	if (process.env.LEDGER === "true" || process.env.HW_LEDGER === "true") return true
	if (firstEnv([...optionalEnvNames(envPrefix, "LEDGER_PATH"), "LEDGER_PATH", "HW_LEDGER_PATH"])) return true
	if (process.env.LEDGER_SCAN === "true" || process.env.HW_LEDGER_SCAN === "true") return true
	return false
}

async function dynamicImport(moduleName: string): Promise<any> {
	const importer = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>
	return importer(moduleName)
}

async function loadLedgerModules(): Promise<LedgerModules> {
	try {
		const [transportModule, ethModule] = await Promise.all([dynamicImport("@ledgerhq/hw-transport-node-hid"), dynamicImport("@ledgerhq/hw-app-eth")])
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

function configuredLedgerPath(envPrefix?: string): string | undefined {
	return firstEnv([...optionalEnvNames(envPrefix, "LEDGER_PATH"), "LEDGER_PATH", "HW_LEDGER_PATH"])
}

function configuredLedgerPathList(envPrefix?: string): string[] {
	const raw = firstEnv([...optionalEnvNames(envPrefix, "LEDGER_PATHS"), "LEDGER_PATHS", "HW_LEDGER_PATHS"])
	return raw
		? raw
				.split(",")
				.map(p => p.trim())
				.filter(Boolean)
		: []
}

function ledgerScanRange(envPrefix: string | undefined, key: string, fallback: number): number {
	const value = firstEnv([...optionalEnvNames(envPrefix, key), `HW_LEDGER_${key}`, `LEDGER_${key}`])
	if (!value) return fallback
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid ${key}: ${value}`)
	return parsed
}

export function buildLedgerCandidatePaths(envPrefix?: string): string[] {
	const paths: string[] = []
	const add = (path: string) => {
		if (!paths.includes(path)) paths.push(path)
	}

	for (const path of configuredLedgerPathList(envPrefix)) add(path)
	const explicitPath = configuredLedgerPath(envPrefix)
	if (explicitPath) add(explicitPath)

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

class LedgerSigner extends AbstractSigner<Provider> {
	private cachedAddress?: string

	constructor(
		private readonly path: string,
		provider: Provider,
		private readonly app: any,
	) {
		super(provider)
	}

	connect(provider: null | Provider): Signer {
		if (!provider) throw new Error("LedgerSigner requires a provider")
		return new LedgerSigner(this.path, provider, this.app)
	}

	async getAddress(): Promise<string> {
		if (this.cachedAddress) return this.cachedAddress
		const result = await this.app.getAddress(this.path, false)
		const address = ethers.getAddress(result.address)
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
			const signerAddress = await this.getAddress()
			if (ethers.getAddress(String(request.from)) !== signerAddress) {
				throw new Error(`Transaction from address mismatch: ${request.from} is not ${signerAddress}`)
			}
			delete request.from
		}

		const txObj = Transaction.from(request as TransactionLike<string>)
		const signature = await this.app.signTransaction(this.path, txObj.unsignedSerialized.slice(2))
		txObj.signature = Signature.from({
			r: ensureHex(signature.r),
			s: ensureHex(signature.s),
			v: ledgerV(signature.v),
		})
		return txObj.serialized
	}

	async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
		log.warn("Waiting for Ledger confirmation. Review the transaction on the device.")
		return super.sendTransaction(tx)
	}

	async signMessage(message: string | Uint8Array): Promise<string> {
		const bytes = typeof message === "string" ? getBytes(ethers.toUtf8Bytes(message)) : getBytes(message)
		const signature = await this.app.signPersonalMessage(this.path, hexlify(bytes).slice(2))
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
	const transport = await modules.transport.create()
	return new modules.eth(transport)
}

async function resolveLedgerSigner(expectedAddress: string, envPrefix?: string): Promise<Signer | undefined> {
	if (!wantsLedger(envPrefix)) return undefined

	const app = await openLedgerApp()
	const paths = buildLedgerCandidatePaths(envPrefix)
	log.info(`Scanning Ledger derivation paths (${paths.length}) for ${log.addr(expectedAddress)}...`)

	for (const path of paths) {
		const result = await app.getAddress(path, false)
		const address = ethers.getAddress(result.address)
		if (matchesAddress(address, expectedAddress)) {
			log.ok(`Resolved ${log.addr(expectedAddress)} from Ledger path ${path}`)
			return new LedgerSigner(path, ethers.provider, app)
		}
	}

	throw new Error(
		`Ledger is connected, but ${expectedAddress} was not found in scanned paths. ` +
			`Set LEDGER_PATH if you know it, or increase LEDGER_ACCOUNT_COUNT / LEDGER_ADDRESS_COUNT.`,
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

	const ledgerSigner = await resolveLedgerSigner(expectedAddress, options.envPrefix)
	if (ledgerSigner) return ledgerSigner

	throw new Error(
		`${options.role}: no signer found for ${expectedAddress}.\n` +
			`Options:\n` +
			`  - Set TEAM_DEPLOYER / TEAM_MIGRATOR or USE_KEYSTORE=true if this is a managed key.\n` +
			`  - Use an external wallet RPC that exposes the hardware account: HARDWARE_WALLET_RPC_URL=http://127.0.0.1:<port>.\n` +
			`  - Use direct Ledger scanning: HW_WALLET=ledger LEDGER_SCAN=true, or set LEDGER_PATH once known.`,
	)
}

export async function printHardwareWalletDiscovery(options: HardwareDiscoveryOptions = {}): Promise<void> {
	const expectedAddress = normalizeAddress(options.expectedAddress)
	const label = options.role ?? "hardware wallet"
	const rpcUrl = firstEnv([...optionalEnvNames(options.envPrefix, "RPC_URL"), ...EXTERNAL_RPC_ENV_NAMES])

	log.header("Hardware Wallet Discovery")
	if (expectedAddress) log.kv("Expected", `${log.addr(expectedAddress)} (${label})`)

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

	if (wantsLedger(options.envPrefix)) {
		const app = await openLedgerApp()
		const paths = buildLedgerCandidatePaths(options.envPrefix)
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
