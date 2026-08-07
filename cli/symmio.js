#!/usr/bin/env node
// symmio — operator CLI for deploying, configuring and inspecting SYMMIO deployments.
//
// Plain ESM JavaScript with no dependencies beyond what the repo already installs, and no
// build step: a tool that deploys money should never be runnable from a stale build, and
// the operator should always be able to read the exact source that just ran.
import { configurationHelpLines } from "./lib/config-guide.js";
import { blank, c, fatal, log } from "./lib/ui.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const BOOLEAN = "boolean";
const STRING = "string";

export const COMMANDS = {
	guide: {
		summary: "interactive: work out where you are and what to do next",
		usage: ["./symmio", "./symmio guide"],
		options: {},
		load: () => import("./commands/guide.js").then(m => m.guide),
	},
	doctor: {
		summary: "check everything that must be true before you deploy",
		usage: [
			"./symmio doctor --config deployments/<name>.json",
			"./symmio doctor --config deployments/<name>.json --only <component>",
			"./symmio doctor --network <network>  # compatibility mode",
		],
		helpLines: configurationHelpLines,
		options: { config: STRING, network: STRING, only: STRING },
		requireOneOf: [["config", "network"]],
		exclusive: [["config", "network"]],
		requires: [["only", "config"]],
		choices: { only: ["core", "partyB", "symbolManager", "expressProvider"] },
		load: () => import("./commands/doctor.js").then(m => m.doctor),
	},
	deploy: {
		summary: "guided deployment: preflight, plan, confirm, deploy, verify",
		usage: [
			"./symmio deploy --config deployments/<name>.json [--plan]",
			"./symmio deploy --config deployments/<name>.json --only <component>",
			"./symmio deploy --network <network>  # compatibility mode",
		],
		helpLines: configurationHelpLines,
		options: {
			config: STRING,
			network: STRING,
			only: STRING,
			plan: BOOLEAN,
			yes: BOOLEAN,
			fresh: BOOLEAN,
			"no-verify": BOOLEAN,
			force: BOOLEAN,
			"confirm-network": STRING,
		},
		requireOneOf: [["config", "network"]],
		exclusive: [["config", "network"]],
		requires: [
			["only", "config"],
			["plan", "config"],
		],
		choices: { only: ["core", "partyB", "symbolManager", "expressProvider"] },
		load: () => import("./commands/deploy.js").then(m => m.deploy),
	},
	recipe: {
		summary: "create a reviewed JSON deployment recipe",
		usage: [
			"./symmio recipe init --network <network> [--out <path>] [--force]",
			"./symmio recipe init --network <network> --only <partyB|symbolManager|expressProvider> [--out <path>]",
		],
		helpLines: configurationHelpLines,
		subcommands: {
			init: {
				options: { network: STRING, only: STRING, out: STRING, force: BOOLEAN },
				required: ["network"],
				choices: { only: ["partyB", "symbolManager", "expressProvider"] },
			},
		},
		load: () => import("./commands/recipe.js").then(m => m.recipe),
	},
	status: {
		summary: "what is deployed on a chain, and is it safe",
		usage: [
			"./symmio status --config deployments/<name>.json",
			"./symmio status --config deployments/<name>.json --only <partyB|symbolManager|expressProvider>",
			"./symmio status --network <network>  # compatibility mode",
		],
		helpLines: configurationHelpLines,
		options: { config: STRING, network: STRING, only: STRING, diamond: STRING, "account-layer": STRING, "instant-layer": STRING },
		requireOneOf: [["config", "network"]],
		exclusive: [["config", "network"]],
		requires: [["only", "config"]],
		choices: { only: ["partyB", "symbolManager", "expressProvider"] },
		load: () => import("./commands/status.js").then(m => m.status),
	},
	config: {
		summary: "show, diff or export protocol parameters and InstantLayer templates",
		usage: [
			"./symmio config show --chain <chainId>",
			"./symmio config diff --network <live> --symmio <addr> --instant-layer <addr> --against <chainId>",
			"./symmio config export --network <live> --symmio <addr> --instant-layer <addr> [--to <chainId>]",
		],
		defaultSubcommand: "show",
		subcommands: {
			show: {
				options: { chain: STRING, network: STRING },
				requireOneOf: [["chain", "network"]],
				exclusive: [["chain", "network"]],
			},
			diff: {
				options: { network: STRING, symmio: STRING, "instant-layer": STRING, against: STRING },
				required: ["network", "symmio", "instant-layer", "against"],
			},
			export: {
				options: { network: STRING, symmio: STRING, "instant-layer": STRING, to: STRING },
				required: ["network", "symmio", "instant-layer"],
			},
		},
		load: () => import("./commands/config.js").then(m => m.config),
	},
	verify: {
		summary: "verify deployed contracts on the block explorer",
		usage: [
			"./symmio verify --config deployments/<name>.json [--retry-failed]",
			"./symmio verify --network <network> [--retry-failed]  # compatibility mode",
		],
		helpLines: configurationHelpLines,
		options: { config: STRING, network: STRING, "retry-failed": BOOLEAN },
		requireOneOf: [["config", "network"]],
		exclusive: [["config", "network"]],
		load: () => import("./commands/verify.js").then(m => m.verify),
	},
};

