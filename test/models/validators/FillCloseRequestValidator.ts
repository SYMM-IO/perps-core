import { expect } from "chai"

import type { QuoteStructOutput } from "../../../src/types/interfaces/ISymmio.js"
import { unDecimal } from "../../utils/Common.js"
import { logger } from "../../utils/LoggerUtils.js"
import { OrderType, PositionType, QuoteStatus } from "../Enums.js"
import { Hedger } from "../Hedger.js"
import { RunContext } from "../RunContext.js"
import { BalanceInfo, User } from "../User.js"
import { getAllOpenPositions } from "./OpenPositionPagination.js"
import { TransactionValidator } from "./TransactionValidator.js"

export type FillCloseRequestValidatorBeforeArg = {
	user: User
	quoteId: bigint
	hedger: Hedger
}

export type FillCloseRequestValidatorBeforeOutput = {
	balanceInfoPartyA: BalanceInfo
	balanceInfoPartyB: BalanceInfo
	quote: QuoteStructOutput
	partyAPositionsCount: bigint
	partyBPositionsCount: bigint
	partyAOpenPositionCount: bigint
	partyBOpenPositionCount: bigint
	partyBPendingQuoteCount: bigint
	connectedPartyBs: string[]
	partyANonce: bigint
	partyBNonce: bigint
	isCrossPartyB: boolean
}

export type FillCloseRequestValidatorAfterArg = {
	user: User
	hedger: Hedger
	quoteId: bigint
	closePrice: bigint
	fillAmount: bigint
	beforeOutput: FillCloseRequestValidatorBeforeOutput
}

export type LockedValuesLike = {
	cva: bigint
	lf: bigint
	partyAmm: bigint
	partyBmm: bigint
}

export function calculateReleasedLockedValues(
	lockedValues: LockedValuesLike,
	fillAmount: bigint,
	openAmount: bigint,
): LockedValuesLike & { partyA: bigint; partyB: bigint } {
	if (openAmount <= 0n) throw new RangeError("Open amount must be greater than zero")
	if (fillAmount <= 0n || fillAmount > openAmount) {
		throw new RangeError("Fill amount must be greater than zero and at most the open amount")
	}

	const releasedCva = (lockedValues.cva * fillAmount) / openAmount
	const releasedLf = (lockedValues.lf * fillAmount) / openAmount
	const releasedPartyAmm = (lockedValues.partyAmm * fillAmount) / openAmount
	const releasedPartyBmm = (lockedValues.partyBmm * fillAmount) / openAmount

	return {
		cva: releasedCva,
		lf: releasedLf,
		partyAmm: releasedPartyAmm,
		partyBmm: releasedPartyBmm,
		partyA: releasedCva + releasedLf + releasedPartyAmm,
		partyB: releasedCva + releasedLf + releasedPartyBmm,
	}
}

export function calculateCloseFee(fillAmount: bigint, closePrice: bigint, closeFee: bigint): bigint {
	return (fillAmount * closePrice * closeFee) / 10n ** 36n
}

export function shouldKeepPartyBConnection(openPositionCount: bigint, pendingQuoteCount: bigint): boolean {
	return openPositionCount > 0n || pendingQuoteCount > 0n
}

export class FillCloseRequestValidator implements TransactionValidator {
	async before(context: RunContext, arg: FillCloseRequestValidatorBeforeArg): Promise<FillCloseRequestValidatorBeforeOutput> {
		logger.debug("Before FillCloseRequestValidator...")
		const [userAddress, hedgerAddress] = await Promise.all([arg.user.getAddress(), arg.hedger.getAddress()])
		const isCrossPartyBPromise = context.viewFacet.isCrossPartyB(hedgerAddress)
		const balanceInfoPartyBPromise = isCrossPartyBPromise.then(isCrossPartyB =>
			isCrossPartyB ? arg.hedger.getBalanceInfoCrossPartyB() : arg.hedger.getBalanceInfo(userAddress),
		)
		const [
			balanceInfoPartyA,
			balanceInfoPartyB,
			quote,
			partyAPositionsCount,
			partyBPositionsCount,
			partyAOpenPositions,
			partyBOpenPositions,
			partyBPendingQuotes,
			connectedPartyBs,
			partyANonce,
			partyBNonce,
			isCrossPartyB,
		] = await Promise.all([
			arg.user.getBalanceInfo(),
			balanceInfoPartyBPromise,
			context.viewFacetQuote.getQuote(arg.quoteId),
			context.viewFacetQuote.partyAPositionsCount(userAddress),
			context.viewFacetQuote.partyBPositionsCount(hedgerAddress, userAddress),
			getAllOpenPositions((start, size) => context.viewFacetQuote.getPartyAOpenPositions(userAddress, start, size)),
			getAllOpenPositions((start, size) => context.viewFacetQuote.getPartyBOpenPositions(hedgerAddress, userAddress, start, size)),
			context.viewFacetQuote.getPartyBPendingQuotes(hedgerAddress, userAddress),
			context.viewFacetSymbol.getConnectedPartyBs(userAddress),
			context.viewFacet.nonceOfPartyA(userAddress),
			context.viewFacet.nonceOfPartyB(hedgerAddress, userAddress),
			isCrossPartyBPromise,
		])
		return {
			balanceInfoPartyA,
			balanceInfoPartyB,
			quote,
			partyAPositionsCount,
			partyBPositionsCount,
			partyAOpenPositionCount: BigInt(partyAOpenPositions.length),
			partyBOpenPositionCount: BigInt(partyBOpenPositions.length),
			partyBPendingQuoteCount: BigInt(partyBPendingQuotes.length),
			connectedPartyBs: [...connectedPartyBs].map(a => a.toLowerCase()),
			partyANonce,
			partyBNonce,
			isCrossPartyB,
		}
	}

