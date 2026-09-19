import {
	POLICY,
	ROLE,
	buildPlan,
	digest,
	submitOperation,
	validateInput,
	validateStage,
	verifyOperationEvents,
	verifyPlan,
} from "../../deployment-tooling/disputed-settlement.js";
import { settlementFixture } from "./fixtures/disputed-settlement.js";
import { Interface, ZeroAddress, formatUnits } from "ethers";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const iface = new Interface(JSON.parse(fs.readFileSync(new URL("../../abis/symmio.json", import.meta.url))));
const address = n => `0x${n.toString(16).padStart(40, "0")}`;

const clone = x => structuredClone(x);
const log = (name, args, core) => ({ address: core, ...iface.encodeEventLog(iface.getEvent(name), args) });

test("input-file rules reproduce the disputed case with exact 18-decimal conservation", () => {
	const f = settlementFixture(),
		plan = f.plan();
	assert.equal(plan.solverTotal, "3442572744357476090");
	assert.equal(plan.residual, "579974554669831643");
	assert.equal(plan.liquidatorFee, "0");
	assert.deepEqual(
		plan.actions.map(a => a.phase),
		["grant", "takeover", "payment", "finalize", "cleanup"],
	);
	const rows = iface.decodeFunctionData("applyClearingHouseSettlement", plan.actions[2].data)[1];
	for (let c = 3; c <= 5; c++)
		assert.equal(
			rows.reduce((n, r) => n + r[c], 0n),
			0n,
		);
	assert.equal(plan.totals[0].recorded.funding, "53876144664567485");
	verifyPlan(plan, f.input);
});
const caseShares = () => JSON.parse(fs.readFileSync(new URL("../../tasks/config/disputed-settlement.arbitrum-652b2e.json", import.meta.url))).shares;

test("filled case records the exact solver components and zero liquidator amount alongside percentages", () => {
	const f = settlementFixture();
	f.input.shares = caseShares();
	const p = f.plan();
	assert.deepEqual(p.solverAmounts, { pnl: "2493108170448664277", funding: "53876144664567485", cva: "895588429244244328" });
	assert.equal(p.liquidatorFee, "0");
	for (const component of ["pnl", "funding", "cva"])
		assert.equal(formatUnits(p.solverAmounts[component], 18), f.input.shares.solver.expectedAmounts[component]);
});

test("a one-unit component mismatch or stale expected amount stops plan creation", () => {
	for (const component of ["pnl", "funding", "cva"]) {
		const f = settlementFixture();
		f.input.shares = caseShares();
		const raw = f.plan().solverAmounts[component];
		f.input.shares.solver.expectedAmounts[component] = formatUnits(BigInt(raw) + 1n, 18);
		assert.throws(f.plan, new RegExp(`Solver ${component} calculates to`));
	}
	const f = settlementFixture();
	f.input.shares = caseShares();
	f.input.shares.solver.cvaBps = 5000;
	assert.throws(f.plan, /Solver cva calculates to/);
});

test("liquidator amount validates the percentage result rather than overriding it", () => {
	const f = settlementFixture();
	f.input.shares = caseShares();
	f.input.shares.liquidator.expectedAmount = "0.000000000000000001";
	assert.throws(f.plan, /Liquidator share calculates to 0.0/);
	f.input.shares.liquidator.shareBps = 2500;
	f.input.shares.liquidator.expectedAmount = "0.144993638667457910";
	f.snapshot.feeRecipient = { address: f.input.shares.liquidator.recipient, registeredB: false, liquidated: false };
	assert.equal(f.plan().liquidatorFee, "144993638667457910");
});

