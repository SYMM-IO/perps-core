import connection, { ethers, hre } from "../../../test/helpers/hardhat-connection.js"
import { log } from "./log.js"
import { baseNetworkName } from "./sharedConfig.js"

async function rpcUrlFromValue(value: unknown): Promise<string | undefined> {
	if (typeof value === "string" && value.length > 0) return value
	if (typeof value !== "object" || value === null) return undefined

	const resolved = value as {
		getUrl?: () => Promise<string>
		get?: () => Promise<string>
	}

	try {
		const url = await resolved.getUrl?.()
		if (typeof url === "string" && url.length > 0) return url
	} catch {
		// Best-effort display only; connection verification below owns failures.
	}

	try {
		const url = await resolved.get?.()
		if (typeof url === "string" && url.length > 0) return url
	} catch {
		// Best-effort display only; connection verification below owns failures.
	}

	return undefined
}

function maskRpcUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl)
		if (url.username) url.username = "***"
		if (url.password) url.password = "***"
		if (url.search) url.search = "?***"
		return url.toString()
	} catch {
		return rawUrl
	}
}

async function resolveConfiguredRpcUrl(): Promise<string> {
	const networkName = connection.networkName
	const networkConfig = (hre.config.networks as Record<string, unknown>)[networkName] as Record<string, unknown> | undefined
	const forkingConfig = networkConfig?.forking as Record<string, unknown> | undefined
	const configUrl = (await rpcUrlFromValue(networkConfig?.url)) ?? (await rpcUrlFromValue(forkingConfig?.url))
	if (configUrl) return configUrl

	if (networkName === "docker") {
		return process.env.HARDHAT_DOCKER_URL ?? "http://localhost:8545"
	}

	const suffix = baseNetworkName(networkName)
	const envName = suffix ? `RPC_${suffix.toUpperCase()}` : undefined
	if (envName) {
		const envUrl = await rpcUrlFromValue(process.env[envName])
		if (envUrl) return envUrl
	}

	const provider = ethers.provider as unknown as {
		_getConnection?: () => { url?: unknown }
		connection?: { url?: unknown }
	}
	const providerUrl = (await rpcUrlFromValue(provider._getConnection?.()?.url)) ?? (await rpcUrlFromValue(provider.connection?.url))
	if (providerUrl) return providerUrl

	return "(provider URL unavailable)"
}

/**
 * Verifies the RPC connection is healthy before running any script.
 * Checks connectivity, chain ID, and latest block freshness.
 */
export async function verifyRpc(expectedChainId?: number): Promise<void> {
	log.kv("Network", connection.networkName)
	log.kv("RPC URL", maskRpcUrl(await resolveConfiguredRpcUrl()))

	let network
	try {
		network = await ethers.provider.getNetwork()
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		throw new Error(`RPC connection failed. Check your RPC endpoint and network connectivity.\n  ${msg}`)
	}

	const chainId = Number(network.chainId)
	if (expectedChainId && chainId !== expectedChainId) {
		throw new Error(`Chain ID mismatch: expected ${expectedChainId}, got ${chainId}`)
	}

	let block
	try {
		block = await ethers.provider.getBlock("latest")
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		throw new Error(`RPC connected but failed to fetch latest block.\n  ${msg}`)
	}

	if (!block) {
		throw new Error("RPC returned null for latest block")
	}

	const blockAge = Math.floor(Date.now() / 1000) - block.timestamp
	const maxAge = 120 // 2 minutes
	if (blockAge > maxAge) {
		log.warn(`Latest block is ${blockAge}s old (block ${block.number}). RPC may be stale.`)
	}

	log.ok(`RPC connected — Chain ${chainId} | Block ${log.commaNumber(block.number)} (${blockAge}s ago)`)
}
