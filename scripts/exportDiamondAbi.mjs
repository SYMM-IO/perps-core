#!/usr/bin/env node

import {
	analyzeSelectorsAgainstAbiSources,
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
	resolveRpcUrl,
} from "./utils/diamondAbi.mjs";
import { Contract, FunctionFragment, Interface, JsonRpcProvider, getAddress, keccak256, sha256, toUtf8Bytes } from "ethers";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LOUPE_ABI = ["function facets() view returns (tuple(address facetAddress, bytes4[] functionSelectors)[] facets_)"];
const BEACON_INTERFACE = new Interface(["function implementation() view returns (address)"]);
const EIP1967_IMPLEMENTATION_SLOT = `0x${(BigInt(keccak256(toUtf8Bytes("eip1967.proxy.implementation"))) - 1n).toString(16).padStart(64, "0")}`;
const EIP1967_BEACON_SLOT = `0x${(BigInt(keccak256(toUtf8Bytes("eip1967.proxy.beacon"))) - 1n).toString(16).padStart(64, "0")}`;
const MINIMAL_PROXY_RUNTIME = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;

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

function selectorProof(source) {
	if (source.type === "local-artifact-bytecode-match") return "exact-bytecode";
	if (source.type === "etherscan-v2" || source.type === "etherscan-html") return "verified-explorer";
	return "selector-match";
}

function abiFunctionSelectors(abi) {
	return abi.flatMap(item => {
		if (item?.type !== "function") return [];
		try {
			return [FunctionFragment.from(item).selector.toLowerCase()];
		} catch {
			return [];
		}
	});
}

function abiFromAnalysis(sourceAbi, analysis, includeNonFunctions = true) {
	return [...(includeNonFunctions ? sourceAbi.filter(item => item?.type !== "function") : []), ...analysis.matched.map(match => match.abi)];
}

function selectorAnalysisReport(analysis, source, context = {}) {
	return {
		status: analysis.status,
		installedSelectorCount: analysis.installedSelectorCount,
		matched: analysis.matched.map(({ abi: _abi, outputsBytecodeProven, corroboratingSources, ...match }) => ({
			...context,
			...match,
			corroboratingSourceCount: corroboratingSources.length,
			...(corroboratingSources.length > 0 ? { corroboratingSources: corroboratingSources.slice(0, 5) } : {}),
			proof: selectorProof(source),
			outputsBytecodeProven,
			fullAbiArtifactProven: source.type === "local-artifact-bytecode-match",
		})),
		unmatched: analysis.unmatched.map(item => ({ ...context, ...item })),
		ambiguous: analysis.ambiguous.map(item => ({ ...context, ...item })),
		localOnly: analysis.localOnly.map(item => ({ ...context, ...item })),
		invalidAbiEntries: analysis.invalidAbiEntries.map(item => ({ ...context, ...item })),
	};
}

function analyzeResolvedAbi(installedSelectors, resolved, context = {}) {
	const analysis =
		resolved.selectorAnalysis ??
		analyzeSelectorsAgainstAbiSources(
			installedSelectors,
			[
				{
					...resolved.source,
					label: resolved.source.label ?? resolved.source.file ?? resolved.source.url ?? resolved.source.type,
					abi: resolved.abi,
				},
			],
			{ outputsBytecodeProven: false },
		);
	return {
		analysis,
		report: selectorAnalysisReport(analysis, resolved.source, context),
	};
}

function combineSelectorReports(reports) {
	const combined = {
		status: reports.some(report => report.status === "ambiguous")
			? "ambiguous"
			: reports.some(report => report.status !== "complete")
				? "partial"
				: "complete",
		installedSelectorCount: reports.reduce((total, report) => total + report.installedSelectorCount, 0),
		matched: reports.flatMap(report => report.matched),
		unmatched: reports.flatMap(report => report.unmatched),
		ambiguous: reports.flatMap(report => report.ambiguous),
		localOnly: reports.flatMap(report => report.localOnly),
		invalidAbiEntries: reports.flatMap(report => report.invalidAbiEntries),
	};
	return combined;
}

