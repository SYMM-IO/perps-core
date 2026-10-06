import { expect } from "chai"

import type { QuoteStructOutput } from "../../../src/types/interfaces/ISymmio.js"
import { logger } from "../../utils/LoggerUtils.js"
import { QuoteStatus } from "../Enums.js"
import { Hedger } from "../Hedger.js"
import { RunContext } from "../RunContext.js"
import { BalanceInfo, User } from "../User.js"
import { TransactionValidator } from "./TransactionValidator.js"

export type CloseRequestValidatorBeforeArg = {
	user: User
	quoteId: bigint
	hedger: Hedger
}

export type CloseRequestValidatorBeforeOutput = {
	balanceInfoPartyA: BalanceInfo
	balanceInfoPartyB: BalanceInfo
	quote: QuoteStructOutput
}

export type CloseRequestValidatorAfterArg = {
	user: User
	hedger: Hedger
	quoteId: bigint
	closePrice: bigint
	quantityToClose: bigint
	beforeOutput: CloseRequestValidatorBeforeOutput
}

export class CloseRequestValidator implements TransactionValidator {
	async before(context: RunContext, arg: CloseRequestValidatorBeforeArg): Promise<CloseRequestValidatorBeforeOutput> {
		logger.debug("Before CloseRequestValidator...")
		return {
			balanceInfoPartyA: await arg.user.getBalanceInfo(),
			balanceInfoPartyB: await arg.hedger.getBalanceInfo(await arg.user.getAddress()),
			quote: await context.viewFacetQuote.getQuote(arg.quoteId),
		}
	}

	async after(context: RunContext, arg: CloseRequestValidatorAfterArg) {
		logger.debug("After CloseRequestValidator...")
		// Check Quote
		const newQuote = await context.viewFacetQuote.getQuote(arg.quoteId)
		const oldQuote = arg.beforeOutput.quote
		expect(newQuote.quoteStatus).to.be.equal(QuoteStatus.CLOSE_PENDING)
		expect(newQuote.quantityToClose).to.be.equal(arg.quantityToClose)
		expect(newQuote.requestedClosePrice).to.be.equal(arg.closePrice)

		// Check Balances partyA
		const newBalanceInfoPartyA = await arg.user.getBalanceInfo()
		const oldBalanceInfoPartyA = arg.beforeOutput.balanceInfoPartyA

		expect(newBalanceInfoPartyA.totalPendingLockedPartyA).to.be.equal(oldBalanceInfoPartyA.totalPendingLockedPartyA.toString())
		expect(newBalanceInfoPartyA.totalLockedPartyA).to.be.equal(oldBalanceInfoPartyA.totalLockedPartyA.toString())
		expect(newBalanceInfoPartyA.allocatedBalances).to.be.equal(oldBalanceInfoPartyA.allocatedBalances)

		// Check Balances partyB
		const newBalanceInfoPartyB = await arg.hedger.getBalanceInfo(await arg.user.getAddress())
		const oldBalanceInfoPartyB = arg.beforeOutput.balanceInfoPartyB

		expect(newBalanceInfoPartyB.totalPendingLockedPartyB).to.be.equal(oldBalanceInfoPartyB.totalPendingLockedPartyB.toString())
		expect(newBalanceInfoPartyB.totalLockedPartyB).to.be.equal(oldBalanceInfoPartyB.totalLockedPartyB.toString())
		expect(newBalanceInfoPartyB.allocatedBalances).to.be.equal(oldBalanceInfoPartyB.allocatedBalances.toString())
	}
}
