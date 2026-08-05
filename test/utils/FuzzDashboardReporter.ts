import { createHash } from "node:crypto"
import { mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import type {
	FuzzActionPhase,
	FuzzFailure,
	FuzzModelEvent,
	FuzzQueueSnapshot,
	FuzzRootResult,
	FuzzRunConfig,
	FuzzRunResult,
	FuzzSetupInfo,
	FuzzStopSignal,
} from "../models/FuzzLogTypes.js"
import { FUZZ_CORNER_OPERATIONS, type FuzzCornerOperation } from "../models/FuzzLogTypes.js"
import type { FuzzOperationCoverage } from "./FuzzOperationCoverage.js"
import {
	FUZZ_ORDER_TYPES,
	FUZZ_POSITION_TYPES,
	FUZZ_QUOTE_STATUS_NAMES,
	type FuzzQuoteInventory,
	type FuzzQuoteStatusName,
} from "./FuzzQuoteInventory.js"

export type FuzzDashboardProjection = {
	quotes: FuzzQuoteInventory
	corners: FuzzOperationCoverage
	queue?: FuzzQueueSnapshot
	actions: {
		successful: number
		failed: number
		timedOut: number
	}
	assurance: {
		eligibleValidatorSelections: number
		selectedValidators: number
		observableSuccessfulTransitions: number
		confirmedValidatorTransitions: number
		confirmedActionTypes: string[]
		observedQuoteStatuses: string[]
	}
	lastActivity: string
}

export type FuzzDashboardFinal = {
	outcome: "passed" | "stopped" | "failed"
	result?: FuzzRunResult
	signal?: FuzzStopSignal
	failures?: readonly FuzzFailure[]
	traceHash: string
	replay: string
	projection: FuzzDashboardProjection
}

export interface FuzzDashboardRecorder {
	start(startedAt: number): void
	setupComplete(info: FuzzSetupInfo): void
	onModelEvent(event: FuzzModelEvent, projection: FuzzDashboardProjection): void
	rootComplete(result: FuzzRootResult): void
	stopRequested(signal: FuzzStopSignal): void
	finalize(final: FuzzDashboardFinal): void
	flush(): Promise<void>
	location(): { file: string; dashboardUrl?: string }
}

type FuzzDashboardEnvironment = Readonly<Record<string, string | undefined>>

type RecorderOptions = {
	file: string
	archiveDirectory?: string
	dashboardUrl?: string
	writeIntervalMs: number
	timelineEveryRoots: number
	maxTimeline: number
	maxActivity: number
	maxBytes: number
}

type DashboardStatus = "initializing" | "running" | "draining" | FuzzDashboardFinal["outcome"]

type RootCounters = {
	completed: number
	sent: number
	discarded: number
}

type DecisionCounters = {
	total: number
	validated: number
	unvalidated: number
	noAction: number
}

type QuoteStateMilestone = {
	root: number
	elapsedMs: number
	quoteId: string
	actionSequence?: number
}

type CornerMilestone = {
	root: number
	elapsedMs: number
	actionSequence?: number
	quoteIds?: string[]
	actorIds?: string[]
	detail?: string
}

type TimelineQueuePeak = {
	outstanding: number
	pending: number
	scheduled: number
	running: boolean
}

type RootPace = {
	rootP50Ms: number
	rootP95Ms: number
	window: number
}

type TimelineCheckpoint = {
	root: number
	elapsedMs: number
	durationMs: number
	queue: FuzzQueueSnapshot
	queuePeak: TimelineQueuePeak
	pace: RootPace
	roots: RootCounters
	actions: FuzzDashboardProjection["actions"]
	assurance: FuzzDashboardProjection["assurance"]
	quotes: FuzzQuoteInventory
	corners: FuzzOperationCoverage
}

type ActivityRecord = {
	root: number
	elapsedMs: number
	event: unknown
}

const DEFAULT_WRITE_INTERVAL_MS = 2_000
const DEFAULT_TIMELINE_EVERY_ROOTS = 1
const DEFAULT_MAX_TIMELINE = 256
const DEFAULT_MAX_ACTIVITY = 128
const DEFAULT_MAX_BYTES = 1_048_576
const MIN_MAX_BYTES = 65_536
const MAX_TEXT_LENGTH = 2_048
const MAX_NORMALIZED_ARRAY = 256
const ROOT_DURATION_WINDOW = 64
const SCHEMA_VERSION = 1
const ATOMIC_WRITE_ATTEMPTS = 3

const ACTION_PHASES: readonly FuzzActionPhase[] = ["queued", "started", "succeeded", "failed", "timed_out", "settled_after_timeout"]

function emptyQuoteInventory(): FuzzQuoteInventory {
	return {
		total: 0,
		active: 0,
		terminal: 0,
		byStatus: Object.fromEntries(FUZZ_QUOTE_STATUS_NAMES.map(status => [status, 0])) as FuzzQuoteInventory["byStatus"],
		byPositionType: Object.fromEntries(FUZZ_POSITION_TYPES.map(positionType => [positionType, 0])) as FuzzQuoteInventory["byPositionType"],
		byOpeningOrderType: Object.fromEntries(FUZZ_ORDER_TYPES.map(orderType => [orderType, 0])) as FuzzQuoteInventory["byOpeningOrderType"],
		byCloseOrderType: Object.fromEntries(FUZZ_ORDER_TYPES.map(orderType => [orderType, 0])) as FuzzQuoteInventory["byCloseOrderType"],
		partialOpen: { splits: 0, activePositions: 0, waitingRemainders: 0 },
		partialCloseRequested: 0,
		partiallyClosed: 0,
	}
}

function zeroOperationCounts() {
	return { attempted: 0, succeeded: 0, skipped: 0, failed: 0 }
}

function emptyOperationCoverage(): FuzzOperationCoverage {
	return {
		totals: zeroOperationCounts(),
		byOperation: Object.fromEntries(
			FUZZ_CORNER_OPERATIONS.map(operation => [operation, zeroOperationCounts()]),
		) as FuzzOperationCoverage["byOperation"],
	}
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
		byOperation: Object.fromEntries(
			FUZZ_CORNER_OPERATIONS.map(operation => [operation, { ...coverage.byOperation[operation] }]),
		) as FuzzOperationCoverage["byOperation"],
	}
}

