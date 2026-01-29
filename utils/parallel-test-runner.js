#!/usr/bin/env node

import { spawn, execSync } from "child_process"
import { readdirSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ═══════════════════════════════════════════════════════════════════════════════
// COLORS
// ═══════════════════════════════════════════════════════════════════════════════

const c = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	white: "\x1b[37m",
	gray: "\x1b[90m",
	brightRed: "\x1b[91m",
	brightGreen: "\x1b[92m",
	brightYellow: "\x1b[93m",
	brightCyan: "\x1b[96m",
	brightWhite: "\x1b[97m",
}

const style = (color, text) => `${c[color]}${text}${c.reset}`
const bold = (color, text) => `${c.bold}${c[color]}${text}${c.reset}`

// Gradient for progress bar
const gradient = [
	"\x1b[38;5;198m", "\x1b[38;5;199m", "\x1b[38;5;200m", "\x1b[38;5;164m",
	"\x1b[38;5;128m", "\x1b[38;5;92m", "\x1b[38;5;56m", "\x1b[38;5;57m",
	"\x1b[38;5;93m", "\x1b[38;5;129m", "\x1b[38;5;165m"
]

// ═══════════════════════════════════════════════════════════════════════════════
// BANNER
// ═══════════════════════════════════════════════════════════════════════════════

function printBanner() {
	console.log()
	console.log(style("brightCyan", "  ███████╗██╗   ██╗███╗   ███╗███╗   ███╗██╗ ██████╗ "))
	console.log(style("brightCyan", "  ██╔════╝╚██╗ ██╔╝████╗ ████║████╗ ████║██║██╔═══██╗"))
	console.log(style("brightCyan", "  ███████╗ ╚████╔╝ ██╔████╔██║██╔████╔██║██║██║   ██║"))
	console.log(style("brightCyan", "  ╚════██║  ╚██╔╝  ██║╚██╔╝██║██║╚██╔╝██║██║██║   ██║"))
	console.log(style("brightCyan", "  ███████║   ██║   ██║ ╚═╝ ██║██║ ╚═╝ ██║██║╚██████╔╝"))
	console.log(style("brightCyan", "  ╚══════╝   ╚═╝   ╚═╝     ╚═╝╚═╝     ╚═╝╚═╝ ╚═════╝ "))
	console.log()
	console.log(style("magenta", "  ⚡ PARALLEL TEST RUNNER ⚡"))
	console.log()
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatTime(ms) {
	if (ms < 1000) return `${ms}ms`
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
	const mins = Math.floor(ms / 60000)
	const secs = ((ms % 60000) / 1000).toFixed(0)
	return `${mins}m ${secs}s`
}

function createProgressBar(percent, width = 30) {
	const filled = Math.round((percent / 100) * width)
	let bar = ""
	for (let i = 0; i < width; i++) {
		if (i < filled) {
			const idx = Math.floor((i / width) * gradient.length)
			bar += gradient[idx] + "█" + c.reset
		} else {
			bar += style("gray", "░")
		}
	}
	return bar
}

function runCommand(cmd, args = [], options = {}) {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, { stdio: "pipe", ...options })
		let stdout = ""
		let stderr = ""
		proc.stdout?.on("data", data => (stdout += data.toString()))
		proc.stderr?.on("data", data => (stderr += data.toString()))
		proc.on("close", code => {
			if (code === 0) resolve({ stdout, stderr })
			else reject(new Error(stderr || stdout || `Exit code ${code}`))
		})
	})
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

const args = process.argv.slice(2)
const jobs = parseInt(args[0]) || 8
const extraArgs = args.slice(1)

const testDir = path.join(process.cwd(), "test/parallel")
const testFiles = readdirSync(testDir)
	.filter(f => f.endsWith(".test.ts"))
	.map(f => path.join(testDir, f))

const results = {
	passed: 0,
	failed: 0,
	pending: 0,
	suites: [],
	failures: [],
}

function runTest(file) {
	return new Promise(resolve => {
		const basename = path.basename(file, ".test.ts")
		const startTime = Date.now()

		const proc = spawn("npx", ["hardhat", "test", "mocha", "--no-compile", ...extraArgs, "--", file], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, FORCE_COLOR: "1" },
		})

		let stdout = ""
		proc.stdout.on("data", data => (stdout += data.toString()))
		proc.stderr.on("data", data => (stdout += data.toString()))

		proc.on("close", code => {
			const duration = Date.now() - startTime

			const passMatch = stdout.match(/(\d+) passing/)
			const failMatch = stdout.match(/(\d+) failing/)
			const pendingMatch = stdout.match(/(\d+) pending/)

			resolve({
				file: basename,
				passed: passMatch ? parseInt(passMatch[1]) : 0,
				failed: failMatch ? parseInt(failMatch[1]) : 0,
				pending: pendingMatch ? parseInt(pendingMatch[1]) : 0,
				duration,
				stdout,
				code,
			})
		})
	})
}

