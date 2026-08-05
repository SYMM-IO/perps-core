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
 * How long to wait for a single transaction before giving up, in seconds.
 *
 * Without a bound, `tx.wait()` waits forever: a dropped transaction, an under-priced one on
 * a congested chain, or an RPC that quietly stops responding all leave the deploy hanging
 * with no output. Failing loudly is better — the deployment is checkpointed, so re-running
 * resumes from the same step.
 *
 * The default is generous because block times vary enormously (Arbitrum ~0.25s, Ethereum
 * ~12s, some L2s far slower under load). Raise it on a slow or congested chain.
 */
export const TX_TIMEOUT_SECONDS = Math.max(30, Number(process.env.DEPLOY_TX_TIMEOUT || 300))

/** Log a still-waiting notice if a transaction takes longer than this, in seconds. */
const SLOW_TX_NOTICE_SECONDS = Math.max(10, Number(process.env.DEPLOY_SLOW_TX_NOTICE || 30))

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
	const startedAt = Date.now()

	// On a slow or congested chain a single wait can take minutes. Say something, so the
	// operator can tell "still mining" apart from "hung", and include the hash so they can
	// follow it on an explorer while they wait.
	const notice = setTimeout(() => {
		console.log(`      … still waiting on ${label} (${tx.hash}) after ${SLOW_TX_NOTICE_SECONDS}s`)
	}, SLOW_TX_NOTICE_SECONDS * 1000)

	let receipt: ContractTransactionReceipt | null
	try {
		receipt = await withTimeout(tx.wait(confirmations), TX_TIMEOUT_SECONDS, label, tx.hash)
	} finally {
		clearTimeout(notice)
	}

	if (!receipt) {
		throw new Error(`${label}: transaction ${tx.hash} was dropped or replaced before ${confirmations} confirmation(s)`)
	}
	if (receipt.status !== 1) {
		throw new Error(`${label}: transaction ${tx.hash} reverted in block ${receipt.blockNumber}`)
	}

	const seconds = (Date.now() - startedAt) / 1000
	const timing = seconds >= 5 ? ` in ${seconds.toFixed(1)}s` : ""
	console.log(`    ✓ ${label} — ${tx.hash} (gas ${receipt.gasUsed.toString()})${timing}`)
	return receipt
}

function withTimeout<T>(promise: Promise<T>, seconds: number, label: string, hash: string): Promise<T> {
	let timer: NodeJS.Timeout
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new Error(
						`${label}: transaction ${hash} was not mined within ${seconds}s. ` +
							`It may still land — check the explorer before re-running. ` +
							`The deployment is checkpointed, so re-running resumes from this step. ` +
							`Raise DEPLOY_TX_TIMEOUT if the chain is simply slow.`,
					),
				),
			seconds * 1000,
		)
	})
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}