	async after(context: RunContext, arg: FillCloseRequestValidatorAfterArg) {
		logger.debug("After FillCloseRequestValidator...")
		const [userAddress, hedgerAddress, newQuote] = await Promise.all([
			arg.user.getAddress(),
			arg.hedger.getAddress(),
			context.viewFacetQuote.getQuote(arg.quoteId),
		])
		const oldQuote = arg.beforeOutput.quote
		const zeroToClose = newQuote.quantityToClose === 0n
		const isFullyClosed = newQuote.quantity === newQuote.closedAmount

		// Check Quote
		if (isFullyClosed) {
			expect(newQuote.quoteStatus).to.equal(QuoteStatus.CLOSED)
		} else if (zeroToClose || newQuote.quoteStatus === BigInt(QuoteStatus.CANCEL_CLOSE_PENDING)) {
			expect(newQuote.quoteStatus).to.equal(QuoteStatus.OPENED)
		} else {
			expect(newQuote.quoteStatus).to.equal(QuoteStatus.CLOSE_PENDING)
		}

		expect(newQuote.closedAmount.toString()).to.equal((BigInt(oldQuote.closedAmount) + BigInt(arg.fillAmount)).toString())

		const requestRemainder = BigInt(oldQuote.quantityToClose) - BigInt(arg.fillAmount)
		const expectedQuantityToClose =
			oldQuote.quoteStatus === BigInt(QuoteStatus.CANCEL_CLOSE_PENDING) ||
			(oldQuote.orderType === BigInt(OrderType.MARKET_BEST_EFFORT) && newQuote.quoteStatus === BigInt(QuoteStatus.OPENED) && requestRemainder > 0n)
				? 0n
				: requestRemainder
		expect(newQuote.quantityToClose).to.equal(expectedQuantityToClose)

		let profit
		if (newQuote.positionType === BigInt(PositionType.LONG)) {
			profit = unDecimal((BigInt(arg.closePrice) - BigInt(newQuote.openedPrice)) * BigInt(arg.fillAmount))
		} else {
			profit = unDecimal((BigInt(newQuote.openedPrice) - BigInt(arg.closePrice)) * BigInt(arg.fillAmount))
		}

		const openAmount = oldQuote.quantity - oldQuote.closedAmount
		const returnedLockedValues = calculateReleasedLockedValues(oldQuote.lockedValues, arg.fillAmount, openAmount)
		const closeFee = calculateCloseFee(arg.fillAmount, arg.closePrice, oldQuote.closeFee)
		const fundingFee = (openAmount * (newQuote.accumulatedPaidFunding - oldQuote.accumulatedPaidFunding)) / 10n ** 18n

		expect(newQuote.lockedValues.cva).to.equal(oldQuote.lockedValues.cva - returnedLockedValues.cva)
		expect(newQuote.lockedValues.lf).to.equal(oldQuote.lockedValues.lf - returnedLockedValues.lf)
		expect(newQuote.lockedValues.partyAmm).to.equal(oldQuote.lockedValues.partyAmm - returnedLockedValues.partyAmm)
		expect(newQuote.lockedValues.partyBmm).to.equal(oldQuote.lockedValues.partyBmm - returnedLockedValues.partyBmm)

		const balanceInfoPartyBPromise = arg.beforeOutput.isCrossPartyB ? arg.hedger.getBalanceInfoCrossPartyB() : arg.hedger.getBalanceInfo(userAddress)
		const commonSnapshotPromise = Promise.all([
			arg.user.getBalanceInfo(),
			balanceInfoPartyBPromise,
			context.viewFacet.nonceOfPartyA(userAddress),
			context.viewFacet.nonceOfPartyB(hedgerAddress, userAddress),
		])

		const [
			[newBalanceInfoPartyA, newBalanceInfoPartyB, newPartyANonce, newPartyBNonce],
			newPositionsCountA,
			newPositionsCountB,
			newPartyAOpenPositions,
			newPartyBOpenPositions,
			newPartyBPendingQuotes,
			newConnectedPartyBsRaw,
		] = await Promise.all([
			commonSnapshotPromise,
			context.viewFacetQuote.partyAPositionsCount(userAddress),
			context.viewFacetQuote.partyBPositionsCount(hedgerAddress, userAddress),
			getAllOpenPositions((start, size) => context.viewFacetQuote.getPartyAOpenPositions(userAddress, start, size)),
			isFullyClosed
				? getAllOpenPositions((start, size) => context.viewFacetQuote.getPartyBOpenPositions(hedgerAddress, userAddress, start, size))
				: Promise.resolve(undefined),
			isFullyClosed ? context.viewFacetQuote.getPartyBPendingQuotes(hedgerAddress, userAddress) : Promise.resolve(undefined),
			context.viewFacetSymbol.getConnectedPartyBs(userAddress),
		])
		const newConnectedPartyBs = newConnectedPartyBsRaw.map(a => a.toLowerCase())

		// Check Balances partyA
		const oldBalanceInfoPartyA = arg.beforeOutput.balanceInfoPartyA

		expect(newBalanceInfoPartyA.totalPendingLockedPartyA.toString()).to.equal(oldBalanceInfoPartyA.totalPendingLockedPartyA.toString())
		expect(newBalanceInfoPartyA.totalLockedPartyA).to.equal(oldBalanceInfoPartyA.totalLockedPartyA - returnedLockedValues.partyA)
		expect(newBalanceInfoPartyA.allocatedBalances).to.equal(oldBalanceInfoPartyA.allocatedBalances - closeFee + profit - fundingFee)
		// Check Balances partyB
		const oldBalanceInfoPartyB = arg.beforeOutput.balanceInfoPartyB

		expect(newBalanceInfoPartyB.totalPendingLockedPartyB.toString()).to.equal(oldBalanceInfoPartyB.totalPendingLockedPartyB.toString())
		expect(newBalanceInfoPartyB.totalLockedPartyB).to.equal(oldBalanceInfoPartyB.totalLockedPartyB - returnedLockedValues.partyB)
		expect(newBalanceInfoPartyB.allocatedBalances).to.equal(oldBalanceInfoPartyB.allocatedBalances - profit + fundingFee)

		// ---- Enhanced State Checks ----

		// Verify nonces incremented (fillCloseRequest calls increaseBothNonces)
		expect(newPartyANonce).to.equal(arg.beforeOutput.partyANonce + 1n)
		expect(newPartyBNonce).to.equal(arg.beforeOutput.partyBNonce + 1n)

		if (isFullyClosed) {
			// Position count should decrease by 1
			expect(newPositionsCountA).to.equal(arg.beforeOutput.partyAPositionsCount - 1n)

			expect(newPositionsCountB).to.equal(arg.beforeOutput.partyBPositionsCount - 1n)

			// Open positions arrays should shrink
			expect(BigInt(newPartyAOpenPositions.length)).to.equal(arg.beforeOutput.partyAOpenPositionCount - 1n)
			expect(newPartyAOpenPositions.map(q => q.id.toString())).to.not.include(arg.quoteId.toString())

			if (newPartyBOpenPositions === undefined || newPartyBPendingQuotes === undefined) {
				throw new Error("Fully closed position snapshot is incomplete")
			}
			expect(BigInt(newPartyBOpenPositions.length)).to.equal(arg.beforeOutput.partyBOpenPositionCount - 1n)

			expect(BigInt(newPartyBPendingQuotes.length)).to.equal(arg.beforeOutput.partyBPendingQuoteCount)
			if (shouldKeepPartyBConnection(newPositionsCountB, BigInt(newPartyBPendingQuotes.length))) {
				expect(newConnectedPartyBs).to.include(hedgerAddress.toLowerCase())
			} else {
				expect(newConnectedPartyBs).to.not.include(hedgerAddress.toLowerCase())
			}
		} else {
			// Position count should remain unchanged for partial close
			expect(newPositionsCountA).to.equal(arg.beforeOutput.partyAPositionsCount)

			expect(newPositionsCountB).to.equal(arg.beforeOutput.partyBPositionsCount)

			// Open positions arrays should remain the same size
			expect(BigInt(newPartyAOpenPositions.length)).to.equal(arg.beforeOutput.partyAOpenPositionCount)

			// Connection should remain
			expect(newConnectedPartyBs).to.include(hedgerAddress.toLowerCase())
		}
	}
}
