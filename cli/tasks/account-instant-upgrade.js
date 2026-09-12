import { UPGRADE_DEPLOYMENTS, digest, validateUpgradeConfig } from "../../deployment-tooling/account-instant-upgrade.js";
import { loadRecipeContext, recipeHardhatEnvironment } from "../lib/recipe-context.js";
import { EOA_SIGNER_MODES, SIGNER_MODES, dispatchSafeActions, validateSignerSelection } from "../signer/index.js";
import { atomicWrite } from "./guided-recipe.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ACCOUNT_INSTANT_PLAN = Object.freeze([
	{ id: "compile", phase: "prepare", title: "Compile the reviewed upgrade contracts" },
	{ id: "inspect", phase: "prepare", title: "Read current values and the supplied flow permissions" },
	{ id: "rehearse", phase: "rehearsal", title: "Rehearse the full upgrade on the exact snapshot fork" },
	{ id: "authorize", phase: "authorization", title: "Review current values and authorize the upgrade" },
	{
		id: "deploy",
		phase: "deployment",
		title: "Deploy the AccountLayer library and five facets, InstantLayer, five Gasless libraries and implementation",
		items: UPGRADE_DEPLOYMENTS.map(name => name.toLowerCase()),
	},
	{ id: "publish", phase: "publication", title: "Publish all thirteen contracts on Arbiscan" },
	{ id: "account-cut", phase: "execution", title: "Export the AccountLayer cut for the Safe" },
	{ id: "verify-account-cut", phase: "verification", title: "Verify the installed AccountLayer selectors" },
	{ id: "configure-instant", phase: "execution", title: "Export current InstantLayer values and flow grants for the Safe" },
	{ id: "verify-instant", phase: "verification", title: "Compare all replacement InstantLayer settings with the snapshot" },
	{ id: "party-b", phase: "execution", title: "Export PartyB manager, trust and whitelist wiring for the Safe" },
	{ id: "client-ready", phase: "verification", title: "Prepare relayer and event consumers for the indexed-wallet cutover" },
	{ id: "wire", phase: "execution", title: "Export protocol grants and the existing Gasless proxy upgrade for the Safe" },
	{ id: "verify-wire", phase: "verification", title: "Verify wiring and preservation of all Gasless settings" },
	{ id: "canary", phase: "canary", title: "Verify a successful relay using the new InstantLayer" },
	{ id: "retire", phase: "execution", title: "Export removal of old InstantLayer protocol roles for the Safe" },
	{ id: "retire-party-b", phase: "execution", title: "Export old InstantLayer PartyB trust removal for the Safe" },
	{ id: "verify-final", phase: "verification", title: "Verify the complete upgrade and preserved current values" },
]);
const CONFIG_PATH = "tasks/config/arbitrum-account-instant-upgrade-42161.json";
const RECIPE_PATH = "deployment-recipes/arbitrum-vibe-production.json";
const ADAPTER = "internal:account-instant-upgrade";
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const clientHandoffPath = input => path.join(path.dirname(input.output), "client-upgrade.json");
const configurationPath = input => path.join(path.dirname(input.output), "configuration-input.json");

export function validateAccountInstantInput(input) {
	if (input.network !== "arbitrum" || input.chainId !== 42161 || input.mode !== "live")
		throw new Error("Upgrade requires live Arbitrum chain 42161");
	const standard = read(input.input);
	validateUpgradeConfig(standard.config);
	if (digest(standard) !== input.inputDigest || standard.sourceCommit !== input.sourceCommit)
		throw new Error("Upgrade input/source binding changed");
	if (loadRecipeContext(input.config, { plan: false }).digest !== standard.recipeDigest) throw new Error("Upgrade credential recipe changed");
	if (loadRecipeContext(input.forkConfig, { plan: false }).digest !== standard.forkRecipeDigest) throw new Error("Upgrade fork recipe changed");
	const signer = validateSignerSelection(input.signer, { allowSafe: false });
	if (signer.mode === SIGNER_MODES.LOCAL_NODE) throw new Error("Live deployment requires an EOA wallet signer");
	return standard;
}

function readReport(input) {
	const report = read(input.output);
	if (report.inputDigest !== input.inputDigest) throw new Error("Upgrade report binding changed");
	return report;
}

export function reviewedConfiguration(ctx, input) {
	const report = readReport(input);
	const snapshot = read(configurationPath(input));
	if (
		!ctx.state.configurationDigest ||
		digest(snapshot) !== ctx.state.configurationDigest ||
		report.snapshotDigest !== ctx.state.configurationDigest
	)
		throw new Error("Reviewed configuration input changed; resume cannot accept different current values");
	return snapshot;
}

