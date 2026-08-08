// `symmio deploy --network <n>` — the runbook, executed.
//
// Encodes the order that a correct deployment actually requires: preflight, an explicit
// plan, confirmation proportional to the risk, the deploy itself, then verification and a
// health check. The manual steps the tooling cannot perform are printed at the end rather
// than left in someone's head.
import {
	deploymentCheckpointPath,
	isLiveMainnet,
	isMainnet,
	loadEnv,
	readDeploymentReport,
	resolveDeployer,
	resolveNetwork,
} from "../lib/context.js";
import { hardhat } from "../lib/hardhat.js";
import { projectPath } from "../lib/paths.js";
import {
	assertDeploymentReportRecipeBinding,
	assertRecipeNetworkCompatibility,
	loadRecipeContext,
	recipeHardhatEnvironment,
} from "../lib/recipe-context.js";
import { blank, c, confirm, confirmPhrase, info, kv, log, table, title, warn } from "../lib/ui.js";
import { doctor } from "./doctor.js";
import { isAddress } from "ethers";
import fs from "node:fs";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function validateDeploymentAuthorization({ mainnet, force = false, yes = false, confirmNetwork, networkName, noVerify = false }) {
	if (mainnet && force) {
		throw new Error("--force is refused on mainnet; fix every blocking preflight issue before deploying");
	}
	if (mainnet && noVerify) {
		throw new Error("--no-verify is refused on live mainnets; explorer verification is a required deployment gate");
	}
	if (confirmNetwork !== undefined && !yes) {
		throw new Error("--confirm-network is only valid together with --yes");
	}
	if (mainnet && yes && confirmNetwork !== networkName) {
		throw new Error(`mainnet --yes requires --confirm-network ${networkName}`);
	}
	if (confirmNetwork !== undefined && confirmNetwork !== networkName) {
		throw new Error(`--confirm-network must exactly match ${networkName}`);
	}
}

export function liquidationPlanValues(env, chainId) {
	const productionShape = isMainnet(chainId);
	return {
		vault: env.LIQUIDATION_INSURANCE_VAULT || (productionShape ? "(required for mainnet/fork)" : "(defaults to admin locally)"),
		maxProfit: env.MAX_LIQUIDATION_PROFIT_PER_POSITION || (productionShape ? "(required for mainnet/fork)" : "(defaults to 100e18 locally)"),
		collector: env.SOFT_LIQUIDATION_PENALTY_COLLECTOR || (productionShape ? "(required for mainnet/fork)" : "(defaults to admin locally)"),
	};
}

export function effectiveVerification({ recipe, noVerify = false, mainnet = false, simulated = false }) {
	if (mainnet && noVerify) {
		throw new Error("--no-verify is refused on live mainnets; explorer verification is a required deployment gate");
	}
	if (recipe && mainnet && recipe.execution.verify !== true) {
		throw new Error("execution.verify must be true for a live network");
	}
	if (noVerify && !mainnet) return false;
	if (recipe) return recipe.execution.verify === true && !simulated;
	return !simulated && !noVerify;
}

/** Build the exact production artifacts deployment tasks consume, without unlocking credentials or loading dotenv. */
export function deploymentBuildInvocation(recipeContext) {
	return {
		args: ["--build-profile", "production", "build"],
		env: recipeContext ? recipeHardhatEnvironment(recipeContext, { SYMMIO_RECIPE_READ_ONLY: "true" }) : {},
	};
}

export function deploymentTaskInvocation({ recipeContext, only, networkName, fresh = false, verify = false, logLevel = "verbose" }) {
	if (recipeContext) {
		const env = recipeHardhatEnvironment(recipeContext, { DEPLOY_LOG_LEVEL: logLevel });
		if (only) {
			if (only === "core") {
				throw new Error(
					'--only core is unavailable because Core is a system bundle; set partyB.mode, symbolManager.mode, and expressProvider.mode to "skip", then run without --only',
				);
			}
			return {
				args: [
					"deploy:component",
					"--recipe",
					recipeContext.path,
					"--component",
					only,
					"--fresh",
					String(Boolean(fresh)),
					"--verify",
					String(Boolean(verify)),
					"--network",
					networkName,
				],
				env,
			};
		}
		return {
			args: ["deploy:system", "--network", networkName, "--fresh", String(Boolean(fresh)), "--verify", String(Boolean(verify))],
			env,
		};
	}
	const args = ["deploy:system", "--network", networkName, "--verify", String(Boolean(verify))];
	if (fresh) args.push("--fresh", "true");
	return { args, env: { DEPLOY_LOG_LEVEL: logLevel } };
}

