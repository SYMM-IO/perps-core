import {
	createDeploymentPlan,
	loadCoreDependencyReport,
	loadDeploymentRecipe,
	parseSecretRef,
	parseCoreDependencyReport,
	recipeDigest,
	recipeEnvironment,
	validateDeploymentRecipe,
} from "../../deployment/recipe.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const A = "0x1000000000000000000000000000000000000001";
const B = "0x2000000000000000000000000000000000000002";
const C = "0x3000000000000000000000000000000000000003";
const D = "0x4000000000000000000000000000000000000004";

function protocol() {
	return {
		description: "test protocol",
		parameters: {
			balanceLimitPerUser: "1",
			maxWithdrawParts: 1,
			deallocateCooldown: 1,
			settlementCooldown: 1,
			deallocateDebounceTime: 0,
			liquidatorShare: "1",
			liquidationTimeout: 1,
			forceCloseCooldowns: [1, 1],
			forceCancelCooldown: 1,
			forceCancelCloseCooldown: 1,
			pendingQuotesValidLength: 1,
			maxPartyAConnectionLimit: 1,
		},
		instantLayerTemplates: [
			{
				name: "Template",
				operations: [{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }],
			},
		],
	};
}

function localRecipe() {
	return {
		apiVersion: "deployment.symm.io/v1",
		kind: "DeploymentRecipe",
		name: "local-test",
		network: { name: "localhost", chainId: 31337, mode: "local" },
		secrets: {},
		execution: { logLevel: "verbose", verify: false },
		governance: {
			admin: A,
			feeReceiver: A,
			liquidationInsuranceVault: B,
			maxLiquidationProfitPerPosition: "1",
			softLiquidationPenaltyCollector: C,
		},
		core: {
			mode: "deploy",
			create2: { vanityPrefix: "573310" },
			collateral: { mode: "deploy" },
			muon: { mode: "mock", upnlValidTime: "300", priceValidTime: "300" },
			protocol: protocol(),
			setupInstantLayerTemplates: true,
			registerDummyAffiliate: false,
		},
		partyB: { mode: "skip", adlEnabled: false },
		symbolManager: { mode: "skip" },
		expressProvider: { mode: "skip" },
	};
}

function coreDependencyReport() {
	return {
		deploymentId: "deployment-1",
		network: "arbitrum",
		chainId: 42161,
		lifecycle: "complete",
		checks: { health: "passed", verification: "skipped", verificationPolicy: "not_applicable" },
		deployerAddress: A,
		config: { admin: B },
		addresses: { diamond: C, instantLayer: D },
	};
}

test("recipe validation is strict at every layer and enforces conditional addresses and uint strings", () => {
	assert.equal(validateDeploymentRecipe(localRecipe()).name, "local-test");
	const withSchema = localRecipe();
	withSchema.$schema = "../deployment-recipe.schema.json";
	assert.equal(validateDeploymentRecipe(withSchema).$schema, "../deployment-recipe.schema.json");

	const unknownRoot = { ...localRecipe(), typo: true };
	assert.throws(() => validateDeploymentRecipe(unknownRoot), /recipe\.typo is not a supported field/);

	const unknownNested = localRecipe();
	unknownNested.core.collateral.typo = true;
	assert.throws(() => validateDeploymentRecipe(unknownNested), /core\.collateral\.typo is not a supported field/);

	const zeroAdmin = localRecipe();
	zeroAdmin.governance.admin = "0x0000000000000000000000000000000000000000";
	assert.throws(() => validateDeploymentRecipe(zeroAdmin), /governance\.admin must not be the zero address/);

	const nonCanonicalUint = localRecipe();
	nonCanonicalUint.governance.maxLiquidationProfitPerPosition = "01";
	assert.throws(() => validateDeploymentRecipe(nonCanonicalUint), /canonical unsigned base-10 integer string/);

	const reuseWithoutAddress = localRecipe();
	reuseWithoutAddress.partyB = { mode: "reuse", adlEnabled: false };
	assert.throws(() => validateDeploymentRecipe(reuseWithoutAddress), /partyB\.address is required/);

	const deployWithAddress = localRecipe();
	deployWithAddress.expressProvider = { mode: "deploy", address: D };
	assert.throws(() => validateDeploymentRecipe(deployWithAddress), /expressProvider\.address must be omitted when mode is deploy/);

	const unsafeName = localRecipe();
	unsafeName.name = "../checkpoint";
	assert.throws(() => validateDeploymentRecipe(unsafeName), /must be a safe 1-128 character slug/);

	const invalidVanity = localRecipe();
	invalidVanity.core.create2.vanityPrefix = "abc";
	assert.throws(() => validateDeploymentRecipe(invalidVanity), /2, 4, 6, or 8 hexadecimal characters/);

	const minimalCoreReuse = localRecipe();
	minimalCoreReuse.core = { mode: "reuse", fromReport: "../tasks/data/42161/deployment-report.json" };
	minimalCoreReuse.governance = { admin: A };
	assert.equal(validateDeploymentRecipe(minimalCoreReuse).core.mode, "reuse");
});

