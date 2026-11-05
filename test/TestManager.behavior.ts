import { expect } from "chai"

import { Action } from "./models/Actions.js"
import { OrderType, PositionType, QuoteStatus } from "./models/Enums.js"
import type { FuzzModelEvent } from "./models/FuzzLogTypes.js"
import type { Hedger } from "./models/Hedger.js"
import type { ActorRoute } from "./models/QuoteStateRouting.js"
import { RunContext } from "./models/RunContext.js"
import { FuzzActionError, FuzzActionQueue, TestManager } from "./models/TestManager.js"
import type { User } from "./models/User.js"

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>(done => {
		resolve = done
	})
	return { promise, resolve }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise
		throw new Error("Expected promise to reject")
	} catch (error) {
		return error
	}
}

export function shouldBehaveLikeTestManager(): void {
	describe("FuzzActionQueue", function () {
		it("runs accepted actions serially", async function () {
			const queue = new FuzzActionQueue(1_000)
			const first = deferred()
			const firstStarted = deferred()
			const order: string[] = []

			queue.enqueueAction({
				title: "first",
				action: async () => {
					order.push("first:start")
					firstStarted.resolve()
					await first.promise
					order.push("first:end")
				},
			})
			queue.enqueueAction({
				title: "second",
				action: async () => {
					order.push("second")
				},
			})

			await firstStarted.promise
			expect(order).to.deep.equal(["first:start"])

			first.resolve()
			await queue.waitForIdle(1_000)

			expect(order).to.deep.equal(["first:start", "first:end", "second"])
			expect(queue.getSummary()).to.include({
				accepted: 2,
				completed: 2,
				pending: 0,
				running: false,
				scheduled: 0,
			})
		})

		it("emits deterministic action lifecycle events with queue snapshots", async function () {
			const events: FuzzModelEvent[] = []
			const queue = new FuzzActionQueue(1_000, event => events.push(event))

			queue.enqueueAction({ title: "first", action: async () => undefined })
			queue.enqueueAction({
				title: "second",
				action: async () => {
					throw new Error("boom")
				},
			})

			await rejectionOf(queue.waitForIdle(1_000))

			const actionEvents = events.filter((event): event is Extract<FuzzModelEvent, { type: "action" }> => event.type === "action")
			expect(actionEvents.map(({ sequence, phase, title }) => ({ sequence, phase, title }))).to.deep.equal([
				{ sequence: 1, phase: "queued", title: "first" },
				{ sequence: 1, phase: "started", title: "first" },
				{ sequence: 2, phase: "queued", title: "second" },
				{ sequence: 1, phase: "succeeded", title: "first" },
				{ sequence: 2, phase: "started", title: "second" },
				{ sequence: 2, phase: "failed", title: "second" },
			])
			expect(actionEvents.at(-1)!.queue).to.deep.include({
				accepted: 2,
				completed: 2,
				pending: 0,
				running: false,
				failures: 1,
			})
		})

		it("holds accepted actions while paused and resumes them in order", async function () {
			const queue = new FuzzActionQueue(1_000)
			const order: string[] = []

			queue.setPaused(true)
			queue.enqueueAction({ title: "first", action: async () => void order.push("first") })
			queue.enqueueAction({ title: "second", action: async () => void order.push("second") })

			expect(order).to.deep.equal([])
			expect(queue.getSummary()).to.include({ accepted: 2, pending: 2, paused: true, running: false })

			queue.setPaused(false)
			await queue.waitForIdle(1_000)

			expect(order).to.deep.equal(["first", "second"])
		})

		it("waits through a quiet period for externally enqueued follow-up work", async function () {
			const queue = new FuzzActionQueue(1_000)
			const order: string[] = []

			queue.enqueueAction({ title: "root", action: async () => void order.push("root") })
			setTimeout(() => {
				queue.enqueueAction({ title: "event follow-up", action: async () => void order.push("follow-up") })
			}, 15)

			await queue.waitForQuiescence(30, 1_000)

			expect(order).to.deep.equal(["root", "follow-up"])
			expect(queue.getSummary()).to.include({ accepted: 2, completed: 2, pending: 0, running: false })
		})

		it("surfaces an action rejection with its title and cause", async function () {
			const queue = new FuzzActionQueue(1_000)
			const cause = new Error("transaction reverted")
			let continued = false

			queue.enqueueAction({
				title: "LockQuote #17",
				action: async () => {
					throw cause
				},
			})
			queue.enqueueAction({
				title: "next action",
				action: async () => {
					continued = true
				},
			})

			const error = await rejectionOf(queue.waitForIdle(1_000))

			expect(error).to.be.instanceOf(FuzzActionError)
			expect((error as Error).message).to.include("LockQuote #17")
			expect((error as Error).message).to.include("transaction reverted")
			expect((error as FuzzActionError).actionSequence).to.equal(1)
			expect((error as FuzzActionError).cause).to.equal(cause)
			expect(continued).to.equal(true)
			expect(queue.getSummary()).to.include({ accepted: 2, completed: 2 })
			expect(queue.getSummary().failures).to.deep.equal([{ title: "LockQuote #17", cause }])

			const drainError = await rejectionOf(queue.stopAndDrain(1_000))
			expect(drainError).to.equal(error)
		})

		it("reports a timeout without overlapping or prematurely draining the action", async function () {
			const queue = new FuzzActionQueue(25)
			const stalled = deferred()
			let continued = false

			queue.enqueueAction({
				title: "stalled action",
				action: () => stalled.promise,
			})
			queue.enqueueAction({
				title: "next action",
				action: async () => {
					continued = true
				},
			})

			const error = await rejectionOf(queue.waitForIdle(1_000))

			expect(error).to.be.instanceOf(FuzzActionError)
			expect((error as Error).message).to.include("stalled action")
			expect((error as Error).message).to.include("timed out after 25ms")
			expect(continued).to.equal(false)
			expect(queue.getSummary()).to.include({ accepted: 2, completed: 0, pending: 1, running: true })

			stalled.resolve()
			const drainError = await rejectionOf(queue.stopAndDrain(1_000))

			expect(drainError).to.equal(error)
			expect(continued).to.equal(true)
			expect(queue.getSummary()).to.include({ accepted: 2, completed: 2, pending: 0, running: false, stopped: true })
		})

		it("cancels scheduled work on stop and drains already accepted actions", async function () {
			const queue = new FuzzActionQueue(1_000)
			const releaseFirst = deferred()
			const firstStarted = deferred()
			const order: string[] = []

			queue.enqueueAction({
				title: "first",
				action: async () => {
					order.push("first")
					firstStarted.resolve()
					await releaseFirst.promise
				},
			})
			queue.enqueueAction({
				title: "second",
				action: async () => {
					order.push("second")
				},
			})
			queue.scheduleAction(10_000, {
				title: "scheduled",
				action: async () => {
					order.push("scheduled")
				},
			})

			await firstStarted.promise
			expect(queue.getSummary()).to.include({ accepted: 2, completed: 0, pending: 1, running: true, scheduled: 1 })

			const drain = queue.stopAndDrain(1_000)
			expect(queue.getSummary()).to.include({ stopped: true, scheduled: 0 })
			expect(queue.enqueueAction({ title: "late", action: async () => undefined })).to.equal(false)

			releaseFirst.resolve()
			await drain

			expect(order).to.deep.equal(["first", "second"])
			expect(queue.getSummary()).to.include({
				accepted: 2,
				completed: 2,
				pending: 0,
				running: false,
				scheduled: 0,
				stopped: true,
			})
		})
	})

	describe("TestManager scheduling", function () {
		it("registers multiple users and hedgers by address", async function () {
			const manager = new TestManager({} as RunContext, true, "direct")
			const user1 = { getAddress: async () => "0xuser1" } as User
			const user2 = { getAddress: async () => "0xuser2" } as User
			const hedger1 = { getAddress: async () => "0xhedger1" } as Hedger
			const hedger2 = { getAddress: async () => "0xhedger2" } as Hedger

			await Promise.all([manager.registerUser(user1), manager.registerUser(user2), manager.registerHedger(hedger1), manager.registerHedger(hedger2)])

			expect(manager.getUser("0xuser1") === user1).to.equal(true)
			expect(manager.getUser("0xuser2") === user2).to.equal(true)
			expect(manager.getHedger("0xhedger1") === hedger1).to.equal(true)
			expect(manager.getHedger("0xhedger2") === hedger2).to.equal(true)
			await manager.stopAndDrain(1_000)
		})

		it("associates controller decisions with the active queue action", async function () {
			const events: FuzzModelEvent[] = []
			const manager = new TestManager({} as RunContext, true, "direct", event => events.push(event))

			manager.enqueueAction({
				title: "user transition",
				action: async () => {
					manager.recordDecision("user", "user#1", 17n, BigInt(QuoteStatus.PENDING), Action.NOTHING, false)
				},
			})
			await manager.waitForIdle(1_000)

			expect(events.find((event): event is Extract<FuzzModelEvent, { type: "decision" }> => event.type === "decision")).to.deep.equal({
				type: "decision",
				actionSequence: 1,
				actor: "user",
				actorId: "user#1",
				quoteId: 17n,
				quoteStatus: "PENDING",
				action: "NOTHING",
				validated: false,
			})
			await manager.stopAndDrain(1_000)
		})

		it("uses logical queue order for delayed work in deterministic direct mode", async function () {
			const manager = new TestManager({} as RunContext, true, "direct")
			const order: string[] = []

			manager.enqueueAction({
				title: "root",
				action: async () => {
					order.push("root:start")
					manager.scheduleAction(10_000, {
						title: "rethink",
						action: async () => void order.push("rethink"),
					})
					order.push("root:end")
				},
			})

			await manager.waitForIdle(1_000)

			expect(order).to.deep.equal(["root:start", "root:end", "rethink"])
			expect(manager.getSummary()).to.include({ accepted: 2, completed: 2, scheduled: 0, pending: 0, running: false })
			await manager.stopAndDrain(1_000)
		})

		it("enqueues direct quote observations only for the owner and allowlisted hedger", async function () {
			const events: FuzzModelEvent[] = []
			const quote = {
				quoteStatus: BigInt(QuoteStatus.PENDING),
				positionType: BigInt(PositionType.SHORT),
				orderType: BigInt(OrderType.MARKET),
				quantity: 100n,
				closedAmount: 25n,
				quantityToClose: 10n,
				parentId: 3n,
				partyA: "0x00000000000000000000000000000000000000a2",
				partyB: "0x0000000000000000000000000000000000000000",
				partyBsWhiteList: ["0x00000000000000000000000000000000000000b2"],
			}
			let quoteReads = 0
			const facet = { runner: {} }
			const context = {
				partyAFacet: facet,
				partyBQuoteActionsFacet: facet,
				partyBPositionActionsFacet: facet,
				viewFacetQuote: {
					getQuote: async () => {
						quoteReads++
						return quote
					},
				},
			} as unknown as RunContext
			const manager = new TestManager(context, false, "direct", event => events.push(event))
			const recipients: string[] = []
			const actorRoutes: Array<[string, ActorRoute]> = [
				["user#1", { kind: "user", address: "0x00000000000000000000000000000000000000a1" }],
				["user#2", { kind: "user", address: "0x00000000000000000000000000000000000000a2" }],
				["user#3", { kind: "user", address: "0x00000000000000000000000000000000000000a3" }],
				["hedger#1", { kind: "hedger", address: "0x00000000000000000000000000000000000000b1" }],
				["hedger#2", { kind: "hedger", address: "0x00000000000000000000000000000000000000b2" }],
			]
			const subscriptions = actorRoutes.map(([name, actor]) =>
				manager.getQueueObservable(QuoteStatus.PENDING, actor).subscribe(quoteId => {
					manager.enqueueAction({
						title: `Observe:${name}:${quoteId}`,
						action: async () => void recipients.push(name),
					})
				}),
			)

			await manager.dispatchQuoteState(17n)
			await manager.waitForIdle(1_000)

			expect(recipients).to.deep.equal(["user#2", "hedger#2"])
			expect(quoteReads).to.equal(1)
			expect(manager.getSummary()).to.include({ accepted: 2, completed: 2 })
			expect(events[0]).to.deep.equal({
				type: "state",
				actionSequence: undefined,
				quoteId: 17n,
				quoteStatus: "PENDING",
				quote: {
					positionType: "SHORT",
					orderType: "MARKET",
					quantity: 100n,
					closedAmount: 25n,
					quantityToClose: 10n,
					parentId: 3n,
				},
			})

			for (const subscription of subscriptions) subscription.unsubscribe()
			await manager.stopAndDrain(1_000)
		})
	})
}
