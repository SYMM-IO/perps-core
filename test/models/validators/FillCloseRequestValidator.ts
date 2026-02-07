import { expect } from "chai"
import type { QuoteStructOutput } from "../../../src/types/interfaces/ISymmio.js"
import { getCloseTradingFeeForQuotes, getTotalPartyALockedValuesForQuotes, getTotalPartyBLockedValuesForQuotes, unDecimal } from "../../utils/Common.js"
import { logger } from "../../utils/LoggerUtils.js"
import { expectToBeApproximately } from "../../utils/SafeMath.js"
import { PositionType, QuoteStatus } from "../Enums.js"
import { Hedger } from "../Hedger.js"
import { RunContext } from "../RunContext.js"
import { BalanceInfo, User } from "../User.js"
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
	connectedPartyBs: string[]
}

export type FillCloseRequestValidatorAfterArg = {
	user: User
	hedger: Hedger
	quoteId: bigint
	closePrice: bigint
	fillAmount: bigint
	beforeOutput: FillCloseRequestValidatorBeforeOutput
}

export class FillCloseRequestValidator implements TransactionValidator {
	async before(context: RunContext, arg: FillCloseRequestValidatorBeforeArg): Promise<FillCloseRequestValidatorBeforeOutput> {
		logger.debug("Before FillCloseRequestValidator...")
		const userAddress = await arg.user.getAddress()
		const hedgerAddress = await arg.hedger.getAddress()
		const partyAOpenPositions = await context.viewFacetQuote.getPartyAOpenPositions(userAddress, 0, 1000)
		const partyBOpenPositions = await context.viewFacetQuote.getPartyBOpenPositions(hedgerAddress, userAddress, 0, 1000)
		return {
			balanceInfoPartyA: await arg.user.getBalanceInfo(),
			balanceInfoPartyB: await arg.hedger.getBalanceInfo(userAddress),
			quote: await context.viewFacetQuote.getQuote(arg.quoteId),
			partyAPositionsCount: await context.viewFacetQuote.partyAPositionsCount(userAddress),
			partyBPositionsCount: await context.viewFacetQuote.partyBPositionsCount(hedgerAddress, userAddress),
			partyAOpenPositionCount: BigInt(partyAOpenPositions.length),
			partyBOpenPositionCount: BigInt(partyBOpenPositions.length),
			connectedPartyBs: [...(await context.viewFacetSymbol.getConnectedPartyBs(userAddress))].map(a => a.toLowerCase()),
		}
	}

