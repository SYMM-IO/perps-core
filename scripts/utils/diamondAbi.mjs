import { ErrorFragment, EventFragment, Fragment, FunctionFragment, getAddress, id, isAddress } from "ethers";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SELECTOR_PATTERN = /^0x[0-9a-fA-F]{8}$/;

function requireObject(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value;
}

function requireString(value, label) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value.trim();
}

function requirePositiveInteger(value, label) {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value;
}

function normalizeUrl(value, label) {
	const raw = requireString(value, label);
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`${label} is not a valid URL`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`${label} must use http or https`);
	}
	return url.toString().replace(/\/$/, "");
}

function normalizeExplorer(source, index) {
	const value = requireObject(source, `explorers[${index}]`);
	const type = requireString(value.type, `explorers[${index}].type`);

	if (type === "etherscan-v2") {
		return {
			type,
			apiUrl: normalizeUrl(value.apiUrl, `explorers[${index}].apiUrl`),
			apiKeyEnv: requireString(value.apiKeyEnv, `explorers[${index}].apiKeyEnv`),
		};
	}

	if (type === "etherscan-html") {
		const runtimeMatchValue =
			value.runtimeMatch === undefined ? undefined : requireObject(value.runtimeMatch, `explorers[${index}].runtimeMatch`);
		const runtimeMatchRpc =
			runtimeMatchValue === undefined ? undefined : requireObject(runtimeMatchValue.rpc, `explorers[${index}].runtimeMatch.rpc`);
		return {
			type,
			browserUrl: normalizeUrl(value.browserUrl, `explorers[${index}].browserUrl`),
			runtimeMatch:
				runtimeMatchValue === undefined
					? undefined
					: {
							chainId: requirePositiveInteger(runtimeMatchValue.chainId, `explorers[${index}].runtimeMatch.chainId`),
							rpc: {
								url: normalizeUrl(runtimeMatchRpc.url, `explorers[${index}].runtimeMatch.rpc.url`),
								urlEnv:
									runtimeMatchRpc.urlEnv === undefined
										? undefined
										: requireString(runtimeMatchRpc.urlEnv, `explorers[${index}].runtimeMatch.rpc.urlEnv`),
							},
						},
		};
	}

	throw new Error(`explorers[${index}].type is unsupported: ${type}`);
}

function normalizeAbiSnapshot(snapshot, index) {
	const value = requireObject(snapshot, `abiSnapshots[${index}]`);
	const type = requireString(value.type, `abiSnapshots[${index}].type`);
	const label = value.label === undefined ? `${type}:${index}` : requireString(value.label, `abiSnapshots[${index}].label`);

	if (type === "file") {
		return {
			type,
			label,
			path: requireString(value.path, `abiSnapshots[${index}].path`),
		};
	}
	if (type === "git") {
		return {
			type,
			label,
			ref: requireString(value.ref, `abiSnapshots[${index}].ref`),
			path: requireString(value.path, `abiSnapshots[${index}].path`),
		};
	}
	throw new Error(`abiSnapshots[${index}].type is unsupported: ${type}`);
}

