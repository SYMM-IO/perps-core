import { createTaskRunner } from "../../task-runner.js";
import fs from "node:fs";
import path from "node:path";

const [taskId, inputPath] = process.argv.slice(2);
if (!taskId || !inputPath) throw new Error("Usage: node run-task.js <task-id> <input.json>");

const input = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"));
const stateRoot = process.env.SYMMIO_TASK_STATE_DIR;
if (!stateRoot) throw new Error("SYMMIO_TASK_STATE_DIR is required for an isolated task run");

const ui = {
	confirm: async () => true,
	text: async options => options.initialValue || options.placeholder || "",
	password: async () => {
		throw new Error("The local QA fixture never supplies secrets");
	},
	note: (message, title) => console.log(`${title}: ${message}`),
};
const runner = createTaskRunner({ root: process.cwd(), stateRoot });
const result = await runner.start(taskId, {
	input,
	ui,
	onEvent: event => {
		if (["task.started", "step.started", "step.completed", "task.completed", "task.failed"].includes(event.type)) {
			console.log(`${event.type}${event.title ? `: ${event.title}` : ""}${event.message ? `: ${event.message}` : ""}`);
		}
	},
	onLine: line => console.log(line),
});
console.log(
	JSON.stringify({ taskId: result?.taskId, status: result?.status, completedSteps: result?.completedSteps?.length, lastError: result?.lastError }),
);
if (result?.status !== "completed") process.exitCode = 1;
