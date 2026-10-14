import { createSafeBatch } from "../../cli/signer/safe-batch.js";
import { createTaskRunner } from "../../cli/task-runner.js";
import { TASK_DEFINITIONS } from "../../cli/tasks/registry.js";
import { ROOT, loadBuild, sourceIdentity, validateBuild } from "./build.js";
import { DEFAULT_LEDGER_PATH, rpcProvider, inspect, assertSnapshot, verifyMap, createFork, ledgerSigner } from "./chain.js";
import { HttpError, classify, errorMessage } from "./errors.js";
import {
	address,
	assertIntentTransaction,
	canonical,
	codeHash,
	deploymentIdentity,
	digest,
	encodeCut,
	executionConfirmation,
	journalCounts,
	linkBytecode,
	rehearsalState,
	runtimeBytecode,
} from "./model.js";
import { preparePlan, resolveRouting } from "./planner.js";
import { defaultProfiles } from "./system.js";
import { getCreateAddress, Transaction } from "ethers";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const DIAMOND_TASK_ID = "maintenance.upgrade-workbench";
/** The CLI task runner's active-task file, shared by every adapter and `./symmio`. */
export const activeTaskFile = (root = ROOT) => path.join(process.env.SYMMIO_TASK_STATE_DIR || path.join(root, ".symmio", "tasks"), "active.json");
/**
 * What the status ETag must see of the task state another process can change: the active-task file and the
 * runner lock (each atomic write is a new inode, so two writes in one millisecond still differ), and whether
 * the lock's holder is still alive. A CLI that crashes changes no file, yet the task stops reading as running.
 */
