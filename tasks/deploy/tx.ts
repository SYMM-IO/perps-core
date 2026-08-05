import type { ContractTransactionReceipt, ContractTransactionResponse } from "ethers"

// Awaiting a contract call in ethers v6 resolves as soon as the transaction is
// BROADCAST, not when it is mined. deploy:system wraps its setup calls in
// checkpointedStep(), which marks a step complete the moment its action resolves — so
// without an explicit wait(), a dropped or reverted transaction is recorded as done and
// then skipped on resume, with no error anywhere.
//
// send() closes that gap and doubles as the deploy path's transaction log: every
// privileged call gets its hash and gas usage printed, which is the difference between
// a debuggable mainnet failure and a silent one.

/** Confirmations to wait for. Raise on chains where reorgs are a real concern. */
export const DEFAULT_CONFIRMATIONS = Math.max(1, Number(process.env.DEPLOY_CONFIRMATIONS || 1))

/**
 * Send a contract transaction, wait for it to be mined, and fail loudly if it did not
 * succeed. Returns the receipt so callers can read logs or gas.
 *
 * @param txPromise   the un-awaited contract call, e.g. `controlFacet.setAdmin(addr)`
 * @param label       human-readable name used in logs and error messages
 * @param confirmations blocks to wait for (defaults to DEPLOY_CONFIRMATIONS or 1)
 */
export async function send(
	txPromise: Promise<ContractTransactionResponse>,
	label: string,
	confirmations: number = DEFAULT_CONFIRMATIONS,
): Promise<ContractTransactionReceipt> {
	const tx = await txPromise
	const receipt = await tx.wait(confirmations)

	if (!receipt) {
		throw new Error(`${label}: transaction ${tx.hash} was dropped or replaced before ${confirmations} confirmation(s)`)
	}
	if (receipt.status !== 1) {
		throw new Error(`${label}: transaction ${tx.hash} reverted in block ${receipt.blockNumber}`)
	}

	console.log(`    ✓ ${label} — ${tx.hash} (gas ${receipt.gasUsed.toString()})`)
	return receipt
}
