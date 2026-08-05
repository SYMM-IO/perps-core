import { expect } from "chai"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { FuzzModelEvent, FuzzQueueSnapshot, FuzzRootResult, FuzzRunConfig, FuzzRunResult } from "./models/FuzzLogTypes.js"
import { FUZZ_CORNER_OPERATIONS } from "./models/FuzzLogTypes.js"
import {
	createFuzzDashboardRecorderFromEnv,
	type FuzzDashboardFinal,
	type FuzzDashboardProjection,
	type FuzzDashboardRecorder,
} from "./utils/FuzzDashboardReporter.js"
import type { FuzzOperationCoverage } from "./utils/FuzzOperationCoverage.js"
import { FUZZ_QUOTE_STATUS_NAMES, type FuzzQuoteInventory } from "./utils/FuzzQuoteInventory.js"

const config: FuzzRunConfig = {
	seed: "dashboard-seed",
	runMode: "continuous",
	rootActions: 10,
	userCount: 3,
	hedgerCount: 2,
	progressEvery: 1,
	cornerEvery: 2,
	eventMode: "direct",
	validationProbability: 0.2,
	blockedQuoteProbability: 0,
	rethinkDelayMs: 100,
	actionTimeoutMs: 30_000,
	runTimeoutMs: 30_000,
	drainTimeoutMs: 30_000,
}

const queue: FuzzQueueSnapshot = {
	accepted: 3,
	completed: 3,
	scheduled: 0,
	pending: 0,
	running: false,
	paused: false,
	stopped: false,
	failures: 0,
}

function emptyQuotes(): FuzzQuoteInventory {
	return {
		total: 0,
		active: 0,
		terminal: 0,
		byStatus: Object.fromEntries(FUZZ_QUOTE_STATUS_NAMES.map(status => [status, 0])) as FuzzQuoteInventory["byStatus"],
		byPositionType: { LONG: 0, SHORT: 0 },
		byOpeningOrderType: { LIMIT: 0, MARKET: 0 },
		byCloseOrderType: { LIMIT: 0, MARKET: 0 },
		partialOpen: { splits: 0, activePositions: 0, waitingRemainders: 0 },
		partialCloseRequested: 0,
		partiallyClosed: 0,
	}
}

function emptyCorners(): FuzzOperationCoverage {
	const zero = () => ({ attempted: 0, succeeded: 0, skipped: 0, failed: 0 })
	return {
		totals: zero(),
		byOperation: Object.fromEntries(FUZZ_CORNER_OPERATIONS.map(operation => [operation, zero()])) as FuzzOperationCoverage["byOperation"],
	}
}

function projection(overrides: Partial<FuzzDashboardProjection> = {}): FuzzDashboardProjection {
	return {
		quotes: emptyQuotes(),
		corners: emptyCorners(),
		queue,
		actions: { successful: 0, failed: 0, timedOut: 0 },
		assurance: {
			eligibleValidatorSelections: 0,
			selectedValidators: 0,
			observableSuccessfulTransitions: 0,
			confirmedValidatorTransitions: 0,
			confirmedActionTypes: [],
			observedQuoteStatuses: [],
		},
		lastActivity: "waiting",
		...overrides,
	}
}

function root(index: number, status: FuzzRootResult["status"] = "sent"): FuzzRootResult {
	return {
		index,
		userId: "user#1",
		hedgerId: "hedger#1",
		status,
		...(status === "sent" ? { quoteId: BigInt(index) } : { reason: "invalid-generated-quote" }),
		durationMs: index * 10,
		queue: { ...queue, accepted: index, completed: index },
	}
}

function result(rootActions: number): FuzzRunResult {
	return {
		durationMs: rootActions * 10,
		rootActions,
		sentQuotes: rootActions,
		discardedInputs: 0,
		discardedReasons: {},
		queue: { ...queue, accepted: rootActions, completed: rootActions, stopped: true },
	}
}

