import { expect } from "chai"

import {
	getRandomSeed,
	pick,
	randomBigNumber,
	randomBigNumberRatio,
	randomFloat,
	setRandomSeed,
	withIsolatedRandomSequence,
} from "./utils/RandomUtils.js"

export function shouldBehaveLikeRandomUtils(): void {
	afterEach(function () {
		setRandomSeed(undefined)
	})

	it("replays mixed float, bigint, and pick sequences from the same seed", function () {
		const takeSequence = () => [
			randomFloat(),
			randomBigNumber(2n ** 200n),
			pick(["open", "close", "cancel"] as const),
			randomFloat(),
			randomBigNumber(500n, -500n),
		]

		setRandomSeed("fuzz-run-42")
		const firstSequence = takeSequence()

		setRandomSeed("fuzz-run-42")
		expect(takeSequence()).to.deep.equal(firstSequence)
	})

	it("retains the seed value and resets the sequence for all supported seed types", function () {
		for (const seed of ["run-7", 7, 7n]) {
			setRandomSeed(seed)
			const first = randomBigNumber(1_000_000n)

			setRandomSeed(seed)
			expect(getRandomSeed()).to.equal(seed)
			expect(randomBigNumber(1_000_000n)).to.equal(first)
		}

		setRandomSeed(undefined)
		expect(getRandomSeed()).to.equal(undefined)
	})

	it("keeps floats and bigints inside their exclusive upper bounds", function () {
		setRandomSeed("bounds")

		for (let i = 0; i < 250; i++) {
			const floatValue = randomFloat()
			expect(floatValue).to.be.at.least(0)
			expect(floatValue).to.be.lessThan(1)

			const bigintValue = randomBigNumber(23n, -17n)
			expect(bigintValue).to.be.at.least(-17n)
			expect(bigintValue).to.be.lessThan(23n)
		}
	})

	it("handles zero-width ranges without consuming randomness", function () {
		setRandomSeed("singleton-range")
		const expectedNextValue = randomBigNumber(10_000n)

		setRandomSeed("singleton-range")
		expect(randomBigNumber(0n)).to.equal(0n)
		expect(randomBigNumber(91n, 91n)).to.equal(91n)
		expect(randomBigNumber(1n)).to.equal(0n)
		expect(randomBigNumber(10_000n)).to.equal(expectedNextValue)
	})

	it("keeps diagnostic randomness from changing the modeled sequence", async function () {
		setRandomSeed("diagnostic-isolation")
		const expectedNextValue = randomBigNumber(10_000n)

		setRandomSeed("diagnostic-isolation")
		const diagnosticValues = await withIsolatedRandomSequence(async () => [randomBigNumber(10_000n), randomFloat()])

		expect(diagnosticValues[0]).to.equal(expectedNextValue)
		expect(randomBigNumber(10_000n)).to.equal(expectedNextValue)
	})

	it("rejects invalid ranges and empty picks", function () {
		expect(() => randomBigNumber(-1n)).to.throw(RangeError, "max (-1) must be greater than or equal to min (0)")
		expect(() => randomBigNumber(4n, 5n)).to.throw(RangeError, "max (4) must be greater than or equal to min (5)")
		expect(() => pick([])).to.throw(RangeError, "Cannot pick from an empty array")
	})

	it("replays ratios and keeps them within the requested bounds", function () {
		const value = 1_000_000_000_000_000_000n

		setRandomSeed(20260726n)
		const first = randomBigNumberRatio(value, 0.25, 0.1)

		setRandomSeed(20260726n)
		expect(randomBigNumberRatio(value, 0.25, 0.1)).to.equal(first)
		expect(first).to.be.at.least(value / 10n)
		expect(first).to.be.lessThan(value / 4n)
	})
}
