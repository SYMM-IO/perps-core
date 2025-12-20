import { loadFixture, time } from "./helpers/network-helpers"
import { expect } from "chai"

import { initializeFixture } from "./Initialize.fixture"
import { RunContext } from "./models/RunContext"
import { User } from "./models/User"
import { Hedger } from "./models/Hedger"
import { PositionType } from "./models/Enums"
import { limitQuoteRequestBuilder, marketQuoteRequestBuilder } from "./models/requestModels/QuoteRequest"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest"
import { decimal, pausePartyB } from "./utils/Common"
import { getDummyPairUpnlAndPricesSig } from "./utils/SignatureUtils"

export function shouldBehaveLikePartyBBatchActionsFacet(): void {
	let context: RunContext, user: User, user2: User, hedger: Hedger, hedger2: Hedger

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		this.user_allocated = decimal(500n)
		this.hedger_allocated = decimal(400000n)

		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

		user2 = new User(context, context.signers.user2)
		await user2.setup()
		await user2.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(this.hedger_allocated, this.hedger_allocated)

		hedger2 = new Hedger(context, context.signers.hedger2)
		await hedger2.setup()
		await hedger2.setBalances(this.hedger_allocated, this.hedger_allocated)
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

	const requestAndFillClose = async (id: bigint, partyB: Hedger, filled: bigint) => {
		// Party A requests close (LIMIT close; price is irrelevant with dummy oracle)
		await user.requestToClosePosition(id, limitCloseRequestBuilder().build())
		const q = await context.viewFacetQuote.getQuote(id)
		const upnlSig = await getDummyPairUpnlAndPricesSig([q.openedPrice], [id])
		await context.partyBBatchActionsFacet.connect(partyB.signer).fillCloseRequests([id], [filled], [q.openedPrice], upnlSig)
	}

	const expectConnected = async (partyBAddr: string, expected: boolean) => {
		const isConn = await context.viewFacetSymbol.isConnectedPartyB(context.signers.user.address, partyBAddr)
		expect(isConn).to.equal(expected)

		const conns = await context.viewFacetSymbol.getConnectedPartyBs(context.signers.user.address)
		if (expected) {
			expect(conns).to.include(partyBAddr)
		} else {
			expect(conns).to.not.include(partyBAddr)
		}
	}

	describe("openPositions", async function () {
		beforeEach(async function () {
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
			await user.sendQuote(marketQuoteRequestBuilder().positionType(PositionType.LONG).build())

			await hedger.lockQuote(1)
			await hedger.lockQuote(2)
			await hedger.lockQuote(3)
		})

		it("Should fail when PartyB actions are paused", async function () {
			await pausePartyB(context)
			const quoteIds = [1n, 2n]
			const filledAmounts = [decimal(100n), decimal(100n)]
			const openedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions(quoteIds, filledAmounts, openedPrices, upnlSig),
			).to.be.revertedWith("Pausable: PartyB actions paused")
		})

		it("Should fail with invalid array lengths", async function () {
			const quoteIds = [1n, 2n]
			const filledAmounts = [decimal(100n)]
			const openedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions(quoteIds, filledAmounts, openedPrices, upnlSig),
			).to.be.revertedWith("PartyBFacet: Invalid length")
		})

		it("Should fail with empty arrays", async function () {
			const quoteIds: bigint[] = []
			const filledAmounts: bigint[] = []
			const openedPrices: bigint[] = []
			const upnlSig = await getDummyPairUpnlAndPricesSig([], [])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions(quoteIds, filledAmounts, openedPrices, upnlSig),
			).to.be.revertedWith("PartyBFacet: Invalid length")
		})

		it("Should fail when sender is not partyB of quote", async function () {
			const quoteIds = [1n, 2n]
			const filledAmounts = [decimal(100n), decimal(100n)]
			const openedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger2).openPositions(quoteIds, filledAmounts, openedPrices, upnlSig),
			).to.be.revertedWith("PartyBFacet: Sender should be the partyB")
		})

		it("Should fail when partyA is suspended", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(context.signers.hedger.address)

			const quoteIds = [1n, 2n]
			const filledAmounts = [decimal(100n), decimal(100n)]
			const openedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions(quoteIds, filledAmounts, openedPrices, upnlSig),
			).to.be.revertedWith("PartyBFacet: Sender is Suspended")
		})

		it("Should fail when partyB is suspended", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(context.signers.hedger.address)

			const quoteIds = [1n, 2n]
			const filledAmounts = [decimal(100n), decimal(100n)]
			const openedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions(quoteIds, filledAmounts, openedPrices, upnlSig),
			).to.be.revertedWith("PartyBFacet: Sender is Suspended")
		})

		it("Should fail when system is in emergency mode", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).activeEmergencyMode()

			const quoteIds = [1n, 2n]
			const filledAmounts = [decimal(100n), decimal(100n)]
			const openedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions(quoteIds, filledAmounts, openedPrices, upnlSig),
			).to.be.revertedWith("PartyBFacet: System is in emergency mode")
		})

		it("Should fail when partyB is in emergency mode", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).setPartyBEmergencyStatus([context.signers.hedger.address], true)

			const quoteIds = [1n, 2n]
			const filledAmounts = [decimal(100n), decimal(100n)]
			const openedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions(quoteIds, filledAmounts, openedPrices, upnlSig),
			).to.be.revertedWith("PartyBFacet: PartyB is in emergency mode")
		})

		it("Should fail when quotes belong to different partyAs", async function () {
			await user2.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(4)

			const quoteIds = [1n, 4n]
			const filledAmounts = [decimal(100n), decimal(100n)]
			const openedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions(quoteIds, filledAmounts, openedPrices, upnlSig),
			).to.be.revertedWith("PartyBFacet: All positions should belong to one partyA")
		})

		it("Should successfully open multiple positions", async function () {
			const quoteIds = [1n, 2n]
			const filledAmounts = [decimal(100n), decimal(100n)]
			const openedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await expect(context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions(quoteIds, filledAmounts, openedPrices, upnlSig)).to
				.not.reverted
		})
	})

	describe("fillCloseRequests", async function () {
		beforeEach(async function () {
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).price(decimal(4n)).build())
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())

			await hedger.lockQuote(1)
			await hedger.lockQuote(2)
			await hedger.openPosition(1)
			await hedger.openPosition(2)

			await user.requestToClosePosition(1, limitCloseRequestBuilder().build())
			await user.requestToClosePosition(2, limitCloseRequestBuilder().build())
		})

		it("Should fail when PartyB actions are paused", async function () {
			await pausePartyB(context)
			const quoteIds = [1n, 2n]
			const filledAmounts = [decimal(50n), decimal(50n)]
			const closedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).fillCloseRequests(quoteIds, filledAmounts, closedPrices, upnlSig),
			).to.be.revertedWith("Pausable: PartyB actions paused")
		})

		it("Should fail with invalid array lengths", async function () {
			const quoteIds = [1n, 2n]
			const filledAmounts = [decimal(50n)]
			const closedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).fillCloseRequests(quoteIds, filledAmounts, closedPrices, upnlSig),
			).to.be.revertedWith("PartyBFacet: Invalid length")
		})

		it("Should fail with empty arrays", async function () {
			const quoteIds: bigint[] = []
			const filledAmounts: bigint[] = []
			const closedPrices: bigint[] = []
			const upnlSig = await getDummyPairUpnlAndPricesSig([], [])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).fillCloseRequests(quoteIds, filledAmounts, closedPrices, upnlSig),
			).to.be.revertedWith("PartyBFacet: Invalid length")
		})

		it("Should fail when quotes belong to different partyAs", async function () {
			await user2.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(3)
			await hedger.openPosition(3)
			await user2.requestToClosePosition(3, limitCloseRequestBuilder().build())

			const quoteIds = [1n, 3n]
			const filledAmounts = [decimal(50n), decimal(50n)]
			const closedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).fillCloseRequests(quoteIds, filledAmounts, closedPrices, upnlSig),
			).to.be.revertedWith("PartyBBatchActionsFacet: All positions must have same partyA")
		})

		it("Should successfully fill multiple close requests", async function () {
			const quoteIds = [1n, 2n]
			const filledAmounts = [decimal(50n), decimal(50n)]
			const closedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await expect(context.partyBBatchActionsFacet.connect(context.signers.hedger).fillCloseRequests(quoteIds, filledAmounts, closedPrices, upnlSig))
				.to.not.reverted
		})

		it("Should update nonces correctly", async function () {
			const partyANonceBefore = await context.viewFacet.nonceOfPartyA(context.signers.user.address)
			const partyBNonceBefore = await context.viewFacet.nonceOfPartyB(context.signers.hedger.address, context.signers.user.address)

			const quoteIds = [1n, 2n]
			const filledAmounts = [decimal(50n), decimal(50n)]
			const closedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await context.partyBBatchActionsFacet.connect(context.signers.hedger).fillCloseRequests(quoteIds, filledAmounts, closedPrices, upnlSig)

			const partyANonceAfter = await context.viewFacet.nonceOfPartyA(context.signers.user.address)
			const partyBNonceAfter = await context.viewFacet.nonceOfPartyB(context.signers.hedger.address, context.signers.user.address)

			expect(partyANonceAfter).to.equal(partyANonceBefore + 1n)
			expect(partyBNonceAfter).to.equal(partyBNonceBefore + 1n)
		})
	})

	describe("adlClosePositions", async function () {
		beforeEach(async function () {
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.partyBWhiteList([await hedger.getAddress()])
					.positionType(PositionType.LONG)
					.build(),
			)
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.partyBWhiteList([await hedger.getAddress()])
					.positionType(PositionType.SHORT)
					.build(),
			)
			await user2.sendQuote(
				limitQuoteRequestBuilder()
					.positionType(PositionType.SHORT)
					.partyBWhiteList([await hedger2.getAddress()])
					.build(),
			)
			await user2.sendQuote(
				limitQuoteRequestBuilder()
					.partyBWhiteList([await hedger.getAddress()])
					.positionType(PositionType.SHORT)
					.build(),
			)

			await hedger.lockQuote(1)
			await hedger.lockQuote(2)
			await hedger2.lockQuote(3)
			await hedger.lockQuote(4)

			await hedger.openPosition(1)
			await hedger.openPosition(2)
			await hedger.openPosition(4)
		})

		it("Should fail when PartyB actions are paused", async function () {
			await pausePartyB(context)
			const quoteIds = [1n, 2n]
			const filledAmounts = [decimal(50n), decimal(50n)]
			const closedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).adlClosePositions(quoteIds, filledAmounts, closedPrices, upnlSig),
			).to.be.revertedWith("Pausable: PartyB actions paused")
		})

		it("Should fail with invalid array lengths", async function () {
			const quoteIds = [1n, 2n]
			const filledAmounts = [decimal(50n)]
			const closedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).adlClosePositions(quoteIds, filledAmounts, closedPrices, upnlSig),
			).to.be.revertedWith("PartyBFacet: Invalid length")
		})

		it("Should fail with empty arrays", async function () {
			const quoteIds: bigint[] = []
			const filledAmounts: bigint[] = []
			const closedPrices: bigint[] = []
			const upnlSig = await getDummyPairUpnlAndPricesSig([], [])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).adlClosePositions(quoteIds, filledAmounts, closedPrices, upnlSig),
			).to.be.revertedWith("PartyBFacet: Invalid length")
		})

		it("Should fail when quotes belong to different partyAs", async function () {
			const quoteIds = [1n, 4n]
			const filledAmounts = [decimal(50n), decimal(50n)]
			const closedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).adlClosePositions(quoteIds, filledAmounts, closedPrices, upnlSig),
			).to.be.revertedWith("PartyBBatchActionsFacet: All positions must have same partyA")
		})

		it("Should fail when quotes belong to different partyBs", async function () {
			const quoteIds = [1n, 3n]
			const filledAmounts = [decimal(50n), decimal(50n)]
			const closedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).adlClosePositions(quoteIds, filledAmounts, closedPrices, upnlSig),
			).to.be.revertedWith("PartyBBatchActionsFacet: All positions must have same partyB")
		})

		it("Should fail when quote status is not OPENED", async function () {
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.partyBWhiteList([await hedger.getAddress()])
					.positionType(PositionType.LONG)
					.build(),
			)

			const quoteIds = [5n]
			const filledAmounts = [decimal(50n)]
			const closedPrices = [decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n)], [1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).adlClosePositions(quoteIds, filledAmounts, closedPrices, upnlSig),
			).to.be.revertedWith("PartyBBatchActionsFacet: Invalid position state")
		})

		it("Should fail when filled amount is invalid", async function () {
			const quoteIds = [1n]
			const filledAmounts = [decimal(0n)]
			const closedPrices = [decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n)], [1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).adlClosePositions(quoteIds, filledAmounts, closedPrices, upnlSig),
			).to.be.revertedWith("PartyBBatchActionsFacet: Invalid filled amount")
		})

		// it.only("Should fail when symbol is not valid", async function () {
		// 	// Invalidate symbol for quote 1
		// 	const quote = await context.viewFacetQuote.getQuote(1n)
		// 	await context.controlFacet.connect(context.signers.admin).setSymbolValidationState(quote.symbolId, false)

		// 	const quoteIds = [1n]
		// 	const filledAmounts = [decimal(50n)]
		// 	const closedPrices = [decimal(1n)]
		// 	const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n)], [1n])

		// 	await expect(
		// 		context.partyBBatchActionsFacet.connect(context.signers.hedger).adlClosePositions(quoteIds, filledAmounts, closedPrices, upnlSig),
		// 	).to.be.revertedWith("PartyBBatchActionsFacet: Symbol is not valid")
		// })

		it("Should fail when parties become insolvent after closing", async function () {
			const quoteIds = [1n]
			const filledAmounts = [decimal(50n)]
			const closedPrices = [decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n)], [1n], -decimal(10000n), -decimal(10000n))

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).adlClosePositions(quoteIds, filledAmounts, closedPrices, upnlSig),
			).to.be.revertedWith("LibSolvency: Available balance is lower than zero")
		})

		it("Should successfully close multiple positions via ADL", async function () {
			const quoteIds = [1n, 2n]
			const filledAmounts = [decimal(100n), decimal(100n)]
			const closedPrices = [decimal(1n), decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n), decimal(1n)], [1n, 1n])

			await expect(context.partyBBatchActionsFacet.connect(context.signers.hedger).adlClosePositions(quoteIds, filledAmounts, closedPrices, upnlSig))
				.to.not.reverted

			const q1 = await context.viewFacetQuote.getQuote(1)
			const q2 = await context.viewFacetQuote.getQuote(2)

			expect(q1.quoteStatus).to.equal(7n)
			expect(q2.quoteStatus).to.equal(7n)
			expect(q1.closedAmount).to.equal(decimal(100n))
			expect(q2.closedAmount).to.equal(decimal(100n))
		})
	})

	describe("Access Control and Security", async function () {
		beforeEach(async function () {
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(1)
		})

		it("Should fail when called by non-partyB address", async function () {
			const quoteIds = [1n]
			const filledAmounts = [decimal(100n)]
			const openedPrices = [decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n)], [1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.user).openPositions(quoteIds, filledAmounts, openedPrices, upnlSig),
			).to.be.revertedWith("PartyBFacet: Sender should be the partyB")
		})

		it("Should fail when global pause is active", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseGlobal()

			const quoteIds = [1n]
			const filledAmounts = [decimal(100n)]
			const openedPrices = [decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n)], [1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions(quoteIds, filledAmounts, openedPrices, upnlSig),
			).to.be.revertedWith("Pausable: Global paused")
		})

		it("Should handle invalid quote states", async function () {
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			// Dont lock quote 2

			const quoteIds = [2n]
			const filledAmounts = [decimal(100n)]
			const openedPrices = [decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n)], [1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions(quoteIds, filledAmounts, openedPrices, upnlSig),
			).to.be.revertedWith("PartyBFacet: Sender should be the partyB")
		})

		it("Should validate quote expiration", async function () {
			await time.increase(86400) // 1 day

			const quoteIds = [1n]
			const filledAmounts = [decimal(100n)]
			const openedPrices = [decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n)], [1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions(quoteIds, filledAmounts, openedPrices, upnlSig),
			).to.be.revertedWith("PartyBFacet: Quote is expired")
		})
	})

	describe("Edge Cases and Error Handling", async function () {
		beforeEach(async function () {
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(1)
		})

		it("Should fail when opened price is invalid for LONG position", async function () {
			const quote = await context.viewFacetQuote.getQuote(1n)
			const invalidPrice = quote.requestedOpenPrice + decimal(1n)

			const quoteIds = [1n]
			const filledAmounts = [decimal(100n)]
			const openedPrices = [invalidPrice]
			const upnlSig = await getDummyPairUpnlAndPricesSig([invalidPrice], [1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions(quoteIds, filledAmounts, openedPrices, upnlSig),
			).to.be.revertedWith("PartyBFacet: Opened price isn't valid")
		})

		it("Should fail when opened price is invalid for SHORT position", async function () {
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
			await hedger.lockQuote(2)

			const quote = await context.viewFacetQuote.getQuote(2n)
			const invalidPrice = quote.requestedOpenPrice - decimal(1n)

			const quoteIds = [2n]
			const filledAmounts = [decimal(100n)]
			const openedPrices = [invalidPrice]
			const upnlSig = await getDummyPairUpnlAndPricesSig([invalidPrice], [1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions(quoteIds, filledAmounts, openedPrices, upnlSig),
			).to.be.revertedWith("PartyBFacet: Opened price isn't valid")
		})

		it("Should fail when parties become insolvent after opening", async function () {
			const quoteIds = [1n]
			const filledAmounts = [decimal(100n)]
			const openedPrices = [decimal(1n)]
			const upnlSig = await getDummyPairUpnlAndPricesSig([decimal(1n)], [1n], -decimal(10000n), -decimal(10000n))

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions(quoteIds, filledAmounts, openedPrices, upnlSig),
			).to.be.revertedWith("LibSolvency: Available balance is lower than zero")
		})
	})

	describe("Connections: Is Symbol Allowed For PartyA)", function () {
		beforeEach(async function () {})

		it("Baseline: with no connections, A can open with any B regardless of Bs whitelist", async function () {
			// A sends a quote targeted to B2; no connections exist yet.
			await user2.sendQuote(
				limitQuoteRequestBuilder()
					.partyBWhiteList([await hedger2.getAddress()])
					.build(),
			)

			await context.symbolControlFacet
				.connect(context.signers.admin)
				.addSymbol("BTCUSDT_wrapped", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
			await context.symbolControlFacet.connect(context.signers.admin).setSymbolTypes([2], [2])
			await context.symbolControlFacet.whitelistSymbolType(context.signers.hedger.address, 2)

			await hedger2.lockQuote(1)

			const q1 = await context.viewFacetQuote.getQuote(1n)
			const upnlSig = await getDummyPairUpnlAndPricesSig([q1.requestedOpenPrice], [2n])

			// Should succeed even if B2 hasn't whitelisted the symbol yet
			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger2).openPositions([1n], [decimal(100n)], [q1.requestedOpenPrice], upnlSig),
			).to.not.be.reverted
		})

		it("After connecting A↔B1 on Symbol1, opening Symbol2 with B2 reverts if B1 has NOT whitelisted Symbol2", async function () {
			// 1) A opens a first position with B1 → connects A↔B1
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.partyBWhiteList([await hedger.getAddress()])
					.build(),
			)
			await hedger.lockQuote(1)
			const q1 = await context.viewFacetQuote.getQuote(1n)
			const symbol1 = q1.symbolId as bigint

			let upnlSig = await getDummyPairUpnlAndPricesSig([q1.requestedOpenPrice], [1n])
			await context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions([1n], [decimal(100n)], [q1.requestedOpenPrice], upnlSig)

			// Sanity: A is now "connected" to B1 by the open above.

			// 2) Try to open the SAME symbol with B2, but only B2 whitelists it (B1 does NOT)
			await context.symbolControlFacet
				.connect(context.signers.admin)
				.addSymbol("BTCUSDT_wrapped", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
			await context.symbolControlFacet.connect(context.signers.admin).setSymbolTypes([2], [2])
			await context.symbolControlFacet.whitelistSymbolType(context.signers.hedger2.address, 2)
			const symbol2 = 2
			await context.symbolControlFacet.connect(context.signers.admin).whitelistSymbols(await hedger2.getAddress(), [symbol2]) // B2 ✅
			// Important: do NOT whitelist for B1 here.

			await user.sendQuote(
				limitQuoteRequestBuilder()
					.partyBWhiteList([await hedger2.getAddress()])
					.symbolId(symbol2) // ensure same symbol
					.build(),
			)
			await expect(hedger2.lockQuote(2)).to.be.revertedWith("PartyBFacet: Symbol not allowed due to connection restrictions")
		})

		it("After connecting A↔B1 on Symbol1, opening Symbol1 with B2 SUCCEEDS when BOTH B1 and B2 whitelist Symbol1", async function () {
			// Connect A↔B1 by opening first position on Symbol1
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.partyBWhiteList([await hedger.getAddress()])
					.build(),
			)
			await hedger.lockQuote(1)
			const q1 = await context.viewFacetQuote.getQuote(1n)
			const sym = q1.symbolId as bigint

			let upnlSig = await getDummyPairUpnlAndPricesSig([q1.requestedOpenPrice], [1n])
			await context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions([1n], [decimal(100n)], [q1.requestedOpenPrice], upnlSig)

			// Whitelist Symbol1 for BOTH B1 and B2
			await context.symbolControlFacet.connect(context.signers.admin).whitelistSymbols(await hedger.getAddress(), [sym]) // B1 ✅
			await context.symbolControlFacet.connect(context.signers.admin).whitelistSymbols(await hedger2.getAddress(), [sym]) // B2 ✅

			// Now try to open with B2 on the same symbol
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.partyBWhiteList([await hedger2.getAddress()])
					.symbolId(sym)
					.build(),
			)
			await hedger2.lockQuote(2)
			const q2 = await context.viewFacetQuote.getQuote(2n)
			upnlSig = await getDummyPairUpnlAndPricesSig([q2.requestedOpenPrice], [1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger2).openPositions([2n], [decimal(100n)], [q2.requestedOpenPrice], upnlSig),
			).to.not.be.reverted
		})

		it("Consensus via symbol TYPE: succeeds if B1 lacks Symbol1 but HAS Symbol1's type whitelisted", async function () {
			// Connect A↔B1 by opening first position on Symbol1
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.partyBWhiteList([await hedger.getAddress()])
					.build(),
			)
			await hedger.lockQuote(1)
			const q1 = await context.viewFacetQuote.getQuote(1n)
			const sym = q1.symbolId as bigint

			let upnlSig = await getDummyPairUpnlAndPricesSig([q1.requestedOpenPrice], [1n])
			await context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions([1n], [decimal(100n)], [q1.requestedOpenPrice], upnlSig)

			// Get the symbol type
			const symbolInfo = await context.viewFacetSymbol.getSymbolWithType(sym)
			const symType = symbolInfo.symbolType

			// B2 explicitly whitelists Symbol1; B1 whitelists only the type (not the symbol)
			await context.symbolControlFacet.connect(context.signers.admin).whitelistSymbols(await hedger2.getAddress(), [sym]) // B2 ✅ symbol
			await context.symbolControlFacet.connect(context.signers.admin).whitelistSymbolType(await hedger.getAddress(), symType) // B1 ✅ type

			// Try to open with B2 on Symbol1 → should pass because check allows symbol OR type per B
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.partyBWhiteList([await hedger2.getAddress()])
					.symbolId(sym)
					.build(),
			)
			await hedger2.lockQuote(2)
			const q2 = await context.viewFacetQuote.getQuote(2n)
			upnlSig = await getDummyPairUpnlAndPricesSig([q2.requestedOpenPrice], [1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger2).openPositions([2n], [decimal(100n)], [q2.requestedOpenPrice], upnlSig),
			).to.not.be.reverted
		})

		it("If any connected B blacklists Symbol1, opening with ANY B must revert", async function () {
			await context.symbolControlFacet
				.connect(context.signers.admin)
				.addSymbol("BTCUSDT_wrapped", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
			await context.symbolControlFacet.connect(context.signers.admin).setSymbolTypes([2], [2])
			// Connect A↔B1 on Symbol1
			await user.sendQuote(limitQuoteRequestBuilder().symbolId(2).build())

			const quote1 = await context.viewFacetQuote.getQuote(1n)
			const sym = quote1.symbolId as bigint
			await context.symbolControlFacet.connect(context.signers.admin).whitelistSymbols(await hedger.getAddress(), [sym])
			await hedger.lockQuote(1)

			let upnlSig = await getDummyPairUpnlAndPricesSig([quote1.requestedOpenPrice], [1n])
			await context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions([1n], [decimal(100n)], [quote1.requestedOpenPrice], upnlSig)

			// Whitelist Symbol1 for B2
			await context.symbolControlFacet.connect(context.signers.admin).whitelistSymbols(await hedger2.getAddress(), [sym])

			// Try to open with B2 on the same Symbol1
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.partyBWhiteList([await hedger2.getAddress()])
					.symbolId(sym)
					.build(),
			)
			await hedger2.lockQuote(2)
			const quote2 = await context.viewFacetQuote.getQuote(2n)
			upnlSig = await getDummyPairUpnlAndPricesSig([quote2.requestedOpenPrice], [1n])

			// Now blacklist Symbol1 on B1 → should trump the whitelist and block
			await context.symbolControlFacet.connect(context.signers.admin).removeSymbolsFromWhitelist(await hedger.getAddress(), [sym])
			await context.symbolControlFacet.connect(context.signers.admin).blacklistSymbols(await hedger.getAddress(), [sym])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger2).openPositions([2n], [decimal(100n)], [quote2.requestedOpenPrice], upnlSig),
			).to.be.revertedWith("PartyBFacet: Symbol not allowed due to connection restrictions")
		})
	})

	describe("Connections: addConnection()", function () {
		beforeEach(async function () {})

		it("adds a connection on first successful open", async function () {
			// Allow a roomy cap to avoid incidental reverts
			await context.controlFacet.connect(context.signers.admin).setMaxPartyAConnectionLimit(10)

			await openWith(hedger)

			// Assert via view (use whatever getters your ViewFacet exposes)
			const connections = await context.viewFacetSymbol.getConnectedPartyBs(user.address) // e.g., address[]
			expect(connections).to.include(await hedger.getAddress())
			expect(connections.length).to.equal(1)

			const isConn = await context.viewFacetSymbol.isConnectedPartyB(context.signers.user.address, await hedger.getAddress())
			expect(isConn).to.equal(true)
		})

		it("is idempotent: opening again with the same B does not duplicate the connection", async function () {
			await context.controlFacet.connect(context.signers.admin).setMaxPartyAConnectionLimit(1)
			await openWith(hedger)
			// Open another position with the SAME B — should not revert and should NOT add a second entry
			await openWith(hedger)

			const connects = await context.viewFacetSymbol.getConnectedPartyBs(context.signers.user.address)
			expect(connects.length).to.equal(1) // still one unique B
			expect(connects[0]).to.equal(await hedger.getAddress())
		})

		it("enforces the max connection limit: reverts when trying to connect to a new B beyond the cap", async function () {
			// Cap connections at 1
			await context.controlFacet.connect(context.signers.admin).setMaxPartyAConnectionLimit(1)

			// First connection (A↔B1) succeeds
			await openWith(hedger)

			// Second connection (A↔B2) should FAIL on the first time addConnection() is attempted
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.partyBWhiteList([await hedger2.getAddress()])
					.build(),
			)
			const id2 = await context.viewFacetQuote.getNextQuoteId()
			await hedger2.lockQuote(id2)

			const q2 = await context.viewFacetQuote.getQuote(id2)
			const upnlSig2 = await getDummyPairUpnlAndPricesSig([q2.requestedOpenPrice], [1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger2).openPositions([id2], [decimal(100n)], [q2.requestedOpenPrice], upnlSig2),
			).to.be.revertedWith("AccountFacet: PartyA max connection limit exceeded")
		})

		it("does not consume limit when re-opening with an already-connected B", async function () {
			// Cap = 1: A can keep trading with B1 freely
			await context.controlFacet.connect(context.signers.admin).setMaxPartyAConnectionLimit(1)

			await openWith(hedger)
			await openWith(hedger) // should still be fine

			// And still blocked for a *new* B
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.partyBWhiteList([await hedger2.getAddress()])
					.build(),
			)
			const id2 = await context.viewFacetQuote.getNextQuoteId()
			await hedger2.lockQuote(id2)
			const q2 = await context.viewFacetQuote.getQuote(id2)
			const upnlSig2 = await getDummyPairUpnlAndPricesSig([q2.requestedOpenPrice], [1n])

			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger2).openPositions([id2], [decimal(100n)], [q2.requestedOpenPrice], upnlSig2),
			).to.be.revertedWith("AccountFacet: PartyA max connection limit exceeded")
		})
	})

	describe("Connections: removeConnectionIfNoPositions()", function () {
		beforeEach(async function () {
			// Allow generous connection cap so we don't trip the limit mid-tests
			await context.controlFacet.connect(context.signers.admin).setMaxPartyAConnectionLimit(10)
		})

		it("removes connection after the last (A,B) position is fully closed", async function () {
			const id = await openWith(hedger)
			await expectConnected(await hedger.getAddress(), true) // connection created

			// Fully close (filled == 100%)
			await requestAndFillClose(id, hedger, decimal(100n))

			// Connection should be removed (positions count for (B,A) is now zero)
			await expectConnected(await hedger.getAddress(), false)
		})

		it("does NOT remove connection after a partial close", async function () {
			const id = await openWith(hedger)
			await expectConnected(await hedger.getAddress(), true)

			// Partial close (50%)
			await requestAndFillClose(id, hedger, decimal(50n))

			// Still an open remainder → connection must persist
			await expectConnected(await hedger.getAddress(), true)
		})

		it("does NOT remove connection if another (A,B) position remains open", async function () {
			// Open two positions with the same B
			const id1 = await openWith(hedger)
			const id2 = await openWith(hedger)
			await expectConnected(await hedger.getAddress(), true)

			// Fully close only the first
			await requestAndFillClose(id1, hedger, decimal(100n))

			// One position still open → connection must persist
			await expectConnected(await hedger.getAddress(), true)

			// Now close the second fully → connection should drop
			await requestAndFillClose(id2, hedger, decimal(100n))
			await expectConnected(await hedger.getAddress(), false)
		})

		it("removing B1’s connection does not affect other Bs (B2 stays connected)", async function () {
			const idB1 = await openWith(hedger)
			const idB2 = await openWith(hedger2)

			await expectConnected(await hedger.getAddress(), true)
			await expectConnected(await hedger2.getAddress(), true)

			// Fully close B1 position(s)
			await requestAndFillClose(idB1, hedger, decimal(100n))

			// B1 should be removed; B2 must still be connected
			await expectConnected(await hedger.getAddress(), false)
			await expectConnected(await hedger2.getAddress(), true)

			// Clean up: close B2 to avoid leakage across tests
			await requestAndFillClose(idB2, hedger2, decimal(100n))
			await expectConnected(await hedger2.getAddress(), false)
		})
	})
}
