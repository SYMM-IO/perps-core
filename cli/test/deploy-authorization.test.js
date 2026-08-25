import {
	componentReportPath,
	deploymentBuildInvocation,
	deploymentPlanRows,
	deploymentTaskInvocation,
	deploymentLifecycleExitCode,
	expectedDeploymentCheckpointPath,
	effectiveVerification,
	liquidationPlanValues,
	validateComponentReport,
	validateDeploymentAuthorization,
	validateDeploymentHandoff,
} from "../commands/deploy.js";
import assert from "node:assert/strict";
import test from "node:test";

test("mainnet refuses force overrides", () => {
	assert.throws(() => validateDeploymentAuthorization({ mainnet: true, force: true, networkName: "arbitrum" }), /--force is refused on mainnet/);
});

test("mainnet refuses deployments that skip explorer verification", () => {
	assert.throws(
		() => validateDeploymentAuthorization({ mainnet: true, noVerify: true, networkName: "arbitrum" }),
		/--no-verify is refused on live mainnets/,
	);
});

test("mainnet non-interactive confirmation must repeat the exact network", () => {
	assert.throws(
		() => validateDeploymentAuthorization({ mainnet: true, yes: true, networkName: "arbitrum" }),
		/requires --confirm-network arbitrum/,
	);
	assert.throws(
		() =>
			validateDeploymentAuthorization({
				mainnet: true,
				yes: true,
				confirmNetwork: "base",
				networkName: "arbitrum",
			}),
		/requires --confirm-network arbitrum/,
	);
	assert.doesNotThrow(() =>
		validateDeploymentAuthorization({
			mainnet: true,
			yes: true,
			confirmNetwork: "arbitrum",
			networkName: "arbitrum",
		}),
	);
});

test("confirm-network cannot be supplied without yes and simulations may use force", () => {
	assert.throws(
		() => validateDeploymentAuthorization({ mainnet: false, confirmNetwork: "fork-arbitrum", networkName: "fork-arbitrum" }),
		/only valid together with --yes/,
	);
	assert.doesNotThrow(() => validateDeploymentAuthorization({ mainnet: false, force: true, yes: false, networkName: "fork-arbitrum" }));
});

test("recipe verification is authoritative and can only be further disabled off mainnet", () => {
	const recipe = { execution: { verify: true } };
	assert.equal(effectiveVerification({ recipe, mainnet: false }), true);
	assert.equal(effectiveVerification({ recipe, noVerify: true, mainnet: false }), false);
	assert.equal(effectiveVerification({ recipe, simulated: true, mainnet: false }), false);
	assert.throws(() => effectiveVerification({ recipe, noVerify: true, mainnet: true }), /refused on live mainnets/);
	assert.throws(() => effectiveVerification({ recipe: { execution: { verify: false } }, mainnet: true }), /execution.verify must be true/);
});

test("recipe deployments pass an absolute recipe path and disable dotenv loading", () => {
	const recipeContext = { path: "/repo/deployment-recipes/arbitrum.json", digest: "recipe-digest" };
	assert.deepEqual(deploymentBuildInvocation(recipeContext), {
		args: ["--build-profile", "production", "build"],
		env: {
			SYMMIO_DEPLOYMENT_RECIPE: "/repo/deployment-recipes/arbitrum.json",
			SYMMIO_DEPLOYMENT_RECIPE_DIGEST: "recipe-digest",
			DOTENV_CONFIG_PATH: "/dev/null",
			SYMMIO_RECIPE_READ_ONLY: "true",
		},
	});
	assert.deepEqual(
		deploymentTaskInvocation({
			recipeContext,
			only: "partyB",
			networkName: "arbitrum",
			fresh: true,
			verify: true,
			logLevel: "minimal",
		}),
		{
			args: [
				"deploy:component",
				"--recipe",
				"/repo/deployment-recipes/arbitrum.json",
				"--component",
				"partyB",
				"--fresh",
				"true",
				"--verify",
				"true",
				"--network",
				"arbitrum",
			],
			env: {
				DEPLOY_LOG_LEVEL: "minimal",
				SYMMIO_DEPLOYMENT_RECIPE: "/repo/deployment-recipes/arbitrum.json",
				SYMMIO_DEPLOYMENT_RECIPE_DIGEST: "recipe-digest",
				DOTENV_CONFIG_PATH: "/dev/null",
			},
		},
	);

	const full = deploymentTaskInvocation({ recipeContext, networkName: "arbitrum", verify: false });
	assert.deepEqual(full.args, ["deploy:system", "--network", "arbitrum", "--fresh", "false", "--verify", "false"]);
	assert.throws(() => deploymentTaskInvocation({ recipeContext, only: "core", networkName: "arbitrum" }), /Core is a system bundle/);
});

