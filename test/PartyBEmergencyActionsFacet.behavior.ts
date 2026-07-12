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
import { decimal, getBlockTimestamp } from "./utils/Common.js"
import { getDummyLiquidationSig, getDummyPairUpnlAndPricesSig, getDummySingleUpnlSig } from "./utils/SignatureUtils.js"

export function shouldBehaveLikePartyBEmergencyActionsFacet(): void {
	let context: RunContext, user: User, hedger: Hedger

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
			await context.pledgeFacet.connect(hedger.signer).depositPledge(collateral, decimal(1000n))
			await context.controlFacet.connect(context.signers.admin).setADLEnabled(await hedger.getAddress(), true)
		})

		const parseEvents = async (tx: any) => {
			const receipt = await tx.wait()
			return receipt.logs
				.map((log: any) => {
					// Try multiple interfaces to parse events
					const interfaces = [
						context.partyAFacet.interface, // RequestToClosePosition
						context.partyBPositionActionsFacet.interface, // AcceptCancelCloseRequest
						context.partyBBatchActionsFacet.interface, // Has all events via inheritance
						context.partyBEmergencyActionsFacet.interface, // ADLClose
					]
					for (const iface of interfaces) {
						try {
							return iface.parseLog(log)
						} catch {
							// Continue to next interface
						}
					}
					return null
				})
				.filter((l: any) => l)
		}

		describe("reverts", function () {
			it("fails when ADL is disabled for partyB", async function () {
				const quoteId = await openWith(hedger)
				await context.controlFacet.connect(context.signers.admin).setADLEnabled(await hedger.getAddress(), false)
				await expect(context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, decimal(10n), decimal(1n))).to.be.revertedWith(
					"PartyBFacet: ADL disabled",
				)
			})

			it("fails when sender is not partyB of quote", async function () {
				const quoteId = await openWith(hedger)
				await expect(
					context.partyBEmergencyActionsFacet.connect(context.signers.hedger2).adlClose(quoteId, decimal(10n), decimal(1n)),
				).to.be.revertedWith("PartyBFacet: Sender isn't partyB of quote")
			})

			it("fails when the symbol is frozen for adjustment", async function () {
				const quoteId = await openWith(hedger)
				const quote = await context.viewFacetQuote.getQuote(quoteId)
				const now = await getBlockTimestamp()
				await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(quote.symbolId, decimal(4n), now - 1n)
				await expect(context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, decimal(10n), decimal(1n))).to.be.revertedWith(
					"LibSymbolAdjustment: Symbol is frozen",
				)
			})

			it("fails on zero amount", async function () {
				const quoteId = await openWith(hedger)
				const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
				await expect(context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, 0, quoteBefore.openedPrice)).to.be.revertedWith(
					"PartyBFacet: Invalid amount",
				)
			})

			it("skips when ADL amount exceeds open amount", async function () {
				const quoteId = await openWith(hedger)
				const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
				const openAmount = quoteBefore.quantity - quoteBefore.closedAmount
				await expect(
					context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, openAmount + 1n, quoteBefore.openedPrice),
				).to.be.revertedWith("PartyBFacet: Invalid amount")
			})

			it("allows ADL close even with minimal partyB allocation", async function () {
				await user.sendQuote(
					limitQuoteRequestBuilder()
						.partyBWhiteList([await hedger.getAddress()])
						.build(),
				)
				const quoteId = await context.viewFacetQuote.getNextQuoteId()
				const q = await context.viewFacetQuote.getQuote(quoteId)

				// Allocate only the bare minimum for PartyB: totalForPartyB = CVA + LF + partyBmm = 65
				await context.partyBAccountFacet.connect(hedger.signer).allocateForPartyB(decimal(65n), await user.getAddress())
				await hedger.lockQuote(quoteId, 0n, null)

				const upnlSig = await getDummyPairUpnlAndPricesSig([q.requestedOpenPrice], [1n])
				await context.partyBBatchActionsFacet.connect(hedger.signer).openPositions([quoteId], [decimal(100n)], [q.requestedOpenPrice], upnlSig)

				// Close half with profit for PartyA.
				await expect(context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, decimal(50n), decimal(22n, 17))).to.not.be.reverted // 2.2

				const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
				expect(quoteAfter.quoteStatus).to.equal(BigInt(QuoteStatus.OPENED))
				expect(quoteAfter.closedAmount).to.equal(decimal(50n))
			})

			it("reverts when partyA is in liquidation", async function () {
				const quoteId = await openWith(hedger)
				// Put partyA in liquidation using proper liquidation signature
				const allocatedBalance = decimal(500n)
				const liquidationSig = await getDummyLiquidationSig("0x01", -decimal(600n), [1n], [decimal(1n)], -decimal(600n), allocatedBalance)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePartyA(await user.getAddress(), liquidationSig)

				await expect(context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, decimal(10n), decimal(1n))).to.be.revertedWith(
					"PartyAFacet: PartyA is in liquidation process",
				)
			})

			it("reverts when partyB is in liquidation", async function () {
				// Set up with minimal allocation to allow liquidation
				await user.sendQuote(
					limitQuoteRequestBuilder()
						.partyBWhiteList([await hedger.getAddress()])
						.build(),
				)
				const quoteId = await context.viewFacetQuote.getNextQuoteId()
				const q = await context.viewFacetQuote.getQuote(quoteId)

				// Allocate minimum for partyB (totalForPartyB = CVA + LF + partyBmm = 65)
				await context.partyBAccountFacet.connect(hedger.signer).allocateForPartyB(decimal(65n), await user.getAddress())
				await hedger.lockQuote(quoteId, 0n, null)

				const upnlSig = await getDummyPairUpnlAndPricesSig([q.requestedOpenPrice], [1n])
				await context.partyBBatchActionsFacet.connect(hedger.signer).openPositions([quoteId], [decimal(100n)], [q.requestedOpenPrice], upnlSig)

				// Liquidate partyB with a large negative upnl
				await context.partyBLiquidationFacet
					.connect(context.signers.liquidator)
					.liquidatePartyB(await hedger.getAddress(), await user.getAddress(), await getDummySingleUpnlSig(decimal(-100n)))

				await expect(context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, decimal(10n), decimal(1n))).to.be.revertedWith(
					"PartyBState: PartyB is in liquidation",
				)
			})

			it("reverts when partyB is in cross liquidation", async function () {
				// Open a position first
				const quoteId = await openWith(hedger)

				// Enable cross partyB mode for hedger directly (no migration to avoid double-counting locked values)
				await context.controlFacet.connect(context.signers.admin).setCrossPartyBModeActivated(true)
				await context.controlFacet.connect(context.signers.admin).setCrossPartyB(await hedger.getAddress(), true)
				// Allocate to cross bucket for solvency
				const allocatedPerPartyA = await context.viewFacet.allocatedBalanceOfPartyB(await hedger.getAddress(), await user.getAddress())
				await hedger.setBalances(allocatedPerPartyA, allocatedPerPartyA, 0n)
				await context.partyBAccountFacet.connect(hedger.signer).allocateForPartyB(allocatedPerPartyA, ethers.ZeroAddress)

				// Grant CLEARING_HOUSE_ROLE to liquidator
				await context.controlFacet.grantRole(context.signers.liquidator.address, ethers.keccak256(ethers.toUtf8Bytes("CLEARING_HOUSE_ROLE")))

				// Trigger cross liquidation with a large negative upnl
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(await hedger.getAddress(), "0x01", decimal(-500000n), await getBlockTimestamp())

				await expect(context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, decimal(10n), decimal(1n))).to.be.revertedWith(
					"PartyBState: PartyB is in cross liquidation",
				)
			})
		})

		describe("basic happy path (OPENED state)", function () {
			it("partially closes an OPENED position via ADL", async function () {
				const quoteId = await openWith(hedger)
				const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
				const adlAmount = decimal(40n)

				await context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, adlAmount, quoteBefore.openedPrice)

				const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
				expect(quoteAfter.quoteStatus).to.equal(BigInt(QuoteStatus.OPENED))
				expect(quoteAfter.closedAmount).to.equal(adlAmount)
				expect(quoteAfter.quantityToClose).to.equal(0n)
				expect(quoteAfter.requestedClosePrice).to.equal(0n)
			})

			it("fully closes an OPENED position via ADL", async function () {
				const quoteId = await openWith(hedger)
				const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
				const openAmount = quoteBefore.quantity - quoteBefore.closedAmount

				await context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, openAmount, quoteBefore.openedPrice)

				const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
				expect(quoteAfter.quoteStatus).to.equal(BigInt(QuoteStatus.CLOSED))
				expect(quoteAfter.closedAmount).to.equal(quoteBefore.quantity)
			})
		})

		describe("event emissions", function () {
			it("emits RequestToClosePosition with MARKET order type for ADL close", async function () {
				const quoteId = await openWith(hedger)
				const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
				const adlAmount = decimal(30n)

				const tx = await context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, adlAmount, quoteBefore.openedPrice)
				const events = await parseEvents(tx)

				const requestEvents = events.filter((e: any) => e!.name === "RequestToClosePosition")
				expect(requestEvents.length).to.be.greaterThanOrEqual(1)

				const adlRequestEvent = requestEvents.find((e: any) => e!.args.orderType === BigInt(OrderType.MARKET))
				expect(adlRequestEvent).to.not.be.undefined
				expect(adlRequestEvent!.args.quantityToClose).to.equal(adlAmount)
				expect(adlRequestEvent!.args.closePrice).to.equal(quoteBefore.openedPrice)
			})

			it("emits FillCloseRequest event for ADL close", async function () {
				const quoteId = await openWith(hedger)
				const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
				const adlAmount = decimal(30n)

				const tx = await context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, adlAmount, quoteBefore.openedPrice)
				const events = await parseEvents(tx)

				const fillEvents = events.filter((e: any) => e!.name === "FillCloseRequest")
				expect(fillEvents.length).to.be.greaterThanOrEqual(1)

				const fillEvent = fillEvents[0]
				expect(fillEvent!.args.quoteId).to.equal(quoteId)
				expect(fillEvent!.args.filledAmount).to.equal(adlAmount)
				expect(fillEvent!.args.closedPrice).to.equal(quoteBefore.openedPrice)
			})
		})

		describe("nonce and closeId updates", function () {
			it("increments partyA and partyB nonces after ADL close", async function () {
				const quoteId = await openWith(hedger)
				const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)

				const partyANonceBefore = await context.viewFacet.nonceOfPartyA(await user.getAddress())
				const partyBNonceBefore = await context.viewFacet.nonceOfPartyB(await hedger.getAddress(), await user.getAddress())

				await context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, decimal(30n), quoteBefore.openedPrice)

				const partyANonceAfter = await context.viewFacet.nonceOfPartyA(await user.getAddress())
				const partyBNonceAfter = await context.viewFacet.nonceOfPartyB(await hedger.getAddress(), await user.getAddress())

				expect(partyANonceAfter).to.equal(partyANonceBefore + 1n)
				expect(partyBNonceAfter).to.equal(partyBNonceBefore + 1n)
			})

			it("assigns a new closeId for ADL close", async function () {
				const quoteId = await openWith(hedger)
				const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
				const closeIdBefore = await context.viewFacetQuote.getQuoteCloseId(quoteId)

				await context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, decimal(30n), quoteBefore.openedPrice)

				const closeIdAfter = await context.viewFacetQuote.getQuoteCloseId(quoteId)
				expect(closeIdAfter).to.be.greaterThan(closeIdBefore)
			})
		})

		describe("multiple successive ADL closes", function () {
			it("allows multiple partial ADL closes on the same position", async function () {
				const quoteId = await openWith(hedger)
				const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)

				// First ADL close: 30 units
				await context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, decimal(30n), quoteBefore.openedPrice)
				let quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
				expect(quoteAfter.closedAmount).to.equal(decimal(30n))
				expect(quoteAfter.quoteStatus).to.equal(BigInt(QuoteStatus.OPENED))

				// Second ADL close: 40 units
				await context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, decimal(40n), quoteBefore.openedPrice)
				quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
				expect(quoteAfter.closedAmount).to.equal(decimal(70n))
				expect(quoteAfter.quoteStatus).to.equal(BigInt(QuoteStatus.OPENED))

				// Third ADL close: remaining 30 units (fully close)
				await context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, decimal(30n), quoteBefore.openedPrice)
				quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
				expect(quoteAfter.closedAmount).to.equal(decimal(100n))
				expect(quoteAfter.quoteStatus).to.equal(BigInt(QuoteStatus.CLOSED))
			})

			it("increments closeId on each successive ADL close", async function () {
				const quoteId = await openWith(hedger)
				const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)

				const closeId1 = await context.viewFacetQuote.getQuoteCloseId(quoteId)

				await context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, decimal(30n), quoteBefore.openedPrice)
				const closeId2 = await context.viewFacetQuote.getQuoteCloseId(quoteId)
				expect(closeId2).to.be.greaterThan(closeId1)

				await context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, decimal(30n), quoteBefore.openedPrice)
				const closeId3 = await context.viewFacetQuote.getQuoteCloseId(quoteId)
				expect(closeId3).to.be.greaterThan(closeId2)
			})
		})

		it("keeps existing close request intact after ADL when enough remains to fulfill it", async function () {
			const userClosePrice = decimal(2n)
			const userCloseQty = decimal(60n)
			const quoteId = await openWith(hedger)
			await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(userCloseQty).closePrice(userClosePrice).build())

			const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
			const oldCloseId = await context.viewFacetQuote.getQuoteCloseId(quoteId)
			const adlAmount = decimal(30n) // means we have still amount = 70 after ADL close

			await context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, adlAmount, quoteBefore.openedPrice)

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

			const tx = await context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, adlAmount, quoteBefore.openedPrice)
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

			await context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, adlAmount, quoteBefore.openedPrice)

			const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
			expect(quoteAfter.quoteStatus).to.equal(BigInt(QuoteStatus.CLOSED))
			expect(quoteAfter.quantityToClose).to.equal(0n)
			expect(quoteAfter.requestedClosePrice).to.equal(0n)
			expect(quoteAfter.closedAmount - quoteBefore.closedAmount).to.equal(adlAmount)
			const finalCloseId = await context.viewFacetQuote.getQuoteCloseId(quoteId)
			expect(finalCloseId).to.be.greaterThan(oldCloseId)
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
			const tx = await context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, adlAmount, quoteBefore.openedPrice)
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
			const tx = await context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, adlAmount, quoteBefore.openedPrice)
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
			const tx = await context.partyBEmergencyActionsFacet.connect(hedger.signer).adlClose(quoteId, adlAmount, quoteBefore.openedPrice)
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
