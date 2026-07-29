import {
	assertCompleteTargetResults,
	countAbiEntries,
	exportContractAbi,
	exportDiamondAbi,
	parseArguments,
} from "../../scripts/exportDiamondAbi.mjs";
import {
	analyzeSelectorsAgainstAbiSources,
	extractDispatcherSelectors,
	extractAbiFromEtherscanApi,
	extractAbiFromEtherscanHtml,
	findMatchingArtifact,
	findSelectorMatchingAbiSnapshot,
	findSelectorMatchingArtifact,
	fetchVerifiedAbi,
	matchArtifactRuntime,
	mergeLiveFacetAbis,
	normalizeLiveFacets,
	parseAbiTargetConfig,
	parseDiamondAbiConfig,
	resolveChainProfile,
	resolveFunctionsFromAbiSnapshots,
} from "../../scripts/utils/diamondAbi.mjs";
import { FunctionFragment } from "ethers";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

function baseConfig(targets = {}) {
	return {
		targets: {
			core: DIAMOND,
			"account-layer": "0x00000000000000000000000000000000000000a1",
			...targets,
		},
	};
}

function mockProvider(code = "0x6000") {
	return {
		getNetwork: async () => ({ chainId: 999n }),
		getBlockNumber: async () => 123,
		getCode: async () => code,
	};
}

function exportConfig(outputDirectory, overrides = {}) {
	return {
		name: "test",
		expectedChainId: 999,
		targetLabel: "target",
		targetAddress: DIAMOND,
		outputDirectory,
		explorers: [],
		request: { concurrency: 2, attempts: 1, timeoutMs: 100 },
		...overrides,
	};
}

test("validates a minimal multi-target chain config", () => {
	const config = parseAbiTargetConfig(baseConfig());
	assert.deepEqual(config.targets, [
		{ label: "core", address: DIAMOND },
		{ label: "account-layer", address: FACET_A },
	]);
	assert.deepEqual(parseDiamondAbiConfig(baseConfig()), config);

	assert.throws(() => parseAbiTargetConfig(baseConfig({ broken: "0x1234" })), /targets.broken is not a valid EVM address/);
	assert.throws(() => parseAbiTargetConfig(baseConfig({ Core: FACET_B })), /target label "Core"/);
	assert.throws(() => parseAbiTargetConfig({ ...baseConfig(), chainId: 999 }), /only "targets" belongs/);
	assert.throws(() => parseAbiTargetConfig({ targets: { core: DIAMOND, duplicate: DIAMOND } }), /duplicates targets.core/);
});

