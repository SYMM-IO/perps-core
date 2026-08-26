import { expect } from "chai"

import type { FuzzModelEvent, FuzzQueueSnapshot, FuzzQuoteSnapshot, FuzzRootResult, FuzzRunConfig, FuzzRunResult } from "./models/FuzzLogTypes.js"
import type { FuzzDashboardFinal, FuzzDashboardProjection, FuzzDashboardRecorder } from "./utils/FuzzDashboardReporter.js"
import { createFuzzRunLogger, FuzzRunLogger, fuzzLogOptionsFromEnv, type FuzzTerminalSink } from "./utils/FuzzLogger.js"

const config: FuzzRunConfig = {
	seed: "seed-42",
	runMode: "bounded",
	rootActions: 2,
	userCount: 2,
	hedgerCount: 2,
	progressEvery: 10,
	cornerEvery: 4,
	eventMode: "direct",
	validationProbability: 0.75,
	blockedQuoteProbability: 0.25,
	rethinkDelayMs: 100,
	actionTimeoutMs: 1_000,
	runTimeoutMs: 2_000,
	drainTimeoutMs: 3_000,
}

const queue: FuzzQueueSnapshot = {
	accepted: 1,
	completed: 1,
	scheduled: 0,
	pending: 0,
	running: false,
	paused: false,
	stopped: true,
	failures: 0,
}

function root(index: number, total = config.rootActions, overrides: Partial<FuzzRootResult> = {}): FuzzRootResult {
	return {
		index,
		total,
		userId: "user#1",
		hedgerId: "hedger#1",
		status: "sent",
		quoteId: BigInt(index),
		durationMs: index * 10,
		queue,
		...overrides,
	}
}

function result(overrides: Partial<FuzzRunResult> = {}): FuzzRunResult {
	return {
		durationMs: 321,
		rootActions: 2,
		sentQuotes: 1,
		discardedInputs: 1,
		discardedReasons: { "invalid quote": 1 },
		queue,
		...overrides,
	}
}

function action(overrides: Partial<Extract<FuzzModelEvent, { type: "action" }>> = {}): Extract<FuzzModelEvent, { type: "action" }> {
	return {
		type: "action",
		sequence: 1,
		title: "User:PENDING:1",
		phase: "succeeded",
		queue,
		...overrides,
	}
}

function quoteSnapshot(overrides: Partial<FuzzQuoteSnapshot> = {}): FuzzQuoteSnapshot {
	return {
		positionType: "LONG",
		orderType: "LIMIT",
		quantity: 100n,
		closedAmount: 0n,
		quantityToClose: 0n,
		parentId: 0n,
		...overrides,
	}
}

function state(
	quoteId: bigint,
	quoteStatus: string,
	overrides: Partial<FuzzQuoteSnapshot> = {},
	actionSequence?: number,
): Extract<FuzzModelEvent, { type: "state" }> {
	return {
		type: "state",
		...(actionSequence === undefined ? {} : { actionSequence }),
		quoteId,
		quoteStatus,
		quote: quoteSnapshot(overrides),
	}
}

function corner(
	operation: Extract<FuzzModelEvent, { type: "operation" }>["operation"],
	phase: Extract<FuzzModelEvent, { type: "operation" }>["phase"],
	overrides: Partial<Extract<FuzzModelEvent, { type: "operation" }>> = {},
): Extract<FuzzModelEvent, { type: "operation" }> {
	return {
		type: "operation",
		operation,
		phase,
		...overrides,
	}
}

function terminalHarness(columns = 100): {
	terminal: FuzzTerminalSink
	frames: string[][]
	clears: () => number
} {
	const frames: string[][] = []
	let clearCount = 0
	return {
		terminal: {
			columns,
			replace: lines => frames.push([...lines]),
			clear: () => {
				clearCount++
			},
		},
		frames,
		clears: () => clearCount,
	}
}

function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "")
}