export function parseDiamondAbiConfig(raw) {
	const value = requireObject(raw, "config");
	const name = requireString(value.name, "name");
	const chainId = requirePositiveInteger(value.chainId, "chainId");
	const diamondAddress = requireString(value.diamondAddress, "diamondAddress");

	if (!ADDRESS_PATTERN.test(diamondAddress) || !isAddress(diamondAddress)) {
		throw new Error(`diamondAddress is not a valid EVM address: ${diamondAddress}`);
	}

	const rpc = requireObject(value.rpc, "rpc");
	const rpcUrl = normalizeUrl(rpc.url, "rpc.url");
	const rpcUrlEnv = rpc.urlEnv === undefined ? undefined : requireString(rpc.urlEnv, "rpc.urlEnv");

	if (!Array.isArray(value.explorers) || value.explorers.length === 0) {
		throw new Error("explorers must contain at least one ABI source");
	}

	const request = value.request === undefined ? {} : requireObject(value.request, "request");
	const concurrency = request.concurrency === undefined ? 4 : requirePositiveInteger(request.concurrency, "request.concurrency");
	const attempts = request.attempts === undefined ? 3 : requirePositiveInteger(request.attempts, "request.attempts");
	const timeoutMs = request.timeoutMs === undefined ? 30_000 : requirePositiveInteger(request.timeoutMs, "request.timeoutMs");
	const localArtifacts =
		value.localArtifacts === undefined
			? undefined
			: {
					directory: requireString(requireObject(value.localArtifacts, "localArtifacts").directory, "localArtifacts.directory"),
					allowSelectorOnlyFallback: requireObject(value.localArtifacts, "localArtifacts").allowSelectorOnlyFallback === true,
				};

	return {
		schemaVersion: value.schemaVersion === undefined ? 1 : requirePositiveInteger(value.schemaVersion, "schemaVersion"),
		name,
		chainId,
		diamondAddress: getAddress(diamondAddress),
		rpc: {
			url: rpcUrl,
			urlEnv: rpcUrlEnv,
		},
		explorers: value.explorers.map(normalizeExplorer),
		request: {
			concurrency,
			attempts,
			timeoutMs,
		},
		localArtifacts,
		abiSnapshots: Array.isArray(value.abiSnapshots) ? value.abiSnapshots.map(normalizeAbiSnapshot) : [],
		outputDirectory: requireString(value.outputDirectory, "outputDirectory"),
	};
}

export function resolveRpcUrl(config, environment = process.env) {
	const envName = config.rpc.urlEnv;
	const envValue = envName ? environment[envName]?.trim() : undefined;
	return {
		url: envValue || config.rpc.url,
		source: envValue ? `env:${envName}` : "config",
	};
}

export function normalizeSelector(value, label = "selector") {
	if (typeof value !== "string" || !SELECTOR_PATTERN.test(value)) {
		throw new Error(`${label} is not a bytes4 selector: ${String(value)}`);
	}
	return value.toLowerCase();
}

export function normalizeLiveFacets(rawFacets) {
	if (!Array.isArray(rawFacets)) throw new Error("facets() did not return an array");

	const seenAddresses = new Set();
	const seenSelectors = new Map();

	return rawFacets.map((rawFacet, facetIndex) => {
		const rawAddress = rawFacet?.facetAddress ?? rawFacet?.address ?? rawFacet?.[0];
		const rawSelectors = rawFacet?.functionSelectors ?? rawFacet?.[1];
		if (typeof rawAddress !== "string" || !isAddress(rawAddress)) {
			throw new Error(`facets()[${facetIndex}] has an invalid facet address`);
		}
		if (!Array.isArray(rawSelectors) && typeof rawSelectors?.[Symbol.iterator] !== "function") {
			throw new Error(`facets()[${facetIndex}] has invalid function selectors`);
		}

		const address = getAddress(rawAddress);
		const addressKey = address.toLowerCase();
		if (seenAddresses.has(addressKey)) {
			throw new Error(`facets() returned duplicate facet address ${address}`);
		}
		seenAddresses.add(addressKey);

		const functionSelectors = Array.from(rawSelectors, (selector, selectorIndex) =>
			normalizeSelector(selector, `facets()[${facetIndex}].functionSelectors[${selectorIndex}]`),
		);
		if (functionSelectors.length === 0) {
			throw new Error(`facets()[${facetIndex}] returned no selectors for ${address}`);
		}

		for (const selector of functionSelectors) {
			const previous = seenSelectors.get(selector);
			if (previous) {
				throw new Error(`selector ${selector} is assigned to both ${previous} and ${address}`);
			}
			seenSelectors.set(selector, address);
		}

		return { address, functionSelectors };
	});
}

