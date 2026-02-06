import { expect } from "chai"
import { ZeroAddress } from "ethers"

import type { QuoteStructOutput } from "../../../src/types/interfaces/ISymmio.js"
import { logger } from "../../utils/LoggerUtils.js"
import { QuoteStatus } from "../Enums.js"
import { Hedger, BalanceInfo as HedgerBalanceInfo } from "../Hedger.js"
import { RunContext } from "../RunContext.js"
import { BalanceInfo, User } from "../User.js"
import { TransactionValidator } from "./TransactionValidator.js"

// ==========================================
// LiquidateCrossPartyB Validator
// ==========================================

export type LiquidateCrossPartyBBeforeArg = {
	hedger: Hedger
}

export type LiquidateCrossPartyBBeforeOutput = {
	crossBalanceInfo: HedgerBalanceInfo
	partyBCrossLiquidationStatus: boolean
	partyBLiquidationTimestamp: bigint
}

export type LiquidateCrossPartyBAfterArg = {
	hedger: Hedger
	upnl: bigint
	beforeOutput: LiquidateCrossPartyBBeforeOutput
}

export class LiquidateCrossPartyBValidator implements TransactionValidator {
	async before(context: RunContext, arg: LiquidateCrossPartyBBeforeArg): Promise<LiquidateCrossPartyBBeforeOutput> {
		logger.debug("Before LiquidateCrossPartyBValidator...")
		const hedgerAddress = await arg.hedger.getAddress()
		return {
			crossBalanceInfo: await arg.hedger.getBalanceInfoCrossPartyB(),
			partyBCrossLiquidationStatus: await context.viewFacet.getPartyBCrossLiquidationStatus(hedgerAddress),
			partyBLiquidationTimestamp: await context.viewFacet.partyBLiquidationTimestamp(hedgerAddress, ZeroAddress),
		}
	}

	async after(context: RunContext, arg: LiquidateCrossPartyBAfterArg) {
		logger.debug("After LiquidateCrossPartyBValidator...")
		const hedgerAddress = await arg.hedger.getAddress()

		// Cross liquidation status should be true
		expect(await context.viewFacet.getPartyBCrossLiquidationStatus(hedgerAddress)).to.equal(true)

		// Cross liquidation details should be set
		const details = await context.viewFacet.getCrossLiquidationDetails(hedgerAddress)
		expect(details.inProgress).to.equal(true)
		expect(details.upnl).to.equal(arg.upnl)
		expect(details.deallocateForLiquidation).to.equal(0)
		expect(Number(details.timestamp)).to.be.greaterThan(0)

		// PartyB liquidation timestamp should be set for cross bucket
		const newTimestamp = await context.viewFacet.partyBLiquidationTimestamp(hedgerAddress, ZeroAddress)
		expect(Number(newTimestamp)).to.be.greaterThan(Number(arg.beforeOutput.partyBLiquidationTimestamp))
	}
}

// ==========================================
// TakeoverPartyALiquidation Validator
// ==========================================

export type TakeoverPartyALiquidationBeforeArg = {
	user: User
}

export type TakeoverPartyALiquidationBeforeOutput = {
	isLiquidated: boolean
	liquidationDetails: any
	partyAReimbursement: bigint
}

export type TakeoverPartyALiquidationAfterArg = {
	user: User
	beforeOutput: TakeoverPartyALiquidationBeforeOutput
}

export class TakeoverPartyALiquidationValidator implements TransactionValidator {
	async before(context: RunContext, arg: TakeoverPartyALiquidationBeforeArg): Promise<TakeoverPartyALiquidationBeforeOutput> {
		logger.debug("Before TakeoverPartyALiquidationValidator...")
		const userAddress = await arg.user.getAddress()
		return {
			isLiquidated: await context.viewFacet.isPartyALiquidated(userAddress),
			liquidationDetails: await context.viewFacet.getLiquidatedStateOfPartyA(userAddress),
			partyAReimbursement: await context.viewFacet.partyAReimbursement(userAddress),
		}
	}

