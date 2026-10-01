import {
	CORE_UPGRADE_API,
	CORE_UPGRADE_CONFIG,
	CORE_UPGRADE_RECIPE,
	assertCoreEvidence,
	digest,
	validateCoreUpgradeConfig,
} from "../../deployment-tooling/arbitrum-core-upgrade.js";
import { loadRecipeContext, recipeHardhatEnvironment } from "../lib/recipe-context.js";
import { EOA_SIGNER_MODES, SIGNER_MODES, dispatchSafeActions, validateSignerSelection } from "../signer/index.js";
import { atomicWrite } from "./guided-recipe.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CORE_UPGRADE_PLAN = Object.freeze([
	{ id: "compile", phase: "prepare", title: "Compile the current Core release and enforce the size budget" },
	{ id: "inspect", phase: "prepare", title: "Inspect the supplied deployment, storage and funding" },
	{ id: "rehearse-initial", phase: "rehearsal", title: "Rehearse the complete Core upgrade on the initial fork" },
	{ id: "authorize", phase: "authorization", title: "Review and authorize the Core deployments" },
	{ id: "deploy", phase: "deployment", title: "Deploy all Core libraries and facets with recovery checkpoints" },
	{ id: "publish", phase: "publication", title: "Verify runtime bytecode and publish the deployments" },
	{ id: "client-ready", phase: "verification", title: "Confirm consumer ABI and operator role readiness" },
	{ id: "pause", phase: "execution", title: "Export and verify the Safe maintenance pause" },
	{ id: "plan-cut", phase: "prepare", title: "Bind the paused state and atomic Core upgrade batch" },
	{ id: "rehearse-cut", phase: "rehearsal", title: "Execute the exact deployed Safe payload on the paused fork" },
	{ id: "cut", phase: "execution", title: "Export the atomic Core upgrade and verify its Safe receipt" },
	{ id: "service-ready", phase: "verification", title: "Confirm application and indexer checks before restoring service" },
	{ id: "unpause", phase: "execution", title: "Restore the original pause state after verification" },
]);
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const BINDINGS = {
	inspect: ["initial", "client"],
	"rehearse-initial": ["initialRehearsal"],
	deploy: ["deployments"],
	publish: ["publication"],
	"plan-pause": ["pauseBatch"],
	"verify-pause": ["paused"],
	"plan-cut": ["batch"],
	"rehearse-cut": ["cutRehearsal"],
	"verify-cut": ["verifiedCut"],
	"plan-unpause": ["unpauseBatch"],
};

export function validateCoreTaskInput(ctx, input) {
	if (input.network !== "arbitrum" || input.chainId !== 42161 || input.mode !== "live")
		throw new Error("Core upgrade requires live Arbitrum 42161");
	const standard = read(input.input);
	validateCoreUpgradeConfig(standard.config);
	if (standard.apiVersion !== CORE_UPGRADE_API || digest(standard) !== input.inputDigest || standard.sourceCommit !== input.sourceCommit)
		throw new Error("Core upgrade input/source changed");
	if (
		loadRecipeContext(input.config, { plan: false }).digest !== standard.recipeDigest ||
		loadRecipeContext(input.forkConfig, { plan: false }).digest !== standard.forkRecipeDigest
	)
		throw new Error("Upgrade credential recipe changed");
	const signer = validateSignerSelection(input.signer, { allowSafe: false });
	if (signer.mode === SIGNER_MODES.LOCAL_NODE) throw new Error("Live deployments require an EOA signer");
	const report = read(input.output);
	if (report.inputDigest !== input.inputDigest) throw new Error("Core report/input mismatch");
	for (const [field, hash] of Object.entries(ctx.state.coreEvidence || {})) assertCoreEvidence(report, field, hash);
	if (ctx.state.coreEvidence?.client && digest(read(path.join(path.dirname(input.output), "core-abi.json"))) !== report.client.abiDigest)
		throw new Error("Client ABI artifact changed");
	return standard;
}

