import { expect } from "chai"
import { EventEmitter } from "node:events"
import { firstValueFrom } from "rxjs"

import { Action, assertActionMapsComplete, expandActions, hedgerActionsMap, userActionsMap } from "./models/Actions.js"
import { OrderType, PositionType, QuoteStatus } from "./models/Enums.js"
import { EventListener } from "./models/EventListener.js"
import {
	calculatePartyALockedValueAfterOpen,
	isHedgerEligibleForQuote,
	isValidFuzzPartialOpen,
	quoteStateIdsAfterOpen,
	selectFuzzOpenedPrice,
} from "./models/HedgerController.js"
import { shouldRouteQuoteState } from "./models/QuoteStateRouting.js"
import { RunContext } from "./models/RunContext.js"
import { QuoteCheckpoint } from "./models/quoteCheckpoint.js"
import { calculateCloseFee, calculateReleasedLockedValues, shouldKeepPartyBConnection } from "./models/validators/FillCloseRequestValidator.js"
import { getTradingFeeForQuoteWithFilledAmount } from "./utils/Common.js"
import { FuzzStopController, installFuzzSignalHandlers, runFuzzRootLoop } from "./utils/FuzzRunControl.js"
import { expectToBeApproximately, roundToPrecision } from "./utils/SafeMath.js"

const SEND_QUOTE_EVENT =
	"SendQuote(address,uint256,address[],uint256,uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)"

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>(done => {
		resolve = done
	})
	return { promise, resolve }
}

class FakeEventContract {
	readonly runner: { pollingInterval?: number } = {}
	readonly listeners = new Map<string, (...args: any[]) => void>()
	readonly removed: string[] = []

	async on(event: string, listener: (...args: any[]) => void): Promise<void> {
		this.listeners.set(event, listener)
	}

	async off(event: string, listener: (...args: any[]) => void): Promise<void> {
		if (this.listeners.get(event) === listener) this.listeners.delete(event)
		this.removed.push(event)
	}

	emit(event: string, value: Record<string, unknown>): void {
		const listener = this.listeners.get(event)
		if (!listener) throw new Error(`No fake listener registered for ${event}`)
		listener({ args: value })
	}
}

