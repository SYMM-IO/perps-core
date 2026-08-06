export type VerificationProviderName = "etherscan" | "blockscout"

/** Chains whose canonical configured explorer implements the Blockscout API. */
export const BLOCKSCOUT_VERIFICATION_CHAIN_IDS = new Set([8822, 34443, 2632500])

export function verificationProviderForChain(chainId: number | bigint): VerificationProviderName {
	return BLOCKSCOUT_VERIFICATION_CHAIN_IDS.has(Number(chainId)) ? "blockscout" : "etherscan"
}
