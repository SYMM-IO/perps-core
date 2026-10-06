import {
	assertReleaseSource,
	buildRoundingInput,
	digest,
	roundingLibraries,
	roundingSuffix,
	roundingFacets,
	roundingProfile,
	roundingOwner,
	roundingDeployments,
	validateRoundingSourceMigration,
} from "../../deployment-tooling/arbitrum-rounding-upgrade.js";
import { PROJECT_ROOT } from "../lib/paths.js";
import { loadRecipeContext, recipeHardhatEnvironment } from "../lib/recipe-context.js";
import { EOA_SIGNER_MODES, SIGNER_MODES, dispatchSafeActions, selectSigner, signerEnvironment, validateSignerSelection } from "../signer/index.js";
import { atomicWrite } from "./guided-recipe.js";
import { execFileSync } from "node:child_process";
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
export const PREVIOUS_PRODUCTION_ROUNDING_PLAN = Object.freeze([
	...ROUNDING_PLAN.slice(0, 5).map(step => ({
		...step,
		title: {
			compile: "Compile the tagged rounding and funding release",
			inspect: "Verify the production baseline, Ledger owner and reused libraries",
			authorize: "Authorize ten deployments and the Ledger pause, cut and unpause",
			deploy: "Deploy a temporary factory, four libraries and five facets ending in 862",
			publish: "Publish the ten new contracts on Arbiscan",
		}[step.id],
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
export const PRODUCTION_ROUNDING_PLAN = Object.freeze([
	...PREVIOUS_PRODUCTION_ROUNDING_PLAN.slice(0, 5).map(step => ({
		...step,
		title: step.id === "authorize" ? "Authorize ten deployments and the Ledger diamond cut" : step.title,
	})),
	{ id: "core-cut", phase: "execution", title: "Execute the Core cut using the owner Ledger" },
	{ id: "verify", phase: "verification", title: "Verify all Core selectors, runtime bytecode and publication" },
]);
export const STAGE_FUNDING_PLAN = Object.freeze([
	{ id: "compile", phase: "prepare", title: "Compile the tagged funding release" },
	{ id: "inspect", phase: "prepare", title: "Verify the installed stage rounding baseline, Safe owner and funding library" },
	{ id: "authorize", phase: "authorization", title: "Authorize two deployments and the Safe role, pause, cut and unpause workflow" },
	{ id: "deploy", phase: "deployment", title: "Deploy a temporary factory and FundingRateFacet ending in 863" },
	{ id: "publish", phase: "publication", title: "Publish both new contracts on Arbiscan" },
	{ id: "core-roles", phase: "execution", title: "Export missing Core pause role grants for the Safe" },
	{ id: "verify-roles", phase: "verification", title: "Verify the Safe holds both pause roles" },
	{ id: "core-pause", phase: "execution", title: "Export the Core global-pause transaction for the Safe" },
	{ id: "verify-pause", phase: "verification", title: "Verify Core is globally paused before exporting the funding cut" },
	{ id: "core-cut", phase: "execution", title: "Export the funding-only Core cut for the Safe" },
	{ id: "verify", phase: "verification", title: "Verify the funding replacement and preserved selectors while Core stays paused" },
	{ id: "core-unpause", phase: "execution", title: "Export a separate Core global-unpause transaction for the Safe" },
	{ id: "verify-unpause", phase: "verification", title: "Verify the Core global pause flag is cleared" },
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
	const migration = productionSourceMigration(ctx, input);
	await ctx.runProcess(
		"./node_modules/.bin/hardhat",
		["internal:arbitrum-rounding-upgrade", "--phase", phase, "--input", input.input, "--output", input.output, "--network", "arbitrum"],
		{ env: environment(input, { ...env, SYMMIO_ROUNDING_SOURCE_MIGRATION: migration ? JSON.stringify(migration) : "" }) },
	);
	return readReport(input);
}

export function productionSourceMigration(ctx, input) {
	if (!ctx.state?.sourceMigrations?.length) return undefined;
	const standard = JSON.parse(fs.readFileSync(input.input, "utf8"));
	const migration = {
		taskId: ctx.state.taskId,
		taskRunId: ctx.state.runId,
		inputDigest: input.inputDigest,
		originalCommit: input.sourceCommit,
		currentCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ctx.root, encoding: "utf8" }).trim(),
		sourceHash: ctx.state.sourceHash,
		migrations: ctx.state.sourceMigrations,
	};
	return validateRoundingSourceMigration(ctx.root, standard, migration);
}

export function migrateProductionCutPlan(ctx, input, migration) {
	if (JSON.stringify(ctx.state.plan) === JSON.stringify(PRODUCTION_ROUNDING_PLAN)) return;
	if (!migration || JSON.stringify(ctx.state.plan) !== JSON.stringify(PREVIOUS_PRODUCTION_ROUNDING_PLAN))
		throw new Error("Production plan differs from the supported pause-to-cut migration");
	const report = readReport(input);
	if (
		JSON.stringify(ctx.state.completedSteps) !== JSON.stringify(["compile", "inspect", "authorize", "deploy", "publish"]) ||
		ctx.state.transactions.length !== 10 ||
		ctx.state.transactions.some(tx => tx.status !== "confirmed") ||
		report.governanceTransactions?.length ||
		report.pause ||
		report.unpause ||
		report.verifiedBlock ||
		roundingDeployments("production").some(name => !report.deployments?.[name]?.published)
	)
		throw new Error("Production plan migration requires ten published deployments and no started governance actions");
	ctx.migratePlan(
		PRODUCTION_ROUNDING_PLAN.map(step => ({ ...step })),
		"Remove production pause and unpause; preserve deployments and execute only the verified Ledger cut",
	);
	ctx.ui.note("Production resume now performs only the Ledger diamond cut and verification. The ten deployments and their evidence are preserved.");
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
			{ value: "ledger", label: "Connect Ledger and continue", hint: "The admin will execute the Core cut, followed by verification" },
		],
		initialValue: "later",
	});
	const waitForAdmin = () =>
		ctx.wait(`Ledger owner ${owner} is required for the Core cut. Connect it when the admin is available, then choose Continue active task.`);
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
	const { recipePath, releaseTag } = roundingProfile(profile);
	const production = profile === "production";
	const funding = profile === "stage-funding";
	const facets = roundingFacets(profile);
	const suffix = roundingSuffix(profile);
	const plan = funding ? STAGE_FUNDING_PLAN : production ? PRODUCTION_ROUNDING_PLAN : ROUNDING_PLAN;
	return common({
		id: funding
			? "maintenance.arbitrum-vibe-stage-funding-upgrade-863"
			: production
				? "maintenance.arbitrum-vibe-production-rounding-upgrade-862"
				: "maintenance.arbitrum-rounding-upgrade-862",
		version: funding ? 2 : production ? 3 : 5,
		category: "maintenance",
		risk: "transaction",
		title: funding
			? "Arbitrum Vibe stage / Safe funding upgrade (863)"
			: production
				? "Arbitrum Vibe production / Ledger rounding + funding v0.8.6.2"
				: "Arbitrum Vibe stage / Safe rounding fix v0.8.6.2",
		description: funding
			? "Deploy and verify a temporary factory and funding facet ending in 863; export separate Safe files for missing roles, pause, funding cut and unpause."
			: production
				? "Deploy and publish ten contracts for the rounding and bound-solver funding fixes; execute the owner Ledger cut and verify the upgrade."
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
				? "Separate Ledger governance checkpoint, diamond-cut preview and receipt"
				: "Separate Safe Transaction Builder JSON files for the Core cut and global unpause",
			"Arbiscan publication and selector verification",
		],
		resumePolicy: { strategy: "stable-step-id", sourceDrift: production ? "confirm" : "refuse", inputDrift: "refuse" },
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
					`Release: ${releaseTag}`,
					`Solidity release: ${standardInput.releaseCommit}`,
					`Deployment scripts: ${standardInput.sourceCommit}`,
					`Core: ${standardInput.target.core}`,
					...(production
						? [
								"Ledger is requested after ten deployments and publication: diamondCut, then verify the upgrade; pause flags are preserved",
							]
						: []),
					"Temporary CREATE2 factory: new; selected deployment wallet receives DEFAULT_ADMIN_ROLE and DEPLOYER_ROLE",
					`New libraries: ${roundingLibraries(profile).join(", ") || "None; reuse the reviewed LibQuoteFunding"}`,
					`Facets (suffix ${suffix}): ${facets.join(", ")}`,
					...(funding ? ["Two deployments; Safe role grants, pause, verified funding-only cut, then unpause"] : []),
					`Output: ${path.relative(root, output)}`,
				].join("\n"),
				funding ? "Stage funding-only upgrade" : production ? "Production rounding and funding upgrade" : "Rounding-only upgrade",
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
			const migration = productionSourceMigration(ctx, input);
			assertReleaseSource(ctx.root, standard, profile, migration);
			if (production) migrateProductionCutPlan(ctx, input, migration);
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
				const phrase = funding
					? "UPGRADE VIBE STAGE FUNDING 863 ON 42161"
					: `${production ? "UPGRADE VIBE PRODUCTION" : "DEPLOY"} ${releaseTag} ON 42161`;
				const confirmed = await ctx.ui.text({
					message: funding
						? `Type ${phrase} to authorize a temporary factory (your deployment wallet is admin and deployer) and FundingRateFacet; then Safe role grants, pause, verified cut and unpause`
						: `Type ${phrase} to authorize a temporary factory (your deployment wallet is admin and deployer), four libraries and ${production ? "five" : "four"} facets${production ? "; then Ledger diamond cut and verification" : ""}`,
					validate: value => (value === phrase ? undefined : "Type the displayed release and chain phrase"),
				});
				if (confirmed === null) ctx.requestPause();
			});
			for (const phase of ["deploy", "publish"])
				await step(phase, () => runPhase(ctx, input, phase, { env: { SYMMIO_ROUNDING_UPGRADE_EXECUTE: "true", CONFIRM_CHAIN_ID: "42161" } }));
			if (funding) {
				for (const [id, phase, key, title, description] of [
					[
						"core-roles",
						"plan-roles",
						"roles",
						"Stage Core pause roles",
						"Grant missing PAUSER_ROLE and UNPAUSER_ROLE to the Core owner Safe.",
					],
					["core-pause", "plan-pause", "pause", "Stage Core global pause", "Pause Core globally before the stage funding cut."],
				]) {
					await step(id, async () => {
						const report = await runPhase(ctx, input, phase);
						if (!report[key].actions.length) return;
						const delivery = await dispatchSafeActions(ctx, input.governanceSigner, report[key].actions, {
							root: ctx.root,
							chainId: 42161,
							network: "arbitrum",
							name: title,
							description,
							stateKey: `funding-${id}`,
							processEnv: environment(input),
						});
						report[`${key}Delivery`] = delivery;
						atomicWrite(input.output, report);
						ctx.wait(`Import ${delivery.builderPath} in Safe Transaction Builder, execute ${title}, then choose Continue active task.`);
					});
					await step(`verify-${key}`, () => runPhase(ctx, input, `verify-${key}`));
				}
			}
			await step("core-cut", async () => {
				if (production) {
					await bindProductionLedger(ctx, standard);
					return runLedgerPhase(ctx, input, "execute-cut");
				}
				const report = await runPhase(ctx, input, "plan");
				if (!report.actions.length) return;
				const delivery = await dispatchSafeActions(ctx, input.governanceSigner, report.actions, {
					root: ctx.root,
					chainId: 42161,
					network: "arbitrum",
					name: funding ? "Stage Core funding upgrade (863)" : `${releaseTag} Core rounding fix`,
					description: funding
						? "Replace the seven FundingRateFacet selectors; preserve the installed rounding facets, with no added selectors or initializer."
						: "Replace the four rounding-release facets and add the starting-position-count getter.",
					stateKey: "rounding-core-cut",
					processEnv: environment(input),
				});
				report.safeDelivery = delivery;
				atomicWrite(input.output, report);
				ctx.wait(`Import ${delivery.builderPath} in Safe Transaction Builder, execute the Core cut, then choose Continue active task.`);
			});
			await step("verify", () => runPhase(ctx, input, "verify"));
			if (production) return;
			await step("core-unpause", async () => {
				const report = await runPhase(ctx, input, "plan-unpause");
				if (!report.unpause.actions.length) {
					ctx.ui.note("Core is already globally unpaused; no unpause transaction is needed.");
					return;
				}
				const delivery = await dispatchSafeActions(ctx, input.governanceSigner, report.unpause.actions, {
					root: ctx.root,
					chainId: 42161,
					network: "arbitrum",
					name: `${releaseTag} Core global unpause`,
					description: "Clear the Core global pause flag after verifying the upgrade. Other pause flags are unchanged.",
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
