import {
	batchPlanDigest,
	batchSummary,
	batchSourceDigest,
	unresolvedBatchOperations,
	validateBatchInput,
} from "../../deployment-tooling/batch-withdrawal.js";
import { digest } from "../../deployment-tooling/core-withdrawal.js";
import { CHAINS } from "../lib/context.js";
import { PROJECT_ROOT } from "../lib/paths.js";
import { selectSigner, hydrateSigner, signerEnvironment, SIGNER_MODES, redactSignerSecrets } from "../signer/index.js";
import { withdrawalEnvironment, withdrawalHistory } from "./core-withdrawal.js";
import { atomicWrite } from "./guided-recipe.js";
import { getAddress, isAddress, ZeroAddress } from "ethers";
import fs from "node:fs";
import path from "node:path";

const rememberedSigners = new WeakMap();
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const directory = ctx => path.join(path.dirname(ctx.state.eventPath), "batch-withdrawal");
const reportFile = (ctx, input) => input.batchFile || path.join(directory(ctx), "report.json");
export function readBatchFile(file) {
	const inputFile = path.join(path.dirname(file), "input.json"),
		input = read(inputFile),
		report = read(file);
	validateBatchInput(input);
	if (report.schema !== 1 || report.inputDigest !== digest(input)) throw new Error("Batch report is not bound to its public input");
	return { input, report, inputFile };
}
function bindings(ctx, input) {
	const file = reportFile(ctx, input);
	if (input.batchFile) return { file, ...readBatchFile(file) };
	validateBatchInput(input);
	fs.mkdirSync(directory(ctx), { recursive: true });
	const inputFile = path.join(directory(ctx), "input.json");
	if (fs.existsSync(inputFile) && digest(read(inputFile)) !== digest(input)) throw new Error("Withdrawal batch input changed");
	atomicWrite(inputFile, input);
	return { file, inputFile, input, report: fs.existsSync(file) ? readBatchFile(file).report : null };
}
export function batchHistory(stateRoot, { includeActive = false } = {}) {
	const rows = [];
	const states = [];
	if (includeActive) {
		try {
			states.push(read(path.join(stateRoot, "active.json")));
		} catch {}
	}
	for (const folder of ["history"]) {
		let entries;
		try {
			entries = fs.readdirSync(path.join(stateRoot, folder), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries.filter(entry => entry.isDirectory())) {
			try {
				states.push(read(path.join(stateRoot, folder, entry.name, "state.json")));
			} catch {}
		}
	}
	for (const state of states) {
		try {
			if (state.taskId !== "maintenance.batch-withdrawal" || (!includeActive && state.status !== "completed")) continue;
			const file = path.join(path.dirname(state.eventPath), "batch-withdrawal", "report.json");
			const { input, report } = readBatchFile(file);
			if (CHAINS[input.network]?.chainId !== input.chainId || rows.some(row => row.file === file)) continue;
			rows.push({
				file,
				input,
				report,
				status: state.status,
				finishedAt: new Date(state.finishedAt || state.updatedAt || state.createdAt).toISOString(),
			});
		} catch {}
	}
	return rows.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
}
async function address(ui, message, initialValue) {
	return ui.text({
		message,
		...(initialValue ? { initialValue } : {}),
		validate: value => (isAddress(value) && getAddress(value) !== ZeroAddress ? undefined : "Enter a non-zero EVM address"),
	});
}
export async function prepareBatch({
	ui,
	root = PROJECT_ROOT,
	stateRoot = process.env.SYMMIO_TASK_STATE_DIR || path.join(root, ".symmio", "tasks"),
}) {
	const history = batchHistory(stateRoot),
		single = withdrawalHistory(stateRoot);
	const previousNetwork = history[0]?.input.network || single[0]?.input.network;
	const network = await ui.select({
		message: "Batch Core network",
		...(previousNetwork ? { initialValue: previousNetwork } : {}),
		options: Object.entries(CHAINS)
			.filter(([name, chain]) => !chain.simulated || name === "localhost")
			.map(([value, chain]) => ({ value, label: chain.name })),
	});
	if (!network) return null;
	const previous = history.find(row => row.input.network === network)?.input || single.find(row => row.input.network === network)?.input;
	const core = await address(ui, "Batch Core diamond address", previous?.core);
	if (!core) return null;
	const sameCore = previous && getAddress(previous.core) === getAddress(core);
	const recipientMode = await ui.select({
		message: "Batch collateral recipients",
		initialValue: (sameCore && previous.recipientMode) || "self",
		options: [
			{ value: "self", label: "Each account's own wallet" },
			{ value: "common", label: "One common recipient" },
		],
	});
	if (!recipientMode) return null;
	const recipient =
		recipientMode === "common"
			? await address(ui, "Common collateral recipient", sameCore && previous.recipientMode === "common" ? previous.recipient : undefined)
			: undefined;
	if (recipientMode === "common" && !recipient) return null;
	const amount = await ui.text({
		message: "Amount per account, or all",
		initialValue: sameCore ? previous.amount : "all",
		validate: value =>
			value === "all" || (/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value) && Number(value) > 0)
				? undefined
				: "Enter all or a positive decimal amount",
	});
	if (!amount) return null;
	const route = await ui.select({
		message: "Batch withdrawal interface",
		initialValue: sameCore ? previous.route : "auto",
		options: [
			{ value: "auto", label: "Auto: classic if installed, otherwise legacy" },
			{ value: "classic", label: "Classic requests and finalization" },
			{ value: "legacy", label: "Legacy withdrawTo" },
		],
	});
	if (!route) return null;
	const muonUrl = await ui.text({
		message: "Batch Muon HTTPS URL",
		initialValue: sameCore ? previous.muonUrl : "https://muon-oracle3.rasa.capital/",
		validate: value => {
			try {
				const url = new URL(value);
				if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) return;
			} catch {}
			return "Use an HTTPS endpoint without credentials, query or fragment";
		},
	});
	if (!muonUrl) return null;
	const source = await ui.select({
		message: "Batch account list",
		options: [
			{ value: "addresses", label: "Enter public addresses; request keys only when needed" },
			{ value: "keys", label: "Enter private keys one at a time, masked" },
		],
		initialValue: "addresses",
	});
	if (!source) return null;
	const accounts = [],
		signers = new Map();
	if (source === "addresses") {
		const text = await ui.text({
			message: "Account addresses separated by commas or spaces",
			...(sameCore && previous.accounts ? { initialValue: previous.accounts.join(", ") } : {}),
			validate: value => {
				try {
					const parts = value.trim().split(/[\s,;]+/);
					if (parts.length > 0 && parts.length <= 100 && parts.every(a => isAddress(a) && getAddress(a) !== ZeroAddress)) return;
				} catch {}
				return "Enter 1–100 public addresses";
			},
		});
		if (!text) return null;
		accounts.push(
			...text
				.trim()
				.split(/[\s,;]+/)
				.map(getAddress),
		);
	} else {
		const count = await ui.text({
			message: "Number of private-key accounts",
			validate: value => (/^(?:[1-9]\d?|100)$/.test(value) ? undefined : "Enter 1–100"),
		});
		if (!count) return null;
		for (let index = 0; index < Number(count); index++) {
			const selection = await selectSigner(ui, {
				role: `Batch account ${index + 1}`,
				network,
				chainId: CHAINS[network].chainId,
				allowedModes: [SIGNER_MODES.PRIVATE_KEY],
			});
			if (!selection) return null;
			accounts.push(selection.address);
			signers.set(selection.address.toLowerCase(), selection);
		}
	}
	const unique = [...new Set(accounts)];
	if (unique.length !== accounts.length) ui.note(`Removed ${accounts.length - unique.length} duplicate account(s).`, "Batch account list");
	const input = {
		schema: 1,
		network,
		chainId: CHAINS[network].chainId,
		core: getAddress(core),
		accounts: unique,
		recipientMode,
		...(recipient ? { recipient: getAddress(recipient) } : {}),
		amount,
		route,
		muonUrl,
	};
	validateBatchInput(input);
	rememberedSigners.set(input, signers);
	return input;
}
async function prepareExisting({ ui, root = PROJECT_ROOT, stateRoot = process.env.SYMMIO_TASK_STATE_DIR || path.join(root, ".symmio", "tasks") }) {
	const history = batchHistory(stateRoot, { includeActive: true });
	let file;
	if (history.length) {
		file = await ui.select({
			message: "Withdrawal batch to recheck",
			options: [
				...history.map(row => ({
					value: row.file,
					label: `${row.finishedAt} | ${row.input.network} | ${row.input.accounts.length} accounts | ${row.input.core}`,
				})),
				{ value: "manual", label: "Enter a batch report path" },
			],
		});
		if (!file) return null;
	}
	if (!file || file === "manual")
		file = await ui.text({
			message: "Saved batch report.json path",
			validate: value => {
				try {
					readBatchFile(path.resolve(root, value));
					return;
				} catch (error) {
					return error.message;
				}
			},
		});
	if (!file) return null;
	file = path.resolve(root, file);
	const { input } = readBatchFile(file);
	return { batchFile: file, network: input.network, chainId: input.chainId };
}
async function accountSigner(ctx, input, account) {
	const role = `account-${account.slice(2).toLowerCase()}`;
	let signer = ctx.getSigner?.(role) || rememberedSigners.get(input)?.get(account.toLowerCase());
	if (!signer)
		signer = await selectSigner(ctx.ui, {
			role: `Private-key wallet for ${account}`,
			allowedModes: input.network === "localhost" ? [SIGNER_MODES.LOCAL_NODE, SIGNER_MODES.PRIVATE_KEY] : [SIGNER_MODES.PRIVATE_KEY],
			initialMode: input.network === "localhost" ? SIGNER_MODES.LOCAL_NODE : SIGNER_MODES.PRIVATE_KEY,
			network: input.network,
			chainId: input.chainId,
			expectedAddress: account,
		});
	if (!signer) throw new Error("Account signer entry was cancelled");
	if (getAddress(signer.address) !== getAddress(account)) throw new Error("Private key does not match the batch account");
	if (ctx.bindSigner) signer = ctx.bindSigner(role, signer);
	await hydrateSigner(signer, ctx.ui);
	return signer;
}
function journalEntries(report) {
	return Object.values(report.rows || {}).flatMap(row =>
		[row.fresh, ...Object.values(row.requests || {})].flatMap(child =>
			Object.values(child?.operations || {})
				.filter(operation => operation.hash)
				.map(operation => ({
					...operation.journal,
					...operation.intent,
					hash: operation.hash,
					originalHash: operation.journal?.hash,
					nonce: operation.nonce,
					status: operation.status === "confirmed" ? "confirmed" : "submitted",
					blockNumber: operation.blockNumber,
				})),
		),
	);
}
export async function runBatchAdapter(ctx, input, account, phase, { execute = false, transaction = "", transactionPhase = "" } = {}) {
	const bound = bindings(ctx, input),
		env = withdrawalEnvironment(bound.input, execute);
	if (execute) Object.assign(env, signerEnvironment(await accountSigner(ctx, input, account)));
	try {
		await ctx.runProcess(
			"./node_modules/.bin/hardhat",
			[
				"internal:batch-withdrawal",
				"--network",
				bound.input.network,
				"--phase",
				phase,
				"--account",
				account,
				"--input",
				bound.inputFile,
				"--output",
				bound.file,
				...(transaction ? ["--transaction", transaction, "--transaction-phase", transactionPhase] : []),
			],
			{ env, captureEvents: ctx.state.risk !== "read-only" },
		);
	} finally {
		if (fs.existsSync(bound.file) && ctx.state.risk !== "read-only") {
			for (const transaction of journalEntries(readBatchFile(bound.file).report)) {
				if (!ctx.state.transactions?.some(tx => tx.hash === transaction.hash || tx.hash === transaction.originalHash))
					ctx.emit("tx.submitted", { transaction });
				if (transaction.status === "confirmed") ctx.emit("tx.confirmed", { transaction });
			}
		}
	}
	return readBatchFile(bound.file).report;
}
async function eachAccount(ctx, input, phase, { execute = false, onlyReady = false } = {}) {
	const bound = bindings(ctx, input);
	for (const account of bound.input.accounts) {
		ctx.checkpoint?.();
		let row = fs.existsSync(bound.file) ? readBatchFile(bound.file).report.rows[account.toLowerCase()] : null;
		if (phase !== "inspect" && !row?.planDigest) continue;
		const uncertain = row && unresolvedBatchOperations({ rows: { [account]: row } }).length > 0;
		if (
			execute &&
			!uncertain &&
			(row?.issues?.length || row?.status === "empty" || row?.status === "completed" || (onlyReady && row?.status !== "ready"))
		)
			continue;
		try {
			if (execute && unresolvedBatchOperations({ rows: { [account]: row } }).length) {
				try {
					await runBatchAdapter(ctx, input, account, "reconcile");
				} catch {}
				row = readBatchFile(bound.file).report.rows[account.toLowerCase()];
				for (const operation of unresolvedBatchOperations({ rows: { [account]: row } })) {
					const transaction = await ctx.ui.text({
						message: `Original or replacement transaction hash for ${account} (${operation.phase}, nonce ${operation.nonce})`,
						initialValue: operation.hash || "",
						validate: value => (/^0x[0-9a-fA-F]{64}$/.test(value) ? undefined : "Enter the original or replacement transaction hash"),
					});
					if (!transaction) throw new Error("Transaction outcome remains unresolved; no automatic resend");
					await runBatchAdapter(ctx, input, account, "reconcile", { transaction, transactionPhase: operation.phase });
				}
				row = readBatchFile(bound.file).report.rows[account.toLowerCase()];
			}
			if (onlyReady && row?.status !== "ready") {
				await runBatchAdapter(ctx, input, account, "recheck");
				row = readBatchFile(bound.file).report.rows[account.toLowerCase()];
				if (row.status !== "ready") continue;
			}
			const fresh = row?.fresh;
			const prepareFresh =
				phase === "process" &&
				fresh &&
				!fresh.completed &&
				((BigInt(fresh.plan.deallocate) > 0n && fresh.operations.deallocate?.status !== "confirmed") ||
					(fresh.plan.route === "classic" && BigInt(fresh.plan.withdrawToken) > 0n && !fresh.operations.initiate));
			const needsSigner = execute && (prepareFresh || row?.status === "ready");
			await runBatchAdapter(ctx, input, account, phase, { execute: Boolean(needsSigner) });
		} catch (error) {
			ctx.checkpoint?.();
			// Startup failures (for example, a rejected keystore unlock) have no report
			// to review. Preserve their cause instead of replacing it with ENOENT.
			if (!fs.existsSync(bound.file)) throw error;
			ctx.ui.note(`${account}: ${redactSignerSecrets(error.message)}\nOther accounts will continue.`, "Account needs investigation");
		}
	}
	return readBatchFile(bound.file).report;
}
function preview(input, report) {
	return `Network: ${input.network} (${input.chainId})\nCore: ${input.core}\nAmounts and recipients are frozen for this batch. Existing requests keep their original terms.\n${batchSummary(report)}`;
}
async function authorize(ctx, input, { readyOnly = false } = {}) {
	const bound = bindings(ctx, input),
		report = bound.report;
	ctx.ui.note(preview(bound.input, report), readyOnly ? "Review ready batch accounts" : "Review batch deallocation and withdrawals");
	const planDigest = batchPlanDigest(report),
		phrase = `BATCH WITHDRAW ${bound.input.chainId} ${planDigest.slice(0, 12)}`;
	const response = await ctx.ui.text({
		message: `Type ${phrase} to authorize ${readyOnly ? "ready accounts" : "this batch"}`,
		validate: value => (value === phrase ? undefined : "Enter the exact confirmation phrase"),
	});
	if (response !== phrase) return ctx.wait("Batch plan has not been authorized");
	report.approvedDigest = planDigest;
	atomicWrite(bound.file, report);
}
async function reconcile(ctx, input) {
	const bound = bindings(ctx, input);
	if (!bound.report) return { unresolved: [] };
	await eachAccount(ctx, input, "reconcile");
	return {
		unresolved: unresolvedBatchOperations(readBatchFile(bound.file).report).map(
			operation => operation.hash || `${operation.account} ${operation.phase}: unknown outcome at nonce ${operation.nonce}`,
		),
	};
}
export function createBatchWithdrawalTasks(common) {
	const base = {
		version: 1,
		category: "maintenance",
		perAccountSigners: true,
		supportedNetworks: Object.keys(CHAINS).filter(name => !name.startsWith("fork-")),
		inputs: [
			{ id: "network", type: "network", label: "Network", required: true },
			{ id: "accounts", type: "selection", label: "Public batch accounts", required: false },
			{ id: "batchFile", type: "string", label: "Saved batch report", required: false },
		],
		artifacts: [
			"batch input and reviewed account plans",
			"per-account transaction journals",
			"cooldown queue and investigation report",
			"receipt and collateral transfer proofs",
		],
		validateResume: (ctx, input) => {
			const bound = bindings(ctx, input);
			if (bound.report && bound.report.sourceDigest !== batchSourceDigest(ctx.root))
				throw new Error("Batch runtime changed after review; restore the original source");
		},
		reconcile,
	};
	return [
		common({
			...base,
			id: "maintenance.batch-withdrawal",
			risk: "transaction",
			title: "Batch deallocate and withdraw Core collateral",
			description: "Process private-key accounts sequentially and save cooling-down accounts for a later pass.",
			prepare: prepareBatch,
			plan: () => [
				{ id: "inspect", phase: "prepare", title: "Inspect account balances and existing requests" },
				{ id: "authorize", phase: "authorization", title: "Review and authorize the batch" },
				{ id: "process", phase: "execution", title: "Process accounts and save the cooldown queue" },
			],
			run: async (ctx, input) => {
				await ctx.step("inspect", "Inspect account balances and existing requests", () => eachAccount(ctx, input, "inspect"));
				await ctx.step("authorize", "Review and authorize the batch", () => authorize(ctx, input));
				await ctx.step("process", "Process accounts and save the cooldown queue", async () => {
					const report = await eachAccount(ctx, input, "process", { execute: true });
					ctx.ui.note(
						`${batchSummary(report)}\nSaved batch: ${reportFile(ctx, input)}\nUse Recheck pending batch withdrawals, then Withdraw ready batch accounts.`,
						"Batch first pass finished",
					);
					if (unresolvedBatchOperations(report).length)
						return ctx.wait(
							"Some transaction outcomes need reconciliation. Resume this same batch before starting another withdrawal task.",
						);
				});
			},
		}),
		common({
			...base,
			id: "maintenance.batch-withdrawal-check",
			risk: "read-only",
			title: "Recheck pending batch withdrawals",
			description: "Read saved accounts and request cooldowns without connecting private keys.",
			prepare: prepareExisting,
			plan: () => [{ id: "recheck", phase: "verification", title: "Recheck batch requests and cooldowns" }],
			run: async (ctx, input) =>
				ctx.step("recheck", "Recheck batch requests and cooldowns", async () => {
					const report = await eachAccount(ctx, input, "recheck");
					ctx.ui.note(batchSummary(report), "Batch withdrawal readiness");
				}),
		}),
		common({
			...base,
			id: "maintenance.batch-withdrawal-ready",
			risk: "transaction",
			title: "Withdraw ready batch accounts",
			description: "Recheck a saved batch, review ready accounts and finalize their withdrawals.",
			prepare: prepareExisting,
			plan: () => [
				{ id: "recheck", phase: "verification", title: "Recheck batch requests and cooldowns" },
				{ id: "authorize", phase: "authorization", title: "Review and authorize ready accounts" },
				{ id: "withdraw", phase: "execution", title: "Withdraw ready accounts and verify transfers" },
			],
			run: async (ctx, input) => {
				await ctx.step("recheck", "Recheck batch requests and cooldowns", () => eachAccount(ctx, input, "recheck"));
				await ctx.step("authorize", "Review and authorize ready accounts", () => authorize(ctx, input, { readyOnly: true }));
				await ctx.step("withdraw", "Withdraw ready accounts and verify transfers", async () => {
					const report = await eachAccount(ctx, input, "withdraw-ready", { execute: true, onlyReady: true });
					ctx.ui.note(batchSummary(report), "Ready-account withdrawal results");
					if (unresolvedBatchOperations(report).length) return ctx.wait("Reconcile uncertain transactions before continuing this batch");
				});
			},
		}),
	];
}