	async after(context: RunContext, arg: TakeoverPartyALiquidationAfterArg) {
		logger.debug("After TakeoverPartyALiquidationValidator...")
		const userAddress = await arg.user.getAddress()

		// PartyA should still be liquidated
		expect(await context.viewFacet.isPartyALiquidated(userAddress)).to.equal(true)

		// Liquidation details: disputed should be false, fee should be 0
		const details = await context.viewFacet.getLiquidatedStateOfPartyA(userAddress)
		expect(details.disputed).to.equal(false)
		expect(details.liquidationFee).to.equal(0)

		// Takeover details should be set
		const takeoverDetails = await context.viewFacet.getPartyATakeoverDetails(userAddress)
		expect(takeoverDetails.inProgress).to.equal(true)
		expect(takeoverDetails.deallocatedPool).to.equal(0)
	}
}

// ==========================================
// DeallocateForClearingHouse Validator
// ==========================================

export type DeallocateForCHBeforeArg = {
	subject: string
	parties: string[]
	allocationKeys: string[]
	amounts: bigint[]
	isCrossPartyB?: boolean
}

export type DeallocateForCHBeforeOutput = {
	sourceBalances: bigint[]
	poolBefore: bigint
	isCrossPartyB: boolean
}

export type DeallocateForCHAfterArg = {
	subject: string
	parties: string[]
	allocationKeys: string[]
	amounts: bigint[]
	beforeOutput: DeallocateForCHBeforeOutput
}

export class DeallocateForCHValidator implements TransactionValidator {
	private isPartyASource(party: string, subject: string, key: string, isCrossPartyB: boolean): boolean {
		// In cross partyB liquidation, the subject is partyB, so party==subject means partyB bucket
		// In partyA takeover, the subject is partyA, so party==subject means partyA's own balances
		return party.toLowerCase() === subject.toLowerCase() && !isCrossPartyB
	}

	async before(context: RunContext, arg: DeallocateForCHBeforeArg): Promise<DeallocateForCHBeforeOutput> {
		logger.debug("Before DeallocateForCHValidator...")
		const sourceBalances: bigint[] = []

		// Determine liquidation type
		const crossDetails = await context.viewFacet.getCrossLiquidationDetails(arg.subject)
		const isCrossPartyB = arg.isCrossPartyB ?? crossDetails.inProgress

		for (let i = 0; i < arg.parties.length; i++) {
			const party = arg.parties[i]
			const key = arg.allocationKeys[i]
			if (this.isPartyASource(party, arg.subject, key, isCrossPartyB) && key === ZeroAddress) {
				// PartyA allocated balance
				sourceBalances.push(await context.viewFacet.allocatedBalanceOfPartyA(party))
			} else if (this.isPartyASource(party, arg.subject, key, isCrossPartyB) && key === "0x0000000000000000000000000000000000000001") {
				// PartyA reimbursement
				sourceBalances.push(await context.viewFacet.partyAReimbursement(party))
			} else {
				// PartyB allocated balance
				sourceBalances.push(await context.viewFacet.allocatedBalanceOfPartyB(party, key))
			}
		}

		// Get current pool
		let poolBefore = 0n
		if (isCrossPartyB) {
			poolBefore = crossDetails.deallocateForLiquidation
		} else {
			const takeoverDetails = await context.viewFacet.getPartyATakeoverDetails(arg.subject)
			if (takeoverDetails.inProgress) {
				poolBefore = takeoverDetails.deallocatedPool
			}
		}

		return { sourceBalances, poolBefore, isCrossPartyB }
	}

