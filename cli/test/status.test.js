import {
	buildComponentStatusTaskArgs,
	buildStatusTaskArgs,
	componentStatusCheckpointScope,
	resolveStatusRecipeSelection,
	statusHardhatEnvironment,
	validateCheckpointReportBinding,
	validateComponentStatusCheckpoint,
	validateComponentStatusReport,
	validateStatusReport,
} from "../commands/status.js";
import assert from "node:assert/strict";
import test from "node:test";

const report = {
	deploymentId: "deploy-1",
	chainId: 42161,
	lifecycle: "pending_handover",
	deployerAddress: "0x0000000000000000000000000000000000000001",
	addresses: {
		diamond: "0x1000000000000000000000000000000000000001",
		accountLayerDiamond: "0x2000000000000000000000000000000000000002",
		instantLayer: "0x3000000000000000000000000000000000000003",
	},
	config: {
		liquidationInsuranceVault: "0x0000000000000000000000000000000000000006",
		maxLiquidationProfitPerPosition: "100000000000000000000",
		softLiquidationPenaltyCollector: "0x0000000000000000000000000000000000000007",
	},
	checks: { health: "passed", verification: "passed", verificationPolicy: "required" },
	manualActions: ["admin accepts both diamonds"],
};

test("an active checkpoint must be bound to the same deployment report", () => {
	assert.doesNotThrow(() => validateCheckpointReportBinding({ deploymentId: "deploy-1" }, report));
	assert.throws(() => validateCheckpointReportBinding({ deploymentId: "deploy-2" }, report), /report belongs to an earlier attempt/);
	assert.throws(() => validateCheckpointReportBinding({}, report), /missing deploymentId/);
});

test("status delegates to the canonical chain-scoped health check", () => {
	assert.deepEqual(buildStatusTaskArgs("arbitrum"), ["check:deployment", "--network", "arbitrum", "--from-report", "true"]);
	assert.deepEqual(buildStatusTaskArgs("arbitrum", { diamond: "0xoverride", "account-layer": "0xal" }), [
		"check:deployment",
		"--network",
		"arbitrum",
		"--from-report",
		"true",
		"--diamond",
		"0xoverride",
		"--account-layer",
		"0xal",
	]);
});

test("component status delegates to the exact read-only recipe checker", () => {
	assert.deepEqual(buildComponentStatusTaskArgs("arbitrum", "/repo/deployments/add-partyb.json", "partyB"), [
		"check:component",
		"--recipe",
		"/repo/deployments/add-partyb.json",
		"--component",
		"partyB",
		"--network",
		"arbitrum",
	]);
	assert.equal(componentStatusCheckpointScope("add-partyb", "partyB"), "component-add-partyb-partyB");
});

test("all recipe-backed status checks run without signer or explorer credentials", () => {
	assert.deepEqual(statusHardhatEnvironment({ path: "/repo/deployments/full.json", digest: "digest-1" }), {
		SYMMIO_DEPLOYMENT_RECIPE: "/repo/deployments/full.json",
		SYMMIO_DEPLOYMENT_RECIPE_DIGEST: "digest-1",
		DOTENV_CONFIG_PATH: "/dev/null",
		SYMMIO_RECIPE_READ_ONLY: "true",
	});
	assert.deepEqual(statusHardhatEnvironment(null), {});
});

test("status refuses system/component recipe mismatches with a menu-only recovery path", () => {
	const component = {
		path: "/repo/deployments/add-partyb.json",
		recipe: {
			core: { mode: "reuse" },
			partyB: { mode: "deploy" },
			symbolManager: { mode: "skip" },
		},
	};
	assert.throws(
		() => resolveStatusRecipeSelection(component, undefined, "deployments/add-partyb.json"),
		/component recipe.*partyB.*operator task.*deployments\/add-partyb\.json/,
	);
	assert.throws(
		() =>
			resolveStatusRecipeSelection(
				{ path: "/repo/deployments/full.json", recipe: { core: { mode: "deploy" } } },
				"partyB",
				"deployments/full.json",
			),
		/requires a component recipe with core.mode=reuse.*full deployment checklist/,
	);
});

