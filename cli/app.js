import { normalizeDeploymentSummary, renderDeploymentTerminal } from "../deployment-tooling/deployment-report.js";
import { resolveNetwork } from "./lib/context.js";
import * as defaultRunner from "./task-runner.js";
import * as clack from "@clack/prompts";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { clearScreenDown, cursorTo, moveCursor } from "node:readline";

const CATEGORY_ACTIONS = Object.freeze({
	deploy: "Deploy a contract",
	patch: "Patch configurations for deployed contracts",
	checklist: "Run the checklist on a new deployment",
	maintenance: "Other maintenance scripts",
});

function elapsed(start) {
	const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
	const minutes = Math.floor(seconds / 60);
	return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function transactionCounts(transactions = []) {
	const confirmed = transactions.filter(tx => ["confirmed", "replaced"].includes(tx.status)).length;
	const failed = transactions.filter(tx => tx.status === "failed").length;
	return { confirmed, failed, pending: transactions.length - confirmed - failed };
}

function createLiveTaskView({ title, input, output }) {
	const base = clack.taskLog({ title, limit: 14, retainLog: false, input, output });
	let message = "";
	let renderedLines = [];
	let suspended = false;

	const columns = () => Math.max(20, output.columns || 80);
	const visualRows = lines => lines.reduce((total, line) => total + Math.max(1, Math.ceil(Array.from(line).length / columns())), 0);
	const frameLines = value => {
		const available = Math.max(1, columns() - 4);
		return value.split("\n").map(line => {
			const characters = Array.from(line);
			const content = characters.length <= available ? line : `${characters.slice(0, Math.max(1, available - 1)).join("")}…`;
			return `│  ${content}`;
		});
	};
	const clear = () => {
		if (!renderedLines.length) return;
		moveCursor(output, 0, -visualRows(renderedLines));
		cursorTo(output, 0);
		clearScreenDown(output);
		renderedLines = [];
	};
	const draw = () => {
		if (suspended || !message) return;
		renderedLines = frameLines(message);
		output.write(`${renderedLines.join("\n")}\n`);
	};
	return {
		message(next) {
			message = next;
			clear();
			draw();
		},
		suspend() {
			suspended = true;
			clear();
		},
		resume() {
			if (!suspended) return;
			suspended = false;
			draw();
		},
		error(text, options) {
			clear();
			base.error(text, options);
		},
		warning(text) {
			clear();
			clack.log.warn(text, { input, output });
		},
		success(text, options) {
			clear();
			base.success(text, options);
		},
	};
}

function createDetailController(input, output, render, view) {
	let active = false;
	let detail = false;
	const onData = chunk => {
		// Skip escape sequences: CSI 'D' (left arrow) ends in the same byte as the "D" hotkey.
		const bytes = Buffer.from(chunk);
		for (let index = 0; index < bytes.length; index++) {
			const byte = bytes[index];
			if (byte === 0x1b) {
				const rest = bytes.subarray(index);
				const match = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|.)/su.exec(rest.toString("latin1"));
				index += (match ? match[0].length : 1) - 1;
				continue;
			}
			if (byte === 3) process.kill(process.pid, "SIGINT");
			if (byte === 100 || byte === 68) {
				detail = !detail;
				render();
			}
		}
	};
	const onResize = () => render(true);
	function start() {
		if (active) return;
		view.resume();
		if (!input.isTTY) return;
		active = true;
		input.setRawMode?.(true);
		input.resume();
		input.on("data", onData);
		output.on?.("resize", onResize);
	}
	function stop() {
		view.suspend();
		if (!active) return;
		active = false;
		input.off("data", onData);
		output.off?.("resize", onResize);
		input.setRawMode?.(false);
		input.pause();
	}
	return { start, stop, detail: () => detail };
}

function createUi({ input, output, controllerRef }) {
	const common = { input, output };
	const prompt = async (fn, options) => {
		controllerRef.current?.stop();
		try {
			const result = await fn({ ...options, ...common });
			return clack.isCancel(result) ? null : result;
		} finally {
			controllerRef.current?.start();
		}
	};
	return {
		select: options => prompt(clack.select, options),
		confirm: options => prompt(clack.confirm, options),
		text: options => prompt(clack.text, options),
		password: options => prompt(clack.password, options),
		multiselect: options => prompt(clack.multiselect, options),
		note: (message, title) => clack.note(message, title, common),
		runInteractive(command, args) {
			controllerRef.current?.stop();
			try {
				const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
				if (result.error) throw result.error;
				return result.status ?? 1;
			} finally {
				controllerRef.current?.start();
			}
		},
	};
}