test("execution policy uses task-compatible ranges and fork-only block pinning", () => {
	const recipe = localRecipe();
	recipe.execution.confirmations = 65;
	assert.throws(() => validateDeploymentRecipe(recipe), /execution\.confirmations must be <= 64/);

	recipe.execution.confirmations = 1;
	recipe.execution.txTimeoutSeconds = 29;
	assert.throws(() => validateDeploymentRecipe(recipe), /execution\.txTimeoutSeconds must be a safe integer >= 30/);

	recipe.execution.txTimeoutSeconds = 30;
	recipe.execution.slowNoticeSeconds = 30;
	assert.throws(() => validateDeploymentRecipe(recipe), /slowNoticeSeconds must be less than txTimeoutSeconds/);

	recipe.execution.txTimeoutSeconds = 60;
	recipe.execution.slowNoticeSeconds = 5;
	recipe.execution.forkBlockNumber = 123;
	assert.throws(() => validateDeploymentRecipe(recipe), /forkBlockNumber is only allowed when network.mode is fork/);
	recipe.network = { name: "fork-arbitrum", chainId: 42161, mode: "fork" };
	assert.equal(recipeEnvironment(recipe).env.FORK_BLOCK_NUMBER, "123");
});

test("secret references are metadata only and live recipes require the appropriate references", () => {
	assert.deepEqual(parseSecretRef("hardhat-keystore://NEW_DEPLOYER"), {
		provider: "hardhat-keystore",
		key: "NEW_DEPLOYER",
	});
	assert.deepEqual(parseSecretRef("env://RPC_ARBITRUM"), { provider: "env", key: "RPC_ARBITRUM" });
	assert.throws(() => parseSecretRef("0xfeed"), /inline secret values are forbidden/);
	assert.throws(() => parseSecretRef("file:\/\/secret"), /hardhat-keystore:\/\/KEY or env:\/\/KEY/);

	const live = localRecipe();
	live.network = { name: "arbitrum", chainId: 42161, mode: "live" };
	live.execution.verify = true;
	live.core.collateral = { mode: "reuse", address: D };
	live.core.muon = {
		mode: "reuse",
		address: C,
		appId: "1",
		upnlValidTime: "60",
		priceValidTime: "60",
		permissions: [
			"Trading",
			"AccountManagement",
			"Settlement",
			"ForceClose",
			"Funding",
			"LiquidationPartyA",
			"LiquidationPartyB",
			"RemoveMargin",
		],
	};
	assert.throws(() => validateDeploymentRecipe(live), /secrets\.deployer is required/);
	live.secrets = { deployer: "hardhat-keystore://NEW_DEPLOYER", rpc: "hardhat-keystore://RPC_ARBITRUM" };
	assert.throws(() => validateDeploymentRecipe(live), /secrets\.explorer is required/);
	live.secrets.explorer = "hardhat-keystore://ETHERSCAN_APIKEY";
	assert.equal(validateDeploymentRecipe(live).network.mode, "live");
	live.execution.logLevel = "silent";
	assert.throws(() => validateDeploymentRecipe(live), /execution\.logLevel must be minimal or verbose for live targets/);
	live.execution.logLevel = "verbose";
	live.execution.verify = false;
	assert.throws(() => validateDeploymentRecipe(live), /execution\.verify must be true for live targets/);
});