function final(projectionValue: FuzzDashboardProjection, overrides: Partial<FuzzDashboardFinal> = {}): FuzzDashboardFinal {
	return {
		outcome: "passed",
		result: result(1),
		traceHash: "abc123",
		replay: "FUZZ_SEED=dashboard-seed FUZZ_ROOT_ACTIONS=1 npm run test:fuzz:ci",
		projection: projectionValue,
		...overrides,
	} as FuzzDashboardFinal
}

async function parseReport(file: string): Promise<Record<string, any>> {
	return JSON.parse(await readFile(file, "utf8")) as Record<string, any>
}

export function shouldBehaveLikeFuzzDashboardReporter(): void {
	let temporaryDirectories: string[] = []

	beforeEach(function () {
		temporaryDirectories = []
	})

	afterEach(async function () {
		await Promise.all(temporaryDirectories.map(directory => rm(directory, { recursive: true, force: true })))
	})

	async function temporaryDirectory(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "symmio-fuzz-dashboard-"))
		temporaryDirectories.push(directory)
		return directory
	}

	it("is opt-in and records independently of terminal log level", async function () {
		expect(createFuzzDashboardRecorderFromEnv(config, { FUZZ_LOG_LEVEL: "quiet" })).to.equal(undefined)

		const directory = await temporaryDirectory()
		const file = join(directory, "report.json")
		const recorder = createFuzzDashboardRecorderFromEnv(config, {
			FUZZ_LOG_LEVEL: "quiet",
			FUZZ_DASHBOARD_FILE: file,
			FUZZ_DASHBOARD_URL: "http://127.0.0.1:8123/",
		})
		expect(recorder).not.to.equal(undefined)
		expect(recorder!.location()).to.deep.equal({ file, dashboardUrl: "http://127.0.0.1:8123/" })

		recorder!.start(Date.now())
		recorder!.setupComplete({ users: [], hedgers: [], durationMs: 5 })
		recorder!.finalize(final(projection()))
		await recorder!.flush()

		const report = await parseReport(file)
		expect(report).to.deep.include({ schemaVersion: 1, kind: "symmio-fuzz-dashboard" })
		expect(report.run).to.include({ status: "passed", dashboardUrl: "http://127.0.0.1:8123/" })
	})

	it("persists semantic totals, current projections, milestones, and normalized bigint/error activity", async function () {
		const directory = await temporaryDirectory()
		const file = join(directory, "report.json")
		const recorder = createFuzzDashboardRecorderFromEnv(config, { FUZZ_DASHBOARD_FILE: file })!
		const quotes = emptyQuotes()
		quotes.total = 1
		quotes.active = 1
		quotes.byStatus.PENDING = 1
		const corners = emptyCorners()
		corners.totals = { attempted: 1, succeeded: 1, skipped: 0, failed: 0 }
		corners.byOperation.FUNDING_CHARGE = { attempted: 1, succeeded: 1, skipped: 0, failed: 0 }
		const current = projection({
			quotes,
			corners,
			actions: { successful: 1, failed: 0, timedOut: 0 },
			assurance: {
				eligibleValidatorSelections: 1,
				selectedValidators: 1,
				observableSuccessfulTransitions: 1,
				confirmedValidatorTransitions: 1,
				confirmedActionTypes: ["SEND_QUOTE"],
				observedQuoteStatuses: ["PENDING"],
			},
			lastActivity: "quote #9007199254740993 · PENDING",
		})

		recorder.start(Date.now() - 100)
		recorder.setupComplete({
			users: [{ id: "user#1", address: "0x1111111111111111111111111111111111111111" }],
			hedgers: [{ id: "hedger#1", address: "0x2222222222222222222222222222222222222222" }],
			durationMs: 5,
		})
		recorder.onModelEvent(
			{
				type: "action",
				sequence: 1,
				title: "Root:1:user#1->hedger#1:SendQuote",
				phase: "succeeded",
				queue,
				error: Object.assign(new Error("diagnostic boom"), { cause: 9_007_199_254_740_993n }),
			},
			current,
		)
		recorder.onModelEvent(
			{
				type: "decision",
				actionSequence: 1,
				actor: "user",
				actorId: "user#1",
				quoteId: 9_007_199_254_740_993n,
				quoteStatus: "PENDING",
				action: "SEND_QUOTE",
				validated: true,
			},
			current,
		)
		recorder.onModelEvent(
			{
				type: "state",
				actionSequence: 1,
				quoteId: 9_007_199_254_740_993n,
				quoteStatus: "PENDING",
				quote: {
					positionType: "LONG",
					orderType: "LIMIT",
					quantity: 10_000_000_000_000_000_000n,
					closedAmount: 0n,
					quantityToClose: 0n,
					parentId: 0n,
				},
			},
			current,
		)
		recorder.onModelEvent(
			{
				type: "operation",
				actionSequence: 1,
				operation: "FUNDING_CHARGE",
				phase: "succeeded",
				quoteIds: [9_007_199_254_740_993n],
				actorIds: ["user#1"],
			},
			current,
		)
		recorder.rootComplete({ ...root(1), quoteId: 9_007_199_254_740_993n })
		recorder.finalize(final(current))
		await recorder.flush()

		const report = await parseReport(file)
		expect(report.latest.quotes).to.deep.equal(JSON.parse(JSON.stringify(quotes)))
		expect(report.latest.corners).to.deep.equal(corners)
		expect(report.latest.queue).to.deep.equal(queue)
		expect(report.latest.actions).to.deep.equal({ successful: 1, failed: 0, timedOut: 0 })
		expect(report.counters.decisions).to.deep.equal({ total: 1, validated: 1, unvalidated: 0, noAction: 0 })
		expect(report.counters.roots).to.deep.equal({ completed: 1, sent: 1, discarded: 0 })
		expect(report.milestones.quoteStates.PENDING).to.include({
			quoteId: "9007199254740993",
			actionSequence: 1,
		})
		expect(report.milestones.corners.FUNDING_CHARGE.actionSequence).to.equal(1)
		expect(report.milestones.corners.FUNDING_CHARGE.quoteIds).to.deep.equal(["9007199254740993"])
		expect(report.activity.some((entry: any) => entry.event.quoteId === "9007199254740993")).to.equal(true)
		const actionActivity = report.activity.find((entry: any) => entry.event.type === "action")
		expect(actionActivity.event.error).to.include({ name: "Error", message: "diagnostic boom", cause: "9007199254740993" })
		expect(report.run).to.include({
			status: "passed",
			traceHash: "abc123",
			replay: "FUZZ_SEED=dashboard-seed FUZZ_ROOT_ACTIONS=1 npm run test:fuzz:ci",
		})
	})

	it("preserves queue peaks that occurred before a root settled and resets them after the checkpoint", async function () {
		const directory = await temporaryDirectory()
		const file = join(directory, "report.json")
		const recorder = createFuzzDashboardRecorderFromEnv(config, {
			FUZZ_DASHBOARD_FILE: file,
			FUZZ_DASHBOARD_WRITE_INTERVAL_MS: "60000",
		})!
		const settledQueue = { ...queue, accepted: 4, completed: 4 }
		const current = projection({ queue: settledQueue })

		recorder.start(Date.now())
		recorder.onModelEvent(
			{
				type: "action",
				sequence: 1,
				title: "Root:1:user#1->hedger#1:SendQuote",
				phase: "queued",
				queue: { ...settledQueue, completed: 3, scheduled: 1, pending: 1 },
			},
			current,
		)
		recorder.onModelEvent(
			{
				type: "action",
				sequence: 1,
				title: "Root:1:user#1->hedger#1:SendQuote",
				phase: "started",
				queue: { ...settledQueue, completed: 3, running: true },
			},
			current,
		)
		recorder.onModelEvent(
			{
				type: "action",
				sequence: 1,
				title: "Root:1:user#1->hedger#1:SendQuote",
				phase: "succeeded",
				queue: settledQueue,
			},
			current,
		)
		recorder.rootComplete({ ...root(1), queue: settledQueue })
		recorder.rootComplete({ ...root(2), queue: { ...settledQueue, accepted: 5, completed: 5 } })
		recorder.finalize(final(current, { result: result(2) }))
		await recorder.flush()

		const report = await parseReport(file)
		expect(report.timeline[0].queue).to.deep.equal(settledQueue)
		expect(report.timeline[0].queuePeak).to.deep.equal({
			outstanding: 1,
			pending: 1,
			scheduled: 1,
			running: true,
		})
		expect(report.timeline[1].queuePeak).to.deep.equal({
			outstanding: 0,
			pending: 0,
			scheduled: 0,
			running: false,
		})
	})

	it("compacts queue peaks without losing dropped pressure and keeps exact rolling root pace", async function () {
		const directory = await temporaryDirectory()
		const file = join(directory, "report.json")
		const recorder = createFuzzDashboardRecorderFromEnv(config, {
			FUZZ_DASHBOARD_FILE: file,
			FUZZ_DASHBOARD_MAX_TIMELINE: "4",
			FUZZ_DASHBOARD_MAX_ACTIVITY: "3",
			FUZZ_DASHBOARD_WRITE_INTERVAL_MS: "60000",
		})!
		const current = projection()

		recorder.start(Date.now())
		for (let index = 1; index <= 100; index++) {
			recorder.onModelEvent(
				{
					type: "decision",
					actor: "user",
					actorId: "user#1",
					quoteId: BigInt(index),
					quoteStatus: "PENDING",
					action: "NOTHING",
					validated: false,
				},
				current,
			)
			if (index === 2) {
				recorder.onModelEvent(
					{
						type: "action",
						sequence: 2,
						title: "Root:2:user#1->hedger#1:QueuePressure",
						phase: "queued",
						queue: { ...queue, accepted: 11, completed: 2, scheduled: 7, pending: 8, running: true },
					},
					current,
				)
			}
			if (index === 100) {
				recorder.onModelEvent(
					{
						type: "action",
						sequence: 101,
						title: "Root:100:user#1->hedger#1:FinalDrain",
						phase: "started",
						queue: { ...queue, accepted: 101, completed: 100, running: true },
					},
					current,
				)
			}
			recorder.rootComplete(root(index))
		}
		recorder.finalize(final(current, { result: result(100) }))
		await recorder.flush()

		const report = await parseReport(file)
		expect(report.timeline.length).to.be.at.most(4)
		expect(report.timeline[0].root).to.equal(1)
		expect(report.timeline[0].durationMs).to.equal(10)
		expect(report.timeline.some((checkpoint: any) => checkpoint.root === 2)).to.equal(false)
		const checkpointAfterDroppedPressure = report.timeline.find((checkpoint: any) => checkpoint.root > 2)
		expect(checkpointAfterDroppedPressure.queuePeak).to.deep.equal({
			outstanding: 9,
			pending: 8,
			scheduled: 7,
			running: true,
		})
		expect(report.timeline.at(-1).root).to.equal(100)
		expect(report.timeline.at(-1).durationMs).to.equal(1_000)
		expect(report.timeline.at(-1).queuePeak).to.deep.equal({
			outstanding: 1,
			pending: 0,
			scheduled: 0,
			running: true,
		})
		expect(report.latest.root.completed).to.equal(100)
		expect(report.latest.pace).to.deep.equal({ rootP50Ms: 680, rootP95Ms: 970, window: 64 })
		expect(report.timeline.at(-1).pace).to.deep.equal({ rootP50Ms: 680, rootP95Ms: 970, window: 64 })
		expect(report.activity).to.have.length(3)
		expect(report.activity.at(-1).event).to.include({ type: "root", index: 100, durationMs: 1_000 })
		expect(report.retention.timelineStride).to.be.greaterThan(1)
		expect(report.retention.droppedActivity).to.be.greaterThan(97)
	})

	it("carries queue peaks forward when byte-cap trimming drops their checkpoint", async function () {
		const directory = await temporaryDirectory()
		const file = join(directory, "report.json")
		const recorder = createFuzzDashboardRecorderFromEnv(config, {
			FUZZ_DASHBOARD_FILE: file,
			FUZZ_DASHBOARD_MAX_TIMELINE: "200",
			FUZZ_DASHBOARD_MAX_ACTIVITY: "1",
			FUZZ_DASHBOARD_MAX_BYTES: "65536",
			FUZZ_DASHBOARD_WRITE_INTERVAL_MS: "60000",
		})!
		const current = projection()

		recorder.start(Date.now())
		for (let index = 1; index <= 100; index++) {
			if (index === 2) {
				recorder.onModelEvent(
					{
						type: "action",
						sequence: 2,
						title: "Root:2:user#1->hedger#1:QueuePressure",
						phase: "queued",
						queue: { ...queue, accepted: 15, completed: 2, scheduled: 11, pending: 12, running: true },
					},
					current,
				)
			}
			recorder.rootComplete(root(index))
		}
		recorder.finalize(final(current, { result: result(100) }))
		await recorder.flush()

		const report = await parseReport(file)
		expect(report.retention.droppedTimeline).to.be.greaterThan(0)
		expect(report.timeline.some((checkpoint: any) => checkpoint.root === 2)).to.equal(false)
		const checkpointAfterDroppedPressure = report.timeline.find((checkpoint: any) => checkpoint.root > 2)
		expect(checkpointAfterDroppedPressure.queuePeak).to.deep.equal({
			outstanding: 13,
			pending: 12,
			scheduled: 11,
			running: true,
		})
	})

	it("flushes a final report and one optional immutable archive", async function () {
		const directory = await temporaryDirectory()
		const file = join(directory, "report.json")
		const archiveDirectory = join(directory, "runs")
		const recorder = createFuzzDashboardRecorderFromEnv(config, {
			FUZZ_DASHBOARD_FILE: file,
			FUZZ_DASHBOARD_ARCHIVE_DIR: archiveDirectory,
		})!
		const current = projection()

		recorder.start(1_725_000_000_000)
		recorder.rootComplete(root(1))
		recorder.stopRequested("SIGINT")
		recorder.finalize(
			final(current, {
				outcome: "stopped",
				signal: "SIGINT",
				result: result(1),
			}),
		)
		await recorder.flush()
		await recorder.flush()

		const archivedFiles = await readdir(archiveDirectory)
		expect(archivedFiles).to.have.length(1)
		expect(archivedFiles[0]).to.match(/\.json$/)
		const latest = await parseReport(file)
		const archived = await parseReport(join(archiveDirectory, archivedFiles[0]))
		expect(latest.run).to.include({ status: "stopped", signal: "SIGINT" })
		expect(archived.run).to.include({ status: "stopped", signal: "SIGINT" })
	})

	it("retries atomic writes and surfaces an archive failure in the live report", async function () {
		const directory = await temporaryDirectory()
		const file = join(directory, "report.json")
		const archiveBlocker = join(directory, "archive-is-a-file")
		await writeFile(archiveBlocker, "not a directory")
		const recorder = createFuzzDashboardRecorderFromEnv(config, {
			FUZZ_DASHBOARD_FILE: file,
			FUZZ_DASHBOARD_ARCHIVE_DIR: archiveBlocker,
		})!

		recorder.start(Date.now())
		recorder.rootComplete(root(1))
		recorder.finalize(final(projection()))
		await recorder.flush()

		const report = await parseReport(file)
		expect(report.run.status).to.equal("passed")
		expect(report.retention.lastWriteError).to.include("archive:")
	})

	it("never throws into the fuzz run when atomic persistence fails", async function () {
		const directory = await temporaryDirectory()
		const recorder: FuzzDashboardRecorder = createFuzzDashboardRecorderFromEnv(config, {
			FUZZ_DASHBOARD_FILE: directory,
			FUZZ_DASHBOARD_WRITE_INTERVAL_MS: "1",
		})!

		expect(() => recorder.start(Date.now())).not.to.throw()
		expect(() => recorder.onModelEvent({ type: "pause", paused: true }, projection())).not.to.throw()
		expect(() => recorder.rootComplete(root(1))).not.to.throw()
		expect(() => recorder.finalize(final(projection()))).not.to.throw()
		await recorder.flush()
		expect((await stat(directory)).isDirectory()).to.equal(true)
	})
}