	async after(context: RunContext, arg: DeallocateForCHAfterArg) {
		logger.debug("After DeallocateForCHValidator...")
		const isCrossPartyB = arg.beforeOutput.isCrossPartyB

		let totalDeallocated = 0n
		for (let i = 0; i < arg.parties.length; i++) {
			const party = arg.parties[i]
			const key = arg.allocationKeys[i]
			const amount = arg.amounts[i]

			let newBalance: bigint
			if (this.isPartyASource(party, arg.subject, key, isCrossPartyB) && key === ZeroAddress) {
				newBalance = await context.viewFacet.allocatedBalanceOfPartyA(party)
			} else if (this.isPartyASource(party, arg.subject, key, isCrossPartyB) && key === "0x0000000000000000000000000000000000000001") {
				newBalance = await context.viewFacet.partyAReimbursement(party)
			} else {
				newBalance = await context.viewFacet.allocatedBalanceOfPartyB(party, key)
			}

			expect(newBalance).to.equal(arg.beforeOutput.sourceBalances[i] - amount)
			totalDeallocated += amount
		}

		// Verify pool increased
		let poolAfter = 0n
		if (isCrossPartyB) {
			const crossDetails = await context.viewFacet.getCrossLiquidationDetails(arg.subject)
			poolAfter = crossDetails.deallocateForLiquidation
		} else {
			const takeoverDetails = await context.viewFacet.getPartyATakeoverDetails(arg.subject)
			if (takeoverDetails.inProgress) {
				poolAfter = takeoverDetails.deallocatedPool
			}
		}
		expect(poolAfter).to.equal(arg.beforeOutput.poolBefore + totalDeallocated)
	}
}

// ==========================================
// DistributeForClearingHouse Validator
// ==========================================

export type DistributeForCHBeforeArg = {
	subject: string
	receivers: string[]
	allocationKeys: string[]
	amounts: bigint[]
}

export type DistributeForCHBeforeOutput = {
	receiverBalances: bigint[]
	poolBefore: bigint
}

export type DistributeForCHAfterArg = {
	subject: string
	receivers: string[]
	allocationKeys: string[]
	amounts: bigint[]
	beforeOutput: DistributeForCHBeforeOutput
}

export class DistributeForCHValidator implements TransactionValidator {
	async before(context: RunContext, arg: DistributeForCHBeforeArg): Promise<DistributeForCHBeforeOutput> {
		logger.debug("Before DistributeForCHValidator...")
		const receiverBalances: bigint[] = []

		for (let i = 0; i < arg.receivers.length; i++) {
			const receiver = arg.receivers[i]
			const key = arg.allocationKeys[i]
			const isPartyB = await context.viewFacet.isPartyB(receiver)
			if (isPartyB) {
				receiverBalances.push(await context.viewFacet.allocatedBalanceOfPartyB(receiver, key))
			} else {
				receiverBalances.push(await context.viewFacet.allocatedBalanceOfPartyA(receiver))
			}
		}

		let poolBefore = 0n
		const crossDetails = await context.viewFacet.getCrossLiquidationDetails(arg.subject)
		if (crossDetails.inProgress) {
			poolBefore = crossDetails.deallocateForLiquidation
		} else {
			const takeoverDetails = await context.viewFacet.getPartyATakeoverDetails(arg.subject)
			if (takeoverDetails.inProgress) {
				poolBefore = takeoverDetails.deallocatedPool
			}
		}

		return { receiverBalances, poolBefore }
	}

	async after(context: RunContext, arg: DistributeForCHAfterArg) {
		logger.debug("After DistributeForCHValidator...")

		let totalDistributed = 0n
		for (let i = 0; i < arg.receivers.length; i++) {
			const receiver = arg.receivers[i]
			const key = arg.allocationKeys[i]
			const amount = arg.amounts[i]
			const isPartyB = await context.viewFacet.isPartyB(receiver)

			let newBalance: bigint
			if (isPartyB) {
				newBalance = await context.viewFacet.allocatedBalanceOfPartyB(receiver, key)
			} else {
				newBalance = await context.viewFacet.allocatedBalanceOfPartyA(receiver)
			}

			expect(newBalance).to.equal(arg.beforeOutput.receiverBalances[i] + amount)
			totalDistributed += amount
		}

		// Verify pool decreased
		let poolAfter = 0n
		const crossDetails = await context.viewFacet.getCrossLiquidationDetails(arg.subject)
		if (crossDetails.inProgress) {
			poolAfter = crossDetails.deallocateForLiquidation
		} else {
			const takeoverDetails = await context.viewFacet.getPartyATakeoverDetails(arg.subject)
			if (takeoverDetails.inProgress) {
				poolAfter = takeoverDetails.deallocatedPool
			}
		}
		expect(poolAfter).to.equal(arg.beforeOutput.poolBefore - totalDistributed)
	}
}

