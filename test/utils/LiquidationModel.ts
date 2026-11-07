import { PositionType } from "../models/Enums.js"

/**
 * Reference model of a PartyA liquidation, written from the protocol's accounting rules rather
 * than copied from the contract control flow. The fuzz generator executes a random liquidation on
 * chain and compares every observable (type, deficit, fee, dispute, per-solver plan, settlement
 * deltas, final balances) with this model, then checks spec-level identities that must hold no
 * matter how the contract arrives at its numbers.
 */

export const ROUNDING_ALLOWANCE_PER_POSITION = 3n

export enum ModelLiquidationType {
	NONE = 0,
	NORMAL = 1,
	LATE = 2,
	OVERDUE = 3,
}

export type ModelQuote = {
	id: bigint
	partyB: string
	side: PositionType
	openedPrice: bigint
	openAmount: bigint
	cva: bigint
	fundingFee: bigint
}

export type LiquidationPlanInput = {
	/** Allocation the liquidation signature was built against (consumed by the liquidation). */
	allocated: bigint
	lockedCva: bigint
	lockedLf: bigint
	positionsCount: bigint
	maxLiquidationProfitPerPosition: bigint
	quotes: ModelQuote[]
	price: bigint
	signedUpnl: bigint
	/** Still part of the Muon payload, but the protocol no longer reads it: the plan is built from on-chain totals. */
	signedTotalUnrealizedLoss: bigint
	/** Each solver's allocation for this PartyA while positions are liquidated (before CVA is returned). */
	allocationAtClose: Record<string, bigint>
	/**
	 * Order in which the quotes are closed on chain (quote ids). A solver's bucket opens at its first closed quote,
	 * and the plan step walks the buckets in that order with running remainders. Defaults to `quotes` order.
	 */
	closeOrder?: bigint[]
	/** Allocation set aside at liquidation start (deferred flow); the NORMAL rounding recovery draws on it first. */
	deferredBalance?: bigint
}

export type SolverPlan = {
	partyB: string
	expectedAmount: bigint
	actualAmount: bigint
	cva: bigint
}

export type LiquidationPlan = {
	solvent: boolean
	type: ModelLiquidationType
	shortfall: bigint
	deficit: bigint
	/** Liquidator fee as fixed at liquidation start, before the rounding recovery. */
	liquidationFeeAtStart: bigint
	/** Liquidator fee paid at finalization. */
	liquidationFee: bigint
	/** Insurance vault credit made at liquidation start. */
	vaultCredit: bigint
	/** Part of the vault credit taken back by the rounding recovery at the plan step. */
	vaultRecovered: bigint
	solvers: Record<string, SolverPlan>
	accumulatedUpnl: bigint
	disputed: boolean
	/**
	 * Change of PartyA's deferred balance at the plan step. Positive: collateral the buckets do not need, returned to
	 * PartyA at finalization. Negative: a NORMAL rounding shortfall recovered from the deferred allocation.
	 */
	deferredDelta: bigint
}

export type SolverSettlement = {
	partyB: string
	settleAmount: bigint
	cva: bigint
	/** Change of the solver's allocation for this PartyA. */
	delta: bigint
	/** The solver's allocation (with its CVA back) is below its planned amount; the protocol reverts instead of capping. */
	cappedBy: bigint
}

export type SettlementPlan = {
	solvers: Record<string, SolverSettlement>
}

export type Violation = {
	code: string
	detail: string
	amount?: bigint
}

/** Mirrors LibQuote.getValueOfQuoteForPartyA: signed PnL of PartyA on one position at `price`. */
export function quotePnlForPartyA(quote: Pick<ModelQuote, "side" | "openedPrice" | "openAmount">, price: bigint): bigint {
	const up = price > quote.openedPrice
	const magnitude = ((up ? price - quote.openedPrice : quote.openedPrice - price) * quote.openAmount) / 10n ** 18n
	const profit = up ? quote.side === PositionType.LONG : quote.side !== PositionType.LONG
	return profit ? magnitude : -magnitude
}

export function truePnl(quotes: ModelQuote[], price: bigint): { upnl: bigint; totalUnrealizedLoss: bigint } {
	let upnl = 0n
	let totalUnrealizedLoss = 0n
	for (const quote of quotes) {
		const pnl = quotePnlForPartyA(quote, price) - quote.fundingFee
		upnl += pnl
		if (pnl < 0n) totalUnrealizedLoss += pnl
	}
	return { upnl, totalUnrealizedLoss }
}

function abs(value: bigint): bigint {
	return value < 0n ? -value : value
}

