import { renderTerminalScreen } from "./terminal-screen.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

test("PTY arrow navigation renders the exact home menu and exits cleanly", { timeout: 10_000 }, async () => {
	const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-home-pty-"));
	const child = spawn("python3", [path.resolve("cli/test/fixtures/pty-home.py"), process.cwd(), process.execPath, path.resolve("cli/symmio.js")], {
		cwd: process.cwd(),
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, SYMMIO_TASK_STATE_DIR: stateRoot },
	});
	let output = "";
	const read = chunk => {
		output += chunk.toString();
	};
	child.stdout.on("data", read);
	child.stderr.on("data", read);
	const code = await new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	const plain = output.replace(ANSI, "").replace(/\r/g, "");
	assert.equal(code, 0, plain);
	for (const label of [
		"Deploy a contract",
		"Patch configurations for deployed contracts",
		"Run the checklist on a new deployment",
		"Other maintenance scripts",
		"Continue active task (nothing is active)",
		"Cancel active task (nothing is active)",
		"Exit",
	]) {
		assert.match(plain, new RegExp(label.replace(/[()]/g, "\\$&")));
	}
	assert.match(plain, /Operator session closed/);
});

test("PTY guided confirmation, detail toggle, resize, and first Ctrl+C pause cooperatively", { timeout: 15_000 }, async () => {
	const child = spawn(
		"python3",
		[path.resolve("cli/test/fixtures/pty-progress.py"), process.cwd(), process.execPath, path.resolve("cli/test/fixtures/progress-app.js")],
		{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: process.env },
	);
	let output = "";
	child.stdout.on("data", chunk => (output += chunk.toString()));
	child.stderr.on("data", chunk => (output += chunk.toString()));
	const code = await new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	const plain = output.replace(ANSI, "").replace(/\r/g, "");
	assert.equal(code, 0, plain);
	assert.match(plain, /Use Hardhat keystore\?/);
	assert.match(plain, /Yes/);
	assert.match(plain, /0xaaaaaaaa/);
	assert.match(plain, /gas 42000/);
	assert.match(plain, /Interrupt received; stopping the current operation and preserving resumable task state/);
	assert.match(plain, /Synthetic PTY task paused after an error/);
	assert.match(plain, /Operator session closed/);
});

test("a paused task reports its concrete failure without a success marker or detail toggle", { timeout: 15_000 }, async () => {
	const child = spawn(
		"python3",
		[path.resolve("cli/test/fixtures/pty-failure.py"), process.cwd(), process.execPath, path.resolve("cli/test/fixtures/progress-app.js")],
		{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: process.env },
	);
	let output = "";
	child.stdout.on("data", chunk => (output += chunk.toString()));
	child.stderr.on("data", chunk => (output += chunk.toString()));
	const code = await new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	const plain = output.replace(ANSI, "").replace(/\r/g, "");
	assert.equal(code, 0, plain);
	assert.match(plain, /Synthetic PTY task paused after an error/);
	assert.match(plain, /HHE999: simulated operator failure/);
	assert.doesNotMatch(plain, /Synthetic PTY task is paused/);
});

test("PTY progress keeps one live execution frame with heartbeat and activity", { timeout: 15_000 }, async () => {
	const child = spawn(
		"python3",
		[
			path.resolve("cli/test/fixtures/pty-progress-snapshot.py"),
			process.cwd(),
			process.execPath,
			path.resolve("cli/test/fixtures/progress-app.js"),
		],
		{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: process.env },
	);
	let output = "";
	child.stdout.on("data", chunk => (output += chunk.toString()));
	child.stderr.on("data", chunk => (output += chunk.toString()));
	const code = await new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	assert.equal(code, 0, output.replace(ANSI, ""));
	const screen = renderTerminalScreen(output, { columns: 100, rows: 32 });
	assert.equal((screen.match(/Phase\s+/g) || []).length, 1, screen);
	assert.match(screen, /Phase\s+execution/);
	assert.match(screen, /Status\s+.*Working/);
	assert.match(screen, /Activity\s+/);
	assert.match(screen, /Elapsed\s+[1-9]\d*s/);
});

