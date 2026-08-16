// Runs hardhat tasks as child processes.
//
// Shelling out rather than importing hardhat programmatically is deliberate: the operator
// sees the exact command being run and can reproduce it by hand, and the CLI cannot
// accidentally hold a stale in-process network connection across commands.
import { PROJECT_ROOT, projectPath } from "./paths.js";
import { taskOutputSink } from "./task-output.js";
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
		console.error(`  ${c.grey("Run `npm ci` in the repository, then retry. The CLI will not download packages implicitly.")}`);
		return Promise.resolve(1);
	}
	if (echo) {
		blank();
		console.log(`  ${c.grey("$")} ${c.cyan(["./node_modules/.bin/hardhat", ...args].join(" "))}`);
		blank();
	}
	return new Promise(resolve => {
		const sink = taskOutputSink();
		let settled = false;
		const finish = code => {
			if (settled) return;
			settled = true;
			resolve(code);
		};
		const child = spawn(HARDHAT_BIN, args, {
			stdio: sink ? ["inherit", "pipe", "pipe", "pipe"] : "inherit",
			env: { ...process.env, ...env, ...(sink ? { SYMMIO_TASK_EVENT_FD: "3" } : {}) },
			cwd: PROJECT_ROOT,
		});
		sink?.child?.(child);
		if (sink) {
			const consume = (stream, name) => {
				let buffer = "";
				stream.setEncoding("utf8");
				stream.on("data", chunk => {
					buffer += chunk;
					const lines = buffer.split(/\r?\n/);
					buffer = lines.pop() || "";
					for (const line of lines) if (line) sink.line(line, name);
				});
				stream.on("end", () => {
					if (buffer) sink.line(buffer, name);
				});
			};
			consume(child.stdout, "stdout");
			consume(child.stderr, "stderr");
			let eventBuffer = "";
			child.stdio[3].setEncoding("utf8");
			child.stdio[3].on("data", chunk => {
				eventBuffer += chunk;
				const lines = eventBuffer.split(/\r?\n/);
				eventBuffer = lines.pop() || "";
				for (const line of lines) {
					try {
						const event = JSON.parse(line);
						sink.event(event.type || "task.detail", event.detail || event);
					} catch {
						sink.line(line, "event");
					}
				}
			});
		}
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
