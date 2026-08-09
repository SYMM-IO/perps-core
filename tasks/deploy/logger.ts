// Deployment logger utility. Human-readable output is intentionally the default for
// operator runs; tests set DEPLOY_LOG_LEVEL=silent in their shared connection helper.

export type LogLevel = "silent" | "minimal" | "verbose"

const LOG_LEVELS = new Set<LogLevel>(["silent", "minimal", "verbose"])
const colorsEnabled = process.env.NO_COLOR === undefined && process.env.TERM !== "dumb" && Boolean(process.stdout.isTTY)

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

let currentLevel = parseLogLevel(process.env.DEPLOY_LOG_LEVEL)

export function setLogLevel(level: LogLevel): void {
	currentLevel = parseLogLevel(level)
}

export function getLogLevel(): LogLevel {
	return currentLevel
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

export const logger = {
	// Errors and warnings remain visible even in silent mode. Silent suppresses routine
	// progress, never evidence that a deployment is unsafe or incomplete.
	error: (...args: any[]) => console.error(color("[ERROR]", COLORS.red), ...args),
	warn: (...args: any[]) => console.warn(color("[WARN]", COLORS.yellow), ...args),

	// Minimal and verbose lifecycle output.
	info: (...args: any[]) => {
		if (currentLevel !== "silent") console.log(...args)
	},

	debug: (...args: any[]) => {
		if (currentLevel === "verbose") console.log(`  ${color(SYMBOLS.bullet, COLORS.dim)}`, ...args)
	},

	section: (title: string) => {
		if (currentLevel !== "verbose") return
		console.log("")
		console.log(separator())
		console.log(color(`  ${title}`, `${COLORS.bright}${COLORS.blue}`))
		console.log(separator())
	},

	subsection: (title: string) => {
		if (currentLevel === "verbose") console.log(`\n  ${color(`${SYMBOLS.arrow} ${title}`, COLORS.magenta)}`)
	},

	deployed: (contractName: string, address: string) => {
		if (currentLevel === "silent") return
		console.log(`  ${color(SYMBOLS.check, COLORS.green)} ${formatContract(contractName)} ${color("at", COLORS.dim)} ${formatAddress(address)}`)
	},

	complete: (title: string, contracts: Array<{ name: string; address: string }>) => {
		if (currentLevel === "silent") return
		if (currentLevel === "minimal") {
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
		if (currentLevel === "verbose") console.log(`  ${color(`[${current}/${total}]`, COLORS.dim)} ${message}`)
	},
}