export function assertCompleteTargetResults(targetResults) {
	const incompleteTargets = targetResults.filter(target => !target.result.complete);
	if (incompleteTargets.length === 0) return;
	const error = new Error(
		`ABI resolution is incomplete for ${incompleteTargets.map(target => target.label).join(", ")}; review ${incompleteTargets
			.map(target => target.result.reportFile)
			.join(", ")}`,
	);
	error.exitCode = 2;
	throw error;
}

async function writeJson(file, value) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeCompleteOutputs(outputDirectory, abi, manifest, report) {
	const abiFile = path.join(outputDirectory, "abi.json");
	const manifestFile = path.join(outputDirectory, "manifest.json");
	const reportFile = path.join(outputDirectory, "report.json");
	const partialAbiFile = path.join(outputDirectory, "abi.partial.json");
	const abiBody = `${JSON.stringify(abi, null, 2)}\n`;
	const abiSha256 = sha256(toUtf8Bytes(abiBody));
	await fs.mkdir(outputDirectory, { recursive: true });
	await fs.rm(partialAbiFile, { force: true });
	await fs.writeFile(abiFile, abiBody);
	await writeJson(manifestFile, {
		...manifest,
		abiSha256,
		outputs: {
			abi: path.relative(process.cwd(), abiFile),
			manifest: path.relative(process.cwd(), manifestFile),
			report: path.relative(process.cwd(), reportFile),
		},
	});
	await writeJson(reportFile, {
		...report,
		abiSha256,
		outputs: {
			abi: path.relative(process.cwd(), abiFile),
			manifest: path.relative(process.cwd(), manifestFile),
			report: path.relative(process.cwd(), reportFile),
		},
	});
	return { abiFile, manifestFile, reportFile, abiSha256 };
}

async function writePartialOutputs(outputDirectory, abi, report) {
	const abiFile = path.join(outputDirectory, "abi.json");
	const manifestFile = path.join(outputDirectory, "manifest.json");
	const partialAbiFile = path.join(outputDirectory, "abi.partial.json");
	const reportFile = path.join(outputDirectory, "report.json");
	const abiBody = `${JSON.stringify(abi, null, 2)}\n`;
	const abiSha256 = sha256(toUtf8Bytes(abiBody));
	await fs.mkdir(outputDirectory, { recursive: true });
	await fs.rm(abiFile, { force: true });
	await fs.rm(manifestFile, { force: true });
	await fs.writeFile(partialAbiFile, abiBody);
	await writeJson(reportFile, {
		...report,
		partialAbiSha256: abiSha256,
		outputs: {
			partialAbi: path.relative(process.cwd(), partialAbiFile),
			report: path.relative(process.cwd(), reportFile),
		},
	});
	return { partialAbiFile, reportFile, abiSha256 };
}

function addressFromStorage(value) {
	if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) return undefined;
	const encoded = value.slice(2).padStart(64, "0");
	if (encoded.length !== 64) return undefined;
	const rawAddress = encoded.slice(-40);
	if (/^0+$/.test(rawAddress)) return undefined;
	return getAddress(`0x${rawAddress}`);
}

async function readStorageAddress(provider, address, slot, blockNumber, warnings) {
	if (typeof provider.getStorage !== "function") {
		warnings.push(`Provider does not expose getStorage; EIP-1967 proxy detection was skipped for ${address}.`);
		return undefined;
	}
	try {
		return addressFromStorage(await provider.getStorage(address, slot, blockNumber));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warnings.push(`Could not read EIP-1967 storage at ${address}: ${message}`);
		return undefined;
	}
}

async function readBeaconImplementation(provider, beaconAddress, blockNumber) {
	const result = await provider.call(
		{
			to: beaconAddress,
			data: BEACON_INTERFACE.encodeFunctionData("implementation"),
		},
		blockNumber,
	);
	const [implementationAddress] = BEACON_INTERFACE.decodeFunctionResult("implementation", result);
	return getAddress(implementationAddress);
}

function minimalProxyImplementation(runtimeCode) {
	const match = runtimeCode.match(MINIMAL_PROXY_RUNTIME);
	return match ? getAddress(`0x${match[1]}`) : undefined;
}

