import { expect } from "chai"

import { initializeFixture } from "../Initialize.fixture.js"
import { loadFixture } from "../helpers/network-helpers.js"
import { LiquidationType } from "../models/Enums.js"
import { Hedger } from "../models/Hedger.js"
import { RunContext } from "../models/RunContext.js"
import { User } from "../models/User.js"
import { limitOpenRequestBuilder } from "../models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal } from "../utils/Common.js"
import { getDummyLiquidationSig, getDummySingleUpnlSig } from "../utils/SignatureUtils.js"

// One LONG position (qty 200 @ 1, CVA 20, LF 10), no funding, no pending quotes, and exactly 100 allocated
// at the signed liquidation point.
const CVA = decimal(20n)
const LF = decimal(10n)
const QTY = decimal(200n)
const HISTORICAL_ALLOCATION = decimal(100n)

async function onePositionFixture() {
	const context = await initializeFixture()
	const user = new User(context, context.signers.user)
	await user.setup()
	await user.setBalances(decimal(5000n), decimal(1000n), decimal(101n))
	const hedger = new Hedger(context, context.signers.hedger)
	await hedger.setup()
	await hedger.setBalances(decimal(5000n), decimal(5000n))
	const quoteId = await user.sendQuote(limitQuoteRequestBuilder().quantity(QTY).cva(CVA).lf(LF).partyAmm(decimal(40n)).build())
	await hedger.lockQuote(quoteId)
	await hedger.openPosition(quoteId, limitOpenRequestBuilder().filledAmount(QTY).build())

	// Remove the open-fee noise so the signed allocation is a round number.
	const allocated = (await user.getBalanceInfo()).allocatedBalances
	if (allocated > HISTORICAL_ALLOCATION) {
		await context.accountFacet.connect(user.signer).deallocate(allocated - HISTORICAL_ALLOCATION, await getDummySingleUpnlSig())
	} else if (allocated < HISTORICAL_ALLOCATION) {
		await context.accountFacet.connect(user.signer).allocate(HISTORICAL_ALLOCATION - allocated)
	}
	expect((await user.getBalanceInfo()).allocatedBalances).to.equal(HISTORICAL_ALLOCATION)
	return { context, user, hedger, quoteId }
}

type Ledger = {
	partyA: bigint
	partyADeferred: bigint
	partyAReimbursement: bigint
	partyAEscrow: bigint
	partyB: bigint
	liquidator: bigint
	insuranceVault: bigint
	coreTokens: bigint
}

async function readLedger(context: RunContext, partyA: string, partyB: string): Promise<Ledger> {
	const [vault] = await context.viewFacet.getLiquidationInsuranceVaultParams()
	return {
		partyA: await context.viewFacet.allocatedBalanceOfPartyA(partyA),
		partyADeferred: await context.viewFacet.getPartyADeferredBalance(partyA),
		partyAReimbursement: await context.viewFacet.partyAReimbursement(partyA),
		partyAEscrow: await context.viewFacet.getLiquidationEscrow(partyA),
		partyB: await context.viewFacet.allocatedBalanceOfPartyB(partyB, partyA),
		liquidator: await context.viewFacet.allocatedBalanceOfPartyA(context.signers.liquidator.address),
		insuranceVault: await context.viewFacet.balanceOf(vault),
		coreTokens: await context.collateral.balanceOf(context.diamond),
	}
}

const internalTotal = (ledger: Ledger) =>
	ledger.partyA + ledger.partyADeferred + ledger.partyAReimbursement + ledger.partyAEscrow + ledger.partyB + ledger.liquidator + ledger.insuranceVault

type Path = "deferred" | "snapshot"

