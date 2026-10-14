import { ROOT, loadBuild } from "../server/build.js";
import { createFork, inspect } from "../server/chain.js";
import { CUT_ABI, selectors, linkBytecode } from "../server/model.js";
import { preparePeripheral, assertPeripheralInputs } from "../server/peripherals.js";
import { preparePlan } from "../server/planner.js";
import { inspectSystem, systemDiff, validateProfile, IMPLEMENTATION_SLOT } from "../server/system.js";
import { createWorkspace } from "../server/workspace.js";
import { Contract, ContractFactory, JsonRpcProvider, Transaction, Wallet, ZeroAddress, ZeroHash, id } from "ethers";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Hardhat's first default account: the harness admin, deployer and authority.
const ADMIN_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// Peripheral plans for the test profile carry its deployment id, so that is what an operator types.
const confirm = plan => `test:${plan.id.slice(0, 8)}`;
const walletUI = h => ({ transaction: async ({ request }) => ({ hash: (await h.signer.sendTransaction(request)).hash }) });
const artifact = relative => JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts/contracts", relative), "utf8"));
const files = {
	diamond: "diamond/Diamond.sol/Diamond.json",
	cut: "diamond/facets/DiamondCut/DiamondCutFacet.sol/DiamondCutFacet.json",
	loupe: "diamond/facets/DiamondLoup/DiamondLoupeFacet.sol/DiamondLoupeFacet.json",
	core: "mocks/WorkbenchFixtures.sol/WorkbenchSystemFacet.json",
	verifier: "helpers/verification/SymmioSignatureVerifier.sol/MuonSignatureVerifier.json",
	party: "helpers/accounts/SymmioPartyB.sol/SymmioPartyB.json",
	proxy: "helpers/utils/LocalERC1967Proxy.sol/LocalERC1967Proxy.json",
};
async function harness() {
	const hre = await createHardhatRuntimeEnvironment({
		networks: { test: { type: "edr-simulated", chainId: 31337, hardfork: "cancun", blockGasLimit: 60_000_000 } },
	});
	const server = await hre.network.createServer("test", "127.0.0.1", 0);
	const { port } = await server.listen();
	const url = `http://127.0.0.1:${port}`,
		provider = new JsonRpcProvider(url, undefined, { cacheTimeout: -1, batchMaxCount: 1 }),
		signer = await provider.getSigner(0),
		admin = await signer.getAddress();
	const deploy = async (key, args = []) => {
		const a = artifact(files[key]);
		const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
		await c.waitForDeployment();
		return c;
	};
	const cut = await deploy("cut"),
		loupe = await deploy("loupe"),
		facet = await deploy("core"),
		diamond = await deploy("diamond", [admin, await cut.getAddress()]),
		core = new Contract(await diamond.getAddress(), artifact(files.core).abi, signer);
	await (
		await new Contract(await core.getAddress(), CUT_ABI, signer).diamondCut(
			[
				...[
					[loupe, "loupe"],
					[facet, "core"],
				].map(([c, k]) => ({ facetAddress: c.target, action: 0, functionSelectors: Object.keys(selectors(artifact(files[k]).abi)) })),
			],
			ZeroAddress,
			"0x",
		)
	).wait();
	await (await core.setupWorkbenchAdmin(admin)).wait();
	const verifier = await deploy("verifier", [admin]);
	await (await verifier.addPublicKey([123, 0])).wait();
	await (await verifier.addGatewaySigner(admin)).wait();
	await (await verifier.setPublicKeyPermissions([123, 0], [0, 17, 255], true)).wait();
	await (await verifier.setGatewaySignerPermissions(admin, [0, 255], true)).wait();
	await (await core.setSignatureVerifierAddress(verifier.target)).wait();
	const implementation = await deploy("party"),
		partyProxy = await deploy("proxy", [implementation.target, implementation.interface.encodeFunctionData("initialize", [admin, core.target])]),
		party = new Contract(partyProxy.target, artifact(files.party).abi, signer);
	const profile = {
		id: "test",
		name: "Local full system",
		chainId: 31337,
		nodes: [
			{ id: "core", name: "Core", kind: "core", address: core.target },
			{ id: "partyB", name: "PartyB", kind: "partyB", address: party.target },
			{ id: "verifier", name: "Verifier", kind: "verifier", address: verifier.target },
		],
	};
	return {
		provider,
		signer,
		admin,
		url,
		profile,
		core,
		party,
		verifier,
		close: async () => {
			provider.destroy();
			await server.close();
		},
	};
}