export async function resolveProxyRuntime(provider, targetAddress, blockNumber, options = {}) {
	const maxDepth = options.maxDepth ?? 8;
	if (!Number.isSafeInteger(maxDepth) || maxDepth <= 0) throw new Error("maxDepth must be a positive integer");
	const warnings = [];
	const chain = [];
	const seen = new Set();
	let runtimeAddress = getAddress(targetAddress);
	let runtimeCode = options.targetCode ?? (await provider.getCode(runtimeAddress, blockNumber));

	for (let depth = 0; depth < maxDepth; depth++) {
		if (runtimeCode === "0x") throw new Error(`no contract code at proxy resolution target ${runtimeAddress} at block ${blockNumber}`);
		const addressKey = runtimeAddress.toLowerCase();
		if (seen.has(addressKey)) throw new Error(`proxy implementation cycle detected at ${runtimeAddress}`);
		seen.add(addressKey);

		let proxyType;
		let implementationAddress = minimalProxyImplementation(runtimeCode);
		let beaconAddress;
		if (implementationAddress) {
			proxyType = "eip-1167";
		} else {
			const [slotImplementation, slotBeacon] = await Promise.all([
				readStorageAddress(provider, runtimeAddress, EIP1967_IMPLEMENTATION_SLOT, blockNumber, warnings),
				readStorageAddress(provider, runtimeAddress, EIP1967_BEACON_SLOT, blockNumber, warnings),
			]);
			if (slotImplementation && slotBeacon) {
				warnings.push(`${runtimeAddress} has both EIP-1967 implementation and beacon slots set; the implementation slot takes precedence.`);
			}
			if (slotImplementation) {
				proxyType = "eip-1967";
				implementationAddress = slotImplementation;
			} else if (slotBeacon) {
				proxyType = "eip-1967-beacon";
				beaconAddress = slotBeacon;
				try {
					implementationAddress = await readBeaconImplementation(provider, beaconAddress, blockNumber);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(`could not resolve implementation from beacon ${beaconAddress} at block ${blockNumber}: ${message}`);
				}
			}
		}

		if (!implementationAddress) {
			return {
				targetAddress: getAddress(targetAddress),
				runtimeAddress,
				runtimeCode,
				runtimeCodeHash: keccak256(runtimeCode),
				chain,
				warnings,
			};
		}
		if (seen.has(implementationAddress.toLowerCase())) {
			throw new Error(`proxy implementation cycle detected from ${runtimeAddress} to ${implementationAddress}`);
		}

		chain.push({
			type: proxyType,
			proxyAddress: runtimeAddress,
			proxyRuntimeCodeHash: keccak256(runtimeCode),
			...(beaconAddress ? { beaconAddress } : {}),
			implementationAddress,
		});
		runtimeAddress = implementationAddress;
		runtimeCode = await provider.getCode(runtimeAddress, blockNumber);
	}

	throw new Error(`proxy resolution exceeded maximum depth ${maxDepth} from ${targetAddress}`);
}