// ==========================================
// LiquidatePendingPositionsCH Validator
// ==========================================

export type LiquidatePendingCHBeforeArg = {
	subject: string
	counterparties: string[]
	isCrossPartyB: boolean
}

export type LiquidatePendingCHBeforeOutput = {
	partyAPendingQuotes: Map<string, bigint[]>
	partyABalances: Map<string, BalanceInfo>
	pendingLockedPartyA: Map<string, bigint>
	crossPendingLocked: HedgerBalanceInfo | null
	reimbursement: bigint
}

export type LiquidatePendingCHAfterArg = {
	subject: string
	counterparties: string[]
	isCrossPartyB: boolean
	beforeOutput: LiquidatePendingCHBeforeOutput
}

export class LiquidatePendingCHValidator implements TransactionValidator {
	async before(context: RunContext, arg: LiquidatePendingCHBeforeArg): Promise<LiquidatePendingCHBeforeOutput> {
		logger.debug("Before LiquidatePendingCHValidator...")

		const partyAPendingQuotes = new Map<string, bigint[]>()
		const partyABalances = new Map<string, BalanceInfo>()
		const pendingLockedPartyA = new Map<string, bigint>()

		if (arg.isCrossPartyB) {
			for (const partyA of arg.counterparties) {
				const pending = [...(await context.viewFacetQuote.getPartyAPendingQuotes(partyA))]
				partyAPendingQuotes.set(partyA, pending)
			}
		} else {
			const pending = [...(await context.viewFacetQuote.getPartyAPendingQuotes(arg.subject))]
			partyAPendingQuotes.set(arg.subject, pending)
		}

		let crossPendingLocked: HedgerBalanceInfo | null = null
		let reimbursement = 0n

		if (!arg.isCrossPartyB) {
			reimbursement = await context.viewFacet.partyAReimbursement(arg.subject)
		}

		return {
			partyAPendingQuotes,
			partyABalances,
			pendingLockedPartyA,
			crossPendingLocked,
			reimbursement,
		}
	}

	async after(context: RunContext, arg: LiquidatePendingCHAfterArg) {
		logger.debug("After LiquidatePendingCHValidator...")

		if (arg.isCrossPartyB) {
			// For cross partyB: verify partyB's pending quotes with each partyA are cleared
			for (const partyA of arg.counterparties) {
				const newPending = await context.viewFacetQuote.getPartyAPendingQuotes(partyA)
				const oldPending = arg.beforeOutput.partyAPendingQuotes.get(partyA) ?? []

				// All quotes with this partyB should be removed
				for (const qId of newPending) {
					const q = await context.viewFacetQuote.getQuote(qId)
					expect(q.partyB).to.not.equal(arg.subject)
				}

				// Targeted quotes should have LIQUIDATED_PENDING status
				for (const qId of oldPending) {
					const q = await context.viewFacetQuote.getQuote(qId)
					if (q.partyB === arg.subject && (q.quoteStatus === BigInt(QuoteStatus.LIQUIDATED_PENDING))) {
						// Good - quote was liquidated
					}
				}
			}
		} else {
			// For partyA takeover: all pending should be cleared
			const newPending = await context.viewFacetQuote.getPartyAPendingQuotes(arg.subject)
			expect(newPending.length).to.equal(0)

			// All targeted quotes should have LIQUIDATED_PENDING status
			const oldPending = arg.beforeOutput.partyAPendingQuotes.get(arg.subject) ?? []
			for (const qId of oldPending) {
				const q = await context.viewFacetQuote.getQuote(qId)
				expect(q.quoteStatus).to.equal(QuoteStatus.LIQUIDATED_PENDING)
			}

			// Reimbursement should have increased (fees returned)
			const newReimbursement = await context.viewFacet.partyAReimbursement(arg.subject)
			expect(newReimbursement >= arg.beforeOutput.reimbursement).to.equal(true)
		}
	}
}

