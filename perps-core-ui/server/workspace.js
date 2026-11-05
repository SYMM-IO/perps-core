import { createSafeBatch } from "../../cli/signer/safe-batch.js";
import { ROOT, loadBuild, sourceIdentity, validateBuild } from "./build.js";
import { rpcProvider, createFork, ledgerSigner } from "./chain.js";
import { DIAMOND_TASK_ID, activeTaskFile, activeTaskStamp, atomicWrite } from "./engine.js";
import { HttpError, classify, errorMessage } from "./errors.js";
import { canonical, digest, codeHash, deploymentIdentity, journalCounts, rehearsalState } from "./model.js";
import { compareRuntime, preparePeripheral, assertPeripheralInputs } from "./peripherals.js";
import { identifyBuild } from "./planner.js";
import { SYSTEM_TASK_ID, createQueueRunner } from "./queue-runner.js";
import { defaultProfiles, validateProfile, suppliedProfile, inspectSystem, systemDiff, COMPONENTS, readCall, IMPLEMENTATION_SLOT } from "./system.js";
import { getAddress, ZeroHash, Interface } from "ethers";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PLAN_FILE = /^[a-f0-9]{64}\.json$/;
const yieldToEvents = () => new Promise(resolve => setImmediate(resolve));
// A selected profile keeps its public RPC and chain key, which validation does not carry.
const selectable = profile => ({
	...validateProfile(profile),
	rpc: profile.rpc || "",
	...(profile.chainName ? { chainName: profile.chainName } : {}),
});
const coreOf = profile => profile?.nodes?.find(n => n.id === "core")?.address.toLowerCase();