function proxyResolutionReport(resolution) {
	if (!resolution || resolution.chain.length === 0) return undefined;
	return {
		targetAddress: resolution.targetAddress,
		runtimeAddress: resolution.runtimeAddress,
		runtimeCodeHash: resolution.runtimeCodeHash,
		chain: resolution.chain,
		warnings: resolution.warnings,
	};
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
	const runtimeAddress = getAddress(config.runtimeAddress ?? config.targetAddress);
	const deployedCode = options.runtimeCode ?? (await provider.getCode(runtimeAddress, blockNumber));
	if (deployedCode === "0x") {
		throw new Error(`no contract code at runtime target ${config.targetLabel} (${runtimeAddress}) at block ${blockNumber}`);
	}
	const proxy = proxyResolutionReport(config.proxyResolution);

	const localArtifacts = options.localArtifacts ?? (await loadArtifactCandidates("artifacts/contracts"));
	const abiSnapshots = options.abiSnapshots ?? (await loadAbiSnapshots());
	const dispatcherSelectors = extractDispatcherSelectors(deployedCode);
	const exactArtifact = findMatchingArtifact(deployedCode, [], localArtifacts);
	let resolved;
	if (exactArtifact) {
		const installedSelectors = abiFunctionSelectors(exactArtifact.abi);
		const source = {
			type: "local-artifact-bytecode-match",
			file: exactArtifact.file,
			contractName: exactArtifact.contractName,
			sourceName: exactArtifact.sourceName,
			linkedLibraries: exactArtifact.linkedLibraries,
			immutableReferenceCount: exactArtifact.immutableReferenceCount,
		};
		resolved = {
			abi: exactArtifact.abi,
			source,
			installedSelectors,
			selectorSource: "exact-artifact-bound-to-runtime-bytecode",
			selectorAnalysis: analyzeSelectorsAgainstAbiSources(
				installedSelectors,
				[{ ...source, label: exactArtifact.file, abi: exactArtifact.abi }],
				{ outputsBytecodeProven: false },
			),
		};
	} else {
		let explorerFailure;
		let explorerCandidate;
		try {
			explorerCandidate = await fetchVerifiedAbi(runtimeAddress, { ...config, chainId }, options);
			const explorerAnalysis = analyzeSelectorsAgainstAbiSources(
				dispatcherSelectors,
				[{ ...explorerCandidate.source, label: explorerCandidate.source.url, abi: explorerCandidate.abi }],
				{ outputsBytecodeProven: false },
			);
			if (dispatcherSelectors.length > 0 && explorerAnalysis.status === "complete") {
				resolved = {
					...explorerCandidate,
					abi: abiFromAnalysis(explorerCandidate.abi, explorerAnalysis),
					installedSelectors: dispatcherSelectors,
					selectorSource: "runtime-dispatcher",
					selectorAnalysis: explorerAnalysis,
				};
			}
		} catch (error) {
			explorerFailure = error instanceof Error ? error.message : String(error);
		}

		if (!resolved) {
			const selectorArtifact = dispatcherSelectors.length > 0 ? findSelectorMatchingArtifact(dispatcherSelectors, localArtifacts) : undefined;
			if (selectorArtifact) {
				const source = {
					type: "local-artifact-dispatcher-match",
					file: selectorArtifact.file,
					contractName: selectorArtifact.contractName,
					sourceName: selectorArtifact.sourceName,
					runtimeBytecodeMatch: false,
					warning:
						"Every dispatcher selector matches this local artifact, but return types and non-function ABI entries are not bytecode-proven.",
				};
				const analysis = analyzeSelectorsAgainstAbiSources(
					dispatcherSelectors,
					[{ ...source, label: selectorArtifact.file, abi: selectorArtifact.abi }],
					{ outputsBytecodeProven: false },
				);
				resolved = {
					abi: abiFromAnalysis(selectorArtifact.abi, analysis),
					source,
					installedSelectors: dispatcherSelectors,
					selectorSource: "runtime-dispatcher",
					selectorAnalysis: analysis,
				};
			}
		}

		if (!resolved) {
			const snapshot = findSelectorMatchingAbiSnapshot(dispatcherSelectors, abiSnapshots);
			if (snapshot) {
				const originalSnapshot = abiSnapshots.find(candidate => candidate.label === snapshot.label) ?? snapshot;
				const source = {
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
				};
				const analysis = analyzeSelectorsAgainstAbiSources(dispatcherSelectors, [{ ...originalSnapshot, abi: originalSnapshot.abi }], {
					outputsBytecodeProven: false,
				});
				resolved = {
					abi: snapshot.abi,
					source,
					installedSelectors: dispatcherSelectors,
					selectorSource: "runtime-dispatcher",
					selectorAnalysis: analysis,
				};
			}
		}

		if (!resolved) {
			const candidateSources = [
				...(explorerCandidate ? [{ ...explorerCandidate.source, label: explorerCandidate.source.url, abi: explorerCandidate.abi }] : []),
				...localArtifacts.map(artifact => ({
					type: "local-artifact",
					label: artifact.file,
					file: artifact.file,
					contractName: artifact.contractName,
					sourceName: artifact.sourceName,
					abi: artifact.abi,
				})),
				...abiSnapshots,
			];
			const analysis = analyzeSelectorsAgainstAbiSources(dispatcherSelectors, candidateSources, {
				includeLocalOnly: false,
				outputsBytecodeProven: false,
			});
			const warning =
				dispatcherSelectors.length === 0
					? "No standard dispatcher selectors could be extracted from runtime bytecode."
					: `${analysis.unmatched.length} selector(s) are unmatched and ${analysis.ambiguous.length} selector(s) are ambiguous.`;
			resolved = {
				abi: analysis.matched.map(match => match.abi),
				source: {
					type: "selector-resolution-incomplete",
					dispatcherSelectorCount: dispatcherSelectors.length,
					runtimeBytecodeMatch: false,
					...(explorerFailure ? { explorerFailure } : {}),
					warning,
				},
				installedSelectors: dispatcherSelectors,
				selectorSource: "runtime-dispatcher",
				selectorAnalysis: analysis,
			};
		}
	}

	const generatedAt = new Date().toISOString();
	const outputDirectory = path.resolve(config.outputDirectory);
	const { analysis, report: selectorVerification } = analyzeResolvedAbi(resolved.installedSelectors, resolved);
	const complete = analysis.status === "complete";
	const baseReport = {
		schemaVersion: 1,
		generatedAt,
		status: complete ? "complete" : "incomplete",
		chain: {
			name: config.name,
			chainId,
			rpcSource: rpc.source,
		},
		targetLabel: config.targetLabel,
		targetType: proxy ? "proxy" : "contract",
		targetAddress: getAddress(config.targetAddress),
		runtimeAddress,
		blockNumber,
		runtimeCodeHash: keccak256(deployedCode),
		...(proxy ? { proxy } : {}),
		selectorSource: resolved.selectorSource,
		selectorVerification,
		abiEntryCounts: countAbiEntries(resolved.abi),
		abiSource: resolved.source,
		warnings: [...(resolved.source.warning ? [resolved.source.warning] : []), ...(proxy?.warnings ?? [])],
	};

	console.log(`Target:   ${config.targetLabel} (${config.targetAddress})`);
	console.log(`Type:     ${proxy ? "proxy" : "contract"}`);
	if (proxy) console.log(`Runtime:  ${runtimeAddress} (${proxy.chain.length} proxy hop(s))`);
	console.log(`Chain:    ${config.name} (${chainId})`);
	console.log(`Block:    ${blockNumber}`);
	console.log(`Source:   ${resolved.source.type}`);
	console.log(`Selectors: ${analysis.matched.length} matched, ${analysis.unmatched.length} unmatched, ${analysis.ambiguous.length} ambiguous`);

	if (complete) {
		const outputs = await writeCompleteOutputs(outputDirectory, resolved.abi, baseReport, baseReport);
		console.log(`ABI:      ${outputs.abiFile}`);
		console.log(`Manifest: ${outputs.manifestFile}`);
		console.log(`Report:   ${outputs.reportFile}`);
		console.log(`SHA-256:  ${outputs.abiSha256}`);
		return { ...outputs, complete, manifest: { ...baseReport, abiSha256: outputs.abiSha256 }, abi: resolved.abi };
	}

	const outputs = await writePartialOutputs(outputDirectory, resolved.abi, baseReport);
	console.log(`Partial:  ${outputs.partialAbiFile}`);
	console.log(`Report:   ${outputs.reportFile}`);
	return { ...outputs, complete, report: baseReport, abi: resolved.abi };
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
	const proxy = proxyResolutionReport(config.proxyResolution);

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
			let explorerCandidate;
			let explorerFailure;
			try {
				explorerCandidate = await fetchVerifiedAbi(address, runtimeConfig, {
					...options,
					targetRuntimeCode: deployedCode,
				});
				if (!facet) return explorerCandidate;
				const explorerAnalysis = analyzeSelectorsAgainstAbiSources(
					facet.functionSelectors,
					[{ ...explorerCandidate.source, label: explorerCandidate.source.url, abi: explorerCandidate.abi }],
					{ outputsBytecodeProven: false },
				);
				if (explorerAnalysis.status === "complete") {
					return {
						...explorerCandidate,
						selectorAnalysis: explorerAnalysis,
					};
				}
			} catch (explorerError) {
				explorerFailure = explorerError instanceof Error ? explorerError.message : String(explorerError);
			}
			if (!facet) {
				return {
					abi: [],
					source: {
						type: "diamond-edge-unavailable",
						runtimeBytecodeMatch: false,
						warning: `Diamond fallback/receive ABI was unavailable: ${explorerFailure ?? "verified explorer ABI was incomplete"}`,
					},
				};
			}

			const selectorArtifact = findSelectorMatchingArtifact(facet.functionSelectors, localArtifacts);
			if (selectorArtifact) {
				const source = {
					type: "local-artifact-selector-match",
					file: selectorArtifact.file,
					contractName: selectorArtifact.contractName,
					sourceName: selectorArtifact.sourceName,
					runtimeBytecodeMatch: false,
					warning: "Function selectors match, but return types and non-function ABI entries cannot be proven from on-chain bytecode.",
				};
				return {
					abi: selectorArtifact.abi,
					source,
					selectorAnalysis: analyzeSelectorsAgainstAbiSources(
						facet.functionSelectors,
						[{ ...source, label: selectorArtifact.file, abi: selectorArtifact.abi }],
						{ outputsBytecodeProven: false },
					),
				};
			}

			const snapshotAnalysis = analyzeSelectorsAgainstAbiSources(facet.functionSelectors, abiSnapshots, {
				includeLocalOnly: false,
				outputsBytecodeProven: false,
			});
			if (snapshotAnalysis.status === "complete") {
				const snapshots = new Map();
				for (const match of snapshotAnalysis.matched) {
					for (const source of [match.source, ...match.corroboratingSources]) {
						const label = source.label ?? source.path ?? source.type;
						snapshots.set(label, source);
					}
				}
				return {
					abi: snapshotAnalysis.matched.map(match => match.abi),
					source: {
						type: "local-abi-snapshot-selector-match",
						snapshots: [...snapshots.values()],
						functions: snapshotAnalysis.matched.map(match => ({
							selector: match.selector,
							signature: match.signature,
							snapshot: match.source.label,
						})),
						runtimeBytecodeMatch: false,
						warning: "Function selectors match configured ABI snapshots, but return types cannot be proven from on-chain bytecode.",
					},
					selectorAnalysis: snapshotAnalysis,
				};
			}

			const combinedAnalysis = analyzeSelectorsAgainstAbiSources(
				facet.functionSelectors,
				[
					...(explorerCandidate ? [{ ...explorerCandidate.source, label: explorerCandidate.source.url, abi: explorerCandidate.abi }] : []),
					...localArtifacts.map(artifact => ({
						type: "local-artifact",
						label: artifact.file,
						file: artifact.file,
						contractName: artifact.contractName,
						sourceName: artifact.sourceName,
						abi: artifact.abi,
					})),
					...abiSnapshots,
				],
				{ includeLocalOnly: false, outputsBytecodeProven: false },
			);
			return {
				abi: combinedAnalysis.matched.map(match => match.abi),
				source: {
					type: combinedAnalysis.status === "complete" ? "combined-selector-match" : "selector-resolution-incomplete",
					runtimeBytecodeMatch: false,
					...(explorerFailure ? { explorerFailure } : {}),
					warning:
						combinedAnalysis.status === "complete"
							? "Installed selectors were resolved across multiple ABI sources; return types are source-derived."
							: `${combinedAnalysis.unmatched.length} selector(s) are unmatched and ${combinedAnalysis.ambiguous.length} selector(s) are ambiguous.`,
				},
				selectorAnalysis: combinedAnalysis,
			};
		},
		(address, _index, result) => {
			completed += 1;
			console.log(`[${completed}/${addresses.length}] resolved ABI for ${address} (${result.source.type})`);
		},
	);
	const fetchedByAddress = new Map(addresses.map((address, index) => [address.toLowerCase(), fetched[index]]));
	const diamondFetched = fetchedByAddress.get(config.diamondAddress.toLowerCase());
	const facetResolutions = liveFacets.map(facet => {
		const resolved = fetchedByAddress.get(facet.address.toLowerCase());
		const resolution = analyzeResolvedAbi(facet.functionSelectors, resolved, { facetAddress: facet.address });
		return { facet, resolved, ...resolution };
	});
	const selectorVerification = combineSelectorReports(facetResolutions.map(resolution => resolution.report));
	const complete = selectorVerification.status === "complete";
	const merged = complete ? mergeLiveFacetAbis(liveFacets, fetchedByAddress, diamondFetched?.abi) : undefined;
	const abi = complete ? merged.abi : facetResolutions.flatMap(resolution => resolution.analysis.matched.map(match => match.abi));
	const facets = complete
		? merged.facets
		: facetResolutions.map(resolution => ({
				address: resolution.facet.address,
				abiSource: resolution.resolved.source,
				fetchedAbiEntries: resolution.resolved.abi.length,
				functions: resolution.analysis.matched.map(({ selector, signature }) => ({ selector, signature })),
				unmatchedSelectors: resolution.analysis.unmatched.map(item => item.selector),
				ambiguousSelectors: resolution.analysis.ambiguous.map(item => item.selector),
			}));
	const warnings = [
		...(diamondFetched?.source.warning ? [diamondFetched.source.warning] : []),
		...facetResolutions.flatMap(resolution => (resolution.resolved.source.warning ? [resolution.resolved.source.warning] : [])),
		...(proxy?.warnings ?? []),
	];

	const generatedAt = new Date().toISOString();
	const outputDirectory = path.resolve(config.outputDirectory);
	const baseReport = {
		schemaVersion: 1,
		generatedAt,
		status: complete ? "complete" : "incomplete",
		chain: {
			name: config.name,
			chainId,
			rpcSource: rpc.source,
		},
		targetLabel: config.diamondLabel,
		targetType: proxy ? "diamond-proxy" : "diamond",
		targetAddress: getAddress(config.diamondAddress),
		...(proxy ? { runtimeAddress: proxy.runtimeAddress, proxy } : {}),
		diamondLabel: config.diamondLabel,
		diamondAddress: getAddress(config.diamondAddress),
		blockNumber,
		facetCount: liveFacets.length,
		runtimeCodeHash: keccak256(diamondCode),
		selectorSource: "diamond-loupe",
		selectorCount,
		selectorVerification,
		abiEntryCounts: countAbiEntries(abi),
		diamondAbiSource: diamondFetched?.source,
		diamondEdgeEntryCount: merged?.diamondEdgeEntryCount ?? 0,
		warnings,
		facets,
	};

	console.log(
		`Selectors: ${selectorVerification.matched.length} matched, ${selectorVerification.unmatched.length} unmatched, ${selectorVerification.ambiguous.length} ambiguous`,
	);
	if (complete) {
		const outputs = await writeCompleteOutputs(outputDirectory, abi, baseReport, baseReport);
		console.log(`ABI:      ${outputs.abiFile}`);
		console.log(`Manifest: ${outputs.manifestFile}`);
		console.log(`Report:   ${outputs.reportFile}`);
		console.log(`SHA-256:  ${outputs.abiSha256}`);
		return { ...outputs, complete, manifest: { ...baseReport, abiSha256: outputs.abiSha256 }, abi };
	}

	const outputs = await writePartialOutputs(outputDirectory, abi, baseReport);
	console.log(`Partial:  ${outputs.partialAbiFile}`);
	console.log(`Report:   ${outputs.reportFile}`);
	return { ...outputs, complete, report: baseReport, abi };
}

