import { expect } from "chai"

import type { QuoteStructOutput } from "../../../src/types/interfaces/ISymmio.js"
import {
	getTotalPartyALockedValuesForQuotes,
	getTotalPartyBLockedValuesForQuotes,
	getTradingFeeForQuotes,
	getTradingFeeForQuoteWithFilledAmount,
	getOpenTradingFeeForQuoteWithFilledAmount,
} from "../../utils/Common.js"
import { logger } from "../../utils/LoggerUtils.js"
import { expectToBeApproximately } from "../../utils/SafeMath.js"
import { QuoteStatus } from "../Enums.js"
import { Hedger } from "../Hedger.js"
import { RunContext } from "../RunContext.js"
import { BalanceInfo, User } from "../User.js"
import { getAllOpenPositions } from "./OpenPositionPagination.js"
import { TransactionValidator } from "./TransactionValidator.js"

export type OpenPositionValidatorBeforeArg = {
	user: User
	quoteId: bigint
	hedger: Hedger
}

export type OpenPositionValidatorBeforeOutput = {
	balanceInfoPartyA: BalanceInfo
	balanceInfoPartyB: BalanceInfo
	quote: QuoteStructOutput
	feeCollectorBalance: bigint
	partyAPositionsCount: bigint
	partyBPositionsCount: bigint
	partyAPendingQuotes: bigint[]
	partyBPendingQuotes: bigint[]
	partyAOpenPositionCount: bigint
	partyBOpenPositionCount: bigint
	isConnected: boolean
	partyANonce: bigint
	partyBNonce: bigint
}

export type OpenPositionValidatorAfterArg = {
	user: User
	hedger: Hedger
	quoteId: bigint
	openedPrice: bigint
	fillAmount: bigint
	beforeOutput: OpenPositionValidatorBeforeOutput
	newQuoteId?: bigint
	newQuoteTargetStatus?: QuoteStatus
}

export class OpenPositionValidator implements TransactionValidator {
	async before(context: RunContext, arg: OpenPositionValidatorBeforeArg): Promise<OpenPositionValidatorBeforeOutput> {
		logger.debug("Before OpenPositionValidator...")
		const [userAddress, hedgerAddress] = await Promise.all([arg.user.getAddress(), arg.hedger.getAddress()])
		const quotePromise = context.viewFacetQuote.getQuote(arg.quoteId)
		const feeCollectorBalancePromise = quotePromise.then(async quote => {
			const feeCollector = await context.viewFacet.getFeeCollector(quote.affiliate)
			return context.viewFacet.balanceOf(feeCollector)
		})
		const [
			balanceInfoPartyA,
			balanceInfoPartyB,
			quote,
			feeCollectorBalance,
			partyAPositionsCount,
			partyBPositionsCount,
			partyAPendingQuotes,
			partyBPendingQuotes,
			partyAOpenPositions,
			partyBOpenPositions,
			connectedPartyBs,
			partyANonce,
			partyBNonce,
		] = await Promise.all([
			arg.user.getBalanceInfo(),
			arg.hedger.getBalanceInfo(userAddress),
			quotePromise,
			feeCollectorBalancePromise,
			context.viewFacetQuote.partyAPositionsCount(userAddress),
			context.viewFacetQuote.partyBPositionsCount(hedgerAddress, userAddress),
			context.viewFacetQuote.getPartyAPendingQuotes(userAddress),
			context.viewFacetQuote.getPartyBPendingQuotes(hedgerAddress, userAddress),
			getAllOpenPositions((start, size) => context.viewFacetQuote.getPartyAOpenPositions(userAddress, start, size)),
			getAllOpenPositions((start, size) => context.viewFacetQuote.getPartyBOpenPositions(hedgerAddress, userAddress, start, size)),
			context.viewFacetSymbol.getConnectedPartyBs(userAddress),
			context.viewFacet.nonceOfPartyA(userAddress),
			context.viewFacet.nonceOfPartyB(hedgerAddress, userAddress),
		])
		return {
			balanceInfoPartyA,
			balanceInfoPartyB,
			quote,
			feeCollectorBalance,
			partyAPositionsCount,
			partyBPositionsCount,
			partyAPendingQuotes: [...partyAPendingQuotes],
			partyBPendingQuotes: [...partyBPendingQuotes],
			partyAOpenPositionCount: BigInt(partyAOpenPositions.length),
			partyBOpenPositionCount: BigInt(partyBOpenPositions.length),
			isConnected: connectedPartyBs.map(a => a.toLowerCase()).includes(hedgerAddress.toLowerCase()),
			partyANonce,
			partyBNonce,
		}
	}

