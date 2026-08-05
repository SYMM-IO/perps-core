import { expect } from "chai"

import { ethers } from "../../helpers/hardhat-connection.js"
import { logger } from "../../utils/LoggerUtils.js"
import { QuoteStatus } from "../Enums.js"
import type { BalanceInfo as PartyBBalanceInfo, Hedger } from "../Hedger.js"
import { RunContext } from "../RunContext.js"
import { User } from "../User.js"
import { CancelQuoteValidator, expectedQuoteIdsAfterSwapPop, type CancelQuoteValidatorBeforeOutput } from "./CancelQuoteValidator.js"
import { TransactionValidator } from "./TransactionValidator.js"

export type UnlockQuoteValidatorBeforeArg = {
	user: User
	hedger: Hedger
	quoteId: bigint
}

export type UnlockQuoteValidatorBeforeOutput = CancelQuoteValidatorBeforeOutput & {
	partyBAddress: string
	balanceInfoPartyB: PartyBBalanceInfo
	balanceInfoCrossPartyB: PartyBBalanceInfo
	partyBPendingQuotes: bigint[]
	partyBPositionsCount: bigint
	wasConnected: boolean
}

export type UnlockQuoteValidatorAfterArg = {
	user: User
	hedger: Hedger
	quoteId: bigint
	transactionBlockTimestamp: bigint
	beforeOutput: UnlockQuoteValidatorBeforeOutput
}

export function expectedUnlockQuoteStatus(deadline: bigint, transactionBlockTimestamp: bigint): QuoteStatus.PENDING | QuoteStatus.EXPIRED {
	return transactionBlockTimestamp > deadline ? QuoteStatus.EXPIRED : QuoteStatus.PENDING
}

function expectPartyBPendingLockReleased(
	after: PartyBBalanceInfo,
	before: PartyBBalanceInfo,
	quote: CancelQuoteValidatorBeforeOutput["quote"],
): void {
	const cva = BigInt(quote.lockedValues.cva)
	const lf = BigInt(quote.lockedValues.lf)
	const partyAmm = BigInt(quote.lockedValues.partyAmm)
	const partyBmm = BigInt(quote.lockedValues.partyBmm)

	expect(after.allocatedBalances).to.equal(before.allocatedBalances)
	expect(after.lockedCva).to.equal(before.lockedCva)
	expect(after.lockedLf).to.equal(before.lockedLf)
	expect(after.lockedMmPartyA).to.equal(before.lockedMmPartyA)
	expect(after.lockedMmPartyB).to.equal(before.lockedMmPartyB)
	expect(after.pendingLockedCva).to.equal(before.pendingLockedCva - cva)
	expect(after.pendingLockedLf).to.equal(before.pendingLockedLf - lf)
	expect(after.pendingLockedMmPartyA).to.equal(before.pendingLockedMmPartyA - partyAmm)
	expect(after.pendingLockedMmPartyB).to.equal(before.pendingLockedMmPartyB - partyBmm)
	expect(after.totalPendingLockedPartyA).to.equal(before.totalPendingLockedPartyA - cva - lf - partyAmm)
	expect(after.totalPendingLockedPartyB).to.equal(before.totalPendingLockedPartyB - cva - lf - partyBmm)
}

export class UnlockQuoteValidator implements TransactionValidator {
	private readonly expiryValidator = new CancelQuoteValidator()

	async before(context: RunContext, arg: UnlockQuoteValidatorBeforeArg): Promise<UnlockQuoteValidatorBeforeOutput> {
		logger.debug("Before UnlockQuoteValidator...")
		const [partyAAddress, partyBAddress, cancellation] = await Promise.all([
			arg.user.getAddress(),
			arg.hedger.getAddress(),
			this.expiryValidator.before(context, arg),
		])
		expect(cancellation.quote.quoteStatus).to.equal(QuoteStatus.LOCKED)
		expect(cancellation.quote.partyB.toLowerCase()).to.equal(partyBAddress.toLowerCase())

		const [balanceInfoPartyB, balanceInfoCrossPartyB, partyBPendingQuotes, partyBPositionsCount, connectedPartyBs, wasConnected] = await Promise.all([
			arg.hedger.getBalanceInfo(partyAAddress),
			arg.hedger.getBalanceInfoCrossPartyB(),
			context.viewFacetQuote.getPartyBPendingQuotes(partyBAddress, partyAAddress),
			context.viewFacetQuote.partyBPositionsCount(partyBAddress, partyAAddress),
			context.viewFacetSymbol.getConnectedPartyBs(partyAAddress),
			context.viewFacetSymbol.isConnectedPartyB(partyAAddress, partyBAddress),
		])
		expect(partyBPendingQuotes.map(quoteId => quoteId.toString())).to.include(arg.quoteId.toString())
		expect(connectedPartyBs.some(address => address.toLowerCase() === partyBAddress.toLowerCase())).to.equal(wasConnected)
		return {
			...cancellation,
			partyBAddress,
			balanceInfoPartyB,
			balanceInfoCrossPartyB,
			partyBPendingQuotes: [...partyBPendingQuotes],
			partyBPositionsCount,
			wasConnected,
		}
	}