export function shouldBehaveLikeFuzzHarness(): void {
	describe("run lifecycle", function () {
		it("keeps continuous mode alive until stop and finishes the active root", async function () {
			const stop = new FuzzStopController()
			const started = deferred()
			const release = deferred()
			const roots: number[] = []
			let settled = false
			const run = runFuzzRootLoop({ mode: "continuous", rootActions: 1, stop }, async index => {
				roots.push(index)
				started.resolve()
				await release.promise
			}).then(count => {
				settled = true
				return count
			})

			await started.promise
			expect(settled).to.equal(false)
			expect(stop.request("SIGINT")).to.equal(true)
			release.resolve()

			expect(await run).to.equal(1)
			expect(roots).to.deep.equal([1])
			expect(stop.signal).to.equal("SIGINT")
		})

		it("runs exactly the configured number of bounded roots", async function () {
			const roots: number[] = []
			const count = await runFuzzRootLoop({ mode: "bounded", rootActions: 3, stop: new FuzzStopController() }, async index => void roots.push(index))
			expect(count).to.equal(3)
			expect(roots).to.deep.equal([1, 2, 3])
		})

		it("does not count a root rejected by a racing stop request", async function () {
			const stop = new FuzzStopController()
			const roots: number[] = []
			const count = await runFuzzRootLoop({ mode: "continuous", rootActions: 1, stop }, async index => {
				roots.push(index)
				stop.request("SIGINT")
				return false
			})

			expect(count).to.equal(0)
			expect(roots).to.deep.equal([1])
		})

		it("turns the first process signal into one graceful stop request", function () {
			const target = new EventEmitter()
			const stop = new FuzzStopController()
			const observed: string[] = []
			const dispose = installFuzzSignalHandlers(target, stop, signal => observed.push(signal))

			target.emit("SIGINT")
			target.emit("SIGTERM")
			dispose()
			dispose()

			expect(stop.signal).to.equal("SIGINT")
			expect(observed).to.deep.equal(["SIGINT"])
			expect(target.listenerCount("SIGINT")).to.equal(0)
			expect(target.listenerCount("SIGTERM")).to.equal(0)
		})
	})

	describe("action policy", function () {
		it("defines user and hedger behavior for every quote status", function () {
			expect(assertActionMapsComplete).not.to.throw()
			const statuses = Object.values(QuoteStatus).filter((status): status is QuoteStatus => typeof status === "number")
			expect([...userActionsMap.keys()]).to.have.members(statuses)
			expect([...hedgerActionsMap.keys()]).to.have.members(statuses)
		})

		it("lets opened positions remain live between world ticks without selecting the obsolete one-step force close", function () {
			const openedActions = expandActions(userActionsMap.get(QuoteStatus.OPENED)!)
			const closePendingActions = expandActions(userActionsMap.get(QuoteStatus.CLOSE_PENDING)!)

			expect(openedActions).to.have.length(10)
			expect(openedActions.filter(({ action }) => action === Action.CLOSE_REQUEST)).to.have.length(7)
			expect(openedActions.filter(({ action }) => action === Action.NOTHING)).to.have.length(3)
			expect(openedActions.filter(({ action }) => action === Action.NOTHING).every(({ rethink }) => !rethink)).to.equal(true)
			expect(closePendingActions).to.have.length(4)
			expect(closePendingActions.filter(({ action }) => action === Action.CANCEL_CLOSE_REQUEST)).to.have.length(1)
			expect(closePendingActions.some(({ action }) => action === Action.FORCE_CLOSE_REQUEST)).to.equal(false)
		})
	})

	describe("fixed-point generation", function () {
		it("rounds 18-decimal values without converting decimal strings to bigint", function () {
			expect(roundToPrecision(98_123_000_000_000_000_000n, 1)).to.equal(98_200_000_000_000_000_000n)
			expect(roundToPrecision(98_100_000_000_000_000_000n, 1)).to.equal(98_100_000_000_000_000_000n)
			expect(roundToPrecision(-98_123_000_000_000_000_000n, 1)).to.equal(-98_100_000_000_000_000_000n)
			expect(() => roundToPrecision(1n, 19)).to.throw(RangeError, "between 0 and 18")
		})

		it("checks approximate equality symmetrically", function () {
			expect(() => expectToBeApproximately(100n, 90n)).not.to.throw()
			expect(() => expectToBeApproximately(90n, 100n)).not.to.throw()
			expect(() => expectToBeApproximately(101n, 90n)).to.throw()
			expect(() => expectToBeApproximately(90n, 101n)).to.throw()
		})
	})

	describe("open generation", function () {
		it("uses a valid fallback price when market-price scaling would make a quote too small", function () {
			const lockedValues = {
				cva: 689_444_527_077_548_486n,
				lf: 1_458_707_732_772_357_067n,
				partyAmm: 3_219_091_393_073_216_086n,
			}
			const requestedOpenPrice = 114_000_000_000_000_000_000n
			const marketPrice = 104_026_318_382_471_578_134n
			const minimumQuoteValue = 5_000_000_000_000_000_000n

			expect(calculatePartyALockedValueAfterOpen(lockedValues, marketPrice, requestedOpenPrice)).to.be.lessThan(minimumQuoteValue)
			expect(
				selectFuzzOpenedPrice(BigInt(OrderType.MARKET), BigInt(PositionType.LONG), lockedValues, requestedOpenPrice, marketPrice, minimumQuoteValue),
			).to.equal(requestedOpenPrice)
		})

		it("keeps the preferred market price when the adjusted quote remains large enough", function () {
			const lockedValues = { cva: 2_000n, lf: 2_000n, partyAmm: 6_000n }
			expect(selectFuzzOpenedPrice(BigInt(OrderType.MARKET), BigInt(PositionType.LONG), lockedValues, 110n, 100n, 5_000n)).to.equal(100n)
			expect(selectFuzzOpenedPrice(BigInt(OrderType.LIMIT), BigInt(PositionType.SHORT), lockedValues, 110n, 100n, 20_000n)).to.equal(110n)
		})

		it("falls back to the requested price when a market price crosses the position limit", function () {
			const lockedValues = { cva: 2_000n, lf: 2_000n, partyAmm: 6_000n }
			expect(selectFuzzOpenedPrice(BigInt(OrderType.MARKET), BigInt(PositionType.LONG), lockedValues, 100n, 101n, 5_000n)).to.equal(100n)
			expect(selectFuzzOpenedPrice(BigInt(OrderType.MARKET), BigInt(PositionType.SHORT), lockedValues, 100n, 99n, 5_000n)).to.equal(100n)
			expect(selectFuzzOpenedPrice(BigInt(OrderType.MARKET), BigInt(PositionType.SHORT), lockedValues, 100n, 101n, 5_000n)).to.equal(101n)
		})

		it("checks partial-open minimums with the same component-wise rounding as Solidity", function () {
			expect(isValidFuzzPartialOpen({ cva: 1n, lf: 1n, partyAmm: 8n }, 5n, 10n, 1n, 1n, 5n, false)).to.equal(false)
			expect(isValidFuzzPartialOpen({ cva: 2n, lf: 2n, partyAmm: 6n }, 5n, 10n, 1n, 1n, 5n, false)).to.equal(true)
			expect(isValidFuzzPartialOpen({ cva: 2n, lf: 2n, partyAmm: 6n }, 9n, 10n, 1n, 1n, 5n, false)).to.equal(false)
			expect(isValidFuzzPartialOpen({ cva: 2n, lf: 2n, partyAmm: 6n }, 9n, 10n, 1n, 1n, 5n, true)).to.equal(true)
		})

		it("continues direct-event modeling for a partial-open remainder", function () {
			expect(quoteStateIdsAfterOpen(17n)).to.deep.equal([17n])
			expect(quoteStateIdsAfterOpen(17n, 18n)).to.deep.equal([17n, 18n])
		})
	})

	describe("close accounting", function () {
		it("releases each lock field against the remaining open amount", function () {
			const released = calculateReleasedLockedValues(
				{
					cva: 7n,
					lf: 11n,
					partyAmm: 13n,
					partyBmm: 17n,
				},
				20n,
				60n,
			)

			expect(released).to.deep.equal({
				cva: 2n,
				lf: 3n,
				partyAmm: 4n,
				partyBmm: 5n,
				partyA: 9n,
				partyB: 10n,
			})
		})

		it("charges close fees from the fill amount and executed close price", function () {
			expect(calculateCloseFee(2n * 10n ** 18n, 15n * 10n ** 18n, 5n * 10n ** 15n)).to.equal(15n * 10n ** 16n)
		})

		it("keeps a PartyB connection while a partial-open remainder is pending", function () {
			expect(shouldKeepPartyBConnection(0n, 1n)).to.equal(true)
			expect(shouldKeepPartyBConnection(1n, 0n)).to.equal(true)
			expect(shouldKeepPartyBConnection(0n, 0n)).to.equal(false)
		})
	})

	describe("fee snapshots", function () {
		it("validates partial fills with the trading fee stored on the quote", async function () {
			const context = {
				viewFacetQuote: {
					getQuote: async () => ({
						orderType: BigInt(OrderType.LIMIT),
						tradingFee: 10n ** 16n,
						requestedOpenPrice: 10n * 10n ** 18n,
						marketPrice: 9n * 10n ** 18n,
					}),
				},
				viewFacetSymbol: {
					getSymbol: async () => {
						throw new Error("symbol fee should not be read for an existing quote")
					},
				},
			} as unknown as RunContext

			expect(await getTradingFeeForQuoteWithFilledAmount(context, 1n, 2n * 10n ** 18n)).to.equal(2n * 10n ** 17n)
		})
	})

	describe("event routing", function () {
		it("routes an unassigned allowlisted quote only to its selected hedger", function () {
			const hedger1 = "0x0000000000000000000000000000000000000001"
			const hedger2 = "0x0000000000000000000000000000000000000002"
			const unassigned = {
				partyB: "0x0000000000000000000000000000000000000000",
				partyBsWhiteList: [hedger2.toUpperCase()],
			}
			const assigned = { ...unassigned, partyB: hedger2 }

			expect(isHedgerEligibleForQuote(unassigned as any, hedger1)).to.equal(false)
			expect(isHedgerEligibleForQuote(unassigned as any, hedger2)).to.equal(true)
			expect(isHedgerEligibleForQuote(assigned as any, hedger1)).to.equal(false)
			expect(isHedgerEligibleForQuote(assigned as any, hedger2)).to.equal(true)
		})

		it("targets owners and eligible hedgers case-insensitively", function () {
			const user = "0x00000000000000000000000000000000000000a1"
			const hedger1 = "0x00000000000000000000000000000000000000b1"
			const hedger2 = "0x00000000000000000000000000000000000000b2"
			const envelope = {
				quoteId: 17n,
				route: {
					partyA: user.toUpperCase(),
					partyB: "0x0000000000000000000000000000000000000000",
					partyBsWhiteList: [hedger2.toUpperCase()],
				},
			}

			expect(shouldRouteQuoteState(envelope, { kind: "user", address: user })).to.equal(true)
			expect(shouldRouteQuoteState(envelope, { kind: "user", address: hedger1 })).to.equal(false)
			expect(shouldRouteQuoteState(envelope, { kind: "hedger", address: hedger1 })).to.equal(false)
			expect(shouldRouteQuoteState(envelope, { kind: "hedger", address: hedger2 })).to.equal(true)
		})

		it("routes an empty whitelist to all hedgers and an assigned quote only to Party B", function () {
			const hedger1 = "0x00000000000000000000000000000000000000b1"
			const hedger2 = "0x00000000000000000000000000000000000000b2"
			const unassigned = {
				quoteId: 17n,
				route: {
					partyA: "0x00000000000000000000000000000000000000a1",
					partyB: "0x0000000000000000000000000000000000000000",
					partyBsWhiteList: [],
				},
			}
			const assigned = { ...unassigned, route: { ...unassigned.route, partyB: hedger2, partyBsWhiteList: [hedger1] } }

			expect(shouldRouteQuoteState(unassigned, { kind: "hedger", address: hedger1 })).to.equal(true)
			expect(shouldRouteQuoteState(unassigned, { kind: "hedger", address: hedger2 })).to.equal(true)
			expect(shouldRouteQuoteState(assigned, { kind: "hedger", address: hedger1 })).to.equal(false)
			expect(shouldRouteQuoteState(assigned, { kind: "hedger", address: hedger2 })).to.equal(true)
		})

		it("keeps provider events broad when routing metadata is unavailable", function () {
			const providerEnvelope = { quoteId: 17n }

			expect(shouldRouteQuoteState(providerEnvelope, { kind: "user", address: "0xuser" })).to.equal(true)
			expect(shouldRouteQuoteState(providerEnvelope, { kind: "hedger", address: "0xhedger" })).to.equal(true)
		})

		it("releases blocked-quote bookkeeping at terminal states", function () {
			const checkpoint = QuoteCheckpoint.getInstance()
			checkpoint.reset()
			checkpoint.addBlockedQuotes(17n)
			checkpoint.observeQuoteStatus(17n, QuoteStatus.OPENED)
			expect(checkpoint.isBlockedQuote(17n)).to.equal(true)
			checkpoint.observeQuoteStatus(17n, QuoteStatus.CLOSED)
			expect(checkpoint.isBlockedQuote(17n)).to.equal(false)
			checkpoint.addBlockedQuotes(18n)
			checkpoint.observeQuoteStatus(18n, QuoteStatus.LIQUIDATED_PENDING)
			expect(checkpoint.isBlockedQuote(18n)).to.equal(false)
		})

		it("routes split-facet and overloaded events into current quote-status queues", async function () {
			const partyA = new FakeEventContract()
			const partyBQuote = new FakeEventContract()
			const partyBPosition = new FakeEventContract()
			const context = {
				partyAFacet: partyA,
				partyBQuoteActionsFacet: partyBQuote,
				partyBPositionActionsFacet: partyBPosition,
			} as unknown as RunContext
			const listener = new EventListener(context)

			await listener.start()
			expect([...listener.queues.keys()]).to.include(QuoteStatus.LIQUIDATED_PENDING)
			expect(partyA.listeners.has(SEND_QUOTE_EVENT)).to.equal(true)
			expect(partyBQuote.listeners.has("LockQuote")).to.equal(true)
			expect(partyBPosition.listeners.has("OpenPosition(uint256,address,address,uint256,uint256)")).to.equal(true)

			const pending = firstValueFrom(listener.getQueue(QuoteStatus.PENDING))
			partyA.emit(SEND_QUOTE_EVENT, { quoteId: 17n })
			expect(await pending).to.deep.equal({ quoteId: 17n })

			const opened = firstValueFrom(listener.getQueue(QuoteStatus.OPENED))
			partyBPosition.emit("OpenPosition(uint256,address,address,uint256,uint256)", { quoteId: 17n })
			expect(await opened).to.deep.equal({ quoteId: 17n })

			await listener.stop()
			expect(partyA.listeners.size).to.equal(0)
			expect(partyBQuote.listeners.size).to.equal(0)
			expect(partyBPosition.listeners.size).to.equal(0)
		})
	})
}