function parseBoolean(value, flag) {
	if (value === undefined) return true;
	if (typeof value === "boolean") return value;
	if (String(value).toLowerCase() === "true") return true;
	if (String(value).toLowerCase() === "false") return false;
	throw new Error(`--${flag} expects true or false`);
}

function validateSchema(schema, args) {
	if (args.help === true) return;
	for (const name of schema.required ?? []) {
		if (args[name] === undefined || args[name] === "") throw new Error(`--${name} is required`);
	}
	for (const group of schema.requireOneOf ?? []) {
		if (!group.some(name => args[name] !== undefined && args[name] !== "")) {
			throw new Error(`one of ${group.map(name => `--${name}`).join(" or ")} is required`);
		}
	}
	for (const group of schema.exclusive ?? []) {
		const present = group.filter(name => args[name] !== undefined);
		if (present.length > 1) throw new Error(`${present.map(name => `--${name}`).join(" and ")} cannot be used together`);
	}
	for (const [name, dependency] of schema.requires ?? []) {
		if (args[name] !== undefined && args[dependency] === undefined) {
			throw new Error(`--${name} requires --${dependency}`);
		}
	}
	for (const [name, allowed] of Object.entries(schema.choices ?? {})) {
		if (args[name] !== undefined && !allowed.includes(args[name])) {
			throw new Error(`--${name} must be one of: ${allowed.join(", ")}`);
		}
	}
}

/** Strict parser for the public CLI surface. Exported so its contract is unit-testable. */
export function parseArgs(argv) {
	if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
	if (argv.length === 0) return { _: [] };

	if (argv[0] === "--help" || argv[0] === "-h") {
		if (argv.length > 1) throw new Error(`unexpected positional argument "${argv[1]}"`);
		return { _: [], help: true };
	}

	if (argv[0] === "help") {
		if (argv.length > 2) throw new Error(`unexpected positional argument "${argv[2]}"`);
		if (argv[1] && !COMMANDS[argv[1]]) throw new Error(`unknown command "${argv[1]}"`);
		return { _: argv.slice() };
	}

	const name = argv[0];
	if (name.startsWith("-")) throw new Error(`unknown global option "${name}"`);
	const command = COMMANDS[name];
	if (!command) throw new Error(`unknown command "${name}"`);

	const args = { _: [name] };
	let index = 1;
	let schema = command;

	if (command.subcommands) {
		let subcommand = command.defaultSubcommand;
		const candidate = argv[index];
		if (candidate !== undefined && !candidate.startsWith("-")) {
			if (!command.subcommands[candidate]) {
				throw new Error(`unknown ${name} subcommand "${candidate}"`);
			}
			subcommand = candidate;
			args._.push(candidate);
			index++;
		}
		if (!subcommand) {
			if (candidate === "--help" || candidate === "-h") schema = { options: {} };
			else throw new Error(`${name} requires a subcommand (${Object.keys(command.subcommands).join(", ")})`);
		} else {
			schema = command.subcommands[subcommand];
		}
	}

	const options = { ...(schema.options ?? {}), help: BOOLEAN };
	for (; index < argv.length; index++) {
		const token = argv[index];
		if (!token.startsWith("--") && token !== "-h") {
			throw new Error(`unexpected positional argument "${token}" for ${name}`);
		}

		const body = token === "-h" ? "help" : token.slice(2);
		const eq = body.indexOf("=");
		const key = eq === -1 ? body : body.slice(0, eq);
		const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
		const type = options[key];
		if (!type) throw new Error(`unknown option --${key} for ${name}`);
		if (Object.prototype.hasOwnProperty.call(args, key)) throw new Error(`option --${key} was provided more than once`);

		if (type === BOOLEAN) {
			let value = inlineValue;
			if (value === undefined) {
				const next = argv[index + 1];
				if (next !== undefined && /^(?:true|false)$/i.test(next)) {
					value = next;
					index++;
				}
			}
			args[key] = parseBoolean(value, key);
			continue;
		}

		let value = inlineValue;
		if (value === undefined) {
			value = argv[index + 1];
			if (value === undefined || value.startsWith("-")) throw new Error(`--${key} requires a value`);
			index++;
		}
		if (value === "") throw new Error(`--${key} requires a non-empty value`);
		args[key] = value;
	}

	validateSchema(schema, args);
	return args;
}

