#!/usr/bin/env node

import {
	extractDispatcherSelectors,
	findMatchingArtifact,
	findSelectorMatchingAbiSnapshot,
	findSelectorMatchingArtifact,
	fetchVerifiedAbi,
	mapWithConcurrency,
	mergeLiveFacetAbis,
	normalizeLiveFacets,
	parseAbiTargetConfig,
	resolveChainProfile,
	resolveFunctionsFromAbiSnapshots,
	resolveRpcUrl,
} from "./utils/diamondAbi.mjs";
import { Contract, JsonRpcProvider, getAddress, keccak256, sha256, toUtf8Bytes } from "ethers";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LOUPE_ABI = ["function facets() view returns (tuple(address facetAddress, bytes4[] functionSelectors)[] facets_)"];

function usage() {
	return [
		"Usage:",
		"  node scripts/exportDiamondAbi.mjs --chain <name> [--target <label>]",
		"  node scripts/exportDiamondAbi.mjs --config <file> [--chain <name>] [--target <label>] [--output <directory>]",
		"",
		"Defaults:",
		"  --config scripts/config/diamond-abi/<chain>.json",
		"  --chain  $DIAMOND_ABI_CHAIN",
		"  omit --target to export every target in the selected chain config",
		"  --diamond is retained as a deprecated alias for --target",
	].join("\n");
}

export function parseArguments(argv, environment = process.env) {
	let chain = environment.DIAMOND_ABI_CHAIN?.trim();
	let configFile;
	let targetLabel;
	let outputDirectory;

	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") return { help: true };
		if (argument === "--chain") {
			chain = argv[++index];
			if (!chain) throw new Error("--chain requires a value");
			continue;
		}
		if (argument === "--config") {
			configFile = argv[++index];
			if (!configFile) throw new Error("--config requires a value");
			continue;
		}
		if (argument === "--target" || argument === "--diamond") {
			targetLabel = argv[++index];
			if (!targetLabel) throw new Error(`${argument} requires a value`);
			continue;
		}
		if (argument === "--output") {
			outputDirectory = argv[++index];
			if (!outputDirectory) throw new Error("--output requires a value");
			continue;
		}
		throw new Error(`unknown argument: ${argument}`);
	}

	if (!configFile) {
		if (!chain) throw new Error("missing --chain or --config");
		configFile = path.join("scripts", "config", "diamond-abi", `${chain}.json`);
	}

	return {
		help: false,
		chain,
		configFile,
		targetLabel,
		outputDirectory,
	};
}

async function loadConfig(configFile) {
	const body = await fs.readFile(configFile, "utf8");
	let raw;
	try {
		raw = JSON.parse(body);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`invalid JSON in ${configFile}: ${message}`);
	}
	return parseAbiTargetConfig(raw);
}

async function listJsonFiles(directory) {
	const files = [];
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await listJsonFiles(entryPath)));
		else if (entry.isFile() && entry.name.endsWith(".json")) files.push(entryPath);
	}
	return files;
}

async function loadArtifactCandidates(directory) {
	const resolvedDirectory = path.resolve(directory);
	let files;
	try {
		files = await listJsonFiles(resolvedDirectory);
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`cannot read local artifact directory ${resolvedDirectory}: ${message}`);
	}

	const artifacts = [];
	for (const file of files) {
		let artifact;
		try {
			artifact = JSON.parse(await fs.readFile(file, "utf8"));
		} catch {
			continue;
		}
		if (
			typeof artifact.contractName !== "string" ||
			typeof artifact.sourceName !== "string" ||
			!Array.isArray(artifact.abi) ||
			typeof artifact.deployedBytecode !== "string" ||
			artifact.deployedBytecode === "0x"
		) {
			continue;
		}
		artifacts.push({
			file: path.relative(process.cwd(), file),
			contractName: artifact.contractName,
			sourceName: artifact.sourceName,
			abi: artifact.abi,
			deployedBytecode: artifact.deployedBytecode,
			immutableReferences: artifact.immutableReferences ?? {},
		});
	}
	return artifacts;
}

function parseAbiSnapshot(body, snapshot) {
	let abi;
	try {
		abi = JSON.parse(body);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`ABI snapshot ${snapshot.label} is not valid JSON: ${message}`);
	}
	if (!Array.isArray(abi)) throw new Error(`ABI snapshot ${snapshot.label} is not an ABI array`);
	return { ...snapshot, abi };
}

