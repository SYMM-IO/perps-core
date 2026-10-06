import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import type {
	FuzzActorInfo,
	FuzzFailure,
	FuzzFailureBoundary,
	FuzzQueueSnapshot,
	FuzzRootResult,
	FuzzRunConfig,
	FuzzRunMode,
	FuzzRunResult,
	FuzzStopSignal,
} from "./models/FuzzLogTypes.js"
import { Hedger } from "./models/Hedger.js"
import { HedgerController } from "./models/HedgerController.js"
import { ManagedError } from "./models/ManagedError.js"
import type { RunContext } from "./models/RunContext.js"
import { TestManager } from "./models/TestManager.js"
import type { FuzzActionQueueSummary } from "./models/TestManager.js"
import { User } from "./models/User.js"
import { UserController } from "./models/UserController.js"
import { QuoteCheckpoint } from "./models/quoteCheckpoint.js"
import { decimal } from "./utils/Common.js"
import { FuzzCornerCampaign } from "./utils/FuzzCornerCampaign.js"
import { createFuzzRunLogger, type FuzzRunLoggerOptions } from "./utils/FuzzLogger.js"
import { assertRequiredFuzzOperationCoverage } from "./utils/FuzzOperationCoverage.js"
import { FuzzStopController, runFuzzRootLoop } from "./utils/FuzzRunControl.js"
import { MultiError } from "./utils/MultiError.js"
import { pick, setRandomSeed } from "./utils/RandomUtils.js"

const DEFAULT_ROOT_ACTIONS = 10
const DEFAULT_USER_COUNT = 3
const DEFAULT_HEDGER_COUNT = 2
const DEFAULT_RETHINK_DELAY_MS = 100
const DEFAULT_ACTION_TIMEOUT_MS = 30_000
const DEFAULT_RUN_TIMEOUT_MS = 30_000
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000
const MAX_USER_COUNT = 3
const MAX_HEDGER_COUNT = 2
const PROFILE_DEFAULTS: Record<FuzzRunMode, { progressEvery: number; validationProbability: number; cornerEvery: number }> = {
	continuous: {
		progressEvery: 1,
		validationProbability: 0.2,
		cornerEvery: 2,
	},
	bounded: {
		progressEvery: 10,
		validationProbability: 1,
		cornerEvery: 1,
	},
}

type UserActor = {
	info: FuzzActorInfo
	user: User
	controller: UserController
}

type HedgerActor = {
	info: FuzzActorInfo
	hedger: Hedger
	controller: HedgerController
}

type CornerActors = {
	reusable: { info: FuzzActorInfo; user: User }
	sacrifice: { info: FuzzActorInfo; user: User }
}

export type FuzzRunnerOptions = {
	env?: NodeJS.ProcessEnv
	runMode?: FuzzRunMode
	stop?: FuzzStopController
	loggerOptions?: FuzzRunLoggerOptions
}

export type FuzzRunCompletion = {
	outcome: "passed" | "stopped"
	signal?: FuzzStopSignal
	result: FuzzRunResult
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
	const value = Number(env[name] ?? defaultValue)
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, received ${env[name]}`)
	return value
}

function nonNegativeInteger(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
	const value = Number(env[name] ?? defaultValue)
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, received ${env[name]}`)
	return value
}

function probability(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
	const value = Number(env[name] ?? defaultValue)
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error(`${name} must be a number between 0 and 1, received ${env[name]}`)
	}
	return value
}

function runModeFromEnv(env: NodeJS.ProcessEnv): FuzzRunMode {
	const mode = env.FUZZ_RUN_MODE ?? "continuous"
	if (mode !== "continuous" && mode !== "bounded") {
		throw new Error(`FUZZ_RUN_MODE must be continuous or bounded, received ${mode}`)
	}
	return mode
}

function boundedActorCount(env: NodeJS.ProcessEnv, name: string, defaultValue: number, maximum: number): number {
	const value = positiveInteger(env, name, defaultValue)
	if (value > maximum) throw new Error(`${name} cannot exceed the ${maximum} actors available in the fuzz fixture, received ${value}`)
	return value
}

