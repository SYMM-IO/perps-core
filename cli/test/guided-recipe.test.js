import { validateDeploymentRecipe } from "../../deployment-tooling/recipe.js";
import { buildInitialRecipe } from "../commands/recipe.js";
import {
	applyLocalAccountDefaults,
	editGaslessLayer,
	prepareDeploymentRecipe,
	prepareExpressPatch,
	recipeReviewText,
} from "../tasks/guided-recipe.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ACCOUNTS = Array.from({ length: 8 }, (_, index) => `0x${String(index + 1).padStart(40, "0")}`);
const PRIVATE_KEY = `0x${"11".repeat(32)}`;

function fakeUi({
	keystore,
	network = "fork-arbitrum",
	overrides = [],
	omitPartyBSigner = false,
	existingChoice = "use",
	selectedRecipePath,
	signerMode,
}) {
	const prompts = [];
	return {
		prompts,
		select: async options => {
			const { message } = options;
			prompts.push({ type: "select", ...options });
			if (message === "Deployment transaction signer") {
				if (signerMode) return signerMode;
				if (network === "localhost") return "local-node";
				return keystore ? "hardhat-keystore" : "private-key";
			}
			if (message === "A reviewed recipe already exists for this scope") return existingChoice;
			if (message === "Which reviewed recipe file do you want to use?") return selectedRecipePath;
			return network;
		},
		multiselect: async options => {
			prompts.push({ type: "multiselect", ...options });
			return overrides;
		},
		confirm: async options => {
			prompts.push({ type: "confirm", ...options });
			if (options.message === "Store RPC and explorer credentials in the Hardhat keystore?") return keystore;
			if (options.message.includes("Configure or refresh")) return false;
			return true;
		},
		text: async options => {
			prompts.push({ type: "text", ...options });
			if (/keystore key/i.test(options.message)) return "NEW_DEPLOYER";
			if (omitPartyBSigner && options.message === "PartyB signer (optional)") return "";
			return /app ID|public-key X|maximum debt/i.test(options.message) ? "1" : "0x1111111111111111111111111111111111111111";
		},
		password: async options => {
			prompts.push({ type: "password", ...options });
			return PRIVATE_KEY;
		},
		note: (message, title) => prompts.push({ type: "note", message, title }),
		runInteractive: async () => {
			throw new Error("keystore flow must not run when refresh is declined");
		},
	};
}

test("guided recipe selects a signer once, defaults keystore infrastructure to Yes, and validates immediately", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-guided-recipe-"));
	const ui = fakeUi({ keystore: true });
	const input = await prepareDeploymentRecipe({ root, ui });
	assert.equal(input.network, "fork-arbitrum");
	const useKeystore = ui.prompts.find(prompt => prompt.message === "Store RPC and explorer credentials in the Hardhat keystore?");
	assert.equal(useKeystore.initialValue, true);
	assert.equal(ui.prompts.filter(prompt => prompt.message === "Deployment transaction signer").length, 1);
	const recipe = JSON.parse(fs.readFileSync(input.config, "utf8"));
	assert.equal(recipe.secrets.deployer, undefined);
	assert.equal(recipe.secrets.rpc, "hardhat-keystore://RPC_ARBITRUM");
	assert.ok(!JSON.stringify(recipe).includes("REPLACE_WITH_"));
});

test("environment secret references remain available for fork-only operation", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-guided-env-"));
	const ui = fakeUi({ keystore: false });
	const input = await prepareDeploymentRecipe({ root, ui });
	const recipe = JSON.parse(fs.readFileSync(input.config, "utf8"));
	assert.equal(recipe.network.mode, "fork");
	assert.equal(recipe.secrets.deployer, undefined);
	assert.equal(recipe.secrets.rpc, "env://RPC_ARBITRUM");
});