export function coreUpgradeEnvironment(input, extra = {}, fork = false) {
	return {
		...recipeHardhatEnvironment(loadRecipeContext(fork ? input.forkConfig : input.config, { plan: false })),
		SYMMIO_CORE_UPGRADE_INPUT: input.inputDigest,
		SYMMIO_CORE_UPGRADE_EXECUTE: "false",
		CONFIRM_CHAIN_ID: "",
		DEPLOY_CONFIRMATIONS: "1",
		DEPLOY_TX_TIMEOUT: "300",
		...extra,
	};
}

async function runPhase(ctx, input, phase, { fork = false, env = {} } = {}) {
	validateCoreTaskInput(ctx, input);
	await ctx.runProcess(
		"./node_modules/.bin/hardhat",
		[
			"internal:arbitrum-core-upgrade",
			"--phase",
			phase,
			"--input",
			input.input,
			"--output",
			input.output,
			"--network",
			fork ? "fork-arbitrum" : "arbitrum",
		],
		{
			env: coreUpgradeEnvironment(
				input,
				{
					...(phase !== "deploy"
						? { SYMMIO_RECIPE_READ_ONLY: phase === "publish" ? "false" : "true", SYMMIO_SIGNER_MODE: "safe-file" }
						: {}),
					SYMMIO_CORE_UPGRADE_EVIDENCE: JSON.stringify(ctx.state.coreEvidence || {}),
					...env,
				},
				fork,
			),
		},
	);
	const report = read(input.output);
	ctx.state.coreEvidence ||= {};
	for (const field of BINDINGS[phase] || []) {
		if (!report[field]) throw new Error(`Missing ${field} evidence after ${phase}`);
		const hash = digest(report[field]);
		if (ctx.state.coreEvidence[field] && ctx.state.coreEvidence[field] !== hash) throw new Error(`Bound ${field} changed`);
		ctx.state.coreEvidence[field] = hash;
	}
	ctx.emit("upgrade.core-evidence", { phase, bindings: ctx.state.coreEvidence });
	return report;
}

export async function deliverCoreBatch(ctx, input, key) {
	const field = key === "cut" ? "batch" : `${key}Batch`,
		standard = validateCoreTaskInput(ctx, input);
	let report = read(input.output);
	if (key !== "cut" && !report[field]) report = await runPhase(ctx, input, `plan-${key}`);
	const batch = report[field];
	if (!batch) throw new Error("Missing reviewed Safe batch");
	if (batch.alreadyPaused) {
		await runPhase(ctx, input, `verify-${key}`);
		return;
	}
	if (!ctx.state.safeDispatches?.[key]) {
		await runPhase(ctx, input, "check-export", { env: { SYMMIO_CORE_UPGRADE_BATCH: key } });
		ctx.ui.note(batch.actions.map(a => `${a.description}\n${a.to} · value ${a.value}\n${a.data}`).join("\n\n"), `Review ${key} Safe batch`);
		const approved = await ctx.ui.confirm({ message: `Export this ${key} batch for the Dev Safe?`, initialValue: false });
		if (!approved) ctx.wait(`Review the ${key} batch and continue when ready to export it.`);
		const delivery = await dispatchSafeActions(ctx, { mode: SIGNER_MODES.SAFE_FILE, safeAddress: standard.config.target.safe }, batch.actions, {
			root: ctx.root,
			chainId: 42161,
			network: "arbitrum",
			name: `Vibe Core upgrade ${key}`,
			description: `Core upgrade ${input.inputDigest}; execute together as one Safe transaction. Expected Safe hash ${batch.envelope.safeTxHash}`,
			stateKey: key,
		});
		ctx.wait(
			`Execute ${delivery.builderPath} as ONE Safe transaction. Match the saved payload in ${input.output} (Safe hash ${batch.envelope.safeTxHash}); then continue with its execution transaction hash.`,
		);
	}
	const hash = await ctx.ui.text({
		message: `Successful ${key} Safe execution transaction hash (leave empty to keep waiting)`,
		initialValue: ctx.state.coreReceipts?.[key] || "",
	});
	if (!hash) ctx.wait(`Waiting for the ${key} Safe execution transaction hash. An export or proposal is not execution.`);
	const verified = await runPhase(ctx, input, `verify-${key}`, { env: { SYMMIO_CORE_UPGRADE_RECEIPT: hash } });
	ctx.state.coreReceipts ||= {};
	ctx.state.coreReceipts[key] = hash;
	ctx.state.safeDispatches[key].status = "executed";
	return verified;
}

