import { createHash, type Hash } from "node:crypto"

import type {
	FuzzFailure,
	FuzzCornerOperation,
	FuzzLogFormat,
	FuzzLogLevel,
	FuzzModelEvent,
	FuzzQueueSnapshot,
	FuzzRootResult,
	FuzzRunConfig,
	FuzzRunResult,
	FuzzSetupInfo,
	FuzzStopSignal,
} from "../models/FuzzLogTypes.js"
import { FUZZ_CORNER_OPERATIONS } from "../models/FuzzLogTypes.js"
import {
	createFuzzDashboardRecorderFromEnv,
	type FuzzDashboardFinal,
	type FuzzDashboardProjection,
	type FuzzDashboardRecorder,
} from "./FuzzDashboardReporter.js"
import { FuzzOperationCoverageTracker, type FuzzOperationCoverage, type FuzzOperationCounts } from "./FuzzOperationCoverage.js"
import { FUZZ_QUOTE_STATUS_NAMES, FuzzQuoteInventoryTracker, type FuzzQuoteInventory, type FuzzQuoteStatusName } from "./FuzzQuoteInventory.js"

export type {
	FuzzActionPhase,
	FuzzCornerOperation,
	FuzzFailure,
	FuzzFailureBoundary,
	FuzzLogFormat,
	FuzzLogLevel,
	FuzzModelEvent,
	FuzzOperationPhase,
	FuzzQueueSnapshot,
	FuzzRootResult,
	FuzzRunConfig,
	FuzzRunMode,
	FuzzRunResult,
	FuzzSetupInfo,
	FuzzStopSignal,
} from "../models/FuzzLogTypes.js"

export type FuzzLogColor = "auto" | "always" | "never"

export type FuzzLogWriter = (line: string) => void

export type FuzzLogClock = () => number

export type FuzzLogEnvironment = Readonly<Record<string, string | undefined>>

export type FuzzTerminalSink = {
	columns: number
	replace(lines: readonly string[]): void
	clear(): void
}

export type FuzzRunLoggerOptions = {
	level?: FuzzLogLevel
	format?: FuzzLogFormat
	writer?: FuzzLogWriter
	clock?: FuzzLogClock
	color?: boolean
	recentActionLimit?: number
	terminal?: FuzzTerminalSink
	dashboardRecorder?: FuzzDashboardRecorder
}

type CompleteFuzzRunLoggerOptions = {
	level: FuzzLogLevel
	format: FuzzLogFormat
	writer: FuzzLogWriter
	clock: FuzzLogClock
	color: boolean
	recentActionLimit: number
	terminal?: FuzzTerminalSink
	dashboardRecorder?: FuzzDashboardRecorder
}

type ErrorWithCause = Error & { cause?: unknown }

type AggregateErrorLike = ErrorWithCause & { errors: readonly unknown[] }

type JsonSafe =
	| null
	| boolean
	| number
	| string
	| JsonSafe[]
	| {
			[key: string]: JsonSafe
	  }

const LOG_LEVELS: readonly FuzzLogLevel[] = ["quiet", "summary", "progress", "trace"]
const LOG_FORMATS: readonly FuzzLogFormat[] = ["pretty", "json"]
const LOG_COLORS: readonly FuzzLogColor[] = ["auto", "always", "never"]
const DEFAULT_RECENT_ACTION_LIMIT = 8
const LIVE_RENDER_INTERVAL_MS = 80
const ROOT_DURATION_WINDOW = 64
const VALIDATOR_ACTION_TYPE_COUNT = 10
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g

const ANSI = {
	reset: "\u001b[0m",
	bold: "\u001b[1m",
	dim: "\u001b[2m",
	red: "\u001b[31m",
	green: "\u001b[32m",
	cyan: "\u001b[36m",
	yellow: "\u001b[33m",
	magenta: "\u001b[35m",
	gray: "\u001b[90m",
}

function defaultWriter(line: string): void {
	process.stdout.write(`${line}\n`)
}

export function createProcessTerminalSink(stream: NodeJS.WriteStream): FuzzTerminalSink {
	let renderedLines: string[] = []
	let previousFrame = ""
	const clearSequence = (lineCount: number): string => {
		let sequence = ""
		for (let index = 0; index < lineCount; index++) {
			sequence += "\r\u001b[2K"
			if (index < lineCount - 1) sequence += "\u001b[1A"
		}
		return sequence
	}
	const physicalLineCount = (lines: readonly string[]): number => {
		const columns = Math.max(1, stream.columns || 80)
		return lines.reduce((total, line) => total + Math.max(1, Math.ceil(visibleLength(line) / columns)), 0)
	}
	const clear = () => {
		if (renderedLines.length === 0) return
		stream.write(clearSequence(physicalLineCount(renderedLines)))
		renderedLines = []
		previousFrame = ""
	}
	return {
		get columns() {
			return stream.columns || 80
		},
		replace(lines) {
			const frame = lines.join("\n")
			if (frame === previousFrame) return
			if (lines.length === 0) {
				clear()
				return
			}
			stream.write(`${renderedLines.length === 0 ? "" : clearSequence(physicalLineCount(renderedLines))}${frame}`)
			renderedLines = [...lines]
			previousFrame = frame
		},
		clear,
	}
}

function environmentFlag(value: string | undefined): boolean {
	if (value === undefined || value === "") return false
	return !["0", "false", "no", "off"].includes(value.toLowerCase())
}

function parseChoice<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
	if (value === undefined || value === "") return fallback
	if ((allowed as readonly string[]).includes(value)) return value as T
	throw new Error(`${name} must be one of ${allowed.join("|")}, received ${JSON.stringify(value)}`)
}

export function fuzzLogOptionsFromEnv(
	env: FuzzLogEnvironment = process.env,
	isTTY = Boolean(process.stdout.isTTY),
): Pick<CompleteFuzzRunLoggerOptions, "level" | "format" | "color"> {
	const level = parseChoice("FUZZ_LOG_LEVEL", env.FUZZ_LOG_LEVEL, LOG_LEVELS, "progress")
	const format = parseChoice("FUZZ_LOG_FORMAT", env.FUZZ_LOG_FORMAT, LOG_FORMATS, "pretty")
	const colorMode = parseChoice("FUZZ_LOG_COLOR", env.FUZZ_LOG_COLOR, LOG_COLORS, "auto")
	const color = format === "pretty" && (colorMode === "always" || (colorMode === "auto" && isTTY && env.NO_COLOR === undefined))
	return { level, format, color }
}

function safeClock(clock: FuzzLogClock): number {
	try {
		const value = clock()
		return Number.isFinite(value) ? value : Date.now()
	} catch {
		return Date.now()
	}
}

function isAggregateErrorLike(error: unknown): error is AggregateErrorLike {
	try {
		return error instanceof Error && Array.isArray((error as Partial<AggregateErrorLike>).errors)
	} catch {
		return false
	}
}

function errorCause(error: Error): unknown {
	try {
		return (error as ErrorWithCause).cause
	} catch {
		return undefined
	}
}

function safeJson(value: unknown, seen = new WeakSet<object>()): JsonSafe {
	try {
		return safeJsonValue(value, seen)
	} catch {
		return "[Unserializable]"
	}
}

