import { expect } from "chai"

import { calculateGroupFunding } from "../scripts/utils/aggregateFundingResync.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { scalarGetterSlot, setSignedStorage } from "./helpers/diamond-storage.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { PositionType } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal } from "./utils/Common.js"

const FIXED_POINT_SCALE = 10n ** 18n
const EPOCH = 500n
const RATE = 10_000_000_000_000_001n
const QUANTITY = decimal(100n) + 100n
const OPEN_PRICE = decimal(10n)

export function shouldBehaveLikeAggregateFundingRounding(): void {
	let context: RunContext
	let user: User
	let hedger: Hedger
	let partyA: string
	let partyB: string

	const openLong = async (owner: User = user): Promise<bigint> => {
		const quoteId = await owner.sendQuote(
			limitQuoteRequestBuilder().positionType(PositionType.LONG).price(OPEN_PRICE).quantity(QUANTITY).maxFundingRate(decimal(1n)).build(),
		)
		await hedger.lockQuote(quoteId)
		await hedger.openPosition(quoteId, limitOpenRequestBuilder().filledAmount(QUANTITY).openPrice(OPEN_PRICE).price(OPEN_PRICE).build())
		return quoteId
	}

	const aggregateValues = async () => ({
		partyA: await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(partyA, partyB, 1n, PositionType.LONG),
		partyB: await context.viewFacetAggregate.getPartyBAggregatedFundingPerPartyA(partyB, partyA, 1n, PositionType.LONG),
		globalPartyB: await context.viewFacetAggregate.getPartyBAggregatedFunding(partyB, 1n, PositionType.LONG),
	})

	const fundingSlots = async (owner: string) => {
		const view = context.viewFacetAggregate
		const partyASlot = await scalarGetterSlot(view, "getPartyAAggregatedFundingPerPartyB", [owner, partyB, 1n, PositionType.LONG])
		const partyBSlot = await scalarGetterSlot(view, "getPartyBAggregatedFundingPerPartyA", [partyB, owner, 1n, PositionType.LONG])
		const globalPartyBSlot = await scalarGetterSlot(view, "getPartyBAggregatedFunding", [partyB, 1n, PositionType.LONG])
		return { partyASlot, partyBSlot, globalPartyBSlot }
	}

	const fundingRepair = (owner: string, expectedPartyAFunding: bigint, expectedPartyBFunding: bigint, newFunding: bigint) => ({
		partyA: owner,
		partyB,
		symbolId: 1n,
		positionType: PositionType.LONG,
		expectedPartyAFunding,
		expectedPartyBFunding,
		newFunding,
	})

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(2000n), decimal(1000n), decimal(500n))
		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(5000n), decimal(5000n))
		partyA = await user.getAddress()
		partyB = await hedger.getAddress()

		const latest = BigInt(await time.latest())
		const aligned = (latest / EPOCH + 1n) * EPOCH
		await time.setNextBlockTimestamp(Number(aligned))
		await context.pauseControlFacet.activateAccumulatedFunding()
		await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1n], [EPOCH])
		await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1n], [RATE], [0n], [decimal(1n)])
		await time.setNextBlockTimestamp(Number(aligned + EPOCH + 100n))
		await context.controlFacet.setMuonConfig(1000n, 1000n)
	})

	for (const sign of [1n, -1n]) {
		it(`keeps ${sign > 0n ? "positive" : "negative"} funding exact through a 60%/40% close, empty group, and reopen`, async function () {
			if (sign < 0n) {
				await context.fundingRateFacet.connect(hedger.signer).setFundingFee([1n], [-RATE], [0n], [decimal(1n)])
				await time.setNextBlockTimestamp((BigInt(await time.latest()) / EPOCH + 2n) * EPOCH + 100n)
				await context.controlFacet.setMuonConfig(1000n, 1000n)
			}
			const quoteId = await openLong()
			expect((await context.viewFacetQuote.getQuote(quoteId)).accumulatedPaidFunding * sign).to.be.greaterThan(0n)
			const closedAmount = (QUANTITY * 60n) / 100n
			const remainingAmount = QUANTITY - closedAmount

			await user.requestToClosePosition(
				quoteId,
				limitCloseRequestBuilder().quantityToClose(QUANTITY).closePrice(OPEN_PRICE).price(OPEN_PRICE).build(),
			)
			await hedger.fillCloseRequest(
				quoteId,
				limitFillCloseRequestBuilder().filledAmount(closedAmount).closedPrice(OPEN_PRICE).price(OPEN_PRICE).build(),
			)

			const quoteAfterPartialClose = await context.viewFacetQuote.getQuote(quoteId)
			const expectedRemaining = (remainingAmount * quoteAfterPartialClose.accumulatedPaidFunding) / FIXED_POINT_SCALE
			const afterPartialClose = await aggregateValues()
			expect(afterPartialClose.partyA).to.equal(expectedRemaining)
			expect(afterPartialClose.partyB).to.equal(expectedRemaining)
			expect(afterPartialClose.globalPartyB).to.equal(expectedRemaining)

			await hedger.fillCloseRequest(
				quoteId,
				limitFillCloseRequestBuilder().filledAmount(remainingAmount).closedPrice(OPEN_PRICE).price(OPEN_PRICE).build(),
			)
			const afterFullClose = await aggregateValues()
			expect(afterFullClose.partyA).to.equal(0n)
			expect(afterFullClose.partyB).to.equal(0n)
			expect(afterFullClose.globalPartyB).to.equal(0n)

			const reopenedQuoteId = await openLong()
			const reopenedQuote = await context.viewFacetQuote.getQuote(reopenedQuoteId)
			const expectedReopened = (QUANTITY * reopenedQuote.accumulatedPaidFunding) / FIXED_POINT_SCALE
			const afterReopen = await aggregateValues()
			expect(afterReopen.partyA).to.equal(expectedReopened)
			expect(afterReopen.partyB).to.equal(expectedReopened)
			expect(afterReopen.globalPartyB).to.equal(expectedReopened)
		})
	}

	it("returns bounded open-position pages for the off-chain repair calculation", async function () {
		const quoteIds = [await openLong(), await openLong(), await openLong()]
		const firstPage = await context.viewFacetQuote.getPartyBOpenPositions(partyB, partyA, 0n, 2n)
		const secondPage = await context.viewFacetQuote.getPartyBOpenPositions(partyB, partyA, 2n, 2n)
		const pastEnd = await context.viewFacetQuote.getPartyBOpenPositions(partyB, partyA, 3n, 1n)

		expect(firstPage.map(quote => quote.id)).to.deep.equal(quoteIds.slice(0, 2))
		expect(secondPage.map(quote => quote.id)).to.deep.equal(quoteIds.slice(2))
		expect(pastEnd).to.have.length(0)
	})

	it("matches the script's raw-unit calculation with the Solidity aggregate", async function () {
		const quote = await context.viewFacetQuote.getQuote(await openLong())
		const scriptFunding = calculateGroupFunding([quote], 1n, PositionType.LONG)
		const storedFunding = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(partyA, partyB, 1n, PositionType.LONG)

		expect(scriptFunding).to.equal(storedFunding)
	})

	it("lets only migration governance rebuild old drift and invalidates old oracle signatures", async function () {
		const quoteId = await openLong()
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const expected = (QUANTITY * quote.accumulatedPaidFunding) / FIXED_POINT_SCALE
		const { partyASlot, partyBSlot, globalPartyBSlot } = await fundingSlots(partyA)
		const diamond = await context.viewFacet.getAddress()
		await setSignedStorage(diamond, partyASlot, expected + 2n)
		await setSignedStorage(diamond, partyBSlot, expected + 1n)
		await setSignedStorage(diamond, globalPartyBSlot, expected + 1n)

		await expect(
			context.migrationFacet.connect(context.signers.user).resyncAggregateFunding([fundingRepair(partyA, expected + 2n, expected + 1n, expected)]),
		).to.be.revertedWith("Accessibility: Must have role")

		const partyACounterBefore = await context.viewFacet.upnlCounterOfPartyA(partyA)
		const partyBCounterBefore = await context.viewFacet.upnlCounterOfPartyB(partyB, partyA)
		await expect(
			context.migrationFacet.connect(context.signers.admin).resyncAggregateFunding([fundingRepair(partyA, expected + 2n, expected + 1n, expected)]),
		).to.be.revertedWith("MigrationFacet: Protocol is not globally paused")

		await context.pauseControlFacet.connect(context.signers.admin).pauseGlobal()
		await expect(
			context.migrationFacet.connect(context.signers.admin).resyncAggregateFunding([fundingRepair(partyA, expected + 3n, expected + 1n, expected)]),
		).to.be.revertedWith("MigrationFacet: PartyA funding changed")
		await expect(
			context.migrationFacet.connect(context.signers.admin).resyncAggregateFunding([fundingRepair(partyA, expected + 2n, expected + 3n, expected)]),
		).to.be.revertedWith("MigrationFacet: PartyB funding changed")

		await expect(
			context.migrationFacet.connect(context.signers.admin).resyncAggregateFunding([fundingRepair(partyA, expected + 2n, expected + 1n, expected)]),
		)
			.to.emit(context.migrationFacet, "AggregateFundingResynced")
			.withArgs(partyA, partyB, 1n, PositionType.LONG, expected + 2n, expected + 1n, expected, expected + 1n, expected)

		const repaired = await aggregateValues()
		expect(repaired.partyA).to.equal(expected)
		expect(repaired.partyB).to.equal(expected)
		expect(repaired.globalPartyB).to.equal(expected)
		expect(await context.viewFacet.upnlCounterOfPartyA(partyA)).to.equal(partyACounterBefore + 1n)
		expect(await context.viewFacet.upnlCounterOfPartyB(partyB, partyA)).to.equal(partyBCounterBefore + 1n)

		await context.migrationFacet
			.connect(context.signers.admin)
			.resyncAggregateFunding([fundingRepair(partyA, expected + 2n, expected + 1n, expected)])
		expect(await context.viewFacet.upnlCounterOfPartyA(partyA)).to.equal(partyACounterBefore + 1n)
		expect(await context.viewFacet.upnlCounterOfPartyB(partyB, partyA)).to.equal(partyBCounterBefore + 1n)
	})

	it("repairs multiple PartyAs sharing a global total and handles duplicate groups without double correction", async function () {
		const secondUser = new User(context, context.signers.user2)
		await secondUser.setup()
		await secondUser.setBalances(decimal(2000n), decimal(1000n), decimal(500n))
		const secondPartyA = await secondUser.getAddress()
		const quoteIds = [await openLong(), await openLong(secondUser)]
		const expected = await Promise.all(
			quoteIds.map(async quoteId => {
				const quote = await context.viewFacetQuote.getQuote(quoteId)
				return (QUANTITY * quote.accumulatedPaidFunding) / FIXED_POINT_SCALE
			}),
		)
		const total = expected[0] + expected[1]
		const diamond = await context.viewFacet.getAddress()
		const first = await fundingSlots(partyA)
		const second = await fundingSlots(secondPartyA)
		await setSignedStorage(diamond, first.partyASlot, expected[0] + 1n)
		await setSignedStorage(diamond, first.partyBSlot, expected[0] + 1n)
		await setSignedStorage(diamond, second.partyASlot, expected[1] + 2n)
		await setSignedStorage(diamond, second.partyBSlot, expected[1] + 2n)
		await setSignedStorage(diamond, first.globalPartyBSlot, total + 3n)
		const owners = [partyA, secondPartyA]
		const countersBefore = await Promise.all(
			owners.map(async owner => [await context.viewFacet.upnlCounterOfPartyA(owner), await context.viewFacet.upnlCounterOfPartyB(partyB, owner)]),
		)
		const groups = owners.map((owner, index) =>
			fundingRepair(owner, expected[index] + BigInt(index + 1), expected[index] + BigInt(index + 1), expected[index]),
		)
		await context.pauseControlFacet.connect(context.signers.admin).pauseGlobal()
		const tx = await context.migrationFacet.connect(context.signers.admin).resyncAggregateFunding([...groups, groups[0]])
		const receipt = await tx.wait()
		const events = receipt!.logs.flatMap(log => {
			try {
				const event = context.migrationFacet.interface.parseLog(log)
				return event?.name === "AggregateFundingResynced" ? [event] : []
			} catch {
				return []
			}
		})
		expect(events).to.have.length(3)
		expect(events.map(event => event.args.partyA)).to.deep.equal([partyA, secondPartyA, partyA])
		expect(events.map(event => event.args.newGlobalFunding)).to.deep.equal([total + 2n, total, total])
		for (const [index, owner] of owners.entries()) {
			expect(await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(owner, partyB, 1n, PositionType.LONG)).to.equal(expected[index])
			expect(await context.viewFacetAggregate.getPartyBAggregatedFundingPerPartyA(partyB, owner, 1n, PositionType.LONG)).to.equal(expected[index])
			expect(await context.viewFacet.upnlCounterOfPartyA(owner)).to.equal(countersBefore[index][0] + 1n)
			expect(await context.viewFacet.upnlCounterOfPartyB(partyB, owner)).to.equal(countersBefore[index][1] + 1n)
		}
		expect(await context.viewFacetAggregate.getPartyBAggregatedFunding(partyB, 1n, PositionType.LONG)).to.equal(total)
	})

	it("rolls back earlier repairs and counters if a later group is liquidating", async function () {
		const quote = await context.viewFacetQuote.getQuote(await openLong())
		const expected = (QUANTITY * quote.accumulatedPaidFunding) / FIXED_POINT_SCALE
		const diamond = await context.viewFacet.getAddress()
		const slots = await fundingSlots(partyA)
		for (const slot of Object.values(slots)) await setSignedStorage(diamond, slot, expected + 1n)
		const secondPartyA = context.signers.user2.address
		const liquidationSlot = await scalarGetterSlot(context.viewFacet, "isPartyBLiquidated", [partyB, secondPartyA])
		await setSignedStorage(diamond, liquidationSlot, 1n)
		expect(await context.viewFacet.isPartyBLiquidated(partyB, secondPartyA)).to.equal(true)
		const partyACounter = await context.viewFacet.upnlCounterOfPartyA(partyA)
		const partyBCounter = await context.viewFacet.upnlCounterOfPartyB(partyB, partyA)
		await context.pauseControlFacet.connect(context.signers.admin).pauseGlobal()
		await expect(
			context.migrationFacet.connect(context.signers.admin).resyncAggregateFunding([
				fundingRepair(partyA, expected + 1n, expected + 1n, expected),
				{
					partyA: secondPartyA,
					partyB,
					symbolId: 1n,
					positionType: PositionType.SHORT,
					expectedPartyAFunding: 0n,
					expectedPartyBFunding: 0n,
					newFunding: 0n,
				},
			]),
		).to.be.revertedWith("PartyBState: PartyB is in liquidation")
		const after = await aggregateValues()
		expect(after.partyA).to.equal(expected + 1n)
		expect(after.partyB).to.equal(expected + 1n)
		expect(after.globalPartyB).to.equal(expected + 1n)
		expect(await context.viewFacet.upnlCounterOfPartyA(partyA)).to.equal(partyACounter)
		expect(await context.viewFacet.upnlCounterOfPartyB(partyB, partyA)).to.equal(partyBCounter)
	})

	it("accepts an empty batch without events or counter changes", async function () {
		const before = await context.viewFacet.upnlCounterOfPartyA(partyA)
		await expect(context.migrationFacet.connect(context.signers.admin).resyncAggregateFunding([])).to.not.emit(
			context.migrationFacet,
			"AggregateFundingResynced",
		)
		expect(await context.viewFacet.upnlCounterOfPartyA(partyA)).to.equal(before)
	})
}
