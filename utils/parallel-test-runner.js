#!/usr/bin/env node

import { spawn, execSync } from "child_process"
import { readdirSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Colors
const colors = {
	reset: "\x1b[0m",
	bright: "\x1b[1m",
	dim: "\x1b[2m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
}

const c = (color, text) => `${colors[color]}${text}${colors.reset}`

// Parse args
const args = process.argv.slice(2)
const jobs = parseInt(args[0]) || 8
const extraArgs = args.slice(1)

// Get test files
const testDir = path.join(process.cwd(), "test/parallel")
const testFiles = readdirSync(testDir)
	.filter(f => f.endsWith(".test.ts"))
	.map(f => path.join(testDir, f))

console.log(c("cyan", `\n  Running ${testFiles.length} test files with ${jobs} parallel workers...\n`))

// Compile first
console.log(c("gray", "  Compiling contracts..."))
try {
	execSync("npx hardhat compile --quiet", { stdio: "inherit" })
} catch (e) {
	console.error(c("red", "  Compilation failed"))
	process.exit(1)
}
console.log(c("green", "  ✓ Compilation complete\n"))

// Results tracking
const results = {
	passed: 0,
	failed: 0,
	pending: 0,
	duration: 0,
	suites: [],
	failures: [],
}

// Run a single test file
function runTest(file) {
	return new Promise(resolve => {
		const basename = path.basename(file, ".test.ts")
		const startTime = Date.now()

		const proc = spawn("npx", ["hardhat", "test", "mocha", "--no-compile", ...extraArgs, "--", file], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, FORCE_COLOR: "1" },
		})

		let stdout = ""
		let stderr = ""

		proc.stdout.on("data", data => {
			stdout += data.toString()
		})

		proc.stderr.on("data", data => {
			stderr += data.toString()
		})

		proc.on("close", code => {
			const duration = Date.now() - startTime

			// Parse results from output
			const passMatch = stdout.match(/(\d+) passing/)
			const failMatch = stdout.match(/(\d+) failing/)
			const pendingMatch = stdout.match(/(\d+) pending/)

			const passed = passMatch ? parseInt(passMatch[1]) : 0
			const failed = failMatch ? parseInt(failMatch[1]) : 0
			const pending = pendingMatch ? parseInt(pendingMatch[1]) : 0

			resolve({
				file: basename,
				passed,
				failed,
				pending,
				duration,
				stdout,
				stderr,
				code,
			})
		})
	})
}

// Run tests in parallel with job limit
async function runAllTests() {
	const startTime = Date.now()
	const pending = [...testFiles]
	const running = new Map()
	const completed = []

	const printProgress = () => {
		const done = completed.length
		const total = testFiles.length
		const pct = Math.round((done / total) * 100)
		process.stdout.write(`\r  Progress: ${c("cyan", `${done}/${total}`)} (${pct}%) | ` + `${c("green", `✓ ${results.passed}`)} | ` + `${c("red", `✗ ${results.failed}`)} | ` + `${c("yellow", `○ ${results.pending}`)}    `)
	}

	while (pending.length > 0 || running.size > 0) {
		// Start new jobs up to limit
		while (pending.length > 0 && running.size < jobs) {
			const file = pending.shift()
			const promise = runTest(file).then(result => {
				running.delete(file)
				completed.push(result)

				results.passed += result.passed
				results.failed += result.failed
				results.pending += result.pending
				results.duration += result.duration
				results.suites.push(result)

				if (result.failed > 0) {
					results.failures.push(result)
				}

				printProgress()
				return result
			})
			running.set(file, promise)
		}

		// Wait for at least one to complete
		if (running.size > 0) {
			await Promise.race(running.values())
		}
	}

	const totalDuration = Date.now() - startTime
	console.log("\n")

	// Print summary header
	console.log(c("bright", "  ══════════════════════════════════════════════════════════"))
	console.log(c("bright", "                        TEST RESULTS"))
	console.log(c("bright", "  ══════════════════════════════════════════════════════════\n"))

	// Print each suite result
	for (const suite of results.suites) {
		const status = suite.failed > 0 ? c("red", "✗") : c("green", "✓")
		const name = suite.failed > 0 ? c("red", suite.file) : c("green", suite.file)
		const time = c("gray", `(${(suite.duration / 1000).toFixed(1)}s)`)
		const counts = `${c("green", suite.passed + " passing")}` + (suite.failed > 0 ? `, ${c("red", suite.failed + " failing")}` : "") + (suite.pending > 0 ? `, ${c("yellow", suite.pending + " pending")}` : "")

		console.log(`  ${status} ${name} ${time}`)
		console.log(`    ${counts}\n`)
	}

	// Print failures in detail
	if (results.failures.length > 0) {
		console.log(c("red", "\n  ══════════════════════════════════════════════════════════"))
		console.log(c("red", "                         FAILURES"))
		console.log(c("red", "  ══════════════════════════════════════════════════════════\n"))

		for (const failure of results.failures) {
			console.log(c("red", `  ─── ${failure.file} ───\n`))
			// Extract and print failure details from stdout
			const failureOutput = failure.stdout.split("\n").filter(line => line.includes("AssertionError") || line.includes("Error:") || line.includes("expected") || line.includes("actual") || line.includes("    at ") || line.match(/^\s+\d+\)/))
			console.log(failureOutput.join("\n"))
			console.log("")
		}
	}

	// Print final summary
	console.log(c("bright", "  ══════════════════════════════════════════════════════════"))
	console.log(c("bright", "                          SUMMARY"))
	console.log(c("bright", "  ══════════════════════════════════════════════════════════\n"))

	console.log(`  ${c("green", `${results.passed} passing`)}`)
	if (results.failed > 0) console.log(`  ${c("red", `${results.failed} failing`)}`)
	if (results.pending > 0) console.log(`  ${c("yellow", `${results.pending} pending`)}`)
	console.log(`  ${c("gray", `${(totalDuration / 1000).toFixed(1)}s total (${(results.duration / 1000).toFixed(1)}s test time)`)}`)
	console.log("")

	process.exit(results.failed > 0 ? 1 : 0)
}

runAllTests().catch(err => {
	console.error(c("red", `Error: ${err.message}`))
	process.exit(1)
})
