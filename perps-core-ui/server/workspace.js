import { createSafeBatch } from "../../cli/signer/safe-batch.js";
import { ROOT, loadBuild, sourceIdentity, validateBuild } from "./build.js";
import { rpcProvider, createFork } from "./chain.js";
import { atomicWrite } from "./engine.js";
import { canonical, digest, codeHash } from "./model.js";
import { compareRuntime, preparePeripheral, assertPeripheralInputs } from "./peripherals.js";
import { identifyBuild } from "./planner.js";
import { createQueueRunner } from "./queue-runner.js";
import { defaultProfiles, validateProfile, suppliedProfile, inspectSystem, systemDiff, COMPONENTS, readCall, IMPLEMENTATION_SLOT } from "./system.js";
import { getAddress, ZeroHash, Interface } from "ethers";
import fs from "node:fs";
import path from "node:path";

export function createWorkspace({ onChange = () => {}, root = ROOT, stateRoot, taskRoot = root } = {}) {
	const dir = stateRoot || path.join(root, ".symmio/workbench/system");
	let selectedProfile = suppliedProfile;
	let provider,
		endpoint,
		snapshot,
		baseline,
		busy = false,
		error = null,
		activity = "Load a deployment to inspect its current state",
		comparison = {},
		delta = [],
		// The inspection `delta` was measured against, so the changes can be dated.
		since = null,
		selectedPlan;
	// What changed between the last two inspections is kept beside the snapshot it describes, so it is
	// still there after a restart instead of only until the process ends.
	const changesFile = (chainId, id) => path.join(dir, `changes-${chainId}-${id || "custom"}.json`);
	function restoreSnapshot() {
		try {
			const cached = JSON.parse(fs.readFileSync(path.join(dir, `snapshot-${selectedProfile.chainId}-${selectedProfile.id}.json`), "utf8"));
			if (
				cached.chainId === selectedProfile.chainId &&
				cached.profile.id === selectedProfile.id &&
				cached.profile.nodes.find(n => n.id === "core")?.address.toLowerCase() ===
					selectedProfile.nodes.find(n => n.id === "core")?.address.toLowerCase() &&
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
	restoreSnapshot();
	const planFile = id => {
		if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid plan ID");
		return path.join(dir, `${id}.json`);
	};
	const save = r => {
		atomicWrite(planFile(r.plan.id), r);
		selectedPlan = r;
		onChange();
	};
	async function job(label, fn) {
		if (busy) throw new Error("A system operation is running");
		busy = true;
		error = null;
		activity = label;
		onChange();
		try {
			return await fn();
		} catch (e) {
			error = String(e.shortMessage || e.message)
				.replace(/https?:\/\/\S+/g, "<rpc>")
				.slice(0, 1500);
			throw new Error(error);
		} finally {
			busy = false;
			onChange();
		}
	}
	function requirePlan(id, { recovery = false } = {}) {
		const r = JSON.parse(fs.readFileSync(planFile(id), "utf8"));
		const { id: hash, createdAt, ...body } = r.plan;
		if (digest(body) !== hash) throw new Error("Plan checksum mismatch");
		if (!recovery && sourceIdentity(root).digest !== r.plan.source.digest) throw new Error("Source changed; compile and prepare a new plan");
		if (!recovery && r.plan.blockers.length) throw new Error(r.plan.blockers.join(" "));
		if (!provider) throw new Error("Inspect the deployment to reconnect the RPC");
		if (
			!snapshot ||
			snapshot.chainId !== r.plan.chainId ||
			snapshot.profile.nodes.find(n => n.id === "core").address.toLowerCase() !==
				r.plan.profile.nodes.find(n => n.id === "core").address.toLowerCase()
		)
			throw new Error("This plan belongs to another workspace; inspect its deployment first");
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
			if (!provider) throw new Error("Inspect the deployment to reconnect");
			return provider;
		},
		verify,
		activity: value => {
			activity = value;
			onChange();
		},
	});

	return {
		// Server-side only: lets the Diamond engine reuse this connection. Never included in status().
		endpoint: () => (provider ? endpoint : undefined),
		status: () => ({
			active: queue.active(),
			connected: !!provider,
			profile: snapshot?.profile || selectedProfile,
			profiles: defaultProfiles,
			snapshot: snapshot ? { ...snapshot, nodes: snapshot.nodes.map(({ diamond, ...n }) => n) } : null,
			comparison,
			delta,
			since,
			busy,
			error,
			activity,
			plan: selectedPlan,
			history: fs.existsSync(dir)
				? fs
						.readdirSync(dir)
						.filter(n => /^[a-f0-9]{64}\.json$/.test(n))
						.map(n => {
							const r = JSON.parse(fs.readFileSync(path.join(dir, n)));
							return {
								id: r.plan.id,
								scope: r.plan.scope,
								chainId: r.plan.chainId,
								target: r.plan.sourceAddress,
								at: r.plan.createdAt,
								status: r.status,
							};
						})
						.sort((a, b) => b.at.localeCompare(a.at))
				: [],
		}),
		select: input => {
			if (busy || queue.active()) throw new Error("Finish the active operation before switching workspaces");
			const next = typeof input === "string" ? defaultProfiles.find(p => p.id === input) : input;
			if (!next) throw new Error("Unknown workspace");
			selectedProfile = { ...validateProfile(next), rpc: next.rpc || "" };
			provider?.destroy();
			provider = undefined;
			endpoint = undefined;
			snapshot = undefined;
			baseline = undefined;
			selectedPlan = undefined;
			comparison = {};
			delta = [];
			since = null;
			error = null;
			activity = "Workspace loaded. Inspect the live deployment to verify its configuration.";
			restoreSnapshot();
			onChange();
			return selectedProfile;
		},
		scan: (url, profile) =>
			job("Reading contracts and verifying connections at one block", async () => {
				if (queue.active()) throw new Error("Finish the active upgrade before inspecting another deployment");
				const next = rpcProvider(url);
				// The scan reads through its own connection, which skips the per-request chain check after the first.
				const reader = rpcProvider(url, { staticNetwork: true });
				try {
					const fresh = await inspectSystem(reader, profile || selectedProfile, message => {
						activity = message;
						onChange();
					}).finally(() => reader.destroy());
					// Only the host is kept: an RPC URL can carry a key, and the snapshot is written to disk.
					fresh.sources.chain.rpc = new URL(url).host;
					const previousFile = path.join(dir, `snapshot-${fresh.chainId}-${fresh.profile.id || "custom"}.json`);
					let previous = snapshot?.chainId === fresh.chainId && snapshot?.profile.id === fresh.profile.id ? snapshot : null;
					if (!previous && fs.existsSync(previousFile)) previous = JSON.parse(fs.readFileSync(previousFile));
					delta = systemDiff(previous, fresh);
					since = previous ? { blockNumber: previous.blockNumber, at: previous.at } : null;
					atomicWrite(changesFile(fresh.chainId, fresh.profile.id), { since, to: fresh.blockNumber, delta });
					snapshot = fresh;
					selectedProfile = fresh.profile;
					selectedPlan = undefined;
					baseline = undefined;
					atomicWrite(previousFile, fresh);
					provider?.destroy();
					provider = next;
					endpoint = url;
					comparison = {};
					activity = `${fresh.nodes.length} addresses inspected at block ${fresh.blockNumber}`;
					return fresh;
				} catch (e) {
					next.destroy();
					throw e;
				}
			}),
		compare: () =>
			job("Comparing deployed bytecode with compiled checkout", async () => {
				if (!snapshot || !provider) throw new Error("Inspect a deployment first");
				for (const n of snapshot.nodes.filter(n => COMPONENTS[n.kind] && n.status === "observed")) {
					const build = await loadBuild(root, n.kind);
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
						comparison[n.id] = {
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
						comparison[n.id] = {
							kind: n.kind,
							matching: compareRuntime(artifact, code),
							buildDigest: build.digest,
							note: "Constructor immutable bytes excluded from this comparison; exact deployment and configuration are verified during rehearsal.",
						};
					}
				}
				activity = "Source comparison ready";
				return comparison;
			}),
		importBaseline: value => {
			baseline = validateBuild(value);
			return { scope: baseline.scope, digest: baseline.digest };
		},
		build: scope => loadBuild(root, scope),
		prepare: input =>
			job("Preparing ordered deployments, configuration, and cutover calls", async () => {
				if (!snapshot || !provider) throw new Error("Inspect a deployment first");
				const { nodeId, deployer, authority } = input;
				const plan = await preparePeripheral({
					provider,
					system: snapshot,
					baseline,
					root,
					nodeId,
					deployer,
					authority,
				});
				const record = { plan, status: "prepared" };
				save(record);
				activity = `${plan.actions.length} transactions prepared`;
				return record;
			}),
		read: id => JSON.parse(fs.readFileSync(planFile(id), "utf8")),
		open: id => {
			selectedPlan = JSON.parse(fs.readFileSync(planFile(id), "utf8"));
			onChange();
			return selectedPlan;
		},
		rehearse: id =>
			job("Rehearsing the complete transaction sequence on an isolated fork", async () => {
				const record = requirePlan(id),
					p = record.plan;
				await assertPeripheralInputs(provider, p);
				const block = await provider.getBlock("latest"),
					fork = await createFork(endpoint, { chainId: p.chainId, blockNumber: block.number });
				const receipts = [];
				try {
					for (const action of p.actions) {
						activity = action.label;
						onChange();
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
					record.rehearsal = { status: "failed", error: String(e.shortMessage || e.message) };
					save(record);
					throw e;
				} finally {
					await fork.close();
				}
			}),
		export: id => {
			const r = requirePlan(id);
			if (r.rehearsal?.status !== "passed") throw new Error("Rehearse successfully before exporting executable transactions");
			return r;
		},
		safe: async id => {
			const r = requirePlan(id);
			if (r.rehearsal?.status !== "passed") throw new Error("Rehearse successfully first");
			if (codeHash(await provider.getCode(r.plan.replacement)) !== r.rehearsal.expectedRuntime)
				throw new Error("Deploy the reviewed creation transaction first, then export the Safe batch");
			const owners = await readCall(provider, r.plan.authority, "function getOwners() view returns(address[])");
			const threshold = Number(await readCall(provider, r.plan.authority, "function getThreshold() view returns(uint256)"));
			if (threshold < 1 || threshold > owners.length) throw new Error("Authority does not pass Safe interface checks");
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
			job("Verifying live post-upgrade state", async () => {
				const r = requirePlan(id);
				if (!r.rehearsal?.expectedRuntime) throw new Error("Rehearse first");
				r.verification = await verify(provider, r.plan, r.rehearsal.expectedRuntime);
				r.status = "verified";
				save(r);
				activity = "Live upgrade state verified";
				return r;
			}),
		execute: (id, input, ui) => job("Executing reviewed transactions", () => queue.execute(id, input, ui)),
		resume: ui => job("Continuing saved upgrade", () => queue.resume(ui)),
		cancel: () => job("Reconciling before cancellation", () => queue.cancel()),
		attach: (id, actionId, hash) => job("Recovering transaction outcome", () => queue.attach(id, actionId, hash)),
		close: () => provider?.destroy(),
	};
}
