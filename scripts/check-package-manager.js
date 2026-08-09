#!/usr/bin/env node
// preinstall guard: refuse to build a dependency tree with the wrong package manager.
//
// This project resolves from a committed package-lock.json. Yarn and pnpm ignore that file
// and resolve their own tree from the semver ranges, so what you would end up running is not
// what was reviewed — and this repo's tooling signs mainnet transactions.
//
// No npm version is pinned. Any npm reads the lockfile correctly, and pinning one only
// creates onboarding friction for no safety gain. Use `npm ci` for an exact, immutable
// install; `npm install` is fine for day-to-day work.
//
// Node builtins only: preinstall runs before node_modules exists.

const OVERRIDE = "SYMMIO_ALLOW_ANY_PACKAGE_MANAGER";

/** npm reports e.g. "npm/11.11.0 node/v22.15.0 darwin arm64"; yarn reports "yarn/4.13.0 ...". */
function detect(userAgent) {
	if (typeof userAgent !== "string" || userAgent.trim() === "") return null;
	const match = /^([a-z]+)\/(\S+)/i.exec(userAgent.trim());
	if (!match) return null;
	return { name: match[1].toLowerCase(), version: match[2] };
}

if (process.env[OVERRIDE] === "1") {
	console.error(`check-package-manager: ${OVERRIDE}=1 set — skipping the package-manager check.`);
	process.exit(0);
}

const agent = detect(process.env.npm_config_user_agent);

// No agent means we cannot positively identify a wrong manager (someone ran this script
// directly, or an unusual harness). Refusing here would block installs for no proven reason.
if (agent === null) process.exit(0);

if (agent.name !== "npm") {
	console.error("");
	console.error("  This checkout uses npm.");
	console.error("");
	console.error(`  Detected ${agent.name} ${agent.version}, which ignores package-lock.json and would`);
	console.error("  resolve a different dependency tree than the one that was reviewed.");
	console.error("");
	console.error("  Install with:");
	console.error("    npm install");
	console.error("");
	console.error("  To bypass deliberately (not for a deployment checkout):");
	console.error(`    ${OVERRIDE}=1 <your command>`);
	console.error("");
	process.exit(1);
}
