import { parseArgs, runCli } from "../symmio.js";
import assert from "node:assert/strict";
import test from "node:test";

test("boolean flags preserve explicit false values", () => {
	const args = parseArgs(["deploy", "--network", "arbitrum", "--fresh=false", "--yes", "false", "--force=false", "--no-verify=false"]);

	assert.equal(args.fresh, false);
	assert.equal(args.yes, false);
	assert.equal(args.force, false);
	assert.equal(args["no-verify"], false);
});

test("bare boolean flags are true", () => {
	const args = parseArgs(["deploy", "--config", "deployments/local.json", "--fresh", "--yes", "--plan"]);
	assert.equal(args.fresh, true);
	assert.equal(args.yes, true);
	assert.equal(args.plan, true);
});

test("recipe-first commands accept exactly one configuration source", () => {
	for (const command of ["doctor", "deploy", "status", "verify"]) {
		assert.equal(parseArgs([command, "--config", "deployments/arbitrum.json"]).config, "deployments/arbitrum.json");
		assert.throws(() => parseArgs([command]), /one of --config or --network is required/);
		assert.throws(
			() => parseArgs([command, "--config", "deployments/arbitrum.json", "--network", "base"]),
			/--config and --network cannot be used together/,
		);
	}
});

test("deploy component selection and read-only plan require a recipe", () => {
	assert.equal(parseArgs(["deploy", "--config", "deployments/a.json", "--only", "partyB"]).only, "partyB");
	assert.equal(parseArgs(["deploy", "--config", "deployments/a.json", "--plan"]).plan, true);
	assert.throws(() => parseArgs(["deploy", "--network", "arbitrum", "--only", "partyB"]), /--only requires --config/);
	assert.throws(() => parseArgs(["deploy", "--network", "arbitrum", "--plan"]), /--plan requires --config/);
	assert.throws(
		() => parseArgs(["deploy", "--config", "deployments/a.json", "--only", "instantLayer"]),
		/--only must be one of: core, partyB, symbolManager, expressProvider/,
	);
});

test("doctor can preflight the same partial component selection as deploy", () => {
	assert.equal(parseArgs(["doctor", "--config", "deployments/a.json", "--only", "symbolManager"]).only, "symbolManager");
	assert.throws(() => parseArgs(["doctor", "--network", "arbitrum", "--only", "partyB"]), /--only requires --config/);
	assert.throws(() => parseArgs(["doctor", "--config", "deployments/a.json", "--only", "instantLayer"]), /--only must be one of/);
});

test("status component selection requires a JSON recipe and supports only deployed add-ons", () => {
	assert.equal(parseArgs(["status", "--config", "deployments/a.json", "--only", "partyB"]).only, "partyB");
	assert.equal(parseArgs(["status", "--config", "deployments/a.json", "--only", "symbolManager"]).only, "symbolManager");
	assert.equal(parseArgs(["status", "--config", "deployments/a.json", "--only", "expressProvider"]).only, "expressProvider");
	assert.throws(() => parseArgs(["status", "--network", "arbitrum", "--only", "partyB"]), /--only requires --config/);
	// Core is a system bundle, so it is never a standalone status target.
	assert.throws(() => parseArgs(["status", "--config", "deployments/a.json", "--only", "core"]), /--only must be one of/);
	assert.throws(() => parseArgs(["status", "--config", "deployments/a.json", "--only", "nope"]), /--only must be one of/);
});

test("recipe init has an explicit subcommand and output controls", () => {
	assert.deepEqual(parseArgs(["recipe", "init", "--network", "arbitrum", "--out", "deployments/prod.json", "--force"]), {
		_: ["recipe", "init"],
		network: "arbitrum",
		out: "deployments/prod.json",
		force: true,
	});
	assert.deepEqual(parseArgs(["recipe", "init", "--network", "arbitrum", "--only", "partyB"]), {
		_: ["recipe", "init"],
		network: "arbitrum",
		only: "partyB",
	});
	assert.deepEqual(parseArgs(["recipe", "init", "--network", "arbitrum", "--only", "expressProvider"]), {
		_: ["recipe", "init"],
		network: "arbitrum",
		only: "expressProvider",
	});
	assert.throws(() => parseArgs(["recipe", "init", "--network", "arbitrum", "--only", "core"]), /must be one of/);
	assert.throws(() => parseArgs(["recipe"]), /recipe requires a subcommand \(init\)/);
});

