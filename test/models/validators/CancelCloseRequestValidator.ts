import {expect} from "chai"

import type { QuoteStructOutput} from "../../../src/types/interfaces/ISymmio.js"
import {logger} from "../../utils/LoggerUtils.js"
import {QuoteStatus} from "../Enums.js"
import {Hedger} from "../Hedger.js"
import {RunContext} from "../RunContext.js"
import {BalanceInfo, User} from "../User.js"
import {TransactionValidator} from "./TransactionValidator.js"

export type CancelCloseRequestValidatorBeforeArg = {
	user: User
	hedger: Hedger
	quoteId: bigint
}

export type CancelCloseRequestValidatorBeforeOutput = {
	balanceInfoPartyA: BalanceInfo
	balanceInfoPartyB: BalanceInfo
	quote: QuoteStructOutput
}

export type CancelCloseRequestValidatorAfterArg = {
	user: User
	hedger: Hedger
	quoteId: bigint
	beforeOutput: CancelCloseRequestValidatorBeforeOutput
}

export class CancelCloseRequestValidator implements TransactionValidator {
	async before(context: RunContext, arg: CancelCloseRequestValidatorBeforeArg): Promise<CancelCloseRequestValidatorBeforeOutput> {
		logger.debug("Before CancelCloseRequestValidator...")
		return {
			balanceInfoPartyA: await arg.user.getBalanceInfo(),
			balanceInfoPartyB: await arg.hedger.getBalanceInfo(await arg.user.getAddress()),
			quote: await context.viewFacetQuote.getQuote(arg.quoteId),
		}
	}

	async after(context: RunContext, arg: CancelCloseRequestValidatorAfterArg) {
		logger.debug("After CancelCloseRequestValidator...")
		// Check Quote
		const newQuote = await context.viewFacetQuote.getQuote(arg.quoteId)
		const oldQuote = arg.beforeOutput.quote

		expect(newQuote.quoteStatus).to.be.equal(QuoteStatus.CANCEL_CLOSE_PENDING)

		// Check Balances partyA
		const newBalanceInfoPartyA = await arg.user.getBalanceInfo()
		const oldBalanceInfoPartyA = arg.beforeOutput.balanceInfoPartyA

		expect(newBalanceInfoPartyA.totalPendingLockedPartyA).to.be.equal(oldBalanceInfoPartyA.totalPendingLockedPartyA.toString())
		expect(newBalanceInfoPartyA.totalLockedPartyA).to.be.equal(oldBalanceInfoPartyA.totalLockedPartyA.toString())
		expect(newBalanceInfoPartyA.allocatedBalances).to.be.equal(oldBalanceInfoPartyA.allocatedBalances.toString())

		// Check Balances partyB
		const newBalanceInfoPartyB = await arg.hedger.getBalanceInfo(await arg.user.getAddress())
		const oldBalanceInfoPartyB = arg.beforeOutput.balanceInfoPartyB

		expect(newBalanceInfoPartyB.totalPendingLockedPartyB).to.be.equal(oldBalanceInfoPartyB.totalPendingLockedPartyB.toString())
		expect(newBalanceInfoPartyB.totalLockedPartyB).to.be.equal(oldBalanceInfoPartyB.totalLockedPartyB.toString())
		expect(newBalanceInfoPartyB.allocatedBalances).to.be.equal(oldBalanceInfoPartyB.allocatedBalances.toString())
	}
}
