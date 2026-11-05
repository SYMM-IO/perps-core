import {
	deploymentCheckpointPath,
	deploymentRecordDir,
	isLiveMainnet,
	loadEnv,
	resolveRpc,
	resolveNetwork,
	rpcEnvKey,
	rpcUrl,
	verificationProviderForChain,
} from "../lib/context.js";
import { EXPECTED_CORE_FACETS, checkFacetMirrorDrift } from "../lib/facets-mirror.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("dotenv parsing matches dotenv and process environment wins", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-cli-env-"));
	const envPath = path.join(dir, ".env");
	fs.writeFileSync(envPath, 'VALUE="from file"\nINLINE=file # comment\nONLY_FILE=yes\nSECRET=file-secret\n');

	try {
		const loaded = loadEnv(envPath, { VALUE: "from process", SECRET: "process-secret" });
		assert.equal(loaded.vars.VALUE, "from process");
		assert.equal(loaded.vars.INLINE, "file");
		assert.equal(loaded.vars.ONLY_FILE, "yes");
		assert.equal(loaded.vars.SECRET, "process-secret");
		assert.equal(loaded.fileVars.SECRET, "file-secret");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("supported fork aliases resolve as simulations of their upstream chains", () => {
	for (const upstream of ["arbitrum", "base", "bsc", "mantle", "hyperevm"]) {
		const live = resolveNetwork(upstream);
		const fork = resolveNetwork(`fork-${upstream}`);
		assert.equal(fork.chainId, live.chainId);
		assert.equal(fork.upstream, upstream);
		assert.equal(fork.simulated, true);
		assert.equal(isLiveMainnet(fork), false);
	}
});

test("fork RPC and checkpoint scopes use upstream config without touching live paths", () => {
	const fork = resolveNetwork("fork-arbitrum");
	assert.equal(rpcEnvKey(fork.key), "RPC_ARBITRUM");
	assert.equal(rpcUrl(fork.key, { RPC_ARBITRUM: "https://example.invalid/rpc" }), "https://example.invalid/rpc");
	assert.match(deploymentCheckpointPath(fork.chainId, { simulated: true }), /checkpoint-42161-fork\.json$/);
	assert.match(
		deploymentCheckpointPath(fork.chainId, { simulated: true, scope: "component-release-partyB" }),
		/checkpoint-42161-fork-component-release-partyB\.json$/,
	);
	assert.match(deploymentCheckpointPath(fork.chainId), /checkpoint-42161\.json$/);
	assert.throws(() => deploymentCheckpointPath(fork.chainId, { scope: "../escape" }), /invalid deployment checkpoint scope/);
	assert.match(deploymentRecordDir(fork.chainId, { simulated: true }), /tasks\/data\/42161-fork$/);
	assert.match(deploymentRecordDir(fork.chainId), /tasks\/data\/42161$/);
});

test("RPC resolution mirrors Hardhat override and encrypted-keystore precedence", () => {
	assert.deepEqual(resolveRpc("arbitrum", { RPC_ARBITRUM: "https://env.invalid" }), {
		url: "https://env.invalid",
		source: "RPC_ARBITRUM",
		key: "RPC_ARBITRUM",
		inspectable: true,
	});
	assert.deepEqual(
		resolveRpc("arbitrum", {
			USE_KEYSTORE: "true",
			RPC_ARBITRUM: "https://stale-env.invalid",
			SYMMIO_RPC_URL_OVERRIDE: "https://explicit.invalid",
		}),
		{
			url: "https://explicit.invalid",
			source: "SYMMIO_RPC_URL_OVERRIDE",
			key: "RPC_ARBITRUM",
			inspectable: true,
		},
	);
	assert.deepEqual(resolveRpc("arbitrum", { USE_KEYSTORE: "true", RPC_ARBITRUM: "https://stale-env.invalid" }), {
		url: null,
		source: "Hardhat keystore (RPC_ARBITRUM)",
		key: "RPC_ARBITRUM",
		inspectable: false,
	});
	assert.throws(() => rpcUrl("arbitrum", { USE_KEYSTORE: "true" }), /SYMMIO_RPC_URL_OVERRIDE/);
});

test("direct process-env networks preserve their Hardhat-specific RPC behavior", () => {
	assert.equal(
		resolveRpc("fork-hyperevm", {
			USE_KEYSTORE: "true",
			SYMMIO_RPC_URL_OVERRIDE: "https://ignored.invalid",
			RPC_HYPEREVM: "https://fork.invalid",
		}).url,
		"https://fork.invalid",
	);
	assert.equal(resolveRpc("localhost", { SYMMIO_RPC_URL_OVERRIDE: "https://ignored.invalid" }).url, "http://127.0.0.1:8545");
});

test("core facet count mirror matches the deploy task source", () => {
	assert.equal(EXPECTED_CORE_FACETS, 33);
	assert.deepEqual(checkFacetMirrorDrift().problems, []);
});

test("Blockscout chains use current explorer endpoints without an Etherscan key", () => {
	for (const network of ["iota", "mode", "coti"]) {
		const chain = resolveNetwork(network);
		assert.equal(verificationProviderForChain(chain), "blockscout");
		assert.match(chain.verification.apiUrl, /^https:\/\//);
	}
	assert.equal(resolveNetwork("mode").explorer, "https://explorer.mode.network");
	assert.equal(verificationProviderForChain(resolveNetwork("arbitrum")), "etherscan");
});