function copyQueue(queue: FuzzQueueSnapshot | undefined): FuzzQueueSnapshot | undefined {
	return queue === undefined ? undefined : { ...queue }
}

function emptyQueuePeak(): TimelineQueuePeak {
	return {
		outstanding: 0,
		pending: 0,
		scheduled: 0,
		running: false,
	}
}

function mergeQueuePeaks(left: TimelineQueuePeak, right: TimelineQueuePeak): TimelineQueuePeak {
	return {
		outstanding: Math.max(left.outstanding, right.outstanding),
		pending: Math.max(left.pending, right.pending),
		scheduled: Math.max(left.scheduled, right.scheduled),
		running: left.running || right.running,
	}
}

function percentile(values: readonly number[], quantile: number): number {
	if (values.length === 0) return 0
	const ordered = [...values].sort((left, right) => left - right)
	const index = Math.max(0, Math.min(ordered.length - 1, Math.ceil(quantile * ordered.length) - 1))
	return ordered[index]
}

function copyProjection(projection: FuzzDashboardProjection): FuzzDashboardProjection {
	return {
		quotes: copyQuoteInventory(projection.quotes),
		corners: copyOperationCoverage(projection.corners),
		...(projection.queue === undefined ? {} : { queue: { ...projection.queue } }),
		actions: { ...projection.actions },
		assurance: {
			...projection.assurance,
			confirmedActionTypes: [...projection.assurance.confirmedActionTypes],
			observedQuoteStatuses: [...projection.assurance.observedQuoteStatuses],
		},
		lastActivity: truncateText(projection.lastActivity),
	}
}

function initialProjection(): FuzzDashboardProjection {
	return {
		quotes: emptyQuoteInventory(),
		corners: emptyOperationCoverage(),
		actions: { successful: 0, failed: 0, timedOut: 0 },
		assurance: {
			eligibleValidatorSelections: 0,
			selectedValidators: 0,
			observableSuccessfulTransitions: 0,
			confirmedValidatorTransitions: 0,
			confirmedActionTypes: [],
			observedQuoteStatuses: [],
		},
		lastActivity: "waiting for the first protocol transition",
	}
}

