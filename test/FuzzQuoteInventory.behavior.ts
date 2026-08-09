import { expect } from "chai"

import type { FuzzModelEvent } from "./models/FuzzLogTypes.js"
import {
	FUZZ_QUOTE_STATUS_NAMES,
	FuzzQuoteInventoryTracker,
	type FuzzOrderType,
	type FuzzPositionType,
	type FuzzQuoteStatusName,
} from "./utils/FuzzQuoteInventory.js"

type QuoteStateEvent = Extract<FuzzModelEvent, { type: "state" }>

function state(quoteId: bigint, quoteStatus: FuzzQuoteStatusName, overrides: Partial<QuoteStateEvent["quote"]> = {}): QuoteStateEvent {
	return {
		type: "state",
		quoteId,
		quoteStatus,
		quote: {
			positionType: "LONG",
			orderType: "LIMIT",
			quantity: 100n,
			closedAmount: 0n,
			quantityToClose: 0n,
			parentId: 0n,
			...overrides,
		},
	}
}

export function shouldBehaveLikeFuzzQuoteInventory(): void {
	it("reports every quote status, including zero-filled states and active versus terminal totals", function () {
		const tracker = new FuzzQuoteInventoryTracker()

		FUZZ_QUOTE_STATUS_NAMES.forEach((quoteStatus, index) => {
			const positionType: FuzzPositionType = index % 2 === 0 ? "LONG" : "SHORT"
			const orderType: FuzzOrderType = index % 2 === 0 ? "LIMIT" : "MARKET"
			tracker.observe(state(BigInt(index + 1), quoteStatus, { positionType, orderType }))
		})

		const inventory = tracker.snapshot()
		expect(inventory.total).to.equal(11)
		expect(inventory.active).to.equal(6)
		expect(inventory.terminal).to.equal(5)
		expect(inventory.byStatus).to.deep.equal({
			PENDING: 1,
			LOCKED: 1,
			CANCEL_PENDING: 1,
			CANCELED: 1,
			OPENED: 1,
			CLOSE_PENDING: 1,
			CANCEL_CLOSE_PENDING: 1,
			CLOSED: 1,
			LIQUIDATED: 1,
			EXPIRED: 1,
			LIQUIDATED_PENDING: 1,
		})
		expect(inventory.byPositionType).to.deep.equal({ LONG: 6, SHORT: 5 })
		expect(inventory.byOpeningOrderType).to.deep.equal({ LIMIT: 6, MARKET: 5 })
		expect(inventory.byCloseOrderType).to.deep.equal({ LIMIT: 1, MARKET: 1 })
	})

	it("starts with all counters present and zero", function () {
		const inventory = new FuzzQuoteInventoryTracker().snapshot()

		expect(inventory).to.deep.equal({
			total: 0,
			active: 0,
			terminal: 0,
			byStatus: {
				PENDING: 0,
				LOCKED: 0,
				CANCEL_PENDING: 0,
				CANCELED: 0,
				OPENED: 0,
				CLOSE_PENDING: 0,
				CANCEL_CLOSE_PENDING: 0,
				CLOSED: 0,
				LIQUIDATED: 0,
				EXPIRED: 0,
				LIQUIDATED_PENDING: 0,
			},
			byPositionType: { LONG: 0, SHORT: 0 },
			byOpeningOrderType: { LIMIT: 0, MARKET: 0 },
			byCloseOrderType: { LIMIT: 0, MARKET: 0 },
			partialOpen: { splits: 0, activePositions: 0, waitingRemainders: 0 },
			partialCloseRequested: 0,
			partiallyClosed: 0,
		})
	})

	it("updates a quote idempotently and replaces its previous lifecycle state", function () {
		const tracker = new FuzzQuoteInventoryTracker()
		const pending = state(7n, "PENDING")

		const first = tracker.observe(pending)
		const replayed = tracker.observe(pending)
		const locked = tracker.observe(state(7n, "LOCKED"))

		expect(replayed).to.deep.equal(first)
		expect(locked.total).to.equal(1)
		expect(locked.byStatus.PENDING).to.equal(0)
		expect(locked.byStatus.LOCKED).to.equal(1)
		expect(locked.active).to.equal(1)
	})

	it("preserves the first-seen opening order type and counts close mode only while a close request is live", function () {
		const tracker = new FuzzQuoteInventoryTracker()
		tracker.observe(state(1n, "PENDING", { orderType: "LIMIT" }))

		const closing = tracker.observe(state(1n, "CLOSE_PENDING", { orderType: "MARKET", quantityToClose: 100n }))
		expect(closing.byOpeningOrderType).to.deep.equal({ LIMIT: 1, MARKET: 0 })
		expect(closing.byCloseOrderType).to.deep.equal({ LIMIT: 0, MARKET: 1 })

		const canceledClose = tracker.observe(state(1n, "OPENED", { orderType: "MARKET" }))
		expect(canceledClose.byOpeningOrderType).to.deep.equal({ LIMIT: 1, MARKET: 0 })
		expect(canceledClose.byCloseOrderType).to.deep.equal({ LIMIT: 0, MARKET: 0 })
	})

	it("keeps active split positions disjoint from waiting pre-open remainders", function () {
		const tracker = new FuzzQuoteInventoryTracker()
		tracker.observe(state(10n, "OPENED"))
		tracker.observe(state(11n, "PENDING", { parentId: 10n, quantity: 75n }))

		expect(tracker.snapshot().partialOpen).to.deep.equal({
			splits: 1,
			activePositions: 1,
			waitingRemainders: 1,
		})

		tracker.observe(state(11n, "OPENED", { parentId: 10n, quantity: 75n }))
		tracker.observe(state(12n, "LOCKED", { parentId: 11n, quantity: 50n }))
		expect(tracker.snapshot().partialOpen).to.deep.equal({
			splits: 2,
			activePositions: 2,
			waitingRemainders: 1,
		})

		tracker.observe(state(10n, "CLOSED", { closedAmount: 100n }))
		tracker.observe(state(12n, "CANCELED", { parentId: 11n, quantity: 50n }))
		expect(tracker.snapshot().partialOpen).to.deep.equal({
			splits: 2,
			activePositions: 1,
			waitingRemainders: 0,
		})
	})

	it("distinguishes partial close requests, partial fills, zero boundaries, and full closes", function () {
		const tracker = new FuzzQuoteInventoryTracker()
		tracker.observe(state(1n, "CLOSE_PENDING", { quantity: 100n, closedAmount: 20n, quantityToClose: 40n }))
		tracker.observe(state(2n, "CLOSE_PENDING", { quantity: 100n, quantityToClose: 0n }))
		tracker.observe(state(3n, "CLOSE_PENDING", { quantity: 100n, quantityToClose: 100n }))
		tracker.observe(state(4n, "CLOSED", { quantity: 100n, closedAmount: 100n }))
		tracker.observe(state(5n, "CANCEL_CLOSE_PENDING", { quantity: 100n, closedAmount: 40n, quantityToClose: 60n }))
		tracker.observe(state(6n, "OPENED", { quantity: 100n, closedAmount: 50n }))
		tracker.observe(state(7n, "LIQUIDATED", { quantity: 100n, closedAmount: 50n }))

		const inventory = tracker.snapshot()
		expect(inventory.partialCloseRequested).to.equal(1)
		expect(inventory.partiallyClosed).to.equal(4)
		expect(inventory.byCloseOrderType).to.deep.equal({ LIMIT: 4, MARKET: 0 })
	})
}
