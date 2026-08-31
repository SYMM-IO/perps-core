import { LedgerSigner } from "@ethers-ext/signer-ledger"
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"
import { Contract, JsonRpcProvider, Wallet, ZeroHash, getAccountPath, getAddress, isAddress } from "ethers"
import hre from "hardhat"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"

import { isHyperEVMChainId, setHyperEVMBigBlocksForSigner } from "../../tasks/deploy/hyperevm.js"
import { GOLDEN_WALLET_INITCODE_HASH, REFERENCE_WALLET_OWNER, predictGaslessWalletAddress } from "./gasless-wallet.js"
import { GaslessLayerLibraryAddresses, deployGaslessLayerLibraries, gaslessLayerFactoryOptions } from "./layer-libraries.js"

const DEFAULT_PROXY = "0x9E8e015F0537c3C86c7103280F70bb42cb0f573f"
const DEFAULT_NETWORK = "hyperevm"
const DEFAULT_RPC = "https://rpc.hyperliquid.xyz/evm"
const HYPEREVM_CHAIN_ID = 999
const LEDGER_CACHE_FILE = ".gasless-layer-ledger-upgrade-cache.json"
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const IMPLEMENTATION_CONTRACT = "contracts/gaslessLayer/GaslessLayer.sol:GaslessLayer"
const NATIVE_TOP_UP_LIBRARY_CONTRACT = "contracts/gaslessLayer/libraries/GaslessNativeGasTopUpLib.sol:GaslessNativeGasTopUpLib"
const OPERATIONAL_FEE_LIBRARY_CONTRACT = "contracts/gaslessLayer/libraries/GaslessOperationalFeeLib.sol:GaslessOperationalFeeLib"
const DEPLOYER_LIBRARY_CONTRACT = "contracts/gaslessLayer/libraries/GaslessWalletDeployerLib.sol:GaslessWalletDeployerLib"
const EXECUTION_LIBRARY_CONTRACT = "contracts/gaslessLayer/libraries/GaslessWalletExecutionLib.sol:GaslessWalletExecutionLib"
const DEFAULT_VERIFY_PROVIDER = "etherscan"
const require = createRequire(import.meta.url)
const VERIFY_PROVIDERS = new Set(["etherscan", "blockscout", "sourcify"])
const RPC_RETRY_ATTEMPTS = 8
const RPC_RETRY_DELAY_MS = 2_500

type VerifyProvider = "etherscan" | "blockscout" | "sourcify"

const AccessControlABI = [
	"function hasRole(bytes32 role, address account) view returns (bool)",
	"function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
]

const UUPSABI = ["function upgradeToAndCall(address newImplementation, bytes data) payable", "function proxiableUUID() view returns (bytes32)"]

const WalletDerivationABI = ["function getGaslessWalletAddress(address ownerWallet) view returns (address)"]

class HyperEVMRetryingProvider extends JsonRpcProvider {
	async _send(payload: any): Promise<any> {
		for (let attempt = 1; ; attempt++) {
			const response = await super._send(payload)
			if (!hasRetryableRpcError(response) || attempt >= RPC_RETRY_ATTEMPTS) return response

			console.warn(`HyperEVM RPC returned a transient block-height error; retrying JSON-RPC request ` + `(${attempt}/${RPC_RETRY_ATTEMPTS - 1})...`)
			await sleep(RPC_RETRY_DELAY_MS)
		}
	}
}

function env(name: string): string | undefined {
	const value = process.env[name]?.trim()
	return value ? value : undefined
}

function normalizeAddress(value: string, label: string): string {
	if (!isAddress(value)) throw new Error(`${label} must be a valid address, got "${value}"`)
	return getAddress(value)
}

function addressKey(value: string): string {
	return value.toLowerCase()
}

function sameAddress(a: string, b: string): boolean {
	return addressKey(a) === addressKey(b)
}

function getRpcUrl(): string {
	return env("RPC_HYPEREVM") || DEFAULT_RPC
}

function boolEnv(name: string): boolean {
	return process.env[name] === "true"
}

function hasRetryableRpcError(response: any): boolean {
	const results = Array.isArray(response) ? response : [response]
	return results.some(result => {
		const message = String(result?.error?.message ?? result?.message ?? "")
		return message.includes("invalid block height")
	})
}

