import { digest } from "../../deployment-tooling/arbitrum-core-upgrade.js";
import { validateCoreUpgradeInput, coreUpgradeInputReview, coreUpgradeRecipe } from "../../deployment-tooling/core-upgrade-input.js";
import { prepareGitRelease, runGitReleasePhase, validateGitRelease } from "../lib/git-release.js";
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

export async function prepareStandardCoreUpgrade({ root, ui, askGitRelease = false }) {
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
	const sourceCommit = git(["rev-parse", "HEAD"]);
	const releaseCommit = git(["rev-parse", "--verify", "--end-of-options", `${config.release.ref}^{commit}`]);
	const baselineCommit = git(["rev-parse", "--verify", "--end-of-options", `${config.release.baselineRef}^{commit}`]);
	const contractsTree = git(["rev-parse", `${releaseCommit}:contracts`]);
	const releaseGit = askGitRelease ? await prepareGitRelease({ root, ui, contractsTree }) : false;
	if (releaseGit === null) return null;
	if (!releaseGit && git(["status", "--porcelain", "--untracked-files=no"])) throw new Error("Commit tracked edits before binding this upgrade");
	if (git(["rev-parse", `${releaseGit ? releaseGit.tree : "HEAD"}:contracts`]) !== contractsTree)
		throw new Error("Current Solidity differs from the input's target release");
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
		`${coreUpgradeInputReview(config)}\nCore baseline commit: ${baselineCommit}\nCore target release commit: ${releaseCommit}\nGit release: ${releaseGit ? `${releaseGit.tag} → ${releaseGit.remote}` : "skipped"}\nInput: ${inputSource}\nReport: ${output}\nFork rehearsal is a separate optional action. Explorer publication runs after service restoration.`,
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
		...(releaseGit ? { releaseGit, gitReport: path.join(directory, "git-release.json"), preparedRun: standard } : {}),
	};
}

export const CORE_GIT_RELEASE_PLAN = Object.freeze([
	{ id: "git-review", phase: "prepare", title: "Review and authorize the optional Git release" },
	{ id: "git-commit", phase: "publication", title: "Commit the reviewed staged tree or reuse the clean commit" },
	{ id: "git-tag", phase: "publication", title: "Create or reuse the selected upgrade Git tag" },
	{ id: "git-publish", phase: "publication", title: "Publish the selected Git tag and verify its remote commit" },
	{ id: "git-bind", phase: "prepare", title: "Bind the upgrade to the published release commit" },
]);

function gitBoundRun(input, report) {
	return {
		...input.preparedRun,
		sourceCommit: report.commit,
		upgradeGitTag: {
			tag: input.releaseGit.tag,
			remote: input.releaseGit.remote,
			remoteDigest: input.releaseGit.remoteDigest,
			commit: report.commit,
			tagObject: report.tagObject,
			publication: report.publication,
		},
	};
}

function validateGitInput(ctx, input) {
	if (!input.releaseGit) return null;
	if (digest(input.preparedRun) !== input.inputDigest || input.preparedRun.sourceCommit !== input.sourceCommit)
		throw new Error("Prepared Git release input changed");
	const standard = input.preparedRun;
	if (digest(JSON.parse(fs.readFileSync(standard.inputSource, "utf8"))) !== standard.userInputDigest)
		throw new Error("Original upgrade input changed");
	for (const [ref, commit] of [
		[standard.config.release.ref, standard.releaseCommit],
		[standard.config.release.baselineRef, standard.baselineCommit],
	]) {
		if (
			execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd: ctx.root, encoding: "utf8" }).trim() !==
			commit
		)
			throw new Error("Core upgrade release or baseline reference changed");
	}
	const report = validateGitRelease(ctx.root, input.releaseGit, input.gitReport);
	for (const [key, hash] of Object.entries(ctx.state.gitReleaseEvidence || {}))
		if (digest(report[key]) !== hash) throw new Error(`Git release ${key} evidence changed`);
	const savedDigest = digest(JSON.parse(fs.readFileSync(input.input, "utf8")));
	const boundDigest = report.publication ? digest(gitBoundRun(input, report)) : null;
	if (savedDigest !== input.inputDigest && savedDigest !== boundDigest) throw new Error("Git-bound upgrade input changed");
	if (
		ctx.state.coreReleaseBinding &&
		(savedDigest !== boundDigest ||
			ctx.state.coreReleaseBinding.inputDigest !== boundDigest ||
			ctx.state.coreReleaseBinding.sourceCommit !== report.commit)
	)
		throw new Error("Core release binding changed");
	return report;
}

function resolvedCoreInput(ctx, input) {
	if (!input.releaseGit) return input;
	const report = validateGitInput(ctx, input);
	if (!ctx.state.coreReleaseBinding || !report.publication) throw new Error("Bind the published Git release before Core execution");
	return { ...input, sourceCommit: report.commit, inputDigest: ctx.state.coreReleaseBinding.inputDigest };
}

