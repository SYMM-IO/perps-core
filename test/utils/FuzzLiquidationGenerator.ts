import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { ZeroAddress } from "ethers"

import { ethers } from "../helpers/hardhat-connection.js"
import { OrderType, PositionType, QuoteStatus } from "../models/Enums.js"
import { Hedger } from "../models/Hedger.js"
import type { RunContext } from "../models/RunContext.js"
import type { TestManager } from "../models/TestManager.js"
import { User } from "../models/User.js"
import { limitCloseRequestBuilder } from "../models/requestModels/CloseRequest.js"
import { limitOpenRequestBuilder } from "../models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp } from "./Common.js"
import { conservationOracle } from "./ConservationOracle.js"
import {
	type LiquidationPlan,
	type ModelQuote,
	ModelLiquidationType,
	ROUNDING_ALLOWANCE_PER_POSITION,
	type Violation,
	planLiquidation,
	planSettlement,
	planSurplus,
	truePnl,
} from "./LiquidationModel.js"
import { getDummyLiquidationSig, getDummySingleUpnlAndPriceSig, getDummySingleUpnlSig } from "./SignatureUtils.js"

/**
 * Seeded random PartyA liquidation against one to three solvers, checked against the reference
 * model in LiquidationModel.ts. Every seed is replayable; nothing here uses the global fuzz RNG.
 */

const ONE = 10n ** 18n
const SYMBOL_ID = 1n
const TRADING_FEE = 10n ** 16n // fixture symbol: 1%
const MIN_QUOTE_VALUE = 5n * ONE

class Rng {
	private state: number

	constructor(seed: string) {
		let state = 0x811c9dc5
		for (let index = 0; index < seed.length; index++) {
			state ^= seed.charCodeAt(index)
			state = Math.imul(state, 0x01000193)
		}
		this.state = state >>> 0 || 0x6d2b79f5
	}

	float(): number {
		this.state = (this.state + 0x6d2b79f5) >>> 0
		let value = this.state
		value = Math.imul(value ^ (value >>> 15), value | 1)
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
		return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000
	}

	int(exclusiveMax: number): number {
		return Math.floor(this.float() * exclusiveMax)
	}

	chance(probability: number): boolean {
		return this.float() < probability
	}

	/** Uniform-ish bigint in [min, max). */
	big(max: bigint, min = 0n): bigint {
		if (max <= min) return min
		let bits = 0n
		for (let round = 0; round < 4; round++) bits = (bits << 26n) | BigInt(Math.floor(this.float() * 0x400_0000))
		return min + (bits % (max - min))
	}

	pick<T>(items: readonly T[]): T {
		return items[this.int(items.length)]
	}

	shuffle<T>(items: readonly T[]): T[] {
		const result = [...items]
		for (let index = result.length - 1; index > 0; index--) {
			const swap = this.int(index + 1)
			;[result[index], result[swap]] = [result[swap], result[index]]
		}
		return result
	}
}

type Leg = {
	solver: number
	side: PositionType
	quantity: bigint
	price: bigint
	cva: bigint
	lf: bigint
	partyAmm: bigint
	partyBmm: bigint
	partialOpen: boolean
}

type Band = "NORMAL" | "LATE" | "OVERDUE"
type Flow = "legacy" | "deferred" | "snapshot"
type Shape = "ample" | "exact" | "between" | "minus-wei" | "short"

export type RandomLiquidationOptions = {
	seed: string
	/** Campaign hook: exact conservation check after each on-chain step. */
	check?: (step: string) => Promise<void>
	/** Standalone only: randomly configure the liquidator fee cap (global config). */
	configureLfCap?: boolean
}

export type RandomLiquidationResult = {
	seed: string
	legs: string
	band: Band
	flow: Flow
	shapes: string
	type: string
	disputed: boolean
	skipped?: string
	violations: Violation[]
}

function typeName(type: ModelLiquidationType | bigint): string {
	return ModelLiquidationType[Number(type)] ?? String(type)
}

function pct(rng: Rng, from: number, to: number): bigint {
	return BigInt(from + rng.int(to - from + 1))
}

/** The symbol's minimum quote value applies to PartyA's locked values (cva + lf + partyAmm), per quote and per partial fill. */
const MIN_LOCKED_VALUE = MIN_QUOTE_VALUE * 2n

function withMinimumLocked(leg: Leg): Leg {
	const total = leg.cva + leg.lf + leg.partyAmm
	const bumped = total >= MIN_LOCKED_VALUE ? leg : { ...leg, partyAmm: leg.partyAmm + (MIN_LOCKED_VALUE - total) }
	// LF must stay at least 1% of PartyA's locked total (symbol minAcceptablePortionLF).
	const minimumLf = ((bumped.cva + bumped.lf + bumped.partyAmm) * 2n) / 100n
	return bumped.lf >= minimumLf ? bumped : { ...bumped, lf: minimumLf }
}