export function deploymentPlanRows(plan) {
	return plan.components.map(component => [
		plan.only ? (component.name === plan.only ? "selected" : "dependency") : component.mode === "skip" ? "not selected" : "selected",
		component.name,
		component.mode,
		component.dependsOn.length ? component.dependsOn.join(", ") : "none",
	]);
}

/** Exit success only when a persistent deployment is actually complete. */
export function deploymentLifecycleExitCode(report, { simulated = false } = {}) {
	if (report?.lifecycle === "complete") return 0;
	if (report?.lifecycle === "pending_handover") return simulated ? 0 : 2;
	return 1;
}

function validAddress(value) {
	return typeof value === "string" && isAddress(value) && value.toLowerCase() !== ZERO_ADDRESS;
}

function sameAddress(actual, expected) {
	return validAddress(actual) && validAddress(expected) && actual.toLowerCase() === expected.toLowerCase();
}

export function componentReportPath(chainId, { simulated = false, recipeName, component }) {
	return projectPath("tasks", "data", `${Number(chainId)}${simulated ? "-fork" : ""}`, "components", recipeName, `${component}-report.json`);
}

export function expectedDeploymentCheckpointPath(chainId, { simulated = false, recipeContext = null, only } = {}) {
	const scope = only && recipeContext ? `component-${recipeContext.recipe.name}-${only}` : undefined;
	return deploymentCheckpointPath(chainId, { simulated, scope });
}