test("an existing scope can select any JSON recipe file from deployment-recipes", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-guided-select-recipe-"));
	const created = await prepareDeploymentRecipe({ root, ui: fakeUi({ keystore: false }) });
	const selectedRecipePath = path.join(root, "deployment-recipes", "fork-arbitrum-reviewed-alternative.json");
	const selectedRecipe = JSON.parse(fs.readFileSync(created.config, "utf8"));
	selectedRecipe.name = "fork-arbitrum-reviewed-alternative";
	fs.writeFileSync(selectedRecipePath, `${JSON.stringify(selectedRecipe, null, 2)}\n`);
	fs.writeFileSync(path.join(root, "deployment-recipes", "ignore-me.txt"), "not a recipe\n");

	const ui = fakeUi({ keystore: false, existingChoice: "choose", selectedRecipePath });
	const input = await prepareDeploymentRecipe({ root, ui });
	assert.equal(input.config, selectedRecipePath);
	const selection = ui.prompts.find(prompt => prompt.message === "Which reviewed recipe file do you want to use?");
	assert.deepEqual(
		selection.options.map(option => option.label),
		["deployment-recipes/fork-arbitrum-reviewed-alternative.json", "deployment-recipes/fork-arbitrum.json"],
	);
	assert.equal(ui.prompts.filter(prompt => prompt.message === "Deployment transaction signer").length, 1);
});

test("a selected recipe replaces the earlier network choice before signer selection", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-guided-select-network-"));
	const localhost = await prepareDeploymentRecipe({
		root,
		ui: fakeUi({ network: "localhost" }),
		discoverAccounts: async () => ACCOUNTS,
	});
	await prepareDeploymentRecipe({ root, ui: fakeUi({ keystore: false }) });

	const ui = fakeUi({
		keystore: false,
		existingChoice: "choose",
		selectedRecipePath: localhost.config,
		signerMode: "local-node",
	});
	const input = await prepareDeploymentRecipe({ root, ui });
	assert.equal(input.config, localhost.config);
	assert.equal(input.network, "localhost");
	assert.equal(input.signer.mode, "local-node");
	const signerPrompt = ui.prompts.find(prompt => prompt.message === "Deployment transaction signer");
	assert.ok(signerPrompt.options.some(option => option.value === "local-node"));
	assert.match(ui.prompts.find(prompt => prompt.title === "Deployment target changed").message, /targets localhost/);
});

test("guided PartyB setup allows the ERC-1271 signer to remain unset", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-guided-no-partyb-signer-"));
	const ui = fakeUi({ keystore: false, overrides: ["components"], omitPartyBSigner: true });
	const input = await prepareDeploymentRecipe({ root, ui });
	const recipe = JSON.parse(fs.readFileSync(input.config, "utf8"));
	assert.equal(recipe.partyB.signer, undefined);
	assert.ok(recipe.partyB.operators.length > 0);
	assert.match(recipeReviewText(recipe), /PartyB signer: not configured/);
	assert.doesNotThrow(() => validateDeploymentRecipe(recipe));
});

test("persistent local preparation discovers unlocked accounts and needs no JSON or secret input", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-guided-local-"));
	const ui = fakeUi({ network: "localhost" });
	const input = await prepareDeploymentRecipe({ root, ui, discoverAccounts: async () => ACCOUNTS });
	const recipe = JSON.parse(fs.readFileSync(input.config, "utf8"));
	assert.equal(input.network, "localhost");
	assert.deepEqual(recipe.secrets, {});
	assert.deepEqual(recipe.core.collateral, { mode: "deploy" });
	assert.equal(recipe.core.muon.mode, "mock");
	assert.equal(recipe.governance.admin, ACCOUNTS[1]);
	assert.equal(recipe.partyB.signer, ACCOUNTS[2]);
	assert.deepEqual(recipe.partyB.operators, [ACCOUNTS[4]]);
	assert.equal(recipe.symbolManager.operator, ACCOUNTS[3]);
	assert.equal(recipe.expressProvider.roles.OPERATOR_ROLE[0], ACCOUNTS[4]);
	assert.equal(recipe.gaslessLayer.treasury, ACCOUNTS[1]);
	assert.deepEqual(recipe.gaslessLayer.relayers, [ACCOUNTS[4]]);
	assert.ok(!JSON.stringify(recipe).includes("REPLACE_WITH_"));
	assert.equal(
		ui.prompts.some(prompt => prompt.message === "Store RPC and explorer credentials in the Hardhat keystore?"),
		false,
	);
	assert.doesNotThrow(() => validateDeploymentRecipe(recipe));
});

