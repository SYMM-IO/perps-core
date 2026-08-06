import { buildInitialRecipe, initializeRecipe } from "../commands/recipe.js";
import { buildVerifyTaskArgs, validateVerifyRecipeReport } from "../commands/verify.js";
import {
	assertDeploymentReportRecipeBinding,
	assertRecipeNetworkCompatibility,
	expectedRecipeNetworkMode,
	resolveRecipeEnvironment,
} from "../lib/recipe-context.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("recipe init derives live and fork intent from the reviewed Arbitrum profile", () => {
	const source = {
		$schema: "../recipe.schema.json",
		name: "example",
		network: { name: "arbitrum", chainId: 42161, mode: "live" },
		execution: { verify: true, logLevel: "verbose" },
	};
	const live = buildInitialRecipe("arbitrum", source);
	assert.equal(live.name, "arbitrum-deployment");
	assert.deepEqual(live.network, { name: "arbitrum", chainId: 42161, mode: "live" });
	assert.equal(live.execution.verify, true);

	const fork = buildInitialRecipe("fork-arbitrum", source);
	assert.equal(fork.name, "fork-arbitrum-deployment");
	assert.deepEqual(fork.network, { name: "fork-arbitrum", chainId: 42161, mode: "fork" });
	assert.equal(fork.execution.verify, false);
	assert.throws(() => buildInitialRecipe("base", source), /refusing to fabricate/);
});