/// Signs insolvency at the historical allocation, allocates `lateAllocation` afterwards, then runs the full liquidation.
async function liquidateWithLateAllocation(path: Path, historicalShortfall: bigint, lateAllocation: bigint) {
	const { context, user, hedger, quoteId } = await loadFixture(onePositionFixture)
	const partyA = await user.getAddress()
	const partyB = await hedger.getAddress()
	const liquidator = context.signers.liquidator

	const upnl = -(HISTORICAL_ALLOCATION - CVA - LF + historicalShortfall)
	const price = decimal(1n) + (upnl * decimal(1n)) / QTY
	const sig = await getDummyLiquidationSig("0x10", upnl, [1n], [price], upnl, HISTORICAL_ALLOCATION)
	if (lateAllocation > 0n) await context.accountFacet.connect(user.signer).allocate(lateAllocation)

	const before = await readLedger(context, partyA, partyB)
	if (path === "deferred") {
		await context.partyALiquidationFacet.connect(liquidator).deferredLiquidatePartyA(partyA, sig)
		await context.partyALiquidationFacet.connect(liquidator).deferredSetSymbolsPrice(partyA, sig)
	} else {
		const snapshotSig = {
			reqId: sig.reqId,
			timestamp: sig.timestamp,
			liquidationId: sig.liquidationId,
			upnl: sig.upnl,
			totalUnrealizedLoss: sig.totalUnrealizedLoss,
			states: [{ partyB, symbolId: 1n, price, cumulativeLongFee: 0n, cumulativeShortFee: 0n }],
			liquidationBlockNumber: sig.liquidationBlockNumber,
			liquidationTimestamp: sig.liquidationTimestamp,
			liquidationAllocatedBalance: sig.liquidationAllocatedBalance,
			gatewaySignature: sig.gatewaySignature,
			sigs: sig.sigs,
		}
		await context.partyALiquidationSnapshotFacet.connect(liquidator).liquidatePartyAWithSnapshot(partyA, { ...snapshotSig, states: [] })
		await context.partyALiquidationSnapshotFacet.connect(liquidator).setSymbolsPriceWithSnapshot(partyA, snapshotSig)
	}
	const deferredAtStart = await context.viewFacet.getPartyADeferredBalance(partyA)
	const detail = await context.viewFacet.getLiquidatedStateOfPartyA(partyA)

	if (path === "deferred") {
		await context.partyALiquidationFacet.connect(liquidator).liquidatePositionsPartyA(partyA, [quoteId])
		await context.partyALiquidationFacet.connect(liquidator).settlePartyALiquidation(partyA, [partyB])
	} else {
		await context.partyALiquidationSnapshotFacet.connect(liquidator).liquidatePositionsPartyAWithSnapshot(partyA, [quoteId])
		await context.partyALiquidationSnapshotFacet.connect(liquidator).settlePartyALiquidationWithSnapshot(partyA, [partyB])
	}
	expect(await context.viewFacet.isPartyALiquidated(partyA)).to.equal(false)
	const after = await readLedger(context, partyA, partyB)

	return {
		detail,
		deferredAtStart,
		partyAReturned: after.partyA,
		partyBDelta: after.partyB - before.partyB,
		liquidatorDelta: after.liquidator - before.liquidator,
		insuranceDelta: after.insuranceVault - before.insuranceVault,
		escrowDelta: after.partyAEscrow - before.partyAEscrow,
		internalDelta: internalTotal(after) - internalTotal(before),
		coreTokenDelta: after.coreTokens - before.coreTokens,
	}
}

describe("Historical PartyA liquidation with allocation added after the signed point", function () {
	for (const path of ["deferred", "snapshot"] as const) {
		it(`${path}: returns the full later allocation and pays others from the signed allocation only`, async function () {
			// Signed: 100 allocated, uPNL -90, CVA 20, LF 10 -> threshold shortfall 20, LATE with stored deficit 10.
			const result = await liquidateWithLateAllocation(path, decimal(20n), decimal(50n))

			expect(result.detail.liquidationType).to.equal(BigInt(LiquidationType.LATE))
			expect(result.detail.deficit).to.equal(decimal(10n))
			expect(result.detail.liquidationFee).to.equal(0n)
			expect(result.deferredAtStart).to.equal(decimal(50n))

			expect(result.partyAReturned).to.equal(decimal(50n))
			expect(result.partyBDelta).to.equal(decimal(100n)) // 90 realized PnL + 10 CVA
			expect(result.liquidatorDelta).to.equal(0n)
			expect(result.insuranceDelta).to.equal(0n)
			expect(result.escrowDelta).to.equal(0n)
			expect(result.internalDelta).to.equal(0n)
			expect(result.coreTokenDelta).to.equal(0n)
		})

		// Later allocation below, equal to, and above the threshold shortfall, across NORMAL, LATE, and OVERDUE.
		for (const [shortfall, late] of [
			[20n, 10n],
			[20n, 20n],
			[20n, 50n],
			[5n, 50n],
			[45n, 50n],
		] as const) {
			it(`${path}: shortfall ${shortfall}, later allocation ${late} changes nothing for other recipients`, async function () {
				const control = await liquidateWithLateAllocation(path, decimal(shortfall), 0n)
				const result = await liquidateWithLateAllocation(path, decimal(shortfall), decimal(late))

				expect(result.detail.liquidationType).to.equal(control.detail.liquidationType)
				expect(result.detail.deficit).to.equal(control.detail.deficit)
				expect(result.detail.liquidationFee).to.equal(control.detail.liquidationFee)
				expect(result.deferredAtStart).to.equal(decimal(late))

				expect(result.partyAReturned).to.equal(control.partyAReturned + decimal(late))
				expect(result.partyBDelta).to.equal(control.partyBDelta)
				expect(result.liquidatorDelta).to.equal(control.liquidatorDelta)
				expect(result.insuranceDelta).to.equal(control.insuranceDelta)
				expect(result.escrowDelta).to.equal(control.escrowDelta)
				expect(control.internalDelta).to.equal(0n)
				expect(result.internalDelta).to.equal(0n)
				expect(result.coreTokenDelta).to.equal(0n)
			})
		}
	}
})