	async after(context: RunContext, arg: OpenPositionValidatorAfterArg) {
		logger.debug("After OpenPositionValidator...")
		const [userAddress, hedgerAddress, newQuote] = await Promise.all([
			arg.user.getAddress(),
			arg.hedger.getAddress(),
			context.viewFacetQuote.getQuote(arg.quoteId),
		])
		const oldQuote = arg.beforeOutput.quote

		// Check Quote
		expect(newQuote.quoteStatus).to.be.equal(QuoteStatus.OPENED)
		expect(newQuote.openedPrice).to.be.equal(arg.openedPrice)
		expect(newQuote.quantity).to.be.equal(arg.fillAmount)

		const oldLockedValuesPartyA = await getTotalPartyALockedValuesForQuotes([oldQuote])
		const newLockedValuesPartyA = await getTotalPartyALockedValuesForQuotes([newQuote])
		const oldLockedValuesPartyB = await getTotalPartyBLockedValuesForQuotes([oldQuote])

		const filledLockedValues = {
			cva: (oldQuote.lockedValues.cva * arg.fillAmount) / oldQuote.quantity,
			lf: (oldQuote.lockedValues.lf * arg.fillAmount) / oldQuote.quantity,
			partyAmm: (oldQuote.lockedValues.partyAmm * arg.fillAmount) / oldQuote.quantity,
			partyBmm: (oldQuote.lockedValues.partyBmm * arg.fillAmount) / oldQuote.quantity,
		}
		const partialLockedValues = filledLockedValues.cva + filledLockedValues.lf + filledLockedValues.partyAmm
		const partialWithPriceLockedValuesPartyA =
			(filledLockedValues.cva * arg.openedPrice) / oldQuote.requestedOpenPrice +
			(filledLockedValues.lf * arg.openedPrice) / oldQuote.requestedOpenPrice +
			(filledLockedValues.partyAmm * arg.openedPrice) / oldQuote.requestedOpenPrice
		const partialWithPriceLockedValuesPartyB =
			(filledLockedValues.cva * arg.openedPrice) / oldQuote.requestedOpenPrice +
			(filledLockedValues.lf * arg.openedPrice) / oldQuote.requestedOpenPrice +
			(filledLockedValues.partyBmm * arg.openedPrice) / oldQuote.requestedOpenPrice
		const partially = arg.fillAmount !== oldQuote.quantity
		if (partially && (arg.newQuoteId === undefined || arg.newQuoteTargetStatus === undefined)) {
			throw new Error("Partial opens must identify the remaining quote and its status")
		}

		const newCollectorBalancePromise = (async () => {
			const feeCollector = await context.viewFacet.getFeeCollector(newQuote.affiliate)
			return context.viewFacet.balanceOf(feeCollector)
		})()
		const [
			newCollectorBalance,
			filledTradingFee,
			newlyCreatedQuote,
			canceledRemainderTradingFee,
			newBalanceInfoPartyA,
			newBalanceInfoPartyB,
			newPositionsCountA,
			newPositionsCountB,
			newPartyAPendingQuotes,
			newPartyBPendingQuotes,
			newPartyAOpenPositions,
			newPartyBOpenPositions,
			connectedPartyBs,
			newPartyANonce,
			newPartyBNonce,
		] = await Promise.all([
			newCollectorBalancePromise,
			getTradingFeeForQuoteWithFilledAmount(context, newQuote.id!, arg.fillAmount),
			partially ? context.viewFacetQuote.getQuote(arg.newQuoteId!) : Promise.resolve(undefined),
			arg.newQuoteTargetStatus === QuoteStatus.CANCELED ? getTradingFeeForQuotes(context, [arg.newQuoteId!]) : Promise.resolve(0n),
			arg.user.getBalanceInfo(),
			arg.hedger.getBalanceInfo(userAddress),
			context.viewFacetQuote.partyAPositionsCount(userAddress),
			context.viewFacetQuote.partyBPositionsCount(hedgerAddress, userAddress),
			context.viewFacetQuote.getPartyAPendingQuotes(userAddress),
			context.viewFacetQuote.getPartyBPendingQuotes(hedgerAddress, userAddress),
			getAllOpenPositions((start, size) => context.viewFacetQuote.getPartyAOpenPositions(userAddress, start, size)),
			getAllOpenPositions((start, size) => context.viewFacetQuote.getPartyBOpenPositions(hedgerAddress, userAddress, start, size)),
			context.viewFacetSymbol.getConnectedPartyBs(userAddress),
			context.viewFacet.nonceOfPartyA(userAddress),
			context.viewFacet.nonceOfPartyB(hedgerAddress, userAddress),
		])

		expect(newCollectorBalance).to.be.equal(arg.beforeOutput.feeCollectorBalance + filledTradingFee)

		if (partially) {
			if (newlyCreatedQuote === undefined) throw new Error("Partial open remainder quote was not loaded")
			expect(newlyCreatedQuote.quoteStatus).to.be.equal(arg.newQuoteTargetStatus)
			expect(newlyCreatedQuote.quantity).to.be.equal(oldQuote.quantity - arg.fillAmount)
			expect(newlyCreatedQuote.lockedValues.cva).to.equal(oldQuote.lockedValues.cva - filledLockedValues.cva)
			expect(newlyCreatedQuote.lockedValues.lf).to.equal(oldQuote.lockedValues.lf - filledLockedValues.lf)
			expect(newlyCreatedQuote.lockedValues.partyAmm).to.equal(oldQuote.lockedValues.partyAmm - filledLockedValues.partyAmm)
			expect(newlyCreatedQuote.lockedValues.partyBmm).to.equal(oldQuote.lockedValues.partyBmm - filledLockedValues.partyBmm)
		}
		expectToBeApproximately(newLockedValuesPartyA, partialWithPriceLockedValuesPartyA)

		// Check Balances partyA
		const oldBalanceInfoPartyA = arg.beforeOutput.balanceInfoPartyA
		const reservedOpenFee = await getOpenTradingFeeForQuoteWithFilledAmount(context, oldQuote.id!, arg.fillAmount)
		const executedOpenFee = await getTradingFeeForQuoteWithFilledAmount(context, newQuote.id!, arg.fillAmount)
		const openFeeDelta = executedOpenFee > reservedOpenFee ? executedOpenFee - reservedOpenFee : reservedOpenFee - executedOpenFee
		if (oldQuote.quoteStatus == BigInt(QuoteStatus.CANCEL_PENDING)) {
			expect(newBalanceInfoPartyA.totalPendingLockedPartyA).to.be.equal(
				(oldBalanceInfoPartyA.totalPendingLockedPartyA - oldLockedValuesPartyA).toString(),
			)
		} else {
			expectToBeApproximately(newBalanceInfoPartyA.totalPendingLockedPartyA, oldBalanceInfoPartyA.totalPendingLockedPartyA - partialLockedValues)
		}
		expectToBeApproximately(newBalanceInfoPartyA.totalLockedPartyA, oldBalanceInfoPartyA.totalLockedPartyA + partialWithPriceLockedValuesPartyA)
		let expectedAllocatedBalance = oldBalanceInfoPartyA.allocatedBalances
		if (executedOpenFee > reservedOpenFee) expectedAllocatedBalance -= openFeeDelta
		else expectedAllocatedBalance += openFeeDelta
		if (arg.newQuoteTargetStatus == QuoteStatus.CANCELED) {
			expectedAllocatedBalance += canceledRemainderTradingFee
			expect(newBalanceInfoPartyA.allocatedBalances).to.be.equal(expectedAllocatedBalance.toString())
		} else {
			expect(newBalanceInfoPartyA.allocatedBalances).to.be.equal(expectedAllocatedBalance.toString())
		}

		// Check Balances partyB
		const oldBalanceInfoPartyB = arg.beforeOutput.balanceInfoPartyB

		if (arg.newQuoteTargetStatus == QuoteStatus.CANCELED) {
			expect(newBalanceInfoPartyB.totalPendingLockedPartyB).to.be.equal(
				(oldBalanceInfoPartyB.totalPendingLockedPartyB - oldLockedValuesPartyB).toString(),
			)
		} else {
			expectToBeApproximately(newBalanceInfoPartyB.totalPendingLockedPartyB, oldBalanceInfoPartyB.totalPendingLockedPartyB - oldLockedValuesPartyB)
		}
		expectToBeApproximately(newBalanceInfoPartyB.totalLockedPartyB, oldBalanceInfoPartyB.totalLockedPartyB + partialWithPriceLockedValuesPartyB)
		expect(newBalanceInfoPartyB.allocatedBalances).to.be.equal(oldBalanceInfoPartyB.allocatedBalances.toString())

		// ---- Enhanced State Checks ----

		// Verify positions count increased by 1
		expect(newPositionsCountA).to.equal(arg.beforeOutput.partyAPositionsCount + 1n)

		expect(newPositionsCountB).to.equal(arg.beforeOutput.partyBPositionsCount + 1n)

		// Verify quote removed from pending arrays and added to open positions
		expect(newPartyAPendingQuotes.map(q => q.toString())).to.not.include(arg.quoteId.toString())

		expect(newPartyBPendingQuotes.map(q => q.toString())).to.not.include(arg.quoteId.toString())

		// Verify open positions arrays grew
		expect(BigInt(newPartyAOpenPositions.length)).to.equal(arg.beforeOutput.partyAOpenPositionCount + 1n)
		expect(newPartyAOpenPositions.map(q => q.id.toString())).to.include(arg.quoteId.toString())

		expect(BigInt(newPartyBOpenPositions.length)).to.equal(arg.beforeOutput.partyBOpenPositionCount + 1n)

		// Verify connection established
		expect(connectedPartyBs.map(a => a.toLowerCase())).to.include(hedgerAddress.toLowerCase())

		// Verify nonces incremented (openPosition increments both partyA and partyB nonces)
		expect(newPartyANonce).to.equal(arg.beforeOutput.partyANonce + 1n)
		expect(newPartyBNonce).to.equal(arg.beforeOutput.partyBNonce + 1n)
	}
}