function decodeHtmlEntities(value) {
	return value
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&#x27;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}

function validateAbi(value, label) {
	if (!Array.isArray(value)) throw new Error(`${label} did not return an ABI array`);
	for (let index = 0; index < value.length; index++) {
		try {
			Fragment.from(value[index]);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`${label} returned an invalid ABI item at index ${index}: ${message}`);
		}
	}
	return value;
}

export function extractAbiFromEtherscanHtml(html) {
	if (typeof html !== "string") throw new Error("explorer HTML response must be a string");
	const match = html.match(/<pre[^>]*\bid=(?:'|")js-copytextarea2(?:'|")[^>]*>([\s\S]*?)<\/pre>/i);
	if (!match) {
		throw new Error("verified Contract ABI section was not found");
	}

	let parsed;
	try {
		parsed = JSON.parse(decodeHtmlEntities(match[1].trim()));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`verified Contract ABI is not valid JSON: ${message}`);
	}
	return validateAbi(parsed, "explorer HTML");
}

export function extractAbiFromEtherscanApi(payload) {
	const value = requireObject(payload, "explorer API response");
	if (String(value.status) !== "1") {
		throw new Error(typeof value.result === "string" ? value.result : `explorer API returned status ${String(value.status)}`);
	}

	let parsed;
	try {
		parsed = typeof value.result === "string" ? JSON.parse(value.result) : value.result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`explorer API ABI is not valid JSON: ${message}`);
	}
	return validateAbi(parsed, "explorer API");
}

function retryableStatus(status) {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

function wait(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchTextWithRetry(url, options, request, fetchImpl) {
	let lastError;
	for (let attempt = 1; attempt <= request.attempts; attempt++) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
		try {
			const response = await fetchImpl(url, {
				...options,
				signal: controller.signal,
			});
			const body = await response.text();
			if (response.ok) return body;
			const error = new Error(`HTTP ${response.status}`);
			if (!retryableStatus(response.status)) throw error;
			lastError = error;
		} catch (error) {
			lastError = error;
		} finally {
			clearTimeout(timeout);
		}

		if (attempt < request.attempts) {
			await wait(Math.min(500 * 2 ** (attempt - 1), 4_000));
		}
	}

	const message = lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(`request failed after ${request.attempts} attempt(s): ${message}`);
}

async function fetchFromEtherscanV2(address, chainId, source, request, environment, fetchImpl) {
	const apiKey = environment[source.apiKeyEnv]?.trim();
	if (!apiKey) {
		throw new Error(`API key environment variable ${source.apiKeyEnv} is not set`);
	}

	const url = new URL(source.apiUrl);
	url.searchParams.set("chainid", String(chainId));
	url.searchParams.set("module", "contract");
	url.searchParams.set("action", "getabi");
	url.searchParams.set("address", address);
	url.searchParams.set("apikey", apiKey);

	const body = await fetchTextWithRetry(
		url,
		{
			headers: {
				accept: "application/json",
			},
		},
		request,
		fetchImpl,
	);

	let payload;
	try {
		payload = JSON.parse(body);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`explorer API response is not valid JSON: ${message}`);
	}
	return {
		abi: extractAbiFromEtherscanApi(payload),
		source: {
			type: source.type,
			url: source.apiUrl,
		},
	};
}

