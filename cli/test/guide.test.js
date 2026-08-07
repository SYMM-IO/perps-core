import { actionsFor, describeRecipe } from "../commands/guide.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function writeRecipe(contents) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-guide-"));
	const file = path.join(dir, "arbitrum.json");
	fs.writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));
	return file;
}

const FULL_RECIPE = {
	name: "arbitrum-deployment",
	network: { name: "arbitrum", chainId: 42161, mode: "live" },
	core: { mode: "deploy" },
	partyB: { mode: "deploy" },
	symbolManager: { mode: "deploy" },
	expressProvider: { mode: "deploy" },
};

const ADDON_RECIPE = {
	name: "arbitrum-expressProvider",
	network: { name: "arbitrum", chainId: 42161, mode: "live" },
	core: { mode: "reuse", fromReport: "../tasks/data/42161/deployment-report.json" },
	partyB: { mode: "skip" },
	symbolManager: { mode: "skip" },
	expressProvider: { mode: "deploy" },
};

const EMPTY_STATE = { report: null, checkpoint: null };
const kinds = actions => actions.map(action => action.value.kind);
const labels = actions => actions.map(action => action.label);

test("describeRecipe reads target, components and outstanding placeholders", () => {
	const recipe = describeRecipe(writeRecipe(FULL_RECIPE));
	assert.equal(recipe.valid, true);
	assert.equal(recipe.network, "arbitrum");
	assert.equal(recipe.chainId, 42161);
	assert.equal(recipe.mode, "live");
	assert.equal(recipe.simulated, false);
	assert.equal(recipe.isAddon, false);
	assert.equal(recipe.addon, undefined);
	assert.deepEqual(recipe.placeholders, []);
});

test("describeRecipe counts placeholders and identifies a standalone add-on", () => {
	const recipe = describeRecipe(writeRecipe({ ...ADDON_RECIPE, expressProvider: { mode: "deploy", admin: "REPLACE_WITH_ADMIN_ADDRESS" } }));
	assert.equal(recipe.isAddon, true);
	assert.equal(recipe.addon, "expressProvider");
	assert.deepEqual(recipe.placeholders, ["REPLACE_WITH_ADMIN_ADDRESS"]);
});

test("describeRecipe treats a fork recipe as simulated so it reads fork-scoped evidence", () => {
	const recipe = describeRecipe(writeRecipe({ ...FULL_RECIPE, network: { name: "fork-arbitrum", chainId: 42161, mode: "fork" } }));
	assert.equal(recipe.simulated, true);
});

test("describeRecipe survives unreadable and malformed recipes instead of throwing", () => {
	const missing = describeRecipe(path.join(os.tmpdir(), "symmio-guide-does-not-exist", "nope.json"));
	assert.equal(missing.valid, false);
	assert.match(missing.error, /cannot read/);

	const broken = describeRecipe(writeRecipe("{ not json"));
	assert.equal(broken.valid, false);
	assert.match(broken.error, /not valid JSON/);
});

test("a broken recipe offers only the fix, never a deployment", () => {
	const actions = actionsFor(describeRecipe(writeRecipe("{ not json")), EMPTY_STATE);
	assert.deepEqual(kinds(actions), ["edit"]);
});

test("unfilled placeholders are the first thing offered", () => {
	const recipe = describeRecipe(writeRecipe({ ...FULL_RECIPE, partyB: { mode: "deploy", signer: "REPLACE_WITH_PARTY_B_SIGNER_ADDRESS" } }));
	const actions = actionsFor(recipe, EMPTY_STATE);
	assert.equal(actions[0].value.kind, "edit");
	// Deploying is not offered while the recipe still contains placeholders.
	assert.ok(!actions.some(action => action.value.command === "deploy"));
});

/** Strip the recipe path so assertions describe the command shape, not the temp directory. */
const shape = display => display.replace(/--config \S+/, "--config <recipe>");

test("a clean recipe with nothing deployed offers preflight, plan, then deploy in that order", () => {
	const actions = actionsFor(describeRecipe(writeRecipe(FULL_RECIPE)), EMPTY_STATE);
	const commands = actions
		.filter(action => action.value.kind === "run" && action.value.command !== "config")
		.map(action => shape(action.value.display));
	assert.deepEqual(commands, [
		"./symmio doctor --config <recipe>",
		"./symmio deploy --config <recipe> --plan",
		"./symmio deploy --config <recipe>",
	]);
});