function generateLegs(rng: Rng, solverCount: number): Leg[] {
	const legs: Leg[] = []
	const count = 1 + rng.int(5)
	for (let index = 0; index < count; index++) {
		const units = 11n + rng.big(190n)
		const quantity = units * ONE + (rng.chance(0.3) ? rng.big(ONE) : 0n)
		const price = rng.chance(0.5) ? ONE : rng.big(2n * ONE, ONE / 2n)
		const notional = (quantity * price) / ONE
		legs.push(
			withMinimumLocked({
				solver: rng.int(solverCount),
				side: rng.chance(0.5) ? PositionType.SHORT : PositionType.LONG,
				quantity,
				price,
				cva: (notional * pct(rng, 5, 30)) / 100n,
				lf: (notional * pct(rng, 15, 50)) / 1000n,
				partyAmm: (notional * pct(rng, 20, 80)) / 100n,
				partyBmm: (notional * pct(rng, 10, 50)) / 100n,
				partialOpen: rng.chance(0.2),
			}),
		)
	}
	// Mixed books (one solver long and short against the same trader) are where OVERDUE haircuts
	// and the close-time dispute check disagree; make sure they are generated often.
	if (rng.chance(0.4)) {
		const base = rng.pick(legs)
		const notional = (base.quantity * base.price) / ONE
		const candidate = (base.quantity * pct(rng, 20, 90)) / 100n + (rng.chance(0.3) ? rng.big(ONE) : 0n)
		legs.push(
			withMinimumLocked({
				...base,
				side: base.side === PositionType.LONG ? PositionType.SHORT : PositionType.LONG,
				quantity: candidate < ONE ? ONE : candidate,
				cva: (notional * pct(rng, 5, 30)) / 100n,
				partialOpen: false,
			}),
		)
	}
	return legs
}

function netExposure(legs: Leg[]): { k: bigint; m: bigint } {
	let k = 0n
	let m = 0n
	for (const leg of legs) {
		const sign = leg.side === PositionType.LONG ? 1n : -1n
		k += sign * leg.quantity
		m += sign * leg.quantity * leg.price
	}
	return { k, m }
}

function describeLegs(legs: Leg[]): string {
	return legs.map(leg => `${leg.side === PositionType.SHORT ? "S" : "L"}${leg.quantity / ONE}@${leg.solver}${leg.partialOpen ? "p" : ""}`).join(" ")
}

async function ensureSolver(context: RunContext, signer: HardhatEthersSigner): Promise<Hedger> {
	const hedger = new Hedger(context, signer)
	await hedger.setup()
	if (!(await context.viewFacet.isPartyB(hedger.address))) {
		await context.controlFacet.connect(context.signers.admin).registerPartyB(hedger.address)
		await context.symbolControlFacet.connect(context.signers.admin).whitelistSymbolType(hedger.address, SYMBOL_ID)
	}
	return hedger
}

async function fund(context: RunContext, signer: HardhatEthersSigner, amount: bigint): Promise<void> {
	await context.collateral.mint(signer.address, amount)
	await context.collateral.connect(signer).approve(context.diamond, amount)
	await context.accountFacet.connect(signer).deposit(amount)
}

const LOCKED_FIELDS = ["cva", "lf", "partyAmm", "partyBmm"] as const

/** Structural invariant: aggregate locked balances equal the sum over the quotes that lock them. */
async function lockedSums(context: RunContext, partyA: string, solvers: Hedger[], label: string): Promise<Violation[]> {
	const violations: Violation[] = []
	const open = await context.viewFacetQuote.getPartyAOpenPositions(partyA, 0, 100)
	const pendingIds = await context.viewFacetQuote.getPartyAPendingQuotes(partyA)
	const pending = await Promise.all(pendingIds.map(id => context.viewFacetQuote.getQuote(id)))
	const sum = (quotes: typeof open, field: (typeof LOCKED_FIELDS)[number]) => quotes.reduce((total, q) => total + q.lockedValues[field], 0n)
	const compare = (who: string, info: readonly bigint[], openQuotes: typeof open, pendingQuotes: typeof open) => {
		for (const [index, field] of LOCKED_FIELDS.entries()) {
			const expectedOpen = sum(openQuotes, field)
			const expectedPending = sum(pendingQuotes, field)
			if (info[1 + index] !== expectedOpen)
				violations.push({
					code: "LOCKED_SUM",
					detail: `${label}: ${who} locked ${field} ${info[1 + index]} != open positions ${expectedOpen}`,
					amount: info[1 + index] - expectedOpen,
				})
			if (info[5 + index] !== expectedPending)
				violations.push({
					code: "LOCKED_SUM",
					detail: `${label}: ${who} pending ${field} ${info[5 + index]} != pending quotes ${expectedPending}`,
					amount: info[5 + index] - expectedPending,
				})
		}
	}
	compare("partyA", await context.viewFacet.balanceInfoOfPartyA(partyA), open, pending)
	for (const solver of solvers) {
		const mine = (quotes: typeof open) => quotes.filter(q => q.partyB.toLowerCase() === solver.address.toLowerCase())
		compare(`solver ${solver.address}`, await context.viewFacet.balanceInfoOfPartyB(solver.address, partyA), mine(open), mine(pending))
	}
	return violations
}

function revertMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error)
	const match = message.match(/reverted with reason string '([^']*)'/) ?? message.match(/reason="([^"]*)"/)
	return match ? match[1] : message.slice(0, 200)
}

export async function runRandomLiquidation(
	context: RunContext,
	manager: TestManager,
	options: RandomLiquidationOptions,
): Promise<RandomLiquidationResult> {
	const rng = new Rng(options.seed)
	const violations: Violation[] = []
	const result: RandomLiquidationResult = {
		seed: options.seed,
		legs: "",
		band: "OVERDUE",
		flow: "legacy",
		shapes: "",
		type: "NONE",
		disputed: false,
		violations,
	}
	const fail = (code: string, detail: string, amount?: bigint) => violations.push({ code, detail, amount })
	const expectEqual = (code: string, label: string, actual: bigint, expected: bigint) => {
		if (actual !== expected) fail(code, `${label}: chain ${actual} model ${expected}`, actual - expected)
	}

	const partyAAddress = ethers.getAddress("0x" + ethers.keccak256(ethers.toUtf8Bytes(`${options.seed}:partyA`)).slice(-40))
	const extraSolverAddress = ethers.getAddress("0x" + ethers.keccak256(ethers.toUtf8Bytes(`${options.seed}:solver`)).slice(-40))
	const tracked = {
		partyAs: [partyAAddress, ...manager.users.keys()],
		partyBs: [extraSolverAddress, context.signers.hedger.address, context.signers.hedger2.address, ...manager.hedgers.keys()],
	}
	const firstQuoteId = await context.viewFacetQuote.getNextQuoteId()
	// Standalone mode: exact conservation after every step, attributed to the step that moved it.
	// Campaign mode checks through `options.check` (baseline-relative, from the TestManager).
	const measure = async () => {
		const lastQuoteId = await context.viewFacetQuote.getNextQuoteId()
		const quoteIds = Array.from({ length: Number(lastQuoteId - firstQuoteId) + 1 }, (_, i) => firstQuoteId + BigInt(i))
		return (await conservationOracle(context, { ...tracked, quoteIds })).diff
	}
	let lastDiff = options.check ? 0n : await measure()
	const check =
		options.check ??
		(async (step: string) => {
			const diff = await measure()
			if (diff !== lastDiff) fail("CONSERVATION", `${step}: ledger minus tokens moved by ${diff - lastDiff} (now ${diff})`, diff - lastDiff)
			lastDiff = diff
		})

	if (options.configureLfCap) {
		const [vault] = await context.viewFacet.getLiquidationInsuranceVaultParams()
		const vaultAddress = vault === ZeroAddress ? context.signers.others[1].address : vault
		await context.controlFacet
			.connect(context.signers.admin)
			.setLiquidationInsuranceVaultParams(vaultAddress, rng.chance(0.5) ? 0n : rng.big(decimal(5n)))
	}

	// Actors
	const solverCount = 1 + rng.int(3)
	const extraSigner = await ethers.getImpersonatedSigner(extraSolverAddress)
	const signers = rng.shuffle([context.signers.hedger, context.signers.hedger2, extraSigner]).slice(0, solverCount)
	const solvers: Hedger[] = []
	for (const signer of signers) {
		if (signer.address === extraSolverAddress) await ethers.provider.send("hardhat_setBalance", [extraSolverAddress, "0x56BC75E2D63100000"])
		solvers.push(await ensureSolver(context, signer))
	}
	const user = new User(context, await ethers.getImpersonatedSigner(partyAAddress))
	await user.setup()
	await user.setNativeBalance(decimal(100n))

	// Legs and PartyA funding
	let legs = generateLegs(rng, solverCount)
	const band: Band = rng.pick(["NORMAL", "LATE", "OVERDUE", "OVERDUE"])
	result.band = band
	let lockedA = 0n
	let fees = 0n
	for (const leg of legs) {
		lockedA += leg.cva + leg.lf + leg.partyAmm
		fees += (leg.quantity * leg.price * TRADING_FEE) / ONE / ONE
	}
	// An extra pending (sometimes locked) quote that is liquidated with the account; funded up front.
	const pendingUnits = rng.chance(0.3) ? 11n + rng.big(20n) : 0n
	const pendingLocked = pendingUnits * ONE // cva 22% + lf 3% + partyAmm 75% of a price-1 notional
	const pendingFee = (pendingUnits * ONE * TRADING_FEE) / ONE
	const allocation =
		lockedA + fees + pendingLocked + pendingFee + (rng.chance(0.2) ? 1n + rng.big(ONE) : (lockedA * pct(rng, 0, 200)) / 100n + rng.big(ONE))
	{
		// A net-long book can only lose its notional; flip every side when the chosen band is unreachable.
		const { k, m } = netExposure(legs)
		const last = legs[legs.length - 1]
		if (k === 0n) last.side = last.side === PositionType.LONG ? PositionType.SHORT : PositionType.LONG
		else if (k > 0n && m / ONE <= allocation + lockedA)
			legs = legs.map(leg => ({ ...leg, side: leg.side === PositionType.LONG ? PositionType.SHORT : PositionType.LONG }))
	}
	result.legs = describeLegs(legs)
	const lateAllocation = decimal(1n) + rng.big(decimal(50n))
	await user.setBalances(allocation + lateAllocation, allocation, allocation)
	await check("fund-partyA")

	// Solver funding: ample first; allocation shapes are applied once the book is open.
	for (const [index, solver] of solvers.entries()) {
		let lockedB = 0n
		let notional = 0n
		for (const leg of legs) {
			if (leg.solver !== index) continue
			lockedB += leg.cva + leg.lf + leg.partyBmm
			notional += (leg.quantity * leg.price) / ONE
		}
		const amount = lockedB * 3n + allocation * 6n + notional + decimal(100n)
		await fund(context, solver.signer, amount)
		await context.partyBAccountFacet.connect(solver.signer).allocateForPartyB(amount, partyAAddress)
		await check(`fund-solver-${index}`)
	}

	// Open the book
	const openedIds: bigint[] = []
	for (const [index, leg] of legs.entries()) {
		const solver = solvers[leg.solver]
		const id = await user.sendQuote(
			limitQuoteRequestBuilder()
				.partyBWhiteList([solver.address])
				.positionType(leg.side)
				.orderType(OrderType.LIMIT)
				.price(leg.price)
				.quantity(leg.quantity)
				.cva(leg.cva)
				.lf(leg.lf)
				.partyAmm(leg.partyAmm)
				.partyBmm(leg.partyBmm)
				.deadline((await getBlockTimestamp()) + 100_000n)
				.upnlSig(getDummySingleUpnlAndPriceSig(leg.price))
				.build(),
		)
		await check(`send-${index}`)
		await solver.lockQuote(id, 0n, null)
		await check(`lock-${index}`)
		let filled = leg.quantity
		if (leg.partialOpen) {
			// Both the filled part and the remainder quote must keep locked values above the symbol minimum.
			const candidate = (leg.quantity * pct(rng, 50, 90)) / 100n
			const locked = leg.cva + leg.lf + leg.partyAmm
			const margin = MIN_QUOTE_VALUE + 10n ** 15n // per-field floors in the contract's proportional split
			if ((locked * candidate) / leg.quantity >= margin && (locked * (leg.quantity - candidate)) / leg.quantity >= margin) filled = candidate
		}
		await solver.openPosition(id, limitOpenRequestBuilder().filledAmount(filled).openPrice(leg.price).price(leg.price).build())
		await check(`open-${index}`)
		openedIds.push(id)
	}

	// Optional partial close at the open price (zero PnL, scaled locked values)
	if (rng.chance(0.25)) {
		const index = rng.int(legs.length)
		const quote = await context.viewFacetQuote.getQuote(openedIds[index])
		const open = quote.quantity - quote.closedAmount
		const amount = (open * pct(rng, 10, 50)) / 100n
		const locked = quote.lockedValues.cva + quote.lockedValues.lf + quote.lockedValues.partyAmm
		if (((open - amount) * locked) / open >= MIN_QUOTE_VALUE + 10n ** 15n) {
			await user.requestToClosePosition(
				quote.id,
				limitCloseRequestBuilder()
					.quantityToClose(amount)
					.closePrice(quote.openedPrice)
					.price(quote.openedPrice)
					.upnl(0n)
					.orderType(OrderType.LIMIT)
					.deadline((await getBlockTimestamp()) + 10_000n)
					.build(),
			)
			await check("partial-close-request")
			await solvers[legs[index].solver].fillCloseRequest(quote.id, {
				filledAmount: amount,
				closedPrice: quote.openedPrice,
				price: quote.openedPrice,
				upnlPartyA: 0n,
				upnlPartyB: 0n,
			})
			await check("partial-close-fill")
			result.legs += " close"
		}
	}

	// Optional pending / locked quote that gets liquidated with the account
	if (pendingUnits > 0n) {
		const solver = rng.pick(solvers)
		const units = pendingUnits
		const id = await user.sendQuote(
			limitQuoteRequestBuilder()
				.partyBWhiteList([solver.address])
				.quantity(units * ONE)
				.cva((units * ONE * 22n) / 100n)
				.lf((units * ONE * 3n) / 100n)
				.partyAmm((units * ONE * 75n) / 100n)
				.partyBmm((units * ONE * 40n) / 100n)
				.deadline((await getBlockTimestamp()) + 100_000n)
				.build(),
		)
		await check("pending-quote")
		result.legs += " pending"
		if (rng.chance(0.5)) {
			await solver.lockQuote(id, 0n, null)
			await check("locked-quote")
			result.legs += "+locked"
		}
	}

	// Snapshot of the book the model works from
	violations.push(...(await lockedSums(context, partyAAddress, solvers, "pre-liquidation")))
	const positions = await context.viewFacetQuote.getPartyAOpenPositions(partyAAddress, 0, 100)
	const quoteIds = positions.map(q => q.id)
	if ((await context.viewFacetQuote.getSumQuoteFundingDebts(quoteIds)) !== 0n) {
		result.skipped = "funding active on fresh quotes"
		return result
	}
	const quotes: ModelQuote[] = positions.map(q => ({
		id: q.id,
		partyB: q.partyB.toLowerCase(),
		side: Number(q.positionType) as PositionType,
		openedPrice: q.openedPrice,
		openAmount: q.quantity - q.closedAmount,
		cva: q.lockedValues.cva,
		fundingFee: 0n,
	}))
	const balanceA = await context.viewFacet.balanceInfoOfPartyA(partyAAddress)
	const allocated = balanceA[0]
	const lockedCva = balanceA[1]
	const lockedLf = balanceA[2]
	const positionsCount = await context.viewFacetQuote.partyAPositionsCount(partyAAddress)
	const [vault, maxLiquidationProfitPerPosition] = await context.viewFacet.getLiquidationInsuranceVaultParams()
	const vaultBefore = await context.viewFacet.balanceOf(vault)
	const liquidator = context.signers.liquidator.address
	const liquidatorBefore = await context.viewFacet.allocatedBalanceOfPartyA(liquidator)

	// Price: pick a shortfall in the chosen band and solve the (piecewise linear) uPNL for it.
	const lfAndCva = lockedLf + lockedCva
	let shortfall: bigint
	if (band === "NORMAL") shortfall = 1n + rng.big(lockedLf > 1n ? lockedLf - 1n : 1n)
	else if (band === "LATE") shortfall = lockedLf + rng.big(lockedCva + 1n)
	else shortfall = lfAndCva + 1n + rng.big((allocated * pct(rng, 5, 300)) / 100n + ONE)
	const targetUpnl = lfAndCva - allocated - shortfall
	let k = 0n
	let m = 0n
	for (const quote of quotes) {
		const sign = quote.side === PositionType.LONG ? 1n : -1n
		k += sign * quote.openAmount
		m += sign * quote.openAmount * quote.openedPrice
	}
	if (k === 0n) {
		result.skipped = "flat book after partial fills"
		return result
	}
	let price = (targetUpnl * ONE + m) / k
	if (price < 1n) price = 1n
	let pnl = truePnl(quotes, price)
	for (let attempt = 0; attempt < 16 && allocated - lfAndCva + pnl.upnl >= 0n; attempt++) {
		price = k > 0n ? (price > 1n ? price - 1n : 1n) : price + 1n
		pnl = truePnl(quotes, price)
	}
	if (allocated - lfAndCva + pnl.upnl >= 0n) {
		result.skipped = `account stays solvent at price ${price}`
		return result
	}

	// Solver allocation shapes relative to the model's own plan at ample allocation
	const ampleAllocation: Record<string, bigint> = {}
	for (const solver of solvers)
		ampleAllocation[solver.address.toLowerCase()] = await context.viewFacet.allocatedBalanceOfPartyB(solver.address, partyAAddress)
	const baseInput = {
		allocated,
		lockedCva,
		lockedLf,
		positionsCount,
		maxLiquidationProfitPerPosition,
		quotes,
		price,
		signedUpnl: pnl.upnl,
		signedTotalUnrealizedLoss: pnl.totalUnrealizedLoss,
	}
	const amplePlan = planLiquidation({ ...baseInput, allocationAtClose: ampleAllocation })
	const shapes: string[] = []
	const allocationAtClose: Record<string, bigint> = {}
	for (const [index, solver] of solvers.entries()) {
		const key = solver.address.toLowerCase()
		const plan = amplePlan.solvers[key]
		const b = await context.viewFacet.balanceInfoOfPartyB(solver.address, partyAAddress)
		const minimum = b[1] + b[2] + b[4] + b[5] + b[6] + b[8]
		let shape: Shape = "ample"
		let target = ampleAllocation[key]
		if (plan !== undefined && plan.expectedAmount > 0n) {
			shape = rng.pick<Shape>(["ample", "ample", "exact", "between", "between", "minus-wei", "short"])
			if (shape === "exact") target = plan.expectedAmount
			else if (shape === "between")
				target =
					plan.actualAmount > plan.expectedAmount ? plan.expectedAmount + rng.big(plan.actualAmount - plan.expectedAmount + 1n) : plan.expectedAmount
			else if (shape === "minus-wei") target = plan.expectedAmount - (1n + rng.big(ROUNDING_ALLOWANCE_PER_POSITION * positionsCount))
			else if (shape === "short") target = plan.expectedAmount / 2n
		}
		if (target < minimum) target = minimum
		if (target < ampleAllocation[key]) {
			await context.partyBAccountFacet
				.connect(solver.signer)
				.deallocateForPartyB(ampleAllocation[key] - target, partyAAddress, await getDummySingleUpnlSig(0n))
			await check(`shape-${index}`)
		}
		allocationAtClose[key] = await context.viewFacet.allocatedBalanceOfPartyB(solver.address, partyAAddress)
		shapes.push(plan === undefined ? "none" : shape)
	}
	result.shapes = shapes.join(",")

	// Signed oracle values, sometimes perturbed inside or beyond the rounding allowance
	const allowance = ROUNDING_ALLOWANCE_PER_POSITION * positionsCount
	let signedUpnl = pnl.upnl
	const perturbation = rng.float()
	if (perturbation < 0.2) signedUpnl += (rng.chance(0.5) ? 1n : -1n) * (1n + rng.big(allowance))
	else if (perturbation < 0.3) signedUpnl += (rng.chance(0.5) ? 1n : -1n) * (allowance + 1n + rng.big(1000n))
	let signedTotalUnrealizedLoss = pnl.totalUnrealizedLoss
	if (rng.chance(0.15) && signedTotalUnrealizedLoss < -3n) signedTotalUnrealizedLoss += (rng.chance(0.5) ? 1n : -1n) * (1n + rng.big(3n))
	let plan = planLiquidation({ ...baseInput, signedUpnl, signedTotalUnrealizedLoss, allocationAtClose })
	if (plan.solvent) {
		result.skipped = "solvent after signed perturbation"
		return result
	}
	result.type = typeName(plan.type)
	result.disputed = plan.disputed

	// Start the liquidation through one of the three entry flows
	const flow: Flow = rng.pick<Flow>(["legacy", "legacy", "legacy", "legacy", "deferred", "snapshot"])
	result.flow = flow
	const sig = await getDummyLiquidationSig("0x10", signedUpnl, [SYMBOL_ID], [price], signedTotalUnrealizedLoss, allocated)
	const facet = context.partyALiquidationFacet.connect(context.signers.liquidator)
	let expectedDeferred = 0n
	try {
		if (flow === "snapshot") {
			const snapshotFacet = context.partyALiquidationSnapshotFacet.connect(context.signers.liquidator)
			const states = solvers.map(s => ({ partyB: s.address, symbolId: SYMBOL_ID, price, cumulativeLongFee: 0n, cumulativeShortFee: 0n }))
			await snapshotFacet.liquidatePartyAWithSnapshot(partyAAddress, { ...sig, states: [] })
			await check("start")
			await snapshotFacet.setSymbolsPriceWithSnapshot(partyAAddress, { ...sig, states })
		} else if (flow === "deferred") {
			await context.accountFacet.connect(user.signer).deposit(lateAllocation)
			await context.accountFacet.connect(user.signer).allocate(lateAllocation)
			expectedDeferred = lateAllocation
			await check("late-allocation")
			await facet.deferredLiquidatePartyA(partyAAddress, sig)
			await check("start")
			await facet.deferredSetSymbolsPrice(partyAAddress, sig)
		} else {
			await facet.liquidatePartyA(partyAAddress, sig)
			await check("start")
			await facet.setSymbolsPrice(partyAAddress, sig)
		}
	} catch (error) {
		fail("REVERT", `liquidation start (${flow}): ${revertMessage(error)}`)
		return result
	}
	await check("prices")
	const started = await context.viewFacet.getLiquidatedStateOfPartyA(partyAAddress)
	expectEqual("TYPE", "liquidation type", started.liquidationType, BigInt(plan.type))
	expectEqual("DEFICIT", "deficit", started.deficit, plan.deficit)
	expectEqual("LF", "liquidation fee", started.liquidationFee, plan.liquidationFee)
	expectEqual("DEFERRED", "deferred balance", await context.viewFacet.getPartyADeferredBalance(partyAAddress), expectedDeferred)
	expectEqual("VAULT", "insurance vault credit at start", (await context.viewFacet.balanceOf(vault)) - vaultBefore, plan.vaultCredit)
	if (started.liquidationType !== BigInt(plan.type)) return result

	// Pending quotes, then positions in random order and batches
	try {
		await facet.liquidatePendingPositionsPartyA(partyAAddress)
	} catch (error) {
		fail("REVERT", `liquidatePendingPositionsPartyA: ${revertMessage(error)}`)
		return result
	}
	await check("pending")
	const reimbursement = await context.viewFacet.partyAReimbursement(partyAAddress)
	const closeOrder = rng.shuffle(quoteIds)
	const closeBatches = rng.chance(0.3) && closeOrder.length > 1 ? [closeOrder.slice(0, 1), closeOrder.slice(1)] : [closeOrder]
	// The plan step walks the buckets in open order with running remainders, so the per-solver amounts are
	// only final once the close order is drawn; type, deficit and fee at start are order-independent.
	plan = planLiquidation({ ...baseInput, signedUpnl, signedTotalUnrealizedLoss, allocationAtClose, closeOrder, deferredBalance: expectedDeferred })
	try {
		for (const batch of closeBatches) await facet.liquidatePositionsPartyA(partyAAddress, batch)
	} catch (error) {
		fail("REVERT", `liquidatePositionsPartyA: ${revertMessage(error)}`)
		return result
	}
	await check("positions")
	const closed = await context.viewFacet.getLiquidatedStateOfPartyA(partyAAddress)
	if (closed.disputed !== plan.disputed)
		fail(
			"DISPUTE",
			`chain disputed=${closed.disputed} model disputed=${plan.disputed} (accumulated ${closed.partyAAccumulatedUpnl}, signed ${signedUpnl}, allowance ${allowance})`,
		)
	result.disputed = closed.disputed
	if (!closed.disputed) expectEqual("ACCUMULATED", "accumulated uPNL", closed.partyAAccumulatedUpnl, plan.accumulatedUpnl)
	const solverAddresses = solvers.map(s => s.address)
	const states = await context.viewFacet.getSettlementStates(partyAAddress, solverAddresses)
	const chainPlan: LiquidationPlan["solvers"] = {}
	for (const [index, solver] of solvers.entries()) {
		const key = solver.address.toLowerCase()
		const expected = plan.solvers[key]
		const state = states[index]
		if (expected === undefined) {
			if (state.pending) fail(`STATE:${index}`, `${solver.address} is pending settlement but has no positions in the model`)
			continue
		}
		chainPlan[key] = { partyB: key, expectedAmount: state.expectedAmount, actualAmount: state.actualAmount, cva: state.cva }
		if (!state.pending) fail(`STATE:${index}`, `${solver.address} is not pending settlement`)
		expectEqual(`STATE:${index}`, `${solver.address} expectedAmount`, state.expectedAmount, expected.expectedAmount)
		expectEqual(`STATE:${index}`, `${solver.address} actualAmount`, state.actualAmount, expected.actualAmount)
		expectEqual(`STATE:${index}`, `${solver.address} cva`, state.cva, expected.cva)
	}
	expectEqual(
		"DEFERRED_PLAN",
		"deferred balance after the plan step",
		await context.viewFacet.getPartyADeferredBalance(partyAAddress),
		expectedDeferred + plan.deferredDelta,
	)
	if (!closed.disputed) {
		expectEqual("LF_FINAL", "liquidator fee after the plan step", closed.liquidationFee, plan.liquidationFee)
		// The stored plan is final after the last close: the buckets, the fee and vault credit, and what PartyA
		// gets back through its deferred balance must add up to exactly the liquidated allocation.
		const surplus =
			planSurplus({ solvers: chainPlan, liquidationFee: closed.liquidationFee, vaultCredit: plan.vaultCredit - plan.vaultRecovered }, allocated) +
			plan.deferredDelta
		if (surplus !== 0n)
			fail(
				"PLAN_SUM",
				`settlement plan pays out ${surplus} wei more than the liquidated allocation ${allocated} (deferred delta ${plan.deferredDelta}, fee ${closed.liquidationFee}, vault recovered ${plan.vaultRecovered})`,
				surplus,
			)
	}

	const involved = solverAddresses.filter(address => plan.solvers[address.toLowerCase()] !== undefined)
	if (closed.disputed) {
		try {
			await facet.settlePartyALiquidation(partyAAddress, involved)
			fail("SETTLED_WHILE_DISPUTED", "settlePartyALiquidation succeeded on a disputed liquidation")
		} catch {
			// expected: a disputed liquidation cannot settle
		}
	} else {
		const order = rng.shuffle(involved)
		const batchCount = 1 + rng.int(order.length)
		const batches: string[][] = []
		for (let index = 0; index < order.length; index++) (batches[index % batchCount] ??= []).push(order[index])
		const allocationAtSettlement: Record<string, bigint> = {}
		for (const solver of solvers)
			allocationAtSettlement[solver.address.toLowerCase()] = await context.viewFacet.allocatedBalanceOfPartyB(solver.address, partyAAddress)
		const settlement = planSettlement(
			plan,
			batches.map(batch => batch.map(a => a.toLowerCase())),
			allocationAtSettlement,
		)
		try {
			// Solver buckets are paid per batch while PartyA's allocation is debited only at
			// finalization, so the ledger is exact again only after the last batch.
			for (const [index, batch] of batches.entries()) {
				await facet.settlePartyALiquidation(partyAAddress, batch)
				if (index === batches.length - 1) await check("settle")
			}
		} catch (error) {
			fail("REVERT", `settlePartyALiquidation: ${revertMessage(error)}`)
			return result
		}
		for (const [index, solver] of solvers.entries()) {
			const key = solver.address.toLowerCase()
			const planned = settlement.solvers[key]
			if (planned === undefined) continue
			const after = await context.viewFacet.allocatedBalanceOfPartyB(solver.address, partyAAddress)
			expectEqual(`SOLVER_DELTA:${index}`, `${solver.address} allocation change`, after - allocationAtSettlement[key], planned.delta)
			if (planned.cappedBy > 0n)
				fail(
					`SOLVER_CAP:${index}`,
					`${solver.address} owed ${planned.settleAmount + planned.cappedBy} but paid ${planned.settleAmount} without a dispute`,
					planned.cappedBy,
				)
		}
		const expectedFinal = expectedDeferred + plan.deferredDelta + (plan.type === ModelLiquidationType.NORMAL ? reimbursement : 0n)
		expectEqual("PARTYA_FINAL", "partyA allocation after settlement", await context.viewFacet.allocatedBalanceOfPartyA(partyAAddress), expectedFinal)
		expectEqual(
			"ESCROW",
			"liquidation escrow",
			await context.viewFacet.getLiquidationEscrow(partyAAddress),
			plan.type === ModelLiquidationType.NORMAL ? 0n : reimbursement,
		)
		expectEqual(
			"LIQUIDATOR_LF",
			"liquidator fee",
			(await context.viewFacet.allocatedBalanceOfPartyA(liquidator)) - liquidatorBefore,
			plan.liquidationFee,
		)
		expectEqual("VAULT", "insurance vault credit", (await context.viewFacet.balanceOf(vault)) - vaultBefore, plan.vaultCredit - plan.vaultRecovered)
		if (await context.viewFacet.isPartyALiquidated(partyAAddress))
			fail("LIQUIDATION_OPEN", "partyA still flagged as liquidated after full settlement")
		violations.push(...(await lockedSums(context, partyAAddress, solvers, "post-settlement")))
		for (const id of quoteIds) {
			const status = (await context.viewFacetQuote.getQuote(id)).quoteStatus
			if (status !== BigInt(QuoteStatus.LIQUIDATED)) fail("QUOTE_STATUS", `quote ${id} is ${QuoteStatus[Number(status)]} after settlement`)
		}
	}

	await check("final")
	return result
}

export function describeResult(result: RandomLiquidationResult): string {
	const outcome = result.skipped ? `skipped: ${result.skipped}` : result.violations.length === 0 ? "ok" : result.violations.map(v => v.code).join(" ")
	return `${result.seed} | ${result.band.padEnd(7)} ${result.flow.padEnd(8)} ${result.type.padEnd(7)} ${result.disputed ? "disputed" : "settled "} | ${result.legs} | shapes ${result.shapes} | ${outcome}`
}