function truncateText(value: string, maximum = MAX_TEXT_LENGTH): string {
	if (value.length <= maximum) return value
	if (maximum <= 1) return value.slice(0, maximum)
	return `${value.slice(0, maximum - 1)}…`
}

function safeNumber(env: FuzzDashboardEnvironment, names: readonly string[], fallback: number, minimum: number): number {
	const configured = names.map(name => env[name]).find(value => value !== undefined && value !== "")
	if (configured === undefined) return fallback
	const value = Number(configured)
	return Number.isSafeInteger(value) && value >= minimum ? value : fallback
}

function normalizeValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
	if (value === null || typeof value === "boolean") return value
	if (typeof value === "string") return truncateText(value)
	if (typeof value === "bigint") return value.toString()
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
	if (typeof value === "undefined") return "[undefined]"
	if (typeof value === "symbol") return truncateText(value.toString())
	if (typeof value === "function") return `[Function ${truncateText(value.name || "anonymous", 128)}]`
	if (depth >= 12) return "[Max depth]"
	if (seen.has(value)) return "[Circular]"
	seen.add(value)

	if (value instanceof Error) {
		const cause = (() => {
			try {
				return (value as Error & { cause?: unknown }).cause
			} catch {
				return undefined
			}
		})()
		const aggregateErrors = (() => {
			try {
				const errors = (value as Error & { errors?: unknown }).errors
				return Array.isArray(errors) ? errors : undefined
			} catch {
				return undefined
			}
		})()
		return {
			name: truncateText(value.name, 128),
			message: truncateText(value.message),
			...(value.stack === undefined ? {} : { stack: truncateText(value.stack, 4_096) }),
			...(cause === undefined ? {} : { cause: normalizeValue(cause, seen, depth + 1) }),
			...(aggregateErrors === undefined ? {} : { errors: normalizeValue(aggregateErrors, seen, depth + 1) }),
		}
	}

	if (Array.isArray(value)) {
		return value.slice(0, MAX_NORMALIZED_ARRAY).map(item => normalizeValue(item, seen, depth + 1))
	}

	const output: Record<string, unknown> = {}
	for (const [key, item] of Object.entries(value)) {
		output[key] = normalizeValue(item, seen, depth + 1)
	}
	return output
}

function isoTimestamp(value: number | undefined): string | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined
	try {
		return new Date(value).toISOString()
	} catch {
		return undefined
	}
}

function archiveName(config: FuzzRunConfig, startedAt: number | undefined): string {
	const timestamp = (isoTimestamp(startedAt) ?? "unknown-time").replace(/:/g, "-")
	const seedHash = createHash("sha256").update(config.seed).digest("hex").slice(0, 12)
	return `${timestamp}-${seedHash}.json`
}

async function atomicWrite(file: string, content: string, sequence: number): Promise<void> {
	const directory = dirname(file)
	const temporaryFile = `${file}.tmp-${process.pid}-${sequence}`
	await mkdir(directory, { recursive: true })
	try {
		await writeFile(temporaryFile, content, "utf8")
		await rename(temporaryFile, file)
	} catch (error) {
		try {
			await unlink(temporaryFile)
		} catch {
			// The temporary file may not have been created.
		}
		throw error
	}
}

async function atomicWriteWithRetries(file: string, content: string, sequence: number): Promise<void> {
	let lastError: unknown
	for (let attempt = 1; attempt <= ATOMIC_WRITE_ATTEMPTS; attempt++) {
		try {
			await atomicWrite(file, content, sequence * ATOMIC_WRITE_ATTEMPTS + attempt)
			return
		} catch (error) {
			lastError = error
		}
	}
	throw lastError
}

function persistenceError(scope: "report" | "archive", error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error)
	return `${scope}: ${truncateText(detail)}`
}