test("derives public chain metadata and supports selecting one target", () => {
	const profile = resolveChainProfile("HyperEVM");
	assert.equal(profile.name, "hyperevm");
	assert.equal(profile.expectedChainId, 999);
	assert.equal(profile.rpc.urlEnv, "RPC_HYPEREVM");
	assert.equal(profile.explorers.at(-1).browserUrl, "https://hyperevmscan.io");
	assert.throws(() => resolveChainProfile("unknown"), /unsupported chain/);

	assert.deepEqual(parseArguments(["--chain", "hyperevm", "--target", "account-layer"], {}), {
		help: false,
		chain: "hyperevm",
		configFile: "scripts/config/diamond-abi/hyperevm.json",
		targetLabel: "account-layer",
		outputDirectory: undefined,
	});
	assert.equal(parseArguments(["--chain", "hyperevm", "--diamond", "core"], {}).targetLabel, "core");
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

test("matches constructor-set immutable runtime regions", () => {
	const compiled = `0x60${"00".repeat(32)}61`;
	const deployed = `0x60${"ab".repeat(32)}61`;
	const immutableReferences = {
		1: [{ start: 1, length: 32 }],
	};
	assert.equal(matchArtifactRuntime(deployed, compiled).match, false);
	assert.deepEqual(matchArtifactRuntime(deployed, compiled, immutableReferences), {
		match: true,
		linkedLibraries: {},
		immutableReferenceCount: 1,
	});
});

test("extracts dispatcher selectors and chooses the narrowest covering ABI snapshot", () => {
	const runtimeCode = `0x63${alphaSelector.slice(2)}14600063${betaSelector.slice(2)}14`;
	assert.deepEqual(extractDispatcherSelectors(runtimeCode), [alphaSelector, betaSelector]);

	const match = findSelectorMatchingAbiSnapshot(
		[alphaSelector, betaSelector],
		[
			{ type: "file", label: "wide", path: "wide.json", abi: [alpha, beta, unused, event] },
			{ type: "file", label: "exact", path: "exact.json", abi: [alpha, beta, event, error] },
		],
	);
	assert.equal(match.label, "exact");
	assert.equal(match.extraSelectorCount, 0);
	assert.deepEqual(match.abi, [alpha, beta, event, error]);
});

test("counts constructor ABI entries without inherited-property collisions", () => {
	assert.deepEqual(countAbiEntries([{ type: "constructor", inputs: [] }, alpha, event, error]), {
		constructor: 1,
		function: 1,
		event: 1,
		error: 1,
	});
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

test("reports matched, unmatched, and local-only ABI selectors", () => {
	const unknownSelector = "0x12345678";
	const analysis = analyzeSelectorsAgainstAbiSources(
		[alphaSelector, unknownSelector],
		[
			{
				type: "file",
				label: "working-tree:abis/example.json",
				path: "abis/example.json",
				abi: [alpha, unused],
			},
		],
	);

	assert.equal(analysis.status, "partial");
	assert.deepEqual(
		analysis.matched.map(({ selector, signature, outputsBytecodeProven }) => ({
			selector,
			signature,
			outputsBytecodeProven,
		})),
		[{ selector: alphaSelector, signature: "alpha(uint256)", outputsBytecodeProven: false }],
	);
	assert.deepEqual(analysis.unmatched, [{ selector: unknownSelector }]);
	assert.deepEqual(
		analysis.localOnly.map(({ selector, signatures }) => ({ selector, signatures })),
		[{ selector: FunctionFragment.from(unused).selector.toLowerCase(), signatures: ["unused()"] }],
	);
	assert.deepEqual(analysis.ambiguous, []);
});

test("reports selector collisions as ambiguous instead of choosing silently", () => {
	const burn = {
		type: "function",
		name: "burn",
		inputs: [{ name: "value", type: "uint256" }],
		outputs: [],
		stateMutability: "nonpayable",
	};
	const collate = {
		type: "function",
		name: "collate_propagate_storage",
		inputs: [{ name: "value", type: "bytes16" }],
		outputs: [],
		stateMutability: "nonpayable",
	};
	const collisionSelector = FunctionFragment.from(burn).selector.toLowerCase();
	assert.equal(collisionSelector, FunctionFragment.from(collate).selector.toLowerCase());

	const analysis = analyzeSelectorsAgainstAbiSources(
		[collisionSelector],
		[
			{ type: "file", label: "burn", abi: [burn] },
			{ type: "file", label: "collate", abi: [collate] },
		],
	);

	assert.equal(analysis.status, "ambiguous");
	assert.deepEqual(analysis.unmatched, []);
	assert.deepEqual(analysis.matched, []);
	assert.deepEqual(
		analysis.ambiguous[0].candidates.map(candidate => candidate.signature),
		["burn(uint256)", "collate_propagate_storage(bytes16)"],
	);
});

test("writes a complete report beside an exact-bytecode contract ABI", async t => {
	const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "diamond-abi-complete-"));
	t.after(() => fs.rm(outputDirectory, { recursive: true, force: true }));
	const artifact = {
		file: "artifacts/Alpha.json",
		contractName: "Alpha",
		sourceName: "contracts/Alpha.sol",
		abi: [alpha, event],
		deployedBytecode: "0x6000",
		immutableReferences: {},
	};

	const result = await exportContractAbi(exportConfig(outputDirectory), {
		provider: mockProvider(),
		rpc: { url: "http://rpc.example", source: "test" },
		blockNumber: 123,
		localArtifacts: [artifact],
		abiSnapshots: [],
	});
	const report = JSON.parse(await fs.readFile(result.reportFile, "utf8"));
	const manifest = JSON.parse(await fs.readFile(result.manifestFile, "utf8"));

	assert.equal(result.complete, true);
	assert.equal(report.status, "complete");
	assert.equal(report.selectorSource, "exact-artifact-bound-to-runtime-bytecode");
	assert.equal(report.selectorVerification.matched[0].signature, "alpha(uint256)");
	assert.equal(report.selectorVerification.matched[0].fullAbiArtifactProven, true);
	assert.equal(manifest.outputs.report, path.relative(process.cwd(), result.reportFile));
	await assert.rejects(fs.access(path.join(outputDirectory, "abi.partial.json")), error => error?.code === "ENOENT");
});

test("writes a partial contract report before returning incomplete resolution", async t => {
	const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "diamond-abi-partial-contract-"));
	t.after(() => fs.rm(outputDirectory, { recursive: true, force: true }));
	const unknownSelector = "0x12345678";
	const runtimeCode = `0x63${alphaSelector.slice(2)}14600063${unknownSelector.slice(2)}146000`;

	const result = await exportContractAbi(exportConfig(outputDirectory), {
		provider: mockProvider(runtimeCode),
		rpc: { url: "http://rpc.example", source: "test" },
		blockNumber: 123,
		localArtifacts: [],
		abiSnapshots: [{ type: "file", label: "alpha", path: "abis/alpha.json", abi: [alpha] }],
	});
	const report = JSON.parse(await fs.readFile(result.reportFile, "utf8"));
	const partialAbi = JSON.parse(await fs.readFile(result.partialAbiFile, "utf8"));

	assert.equal(result.complete, false);
	assert.equal(report.status, "incomplete");
	assert.equal(report.selectorVerification.status, "partial");
	assert.deepEqual(report.selectorVerification.unmatched, [{ selector: unknownSelector }]);
	assert.deepEqual(
		partialAbi.filter(item => item.type === "function").map(item => item.name),
		["alpha"],
	);
	await assert.rejects(fs.access(path.join(outputDirectory, "abi.json")), error => error?.code === "ENOENT");
	await assert.rejects(fs.access(path.join(outputDirectory, "manifest.json")), error => error?.code === "ENOENT");
});

