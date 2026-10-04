import { waitForCanonicalReceipt } from "./transaction-receipt.js";
import { createHash } from "node:crypto";

const json = value => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const digest = value => createHash("sha256").update(json(value)).digest("hex");
const sameAddress = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const check = (condition, message) => {
	if (!condition) throw new Error(message);
};

// An uncertain send is never retried. Reconciliation needs the original/replacement hash
// and proves the entire transaction intent, nonce, receipt and canonical block.
export async function submitOperation({
	provider,
	signer,
	plan,
	action,
	report,
	save,
	completeRequest,
	beforeSubmit,
	send,
	suppliedHash,
	label = "operation",
	receiptAttempts = 31,
	receiptIntervalMs = 1000,
	onProgress = () => {},
}) {
	check(Number.isInteger(receiptAttempts) && receiptAttempts >= 1 && receiptAttempts <= 31, "Invalid receipt polling attempts");
	check(Number.isInteger(receiptIntervalMs) && receiptIntervalMs >= 0 && receiptIntervalMs <= 1000, "Invalid receipt polling interval");
	const from = plan.input.operator,
		intent = { from, to: action.to, data: action.data, value: action.value, chainId: plan.input.chainId };
	report.operations ||= {};
	let operation = report.operations[action.phase];
	if (operation) check(digest(operation.intent) === digest(intent), "Saved transaction intent changed");
	else {
		check(signer && sameAddress(await signer.getAddress(), from), "Connected signer differs from the reviewed operator");
		const request = await completeRequest(provider, { from, to: action.to, data: action.data, value: BigInt(action.value) });
		const nonce = await provider.getTransactionCount(from, "pending");
		// Expiring prerequisites may be refreshed only before the write-ahead intent exists.
		// Recovery of an existing intent always bypasses this hook and never signs again.
		await beforeSubmit?.();
		operation = report.operations[action.phase] = { intent, nonce, status: "prepared" };
		save();
		let response;
		try {
			response = await signer.sendTransaction({ ...request, nonce: operation.nonce, chainId: plan.input.chainId });
		} catch (error) {
			// An explicit device rejection did not submit. Other errors retain the intent.
			if (error.code === "ACTION_REJECTED") {
				delete report.operations[action.phase];
				save();
			}
			throw error;
		}
		operation.hash = response.hash;
		operation.status = "submitted";
		save();
		let receipt;
		try {
			receipt = await send(Promise.resolve(response), `${label} ${action.phase}`, 1, {
				onSubmitted: record => {
					operation.journal = record;
					save();
				},
			});
		} catch (error) {
			save();
			throw error;
		}
		operation.hash = receipt.hash;
		save();
	}
	const hash = suppliedHash || operation.hash;
	check(
		/^0x[0-9a-fA-F]{64}$/.test(hash || ""),
		`Interrupted ${action.phase} at nonce ${operation.nonce}: provide the original or replacement transaction hash; no automatic resend`,
	);
	const receipt = await waitForCanonicalReceipt({
		provider,
		hash,
		receiptAttempts,
		receiptIntervalMs,
		onProgress,
		label: `${label} ${action.phase}`,
		validateTransaction: tx =>
			check(
				sameAddress(tx.from, from) &&
					sameAddress(tx.to, intent.to) &&
					tx.data.toLowerCase() === intent.data.toLowerCase() &&
					BigInt(tx.value) === BigInt(intent.value) &&
					tx.nonce === operation.nonce &&
					Number(tx.chainId) === intent.chainId,
				"Reconciliation transaction does not match the reviewed intent and nonce",
			),
		onObservation: observation => {
			operation.confirmation = observation;
			save();
		},
	});
	Object.assign(operation, { hash, status: "confirmed", blockNumber: receipt.blockNumber, blockHash: receipt.blockHash });
	if (operation.journal) {
		operation.journal.status = "confirmed";
		operation.journal.replacementHash = hash === operation.journal.hash ? undefined : hash;
	}
	save();
	return receipt;
}
