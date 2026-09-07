#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function scanDirectories(directoryName) {
	const subdirectories = fs
		.readdirSync(directoryName, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => path.join(directoryName, entry.name));

	return subdirectories.flatMap(directory => [directory, ...scanDirectories(directory)]);
}

function normalizeAbiTypes(item) {
	if (Array.isArray(item)) return item.map(normalizeAbiTypes);
	if (item === null || typeof item !== "object") return item;

	return Object.fromEntries(
		Object.entries(item).map(([key, value]) => {
			if (key === "type" && item.internalType?.startsWith("enum ")) return [key, "uint8"];
			return [key, normalizeAbiTypes(value)];
		}),
	);
}

function getAbiSignature(item) {
	const inputs = item.inputs ? `(${item.inputs.map(input => input.type ?? "").join(",")})` : "";
	return `${item.type ?? ""}${item.name ?? ""}${inputs}`;
}

function removeDuplicates(abi) {
	const seen = new Set();
	return abi.filter(item => {
		const signature = getAbiSignature(item);
		if (seen.has(signature)) return false;
		seen.add(signature);
		return true;
	});
}

function writeAbi(outputName, abi) {
	fs.writeFileSync(path.join("abis", `${outputName}.json`), JSON.stringify(abi, null, 4));
	console.log(`Generated abis/${outputName}.json`);
}

function generateDiamondAbi(subdirectories, outputName) {
	const abi = [];

	for (const subdirectory of subdirectories) {
		const directoryPath = path.join("artifacts", "contracts", subdirectory);
		if (!fs.existsSync(directoryPath)) {
			console.log(`Directory ${directoryPath} does not exist. Skipping.`);
			continue;
		}

		for (const directory of [directoryPath, ...scanDirectories(directoryPath)]) {
			console.log(`Checking ${directory}`);
			const files = fs.readdirSync(directory).filter(file => file.endsWith(".json") && !file.endsWith(".dbg.json"));

			for (const file of files) {
				const artifact = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
				if (artifact.abi) abi.push(...normalizeAbiTypes(artifact.abi));
			}
		}
	}

	writeAbi(outputName, removeDuplicates(abi));
}

function generateSingleContractAbi(contractPath, contractName, outputName) {
	const artifactPath = path.join("artifacts", "contracts", contractPath, `${contractName}.json`);
	if (!fs.existsSync(artifactPath)) {
		console.log(`Artifact ${artifactPath} does not exist. Skipping ${contractName}.`);
		return;
	}

	const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
	if (!artifact.abi) {
		console.log(`No ABI found in ${artifactPath}`);
		return;
	}

	writeAbi(outputName, normalizeAbiTypes(artifact.abi));
}

fs.mkdirSync("abis", { recursive: true });

console.log("\n=== Generating Symmio ABI ===");
generateDiamondAbi(["core/facets", "core/libraries", "core/utils", "core/storages"], "symmio");

console.log("\n=== Generating AccountLayer ABI ===");
generateDiamondAbi(["accountLayer/facets", "accountLayer/libraries", "accountLayer/utils", "accountLayer/storages"], "accountLayer");

console.log("\n=== Generating ExpressProvider ABI ===");
generateDiamondAbi(
	["expressWithdrawLayer/facets", "expressWithdrawLayer/libraries", "expressWithdrawLayer/utils", "expressWithdrawLayer/storages"],
	"expressProvider",
);

const standaloneContracts = [
	["helpers/accounts/SymmioPartyB.sol", "SymmioPartyB", "partyB"],
	["instantLayer/InstantLayer.sol", "InstantLayer", "instantLayer"],
	["accountLayer/AccountManager.sol", "AccountManager", "accountManager"],
	["helpers/accounts/MultiAccount.sol", "MultiAccount", "multiAccount"],
	["gaslessLayer/GaslessLayer.sol", "GaslessLayer", "gaslessLayer"],
	["gaslessLayer/GaslessWallet.sol", "GaslessWallet", "gaslessLayerWallet"],
];

for (const [contractPath, contractName, outputName] of standaloneContracts) {
	console.log(`\n=== Generating ${contractName} ABI ===`);
	generateSingleContractAbi(contractPath, contractName, outputName);
}