export function shouldBehaveLikeFuzzLogger(): void {
	it("pins compact pretty progress and success diagnostics", function () {
		const lines: string[] = []
		const logger = new FuzzRunLogger(config, {
			level: "progress",
			format: "pretty",
			color: false,
			clock: () => 1_000,
			writer: line => lines.push(line),
		})

		logger.start()
		logger.setupComplete({
			users: [
				{ id: "user#1", address: "0xaaa" },
				{ id: "user#2", address: "0xaab" },
			],
			hedgers: [
				{ id: "hedger#1", address: "0xbbb" },
				{ id: "hedger#2", address: "0xbbc" },
			],
			durationMs: 12,
		})
		logger.rootComplete(root(1))
		logger.onModelEvent(action())
		logger.rootComplete(root(2, 2, { status: "discarded", quoteId: undefined, reason: "invalid quote", durationMs: 20 }))
		logger.pass(result())

		const normalized = lines.map(line => (line.startsWith("│ trace") ? "│ trace      <hash>" : line))
		expect(normalized).to.deep.equal([
			"╭─ SYMMIO · FUZZ WORLD",
			'│ seed       "seed-42"',
			"│ profile    bounded · 2 roots · Hardhat",
			"│ world      2 users · 2 hedgers · direct events",
			"│ assurance  75% validator sampling · rare path every 4 roots",
			"│ generation 25% blocked quote generation · 100ms rethink delay",
			"│ guardrails 1.0s action · 2.0s root · 3.0s drain timeout",
			"╰─ replay     FUZZ_SEED=seed-42 FUZZ_RUN_MODE=bounded FUZZ_USER_COUNT=2 FUZZ_HEDGER_COUNT=2 FUZZ_PROGRESS_EVERY=10 FUZZ_CORNER_EVERY=4 FUZZ_ROOT_ACTIONS=2 VALIDATION_PROBABILITY=0.75 FUZZ_BLOCKED_QUOTE_PROBABILITY=0.25 FUZZ_RETHINK_DELAY_MS=100 FUZZ_ACTION_TIMEOUT_MS=1000 FUZZ_RUN_TIMEOUT_MS=2000 FUZZ_DRAIN_TIMEOUT_MS=3000 npm run test:fuzz:ci",
			"✓ WORLD READY  2 users · 2 hedgers · 12ms",
			"  users    user#1 0xaaa   user#2 0xaab",
			"  hedgers  hedger#1 0xbbb   hedger#2 0xbbc",
			"  ◆ ROOT ━━━━━━──────  1/2  user#1 → hedger#1 · quote #1 · 10ms · actions 1/1 · idle",
			"  ○ ROOT ━━━━━━━━━━━━  2/2  user#1 → hedger#1 · discarded · invalid quote · 20ms · actions 1/1 · idle",
			"╭─ SYMMIO FUZZ WORLD · ✓ PASS",
			'│ seed       "seed-42"',
			"├─ RUN",
			"│ result     2 roots · 1 quote sent · 1 input discarded · 321ms",
			"│ health     ✓ queue drained · 0 failed actions · 0 timed out · 0 error records",
			"│ pace       6.2 roots/s · 3.1 actions/s · 50% input yield · root p50 10ms · p95 20ms · n=2",
			"│ engine     1/1 settled · 0 outstanding · 0 waiting · 0 scheduled · idle · event queue unpaused · 0 error records",
			"├─ QUOTE WORLD · 0 total · 0 live · 0 ended",
			"│ waiting    0 pending · 0 locked · 0 cancel pending",
			"│ positions  0 opened · 0 close pending · 0 cancel close",
			"│ outcomes   0 canceled · 0 closed · 0 liquidated · 0 expired · 0 liquidated before open",
			"│ direction  0 long · 0 short · all quotes",
			"│ opening    0 limit · 0 market · 0 best effort",
			"│ closing    0 limit · 0 market · 0 best effort · live close requests",
			"│ partial    0 split opens · 0 active split positions · 0 waiting remainders · 0 partial close requests",
			"│            0 partially closed",
			"├─ ASSURANCE",
			"│ sampling   no eligible decisions observed yet · 75% target",
			"│ confirmed  waiting for observable changed transitions · 0/10 action types confirmed",
			"│ lifecycle  0/11 quote states observed · 11 unseen",
			"│ corners    0/7 rare paths verified · 0 passed · 0 skipped · 0 failed",
			"│ operation  rare path                 attempted  passed  skipped  failed",
			"│            funding charge                    0       0        0       0",
			"│            settle unrealized PnL             0       0        0       0",
			"│            force close                       0       0        0       0",
			"│            emergency close                   0       0        0       0",
			"│            quote expiry                      0       0        0       0",
			"│            Party A liquidation               0       0        0       0",
			"│            Party B liquidation               0       0        0       0",
			"├─ DIAGNOSTICS",
			"│ discards   invalid quote ×1",
			"│ trace      <hash>",
			"├─ REPLAY",
			"│   FUZZ_SEED=seed-42 FUZZ_RUN_MODE=bounded FUZZ_USER_COUNT=2 FUZZ_HEDGER_COUNT=2 FUZZ_PROGRESS_EVERY=10 \\",
			"│   FUZZ_CORNER_EVERY=4 FUZZ_ROOT_ACTIONS=2 VALIDATION_PROBABILITY=0.75 FUZZ_BLOCKED_QUOTE_PROBABILITY=0.25 \\",
			"│   FUZZ_RETHINK_DELAY_MS=100 FUZZ_ACTION_TIMEOUT_MS=1000 FUZZ_RUN_TIMEOUT_MS=2000 FUZZ_DRAIN_TIMEOUT_MS=3000 npm run \\",
			"│   test:fuzz:ci",
			"╰─",
		])
	})

	it("reports continuous progress at a stable cadence and emits a bounded replay on graceful stop", function () {
		const lines: string[] = []
		const logger = new FuzzRunLogger(
			{ ...config, runMode: "continuous", rootActions: 10, progressEvery: 2 },
			{
				level: "progress",
				format: "pretty",
				color: false,
				writer: line => lines.push(line),
			},
		)

		logger.start()
		for (let index = 1; index <= 5; index++) logger.rootComplete({ ...root(index), total: undefined })
		logger.stopRequested("SIGINT")
		logger.stopped("SIGINT", result({ rootActions: 5 }))

		const rootLines = lines.filter(line => line.includes(" ROOT "))
		const startupReplay = lines.find(line => line.includes("FUZZ_RUN_MODE=continuous"))
		expect(startupReplay).to.include("FUZZ_SEED=seed-42 FUZZ_RUN_MODE=continuous FUZZ_USER_COUNT=2 FUZZ_HEDGER_COUNT=2 FUZZ_PROGRESS_EVERY=2")
		expect(startupReplay).to.include("npm run test:fuzz")
		expect(startupReplay).not.to.include("FUZZ_ROOT_ACTIONS")
		expect(rootLines.map(line => Number(line.match(/ROOT #0*(\d+)/)![1]))).to.deep.equal([1, 2, 4])
		expect(rootLines.every(line => line.includes("ROOT #"))).to.equal(true)
		expect(lines).to.include("■ STOP  SIGINT received · finishing the active action and draining accepted work…")
		expect(lines).to.include("╭─ SYMMIO FUZZ WORLD · ■ STOPPED · SIGINT")
		expect(lines).to.include("│ result     5 roots · 1 quote sent · 1 input discarded · 321ms")
		const stoppedOutput = lines.join("\n")
		expect(stoppedOutput).to.include("FUZZ_RUN_MODE=bounded")
		expect(stoppedOutput).to.include("FUZZ_ROOT_ACTIONS=5")
		expect(stoppedOutput).to.include("npm run")
		expect(stoppedOutput).to.include("test:fuzz:ci")
		expect(lines.at(-1)).to.equal("╰─")
		expect(logger.replayCommand(result({ rootActions: 0 }))).to.include("FUZZ_ROOT_ACTIONS=1")
	})

	it("renders continuous TTY progress as a compact live dashboard and clears it before the final summary", function () {
		const lines: string[] = []
		const harness = terminalHarness(100)
		let now = 1_000
		const logger = new FuzzRunLogger(
			{ ...config, runMode: "continuous", progressEvery: 1 },
			{
				level: "progress",
				format: "pretty",
				color: false,
				clock: () => now,
				writer: line => lines.push(line),
				terminal: harness.terminal,
			},
		)

		logger.start()
		logger.setupComplete({
			users: [{ id: "user#1", address: "0x1111111111111111111111111111111111111111" }],
			hedgers: [{ id: "hedger#1", address: "0x2222222222222222222222222222222222222222" }],
			durationMs: 25,
		})
		expect(harness.frames.at(-1)).to.deep.equal([
			"╭─ SYMMIO FUZZ WORLD · RUNNING · 0 roots · 0ms",
			"│ health     … warming up · fixture ready · waiting for actions",
			"│ pace       warming up after fixture setup",
			"├─ NOW",
			"│ last       waiting for the first protocol transition",
			"├─ QUOTE WORLD · 0 total · 0 live · 0 ended",
			"│ waiting    0 pending · 0 locked · 0 cancel pending",
			"│ positions  0 opened · 0 close pending · 0 cancel close",
			"│ outcomes   0 canceled · 0 closed · 0 liquidated · 0 expired · 0 liquidated before open",
			"│ direction  0 long · 0 short · all quotes",
			"│ opening    0 limit · 0 market · 0 best effort",
			"│ closing    0 limit · 0 market · 0 best effort · live close requests",
			"│ partial    0 split opens · 0 active split positions · 0 waiting remainders",
			"│            0 partial close requests · 0 partially closed",
			"├─ ASSURANCE",
			"│ sampling   no eligible decisions observed yet · 75% target",
			"│ confirmed  waiting for observable changed transitions · 0/10 action types confirmed",
			"│ lifecycle  0/11 quote states observed · 11 unseen",
			"│ corners    0/7 rare paths verified · 0 passed · 0 skipped · 0 failed",
			"│ rare paths ○ funding charge · ○ settle unrealized PnL · ○ force close · ○ emergency close",
			"│            ○ quote expiry · ○ Party A liquidation · ○ Party B liquidation",
			"├─ ENGINE",
			"│ queue      waiting for first action",
			"╰─ Ctrl+C drains safely · press again to force",
		])

		const runningQueue = { ...queue, accepted: 2, completed: 1, running: true, stopped: false }
		now = 1_100
		logger.onModelEvent(action({ sequence: 2, title: "Observe:hedger#1:LOCKED:9", phase: "started", queue: runningQueue }))
		expect(harness.frames.at(-1)).to.include("│ active     #0002 · hedger#1 revisits quote #9 in LOCKED")

		now = 1_200
		logger.onModelEvent({
			type: "decision",
			actionSequence: 2,
			actor: "hedger",
			actorId: "hedger#1",
			quoteId: 9n,
			quoteStatus: "LOCKED",
			action: "OPEN_POSITION",
			validated: true,
		})
		expect(harness.frames.at(-1)).to.include("│ active     #0002 · hedger#1 opens position · quote #9 · from LOCKED · validator selected")

		now = 1_300
		logger.onModelEvent(action({ sequence: 2, phase: "succeeded", queue: { ...runningQueue, completed: 2, running: false } }))
		now = 1_400
		logger.rootComplete({ ...root(1), total: undefined, queue: { ...queue, accepted: 2, completed: 2, stopped: false } })
		const activeFrame = harness.frames.at(-1)!
		expect(activeFrame[0]).to.equal("╭─ SYMMIO FUZZ WORLD · RUNNING · 1 root · 400ms")
		expect(activeFrame).to.include("│ health     ✓ clean · queue idle · 2/2 settled")
		expect(activeFrame).to.include("│ last       user#1 → hedger#1 · sent quote #1 · 10ms")
		expect(activeFrame).to.include("├─ QUOTE WORLD · 0 total · 0 live · 0 ended")
		expect(activeFrame).to.include("├─ ASSURANCE")
		expect(activeFrame).to.include("├─ ENGINE")

		logger.stopRequested("SIGINT")
		expect(harness.frames.at(-1)?.[0]).to.equal("╭─ SYMMIO FUZZ WORLD · DRAINING · SIGINT · 1 root · 400ms")
		expect(harness.frames.at(-1)).to.include("│ health     → clean drain · 0 actions · queue drained")
		logger.stopped("SIGINT", result({ rootActions: 1, sentQuotes: 1, discardedInputs: 0 }))
		expect(harness.clears()).to.equal(1)
		expect(lines).to.include("╭─ SYMMIO FUZZ WORLD · ■ STOPPED · SIGINT")
		expect(lines.join("\n")).to.include("FUZZ_ROOT_ACTIONS=1")
		expect(lines.at(-1)).to.equal("╰─")
		expect(lines.join("\n")).not.to.match(/\u001b\[[12][A-Z]/)
	})

	it("keeps a timed-out action active until its late settlement", function () {
		const harness = terminalHarness(100)
		let now = 1_000
		const logger = new FuzzRunLogger(
			{ ...config, runMode: "continuous" },
			{
				level: "progress",
				format: "pretty",
				color: false,
				clock: () => now,
				writer: () => undefined,
				terminal: harness.terminal,
			},
		)
		const runningQueue = { ...queue, accepted: 1, completed: 0, running: true, stopped: false }

		logger.start()
		logger.setupComplete({ users: [], hedgers: [], durationMs: 0 })
		now = 1_100
		logger.onModelEvent(action({ sequence: 7, title: "Rethink:hedger#1:9", phase: "started", queue: runningQueue }))
		now = 1_200
		logger.onModelEvent(action({ sequence: 7, phase: "timed_out", queue: { ...runningQueue, failures: 1 } }))

		const timedOutFrame = harness.frames.at(-1)!
		expect(timedOutFrame).to.include("│ active     #0007 · hedger#1 reconsiders quote #9 · timed out · still settling")
		expect(timedOutFrame.join("\n")).to.include("1 timed-out action")

		now = 1_300
		logger.onModelEvent(
			action({
				sequence: 7,
				phase: "settled_after_timeout",
				queue: { ...runningQueue, completed: 1, running: false, failures: 1 },
			}),
		)
		expect(harness.frames.at(-1)).to.include("│ last       #0007 · hedger#1 reconsiders quote #9 · timed out · still settling")
	})

	it("separates validator selection from confirmed state-changing actions", function () {
		const lines: string[] = []
		const harness = terminalHarness(140)
		let now = 1_000
		const logger = new FuzzRunLogger(
			{ ...config, runMode: "continuous" },
			{
				level: "progress",
				format: "pretty",
				color: false,
				clock: () => now,
				writer: line => lines.push(line),
				terminal: harness.terminal,
			},
		)
		const emit = (event: FuzzModelEvent) => {
			now += 100
			logger.onModelEvent(event)
		}

		logger.start()
		logger.setupComplete({ users: [], hedgers: [], durationMs: 0 })

		emit({
			type: "decision",
			actionSequence: 1,
			actor: "hedger",
			actorId: "hedger#1",
			quoteId: 1n,
			quoteStatus: "PENDING",
			action: "LOCK_QUOTE",
			validated: true,
		})
		emit(action({ sequence: 1, phase: "succeeded" }))

		const selectedWithoutState = harness.frames.at(-1)!.join("\n")
		expect(selectedWithoutState).to.include("│ sampling   1/1 selected in observed decisions · 100% observed rate · 75% target")
		expect(selectedWithoutState).to.include("│ confirmed  waiting for observable changed transitions · 0/10 action types confirmed")
		expect(selectedWithoutState).not.to.include("1/1 state-changing actions checked")

		emit(state(2n, "PENDING"))
		emit({
			type: "decision",
			actionSequence: 2,
			actor: "hedger",
			actorId: "hedger#1",
			quoteId: 2n,
			quoteStatus: "PENDING",
			action: "LOCK_QUOTE",
			validated: true,
		})
		emit(state(2n, "LOCKED", {}, 2))
		emit(action({ sequence: 2, phase: "succeeded" }))

		emit(state(3n, "PENDING"))
		emit({
			type: "decision",
			actionSequence: 3,
			actor: "user",
			actorId: "user#1",
			quoteId: 3n,
			quoteStatus: "PENDING",
			action: "CANCEL_REQUEST",
			validated: false,
		})
		emit(state(3n, "CANCEL_PENDING", {}, 3))
		emit(action({ sequence: 3, phase: "succeeded" }))

		const correlated = harness.frames.at(-1)!.join("\n")
		expect(correlated).to.include("│ sampling   2/3 selected in observed decisions · 66.7% observed rate · 75% target")
		expect(correlated).to.include("│ confirmed  1/2 state-changing actions checked · 1/10 action types confirmed")

		logger.pass(result())
		expect(lines).to.include("│ sampling   2/3 selected in observed decisions · 66.7% observed rate · 75% target")
		expect(lines).to.include("│ confirmed  1/2 state-changing actions checked · 1/10 action types confirmed")
	})

	it("shows every quote, mode, and partial row and reports all lifecycle states observed", function () {
		const lines: string[] = []
		const harness = terminalHarness(140)
		let now = 1_000
		const logger = new FuzzRunLogger(
			{ ...config, runMode: "continuous" },
			{
				level: "progress",
				format: "pretty",
				color: false,
				clock: () => now,
				writer: line => lines.push(line),
				terminal: harness.terminal,
			},
		)

		logger.start()
		logger.setupComplete({ users: [], hedgers: [], durationMs: 0 })
		for (const event of [
			state(1n, "PENDING"),
			state(2n, "LOCKED", { positionType: "SHORT", orderType: "MARKET" }),
			state(3n, "CANCEL_PENDING"),
			state(4n, "CANCELED", { positionType: "SHORT", orderType: "MARKET" }),
			state(5n, "OPENED"),
			state(6n, "CLOSE_PENDING", {
				positionType: "SHORT",
				orderType: "LIMIT",
				quantity: 100n,
				closedAmount: 20n,
				quantityToClose: 40n,
			}),
			state(7n, "OPENED"),
			state(7n, "CANCEL_CLOSE_PENDING", { orderType: "MARKET" }),
			state(8n, "CLOSED", { positionType: "SHORT", orderType: "MARKET", closedAmount: 100n }),
			state(9n, "LIQUIDATED"),
			state(10n, "EXPIRED", { positionType: "SHORT", orderType: "MARKET" }),
			state(11n, "LIQUIDATED_PENDING", { quantity: 40n, parentId: 5n }),
		]) {
			now += 100
			logger.onModelEvent(event)
		}

		const frame = harness.frames.at(-1)!
		expect(frame).to.include("├─ QUOTE WORLD · 11 total · 6 live · 5 ended")
		expect(frame).to.include("│ waiting    1 pending · 1 locked · 1 cancel pending")
		expect(frame).to.include("│ positions  1 opened · 1 close pending · 1 cancel close")
		expect(frame).to.include("│ outcomes   1 canceled · 1 closed · 1 liquidated · 1 expired · 1 liquidated before open")
		expect(frame).to.include("│ direction  6 long · 5 short · all quotes")
		expect(frame).to.include("│ opening    7 limit · 4 market · 0 best effort")
		expect(frame).to.include("│ closing    1 limit · 1 market · 0 best effort · live close requests")
		expect(frame).to.include(
			"│ partial    1 split opens · 1 active split positions · 0 waiting remainders · 1 partial close requests · 1 partially closed",
		)
		expect(frame).to.include("│ lifecycle  11/11 quote states observed · all states observed")

		logger.pass(result({ rootActions: 11, sentQuotes: 11, discardedInputs: 0, discardedReasons: {} }))
		expect(lines).to.include("├─ QUOTE WORLD · 11 total · 6 live · 5 ended")
		expect(lines).to.include("│ waiting    1 pending · 1 locked · 1 cancel pending")
		expect(lines).to.include("│ positions  1 opened · 1 close pending · 1 cancel close")
		expect(lines).to.include("│ outcomes   1 canceled · 1 closed · 1 liquidated · 1 expired · 1 liquidated before open")
		expect(lines).to.include("│ direction  6 long · 5 short · all quotes")
		expect(lines).to.include("│ opening    7 limit · 4 market · 0 best effort")
		expect(lines).to.include("│ closing    1 limit · 1 market · 0 best effort · live close requests")
		expect(lines).to.include(
			"│ partial    1 split opens · 1 active split positions · 0 waiting remainders · 1 partial close requests · 1 partially closed",
		)
		expect(lines).to.include("│ lifecycle  11/11 quote states observed · all states observed")
	})

	it("names every rare path and reports passed, skipped, failed, running, and unseen outcomes", function () {
		const lines: string[] = []
		const harness = terminalHarness(140)
		let now = 1_000
		const logger = new FuzzRunLogger(
			{ ...config, runMode: "continuous" },
			{
				level: "progress",
				format: "pretty",
				color: false,
				clock: () => now,
				writer: line => lines.push(line),
				terminal: harness.terminal,
			},
		)

		logger.start()
		logger.setupComplete({ users: [], hedgers: [], durationMs: 0 })
		for (const event of [
			corner("FUNDING_CHARGE", "started", { quoteIds: [1n], actorIds: ["keeper#1"] }),
			corner("FUNDING_CHARGE", "succeeded", { quoteIds: [1n] }),
			corner("SETTLE_UPNL", "started"),
			corner("SETTLE_UPNL", "skipped", { detail: "nothing to settle" }),
			corner("FORCE_CLOSE", "started"),
			corner("FORCE_CLOSE", "failed", { detail: "cooldown" }),
			corner("EMERGENCY_CLOSE", "started"),
			corner("LIQUIDATE_PARTY_B", "started"),
			corner("LIQUIDATE_PARTY_B", "succeeded"),
		]) {
			now += 100
			logger.onModelEvent(event)
		}

		const live = harness.frames.at(-1)!.join("\n")
		expect(live).to.include("│ corners    2/7 rare paths verified · 2 passed · 1 skipped · 1 failed · 1 running")
		expect(live).to.include("✓ funding charge ×1")
		expect(live).to.include("! settle unrealized PnL · 1 skipped")
		expect(live).to.include("✗ force close · 0 passed · 1 failed")
		expect(live).to.include("→ emergency close · running")
		expect(live).to.include("○ quote expiry")
		expect(live).to.include("○ Party A liquidation")
		expect(live).to.include("✓ Party B liquidation ×1")

		logger.pass(result())
		expect(lines).to.include("│ corners    2/7 rare paths verified · 2 passed · 1 skipped · 1 failed · 1 running")
		const summary = lines.join("\n")
		expect(summary).to.match(/funding charge\s+1\s+1\s+0\s+0/)
		expect(summary).to.match(/settle unrealized PnL\s+1\s+0\s+1\s+0/)
		expect(summary).to.match(/force close\s+1\s+0\s+0\s+1/)
		expect(summary).to.match(/emergency close\s+1\s+0\s+0\s+0/)
		expect(summary).to.match(/quote expiry\s+0\s+0\s+0\s+0/)
		expect(summary).to.match(/Party A liquidation\s+0\s+0\s+0\s+0/)
		expect(summary).to.match(/Party B liquidation\s+1\s+1\s+0\s+0/)
	})

	it("includes corner operations in JSON results and the semantic trace", function () {
		const lines: string[] = []
		const logger = new FuzzRunLogger(config, {
			level: "trace",
			format: "json",
			color: false,
			writer: line => lines.push(line),
		})
		const initialTrace = logger.traceHash()

		logger.onModelEvent(
			corner("LIQUIDATE_PARTY_A", "started", {
				actionSequence: 12,
				quoteIds: [17n, 18n],
				actorIds: ["liquidator#1", "user#2"],
				detail: "insolvency campaign",
			}),
		)
		logger.onModelEvent(
			corner("LIQUIDATE_PARTY_A", "failed", {
				actionSequence: 12,
				quoteIds: [17n, 18n],
				error: new Error("settlement reverted"),
			}),
		)
		expect(logger.traceHash()).not.to.equal(initialTrace)
		logger.pass(result())

		const records = lines.map(line => JSON.parse(line) as Record<string, any>)
		expect(records.map(record => record.type)).to.deep.equal(["model_event", "model_event", "run_passed"])
		expect(records[0].event).to.deep.include({
			type: "operation",
			actionSequence: 12,
			operation: "LIQUIDATE_PARTY_A",
			phase: "started",
			quoteIds: ["17", "18"],
			actorIds: ["liquidator#1", "user#2"],
			detail: "insolvency campaign",
		})
		expect(records[1].event.error).to.include({ name: "Error", message: "settlement reverted" })
		expect(records[2].corners.totals).to.deep.equal({ attempted: 1, succeeded: 0, skipped: 0, failed: 1 })
		expect(records[2].corners.byOperation.LIQUIDATE_PARTY_B).to.deep.equal({
			attempted: 0,
			succeeded: 0,
			skipped: 0,
			failed: 0,
		})
	})

	it("fits live dashboard lines to the terminal and keeps JSON append-only", function () {
		const narrow = terminalHarness(44)
		let now = 1_000
		const pretty = new FuzzRunLogger(
			{ ...config, runMode: "continuous" },
			{
				level: "progress",
				format: "pretty",
				color: true,
				clock: () => now,
				writer: () => undefined,
				terminal: narrow.terminal,
			},
		)
		pretty.start()
		pretty.setupComplete({ users: [], hedgers: [], durationMs: 0 })
		now = 1_100
		pretty.onModelEvent(
			action({
				phase: "started",
				title: "Observe:hedger-with-a-very-long-name:CLOSE_PENDING:123456789",
			}),
		)
		const narrowFrame = narrow.frames.at(-1)!
		expect(narrowFrame.every(line => stripAnsi(line).length <= 43)).to.equal(true)
		expect(narrowFrame.map(stripAnsi).find(line => line.startsWith("│ active"))).to.match(/…$/)
		pretty.fail({ boundary: "execution", error: new Error("boom") }, result(), { emitPretty: false })
		expect(narrow.clears()).to.equal(1)

		const jsonTerminal = terminalHarness()
		const jsonLines: string[] = []
		const json = new FuzzRunLogger(
			{ ...config, runMode: "continuous" },
			{
				level: "progress",
				format: "json",
				color: true,
				writer: line => jsonLines.push(line),
				terminal: jsonTerminal.terminal,
			},
		)
		json.start()
		json.rootComplete({ ...root(1), total: undefined })
		json.pass(result({ rootActions: 1 }))
		expect(jsonTerminal.frames).to.deep.equal([])
		expect(jsonLines.map(line => JSON.parse(line).type)).to.deep.equal(["run_started", "root_complete", "run_passed"])
		expect(jsonLines.every(line => !line.includes("\u001b["))).to.equal(true)
	})

	it("writes one parseable, bigint-safe JSON object per line", function () {
		const lines: string[] = []
		const logger = new FuzzRunLogger(config, {
			level: "trace",
			format: "json",
			color: true,
			writer: line => lines.push(line),
			clock: () => 7,
		})

		logger.start()
		logger.onModelEvent({
			type: "decision",
			actor: "hedger",
			actorId: "hedger#1",
			quoteId: 9_007_199_254_740_993n,
			quoteStatus: "LOCKED",
			action: "OPEN_POSITION",
			validated: true,
		})
		logger.onModelEvent(
			state(9_007_199_254_740_993n, "CLOSE_PENDING", {
				positionType: "SHORT",
				orderType: "MARKET",
				quantity: 100n,
				closedAmount: 20n,
				quantityToClose: 40n,
			}),
		)
		logger.onModelEvent(action({ phase: "failed", error: new Error("reverted") }))
		logger.rootComplete(root(1, 2, { quoteId: 9_007_199_254_740_993n }))
		logger.pass(result())

		expect(lines).to.have.length(6)
		const records = lines.map(line => JSON.parse(line) as Record<string, any>)
		expect(records.map(record => record.type)).to.deep.equal([
			"run_started",
			"model_event",
			"model_event",
			"model_event",
			"root_complete",
			"run_passed",
		])
		expect(records[1].event.quoteId).to.equal("9007199254740993")
		expect(records[2].event.quote).to.include({ quantity: "100", closedAmount: "20", quantityToClose: "40" })
		expect(records[3].event.error).to.include({ name: "Error", message: "reverted" })
		expect(records[4].root.quoteId).to.equal("9007199254740993")
		expect(records[5].quotes).to.deep.include({
			total: 1,
			active: 1,
			terminal: 0,
			partialCloseRequested: 1,
			partiallyClosed: 1,
		})
		expect(lines.every(line => !line.includes("\u001b["))).to.equal(true)
	})

	it("hashes semantic order and outcomes while excluding timing and queue telemetry", function () {
		const telemetryA = { ...queue, accepted: 3, completed: 2, pending: 1, stopped: false }
		const telemetryB = { ...queue, accepted: 300, completed: 200, pending: 100, failures: 7 }
		const makeLogger = (telemetry: FuzzQueueSnapshot, durationMs: number) => {
			const logger = new FuzzRunLogger(config, { level: "quiet", format: "pretty", color: false, writer: () => undefined })
			logger.onModelEvent(action({ queue: telemetry }))
			logger.rootComplete(root(1, 1, { queue: telemetry, durationMs }))
			logger.pass(
				result({
					durationMs,
					queue: telemetry,
				}),
			)
			return logger
		}

		const first = makeLogger(telemetryA, 10)
		const second = makeLogger(telemetryB, 99_999)
		expect(first.traceHash()).to.equal(second.traceHash())
		expect(first.traceHash()).to.match(/^[a-f0-9]{64}$/)

		const reordered = new FuzzRunLogger(config, { level: "quiet", format: "pretty", color: false, writer: () => undefined })
		reordered.rootComplete(root(1, 1, { queue: telemetryA, durationMs: 10 }))
		reordered.onModelEvent(action({ queue: telemetryA }))
		reordered.pass(result({ durationMs: 10, queue: telemetryA }))
		expect(reordered.traceHash()).not.to.equal(first.traceHash())

		const failed = new FuzzRunLogger(config, { level: "quiet", format: "pretty", color: false, writer: () => undefined })
		failed.onModelEvent(action({ queue: telemetryA, phase: "failed", error: new Error("boom") }))
		failed.rootComplete(root(1, 1, { queue: telemetryA, durationMs: 10 }))
		failed.fail({ boundary: "execution", error: new Error("boom") }, result({ durationMs: 10, queue: telemetryA }))
		expect(failed.traceHash()).not.to.equal(first.traceHash())

		const differentConfig = new FuzzRunLogger(
			{ ...config, validationProbability: 0.5 },
			{ level: "quiet", format: "pretty", color: false, writer: () => undefined },
		)
		differentConfig.onModelEvent(action({ queue: telemetryA }))
		differentConfig.rootComplete(root(1, 1, { queue: telemetryA, durationMs: 10 }))
		differentConfig.pass(result({ durationMs: 10, queue: telemetryA }))
		expect(differentConfig.traceHash()).not.to.equal(first.traceHash())
	})

	it("samples long root runs to ten evenly spaced progress lines", function () {
		const lines: string[] = []
		const logger = new FuzzRunLogger(
			{ ...config, rootActions: 100 },
			{
				level: "progress",
				format: "pretty",
				color: false,
				writer: line => lines.push(line),
			},
		)

		for (let index = 1; index <= 100; index++) logger.rootComplete(root(index, 100))

		expect(lines).to.have.length(10)
		expect(lines.map(line => Number(line.match(/(\d+)\/100/)![1]))).to.deep.equal([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
	})

	it("formats rounded minute boundaries without producing sixty seconds", function () {
		const lines: string[] = []
		const logger = new FuzzRunLogger(config, {
			level: "summary",
			format: "pretty",
			color: false,
			writer: line => lines.push(line),
		})

		logger.pass(result({ durationMs: 119_999 }))
		expect(lines).to.include("│ result     2 roots · 1 quote sent · 1 input discarded · 2m00s")
	})

	it("keeps failure diagnostics in quiet mode and safely quotes replay seeds", function () {
		const lines: string[] = []
		const failureConfig = { ...config, seed: "odd seed'$HOME\nnext" }
		const logger = new FuzzRunLogger(failureConfig, {
			level: "quiet",
			format: "pretty",
			color: false,
			recentActionLimit: 3,
			writer: line => lines.push(line),
		})
		logger.onModelEvent(action({ sequence: 7, title: "Hedger:OPENED:9" }))
		logger.onModelEvent({
			type: "decision",
			actionSequence: 7,
			actor: "hedger",
			actorId: "hedger#1",
			quoteId: 9n,
			quoteStatus: "OPENED",
			action: "FILL_POSITION",
			validated: true,
		})
		logger.onModelEvent(state(9n, "CLOSED", { closedAmount: 100n }, 7))

		logger.fail(
			[
				{ boundary: "execution", error: new Error("transaction reverted") },
				{ boundary: "drain", error: new Error("queue remained busy") },
			],
			result(),
		)

		expect(lines[0]).to.equal("╭─ ✗ FAIL · 2 boundaries")
		expect(lines.join("\n")).to.include("1. execution transaction reverted")
		expect(lines.join("\n")).to.include("2. drain   queue remained busy")
		expect(lines.join("\n")).to.include("1/1 settled")
		expect(lines.join("\n")).to.include("0 error records")
		expect(lines.join("\n")).to.include("#7 succeeded Hedger:OPENED:9")
		expect(lines.join("\n")).to.include("#0007 hedger#1 FILL_POSITION quote=9 trigger=OPENED validate=yes")
		expect(lines.join("\n")).to.include("#0007 state quote=9 status=CLOSED")
		expect(lines.join("\n")).to.include(`FUZZ_SEED=$'odd seed\\'$HOME\\nnext'`)
		expect(lines).to.include("├─ REPLAY")
		expect(lines.at(-1)).to.equal("╰─")
	})

	it("feeds the visual recorder independently from terminal verbosity and flushes it on demand", async function () {
		const calls: string[] = []
		let finalReport: FuzzDashboardFinal | undefined
		let eventProjection: FuzzDashboardProjection | undefined
		const dashboardRecorder: FuzzDashboardRecorder = {
			start: () => calls.push("start"),
			setupComplete: () => calls.push("setup"),
			onModelEvent: (_event, projectionValue) => {
				calls.push("event")
				eventProjection = projectionValue
			},
			rootComplete: () => calls.push("root"),
			stopRequested: () => calls.push("stop"),
			finalize: finalValue => {
				calls.push("final")
				finalReport = finalValue
			},
			flush: async () => {
				calls.push("flush")
			},
			location: () => ({ file: "/tmp/fuzz-report.json", dashboardUrl: "http://127.0.0.1:4173" }),
		}
		const logger = new FuzzRunLogger(config, {
			level: "quiet",
			format: "pretty",
			color: false,
			writer: () => undefined,
			dashboardRecorder,
		})

		logger.start()
		logger.setupComplete({ users: [], hedgers: [], durationMs: 1 })
		logger.onModelEvent(state(17n, "PENDING"))
		logger.rootComplete(root(1))
		logger.stopRequested("SIGINT")
		logger.stopped("SIGINT", result({ rootActions: 1 }))
		await logger.flushDashboard()

		expect(calls).to.deep.equal(["start", "setup", "event", "root", "stop", "final", "flush"])
		expect(eventProjection?.quotes).to.include({ total: 1, active: 1, terminal: 0 })
		expect(eventProjection?.quotes.byStatus.PENDING).to.equal(1)
		expect(finalReport).to.include({ outcome: "stopped", signal: "SIGINT" })
		expect(finalReport?.projection.quotes.byStatus.PENDING).to.equal(1)
		expect(finalReport?.replay).to.include("FUZZ_ROOT_ACTIONS=1")
	})

	it("validates logging environment values and never lets a writer failure escape", function () {
		expect(() => fuzzLogOptionsFromEnv({ FUZZ_LOG_LEVEL: "verbose" })).to.throw("FUZZ_LOG_LEVEL must be one of quiet|summary|progress|trace")
		expect(() => fuzzLogOptionsFromEnv({ FUZZ_LOG_FORMAT: "yaml" })).to.throw("FUZZ_LOG_FORMAT must be one of pretty|json")
		expect(() => fuzzLogOptionsFromEnv({ FUZZ_LOG_COLOR: "sometimes" })).to.throw("FUZZ_LOG_COLOR must be one of auto|always|never")

		const coloredLines: string[] = []
		const colored = createFuzzRunLogger(
			config,
			{ FUZZ_LOG_LEVEL: "summary", FUZZ_LOG_FORMAT: "pretty", FUZZ_LOG_COLOR: "always" },
			{ writer: line => coloredLines.push(line) },
		)
		colored.start()
		expect(coloredLines[0]).to.include("\u001b[")

		const traceLines: string[] = []
		const coloredTrace = new FuzzRunLogger(config, {
			level: "trace",
			format: "pretty",
			color: true,
			writer: line => traceLines.push(line),
		})
		coloredTrace.onModelEvent(action({ phase: "started" }))
		expect(traceLines[0]).to.include("\u001b[33m→")
		expect(traceLines[0]).not.to.include("undefined")

		const brokenWriter = new FuzzRunLogger(config, {
			level: "quiet",
			format: "json",
			color: false,
			writer: () => {
				throw new Error("broken stdout")
			},
		})
		expect(() => brokenWriter.fail({ boundary: "setup", error: new Error("protocol failure") })).not.to.throw()
	})
}
