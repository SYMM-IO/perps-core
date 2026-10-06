import { isLiveMainnet, readCheckpoint, readDeploymentReport, resolveNetwork } from "../lib/context.js";
import { hardhat } from "../lib/hardhat.js";
import {
	assertDeploymentReportRecipeBinding,
	assertRecipeNetworkCompatibility,
	loadRecipeContext,
	recipeHardhatEnvironment,
} from "../lib/recipe-context.js";

export function buildVerifyTaskArgs(networkName, { retryFailed = false, deploymentId, recipeDigest } = {}) {
	const args = ["verify:all", "--network", networkName];
	if (retryFailed) args.push("--retry-failed");
	if (deploymentId) args.push("--deployment-id", deploymentId);
	if (recipeDigest) args.push("--recipe-digest", recipeDigest);
	return args;
}

export function validateVerifyRecipeReport(report, checkpoint, context, expectedChainId) {
	if (context.recipe.core.mode !== "deploy") {
		const selected =
			context.recipe.partyB.mode === "deploy" ? "partyB" : context.recipe.symbolManager.mode === "deploy" ? "symbolManager" : "component";
		throw new Error(
			`Full-system verification cannot consume a component recipe. ${selected} verification is owned by its operator task; ` +
				`launch ./symmio and continue that task to retry or finalize ${context.path}.`,
		);
	}
	if (!report || typeof report !== "object") throw new Error("chain-scoped deployment report is missing");
	if (report.chainId !== Number(expectedChainId)) {
		throw new Error(`deployment report chainId mismatch: expected ${Number(expectedChainId)}, got ${JSON.stringify(report.chainId)}`);
	}
	assertDeploymentReportRecipeBinding(report, context);
	if (typeof report.deploymentId !== "string" || report.deploymentId.trim() === "") {
		throw new Error("deployment report is missing deploymentId");
	}
	if (report.checks?.health !== "passed") {
		throw new Error(`deployment health must pass before explorer verification; got ${JSON.stringify(report.checks?.health)}`);
	}
	if (checkpoint) {
		if (typeof checkpoint.deploymentId !== "string" || checkpoint.deploymentId.trim() === "") {
			throw new Error("active deployment checkpoint is missing deploymentId");
		}
		if (checkpoint.deploymentId !== report.deploymentId) {
			throw new Error(
				`active checkpoint deploymentId ${checkpoint.deploymentId} does not match report deploymentId ${report.deploymentId}; refusing to verify another attempt's records`,
			);
		}
	}
	return report;
}

export async function verify(args) {
	const recipeContext = args.config ? loadRecipeContext(args.config, { plan: false }) : null;
	const networkName = recipeContext?.networkName || args.network;
	if (!networkName) throw new Error("exactly one of --config or --network is required");
	const chain = resolveNetwork(networkName);
	if (recipeContext) assertRecipeNetworkCompatibility(recipeContext.recipe, chain);
	if (chain.simulated) throw new Error("block-explorer verification is unavailable for ephemeral fork networks");
	let binding = {};
	if (recipeContext) {
		// Reject a component recipe before looking for the unrelated full-system report.
		if (recipeContext.recipe.core.mode !== "deploy") {
			validateVerifyRecipeReport(null, null, recipeContext, chain.chainId);
		}
		const report = validateVerifyRecipeReport(
			readDeploymentReport(chain.chainId, { simulated: chain.simulated }),
			readCheckpoint(chain.chainId, { simulated: chain.simulated }),
			recipeContext,
			chain.chainId,
		);
		if (isLiveMainnet(chain) && report.checks?.verificationPolicy !== "required") {
			throw new Error(`live deployment report verificationPolicy must be required; got ${JSON.stringify(report.checks?.verificationPolicy)}`);
		}
		binding = { deploymentId: report.deploymentId, recipeDigest: recipeContext.digest };
	}
	return hardhat(buildVerifyTaskArgs(networkName, { retryFailed: args["retry-failed"] === true, ...binding }), {
		env: recipeContext ? recipeHardhatEnvironment(recipeContext) : {},
	});
}