class JsonFuzzDashboardRecorder implements FuzzDashboardRecorder {
	private projection = initialProjection()
	private status: DashboardStatus = "initializing"
	private startedAt?: number
	private finishedAt?: number
	private setup?: FuzzSetupInfo
	private stopSignal?: FuzzStopSignal
	private finalResult?: FuzzRunResult
	private finalFailures?: readonly FuzzFailure[]
	private traceHash?: string
	private replay?: string
	private latestQueue?: FuzzQueueSnapshot
	private queuePeak = emptyQueuePeak()
	private readonly rootDurations: number[] = []
	private readonly roots: RootCounters = { completed: 0, sent: 0, discarded: 0 }
	private readonly discardedReasons: Record<string, number> = {}
	private readonly decisions: DecisionCounters = { total: 0, validated: 0, unvalidated: 0, noAction: 0 }
	private readonly actionPhases = Object.fromEntries(ACTION_PHASES.map(phase => [phase, 0])) as Record<FuzzActionPhase, number>
	private readonly quoteStateMilestones = Object.fromEntries(FUZZ_QUOTE_STATUS_NAMES.map(status => [status, null])) as Record<
		FuzzQuoteStatusName,
		QuoteStateMilestone | null
	>
	private readonly cornerMilestones = Object.fromEntries(FUZZ_CORNER_OPERATIONS.map(operation => [operation, null])) as Record<
		FuzzCornerOperation,
		CornerMilestone | null
	>
	private readonly timeline: TimelineCheckpoint[] = []
	private readonly activity: ActivityRecord[] = []
	private lastRootResult?: FuzzRootResult
	private timelineStride: number
	private droppedTimeline = 0
	private droppedActivity = 0
	private updatedAt = Date.now()
	private lastWriteAt?: number
	private lastWriteError?: string
	private dirty = false
	private writeTimer?: ReturnType<typeof setTimeout>
	private writeChain: Promise<void> = Promise.resolve()
	private writeRunning = false
	private writeSequence = 0
	private archivePending = false
	private archiveAttempted = false

	constructor(
		private readonly config: FuzzRunConfig,
		private readonly options: RecorderOptions,
	) {
		this.timelineStride = options.timelineEveryRoots
	}

	start(startedAt: number): void {
		this.safely(() => {
			this.startedAt = Number.isFinite(startedAt) ? startedAt : Date.now()
			this.status = "running"
			this.touch(true)
		})
	}

	setupComplete(info: FuzzSetupInfo): void {
		this.safely(() => {
			this.setup = {
				users: info.users.map(actor => ({ ...actor })),
				hedgers: info.hedgers.map(actor => ({ ...actor })),
				durationMs: info.durationMs,
			}
			this.touch(true)
		})
	}

	onModelEvent(event: FuzzModelEvent, projection: FuzzDashboardProjection): void {
		this.safely(() => {
			this.projection = copyProjection(projection)
			this.latestQueue = copyQueue(projection.queue) ?? this.latestQueue
			if (projection.queue !== undefined) this.observeQueue(projection.queue)

			if (event.type === "action") {
				this.actionPhases[event.phase]++
				this.latestQueue = { ...event.queue }
				this.observeQueue(event.queue)
			} else if (event.type === "decision") {
				this.decisions.total++
				if (event.validated) this.decisions.validated++
				else this.decisions.unvalidated++
				if (event.action === "NOTHING") this.decisions.noAction++
			} else if (event.type === "state") {
				const status = event.quoteStatus as FuzzQuoteStatusName
				if (FUZZ_QUOTE_STATUS_NAMES.includes(status) && this.quoteStateMilestones[status] === null) {
					this.quoteStateMilestones[status] = {
						root: this.roots.completed,
						elapsedMs: this.elapsedMs(),
						quoteId: event.quoteId.toString(),
						...(event.actionSequence === undefined ? {} : { actionSequence: event.actionSequence }),
					}
				}
			} else if (event.type === "operation" && event.phase === "succeeded" && this.cornerMilestones[event.operation] === null) {
				this.cornerMilestones[event.operation] = {
					root: this.roots.completed,
					elapsedMs: this.elapsedMs(),
					...(event.actionSequence === undefined ? {} : { actionSequence: event.actionSequence }),
					...(event.quoteIds === undefined ? {} : { quoteIds: event.quoteIds.map(quoteId => quoteId.toString()) }),
					...(event.actorIds === undefined ? {} : { actorIds: [...event.actorIds] }),
					...(event.detail === undefined ? {} : { detail: truncateText(event.detail) }),
				}
			}

			if (event.type !== "pause" && !(event.type === "action" && ["queued", "started"].includes(event.phase))) {
				this.rememberActivity(event)
			}
			const urgent =
				(event.type === "action" && ["failed", "timed_out"].includes(event.phase)) || (event.type === "operation" && event.phase === "failed")
			this.touch(urgent)
		})
	}