test("profile validation and state diffs never treat unavailable state as verified", () => {
	assert.throws(() => validateProfile({ chainId: 1, nodes: [] }), /Core/);
	const before = { nodes: [{ id: "x", address: "a", state: { paused: false }, status: "observed" }], edges: [] };
	const after = { nodes: [{ id: "x", address: "a", state: { paused: true }, status: "unavailable" }], edges: [] };
	const changes = systemDiff(before, after);
	assert.ok(changes.some(c => c.field === "paused" && c.before === false && c.after === true));
	assert.ok(changes.some(c => c.field === "status"));
});
for (const scope of ["verifier", "partyB"])
	test(`${scope}: prepares, rehearses and verifies a full upgrade with real contracts`, { timeout: 120000 }, async () => {
		const h = await harness();
		const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-system-test-"));
		const workspace = createWorkspace({ stateRoot, taskRoot: stateRoot });
		try {
			const snapshot = await workspace.scan(h.url, h.profile);
			assert.equal(snapshot.edges.find(e => e.label === "getSignatureVerifier").status, "verified");
			const nonce = await h.provider.getTransactionCount(h.admin);
			const record = await workspace.prepare({ nodeId: scope, deployer: h.admin, authority: h.admin });
			assert.deepEqual(record.plan.blockers, []);
			const saved = workspace.status().history.find(item => item.id === record.plan.id);
			assert.equal(saved.scope, scope);
			assert.equal(saved.chainId, record.plan.chainId);
			assert.equal(saved.target, record.plan.sourceAddress);
			assert.equal(saved.family, "system");
			assert.equal(saved.rehearsal, "none");
			assert.deepEqual(record.plan.deployment, { id: "test", name: "Local full system", environment: "Custom", chainId: 31337 });
			if (scope === "verifier") assert.ok(record.plan.actions.some(a => a.method === "setPublicKeyPermissions" && a.args[1].includes(255)));
			const rehearsed = await workspace.rehearse(record.plan.id);
			assert.equal(rehearsed.rehearsal.status, "passed");
			assert.equal(await h.provider.getTransactionCount(h.admin), nonce, "rehearsal must not send live transactions");
			await assert.rejects(workspace.safe(record.plan.id), /Deploy the reviewed/);
			const executed = await workspace.execute(
				record.plan.id,
				{ confirmation: confirm(record.plan), deploymentMode: "browser", upgradeMode: "browser" },
				{ transaction: async ({ request }) => ({ hash: (await h.signer.sendTransaction(request)).hash }) },
			);
			assert.equal(executed.status, "completed", executed.lastError);
			const verified = await workspace.verify(record.plan.id);
			assert.equal(verified.status, "verified");
			// Remove only this test's generated evidence, never operator state.
			fs.rmSync(path.join(stateRoot, `${record.plan.id}.json`), { force: true });
		} finally {
			workspace.close();
			fs.rmSync(stateRoot, { recursive: true, force: true });
			await h.close();
		}
	});
