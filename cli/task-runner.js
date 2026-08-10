// Durable task runner for every operator workflow.
//
// The terminal UI deliberately knows only this interface: catalog(), start(),
// resumeActive(), cancelActive(), and getActive(). Task definitions own prompts and
// implementation details; the runner owns lifecycle, locking, evidence and recovery.
import { PROJECT_ROOT } from "./lib/paths.js";
import { withTaskOutputSink } from "./lib/task-output.js";
import { redactSignerSecrets, validateSignerSelection, withSignerEnvironment } from "./signer/index.js";
import { TASK_DEFINITIONS } from "./tasks/registry.js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";

const ACTIVE_STATUSES = new Set(["prepared", "running", "paused", "waiting_external", "cancel_pending"]);
const RISK_LEVELS = new Set(["read-only", "local-write", "transaction"]);
const CATEGORIES = new Set(["deploy", "patch", "checklist", "maintenance"]);
const UNCERTAIN_TX_STATUSES = new Set(["submitted", "unresolved", "timed_out"]);
const HARDHAT_KEYSTORE_PROMPT = /\[hardhat-keystore\]\s*(?:Enter the password|Please confirm your password):\s*$/u;
const TERMINAL_CONTROL = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu;

export class TaskPauseError extends Error {
	constructor(message = "Task paused at a safe boundary") {
		super(message);
		this.name = "TaskPauseError";
	}
}

export class TaskWaitingError extends Error {
	constructor(message) {
		super(message);
		this.name = "TaskWaitingError";
	}
}

export class TaskFatalError extends Error {
	constructor(message) {
		super(message);
		this.name = "TaskFatalError";
	}
}

function stableValue(value) {
	if (value === undefined) return "[undefined]";
	if (typeof value === "bigint") return value.toString();
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(stableValue);
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map(key => [key, stableValue(value[key])]),
	);
}

function digest(value) {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(stableValue(value)))
		.digest("hex")}`;
}

function safeSegment(value) {
	return (
		String(value)
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "task"
	);
}

function redact(value) {
	return redactSignerSecrets(value)
		.replace(/(?:https?|wss?):\/\/[^\s'"`<>]+/giu, "<redacted-url>")
		.replace(/((?:private|secret)[ _-]?key\s*[:=]\s*)0x[a-fA-F0-9]{64}/giu, "$1<redacted-private-key>")
		.replace(/((?:password|secret|token|api[ _-]?key)\s*[:=]\s*)\S+/giu, "$1<redacted>");
}

function atomicWrite(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
	try {
		fs.writeFileSync(temporary, value, { mode: 0o600 });
		fs.renameSync(temporary, file);
	} catch (error) {
		try {
			fs.unlinkSync(temporary);
		} catch {}
		throw error;
	}
}

function readJson(file, fallback = null) {
	if (!fs.existsSync(file)) return fallback;
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`Task state ${file} is unreadable: ${error.message || error}`);
	}
}

function processAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function hashSourceTree(root) {
	const hash = createHash("sha256");
	const entries = [
		"cli",
		"contracts",
		"deployment",
		"scripts",
		"tasks",
		"utils",
		"hardhat.config.ts",
		"package.json",
		"package-lock.json",
		"tsconfig.json",
	];
	const files = [];
	const visit = entry => {
		if (!fs.existsSync(entry)) return;
		const relative = path.relative(root, entry);
		if (relative === path.join("tasks", "data") || relative.startsWith(`${path.join("tasks", "data")}${path.sep}`)) return;
		const stat = fs.statSync(entry);
		if (stat.isDirectory()) {
			for (const child of fs.readdirSync(entry).sort()) visit(path.join(entry, child));
		} else if (stat.isFile()) {
			files.push(entry);
		}
	};
	for (const entry of entries) visit(path.join(root, entry));
	for (const file of files.sort()) {
		hash.update(path.relative(root, file));
		hash.update("\0");
		hash.update(fs.readFileSync(file));
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

function validateDefinition(definition) {
	if (!definition || typeof definition !== "object") throw new Error("Task definition must be an object");
	if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(definition.id || "")) throw new Error(`Invalid task id ${JSON.stringify(definition.id)}`);
	if (!Number.isSafeInteger(definition.version) || definition.version < 1)
		throw new Error(`Task ${definition.id} must have a positive integer version`);
	if (!CATEGORIES.has(definition.category)) throw new Error(`Task ${definition.id} has unknown category ${JSON.stringify(definition.category)}`);
	if (!RISK_LEVELS.has(definition.risk)) throw new Error(`Task ${definition.id} has unknown risk ${JSON.stringify(definition.risk)}`);
	for (const name of ["title", "description"]) {
		if (typeof definition[name] !== "string" || definition[name].trim() === "") throw new Error(`Task ${definition.id} requires ${name}`);
	}
	if (typeof definition.prepare !== "function") throw new Error(`Task ${definition.id} requires prepare()`);
	if (typeof definition.plan !== "function") throw new Error(`Task ${definition.id} requires plan()`);
	if (typeof definition.run !== "function") throw new Error(`Task ${definition.id} requires run()`);
	if (definition.handler !== definition.run) throw new Error(`Task ${definition.id} must expose its run function as handler`);
	if (!Array.isArray(definition.supportedNetworks) || definition.supportedNetworks.length === 0) {
		throw new Error(`Task ${definition.id} requires supportedNetworks`);
	}
	if (
		!Array.isArray(definition.inputs) ||
		definition.inputs.some(
			input =>
				!input ||
				typeof input !== "object" ||
				typeof input.id !== "string" ||
				!["string", "address", "integer", "boolean", "recipe", "network", "secret-reference", "selection"].includes(input.type),
		)
	) {
		throw new Error(`Task ${definition.id} requires typed input declarations`);
	}
	if (!definition.resumePolicy || typeof definition.resumePolicy !== "object") throw new Error(`Task ${definition.id} requires resumePolicy`);
	if (!definition.cancellationPolicy || typeof definition.cancellationPolicy !== "object")
		throw new Error(`Task ${definition.id} requires cancellationPolicy`);
	if (!Array.isArray(definition.artifacts)) throw new Error(`Task ${definition.id} requires artifact declarations`);
	if (definition.risk !== "read-only" && typeof definition.reconcile !== "function") {
		throw new Error(`Mutating task ${definition.id} requires reconcile()`);
	}
	if (definition.risk !== "read-only" && definition.transactionJournal !== true) {
		throw new Error(`Mutating task ${definition.id} requires shared transaction-journal support`);
	}
	return definition;
}

function validatePlan(taskId, plan) {
	if (!Array.isArray(plan) || plan.length === 0) throw new Error(`Task ${taskId} produced an empty plan`);
	const ids = new Set();
	for (const step of plan) {
		if (!step || typeof step !== "object" || !/^[a-z0-9][a-z0-9.-]*$/.test(step.id || "")) {
			throw new Error(`Task ${taskId} produced a step without a stable id`);
		}
		if (ids.has(step.id)) throw new Error(`Task ${taskId} repeated plan step ${step.id}`);
		ids.add(step.id);
		if (typeof step.phase !== "string" || !step.phase) throw new Error(`Task ${taskId} step ${step.id} requires a stable phase id`);
		if (typeof step.title !== "string" || !step.title) throw new Error(`Task ${taskId} step ${step.id} requires a title`);
		if (step.items !== undefined && (!Array.isArray(step.items) || new Set(step.items).size !== step.items.length)) {
			throw new Error(`Task ${taskId} step ${step.id} requires unique batch item ids`);
		}
	}
	return plan;
}

function validateDefinitions(definitions) {
	const ids = new Set();
	return definitions.map(definition => {
		validateDefinition(definition);
		if (ids.has(definition.id)) throw new Error(`Duplicate task id ${definition.id}`);
		ids.add(definition.id);
		return definition;
	});
}

function publicDefinition(definition) {
	return {
		id: definition.id,
		version: definition.version,
		category: definition.category,
		risk: definition.risk,
		title: definition.title,
		description: definition.description,
		supportedNetworks: definition.supportedNetworks || ["any"],
		inputs: structuredClone(definition.inputs),
		resumePolicy: structuredClone(definition.resumePolicy),
		cancellationPolicy: structuredClone(definition.cancellationPolicy),
		artifacts: structuredClone(definition.artifacts),
		transactionJournal: definition.transactionJournal,
	};
}

export function createTaskRunner(options = {}) {
	const root = options.root || PROJECT_ROOT;
	const stateRoot = options.stateRoot || process.env.SYMMIO_TASK_STATE_DIR || path.join(root, ".symmio", "tasks");
	const activePath = path.join(stateRoot, "active.json");
	const lockPath = path.join(stateRoot, "runner.lock");
	const historyRoot = path.join(stateRoot, "history");
	const definitions = validateDefinitions(options.definitions || TASK_DEFINITIONS);
	const byId = new Map(definitions.map(definition => [definition.id, definition]));
	const clock = options.clock || (() => new Date());
	const idFactory = options.idFactory || randomUUID;

	function now() {
		return clock().toISOString();
	}

	function saveActive(state) {
		state.updatedAt = now();
		atomicWrite(activePath, `${JSON.stringify(state, null, 2)}\n`);
	}

	function appendEvent(state, event) {
		const record = { at: now(), runId: state.runId, taskId: state.taskId, ...event };
		fs.mkdirSync(path.dirname(state.eventPath), { recursive: true });
		fs.appendFileSync(state.eventPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
		state.lastEvent = record;
		return record;
	}

	function acquireLock(runId) {
		fs.mkdirSync(stateRoot, { recursive: true });
		if (fs.existsSync(lockPath)) {
			const existing = readJson(lockPath, {});
			if (existing.runId === runId && existing.pid === process.pid) return () => {};
			if (processAlive(existing.pid)) {
				throw new Error(`Another SYMMIO task runner is active in PID ${existing.pid} for run ${existing.runId || "unknown"}`);
			}
			fs.unlinkSync(lockPath);
		}
		fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, runId, acquiredAt: now() }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		return () => {
			try {
				const lock = readJson(lockPath, {});
				if (lock.pid === process.pid && lock.runId === runId) fs.unlinkSync(lockPath);
			} catch {}
		};
	}

	function archive(state, outcome) {
		state.status = outcome;
		state.finishedAt = now();
		state.updatedAt = state.finishedAt;
		const directory = path.join(historyRoot, `${safeSegment(state.taskId)}-${state.runId}`);
		fs.mkdirSync(directory, { recursive: true });
		const archivedPath = path.join(directory, "state.json");
		state.archivedPath = archivedPath;
		atomicWrite(archivedPath, `${JSON.stringify(state, null, 2)}\n`);
		if (fs.existsSync(activePath)) {
			const active = readJson(activePath);
			if (active?.runId === state.runId) fs.unlinkSync(activePath);
		}
		return state;
	}

	function getActive() {
		const state = readJson(activePath);
		if (!state) return null;
		if (!ACTIVE_STATUSES.has(state.status)) {
			throw new Error(`Active task file contains terminal/unknown status ${JSON.stringify(state.status)}`);
		}
		const lock = readJson(lockPath);
		return { ...state, runner: lock && processAlive(lock.pid) ? { pid: lock.pid, running: true } : { running: false } };
	}

	function catalog(category) {
		return definitions.filter(definition => !category || definition.category === category).map(publicDefinition);
	}

	function createState(definition, input, plan, runId = idFactory()) {
		if (input?.signer) validateSignerSelection(input.signer);
		if (input?.governanceSigner) validateSignerSelection(input.governanceSigner);
		const directory = path.join(stateRoot, "runs", `${safeSegment(definition.id)}-${runId}`);
		return {
			version: 1,
			runId,
			taskId: definition.id,
			taskVersion: definition.version,
			title: definition.title,
			category: definition.category,
			risk: definition.risk,
			status: "prepared",
			createdAt: now(),
			updatedAt: now(),
			input,
			inputHash: digest(input),
			sourceHash: hashSourceTree(root),
			recipeDigest: input?.recipeDigest,
			chainId: input?.chainId,
			network: input?.network,
			signing: input?.signer || input?.governanceSigner ? { transaction: input?.signer, governance: input?.governanceSigner } : undefined,
			plan,
			planHash: digest(plan),
			completedSteps: [],
			transactions: [],
			warnings: [],
			lastError: null,
			eventPath: path.join(directory, "events.ndjson"),
			logPath: path.join(directory, "raw.log"),
		};
	}

	async function runState(definition, state, runtime = {}) {
		const release = acquireLock(state.runId);
		let pauseRequested = false;
		let interruptCount = 0;
		const activeChildren = new Set();
		const interrupt = () => {
			interruptCount++;
			pauseRequested = true;
			if (interruptCount === 1) {
				for (const child of activeChildren) {
					try {
						child.kill("SIGINT");
					} catch {}
				}
			}
			if (interruptCount >= 2) {
				state.status = "paused";
				state.lastError = "Forced exit while pausing; reconcile submitted transactions before continuing";
				if (definition.risk === "read-only") archive(state, "failed");
				else saveActive(state);
				process.exit(130);
			}
		};
		process.on("SIGINT", interrupt);

		const emit = (type, detail = {}) => {
			const event = appendEvent(state, { type, ...detail });
			if (type === "warning") state.warnings.push({ at: event.at, message: detail.message });
			if (type === "tx.submitted") {
				state.transactions.push({ ...detail.transaction });
				if (detail.transaction?.from) {
					if (!state.signer) state.signer = detail.transaction.from;
					else if (detail.transaction.from.toLowerCase() !== state.signer.toLowerCase()) {
						state.additionalSigners ||= [];
						if (!state.additionalSigners.some(signer => signer.toLowerCase() === detail.transaction.from.toLowerCase())) {
							state.additionalSigners.push(detail.transaction.from);
						}
					}
				}
			}
			if (type === "tx.confirmed" || type === "tx.failed") {
				const tx = state.transactions.find(item => item.hash === detail.transaction?.hash || item.hash === detail.transaction?.originalHash);
				if (tx) Object.assign(tx, detail.transaction);
			}
			if (definition.risk !== "read-only") saveActive(state);
			runtime.onEvent?.(event, state);
			return event;
		};

		const captureLine = (line, stream = "stdout") => {
			const safe = redact(line);
			fs.mkdirSync(path.dirname(state.logPath), { recursive: true });
			fs.appendFileSync(state.logPath, `${safe}\n`, { mode: 0o600 });
			runtime.onLine?.(safe, stream, state);
		};

		const context = {
			root,
			ui: runtime.ui,
			state,
			emit,
			captureLine,
			isPauseRequested: () => pauseRequested,
			requestPause: () => {
				pauseRequested = true;
			},
			fatal: message => {
				throw new TaskFatalError(message);
			},
			checkpoint: () => {
				if (pauseRequested) throw new TaskPauseError();
			},
			setWaiting: message => {
				state.status = "waiting_external";
				state.waitingFor = message;
				if (definition.risk !== "read-only") saveActive(state);
				emit("task.waiting", { message });
			},
			wait: message => {
				context.setWaiting(message);
				throw new TaskWaitingError(message);
			},
			async step(id, title, action, { phase } = {}) {
				const resolvedPhase = phase || state.plan.find(step => step.id === id)?.phase;
				if (state.completedSteps.includes(id)) {
					emit("step.skipped", { stepId: id, title, phase: resolvedPhase });
					return undefined;
				}
				if (pauseRequested) throw new TaskPauseError();
				emit("step.started", { stepId: id, title, phase: resolvedPhase });
				const result = await action();
				state.completedSteps.push(id);
				if (definition.risk !== "read-only") saveActive(state);
				emit("step.completed", { stepId: id, title, phase: resolvedPhase });
				if (pauseRequested) throw new TaskPauseError();
				return result;
			},
			async runCallable(label, action) {
				emit("process.started", { command: label });
				const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
				console.log = (...args) => captureLine(format(...args), "stdout");
				console.info = (...args) => captureLine(format(...args), "stdout");
				console.warn = (...args) => captureLine(format(...args), "stderr");
				console.error = (...args) => captureLine(format(...args), "stderr");
				try {
					const result = await withTaskOutputSink(
						{
							line: captureLine,
							event: emit,
							child: child => {
								activeChildren.add(child);
								child.once("close", () => activeChildren.delete(child));
							},
						},
						action,
					);
					emit("process.completed", { code: Number(result) || 0 });
					return result;
				} finally {
					Object.assign(console, original);
				}
			},
			runProcess(command, args = [], processOptions = {}) {
				return new Promise((resolve, reject) => {
					emit("process.started", { command: [command, ...args].join(" ") });
					const child = spawn(command, args, {
						cwd: processOptions.cwd || root,
						env: { ...process.env, ...processOptions.env, SYMMIO_TASK_EVENT_FD: "3" },
						stdio: ["pipe", "pipe", "pipe", "pipe"],
					});
					activeChildren.add(child);
					let passwordPromptActive = false;
					const resolvePasswordPrompt = () => {
						if (!passwordPromptActive) return;
						passwordPromptActive = false;
						runtime.onPromptResolved?.(state);
					};
					const consume = (stream, name) => {
						let buffer = "";
						stream.setEncoding("utf8");
						stream.on("data", chunk => {
							const wasPasswordPromptActive = passwordPromptActive;
							if (wasPasswordPromptActive && /^[*\s]*$/u.test(chunk.replace(TERMINAL_CONTROL, ""))) return;
							resolvePasswordPrompt();
							buffer += chunk;
							const lines = buffer.split(/\r?\n/);
							buffer = lines.pop() || "";
							for (const line of lines) {
								if (line && !(wasPasswordPromptActive && /^\*+$/u.test(line.replace(TERMINAL_CONTROL, "")))) captureLine(line, name);
							}
							const plainBuffer = buffer.replace(TERMINAL_CONTROL, "");
							if (HARDHAT_KEYSTORE_PROMPT.test(plainBuffer)) {
								const prompt = redact(plainBuffer.trim());
								buffer = "";
								passwordPromptActive = true;
								runtime.onPrompt?.(prompt, state, { write: value => child.stdin.write(value) });
								captureLine(prompt, name);
							}
						});
						stream.on("end", () => {
							if (buffer) captureLine(buffer, name);
						});
					};
					consume(child.stdout, "stdout");
					consume(child.stderr, "stderr");
					let eventBuffer = "";
					child.stdio[3].setEncoding("utf8");
					child.stdio[3].on("data", chunk => {
						resolvePasswordPrompt();
						eventBuffer += chunk;
						const lines = eventBuffer.split(/\r?\n/);
						eventBuffer = lines.pop() || "";
						for (const line of lines) {
							try {
								const taskEvent = JSON.parse(line);
								emit(taskEvent.type || "task.detail", taskEvent.detail || taskEvent);
							} catch {
								captureLine(line, "event");
							}
						}
					});
					child.on("error", reject);
					child.on("close", code => {
						resolvePasswordPrompt();
						activeChildren.delete(child);
						emit("process.completed", { code: code ?? 1 });
						if (code === 0) resolve(0);
						else reject(new Error(`${command} exited with code ${code ?? 1}`));
					});
				});
			},
		};

		try {
			state.status = "running";
			state.lastError = null;
			delete state.waitingFor;
			if (definition.risk !== "read-only") saveActive(state);
			emit("task.started", { title: state.title, plan: state.plan });
			const result = await withSignerEnvironment(state.input?.signer, runtime.ui, () => definition.run(context, state.input, state.plan));
			state.result = result ?? null;
			if (state.status === "waiting_external") {
				saveActive(state);
				return state;
			}
			emit("task.completed", { result: state.result });
			return archive(state, "completed");
		} catch (error) {
			if (error instanceof TaskWaitingError) return state;
			if (error instanceof TaskFatalError) {
				state.lastError = redact(error.message);
				emit("task.failed", { message: state.lastError, unrecoverable: true });
				return archive(state, "failed");
			}
			if (error instanceof TaskPauseError || pauseRequested) {
				state.status = "paused";
				state.lastError = error.message || "Paused";
				emit("task.paused", { message: state.lastError });
				if (definition.risk === "read-only") return archive(state, "failed");
				saveActive(state);
				return state;
			}
			state.lastError = redact(error?.message || String(error));
			emit("task.failed", { message: state.lastError });
			if (definition.risk === "read-only") return archive(state, "failed");
			state.status = "paused";
			saveActive(state);
			return state;
		} finally {
			process.off("SIGINT", interrupt);
			release();
		}
	}

	async function start(id, runtime = {}) {
		const definition = byId.get(id);
		if (!definition) throw new Error(`Unknown operator task ${JSON.stringify(id)}`);
		const runId = idFactory();
		const release = acquireLock(runId);
		try {
			if (definition.risk !== "read-only" && getActive()) {
				throw new Error("Finish or cancel the active task before starting another mutating task");
			}
			const input = runtime.input ?? (await definition.prepare({ root, ui: runtime.ui, catalog: catalog() }));
			if (input === null || input === undefined) return null;
			const plan = validatePlan(definition.id, await definition.plan({ root, ui: runtime.ui }, input));
			const state = createState(definition, input, plan, runId);
			if (definition.risk !== "read-only") saveActive(state);
			return await runState(definition, state, runtime);
		} finally {
			release();
		}
	}

	async function resumeActive(runtime = {}) {
		const state = getActive();
		if (!state) throw new Error("There is no active task to continue");
		if (state.runner?.running) throw new Error(`Task ${state.runId} is already running in PID ${state.runner.pid}`);
		const definition = byId.get(state.taskId);
		if (!definition || definition.version !== state.taskVersion) {
			throw new Error(`Task definition ${state.taskId}@${state.taskVersion} is unavailable; cancellation can still preserve its evidence`);
		}
		if (digest(state.input) !== state.inputHash) throw new Error("Active task input no longer matches its bound input hash");
		if (digest(state.plan) !== state.planHash) throw new Error("Active task plan no longer matches its bound plan hash");
		if (state.signer) {
			const signers = [state.signer, ...(state.additionalSigners || [])].map(signer => signer.toLowerCase());
			if (new Set(signers).size !== signers.length) throw new Error("Active task signer binding contains duplicates");
			if (state.transactions.some(transaction => transaction.from && !signers.includes(transaction.from.toLowerCase()))) {
				throw new Error("Active task transaction journal contains a signer outside its bound signer set");
			}
		}
		const currentSourceHash = hashSourceTree(root);
		if (currentSourceHash !== state.sourceHash) {
			throw new Error(
				`Task source changed since this run started (${state.sourceHash.slice(0, 19)} != ${currentSourceHash.slice(0, 19)}); restore the original source or cancel safely`,
			);
		}
		if (definition.validateResume) await definition.validateResume({ root, state }, state.input);
		delete state.runner;
		return runState(definition, state, runtime);
	}

	async function cancelActive(runtime = {}) {
		const state = getActive();
		if (!state) throw new Error("There is no active task to cancel");
		if (state.runner?.running) throw new Error(`Task ${state.runId} is still running in PID ${state.runner.pid}; pause it before cancelling`);
		const definition = byId.get(state.taskId);
		const release = acquireLock(state.runId);
		try {
			delete state.runner;
			state.status = "cancel_pending";
			saveActive(state);
			const event = appendEvent(state, { type: "task.cancel.requested" });
			runtime.onEvent?.(event, state);
			const cancellationEmit = (type, detail = {}) => {
				const next = appendEvent(state, { type, ...detail });
				if (type === "warning") state.warnings.push({ at: next.at, message: detail.message });
				if (type === "tx.confirmed" || type === "tx.failed") {
					const transaction = state.transactions.find(
						item => item.hash === detail.transaction?.hash || item.hash === detail.transaction?.originalHash,
					);
					if (transaction) Object.assign(transaction, detail.transaction);
				}
				saveActive(state);
				runtime.onEvent?.(next, state);
				return next;
			};
			const cancellationLine = (line, stream = "stdout") => {
				const safe = redact(line);
				fs.mkdirSync(path.dirname(state.logPath), { recursive: true });
				fs.appendFileSync(state.logPath, `${safe}\n`, { mode: 0o600 });
				runtime.onLine?.(safe, stream, state);
			};
			const cancellationProcess = (command, args = [], processOptions = {}) =>
				new Promise((resolve, reject) => {
					cancellationEmit("process.started", { command: [command, ...args].join(" ") });
					const child = spawn(command, args, {
						cwd: processOptions.cwd || root,
						env: { ...process.env, ...processOptions.env, SYMMIO_TASK_EVENT_FD: "3" },
						stdio: ["pipe", "pipe", "pipe", "pipe"],
					});
					let passwordPromptActive = false;
					const resolvePasswordPrompt = () => {
						if (!passwordPromptActive) return;
						passwordPromptActive = false;
						runtime.onPromptResolved?.(state);
					};
					const consume = (stream, name, structured = false) => {
						let buffer = "";
						stream.setEncoding("utf8");
						stream.on("data", chunk => {
							const wasPasswordPromptActive = passwordPromptActive;
							if (wasPasswordPromptActive && /^[*\s]*$/u.test(chunk.replace(TERMINAL_CONTROL, ""))) return;
							resolvePasswordPrompt();
							buffer += chunk;
							const lines = buffer.split(/\r?\n/);
							buffer = lines.pop() || "";
							for (const line of lines) {
								if (!line || (wasPasswordPromptActive && /^\*+$/u.test(line.replace(TERMINAL_CONTROL, "")))) continue;
								if (!structured) cancellationLine(line, name);
								else {
									try {
										const childEvent = JSON.parse(line);
										cancellationEmit(childEvent.type || "task.detail", childEvent.detail || childEvent);
									} catch {
										cancellationLine(line, "event");
									}
								}
							}
							const plainBuffer = buffer.replace(TERMINAL_CONTROL, "");
							if (!structured && HARDHAT_KEYSTORE_PROMPT.test(plainBuffer)) {
								const prompt = redact(plainBuffer.trim());
								buffer = "";
								passwordPromptActive = true;
								runtime.onPrompt?.(prompt, state, { write: value => child.stdin.write(value) });
								cancellationLine(prompt, name);
							}
						});
						stream.on("end", () => {
							if (buffer) cancellationLine(buffer, name);
						});
					};
					consume(child.stdout, "stdout");
					consume(child.stderr, "stderr");
					consume(child.stdio[3], "event", true);
					child.on("error", reject);
					child.on("close", code => {
						resolvePasswordPrompt();
						cancellationEmit("process.completed", { code: code ?? 1 });
						if (code === 0) resolve(0);
						else reject(new Error(`${command} exited with code ${code ?? 1}`));
					});
				});
			let reconciliation = { unresolved: [] };
			if (definition?.reconcile) {
				try {
					reconciliation =
						(await definition.reconcile(
							{ root, ui: runtime.ui, state, emit: cancellationEmit, captureLine: cancellationLine, runProcess: cancellationProcess },
							state.input,
						)) || reconciliation;
				} catch (error) {
					state.lastError = redact(error?.message || String(error));
					cancellationEmit("warning", { message: `Transaction reconciliation is incomplete: ${state.lastError}` });
					reconciliation = {
						unresolved: (state.transactions || [])
							.filter(transaction => UNCERTAIN_TX_STATUSES.has(transaction.status))
							.map(transaction => transaction.hash),
					};
				}
			}
			const journalUnresolved = (state.transactions || []).filter(transaction => UNCERTAIN_TX_STATUSES.has(transaction.status));
			const unresolved = [...(reconciliation.unresolved || []), ...journalUnresolved.map(transaction => transaction.hash)];
			if (unresolved.length > 0) {
				state.cancelBlockedBy = [...new Set(unresolved)];
				state.lastError = `Cancellation is waiting for ${state.cancelBlockedBy.length} unresolved transaction outcome(s)`;
				saveActive(state);
				return state;
			}
			delete state.cancelBlockedBy;
			if (definition?.cancel) state.cancellation = (await definition.cancel({ root, ui: runtime.ui, state }, state.input)) || null;
			state.cancellation = state.cancellation || {
				message: "No rollback was attempted. Confirmed on-chain effects remain in place.",
				transactions: state.transactions,
			};
			const cancelled = appendEvent(state, { type: "task.cancelled", cancellation: state.cancellation });
			runtime.onEvent?.(cancelled, state);
			return archive(state, "cancelled");
		} finally {
			release();
		}
	}

	return Object.freeze({ catalog, start, resumeActive, cancelActive, getActive });
}

const defaultRunner = createTaskRunner();

export const catalog = (...args) => defaultRunner.catalog(...args);
export const start = (...args) => defaultRunner.start(...args);
export const resumeActive = (...args) => defaultRunner.resumeActive(...args);
export const cancelActive = (...args) => defaultRunner.cancelActive(...args);
export const getActive = (...args) => defaultRunner.getActive(...args);
