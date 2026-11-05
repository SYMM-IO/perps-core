import { expect } from "chai"

import type { QuoteStructOutput } from "../src/types/interfaces/ISymmio.js"
import { Action, ActionWrapper, assertFuzzActionCoverage } from "./models/Actions.js"
import { QuoteStatus } from "./models/Enums.js"
import type { Hedger } from "./models/Hedger.js"
import { HedgerController } from "./models/HedgerController.js"
import type { RunContext } from "./models/RunContext.js"
import { TestManager } from "./models/TestManager.js"
import type { User } from "./models/User.js"
import { executeValidatedSendQuote, expectedCancelTargetStatus, UserController } from "./models/UserController.js"
import type { QuoteCheckpoint } from "./models/quoteCheckpoint.js"
import { CancelQuoteValidator } from "./models/validators/CancelQuoteValidator.js"
import { LockQuoteValidator } from "./models/validators/LockQuoteValidator.js"
import type { SendQuoteValidator } from "./models/validators/SendQuoteValidator.js"
import type { TransactionValidator } from "./models/validators/TransactionValidator.js"
import { expectedUnlockQuoteStatus } from "./models/validators/UnlockQuoteValidator.js"

type PrivateQuoteHandler = {
	handleQuote(quote: QuoteStructOutput, actions: ActionWrapper[]): Promise<void>
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise
		throw new Error("Expected promise to reject")
	} catch (error) {
		return error
	}
}

