#!/usr/bin/env node
// Install guard: refuse to build a dependency tree with the wrong package manager.
//
// utils/pinned-yarn.sh only protects the invocations that go through it. A plain
// `npm install` or a Corepack-redirected `yarn` bypasses it entirely — and that is the exact
// failure it exists to prevent, because this project resolves from a committed yarn.lock.
// A tree installed by a different package manager is not the tree that was reviewed, and
// this repo's tooling signs mainnet transactions.
//
// Wired into BOTH preinstall and postinstall, because the two managers reach it differently:
//
//   npm/pnpm  run preinstall, so they fail here before any tree is written. This is the
//             case that matters most, and it still fails early.
//   yarn 4    does not run a root-workspace preinstall at all. It does run postinstall, so
//             a wrong Yarn release is caught there — after the tree exists, which is later
//             than ideal but still loud. Corepack plus the packageManager field is what
//             makes that case unlikely in the first place; this is the backstop.
//
// Node builtins only: at preinstall there is no node_modules yet.

const EXPECTED = "4.13.0";
const OVERRIDE = "SYMMIO_ALLOW_ANY_PACKAGE_MANAGER";

/** yarn reports e.g. "yarn/4.13.0 npm/? node/v22.15.0 darwin arm64"; npm reports "npm/10.8.2 ...". */
function detect(userAgent) {
	if (typeof userAgent !== "string" || userAgent.trim() === "") return null;
	const match = /^([a-z]+)\/(\S+)/i.exec(userAgent.trim());
	if (!match) return null;
	return { name: match[1].toLowerCase(), version: match[2] };
}

function fail(lines) {
	console.error("");
	console.error("  This checkout requires Yarn " + EXPECTED + ".");
	console.error("");
	for (const line of lines) console.error("  " + line);
	console.error("");
	console.error("  Enable the pin from package.json:");
	console.error("    corepack enable && corepack prepare yarn@" + EXPECTED + " --activate");
	console.error("");
	console.error("  Then install through the guarded wrapper:");
	console.error("    ./utils/pinned-yarn.sh install --immutable");
	console.error("");
	console.error("  To bypass deliberately (not for a deployment checkout):");
	console.error("    " + OVERRIDE + "=1 <your command>");
	console.error("");
	process.exit(1);
}

if (process.env[OVERRIDE] === "1") {
	console.error(`check-package-manager: ${OVERRIDE}=1 set — skipping the package-manager pin check.`);
	process.exit(0);
}

const agent = detect(process.env.npm_config_user_agent);

// No agent means we cannot positively identify a wrong manager (someone ran this script
// directly, or an unusual harness). Refusing here would block installs for no proven reason.
if (agent === null) process.exit(0);

if (agent.name !== "yarn") {
	fail([`Detected ${agent.name} ${agent.version}, which does not honour this project's yarn.lock.`]);
}

if (agent.version !== EXPECTED) {
	fail([
		`Detected yarn ${agent.version}.`,
		agent.version.startsWith("1.")
			? "Yarn Classic cannot read this checkout's lockfile format and would rewrite it."
			: "That is a different Yarn release than the pinned one and may resolve a different tree.",
	]);
}