export function resolveFuzzRunConfig(options: Pick<FuzzRunnerOptions, "env" | "runMode"> = {}): FuzzRunConfig {
	const env = options.env ?? process.env
	const runMode = options.runMode ?? runModeFromEnv(env)
	const defaults = PROFILE_DEFAULTS[runMode]
	return {
		seed: env.FUZZ_SEED ?? Date.now().toString(),
		runMode,
		rootActions: positiveInteger(env, "FUZZ_ROOT_ACTIONS", DEFAULT_ROOT_ACTIONS),
		userCount: boundedActorCount(env, "FUZZ_USER_COUNT", DEFAULT_USER_COUNT, MAX_USER_COUNT),
		hedgerCount: boundedActorCount(env, "FUZZ_HEDGER_COUNT", DEFAULT_HEDGER_COUNT, MAX_HEDGER_COUNT),
		progressEvery: positiveInteger(env, "FUZZ_PROGRESS_EVERY", defaults.progressEvery),
		cornerEvery: nonNegativeInteger(env, "FUZZ_CORNER_EVERY", defaults.cornerEvery),
		eventMode: "direct",
		validationProbability: probability(env, "VALIDATION_PROBABILITY", defaults.validationProbability),
		blockedQuoteProbability: probability(env, "FUZZ_BLOCKED_QUOTE_PROBABILITY", 0),
		rethinkDelayMs: nonNegativeInteger(env, "FUZZ_RETHINK_DELAY_MS", DEFAULT_RETHINK_DELAY_MS),
		actionTimeoutMs: positiveInteger(env, "FUZZ_ACTION_TIMEOUT_MS", DEFAULT_ACTION_TIMEOUT_MS),
		runTimeoutMs: positiveInteger(env, "FUZZ_RUN_TIMEOUT_MS", DEFAULT_RUN_TIMEOUT_MS),
		drainTimeoutMs: positiveInteger(env, "FUZZ_DRAIN_TIMEOUT_MS", DEFAULT_DRAIN_TIMEOUT_MS),
	}
}

function queueSnapshot(summary: FuzzActionQueueSummary): FuzzQueueSnapshot {
	return {
		accepted: summary.accepted,
		completed: summary.completed,
		scheduled: summary.scheduled,
		pending: summary.pending,
		running: summary.running,
		paused: summary.paused,
		stopped: summary.stopped,
		failures: summary.failures.length,
	}
}

function runResult(
	startedAt: number,
	rootActions: number,
	sentQuotes: number,
	discardedInputs: number,
	discardedReasons: Record<string, number>,
	summary: FuzzActionQueueSummary,
): FuzzRunResult {
	return {
		durationMs: Date.now() - startedAt,
		rootActions,
		sentQuotes,
		discardedInputs,
		discardedReasons,
		queue: queueSnapshot(summary),
	}
}

function recordFailure(failures: FuzzFailure[], boundary: FuzzFailureBoundary, error: unknown): void {
	if (!failures.some(failure => failure.error === error)) failures.push({ boundary, error })
}

function discardedInputReason(error: unknown): string | undefined {
	if (!(error instanceof ManagedError)) return undefined
	if (error.message.includes("Insufficient funds available for tradingFee")) return "insufficient-trading-fee"
	if (error.message.includes("Insufficient funds available")) return "insufficient-balance"
	if (error.message.includes("Too many open quotes")) return "pending-quote-limit"
	if (error.message.includes("Random data lead to invalid quote")) return "invalid-generated-quote"
	return undefined
}

function replayableError(failures: readonly FuzzFailure[], diagnostics: string): Error {
	const causes =
		failures.length === 1
			? failures[0].error
			: new MultiError(
					failures.map(({ error }) => error),
					"The fuzz run failed at multiple boundaries",
				)
	const message = failures
		.map(({ boundary, error }, index) => {
			const detail = error instanceof Error ? error.message : String(error)
			return failures.length === 1 ? detail : `${index + 1}. [${boundary}] ${detail}`
		})
		.join("\n")
	const error = new Error(`${message}\n\n${diagnostics}`)
	;(error as Error & { cause: unknown }).cause = causes
	return error
}

function assertSuccessfulResult(result: FuzzRunResult, summary: FuzzActionQueueSummary, requireTransition: boolean): void {
	if (summary.failures.length > 0) throw new Error(`The fuzz queue recorded ${summary.failures.length} action failure(s)`)
	if (summary.accepted !== summary.completed) {
		throw new Error(`The fuzz queue completed ${summary.completed} of ${summary.accepted} accepted actions`)
	}
	if (requireTransition) {
		if (result.sentQuotes === 0) throw new Error("The generator did not submit a valid quote")
		if (summary.completed <= result.sentQuotes + result.discardedInputs) {
			throw new Error("The event-driven model did not execute transitions beyond root quote actions")
		}
	}
}

