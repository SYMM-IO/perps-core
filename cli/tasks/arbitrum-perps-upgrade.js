import {
	ARBITRUM_PERPS_UPGRADE_CANARY_WAIVER_CONFIRMATION,
	ARBITRUM_PERPS_UPGRADE_RUNTIME_CONFIG_PATH,
	ARBITRUM_PERPS_UPGRADE_TARGET,
	ARBITRUM_PERPS_UPGRADE_SOURCE_MIGRATION_API_VERSION,
	arbitrumPerpsUpgradeInputDigest,
	buildArbitrumPerpsUpgradeInput,
	createArbitrumPerpsUpgradeReport,
	loadArbitrumPerpsUpgradeRuntimeConfig,
	loadArbitrumPerpsUpgradeInput,
	recordArbitrumPerpsUpgradeCanaryWaiver,
	arbitrumPerpsUpgradeSafeHardeningDisposition,
	recordArbitrumPerpsUpgradeSafeHardeningSkip,
	validateArbitrumPerpsUpgradeReport,
} from "../../deployment-tooling/arbitrum-perps-upgrade.js";
import { PROJECT_ROOT } from "../lib/paths.js";
import { loadRecipeContext, recipeHardhatEnvironment } from "../lib/recipe-context.js";
import { EOA_SIGNER_MODES, SAFE_SIGNER_MODES, SIGNER_MODES, dispatchSafeActions, selectSigner, validateSignerSelection } from "../signer/index.js";
import { atomicWrite } from "./guided-recipe.js";
import { getAddress } from "ethers";
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

export function buildArbitrumPerpsUpgradeSourceMigrationEnvironment(input, state) {
	if (!state?.sourceMigrations?.length) return {};
	if (state.sourceMigrations.at(-1)?.to !== state.sourceHash) {
		throw new Error("Task source migration journal does not end at the active source hash");
	}
	const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" }).trim();
	return {
		SYMMIO_ARBITRUM_UPGRADE_SOURCE_MIGRATION: JSON.stringify({
			apiVersion: ARBITRUM_PERPS_UPGRADE_SOURCE_MIGRATION_API_VERSION,
			taskId: TASK_ID,
			taskRunId: state.runId,
			inputDigest: input.inputDigest,
			originalCommit: input.sourceCommit,
			currentCommit,
			migrations: state.sourceMigrations,
		}),
	};
}