test("planner supports one-go and component-only runs without silently deploying dependencies", () => {
	const recipe = localRecipe();
	recipe.partyB = { mode: "deploy", signer: B, adlEnabled: true };
	recipe.symbolManager = { mode: "deploy", operator: C };

	assert.deepEqual(createDeploymentPlan(recipe).components, [
		{ name: "core", mode: "deploy", dependsOn: [] },
		{ name: "partyB", mode: "deploy", dependsOn: ["core"] },
		{ name: "symbolManager", mode: "deploy", dependsOn: ["core"] },
		{ name: "expressProvider", mode: "skip", dependsOn: ["core"] },
	]);
	const onlyRecipe = structuredClone(recipe);
	onlyRecipe.core.mode = "reuse";
	onlyRecipe.core.fromReport = "reports/core.json";
	assert.deepEqual(createDeploymentPlan(onlyRecipe, { only: "partyB" }).components, [
		{ name: "core", mode: "reuse", dependsOn: [] },
		{ name: "partyB", mode: "deploy", dependsOn: ["core"] },
	]);
	assert.throws(
		() => createDeploymentPlan(onlyRecipe, { only: "expressProvider" }),
		error => error.code === "TARGET_MODE_UNSUPPORTED",
	);

	const missingProof = localRecipe();
	missingProof.partyB = { mode: "deploy", signer: B, adlEnabled: false };
	assert.throws(
		() => createDeploymentPlan(missingProof, { only: "partyB" }),
		error => error.code === "CORE_DEPENDENCY_UNPROVEN",
	);

	const reusedCore = localRecipe();
	reusedCore.core.mode = "reuse";
	reusedCore.core.fromReport = "reports/core.json";
	reusedCore.partyB = { mode: "deploy", signer: B, adlEnabled: false };
	assert.throws(
		() => createDeploymentPlan(reusedCore),
		error => error.code === "TARGET_MODE_UNSUPPORTED",
	);
	assert.equal(createDeploymentPlan(reusedCore, { only: "partyB" }).only, "partyB");

	const reusedAddon = localRecipe();
	reusedAddon.partyB = { mode: "reuse", address: D, adlEnabled: false };
	assert.throws(
		() => createDeploymentPlan(reusedAddon),
		error => error.code === "TARGET_MODE_UNSUPPORTED",
	);
	assert.throws(
		() => createDeploymentPlan(localRecipe(), { only: "core" }),
		error => error.code === "TARGET_MODE_UNSUPPORTED" && /system bundle/.test(error.message),
	);
	const reusedExpress = localRecipe();
	reusedExpress.expressProvider = { mode: "reuse", address: D };
	assert.throws(
		() => createDeploymentPlan(reusedExpress),
		error => error.code === "TARGET_MODE_UNSUPPORTED" && /expressProvider/.test(error.message),
	);
});

test("recipe digest is stable across JSON object key order", () => {
	const recipe = localRecipe();
	const reversed = Object.fromEntries(Object.entries(recipe).reverse());
	assert.match(recipeDigest(recipe), /^[0-9a-f]{64}$/);
	assert.equal(recipeDigest(recipe), recipeDigest(reversed));
	const changed = localRecipe();
	changed.name = "changed";
	assert.notEqual(recipeDigest(recipe), recipeDigest(changed));
	const editorMetadata = localRecipe();
	editorMetadata.$schema = "../../somewhere/deployment-recipe.schema.json";
	assert.equal(recipeDigest(recipe), recipeDigest(editorMetadata));
});

test("loader normalizes recipe and report paths", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-recipe-"));
	const recipe = localRecipe();
	recipe.core.mode = "reuse";
	recipe.core.fromReport = "reports/deployment-report.json";
	const file = path.join(directory, "recipe.json");
	const reportFile = path.join(directory, "reports", "deployment-report.json");
	fs.mkdirSync(path.dirname(reportFile), { recursive: true });
	fs.writeFileSync(reportFile, JSON.stringify(coreDependencyReport()));
	fs.writeFileSync(file, JSON.stringify(recipe));

	const loaded = loadDeploymentRecipe("recipe.json", { projectRoot: directory });
	assert.equal(loaded.path, file);
	assert.equal(loaded.recipe.core.fromReport, path.join(directory, "reports", "deployment-report.json"));
	assert.equal(loaded.dependencies.coreReport.path, reportFile);
	assert.match(loaded.dependencies.coreReport.digest, /^[0-9a-f]{64}$/);
	fs.writeFileSync(reportFile, `${JSON.stringify(coreDependencyReport())}\n`);
	assert.notEqual(loadDeploymentRecipe("recipe.json", { projectRoot: directory }).digest, loaded.digest);
});

test("core dependency report proof validates identity, gates, and every consumed address", () => {
	const expected = { network: "arbitrum", chainId: 42161, live: false };
	assert.equal(parseCoreDependencyReport(coreDependencyReport(), expected).addresses.diamond, C);

	const wrongChain = coreDependencyReport();
	wrongChain.chainId = 1;
	assert.throws(
		() => parseCoreDependencyReport(wrongChain, expected),
		error => error.code === "DEPENDENCY_UNAVAILABLE" && /chainId/.test(error.message),
	);

	const failedHealth = coreDependencyReport();
	failedHealth.checks.health = "failed";
	assert.throws(() => parseCoreDependencyReport(failedHealth, expected), /health gate/);

	const badAddress = coreDependencyReport();
	badAddress.addresses.instantLayer = "0x0000000000000000000000000000000000000000";
	assert.throws(() => parseCoreDependencyReport(badAddress, expected), /addresses\.instantLayer must be a valid non-zero address/);

	assert.throws(() => parseCoreDependencyReport(coreDependencyReport(), { ...expected, live: true }), /live verification proof is incomplete/);
	const verified = coreDependencyReport();
	verified.checks = { health: "passed", verification: "passed", verificationPolicy: "required" };
	assert.equal(parseCoreDependencyReport(verified, { ...expected, live: true }).checks.verification, "passed");
});

