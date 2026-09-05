import {
	assertReleaseSource,
	buildRoundingInput,
	digest,
	FACETS,
	LIBRARIES,
	RECIPE_PATH,
	RELEASE_TAG,
} from "../../deployment-tooling/arbitrum-rounding-upgrade.js";
import { PROJECT_ROOT } from "../lib/paths.js";
import { loadRecipeContext, recipeHardhatEnvironment } from "../lib/recipe-context.js";
import { EOA_SIGNER_MODES, SIGNER_MODES, dispatchSafeActions, selectSigner, validateSignerSelection } from "../signer/index.js";
import { atomicWrite } from "./guided-recipe.js";
import fs from "node:fs";
import path from "node:path";

export const ROUNDING_PLAN = Object.freeze([
	{ id: "compile", phase: "prepare", title: "Compile the tagged rounding-only release" },
	{ id: "inspect", phase: "prepare", title: "Verify the Core baseline, Safe owner and reused libraries" },
	{ id: "rehearse", phase: "rehearsal", title: "Rehearse the four-facet upgrade on the inspected Arbitrum fork" },
	{ id: "authorize", phase: "authorization", title: "Authorize nine contract deployments on Arbitrum" },
	{ id: "deploy", phase: "deployment", title: "Deploy a temporary factory, four libraries and four facets ending in 862" },
	{ id: "publish", phase: "publication", title: "Publish the nine new contracts on Arbiscan" },
	{ id: "core-cut", phase: "execution", title: "Export the Core cut for execution through the Safe" },
	{ id: "verify", phase: "verification", title: "Verify all Core selectors and the new getter" },
]);

const readReport = input => {
	const report = JSON.parse(fs.readFileSync(input.output, "utf8"));
	if (report.inputDigest !== input.inputDigest) throw new Error("Rounding report input changed");
	return report;
};
const environment = (input, extra = {}) => ({
	...recipeHardhatEnvironment(loadRecipeContext(input.config, { plan: false })),
	SYMMIO_ROUNDING_UPGRADE_RUN_ID: input.inputDigest,
	...extra,
});

async function runPhase(ctx, input, phase, { network = "arbitrum", env = {} } = {}) {
	await ctx.runProcess(
		"./node_modules/.bin/hardhat",
		["internal:arbitrum-rounding-upgrade", "--phase", phase, "--input", input.input, "--output", input.output, "--network", network],
		{ env: environment(input, env) },
	);
	return readReport(input);
}

