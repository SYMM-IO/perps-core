function isLoopbackRpc(rawUrl: unknown): boolean {
	if (typeof rawUrl !== "string") return false
	try {
		const hostname = new URL(rawUrl).hostname.toLowerCase()
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
	} catch {
		return false
	}
}

export function assertLocalExecution(
	connection: { networkName?: string; networkConfig?: { type?: string; url?: unknown } },
	chainId: bigint | number,
	purpose: string,
): string {
	if (BigInt(chainId) !== 31337n) throw new Error(`${purpose} requires local chainId 31337; connected chainId is ${chainId}`)
	return assertSimulatedOrLoopback(connection, purpose)
}

export function assertSimulatedOrLoopback(
	connection: { networkName?: string; networkConfig?: { type?: string; url?: unknown } },
	purpose: string,
): string {
	if (connection.networkConfig?.type === "edr-simulated") return `simulated (${connection.networkName ?? "unknown"})`
	if (connection.networkConfig?.type === "http" && isLoopbackRpc(connection.networkConfig.url)) {
		return `loopback (${connection.networkName ?? "unknown"})`
	}
	throw new Error(`${purpose} refuses non-local RPC endpoints; use an EDR simulation or a localhost/loopback Hardhat node`)
}