test("expected amounts require exact decimal strings with all three solver components", () => {
	for (const invalid of [2.49, "1e-3", "0.0000000000000000001", "", null, "NaN", " 1", "01.2"]) {
		const f = settlementFixture();
		f.input.shares = caseShares();
		f.input.shares.solver.expectedAmounts.pnl = invalid;
		assert.throws(() => validateInput(f.input), /decimal string/);
	}
	for (const mutate of [
		f => delete f.input.shares.solver.expectedAmounts.funding,
		f => (f.input.shares.solver.expectedAmounts = null),
		f => (f.input.shares.solver.expectedAmounts.cva = "-1"),
		f => (f.input.shares.liquidator.expectedAmount = "-1"),
		f => (f.input.shares.liquidator.expectedAmount = 0),
	]) {
		const f = settlementFixture();
		f.input.shares = caseShares();
		mutate(f);
		assert.throws(() => validateInput(f.input));
	}
});

test("expected solver amounts check the sum after per-market percentage rounding", () => {
	const f = settlementFixture();
	f.snapshot.logs[1].symbolId = "2";
	f.snapshot.quotes[1].symbolId = "2";
	f.input.shares.solver = { pnlBps: 3333, fundingBps: 3333, cvaBps: 3333 };
	const calculated = f.plan();
	f.input.shares.solver.expectedAmounts = Object.fromEntries(
		Object.entries(calculated.solverAmounts).map(([key, raw]) => [key, formatUnits(raw, 18)]),
	);
	assert.equal(f.plan().solverTotal, calculated.solverTotal);
});
test("shares are calculated from the file, including fee recipients and raw-unit rounding", () => {
	const f = settlementFixture();
	f.input.shares.solver.cvaBps = 5000;
	f.input.shares.liquidator.shareBps = 2500;
	f.snapshot.feeRecipient = { address: f.input.operator, allocated: "0", registeredB: false, liquidated: false };
	const plan = f.plan();
	assert.equal(plan.totals[0].cva, "447794214622122164");
	assert.equal(plan.liquidatorFee, ((BigInt(f.snapshot.allocated) - BigInt(plan.solverTotal)) / 4n).toString());
	assert.equal(BigInt(plan.solverTotal) + BigInt(plan.liquidatorFee) + BigInt(plan.residual), BigInt(f.snapshot.allocated));
	const rows = plan.actions.find(a => a.phase === "payment").args[1];
	assert(rows.some(r => r[0] === f.input.operator && r[1] === ZeroAddress && r[2] === "0" && r[5] === plan.liquidatorFee));
});
test("the exact recorded liquidation fee exceeding available funds by rounding is refused", () => {
	const f = settlementFixture();
	f.input.shares.liquidator = { basis: "recordedLiquidationFee", shareBps: 10000, recipient: f.input.operator };
	f.snapshot.feeRecipient = { address: f.input.operator, registeredB: false, liquidated: false };
	assert.throws(f.plan, /liquidator share exceeds/);
});
test("full remainder fee sends every leftover raw unit to the declared fee recipient", () => {
	const f = settlementFixture();
	f.input.shares.liquidator.shareBps = 10000;
	f.snapshot.feeRecipient = { address: f.input.operator, registeredB: false, liquidated: false };
	const p = f.plan();
	assert.equal(p.residual, "0");
	assert.equal(p.liquidatorFee, "579974554669831643");
});
test("an existing clearing-house role is preserved, without a grant or revocation", () => {
	const f = settlementFixture();
	f.snapshot.role = true;
	assert.deepEqual(
		f.plan().actions.map(a => a.phase),
		["takeover", "payment", "finalize"],
	);
});
test("an explicitly all-zero share file omits the empty payment and returns all collateral", () => {
	const f = settlementFixture();
	f.input.shares.solver = { pnlBps: 0, fundingBps: 0, cvaBps: 0 };
	const p = f.plan();
	assert.equal(p.total, "0");
	assert.equal(p.residual, f.snapshot.allocated);
	assert(!p.actions.some(a => a.phase === "payment"));
});
test("input requires explicit share rules and rejects malformed percentages and recipients", () => {
	for (const mutate of [
		f => delete f.input.shares,
		f => (f.input.shares.solver.pnlBps = 10001),
		f => (f.input.shares.solver.cvaBps = 0.1),
		f => (f.input.shares.liquidator.basis = "balance"),
		f => {
			f.input.shares.liquidator.shareBps = 1;
			f.input.shares.liquidator.recipient = ZeroAddress;
		},
	]) {
		const f = settlementFixture();
		mutate(f);
		assert.throws(() => validateInput(f.input));
	}
});
test("unsupported or incomplete account evidence cannot produce an executable plan", () => {
	for (const mutate of [
		f => (f.snapshot.admin = false),
		f => (f.snapshot.detail.liquidationType = "2"),
		f => (f.snapshot.detail.disputed = false),
		f => (f.snapshot.takeover.inProgress = true),
		f => (f.snapshot.pending = "1"),
		f => (f.snapshot.open = "1"),
		f => (f.snapshot.reimbursement = "1"),
		f => (f.snapshot.allocated = "1"),
		f => (f.snapshot.parties[0].cross = true),
		f => (f.snapshot.parties[0].registered = false),
		f => (f.snapshot.parties[0].settlement.pending = false),
		f => (f.snapshot.parties[0].settlement.actualAmount = "1"),
		f => f.snapshot.logs.pop(),
		f => f.snapshot.logs.push(clone(f.snapshot.logs[0])),
		f => (f.snapshot.quotes[0].partyA = address(500)),
		f => (f.snapshot.quotes[0].lockedValues[0] = "1"),
		f => (f.snapshot.logs[0].rawFunding = "0"),
	]) {
		const f = settlementFixture();
		mutate(f);
		assert.throws(f.plan);
	}
});
test("multi-market rows are grouped and sorted, with independently calculated shares", () => {
	const f = settlementFixture();
	f.snapshot.logs[1].symbolId = "2";
	f.snapshot.quotes[1].symbolId = "2";
	const p = f.plan(),
		rows = p.actions.find(a => a.phase === "payment").args[1];
	assert.equal(rows.length, 4);
	assert.equal(p.solverTotal, "3442572744357476090");
	assert(rows.every((r, i) => !i || BigInt(rows[i - 1][0]) <= BigInt(r[0])));
});
test("plan editing and share-file drift invalidate approval", () => {
	const f = settlementFixture(),
		p = f.plan();
	p.residual = "1";
	assert.throws(() => verifyPlan(p, f.input), /changed/);
	const original = f.plan();
	f.input.shares.solver.cvaBps = 0;
	assert.throws(() => verifyPlan(original, f.input), /changed/);
});
test("resume requires matching confirmed phases and detects a foreign takeover or payment", () => {
	const f = settlementFixture(),
		plan = f.plan(),
		s = clone(f.snapshot);
	validateStage(plan, s, []);
	s.role = true;
	validateStage(plan, s, ["grant"]);
	assert.throws(() => validateStage(plan, s, []), /role changed/);
	s.takeover.inProgress = true;
	s.takeover.liquidationId = plan.liquidationId;
	s.detail.disputed = false;
	s.detail.liquidationFee = "0";
	validateStage(plan, s, ["grant", "takeover"]);
	assert.throws(() => validateStage(plan, s, ["grant"]), /Liquidation\/takeover/);
	s.allocated = plan.residual;
	validateStage(plan, s, ["grant", "takeover", "payment"]);
	assert.throws(() => validateStage(plan, s, ["grant", "takeover"]), /allocation/);
	s.fingerprints.payment = "upgrade";
	assert.throws(() => validateStage(plan, s, ["grant", "takeover", "payment"]), /code/);
});
test("payment receipts must carry exact typed components and per-account totals", () => {
	const f = settlementFixture(),
		plan = f.plan(),
		action = plan.actions.find(a => a.phase === "payment");
	const components = action.args[1].map(r =>
		log("ClearingHouseSettlementComponent", [f.input.partyA, r[0], r[2], r[1], r[3], r[4], r[5]], f.input.core),
	);
	const totals = action.args[1].map(r =>
		log("ClearingHouseAccountSettlement", [f.input.partyA, r[0], r[1], BigInt(r[3]) + BigInt(r[4]) + BigInt(r[5])], f.input.core),
	);
	const receipt = { status: 1, logs: [...components, ...totals] };
	verifyOperationEvents(plan, action, receipt, iface);
	assert.throws(() => verifyOperationEvents(plan, action, { ...receipt, logs: components }, iface), /account settlement/);
	assert.throws(() => verifyOperationEvents(plan, action, { ...receipt, logs: [...components.slice(1), ...totals] }, iface), /components/);
	assert.throws(() => verifyOperationEvents(plan, action, { ...receipt, status: 0 }, iface), /reverted/);
});