function safeJsonValue(value: unknown, seen: WeakSet<object>): JsonSafe {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value
	if (typeof value === "bigint") return value.toString()
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
	if (typeof value === "undefined") return "[undefined]"
	if (typeof value === "symbol") return value.toString()
	if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`

	if (seen.has(value)) return "[Circular]"
	seen.add(value)

	if (isAggregateErrorLike(value)) {
		const result: Record<string, JsonSafe> = {
			name: value.name,
			message: value.message,
			errors: value.errors.map(error => safeJson(error, seen)),
		}
		const cause = errorCause(value)
		if (cause !== undefined) result.cause = safeJson(cause, seen)
		if (value.stack) result.stack = value.stack
		return result
	}

	if (value instanceof Error) {
		const result: Record<string, JsonSafe> = {
			name: value.name,
			message: value.message,
		}
		const cause = errorCause(value)
		if (cause !== undefined) result.cause = safeJson(cause, seen)
		if (value.stack) result.stack = value.stack
		for (const key of Object.keys(value).sort()) {
			if (key === "cause") continue
			result[key] = safeJson((value as unknown as Record<string, unknown>)[key], seen)
		}
		return result
	}

	if (Array.isArray(value)) return value.map(item => safeJson(item, seen))

	const result: Record<string, JsonSafe> = {}
	for (const key of Object.keys(value).sort()) result[key] = safeJson((value as Record<string, unknown>)[key], seen)
	return result
}

function semanticError(error: unknown, seen = new WeakSet<object>()): JsonSafe {
	if (error instanceof Error) {
		if (seen.has(error)) return "[Circular error]"
		seen.add(error)
	}
	if (isAggregateErrorLike(error)) {
		const cause = errorCause(error)
		return {
			name: error.name,
			message: error.message,
			errors: error.errors.map(item => semanticError(item, seen)),
			...(cause === undefined ? {} : { cause: semanticError(cause, seen) }),
		}
	}
	if (error instanceof Error) {
		const cause = errorCause(error)
		return {
			name: error.name,
			message: error.message,
			...(cause === undefined ? {} : { cause: semanticError(cause, seen) }),
		}
	}
	return safeJson(error, seen)
}

function stableStringify(value: unknown): string {
	return JSON.stringify(safeJson(value))
}

function errorMessage(error: unknown, seen = new WeakSet<object>()): string {
	if (error instanceof Error) {
		if (seen.has(error)) return "[Circular error]"
		seen.add(error)
	}
	if (isAggregateErrorLike(error)) {
		const details = error.errors.map(item => errorMessage(item, seen)).filter(Boolean)
		return details.length === 0 ? error.message : `${error.message}: ${details.join("; ")}`
	}
	if (error instanceof Error) {
		const errorCauseValue = errorCause(error)
		const cause = errorCauseValue === undefined ? "" : ` (cause: ${errorMessage(errorCauseValue, seen)})`
		return `${error.message}${cause}`
	}
	if (typeof error === "string") return error
	try {
		return stableStringify(error)
	} catch {
		return String(error)
	}
}

function quote(value: string): string {
	return JSON.stringify(value)
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
	if (/[\n\r\t]/.test(value)) {
		const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
		return `$'${escaped}'`
	}
	return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`
	const roundedSeconds = Math.round(durationMs / 1_000)
	if (roundedSeconds < 60) return `${(durationMs / 1_000).toFixed(1)}s`
	const minutes = Math.floor(roundedSeconds / 60)
	const seconds = roundedSeconds % 60
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`
}

function formatProbability(value: number): string {
	return `${(value * 100).toFixed(value * 100 === Math.round(value * 100) ? 0 : 1)}%`
}

function formatCount(value: number): string {
	return value.toLocaleString("en-US")
}

function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
	return `${formatCount(value)} ${value === 1 ? singular : pluralForm}`
}

function formatRate(value: number, unit: string): string {
	if (!Number.isFinite(value) || value < 0) return `0.0 ${unit}/s`
	return `${value.toFixed(1)} ${unit}/s`
}

function percentile(values: readonly number[], quantile: number): number | undefined {
	if (values.length === 0) return undefined
	const sorted = [...values].sort((left, right) => left - right)
	const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1))
	return sorted[index]
}

function copyQuoteInventory(inventory: FuzzQuoteInventory): FuzzQuoteInventory {
	return {
		...inventory,
		byStatus: { ...inventory.byStatus },
		byPositionType: { ...inventory.byPositionType },
		byOpeningOrderType: { ...inventory.byOpeningOrderType },
		byCloseOrderType: { ...inventory.byCloseOrderType },
		partialOpen: { ...inventory.partialOpen },
	}
}

function copyOperationCoverage(coverage: FuzzOperationCoverage): FuzzOperationCoverage {
	return {
		totals: { ...coverage.totals },
		byOperation: Object.fromEntries(FUZZ_CORNER_OPERATIONS.map(operation => [operation, { ...coverage.byOperation[operation] }])) as Record<
			FuzzCornerOperation,
			FuzzOperationCounts
		>,
	}
}

function compactQueueText(queue: FuzzQueueSnapshot): string {
	const activity = [
		queue.pending > 0 ? `${queue.pending} pending` : undefined,
		queue.scheduled > 0 ? `${queue.scheduled} scheduled` : undefined,
		queue.running ? "1 running" : undefined,
		queue.paused ? "paused" : undefined,
	].filter((value): value is string => value !== undefined)
	return (
		`actions ${queue.completed}/${queue.accepted}` +
		(activity.length === 0 ? " · idle" : ` · ${activity.join(" · ")}`) +
		(queue.failures === 0 ? "" : ` · ${queue.failures} failed`)
	)
}

function progressBar(index: number, total: number, width = 12): string {
	const boundedIndex = Math.max(0, Math.min(index, total))
	const completed = total <= 0 ? 0 : Math.round((boundedIndex / total) * width)
	return `${"━".repeat(completed)}${"─".repeat(width - completed)}`
}

function shortAddress(address: string): string {
	return address.length <= 18 ? address : `${address.slice(0, 8)}…${address.slice(-6)}`
}

function actorList(actors: FuzzSetupInfo["users"]): string {
	return actors.map(actor => `${actor.id} ${shortAddress(actor.address)}`).join("   ")
}

function fitTerminalLine(line: string, columns: number): string {
	const width = Math.max(1, Math.floor(columns) - 1)
	const plain = line.replace(ANSI_PATTERN, "")
	if (plain.length <= width) return line
	if (width === 1) return "…"
	return `${plain.slice(0, width - 1)}…`
}

function visibleLength(value: string): number {
	return value.replace(ANSI_PATTERN, "").length
}

function wrapDashboardSegments(label: string, segments: readonly string[], columns: number): string[] {
	const plainLabel = label.padEnd(11)
	const prefix = `│ ${plainLabel}`
	const continuation = `│ ${" ".repeat(plainLabel.length)}`
	const width = Math.max(1, Math.floor(columns) - 1)
	const lines: string[] = []
	let line = prefix

	for (const segment of segments) {
		const separator = line === prefix || line === continuation ? "" : " · "
		const candidate = `${line}${separator}${segment}`
		if (visibleLength(candidate) <= width || line === prefix || line === continuation) {
			line = candidate
			continue
		}
		lines.push(fitTerminalLine(line, columns))
		line = `${continuation}${segment}`
	}

	if (line !== prefix && line !== continuation) lines.push(fitTerminalLine(line, columns))
	return lines
}

function wrapShellCommand(tokens: readonly string[], columns: number): string[] {
	const width = Math.max(20, Math.floor(columns) - 1)
	const prefix = "│   "
	const availableWidth = Math.max(1, width - 2)
	const lines: string[] = []
	let line = prefix

	for (const token of tokens) {
		const candidate = `${line}${line === prefix ? "" : " "}${token}`
		if (visibleLength(candidate) <= availableWidth || line === prefix) {
			line = candidate
			continue
		}
		lines.push(line)
		line = `${prefix}${token}`
	}
	if (line !== prefix) lines.push(line)
	return lines.map((value, index) => (index === lines.length - 1 ? fitTerminalLine(value, columns) : fitTerminalLine(`${value} \\`, columns)))
}

const ACTION_LABELS: Readonly<Record<string, string>> = {
	SEND_QUOTE: "sends quote",
	CANCEL_REQUEST: "requests quote cancellation",
	ACCEPT_CANCEL_REQUEST: "accepts quote cancellation",
	LOCK_QUOTE: "locks quote",
	UNLOCK_QUOTE: "unlocks quote",
	OPEN_POSITION: "opens position",
	CLOSE_REQUEST: "requests position close",
	FORCE_CLOSE_REQUEST: "requests force close",
	CANCEL_CLOSE_REQUEST: "cancels close request",
	ACCEPT_CANCEL_CLOSE_REQUEST: "accepts close cancellation",
	FILL_POSITION: "fills close request",
	NOTHING: "holds state",
}

const CORNER_LABELS: Readonly<Record<FuzzCornerOperation, string>> = {
	FUNDING_CHARGE: "funding charge",
	SETTLE_UPNL: "settle unrealized PnL",
	FORCE_CLOSE: "force close",
	EMERGENCY_CLOSE: "emergency close",
	EXPIRE_QUOTE: "quote expiry",
	LIQUIDATE_PARTY_A: "Party A liquidation",
	LIQUIDATE_PARTY_B: "Party B liquidation",
}

function humanizeAction(action: string): string {
	return ACTION_LABELS[action] ?? action.toLowerCase().replaceAll("_", " ")
}

function humanizeActionTitle(title: string): string {
	const observe = /^Observe:([^:]+):([^:]+):(.+)$/.exec(title)
	if (observe) return `${observe[1]} revisits quote #${observe[3]} in ${observe[2]}`
	const root = /^Root:[^:]+:([^:]+)->([^:]+):SendQuote$/.exec(title)
	if (root) return `${root[1]} sends a quote to ${root[2]}`
	const world = /^World:[^:]+:([^:]+):Revisit:(.+)$/.exec(title)
	if (world) return `${world[1]} advances quote #${world[2]}`
	const rethink = /^Rethink:([^:]+):(.+)$/.exec(title)
	if (rethink) return `${rethink[1]} reconsiders quote #${rethink[2]}`
	if (/^Corner:/.test(title)) return "runs the next rare-path campaign"
	return title
}

