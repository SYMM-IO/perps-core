import { ErrorFragment, EventFragment, Fragment, FunctionFragment, getAddress, id, isAddress } from "ethers";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SELECTOR_PATTERN = /^0x[0-9a-fA-F]{8}$/;
const TARGET_LABEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_REQUEST = Object.freeze({
	concurrency: 4,
	attempts: 3,
	timeoutMs: 30_000,
});
const ETHERSCAN_V2 = Object.freeze({
	type: "etherscan-v2",
	apiUrl: "https://api.etherscan.io/v2/api",
	apiKeyEnv: "ETHERSCAN_APIKEY",
});
const PUBLIC_CHAIN_PROFILES = Object.freeze({
	arbitrum: {
		chainId: 42161,
		rpcUrl: "https://arbitrum.llamarpc.com",
		rpcUrlEnv: "RPC_ARBITRUM",
		explorerUrl: "https://arbiscan.io",
	},
	base: {
		chainId: 8453,
		rpcUrl: "https://mainnet.base.org",
		rpcUrlEnv: "RPC_BASE",
		explorerUrl: "https://basescan.org",
	},
	blast: {
		chainId: 81457,
		rpcUrl: "https://rpc.blast.io",
		rpcUrlEnv: "RPC_BLAST",
		explorerUrl: "https://blastscan.io",
	},
	bsc: {
		chainId: 56,
		rpcUrl: "https://binance.llamarpc.com",
		rpcUrlEnv: "RPC_BSC",
		explorerUrl: "https://bscscan.com",
	},
	hyperevm: {
		chainId: 999,
		rpcUrl: "https://rpc.hyperliquid.xyz/evm",
		rpcUrlEnv: "RPC_HYPEREVM",
		explorerUrl: "https://hyperevmscan.io",
	},
	iota: {
		chainId: 8822,
		rpcUrl: "https://json-rpc.evm.iotaledger.net",
		rpcUrlEnv: "RPC_IOTA",
		explorerUrl: "https://explorer.evm.iota.org",
	},
	mantle: {
		chainId: 5000,
		rpcUrl: "https://mantle.drpc.org",
		rpcUrlEnv: "RPC_MANTLE",
		explorerUrl: "https://mantlescan.xyz",
	},
	mantle2: {
		chainId: 5000,
		rpcUrl: "https://mantle.drpc.org",
		rpcUrlEnv: "RPC_MANTLE2",
		explorerUrl: "https://mantlescan.xyz",
	},
	mode: {
		chainId: 34443,
		rpcUrl: "https://mainnet.mode.network",
		rpcUrlEnv: "RPC_MODE",
		explorerUrl: "https://modescan.io",
	},
	polygon: {
		chainId: 137,
		rpcUrl: "https://polygon-rpc.com",
		rpcUrlEnv: "RPC_POLYGON",
		explorerUrl: "https://polygonscan.com",
	},
	sei: {
		chainId: 1329,
		rpcUrl: "https://evm-rpc.sei-apis.com",
		rpcUrlEnv: "RPC_SEI",
		explorerUrl: "https://seitrace.com",
	},
});

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

export function parseAbiTargetConfig(raw) {
	const value = requireObject(raw, "config");
	const rawTargets = requireObject(value.targets, "targets");
	const entries = Object.entries(rawTargets);
	if (entries.length === 0) throw new Error("targets must contain at least one named address");

	const seenAddresses = new Map();
	const targets = entries.map(([rawLabel, rawAddress]) => {
		const label = requireString(rawLabel, "target label");
		if (!TARGET_LABEL_PATTERN.test(label)) {
			throw new Error(`target label "${label}" must use lowercase letters, digits, and single hyphens`);
		}
		const address = requireString(rawAddress, `targets.${label}`);
		if (!ADDRESS_PATTERN.test(address) || !isAddress(address)) {
			throw new Error(`targets.${label} is not a valid EVM address: ${address}`);
		}
		const checksummedAddress = getAddress(address);
		const previous = seenAddresses.get(checksummedAddress.toLowerCase());
		if (previous) {
			throw new Error(`targets.${label} duplicates targets.${previous} at ${checksummedAddress}`);
		}
		seenAddresses.set(checksummedAddress.toLowerCase(), label);
		return { label, address: checksummedAddress };
	});

	const extraKeys = Object.keys(value).filter(key => key !== "targets");
	if (extraKeys.length > 0) {
		throw new Error(`unsupported chain config field(s): ${extraKeys.join(", ")}; only "targets" belongs in this file`);
	}

	return { targets };
}

export const parseDiamondAbiConfig = parseAbiTargetConfig;

