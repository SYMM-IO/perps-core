import { expect } from "chai"

import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { LiquidationType, PositionType } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, getPriceFetcher } from "./utils/Common.js"
import { getDummyLiquidationSig, getDummySingleUpnlAndPriceSig } from "./utils/SignatureUtils.js"

const FIXED_POINT_SCALE = 10n ** 18n
const EPOCH = 500n
// 1e16 + 1 per epoch: an odd rate makes amount * rate / 1e18 carry a fractional part.
const RATE = 10_000_000_000_000_001n
const INCIDENT_QUANTITY = 92_203_449_000_000_000_000n
const OPEN_PRICE = decimal(10n)
// One truncation on the price PnL side and two on the funding side per position.
const ALLOWANCE_PER_POSITION = 3n

export function shouldBehaveLikeLiquidationUpnlRoundingAllowance(): void {
	let context: RunContext
	let user: User
	let hedger: Hedger
	let userAddr: string
	let hedgerAddr: string

	const mineAt = async (timestamp: bigint) => {
		await time.setNextBlockTimestamp(Number(timestamp))
		await context.controlFacet.setMuonConfig(1000n, 1000n)
	}

	const advanceEpochs = async (epochs: bigint) => {
		const now = BigInt(await time.latest())
		await mineAt((now / EPOCH + epochs) * EPOCH + 100n)
	}

	const signedState = async (partyB: string, symbolId: bigint, price: bigint) => {
		const fundingFee = await context.viewFacetSymbol.getFundingFeesOfPartyB(symbolId, partyB)
		const timestamp = BigInt(await time.latest()) + 1n
		const currentEpoch = timestamp / fundingFee.epochDuration
		const epochsSinceLastUpdate = currentEpoch - fundingFee.lastUpdatedEpoch
		const epochsBeforeLastUpdate = fundingFee.lastUpdatedEpoch - fundingFee.startEpoch
		return {
			partyB,
			symbolId,
			price,
			cumulativeLongFee:
				fundingFee.snapshotLongFee + fundingFee.accumulatedLongRate * epochsBeforeLastUpdate + fundingFee.currentLongRate * epochsSinceLastUpdate,
			cumulativeShortFee:
				fundingFee.snapshotShortFee + fundingFee.accumulatedShortRate * epochsBeforeLastUpdate + fundingFee.currentShortRate * epochsSinceLastUpdate,
		}
	}

	const snapshotSig = (sig: any, states: any[]) => ({
		reqId: sig.reqId,
		timestamp: sig.timestamp,
		liquidationId: sig.liquidationId,
		upnl: sig.upnl,
		totalUnrealizedLoss: sig.totalUnrealizedLoss,
		states,
		liquidationBlockNumber: sig.liquidationBlockNumber,
		liquidationTimestamp: sig.liquidationTimestamp,
		liquidationAllocatedBalance: sig.liquidationAllocatedBalance,
		gatewaySignature: sig.gatewaySignature,
		sigs: sig.sigs,
	})

	const openLong = async (quantity: bigint, price: bigint = OPEN_PRICE): Promise<bigint> => {
		const quoteId = await user.sendQuote(
			limitQuoteRequestBuilder()
				.positionType(PositionType.LONG)
				.price(price)
				.quantity(quantity)
				.upnlSig(getDummySingleUpnlAndPriceSig(price))
				.build(),
		)
		await hedger.lockQuote(quoteId)
		await hedger.openPosition(quoteId, limitOpenRequestBuilder().filledAmount(quantity).openPrice(price).price(price).build())
		return quoteId
	}

	/** Liquidation price that leaves the shortfall inside LF, so the liquidation is NORMAL. */
	const normalLiquidationPrice = async (quoteIds: bigint[], totalQuantity: bigint): Promise<bigint> => {
		const balance = await user.getBalanceInfo()
		const fundingDebt = await context.viewFacetQuote.getSumQuoteFundingDebts(quoteIds)
		const free = balance.allocatedBalances - balance.lockedCva - balance.lockedLf
		const targetLoss = free - fundingDebt + balance.lockedLf / 2n
		return OPEN_PRICE - ((targetLoss * FIXED_POINT_SCALE) / totalQuantity + 1n)
	}

	/** Profitable price whose uPNL leaves a zero-allocation historical snapshot in NORMAL liquidation. */
	const positiveNormalLiquidationPrice = async (quoteId: bigint, quantity: bigint): Promise<bigint> => {
		const balance = await user.getBalanceInfo()
		const fundingDebt = await context.viewFacetQuote.getSumQuoteFundingDebts([quoteId])
		const targetProfit = balance.lockedCva + balance.lockedLf / 2n
		const pnlBeforeFunding = targetProfit + fundingDebt
		return OPEN_PRICE + (pnlBeforeFunding * FIXED_POINT_SCALE + quantity - 1n) / quantity
	}

	const quoteLevelUpnl = async (quoteIds: bigint[], price: bigint): Promise<bigint> =>
		(await user.getUpnl(getPriceFetcher([1n], [price]))) - (await context.viewFacetQuote.getSumQuoteFundingDebts(quoteIds))

	/** What an O(groups) Muon computes from the aggregate views: avgOpenPrice PnL minus trunc(A*F/1e18) - W. */
	const aggregateUpnl = async (price: bigint, state: any): Promise<bigint> => {
		const [entry] = await context.viewFacetAggregate.getPartyAUpnlData(userAddr, hedgerAddr, 0, 10)
		const weightedPaid = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(userAddr, hedgerAddr, 1, PositionType.LONG)
		const funding = (entry.aggregatedAmount * state.cumulativeLongFee) / FIXED_POINT_SCALE - weightedPaid
		const pnl = ((price - entry.avgOpenPrice) * entry.aggregatedAmount) / FIXED_POINT_SCALE
		return pnl - funding
	}

	const startLiquidation = async (
		signedUpnl: bigint,
		price: bigint,
		state: any,
		overrides: { totalUnrealizedLoss?: bigint; liquidationAllocatedBalance?: bigint } = {},
	) => {
		const allocated = overrides.liquidationAllocatedBalance ?? (await user.getBalanceInfo()).allocatedBalances
		const totalUnrealizedLoss = overrides.totalUnrealizedLoss ?? signedUpnl
		const sig = await getDummyLiquidationSig("0x10", signedUpnl, [1n], [price], totalUnrealizedLoss, allocated)
		const facet = context.partyALiquidationSnapshotFacet.connect(context.signers.liquidator)
		await facet.liquidatePartyAWithSnapshot(userAddr, snapshotSig(sig, []))
		await facet.setSymbolsPriceWithSnapshot(userAddr, snapshotSig(sig, [state]))
		return facet
	}

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(2000n), decimal(1000n), decimal(500n))
		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(5000n), decimal(5000n))
		userAddr = await user.getAddress()
		hedgerAddr = await hedger.getAddress()

		const latest = BigInt(await time.latest())
		const aligned = (latest / EPOCH + 1n) * EPOCH
		await time.setNextBlockTimestamp(Number(aligned))
		await context.pauseControlFacet.activateAccumulatedFunding()
		await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EPOCH])
		await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [RATE], [0n], [decimal(1n)])
		// Open one epoch after the rate was set so accumulatedPaidFunding is a non-zero fractional contribution.
		await mineAt(aligned + EPOCH + 100n)
	})

	describe("position count captured at liquidation start", function () {
		it("records the open position count when liquidation starts and clears it after settlement", async function () {
			const quoteA = await openLong(INCIDENT_QUANTITY / 2n)
			const quoteB = await openLong(INCIDENT_QUANTITY / 2n)
			await advanceEpochs(4n)
			const price = await normalLiquidationPrice([quoteA, quoteB], INCIDENT_QUANTITY)
			const state = await signedState(hedgerAddr, 1n, price)
			const facet = await startLiquidation(await quoteLevelUpnl([quoteA, quoteB], price), price, state)

			expect(await context.viewFacet.liquidationStartPositionCount(userAddr)).to.equal(2n)

			await facet.liquidatePositionsPartyAWithSnapshot(userAddr, [quoteA, quoteB])
			await facet.settlePartyALiquidationWithSnapshot(userAddr, [hedgerAddr])
			expect(await context.viewFacet.liquidationStartPositionCount(userAddr)).to.equal(0n)
		})
	})

	describe("bounded dispute check", function () {
		let quoteId: bigint
		let price: bigint
		let state: any
		let settledUpnl: bigint
		let signedUpnl: bigint

		beforeEach(async function () {
			quoteId = await openLong(INCIDENT_QUANTITY)
			// Four epochs later the aggregate decomposition drops one more unit than the per-quote formula.
			await advanceEpochs(4n)
			price = await normalLiquidationPrice([quoteId], INCIDENT_QUANTITY)
			state = await signedState(hedgerAddr, 1n, price)
			settledUpnl = await quoteLevelUpnl([quoteId], price)
			signedUpnl = await aggregateUpnl(price, state)
			expect(signedUpnl - settledUpnl).to.equal(-1n)
		})

		it("accepts one-unit rounding without configuration", async function () {
			const facet = await startLiquidation(signedUpnl, price, state)
			await facet.liquidatePositionsPartyAWithSnapshot(userAddr, [quoteId])
			expect((await user.getLiquidatedStateOfPartyA()).disputed).to.equal(false)
		})

		it("uses the quote loss when it is smaller than the signed loss", async function () {
			const facet = await startLiquidation(signedUpnl, price, state)
			expect((await user.getLiquidatedStateOfPartyA()).liquidationType).to.equal(BigInt(LiquidationType.NORMAL))
			const hedgerBefore = await hedger.getBalanceInfo(userAddr)

			await facet.liquidatePositionsPartyAWithSnapshot(userAddr, [quoteId])
			const [settlement] = await context.viewFacet.getSettlementStates(userAddr, [hedgerAddr])
			expect(settlement.expectedAmount).to.equal(settledUpnl)

			const detail = await user.getLiquidatedStateOfPartyA()
			expect(detail.disputed).to.equal(false)
			expect(detail.upnl).to.equal(signedUpnl)
			expect(detail.partyAAccumulatedUpnl).to.equal(settledUpnl)

			await expect(facet.settlePartyALiquidationWithSnapshot(userAddr, [hedgerAddr])).to.not.be.reverted
			expect(await context.viewFacet.isPartyALiquidated(userAddr)).to.equal(false)
			const hedgerAfter = await hedger.getBalanceInfo(userAddr)
			// The quote-level loss is already the smaller amount, so PartyB receives it plus CVA.
			expect(hedgerAfter.allocatedBalances - hedgerBefore.allocatedBalances).to.equal(-settledUpnl + settlement.cva)
		})

		it("caps the quote loss when it is larger than the signed loss", async function () {
			const smallerSignedLoss = settledUpnl + 1n
			const facet = await startLiquidation(smallerSignedLoss, price, state)
			const hedgerBefore = await hedger.getBalanceInfo(userAddr)

			await facet.liquidatePositionsPartyAWithSnapshot(userAddr, [quoteId])
			const [settlement] = await context.viewFacet.getSettlementStates(userAddr, [hedgerAddr])
			expect(settlement.expectedAmount).to.equal(smallerSignedLoss)
			expect(settlement.actualAmount).to.equal(smallerSignedLoss)
			expect((await user.getLiquidatedStateOfPartyA()).partyAAccumulatedUpnl).to.equal(smallerSignedLoss)

			await facet.settlePartyALiquidationWithSnapshot(userAddr, [hedgerAddr])
			const hedgerAfter = await hedger.getBalanceInfo(userAddr)
			expect(hedgerAfter.allocatedBalances - hedgerBefore.allocatedBalances).to.equal(-smallerSignedLoss + settlement.cva)
		})

		it("settles without a cap when signed and settled uPNL are equal", async function () {
			const facet = await startLiquidation(settledUpnl, price, state)
			await facet.liquidatePositionsPartyAWithSnapshot(userAddr, [quoteId])
			expect((await user.getLiquidatedStateOfPartyA()).disputed).to.equal(false)
		})

		it("accepts a difference exactly at the allowance", async function () {
			const facet = await startLiquidation(settledUpnl - ALLOWANCE_PER_POSITION, price, state)
			await facet.liquidatePositionsPartyAWithSnapshot(userAddr, [quoteId])
			expect((await user.getLiquidatedStateOfPartyA()).disputed).to.equal(false)
		})

		it("still disputes a difference one unit above the allowance", async function () {
			const facet = await startLiquidation(settledUpnl - ALLOWANCE_PER_POSITION - 1n, price, state)
			await facet.liquidatePositionsPartyAWithSnapshot(userAddr, [quoteId])
			expect((await user.getLiquidatedStateOfPartyA()).disputed).to.equal(true)
		})

		it("still disputes a signed value that is too optimistic by more than the allowance", async function () {
			const facet = await startLiquidation(settledUpnl + ALLOWANCE_PER_POSITION + 1n, price, state)
			await facet.liquidatePositionsPartyAWithSnapshot(userAddr, [quoteId])
			expect((await user.getLiquidatedStateOfPartyA()).disputed).to.equal(true)
		})

		it("still disputes a genuinely wrong price in the signature", async function () {
			const wrongState = { ...state, price: price - decimal(1n, 15) }
			const facet = await startLiquidation(signedUpnl, price, wrongState)
			await facet.liquidatePositionsPartyAWithSnapshot(userAddr, [quoteId])
			expect((await user.getLiquidatedStateOfPartyA()).disputed).to.equal(true)
		})
	})

	describe("OVERDUE loss rounding", function () {
		it("saturates a one-unit loss mismatch instead of reverting", async function () {
			const quoteId = await openLong(INCIDENT_QUANTITY)
			await advanceEpochs(4n)
			const price = await normalLiquidationPrice([quoteId], INCIDENT_QUANTITY)
			const state = await signedState(hedgerAddr, 1n, price)
			const signedUpnl = await quoteLevelUpnl([quoteId], price)
			const facet = await startLiquidation(signedUpnl, price, state, {
				liquidationAllocatedBalance: 0n,
				totalUnrealizedLoss: signedUpnl + 1n,
			})

			expect((await user.getLiquidatedStateOfPartyA()).liquidationType).to.equal(BigInt(LiquidationType.OVERDUE))
			await expect(facet.liquidatePositionsPartyAWithSnapshot(userAddr, [quoteId])).to.not.be.reverted
		})
	})

	describe("positive uPNL rounding", function () {
		it("caps PartyB's payment when the quote profit is larger than the signed profit", async function () {
			const quoteId = await openLong(INCIDENT_QUANTITY)
			await advanceEpochs(4n)
			const price = await positiveNormalLiquidationPrice(quoteId, INCIDENT_QUANTITY)
			const state = await signedState(hedgerAddr, 1n, price)
			const quoteProfit = await quoteLevelUpnl([quoteId], price)
			const signedProfit = quoteProfit - 1n
			const facet = await startLiquidation(signedProfit, price, state, { liquidationAllocatedBalance: 0n })
			const hedgerBefore = await hedger.getBalanceInfo(userAddr)

			expect(signedProfit).to.be.greaterThan(0n)
			expect((await user.getLiquidatedStateOfPartyA()).liquidationType).to.equal(BigInt(LiquidationType.NORMAL))
			await facet.liquidatePositionsPartyAWithSnapshot(userAddr, [quoteId])
			const [settlement] = await context.viewFacet.getSettlementStates(userAddr, [hedgerAddr])
			expect(settlement.expectedAmount).to.equal(signedProfit)
			expect(settlement.actualAmount).to.equal(signedProfit)

			await facet.settlePartyALiquidationWithSnapshot(userAddr, [hedgerAddr])
			const hedgerAfter = await hedger.getBalanceInfo(userAddr)
			expect(hedgerAfter.allocatedBalances - hedgerBefore.allocatedBalances).to.equal(settlement.cva - signedProfit)
		})

		it("restores only the quote profit when it is smaller than the signed profit", async function () {
			const quoteId = await openLong(INCIDENT_QUANTITY)
			await advanceEpochs(4n)
			const balanceBefore = await user.getBalanceInfo()
			const price = await positiveNormalLiquidationPrice(quoteId, INCIDENT_QUANTITY)
			const state = await signedState(hedgerAddr, 1n, price)
			const quoteProfit = await quoteLevelUpnl([quoteId], price)
			const signedProfit = quoteProfit + 1n
			const facet = await startLiquidation(signedProfit, price, state, { liquidationAllocatedBalance: 0n })

			await facet.liquidatePositionsPartyAWithSnapshot(userAddr, [quoteId])
			await facet.settlePartyALiquidationWithSnapshot(userAddr, [hedgerAddr])
			const balanceAfter = await user.getBalanceInfo()
			expect(balanceAfter.allocatedBalances).to.equal(
				balanceBefore.allocatedBalances - balanceBefore.lockedCva - balanceBefore.lockedLf + quoteProfit,
			)
		})
	})

	describe("allowance scales with the position count captured at start", function () {
		let quoteA: bigint
		let quoteB: bigint
		let price: bigint
		let state: any
		let settledUpnl: bigint

		beforeEach(async function () {
			quoteA = await openLong(INCIDENT_QUANTITY / 2n)
			quoteB = await openLong(INCIDENT_QUANTITY / 2n)
			await advanceEpochs(4n)
			price = await normalLiquidationPrice([quoteA, quoteB], INCIDENT_QUANTITY)
			state = await signedState(hedgerAddr, 1n, price)
			settledUpnl = await quoteLevelUpnl([quoteA, quoteB], price)
		})

		it("accepts twice the per-position allowance for two positions even when they close in separate batches", async function () {
			const facet = await startLiquidation(settledUpnl - 2n * ALLOWANCE_PER_POSITION, price, state)
			await facet.liquidatePositionsPartyAWithSnapshot(userAddr, [quoteA])
			expect((await user.getLiquidatedStateOfPartyA()).disputed).to.equal(false)
			await facet.liquidatePositionsPartyAWithSnapshot(userAddr, [quoteB])
			expect((await user.getLiquidatedStateOfPartyA()).disputed).to.equal(false)
		})

		it("disputes one unit beyond twice the per-position allowance", async function () {
			const facet = await startLiquidation(settledUpnl - 2n * ALLOWANCE_PER_POSITION - 1n, price, state)
			await facet.liquidatePositionsPartyAWithSnapshot(userAddr, [quoteA, quoteB])
			expect((await user.getLiquidatedStateOfPartyA()).disputed).to.equal(true)
		})
	})
}