test("recipe plan rows expose target, mode, and declared dependencies", () => {
	assert.deepEqual(
		deploymentPlanRows({
			only: "partyB",
			components: [
				{ name: "core", mode: "reuse", dependsOn: [] },
				{ name: "partyB", mode: "deploy", dependsOn: ["core"] },
			],
		}),
		[
			["dependency", "core", "reuse", "none"],
			["selected", "partyB", "deploy", "core"],
		],
	);
});

test("persistent deploy exits distinguish complete state from pending admin handover", () => {
	assert.equal(deploymentLifecycleExitCode({ lifecycle: "complete" }), 0);
	assert.equal(deploymentLifecycleExitCode({ lifecycle: "pending_handover" }), 2);
	assert.equal(deploymentLifecycleExitCode({ lifecycle: "pending_handover" }, { simulated: true }), 0);
	assert.equal(deploymentLifecycleExitCode({ lifecycle: "failed" }), 1);
});

test("deployment failure recovery checks the exact full or component checkpoint", () => {
	assert.match(expectedDeploymentCheckpointPath(42161), /checkpoint-42161\.json$/);
	assert.match(expectedDeploymentCheckpointPath(42161, { simulated: true }), /checkpoint-42161-fork\.json$/);
	assert.match(
		expectedDeploymentCheckpointPath(42161, {
			recipeContext: { recipe: { name: "add-partyb" } },
			only: "partyB",
		}),
		/checkpoint-42161-component-add-partyb-partyB\.json$/,
	);
});

