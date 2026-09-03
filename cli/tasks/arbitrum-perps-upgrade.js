import {
	ARBITRUM_PERPS_UPGRADE_TARGET,
	arbitrumPerpsUpgradeInputDigest,
	buildArbitrumPerpsUpgradeInput,
	createArbitrumPerpsUpgradeReport,
	loadArbitrumPerpsUpgradeInput,
	validateArbitrumPerpsUpgradeReport,
} from "../../deployment-tooling/arbitrum-perps-upgrade.js";
import { loadRecipeContext, recipeHardhatEnvironment } from "../lib/recipe-context.js";
import { EOA_SIGNER_MODES, SAFE_SIGNER_MODES, SIGNER_MODES, dispatchSafeActions, selectSigner, validateSignerSelection } from "../signer/index.js";
import { atomicWrite } from "./guided-recipe.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TASK_ID = "maintenance.arbitrum-perps-upgrade";
const RECIPE_PATH = "deployment-recipes/arbitrum-vibe-production.json";
const ADAPTER = "internal:arbitrum-perps-upgrade";

const PLAN = Object.freeze([
	{ id: "compile", phase: "prepare", title: "Compile and validate the pinned contract artifacts" },
	{ id: "inspect", phase: "prepare", title: "Inspect the live target, ownership, roles, and Safe state" },
	{ id: "rehearse", phase: "rehearsal", title: "Run or explicitly waive the matching Arbitrum fork rehearsal" },
	{ id: "authorize", phase: "authorization", title: "Authorize the exact live chain, Safe, input, and report" },
	{ id: "deploy-core-facets", phase: "deployment", title: "Deploy or recover the Core facet and library set" },
	{ id: "deploy-account-facets", phase: "deployment", title: "Deploy or recover the AccountLayer facet and library set" },
	{ id: "deploy-instant-layer", phase: "deployment", title: "Deploy or recover the new InstantLayer" },
	{ id: "deploy-gasless-layer", phase: "deployment", title: "Deploy, configure, and recover the new GaslessLayer" },
	{ id: "publish", phase: "publication", title: "Publish all newly deployed bytecode to Arbiscan" },
	{ id: "plan-governance", phase: "planning", title: "Recompute exact Diamond cuts and wiring from live state" },
	{ id: "core-cut", phase: "execution", title: "Execute the Safe Core Diamond-cut batch" },
	{ id: "verify-core-cut", phase: "verification", title: "Verify the Core selector surface from live state" },
	{ id: "account-cut", phase: "execution", title: "Execute the Safe AccountLayer Diamond-cut batch" },
	{ id: "verify-account-cut", phase: "verification", title: "Verify the AccountLayer selector surface from live state" },
	{
		id: "account-authority",
		phase: "verification",
		title: "Verify AccountLayer role administration is held by the Safe",
	},
	{ id: "core-authority", phase: "authority", title: "Execute the remaining Safe Core authority batch" },
	{ id: "verify-authority", phase: "verification", title: "Verify Safe post-cut authority from live contract state" },
	{ id: "wiring", phase: "execution", title: "Execute the Safe InstantLayer and GaslessLayer wiring batch" },
	{ id: "verify-wiring", phase: "verification", title: "Verify new InstantLayer and GaslessLayer wiring from live state" },
	{ id: "canary", phase: "canary", title: "Record a successful production canary before cutover" },
	{ id: "cutover", phase: "execution", title: "Execute the Safe old-InstantLayer role cutover batch" },
	{ id: "verify-cutover", phase: "verification", title: "Verify old InstantLayer protocol roles are revoked" },
	{ id: "safe-hardening", phase: "handover", title: "Verify production Safe owners and threshold are hardened" },
	{ id: "final-report", phase: "verification", title: "Finalize the standard upgrade report" },
]);