function readGaslessLayerLibrariesFromEnv(required: boolean): GaslessLayerLibraryAddresses | undefined {
	const nativeTopUpLib = env("GASLESS_NATIVE_GAS_TOP_UP_LIB")
	const operationalFeeLib = env("GASLESS_OPERATIONAL_FEE_LIB")
	const deployerLib = env("GASLESS_WALLET_DEPLOYER_LIB")
	const executionLib = env("GASLESS_WALLET_EXECUTION_LIB")
	if (!nativeTopUpLib && !operationalFeeLib && !deployerLib && !executionLib && !required) return undefined
	if (!nativeTopUpLib || !operationalFeeLib || !deployerLib || !executionLib) {
		throw new Error(
			"GASLESS_NATIVE_GAS_TOP_UP_LIB, GASLESS_OPERATIONAL_FEE_LIB, GASLESS_WALLET_DEPLOYER_LIB and GASLESS_WALLET_EXECUTION_LIB must all be set when verifying or using a supplied linked implementation.",
		)
	}
	return {
		GaslessNativeGasTopUpLib: normalizeAddress(nativeTopUpLib, "GASLESS_NATIVE_GAS_TOP_UP_LIB"),
		GaslessOperationalFeeLib: normalizeAddress(operationalFeeLib, "GASLESS_OPERATIONAL_FEE_LIB"),
		GaslessWalletDeployerLib: normalizeAddress(deployerLib, "GASLESS_WALLET_DEPLOYER_LIB"),
		GaslessWalletExecutionLib: normalizeAddress(executionLib, "GASLESS_WALLET_EXECUTION_LIB"),
	}
}

function getVerifyProvider(): VerifyProvider {
	const provider = env("VERIFY_PROVIDER") || DEFAULT_VERIFY_PROVIDER
	if (!VERIFY_PROVIDERS.has(provider)) {
		throw new Error(`VERIFY_PROVIDER must be one of etherscan, blockscout, or sourcify, got "${provider}"`)
	}
	return provider as VerifyProvider
}

function assertVerificationConfigured(provider: VerifyProvider): void {
	if (provider === "etherscan" && !env("ETHERSCAN_APIKEY") && !boolEnv("USE_KEYSTORE")) {
		throw new Error(
			"ETHERSCAN_APIKEY is required for VERIFY_PROVIDER=etherscan unless USE_KEYSTORE=true is set. " +
				"Set USE_KEYSTORE=true to read ETHERSCAN_APIKEY from the Hardhat keystore, or set SKIP_VERIFY=true to skip implementation verification.",
		)
	}
}

function getLedgerPath(): string | number {
	const rawPath = env("LEDGER_PATH")
	if (!rawPath) return 0

	const numericPath = Number(rawPath)
	if (Number.isInteger(numericPath) && numericPath >= 0 && rawPath === numericPath.toString()) return numericPath
	return rawPath
}

function getLedgerScanCount(): number {
	const rawScanCount = env("LEDGER_SCAN_COUNT")
	if (!rawScanCount) return 100

	const scanCount = Number(rawScanCount)
	if (!Number.isInteger(scanCount) || scanCount <= 0) {
		throw new Error(`LEDGER_SCAN_COUNT must be a positive integer, got "${rawScanCount}"`)
	}
	return scanCount
}

function getLedgerApiPath(path: string | number): string {
	return typeof path === "number" ? getAccountPath(path) : path
}

function readLedgerPathCache(expectedAddress: string): string | number | undefined {
	if (!existsSync(LEDGER_CACHE_FILE)) return undefined

	try {
		const cache = JSON.parse(readFileSync(LEDGER_CACHE_FILE, "utf8"))
		const cachedPath = cache?.[addressKey(expectedAddress)]?.path
		if (typeof cachedPath === "string" || typeof cachedPath === "number") return cachedPath
	} catch {
		return undefined
	}
	return undefined
}

