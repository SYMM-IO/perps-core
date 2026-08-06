#!/usr/bin/env node

import { execFileSync, spawn } from "child_process";
import { readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hardhatBin = path.join(process.cwd(), "node_modules", ".bin", "hardhat");

// A developer's deployment .env must never change the local test topology. In
// particular, a production CREATE2 factory, keystore selection, signer, RPC, or
// mainnet confirmation can make fixtures target external state or fail before a
// test begins. Keep fuzz/test controls, but strip deployment-only inputs and tell
// hardhat.config.ts not to load the repository .env in worker processes.
const DEPLOYMENT_ENV_PREFIXES = ["RPC_", "MUON_", "DEPLOY_", "KEYSTORE_", "CONFIRM_"];
const DEPLOYMENT_ENV_NAMES = new Set([
	"ADMIN_PUBLIC_KEY",
	"COLLATERAL_ADDRESS",
	"CREATE2_FACTORY_ADDRESS",
	"DIAMOND_VANITY_PREFIX",
	"DRY_RUN",
	"ETHERSCAN_APIKEY",
	"EXECUTE",
	"FORK_BLOCK_NUMBER",
	"NEW_DEPLOYER",
	"PARTYB_SIGNER",
	"PRIVATE_KEY",
	"PRIVATE_KEYS_STR",
	"REGISTER_DUMMY_AFFILIATE",
	"SAFE_PROPOSAL_SUBMIT",
	"SETUP_INSTANT_LAYER_TEMPLATES",
	"SET_ADL_ENABLED",
	"SUBMIT_SAFE_PROPOSAL",
	"SYMMIO_FEE_RECEIVER",
	"SYMMIO_RPC_URL_OVERRIDE",
	"SYMBOL_MANAGER_OPERATOR",
	"TEAM_DEPLOYER",
	"TEAM_MIGRATOR",
	"TEAM_PROPOSER",
	"TEAM_UPGRADE_OPERATOR",
	"UNSAFE_MAINNET_CONFIRM_CHAIN_ID",
	"USE_KEYSTORE",
]);

function isolatedTestEnvironment(extra = {}) {
	const env = { ...process.env };
	for (const name of Object.keys(env)) {
		if (DEPLOYMENT_ENV_NAMES.has(name) || DEPLOYMENT_ENV_PREFIXES.some(prefix => name.startsWith(prefix))) delete env[name];
	}
	return {
		...env,
		DOTENV_CONFIG_PATH: "/dev/null",
		DEPLOY_LOG_LEVEL: "silent",
		...extra,
	};
}

// ═══════════════════════════════════════════════════════════════════════════════
// COLORS
// ═══════════════════════════════════════════════════════════════════════════════

const colorsEnabled = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const ansi = value => (colorsEnabled ? value : "");
const c = {
	reset: ansi("\x1b[0m"),
	bold: ansi("\x1b[1m"),
	dim: ansi("\x1b[2m"),
	red: ansi("\x1b[31m"),
	green: ansi("\x1b[32m"),
	yellow: ansi("\x1b[33m"),
	blue: ansi("\x1b[34m"),
	magenta: ansi("\x1b[35m"),
	cyan: ansi("\x1b[36m"),
	white: ansi("\x1b[37m"),
	gray: ansi("\x1b[90m"),
	brightRed: ansi("\x1b[91m"),
	brightGreen: ansi("\x1b[92m"),
	brightYellow: ansi("\x1b[93m"),
	brightCyan: ansi("\x1b[96m"),
	brightWhite: ansi("\x1b[97m"),
};

const style = (color, text) => `${c[color]}${text}${c.reset}`;
const bold = (color, text) => `${c.bold}${c[color]}${text}${c.reset}`;

// Gradient for progress bar
const gradient = [
	"\x1b[38;5;198m",
	"\x1b[38;5;199m",
	"\x1b[38;5;200m",
	"\x1b[38;5;164m",
	"\x1b[38;5;128m",
	"\x1b[38;5;92m",
	"\x1b[38;5;56m",
	"\x1b[38;5;57m",
	"\x1b[38;5;93m",
	"\x1b[38;5;129m",
	"\x1b[38;5;165m",
].map(ansi);

// ═══════════════════════════════════════════════════════════════════════════════
// BANNER
// ═══════════════════════════════════════════════════════════════════════════════

function printBanner() {
	console.log();
	console.log(style("brightCyan", "  ███████╗██╗   ██╗███╗   ███╗███╗   ███╗██╗ ██████╗ "));
	console.log(style("brightCyan", "  ██╔════╝╚██╗ ██╔╝████╗ ████║████╗ ████║██║██╔═══██╗"));
	console.log(style("brightCyan", "  ███████╗ ╚████╔╝ ██╔████╔██║██╔████╔██║██║██║   ██║"));
	console.log(style("brightCyan", "  ╚════██║  ╚██╔╝  ██║╚██╔╝██║██║╚██╔╝██║██║██║   ██║"));
	console.log(style("brightCyan", "  ███████║   ██║   ██║ ╚═╝ ██║██║ ╚═╝ ██║██║╚██████╔╝"));
	console.log(style("brightCyan", "  ╚══════╝   ╚═╝   ╚═╝     ╚═╝╚═╝     ╚═╝╚═╝ ╚═════╝ "));
	console.log();
	console.log(style("magenta", "  ⚡ PARALLEL TEST RUNNER ⚡"));
	console.log();
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatTime(ms) {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const mins = Math.floor(ms / 60000);
	const secs = ((ms % 60000) / 1000).toFixed(0);
	return `${mins}m ${secs}s`;
}

function createProgressBar(percent, width = 30) {
	const filled = Math.round((percent / 100) * width);
	let bar = "";
	for (let i = 0; i < width; i++) {
		if (i < filled) {
			const idx = Math.floor((i / width) * gradient.length);
			bar += gradient[idx] + "█" + c.reset;
		} else {
			bar += style("gray", "░");
		}
	}
	return bar;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const jobsRaw = args[0] ?? "8";
if (!/^\d+$/.test(jobsRaw) || Number(jobsRaw) < 1 || Number(jobsRaw) > 64 || !Number.isSafeInteger(Number(jobsRaw))) {
	throw new Error(`parallel jobs must be an integer between 1 and 64; received "${jobsRaw}"`);
}
const jobs = Number(jobsRaw);
const extraArgs = args.slice(1);

const parallelTestDir = path.join(process.cwd(), "test/parallel");
const parallelTestFiles = readdirSync(parallelTestDir)
	.filter(f => f.endsWith(".test.ts"))
	.map(f => path.join(parallelTestDir, f));
const sequentialTestDir = path.join(process.cwd(), "test/sequential");
const sequentialTestFiles = readdirSync(sequentialTestDir)
	.filter(f => f === "Main.ts" || f.endsWith(".test.ts"))
	.map(f => path.join(sequentialTestDir, f));
const totalTestFiles = parallelTestFiles.length + sequentialTestFiles.length;

const results = {
	passed: 0,
	failed: 0,
	pending: 0,
	suites: [],
	failures: [],
};

function runTest(file) {
	return new Promise(resolve => {
		const basename = path.relative(process.cwd(), file);
		const startTime = Date.now();
		let resolved = false;

		const doResolve = result => {
			if (resolved) return;
			resolved = true;
			resolve(result);
		};

		let proc;
		try {
			proc = spawn(hardhatBin, ["test", "mocha", "--no-compile", ...extraArgs, "--", file], {
				stdio: ["ignore", "pipe", "pipe"],
				env: isolatedTestEnvironment({ FORCE_COLOR: colorsEnabled ? "1" : "0" }),
			});
		} catch (err) {
			// Handle spawn failure (e.g., ENFILE)
			doResolve({
				file: basename,
				passed: 0,
				failed: 1,
				pending: 0,
				duration: Date.now() - startTime,
				stdout: `Spawn error: ${err.message}`,
				code: 1,
			});
			return;
		}

		proc.on("error", err => {
			// Handle spawn error event
			doResolve({
				file: basename,
				passed: 0,
				failed: 1,
				pending: 0,
				duration: Date.now() - startTime,
				stdout: `Spawn error: ${err.message}`,
				code: 1,
			});
		});

		let stdout = "";
		proc.stdout.on("data", data => (stdout += data.toString()));
		proc.stderr.on("data", data => (stdout += data.toString()));

		proc.on("close", code => {
			const duration = Date.now() - startTime;

			const passMatch = stdout.match(/(\d+) passing/);
			const failMatch = stdout.match(/(\d+) failing/);
			const pendingMatch = stdout.match(/(\d+) pending/);

			doResolve({
				file: basename,
				passed: passMatch ? parseInt(passMatch[1]) : 0,
				failed: failMatch ? parseInt(failMatch[1]) : 0,
				pending: pendingMatch ? parseInt(pendingMatch[1]) : 0,
				duration,
				stdout,
				code,
			});
		});
	});
}

function updateProgress(completed, total, elapsed) {
	const percent = total === 0 ? 100 : Math.round((completed / total) * 100);
	const bar = createProgressBar(percent);

	const status =
		`  ${bar} ${style("brightWhite", String(percent).padStart(3))}% ` +
		`${style("gray", "│")} ` +
		`${style("brightGreen", "✓" + results.passed)} ` +
		`${style("brightRed", "✗" + results.failed)} ` +
		`${style("brightYellow", "○" + results.pending)} ` +
		`${style("gray", "│")} ` +
		`${style("cyan", completed + "/" + total)} ` +
		`${style("gray", "│")} ` +
		`${style("white", formatTime(elapsed))}`;

	process.stdout.write(`\r${status}\x1b[K`);
}

function recordResult(result) {
	if (result.code !== 0 && result.failed === 0) {
		result.crashed = true;
		result.failed = 1;
	}
	results.passed += result.passed;
	results.failed += result.failed;
	results.pending += result.pending;
	results.suites.push(result);
	if (result.failed > 0) results.failures.push(result);
}

function printResults(totalDuration) {
	console.log("\n");

	// Sort: failures first, then by duration desc
	const sorted = [...results.suites].sort((a, b) => {
		if (a.failed > 0 && b.failed === 0) return -1;
		if (a.failed === 0 && b.failed > 0) return 1;
		return b.duration - a.duration;
	});

	// Header
	console.log(bold("brightWhite", "  ═══════════════════════════════════════════════════════════"));
	console.log(bold("brightWhite", "                         TEST RESULTS"));
	console.log(bold("brightWhite", "  ═══════════════════════════════════════════════════════════"));
	console.log();

	// Each suite
	for (const suite of sorted) {
		const icon = suite.failed > 0 ? style("brightRed", "✗") : style("brightGreen", "✓");
		const nameColor = suite.failed > 0 ? "brightRed" : "brightGreen";
		const name = style(nameColor, suite.file);
		const time = style("gray", `(${formatTime(suite.duration)})`);

		const counts = [];
		if (suite.passed > 0) counts.push(style("green", `${suite.passed} passing`));
		if (suite.failed > 0) counts.push(style("red", `${suite.failed} failing`));
		if (suite.pending > 0) counts.push(style("yellow", `${suite.pending} pending`));

		console.log(`  ${icon} ${name} ${time}`);
		console.log(`      ${counts.join(style("gray", " · "))}`);
		console.log();
	}

	// Failures section with full details
	if (results.failures.length > 0) {
		console.log();
		console.log(bold("brightRed", "  ═══════════════════════════════════════════════════════════"));
		console.log(bold("brightRed", "                           FAILURES"));
		console.log(bold("brightRed", "  ═══════════════════════════════════════════════════════════"));

		for (const failure of results.failures) {
			console.log();
			console.log(style("brightRed", `  ✗ ${failure.file}`));
			console.log(style("gray", "  " + "─".repeat(60)));

			// Strip ANSI codes from mocha output for clean parsing
			const stripAnsi = str => str.replace(/\x1b\[[0-9;]*m/g, "");
			const rawOutput = stripAnsi(failure.stdout);
			const lines = rawOutput.split("\n");

			let inFailureBlock = false;
			let lastWasStackTrace = false;
			let hasPrintedSomething = false;

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				const trimmed = line.trim();

				// Start capturing after "X failing" line
				if (line.match(/\d+ failing/)) {
					inFailureBlock = true;
					continue;
				}

				if (!inFailureBlock) continue;

				// Skip empty lines at the start
				if (!hasPrintedSomething && trimmed === "") continue;

				// Stop at "passing" line (end of failures)
				if (trimmed.match(/^\d+ passing/)) break;

				// Numbered failure line (e.g., "1) Suite name")
				if (line.match(/^\s+\d+\)/)) {
					lastWasStackTrace = false;
					hasPrintedSomething = true;
					console.log(style("brightRed", `    ${trimmed}`));
					continue;
				}

				// Skip additional stack trace lines after we've printed one
				if (lastWasStackTrace && trimmed.startsWith("at ")) {
					continue;
				}

				// Test hierarchy lines (indented)
				if (
					line.match(/^\s{6,}\S/) &&
					!trimmed.startsWith("at ") &&
					!trimmed.startsWith("+") &&
					!trimmed.startsWith("-") &&
					!trimmed.includes("expected")
				) {
					console.log(style("white", `       ${trimmed}`));
					continue;
				}

				// AssertionError line
				if (trimmed.startsWith("AssertionError") || trimmed.match(/^Error:/)) {
					lastWasStackTrace = false;
					console.log();
					console.log(style("red", `    ${trimmed}`));
					continue;
				}

				// "+ expected - actual" header
				if (trimmed === "+ expected - actual") {
					console.log(style("gray", `    ${trimmed}`));
					continue;
				}

				// Diff lines (expected/actual values)
				if (trimmed.startsWith("+")) {
					console.log(style("green", `    ${trimmed}`));
					continue;
				}
				if (trimmed.startsWith("-")) {
					console.log(style("red", `    ${trimmed}`));
					continue;
				}

				// Stack trace - show first relevant line (test file, contract file, or Context)
				if (
					trimmed.startsWith("at ") &&
					(trimmed.includes("test/") || trimmed.includes("contracts/") || trimmed.includes("Context.<anonymous>"))
				) {
					console.log();
					console.log(style("gray", `    ${trimmed}`));
					console.log(); // Add spacing before next failure
					lastWasStackTrace = true;
					continue;
				}

				// Revert messages
				if (trimmed.includes("revert") || trimmed.includes("VM Exception") || trimmed.includes("reverted with")) {
					console.log(style("red", `    ${trimmed}`));
					continue;
				}
			}
		}
		console.log();
	}

	// Summary
	console.log();
	console.log(bold("brightWhite", "  ═══════════════════════════════════════════════════════════"));
	console.log(bold("brightWhite", "                           SUMMARY"));
	console.log(bold("brightWhite", "  ═══════════════════════════════════════════════════════════"));
	console.log();

	console.log(`  ${style("brightGreen", `✓ ${results.passed} passing`)}`);
	if (results.failed > 0) {
		console.log(`  ${style("brightRed", `✗ ${results.failed} failing`)}`);
	}
	if (results.pending > 0) {
		console.log(`  ${style("brightYellow", `○ ${results.pending} pending`)}`);
	}
	console.log(`  ${style("gray", `★ ${results.suites.length} test suites`)}`);
	console.log(`  ${style("gray", `→ ${formatTime(totalDuration)} total`)}`);

	// Final status
	console.log();
	if (results.failed === 0) {
		console.log(style("brightGreen", "  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓"));
		console.log(
			style("brightGreen", "  ┃") +
				bold("brightGreen", "        ✨ ALL TESTS PASSED! GREAT JOB! ✨                 ") +
				style("brightGreen", "┃"),
		);
		console.log(style("brightGreen", "  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛"));
	} else {
		console.log(style("brightRed", "  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓"));
		console.log(
			style("brightRed", "  ┃") +
				bold("brightRed", `      💥 ${results.failed} TEST(S) FAILED - PLEASE FIX! 💥             `) +
				style("brightRed", "┃"),
		);
		console.log(style("brightRed", "  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛"));
	}
	console.log();
}

// Note: Muon signature verification is now handled via MockMuonSignatureVerifier
// deployed in test initialization. No source code modification needed.

async function compile() {
	console.log(style("cyan", "  ⟳ Compiling contracts..."));
	try {
		execFileSync(hardhatBin, ["compile", "--quiet"], { stdio: "pipe", env: isolatedTestEnvironment() });
		console.log(style("brightGreen", "  ✓ Compilation complete!"));
	} catch (e) {
		console.error(style("brightRed", "  ✗ Compilation failed!"));
		throw e;
	}
}

async function main() {
	printBanner();

	console.log(style("gray", `  → Parallel test files: ${style("white", parallelTestFiles.length)}`));
	console.log(style("gray", `  → Sequential test files: ${style("white", sequentialTestFiles.length)}`));
	console.log(style("gray", `  → Workers: ${style("white", jobs)}`));
	console.log();

	// Compile
	await compile();
	console.log();

	console.log(style("cyan", "  ⟳ Running tests..."));
	console.log();

	const startTime = Date.now();
	const pending = [...parallelTestFiles];
	const running = new Map();
	let completed = 0;

	// Progress update interval
	const progressInterval = colorsEnabled
		? setInterval(() => {
				updateProgress(completed, totalTestFiles, Date.now() - startTime);
			}, 100)
		: undefined;

	// Run tests
	try {
		while (pending.length > 0 || running.size > 0) {
			while (pending.length > 0 && running.size < jobs) {
				const file = pending.shift();
				const promise = runTest(file).then(result => {
					running.delete(file);
					completed++;

					recordResult(result);

					return result;
				});
				running.set(file, promise);
			}

			if (running.size > 0) {
				await Promise.race(running.values());
			}
		}

		// Sequential suites intentionally run only after every parallel worker has
		// finished, so stateful/fuzz orchestration cannot overlap another suite.
		for (const file of sequentialTestFiles) {
			const result = await runTest(file);
			completed++;
			recordResult(result);
		}
	} finally {
		if (progressInterval) {
			clearInterval(progressInterval);
			updateProgress(completed, totalTestFiles, Date.now() - startTime);
		}

		const totalDuration = Date.now() - startTime;
		printResults(totalDuration);
	}

	process.exit(results.failed > 0 ? 1 : 0);
}

process.on("SIGINT", () => {
	console.log(style("yellow", "\n\n  Interrupted by user"));
	process.exit(130);
});

process.on("uncaughtException", err => {
	console.error(style("red", `\n  Error: ${err.message}`));
	process.exit(1);
});

main().catch(err => {
	console.error(style("red", `\n  Error: ${err.message}`));
	process.exit(1);
});