	rootComplete(result: FuzzRootResult): void {
		this.safely(() => {
			this.lastRootResult = {
				...result,
				queue: { ...result.queue },
			}
			this.roots.completed = Math.max(this.roots.completed, result.index)
			if (result.status === "sent") this.roots.sent++
			else {
				this.roots.discarded++
				if (result.reason !== undefined) this.discardedReasons[result.reason] = (this.discardedReasons[result.reason] ?? 0) + 1
			}
			this.latestQueue = { ...result.queue }
			this.observeQueue(result.queue)
			this.rememberRootDuration(result.durationMs)
			this.rememberActivity({
				type: "root",
				index: result.index,
				userId: result.userId,
				hedgerId: result.hedgerId,
				status: result.status,
				...(result.quoteId === undefined ? {} : { quoteId: result.quoteId }),
				...(result.reason === undefined ? {} : { reason: result.reason }),
				durationMs: result.durationMs,
				queue: result.queue,
			})
			if (result.index === 1 || result.index % this.timelineStride === 0) {
				this.timeline.push(this.checkpoint(result))
				this.queuePeak = emptyQueuePeak()
				this.compactTimeline()
			}
			this.touch(result.index % 10 === 0)
		})
	}

	stopRequested(signal: FuzzStopSignal): void {
		this.safely(() => {
			this.status = "draining"
			this.stopSignal = signal
			this.touch(true)
		})
	}

	finalize(final: FuzzDashboardFinal): void {
		this.safely(() => {
			this.status = final.outcome
			this.finishedAt = Date.now()
			this.stopSignal = final.signal ?? this.stopSignal
			this.finalResult = final.result === undefined ? undefined : { ...final.result, queue: { ...final.result.queue } }
			this.finalFailures = final.failures === undefined ? undefined : [...final.failures]
			this.traceHash = truncateText(final.traceHash, 256)
			this.replay = truncateText(final.replay, 8_192)
			this.projection = copyProjection(final.projection)
			this.latestQueue = copyQueue(final.projection.queue) ?? this.latestQueue
			if (final.projection.queue !== undefined) this.observeQueue(final.projection.queue)
			if (this.lastRootResult !== undefined && this.timeline.at(-1)?.root !== this.lastRootResult.index) {
				this.timeline.push(this.checkpoint(this.lastRootResult))
				this.queuePeak = emptyQueuePeak()
				this.compactTimeline()
			}
			this.archivePending = this.options.archiveDirectory !== undefined
			this.touch(true)
		})
	}

	async flush(): Promise<void> {
		try {
			if (this.writeTimer !== undefined) {
				clearTimeout(this.writeTimer)
				this.writeTimer = undefined
			}
			while (true) {
				if (this.dirty || (this.archivePending && !this.archiveAttempted)) this.queueWrite()
				const pending = this.writeChain
				await pending
				if (!this.dirty && !this.writeRunning && pending === this.writeChain) return
			}
		} catch {
			// Persistence is deliberately diagnostic-only.
		}
	}

	location(): { file: string; dashboardUrl?: string } {
		return {
			file: this.options.file,
			...(this.options.dashboardUrl === undefined ? {} : { dashboardUrl: this.options.dashboardUrl }),
		}
	}

	private safely(action: () => void): void {
		try {
			action()
		} catch {
			// A malformed diagnostic or persistence request cannot affect fuzzing.
		}
	}