test("live progress reflows immediately when the terminal grows from 80 to 120 columns", { timeout: 15_000 }, async () => {
	const child = spawn(
		"python3",
		[
			path.resolve("cli/test/fixtures/pty-progress-resize.py"),
			process.cwd(),
			process.execPath,
			path.resolve("cli/test/fixtures/progress-app.js"),
		],
		{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: process.env },
	);
	let output = "";
	child.stdout.on("data", chunk => (output += chunk.toString()));
	child.stderr.on("data", chunk => (output += chunk.toString()));
	const code = await new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	assert.equal(code, 0, output.replace(ANSI, ""));
	const screen = renderTerminalScreen(output, { columns: 120, rows: 32 });
	assert.equal((screen.match(/Phase\s+/g) || []).length, 1, screen);
	assert.match(screen, /one hundred and twenty columns/);
});

test("one Hardhat keystore password unlocks every subprocess in the same task run", { timeout: 15_000 }, async () => {
	const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-keystore-pty-test-"));
	const child = spawn(
		"python3",
		[
			path.resolve("cli/test/fixtures/pty-keystore-password.py"),
			process.cwd(),
			process.execPath,
			path.resolve("cli/test/fixtures/keystore-progress-app.js"),
		],
		{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SYMMIO_PTY_STATE_ROOT: stateRoot } },
	);
	let output = "";
	child.stdout.on("data", chunk => (output += chunk.toString()));
	child.stderr.on("data", chunk => (output += chunk.toString()));
	const code = await new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	const plain = output.replace(ANSI, "").replace(/\r/g, "");
	assert.equal(code, 0, plain);
	assert.match(plain, /Enter the password:/);
	assert.match(plain, /goes directly to Hardhat and is never stored/);
	assert.equal((plain.match(/Your password goes directly to Hardhat/g) || []).length, 1, plain);
	assert.match(plain, /Keystore PTY task completed/);
	assert.doesNotMatch(plain, /test-password/);
	assert.doesNotMatch(plain, /Activity\s+\*+/);
	const progressSnapshot = fs.readFileSync(path.join(stateRoot, "keystore-progress.snapshot"), "utf8");
	const progressScreen = renderTerminalScreen(progressSnapshot, { columns: 100, rows: 32 });
	assert.match(progressScreen, /Current\s+Unlock keystore and run task/);
	assert.match(progressScreen, /Activity\s+Plan prepared; waiting for subprocess to finish/);
	assert.doesNotMatch(progressScreen, /Current\s+Unlock Hardhat keystore/);
	assert.doesNotMatch(progressScreen, /rerun with EXECUTE=true/);
	const evidence = fs
		.readdirSync(stateRoot, { recursive: true, withFileTypes: true })
		.filter(entry => entry.isFile())
		.map(entry => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
		.join("\n");
	assert.doesNotMatch(evidence, /test-password/);
});

test("a second Ctrl+C exits immediately after atomically preserving resumable state", { timeout: 15_000 }, async () => {
	const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-double-interrupt-"));
	const child = spawn(
		"python3",
		[
			path.resolve("cli/test/fixtures/pty-double-interrupt.py"),
			process.cwd(),
			process.execPath,
			path.resolve("cli/test/fixtures/progress-app.js"),
		],
		{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SYMMIO_PTY_STATE_ROOT: stateRoot } },
	);
	let output = "";
	child.stdout.on("data", chunk => (output += chunk.toString()));
	child.stderr.on("data", chunk => (output += chunk.toString()));
	const code = await new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	assert.equal(code, 0, output.replace(ANSI, ""));
	const active = JSON.parse(fs.readFileSync(path.join(stateRoot, "active.json"), "utf8"));
	assert.equal(active.status, "paused");
	assert.match(active.lastError, /Forced exit while pausing/);
	assert.equal(active.transactions[0].status, "confirmed");
});

test("arrow keys navigate without toggling the receipts pane", { timeout: 25_000 }, async () => {
	const child = spawn(
		"python3",
		[path.resolve("cli/test/fixtures/pty-arrow-keys.py"), process.cwd(), process.execPath, path.resolve("cli/test/fixtures/progress-app.js")],
		// Hold the live panel open long enough to press the arrows and then the real hotkey.
		{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SYMMIO_PTY_HOLD_MS: "6000" } },
	);
	let output = "";
	child.stdout.on("data", chunk => (output += chunk.toString()));
	child.stderr.on("data", chunk => (output += chunk.toString()));
	const code = await new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	const plain = output.replace(ANSI, "").replace(/\r/g, "");
	// The fixture fails loudly if ←/→/↑/↓ opened the pane; "d" must still open it afterwards.
	assert.equal(code, 0, plain);
	assert.match(plain, /gas 42000/);
	assert.match(plain, /Operator session closed/);
});
