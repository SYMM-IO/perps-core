import type { QuoteSettlementDataStructOutput } from "../../src/types/facets/Settlement/ISettlementFacet.js"
import type { QuoteStructOutput } from "../../src/types/interfaces/ISymmio.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { time } from "../helpers/network-helpers.js"
import { OrderType, PositionType, QuoteStatus } from "../models/Enums.js"
import { FUZZ_CORNER_OPERATIONS, type FuzzCornerOperation } from "../models/FuzzLogTypes.js"
import { Hedger } from "../models/Hedger.js"
import type { RunContext } from "../models/RunContext.js"
import type { TestManager } from "../models/TestManager.js"
import { User } from "../models/User.js"
import { limitCloseRequestBuilder } from "../models/requestModels/CloseRequest.js"
import { emergencyCloseRequestBuilder } from "../models/requestModels/EmergencyCloseRequest.js"
import { limitOpenRequestBuilder } from "../models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { EmergencyCloseRequestValidator } from "../models/validators/EmergencyCloseRequestValidator.js"
import { decimal, getBlockTimestamp, unDecimal } from "./Common.js"
import {
	getDummyHighLowPriceSig,
	getDummyPairUpnlAndPriceSig,
	getDummyPairUpnlSig,
	getDummyPriceSig,
	getDummySettlementSig,
	getDummySingleUpnlSig,
} from "./SignatureUtils.js"

const ONE_SHOT_OPERATION: FuzzCornerOperation = "LIQUIDATE_PARTY_A"

function seedState(seed: string): number {
	let state = 0x811c9dc5
	for (let index = 0; index < seed.length; index++) {
		state ^= seed.charCodeAt(index)
		state = Math.imul(state, 0x01000193)
	}
	return state >>> 0 || 0x6d2b79f5
}

function nextRandom(state: number): { state: number; value: number } {
	const nextState = (state + 0x6d2b79f5) >>> 0
	let value = nextState
	value = Math.imul(value ^ (value >>> 15), value | 1)
	value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
	return {
		state: nextState,
		value: ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000,
	}
}

export class FuzzCornerOperationPlanner {
	private bag: FuzzCornerOperation[] = []
	private randomState: number
	private partyALiquidationSucceeded = false

	constructor(seed: string) {
		this.randomState = seedState(seed)
	}

	next(): FuzzCornerOperation {
		if (this.bag.length === 0) this.refill()
		return this.bag.pop()!
	}

	markSucceeded(operation: FuzzCornerOperation): void {
		if (operation !== ONE_SHOT_OPERATION || this.partyALiquidationSucceeded) return
		this.partyALiquidationSucceeded = true
		this.bag = this.bag.filter(candidate => candidate !== ONE_SHOT_OPERATION)
	}

	private refill(): void {
		this.bag = FUZZ_CORNER_OPERATIONS.filter(operation => !this.partyALiquidationSucceeded || operation !== ONE_SHOT_OPERATION)
		for (let index = this.bag.length - 1; index > 0; index--) {
			const random = nextRandom(this.randomState)
			this.randomState = random.state
			const swapIndex = Math.floor(random.value * (index + 1))
			;[this.bag[index], this.bag[swapIndex]] = [this.bag[swapIndex], this.bag[index]]
		}
	}
}

export type FuzzCornerCampaignOptions = {
	context: RunContext
	manager: TestManager
	reusableUser: User
	sacrificeUser: User
	hedger: Hedger
	actorIds: {
		reusableUser: string
		sacrificeUser: string
		hedger: string
	}
	seed: string
}

type OperationResult = {
	quoteIds: bigint[]
	detail: string
}

type RelationshipNonces = {
	partyA: bigint
	partyB: bigint
	partyBCross: bigint
}