test("writes facet addresses beside unmatched Diamond selectors", async t => {
	const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "diamond-abi-partial-diamond-"));
	t.after(() => fs.rm(outputDirectory, { recursive: true, force: true }));
	const unknownSelector = "0x12345678";
	const liveFacets = [{ address: FACET_A, functionSelectors: [alphaSelector, unknownSelector] }];

	const result = await exportDiamondAbi(
		exportConfig(outputDirectory, {
			diamondLabel: "diamond",
			diamondAddress: DIAMOND,
		}),
		{
			provider: mockProvider(),
			rpc: { url: "http://rpc.example", source: "test" },
			blockNumber: 123,
			liveFacets,
			localArtifacts: [],
			abiSnapshots: [{ type: "file", label: "alpha", path: "abis/alpha.json", abi: [alpha] }],
		},
	);
	const report = JSON.parse(await fs.readFile(result.reportFile, "utf8"));

	assert.equal(result.complete, false);
	assert.equal(report.selectorSource, "diamond-loupe");
	assert.equal(report.selectorVerification.matched[0].facetAddress, FACET_A);
	assert.deepEqual(report.selectorVerification.unmatched, [{ facetAddress: FACET_A, selector: unknownSelector }]);
	assert.deepEqual(report.facets[0].unmatchedSelectors, [unknownSelector]);
});

test("uses exit code 2 after incomplete target reports have been written", () => {
	assert.doesNotThrow(() => assertCompleteTargetResults([{ label: "core", result: { complete: true } }]));
	assert.throws(
		() =>
			assertCompleteTargetResults([
				{
					label: "instant-layer",
					result: { complete: false, reportFile: "/tmp/instant-layer/report.json" },
				},
			]),
		error => error?.exitCode === 2 && error.message.includes("instant-layer") && error.message.includes("/tmp/instant-layer/report.json"),
	);
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
