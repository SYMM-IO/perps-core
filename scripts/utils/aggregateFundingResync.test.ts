import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { accumulateGroupFunding, calculateGroupFunding, calculateWeightedPaidFunding } from "./aggregateFundingResync.js"

describe("aggregate funding resync arithmetic", () => {
	it("truncates negative signed division toward zero like Solidity", () => {
		assert.equal(calculateWeightedPaidFunding(10n ** 18n + 1n, -1n), -1n)
	})

	it("rounds each quote before adding and uses only the requested group", () => {
		const quotes = [
			{ symbolId: 7n, positionType: 0, quantity: 3n * 10n ** 17n, closedAmount: 0n, accumulatedPaidFunding: 6n },
			{ symbolId: 7n, positionType: 0, quantity: 3n * 10n ** 17n, closedAmount: 1n, accumulatedPaidFunding: 6n },
			{ symbolId: 8n, positionType: 0, quantity: 10n ** 18n, closedAmount: 0n, accumulatedPaidFunding: 99n },
			{ symbolId: 7n, positionType: 1, quantity: 10n ** 18n, closedAmount: 0n, accumulatedPaidFunding: 99n },
		]
		assert.equal(calculateGroupFunding(quotes, 7n, 0), 2n)
	})

	it("keeps the same checked-addition order across RPC pages", () => {
		const quotes = [
			{ symbolId: 1n, positionType: 0, quantity: 10n ** 18n + 1n, closedAmount: 0n, accumulatedPaidFunding: -1n },
			{ symbolId: 1n, positionType: 0, quantity: 2n * 10n ** 18n + 1n, closedAmount: 0n, accumulatedPaidFunding: 1n },
		]
		const firstPage = accumulateGroupFunding(0n, quotes.slice(0, 1), 1n, 0)
		const secondPage = accumulateGroupFunding(firstPage, quotes.slice(1), 1n, 0)
		assert.equal(secondPage, calculateGroupFunding(quotes, 1n, 0))
		assert.equal(secondPage, 1n)
	})

	it("matches Solidity's explicit uint256-to-int256 conversion", () => {
		assert.equal(calculateWeightedPaidFunding((1n << 256n) - 1n, 10n ** 18n), -1n)
	})

	it("rejects arithmetic that Solidity 0.8 would revert", () => {
		assert.throws(() => calculateWeightedPaidFunding((1n << 255n) - 1n, 2n), /outside int256/)
		assert.throws(
			() => calculateGroupFunding([{ symbolId: 1n, positionType: 0, quantity: 1n, closedAmount: 2n, accumulatedPaidFunding: 0n }], 1n, 0),
			/closedAmount exceeds/,
		)
	})
})
