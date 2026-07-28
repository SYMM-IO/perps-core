#!/usr/bin/env node

import {
	findMatchingArtifact,
	findSelectorMatchingArtifact,
	fetchVerifiedAbi,
	mapWithConcurrency,
	mergeLiveFacetAbis,
	normalizeLiveFacets,
	parseDiamondAbiConfig,
	resolveFunctionsFromAbiSnapshots,
	resolveRpcUrl,
} from "./utils/diamondAbi.mjs";
import { Contract, JsonRpcProvider, getAddress, sha256, toUtf8Bytes } from "ethers";
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
		"  node scripts/exportDiamondAbi.mjs --chain <name>",
		"  node scripts/exportDiamondAbi.mjs --config <file> [--output <directory>]",
		"",
		"Defaults:",
		"  --config scripts/config/diamond-abi/<chain>.json",
		"  --chain  $DIAMOND_ABI_CHAIN",
	].join("\n");
}

export function parseArguments(argv, environment = process.env) {
	let chain = environment.DIAMOND_ABI_CHAIN?.trim();
	let configFile;
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
		outputDirectory,
	};
}

async function loadConfig(configFile, outputOverride) {
	const body = await fs.readFile(configFile, "utf8");
	let raw;
	try {
		raw = JSON.parse(body);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`invalid JSON in ${configFile}: ${message}`);
	}
	const config = parseDiamondAbiConfig(raw);
	return {
		...config,
		outputDirectory: outputOverride ?? config.outputDirectory,
	};
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
		if (artifact.immutableReferences && Object.keys(artifact.immutableReferences).length > 0) continue;
		artifacts.push({
			file: path.relative(process.cwd(), file),
			contractName: artifact.contractName,
			sourceName: artifact.sourceName,
			abi: artifact.abi,
			deployedBytecode: artifact.deployedBytecode,
		});
	}
	return artifacts;
}

async function loadAbiSnapshots(configuredSnapshots) {
	const snapshots = [];
	for (const snapshot of configuredSnapshots) {
		let body;
		if (snapshot.type === "file") {
			body = await fs.readFile(snapshot.path, "utf8");
		} else {
			try {
				const result = await execFileAsync("git", ["show", `${snapshot.ref}:${snapshot.path}`], {
					maxBuffer: 20 * 1024 * 1024,
				});
				body = result.stdout;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`cannot load ABI snapshot ${snapshot.label} from ${snapshot.ref}:${snapshot.path}: ${message}`);
			}
		}

		let abi;
		try {
			abi = JSON.parse(body);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`ABI snapshot ${snapshot.label} is not valid JSON: ${message}`);
		}
		if (!Array.isArray(abi)) throw new Error(`ABI snapshot ${snapshot.label} is not an ABI array`);
		snapshots.push({
			...snapshot,
			abi,
		});
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

export async function exportDiamondAbi(config, options = {}) {
	const rpc = resolveRpcUrl(config, options.environment);
	const provider = options.provider ?? new JsonRpcProvider(rpc.url);
	const network = await provider.getNetwork();
	if (network.chainId !== BigInt(config.chainId)) {
		throw new Error(`RPC chain ID mismatch: config expects ${config.chainId}, RPC returned ${network.chainId}`);
	}

	const blockNumber = await provider.getBlockNumber();
	const diamondCode = await provider.getCode(config.diamondAddress, blockNumber);
	if (diamondCode === "0x") {
		throw new Error(`no contract code at diamondAddress ${config.diamondAddress} at block ${blockNumber}`);
	}

	const loupe = new Contract(config.diamondAddress, LOUPE_ABI, provider);
	const liveFacets = normalizeLiveFacets(await loupe.facets({ blockTag: blockNumber }));
	const selectorCount = liveFacets.reduce((total, facet) => total + facet.functionSelectors.length, 0);
	console.log(`Diamond: ${config.diamondAddress}`);
	console.log(`Chain:   ${config.name} (${config.chainId})`);
	console.log(`Block:   ${blockNumber}`);
	console.log(`Live:    ${liveFacets.length} facets, ${selectorCount} selectors`);

	const addresses = uniqueAddresses(liveFacets, config.diamondAddress);
	const facetByAddress = new Map(liveFacets.map(facet => [facet.address.toLowerCase(), facet]));
	const localArtifacts = config.localArtifacts ? await loadArtifactCandidates(config.localArtifacts.directory) : [];
	const abiSnapshots = await loadAbiSnapshots(config.abiSnapshots);
	if (config.localArtifacts) {
		console.log(`Local:   ${localArtifacts.length} compiled runtime artifact(s) available for verified fallback`);
	}
	if (abiSnapshots.length > 0) {
		console.log(`ABI refs: ${abiSnapshots.map(snapshot => snapshot.label).join(", ")}`);
	}
	let completed = 0;
	const fetched = await mapWithConcurrency(
		addresses,
		config.request.concurrency,
		async address => {
			const deployedCode = await provider.getCode(address, blockNumber);
			if (deployedCode === "0x") throw new Error(`no contract code at live ABI target ${address} at block ${blockNumber}`);
			try {
				return await fetchVerifiedAbi(address, config, {
					...options,
					targetRuntimeCode: deployedCode,
				});
			} catch (explorerError) {
				const facet = facetByAddress.get(address.toLowerCase());
				if (!facet) throw explorerError;
				const exactArtifact = findMatchingArtifact(deployedCode, facet.functionSelectors, localArtifacts);
				if (exactArtifact) {
					return {
						abi: exactArtifact.abi,
						source: {
							type: "local-artifact-bytecode-match",
							file: exactArtifact.file,
							contractName: exactArtifact.contractName,
							sourceName: exactArtifact.sourceName,
							linkedLibraries: exactArtifact.linkedLibraries,
						},
					};
				}
				const selectorArtifact = config.localArtifacts?.allowSelectorOnlyFallback
					? findSelectorMatchingArtifact(facet.functionSelectors, localArtifacts)
					: undefined;
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
			chainId: config.chainId,
			rpcSource: rpc.source,
		},
		diamondAddress: getAddress(config.diamondAddress),
		blockNumber,
		facetCount: liveFacets.length,
		selectorCount: merged.selectorCount,
		abiEntryCounts: merged.counts,
		abiSha256,
		diamondAbiSource: diamondFetched?.source,
		diamondEdgeEntryCount: merged.diamondEdgeEntryCount,
		warnings: merged.facets
			.filter(facet => facet.abiSource.type === "local-artifact-selector-match" || facet.abiSource.type === "local-abi-snapshot-selector-match")
			.map(facet => `${facet.address} uses ${facet.abiSource.type} only; return types and non-function entries are not bytecode-proven.`),
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

async function main() {
	const args = parseArguments(process.argv.slice(2));
	if (args.help) {
		console.log(usage());
		return;
	}
	const config = await loadConfig(args.configFile, args.outputDirectory);
	await exportDiamondAbi(config);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
	main().catch(error => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Diamond ABI export failed: ${message}`);
		process.exitCode = 1;
	});
}