function writeLedgerPathCache(expectedAddress: string, path: string | number): void {
	let cache: Record<string, { address: string; path: string | number; updatedAt: string }> = {}
	if (existsSync(LEDGER_CACHE_FILE)) {
		try {
			cache = JSON.parse(readFileSync(LEDGER_CACHE_FILE, "utf8"))
		} catch {
			cache = {}
		}
	}

	cache[addressKey(expectedAddress)] = {
		address: expectedAddress,
		path,
		updatedAt: new Date().toISOString(),
	}
	writeFileSync(LEDGER_CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`)
}

async function readLedgerAddress(signer: LedgerSigner, path: string | number): Promise<string> {
	return signer.getAddress().catch((error: any) => {
		if (error?.message === "device is not running Ethereum App") {
			throw new Error("Ledger is connected, but the Ethereum app is not open.")
		}
		throw new Error(`Failed to read Ledger address for path ${path}: ${error?.message ?? error}`)
	})
}

function attachLedgerMetadata(signer: LedgerSigner, transport: any, provider: JsonRpcProvider | null, path: string | number): LedgerSigner {
	const apiPath = getLedgerApiPath(path)
	const signerWithMetadata = signer as any
	signerWithMetadata.__ledgerTransport = transport
	signerWithMetadata.__ledgerPath = apiPath
	signerWithMetadata.connect = (nextProvider?: JsonRpcProvider | null) =>
		attachLedgerMetadata(new LedgerSigner(transport, nextProvider ?? null, path), transport, nextProvider ?? null, path)
	signerWithMetadata.getSigner = (nextPath?: string | number) => {
		const resolvedPath = nextPath ?? path
		return attachLedgerMetadata(new LedgerSigner(transport, provider, resolvedPath), transport, provider, resolvedPath)
	}
	return signer
}

async function getLedgerSigner(provider: JsonRpcProvider): Promise<LedgerSigner> {
	const { default: TransportNodeHidNoEvents } = require("@ledgerhq/hw-transport-node-hid-noevents")
	const transport = await TransportNodeHidNoEvents.open().catch((error: any) => {
		if (error?.id === "NoDevice" || error?.message === "NoDevice") {
			throw new Error("Ledger device not found. Connect and unlock the Ledger, then open the Ethereum app.")
		}
		throw error
	})

	const expected = env("LEDGER_ACCOUNT")
	const expectedAddress = expected ? normalizeAddress(expected, "LEDGER_ACCOUNT") : undefined
	const expectedKey = expectedAddress ? addressKey(expectedAddress) : undefined
	const rawPath = env("LEDGER_PATH")

	if (!rawPath && !expectedAddress) {
		throw new Error("Ledger admin is not assumed to be index 0. Set LEDGER_ACCOUNT for auto-discovery, or set LEDGER_PATH explicitly.")
	}

	if (!rawPath && expectedAddress) {
		const cachedPath = readLedgerPathCache(expectedAddress)
		if (cachedPath !== undefined) {
			const cachedSigner = new LedgerSigner(transport, provider, cachedPath)
			const cachedAddress = await readLedgerAddress(cachedSigner, cachedPath)
			if (addressKey(cachedAddress) === expectedKey) {
				console.log(`Ledger account matched cached path ${cachedPath}: ${cachedAddress}`)
				return attachLedgerMetadata(cachedSigner, transport, provider, cachedPath)
			}
			console.warn(`Cached Ledger path ${cachedPath} resolved to ${cachedAddress}, not ${expectedAddress}. Scanning again...`)
		}

		const scanCount = getLedgerScanCount()
		console.log(`Scanning first ${scanCount} Ledger accounts for ${expectedAddress}...`)
		for (let index = 0; index < scanCount; index++) {
			const candidate = new LedgerSigner(transport, provider, index)
			const candidateAddress = await readLedgerAddress(candidate, index)
			if (addressKey(candidateAddress) === expectedKey) {
				console.log(`Ledger account matched at index ${index}: ${candidateAddress}`)
				writeLedgerPathCache(expectedAddress, index)
				return attachLedgerMetadata(candidate, transport, provider, index)
			}
		}

		throw new Error(
			`LEDGER_ACCOUNT ${expectedAddress} was not found in the first ${scanCount} Ledger accounts. ` +
				"Set LEDGER_PATH to the exact derivation path or increase LEDGER_SCAN_COUNT.",
		)
	}

	const path = getLedgerPath()
	const signer = new LedgerSigner(transport, provider, path)
	const signerAddress = await readLedgerAddress(signer, path)
	if (expectedAddress && !sameAddress(signerAddress, expectedAddress)) {
		throw new Error(`Ledger account mismatch: LEDGER_ACCOUNT is ${expectedAddress}, but ${getLedgerApiPath(path)} resolved to ${signerAddress}`)
	}
	return attachLedgerMetadata(signer, transport, provider, path)
}

async function getSigner(provider: JsonRpcProvider): Promise<any> {
	if (process.env.USE_LEDGER === "true") return getLedgerSigner(provider)

	const key = env("DEPLOYER_KEY") || env("NEW_DEPLOYER") || env("TEAM_DEPLOYER")
	if (!key) {
		throw new Error("Set USE_LEDGER=true for the Ledger admin, or set NEW_DEPLOYER for a non-Ledger signer.")
	}
	return new Wallet(key, provider)
}

async function getSignerAddress(signer: any): Promise<string> {
	return getAddress(signer.address ?? (await signer.getAddress()))
}

async function getImplementationAddress(provider: JsonRpcProvider, proxy: string): Promise<string> {
	const value = await provider.getStorage(proxy, IMPLEMENTATION_SLOT)
	return getAddress(`0x${value.slice(-40)}`)
}

async function requireCode(provider: JsonRpcProvider, address: string, label: string): Promise<void> {
	const code = await provider.getCode(address)
	if (code === "0x") throw new Error(`${label} has no code at ${address}`)
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForImplementation(provider: JsonRpcProvider, proxy: string, expectedImplementation: string): Promise<string> {
	const expected = addressKey(expectedImplementation)
	let current = await getImplementationAddress(provider, proxy)

	for (let attempt = 1; attempt <= 12 && addressKey(current) !== expected; attempt++) {
		console.warn(`Implementation slot still reads ${current}; waiting for RPC state (${attempt}/12)...`)
		await sleep(5_000)
		current = await getImplementationAddress(provider, proxy)
	}

	if (addressKey(current) !== expected) {
		throw new Error(`Implementation mismatch after upgrade: expected ${expectedImplementation}, got ${current}`)
	}
	return current
}

async function verifyUUPSImplementation(provider: JsonRpcProvider, implementation: string): Promise<void> {
	const implementationContract = new Contract(implementation, UUPSABI, provider) as any
	const uuid = await implementationContract.proxiableUUID()
	if (uuid.toLowerCase() !== IMPLEMENTATION_SLOT.toLowerCase()) {
		throw new Error(`New implementation proxiableUUID mismatch: expected ${IMPLEMENTATION_SLOT}, got ${uuid}`)
	}
}

function implementationSlotOverride(implementation: string): string {
	return `0x${getAddress(implementation).slice(2).toLowerCase().padStart(64, "0")}`
}

/**
 * Guard the frozen deposit-address invariant across an upgrade. Every user's deposit address is
 * CREATE2(proxy, salt(owner), keccak256(GaslessWallet.creationCode)); a mis-linked
 * GaslessWalletDeployerLib or a changed salt/initcode in the new implementation would deploy fine yet
 * MOVE every address. This fails BEFORE upgradeToAndCall.
 */
async function assertWalletDerivationStable(provider: JsonRpcProvider, proxy: string, newImplementation: string): Promise<void> {
	const expected = predictGaslessWalletAddress(proxy, REFERENCE_WALLET_OWNER, GOLDEN_WALLET_INITCODE_HASH)
	const reader = new Contract(proxy, WalletDerivationABI, provider) as any

	// 1. If the CURRENT live implementation already exposes wallet derivation, it must match the
	//    pinned formula. Older deployed implementations do not have this method yet; that is expected
	//    when upgrading from the pre-wallet main deployment, so the new implementation pre-flight below
	//    is the authoritative pre-upgrade check for this migration.
	try {
		const live = await reader.getGaslessWalletAddress(REFERENCE_WALLET_OWNER)
		if (!sameAddress(live, expected)) {
			throw new Error(
				`Wallet-derivation drift: the live proxy derives ${live} for the reference owner, but the pinned golden ` +
					`formula expects ${expected}. The working-tree GaslessWallet bytecode or salt scheme no longer matches the ` +
					`deployed system — shipping this would move every deposit address.`,
			)
		}
		console.log("Wallet-derivation live check: OK", live)
	} catch (error: any) {
		if (error?.code !== "CALL_EXCEPTION") throw error
		console.warn("Wallet-derivation live check skipped: current implementation does not expose getGaslessWalletAddress yet.")
	}

	// 2. Pre-flight the NEW implementation via eth_call with a state override that repoints the proxy's
	//    implementation slot, WITHOUT upgrading. Skipped only if the RPC rejects state overrides.
	const calldata = reader.interface.encodeFunctionData("getGaslessWalletAddress", [REFERENCE_WALLET_OWNER])
	const override = { [proxy]: { stateDiff: { [IMPLEMENTATION_SLOT]: implementationSlotOverride(newImplementation) } } }
	let raw: string | undefined
	try {
		raw = await provider.send("eth_call", [{ to: proxy, data: calldata }, "latest", override])
	} catch (error: any) {
		console.warn(
			`Wallet-derivation pre-flight skipped (RPC rejected the state override: ${error?.message ?? error}). Relying on the post-upgrade check.`,
		)
	}
	if (raw !== undefined) {
		const derived = getAddress(`0x${raw.slice(-40)}`)
		if (!sameAddress(derived, expected)) {
			throw new Error(
				`New implementation derives ${derived} for the reference owner, expected ${expected}. A mis-linked ` +
					`GaslessWalletDeployerLib or changed salt/initcode would MOVE every deposit address. Aborting before upgradeToAndCall.`,
			)
		}
		console.log("Wallet-derivation pre-flight (state override): OK", derived)
	}
}

async function assertPostUpgradeWalletDerivation(provider: JsonRpcProvider, proxy: string, previousImplementation: string): Promise<void> {
	const expected = predictGaslessWalletAddress(proxy, REFERENCE_WALLET_OWNER, GOLDEN_WALLET_INITCODE_HASH)
	const reader = new Contract(proxy, WalletDerivationABI, provider) as any
	const derived = await reader.getGaslessWalletAddress(REFERENCE_WALLET_OWNER)
	if (!sameAddress(derived, expected)) {
		throw new Error(
			`After upgrade the proxy derives ${derived} for the reference owner, expected ${expected}. The new implementation ` +
				`MOVES deposit addresses — DO NOT announce; roll back by upgrading to ${previousImplementation}.`,
		)
	}
	console.log("Wallet-derivation post-upgrade check: OK", derived)
}

function isAlreadyVerifiedError(error: any): boolean {
	const message = String(error?.message ?? error)
	return message.toLowerCase().includes("already verified") || message.toLowerCase().includes("contract source code already verified")
}

async function verifyOnExplorer(address: string, contract: string, label: string, libraries?: Record<string, string>): Promise<void> {
	const provider = getVerifyProvider()
	assertVerificationConfigured(provider)
	console.log(`Verifying ${label} on ${provider}:`, address)

	try {
		const verified = await verifyContract(
			{
				address,
				constructorArgs: [],
				contract,
				force: boolEnv("FORCE_VERIFY"),
				provider,
				...(libraries ? { libraries } : {}),
			},
			hre,
		)
		console.log(verified ? `${label} verified.` : `${label} verification finished without a success response.`)
	} catch (error: any) {
		if (isAlreadyVerifiedError(error)) {
			console.log(`${label} already verified.`)
			return
		}
		throw error
	}
}

async function verifyGaslessLayerLibrariesOnExplorer(libraries: GaslessLayerLibraryAddresses): Promise<void> {
	if (boolEnv("SKIP_VERIFY")) return

	await verifyOnExplorer(libraries.GaslessNativeGasTopUpLib, NATIVE_TOP_UP_LIBRARY_CONTRACT, "GaslessNativeGasTopUpLib")
	await verifyOnExplorer(libraries.GaslessOperationalFeeLib, OPERATIONAL_FEE_LIBRARY_CONTRACT, "GaslessOperationalFeeLib")
	await verifyOnExplorer(libraries.GaslessWalletDeployerLib, DEPLOYER_LIBRARY_CONTRACT, "GaslessWalletDeployerLib")
	await verifyOnExplorer(libraries.GaslessWalletExecutionLib, EXECUTION_LIBRARY_CONTRACT, "GaslessWalletExecutionLib", {
		GaslessWalletDeployerLib: libraries.GaslessWalletDeployerLib,
	})
}

async function verifyImplementationOnExplorer(implementation: string, libraries?: GaslessLayerLibraryAddresses): Promise<void> {
	if (boolEnv("SKIP_VERIFY")) {
		console.log("Verification skipped: SKIP_VERIFY=true")
		return
	}

	try {
		if (libraries) await verifyGaslessLayerLibrariesOnExplorer(libraries)
		await verifyOnExplorer(implementation, IMPLEMENTATION_CONTRACT, "implementation", libraries)
	} catch (error: any) {
		console.error("Implementation verification failed after upgrade. The proxy upgrade may still be mined; verify manually if needed.")
		throw error
	}
}

async function main() {
	const networkName = env("UPGRADE_NETWORK") || DEFAULT_NETWORK
	const proxy = normalizeAddress(env("GASLESS_LAYER_PROXY") || DEFAULT_PROXY, "GASLESS_LAYER_PROXY")
	const dryRun = process.env.CONFIRM_UPGRADE !== "true"
	const verifyProvider = getVerifyProvider()
	const rpcUrl = getRpcUrl()
	const provider = new HyperEVMRetryingProvider(rpcUrl)
	const connection = await hre.network.connect(networkName)
	const { ethers } = connection
	const signer = await getSigner(provider)
	const signerAddress = await getSignerAddress(signer)
	const chain = await provider.getNetwork()
	const chainId = Number(chain.chainId)

	console.log("gaslessLayer GaslessLayer UUPS upgrade")
	console.log("Network:              ", networkName)
	console.log("RPC:                  ", rpcUrl)
	console.log("Chain ID:             ", chainId)
	console.log("Proxy:                ", proxy)
	console.log("Signer:               ", signerAddress)
	console.log("Signer type:          ", process.env.USE_LEDGER === "true" ? "Ledger" : "NEW_DEPLOYER")
	console.log("Verification:         ", boolEnv("SKIP_VERIFY") ? "skipped" : verifyProvider)

	if (chainId !== HYPEREVM_CHAIN_ID) {
		throw new Error(`Refusing to upgrade on chain ${chainId}; expected HyperEVM chain ${HYPEREVM_CHAIN_ID}`)
	}
	if (sameAddress(proxy, DEFAULT_PROXY)) {
		throw new Error(
			`Refusing to upgrade legacy GaslessLayer proxy ${proxy}: it was deployed with OpenZeppelin 4 and is not storage-compatible with ` +
				"the OpenZeppelin 5 implementation. Deploy a fresh proxy with scripts/gaslessLayer/deploy.ts instead.",
		)
	}

	if (!dryRun && !boolEnv("SKIP_VERIFY")) {
		assertVerificationConfigured(verifyProvider)
	}

	await requireCode(provider, proxy, "GaslessLayer proxy")
	const currentImplementation = await getImplementationAddress(provider, proxy)
	console.log("Current implementation:", currentImplementation)

	const gatewayReader = new Contract(proxy, AccessControlABI, provider) as any
	const defaultAdminRole = await gatewayReader.DEFAULT_ADMIN_ROLE().catch(() => ZeroHash)
	const signerIsAdmin = await gatewayReader.hasRole(defaultAdminRole, signerAddress)
	console.log("Signer has admin role: ", signerIsAdmin)

	if (!signerIsAdmin) {
		const message = `Signer ${signerAddress} does not hold DEFAULT_ADMIN_ROLE on ${proxy}`
		if (dryRun) console.warn(`WARNING: ${message}. Execution would fail.`)
		else throw new Error(message)
	}

	const suppliedImplementation = env("NEW_IMPLEMENTATION")
	if (dryRun) {
		console.log("Dry run only. Set CONFIRM_UPGRADE=true to deploy and send upgradeToAndCall.")
		if (suppliedImplementation) {
			const implementation = normalizeAddress(suppliedImplementation, "NEW_IMPLEMENTATION")
			await requireCode(provider, implementation, "NEW_IMPLEMENTATION")
			await verifyUUPSImplementation(provider, implementation)
			await assertWalletDerivationStable(provider, proxy, implementation)
			const gateway = new Contract(proxy, UUPSABI, signer) as any
			const tx = await gateway.upgradeToAndCall.populateTransaction(implementation, "0x")
			console.log("Prepared upgradeToAndCall calldata:", tx.data)
		}
		return
	}

	let newImplementation: string
	let linkedLibraries: GaslessLayerLibraryAddresses | undefined
	if (suppliedImplementation) {
		newImplementation = normalizeAddress(suppliedImplementation, "NEW_IMPLEMENTATION")
		await requireCode(provider, newImplementation, "NEW_IMPLEMENTATION")
		linkedLibraries = readGaslessLayerLibrariesFromEnv(!boolEnv("SKIP_VERIFY"))
		if (linkedLibraries) {
			console.log("Using supplied GaslessNativeGasTopUpLib:", linkedLibraries.GaslessNativeGasTopUpLib)
			console.log("Using supplied GaslessOperationalFeeLib:", linkedLibraries.GaslessOperationalFeeLib)
			console.log("Using supplied GaslessWalletDeployerLib:", linkedLibraries.GaslessWalletDeployerLib)
			console.log("Using supplied GaslessWalletExecutionLib:", linkedLibraries.GaslessWalletExecutionLib)
		}
		console.log("Using supplied implementation:", newImplementation)
	} else {
		const shouldToggleBigBlocks = isHyperEVMChainId(chainId)
		if (shouldToggleBigBlocks) {
			console.log("HyperEVM detected - enabling big blocks for library and implementation deployment...")
			await setHyperEVMBigBlocksForSigner(signer, chainId, true)
			console.log("")
		}

		try {
			linkedLibraries = await deployGaslessLayerLibraries(ethers, signer, console.log)
			console.log("GaslessNativeGasTopUpLib:", linkedLibraries.GaslessNativeGasTopUpLib)
			console.log("GaslessOperationalFeeLib:", linkedLibraries.GaslessOperationalFeeLib)
			console.log("GaslessWalletDeployerLib:", linkedLibraries.GaslessWalletDeployerLib)
			console.log("GaslessWalletExecutionLib:", linkedLibraries.GaslessWalletExecutionLib)

			const Gateway = await ethers.getContractFactory("GaslessLayer", gaslessLayerFactoryOptions(linkedLibraries, signer))
			console.log("Deploying GaslessLayer implementation...")
			const implementation = await Gateway.deploy()
			console.log("Deploy implementation tx:", implementation.deploymentTransaction()?.hash)
			await implementation.waitForDeployment()
			newImplementation = await implementation.getAddress()
			console.log("New implementation:   ", newImplementation)
		} finally {
			if (shouldToggleBigBlocks) {
				console.log("")
				console.log("Library and implementation deployment complete - restoring HyperEVM fast blocks before upgradeToAndCall...")
				try {
					await setHyperEVMBigBlocksForSigner(signer, chainId, false)
				} catch (err: any) {
					console.error("Failed to disable big blocks. Run manually:")
					console.error("  npx hardhat hyperevm:disable-big-blocks --network hyperevm")
					console.error(err)
				}
			}
		}
	}

	await requireCode(provider, newImplementation, "new implementation")
	await verifyUUPSImplementation(provider, newImplementation)
	await assertWalletDerivationStable(provider, proxy, newImplementation)

	const gateway = new Contract(proxy, UUPSABI, signer) as any
	const estimatedGas = await gateway.upgradeToAndCall.estimateGas(newImplementation, "0x").catch(() => undefined)
	if (estimatedGas !== undefined) console.log("upgradeToAndCall gas estimate:", estimatedGas.toString())

	const upgradeTx = await gateway.upgradeToAndCall(newImplementation, "0x")
	console.log("Upgrade tx:           ", upgradeTx.hash)
	const receipt = await upgradeTx.wait()
	if (receipt.status !== 1) throw new Error(`Upgrade transaction reverted: ${upgradeTx.hash}`)
	console.log("Upgrade mined in block:", receipt.blockNumber)

	const implementationAfter = await waitForImplementation(provider, proxy, newImplementation)
	console.log("Implementation after: ", implementationAfter)
	await assertPostUpgradeWalletDerivation(provider, proxy, currentImplementation)
	await verifyImplementationOnExplorer(implementationAfter, linkedLibraries)
	console.log("Upgrade complete.")
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