const componentReport = {
	schemaVersion: 1,
	deploymentId: "component-1",
	recipe: { name: "add-partyb", digest: "digest-1", path: "/repo/deployments/add-partyb.json" },
	component: "partyB",
	network: "arbitrum",
	chainId: 42161,
	mode: "deploy",
	lifecycle: "complete",
	address: "0x1000000000000000000000000000000000000001",
	implementation: "0x2000000000000000000000000000000000000002",
	config: {
		admin: "0x4000000000000000000000000000000000000004",
		signer: "0x5000000000000000000000000000000000000005",
		adlEnabled: true,
	},
	coreDependency: {
		reportPath: "/repo/tasks/data/42161/deployment-report.json",
		deploymentId: "core-1",
		diamond: "0x3000000000000000000000000000000000000003",
		instantLayer: "0x6000000000000000000000000000000000000006",
	},
	verification: {
		policy: "not_applicable",
		status: "skipped",
		records: [
			{ name: "SymmioPartyB", address: "0x2000000000000000000000000000000000000002", constructorArguments: [] },
			{ name: "LocalERC1967Proxy", address: "0x1000000000000000000000000000000000000001", constructorArguments: [] },
		],
	},
	health: { status: "passed", checks: [{ check: "runtime bytecode", status: "passed" }] },
	manualActions: [],
};

const componentExpected = {
	component: "partyB",
	networkName: "arbitrum",
	chainId: 42161,
	recipeName: "add-partyb",
	recipeDigest: "digest-1",
	recipePath: "/repo/deployments/add-partyb.json",
	live: false,
	config: {
		admin: "0x4000000000000000000000000000000000000004",
		signer: "0x5000000000000000000000000000000000000005",
		adlEnabled: true,
	},
	coreReportPath: "/repo/tasks/data/42161/deployment-report.json",
	coreReport: {
		deploymentId: "core-1",
		addresses: {
			diamond: "0x3000000000000000000000000000000000000003",
			instantLayer: "0x6000000000000000000000000000000000000006",
		},
	},
};

test("component status report is bound to its recipe and reused Core report", () => {
	assert.equal(validateComponentStatusReport(componentReport, componentExpected), componentReport);
	assert.throws(
		() =>
			validateComponentStatusReport(
				{ ...componentReport, coreDependency: { ...componentReport.coreDependency, deploymentId: "old-core" } },
				componentExpected,
			),
		/Core deploymentId/,
	);
	assert.throws(
		() =>
			validateComponentStatusReport(
				{ ...componentReport, recipe: { ...componentReport.recipe, path: "/repo/deployments/other.json" } },
				componentExpected,
			),
		/recipe path/,
	);
});

test("component status checkpoint must be the exact scoped attempt and lifecycle", () => {
	const scope = "component-add-partyb-partyB";
	const checkpoint = {
		deploymentId: "component-1",
		scope,
		network: "arbitrum",
		chainId: 42161,
		step: "complete",
		manifest: { deploymentId: "component-1" },
		contracts: {
			symmioPartyB: {
				address: componentReport.address,
				implementation: componentReport.implementation,
			},
		},
	};
	const expected = { component: "partyB", scope, networkName: "arbitrum", chainId: 42161, path: "/repo/checkpoint.json" };
	assert.equal(validateComponentStatusCheckpoint(checkpoint, componentReport, expected), checkpoint);
	assert.throws(() => validateComponentStatusCheckpoint({ ...checkpoint, scope: "component-other-partyB" }, componentReport, expected), /scope/);
	assert.throws(
		() => validateComponentStatusCheckpoint({ ...checkpoint, step: "pending_handover" }, componentReport, expected),
		/lifecycle.*stale/,
	);
	assert.throws(() => validateComponentStatusCheckpoint(null, componentReport, expected), /checkpoint is missing/);
});

