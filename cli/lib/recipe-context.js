import {
	DEPLOYMENT_COMPONENTS,
	createDeploymentPlan,
	loadCoreDependencyReport,
	loadDeploymentRecipe,
	recipeEnvironment,
} from "../../deployment/recipe.js";
import { PROJECT_ROOT } from "./paths.js";

const SECRET_RUNTIME_KEYS = Object.freeze({
	deployer: "NEW_DEPLOYER",
	rpc: "SYMMIO_RPC_URL_OVERRIDE",
	explorer: "ETHERSCAN_APIKEY",
});

export { DEPLOYMENT_COMPONENTS, loadCoreDependencyReport };

export function recipeNetworkName(recipe) {
	const name = recipe?.network?.name;
	if (typeof name !== "string" || name.length === 0) {
		throw new Error("network.name: validated deployment recipe did not contain a network name");
	}
	return name;
}

export function expectedRecipeNetworkMode(chain) {
	if (chain?.simulated === true) return "fork";
	if (chain?.key === "localhost") return "local";
	return "live";
}

/** Bind a validated recipe to the exact Hardhat network shape before any RPC is opened. */
export function assertRecipeNetworkCompatibility(recipe, chain) {
	const target = recipe?.network;
	if (!target || typeof target !== "object") throw new Error("network: validated deployment recipe did not contain a network target");
	if (target.name !== chain.key) {
		throw new Error(`network.name: recipe selects ${target.name}, but the CLI resolved ${chain.key}`);
	}
	if (target.chainId !== chain.chainId) {
		throw new Error(`network.chainId: recipe declares ${target.chainId}, but ${chain.key} is chainId ${chain.chainId}`);
	}
	const expectedMode = expectedRecipeNetworkMode(chain);
	if (target.mode !== expectedMode) {
		throw new Error(`network.mode: ${chain.key} requires ${expectedMode}, but the recipe declares ${target.mode}`);
	}
	return target;
}

/**
 * Bind a chain-scoped full deployment report to the exact recipe selected by this CLI
 * invocation. Legacy --network operation intentionally does not call this validator.
 */
export function assertDeploymentReportRecipeBinding(report, context) {
	if (!report?.recipe || typeof report.recipe !== "object" || Array.isArray(report.recipe)) {
		throw new Error("deployment report is missing its recipe binding");
	}
	if (report.recipe.name !== context.recipe.name) {
		throw new Error(`deployment report recipe name is ${JSON.stringify(report.recipe.name)}, expected ${context.recipe.name}`);
	}
	if (report.recipe.digest !== context.digest) throw new Error("deployment report recipe digest does not match the selected JSON recipe");
	if (typeof report.recipe.path !== "string" || report.recipe.path.trim() === "") throw new Error("deployment report recipe path is missing");
	if (!report.recipe.components || typeof report.recipe.components !== "object" || Array.isArray(report.recipe.components)) {
		throw new Error("deployment report recipe binding is missing component modes");
	}
	for (const component of DEPLOYMENT_COMPONENTS) {
		const expectedMode = context.recipe[component].mode;
		if (report.recipe.components[component] !== expectedMode) {
			throw new Error(
				`deployment report recipe component ${component} is ${JSON.stringify(report.recipe.components[component])}, expected ${expectedMode}`,
			);
		}
	}
	const keys = Object.keys(report.recipe.components).sort();
	const expectedKeys = [...DEPLOYMENT_COMPONENTS].sort();
	if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
		throw new Error(`deployment report recipe components must contain exactly: ${DEPLOYMENT_COMPONENTS.join(", ")}`);
	}
	return report.recipe;
}

/**
 * Resolve only secret references explicitly named by the recipe. This never reads a
 * dotenv file and never includes secret values in the returned recipe/plan metadata.
 */
export function resolveRecipeEnvironment(projection, processEnv = process.env) {
	const env = { ...(projection?.env ?? {}) };
	const missingSecrets = [];
	const operatorSignerMode = processEnv.SYMMIO_SIGNER_MODE;
	for (const [purpose, reference] of Object.entries(projection?.secrets ?? {})) {
		if (!reference) continue;
		if (purpose === "deployer" && operatorSignerMode) {
			if (operatorSignerMode === "private-key") {
				const privateKey = processEnv.SYMMIO_EPHEMERAL_PRIVATE_KEY;
				if (!privateKey) missingSecrets.push({ purpose, key: "SYMMIO_EPHEMERAL_PRIVATE_KEY", field: "task.signer" });
				else env.NEW_DEPLOYER = privateKey;
			}
			continue;
		}
		if (reference.provider === "hardhat-keystore") continue;
		if (reference.provider !== "env") continue;
		const value = processEnv[reference.key];
		if (!value) {
			missingSecrets.push({ purpose, key: reference.key, field: `secrets.${purpose}` });
			continue;
		}
		const runtimeKey = SECRET_RUNTIME_KEYS[purpose];
		if (runtimeKey) env[runtimeKey] = value;
	}
	return { env, missingSecrets, secrets: projection?.secrets ?? {} };
}

export function loadRecipeContext(configPath, { only, processEnv = process.env, plan = true } = {}) {
	const loaded = loadDeploymentRecipe(configPath, { projectRoot: PROJECT_ROOT });
	const deploymentPlan = plan ? createDeploymentPlan(loaded.recipe, { only }) : null;
	const projection = recipeEnvironment(loaded.recipe);
	const resolved = resolveRecipeEnvironment(projection, processEnv);
	return {
		...loaded,
		plan: deploymentPlan,
		networkName: recipeNetworkName(loaded.recipe),
		env: resolved.env,
		missingSecrets: resolved.missingSecrets,
		secrets: resolved.secrets,
	};
}

export function recipeHardhatEnvironment(context, extra = {}) {
	return {
		...extra,
		SYMMIO_DEPLOYMENT_RECIPE: context.path,
		SYMMIO_DEPLOYMENT_RECIPE_DIGEST: context.digest,
		DOTENV_CONFIG_PATH: "/dev/null",
	};
}
