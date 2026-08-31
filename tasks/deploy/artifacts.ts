/**
 * Build a deployment-only artifact without parsing callable ABI fragments.
 *
 * Solidity 0.8.36 can emit named enum/struct types for public library ABI
 * entries that Ethers 6 cannot parse. A deployment factory only needs bytecode
 * and link references here: the affected libraries have no constructor args.
 * Keeping the compiler artifact intact preserves verification and selectors.
 */
export function deploymentOnlyArtifact<T extends { readonly abi: readonly unknown[] }>(artifact: T): T {
	const constructor = artifact.abi.find((entry: any) => entry?.type === "constructor") as { inputs?: unknown[] } | undefined
	if (constructor?.inputs?.length) {
		throw new Error("deploymentOnlyArtifact is only safe for contracts without constructor arguments")
	}
	return { ...artifact, abi: [] } as T
}