function updateProgress(completed, total, elapsed) {
	const percent = Math.round((completed / total) * 100)
	const bar = createProgressBar(percent)

	const status =
		`  ${bar} ${style("brightWhite", String(percent).padStart(3))}% ` +
		`${style("gray", "│")} ` +
		`${style("brightGreen", "✓" + results.passed)} ` +
		`${style("brightRed", "✗" + results.failed)} ` +
		`${style("brightYellow", "○" + results.pending)} ` +
		`${style("gray", "│")} ` +
		`${style("cyan", completed + "/" + total)} ` +
		`${style("gray", "│")} ` +
		`${style("white", formatTime(elapsed))}`

	process.stdout.write(`\r${status}\x1b[K`)
}

function printResults(totalDuration) {
	console.log("\n")

	// Sort: failures first, then by duration desc
	const sorted = [...results.suites].sort((a, b) => {
		if (a.failed > 0 && b.failed === 0) return -1
		if (a.failed === 0 && b.failed > 0) return 1
		return b.duration - a.duration
	})

	// Header
	console.log(bold("brightWhite", "  ═══════════════════════════════════════════════════════════"))
	console.log(bold("brightWhite", "                         TEST RESULTS"))
	console.log(bold("brightWhite", "  ═══════════════════════════════════════════════════════════"))
	console.log()

	// Each suite
	for (const suite of sorted) {
		const icon = suite.failed > 0 ? style("brightRed", "✗") : style("brightGreen", "✓")
		const nameColor = suite.failed > 0 ? "brightRed" : "brightGreen"
		const name = style(nameColor, suite.file)
		const time = style("gray", `(${formatTime(suite.duration)})`)

		const counts = []
		if (suite.passed > 0) counts.push(style("green", `${suite.passed} passing`))
		if (suite.failed > 0) counts.push(style("red", `${suite.failed} failing`))
		if (suite.pending > 0) counts.push(style("yellow", `${suite.pending} pending`))

		console.log(`  ${icon} ${name} ${time}`)
		console.log(`      ${counts.join(style("gray", " · "))}`)
		console.log()
	}

	// Failures section with full details
	if (results.failures.length > 0) {
		console.log()
		console.log(bold("brightRed", "  ═══════════════════════════════════════════════════════════"))
		console.log(bold("brightRed", "                           FAILURES"))
		console.log(bold("brightRed", "  ═══════════════════════════════════════════════════════════"))

		for (const failure of results.failures) {
			console.log()
			console.log(style("brightRed", `  ✗ ${failure.file}`))
			console.log(style("gray", "  " + "─".repeat(60)))

			// Strip ANSI codes from mocha output for clean parsing
			const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, "")
			const rawOutput = stripAnsi(failure.stdout)
			const lines = rawOutput.split("\n")

			let inFailureBlock = false
			let printedLines = 0
			const maxLines = 30

			for (let i = 0; i < lines.length && printedLines < maxLines; i++) {
				const line = lines[i]
				const trimmed = line.trim()

				// Start capturing after "X failing" line
				if (line.match(/\d+ failing/)) {
					inFailureBlock = true
					continue
				}

				if (!inFailureBlock) continue

				// Skip empty lines at the start
				if (printedLines === 0 && trimmed === "") continue

				// Stop at "passing" line (end of failures)
				if (trimmed.match(/^\d+ passing/)) break

				// Numbered failure line (e.g., "1) Suite name")
				if (line.match(/^\s+\d+\)/)) {
					console.log(style("brightRed", `    ${trimmed}`))
					printedLines++
					continue
				}

				// Test hierarchy lines (indented)
				if (line.match(/^\s{6,}\S/) && !trimmed.startsWith("at ") && !trimmed.startsWith("+") && !trimmed.startsWith("-") && !trimmed.includes("expected")) {
					console.log(style("white", `       ${trimmed}`))
					printedLines++
					continue
				}

				// AssertionError line
				if (trimmed.startsWith("AssertionError") || trimmed.match(/^Error:/)) {
					console.log()
					console.log(style("red", `    ${trimmed}`))
					printedLines++
					continue
				}

				// "+ expected - actual" header
				if (trimmed === "+ expected - actual") {
					console.log(style("gray", `    ${trimmed}`))
					printedLines++
					continue
				}

				// Diff lines (expected/actual values)
				if (trimmed.startsWith("+")) {
					console.log(style("green", `    ${trimmed}`))
					printedLines++
					continue
				}
				if (trimmed.startsWith("-")) {
					console.log(style("red", `    ${trimmed}`))
					printedLines++
					continue
				}

				// Stack trace - show relevant test file lines
				if (trimmed.startsWith("at ") && trimmed.includes("test/")) {
					console.log()
					console.log(style("gray", `    ${trimmed}`))
					printedLines++
					break // Only show first relevant stack line
				}

				// Revert messages
				if (trimmed.includes("revert") || trimmed.includes("VM Exception") || trimmed.includes("reverted with")) {
					console.log(style("red", `    ${trimmed}`))
					printedLines++
					continue
				}
			}
		}
		console.log()
	}

	// Summary
	console.log()
	console.log(bold("brightWhite", "  ═══════════════════════════════════════════════════════════"))
	console.log(bold("brightWhite", "                           SUMMARY"))
	console.log(bold("brightWhite", "  ═══════════════════════════════════════════════════════════"))
	console.log()

	console.log(`  ${style("brightGreen", `✓ ${results.passed} passing`)}`)
	if (results.failed > 0) {
		console.log(`  ${style("brightRed", `✗ ${results.failed} failing`)}`)
	}
	if (results.pending > 0) {
		console.log(`  ${style("brightYellow", `○ ${results.pending} pending`)}`)
	}
	console.log(`  ${style("gray", `★ ${results.suites.length} test suites`)}`)
	console.log(`  ${style("gray", `→ ${formatTime(totalDuration)} total`)}`)

	// Final status
	console.log()
	if (results.failed === 0) {
		console.log(style("brightGreen", "  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓"))
		console.log(style("brightGreen", "  ┃") + bold("brightGreen", "        ✨ ALL TESTS PASSED! GREAT JOB! ✨               ") + style("brightGreen", "┃"))
		console.log(style("brightGreen", "  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛"))
	} else {
		console.log(style("brightRed", "  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓"))
		console.log(style("brightRed", "  ┃") + bold("brightRed", `      💥 ${results.failed} TEST(S) FAILED - PLEASE FIX! 💥             `) + style("brightRed", "┃"))
		console.log(style("brightRed", "  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛"))
	}
	console.log()
}