async function rpcRequest(url, method, params, request, fetchImpl) {
	const body = await fetchTextWithRetry(
		url,
		{
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method,
				params,
			}),
		},
		request,
		fetchImpl,
	);
	let payload;
	try {
		payload = JSON.parse(body);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${method} response is not valid JSON: ${message}`);
	}
	if (payload.error) throw new Error(`${method} failed: ${payload.error.message ?? JSON.stringify(payload.error)}`);
	return payload.result;
}

async function verifyCrossChainRuntime(address, targetRuntimeCode, source, request, environment, fetchImpl) {
	if (typeof targetRuntimeCode !== "string" || !/^0x[0-9a-fA-F]+$/.test(targetRuntimeCode)) {
		throw new Error("target runtime bytecode is required for cross-chain ABI verification");
	}

	const envName = source.runtimeMatch.rpc.urlEnv;
	const envValue = envName ? environment[envName]?.trim() : undefined;
	const rpcUrl = envValue || source.runtimeMatch.rpc.url;
	const remoteChainId = await rpcRequest(rpcUrl, "eth_chainId", [], request, fetchImpl);
	if (BigInt(remoteChainId) !== BigInt(source.runtimeMatch.chainId)) {
		throw new Error(`cross-chain RPC returned chain ID ${BigInt(remoteChainId)}, expected ${source.runtimeMatch.chainId}`);
	}
	const remoteRuntimeCode = await rpcRequest(rpcUrl, "eth_getCode", [address, "latest"], request, fetchImpl);
	if (typeof remoteRuntimeCode !== "string" || remoteRuntimeCode.toLowerCase() !== targetRuntimeCode.toLowerCase()) {
		throw new Error(`runtime bytecode at ${address} does not match chain ${source.runtimeMatch.chainId}`);
	}
	return {
		chainId: source.runtimeMatch.chainId,
		rpcSource: envValue ? `env:${envName}` : "config",
	};
}

async function fetchFromEtherscanHtml(address, source, request, environment, targetRuntimeCode, fetchImpl) {
	const url = new URL(`/address/${address}`, `${source.browserUrl}/`);
	const body = await fetchTextWithRetry(
		url,
		{
			headers: {
				accept: "text/html",
				"user-agent": "symmio-diamond-abi-exporter/1.0",
			},
		},
		request,
		fetchImpl,
	);
	const runtimeBytecodeMatch = source.runtimeMatch
		? await verifyCrossChainRuntime(address, targetRuntimeCode, source, request, environment, fetchImpl)
		: undefined;
	return {
		abi: extractAbiFromEtherscanHtml(body),
		source: {
			type: source.type,
			url: `${url.toString()}#code`,
			...(runtimeBytecodeMatch ? { runtimeBytecodeMatch } : {}),
		},
	};
}