export function validateComponentReport(report, expected) {
	if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("component report must be an object");
	if (report.schemaVersion !== 1) throw new Error(`component report schemaVersion must be 1, got ${JSON.stringify(report.schemaVersion)}`);
	if (report.component !== expected.component) {
		throw new Error(`component report is for ${JSON.stringify(report.component)}, expected ${expected.component}`);
	}
	if (report.network !== expected.networkName) {
		throw new Error(`component report network is ${JSON.stringify(report.network)}, expected ${expected.networkName}`);
	}
	if (report.chainId !== Number(expected.chainId)) {
		throw new Error(`component report chainId is ${JSON.stringify(report.chainId)}, expected ${Number(expected.chainId)}`);
	}
	if (!report.recipe || typeof report.recipe !== "object") throw new Error("component report is missing recipe binding");
	if (report.recipe.name !== expected.recipeName) {
		throw new Error(`component report recipe name is ${JSON.stringify(report.recipe.name)}, expected ${expected.recipeName}`);
	}
	if (report.recipe.digest !== expected.recipeDigest) throw new Error("component report recipe digest does not match the selected recipe");
	if (typeof report.recipe.path !== "string" || report.recipe.path.trim() === "") throw new Error("component report recipe path is missing");
	if (typeof report.deploymentId !== "string" || report.deploymentId.trim() === "") {
		throw new Error("component report is missing deploymentId");
	}
	const validModes = expected.component === "expressProvider" ? ["deploy", "patch"] : ["deploy"];
	if (!validModes.includes(report.mode)) {
		throw new Error(`component report mode must be one of ${validModes.join(", ")}, got ${JSON.stringify(report.mode)}`);
	}
	if (report.lifecycle !== "pending_handover" && report.lifecycle !== "complete") {
		throw new Error(`component report is not in a successful lifecycle: ${JSON.stringify(report.lifecycle)}`);
	}
	if (!validAddress(report.address)) throw new Error("component report is missing a valid deployed address");
	if (report.implementation !== undefined && !validAddress(report.implementation)) {
		throw new Error("component report implementation is not a valid non-zero address");
	}
	if (expected.component === "partyB" && !validAddress(report.implementation)) {
		throw new Error("PartyB component report is missing its implementation address");
	}
	if (!report.config || typeof report.config !== "object" || Array.isArray(report.config)) {
		throw new Error("component report is missing its public config evidence");
	}
	if (!expected.config || !sameAddress(report.config.admin, expected.config.admin)) {
		throw new Error(
			`component report config.admin is ${JSON.stringify(report.config.admin)}, expected ${JSON.stringify(expected.config?.admin)}`,
		);
	}
	if (expected.component === "partyB") {
		if (!sameAddress(report.config.signer, expected.config.signer)) {
			throw new Error(
				`component report config.signer is ${JSON.stringify(report.config.signer)}, expected ${JSON.stringify(expected.config.signer)}`,
			);
		}
		if (report.config.adlEnabled !== expected.config.adlEnabled) {
			throw new Error(
				`component report config.adlEnabled is ${JSON.stringify(report.config.adlEnabled)}, expected ${JSON.stringify(expected.config.adlEnabled)}`,
			);
		}
	} else if (expected.component === "symbolManager" && !sameAddress(report.config.operator, expected.config.operator)) {
		throw new Error(
			`component report config.operator is ${JSON.stringify(report.config.operator)}, expected ${JSON.stringify(expected.config.operator)}`,
		);
	}
	if (!report.verification || typeof report.verification !== "object") throw new Error("component report is missing verification evidence");
	if (!Array.isArray(report.verification.records)) throw new Error("component report verification.records must be an array");
	const verifiedAddresses = new Set();
	for (const [index, record] of report.verification.records.entries()) {
		if (!record || typeof record !== "object" || Array.isArray(record)) {
			throw new Error(`component report verification.records[${index}] must be an object`);
		}
		if (typeof record.name !== "string" || record.name.trim() === "") {
			throw new Error(`component report verification.records[${index}].name must be non-empty`);
		}
		if (!validAddress(record.address)) {
			throw new Error(`component report verification.records[${index}].address is not a valid non-zero address`);
		}
		if (!Array.isArray(record.constructorArguments)) {
			throw new Error(`component report verification.records[${index}].constructorArguments must be an array`);
		}
		verifiedAddresses.add(record.address.toLowerCase());
	}
	if (!verifiedAddresses.has(report.address.toLowerCase())) {
		throw new Error(`component verification records do not cover deployed ${expected.component} address ${report.address}`);
	}
	if (expected.component === "partyB" && !verifiedAddresses.has(report.implementation.toLowerCase())) {
		throw new Error(`PartyB verification records do not cover implementation address ${report.implementation}`);
	}
	if (expected.live) {
		if (report.verification.policy !== "required" || report.verification.status !== "passed") {
			throw new Error(
				`live component verification is incomplete: ${JSON.stringify(report.verification.policy)}/${JSON.stringify(report.verification.status)}`,
			);
		}
	} else if (report.verification.policy !== "not_applicable" || report.verification.status !== "skipped") {
		throw new Error(
			`non-live component verification must be not_applicable/skipped, got ${JSON.stringify(report.verification.policy)}/${JSON.stringify(report.verification.status)}`,
		);
	}
	if (!report.health || !["passed", "pending"].includes(report.health.status)) {
		throw new Error(`component health status is not successful: ${JSON.stringify(report.health?.status)}`);
	}
	if (!Array.isArray(report.health.checks)) throw new Error("component report health.checks must be an array");
	if (report.health.checks.length === 0) throw new Error("component report health.checks must contain post-state evidence");
	for (const [index, check] of report.health.checks.entries()) {
		if (!check || typeof check !== "object" || Array.isArray(check)) {
			throw new Error(`component report health.checks[${index}] must be an object`);
		}
		if (typeof check.check !== "string" || check.check.trim() === "") {
			throw new Error(`component report health.checks[${index}].check must be non-empty`);
		}
		if (check.status !== "passed" && check.status !== "pending") {
			throw new Error(`component report health.checks[${index}].status is not successful: ${JSON.stringify(check.status)}`);
		}
	}
	if (report.health.status === "passed" && report.health.checks.some(check => check.status !== "passed")) {
		throw new Error("component report health.status is passed but a post-state check is not passed");
	}
	if (report.health.status === "pending" && !report.health.checks.some(check => check.status === "pending")) {
		throw new Error("component report health.status is pending but no post-state check is pending");
	}
	if (!Array.isArray(report.manualActions)) throw new Error("component report manualActions must be an array");
	for (const [index, action] of report.manualActions.entries()) {
		if (!action || typeof action !== "object") throw new Error(`component report manualActions[${index}] must be an object`);
		if (!validAddress(action.to)) throw new Error(`component report manualActions[${index}].to is not a valid address`);
		if (action.value !== "0") throw new Error(`component report manualActions[${index}].value must be "0"`);
		if (typeof action.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(action.data)) {
			throw new Error(`component report manualActions[${index}].data must be hexadecimal calldata`);
		}
		if (typeof action.description !== "string" || action.description.trim() === "") {
			throw new Error(`component report manualActions[${index}].description must be non-empty`);
		}
	}
	if (report.lifecycle === "complete" && (report.health.status !== "passed" || report.manualActions.length > 0)) {
		throw new Error("complete component report must have passed health and no manual actions");
	}
	if (report.lifecycle === "pending_handover" && report.health.status === "passed" && report.manualActions.length === 0) {
		throw new Error("pending_handover component report contains no pending health check or manual action");
	}
	return report;
}

