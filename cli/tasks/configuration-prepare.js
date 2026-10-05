import { loadConfigurationRequest } from "../../deployment-tooling/operations/configuration-request.js";
import { operationDigest, readOperationJson } from "../../deployment-tooling/operations/inputs.js";
import { loadRecipeContext, recipeHardhatEnvironment } from "../lib/recipe-context.js";
import { execFileSync } from "node:child_process";
import path from "node:path";

export function prepareConfigurationRequest(requestPath) {
	const bundle = loadConfigurationRequest(requestPath),
		recipe = loadRecipeContext(bundle.recipePath, { plan: false }),
		network = recipe.recipe.network;
	if (network.chainId !== bundle.profile.chainId) throw new Error("Configuration source chain differs from the credential recipe");
	return {
		requestPath: bundle.path,
		inputDigest: bundle.inputDigest,
		config: recipe.path,
		recipeDigest: recipe.digest,
		network: network.name,
		chainId: network.chainId,
		mode: network.mode,
	};
}
const bound = input => {
	if (operationDigest(prepareConfigurationRequest(input.requestPath)) !== operationDigest(input))
		throw new Error("Configuration input or recipe changed");
	return loadConfigurationRequest(input.requestPath);
};
const outputFor = (ctx, input) =>
	path.join(
		ctx.root,
		"tasks/data",
		`${input.chainId}${input.mode === "fork" ? "-fork" : ""}`,
		"configuration",
		ctx.state.runId,
		"prepared-configuration.json",
	);

export function createConfigurationPrepareTask(common) {
	return common({
		id: "operations.prepare-configuration",
		version: 2,
		category: "maintenance",
		risk: "local-write",
		title: "Prepare configuration preservation from JSON",
		description:
			"Read pinned configuration and optionally plan its setters, administrative roles and consumer wiring for a deployed replacement.",
		inputs: [{ id: "requestPath", label: "Configuration request JSON", type: "string", required: true }],
		artifacts: ["prepared-configuration.json with source snapshot and optional governance calls"],
		prepare: async ({ root, ui }) => {
			const file = await ui.text({
				message: "Configuration request JSON path",
				validate: value => {
					try {
						prepareConfigurationRequest(path.resolve(root, value));
					} catch (error) {
						return error.message;
					}
				},
			});
			return file === null ? null : prepareConfigurationRequest(path.resolve(root, file));
		},
		plan: (_ctx, input) => {
			bound(input);
			return [{ id: "prepare", phase: "inspect", title: "Read and validate configuration preservation" }];
		},
		validateResume: (ctx, input) => {
			bound(input);
			if (
				ctx.state.configurationEvidenceDigest &&
				operationDigest(readOperationJson(outputFor(ctx, input)).value) !== ctx.state.configurationEvidenceDigest
			)
				throw new Error("Configuration evidence changed");
		},
		reconcile: () => ({ unresolved: [] }),
		run: async (ctx, input) => {
			const bundle = bound(input),
				output = outputFor(ctx, input),
				git = args => execFileSync("git", args, { cwd: ctx.root, encoding: "utf8" }).trim();
			if (git(["rev-parse", "HEAD"]) !== bundle.request.sourceCommit || git(["status", "--porcelain", "--untracked-files=no"]))
				throw new Error("Configuration preparation requires its clean bound source checkout");
			await ctx.step("prepare", "Read and validate configuration preservation", async () => {
				await ctx.runProcess(
					"./node_modules/.bin/hardhat",
					["internal:configuration-prepare", "--request", input.requestPath, "--output", output, "--network", input.network],
					{
						env: recipeHardhatEnvironment(loadRecipeContext(input.config, { plan: false }), {
							SYMMIO_CONFIGURATION_INPUT: input.inputDigest,
							SYMMIO_RECIPE_READ_ONLY: "true",
							SYMMIO_SIGNER_MODE: "safe-file",
						}),
					},
				);
				bound(input);
				const result = readOperationJson(output).value;
				if (
					result.inputDigest !== input.inputDigest ||
					result.kind !== "symmio.prepared-configuration" ||
					!["planned", "inspected"].includes(result.status)
				)
					throw new Error("Prepared configuration does not bind the input");
				ctx.state.configurationEvidenceDigest = operationDigest(result);
			});
			const result = readOperationJson(output).value;
			if (operationDigest(result) !== ctx.state.configurationEvidenceDigest) throw new Error("Configuration evidence changed");
			ctx.ui.note(
				`Evidence: ${output}\nSettings: ${result.snapshot.fields.length}\nConfiguration calls: ${result.plan?.actions.length || 0}\nRole grants: ${result.roles?.plan.actions.length || 0}\nWiring activations: ${result.wiring?.plan.activate.length || 0}\nRetirements: ${result.wiring?.plan.retire.length || 0}\nNo transactions were submitted.`,
				"Configuration prepared",
			);
			return result;
		},
	});
}