function requireStatus(quote: QuoteStructOutput, expected: QuoteStatus, operation: FuzzCornerOperation): void {
	if (quote.quoteStatus !== BigInt(expected)) {
		throw new Error(
			`${operation} left quote ${quote.id} in ${QuoteStatus[Number(quote.quoteStatus)] ?? quote.quoteStatus.toString()}, expected ${QuoteStatus[expected]}`,
		)
	}
}

function requireBigInt(actual: bigint, expected: bigint, operation: FuzzCornerOperation, label: string): void {
	if (actual !== expected) {
		throw new Error(`${operation} ${label} ${actual} does not match ${expected}`)
	}
}

export class FuzzCornerCampaign {
	private readonly planner: FuzzCornerOperationPlanner

	constructor(private readonly options: FuzzCornerCampaignOptions) {
		this.planner = new FuzzCornerOperationPlanner(options.seed)
	}

	async executeNext(): Promise<FuzzCornerOperation> {
		const operation = this.planner.next()
		const actorIds =
			operation === "LIQUIDATE_PARTY_A"
				? [this.options.actorIds.sacrificeUser, this.options.actorIds.hedger]
				: [this.options.actorIds.reusableUser, this.options.actorIds.hedger]
		this.options.manager.recordCornerOperation({
			operation,
			phase: "started",
			actorIds,
		})

		try {
			const result = await this.execute(operation)
			this.planner.markSucceeded(operation)
			this.options.manager.recordCornerOperation({
				operation,
				phase: "succeeded",
				actorIds,
				quoteIds: result.quoteIds,
				detail: result.detail,
			})
			return operation
		} catch (error) {
			this.options.manager.recordCornerOperation({
				operation,
				phase: "failed",
				actorIds,
				error,
			})
			throw error
		}
	}

	private execute(operation: FuzzCornerOperation): Promise<OperationResult> {
		switch (operation) {
			case "FUNDING_CHARGE":
				return this.chargeFunding()
			case "SETTLE_UPNL":
				return this.settleUpnl()
			case "FORCE_CLOSE":
				return this.forceClose()
			case "EMERGENCY_CLOSE":
				return this.emergencyClose()
			case "EXPIRE_QUOTE":
				return this.expireQuote()
			case "LIQUIDATE_PARTY_A":
				return this.liquidatePartyA()
			case "LIQUIDATE_PARTY_B":
				return this.liquidatePartyB()
		}
	}

