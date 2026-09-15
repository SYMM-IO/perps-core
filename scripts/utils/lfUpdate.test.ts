import assert from "node:assert/strict"
import test from "node:test"

import { LF_BTC_ETH, LF_OTHER, analyzeLfState, buildLfAction, classifyLfSymbols, lfCapacity, parseLfIds } from "./lfUpdate.js"

const symbol = (symbolId: string, name: string, overrides = {}) => ({
	symbolId,
	name,
	isValid: true,
	minAcceptableQuoteValue: `${symbolId}00000000000000000000`,
	minAcceptablePortionLF: "3000000000000000",
	tradingFee: "100",
	maxLeverage: "200",
	fundingRateEpochDuration: "3600",
	fundingRateWindowTime: "300",
	...overrides,
})
const symbols = [
	symbol("1", "BTCUSDT"),
	symbol("2", "BTCUSD_CARBONRWA", { isValid: false }),
	symbol("3", "ETHUSDT"),
	symbol("4", "ETHFIUSDT"),
	symbol("5", "XAUUSD"),
]

test("classification keeps duplicate and inactive BTC listings and surfaces ambiguous names", () => {
	assert.deepEqual(classifyLfSymbols(symbols), { btcEthIds: ["1", "2", "3"], ambiguousIds: ["4"] })
	assert.deepEqual(parseLfIds("1, 2,3", symbols), ["1", "2", "3"])
	assert.throws(() => parseLfIds("1,1", symbols), /duplicate/)
	assert.throws(() => parseLfIds("6", symbols), /unknown/)
})

test("exact calldata preserves each quote minimum and assigns the reviewed rate by ID", () => {
	const action = buildLfAction("0x1111111111111111111111111111111111111111", symbols, ["1", "2", "3"])
	assert.deepEqual(
		action.minAcceptableQuoteValues,
		symbols.map(s => s.minAcceptableQuoteValue),
	)
	assert.deepEqual(action.minAcceptablePortionLFs, [LF_BTC_ETH, LF_BTC_ETH, LF_BTC_ETH, LF_OTHER, LF_OTHER])
	assert.deepEqual(action.symbolIds, ["1", "2", "3", "4", "5"])
})

test("partial completion skips target values, detects drift, and refuses unseen catalog additions", () => {
	const current = symbols.map(s => ({ ...s }))
	current[0].minAcceptablePortionLF = LF_BTC_ETH
	assert.deepEqual(
		analyzeLfState(symbols, current, ["1", "2", "3"]).pending.map(s => s.symbolId),
		["2", "3", "4", "5"],
	)
	current[1].minAcceptableQuoteValue = "0"
	assert.throws(() => analyzeLfState(symbols, current, ["1", "2", "3"]), /minAcceptableQuoteValue/)
	assert.throws(() => analyzeLfState(symbols, [...symbols, symbol("6", "SOLUSDT")], ["1"]), /catalog/)
	assert.throws(
		() =>
			analyzeLfState(
				symbols,
				symbols.map(s => ({ ...s, minAcceptablePortionLF: "7" })),
				["1"],
			),
		/LF changed/,
	)
})

test("quota resets at the contract boundary and clamps a lowered limit below usage", () => {
	assert.equal(lfCapacity("3000", "100", "1000", "87399").remaining, 2900)
	assert.equal(lfCapacity("3000", "100", "1000", "87400").remaining, 3000)
	assert.equal(lfCapacity("50", "100", "1000", "1001").remaining, 0)
})