export function readComponentReport(chainId, options) {
	const reportPath = componentReportPath(chainId, options);
	let report;
	try {
		report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
	} catch (error) {
		throw new Error(`component report ${reportPath} is unavailable: ${error.message || error}`);
	}
	return { report: validateComponentReport(report, options), path: reportPath };
}

function showComponentHandoff(report, reportPath, recipePath) {
	title(report.lifecycle === "complete" ? `${report.component} deployment complete` : `${report.component} pending admin handover`);
	kv([
		["lifecycle", report.lifecycle],
		["address", report.address],
		["implementation", report.implementation || c.grey("not applicable")],
		["admin", report.config.admin],
		...(report.component === "partyB"
			? [
					["signer", report.config.signer],
					["ADL enabled", String(report.config.adlEnabled)],
				]
			: [["operator", report.config.operator]]),
		["verification", `${report.verification.policy} / ${report.verification.status}`],
		["health", report.health.status],
		["report", reportPath],
	]);
	if (report.manualActions.length > 0) {
		title("Exact Safe actions");
		for (const [index, action] of report.manualActions.entries()) {
			log(`  ${c.yellow(`${index + 1}.`)} ${action.description}`);
			log(`     ${c.grey("to")}     ${action.to}`);
			log(`     ${c.grey("value")}  ${action.value}`);
			log(`     ${c.grey("data")}   ${action.data}`);
		}
	}
	if (report.lifecycle === "pending_handover") {
		blank();
		info("after the Safe actions confirm, rerun the identical command; it resumes without redeploying and proves the final state");
		log(`  ${c.cyan(`./symmio deploy --config ${recipePath} --only ${report.component}`)}`);
	}
}

function showRecipePlan(recipeContext, chain) {
	title("Recipe plan");
	kv([
		["recipe", recipeContext.path],
		["digest", recipeContext.digest],
		["network", `${chain.name} (chainId ${chain.chainId})`],
		["selection", recipeContext.plan.only || "all components enabled by the recipe"],
	]);
	blank();
	table(["target", "component", "mode", "dependencies"], deploymentPlanRows(recipeContext.plan));
	blank();
}