async function prepare({ root, ui }) {
	if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }).trim())
		throw new Error("Commit tracked edits before binding this upgrade");
	const config = validateCoreUpgradeConfig(read(path.join(root, CORE_UPGRADE_CONFIG)));
	const recipe = loadRecipeContext(path.join(root, CORE_UPGRADE_RECIPE), { plan: false });
	if (recipe.recipe.network.name !== "arbitrum" || recipe.recipe.network.chainId !== 42161 || recipe.recipe.network.mode !== "live")
		throw new Error("Credential recipe must select live Arbitrum 42161");
	const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	const directory = path.join(root, "tasks/data/42161/core-upgrades", randomUUID());
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const forkConfig = path.join(directory, "fork-recipe.json");
	atomicWrite(forkConfig, { ...recipe.recipe, network: { ...recipe.recipe.network, name: "fork-arbitrum", mode: "fork" } });
	const standard = {
		apiVersion: CORE_UPGRADE_API,
		sourceCommit,
		config,
		recipeDigest: recipe.digest,
		forkRecipeDigest: loadRecipeContext(forkConfig, { plan: false }).digest,
		runNonce: path.basename(directory),
	};
	const input = path.join(directory, "input.json"),
		output = path.join(directory, "report.json"),
		inputDigest = digest(standard);
	atomicWrite(input, standard);
	atomicWrite(output, { inputDigest, transactions: [] });
	ui.note(
		`Core: ${config.target.core}\nSafe: ${config.target.safe}\nSource: ${sourceCommit}\nReport: ${output}\nBoth fork rehearsals are mandatory. The task upgrades Core and preserves the current Account, Instant and Gasless layers.`,
		"Current Arbitrum Core upgrade",
	);
	return { network: "arbitrum", chainId: 42161, mode: "live", config: recipe.path, forkConfig, input, output, inputDigest, sourceCommit };
}

async function reconcile(ctx, input) {
	const unresolved = () =>
		(ctx.state.transactions || []).filter(tx => ["submitted", "unresolved", "timed_out"].includes(tx.status)).map(tx => tx.hash);
	if (!unresolved().length) return { unresolved: [] };
	try {
		await runPhase(ctx, input, "reconcile", { env: { SYMMIO_CORE_UPGRADE_TRANSACTIONS: JSON.stringify(ctx.state.transactions) } });
	} finally {
		for (const tx of ctx.state.transactions) {
			const match = read(input.output).transactions?.find(t => t.hash === tx.hash || t.originalHash === tx.hash);
			if (match) Object.assign(tx, match);
		}
	}
	return { unresolved: unresolved() };
}