test("component handoff evidence is bound to the recipe, target, lifecycle, and Safe actions", () => {
	const expected = {
		component: "partyB",
		networkName: "arbitrum",
		chainId: 42161,
		recipeName: "add-partyb",
		recipeDigest: "abc123",
		recipePath: "/repo/deployment-recipes/add-partyb.json",
		live: true,
		config: {
			admin: "0x4000000000000000000000000000000000000004",
			signer: "0x5000000000000000000000000000000000000005",
			adlEnabled: true,
		},
	};
	const report = {
		schemaVersion: 1,
		deploymentId: "component-1",
		recipe: { name: "add-partyb", digest: "abc123", path: "/repo/deployment-recipes/add-partyb.json" },
		component: "partyB",
		network: "arbitrum",
		chainId: 42161,
		mode: "deploy",
		lifecycle: "pending_handover",
		address: "0x1000000000000000000000000000000000000001",
		implementation: "0x2000000000000000000000000000000000000002",
		config: {
			admin: "0x4000000000000000000000000000000000000004",
			signer: "0x5000000000000000000000000000000000000005",
			adlEnabled: true,
		},
		verification: {
			policy: "required",
			status: "passed",
			records: [
				{
					name: "contracts/helpers/accounts/SymmioPartyB.sol:SymmioPartyB",
					address: "0x2000000000000000000000000000000000000002",
					constructorArguments: [],
				},
				{
					name: "contracts/helpers/utils/LocalERC1967Proxy.sol:LocalERC1967Proxy",
					address: "0x1000000000000000000000000000000000000001",
					constructorArguments: ["0x2000000000000000000000000000000000000002", "0x1234"],
				},
			],
		},
		health: { status: "pending", checks: [{ check: "core PartyB registration", status: "pending" }] },
		manualActions: [
			{
				to: "0x3000000000000000000000000000000000000003",
				value: "0",
				data: "0x1234",
				description: "Admin registers PartyB",
			},
		],
	};
	assert.equal(validateComponentReport(report, expected), report);
	assert.equal(
		validateComponentReport({ ...report, recipe: { ...report.recipe, path: "deployment-recipes/add-partyb.json" } }, expected).deploymentId,
		"component-1",
	);
	assert.throws(() => validateComponentReport({ ...report, lifecycle: "validating" }, expected), /successful lifecycle/);
	assert.throws(() => validateComponentReport({ ...report, recipe: { ...report.recipe, digest: "wrong" } }, expected), /recipe digest/);
	assert.throws(() => validateComponentReport({ ...report, implementation: undefined }, expected), /implementation address/);
	assert.throws(
		() => validateComponentReport({ ...report, verification: { ...report.verification, status: "pending" } }, expected),
		/live component verification is incomplete/,
	);
	assert.throws(
		() => validateComponentReport({ ...report, config: { ...report.config, signer: "0x6000000000000000000000000000000000000006" } }, expected),
		/config.signer/,
	);
	assert.throws(
		() => validateComponentReport({ ...report, verification: { ...report.verification, records: [] } }, expected),
		/do not cover deployed partyB address/,
	);
	assert.throws(
		() => validateComponentReport({ ...report, manualActions: [{ ...report.manualActions[0], data: "not-calldata" }] }, expected),
		/hexadecimal calldata/,
	);

	const completeSymbolManager = {
		...report,
		component: "symbolManager",
		lifecycle: "complete",
		implementation: undefined,
		config: {
			admin: "0x4000000000000000000000000000000000000004",
			operator: "0x6000000000000000000000000000000000000006",
		},
		verification: {
			policy: "not_applicable",
			status: "skipped",
			records: [
				{
					name: "contracts/helpers/symbolManager/SymmioSymbolManager.sol:SymmioSymbolManager",
					address: "0x1000000000000000000000000000000000000001",
					constructorArguments: [],
				},
			],
		},
		health: { status: "passed", checks: [{ check: "runtime bytecode", status: "passed" }] },
		manualActions: [],
	};
	assert.equal(
		validateComponentReport(completeSymbolManager, {
			...expected,
			component: "symbolManager",
			live: false,
			config: {
				admin: "0x4000000000000000000000000000000000000004",
				operator: "0x6000000000000000000000000000000000000006",
			},
		}),
		completeSymbolManager,
	);
	const completeExpressPatch = {
		...completeSymbolManager,
		component: "expressProvider",
		mode: "patch",
		config: { admin: "0x4000000000000000000000000000000000000004", expressProvider: {} },
		verification: { policy: "not_applicable", status: "skipped", records: [] },
		health: { status: "passed", checks: [{ check: "provider already matches the recipe", status: "passed" }] },
	};
	assert.equal(
		validateComponentReport(completeExpressPatch, {
			...expected,
			component: "expressProvider",
			live: true,
			config: { admin: "0x4000000000000000000000000000000000000004" },
		}),
		completeExpressPatch,
	);
	assert.throws(
		() =>
			validateComponentReport(
				{
					...completeExpressPatch,
					verification: { ...completeExpressPatch.verification, records: completeSymbolManager.verification.records },
				},
				{
					...expected,
					component: "expressProvider",
					live: true,
					config: { admin: "0x4000000000000000000000000000000000000004" },
				},
			),
		/patch verification records must be empty/,
	);

	const completeGaslessLayer = {
		...completeSymbolManager,
		component: "gaslessLayer",
		implementation: "0x2000000000000000000000000000000000000002",
		config: { admin: "0x4000000000000000000000000000000000000004", gaslessLayer: { relayers: [] } },
		verification: {
			policy: "not_applicable",
			status: "skipped",
			records: [
				{
					name: "contracts/gaslessLayer/GaslessLayer.sol:GaslessLayer",
					address: "0x2000000000000000000000000000000000000002",
					constructorArguments: [],
				},
				{
					name: "contracts/helpers/utils/LocalERC1967Proxy.sol:LocalERC1967Proxy",
					address: "0x1000000000000000000000000000000000000001",
					constructorArguments: [],
				},
			],
		},
	};
	const gaslessExpected = {
		...expected,
		component: "gaslessLayer",
		live: false,
		config: { admin: "0x4000000000000000000000000000000000000004" },
	};
	assert.equal(validateComponentReport(completeGaslessLayer, gaslessExpected), completeGaslessLayer);
	assert.throws(() => validateComponentReport({ ...completeGaslessLayer, implementation: undefined }, gaslessExpected), /implementation address/);
	assert.throws(
		() => validateComponentReport({ ...completeGaslessLayer, config: { admin: completeGaslessLayer.config.admin } }, gaslessExpected),
		/missing its resolved configuration/,
	);
	assert.match(
		componentReportPath(42161, { simulated: true, recipeName: "add-partyb", component: "partyB" }),
		/tasks\/data\/42161-fork\/components\/add-partyb\/partyB-report\.json$/,
	);
});