	async after(context: RunContext, arg: UnlockQuoteValidatorAfterArg) {
		logger.debug("After UnlockQuoteValidator...")
		const quote = await context.viewFacetQuote.getQuote(arg.quoteId)
		const expectedStatus = expectedUnlockQuoteStatus(BigInt(arg.beforeOutput.quote.deadline), arg.transactionBlockTimestamp)
		expect(quote.quoteStatus).to.equal(expectedStatus)
		expect(BigInt(quote.statusModifyTimestamp)).to.equal(arg.transactionBlockTimestamp)

		if (expectedStatus === QuoteStatus.EXPIRED) {
			expect(quote.partyB.toLowerCase()).to.equal(arg.beforeOutput.partyBAddress.toLowerCase())
			await this.expiryValidator.after(context, {
				user: arg.user,
				quoteId: arg.quoteId,
				targetStatus: QuoteStatus.EXPIRED,
				beforeOutput: arg.beforeOutput,
			})
		} else {
			const [newBalanceInfo, pendingQuotes, positionsCount] = await Promise.all([
				arg.user.getBalanceInfo(),
				context.viewFacetQuote.getPartyAPendingQuotes(await arg.user.getAddress()),
				context.viewFacetQuote.partyAPositionsCount(await arg.user.getAddress()),
			])
			expect(newBalanceInfo).to.deep.equal(arg.beforeOutput.balanceInfoPartyA)
			expect([...pendingQuotes]).to.deep.equal(arg.beforeOutput.pendingQuotes)
			expect(positionsCount).to.equal(arg.beforeOutput.positionsCount)
			expect(quote.partyB).to.equal(ethers.ZeroAddress)
		}

		const partyAAddress = await arg.user.getAddress()
		const partyBAddress = await arg.hedger.getAddress()
		expect(partyBAddress.toLowerCase()).to.equal(arg.beforeOutput.partyBAddress.toLowerCase())
		const [balanceInfoPartyB, balanceInfoCrossPartyB, pendingQuotes, positionsCount, connectedPartyBs, isConnected] = await Promise.all([
			arg.hedger.getBalanceInfo(partyAAddress),
			arg.hedger.getBalanceInfoCrossPartyB(),
			context.viewFacetQuote.getPartyBPendingQuotes(partyBAddress, partyAAddress),
			context.viewFacetQuote.partyBPositionsCount(partyBAddress, partyAAddress),
			context.viewFacetSymbol.getConnectedPartyBs(partyAAddress),
			context.viewFacetSymbol.isConnectedPartyB(partyAAddress, partyBAddress),
		])
		expectPartyBPendingLockReleased(balanceInfoPartyB, arg.beforeOutput.balanceInfoPartyB, arg.beforeOutput.quote)
		expectPartyBPendingLockReleased(balanceInfoCrossPartyB, arg.beforeOutput.balanceInfoCrossPartyB, arg.beforeOutput.quote)
		expect([...pendingQuotes]).to.deep.equal(expectedQuoteIdsAfterSwapPop(arg.beforeOutput.partyBPendingQuotes, arg.quoteId))
		expect(positionsCount).to.equal(arg.beforeOutput.partyBPositionsCount)
		const listedAsConnected = connectedPartyBs.some(address => address.toLowerCase() === partyBAddress.toLowerCase())
		expect(listedAsConnected).to.equal(isConnected)
		expect(isConnected).to.equal(arg.beforeOutput.wasConnected && (pendingQuotes.length > 0 || positionsCount > 0n))
	}
}
