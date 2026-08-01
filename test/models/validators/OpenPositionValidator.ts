import { BigNumber as BN } from "bignumber.js"
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
		const userAddress = await arg.user.getAddress()
		const hedgerAddress = await arg.hedger.getAddress()
		const quote = await context.viewFacetQuote.getQuote(arg.quoteId)
		const partyAOpenPositions = await context.viewFacetQuote.getPartyAOpenPositions(userAddress, 0, 1000)
		const partyBOpenPositions = await context.viewFacetQuote.getPartyBOpenPositions(hedgerAddress, userAddress, 0, 1000)
		return {
			balanceInfoPartyA: await arg.user.getBalanceInfo(),
			balanceInfoPartyB: await arg.hedger.getBalanceInfo(userAddress),
			quote: quote,
			feeCollectorBalance: await context.viewFacet.balanceOf(await context.viewFacet.getFeeCollector(quote.affiliate)),
			partyAPositionsCount: await context.viewFacetQuote.partyAPositionsCount(userAddress),
			partyBPositionsCount: await context.viewFacetQuote.partyBPositionsCount(hedgerAddress, userAddress),
			partyAPendingQuotes: [...(await context.viewFacetQuote.getPartyAPendingQuotes(userAddress))],
			partyBPendingQuotes: [...(await context.viewFacetQuote.getPartyBPendingQuotes(hedgerAddress, userAddress))],
			partyAOpenPositionCount: BigInt(partyAOpenPositions.length),
			partyBOpenPositionCount: BigInt(partyBOpenPositions.length),
			isConnected: (await context.viewFacetSymbol.getConnectedPartyBs(userAddress)).map(a => a.toLowerCase()).includes(hedgerAddress.toLowerCase()),
			partyANonce: await context.viewFacet.nonceOfPartyA(userAddress),
			partyBNonce: await context.viewFacet.nonceOfPartyB(hedgerAddress, userAddress),
		}
	}

	async after(context: RunContext, arg: OpenPositionValidatorAfterArg) {
		logger.debug("After OpenPositionValidator...")
		const userAddress = await arg.user.getAddress()
		const hedgerAddress = await arg.hedger.getAddress()

		// Check Quote
		const newQuote = await context.viewFacetQuote.getQuote(arg.quoteId)
		const oldQuote = arg.beforeOutput.quote
		expect(newQuote.quoteStatus).to.be.equal(QuoteStatus.OPENED)
		expect(newQuote.openedPrice).to.be.equal(arg.openedPrice)
		expect(newQuote.quantity).to.be.equal(arg.fillAmount)

		const newCollectorBalance = await context.viewFacet.balanceOf(await context.viewFacet.getFeeCollector(newQuote.affiliate))
		expect(newCollectorBalance).to.be.equal(
			arg.beforeOutput.feeCollectorBalance + (await getTradingFeeForQuoteWithFilledAmount(context, newQuote.id!, arg.fillAmount)),
		)

		const oldLockedValuesPartyA = await getTotalPartyALockedValuesForQuotes([oldQuote])
		const newLockedValuesPartyA = await getTotalPartyALockedValuesForQuotes([newQuote])

		const oldLockedValuesPartyB = await getTotalPartyBLockedValuesForQuotes([oldQuote])

		const fillAmountCoef = new BN(arg.fillAmount.toString()).div(new BN(oldQuote.quantity.toString()))
		const priceCoef = new BN(arg.openedPrice.toString()).div(new BN(oldQuote.requestedOpenPrice.toString()))
		const partially = !fillAmountCoef.eq(1)

		if (partially && arg.newQuoteId != null) {
			const newlyCreatedQuote = await context.viewFacetQuote.getQuote(arg.newQuoteId!)
			expect(newlyCreatedQuote.quoteStatus).to.be.equal(arg.newQuoteTargetStatus!)
			const lv = await getTotalPartyALockedValuesForQuotes([newlyCreatedQuote])
			expect(newlyCreatedQuote.quantity).to.be.equal(oldQuote.quantity - arg.fillAmount)
			expect(lv).to.be.equal(new BN(oldLockedValuesPartyA.toString()).times(new BN(1).minus(fillAmountCoef)).toString())
		}

		const partialLockedValues = BigInt(new BN(oldLockedValuesPartyA.toString()).times(fillAmountCoef).toFixed(0, BN.ROUND_DOWN).toString())
		const partialWithPriceLockedValuesPartyA = BigInt(
			new BN(oldLockedValuesPartyA.toString()).times(fillAmountCoef).times(priceCoef).toFixed(0, BN.ROUND_DOWN).toString(),
		)
		const partialWithPriceLockedValuesPartyB = BigInt(
			new BN(oldLockedValuesPartyB.toString()).times(fillAmountCoef).times(priceCoef).toFixed(0, BN.ROUND_DOWN).toString(),
		)
		expectToBeApproximately(newLockedValuesPartyA, partialWithPriceLockedValuesPartyA)

		// Check Balances partyA
		const newBalanceInfoPartyA = await arg.user.getBalanceInfo()
		const oldBalanceInfoPartyA = arg.beforeOutput.balanceInfoPartyA
		const reservedOpenFee = await getOpenTradingFeeForQuoteWithFilledAmount(context, oldQuote.id!, arg.fillAmount)
		const executedOpenFee = await getTradingFeeForQuoteWithFilledAmount(context, newQuote.id!, arg.fillAmount)
		const feeTrueUpDelta = executedOpenFee > reservedOpenFee ? executedOpenFee - reservedOpenFee : reservedOpenFee - executedOpenFee
		if (oldQuote.quoteStatus == BigInt(QuoteStatus.CANCEL_PENDING)) {
			expect(newBalanceInfoPartyA.totalPendingLockedPartyA).to.be.equal(
				(oldBalanceInfoPartyA.totalPendingLockedPartyA - oldLockedValuesPartyA).toString(),
			)
		} else {
			expectToBeApproximately(newBalanceInfoPartyA.totalPendingLockedPartyA, oldBalanceInfoPartyA.totalPendingLockedPartyA - partialLockedValues)
		}
		expectToBeApproximately(newBalanceInfoPartyA.totalLockedPartyA, oldBalanceInfoPartyA.totalLockedPartyA + partialWithPriceLockedValuesPartyA)
		let expectedAllocatedBalance = oldBalanceInfoPartyA.allocatedBalances
		if (executedOpenFee > reservedOpenFee) expectedAllocatedBalance -= feeTrueUpDelta
		else expectedAllocatedBalance += feeTrueUpDelta
		if (arg.newQuoteTargetStatus == QuoteStatus.CANCELED) {
			expectedAllocatedBalance += await getTradingFeeForQuotes(context, [arg.newQuoteId!])
			expect(newBalanceInfoPartyA.allocatedBalances).to.be.equal(expectedAllocatedBalance.toString())
		} else {
			expect(newBalanceInfoPartyA.allocatedBalances).to.be.equal(expectedAllocatedBalance.toString())
		}

		// Check Balances partyB
		const newBalanceInfoPartyB = await arg.hedger.getBalanceInfo(userAddress)
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
		const newPositionsCountA = await context.viewFacetQuote.partyAPositionsCount(userAddress)
		expect(newPositionsCountA).to.equal(arg.beforeOutput.partyAPositionsCount + 1n)

		const newPositionsCountB = await context.viewFacetQuote.partyBPositionsCount(hedgerAddress, userAddress)
		expect(newPositionsCountB).to.equal(arg.beforeOutput.partyBPositionsCount + 1n)

		// Verify quote removed from pending arrays and added to open positions
		const newPartyAPendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(userAddress)
		expect(newPartyAPendingQuotes.map(q => q.toString())).to.not.include(arg.quoteId.toString())

		const newPartyBPendingQuotes = await context.viewFacetQuote.getPartyBPendingQuotes(hedgerAddress, userAddress)
		expect(newPartyBPendingQuotes.map(q => q.toString())).to.not.include(arg.quoteId.toString())

		// Verify open positions arrays grew
		const newPartyAOpenPositions = await context.viewFacetQuote.getPartyAOpenPositions(userAddress, 0, 1000)
		expect(BigInt(newPartyAOpenPositions.length)).to.equal(arg.beforeOutput.partyAOpenPositionCount + 1n)
		expect(newPartyAOpenPositions.map(q => q.id.toString())).to.include(arg.quoteId.toString())

		const newPartyBOpenPositions = await context.viewFacetQuote.getPartyBOpenPositions(hedgerAddress, userAddress, 0, 1000)
		expect(BigInt(newPartyBOpenPositions.length)).to.equal(arg.beforeOutput.partyBOpenPositionCount + 1n)

		// Verify connection established
		const connectedPartyBs = await context.viewFacetSymbol.getConnectedPartyBs(userAddress)
		expect(connectedPartyBs.map(a => a.toLowerCase())).to.include(hedgerAddress.toLowerCase())

		// Verify nonces incremented (openPosition increments both partyA and partyB nonces)
		const newPartyANonce = await context.viewFacet.nonceOfPartyA(userAddress)
		expect(newPartyANonce).to.equal(arg.beforeOutput.partyANonce + 1n)
		const newPartyBNonce = await context.viewFacet.nonceOfPartyB(hedgerAddress, userAddress)
		expect(newPartyBNonce).to.equal(arg.beforeOutput.partyBNonce + 1n)
	}
}