	private elapsedMs(): number {
		return this.startedAt === undefined ? 0 : Math.max(0, Date.now() - this.startedAt)
	}

	private touch(immediate = false): void {
		this.updatedAt = Date.now()
		this.dirty = true
		if (immediate) {
			if (this.writeTimer !== undefined) {
				clearTimeout(this.writeTimer)
				this.writeTimer = undefined
			}
			this.queueWrite()
			return
		}
		if (this.writeTimer !== undefined) return
		this.writeTimer = setTimeout(() => {
			this.writeTimer = undefined
			this.queueWrite()
		}, this.options.writeIntervalMs)
		this.writeTimer.unref?.()
	}

	private rememberActivity(event: unknown): void {
		this.activity.push({
			root: this.roots.completed,
			elapsedMs: this.elapsedMs(),
			event: normalizeValue(event),
		})
		while (this.activity.length > this.options.maxActivity) {
			this.activity.shift()
			this.droppedActivity++
		}
	}

	private observeQueue(queue: FuzzQueueSnapshot): void {
		this.queuePeak.outstanding = Math.max(this.queuePeak.outstanding, Math.max(0, queue.accepted - queue.completed))
		this.queuePeak.pending = Math.max(this.queuePeak.pending, queue.pending)
		this.queuePeak.scheduled = Math.max(this.queuePeak.scheduled, queue.scheduled)
		this.queuePeak.running ||= queue.running
	}

	private rememberRootDuration(durationMs: number): void {
		if (!Number.isFinite(durationMs) || durationMs < 0) return
		this.rootDurations.push(durationMs)
		if (this.rootDurations.length > ROOT_DURATION_WINDOW) this.rootDurations.shift()
	}

	private pace(): RootPace {
		return {
			rootP50Ms: percentile(this.rootDurations, 0.5),
			rootP95Ms: percentile(this.rootDurations, 0.95),
			window: this.rootDurations.length,
		}
	}

	private checkpoint(result: FuzzRootResult): TimelineCheckpoint {
		return {
			root: result.index,
			elapsedMs: this.elapsedMs(),
			durationMs: result.durationMs,
			queue: { ...result.queue },
			queuePeak: { ...this.queuePeak },
			pace: this.pace(),
			roots: { ...this.roots },
			actions: { ...this.projection.actions },
			assurance: {
				...this.projection.assurance,
				confirmedActionTypes: [...this.projection.assurance.confirmedActionTypes],
				observedQuoteStatuses: [...this.projection.assurance.observedQuoteStatuses],
			},
			quotes: copyQuoteInventory(this.projection.quotes),
			corners: copyOperationCoverage(this.projection.corners),
		}
	}

	private compactTimeline(): void {
		while (this.timeline.length > this.options.maxTimeline) {
			this.timelineStride *= 2
			const before = this.timeline.length
			const finalRoot = this.timeline.at(-1)?.root
			const retained = this.timeline.filter(
				checkpoint => checkpoint.root === 1 || checkpoint.root === finalRoot || checkpoint.root % this.timelineStride === 0,
			)
			let carriedPeak = emptyQueuePeak()
			for (const checkpoint of this.timeline) {
				if (retained.includes(checkpoint)) {
					checkpoint.queuePeak = mergeQueuePeaks(carriedPeak, checkpoint.queuePeak)
					carriedPeak = emptyQueuePeak()
				} else {
					carriedPeak = mergeQueuePeaks(carriedPeak, checkpoint.queuePeak)
				}
			}
			this.timeline.splice(0, this.timeline.length, ...retained)
			this.droppedTimeline += before - retained.length
			if (retained.length === before) {
				const [discarded] = this.timeline.splice(1, 1)
				this.timeline[1].queuePeak = mergeQueuePeaks(discarded.queuePeak, this.timeline[1].queuePeak)
				this.droppedTimeline++
			}
		}
	}

