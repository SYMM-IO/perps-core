import {
	CONFIG,
	TARGET,
	ROLE,
	SELECTOR,
	digest,
	sourceDigest,
	validateInput,
	requireTpmConfirmation,
} from "../../deployment-tooling/hyperevm-zero-recovery.js";
import { PROJECT_ROOT } from "../lib/paths.js";
import { EOA_SIGNER_MODES, SIGNER_MODES, dispatchSafeActions, hydrateSigner, selectSigner, signerEnvironment } from "../signer/index.js";
import { atomicWrite } from "./guided-recipe.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RECOVERY_PLAN = Object.freeze(
	[
		["compile", "prepare", "Compile the isolated Solidity 0.8.18 recovery facet"],
		["test", "verification", "Run the local recovery tests"],
		["inspect", "prepare", "Inspect Core, Safe and authorities"],
		["tpm", "authorization", "Record TPM confirmation of the exact recipient"],
		["rehearse", "verification", "Prove full-precision recovery and guards on a historical fork"],
		["authorize", "authorization", "Review and authorize the live operations"],
		["deploy", "deployment", "Deploy the recovery facet"],
		["publish", "publication", "Publish the facet on Hyperevmscan"],
		["cut", "execution", "Add the recovery selector using the Core owner"],
		["grant", "execution", "Grant the Safe a temporary recovery role if needed"],
		["recovery", "execution", "Export the Safe recovery and verify its receipt"],
		["cleanup", "execution", "Remove only the recovery role granted by this task"],
		["evidence", "verification", "Verify final balances and write the TPM / Leon handoff"],
		["handoff", "verification", "Record delivery of recovery evidence to the TPM"],
	].map(([id, phase, title]) => ({ id, phase, title })),
);