test("local defaults remain fully reviewable without exposing a secret", () => {
	const source = JSON.parse(fs.readFileSync(path.resolve("deployment-tooling/examples/arbitrum.v1.example.json"), "utf8"));
	const recipe = applyLocalAccountDefaults(buildInitialRecipe("localhost", source), ACCOUNTS);
	const review = recipeReviewText(recipe, { identityPath: "deployment-recipes/localhost.json", only: "full system" });
	assert.match(review, /TARGET\nlocalhost • chain 31337 • local/);
	assert.match(review, /no secret reference is stored/i);
	assert.match(review, /OWNERSHIP/);
	assert.match(review, new RegExp(`PartyB operators: ${ACCOUNTS[4]}`));
	assert.match(review, /Express roles:/);
	assert.match(review, /Gasless treasury:/);
	assert.match(review, /Gasless relayers:/);
	assert.match(review, /Gasless selector overrides:/);
	assert.doesNotMatch(review, /private key|password/i);
});

test("GaslessLayer guided editing covers selector-specific fee overrides", async () => {
	const source = JSON.parse(fs.readFileSync(path.resolve("deployment-tooling/examples/arbitrum.v1.example.json"), "utf8"));
	const recipe = applyLocalAccountDefaults(buildInitialRecipe("localhost", source), ACCOUNTS);
	const ui = {
		text: async options => {
			if (options.message === "Selector fee override count") return "1";
			if (options.message === "Selector override #1") return "0x12345678";
			if (options.message === "Selector fee amount #1") return "11";
			return String(options.initialValue ?? "0");
		},
		confirm: async options => options.initialValue,
		note: () => {},
	};
	assert.equal(await editGaslessLayer(ui, recipe), true);
	assert.deepEqual(recipe.gaslessLayer.selectorFees, [{ selector: "0x12345678", configured: true, amount: "11" }]);
	assert.doesNotThrow(() => validateDeploymentRecipe(recipe));
});

test("guided tests use an explicit deployment-report fixture", () => {
	const fixture = path.resolve("cli/test/fixtures/arbitrum-deployment-report.json");
	assert.equal(fs.existsSync(fixture), true);
	const report = JSON.parse(fs.readFileSync(fixture, "utf8"));
	assert.equal(report.chainId, 42161);
	assert.ok(report.addresses.expressProvider);
});

test("ExpressProvider patch sections are edited interactively and can declare role revocations", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-guided-patch-"));
	const source = JSON.parse(fs.readFileSync(path.resolve("deployment-tooling/examples/arbitrum.v1.example.json"), "utf8"));
	const recipePath = path.join(root, "deployment-recipes", "localhost.json");
	const recipe = applyLocalAccountDefaults(buildInitialRecipe("localhost", source, { outputPath: recipePath }), ACCOUNTS);
	fs.mkdirSync(path.dirname(recipePath), { recursive: true });
	fs.writeFileSync(recipePath, `${JSON.stringify(recipe, null, 2)}\n`);

	const report = JSON.parse(fs.readFileSync(path.resolve("cli/test/fixtures/arbitrum-deployment-report.json"), "utf8"));
	report.network = "localhost";
	report.chainId = 31337;
	report.live = false;
	report.lifecycle = "complete";
	report.config.admin = recipe.governance.admin;
	report.recipe = undefined;
	const reportPath = path.join(root, "tasks", "data", "31337", "deployment-report.json");
	fs.mkdirSync(path.dirname(reportPath), { recursive: true });
	fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

	const prompts = [];
	const ui = {
		select: async options => {
			prompts.push(options);
			return options.options[0].value;
		},
		multiselect: async options => {
			prompts.push(options);
			return ["timing", "roles"];
		},
		confirm: async options => {
			prompts.push(options);
			return true;
		},
		text: async options => {
			prompts.push(options);
			if (/SIGNER ROLE/.test(options.message)) return "";
			return String(options.initialValue ?? ACCOUNTS[4]);
		},
		note: (message, title) => prompts.push({ type: "note", message, title }),
		runInteractive: async () => 0,
	};
	const input = await prepareExpressPatch({ root, ui, readReport: () => report });
	const patchRecipe = JSON.parse(fs.readFileSync(input.config, "utf8"));
	assert.equal(input.network, "localhost");
	assert.equal(patchRecipe.expressProvider.mode, "reuse");
	assert.equal(patchRecipe.expressProvider.roles.SIGNER_ROLE, undefined);
	assert.equal(patchRecipe.expressProvider.securityWindow, recipe.expressProvider.securityWindow);
	assert.match(prompts.find(prompt => /SIGNER ROLE/.test(prompt.message)).placeholder, /empty/i);
	assert.match(prompts.find(prompt => prompt.title === "Authoritative patch review").message, new RegExp(input.recipeDigest));
});