function taskSummary(state, current, startedAt, detail, rawLines, activity = {}) {
	const counts = transactionCounts(state?.transactions);
	const completedSteps = state?.completedSteps || [];
	// Batch items are planned contracts. Counting confirmed transactions against them pins the
	// bar early (a full deployment sends ~3x more transactions than it creates contracts) and
	// lets a fork rehearsal consume the live stage's budget, so count contract events per step.
	const batchTotal = (state?.plan || []).reduce((sum, step) => sum + (step.items?.length || 0), 0);
	const batchDone = (state?.plan || []).reduce((sum, step) => {
		const items = step.items?.length || 0;
		if (!items) return sum;
		if (completedSteps.includes(step.id)) return sum + items;
		return sum + Math.min((state?.batchProgress?.[step.id] || []).length, items);
	}, 0);
	const complete = completedSteps.length + batchDone;
	const total = (state?.plan?.length || 0) + batchTotal;
	const activeIndex = (state?.plan || []).findIndex(step => step.id === current.stepId);
	const activeStep = activeIndex >= 0 ? state.plan[activeIndex] : null;
	const phase = current.phase || state?.lastEvent?.phase || activeStep?.phase || "prepare";
	const section = current.section ? ` \u203a ${current.section}` : "";
	const running = activeStep && !completedSteps.includes(activeStep.id);
	const progressDetail = running ? ` • step ${activeIndex + 1} running` : "";
	const age = activity.at ? Math.max(0, Math.floor((Date.now() - activity.at) / 1000)) : 0;
	const status = state?.status === "waiting_external" ? "Waiting for external action" : activity.processRunning ? "Process running" : "Working";
	const pulse = ["◒", "◐", "◓", "◑"][Math.floor((Date.now() - startedAt) / 500) % 4];
	const lines = [
		`Phase        ${phase}${section}`,
		`Progress     ${complete}/${total} completed${progressDetail}`,
		`Current      ${current.title || state?.waitingFor || "Preparing task"}`,
		`Status       ${pulse} ${status} • activity ${age === 0 ? "now" : `${age}s ago`}`,
		`Activity     ${activity.text || current.title || "Preparing task plan"}`,
		`Transactions ${counts.confirmed} confirmed  ${counts.pending} pending  ${counts.failed} failed`,
		`Elapsed      ${elapsed(startedAt)}`,
		`Warnings     ${state?.warnings?.length || 0}`,
		`Details      press d to ${detail ? "hide" : "show"} receipts, gas and recent raw logs`,
	];
	if (detail) {
		if (state?.safeDispatch) {
			lines.push(
				"",
				"Safe delivery:",
				`  ${state.safeDispatch.status} ${state.safeDispatch.actionCount} action(s) • ${state.safeDispatch.safeAddress}`,
				`  digest ${state.safeDispatch.digest}`,
				...(state.safeDispatch.safeTxHash ? [`  proposal ${state.safeDispatch.safeTxHash}`] : []),
				...(state.safeDispatch.builderPath ? [`  builder ${state.safeDispatch.builderPath}`] : []),
			);
		}
		const recentTransactions = (state?.transactions || []).slice(-4);
		if (recentTransactions.length) {
			lines.push("", "Recent transactions:");
			for (const tx of recentTransactions) {
				const hash = tx.replacementHash || tx.hash;
				let explorer;
				try {
					const base = resolveNetwork(state?.network).explorer;
					if (base && hash) explorer = `${base}/tx/${hash}`;
				} catch {}
				lines.push(`  ${tx.status.padEnd(10)} ${tx.label || "transaction"}`, `    hash ${hash || "pending"}`);
				if (tx.gasUsed) lines.push(`    gas ${tx.gasUsed}`);
				if (explorer) lines.push(`    explorer ${explorer}`);
			}
		}
		if (rawLines.length) lines.push("", "Recent redacted log:", ...rawLines.slice(-6).map(line => `  ${line}`));
	}
	return lines.join("\n");
}

function activeDescription(active) {
	if (!active) return "No active task. Completed deployment reports remain in history and are never treated as active.";
	const complete = active.completedSteps?.length || 0;
	const signerLines = Object.entries(active.signing || {}).flatMap(([role, signer]) => {
		if (!signer) return [];
		const identity = signer.safeAddress || signer.address || signer.key || "local node";
		return [`${role === "transaction" ? "Signer" : "Governance"}: ${signer.mode} • ${identity}`];
	});
	return [
		`${active.title}`,
		`${active.status} • ${complete}/${active.plan?.length || 0} steps • ${active.network || "no network"}`,
		...signerLines,
		`Run ${active.runId}`,
		active.waitingFor || active.lastError || "Ready to continue from the next safe boundary.",
	].join("\n");
}

