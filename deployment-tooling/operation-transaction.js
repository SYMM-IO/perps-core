import { createHash } from "node:crypto";

const json = value => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const digest = value => createHash("sha256").update(json(value)).digest("hex");
const sameAddress = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const check = (condition, message) => {
	if (!condition) throw new Error(message);
};

// An uncertain send is never retried. Reconciliation needs the original/replacement hash
// and proves the entire transaction intent, nonce, receipt and canonical block.
export async function submitOperation({ provider, signer, plan, action, report, save, completeRequest, send, suppliedHash, label = "operation" }) {
	const from = plan.input.operator,
		intent = { from, to: action.to, data: action.data, value: action.value, chainId: plan.input.chainId };
	report.operations ||= {};
	let operation = report.operations[action.phase];
	if (operation) check(digest(operation.intent) === digest(intent), "Saved transaction intent changed");
	else {
		check(signer && sameAddress(await signer.getAddress(), from), "Connected signer differs from the reviewed operator");
		const request = await completeRequest(provider, { from, to: action.to, data: action.data, value: BigInt(action.value) });
		operation = report.operations[action.phase] = { intent, nonce: await provider.getTransactionCount(from, "pending"), status: "prepared" };
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
		const receipt = await send(Promise.resolve(response), `${label} ${action.phase}`, 1, {
			onSubmitted: record => {
				operation.journal = record;
				save();
			},
		});
		operation.hash = receipt.hash;
		save();
	}
	const hash = suppliedHash || operation.hash;
	check(
		/^0x[0-9a-fA-F]{64}$/.test(hash || ""),
		`Interrupted ${action.phase} at nonce ${operation.nonce}: provide the original or replacement transaction hash; no automatic resend`,
	);
	const [tx, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
	check(
		tx &&
			sameAddress(tx.from, from) &&
			sameAddress(tx.to, intent.to) &&
			tx.data.toLowerCase() === intent.data.toLowerCase() &&
			BigInt(tx.value) === BigInt(intent.value) &&
			tx.nonce === operation.nonce &&
			Number(tx.chainId) === intent.chainId,
		"Reconciliation transaction does not match the reviewed intent and nonce",
	);
	check(receipt && Number(receipt.status) === 1, "Transaction is pending, missing or reverted; resolve it before continuing");
	check((await provider.getBlock(receipt.blockNumber))?.hash === receipt.blockHash, "Receipt is not on the canonical chain");
	Object.assign(operation, { hash, status: "confirmed", blockNumber: receipt.blockNumber, blockHash: receipt.blockHash });
	if (operation.journal) {
		operation.journal.status = "confirmed";
		operation.journal.replacementHash = hash === operation.journal.hash ? undefined : hash;
	}
	save();
	return receipt;
}