test("peripheral plans bind the deployment nonce and the source configuration they were prepared from", { timeout: 120000 }, async () => {
	const h = await harness();
	try {
		const system = await inspectSystem(h.provider, h.profile);
		const p = await preparePeripheral({ provider: h.provider, system, nodeId: "verifier", deployer: h.admin, authority: h.admin });
		await assertPeripheralInputs(h.provider, p);
		await (await h.verifier.setGatewaySignerPermissions(h.admin, [7], true)).wait();
		await assert.rejects(assertPeripheralInputs(h.provider, p), /configuration changed|nonce changed/);
	} finally {
		await h.close();
	}
});
test("AccountLayer catalog deploys and produces an exact no-op Diamond plan", { timeout: 120000 }, async () => {
	const h = await harness();
	try {
		const build = await loadBuild(ROOT, "accountLayer"),
			addresses = {};
		for (const a of Object.values(build.catalog)) {
			const data = linkBytecode(a.bytecode, a.linkReferences, addresses);
			const r = await (await h.signer.sendTransaction({ data })).wait();
			addresses[a.name] = r.contractAddress;
		}
		const d = await new ContractFactory(artifact(files.diamond).abi, artifact(files.diamond).bytecode, h.signer).deploy(
			h.admin,
			addresses.DiamondCutFacet,
		);
		await d.waitForDeployment();
		await (
			await new Contract(d.target, CUT_ABI, h.signer).diamondCut(
				Object.values(build.catalog)
					.filter(a => a.kind === "facet" && a.name !== "DiamondCutFacet")
					.map(a => ({ facetAddress: addresses[a.name], action: 0, functionSelectors: Object.keys(a.selectors) })),
				ZeroAddress,
				"0x",
			)
		).wait();
		const snapshot = await inspect(h.provider, d.target);
		const p = await preparePlan({
			snapshot,
			build,
			selected: Object.values(build.catalog)
				.filter(a => a.kind === "facet")
				.map(a => a.name),
			mode: "patch",
			removals: [],
			deployer: h.admin,
			provider: h.provider,
		});
		assert.deepEqual(p.blockers, []);
		assert.deepEqual(p.changes, []);
		assert.equal(p.scope, "accountLayer");
	} finally {
		await h.close();
	}
});

