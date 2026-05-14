/**
 * Sets every valid Sei Symmio symbol trading fee to 0.5 bps through SymmioSymbolManager.
 *
 * Usage:
 *   DRY_RUN=true npx hardhat run scripts/setSeiSymbolTradingFees.ts --network sei
 *   npx hardhat run scripts/setSeiSymbolTradingFees.ts --network sei
 *
 * Env overrides:
 *   RPC_SEI=https://...                  Sei RPC URL
 *   SYMMIO_ADDRESS=0x...                 Symmio diamond address
 *   SYMBOL_MANAGER_ADDRESS=0x...         SymmioSymbolManager address
 *   TRADING_FEE_BPS=0.5                  Target fee in basis points
 *   BATCH_SIZE=25                        Symbols per transaction
 *   SYMBOL_READ_CHUNK=100                Symbols per read call
 *   CONFIRMATIONS=1                      Confirmations to wait per tx
 *   RPC_RETRIES=6                        Retry count for rate-limited reads/receipts
 *   RPC_RETRY_DELAY_MS=1000              Initial retry delay, doubled each retry
 *   BETWEEN_BATCH_DELAY_MS=1000          Delay after each verified batch
 *   SIGNER_ADDRESS=0x...                 Optional dry-run role check address
 *   ALLOW_NON_SEI=true                   Allow fork/testing networks
 *   DRY_RUN=true                         Print actions without sending transactions
 */
import { getAddress, id, parseUnits, ZeroAddress } from "ethers"
import hre from "hardhat"

const DEFAULT_SYMMIO_ADDRESS = "0xC6a7cc26fd84aE573b705423b7d1831139793025"
const DEFAULT_SYMBOL_MANAGER_ADDRESS = "0xbC6823bF53fCa3ED2B22b2ba9eaD339946031334"
const DEFAULT_RPC_SEI = "https://evm-rpc.sei-apis.com"
const DUMMY_PRIVATE_KEY = "0xec81e00837948239d5927bcb2b785675552bc92f1d2607ee91c540ddb56d6796"
const DEFAULT_TRADING_FEE_BPS = "0.5"
const DEFAULT_BATCH_SIZE = 25
const DEFAULT_SYMBOL_READ_CHUNK = 100
const DEFAULT_CONFIRMATIONS = 1
const DEFAULT_RPC_RETRIES = 6
const DEFAULT_RPC_RETRY_DELAY_MS = 1000
const DEFAULT_BETWEEN_BATCH_DELAY_MS = 1000
const SEI_CHAIN_ID = 1329
const ONE_DAY_SECONDS = 24n * 60n * 60n

const SYMBOL_MANAGER_ABI = [
	"function SYMBOL_TRADING_FEE_MANAGER_ROLE() view returns (bytes32)",
	"function hasRole(bytes32 role,address account) view returns (bool)",
	"function paused() view returns (bool)",
	"function symmioAddress() view returns (address)",
	"function lastResetTimestamp() view returns (uint256)",
	"function getDailyLimits() view returns (tuple(uint256 symbolAddition,uint256 tradingFee,uint256 validationState,uint256 maxLeverage,uint256 acceptableValues,uint256 fundingState,uint256 forceCloseGapRatio))",
	"function getDailyOperations() view returns (tuple(uint256 symbolAddition,uint256 tradingFee,uint256 validationState,uint256 maxLeverage,uint256 acceptableValues,uint256 fundingState,uint256 forceCloseGapRatio))",
	"function setSymbolTradingFeeBatch(uint256[] symbolIds,uint256[] tradingFees)",
]

const SYMMIO_ABI = [
	"function hasRole(address user,bytes32 role) view returns (bool)",
	"function getSymbol(uint256 symbolId) view returns (tuple(uint256 symbolId,string name,bool isValid,uint256 minAcceptableQuoteValue,uint256 minAcceptablePortionLF,uint256 tradingFee,uint256 maxLeverage,uint256 fundingRateEpochDuration,uint256 fundingRateWindowTime))",
	"function getSymbols(uint256 start,uint256 size) view returns (tuple(uint256 symbolId,string name,bool isValid,uint256 minAcceptableQuoteValue,uint256 minAcceptablePortionLF,uint256 tradingFee,uint256 maxLeverage,uint256 fundingRateEpochDuration,uint256 fundingRateWindowTime)[])",
]

