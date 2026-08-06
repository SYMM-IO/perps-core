// `symmio status --network <n>` — canonical deployment health, without a second
// hand-maintained interpretation of what "healthy" means.
//
// The Hardhat check:deployment task verifies exact facet selectors, all configured
// protocol values/templates, both diamonds, integrations, roles, ownership and optional
// components. Delegating to it means an unreadable/unknown probe is a failed check rather
// than a warning followed by a false-green "looks healthy" verdict.
import { createDeploymentPlan } from "../../deployment/recipe.js";
import { deploymentCheckpointPath, explorerAddressUrl, isLiveMainnet, readCheckpoint, readDeploymentReport, resolveNetwork } from "../lib/context.js";
import { hardhat } from "../lib/hardhat.js";
import {
	assertDeploymentReportRecipeBinding,
	assertRecipeNetworkCompatibility,
	loadCoreDependencyReport,
	loadRecipeContext,
	recipeHardhatEnvironment,
} from "../lib/recipe-context.js";
import { blank, c, fail, info, kv, log, title, warn } from "../lib/ui.js";
import { readComponentReport, validateComponentReport } from "./deploy.js";
import { isAddress } from "ethers";
import path from "node:path";

const KNOWN_LIFECYCLES = new Set(["validating", "pending_handover", "complete", "failed"]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function validAddress(value) {
	return typeof value === "string" && isAddress(value) && value.toLowerCase() !== ZERO_ADDRESS;
}

export function buildStatusTaskArgs(networkName, args = {}) {
	const taskArgs = ["check:deployment", "--network", networkName, "--from-report", "true"];
	for (const [cliName, taskName] of [
		["diamond", "diamond"],
		["account-layer", "account-layer"],
		["instant-layer", "instant-layer"],
	]) {
		if (args[cliName]) taskArgs.push(`--${taskName}`, args[cliName]);
	}
	return taskArgs;
}

export function buildComponentStatusTaskArgs(networkName, recipePath, component) {
	return ["check:component", "--recipe", recipePath, "--component", component, "--network", networkName];
}

/** Every recipe-backed status command is read-only and must expose no signer or explorer credential. */
export function statusHardhatEnvironment(recipeContext) {
	return recipeContext ? recipeHardhatEnvironment(recipeContext, { SYMMIO_RECIPE_READ_ONLY: "true" }) : {};
}

export function componentStatusCheckpointScope(recipeName, component) {
	return `component-${recipeName}-${component}`;
}

/**
 * A component recipe and a system recipe have deliberately different evidence paths.
 * Refuse an ambiguous status request before reading either one.
 */
export function resolveStatusRecipeSelection(recipeContext, only, configLabel = recipeContext.path) {
	const coreMode = recipeContext.recipe.core.mode;
	if (only) {
		if (coreMode !== "reuse") {
			throw new Error(
				`--only ${only} requires a component recipe with core.mode=reuse; this recipe has core.mode=${coreMode}. ` +
					`Run status without --only to inspect its full-system deployment.`,
			);
		}
		const plan = createDeploymentPlan(recipeContext.recipe, { only });
		return { kind: "component", component: only, plan };
	}

	if (coreMode === "reuse") {
		const enabled = ["partyB", "symbolManager", "expressProvider"].filter(component => recipeContext.recipe[component]?.mode === "deploy");
		const selection =
			enabled.length === 1 ? `--only ${enabled[0]}` : `--only ${["partyB", "symbolManager", "expressProvider"].join(" or --only ")}`;
		throw new Error(
			`This is a component recipe because core.mode=reuse. Select its component explicitly: ` +
				`./symmio status --config ${configLabel} ${selection}`,
		);
	}

	return { kind: "system", component: null, plan: createDeploymentPlan(recipeContext.recipe) };
}

function sameAddress(actual, expected) {
	return validAddress(actual) && validAddress(expected) && actual.toLowerCase() === expected.toLowerCase();
}

function sameResolvedPath(actual, expected) {
	return typeof actual === "string" && actual.trim() !== "" && path.resolve(actual) === path.resolve(expected);
}

export function validateComponentStatusReport(report, expected) {
	// Reuse the deployment handoff validator, then add the dependency/path binding that
	// matters specifically when this report is later used as status evidence.
	validateComponentReport(report, expected);
	if (!sameResolvedPath(report.recipe.path, expected.recipePath)) {
		throw new Error(`component report recipe path ${JSON.stringify(report.recipe.path)} does not match ${expected.recipePath}`);
	}
	if (!report.coreDependency || typeof report.coreDependency !== "object" || Array.isArray(report.coreDependency)) {
		throw new Error("component report is missing its reused-Core binding");
	}
	if (!sameResolvedPath(report.coreDependency.reportPath, expected.coreReportPath)) {
		throw new Error(
			`component report Core dependency path ${JSON.stringify(report.coreDependency.reportPath)} does not match ${expected.coreReportPath}`,
		);
	}
	if (report.coreDependency.deploymentId !== expected.coreReport.deploymentId) {
		throw new Error(
			`component report Core deploymentId is ${JSON.stringify(report.coreDependency.deploymentId)}, expected ${expected.coreReport.deploymentId}`,
		);
	}
	for (const field of ["diamond", "instantLayer"]) {
		if (!sameAddress(report.coreDependency[field], expected.coreReport.addresses[field])) {
			throw new Error(
				`component report Core ${field} is ${JSON.stringify(report.coreDependency[field])}, expected ${expected.coreReport.addresses[field]}`,
			);
		}
	}
	return report;
}

export function validateComponentStatusCheckpoint(checkpoint, report, expected) {
	if (!checkpoint) throw new Error(`component checkpoint is missing: ${expected.path}`);
	if (checkpoint._corrupt) throw new Error(`component checkpoint is unreadable: ${checkpoint._path || expected.path}`);
	if (checkpoint._scopeMismatch) {
		throw new Error(
			`component checkpoint scope is ${JSON.stringify(checkpoint._actualScope)}, expected ${JSON.stringify(checkpoint._expectedScope)}`,
		);
	}
	if (checkpoint.scope !== expected.scope) {
		throw new Error(`component checkpoint scope is ${JSON.stringify(checkpoint.scope)}, expected ${expected.scope}`);
	}
	if (checkpoint.chainId !== Number(expected.chainId)) {
		throw new Error(`component checkpoint chainId is ${JSON.stringify(checkpoint.chainId)}, expected ${Number(expected.chainId)}`);
	}
	if (checkpoint.network !== expected.networkName) {
		throw new Error(`component checkpoint network is ${JSON.stringify(checkpoint.network)}, expected ${expected.networkName}`);
	}
	validateCheckpointReportBinding(checkpoint, report);
	if (!checkpoint.manifest || checkpoint.manifest.deploymentId !== report.deploymentId) {
		throw new Error("component checkpoint manifest is missing or belongs to another deployment attempt");
	}
	const checkpointContract = expected.component === "partyB" ? checkpoint.contracts?.symmioPartyB : checkpoint.contracts?.symbolManager;
	if (!sameAddress(checkpointContract?.address, report.address)) {
		throw new Error(`component checkpoint address is ${JSON.stringify(checkpointContract?.address)}, but the report records ${report.address}`);
	}
	if (expected.component === "partyB" && !sameAddress(checkpointContract?.implementation, report.implementation)) {
		throw new Error(
			`PartyB checkpoint implementation is ${JSON.stringify(checkpointContract?.implementation)}, but the report records ${report.implementation}`,
		);
	}
	if (checkpoint.step !== report.lifecycle) {
		throw new Error(
			`component checkpoint lifecycle is ${JSON.stringify(checkpoint.step)}, but the report lifecycle is ${JSON.stringify(report.lifecycle)}; evidence is stale`,
		);
	}
	return checkpoint;
}

export function validateStatusReport(report, expectedChainId, { requireVerification = false, recipeContext = null } = {}) {
	if (!report || typeof report !== "object") throw new Error("deployment report is missing");
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
	if (report.lifecycle !== undefined && !KNOWN_LIFECYCLES.has(report.lifecycle)) {
		throw new Error(`deployment report has unknown lifecycle ${JSON.stringify(report.lifecycle)}`);
	}
	if (report.lifecycle === "validating" || report.lifecycle === "failed" || report.lifecycle === undefined) {
		throw new Error(`deployment report is not in a successful lifecycle: ${JSON.stringify(report.lifecycle)}`);
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
	if (report.checks?.verificationPolicy === "required" && report.checks?.verification !== "passed") {
		throw new Error(`required explorer verification is not passed: ${JSON.stringify(report.checks?.verification)}`);
	}
	if (requireVerification) {
		if (report.checks?.verificationPolicy !== "required") {
			throw new Error(`live deployment verification policy is not required: ${JSON.stringify(report.checks?.verificationPolicy)}`);
		}
		if (report.checks?.verification !== "passed") {
			throw new Error(`live deployment explorer verification is not passed: ${JSON.stringify(report.checks?.verification)}`);
		}
	}
	return report;
}

export function validateCheckpointReportBinding(checkpoint, report) {
	if (!checkpoint) return;
	if (typeof checkpoint.deploymentId !== "string" || checkpoint.deploymentId.trim() === "") {
		throw new Error("active checkpoint is missing deploymentId");
	}
	if (!report || report.deploymentId !== checkpoint.deploymentId) {
		throw new Error(
			`active checkpoint deploymentId ${checkpoint.deploymentId} does not match report deploymentId ${report?.deploymentId ?? "missing"}; the report belongs to an earlier attempt`,
		);
	}
}

function componentExpectedConfig(recipeContext, component) {
	return component === "partyB"
		? {
				admin: recipeContext.recipe.governance.admin,
				signer: recipeContext.recipe.partyB.signer,
				adlEnabled: recipeContext.recipe.partyB.adlEnabled,
			}
		: {
				admin: recipeContext.recipe.governance.admin,
				operator: recipeContext.recipe.symbolManager.operator,
			};
}

function componentRerunCommand(configLabel, component) {
	return `./symmio deploy --config ${configLabel} --only ${component}`;
}

function showComponentStatusReport(report, reportPath, checkpointPath, networkName) {
	title("Component deployment report");
	kv([
		["component", report.component],
		["deployment", report.deploymentId],
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
		["Core dependency", report.coreDependency.diamond],
		["verification", `${report.verification.policy} / ${report.verification.status}`],
		["recorded health", report.health.status],
		["report", reportPath],
		["checkpoint", checkpointPath],
	]);
	log(`  ${c.grey("explorer")} ${explorerAddressUrl(networkName, report.address)}`);

	if (report.manualActions.length > 0) {
		title("Exact Safe actions still recorded");
		for (const [index, action] of report.manualActions.entries()) {
			log(`  ${c.yellow(`${index + 1}.`)} ${action.description}`);
			log(`     ${c.grey("to")}     ${action.to}`);
			log(`     ${c.grey("value")}  ${action.value}`);
			log(`     ${c.grey("data")}   ${action.data}`);
		}
	}
}

function showComponentRerun(configLabel, component, { safeActions = false } = {}) {
	const detail = safeActions
		? "after the Safe actions confirm, rerun this identical deploy command; it resumes without redeploying and refreshes the report/checkpoint"
		: "rerun this identical deploy command to reconcile and refresh the component evidence";
	info(detail);
	log(`  ${c.cyan(componentRerunCommand(configLabel, component))}`);
}

async function componentStatus(args, recipeContext, selection, chain) {
	const component = selection.component;
	const dependencyBinding = recipeContext.dependencies?.coreReport;
	if (!dependencyBinding) {
		throw new Error(`component status requires the recipe's pinned core.fromReport dependency`);
	}
	const coreReport = loadCoreDependencyReport(dependencyBinding.identityPath, {
		network: recipeContext.recipe.network.name,
		chainId: recipeContext.recipe.network.chainId,
		live: recipeContext.recipe.network.mode === "live",
		digest: dependencyBinding.digest,
	});
	const expected = {
		component,
		networkName: selection.plan.network.name,
		chainId: selection.plan.network.chainId,
		recipeName: recipeContext.recipe.name,
		recipeDigest: recipeContext.digest,
		recipePath: recipeContext.path,
		live: recipeContext.recipe.network.mode === "live",
		config: componentExpectedConfig(recipeContext, component),
		coreReport,
		coreReportPath: dependencyBinding.identityPath,
	};

	let evidence;
	try {
		evidence = readComponentReport(chain.chainId, {
			simulated: chain.simulated,
			recipeName: recipeContext.recipe.name,
			...expected,
		});
		validateComponentStatusReport(evidence.report, expected);
	} catch (error) {
		fail(`cannot validate the ${component} component report`, error.message || String(error));
		showComponentRerun(args.config, component);
		blank();
		return 1;
	}

	const scope = componentStatusCheckpointScope(recipeContext.recipe.name, component);
	const checkpointPath = deploymentCheckpointPath(chain.chainId, { simulated: chain.simulated, scope });
	showComponentStatusReport(evidence.report, evidence.path, checkpointPath, selection.plan.network.name);
	const checkpoint = readCheckpoint(chain.chainId, { simulated: chain.simulated, scope });
	try {
		validateComponentStatusCheckpoint(checkpoint, evidence.report, {
			component,
			chainId: chain.chainId,
			networkName: selection.plan.network.name,
			scope,
			path: checkpointPath,
		});
	} catch (error) {
		fail(`cannot validate the ${component} component checkpoint`, error.message || String(error));
		showComponentRerun(args.config, component, { safeActions: evidence.report.manualActions.length > 0 });
		blank();
		return 1;
	}

	title("Canonical component on-chain check");
	info(`running the read-only ${component} checker from the exact recipe, dependency report, component report, and checkpoint`);
	const code = await hardhat(buildComponentStatusTaskArgs(selection.plan.network.name, recipeContext.path, component), {
		env: statusHardhatEnvironment(recipeContext),
	});
	if (code !== 0) {
		blank();
		log(`  ${c.red(c.bold(`${component} is not in a complete, current state`))}`);
		showComponentRerun(args.config, component, { safeActions: evidence.report.manualActions.length > 0 });
		blank();
		return code;
	}

	if (evidence.report.lifecycle !== "complete" || checkpoint.step !== "complete") {
		warn(
			`${component} lifecycle is still ${evidence.report.lifecycle}`,
			"status stays nonzero until the identical deploy rerun records complete post-state",
		);
		showComponentRerun(args.config, component, { safeActions: evidence.report.manualActions.length > 0 });
		blank();
		return 1;
	}

	blank();
	log(`  ${c.green(c.bold(`canonical ${component} health check passed`))}`);
	blank();
	return 0;
}

export async function status(args) {
	if (args.only && !args.config) throw new Error("--only requires --config");
	const recipeContext = args.config ? loadRecipeContext(args.config, { plan: false }) : null;
	const selection = recipeContext ? resolveStatusRecipeSelection(recipeContext, args.only, args.config) : { kind: "system", component: null };
	if (selection.kind === "component" && (args.diamond || args["account-layer"] || args["instant-layer"])) {
		throw new Error("component status is report-bound; address override flags are only valid for full-system status");
	}
	const networkName = recipeContext?.networkName || args.network;
	if (!networkName) throw new Error("exactly one of --config or --network is required");
	const chain = resolveNetwork(networkName);
	if (recipeContext) assertRecipeNetworkCompatibility(recipeContext.recipe, chain);
	const mainnet = isLiveMainnet(chain);

	blank();
	kv([
		["network", `${chain.key} ${c.grey(`(chainId ${chain.chainId})`)}`],
		["mode", chain.simulated ? c.cyan("SIMULATED FORK") : mainnet ? c.yellow("MAINNET") : c.grey("non-mainnet")],
	]);

	if (selection.kind === "component") return componentStatus(args, recipeContext, selection, chain);

	const checkpoint = readCheckpoint(chain.chainId, { simulated: chain.simulated });
	if (checkpoint?._corrupt) {
		fail("checkpoint file is unreadable", checkpoint._path);
		return 1;
	}
	if (checkpoint) {
		warn(
			"an active deployment checkpoint exists",
			`deployment: ${checkpoint.deploymentId ?? "unknown"}; last step: ${checkpoint.step ?? "unknown"}`,
		);
	}

	let report;
	try {
		const rawReport = readDeploymentReport(chain.chainId, { simulated: chain.simulated });
		validateCheckpointReportBinding(checkpoint, rawReport);
		report = validateStatusReport(rawReport, chain.chainId, {
			requireVerification: mainnet,
			recipeContext,
		});
	} catch (error) {
		fail("cannot run a complete status check", error.message || String(error));
		info(`deploy:system must write tasks/data/${chain.chainId}${chain.simulated ? "-fork" : ""}/deployment-report.json`);
		blank();
		return 1;
	}

	title("Deployment report");
	kv([
		["deployment", report.deploymentId || c.grey("legacy report")],
		["lifecycle", report.lifecycle || c.yellow("legacy/unknown")],
		["Core Diamond", report.addresses.diamond],
		["AccountLayer Diamond", report.addresses.accountLayerDiamond],
		["InstantLayer", report.addresses.instantLayer],
		["SymbolManager", report.addresses.symbolManager || c.grey("not deployed")],
	]);
	log(`  ${c.grey("explorer")} ${explorerAddressUrl(networkName, report.addresses.diamond)}`);

	if (report.manualActions?.length) {
		title("Reported manual actions");
		for (const [index, action] of report.manualActions.entries()) log(`  ${c.yellow(`${index + 1}.`)} ${action}`);
	}

	title("Canonical on-chain health check");
	info("running check:deployment from the chain-scoped report; any unreadable critical probe fails");
	const code = await hardhat(buildStatusTaskArgs(networkName, args), {
		env: statusHardhatEnvironment(recipeContext),
	});
	if (code !== 0) {
		blank();
		log(`  ${c.red(c.bold("deployment is not healthy"))}`);
		blank();
		return code;
	}

	blank();
	log(`  ${c.green(c.bold("canonical deployment health check passed"))}`);
	if (checkpoint) {
		warn(
			"deployment is not final while its checkpoint is active",
			"resume deploy:system and resolve the checkpoint before relying on this status",
		);
		blank();
		return 1;
	}
	if (report.lifecycle !== "complete") {
		warn(`report lifecycle is still ${report.lifecycle}`, "re-run deploy:system to refresh/archive the handover report after admin actions");
		blank();
		return 1;
	}
	blank();
	return 0;
}