	private queueWrite(): void {
		if (this.writeRunning) return
		if (!this.dirty && (!this.archivePending || this.archiveAttempted)) return
		this.dirty = false
		const shouldArchive = this.archivePending && !this.archiveAttempted
		if (shouldArchive) this.archiveAttempted = true

		let content: string
		try {
			content = this.serializeDocument()
		} catch (error) {
			this.lastWriteError = error instanceof Error ? truncateText(error.message) : truncateText(String(error))
			return
		}

		const writeSequence = ++this.writeSequence
		this.writeRunning = true
		this.writeChain = (async () => {
			let primaryError: unknown
			try {
				await atomicWriteWithRetries(this.options.file, content, writeSequence)
				this.lastWriteAt = Date.now()
				this.lastWriteError = undefined
			} catch (error) {
				primaryError = error
				this.lastWriteError = persistenceError("report", error)
			}

			if (shouldArchive && this.options.archiveDirectory !== undefined) {
				try {
					await atomicWriteWithRetries(join(this.options.archiveDirectory, archiveName(this.config, this.startedAt)), content, writeSequence)
				} catch (error) {
					if (primaryError === undefined) {
						this.lastWriteError = persistenceError("archive", error)
						this.dirty = true
					}
				}
			}
		})()
			.catch(error => {
				this.lastWriteError = persistenceError("report", error)
			})
			.finally(() => {
				this.writeRunning = false
				if (this.dirty || (this.archivePending && !this.archiveAttempted)) this.queueWrite()
			})
	}

	private serializeDocument(): string {
		let document = this.document()
		let serialized = JSON.stringify(normalizeValue(document), null, 2)

		while (Buffer.byteLength(serialized) > this.options.maxBytes && this.activity.length > 0) {
			const removeCount = Math.max(1, Math.ceil(this.activity.length / 2))
			this.activity.splice(0, removeCount)
			this.droppedActivity += removeCount
			document = this.document()
			serialized = JSON.stringify(normalizeValue(document), null, 2)
		}
		while (Buffer.byteLength(serialized) > this.options.maxBytes && this.timeline.length > 2) {
			const before = this.timeline.length
			const removeCount = Math.max(1, Math.floor((this.timeline.length - 1) / 2))
			const discarded = this.timeline.slice(1, 1 + removeCount)
			const nextRetained = this.timeline[1 + removeCount]
			nextRetained.queuePeak = discarded.reduce((peak, checkpoint) => mergeQueuePeaks(peak, checkpoint.queuePeak), nextRetained.queuePeak)
			this.timeline.splice(1, removeCount)
			this.droppedTimeline += before - this.timeline.length
			document = this.document()
			serialized = JSON.stringify(normalizeValue(document), null, 2)
		}
		if (Buffer.byteLength(serialized) <= this.options.maxBytes) return serialized

		const minimal = {
			...document,
			timeline: [],
			activity: [],
			retention: {
				...(document.retention as Record<string, unknown>),
				truncatedToByteCap: true,
			},
		}
		return JSON.stringify(normalizeValue(minimal), null, 2)
	}