export async function exportAbiTarget(config, options = {}) {
	const provider = options.provider ?? new JsonRpcProvider((options.rpc ?? resolveRpcUrl(config, options.environment)).url);
	const blockNumber = options.blockNumber ?? (await provider.getBlockNumber());
	const targetCode = await provider.getCode(config.targetAddress, blockNumber);
	if (targetCode === "0x") {
		throw new Error(`no contract code at target ${config.targetLabel} (${config.targetAddress}) at block ${blockNumber}`);
	}
	const proxyResolution = await resolveProxyRuntime(provider, config.targetAddress, blockNumber, { targetCode });
	const liveFacets = await detectDiamondFacets(provider, config.targetAddress, blockNumber);
	if (liveFacets) {
		return exportDiamondAbi(
			{
				...config,
				diamondLabel: config.targetLabel,
				diamondAddress: config.targetAddress,
				proxyResolution,
			},
			{
				...options,
				provider,
				blockNumber,
				liveFacets,
			},
		);
	}
	return exportContractAbi(
		{
			...config,
			runtimeAddress: proxyResolution.runtimeAddress,
			proxyResolution,
		},
		{
			...options,
			provider,
			blockNumber,
			runtimeCode: proxyResolution.runtimeCode,
		},
	);
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

	const targetResults = [];
	for (const target of selectedTargets) {
		const result = await exportAbiTarget(
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
		targetResults.push({ label: target.label, result });
	}
	assertCompleteTargetResults(targetResults);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
	main().catch(error => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Diamond ABI export failed: ${message}`);
		process.exitCode = Number.isSafeInteger(error?.exitCode) ? error.exitCode : 1;
	});
}
