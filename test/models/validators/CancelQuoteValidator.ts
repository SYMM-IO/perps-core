import { expect } from "chai"

import type { QuoteStructOutput } from "../../../src/types/interfaces/ISymmio.js"
import { getTotalPartyALockedValuesForQuotes, getTradingFeeForQuotes } from "../../utils/Common.js"
import { logger } from "../../utils/LoggerUtils.js"
import { expectToBeApproximately } from "../../utils/SafeMath.js"
import { QuoteStatus } from "../Enums.js"
import { RunContext } from "../RunContext.js"
import { BalanceInfo, User } from "../User.js"
import { TransactionValidator } from "./TransactionValidator.js"

export type CancelQuoteValidatorBeforeArg = {
	user: User
	quoteId: bigint
}

export type CancelQuoteValidatorBeforeOutput = {
	balanceInfoPartyA: BalanceInfo
	quote: QuoteStructOutput
	pendingQuotes: bigint[]
	positionsCount: bigint
}

export type CancelQuoteValidatorAfterArg = {
	user: User
	quoteId: bigint
	targetStatus?: QuoteStatus.CANCELED | QuoteStatus.EXPIRED
	beforeOutput: CancelQuoteValidatorBeforeOutput
}

export function expectedQuoteIdsAfterSwapPop(quoteIds: readonly bigint[], quoteId: bigint): bigint[] {
	const index = quoteIds.findIndex(currentQuoteId => currentQuoteId === quoteId)
	if (index === -1) throw new Error(`Quote ${quoteId} was not present in the snapshotted pending array`)

	const expected = [...quoteIds]
	expected[index] = expected[expected.length - 1]
	expected.pop()
	return expected
}

export class CancelQuoteValidator implements TransactionValidator {
	async before(context: RunContext, arg: CancelQuoteValidatorBeforeArg): Promise<CancelQuoteValidatorBeforeOutput> {
		logger.debug("Before CancelQuoteValidator...")
		const userAddress = await arg.user.getAddress()
		return {
			balanceInfoPartyA: await arg.user.getBalanceInfo(),
			quote: await context.viewFacetQuote.getQuote(arg.quoteId),
			pendingQuotes: [...(await context.viewFacetQuote.getPartyAPendingQuotes(userAddress))],
			positionsCount: await context.viewFacetQuote.partyAPositionsCount(userAddress),
		}
	}

	async after(context: RunContext, arg: CancelQuoteValidatorAfterArg) {
		logger.debug("After CancelQuoteValidator...")
		const userAddress = await arg.user.getAddress()

		// Check Quote
		const newQuote = await context.viewFacetQuote.getQuote(arg.quoteId)
		const oldQuote = arg.beforeOutput.quote

		const newBalanceInfoPartyA = await arg.user.getBalanceInfo()
		const oldBalanceInfoPartyA = arg.beforeOutput.balanceInfoPartyA

		if (oldQuote.quoteStatus == BigInt(QuoteStatus.LOCKED) && arg.targetStatus !== QuoteStatus.EXPIRED) {
			expect(newQuote.quoteStatus).to.be.equal(QuoteStatus.CANCEL_PENDING)
			expect(newBalanceInfoPartyA.totalPendingLockedPartyA).to.be.equal(oldBalanceInfoPartyA.totalPendingLockedPartyA.toString())
			expect(newBalanceInfoPartyA.totalLockedPartyA).to.be.equal(oldBalanceInfoPartyA.totalLockedPartyA.toString())
			expect(newBalanceInfoPartyA.allocatedBalances).to.be.equal(oldBalanceInfoPartyA.allocatedBalances.toString())

			// Pending quotes array should not change (CANCEL_PENDING is still "pending")
			const newPendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(userAddress)
			expect([...newPendingQuotes]).to.deep.equal(arg.beforeOutput.pendingQuotes)
			return
		}
		if (arg.targetStatus == null) {
			throw new Error("CancelQuoteValidator requires the expected CANCELED or EXPIRED target for a pending quote")
		}
		expect(newQuote.quoteStatus).to.be.equal(arg.targetStatus)

		const lockedValues = await getTotalPartyALockedValuesForQuotes([oldQuote])

		expect(newBalanceInfoPartyA.totalPendingLockedPartyA.toString()).to.equal(
			(oldBalanceInfoPartyA.totalPendingLockedPartyA - lockedValues).toString(),
		)
		expect(newBalanceInfoPartyA.totalLockedPartyA.toString()).to.equal(oldBalanceInfoPartyA.totalLockedPartyA.toString())
		const tradingFee = await getTradingFeeForQuotes(context, [arg.quoteId])
		expectToBeApproximately(BigInt(newBalanceInfoPartyA.allocatedBalances), BigInt(oldBalanceInfoPartyA.allocatedBalances) + BigInt(tradingFee))

		// Verify the exact swap-pop performed by LibUtils.removeFromArray.
		const newPendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(userAddress)
		expect([...newPendingQuotes]).to.deep.equal(expectedQuoteIdsAfterSwapPop(arg.beforeOutput.pendingQuotes, arg.quoteId))

		// Verify position count unchanged (cancel doesn't affect open positions)
		const newPositionsCount = await context.viewFacetQuote.partyAPositionsCount(userAddress)
		expect(newPositionsCount).to.equal(arg.beforeOutput.positionsCount)
	}
}
