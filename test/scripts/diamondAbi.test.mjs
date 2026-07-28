import { parseArguments } from "../../scripts/exportDiamondAbi.mjs";
import {
	extractAbiFromEtherscanApi,
	extractAbiFromEtherscanHtml,
	findMatchingArtifact,
	findSelectorMatchingArtifact,
	fetchVerifiedAbi,
	matchArtifactRuntime,
	mergeLiveFacetAbis,
	normalizeLiveFacets,
	parseDiamondAbiConfig,
	resolveChainProfile,
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

function baseConfig(diamonds = {}) {
	return {
		diamonds: {
			core: DIAMOND,
			"account-layer": "0x00000000000000000000000000000000000000a1",
			...diamonds,
		},
	};
}

test("validates a minimal multi-Diamond chain config", () => {
	const config = parseDiamondAbiConfig(baseConfig());
	assert.deepEqual(config.diamonds, [
		{ label: "core", address: DIAMOND },
		{ label: "account-layer", address: FACET_A },
	]);

	assert.throws(() => parseDiamondAbiConfig(baseConfig({ broken: "0x1234" })), /diamonds.broken is not a valid EVM address/);
	assert.throws(() => parseDiamondAbiConfig(baseConfig({ Core: FACET_B })), /diamond label "Core"/);
	assert.throws(() => parseDiamondAbiConfig({ ...baseConfig(), chainId: 999 }), /only "diamonds" belongs/);
	assert.throws(() => parseDiamondAbiConfig({ diamonds: { core: DIAMOND, duplicate: DIAMOND } }), /duplicates diamonds.core/);
});

test("derives public chain metadata and supports selecting one Diamond", () => {
	const profile = resolveChainProfile("HyperEVM");
	assert.equal(profile.name, "hyperevm");
	assert.equal(profile.expectedChainId, 999);
	assert.equal(profile.rpc.urlEnv, "RPC_HYPEREVM");
	assert.equal(profile.explorers.at(-1).browserUrl, "https://hyperevmscan.io");
	assert.throws(() => resolveChainProfile("unknown"), /unsupported chain/);

	assert.deepEqual(parseArguments(["--chain", "hyperevm", "--diamond", "account-layer"], {}), {
		help: false,
		chain: "hyperevm",
		configFile: "scripts/config/diamond-abi/hyperevm.json",
		diamondLabel: "account-layer",
		outputDirectory: undefined,
	});
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

test("does not retry non-retryable explorer responses", async () => {
	let requests = 0;
	await assert.rejects(
		fetchVerifiedAbi(
			FACET_A,
			{
				chainId: 999,
				explorers: [{ type: "etherscan-html", browserUrl: "https://explorer.example" }],
				request: { concurrency: 1, attempts: 3, timeoutMs: 1_000 },
			},
			{
				targetRuntimeCode: "0x6000",
				fetchImpl: async () => {
					requests += 1;
					return {
						ok: false,
						status: 403,
						text: async () => "forbidden",
					};
				},
			},
		),
		/HTTP 403/,
	);
	assert.equal(requests, 1);
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