export function createArbitrumCoreUpgradeTask(common) {
	return common({
		id: "maintenance.arbitrum-core-upgrade",
		version: 1,
		category: "maintenance",
		risk: "transaction",
		title: "Arbitrum Vibe Core upgrade — current contracts, preserve existing layers",
		description:
			"Rehearse, deploy and publish every Core facet; pause through the Dev Safe, bind a fresh storage/funding snapshot, rehearse the exact atomic Safe batch, verify execution and restore service.",
		supportedNetworks: ["arbitrum"],
		inputs: [
			{ id: "network", label: "Network", type: "network", required: true },
			{ id: "config", label: "Credential recipe", type: "recipe", required: true },
			{ id: "input", label: "Upgrade input", type: "string", required: true },
			{ id: "output", label: "Upgrade report", type: "string", required: true },
		],
		artifacts: [
			"source-bound input and report",
			"initial and paused snapshots",
			"deployment journal and runtime/publication evidence",
			"core-abi.json",
			"two fork rehearsals",
			"atomic Safe batches and verified execution receipts",
		],
		signerPolicy: {
			role: "Core deployment signer",
			allowedModes: EOA_SIGNER_MODES.filter(m => m !== SIGNER_MODES.LOCAL_NODE),
			initialMode: SIGNER_MODES.KEYSTORE,
		},
		prepare,
		plan: () => CORE_UPGRADE_PLAN.map(step => ({ ...step })),
		validateResume: validateCoreTaskInput,
		reconcile,
		run: async (ctx, input) => {
			validateCoreTaskInput(ctx, input);
			const step = (id, fn) => ctx.step(id, CORE_UPGRADE_PLAN.find(s => s.id === id).title, fn);
			const rehearse = async phase => {
				const block = read(input.output)[phase === "rehearse-initial" ? "initial" : "paused"].blockNumber;
				return runPhase(ctx, input, phase, {
					fork: true,
					env: {
						FORK_BLOCK_NUMBER: String(block),
						SYMMIO_SIGNER_MODE: "local-node",
						SYMMIO_EXPECTED_SIGNER: "",
						SYMMIO_RECIPE_READ_ONLY: "false",
					},
				});
			};
			await step("compile", () =>
				ctx.runProcess("npm", ["run", "compile"], {
					env: coreUpgradeEnvironment(input, { SYMMIO_RECIPE_READ_ONLY: "true", SYMMIO_SIGNER_MODE: "safe-file" }),
				}),
			);
			await step("inspect", () => runPhase(ctx, input, "inspect"));
			await step("rehearse-initial", () => rehearse("rehearse-initial"));
			await step("authorize", async () => {
				ctx.ui.note(
					`Source ${input.sourceCommit}\nReview ${input.output}. This deploys all current Core libraries and facets; governance actions are exported for the Dev Safe.`,
					"Deployment authorization",
				);
				const confirmation = await ctx.ui.text({ message: "Type 42161 to authorize Core contract deployments", initialValue: "" });
				if (confirmation !== "42161") ctx.wait("Core deployments await explicit Arbitrum authorization.");
			});
			await step("deploy", () => runPhase(ctx, input, "deploy", { env: { SYMMIO_CORE_UPGRADE_EXECUTE: "true", CONFIRM_CHAIN_ID: "42161" } }));
			await step("publish", () => runPhase(ctx, input, "publish"));
			await step("client-ready", async () => {
				ctx.ui.note(
					`${path.join(path.dirname(input.output), "core-abi.json")}\n${read(input.output).client.changes.join("\n")}`,
					"Integration changes",
				);
				if (
					!(await ctx.ui.confirm({
						message:
							"Have client/indexer ABI updates, operator roles and the displayed pledge token policy been reviewed for this cutover?",
						initialValue: false,
					}))
				)
					ctx.wait("Prepare the ABI consumers and review operator role changes before pausing Core.");
			});
			await step("pause", () => deliverCoreBatch(ctx, input, "pause"));
			await step("plan-cut", () => runPhase(ctx, input, "plan-cut"));
			await step("rehearse-cut", () => rehearse("rehearse-cut"));
			await step("cut", () => deliverCoreBatch(ctx, input, "cut"));
			await step("service-ready", async () => {
				const report = read(input.output);
				ctx.ui.note(
					`Verified cut: ${JSON.stringify(report.verifiedCut)}\nCheck frontend/backend reads, liquidator queries and indexer consumption using the supplied Core ABI.`,
					"Service verification",
				);
				if (
					!(await ctx.ui.confirm({
						message: "Have application reads and indexer consumption of the executed cut passed?",
						initialValue: false,
					}))
				)
					ctx.wait("Core stays paused until application and indexer checks pass.");
				ctx.state.coreServiceReadiness = { verifiedCutDigest: ctx.state.coreEvidence.verifiedCut, confirmedAt: new Date().toISOString() };
			});
			await step("unpause", () => deliverCoreBatch(ctx, input, "unpause"));
			ctx.ui.note(`Core upgrade verified. Report: ${input.output}`, "Complete");
		},
	});
}