function min(a: bigint, b: bigint): bigint {
	return a < b ? a : b
}

function smallerSameDirection(signed: bigint, settled: bigint): bigint {
	if (signed > 0n && settled > 0n) return signed < settled ? signed : settled
	if (signed < 0n && settled < 0n) return signed > settled ? signed : settled
	return 0n
}

/** Mirrors `_capSettlementToSmallerUpnl`: the reduction consumes planned amounts of its own sign, bucket by bucket. */
function capBucket(solver: SolverPlan, remainingReduction: bigint): bigint {
	const actual = solver.actualAmount
	if (remainingReduction === 0n || actual === 0n || remainingReduction > 0n !== actual > 0n) return remainingReduction
	const sign = remainingReduction > 0n ? 1n : -1n
	const reduction = sign * min(abs(actual), abs(remainingReduction))
	solver.actualAmount = actual - reduction
	const expected = solver.expectedAmount
	if (expected !== 0n && expected > 0n === reduction > 0n) solver.expectedAmount = expected - sign * min(abs(expected), abs(reduction))
	return remainingReduction - reduction
}

export function planLiquidation(input: LiquidationPlanInput): LiquidationPlan {
	const available = input.allocated - input.lockedCva - input.lockedLf + input.signedUpnl
	const solvers: Record<string, SolverPlan> = {}
	const plan: LiquidationPlan = {
		solvent: available >= 0n,
		type: ModelLiquidationType.NONE,
		shortfall: 0n,
		deficit: 0n,
		liquidationFeeAtStart: 0n,
		liquidationFee: 0n,
		vaultCredit: 0n,
		vaultRecovered: 0n,
		solvers,
		accumulatedUpnl: 0n,
		disputed: false,
		deferredDelta: 0n,
	}
	if (plan.solvent) return plan
	const shortfall = -available
	plan.shortfall = shortfall
	const lfAndCva = input.lockedLf + input.lockedCva
	if (shortfall < input.lockedLf) {
		plan.type = ModelLiquidationType.NORMAL
		let remainingLf = input.lockedLf - shortfall
		const maxLf = input.maxLiquidationProfitPerPosition * input.positionsCount
		if (remainingLf > maxLf) {
			plan.vaultCredit = remainingLf - maxLf
			remainingLf = maxLf
		}
		plan.liquidationFeeAtStart = remainingLf
		plan.liquidationFee = remainingLf
	} else if (shortfall <= lfAndCva) {
		plan.type = ModelLiquidationType.LATE
		plan.deficit = shortfall - input.lockedLf
	} else {
		plan.type = ModelLiquidationType.OVERDUE
		plan.deficit = shortfall - lfAndCva
	}

	// Close step: buckets hold raw amounts in close order; a solver's bucket opens at its first closed quote.
	const byId = new Map(input.quotes.map(quote => [quote.id, quote]))
	const orderedQuotes = input.closeOrder === undefined ? input.quotes : input.closeOrder.map(id => byId.get(id)!)
	for (const quote of orderedQuotes) {
		const solver = (solvers[quote.partyB] ??= { partyB: quote.partyB, expectedAmount: 0n, actualAmount: 0n, cva: 0n })
		const pnl = quotePnlForPartyA(quote, input.price) - quote.fundingFee
		solver.expectedAmount += pnl
		solver.actualAmount += pnl
		if (plan.type !== ModelLiquidationType.OVERDUE) solver.cva += quote.cva
	}
	// Bucket close: a payer is counted at min(expected, allocation) and never pays more than what was counted.
	const buckets = Object.values(solvers)
	for (const solver of buckets) {
		if (solver.expectedAmount < 0n) {
			plan.accumulatedUpnl += solver.expectedAmount
		} else {
			const counted = min(solver.expectedAmount, input.allocationAtClose[solver.partyB] ?? 0n)
			plan.accumulatedUpnl += counted
			solver.actualAmount = counted
		}
	}

	// Plan step, in the close that brings the position count to zero.
	let netUpnl = plan.accumulatedUpnl
	const difference = abs(netUpnl - input.signedUpnl)
	if (difference > ROUNDING_ALLOWANCE_PER_POSITION * input.positionsCount) {
		plan.disputed = true
		netUpnl = input.signedUpnl
	} else if (difference !== 0n) {
		const capped = smallerSameDirection(input.signedUpnl, netUpnl)
		let remaining = netUpnl - capped
		for (const solver of buckets) {
			if (remaining === 0n) break
			remaining = capBucket(solver, remaining)
		}
		plan.accumulatedUpnl = capped
		netUpnl = capped
	}

	if (plan.type === ModelLiquidationType.NORMAL) {
		if (!plan.disputed) {
			// Fee and vault credit were sized from the signed uPNL; the buckets settle at the capped on-chain amount.
			const diff = netUpnl - input.signedUpnl
			if (diff >= 0n) {
				plan.deferredDelta = diff
			} else {
				let short = -diff
				let take = min(input.deferredBalance ?? 0n, short)
				plan.deferredDelta = -take
				short -= take
				take = min(plan.liquidationFee, short)
				plan.liquidationFee -= take
				short -= take
				take = min(plan.vaultCredit, short)
				plan.vaultRecovered = take
				short -= take
				if (short > 0n) plan.disputed = true
			}
		}
	} else {
		// LATE and OVERDUE: PartyA's allocation plus its net uPNL is what is left once every bucket settles at its
		// planned amount. Positive: returned as CVA pro rata to locked CVA. Negative: shared across net claims.
		const resources = input.allocated + netUpnl
		let remainingCva = 0n
		let remainingClaims = 0n
		for (const solver of buckets) {
			remainingCva += solver.cva
			if (solver.actualAmount < 0n) remainingClaims -= solver.actualAmount
		}
		let remainingPool = 0n
		let remainingDeficit = 0n
		if (resources >= 0n) {
			remainingPool = min(resources, remainingCva)
			plan.deferredDelta += resources - remainingPool
		} else {
			remainingDeficit = min(-resources, remainingClaims)
		}
		for (const solver of buckets) {
			const cva = solver.cva
			if (cva > 0n) {
				const share = remainingCva <= cva ? remainingPool : (cva * remainingPool) / remainingCva
				solver.cva = share
				remainingPool -= share
				remainingCva -= cva
			}
			const actual = solver.actualAmount
			if (actual < 0n && remainingDeficit > 0n) {
				const claim = -actual
				const share = remainingClaims <= claim ? remainingDeficit : (claim * remainingDeficit) / remainingClaims
				solver.actualAmount = actual + share
				remainingDeficit -= share
				remainingClaims -= claim
			}
		}
	}
	return plan
}