export function resolveChainProfile(chain) {
	const key = requireString(chain, "chain").toLowerCase();
	const raw = PUBLIC_CHAIN_PROFILES[key];
	if (!raw) {
		throw new Error(
			`unsupported chain "${key}"; add its public RPC and explorer metadata to PUBLIC_CHAIN_PROFILES, not to the Diamond address config`,
		);
	}
	return {
		name: key,
		expectedChainId: raw.chainId,
		rpc: {
			url: normalizeUrl(raw.rpcUrl, `${key}.rpcUrl`),
			urlEnv: raw.rpcUrlEnv,
		},
		explorers: [normalizeExplorer(ETHERSCAN_V2, 0), normalizeExplorer({ type: "etherscan-html", browserUrl: raw.explorerUrl }, 1)],
		request: { ...DEFAULT_REQUEST },
	};
}

export function resolveRpcUrl(profile, environment = process.env) {
	const envName = profile.rpc.urlEnv;
	const envValue = envName ? environment[envName]?.trim() : undefined;
	return {
		url: envValue || profile.rpc.url,
		source: envValue ? `env:${envName}` : "public-profile",
	};
}

export function normalizeSelector(value, label = "selector") {
	if (typeof value !== "string" || !SELECTOR_PATTERN.test(value)) {
		throw new Error(`${label} is not a bytes4 selector: ${String(value)}`);
	}
	return value.toLowerCase();
}