	async after(context: RunContext, arg: FillCloseRequestValidatorAfterArg) {
		logger.debug("After FillCloseRequestValidator...")
		const userAddress = await arg.user.getAddress()
		const hedgerAddress = await arg.hedger.getAddress()

		// Check Quote
		const newQuote = await context.viewFacetQuote.getQuote(arg.quoteId)
		const oldQuote = arg.beforeOutput.quote
		const zeroToClose = newQuote.quantityToClose === 0n
		const isFullyClosed = newQuote.quantity === newQuote.closedAmount

		if (isFullyClosed) {
			expect(newQuote.quoteStatus).to.equal(QuoteStatus.CLOSED)
		} else if (zeroToClose || newQuote.quoteStatus === BigInt(QuoteStatus.CANCEL_CLOSE_PENDING)) {
			expect(newQuote.quoteStatus).to.equal(QuoteStatus.OPENED)
		} else {
			expect(newQuote.quoteStatus).to.equal(QuoteStatus.CLOSE_PENDING)
		}

		expect(newQuote.closedAmount.toString()).to.equal((BigInt(oldQuote.closedAmount) + BigInt(arg.fillAmount)).toString())

		expect(newQuote.quantityToClose.toString()).to.equal((BigInt(oldQuote.quantityToClose) - BigInt(arg.fillAmount)).toString())

		const oldLockedValuesPartyA = await getTotalPartyALockedValuesForQuotes([oldQuote])
		const oldLockedValuesPartyB = await getTotalPartyBLockedValuesForQuotes([oldQuote])

		let profit
		if (newQuote.positionType === BigInt(PositionType.LONG)) {
			profit = unDecimal((BigInt(arg.closePrice) - BigInt(newQuote.openedPrice)) * BigInt(arg.fillAmount))
		} else {
			profit = unDecimal((BigInt(newQuote.openedPrice) - BigInt(arg.closePrice)) * BigInt(arg.fillAmount))
		}

		const returnedLockedValuesPartyA = (BigInt(oldLockedValuesPartyA) * BigInt(arg.fillAmount)) / BigInt(oldQuote.quantity)
		const returnedLockedValuesPartyB = (BigInt(oldLockedValuesPartyB) * BigInt(arg.fillAmount)) / BigInt(oldQuote.quantity)

		// Check Balances partyA
		const newBalanceInfoPartyA = await arg.user.getBalanceInfo()
		const oldBalanceInfoPartyA = arg.beforeOutput.balanceInfoPartyA

		expect(newBalanceInfoPartyA.totalPendingLockedPartyA.toString()).to.equal(oldBalanceInfoPartyA.totalPendingLockedPartyA.toString())
		expectToBeApproximately(
			BigInt(newBalanceInfoPartyA.totalLockedPartyA),
			BigInt(oldBalanceInfoPartyA.totalLockedPartyA) - returnedLockedValuesPartyA,
		)
		expect(newBalanceInfoPartyA.allocatedBalances).to.be.approximately(
			oldBalanceInfoPartyA.allocatedBalances - (await getCloseTradingFeeForQuotes(context, [arg.quoteId])) + profit,
			oldBalanceInfoPartyA.allocatedBalances / 1000n,
		)
		// Check Balances partyB
		const newBalanceInfoPartyB = await arg.hedger.getBalanceInfo(userAddress)
		const oldBalanceInfoPartyB = arg.beforeOutput.balanceInfoPartyB

		expect(newBalanceInfoPartyB.totalPendingLockedPartyB.toString()).to.equal(oldBalanceInfoPartyB.totalPendingLockedPartyB.toString())
		expectToBeApproximately(BigInt(newBalanceInfoPartyB.totalLockedPartyB), BigInt(oldBalanceInfoPartyB.totalLockedPartyB) - returnedLockedValuesPartyB)
		expectToBeApproximately(BigInt(newBalanceInfoPartyB.allocatedBalances), BigInt(oldBalanceInfoPartyB.allocatedBalances) - profit)

		// ---- Enhanced State Checks ----

		if (isFullyClosed) {
			// Position count should decrease by 1
			const newPositionsCountA = await context.viewFacetQuote.partyAPositionsCount(userAddress)
			expect(newPositionsCountA).to.equal(arg.beforeOutput.partyAPositionsCount - 1n)

			const newPositionsCountB = await context.viewFacetQuote.partyBPositionsCount(hedgerAddress, userAddress)
			expect(newPositionsCountB).to.equal(arg.beforeOutput.partyBPositionsCount - 1n)

			// Open positions arrays should shrink
			const newPartyAOpenPositions = await context.viewFacetQuote.getPartyAOpenPositions(userAddress, 0, 1000)
			expect(BigInt(newPartyAOpenPositions.length)).to.equal(arg.beforeOutput.partyAOpenPositionCount - 1n)
			expect(newPartyAOpenPositions.map(q => q.id.toString())).to.not.include(arg.quoteId.toString())

			const newPartyBOpenPositions = await context.viewFacetQuote.getPartyBOpenPositions(hedgerAddress, userAddress, 0, 1000)
			expect(BigInt(newPartyBOpenPositions.length)).to.equal(arg.beforeOutput.partyBOpenPositionCount - 1n)

			// If this was the last position with this hedger, connection should be removed
			if (arg.beforeOutput.partyBPositionsCount === 1n) {
				const newConnectedPartyBs = (await context.viewFacetSymbol.getConnectedPartyBs(userAddress)).map(a => a.toLowerCase())
				expect(newConnectedPartyBs).to.not.include(hedgerAddress.toLowerCase())
			}
		} else {
			// Position count should remain unchanged for partial close
			const newPositionsCountA = await context.viewFacetQuote.partyAPositionsCount(userAddress)
			expect(newPositionsCountA).to.equal(arg.beforeOutput.partyAPositionsCount)

			const newPositionsCountB = await context.viewFacetQuote.partyBPositionsCount(hedgerAddress, userAddress)
			expect(newPositionsCountB).to.equal(arg.beforeOutput.partyBPositionsCount)

			// Open positions arrays should remain the same size
			const newPartyAOpenPositions = await context.viewFacetQuote.getPartyAOpenPositions(userAddress, 0, 1000)
			expect(BigInt(newPartyAOpenPositions.length)).to.equal(arg.beforeOutput.partyAOpenPositionCount)

			// Connection should remain
			const newConnectedPartyBs = (await context.viewFacetSymbol.getConnectedPartyBs(userAddress)).map(a => a.toLowerCase())
			expect(newConnectedPartyBs).to.include(hedgerAddress.toLowerCase())
		}
	}
}