export function createWorkspace({
	onChange = () => {},
	root = ROOT,
	stateRoot,
	taskRoot = root,
	diamondRoot = path.join(root, ".symmio/workbench/plans"),
	providerFactory = rpcProvider,
	forkFactory = createFork,
	signerFactory = ledgerSigner,
} = {}) {
	const dir = stateRoot || path.join(root, ".symmio/workbench/system");
	let selectedProfile = suppliedProfile;
	let provider,
		endpoint,
		// The chain the current provider was checked against, by a scan or a reconnect.
		connectedChainId,
		snapshot,
		// True only for a snapshot read live in this session; a restored one is shown, never prepared from.
		live = false,
		baseline,
		busy = false,
		error = null,
		errorInfo = null,
		progress = null,
		walletWait = null,
		activity = "Load a deployment to inspect its current state",
		comparison = {},
		delta = [],
		// The inspection `delta` was measured against, so the changes can be dated.
		since = null,
		selectedPlan,
		revision = 0,
		taskCache = null;
	const changed = () => {
		revision++;
		onChange();
	};
	// What changed between the last two inspections is kept beside the snapshot it describes, so it is
	// still there after a restart instead of only until the process ends.
	const changesFile = (chainId, id) => path.join(dir, `changes-${chainId}-${id || "custom"}.json`);
	function restoreSnapshot() {
		try {
			const cached = JSON.parse(fs.readFileSync(path.join(dir, `snapshot-${selectedProfile.chainId}-${selectedProfile.id}.json`), "utf8"));
			if (
				cached.chainId === selectedProfile.chainId &&
				cached.profile.id === selectedProfile.id &&
				coreOf(cached.profile) === coreOf(selectedProfile) &&
				Array.isArray(cached.nodes) &&
				Array.isArray(cached.edges)
			) {
				snapshot = cached;
				activity = "Saved snapshot loaded. Inspect live to reconnect.";
				try {
					const saved = JSON.parse(fs.readFileSync(changesFile(cached.chainId, cached.profile.id), "utf8"));
					// Only if it describes this very snapshot; a list measured against another read would mislead.
					if (saved.to === cached.blockNumber && Array.isArray(saved.delta)) {
						delta = saved.delta;
						since = saved.since || null;
					}
				} catch {
					/* No recorded changes is the normal state after a first inspection. */
				}
			}
		} catch {
			/* A missing or incomplete cache must not prevent opening the workspace. */
		}
	}
	const planFile = id => {
		if (!/^[a-f0-9]{64}$/.test(id || "")) throw new HttpError(400, "bad-input", "Invalid plan ID");
		return path.join(dir, `${id}.json`);
	};
	const readRecord = id => JSON.parse(fs.readFileSync(planFile(id), "utf8"));

	// History is indexed once and kept current by save(), so a status poll never re-reads every plan.
	const index = new Map();
	const entryFor = r => ({
		id: r.plan.id,
		family: "system",
		scope: r.plan.scope,
		chainId: r.plan.chainId,
		target: r.plan.sourceAddress,
		createdAt: r.plan.createdAt,
		at: r.plan.createdAt,
		status: r.status,
		changes: r.plan.changes?.length ?? 0,
		deployment: r.plan.deployment || (r.plan.profile ? deploymentIdentity(r.plan.profile, r.plan.chainId) : undefined),
		rehearsal: rehearsalState(r),
		...(r.execution || Object.keys(r.journal || {}).length ? { execution: journalCounts(r.journal) } : {}),
	});
	if (fs.existsSync(dir))
		for (const name of fs.readdirSync(dir).filter(n => PLAN_FILE.test(n)))
			try {
				const r = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
				index.set(r.plan.id, entryFor(r));
			} catch {
				/* One unreadable plan must not hide the others. */
			}
	const save = r => {
		atomicWrite(planFile(r.plan.id), r);
		index.set(r.plan.id, entryFor(r));
		selectedPlan = r;
		changed();
	};

	// `phase` names the stage of a job, `label` the step within it, as inspectSystem reports them.
	function startProgress(phase) {
		progress = { label: phase, phase, phaseIndex: 1, phaseCount: 1, done: null, total: null, startedAt: new Date().toISOString() };
	}
	function report(update) {
		if (typeof update === "string") update = { label: update };
		progress = { ...(progress || {}), ...update };
		activity = update.label || update.phase || activity;
		changed();
	}
	async function job(operation, label, fn, { signal } = {}) {
		if (busy) throw new HttpError(409, "busy", "A system operation is running");
		busy = true;
		error = null;
		errorInfo = null;
		activity = label;
		changed();
		try {
			return await fn();
		} catch (e) {
			// A cancelled job is not an error, and leaves the previous state as it was.
			if (signal?.aborted) throw e;
			const { status, code, message } = classify(e);
			error = message;
			errorInfo = { id: randomUUID(), operation, message, code, at: new Date().toISOString() };
			throw new HttpError(status, code, message);
		} finally {
			busy = false;
			progress = null;
			changed();
		}
	}

	const queueActive = () => {
		try {
			return queue.active();
		} catch {
			return null;
		}
	};
	// The active task, whichever adapter owns it, with the deployment its plan belongs to.
	function activeTask() {
		const state = queueActive();
		if (!state) return null;
		const planId = state.input?.planId;
		if (taskCache?.runId !== state.runId) {
			let info = { family: null };
			try {
				if (state.taskId === SYSTEM_TASK_ID) {
					const { plan } = readRecord(planId);
					info = {
						family: "system",
						chainId: plan.chainId,
						profile: plan.profile,
						deploymentId: plan.deployment?.id || plan.profile?.id,
						target: plan.sourceAddress,
					};
				} else if (state.taskId === DIAMOND_TASK_ID && /^[a-f0-9]{64}$/.test(planId)) {
					const { plan } = JSON.parse(fs.readFileSync(path.join(diamondRoot, `${planId}.json`), "utf8"));
					info = { family: "diamond", chainId: plan.snapshot.chainId, deploymentId: plan.deployment?.id, target: plan.snapshot.target };
				}
			} catch {
				/* A plan that cannot be read still leaves the task active; it just names no deployment. */
			}
			taskCache = { runId: state.runId, info };
		}
		return { state, planId, ...taskCache.info };
	}
	const ownTask = task => task?.state.taskId === SYSTEM_TASK_ID;
	// Inspecting or switching is fine beside a paused task on the same chain. Not while it runs, and not across chains.
	function assertTaskAllows(profile) {
		const task = activeTask();
		if (!task) return;
		if (task.state.runner?.running) throw new HttpError(409, "task-running", "Wait for the running upgrade task to pause or finish");
		if (task.chainId !== undefined && task.chainId !== profile.chainId)
			throw new HttpError(
				409,
				"task-active",
				`An upgrade task is open on chain ${task.chainId}. Finish or cancel it before working on another chain.`,
			);
	}
	function profileForTask(task) {
		const listed = task.deploymentId && defaultProfiles.find(p => p.id === task.deploymentId);
		if (listed) return listed;
		if (task.family === "system" && task.profile) return task.profile;
		if (task.target)
			return defaultProfiles.find(p => p.chainId === task.chainId && p.nodes.some(n => n.address.toLowerCase() === task.target.toLowerCase()));
	}

	function requirePlan(id, { recovery = false } = {}) {
		const r = readRecord(id);
		const { id: hash, createdAt, ...body } = r.plan;
		if (digest(body) !== hash) throw new HttpError(412, "stale-plan", "Plan checksum mismatch");
		if (!recovery && sourceIdentity(root).digest !== r.plan.source.digest)
			throw new HttpError(412, "stale-source", "Source changed; compile and prepare a new plan");
		if (!recovery && r.plan.blockers.length) throw new HttpError(412, "stale-plan", r.plan.blockers.join(" "));
		if (!provider) throw new HttpError(409, "reconnect-required", "Reconnect to the deployment's RPC to continue");
		if (connectedChainId !== r.plan.chainId)
			throw new HttpError(412, "chain-mismatch", `The connection is on chain ${connectedChainId}; this plan is for chain ${r.plan.chainId}`);
		// The active task's own plan only needs the right chain: a reconnect after a restart restores no live snapshot.
		const task = activeTask(),
			forTask = ownTask(task) && task.planId === id;
		if (!forTask && (!snapshot || snapshot.chainId !== r.plan.chainId || coreOf(snapshot.profile) !== coreOf(r.plan.profile)))
			throw new HttpError(412, "chain-mismatch", "This plan belongs to another workspace; inspect its deployment first");
		return r;
	}
	async function verify(provider, plan, expectedRuntime) {
		if (codeHash(await provider.getCode(plan.replacement)) !== expectedRuntime) throw new Error("Replacement runtime differs from rehearsal");
		const core = plan.profile.nodes.find(n => n.id === "core").address;
		if (plan.scope === "partyB") {
			if (getAddress(`0x${(await provider.getStorage(plan.sourceAddress, IMPLEMENTATION_SLOT)).slice(-40)}`) !== plan.replacement)
				throw new Error("PartyB implementation did not change as planned");
			for (const r of plan.reads)
				if (r.to === plan.sourceAddress && (await provider.call({ to: r.to, data: r.data })) !== r.result)
					throw new Error("PartyB configuration changed unexpectedly");
		} else {
			// Compare copied getters and permissions against the old instance. Enumerable
			// role indexes are checked as sets separately because grant order can differ.
			const roleIndexed = new Interface(["function getRoleMember(bytes32,uint256) view returns(address)"]);
			for (let start = 0; start < plan.reads.length; start += 16)
				await Promise.all(
					plan.reads
						.slice(start, start + 16)
						.filter(r => r.to === plan.sourceAddress && !r.data.startsWith(roleIndexed.getFunction("getRoleMember").selector))
						.map(async r => {
							if ((await provider.call({ to: plan.replacement, data: r.data })) !== r.result)
								throw new Error(`Replacement configuration mismatch for ${r.data.slice(0, 10)}`);
						}),
				);
			for (const name of ["DEFAULT_ADMIN_ROLE", "SETTER_ROLE"]) {
				const { id } = await import("ethers");
				const role = name === "DEFAULT_ADMIN_ROLE" ? ZeroHash : id(name);
				const members = async target => {
					const count = Number(await readCall(provider, target, "function getRoleMemberCount(bytes32) view returns(uint256)", [role]));
					return (
						await Promise.all(
							Array.from({ length: count }, (_, i) =>
								readCall(provider, target, "function getRoleMember(bytes32,uint256) view returns(address)", [role, i]),
							),
						)
					).sort();
				};
				if (canonical([...(plan.roles?.[name] || [])].sort()) !== canonical(await members(plan.replacement)))
					throw new Error(`Replacement role mismatch: ${name}`);
			}
			if (
				plan.scope === "verifier" &&
				(await readCall(provider, core, "function getSignatureVerifier() view returns(address)")).toLowerCase() !==
					plan.replacement.toLowerCase()
			)
				throw new Error("Core verifier pointer differs from the plan");
		}
		return { at: new Date().toISOString(), blockNumber: await provider.getBlockNumber(), runtimeHash: expectedRuntime };
	}
	const queue = createQueueRunner({
		root: taskRoot,
		load: requirePlan,
		loadRecovery: id => requirePlan(id, { recovery: true }),
		save,
		provider: () => {
			if (!provider) throw new HttpError(409, "reconnect-required", "Reconnect to the deployment's RPC to continue");
			return provider;
		},
		verify,
		activity: value => {
			activity = value;
			changed();
		},
		signerFactory,
		onWallet: value => {
			walletWait = value;
			changed();
		},
	});

	// Builds depend only on the checkout, so one compare loads each scope once, and later calls reuse it until the source changes.
	const builds = new Map();
	async function buildFor(scope, key = sourceIdentity(root).digest) {
		const hit = builds.get(scope);
		if (hit?.key === key) return hit.build;
		const build = await loadBuild(root, scope);
		if (build.source.digest === key) builds.set(scope, { key, build });
		return build;
	}

	// After a restart with an upgrade task open, open the deployment that task belongs to.
	const startup = activeTask();
	const startupProfile = startup && profileForTask(startup);
	if (startupProfile) selectedProfile = startupProfile === startup.profile ? { ...startup.profile, rpc: "" } : startupProfile;
	restoreSnapshot();
	if (startup) activity = "An upgrade task is open. Reconnect to continue it.";

	function selectProfile(next) {
		selectedProfile = next;
		provider?.destroy();
		provider = undefined;
		endpoint = undefined;
		connectedChainId = undefined;
		snapshot = undefined;
		live = false;
		baseline = undefined;
		selectedPlan = undefined;
		comparison = {};
		delta = [];
		since = null;
		error = null;
		errorInfo = null;
	}

	return {
		// Server-side only: lets the Diamond engine reuse this connection. Never included in status().
		endpoint: () => (provider ? endpoint : undefined),
		get revision() {
			return revision;
		},
		// For the status ETag: the CLI changes task state from another process.
		activeTaskStamp: () => activeTaskStamp(path.dirname(activeTaskFile(taskRoot))),
		status: () => {
			const task = activeTask(),
				own = ownTask(task);
			const history = [...index.values()]
				.map(entry =>
					task && entry.id === task.planId && own
						? {
								...entry,
								active: true,
								taskStatus: task.state.status,
								...(walletWait?.planId === entry.id || task.state.waitingFor
									? { waitingFor: walletWait?.planId === entry.id ? walletWait.message : task.state.waitingFor }
									: {}),
							}
						: { ...entry, active: false },
				)
				.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
			return {
				revision,
				active: task?.state || null,
				activePlanId: task?.planId || null,
				ownsActiveTask: own,
				needsReconnect: own && !provider,
				waitingFor: own ? walletWait?.message || task.state.waitingFor || null : null,
				connected: !!provider,
				live,
				// Saved snapshots carry the validated profile, which drops the chain key.
				profile: snapshot?.profile
					? { ...snapshot.profile, ...(selectedProfile.chainName ? { chainName: selectedProfile.chainName } : {}) }
					: selectedProfile,
				snapshot: snapshot ? { ...snapshot, nodes: snapshot.nodes.map(({ diamond, ...n }) => n) } : null,
				comparison,
				delta,
				since,
				busy,
				error,
				errorInfo,
				progress,
				activity,
				plan: selectedPlan,
				history,
			};
		},
		dismissError: id => {
			if (!errorInfo || errorInfo.id !== id) return { dismissed: false };
			error = null;
			errorInfo = null;
			changed();
			return { dismissed: true };
		},
		select: input => {
			if (busy) throw new HttpError(409, "busy", "Finish the active operation before switching workspaces");
			const next = typeof input === "string" ? defaultProfiles.find(p => p.id === input) : input;
			if (!next) throw new HttpError(400, "bad-input", "Unknown workspace");
			const profile = selectable(next);
			assertTaskAllows(profile);
			selectProfile(profile);
			activity = "Workspace loaded. Inspect the live deployment to verify its configuration.";
			restoreSnapshot();
			changed();
			return selectedProfile;
		},
		scan: (options, legacyProfile) => {
			const { rpc: url, profile, signal } = typeof options === "string" ? { rpc: options, profile: legacyProfile } : options || {};
			return job(
				"scan",
				"Reading contracts and verifying connections at one block",
				async () => {
					const target = profile || selectedProfile;
					assertTaskAllows(target);
					if (!url) throw new HttpError(400, "bad-input", "Enter an RPC endpoint");
					const next = providerFactory(url);
					// The scan reads through its own connection, which skips the per-request chain check after the first.
					const reader = providerFactory(url, { staticNetwork: true });
					startProgress("Inspecting the deployment");
					try {
						const fresh = await inspectSystem(reader, target, { signal, onProgress: report }).finally(() => reader.destroy());
						signal?.throwIfAborted();
						// Only the host is kept: an RPC URL can carry a key, and the snapshot is written to disk.
						fresh.sources.chain.rpc = new URL(url).host;
						const previousFile = path.join(dir, `snapshot-${fresh.chainId}-${fresh.profile.id || "custom"}.json`);
						const inMemory = snapshot?.chainId === fresh.chainId && snapshot?.profile.id === fresh.profile.id;
						let previous = inMemory ? snapshot : null;
						if (!previous && fs.existsSync(previousFile)) previous = JSON.parse(fs.readFileSync(previousFile));
						const measured = systemDiff(previous, fresh);
						// Nothing changed since the last read: keep the list that describes the last real change, and move its end to this block.
						let kept = null;
						if (!measured.length && previous) {
							if (inMemory) kept = { delta, since };
							else
								try {
									const saved = JSON.parse(fs.readFileSync(changesFile(fresh.chainId, fresh.profile.id), "utf8"));
									if (saved.to === previous.blockNumber && Array.isArray(saved.delta))
										kept = { delta: saved.delta, since: saved.since || null };
								} catch {
									/* No earlier list to keep. */
								}
						}
						if (kept?.delta.length) ({ delta, since } = kept);
						else {
							delta = measured;
							since = previous ? { blockNumber: previous.blockNumber, at: previous.at } : null;
						}
						atomicWrite(changesFile(fresh.chainId, fresh.profile.id), { since, to: fresh.blockNumber, delta });
						snapshot = fresh;
						live = true;
						const listed = defaultProfiles.find(p => p.id === fresh.profile.id && p.chainId === fresh.chainId);
						selectedProfile = { ...fresh.profile, rpc: listed?.rpc || "", ...(listed?.chainName ? { chainName: listed.chainName } : {}) };
						selectedPlan = undefined;
						baseline = undefined;
						atomicWrite(previousFile, fresh);
						provider?.destroy();
						provider = next;
						endpoint = url;
						connectedChainId = fresh.chainId;
						comparison = {};
						activity = `${fresh.nodes.length} addresses inspected at block ${fresh.blockNumber}`;
						return fresh;
					} catch (e) {
						next.destroy();
						throw e;
					}
				},
				{ signal },
			);
		},
		// Restores the RPC connection after a restart without a full inspection, so an open task can continue.
		reconnect: ({ rpc } = {}) =>
			job("reconnect", "Reconnecting to the deployment", async () => {
				const task = activeTask();
				const plan = ownTask(task) ? readRecord(task.planId).plan : null;
				const profile = plan ? defaultProfiles.find(p => p.id === plan.profile?.id) || plan.profile : selectedProfile;
				const url = rpc || defaultProfiles.find(p => p.id === profile.id)?.rpc || selectedProfile.rpc;
				if (!url) throw new HttpError(400, "bad-input", "Enter an RPC endpoint to reconnect");
				const expected = plan?.chainId ?? selectedProfile.chainId;
				const target = plan?.sourceAddress || profile.nodes.find(n => n.id === "core").address;
				const next = providerFactory(url);
				try {
					const chainId = Number((await next.getNetwork()).chainId);
					if (chainId !== expected)
						throw new HttpError(
							412,
							"chain-mismatch",
							`That RPC is on chain ${chainId}; ${plan ? "the open task" : "this deployment"} is on chain ${expected}`,
						);
					if ((await next.getCode(target)) === "0x") throw new HttpError(412, "no-code", `No contract at ${target} through that RPC`);
					provider?.destroy();
					provider = next;
					endpoint = url;
					connectedChainId = chainId;
					activity = plan ? "Reconnected. Continue or cancel the open task." : "Reconnected. Inspect live to refresh the snapshot.";
					return { chainId, target, planId: plan?.id || null };
				} catch (e) {
					next.destroy();
					throw e;
				}
			}),
		compare: ({ signal } = {}) =>
			job(
				"compare",
				"Comparing deployed bytecode with compiled checkout",
				async () => {
					if (!snapshot || !provider) throw new HttpError(409, "not-ready", "Inspect a deployment first");
					const nodes = snapshot.nodes.filter(n => COMPONENTS[n.kind] && n.status === "observed");
					const key = sourceIdentity(root).digest,
						next = {};
					startProgress("Comparing deployed bytecode with compiled checkout");
					for (const [i, n] of nodes.entries()) {
						signal?.throwIfAborted();
						report({ label: `Comparing ${n.name} · ${i + 1} of ${nodes.length}`, done: i, total: nodes.length });
						// Loading a build is mostly synchronous; let status polls through between contracts.
						await yieldToEvents();
						const build = await buildFor(n.kind, key);
						if (n.diamond) {
							const identified = await identifyBuild(n.diamond, build, provider);
							const facets = Object.values(build.catalog)
								.filter(a => a.kind === "facet")
								.map(a => {
									const existing = Object.keys(identified.matches).find(at => identified.matches[at] === a.name);
									const functions = Object.keys(a.selectors);
									return {
										name: a.name,
										state: existing ? "matching" : "changed",
										current: existing || [...new Set(functions.map(s => n.diamond.map[s]).filter(Boolean))],
										functions: functions.length,
										dependencies: a.dependencies,
									};
								});
							const desiredSelectors = Object.assign(
								{},
								...Object.values(build.catalog)
									.filter(a => a.kind === "facet")
									.map(a => a.selectors),
							);
							const interfaceChanges = {
								added: Object.entries(desiredSelectors)
									.filter(([selector]) => !n.diamond.map[selector])
									.map(([selector, signature]) => ({ selector, signature })),
								removed: Object.keys(n.diamond.map).filter(selector => !desiredSelectors[selector]),
							};
							next[n.id] = {
								interfaceChanges,
								kind: "diamond",
								matching: facets.filter(f => f.state === "matching").length,
								total: facets.length,
								facets,
								unrecognized: n.diamond.facets.filter(f => !identified.matches[f.address]).map(f => f.address),
								buildDigest: build.digest,
							};
						} else {
							const artifact = Object.values(build.catalog)[0],
								code = await provider.getCode(n.implementation || n.address, snapshot.blockNumber);
							next[n.id] = {
								kind: n.kind,
								matching: compareRuntime(artifact, code),
								buildDigest: build.digest,
								note: "Constructor immutable bytes excluded from this comparison; exact deployment and configuration are verified during rehearsal.",
							};
						}
					}
					signal?.throwIfAborted();
					comparison = next;
					activity = "Source comparison ready";
					return comparison;
				},
				{ signal },
			),
		importBaseline: value => {
			baseline = validateBuild(value);
			return { scope: baseline.scope, digest: baseline.digest };
		},
		build: scope => buildFor(scope),
		prepare: input =>
			job("prepare", "Preparing ordered deployments, configuration, and cutover calls", async () => {
				if (!snapshot || !provider) throw new HttpError(409, "not-ready", "Inspect a deployment first");
				if (!live) throw new HttpError(412, "stale-snapshot", "Inspect live before preparing; the snapshot on screen is a saved one");
				const { nodeId, deployer, authority } = input;
				const plan = await preparePeripheral({
					provider,
					system: snapshot,
					baseline,
					root,
					nodeId,
					deployer,
					authority,
					buildFor: scope => buildFor(scope),
				});
				const record = { plan, status: "prepared" };
				save(record);
				activity = `${plan.actions.length} transactions prepared`;
				return record;
			}),
		read: id => readRecord(id),
		open: id => {
			selectedPlan = readRecord(id);
			changed();
			return selectedPlan;
		},
		rehearse: (idOrOptions, options = {}) => {
			const { id, signal } = typeof idOrOptions === "string" ? { ...options, id: idOrOptions } : idOrOptions || {};
			return job(
				"rehearse",
				"Rehearsing the complete transaction sequence on an isolated fork",
				async () => {
					const record = requirePlan(id),
						p = record.plan;
					await assertPeripheralInputs(provider, p);
					signal?.throwIfAborted();
					const block = await provider.getBlock("latest"),
						fork = await forkFactory(endpoint, { chainId: p.chainId, blockNumber: block.number });
					let closed;
					const closeFork = () => (closed ||= Promise.resolve(fork.close()).catch(() => {}));
					signal?.addEventListener("abort", closeFork, { once: true });
					const receipts = [];
					startProgress("Rehearsing on an isolated fork");
					try {
						for (const [i, action] of p.actions.entries()) {
							signal?.throwIfAborted();
							report({ label: action.label, done: i, total: p.actions.length });
							const signer = await fork.impersonate(action.sender);
							const tx = await signer.sendTransaction({
								...(action.to ? { to: action.to } : {}),
								data: action.data,
								value: 0,
								...(action.nonce !== undefined ? { nonce: action.nonce } : {}),
							});
							const receipt = await tx.wait();
							if (receipt.status !== 1) throw new Error(`Reverted: ${action.label}`);
							if (action.creates && receipt.contractAddress !== action.creates) throw new Error("Deployment address differs from plan");
							receipts.push({ id: action.id, gasUsed: receipt.gasUsed.toString() });
						}
						signal?.throwIfAborted();
						const expectedRuntime = codeHash(await fork.provider.getCode(p.replacement));
						await verify(fork.provider, p, expectedRuntime);
						record.rehearsal = {
							status: "passed",
							at: new Date().toISOString(),
							blockNumber: block.number,
							blockHash: block.hash,
							expectedRuntime,
							receipts,
							limitations: [
								"Authority impersonated and fork accounts funded. Real wallet/Safe signatures and funding are not validated.",
								"Protocol trading and accounting scenarios are not covered.",
							],
						};
						save(record);
						activity = "Complete transaction sequence and post-state verified on the fork";
						return record;
					} catch (e) {
						// A cancelled rehearsal keeps whatever result the plan had before.
						if (signal?.aborted) throw e;
						record.rehearsal = { status: "failed", at: new Date().toISOString(), error: errorMessage(e, 1500) };
						save(record);
						throw e;
					} finally {
						signal?.removeEventListener("abort", closeFork);
						await closeFork();
					}
				},
				{ signal },
			);
		},
		export: id => {
			const r = requirePlan(id);
			if (r.rehearsal?.status !== "passed")
				throw new HttpError(412, "stale-plan", "Rehearse successfully before exporting executable transactions");
			return r;
		},
		safe: async id => {
			const r = requirePlan(id);
			if (r.rehearsal?.status !== "passed") throw new HttpError(412, "stale-plan", "Rehearse successfully first");
			if (codeHash(await provider.getCode(r.plan.replacement)) !== r.rehearsal.expectedRuntime)
				throw new HttpError(412, "not-deployed", "Deploy the reviewed creation transaction first, then export the Safe batch");
			const owners = await readCall(provider, r.plan.authority, "function getOwners() view returns(address[])");
			const threshold = Number(await readCall(provider, r.plan.authority, "function getThreshold() view returns(uint256)"));
			if (threshold < 1 || threshold > owners.length) throw new HttpError(412, "stale-plan", "Authority does not pass Safe interface checks");
			await assertPeripheralInputs(provider, r.plan, { nonce: false });
			return createSafeBatch({
				chainId: r.plan.chainId,
				safeAddress: r.plan.authority,
				name: `${COMPONENTS[r.plan.scope].title} upgrade`,
				description: `Plan ${id}; preserve transaction order`,
				actions: r.plan.actions.filter(a => a.to).map(a => ({ ...a, description: a.label })),
			});
		},
		verify: id =>
			job("verify", "Verifying live post-upgrade state", async () => {
				const r = requirePlan(id);
				if (!r.rehearsal?.expectedRuntime) throw new HttpError(412, "stale-plan", "Rehearse first");
				r.verification = await verify(provider, r.plan, r.rehearsal.expectedRuntime);
				r.status = "verified";
				save(r);
				activity = "Live upgrade state verified";
				return r;
			}),
		execute: (id, input, ui) => job("execute", "Executing reviewed transactions", () => queue.execute(id, input, ui)),
		resume: ui =>
			job("resume", "Continuing saved upgrade", () => {
				// Refuse here rather than let the task pause on a missing connection and lose its waiting state.
				if (!provider) throw new HttpError(409, "reconnect-required", "Reconnect to the deployment's RPC to continue");
				return queue.resume(ui);
			}),
		cancel: () => job("cancel", "Reconciling before cancellation", () => queue.cancel()),
		attach: (id, actionId, hash) => job("attach", "Recovering transaction outcome", () => queue.attach(id, actionId, hash)),
		close: () => provider?.destroy(),
	};
}