async function createActors(context: RunContext, manager: TestManager, checkpoint: QuoteCheckpoint, config: FuzzRunConfig, stop: FuzzStopController) {
	const userSigners = [context.signers.user, context.signers.user2, context.signers.others[0]].slice(0, config.userCount)
	const hedgerSigners = [context.signers.hedger, context.signers.hedger2].slice(0, config.hedgerCount)
	const users: UserActor[] = []
	const hedgers: HedgerActor[] = []
	const controllerOptions = {
		validationProbability: config.validationProbability,
		blockedQuoteProbability: config.blockedQuoteProbability,
		rethinkDelayMs: config.rethinkDelayMs,
	}

	for (const [index, signer] of userSigners.entries()) {
		if (stop.requested) break
		const user = new User(context, signer)
		await user.setup()
		await user.setNativeBalance(100n * 10n ** 18n)
		await user.setBalances(decimal(1_000_000n), decimal(1_000_000n), decimal(1_000_000n))
		const info = { id: `user#${index + 1}`, address: await user.getAddress() }
		users.push({ info, user, controller: new UserController(manager, user, checkpoint, info.id, controllerOptions) })
	}

	for (const [index, signer] of hedgerSigners.entries()) {
		if (stop.requested) break
		const hedger = new Hedger(context, signer)
		await hedger.setup()
		await hedger.setNativeBalance(100n * 10n ** 18n)
		await hedger.setBalances(decimal(5_000_000n), decimal(5_000_000n))
		const info = { id: `hedger#${index + 1}`, address: await hedger.getAddress() }
		hedgers.push({ info, hedger, controller: new HedgerController(manager, hedger, checkpoint, info.id, controllerOptions) })
	}

	for (const actor of users) {
		if (stop.requested) break
		await actor.controller.start()
	}
	for (const actor of hedgers) {
		if (stop.requested) break
		await actor.controller.start()
	}
	return { users, hedgers }
}

async function createCornerActors(context: RunContext, manager: TestManager, stop: FuzzStopController): Promise<CornerActors | undefined> {
	if (stop.requested) return undefined
	const signers = await ethers.getSigners()
	const cornerSigners = signers.slice(13, 15)
	if (cornerSigners.length !== 2) throw new Error(`The fuzz corner campaign requires two spare Hardhat signers, found ${cornerSigners.length}`)

	const actors: Array<{ info: FuzzActorInfo; user: User }> = []
	for (const [index, signer] of cornerSigners.entries()) {
		const user = new User(context, signer)
		await user.setup()
		await user.setNativeBalance(100n * 10n ** 18n)
		await user.setBalances(decimal(1_000_000n), decimal(1_000_000n), decimal(1_000_000n))
		actors.push({
			info: {
				id: index === 0 ? "corner#reusable" : "corner#sacrifice",
				address: await user.getAddress(),
			},
			user,
		})
	}
	return { reusable: actors[0], sacrifice: actors[1] }
}

async function revisitRandomPosition(manager: TestManager, users: readonly UserActor[], rootIndex: number, timeoutMs: number): Promise<void> {
	const actor = pick(users)
	const positions = await actor.user.getOpenPositions()
	if (positions.length === 0) return
	const quote = pick(positions)
	const accepted = manager.enqueueAction({
		title: `World:${rootIndex}:${actor.info.id}:Revisit:${quote.id}`,
		action: () => manager.dispatchQuoteState(quote.id),
	})
	if (!accepted) return
	await manager.waitForIdle(timeoutMs)
}

