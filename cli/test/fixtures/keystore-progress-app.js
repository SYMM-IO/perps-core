import { runOperatorApp } from "../../app.js";
import { createTaskRunner } from "../../task-runner.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const run = async ctx => {
	await ctx.step("unlock", "Unlock keystore and run task", async () => {
		await ctx.runProcess(process.execPath, [path.resolve("cli/test/fixtures/keystore-child.js"), "first"]);
		await ctx.runProcess(process.execPath, [path.resolve("cli/test/fixtures/keystore-child.js"), "second"]);
	});
};
const task = {
	id: "deploy.keystore-pty",
	version: 1,
	category: "deploy",
	risk: "read-only",
	title: "Keystore PTY task",
	description: "Proves that a subprocess can securely take over the terminal for a password.",
	supportedNetworks: ["local"],
	inputs: [],
	resumePolicy: { strategy: "restart" },
	cancellationPolicy: { rollback: false },
	artifacts: ["event journal", "redacted raw log"],
	transactionJournal: false,
	prepare: async ({ ui }) => {
		const keystore = await ui.confirm({ message: "Use Hardhat keystore?", initialValue: true });
		return keystore ? { network: "local", chainId: 31337 } : null;
	},
	plan: async () => [{ id: "unlock", phase: "execution", title: "Unlock keystore and run task" }],
	run,
	handler: run,
};

const stateRoot = process.env.SYMMIO_PTY_STATE_ROOT || mkdtempSync(path.join(tmpdir(), "symmio-keystore-pty-"));
const runner = createTaskRunner({ root: process.cwd(), stateRoot, definitions: [task] });
process.exitCode = await runOperatorApp({ runner });