export function accountInstantEnvironment(input, extra = {}, fork = false) {
	return {
		...recipeHardhatEnvironment(loadRecipeContext(fork ? input.forkConfig : input.config, { plan: false })),
		SYMMIO_ACCOUNT_UPGRADE_INPUT: input.inputDigest,
		SYMMIO_ACCOUNT_UPGRADE_EXECUTE: "false",
		CONFIRM_CHAIN_ID: "",
		DEPLOY_CONFIRMATIONS: "1",
		DEPLOY_TX_TIMEOUT: "300",
		...extra,
	};
}

async function runPhase(ctx, input, phase, { env = {}, fork = false } = {}) {
	if (phase !== "inspect") reviewedConfiguration(ctx, input);
	await ctx.runProcess(
		"./node_modules/.bin/hardhat",
		[ADAPTER, "--phase", phase, "--input", input.input, "--output", input.output, "--network", fork ? "fork-arbitrum" : "arbitrum"],
		{
			env: accountInstantEnvironment(input, { SYMMIO_ACCOUNT_UPGRADE_SNAPSHOT: ctx.state.configurationDigest || "", ...env }, fork),
		},
	);
	return readReport(input);
}
const executeEnvironment = { SYMMIO_ACCOUNT_UPGRADE_EXECUTE: "true", CONFIRM_CHAIN_ID: "42161" };

export async function dispatchAccountInstantSafe(ctx, input, phase, label) {
	const report = await runPhase(ctx, input, phase, {
		env: { SYMMIO_RECIPE_READ_ONLY: "true", SYMMIO_SIGNER_MODE: "safe-file" },
	});
	if (!Array.isArray(report.actions)) throw new Error("Upgrade action plan is missing");
	if (!report.actions.length) return;
	const safe = read(input.input).config.target.safe.toLowerCase();
	if (report.actions.some(action => action.authority !== safe)) throw new Error("Action requires a different administrator than the protocol Safe");
	ctx.ui.note(report.actions.map(a => `${a.to}: ${a.description}\nvalue=${a.value}\n${a.data}`).join("\n\n"), label);
	const delivery = await dispatchSafeActions(ctx, { mode: SIGNER_MODES.SAFE_FILE, safeAddress: safe }, report.actions, {
		root: ctx.root,
		chainId: 42161,
		network: "arbitrum",
		name: label,
		description: `Configuration-preserving upgrade ${input.inputDigest}`,
		stateKey: phase,
		processEnv: accountInstantEnvironment(input),
	});
	ctx.wait(`Execute ${delivery.builderPath} through Safe ${safe}, then continue this task. Continuation checks the on-chain result.`);
}

function verifyClientHandoff(ctx, input) {
	if (
		ctx.state.clientHandoffDigest &&
		(digest(read(clientHandoffPath(input))) !== ctx.state.clientHandoffDigest ||
			readReport(input).clientHandoffDigest !== ctx.state.clientHandoffDigest)
	)
		throw new Error("Reviewed client handoff changed");
}

async function prepareUpgrade({ root, ui }) {
	const config = validateUpgradeConfig(read(path.join(root, CONFIG_PATH)));
	const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }).trim();
	if (dirty) throw new Error("Commit tracked changes before binding the upgrade to its source commit");
	const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	const recipe = loadRecipeContext(path.join(root, RECIPE_PATH), { plan: false });
	if (recipe.recipe.network.name !== "arbitrum" || recipe.recipe.network.chainId !== 42161 || recipe.recipe.network.mode !== "live")
		throw new Error("The credential recipe must select live Arbitrum chain 42161");
	const directory = path.join(root, "tasks/data/42161/account-instant-upgrades", randomUUID());
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const forkConfig = path.join(directory, "fork-recipe.json");
	atomicWrite(forkConfig, { ...recipe.recipe, network: { ...recipe.recipe.network, name: "fork-arbitrum", mode: "fork" } });
	const forkRecipe = loadRecipeContext(forkConfig, { plan: false });
	const standard = {
		apiVersion: "operations.symm.io/account-instant-run-v1",
		sourceCommit,
		config,
		recipeDigest: recipe.digest,
		forkRecipeDigest: forkRecipe.digest,
		runNonce: path.basename(directory),
	};
	const input = path.join(directory, "input.json"),
		output = path.join(directory, "report.json"),
		inputDigest = digest(standard);
	atomicWrite(input, standard);
	atomicWrite(output, { inputDigest, transactions: [] });
	ui.note(
		`AccountLayer: ${config.target.accountLayer}\nCurrent InstantLayer: ${config.target.instantLayer}\nPreserved Gasless proxy: ${config.target.gaslessLayer}\nSafe: ${config.target.safe}\nInput: ${input}\nThe task reads current values and rehearses before asking to deploy.`,
		"Arbitrum AccountLayer and InstantLayer upgrade",
	);
	return { network: "arbitrum", chainId: 42161, mode: "live", config: recipe.path, forkConfig, input, output, inputDigest, sourceCommit };
}