test("unknown flags, duplicate flags, and extra positionals are rejected", () => {
	assert.throws(() => parseArgs(["doctor", "--network", "arbitrum", "--netwrok", "arbitrum"]), /unknown option --netwrok/);
	assert.throws(() => parseArgs(["doctor", "--network", "arbitrum", "--network", "base"]), /provided more than once/);
	assert.throws(() => parseArgs(["status", "--network", "arbitrum", "extra"]), /unexpected positional argument/);
	assert.throws(() => parseArgs(["config", "unknown", "--network", "arbitrum"]), /unknown config subcommand/);
	assert.throws(() => parseArgs(["deploy", "--network", "arbitrum", "--fresh=maybe"]), /expects true or false/);
});

test("command schemas reject missing and cross-command options", () => {
	assert.throws(() => parseArgs(["verify"]), /one of --config or --network is required/);
	assert.throws(() => parseArgs(["doctor", "--network", "arbitrum", "--yes"]), /unknown option --yes/);
	assert.throws(() => parseArgs(["config", "show", "--chain", "42161", "--network", "arbitrum"]), /cannot be used together/);
	assert.throws(
		() => parseArgs(["config", "diff", "--network", "arbitrum", "--symmio", "0x1", "--against", "42161"]),
		/--instant-layer is required/,
	);
	assert.throws(() => parseArgs(["config", "export", "--network", "arbitrum", "--symmio", "0x1"]), /--instant-layer is required/);
});

test("runner is import-safe and can render root help", async () => {
	const original = console.log;
	console.log = () => {};
	try {
		assert.equal(await runCli([]), 0);
	} finally {
		console.log = original;
	}
});

test("doctor help tells a first-time operator where every configuration class lives", async () => {
	const output = [];
	const original = console.log;
	console.log = (...values) => output.push(values.join(" "));
	try {
		assert.equal(await runCli(["doctor", "--help"]), 0);
	} finally {
		console.log = original;
	}

	const rendered = output.join("\n");
	assert.match(rendered, /JSON recipe \(recommended\)/);
	assert.match(rendered, /deployment\/examples\/arbitrum\.v1\.example\.json/);
	assert.match(rendered, /deployments\/<name>\.json/);
	assert.match(rendered, /tasks\/data\/<chainId>\/deployment-report\.json/);
	assert.match(rendered, /\.\/symmio doctor --config deployments\/arbitrum\.json/);
	assert.doesNotMatch(rendered, /\.env/);
});

test("root help does not assume the global binary is linked", async () => {
	const output = [];
	const original = console.log;
	console.log = (...values) => output.push(values.join(" "));
	try {
		assert.equal(await runCli([]), 0);
	} finally {
		console.log = original;
	}
	const rendered = output.join("\n");
	assert.match(rendered, /\.\/symmio recipe init/);
	assert.match(rendered, /pinned-yarn\.sh link/);
});

test("every command help example is checkout-local unless the optional link is used", async () => {
	for (const command of Object.keys((await import("../symmio.js")).COMMANDS)) {
		const output = [];
		const original = console.log;
		console.log = (...values) => output.push(values.join(" "));
		try {
			assert.equal(await runCli([command, "--help"]), 0);
		} finally {
			console.log = original;
		}
		const commandLines = output
			.join("\n")
			.split("\n")
			.filter(line => line.startsWith("    symmio "));
		assert.deepEqual(commandLines, [], `${command} help contains an unlinked bare symmio command`);
	}
});
