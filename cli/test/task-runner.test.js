import { SIGNER_MODES, selectSigner } from "../signer/index.js";
import { createTaskRunner, TaskFatalError } from "../task-runner.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function temporaryRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-task-runner-"));
	fs.mkdirSync(path.join(root, "cli"), { recursive: true });
	fs.writeFileSync(path.join(root, "cli", "source.js"), "export const version = 1\n");
	return root;
}

function definition(overrides = {}) {
	const run = overrides.run || (async ctx => ctx.step("run", "Run", async () => {}));
	return {
		id: "maintenance.test",
		version: 1,
		category: "maintenance",
		risk: "read-only",
		title: "Test task",
		description: "A task used to prove runner behavior.",
		supportedNetworks: ["any"],
		inputs: [],
		resumePolicy: { strategy: "restart" },
		cancellationPolicy: { rollback: false },
		artifacts: ["event journal"],
		transactionJournal: false,
		prepare: async () => ({}),
		plan: async () => [{ id: "run", phase: "test", title: "Run" }],
		run,
		handler: run,
		...overrides,
	};
}

function mutating(overrides = {}) {
	const task = definition({
		risk: "transaction",
		transactionJournal: true,
		reconcile: ({ state }) => ({
			unresolved: state.transactions.filter(tx => ["unresolved", "timed_out"].includes(tx.status)).map(tx => tx.hash),
		}),
		...overrides,
	});
	task.handler = task.run;
	return task;
}

function runnerFor(task, root = temporaryRoot()) {
	return { root, runner: createTaskRunner({ root, definitions: [task], idFactory: () => "run-1" }) };
}

test("task definitions fail closed when the standard is incomplete", () => {
	const root = temporaryRoot();
	assert.throws(() => createTaskRunner({ root, definitions: [{ id: "broken" }] }), /positive integer version/);
	const noJournal = definition({ risk: "transaction", reconcile: async () => ({ unresolved: [] }) });
	assert.throws(() => createTaskRunner({ root, definitions: [noJournal] }), /transaction-journal support/);
});

test("catalog exposes the complete declarative task contract without handlers", () => {
	const { runner } = runnerFor(mutating());
	const [entry] = runner.catalog("maintenance");
	assert.deepEqual(entry.inputs, []);
	assert.deepEqual(entry.resumePolicy, { strategy: "restart" });
	assert.deepEqual(entry.cancellationPolicy, { rollback: false });
	assert.deepEqual(entry.artifacts, ["event journal"]);
	assert.equal(entry.transactionJournal, true);
	assert.equal(entry.run, undefined);
});

test("one-step read-only task archives locally and never occupies the active slot", async () => {
	const { runner } = runnerFor(definition());
	const result = await runner.start("maintenance.test");
	assert.equal(result.status, "completed");
	assert.equal(runner.getActive(), null);
	assert.deepEqual(result.completedSteps, ["run"]);
});

test("step events inherit their stable phase from the declared plan", async () => {
	const events = [];
	const { runner } = runnerFor(definition());
	await runner.start("maintenance.test", { onEvent: event => events.push(event) });
	const started = events.find(event => event.type === "step.started");
	const completed = events.find(event => event.type === "step.completed");
	assert.equal(started?.phase, "test");
	assert.equal(completed?.phase, "test");
});

test("synthetic 200-transaction task keeps stable steps and write-ahead outcomes", async () => {
	const hashes = Array.from({ length: 200 }, (_, index) => `0x${index.toString(16).padStart(64, "0")}`);
	const run = async ctx => {
		for (let index = 0; index < hashes.length; index++) {
			await ctx.step(`tx-${index}`, `Transaction ${index}`, async () => {
				const transaction = {
					hash: hashes[index],
					label: `transaction ${index}`,
					nonce: index,
					from: "0x1111111111111111111111111111111111111111",
					status: "unresolved",
				};
				ctx.emit("tx.submitted", { transaction });
				ctx.emit("tx.confirmed", {
					transaction: {
						...transaction,
						status: index === 5 ? "replaced" : "confirmed",
						replacementHash: index === 5 ? `0x${"f".repeat(64)}` : undefined,
					},
				});
			});
		}
	};
	const task = mutating({
		id: "deploy.synthetic",
		category: "deploy",
		plan: async () => hashes.map((_hash, index) => ({ id: `tx-${index}`, phase: "broadcast", title: `Transaction ${index}` })),
		run,
		handler: run,
	});
	const { runner } = runnerFor(task);
	const result = await runner.start("deploy.synthetic");
	assert.equal(result.status, "completed");
	assert.equal(result.completedSteps.length, 200);
	assert.equal(result.transactions.length, 200);
	assert.equal(result.transactions[5].status, "replaced");
	assert.equal(result.signer, "0x1111111111111111111111111111111111111111");
	assert.equal(runner.getActive(), null);
});

