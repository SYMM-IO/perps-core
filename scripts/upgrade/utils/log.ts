/**
 * Structured logging utility for upgrade & migration scripts.
 *
 * Provides colored, step-numbered output with timing, consistent
 * formatting for deployed contracts, key-value pairs, and summaries.
 */

// ─── ANSI Colors ─────────────────────────────────────────────────────────────

const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	white: "\x1b[37m",
} as const

const colorsEnabled = process.env.NO_COLOR === undefined && process.env.TERM !== "dumb" && Boolean(process.stdout.isTTY)
const C = Object.fromEntries(Object.entries(ANSI).map(([name, value]) => [name, colorsEnabled ? value : ""])) as typeof ANSI

export type ScriptLogLevel = "silent" | "minimal" | "verbose"
const validLevels = new Set<ScriptLogLevel>(["silent", "minimal", "verbose"])
const configuredLevel = process.env.SCRIPT_LOG_LEVEL || process.env.DEPLOY_LOG_LEVEL || "verbose"
if (!validLevels.has(configuredLevel as ScriptLogLevel)) {
	throw new Error(`SCRIPT_LOG_LEVEL must be silent, minimal, or verbose; received ${JSON.stringify(configuredLevel)}.`)
}
let currentLevel = configuredLevel as ScriptLogLevel

function output(...args: unknown[]): void {
	if (currentLevel !== "silent") console.log(...args)
}

function verboseOutput(...args: unknown[]): void {
	if (currentLevel === "verbose") console.log(...args)
}

const SYM = {
	check: "\u2713",
	cross: "\u2717",
	arrow: "\u2192",
	bullet: "\u2022",
	warn: "\u26A0",
	line: "\u2500",
	doubleLine: "\u2550",
} as const

// ─── Formatting helpers ──────────────────────────────────────────────────────

function pad(str: string, len: number): string {
	return str.length >= len ? str : str + " ".repeat(len - str.length)
}

function ruleChar(char: string, length: number): string {
	return char.repeat(length)
}

function commaNumber(n: number): string {
	return n.toLocaleString("en-US")
}

function formatMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
	const mins = Math.floor(ms / 60_000)
	const secs = ((ms % 60_000) / 1000).toFixed(1)
	return `${mins}m ${secs}s`
}

function truncAddr(address: string): string {
	if (address.length <= 14) return address
	return `${address.slice(0, 6)}...${address.slice(-4)}`
}

// ─── Timer ───────────────────────────────────────────────────────────────────

export type Timer = {
	/** Elapsed time in milliseconds */
	ms(): number
	/** Formatted elapsed string (e.g. "2.3s") */
	fmt(): string
	/** Wall-clock start time in epoch ms */
	startMs(): number
	/** ISO-8601 UTC timestamp of when this timer started */
	startedAt(): string
	/** ISO-8601 UTC timestamp of "right now" (useful as a finishedAt) */
	nowIso(): string
}

function createTimer(): Timer {
	const start = Date.now()
	return {
		ms: () => Date.now() - start,
		fmt: () => formatMs(Date.now() - start),
		startMs: () => start,
		startedAt: () => new Date(start).toISOString(),
		nowIso: () => new Date().toISOString(),
	}
}

// ─── Step tracking ───────────────────────────────────────────────────────────

let _totalSteps = 0
let _currentStep = 0

// ─── Public API ──────────────────────────────────────────────────────────────

