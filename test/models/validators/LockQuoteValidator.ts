import { expect } from "chai"

import { logger } from "../../utils/LoggerUtils.js"
import { QuoteStatus } from "../Enums.js"
import { Hedger } from "../Hedger.js"
import { RunContext } from "../RunContext.js"
import { BalanceInfo, User } from "../User.js"
import { TransactionValidator } from "./TransactionValidator.js"

export type LockQuoteValidatorBeforeArg = {
	user: User
	hedger: Hedger
	quoteId: bigint
}

export type LockQuoteValidatorBeforeOutput = {
	balanceInfoPartyA: BalanceInfo
	partyBPendingQuotes: bigint[]
	positionsCount: bigint
	partyBPositionsCount: bigint
}

export type LockQuoteValidatorAfterArg = {
	user: User
	hedger: Hedger
	quoteId: bigint
	beforeOutput: LockQuoteValidatorBeforeOutput
}

export class LockQuoteValidator implements TransactionValidator {
	async before(context: RunContext, arg: LockQuoteValidatorBeforeArg): Promise<LockQuoteValidatorBeforeOutput> {
		logger.debug("Before LockQuoteValidator...")
		const [userAddress, hedgerAddress] = await Promise.all([arg.user.getAddress(), arg.hedger.getAddress()])
		const [balanceInfoPartyA, partyBPendingQuotes, positionsCount, partyBPositionsCount] = await Promise.all([
			arg.user.getBalanceInfo(),
			context.viewFacetQuote.getPartyBPendingQuotes(hedgerAddress, userAddress),
			context.viewFacetQuote.partyAPositionsCount(userAddress),
			context.viewFacetQuote.partyBPositionsCount(hedgerAddress, userAddress),
		])
		expect(partyBPendingQuotes.map(quoteId => quoteId.toString())).to.not.include(arg.quoteId.toString())
		return {
			balanceInfoPartyA,
			partyBPendingQuotes: [...partyBPendingQuotes],
			positionsCount,
			partyBPositionsCount,
		}
	}

	async after(context: RunContext, arg: LockQuoteValidatorAfterArg) {
		logger.debug("After LockQuoteValidator...")
		const userAddress = await arg.user.getAddress()
		const hedgerAddress = await arg.hedger.getAddress()
		const newBalanceInfo = await arg.user.getBalanceInfo()
		const oldBalanceInfo = arg.beforeOutput.balanceInfoPartyA

		expect(newBalanceInfo.totalPendingLockedPartyA).to.be.equal(oldBalanceInfo.totalPendingLockedPartyA.toString())
		expect(newBalanceInfo.allocatedBalances).to.be.equal(oldBalanceInfo.allocatedBalances.toString())
		const quote = await context.viewFacetQuote.getQuote(arg.quoteId)
		expect(quote.quoteStatus).to.be.equal(QuoteStatus.LOCKED)
		expect(quote.partyB).to.be.equal(hedgerAddress)

		// Verify partyB pending quotes grew by 1.
		const newPartyBPendingQuotes = await context.viewFacetQuote.getPartyBPendingQuotes(hedgerAddress, userAddress)
		expect(newPartyBPendingQuotes.length).to.equal(arg.beforeOutput.partyBPendingQuotes.length + 1)
		expect(newPartyBPendingQuotes.map(q => q.toString())).to.include(arg.quoteId.toString())

		// Verify position counts unchanged (quote is locked, not opened).
		const [newPositionsCount, newPartyBPositionsCount] = await Promise.all([
			context.viewFacetQuote.partyAPositionsCount(userAddress),
			context.viewFacetQuote.partyBPositionsCount(hedgerAddress, userAddress),
		])
		expect(newPositionsCount).to.equal(arg.beforeOutput.positionsCount)
		expect(newPartyBPositionsCount).to.equal(arg.beforeOutput.partyBPositionsCount)
	}
}