type LiveSymbol = {
	symbolId: bigint
	name: string
	isValid: boolean
	tradingFee: bigint
}

type RetryConfig = {
	retries: number
	delayMs: number
}

function envFlag(name: string, defaultValue = false): boolean {
	const raw = process.env[name]
	if (raw === undefined) return defaultValue
	return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes"
}

function readPositiveInteger(name: string, defaultValue: number): number {
	const raw = process.env[name]
	if (raw === undefined) return defaultValue

	const parsed = Number(raw)
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
	return parsed
}

function readNonNegativeInteger(name: string, defaultValue: number): number {
	const raw = process.env[name]
	if (raw === undefined) return defaultValue

	const parsed = Number(raw)
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`)
	return parsed
}

function normalizeAddress(value: string, label: string): string {
	try {
		const address = getAddress(value.trim().toLowerCase())
		if (address === ZeroAddress) throw new Error("zero address")
		return address
	} catch {
		throw new Error(`${label} must be a valid address: ${value}`)
	}
}

function parseTradingFeeBps(value: string): bigint {
	try {
		return parseUnits(value, 14)
	} catch {
		throw new Error(`TRADING_FEE_BPS must be a decimal bps value: ${value}`)
	}
}

function formatUnitsTrimmed(value: bigint, decimals: number): string {
	const scale = 10n ** BigInt(decimals)
	const whole = value / scale
	const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "")
	return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString()
}

function formatTradingFee(value: bigint): string {
	return `${formatUnitsTrimmed(value, 14)} bps (${value.toString()})`
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function isRetryableRpcError(error: unknown): boolean {
	const message = errorMessage(error).toLowerCase()
	return (
		message.includes("rate limit") ||
		message.includes("server busy") ||
		message.includes("too many requests") ||
		message.includes("timeout") ||
		message.includes("econnreset") ||
		message.includes("network error")
	)
}

async function withRetry<T>(label: string, retryConfig: RetryConfig, action: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await action()
		} catch (error) {
			if (attempt >= retryConfig.retries || !isRetryableRpcError(error)) {
				throw error
			}

			const delay = retryConfig.delayMs * 2 ** attempt
			console.warn(`  ${label}: RPC busy, retry ${attempt + 1}/${retryConfig.retries} in ${delay}ms`)
			await sleep(delay)
		}
	}
}

function normalizeSymbol(symbol: any): LiveSymbol {
	return {
		symbolId: BigInt(symbol.symbolId),
		name: symbol.name,
		isValid: Boolean(symbol.isValid),
		tradingFee: BigInt(symbol.tradingFee),
	}
}

async function readSymbolsRange(symmio: any, start: number, size: number, retryConfig: RetryConfig): Promise<LiveSymbol[]> {
	const batch = await withRetry(`getSymbols(${start}, ${size})`, retryConfig, () => symmio.getSymbols(start, size))
	return batch.map((symbol: any) => normalizeSymbol(symbol))
}

async function readAllSymbols(symmio: any, chunkSize: number, retryConfig: RetryConfig): Promise<LiveSymbol[]> {
	const symbols: LiveSymbol[] = []

	for (let start = 0; ; start += chunkSize) {
		const batch = await readSymbolsRange(symmio, start, chunkSize, retryConfig)
		if (batch.length === 0) break

		symbols.push(...batch)

		if (batch.length < chunkSize) break
	}

	return symbols
}

async function readSymbolsByIds(symmio: any, symbolIds: bigint[], chunkSize: number, retryConfig: RetryConfig): Promise<LiveSymbol[]> {
	const sortedIds = [...symbolIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
	const symbols = new Map<string, LiveSymbol>()

	for (let i = 0; i < sortedIds.length; ) {
		const startId = sortedIds[i]
		if (startId <= 0n) throw new Error(`Invalid symbol id: ${startId}`)

		let end = i + 1
		while (end < sortedIds.length && sortedIds[end] - startId + 1n <= BigInt(chunkSize)) {
			end++
		}

		const endId = sortedIds[end - 1]
		const start = Number(startId - 1n)
		const size = Number(endId - startId + 1n)
		const rangeSymbols = await readSymbolsRange(symmio, start, size, retryConfig)
		for (const symbol of rangeSymbols) {
			symbols.set(symbol.symbolId.toString(), symbol)
		}

		i = end
	}

	return sortedIds.map(symbolId => {
		const symbol = symbols.get(symbolId.toString())
		if (!symbol) throw new Error(`Symbol #${symbolId} was not returned by getSymbols`)
		return symbol
	})
}

