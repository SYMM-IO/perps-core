import { BigNumber as BN } from "bignumber.js"
import { expect } from "chai"

export function safeDiv(a: bigint, b: bigint): bigint {
	const value = new BN(a.toString()).dividedBy(new BN(b.toString()))
	if (value.isLessThan(1) && value.isGreaterThan(0)) {
		throw new Error("Division led to fraction!")
	}
	return BigInt(value.toFixed(0))
}

BN.set({ ROUNDING_MODE: BN.ROUND_CEIL })

export function roundToPrecision(a: bigint, precision: number): bigint {
	if (!Number.isInteger(precision) || precision < 0 || precision > 18) {
		throw new RangeError(`Precision must be an integer between 0 and 18, received ${precision}`)
	}

	const quantum = 10n ** BigInt(18 - precision)
	const remainder = a % quantum
	if (remainder === 0n) return a

	const truncated = (a / quantum) * quantum
	return a > 0n ? truncated + quantum : truncated
}

export function expectToBeApproximately(a: bigint, b: bigint): void {
	const difference = a >= b ? a - b : b - a
	expect(difference).to.be.lte(10n)
}
