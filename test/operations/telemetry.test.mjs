import { createTaskRunner } from "../../cli/task-runner.js";
import { projectTelemetry, telemetrySnapshot, createTelemetryPublisher } from "../../deployment-tooling/operations/telemetry.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const state = {
	runId: "fixture",
	taskId: "deploy.fixture",
	attempt: 2,
	attemptStartedAt: "2026-10-01T00:00:00Z",
	status: "waiting_external",
	waitingSince: "2026-10-01T00:00:00Z",
	transactions: [{ hash: "private-hash", status: "unresolved", submittedAt: "2026-10-01T00:00:00Z" }],
};
test("safe projection retains linked attempts and excludes payloads/free-form labels", () => {
	const event = {
		type: "tx.failed",
		sequence: 7,
		at: "2026-10-01T02:00:00Z",
		transaction: { hash: "private-hash", data: "secret-payload", error: "https://secret.invalid", status: "timed_out", durationMs: 50 },
	};
	const result = projectTelemetry(state, event);
	assert.equal(result.labels.operation, "other");
	assert.equal(result.labels.errorCategory, "timeout");
	assert.equal(result.correlation.attempt, 2);
	assert.doesNotMatch(JSON.stringify(result), /secret|payload/);
	assert.doesNotMatch(JSON.stringify(result.labels), /private-hash/);
	const snapshot = telemetrySnapshot(state, new Date(event.at));
	assert.equal(snapshot.unresolvedCount, 1);
	assert.equal(snapshot.unresolvedAgeMs, 7200000);
	assert.equal(snapshot.governanceWaitAgeMs, 7200000);
	assert.equal(telemetrySnapshot({ ...state, waitingSince: undefined }, new Date(event.at)).governanceWaitAgeMs, null);
});

test("a resumed governance wait retains durable age and exports separate linked attempts", async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-telemetry-run-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	let instant = new Date("2026-10-01T00:00:00Z");
	const exported = [];
	const run = async ctx => ctx.wait("Wait for governance execution");
	const definition = {
		id: "maintenance.fixture",
		version: 1,
		title: "Fixture",
		description: "Fixture",
		category: "maintenance",
		risk: "transaction",
		supportedNetworks: ["any"],
		inputs: [],
		artifacts: [],
		prepare: async () => ({}),
		plan: async () => [{ id: "fixture", phase: "handover", title: "Fixture" }],
		run,
		handler: run,
		transactionJournal: true,
		resumePolicy: { strategy: "stable-step-id", sourceDrift: "refuse", inputDrift: "refuse" },
		cancellationPolicy: { rollback: false, reconcileSubmittedTransactions: true, unresolvedOutcome: "cancel_pending" },
		reconcile: () => ({ unresolved: [] }),
	};
	const runner = createTaskRunner({ root, definitions: [definition], clock: () => instant, telemetry: event => exported.push(event) });
	const initial = await runner.start(definition.id);
	instant = new Date("2026-10-01T02:00:00Z");
	const resumed = await runner.resumeActive();
	assert.equal(resumed.attempt, 2);
	assert.equal(resumed.waitingSince, initial.waitingSince);
	assert.equal(telemetrySnapshot(resumed, instant).governanceWaitAgeMs, 7200000);
	assert.deepEqual(
		exported.map(event => event.labels.outcome),
		["started", "waiting", "started", "waiting"],
	);
	assert.equal(new Set(exported.map(event => event.id)).size, 4);
	assert.deepEqual(
		exported.map(event => event.correlation.attempt),
		[1, 1, 2, 2],
	);
	const events = fs
		.readFileSync(resumed.eventPath, "utf8")
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
	assert.ok(exported.every(event => events.some(record => record.eventId === event.id)));
	instant = new Date("2026-10-02T02:00:00Z");
	const cancelled = await runner.cancelActive();
	assert.equal(cancelled.status, "cancelled");
	assert.equal(exported.at(-1).labels.outcome, "cancelled");
	assert.equal(exported.at(-1).durationMs, 0, "governance waiting does not extend an ended execution attempt");
});
test("duplicate delivery is bounded and a rejected collector never blocks persistence", async () => {
	const events = [];
	const publish = createTelemetryPublisher(event => {
		events.push(event);
		return Promise.reject(new Error("collector down"));
	});
	const event = { type: "task.paused", sequence: 1, at: "2026-10-01T02:00:00Z" };
	publish(state, event);
	publish(state, event);
	publish({ ...state, attempt: 3 }, { ...event, type: "task.started", sequence: 2 });
	assert.equal(events.length, 2);
	assert.equal(events[0].durationMs, 7200000);
	assert.equal(events[1].correlation.attempt, 3);
	const throwing = createTelemetryPublisher(() => {
		throw new Error("collector down");
	});
	assert.doesNotThrow(() => throwing(state, event));
	await new Promise(resolve => setImmediate(resolve));
});
