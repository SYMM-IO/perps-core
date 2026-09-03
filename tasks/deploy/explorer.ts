export type VerificationProviderName = "etherscan" | "blockscout"

type VerificationArtifactManager = {
	readArtifact: (contractNameOrFullyQualifiedName: string) => Promise<{ sourceName: string; contractName: string }>
}

/** Chains whose canonical configured explorer implements the Blockscout API. */
export const BLOCKSCOUT_VERIFICATION_CHAIN_IDS = new Set([8822, 34443, 2632500])

export function verificationProviderForChain(chainId: number | bigint): VerificationProviderName {
	return BLOCKSCOUT_VERIFICATION_CHAIN_IDS.has(Number(chainId)) ? "blockscout" : "etherscan"
}

/** Resolve a unique deployment artifact name to the exact FQN required by Hardhat verify. */
export async function resolveVerificationContractName(
	artifacts: VerificationArtifactManager,
	contractNameOrFullyQualifiedName: string,
): Promise<string> {
	if (contractNameOrFullyQualifiedName.includes(":")) return contractNameOrFullyQualifiedName
	const artifact = await artifacts.readArtifact(contractNameOrFullyQualifiedName)
	if (!artifact.sourceName || !artifact.contractName) {
		throw new Error(`Compiled artifact ${contractNameOrFullyQualifiedName} is missing its source or contract name`)
	}
	return `${artifact.sourceName}:${artifact.contractName}`
}