async function discoverVersionRefs() {
	let stdout;
	try {
		({ stdout } = await execFileAsync(
			"git",
			["for-each-ref", "--format=%(refname:short)", "refs/heads/version_*", "refs/remotes/origin/version_*"],
			{ maxBuffer: 2 * 1024 * 1024 },
		));
	} catch {
		return [];
	}

	const available = new Set(
		stdout
			.split(/\r?\n/)
			.map(value => value.trim())
			.filter(Boolean),
	);
	const versions = new Set([...available].map(ref => ref.replace(/^origin\//, "")));
	return [...versions]
		.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
		.map(version => (available.has(version) ? version : `origin/${version}`));
}

async function loadAbiSnapshots(directory = "abis") {
	const snapshots = [];
	const resolvedDirectory = path.resolve(directory);

	let workingTreeFiles = [];
	try {
		workingTreeFiles = await listJsonFiles(resolvedDirectory);
	} catch {
		// A checkout without generated ABI files can still use explorer and compiled-artifact sources.
	}
	for (const file of workingTreeFiles.sort()) {
		const relativePath = path.relative(process.cwd(), file);
		snapshots.push(
			parseAbiSnapshot(await fs.readFile(file, "utf8"), {
				type: "file",
				label: `working-tree:${relativePath}`,
				path: relativePath,
			}),
		);
	}

	for (const ref of await discoverVersionRefs()) {
		let files;
		try {
			const result = await execFileAsync("git", ["ls-tree", "-r", "--name-only", ref, "--", directory], {
				maxBuffer: 2 * 1024 * 1024,
			});
			files = result.stdout
				.split(/\r?\n/)
				.map(value => value.trim())
				.filter(value => value.endsWith(".json"))
				.sort();
		} catch {
			continue;
		}
		for (const file of files) {
			try {
				const result = await execFileAsync("git", ["show", `${ref}:${file}`], {
					maxBuffer: 20 * 1024 * 1024,
				});
				snapshots.push(
					parseAbiSnapshot(result.stdout, {
						type: "git",
						label: `${ref}:${file}`,
						ref,
						path: file,
					}),
				);
			} catch {
				// Ignore files absent or invalid on a historical branch.
			}
		}
	}

	return snapshots;
}

function uniqueAddresses(facets, diamondAddress) {
	const addresses = facets.map(facet => facet.address);
	if (!addresses.some(address => address.toLowerCase() === diamondAddress.toLowerCase())) {
		addresses.push(diamondAddress);
	}
	return addresses;
}

export function countAbiEntries(abi) {
	return abi.reduce((counts, item) => {
		const current = Object.hasOwn(counts, item.type) ? counts[item.type] : 0;
		counts[item.type] = current + 1;
		return counts;
	}, {});
}

async function detectDiamondFacets(provider, address, blockNumber) {
	const loupe = new Contract(address, LOUPE_ABI, provider);
	try {
		return normalizeLiveFacets(await loupe.facets({ blockTag: blockNumber }));
	} catch (error) {
		if (error?.code === "CALL_EXCEPTION" || error?.code === "BAD_DATA" || error?.code === "BUFFER_OVERRUN") {
			return undefined;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`could not detect whether ${address} implements the Diamond loupe at block ${blockNumber}: ${message}`);
	}
}

export async function exportContractAbi(config, options = {}) {
	const rpc = options.rpc ?? resolveRpcUrl(config, options.environment);
	const provider = options.provider ?? new JsonRpcProvider(rpc.url);
	const network = await provider.getNetwork();
	const chainId = Number(network.chainId);
	if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`RPC returned unsupported chain ID ${network.chainId}`);
	if (config.expectedChainId !== undefined && chainId !== config.expectedChainId) {
		throw new Error(`RPC chain ID mismatch: ${config.name} expects ${config.expectedChainId}, RPC returned ${chainId}`);
	}

	const blockNumber = options.blockNumber ?? (await provider.getBlockNumber());
	const deployedCode = await provider.getCode(config.targetAddress, blockNumber);
	if (deployedCode === "0x") {
		throw new Error(`no contract code at target ${config.targetLabel} (${config.targetAddress}) at block ${blockNumber}`);
	}

	const localArtifacts = options.localArtifacts ?? (await loadArtifactCandidates("artifacts/contracts"));
	const abiSnapshots = options.abiSnapshots ?? (await loadAbiSnapshots());
	const exactArtifact = findMatchingArtifact(deployedCode, [], localArtifacts);
	let resolved;
	if (exactArtifact) {
		resolved = {
			abi: exactArtifact.abi,
			source: {
				type: "local-artifact-bytecode-match",
				file: exactArtifact.file,
				contractName: exactArtifact.contractName,
				sourceName: exactArtifact.sourceName,
				linkedLibraries: exactArtifact.linkedLibraries,
				immutableReferenceCount: exactArtifact.immutableReferenceCount,
			},
		};
	} else {
		try {
			resolved = await fetchVerifiedAbi(config.targetAddress, { ...config, chainId }, options);
		} catch (error) {
			const dispatcherSelectors = extractDispatcherSelectors(deployedCode);
			const snapshot = findSelectorMatchingAbiSnapshot(dispatcherSelectors, abiSnapshots);
			if (!snapshot) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					`no bytecode-matching local artifact, verified explorer ABI, or ABI snapshot covering ${dispatcherSelectors.length} dispatcher selector(s) was found for ${config.targetLabel} (${config.targetAddress}): ${message}`,
				);
			}
			resolved = {
				abi: snapshot.abi,
				source: {
					type: "local-abi-snapshot-dispatcher-match",
					snapshot: {
						type: snapshot.type,
						label: snapshot.label,
						path: snapshot.path,
						...(snapshot.ref ? { ref: snapshot.ref } : {}),
					},
					dispatcherSelectorCount: dispatcherSelectors.length,
					extraSnapshotSelectorCount: snapshot.extraSelectorCount,
					runtimeBytecodeMatch: false,
					warning:
						"Every dispatcher selector is covered by one ABI snapshot, but return types and non-function ABI entries are not bytecode-proven.",
				},
			};
		}
	}

	const generatedAt = new Date().toISOString();
	const outputDirectory = path.resolve(config.outputDirectory);
	const abiFile = path.join(outputDirectory, "abi.json");
	const manifestFile = path.join(outputDirectory, "manifest.json");
	const abiBody = `${JSON.stringify(resolved.abi, null, 2)}\n`;
	const abiSha256 = sha256(toUtf8Bytes(abiBody));
	const manifest = {
		schemaVersion: 1,
		generatedAt,
		chain: {
			name: config.name,
			chainId,
			rpcSource: rpc.source,
		},
		targetLabel: config.targetLabel,
		targetType: "contract",
		targetAddress: getAddress(config.targetAddress),
		blockNumber,
		runtimeCodeHash: keccak256(deployedCode),
		abiEntryCounts: countAbiEntries(resolved.abi),
		abiSha256,
		abiSource: resolved.source,
		warnings: resolved.source.warning ? [resolved.source.warning] : [],
		outputs: {
			abi: path.relative(process.cwd(), abiFile),
			manifest: path.relative(process.cwd(), manifestFile),
		},
	};

	await fs.mkdir(outputDirectory, { recursive: true });
	await fs.writeFile(abiFile, abiBody);
	await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

	console.log(`Target:   ${config.targetLabel} (${config.targetAddress})`);
	console.log(`Type:     contract`);
	console.log(`Chain:    ${config.name} (${chainId})`);
	console.log(`Block:    ${blockNumber}`);
	console.log(`Source:   ${resolved.source.type}`);
	console.log(`ABI:      ${abiFile}`);
	console.log(`Manifest: ${manifestFile}`);
	console.log(`SHA-256:  ${abiSha256}`);

	return { abiFile, manifestFile, manifest, abi: resolved.abi };
}