export function validateDeploymentHandoff(report, expectedChainId, { requireVerification = false, recipeContext = null } = {}) {
	if (!report || typeof report !== "object") throw new Error("deploy:system succeeded but did not write a deployment report");
	if (!Number.isSafeInteger(report.chainId) || report.chainId !== Number(expectedChainId)) {
		throw new Error(`deployment report chainId mismatch: expected ${Number(expectedChainId)}, got ${JSON.stringify(report.chainId)}`);
	}
	if (recipeContext) assertDeploymentReportRecipeBinding(report, recipeContext);
	if (!report.addresses || typeof report.addresses !== "object") throw new Error("deployment report is missing its addresses map");
	if (!validAddress(report.deployerAddress)) {
		throw new Error("deployment report is missing a valid deployerAddress");
	}
	for (const field of ["diamond", "accountLayerDiamond", "instantLayer"]) {
		if (!validAddress(report.addresses[field])) {
			throw new Error(`deployment report is missing a valid addresses.${field}`);
		}
	}
	if (report.config?.deploySymbolManager === true && !validAddress(report.addresses.symbolManager)) {
		throw new Error("deployment report declares SymbolManager enabled but has no addresses.symbolManager");
	}
	for (const field of ["liquidationInsuranceVault", "softLiquidationPenaltyCollector"]) {
		const value = report.config?.[field];
		if (!validAddress(value)) {
			throw new Error(`deployment report is missing a valid config.${field}`);
		}
	}
	if (
		typeof report.config?.maxLiquidationProfitPerPosition !== "string" ||
		!/^[1-9]\d*$/.test(report.config.maxLiquidationProfitPerPosition) ||
		BigInt(report.config.maxLiquidationProfitPerPosition) > (1n << 256n) - 1n
	) {
		throw new Error("deployment report is missing a valid config.maxLiquidationProfitPerPosition");
	}
	if (report.lifecycle !== "pending_handover" && report.lifecycle !== "complete") {
		throw new Error(`deployment report is not in a successful handoff lifecycle: ${JSON.stringify(report.lifecycle)}`);
	}
	if (report.manualActions !== undefined && !Array.isArray(report.manualActions)) {
		throw new Error("deployment report manualActions must be an array");
	}
	if (report.manualActions?.some(action => typeof action !== "string" || action.trim() === "")) {
		throw new Error("deployment report manualActions must contain only non-empty strings");
	}
	if (report.lifecycle === "pending_handover" && (!report.manualActions || report.manualActions.length === 0)) {
		throw new Error("deployment report says pending_handover but contains no manualActions");
	}
	if (report.checks?.health !== "passed") throw new Error(`deployment health gate is not passed: ${JSON.stringify(report.checks?.health)}`);
	if (requireVerification) {
		if (report.checks?.verificationPolicy !== "required") {
			throw new Error(`deployment verification policy is not required: ${JSON.stringify(report.checks?.verificationPolicy)}`);
		}
		if (report.checks?.verification !== "passed") {
			throw new Error(`deployment explorer verification is not passed: ${JSON.stringify(report.checks?.verification)}`);
		}
	}
	return report;
}

