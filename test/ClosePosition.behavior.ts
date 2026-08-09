import { expect } from "chai"

import type { QuoteStructOutput } from "../src/types/interfaces/ISymmio.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { OrderType, PositionType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder, marketCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitFillCloseRequestBuilder, marketFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { AcceptCancelCloseRequestValidator } from "./models/validators/AcceptCancelCloseRequestValidator.js"
import { CancelCloseRequestValidator } from "./models/validators/CancelCloseRequestValidator.js"
import { CloseRequestValidator } from "./models/validators/CloseRequestValidator.js"
import { FillCloseRequestValidator } from "./models/validators/FillCloseRequestValidator.js"
import {
	decimal,
	getBlockTimestamp,
	getQuoteQuantity,
	getTotalLockedValuesForQuoteIds,
	getTradingFeeForQuotes,
	pausePartyA,
	pausePartyB,
	pausePartyBOpenPositions,
	unDecimal,
} from "./utils/Common.js"

const WAD = 10n ** 18n
const WAD_36 = 10n ** 36n

export function shouldBehaveLikeClosePosition(): void {
	let user: User, hedger: Hedger, hedger2: Hedger
	let context: RunContext
	let quote1LongOpened: QuoteStructOutput,
		quote2ShortOpened: QuoteStructOutput,
		quote3JustSent: QuoteStructOutput,
		quote4LongOpened: QuoteStructOutput

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		this.user_allocated = decimal(500n)
		this.hedger_allocated = decimal(4000n)

		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(this.hedger_allocated, this.hedger_allocated)

		hedger2 = new Hedger(context, context.signers.hedger2)
		await hedger2.setup()
		await hedger2.setBalances(this.hedger_allocated, this.hedger_allocated)

		// Quote1 LONG opened
		quote1LongOpened = await context.viewFacetQuote.getQuote(await user.sendQuote())
		await hedger.lockQuote(quote1LongOpened.id)
		await hedger.openPosition(quote1LongOpened.id)

		// Quote2 SHORT opened
		quote2ShortOpened = await context.viewFacetQuote.getQuote(
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build()),
		)
		await hedger.lockQuote(quote2ShortOpened.id)
		await hedger.openPosition(quote2ShortOpened.id)

		// Quote3 SHORT sent
		quote3JustSent = await context.viewFacetQuote.getQuote(await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build()))

		// Quote4 LONG sent
		quote4LongOpened = await context.viewFacetQuote.getQuote(await user.sendQuote())
		await hedger.lockQuote(quote4LongOpened.id)
		await hedger.openPosition(quote4LongOpened.id)
	})

	it("Should return total open amounts and average open prices by position type for partyB and symbol", async function () {
		const symbolId = (await context.viewFacetQuote.getQuote(quote1LongOpened.id)).symbolId
		const quoteIds = [quote1LongOpened.id, quote2ShortOpened.id, quote4LongOpened.id]
		let expectedLong = 0n
		let expectedShort = 0n
		let expectedLongNotional = 0n
		let expectedShortNotional = 0n
		for (const quoteId of quoteIds) {
			const quote = await context.viewFacetQuote.getQuote(quoteId)
			if (quote.symbolId !== symbolId) continue
			const openAmount = quote.quantity - quote.closedAmount
			if (quote.positionType === BigInt(PositionType.LONG)) {
				expectedLong += openAmount
				expectedLongNotional += openAmount * quote.openedPrice
			} else {
				expectedShort += openAmount
				expectedShortNotional += openAmount * quote.openedPrice
			}
		}

		const amounts = await context.viewFacetAggregate.getPartyBAggregatedPositionBySymbol(hedger.address, symbolId)
		expect(amounts.length).to.equal(2)
		expect(amounts[0].positionType).to.equal(BigInt(PositionType.LONG))
		expect(amounts[0].aggregatedOpenAmount).to.equal(expectedLong)
		expect(amounts[0].avgOpenPrice).to.equal(expectedLong === 0n ? 0n : expectedLongNotional / expectedLong)
		expect(amounts[1].positionType).to.equal(BigInt(PositionType.SHORT))
		expect(amounts[1].aggregatedOpenAmount).to.equal(expectedShort)
		expect(amounts[1].avgOpenPrice).to.equal(expectedShort === 0n ? 0n : expectedShortNotional / expectedShort)
	})

	it("Should net funding fee and realized PnL on close (no intermediate balance requirement)", async function () {
		await context.pauseControlFacet.connect(context.signers.admin).activateAccumulatedFunding()

		const epochDurationSec = 3600
		const latest = BigInt(await time.latest())
		const aligned = (latest / BigInt(epochDurationSec) + 1n) * BigInt(epochDurationSec)
		await time.setNextBlockTimestamp(Number(aligned))

		await context.fundingRateFacet.connect(hedger.signer).setEpochDurations([1], [epochDurationSec])
		await context.fundingRateFacet.connect(hedger.signer).setFundingFee([1], [decimal(8n, 16)], [0], [decimal(1n)])

		// Ensure PartyA has enough available balance to create an extra position
		await context.accountFacet.connect(user.signer).allocate(decimal(250n))

		const quoteId = await user.sendQuote(limitQuoteRequestBuilder().maxFundingRate(decimal(1000n)).build())
		await hedger.lockQuote(quoteId, 0n, decimal(20n))
		await hedger.openPosition(quoteId)

		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const filledAmount = quote.quantity - quote.closedAmount

		await time.increase(epochDurationSec)

		const fundingFee = (await context.viewFacetQuote.getQuoteFundingDebts([quoteId]))[0]
		expect(fundingFee).to.be.gt(0n)

		const closedPrice = decimal(20n)
		await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(filledAmount).closePrice(closedPrice).build())

		const partyAAllocatedBefore = (await user.getBalanceInfo()).allocatedBalances
		const partyBAllocatedBefore = (await hedger.getBalanceInfo(await user.getAddress())).allocatedBalances
		const validator = new FillCloseRequestValidator()
		const beforeOut = await validator.before(context, {
			user,
			hedger,
			quoteId,
		})

		expect(partyAAllocatedBefore).to.be.gte(fundingFee)

		await expect(
			hedger.fillCloseRequest(quoteId, limitFillCloseRequestBuilder().filledAmount(filledAmount).closedPrice(closedPrice).price(closedPrice).build()),
		).to.not.be.reverted

		const partyAAllocatedAfter = (await user.getBalanceInfo()).allocatedBalances
		const partyBAllocatedAfter = (await hedger.getBalanceInfo(await user.getAddress())).allocatedBalances
		await validator.after(context, {
			user,
			hedger,
			quoteId,
			closePrice: closedPrice,
			fillAmount: filledAmount,
			beforeOutput: beforeOut,
		})

		const pnl = ((closedPrice - quote.openedPrice) * filledAmount) / WAD
		const netToPartyA = pnl - fundingFee
		const closeFee = (filledAmount * closedPrice * quote.closeFee) / WAD_36

		expect(partyAAllocatedAfter - partyAAllocatedBefore).to.equal(netToPartyA - closeFee)
		expect(partyBAllocatedAfter - partyBAllocatedBefore).to.equal(-netToPartyA)
	})

	it("Should fail on invalid partyA", async function () {
		await expect(
			context.partyAFacet.requestToClosePosition(
				2n, //quoteId
				decimal(1n), //closePrice
				decimal(1n), //quantityToClose
				BigInt(OrderType.LIMIT),
				await getBlockTimestamp(100n),
			),
		).to.be.revertedWith("Accessibility: Should be partyA of quote")
	})

	it("Should fail on paused partyA", async function () {
		await pausePartyA(context)
		await expect(user.requestToClosePosition(2)).to.be.revertedWith("Pausable: PartyA actions paused")
	})

	it("Should restrict PartyB to closing positions only when close-only mode is active", async function () {
		await pausePartyBOpenPositions(context)

		await expect(hedger.lockQuote(quote3JustSent.id)).to.be.revertedWith("Pausable: PartyB open positions paused")
		await expect(hedger.openPosition(quote4LongOpened.id)).to.be.revertedWith("Pausable: PartyB open positions paused")

		await user.requestToClosePosition(quote1LongOpened.id, limitCloseRequestBuilder().build())
		await expect(hedger.fillCloseRequest(quote1LongOpened.id, limitFillCloseRequestBuilder().build())).to.not.be.reverted

		const closedQuote = await context.viewFacetQuote.getQuote(quote1LongOpened.id)
		expect(closedQuote.quoteStatus).to.equal(QuoteStatus.CLOSED)
		expect(closedQuote.closedAmount).to.equal(closedQuote.quantity)
	})

	it("Should restrict a specific PartyB from opening positions via per-PartyB pause", async function () {
		const hedgerAddress = await hedger.getAddress()

		// Pause only this specific PartyB
		await context.pauseControlFacet.connect(context.signers.admin).setPartyBOpenPositionsPaused(hedgerAddress, true)

		// lockQuote should fail for the paused PartyB
		await expect(hedger.lockQuote(quote3JustSent.id)).to.be.revertedWith("PartyBFacet: PartyB open positions paused")

		// But closing positions should still work
		await user.requestToClosePosition(quote1LongOpened.id, limitCloseRequestBuilder().build())
		await expect(hedger.fillCloseRequest(quote1LongOpened.id, limitFillCloseRequestBuilder().build())).to.not.be.reverted

		const closedQuote = await context.viewFacetQuote.getQuote(quote1LongOpened.id)
		expect(closedQuote.quoteStatus).to.equal(QuoteStatus.CLOSED)

		// A different PartyB should NOT be affected
		await expect(hedger2.lockQuote(quote3JustSent.id)).to.not.be.reverted

		// Unpause and verify the original PartyB can lock quotes again
		await context.pauseControlFacet.connect(context.signers.admin).setPartyBOpenPositionsPaused(hedgerAddress, false)
		const newQuote = await context.viewFacetQuote.getQuote(await user.sendQuote())
		await expect(hedger.lockQuote(newQuote.id)).to.not.be.reverted
	})

	it("Should restrict an affiliate to closing positions only when affiliate shutdown is scheduled", async function () {
		const affiliate = await context.accountManager.getAddress()
		await context.controlFacet.connect(context.signers.admin).scheduleAffiliateShutdown(affiliate, (await getBlockTimestamp()) + 10n)

		await expect(user.sendQuote()).to.be.revertedWith("PartyAFacet: Affiliate shutdown scheduled")
		await expect(hedger.lockQuote(quote3JustSent.id)).to.be.revertedWith("PartyBFacet: Affiliate shutdown scheduled")

		await user.requestToClosePosition(quote1LongOpened.id, limitCloseRequestBuilder().build())
		await expect(hedger.fillCloseRequest(quote1LongOpened.id, limitFillCloseRequestBuilder().build())).to.not.be.reverted

		const closedQuote = await context.viewFacetQuote.getQuote(quote1LongOpened.id)
		expect(closedQuote.quoteStatus).to.equal(QuoteStatus.CLOSED)
	})

	it("Should block opening a quote that was locked before the affiliate shutdown was scheduled", async function () {
		const affiliate = await context.accountManager.getAddress()
		const lockedQuoteId = quote3JustSent.id
		await hedger.lockQuote(lockedQuoteId)

		await context.controlFacet.connect(context.signers.admin).scheduleAffiliateShutdown(affiliate, (await getBlockTimestamp()) + 10n)

		await expect(hedger.openPosition(lockedQuoteId)).to.be.revertedWith("PartyBFacet: Affiliate shutdown scheduled")
	})

	it("Should fail on invalid quoteId", async function () {
		await expect(user.requestToClosePosition(50)).to.be.revertedWith("Accessibility: Should be partyA of quote")
	})

	it("Should fail on invalid quote state", async function () {
		await expect(user.requestToClosePosition(3)).to.be.revertedWith("PartyAFacet: Invalid state")
	})

	it("Should fail on invalid quantityToClose", async function () {
		const quantity = await getQuoteQuantity(context, 1n)
		await expect(
			user.requestToClosePosition(
				1,
				limitCloseRequestBuilder()
					.quantityToClose(quantity + decimal(1n))
					.build(),
			),
		).to.be.revertedWith("PartyAFacet: Invalid quantityToClose")
		await expect(
			user.requestToClosePosition(
				1,
				limitCloseRequestBuilder()
					.quantityToClose(quantity + decimal(1n))
					.build(),
			),
		).to.be.revertedWith("PartyAFacet: Invalid quantityToClose")
	})

	it("Should request limit successfully", async function () {
		const validator = new CloseRequestValidator()
		const beforeOut = await validator.before(context, {
			user: user,
			hedger: hedger,
			quoteId: BigInt(1),
		})
		const closePrice = decimal(1n, 17)
		const quantityToClose = await getQuoteQuantity(context, 1n)
		await user.requestToClosePosition(1, limitCloseRequestBuilder().quantityToClose(quantityToClose).closePrice(closePrice).build())
		await validator.after(context, {
			user: user,
			hedger: hedger,
			quoteId: BigInt(1),
			closePrice: closePrice,
			quantityToClose: quantityToClose,
			beforeOutput: beforeOut,
		})
	})

	it("Should request limit successfully partially", async function () {
		const quantity = await getQuoteQuantity(context, 1n)
		const validator = new CloseRequestValidator()
		const beforeOut = await validator.before(context, {
			user: user,
			hedger: hedger,
			quoteId: BigInt(1),
		})
		const closePrice = decimal(1n, 17)
		const quantityToClose = quantity / 2n
		await user.requestToClosePosition(1, limitCloseRequestBuilder().quantityToClose(quantityToClose).closePrice(closePrice).build())
		await validator.after(context, {
			user: user,
			hedger: hedger,
			quoteId: BigInt(1),
			closePrice: closePrice,
			quantityToClose: quantityToClose,
			beforeOutput: beforeOut,
		})
	})

	it("Should request market successfully", async function () {
		const validator = new CloseRequestValidator()
		const beforeOut = await validator.before(context, {
			user: user,
			hedger: hedger,
			quoteId: BigInt(1),
		})
		const closePrice = decimal(1n, 17)
		const quantityToClose = await getQuoteQuantity(context, 1n)
		await user.requestToClosePosition(1, marketCloseRequestBuilder().quantityToClose(quantityToClose).closePrice(closePrice).build())
		await validator.after(context, {
			user: user,
			hedger: hedger,
			quoteId: BigInt(1),
			closePrice: closePrice,
			quantityToClose: quantityToClose,
			beforeOutput: beforeOut,
		})
	})

	it("Should request market successfully partially", async function () {
		const quantity = await getQuoteQuantity(context, 1n)
		const validator = new CloseRequestValidator()
		const beforeOut = await validator.before(context, {
			user: user,
			hedger: hedger,
			quoteId: BigInt(1),
		})
		const closePrice = decimal(1n, 17)
		const quantityToClose = quantity / 2n
		await user.requestToClosePosition(1, marketCloseRequestBuilder().quantityToClose(quantityToClose).closePrice(closePrice).build())
		await validator.after(context, {
			user: user,
			hedger: hedger,
			quoteId: BigInt(1),
			closePrice: closePrice,
			quantityToClose: quantityToClose,
			beforeOutput: beforeOut,
		})
	})

	it("Should expire close request", async function () {
		await user.requestToClosePosition(
			1,
			limitCloseRequestBuilder()
				.quantityToClose(await getQuoteQuantity(context, 1n))
				.closePrice(decimal(1n, 17))
				.build(),
		)
		await time.increase(1000)
		await context.partyAFacet.expireQuote([1])
		let q = await context.viewFacetQuote.getQuote(1)
		expect(q.quoteStatus).to.be.equal(QuoteStatus.OPENED)
		expect(q.requestedClosePrice).to.equal(0n)
		expect(q.quantityToClose).to.equal(0n)
	})

	describe("Fill Close Request", async function () {
		beforeEach(async function () {
			await user.requestToClosePosition(
				1,
				limitCloseRequestBuilder()
					.quantityToClose(await getQuoteQuantity(context, 1n))
					.closePrice(decimal(1n))
					.build(),
			)
			await user.requestToClosePosition(
				2,
				limitCloseRequestBuilder()
					.quantityToClose(await getQuoteQuantity(context, 2n))
					.closePrice(decimal(1n))
					.build(),
			)
			await user.requestToClosePosition(
				4,
				marketCloseRequestBuilder()
					.quantityToClose(await getQuoteQuantity(context, 4n))
					.closePrice(decimal(1n))
					.build(),
			)
		})

		it("Should fail on invalid partyB", async function () {
			await expect(
				hedger2.fillCloseRequest(
					1,
					limitFillCloseRequestBuilder()
						.filledAmount(await getQuoteQuantity(context, 1n))
						.closedPrice(decimal(1n))
						.build(),
				),
			).to.be.revertedWith("Accessibility: Should be partyB of quote")
		})

		it("Should fail on paused partyB", async function () {
			await pausePartyB(context)
			await expect(
				hedger.fillCloseRequest(
					1,
					limitFillCloseRequestBuilder()
						.filledAmount(await getQuoteQuantity(context, 1n))
						.closedPrice(decimal(1n))
						.build(),
				),
			).to.be.revertedWith("Pausable: PartyB actions paused")
		})

		it("Should fail on fill amount", async function () {
			const quantity = await getQuoteQuantity(context, 1n)
			await expect(
				hedger.fillCloseRequest(
					1,
					limitFillCloseRequestBuilder()
						.filledAmount(quantity + decimal(1n))
						.build(),
				),
			).to.be.revertedWith("PartyBFacet: Invalid filledAmount")
			await expect(
				hedger.fillCloseRequest(
					4,
					limitFillCloseRequestBuilder()
						.filledAmount(quantity + decimal(1n))
						.build(),
				),
			).to.be.revertedWith("PartyBFacet: Invalid filledAmount")
		})

		it("Should fail on invalid close price", async function () {
			await expect(
				hedger.fillCloseRequest(
					1,
					limitFillCloseRequestBuilder()
						.filledAmount(await getQuoteQuantity(context, 1n))
						.closedPrice(decimal(1n, 17))
						.build(),
				),
			).to.be.revertedWith("PartyBFacet: Closed price isn't valid")

			await expect(
				hedger.fillCloseRequest(
					2,
					limitFillCloseRequestBuilder()
						.filledAmount(await getQuoteQuantity(context, 2n))
						.closedPrice(decimal(2n))
						.build(),
				),
			).to.be.revertedWith("PartyBFacet: Closed price isn't valid")
		})

		it("Should fail on negative balance of partyA/partyB", async function () {
			await expect(
				hedger.fillCloseRequest(
					1,
					limitFillCloseRequestBuilder()
						.filledAmount(await getQuoteQuantity(context, 1n))
						.closedPrice(decimal(1n))
						.upnlPartyA(decimal(-575n))
						.build(),
				),
			).to.be.revertedWith("LibSolvency: Available balance is lower than zero")
			await expect(
				hedger.fillCloseRequest(
					1,
					limitFillCloseRequestBuilder()
						.filledAmount(await getQuoteQuantity(context, 1n))
						.closedPrice(decimal(1n))
						.upnlPartyB(decimal(-410n))
						.build(),
				),
			).to.be.revertedWith("LibSolvency: Available balance is lower than zero")
		})

		it("Should fail on partyB becoming liquidatable", async function () {
			await expect(
				hedger.fillCloseRequest(
					1,
					limitFillCloseRequestBuilder()
						.filledAmount(await getQuoteQuantity(context, 1n))
						.closedPrice(decimal(1n))
						.upnlPartyB(decimal(-300n))
						.price(decimal(1n, 17))
						.build(),
				),
			).to.be.revertedWith("LibSolvency: Available balance is lower than zero")
			await expect(
				hedger.fillCloseRequest(
					2,
					limitFillCloseRequestBuilder()
						.filledAmount(await getQuoteQuantity(context, 2n))
						.closedPrice(decimal(1n, 17))
						.upnlPartyB(decimal(-300n))
						.build(),
				),
			).to.be.revertedWith("LibSolvency: Available balance is lower than zero")
		})

		it("Should fail on partyA becoming liquidatable", async function () {
			let quantity = await getQuoteQuantity(context, 1n)
			let price = decimal(11n, 17)
			let closePrice = decimal(1n)
			let quote1 = await context.viewFacetQuote.getQuote(1n)
			// Close fee: filledAmount * closedPrice * closeFee / 1e36
			let closeFee1 = (quantity * closePrice * quote1.closeFee) / WAD_36
			let userAvailable =
				this.user_allocated -
				(await getTotalLockedValuesForQuoteIds(context, [2n, 4n], false)) -
				(await getTradingFeeForQuotes(context, [1n, 2n, 3n, 4n])) -
				unDecimal(quantity * (price - closePrice)) -
				closeFee1

			await expect(
				hedger.fillCloseRequest(
					1,
					limitFillCloseRequestBuilder()
						.filledAmount(quantity)
						.closedPrice(closePrice)
						.upnlPartyA((userAvailable + decimal(1n)) * -1n)
						.price(price)
						.build(),
				),
			).to.be.revertedWith("LibSolvency: Available balance is lower than zero")

			quantity = await getQuoteQuantity(context, 1n)
			price = decimal(1n, 17)
			closePrice = decimal(1n)
			let quote2 = await context.viewFacetQuote.getQuote(2n)
			// Close fee: filledAmount * closedPrice * closeFee / 1e36
			let closeFee2 = (quantity * closePrice * quote2.closeFee) / WAD_36
			userAvailable =
				this.user_allocated -
				(await getTotalLockedValuesForQuoteIds(context, [1n, 4n], false)) -
				(await getTradingFeeForQuotes(context, [1n, 2n, 3n, 4n])) -
				unDecimal(quantity * (closePrice - price)) -
				closeFee2

			await expect(
				hedger.fillCloseRequest(
					2,
					limitFillCloseRequestBuilder()
						.filledAmount(quantity)
						.closedPrice(closePrice)
						.upnlPartyA((userAvailable + decimal(1n)) * -1n)
						.price(price)
						.build(),
				),
			).to.be.revertedWith("LibSolvency: Available balance is lower than zero")
		})

		it("Should fail due to expired request", async function () {
			await time.increase(1000)
			let closePrice = decimal(11n, 17)
			await expect(
				hedger.fillCloseRequest(
					1,
					limitFillCloseRequestBuilder()
						.filledAmount(await getQuoteQuantity(context, 1n))
						.closedPrice(closePrice)
						.build(),
				),
			).to.be.revertedWith("PartyBFacet: Quote is expired")
		})

		it("Should run successfully for limit", async function () {
			const validator = new FillCloseRequestValidator()
			const beforeOut = await validator.before(context, {
				user: user,
				hedger: hedger,
				quoteId: BigInt(1),
			})
			let closePrice = decimal(11n, 17)
			const filledAmount = await getQuoteQuantity(context, 1n)
			await hedger.fillCloseRequest(1, limitFillCloseRequestBuilder().filledAmount(filledAmount).closedPrice(closePrice).build())
			await validator.after(context, {
				user: user,
				hedger: hedger,
				quoteId: BigInt(1),
				closePrice: closePrice,
				fillAmount: filledAmount,
				beforeOutput: beforeOut,
			})
		})

		it("Should run successfully partially for limit", async function () {
			const closePrice = decimal(11n, 17)
			const quantity = await getQuoteQuantity(context, 1n)
			const filledAmount = quantity / 2n
			const validator = new FillCloseRequestValidator()
			const beforeOut = await validator.before(context, {
				user: user,
				hedger: hedger,
				quoteId: BigInt(1),
			})
			await hedger.fillCloseRequest(1, limitFillCloseRequestBuilder().filledAmount(filledAmount).closedPrice(closePrice).build())
			await validator.after(context, {
				user: user,
				hedger: hedger,
				quoteId: BigInt(1),
				closePrice: closePrice,
				fillAmount: filledAmount,
				beforeOutput: beforeOut,
			})
		})

		it("Should run successfully for market", async function () {
			let closePrice = decimal(11n, 17)
			const validator = new FillCloseRequestValidator()
			const beforeOut = await validator.before(context, {
				user: user,
				hedger: hedger,
				quoteId: BigInt(4),
			})
			const filledAmount = await getQuoteQuantity(context, 4n)
			await hedger.fillCloseRequest(4, marketFillCloseRequestBuilder().filledAmount(filledAmount).closedPrice(closePrice).build())
			await validator.after(context, {
				user: user,
				hedger: hedger,
				quoteId: BigInt(4),
				closePrice: closePrice,
				fillAmount: filledAmount,
				beforeOutput: beforeOut,
			})
		})

		it("Should check sig when not bind", async function () {
			let closePrice = decimal(11n, 17)
			await expect(
				hedger.fillCloseRequest(
					1,
					limitFillCloseRequestBuilder()
						.filledAmount(await getQuoteQuantity(context, 1n))
						.closedPrice(closePrice)
						.upnlPartyB(decimal(-1000n))
						.build(),
				),
			).to.be.revertedWith("LibSolvency: Available balance is lower than zero")
		})

		it("Should skip check sig when bind", async function () {
			let closePrice = decimal(11n, 17)

			// First cancel pending quote 3 (sent but not locked in parent beforeEach)
			// Since it's PENDING (not LOCKED), requestToCancelQuote will cancel it directly
			await user.requestToCancelQuote(3)

			// BINDABLE_SETTER_ROLE was merged into PARTY_B_MANAGER_ROLE - no separate grant needed
			await context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address, true)
			await context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			const filledAmount = await getQuoteQuantity(context, 1n)
			await expect(
				hedger.fillCloseRequest(
					1,
					limitFillCloseRequestBuilder().filledAmount(filledAmount).closedPrice(closePrice).upnlPartyB(decimal(-1000n)).build(),
				),
			).not.reverted

			const closedQuote = await context.viewFacetQuote.getQuote(1)
			expect(closedQuote.quoteStatus).to.equal(QuoteStatus.CLOSED)
			expect(closedQuote.closedAmount).to.equal(filledAmount)
		})
	})

	describe("Cancel Close Request", async function () {
		beforeEach(async function () {
			await user.requestToClosePosition(
				1,
				limitCloseRequestBuilder()
					.quantityToClose(await getQuoteQuantity(context, 4n))
					.build(),
			)
		})

		it("Should fail on invalid quoteId", async function () {
			await expect(user.requestToCancelCloseRequest(3)).to.be.revertedWith("PartyAFacet: Invalid state")
		})

		it("Should fail on invalid partyA", async function () {
			await expect(context.partyAFacet.connect(context.signers.user2).requestToCancelCloseRequest(1)).to.be.revertedWith(
				"Accessibility: Should be partyA of quote",
			)
		})

		it("Should fail on paused partyA", async function () {
			await pausePartyA(context)
			await expect(user.requestToCancelCloseRequest(1)).to.be.revertedWith("Pausable: PartyA actions paused")
		})

		it("Should fail on invalid state", async function () {
			await expect(user.requestToCancelCloseRequest(2)).to.be.revertedWith("PartyAFacet: Invalid state")
		})

		it("Should send cancel request successfully", async function () {
			const validator = new CancelCloseRequestValidator()
			const beforeOut = await validator.before(context, {
				user: user,
				hedger: hedger,
				quoteId: BigInt(1),
			})
			await user.requestToCancelCloseRequest(1)
			await validator.after(context, {
				user: user,
				hedger: hedger,
				quoteId: BigInt(1),
				beforeOutput: beforeOut,
			})
		})

		it("Should expire request", async function () {
			await time.increase(1000)
			await user.requestToCancelCloseRequest(1)
			const quote = await context.viewFacetQuote.getQuote(1)
			expect(quote.quoteStatus).to.be.equal(QuoteStatus.OPENED)
			expect(quote.requestedClosePrice).to.equal(0n)
			expect(quote.quantityToClose).to.equal(0n)
		})

		describe("Accepting cancel request", async function () {
			this.beforeEach(async function () {
				await user.requestToCancelCloseRequest(1)
			})

			it("Should fail on invalid quoteId", async function () {
				await expect(hedger.acceptCancelCloseRequest(3)).to.be.revertedWith("Accessibility: Should be partyB of quote")
			})

			it("Should fail on invalid partyB", async function () {
				await expect(hedger2.acceptCancelCloseRequest(1)).to.be.revertedWith("Accessibility: Should be partyB of quote")
			})

			it("Should fail on paused partyB", async function () {
				await pausePartyB(context)
				await expect(hedger.acceptCancelCloseRequest(1)).to.be.revertedWith("Pausable: PartyB actions paused")
			})

			it("Should fail on invalid state", async function () {
				await expect(hedger.acceptCancelCloseRequest(2)).to.be.revertedWith("PartyBFacet: Invalid state")
			})

			it("Should run successfully", async function () {
				const validator = new AcceptCancelCloseRequestValidator()
				const beforeOut = await validator.before(context, {
					user: user,
					hedger: hedger,
					quoteId: BigInt(1),
				})
				await hedger.acceptCancelCloseRequest(1)
				await validator.after(context, {
					user: user,
					hedger: hedger,
					quoteId: BigInt(1),
					beforeOutput: beforeOut,
				})
			})

			it("Should reset the remaining request when partyB partially fills during cancellation", async function () {
				const quote = await context.viewFacetQuote.getQuote(1)
				const filledAmount = quote.quantityToClose / 2n
				const validator = new FillCloseRequestValidator()
				const beforeOut = await validator.before(context, {
					user: user,
					hedger: hedger,
					quoteId: 1n,
				})

				await hedger.fillCloseRequest(1, limitFillCloseRequestBuilder().filledAmount(filledAmount).closedPrice(quote.requestedClosePrice).build())
				await validator.after(context, {
					user: user,
					hedger: hedger,
					quoteId: 1n,
					closePrice: quote.requestedClosePrice,
					fillAmount: filledAmount,
					beforeOutput: beforeOut,
				})

				const updatedQuote = await context.viewFacetQuote.getQuote(1)
				expect(updatedQuote.quoteStatus).to.equal(QuoteStatus.OPENED)
				expect(updatedQuote.quantityToClose).to.equal(0n)
			})

			it("Should force cancel close request", async function () {
				await expect(user.forceCancelCloseRequest(2)).to.be.revertedWith("PartyAFacet: Invalid state")
				await expect(user.forceCancelCloseRequest(1)).to.be.revertedWith("PartyAFacet: Cooldown not reached")
				await time.increase(300)
				await user.forceCancelCloseRequest(1)
				const quote = await context.viewFacetQuote.getQuote(1)
				expect(quote.quoteStatus).to.be.eq(QuoteStatus.OPENED)
				expect(quote.quantityToClose).to.equal(0n)
				expect(quote.requestedClosePrice).to.equal(0n)
			})
		})
	})
}
