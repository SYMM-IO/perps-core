import {expect} from "chai"

import {getTotalLockedValuesForQuoteIds, getTradingFeeForQuotes} from "../../utils/Common.js"
import {logger} from "../../utils/LoggerUtils.js"
import {QuoteStatus} from "../Enums.js"
import {RunContext} from "../RunContext.js"
import {BalanceInfo, User} from "../User.js"
import {TransactionValidator} from "./TransactionValidator.js"

export type SendQuoteValidatorBeforeArg = {
	user: User
}

export type SendQuoteValidatorBeforeOutput = {
	balanceInfoPartyA: BalanceInfo
	pendingQuotes: bigint[]
	positionsCount: bigint
}

export type SendQuoteValidatorAfterArg = {
	user: User
	quoteId: bigint
	beforeOutput: SendQuoteValidatorBeforeOutput
}

export class SendQuoteValidator implements TransactionValidator {
	async before(context: RunContext, arg: SendQuoteValidatorBeforeArg): Promise<SendQuoteValidatorBeforeOutput> {
		logger.debug("Before SendQuoteValidator...")
		const userAddress = await arg.user.getAddress()
		return {
			balanceInfoPartyA: await arg.user.getBalanceInfo(),
			pendingQuotes: [...(await context.viewFacetQuote.getPartyAPendingQuotes(userAddress))],
			positionsCount: await context.viewFacetQuote.partyAPositionsCount(userAddress),
		}
	}

	async after(context: RunContext, arg: SendQuoteValidatorAfterArg) {
		logger.debug("After SendQuoteValidator...")
		const userAddress = await arg.user.getAddress()
		const newBalanceInfo = await arg.user.getBalanceInfo()
		const oldBalanceInfo = arg.beforeOutput.balanceInfoPartyA

		expect(newBalanceInfo.totalPendingLockedPartyA).to.be.equal(
			(oldBalanceInfo.totalPendingLockedPartyA + await getTotalLockedValuesForQuoteIds(context, [arg.quoteId])).toString(),
		)
		expect(newBalanceInfo.allocatedBalances).to.be.equal((oldBalanceInfo.allocatedBalances - await getTradingFeeForQuotes(context, [arg.quoteId])))
		expect((await context.viewFacetQuote.getQuote(arg.quoteId)).quoteStatus).to.be.equal(QuoteStatus.PENDING)

		// Verify pending quotes array grew by 1 and contains the new quote
		const newPendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(userAddress)
		expect(newPendingQuotes.length).to.equal(arg.beforeOutput.pendingQuotes.length + 1)
		expect(newPendingQuotes.map(q => q.toString())).to.include(arg.quoteId.toString())

		// Verify positions count unchanged (quote is pending, not opened)
		const newPositionsCount = await context.viewFacetQuote.partyAPositionsCount(userAddress)
		expect(newPositionsCount).to.equal(arg.beforeOutput.positionsCount)
	}
}