export function extractDispatcherSelectors(runtimeCode) {
	if (typeof runtimeCode !== "string" || !/^0x[0-9a-fA-F]+$/.test(runtimeCode) || runtimeCode.length % 2 !== 0) {
		throw new Error("runtime bytecode is invalid");
	}
	const code = runtimeCode.slice(2);
	const selectors = [];
	const seen = new Set();

	for (let byteOffset = 0; byteOffset < code.length / 2; ) {
		const opcode = Number.parseInt(code.slice(byteOffset * 2, byteOffset * 2 + 2), 16);
		const pushWidth = opcode >= 0x60 && opcode <= 0x7f ? opcode - 0x5f : 0;
		if (opcode === 0x63) {
			const selector = `0x${code.slice((byteOffset + 1) * 2, (byteOffset + 5) * 2)}`.toLowerCase();
			const nextOpcode = Number.parseInt(code.slice((byteOffset + 5) * 2, (byteOffset + 6) * 2), 16);
			if (nextOpcode === 0x14 && !seen.has(selector)) {
				seen.add(selector);
				selectors.push(selector);
			}
		}
		byteOffset += pushWidth + 1;
	}

	return selectors;
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
			error.retryable = retryableStatus(response.status);
			if (!error.retryable) throw error;
			lastError = error;
		} catch (error) {
			if (error?.retryable === false) throw error;
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

export function matchArtifactRuntime(deployedCode, compiledCode, immutableReferences = {}) {
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

	let comparableDeployed = deployed;
	let comparableCompiled = linked;
	let immutableReferenceCount = 0;
	for (const references of Object.values(immutableReferences ?? {})) {
		if (!Array.isArray(references)) throw new Error("artifact immutableReferences is invalid");
		for (const reference of references) {
			const start = reference?.start;
			const length = reference?.length;
			if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length <= 0) {
				throw new Error("artifact immutableReferences contains an invalid range");
			}
			const startIndex = start * 2;
			const endIndex = (start + length) * 2;
			if (endIndex > comparableDeployed.length) return { match: false, linkedLibraries: {}, immutableReferenceCount: 0 };
			const mask = "0".repeat(endIndex - startIndex);
			comparableDeployed = `${comparableDeployed.slice(0, startIndex)}${mask}${comparableDeployed.slice(endIndex)}`;
			comparableCompiled = `${comparableCompiled.slice(0, startIndex)}${mask}${comparableCompiled.slice(endIndex)}`;
			immutableReferenceCount += 1;
		}
	}

	return {
		match: comparableCompiled === comparableDeployed,
		linkedLibraries,
		immutableReferenceCount,
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

function abiSourceSummary(source) {
	return {
		type: source.type,
		label: source.label,
		...(source.path ? { path: source.path } : {}),
		...(source.ref ? { ref: source.ref } : {}),
		...(source.file ? { file: source.file } : {}),
		...(source.contractName ? { contractName: source.contractName } : {}),
		...(source.sourceName ? { sourceName: source.sourceName } : {}),
	};
}

function abiVariantKey(item) {
	return Fragment.from(item).format("json");
}

export function analyzeSelectorsAgainstAbiSources(installedSelectors, sources, options = {}) {
	const selectors = installedSelectors.map((selector, index) => normalizeSelector(selector, `installedSelectors[${index}]`));
	const uniqueSelectors = [...new Set(selectors)];
	if (uniqueSelectors.length !== selectors.length) throw new Error("installedSelectors contains duplicates");
	const installed = new Set(uniqueSelectors);
	const candidatesBySelector = new Map(uniqueSelectors.map(selector => [selector, []]));
	const localOnlyBySelector = new Map();
	const invalidAbiEntries = [];

	for (const [sourceIndex, source] of sources.entries()) {
		if (!Array.isArray(source?.abi)) throw new Error(`sources[${sourceIndex}].abi must be an ABI array`);
		const summary = abiSourceSummary(source);
		for (const [abiIndex, item] of source.abi.entries()) {
			if (item?.type !== "function") continue;
			let fragment;
			try {
				fragment = FunctionFragment.from(item);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				invalidAbiEntries.push({
					source: summary,
					abiIndex,
					error: message,
				});
				continue;
			}
			const candidate = {
				selector: fragment.selector.toLowerCase(),
				signature: fragment.format("sighash"),
				abi: item,
				abiVariant: abiVariantKey(item),
				source: summary,
			};
			if (!installed.has(candidate.selector) && options.includeLocalOnly === false) continue;
			const bucket = installed.has(candidate.selector) ? candidatesBySelector : localOnlyBySelector;
			const existing = bucket.get(candidate.selector) ?? [];
			existing.push(candidate);
			bucket.set(candidate.selector, existing);
		}
	}

	const matched = [];
	const ambiguous = [];
	const unmatched = [];
	for (const selector of uniqueSelectors) {
		const candidates = candidatesBySelector.get(selector);
		if (candidates.length === 0) {
			unmatched.push({ selector });
			continue;
		}

		const bySignature = new Map();
		for (const candidate of candidates) {
			const values = bySignature.get(candidate.signature) ?? [];
			values.push(candidate);
			bySignature.set(candidate.signature, values);
		}
		if (bySignature.size > 1) {
			ambiguous.push({
				selector,
				candidates: [...bySignature.entries()].map(([signature, values]) => ({
					signature,
					sources: values.map(value => value.source),
				})),
			});
			continue;
		}

		const signatureCandidates = candidates;
		const selected = signatureCandidates[0];
		const variantCount = new Set(signatureCandidates.map(candidate => candidate.abiVariant)).size;
		matched.push({
			selector,
			signature: selected.signature,
			abi: selected.abi,
			source: selected.source,
			corroboratingSources: signatureCandidates.slice(1).map(candidate => candidate.source),
			abiVariantCount: variantCount,
			outputsBytecodeProven: options.outputsBytecodeProven === true,
		});
	}

	const localOnly = [...localOnlyBySelector.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([selector, candidates]) => ({
			selector,
			signatures: [...new Set(candidates.map(candidate => candidate.signature))],
			sources: candidates.map(candidate => candidate.source),
		}));

	return {
		status: ambiguous.length > 0 ? "ambiguous" : unmatched.length > 0 ? "partial" : "complete",
		installedSelectorCount: uniqueSelectors.length,
		matched,
		unmatched,
		ambiguous,
		localOnly,
		invalidAbiEntries,
	};
}

export function findSelectorMatchingAbiSnapshot(installedSelectors, snapshots) {
	const selectors = installedSelectors.map((selector, index) => normalizeSelector(selector, `installedSelectors[${index}]`));
	if (selectors.length === 0) return undefined;
	const installed = new Set(selectors);
	const matches = [];

	for (const snapshot of snapshots) {
		const snapshotSelectors = abiFunctionSelectors(snapshot.abi);
		if (!selectors.every(selector => snapshotSelectors.has(selector))) continue;
		const abi = snapshot.abi.filter(item => {
			if (item?.type !== "function") return true;
			try {
				return installed.has(FunctionFragment.from(item).selector.toLowerCase());
			} catch {
				return false;
			}
		});
		matches.push({
			...snapshot,
			abi,
			extraSelectorCount: snapshotSelectors.size - selectors.length,
		});
	}

	if (matches.length === 0) return undefined;
	matches.sort((left, right) => left.extraSelectorCount - right.extraSelectorCount);
	return matches[0];
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
		const runtimeMatch = matchArtifactRuntime(deployedCode, artifact.deployedBytecode, artifact.immutableReferences);
		if (!runtimeMatch.match) continue;
		const artifactSelectors = abiFunctionSelectors(artifact.abi);
		if (!selectors.every(selector => artifactSelectors.has(selector))) continue;
		matches.push({
			...artifact,
			linkedLibraries: runtimeMatch.linkedLibraries,
			immutableReferenceCount: runtimeMatch.immutableReferenceCount,
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
