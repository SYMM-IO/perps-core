import {
	buildConfigurationMigration,
	captureConfigurationSnapshot,
	verifyConfigurationMigration,
} from "../../deployment-tooling/operations/configuration-migration.js";
import { loadConfigurationRequest, prepareConfiguration } from "../../deployment-tooling/operations/configuration-request.js";
import { hashBytes, operationDigest } from "../../deployment-tooling/operations/inputs.js";
import { createTaskRunner } from "../task-runner.js";
import { prepareConfigurationRequest } from "../tasks/configuration-prepare.js";
import { TASK_DEFINITIONS } from "../tasks/registry.js";
import { coreUpgradeFixture, read, write } from "./fixtures/core-upgrade.js";
import { Interface, keccak256, toBeHex } from "ethers";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

async function fixture(t) {
	const f = await coreUpgradeFixture(t),
		address = n => toBeHex(n, 20),
		code = "0x6000",
		block = { blockNumber: 12, blockHash: toBeHex(12, 32) };
	const profile = {
		schemaVersion: 1,
		kind: "symmio.configuration-profile",
		chainId: f.config.network.chainId,
		source: { address: address(1), codeHash: keccak256(code) },
		fields: [
			{
				id: "cooldown",
				mode: "copy",
				read: { signature: "function revocationCooldown() view returns(uint256)", args: [] },
				write: { signature: "function setRevocationCooldown(uint256)", args: [{ ref: "observed" }] },
				authority: { address: address(3), read: { signature: "function owner() view returns(address)", args: [] } },
				expectedValue: "600",
			},
		],
	};
	const target = { address: address(2), codeHash: keccak256(code) },
		dir = path.join(f.root, "configuration");
	fs.mkdirSync(dir);
	const profileFile = path.join(dir, "profile.json");
	write(profileFile, profile);
	const request = {
		schemaVersion: 1,
		kind: "symmio.configuration-request",
		sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.root, encoding: "utf8" }).trim(),
		credentialRecipe: path.relative(dir, f.input.config),
		profile: { file: "profile.json", sha256: hashBytes(fs.readFileSync(profileFile)) },
		sourceCheckpoint: block,
		target: { contract: target, checkpoint: block },
	};
	const requestPath = path.join(dir, "request.json");
	write(requestPath, request);
	const iface = new Interface([profile.fields[0].read.signature, profile.fields[0].authority.read.signature]),
		values = { target: "300" },
		calls = [];
	const provider = {
		send: async (method, args) => {
			calls.push([method, args]);
			if (method === "eth_chainId") return toBeHex(profile.chainId);
			if (method === "eth_getBlockByNumber") return { hash: block.blockHash };
			if (method === "eth_getCode") return code;
			if (method !== "eth_call") throw new Error(`Unexpected RPC call ${method}`);
			const fn = iface.parseTransaction(args[0]);
			return iface.encodeFunctionResult(fn.fragment, [
				fn.name === "owner" ? address(3) : args[0].to === profile.source.address ? "600" : values.target,
			]);
		},
	};
	return {
		...f,
		profile,
		target,
		block,
		request,
		requestPath,
		profileFile,
		bundle: loadConfigurationRequest(requestPath),
		provider,
		calls,
		values,
	};
}

test("configuration plans bind exact values, authority and pinned reads without storage discovery", async t => {
	const f = await fixture(t),
		result = await prepareConfiguration(f.provider, f.bundle);
	assert.equal(result.status, "planned");
	assert.equal(result.plan.actions.length, 1);
	assert.equal(result.plan.actions[0].authority, f.profile.fields[0].authority.address);
	f.values.target = "600";
	assert.equal((await verifyConfigurationMigration(f.provider, result.plan, f.block)).fields, 1);
	assert.equal((await buildConfigurationMigration(f.provider, f.profile, result.snapshot, f.target, f.block)).actions.length, 0);
	assert.ok(f.calls.every(([name, args]) => name === "eth_chainId" || args.includes("0x0c")));
	assert.ok(f.calls.every(([name]) => ["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"].includes(name)));
	const forged = structuredClone(result.snapshot);
	forged.fields[0].value = "700";
	await assert.rejects(buildConfigurationMigration(f.provider, f.profile, forged, f.target, f.block), /pinned source/);
	await assert.rejects(verifyConfigurationMigration(f.provider, { ...result.plan, actions: [] }, f.block), /plan changed/);
});

test("configuration request rejects dependency drift, unexpected state data and supplied value mismatch", async t => {
	const f = await fixture(t);
	await assert.rejects(
		captureConfigurationSnapshot(f.provider, { ...f.profile, fields: [{ ...f.profile.fields[0], expectedValue: "701" }] }, f.block),
		/Supplied configuration differs/,
	);
	write(f.requestPath, { ...f.request, users: { nonces: [] } });
	assert.throws(() => loadConfigurationRequest(f.requestPath), /Invalid configuration request/);
	write(f.requestPath, f.request);
	fs.appendFileSync(f.profileFile, " ");
	assert.throws(() => loadConfigurationRequest(f.requestPath), /profile changed/);
});

test("registered signer-free preparation uses the real runner and binds evidence across retry", async t => {
	const f = await fixture(t),
		definition = TASK_DEFINITIONS.find(task => task.id === "operations.prepare-configuration"),
		input = prepareConfigurationRequest(f.requestPath);
	assert.equal(definition.risk, "local-write");
	assert.ok(!definition.inputs.some(i => i.id === "signer"));
	let fail = true,
		subprocesses = 0;
	const run = (ctx, prepared) =>
		definition.run(
			{
				...ctx,
				runProcess: async (command, args, options) => {
					assert.equal(command, "./node_modules/.bin/hardhat");
					assert.equal(args[0], "internal:configuration-prepare");
					assert.equal(options.env.SYMMIO_RECIPE_READ_ONLY, "true");
					assert.equal(options.env.SYMMIO_SIGNER_MODE, "safe-file");
					const output = args[args.indexOf("--output") + 1];
					fs.mkdirSync(path.dirname(output), { recursive: true });
					write(output, await prepareConfiguration(f.provider, f.bundle));
					subprocesses++;
					if (fail) {
						fail = false;
						throw new Error("Interrupted after inspection");
					}
				},
			},
			prepared,
		);
	const task = { ...definition, run, handler: run },
		runner = createTaskRunner({ root: f.root, definitions: [task] }),
		ui = { note() {}, confirm: async () => true };
	let state = await runner.start(task.id, { input, ui });
	assert.equal(state.status, "paused", state.lastError);
	state = await runner.resumeActive({ ui });
	assert.equal(state.status, "completed", state.lastError);
	assert.equal(subprocesses, 2);
	const output = path.join(f.root, "tasks/data", String(input.chainId), "configuration", state.runId, "prepared-configuration.json");
	assert.equal(operationDigest(read(output)), state.configurationEvidenceDigest);
	write(output, { ...read(output), status: "changed" });
	assert.throws(() => definition.validateResume({ root: f.root, state }, input), /evidence changed/);
	const recipe = read(input.config);
	recipe.name += "-changed";
	write(input.config, recipe);
	assert.throws(() => definition.plan({}, input), /input or recipe changed/);
});