export async function exportDiamondAbi(config, options = {}) {
	const rpc = options.rpc ?? resolveRpcUrl(config, options.environment);
	const provider = options.provider ?? new JsonRpcProvider(rpc.url);
	const network = await provider.getNetwork();
	const chainId = Number(network.chainId);
	if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`RPC returned unsupported chain ID ${network.chainId}`);
	if (config.expectedChainId !== undefined && chainId !== config.expectedChainId) {
		throw new Error(`RPC chain ID mismatch: ${config.name} expects ${config.expectedChainId}, RPC returned ${chainId}`);
	}
	const runtimeConfig = { ...config, chainId };

	const blockNumber = options.blockNumber ?? (await provider.getBlockNumber());
	const diamondCode = await provider.getCode(config.diamondAddress, blockNumber);
	if (diamondCode === "0x") {
		throw new Error(`no contract code at diamondAddress ${config.diamondAddress} at block ${blockNumber}`);
	}

	const loupe = new Contract(config.diamondAddress, LOUPE_ABI, provider);
	const liveFacets = options.liveFacets ?? normalizeLiveFacets(await loupe.facets({ blockTag: blockNumber }));
	const selectorCount = liveFacets.reduce((total, facet) => total + facet.functionSelectors.length, 0);
	console.log(`Diamond: ${config.diamondLabel} (${config.diamondAddress})`);
	console.log(`Chain:   ${config.name} (${chainId})`);
	console.log(`Block:   ${blockNumber}`);
	console.log(`Live:    ${liveFacets.length} facets, ${selectorCount} selectors`);

	const addresses = uniqueAddresses(liveFacets, config.diamondAddress);
	const facetByAddress = new Map(liveFacets.map(facet => [facet.address.toLowerCase(), facet]));
	const localArtifacts = options.localArtifacts ?? (await loadArtifactCandidates("artifacts/contracts"));
	const abiSnapshots = options.abiSnapshots ?? (await loadAbiSnapshots());
	if (options.localArtifacts === undefined) {
		console.log(`Local:   ${localArtifacts.length} compiled runtime artifact(s) available for verified fallback`);
	}
	if (options.abiSnapshots === undefined && abiSnapshots.length > 0) {
		console.log(`ABI refs: ${abiSnapshots.length} working-tree and version-branch snapshot(s) discovered`);
	}
	let completed = 0;
	const fetched = await mapWithConcurrency(
		addresses,
		config.request.concurrency,
		async address => {
			const deployedCode = await provider.getCode(address, blockNumber);
			if (deployedCode === "0x") throw new Error(`no contract code at live ABI target ${address} at block ${blockNumber}`);
			const facet = facetByAddress.get(address.toLowerCase());
			const exactArtifact = findMatchingArtifact(deployedCode, facet?.functionSelectors ?? [], localArtifacts);
			if (exactArtifact) {
				return {
					abi: exactArtifact.abi,
					source: {
						type: "local-artifact-bytecode-match",
						file: exactArtifact.file,
						contractName: exactArtifact.contractName,
						sourceName: exactArtifact.sourceName,
						linkedLibraries: exactArtifact.linkedLibraries,
						immutableReferenceCount: exactArtifact.immutableReferenceCount,
					},
				};
			}
			try {
				return await fetchVerifiedAbi(address, runtimeConfig, {
					...options,
					targetRuntimeCode: deployedCode,
				});
			} catch (explorerError) {
				if (!facet) {
					const message = explorerError instanceof Error ? explorerError.message : String(explorerError);
					return {
						abi: [],
						source: {
							type: "diamond-edge-unavailable",
							runtimeBytecodeMatch: false,
							warning: `Diamond fallback/receive ABI was unavailable: ${message}`,
						},
					};
				}
				const selectorArtifact = findSelectorMatchingArtifact(facet.functionSelectors, localArtifacts);
				if (selectorArtifact) {
					return {
						abi: selectorArtifact.abi,
						source: {
							type: "local-artifact-selector-match",
							file: selectorArtifact.file,
							contractName: selectorArtifact.contractName,
							sourceName: selectorArtifact.sourceName,
							runtimeBytecodeMatch: false,
							warning:
								"Function selectors match, but return types and non-function ABI entries cannot be proven from on-chain bytecode.",
						},
					};
				}
				const snapshotFunctions = resolveFunctionsFromAbiSnapshots(facet.functionSelectors, abiSnapshots);
				if (!snapshotFunctions) {
					const message = explorerError instanceof Error ? explorerError.message : String(explorerError);
					throw new Error(`${message}; no local artifact or ABI snapshot covers every installed selector`);
				}
				return {
					abi: snapshotFunctions.abi,
					source: {
						type: "local-abi-snapshot-selector-match",
						snapshots: snapshotFunctions.snapshots,
						functions: snapshotFunctions.functions,
						runtimeBytecodeMatch: false,
						warning: "Function selectors match configured ABI snapshots, but return types cannot be proven from on-chain bytecode.",
					},
				};
			}
		},
		(address, _index, result) => {
			completed += 1;
			console.log(`[${completed}/${addresses.length}] resolved ABI for ${address} (${result.source.type})`);
		},
	);
	const fetchedByAddress = new Map(addresses.map((address, index) => [address.toLowerCase(), fetched[index]]));
	const diamondFetched = fetchedByAddress.get(config.diamondAddress.toLowerCase());
	const merged = mergeLiveFacetAbis(liveFacets, fetchedByAddress, diamondFetched?.abi);

	const generatedAt = new Date().toISOString();
	const outputDirectory = path.resolve(config.outputDirectory);
	const abiFile = path.join(outputDirectory, "abi.json");
	const manifestFile = path.join(outputDirectory, "manifest.json");
	const abiBody = `${JSON.stringify(merged.abi, null, 2)}\n`;
	const abiSha256 = sha256(toUtf8Bytes(abiBody));
	const manifest = {
		schemaVersion: 1,
		generatedAt,
		chain: {
			name: config.name,
			chainId,
			rpcSource: rpc.source,
		},
		targetLabel: config.diamondLabel,
		targetType: "diamond",
		targetAddress: getAddress(config.diamondAddress),
		diamondLabel: config.diamondLabel,
		diamondAddress: getAddress(config.diamondAddress),
		blockNumber,
		facetCount: liveFacets.length,
		selectorCount: merged.selectorCount,
		abiEntryCounts: merged.counts,
		abiSha256,
		diamondAbiSource: diamondFetched?.source,
		diamondEdgeEntryCount: merged.diamondEdgeEntryCount,
		warnings: [
			...(diamondFetched?.source.warning ? [diamondFetched.source.warning] : []),
			...merged.facets
				.filter(
					facet => facet.abiSource.type === "local-artifact-selector-match" || facet.abiSource.type === "local-abi-snapshot-selector-match",
				)
				.map(facet => `${facet.address} uses ${facet.abiSource.type} only; return types and non-function entries are not bytecode-proven.`),
		],
		facets: merged.facets,
		outputs: {
			abi: path.relative(process.cwd(), abiFile),
			manifest: path.relative(process.cwd(), manifestFile),
		},
	};

	await fs.mkdir(outputDirectory, { recursive: true });
	await fs.writeFile(abiFile, abiBody);
	await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

	console.log(`ABI:      ${abiFile}`);
	console.log(`Manifest: ${manifestFile}`);
	console.log(`SHA-256:  ${abiSha256}`);

	return { abiFile, manifestFile, manifest, abi: merged.abi };
}