export function createArbitrumRoundingUpgradeTask(common) {
	return common({
		id: "maintenance.arbitrum-rounding-upgrade-862",
		version: 3,
		category: "maintenance",
		risk: "transaction",
		title: "Arbitrum rounding fix v0.8.6.2",
		description:
			"Deploy a temporary factory owned by your deployment wallet, four libraries and four facets ending in 862; export the rehearsed Core cut to the Safe.",
		supportedNetworks: ["arbitrum"],
		inputs: [
			{ id: "network", label: "Network", type: "network", required: true },
			{ id: "config", label: "Stage recipe", type: "recipe", required: true },
			...["input", "output", "inputDigest", "sourceCommit"].map(id => ({ id, label: id, type: "string", required: true })),
			{ id: "governanceSigner", label: "Core owner Safe", type: "selection", required: true },
		],
		artifacts: [
			"tag-bound input and report",
			"fork rehearsal",
			"deployment checkpoint and receipts",
			"Safe Transaction Builder JSON",
			"Arbiscan publication and selector verification",
		],
		resumePolicy: { strategy: "stable-step-id", sourceDrift: "refuse", inputDrift: "refuse" },
		signerPolicy: () => ({
			role: "Contract deployment signer and temporary factory admin",
			allowedModes: EOA_SIGNER_MODES.filter(mode => mode !== SIGNER_MODES.LOCAL_NODE),
			initialMode: SIGNER_MODES.KEYSTORE,
		}),
		prepare: async ({ ui, root = PROJECT_ROOT }) => {
			const standardInput = buildRoundingInput(root);
			const inputDigest = digest(standardInput);
			const directory = path.join(root, "tasks", "data", "42161", "rounding-upgrades", inputDigest);
			const input = path.join(directory, "input.json");
			const output = path.join(directory, "report.json");
			const governanceSigner = await selectSigner(ui, {
				role: "Core owner Safe",
				allowedModes: [SIGNER_MODES.SAFE_FILE],
				initialMode: SIGNER_MODES.SAFE_FILE,
				network: "arbitrum",
				chainId: 42161,
				safeAddress: standardInput.target.safe,
			});
			if (!governanceSigner) return null;
			atomicWrite(input, standardInput);
			ui.note(
				[
					`Release: ${RELEASE_TAG}`,
					`Source: ${standardInput.sourceCommit}`,
					`Core: ${standardInput.target.core}`,
					"Temporary CREATE2 factory: new; selected deployment wallet receives DEFAULT_ADMIN_ROLE and DEPLOYER_ROLE",
					`Libraries: ${LIBRARIES.join(", ")}`,
					`Facets (suffix 862): ${FACETS.join(", ")}`,
					`Output: ${path.relative(root, output)}`,
				].join("\n"),
				"Rounding-only upgrade",
			);
			return {
				network: "arbitrum",
				chainId: 42161,
				mode: "live",
				config: path.join(root, RECIPE_PATH),
				input,
				output,
				inputDigest,
				sourceCommit: standardInput.sourceCommit,
				governanceSigner,
			};
		},
		plan: () => ROUNDING_PLAN.map(step => ({ ...step })),
		run: async (ctx, input) => {
			const standard = JSON.parse(fs.readFileSync(input.input, "utf8"));
			if (digest(standard) !== input.inputDigest || input.sourceCommit !== standard.sourceCommit)
				throw new Error("Rounding task input changed");
			assertReleaseSource(ctx.root, standard);
			const governance = validateSignerSelection(input.governanceSigner);
			if (governance.mode !== SIGNER_MODES.SAFE_FILE || governance.safeAddress.toLowerCase() !== standard.target.safe.toLowerCase())
				throw new Error("Use the reviewed Core owner Safe export");
			const step = (id, fn) => {
				const entry = ROUNDING_PLAN.find(s => s.id === id);
				return ctx.step(id, entry.title, fn, { phase: entry.phase });
			};
			await step("compile", () => ctx.runProcess("npm", ["run", "compile"], { env: environment(input) }));
			await step("inspect", () => runPhase(ctx, input, "inspect"));
			await step("rehearse", () =>
				runPhase(ctx, input, "rehearse", {
					network: "fork-arbitrum",
					env: { FORK_BLOCK_NUMBER: String(readReport(input).inspection.blockNumber) },
				}),
			);
			await step("authorize", async () => {
				const confirmed = await ctx.ui.text({
					message: `Type DEPLOY ${RELEASE_TAG} ON 42161 to authorize a temporary factory (your wallet is admin and deployer), four libraries and four facets`,
					validate: value => (value === `DEPLOY ${RELEASE_TAG} ON 42161` ? undefined : "Type the displayed release and chain phrase"),
				});
				if (confirmed === null) ctx.requestPause();
			});
			for (const phase of ["deploy", "publish"])
				await step(phase, () => runPhase(ctx, input, phase, { env: { SYMMIO_ROUNDING_UPGRADE_EXECUTE: "true", CONFIRM_CHAIN_ID: "42161" } }));
			await step("core-cut", async () => {
				const report = await runPhase(ctx, input, "plan");
				if (!report.actions.length) return;
				const delivery = await dispatchSafeActions(ctx, input.governanceSigner, report.actions, {
					chainId: 42161,
					network: "arbitrum",
					name: `${RELEASE_TAG} Core rounding fix`,
					description: "Replace the four rounding-release facets and add the starting-position-count getter.",
					stateKey: "rounding-core-cut",
					processEnv: environment(input),
				});
				report.safeDelivery = delivery;
				atomicWrite(input.output, report);
				ctx.wait(`Import ${delivery.builderPath} in Safe Transaction Builder, execute the Core cut, then choose Continue active task.`);
			});
			await step("verify", () => runPhase(ctx, input, "verify"));
		},
		reconcile: async (ctx, input) => {
			if (!ctx.state.transactions.some(t => ["submitted", "unresolved", "timed_out"].includes(t.status))) return { unresolved: [] };
			const report = await runPhase(ctx, input, "reconcile", { env: { SYMMIO_RECIPE_READ_ONLY: "true" } });
			for (const transaction of ctx.state.transactions) {
				const updated = report.transactions?.find(t => t.hash.toLowerCase() === transaction.hash.toLowerCase());
				if (updated) Object.assign(transaction, updated);
			}
			return { unresolved: ctx.state.transactions.filter(t => ["submitted", "unresolved", "timed_out"].includes(t.status)).map(t => t.hash) };
		},
	});
}
