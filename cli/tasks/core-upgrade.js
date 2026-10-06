import { digest } from "../../deployment-tooling/arbitrum-core-upgrade.js";
import { validateCoreUpgradeInput, coreUpgradeRecipe } from "../../deployment-tooling/core-upgrade-input.js";
import { loadRecipeContext } from "../lib/recipe-context.js";
import {
	createArbitrumCoreUpgradeTask,
	CORE_UPGRADE_PLAN,
	runCoreUpgradePhase,
	rehearseCoreUpgrade,
	validateCoreTaskInput,
	coreUpgradeEnvironment,
} from "./arbitrum-core-upgrade.js";
import { atomicWrite } from "./guided-recipe.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export async function prepareStandardCoreUpgrade({ root, ui }) {
	const files = fs.readdirSync(path.join(root, "tasks/config")).filter(file => /^core-upgrade\.[a-z0-9-]+\.input\.json$/.test(file));
	const choice = await ui.select({
		message: "Core upgrade input file",
		options: [
			...files.map(file => ({ value: path.join("tasks/config", file), label: file })),
			{ value: "custom", label: "Choose another input file" },
		],
	});
	if (choice === null) return null;
	const requested = choice === "custom" ? await ui.text({ message: "Path to core-upgrade.<deployment>.input.json" }) : choice;
	if (!requested) return null;
	const inputSource = path.resolve(root, requested);
	if (!/^core-upgrade\.[a-z0-9-]+\.input\.json$/.test(path.basename(inputSource)))
		throw new Error("Use core-upgrade.<deployment>.input.json naming");
	const config = validateCoreUpgradeInput(JSON.parse(fs.readFileSync(inputSource, "utf8")));
	const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	if (git(["status", "--porcelain", "--untracked-files=no"])) throw new Error("Commit tracked edits before binding this upgrade");
	const sourceCommit = git(["rev-parse", "HEAD"]);
	const releaseCommit = git(["rev-parse", "--verify", "--end-of-options", `${config.release.ref}^{commit}`]);
	const baselineCommit = git(["rev-parse", "--verify", "--end-of-options", `${config.release.baselineRef}^{commit}`]);
	const contractsTree = git(["rev-parse", `${releaseCommit}:contracts`]);
	if (git(["rev-parse", "HEAD:contracts"]) !== contractsTree) throw new Error("Current Solidity differs from the input's target release");
	const directory = path.join(root, "tasks/data", String(config.network.chainId), "core-upgrades", randomUUID());
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const credentialRecipe = path.join(directory, "credential-recipe.json"),
		forkConfig = path.join(directory, "fork-recipe.json");
	atomicWrite(credentialRecipe, coreUpgradeRecipe(config));
	atomicWrite(forkConfig, coreUpgradeRecipe(config, true));
	const standard = {
		apiVersion: "operations.symm.io/core-upgrade-run-v1",
		sourceCommit,
		config,
		inputSource,
		userInputDigest: digest(config),
		releaseCommit,
		baselineCommit,
		contractsTree,
		recipeDigest: loadRecipeContext(credentialRecipe, { plan: false }).digest,
		forkRecipeDigest: loadRecipeContext(forkConfig, { plan: false }).digest,
		runNonce: path.basename(directory),
	};
	const input = path.join(directory, "input.json"),
		output = path.join(directory, "report.json"),
		inputDigest = digest(standard);
	atomicWrite(input, standard);
	atomicWrite(output, { inputDigest, transactions: [] });
	ui.note(
		`Network: ${config.network.name} (${config.network.chainId})\nCore: ${config.target.core}\nOwner: ${config.governance.owner} (${config.governance.kind})\nBaseline: ${config.release.baselineRef} (${baselineCommit})\nRelease: ${config.release.ref} (${releaseCommit})\nInput: ${inputSource}\nReport: ${output}\nFork rehearsal is a separate optional action. Explorer publication runs after service restoration.`,
		"Core upgrade input",
	);
	const key = config.credentials.deployer.split("://")[1];
	return {
		network: config.network.name,
		chainId: config.network.chainId,
		mode: "live",
		config: credentialRecipe,
		forkConfig,
		input,
		output,
		inputDigest,
		sourceCommit,
		signer: { mode: "hardhat-keystore", key },
	};
}

export function createCoreUpgradeTask(common) {
	return createArbitrumCoreUpgradeTask(common, {
		id: "maintenance.core-upgrade",
		title: "Upgrade Core from a standard input file",
		supportedNetworks: ["any"],
		description:
			"Load a reviewed Core input, deploy the manifest, execute through its EOA or Safe owner, verify and restore service, then publish on the explorer.",
		prepare: prepareStandardCoreUpgrade,
		upgradePlan: CORE_UPGRADE_PLAN.map(step => ({
			...step,
			title:
				{
					pause: "Execute or export the maintenance pause and verify its receipt",
					"rehearse-cut": "Rehearse the exact deployed governance payload on the paused fork",
					cut: "Execute or export the complete Core upgrade and verify every action",
					"plan-cut": "Bind the paused state and complete Core governance plan",
				}[step.id] || step.title,
		})),
		artifacts: [
			"source-bound input and report",
			"initial and paused snapshots",
			"deployment and governance journals",
			"core-abi.json",
			"optional separate fork rehearsal",
			"reviewed governance payloads and canonical execution receipts",
			"muon-readiness-request.json and pinned routed simulations",
		],
	});
}

export function createCoreUpgradeRehearsalTask(common) {
	const steps = [
		{ id: "compile", phase: "prepare", title: "Compile the reviewed release" },
		{ id: "inspect", phase: "prepare", title: "Inspect the deployment at one block" },
		{ id: "rehearse-initial", phase: "rehearsal", title: "Rehearse deployment, upgrade and restoration on the fork" },
	];
	return common({
		id: "maintenance.core-upgrade-rehearse",
		version: 1,
		category: "maintenance",
		risk: "local-write",
		title: "Rehearse a Core upgrade on fork (optional)",
		description:
			"Run the complete reviewed upgrade on a pinned fork without broadcasting live transactions. This creates independent rehearsal evidence.",
		inputs: [{ id: "input", label: "Upgrade input", type: "string", required: true }],
		artifacts: ["source-bound input and report", "pinned snapshot", "complete fork rehearsal"],
		prepare: prepareStandardCoreUpgrade,
		plan: () => steps.map(step => ({ ...step })),
		validateResume: validateCoreTaskInput,
		reconcile: () => ({ unresolved: [] }),
		run: async (ctx, input) => {
			validateCoreTaskInput(ctx, input);
			await ctx.step("compile", steps[0].title, () =>
				ctx.runProcess("npm", ["run", "compile"], {
					env: coreUpgradeEnvironment(input, { SYMMIO_RECIPE_READ_ONLY: "true", SYMMIO_SIGNER_MODE: "safe-file" }),
				}),
			);
			await ctx.step("inspect", steps[1].title, () => runCoreUpgradePhase(ctx, input, "inspect"));
			await ctx.step("rehearse-initial", steps[2].title, () => rehearseCoreUpgrade(ctx, input));
			ctx.ui.note(`Fork rehearsal complete. Report: ${input.output}\nNo live upgrade was executed.`, "Rehearsal");
		},
	});
}
