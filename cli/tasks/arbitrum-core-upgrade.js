import {
	CORE_UPGRADE_API,
	CORE_UPGRADE_CONFIG,
	CORE_UPGRADE_RECIPE,
	assertCoreEvidence,
	digest,
	validateCoreUpgradeConfig,
} from "../../deployment-tooling/arbitrum-core-upgrade.js";
import { assertCoreUpgradeSourceBinding } from "../../deployment-tooling/core-upgrade-binding.js";
import {
	isStandardCoreInput,
	coreUpgradeNetwork,
	coreUpgradeAuthority,
	coreGovernanceKind,
	coreUpgradePolicyReview,
	coreUpgradeRoleGrantReview,
	coreUpgradeInputReview,
} from "../../deployment-tooling/core-upgrade-input.js";
import { loadRecipeContext, recipeHardhatEnvironment } from "../lib/recipe-context.js";
import { EOA_SIGNER_MODES, SIGNER_MODES, dispatchSafeActions, validateSignerSelection, hydrateSigner, signerEnvironment } from "../signer/index.js";
import { atomicWrite } from "./guided-recipe.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CORE_UPGRADE_PLAN = Object.freeze([
	{ id: "compile", phase: "prepare", title: "Compile the current Core release and enforce the size budget" },
	{ id: "inspect", phase: "prepare", title: "Inspect the supplied deployment, storage and funding" },
	{ id: "authorize", phase: "authorization", title: "Review and authorize the Core deployments" },
	{ id: "deploy", phase: "deployment", title: "Deploy all Core libraries and facets with recovery checkpoints" },
	{ id: "client-ready", phase: "verification", title: "Confirm consumer ABI and operator role readiness" },
	{ id: "pause", phase: "execution", title: "Export and verify the Safe maintenance pause" },
	{ id: "plan-cut", phase: "prepare", title: "Bind the paused state and atomic Core upgrade batch" },
	{ id: "cut", phase: "execution", title: "Export the atomic Core upgrade and verify its Safe receipt" },
	{ id: "service-ready", phase: "verification", title: "Confirm application and indexer checks before restoring service" },
	{ id: "muon-ready", phase: "verification", title: "Verify Muon registration, permissions and fresh routed canaries" },
	{ id: "unpause", phase: "execution", title: "Restore the original pause state after verification" },
	{ id: "publish", phase: "publication", title: "Publish verified implementations, facets and libraries on the explorer" },
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
	"verify-muon": ["muonReadiness"],
	"plan-unpause": ["unpauseBatch"],
	"verify-unpause": ["restoredService"],
};

export function validateCoreTaskInput(ctx, input) {
	const standard = read(input.input);
	assertCoreUpgradeSourceBinding(ctx.root, standard);
	const network = coreUpgradeNetwork(standard.config);
	if (input.network !== network.name || input.chainId !== network.chainId || input.mode !== "live")
		throw new Error("Core upgrade network differs from the input");
	validateCoreUpgradeConfig(standard.config);
	if (
		standard.apiVersion !== (isStandardCoreInput(standard.config) ? "operations.symm.io/core-upgrade-run-v1" : CORE_UPGRADE_API) ||
		digest(standard) !== input.inputDigest ||
		standard.sourceCommit !== input.sourceCommit
	)
		throw new Error("Core upgrade input/source changed");
	if (
		loadRecipeContext(input.config, { plan: false }).digest !== standard.recipeDigest ||
		loadRecipeContext(input.forkConfig, { plan: false }).digest !== standard.forkRecipeDigest
	)
		throw new Error("Upgrade credential recipe changed");
	const signer = validateSignerSelection(input.signer, { allowSafe: false });
	if (
		isStandardCoreInput(standard.config) &&
		(signer.mode !== SIGNER_MODES.KEYSTORE || signer.key !== standard.config.credentials.deployer.split("://")[1])
	)
		throw new Error("Deployment signer differs from the standard input");
	if (signer.mode === SIGNER_MODES.LOCAL_NODE) throw new Error("Live deployments require an EOA signer");
	const report = read(input.output);
	if (report.inputDigest !== input.inputDigest) throw new Error("Core report/input mismatch");
	if (ctx.state.corePublicationProgressDigest && digest(report.publicationProgress) !== ctx.state.corePublicationProgressDigest)
		throw new Error("Explorer publication checkpoints changed");
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
		DEPLOY_CONFIRMATIONS: String(read(input.input).config.execution?.confirmations || 1),
		DEPLOY_TX_TIMEOUT: String(read(input.input).config.execution?.txTimeoutSeconds || 300),
		DEPLOY_SLOW_TX_NOTICE: String(read(input.input).config.execution?.slowNoticeSeconds || 30),
		...extra,
	};
}