async function disableMuonSignatures() {
	console.log(style("cyan", "  ⟳ Disabling Muon signature checks..."))
	try {
		const result = await runCommand("python3", ["utils/update_sig_checks.py", "1"], {
			env: { ...process.env, PYTHONPATH: "." }
		})
		const count = (result.stdout.match(/Removed/g) || []).length
		console.log(style("brightGreen", `  ✓ Disabled signature checks in ${count} files`))
	} catch (e) {
		console.error(style("brightRed", `  ✗ Failed to disable signature checks: ${e.message}`))
		throw e
	}
}

async function enableMuonSignatures() {
	console.log(style("cyan", "  ⟳ Re-enabling Muon signature checks..."))
	try {
		const result = await runCommand("python3", ["utils/update_sig_checks.py", "0"], {
			env: { ...process.env, PYTHONPATH: "." }
		})
		const count = (result.stdout.match(/Added/g) || []).length
		console.log(style("brightGreen", `  ✓ Re-enabled signature checks in ${count} files`))
	} catch (e) {
		console.error(style("brightRed", `  ✗ Failed to re-enable signature checks: ${e.message}`))
	}
}

async function compile() {
	console.log(style("cyan", "  ⟳ Compiling contracts..."))
	try {
		execSync("npx hardhat compile --quiet", { stdio: "pipe" })
		console.log(style("brightGreen", "  ✓ Compilation complete!"))
	} catch (e) {
		console.error(style("brightRed", "  ✗ Compilation failed!"))
		throw e
	}
}

async function main() {
	printBanner()

	console.log(style("gray", `  → Test files: ${style("white", testFiles.length)}`))
	console.log(style("gray", `  → Workers: ${style("white", jobs)}`))
	console.log()

	// Disable Muon signatures
	await disableMuonSignatures()
	console.log()

	// Compile
	await compile()
	console.log()

	console.log(style("cyan", "  ⟳ Running tests..."))
	console.log()

	const startTime = Date.now()
	const pending = [...testFiles]
	const running = new Map()
	let completed = 0

	// Progress update interval
	const progressInterval = setInterval(() => {
		updateProgress(completed, testFiles.length, Date.now() - startTime)
	}, 100)

	// Run tests
	try {
		while (pending.length > 0 || running.size > 0) {
			while (pending.length > 0 && running.size < jobs) {
				const file = pending.shift()
				const promise = runTest(file).then(result => {
					running.delete(file)
					completed++

					results.passed += result.passed
					results.failed += result.failed
					results.pending += result.pending
					results.suites.push(result)

					if (result.failed > 0) {
						results.failures.push(result)
					}

					return result
				})
				running.set(file, promise)
			}

			if (running.size > 0) {
				await Promise.race(running.values())
			}
		}
	} finally {
		clearInterval(progressInterval)
		updateProgress(completed, testFiles.length, Date.now() - startTime)

		const totalDuration = Date.now() - startTime
		printResults(totalDuration)

		// Re-enable Muon signatures
		console.log()
		await enableMuonSignatures()
		console.log()
	}

	process.exit(results.failed > 0 ? 1 : 0)
}

process.on("SIGINT", async () => {
	console.log(style("yellow", "\n\n  Interrupted by user"))
	console.log()
	await enableMuonSignatures()
	process.exit(130)
})

process.on("uncaughtException", async err => {
	console.error(style("red", `\n  Error: ${err.message}`))
	await enableMuonSignatures()
	process.exit(1)
})

main().catch(async err => {
	console.error(style("red", `\n  Error: ${err.message}`))
	await enableMuonSignatures()
	process.exit(1)
})
