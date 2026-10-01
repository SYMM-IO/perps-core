import { validateDocument } from "../../deployment-tooling/operations/inputs.js";
import { writeOperationFile } from "../../deployment-tooling/operations/outputs.js";
import { createTaskRunner } from "../task-runner.js";
import { prepareOperationRequest } from "../tasks/operation-plan.js";
import { TASK_DEFINITIONS } from "../tasks/registry.js";
import { operationFixture, operationAddress as address, operationHash as hash } from "./fixtures/operation.js";
import { Interface } from "ethers";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const definition = TASK_DEFINITIONS.find(t => t.id === "operations.plan");
const iface = new Interface(["function foo()"]);
const ui = {
	note() {},
	confirm() {
		throw new Error("Planning must not request signing authorization");
	},
};

function setup(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "operation-runner-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const fixture = operationFixture(root);
	// The runner and source binding are real; only RPC subprocess output is supplied by the fixture.
	execFileSync("git", ["init", "-q", root]);
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], {
		cwd: root,
	});
	fixture.release.sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	writeOperationFile(fixture.releaseFile, fixture.release);
	const input = prepareOperationRequest(fixture.file);
	const snapshot = {
		schemaVersion: 1,
		kind: "symmio.snapshot",
		inputDigest: input.inputDigest,
		chainId: input.chainId,
		blockNumber: 10,
		blockHash: hash(4),
		core: address(1),
		owner: address(2),
		coreCodeHash: hash(5),
		facets: [{ address: address(6), codeHash: hash(3), selectors: ["0x1f931c1c", iface.getFunction("foo").selector] }],
	};
	let calls = 0,
		pauseAfterInspection = false,
		failInspection = false;
	const wrapped = {
		...definition,
		run: async (ctx, i) =>
			definition.run(
				{
					...ctx,
					runProcess: async (command, args, opts) => {
						calls++;
						assert.equal(command, "./node_modules/.bin/hardhat");
						assert.equal(args[0], "internal:operations-inspect");
						assert.equal(opts.env.SYMMIO_RECIPE_READ_ONLY, "true");
						assert.equal(opts.env.SYMMIO_SIGNER_MODE, "safe-file");
						if (failInspection) throw new Error("RPC failed https://user:secret@rpc.invalid");
						writeOperationFile(args[args.indexOf("--output") + 1], snapshot);
						if (pauseAfterInspection) ctx.requestPause();
					},
				},
				i,
			),
	};
	wrapped.handler = wrapped.run;
	const runner = createTaskRunner({ root, definitions: [wrapped], idFactory: () => "fixture-run" });
	const directory = path.join(root, "tasks/data", String(input.chainId), "operations/fixture-run");
	const result = () => JSON.parse(fs.readFileSync(path.join(directory, "result.json")));
	return {
		root,
		fixture,
		input,
		runner,
		directory,
		result,
		calls: () => calls,
		pause: () => (pauseAfterInspection = true),
		fail: () => (failInspection = true),
	};
}

test("registered planner runs without a signer and emits standard outputs with planned status", async t => {
	const f = setup(t);
	const state = await f.runner.start(definition.id, { input: f.input, ui });
	assert.equal(state.status, "completed");
	assert.equal(state.result.status, "planned");
	assert.deepEqual(state.transactions, []);
	assert.deepEqual(state.signing, {});
	const result = validateDocument("result", f.result());
	assert.equal(result.verification, "not-run");
	assert.equal(f.calls(), 1);
	for (const filename of Object.values(result.artifacts)) assert.ok(fs.existsSync(path.resolve(f.directory, filename)), filename);
	assert.match(fs.readFileSync(path.join(f.directory, "review.md"), "utf8"), /Planning only/);
	assert.equal(f.runner.getActive(), null);
});

test("pause after inspection resumes from its bound snapshot without another subprocess", async t => {
	const f = setup(t);
	f.pause();
	let state = await f.runner.start(definition.id, { input: f.input, ui });
	assert.equal(state.status, "paused");
	assert.equal(f.result().status, "paused");
	assert.deepEqual(state.completedSteps, ["inspect"]);
	state = await f.runner.resumeActive({ ui });
	assert.equal(state.status, "completed");
	assert.equal(f.calls(), 1);
	assert.equal(f.result().status, "planned");
});

test("changed input and saved snapshots cannot be accepted on resume", async t => {
	const f = setup(t);
	f.pause();
	await f.runner.start(definition.id, { input: f.input, ui });
	fs.appendFileSync(f.fixture.profileFile, "\n");
	await assert.rejects(f.runner.resumeActive({ ui }), /changed/);
	const saved = fs.readFileSync(f.fixture.profileFile, "utf8");
	fs.writeFileSync(f.fixture.profileFile, saved.slice(0, -1));
	const file = path.join(f.directory, "snapshot.json"),
		snapshot = JSON.parse(fs.readFileSync(file));
	snapshot.blockNumber++;
	writeOperationFile(file, snapshot);
	const state = await f.runner.resumeActive({ ui });
	assert.equal(state.status, "paused");
	assert.equal(f.result().errors[0].code, "evidence-drift");
});

test("RPC failure produces a redacted standard result and cancellation preserves evidence", async t => {
	const f = setup(t);
	f.fail();
	const state = await f.runner.start(definition.id, { input: f.input, ui });
	assert.equal(state.status, "paused");
	assert.equal(f.result().errors[0].code, "inspection-failed");
	assert.doesNotMatch(JSON.stringify(f.result()), /user:secret/);
	assert.equal((await f.runner.cancelActive({ ui })).status, "cancelled");
	assert.equal(f.result().status, "cancelled");
	assert.deepEqual(f.result().transactions, []);
});