export async function runCoreUpgradePhase(ctx, input, phase, { fork = false, env = {} } = {}) {
	validateCoreTaskInput(ctx, input);
	try {
		await ctx.runProcess(
			"./node_modules/.bin/hardhat",
			[
				isStandardCoreInput(read(input.input).config) ? "internal:core-upgrade" : "internal:arbitrum-core-upgrade",
				"--phase",
				phase,
				"--input",
				input.input,
				"--output",
				input.output,
				"--network",
				fork ? coreUpgradeNetwork(read(input.input).config).fork : input.network,
			],
			{
				env: coreUpgradeEnvironment(
					input,
					{
						...(!["deploy", "execute-governance"].includes(phase)
							? { SYMMIO_RECIPE_READ_ONLY: phase === "publish" ? "false" : "true", SYMMIO_SIGNER_MODE: "safe-file" }
							: {}),
						SYMMIO_CORE_UPGRADE_EVIDENCE: JSON.stringify(ctx.state.coreEvidence || {}),
						...env,
					},
					fork,
				),
			},
		);
	} finally {
		if (phase === "publish") {
			const progress = read(input.output).publicationProgress;
			if (progress) ctx.state.corePublicationProgressDigest = digest(progress);
		}
	}
	const report = read(input.output);
	ctx.state.coreEvidence ||= {};
	for (const field of BINDINGS[phase] || []) {
		if (!report[field]) throw new Error(`Missing ${field} evidence after ${phase}`);
		const hash = digest(report[field]);
		if (ctx.state.coreEvidence[field] && ctx.state.coreEvidence[field] !== hash && phase !== "verify-muon")
			throw new Error(`Bound ${field} changed`);
		ctx.state.coreEvidence[field] = hash;
	}
	ctx.emit("upgrade.core-evidence", { phase, bindings: ctx.state.coreEvidence });
	return report;
}

const runPhase = runCoreUpgradePhase;

export async function rehearseCoreUpgrade(ctx, input, phase = "rehearse-initial") {
	if (!["rehearse-initial", "rehearse-cut"].includes(phase)) throw new Error("Unknown Core rehearsal phase");
	const snapshot = read(input.output)[phase === "rehearse-initial" ? "initial" : "paused"];
	if (!snapshot) throw new Error("Inspect the deployment before rehearsal");
	return runPhase(ctx, input, phase, {
		fork: true,
		env: {
			FORK_BLOCK_NUMBER: String(snapshot.blockNumber),
			SYMMIO_SIGNER_MODE: "local-node",
			SYMMIO_EXPECTED_SIGNER: "",
			SYMMIO_RECIPE_READ_ONLY: "false",
		},
	});
}

