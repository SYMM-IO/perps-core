import {
	assertReleaseSource,
	buildRoundingInput,
	digest,
	FACETS,
	LIBRARIES,
	RELEASE_TAG,
	roundingProfile,
	roundingOwner,
} from "../../deployment-tooling/arbitrum-rounding-upgrade.js";
import { PROJECT_ROOT } from "../lib/paths.js";
import { loadRecipeContext, recipeHardhatEnvironment } from "../lib/recipe-context.js";
import { EOA_SIGNER_MODES, SIGNER_MODES, dispatchSafeActions, selectSigner, signerEnvironment, validateSignerSelection } from "../signer/index.js";
import { atomicWrite } from "./guided-recipe.js";
import fs from "node:fs";
import path from "node:path";

export const ROUNDING_PLAN = Object.freeze([
	{ id: "compile", phase: "prepare", title: "Compile the tagged rounding-only release" },
	{ id: "inspect", phase: "prepare", title: "Verify the Core baseline, Safe owner and reused libraries" },
	{ id: "authorize", phase: "authorization", title: "Authorize nine contract deployments on Arbitrum" },
	{ id: "deploy", phase: "deployment", title: "Deploy a temporary factory, four libraries and four facets ending in 862" },
	{ id: "publish", phase: "publication", title: "Publish the nine new contracts on Arbiscan" },
	{ id: "core-cut", phase: "execution", title: "Export the Core cut for execution through the Safe" },
	{ id: "verify", phase: "verification", title: "Verify all Core selectors and the new getter" },
	{ id: "core-unpause", phase: "execution", title: "Export a separate Core global-unpause transaction for the Safe" },
	{ id: "verify-unpause", phase: "verification", title: "Verify the Core global pause flag is cleared" },
]);
export const PRODUCTION_ROUNDING_PLAN = Object.freeze([
	...ROUNDING_PLAN.slice(0, 5).map(step => ({
		...step,
		title:
			step.id === "inspect"
				? "Verify the production baseline, Ledger owner and reused libraries"
				: step.id === "authorize"
					? "Authorize nine deployments and the Ledger pause, cut and unpause"
					: step.title,
	})),
	{ id: "core-pause", phase: "execution", title: "Pause production Core using the owner Ledger" },
	{ id: "verify-pause", phase: "verification", title: "Verify Core is globally paused before the production cut" },
	...ROUNDING_PLAN.slice(5).map(step => ({
		...step,
		title:
			step.id === "core-cut"
				? "Execute the paused Core cut using the owner Ledger"
				: step.id === "core-unpause"
					? "Unpause verified production Core using the owner Ledger"
					: step.title,
	})),
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

async function runPhase(ctx, input, phase, { env = {} } = {}) {
	await ctx.runProcess(
		"./node_modules/.bin/hardhat",
		["internal:arbitrum-rounding-upgrade", "--phase", phase, "--input", input.input, "--output", input.output, "--network", "arbitrum"],
		{ env: environment(input, env) },
	);
	return readReport(input);
}

const governanceSigner = (ctx, input) => ctx.getSigner?.("governance") || ctx.state?.signing?.governance || input.governanceSigner;

export async function runLedgerPhase(ctx, input, phase) {
	const selection = validateSignerSelection(governanceSigner(ctx, input), { allowSafe: false });
	if (selection.mode !== SIGNER_MODES.LEDGER) throw new Error("Production governance requires Ledger signing");
	return runPhase(ctx, input, phase, {
		env: {
			...signerEnvironment(selection),
			SYMMIO_ROUNDING_UPGRADE_EXECUTE: "true",
			CONFIRM_CHAIN_ID: "42161",
		},
	});
}

export async function bindProductionLedger(ctx, standard) {
	const owner = roundingOwner(standard);
	const existing = ctx.getSigner?.("governance");
	if (existing) {
		const selection = validateSignerSelection(existing, { allowSafe: false });
		if (selection.mode !== SIGNER_MODES.LEDGER || selection.address.toLowerCase() !== owner.toLowerCase())
			throw new Error("Use the reviewed Core owner Ledger");
		return selection;
	}
	const next = await ctx.ui.select({
		message: "Deployment and explorer verification are complete. Continue with the Core owner Ledger?",
		options: [
			{ value: "later", label: "Wait for admin", hint: "Save progress and continue this task when the Ledger is available" },
			{ value: "ledger", label: "Connect Ledger and continue", hint: "The admin will pause Core, execute the cut and unpause" },
		],
		initialValue: "later",
	});
	const waitForAdmin = () =>
		ctx.wait(`Ledger owner ${owner} is required to pause Core. Connect it when the admin is available, then choose Continue active task.`);
	if (next !== "ledger") return waitForAdmin();
	const selection = await selectSigner(ctx.ui, {
		role: "Core owner Ledger",
		allowedModes: [SIGNER_MODES.LEDGER],
		initialMode: SIGNER_MODES.LEDGER,
		network: "arbitrum",
		chainId: 42161,
		expectedAddress: owner,
	});
	if (!selection) return waitForAdmin();
	return ctx.bindSigner("governance", selection);
}

export function createArbitrumRoundingUpgradeTask(common, profile = "stage") {
	const { recipePath } = roundingProfile(profile);
	const production = profile === "production";
	const plan = production ? PRODUCTION_ROUNDING_PLAN : ROUNDING_PLAN;
	return common({
		id: production ? "maintenance.arbitrum-vibe-production-rounding-upgrade-862" : "maintenance.arbitrum-rounding-upgrade-862",
		version: production ? 1 : 5,
		category: "maintenance",
		risk: "transaction",
		title: production ? "Arbitrum Vibe production / Ledger rounding fix v0.8.6.2" : "Arbitrum Vibe stage / Safe rounding fix v0.8.6.2",
		description: production
			? "Deploy the rounding fix to Vibe production; pause with the owner Ledger, verify and execute the cut, then unpause with the Ledger."
			: "Deploy a temporary factory owned by your deployment wallet, four libraries and four facets ending in 862; export separate Core cut and global-unpause files to the Safe.",
		supportedNetworks: ["arbitrum"],
		inputs: [
			{ id: "network", label: "Network", type: "network", required: true },
			{ id: "config", label: production ? "Production recipe" : "Stage recipe", type: "recipe", required: true },
			...["input", "output", "inputDigest", "sourceCommit"].map(id => ({ id, label: id, type: "string", required: true })),
			{
				id: "governanceSigner",
				label: production ? "Core owner Ledger (requested after publication)" : "Core owner Safe",
				type: "selection",
				required: !production,
			},
		],
		artifacts: [
			"tag-bound input and report",
			"deployment checkpoint and receipts",
			production
				? "Separate Ledger governance checkpoint, transaction previews and pause/cut/unpause receipts"
				: "Separate Safe Transaction Builder JSON files for the Core cut and global unpause",
			"Arbiscan publication and selector verification",
		],
		resumePolicy: { strategy: "stable-step-id", sourceDrift: "refuse", inputDrift: "refuse" },
		signerPolicy: () => ({
			role: "Contract deployment signer and temporary factory admin",
			allowedModes: EOA_SIGNER_MODES.filter(mode => mode !== SIGNER_MODES.LOCAL_NODE),
			initialMode: SIGNER_MODES.KEYSTORE,
		}),
		prepare: async ({ ui, root = PROJECT_ROOT }) => {
			const standardInput = buildRoundingInput(root, profile);
			const inputDigest = digest(standardInput);
			const directory = path.join(root, "tasks", "data", "42161", "rounding-upgrades", inputDigest);
			const input = path.join(directory, "input.json");
			const output = path.join(directory, "report.json");
			const governanceSigner = production
				? undefined
				: await selectSigner(ui, {
						role: "Core owner Safe",
						allowedModes: [SIGNER_MODES.SAFE_FILE],
						initialMode: SIGNER_MODES.SAFE_FILE,
						network: "arbitrum",
						chainId: 42161,
						safeAddress: roundingOwner(standardInput),
					});
			if (!production && !governanceSigner) return null;
			atomicWrite(input, standardInput);
			ui.note(
				[
					`Release: ${RELEASE_TAG}`,
					`Solidity release: ${standardInput.releaseCommit}`,
					`Deployment scripts: ${standardInput.sourceCommit}`,
					`Core: ${standardInput.target.core}`,
					...(production
						? ["Ledger is requested after nine deployments and publication: pause, verify pause, diamondCut, verify upgrade, unpause"]
						: []),
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
				config: path.join(root, recipePath),
				input,
				output,
				inputDigest,
				sourceCommit: standardInput.sourceCommit,
				...(governanceSigner ? { governanceSigner } : {}),
			};
		},
		plan: () => plan.map(step => ({ ...step })),
		run: async (ctx, input) => {
			const standard = JSON.parse(fs.readFileSync(input.input, "utf8"));
			if ((standard.profile || "stage") !== profile || path.resolve(input.config) !== path.join(ctx.root, recipePath))
				throw new Error("Rounding task profile or recipe path changed");
			if (digest(standard) !== input.inputDigest || input.sourceCommit !== standard.sourceCommit)
				throw new Error("Rounding task input changed");
			assertReleaseSource(ctx.root, standard);
			if (!production) {
				const governance = validateSignerSelection(input.governanceSigner);
				if (governance.mode !== SIGNER_MODES.SAFE_FILE || governance.safeAddress.toLowerCase() !== roundingOwner(standard).toLowerCase())
					throw new Error("Use the reviewed Core owner Safe export");
			}
			const step = (id, fn) => {
				const entry = plan.find(s => s.id === id);
				return ctx.step(id, entry.title, fn, { phase: entry.phase });
			};
			await step("compile", () => ctx.runProcess("npm", ["run", "compile"], { env: environment(input) }));
			await step("inspect", () => runPhase(ctx, input, "inspect"));
			await step("authorize", async () => {
				const phrase = `${production ? "UPGRADE VIBE PRODUCTION" : "DEPLOY"} ${RELEASE_TAG} ON 42161`;
				const confirmed = await ctx.ui.text({
					message: `Type ${phrase} to authorize a temporary factory (your deployment wallet is admin and deployer), four libraries and four facets${production ? "; then Ledger pause, verified diamond cut and unpause" : ""}`,
					validate: value => (value === phrase ? undefined : "Type the displayed release and chain phrase"),
				});
				if (confirmed === null) ctx.requestPause();
			});
			for (const phase of ["deploy", "publish"])
				await step(phase, () => runPhase(ctx, input, phase, { env: { SYMMIO_ROUNDING_UPGRADE_EXECUTE: "true", CONFIRM_CHAIN_ID: "42161" } }));
			if (production) {
				await step("core-pause", async () => {
					await bindProductionLedger(ctx, standard);
					await runLedgerPhase(ctx, input, "execute-pause");
				});
				await step("verify-pause", () => runPhase(ctx, input, "verify-pause"));
			}
			await step("core-cut", async () => {
				if (production) return runLedgerPhase(ctx, input, "execute-cut");
				const report = await runPhase(ctx, input, "plan");
				if (!report.actions.length) return;
				const delivery = await dispatchSafeActions(ctx, input.governanceSigner, report.actions, {
					root: ctx.root,
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
			await step("core-unpause", async () => {
				if (production) return runLedgerPhase(ctx, input, "execute-unpause");
				const report = await runPhase(ctx, input, "plan-unpause");
				if (!report.unpause.actions.length) {
					ctx.ui.note("Core is already globally unpaused; no unpause transaction is needed.");
					return;
				}
				const delivery = await dispatchSafeActions(ctx, input.governanceSigner, report.unpause.actions, {
					root: ctx.root,
					chainId: 42161,
					network: "arbitrum",
					name: `${RELEASE_TAG} Core global unpause`,
					description: "Clear the Core global pause flag after verifying the rounding upgrade. Other pause flags are unchanged.",
					stateKey: "rounding-core-unpause",
					processEnv: environment(input),
				});
				report.unpauseDelivery = delivery;
				atomicWrite(input.output, report);
				ctx.wait(`Import ${delivery.builderPath} in Safe Transaction Builder, execute unpauseGlobal(), then choose Continue active task.`);
			});
			await step("verify-unpause", () => runPhase(ctx, input, "verify-unpause"));
		},
		reconcile: async (ctx, input) => {
			if (!ctx.state.transactions.some(t => ["submitted", "unresolved", "timed_out"].includes(t.status))) return { unresolved: [] };
			let report = await runPhase(ctx, input, "reconcile", { env: { SYMMIO_RECIPE_READ_ONLY: "true" } });
			const governance = governanceSigner(ctx, input);
			if (
				production &&
				governance &&
				ctx.state.transactions.some(
					t => t.from?.toLowerCase() === governance.address.toLowerCase() && ["submitted", "unresolved", "timed_out"].includes(t.status),
				)
			)
				report = await runLedgerPhase(ctx, input, "reconcile-governance");
			for (const transaction of ctx.state.transactions) {
				const updated = [...(report.transactions || []), ...(report.governanceTransactions || [])].find(
					t => t.hash.toLowerCase() === transaction.hash.toLowerCase(),
				);
				if (updated) Object.assign(transaction, updated);
			}
			return { unresolved: ctx.state.transactions.filter(t => ["submitted", "unresolved", "timed_out"].includes(t.status)).map(t => t.hash) };
		},
	});
}