test("recipe init writes the requested path, preserves editor schema resolution, and refuses accidental overwrite", () => {
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-recipe-cli-"));
	try {
		const outputPath = path.join(temporary, "nested", "arbitrum.json");
		const created = initializeRecipe({ network: "arbitrum", out: outputPath });
		assert.equal(created.outputPath, outputPath);
		const written = JSON.parse(fs.readFileSync(outputPath, "utf8"));
		assert.equal(written.network.name, "arbitrum");
		assert.equal(written.execution.verify, true);
		assert.equal(path.resolve(path.dirname(outputPath), written.$schema), path.resolve("deployment/deployment-recipe.schema.json"));
		assert.throws(() => initializeRecipe({ network: "arbitrum", out: outputPath }), /already exists/);
		assert.doesNotThrow(() => initializeRecipe({ network: "arbitrum", out: outputPath, force: true }));
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
});

test("recipe init creates a minimal standalone component recipe with a portable Core report reference", () => {
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-component-recipe-cli-"));
	try {
		const outputPath = path.join(temporary, "deployments", "add-partyb.json");
		const created = initializeRecipe({ network: "arbitrum", only: "partyB", out: outputPath });
		assert.equal(created.recipe.name, "arbitrum-partyB");
		assert.deepEqual(created.recipe.governance, { admin: "REPLACE_WITH_ADMIN_ADDRESS" });
		assert.equal(created.recipe.core.mode, "reuse");
		assert.equal(created.recipe.partyB.mode, "deploy");
		assert.deepEqual(created.recipe.symbolManager, { mode: "skip" });
		assert.deepEqual(created.recipe.expressProvider, { mode: "skip" });
		assert.equal(path.resolve(path.dirname(outputPath), created.recipe.core.fromReport), path.resolve("tasks/data/42161/deployment-report.json"));
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
});

test("doctor resolves only secret references named by the recipe and never reads a config file", () => {
	const projection = {
		env: { ADMIN_PUBLIC_KEY: "0x0000000000000000000000000000000000000001" },
		secrets: {
			deployer: { provider: "env", key: "TEST_RECIPE_DEPLOYER" },
			rpc: { provider: "hardhat-keystore", key: "RPC_ARBITRUM" },
			explorer: { provider: "env", key: "TEST_RECIPE_EXPLORER" },
		},
	};
	const resolved = resolveRecipeEnvironment(projection, {
		TEST_RECIPE_DEPLOYER: "0xsecret",
		UNRELATED_SECRET: "must-not-be-read",
	});
	assert.equal(resolved.env.NEW_DEPLOYER, "0xsecret");
	assert.equal(resolved.env.USE_KEYSTORE, undefined);
	assert.equal(resolved.env.UNRELATED_SECRET, undefined);
	assert.deepEqual(resolved.missingSecrets, [{ purpose: "explorer", key: "TEST_RECIPE_EXPLORER", field: "secrets.explorer" }]);
});

test("keystore metadata remains purpose-scoped in mixed-provider recipes", () => {
	const resolved = resolveRecipeEnvironment(
		{
			env: {},
			secrets: {
				deployer: { provider: "env", key: "MISSING_DEPLOYER" },
				rpc: { provider: "env", key: "EXPLICIT_RPC" },
				explorer: { provider: "hardhat-keystore", key: "ETHERSCAN_APIKEY" },
			},
		},
		{ EXPLICIT_RPC: "https://rpc.example" },
	);
	assert.equal(resolved.env.SYMMIO_RPC_URL_OVERRIDE, "https://rpc.example");
	assert.equal(resolved.env.NEW_DEPLOYER, undefined);
	assert.equal(resolved.env.USE_KEYSTORE, undefined);
	assert.deepEqual(resolved.missingSecrets, [{ purpose: "deployer", key: "MISSING_DEPLOYER", field: "secrets.deployer" }]);
});

test("recipe network mode is bound to the selected Hardhat network before RPC", () => {
	const liveChain = { key: "arbitrum", chainId: 42161 };
	const forkChain = { key: "fork-arbitrum", chainId: 42161, simulated: true };
	const localChain = { key: "localhost", chainId: 31337 };
	assert.equal(expectedRecipeNetworkMode(liveChain), "live");
	assert.equal(expectedRecipeNetworkMode(forkChain), "fork");
	assert.equal(expectedRecipeNetworkMode(localChain), "local");
	assert.doesNotThrow(() => assertRecipeNetworkCompatibility({ network: { name: "fork-arbitrum", chainId: 42161, mode: "fork" } }, forkChain));
	assert.throws(
		() => assertRecipeNetworkCompatibility({ network: { name: "fork-arbitrum", chainId: 42161, mode: "live" } }, forkChain),
		/network.mode: fork-arbitrum requires fork/,
	);
	assert.throws(
		() => assertRecipeNetworkCompatibility({ network: { name: "arbitrum", chainId: 42161, mode: "fork" } }, liveChain),
		/network.mode: arbitrum requires live/,
	);
});

test("full deployment evidence is digest-bound and remains portable across checkout paths", () => {
	const context = {
		path: "/repo/deployments/arbitrum.json",
		digest: "digest-1",
		recipe: {
			name: "arbitrum-release",
			core: { mode: "deploy" },
			partyB: { mode: "deploy" },
			symbolManager: { mode: "skip" },
			expressProvider: { mode: "skip" },
		},
	};
	const report = {
		recipe: {
			name: "arbitrum-release",
			path: "/old-clone/deployments/arbitrum.json",
			digest: "digest-1",
			components: { core: "deploy", partyB: "deploy", symbolManager: "skip", expressProvider: "skip" },
		},
	};
	assert.equal(assertDeploymentReportRecipeBinding(report, context), report.recipe);
	assert.throws(() => assertDeploymentReportRecipeBinding({ recipe: { ...report.recipe, digest: "older" } }, context), /recipe digest/);
	assert.throws(
		() =>
			assertDeploymentReportRecipeBinding(
				{ recipe: { ...report.recipe, components: { ...report.recipe.components, partyB: "skip" } } },
				context,
			),
		/component partyB/,
	);
});

test("verify task arguments preserve retry intent", () => {
	assert.deepEqual(buildVerifyTaskArgs("arbitrum"), ["verify:all", "--network", "arbitrum"]);
	assert.deepEqual(buildVerifyTaskArgs("arbitrum", { retryFailed: true }), ["verify:all", "--network", "arbitrum", "--retry-failed"]);
	assert.deepEqual(buildVerifyTaskArgs("arbitrum", { retryFailed: true, deploymentId: "deploy-1", recipeDigest: "abc" }), [
		"verify:all",
		"--network",
		"arbitrum",
		"--retry-failed",
		"--deployment-id",
		"deploy-1",
		"--recipe-digest",
		"abc",
	]);
});

test("recipe verification is bound to one full-system deployment attempt", () => {
	const context = {
		path: "/repo/deployments/arbitrum.json",
		digest: "digest-1",
		recipe: {
			name: "arbitrum-release",
			core: { mode: "deploy" },
			partyB: { mode: "skip" },
			symbolManager: { mode: "skip" },
			expressProvider: { mode: "skip" },
		},
	};
	const report = {
		deploymentId: "deploy-1",
		chainId: 42161,
		checks: { health: "passed", verificationPolicy: "required", verification: "failed" },
		recipe: {
			name: "arbitrum-release",
			path: "deployments/arbitrum.json",
			digest: "digest-1",
			components: { core: "deploy", partyB: "skip", symbolManager: "skip", expressProvider: "skip" },
		},
	};
	assert.equal(validateVerifyRecipeReport(report, { deploymentId: "deploy-1" }, context, 42161), report);
	assert.throws(() => validateVerifyRecipeReport(report, { deploymentId: "older" }, context, 42161), /another attempt's records/);
	assert.throws(
		() =>
			validateVerifyRecipeReport(
				report,
				null,
				{ ...context, recipe: { ...context.recipe, core: { mode: "reuse" }, partyB: { mode: "deploy" } } },
				42161,
			),
		/for full-system recipes only.*--only partyB/,
	);
});
