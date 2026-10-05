#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upgradeRoot = path.join(root, "test/upgrade");
const stages = ["input", "preflight", "deployment", "rehearsal", "governance", "verification", "unpause", "recovery", "workflow"];
const help = `Usage: npm run test:upgrade -- <stage> [--chain-bound] [--match <text>] [--list]
Stages: ${stages.join(", ")}
Select one stage. --chain-bound selects ignored local deployment checks.
--match filters filenames. --list prints the selection without running it.
Hardhat tests use existing artifacts; compile once at the stage boundary if needed.`;
const args = process.argv.slice(2);
if (args.includes("--help")) {
	console.log(help);
	process.exit(0);
}
const stage = args.shift();
if (!stages.includes(stage)) {
	console.error(help);
	process.exit(2);
}
let chainBound = false,
	list = false,
	match = "";
while (args.length) {
	const option = args.shift();
	if (option === "--chain-bound") chainBound = true;
	else if (option === "--list") list = true;
	else if (option === "--match" && args[0] && !args[0].startsWith("--")) match = args.shift().toLowerCase();
	else {
		console.error(`Unknown or incomplete option: ${option}\n${help}`);
		process.exit(2);
	}
}
const directory = path.join(upgradeRoot, ...(chainBound ? ["chain-bound"] : []), stage);
const files = fs.existsSync(directory)
	? fs
			.readdirSync(directory, { withFileTypes: true })
			.filter(entry => entry.isFile() && /\.test\.(js|ts)$/.test(entry.name) && entry.name.toLowerCase().includes(match))
			.map(entry => path.relative(root, path.join(directory, entry.name)))
			.sort()
	: [];
if (!files.length) {
	console.error(
		`No ${chainBound ? "local chain-bound" : "tracked reusable"} upgrade tests selected for ${stage}${match ? ` matching ${match}` : ""}.`,
	);
	process.exit(2);
}
console.log(files.join("\n"));
if (list) process.exit(0);
const env = { ...process.env, DOTENV_CONFIG_PATH: "/dev/null" };
const commands = [
	[process.execPath, ["--test", ...files.filter(file => file.endsWith(".js"))]],
	[path.join(root, "node_modules/.bin/hardhat"), ["test", "mocha", "--no-compile", "--", ...files.filter(file => file.endsWith(".ts"))]],
];
for (const [command, commandArgs] of commands) {
	const count = commandArgs.filter(arg => /\.test\.(js|ts)$/.test(arg)).length;
	if (!count) continue;
	const result = spawnSync(command, commandArgs, { cwd: root, env, stdio: "inherit" });
	if (result.error) console.error(result.error.message);
	if (result.status !== 0) process.exit(result.status ?? 1);
}
