import { expect } from "chai"

import { OrderType, PositionType, QuoteStatus } from "../models/Enums.js"
import type { Hedger } from "../models/Hedger.js"
import type { RunContext } from "../models/RunContext.js"
import type { BalanceInfo, User } from "../models/User.js"
import { FillCloseRequestValidator } from "../models/validators/FillCloseRequestValidator.js"
import { getAllOpenPositions } from "../models/validators/OpenPositionPagination.js"
import { OpenPositionValidator } from "../models/validators/OpenPositionValidator.js"

const USER_ADDRESS = "0x0000000000000000000000000000000000000001"
const HEDGER_ADDRESS = "0x0000000000000000000000000000000000000002"
const FEE_COLLECTOR_ADDRESS = "0x0000000000000000000000000000000000000003"
const AFFILIATE_ADDRESS = "0x0000000000000000000000000000000000000004"

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>(done => {
		resolve = done
	})
	return { promise, resolve }
}

function gatedRead<T>(started: string[], gate: Promise<void>, name: string, value: T): (...args: any[]) => Promise<T> {
	return async () => {
		started.push(name)
		await gate
		return value
	}
}

async function flushStartedReads(): Promise<void> {
	await new Promise<void>(resolve => setImmediate(resolve))
}

function balanceInfo(overrides: Partial<BalanceInfo> = {}): BalanceInfo {
	return {
		allocatedBalances: 0n,
		lockedCva: 0n,
		lockedMmPartyA: 0n,
		lockedMmPartyB: 0n,
		lockedLf: 0n,
		totalLockedPartyA: 0n,
		totalLockedPartyB: 0n,
		pendingLockedCva: 0n,
		pendingLockedMmPartyA: 0n,
		pendingLockedMmPartyB: 0n,
		pendingLockedLf: 0n,
		totalPendingLockedPartyA: 0n,
		totalPendingLockedPartyB: 0n,
		...overrides,
	}
}

function openQuote(status: QuoteStatus) {
	return {
		id: 1n,
		affiliate: AFFILIATE_ADDRESS,
		quoteStatus: BigInt(status),
		orderType: BigInt(OrderType.LIMIT),
		positionType: BigInt(PositionType.LONG),
		quantity: 10n,
		closedAmount: 0n,
		quantityToClose: 0n,
		requestedOpenPrice: 100n,
		openedPrice: 100n,
		marketPrice: 100n,
		tradingFee: 0n,
		closeFee: 0n,
		accumulatedPaidFunding: 0n,
		lockedValues: {
			cva: 2n,
			lf: 3n,
			partyAmm: 5n,
			partyBmm: 7n,
		},
	}
}

type PageCall = [start: number, size: number]

function quotePage(total: number, calls: PageCall[], rawStart: number, rawSize: number, firstId = 1) {
	const start = Number(rawStart)
	const size = Number(rawSize)
	const length = Math.max(0, Math.min(size, total - start))
	calls.push([start, size])
	return Array.from({ length }, (_, index) => ({ id: BigInt(firstId + start + index) }))
}

