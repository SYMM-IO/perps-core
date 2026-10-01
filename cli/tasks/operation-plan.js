import { buildCorePlan } from "../../deployment-tooling/operations/core-plan.js";
import {
	assertOperationUnchanged,
	loadOperation,
	OperationError,
	operationDigest,
	readOperationJson,
} from "../../deployment-tooling/operations/inputs.js";
import { renderCoreReview, writeImmutableDocument, writeOperationFile, writeOperationResult } from "../../deployment-tooling/operations/outputs.js";
import { recipeHardhatEnvironment } from "../lib/recipe-context.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const OPERATION_PLAN_STEPS = [
	{ id: "inspect", phase: "inspect", title: "Read the selected deployment at one block" },
	{ id: "plan", phase: "plan", title: "Compare the release and write the review" },
];

export function prepareOperationRequest(requestPath) {
	const { resolved, recipe } = loadOperation(requestPath);
	return {
		requestPath: path.resolve(requestPath),
		inputDigest: resolved.inputDigest,
		network: resolved.profile.network.name,
		chainId: resolved.profile.network.chainId,
		mode: resolved.profile.network.mode,
		config: recipe.path,
		recipeDigest: recipe.digest,
	};
}

function loadBound(input) {
	const bundle = assertOperationUnchanged(input.requestPath, input.inputDigest),
		network = bundle.resolved.profile.network;
	if (
		input.network !== network.name ||
		input.chainId !== network.chainId ||
		input.mode !== network.mode ||
		input.config !== bundle.recipe.path ||
		input.recipeDigest !== bundle.recipe.digest
	)
		throw new OperationError("input-drift", "Prepared operation does not match its profile and credential recipe");
	return bundle;
}

const directoryFor = (ctx, input) =>
	path.join(ctx.root, "tasks", "data", `${input.chainId}${input.mode === "fork" ? "-fork" : ""}`, "operations", ctx.state.runId);

export function createOperationPlanTask(common) {
	return common({
		id: "operations.plan",
		version: 1,
		category: "maintenance",
		risk: "local-write",
		title: "Plan a Core upgrade from JSON",
		description: "Load a deployment profile and pinned release, inspect installed facets, and export a standard read-only upgrade plan.",
		inputs: [{ id: "requestPath", label: "Operation request JSON", type: "string", required: true }],
		artifacts: ["request.json", "resolved-input.json", "snapshot.json", "plan.json", "review.md", "result.json", "summary.md"],
		prepare: async ({ root, ui }) => {
			const request = await ui.text({
				message: "Operation request JSON path",
				validate: value => {
					try {
						prepareOperationRequest(path.resolve(root, value));
					} catch (error) {
						return error.message;
					}
				},
			});
			return request === null ? null : prepareOperationRequest(path.resolve(root, request));
		},
		plan: (_ctx, input) => {
			loadBound(input);
			return OPERATION_PLAN_STEPS.map(step => ({ ...step }));
		},
		validateResume: (_ctx, input) => loadBound(input),
		reconcile: () => ({ unresolved: [] }),
		cancel: (ctx, input) => {
			const directory = directoryFor(ctx, input),
				resolvedFile = path.join(directory, "resolved-input.json");
			if (fs.existsSync(resolvedFile))
				writeOperationResult(directory, readOperationJson(resolvedFile).value, {
					runId: ctx.state.runId,
					eventPath: ctx.state.eventPath,
					status: "cancelled",
				});
			return { message: "Planning cancelled; no on-chain transactions were submitted" };
		},
		run: async (ctx, input) => {
			const directory = directoryFor(ctx, input),
				snapshotPath = path.join(directory, "snapshot.json");
			const bundle = loadBound(input),
				{ resolved } = bundle;
			writeImmutableDocument(directory, "request.json", resolved.request);
			writeImmutableDocument(directory, "resolved-input.json", resolved);
			try {
				const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ctx.root, encoding: "utf8" }).trim();
				if (source !== resolved.release.sourceCommit)
					throw new OperationError("source-mismatch", "Checkout commit differs from the pinned release source");
				await ctx.step("inspect", OPERATION_PLAN_STEPS[0].title, async () => {
					await ctx.runProcess(
						"./node_modules/.bin/hardhat",
						["internal:operations-inspect", "--request", input.requestPath, "--output", snapshotPath, "--network", input.network],
						{
							env: recipeHardhatEnvironment(bundle.recipe, {
								SYMMIO_OPERATION_INPUT: input.inputDigest,
								SYMMIO_RECIPE_READ_ONLY: "true",
								SYMMIO_SIGNER_MODE: "safe-file",
							}),
						},
					);
					loadBound(input);
					const snapshot = readOperationJson(snapshotPath).value;
					buildCorePlan(bundle, snapshot);
					ctx.state.operationSnapshotDigest = operationDigest(snapshot);
				});
				loadBound(input);
				const snapshot = readOperationJson(snapshotPath).value;
				if (operationDigest(snapshot) !== ctx.state.operationSnapshotDigest)
					throw new OperationError("evidence-drift", "Bound snapshot changed");
				const plan = buildCorePlan(bundle, snapshot);
				await ctx.step("plan", OPERATION_PLAN_STEPS[1].title, async () => {
					writeImmutableDocument(directory, "plan.json", plan);
					writeOperationFile(path.join(directory, "review.md"), renderCoreReview(resolved, snapshot, plan));
				});
				// Also compare on a resume after the plan step but before final publication.
				writeImmutableDocument(directory, "plan.json", plan);
				writeOperationFile(path.join(directory, "review.md"), renderCoreReview(resolved, snapshot, plan));
				const result = writeOperationResult(directory, resolved, {
					runId: ctx.state.runId,
					eventPath: ctx.state.eventPath,
					status: "planned",
					plan,
				});
				ctx.ui.note(
					`Review: ${path.join(directory, "review.md")}\nResult: ${path.join(directory, "result.json")}\nNo contracts were changed. Execution requirements are listed in the review.`,
					"Plan prepared",
				);
				return result;
			} catch (error) {
				writeOperationResult(directory, resolved, { runId: ctx.state.runId, eventPath: ctx.state.eventPath, status: "paused", error });
				throw error;
			}
		},
	});
}
