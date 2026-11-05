import { expect } from "chai"
import { id } from "ethers"

import { initializeFixture } from "../Initialize.fixture.js"
import { loadFixture } from "../helpers/network-helpers.js"
import { PositionType } from "../models/Enums.js"
import { Hedger } from "../models/Hedger.js"
import { User } from "../models/User.js"
import { limitOpenRequestBuilder } from "../models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal } from "../utils/Common.js"
import { getDummyLiquidationSig } from "../utils/SignatureUtils.js"

const PRICE = decimal(5n, 17)
// At price 0.5, PartyA loses 500 to B1 and gains 50 from B2.
// Inject a one-raw-unit oracle difference to exercise the rounding cap.
const SIGNED_UPNL = -decimal(450n) + 1n

async function twoPartyBsFixture() {
	const context = await initializeFixture()
	const user = new User(context, context.signers.user)
	await user.setup()
	await user.setBalances(decimal(5000n), decimal(1000n), decimal(497n))
	const partyA = await user.getAddress()
	const b1 = new Hedger(context, context.signers.hedger)
	const b2 = new Hedger(context, context.signers.hedger2)
	for (const hedger of [b1, b2]) {
		await hedger.setup()
		await hedger.setBalances(decimal(5000n), decimal(5000n))
	}
	const partyBs = [await b1.getAddress(), await b2.getAddress()]

	const longQuote = await user.sendQuote(limitQuoteRequestBuilder().quantity(decimal(1000n)).build())
	await b1.lockQuote(longQuote)
	await b1.openPosition(longQuote, limitOpenRequestBuilder().filledAmount(decimal(1000n)).price(decimal(1n)).build())
	const shortQuote = await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
	await b2.lockQuote(shortQuote)
	await b2.openPosition(shortQuote)

	const liquidation = context.partyALiquidationFacet.connect(context.signers.liquidator)
	const clearingHouse = context.clearingHouseFacet.connect(context.signers.liquidator)
	await context.controlFacet.grantRole(context.signers.liquidator.address, id("CLEARING_HOUSE_ROLE"))
	async function startLiquidation(signedUpnl = SIGNED_UPNL) {
		const signature = await getDummyLiquidationSig("0x10", signedUpnl, [1n], [PRICE], -decimal(500n), (await user.getBalanceInfo()).allocatedBalances)
		await liquidation.liquidatePartyA(partyA, signature)
		await liquidation.setSymbolsPrice(partyA, signature)
	}
	return { context, user, partyA, partyBs, b1, b2, longQuote, shortQuote, liquidation, clearingHouse, startLiquidation }
}

async function closedPositionsFixture() {
	const fixture = await twoPartyBsFixture()
	await fixture.startLiquidation()
	await fixture.liquidation.liquidatePositionsPartyA(fixture.partyA, [fixture.longQuote, fixture.shortQuote])
	return fixture
}

