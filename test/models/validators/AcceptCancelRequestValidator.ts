import { expect } from "chai"

import type { QuoteStructOutput } from "../../../src/types/interfaces/ISymmio.js"
import { getTotalPartyALockedValuesForQuotes, getTradingFeeForQuotes } from "../../utils/Common.js"
import { logger } from "../../utils/LoggerUtils.js"
import { expectToBeApproximately } from "../../utils/SafeMath.js"
import { QuoteStatus } from "../Enums.js"
import { RunContext } from "../RunContext.js"
import { BalanceInfo, User } from "../User.js"
import { TransactionValidator } from "./TransactionValidator.js"

export type AcceptCancelRequestValidatorBeforeArg = {
	user: User
	quoteId: bigint
}

export type AcceptCancelRequestValidatorBeforeOutput = {
	balanceInfoPartyA: BalanceInfo
	quote: QuoteStructOutput
}

export type AcceptCancelRequestValidatorAfterArg = {
	user: User
	quoteId: bigint
	beforeOutput: AcceptCancelRequestValidatorBeforeOutput
}

export class AcceptCancelRequestValidator implements TransactionValidator {
	async before(context: RunContext, arg: AcceptCancelRequestValidatorBeforeArg): Promise<AcceptCancelRequestValidatorBeforeOutput> {
		logger.debug("Before AcceptCancelRequestValidator...")
		return {
			balanceInfoPartyA: await arg.user.getBalanceInfo(),
			quote: await context.viewFacetQuote.getQuote(arg.quoteId),
		}
	}

	async after(context: RunContext, arg: AcceptCancelRequestValidatorAfterArg) {
		logger.debug("After AcceptCancelRequestValidator...")
		// Check Quote
		const newQuote = await context.viewFacetQuote.getQuote(arg.quoteId)
		const oldQuote = arg.beforeOutput.quote
		expect(newQuote.quoteStatus).to.be.equal(QuoteStatus.CANCELED)

		// Check Balances partyA
		const newBalanceInfoPartyA = await arg.user.getBalanceInfo()
		const oldBalanceInfoPartyA = arg.beforeOutput.balanceInfoPartyA

		const lockedValues = await getTotalPartyALockedValuesForQuotes([oldQuote])

		// Assert changes in totalPendingLockedPartyA
		expect(newBalanceInfoPartyA.totalPendingLockedPartyA).to.equal(oldBalanceInfoPartyA.totalPendingLockedPartyA - lockedValues)

		// Assert no changes in totalLockedPartyA
		expect(newBalanceInfoPartyA.totalLockedPartyA).to.equal(oldBalanceInfoPartyA.totalLockedPartyA)

		// Calculate and assert changes in allocatedBalances
		const tradingFee = await getTradingFeeForQuotes(context, [arg.quoteId])
		expectToBeApproximately(newBalanceInfoPartyA.allocatedBalances, oldBalanceInfoPartyA.allocatedBalances + tradingFee)
	}
}
