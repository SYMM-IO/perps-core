import winston, { format, transports } from "winston"

import { withIsolatedRandomSequence } from "./RandomUtils.js"

const customLevels = {
	levels: {
		error: 0,
		warning: 1,
		contractLogs: 2,
		info: 3,
		debug: 4,
		detailedDebug: 5,
		detailedEventDebug: 6,
	},
	colors: {
		error: "red",
		warning: "yellow",
		info: "green",
		contractLogs: "green",
		debug: "blue",
		detailedDebug: "cyan",
		detailedEventDebug: "cyan",
	},
} as const

type LogLevel = keyof typeof customLevels.levels

function configuredLogLevel(): LogLevel {
	const setting = process.env.TEST_MODE === "fuzz" ? "FUZZ_LEGACY_LOG_LEVEL" : "LOG_LEVEL"
	const configured = process.env[setting]
	let level = configured ?? "info"
	if (process.env.TEST_MODE === "static") level = "error"
	if (process.env.TEST_MODE === "fuzz") level = configured ?? "error"

	if (!(level in customLevels.levels)) {
		throw new Error(`${setting} must be one of ${Object.keys(customLevels.levels).join(", ")}, received ${level}`)
	}
	return level as LogLevel
}

const logLevel = configuredLogLevel()
const useConsoleColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined
const consoleFormat = format.combine(
	...(useConsoleColor ? [format.colorize()] : []),
	format.timestamp(),
	format.printf(({ level, message, timestamp }) => `${timestamp} ${level}: ${message}`),
)

const loggerTransports: any[] = [
	new transports.Console({
		level: logLevel,
		format: consoleFormat,
	}),
]

const detailedLogFile = process.env.DETAILED_LOG_FILE
if (detailedLogFile || logLevel === "detailedDebug" || logLevel === "detailedEventDebug") {
	loggerTransports.push(
		new transports.File({
			filename: detailedLogFile || "detailedDebug.log",
			level: logLevel,
			format: format.combine(
				format.timestamp(),
				format.printf(({ level, message, timestamp }) => `${timestamp} ${level}: ${message}`),
			),
		}),
	)
}

export const logger: any = winston.createLogger({
	levels: customLevels.levels,
	transports: loggerTransports,
})

export interface DetailedDebugLogger {
	isLevelEnabled(level: "detailedDebug"): boolean
	detailedDebug(message: unknown): unknown
}

export type DetailedDebugMessageFactory = () => unknown | Promise<unknown>

export async function logDetailedDebug(
	createMessage: DetailedDebugMessageFactory,
	target: DetailedDebugLogger = logger as DetailedDebugLogger,
): Promise<void> {
	if (!target.isLevelEnabled("detailedDebug")) return
	target.detailedDebug(await withIsolatedRandomSequence(createMessage))
}

winston.addColors(customLevels.colors)
