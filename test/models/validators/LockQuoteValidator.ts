import {expect} from "chai"

import {QuoteStatus} from "../Enums.js"
import {Hedger} from "../Hedger.js"
import {RunContext} from "../RunContext.js"
import {BalanceInfo, User} from "../User.js"
import {logger} from "../../utils/LoggerUtils.js"
import {TransactionValidator} from "./TransactionValidator.js"

export type LockQuoteValidatorBeforeArg = {
	user: User
	hedger?: Hedger
	quoteId?: bigint
}

export type LockQuoteValidatorBeforeOutput = {
	balanceInfoPartyA: BalanceInfo
	partyBPendingQuotes?: bigint[]
	positionsCount?: bigint
	partyBPositionsCount?: bigint
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
		const userAddress = await arg.user.getAddress()
		const output: LockQuoteValidatorBeforeOutput = {
			balanceInfoPartyA: await arg.user.getBalanceInfo(),
		}
		if (arg.hedger) {
			const hedgerAddress = await arg.hedger.getAddress()
			output.partyBPendingQuotes = [...(await context.viewFacetQuote.getPartyBPendingQuotes(hedgerAddress, userAddress))]
			output.positionsCount = await context.viewFacetQuote.partyAPositionsCount(userAddress)
			output.partyBPositionsCount = await context.viewFacetQuote.partyBPositionsCount(hedgerAddress, userAddress)
		}
		return output
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

		// Verify partyB pending quotes grew by 1 (if before captured it)
		if (arg.beforeOutput.partyBPendingQuotes != null) {
			const newPartyBPendingQuotes = await context.viewFacetQuote.getPartyBPendingQuotes(hedgerAddress, userAddress)
			expect(newPartyBPendingQuotes.length).to.equal(arg.beforeOutput.partyBPendingQuotes.length + 1)
			expect(newPartyBPendingQuotes.map(q => q.toString())).to.include(arg.quoteId.toString())
		}

		// Verify position counts unchanged (quote is locked, not opened)
		if (arg.beforeOutput.positionsCount != null) {
			const newPositionsCount = await context.viewFacetQuote.partyAPositionsCount(userAddress)
			expect(newPositionsCount).to.equal(arg.beforeOutput.positionsCount)
		}
		if (arg.beforeOutput.partyBPositionsCount != null) {
			const newPartyBPositionsCount = await context.viewFacetQuote.partyBPositionsCount(hedgerAddress, userAddress)
			expect(newPartyBPositionsCount).to.equal(arg.beforeOutput.partyBPositionsCount)
		}
	}
}