function homeOptions(active) {
	return [
		{ value: "deploy", label: "Deploy a contract" },
		{ value: "patch", label: "Patch configurations for deployed contracts" },
		{ value: "checklist", label: "Run the checklist on a new deployment" },
		{ value: "maintenance", label: "Other maintenance scripts" },
		{
			value: "continue",
			label: "Continue active task",
			hint: active ? `${active.status} • ${active.title}` : "nothing is active",
			disabled: !active,
		},
		{
			value: "cancel",
			label: "Cancel active task",
			hint: active ? "safe abandonment; confirmed effects remain" : "nothing is active",
			disabled: !active,
		},
		{ value: "exit", label: "Exit" },
	];
}

async function runWithProgress(action, { ui, runner, input, output, controllerRef }) {
	const view = createLiveTaskView({ title: "SYMMIO task progress", input, output });
	const startedAt = Date.now();
	const current = { phase: null, stepId: null, title: "" };
	const activity = { at: startedAt, processRunning: false, text: "Preparing guided inputs" };
	const rawLines = [];
	let passwordPromptActive = false;
	let passwordSubmitted = false;
	let cachedKeystoreInput = null;
	let pendingKeystoreInput = [];
	let titleBeforePassword = "";
	let stopPasswordInput = null;
	const channelsServedFromCache = new WeakSet();
	let latestState = null;
	let rendered = "";
	const render = (force = false) => {
		if (!latestState) return;
		const message = taskSummary(latestState, current, startedAt, controllerRef.current?.detail() || false, rawLines, activity);
		if (force || message !== rendered) {
			rendered = message;
			view.message(message);
		}
	};
	const markActivity = (text, processRunning = activity.processRunning) => {
		activity.at = Date.now();
		activity.processRunning = processRunning;
		activity.text = text;
	};
	const displayLine = line =>
		String(line)
			.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu, "")
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
			.replace(/\s+/gu, " ")
			.trim();
	controllerRef.current = createDetailController(input, output, render, view);
	const runtime = {
		ui,
		onEvent(event, state) {
			latestState = state;
			if (event.phase) current.phase = event.phase;
			if (event.stepId) current.stepId = event.stepId;
			// A deployment section is not a task phase: show it beside the phase instead of
			// letting it overwrite the running step's title.
			if (event.type === "phase.started") {
				current.section = event.title || null;
				markActivity(event.title ? `Started ${event.title}` : "Started a deployment section", activity.processRunning);
			} else if (event.title) current.title = event.title;
			if (event.type === "step.started" || event.type === "step.completed") current.section = null;
			if (event.type === "contract.deployed")
				markActivity(`Deployed ${event.contractName || "contract"}${event.address ? ` at ${event.address}` : ""}`, activity.processRunning);
			if (event.type === "contract.reused")
				markActivity(`Reusing ${event.contractName || "contract"}${event.address ? ` at ${event.address}` : ""}`, activity.processRunning);
			if (event.type === "step.progress") {
				current.title = event.message || current.title;
				markActivity(`[${event.current}/${event.total}] ${event.message || "working"}`, activity.processRunning);
			}
			if (event.type === "task.started") markActivity(`Plan ready • ${state.plan?.length || 0} steps`, false);
			if (event.type === "step.started") markActivity(event.title || "Step started", false);
			if (event.type === "step.completed") markActivity(`Completed ${event.title || "step"}`, false);
			if (event.type === "process.started") markActivity("Subprocess started; output is being captured", true);
			if (event.type === "process.completed" && event.code !== 0 && cachedKeystoreInput) {
				// The password may be exactly why this failed; asking again beats replaying a
				// rejected secret into every later subprocess of the run.
				cachedKeystoreInput.fill(0);
				cachedKeystoreInput = null;
			}
			if (event.type === "process.completed")
				markActivity(
					event.code === 0
						? "Subprocess completed"
						: event.code === 2
							? "Subprocess completed with governance/handover actions still pending"
							: `Subprocess exited with code ${event.code}`,
					false,
				);
			if (event.type === "task.pause_requested") {
				current.title = "Pausing safely";
				markActivity(event.message || "Pause requested; preserving resumable task state", false);
			}
			if (event.type === "tx.submitted") markActivity(`Broadcast ${event.transaction?.label || "transaction"}; waiting for receipt`, false);
			if (event.type === "tx.confirmed") markActivity(`Confirmed ${event.transaction?.label || "transaction"}`, false);
			if (event.type === "tx.failed") markActivity(`Transaction failed: ${event.transaction?.label || "transaction"}`, false);
			if (event.type === "warning") markActivity("Warning recorded", activity.processRunning);
			if (event.type === "task.waiting") {
				current.title = event.message;
				markActivity("Waiting for an external action", false);
			}
			if (event.type === "safe.exported") {
				current.title = "Safe batch exported with decoded actions";
				markActivity(current.title, false);
			}
			if (event.type === "safe.proposed") {
				current.title = `Safe proposal ${event.safe?.safeTxHash || "created"}`;
				markActivity(current.title, false);
			}
			controllerRef.current.start();
			render();
		},
		onLine(line, _stream, state) {
			latestState = state;
			const safeLine = displayLine(line);
			if (!safeLine) return;
			rawLines.push(safeLine);
			if (rawLines.length > 50) rawLines.shift();
			const progress = safeLine.match(/\[(\d+)\/(\d+)\]\s*(.+)/);
			if (progress) current.title = progress[3];
			const activityLine = /^Plan complete\.\s+Review it,\s+then rerun with EXECUTE=true\b/u.test(safeLine)
				? "Plan prepared; waiting for subprocess to finish"
				: safeLine;
			markActivity(activityLine, activity.processRunning);
			render();
		},
		onPrompt(prompt, state, channel) {
			latestState = state;
			passwordPromptActive = true;
			passwordSubmitted = false;
			titleBeforePassword = current.title;
			current.title = "Unlock Hardhat keystore";
			controllerRef.current.stop();
			// Reuse the unlock only for a channel that has not already consumed it. A child that
			// prompts twice (unlock, then "confirm your password", or a retry after a wrong
			// password) must reach the operator instead of silently receiving the same bytes.
			if (cachedKeystoreInput && !channelsServedFromCache.has(channel)) {
				channelsServedFromCache.add(channel);
				passwordSubmitted = true;
				markActivity("Reusing in-memory keystore unlock for this task", true);
				channel.write(cachedKeystoreInput);
				channel.end?.();
				return;
			}
			pendingKeystoreInput = [];
			markActivity("Waiting for keystore password", false);
			const forward = chunk => {
				const bytes = Buffer.from(chunk);
				if (bytes.includes(3)) {
					stopPasswordInput?.();
					process.kill(process.pid, "SIGINT");
					return;
				}
				channel.write(chunk);
				const terminator = bytes.findIndex(byte => byte === 10 || byte === 13);
				const accepted = terminator >= 0 ? bytes.subarray(0, terminator + 1) : bytes;
				if (accepted.length > 0) pendingKeystoreInput.push(Buffer.from(accepted));
				if (terminator >= 0) {
					cachedKeystoreInput = Buffer.concat(pendingKeystoreInput);
					for (const part of pendingKeystoreInput) part.fill(0);
					pendingKeystoreInput = [];
					channel.end?.();
					passwordSubmitted = true;
					stopPasswordInput?.();
					output.write("\n");
					clack.log.info("Unlocking keystore…", { input, output });
				}
			};
			stopPasswordInput = () => {
				input.off("data", forward);
				input.setRawMode?.(false);
				input.pause();
				stopPasswordInput = null;
			};
			input.setRawMode?.(true);
			input.resume();
			input.on("data", forward);
			clack.note("Your password goes directly to Hardhat and is never stored in task state or logs.", "Keystore unlock", { input, output });
			output.write(`${prompt} `);
		},
		onPromptResolved(state) {
			if (!passwordPromptActive) return;
			latestState = state;
			passwordPromptActive = false;
			stopPasswordInput?.();
			if (!passwordSubmitted) output.write("\n");
			current.title = titleBeforePassword || current.title;
			titleBeforePassword = "";
			markActivity("Keystore unlocked; task continuing", true);
			controllerRef.current.start();
			render();
		},
	};
	const heartbeat = setInterval(render, 500);
	heartbeat.unref?.();
	try {
		const result = await action(runtime);
		latestState = result || latestState;
		controllerRef.current.stop();
		if (!result) {
			view.success("Task setup cancelled; no active task was created", { showLog: false });
			return null;
		}
		if (result.status === "completed") {
			view.success(`${result.title} completed`, { showLog: false });
			const reportPath = result.result?.deploymentReportPath;
			if (reportPath && fs.existsSync(reportPath)) {
				const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
				const explorer = Number(report.chainId) === 42161 ? "https://arbiscan.io" : undefined;
				clack.note(renderDeploymentTerminal(normalizeDeploymentSummary(report, { explorer })).trimEnd(), "Deployment report", {
					input,
					output,
				});
			}
		} else if (result.status === "cancelled")
			view.success(`${result.title} cancelled safely; confirmed effects were preserved`, { showLog: true });
		else if (result.status === "failed") {
			view.error(
				[result.title + " failed and cannot be resumed", result.lastError && `Reason: ${result.lastError}`].filter(Boolean).join("\n"),
				{ showLog: true },
			);
		} else if (result.status === "paused") {
			view.warning(
				[
					`${result.title} paused after an error; resumable evidence was preserved`,
					result.lastError && `Reason: ${result.lastError}`,
					"Next: choose Continue active task to retry from the next safe step, or Cancel active task to preserve confirmed effects and close it.",
				]
					.filter(Boolean)
					.join("\n"),
			);
		} else {
			view.warning(
				[
					`${result.title} is ${result.status}; resumable evidence was preserved`,
					(result.waitingFor || result.lastError) && `Reason: ${result.waitingFor || result.lastError}`,
				]
					.filter(Boolean)
					.join("\n"),
			);
		}
		if (result.logPath || result.eventPath || result.archivedPath) {
			clack.note(
				[
					result.eventPath && `Events: ${result.eventPath}`,
					result.logPath && `Raw log: ${result.logPath}`,
					result.archivedPath && `History: ${result.archivedPath}`,
				]
					.filter(Boolean)
					.join("\n"),
				"Task evidence",
				{ input, output },
			);
		}
		return result;
	} catch (error) {
		controllerRef.current.stop();
		view.error(error?.message || String(error), { showLog: true });
		return null;
	} finally {
		clearInterval(heartbeat);
		stopPasswordInput?.();
		for (const part of pendingKeystoreInput) part.fill(0);
		pendingKeystoreInput = [];
		cachedKeystoreInput?.fill(0);
		cachedKeystoreInput = null;
		controllerRef.current?.stop();
		controllerRef.current = null;
	}
}