export async function reconcileAccountInstantUpgrade(ctx, input) {
	const unresolved = () =>
		(ctx.state.transactions || []).filter(tx => ["submitted", "unresolved", "timed_out"].includes(tx.status)).map(tx => tx.hash);
	if (!unresolved().length) return { unresolved: [] };
	try {
		await runPhase(ctx, input, "reconcile", {
			env: {
				SYMMIO_RECIPE_READ_ONLY: "true",
				SYMMIO_SIGNER_MODE: "safe-file",
				SYMMIO_ACCOUNT_UPGRADE_TRANSACTIONS: JSON.stringify(ctx.state.transactions),
			},
		});
	} finally {
		const report = readReport(input);
		for (const tx of ctx.state.transactions) {
			const matched = report.transactions?.find(record => record.hash === tx.hash || record.originalHash === tx.hash);
			if (matched) Object.assign(tx, matched);
		}
	}
	return { unresolved: unresolved() };
}

export function createAccountInstantUpgradeTask(common) {
	return common({
		id: "maintenance.arbitrum-account-instant-upgrade",
		version: 7,
		category: "maintenance",
		risk: "transaction",
		title: "Arbitrum AccountLayer and InstantLayer upgrade — preserve current values",
		description:
			"Deploy the new contracts first, cut AccountLayer, reproduce InstantLayer configuration, and upgrade the existing Gasless proxy with verified storage preservation.",
		supportedNetworks: ["arbitrum"],
		inputs: [
			{ id: "network", label: "Network", type: "network", required: true },
			{ id: "config", label: "Credential recipe", type: "recipe", required: true },
			{ id: "input", label: "Upgrade input", type: "string", required: true },
			{ id: "output", label: "Upgrade report", type: "string", required: true },
		],
		artifacts: [
			"pinned configuration-input.json",
			"fork rehearsal evidence",
			"thirteen contract deployments and publication evidence",
			"transaction journal",
			"Safe batches",
			"client-upgrade.json with deployed addresses and indexed-wallet ABIs",
			"verified final report",
		],
		signerPolicy: {
			role: "Contract deployment signer",
			allowedModes: EOA_SIGNER_MODES.filter(mode => mode !== SIGNER_MODES.LOCAL_NODE),
			initialMode: SIGNER_MODES.KEYSTORE,
		},
		prepare: prepareUpgrade,
		plan: () => ACCOUNT_INSTANT_PLAN.map(step => ({ ...step, ...(step.items ? { items: [...step.items] } : {}) })),
		validateResume: (ctx, input) => {
			validateAccountInstantInput(input);
			if (ctx.state.configurationDigest) reviewedConfiguration(ctx, input);
			verifyClientHandoff(ctx, input);
		},
		reconcile: reconcileAccountInstantUpgrade,
		run: async (ctx, input) => {
			validateAccountInstantInput(input);
			if (ctx.state.configurationDigest) reviewedConfiguration(ctx, input);
			verifyClientHandoff(ctx, input);
			const step = (id, fn) => ctx.step(id, ACCOUNT_INSTANT_PLAN.find(s => s.id === id).title, fn);
			await step("compile", () =>
				ctx.runProcess("npm", ["run", "compile"], {
					env: accountInstantEnvironment(input, { SYMMIO_RECIPE_READ_ONLY: "true", SYMMIO_SIGNER_MODE: "safe-file" }),
				}),
			);
			await step("inspect", async () => {
				const report = await runPhase(ctx, input, "inspect", { env: { SYMMIO_RECIPE_READ_ONLY: "true", SYMMIO_SIGNER_MODE: "safe-file" } });
				if (!report.snapshotDigest || digest(read(configurationPath(input))) !== report.snapshotDigest)
					throw new Error("Inspection did not bind the configuration input");
				ctx.state.configurationDigest = report.snapshotDigest;
				ctx.emit("upgrade.configuration-bound", { digest: report.snapshotDigest, blockNumber: report.snapshotBlock });
			});
			await step("rehearse", async () => {
				const snapshot = reviewedConfiguration(ctx, input);
				const report = await runPhase(ctx, input, "rehearse", {
					fork: true,
					env: {
						FORK_BLOCK_NUMBER: String(snapshot.blockNumber),
						SYMMIO_SIGNER_MODE: "local-node",
						SYMMIO_EXPECTED_SIGNER: "",
						SYMMIO_RECIPE_READ_ONLY: "false",
					},
				});
				if (report.rehearsal?.status !== "complete" || report.rehearsal.snapshotDigest !== ctx.state.configurationDigest)
					throw new Error("Matching fork rehearsal is incomplete");
			});
			await step("authorize", async () => {
				const snapshot = reviewedConfiguration(ctx, input);
				ctx.ui.note(
					JSON.stringify(
						{
							blockNumber: snapshot.blockNumber,
							gasless: snapshot.gasless,
							instant: snapshot.instant,
							partyBAdmins: snapshot.partyBAdmins,
						},
						null,
						2,
					),
					"Current on-chain values to preserve (integer values use contract units)",
				);
				ctx.ui.note(
					`Snapshot: ${configurationPath(input)}\nGasless proxy/storage remain in place. InstantLayer user delegations/replay state are not migrated. No global or per-account timelock setters are called. PartyB wiring is exported for the Dev Safe, including MANAGER_ROLE when needed; Gasless cutover waits for its on-chain verification.`,
					"Upgrade scope",
				);
				const confirmation = await ctx.ui.text({
					message: "Type 42161 to authorize the thirteen deployments and subsequent upgrade stages",
					validate: value => (value === "42161" ? undefined : "Type exactly 42161"),
				});
				if (confirmation === null) {
					ctx.requestPause();
					ctx.checkpoint();
					return;
				}
				if (confirmation !== "42161") throw new Error("Arbitrum authorization was not provided");
			});
			await step("deploy", () => runPhase(ctx, input, "deploy", { env: executeEnvironment }));
			await step("publish", () => runPhase(ctx, input, "publish"));
			await step("account-cut", () => dispatchAccountInstantSafe(ctx, input, "plan-account-cut", "AccountLayer cut"));
			await step("verify-account-cut", () => runPhase(ctx, input, "verify-account-cut"));
			await step("configure-instant", () =>
				dispatchAccountInstantSafe(ctx, input, "plan-configure-instant", "InstantLayer configuration and flow grants"),
			);
			await step("verify-instant", () => runPhase(ctx, input, "verify-instant"));
			await step("party-b", () => dispatchAccountInstantSafe(ctx, input, "plan-party-b", "PartyB manager, trust and whitelist wiring"));
			await step("client-ready", async () => {
				const report = await runPhase(ctx, input, "client-handoff");
				const handoff = read(clientHandoffPath(input));
				if (!report.clientHandoffDigest || digest(handoff) !== report.clientHandoffDigest)
					throw new Error("Client handoff is not bound to the report");
				ctx.ui.note(
					`${clientHandoffPath(input)}\nNew InstantLayer: ${handoff.instantLayer}\n${handoff.instructions.join("\n")}`,
					"Relayer and event consumer cutover",
				);
				const ready = await ctx.ui.confirm({
					message:
						"Are relayer/client ABI, signing-domain, fee-quote/limit and event-consumer changes staged for activation with the Gasless Safe upgrade?",
					initialValue: false,
				});
				if (!ready)
					ctx.wait(
						`Prepare the relayer and event consumers using ${clientHandoffPath(input)}, then continue before exporting the Gasless upgrade.`,
					);
				ctx.state.clientHandoffDigest = report.clientHandoffDigest;
				ctx.emit("upgrade.clients-ready", { digest: report.clientHandoffDigest });
			});
			await step("wire", () => dispatchAccountInstantSafe(ctx, input, "plan-wire", "Protocol wiring and existing Gasless proxy upgrade"));
			await step("verify-wire", () => runPhase(ctx, input, "verify-wire"));
			await step("canary", async () => {
				const hash =
					readReport(input).canary?.hash ||
					(await ctx.ui.text({
						message: "Successful transaction hash for a Gasless relay using the new InstantLayer (leave empty to wait)",
						validate: value => (!value || /^0x[0-9a-fA-F]{64}$/.test(value) ? undefined : "Enter a transaction hash"),
					}));
				if (!hash)
					ctx.wait(
						`Update the relayer to use the replacement InstantLayer, execute a real delegation grant or ordered-nonce operation through ${read(input.input).config.target.gaslessLayer}, then continue with its transaction hash.`,
					);
				await runPhase(ctx, input, "canary", { env: { SYMMIO_ACCOUNT_UPGRADE_CANARY: hash } });
			});
			await step("retire", () => dispatchAccountInstantSafe(ctx, input, "plan-retire", "Retire old InstantLayer protocol roles"));
			await step("retire-party-b", () => dispatchAccountInstantSafe(ctx, input, "plan-retire-party-b", "Retire old InstantLayer PartyB trust"));
			return step("verify-final", async () => {
				const report = await runPhase(ctx, input, "verify-final");
				if (report.status !== "complete") throw new Error("Final on-chain verification is incomplete");
				return { output: input.output, configuration: configurationPath(input), verifiedBlock: report.verifiedBlock };
			});
		},
	});
}
