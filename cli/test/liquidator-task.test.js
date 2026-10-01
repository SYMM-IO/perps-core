import { TASK_DEFINITIONS } from "../tasks/registry.js";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const task = TASK_DEFINITIONS.find(task => task.id === "deploy.symmio-liquidator");
for (const network of ["localhost", "hyperevm"]) {
	test(`liquidator ${network} plan cannot inherit execution and isolates retry records`, async () => {
		const calls = [];
		const input = { network, chainId: network === "localhost" ? 31337 : 999, symmio: "core", admin: "admin", operators: "operator" };
		const plan = task.plan({}, input);
		const ctx = {
			state: { logPath: "/tmp/liquidator-task/run/output.log" },
			ui: { confirm: async () => true, text: async () => String(input.chainId) },
			checkpoint() {},
			async step(id, title, action) {
				assert.equal(title, plan.find(step => step.id === id).title);
				await action();
			},
			async runProcess(command, args, options) {
				calls.push({ command, args, env: options?.env });
			},
		};
		await task.run(ctx, input);
		const runs = calls.filter(call => call.args.includes("scripts/deployLiquidator.ts"));
		assert.equal(runs[0].env.EXECUTE, "false");
		assert.equal(runs[0].env.CONFIRM_CHAIN_ID, "");
		assert.equal(runs[0].env.LIQUIDATOR_ADDRESS, "");
		assert.equal(runs.at(-1).env.EXECUTE, "true");
		assert.equal(runs.at(-1).env.LIQUIDATOR_RESUME_FILE, path.join(path.dirname(ctx.state.logPath), "liquidator-execute.json"));
		if (network === "hyperevm") assert.notEqual(runs[1].env.LIQUIDATOR_RESUME_FILE, runs[2].env.LIQUIDATOR_RESUME_FILE);
		const record = runs.at(-1).env.LIQUIDATOR_RESUME_FILE;
		await task.run(ctx, input);
		assert.equal(calls.at(-1).env.LIQUIDATOR_RESUME_FILE, record);
	});
}
