import {
	CONFIG,
	EXECUTION,
	sameAddress,
	TARGET,
	ROLE,
	SELECTOR,
	digest,
	sourceDigest,
	validateInput,
	requireRecipientConfirmation,
} from "../../deployment-tooling/hyperevm-zero-recovery.js";
import { PROJECT_ROOT } from "../lib/paths.js";
import { SIGNER_MODES, hydrateSigner, selectSigner, signerEnvironment } from "../signer/index.js";
import { atomicWrite } from "./guided-recipe.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PUBLIC_RPC = Object.freeze({ key: "RPC_HYPEREVM_PUBLIC", url: "https://rpc.hyperliquid.xyz/evm" });

export const RECOVERY_PLAN = Object.freeze(
	[
		["compile", "prepare", "Compile the isolated Solidity 0.8.18 recovery facet"],
		["test", "verification", "Run the local recovery tests"],
		["inspect", "prepare", "Inspect Core, Safe and authorities"],
		["recipient", "authorization", "Confirm the exact recipient address"],
		["rehearse", "verification", "Prove full-precision recovery and guards on a historical fork"],
		["authorize", "authorization", "Review and authorize the live operations"],
		["deploy", "deployment", "Deploy the recovery facet"],
		["publish", "publication", "Publish the facet on Hyperevmscan"],
		["cut", "execution", "Add the recovery selector using the Core owner"],
		["grant", "execution", "Grant the Ledger a temporary recovery role if needed"],
		["recovery", "execution", "Recover to the multisig using Ledger and verify the receipt"],
		["cleanup", "execution", "Remove only the recovery role granted by this task"],
		["evidence", "verification", "Verify final balances and write the recovery summary"],
	].map(([id, phase, title]) => ({ id, phase, title })),
);