function transactionFixture() {
	const f = settlementFixture(),
		plan = f.plan(),
		action = plan.actions[0],
		hash = `0x${"ab".repeat(32)}`,
		blockHash = `0x${"cd".repeat(32)}`;
	let sends = 0,
		saves = 0;
	const report = {};
	const tx = { from: plan.input.operator, to: action.to, data: action.data, value: 0n, nonce: 7, chainId: 42161n };
	const receipt = { hash, status: 1, blockNumber: 1010, blockHash };
	const provider = {
		getTransactionCount: async () => 7,
		getTransaction: async () => tx,
		getTransactionReceipt: async () => receipt,
		getBlock: async () => ({ hash: blockHash }),
	};
	const args = {
		provider,
		plan,
		action,
		report,
		save: () => saves++,
		signer: {
			getAddress: async () => plan.input.operator,
			sendTransaction: async request => {
				assert(saves > 0);
				assert.equal(report.operations.grant.status, "prepared");
				assert.equal(request.gasLimit, 120000n);
				assert.equal(request.maxFeePerGas, 2n);
				sends++;
				return { hash };
			},
		},
		completeRequest: async (_p, r) => ({ ...r, gasLimit: 120000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
		send: async () => receipt,
	};
	return { args, receipt, tx, hash, report, sends: () => sends };
}
test("journal persists before signing and a confirmed rerun never resends", async () => {
	const f = transactionFixture();
	await submitOperation(f.args);
	assert.equal(f.sends(), 1);
	assert.equal(f.report.operations.grant.status, "confirmed");
	await submitOperation({ ...f.args, signer: undefined });
	assert.equal(f.sends(), 1);
});
test("ambiguous send without a hash stays blocked; explicit Ledger rejection permits a fresh attempt", async () => {
	for (const code of ["NETWORK_ERROR", "ACTION_REJECTED"]) {
		const f = transactionFixture();
		f.args.signer.sendTransaction = async () => {
			throw Object.assign(new Error("send error"), { code });
		};
		await assert.rejects(submitOperation(f.args), /send error/);
		assert.equal(Boolean(f.report.operations.grant), code !== "ACTION_REJECTED");
		if (code !== "ACTION_REJECTED") await assert.rejects(submitOperation({ ...f.args, signer: undefined }), /no automatic resend/);
	}
});
test("reconciliation accepts the same-intent replacement, and rejects nonce, calldata or chain mismatch", async () => {
	for (const field of ["nonce", "data", "chainId", "value", "from"]) {
		const f = transactionFixture();
		await submitOperation(f.args);
		f.tx[field] = field === "data" ? "0xdead" : field === "from" ? address(9) : 999;
		await assert.rejects(submitOperation({ ...f.args, signer: undefined }), /intent and nonce/);
		assert.equal(f.sends(), 1);
	}
	const f = transactionFixture();
	await submitOperation(f.args);
	const replacement = `0x${"ef".repeat(32)}`;
	await submitOperation({ ...f.args, signer: undefined, suppliedHash: replacement });
	assert.equal(f.report.operations.grant.hash, replacement);
	assert.equal(f.sends(), 1);
});
test("pending, reverted and reorged receipts are not treated as success", async () => {
	for (const variant of ["pending", "reverted", "reorg"]) {
		const f = transactionFixture();
		await submitOperation(f.args);
		if (variant === "pending") f.args.provider.getTransactionReceipt = async () => null;
		if (variant === "reverted") f.receipt.status = 0;
		if (variant === "reorg") f.args.provider.getBlock = async () => ({ hash: "0xother" });
		await assert.rejects(submitOperation({ ...f.args, signer: undefined }));
		assert.equal(f.sends(), 1);
	}
});
