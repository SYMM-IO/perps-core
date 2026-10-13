import { ROOT, loadBuild } from "../server/build.js";
import { createFork, inspect } from "../server/chain.js";
import { CUT_ABI, selectors, linkBytecode } from "../server/model.js";
import { preparePeripheral, assertPeripheralInputs } from "../server/peripherals.js";
import { preparePlan } from "../server/planner.js";
import { inspectSystem, systemDiff, validateProfile, IMPLEMENTATION_SLOT } from "../server/system.js";
import { createWorkspace } from "../server/workspace.js";
import { Contract, ContractFactory, JsonRpcProvider, ZeroAddress, ZeroHash, id } from "ethers";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
			if (scope === "verifier") assert.ok(record.plan.actions.some(a => a.method === "setPublicKeyPermissions" && a.args[1].includes(255)));
			const rehearsed = await workspace.rehearse(record.plan.id);
			assert.equal(rehearsed.rehearsal.status, "passed");
			assert.equal(await h.provider.getTransactionCount(h.admin), nonce, "rehearsal must not send live transactions");
			await assert.rejects(workspace.safe(record.plan.id), /Deploy the reviewed/);
			const executed = await workspace.execute(
				record.plan.id,
				{ confirmation: `31337:${record.plan.id.slice(0, 8)}`, deploymentMode: "browser", upgradeMode: "browser" },
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
		const result = await workspace.execute(
			r.plan.id,
			{ confirmation: `31337:${r.plan.id.slice(0, 8)}`, deploymentMode: "browser", upgradeMode: "safe" },
			ui,
		);
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