test("deployment plan describes the same liquidation defaults the deploy task resolves", () => {
	assert.deepEqual(liquidationPlanValues({}, 31337), {
		vault: "(defaults to admin locally)",
		maxProfit: "(defaults to 100e18 locally)",
		collector: "(defaults to admin locally)",
	});
	assert.deepEqual(liquidationPlanValues({}, 42161), {
		vault: "(required for mainnet/fork)",
		maxProfit: "(required for mainnet/fork)",
		collector: "(required for mainnet/fork)",
	});
});

test("deployment handoff requires both diamonds and the real SymbolManager address", () => {
	const report = {
		chainId: 42161,
		lifecycle: "pending_handover",
		deployerAddress: "0x0000000000000000000000000000000000000001",
		addresses: {
			diamond: "0x1000000000000000000000000000000000000001",
			accountLayerDiamond: "0x2000000000000000000000000000000000000002",
			instantLayer: "0x3000000000000000000000000000000000000003",
			symbolManager: "0x4000000000000000000000000000000000000004",
		},
		config: {
			deploySymbolManager: true,
			liquidationInsuranceVault: "0x0000000000000000000000000000000000000006",
			maxLiquidationProfitPerPosition: "100000000000000000000",
			softLiquidationPenaltyCollector: "0x0000000000000000000000000000000000000007",
		},
		checks: { health: "passed", verification: "passed", verificationPolicy: "required" },
		manualActions: ["admin accepts Core", "admin accepts AccountLayer", "admin grants SymbolManager roles"],
	};
	assert.equal(validateDeploymentHandoff(report, 42161), report);
	assert.throws(
		() => validateDeploymentHandoff({ ...report, addresses: { ...report.addresses, accountLayerDiamond: "" } }, 42161),
		/accountLayerDiamond/,
	);
	assert.throws(
		() => validateDeploymentHandoff({ ...report, addresses: { ...report.addresses, symbolManager: "" } }, 42161),
		/SymbolManager enabled/,
	);
	assert.throws(() => validateDeploymentHandoff({ ...report, manualActions: [] }, 42161), /pending_handover/);
	assert.throws(
		() => validateDeploymentHandoff({ ...report, config: { ...report.config, liquidationInsuranceVault: "" } }, 42161),
		/config.liquidationInsuranceVault/,
	);
	assert.equal(validateDeploymentHandoff(report, 42161, { requireVerification: true }), report);
	assert.throws(
		() =>
			validateDeploymentHandoff({ ...report, checks: { ...report.checks, verification: "skipped" } }, 42161, {
				requireVerification: true,
			}),
		/explorer verification is not passed/,
	);

	const recipeContext = {
		path: "/repo/deployment-recipes/release.json",
		digest: "digest-1",
		recipe: {
			name: "release",
			core: { mode: "deploy" },
			partyB: { mode: "deploy" },
			symbolManager: { mode: "deploy" },
			expressProvider: { mode: "skip" },
			gaslessLayer: { mode: "skip" },
		},
	};
	const boundReport = {
		...report,
		recipe: {
			name: "release",
			path: "/repo/deployment-recipes/release.json",
			digest: "digest-1",
			components: { core: "deploy", partyB: "deploy", symbolManager: "deploy", expressProvider: "skip", gaslessLayer: "skip" },
		},
	};
	assert.equal(validateDeploymentHandoff(boundReport, 42161, { recipeContext }), boundReport);
	assert.throws(
		() => validateDeploymentHandoff({ ...boundReport, recipe: { ...boundReport.recipe, digest: "stale" } }, 42161, { recipeContext }),
		/recipe digest/,
	);
});