test("ordinary errors pause a mutating task and continuation skips completed steps", async () => {
	let attempts = 0;
	const run = async ctx => {
		await ctx.step("first", "First", async () => {});
		await ctx.step("second", "Second", async () => {
			if (attempts++ === 0) throw new Error("temporary RPC failure");
		});
	};
	const task = mutating({
		plan: async () => [
			{ id: "first", phase: "work", title: "First" },
			{ id: "second", phase: "work", title: "Second" },
		],
		run,
		handler: run,
	});
	const { runner } = runnerFor(task);
	const paused = await runner.start("maintenance.test");
	assert.equal(paused.status, "paused");
	assert.deepEqual(paused.completedSteps, ["first"]);
	const complete = await runner.resumeActive();
	assert.equal(complete.status, "completed");
	assert.deepEqual(complete.completedSteps, ["first", "second"]);
});

test("private-key signer state persists only its address and rehydrates after restart", async () => {
	const privateKey = `0x${"71".repeat(32)}`;
	const ui = { password: async () => privateKey, note: () => {} };
	const signer = await selectSigner(ui, { allowedModes: [SIGNER_MODES.PRIVATE_KEY], network: "arbitrum" });
	let attempts = 0;
	const run = async () => {
		assert.equal(process.env.SYMMIO_EPHEMERAL_PRIVATE_KEY, privateKey);
		if (attempts++ === 0) throw new Error("pause after credential use");
	};
	const { root, runner } = runnerFor(mutating({ run, handler: run }));
	const paused = await runner.start("maintenance.test", { input: { network: "arbitrum", signer }, ui });
	assert.equal(paused.status, "paused");
	assert.equal(process.env.SYMMIO_EPHEMERAL_PRIVATE_KEY, undefined);
	const serialized = fs.readFileSync(path.join(root, ".symmio", "tasks", "active.json"), "utf8");
	assert.doesNotMatch(serialized, new RegExp(privateKey.slice(2), "i"));
	assert.match(serialized, new RegExp(signer.address, "i"));
	const complete = await runner.resumeActive({ ui });
	assert.equal(complete.status, "completed");
	assert.equal(process.env.SYMMIO_EPHEMERAL_PRIVATE_KEY, undefined);
});

test("a resumable workflow binds every signer used by an intentional multi-authority handover", async () => {
	const deployer = "0x1111111111111111111111111111111111111111";
	const admin = "0x2222222222222222222222222222222222222222";
	let attempts = 0;
	const run = async ctx => {
		if (attempts++ > 0) return;
		for (const [index, from] of [deployer, admin].entries()) {
			const transaction = { hash: `0x${String(index + 1).repeat(64)}`, from, nonce: index, status: "submitted" };
			ctx.emit("tx.submitted", { transaction });
			ctx.emit("tx.confirmed", { transaction: { ...transaction, status: "confirmed" } });
		}
		throw new Error("pause after local handover boundary");
	};
	const { runner } = runnerFor(mutating({ run, handler: run }));
	const paused = await runner.start("maintenance.test");
	assert.equal(paused.signer, deployer);
	assert.deepEqual(paused.additionalSigners, [admin]);
	assert.equal((await runner.resumeActive()).status, "completed");
});

test("a known reverted transaction remains journaled while its stable step resumes safely", async () => {
	const revertedHash = `0x${"4".repeat(64)}`;
	const replacementHash = `0x${"5".repeat(64)}`;
	let attempts = 0;
	const run = async ctx => {
		await ctx.step("broadcast", "Broadcast", async () => {
			if (attempts++ === 0) {
				ctx.emit("tx.submitted", { transaction: { hash: revertedHash, status: "submitted", nonce: 7 } });
				ctx.emit("tx.failed", { transaction: { hash: revertedHash, status: "failed", nonce: 7, error: "execution reverted" } });
				throw new Error("transaction reverted");
			}
			ctx.emit("tx.submitted", { transaction: { hash: replacementHash, status: "submitted", nonce: 7 } });
			ctx.emit("tx.confirmed", { transaction: { hash: replacementHash, status: "confirmed", nonce: 7 } });
		});
	};
	const task = mutating({ run, handler: run, plan: async () => [{ id: "broadcast", phase: "work", title: "Broadcast" }] });
	const { runner } = runnerFor(task);
	assert.equal((await runner.start("maintenance.test")).status, "paused");
	const complete = await runner.resumeActive();
	assert.equal(complete.status, "completed");
	assert.equal(complete.transactions.find(tx => tx.hash === revertedHash).status, "failed");
	assert.equal(complete.transactions.find(tx => tx.hash === replacementHash).status, "confirmed");
});

