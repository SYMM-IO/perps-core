// The CLI is plain JS (no build step), so it cannot import tasks/deploy/safety.ts
// directly. These constants are therefore duplicated — and duplication drifts, so
// checkMirrorDrift() parses the TypeScript source at runtime and reports any mismatch.
// `symmio doctor` runs it, which means the tool polices its own copy.
import { projectPath } from "./paths.js";
import fs from "node:fs";

const SAFETY_TS = projectPath("tasks", "deploy", "safety.ts");

export const KNOWN_MAINNET_CHAIN_IDS = new Set([1, 56, 137, 146, 204, 999, 1101, 1329, 5000, 8453, 8822, 9745, 34443, 42161, 80094, 81457, 2632500]);

export const UNSAFE_DEPLOYERS = new Map([
	["0x57331e7ca8ef2b0c8dfaa1f0760912509fe2d46d", "DUMMY_PRIVATE_KEY committed in hardhat.config.ts"],
	["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", "well-known Hardhat test account #0"],
]);

/**
 * Compare this file's copies against tasks/deploy/safety.ts.
 * @returns {{checked: boolean, problems: string[]}}
 */
export function checkMirrorDrift() {
	if (!fs.existsSync(SAFETY_TS)) {
		return { checked: false, problems: ["tasks/deploy/safety.ts not found — cannot verify the CLI's copy of the mainnet chain list"] };
	}

	const src = fs.readFileSync(SAFETY_TS, "utf8");
	const problems = [];

	const idsBlock = src.match(/KNOWN_MAINNET_CHAIN_IDS\s*=\s*new Set<number>\(\[([\s\S]*?)\]\)/);
	if (!idsBlock) {
		problems.push("could not parse KNOWN_MAINNET_CHAIN_IDS from safety.ts");
	} else {
		const ids = new Set(
			idsBlock[1]
				.split("\n")
				.map(l =>
					l
						.replace(/\/\/.*$/, "")
						.trim()
						.replace(/,$/, ""),
				)
				.filter(Boolean)
				.map(Number)
				.filter(n => Number.isFinite(n)),
		);
		const missing = [...ids].filter(i => !KNOWN_MAINNET_CHAIN_IDS.has(i));
		const extra = [...KNOWN_MAINNET_CHAIN_IDS].filter(i => !ids.has(i));
		if (missing.length) problems.push(`safety.ts has mainnet chainIds the CLI does not: ${missing.join(", ")}`);
		if (extra.length) problems.push(`the CLI has mainnet chainIds safety.ts does not: ${extra.join(", ")}`);
	}

	const addrs = [...src.matchAll(/\["(0x[0-9a-fA-F]{40})",\s*"/g)].map(m => m[1].toLowerCase());
	const missingAddrs = addrs.filter(a => !UNSAFE_DEPLOYERS.has(a));
	if (missingAddrs.length) problems.push(`safety.ts blocks deployer addresses the CLI does not: ${missingAddrs.join(", ")}`);

	return { checked: true, problems };
}