// ==========================================
// LiquidatePositionsCH Validator
// ==========================================

export type LiquidatePositionsCHBeforeArg = {
	subject: string
	quoteIds: bigint[]
}

export type LiquidatePositionsCHBeforeOutput = {
	quotes: QuoteStructOutput[]
	partyAPositionsCount: bigint
	partyBPositionsCounts: Map<string, bigint>
	partyAOpenPositionCount: bigint
	connectedPartyBs: string[]
	partyBNonces: Map<string, bigint>
}

export type LiquidatePositionsCHAfterArg = {
	subject: string
	quoteIds: bigint[]
	prices: bigint[]
	beforeOutput: LiquidatePositionsCHBeforeOutput
}

export class LiquidatePositionsCHValidator implements TransactionValidator {
	async before(context: RunContext, arg: LiquidatePositionsCHBeforeArg): Promise<LiquidatePositionsCHBeforeOutput> {
		logger.debug("Before LiquidatePositionsCHValidator...")
		const quotes: QuoteStructOutput[] = []
		const partyBPositionsCounts = new Map<string, bigint>()
		const partyBNonces = new Map<string, bigint>()

		let partyAForCount = ""
		for (const qId of arg.quoteIds) {
			const q = await context.viewFacetQuote.getQuote(qId)
			quotes.push(q)

			// Determine partyA for position count
			partyAForCount = q.partyA

			// Track partyB positions counts
			const key = `${q.partyB}_${q.partyA}`
			if (!partyBPositionsCounts.has(key)) {
				partyBPositionsCounts.set(key, await context.viewFacetQuote.partyBPositionsCount(q.partyB, q.partyA))
				partyBNonces.set(key, await context.viewFacet.nonceOfPartyB(q.partyB, q.partyA))
			}
		}

		const partyA = partyAForCount || arg.subject
		const partyAOpenPositions = await context.viewFacetQuote.getPartyAOpenPositions(partyA, 0, 1000)

		return {
			quotes,
			partyAPositionsCount: await context.viewFacetQuote.partyAPositionsCount(partyA),
			partyBPositionsCounts,
			partyAOpenPositionCount: BigInt(partyAOpenPositions.length),
			connectedPartyBs: [...(await context.viewFacetSymbol.getConnectedPartyBs(partyA))].map(a => a.toLowerCase()),
			partyBNonces,
		}
	}

	async after(context: RunContext, arg: LiquidatePositionsCHAfterArg) {
		logger.debug("After LiquidatePositionsCHValidator...")

		// Verify all quotes are LIQUIDATED
		for (let i = 0; i < arg.quoteIds.length; i++) {
			const q = await context.viewFacetQuote.getQuote(arg.quoteIds[i])
			expect(q.quoteStatus).to.equal(QuoteStatus.LIQUIDATED)
			expect(q.closedAmount).to.equal(q.quantity)
		}

		// Verify positions count decreased
		if (arg.beforeOutput.quotes.length > 0) {
			const partyA = arg.beforeOutput.quotes[0].partyA
			const newPositionsCount = await context.viewFacetQuote.partyAPositionsCount(partyA)
			expect(newPositionsCount).to.equal(arg.beforeOutput.partyAPositionsCount - BigInt(arg.quoteIds.length))

			// Verify open positions array shrunk
			const newOpenPositions = await context.viewFacetQuote.getPartyAOpenPositions(partyA, 0, 1000)
			expect(BigInt(newOpenPositions.length)).to.equal(arg.beforeOutput.partyAOpenPositionCount - BigInt(arg.quoteIds.length))

			// Verify liquidated quotes removed from open positions
			for (const qId of arg.quoteIds) {
				expect(newOpenPositions.map(q => q.id.toString())).to.not.include(qId.toString())
			}
		}
	}
}