async function runPhase(ctx, input, phase, { network = "arbitrum", env = {} } = {}) {
	await ctx.runProcess(
		"./node_modules/.bin/hardhat",
		[ADAPTER, "--phase", phase, "--input", input.input, "--output", input.output, "--network", network],
		{ env: phaseEnvironment(input, { ...env, ...buildArbitrumPerpsUpgradeSourceMigrationEnvironment(input, ctx.state) }) },
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

export async function chooseOptionalSafeHardening(ctx, report) {
	const hardening = arbitrumPerpsUpgradeSafeHardeningDisposition(report);
	if (hardening.satisfied) return;
	const choice = await ctx.ui.select({
		message: `Safe hardening is optional. Current Safe: ${hardening.ownerCount} owner(s), threshold ${hardening.threshold}.`,
		options: [
			{ value: "skip", label: "Skip Safe hardening for this upgrade" },
			{ value: "wait", label: "Wait for production owners and threshold changes" },
		],
		initialValue: "skip",
	});
	if (choice === null) {
		ctx.requestPause();
		ctx.checkpoint();
		return;
	}
	if (choice !== "skip")
		ctx.wait(`Update Safe ${ARBITRUM_PERPS_UPGRADE_TARGET.safe} owners and threshold, or continue and choose to skip Safe hardening.`);
	else recordArbitrumPerpsUpgradeSafeHardeningSkip(report);
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

const SAFE_DISPATCH_STATE_KEYS = Object.freeze({
	coreCut: "core-cut",
	accountCut: "account-cut",
	authority: "authority",
	partyBWiring: "partyb-wiring",
	wiring: "wiring",
	instantState: "instant-state",
	gaslessState: "gasless-state",
	liquidatorState: "liquidator-state",
	replacementWiring: "replacement-wiring",
	quarantine: "quarantine",
	cutover: "cutover",
});

export function safeDispatchStateKeyForUpgradeBatch(batchId) {
	const stateKey = SAFE_DISPATCH_STATE_KEYS[batchId];
	if (!stateKey) throw new Error(`Unsupported Arbitrum upgrade Safe batch ${JSON.stringify(batchId)}`);
	return stateKey;
}

const INSTANT_STATE_TEMPLATES_PER_SAFE_BATCH = 4;

function instantStateTemplateId(action) {
	const match = action?.description?.match(/^Copy legacy (?:InstantLayer template |(?:active state|instant-open mode) for template )(\d+):/);
	if (!match) throw new Error(`InstantLayer state action has no stable template id: ${JSON.stringify(action?.description)}`);
	return Number(match[1]);
}

export function safeDispatchChunksForUpgradeBatch(batchId, actions) {
	const stateKey = safeDispatchStateKeyForUpgradeBatch(batchId);
	if (batchId !== "instantState") return [{ stateKey, templateRange: null, actions }];
	const chunks = [];
	let current;
	let previousTemplateId = -1;
	for (const entry of actions) {
		const templateId = instantStateTemplateId(entry);
		if (templateId < previousTemplateId) throw new Error("InstantLayer state actions must be ordered by ascending template id");
		if (!current || (templateId !== previousTemplateId && current.templateIds.length === INSTANT_STATE_TEMPLATES_PER_SAFE_BATCH)) {
			current = { templateIds: [], actions: [] };
			chunks.push(current);
		}
		if (templateId !== previousTemplateId) current.templateIds.push(templateId);
		current.actions.push(entry);
		previousTemplateId = templateId;
	}
	return chunks.map(chunk => {
		const first = chunk.templateIds[0];
		const last = chunk.templateIds.at(-1);
		return {
			stateKey: `${stateKey}-${first}${first === last ? "" : `-${last}`}`,
			templateRange: first === last ? `template ${first}` : `templates ${first}-${last}`,
			actions: chunk.actions,
		};
	});
}

async function dispatchBatch(ctx, input, id, name, description, { planPhase = "plan" } = {}) {
	const report = await runPhase(ctx, input, planPhase);
	const actions = requiredActions(report, "safeBatches", id);
	if (actions.length === 0) return;
	const [chunk] = safeDispatchChunksForUpgradeBatch(id, actions);
	const displayName = chunk.templateRange ? `${name} (${chunk.templateRange})` : name;
	const displayDescription = chunk.templateRange
		? `${description} This independently executable batch covers ${chunk.templateRange}.`
		: description;
	const delivery = await dispatchSafeActions(ctx, input.governanceSigner, chunk.actions, {
		chainId: input.chainId,
		network: input.network,
		name: displayName,
		description: displayDescription,
		stateKey: chunk.stateKey,
		processEnv: phaseEnvironment(input),
	});
	const current = readReport(input);
	current.safeBatches[id] = {
		...current.safeBatches[id],
		status: delivery.status,
		delivery: {
			mode: delivery.mode,
			stateKey: chunk.stateKey,
			actionCount: chunk.actions.length,
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

async function completePartyBWiring(ctx, input) {
	await dispatchBatch(
		ctx,
		input,
		"partyBWiring",
		"Arbitrum InstantLayer PartyB wiring",
		"Register each configured PartyB on InstantLayer and grant AccountLayer INSTANT_LAYER_ROLE.",
		{ planPhase: "plan-partyb" },
	);
	const report = await runPhase(ctx, input, "plan-partyb");
	assertNoActions(report, "safeBatches", "partyBWiring", "InstantLayer PartyB wiring");
	const externalActions = requiredActions(report, "externalActions", "partyBLocalWiring");
	if (externalActions.length > 0) {
		ctx.wait(
			`Prior PartyB admin ${report.externalActions.partyBLocalWiring.authority} must execute the ${externalActions.length} PartyB-local wiring action(s) in ${path.relative(ctx.root, input.output)} at externalActions.partyBLocalWiring.actions, then continue this task.`,
		);
	}
}

async function prepareUpgrade({ root, ui }) {
	const config = path.join(root, RECIPE_PATH);
	if (!fs.existsSync(config)) throw new Error(`Reviewed production recipe is missing: ${RECIPE_PATH}`);
	const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }).trim();
	if (dirty) throw new Error("The tracked worktree must be clean before binding a live upgrade to an exact Git commit");
	const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	const recipe = loadRecipeContext(config, { plan: false });
	const runtimeConfigFile = path.join(root, ARBITRUM_PERPS_UPGRADE_RUNTIME_CONFIG_PATH);
	const runtimeConfig = loadArbitrumPerpsUpgradeRuntimeConfig(runtimeConfigFile);
	let partyBs = runtimeConfig.config.instantLayer.partyBs;
	if (partyBs.length === 0) {
		const entered = await ui.text({
			message: "PartyB address(es) required by the new InstantLayer (comma or whitespace separated)",
			validate: value => {
				try {
					parsePartyBAddressInput(value);
					return undefined;
				} catch (error) {
					return error.message || String(error);
				}
			},
		});
		if (entered === null) return null;
		partyBs = parsePartyBAddressInput(entered);
	}
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
		partyBs,
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
			`PartyBs: ${standardInput.instantLayer.partyBs.join(", ")}`,
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

export function parsePartyBAddressInput(value) {
	const entries = String(value || "")
		.split(/[\s,]+/)
		.filter(Boolean)
		.map(entry => getAddress(entry));
	if (entries.length === 0) throw new Error("At least one non-zero PartyB address is required");
	if (entries.some(entry => entry === "0x0000000000000000000000000000000000000000")) {
		throw new Error("PartyB addresses must be non-zero");
	}
	if (new Set(entries.map(entry => entry.toLowerCase())).size !== entries.length) {
		throw new Error("PartyB addresses must not contain duplicates");
	}
	return entries;
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
		resumePolicy: { strategy: "stable-step-id", sourceDrift: "confirm", inputDrift: "refuse" },
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
				completePartyBWiring(ctx, input).then(() =>
					dispatchBatch(
						ctx,
						input,
						"wiring",
						"Arbitrum InstantLayer and GaslessLayer wiring",
						"Grant roles, bind AccountLayer, install templates, and configure operational fees.",
					),
				),
			);
			await ctx.step("verify-wiring", PLAN[18].title, async () => {
				const report = await runPhase(ctx, input, "plan");
				assertNoActions(report, "externalActions", "partyBLocalWiring", "PartyB-local wiring");
				assertNoActions(report, "safeBatches", "partyBWiring", "InstantLayer PartyB wiring");
				assertNoActions(report, "safeBatches", "wiring", "InstantLayer and GaslessLayer wiring");
			});
			await ctx.step("canary", PLAN[19].title, async () => {
				for (const phase of ["repair-instant-layer", "repair-gasless-layer", "publish-peripherals"]) {
					await runPhase(ctx, input, phase, {
						env: { SYMMIO_ARBITRUM_UPGRADE_EXECUTE: "true", CONFIRM_CHAIN_ID: String(input.chainId) },
					});
				}
				const replacement = readReport(input).stages.peripheralReplacement;
				if (replacement?.discardedInstantLayer) {
					await dispatchBatch(
						ctx,
						input,
						"replacementWiring",
						"Arbitrum replacement InstantLayer and GaslessLayer wiring",
						"Authorize the exact verified replacement pair without changing the original production pair.",
					);
					let report = await runPhase(ctx, input, "plan");
					assertNoActions(report, "safeBatches", "replacementWiring", "Replacement peripheral wiring");
					await dispatchBatch(
						ctx,
						input,
						"quarantine",
						"Arbitrum discarded peripheral quarantine",
						"Remove protocol authority from the discarded InstantLayer and GaslessLayer while keeping the original production pair active.",
					);
					report = await runPhase(ctx, input, "plan");
					assertNoActions(report, "safeBatches", "quarantine", "Discarded peripheral quarantine");
				}
				await dispatchBatch(
					ctx,
					input,
					"instantState",
					"Arbitrum InstantLayer template-state migration",
					"Copy the pinned legacy InstantLayer templates, active flags, and instant-open modes without changing template IDs.",
				);
				await dispatchBatch(
					ctx,
					input,
					"gaslessState",
					"Arbitrum GaslessLayer fee-state migration",
					"Copy the pinned legacy GaslessLayer fee and quota configuration while retaining the reviewed new treasury.",
				);
				await dispatchBatch(
					ctx,
					input,
					"liquidatorState",
					"Arbitrum reused Liquidator Proxy wiring",
					"Preserve the pinned operator list and complete any missing Core liquidation role required by the reused proxy.",
				);
				const confirmed = await ctx.ui.confirm({
					message: "Did the production canary complete successfully against the new InstantLayer and GaslessLayer?",
					initialValue: false,
				});
				if (confirmed) {
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
					return;
				}
				const waive = await ctx.ui.confirm({
					message: "Explicitly waive the production canary and accept cutover without runtime canary evidence?",
					initialValue: false,
				});
				if (!waive)
					ctx.wait("Run and verify a production canary against the newly wired InstantLayer and GaslessLayer, then continue this task.");
				const authorization = await ctx.ui.text({
					message: `Type ${ARBITRUM_PERPS_UPGRADE_CANARY_WAIVER_CONFIRMATION} to authorize the waiver`,
					validate: value =>
						value === ARBITRUM_PERPS_UPGRADE_CANARY_WAIVER_CONFIRMATION
							? undefined
							: `Type exactly ${ARBITRUM_PERPS_UPGRADE_CANARY_WAIVER_CONFIRMATION}`,
				});
				if (authorization === null) {
					ctx.requestPause();
					ctx.checkpoint();
				}
				const reason = await ctx.ui.text({
					message: "Durable operator reason for waiving the production canary",
					validate: value => (value.trim() ? undefined : "A waiver reason is required"),
				});
				if (reason === null) {
					ctx.requestPause();
					ctx.checkpoint();
				}
				const report = readReport(input);
				recordArbitrumPerpsUpgradeCanaryWaiver(report, reason.trim());
				writeReport(input, report);
				ctx.emit("warning", {
					message: "Production canary was explicitly waived; cutover is proceeding without runtime canary evidence.",
				});
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
				// Compatibility gate for upgrade runs that completed the original wiring
				// step before PartyB wiring became a mandatory deployment invariant.
				await completePartyBWiring(ctx, input);
				const report = await runPhase(ctx, input, "verify-final");
				await chooseOptionalSafeHardening(ctx, report);
				writeReport(input, report);
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