export const log = {
	// ── Banners ──────────────────────────────────────────────────────────

	/** Top-level script header (e.g., "Symmio v0.8.5 Fork Upgrade") */
	header(title: string): void {
		const width = 64
		const border = C.blue + ruleChar(SYM.doubleLine, width) + C.reset
		output("")
		output(border)
		output(`${C.bold}${C.blue}  ${title}${C.reset}`)
		output(border)
	},

	/** Set total step count for step() numbering */
	setSteps(total: number): void {
		_totalSteps = total
		_currentStep = 0
	},

	/**
	 * Step separator with number, title, and ISO start timestamp.
	 * Returns a Timer whose startedAt() / nowIso() / ms() feed the per-step
	 * timestamps in report JSON.
	 *
	 *   ── Step 3/11 ─ Pause system ────────────  @ 2026-04-22T14:03:11Z ─
	 */
	step(title: string): Timer {
		_currentStep++
		const t = createTimer()
		const label = _totalSteps > 0 ? `Step ${_currentStep}/${_totalSteps}` : `Step ${_currentStep}`
		const startedAt = t.startedAt()
		const prefix = `${C.dim}${SYM.line}${SYM.line}${C.reset} ${C.bold}${label}${C.reset} ${C.dim}${SYM.line}${C.reset} ${C.bold}${title}${C.reset} `
		const suffix = `${C.dim} @ ${startedAt}${C.reset}`
		// Rule tail is shorter because we're appending the ISO timestamp.
		const usedLen = label.length + title.length + startedAt.length + 9
		const tailLen = Math.max(0, 70 - usedLen)
		const tail = C.dim + ruleChar(SYM.line, tailLen) + C.reset
		output("")
		output(prefix + tail + suffix)
		return t
	},

	/** Print step elapsed time + finish ISO timestamp (call after step work is done). */
	stepDone(timer: Timer): void {
		output(`${C.dim}  (${timer.fmt()}) finished at ${timer.nowIso()}${C.reset}`)
	},

	// ── Messages ─────────────────────────────────────────────────────────

	/** Informational message (indented) */
	info(msg: string): void {
		output(`  ${msg}`)
	},

	/** Success message with green checkmark */
	ok(msg: string): void {
		output(`  ${C.green}${SYM.check}${C.reset} ${msg}`)
	},

	/** Warning message */
	warn(msg: string): void {
		console.warn(`  ${C.yellow}${SYM.warn} ${msg}${C.reset}`)
	},

	/** Error message */
	error(msg: string): void {
		console.error(`  ${C.red}${SYM.cross} ${msg}${C.reset}`)
	},

	/** Detail line (further indented, dimmed bullet) */
	detail(msg: string): void {
		verboseOutput(`    ${C.dim}${SYM.bullet}${C.reset} ${msg}`)
	},

	/** Blank line */
	blank(): void {
		output("")
	},

	// ── Key-value display ────────────────────────────────────────────────

	/** Key-value pair:  "  Diamond:  0x1234...5678" */
	kv(key: string, value: string, indent = 2): void {
		const spaces = " ".repeat(indent)
		const paddedKey = pad(key + ":", 24)
		output(`${spaces}${C.dim}${paddedKey}${C.reset}${value}`)
	},

	// ── Contract deployment ──────────────────────────────────────────────

	/**
	 * Deployed contract line:
	 *   ✓ AccountFacet            0x579a...FbA
	 *   ✓ AccountFacet            0x579a...FbA  (cached)
	 */
	deployed(name: string, address: string, cached = false): void {
		const paddedName = pad(name, 32)
		const suffix = cached ? `  ${C.dim}(cached)${C.reset}` : ""
		output(`  ${C.green}${SYM.check}${C.reset} ${C.bold}${paddedName}${C.reset}${C.cyan}${address}${C.reset}${suffix}`)
	},

	/**
	 * Skipped deployment line (when resuming):
	 *   → AccountFacet            0x579a...FbA  (already deployed)
	 */
	skipped(name: string, address: string): void {
		const paddedName = pad(name, 32)
		verboseOutput(`  ${C.dim}${SYM.arrow} ${paddedName}${C.cyan}${address}${C.reset}  ${C.dim}(already deployed)${C.reset}`)
	},

	/**
	 * Progress line for batch operations:
	 *   [3/28] AccountFacet            0x579a...FbA
	 */
	progress(current: number, total: number, msg: string): void {
		const label = `${C.dim}[${current}/${total}]${C.reset}`
		verboseOutput(`  ${label} ${msg}`)
	},

	// ── Tables ───────────────────────────────────────────────────────────

	/** Simple stats display as aligned key-value pairs */
	stats(entries: Array<[string, string | number]>): void {
		const maxKeyLen = Math.max(...entries.map(([k]) => k.length))
		for (const [key, value] of entries) {
			const paddedKey = pad(key, maxKeyLen + 2)
			const formatted = typeof value === "number" ? commaNumber(value) : value
			output(`    ${C.dim}${paddedKey}${C.reset}${formatted}`)
		}
	},

	// ── Summary ──────────────────────────────────────────────────────────

	/** Success summary box at end of script */
	success(title: string, entries: Array<[string, string]>): void {
		const width = 64
		const border = C.green + ruleChar(SYM.doubleLine, width) + C.reset
		output("")
		output(border)
		output(`${C.bold}${C.green}  ${SYM.check} ${title}${C.reset}`)
		output(border)
		if (entries.length > 0) {
			const maxKeyLen = Math.max(...entries.map(([k]) => k.length))
			for (const [key, value] of entries) {
				const paddedKey = pad(key + ":", maxKeyLen + 2)
				output(`  ${C.dim}${paddedKey}${C.reset}${value}`)
			}
		}
		output("")
	},

	/** Failure summary */
	failure(title: string, errorMsg: string): void {
		const width = 64
		const border = C.red + ruleChar(SYM.doubleLine, width) + C.reset
		console.error("")
		console.error(border)
		console.error(`${C.bold}${C.red}  ${SYM.cross} ${title}${C.reset}`)
		console.error(border)
		console.error(`  ${C.red}${errorMsg}${C.reset}`)
		console.error("")
	},

	/** "Next steps" block */
	nextSteps(steps: string[]): void {
		output(`  ${C.bold}Next steps:${C.reset}`)
		steps.forEach((s, i) => {
			output(`    ${i + 1}. ${s}`)
		})
		output("")
	},

	// ── Utilities ────────────────────────────────────────────────────────

	/** Format an address with cyan color */
	addr(address: string): string {
		return `${C.cyan}${address}${C.reset}`
	},

	/** Format a contract/facet name bold */
	name(n: string): string {
		return `${C.bold}${n}${C.reset}`
	},

	/** Truncate address to 0x1234...5678 */
	truncAddr: truncAddr,

	/** Format milliseconds to human string */
	formatMs: formatMs,

	/** Format number with comma separators */
	commaNumber: commaNumber,

	/** Create a standalone timer */
	timer: createTimer,

	/** Reset step counter (for scripts that share the module) */
	resetSteps(): void {
		_totalSteps = 0
		_currentStep = 0
	},

	/** Override verbosity for embedded/test callers. */
	setLevel(level: ScriptLogLevel): void {
		if (!validLevels.has(level)) throw new Error(`Invalid script log level: ${level}`)
		currentLevel = level
	},
}