// ==========================================
// SettlePartyATakeover Validator
// ==========================================

export type SettlePartyATakeoverBeforeArg = {
	user: User
}

export type SettlePartyATakeoverBeforeOutput = {
	isLiquidated: boolean
	partyANonce: bigint
	reimbursement: bigint
	balanceInfoPartyA: BalanceInfo
	takeoverDetails: any
}

export type SettlePartyATakeoverAfterArg = {
	user: User
	settledPartyBs: string[]
	beforeOutput: SettlePartyATakeoverBeforeOutput
}

export class SettlePartyATakeoverValidator implements TransactionValidator {
	async before(context: RunContext, arg: SettlePartyATakeoverBeforeArg): Promise<SettlePartyATakeoverBeforeOutput> {
		logger.debug("Before SettlePartyATakeoverValidator...")
		const userAddress = await arg.user.getAddress()
		return {
			isLiquidated: await context.viewFacet.isPartyALiquidated(userAddress),
			partyANonce: await context.viewFacet.nonceOfPartyA(userAddress),
			reimbursement: await context.viewFacet.partyAReimbursement(userAddress),
			balanceInfoPartyA: await arg.user.getBalanceInfo(),
			takeoverDetails: await context.viewFacet.getPartyATakeoverDetails(userAddress),
		}
	}

	async after(context: RunContext, arg: SettlePartyATakeoverAfterArg) {
		logger.debug("After SettlePartyATakeoverValidator...")
		const userAddress = await arg.user.getAddress()

		// Liquidation status should be cleared
		expect(await context.viewFacet.isPartyALiquidated(userAddress)).to.equal(false)

		// Nonce should be incremented
		const newNonce = await context.viewFacet.nonceOfPartyA(userAddress)
		expect(newNonce).to.equal(arg.beforeOutput.partyANonce + 1n)

		// Reimbursement should be zeroed
		expect(await context.viewFacet.partyAReimbursement(userAddress)).to.equal(0)

		// Locked balances should be zeroed
		const newBalanceInfo = await arg.user.getBalanceInfo()
		expect(newBalanceInfo.totalLockedPartyA).to.equal(0n)

		// Takeover details should be deleted (inProgress = false)
		const takeoverDetails = await context.viewFacet.getPartyATakeoverDetails(userAddress)
		expect(takeoverDetails.inProgress).to.equal(false)
		expect(takeoverDetails.deallocatedPool).to.equal(0)

		// Settlement states for settled partyBs should be deleted
		if (arg.settledPartyBs.length > 0) {
			const states = await context.viewFacet.getSettlementStates(userAddress, arg.settledPartyBs)
			for (const state of states) {
				expect(state.pending).to.equal(false)
			}
		}

		// Positions count should be 0
		const positionsCount = await context.viewFacetQuote.partyAPositionsCount(userAddress)
		expect(positionsCount).to.equal(0)

		// Pending quotes should be empty
		const pendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(userAddress)
		expect(pendingQuotes.length).to.equal(0)
	}
}

// ==========================================
// SettleCrossPartyBLiquidation Validator
// ==========================================

export type SettleCrossPartyBBeforeArg = {
	hedger: Hedger
}

export type SettleCrossPartyBBeforeOutput = {
	crossLiquidationStatus: boolean
	crossBalanceInfo: HedgerBalanceInfo
	partyBNonceCross: bigint
}

export type SettleCrossPartyBAfterArg = {
	hedger: Hedger
	beforeOutput: SettleCrossPartyBBeforeOutput
}

export class SettleCrossPartyBValidator implements TransactionValidator {
	async before(context: RunContext, arg: SettleCrossPartyBBeforeArg): Promise<SettleCrossPartyBBeforeOutput> {
		logger.debug("Before SettleCrossPartyBValidator...")
		const hedgerAddress = await arg.hedger.getAddress()
		return {
			crossLiquidationStatus: await context.viewFacet.getPartyBCrossLiquidationStatus(hedgerAddress),
			crossBalanceInfo: await arg.hedger.getBalanceInfoCrossPartyB(),
			partyBNonceCross: await context.viewFacet.nonceOfPartyB(hedgerAddress, ZeroAddress),
		}
	}

