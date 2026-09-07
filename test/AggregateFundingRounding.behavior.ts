import { expect } from "chai"

import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
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
const AGGREGATED_DATA_STORAGE_SLOT = BigInt(ethers.keccak256(ethers.toUtf8Bytes("diamond.standard.storage.aggregateddata")))

const nestedMappingSlot = (baseSlot: bigint, keys: Array<{ type: string; value: string | bigint | number }>): bigint => {
	let slot = baseSlot
	for (const key of keys) {
		slot = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([key.type, "uint256"], [key.value, slot])))
	}
	return slot
}

const setSignedStorage = async (contractAddress: string, slot: bigint, value: bigint) => {
	await ethers.provider.send("hardhat_setStorageAt", [contractAddress, ethers.toBeHex(slot, 32), ethers.toBeHex(ethers.toTwos(value, 256), 32)])
}

export function shouldBehaveLikeAggregateFundingRounding(): void {
	let context: RunContext
	let user: User
	let hedger: Hedger
	let partyA: string
	let partyB: string

	const openLong = async (): Promise<bigint> => {
		const quoteId = await user.sendQuote(
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

	it("keeps the stored contribution exact through a 60%/40% partial close and clears an empty group", async function () {
		const quoteId = await openLong()
		const closedAmount = (QUANTITY * 60n) / 100n
		const remainingAmount = QUANTITY - closedAmount

		await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(QUANTITY).closePrice(OPEN_PRICE).price(OPEN_PRICE).build())
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

	it("lets only migration governance rebuild old drift and invalidates old oracle signatures", async function () {
		const quoteId = await openLong()
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const expected = (QUANTITY * quote.accumulatedPaidFunding) / FIXED_POINT_SCALE
		const commonKeys = [
			{ type: "address", value: partyB },
			{ type: "address", value: partyA },
			{ type: "uint256", value: 1n },
			{ type: "uint256", value: PositionType.LONG },
		]
		const partyAKeys = [
			{ type: "address", value: partyA },
			{ type: "address", value: partyB },
			{ type: "uint256", value: 1n },
			{ type: "uint256", value: PositionType.LONG },
		]
		const globalPartyBKeys = [
			{ type: "address", value: partyB },
			{ type: "uint256", value: 1n },
			{ type: "uint256", value: PositionType.LONG },
		]
		const partyASlot = nestedMappingSlot(AGGREGATED_DATA_STORAGE_SLOT + 10n, partyAKeys)
		const partyBSlot = nestedMappingSlot(AGGREGATED_DATA_STORAGE_SLOT + 11n, commonKeys)
		const globalPartyBSlot = nestedMappingSlot(AGGREGATED_DATA_STORAGE_SLOT + 9n, globalPartyBKeys)
		const diamond = await context.viewFacet.getAddress()
		await setSignedStorage(diamond, partyASlot, expected + 2n)
		await setSignedStorage(diamond, partyBSlot, expected + 1n)
		await setSignedStorage(diamond, globalPartyBSlot, expected + 1n)

		await expect(
			context.migrationFacet.connect(context.signers.user).resyncAggregateFunding(partyA, partyB, 1n, PositionType.LONG),
		).to.be.revertedWith("Accessibility: Must have role")

		const partyACounterBefore = await context.viewFacet.upnlCounterOfPartyA(partyA)
		const partyBCounterBefore = await context.viewFacet.upnlCounterOfPartyB(partyB, partyA)
		await expect(context.migrationFacet.connect(context.signers.admin).resyncAggregateFunding(partyA, partyB, 1n, PositionType.LONG))
			.to.emit(context.migrationFacet, "AggregateFundingResynced")
			.withArgs(partyA, partyB, 1n, PositionType.LONG, expected + 2n, expected + 1n, expected, expected + 1n, expected)

		const repaired = await aggregateValues()
		expect(repaired.partyA).to.equal(expected)
		expect(repaired.partyB).to.equal(expected)
		expect(repaired.globalPartyB).to.equal(expected)
		expect(await context.viewFacet.upnlCounterOfPartyA(partyA)).to.equal(partyACounterBefore + 1n)
		expect(await context.viewFacet.upnlCounterOfPartyB(partyB, partyA)).to.equal(partyBCounterBefore + 1n)

		await context.migrationFacet.connect(context.signers.admin).resyncAggregateFunding(partyA, partyB, 1n, PositionType.LONG)
		expect(await context.viewFacet.upnlCounterOfPartyA(partyA)).to.equal(partyACounterBefore + 1n)
		expect(await context.viewFacet.upnlCounterOfPartyB(partyB, partyA)).to.equal(partyBCounterBefore + 1n)
	})
}