async function bindGitRelease(ctx, input) {
	if (!input.releaseGit) return input;
	validateGitInput(ctx, input);
	const alreadyPublished = ctx.state.completedSteps.includes("git-publish");
	const step = (id, action) => ctx.step(id, CORE_GIT_RELEASE_PLAN.find(item => item.id === id).title, action);
	const phase = async name => {
		const report = await ctx.runCallable(`Git release ${name}`, () => runGitReleasePhase(ctx.root, input.releaseGit, input.gitReport, name));
		ctx.state.gitReleaseEvidence ||= {};
		for (const key of ["commit", "tagObject", "publication"]) if (report[key]) ctx.state.gitReleaseEvidence[key] = digest(report[key]);
		ctx.emit("git.release.checkpoint", { phase: name, tag: input.releaseGit.tag });
	};
	await step("git-review", async () => {
		ctx.ui.note(
			`Tag: ${input.releaseGit.tag}\nRemote: ${input.releaseGit.remote}\nReviewed tree: ${input.releaseGit.tree}\nCommit: ${input.releaseGit.commitMessage || input.releaseGit.previousHead}`,
			"Git release",
		);
		if (
			!(await ctx.ui.confirm({
				message: "Commit the reviewed staged changes, tag this release and push this exact Git tag?",
				initialValue: false,
			}))
		)
			ctx.wait("Git release awaits authorization. Cancel this task and start again to choose Skip Git release.");
		await phase("inspect");
	});
	await step("git-commit", () => phase("commit"));
	await step("git-tag", () => phase("tag"));
	await step("git-publish", () => phase("publish"));
	if (alreadyPublished)
		await ctx.runCallable("Recheck published Git release", () =>
			runGitReleasePhase(ctx.root, input.releaseGit, input.gitReport, "verify-publication"),
		);
	await step("git-bind", () => {
		const report = validateGitInput(ctx, input);
		const standard = gitBoundRun(input, report);
		const nextDigest = digest(standard);
		const coreReport = JSON.parse(fs.readFileSync(input.output, "utf8"));
		if (
			![input.inputDigest, nextDigest].includes(coreReport.inputDigest) ||
			Object.keys(coreReport).some(key => !["inputDigest", "transactions"].includes(key)) ||
			coreReport.transactions?.length
		)
			throw new Error("Core execution evidence already exists before Git release binding");
		atomicWrite(input.input, standard);
		atomicWrite(input.output, { inputDigest: nextDigest, transactions: [] });
		ctx.state.coreReleaseBinding = { sourceCommit: report.commit, inputDigest: nextDigest };
		ctx.emit("git.release.bound", { ...ctx.state.coreReleaseBinding, tag: input.releaseGit.tag });
	});
	return resolvedCoreInput(ctx, input);
}

export function createCoreUpgradeTask(common) {
	const task = createArbitrumCoreUpgradeTask(definition => definition, {
		id: "maintenance.core-upgrade",
		title: "Upgrade Core from a standard input file",
		supportedNetworks: ["any"],
		description:
			"Load a reviewed Core input, optionally commit and publish an upgrade Git tag, deploy the manifest, execute through its owner, verify and restore service, then publish on the explorer.",
		prepare: context => prepareStandardCoreUpgrade({ ...context, askGitRelease: true }),
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
			"optional Git release journal and verified remote tag",
			"source-bound input and report",
			"initial and paused snapshots",
			"deployment and governance journals",
			"core-abi.json",
			"optional separate fork rehearsal",
			"reviewed governance payloads and canonical execution receipts",
			"muon-readiness-request.json and pinned routed simulations",
		],
	});
	return common({
		...task,
		version: 5,
		inputs: [...task.inputs, { id: "releaseGit", label: "Optional Git release", type: "selection", required: false }],
		plan: (ctx, input) => [...(input?.releaseGit ? CORE_GIT_RELEASE_PLAN : []), ...task.plan(ctx, input)].map(step => ({ ...step })),
		validateResume: (ctx, input) => {
			validateGitInput(ctx, input);
			if (!input.releaseGit || ctx.state.coreReleaseBinding) validateCoreTaskInput(ctx, resolvedCoreInput(ctx, input));
		},
		reconcile: (ctx, input) => {
			if (input.releaseGit && !ctx.state.coreReleaseBinding) {
				if (ctx.state.transactions.length) throw new Error("Unexpected chain transactions before Git release binding");
				return { unresolved: [] };
			}
			return task.reconcile(ctx, resolvedCoreInput(ctx, input));
		},
		run: async (ctx, input) => task.run(ctx, await bindGitRelease(ctx, input)),
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
