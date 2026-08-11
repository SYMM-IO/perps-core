import { expect } from "chai"

import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture } from "../helpers/network-helpers.js"
import { RunContext } from "../models/RunContext.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal } from "../utils/Common.js"

// VirtualAccountIsolationType / SubAccountIsolationType.POSITION
const POSITION = 0
const MARGIN = decimal(1000n)

describe("CallWithMargin", function () {
	let context: RunContext
	let subAccount: string
	let quoteCallData: string

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		const user = context.signers.user
		const affiliate = await context.accountManager.getAddress()

		const creationData = [{ name: "cwm", metadata: "0x", symmioCore: context.diamond, isolationType: POSITION, singleVAMode: false }]
		const predicted = await context.alCoreFacet.connect(user).createSubAccounts.staticCall(affiliate, creationData)
		await context.alCoreFacet.connect(user).createSubAccounts(affiliate, creationData)
		subAccount = predicted[0]

		await context.collateral.connect(user).mint(user.address, decimal(100000n))
		await context.collateral.connect(user).approve(context.diamond, ethers.MaxUint256)
		await context.accountFacet.connect(user).depositFor(subAccount, decimal(10000n))

		const request = limitQuoteRequestBuilder()
			.partyBWhiteList([await context.signers.hedger.getAddress()])
			.build()
		quoteCallData = context.partyAFacet.interface.encodeFunctionData("sendQuoteWithAffiliate", [
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
			request.maxFundingRate,
			await request.deadline,
			request.affiliate,
			await request.upnlSig,
		])
	})

	it("should produce the same state as sequential addMarginToNextVA + _call", async function () {
		const user = context.signers.user

		// Sequential baseline → quote 1 on VA #1
		await context.alMarginFacet.connect(user).addMarginToNextVA(subAccount, POSITION, 1, MARGIN)
		await context.alCoreFacet.connect(user)._call(subAccount, [quoteCallData])

		// Combined call → quote 2 on VA #2
		await context.alCoreFacet.connect(user)._callWithMargin(subAccount, POSITION, 1, MARGIN, [quoteCallData])

		const sequential = await context.viewFacetQuote.getQuote(1)
		const combined = await context.viewFacetQuote.getQuote(2)

		expect(combined.quoteStatus).to.equal(sequential.quoteStatus)
		expect(combined.quantity).to.equal(sequential.quantity)
		expect(combined.lockedValues.cva).to.equal(sequential.lockedValues.cva)
		expect(combined.lockedValues.partyAmm).to.equal(sequential.lockedValues.partyAmm)
		expect(combined.partyA).to.not.equal(sequential.partyA) // two distinct fresh VAs

		// margin (minus trading fee) allocated to each quote's VA identically
		const seqAllocated = await context.viewFacet.allocatedBalanceOfPartyA(sequential.partyA)
		const combAllocated = await context.viewFacet.allocatedBalanceOfPartyA(combined.partyA)
		expect(combAllocated).to.equal(seqAllocated)
	})

	it("should route the margin to the same VA the sendQuote creates", async function () {
		await context.alCoreFacet.connect(context.signers.user)._callWithMargin(subAccount, POSITION, 1, MARGIN, [quoteCallData])
		const quote = await context.viewFacetQuote.getQuote(1)
		// The quote's VA holds the margin minus the trading fee — proves prediction matched creation
		const allocated = await context.viewFacet.allocatedBalanceOfPartyA(quote.partyA)
		expect(allocated).to.be.gt(0n)
		const va = await context.alViewFacet.getVirtualAccount(quote.partyA)
		expect(va.isExists).to.be.true
		expect(va.parentAccount).to.equal(subAccount)
	})

	it("should emit AddMargin and Call events", async function () {
		await expect(context.alCoreFacet.connect(context.signers.user)._callWithMargin(subAccount, POSITION, 1, MARGIN, [quoteCallData]))
			.to.emit(context.alMarginFacet, "AddMargin")
			.and.to.emit(context.alCoreFacet, "Call")
	})

	it("should revert on zero margin amount", async function () {
		await expect(
			context.alCoreFacet.connect(context.signers.user)._callWithMargin(subAccount, POSITION, 1, 0, [quoteCallData]),
		).to.be.revertedWithCustomError(context.alCoreFacet, "ZeroAmount")
	})

	it("should revert on mismatched isolation type", async function () {
		const MARKET = 1
		await expect(
			context.alCoreFacet.connect(context.signers.user)._callWithMargin(subAccount, MARKET, 1, MARGIN, [quoteCallData]),
		).to.be.revertedWithCustomError(context.alCoreFacet, "InvalidIsolationType")
	})

	it("should revert when the quote symbol does not match the margin key", async function () {
		// margin sent to the (POSITION, symbol 2) VA while the quote routes to (POSITION, symbol 1)
		await expect(
			context.alCoreFacet.connect(context.signers.user)._callWithMargin(subAccount, POSITION, 2, MARGIN, [quoteCallData]),
		).to.be.revertedWithCustomError(context.alCoreFacet, "MarginKeyMismatch")
	})

	it("should revert when the quote direction does not match a directional margin key", async function () {
		const MARKET_DIRECTION = 2 // SubAccountIsolationType
		const MARKET_SHORT = 3 // VirtualAccountIsolationType
		const user = context.signers.user
		const affiliate = await context.accountManager.getAddress()

		const creationData = [{ name: "cwm-dir", metadata: "0x", symmioCore: context.diamond, isolationType: MARKET_DIRECTION, singleVAMode: false }]
		const predicted = await context.alCoreFacet.connect(user).createSubAccounts.staticCall(affiliate, creationData)
		await context.alCoreFacet.connect(user).createSubAccounts(affiliate, creationData)
		await context.accountFacet.connect(user).depositFor(predicted[0], decimal(5000n))

		// margin funds the MARKET_SHORT VA while the quote is LONG
		await expect(
			context.alCoreFacet.connect(user)._callWithMargin(predicted[0], MARKET_SHORT, 1, MARGIN, [quoteCallData]),
		).to.be.revertedWithCustomError(context.alCoreFacet, "MarginKeyMismatch")
	})

	it("should revert when caller is not the account owner", async function () {
		await expect(context.alCoreFacet.connect(context.signers.user2)._callWithMargin(subAccount, POSITION, 1, MARGIN, [quoteCallData])).to.be.reverted
	})

	it("should revert on empty callDatas", async function () {
		await expect(
			context.alCoreFacet.connect(context.signers.user)._callWithMargin(subAccount, POSITION, 1, MARGIN, []),
		).to.be.revertedWithCustomError(context.alCoreFacet, "EmptyArray")
	})
})