describe("Open-position snapshot pagination", function () {
	it("loads positions beyond the old 1,000-row ceiling", async function () {
		const calls: PageCall[] = []

		const positions = await getAllOpenPositions((start, size) => Promise.resolve(quotePage(1_001, calls, start, size)))

		expect(positions).to.have.length(1_001)
		expect(positions.at(-1)?.id).to.equal(1_001n)
		expect(calls).to.deep.equal([
			[0, 1_000],
			[1_000, 1_000],
		])
	})

	it("terminates an exact page-size multiple with one final empty page", async function () {
		const calls: PageCall[] = []

		const positions = await getAllOpenPositions((start, size) => Promise.resolve(quotePage(2_000, calls, start, size)))

		expect(positions).to.have.length(2_000)
		expect(calls).to.deep.equal([
			[0, 1_000],
			[1_000, 1_000],
			[2_000, 1_000],
		])
	})

	it("captures complete PartyA and PartyB counts before an open", async function () {
		const partyACalls: PageCall[] = []
		const partyBCalls: PageCall[] = []
		const quote = openQuote(QuoteStatus.LOCKED)
		const emptyBalance = balanceInfo()
		const user = {
			getAddress: async () => USER_ADDRESS,
			getBalanceInfo: async () => emptyBalance,
		} as unknown as User
		const hedger = {
			getAddress: async () => HEDGER_ADDRESS,
			getBalanceInfo: async () => emptyBalance,
		} as unknown as Hedger
		const context = {
			viewFacet: {
				getFeeCollector: async () => FEE_COLLECTOR_ADDRESS,
				balanceOf: async () => 0n,
				nonceOfPartyA: async () => 0n,
				nonceOfPartyB: async () => 0n,
			},
			viewFacetQuote: {
				getQuote: async () => quote,
				partyAPositionsCount: async () => 1_001n,
				partyBPositionsCount: async () => 2_000n,
				getPartyAPendingQuotes: async () => [],
				getPartyBPendingQuotes: async () => [],
				getPartyAOpenPositions: async (_partyA: string, start: number, size: number) => quotePage(1_001, partyACalls, start, size),
				getPartyBOpenPositions: async (_partyB: string, _partyA: string, start: number, size: number) => quotePage(2_000, partyBCalls, start, size),
			},
			viewFacetSymbol: {
				getConnectedPartyBs: async () => [HEDGER_ADDRESS],
			},
		} as unknown as RunContext

		const snapshot = await new OpenPositionValidator().before(context, { user, hedger, quoteId: 1n })

		expect(snapshot.partyAOpenPositionCount).to.equal(1_001n)
		expect(snapshot.partyBOpenPositionCount).to.equal(2_000n)
		expect(partyACalls).to.deep.equal([
			[0, 1_000],
			[1_000, 1_000],
		])
		expect(partyBCalls).to.deep.equal([
			[0, 1_000],
			[1_000, 1_000],
			[2_000, 1_000],
		])
	})

	it("captures complete PartyA and PartyB counts before a close fill", async function () {
		const partyACalls: PageCall[] = []
		const partyBCalls: PageCall[] = []
		const quote = openQuote(QuoteStatus.CLOSE_PENDING)
		const emptyBalance = balanceInfo()
		const user = {
			getAddress: async () => USER_ADDRESS,
			getBalanceInfo: async () => emptyBalance,
		} as unknown as User
		const hedger = {
			getAddress: async () => HEDGER_ADDRESS,
			getBalanceInfo: async () => emptyBalance,
			getBalanceInfoCrossPartyB: async () => emptyBalance,
		} as unknown as Hedger
		const context = {
			viewFacet: {
				isCrossPartyB: async () => false,
				nonceOfPartyA: async () => 0n,
				nonceOfPartyB: async () => 0n,
			},
			viewFacetQuote: {
				getQuote: async () => quote,
				partyAPositionsCount: async () => 2_000n,
				partyBPositionsCount: async () => 1_001n,
				getPartyAOpenPositions: async (_partyA: string, start: number, size: number) => quotePage(2_000, partyACalls, start, size),
				getPartyBOpenPositions: async (_partyB: string, _partyA: string, start: number, size: number) => quotePage(1_001, partyBCalls, start, size),
				getPartyBPendingQuotes: async () => [],
			},
			viewFacetSymbol: {
				getConnectedPartyBs: async () => [HEDGER_ADDRESS],
			},
		} as unknown as RunContext

		const snapshot = await new FillCloseRequestValidator().before(context, { user, hedger, quoteId: 1n })

		expect(snapshot.partyAOpenPositionCount).to.equal(2_000n)
		expect(snapshot.partyBOpenPositionCount).to.equal(1_001n)
		expect(partyACalls).to.deep.equal([
			[0, 1_000],
			[1_000, 1_000],
			[2_000, 1_000],
		])
		expect(partyBCalls).to.deep.equal([
			[0, 1_000],
			[1_000, 1_000],
		])
	})
})