function sampledRoot(index: number, total: number): boolean {
	if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1 || index > total) return true
	const sampleCount = Math.min(10, total)
	for (let sample = 1; sample <= sampleCount; sample++) {
		if (index === Math.ceil((total * sample) / sampleCount)) return true
	}
	return false
}

function normalizeFailures(failure: FuzzFailure | readonly FuzzFailure[]): readonly FuzzFailure[] {
	return Array.isArray(failure) ? failure : [failure as FuzzFailure]
}

export class FuzzRunLogger {
	private readonly options: CompleteFuzzRunLoggerOptions
	private readonly interactive: boolean
	private readonly semanticHash: Hash = createHash("sha256")
	private readonly quoteInventoryTracker = new FuzzQuoteInventoryTracker()
	private readonly operationCoverageTracker = new FuzzOperationCoverageTracker()
	private readonly recentEvents: Array<Exclude<FuzzModelEvent, { type: "pause" }>> = []
	private latestQuoteInventory = this.quoteInventoryTracker.snapshot()
	private latestOperationCoverage = this.operationCoverageTracker.snapshot()
	private readonly reachedQuoteStatuses = new Set<FuzzQuoteStatusName>()
	private readonly rootDurationsMs: number[] = []
	private readonly quoteStateFingerprints = new Map<bigint, string>()
	private readonly decisionsByAction = new Map<number, Extract<FuzzModelEvent, { type: "decision" }>>()
	private readonly changedActionSequences = new Set<number>()
	private readonly confirmedValidationActions = new Set<string>()
	private startedAt?: number
	private executionStartedAt?: number
	private lastQueue?: FuzzQueueSnapshot
	private finalSemanticRecorded = false
	private completedRoots = 0
	private sentRoots = 0
	private discardedRoots = 0
	private eligibleValidatorSelections = 0
	private selectedValidators = 0
	private observableSuccessfulTransitions = 0
	private confirmedValidatorTransitions = 0
	private successfulActions = 0
	private failedActions = 0
	private timedOutActions = 0
	private activeAction?: Extract<FuzzModelEvent, { type: "action" }>
	private activeDecision?: Extract<FuzzModelEvent, { type: "decision" }>
	private lastActivity = "waiting for the first protocol transition"
	private livePhase: "running" | "draining" = "running"
	private drainingSignal?: FuzzStopSignal
	private lastLiveRenderAt = Number.NEGATIVE_INFINITY
	private liveRenderTimer?: ReturnType<typeof setTimeout>
	private liveVisible = false

	constructor(
		readonly config: FuzzRunConfig,
		options: FuzzRunLoggerOptions = {},
	) {
		const needsEnvironment = options.level === undefined || options.format === undefined || options.color === undefined
		const environment = needsEnvironment ? fuzzLogOptionsFromEnv() : undefined
		const recentActionLimit = options.recentActionLimit ?? DEFAULT_RECENT_ACTION_LIMIT
		if (!Number.isSafeInteger(recentActionLimit) || recentActionLimit < 0) {
			throw new Error(`recentActionLimit must be a non-negative safe integer, received ${recentActionLimit}`)
		}

		const format = options.format ?? environment!.format
		this.options = {
			level: options.level ?? environment!.level,
			format,
			writer: options.writer ?? defaultWriter,
			clock: options.clock ?? Date.now,
			color: format === "pretty" && (options.color ?? environment!.color),
			recentActionLimit,
			terminal: options.terminal,
			dashboardRecorder: options.dashboardRecorder,
		}
		this.interactive =
			this.options.format === "pretty" &&
			this.options.level === "progress" &&
			this.config.runMode === "continuous" &&
			this.options.terminal !== undefined
		this.recordSemantic({
			type: "config",
			seed: config.seed,
			runMode: config.runMode,
			rootActions: config.rootActions,
			userCount: config.userCount,
			hedgerCount: config.hedgerCount,
			progressEvery: config.progressEvery,
			cornerEvery: config.cornerEvery,
			eventMode: config.eventMode,
			validationProbability: config.validationProbability,
			blockedQuoteProbability: config.blockedQuoteProbability,
			rethinkDelayMs: config.rethinkDelayMs,
			actionTimeoutMs: config.actionTimeoutMs,
			runTimeoutMs: config.runTimeoutMs,
			drainTimeoutMs: config.drainTimeoutMs,
		})
	}

	start(): void {
		if (this.startedAt !== undefined) return
		this.startedAt = safeClock(this.options.clock)
		this.recordDashboard(recorder => recorder.start(this.startedAt!))
		if (!this.enabled("summary")) return

		const mode = this.config.runMode === "bounded" ? `bounded · ${plural(this.config.rootActions, "root")}` : "continuous · Ctrl+C drains safely"
		const dashboard = this.dashboardLocation()
		this.emit(
			"run_started",
			{
				config: this.config,
				startedAt: this.startedAt,
				...(dashboard === undefined ? {} : { dashboard }),
			},
			[
				this.paint("cyan", "╭─ SYMMIO · FUZZ WORLD"),
				this.detailLine("seed", quote(this.config.seed)),
				this.detailLine("profile", `${mode} · Hardhat`),
				this.detailLine(
					"world",
					`${plural(this.config.userCount, "user")} · ${plural(this.config.hedgerCount, "hedger")} · ${this.config.eventMode} events`,
				),
				this.detailLine(
					"assurance",
					`${formatProbability(this.config.validationProbability)} validator sampling · ` +
						(this.config.cornerEvery === 0
							? "rare-path campaign off"
							: this.config.cornerEvery === 1
								? "rare path every root"
								: `rare path every ${this.config.cornerEvery} roots`),
				),
				this.detailLine(
					"generation",
					`${formatProbability(this.config.blockedQuoteProbability)} blocked quote generation · ` +
						`${formatDuration(this.config.rethinkDelayMs)} rethink delay`,
				),
				this.detailLine(
					"guardrails",
					`${formatDuration(this.config.actionTimeoutMs)} action · ${formatDuration(this.config.runTimeoutMs)} root · ` +
						`${formatDuration(this.config.drainTimeoutMs)} drain timeout`,
				),
				...this.dashboardReportLines(),
				this.interactive
					? `${this.paint("cyan", "╰─")} ${this.paint("dim", "dashboard".padEnd(10))} live · exact replay printed on exit`
					: `${this.paint("cyan", "╰─")} ${this.paint("dim", "replay".padEnd(10))} ${this.replayCommand()}`,
			],
		)
	}

	setupComplete(info: FuzzSetupInfo): void {
		this.executionStartedAt ??= safeClock(this.options.clock)
		this.recordDashboard(recorder => recorder.setupComplete(info))
		if (!this.enabled("progress")) return
		this.emit("setup_complete", { setup: info }, [
			`${this.paint("green", "✓ WORLD READY")}  ${plural(info.users.length, "user")} · ${plural(info.hedgers.length, "hedger")}` +
				` · ${this.paint("dim", formatDuration(info.durationMs))}`,
			`  ${this.paint("dim", "users".padEnd(9))}${actorList(info.users)}`,
			`  ${this.paint("dim", "hedgers".padEnd(9))}${actorList(info.hedgers)}`,
		])
		this.requestLiveRender(true)
	}

