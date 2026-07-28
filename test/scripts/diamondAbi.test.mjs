import {
	extractAbiFromEtherscanApi,
	extractAbiFromEtherscanHtml,
	findMatchingArtifact,
	findSelectorMatchingArtifact,
	matchArtifactRuntime,
	mergeLiveFacetAbis,
	normalizeLiveFacets,
	parseDiamondAbiConfig,
	resolveFunctionsFromAbiSnapshots,
} from "../../scripts/utils/diamondAbi.mjs";
import { FunctionFragment } from "ethers";
import assert from "node:assert/strict";
import test from "node:test";

const FACET_A = "0x00000000000000000000000000000000000000A1";
const FACET_B = "0x00000000000000000000000000000000000000b2";
const DIAMOND = "0x00000000000000000000000000000000000000D4";

const alpha = {
	type: "function",
	name: "alpha",
	inputs: [{ name: "value", type: "uint256", internalType: "uint256" }],
	outputs: [{ name: "result", type: "bool", internalType: "bool" }],
	stateMutability: "view",
};
const beta = {
	type: "function",
	name: "beta",
	inputs: [{ name: "account", type: "address", internalType: "address" }],
	outputs: [],
	stateMutability: "nonpayable",
};
const unused = {
	type: "function",
	name: "unused",
	inputs: [],
	outputs: [],
	stateMutability: "view",
};
const changed = {
	...alpha,
	outputs: [{ name: "result", type: "uint256", internalType: "uint256" }],
};
const changedInput = {
	type: "function",
	name: "alpha",
	inputs: [{ name: "value", type: "address", internalType: "address" }],
	outputs: [],
	stateMutability: "view",
};
const event = {
	type: "event",
	name: "Changed",
	anonymous: false,
	inputs: [{ name: "value", type: "uint256", internalType: "uint256", indexed: true }],
};
const error = {
	type: "error",
	name: "Rejected",
	inputs: [{ name: "account", type: "address", internalType: "address" }],
};

const alphaSelector = FunctionFragment.from(alpha).selector.toLowerCase();
const betaSelector = FunctionFragment.from(beta).selector.toLowerCase();

function baseConfig(overrides = {}) {
	return {
		schemaVersion: 1,
		name: "test-chain",
		chainId: 999,
		diamondAddress: DIAMOND,
		rpc: {
			url: "https://rpc.example",
			urlEnv: "RPC_TEST_CHAIN",
		},
		explorers: [
			{
				type: "etherscan-html",
				browserUrl: "https://explorer.example",
			},
		],
		request: {
			concurrency: 2,
			attempts: 2,
			timeoutMs: 1_000,
		},
		localArtifacts: {
			directory: "artifacts/contracts",
			allowSelectorOnlyFallback: true,
		},
		abiSnapshots: [
			{
				type: "git",
				label: "v1",
				ref: "version_1",
				path: "abis/diamond.json",
			},
		],
		outputDirectory: "scripts/output/diamond-abi/test-chain",
		...overrides,
	};
}

test("validates and normalizes a per-chain config", () => {
	const config = parseDiamondAbiConfig(baseConfig());
	assert.equal(config.chainId, 999);
	assert.equal(config.diamondAddress, DIAMOND);
	assert.equal(config.localArtifacts.allowSelectorOnlyFallback, true);
	assert.deepEqual(config.abiSnapshots[0], {
		type: "git",
		label: "v1",
		ref: "version_1",
		path: "abis/diamond.json",
	});

	assert.throws(() => parseDiamondAbiConfig(baseConfig({ diamondAddress: "0x1234" })), /diamondAddress is not a valid EVM address/);
});

test("extracts verified ABI arrays from Etherscan API and HTML responses", () => {
	const abi = [alpha, event];
	assert.deepEqual(
		extractAbiFromEtherscanApi({
			status: "1",
			message: "OK",
			result: JSON.stringify(abi),
		}),
		abi,
	);
	assert.deepEqual(
		extractAbiFromEtherscanHtml(`<pre class="text-wrap" id='js-copytextarea2'>${JSON.stringify(abi).replaceAll('"', "&quot;")}</pre>`),
		abi,
	);
	assert.throws(() => extractAbiFromEtherscanApi({ status: "0", result: "not verified" }), /not verified/);
	assert.throws(() => extractAbiFromEtherscanHtml("<html></html>"), /Contract ABI section was not found/);
});

