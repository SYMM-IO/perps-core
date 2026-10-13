import { ROOT, sourceIdentity } from "../server/build.js";
import { inspect } from "../server/chain.js";
import { createEngine, atomicWrite } from "../server/engine.js";
import { digest, selectors, CUT_ABI, canonical } from "../server/model.js";
import { preparePlan } from "../server/planner.js";
import { Contract, ContractFactory, Interface, JsonRpcProvider } from "ethers";
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
async function harness({ safe = false } = {}) {
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
		const { keccak256, toUtf8Bytes, toBeHex, zeroPadValue } = await import("ethers");
		await provider.send("hardhat_setStorageAt", [
			target,
			toBeHex(BigInt(keccak256(toUtf8Bytes("diamond.standard.diamond.storage"))) + 3n, 32),
			zeroPadValue(await safeContract.getAddress(), 32),
		]);
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
	const engine = createEngine({ root, stateRoot });
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