	async after(context: RunContext, arg: SettleCrossPartyBAfterArg) {
		logger.debug("After SettleCrossPartyBValidator...")
		const hedgerAddress = await arg.hedger.getAddress()

		// Cross liquidation should no longer be in progress
		expect(await context.viewFacet.getPartyBCrossLiquidationStatus(hedgerAddress)).to.equal(false)

		// Cross liquidation details timestamp should be 0
		const details = await context.viewFacet.getCrossLiquidationDetails(hedgerAddress)
		expect(details.timestamp).to.equal(0)
		expect(details.inProgress).to.equal(false)

		// Cross locked balances should be 0
		const crossBalanceInfo = await arg.hedger.getBalanceInfoCrossPartyB()
		expect(crossBalanceInfo.totalLockedPartyA).to.equal(0n)
		expect(crossBalanceInfo.totalLockedPartyB).to.equal(0n)

		// Cross positions count should be 0
		const posCount = await context.viewFacetQuote.partyBPositionsCount(hedgerAddress, ZeroAddress)
		expect(posCount).to.equal(0)
	}
}

// ==========================================
// SoftPartyBLiquidation Validator
// ==========================================

export type SoftPartyBLiquidationBeforeArg = {
	hedger: Hedger
	partyA: string
	penaltyFromAllocated: bigint
	penaltyFromBalance: bigint
}

export type SoftPartyBLiquidationBeforeOutput = {
	allocatedBalance: bigint
	hedgerBalance: bigint
	collectorBalance: bigint
	collectorAddress: string
}

export type SoftPartyBLiquidationAfterArg = {
	hedger: Hedger
	partyA: string
	penaltyFromAllocated: bigint
	penaltyFromBalance: bigint
	beforeOutput: SoftPartyBLiquidationBeforeOutput
}

export class SoftPartyBLiquidationValidator implements TransactionValidator {
	async before(context: RunContext, arg: SoftPartyBLiquidationBeforeArg): Promise<SoftPartyBLiquidationBeforeOutput> {
		logger.debug("Before SoftPartyBLiquidationValidator...")
		const hedgerAddress = await arg.hedger.getAddress()
		const collectorAddress = await context.viewFacet.getSoftLiquidationPenaltyCollector()
		return {
			allocatedBalance: await context.viewFacet.allocatedBalanceOfPartyB(hedgerAddress, arg.partyA),
			hedgerBalance: await context.viewFacet.balanceOf(hedgerAddress),
			collectorBalance: await context.viewFacet.balanceOf(collectorAddress),
			collectorAddress,
		}
	}

	async after(context: RunContext, arg: SoftPartyBLiquidationAfterArg) {
		logger.debug("After SoftPartyBLiquidationValidator...")
		const hedgerAddress = await arg.hedger.getAddress()

		// Allocated balance should decrease by penaltyFromAllocated
		const newAllocated = await context.viewFacet.allocatedBalanceOfPartyB(hedgerAddress, arg.partyA)
		expect(newAllocated).to.equal(arg.beforeOutput.allocatedBalance - arg.penaltyFromAllocated)

		// Hedger balance should decrease by penaltyFromBalance
		const newBalance = await context.viewFacet.balanceOf(hedgerAddress)
		expect(newBalance).to.equal(arg.beforeOutput.hedgerBalance - arg.penaltyFromBalance)

		// Collector balance should increase by total penalty
		const newCollectorBalance = await context.viewFacet.balanceOf(arg.beforeOutput.collectorAddress)
		expect(newCollectorBalance).to.equal(arg.beforeOutput.collectorBalance + arg.penaltyFromAllocated + arg.penaltyFromBalance)
	}
}
