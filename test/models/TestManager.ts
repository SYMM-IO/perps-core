import { BehaviorSubject, filter, map } from "rxjs"

import { logger } from "../utils/LoggerUtils.js"
import { MultiError } from "../utils/MultiError.js"
import { pause } from "../utils/Pauser.js"
import { Action, actionNamesMap, assertFuzzActionCoverage, assertFuzzActionRoute, FuzzActionRoute } from "./Actions.js"
import { OrderType, PositionType, QuoteStatus } from "./Enums.js"
import { EventListener } from "./EventListener.js"
import type { FuzzModelEvent, FuzzQueueSnapshot } from "./FuzzLogTypes.js"
import { Hedger } from "./Hedger.js"
import type { ActorRoute } from "./QuoteStateRouting.js"
import { shouldRouteQuoteState } from "./QuoteStateRouting.js"
import { RunContext } from "./RunContext.js"
import { SymbolManager } from "./SymbolManager.js"
import { User } from "./User.js"
import { QuoteCheckpoint } from "./quoteCheckpoint.js"
import { AcceptCancelCloseRequestValidator } from "./validators/AcceptCancelCloseRequestValidator.js"
import { AcceptCancelRequestValidator } from "./validators/AcceptCancelRequestValidator.js"
import { CancelCloseRequestValidator } from "./validators/CancelCloseRequestValidator.js"
import { CancelQuoteValidator } from "./validators/CancelQuoteValidator.js"
import { CloseRequestValidator } from "./validators/CloseRequestValidator.js"
import { FillCloseRequestValidator } from "./validators/FillCloseRequestValidator.js"
import { ForceClosePositionValidator } from "./validators/ForceClosePositionValidator.js"
import { LockQuoteValidator } from "./validators/LockQuoteValidator.js"
import { OpenPositionValidator } from "./validators/OpenPositionValidator.js"
import { SendQuoteValidator } from "./validators/SendQuoteValidator.js"
import { TransactionValidator } from "./validators/TransactionValidator.js"
import { UnlockQuoteValidator } from "./validators/UnlockQuoteValidator.js"

export type LoopAction = {
	title: string
	action: () => Promise<void>
}

type QueuedLoopAction = LoopAction & {
	sequence: number
}

export type FuzzActionQueueSummary = {
	accepted: number
	completed: number
	scheduled: number
	pending: number
	running: boolean
	paused: boolean
	stopped: boolean
	failures: ReadonlyArray<{ title: string; cause: unknown }>
}

export type FuzzEventMode = "provider" | "direct"
export type FuzzModelEventObserver = (event: FuzzModelEvent) => void
export type FuzzOperationRecord = Omit<Extract<FuzzModelEvent, { type: "operation" }>, "type" | "actionSequence">

const DEFAULT_FUZZ_ACTION_TIMEOUT_MS = 30_000
const DEFAULT_FUZZ_IDLE_TIMEOUT_MS = 30_000
const DEFAULT_FUZZ_QUIET_PERIOD_MS = 200