async function verifySymbols(symmio: any, symbolIds: bigint[], targetTradingFee: bigint, chunkSize: number, retryConfig: RetryConfig) {
	const symbols = await readSymbolsByIds(symmio, symbolIds, chunkSize, retryConfig)

	for (const symbol of symbols) {
		if (symbol.tradingFee !== targetTradingFee) {
			throw new Error(`Post-update verification failed for #${symbol.symbolId}: expected ${targetTradingFee}, got ${symbol.tradingFee}`)
		}
	}
}

async function main() {
	const dryRun = envFlag("DRY_RUN")
	const allowNonSei = envFlag("ALLOW_NON_SEI")
	const symmioAddress = normalizeAddress(process.env.SYMMIO_ADDRESS ?? DEFAULT_SYMMIO_ADDRESS, "SYMMIO_ADDRESS")
	const symbolManagerAddress = normalizeAddress(process.env.SYMBOL_MANAGER_ADDRESS ?? DEFAULT_SYMBOL_MANAGER_ADDRESS, "SYMBOL_MANAGER_ADDRESS")
	const rpcUrl = process.env.RPC_SEI ?? DEFAULT_RPC_SEI
	const targetTradingFee = parseTradingFeeBps(process.env.TRADING_FEE_BPS ?? DEFAULT_TRADING_FEE_BPS)
	const batchSize = readPositiveInteger("BATCH_SIZE", DEFAULT_BATCH_SIZE)
	const readChunkSize = readPositiveInteger("SYMBOL_READ_CHUNK", DEFAULT_SYMBOL_READ_CHUNK)
	const confirmations = readPositiveInteger("CONFIRMATIONS", DEFAULT_CONFIRMATIONS)
	const retryConfig = {
		retries: readNonNegativeInteger("RPC_RETRIES", DEFAULT_RPC_RETRIES),
		delayMs: readPositiveInteger("RPC_RETRY_DELAY_MS", DEFAULT_RPC_RETRY_DELAY_MS),
	}
	const betweenBatchDelayMs = readNonNegativeInteger("BETWEEN_BATCH_DELAY_MS", DEFAULT_BETWEEN_BATCH_DELAY_MS)
	const dryRunSignerAddress = process.env.SIGNER_ADDRESS ? normalizeAddress(process.env.SIGNER_ADDRESS, "SIGNER_ADDRESS") : undefined

	const connection = await hre.network.connect({
		override: dryRun ? { accounts: [DUMMY_PRIVATE_KEY], url: rpcUrl } : { url: rpcUrl },
	})
	const { ethers } = connection as any
	const network = await withRetry("getNetwork", retryConfig, () => ethers.provider.getNetwork())
	const chainId = Number(network.chainId)

	if (chainId !== SEI_CHAIN_ID && !allowNonSei) {
		throw new Error(`This script is intended for Sei mainnet (chainId ${SEI_CHAIN_ID}). Current chainId: ${chainId}`)
	}

	const symmioCode = await withRetry("getCode(Symmio)", retryConfig, () => ethers.provider.getCode(symmioAddress))
	if (symmioCode === "0x") throw new Error(`Symmio has no bytecode at ${symmioAddress}`)

	const symbolManagerCode = await withRetry("getCode(SymbolManager)", retryConfig, () => ethers.provider.getCode(symbolManagerAddress))
	if (symbolManagerCode === "0x") throw new Error(`SymbolManager has no bytecode at ${symbolManagerAddress}`)

	const [signer] = dryRun ? [] : await ethers.getSigners()
	const signerAddress = signer?.address ?? dryRunSignerAddress
	const symbolManager = new ethers.Contract(symbolManagerAddress, SYMBOL_MANAGER_ABI, signer ?? ethers.provider)
	const symmio = new ethers.Contract(symmioAddress, SYMMIO_ABI, ethers.provider)

	const configuredSymmioAddress = normalizeAddress(
		await withRetry("symbolManager.symmioAddress()", retryConfig, () => symbolManager.symmioAddress()),
		"symbolManager.symmioAddress",
	)
	if (configuredSymmioAddress !== symmioAddress) {
		throw new Error(`SymbolManager points at ${configuredSymmioAddress}, expected ${symmioAddress}`)
	}

	const coreSymbolManagerRole = id("SYMBOL_MANAGER_ROLE")
	const managerHasCoreRole = await withRetry("symmio.hasRole(SymbolManager)", retryConfig, () =>
		symmio.hasRole(symbolManagerAddress, coreSymbolManagerRole),
	)
	if (!managerHasCoreRole) {
		throw new Error(`SymbolManager ${symbolManagerAddress} does not have SYMBOL_MANAGER_ROLE on ${symmioAddress}`)
	}

	const tradingFeeRole = await withRetry("SYMBOL_TRADING_FEE_MANAGER_ROLE()", retryConfig, () => symbolManager.SYMBOL_TRADING_FEE_MANAGER_ROLE())
	const canManageTradingFees = signerAddress
		? await withRetry("symbolManager.hasRole(signer)", retryConfig, () => symbolManager.hasRole(tradingFeeRole, signerAddress))
		: false
	const paused = await withRetry("symbolManager.paused()", retryConfig, () => symbolManager.paused())

	const dailyLimits = await withRetry("getDailyLimits()", retryConfig, () => symbolManager.getDailyLimits())
	const dailyOperations = await withRetry("getDailyOperations()", retryConfig, () => symbolManager.getDailyOperations())
	const lastResetTimestamp = BigInt(await withRetry("lastResetTimestamp()", retryConfig, () => symbolManager.lastResetTimestamp()))
	const latestBlock = await withRetry("getBlock(latest)", retryConfig, () => ethers.provider.getBlock("latest"))
	const latestTimestamp = BigInt(latestBlock.timestamp)
	const effectiveUsedToday = latestTimestamp >= lastResetTimestamp + ONE_DAY_SECONDS ? 0n : BigInt(dailyOperations.tradingFee)
	const dailyLimit = BigInt(dailyLimits.tradingFee)
	const remainingDailyCapacity = dailyLimit > effectiveUsedToday ? dailyLimit - effectiveUsedToday : 0n

	console.log("Sei symbol trading-fee update")
	console.log(`  Network:          ${connection.networkName} (${chainId})`)
	console.log(`  Symmio:           ${symmioAddress}`)
	console.log(`  SymbolManager:    ${symbolManagerAddress}`)
	console.log(`  Signer:           ${signerAddress ?? "(none)"}`)
	console.log(`  Has manager role: ${signerAddress ? (canManageTradingFees ? "yes" : "no") : "(not checked)"}`)
	console.log(`  Core role:        ${managerHasCoreRole ? "yes" : "no"}`)
	console.log(`  Paused:           ${paused ? "yes" : "no"}`)
	console.log(`  Target fee:       ${formatTradingFee(targetTradingFee)}`)
	console.log(`  Batch size:       ${batchSize} symbols per tx`)
	console.log(`  RPC retries:      ${retryConfig.retries} (initial ${retryConfig.delayMs}ms)`)
	console.log(`  Daily remaining:  ${remainingDailyCapacity.toString()} of ${dailyLimit.toString()}`)
	console.log(`  Dry run:          ${dryRun ? "yes" : "no"}`)

	if (!dryRun && !canManageTradingFees) {
		throw new Error(`Signer ${signerAddress} does not have SYMBOL_TRADING_FEE_MANAGER_ROLE on ${symbolManagerAddress}`)
	}

	if (!dryRun && paused) {
		throw new Error(`SymbolManager ${symbolManagerAddress} is paused`)
	}

	const symbols = await readAllSymbols(symmio, readChunkSize, retryConfig)
	const validSymbols = symbols.filter(symbol => symbol.isValid)
	const symbolsToUpdate = validSymbols.filter(symbol => symbol.tradingFee !== targetTradingFee)
	const validSymbolsAlreadyAtTarget = validSymbols.length - symbolsToUpdate.length

	console.log(`\nSymbols found:          ${symbols.length}`)
	console.log(`Valid symbols:          ${validSymbols.length}`)
	console.log(`Valid symbols already set: ${validSymbolsAlreadyAtTarget}`)
	console.log(`Invalid symbols skipped: ${symbols.length - validSymbols.length}`)
	console.log(`Valid symbols to update: ${symbolsToUpdate.length}`)
	console.log(`Planned transactions:    ${Math.ceil(symbolsToUpdate.length / batchSize)}`)

	if (symbolsToUpdate.length === 0) {
		console.log("\nAll valid symbols already use the target trading fee.")
		return
	}

	if (BigInt(symbolsToUpdate.length) > remainingDailyCapacity) {
		throw new Error(
			`Updating ${symbolsToUpdate.length} symbols would exceed SymbolManager daily tradingFee capacity (${remainingDailyCapacity} remaining)`,
		)
	}

	console.log("\nPlanned updates:")
	for (const symbol of symbolsToUpdate) {
		console.log(`  #${symbol.symbolId} ${symbol.name} ${formatTradingFee(symbol.tradingFee)} -> ${formatTradingFee(targetTradingFee)}`)
	}

	if (dryRun) {
		console.log("\nDry run complete. Re-run without DRY_RUN=true to submit transactions.")
		return
	}

	console.log("\nSubmitting transactions:")
	for (let i = 0; i < symbolsToUpdate.length; i += batchSize) {
		const initialBatch = symbolsToUpdate.slice(i, i + batchSize)
		const batchNumber = Math.floor(i / batchSize) + 1
		const batchCount = Math.ceil(symbolsToUpdate.length / batchSize)
		const refreshedBatch = (
			await readSymbolsByIds(
				symmio,
				initialBatch.map(symbol => symbol.symbolId),
				readChunkSize,
				retryConfig,
			)
		).filter(symbol => symbol.isValid && symbol.tradingFee !== targetTradingFee)

		if (refreshedBatch.length === 0) {
			console.log(`  batch ${batchNumber}/${batchCount}: already at target, skipping`)
			continue
		}

		const symbolIds = refreshedBatch.map(symbol => symbol.symbolId)
		const tradingFees = refreshedBatch.map(() => targetTradingFee)

		console.log(
			`  batch ${batchNumber}/${batchCount}: setSymbolTradingFeeBatch(${symbolIds[0]}..${symbolIds[symbolIds.length - 1]}, ${refreshedBatch.length} symbols)`,
		)
		const tx = await symbolManager.setSymbolTradingFeeBatch(symbolIds, tradingFees)
		console.log(`    tx: ${tx.hash}`)
		await withRetry(`wait(${tx.hash})`, retryConfig, () => tx.wait(confirmations))
		await verifySymbols(symmio, symbolIds, targetTradingFee, readChunkSize, retryConfig)
		console.log("    confirmed and verified")

		if (betweenBatchDelayMs > 0 && i + batchSize < symbolsToUpdate.length) {
			await sleep(betweenBatchDelayMs)
		}
	}

	console.log("\nDone. All valid discovered symbols now use the target trading fee.")
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