export async function exportAbiTarget(config, options = {}) {
	const provider = options.provider ?? new JsonRpcProvider((options.rpc ?? resolveRpcUrl(config, options.environment)).url);
	const blockNumber = options.blockNumber ?? (await provider.getBlockNumber());
	const liveFacets = await detectDiamondFacets(provider, config.targetAddress, blockNumber);
	if (liveFacets) {
		return exportDiamondAbi(
			{
				...config,
				diamondLabel: config.targetLabel,
				diamondAddress: config.targetAddress,
			},
			{
				...options,
				provider,
				blockNumber,
				liveFacets,
			},
		);
	}
	return exportContractAbi(config, {
		...options,
		provider,
		blockNumber,
	});
}

async function main() {
	const args = parseArguments(process.argv.slice(2));
	if (args.help) {
		console.log(usage());
		return;
	}
	const chain = (args.chain ?? path.basename(args.configFile, path.extname(args.configFile))).toLowerCase();
	const chainConfig = await loadConfig(args.configFile);
	const profile = resolveChainProfile(chain);
	const selectedTargets = args.targetLabel ? chainConfig.targets.filter(target => target.label === args.targetLabel) : chainConfig.targets;
	if (selectedTargets.length === 0) {
		throw new Error(
			`Target "${args.targetLabel}" is not configured for ${chain}; available labels: ${chainConfig.targets
				.map(target => target.label)
				.join(", ")}`,
		);
	}

	const rpc = resolveRpcUrl(profile);
	const provider = new JsonRpcProvider(rpc.url);
	const network = await provider.getNetwork();
	if (Number(network.chainId) !== profile.expectedChainId) {
		throw new Error(`RPC chain ID mismatch: ${chain} expects ${profile.expectedChainId}, RPC returned ${network.chainId}`);
	}
	const blockNumber = await provider.getBlockNumber();
	const localArtifacts = await loadArtifactCandidates("artifacts/contracts");
	const abiSnapshots = await loadAbiSnapshots();
	const outputRoot = path.resolve(args.outputDirectory ?? path.join("scripts", "output", "diamond-abi", chain));

	console.log(`Chain config: ${args.configFile}`);
	console.log(`RPC source:   ${rpc.source}`);
	console.log(`Targets:      ${selectedTargets.map(target => target.label).join(", ")}`);
	console.log(`Local:        ${localArtifacts.length} compiled runtime artifact(s)`);
	console.log(`ABI refs:     ${abiSnapshots.length} working-tree and version-branch snapshot(s)`);

	for (const target of selectedTargets) {
		await exportAbiTarget(
			{
				...profile,
				targetLabel: target.label,
				targetAddress: target.address,
				outputDirectory: path.join(outputRoot, target.label),
			},
			{
				provider,
				rpc,
				blockNumber,
				localArtifacts,
				abiSnapshots,
			},
		);
	}
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
	main().catch(error => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Diamond ABI export failed: ${message}`);
		process.exitCode = 1;
	});
}
