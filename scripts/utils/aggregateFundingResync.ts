export const FIXED_POINT_SCALE = 10n ** 18n

const UINT256_MODULUS = 1n << 256n
const MAX_UINT256 = UINT256_MODULUS - 1n
const MIN_INT256 = -(1n << 255n)
const MAX_INT256 = (1n << 255n) - 1n

export interface FundingQuoteLike {
	symbolId: bigint
	positionType: bigint | number
	quantity: bigint
	closedAmount: bigint
	accumulatedPaidFunding: bigint
}

function requireUint256(value: bigint, label: string): bigint {
	if (value < 0n || value > MAX_UINT256) throw new Error(`${label} is outside uint256`)
	return value
}

export function requireInt256(value: bigint, label: string): bigint {
	if (value < MIN_INT256 || value > MAX_INT256) throw new Error(`${label} is outside int256`)
	return value
}

/** Matches Solidity's explicit int256(uint256Value) two's-complement conversion. */
function uint256ToInt256(value: bigint): bigint {
	requireUint256(value, "amount")
	return value <= MAX_INT256 ? value : value - UINT256_MODULUS
}

/** Matches LibAggregateFunding.calculateWeightedPaidFunding, including checked int256 multiplication and truncation toward zero. */
export function calculateWeightedPaidFunding(amount: bigint, accumulatedPaidFunding: bigint): bigint {
	const signedAmount = uint256ToInt256(amount)
	requireInt256(accumulatedPaidFunding, "accumulatedPaidFunding")
	const product = requireInt256(signedAmount * accumulatedPaidFunding, "amount * accumulatedPaidFunding")
	return product / FIXED_POINT_SCALE
}

/** Matches Solidity 0.8 checked int256 addition. */
export function addFunding(left: bigint, right: bigint): bigint {
	return requireInt256(left + right, "aggregate funding sum")
}

/** Matches Solidity 0.8 checked int256 subtraction. */
export function subtractFunding(left: bigint, right: bigint): bigint {
	return requireInt256(left - right, "aggregate funding difference")
}

/** Adds matching quote contributions in iteration order, preserving Solidity's checked-addition behavior across pages. */
export function accumulateGroupFunding(total: bigint, quotes: Iterable<FundingQuoteLike>, symbolId: bigint, positionType: number): bigint {
	requireInt256(total, "starting aggregate funding")
	for (const quote of quotes) {
		if (quote.symbolId !== symbolId || Number(quote.positionType) !== positionType) continue
		requireUint256(quote.quantity, "quote.quantity")
		requireUint256(quote.closedAmount, "quote.closedAmount")
		if (quote.closedAmount > quote.quantity) throw new Error("quote.closedAmount exceeds quote.quantity")
		const openAmount = quote.quantity - quote.closedAmount
		total = addFunding(total, calculateWeightedPaidFunding(openAmount, quote.accumulatedPaidFunding))
	}
	return total
}

/** Sums one group's per-quote funding contributions with checked arithmetic and truncation toward zero. */
export function calculateGroupFunding(quotes: Iterable<FundingQuoteLike>, symbolId: bigint, positionType: number): bigint {
	return accumulateGroupFunding(0n, quotes, symbolId, positionType)
}