function readReport(input) {
	const standardInput = loadArbitrumPerpsUpgradeInput(input.input);
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(input.output, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read upgrade report ${input.output}: ${error.message || error}`);
	}
	return validateArbitrumPerpsUpgradeReport(parsed, standardInput, input.output);
}

function writeReport(input, report) {
	const standardInput = loadArbitrumPerpsUpgradeInput(input.input);
	report.updatedAt = new Date().toISOString();
	validateArbitrumPerpsUpgradeReport(report, standardInput, input.output);
	atomicWrite(input.output, report);
}

function phaseEnvironment(input, extra = {}) {
	const recipe = loadRecipeContext(input.config, { plan: false });
	return {
		...recipeHardhatEnvironment(recipe),
		SYMMIO_ARBITRUM_UPGRADE_RUN_ID: input.inputDigest,
		DEPLOY_CONFIRMATIONS: String(input.execution.confirmations),
		DEPLOY_TX_TIMEOUT: String(input.execution.txTimeoutSeconds),
		DEPLOY_SLOW_TX_NOTICE: String(input.execution.slowNoticeSeconds),
		...extra,
	};
}

async function runPhase(ctx, input, phase, { network = "arbitrum", env = {} } = {}) {
	await ctx.runProcess(
		"./node_modules/.bin/hardhat",
		[ADAPTER, "--phase", phase, "--input", input.input, "--output", input.output, "--network", network],
		{ env: phaseEnvironment(input, env) },
	);
	return readReport(input);
}

function requiredActions(report, collection, id) {
	const entry = report[collection]?.[id];
	if (!entry || !Array.isArray(entry.actions)) throw new Error(`Standard report is missing ${collection}.${id}.actions`);
	return entry.actions;
}

function assertNoActions(report, collection, id, label) {
	const actions = requiredActions(report, collection, id);
	if (actions.length > 0) throw new Error(`${label} still requires ${actions.length} action(s)`);
}

function assertSafeAccountAuthority(report) {
	const actions = requiredActions(report, "externalActions", "accountAuthority");
	if (actions.length > 0) {
		throw new Error(
			`Safe ${ARBITRUM_PERPS_UPGRADE_TARGET.safe} must already administer AccountLayer SIGNER_SETTER_ROLE; no prior-admin or Ledger signer is accepted by this workflow`,
		);
	}
}

export function applyForkRehearsalWaiver(report, forkBlockNumber, skippedAt = new Date().toISOString()) {
	if (!Number.isSafeInteger(forkBlockNumber) || forkBlockNumber < 1) throw new Error("Live inspection did not record a fork block number");
	report.stages.forkRehearsal = {
		status: "skipped",
		baseBlockNumber: forkBlockNumber,
		reason: "Explicit operator waiver bound in the standard upgrade input",
		skippedAt,
	};
	if (report.lifecycle !== "complete") report.lifecycle = "in_progress";
	return report;
}

function validateUpgradeTaskInput(input) {
	if (input.network !== "arbitrum" || input.chainId !== 42161 || input.mode !== "live") {
		throw new Error("Arbitrum Perps upgrade task input must target live Arbitrum chain 42161");
	}
	const standardInput = loadArbitrumPerpsUpgradeInput(input.input);
	if (arbitrumPerpsUpgradeInputDigest(standardInput) !== input.inputDigest)
		throw new Error("Standard upgrade input digest does not match task input");
	if (standardInput.source.commit !== input.sourceCommit) throw new Error("Standard upgrade source commit does not match task input");
	const governance = validateSignerSelection(input.governanceSigner);
	if (!SAFE_SIGNER_MODES.includes(governance.mode) || governance.safeAddress.toLowerCase() !== ARBITRUM_PERPS_UPGRADE_TARGET.safe.toLowerCase()) {
		throw new Error(`Governance signer must be Safe ${ARBITRUM_PERPS_UPGRADE_TARGET.safe}`);
	}
	return standardInput;
}

async function dispatchBatch(ctx, input, id, name, description) {
	const report = await runPhase(ctx, input, "plan");
	const actions = requiredActions(report, "safeBatches", id);
	if (actions.length === 0) return;
	const delivery = await dispatchSafeActions(ctx, input.governanceSigner, actions, {
		chainId: input.chainId,
		network: input.network,
		name,
		description,
		stateKey: id,
		processEnv: phaseEnvironment(input),
	});
	const current = readReport(input);
	current.safeBatches[id] = {
		...current.safeBatches[id],
		status: delivery.status,
		delivery: {
			mode: delivery.mode,
			digest: delivery.digest,
			builderPath: delivery.builderPath,
			intentPath: delivery.intentPath,
			proposalPath: delivery.proposalPath,
			safeTxHash: delivery.safeTxHash,
		},
	};
	writeReport(input, current);
	if (delivery.mode === SIGNER_MODES.SAFE_FILE) {
		ctx.wait(`Import ${path.relative(ctx.root, delivery.builderPath)} into Safe Transaction Builder, execute it, then continue this task.`);
	}
	ctx.wait(`Safe proposal ${delivery.safeTxHash} must execute before this task can continue.`);
}

async function prepareUpgrade({ root, ui }) {
	const config = path.join(root, RECIPE_PATH);
	if (!fs.existsSync(config)) throw new Error(`Reviewed production recipe is missing: ${RECIPE_PATH}`);
	const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }).trim();
	if (dirty) throw new Error("The tracked worktree must be clean before binding a live upgrade to an exact Git commit");
	const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	const recipe = loadRecipeContext(config, { plan: false });
	const skipForkRehearsal = await ui.confirm({
		message: "Skip the matching Arbitrum fork rehearsal before live deployment?",
		initialValue: false,
	});
	if (skipForkRehearsal === null) return null;
	if (skipForkRehearsal) {
		const waiver = await ui.text({
			message: "Type SKIP FORK REHEARSAL to bind this waiver into the standard upgrade input",
			validate: value => (value === "SKIP FORK REHEARSAL" ? undefined : "Type exactly SKIP FORK REHEARSAL"),
		});
		if (waiver === null) return null;
	}
	const standardInput = buildArbitrumPerpsUpgradeInput({
		recipe: recipe.recipe,
		recipePath: recipe.identityPath,
		recipeDigest: recipe.digest,
		sourceCommit,
		requireForkRehearsal: !skipForkRehearsal,
	});
	const inputDigest = arbitrumPerpsUpgradeInputDigest(standardInput);
	const directory = path.join(root, "tasks", "data", "42161", "upgrades", inputDigest);
	const inputFile = path.join(directory, "input.json");
	const outputFile = path.join(directory, "report.json");
	atomicWrite(inputFile, standardInput);
	if (!fs.existsSync(outputFile)) atomicWrite(outputFile, createArbitrumPerpsUpgradeReport(standardInput));

	ui.note(
		[
			`Input digest: ${inputDigest}`,
			`Source commit: ${sourceCommit}`,
			`Core: ${standardInput.contracts.core}`,
			`AccountLayer: ${standardInput.contracts.accountLayer}`,
			`Safe: ${standardInput.governance.safe}`,
			`Input: ${path.relative(root, inputFile)}`,
			`Output: ${path.relative(root, outputFile)}`,
		].join("\n"),
		"Bound standard upgrade I/O",
	);

	const governanceSigner = await selectSigner(ui, {
		role: "Upgrade governance Safe",
		allowedModes: SAFE_SIGNER_MODES,
		initialMode: SIGNER_MODES.SAFE_FILE,
		network: "arbitrum",
		chainId: 42161,
		safeAddress: ARBITRUM_PERPS_UPGRADE_TARGET.safe,
	});
	if (!governanceSigner) return null;
	return {
		network: "arbitrum",
		chainId: 42161,
		mode: "live",
		config,
		recipeDigest: recipe.digest,
		input: inputFile,
		output: outputFile,
		inputDigest,
		sourceCommit,
		execution: standardInput.execution,
		governanceSigner,
	};
}

async function reconcileUpgrade(ctx, input) {
	if (!ctx.state.transactions.some(transaction => ["submitted", "unresolved", "timed_out"].includes(transaction.status))) {
		return { unresolved: [] };
	}
	await runPhase(ctx, input, "reconcile", {
		env: { SYMMIO_RECIPE_READ_ONLY: "true" },
	});
	const byHash = new Map(readReport(input).transactions.map(transaction => [transaction.hash?.toLowerCase(), transaction]));
	for (const transaction of ctx.state.transactions) {
		const reconciled = byHash.get(transaction.hash?.toLowerCase());
		if (reconciled) Object.assign(transaction, reconciled);
	}
	return {
		unresolved: ctx.state.transactions
			.filter(transaction => ["submitted", "unresolved", "timed_out"].includes(transaction.status))
			.map(transaction => transaction.hash),
	};
}

export function createArbitrumPerpsUpgradeTask(common) {
	return common({
		id: TASK_ID,
		version: 5,
		category: "maintenance",
		risk: "transaction",
		title: "Arbitrum Perps Core v0.8.6 upgrade",
		description:
			"Deploy, publish, upgrade, wire, cut over, and verify the fixed Arbitrum production target through its Safe, with a rehearsal or explicit waiver.",
		supportedNetworks: ["arbitrum"],
		inputs: [
			{ id: "network", label: "Network", type: "network", required: true },
			{ id: "config", label: "Reviewed deployment recipe", type: "recipe", required: true },
			{ id: "input", label: "Standard input JSON", type: "string", required: true },
			{ id: "output", label: "Standard report JSON", type: "string", required: true },
			{ id: "governanceSigner", label: "Upgrade governance Safe", type: "selection", required: true },
			{ id: "signer", label: "Contract deployment signer", type: "selection", required: true },
		],
		artifacts: [
			"digest-bound standard input JSON",
			"resumable standard report JSON",
			"fork rehearsal evidence or explicit digest-bound waiver",
			"deployment checkpoint and transaction journal",
			"independent Safe Transaction Builder batches",
			"Arbiscan publication evidence",
			"final on-chain verification",
		],
		prepare: prepareUpgrade,
		signerPolicy: {
			role: "Contract deployment signer",
			allowedModes: EOA_SIGNER_MODES.filter(mode => mode !== SIGNER_MODES.LOCAL_NODE),
			initialMode: SIGNER_MODES.KEYSTORE,
		},
		plan: () => PLAN.map(step => ({ ...step })),
		run: async (ctx, input) => {
			validateUpgradeTaskInput(input);
			await ctx.step("compile", PLAN[0].title, async () => {
				await ctx.runProcess("npm", ["run", "compile"], { env: phaseEnvironment(input) });
			});
			await ctx.step("inspect", PLAN[1].title, async () => {
				const report = await runPhase(ctx, input, "inspect");
				assertSafeAccountAuthority(report);
			});
			await ctx.step("rehearse", PLAN[2].title, async () => {
				const report = readReport(input);
				const forkBlockNumber = report.stages.inspect?.blockNumber;
				if (!Number.isSafeInteger(forkBlockNumber) || forkBlockNumber < 1)
					throw new Error("Live inspection did not record a fork block number");
				if (!input.execution.requireForkRehearsal) {
					applyForkRehearsalWaiver(report, forkBlockNumber);
					writeReport(input, report);
					ctx.emit("warning", {
						message: "Matching Arbitrum fork rehearsal was explicitly waived; live deployment is proceeding without rehearsal evidence.",
					});
					return;
				}
				await runPhase(ctx, input, "rehearse", {
					network: "fork-arbitrum",
					env: { FORK_BLOCK_NUMBER: String(forkBlockNumber) },
				});
				const rehearsed = readReport(input).stages.forkRehearsal;
				if (rehearsed?.status !== "complete" || rehearsed.baseBlockNumber !== forkBlockNumber) {
					throw new Error("Fork rehearsal is not bound to the inspected live block");
				}
			});
			await ctx.step("authorize", PLAN[3].title, async () => {
				const typedChain = await ctx.ui.text({
					message: `Type chain ID ${input.chainId} to authorize this live upgrade`,
					validate: value => (value === String(input.chainId) ? undefined : `Type exactly ${input.chainId}`),
				});
				if (typedChain === null) ctx.requestPause();
				const typedSafe = await ctx.ui.text({
					message: `Type Safe address ${ARBITRUM_PERPS_UPGRADE_TARGET.safe}`,
					validate: value =>
						value.toLowerCase() === ARBITRUM_PERPS_UPGRADE_TARGET.safe.toLowerCase()
							? undefined
							: `Type exactly ${ARBITRUM_PERPS_UPGRADE_TARGET.safe}`,
				});
				if (typedSafe === null) ctx.requestPause();
				ctx.checkpoint();
			});
			for (const [index, phase] of ["deploy-core-facets", "deploy-account-facets", "deploy-instant-layer", "deploy-gasless-layer"].entries()) {
				await ctx.step(phase, PLAN[4 + index].title, () =>
					runPhase(ctx, input, phase, {
						env: { SYMMIO_ARBITRUM_UPGRADE_EXECUTE: "true", CONFIRM_CHAIN_ID: String(input.chainId) },
					}),
				);
			}
			await ctx.step("publish", PLAN[8].title, () =>
				runPhase(ctx, input, "publish", {
					env: { SYMMIO_ARBITRUM_UPGRADE_EXECUTE: "true", CONFIRM_CHAIN_ID: String(input.chainId) },
				}),
			);
			await ctx.step("plan-governance", PLAN[9].title, async () => {
				await runPhase(ctx, input, "plan");
			});
			await ctx.step("core-cut", PLAN[10].title, () =>
				dispatchBatch(
					ctx,
					input,
					"coreCut",
					"Arbitrum Perps Core Diamond cut",
					"Install the exact reviewed Core selector surface from the pinned source.",
				),
			);
			await ctx.step("verify-core-cut", PLAN[11].title, async () => {
				const report = await runPhase(ctx, input, "plan");
				assertNoActions(report, "safeBatches", "coreCut", "Core Diamond cut");
			});
			await ctx.step("account-cut", PLAN[12].title, () =>
				dispatchBatch(
					ctx,
					input,
					"accountCut",
					"Arbitrum AccountLayer Diamond cut",
					"Install the exact reviewed AccountLayer selector surface from the pinned source.",
				),
			);
			await ctx.step("verify-account-cut", PLAN[13].title, async () => {
				const report = await runPhase(ctx, input, "plan");
				assertNoActions(report, "safeBatches", "accountCut", "AccountLayer Diamond cut");
			});
			await ctx.step("account-authority", PLAN[14].title, async () => {
				const report = await runPhase(ctx, input, "inspect");
				assertSafeAccountAuthority(report);
			});
			await ctx.step("core-authority", PLAN[15].title, () =>
				dispatchBatch(
					ctx,
					input,
					"authority",
					"Arbitrum Perps Core authority completion",
					"Grant any remaining reviewed Core administrative role to the upgrade Safe after both Diamond cuts.",
				),
			);
			await ctx.step("verify-authority", PLAN[16].title, async () => {
				const report = await runPhase(ctx, input, "inspect");
				assertNoActions(report, "safeBatches", "authority", "Core authority");
				assertNoActions(report, "externalActions", "accountAuthority", "Scoped AccountLayer authority");
			});
			await ctx.step("wiring", PLAN[17].title, () =>
				dispatchBatch(
					ctx,
					input,
					"wiring",
					"Arbitrum InstantLayer and GaslessLayer wiring",
					"Grant roles, bind AccountLayer, install templates, and configure operational fees.",
				),
			);
			await ctx.step("verify-wiring", PLAN[18].title, async () => {
				const report = await runPhase(ctx, input, "plan");
				assertNoActions(report, "safeBatches", "wiring", "InstantLayer and GaslessLayer wiring");
			});
			await ctx.step("canary", PLAN[19].title, async () => {
				const confirmed = await ctx.ui.confirm({
					message: "Did the production canary complete successfully against the new InstantLayer and GaslessLayer?",
					initialValue: false,
				});
				if (!confirmed)
					ctx.wait("Run and verify a production canary against the newly wired InstantLayer and GaslessLayer, then continue this task.");
				const evidence = await ctx.ui.text({
					message: "Canary transaction hash or durable evidence reference",
					validate: value => (value.trim() ? undefined : "A canary evidence reference is required"),
				});
				if (evidence === null) {
					ctx.requestPause();
					ctx.checkpoint();
				}
				const report = readReport(input);
				report.stages.canary = { status: "complete", evidence: evidence.trim(), recordedAt: new Date().toISOString() };
				writeReport(input, report);
			});
			await ctx.step("cutover", PLAN[20].title, () =>
				dispatchBatch(
					ctx,
					input,
					"cutover",
					"Arbitrum old InstantLayer cutover",
					"Revoke the old InstantLayer protocol roles only after the successful canary.",
				),
			);
			await ctx.step("verify-cutover", PLAN[21].title, async () => {
				const report = await runPhase(ctx, input, "plan");
				assertNoActions(report, "safeBatches", "cutover", "Old InstantLayer cutover");
			});
			await ctx.step("safe-hardening", PLAN[22].title, async () => {
				const report = await runPhase(ctx, input, "verify-final");
				if (report.stages.safeHardening?.status !== "complete") {
					ctx.wait(
						`Add the production owners to Safe ${ARBITRUM_PERPS_UPGRADE_TARGET.safe}, raise its threshold above 1, then continue this task.`,
					);
				}
			});
			return ctx.step("final-report", PLAN[23].title, async () => {
				const report = await runPhase(ctx, input, "verify-final");
				if (report.lifecycle !== "complete") throw new Error(`Final upgrade lifecycle is ${report.lifecycle}, not complete`);
				return { input: input.input, output: input.output, inputDigest: input.inputDigest, lifecycle: report.lifecycle };
			});
		},
		validateResume: (_context, input) => {
			validateUpgradeTaskInput(input);
		},
		reconcile: reconcileUpgrade,
	});
}

export { PLAN as ARBITRUM_PERPS_UPGRADE_PLAN };