export function shouldBehaveLikeFuzzValidatorWiring(): void {
	describe("root send-quote validation", function () {
		it("runs the sampled validator around the transaction before publishing downstream state", async function () {
			const order: string[] = []
			const user = {} as User
			const context = {} as RunContext
			const validator = {
				before: async (_context: RunContext, arg: { user: User }) => {
					expect(arg.user).to.equal(user)
					order.push("before")
					return { snapshot: true }
				},
				after: async (_context: RunContext, arg: { user: User; quoteId: bigint; beforeOutput: { snapshot: boolean } }) => {
					expect(arg).to.deep.include({ user, quoteId: 17n })
					expect(arg.beforeOutput).to.deep.equal({ snapshot: true })
					order.push("after")
				},
			} as unknown as SendQuoteValidator
			const manager = {
				setPauseState: (paused: boolean) => order.push(paused ? "pause" : "resume"),
			} as Pick<TestManager, "setPauseState">

			const quoteId = await executeValidatedSendQuote({
				context,
				manager,
				user,
				validator,
				validationProbability: 1,
				sendQuote: async () => {
					order.push("transaction")
					return 17n
				},
				onValidated: async (id, validated) => {
					expect(id).to.equal(17n)
					expect(validated).to.equal(true)
					order.push("dispatch")
				},
			})

			expect(quoteId).to.equal(17n)
			expect(order).to.deep.equal(["pause", "before", "transaction", "after", "resume", "dispatch"])
		})

		it("obeys a zero validation probability without skipping the transaction or state publication", async function () {
			const order: string[] = []
			const validator = {
				before: async () => void order.push("before"),
				after: async () => void order.push("after"),
			} as unknown as SendQuoteValidator

			await executeValidatedSendQuote({
				context: {} as RunContext,
				manager: { setPauseState: () => void order.push("pause") } as Pick<TestManager, "setPauseState">,
				user: {} as User,
				validator,
				validationProbability: 0,
				sendQuote: async () => {
					order.push("transaction")
					return 18n
				},
				onValidated: async (_quoteId, validated) => {
					expect(validated).to.equal(false)
					order.push("dispatch")
				},
			})

			expect(order).to.deep.equal(["transaction", "dispatch"])
		})
	})

	describe("action coverage", function () {
		it("fails startup coverage and runtime lookup when a reachable action loses its validator", async function () {
			const manager = new TestManager({} as RunContext, true, "direct")
			const incomplete = new Map(manager.validators)
			incomplete.delete(Action.LOCK_QUOTE)

			expect(() => assertFuzzActionCoverage(incomplete)).to.throw("Missing validator for reachable hedger fuzz action LOCK_QUOTE")
			manager.validators.delete(Action.LOCK_QUOTE)
			expect(() => manager.getValidator("hedger", Action.LOCK_QUOTE)).to.throw("Missing validator for hedger fuzz action LOCK_QUOTE")
			expect(() => manager.getValidator("user", Action.LOCK_QUOTE)).to.throw("Missing user handler for fuzz action LOCK_QUOTE")

			await manager.stopAndDrain(1_000)
		})
	})

	describe("transition wiring", function () {
		it("derives cancellation outcomes from the timestamp of the transaction block", function () {
			expect(expectedCancelTargetStatus(BigInt(QuoteStatus.PENDING), 100n, 100n)).to.equal(QuoteStatus.CANCELED)
			expect(expectedCancelTargetStatus(BigInt(QuoteStatus.PENDING), 100n, 101n)).to.equal(QuoteStatus.EXPIRED)
			expect(expectedCancelTargetStatus(BigInt(QuoteStatus.LOCKED), 100n, 100n)).to.equal(undefined)
			expect(expectedCancelTargetStatus(BigInt(QuoteStatus.LOCKED), 100n, 101n)).to.equal(QuoteStatus.EXPIRED)
		})

		it("derives unlock outcomes from the transaction block rather than the resulting quote", function () {
			expect(expectedUnlockQuoteStatus(100n, 100n)).to.equal(QuoteStatus.PENDING)
			expect(expectedUnlockQuoteStatus(100n, 101n)).to.equal(QuoteStatus.EXPIRED)
		})

		it("passes the acting hedger and quote id into the lock validator snapshot", async function () {
			const user = {} as User
			const hedger = {
				lockQuote: async (quoteId: bigint) => expect(quoteId).to.equal(17n),
			} as unknown as Hedger
			let beforeArg: Record<string, unknown> | undefined
			const validator = {
				before: async (_context: RunContext, arg: Record<string, unknown>) => {
					beforeArg = arg
					return {}
				},
				after: async () => undefined,
			} as TransactionValidator
			const manager = {
				context: {} as RunContext,
				getValidator: (route: string, action: Action) => {
					expect({ route, action }).to.deep.equal({ route: "hedger", action: Action.LOCK_QUOTE })
					return validator
				},
				recordDecision: () => undefined,
				setPauseState: () => undefined,
				getUser: () => user,
				dispatchQuoteState: async () => undefined,
			} as unknown as TestManager
			const controller = new HedgerController(manager, hedger, {} as QuoteCheckpoint, "hedger#1", {
				validationProbability: 1,
				blockedQuoteProbability: 0,
				rethinkDelayMs: 0,
			})
			const quote = {
				id: 17n,
				quoteStatus: BigInt(QuoteStatus.PENDING),
				partyA: "0x00000000000000000000000000000000000000a1",
			} as QuoteStructOutput

			await (controller as unknown as PrivateQuoteHandler).handleQuote(quote, [new ActionWrapper(Action.LOCK_QUOTE)])

			expect(beforeArg).to.deep.equal({ user, hedger, quoteId: 17n })
		})

		it("passes the acting hedger and transaction timestamp through unlock validation", async function () {
			const user = {} as User
			const hedger = {
				unlockQuote: async (quoteId: bigint) => expect(quoteId).to.equal(19n),
			} as unknown as Hedger
			let beforeArg: Record<string, unknown> | undefined
			let afterArg: Record<string, unknown> | undefined
			const validator = {
				before: async (_context: RunContext, arg: Record<string, unknown>) => {
					beforeArg = arg
					return {}
				},
				after: async (_context: RunContext, arg: Record<string, unknown>) => {
					afterArg = arg
				},
			} as TransactionValidator
			const manager = {
				context: {} as RunContext,
				getValidator: (route: string, action: Action) => {
					expect({ route, action }).to.deep.equal({ route: "hedger", action: Action.UNLOCK_QUOTE })
					return validator
				},
				recordDecision: () => undefined,
				setPauseState: () => undefined,
				getUser: () => user,
				dispatchQuoteState: async () => undefined,
			} as unknown as TestManager
			const controller = new HedgerController(manager, hedger, {} as QuoteCheckpoint, "hedger#1", {
				validationProbability: 1,
				blockedQuoteProbability: 0,
				rethinkDelayMs: 0,
			})
			const quote = {
				id: 19n,
				quoteStatus: BigInt(QuoteStatus.LOCKED),
				partyA: "0x00000000000000000000000000000000000000a1",
			} as QuoteStructOutput

			await (controller as unknown as PrivateQuoteHandler).handleQuote(quote, [new ActionWrapper(Action.UNLOCK_QUOTE)])

			expect(beforeArg).to.deep.equal({ user, hedger, quoteId: 19n })
			expect(afterArg).to.deep.include({ user, hedger, quoteId: 19n, beforeOutput: {} })
			expect(afterArg?.transactionBlockTimestamp).to.be.a("bigint")
		})

		it("declares CANCELED as the exact target of a pending fuzz cancellation", async function () {
			const user = {
				requestToCancelQuote: async (quoteId: bigint) => expect(quoteId).to.equal(23n),
			} as unknown as User
			let afterArg: Record<string, unknown> | undefined
			const validator = {
				before: async () => ({}),
				after: async (_context: RunContext, arg: Record<string, unknown>) => {
					afterArg = arg
				},
			} as TransactionValidator
			const manager = {
				context: {} as RunContext,
				getValidator: () => validator,
				recordDecision: () => undefined,
				setPauseState: () => undefined,
				dispatchQuoteState: async () => undefined,
			} as unknown as TestManager
			const controller = new UserController(manager, user, {} as QuoteCheckpoint, "user#1", {
				validationProbability: 1,
				blockedQuoteProbability: 0,
				rethinkDelayMs: 0,
			})
			const quote = {
				id: 23n,
				quoteStatus: BigInt(QuoteStatus.PENDING),
				deadline: 1n << 255n,
			} as QuoteStructOutput

			await (controller as unknown as PrivateQuoteHandler).handleQuote(quote, [new ActionWrapper(Action.CANCEL_REQUEST)])

			expect(afterArg).to.deep.include({ user, quoteId: 23n, targetStatus: QuoteStatus.CANCELED })
		})
	})

	describe("validator guards", function () {
		it("captures all Party B lock collections and position counts before locking", async function () {
			const user = {
				getAddress: async () => "0x00000000000000000000000000000000000000a1",
				getBalanceInfo: async () => ({ allocatedBalances: 100n }),
			} as unknown as User
			const hedger = {
				getAddress: async () => "0x00000000000000000000000000000000000000b1",
			} as Hedger
			const context = {
				viewFacetQuote: {
					getPartyBPendingQuotes: async () => [8n, 9n],
					partyAPositionsCount: async () => 3n,
					partyBPositionsCount: async () => 2n,
				},
			} as unknown as RunContext

			const snapshot = await new LockQuoteValidator().before(context, { user, hedger, quoteId: 17n })

			expect(snapshot.partyBPendingQuotes).to.deep.equal([8n, 9n])
			expect(snapshot.positionsCount).to.equal(3n)
			expect(snapshot.partyBPositionsCount).to.equal(2n)
		})

		it("rejects a pending cancel check that omits the expected terminal target", async function () {
			const balance = { allocatedBalances: 100n } as any
			const user = {
				getAddress: async () => "0x00000000000000000000000000000000000000a1",
				getBalanceInfo: async () => balance,
			} as unknown as User
			const context = {
				viewFacetQuote: {
					getQuote: async () => ({ quoteStatus: BigInt(QuoteStatus.CANCELED) }),
				},
			} as unknown as RunContext
			const validator = new CancelQuoteValidator()

			const error = await rejectionOf(
				validator.after(context, {
					user,
					quoteId: 17n,
					beforeOutput: {
						balanceInfoPartyA: balance,
						quote: { quoteStatus: BigInt(QuoteStatus.PENDING) } as QuoteStructOutput,
						pendingQuotes: [17n],
						positionsCount: 0n,
					},
				}),
			)

			expect(error).to.be.instanceOf(Error)
			expect((error as Error).message).to.equal("CancelQuoteValidator requires the expected CANCELED or EXPIRED target for a pending quote")
		})
	})
}