async function chooseCatalogTask(category, runner, ui) {
	const definitions = runner.catalog(category);
	return ui.select({
		message: CATEGORY_ACTIONS[category],
		options: [
			...definitions.map(definition => ({ value: definition.id, label: definition.title, hint: definition.description })),
			{ value: "back", label: "Back" },
		],
		maxItems: 10,
	});
}

export async function runOperatorApp({ runner = defaultRunner, input = process.stdin, output = process.stdout } = {}) {
	const controllerRef = { current: null };
	const ui = createUi({ input, output, controllerRef });
	clack.intro("SYMMIO  •  Operator", { input, output });
	while (true) {
		let active;
		try {
			active = runner.getActive();
		} catch (error) {
			clack.log.error(error?.message || String(error), { input, output });
			return 1;
		}
		clack.box(activeDescription(active), "Active task", {
			width: Math.max(48, Math.min(76, (output.columns || 80) - 4)),
			formatBorder: text => (process.env.NO_COLOR ? text : `\u001b[36m${text}\u001b[0m`),
			input,
			output,
		});
		const action = await ui.select({
			message: "What do you want to do?",
			options: homeOptions(active),
			initialValue: active ? "continue" : "deploy",
			maxItems: 7,
		});
		if (action === null || action === "exit") {
			clack.outro("Operator session closed", { input, output });
			return 0;
		}
		if (Object.hasOwn(CATEGORY_ACTIONS, action)) {
			const taskId = await chooseCatalogTask(action, runner, ui);
			if (!taskId || taskId === "back") continue;
			await runWithProgress(runtime => runner.start(taskId, runtime), { ui, runner, input, output, controllerRef });
			continue;
		}
		if (action === "continue") {
			await runWithProgress(runtime => runner.resumeActive(runtime), { ui, runner, input, output, controllerRef });
			continue;
		}
		if (action === "cancel") {
			const confirmed = await ui.confirm({
				message: "Abandon this task safely? Confirmed on-chain work will not be rolled back.",
				initialValue: false,
			});
			if (confirmed) await runWithProgress(runtime => runner.cancelActive(runtime), { ui, runner, input, output, controllerRef });
		}
	}
}

export { CATEGORY_ACTIONS, activeDescription, createUi, homeOptions, taskSummary };