describe("Validator snapshot scheduling", function () {
	it("starts independent open-position before reads together", async function () {
		const gate = deferred()
		const started: string[] = []
		const read = <T>(name: string, value: T) => gatedRead(started, gate.promise, name, value)
		const quote = openQuote(QuoteStatus.LOCKED)
		const emptyBalance = balanceInfo()
		const user = {
			getAddress: async () => USER_ADDRESS,
			getBalanceInfo: read("user balance", emptyBalance),
		} as unknown as User
		const hedger = {
			getAddress: async () => HEDGER_ADDRESS,
			getBalanceInfo: read("hedger balance", emptyBalance),
		} as unknown as Hedger
		const context = {
			viewFacet: {
				getFeeCollector: async () => FEE_COLLECTOR_ADDRESS,
				balanceOf: async () => 0n,
				nonceOfPartyA: read("partyA nonce", 0n),
				nonceOfPartyB: read("partyB nonce", 0n),
			},
			viewFacetQuote: {
				getQuote: read("quote", quote),
				partyAPositionsCount: read("partyA count", 0n),
				partyBPositionsCount: read("partyB count", 0n),
				getPartyAPendingQuotes: read("partyA pending", []),
				getPartyBPendingQuotes: read("partyB pending", []),
				getPartyAOpenPositions: read("partyA positions", []),
				getPartyBOpenPositions: read("partyB positions", []),
			},
			viewFacetSymbol: {
				getConnectedPartyBs: read("connections", []),
			},
		} as unknown as RunContext

		const snapshotPromise = new OpenPositionValidator().before(context, { user, hedger, quoteId: 1n })
		await flushStartedReads()

		expect(started).to.have.members([
			"user balance",
			"hedger balance",
			"quote",
			"partyA count",
			"partyB count",
			"partyA pending",
			"partyB pending",
			"partyA positions",
			"partyB positions",
			"connections",
			"partyA nonce",
			"partyB nonce",
		])

		gate.resolve()
		const snapshot = await snapshotPromise
		expect(snapshot.quote).to.equal(quote)
	})

	it("starts independent fill-close before reads while the account mode is pending", async function () {
		const gate = deferred()
		const started: string[] = []
		const read = <T>(name: string, value: T) => gatedRead(started, gate.promise, name, value)
		const quote = openQuote(QuoteStatus.CLOSE_PENDING)
		const emptyBalance = balanceInfo()
		const user = {
			getAddress: async () => USER_ADDRESS,
			getBalanceInfo: read("user balance", emptyBalance),
		} as unknown as User
		const hedger = {
			getAddress: async () => HEDGER_ADDRESS,
			getBalanceInfo: read("hedger balance", emptyBalance),
			getBalanceInfoCrossPartyB: read("cross hedger balance", emptyBalance),
		} as unknown as Hedger
		const context = {
			viewFacet: {
				isCrossPartyB: read("account mode", false),
				nonceOfPartyA: read("partyA nonce", 0n),
				nonceOfPartyB: read("partyB nonce", 0n),
			},
			viewFacetQuote: {
				getQuote: read("quote", quote),
				partyAPositionsCount: read("partyA count", 1n),
				partyBPositionsCount: read("partyB count", 1n),
				getPartyAOpenPositions: read("partyA positions", [quote]),
				getPartyBOpenPositions: read("partyB positions", [quote]),
				getPartyBPendingQuotes: read("partyB pending", []),
			},
			viewFacetSymbol: {
				getConnectedPartyBs: read("connections", [HEDGER_ADDRESS]),
			},
		} as unknown as RunContext

		const snapshotPromise = new FillCloseRequestValidator().before(context, { user, hedger, quoteId: 1n })
		await flushStartedReads()

		expect(started).to.include.members([
			"account mode",
			"user balance",
			"quote",
			"partyA count",
			"partyB count",
			"partyA positions",
			"partyB positions",
			"partyB pending",
			"connections",
			"partyA nonce",
			"partyB nonce",
		])
		expect(started).not.to.include("hedger balance")

		gate.resolve()
		const snapshot = await snapshotPromise
		expect(snapshot.isCrossPartyB).to.equal(false)
		expect(started).to.include("hedger balance")
	})

	it("starts all open-position after-state reads before any one read finishes", async function () {
		const gate = deferred()
		const started: string[] = []
		const read = <T>(name: string, value: T) => gatedRead(started, gate.promise, name, value)
		const oldQuote = openQuote(QuoteStatus.LOCKED)
		const newQuote = openQuote(QuoteStatus.OPENED)
		const oldPartyABalance = balanceInfo({ allocatedBalances: 100n, totalPendingLockedPartyA: 10n })
		const oldPartyBBalance = balanceInfo({ allocatedBalances: 100n, totalPendingLockedPartyB: 12n })
		const newPartyABalance = balanceInfo({ allocatedBalances: 100n, totalLockedPartyA: 10n })
		const newPartyBBalance = balanceInfo({ allocatedBalances: 100n, totalLockedPartyB: 12n })
		let quoteReads = 0
		const user = {
			getAddress: async () => USER_ADDRESS,
			getBalanceInfo: read("user balance", newPartyABalance),
		} as unknown as User
		const hedger = {
			getAddress: async () => HEDGER_ADDRESS,
			getBalanceInfo: read("hedger balance", newPartyBBalance),
		} as unknown as Hedger
		const context = {
			viewFacet: {
				getFeeCollector: async () => FEE_COLLECTOR_ADDRESS,
				balanceOf: read("collector balance", 0n),
				nonceOfPartyA: read("partyA nonce", 1n),
				nonceOfPartyB: read("partyB nonce", 1n),
			},
			viewFacetQuote: {
				getQuote: async () => {
					quoteReads++
					if (quoteReads === 1) return newQuote
					return read("fee quote", newQuote)()
				},
				partyAPositionsCount: read("partyA count", 1n),
				partyBPositionsCount: read("partyB count", 1n),
				getPartyAPendingQuotes: read("partyA pending", []),
				getPartyBPendingQuotes: read("partyB pending", []),
				getPartyAOpenPositions: read("partyA positions", [newQuote]),
				getPartyBOpenPositions: read("partyB positions", [newQuote]),
			},
			viewFacetSymbol: {
				getConnectedPartyBs: read("connections", [HEDGER_ADDRESS]),
			},
		} as unknown as RunContext

		const validationPromise = new OpenPositionValidator().after(context, {
			user,
			hedger,
			quoteId: 1n,
			openedPrice: 100n,
			fillAmount: 10n,
			beforeOutput: {
				balanceInfoPartyA: oldPartyABalance,
				balanceInfoPartyB: oldPartyBBalance,
				quote: oldQuote as any,
				feeCollectorBalance: 0n,
				partyAPositionsCount: 0n,
				partyBPositionsCount: 0n,
				partyAPendingQuotes: [1n],
				partyBPendingQuotes: [1n],
				partyAOpenPositionCount: 0n,
				partyBOpenPositionCount: 0n,
				isConnected: false,
				partyANonce: 0n,
				partyBNonce: 0n,
			},
		})
		await flushStartedReads()

		expect(started).to.have.members([
			"collector balance",
			"fee quote",
			"user balance",
			"hedger balance",
			"partyA count",
			"partyB count",
			"partyA pending",
			"partyB pending",
			"partyA positions",
			"partyB positions",
			"connections",
			"partyA nonce",
			"partyB nonce",
		])

		gate.resolve()
		await validationPromise
	})

	it("starts all full-close after-state reads before any one read finishes", async function () {
		const gate = deferred()
		const started: string[] = []
		const read = <T>(name: string, value: T) => gatedRead(started, gate.promise, name, value)
		const oldQuote = {
			...openQuote(QuoteStatus.CLOSE_PENDING),
			quantityToClose: 10n,
		}
		const newQuote = {
			...openQuote(QuoteStatus.CLOSED),
			closedAmount: 10n,
			lockedValues: { cva: 0n, lf: 0n, partyAmm: 0n, partyBmm: 0n },
		}
		const oldPartyABalance = balanceInfo({ allocatedBalances: 100n, totalLockedPartyA: 10n })
		const oldPartyBBalance = balanceInfo({ allocatedBalances: 100n, totalLockedPartyB: 12n })
		const newPartyABalance = balanceInfo({ allocatedBalances: 100n })
		const newPartyBBalance = balanceInfo({ allocatedBalances: 100n })
		const user = {
			getAddress: async () => USER_ADDRESS,
			getBalanceInfo: read("user balance", newPartyABalance),
		} as unknown as User
		const hedger = {
			getAddress: async () => HEDGER_ADDRESS,
			getBalanceInfo: read("hedger balance", newPartyBBalance),
			getBalanceInfoCrossPartyB: read("cross hedger balance", newPartyBBalance),
		} as unknown as Hedger
		const context = {
			viewFacet: {
				nonceOfPartyA: read("partyA nonce", 1n),
				nonceOfPartyB: read("partyB nonce", 1n),
			},
			viewFacetQuote: {
				getQuote: async () => newQuote,
				partyAPositionsCount: read("partyA count", 0n),
				partyBPositionsCount: read("partyB count", 0n),
				getPartyAOpenPositions: read("partyA positions", []),
				getPartyBOpenPositions: read("partyB positions", []),
				getPartyBPendingQuotes: read("partyB pending", []),
			},
			viewFacetSymbol: {
				getConnectedPartyBs: read("connections", []),
			},
		} as unknown as RunContext

		const validationPromise = new FillCloseRequestValidator().after(context, {
			user,
			hedger,
			quoteId: 1n,
			closePrice: 100n,
			fillAmount: 10n,
			beforeOutput: {
				balanceInfoPartyA: oldPartyABalance,
				balanceInfoPartyB: oldPartyBBalance,
				quote: oldQuote as any,
				partyAPositionsCount: 1n,
				partyBPositionsCount: 1n,
				partyAOpenPositionCount: 1n,
				partyBOpenPositionCount: 1n,
				partyBPendingQuoteCount: 0n,
				connectedPartyBs: [HEDGER_ADDRESS],
				partyANonce: 0n,
				partyBNonce: 0n,
				isCrossPartyB: false,
			},
		})
		await flushStartedReads()

		expect(started).to.have.members([
			"user balance",
			"hedger balance",
			"partyA nonce",
			"partyB nonce",
			"partyA count",
			"partyB count",
			"partyA positions",
			"partyB positions",
			"partyB pending",
			"connections",
		])

		gate.resolve()
		await validationPromise
	})
})