	private document(): Record<string, unknown> {
		const startedAt = isoTimestamp(this.startedAt)
		const finishedAt = isoTimestamp(this.finishedAt)
		const latestQueue = copyQueue(this.projection.queue) ?? copyQueue(this.latestQueue)
		return {
			schemaVersion: SCHEMA_VERSION,
			kind: "symmio-fuzz-dashboard",
			updatedAt: isoTimestamp(this.updatedAt),
			run: {
				status: this.status,
				seed: truncateText(this.config.seed),
				config: { ...this.config, seed: truncateText(this.config.seed) },
				...(startedAt === undefined ? {} : { startedAt }),
				...(finishedAt === undefined ? {} : { finishedAt }),
				...(this.setup === undefined ? {} : { setup: this.setup }),
				...(this.stopSignal === undefined ? {} : { signal: this.stopSignal }),
				...(this.finalResult === undefined ? {} : { result: this.finalResult }),
				...(this.finalFailures === undefined ? {} : { failures: this.finalFailures }),
				...(this.traceHash === undefined ? {} : { traceHash: this.traceHash }),
				...(this.replay === undefined ? {} : { replay: this.replay }),
				...(this.options.dashboardUrl === undefined ? {} : { dashboardUrl: this.options.dashboardUrl }),
			},
			latest: {
				root: { ...this.roots },
				...(latestQueue === undefined ? {} : { queue: latestQueue }),
				pace: this.pace(),
				actions: { ...this.projection.actions },
				assurance: {
					...this.projection.assurance,
					confirmedActionTypes: [...this.projection.assurance.confirmedActionTypes],
					observedQuoteStatuses: [...this.projection.assurance.observedQuoteStatuses],
				},
				quotes: copyQuoteInventory(this.projection.quotes),
				corners: copyOperationCoverage(this.projection.corners),
				lastActivity: this.projection.lastActivity,
			},
			counters: {
				roots: { ...this.roots },
				discardedReasons: { ...this.discardedReasons },
				actions: { ...this.actionPhases },
				decisions: { ...this.decisions },
			},
			milestones: {
				quoteStates: { ...this.quoteStateMilestones },
				corners: { ...this.cornerMilestones },
			},
			timeline: this.timeline.map(checkpoint => ({
				...checkpoint,
				queue: { ...checkpoint.queue },
				queuePeak: { ...checkpoint.queuePeak },
				pace: { ...checkpoint.pace },
				roots: { ...checkpoint.roots },
				actions: { ...checkpoint.actions },
				assurance: {
					...checkpoint.assurance,
					confirmedActionTypes: [...checkpoint.assurance.confirmedActionTypes],
					observedQuoteStatuses: [...checkpoint.assurance.observedQuoteStatuses],
				},
				quotes: copyQuoteInventory(checkpoint.quotes),
				corners: copyOperationCoverage(checkpoint.corners),
			})),
			activity: this.activity.map(record => ({ ...record })),
			retention: {
				timelineEveryRoots: this.options.timelineEveryRoots,
				timelineStride: this.timelineStride,
				maxTimeline: this.options.maxTimeline,
				maxActivity: this.options.maxActivity,
				maxBytes: this.options.maxBytes,
				droppedTimeline: this.droppedTimeline,
				droppedActivity: this.droppedActivity,
				...(this.lastWriteAt === undefined ? {} : { lastWriteAt: isoTimestamp(this.lastWriteAt) }),
				...(this.lastWriteError === undefined ? {} : { lastWriteError: this.lastWriteError }),
			},
		}
	}
}

export function createFuzzDashboardRecorderFromEnv(
	config: FuzzRunConfig,
	env: FuzzDashboardEnvironment = process.env,
): FuzzDashboardRecorder | undefined {
	const configuredFile = env.FUZZ_DASHBOARD_FILE
	if (configuredFile === undefined || configuredFile.trim() === "") return undefined

	const archiveDirectory = env.FUZZ_DASHBOARD_ARCHIVE_DIR?.trim()
	const dashboardUrl = env.FUZZ_DASHBOARD_URL?.trim()
	const options: RecorderOptions = {
		file: resolve(configuredFile),
		...(archiveDirectory === undefined || archiveDirectory === "" ? {} : { archiveDirectory: resolve(archiveDirectory) }),
		...(dashboardUrl === undefined || dashboardUrl === "" ? {} : { dashboardUrl }),
		writeIntervalMs: safeNumber(env, ["FUZZ_DASHBOARD_WRITE_INTERVAL_MS", "FUZZ_DASHBOARD_WRITE_MS"], DEFAULT_WRITE_INTERVAL_MS, 0),
		timelineEveryRoots: safeNumber(env, ["FUZZ_DASHBOARD_TIMELINE_EVERY_ROOTS", "FUZZ_DASHBOARD_TIMELINE_EVERY"], DEFAULT_TIMELINE_EVERY_ROOTS, 1),
		maxTimeline: safeNumber(env, ["FUZZ_DASHBOARD_MAX_TIMELINE"], DEFAULT_MAX_TIMELINE, 2),
		maxActivity: safeNumber(env, ["FUZZ_DASHBOARD_MAX_ACTIVITY"], DEFAULT_MAX_ACTIVITY, 1),
		maxBytes: safeNumber(env, ["FUZZ_DASHBOARD_MAX_BYTES"], DEFAULT_MAX_BYTES, MIN_MAX_BYTES),
	}
	return new JsonFuzzDashboardRecorder(config, options)
}
