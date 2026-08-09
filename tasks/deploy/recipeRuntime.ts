import { loadDeploymentRecipe, recipeEnvironment, type DeploymentRecipe, type SecretMetadata } from "../../deployment/recipe.js"

export interface ActiveDeploymentRecipe {
	recipe: DeploymentRecipe
	path: string
	identityPath: string
	digest: string
	recipeOnlyDigest: string
	dependencies: { coreReport?: { path: string; identityPath: string; digest: string } }
	env: Record<string, string>
	secrets: Partial<Record<"deployer" | "rpc" | "explorer", SecretMetadata>>
}

export function assertExpectedRecipeDigest(actual: string, expected: string | undefined): void {
	if (!expected) {
		throw new Error(
			"Deployment recipe digest is not pinned. Run through `./symmio deploy --config <recipe.json>` so the reviewed digest is carried across the Hardhat process boundary.",
		)
	}
	if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`Invalid SYMMIO_DEPLOYMENT_RECIPE_DIGEST ${JSON.stringify(expected)}`)
	if (actual !== expected) {
		throw new Error(`Deployment recipe changed after confirmation: expected ${expected}, loaded ${actual}. No transaction was sent.`)
	}
}

const PUBLIC_DEPLOYMENT_ENV = [
	"ADMIN_PUBLIC_KEY",
	"SYMMIO_FEE_RECEIVER",
	"LIQUIDATION_INSURANCE_VAULT",
	"MAX_LIQUIDATION_PROFIT_PER_POSITION",
	"SOFT_LIQUIDATION_PENALTY_COLLECTOR",
	"COLLATERAL_ADDRESS",
	"DEPLOY_PARTYB",
	"SET_ADL_ENABLED",
	"PARTYB_SIGNER",
	"DEPLOY_SYMBOL_MANAGER",
	"SYMBOL_MANAGER_OPERATOR",
	"REGISTER_DUMMY_AFFILIATE",
	"SETUP_INSTANT_LAYER_TEMPLATES",
	"MUON_SIGNATURE_VERIFIER_ADDRESS",
	"DEPLOY_MOCK_VERIFIER",
	"MUON_APP_ID",
	"MUON_UPNL_VALID_TIME",
	"MUON_PRICE_VALID_TIME",
	"MUON_FUNCTION_UPNL_VALID_TIMES",
	"MUON_PUBLIC_KEY_X",
	"MUON_PUBLIC_KEY_PARITY",
	"MUON_GATEWAY_SIGNERS",
	"MUON_FUNCTION_PERMISSIONS",
	"DEPLOY_LOG_LEVEL",
	"DEPLOY_CONFIRMATIONS",
	"DEPLOY_TX_TIMEOUT",
	"DEPLOY_SLOW_TX_NOTICE",
	"FORK_BLOCK_NUMBER",
] as const

function loadActiveRecipe(): ActiveDeploymentRecipe | null {
	const recipePath = process.env.SYMMIO_DEPLOYMENT_RECIPE
	if (!recipePath) return null
	const loaded = loadDeploymentRecipe(recipePath)
	assertExpectedRecipeDigest(loaded.digest, process.env.SYMMIO_DEPLOYMENT_RECIPE_DIGEST)
	const projected = recipeEnvironment(loaded.recipe)
	// Recipe mode is a closed public-intent boundary. Clear every legacy public setting
	// before projecting the validated recipe so ambient shell/.env values cannot override it.
	for (const name of PUBLIC_DEPLOYMENT_ENV) delete process.env[name]
	Object.assign(process.env, projected.env)
	return { ...loaded, ...projected }
}

/** Loaded during Hardhat config evaluation, before deployment task modules read settings. */
export const activeDeploymentRecipe = loadActiveRecipe()

export function requireActiveDeploymentRecipe(recipePath?: string): ActiveDeploymentRecipe {
	if (!activeDeploymentRecipe) {
		throw new Error(
			"Deployment recipe mode is not active. Run through `symmio deploy --config <recipe.json>` so SYMMIO_DEPLOYMENT_RECIPE is set before Hardhat loads its network configuration.",
		)
	}
	if (recipePath) {
		const requested = loadDeploymentRecipe(recipePath)
		if (requested.path !== activeDeploymentRecipe.path || requested.digest !== activeDeploymentRecipe.digest) {
			throw new Error(
				`Deployment recipe mismatch: Hardhat bootstrapped ${activeDeploymentRecipe.path} (${activeDeploymentRecipe.digest.slice(0, 12)}), ` +
					`but the task requested ${requested.path} (${requested.digest.slice(0, 12)}).`,
			)
		}
	}
	return activeDeploymentRecipe
}