test("GaslessLayer component status binds the AccountLayer, proxy, and implementation", () => {
	const gaslessReport = {
		...componentReport,
		recipe: { name: "add-gasless", digest: "gasless-digest", path: "/repo/deployments/add-gasless.json" },
		component: "gaslessLayer",
		config: {
			admin: "0x4000000000000000000000000000000000000004",
			gaslessLayer: { relayers: ["0x7000000000000000000000000000000000000007"] },
		},
		coreDependency: {
			...componentReport.coreDependency,
			accountLayer: "0x7000000000000000000000000000000000000007",
		},
	};
	const gaslessExpected = {
		...componentExpected,
		component: "gaslessLayer",
		recipeName: "add-gasless",
		recipeDigest: "gasless-digest",
		recipePath: "/repo/deployments/add-gasless.json",
		config: { admin: "0x4000000000000000000000000000000000000004" },
		coreReport: {
			...componentExpected.coreReport,
			addresses: {
				...componentExpected.coreReport.addresses,
				accountLayerDiamond: "0x7000000000000000000000000000000000000007",
			},
		},
	};
	assert.equal(validateComponentStatusReport(gaslessReport, gaslessExpected), gaslessReport);
	assert.throws(
		() =>
			validateComponentStatusReport(
				{ ...gaslessReport, coreDependency: { ...gaslessReport.coreDependency, accountLayer: "0x8000000000000000000000000000000000000008" } },
				gaslessExpected,
			),
		/AccountLayer|accountLayer/,
	);

	const checkpoint = {
		deploymentId: gaslessReport.deploymentId,
		scope: "component-add-gasless-gaslessLayer",
		network: "arbitrum",
		chainId: 42161,
		step: "complete",
		manifest: { deploymentId: gaslessReport.deploymentId },
		contracts: {
			gaslessLayer: {
				proxy: { address: gaslessReport.address },
				implementation: { address: gaslessReport.implementation },
			},
		},
	};
	assert.equal(
		validateComponentStatusCheckpoint(checkpoint, gaslessReport, {
			component: "gaslessLayer",
			scope: checkpoint.scope,
			networkName: "arbitrum",
			chainId: 42161,
			path: "/repo/checkpoint.json",
		}),
		checkpoint,
	);
});

test("status rejects incomplete, wrong-chain and unknown-lifecycle reports", () => {
	assert.equal(validateStatusReport(report, 42161, { requireVerification: true }), report);
	assert.throws(() => validateStatusReport({ ...report, chainId: 8453 }, 42161), /chainId mismatch/);
	assert.throws(() => validateStatusReport({ ...report, lifecycle: "maybe" }, 42161), /unknown lifecycle/);
	assert.throws(
		() => validateStatusReport({ ...report, addresses: { diamond: "0x1000000000000000000000000000000000000001" } }, 42161),
		/accountLayerDiamond/,
	);
	assert.throws(() => validateStatusReport({ ...report, manualActions: "do it" }, 42161), /must be an array/);
	assert.throws(() => validateStatusReport({ ...report, lifecycle: "failed" }, 42161), /not in a successful lifecycle/);
	assert.throws(
		() => validateStatusReport({ ...report, config: { ...report.config, maxLiquidationProfitPerPosition: "0" } }, 42161),
		/config.maxLiquidationProfitPerPosition/,
	);
	assert.throws(() => validateStatusReport({ ...report, checks: { ...report.checks, health: "failed" } }, 42161), /health gate/);
	assert.throws(
		() => validateStatusReport({ ...report, checks: { ...report.checks, verification: "skipped" } }, 42161, { requireVerification: true }),
		/verification is not passed/,
	);
});

test("config-based status refuses a chain-scoped report from another recipe", () => {
	const recipeContext = {
		path: "/repo/deployments/current.json",
		digest: "current-digest",
		recipe: {
			name: "current",
			core: { mode: "deploy" },
			partyB: { mode: "skip" },
			symbolManager: { mode: "skip" },
			expressProvider: { mode: "skip" },
			gaslessLayer: { mode: "skip" },
		},
	};
	const bound = {
		...report,
		recipe: {
			name: "current",
			path: "/repo/deployments/current.json",
			digest: "current-digest",
			components: { core: "deploy", partyB: "skip", symbolManager: "skip", expressProvider: "skip", gaslessLayer: "skip" },
		},
	};
	assert.equal(validateStatusReport(bound, 42161, { recipeContext }), bound);
	assert.throws(() => validateStatusReport({ ...bound, recipe: { ...bound.recipe, name: "older" } }, 42161, { recipeContext }), /recipe name/);
});
