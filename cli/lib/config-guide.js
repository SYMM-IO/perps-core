import { PROJECT_ROOT, projectPath } from "./paths.js";
import path from "node:path";

export const RECIPE_EXAMPLE = projectPath("deployment-tooling", "examples", "arbitrum.v1.example.json");

export const RECIPE_FIELD_BY_RUNTIME_KEY = Object.freeze({
	ADMIN_PUBLIC_KEY: "governance.admin",
	COLLATERAL_ADDRESS: "core.collateral.address",
	CREATE2_FACTORY_ADDRESS: "create2.factoryAddress",
	DEPLOY_LOG_LEVEL: "execution.logLevel",
	DEPLOY_MOCK_VERIFIER: "core.muon.mode",
	DEPLOY_PARTYB: "partyB.mode",
	DEPLOY_SYMBOL_MANAGER: "symbolManager.mode",
	DIAMOND_VANITY_PREFIX: "create2.groups.diamonds.prefix",
	ETHERSCAN_APIKEY: "secrets.explorer",
	FORK_BLOCK_NUMBER: "execution.forkBlockNumber",
	LIQUIDATION_INSURANCE_VAULT: "governance.liquidationInsuranceVault",
	MAX_LIQUIDATION_PROFIT_PER_POSITION: "governance.maxLiquidationProfitPerPosition",
	MUON_APP_ID: "core.muon.appId",
	MUON_FUNCTION_PERMISSIONS: "core.muon.permissions",
	MUON_FUNCTION_UPNL_VALID_TIMES: "core.muon.upnlValidTimeByFunction",
	MUON_GATEWAY_SIGNERS: "core.muon.gatewaySigners",
	MUON_PRICE_VALID_TIME: "core.muon.priceValidTime",
	MUON_PUBLIC_KEY_PARITY: "core.muon.publicKey.parity",
	MUON_PUBLIC_KEY_X: "core.muon.publicKey.x",
	MUON_SIGNATURE_VERIFIER_ADDRESS: "core.muon.address",
	MUON_UPNL_VALID_TIME: "core.muon.upnlValidTime",
	NEW_DEPLOYER: "secrets.deployer",
	PARTYB_OPERATORS: "partyB.operators",
	PARTYB_SIGNER: "partyB.signer",
	REGISTER_DUMMY_AFFILIATE: "core.registerDummyAffiliate",
	RPC_ARBITRUM: "secrets.rpc",
	SET_ADL_ENABLED: "partyB.adlEnabled",
	SETUP_INSTANT_LAYER_TEMPLATES: "core.setupInstantLayerTemplates",
	SOFT_LIQUIDATION_PENALTY_COLLECTOR: "governance.softLiquidationPenaltyCollector",
	SYMBOL_MANAGER_OPERATOR: "symbolManager.operator",
	SYMMIO_FEE_RECEIVER: "governance.feeReceiver",
	SYMMIO_RPC_URL_OVERRIDE: "secrets.rpc",
	TEAM_DEPLOYER: "secrets.deployer",
	USE_KEYSTORE: "secrets",
});

export function displayPath(target) {
	const relative = path.relative(PROJECT_ROOT, target);
	return relative && !relative.startsWith("..") ? relative : target;
}

export function configurationLocations({
	chainId = "<chainId>",
	simulated = false,
	recipePath = "deployment-recipes/<name>.json",
	recipeName = "<recipe-name>",
	component = "<component>",
} = {}) {
	const scope = `${chainId}${simulated && chainId !== "<chainId>" ? "-fork" : ""}`;
	const resolvedRecipe = path.isAbsolute(recipePath) ? recipePath : projectPath(...recipePath.split(/[\\/]/));
	return {
		checkout: PROJECT_ROOT,
		recipeExample: RECIPE_EXAMPLE,
		recipe: resolvedRecipe,
		deploymentReport: projectPath("tasks", "data", scope, "deployment-report.json"),
		checkpoint: projectPath("tasks", "data", "checkpoints", `checkpoint-${scope}.json`),
		componentReport: projectPath("tasks", "data", scope, "components", recipeName, `${component}-report.json`),
		componentCheckpoint: projectPath("tasks", "data", "checkpoints", `checkpoint-${scope}-component-${recipeName}-${component}.json`),
	};
}