function help() {
	blank();
	log(`  ${c.bold("symmio")} ${c.grey("— operator CLI for SYMMIO deployments")}`);
	blank();
	log(`  ${c.bold("Usage")}`);
	log(`    ./symmio                    ${c.grey("interactive — figures out your next step")}`);
	log(`    ./symmio <command> [options]`);
	blank();
	log(`  ${c.bold("Commands")}`);
	const width = Math.max(...Object.keys(COMMANDS).map(k => k.length));
	for (const [name, cmd] of Object.entries(COMMANDS)) {
		log(`    ${c.cyan(name.padEnd(width))}  ${cmd.summary}`);
	}
	blank();
	log(`  ${c.bold("Getting started")}`);
	log(`    ${c.grey("Run")} ${c.cyan("./symmio")} ${c.grey("with no arguments and it will walk you through it.")}`);
	blank();
	log(`  ${c.bold("Or step by step")}`);
	log(`    ${c.grey("1.")} ./symmio recipe init --network arbitrum`);
	log(`    ${c.grey("2.")} edit deployments/arbitrum.json`);
	log(`    ${c.grey("3.")} ./symmio doctor --config deployments/arbitrum.json`);
	log(`    ${c.grey("4.")} ./symmio deploy --config deployments/arbitrum.json --plan`);
	log(`    ${c.grey("5.")} ./symmio deploy --config deployments/arbitrum.json`);
	blank();
	log(`  ${c.grey("Optional: run `./utils/pinned-yarn.sh link` once if you want the global `symmio` command.")}`);
	log(`  ${c.grey("./symmio <command> --help  shows command details.")}`);
	blank();
}

function commandHelp(name, cmd) {
	blank();
	log(`  ${c.bold("symmio " + name)} ${c.grey("— " + cmd.summary)}`);
	blank();
	for (const line of [].concat(cmd.usage)) log(`    ${c.cyan(line)}`);
	if (cmd.helpLines) {
		blank();
		for (const line of cmd.helpLines()) log(line ? `  ${line}` : "");
	}
	blank();
}

export async function runCli(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	const name = args._[0];

	// A bare `./symmio` on a terminal starts the interactive guide: an operator should be able
	// to run the tool and be led forward, not have to remember a command first. Without a TTY
	// (CI, pipes, `symmio | less`) it stays the printed help it has always been.
	if (!name && args.help !== true && process.stdin.isTTY) {
		const run = await COMMANDS.guide.load();
		return (await run(args)) ?? 0;
	}

	if (!name || name === "help" || args.help === true) {
		if (name && name !== "help") {
			commandHelp(name, COMMANDS[name]);
			return 0;
		}
		if (args._[1] && COMMANDS[args._[1]]) {
			commandHelp(args._[1], COMMANDS[args._[1]]);
			return 0;
		}
		help();
		return 0;
	}

	const cmd = COMMANDS[name];
	const run = await cmd.load();
	return (await run(args)) ?? 0;
}

function isMainModule() {
	if (!process.argv[1]) return false;
	try {
		return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isMainModule()) {
	runCli()
		.then(code => {
			process.exitCode = code;
		})
		.catch(err => {
			fatal(err.message || String(err), err.stack && process.env.SYMMIO_DEBUG ? err.stack : "set SYMMIO_DEBUG=1 for a stack trace");
		});
}
