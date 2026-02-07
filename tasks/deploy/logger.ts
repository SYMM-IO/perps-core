// Deployment logger utility
// Controls verbosity of deployment logs based on environment

export type LogLevel = "silent" | "minimal" | "verbose"

let currentLevel: LogLevel = (process.env.DEPLOY_LOG_LEVEL as LogLevel) || "minimal"

export function setLogLevel(level: LogLevel) {
	currentLevel = level
}

export function getLogLevel(): LogLevel {
	return currentLevel
}

// Silent mode - no output
// Minimal mode - only summary output
// Verbose mode - all output with formatting

const COLORS = {
	reset: "\x1b[0m",
	bright: "\x1b[1m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
}

const SYMBOLS = {
	check: "✓",
	arrow: "→",
	bullet: "•",
	line: "─",
}

function separator(char = SYMBOLS.line, length = 60) {
	return COLORS.dim + char.repeat(length) + COLORS.reset
}

function formatAddress(address: string) {
	return `${COLORS.cyan}${address}${COLORS.reset}`
}

function formatContract(name: string) {
	return `${COLORS.bright}${name}${COLORS.reset}`
}

export const logger = {
	// Always show (errors and important info)
	error: (...args: any[]) => console.error(`${COLORS.yellow}[ERROR]${COLORS.reset}`, ...args),

	// Show in minimal and verbose mode
	info: (...args: any[]) => {
		if (currentLevel !== "silent") {
			console.log(...args)
		}
	},

	// Show only in verbose mode
	debug: (...args: any[]) => {
		if (currentLevel === "verbose") {
			console.log(`  ${COLORS.dim}${SYMBOLS.bullet}${COLORS.reset}`, ...args)
		}
	},

	// Section header with separator
	section: (title: string) => {
		if (currentLevel === "verbose") {
			console.log("")
			console.log(separator())
			console.log(`${COLORS.bright}${COLORS.blue}  ${title}${COLORS.reset}`)
			console.log(separator())
		}
	},

	// Subsection header
	subsection: (title: string) => {
		if (currentLevel === "verbose") {
			console.log("")
			console.log(`  ${COLORS.magenta}${SYMBOLS.arrow} ${title}${COLORS.reset}`)
		}
	},

	// Contract deployed message - always show in minimal and verbose modes
	deployed: (contractName: string, address: string) => {
		if (currentLevel !== "silent") {
			console.log(`  ${COLORS.green}${SYMBOLS.check}${COLORS.reset} ${formatContract(contractName)} ${COLORS.dim}at${COLORS.reset} ${formatAddress(address)}`)
		}
	},

	// Deployment complete summary
	complete: (title: string, contracts: Array<{ name: string; address: string }>) => {
		if (currentLevel === "silent") return

		if (currentLevel === "verbose") {
			console.log("")
			console.log(separator("═", 60))
			console.log(`${COLORS.bright}${COLORS.green}  ${SYMBOLS.check} ${title} Complete${COLORS.reset}`)
			console.log(separator("═", 60))
			console.log("")
			console.log(`  ${COLORS.dim}Deployed Contracts:${COLORS.reset}`)
			for (const { name, address } of contracts) {
				console.log(`    ${COLORS.dim}${SYMBOLS.bullet}${COLORS.reset} ${formatContract(name)}: ${formatAddress(address)}`)
			}
			console.log("")
		}
	},

	// Progress indicator for batch operations
	progress: (current: number, total: number, message: string) => {
		if (currentLevel === "verbose") {
			console.log(`  ${COLORS.dim}[${current}/${total}]${COLORS.reset} ${message}`)
		}
	},
}
