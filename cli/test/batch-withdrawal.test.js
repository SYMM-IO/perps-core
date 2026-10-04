import { batchSummary, validateBatchInput, unresolvedBatchOperations } from "../../deployment-tooling/batch-withdrawal.js";
import { batchHarness } from "./fixtures/batch-withdrawal.js";
import assert from "node:assert/strict";
import test from "node:test";

test("batch isolates locked accounts, queues cooldowns, processes free balance and resumes without duplicate deallocation", async () => {
	const h = batchHarness(),
		[allocated, free, pending, blocked] = h.addresses;
	h.states.get(allocated).allocated = 10n ** 19n;
	h.states.get(free).free = 3n * 10n ** 18n;
	h.request(pending, 5_000_000n);
	h.states.get(blocked).allocated = 10n ** 18n;
	h.states.get(blocked).blockDeallocate = true;
	for (const account of h.addresses) await h.run(account, "inspect");
	h.approve();
	for (const account of h.addresses) {
		try {
			await h.run(account, "process", true);
		} catch {}
	}
	assert.equal(h.row(allocated).status, "waiting_cooldown");
	assert.equal(h.row(free).status, "completed");
	assert.equal(h.row(pending).status, "waiting_cooldown");
	assert.match(batchSummary(h.report), /Existing request 1 \| waiting_cooldown/);
	assert.match(batchSummary(h.report), /New request 1 \| waiting_cooldown/);
	assert.equal(h.row(blocked).status, "needs_investigation");
	assert.equal(h.stats().sends, 4);
	h.advance();
	for (const account of [allocated, pending]) await h.run(account, "recheck");
	assert.equal(h.row(allocated).status, "ready");
	assert.equal(h.row(pending).status, "ready");
	const fetches = h.stats().fetches;
	for (const account of [allocated, pending]) await h.run(account, "withdraw-ready", true);
	assert.equal(h.stats().fetches, fetches);
	assert.equal(h.stats().sends, 6);
	assert.equal(h.row(allocated).status, "completed");
	assert(h.row(pending).requests[1].proof.eventsVerified);
	await h.run(allocated, "process", true);
	await h.run(pending, "withdraw-ready", true);
	assert.equal(h.stats().sends, 6);
});
test("an existing ready request is finalized once without creating another request for its locked funds", async () => {
	const h = batchHarness({ count: 1 }),
		account = h.addresses[0];
	h.request(account, 7_000_000n, { ready: true });
	await h.run(account, "inspect");
	h.approve();
	assert.equal(h.row(account).status, "ready");
	await h.run(account, "process", true);
	assert.equal(h.stats().sends, 1);
	assert.equal(h.stats().fetches, 0);
	assert.equal(h.states.get(account).requests.size, 1);
	assert.equal(h.row(account).status, "completed");
});
test("common recipients verify classic events against the account and token transfers against the recipient", async () => {
	const h = batchHarness({ count: 1, recipientMode: "common" }),
		account = h.addresses[0];
	h.states.get(account).free = 10n ** 18n;
	await h.run(account, "inspect");
	h.approve();
	await h.run(account, "process", true);
	assert.equal(h.row(account).status, "completed");
	assert.equal(h.stats().sends, 2);
});
test("unknown outcomes never resend and timed-out known hashes reconcile before resuming", async () => {
	for (const unknown of [false, true]) {
		const h = batchHarness({ count: 1 }),
			account = h.addresses[0];
		h.states.get(account).allocated = 10n ** 18n;
		await h.run(account, "inspect");
		h.approve();
		h.timeout(!unknown);
		h.unknown(unknown);
		await assert.rejects(h.run(account, "process", true));
		assert.equal(unresolvedBatchOperations(h.report).length, 1);
		h.timeout(false);
		h.unknown(false);
		if (unknown) {
			await assert.rejects(h.run(account, "process", true), /no automatic resend/);
			assert.equal(h.stats().sends, 0);
		} else {
			await h.run(account, "process", true);
			assert.equal(h.stats().sends, 2);
			assert.equal(h.stats().fetches, 1);
		}
	}
});
test("read-only recheck never fetches signatures, adopts completed requests as external settlements, and ignores new earnings", async () => {
	const h = batchHarness({ count: 1 }),
		account = h.addresses[0];
	const r = h.request(account, 2_000_000n);
	await h.run(account, "inspect");
	r.status = 3;
	await h.run(account, "recheck");
	assert.equal(h.row(account).requests[1].status, "completed_elsewhere");
	assert.equal(h.stats().sends, 0);
	assert.equal(h.stats().fetches, 0);
	assert.match(batchSummary(h.report), /withdrawn 0\.0/);
	h.states.get(account).free = 10n ** 18n;
	await assert.rejects(h.run(account, "recheck"), /balances changed/);
});
test("mismatched recipients and wrong token transfer evidence stop that account", async () => {
	const h = batchHarness({ count: 2 }),
		[account, other] = h.addresses;
	h.request(account, 1_000_000n, { ready: true, receiver: other });
	await h.run(account, "inspect");
	await h.run(other, "inspect");
	h.approve();
	await h.run(account, "process", true);
	assert.equal(h.row(account).status, "needs_investigation");
	assert.equal(h.stats().sends, 0);
	const b = batchHarness({ count: 1 }),
		owner = b.addresses[0];
	b.request(owner, 1_000_000n, { ready: true });
	await b.run(owner, "inspect");
	b.approve();
	b.badTransfer();
	await assert.rejects(b.run(owner, "process", true), /collateral transfer/);
	assert.equal(b.row(owner).status, "needs_investigation");
	assert.equal(b.row(owner).requests[1].proof, undefined);
});
test("legacy free funds wait locally and withdraw after cooldown without a classic request", async () => {
	const h = batchHarness({ count: 1, classic: false }),
		account = h.addresses[0];
	h.states.get(account).free = 10n ** 18n;
	h.states.get(account).last = 1000;
	await h.run(account, "inspect");
	h.approve();
	await h.run(account, "process", true);
	assert.equal(h.row(account).status, "waiting_cooldown");
	assert.equal(h.stats().sends, 0);
	h.advance();
	await h.run(account, "withdraw-ready", true);
	assert.equal(h.stats().sends, 1);
	assert.equal(h.states.get(account).requests.size, 0);
});
test("batch input rejects duplicates, raw credentials and unapproved mutations", async () => {
	const h = batchHarness({ count: 1 }),
		account = h.addresses[0];
	assert.throws(() => validateBatchInput({ ...h.input, privateKey: "secret" }), /public configuration/);
	assert.throws(() => validateBatchInput({ ...h.input, accounts: [account, account] }), /duplicate/);
	h.states.get(account).free = 10n ** 18n;
	await h.run(account, "inspect");
	await assert.rejects(h.run(account, "process", true), /not been approved/);
	assert.equal(h.stats().sends, 0);
});
test("a supplied deallocation hash recovers a lost broadcast response without resending", async () => {
	const h = batchHarness({ count: 1 }),
		account = h.addresses[0];
	h.states.get(account).allocated = 10n ** 18n;
	await h.run(account, "inspect");
	h.approve();
	h.timeout(true);
	await assert.rejects(h.run(account, "process", true));
	const operation = h.row(account).fresh.operations.deallocate,
		hash = operation.hash;
	delete operation.hash;
	operation.status = "prepared";
	h.timeout(false);
	await h.run(account, "reconcile", false, { transaction: hash, transactionPhase: "deallocate" });
	await h.run(account, "process", true);
	assert.equal(h.stats().sends, 2);
	assert.equal(h.stats().fetches, 1);
	assert.equal(h.row(account).status, "waiting_cooldown");
});
test("new requests created outside the reviewed batch require investigation even if free balances are unchanged", async () => {
	const h = batchHarness({ count: 1 }),
		account = h.addresses[0];
	await h.run(account, "inspect");
	h.request(account, 1_000_000n, { ready: true });
	h.approve();
	await assert.rejects(h.run(account, "process", true), /history changed outside this batch/);
	assert.equal(h.row(account).status, "needs_investigation");
	assert.equal(h.stats().sends, 0);
});
