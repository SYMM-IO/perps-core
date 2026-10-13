import { createTaskRunner } from "../../cli/task-runner.js";
import { TASK_DEFINITIONS } from "../../cli/tasks/registry.js";
import { assertIntentTransaction, codeHash } from "./model.js";
import { assertPeripheralInputs } from "./peripherals.js";
import { Transaction, getAddress, Interface } from "ethers";

// The generic sequence uses the same durable task lock and tx-intent protocol as
// Diamond upgrades. No retry is permitted while a wallet outcome is unknown.
export function createQueueRunner({ root, load, loadRecovery = load, save, provider, verify, activity }) {
	const taskId = "maintenance.system-upgrade";
	async function reconcile(r, ctx) {
		const p = provider(),
			unresolved = [],
			failed = [];
		for (const j of Object.values(r.journal || {})) {
			if (!j.hash) {
				unresolved.push(j.id);
				continue;
			}
			const tx = await p.getTransaction(j.hash);
			if (!tx) {
				unresolved.push(j.hash);
				continue;
			}
			assertIntentTransaction(tx, j.request, j.sender);
			const receipt = await p.getTransactionReceipt(j.hash);
			if (!receipt) {
				unresolved.push(j.hash);
				continue;
			}
			j.status = receipt.status === 1 ? "confirmed" : "failed";
			if (receipt.status !== 1) failed.push(j.hash);
			ctx?.emit(receipt.status === 1 ? "tx.confirmed" : "tx.failed", {
				transaction: { hash: j.hash, status: j.status, blockNumber: receipt.blockNumber },
			});
			ctx?.emit("tx.intent.resolved", { id: j.id });
		}
		save(r);
		return { unresolved, failed };
	}
	function adjustedPlan(r) {
		const plan = structuredClone(r.plan);
		const completed = r.plan.actions.filter(a => r.journal?.[a.id]?.status === "confirmed");
		for (const a of completed) {
			if (a.method === "upgradeToAndCall") plan.storagePins[a.to] = a.args[0];
			for (const read of plan.reads) {
				if (read.to.toLowerCase() !== a.to?.toLowerCase()) continue;
				if (["grantRole", "revokeRole"].includes(a.method)) {
					const reverse = a.args[0].length === 42;
					const i = new Interface([
						reverse ? "function hasRole(address,bytes32) view returns(bool)" : "function hasRole(bytes32,address) view returns(bool)",
					]);
					if (i.encodeFunctionData("hasRole", a.args) === read.data)
						read.result = i.encodeFunctionResult("hasRole", [a.method === "grantRole"]);
				}
				if (a.method === "setSignatureVerifierAddress") {
					const i = new Interface(["function getSignatureVerifier() view returns(address)"]);
					if (read.data === i.encodeFunctionData("getSignatureVerifier"))
						read.result = i.encodeFunctionResult("getSignatureVerifier", [a.args[0]]);
				}
			}
		}
		return plan;
	}
	async function preflight(r) {
		await assertPeripheralInputs(provider(), adjustedPlan(r), { nonce: r.journal?.[r.plan.actions[0].id]?.status !== "confirmed" });
		if (
			r.journal?.[r.plan.actions[0].id]?.status === "confirmed" &&
			codeHash(await provider().getCode(r.plan.replacement)) !== r.rehearsal.expectedRuntime
		)
			throw new Error("Deployed replacement differs from rehearsal");
	}
	async function sendAction(r, a, ctx, mode) {
		const p = provider();
		await preflight(r);
		const nonce = await p.getTransactionCount(a.sender, "pending");
		if (a.nonce !== undefined && nonce !== a.nonce) throw new Error("Deployment nonce changed; prepare a new plan");
		const fees = await p.getFeeData(),
			request = {
				...(a.to ? { to: a.to } : {}),
				data: a.data,
				value: "0",
				chainId: r.plan.chainId,
				nonce,
				gasLimit: (((await p.estimateGas({ ...(a.to ? { to: a.to } : {}), from: a.sender, data: a.data })) * 120n) / 100n).toString(),
				...(fees.maxFeePerGas !== null
					? { type: 2, maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() }
					: { type: 0, gasPrice: fees.gasPrice.toString() }),
			};
		const j = { id: a.id, sender: a.sender, request, status: "awaiting-signature" };
		r.journal[a.id] = j;
		save(r);
		ctx.emit("tx.intent", { id: a.id });
		let tx;
		if (mode === "browser") {
			const response = await ctx.ui.transaction({ id: a.id, sender: a.sender, request, label: a.label });
			if (response.rejected) {
				delete r.journal[a.id];
				save(r);
				ctx.emit("tx.intent.resolved", { id: a.id });
				throw new Error("Wallet rejected before broadcast");
			}
			j.hash = response.hash;
			j.status = "submitted";
			save(r);
			tx = await p.getTransaction(j.hash);
			if (!tx) ctx.wait("Transaction is not indexed yet; continue after RPC indexing");
			assertIntentTransaction(tx, request, a.sender);
		} else {
			let transport;
			try {
				const [{ LedgerSigner }, m] = await Promise.all([import("@ethers-ext/signer-ledger"), import("@ledgerhq/hw-transport-node-hid")]);
				transport = await (m.default?.default || m.default).create();
				const signer = new LedgerSigner(transport, p, r.execution.ledgerPath || "m/44'/60'/0'/0/0");
				if (getAddress(await signer.getAddress()) !== a.sender) throw new Error("Ledger address differs from the reviewed signer");
				const raw = await signer.signTransaction(request),
					signed = Transaction.from(raw);
				assertIntentTransaction(signed, request, a.sender);
				j.hash = signed.hash;
				j.status = "submitted";
				save(r);
				tx = await p.broadcastTransaction(raw);
			} catch (e) {
				if (!j.hash) {
					delete r.journal[a.id];
					save(r);
					ctx.emit("tx.intent.resolved", { id: a.id });
				}
				throw e;
			} finally {
				await transport?.close();
			}
		}
		const { send } = await import("../../tasks/deploy/tx.ts");
		await ctx.runCallable(a.id, () => send(Promise.resolve(tx), a.label, 1));
		const result = await reconcile(r, ctx);
		if (result.unresolved.length) ctx.wait("Waiting for submitted transaction confirmation");
		if (result.failed.length) throw new Error("A transaction reverted. Reconcile and cancel before preparing a new plan.");
	}
	const def = {
		id: taskId,
		version: 1,
		category: "maintenance",
		risk: "transaction",
		title: "System contract upgrade",
		description: "Execute a rehearsed system transaction sequence",
		supportedNetworks: ["any"],
		inputs: [{ id: "planId", type: "string", required: true }],
		artifacts: [".symmio/workbench/system"],
		transactionJournal: true,
		resumePolicy: { strategy: "stable-step-id", sourceDrift: "refuse", inputDrift: "refuse" },
		cancellationPolicy: { rollback: false, reconcileSubmittedTransactions: true, unresolvedOutcome: "cancel_pending" },
		prepare: async () => {
			throw new Error("Prepare in the system workspace");
		},
		plan: async (_c, input) => load(input.planId).plan.actions.map(a => ({ id: a.id, title: a.label, phase: a.phase })),
		reconcile: async (ctx, input) => reconcile(loadRecovery(input.planId), ctx),
		run: async (ctx, input) => {
			const r = load(input.planId);
			r.journal ||= {};
			if (r.rehearsal?.status !== "passed") throw new Error("A successful rehearsal is required");
			const outcome = await reconcile(r, ctx);
			if (outcome.unresolved.length) ctx.wait(`Resolve wallet outcome: ${outcome.unresolved.join(", ")}`);
			if (outcome.failed.length) throw new Error("A prior transaction reverted; cancel and prepare a new plan");
			if (r.execution.upgradeMode === "safe" && r.journal[r.plan.actions[0].id]?.status === "confirmed") {
				try {
					r.verification = await verify(provider(), r.plan, r.rehearsal.expectedRuntime);
					r.status = "verified";
					save(r);
					return { status: "verified" };
				} catch {
					/* Pending external execution is not success. */
				}
			}
			for (const a of r.plan.actions)
				await ctx.step(a.id, a.label, async () => {
					if (r.journal[a.id]?.status === "confirmed") return;
					if (a.to && r.execution.upgradeMode === "safe") {
						await preflight(r);
						ctx.wait("Deployment confirmed. Export and execute the Safe batch, then continue to verify.");
					}
					await sendAction(r, a, ctx, a.phase === "deploy" ? r.execution.deploymentMode : r.execution.upgradeMode);
				});
			r.verification = await verify(provider(), r.plan, r.rehearsal.expectedRuntime);
			r.status = "verified";
			save(r);
			return { status: "verified" };
		},
	};
	def.handler = def.run;
	const runner = createTaskRunner({ root, definitions: [...TASK_DEFINITIONS, def] });
	return {
		active: () => runner.getActive(),
		execute: async (id, input, ui) => {
			if (runner.getActive()) throw new Error("Continue or cancel the active operator task first");
			const r = load(id);
			if (input.confirmation !== `${r.plan.chainId}:${id.slice(0, 8)}`) throw new Error("Confirm the chain and plan ID");
			if (!["browser", "ledger"].includes(input.deploymentMode) || !["browser", "ledger", "safe"].includes(input.upgradeMode))
				throw new Error("Invalid signing mode");
			if (r.rehearsal?.status !== "passed") throw new Error("Rehearse first");
			const code = await provider().getCode(r.plan.authority);
			if (input.upgradeMode !== "safe" && code !== "0x") throw new Error("Use Safe for a contract authority");
			if (input.upgradeMode === "safe") {
				const i = new Interface(["function getOwners() view returns(address[])", "function getThreshold() view returns(uint256)"]);
				const owners = i.decodeFunctionResult(
						"getOwners",
						await provider().call({ to: r.plan.authority, data: i.encodeFunctionData("getOwners") }),
					)[0],
					threshold = i.decodeFunctionResult(
						"getThreshold",
						await provider().call({ to: r.plan.authority, data: i.encodeFunctionData("getThreshold") }),
					)[0];
				if (threshold < 1n || threshold > BigInt(owners.length)) throw new Error("Authority does not pass Safe checks");
			}
			r.execution = {
				deploymentMode: input.deploymentMode,
				upgradeMode: input.upgradeMode,
				...(input.ledgerPath ? { ledgerPath: input.ledgerPath } : {}),
			};
			save(r);
			return runner.start(taskId, { input: { planId: id, ...r.execution }, ui, onEvent: e => activity(e.message || e.title || e.type) });
		},
		resume: ui => {
			if (runner.getActive()?.taskId !== taskId) throw new Error("Continue the active task in its original workspace");
			return runner.resumeActive({ ui, onEvent: e => activity(e.message || e.title || e.type) });
		},
		cancel: () => {
			if (runner.getActive()?.taskId !== taskId) throw new Error("Cancel the active task in its original workspace");
			return runner.cancelActive();
		},
		attach: async (id, actionId, hash) => {
			const r = loadRecovery(id),
				j = r.journal?.[actionId];
			if (!j || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error("Choose a pending action and its transaction hash");
			assertIntentTransaction(await provider().getTransaction(hash), j.request, j.sender);
			j.hash = hash;
			save(r);
			return reconcile(r);
		},
	};
}
