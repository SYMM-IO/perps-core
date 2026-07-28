import { expect } from "chai"

import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture } from "../helpers/network-helpers.js"
import { PositionType, QuoteStatus } from "../models/Enums.js"
import { Hedger } from "../models/Hedger.js"
import { RunContext } from "../models/RunContext.js"
import { User } from "../models/User.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal, unDecimal } from "../utils/Common.js"
import { getDummyPairUpnlAndPriceSig, getDummySingleUpnlAndPriceSig, getDummySingleUpnlSig } from "../utils/SignatureUtils.js"

const SEND_QUOTE_WITH_DATA_AND_FEE_CAPS =
	"sendQuote(address[],uint256,uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,(bytes,uint256,int256,uint256,bytes,(uint256,address,address)),bytes,(uint256,uint256))"

describe("LockAndOpenPosition", function () {
	let context: RunContext, user: User, hedger: Hedger

	const openPrice = decimal(1n)
	const quantity = decimal(100n)

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)

		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(5000n), decimal(3000n), decimal(3000n))

		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(10000n), decimal(10000n))

		// Two identical quotes: one for the sequential baseline, one for the combined call
		await user.sendQuote()
		await user.sendQuote()
	})

	async function allocateForQuote(quoteId: bigint) {
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const notional = unDecimal(BigInt(quote.quantity) * quote.requestedOpenPrice)
		await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB((notional * 12n) / 10n, quote.partyA)
	}

	function lockAndOpen(quoteId: bigint, filledAmount: bigint = quantity, price: bigint = openPrice, solverFee: bigint = 0n) {
		return (async () =>
			context.partyBExecutionFacet
				.connect(context.signers.hedger)
				.lockAndOpenPosition(
					quoteId,
					filledAmount,
					price,
					await getDummySingleUpnlSig(0n),
					await getDummyPairUpnlAndPriceSig(openPrice),
					solverFee,
				))()
	}

	it("should produce the same quote state as sequential lockQuote + openPosition", async function () {
		await hedger.lockQuote(1)
		await hedger.openPosition(1)

		await allocateForQuote(2n)
		await lockAndOpen(2n)

		const sequential = await context.viewFacetQuote.getQuote(1)
		const combined = await context.viewFacetQuote.getQuote(2)

		expect(combined.quoteStatus).to.equal(QuoteStatus.OPENED)
		expect(combined.quoteStatus).to.equal(sequential.quoteStatus)
		expect(combined.openedPrice).to.equal(sequential.openedPrice)
		expect(combined.initialOpenedPrice).to.equal(sequential.initialOpenedPrice)
		expect(combined.quantity).to.equal(sequential.quantity)
		expect(combined.partyB).to.equal(sequential.partyB)
		expect(combined.lockedValues.cva).to.equal(sequential.lockedValues.cva)
		expect(combined.lockedValues.lf).to.equal(sequential.lockedValues.lf)
		expect(combined.lockedValues.partyAmm).to.equal(sequential.lockedValues.partyAmm)
		expect(combined.lockedValues.partyBmm).to.equal(sequential.lockedValues.partyBmm)
	})

	it("should emit LockQuote and OpenPosition events in one transaction", async function () {
		await allocateForQuote(1n)
		const hedgerAddress = await context.signers.hedger.getAddress()
		await expect(lockAndOpen(1n))
			.to.emit(context.partyBQuoteActionsFacet, "LockQuote")
			.withArgs(hedgerAddress, 1)
			.and.to.emit(context.partyBPositionActionsFacet, "OpenPosition(uint256,address,address,uint256,uint256)")
			.withArgs(1, user.address, hedgerAddress, quantity, openPrice)
	})

	it("should emit LockQuote before the open-side fee and position events", async function () {
		await allocateForQuote(1n)
		const tx = await lockAndOpen(1n)
		const receipt = (await tx.wait())!

		const lockTopic = ethers.id("LockQuote(address,uint256)")
		const feeTopic = ethers.id("TradingFeeCharged(uint256,uint256,address,address,uint256,address,uint8)")
		const openTopic = ethers.id("OpenPosition(uint256,address,address,uint256,uint256)")

		const indexOf = (topic: string) => receipt.logs.findIndex(l => l.topics[0] === topic)
		const iLock = indexOf(lockTopic)
		const iFee = indexOf(feeTopic)
		const iOpen = indexOf(openTopic)

		expect(iLock).to.be.gte(0)
		expect(iFee).to.be.gte(0)
		expect(iOpen).to.be.gte(0)
		// Sequential flow order: LockQuote first, then the events openPosition emits internally, then OpenPosition
		expect(iLock).to.be.lt(iFee)
		expect(iFee).to.be.lt(iOpen)
	})

	it("should track the position in open positions and clear pending state", async function () {
		await allocateForQuote(1n)
		await lockAndOpen(1n)

		const pendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(user.address)
		expect(pendingQuotes.length).to.equal(1) // only quote 2 remains pending
		const openPositions = await context.viewFacetQuote.getPartyAOpenPositions(user.address, 0, 10)
		expect(openPositions.length).to.equal(1)
		expect(openPositions[0].id).to.equal(1n)
	})

	it("should support partial fill and create a pending child quote", async function () {
		await allocateForQuote(1n)
		await lockAndOpen(1n, quantity / 2n)

		const opened = await context.viewFacetQuote.getQuote(1)
		expect(opened.quoteStatus).to.equal(QuoteStatus.OPENED)
		expect(opened.quantity).to.equal(quantity / 2n)

		const child = await context.viewFacetQuote.getQuote(3) // 2 quotes existed, child gets id 3
		expect(child.quoteStatus).to.equal(QuoteStatus.PENDING)
		expect(child.quantity).to.equal(quantity / 2n)
		expect(child.parentId).to.equal(1n)
	})

	it("should charge the solver fee when the quote carries an open rate cap", async function () {
		// Quote 3 with a 2% open rate cap, so a fee can be charged through the combined entry
		const openRateCap = decimal(2n, 16)
		const request = limitQuoteRequestBuilder()
			.partyBWhiteList([await hedger.getAddress()])
			.upnlSig(getDummySingleUpnlAndPriceSig(decimal(1n)))
			.build()
		const sendQuote = (context.partyAFacet.connect(context.signers.user) as any)[SEND_QUOTE_WITH_DATA_AND_FEE_CAPS]
		await sendQuote(
			request.partyBWhiteList,
			request.symbolId,
			request.positionType,
			request.orderType,
			request.price,
			request.quantity,
			request.cva,
			request.lf,
			request.partyAmm,
			request.partyBmm,
			await request.deadline,
			await context.accountManager.getAddress(),
			await request.upnlSig,
			"0x",
			[openRateCap, openRateCap],
		)

		await allocateForQuote(3n)
		const solverFee = decimal(1n) // 1 unit on a 100-notional quote = 1%, within the 2% cap
		const hedgerAddress = await hedger.getAddress()

		await expect(lockAndOpen(3n, quantity, openPrice, solverFee))
			.to.emit(context.partyBExecutionFacet, "OpenSolverFeeCharged")
			.withArgs(3, (await context.viewFacetQuote.getQuote(3)).partyA, hedgerAddress, request.symbolId, solverFee)
	})

	it("should fail when caller is not a partyB", async function () {
		await expect(
			(async () =>
				context.partyBExecutionFacet
					.connect(context.signers.user2)
					.lockAndOpenPosition(1, quantity, openPrice, await getDummySingleUpnlSig(0n), await getDummyPairUpnlAndPriceSig(openPrice), 0))(),
		).to.be.revertedWith("Accessibility: Should be partyB")
	})

	it("should fail on an already locked quote", async function () {
		await hedger.lockQuote(1)
		await allocateForQuote(2n)
		await expect(lockAndOpen(1n)).to.be.revertedWith("PartyBFacet: Invalid state")
	})

	it("should fail when partyB has insufficient available balance", async function () {
		// no allocateForQuote call — hedger has nothing allocated for this partyA
		await expect(lockAndOpen(1n)).to.be.revertedWith("PartyBFacet: insufficient available balance")
	})

	it("should fail when the opened price is invalid for the position type", async function () {
		await allocateForQuote(1n)
		await expect(lockAndOpen(1n, quantity, openPrice + 1n)).to.be.revertedWith("PartyBFacet: Opened price isn't valid")
	})

	it("should fail when partyA is suspended", async function () {
		await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(user.address)
		await allocateForQuote(1n)
		await expect(lockAndOpen(1n)).to.be.revertedWith("PartyBFacet: PartyA is suspended")
	})

	it("should work for SHORT quotes as well", async function () {
		await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
		await allocateForQuote(3n)
		await lockAndOpen(3n)
		const quote = await context.viewFacetQuote.getQuote(3)
		expect(quote.quoteStatus).to.equal(QuoteStatus.OPENED)
	})

	describe("binding flipped by a hook mid-open", function () {
		let user2: User
		const boundQuoteId = 3n

		beforeEach(async function () {
			// Fresh partyA with no pending quotes so bindToPartyB is allowed
			user2 = new User(context, context.signers.user2)
			await user2.setup()
			await user2.setBalances(decimal(5000n), decimal(3000n), decimal(3000n))

			const hedgerAddress = await context.signers.hedger.getAddress()
			await context.controlFacet.connect(context.signers.admin).setPartyBBindable(hedgerAddress, true)
			await context.bindingFacet.connect(context.signers.user2).bindToPartyB(hedgerAddress)
			await user2.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([hedgerAddress]).build())

			// Matured pending unbind: completeUnbindRequest becomes permissionless, so any hook can finish it
			await context.controlFacet.connect(context.signers.admin).setUnbindCooldown(0)
			await context.bindingFacet.connect(context.signers.user2).requestToUnbindFromPartyB()

			const UnbindHook = await ethers.getContractFactory("UnbindDuringOpenHook")
			const hook = await UnbindHook.deploy(context.diamond)
			await hook.waitForDeployment()
			await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await hook.getAddress())
			// Deliberately no allocateForPartyB: the test passes only if the post-open solvency check runs
		})

		it("re-checks binding after hooks so the solvency check still runs", async function () {
			await expect(lockAndOpen(boundQuoteId)).to.be.revertedWith("LibSolvency: Available balance is lower than zero")
		})

		it("matches the sequential lockQuote + openPosition behavior", async function () {
			await context.partyBQuoteActionsFacet.connect(context.signers.hedger).lockQuote(boundQuoteId, await getDummySingleUpnlSig(0n))
			await expect(
				context.partyBPositionActionsFacet
					.connect(context.signers.hedger)
					.openPosition(boundQuoteId, quantity, openPrice, await getDummyPairUpnlAndPriceSig(openPrice)),
			).to.be.revertedWith("LibSolvency: Available balance is lower than zero")
		})
	})
})