export async function fetchVerifiedAbi(address, config, options = {}) {
	const environment = options.environment ?? process.env;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	if (typeof fetchImpl !== "function") throw new Error("global fetch is unavailable; Node.js 18 or newer is required");

	const failures = [];
	for (const source of config.explorers) {
		try {
			if (source.type === "etherscan-v2") {
				return await fetchFromEtherscanV2(address, config.chainId, source, config.request, environment, fetchImpl);
			}
			if (source.type === "etherscan-html") {
				return await fetchFromEtherscanHtml(address, source, config.request, environment, options.targetRuntimeCode, fetchImpl);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failures.push(`${source.type}: ${message}`);
		}
	}

	throw new Error(`no verified ABI source succeeded for ${address}: ${failures.join("; ")}`);
}

export function matchArtifactRuntime(deployedCode, compiledCode) {
	if (typeof deployedCode !== "string" || !/^0x[0-9a-fA-F]+$/.test(deployedCode)) {
		throw new Error("deployed runtime bytecode is invalid");
	}
	if (typeof compiledCode !== "string" || !/^0x(?:[0-9a-fA-F]|__\$[0-9a-fA-F]{34}\$__)+$/.test(compiledCode)) {
		throw new Error("compiled runtime bytecode is invalid");
	}

	const deployed = deployedCode.slice(2).toLowerCase();
	let linked = compiledCode.slice(2).toLowerCase();
	if (linked.length !== deployed.length) return { match: false, linkedLibraries: {} };

	const linkedLibraries = {};
	const placeholders = [...linked.matchAll(/__\$([0-9a-f]{34})\$__/g)];
	for (const placeholder of placeholders) {
		const hash = placeholder[1];
		const address = `0x${deployed.slice(placeholder.index, placeholder.index + 40)}`;
		const previous = linkedLibraries[hash];
		if (previous && previous.toLowerCase() !== address.toLowerCase()) {
			return { match: false, linkedLibraries: {} };
		}
		linkedLibraries[hash] = getAddress(address);
	}
	for (const [hash, address] of Object.entries(linkedLibraries)) {
		linked = linked.replaceAll(`__$${hash}$__`, address.slice(2).toLowerCase());
	}

	return {
		match: linked === deployed,
		linkedLibraries,
	};
}

function abiFunctionSelectors(abi) {
	const selectors = new Set();
	for (const item of abi) {
		if (item?.type !== "function") continue;
		try {
			selectors.add(FunctionFragment.from(item).selector.toLowerCase());
		} catch {
			// Some historical compiler outputs contain invalid enum type strings.
			// They cannot match a valid bytes4 selector and are ignored as candidates.
		}
	}
	return selectors;
}

function artifactScore(artifact) {
	let score = 0;
	if (/Facet$/.test(artifact.contractName)) score += 10;
	if (!/Impl$/.test(artifact.contractName)) score += 5;
	if (artifact.sourceName.includes("/core/facets/")) score += 3;
	score += Math.min(artifact.abi.length / 1_000, 1);
	return score;
}

export function findMatchingArtifact(deployedCode, installedSelectors, artifacts) {
	const selectors = installedSelectors.map((selector, index) => normalizeSelector(selector, `installedSelectors[${index}]`));
	const matches = [];

	for (const artifact of artifacts) {
		const runtimeMatch = matchArtifactRuntime(deployedCode, artifact.deployedBytecode);
		if (!runtimeMatch.match) continue;
		const artifactSelectors = abiFunctionSelectors(artifact.abi);
		if (!selectors.every(selector => artifactSelectors.has(selector))) continue;
		matches.push({
			...artifact,
			linkedLibraries: runtimeMatch.linkedLibraries,
		});
	}

	if (matches.length === 0) return undefined;
	matches.sort((left, right) => artifactScore(right) - artifactScore(left) || left.file.localeCompare(right.file));
	return matches[0];
}

export function findSelectorMatchingArtifact(installedSelectors, artifacts) {
	const selectors = installedSelectors.map((selector, index) => normalizeSelector(selector, `installedSelectors[${index}]`));
	const matches = [];

	for (const artifact of artifacts) {
		const artifactSelectors = abiFunctionSelectors(artifact.abi);
		if (!selectors.every(selector => artifactSelectors.has(selector))) continue;
		matches.push({
			...artifact,
			extraSelectorCount: artifactSelectors.size - selectors.length,
		});
	}

	if (matches.length === 0) return undefined;
	matches.sort(
		(left, right) =>
			left.extraSelectorCount - right.extraSelectorCount || artifactScore(right) - artifactScore(left) || left.file.localeCompare(right.file),
	);
	return matches[0];
}

export function resolveFunctionsFromAbiSnapshots(installedSelectors, snapshots) {
	const selectors = installedSelectors.map((selector, index) => normalizeSelector(selector, `installedSelectors[${index}]`));
	const resolved = [];
	const usedSnapshots = new Map();

	for (const selector of selectors) {
		let match;
		for (const snapshot of snapshots) {
			for (const item of snapshot.abi) {
				if (item?.type !== "function") continue;
				let fragment;
				try {
					fragment = FunctionFragment.from(item);
				} catch {
					continue;
				}
				if (fragment.selector.toLowerCase() !== selector) continue;
				match = {
					abi: item,
					selector,
					signature: fragment.format("sighash"),
					snapshot,
				};
				break;
			}
			if (match) break;
		}
		if (!match) return undefined;
		resolved.push(match);
		usedSnapshots.set(match.snapshot.label, {
			type: match.snapshot.type,
			label: match.snapshot.label,
			...(match.snapshot.path ? { path: match.snapshot.path } : {}),
			...(match.snapshot.ref ? { ref: match.snapshot.ref } : {}),
		});
	}

	return {
		abi: resolved.map(match => match.abi),
		functions: resolved.map(({ selector, signature, snapshot }) => ({
			selector,
			signature,
			snapshot: snapshot.label,
		})),
		snapshots: [...usedSnapshots.values()],
	};
}

function functionDetails(abi, installedSelectors, address) {
	const installed = new Set(installedSelectors);
	const bySelector = new Map();

	for (const item of abi) {
		if (item?.type !== "function") continue;
		const fragment = FunctionFragment.from(item);
		const selector = fragment.selector.toLowerCase();
		if (!installed.has(selector)) continue;

		const previous = bySelector.get(selector);
		if (previous && previous.signature !== fragment.format("sighash")) {
			throw new Error(`verified ABI for ${address} maps selector ${selector} to both ${previous.signature} and ${fragment.format("sighash")}`);
		}
		bySelector.set(selector, {
			selector,
			signature: fragment.format("sighash"),
			abi: item,
		});
	}

	const missing = installedSelectors.filter(selector => !bySelector.has(selector));
	if (missing.length > 0) {
		throw new Error(`verified ABI for ${address} is missing ${missing.length} installed selector(s): ${missing.join(", ")}`);
	}

	return installedSelectors.map(selector => bySelector.get(selector));
}

function nonFunctionKey(item) {
	if (item.type === "event") {
		const fragment = EventFragment.from(item);
		return `event:${id(fragment.format("sighash"))}:${fragment.inputs.map(input => (input.indexed ? "1" : "0")).join("")}`;
	}
	if (item.type === "error") {
		const fragment = ErrorFragment.from(item);
		return `error:${fragment.selector.toLowerCase()}`;
	}
	return `${item.type}:${Fragment.from(item).format("json")}`;
}

export function mergeLiveFacetAbis(liveFacets, fetchedByAddress, diamondAbi = []) {
	const facets = normalizeLiveFacets(liveFacets);
	const functionEntries = [];
	const nonFunctionEntries = new Map();
	const facetManifest = [];

	for (const facet of facets) {
		const fetched = fetchedByAddress.get(facet.address.toLowerCase());
		if (!fetched) throw new Error(`no verified ABI was fetched for live facet ${facet.address}`);
		const functions = functionDetails(fetched.abi, facet.functionSelectors, facet.address);
		functionEntries.push(...functions.map(item => item.abi));

		for (const item of fetched.abi) {
			if (item.type !== "event" && item.type !== "error") continue;
			const key = nonFunctionKey(item);
			if (!nonFunctionEntries.has(key)) nonFunctionEntries.set(key, item);
		}

		facetManifest.push({
			address: facet.address,
			abiSource: fetched.source,
			fetchedAbiEntries: fetched.abi.length,
			functions: functions.map(({ selector, signature }) => ({ selector, signature })),
		});
	}

	const diamondEdgeEntries = [];
	for (const item of diamondAbi) {
		if (item.type === "fallback" || item.type === "receive") {
			const key = nonFunctionKey(item);
			if (!nonFunctionEntries.has(key)) {
				nonFunctionEntries.set(key, item);
				diamondEdgeEntries.push(item);
			}
		}
	}

	const abi = [...nonFunctionEntries.values(), ...functionEntries];
	const counts = abi.reduce((result, item) => {
		result[item.type] = (result[item.type] ?? 0) + 1;
		return result;
	}, {});
	const selectorCount = facets.reduce((total, facet) => total + facet.functionSelectors.length, 0);
	if (counts.function !== selectorCount) {
		throw new Error(`merged ABI function count ${counts.function ?? 0} does not match live selector count ${selectorCount}`);
	}

	return {
		abi,
		facets: facetManifest,
		counts,
		selectorCount,
		diamondEdgeEntryCount: diamondEdgeEntries.length,
	};
}

export async function mapWithConcurrency(values, concurrency, worker, onComplete = () => {}) {
	const results = new Array(values.length);
	let nextIndex = 0;

	async function run() {
		while (true) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= values.length) return;
			results[index] = await worker(values[index], index);
			onComplete(values[index], index, results[index]);
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => run()));
	return results;
}
