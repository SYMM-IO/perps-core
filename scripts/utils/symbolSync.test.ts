import assert from "node:assert/strict"
import test from "node:test"

import {
	SYMBOL_SYNC_CONFIG_API,
	analyzeExactIdSync,
	buildSymbolSyncWindow,
	digestJson,
	effectiveDailyCapacity,
	parseSymbolSyncConfig,
	type SerializedSymbol,
	verifyDigest,
	withDigest,
} from "./symbolSync.js"

function symbol(symbolId: number, overrides: Partial<SerializedSymbol> = {}): SerializedSymbol {
	return {
		symbolId: String(symbolId),
		name: `SYMBOL-${symbolId}`,
		isValid: true,
		minAcceptableQuoteValue: "1",
		minAcceptablePortionLF: "2",
		tradingFee: "3",
		maxLeverage: "4",
		fundingRateEpochDuration: "3600",
		fundingRateWindowTime: "420",
		symbolType: "2",
		...overrides,
	}
}

test("exact-ID analysis preserves order and treats validation drift as repairable", () => {
	const source = [symbol(1), symbol(2, { isValid: false }), symbol(3)]
	const target = [symbol(1), symbol(2)]
	const result = analyzeExactIdSync(source, target)

	assert.equal(result.status, "ready")
	assert.deepEqual(
		result.additions.map(value => value.symbolId),
		["3"],
	)
	assert.deepEqual(
		result.deactivate.map(value => value.symbolId),
		["2"],
	)
	assert.deepEqual(result.conflicts, [])
})

test("exact-ID analysis blocks a same-ID configuration conflict", () => {
	const result = analyzeExactIdSync([symbol(1)], [symbol(1, { name: "WRONG" })])
	assert.equal(result.status, "blocked")
	assert.match(result.conflicts[0], /Symbol ID 1 conflicts \(name:/)
})

test("daily capacity resets logically before the next mutating call", () => {
	const limits = { symbolAddition: 25n, validationState: 25n }
	assert.deepEqual(effectiveDailyCapacity(limits, { symbolAddition: 25n, validationState: 10n }, 100n, 86_500n), {
		additionRemaining: 25n,
		validationRemaining: 25n,
		resetAt: 86_500n,
		resetDue: true,
	})
})

test("a window never adds an invalid symbol without a validation slot", () => {
	const source = [symbol(1), symbol(2), symbol(3, { isValid: false }), symbol(4)]
	const analysis = analyzeExactIdSync(source, [symbol(1)])
	const window = buildSymbolSyncWindow(
		analysis,
		{ symbolAddition: 25n, validationState: 25n },
		{ symbolAddition: 0n, validationState: 25n },
		1_000n,
		1_001n,
		25,
	)
	assert.deepEqual(
		window.additions.map(value => value.symbolId),
		["2"],
	)
	assert.deepEqual(window.deactivateAdded, [])
})

test("config parsing normalizes chain IDs and addresses and refuses escaping outputs", () => {
	const parsed = parseSymbolSyncConfig({
		apiVersion: SYMBOL_SYNC_CONFIG_API,
		name: "test",
		source: { network: "hyperevm", chainId: "999", core: "0x1111111111111111111111111111111111111111" },
		target: {
			network: "arbitrum",
			chainId: "42161",
			core: "0x2222222222222222222222222222222222222222",
			symbolManager: "0x3333333333333333333333333333333333333333",
		},
		execution: { batchSize: 25, preserveValidation: true },
		output: { snapshot: "scripts/output/snapshot.json", assignmentReport: "scripts/output/report.json" },
	})
	assert.equal(parsed.source.chainId, "999")
	assert.throws(() => parseSymbolSyncConfig({ ...parsed, output: { ...parsed.output, snapshot: "../snapshot.json" } }), /must stay inside/)
})

test("all batch size consumes the live symbol capacity", () => {
	const parsed = parseSymbolSyncConfig({
		apiVersion: SYMBOL_SYNC_CONFIG_API,
		name: "test",
		source: { network: "hyperevm", chainId: "999", core: "0x1111111111111111111111111111111111111111" },
		target: {
			network: "arbitrum",
			chainId: "42161",
			core: "0x2222222222222222222222222222222222222222",
			symbolManager: "0x3333333333333333333333333333333333333333",
		},
		execution: { batchSize: "all", preserveValidation: true },
		output: { snapshot: "scripts/output/snapshot.json", assignmentReport: "scripts/output/report.json" },
	})
	assert.equal(parsed.execution.batchSize, "all")

	const source = [symbol(1), symbol(2), symbol(3, { isValid: false }), symbol(4)]
	const window = buildSymbolSyncWindow(
		analyzeExactIdSync(source, [symbol(1)]),
		{ symbolAddition: 100n, validationState: 100n },
		{ symbolAddition: 0n, validationState: 0n },
		1_000n,
		1_001n,
		parsed.execution.batchSize,
	)
	assert.deepEqual(
		window.additions.map(value => value.symbolId),
		["2", "3", "4"],
	)
	assert.deepEqual(
		window.deactivateAdded.map(value => value.symbolId),
		["3"],
	)
})

test("snapshot digests are stable and detect edits", () => {
	const value = withDigest({ apiVersion: "test", symbols: [symbol(1)] })
	assert.equal(verifyDigest(value, "snapshot"), value.digest)
	assert.equal(digestJson({ b: 2, a: 1 }), digestJson({ a: 1, b: 2 }))
	assert.throws(() => verifyDigest({ ...value, symbols: [symbol(1, { name: "edited" })] }, "snapshot"), /digest mismatch/)
})
