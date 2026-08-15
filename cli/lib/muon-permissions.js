import { projectPath } from "./paths.js";
import fs from "node:fs";

// JavaScript mirror of the Solidity MuonFunction enum. The deployment CLI has no build
// step, so it cannot import tasks/deploy/muonPermissions.ts directly.
export const MUON_FUNCTIONS = [
	{ name: "Trading", index: 0 },
	{ name: "AccountManagement", index: 1 },
	{ name: "Settlement", index: 2 },
	{ name: "ForceClose", index: 3 },
	{ name: "Funding", index: 4 },
	{ name: "LiquidationPartyA", index: 5 },
	{ name: "LiquidationPartyB", index: 6 },
	{ name: "RemoveMargin", index: 7 },
];

export const MUON_FUNCTION_NAMES = MUON_FUNCTIONS.map(({ name }) => name);
const MUON_FUNCTION_BY_NAME = new Map(MUON_FUNCTIONS.map(definition => [definition.name, definition]));

/** Ensure a Solidity enum edit cannot silently stale the JavaScript preflight parser. */
export function checkMuonFunctionMirrorDrift() {
	const sourcePath = projectPath("contracts", "core", "interfaces", "IMuonSignatureVerifier.sol");
	try {
		const source = fs.readFileSync(sourcePath, "utf8");
		const match = source.match(/enum\s+MuonFunction\s*\{([\s\S]*?)\}/);
		if (!match) return { problems: [`could not locate MuonFunction in ${sourcePath}`] };
		const solidityNames = match[1]
			.replace(/\/\/.*$/gm, "")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.split(",")
			.map(value => value.trim())
			.filter(Boolean);
		if (JSON.stringify(solidityNames) !== JSON.stringify(MUON_FUNCTION_NAMES)) {
			return {
				problems: [`CLI MuonFunction mirror is stale: Solidity=[${solidityNames.join(",")}] CLI=[${MUON_FUNCTION_NAMES.join(",")}]`],
			};
		}
		return { problems: [] };
	} catch (error) {
		return { problems: [`could not verify MuonFunction mirror: ${error.message || error}`] };
	}
}

/** Parse the exact, complete permission profile required by a general deployment. */
export function parseMuonFunctionPermissions(rawValue, label = "MUON_FUNCTION_PERMISSIONS") {
	if (typeof rawValue !== "string" || rawValue.trim() === "") {
		throw new Error(`${label} must contain all MuonFunction names: ${MUON_FUNCTION_NAMES.join(",")}`);
	}

	const seen = new Set();
	const resolved = [];
	for (const [index, entry] of rawValue.split(",").entries()) {
		const name = entry.trim();
		if (name === "") throw new Error(`${label} contains an empty entry at position ${index + 1}`);
		const definition = MUON_FUNCTION_BY_NAME.get(name);
		if (!definition) {
			throw new Error(`unknown MuonFunction ${JSON.stringify(name)} in ${label}; valid values: ${MUON_FUNCTION_NAMES.join(",")}`);
		}
		if (seen.has(name)) throw new Error(`duplicate MuonFunction ${name} in ${label}`);
		seen.add(name);
		resolved.push(definition);
	}

	const missing = MUON_FUNCTION_NAMES.filter(name => !seen.has(name));
	if (missing.length) throw new Error(`${label} is incomplete; missing: ${missing.join(",")}`);
	return [...MUON_FUNCTIONS];
}

/**
 * Read every key/category and signer/category authorization. Any reverted read is an
 * exception: an unknown permission probe must never become a healthy verdict.
 */
export async function inspectMuonFunctionAuthorizations(reader, { publicKeys, gatewaySigners, permissions = MUON_FUNCTIONS }) {
	const missing = [];
	for (const publicKey of publicKeys) {
		for (const permission of permissions) {
			const authorized = await reader.isPublicKeyAuthorized(publicKey, permission.index);
			if (!authorized) {
				missing.push(`public key x=${String(publicKey.x)}, parity=${Number(publicKey.parity)}: ${permission.name}`);
			}
		}
	}
	for (const signer of gatewaySigners) {
		for (const permission of permissions) {
			const authorized = await reader.isGatewaySignerAuthorized(signer, permission.index);
			if (!authorized) missing.push(`gateway signer ${signer}: ${permission.name}`);
		}
	}
	return missing;
}

export function muonAuthorizationVerdict(missingAuthorizations, deployerCanRepair) {
	if (missingAuthorizations.length === 0) return "ok";
	return deployerCanRepair ? "repairable" : "blocked";
}
