import { check, digest, json, PHASES, validateInput, verifyPlan } from "../../deployment-tooling/disputed-settlement.js";
import { CHAINS, rpcEnvKey } from "../lib/context.js";
import { PROJECT_ROOT } from "../lib/paths.js";
import { hydrateSigner, SIGNER_MODES, signerEnvironment } from "../signer/index.js";
import { atomicWrite } from "./guided-recipe.js";
import { formatUnits } from "ethers";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
export const SETTLEMENT_STEPS = [
	["inspect", "prepare", "Read the disputed account and calculate input-file shares"],
	["authorize", "authorization", "Review exact payouts and authorize the admin transactions"],
	["grant", "execution", "Grant the admin a temporary clearing-house role if needed"],
	["takeover", "execution", "Take over this disputed liquidation"],
	["payment", "execution", "Apply the reviewed settlement shares once"],
	["finalize", "execution", "Finalize liquidation and return the parent remainder"],
	["cleanup", "execution", "Revoke only the role granted by this task"],
	["verify", "verification", "Verify receipts, balances and account cleanup"],
].map(([id, phase, title]) => ({ id, phase, title }));
export function readSettlementReport(input) {
	const report = read(input.output),
		operation = read(input.input);
	check(report.inputDigest === input.inputDigest && digest(operation) === input.inputDigest, "Settlement input/report changed");
	if (report.plan) verifyPlan(report.plan, operation);
	return report;
}
export function settlementEnvironment(input, execute = false) {
	return {
		DOTENV_CONFIG_PATH: "/dev/null",
		SYMMIO_DEPLOYMENT_RECIPE: "",
		SYMMIO_RECIPE_READ_ONLY: String(!execute),
		SYMMIO_SIGNER_MODE: "",
		SYMMIO_SAFE_ACTIONS_ONLY: "false",
		SYMMIO_EXPECTED_SIGNER: "",
		USE_KEYSTORE: String(input.rpcSource === "keystore"),
		SYMMIO_RPC_URL_OVERRIDE: input.rpcSource === "public-arbitrum" ? "https://arb1.arbitrum.io/rpc" : "",
		EXECUTE: String(execute),
		DRY_RUN: "",
		CONFIRM_CHAIN_ID: execute ? String(input.chainId) : "",
	};
}
export async function runSettlementAdapter(ctx, input, phase, { execute = false, transaction = "" } = {}) {
	const env = settlementEnvironment(input, execute);
	if (execute) {
		const selection = await hydrateSigner(input.signer, ctx.ui);
		if (!selection) return ctx.wait("The admin signer is unavailable. Continue when it is ready.");
		Object.assign(env, signerEnvironment(selection));
	}
	await ctx.runProcess(
		"./node_modules/.bin/hardhat",
		[
			"internal:disputed-settlement",
			"--network",
			input.network,
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
	const report = readSettlementReport(input);
	// Recover a progress-journal entry if the process stopped after saving the hash
	// but before the shared transaction adapter could emit its submission event.
	if (ctx.state && ctx.emit)
		for (const operation of Object.values(report.operations || {})) {
			if (operation.status !== "confirmed") continue;
			const transaction = {
				...operation.journal,
				...operation.intent,
				hash: operation.hash,
				originalHash: operation.journal?.hash,
				nonce: operation.nonce,
				status: "confirmed",
				blockNumber: operation.blockNumber,
			};
			if (!ctx.state.transactions.some(t => t.hash === transaction.hash || t.hash === transaction.originalHash))
				ctx.emit("tx.submitted", { transaction });
			ctx.emit("tx.confirmed", { transaction });
		}
	return report;
}
export function settlementPreview(plan) {
	const amount = raw => `${formatUnits(raw, 18)} collateral units (${raw} raw)`;
	return [
		`Chain: ${plan.input.chainId}; Core: ${plan.input.core}`,
		`Admin signer: ${plan.input.operator}; disputed account: ${plan.input.partyA}`,
		`Liquidation: ${plan.liquidationId}; observed block: ${plan.baseline.blockNumber}`,
		`Collateral: ${plan.baseline.collateral}; internal accounting uses 18 decimals.`,
		`Input share rules:\n${json(plan.input.shares)}`,
		...plan.totals.map(t =>
			[
				`Solver ${t.partyB}:`,
				...t.markets.map(
					m =>
						`Market ${m.symbolId}:\nRecorded PnL ${amount(m.recorded.pnl)} × ${plan.input.shares.solver.pnlBps}/10000 = ${amount(m.pnl)}\nRecorded funding ${amount(m.recorded.funding)} × ${plan.input.shares.solver.fundingBps}/10000 = ${amount(m.funding)}\nRecorded CVA ${amount(m.recorded.cva)} × ${plan.input.shares.solver.cvaBps}/10000 = ${amount(m.cva)}`,
				),
				`Sum of market components: ${amount(t.credit)}. Each component rounds toward zero; dust remains with Party A.`,
			].join("\n"),
		),
		`Original recorded liquidation fee: ${amount(plan.originalLiquidatorFee)}.\nLiquidator formula: ${plan.input.shares.liquidator.basis} (${amount(plan.liquidatorBasisAmount)}) × ${plan.input.shares.liquidator.shareBps}/10000 = ${amount(plan.liquidatorFee)}${BigInt(plan.liquidatorFee) > 0n ? ` to ${plan.input.shares.liquidator.recipient}` : " (explicitly disabled by the input file)"}. Rounds down to a raw accounting unit.`,
		`Parent ${plan.baseline.virtual.parentAccount}: ${amount(plan.baseline.allocated)} − solver ${amount(plan.solverTotal)} − liquidator ${amount(plan.liquidatorFee)} = ${amount(plan.residual)}.`,
		"These move internal collateral balances. CVA is classified as realizedPnl and a liquidator payout as platformFee by the explicit-settlement interface.",
		"Each transaction is simulated with eth_call and estimated from the admin address immediately before signing. These are sequential transactions; takeover remains active if interrupted.",
		...plan.actions.map(
			a =>
				`${a.phase}: ${a.method}\nSender: ${a.from}\nTarget: ${a.to}\nNative value: ${a.value}\nArguments: ${json(a.args)}\nCalldata: ${a.data}`,
		),
	].join("\n\n");
}
export function createDisputedSettlementTask(common) {
	return common({
		id: "maintenance.disputed-settlement",
		version: 2,
		category: "maintenance",
		risk: "transaction",
		title: "Settle a disputed account using Clearing House",
		description:
			"Load a share-calculation input file, review live liquidation payouts, and let the admin sign each resumable transaction directly.",
		inputs: ["network", "chainId", "input", "output", "inputDigest", "rpcSource", "operator"].map(id => ({
			id,
			label: id,
			type: id === "chainId" ? "integer" : "string",
			required: true,
		})),
		artifacts: [
			"immutable share-calculation input",
			"decoded settlement plan and review",
			"transaction journal and receipt evidence",
			"verified final account state",
		],
		signerPolicy: input => ({
			role: "Clearing-house admin",
			allowedModes: input.network === "localhost" ? [SIGNER_MODES.LOCAL_NODE] : [SIGNER_MODES.LEDGER, SIGNER_MODES.KEYSTORE],
			initialMode: input.network === "localhost" ? SIGNER_MODES.LOCAL_NODE : SIGNER_MODES.LEDGER,
			expectedAddress: input.operator,
		}),
		prepare: async ({ ui, root = PROJECT_ROOT }) => {
			const file = await ui.text({
				message: "Disputed settlement input JSON file",
				initialValue: "tasks/config/disputed-settlement.arbitrum-652b2e.json",
				validate: value => {
					try {
						const input = read(path.resolve(root, value));
						validateInput(input);
						if (!CHAINS[input.network] || CHAINS[input.network].chainId !== input.chainId)
							return "Input network and chain ID do not match";
					} catch (e) {
						return e.message;
					}
				},
			});
			if (file === null) return null;
			const operation = read(path.resolve(root, file));
			validateInput(operation);
			check(CHAINS[operation.network]?.chainId === operation.chainId, "Input network and chain ID do not match");
			const rpcSource =
				operation.network === "localhost"
					? "local"
					: await ui.select({
							message: "RPC for inspection and admin transactions",
							initialValue: "keystore",
							options: [
								{ value: "keystore", label: `Configured ${rpcEnvKey(operation.network)} Hardhat keystore entry` },
								...(operation.network === "arbitrum"
									? [
											{
												value: "public-arbitrum",
												label: "Public Arbitrum RPC",
												hint: "The selected RPC receives read and transaction data",
											},
										]
									: []),
							],
						});
			if (rpcSource === null) return null;
			const directory = path.join(root, "tasks", "data", String(operation.chainId), "disputed-settlement", randomUUID()),
				input = path.join(directory, "input.json"),
				output = path.join(directory, "report.json");
			atomicWrite(input, operation);
			ui.note(`Share file copied to ${input}. Exact amounts will be calculated from a pinned on-chain snapshot before any transaction.`);
			return {
				network: operation.network,
				chainId: operation.chainId,
				operator: operation.operator,
				input,
				output,
				inputDigest: digest(operation),
				rpcSource,
			};
		},
		plan: () => SETTLEMENT_STEPS,
		run: async (ctx, input) => {
			const step = async (id, fn) => {
				const s = SETTLEMENT_STEPS.find(s => s.id === id);
				return ctx.step(id, s.title, fn);
			};
			await step("inspect", () => runSettlementAdapter(ctx, input, "inspect"));
			await step("authorize", async () => {
				const report = readSettlementReport(input),
					preview = settlementPreview(report.plan);
				fs.writeFileSync(path.join(path.dirname(input.output), "review.txt"), preview + "\n", { mode: 0o600 });
				ctx.ui.note(preview, "Calculated payout shares and transactions");
				const phrase = `SETTLE ${report.plan.input.partyA} ON ${input.chainId} ${report.plan.digest.slice(0, 12)}`;
				const entered = await ctx.ui.text({
					message: `Type ${phrase} to approve these exact shares and sequential admin transactions`,
					validate: value => (value === phrase ? undefined : "Enter the exact confirmation phrase"),
				});
				if (entered !== phrase) return ctx.wait("Settlement amounts have not been approved. Review the input file before continuing.");
				report.approvedDigest = report.plan.digest;
				atomicWrite(input.output, report);
			});
			for (const phase of PHASES)
				await step(phase, async () => {
					const report = readSettlementReport(input),
						action = report.plan.actions.find(a => a.phase === phase),
						op = report.operations?.[phase];
					if (!action) {
						ctx.ui.note(`No ${phase} transaction is needed by this reviewed plan.`);
						return;
					}
					let transaction = "";
					if (op && op.status !== "confirmed") {
						transaction = await ctx.ui.text({
							message: `${phase} was interrupted at nonce ${op.nonce}. Supply its original or replacement transaction hash; it will not be sent again.`,
							initialValue: op.hash || "",
							validate: value => (/^0x[0-9a-fA-F]{64}$/.test(value) ? undefined : "Enter the transaction hash"),
						});
						if (!transaction) return ctx.wait("Reconcile the interrupted transaction before continuing.");
					}
					ctx.ui.note(
						`${action.method}\nAdmin: ${input.operator}\nCore: ${action.to}\nNative value: 0\nArguments: ${json(action.args)}\nCalldata: ${action.data}`,
						"Transaction review",
					);
					await runSettlementAdapter(ctx, input, phase, { execute: !op, transaction });
				});
			await step("verify", async () => {
				const report = await runSettlementAdapter(ctx, input, "verify");
				ctx.ui.note(
					`Settlement verified for ${report.plan.input.partyA}. Liquidation and takeover are cleared; virtual account cleanup is complete. Payout shares and parent remainder are proven by receipt events. ${report.plan.baseline.role ? "The original clearing-house role was preserved." : "The temporary clearing-house role was removed."} Evidence: ${input.output}`,
				);
			});
		},
		reconcile: async (ctx, input) => {
			if (!fs.existsSync(input.output)) return { unresolved: [] };
			let report = readSettlementReport(input);
			if (Object.values(report.operations || {}).some(op => op.hash))
				try {
					report = await runSettlementAdapter(ctx, input, "reconcile");
				} catch {
					report = readSettlementReport(input);
				}
			return {
				unresolved: Object.entries(report.operations || {})
					.filter(([, op]) => op.status !== "confirmed")
					.map(([phase, op]) => op.hash || `${phase}: unknown transaction at nonce ${op.nonce}`),
			};
		},
	});
}