export function activeTaskStamp(directory) {
	const stamp = file => {
		try {
			const s = fs.statSync(file, { bigint: true });
			return `${s.ino.toString(36)}-${s.mtimeNs.toString(36)}-${s.size.toString(36)}`;
		} catch {
			return "0";
		}
	};
	let holder = "";
	try {
		const { pid } = JSON.parse(fs.readFileSync(path.join(directory, "runner.lock"), "utf8"));
		if (Number.isSafeInteger(pid) && pid > 0)
			try {
				process.kill(pid, 0);
				holder = "-alive";
			} catch (error) {
				holder = error?.code === "EPERM" ? "-alive" : "-gone";
			}
	} catch {
		/* No lock, or one being written: the file stamps already say so. */
	}
	return `${stamp(path.join(directory, "active.json"))}.${stamp(path.join(directory, "runner.lock"))}${holder}`;
}
export function atomicWrite(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
}
const PLAN_ID = /^[a-f0-9]{64}$/;
// The deployment a Diamond plan was prepared for, or for an older plan the listed one that holds its target.
function profileForPlan(plan) {
	return (
		(plan.deployment && defaultProfiles.find(p => p.id === plan.deployment.id && p.chainId === plan.deployment.chainId)) ||
		defaultProfiles.find(
			p => p.chainId === plan.snapshot.chainId && p.nodes.some(n => n.address.toLowerCase() === plan.snapshot.target.toLowerCase()),
		)
	);
}
export function createEngine({
	root = ROOT,
	stateRoot = path.join(root, ".symmio/workbench"),
	providerFactory = rpcProvider,
	forkFactory = createFork,
	signerFactory = ledgerSigner,
	onChange = () => {},
} = {}) {
	let endpoint,
		provider,
		latestBuild,
		baseline,
		snapshot,
		// When `snapshot` was read through `connect`; a snapshot restored from a task's plan has none and cannot be prepared from.
		inspectedAt = null,
		// The selected workspace deployment, kept so prepare can name it and reconnect can find its public RPC.
		workspaceProfile = null,
		walletWait = null,
		revision = 0,
		busy = false;
	const current = { activity: "Connect to a deployment to begin", error: null, errorInfo: null, progress: null, task: null };
	const changed = () => {
		revision++;
		onChange();
	};
	const file = id => {
		if (!PLAN_ID.test(id || "")) throw new HttpError(400, "bad-input", "Invalid plan ID");
		return path.join(stateRoot, "plans", `${id}.json`);
	};
	// Each build is stored once by digest; a plan names it with plan.buildDigest. Older records still embed theirs.
	const buildFile = value => {
		if (!PLAN_ID.test(value || "")) throw new HttpError(412, "stale-plan", "The plan names no stored build");
		return path.join(stateRoot, "builds", `${value}.json`);
	};
	let buildCache = null;
	const storedBuild = value => {
		if (buildCache?.digest !== value) buildCache = JSON.parse(fs.readFileSync(buildFile(value), "utf8"));
		return buildCache;
	};
	const raw = id => JSON.parse(fs.readFileSync(file(id), "utf8"));
	const read = id => {
		const record = raw(id);
		if (!record.build) record.build = storedBuild(record.plan.buildDigest);
		return record;
	};
	/** The record without its build, which is what the UI needs to show a plan. */
	const readPlan = id => {
		const { build, ...record } = raw(id);
		return record;
	};

	// History is indexed once and kept current by save(), so a status poll never re-reads every plan.
	const index = new Map();
	const entryFor = r => ({
		id: r.plan.id,
		family: "diamond",
		target: r.plan.snapshot.target,
		scope: r.plan.scope || "core",
		chainId: r.plan.snapshot.chainId,
		createdAt: r.plan.createdAt,
		status: r.status,
		changes: r.plan.changes.length,
		...(r.plan.deployment ? { deployment: r.plan.deployment } : {}),
		rehearsal: rehearsalState(r),
		...(r.execution || Object.keys(r.journal || {}).length ? { execution: journalCounts(r.journal) } : {}),
	});
	if (fs.existsSync(path.join(stateRoot, "plans")))
		for (const name of fs.readdirSync(path.join(stateRoot, "plans")).filter(n => /^[a-f0-9]{64}\.json$/.test(n)))
			try {
				const r = JSON.parse(fs.readFileSync(path.join(stateRoot, "plans", name), "utf8"));
				index.set(r.plan.id, entryFor(r));
			} catch {
				/* One unreadable plan must not hide the others. */
			}
	const save = record => {
		const { build, ...rest } = record;
		// A build that does not match its plan stays embedded, so requireReady can still report the mismatch.
		if (build && build.digest === record.plan.buildDigest) {
			const target = buildFile(build.digest);
			if (!fs.existsSync(target)) atomicWrite(target, build);
			atomicWrite(file(record.plan.id), rest);
		} else atomicWrite(file(record.plan.id), record);
		index.set(record.plan.id, entryFor(record));
		changed();
	};
	const activity = value => {
		current.activity = value;
		if (current.progress) current.progress = { ...current.progress, label: value };
		changed();
	};
	// `phase` names the stage of an operation, `label` the step within it.
	const startProgress = (phase, phaseCount = 1, total = null) => {
		current.progress = {
			label: phase,
			phase,
			phaseIndex: 1,
			phaseCount,
			done: total === null ? null : 0,
			total,
			startedAt: new Date().toISOString(),
		};
	};
	const requireProvider = () => {
		if (!provider) throw new HttpError(409, "reconnect-required", "Reconnect to the RPC endpoint before continuing");
		return provider;
	};
	const requireReady = record => {
		if (record.plan.blockers.length) throw new HttpError(412, "stale-plan", record.plan.blockers.join(" "));
		if (sourceIdentity(root).digest !== record.plan.source.digest)
			throw new HttpError(412, "stale-source", "Checkout inputs changed. Compile and prepare a new plan.");
		if (record.build.digest !== record.plan.buildDigest) throw new HttpError(412, "stale-plan", "Saved build does not match the plan");
		validateBuild(record.build);
		const { id, createdAt, ...body } = record.plan;
		if (digest(body) !== id) throw new HttpError(412, "stale-plan", "Saved plan checksum mismatch");
	};
	async function guarded(operation, action, { signal } = {}) {
		if (busy) throw new HttpError(409, "busy", "Another workbench operation is running");
		busy = true;
		current.error = null;
		current.errorInfo = null;
		changed();
		try {
			return await action();
		} catch (error) {
			// A cancelled operation is not an error, and leaves the previous state as it was.
			if (signal?.aborted) throw error;
			const { status, code, message } = classify(error);
			current.error = message;
			current.errorInfo = { id: randomUUID(), operation, message, code, at: new Date().toISOString() };
			throw new HttpError(status, code, message);
		} finally {
			busy = false;
			current.progress = null;
			changed();
		}
	}
	const getActive = () => {
		try {
			return runner.getActive();
		} catch {
			return null;
		}
	};
	const ownActive = () => {
		const active = getActive();
		return active?.taskId === DIAMOND_TASK_ID ? active : null;
	};
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
	async function rehearseRecord(record, { signal } = {}) {
		requireReady(record);
		const fresh = await assertSnapshot(requireProvider(), record.plan.snapshot);
		await verifyDeployments(record);
		signal?.throwIfAborted();
		startProgress("Rehearsing on an isolated fork", 1, record.plan.deployments.length + 1);
		activity("Creating an isolated fork and rehearsing the upgrade");
		const fork = await forkFactory(endpoint, fresh);
		let closed;
		const closeFork = () => (closed ||= Promise.resolve(fork.close()).catch(() => {}));
		signal?.addEventListener("abort", closeFork, { once: true });
		const gas = [],
			deployed = { ...record.deployed };
		try {
			const forkState = await inspect(fork.provider, fresh.target);
			if (forkState.fingerprint !== fresh.fingerprint) throw new Error("Fork state differs from the pinned chain snapshot");
			const deployer = await fork.impersonate(record.plan.deployer);
			for (const [i, item] of record.plan.deployments.entries()) {
				signal?.throwIfAborted();
				if (current.progress) current.progress = { ...current.progress, done: i };
				if (deployed[item.name]) continue;
				activity(`Rehearsing deployment of ${item.name}`);
				const a = record.build.catalog[item.name];
				const data = linkBytecode(a.bytecode, a.linkReferences, { ...record.plan.bindings, ...deployed });
				const receipt = await (await deployer.sendTransaction({ data })).wait();
				if (receipt.status !== 1) throw new Error(`Rehearsal deployment failed: ${item.name}`);
				deployed[item.name] = receipt.contractAddress;
				gas.push({ action: `Deploy ${item.name}`, gasUsed: receipt.gasUsed.toString() });
			}
			signal?.throwIfAborted();
			const routing = resolveRouting(record.plan, record.build, deployed);
			if (routing.changes.length) {
				activity("Rehearsing the Diamond cut");
				const owner = await fork.impersonate(fresh.owner);
				const receipt = await (await owner.sendTransaction({ to: fresh.target, data: encodeCut(routing.changes) })).wait();
				if (receipt.status !== 1) throw new Error("Rehearsal Diamond cut reverted");
				gas.push({ action: "Diamond cut", gasUsed: receipt.gasUsed.toString() });
			}
			await verifyDeployments({ ...record, deployed }, fork.provider);
			await verifyMap(fork.provider, fresh, routing.finalMap);
			signal?.throwIfAborted();
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
			// A cancelled rehearsal keeps whatever result the plan had before.
			if (signal?.aborted) throw error;
			record.rehearsal = { status: "failed", at: new Date().toISOString(), error: errorMessage(error) };
			save(record);
			throw error;
		} finally {
			signal?.removeEventListener("abort", closeFork);
			await closeFork();
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
		const steps = [...record.plan.deployments.map(d => d.id), "cut"],
			step = steps.indexOf(id) + 1,
			of = steps.length,
			label = component ? `Deploy ${component}` : "Execute Diamond cut";
		let tx;
		if (mode === "browser") {
			if (!ctx.ui?.transaction) throw new Error("Continue this task from the browser workbench");
			walletWait = {
				planId: record.plan.id,
				actionId: id,
				step,
				of,
				message: `Waiting for the wallet to sign step ${step} of ${of}: ${label}`,
			};
			changed();
			let response;
			try {
				response = await ctx.ui.transaction({
					id,
					planId: record.plan.id,
					step,
					of,
					sender,
					target: request.to || null,
					request: txRequest,
					label,
				});
			} finally {
				walletWait = null;
				changed();
			}
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
			let session;
			try {
				session = await signerFactory({ provider, path: record.execution.ledgerPath || DEFAULT_LEDGER_PATH });
				const signer = session.signer;
				if (address(await signer.getAddress()) !== address(sender)) throw new Error("Ledger address differs from the selected signer");
				walletWait = { planId: record.plan.id, actionId: id, step, of, message: `Confirm step ${step} of ${of} on the Ledger: ${label}` };
				activity("Confirm the transaction on your Ledger");
				const signedRaw = await signer.signTransaction(txRequest);
				const signed = Transaction.from(signedRaw);
				assertIntentTransaction(signed, txRequest, sender);
				journal.hash = signed.hash;
				journal.status = "submitted";
				save(record);
				tx = await provider.broadcastTransaction(signedRaw);
			} catch (error) {
				// No broadcast is attempted until the signed hash has been persisted.
				if (!journal.hash) {
					delete record.journal[id];
					save(record);
					ctx.emit("tx.intent.resolved", { id });
				}
				throw error;
			} finally {
				walletWait = null;
				changed();
				await session?.close?.();
			}
		}
		const { send } = await import("../../tasks/deploy/tx.ts");
		try {
			await ctx.runCallable(id, () =>
				send(Promise.resolve(tx), id, 1, {
					onSubmitted: transaction => {
						journal.hash = transaction.hash;
						journal.status = "submitted";
						save(record);
					},
				}),
			);
		} catch (error) {
			// A revert still has a receipt: record it now, so the journal and History say failed rather than submitted.
			await reconcileRecord(record, ctx).catch(() => {});
			throw error;
		}
		const outcome = await reconcileRecord(record, ctx);
		if (outcome.unresolved.length) ctx.wait(`Awaiting confirmation: ${outcome.unresolved.join(", ")}`);
		if (component && record.deployed[component] !== getCreateAddress({ from: sender, nonce }))
			throw new Error("Unexpected deployed contract address");
	}
	const definition = {
		id: DIAMOND_TASK_ID,
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
			...readPlan(input.planId).plan.deployments.map(item => ({ id: item.id, title: `Deploy ${item.name}`, phase: "deploy" })),
			{ id: "cut", title: "Rehearse and execute the Diamond cut", phase: "upgrade" },
			{ id: "verify", title: "Verify the upgraded system", phase: "verify" },
		],
		reconcile: async (ctx, input) => reconcileRecord(raw(input.planId), ctx),
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

	// After a restart with a Diamond task open, show the snapshot its plan was pinned to and remember its deployment.
	{
		const active = ownActive();
		if (active)
			try {
				const { plan } = readPlan(active.input.planId);
				snapshot = plan.snapshot;
				workspaceProfile = profileForPlan(plan) || null;
				current.activity = "An upgrade task is open. Reconnect to continue it.";
			} catch {
				/* The task stays visible through `active` even if its plan cannot be read. */
			}
	}

	return {
		get revision() {
			return revision;
		},
		// For the status ETag: the CLI changes task state from another process.
		activeTaskStamp: () => activeTaskStamp(path.dirname(activeTaskFile(root))),
		status: () => {
			const active = getActive(),
				own = active?.taskId === DIAMOND_TASK_ID,
				planId = active?.input?.planId;
			const history = [...index.values()]
				.map(entry =>
					own && entry.id === planId
						? {
								...entry,
								active: true,
								taskStatus: active.status,
								...(walletWait?.planId === entry.id || active.waitingFor
									? { waitingFor: walletWait?.planId === entry.id ? walletWait.message : active.waitingFor }
									: {}),
							}
						: { ...entry, active: false },
				)
				.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
			return {
				...current,
				revision,
				busy,
				connected: !!provider,
				needsReconnect: own && !provider,
				activePlanId: planId || null,
				ownsActiveTask: own,
				waitingFor: own ? walletWait?.message || active.waitingFor || null : null,
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
				// Facet bytecode stays on the server; the UI needs addresses, selectors and code hashes.
				snapshot: snapshot ? { ...snapshot, facets: snapshot.facets.map(({ code, ...f }) => f), inspectedAt, restored: !inspectedAt } : null,
				baseline: baseline ? { digest: baseline.digest, source: baseline.source } : null,
				active,
				history,
			};
		},
		read,
		readPlan,
		dismissError: id => {
			if (!current.errorInfo || current.errorInfo.id !== id) return { dismissed: false };
			current.error = null;
			current.errorInfo = null;
			changed();
			return { dismissed: true };
		},
		// A new workspace selection drops this engine's connection and snapshot, unless it is carrying an open task.
		resetForWorkspace: profile => {
			// An open task keeps the deployment its plan was prepared for; only a profile on the same chain may replace it.
			if (ownActive() || busy) {
				if (profile && (!workspaceProfile || profile.chainId === workspaceProfile.chainId)) workspaceProfile = profile;
				return false;
			}
			workspaceProfile = profile || null;
			provider?.destroy?.();
			provider = undefined;
			endpoint = undefined;
			snapshot = undefined;
			inspectedAt = null;
			current.error = null;
			current.errorInfo = null;
			current.activity = "Connect to a deployment to begin";
			changed();
			return true;
		},
		connect: (options, legacyTarget) => {
			const { rpc, target, signal } = typeof options === "string" ? { rpc: options, target: legacyTarget } : options || {};
			return guarded(
				"connect",
				async () => {
					const active = ownActive();
					if (active?.runner.running) throw new HttpError(409, "task-running", "An execution task is running");
					if (!rpc) throw new HttpError(400, "bad-input", "Enter an RPC endpoint");
					const next = providerFactory(rpc);
					try {
						startProgress("Inspecting the Diamond");
						const nextSnapshot = await inspect(next, target);
						signal?.throwIfAborted();
						if (active) {
							const { plan } = readPlan(active.input.planId);
							if (plan.snapshot.chainId !== nextSnapshot.chainId)
								throw new HttpError(
									412,
									"chain-mismatch",
									`The open task is on chain ${plan.snapshot.chainId}; that target is on chain ${nextSnapshot.chainId}`,
								);
						}
						provider?.destroy?.();
						provider = next;
						endpoint = rpc;
						snapshot = nextSnapshot;
						inspectedAt = new Date().toISOString();
						activity("Deployment inspected");
						return snapshot;
					} catch (e) {
						next.destroy?.();
						throw e;
					}
				},
				{ signal },
			);
		},
		// Restores the RPC connection for an open task (or the current snapshot) without inspecting or compiling.
		// `shared` is the workspace's live connection ({ rpc, chainId }), preferred over the public RPC when it is on the right chain.
		reconnect: ({ rpc, shared } = {}) =>
			guarded("reconnect", async () => {
				const active = ownActive();
				const expected = active ? readPlan(active.input.planId).plan.snapshot : snapshot;
				if (!expected) throw new HttpError(409, "not-ready", "Inspect a deployment first");
				const url =
					rpc ||
					endpoint ||
					(shared?.rpc && shared.chainId === expected.chainId ? shared.rpc : undefined) ||
					(workspaceProfile?.chainId === expected.chainId ? workspaceProfile.rpc : undefined);
				if (!url) throw new HttpError(400, "bad-input", "Enter an RPC endpoint to reconnect");
				const next = providerFactory(url);
				try {
					const chainId = Number((await next.getNetwork()).chainId);
					if (chainId !== expected.chainId)
						throw new HttpError(
							412,
							"chain-mismatch",
							`That RPC is on chain ${chainId}; ${active ? "the open task" : "the Diamond"} is on chain ${expected.chainId}`,
						);
					if ((await next.getCode(expected.target)) === "0x")
						throw new HttpError(412, "no-code", `No contract at ${expected.target} through that RPC`);
					provider?.destroy?.();
					provider = next;
					endpoint = url;
					activity(active ? "Reconnected. Continue or cancel the open task." : "Reconnected");
					return { chainId, target: expected.target, planId: active?.input.planId || null };
				} catch (e) {
					next.destroy?.();
					throw e;
				}
			}),
		// compile({ scope, signal }), or compile(scope, { signal }) as the server calls it.
		compile: (options = {}, extra = {}) => {
			const { scope = "core", signal } = typeof options === "string" ? { ...extra, scope: options } : options || {};
			return guarded(
				"compile",
				async () => {
					if (getActive()) throw new HttpError(409, "task-active", "Finish or cancel the active operator task before rebuilding");
					startProgress("Compiling the current checkout", 2);
					activity("Compiling the current checkout");
					const before = sourceIdentity(root);
					await exec(path.join(root, "node_modules/.bin/hardhat"), ["compile"], { cwd: root, maxBuffer: 8 * 1024 * 1024, signal });
					signal?.throwIfAborted();
					current.progress = { ...current.progress, phase: "Reading the build", phaseIndex: 2 };
					activity("Reading the build");
					const build = await loadBuild(root, scope);
					signal?.throwIfAborted();
					if (before.digest !== build.source.digest)
						throw new HttpError(412, "stale-source", "Source changed during compilation; compile again");
					latestBuild = build;
					activity("Build ready");
					return { digest: latestBuild.digest };
				},
				{ signal },
			);
		},
		build: () => {
			if (!latestBuild) throw new HttpError(409, "not-ready", "Compile first");
			return latestBuild;
		},
		importBaseline: value => {
			baseline = validateBuild(value);
			changed();
			return { digest: baseline.digest };
		},
		prepare: (input, { workspaceChainId, deployment } = {}) =>
			guarded("prepare", async () => {
				if (!snapshot || !inspectedAt) throw new HttpError(409, "not-ready", "Inspect & compile the target first");
				const chainId = workspaceChainId ?? workspaceProfile?.chainId;
				if (chainId !== undefined && chainId !== null && snapshot.chainId !== chainId)
					throw new HttpError(
						412,
						"chain-mismatch",
						`The inspected Diamond is on chain ${snapshot.chainId}; the selected deployment is on chain ${chainId}. Inspect & compile again.`,
					);
				if (!latestBuild) throw new HttpError(409, "not-ready", "Compile and inspect a deployment first");
				if (sourceIdentity(root).digest !== latestBuild.source.digest)
					throw new HttpError(412, "stale-source", "Source changed; compile again");
				await assertSnapshot(requireProvider(), snapshot);
				const listed = workspaceProfile?.nodes?.some(n => n.address.toLowerCase() === snapshot.target.toLowerCase());
				const plan = await preparePlan({
					...input,
					snapshot,
					build: latestBuild,
					baseline,
					provider,
					deployment: deployment || deploymentIdentity(listed ? workspaceProfile : null, snapshot.chainId),
				});
				const record = { plan, build: latestBuild, deployed: {}, journal: {}, status: "prepared" };
				if (!fs.existsSync(file(plan.id))) save(record);
				activity("Upgrade plan prepared");
				return readPlan(plan.id);
			}),
		rehearse: (idOrOptions, options = {}) => {
			const { id, signal } = typeof idOrOptions === "string" ? { ...options, id: idOrOptions } : idOrOptions || {};
			return guarded("rehearse", () => rehearseRecord(read(id), { signal }), { signal });
		},
		execute: (id, input, ui) =>
			guarded("execute", async () => {
				if (getActive()) throw new HttpError(409, "task-active", "Continue or cancel the active task before starting another upgrade");
				const record = read(id);
				requireReady(record);
				if (input.confirmation !== executionConfirmation(id, record.plan.deployment, record.plan.snapshot.chainId))
					throw new HttpError(400, "confirmation-mismatch", "Execution confirmation does not match the deployment and plan");
				if (!["browser", "ledger"].includes(input.deploymentMode) || !["browser", "ledger", "safe"].includes(input.upgradeMode))
					throw new HttpError(400, "bad-input", "Invalid signer mode");
				if ((input.upgradeMode === "safe") !== (record.plan.snapshot.authority.kind === "safe"))
					throw new HttpError(
						400,
						"bad-input",
						"Select Safe for a Safe-owned Diamond, or a browser wallet/Ledger for an EOA-owned Diamond",
					);
				if (input.ledgerPath && !/^m\/44'\/60'\/\d+'\/\d+\/\d+$/.test(input.ledgerPath))
					throw new HttpError(400, "bad-input", "Use a full Ethereum Ledger derivation path");
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
			guarded("resume", async () => {
				const active = getActive();
				if (active?.taskId !== definition.id) throw new HttpError(409, "task-elsewhere", "Continue the active CLI task in ./symmio");
				requireProvider();
				const record = raw(active.input.planId);
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
			guarded("cancel", async () => {
				if (getActive()?.taskId !== definition.id) throw new HttpError(409, "task-elsewhere", "Cancel the active CLI task in ./symmio");
				return runner.cancelActive();
			}),
		attachHash: (id, actionId, hash) =>
			guarded("attach", async () => {
				const record = raw(id);
				const journal = record.journal[actionId];
				if (!journal || !/^0x[\da-f]{64}$/i.test(hash))
					throw new HttpError(400, "bad-input", "Select a pending action and enter its transaction hash");
				const tx = await requireProvider().getTransaction(hash);
				assertIntentTransaction(tx, journal.request, journal.sender);
				journal.hash = hash;
				save(record);
				return reconcileRecord(record);
			}),
		close: () => provider?.destroy?.(),
	};
}