/**
 * Settlement in the given batches/order. `allocationAtSettlement` is each solver's allocation just
 * before its bucket settles (CVA is credited first, then PnL). The plan is final after the last close,
 * so batches and order no longer change any amount.
 */
export function planSettlement(plan: LiquidationPlan, batches: string[][], allocationAtSettlement: Record<string, bigint>): SettlementPlan {
	const solvers: Record<string, SolverSettlement> = {}
	for (const batch of batches) {
		for (const partyB of batch) {
			const solver = plan.solvers[partyB]
			if (solver === undefined) throw new Error(`model: ${partyB} is not in settlement`)
			const actual = solver.actualAmount
			const capacity = (allocationAtSettlement[partyB] ?? 0n) + solver.cva
			solvers[partyB] = {
				partyB,
				settleAmount: actual,
				cva: solver.cva,
				delta: solver.cva - actual,
				cappedBy: actual > capacity ? actual - capacity : 0n,
			}
		}
	}
	return { solvers }
}

/**
 * Identity that must hold for every non-disputed plan regardless of implementation: the liquidated
 * allocation is exactly what leaves PartyA, and it is split between solvers (CVA minus what they
 * are owed), the liquidator fee and the insurance vault. A positive result is money created.
 */
export function planSurplus(plan: Pick<LiquidationPlan, "solvers" | "liquidationFee" | "vaultCredit">, allocated: bigint): bigint {
	let outflow = plan.liquidationFee + plan.vaultCredit
	for (const solver of Object.values(plan.solvers)) outflow += solver.cva - solver.actualAmount
	return outflow - allocated
}

export type KnownViolation = { code: string; maxAmount?: bigint }

/** `FUZZ_KNOWN_VIOLATIONS="PLAN_SUM<=8,CONSERVATION<=8,SOLVER_CAP"`: code, optional wei bound on |amount|. */
export function parseKnownViolations(value: string | undefined): KnownViolation[] {
	if (value === undefined || value.trim() === "") return []
	return value.split(",").map(entry => {
		const [code, bound] = entry.trim().split("<=")
		return bound === undefined ? { code } : { code, maxAmount: BigInt(bound) }
	})
}

export function isKnownViolation(violation: Violation, known: KnownViolation[]): boolean {
	const code = violation.code.split(":")[0]
	return known.some(entry => {
		if (entry.code !== code) return false
		if (entry.maxAmount === undefined) return true
		return violation.amount !== undefined && abs(violation.amount) <= entry.maxAmount
	})
}