export function configurationHelpLines() {
	const locations = configurationLocations();
	return [
		"Guided recipe and durable evidence",
		`  reviewed example   ${displayPath(locations.recipeExample)}`,
		`  your configuration ${displayPath(locations.recipe)}`,
		`  generated report   ${displayPath(locations.deploymentReport)}  (output; do not edit)`,
		`  component report   ${displayPath(locations.componentReport)}  (output; do not edit)`,
		`  resume checkpoint  ${displayPath(locations.checkpoint)}  (managed automatically)`,
		"",
		"Use it from this checkout",
		"  ./symmio",
		"  Choose Deploy a contract, then follow the typed form and grouped review.",
		"  Preflight, compilation, rehearsal, execution and health run in one task.",
		"",
		"Optional global command",
		"  npm link  # after this, `symmio` launches the same menu",
	];
}

/** Map runtime/task keys in an existing diagnostic back to editable JSON fields. */
function recipeFieldForRuntimeKey(name) {
	return RECIPE_FIELD_BY_RUNTIME_KEY[name] || (/^RPC_[A-Z0-9_]+$/.test(name) ? "secrets.rpc" : undefined);
}

export function referencedRecipeFields(message) {
	const names = String(message).match(/\b[A-Z][A-Z0-9_]+\b/g) ?? [];
	return [...new Set(names.map(recipeFieldForRuntimeKey).filter(Boolean))];
}

export function recipeDiagnostic(message, detail, recipePath, { includeEditHint = true } = {}) {
	const fields = referencedRecipeFields(`${message} ${detail ?? ""}`);
	if (fields.length === 0) return { message, detail, fields };
	const replace = value => String(value).replace(/\b[A-Z][A-Z0-9_]+\b/g, name => recipeFieldForRuntimeKey(name) || name);
	const editHint = includeEditHint ? `correct ${fields.join(", ")} in the guided form for ${displayPath(recipePath)}` : "";
	return {
		message: replace(message),
		detail: detail ? [replace(detail), editHint].filter(Boolean).join("; ") : editHint || undefined,
		fields,
	};
}

export function doctorNextStepLines({ networkName, recipePath, blockingFields = [], only, legacy = false }) {
	const target = recipePath ? displayPath(recipePath) : `deployment-recipes/${networkName}.json`;
	if (legacy) {
		return [
			"Next steps",
			"  Launch ./symmio. Choose Deploy a contract.",
			`  Select ${only || "the deployment"} and ${networkName}; the guided form creates and validates the recipe.`,
		];
	}
	const fields = blockingFields.length ? ` (${blockingFields.join(", ")})` : "";
	return [
		"Next steps",
		`  1. Return to the guided form for ${target}${fields}.`,
		`  2. Correct the highlighted value${blockingFields.length === 1 ? "" : "s"}; validation runs immediately.`,
		`  3. Review the grouped intent, then continue the same operator task${only ? ` for ${only}` : ""}.`,
	];
}

export function runtimeConfigurationRows({ chainId, simulated, recipePath, recipeName, component, coreReportPath, legacy = false }) {
	const locations = configurationLocations({
		chainId,
		simulated,
		recipePath: recipePath || "deployment-recipes/<name>.json",
		recipeName,
		component,
	});
	const stateRows = component
		? [
				["reused Core report", displayPath(coreReportPath || "<core.fromReport>")],
				["component report", `${displayPath(locations.componentReport)}  (output; do not edit)`],
				["component checkpoint", `${displayPath(locations.componentCheckpoint)}  (managed automatically)`],
			]
		: [
				["generated report", `${displayPath(locations.deploymentReport)}  (output; do not edit)`],
				["resume checkpoint", `${displayPath(locations.checkpoint)}  (managed automatically)`],
			];
	return {
		locations,
		rows: [
			["checkout", locations.checkout],
			[legacy ? "recommended recipe" : "deployment recipe", displayPath(locations.recipe)],
			["reviewed example", displayPath(locations.recipeExample)],
			...stateRows,
		],
	};
}