	onModelEvent(event: FuzzModelEvent): void {
		if (event.type === "state") {
			try {
				this.latestQuoteInventory = this.quoteInventoryTracker.observe(event)
				this.reachedQuoteStatuses.add(event.quoteStatus as FuzzQuoteStatusName)
			} catch {
				// Malformed diagnostics must never change the protocol path under test.
			}
		}
		if (event.type === "operation") {
			try {
				this.latestOperationCoverage = this.operationCoverageTracker.observe(event)
			} catch {
				// Malformed diagnostics must never change the protocol path under test.
			}
		}
		this.trackAssurance(event)
		this.recordModelEvent(event)
		this.updateLiveModelEvent(event)
		this.recordDashboard(recorder => recorder.onModelEvent(event, this.dashboardProjection()))
		if (!this.enabled("trace")) return
		if (this.options.format === "json") {
			this.emit("model_event", { event }, [])
			return
		}

		let line: string
		switch (event.type) {
			case "action": {
				if (event.phase === "queued") return
				const marker =
					event.phase === "started"
						? this.paint("yellow", "→")
						: event.phase === "succeeded"
							? this.paint("green", "✓")
							: event.phase === "settled_after_timeout"
								? this.paint("yellow", "!")
								: this.paint("red", "✗")
				line =
					`${this.paint("dim", "ACTION")} #${event.sequence.toString().padStart(4, "0")} ${marker} ${event.title}` +
					` · ${event.phase}` +
					(event.error === undefined ? "" : ` error=${errorMessage(event.error)}`) +
					` · ${compactQueueText(event.queue)}`
				break
			}
			case "decision":
				line =
					`${this.paint("dim", "DECIDE")} ${this.eventSequence(event.actionSequence)} ◇ ${event.actorId}` +
					` · ${humanizeAction(event.action)} · quote #${event.quoteId}` +
					` · from ${event.quoteStatus} · validator ${event.validated ? this.paint("green", "selected") : this.paint("dim", "not selected")}`
				break
			case "state":
				line = `${this.paint("dim", "STATE ")} ${this.eventSequence(event.actionSequence)} ↳ quote #${event.quoteId}` + ` · ${event.quoteStatus}`
				break
			case "operation": {
				const marker =
					event.phase === "started"
						? this.paint("yellow", "→")
						: event.phase === "succeeded"
							? this.paint("green", "✓")
							: event.phase === "skipped"
								? this.paint("yellow", "↷")
								: this.paint("red", "✗")
				line =
					`${this.paint("dim", "RARE  ")} ${this.eventSequence(event.actionSequence)} ${marker} ${CORNER_LABELS[event.operation]}` +
					` · ${event.phase}` +
					(event.quoteIds === undefined ? "" : ` · quotes ${event.quoteIds.map(quoteId => `#${quoteId}`).join(",")}`) +
					(event.actorIds === undefined ? "" : ` · actors ${event.actorIds.join(",")}`) +
					(event.detail === undefined ? "" : ` · ${event.detail}`) +
					(event.error === undefined ? "" : ` · error=${errorMessage(event.error)}`)
				break
			}
			case "pause":
				return
		}
		this.emit("model_event", { event }, [line])
	}

	rootComplete(result: FuzzRootResult): void {
		this.lastQueue = result.queue
		this.recordSemantic({
			type: "root",
			index: result.index,
			userId: result.userId,
			hedgerId: result.hedgerId,
			status: result.status,
			...(result.quoteId === undefined ? {} : { quoteId: result.quoteId.toString() }),
			...(result.reason === undefined ? {} : { reason: result.reason }),
		})
		this.completedRoots = result.index
		if (result.status === "sent") this.sentRoots++
		else this.discardedRoots++
		this.rootDurationsMs.push(result.durationMs)
		while (this.rootDurationsMs.length > ROOT_DURATION_WINDOW) this.rootDurationsMs.shift()
		this.lastActivity =
			`${result.userId} → ${result.hedgerId}` +
			(result.status === "sent"
				? ` · sent quote #${result.quoteId ?? "?"}`
				: ` · input discarded${result.reason === undefined ? "" : ` · ${result.reason}`}`) +
			` · ${formatDuration(result.durationMs)}`
		this.recordDashboard(recorder => recorder.rootComplete(result))
		if (this.interactive) {
			this.requestLiveRender()
			return
		}
		const shouldReport =
			result.total === undefined ? result.index === 1 || result.index % this.config.progressEvery === 0 : sampledRoot(result.index, result.total)
		if (!this.enabled("progress") || !shouldReport) return

		const outcome =
			result.status === "sent"
				? this.paint("green", `quote #${result.quoteId ?? "?"}`)
				: this.paint("yellow", `discarded${result.reason === undefined ? "" : ` · ${result.reason}`}`)
		const position =
			result.total === undefined ? result.index.toString() : `${result.index.toString().padStart(String(result.total).length)}/${result.total}`
		const progress = result.total === undefined ? `#${position.padStart(6, "0")}` : `${progressBar(result.index, result.total)}  ${position}`
		const marker = result.status === "sent" ? this.paint("green", "◆") : this.paint("yellow", "○")
		this.emit("root_complete", { root: result }, [
			`  ${marker} ${this.paint("bold", "ROOT")} ${progress}  ${result.userId} → ${result.hedgerId}` +
				` · ${outcome} · ${this.paint("dim", formatDuration(result.durationMs))}` +
				` · ${this.paint("dim", compactQueueText(result.queue))}`,
		])
	}

	pass(result: FuzzRunResult): void {
		this.lastQueue = result.queue
		this.recordFinalSemanticResult("pass", result)
		this.finalizeDashboard({ outcome: "passed", result })
		this.clearLive()
		if (!this.enabled("summary")) return

		this.emit("run_passed", this.finalPayload(result), this.summaryLines("PASS", result))
	}

	stopRequested(signal: FuzzStopSignal): void {
		this.recordDashboard(recorder => recorder.stopRequested(signal))
		if (this.interactive) {
			this.livePhase = "draining"
			this.drainingSignal = signal
			this.requestLiveRender(true)
			return
		}
		this.emit(
			"stop_requested",
			{ signal },
			[`${this.paint("cyan", "■ STOP")}  ${signal} received · finishing the active action and draining accepted work…`],
			true,
		)
	}

	stopped(signal: FuzzStopSignal, result: FuzzRunResult): void {
		this.lastQueue = result.queue
		this.recordFinalSemanticResult("stopped", result, signal)
		this.finalizeDashboard({ outcome: "stopped", signal, result })
		this.clearLive()
		this.emit(
			"run_stopped",
			{
				signal,
				...this.finalPayload(result),
			},
			this.summaryLines("STOPPED", result, signal),
			true,
		)
	}

	fail(failure: FuzzFailure | readonly FuzzFailure[], result?: FuzzRunResult, options: { emitPretty?: boolean } = {}): string {
		const failures = normalizeFailures(failure)
		if (result) this.lastQueue = result.queue
		this.recordFinalSemanticFailures(failures, result)
		this.finalizeDashboard({ outcome: "failed", failures, ...(result === undefined ? {} : { result }) })
		this.clearLive()

		const message = this.failureMessage(failures, result)
		const lines = message.split("\n")
		if (lines.length > 0) lines[0] = this.paint("red", lines[0])
		if (this.options.format === "json" || options.emitPretty !== false) {
			this.emit(
				"run_failed",
				{
					failures: failures.map(item => ({
						boundary: item.boundary,
						error: item.error,
					})),
					...(result === undefined ? {} : { result }),
					quotes: this.quoteInventory(),
					corners: this.operationCoverage(),
					traceHash: this.traceHash(),
					replay: this.replayCommand(result),
				},
				lines,
				true,
			)
		}
		return message
	}

	failureMessage(failure: FuzzFailure | readonly FuzzFailure[], result?: FuzzRunResult): string {
		const failures = normalizeFailures(failure)
		const headline = failures.length === 1 ? `╭─ ✗ FAIL · ${failures[0].boundary}` : `╭─ ✗ FAIL · ${failures.length} boundaries`
		const lines = [headline]
		failures.forEach((item, index) => {
			const label = failures.length === 1 ? "error" : `${index + 1}. ${item.boundary}`
			lines.push(this.detailLine(label, errorMessage(item.error)))
		})
		if (result) {
			lines.push(
				this.detailLine(
					"result",
					`${result.rootActions} roots · ${result.sentQuotes} sent · ${result.discardedInputs} discarded · ${formatDuration(result.durationMs)}`,
				),
				this.detailLine("queue", this.finalQueueText(result.queue)),
			)
			lines.push(...this.discardReasonLines(result.discardedReasons))
		} else if (this.lastQueue) {
			lines.push(this.detailLine("queue", this.finalQueueText(this.lastQueue)))
		}
		lines.push(...this.quoteSummaryLines(), ...this.cornerSummaryLines())
		lines.push(...this.recentActionLines().map(line => `│ ${line}`))
		lines.push(this.detailLine("trace", this.traceHash()), ...this.dashboardReportLines(), ...this.replaySummaryLines(result, "red"))
		return lines.join("\n")
	}

	traceHash(): string {
		return this.semanticHash.copy().digest("hex")
	}

	quoteInventory(): FuzzQuoteInventory {
		return copyQuoteInventory(this.latestQuoteInventory)
	}

	operationCoverage(): FuzzOperationCoverage {
		return copyOperationCoverage(this.latestOperationCoverage)
	}

	async flushDashboard(): Promise<void> {
		try {
			await this.options.dashboardRecorder?.flush()
		} catch {
			// Report persistence is diagnostic-only and must never change the fuzz result.
		}
	}

	replayCommand(result?: FuzzRunResult): string {
		return this.replayTokens(result).join(" ")
	}

	private replayTokens(result?: FuzzRunResult): string[] {
		const bounded = this.config.runMode === "bounded" || result !== undefined
		const replayRootActions = Math.max(1, result?.rootActions ?? this.config.rootActions)
		const variables = [
			`FUZZ_SEED=${shellQuote(this.config.seed)}`,
			`FUZZ_RUN_MODE=${bounded ? "bounded" : "continuous"}`,
			`FUZZ_USER_COUNT=${this.config.userCount}`,
			`FUZZ_HEDGER_COUNT=${this.config.hedgerCount}`,
			`FUZZ_PROGRESS_EVERY=${this.config.progressEvery}`,
			`FUZZ_CORNER_EVERY=${this.config.cornerEvery}`,
			...(bounded ? [`FUZZ_ROOT_ACTIONS=${replayRootActions}`] : []),
			`VALIDATION_PROBABILITY=${this.config.validationProbability}`,
			`FUZZ_BLOCKED_QUOTE_PROBABILITY=${this.config.blockedQuoteProbability}`,
			`FUZZ_RETHINK_DELAY_MS=${this.config.rethinkDelayMs}`,
			`FUZZ_ACTION_TIMEOUT_MS=${this.config.actionTimeoutMs}`,
			`FUZZ_RUN_TIMEOUT_MS=${this.config.runTimeoutMs}`,
			`FUZZ_DRAIN_TIMEOUT_MS=${this.config.drainTimeoutMs}`,
		]
		return [...variables, "npm", "run", bounded ? "test:fuzz:ci" : "test:fuzz"]
	}

	private trackAssurance(event: FuzzModelEvent): void {
		switch (event.type) {
			case "decision":
				if (event.action === "NOTHING") return
				this.eligibleValidatorSelections++
				if (event.validated) this.selectedValidators++
				if (event.actionSequence !== undefined) this.decisionsByAction.set(event.actionSequence, event)
				return
			case "state": {
				const fingerprint = stableStringify({
					quoteStatus: event.quoteStatus,
					quote: event.quote,
				})
				const previous = this.quoteStateFingerprints.get(event.quoteId)
				this.quoteStateFingerprints.set(event.quoteId, fingerprint)
				if (previous !== fingerprint && event.actionSequence !== undefined) {
					this.changedActionSequences.add(event.actionSequence)
				}
				return
			}
			case "action":
				if (event.phase === "succeeded") {
					this.successfulActions++
					const decision = this.decisionsByAction.get(event.sequence)
					if (decision !== undefined && this.changedActionSequences.has(event.sequence)) {
						this.observableSuccessfulTransitions++
						if (decision.validated) {
							this.confirmedValidatorTransitions++
							this.confirmedValidationActions.add(decision.action)
						}
					}
				} else if (event.phase === "failed") {
					this.failedActions++
				} else if (event.phase === "timed_out") {
					this.timedOutActions++
				}
				if (["succeeded", "failed", "settled_after_timeout"].includes(event.phase)) {
					this.decisionsByAction.delete(event.sequence)
					this.changedActionSequences.delete(event.sequence)
				}
				return
			case "operation":
			case "pause":
				return
		}
	}

	private updateLiveModelEvent(event: FuzzModelEvent): void {
		if (!this.interactive) return
		switch (event.type) {
			case "action":
				if (event.phase === "started") {
					this.activeAction = event
					this.activeDecision = undefined
					this.lastActivity = `#${event.sequence.toString().padStart(4, "0")} · ${humanizeActionTitle(event.title)}`
				} else if (event.phase === "timed_out" && this.activeAction?.sequence === event.sequence) {
					this.lastActivity =
						`#${event.sequence.toString().padStart(4, "0")} · ${humanizeActionTitle(this.activeAction.title)}` + " · timed out · still settling"
				} else if (!["queued", "started"].includes(event.phase) && this.activeAction?.sequence === event.sequence) {
					this.activeAction = undefined
					this.activeDecision = undefined
				}
				break
			case "decision":
				this.activeDecision = event
				this.lastActivity =
					`${this.activitySequencePrefix(event.actionSequence)}${event.actorId} ${humanizeAction(event.action)}` +
					` · quote #${event.quoteId} · from ${event.quoteStatus}` +
					(event.action === "NOTHING" ? " · no transaction" : ` · validator ${event.validated ? "selected" : "not selected"}`)
				break
			case "state": {
				const decision = event.actionSequence === undefined ? undefined : (this.decisionsByAction.get(event.actionSequence) ?? this.activeDecision)
				const from =
					decision !== undefined && decision.quoteId === event.quoteId && decision.quoteStatus !== event.quoteStatus
						? `${decision.quoteStatus} → `
						: ""
				this.lastActivity =
					`${this.activitySequencePrefix(event.actionSequence)}quote #${event.quoteId} · ${from}${event.quoteStatus}` +
					(decision?.validated ? " · validator selected" : "")
				break
			}
			case "operation": {
				const marker = event.phase === "succeeded" ? "verified" : event.phase
				this.lastActivity =
					`${this.activitySequencePrefix(event.actionSequence)}${CORNER_LABELS[event.operation]} · ${marker}` +
					(event.quoteIds === undefined ? "" : ` · ${event.quoteIds.map(quoteId => `quote #${quoteId}`).join(", ")}`) +
					(event.detail === undefined ? "" : ` · ${event.detail}`)
				break
			}
			case "pause":
				break
		}
		this.requestLiveRender()
	}

	private requestLiveRender(force = false): void {
		if (!this.interactive) return
		const now = safeClock(this.options.clock)
		const waitMs = LIVE_RENDER_INTERVAL_MS - (now - this.lastLiveRenderAt)
		if (force || waitMs <= 0) {
			if (this.liveRenderTimer !== undefined) {
				clearTimeout(this.liveRenderTimer)
				this.liveRenderTimer = undefined
			}
			this.renderLive(now)
			return
		}
		if (this.liveRenderTimer !== undefined) return
		this.liveRenderTimer = setTimeout(
			() => {
				this.liveRenderTimer = undefined
				this.renderLive(safeClock(this.options.clock))
			},
			Math.max(1, waitMs),
		)
	}

	private renderLive(now: number): void {
		const terminal = this.options.terminal
		if (!this.interactive || terminal === undefined) return
		const elapsedMs = Math.max(0, now - (this.startedAt ?? now))
		const executionElapsedMs = Math.max(0, now - (this.executionStartedAt ?? now))
		const queue = this.lastQueue
		const statusLabel =
			this.livePhase === "draining" ? this.paint("yellow", `DRAINING · ${this.drainingSignal ?? "STOP"}`) : this.paint("cyan", "RUNNING")
		const inventory = this.latestQuoteInventory
		const header =
			`${this.paint("cyan", "╭─")} ${this.paint("bold", "SYMMIO FUZZ WORLD")} · ${statusLabel}` +
			` · ${plural(this.completedRoots, "root")} · ${formatDuration(elapsedMs)}`
		const quoteHeader =
			`${this.paint("cyan", "├─")} ${this.paint("bold", "QUOTE WORLD")}` +
			` · ${formatCount(inventory.total)} total · ${formatCount(inventory.active)} live · ${formatCount(inventory.terminal)} ended`
		const stopGuide =
			this.livePhase === "draining"
				? "draining current action and accepted work · Ctrl+C again forces exit"
				: "Ctrl+C drains safely · press again to force"

		try {
			terminal.replace(
				[
					header,
					...this.liveHealthLines(queue, terminal.columns),
					...this.livePaceLines(queue, executionElapsedMs, terminal.columns),
					`${this.paint("cyan", "├─")} ${this.paint("bold", "NOW")}`,
					...wrapDashboardSegments(this.activeAction === undefined ? "last" : "active", [this.lastActivity], terminal.columns),
					quoteHeader,
					...this.quoteLiveLines(terminal.columns),
					`${this.paint("cyan", "├─")} ${this.paint("bold", "ASSURANCE")}`,
					...this.assuranceLiveLines(terminal.columns),
					`${this.paint("cyan", "├─")} ${this.paint("bold", "ENGINE")}`,
					...this.engineLiveLines(queue, terminal.columns),
					`${this.paint("cyan", "╰─")} ${this.paint("dim", stopGuide)}`,
				].map(line => fitTerminalLine(line, terminal.columns)),
			)
			this.liveVisible = true
			this.lastLiveRenderAt = now
		} catch {
			// Terminal rendering must never change the protocol path under test.
		}
	}

	private liveHealthLines(queue: FuzzQueueSnapshot | undefined, columns: number): string[] {
		if (queue === undefined) return wrapDashboardSegments("health", ["… warming up", "fixture ready", "waiting for actions"], columns)
		const failed = this.failedActions
		const timedOut = this.timedOutActions
		const outstanding = Math.max(0, queue.accepted - queue.completed)
		if (failed > 0 || timedOut > 0 || queue.failures > 0) {
			return wrapDashboardSegments(
				"health",
				[
					`${this.paint("red", "✗ attention")}`,
					plural(failed, "failed action"),
					plural(timedOut, "timed-out action"),
					plural(queue.failures, "error record"),
				],
				columns,
			)
		}
		if (this.livePhase === "draining") {
			return wrapDashboardSegments(
				"health",
				[this.paint("yellow", "→ clean drain"), plural(outstanding, "action"), outstanding === 0 ? "queue drained" : "outstanding"],
				columns,
			)
		}
		return wrapDashboardSegments(
			"health",
			[
				this.paint("green", "✓ clean"),
				outstanding === 0 ? "queue idle" : `${plural(outstanding, "action")} in flight`,
				`${formatCount(queue.completed)}/${formatCount(queue.accepted)} settled`,
			],
			columns,
		)
	}

	private livePaceLines(queue: FuzzQueueSnapshot | undefined, elapsedMs: number, columns: number): string[] {
		if (elapsedMs <= 0) return wrapDashboardSegments("pace", ["warming up after fixture setup"], columns)
		const elapsedSeconds = elapsedMs / 1_000
		const p50 = percentile(this.rootDurationsMs, 0.5)
		const p95 = percentile(this.rootDurationsMs, 0.95)
		const yieldRate = this.completedRoots === 0 ? undefined : this.sentRoots / this.completedRoots
		return wrapDashboardSegments(
			"pace",
			[
				formatRate(this.completedRoots / elapsedSeconds, "roots"),
				formatRate((queue?.completed ?? 0) / elapsedSeconds, "actions"),
				...(yieldRate === undefined ? [] : [`${formatProbability(yieldRate)} input yield`]),
				...(p50 === undefined ? [] : [`root p50 ${formatDuration(p50)}`, `p95 ${formatDuration(p95!)}`, `n=${this.rootDurationsMs.length}`]),
			],
			columns,
		)
	}

	private clearLive(): void {
		if (this.liveRenderTimer !== undefined) {
			clearTimeout(this.liveRenderTimer)
			this.liveRenderTimer = undefined
		}
		if (!this.liveVisible) return
		try {
			this.options.terminal?.clear()
		} catch {
			// Terminal cleanup must never mask a protocol or verification failure.
		}
		this.liveVisible = false
	}

	private enabled(minimum: Exclude<FuzzLogLevel, "quiet">): boolean {
		return LOG_LEVELS.indexOf(this.options.level) >= LOG_LEVELS.indexOf(minimum)
	}

	private emit(type: string, payload: Record<string, unknown>, prettyLines: readonly string[], force = false): void {
		if (!force && this.options.level === "quiet") return
		if (this.options.format === "json") {
			this.write(
				JSON.stringify(
					safeJson({
						type,
						...payload,
					}),
				),
			)
			return
		}
		for (const line of prettyLines) this.write(line)
	}

	private write(line: string): void {
		try {
			this.options.writer(line)
		} catch {
			// Reporting must never mask a protocol or verification failure.
		}
	}

	private paint(color: keyof typeof ANSI, text: string): string {
		if (!this.options.color) return text
		return `${ANSI[color]}${text}${ANSI.reset}`
	}

	private recordModelEvent(event: FuzzModelEvent): void {
		switch (event.type) {
			case "action":
				this.lastQueue = event.queue
				this.recordSemantic({
					type: event.type,
					sequence: event.sequence,
					title: event.title,
					phase: event.phase,
					...(event.error === undefined ? {} : { error: semanticError(event.error) }),
				})
				if (!["queued", "started"].includes(event.phase)) {
					this.rememberEvent(event)
				}
				break
			case "decision":
				this.recordSemantic({
					type: event.type,
					...(event.actionSequence === undefined ? {} : { actionSequence: event.actionSequence }),
					actor: event.actor,
					actorId: event.actorId,
					quoteId: event.quoteId.toString(),
					quoteStatus: event.quoteStatus,
					action: event.action,
					validated: event.validated,
				})
				this.rememberEvent(event)
				break
			case "state":
				this.recordSemantic({
					type: event.type,
					...(event.actionSequence === undefined ? {} : { actionSequence: event.actionSequence }),
					quoteId: event.quoteId.toString(),
					quoteStatus: event.quoteStatus,
				})
				this.rememberEvent(event)
				break
			case "operation":
				this.recordSemantic({
					type: event.type,
					...(event.actionSequence === undefined ? {} : { actionSequence: event.actionSequence }),
					operation: event.operation,
					phase: event.phase,
					...(event.quoteIds === undefined ? {} : { quoteIds: event.quoteIds.map(quoteId => quoteId.toString()) }),
					...(event.actorIds === undefined ? {} : { actorIds: event.actorIds }),
					...(event.detail === undefined ? {} : { detail: event.detail }),
					...(event.error === undefined ? {} : { error: semanticError(event.error) }),
				})
				this.rememberEvent(event)
				break
			case "pause":
				this.recordSemantic({ type: event.type, paused: event.paused })
				break
		}
	}

	private recordFinalSemanticResult(outcome: "pass" | "stopped", result: FuzzRunResult, signal?: FuzzStopSignal): void {
		if (this.finalSemanticRecorded) return
		this.finalSemanticRecorded = true
		this.recordSemantic({
			type: "run",
			outcome,
			...(signal === undefined ? {} : { signal }),
			rootActions: result.rootActions,
			sentQuotes: result.sentQuotes,
			discardedInputs: result.discardedInputs,
			discardedReasons: result.discardedReasons,
		})
	}

	private recordFinalSemanticFailures(failures: readonly FuzzFailure[], result?: FuzzRunResult): void {
		if (this.finalSemanticRecorded) return
		this.finalSemanticRecorded = true
		this.recordSemantic({
			type: "run",
			outcome: "fail",
			failures: failures.map(failure => ({
				boundary: failure.boundary,
				error: semanticError(failure.error),
			})),
			...(result === undefined
				? {}
				: {
						rootActions: result.rootActions,
						sentQuotes: result.sentQuotes,
						discardedInputs: result.discardedInputs,
						discardedReasons: result.discardedReasons,
					}),
		})
	}

	private finalPayload(result: FuzzRunResult): Record<string, unknown> {
		return {
			result,
			quotes: this.quoteInventory(),
			corners: this.operationCoverage(),
			traceHash: this.traceHash(),
			replay: this.replayCommand(result),
		}
	}

	private summaryLines(outcome: "PASS" | "STOPPED", result: FuzzRunResult, signal?: FuzzStopSignal): string[] {
		const color = outcome === "PASS" ? "green" : "yellow"
		const glyph = outcome === "PASS" ? "✓" : "■"
		const durationSeconds = result.durationMs / 1_000
		const inputYield = result.rootActions === 0 ? 0 : result.sentQuotes / result.rootActions
		const p50 = percentile(this.rootDurationsMs, 0.5)
		const p95 = percentile(this.rootDurationsMs, 0.95)
		const columns = this.summaryColumns()
		const queueDrained =
			result.queue.accepted === result.queue.completed && result.queue.pending === 0 && result.queue.scheduled === 0 && !result.queue.running
		const lines = [
			this.paint(color, `╭─ SYMMIO FUZZ WORLD · ${glyph} ${outcome}${signal === undefined ? "" : ` · ${signal}`}`),
			this.detailLine("seed", quote(this.config.seed)),
			`${this.paint(color, "├─")} ${this.paint("bold", "RUN")}`,
			...wrapDashboardSegments(
				"result",
				[
					plural(result.rootActions, "root"),
					`${plural(result.sentQuotes, "quote")} sent`,
					`${plural(result.discardedInputs, "input")} discarded`,
					formatDuration(result.durationMs),
				],
				columns,
			),
			...wrapDashboardSegments(
				"health",
				[
					queueDrained ? this.paint("green", "✓ queue drained") : this.paint("yellow", "! queue not drained"),
					`${formatCount(this.failedActions)} failed actions`,
					`${formatCount(this.timedOutActions)} timed out`,
					`${formatCount(result.queue.failures)} error records`,
				],
				columns,
			),
			...wrapDashboardSegments(
				"pace",
				[
					formatRate(durationSeconds <= 0 ? 0 : result.rootActions / durationSeconds, "roots"),
					formatRate(durationSeconds <= 0 ? 0 : result.queue.completed / durationSeconds, "actions"),
					`${formatProbability(inputYield)} input yield`,
					...(p50 === undefined ? [] : [`root p50 ${formatDuration(p50)}`, `p95 ${formatDuration(p95!)}`, `n=${this.rootDurationsMs.length}`]),
				],
				columns,
			),
			...wrapDashboardSegments("engine", this.finalQueueSegments(result.queue), columns),
			...this.quoteSummaryLines(columns),
			...this.cornerSummaryLines(columns),
			`${this.paint(color, "├─")} ${this.paint("bold", "DIAGNOSTICS")}`,
			...this.discardReasonLines(result.discardedReasons),
			this.detailLine("trace", this.traceHash()),
			...this.dashboardReportLines(columns),
			...this.replaySummaryLines(result, color),
		]
		return lines
	}

	private replaySummaryLines(result: FuzzRunResult | undefined, color: keyof typeof ANSI): string[] {
		const columns = this.summaryColumns()
		return [
			`${this.paint(color, "├─")} ${this.paint("bold", "REPLAY")}`,
			...wrapShellCommand(this.replayTokens(result), columns),
			this.paint(color, "╰─"),
		]
	}

	private summaryColumns(): number {
		return this.options.terminal?.columns ?? process.stdout.columns ?? 120
	}

	private quoteGroups(inventory = this.latestQuoteInventory): ReadonlyArray<{ label: string; segments: string[] }> {
		const status = inventory.byStatus
		return [
			{
				label: "waiting",
				segments: [
					`${formatCount(status.PENDING)} pending`,
					`${formatCount(status.LOCKED)} locked`,
					`${formatCount(status.CANCEL_PENDING)} cancel pending`,
				],
			},
			{
				label: "positions",
				segments: [
					`${formatCount(status.OPENED)} opened`,
					`${formatCount(status.CLOSE_PENDING)} close pending`,
					`${formatCount(status.CANCEL_CLOSE_PENDING)} cancel close`,
				],
			},
			{
				label: "outcomes",
				segments: [
					`${formatCount(status.CANCELED)} canceled`,
					`${formatCount(status.CLOSED)} closed`,
					`${formatCount(status.LIQUIDATED)} liquidated`,
					`${formatCount(status.EXPIRED)} expired`,
					`${formatCount(status.LIQUIDATED_PENDING)} liquidated before open`,
				],
			},
			{
				label: "direction",
				segments: [`${formatCount(inventory.byPositionType.LONG)} long`, `${formatCount(inventory.byPositionType.SHORT)} short`, "all quotes"],
			},
			{
				label: "opening",
				segments: [
					`${formatCount(inventory.byOpeningOrderType.LIMIT)} limit`,
					`${formatCount(inventory.byOpeningOrderType.MARKET)} market`,
					`${formatCount(inventory.byOpeningOrderType.MARKET_BEST_EFFORT)} best effort`,
				],
			},
			{
				label: "closing",
				segments: [
					`${formatCount(inventory.byCloseOrderType.LIMIT)} limit`,
					`${formatCount(inventory.byCloseOrderType.MARKET)} market`,
					`${formatCount(inventory.byCloseOrderType.MARKET_BEST_EFFORT)} best effort`,
					"live close requests",
				],
			},
			{
				label: "partial",
				segments: [
					`${formatCount(inventory.partialOpen.splits)} split opens`,
					`${formatCount(inventory.partialOpen.activePositions)} active split positions`,
					`${formatCount(inventory.partialOpen.waitingRemainders)} waiting remainders`,
					`${formatCount(inventory.partialCloseRequested)} partial close requests`,
					`${formatCount(inventory.partiallyClosed)} partially closed`,
				],
			},
		]
	}

	private quoteSummaryLines(columns = this.summaryColumns()): string[] {
		const inventory = this.latestQuoteInventory
		return [
			`${this.paint("cyan", "├─")} ${this.paint("bold", "QUOTE WORLD")}` +
				` · ${formatCount(inventory.total)} total · ${formatCount(inventory.active)} live · ${formatCount(inventory.terminal)} ended`,
			...this.quoteGroups(inventory).flatMap(({ label, segments }) => wrapDashboardSegments(label, segments, columns)),
		]
	}

	private quoteLiveLines(columns: number): string[] {
		return this.quoteGroups().flatMap(({ label, segments }) => wrapDashboardSegments(label, segments, columns))
	}

	private validatorSamplingSegments(): string[] {
		if (this.eligibleValidatorSelections === 0) {
			return ["no eligible decisions observed yet", `${formatProbability(this.config.validationProbability)} target`]
		}
		return [
			`${formatCount(this.selectedValidators)}/${formatCount(this.eligibleValidatorSelections)} selected in observed decisions`,
			`${formatProbability(this.selectedValidators / this.eligibleValidatorSelections)} observed rate`,
			`${formatProbability(this.config.validationProbability)} target`,
		]
	}

	private confirmedValidationSegments(): string[] {
		if (this.config.eventMode !== "direct") {
			return [
				"provider events cannot confirm changed transitions",
				`${this.confirmedValidationActions.size}/${VALIDATOR_ACTION_TYPE_COUNT} action types confirmed`,
			]
		}
		if (this.observableSuccessfulTransitions === 0) {
			return [
				"waiting for observable changed transitions",
				`${this.confirmedValidationActions.size}/${VALIDATOR_ACTION_TYPE_COUNT} action types confirmed`,
			]
		}
		return [
			`${formatCount(this.confirmedValidatorTransitions)}/${formatCount(this.observableSuccessfulTransitions)} state-changing actions checked`,
			`${this.confirmedValidationActions.size}/${VALIDATOR_ACTION_TYPE_COUNT} action types confirmed`,
		]
	}

	private quoteLifecycleSegments(): string[] {
		const reached = this.reachedQuoteStatuses.size
		const missing = FUZZ_QUOTE_STATUS_NAMES.filter(status => !this.reachedQuoteStatuses.has(status))
		if (missing.length === 0) return ["11/11 quote states observed", this.paint("green", "all states observed")]
		return [`${reached}/11 quote states observed`, missing.length <= 3 ? `unseen ${missing.join(", ")}` : `${missing.length} unseen`]
	}

	private cornerCoverageSegments(): string[] {
		const coverage = this.latestOperationCoverage
		const covered = FUZZ_CORNER_OPERATIONS.filter(operation => coverage.byOperation[operation].succeeded > 0).length
		const inProgress = Math.max(0, coverage.totals.attempted - coverage.totals.succeeded - coverage.totals.skipped - coverage.totals.failed)
		return [
			`${covered}/${FUZZ_CORNER_OPERATIONS.length} rare paths verified`,
			`${formatCount(coverage.totals.succeeded)} passed`,
			`${formatCount(coverage.totals.skipped)} skipped`,
			`${formatCount(coverage.totals.failed)} failed`,
			...(inProgress === 0 ? [] : [`${formatCount(inProgress)} running`]),
		]
	}

	private cornerBadge(operation: FuzzCornerOperation): string {
		const counts = this.latestOperationCoverage.byOperation[operation]
		const inProgress = Math.max(0, counts.attempted - counts.succeeded - counts.skipped - counts.failed)
		const label = CORNER_LABELS[operation]
		if (counts.failed > 0) {
			return `${this.paint("red", "✗")} ${label} · ${counts.succeeded} passed · ${counts.failed} failed`
		}
		if (counts.skipped > 0 && counts.succeeded === 0) {
			return `${this.paint("yellow", "!")} ${label} · ${counts.skipped} skipped`
		}
		if (counts.succeeded > 0) {
			return `${this.paint("green", "✓")} ${label} ×${formatCount(counts.succeeded)}` + (inProgress === 0 ? "" : ` · ${inProgress} running`)
		}
		if (inProgress > 0) return `${this.paint("yellow", "→")} ${label} · running`
		return `${this.paint("dim", "○")} ${label}`
	}

	private assuranceLiveLines(columns: number): string[] {
		return [
			...wrapDashboardSegments("sampling", this.validatorSamplingSegments(), columns),
			...wrapDashboardSegments("confirmed", this.confirmedValidationSegments(), columns),
			...wrapDashboardSegments("lifecycle", this.quoteLifecycleSegments(), columns),
			...wrapDashboardSegments("corners", this.cornerCoverageSegments(), columns),
			...wrapDashboardSegments(
				"rare paths",
				FUZZ_CORNER_OPERATIONS.map(operation => this.cornerBadge(operation)),
				columns,
			),
		]
	}

	private cornerSummaryLines(columns = this.summaryColumns()): string[] {
		const coverage = this.latestOperationCoverage
		const operationLines =
			columns >= 76
				? [
						this.detailLine("operation", "rare path                 attempted  passed  skipped  failed"),
						...FUZZ_CORNER_OPERATIONS.map(operation => {
							const counts = coverage.byOperation[operation]
							return (
								`│ ${"".padEnd(11)}${CORNER_LABELS[operation].padEnd(26)}` +
								`${formatCount(counts.attempted).padStart(9)}  ${formatCount(counts.succeeded).padStart(6)}  ` +
								`${formatCount(counts.skipped).padStart(7)}  ${formatCount(counts.failed).padStart(6)}`
							)
						}),
					]
				: FUZZ_CORNER_OPERATIONS.flatMap(operation => {
						const counts = coverage.byOperation[operation]
						return wrapDashboardSegments(
							"rare path",
							[
								CORNER_LABELS[operation],
								`${formatCount(counts.attempted)} attempted`,
								`${formatCount(counts.succeeded)} passed`,
								`${formatCount(counts.skipped)} skipped`,
								`${formatCount(counts.failed)} failed`,
							],
							columns,
						)
					})
		return [
			`${this.paint("cyan", "├─")} ${this.paint("bold", "ASSURANCE")}`,
			...wrapDashboardSegments("sampling", this.validatorSamplingSegments(), columns),
			...wrapDashboardSegments("confirmed", this.confirmedValidationSegments(), columns),
			...wrapDashboardSegments("lifecycle", this.quoteLifecycleSegments(), columns),
			...wrapDashboardSegments("corners", this.cornerCoverageSegments(), columns),
			...operationLines,
		]
	}

	private engineLiveLines(queue: FuzzQueueSnapshot | undefined, columns: number): string[] {
		if (queue === undefined) return wrapDashboardSegments("queue", ["waiting for first action"], columns)
		const outstanding = Math.max(0, queue.accepted - queue.completed)
		return [
			...wrapDashboardSegments(
				"queue",
				[
					`${formatCount(queue.completed)}/${formatCount(queue.accepted)} settled`,
					`${formatCount(outstanding)} outstanding`,
					`${formatCount(queue.pending)} waiting`,
					`${formatCount(queue.scheduled)} scheduled`,
					queue.running ? "1 active" : "idle",
					...(queue.paused ? ["event queue paused"] : []),
				],
				columns,
			),
			...wrapDashboardSegments(
				"outcomes",
				[
					`${formatCount(this.successfulActions)} succeeded`,
					`${formatCount(this.failedActions)} failed`,
					`${formatCount(this.timedOutActions)} timed out`,
					`${formatCount(queue.failures)} error records`,
				],
				columns,
			),
		]
	}

	private discardReasonLines(reasons: Record<string, number>, columns = this.summaryColumns()): string[] {
		const entries = Object.entries(reasons)
			.filter(([, count]) => count > 0)
			.sort(([left], [right]) => left.localeCompare(right))
		if (entries.length === 0) return wrapDashboardSegments("discards", ["none"], columns)
		return wrapDashboardSegments(
			"discards",
			entries.map(([reason, count]) => `${reason} ×${count}`),
			columns,
		)
	}

	private recentActionLines(): string[] {
		if (this.recentEvents.length === 0) return ["RECENT TRACE none"]
		return [
			"RECENT TRACE",
			...this.recentEvents.map(event => {
				switch (event.type) {
					case "action":
						return `  #${event.sequence} ${event.phase} ${event.title}` + (event.error === undefined ? "" : ` error=${errorMessage(event.error)}`)
					case "decision":
						return (
							`  ${this.eventSequence(event.actionSequence)} ${event.actorId} ${event.action}` +
							` quote=${event.quoteId} trigger=${event.quoteStatus} validate=${event.validated ? "yes" : "no"}`
						)
					case "state":
						return `  ${this.eventSequence(event.actionSequence)} state quote=${event.quoteId} status=${event.quoteStatus}`
					case "operation":
						return (
							`  ${this.eventSequence(event.actionSequence)} corner ${event.operation} ${event.phase}` +
							(event.quoteIds === undefined ? "" : ` quotes=${event.quoteIds.join(",")}`) +
							(event.actorIds === undefined ? "" : ` actors=${event.actorIds.join(",")}`) +
							(event.detail === undefined ? "" : ` detail=${event.detail}`) +
							(event.error === undefined ? "" : ` error=${errorMessage(event.error)}`)
						)
				}
			}),
		]
	}

	private rememberEvent(event: Exclude<FuzzModelEvent, { type: "pause" }>): void {
		this.recentEvents.push(event)
		while (this.recentEvents.length > this.options.recentActionLimit) this.recentEvents.shift()
	}

	private eventSequence(sequence: number | undefined): string {
		return sequence === undefined ? "      " : `#${sequence.toString().padStart(4, "0")}`
	}

	private activitySequencePrefix(sequence: number | undefined): string {
		return sequence === undefined ? "" : `#${sequence.toString().padStart(4, "0")} · `
	}

	private detailLine(label: string, value: string): string {
		return `│ ${this.paint("dim", label.padEnd(10))} ${value}`
	}

	private finalQueueText(queue: FuzzQueueSnapshot): string {
		return this.finalQueueSegments(queue).join(" · ")
	}

	private finalQueueSegments(queue: FuzzQueueSnapshot): string[] {
		const outstanding = Math.max(0, queue.accepted - queue.completed)
		return [
			`${formatCount(queue.completed)}/${formatCount(queue.accepted)} settled`,
			`${formatCount(outstanding)} outstanding`,
			`${formatCount(queue.pending)} waiting`,
			`${formatCount(queue.scheduled)} scheduled`,
			queue.running ? "1 active" : "idle",
			queue.paused ? "event queue paused" : "event queue unpaused",
			`${formatCount(queue.failures)} error records`,
		]
	}

	private dashboardProjection(): FuzzDashboardProjection {
		return {
			quotes: this.quoteInventory(),
			corners: this.operationCoverage(),
			...(this.lastQueue === undefined ? {} : { queue: { ...this.lastQueue } }),
			actions: {
				successful: this.successfulActions,
				failed: this.failedActions,
				timedOut: this.timedOutActions,
			},
			assurance: {
				eligibleValidatorSelections: this.eligibleValidatorSelections,
				selectedValidators: this.selectedValidators,
				observableSuccessfulTransitions: this.observableSuccessfulTransitions,
				confirmedValidatorTransitions: this.confirmedValidatorTransitions,
				confirmedActionTypes: [...this.confirmedValidationActions].sort(),
				observedQuoteStatuses: FUZZ_QUOTE_STATUS_NAMES.filter(status => this.reachedQuoteStatuses.has(status)),
			},
			lastActivity: this.lastActivity,
		}
	}

	private finalizeDashboard(final: Omit<FuzzDashboardFinal, "traceHash" | "replay" | "projection">): void {
		this.recordDashboard(recorder =>
			recorder.finalize({
				...final,
				traceHash: this.traceHash(),
				replay: this.replayCommand(final.result),
				projection: this.dashboardProjection(),
			}),
		)
	}

	private recordDashboard(record: (recorder: FuzzDashboardRecorder) => void): void {
		const recorder = this.options.dashboardRecorder
		if (recorder === undefined) return
		try {
			record(recorder)
		} catch {
			// Dashboard telemetry is diagnostic-only and must never alter the protocol path.
		}
	}

	private dashboardLocation(): ReturnType<FuzzDashboardRecorder["location"]> | undefined {
		try {
			return this.options.dashboardRecorder?.location()
		} catch {
			return undefined
		}
	}

	private dashboardReportLines(columns = this.summaryColumns()): string[] {
		const location = this.dashboardLocation()
		if (location === undefined) return []
		return wrapDashboardSegments(
			"report",
			[...(location.dashboardUrl === undefined ? [] : [`charts ${location.dashboardUrl}`]), `data ${location.file}`],
			columns,
		)
	}

	private recordSemantic(value: unknown): void {
		const serialized = stableStringify(value)
		this.semanticHash.update(`${Buffer.byteLength(serialized)}:`)
		this.semanticHash.update(serialized)
	}
}

export function createFuzzRunLogger(
	config: FuzzRunConfig,
	env: FuzzLogEnvironment = process.env,
	options: Omit<FuzzRunLoggerOptions, "level" | "format" | "color"> & Partial<Pick<FuzzRunLoggerOptions, "level" | "format" | "color">> = {},
): FuzzRunLogger {
	const environment = fuzzLogOptionsFromEnv(env)
	const format = options.format ?? environment.format
	const level = options.level ?? environment.level
	const dashboardRecorder = options.dashboardRecorder ?? createFuzzDashboardRecorderFromEnv(config, env)
	const terminal =
		options.terminal ??
		(options.writer === undefined &&
		format === "pretty" &&
		level === "progress" &&
		config.runMode === "continuous" &&
		Boolean(process.stdout.isTTY) &&
		env.TERM !== "dumb" &&
		!environmentFlag(env.CI)
			? createProcessTerminalSink(process.stdout)
			: undefined)
	return new FuzzRunLogger(config, { ...environment, ...options, terminal, dashboardRecorder })
}
