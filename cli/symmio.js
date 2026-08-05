#!/usr/bin/env node
// symmio — operator CLI for deploying, configuring and inspecting SYMMIO deployments.
//
// Plain ESM JavaScript with no dependencies beyond what the repo already installs, and no
// build step: a tool that deploys money should never be runnable from a stale build, and
// the operator should always be able to read the exact source that just ran.

import { blank, c, fatal, log } from "./lib/ui.js"

const COMMANDS = {
	doctor: {
		summary: "check everything that must be true before you deploy",
		usage: "symmio doctor --network <network>",
		load: () => import("./commands/doctor.js").then(m => m.doctor),
	},
	deploy: {
		summary: "guided deployment: preflight, plan, confirm, deploy, verify",
		usage: "symmio deploy --network <network> [--yes] [--fresh] [--no-verify] [--force]",
		load: () => import("./commands/deploy.js").then(m => m.deploy),
	},
	status: {
		summary: "what is deployed on a chain, and is it safe",
		usage: "symmio status --network <network> [--diamond <address>] [--instant-layer <address>]",
		load: () => import("./commands/status.js").then(m => m.status),
	},
	config: {
		summary: "show, diff or export protocol parameters and InstantLayer templates",
		usage: [
			"symmio config show --chain <chainId>",
			"symmio config diff --network <live> --symmio <addr> [--instant-layer <addr>] --against <chainId>",
			"symmio config export --network <live> --symmio <addr> [--instant-layer <addr>] [--to <chainId>]",
		],
		load: () => import("./commands/config.js").then(m => m.config),
	},
	verify: {
		summary: "verify deployed contracts on the block explorer",
		usage: "symmio verify --network <network> [--retry-failed]",
		load: () =>
			import("./lib/hardhat.js").then(m => async args => {
				const a = ["verify:all", "--network", args.network]
				if (args["retry-failed"]) a.push("--retry-failed")
				return m.hardhat(a)
			}),
	},
}

/** Minimal argv parser: --flag, --key value, --key=value, positionals in `_`. */
function parseArgs(argv) {
	const args = { _: [] }
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i]
		if (!token.startsWith("--")) {
			args._.push(token)
			continue
		}
		const body = token.slice(2)
		const eq = body.indexOf("=")
		if (eq !== -1) {
			args[body.slice(0, eq)] = body.slice(eq + 1)
			continue
		}
		const next = argv[i + 1]
		if (next === undefined || next.startsWith("--")) {
			args[body] = true
		} else {
			args[body] = next
			i++
		}
	}
	return args
}

function help() {
	blank()
	log(`  ${c.bold("symmio")} ${c.grey("— operator CLI for SYMMIO deployments")}`)
	blank()
	log(`  ${c.bold("Usage")}`)
	log(`    symmio <command> [options]`)
	blank()
	log(`  ${c.bold("Commands")}`)
	const width = Math.max(...Object.keys(COMMANDS).map(k => k.length))
	for (const [name, cmd] of Object.entries(COMMANDS)) {
		log(`    ${c.cyan(name.padEnd(width))}  ${cmd.summary}`)
	}
	blank()
	log(`  ${c.bold("Getting started")}`)
	log(`    ${c.grey("1.")} symmio doctor --network arbitrum      ${c.grey("# is everything configured?")}`)
	log(`    ${c.grey("2.")} symmio config show --chain 42161      ${c.grey("# what parameters will be set?")}`)
	log(`    ${c.grey("3.")} symmio deploy --network fork-arbitrum ${c.grey("# rehearse on a fork first")}`)
	log(`    ${c.grey("4.")} symmio deploy --network arbitrum      ${c.grey("# the real thing")}`)
	log(`    ${c.grey("5.")} symmio status --network arbitrum      ${c.grey("# confirm the result")}`)
	blank()
	log(`  ${c.grey("symmio <command> --help  for details on one command")}`)
	blank()
}

function commandHelp(name, cmd) {
	blank()
	log(`  ${c.bold("symmio " + name)} ${c.grey("— " + cmd.summary)}`)
	blank()
	for (const line of [].concat(cmd.usage)) log(`    ${c.cyan(line)}`)
	blank()
}

async function main() {
	const argv = process.argv.slice(2)
	const args = parseArgs(argv)
	const name = args._[0]

	if (!name || name === "help" || args.help === true) {
		if (name && name !== "help" && COMMANDS[name]) {
			commandHelp(name, COMMANDS[name])
			return 0
		}
		if (args._[1] && COMMANDS[args._[1]]) {
			commandHelp(args._[1], COMMANDS[args._[1]])
			return 0
		}
		help()
		return 0
	}

	const cmd = COMMANDS[name]
	if (!cmd) {
		fatal(`unknown command "${name}"`, `run \`symmio help\` to see the available commands`)
	}
	if (args.help) {
		commandHelp(name, cmd)
		return 0
	}

	const run = await cmd.load()
	return (await run(args)) ?? 0
}

main()
	.then(code => process.exit(code))
	.catch(err => {
		fatal(err.message || String(err), err.stack && process.env.SYMMIO_DEBUG ? err.stack : "set SYMMIO_DEBUG=1 for a stack trace")
	})