export async function deliverCoreBatch(ctx, input, key) {
	const field = key === "cut" ? "batch" : `${key}Batch`,
		standard = validateCoreTaskInput(ctx, input);
	let report = read(input.output);
	if (
		key === "unpause" &&
		!ctx.state.safeDispatches?.unpause &&
		!report.governanceExecutions?.unpause?.transactions?.length &&
		!report.unpauseReceipt
	)
		report = await runPhase(ctx, input, "verify-muon", { env: { SYMMIO_MUON_READY_INPUT: ctx.state.coreMuonReadinessFile || "" } });
	if (key !== "cut" && !report[field]) report = await runPhase(ctx, input, `plan-${key}`);
	const batch = report[field];
	if (!batch) throw new Error("Missing reviewed governance batch");
	if (batch.alreadyPaused) {
		await runPhase(ctx, input, `verify-${key}`);
		return;
	}
	if (coreGovernanceKind(standard.config) === "eoa") {
		await deliverCoreEoaBatch(ctx, input, key, batch);
		return;
	}
	if (!ctx.state.safeDispatches?.[key]) {
		await runPhase(ctx, input, "check-export", { env: { SYMMIO_CORE_UPGRADE_BATCH: key } });
		ctx.ui.note(batch.actions.map(a => `${a.description}\n${a.to} · value ${a.value}\n${a.data}`).join("\n\n"), `Review ${key} Safe batch`);
		const approved = await ctx.ui.confirm({
			message: `Export this ${key} batch for Safe ${coreUpgradeAuthority(standard.config)}?`,
			initialValue: false,
		});
		if (!approved) ctx.wait(`Review the ${key} batch and continue when ready to export it.`);
		const delivery = await dispatchSafeActions(
			ctx,
			{ mode: SIGNER_MODES.SAFE_FILE, safeAddress: coreUpgradeAuthority(standard.config) },
			batch.actions,
			{
				root: ctx.root,
				chainId: input.chainId,
				network: input.network,
				name: `Core upgrade ${key}`,
				description: `Core upgrade ${input.inputDigest}; execute together as one Safe transaction. Expected Safe hash ${batch.envelope.safeTxHash}`,
				stateKey: key,
			},
		);
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

export async function deliverCoreEoaBatch(ctx, input, key, batch) {
	const standard = validateCoreTaskInput(ctx, input),
		governance = standard.config.governance;
	let report = read(input.output);
	if (!report.governanceExecutions?.[key]?.receipts) {
		if (!report.governanceExecutions?.[key]?.transactions?.length)
			await runPhase(ctx, input, "check-export", { env: { SYMMIO_CORE_UPGRADE_BATCH: key } });
		ctx.ui.note(
			batch.actions.map(a => `${a.description}\n${a.to} · value ${a.value}\n${a.data}`).join("\n\n"),
			`Review ${key} governance actions`,
		);
		const stateKey = "core-governance";
		let selection = ctx.getSigner(stateKey);
		if (!selection) {
			selection = {
				mode: governance.signerMode,
				address: governance.owner,
				...(governance.signerKey ? { key: governance.signerKey } : {}),
				...(governance.ledgerDerivation ? { derivation: governance.ledgerDerivation } : {}),
			};
			selection = ctx.bindSigner(stateKey, selection);
		}
		if (
			selection.mode !== governance.signerMode ||
			selection.address.toLowerCase() !== governance.owner.toLowerCase() ||
			selection.key !== governance.signerKey ||
			selection.derivation !== governance.ledgerDerivation
		)
			throw new Error("Governance signer differs from the standard input");
		selection = await hydrateSigner(selection, ctx.ui);
		if (!selection) return ctx.wait("The Core owner signer is unavailable.");
		if (!(await ctx.ui.confirm({ message: `Execute the reviewed ${key} actions using ${governance.owner}?`, initialValue: false })))
			return ctx.wait(`The ${key} actions await owner confirmation.`);
		await runPhase(ctx, input, "execute-governance", {
			env: {
				...signerEnvironment(selection),
				SYMMIO_CORE_UPGRADE_EXECUTE: "true",
				CONFIRM_CHAIN_ID: String(input.chainId),
				SYMMIO_RECIPE_READ_ONLY: "false",
				SYMMIO_CORE_UPGRADE_BATCH: key,
			},
		});
		report = read(input.output);
	}
	const hash = report.governanceExecutions[key].receipts;
	await runPhase(ctx, input, `verify-${key}`, { env: { SYMMIO_CORE_UPGRADE_RECEIPT: hash } });
	ctx.state.coreReceipts ||= {};
	ctx.state.coreReceipts[key] = hash;
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
		`Core: ${config.target.core}\nSafe: ${config.target.safe}\nSource: ${sourceCommit}\nReport: ${output}\nFork rehearsal is optional and separate. The task upgrades Core and preserves the current Account, Instant and Gasless layers.`,
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

export function createArbitrumCoreUpgradeTask(common, overrides = {}) {
	const upgradePlan = overrides.upgradePlan || CORE_UPGRADE_PLAN;
	const { upgradePlan: _plan, ...taskOverrides } = overrides;
	return common({
		id: "maintenance.arbitrum-core-upgrade",
		version: 4,
		category: "maintenance",
		risk: "transaction",
		title: "Arbitrum Vibe Core upgrade — current contracts, preserve existing layers",
		description:
			"Deploy every Core facet, bind paused state, execute the reviewed upgrade, verify and restore service, then publish source on the explorer. Fork rehearsal is separate and optional.",
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
			"optional separate fork rehearsal",
			"atomic Safe batches and verified execution receipts",
			"muon-readiness-request.json and pinned routed simulations",
		],
		signerPolicy: {
			role: "Core deployment signer",
			allowedModes: EOA_SIGNER_MODES.filter(m => m !== SIGNER_MODES.LOCAL_NODE),
			initialMode: SIGNER_MODES.KEYSTORE,
		},
		prepare,
		plan: () => upgradePlan.map(step => ({ ...step })),
		validateResume: validateCoreTaskInput,
		reconcile,
		run: async (ctx, input) => {
			validateCoreTaskInput(ctx, input);
			const step = (id, fn) => ctx.step(id, upgradePlan.find(s => s.id === id).title, fn);
			await step("compile", () =>
				ctx.runProcess("npm", ["run", "compile"], {
					env: coreUpgradeEnvironment(input, { SYMMIO_RECIPE_READ_ONLY: "true", SYMMIO_SIGNER_MODE: "safe-file" }),
				}),
			);
			await step("inspect", () => runPhase(ctx, input, "inspect"));
			await step("authorize", async () => {
				ctx.ui.note(
					`Source ${input.sourceCommit}\n${coreUpgradeInputReview(read(input.input).config)}\n${coreUpgradePolicyReview(read(input.input).config)}\n${coreUpgradeRoleGrantReview(read(input.input).config)}\nReview ${input.output}. This deploys all current Core libraries and facets; governance actions use the owner configured in the input.`,
					"Deployment authorization",
				);
				const confirmation = await ctx.ui.text({ message: `Type ${input.chainId} to authorize Core contract deployments`, initialValue: "" });
				if (confirmation !== String(input.chainId)) ctx.wait("Core deployments await explicit chain authorization.");
			});
			await step("deploy", () =>
				runPhase(ctx, input, "deploy", { env: { SYMMIO_CORE_UPGRADE_EXECUTE: "true", CONFIRM_CHAIN_ID: String(input.chainId) } }),
			);
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
			await step("muon-ready", async () => {
				ctx.ui.note(
					`Fill ${path.join(path.dirname(input.output), "muon-readiness-request.json")} with service registration evidence and fresh positive/negative probes for InstantLayer, GaslessLayer, AccountLayer and PartyB.`,
					"Muon readiness",
				);
				const file = await ctx.ui.text({ message: "Muon readiness JSON path", initialValue: ctx.state.coreMuonReadinessFile || "" });
				if (!file) ctx.wait("Core stays paused until Muon readiness evidence is supplied.");
				ctx.state.coreMuonReadinessFile = path.resolve(ctx.root, file);
				await runPhase(ctx, input, "verify-muon", { env: { SYMMIO_MUON_READY_INPUT: ctx.state.coreMuonReadinessFile } });
			});
			await step("unpause", () => deliverCoreBatch(ctx, input, "unpause"));
			await step("publish", () => runPhase(ctx, input, "publish"));
			ctx.ui.note(`Core upgrade verified. Report: ${input.output}`, "Complete");
		},
		...taskOverrides,
	});
}
