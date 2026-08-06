// Runs hardhat tasks as child processes.
//
// Shelling out rather than importing hardhat programmatically is deliberate: the operator
// sees the exact command being run and can reproduce it by hand, and the CLI cannot
// accidentally hold a stale in-process network connection across commands.
import { PROJECT_ROOT, projectPath } from "./paths.js";
import { c, blank } from "./ui.js";
import { spawn } from "node:child_process";
import fs from "node:fs";

const HARDHAT_BIN = projectPath("node_modules", ".bin", process.platform === "win32" ? "hardhat.cmd" : "hardhat");

/**
 * @param {string[]} args  arguments after `hardhat`
 * @param {{echo?: boolean, env?: Record<string,string>}} [opts]
 * @returns {Promise<number>} exit code
 */
export function hardhat(args, opts = {}) {
	const { echo = true, env = {} } = opts;
	if (!fs.existsSync(HARDHAT_BIN)) {
		console.error(`  ${c.red("Error")} local Hardhat is not installed at ${HARDHAT_BIN}`);
		console.error(
			`  ${c.grey("Run `./utils/yarn-classic.sh install --frozen-lockfile` in the repository, then retry. The CLI will not download packages implicitly.")}`,
		);
		return Promise.resolve(1);
	}
	if (echo) {
		blank();
		console.log(`  ${c.grey("$")} ${c.cyan(["./node_modules/.bin/hardhat", ...args].join(" "))}`);
		blank();
	}
	return new Promise(resolve => {
		let settled = false;
		const finish = code => {
			if (settled) return;
			settled = true;
			resolve(code);
		};
		const child = spawn(HARDHAT_BIN, args, {
			stdio: "inherit",
			env: { ...process.env, ...env },
			cwd: PROJECT_ROOT,
		});
		child.on("close", code => finish(code ?? 1));
		child.on("error", err => {
			console.error(`  ${c.red("Error")} failed to start local Hardhat: ${err.message}`);
			console.error(`  ${c.grey(`binary: ${HARDHAT_BIN}`)}`);
			finish(1);
		});
	});
}

/** Run a hardhat task and throw on non-zero exit. */
export async function hardhatOrThrow(args, opts) {
	const code = await hardhat(args, opts);
	if (code !== 0) {
		throw new Error(`\`hardhat ${args.join(" ")}\` exited with code ${code}`);
	}
}