test("Safe peripheral sequence waits after deployment, exports exact calls, then verifies external execution", { timeout: 120000 }, async () => {
	const h = await harness(),
		stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-safe-test-")),
		workspace = createWorkspace({ stateRoot, taskRoot: stateRoot });
	try {
		const a = artifact("mocks/WorkbenchFixtures.sol/WorkbenchSafeFixture.json");
		const safe = await new ContractFactory(a.abi, a.bytecode, h.signer).deploy(h.admin);
		await safe.waitForDeployment();
		await (await h.core.grantRole(safe.target, ZeroHash)).wait();
		await (await h.verifier.grantRole(ZeroHash, safe.target)).wait();
		await (await h.verifier.grantRole(id("SETTER_ROLE"), safe.target)).wait();
		await workspace.scan(h.url, h.profile);
		const r = await workspace.prepare({ nodeId: "verifier", deployer: h.admin, authority: safe.target });
		await workspace.rehearse(r.plan.id);
		const ui = { transaction: async ({ request }) => ({ hash: (await h.signer.sendTransaction(request)).hash }) };
		const result = await workspace.execute(r.plan.id, { confirmation: confirm(r.plan), deploymentMode: "browser", upgradeMode: "safe" }, ui);
		assert.equal(result.status, "waiting_external", result.lastError);
		const batch = await workspace.safe(r.plan.id);
		assert.equal(batch.actions.length, r.plan.actions.length - 1);
		assert.equal(batch.actions.at(-1).data, r.plan.actions.at(-1).data);
		for (const a of batch.actions) await (await safe.execute(a.to, a.data)).wait();
		const nonce = await h.provider.getTransactionCount(h.admin);
		const done = await workspace.resume(ui);
		assert.equal(done.status, "completed", done.lastError);
		assert.equal(await h.provider.getTransactionCount(h.admin), nonce);
	} finally {
		workspace.close();
		await h.close();
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

// Deploys a Safe-shaped authority that holds the roles a verifier replacement needs.
async function safeAuthority(h) {
	const a = artifact("mocks/WorkbenchFixtures.sol/WorkbenchSafeFixture.json");
	const safe = await new ContractFactory(a.abi, a.bytecode, h.signer).deploy(h.admin);
	await safe.waitForDeployment();
	await (await h.core.grantRole(safe.target, ZeroHash)).wait();
	await (await h.verifier.grantRole(ZeroHash, safe.target)).wait();
	await (await h.verifier.grantRole(id("SETTER_ROLE"), safe.target)).wait();
	return safe;
}
test("a recreated workspace reopens its Safe-waiting task, reconnects without a scan and completes it", { timeout: 120000 }, async () => {
	const h = await harness(),
		stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-restart-test-"));
	let workspace = createWorkspace({ stateRoot, taskRoot: stateRoot });
	try {
		const safe = await safeAuthority(h);
		await workspace.scan({ rpc: h.url, profile: h.profile });
		const r = await workspace.prepare({ nodeId: "verifier", deployer: h.admin, authority: safe.target });
		await workspace.rehearse(r.plan.id);
		const result = await workspace.execute(
			r.plan.id,
			{ confirmation: confirm(r.plan), deploymentMode: "browser", upgradeMode: "safe" },
			walletUI(h),
		);
		assert.equal(result.status, "waiting_external", result.lastError);
		workspace.close();
		// A plan file nobody can read must not hide the rest of the history.
		fs.writeFileSync(path.join(stateRoot, `${"e".repeat(64)}.json`), "{ not json");
		workspace = createWorkspace({ stateRoot, taskRoot: stateRoot });
		const status = workspace.status();
		assert.equal(status.profile.id, "test", "the deployment the task belongs to is selected on start");
		assert.equal(status.snapshot.chainId, 31337, "and its saved snapshot restored");
		assert.equal(status.live, false);
		assert.equal(status.needsReconnect, true);
		assert.equal(status.activePlanId, r.plan.id);
		const entry = status.history.find(item => item.id === r.plan.id);
		assert.deepEqual(
			{ active: entry.active, taskStatus: entry.taskStatus, rehearsal: entry.rehearsal, deployment: entry.deployment.id },
			{ active: true, taskStatus: "waiting_external", rehearsal: "passed", deployment: "test" },
		);
		assert.match(entry.waitingFor, /Safe/);
		assert.equal(entry.execution.confirmed, 1);
		assert.equal(status.history.length, 1);
		await assert.rejects(workspace.resume(walletUI(h)), error => error.code === "reconnect-required");
		await assert.rejects(workspace.prepare({ nodeId: "verifier", deployer: h.admin, authority: h.admin }), error => error.code === "not-ready");
		assert.equal((await workspace.reconnect({ rpc: h.url })).planId, r.plan.id);
		assert.equal(workspace.status().needsReconnect, false);
		await assert.rejects(
			workspace.prepare({ nodeId: "verifier", deployer: h.admin, authority: h.admin }),
			error => error.code === "stale-snapshot",
		);
		const batch = await workspace.safe(r.plan.id);
		for (const a of batch.actions) await (await safe.execute(a.to, a.data)).wait();
		const done = await workspace.resume(walletUI(h));
		assert.equal(done.status, "completed", done.lastError);
		assert.equal(workspace.status().history.find(item => item.id === r.plan.id).status, "verified");
	} finally {
		workspace.close();
		await h.close();
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});
test("after a restart, a lost wallet response is recovered by attaching its hash", { timeout: 120000 }, async () => {
	const h = await harness(),
		stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-attach-test-"));
	let workspace = createWorkspace({ stateRoot, taskRoot: stateRoot });
	try {
		await workspace.scan(h.url, h.profile);
		const r = await workspace.prepare({ nodeId: "verifier", deployer: h.admin, authority: h.admin });
		await workspace.rehearse(r.plan.id);
		let submitted;
		const interrupted = {
			transaction: async ({ request }) => {
				submitted = await h.signer.sendTransaction(request);
				await submitted.wait();
				throw new Error("browser closed before response");
			},
		};
		const paused = await workspace.execute(
			r.plan.id,
			{ confirmation: confirm(r.plan), deploymentMode: "browser", upgradeMode: "browser" },
			interrupted,
		);
		assert.equal(paused.status, "paused");
		workspace.close();
		workspace = createWorkspace({ stateRoot, taskRoot: stateRoot });
		assert.equal(workspace.status().history.find(item => item.id === r.plan.id).execution.unresolved, 1);
		await workspace.reconnect({ rpc: h.url });
		const waiting = await workspace.resume(walletUI(h));
		assert.equal(waiting.status, "waiting_external", "an unknown wallet outcome is never re-sent");
		await workspace.attach(r.plan.id, r.plan.actions[0].id, submitted.hash);
		assert.equal(workspace.status().history.find(item => item.id === r.plan.id).execution.confirmed, 1);
		const done = await workspace.resume(walletUI(h));
		assert.equal(done.status, "completed", done.lastError);
		assert.equal(workspace.read(r.plan.id).journal[r.plan.actions[0].id].hash, submitted.hash);
	} finally {
		workspace.close();
		await h.close();
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});
test("a peripheral wallet rejection deletes the intent and the prompt names its plan and step", { timeout: 120000 }, async () => {
	const h = await harness(),
		stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-reject-test-")),
		workspace = createWorkspace({ stateRoot, taskRoot: stateRoot });
	try {
		await workspace.scan(h.url, h.profile);
		const r = await workspace.prepare({ nodeId: "partyB", deployer: h.admin, authority: h.admin });
		await workspace.rehearse(r.plan.id);
		const prompts = [];
		const result = await workspace.execute(
			r.plan.id,
			{ confirmation: confirm(r.plan), deploymentMode: "browser", upgradeMode: "browser" },
			{
				transaction: async prompt => {
					prompts.push(prompt);
					return { rejected: true };
				},
			},
		);
		assert.equal(result.status, "paused");
		assert.deepEqual(workspace.read(r.plan.id).journal, {});
		assert.deepEqual(result.pendingIntents || [], []);
		assert.deepEqual(
			{ planId: prompts[0].planId, step: prompts[0].step, of: prompts[0].of, target: prompts[0].target },
			{ planId: r.plan.id, step: 1, of: r.plan.actions.length, target: null },
		);
		assert.equal(workspace.status().waitingFor, null, "nothing waits on the wallet once it has answered");
		assert.equal((await workspace.cancel()).status, "cancelled");
	} finally {
		workspace.close();
		await h.close();
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});
test("a reverted peripheral transaction is recorded as failed and blocks resuming until the task is cancelled", { timeout: 120000 }, async () => {
	const h = await harness(),
		stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-revert-test-")),
		workspace = createWorkspace({ stateRoot, taskRoot: stateRoot }),
		wallet = new Wallet(ADMIN_KEY);
	try {
		// A second admin revokes the authority later; the authority's own nonce must stay the one the wallet signs with.
		const other = await h.provider.getSigner(1);
		await (await h.party.grantRole(ZeroHash, await other.getAddress())).wait();
		await workspace.scan(h.url, h.profile);
		const r = await workspace.prepare({ nodeId: "partyB", deployer: h.admin, authority: h.admin });
		await workspace.rehearse(r.plan.id);
		const upgrade = r.plan.actions.find(a => a.to);
		const ui = {
			transaction: async ({ request, id: actionId }) => {
				if (actionId !== upgrade.id) return { hash: (await h.signer.sendTransaction(request)).hash };
				// The authority loses its role after the prompt opens, so the reviewed upgrade reverts on chain.
				await (await h.party.connect(other).revokeRole(ZeroHash, h.admin)).wait();
				const raw = await wallet.signTransaction(request);
				try {
					await h.provider.send("eth_sendRawTransaction", [raw]);
				} catch {
					/* The node may report the failure; the transaction is still mined. */
				}
				return { hash: Transaction.from(raw).hash };
			},
		};
		const result = await workspace.execute(r.plan.id, { confirmation: confirm(r.plan), deploymentMode: "browser", upgradeMode: "browser" }, ui);
		assert.notEqual(result.status, "completed");
		const journal = workspace.read(r.plan.id).journal;
		assert.equal(journal[upgrade.id].status, "failed");
		assert.equal(journal[r.plan.actions[0].id].status, "confirmed");
		assert.equal(workspace.status().history.find(item => item.id === r.plan.id).execution.failed, 1);
		const resumed = await workspace.resume(walletUI(h));
		assert.equal(resumed.status, "paused");
		assert.match(resumed.lastError, /reverted/i);
		assert.equal((await workspace.cancel()).status, "cancelled");
		assert.equal(workspace.status().active, null);
	} finally {
		workspace.close();
		await h.close();
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});
test("peripheral Ledger signing persists the signed hash before every broadcast", { timeout: 120000 }, async () => {
	const h = await harness(),
		stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-ledger-test-")),
		wallet = new Wallet(ADMIN_KEY),
		broadcasts = [];
	let planFile;
	class Recording extends JsonRpcProvider {
		async broadcastTransaction(signed) {
			const hash = Transaction.from(signed).hash;
			const journal = JSON.parse(fs.readFileSync(planFile, "utf8")).journal;
			broadcasts.push(Object.values(journal).some(j => j.hash === hash && j.status === "submitted"));
			return super.broadcastTransaction(signed);
		}
	}
	const workspace = createWorkspace({
		stateRoot,
		taskRoot: stateRoot,
		providerFactory: (url, { staticNetwork = false } = {}) =>
			new Recording(url, undefined, { cacheTimeout: -1, batchMaxCount: 1, ...(staticNetwork ? { staticNetwork: true } : {}) }),
		signerFactory: async () => ({
			signer: { getAddress: async () => wallet.address, signTransaction: request => wallet.signTransaction(request) },
		}),
	});
	try {
		await workspace.scan(h.url, h.profile);
		const r = await workspace.prepare({ nodeId: "partyB", deployer: h.admin, authority: h.admin });
		planFile = path.join(stateRoot, `${r.plan.id}.json`);
		await workspace.rehearse(r.plan.id);
		const result = await workspace.execute(
			r.plan.id,
			{ confirmation: confirm(r.plan), deploymentMode: "ledger", upgradeMode: "ledger" },
			walletUI(h),
		);
		assert.equal(result.status, "completed", result.lastError);
		assert.deepEqual(
			broadcasts,
			r.plan.actions.map(() => true),
		);
	} finally {
		workspace.close();
		await h.close();
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});
test(
	"scan and select go ahead beside a paused task on the same chain, and the typed confirmation names the deployment",
	{ timeout: 120000 },
	async () => {
		const h = await harness(),
			stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-select-test-")),
			workspace = createWorkspace({ stateRoot, taskRoot: stateRoot });
		try {
			await workspace.scan(h.url, h.profile);
			const r = await workspace.prepare({ nodeId: "partyB", deployer: h.admin, authority: h.admin });
			await workspace.rehearse(r.plan.id);
			const modes = { deploymentMode: "browser", upgradeMode: "browser" };
			await assert.rejects(
				workspace.execute(r.plan.id, { ...modes, confirmation: `31337:${r.plan.id.slice(0, 8)}` }),
				error => error.code === "confirmation-mismatch",
			);
			const paused = await workspace.execute(
				r.plan.id,
				{ ...modes, confirmation: confirm(r.plan) },
				{ transaction: async () => ({ rejected: true }) },
			);
			assert.equal(paused.status, "paused");
			await workspace.scan({ rpc: h.url, profile: h.profile });
			await assert.rejects(
				Promise.resolve().then(() => workspace.select({ ...h.profile, chainId: 8453 })),
				error => error.code === "task-active",
			);
			await workspace.cancel();
		} finally {
			workspace.close();
			await h.close();
			fs.rmSync(stateRoot, { recursive: true, force: true });
		}
	},
);
test("an inspection that finds nothing new keeps the last list of changes", { timeout: 120000 }, async () => {
	const h = await harness(),
		stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-changes-test-"));
	let workspace = createWorkspace({ stateRoot, taskRoot: stateRoot });
	try {
		await workspace.scan(h.url, h.profile);
		await (await h.verifier.grantRole(id("SETTER_ROLE"), "0x000000000000000000000000000000000000bEEF")).wait();
		await workspace.scan(h.url, h.profile);
		const changed = workspace.status();
		assert.ok(changed.delta.length, "the new setter is a change");
		await workspace.scan(h.url, h.profile);
		const quiet = workspace.status();
		assert.deepEqual(quiet.delta, changed.delta);
		assert.deepEqual(quiet.since, changed.since);
		assert.ok(quiet.snapshot.blockNumber >= changed.snapshot.blockNumber);
		workspace.close();
		workspace = createWorkspace({ stateRoot, taskRoot: stateRoot });
		assert.equal(workspace.select(h.profile).id, "test");
		assert.deepEqual(workspace.status().delta, changed.delta, "and it is still there after a restart");
	} finally {
		workspace.close();
		await h.close();
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});
