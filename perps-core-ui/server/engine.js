import { createSafeBatch } from "../../cli/signer/safe-batch.js";
import { createTaskRunner } from "../../cli/task-runner.js";
import { TASK_DEFINITIONS } from "../../cli/tasks/registry.js";
import { ROOT, loadBuild, sourceIdentity, validateBuild } from "./build.js";
import { rpcProvider, inspect, assertSnapshot, verifyMap, createFork } from "./chain.js";
import { address, assertIntentTransaction, canonical, codeHash, digest, encodeCut, linkBytecode, runtimeBytecode } from "./model.js";
import { preparePlan, resolveRouting } from "./planner.js";
import { getCreateAddress, Transaction, toQuantity } from "ethers";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export function atomicWrite(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
}
export function createEngine({
	root = ROOT,
	stateRoot = path.join(root, ".symmio/workbench"),
	providerFactory = rpcProvider,
	forkFactory = createFork,
	onChange = () => {},
} = {}) {
	let endpoint,
		provider,
		latestBuild,
		baseline,
		snapshot,
		busy = false;
	const current = { activity: "Connect to a deployment to begin", error: null, task: null };
	const file = id => {
		if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid plan ID");
		return path.join(stateRoot, "plans", `${id}.json`);
	};
	const read = id => JSON.parse(fs.readFileSync(file(id), "utf8"));
	const save = record => {
		atomicWrite(file(record.plan.id), record);
		onChange();
	};
	const activity = value => {
		current.activity = value;
		onChange();
	};
	const requireProvider = () => {
		if (!provider) throw new Error("Connect the RPC endpoint again before continuing");
		return provider;
	};
	const requireReady = record => {
		if (record.plan.blockers.length) throw new Error(record.plan.blockers.join(" "));
		if (sourceIdentity(root).digest !== record.plan.source.digest) throw new Error("Checkout inputs changed. Compile and prepare a new plan.");
		if (record.build.digest !== record.plan.buildDigest) throw new Error("Saved build does not match the plan");
		validateBuild(record.build);
		const { id, createdAt, ...body } = record.plan;
		if (digest(body) !== id) throw new Error("Saved plan checksum mismatch");
	};
	async function guarded(action) {
		if (busy) throw new Error("Another workbench operation is running");
		busy = true;
		current.error = null;
		onChange();
		try {
			return await action();
		} catch (error) {
			current.error = cleanError(error);
			onChange();
			throw new Error(current.error);
		} finally {
			busy = false;
			onChange();
		}
	}
	function cleanError(error) {
		return [error.shortMessage || error.message || String(error), error.info?.error?.message || error.error?.message]
			.filter(Boolean)
			.join(": ")
			.replace(/(?:https?|wss?):\/\/[^\s'"<>]+/g, "<rpc>")
			.slice(0, 2000);
	}
	async function verifyDeployments(record, connection = provider) {
		for (const [deployed, expected] of Object.entries(record.plan.supportingCode || {})) {
			if (codeHash(await connection.getCode(deployed)) !== expected) throw new Error(`Linked library bytecode changed: ${deployed}`);
		}
		for (const item of record.plan.deployments) {
			if (!record.deployed[item.name]) continue;
			const a = record.build.catalog[item.name];
			const expected = runtimeBytecode(a, { ...record.plan.bindings, ...record.deployed }, record.deployed[item.name]);
			if ((await connection.getCode(record.deployed[item.name])).toLowerCase() !== expected.toLowerCase())
				throw new Error(`Runtime bytecode mismatch for ${item.name}`);
		}
	}
	async function rehearseRecord(record) {
		requireReady(record);
		const fresh = await assertSnapshot(requireProvider(), record.plan.snapshot);
		await verifyDeployments(record);
		activity("Creating an isolated fork and rehearsing the upgrade");
		const fork = await forkFactory(endpoint, fresh);
		const gas = [],
			deployed = { ...record.deployed };
		try {
			const forkState = await inspect(fork.provider, fresh.target);
			if (forkState.fingerprint !== fresh.fingerprint) throw new Error("Fork state differs from the pinned chain snapshot");
			const deployer = await fork.impersonate(record.plan.deployer);
			for (const item of record.plan.deployments) {
				if (deployed[item.name]) continue;
				const a = record.build.catalog[item.name];
				const data = linkBytecode(a.bytecode, a.linkReferences, { ...record.plan.bindings, ...deployed });
				const receipt = await (await deployer.sendTransaction({ data })).wait();
				if (receipt.status !== 1) throw new Error(`Rehearsal deployment failed: ${item.name}`);
				deployed[item.name] = receipt.contractAddress;
				gas.push({ action: `Deploy ${item.name}`, gasUsed: receipt.gasUsed.toString() });
			}
			const routing = resolveRouting(record.plan, record.build, deployed);
			if (routing.changes.length) {
				const owner = await fork.impersonate(fresh.owner);
				const receipt = await (await owner.sendTransaction({ to: fresh.target, data: encodeCut(routing.changes) })).wait();
				if (receipt.status !== 1) throw new Error("Rehearsal Diamond cut reverted");
				gas.push({ action: "Diamond cut", gasUsed: receipt.gasUsed.toString() });
			}
			await verifyDeployments({ ...record, deployed }, fork.provider);
			await verifyMap(fork.provider, fresh, routing.finalMap);
			const result = {
				status: "passed",
				at: new Date().toISOString(),
				planId: record.plan.id,
				blockNumber: fresh.blockNumber,
				blockHash: fresh.blockHash,
				deployedDigest: digest(record.deployed),
				gas,
				checks: [
					"Pinned fork state",
					gas.some(g => g.action.startsWith("Deploy ")) ? "Deployment and linking" : "No deployments required",
					routing.changes.length ? "Atomic Diamond cut" : "Selector map already matches; no cut required",
					"Complete selector map and runtime bytecode",
					"Diamond code and owner",
				],
				limitations: [
					"Upgrade authority impersonated on the fork; wallet and Safe signature collection is not exercised.",
					"This checks upgrade mechanics. Trading, liquidation, and accounting scenarios are not certified by this rehearsal.",
				],
			};
			record.rehearsal = result;
			save(record);
			activity("Fork rehearsal passed");
			return result;
		} catch (error) {
			record.rehearsal = { status: "failed", at: new Date().toISOString(), error: cleanError(error) };
			save(record);
			throw error;
		} finally {
			await fork.close();
		}
	}
	async function reconcileRecord(record, ctx) {
		requireProvider();
		const unresolved = [],
			failed = [];
		for (const journal of Object.values(record.journal)) {
			if (!journal.hash) {
				unresolved.push(`Unsigned or unknown outcome: ${journal.id}`);
				continue;
			}
			const tx = await provider.getTransaction(journal.hash);
			if (!tx) {
				unresolved.push(journal.hash);
				continue;
			}
			assertIntentTransaction(tx, journal.request, journal.sender);
			const receipt = await provider.getTransactionReceipt(journal.hash);
			if (!receipt) {
				unresolved.push(journal.hash);
				continue;
			}
			if (receipt.status !== 1) {
				journal.status = "failed";
				failed.push(journal.hash);
				ctx?.emit("tx.failed", { transaction: { hash: journal.hash, status: "failed" } });
				ctx?.emit("tx.intent.resolved", { id: journal.id });
				continue;
			}
			journal.status = "confirmed";
			journal.blockNumber = receipt.blockNumber;
			if (journal.component) record.deployed[journal.component] = receipt.contractAddress;
			ctx?.emit("tx.confirmed", { transaction: { hash: journal.hash, status: "confirmed", blockNumber: receipt.blockNumber } });
			ctx?.emit("tx.intent.resolved", { id: journal.id });
		}
		save(record);
		return { unresolved, failed };
	}
	async function sendRequest(record, id, request, sender, mode, ctx, component) {
		if (record.journal[id]) {
			const { unresolved } = await reconcileRecord(record, ctx);
			if (unresolved.length) ctx.wait(`Reconcile the pending transaction before continuing: ${unresolved.join(", ")}`);
			return;
		}
		if (!["browser", "ledger"].includes(mode)) throw new Error("Select a browser wallet or Ledger for this transaction");
		await assertSnapshot(provider, record.plan.snapshot);
		await verifyDeployments(record);
		const nonce = await provider.getTransactionCount(sender, "pending");
		const fees = await provider.getFeeData();
		const gasLimit = ((await provider.estimateGas({ ...request, from: sender })) * 120n) / 100n;
		const txRequest = {
			...request,
			value: "0",
			chainId: record.plan.snapshot.chainId,
			nonce,
			gasLimit: gasLimit.toString(),
			...(fees.maxFeePerGas !== null
				? { type: 2, maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() }
				: { type: 0, gasPrice: fees.gasPrice.toString() }),
		};
		const journal = { id, component, sender, request: txRequest, status: "awaiting-signature", createdAt: new Date().toISOString() };
		record.journal[id] = journal;
		save(record); // Persist intent BEFORE opening the wallet/device.
		ctx.emit("tx.intent", { id });
		let tx;
		if (mode === "browser") {
			if (!ctx.ui?.transaction) throw new Error("Continue this task from the browser workbench");
			const response = await ctx.ui.transaction({
				id,
				sender,
				request: txRequest,
				label: component ? `Deploy ${component}` : "Execute Diamond cut",
			});
			if (response.rejected === true) {
				delete record.journal[id];
				save(record);
				ctx.emit("tx.intent.resolved", { id });
				throw new Error("Wallet request rejected before broadcast");
			}
			journal.hash = response.hash;
			journal.status = "submitted";
			save(record);
			tx = await provider.getTransaction(journal.hash);
			if (!tx) ctx.wait(`Waiting for RPC to index ${journal.hash}. Continue once the transaction is visible.`);
			assertIntentTransaction(tx, txRequest, sender);
		} else {
			let transport;
			try {
				const [{ LedgerSigner }, transportModule] = await Promise.all([
					import("@ethers-ext/signer-ledger"),
					import("@ledgerhq/hw-transport-node-hid"),
				]);
				const Transport = transportModule.default?.default || transportModule.default;
				transport = await Transport.create();
				const signer = new LedgerSigner(transport, provider, record.execution.ledgerPath || "m/44'/60'/0'/0/0");
				if (address(await signer.getAddress()) !== address(sender)) throw new Error("Ledger address differs from the selected signer");
				activity("Confirm the transaction on your Ledger");
				const raw = await signer.signTransaction(txRequest);
				const signed = Transaction.from(raw);
				assertIntentTransaction(signed, txRequest, sender);
				journal.hash = signed.hash;
				journal.status = "submitted";
				save(record);
				tx = await provider.broadcastTransaction(raw);
			} catch (error) {
				// No broadcast is attempted until the signed hash has been persisted.
				if (!journal.hash) {
					delete record.journal[id];
					save(record);
					ctx.emit("tx.intent.resolved", { id });
				}
				throw error;
			} finally {
				await transport?.close();
			}
		}
		const { send } = await import("../../tasks/deploy/tx.ts");
		await ctx.runCallable(id, () =>
			send(Promise.resolve(tx), id, 1, {
				onSubmitted: transaction => {
					journal.hash = transaction.hash;
					journal.status = "submitted";
					save(record);
				},
			}),
		);
		const outcome = await reconcileRecord(record, ctx);
		if (outcome.unresolved.length) ctx.wait(`Awaiting confirmation: ${outcome.unresolved.join(", ")}`);
		if (component && record.deployed[component] !== getCreateAddress({ from: sender, nonce }))
			throw new Error("Unexpected deployed contract address");
	}
	const definition = {
		id: "maintenance.upgrade-workbench",
		version: 1,
		category: "maintenance",
		risk: "transaction",
		title: "Core Diamond upgrade",
		description: "Execute a reviewed workbench plan",
		supportedNetworks: ["any"],
		inputs: [{ id: "planId", type: "string", label: "Plan", required: true }],
		artifacts: [".symmio/workbench/plans"],
		transactionJournal: true,
		resumePolicy: { strategy: "stable-step-id", sourceDrift: "refuse", inputDrift: "refuse" },
		cancellationPolicy: { rollback: false, reconcileSubmittedTransactions: true, unresolvedOutcome: "cancel_pending" },
		prepare: async () => {
			throw new Error("Prepare a plan in the browser workbench");
		},
		plan: async (_ctx, input) => [
			...read(input.planId).plan.deployments.map(item => ({ id: item.id, title: `Deploy ${item.name}`, phase: "deploy" })),
			{ id: "cut", title: "Rehearse and execute the Diamond cut", phase: "upgrade" },
			{ id: "verify", title: "Verify the upgraded system", phase: "verify" },
		],
		reconcile: async (ctx, input) => reconcileRecord(read(input.planId), ctx),
		run: async (ctx, input) => {
			const record = read(input.planId);
			requireReady(record);
			requireProvider();
			if (record.rehearsal?.status !== "passed" || record.rehearsal.planId !== record.plan.id)
				throw new Error("A matching successful fork rehearsal is required");
			const pending = await reconcileRecord(record, ctx);
			if (pending.unresolved.length) ctx.wait(`Reconcile the pending action: ${pending.unresolved.join(", ")}`);
			if (pending.failed.length)
				throw new Error(`Transaction reverted: ${pending.failed.join(", ")}. Cancel this task and prepare a new plan.`);
			for (const item of record.plan.deployments)
				await ctx.step(item.id, `Deploy ${item.name}`, async () => {
					if (!record.deployed[item.name]) {
						const artifact = record.build.catalog[item.name];
						const data = linkBytecode(artifact.bytecode, artifact.linkReferences, { ...record.plan.bindings, ...record.deployed });
						await sendRequest(record, item.id, { data }, record.plan.deployer, input.deploymentMode, ctx, item.name);
					}
					await verifyDeployments(record);
				});
			await ctx.step("cut", "Rehearse and execute the Diamond cut", async () => {
				const routing = resolveRouting(record.plan, record.build, record.deployed);
				const fresh = await inspect(provider, record.plan.snapshot.target);
				if (canonical(fresh.map) === canonical(routing.finalMap)) {
					await verifyMap(provider, record.plan.snapshot, routing.finalMap);
					return;
				}
				await assertSnapshot(provider, record.plan.snapshot);
				await rehearseRecord(record); // Exact deployed addresses, not the predicted first rehearsal.
				record.final = { ...routing, data: encodeCut(routing.changes) };
				save(record);
				if (input.upgradeMode === "safe") {
					if (record.plan.snapshot.authority.kind !== "safe") throw new Error("The upgrade authority did not pass Safe interface checks");
					record.safe = createSafeBatch({
						chainId: record.plan.snapshot.chainId,
						safeAddress: record.plan.snapshot.owner,
						name: `Core upgrade ${record.plan.id.slice(0, 8)}`,
						description: `Reviewed plan ${record.plan.id}`,
						actions: [
							{
								to: record.plan.snapshot.target,
								data: record.final.data,
								value: "0",
								description: "Apply the reviewed Core Diamond cut",
							},
						],
					});
					save(record);
					ctx.wait("Download the Safe batch, execute it in Safe, then continue here to verify the chain state.");
				}
				if (record.plan.snapshot.authority.kind !== "eoa") throw new Error("Contract-owned upgrades must use the Safe workflow");
				await sendRequest(
					record,
					"cut",
					{ to: record.plan.snapshot.target, data: record.final.data },
					record.plan.snapshot.owner,
					input.upgradeMode,
					ctx,
				);
			});
			await ctx.step("verify", "Verify the upgraded system", async () => {
				await verifyDeployments(record);
				const routing = resolveRouting(record.plan, record.build, record.deployed);
				record.verification = await verifyMap(provider, record.plan.snapshot, routing.finalMap);
				record.status = "verified";
				record.completedAt = new Date().toISOString();
				save(record);
			});
			return { planId: record.plan.id, status: "verified" };
		},
	};
	definition.handler = definition.run;
	const runner = createTaskRunner({ root, definitions: [...TASK_DEFINITIONS, definition] });
	return {
		status: () => ({
			...current,
			busy,
			connected: !!provider,
			build: latestBuild
				? {
						scope: latestBuild.scope,
						digest: latestBuild.digest,
						source: latestBuild.source,
						catalog: Object.values(latestBuild.catalog).map(({ name, kind, selectors, dependencies }) => ({
							name,
							kind,
							selectors,
							dependencies,
						})),
					}
				: null,
			snapshot,
			baseline: baseline ? { digest: baseline.digest, source: baseline.source } : null,
			active: runner.getActive(),
			history: fs.existsSync(path.join(stateRoot, "plans"))
				? fs
						.readdirSync(path.join(stateRoot, "plans"))
						.filter(n => /^[a-f0-9]{64}\.json$/.test(n))
						.map(n => {
							const r = read(n.slice(0, -5));
							return {
								id: r.plan.id,
								target: r.plan.snapshot.target,
								scope: r.plan.scope || "core",
								chainId: r.plan.snapshot.chainId,
								createdAt: r.plan.createdAt,
								status: r.status,
								changes: r.plan.changes.length,
							};
						})
						.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
				: [],
		}),
		read,
		connect: (url, target) =>
			guarded(async () => {
				if (runner.getActive()?.runner.running) throw new Error("An execution task is running");
				const next = providerFactory(url);
				try {
					const nextSnapshot = await inspect(next, target);
					provider?.destroy?.();
					provider = next;
					endpoint = url;
					snapshot = nextSnapshot;
					activity("Deployment inspected");
					return snapshot;
				} catch (e) {
					next.destroy?.();
					throw e;
				}
			}),
		compile: (scope = "core") =>
			guarded(async () => {
				if (runner.getActive()) throw new Error("Finish or cancel the active operator task before rebuilding");
				activity("Compiling the current checkout");
				const before = sourceIdentity(root);
				await exec(path.join(root, "node_modules/.bin/hardhat"), ["compile"], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
				latestBuild = await loadBuild(root, scope);
				if (before.digest !== latestBuild.source.digest) throw new Error("Source changed during compilation; compile again");
				activity("Build ready");
				return { digest: latestBuild.digest };
			}),
		build: () => {
			if (!latestBuild) throw new Error("Compile first");
			return latestBuild;
		},
		importBaseline: value => {
			baseline = validateBuild(value);
			onChange();
			return { digest: baseline.digest };
		},
		prepare: input =>
			guarded(async () => {
				if (!latestBuild || !snapshot) throw new Error("Compile and inspect a deployment first");
				if (sourceIdentity(root).digest !== latestBuild.source.digest) throw new Error("Source changed; compile again");
				await assertSnapshot(provider, snapshot);
				const plan = await preparePlan({ ...input, snapshot, build: latestBuild, baseline, provider });
				const record = { plan, build: latestBuild, deployed: {}, journal: {}, status: "prepared" };
				if (!fs.existsSync(file(plan.id))) save(record);
				activity("Upgrade plan prepared");
				return read(plan.id);
			}),
		rehearse: id => guarded(() => rehearseRecord(read(id))),
		execute: (id, input, ui) =>
			guarded(async () => {
				if (runner.getActive()) throw new Error("Continue or cancel the active task before starting another upgrade");
				const record = read(id);
				requireReady(record);
				if (input.confirmation !== `${record.plan.snapshot.chainId}:${id.slice(0, 8)}`)
					throw new Error("Execution confirmation does not match the chain and plan");
				if (!["browser", "ledger"].includes(input.deploymentMode) || !["browser", "ledger", "safe"].includes(input.upgradeMode))
					throw new Error("Invalid signer mode");
				if ((input.upgradeMode === "safe") !== (record.plan.snapshot.authority.kind === "safe"))
					throw new Error("Select Safe for a Safe-owned Diamond, or a browser wallet/Ledger for an EOA-owned Diamond");
				if (input.ledgerPath && !/^m\/44'\/60'\/\d+'\/\d+\/\d+$/.test(input.ledgerPath))
					throw new Error("Use a full Ethereum Ledger derivation path");
				record.execution = {
					deploymentMode: input.deploymentMode,
					upgradeMode: input.upgradeMode,
					...(input.ledgerPath ? { ledgerPath: input.ledgerPath } : {}),
				};
				save(record);
				const result = await runner.start(definition.id, {
					input: { planId: id, ...record.execution },
					ui,
					onEvent: event => {
						activity(event.type === "task.completed" ? "Upgrade verified" : event.message || event.title || event.type);
					},
				});
				current.task = result;
				return result;
			}),
		resume: ui =>
			guarded(async () => {
				const active = runner.getActive();
				if (active?.taskId !== definition.id) throw new Error("Continue the active CLI task in ./symmio");
				const record = read(active.input.planId);
				record.execution = active.input;
				save(record);
				const result = await runner.resumeActive({
					ui,
					onEvent: e => activity(e.type === "task.completed" ? "Upgrade verified" : e.message || e.title || e.type),
				});
				current.task = result;
				return result;
			}),
		cancel: () =>
			guarded(async () => {
				if (runner.getActive()?.taskId !== definition.id) throw new Error("Cancel the active CLI task in ./symmio");
				return runner.cancelActive();
			}),
		attachHash: (id, actionId, hash) =>
			guarded(async () => {
				const record = read(id);
				const journal = record.journal[actionId];
				if (!journal || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error("Select a pending action and enter its transaction hash");
				const tx = await requireProvider().getTransaction(hash);
				assertIntentTransaction(tx, journal.request, journal.sender);
				journal.hash = hash;
				save(record);
				return reconcileRecord(record);
			}),
		close: () => provider?.destroy?.(),
	};
}
