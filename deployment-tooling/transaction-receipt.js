const check = (condition, message) => {
	if (!condition) throw new Error(message);
};
const validHash = value => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0{64}$/.test(value);

/** Read-only receipt verification shared by new sends and persisted-hash recovery. */
export async function waitForCanonicalReceipt({
	provider,
	hash,
	confirmations = 1,
	receiptAttempts = 31,
	receiptIntervalMs = 1000,
	receiptTimeoutMs = 30000,
	validateTransaction,
	onObservation = () => {},
	onProgress = () => {},
	label = "transaction",
}) {
	check(Number.isInteger(receiptAttempts) && receiptAttempts >= 1 && receiptAttempts <= 31, "Invalid receipt polling attempts");
	check(Number.isInteger(receiptIntervalMs) && receiptIntervalMs >= 0 && receiptIntervalMs <= 1000, "Invalid receipt polling interval");
	check(Number.isInteger(receiptTimeoutMs) && receiptTimeoutMs >= 1 && receiptTimeoutMs <= 30000, "Invalid receipt polling timeout");
	check(Number.isInteger(confirmations) && confirmations >= 1, "Invalid required confirmations");
	check(validHash(hash), "Invalid transaction hash for receipt verification");
	check(
		provider && typeof provider.getTransactionReceipt === "function" && typeof provider.getBlock === "function",
		"Receipt verification requires a provider with receipt and block reads",
	);
	const deadline = Date.now() + receiptTimeoutMs;
	let observation = {
		hash,
		attempt: 0,
		maxAttempts: receiptAttempts,
		transactionFound: null,
		receiptStatus: null,
		blockNumber: null,
		receiptBlockHash: null,
		canonicalBlockHash: null,
		confirmations: 0,
		requiredConfirmations: confirmations,
	};
	const timeout = async () => {
		await onObservation(observation);
		throw Object.assign(
			new Error(
				`Canonical receipt verification timed out for ${hash}: block ${observation.blockNumber ?? "unavailable"}, receipt hash ${observation.receiptBlockHash ?? "unavailable"}, canonical hash ${observation.canonicalBlockHash ?? "unavailable"}, confirmations ${observation.confirmations}/${confirmations}. Resume this same operation to reconcile; no automatic resend.`,
			),
			{ code: "CANONICAL_RECEIPT_TIMEOUT", observation },
		);
	};
	const readBeforeDeadline = async promise => {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return timeout();
		let timer;
		try {
			return await Promise.race([
				promise,
				new Promise((_, reject) => {
					timer = setTimeout(() => timeout().catch(reject), remaining);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	};
	for (let attempt = 1; attempt <= receiptAttempts; attempt++) {
		// Read the receipt again on every pass. Sealing or reorgs can change its block/hash/logs.
		observation = { ...observation, attempt };
		const [receipt, tx] = await readBeforeDeadline(
			Promise.all([provider.getTransactionReceipt(hash), validateTransaction ? provider.getTransaction(hash) : Promise.resolve(undefined)]),
		);
		if (tx && validateTransaction) await validateTransaction(tx);
		check(!receipt || receipt.hash?.toLowerCase() === hash.toLowerCase(), "Receipt hash does not match the requested transaction");
		observation = {
			...observation,
			receiptStatus: receipt?.status == null ? null : Number(receipt.status),
			blockNumber: receipt?.blockNumber ?? null,
			receiptBlockHash: receipt?.blockHash ?? null,
		};
		const block =
			receipt && Number(receipt.status) === 1 && Number.isSafeInteger(receipt.blockNumber)
				? await readBeforeDeadline(provider.getBlock(receipt.blockNumber))
				: null;
		const depth =
			block && confirmations > 1 ? Math.max(0, (await readBeforeDeadline(provider.getBlockNumber())) - receipt.blockNumber + 1) : block ? 1 : 0;
		observation = {
			hash,
			attempt,
			maxAttempts: receiptAttempts,
			transactionFound: validateTransaction ? Boolean(tx) : null,
			receiptStatus: receipt?.status == null ? null : Number(receipt.status),
			blockNumber: receipt?.blockNumber ?? null,
			receiptBlockHash: receipt?.blockHash ?? null,
			canonicalBlockHash: block?.hash ?? null,
			confirmations: depth,
			requiredConfirmations: confirmations,
		};
		await onObservation(observation);
		if (receipt && Number(receipt.status) === 0) {
			throw Object.assign(new Error(`Transaction ${hash} reverted; resolve it before continuing`), {
				code: "CALL_EXCEPTION",
				receipt,
				observation,
			});
		}
		if (
			(!validateTransaction || tx) &&
			receipt &&
			Number(receipt.status) === 1 &&
			validHash(receipt.blockHash) &&
			validHash(block?.hash) &&
			block.hash.toLowerCase() === receipt.blockHash.toLowerCase() &&
			depth >= confirmations
		)
			return receipt;
		if (attempt === receiptAttempts) return timeout();
		if (attempt === 1 || attempt % 5 === 0)
			onProgress(`Waiting for a sealed canonical receipt for ${label} (${hash}); check ${attempt}/${receiptAttempts}.`);
		await new Promise(resolve => setTimeout(resolve, Math.min(receiptIntervalMs, Math.max(0, deadline - Date.now()))));
	}
}
