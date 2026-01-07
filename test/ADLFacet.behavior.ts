import { expect } from "chai"

import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { OrderType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal } from "./utils/Common.js"
import { getDummyPairUpnlAndPricesSig } from "./utils/SignatureUtils.js"

export function shouldBehaveLikeADLFacet(): void {
	let context: RunContext, user: User, hedger: Hedger

	const ADLReason = {
		NOT_IN_CLOSE_STATE: 0n,
		PARTY_A_INSUFFICIENT_BALANCE: 1n,
		PARTY_B_INSUFFICIENT_BALANCE: 2n,
		INVALID_FILLED_AMOUNT: 3n,
	} as const

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		this.user_allocated = decimal(500n)
		this.hedger_allocated = decimal(400000n)

		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(this.hedger_allocated, this.hedger_allocated)
	})

	const openWith = async (partyB: Hedger): Promise<bigint> => {
		await user.sendQuote(
			limitQuoteRequestBuilder()
				.partyBWhiteList([await partyB.getAddress()])
				.build(),
		)
		const lastID = await context.viewFacetQuote.getNextQuoteId()
		await partyB.lockQuote(lastID)
		const q = await context.viewFacetQuote.getQuote(lastID)
		const upnlSig = await getDummyPairUpnlAndPricesSig([q.requestedOpenPrice], [1n])
		await context.partyBBatchActionsFacet.connect(partyB.signer).openPositions([lastID], [decimal(100n)], [q.requestedOpenPrice], upnlSig)
		return lastID
	}

	describe("adlClose", function () {
		beforeEach(async function () {
			const collateral = await context.viewFacet.getCollateral()
			await context.collateral.connect(hedger.signer).mint(await hedger.getAddress(), decimal(2000n))
			await context.collateral.connect(hedger.signer).approve(context.diamond, ethers.MaxUint256)
			await context.accountFacet.connect(hedger.signer).depositAssuranceCollateral(collateral, decimal(1000n))
			await context.controlFacet.connect(context.signers.admin).setADLEnabled(await hedger.getAddress(), true)
		})

		const parseEvents = async (tx: any) => {
			const receipt = await tx.wait()
			return receipt.logs
				.map((log: any) => {
					try {
						return context.adlFacet.interface.parseLog(log)
					} catch {
						return null
					}
				})
				.filter((l: any) => l)
		}

		describe("reverts", function () {
			it("fails on length mismatch", async function () {
				const quoteId = await openWith(hedger)
				await expect(context.adlFacet.connect(hedger.signer).adlClose([quoteId], [decimal(10n)], [])).to.be.revertedWith(
					"ADLFacet: Invalid array length",
				)
			})

			it("fails when ADL is disabled for partyB", async function () {
				const quoteId = await openWith(hedger)
				await context.controlFacet.connect(context.signers.admin).setADLEnabled(await hedger.getAddress(), false)
				await expect(context.adlFacet.connect(hedger.signer).adlClose([quoteId], [decimal(10n)], [decimal(1n)])).to.be.revertedWith(
					"ADLFacet: ADL disabled",
				)
			})

			it("fails when sender is not partyB", async function () {
				const quoteId = await openWith(hedger)
				await expect(context.adlFacet.connect(context.signers.hedger2).adlClose([quoteId], [decimal(10n)], [decimal(1n)])).to.be.revertedWith(
					"ADLFacet: Sender isn't partyB of quote",
				)
			})

			it("fails on zero amount", async function () {
				const quoteId = await openWith(hedger)
				const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
				const tx = await context.adlFacet.connect(hedger.signer).adlClose([quoteId], [0n], [decimal(1n)])
				const events = await parseEvents(tx)
				const skip = events.find((e: any) => e!.name === "ADLSkip" && e!.args.quoteId === quoteId)
				expect(skip).to.not.equal(undefined)
				expect(skip!.args.reason).to.equal(ADLReason.INVALID_FILLED_AMOUNT)

				const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
				expect(quoteAfter.closedAmount).to.equal(quoteBefore.closedAmount)
				expect(quoteAfter.quoteStatus).to.equal(quoteBefore.quoteStatus)
			})

			it("skips when ADL amount exceeds open amount", async function () {
				const quoteId = await openWith(hedger)
				const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
				const openAmount = quoteBefore.quantity - quoteBefore.closedAmount
				const tx = await context.adlFacet.connect(hedger.signer).adlClose([quoteId], [openAmount + 1n], [quoteBefore.openedPrice])
				const events = await parseEvents(tx)
				const skip = events.find((e: any) => e!.name === "ADLSkip" && e!.args.quoteId === quoteId)
				expect(skip).to.not.equal(undefined)
				expect(skip!.args.reason).to.equal(ADLReason.INVALID_FILLED_AMOUNT)
			})

			it("skips when close would make partyB use locked CVA/LF (should settle/close others first)", async function () {
				await user.sendQuote(
					limitQuoteRequestBuilder()
						.partyBWhiteList([await hedger.getAddress()])
						.build(),
				)
				const quoteId = await context.viewFacetQuote.getNextQuoteId()
				const q = await context.viewFacetQuote.getQuote(quoteId)

				// Allocate only the bare minimum for PartyB: totalForPartyB = CVA + LF + partyBmm = 65
				await context.accountFacet.connect(hedger.signer).allocateForPartyB(decimal(65n), await user.getAddress())
				await hedger.lockQuote(quoteId, 0n, null)

				const upnlSig = await getDummyPairUpnlAndPricesSig([q.requestedOpenPrice], [1n])
				await context.partyBBatchActionsFacet.connect(hedger.signer).openPositions([quoteId], [decimal(100n)], [q.requestedOpenPrice], upnlSig)

				// Close half with enough profit for PartyA so PartyB would pay pnl and dip below remaining locked CVA+LF.
				const tx = await context.adlFacet.connect(hedger.signer).adlClose([quoteId], [decimal(50n)], [decimal(22n, 17)]) // 2.2
				const events = await parseEvents(tx)
				const skip = events.find((e: any) => e!.name === "ADLSkip" && e!.args.quoteId === quoteId)
				expect(skip).to.not.equal(undefined)
				expect(skip!.args.reason).to.equal(ADLReason.PARTY_B_INSUFFICIENT_BALANCE)

				const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
				expect(quoteAfter.closedAmount).to.equal(0n)
				expect(quoteAfter.quoteStatus).to.equal(BigInt(QuoteStatus.OPENED))
			})
		})

		it("keeps existing close request intact after ADL when enough remains to fulfill it", async function () {
			const quoteId = await openWith(hedger)
			const userClosePrice = decimal(2n)
			const userCloseQty = decimal(60n)
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(userCloseQty).closePrice(userClosePrice).build())

			const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
			const oldCloseId = await context.viewFacetQuote.getQuoteCloseId(quoteId)
			const adlAmount = decimal(30n)

			await context.adlFacet.connect(hedger.signer).adlClose([quoteId], [adlAmount], [quoteBefore.openedPrice])

			const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
			expect(quoteAfter.quoteStatus).to.equal(BigInt(QuoteStatus.CLOSE_PENDING))
			expect(quoteAfter.quantityToClose).to.equal(userCloseQty)
			expect(quoteAfter.requestedClosePrice).to.equal(userClosePrice)
			const finalCloseId = await context.viewFacetQuote.getQuoteCloseId(quoteId)
			expect(finalCloseId).to.be.greaterThan(oldCloseId)
			expect(quoteAfter.closedAmount - quoteBefore.closedAmount).to.equal(adlAmount)
		})

		it("reissues a reduced user close request when ADL consumes most of the position", async function () {
			const quoteId = await openWith(hedger)
			const userClosePrice = decimal(2n)
			const userCloseQty = decimal(90n)
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(userCloseQty).closePrice(userClosePrice).build())

			const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
			const adlAmount = decimal(70n)

			const tx = await context.adlFacet.connect(hedger.signer).adlClose([quoteId], [adlAmount], [quoteBefore.openedPrice])
			const events = await parseEvents(tx)

			const limitRequest = events.find(
				(e: any) => e!.name === "RequestToClosePosition" && e!.args.orderType === BigInt(OrderType.LIMIT) && e!.args.closePrice === userClosePrice,
			)
			expect(limitRequest?.args.quantityToClose).to.equal(decimal(30n))

			const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
			expect(quoteAfter.quoteStatus).to.equal(BigInt(QuoteStatus.CLOSE_PENDING))
			expect(quoteAfter.quantityToClose).to.equal(decimal(30n))
			expect(quoteAfter.requestedClosePrice).to.equal(userClosePrice)
			expect(quoteAfter.closedAmount - quoteBefore.closedAmount).to.equal(adlAmount)
		})

		it("closes the position fully via ADL without reissuing the user's close request when nothing remains", async function () {
			const quoteId = await openWith(hedger)
			const userClosePrice = decimal(2n)
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(decimal(50n)).closePrice(userClosePrice).build())

			const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
			const oldCloseId = await context.viewFacetQuote.getQuoteCloseId(quoteId)
			const adlAmount = quoteBefore.quantity - quoteBefore.closedAmount

			const tx = await context.adlFacet.connect(hedger.signer).adlClose([quoteId], [adlAmount], [quoteBefore.openedPrice])
			const events = await parseEvents(tx)

			const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
			expect(quoteAfter.quoteStatus).to.equal(BigInt(QuoteStatus.CLOSED))
			expect(quoteAfter.quantityToClose).to.equal(0n)
			expect(quoteAfter.requestedClosePrice).to.equal(0n)
			expect(quoteAfter.closedAmount - quoteBefore.closedAmount).to.equal(adlAmount)
			const finalCloseId = await context.viewFacetQuote.getQuoteCloseId(quoteId)
			expect(finalCloseId).to.be.greaterThan(oldCloseId)
			const acceptCancel = events.find(
				(e: any) => e!.name === "AcceptCancelCloseRequest" && e!.args.quoteId === quoteId && e!.args.closeId === oldCloseId,
			)
			expect(acceptCancel).to.not.equal(undefined)
		})

		it("restores cancel-close-pending flow with the original close request and cancel event", async function () {
			const quoteId = await openWith(hedger)
			const userClosePrice = decimal(2n)
			const userCloseQty = decimal(60n)
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(userCloseQty).closePrice(userClosePrice).build())
			const oldCloseId = await context.viewFacetQuote.getQuoteCloseId(quoteId)
			await user.requestToCancelCloseRequest(quoteId)

			const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
			const adlAmount = decimal(30n)
			const tx = await context.adlFacet.connect(hedger.signer).adlClose([quoteId], [adlAmount], [quoteBefore.openedPrice])
			await tx.wait()

			const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
			expect(quoteAfter.quoteStatus).to.equal(BigInt(QuoteStatus.CANCEL_CLOSE_PENDING))
			expect(quoteAfter.quantityToClose).to.equal(userCloseQty)
			expect(quoteAfter.requestedClosePrice).to.equal(userClosePrice)
			const finalCloseId = await context.viewFacetQuote.getQuoteCloseId(quoteId)
			expect(finalCloseId).to.be.greaterThan(oldCloseId)
		})

		it("keeps cancel-close-pending closeId and params when ADL leaves some open amount", async function () {
			const quoteId = await openWith(hedger)
			const userClosePrice = decimal(2n)
			const userCloseQty = decimal(60n)
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(userCloseQty).closePrice(userClosePrice).build())
			const oldCloseId = await context.viewFacetQuote.getQuoteCloseId(quoteId)
			await user.requestToCancelCloseRequest(quoteId)

			const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
			const adlAmount = decimal(25n)
			const tx = await context.adlFacet.connect(hedger.signer).adlClose([quoteId], [adlAmount], [quoteBefore.openedPrice])
			await tx.wait()

			const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
			expect(quoteAfter.quoteStatus).to.equal(BigInt(QuoteStatus.CANCEL_CLOSE_PENDING))
			expect(quoteAfter.quantityToClose).to.equal(userCloseQty)
			expect(quoteAfter.requestedClosePrice).to.equal(userClosePrice)
			expect(await context.viewFacetQuote.getQuoteCloseId(quoteId)).to.be.greaterThan(oldCloseId)
		})

		it("fully consumes a cancel-close-pending quote via ADL without reissuing user close", async function () {
			const quoteId = await openWith(hedger)
			const userClosePrice = decimal(2n)
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(decimal(40n)).closePrice(userClosePrice).build())
			const oldCloseId = await context.viewFacetQuote.getQuoteCloseId(quoteId)
			await user.requestToCancelCloseRequest(quoteId)

			const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
			const adlAmount = quoteBefore.quantity - quoteBefore.closedAmount
			const tx = await context.adlFacet.connect(hedger.signer).adlClose([quoteId], [adlAmount], [quoteBefore.openedPrice])
			const events = await parseEvents(tx)

			const followUpReq = events.find(
				(e: any) => e!.name === "RequestToClosePosition" && e!.args.closeId === oldCloseId && e!.args.closePrice === userClosePrice,
			)
			expect(followUpReq).to.equal(undefined)

			const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
			expect(quoteAfter.quoteStatus).to.equal(BigInt(QuoteStatus.CLOSED))
			expect(quoteAfter.quantityToClose).to.equal(0n)
			expect(quoteAfter.requestedClosePrice).to.equal(0n)
			expect(await context.viewFacetQuote.getQuoteCloseId(quoteId)).to.equal(oldCloseId + 1n) // ADL closeId consumed the close
		})
	})
}