export async function runFuzzSimulation(options: FuzzRunnerOptions = {}): Promise<FuzzRunCompletion> {
	const env = options.env ?? process.env
	const config = resolveFuzzRunConfig({ env, runMode: options.runMode })
	const { actionTimeoutMs, drainTimeoutMs, rootActions, runMode, runTimeoutMs, seed } = config
	const stop = options.stop ?? new FuzzStopController()
	const fuzzLogger = createFuzzRunLogger(config, env, options.loggerOptions)

	let manager: TestManager | undefined
	let users: UserActor[] = []
	let hedgers: HedgerActor[] = []
	let cornerCampaign: FuzzCornerCampaign | undefined
	let summary: FuzzActionQueueSummary | undefined
	let attemptedRootActions = 0
	let sentQuotes = 0
	let discardedInputs = 0
	const discardedReasons: Record<string, number> = {}
	const failures: FuzzFailure[] = []
	const startedAt = Date.now()
	let boundary: FuzzFailureBoundary = "setup"
	let controllersStopped = false

	const stopControllers = () => {
		if (controllersStopped) return
		controllersStopped = true
		for (const actor of users) actor.controller.stop()
		for (const actor of hedgers) actor.controller.stop()
	}
	const disposeStopLog = stop.onStop(signal => fuzzLogger.stopRequested(signal))
	const disposeExecutionStop = stop.onStop(() => {
		stopControllers()
		manager?.requestStop()
	})

	setRandomSeed(seed)
	fuzzLogger.start()

	try {
		const context = await initializeFixture()
		manager = new TestManager(context, false, "direct", event => fuzzLogger.onModelEvent(event), actionTimeoutMs)
		context.manager = manager
		await manager.start()
		await context.controlFacet.connect(context.signers.admin).setBalanceLimitPerUser(decimal(10_000_000n))

		const checkpoint = QuoteCheckpoint.getInstance()
		checkpoint.reset()
		if (!stop.requested) {
			;({ users, hedgers } = await createActors(context, manager, checkpoint, config, stop))
		}
		if (!stop.requested && config.cornerEvery > 0) {
			const cornerActors = await createCornerActors(context, manager, stop)
			if (cornerActors !== undefined) {
				cornerCampaign = new FuzzCornerCampaign({
					context,
					manager,
					reusableUser: cornerActors.reusable.user,
					sacrificeUser: cornerActors.sacrifice.user,
					hedger: hedgers[0].hedger,
					actorIds: {
						reusableUser: cornerActors.reusable.info.id,
						sacrificeUser: cornerActors.sacrifice.info.id,
						hedger: hedgers[0].info.id,
					},
					seed: `${seed}:corners`,
				})
			}
		}
		fuzzLogger.setupComplete({
			users: users.map(({ info }) => info),
			hedgers: hedgers.map(({ info }) => info),
			durationMs: Date.now() - startedAt,
		})
		if (stop.requested) {
			stopControllers()
			manager.requestStop()
		}
		boundary = "execution"

		await runFuzzRootLoop({ mode: runMode, rootActions, stop }, async index => {
			const user = pick(users)
			const hedger = pick(hedgers)
			const rootStartedAt = Date.now()
			let rootResult: Omit<FuzzRootResult, "index" | "total" | "durationMs" | "queue" | "userId" | "hedgerId"> | undefined
			const accepted = manager!.enqueueAction({
				title: `Root:${index}:${user.info.id}->${hedger.info.id}:SendQuote`,
				action: async () => {
					try {
						const quoteId = await user.controller.sendQuote(undefined, [hedger.info.address])
						sentQuotes++
						rootResult = { status: "sent", quoteId }
					} catch (error) {
						const reason = discardedInputReason(error)
						if (reason === undefined) throw error
						discardedInputs++
						discardedReasons[reason] = (discardedReasons[reason] ?? 0) + 1
						rootResult = { status: "discarded", reason }
					}
				},
			})
			if (!accepted) {
				if (stop.requested) return false
				throw new Error(`Root action ${index} was rejected before the fuzz run requested stop`)
			}
			attemptedRootActions = index
			await manager!.waitForIdle(runTimeoutMs)
			if (!stop.requested && cornerCampaign !== undefined && index % config.cornerEvery === 0) {
				const cornerAccepted = manager!.enqueueAction({
					title: `Corner:${index}`,
					action: async () => {
						await cornerCampaign!.executeNext()
					},
				})
				if (!cornerAccepted) throw new Error(`Corner campaign at root ${index} was rejected before the fuzz run requested stop`)
				await manager!.waitForIdle(runTimeoutMs)
			}
			if (!stop.requested) await revisitRandomPosition(manager!, users, index, runTimeoutMs)
			if (rootResult === undefined) throw new Error(`Root action ${index} completed without a generated-input result`)
			fuzzLogger.rootComplete({
				...rootResult,
				index,
				...(runMode === "bounded" ? { total: rootActions } : {}),
				userId: user.info.id,
				hedgerId: hedger.info.id,
				durationMs: Date.now() - rootStartedAt,
				queue: queueSnapshot(manager!.getSummary()),
			})
			return true
		})
	} catch (error) {
		recordFailure(failures, boundary, error)
	} finally {
		stopControllers()
		if (manager) {
			try {
				await manager.stopAndDrain(drainTimeoutMs)
			} catch (error) {
				recordFailure(failures, "drain", error)
			}
			summary = manager.getSummary()
		}
		disposeExecutionStop()
		disposeStopLog()
		setRandomSeed(undefined)
	}

	const result =
		summary === undefined ? undefined : runResult(startedAt, attemptedRootActions, sentQuotes, discardedInputs, discardedReasons, summary)
	if (failures.length > 0) {
		const diagnostics = fuzzLogger.fail(failures, result, { emitPretty: false })
		await fuzzLogger.flushDashboard()
		throw replayableError(failures, diagnostics)
	}

	try {
		if (summary === undefined || result === undefined) throw new Error("The fuzz manager did not complete setup")
		assertSuccessfulResult(result, summary, runMode === "bounded")
		assertRequiredFuzzOperationCoverage(config, fuzzLogger.operationCoverage())
	} catch (error) {
		const verificationFailure: FuzzFailure = { boundary: "verification", error }
		const diagnostics = fuzzLogger.fail(verificationFailure, result, { emitPretty: false })
		await fuzzLogger.flushDashboard()
		throw replayableError([verificationFailure], diagnostics)
	}

	if (stop.requested) {
		fuzzLogger.stopped(stop.signal!, result)
		await fuzzLogger.flushDashboard()
		return { outcome: "stopped", signal: stop.signal, result }
	}
	fuzzLogger.pass(result)
	await fuzzLogger.flushDashboard()
	return { outcome: "passed", result }
}