test("explicit unrecoverable failures archive as failed instead of becoming active", async () => {
	const run = async () => {
		throw new TaskFatalError("invalid irreversible evidence");
	};
	const { runner } = runnerFor(mutating({ run, handler: run }));
	const failed = await runner.start("maintenance.test");
	assert.equal(failed.status, "failed");
	assert.equal(runner.getActive(), null);
});

test("waiting_external remains active until continuation can prove the external action", async () => {
	let ready = false;
	const run = async ctx =>
		ctx.step("safe", "Safe confirmation", async () => {
			if (!ready) ctx.wait("Confirm the Safe proposal");
		});
	const task = mutating({ run, handler: run });
	const { runner } = runnerFor(task);
	const waiting = await runner.start("maintenance.test");
	assert.equal(waiting.status, "waiting_external");
	ready = true;
	assert.equal((await runner.resumeActive()).status, "completed");
});

test("resume refuses changed source and changed input intent", async () => {
	const run = async () => {
		throw new Error("pause me");
	};
	const task = mutating({ run, handler: run });
	const first = runnerFor(task);
	await first.runner.start("maintenance.test", { input: { network: "fork-arbitrum" } });
	fs.writeFileSync(path.join(first.root, "cli", "source.js"), "export const version = 2\n");
	await assert.rejects(first.runner.resumeActive(), /Task source changed/);

	const second = runnerFor(task);
	await second.runner.start("maintenance.test", { input: { network: "fork-arbitrum" } });
	const activePath = path.join(second.root, ".symmio", "tasks", "active.json");
	const active = JSON.parse(fs.readFileSync(activePath, "utf8"));
	active.input.network = "arbitrum";
	fs.writeFileSync(activePath, JSON.stringify(active));
	await assert.rejects(second.runner.resumeActive(), /input no longer matches/);
});

test("resume refuses a changed stable plan", async () => {
	const run = async () => {
		throw new Error("pause me");
	};
	const { root, runner } = runnerFor(mutating({ run, handler: run }));
	await runner.start("maintenance.test");
	const activePath = path.join(root, ".symmio", "tasks", "active.json");
	const active = JSON.parse(fs.readFileSync(activePath, "utf8"));
	active.plan[0].title = "Changed intent";
	fs.writeFileSync(activePath, JSON.stringify(active));
	await assert.rejects(runner.resumeActive(), /plan no longer matches/);
});

test("a read-only check can run beside a paused mutation without clearing it", async () => {
	const mutatingRun = async () => {
		throw new Error("pause mutation");
	};
	const root = temporaryRoot();
	const mutation = mutating({ id: "deploy.paused", category: "deploy", run: mutatingRun, handler: mutatingRun });
	const readOnly = definition({ id: "maintenance.read", title: "Read beside mutation" });
	const runner = createTaskRunner({
		root,
		definitions: [mutation, readOnly],
		idFactory: (() => {
			let id = 0;
			return () => `run-${++id}`;
		})(),
	});
	await runner.start("deploy.paused");
	const activeRunId = runner.getActive().runId;
	assert.equal((await runner.start("maintenance.read")).status, "completed");
	assert.equal(runner.getActive().runId, activeRunId);
});

test("another live runner lock blocks start and a stale lock is recovered", async () => {
	const task = mutating();
	const { root, runner } = runnerFor(task);
	const lock = path.join(root, ".symmio", "tasks", "runner.lock");
	fs.mkdirSync(path.dirname(lock), { recursive: true });
	fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, runId: "other" }));
	await assert.rejects(runner.start("maintenance.test"), /Another SYMMIO task runner is active/);
	fs.writeFileSync(lock, JSON.stringify({ pid: 99999999, runId: "stale" }));
	assert.equal((await runner.start("maintenance.test")).status, "completed");
});