const readReport = input => {
	const report = JSON.parse(fs.readFileSync(input.output, "utf8"));
	if (report.inputDigest !== input.inputDigest) throw new Error("Recovery report input changed");
	return report;
};
const environment = input => ({
	...(input.rpcKey === PUBLIC_RPC.key ? { [PUBLIC_RPC.key]: PUBLIC_RPC.url } : {}),
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
export function requireOwnerLedger(selection) {
	if (selection?.mode !== SIGNER_MODES.LEDGER || !sameAddress(selection.address, TARGET.owner))
		throw new Error(`This recovery requires Ledger ${TARGET.owner}`);
	return selection;
}
async function ownerSigner(ctx, input) {
	const existing = ctx.getSigner("governance") || (input.signer?.mode === SIGNER_MODES.LEDGER ? input.signer : null);
	if (existing) return requireOwnerLedger(existing);
	const selection = await selectSigner(ctx.ui, {
		role: "Recovery operator (Core owner and role admin)",
		allowedModes: [SIGNER_MODES.LEDGER],
		initialMode: SIGNER_MODES.LEDGER,
		network: "hyperevm",
		chainId: 999,
		expectedAddress: TARGET.owner,
	});
	if (!selection) return ctx.wait("Ledger selection cancelled. Continue when the owner Ledger is ready.");
	return ctx.bindSigner("governance", requireOwnerLedger(selection));
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
// Display the upcoming operator separately from the immutable deployment signer history.
export function recoverySignerLines(active) {
	if (active.taskId !== "maintenance.hyperevm-zero-balance-recovery" || active.taskVersion !== 4) return null;
	const deployment = active.signing?.transaction;
	const selection = active.signing?.governance || active.input?.signer || (deployment?.mode === SIGNER_MODES.LEDGER ? deployment : null);
	const ready = selection?.mode === SIGNER_MODES.LEDGER && sameAddress(selection.address, TARGET.owner);
	const lines = [
		ready
			? `Signer for remaining transactions: Ledger • ${TARGET.owner}`
			: `Required signer: Ledger • ${TARGET.owner} (${selection ? "configuration mismatch" : "selection pending"})`,
	];
	if (selection && !ready) lines.push(`Configured signer: ${selection.mode} • ${selection.address || selection.key || "unknown"}`);
	if (active.completedSteps?.includes("deploy") && deployment && deployment.mode !== SIGNER_MODES.LEDGER)
		lines.push(`Completed deployment signer: ${deployment.mode} • ${deployment.address || deployment.key}`);
	return lines;
}

export function createHyperEvmZeroRecoveryTask(common) {
	return common({
		id: "maintenance.hyperevm-zero-balance-recovery",
		version: 4,
		category: "maintenance",
		risk: "transaction",
		title: "HyperEVM v0.8.5 / recover the zero-address balance",
		description:
			"Test the add-only upgrade locally, optionally rehearse a fork, use the owner Ledger for each transaction, and verify the recovery balances.",
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
			"Ledger recovery receipt",
			"full-precision recovery evidence and summary",
		],
		signerPolicy: () => ({
			role: "Recovery operator (Core owner and role admin)",
			allowedModes: [SIGNER_MODES.LEDGER],
			initialMode: SIGNER_MODES.LEDGER,
			expectedAddress: TARGET.owner,
		}),
		prepare: async ({ ui, root = PROJECT_ROOT }) => {
			const forkEnabled = await ui.confirm({ message: "Run an optional HyperEVM fork rehearsal before deployment?", initialValue: false });
			if (forkEnabled === null) return null;
			const rpcSource = await ui.select({
				message: "HyperEVM RPC provider",
				options: [
					{ value: "public", label: "Public Hyperliquid RPC", hint: "No RPC credentials needed" },
					{ value: "custom", label: "Custom RPC provider", hint: "Use a Hardhat keystore reference" },
				],
				initialValue: "public",
			});
			if (!rpcSource) return null;
			const references = rpcSource === "public" ? { rpcKey: PUBLIC_RPC.key } : {};
			for (const [key, value, message] of [
				...(rpcSource === "custom" ? [["rpcKey", "RPC_HYPEREVM", "HyperEVM RPC keystore key"]] : []),
				...(forkEnabled ? [["archiveRpcKey", "RPC_HYPEREVM_ARCHIVE", "Historical archive RPC keystore key (for the optional fork)"]] : []),
			]) {
				references[key] = await ui.text({
					message,
					initialValue: value,
					validate: v => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v || "") ? undefined : "Enter the keystore key name, not a URL"),
				});
				if (!references[key]) return null;
			}
			const standard = {
				schema: 2,
				execution: EXECUTION,
				target: TARGET,
				forkEnabled,
				...references,
				sourceDigest: sourceDigest(root),
				runId: randomUUID(),
			};
			const inputDigest = digest(standard),
				directory = path.join(root, "tasks", "data", "999", "zero-recovery", inputDigest);
			const input = path.join(directory, "input.json"),
				output = path.join(directory, "report.json");
			atomicWrite(input, standard);
			ui.note(
				`Core: ${TARGET.core}\nRecipient: ${TARGET.recipient}\nLedger operator / Core owner: ${TARGET.owner}\nRPC: ${rpcSource === "public" ? "Public Hyperliquid" : references.rpcKey}\nAll amounts use the internal 18-decimal balance. You confirm the recipient before live operations. Fork rehearsal: ${forkEnabled ? "enabled (requires an archive RPC)" : "not requested"}.\nReports: ${directory}`,
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
					captureEvents: false,
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
			await step("recipient", async () => {
				const report = readReport(input);
				if (report.recipientConfirmation) {
					requireRecipientConfirmation(report.recipientConfirmation);
					return;
				}
				const recipient = await ctx.ui.text({
					message: `Confirm the recovery recipient by entering its address (${TARGET.recipient})`,
					validate: value =>
						value?.toLowerCase() === TARGET.recipient.toLowerCase() ? undefined : "Enter the displayed recipient address",
				});
				if (!recipient) return ctx.wait("Confirm the recipient to continue.");
				report.recipientConfirmation = { recipient, confirmedAt: new Date().toISOString() };
				requireRecipientConfirmation(report.recipientConfirmation);
				atomicWrite(input.output, report);
			});
			if (input.forkEnabled) await step("rehearse", () => runRecoveryPhase(ctx, input, "rehearse"));
			await step("authorize", async () => {
				const report = readReport(input);
				ctx.ui.note(
					`Local recovery tests passed. ${input.forkEnabled ? `Optional fork passed at block ${report.rehearsal.blockNumber}.` : "Fork rehearsal not requested."}\nZero balance: ${report.baseline.zero} raw (18 decimals).\nRecipient: ${TARGET.recipient}\nDeploy one facet, publish, add one selector, grant the Ledger a temporary recovery role if absent, recover directly using that Ledger, then remove only that temporary role. No Safe signatures are needed. Ledger: ${TARGET.owner}. The sweep takes the full balance at execution.`,
				);
				const phrase = "RECOVER ZERO BALANCE ON 999";
				const value = await ctx.ui.text({
					message: `Type ${phrase} to authorize these live operations`,
					validate: v => (v === phrase ? undefined : "Type the exact phrase"),
				});
				if (value !== phrase) return ctx.wait("Live operations have not been authorized.");
			});
			await step("deploy", async () =>
				runRecoveryPhase(ctx, input, "deploy", {
					selection: requireOwnerLedger(input.signer),
					transaction: await resumeHash(ctx, input, "deploy"),
				}),
			);
			await step("publish", () => runRecoveryPhase(ctx, input, "publish"));
			for (const phase of ["cut", "grant"])
				await step(phase, async () => {
					const report = readReport(input);
					ctx.ui.note(
						phase === "cut"
							? `Core: ${TARGET.core}\nAdd selector: ${SELECTOR}\nFacet: ${report.facet}\nNo replacement, removal or initializer.`
							: `Recovery role: ${ROLE}\nLedger role holder: ${TARGET.owner}\nRecipient: ${TARGET.recipient}\nGrant only if absent at baseline; remove the temporary grant after recovery.`,
					);
					return runRecoveryPhase(ctx, input, phase, {
						selection: await ownerSigner(ctx, input),
						transaction: await resumeHash(ctx, input, phase),
					});
				});
			await step("recovery", async () => {
				const report = readReport(input);
				if (report.safeDelivery || ctx.state.safeDispatches?.["zero-recovery"])
					throw new Error("An old Safe export exists; reconcile it before switching the recovery operator");
				if (report.recovery) return runRecoveryPhase(ctx, input, "verify-recovery");
				// Reconcile an existing intent first, even when its successful execution already emptied the source.
				if (!report.operations?.recovery) {
					const preview = await runRecoveryPhase(ctx, input, "plan-recovery");
					ctx.ui.note(
						`Ledger: ${TARGET.owner}\nRecovery preview (raw units, 18 decimals):\naddress(0): ${preview.preview.snapshot.zero} -> 0\nRecipient: ${TARGET.recipient}\nRecipient balance: ${preview.preview.snapshot.recipient} -> ${BigInt(preview.preview.snapshot.recipient) + BigInt(preview.preview.snapshot.zero)}\nApprove the recovery on Ledger. The call takes the full balance at execution.`,
					);
				}
				await runRecoveryPhase(ctx, input, "recover", {
					...(report.operations?.recovery ? {} : { selection: await ownerSigner(ctx, input) }),
					transaction: await resumeHash(ctx, input, "recovery"),
				});
			});
			await step("cleanup", async () => {
				const report = readReport(input);
				return runRecoveryPhase(
					ctx,
					input,
					"cleanup",
					report.temporaryRole ? { selection: await ownerSigner(ctx, input), transaction: await resumeHash(ctx, input, "cleanup") } : {},
				);
			});
			await step("evidence", async () => {
				const report = await runRecoveryPhase(ctx, input, "evidence");
				ctx.ui.note(fs.readFileSync(report.summaryFile, "utf8"));
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
