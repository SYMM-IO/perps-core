import { ROOT, sourceIdentity } from "../server/build.js";
import { inspect } from "../server/chain.js";
import { createEngine, atomicWrite } from "../server/engine.js";
import { digest, selectors, CUT_ABI, canonical } from "../server/model.js";
import { preparePlan } from "../server/planner.js";
import { Contract, ContractFactory, Interface, JsonRpcProvider, Transaction, Wallet, keccak256, toBeHex, toUtf8Bytes, zeroPadValue } from "ethers";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const artifact = relative => JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts/contracts", relative), "utf8"));
const cutArtifact = () => artifact("diamond/facets/DiamondCut/DiamondCutFacet.sol/DiamondCutFacet.json");
const loupeArtifact = () => artifact("diamond/facets/DiamondLoup/DiamondLoupeFacet.sol/DiamondLoupeFacet.json");
const diamondArtifact = () => artifact("diamond/Diamond.sol/Diamond.json");
const versionArtifact = n => artifact(`mocks/WorkbenchFixtures.sol/WorkbenchFacetV${n}.json`);
// Hardhat's first default account, which deploys and owns the test Diamond.
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OWNER_SLOT = toBeHex(BigInt(keccak256(toUtf8Bytes("diamond.standard.diamond.storage"))) + 3n, 32);
async function harness({ safe = false, engineOptions = () => ({}) } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-workbench-test-"));
	const hre = await createHardhatRuntimeEnvironment({ networks: { test: { type: "edr-simulated", chainId: 31337, hardfork: "cancun" } } });
	const server = await hre.network.createServer("test", "127.0.0.1", 0);
	const { port } = await server.listen();
	const url = `http://127.0.0.1:${port}`;
	const provider = new JsonRpcProvider(url, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
	const signer = await provider.getSigner(0),
		deployer = await signer.getAddress();
	const deploy = async (a, args = []) => {
		const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
		await c.waitForDeployment();
		return c;
	};
	const cut = await deploy(cutArtifact()),
		loupe = await deploy(loupeArtifact()),
		v1 = await deploy(versionArtifact(1));
	const safeContract = safe ? await deploy(artifact("mocks/WorkbenchFixtures.sol/WorkbenchSafeFixture.json"), [deployer]) : null;
	const diamond = await deploy(diamondArtifact(), [deployer, await cut.getAddress()]);
	const target = await diamond.getAddress();
	const cutter = new Contract(target, CUT_ABI, signer);
	await (
		await cutter.diamondCut(
			[
				{ facetAddress: await loupe.getAddress(), action: 0, functionSelectors: Object.keys(selectors(loupeArtifact().abi)) },
				{ facetAddress: await v1.getAddress(), action: 0, functionSelectors: Object.keys(selectors(versionArtifact(1).abi)) },
			],
			"0x0000000000000000000000000000000000000000",
			"0x",
		)
	).wait();
	if (safe) {
		await provider.send("hardhat_setStorageAt", [target, OWNER_SLOT, zeroPadValue(await safeContract.getAddress(), 32)]);
	}
	const snapshot = await inspect(provider, target);
	function build(n) {
		const catalog = {};
		for (const [name, a] of [
			["DiamondCutFacet", cutArtifact()],
			["DiamondLoupeFacet", loupeArtifact()],
			["Version", versionArtifact(n)],
		])
			catalog[name] = { ...a, name, selectors: selectors(a.abi), dependencies: [], kind: "facet" };
		const body = {
			version: 1,
			catalog,
			diamond: diamondArtifact(),
			source: sourceIdentity(root),
			inputs: {},
			storageSources: { fixture: "no-storage-change" },
		};
		return { ...body, digest: digest(body) };
	}
	const baseline = build(1),
		desired = build(2);
	const plan = await preparePlan({ snapshot, build: desired, baseline, selected: ["Version"], mode: "patch", removals: [], deployer, provider });
	assert.deepEqual(plan.blockers, []);
	const stateRoot = path.join(root, ".symmio/workbench");
	const planFile = path.join(stateRoot, "plans", `${plan.id}.json`);
	atomicWrite(planFile, { plan, build: desired, deployed: {}, journal: {}, status: "prepared" });
	const engine = createEngine({ root, stateRoot, ...engineOptions({ planFile }) });
	await engine.connect(url, target);
	const ui = { transaction: async ({ sender, request }) => ({ hash: (await (await provider.getSigner(sender)).sendTransaction(request)).hash }) };
	const execute = () =>
		engine.execute(
			plan.id,
			{ confirmation: `31337:${plan.id.slice(0, 8)}`, deploymentMode: "browser", upgradeMode: safe ? "safe" : "browser" },
			ui,
		);
	return {
		root,
		stateRoot,
		url,
		engine,
		plan,
		baseline,
		desired,
		provider,
		signer,
		ui,
		target,
		snapshot,
		planFile,
		execute,
		safeContract,
		close: async () => {
			engine.close();
			provider.destroy();
			await server.close();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}
test("real Diamond: fork rehearsal is isolated, wallet upgrade verifies, identical routing is a no-op", { timeout: 120000 }, async () => {
	const h = await harness();
	try {
		const nonce = await h.provider.getTransactionCount(await h.signer.getAddress());
		const rehearsal = await h.engine.rehearse(h.plan.id);
		assert.equal(rehearsal.status, "passed");
		assert.equal(await h.provider.getTransactionCount(await h.signer.getAddress()), nonce);
		assert.equal(await new Contract(h.target, versionArtifact(1).abi, h.provider).workbenchVersion(), 1n);
		const result = await h.execute();
		assert.equal(result.status, "completed", result.lastError);
		assert.equal(await new Contract(h.target, versionArtifact(2).abi, h.provider).workbenchVersion(), 2n);
		assert.equal(h.engine.read(h.plan.id).status, "verified");
		const fresh = await inspect(h.provider, h.target);
		const noop = await preparePlan({
			snapshot: fresh,
			build: h.desired,
			selected: ["Version"],
			mode: "patch",
			removals: [],
			deployer: await h.signer.getAddress(),
			provider: h.provider,
		});
		assert.equal(noop.changes.length, 0);
		assert.equal(noop.deployments.length, 0);
	} finally {
		await h.close();
	}
});
test("Safe export stays waiting until externally executed, then resumes without duplicate deployments", { timeout: 120000 }, async () => {
	const h = await harness({ safe: true });
	try {
		await h.engine.rehearse(h.plan.id);
		const result = await h.execute();
		assert.equal(result.status, "waiting_external", result.lastError);
		const record = h.engine.read(h.plan.id);
		assert.ok(record.safe);
		assert.notEqual(record.status, "verified");
		await (await h.safeContract.execute(h.target, record.safe.actions[0].data)).wait();
		const nonce = await h.provider.getTransactionCount(await h.signer.getAddress());
		const resumed = await h.engine.resume(h.ui);
		assert.equal(resumed.status, "completed", resumed.lastError);
		assert.equal(await h.provider.getTransactionCount(await h.signer.getAddress()), nonce);
	} finally {
		await h.close();
	}
});
test("storage changes, missing baselines, and stale selector maps are rejected", { timeout: 120000 }, async () => {
	const h = await harness();
	try {
		const input = {
			snapshot: h.snapshot,
			build: h.desired,
			selected: ["Version"],
			mode: "patch",
			removals: [],
			deployer: await h.signer.getAddress(),
			provider: h.provider,
		};
		assert.match((await preparePlan(input)).blockers.join(" "), /baseline/);
		assert.match(
			(await preparePlan({ ...input, baseline: { ...h.baseline, storageSources: { changed: "layout" } } })).blockers.join(" "),
			/Storage/,
		);
		fs.mkdirSync(path.join(h.root, "contracts"));
		fs.writeFileSync(path.join(h.root, "contracts/drift.sol"), "// source changed");
		await assert.rejects(h.engine.rehearse(h.plan.id), /Checkout inputs changed/);
		fs.rmSync(path.join(h.root, "contracts/drift.sol"));
		const cutter = new Contract(h.target, CUT_ABI, h.signer);
		const selector = Object.keys(selectors(versionArtifact(1).abi))[0];
		await (
			await cutter.diamondCut(
				[{ facetAddress: "0x0000000000000000000000000000000000000000", action: 2, functionSelectors: [selector] }],
				"0x0000000000000000000000000000000000000000",
				"0x",
			)
		).wait();
		await assert.rejects(h.engine.rehearse(h.plan.id), /changed/);
	} finally {
		await h.close();
	}
});
test("an interrupted wallet result blocks resend and can recover from its exact transaction hash", { timeout: 120000 }, async () => {
	const h = await harness();
	try {
		await h.engine.rehearse(h.plan.id);
		let submitted;
		const interruptedUI = {
			transaction: async ({ request }) => {
				submitted = await h.signer.sendTransaction(request);
				await submitted.wait();
				throw new Error("browser closed before response");
			},
		};
		const result = await h.engine.execute(
			h.plan.id,
			{ confirmation: `31337:${h.plan.id.slice(0, 8)}`, deploymentMode: "browser", upgradeMode: "browser" },
			interruptedUI,
		);
		assert.equal(result.status, "paused");
		const resumed = await h.engine.resume(h.ui);
		assert.equal(resumed.status, "waiting_external");
		await h.engine.attachHash(h.plan.id, "deploy.version", submitted.hash);
		const finished = await h.engine.resume(h.ui);
		assert.equal(finished.status, "completed", finished.lastError);
		assert.equal(Object.keys(h.engine.read(h.plan.id).journal).length, 2);
	} finally {
		await h.close();
	}
});

test("a recreated engine reopens its open task, refuses to resume until reconnected, then completes it", { timeout: 120000 }, async () => {
	const h = await harness({ safe: true });
	let restarted;
	try {
		await h.engine.rehearse(h.plan.id);
		assert.equal((await h.execute()).status, "waiting_external");
		h.engine.close();
		restarted = createEngine({ root: h.root, stateRoot: h.stateRoot });
		const status = restarted.status();
		assert.equal(status.needsReconnect, true);
		assert.equal(status.activePlanId, h.plan.id);
		assert.equal(status.snapshot.target, h.target, "the plan's pinned snapshot is shown after a restart");
		assert.equal(status.snapshot.restored, true);
		const entry = status.history.find(item => item.id === h.plan.id);
		assert.equal(entry.active, true);
		assert.equal(entry.taskStatus, "waiting_external");
		assert.match(entry.waitingFor, /Safe/);
		assert.equal(entry.rehearsal, "passed");
		await assert.rejects(restarted.resume(h.ui), error => error.code === "reconnect-required");
		await assert.rejects(restarted.compile(), error => error.code === "task-active");
		const reconnected = await restarted.reconnect({ rpc: h.url });
		assert.equal(reconnected.chainId, 31337);
		assert.equal(restarted.status().needsReconnect, false);
		const record = restarted.read(h.plan.id);
		await (await h.safeContract.execute(h.target, record.safe.actions[0].data)).wait();
		const resumed = await restarted.resume(h.ui);
		assert.equal(resumed.status, "completed", resumed.lastError);
		assert.equal(restarted.status().history.find(item => item.id === h.plan.id).status, "verified");
	} finally {
		restarted?.close();
		await h.close();
	}
});
test("an explicit wallet rejection deletes the intent, so the task can be cancelled", { timeout: 120000 }, async () => {
	const h = await harness();
	try {
		await h.engine.rehearse(h.plan.id);
		const prompts = [];
		const result = await h.engine.execute(
			h.plan.id,
			{ confirmation: `31337:${h.plan.id.slice(0, 8)}`, deploymentMode: "browser", upgradeMode: "browser" },
			{
				transaction: async prompt => {
					prompts.push(prompt);
					return { rejected: true };
				},
			},
		);
		assert.equal(result.status, "paused");
		assert.match(result.lastError, /rejected/);
		assert.deepEqual(h.engine.read(h.plan.id).journal, {});
		assert.deepEqual(result.pendingIntents || [], []);
		assert.equal(prompts[0].planId, h.plan.id);
		assert.equal(prompts[0].step, 1);
		assert.equal(prompts[0].of, 2, "one deployment and the cut");
		assert.equal(prompts[0].target, null, "a deployment has no target");
		const cancelled = await h.engine.cancel();
		assert.equal(cancelled.status, "cancelled");
		assert.equal(h.engine.status().active, null);
	} finally {
		await h.close();
	}
});
test("a reverted cut is recorded as failed and blocks resuming until the task is cancelled", { timeout: 120000 }, async () => {
	const h = await harness();
	try {
		await h.engine.rehearse(h.plan.id);
		const wallet = new Wallet(DEPLOYER_KEY);
		const ui = {
			transaction: async ({ request, sender }) => {
				if (request.to?.toLowerCase() !== h.target.toLowerCase())
					return { hash: (await (await h.provider.getSigner(sender)).sendTransaction(request)).hash };
				// Ownership moves after the wallet prompt opens, so the reviewed cut reverts on chain.
				await h.provider.send("hardhat_setStorageAt", [h.target, OWNER_SLOT, zeroPadValue("0x000000000000000000000000000000000000dEaD", 32)]);
				const raw = await wallet.signTransaction(request);
				try {
					await h.provider.send("eth_sendRawTransaction", [raw]);
				} catch {
					/* The node may report the failure; the transaction is still mined. */
				}
				return { hash: Transaction.from(raw).hash };
			},
		};
		await h.engine.execute(h.plan.id, { confirmation: `31337:${h.plan.id.slice(0, 8)}`, deploymentMode: "browser", upgradeMode: "browser" }, ui);
		assert.equal(h.engine.read(h.plan.id).journal.cut.status, "failed", "the revert is recorded as soon as its receipt is seen");
		const resumed = await h.engine.resume(h.ui);
		assert.equal(resumed.status, "paused");
		assert.match(resumed.lastError, /reverted/i);
		const record = h.engine.read(h.plan.id);
		assert.equal(record.journal.cut.status, "failed");
		assert.equal(h.engine.status().history.find(item => item.id === h.plan.id).execution.failed, 1);
		assert.equal((await h.engine.cancel()).status, "cancelled");
	} finally {
		await h.close();
	}
});
test("Ledger signing persists the signed hash before every broadcast", { timeout: 120000 }, async () => {
	const wallet = new Wallet(DEPLOYER_KEY),
		broadcasts = [],
		sessions = [];
	const h = await harness({
		engineOptions: ({ planFile }) => {
			class Recording extends JsonRpcProvider {
				async broadcastTransaction(signed) {
					const hash = Transaction.from(signed).hash;
					const journal = JSON.parse(fs.readFileSync(planFile, "utf8")).journal;
					broadcasts.push(Object.values(journal).some(j => j.hash === hash && j.status === "submitted"));
					return super.broadcastTransaction(signed);
				}
			}
			return {
				providerFactory: url => new Recording(url, undefined, { cacheTimeout: -1, batchMaxCount: 1 }),
				signerFactory: async ({ path: derivation }) => {
					sessions.push({ path: derivation, closed: false });
					const session = sessions.at(-1);
					return {
						signer: { getAddress: async () => wallet.address, signTransaction: request => wallet.signTransaction(request) },
						close: async () => {
							session.closed = true;
						},
					};
				},
			};
		},
	});
	try {
		await h.engine.rehearse(h.plan.id);
		const result = await h.engine.execute(
			h.plan.id,
			{
				confirmation: `31337:${h.plan.id.slice(0, 8)}`,
				deploymentMode: "ledger",
				upgradeMode: "ledger",
				ledgerPath: "m/44'/60'/0'/0/0",
			},
			h.ui,
		);
		assert.equal(result.status, "completed", result.lastError);
		assert.deepEqual(broadcasts, [true, true], "each broadcast happens only after its hash is on disk");
		assert.deepEqual(
			sessions.map(s => [s.path, s.closed]),
			[
				["m/44'/60'/0'/0/0", true],
				["m/44'/60'/0'/0/0", true],
			],
		);
	} finally {
		await h.close();
	}
});
test("prepare refuses a Diamond inspected on another chain, and a new workspace drops the connection", { timeout: 120000 }, async () => {
	const h = await harness();
	try {
		const input = { selected: ["Version"], mode: "patch", removals: [], deployer: await h.signer.getAddress() };
		await assert.rejects(h.engine.prepare(input, { workspaceChainId: 8453 }), error => error.code === "chain-mismatch");
		const status = h.engine.status();
		assert.equal(status.snapshot.chainId, 31337);
		assert.equal(typeof status.snapshot.blockNumber, "number");
		assert.ok(status.snapshot.inspectedAt);
		assert.equal(status.snapshot.facets[0].code, undefined, "facet bytecode stays on the server");
		assert.equal(h.engine.resetForWorkspace({ id: "base-lc", chainId: 8453, nodes: [] }), true);
		assert.equal(h.engine.status().connected, false);
		assert.equal(h.engine.status().snapshot, null);
		await assert.rejects(h.engine.prepare(input, { workspaceChainId: 31337 }), error => error.code === "not-ready");
	} finally {
		await h.close();
	}
});
test("history is indexed once, survives an unreadable plan, and builds are stored once by digest", { timeout: 120000 }, async () => {
	const h = await harness();
	let other;
	try {
		const before = h.engine.status().history.find(item => item.id === h.plan.id);
		assert.deepEqual(
			{ family: before.family, rehearsal: before.rehearsal, active: before.active, execution: before.execution },
			{ family: "diamond", rehearsal: "none", active: false, execution: undefined },
		);
		// The harness saved this record with its build embedded, as older plans were.
		assert.ok(JSON.parse(fs.readFileSync(h.planFile, "utf8")).build);
		await h.engine.rehearse(h.plan.id);
		const saved = JSON.parse(fs.readFileSync(h.planFile, "utf8"));
		assert.equal(saved.build, undefined, "a saved plan names its build instead of embedding it");
		assert.ok(fs.existsSync(path.join(h.stateRoot, "builds", `${h.desired.digest}.json`)));
		assert.equal(h.engine.read(h.plan.id).build.digest, h.desired.digest);
		assert.equal(h.engine.readPlan(h.plan.id).build, undefined);
		assert.equal(h.engine.status().history.find(item => item.id === h.plan.id).rehearsal, "passed");
		const result = await h.execute();
		assert.equal(result.status, "completed", result.lastError);
		const done = h.engine.status().history.find(item => item.id === h.plan.id);
		assert.equal(done.status, "verified");
		assert.deepEqual(done.execution, { confirmed: 2, submitted: 0, unresolved: 0, failed: 0 });
		fs.writeFileSync(path.join(h.stateRoot, "plans", `${"f".repeat(64)}.json`), "{ not json");
		other = createEngine({ root: h.root, stateRoot: h.stateRoot });
		assert.deepEqual(
			other.status().history.map(item => item.id),
			[h.plan.id],
		);
	} finally {
		other?.close();
		await h.close();
	}
});