describe("Liquidation connection cleanup regressions", function () {
	it("finishes rounding when pending quotes are cleared between position batches", async function () {
		const { context, user, partyA, partyBs, b1, longQuote, shortQuote, liquidation, startLiquidation } = await loadFixture(twoPartyBsFixture)
		await b1.lockQuote(await user.sendQuote())
		await startLiquidation()

		await liquidation.liquidatePositionsPartyA(partyA, [longQuote])
		await liquidation.liquidatePendingPositionsPartyA(partyA)
		// B1 is disconnected immediately; its payment remains available through settlementStates.
		expect(await context.viewFacetSymbol.isConnectedPartyB(partyA, partyBs[0])).to.equal(false)
		await expect(liquidation.liquidatePositionsPartyA(partyA, [shortQuote])).to.not.be.reverted
		expect(await context.viewFacetSymbol.getConnectedPartyBs(partyA)).to.be.empty

		expect((await context.viewFacet.getLiquidatedStateOfPartyA(partyA)).partyAAccumulatedUpnl).to.equal(SIGNED_UPNL)
		await liquidation.settlePartyALiquidation(partyA, partyBs)
		expect(await context.viewFacet.isPartyALiquidated(partyA)).to.equal(false)
		expect(await context.viewFacetSymbol.getConnectedPartyBs(partyA)).to.be.empty
	})

	it("takes over after B1 was already disconnected at position closing", async function () {
		const { context, partyA, partyBs, longQuote, shortQuote, liquidation, clearingHouse, startLiquidation } = await loadFixture(twoPartyBsFixture)
		await startLiquidation()
		await liquidation.liquidatePositionsPartyA(partyA, [longQuote])
		expect(await context.viewFacetSymbol.isConnectedPartyB(partyA, partyBs[0])).to.equal(false)

		await clearingHouse.takeoverPartyALiquidation(partyA)
		await clearingHouse.liquidatePositionsForClearingHouse(partyA, [shortQuote], [PRICE])
		await clearingHouse.settlePartyATakeover(partyA, [partyBs[0]])

		expect(await context.viewFacet.isPartyALiquidated(partyA)).to.equal(false)
		// All quotes and settlements are closed; neither connection should remain.
		expect(await context.viewFacetSymbol.getConnectedPartyBs(partyA)).to.be.empty
		expect(await context.viewFacetSymbol.isConnectedPartyB(partyA, partyBs[0])).to.equal(false)
	})

	it("carries the reduction past empty and opposite-direction settlement batches", async function () {
		const { context, partyA, partyBs, liquidation } = await loadFixture(closedPositionsFixture)
		expect(await context.viewFacetSymbol.getConnectedPartyBs(partyA)).to.be.empty
		const settlements = await context.viewFacet.getSettlementStates(partyA, partyBs)
		const before = await Promise.all(partyBs.map(partyB => context.viewFacet.allocatedBalanceOfPartyB(partyB, partyA)))

		await liquidation.settlePartyALiquidation(partyA, [])
		expect(await context.viewFacet.getSettlementStates(partyA, partyBs)).to.deep.equal(settlements)
		await liquidation.settlePartyALiquidation(partyA, [partyBs[1]])
		expect(await context.viewFacet.isPartyALiquidated(partyA)).to.equal(true)
		await expect(liquidation.settlePartyALiquidation(partyA, [partyBs[1]])).to.be.revertedWith("LiquidationFacet: PartyB is not in settlement")
		await liquidation.settlePartyALiquidation(partyA, [partyBs[0]])
		expect(await context.viewFacet.allocatedBalanceOfPartyB(partyBs[0], partyA)).to.equal(before[0] + settlements[0].cva + decimal(500n) - 1n)
		expect(await context.viewFacet.allocatedBalanceOfPartyB(partyBs[1], partyA)).to.equal(before[1] + settlements[1].cva - decimal(50n))
		expect(await context.viewFacet.isPartyALiquidated(partyA)).to.equal(false)
	})

	for (const invalid of ["duplicate", "unknown"] as const) {
		it(`rolls back payment and the reduction when a later PartyB is ${invalid}`, async function () {
			const { context, partyA, partyBs, liquidation } = await loadFixture(closedPositionsFixture)
			const settlements = await context.viewFacet.getSettlementStates(partyA, partyBs)
			const before = await context.viewFacet.allocatedBalanceOfPartyB(partyBs[0], partyA)
			await expect(liquidation.settlePartyALiquidation(partyA, [partyBs[0], invalid === "duplicate" ? partyBs[0] : partyA])).to.be.revertedWith(
				"LiquidationFacet: PartyB is not in settlement",
			)
			expect(await context.viewFacet.getSettlementStates(partyA, partyBs)).to.deep.equal(settlements)
			expect(await context.viewFacet.allocatedBalanceOfPartyB(partyBs[0], partyA)).to.equal(before)
			await liquidation.settlePartyALiquidation(partyA, partyBs)
			expect(await context.viewFacet.allocatedBalanceOfPartyB(partyBs[0], partyA)).to.equal(before + settlements[0].cva + decimal(500n) - 1n)
			expect(await context.viewFacet.isPartyALiquidated(partyA)).to.equal(false)
		})
	}

	it("uses a dispute override exactly after an earlier settlement batch", async function () {
		const { context, partyA, partyBs, liquidation } = await loadFixture(closedPositionsFixture)
		await liquidation.settlePartyALiquidation(partyA, [partyBs[1]])
		const [settlement] = await context.viewFacet.getSettlementStates(partyA, [partyBs[0]])
		const before = await context.viewFacet.allocatedBalanceOfPartyB(partyBs[0], partyA)
		const override = -decimal(500n) + 10n
		await context.partyALiquidationFacet.connect(context.signers.admin).resolveLiquidationDispute(partyA, [partyBs[0]], [override], false)
		await liquidation.settlePartyALiquidation(partyA, [partyBs[0]])
		expect(await context.viewFacet.allocatedBalanceOfPartyB(partyBs[0], partyA)).to.equal(before + settlement.cva - override)
		expect(await context.viewFacet.isPartyALiquidated(partyA)).to.equal(false)
	})

	it("does not cap a large disputed difference after its manual resolution", async function () {
		const { context, partyA, partyBs, longQuote, shortQuote, liquidation, startLiquidation } = await loadFixture(twoPartyBsFixture)
		await startLiquidation(-decimal(450n) + 7n)
		await liquidation.liquidatePositionsPartyA(partyA, [longQuote, shortQuote])
		expect((await context.viewFacet.getLiquidatedStateOfPartyA(partyA)).disputed).to.equal(true)
		expect(await context.viewFacetSymbol.getConnectedPartyBs(partyA)).to.be.empty
		const settlements = await context.viewFacet.getSettlementStates(partyA, partyBs)
		await context.partyALiquidationFacet.connect(context.signers.admin).resolveLiquidationDispute(
			partyA,
			partyBs,
			settlements.map(settlement => settlement.actualAmount),
			false,
		)
		await liquidation.settlePartyALiquidation(partyA, partyBs)
		expect(await context.viewFacet.isPartyALiquidated(partyA)).to.equal(false)
	})

	for (const partiallySettled of [false, true]) {
		it(`takes over with an unapplied reduction ${partiallySettled ? "after one settlement batch" : "before settlement"}`, async function () {
			const { context, user, partyA, partyBs, b1, b2, liquidation, clearingHouse, startLiquidation } = await loadFixture(closedPositionsFixture)
			if (partiallySettled) await liquidation.settlePartyALiquidation(partyA, [partyBs[1]])
			await clearingHouse.takeoverPartyALiquidation(partyA)
			await expect(liquidation.settlePartyALiquidation(partyA, [partyBs[0]])).to.be.revertedWith("LiquidationFacet: Takeover in progress")
			await clearingHouse.settlePartyATakeover(partyA, partiallySettled ? [partyBs[0]] : partyBs)
			expect(await context.viewFacetSymbol.getConnectedPartyBs(partyA)).to.be.empty
			expect(await context.viewFacet.isPartyALiquidated(partyA)).to.equal(false)

			// Reuse the same PartyA for an exact-match liquidation: no old reduction may be applied.
			// Restore only the spent open fees, not another full allocation on top of the existing one.
			await user.setBalances(undefined, undefined, decimal(497n) - (await user.getBalanceInfo()).allocatedBalances)
			const longQuote = await user.sendQuote(limitQuoteRequestBuilder().quantity(decimal(1000n)).build())
			await b1.lockQuote(longQuote)
			await b1.openPosition(longQuote, limitOpenRequestBuilder().filledAmount(decimal(1000n)).price(decimal(1n)).build())
			const shortQuote = await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
			await b2.lockQuote(shortQuote)
			await b2.openPosition(shortQuote)
			await startLiquidation(-decimal(450n))
			await liquidation.liquidatePositionsPartyA(partyA, [longQuote, shortQuote])
			const [settlement] = await context.viewFacet.getSettlementStates(partyA, [partyBs[0]])
			const before = await context.viewFacet.allocatedBalanceOfPartyB(partyBs[0], partyA)
			await liquidation.settlePartyALiquidation(partyA, partyBs)
			expect(await context.viewFacet.allocatedBalanceOfPartyB(partyBs[0], partyA)).to.equal(before + settlement.cva + decimal(500n))
			expect(await context.viewFacet.isPartyALiquidated(partyA)).to.equal(false)
		})
	}
})
