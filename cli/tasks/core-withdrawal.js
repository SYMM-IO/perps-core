import { digest, json, validateWithdrawalInput, verifyWithdrawalPlan, withdrawalPreview } from "../../deployment-tooling/core-withdrawal.js";
import { CHAINS, rpcEnvKey } from "../lib/context.js";
import { hydrateSigner, SIGNER_MODES, signerEnvironment } from "../signer/index.js";
import { atomicWrite } from "./guided-recipe.js";
import { getAddress, isAddress, ZeroAddress } from "ethers";
import fs from "node:fs";
import path from "node:path";

export const WITHDRAWAL_STEPS = [
	["inspect", "prepare", "Read Core balances and freeze the requested amount"],
	["authorize", "authorization", "Review the Core withdrawal plan"],
	["deallocate", "execution", "Deallocate with a fresh Muon signature"],
	["initiate", "execution", "Create a classic withdrawal request if needed"],
	["ready", "verification", "Check the on-chain withdrawal cooldown"],
	["withdraw", "execution", "Transfer collateral to the reviewed recipient"],
	["verify", "verification", "Verify balances and collateral transfer evidence"],
].map(([id, phase, title]) => ({ id, phase, title }));
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
export const withdrawalDirectory = ctx => path.join(path.dirname(ctx.state.eventPath), "core-withdrawal");
function operation(input) {
	const { network, chainId, core, account, recipient, amount, action, route, muonUrl } = input;
	return { schema: 1, network, chainId, core, account, recipient, amount, action, route, muonUrl };
}
export function readWithdrawalReport(ctx, input) {
	const report = read(path.join(withdrawalDirectory(ctx), "report.json"));
	if (report.inputDigest !== digest(operation(input))) throw new Error("Withdrawal report input changed");
	verifyWithdrawalPlan(report.plan, operation(input));
	return report;
}
export function withdrawalEnvironment(input, execute = false) {
	return {
		DOTENV_CONFIG_PATH: "/dev/null",
		SYMMIO_DEPLOYMENT_RECIPE: "",
		SYMMIO_RECIPE_READ_ONLY: String(!execute),
		SYMMIO_SIGNER_MODE: "",
		SYMMIO_SAFE_ACTIONS_ONLY: "false",
		SYMMIO_EXPECTED_SIGNER: "",
		USE_KEYSTORE: String(input.network !== "localhost"),
		SYMMIO_RPC_URL_OVERRIDE: "",
		EXECUTE: String(execute),
		CONFIRM_CHAIN_ID: execute ? String(input.chainId) : "",
		DRY_RUN: "",
	};
}
export async function runWithdrawalAdapter(ctx, input, phase, { execute = false, transaction = "" } = {}) {
	const directory = withdrawalDirectory(ctx);
	fs.mkdirSync(directory, { recursive: true });
	const file = path.join(directory, "input.json"),
		value = operation(input);
	validateWithdrawalInput(value);
	if (fs.existsSync(file) && digest(read(file)) !== digest(value)) throw new Error("Withdrawal input changed");
	atomicWrite(file, value);
	const env = withdrawalEnvironment(input, execute);
	if (execute) {
		const selection = await hydrateSigner(input.signer, ctx.ui);
		if (!selection) return ctx.wait("Reconnect the account signer to continue.");
		Object.assign(env, signerEnvironment(selection));
	}
	await ctx.runProcess(
		"./node_modules/.bin/hardhat",
		[
			"internal:core-withdrawal",
			"--network",
			input.network,
			"--phase",
			phase,
			"--input",
			file,
			"--output",
			path.join(directory, "report.json"),
			...(transaction ? ["--transaction", transaction] : []),
		],
		{ env },
	);
	const report = readWithdrawalReport(ctx, input);
	for (const tx of Object.values(report.operations || {}))
		if (tx.status === "confirmed") {
			const transaction = {
				...tx.journal,
				...tx.intent,
				hash: tx.hash,
				originalHash: tx.journal?.hash,
				nonce: tx.nonce,
				status: "confirmed",
				blockNumber: tx.blockNumber,
			};
			if (!ctx.state.transactions?.some(t => t.hash === tx.hash || t.hash === tx.journal?.hash)) ctx.emit("tx.submitted", { transaction });
			ctx.emit("tx.confirmed", { transaction });
		}
	return report;
}
async function address(ui, message, initialValue) {
	return ui.text({
		message,
		...(initialValue ? { initialValue } : {}),
		validate: v => (isAddress(v) && getAddress(v) !== ZeroAddress ? undefined : "Enter a non-zero EVM address"),
	});
}
async function prepare({ ui }, checkOnly = false) {
	const network = await ui.select({
		message: "Core network",
		options: Object.entries(CHAINS)
			.filter(([n, c]) => !c.simulated || n === "localhost")
			.map(([value, c]) => ({ value, label: c.name })),
	});
	if (!network) return null;
	const core = await address(ui, "Core diamond address");
	if (!core) return null;
	const account = await address(ui, "Account holding the Core balance (must be the signing wallet)");
	if (!account) return null;
	const recipient = checkOnly ? account : await address(ui, "Collateral recipient", account);
	if (!recipient) return null;
	const action = checkOnly
		? "check"
		: await ui.select({
				message: "Operation",
				initialValue: "all",
				options: [
					{ value: "all", label: "Deallocate as needed, check cooldown, then withdraw" },
					{ value: "deallocate", label: "Deallocate only" },
					{ value: "withdraw", label: "Withdraw existing free balance only" },
				],
			});
	if (!action) return null;
	const amount = checkOnly
		? "all"
		: await ui.text({
				message: "Collateral amount, or all (frozen at inspection)",
				initialValue: "all",
				validate: v =>
					v === "all" || (/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(v) && Number(v) > 0)
						? undefined
						: "Enter a positive decimal amount or all",
			});
	if (!amount) return null;
	const route = checkOnly
		? "auto"
		: await ui.select({
				message: "Withdrawal interface",
				initialValue: "auto",
				options: [
					{ value: "auto", label: "Auto: classic request flow if installed, otherwise legacy" },
					{ value: "legacy", label: "Legacy withdrawTo" },
					{ value: "classic", label: "Classic request and finalization" },
				],
			});
	if (!route) return null;
	const muonUrl = checkOnly
		? "https://muon-oracle3.rasa.capital/"
		: await ui.text({
				message: "Muon HTTPS URL (root or /v1/)",
				initialValue: "https://muon-oracle3.rasa.capital/",
				validate: v => {
					try {
						const u = new URL(v);
						if (u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash) return;
					} catch {}
					return "Use HTTPS without credentials or query parameters";
				},
			});
	if (!muonUrl) return null;
	ui.note(`RPC credentials use the existing ${rpcEnvKey(network)} Hardhat keystore entry. No keys or RPC URLs enter the saved task.`, "Connection");
	return {
		network,
		chainId: CHAINS[network].chainId,
		core: getAddress(core),
		account: getAddress(account),
		recipient: getAddress(recipient),
		amount,
		action,
		route,
		muonUrl,
	};
}
async function reconcile(ctx, input) {
	const file = path.join(withdrawalDirectory(ctx), "report.json");
	if (!fs.existsSync(file)) return { unresolved: [] };
	let report = readWithdrawalReport(ctx, input);
	if (Object.keys(report.operations || {}).length) {
		try {
			report = await runWithdrawalAdapter(ctx, input, "reconcile");
		} catch (error) {
			ctx.ui.note(error.message, "Transaction reconciliation required");
			report = readWithdrawalReport(ctx, input);
		}
	}
	return {
		unresolved: Object.entries(report.operations || {})
			.filter(([, op]) => op.status !== "confirmed")
			.map(([phase, op]) => op.hash || `${phase}: unknown outcome at nonce ${op.nonce}`),
	};
}
export function createCoreWithdrawalTasks(common) {
	const fields = ["network", "chainId", "core", "account", "recipient", "amount", "action", "route", "muonUrl"].map(id => ({
		id,
		label: id,
		type: id === "chainId" ? "integer" : ["core", "account", "recipient"].includes(id) ? "address" : id === "network" ? "network" : "string",
		required: true,
	}));
	const base = {
		version: 1,
		category: "maintenance",
		supportedNetworks: Object.keys(CHAINS).filter(n => !n.startsWith("fork-")),
		inputs: fields,
		artifacts: [
			"reviewed withdrawal plan",
			"balance snapshot",
			"Muon response and mapped signature",
			"transaction journal",
			"receipt and token transfer proof",
		],
	};
	return [
		common({
			...base,
			id: "maintenance.core-withdrawal-check",
			risk: "read-only",
			title: "Check Core balance and withdrawal readiness",
			description: "Read a direct account's free/allocated balances, collateral decimals and cooldown without signing.",
			prepare: ctx => prepare(ctx, true),
			plan: () => [WITHDRAWAL_STEPS[0]],
			run: async (ctx, input) => {
				await ctx.step("inspect", WITHDRAWAL_STEPS[0].title, async () => {
					const r = await runWithdrawalAdapter(ctx, input, "inspect");
					ctx.ui.note(
						`${withdrawalPreview(r.plan)}\nCurrent free-balance withdrawal time: ${new Date(r.snapshot.withdrawableAt * 1000).toISOString()}\nThis is not solvency proof for deallocation; no signature was fetched and no transaction sent.`,
						"Core balance check",
					);
				});
			},
		}),
		common({
			...base,
			id: "maintenance.core-withdrawal",
			risk: "transaction",
			title: "Deallocate and withdraw Core collateral",
			description: "Fetch Muon signatures, deallocate, resume after cooldown, and prove the collateral withdrawal.",
			prepare: ctx => prepare(ctx),
			signerPolicy: input => ({
				role: "Core balance owner",
				expectedAddress: input.account,
				allowedModes:
					input.network === "localhost"
						? [SIGNER_MODES.LOCAL_NODE]
						: [SIGNER_MODES.KEYSTORE, SIGNER_MODES.LEDGER, SIGNER_MODES.PRIVATE_KEY],
			}),
			plan: () => WITHDRAWAL_STEPS,
			validateResume: (ctx, input) => {
				if (fs.existsSync(path.join(withdrawalDirectory(ctx), "report.json"))) readWithdrawalReport(ctx, input);
			},
			reconcile,
			run: async (ctx, input) => {
				const step = (id, fn) => ctx.step(id, WITHDRAWAL_STEPS.find(s => s.id === id).title, fn);
				await step("inspect", () => runWithdrawalAdapter(ctx, input, "inspect"));
				await step("authorize", async () => {
					const report = readWithdrawalReport(ctx, input);
					ctx.ui.note(withdrawalPreview(report.plan), "Review exact account, recipient and amount");
					const phrase = `WITHDRAW ${input.chainId} ${report.plan.digest.slice(0, 12)}`;
					const response = await ctx.ui.text({
						message: `Type ${phrase} to authorize this plan`,
						validate: v => (v === phrase ? undefined : "Enter the exact confirmation phrase"),
					});
					if (response !== phrase)
						return ctx.wait("Withdrawal plan not approved. Review the account, amount and recipient before continuing.");
					report.approvedDigest = report.plan.digest;
					atomicWrite(path.join(withdrawalDirectory(ctx), "report.json"), report);
				});
				for (const phase of ["deallocate", "initiate", "ready", "withdraw"])
					await step(phase, async () => {
						const report = readWithdrawalReport(ctx, input);
						if (phase === "ready") {
							if (BigInt(report.plan.withdrawInternal) === 0n) return;
							const fresh = await runWithdrawalAdapter(ctx, input, "ready");
							if (!fresh.readiness.ready)
								return ctx.wait(
									`Withdrawal cooldown ends at ${new Date(fresh.readiness.readyAt * 1000).toISOString()}. Resume this same task then; deallocation will not repeat.`,
								);
							return;
						}
						const op = report.operations?.[phase];
						let transaction = "";
						if (op && op.status !== "confirmed") {
							transaction = await ctx.ui.text({
								message: `Interrupted ${phase} at nonce ${op.nonce}: original or replacement transaction hash (never automatically resent)`,
								initialValue: op.hash || "",
								validate: v => (/^0x[0-9a-fA-F]{64}$/.test(v) ? undefined : "Enter the transaction hash"),
							});
							if (!transaction) return ctx.wait("Resolve the interrupted transaction before continuing.");
						}
						const needed =
							phase === "deallocate"
								? BigInt(report.plan.deallocate) > 0n
								: BigInt(report.plan.withdrawInternal) > 0n && (phase !== "initiate" || report.plan.route === "classic");
						await runWithdrawalAdapter(ctx, input, phase, { execute: needed && !op, transaction });
					});
				await step("verify", async () => {
					await runWithdrawalAdapter(ctx, input, "verify");
					ctx.ui.note(`Core operation verified. Evidence: ${withdrawalDirectory(ctx)}`, "Complete");
				});
			},
		}),
	];
}