test("core dependency report loader gives the parser an absolute source path", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-core-report-"));
	const file = path.join(directory, "deployment-report.json");
	fs.writeFileSync(file, JSON.stringify(coreDependencyReport()));
	const loaded = loadCoreDependencyReport(file, { network: "arbitrum", chainId: 42161, live: false });
	assert.equal(loaded.deploymentId, "deployment-1");
	assert.match(loaded.sourceDigest, /^[0-9a-f]{64}$/);
	assert.equal(
		loadCoreDependencyReport(file, { network: "arbitrum", chainId: 42161, live: false, digest: loaded.sourceDigest }).deploymentId,
		"deployment-1",
	);
	fs.writeFileSync(file, `${JSON.stringify(coreDependencyReport())}\n`);
	assert.throws(
		() => loadCoreDependencyReport(file, { network: "arbitrum", chainId: 42161, live: false, digest: loaded.sourceDigest }),
		/changed after recipe confirmation/,
	);
	assert.throws(
		() => loadCoreDependencyReport(path.join(directory, "missing.json"), { network: "arbitrum", chainId: 42161, live: false }),
		error => error.code === "DEPENDENCY_UNAVAILABLE" && error.message.includes(path.join(directory, "missing.json")),
	);
});

function expressProviderDeploy(overrides = {}) {
	return {
		mode: "deploy",
		registerOnCore: true,
		creditLine: { signatureVerifier: "fromCore", muonAppId: "7", muonFreshnessWindow: 300 },
		roles: { OPERATOR_ROLE: [B] },
		affiliates: [{ address: C, feeRate: "0", operatorFee: "0", maxDebt: "1000", maxDebtBps: 5000 }],
		...overrides,
	};
}

test("ExpressProvider deploy plans once its operating configuration is complete", () => {
	const recipe = localRecipe();
	recipe.expressProvider = expressProviderDeploy();
	const plan = createDeploymentPlan(recipe);
	assert.equal(plan.components.find(component => component.name === "expressProvider")?.mode, "deploy");
});

test("ExpressProvider deploy requires the config that makes it operable", () => {
	for (const [field, value] of [
		["registerOnCore", undefined],
		["creditLine", undefined],
		["roles", undefined],
		["affiliates", undefined],
	]) {
		const recipe = localRecipe();
		const component = expressProviderDeploy();
		delete component[field];
		if (value !== undefined) component[field] = value;
		recipe.expressProvider = component;
		assert.throws(() => createDeploymentPlan(recipe), new RegExp(`expressProvider\\.${field} is required`), `${field} must be required`);
	}

	// A provider with no operator can accept withdrawals it can never process.
	const noOperator = localRecipe();
	noOperator.expressProvider = expressProviderDeploy({ roles: { PAUSER_ROLE: [B] } });
	assert.throws(() => createDeploymentPlan(noOperator), /roles\.OPERATOR_ROLE is required/);

	// An empty affiliate set means no pool backs any advance.
	const noAffiliates = localRecipe();
	noAffiliates.expressProvider = expressProviderDeploy({ affiliates: [] });
	assert.throws(() => createDeploymentPlan(noAffiliates), /affiliates must be a non-empty array/);
});

test("ExpressProvider rejects unknown roles, duplicate affiliates and unreachable validator thresholds", () => {
	const unknownRole = localRecipe();
	unknownRole.expressProvider = expressProviderDeploy({ roles: { OPERATOR_ROLE: [B], ADMIN_ROLE: [C] } });
	assert.throws(() => createDeploymentPlan(unknownRole), /roles\.ADMIN_ROLE is not a supported field/);

	const duplicate = localRecipe();
	duplicate.expressProvider = expressProviderDeploy({
		affiliates: [
			{ address: C, feeRate: "0", operatorFee: "0", maxDebt: "1", maxDebtBps: 1 },
			{ address: C, feeRate: "0", operatorFee: "0", maxDebt: "1", maxDebtBps: 1 },
		],
	});
	assert.throws(() => createDeploymentPlan(duplicate), /duplicates an earlier affiliate/);

	// Requiring more signatures than there are validators bricks the affiliate.
	const threshold = localRecipe();
	threshold.expressProvider = expressProviderDeploy({
		affiliates: [{ address: C, feeRate: "0", operatorFee: "0", maxDebt: "1", maxDebtBps: 1, validators: [B], minValidatorSignatures: 2 }],
	});
	assert.throws(() => createDeploymentPlan(threshold), /minValidatorSignatures/);

	const feeRate = localRecipe();
	feeRate.expressProvider = expressProviderDeploy({
		affiliates: [{ address: C, feeRate: "10001", operatorFee: "0", maxDebt: "1", maxDebtBps: 1 }],
	});
	assert.throws(() => createDeploymentPlan(feeRate), /feeRate must be <= 10000/);
});