test("normalizes loupe output and rejects duplicate selector assignments", () => {
	assert.deepEqual(
		normalizeLiveFacets([
			{ facetAddress: FACET_A, functionSelectors: [alphaSelector] },
			{ address: FACET_B, functionSelectors: [betaSelector] },
		]),
		[
			{ address: FACET_A, functionSelectors: [alphaSelector] },
			{ address: FACET_B, functionSelectors: [betaSelector] },
		],
	);
	assert.throws(
		() =>
			normalizeLiveFacets([
				{ facetAddress: FACET_A, functionSelectors: [alphaSelector] },
				{ facetAddress: FACET_B, functionSelectors: [alphaSelector] },
			]),
		/is assigned to both/,
	);
});

test("matches local runtime artifacts with Solidity library placeholders", () => {
	const hash = "a".repeat(34);
	const library = "1111111111111111111111111111111111111111";
	const compiled = `0x60__$${hash}$__61`;
	const deployed = `0x60${library}61`;
	const match = matchArtifactRuntime(deployed, compiled);
	assert.equal(match.match, true);
	assert.deepEqual(match.linkedLibraries, {
		[hash]: "0x1111111111111111111111111111111111111111",
	});
	assert.equal(matchArtifactRuntime(`0x61${library}61`, compiled).match, false);
});

test("prefers bytecode matches and can fall back to narrow selector matches", () => {
	const artifacts = [
		{
			file: "artifacts/Wide.json",
			contractName: "Wide",
			sourceName: "contracts/Wide.sol",
			abi: [alpha, beta, unused],
			deployedBytecode: "0x6001",
		},
		{
			file: "artifacts/AlphaFacet.json",
			contractName: "AlphaFacet",
			sourceName: "contracts/core/facets/Alpha/AlphaFacet.sol",
			abi: [alpha, event],
			deployedBytecode: "0x6002",
		},
	];

	assert.equal(findMatchingArtifact("0x6002", [alphaSelector], artifacts).contractName, "AlphaFacet");
	assert.equal(findSelectorMatchingArtifact([alphaSelector], artifacts).contractName, "AlphaFacet");
	assert.equal(findMatchingArtifact("0x6003", [alphaSelector], artifacts), undefined);
});

test("resolves installed functions from ordered ABI snapshots", () => {
	const resolved = resolveFunctionsFromAbiSnapshots(
		[alphaSelector, betaSelector],
		[
			{ type: "file", label: "new", path: "new.json", abi: [changed, changedInput] },
			{ type: "git", label: "old", ref: "v1", path: "old.json", abi: [alpha, beta] },
		],
	);
	assert.deepEqual(resolved.abi, [changed, beta]);
	assert.deepEqual(
		resolved.functions.map(item => item.snapshot),
		["new", "old"],
	);
	assert.equal(resolveFunctionsFromAbiSnapshots([betaSelector], [{ type: "file", label: "none", abi: [alpha] }]), undefined);
});

test("merges only installed functions while deduplicating events and errors", () => {
	const liveFacets = [
		{ address: FACET_A, functionSelectors: [alphaSelector] },
		{ address: FACET_B, functionSelectors: [betaSelector] },
	];
	const fetched = new Map([
		[
			FACET_A.toLowerCase(),
			{
				abi: [alpha, unused, event, error],
				source: { type: "explorer", url: "https://example/a" },
			},
		],
		[
			FACET_B.toLowerCase(),
			{
				abi: [beta, event, error],
				source: { type: "explorer", url: "https://example/b" },
			},
		],
	]);

	const merged = mergeLiveFacetAbis(liveFacets, fetched, [
		{ type: "constructor", inputs: [], stateMutability: "nonpayable" },
		{ type: "receive", stateMutability: "payable" },
	]);
	assert.equal(merged.selectorCount, 2);
	assert.deepEqual(merged.counts, {
		event: 1,
		error: 1,
		receive: 1,
		function: 2,
	});
	assert.deepEqual(
		merged.abi.filter(item => item.type === "function").map(item => item.name),
		["alpha", "beta"],
	);
	assert.equal(
		merged.abi.some(item => item.name === "unused"),
		false,
	);

	const incomplete = new Map(fetched);
	incomplete.set(FACET_A.toLowerCase(), {
		abi: [unused],
		source: { type: "explorer" },
	});
	assert.throws(() => mergeLiveFacetAbis(liveFacets, incomplete), /missing 1 installed selector/);
});
