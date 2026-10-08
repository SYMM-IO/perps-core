import { expect } from "chai"

import { initializeFixture } from "../../Initialize.fixture.js"
import { ethers } from "../../helpers/hardhat-connection.js"
import { loadFixture } from "../../helpers/network-helpers.js"
import type { RunContext } from "../../models/RunContext.js"
import { User } from "../../models/User.js"
import { limitQuoteRequestBuilder } from "../../models/requestModels/QuoteRequest.js"
import { decimal } from "../../utils/Common.js"

// These tests model the selector transition. They do not replace a fork rehearsal
// against the complete deployed Core implementation and peripheral configuration.
describe("AccountLayer compatibility before and after the Core cut (verification)", function () {
	this.timeout(180000)
	let context: RunContext
	beforeEach(async () => {
		context = await loadFixture(initializeFixture)
		const user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(10000n))
		await context.controlFacet.registerHook(ethers.ZeroAddress, context.accountLayerDiamond)
		await context.symbolControlFacet
			.connect(context.signers.admin)
			.addSymbol("ETHUSDT", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
	})

	async function createParent(isolationType = 0) {
		const owner = context.signers.user
		await context.alCoreFacet
			.connect(owner)
			.createSubAccounts(await context.accountManager.getAddress(), [
				{ name: "compatibility", metadata: "0x", symmioCore: context.diamond, isolationType, singleVAMode: false },
			])
		const [parent] = await context.alViewFacet.getUserSubAccountsAddresses(owner.address, 0, 1)
		await context.collateral.connect(owner).approve(context.diamond, decimal(3000n))
		await context.accountFacet.connect(owner).depositFor(parent, decimal(3000n))
		return parent
	}

	async function removeAllocatedTransfer() {
		const selector = context.accountFacet.interface.getFunction("internalTransferToAllocatedBalance")!.selector
		const facet = await context.diamondLoupeFacet.facetAddress(selector)
		await context.diamondCutFacet
			.connect(context.signers.admin)
			.diamondCut([{ facetAddress: ethers.ZeroAddress, action: 2, functionSelectors: [selector] }], ethers.ZeroAddress, "0x")
		return { selector, facet }
	}

	async function sendQuoteCall() {
		const q = limitQuoteRequestBuilder().build()
		return context.partyAFacet.interface.encodeFunctionData(
			"sendQuoteWithAffiliate(address[],uint256,uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,(bytes,uint256,int256,uint256,bytes,(uint256,address,address)))",
			[
				q.partyBWhiteList,
				q.symbolId,
				q.positionType,
				q.orderType,
				q.price,
				q.quantity,
				q.cva,
				q.lf,
				q.partyAmm,
				q.partyBmm,
				q.maxFundingRate,
				await q.deadline,
				ethers.ZeroAddress,
				await q.upnlSig,
			],
		)
	}

	it("keeps existing addMargin working when Core lacks the new selector", async () => {
		const parent = await createParent(3)
		await context.alCoreFacet.connect(context.signers.user).createCustomVirtualAccount(parent, "0x", 1, 1)
		const [account] = await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(parent, 0, 1)
		await removeAllocatedTransfer()
		const pause = await context.viewFacet.pauseState()
		await context.alMarginFacet.connect(context.signers.user).addMargin(account, decimal(25n))
		expect(await context.viewFacet.allocatedBalanceOfPartyA(account)).to.equal(decimal(25n))
		expect(await context.viewFacet.pauseState()).to.deep.equal(pause)
	})

	it("keeps prefunding and quote submission working before Core is upgraded", async () => {
		const parent = await createParent()
		await removeAllocatedTransfer()
		await context.alMarginFacet.connect(context.signers.user).addMarginToNextVA(parent, 0, 1, decimal(500n))
		const before = await context.viewFacetQuote.getNextQuoteId()
		await context.alCoreFacet.connect(context.signers.user)._call(parent, [await sendQuoteCall()])
		expect(await context.viewFacetQuote.getNextQuoteId()).to.equal(before + 1n)
		expect((await context.viewFacet.pauseState())[0]).to.equal(false)
	})

	it("keeps _callWithMargin working before Core is upgraded", async () => {
		const parent = await createParent()
		await removeAllocatedTransfer()
		const before = await context.viewFacetQuote.getNextQuoteId()
		await context.alCoreFacet.connect(context.signers.user)._callWithMargin(parent, 0, 1, decimal(500n), [await sendQuoteCall()])
		expect(await context.viewFacetQuote.getNextQuoteId()).to.equal(before + 1n)
	})

	it("switches after the cut while respecting a legacy internal-transfer pause", async () => {
		const parent = await createParent()
		const { selector, facet } = await removeAllocatedTransfer()
		await context.pauseControlFacet.connect(context.signers.admin).pauseInternalTransfer()
		await expect(context.alMarginFacet.connect(context.signers.user).addMarginToNextVA(parent, 0, 1, decimal(25n))).to.be.revertedWith(
			"Pausable: Internal transfer paused",
		)
		await context.diamondCutFacet
			.connect(context.signers.admin)
			.diamondCut([{ facetAddress: facet, action: 0, functionSelectors: [selector] }], ethers.ZeroAddress, "0x")
		await context.alMarginFacet.connect(context.signers.user).addMarginToNextVA(parent, 0, 1, decimal(25n))
		const predicted = await context.alViewFacet.predictNextVirtualAccountAddress(parent, 0, 1)
		expect(await context.viewFacet.allocatedBalanceOfPartyA(predicted)).to.equal(decimal(25n))
		expect((await context.viewFacet.pauseState())[5]).to.equal(true)
	})

	it("does not fall back when the upgraded Core rejects the role", async () => {
		const parent = await createParent()
		await context.controlFacet.connect(context.signers.admin).revokeRole(context.accountLayerDiamond, ethers.id("BALANCE_SETTLER_ROLE"))
		await expect(context.alMarginFacet.connect(context.signers.user).addMarginToNextVA(parent, 0, 1, decimal(25n))).to.be.revertedWith(
			"Accessibility: Must have role",
		)
	})

	it("does not fall back when upgraded Core accounting is paused", async () => {
		const parent = await createParent()
		await context.pauseControlFacet.connect(context.signers.admin).pauseAccounting()
		await expect(context.alMarginFacet.connect(context.signers.user).addMarginToNextVA(parent, 0, 1, decimal(25n))).to.be.revertedWith(
			"Pausable: Accounting paused",
		)
	})
})