function positiveTimeout(value: number, name: string): number {
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, received ${value}`)
	return value
}

function nonNegativeActionDelay(value: number): number {
	if (!Number.isFinite(value) || value < 0) throw new Error(`Fuzz action delay must be a non-negative number, received ${value}`)
	return value
}

function fuzzActionTimeoutMs(): number {
	const configured = process.env.FUZZ_ACTION_TIMEOUT_MS
	return positiveTimeout(configured === undefined ? DEFAULT_FUZZ_ACTION_TIMEOUT_MS : Number(configured), "FUZZ_ACTION_TIMEOUT_MS")
}

export class FuzzActionError extends Error {
	readonly cause: unknown

	constructor(
		readonly actionSequence: number,
		readonly actionTitle: string,
		cause: unknown,
	) {
		const causeMessage = cause instanceof Error ? cause.message : String(cause)
		super(`Fuzz action "${actionTitle}" failed: ${causeMessage}`)
		this.name = "FuzzActionError"
		this.cause = cause
	}
}

export class FuzzActionQueue {
	private readonly pendingActions: QueuedLoopAction[] = []
	private readonly failures: FuzzActionError[] = []
	private readonly scheduledTimers = new Set<ReturnType<typeof setTimeout>>()
	private nextSequence = 1
	private accepted = 0
	private completed = 0
	private running = false
	private activeActionSequence?: number
	private paused = false
	private stopped = false
	private activeTimeoutFailure?: FuzzActionError
	private readonly stateWaiters = new Set<() => void>()

	constructor(
		private readonly actionTimeoutMs = fuzzActionTimeoutMs(),
		private readonly observer: FuzzModelEventObserver = () => undefined,
	) {
		positiveTimeout(actionTimeoutMs, "Fuzz action timeout")
	}

	enqueueAction(action: LoopAction): boolean {
		if (this.stopped) return false
		const queuedAction = { ...action, sequence: this.nextSequence++ }
		this.accepted++
		this.pendingActions.push(queuedAction)
		this.emitActionEvent(queuedAction, "queued")
		this.pump()
		return true
	}

	scheduleAction(delayMs: number, action: LoopAction): boolean {
		if (this.stopped) return false
		nonNegativeActionDelay(delayMs)
		const timer = setTimeout(() => {
			this.scheduledTimers.delete(timer)
			this.enqueueAction(action)
			this.notifyStateChange()
		}, delayMs)
		this.scheduledTimers.add(timer)
		this.notifyStateChange()
		return true
	}

	setPaused(paused: boolean): void {
		this.paused = paused
		if (!paused) this.pump()
		this.notifyStateChange()
	}

	async waitForIdle(timeoutMs = DEFAULT_FUZZ_IDLE_TIMEOUT_MS): Promise<void> {
		positiveTimeout(timeoutMs, "Fuzz idle timeout")
		await this.waitUntilIdle(timeoutMs, true)
	}

	async waitForQuiescence(quietPeriodMs = DEFAULT_FUZZ_QUIET_PERIOD_MS, timeoutMs = DEFAULT_FUZZ_IDLE_TIMEOUT_MS): Promise<void> {
		positiveTimeout(quietPeriodMs, "Fuzz quiet period")
		positiveTimeout(timeoutMs, "Fuzz quiescence timeout")
		const deadline = Date.now() + timeoutMs

		while (true) {
			const remainingMs = deadline - Date.now()
			if (remainingMs <= 0) throw new Error(`Fuzz action queue did not become quiescent within ${timeoutMs}ms`)
			await this.waitForIdle(remainingMs)

			const acceptedAtIdle = this.accepted
			await new Promise(resolve => setTimeout(resolve, quietPeriodMs))
			if (this.isIdle() && this.accepted === acceptedAtIdle) return
		}
	}

	async stopAndDrain(timeoutMs = DEFAULT_FUZZ_IDLE_TIMEOUT_MS): Promise<void> {
		this.requestStop()
		positiveTimeout(timeoutMs, "Fuzz drain timeout")
		await this.waitUntilIdle(timeoutMs, false)
	}

	getSummary(): FuzzActionQueueSummary {
		return {
			accepted: this.accepted,
			completed: this.completed,
			scheduled: this.scheduledTimers.size,
			pending: this.pendingActions.length,
			running: this.running,
			paused: this.paused,
			stopped: this.stopped,
			failures: this.failures.map(failure => ({ title: failure.actionTitle, cause: failure.cause })),
		}
	}

	requestStop(): void {
		if (this.stopped) return
		this.stopped = true
		this.paused = false
		for (const timer of this.scheduledTimers) clearTimeout(timer)
		this.scheduledTimers.clear()
		this.notifyStateChange()
		this.pump()
	}

	private pump(): void {
		if (this.running || this.paused) return
		const action = this.pendingActions.shift()
		if (!action) {
			this.notifyStateChange()
			return
		}

		this.running = true
		this.activeActionSequence = action.sequence
		this.emitActionEvent(action, "started")
		void this.executeAction(action)
	}

	private async executeAction(action: QueuedLoopAction): Promise<void> {
		let phase: Extract<FuzzModelEvent, { type: "action" }>["phase"] = "succeeded"
		let error: unknown

		try {
			const result = await this.runWithTimeout(action)
			phase = result.phase
			error = result.error
		} catch (cause) {
			const failure = new FuzzActionError(action.sequence, action.title, cause)
			this.failures.push(failure)
			phase = "failed"
			error = cause
		} finally {
			this.completed++
			this.running = false
			this.emitActionEvent(action, phase, error)
			this.activeActionSequence = undefined
			this.notifyStateChange()
			this.pump()
		}
	}

	private async runWithTimeout(action: QueuedLoopAction): Promise<{ phase: "succeeded" | "settled_after_timeout"; error?: unknown }> {
		let timeout: ReturnType<typeof setTimeout> | undefined
		const timeoutCause = new Error(`timed out after ${this.actionTimeoutMs}ms`)
		const actionPromise = Promise.resolve().then(() => action.action())
		try {
			await Promise.race([
				actionPromise,
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => reject(timeoutCause), this.actionTimeoutMs)
				}),
			])
			return { phase: "succeeded" }
		} catch (cause) {
			if (cause !== timeoutCause) throw cause

			const timeoutFailure = new FuzzActionError(action.sequence, action.title, timeoutCause)
			this.failures.push(timeoutFailure)
			this.activeTimeoutFailure = timeoutFailure
			this.emitActionEvent(action, "timed_out", timeoutCause)
			this.notifyStateChange()
			try {
				await actionPromise
			} catch (lateCause) {
				this.failures.push(new FuzzActionError(action.sequence, `${action.title} (settled after timeout)`, lateCause))
				this.notifyStateChange()
				return { phase: "settled_after_timeout", error: lateCause }
			} finally {
				this.activeTimeoutFailure = undefined
			}
			return { phase: "settled_after_timeout", error: timeoutCause }
		} finally {
			if (timeout) clearTimeout(timeout)
		}
	}

	private isIdle(): boolean {
		return !this.running && this.pendingActions.length === 0 && this.scheduledTimers.size === 0
	}

	private async waitUntilIdle(timeoutMs: number, surfaceFailuresEarly: boolean): Promise<void> {
		const deadline = Date.now() + timeoutMs
		while (!this.isIdle()) {
			if (surfaceFailuresEarly && this.activeTimeoutFailure) throw this.activeTimeoutFailure
			const remainingMs = deadline - Date.now()
			if (remainingMs <= 0) throw new Error(`Fuzz action queue did not become idle within ${timeoutMs}ms`)
			await this.waitForStateChange(remainingMs)
		}
		if (this.failures.length > 0) throw this.failures[0]
	}

	private waitForStateChange(timeoutMs: number): Promise<void> {
		return new Promise(resolve => {
			const waiter = () => {
				clearTimeout(timer)
				this.stateWaiters.delete(waiter)
				resolve()
			}
			const timer = setTimeout(() => {
				this.stateWaiters.delete(waiter)
				resolve()
			}, timeoutMs)
			this.stateWaiters.add(waiter)
		})
	}

	private notifyStateChange(): void {
		for (const waiter of [...this.stateWaiters]) waiter()
	}

	private getQueueSnapshot(): FuzzQueueSnapshot {
		return {
			accepted: this.accepted,
			completed: this.completed,
			scheduled: this.scheduledTimers.size,
			pending: this.pendingActions.length,
			running: this.running,
			paused: this.paused,
			stopped: this.stopped,
			failures: this.failures.length,
		}
	}

	getActiveActionSequence(): number | undefined {
		return this.activeActionSequence
	}

	private emitActionEvent(action: QueuedLoopAction, phase: Extract<FuzzModelEvent, { type: "action" }>["phase"], error?: unknown): void {
		try {
			this.observer({
				type: "action",
				sequence: action.sequence,
				title: action.title,
				phase,
				queue: this.getQueueSnapshot(),
				...(error === undefined ? {} : { error }),
			})
		} catch {
			// Diagnostic sinks must never change or mask the protocol path under test.
		}
	}
}

export class TestManager {
	users: Map<string, User> = new Map<string, User>()
	hedgers: Map<string, Hedger> = new Map<string, Hedger>()
	symbolManager: SymbolManager
	validators: Map<Action, TransactionValidator> = new Map([
		[Action.CANCEL_REQUEST, new CancelQuoteValidator()],
		[Action.ACCEPT_CANCEL_REQUEST, new AcceptCancelRequestValidator()],
		[Action.LOCK_QUOTE, new LockQuoteValidator()],
		[Action.UNLOCK_QUOTE, new UnlockQuoteValidator()],
		[Action.OPEN_POSITION, new OpenPositionValidator()],
		[Action.CLOSE_REQUEST, new CloseRequestValidator()],
		[Action.CANCEL_CLOSE_REQUEST, new CancelCloseRequestValidator()],
		[Action.ACCEPT_CANCEL_CLOSE_REQUEST, new AcceptCancelCloseRequestValidator()],
		[Action.FILL_POSITION, new FillCloseRequestValidator()],
		[Action.FORCE_CLOSE_REQUEST, new ForceClosePositionValidator()],
		[Action.SEND_QUOTE, new SendQuoteValidator()],
	])
	private readonly actionQueue: FuzzActionQueue
	private pause = new BehaviorSubject<boolean>(false)
	private eventListener?: EventListener

	constructor(
		public context: RunContext,
		onlyInitialize: boolean,
		private readonly eventMode: FuzzEventMode = "provider",
		private readonly observer: FuzzModelEventObserver = () => undefined,
		actionTimeoutMs?: number,
	) {
		this.symbolManager = new SymbolManager()
		this.actionQueue = new FuzzActionQueue(actionTimeoutMs, observer)
		assertFuzzActionCoverage(this.validators)
		if (!onlyInitialize) this.eventListener = new EventListener(context)
	}

	public async start() {
		await this.symbolManager.loadSymbols()
		if (this.eventMode === "provider") await this.eventListener?.start()
	}

	public async registerHedger(hedger: Hedger) {
		this.hedgers.set(await hedger.getAddress(), hedger)
	}

	public async registerUser(user: User) {
		this.users.set(await user.getAddress(), user)
	}

	public getUser(address: string): User {
		return this.users.get(address)!
	}

	public getHedger(address: string): Hedger {
		return this.hedgers.get(address)!
	}

	public getValidator(route: FuzzActionRoute, action: Action): TransactionValidator {
		assertFuzzActionRoute(route, action)
		const validator = this.validators.get(action)
		if (!validator) {
			throw new Error(`Missing validator for ${route} fuzz action ${actionNamesMap.get(action) ?? Action[action] ?? action}`)
		}
		return validator
	}

	public enqueueAction(action: LoopAction): boolean {
		return this.actionQueue.enqueueAction(action)
	}

	public scheduleAction(delayMs: number, action: LoopAction): boolean {
		nonNegativeActionDelay(delayMs)
		// Direct-mode fuzzing uses logical queue order so a seeded replay cannot
		// change when a wall-clock timer happens to fire between transactions.
		if (this.eventMode === "direct") return this.actionQueue.enqueueAction(action)
		return this.actionQueue.scheduleAction(delayMs, action)
	}

	public waitForIdle(timeoutMs = DEFAULT_FUZZ_IDLE_TIMEOUT_MS): Promise<void> {
		return this.actionQueue.waitForIdle(timeoutMs)
	}

	public waitForQuiescence(quietPeriodMs = DEFAULT_FUZZ_QUIET_PERIOD_MS, timeoutMs = DEFAULT_FUZZ_IDLE_TIMEOUT_MS): Promise<void> {
		return this.actionQueue.waitForQuiescence(quietPeriodMs, timeoutMs)
	}

	public async dispatchQuoteState(quoteId: bigint): Promise<void> {
		if (this.eventMode !== "direct") return
		if (!this.eventListener) throw new Error("Fuzz event queues are not available in initialization-only mode")
		const quote = await this.observeQuoteState(quoteId)
		const status = Number(quote.quoteStatus) as QuoteStatus
		this.eventListener.emitQuoteStatus(status, quoteId, {
			partyA: quote.partyA,
			partyB: quote.partyB,
			partyBsWhiteList: [...quote.partyBsWhiteList],
		})
	}

	public async observeQuoteState(quoteId: bigint) {
		const quote = await this.context.viewFacetQuote.getQuote(quoteId)
		const status = Number(quote.quoteStatus) as QuoteStatus
		QuoteCheckpoint.getInstance().observeQuoteStatus(quoteId, status)
		this.emitModelEvent({
			type: "state",
			actionSequence: this.actionQueue.getActiveActionSequence(),
			quoteId,
			quoteStatus: QuoteStatus[status] ?? status.toString(),
			quote: {
				positionType: PositionType[Number(quote.positionType)] ?? quote.positionType.toString(),
				orderType: OrderType[Number(quote.orderType)] ?? quote.orderType.toString(),
				quantity: quote.quantity,
				closedAmount: quote.closedAmount,
				quantityToClose: quote.quantityToClose,
				parentId: quote.parentId,
			},
		})
		return quote
	}

	public recordDecision(actor: "user" | "hedger", actorId: string, quoteId: bigint, quoteStatus: bigint, action: Action, validated: boolean): void {
		const status = Number(quoteStatus) as QuoteStatus
		this.emitModelEvent({
			type: "decision",
			actionSequence: this.actionQueue.getActiveActionSequence(),
			actor,
			actorId,
			quoteId,
			quoteStatus: QuoteStatus[status] ?? status.toString(),
			action: actionNamesMap.get(action) ?? Action[action] ?? action.toString(),
			validated,
		})
	}

	public recordCornerOperation(event: FuzzOperationRecord): void {
		this.emitModelEvent({
			type: "operation",
			actionSequence: this.actionQueue.getActiveActionSequence(),
			...event,
		})
	}

	public async stopAndDrain(timeoutMs = DEFAULT_FUZZ_IDLE_TIMEOUT_MS): Promise<void> {
		let listenerFailure: unknown
		try {
			await this.eventListener?.stop()
		} catch (error) {
			listenerFailure = error
		}

		let queueFailure: unknown
		try {
			await this.actionQueue.stopAndDrain(timeoutMs)
		} catch (error) {
			queueFailure = error
		}

		if (listenerFailure !== undefined && queueFailure !== undefined) {
			throw new MultiError([listenerFailure, queueFailure], "Failed to stop the fuzz event listener and drain the action queue")
		}
		if (listenerFailure !== undefined) throw listenerFailure
		if (queueFailure !== undefined) throw queueFailure
	}

	public requestStop(): void {
		this.actionQueue.requestStop()
	}

	public getSummary(): FuzzActionQueueSummary {
		return this.actionQueue.getSummary()
	}

	public getQueueObservable(status: QuoteStatus, actor?: ActorRoute) {
		if (!this.eventListener) throw new Error("Fuzz event listener is not available in initialization-only mode")
		return this.eventListener.getQueue(status).pipe(
			filter(envelope => actor === undefined || shouldRouteQuoteState(envelope, actor)),
			pause(this.pause),
			map(({ quoteId }) => quoteId),
		)
	}

	public setPauseState(b: boolean) {
		logger.detailedDebug("Pause : " + b)
		this.emitModelEvent({ type: "pause", paused: b })
		this.actionQueue.setPaused(b)
		this.pause.next(b)
	}

	public getPauseState(): boolean {
		return this.pause.value
	}

	private emitModelEvent(event: FuzzModelEvent): void {
		try {
			this.observer(event)
		} catch {
			// Diagnostic sinks must never change or mask the protocol path under test.
		}
	}
}
