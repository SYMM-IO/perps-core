#!/usr/bin/env node
// preinstall guard: refuse to build a dependency tree with the wrong package manager.
//
// utils/pinned-yarn.sh only protects the invocations that go through it. A plain
// `npm install` or a Corepack-redirected `yarn` bypasses it entirely — and that is the exact
// failure it exists to prevent, because this project resolves from a Yarn Classic v1
// yarn.lock. A tree installed by Berry or npm is not the tree that was reviewed, and this
// repo's tooling signs mainnet transactions.
//
// Node builtins only: preinstall runs before node_modules exists.

const EXPECTED = "1.22.22";
const OVERRIDE = "SYMMIO_ALLOW_ANY_PACKAGE_MANAGER";

/** yarn 1 reports e.g. "yarn/1.22.22 npm/? node/v22.15.0 darwin arm64"; npm reports "npm/10.8.2 ...". */
function detect(userAgent) {
	if (typeof userAgent !== "string" || userAgent.trim() === "") return null;
	const match = /^([a-z]+)\/(\S+)/i.exec(userAgent.trim());
	if (!match) return null;
	return { name: match[1].toLowerCase(), version: match[2] };
}

function fail(lines) {
	console.error("");
	console.error("  This checkout requires Yarn Classic " + EXPECTED + ".");
	console.error("");
	for (const line of lines) console.error("  " + line);
	console.error("");
	console.error("  Enable the pin from package.json:");
	console.error("    corepack enable && corepack prepare yarn@" + EXPECTED + " --activate");
	console.error("");
	console.error("  Then install through the guarded wrapper:");
	console.error("    ./utils/pinned-yarn.sh install --frozen-lockfile");
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
	fail([`Detected ${agent.name} ${agent.version}, which does not honour this project's Yarn v1 lockfile.`]);
}

if (agent.version !== EXPECTED) {
	fail([
		`Detected yarn ${agent.version}.`,
		agent.version.startsWith("1.")
			? "That is a different Yarn Classic patch than the pinned one."
			: "Yarn Berry resolves this v1 lockfile differently and would produce a different tree.",
	]);
}
