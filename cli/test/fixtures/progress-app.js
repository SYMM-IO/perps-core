import { runOperatorApp } from "../../app.js";
import { createTaskRunner } from "../../task-runner.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const holdMilliseconds = Number(process.env.SYMMIO_PTY_HOLD_MS || 700);
const run = async ctx => {
	await ctx.step("broadcast", "Broadcast transaction", async () => {
		const transaction = {
			hash: `0x${"a".repeat(64)}`,
			label: "synthetic write",
			nonce: 1,
			from: "0x1111111111111111111111111111111111111111",
			status: "unresolved",
		};
		ctx.emit("tx.submitted", { transaction });
		ctx.emit("tx.confirmed", { transaction: { ...transaction, status: "confirmed", gasUsed: "42000" } });
		ctx.captureLine("receipt stored; activity remains visible after terminal resize at one hundred and twenty columns");
		await wait(holdMilliseconds);
	});
	await ctx.step("finish", "Finish synthetic task", async () => wait(100));
};
const task = {
	id: "deploy.synthetic-pty",
	version: 1,
	category: "deploy",
	risk: "transaction",
	title: "Synthetic PTY task",
	description: "Proves detail toggling and cooperative Ctrl+C pause.",
	supportedNetworks: ["local"],
	inputs: [],
	resumePolicy: { strategy: "stable-step-id" },
	cancellationPolicy: { rollback: false },
	artifacts: ["event journal", "transaction journal"],
	transactionJournal: true,
	prepare: async ({ ui }) => {
		const keystore = await ui.confirm({ message: "Use Hardhat keystore?", initialValue: true });
		return keystore ? { network: "local", chainId: 31337 } : null;
	},
	plan: async () => [
		{ id: "broadcast", phase: "execution", title: "Broadcast transaction" },
		{ id: "finish", phase: "assurance", title: "Finish synthetic task" },
	],
	run,
	handler: run,
	reconcile: ({ state }) => ({ unresolved: state.transactions.filter(tx => tx.status === "unresolved").map(tx => tx.hash) }),
};

const stateRoot = process.env.SYMMIO_PTY_STATE_ROOT || mkdtempSync(path.join(tmpdir(), "symmio-progress-pty-"));
const runner = createTaskRunner({ root: process.cwd(), stateRoot, definitions: [task] });
process.exitCode = await runOperatorApp({ runner });
