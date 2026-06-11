import { expect } from "chai"
import { ethers, toUtf8Bytes } from "ethers"

import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { PositionType } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp, getQuoteQuantity, unDecimal } from "./utils/Common.js"
import { getDummyHighLowPriceSig, getDummyPairUpnlAndPriceSig, getDummyPairUpnlSig, getDummySingleUpnlSig } from "./utils/SignatureUtils.js"

export function shouldBehaveLikeFundingRate(): void {
	let context: RunContext, user: User, hedger: Hedger, hedger2: Hedger

	const EightHourInSec = 28800
	const NineHourInSec = 32400

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(5000n), decimal(5000n), decimal(5000n))

		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setBalances(decimal(5000n), decimal(5000n))

		await user.sendQuote()
		await hedger.lockQuote(1)
		await hedger.openPosition(1)

		await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
		await hedger.lockQuote(2)
		await hedger.openPosition(2)
		await user.requestToClosePosition(2)

		await user.sendQuote()
		await hedger.lockQuote(3)
		await hedger.openPosition(3)
		await user.requestToClosePosition(3)
		await hedger.fillCloseRequest(3)

		await context.pauseControlFacet.connect(context.signers.admin).activateAccumulatedFunding()
	})

	it("Should fail on different length", async function () {
		await expect(hedger.chargeFundingRate(await context.signers.user.getAddress(), [1], [], await getDummyPairUpnlSig())).to.be.revertedWith(
			"ChargeFundingFacet: Length not match",
		)
	})

	it("Should fail on invalid quote for partyB", async function () {
		await expect(hedger.chargeFundingRate(await context.signers.user2.getAddress(), [1], [1], await getDummyPairUpnlSig())).to.be.revertedWith(
			"ChargeFundingFacet: Invalid quote",
		)
	})

	it("Should fail on invalid quote state", async function () {
		await expect(hedger.chargeFundingRate(await context.signers.user.getAddress(), [3], [1], await getDummyPairUpnlSig())).to.be.revertedWith(
			"LibQuote: Invalid state",
		)
	})

	it("Should fail on out of window request", async function () {
		let symbol = await context.viewFacetSymbol.getSymbol(1)
		let duration = symbol.fundingRateEpochDuration
		let window = symbol.fundingRateWindowTime
		let currentEpoch = (BigInt(await time.latest()) / duration) * duration
		let targetTime = duration * 2n + window + 1n + currentEpoch

		await time.setNextBlockTimestamp(targetTime)
		await expect(hedger.chargeFundingRate(await context.signers.user.getAddress(), [1], [1], await getDummyPairUpnlSig())).to.be.revertedWith(
			"ChargeFundingFacet: Current timestamp is out of window",
		)
	})

	it("Should fail on insolvent partyA", async function () {
		let symbol = await context.viewFacetSymbol.getSymbol(1)
		let duration = symbol.fundingRateEpochDuration
		let window = symbol.fundingRateWindowTime
		let currentEpoch = (BigInt(await time.latest()) / duration) * duration
		let targetTime = duration * 2n + window - 1n + currentEpoch

		await time.setNextBlockTimestamp(targetTime)
		await expect(
			hedger.chargeFundingRate(await context.signers.user.getAddress(), [1], [decimal(1n, 16)], await getDummyPairUpnlSig(decimal(4970n) * -1n)),
		).to.be.revertedWith("ChargeFundingFacet: PartyA will be insolvent")
	})

	it("should failed when the caller is not same as partyB of quote", async function () {
		await expect(
			context.fundingRateFacet
				.connect(context.signers.hedger2)
				.chargeFundingRate(await context.signers.user.getAddress(), [1], [decimal(1n, 16)], await getDummyPairUpnlSig()),
		).to.be.revertedWith("ChargeFundingFacet: Sender isn't partyB of quote")
	})

	it("reverts accumulated charge if it makes partyA insolvent", async () => {
		// set epoch + fees
		await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
		await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(5n, 16)], [0], [decimal(1n)])
		await time.increase(EightHourInSec * 6) // accumulate some

		await expect(
			context.fundingRateFacet.connect(context.signers.hedger).chargeAccumulatedFundingFee(
				await context.signers.user.getAddress(),
				await context.signers.hedger.getAddress(),
				[1],
				await getDummyPairUpnlSig(decimal(10_000n) * -1n, BigInt(0)), // make A look poor
			),
		).to.be.revertedWith("FundingRateFacet: PartyA will be insolvent")
	})

	it("reverts on paying twice in the same window", async () => {
		let symbol = await context.viewFacetSymbol.getSymbol(1)
		let duration = symbol.fundingRateEpochDuration
		let window = symbol.fundingRateWindowTime
		let currentEpoch = (BigInt(await time.latest()) / duration) * duration
		let targetTime = duration * 2n + window - 1n + currentEpoch

		await time.setNextBlockTimestamp(targetTime)
		await hedger.chargeFundingRate(await context.signers.user.getAddress(), [1], [decimal(1n, 16)], await getDummyPairUpnlSig())

		await expect(
			hedger.chargeFundingRate(await context.signers.user.getAddress(), [1], [decimal(1n, 16)], await getDummyPairUpnlSig()),
		).to.be.revertedWith("ChargeFundingFacet: Funding already paid for this window")
	})

	it("Should fail on insolvent partyB", async function () {
		let symbol = await context.viewFacetSymbol.getSymbol(1)
		let duration = symbol.fundingRateEpochDuration
		let window = symbol.fundingRateWindowTime
		let currentEpoch = (BigInt(await time.latest()) / duration) * duration
		let targetTime = duration * 2n + window - 1n + currentEpoch

		await time.setNextBlockTimestamp(targetTime)
		await expect(
			hedger.chargeFundingRate(
				await context.signers.user.getAddress(),
				[1],
				[decimal(1n, 15)],
				await getDummyPairUpnlSig(BigInt(0), decimal(4970n) * -1n),
			),
		).to.be.revertedWith("ChargeFundingFacet: PartyB will be insolvent")
	})

	it("Should run successfully for long", async function () {
		let symbol = await context.viewFacetSymbol.getSymbol(1)
		let duration = symbol.fundingRateEpochDuration
		let window = symbol.fundingRateWindowTime
		let currentEpoch = (BigInt(await time.latest()) / duration) * duration
		let targetTime = duration * 2n + window - 1n + currentEpoch

		let oldQuote = await context.viewFacetQuote.getQuote(1)

		await time.setNextBlockTimestamp(targetTime)
		await hedger.chargeFundingRate(await context.signers.user.getAddress(), [1], [decimal(1n, 16)], await getDummyPairUpnlSig())

		let newQuote = await context.viewFacetQuote.getQuote(1)
		expect(newQuote.openedPrice).to.be.equal(unDecimal(oldQuote.openedPrice * (decimal(1n) + decimal(1n, 16))))
	})

	it("Should run successfully for short", async function () {
		let symbol = await context.viewFacetSymbol.getSymbol(1)
		let duration = symbol.fundingRateEpochDuration
		let window = symbol.fundingRateWindowTime
		let currentEpoch = (BigInt(await time.latest()) / duration) * duration
		let targetTime = duration * 2n + window - 1n + currentEpoch

		let oldQuote = await context.viewFacetQuote.getQuote(2)

		await time.setNextBlockTimestamp(targetTime)
		await hedger.chargeFundingRate(await context.signers.user.getAddress(), [2], [decimal(1n, 16)], await getDummyPairUpnlSig())

		let newQuote = await context.viewFacetQuote.getQuote(2)
		expect(newQuote.openedPrice).to.be.equal(unDecimal(oldQuote.openedPrice * (decimal(1n) - decimal(1n, 16))))
	})

	it("should check sig when not bound", async function () {
		let symbol = await context.viewFacetSymbol.getSymbol(1)
		let duration = symbol.fundingRateEpochDuration
		let window = symbol.fundingRateWindowTime
		let currentEpoch = (BigInt(await time.latest()) / duration) * duration
		let targetTime = duration * 2n + window - 1n + currentEpoch

		await time.setNextBlockTimestamp(targetTime)
		await expect(
			hedger.chargeFundingRate(
				await context.signers.user.getAddress(),
				[1],
				[decimal(1n, 15)],
				await getDummyPairUpnlSig(BigInt(0), decimal(4970n) * -1n),
			),
		).to.be.revertedWith("ChargeFundingFacet: PartyB will be insolvent")
	})

	it("should skip check sig when bound", async function () {
		// BINDABLE_SETTER_ROLE was merged into PARTY_B_MANAGER_ROLE - no separate grant needed
		await context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address, true)
		await context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)

		let symbol = await context.viewFacetSymbol.getSymbol(1)
		let duration = symbol.fundingRateEpochDuration
		let window = symbol.fundingRateWindowTime
		let currentEpoch = (BigInt(await time.latest()) / duration) * duration
		let targetTime = duration * 2n + window - 1n + currentEpoch

		let oldQuote = await context.viewFacetQuote.getQuote(1)

		await time.setNextBlockTimestamp(targetTime)
		// When bound, solvency check is skipped so even a large negative upnlPartyB is accepted
		await hedger.chargeFundingRate(
			await context.signers.user.getAddress(),
			[1],
			[decimal(1n, 15)],
			await getDummyPairUpnlSig(BigInt(0), decimal(4970n) * -1n),
		)

		// Verify the funding rate was applied to the quote's opened price
		let newQuote = await context.viewFacetQuote.getQuote(1)
		expect(newQuote.openedPrice).to.be.equal(unDecimal(oldQuote.openedPrice * (decimal(1n) + decimal(1n, 15))))
	})

	describe("Accumulative Funding Rate Methods", function () {
		describe("setEpochDuration", function () {
			beforeEach(async () => {})

			it("should fail when partyB action paused", async () => {
				await context.pauseControlFacet.pausePartyBActions()
				await expect(context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([], [])).to.revertedWith(
					"Pausable: PartyB actions paused",
				)
			})

			it("should fail when system globally paused", async () => {
				await context.pauseControlFacet.pauseGlobal()
				await expect(context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([], [])).to.revertedWith("Pausable: Global paused")
			})

			it("should fail when non-partyB called", async () => {
				await expect(context.fundingRateFacet.connect(context.signers.user).setEpochDurations([], [])).to.revertedWith(
					"Accessibility: Should be partyB",
				)
			})

			it("should fail when input arrays length mismatch", async () => {
				await expect(context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [])).to.revertedWith(
					"FundingRateFacet: Invalid length",
				)
			})

			it("should fail when want to set duration zero", async () => {
				await expect(context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [0])).to.revertedWith(
					"FundingRateFacet: Zero epoch duration",
				)
			})

			it("should set epoch duration for first time correctly", async () => {
				await expect(context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])).to.not.reverted

				const blockTimestamp = await getBlockTimestamp()

				const fundingFee = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)
				expect(fundingFee.epochDuration).to.equal(EightHourInSec)
				expect(fundingFee.lastUpdatedEpoch).to.approximately(blockTimestamp / BigInt(EightHourInSec), 120)
			})

			it("should set epoch duration correctly", async () => {
				await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
				await expect(context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [NineHourInSec])).to.not.reverted

				const blockTimestamp = await getBlockTimestamp()

				const fundingFee = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)
				expect(fundingFee.epochDuration).to.equal(NineHourInSec)
				expect(fundingFee.lastUpdatedEpoch).to.approximately(blockTimestamp / BigInt(NineHourInSec), 1)
				expect(fundingFee.startEpoch).to.approximately(blockTimestamp / BigInt(NineHourInSec), 1)
			})
		})

		describe("updateAccumulatedFundingFee", () => {
			beforeEach(async () => {
				await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			})

			it("should fail when partyB action paused", async () => {
				await context.pauseControlFacet.pausePartyBActions()
				await expect(context.fundingRateFacet.connect(context.signers.hedger).updateAccumulatedFundingFee([], [], [], [])).to.revertedWith(
					"Pausable: PartyB actions paused",
				)
			})

			it("should fail when system globally paused", async () => {
				await context.pauseControlFacet.pauseGlobal()
				await expect(context.fundingRateFacet.connect(context.signers.hedger).updateAccumulatedFundingFee([], [], [], [])).to.revertedWith(
					"Pausable: Global paused",
				)
			})

			it("should fail when non-partyB called", async () => {
				await expect(context.fundingRateFacet.connect(context.signers.user).updateAccumulatedFundingFee([], [], [], [])).to.revertedWith(
					"Accessibility: Should be partyB",
				)
			})

			it("should fail when input arrays length mismatch", async () => {
				await expect(context.fundingRateFacet.connect(context.signers.hedger).updateAccumulatedFundingFee([1], [], [], [])).to.revertedWith(
					"FundingRateFacet: Invalid length",
				)
			})

			it("should fail when epoch duration not set", async () => {
				await expect(context.fundingRateFacet.connect(context.signers.hedger).updateAccumulatedFundingFee([2], [1], [1], [1])).to.revertedWith(
					"FundingRateFacet: Epoch duration not set",
				)
			})

			it("should update accumulated funding fee first time correctly", async () => {
				await expect(
					context.fundingRateFacet
						.connect(context.signers.hedger)
						.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)]),
				).to.not.reverted

				const blockTimestamp = await getBlockTimestamp()

				const fundingFee = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)
				expect(fundingFee.startEpoch).to.equal(blockTimestamp / BigInt(EightHourInSec))
				expect(fundingFee.lastUpdatedEpoch).to.equal(blockTimestamp / BigInt(EightHourInSec))
				expect(fundingFee.accumulatedLongRate).to.equal(0)
				expect(fundingFee.accumulatedShortRate).to.equal(0)
				expect(fundingFee.currentLongRate).to.equal((decimal(1n, 14) * decimal(1n)) / decimal(1n))
				expect(fundingFee.currentShortRate).to.equal((-decimal(1n, 14) * decimal(1n)) / decimal(1n))
			})

			it("should update accumulated funding fee correctly", async () => {
				await context.fundingRateFacet
					.connect(context.signers.hedger)
					.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

				await time.increase(NineHourInSec)

				await context.fundingRateFacet
					.connect(context.signers.hedger)
					.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

				await time.increase(NineHourInSec * 2)

				await expect(
					context.fundingRateFacet
						.connect(context.signers.hedger)
						.updateAccumulatedFundingFee([1], [decimal(2n, 14)], [-decimal(2n, 14)], [decimal(1n)]),
				).to.not.reverted

				const fundingFee = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)
				const blockTimestamp = BigInt(await time.latest())

				expect(fundingFee.lastUpdatedEpoch).to.equal(blockTimestamp / BigInt(EightHourInSec))
				expect(fundingFee.accumulatedLongRate).to.equal(100000000000000)
				expect(fundingFee.accumulatedShortRate).to.equal(-100000000000000)
				expect(fundingFee.currentLongRate).to.equal((decimal(2n, 14) * decimal(1n)) / decimal(1n))
				expect(fundingFee.currentShortRate).to.equal((-decimal(2n, 14) * decimal(1n)) / decimal(1n))
			})
		})

		describe("chargeAccumulatedFundingFee", () => {
			beforeEach(async () => {
				await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
				await context.fundingRateFacet
					.connect(context.signers.hedger)
					.updateAccumulatedFundingFee([1], [decimal(1n, 14)], [-decimal(1n, 14)], [decimal(1n)])

				await time.increase(EightHourInSec * 5)
			})

			it("should fail when partyB action paused", async () => {
				await context.pauseControlFacet.pausePartyBActions()
				await expect(
					context.fundingRateFacet
						.connect(context.signers.hedger)
						.chargeAccumulatedFundingFee(
							await context.signers.user.getAddress(),
							await context.signers.hedger.getAddress(),
							[1],
							await getDummyPairUpnlSig(),
						),
				).to.revertedWith("Pausable: PartyB actions paused")
			})

			it("should fail when system globally paused", async () => {
				await context.pauseControlFacet.pauseGlobal()
				await expect(
					context.fundingRateFacet
						.connect(context.signers.hedger)
						.chargeAccumulatedFundingFee(
							await context.signers.user.getAddress(),
							await context.signers.hedger.getAddress(),
							[1],
							await getDummyPairUpnlSig(),
						),
				).to.revertedWith("Pausable: Global paused")
			})

			it("should fail when non-partyB called", async () => {
				await expect(
					context.fundingRateFacet
						.connect(context.signers.user)
						.chargeAccumulatedFundingFee(
							await context.signers.user.getAddress(),
							await context.signers.hedger.getAddress(),
							[1],
							await getDummyPairUpnlSig(),
						),
				).to.revertedWith("Accessibility: Should be partyB")
			})

			// TODO ::: test notLiquidatedPartyB(partyB, partyA) modifier

			it("should failed when quote has invalid party A", async () => {
				await expect(
					context.fundingRateFacet
						.connect(context.signers.hedger)
						.chargeAccumulatedFundingFee(
							await context.signers.user2.getAddress(),
							await context.signers.hedger.getAddress(),
							[1],
							await getDummyPairUpnlSig(),
						),
				).to.revertedWith("FundingRateFacet: Invalid quote")
			})

			it("should failed when quote has invalid party B", async () => {
				await expect(
					context.fundingRateFacet
						.connect(context.signers.hedger)
						.chargeAccumulatedFundingFee(
							await context.signers.user.getAddress(),
							await context.signers.hedger2.getAddress(),
							[1],
							await getDummyPairUpnlSig(),
						),
				).to.revertedWith("FundingRateFacet: Sender isn't partyB of quote")
			})

			it("should failed when quote has invalid state", async () => {
				await expect(
					context.fundingRateFacet
						.connect(context.signers.hedger)
						.chargeAccumulatedFundingFee(
							await context.signers.user.getAddress(),
							await context.signers.hedger.getAddress(),
							[3],
							await getDummyPairUpnlSig(),
						),
				).to.revertedWith("LibQuote: Invalid state")
			})
		})

		it("does not roll symbol partyB funding state when close charges funding", async () => {
			const startTime = 2000000000n
			const epochDuration = 400n
			const setRateTimestamp = startTime + 100n
			const closeTimestamp = startTime + 800n

			await time.setNextBlockTimestamp(startTime)
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [epochDuration])

			await time.setNextBlockTimestamp(setRateTimestamp)
			await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(2n, 16)], [0], [decimal(1n)])

			await user.requestToClosePosition(
				1,
				limitCloseRequestBuilder()
					.deadline(startTime + 1000n)
					.build(),
			)

			await time.setNextBlockTimestamp(closeTimestamp)
			const tx = context.partyBPositionActionsFacet
				.connect(context.signers.hedger)
				.fillCloseRequest(1, decimal(100n), decimal(1n), await getDummyPairUpnlAndPriceSig(decimal(1n)))

			await expect(tx).to.not.emit(context.fundingRateFacet, "AccumulatedFundingStateUpdated")

			// Symbol/PartyB state stays at the last solver update; the quote settles via lazy extrapolation
			const fundingFee = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger.address)
			expect(fundingFee.accumulatedLongRate).to.equal(0n)
			expect(fundingFee.lastUpdatedEpoch).to.equal(setRateTimestamp / epochDuration)
			expect(fundingFee.lastUpdatedTimeStamp).to.equal(setRateTimestamp)

			// Two epochs elapsed at 0.02 → cumulative baseline recorded on the quote
			const quote = await context.viewFacetQuote.getQuote(1)
			expect(quote.accumulatedPaidFunding).to.equal(decimal(4n, 16))
		})

		describe("funding rate accumulation over multiple epochs", () => {
			beforeEach(async () => {
				// Set initial block timestamp to a known value
				await time.setNextBlockTimestamp(2000000000)
				await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [400])
			})

			it("should roll accumulated funding only when an update crosses an epoch boundary", async () => {
				const startTime = await time.latest()

				await time.setNextBlockTimestamp(startTime + 100)
				await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(2n, 16)], [0], [decimal(1n)])
				const fundingRate1 = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger.address)
				expect(fundingRate1.currentLongRate).to.equal(decimal(2n, 16))
				expect(fundingRate1.accumulatedLongRate).to.equal(0n)

				await time.setNextBlockTimestamp(startTime + 200)
				await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(3n, 16)], [0], [decimal(1n)])
				const fundingRate2 = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger.address)
				expect(fundingRate2.currentLongRate).to.equal(decimal(3n, 16))
				expect(fundingRate2.accumulatedLongRate).to.equal(0n)

				await time.setNextBlockTimestamp(startTime + 800)
				await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(4n, 16)], [0], [decimal(1n)])
				const fundingRate3 = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger.address)
				expect(fundingRate3.currentLongRate).to.equal(decimal(4n, 16))
				expect(fundingRate3.accumulatedLongRate).to.equal(decimal(3n, 16))

				await time.setNextBlockTimestamp(startTime + 900)
				await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(5n, 16)], [0], [decimal(1n)])
				const fundingRate4 = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger.address)
				expect(fundingRate4.currentLongRate).to.equal(decimal(5n, 16))
				expect(fundingRate4.accumulatedLongRate).to.equal(decimal(3n, 16))
			})

			it("should not roll symbol funding state when opening a position", async () => {
				const startTime = await time.latest()

				await time.setNextBlockTimestamp(startTime + 100)
				await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(2n, 16)], [0], [decimal(1n)])

				const quoteId = await user.sendQuote(
					limitQuoteRequestBuilder()
						.deadline(BigInt(startTime + 1000))
						.build(),
				)
				await hedger.lockQuote(quoteId)

				await time.setNextBlockTimestamp(startTime + 800)
				await hedger.openPosition(quoteId)

				// Symbol/PartyB state stays at the last solver update
				const fundingRate = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger.address)
				expect(fundingRate.lastUpdatedEpoch).to.equal(BigInt(Math.floor((startTime + 100) / 400)))
				expect(fundingRate.accumulatedLongRate).to.equal(0n)

				// Baseline = two epochs of lazy extrapolation at the current rate
				const quote = await context.viewFacetQuote.getQuote(quoteId)
				expect(quote.accumulatedPaidFunding).to.equal(decimal(4n, 16))
			})

			it("should correctly accumulate and charge funding rates across multiple epochs", async () => {
				const startTime = await time.latest()

				//* Move to t+200: Set initial funding fee
				await time.setNextBlockTimestamp(startTime + 200)
				await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(2n, 16)], [0], [decimal(1n)])

				const fundingRate1 = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)
				expect(fundingRate1.currentLongRate).to.equal(decimal(2n, 16))
				expect(fundingRate1.accumulatedLongRate).to.equal(0)

				//* Move to t+300: Update funding fee
				await time.setNextBlockTimestamp(startTime + 300)
				await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(3n, 16)], [0], [decimal(1n)])

				const fundingRate2 = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)
				expect(fundingRate2.currentLongRate).to.equal(decimal(3n, 16))
				expect(fundingRate2.accumulatedLongRate).to.equal(0)

				//* Move to t+500: Create and open position
				await time.setNextBlockTimestamp(startTime + 500)
				await user.sendQuote(
					limitQuoteRequestBuilder()
						.quantity(decimal(1n))
						.price(decimal(1n))
						.deadline(startTime + 1000)
						.maxFundingRate(decimal(1n))
						.build(),
				)
				await hedger.lockQuote(4)
				await hedger.openPosition(4, limitOpenRequestBuilder().filledAmount(decimal(1n)).build())

				const fundingRate3 = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)
				const quote1 = await context.viewFacetQuote.getQuote(4)
				expect(fundingRate3.currentLongRate).to.equal(decimal(3n, 16))
				// Position open no longer rolls symbol funding state
				expect(fundingRate3.accumulatedLongRate).to.equal(0n)
				expect(quote1.lastFundingPaymentTimestamp).to.approximately(startTime + 500, 10)

				//* Move to t+700: Update funding fee
				await time.setNextBlockTimestamp(startTime + 700)
				await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(1n, 16)], [0], [decimal(1n)])

				const fundingRate4 = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)
				expect(fundingRate4.currentLongRate).to.equal(decimal(1n, 16))
				expect(fundingRate4.accumulatedLongRate).to.equal(decimal(3n, 16))
				expect(fundingRate4.lastUpdatedEpoch).to.equal(BigInt(await time.latest()) / 400n)

				//* Move to t+1000: Update funding fee
				await time.setNextBlockTimestamp(startTime + 1000)
				await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(5n, 16)], [0], [decimal(1n)])

				const fundingRate5 = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)
				expect(fundingRate5.currentLongRate).to.equal(decimal(5n, 16))
				expect(fundingRate5.accumulatedLongRate).to.equal(decimal(2n, 16))
				expect(fundingRate5.lastUpdatedEpoch).to.equal(BigInt(await time.latest()) / 400n)

				//* Move to t+1300: Update funding fee
				await time.setNextBlockTimestamp(startTime + 1300)
				await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(2n, 16)], [0], [decimal(1n)])

				const fundingRate6 = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)
				expect(fundingRate6.currentLongRate).to.equal(decimal(2n, 16))
				expect(fundingRate6.accumulatedLongRate).to.equal(decimal(3n, 16))
				expect(fundingRate6.lastUpdatedEpoch).to.equal(BigInt(await time.latest()) / 400n)

				//* Move to t+1400: Charge accumulated funding fee
				await time.setNextBlockTimestamp(startTime + 1400)
				const beforeBalance1 = (await user.getBalanceInfo()).allocatedBalances
				await context.fundingRateFacet
					.connect(context.signers.hedger)
					.chargeAccumulatedFundingFee(
						await context.signers.user.getAddress(),
						await context.signers.hedger.getAddress(),
						[4],
						await getDummyPairUpnlSig(),
					)
				const afterBalance1 = (await user.getBalanceInfo()).allocatedBalances

				const quote2 = await context.viewFacetQuote.getQuote(4)
				expect(quote2.accumulatedPaidFunding).to.equal(decimal(9n, 16))
				expect(quote2.lastFundingPaymentTimestamp).to.equal(BigInt(await time.latest()))
				expect(afterBalance1 - beforeBalance1).to.equal(-1n * decimal(6n, 16))

				// Verify aggregate funding matches per-quote calculation
				const perQuoteFee1 = await context.viewFacetQuote.getQuoteFundingDebts([4])
				const aggregateFunding1 = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
					await context.signers.user.getAddress(),
					await context.signers.hedger.getAddress(),
					1,
					PositionType.LONG,
				)
				// After charging, accumulatedPaidFunding should match the aggregate tracking
				expect(aggregateFunding1).to.not.equal(0)
				// Verify debt calculation is consistent (aggregate >= sum due to no caps in aggregate)
				const aggregateDebt1 = await context.viewFacetAggregate.getPartyAAggregateFundingDebt(
					await context.signers.user.getAddress(),
					await context.signers.hedger.getAddress(),
					1,
					PositionType.LONG,
				)
				expect(aggregateDebt1).to.be.gte(perQuoteFee1[0])

				//* Move to t+1500: Update epoch duration
				await time.setNextBlockTimestamp(startTime + 1500)
				await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [300])
				const fundingRate7 = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)
				expect(fundingRate7.currentLongRate).to.equal(decimal(15n, 15))
				expect(fundingRate7.accumulatedLongRate).to.equal(decimal(15n, 15))
				expect(fundingRate7.startEpoch).to.equal(BigInt(fundingRate7.startEpochTimeStamp) / 300n)

				//* Move to t+1700: Charge accumulated funding fee
				await time.setNextBlockTimestamp(startTime + 1700)
				const beforeBalance2 = (await user.getBalanceInfo()).allocatedBalances
				await context.fundingRateFacet
					.connect(context.signers.hedger)
					.chargeAccumulatedFundingFee(
						await context.signers.user.getAddress(),
						await context.signers.hedger.getAddress(),
						[4],
						await getDummyPairUpnlSig(),
					)
				const afterBalance2 = (await user.getBalanceInfo()).allocatedBalances

				const quote3 = await context.viewFacetQuote.getQuote(4)
				const fundingRate8 = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)

				expect(fundingRate8.currentLongRate).to.equal(decimal(15n, 15))
				expect(fundingRate8.accumulatedLongRate).to.equal(decimal(15n, 15))

				expect(quote3.accumulatedPaidFunding).to.equal(decimal(105n, 15)) //! 0.12
				expect(quote3.lastFundingPaymentTimestamp).to.equal(await time.latest())
				expect(afterBalance2 - beforeBalance2).to.equal(-1n * decimal(15n, 15))

				// Verify aggregate funding after second charge
				const perQuoteFee2 = await context.viewFacetQuote.getQuoteFundingDebts([4])
				const aggregateFunding2 = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
					await context.signers.user.getAddress(),
					await context.signers.hedger.getAddress(),
					1,
					PositionType.LONG,
				)
				expect(aggregateFunding2).to.not.equal(0)
				const aggregateDebt2 = await context.viewFacetAggregate.getPartyAAggregateFundingDebt(
					await context.signers.user.getAddress(),
					await context.signers.hedger.getAddress(),
					1,
					PositionType.LONG,
				)
				expect(aggregateDebt2).to.be.gte(perQuoteFee2[0])

				//* Move to t+1900: Update funding fee
				await time.setNextBlockTimestamp(startTime + 1800)
				await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(5n, 16)], [0], [decimal(1n)])

				const fundingRate9 = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)
				expect(fundingRate9.currentLongRate).to.equal(decimal(5n, 16))
				expect(fundingRate9.accumulatedLongRate).to.equal(decimal(15n, 15))
				expect(fundingRate9.lastUpdatedEpoch).to.equal(BigInt(await time.latest()) / 300n)

				//* Move to t+2100: Final charge of accumulated funding fee
				await time.setNextBlockTimestamp(startTime + 2100)
				const beforeBalance3 = (await user.getBalanceInfo()).allocatedBalances
				await context.fundingRateFacet
					.connect(context.signers.hedger)
					.chargeAccumulatedFundingFee(
						await context.signers.user.getAddress(),
						await context.signers.hedger.getAddress(),
						[4],
						await getDummyPairUpnlSig(),
					)
				const afterBalance3 = (await user.getBalanceInfo()).allocatedBalances

				const quote4 = await context.viewFacetQuote.getQuote(4)
				const fundingRate10 = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)

				expect(fundingRate10.currentLongRate).to.equal(decimal(5n, 16))
				// Charging funding no longer rolls symbol state; it stays at the t+1800 solver update
				expect(fundingRate10.accumulatedLongRate).to.equal(decimal(15n, 15))

				expect(quote4.accumulatedPaidFunding).to.approximately(decimal(155n, 15), decimal(1n, 13))
				expect(quote4.lastFundingPaymentTimestamp).to.equal(await time.latest())
				expect(afterBalance3 - beforeBalance3).to.equal(-1n * decimal(5n, 16))

				// Verify aggregate funding after final charge
				const perQuoteFee3 = await context.viewFacetQuote.getQuoteFundingDebts([4])
				const aggregateFunding3 = await context.viewFacetAggregate.getPartyAAggregatedFundingPerPartyB(
					await context.signers.user.getAddress(),
					await context.signers.hedger.getAddress(),
					1,
					PositionType.LONG,
				)
				expect(aggregateFunding3).to.not.equal(0)
				const aggregateDebt3 = await context.viewFacetAggregate.getPartyAAggregateFundingDebt(
					await context.signers.user.getAddress(),
					await context.signers.hedger.getAddress(),
					1,
					PositionType.LONG,
				)
				expect(aggregateDebt3).to.be.gte(perQuoteFee3[0])

				// Also verify aggregate position state
				const { longPosition: partyALong } = await context.viewFacetAggregate.getPartyAAggregatedPositionBySymbolPerPartyB(
					await context.signers.user.getAddress(),
					await context.signers.hedger.getAddress(),
					1,
				)
				expect(partyALong.aggregatedOpenAmount).to.be.gt(0)
				expect(partyALong.avgOpenPrice).to.be.gt(0)

				// Verify partyB aggregate state matches
				const { longPosition: partyBLong } = await context.viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(
					await context.signers.hedger.getAddress(),
					await context.signers.user.getAddress(),
					1,
				)
				expect(partyBLong.aggregatedOpenAmount).to.equal(partyALong.aggregatedOpenAmount)
				expect(partyBLong.avgOpenPrice).to.equal(partyALong.avgOpenPrice)
			})
		})

		// describe("2. funding rate accumulation over multiple epochs", () => {
		// 	beforeEach(async () => {
		// 		// Set initial block timestamp to a known value
		// 		await time.setNextBlockTimestamp(2000000000)
		// 		await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [400])
		// 	})

		// 	it("should correctly accumulate and charge funding rates across multiple epochs", async () => {
		// 		const startTime = await time.latest()

		// 		//* Move to t+200: Set initial funding fee
		// 		await time.setNextBlockTimestamp(startTime + 200)
		// 		await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(2n, 16)], [0], [decimal(1n)])

		// 		//* Move to t+300: Update funding fee
		// 		await time.setNextBlockTimestamp(startTime + 300)
		// 		await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(3n, 16)], [0], [decimal(1n)])

		// 		//* Move to t+500: Create and open position
		// 		await time.setNextBlockTimestamp(startTime + 500)
		// 		await user.sendQuote(
		// 			limitQuoteRequestBuilder()
		// 				.quantity(decimal(1n))
		// 				.price(decimal(1n))
		// 				.deadline(startTime + 1000)
		// 				.maxFundingRate(decimal(1n))
		// 				.build(),
		// 		)
		// 		await hedger.lockQuote(4)
		// 		await hedger.openPosition(4, limitOpenRequestBuilder().filledAmount(decimal(1n)).build())

		// 		//* Move to t+700: Update funding fee
		// 		await time.setNextBlockTimestamp(startTime + 700)
		// 		await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(1n, 16)], [0], [decimal(1n)])

		// 		//* Move to t+1000: Update funding fee
		// 		await time.setNextBlockTimestamp(startTime + 1000)
		// 		await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(5n, 16)], [0], [decimal(1n)])

		// 		//* Move to t+1300: Update funding fee
		// 		await time.setNextBlockTimestamp(startTime + 1300)
		// 		await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(2n, 16)], [0], [decimal(1n)])

		// 		//* Move to t+1400: Charge accumulated funding fee
		// 		await time.setNextBlockTimestamp(startTime + 1400)
		// 		const beforeBalance1 = (await user.getBalanceInfo()).allocatedBalances
		// 		await context.fundingRateFacet
		// 			.connect(context.signers.hedger)
		// 			.chargeAccumulatedFundingFee(
		// 				await context.signers.user.getAddress(),
		// 				await context.signers.hedger.getAddress(),
		// 				[5],
		// 				await getDummyPairUpnlSig(),
		// 			)

		// 		//* Move to t+1700: Charge accumulated funding fee
		// 		await time.setNextBlockTimestamp(startTime + 1700)
		// 		await context.fundingRateFacet
		// 			.connect(context.signers.hedger)
		// 			.chargeAccumulatedFundingFee(
		// 				await context.signers.user.getAddress(),
		// 				await context.signers.hedger.getAddress(),
		// 				[5],
		// 				await getDummyPairUpnlSig(),
		// 			)

		// 		//* Move to t+1800: Update funding fee
		// 		await time.setNextBlockTimestamp(startTime + 1800)
		// 		await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(5n, 16)], [0], [decimal(1n)])

		// 		//* Move to t+2100: Final charge of accumulated funding fee
		// 		await time.setNextBlockTimestamp(startTime + 2100)
		// 		const beforeBalance3 = (await user.getBalanceInfo()).allocatedBalances
		// 		await context.fundingRateFacet
		// 			.connect(context.signers.hedger)
		// 			.chargeAccumulatedFundingFee(
		// 				await context.signers.user.getAddress(),
		// 				await context.signers.hedger.getAddress(),
		// 				[5],
		// 				await getDummyPairUpnlSig(),
		// 			)
		// 		const afterBalance3 = (await user.getBalanceInfo()).allocatedBalances

		// 		expect(afterBalance3 - beforeBalance3).to.equal(-1n * decimal(5n, 16))
		// 	})
		// })
	})

	describe("setEpochDuration snapshot fix", () => {
		it("should preserve fee exactly when changing epoch duration via snapshot", async () => {
			const startTime = 2000000000
			const oldD = 400
			const newD = 700

			// Step 1: Set initial epoch duration
			await time.setNextBlockTimestamp(startTime)
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [oldD])

			// Step 2: Set funding fee => sets startEpochTimeStamp
			await time.setNextBlockTimestamp(startTime + 350)
			await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(1n, 16)], [0], [decimal(1n)])

			// Step 3: Advance several epochs so epochsBefore > 0
			await time.setNextBlockTimestamp(startTime + 1000)
			await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(2n, 16)], [0], [decimal(1n)])

			const fundingBefore = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)
			const oldEpochsBefore = fundingBefore.lastUpdatedEpoch - fundingBefore.startEpoch

			// Record the total fee BEFORE the duration change
			const totalFeeBefore = fundingBefore.accumulatedLongRate * oldEpochsBefore

			// Step 4: Change epoch duration
			await time.setNextBlockTimestamp(startTime + 1001)
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [newD])

			const fundingAfter = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)

			// Snapshot approach: old fee is frozen in snapshotLongFee, epoch tracking resets
			expect(fundingAfter.snapshotLongFee).to.equal(totalFeeBefore, "Snapshot should capture exact old fee")
			expect(fundingAfter.lastUpdatedEpoch - fundingAfter.startEpoch).to.equal(0n, "Epoch tracking resets to 0")
			expect(fundingAfter.startEpochTimeStamp).to.equal(fundingAfter.lastUpdatedTimeStamp, "Start resets to now")
		})

		it("should not inflate fees beyond old total when changing duration", async () => {
			const startTime = 2000000000

			await time.setNextBlockTimestamp(startTime)
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [10])

			await time.setNextBlockTimestamp(startTime + 1)
			await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(5n, 16)], [0], [decimal(1n)])

			await time.setNextBlockTimestamp(startTime + 12)
			await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(5n, 16)], [0], [decimal(1n)])

			const fundingBefore = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)
			const oldEpochsBefore = fundingBefore.lastUpdatedEpoch - fundingBefore.startEpoch
			const totalFeeBefore = fundingBefore.accumulatedLongRate * oldEpochsBefore

			// Change to much smaller epoch duration
			await time.setNextBlockTimestamp(startTime + 13)
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [3])

			const fundingAfter = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)

			// Snapshot captures old fee exactly — no inflation possible
			expect(fundingAfter.snapshotLongFee).to.equal(totalFeeBefore, "Snapshot = old fee, zero rounding error")
			// New epoch tracking starts from 0
			const newEpochsBefore = fundingAfter.lastUpdatedEpoch - fundingAfter.startEpoch
			expect(newEpochsBefore).to.equal(0n)
		})

		it("should charge snapshotted funding immediately after changing duration", async () => {
			const startTime = 2000000000

			await time.setNextBlockTimestamp(startTime)
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [10])

			await time.setNextBlockTimestamp(startTime + 1)
			await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(5n, 16)], [0], [decimal(1n)])

			await time.setNextBlockTimestamp(startTime + 2)
			const quoteId = await user.sendQuote()
			await hedger.lockQuote(quoteId)
			await hedger.openPosition(quoteId)

			await time.setNextBlockTimestamp(startTime + 12)
			await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(5n, 16)], [0], [decimal(1n)])

			await time.setNextBlockTimestamp(startTime + 13)
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [1000])

			const beforeBalance = (await user.getBalanceInfo()).allocatedBalances

			await time.setNextBlockTimestamp(startTime + 14)
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.chargeAccumulatedFundingFee(
					await context.signers.user.getAddress(),
					await context.signers.hedger.getAddress(),
					[quoteId],
					await getDummyPairUpnlSig(),
				)

			const afterBalance = (await user.getBalanceInfo()).allocatedBalances
			const quote = await context.viewFacetQuote.getQuote(quoteId)

			expect(afterBalance - beforeBalance).to.equal(-decimal(5n))
			expect(quote.accumulatedPaidFunding).to.equal(decimal(5n, 16))
		})

		it("should handle multiple successive duration changes correctly", async () => {
			const startTime = 2000000000

			// First duration: 400
			await time.setNextBlockTimestamp(startTime)
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [400])

			await time.setNextBlockTimestamp(startTime + 100)
			await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(1n, 16)], [0], [decimal(1n)])

			await time.setNextBlockTimestamp(startTime + 900)
			await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(1n, 16)], [0], [decimal(1n)])

			const f1 = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)
			const fee1 = f1.accumulatedLongRate * (f1.lastUpdatedEpoch - f1.startEpoch)

			// First change: 400 -> 300
			await time.setNextBlockTimestamp(startTime + 901)
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [300])

			await time.setNextBlockTimestamp(startTime + 1500)
			await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(2n, 16)], [0], [decimal(1n)])

			const f2 = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)
			const fee2 = f2.accumulatedLongRate * (f2.lastUpdatedEpoch - f2.startEpoch)

			// Second change: 300 -> 500
			await time.setNextBlockTimestamp(startTime + 1501)
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [500])

			const f3 = await context.viewFacetSymbol.getFundingFeesOfPartyB(1, context.signers.hedger)

			// Snapshot should accumulate: first change snapshot + second change snapshot
			expect(f3.snapshotLongFee).to.equal(fee1 + fee2, "Snapshots compose correctly across multiple changes")
			expect(f3.lastUpdatedEpoch - f3.startEpoch).to.equal(0n, "Epoch tracking resets after each change")
		})
	})

	describe("normal and accumulated charge funding rate integration", function () {
		it("should not be able to charge normal when epoch duration set", async () => {
			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])
			await expect(
				hedger.chargeFundingRate(await context.signers.user.getAddress(), [1], [decimal(1n, 16)], await getDummyPairUpnlSig()),
			).to.be.revertedWith("ChargeFundingFacet: Use accumulated funding fee")
		})

		it("should set last charge funding rate timestamp when open position correctly", async () => {
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.quantity(decimal(1n))
					.price(decimal(1n))
					.deadline((await getBlockTimestamp()) + 1000n)
					.maxFundingRate(decimal(1n))
					.build(),
			)

			await hedger.lockQuote(4)
			const latestBlockTime = await getBlockTimestamp()
			await hedger.openPosition(4, limitOpenRequestBuilder().filledAmount(decimal(1n)).build())

			const quote = await context.viewFacetQuote.getQuote(4)
			expect(quote.lastFundingPaymentTimestamp).to.approximately(latestBlockTime, 30)
		})

		it("should be able normal charge funding rate and then set accumulated and charge accumulative", async () => {
			await context.symbolControlFacet.connect(context.signers.admin).setSymbolFundingState(1, 28800, 100)
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.quantity(decimal(1n))
					.price(decimal(1n))
					.deadline((await getBlockTimestamp()) + 1000n)
					.maxFundingRate(decimal(1n))
					.build(),
			)
			await hedger.lockQuote(4)
			await hedger.openPosition(4, limitOpenRequestBuilder().filledAmount(decimal(1n)).build())

			const symbol = await context.viewFacetSymbol.getSymbol(1)
			let duration = symbol.fundingRateEpochDuration
			let window = symbol.fundingRateWindowTime
			let currentEpoch = (BigInt(await time.latest()) / duration) * duration
			let targetTime = duration * 2n + window - 1n + currentEpoch

			const quoteBefore = await context.viewFacetQuote.getQuote(4)

			await time.setNextBlockTimestamp(targetTime)
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.chargeFundingRate(await context.signers.user.getAddress(), [4], [decimal(1n, 16)], await getDummyPairUpnlSig())

			// Verify normal charge applied the funding rate to the opened price (LONG: price increases)
			const quoteAfterNormal = await context.viewFacetQuote.getQuote(4)
			expect(quoteAfterNormal.openedPrice).to.be.equal(unDecimal(quoteBefore.openedPrice * (decimal(1n) + decimal(1n, 16))))

			await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [EightHourInSec])

			await expect(
				context.fundingRateFacet
					.connect(context.signers.hedger)
					.chargeFundingRate(await context.signers.user.getAddress(), [4], [decimal(1n, 16)], await getDummyPairUpnlSig()),
			).to.revertedWith("ChargeFundingFacet: Use accumulated funding fee")

			const quoteBeforeAccum = await context.viewFacetQuote.getQuote(4)
			await context.fundingRateFacet
				.connect(context.signers.hedger)
				.chargeAccumulatedFundingFee(
					await context.signers.user.getAddress(),
					await context.signers.hedger.getAddress(),
					[4],
					await getDummyPairUpnlSig(),
				)

			// Verify the accumulated charge updated the quote's lastFundingPaymentTimestamp
			const quoteAfterAccum = await context.viewFacetQuote.getQuote(4)
			expect(quoteAfterAccum.lastFundingPaymentTimestamp).to.be.gte(quoteBeforeAccum.lastFundingPaymentTimestamp)
		})
	})
}
