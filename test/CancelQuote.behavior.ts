import { expect } from "chai"

import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { PositionType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder, marketQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { AcceptCancelRequestValidator } from "./models/validators/AcceptCancelRequestValidator.js"
import { CancelQuoteValidator } from "./models/validators/CancelQuoteValidator.js"
import { OpenPositionValidator } from "./models/validators/OpenPositionValidator.js"
import { decimal, getOpenTradingFeeForQuoteWithFilledAmount, getQuoteQuantity, pausePartyA, pausePartyB } from "./utils/Common.js"
import { getDummySingleUpnlAndPriceSig } from "./utils/SignatureUtils.js"

export function shouldBehaveLikeCancelQuote(): void {
	let context: RunContext, user: User, hedger: Hedger, hedger2: Hedger

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

		await user.sendQuote()
	})

	it("Should fail due to invalid quoteId", async function () {
		await expect(user.requestToCancelQuote(3)).to.be.revertedWith("Accessibility: Should be partyA of quote")
	})

	it("Should fail on invalid partyA", async function () {
		await expect(context.partyAFacet.requestToCancelQuote(1)).to.be.revertedWith("Accessibility: Should be partyA of quote")
	})

	it("Should fail on paused partyA", async function () {
		await pausePartyA(context)
		await expect(user.requestToCancelQuote(1)).to.be.revertedWith("Pausable: PartyA actions paused")
	})

	it("Should fail on liquidated partyA", async function () {
		await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
		await hedger.lockQuote(2)
		await hedger.openPosition(2)
		await user.liquidateAndSetSymbolPrices([1n], [decimal(2000n)], [2n])
		await expect(user.requestToCancelQuote(1)).to.be.revertedWith("Accessibility: PartyA isn't solvent")
	})

	it("Should fail on invalid state", async function () {
		await user.sendQuote()
		await hedger.lockQuote(2)
		await hedger.openPosition(2)
		await expect(user.requestToCancelQuote(2)).to.be.revertedWith("PartyAFacet: Invalid state")
	})

	it("Should cancel a pending quote", async function () {
		const validator = new CancelQuoteValidator()
		const beforeOut = await validator.before(context, {
			user: user,
			quoteId: BigInt(1),
		})
		await user.requestToCancelQuote(1)
		await validator.after(context, {
			user: user,
			quoteId: BigInt(1),
			beforeOutput: beforeOut,
			targetStatus: QuoteStatus.CANCELED,
		})
	})

	it("Should refund the provisional market fee when canceling a pending market quote", async function () {
		const provisionalMarketPrice = decimal(9n, 17)
		const quoteId = await user.sendQuote(marketQuoteRequestBuilder().upnlSig(getDummySingleUpnlAndPriceSig(provisionalMarketPrice)).build())
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const allocatedBefore = (await user.getBalanceInfo()).allocatedBalances
		const reservedFee = await getOpenTradingFeeForQuoteWithFilledAmount(context, quoteId, quote.quantity)

		await user.requestToCancelQuote(quoteId)

		const allocatedAfter = (await user.getBalanceInfo()).allocatedBalances
		expect(allocatedAfter - allocatedBefore).to.equal(reservedFee)
		expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(QuoteStatus.CANCELED)
	})

	it("Should cancel a expired pending quote", async function () {
		const validator = new CancelQuoteValidator()
		const beforeOut = await validator.before(context, {
			user: user,
			quoteId: BigInt(1),
		})
		await time.increase(1000)
		await user.requestToCancelQuote(1)
		await validator.after(context, {
			user: user,
			quoteId: BigInt(1),
			beforeOutput: beforeOut,
			targetStatus: QuoteStatus.EXPIRED,
		})
	})

	it("Should refund the provisional market fee when a pending market quote expires", async function () {
		const provisionalMarketPrice = decimal(9n, 17)
		const quoteId = await user.sendQuote(marketQuoteRequestBuilder().upnlSig(getDummySingleUpnlAndPriceSig(provisionalMarketPrice)).build())
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const allocatedBefore = (await user.getBalanceInfo()).allocatedBalances
		const reservedFee = await getOpenTradingFeeForQuoteWithFilledAmount(context, quoteId, quote.quantity)

		await time.increase(1000)
		await user.requestToCancelQuote(quoteId)

		const allocatedAfter = (await user.getBalanceInfo()).allocatedBalances
		expect(allocatedAfter - allocatedBefore).to.equal(reservedFee)
		expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(QuoteStatus.EXPIRED)
	})

	describe("Should cancel a locked quote", async function () {
		beforeEach(async function () {
			await hedger.lockQuote(1)
		})

		it("Should fail to accept cancel request on invalid quoteId", async function () {
			await expect(hedger.acceptCancelRequest(2)).to.be.revertedWith("Accessibility: Should be partyB of quote")
		})

		it("Should fail to accept cancel request on invalid partyB", async function () {
			await user.requestToCancelQuote(1)
			await expect(hedger2.acceptCancelRequest(1)).to.be.revertedWith("Accessibility: Should be partyB of quote")
		})

		it("Should fail to accept cancel request on paused partyB", async function () {
			await user.requestToCancelQuote(1)
			await pausePartyB(context)
			await expect(hedger.acceptCancelRequest(1)).to.be.revertedWith("Pausable: PartyB actions paused")
		})

		describe("Should cancel successfully", async function () {
			it("Accept cancel request", async function () {
				const cqValidator = new CancelQuoteValidator()
				const cqBeforeOut = await cqValidator.before(context, {
					user: user,
					quoteId: BigInt(1),
				})
				await user.requestToCancelQuote(1)
				await cqValidator.after(context, {
					user: user,
					quoteId: BigInt(1),
					beforeOutput: cqBeforeOut,
				})

				const accValidator = new AcceptCancelRequestValidator()
				const accBeforeOut = await accValidator.before(context, {
					user: user,
					quoteId: BigInt(1),
				})
				await hedger.acceptCancelRequest(1)
				await accValidator.after(context, {
					user: user,
					quoteId: BigInt(1),
					beforeOutput: accBeforeOut,
				})
			})

			it("Open position partially", async function () {
				const quantity = await getQuoteQuantity(context, 1n)
				await user.requestToCancelQuote(1)
				const validator = new OpenPositionValidator()
				const beforeOut = await validator.before(context, {
					user: user,
					hedger: hedger,
					quoteId: BigInt(1),
				})
				const openedPrice = decimal(1n)
				const filledAmount = quantity / 2n
				await hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(openedPrice).price(decimal(1n, 17)).build())
				await validator.after(context, {
					user: user,
					hedger: hedger,
					quoteId: BigInt(1),
					openedPrice: openedPrice,
					fillAmount: filledAmount,
					beforeOutput: beforeOut,
					newQuoteId: BigInt(2),
					newQuoteTargetStatus: QuoteStatus.CANCELED,
				})
			})

			it("Open position fully", async function () {
				const quantity = await getQuoteQuantity(context, 1n)
				await user.requestToCancelQuote(1)
				const validator = new OpenPositionValidator()
				const beforeOut = await validator.before(context, {
					user: user,
					hedger: hedger,
					quoteId: BigInt(1),
				})
				const openedPrice = decimal(1n)
				const filledAmount = quantity
				await hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(quantity).openPrice(openedPrice).price(decimal(1n, 17)).build())
				await validator.after(context, {
					user: user,
					hedger: hedger,
					quoteId: BigInt(1),
					openedPrice: openedPrice,
					fillAmount: filledAmount,
					beforeOutput: beforeOut,
				})
			})

			it("Should fail to accept cancel request on invalid state (not CANCEL_PENDING)", async function () {
				// Quote is LOCKED, not CANCEL_PENDING
				await expect(hedger.acceptCancelRequest(1)).to.be.revertedWith("PartyBFacet: Invalid state")
			})

			it("Should force cancel quote", async function () {
				await expect(user.forceCancelQuote(1)).to.be.revertedWith("PartyAFacet: Invalid state")
				await user.requestToCancelQuote(1)
				expect((await context.viewFacetQuote.getQuote(1)).quoteStatus).to.equal(QuoteStatus.CANCEL_PENDING)
				await expect(user.forceCancelQuote(1)).to.be.revertedWith("PartyAFacet: Cooldown not reached")
				const balanceBefore = await user.getBalanceInfo()
				const hedgerBalanceBefore = await hedger.getBalanceInfo(await user.getAddress())
				expect(balanceBefore.totalPendingLockedPartyA).to.be.greaterThan(0n)
				expect(hedgerBalanceBefore.totalPendingLockedPartyB).to.be.greaterThan(0n)
				await time.increase(300)
				await user.forceCancelQuote(1)
				const balanceAfter = await user.getBalanceInfo()
				const hedgerBalanceAfter = await hedger.getBalanceInfo(await user.getAddress())
				expect(balanceAfter.totalPendingLockedPartyA).to.equal(0n)
				expect(hedgerBalanceAfter.totalPendingLockedPartyB).to.equal(0n)
				// Trading fee should be refunded
				expect(balanceAfter.allocatedBalances).to.be.greaterThan(balanceBefore.allocatedBalances)
				expect((await context.viewFacetQuote.getQuote(1)).quoteStatus).to.be.eq(QuoteStatus.CANCELED)
			})
		})
	})
}