export async function deploy(args) {
	// Recipe and dependency validation happens before doctor opens an RPC connection.
	const recipeContext = args.config ? loadRecipeContext(args.config, { only: args.only }) : null;
	if (recipeContext && args.only === "core") {
		throw new Error(
			'--only core is unavailable because Core is a system bundle; set partyB.mode, symbolManager.mode, and expressProvider.mode to "skip", then run without --only',
		);
	}
	const networkName = recipeContext?.networkName || args.network;
	if (!networkName) throw new Error("exactly one of --config or --network is required");
	const chain = resolveNetwork(networkName);
	if (recipeContext) assertRecipeNetworkCompatibility(recipeContext.recipe, chain);
	const env = recipeContext?.env || loadEnv().vars;
	const mainnet = isLiveMainnet(chain);
	const verify = effectiveVerification({
		recipe: recipeContext?.recipe,
		noVerify: args["no-verify"] === true,
		mainnet,
		simulated: chain.simulated,
	});
	validateDeploymentAuthorization({
		mainnet,
		force: args.force,
		yes: args.yes,
		confirmNetwork: args["confirm-network"],
		networkName,
		noVerify: args["no-verify"],
	});

	// ── 1. preflight ────────────────────────────────────────────────────────────
	log(c.bold("\n  Step 1/4 — preflight"));
	const doctorCode = await doctor(args, { recipeContext });

	// ── 2. plan ─────────────────────────────────────────────────────────────────
	log(c.bold("\n  Step 2/4 — plan"));
	if (recipeContext) {
		showRecipePlan(recipeContext, chain);
	} else {
		warn("--network compatibility mode", "the plan is not bound to a versioned JSON recipe");
		const deployer = chain.simulated ? { address: null, source: "Hardhat simulated account" } : resolveDeployer(env);
		const liquidationPlan = liquidationPlanValues(env, chain.chainId);
		title("What will happen");
		kv([
			["network", `${chain.name} (chainId ${chain.chainId})`],
			[
				"deployer",
				chain.simulated
					? c.grey("pre-funded Hardhat simulation account")
					: deployer.address || (deployer.keystore ? c.grey("(from keystore)") : c.red("(missing signer)")),
			],
			["admin", env.ADMIN_PUBLIC_KEY || c.yellow("(defaults to deployer)")],
			["fee receiver", env.SYMMIO_FEE_RECEIVER || c.grey("(defaults to admin)")],
			["liquidation insurance vault", env.LIQUIDATION_INSURANCE_VAULT || c.yellow(liquidationPlan.vault)],
			["max liquidation profit", env.MAX_LIQUIDATION_PROFIT_PER_POSITION || c.yellow(liquidationPlan.maxProfit)],
			["soft penalty collector", env.SOFT_LIQUIDATION_PENALTY_COLLECTOR || c.yellow(liquidationPlan.collector)],
			["collateral", env.COLLATERAL_ADDRESS || c.yellow("(would deploy FakeStablecoin)")],
			["verifier", env.DEPLOY_MOCK_VERIFIER === "true" ? c.red("MOCK — accepts every signature") : "MuonSignatureVerifier"],
			[
				"Muon permissions",
				env.DEPLOY_MOCK_VERIFIER === "true" ? c.grey("not applicable to mock verifier") : env.MUON_FUNCTION_PERMISSIONS || c.red("(missing)"),
			],
			["protocol config", `tasks/config/protocol-${chain.chainId}.json`],
			["verification", verify ? "inside deploy:system" : c.grey("disabled")],
		]);
		blank();
		info("deploys 50+ contracts: Core Diamond + facets/libraries, AccountLayer, verifier, InstantLayer, PartyB, and SymbolManager");
		info("then hands admin to the configured protocol admin and revokes the deployer's privileges");
	}

	if (doctorCode !== 0) {
		if (!args.force) {
			log(`  ${c.red("Preflight failed.")} ${c.grey("Fix the issues above, or pass --force to override.")}`);
			blank();
			return 1;
		}
		warn("preflight failed but --force was passed — continuing");
	}

	info("building the production contract artifacts used by deployment");
	const buildInvocation = deploymentBuildInvocation(recipeContext);
	const buildCode = await hardhat(buildInvocation.args, { env: buildInvocation.env });
	if (buildCode !== 0) {
		blank();
		log(`  ${c.red(c.bold("Deployment build failed."))}`);
		log(`  ${c.grey("No transaction was sent. Fix the compiler/source error, then re-run the same command.")}`);
		blank();
		return buildCode;
	}
	if (args.plan) {
		info("read-only plan complete", "no transaction was sent");
		blank();
		return 0;
	}

	// ── 3. confirm ──────────────────────────────────────────────────────────────
	if (!args.yes) {
		blank();
		const proceed = mainnet
			? await confirmPhrase(`This will spend real funds on ${chain.name}.`, chain.key)
			: await confirm(`Deploy to ${chain.name}?`);
		if (!proceed) {
			log(`  ${c.grey("Aborted.")}`);
			blank();
			return 1;
		}
	}

	// ── 4. deploy ───────────────────────────────────────────────────────────────
	log(c.bold("\n  Step 3/4 — deploy"));
	const invocation = deploymentTaskInvocation({
		recipeContext,
		only: args.only,
		networkName,
		fresh: args.fresh,
		verify,
		logLevel: env.DEPLOY_LOG_LEVEL || "verbose",
	});
	const code = await hardhat(invocation.args, { env: invocation.env });
	if (code !== 0) {
		blank();
		log(`  ${c.red(c.bold("Deployment failed."))}`);
		const checkpointPath = expectedDeploymentCheckpointPath(chain.chainId, {
			simulated: chain.simulated,
			recipeContext,
			only: args.only,
		});
		if (fs.existsSync(checkpointPath)) {
			log(`  ${c.grey(`Recovery checkpoint: ${checkpointPath}`)}`);
			log(`  ${c.grey("Re-run the identical command to reconcile transactions and resume.")}`);
		} else {
			log(`  ${c.grey("No active checkpoint was created; this failed before durable deployment state existed.")}`);
			log(`  ${c.grey("Fix the startup/preflight error, then re-run the same command.")}`);
		}
		blank();
		return code;
	}
	if (args.only) {
		log(c.bold("\n  Step 4/4 — result"));
		let componentEvidence;
		try {
			componentEvidence = readComponentReport(chain.chainId, {
				simulated: chain.simulated,
				recipeName: recipeContext.recipe.name,
				component: args.only,
				networkName,
				recipeDigest: recipeContext.digest,
				recipePath: recipeContext.path,
				live: mainnet,
				config:
					args.only === "partyB"
						? {
								admin: recipeContext.recipe.governance.admin,
								signer: recipeContext.recipe.partyB.signer,
								adlEnabled: recipeContext.recipe.partyB.adlEnabled,
							}
						: {
								admin: recipeContext.recipe.governance.admin,
								operator: recipeContext.recipe.symbolManager.operator,
							},
			});
		} catch (error) {
			log(`  ${c.red(c.bold("Component deployment evidence is incomplete."))}`);
			log(`  ${c.grey(error.message || String(error))}`);
			blank();
			return 1;
		}
		showComponentHandoff(componentEvidence.report, componentEvidence.path, args.config);
		info("recipe digest", recipeContext.digest);
		const resultCode = deploymentLifecycleExitCode(componentEvidence.report, { simulated: chain.simulated });
		if (resultCode !== 0) {
			warn("deployment is not complete yet", "exit code 2 means the reported admin/Safe handover actions still need confirmation");
		}
		blank();
		return resultCode;
	}

	let report;
	try {
		report = validateDeploymentHandoff(readDeploymentReport(chain.chainId, { simulated: chain.simulated }), chain.chainId, {
			requireVerification: mainnet && !args["no-verify"],
			recipeContext,
		});
	} catch (error) {
		blank();
		log(`  ${c.red(c.bold("Deployment evidence is incomplete."))}`);
		log(`  ${c.grey(error.message || String(error))}`);
		blank();
		return 1;
	}

	// Verification and the deployment health check must run inside deploy:system. A second
	// Hardhat process would create a fresh in-memory fork and lose the deployment entirely.
	log(c.bold("\n  Step 4/4 — result"));
	if (chain.simulated) {
		title("Fork rehearsal complete");
		info("the simulated state is ephemeral; review the deploy:system health summary above");
		info(`deployment report lifecycle: ${report.lifecycle || "unknown"}`);
		blank();
		return deploymentLifecycleExitCode(report, { simulated: true });
	}

	// ── authoritative handoff ───────────────────────────────────────────────────
	title("Deployment handoff");
	kv([
		["lifecycle", report.lifecycle || c.yellow("unknown")],
		["Core Diamond", report.addresses.diamond],
		["AccountLayer Diamond", report.addresses.accountLayerDiamond],
		["InstantLayer", report.addresses.instantLayer],
		["SymbolManager", report.addresses.symbolManager || c.grey("not deployed")],
	]);
	if (report.manualActions?.length) {
		blank();
		log(`  ${c.bold("Manual actions recorded by deploy:system:")}`);
		for (const [index, action] of report.manualActions.entries()) log(`  ${c.yellow(`${index + 1}.`)} ${action}`);
	} else {
		blank();
		info("deploy:system reports no manual actions remaining");
	}
	blank();
	const statusCommand = recipeContext ? `./symmio status --config ${args.config}` : `./symmio status --network ${networkName}`;
	log(`  Then confirm the result: ${c.cyan(statusCommand)}`);
	const resultCode = deploymentLifecycleExitCode(report, { simulated: chain.simulated });
	if (resultCode !== 0) {
		warn("deployment is not complete yet", "exit code 2 means the reported admin/Safe handover actions still need confirmation");
	}
	blank();

	return resultCode;
}