test("ExpressProvider skip still rejects configuration, and reuse stays out of full runs", () => {
	const skip = localRecipe();
	skip.expressProvider = { mode: "skip", roles: { OPERATOR_ROLE: [B] } };
	assert.throws(() => createDeploymentPlan(skip), /roles must be omitted when mode is skip/);

	// reuse + sections is a patch, but a patch is --only-scoped: a full run must not
	// silently reconcile a provider while deploying everything else.
	const full = localRecipe();
	full.expressProvider = { mode: "reuse", address: C, roles: { OPERATOR_ROLE: [B] } };
	assert.throws(() => createDeploymentPlan(full), /deploy or skip/);
});

function patchRecipe(expressProvider) {
	const recipe = localRecipe();
	recipe.name = "local-express-patch";
	recipe.core = { mode: "reuse", fromReport: "./core-report.json" };
	recipe.partyB = { mode: "skip", adlEnabled: false };
	recipe.symbolManager = { mode: "skip" };
	recipe.expressProvider = expressProvider;
	return recipe;
}

test("an ExpressProvider patch plans with --only and validates its declared sections", () => {
	const plan = createDeploymentPlan(patchRecipe({ mode: "reuse", address: C, roles: { OPERATOR_ROLE: [B] } }), { only: "expressProvider" });
	assert.equal(plan.components.find(component => component.name === "expressProvider")?.mode, "reuse");

	// Declared sections are validated exactly as strictly as a deploy would validate them.
	assert.throws(
		() => createDeploymentPlan(patchRecipe({ mode: "reuse", address: C, roles: { PAUSER_ROLE: [B] } }), { only: "expressProvider" }),
		/OPERATOR_ROLE/,
	);
	assert.throws(
		() => createDeploymentPlan(patchRecipe({ mode: "reuse", address: C, securityWindow: 5 }), { only: "expressProvider" }),
		/securityWindow/,
	);
	assert.throws(() => createDeploymentPlan(patchRecipe({ mode: "reuse", roles: { OPERATOR_ROLE: [B] } }), { only: "expressProvider" }), /address/);
});

test("environment projection contains public values and unresolved secret metadata only", () => {
	const recipe = localRecipe();
	recipe.secrets = { deployer: "env://ULTRA_SECRET", rpc: "hardhat-keystore://RPC_LOCAL" };
	recipe.execution = {
		logLevel: "minimal",
		verify: false,
		confirmations: 2,
		txTimeoutSeconds: 90,
		slowNoticeSeconds: 10,
	};
	const projected = recipeEnvironment(recipe);
	assert.equal(projected.env.ADMIN_PUBLIC_KEY, A);
	assert.equal(projected.env.DEPLOY_CONFIRMATIONS, "2");
	assert.equal(projected.env.DEPLOY_TX_TIMEOUT, "90");
	assert.equal(projected.env.DIAMOND_VANITY_PREFIX, "573310");
	assert.equal(projected.env.CREATE2_FACTORY_ADDRESS, "");
	assert.deepEqual(projected.secrets.deployer, { provider: "env", key: "ULTRA_SECRET" });
	assert.deepEqual(projected.secrets.rpc, { provider: "hardhat-keystore", key: "RPC_LOCAL" });
	assert.equal(Object.hasOwn(projected.env, "NEW_DEPLOYER"), false);
	assert.equal(Object.values(projected.env).includes("ULTRA_SECRET"), false);
});

test("distributed example is JSON-parseable but intentionally fails until placeholders are replaced", () => {
	const examplePath = path.resolve("deployment/examples/arbitrum.v1.example.json");
	const example = JSON.parse(fs.readFileSync(examplePath, "utf8"));
	assert.equal(example.apiVersion, "deployment.symm.io/v1");
	assert.throws(() => validateDeploymentRecipe(example, examplePath), /REPLACE|20-byte hexadecimal address/);
});