test("an in-progress checkpoint outranks every other suggestion", () => {
	const recipe = describeRecipe(writeRecipe(FULL_RECIPE));
	const actions = actionsFor(recipe, { report: null, checkpoint: { step: "diamond" } });
	assert.match(actions[0].label, /Continue the interrupted deployment/);
	// Resume must be the plain deploy command — the one that recovers rather than restarts.
	assert.equal(shape(actions[0].value.display), "./symmio deploy --config <recipe>");
	assert.ok(!actions.some(action => /--fresh/.test(action.value.display ?? "")));
});

test("a pending handover surfaces the actions and a way to finalize", () => {
	const recipe = describeRecipe(writeRecipe(FULL_RECIPE));
	const state = {
		checkpoint: null,
		report: { lifecycle: "pending_handover", manualActions: [{ description: "accept ownership", to: "0x1", value: "0", data: "0x" }] },
	};
	const actions = actionsFor(recipe, state);
	assert.ok(kinds(actions).includes("handover"));
	assert.ok(labels(actions).some(label => /Check those actions are done/.test(label)));
});

test("a completed deployment stops offering to deploy and offers verification instead", () => {
	const recipe = describeRecipe(writeRecipe(FULL_RECIPE));
	const actions = actionsFor(recipe, { checkpoint: null, report: { lifecycle: "complete", manualActions: [] } });
	assert.ok(!labels(actions).some(label => /^Deploy/.test(label)));
	assert.ok(actions.some(action => action.value.command === "status"));
});

test("the menu speaks plainly — no internal vocabulary leaks into what an operator reads", () => {
	const states = [
		EMPTY_STATE,
		{ report: null, checkpoint: { step: "diamond" } },
		{ checkpoint: null, report: { lifecycle: "pending_handover", manualActions: [{ description: "x", to: "0x1", value: "0", data: "0x" }] } },
		{ checkpoint: null, report: { lifecycle: "complete", manualActions: [] } },
	];
	// "recipe" and "target" are what confused a first-time operator; the rest are internal terms
	// that mean nothing outside this codebase. Detail lines may still name a concrete file.
	const jargon = /\b(recipe|target|preflight|lifecycle|checkpoint|manifest|digest|artifact)\b/i;
	for (const state of states) {
		for (const action of actionsFor(describeRecipe(writeRecipe(FULL_RECIPE)), state)) {
			assert.ok(!jargon.test(action.label), `jargon in menu label: ${action.label}`);
		}
	}
});

test("the menu always offers something other than deploying", () => {
	const actions = actionsFor(describeRecipe(writeRecipe(FULL_RECIPE)), EMPTY_STATE);
	// The CLI inspects as well as deploys; a wizard that only offers deployment hides half of it.
	assert.ok(actions.some(action => action.value.command === "config"));
});

test("an express patch recipe is addressed as an add-on so every command threads --only", () => {
	const recipe = describeRecipe(
		writeRecipe({
			...ADDON_RECIPE,
			expressProvider: {
				mode: "reuse",
				address: "0x2222222222222222222222222222222222222222",
				roles: { OPERATOR_ROLE: ["0x3333333333333333333333333333333333333333"] },
			},
		}),
	);
	assert.equal(recipe.addon, "expressProvider");
	const runnable = actionsFor(recipe, EMPTY_STATE).filter(action => action.value.kind === "run" && action.value.command !== "config");
	assert.ok(runnable.length > 0);
	for (const action of runnable) assert.match(action.value.display, /--only expressProvider/);
});

test("an add-on recipe threads --only through every command it offers", () => {
	const actions = actionsFor(describeRecipe(writeRecipe(ADDON_RECIPE)), EMPTY_STATE);
	const runnable = actions.filter(action => action.value.kind === "run" && action.value.command !== "config");
	assert.ok(runnable.length > 0);
	for (const action of runnable) {
		assert.match(action.value.display, /--only expressProvider/);
		assert.equal(action.value.args.only, "expressProvider");
	}
});
