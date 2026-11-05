import type { FuzzModelEvent } from "../models/FuzzLogTypes.js"

export const FUZZ_QUOTE_STATUS_NAMES = [
	"PENDING",
	"LOCKED",
	"CANCEL_PENDING",
	"CANCELED",
	"OPENED",
	"CLOSE_PENDING",
	"CANCEL_CLOSE_PENDING",
	"CLOSED",
	"LIQUIDATED",
	"EXPIRED",
	"LIQUIDATED_PENDING",
] as const

export type FuzzQuoteStatusName = (typeof FUZZ_QUOTE_STATUS_NAMES)[number]

export const FUZZ_POSITION_TYPES = ["LONG", "SHORT"] as const

export type FuzzPositionType = (typeof FUZZ_POSITION_TYPES)[number]

export const FUZZ_ORDER_TYPES = ["LIMIT", "MARKET", "MARKET_BEST_EFFORT"] as const

export type FuzzOrderType = (typeof FUZZ_ORDER_TYPES)[number]

export type FuzzQuoteInventory = {
	total: number
	active: number
	terminal: number
	byStatus: Record<FuzzQuoteStatusName, number>
	byPositionType: Record<FuzzPositionType, number>
	byOpeningOrderType: Record<FuzzOrderType, number>
	byCloseOrderType: Record<FuzzOrderType, number>
	partialOpen: {
		splits: number
		activePositions: number
		waitingRemainders: number
	}
	partialCloseRequested: number
	partiallyClosed: number
}

type FuzzQuoteStateEvent = Extract<FuzzModelEvent, { type: "state" }>

type TrackedQuote = {
	quoteId: bigint
	quoteStatus: FuzzQuoteStatusName
	positionType: FuzzPositionType
	openingOrderType: FuzzOrderType
	currentOrderType: FuzzOrderType
	quantity: bigint
	closedAmount: bigint
	quantityToClose: bigint
	parentId: bigint
}

const QUOTE_STATUS_SET = new Set<string>(FUZZ_QUOTE_STATUS_NAMES)
const POSITION_TYPE_SET = new Set<string>(FUZZ_POSITION_TYPES)
const ORDER_TYPE_SET = new Set<string>(FUZZ_ORDER_TYPES)

const TERMINAL_STATUSES = new Set<FuzzQuoteStatusName>(["CANCELED", "CLOSED", "LIQUIDATED", "EXPIRED", "LIQUIDATED_PENDING"])
const ACTIVE_POSITION_STATUSES = new Set<FuzzQuoteStatusName>(["OPENED", "CLOSE_PENDING", "CANCEL_CLOSE_PENDING"])
const PRE_OPEN_REMAINDER_STATUSES = new Set<FuzzQuoteStatusName>(["PENDING", "LOCKED", "CANCEL_PENDING"])
const CLOSE_REQUEST_STATUSES = new Set<FuzzQuoteStatusName>(["CLOSE_PENDING", "CANCEL_CLOSE_PENDING"])

function countsFor<const T extends readonly string[]>(keys: T): Record<T[number], number> {
	return Object.fromEntries(keys.map(key => [key, 0])) as Record<T[number], number>
}

function quoteStatusName(value: string): FuzzQuoteStatusName {
	if (!QUOTE_STATUS_SET.has(value)) throw new Error(`Unknown fuzz quote status ${JSON.stringify(value)}`)
	return value as FuzzQuoteStatusName
}

function positionTypeName(value: string): FuzzPositionType {
	if (!POSITION_TYPE_SET.has(value)) throw new Error(`Unknown fuzz position type ${JSON.stringify(value)}`)
	return value as FuzzPositionType
}

function orderTypeName(value: string): FuzzOrderType {
	if (!ORDER_TYPE_SET.has(value)) throw new Error(`Unknown fuzz order type ${JSON.stringify(value)}`)
	return value as FuzzOrderType
}

function emptyInventory(): FuzzQuoteInventory {
	return {
		total: 0,
		active: 0,
		terminal: 0,
		byStatus: countsFor(FUZZ_QUOTE_STATUS_NAMES),
		byPositionType: countsFor(FUZZ_POSITION_TYPES),
		byOpeningOrderType: countsFor(FUZZ_ORDER_TYPES),
		byCloseOrderType: countsFor(FUZZ_ORDER_TYPES),
		partialOpen: {
			splits: 0,
			activePositions: 0,
			waitingRemainders: 0,
		},
		partialCloseRequested: 0,
		partiallyClosed: 0,
	}
}

/**
 * Maintains the latest known state for every quote observed by a fuzz run.
 *
 * The inventory is derived from the map on demand. Replaying the same state
 * event is therefore idempotent, while transitions replace the previous state
 * instead of inflating counters.
 */
export class FuzzQuoteInventoryTracker {
	private readonly quotes = new Map<bigint, TrackedQuote>()

	public observe(event: FuzzQuoteStateEvent): FuzzQuoteInventory {
		const previous = this.quotes.get(event.quoteId)
		const currentOrderType = orderTypeName(event.quote.orderType)
		this.quotes.set(event.quoteId, {
			quoteId: event.quoteId,
			quoteStatus: quoteStatusName(event.quoteStatus),
			positionType: positionTypeName(event.quote.positionType),
			openingOrderType: previous?.openingOrderType ?? currentOrderType,
			currentOrderType,
			quantity: event.quote.quantity,
			closedAmount: event.quote.closedAmount,
			quantityToClose: event.quote.quantityToClose,
			parentId: event.quote.parentId,
		})
		return this.snapshot()
	}

	public snapshot(): FuzzQuoteInventory {
		const inventory = emptyInventory()
		const referencedParentIds = new Set<bigint>()

		for (const quote of this.quotes.values()) {
			if (quote.parentId > 0n) referencedParentIds.add(quote.parentId)
		}

		for (const quote of this.quotes.values()) {
			const terminal = TERMINAL_STATUSES.has(quote.quoteStatus)
			inventory.total++
			inventory.byStatus[quote.quoteStatus]++
			inventory.byPositionType[quote.positionType]++
			inventory.byOpeningOrderType[quote.openingOrderType]++
			if (terminal) inventory.terminal++
			else inventory.active++

			if (CLOSE_REQUEST_STATUSES.has(quote.quoteStatus)) {
				inventory.byCloseOrderType[quote.currentOrderType]++
				const remainingQuantity = quote.quantity - quote.closedAmount
				if (quote.quantityToClose > 0n && quote.quantityToClose < remainingQuantity) {
					inventory.partialCloseRequested++
				}
			}

			if (quote.closedAmount > 0n && quote.closedAmount < quote.quantity) {
				inventory.partiallyClosed++
			}

			const belongsToSplitLineage = quote.parentId > 0n || referencedParentIds.has(quote.quoteId)
			if (belongsToSplitLineage && ACTIVE_POSITION_STATUSES.has(quote.quoteStatus)) {
				inventory.partialOpen.activePositions++
			}
			if (quote.parentId > 0n && PRE_OPEN_REMAINDER_STATUSES.has(quote.quoteStatus)) {
				inventory.partialOpen.waitingRemainders++
			}
		}

		inventory.partialOpen.splits = referencedParentIds.size
		return inventory
	}
}