test("corrupt active state fails closed instead of being mistaken for history", () => {
	const { root, runner } = runnerFor(mutating());
	const active = path.join(root, ".symmio", "tasks", "active.json");
	fs.mkdirSync(path.dirname(active), { recursive: true });
	fs.writeFileSync(active, "{broken");
	assert.throws(() => runner.getActive(), /unreadable/);
});

test("an interrupted atomic write cannot replace the last durable active record", async () => {
	const run = async () => {
		throw new Error("pause with durable state");
	};
	const task = mutating({ run, handler: run });
	const { root, runner } = runnerFor(task);
	const paused = await runner.start("maintenance.test");
	const activePath = path.join(root, ".symmio", "tasks", "active.json");
	fs.writeFileSync(`${activePath}.tmp-dead-process`, "{partial");
	const recovered = createTaskRunner({ root, definitions: [task] }).getActive();
	assert.equal(recovered.runId, paused.runId);
	assert.equal(recovered.status, "paused");
});

test("raw events redact secrets and endpoints but retain public transaction hashes", async () => {
	const hash = `0x${"a".repeat(64)}`;
	const run = async ctx => {
		ctx.captureLine(`rpc=https://secret.example key=${"0x" + "b".repeat(64)} transaction=${hash}`);
		ctx.captureLine(`private_key=${"0x" + "c".repeat(64)}`);
	};
	const task = definition({ run, handler: run });
	const { runner } = runnerFor(task);
	const result = await runner.start("maintenance.test");
	const log = fs.readFileSync(result.logPath, "utf8");
	assert.doesNotMatch(log, /secret\.example/);
	assert.doesNotMatch(log, /0xcccc/);
	assert.match(log, new RegExp(hash));
});

test("cancellation before broadcast archives safely without inventing rollback", async () => {
	const run = async () => {
		throw new Error("pause before broadcast");
	};
	const task = mutating({ run, handler: run });
	const { runner } = runnerFor(task);
	await runner.start("maintenance.test");
	const cancelled = await runner.cancelActive();
	assert.equal(cancelled.status, "cancelled");
	assert.match(cancelled.cancellation.message, /No rollback/);
	assert.equal(runner.getActive(), null);
});

test("cancellation preserves confirmed work and blocks on unknown outcomes", async () => {
	const confirmedHash = `0x${"1".repeat(64)}`;
	const unknownHash = `0x${"2".repeat(64)}`;
	let unresolved = true;
	const run = async ctx => {
		ctx.emit("tx.submitted", { transaction: { hash: confirmedHash, status: "unresolved", nonce: 1 } });
		ctx.emit("tx.confirmed", { transaction: { hash: confirmedHash, status: "confirmed", nonce: 1 } });
		ctx.emit("tx.submitted", { transaction: { hash: unknownHash, status: "timed_out", nonce: 2 } });
		throw new Error("receipt timeout");
	};
	const task = mutating({
		run,
		handler: run,
		reconcile: () => ({ unresolved: unresolved ? [unknownHash] : [] }),
	});
	const { runner } = runnerFor(task);
	await runner.start("maintenance.test");
	const pending = await runner.cancelActive();
	assert.equal(pending.status, "cancel_pending");
	assert.deepEqual(pending.cancelBlockedBy, [unknownHash]);
	// Simulate the shared receipt reconciler proving the timed-out transaction reverted.
	unresolved = false;
	const activePath = path.join(pending.eventPath, "..", "..", "..", "active.json");
	const active = JSON.parse(fs.readFileSync(activePath, "utf8"));
	active.transactions.find(tx => tx.hash === unknownHash).status = "failed";
	fs.writeFileSync(activePath, JSON.stringify(active));
	const cancelled = await runner.cancelActive();
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.transactions[0].status, "confirmed");
});

test("a reconciliation error keeps uncertain cancellation resumable", async () => {
	const hash = `0x${"3".repeat(64)}`;
	const run = async ctx => {
		ctx.emit("tx.submitted", { transaction: { hash, status: "submitted" } });
		throw new Error("lost RPC connection");
	};
	const task = mutating({
		run,
		handler: run,
		reconcile: async () => {
			throw new Error("RPC still unavailable");
		},
	});
	const { runner } = runnerFor(task);
	await runner.start("maintenance.test");
	const pending = await runner.cancelActive();
	assert.equal(pending.status, "cancel_pending");
	assert.deepEqual(pending.cancelBlockedBy, [hash]);
	assert.match(pending.lastError, /unresolved transaction/);
});
