import { expect } from "chai"

import { initializeFixture } from "../Initialize.fixture.js"
import { loadFixture } from "../helpers/network-helpers.js"
import { TestManager } from "../models/TestManager.js"
import { describeResult, type RandomLiquidationResult, runRandomLiquidation } from "../utils/FuzzLiquidationGenerator.js"
import { isKnownViolation, parseKnownViolations } from "../utils/LiquidationModel.js"

/**
 * Seeded random PartyA liquidations checked against the reference model.
 *
 *   LIQ_SEED=sweep LIQ_ITERATIONS=40 npx hardhat test mocha --no-compile -- test/parallel/LiquidationModelFuzz.test.ts
 *
 * Every violation code is reported; the suite fails unless each one is listed in
 * FUZZ_KNOWN_VIOLATIONS (for example "PLAN_SUM<=8,CONSERVATION<=8" tolerates the per-quote
 * floor rounding while larger leaks still fail).
 */
describe("liquidation model fuzz", function () {
	this.timeout(600_000)
	const seed = process.env.LIQ_SEED ?? "liq-model-1"
	const iterations = Number(process.env.LIQ_ITERATIONS ?? "20")
	// Strict by default: every liquidation must settle exactly. FUZZ_KNOWN_VIOLATIONS tolerates listed codes.
	const known = parseKnownViolations(process.env.FUZZ_KNOWN_VIOLATIONS)
	// LIQ_ONLY=3,17 replays selected iterations of a seed.
	const only = process.env.LIQ_ONLY === undefined ? undefined : new Set(process.env.LIQ_ONLY.split(",").map(Number))
	const results: RandomLiquidationResult[] = []

	for (let iteration = 0; iteration < iterations; iteration++) {
		if (only !== undefined && !only.has(iteration)) continue
		it(`iteration ${iteration} (${seed})`, async function () {
			const context = await loadFixture(initializeFixture)
			const manager = new TestManager(context, false, "direct")
			context.manager = manager
			const result = await runRandomLiquidation(context, manager, { seed: `${seed}:${iteration}`, configureLfCap: true })
			results.push(result)
			const unexpected = result.violations.filter(violation => !isKnownViolation(violation, known))
			expect(unexpected, unexpected.map(v => `${v.code}: ${v.detail}`).join("\n")).to.deep.equal([])
		})
	}

	after(function () {
		console.log("\n      seed | band flow type outcome | legs | shapes | violations")
		for (const result of results) console.log(`      ${describeResult(result)}`)
		const counts: Record<string, number> = {}
		for (const result of results)
			for (const violation of result.violations) counts[violation.code.split(":")[0]] = (counts[violation.code.split(":")[0]] ?? 0) + 1
		console.log(`      violation codes: ${JSON.stringify(counts)}`)
	})
})
