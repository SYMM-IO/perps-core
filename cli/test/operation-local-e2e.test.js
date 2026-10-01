import { hashBytes } from "../../deployment-tooling/operations/inputs.js";
import { writeOperationFile } from "../../deployment-tooling/operations/outputs.js";
import { createTaskRunner } from "../task-runner.js";
import { prepareOperationRequest } from "../tasks/operation-plan.js";
import { operationFixture } from "./fixtures/operation.js";
import { Contract, ContractFactory, JsonRpcProvider, ZeroAddress, keccak256 } from "ethers";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test(
	"JSON request reaches the real read-only Hardhat adapter and publishes a standard plan",
	{
		timeout: 90_000,
		skip: process.env.SYMMIO_OPERATIONS_E2E !== "true" ? "set SYMMIO_OPERATIONS_E2E=true to run" : false,
	},
	async () => {
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "operations-e2e-"));
		const server = net.createServer();
		await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
		const port = server.address().port;
		await new Promise(resolve => server.close(resolve));
		const node = spawn("./node_modules/.bin/hardhat", ["node", "--hostname", "127.0.0.1", "--port", String(port)], { stdio: "ignore" });
		const exited = new Promise(resolve => node.once("exit", resolve));
		const endpoint = `http://127.0.0.1:${port}`,
			previousRpc = process.env.OPERATIONS_TEST_RPC;
		process.env.OPERATIONS_TEST_RPC = endpoint;
		const runId = randomUUID();
		const directory = path.resolve("tasks/data/31337/operations", runId);
		let provider;
		try {
			let ready = false;
			for (let i = 0; i < 100; i++) {
				try {
					const response = await fetch(endpoint, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
						signal: AbortSignal.timeout(500),
					});
					if ((await response.json()).result === "0x7a69") {
						ready = true;
						break;
					}
				} catch {}
				await new Promise(resolve => setTimeout(resolve, 200));
			}
			assert.ok(ready, "isolated localhost node did not start");
			provider = new JsonRpcProvider(endpoint);
			const signer = await provider.getSigner();
			const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
			const names = {
				cut: "diamond/facets/DiamondCut/DiamondCutFacet.sol/DiamondCutFacet",
				loupe: "diamond/facets/DiamondLoup/DiamondLoupeFacet.sol/DiamondLoupeFacet",
				view: "core/facets/ViewFacet/ViewFacet.sol/ViewFacet",
				diamond: "diamond/Diamond.sol/Diamond",
			};
			const artifactPaths = Object.fromEntries(
				Object.entries(names).map(([key, name]) => [key, path.resolve(`artifacts/contracts/${name}.json`)]),
			);
			const artifacts = Object.fromEntries(Object.entries(artifactPaths).map(([key, file]) => [key, read(file)]));
			const deploy = async (a, args = []) => {
				const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
				await c.waitForDeployment();
				return c;
			};
			const cut = await deploy(artifacts.cut),
				loupe = await deploy(artifacts.loupe),
				view = await deploy(artifacts.view);
			const owner = await signer.getAddress(),
				diamond = await deploy(artifacts.diamond, [owner, await cut.getAddress()]);
			await (
				await new Contract(await diamond.getAddress(), artifacts.cut.abi, signer).diamondCut(
					[
						[await loupe.getAddress(), 0, [loupe.interface.getFunction("facets").selector]],
						[await view.getAddress(), 0, [view.interface.getFunction("getOwner").selector]],
					],
					ZeroAddress,
					"0x",
				)
			).wait();
			const f = operationFixture(scratch);
			const recipe = read(f.recipeFile);
			recipe.secrets.rpc = "env://OPERATIONS_TEST_RPC";
			writeOperationFile(f.recipeFile, recipe);
			f.profile.components.core = {
				address: await diamond.getAddress(),
				upgradeAuthority: owner,
				baseline: {
					id: "core-fixture",
					facetCodeHashes: await Promise.all([cut, loupe, view].map(async c => keccak256(await provider.getCode(await c.getAddress())))),
				},
			};
			writeOperationFile(f.profileFile, f.profile);
			f.release.sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
			f.release.components.core.facets = ["loupe", "view"].map(key => ({
				artifactPath: artifactPaths[key],
				sha256: hashBytes(fs.readFileSync(artifactPaths[key])),
			}));
			writeOperationFile(f.releaseFile, f.release);
			const input = prepareOperationRequest(f.file);
			const before = await provider.send("eth_blockNumber", []);
			const runner = createTaskRunner({ stateRoot: path.join(scratch, "state"), idFactory: () => runId });
			const state = await runner.start("operations.plan", { input, ui: { note() {} } });
			assert.equal(state.status, "completed", state.lastError);
			assert.equal(state.result.status, "planned");
			assert.deepEqual(state.transactions, []);
			assert.equal(await provider.send("eth_blockNumber", []), before);
			assert.equal(read(path.join(directory, "plan.json")).executable, false);
			assert.equal(read(path.join(directory, "snapshot.json")).owner, owner);
		} finally {
			provider?.destroy();
			node.kill("SIGTERM");
			await exited;
			if (previousRpc === undefined) delete process.env.OPERATIONS_TEST_RPC;
			else process.env.OPERATIONS_TEST_RPC = previousRpc;
			fs.rmSync(scratch, { recursive: true, force: true });
			fs.rmSync(directory, { recursive: true, force: true });
		}
	},
);
