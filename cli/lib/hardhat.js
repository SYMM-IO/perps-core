// Runs hardhat tasks as child processes.
//
// Shelling out rather than importing hardhat programmatically is deliberate: the operator
// sees the exact command being run and can reproduce it by hand, and the CLI cannot
// accidentally hold a stale in-process network connection across commands.

import { spawn } from "node:child_process"

import { c, blank } from "./ui.js"

/**
 * @param {string[]} args  arguments after `hardhat`
 * @param {{echo?: boolean, env?: Record<string,string>}} [opts]
 * @returns {Promise<number>} exit code
 */
export function hardhat(args, opts = {}) {
	const { echo = true, env = {} } = opts
	if (echo) {
		blank()
		console.log(`  ${c.grey("$")} ${c.cyan(["npx", "hardhat", ...args].join(" "))}`)
		blank()
	}
	return new Promise(resolve => {
		const child = spawn("npx", ["hardhat", ...args], {
			stdio: "inherit",
			env: { ...process.env, ...env },
		})
		child.on("close", code => resolve(code ?? 1))
		child.on("error", () => resolve(1))
	})
}

/** Run a hardhat task and throw on non-zero exit. */
export async function hardhatOrThrow(args, opts) {
	const code = await hardhat(args, opts)
	if (code !== 0) {
		throw new Error(`\`hardhat ${args.join(" ")}\` exited with code ${code}`)
	}
}
