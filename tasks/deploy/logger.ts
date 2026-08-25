// Deployment logger utility. Human-readable output is intentionally the default for
// operator runs; tests set DEPLOY_LOG_LEVEL=silent in their shared connection helper.
import fs from "node:fs"

export type LogLevel = "silent" | "minimal" | "verbose"

const LOG_LEVELS = new Set<LogLevel>(["silent", "minimal", "verbose"])
// NO_COLOR disables colour when present and non-empty (no-color.org); an empty value is
// ignored, which is also how the operator CLI reads it.
const colorsEnabled = !process.env.NO_COLOR && process.env.TERM !== "dumb" && Boolean(process.stdout.isTTY)

const COLORS = {
	reset: "\x1b[0m",
	bright: "\x1b[1m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
}

const SYMBOLS = {
	check: "✓",
	arrow: "→",
	bullet: "•",
	line: "─",
}

function color(value: string, code: string): string {
	return colorsEnabled ? `${code}${value}${COLORS.reset}` : value
}

function parseLogLevel(value: unknown): LogLevel {
	const candidate = value === undefined || value === "" ? "verbose" : String(value)
	if (!LOG_LEVELS.has(candidate as LogLevel)) {
		throw new Error(`DEPLOY_LOG_LEVEL must be silent, minimal, or verbose; received ${JSON.stringify(value)}.`)
	}
	return candidate as LogLevel
}

// Resolved on first use, not at import: hardhat.config.ts loads .env in its body, which ESM
// runs *after* every imported task module. Reading at import time silently ignored a
// DEPLOY_LOG_LEVEL set in .env.
let explicitLevel: LogLevel | null = null
let envLevelCache: { raw: string | undefined; level: LogLevel } | null = null

function resolveLevel(): LogLevel {
	if (explicitLevel !== null) return explicitLevel
	const raw = process.env.DEPLOY_LOG_LEVEL
	if (envLevelCache === null || envLevelCache.raw !== raw) envLevelCache = { raw, level: parseLogLevel(raw) }
	return envLevelCache.level
}

export function setLogLevel(level: LogLevel): void {
	explicitLevel = parseLogLevel(level)
}

export function getLogLevel(): LogLevel {
	return resolveLevel()
}

function separator(char = SYMBOLS.line, length = 60): string {
	return color(char.repeat(length), COLORS.dim)
}

function formatAddress(address: string): string {
	return color(address, COLORS.cyan)
}

function formatContract(name: string): string {
	return color(name, COLORS.bright)
}

/** Structured operator event channel. stdout remains human-readable for non-CLI callers. */
export function emitTaskEvent(type: string, detail: Record<string, unknown> = {}): void {
	const rawFd = process.env.SYMMIO_TASK_EVENT_FD
	if (!rawFd || !/^\d+$/.test(rawFd)) return
	try {
		fs.writeSync(Number(rawFd), `${JSON.stringify({ type, detail })}\n`)
	} catch {
		// The event channel is presentation-only. Deployment receipts/checkpoints remain
		// authoritative and must never fail because a parent renderer disappeared.
	}
}

export const logger = {
	// Errors and warnings remain visible even in silent mode. Silent suppresses routine
	// progress, never evidence that a deployment is unsafe or incomplete.
	error: (...args: any[]) => console.error(color("[ERROR]", COLORS.red), ...args),
	warn: (...args: any[]) => {
		emitTaskEvent("warning", { message: args.map(value => String(value)).join(" ") })
		console.warn(color("[WARN]", COLORS.yellow), ...args)
	},

	// Minimal and verbose lifecycle output.
	info: (...args: any[]) => {
		if (resolveLevel() !== "silent") console.log(...args)
	},

	debug: (...args: any[]) => {
		if (resolveLevel() === "verbose") console.log(`  ${color(SYMBOLS.bullet, COLORS.dim)}`, ...args)
	},

	section: (title: string) => {
		emitTaskEvent("phase.started", { title })
		if (resolveLevel() !== "verbose") return
		console.log("")
		console.log(separator())
		console.log(color(`  ${title}`, `${COLORS.bright}${COLORS.blue}`))
		console.log(separator())
	},

	subsection: (title: string) => {
		emitTaskEvent("step.detail", { title })
		if (resolveLevel() === "verbose") console.log(`\n  ${color(`${SYMBOLS.arrow} ${title}`, COLORS.magenta)}`)
	},

	deployed: (contractName: string, address: string) => {
		emitTaskEvent("contract.deployed", { contractName, address })
		if (resolveLevel() === "silent") return
		console.log(`  ${color(SYMBOLS.check, COLORS.green)} ${formatContract(contractName)} ${color("at", COLORS.dim)} ${formatAddress(address)}`)
	},

	/** A contract recovered from the checkpoint. Same operator meaning as `deployed` for
	 *  progress purposes, so it travels on the structured channel too. */
	reused: (contractName: string, address: string) => {
		emitTaskEvent("contract.reused", { contractName, address })
		if (resolveLevel() === "silent") return
		console.log(
			`  ${color("\u23ed", COLORS.dim)} ${formatContract(contractName)} ${color("already deployed at", COLORS.dim)} ${formatAddress(address)}`,
		)
	},

	complete: (title: string, contracts: Array<{ name: string; address: string }>) => {
		if (resolveLevel() === "silent") return
		if (resolveLevel() === "minimal") {
			console.log(`  ${color(SYMBOLS.check, COLORS.green)} ${title} complete`)
			for (const { name, address } of contracts) console.log(`    ${name}: ${address}`)
			return
		}

		console.log("")
		console.log(separator("═", 60))
		console.log(color(`  ${SYMBOLS.check} ${title} Complete`, `${COLORS.bright}${COLORS.green}`))
		console.log(separator("═", 60))
		console.log(`\n  ${color("Deployed Contracts:", COLORS.dim)}`)
		for (const { name, address } of contracts) {
			console.log(`    ${color(SYMBOLS.bullet, COLORS.dim)} ${formatContract(name)}: ${formatAddress(address)}`)
		}
		console.log("")
	},

	progress: (current: number, total: number, message: string) => {
		emitTaskEvent("step.progress", { current, total, message })
		if (resolveLevel() === "verbose") console.log(`  ${color(`[${current}/${total}]`, COLORS.dim)} ${message}`)
	},
}
