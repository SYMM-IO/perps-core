import {
	configurationHelpLines,
	configurationLocations,
	doctorNextStepLines,
	recipeDiagnostic,
	referencedRecipeFields,
	runtimeConfigurationRows,
} from "../lib/config-guide.js";
import assert from "node:assert/strict";
import test from "node:test";

test("configuration guide separates recipe inputs from generated deployment state", () => {
	const live = configurationLocations({ chainId: 42161, recipePath: "deployments/arbitrum.json" });
	assert.match(live.recipeExample, /deployment\/examples\/arbitrum\.v1\.example\.json$/);
	assert.match(live.recipe, /deployments\/arbitrum\.json$/);
	assert.match(live.deploymentReport, /tasks\/data\/42161\/deployment-report\.json$/);
	assert.match(live.checkpoint, /tasks\/data\/checkpoints\/checkpoint-42161\.json$/);
	assert.match(live.componentReport, /tasks\/data\/42161\/components\/<recipe-name>\/<component>-report\.json$/);
	assert.match(live.componentCheckpoint, /checkpoint-42161-component-<recipe-name>-<component>\.json$/);

	const fork = configurationLocations({ chainId: 42161, simulated: true, recipePath: "deployments/fork-arbitrum.json" });
	assert.match(fork.deploymentReport, /tasks\/data\/42161-fork\/deployment-report\.json$/);
	assert.match(fork.checkpoint, /tasks\/data\/checkpoints\/checkpoint-42161-fork\.json$/);
});

test("help starts from guided recipes and the menu-only checkout-local launcher", () => {
	const help = configurationHelpLines().join("\n");
	assert.match(help, /Guided recipe and durable evidence/);
	assert.match(help, /deployment\/examples\/arbitrum\.v1\.example\.json/);
	assert.match(help, /deployments\/<name>\.json/);
	assert.match(help, /^\s*\.\/symmio$/m);
	assert.match(help, /Choose Deploy a contract/);
	assert.doesNotMatch(help, /\.\/symmio[ \t]+\w+/);
	assert.match(help, /npm link/);
	assert.doesNotMatch(help, /\.env/);
});

test("recipe diagnostics identify exact editable JSON fields", () => {
	assert.deepEqual(referencedRecipeFields("ADMIN_PUBLIC_KEY is missing and PARTYB_SIGNER is invalid"), ["governance.admin", "partyB.signer"]);
	const rendered = recipeDiagnostic(
		"ADMIN_PUBLIC_KEY is not a valid address",
		"PARTYB_SIGNER must be corrected",
		"/repo/deployments/arbitrum.json",
	);
	assert.match(rendered.message, /governance\.admin/);
	assert.match(rendered.detail, /partyB\.signer/);
	assert.match(rendered.detail, /deployments\/arbitrum\.json/);
});

test("doctor next steps return operators to guided correction and review", () => {
	const recipe = doctorNextStepLines({
		networkName: "arbitrum",
		recipePath: "/repo/deployments/prod.json",
		blockingFields: ["governance.admin", "partyB.signer"],
	}).join("\n");
	assert.match(recipe, /guided form for \/repo\/deployments\/prod\.json \(governance\.admin, partyB\.signer\)/);
	assert.match(recipe, /Correct the highlighted values/);
	assert.match(recipe, /Review the grouped intent/);

	const component = doctorNextStepLines({
		networkName: "arbitrum",
		recipePath: "/repo/deployments/arbitrum-partyB.json",
		only: "partyB",
	}).join("\n");
	assert.match(component, /guided form for \/repo\/deployments\/arbitrum-partyB\.json/);
	assert.match(component, /operator task for partyB/);

	const legacy = doctorNextStepLines({ networkName: "arbitrum", legacy: true }).join("\n");
	assert.match(legacy, /Launch \.\/symmio\. Choose Deploy a contract/);
	assert.match(legacy, /arbitrum/);
	assert.doesNotMatch(legacy, /\.\/symmio[ \t]+\w+/);
	assert.doesNotMatch(legacy, /\.env/);
});

test("runtime guide shows the selected recipe, report, and checkpoint destinations", () => {
	const guide = runtimeConfigurationRows({ chainId: 42161, simulated: true, recipePath: "deployments/fork.json" });
	const rendered = guide.rows.flat().join("\n");
	assert.match(rendered, /deployments\/fork\.json/);
	assert.match(rendered, /tasks\/data\/42161-fork\/deployment-report\.json/);
	assert.match(rendered, /checkpoint-42161-fork\.json/);

	const component = runtimeConfigurationRows({
		chainId: 42161,
		simulated: false,
		recipePath: "deployments/arbitrum-partyB.json",
		recipeName: "arbitrum-partyB",
		component: "partyB",
		coreReportPath: "tasks/data/42161/deployment-report.json",
	})
		.rows.flat()
		.join("\n");
	assert.match(component, /components\/arbitrum-partyB\/partyB-report\.json/);
	assert.match(component, /checkpoint-42161-component-arbitrum-partyB-partyB\.json/);
	assert.match(component, /reused Core report/);
	assert.doesNotMatch(component, /generated report/);
});
