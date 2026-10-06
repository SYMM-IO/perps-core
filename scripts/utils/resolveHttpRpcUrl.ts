export async function resolveHttpRpcUrl(value: unknown): Promise<string> {
	const resolved =
		typeof value === "string"
			? value
			: value !== null && typeof value === "object" && "getUrl" in value && typeof value.getUrl === "function"
				? await value.getUrl()
				: null
	if (typeof resolved !== "string" || resolved.trim() === "") throw new Error("Hardhat did not resolve RPC_ARBITRUM to a usable URL")
	const url = new URL(resolved)
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Resolved RPC URL uses unsupported protocol ${url.protocol}`)
	return resolved
}