	private async captureNonces(user: User): Promise<RelationshipNonces> {
		const { context, hedger } = this.options
		const [partyA, partyB] = await Promise.all([user.getAddress(), hedger.getAddress()])
		const [partyANonce, partyBNonce, partyBCrossNonce] = await Promise.all([
			context.viewFacet.nonceOfPartyA(partyA),
			context.viewFacet.nonceOfPartyB(partyB, partyA),
			context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress),
		])
		return {
			partyA: partyANonce,
			partyB: partyBNonce,
			partyBCross: partyBCrossNonce,
		}
	}

	private requireNonceIncrement(
		before: RelationshipNonces,
		after: RelationshipNonces,
		operation: FuzzCornerOperation,
		expected: Partial<Record<keyof RelationshipNonces, bigint>> = {
			partyA: 1n,
			partyB: 1n,
			partyBCross: 1n,
		},
	): void {
		for (const [name, increment] of Object.entries(expected) as Array<[keyof RelationshipNonces, bigint]>) {
			requireBigInt(after[name], before[name] + increment, operation, `${name} nonce`)
		}
	}

	private async requireDisconnected(user: User, operation: FuzzCornerOperation): Promise<void> {
		const { context, hedger } = this.options
		const [partyA, partyB] = await Promise.all([user.getAddress(), hedger.getAddress()])
		const connected = await context.viewFacetSymbol.getConnectedPartyBs(partyA)
		if (connected.some(address => address.toLowerCase() === partyB.toLowerCase())) {
			throw new Error(`${operation} left ${partyA} connected to ${partyB} after its final position ended`)
		}
	}

	private async openPosition(user: User, positionType: PositionType, operation: FuzzCornerOperation): Promise<QuoteStructOutput> {
		const { context, hedger, manager } = this.options
		const hedgerAddress = await hedger.getAddress()
		const quoteId = await user.sendQuote(
			limitQuoteRequestBuilder()
				.partyBWhiteList([hedgerAddress])
				.positionType(positionType)
				.deadline((await getBlockTimestamp()) + 100_000n)
				.build(),
		)
		await manager.observeQuoteState(quoteId)

		await hedger.lockQuote(quoteId)
		await manager.observeQuoteState(quoteId)

		const locked = await context.viewFacetQuote.getQuote(quoteId)
		await hedger.openPosition(
			quoteId,
			limitOpenRequestBuilder()
				.filledAmount(locked.quantity)
				.openPrice(locked.requestedOpenPrice)
				.price(locked.requestedOpenPrice)
				.upnlPartyA(0n)
				.upnlPartyB(0n)
				.build(),
		)
		const opened = await manager.observeQuoteState(quoteId)
		requireStatus(opened, QuoteStatus.OPENED, operation)
		return opened
	}

	private async closePosition(user: User, quoteId: bigint, operation: FuzzCornerOperation): Promise<void> {
		const { hedger, manager } = this.options
		const quote = await this.options.context.viewFacetQuote.getQuote(quoteId)
		const remaining = quote.quantity - quote.closedAmount
		await user.requestToClosePosition(
			quoteId,
			limitCloseRequestBuilder()
				.quantityToClose(remaining)
				.closePrice(quote.openedPrice)
				.price(quote.openedPrice)
				.upnl(0n)
				.orderType(OrderType.LIMIT)
				.deadline((await getBlockTimestamp()) + 10_000n)
				.build(),
		)
		requireStatus(await manager.observeQuoteState(quoteId), QuoteStatus.CLOSE_PENDING, operation)

		await hedger.fillCloseRequest(quoteId, {
			filledAmount: remaining,
			closedPrice: quote.openedPrice,
			price: quote.openedPrice,
			upnlPartyA: 0n,
			upnlPartyB: 0n,
		})
		requireStatus(await manager.observeQuoteState(quoteId), QuoteStatus.CLOSED, operation)
		await this.requireDisconnected(user, operation)
	}

	private async chargeFunding(): Promise<OperationResult> {
		const { context, hedger, manager, reusableUser } = this.options
		if (!(await context.viewFacet.isAccumulatedFundingActivated())) {
			await context.pauseControlFacet.connect(context.signers.admin).activateAccumulatedFunding()
		}
		const quote = await this.openPosition(reusableUser, PositionType.LONG, "FUNDING_CHARGE")
		const symbol = await context.viewFacetSymbol.getSymbol(quote.symbolId)
		const duration = BigInt(symbol.fundingRateEpochDuration)
		const window = BigInt(symbol.fundingRateWindowTime)
		const currentEpoch = (BigInt(await time.latest()) / duration) * duration
		await time.setNextBlockTimestamp(currentEpoch + duration * 2n + window - 1n)

		const rate = decimal(1n, 16)
		const before = await context.viewFacetQuote.getQuote(quote.id)
		await hedger.chargeFundingRate(await reusableUser.getAddress(), [quote.id], [rate], await getDummyPairUpnlSig())
		const after = await manager.observeQuoteState(quote.id)
		requireStatus(after, QuoteStatus.OPENED, "FUNDING_CHARGE")
		const expectedOpenedPrice = unDecimal(before.openedPrice * (decimal(1n) + rate))
		requireBigInt(after.openedPrice, expectedOpenedPrice, "FUNDING_CHARGE", "opened price")
		await this.closePosition(reusableUser, quote.id, "FUNDING_CHARGE")
		return { quoteIds: [quote.id], detail: "legacy funding window charged and position cleaned up" }
	}

	private async settleUpnl(): Promise<OperationResult> {
		const { hedger, manager, reusableUser } = this.options
		const quote = await this.openPosition(reusableUser, PositionType.LONG, "SETTLE_UPNL")
		const partyA = await reusableUser.getAddress()
		const beforeNonces = await this.captureNonces(reusableUser)
		const [partyABalanceBefore, partyBBalanceBefore] = await Promise.all([reusableUser.getBalanceInfo(), hedger.getBalanceInfo(partyA)])
		const currentPrice = decimal(5n, 17)
		const updatedPrice = decimal(6n, 17)
		const signature = await getDummySettlementSig(
			0n,
			[0n],
			[
				{
					quoteId: quote.id,
					currentPrice,
					partyBUpnlIndex: 0n,
				} as QuoteSettlementDataStructOutput,
			],
		)
		await hedger.settleUpnl(partyA, [updatedPrice], signature)
		const settled = await manager.observeQuoteState(quote.id)
		requireStatus(settled, QuoteStatus.OPENED, "SETTLE_UPNL")
		requireBigInt(settled.openedPrice, updatedPrice, "SETTLE_UPNL", "opened price")

		const [partyABalanceAfter, partyBBalanceAfter, afterNonces] = await Promise.all([
			reusableUser.getBalanceInfo(),
			hedger.getBalanceInfo(partyA),
			this.captureNonces(reusableUser),
		])
		const openAmount = quote.quantity - quote.closedAmount
		const settlementAmount = unDecimal((updatedPrice - quote.openedPrice) * openAmount)
		requireBigInt(partyABalanceAfter.allocatedBalances, partyABalanceBefore.allocatedBalances + settlementAmount, "SETTLE_UPNL", "PartyA allocation")
		requireBigInt(partyBBalanceAfter.allocatedBalances, partyBBalanceBefore.allocatedBalances - settlementAmount, "SETTLE_UPNL", "PartyB allocation")
		this.requireNonceIncrement(beforeNonces, afterNonces, "SETTLE_UPNL")
		await this.closePosition(reusableUser, quote.id, "SETTLE_UPNL")
		return { quoteIds: [quote.id], detail: "safe price delta settled and position cleaned up" }
	}

	private async forceClose(): Promise<OperationResult> {
		const { context, manager, reusableUser } = this.options
		await context.controlFacet.connect(context.signers.admin).setForceCloseMinSigPeriod(10)
		await context.controlFacet.connect(context.signers.admin).setForceCloseGapRatio(1n, decimal(1n, 17))

		const opened = await this.openPosition(reusableUser, PositionType.SHORT, "FORCE_CLOSE")
		await reusableUser.requestToClosePosition(
			opened.id,
			limitCloseRequestBuilder()
				.quantityToClose(opened.quantity - opened.closedAmount)
				.closePrice(opened.openedPrice)
				.price(opened.openedPrice)
				.upnl(0n)
				.orderType(OrderType.LIMIT)
				.deadline((await getBlockTimestamp()) + 1_000n)
				.build(),
		)
		const closePending = await manager.observeQuoteState(opened.id)
		requireStatus(closePending, QuoteStatus.CLOSE_PENDING, "FORCE_CLOSE")
		const beforeNonces = await this.captureNonces(reusableUser)

		const now = await getBlockTimestamp()
		const cooldowns = await context.viewFacet.forceCloseCooldowns()
		const period = 100n
		const startTime = now + cooldowns[0]
		const endTime = startTime + period
		await time.increase(cooldowns[0] + period + cooldowns[1] + 1n)
		const gapRatio = await context.viewFacetSymbol.forceCloseGapRatio(opened.symbolId)
		const lowest = closePending.requestedClosePrice - unDecimal(closePending.requestedClosePrice * gapRatio)
		const currentPrice = decimal(2n)
		const signature = await getDummyHighLowPriceSig(startTime, endTime, lowest, decimal(3n), currentPrice, currentPrice, opened.symbolId, 0n, 0n)

		await context.forceCloseStepsFacet.initializeForceClose(opened.id, signature)
		await context.forceCloseStepsFacet.finalizeForceClose(opened.id, await getDummyPairUpnlAndPriceSig(currentPrice, 0n, 0n))
		const closed = await manager.observeQuoteState(opened.id)
		requireStatus(closed, QuoteStatus.CLOSED, "FORCE_CLOSE")
		requireBigInt(closed.closedAmount, closed.quantity, "FORCE_CLOSE", "closed amount")
		requireBigInt(closed.requestedClosePrice, 0n, "FORCE_CLOSE", "requested close price")
		if ((await context.viewFacet.forceCloseDetails(opened.id)).inProgress) {
			throw new Error(`FORCE_CLOSE detail for quote ${opened.id} remained in progress`)
		}
		this.requireNonceIncrement(beforeNonces, await this.captureNonces(reusableUser), "FORCE_CLOSE")
		await this.requireDisconnected(reusableUser, "FORCE_CLOSE")
		return { quoteIds: [opened.id], detail: "modern initialize/finalize workflow" }
	}

	private async emergencyClose(): Promise<OperationResult> {
		const { context, hedger, manager, reusableUser } = this.options
		const opened = await this.openPosition(reusableUser, PositionType.LONG, "EMERGENCY_CLOSE")
		const hedgerAddress = await hedger.getAddress()
		const beforeNonces = await this.captureNonces(reusableUser)
		const validator = new EmergencyCloseRequestValidator()
		const before = await validator.before(context, {
			user: reusableUser,
			hedger,
			quoteId: opened.id,
		})

		await context.pauseControlFacet.connect(context.signers.admin).setPartyBEmergencyStatus([hedgerAddress], true)
		try {
			await hedger.emergencyClosePosition(opened.id, emergencyCloseRequestBuilder().price(opened.openedPrice).upnlPartyA(0n).upnlPartyB(0n).build())
		} finally {
			await context.pauseControlFacet.connect(context.signers.admin).setPartyBEmergencyStatus([hedgerAddress], false)
		}
		await validator.after(context, {
			user: reusableUser,
			hedger,
			quoteId: opened.id,
			price: opened.openedPrice,
			beforeOutput: before,
		})
		requireStatus(await manager.observeQuoteState(opened.id), QuoteStatus.CLOSED, "EMERGENCY_CLOSE")
		this.requireNonceIncrement(beforeNonces, await this.captureNonces(reusableUser), "EMERGENCY_CLOSE")
		await this.requireDisconnected(reusableUser, "EMERGENCY_CLOSE")
		return { quoteIds: [opened.id], detail: "targeted PartyB emergency status restored after close" }
	}

	private async expireQuote(): Promise<OperationResult> {
		const { context, manager, reusableUser } = this.options
		const deadline = (await getBlockTimestamp()) + 100n
		const quoteId = await reusableUser.sendQuote(limitQuoteRequestBuilder().deadline(deadline).build())
		requireStatus(await manager.observeQuoteState(quoteId), QuoteStatus.PENDING, "EXPIRE_QUOTE")

		await time.setNextBlockTimestamp(deadline + 1n)
		await context.partyAFacet.connect(reusableUser.signer).expireQuote([quoteId])
		requireStatus(await manager.observeQuoteState(quoteId), QuoteStatus.EXPIRED, "EXPIRE_QUOTE")
		return { quoteIds: [quoteId], detail: "pending quote expired after its on-chain deadline" }
	}

	private async liquidatePartyA(): Promise<OperationResult> {
		const { hedger, manager, sacrificeUser } = this.options
		const opened = await this.openPosition(sacrificeUser, PositionType.SHORT, "LIQUIDATE_PARTY_A")
		const pendingQuoteId = await sacrificeUser.sendQuote(
			limitQuoteRequestBuilder()
				.partyBWhiteList([await hedger.getAddress()])
				.deadline((await getBlockTimestamp()) + 100_000n)
				.build(),
		)
		requireStatus(await manager.observeQuoteState(pendingQuoteId), QuoteStatus.PENDING, "LIQUIDATE_PARTY_A")
		const beforeNonces = await this.captureNonces(sacrificeUser)
		const balance = await sacrificeUser.getBalanceInfo()
		const quantity = opened.quantity - opened.closedAmount
		const targetLoss = balance.allocatedBalances + balance.totalLockedPartyA + decimal(1_000n)
		const adverseMove = (targetLoss * decimal(1n) + quantity - 1n) / quantity
		const adversePrice = opened.openedPrice + adverseMove

		await sacrificeUser.liquidateAndSetSymbolPrices([opened.symbolId], [adversePrice], [opened.id])
		await sacrificeUser.liquidatePendingPositions()
		requireStatus(await manager.observeQuoteState(pendingQuoteId), QuoteStatus.LIQUIDATED_PENDING, "LIQUIDATE_PARTY_A")
		await sacrificeUser.liquidatePositions([opened.id])
		const liquidated = await manager.observeQuoteState(opened.id)
		requireStatus(liquidated, QuoteStatus.LIQUIDATED, "LIQUIDATE_PARTY_A")
		await sacrificeUser.settleLiquidation(hedger.signer)
		if (await this.options.context.viewFacet.isPartyALiquidated(await sacrificeUser.getAddress())) {
			throw new Error(`LIQUIDATE_PARTY_A did not clear after settlement for ${await sacrificeUser.getAddress()}`)
		}
		this.requireNonceIncrement(beforeNonces, await this.captureNonces(sacrificeUser), "LIQUIDATE_PARTY_A")
		await this.requireDisconnected(sacrificeUser, "LIQUIDATE_PARTY_A")
		return { quoteIds: [opened.id, pendingQuoteId], detail: "open and pending quotes liquidated; full settlement completed; actor retired" }
	}

	private async liquidatePartyB(): Promise<OperationResult> {
		const { context, hedger, manager, reusableUser } = this.options
		const opened = await this.openPosition(reusableUser, PositionType.LONG, "LIQUIDATE_PARTY_B")
		const beforeNonces = await this.captureNonces(reusableUser)
		const partyA = await reusableUser.getAddress()
		const partyB = await hedger.getAddress()
		const balance = await hedger.getBalanceInfo(partyA)
		const available = balance.allocatedBalances - balance.lockedCva - balance.lockedLf
		const insolventUpnl = available >= 0n ? -available - 1n : 0n

		await hedger.liquidate(partyA, getDummySingleUpnlSig(insolventUpnl))
		const priceSignature = await getDummyPriceSig([opened.id], [opened.openedPrice])
		priceSignature.timestamp = await context.viewFacet.partyBLiquidationTimestamp(partyB, partyA)
		await context.partyBLiquidationFacet.connect(context.signers.liquidator).liquidatePositionsPartyB(partyB, partyA, priceSignature)
		const liquidated = await manager.observeQuoteState(opened.id)
		requireStatus(liquidated, QuoteStatus.LIQUIDATED, "LIQUIDATE_PARTY_B")
		if (await context.viewFacet.isPartyBLiquidated(partyB, partyA)) {
			throw new Error(`LIQUIDATE_PARTY_B did not clear the completed liquidation state for ${partyB}/${partyA}`)
		}
		this.requireNonceIncrement(beforeNonces, await this.captureNonces(reusableUser), "LIQUIDATE_PARTY_B")
		await this.requireDisconnected(reusableUser, "LIQUIDATE_PARTY_B")
		return { quoteIds: [opened.id], detail: "relationship liquidated and ready for reallocation" }
	}
}
