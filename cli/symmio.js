#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";

export const HELP_TEXT = `SYMMIO Operator

Usage:
  ./symmio

Launches the interactive operator menu. Commands and flags are intentionally not
supported; deployment, patching, checklists and maintenance all run through the
durable task system. An interactive terminal is required.
`;

export async function runCli(argv = process.argv.slice(2), runtime = {}) {
	const stdin = runtime.stdin || process.stdin;
	const stdout = runtime.stdout || process.stdout;
	const stderr = runtime.stderr || process.stderr;
	if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
		stdout.write(HELP_TEXT);
		return 0;
	}
	if (argv.length > 0) {
		stderr.write(`SYMMIO Operator is menu-only; arguments are not supported.\n\n${HELP_TEXT}`);
		return 2;
	}
	if (!stdin.isTTY || !stdout.isTTY) {
		stderr.write("SYMMIO Operator requires an interactive terminal (TTY). Run ./symmio directly in a terminal.\n");
		return 2;
	}
	const { runOperatorApp } = await import("./app.js");
	return runOperatorApp({ input: stdin, output: stdout });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	try {
		process.exitCode = await runCli();
	} catch (error) {
		console.error(error?.message || String(error));
		process.exitCode = 1;
	}
}
