import { TASK_DEFINITIONS, validateSettlementRepairPlan } from "../tasks/registry.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const input = {
	network: "arbitrum",
	chainId: 42161,
	instantLayer: "0x1111111111111111111111111111111111111111",
	deactivateOriginals: true,
};

function repairPlan(overrides = {}) {
	return {
		apiVersion: "operations.symm.io/instant-layer-settlement-template-recreation-v3",
		chainId: "42161",
		instantLayer: input.instantLayer,
		quoteIdOffset: "480",
		currentPriceOffset: "512",
		legacyQuoteIdOffset: "448",
		recreated: true,
		actions: [],
		...overrides,
	};
}

test("settlement repair accepts the v3 plan for 32-byte Muon request IDs", () => {
	const plan = repairPlan();
	assert.equal(validateSettlementRepairPlan(plan, input), plan);
});

test("settlement repair refuses obsolete v2 plans", () => {
	assert.throws(
		() => validateSettlementRepairPlan(repairPlan({ apiVersion: "operations.symm.io/instant-layer-settlement-template-recreation-v2" }), input),
		/unsupported plan artifact/,
	);
});

for (const [field, invalid] of [
	["quoteIdOffset", "448"],
	["currentPriceOffset", "480"],
	["legacyQuoteIdOffset", "480"],
	["legacyQuoteIdOffset", undefined],
]) {
	test(`settlement repair refuses incompatible ${field} ${invalid}`, () => {
		assert.throws(() => validateSettlementRepairPlan(repairPlan({ [field]: invalid }), input), /offset/i);
	});
}

test("settlement repair still binds plans to the selected chain and target", () => {
	assert.throws(() => validateSettlementRepairPlan(repairPlan({ chainId: "999" }), input), /chain 999 does not match 42161/);
	assert.throws(
		() => validateSettlementRepairPlan(repairPlan({ instantLayer: "0x2222222222222222222222222222222222222222" }), input),
		/target .* does not match/,
	);
	assert.throws(() => validateSettlementRepairPlan(repairPlan({ actions: undefined }), input), /actions are missing/);
});

function repairContext(t, plans) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-settlement-repair-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const calls = [];
	return {
		calls,
		state: { eventPath: path.join(directory, "events.jsonl") },
		ui: {
			note() {},
			text() {
				throw new Error("A satisfied plan must not request authorization");
			},
		},
		step: async (_id, _title, run) => run(),
		runProcess: async (command, args, options) => {
			assert.equal(command, "./node_modules/.bin/hardhat");
			assert.deepEqual(args, ["run", "--no-compile", "scripts/recreateInstantLayerSettlementTemplates.ts", "--network", "arbitrum"]);
			assert.equal(options.env.EXECUTE, "false");
			assert.equal(options.env.CONFIRM_CHAIN_ID, "");
			assert.equal(options.env.INSTANT_LAYER_ADDRESS, input.instantLayer);
			calls.push(options.env);
			assert.ok(plans.length > 0, "Unexpected repair subprocess");
			fs.writeFileSync(options.env.REPAIR_PLAN_OUTPUT, JSON.stringify(plans.shift()));
		},
	};
}

test("registered settlement repair consumes v3 inspection and verification plans without broadcasting completed work", async t => {
	const definition = TASK_DEFINITIONS.find(task => task.id === "maintenance.recreate-settlement-templates");
	assert.equal(definition.version, 4);
	const ctx = repairContext(t, [repairPlan(), repairPlan()]);
	await definition.run(ctx, input);
	assert.equal(ctx.calls.length, 2);
	assert.equal(ctx.state.settlementTemplatePlan.actionCount, 0);
});

test("registered settlement repair rejects unsatisfied post-state even when inspection required no writes", async t => {
	const definition = TASK_DEFINITIONS.find(task => task.id === "maintenance.recreate-settlement-templates");
	const ctx = repairContext(t, [repairPlan(), repairPlan({ recreated: false, actions: [{ description: "Retire a legacy template" }] })]);
	await assert.rejects(() => definition.run(ctx, input), /verification still requires 1 action/);
	assert.equal(ctx.calls.length, 2);
});