const readReport = input => {
	const report = JSON.parse(fs.readFileSync(input.output, "utf8"));
	if (report.inputDigest !== input.inputDigest) throw new Error("Recovery report input changed");
	return report;
};
const environment = input => ({
	SYMMIO_RECOVERY_RPC_KEY: input.rpcKey,
	SYMMIO_RECOVERY_ARCHIVE_KEY: input.archiveRpcKey || "",
	SYMMIO_RECOVERY_EXECUTE: "false",
	SYMMIO_SIGNER_MODE: "",
	SYMMIO_RECOVERY_FORK_BLOCK: "",
});
export async function runRecoveryPhase(ctx, input, phase, { selection, transaction = "" } = {}) {
	const env = environment(input);
	if (phase === "rehearse") env.SYMMIO_RECOVERY_FORK_BLOCK = String(readReport(input).archive.blockNumber);
	if (selection) {
		const hydrated = await hydrateSigner(selection, ctx.ui);
		if (!hydrated) return ctx.wait("Signer unavailable. Continue this task when it is ready.");
		Object.assign(env, signerEnvironment(hydrated), { SYMMIO_RECOVERY_EXECUTE: "true", CONFIRM_CHAIN_ID: "999" });
	}
	await ctx.runProcess(
		"./node_modules/.bin/hardhat",
		[
			"internal:hyperevm-zero-recovery",
			"--config",
			CONFIG,
			"--network",
			"hyperevm",
			"--phase",
			phase,
			"--input",
			input.input,
			"--output",
			input.output,
			...(transaction ? ["--transaction", transaction] : []),
		],
		{ env },
	);
	return readReport(input);
}
async function ownerSigner(ctx) {
	const existing = ctx.getSigner("governance");
	if (existing) return existing;
	const proceed = await ctx.ui.confirm({ message: `Continue with Core owner / role admin ${TARGET.owner}?`, initialValue: false });
	if (!proceed) return ctx.wait("Waiting for the Core owner. Continue active task when the owner is available.");
	const selection = await selectSigner(ctx.ui, {
		role: "Core owner / recovery role admin",
		allowedModes: EOA_SIGNER_MODES.filter(m => m !== SIGNER_MODES.LOCAL_NODE),
		initialMode: SIGNER_MODES.LEDGER,
		network: "hyperevm",
		chainId: 999,
		expectedAddress: TARGET.owner,
	});
	if (!selection) return ctx.wait("Core owner signer selection cancelled.");
	return ctx.bindSigner("governance", selection);
}
async function resumeHash(ctx, input, label) {
	const op = readReport(input).operations?.[label];
	if (!op || op.status === "confirmed") return "";
	const hash = await ctx.ui.text({
		message: `${label} was interrupted at nonce ${op.nonce}. Enter its original or replacement transaction hash (do not send it again).`,
		initialValue: op.hash || "",
		validate: value => (/^0x[0-9a-fA-F]{64}$/.test(value) ? undefined : "Enter the transaction hash"),
	});
	if (!hash) return ctx.wait("Resolve the interrupted transaction before continuing. No automatic resend is allowed.");
	return hash;
}
export function createHyperEvmZeroRecoveryTask(common) {
	return common({
		id: "maintenance.hyperevm-zero-balance-recovery",
		version: 2,
		category: "maintenance",
		risk: "transaction",
		title: "HyperEVM v0.8.5 / recover the zero-address balance",
		description:
			"Test the add-only upgrade locally, optionally rehearse a fork, deploy one facet, export the Safe sweep, and verify the TPM / Leon handoff.",
		supportedNetworks: ["hyperevm"],
		inputs: ["network", "input", "output", "inputDigest", "rpcKey", "archiveRpcKey"].map(id => ({
			id,
			label: id,
			type: "string",
			required: id !== "archiveRpcKey",
		})),
		artifacts: [
			"local test evidence; optional fork evidence",
			"deployment and governance receipts",
			"Safe Transaction Builder recovery JSON",
			"full-precision recovery evidence and TPM handoff",
		],
		signerPolicy: () => ({
			role: "Recovery facet deployment wallet",
			allowedModes: EOA_SIGNER_MODES.filter(m => m !== SIGNER_MODES.LOCAL_NODE),
			initialMode: SIGNER_MODES.KEYSTORE,
		}),
		prepare: async ({ ui, root = PROJECT_ROOT }) => {
			const forkEnabled = await ui.confirm({ message: "Run an optional HyperEVM fork rehearsal before deployment?", initialValue: false });
			if (forkEnabled === null) return null;
			const references = {};
			for (const [key, value, message] of [
				["rpcKey", "RPC_HYPEREVM", "HyperEVM RPC keystore key"],
				...(forkEnabled ? [["archiveRpcKey", "RPC_HYPEREVM_ARCHIVE", "Historical archive RPC keystore key (for the optional fork)"]] : []),
			]) {
				references[key] = await ui.text({
					message,
					initialValue: value,
					validate: v => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v || "") ? undefined : "Enter the keystore key name, not a URL"),
				});
				if (!references[key]) return null;
			}
			const standard = { schema: 1, target: TARGET, forkEnabled, ...references, sourceDigest: sourceDigest(root), runId: randomUUID() };
			const inputDigest = digest(standard),
				directory = path.join(root, "tasks", "data", "999", "zero-recovery", inputDigest);
			const input = path.join(directory, "input.json"),
				output = path.join(directory, "report.json");
			atomicWrite(input, standard);
			ui.note(
				`Core: ${TARGET.core}\nRecipient: ${TARGET.recipient}\nOwner / role admin: ${TARGET.owner}\nAll amounts use the internal 18-decimal balance. TPM confirmation is required before live operations. Fork rehearsal: ${forkEnabled ? "enabled (requires an archive RPC)" : "not requested"}.\nReports: ${directory}`,
			);
			return { network: "hyperevm", chainId: 999, mode: "live", forkEnabled, ...references, input, output, inputDigest };
		},
		plan: (_context, input = {}) => RECOVERY_PLAN.filter(s => s.id !== "rehearse" || input.forkEnabled).map(s => ({ ...s })),
		run: async (ctx, input) => {
			const standard = JSON.parse(fs.readFileSync(input.input, "utf8"));
			validateInput(standard, ctx.root);
			if (
				digest(standard) !== input.inputDigest ||
				input.rpcKey !== standard.rpcKey ||
				input.archiveRpcKey !== standard.archiveRpcKey ||
				input.forkEnabled !== standard.forkEnabled
			)
				throw new Error("Recovery task input changed");
			const step = (id, fn) => {
				const s = RECOVERY_PLAN.find(s => s.id === id);
				return ctx.step(id, s.title, fn, { phase: s.phase });
			};
			await step("compile", () => ctx.runProcess("./node_modules/.bin/hardhat", ["compile", "--config", CONFIG], { env: environment(input) }));
			await step("test", async () => {
				await ctx.runProcess("./node_modules/.bin/hardhat", ["test", "mocha", "--no-compile", "--config", CONFIG], {
					env: environment(input),
				});
				const report = fs.existsSync(input.output) ? readReport(input) : { schema: 1, inputDigest: input.inputDigest };
				report.localTests = {
					passed: true,
					inputDigest: input.inputDigest,
					sourceDigest: standard.sourceDigest,
					completedAt: new Date().toISOString(),
				};
				atomicWrite(input.output, report);
			});
			await step("inspect", () => runRecoveryPhase(ctx, input, "inspect"));
			await step("tpm", async () => {
				const report = readReport(input);
				if (report.tpm) {
					requireTpmConfirmation(report.tpm);
					return;
				}
				const confirmation = {};
				for (const [key, message] of [
					["recipient", `Paste the recipient address confirmed by the TPM (${TARGET.recipient})`],
					["confirmedBy", "TPM name"],
					["reference", "Confirmation reference (ticket/message URL or recorded approval)"],
				]) {
					confirmation[key] = await ctx.ui.text({ message, validate: v => (v?.trim() ? undefined : "Required") });
					if (!confirmation[key]) return ctx.wait("TPM confirmation is required before continuing.");
				}
				confirmation.confirmedAt = new Date().toISOString();
				requireTpmConfirmation(confirmation);
				report.tpm = confirmation;
				atomicWrite(input.output, report);
			});
			if (input.forkEnabled) await step("rehearse", () => runRecoveryPhase(ctx, input, "rehearse"));
			await step("authorize", async () => {
				const report = readReport(input);
				ctx.ui.note(
					`Local recovery tests passed. ${input.forkEnabled ? `Optional fork passed at block ${report.rehearsal.blockNumber}.` : "Fork rehearsal not requested."}\nZero balance: ${report.baseline.zero} raw (18 decimals).\nRecipient: ${TARGET.recipient}\nDeploy one facet, publish, add one selector, grant a temporary role if absent, export a Safe sweep, then remove only the temporary role. The sweep takes the full balance at execution.`,
				);
				const phrase = "RECOVER ZERO BALANCE ON 999";
				const value = await ctx.ui.text({
					message: `Type ${phrase} to authorize these live operations`,
					validate: v => (v === phrase ? undefined : "Type the exact phrase"),
				});
				if (value !== phrase) return ctx.wait("Live operations have not been authorized.");
			});
			await step("deploy", async () =>
				runRecoveryPhase(ctx, input, "deploy", { selection: input.signer, transaction: await resumeHash(ctx, input, "deploy") }),
			);
			await step("publish", () => runRecoveryPhase(ctx, input, "publish"));
			for (const phase of ["cut", "grant"])
				await step(phase, async () => {
					const report = readReport(input);
					ctx.ui.note(
						phase === "cut"
							? `Core: ${TARGET.core}\nAdd selector: ${SELECTOR}\nFacet: ${report.facet}\nNo replacement, removal or initializer.`
							: `Recovery role: ${ROLE}\nRecipient: ${TARGET.recipient}\nGrant only if absent at baseline; remove the temporary grant after recovery.`,
					);
					return runRecoveryPhase(ctx, input, phase, {
						selection: await ownerSigner(ctx),
						transaction: await resumeHash(ctx, input, phase),
					});
				});
			await step("recovery", async () => {
				let report = readReport(input);
				if (!report.safeDelivery && ctx.state.safeDispatches?.["zero-recovery"]) {
					report.safeDelivery = ctx.state.safeDispatches["zero-recovery"];
					atomicWrite(input.output, report);
				}
				if (report.recovery) return runRecoveryPhase(ctx, input, "verify-recovery");
				// Once exported, always ask for execution evidence before considering any further export.
				if (!report.safeDelivery) {
					report = await runRecoveryPhase(ctx, input, "plan-recovery");
					ctx.ui.note(
						`Safe recovery preview (raw units, 18 decimals):\naddress(0): ${report.preview.snapshot.zero} -> 0\nRecipient: ${TARGET.recipient}\nRecipient balance: ${report.preview.snapshot.recipient} -> ${BigInt(report.preview.snapshot.recipient) + BigInt(report.preview.snapshot.zero)}\nThe call sweeps the full available amount at execution.`,
					);
					const delivery = await dispatchSafeActions(
						ctx,
						{ mode: SIGNER_MODES.SAFE_FILE, safeAddress: TARGET.recipient },
						[report.preview.action],
						{
							root: ctx.root,
							chainId: 999,
							network: "hyperevm",
							name: "Recover zero-address internal balance",
							description: `Sweep the full internal balance to ${TARGET.recipient}, including all 18-decimal dust.`,
							stateKey: "zero-recovery",
							processEnv: environment(input),
						},
					);
					report.safeDelivery = delivery;
					atomicWrite(input.output, report);
					return ctx.wait(
						`Import ${delivery.builderPath} into the recipient Safe and execute it. Continue this task with the executed on-chain transaction hash.`,
					);
				}
				const transaction = await ctx.ui.text({
					message: "Executed recovery transaction hash from the recipient Safe",
					validate: v => (/^0x[0-9a-fA-F]{64}$/.test(v) ? undefined : "Enter the executed on-chain transaction hash"),
				});
				if (!transaction) return ctx.wait(`Awaiting Safe execution. Existing export: ${report.safeDelivery.builderPath}`);
				await runRecoveryPhase(ctx, input, "verify-recovery", { transaction });
			});
			await step("cleanup", async () => {
				const report = readReport(input);
				return runRecoveryPhase(
					ctx,
					input,
					"cleanup",
					report.temporaryRole ? { selection: await ownerSigner(ctx), transaction: await resumeHash(ctx, input, "cleanup") } : {},
				);
			});
			await step("evidence", () => runRecoveryPhase(ctx, input, "evidence"));
			await step("handoff", async () => {
				const report = await runRecoveryPhase(ctx, input, "evidence");
				ctx.ui.note(fs.readFileSync(report.handoffFile, "utf8"));
				const reference = await ctx.ui.text({
					message: "After sending this evidence to the TPM and asking them to coordinate with Leon, record the message/ticket reference",
					validate: v => (v?.trim() ? undefined : "Record the delivery reference"),
				});
				if (!reference)
					return ctx.wait(`Send ${report.handoffFile} to the TPM, request Leon coordination, then continue to record delivery.`);
				report.handoff = { reference, recordedAt: new Date().toISOString(), recordedByOperator: true };
				atomicWrite(input.output, report);
			});
		},
		reconcile: async (ctx, input) => {
			// Do not clear cancellation gates on inference from a balance or a selector. The phase revalidates its exact receipt on resume.
			let report = fs.existsSync(input.output) ? readReport(input) : {};
			if (Object.values(report.operations || {}).some(op => op.status !== "confirmed" && op.hash)) {
				try {
					report = await runRecoveryPhase(ctx, input, "reconcile");
				} catch {
					report = readReport(input);
				}
			}
			const operations = Object.values(report.operations || {});
			for (const tx of ctx.state.transactions) {
				const op = operations.find(
					op => op.hash?.toLowerCase() === tx.hash.toLowerCase() || op.journal?.hash?.toLowerCase() === tx.hash.toLowerCase(),
				);
				if (op?.status === "confirmed") Object.assign(tx, op.journal || {}, { status: "confirmed" });
			}
			return { unresolved: operations.filter(op => op.status !== "confirmed").map(op => op.hash || `nonce:${op.nonce}`) };
		},
	});
}
