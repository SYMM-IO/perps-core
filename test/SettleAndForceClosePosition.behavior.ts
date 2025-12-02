import {loadFixture, time} from "@nomicfoundation/hardhat-network-helpers"

import {initializeFixture} from "./Initialize.fixture"
import {PositionType, QuoteStatus} from "./models/Enums"
import {Hedger} from "./models/Hedger"
import {RunContext} from "./models/RunContext"
import {User} from "./models/User"
import {limitCloseRequestBuilder} from "./models/requestModels/CloseRequest"
import {limitQuoteRequestBuilder} from "./models/requestModels/QuoteRequest"
import {decimal, getBlockTimestamp, getQuoteQuantity, unDecimal,} from "./utils/Common"
import {getDummyCrossSettlementSig, getDummyHighLowPriceSig, getDummySettlementSig} from "./utils/SignatureUtils"
import {CrossQuoteSettlementDataStruct, CrossQuoteSettlementDataStructOutput, CrossSettlementSigStruct, CrossSettlementSigStructOutput, QuoteStructOutput} from "../src/types/contracts/interfaces/ISymmio"
import {limitOpenRequestBuilder} from "./models/requestModels/OpenRequest"
import {QuoteSettlementDataStructOutput} from "../src/types/contracts/facets/Settlement/ISettlementFacet"
import {expect} from "chai"
import { ethers } from "hardhat"
import { exec } from "child_process"

export function shouldBehaveLikeSettleAndForceClosePosition(): void {
	let user: User, hedger: Hedger
	let context: RunContext
	let quote1LongOpened: QuoteStructOutput, quote2ShortOpened: QuoteStructOutput

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		this.user_allocated = decimal(500n)
		this.hedger_allocated = decimal(300n)

		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(this.hedger_allocated, this.hedger_allocated)


		// Quote1 LONG opened
		quote1LongOpened = await context.viewFacet.getQuote(await user.sendQuote())
		await hedger.lockQuote(quote1LongOpened.id)
		await hedger.openPosition(quote1LongOpened.id)

		// Quote2 SHORT opened
		quote2ShortOpened = await context.viewFacet.getQuote(
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.positionType(PositionType.SHORT)
					.quantity(decimal(75n))
					.build()
			)
		)
		await hedger.lockQuote(quote2ShortOpened.id)
		await hedger.openPosition(quote2ShortOpened.id, limitOpenRequestBuilder().filledAmount(decimal(75n)).build())

		await user.requestToClosePosition(
			quote1LongOpened.id,
			limitCloseRequestBuilder()
				.quantityToClose(await getQuoteQuantity(context, quote1LongOpened.id))
				.closePrice(decimal(5n))
				.deadline((await getBlockTimestamp()) + 1000n)
				.build(),
		)
		await user.requestToClosePosition(
			quote2ShortOpened.id,
			limitCloseRequestBuilder()
				.quantityToClose(await getQuoteQuantity(context, quote2ShortOpened.id))
				.closePrice(decimal(5n))
				.deadline((await getBlockTimestamp()) + 1000n)
				.build(),
		)
		await context.controlFacet.setForceCloseMinSigPeriod(10)
		await context.controlFacet.setForceCloseGapRatio((await context.viewFacet.getQuote(quote1LongOpened.id)).symbolId, decimal(1n, 17))

		quote1LongOpened = await context.viewFacet.getQuote(quote1LongOpened.id)
		quote2ShortOpened = await context.viewFacet.getQuote(quote2ShortOpened.id)
	})

	async function prepareSigTimes(period: bigint = 10n) {
		const now = await getBlockTimestamp()
		const cooldowns = await context.viewFacet.forceCloseCooldowns()
		const firstCooldown = cooldowns[0]
		const secondCooldown = cooldowns[1]
		const startTime = firstCooldown + now
		const endTime = firstCooldown + now + period
		await time.increase(firstCooldown + period + secondCooldown + 1n)
		return [startTime, endTime]
	}

	it("Should settle and forceClose the quote", async function () {
		const sigTimes = await prepareSigTimes(100n)
		const highLowSig = await getDummyHighLowPriceSig(
			sigTimes[0],  // startTime
			sigTimes[1],  // endTime
			0n,           // lowest
			decimal(8n),  // highest
			decimal(6n),   // currentPrice
			decimal(5n),   // averagePrice
			quote1LongOpened.symbolId, // symbolId
			decimal(150n), // upnlPartyB
			0n             // upnlPartyA
		)
		const settlementSigWithoutData = await getDummySettlementSig(0n, [150n], [])
		const settlementSig = await getDummySettlementSig(0n, [150n], [
			{
				quoteId: quote2ShortOpened.id,
				currentPrice: decimal(7n),
				partyBUpnlIndex: 0n
			} as QuoteSettlementDataStructOutput,
		])

		await expect(
			user.forceClosePosition(quote1LongOpened.id, highLowSig)
		).to.be.revertedWith("LibQuote: PartyA should first exit its positions that are incurring losses")

		await user.settleAndForceClosePosition(quote1LongOpened.id, highLowSig, settlementSig, [decimal(5n)])

		expect((await context.viewFacet.getQuote(quote1LongOpened.id)).quoteStatus).to.be.eq(QuoteStatus.CLOSED)
		expect((await context.viewFacet.getQuote(quote2ShortOpened.id)).openedPrice).to.be.eq(decimal(5n))
	})

	it("Should settle and forceClose the quote", async function () {
		const sigTimes = await prepareSigTimes(100n)
		const highLowSig = await getDummyHighLowPriceSig(
			sigTimes[0],  // startTime
			sigTimes[1],  // endTime
			0n,           // lowest
			decimal(8n),  // highest
			decimal(6n),   // currentPrice
			decimal(5n),   // averagePrice
			quote1LongOpened.symbolId, // symbolId
			decimal(150n), // upnlPartyB
			0n             // upnlPartyA
		)
		const settlementSig = await getDummySettlementSig(0n, [150n], [
			{
				quoteId: quote2ShortOpened.id,
				currentPrice: decimal(7n),
				partyBUpnlIndex: 0n
			} as QuoteSettlementDataStructOutput,
		])

		const updatePrice = decimal(5n)

		await expect(
			user.forceClosePosition(quote1LongOpened.id, highLowSig)
		).to.be.revertedWith("LibQuote: PartyA should first exit its positions that are incurring losses")

		const balanceInfoB1=await hedger.getBalanceInfo(await user.getAddress())
		
		await context.settlementFacet.connect(hedger.getSigner).settleUpnl(settlementSig,[updatePrice],await user.getAddress())
		expect((await context.viewFacet.getQuote(quote2ShortOpened.id)).openedPrice).to.be.eq(updatePrice)
		
		const balanceInfoB2 = await hedger.getBalanceInfo(await user.getAddress())

		await user.forceClosePosition(quote1LongOpened.id, highLowSig)
		expect((await context.viewFacet.getQuote(quote1LongOpened.id)).quoteStatus).to.be.eq(QuoteStatus.CLOSED)
		expect(balanceInfoB2.allocatedBalances - balanceInfoB1.allocatedBalances).to.be.equal(unDecimal((updatePrice - quote2ShortOpened.openedPrice) * quote2ShortOpened.quantity))
	})

	it.only("Should settle and forceClose the quote in master account mode", async function () {
		const sigTimes = await prepareSigTimes(100n)
		const highLowSig = await getDummyHighLowPriceSig(
			sigTimes[0],  // startTime
			sigTimes[1],  // endTime
			0n,           // lowest
			decimal(8n),  // highest
			decimal(5n),   // currentPrice
			decimal(5n),   // averagePrice
			quote1LongOpened.symbolId, // symbolId
			decimal(150n), // upnlPartyB
			0n             // upnlPartyA
		)
		let settlementSig = await getDummyCrossSettlementSig([0n], 250n,await hedger.getAddress(),[await user.getAddress()], [
			{
				quoteId: quote2ShortOpened.id,
				currentPrice: decimal(7n),
			}  as CrossQuoteSettlementDataStructOutput,
		])
		const updatePrice = decimal(5n)

		await context.controlFacet.setMasterAccountActivationMode(true)
		await context.accountFacet.connect(hedger.getSigner).activateMasterAccountMode();


		await expect(
			await context.forceActionsFacet.initializeForceClose(quote1LongOpened.id, highLowSig)
		).not.to.reverted

		await expect(
			 context.forceActionsFacet.finalizeForceClose(quote1LongOpened.id)
		).to.be.revertedWith("LibQuote: PartyA should first exit its positions that are incurring losses")

		// await hedger.setBalances(decimal(100n), decimal(100n))

		await context.accountFacet.connect(hedger.getSigner).allocateForPartyB(decimal(10n), ethers.ZeroAddress)
		const balanceInfo1B=await hedger.getBalanceInfo(await user.getAddress())
		const balanceInfoMasterB=await hedger.getBalanceInfo(ethers.ZeroAddress)
		
		
		await expect(context.settlementFacet.connect(hedger.getSigner).crossSettleUpnl(settlementSig,[updatePrice],await user.getAddress(),await hedger.getAddress(),1)).
		to.be.revertedWith("LibSettlement: PartyB should be solvent");
	
		await expect(context.settlementFacet.connect(hedger.getSigner).settleAllocated(await hedger.getAddress(),[await user.getAddress()],[balanceInfo1B.allocatedBalances])).not.to.reverted;
		const balanceInfo2B=await hedger.getBalanceInfo(await user.getAddress())
		const balanceInfoMasterAfterB=await hedger.getBalanceInfo(ethers.ZeroAddress)

		expect(balanceInfo2B.allocatedBalances).to.equal(0)
		expect(balanceInfoMasterAfterB.allocatedBalances - balanceInfoMasterB.allocatedBalances).to.equal(balanceInfo1B.allocatedBalances)

		// TODO force close ID
		await expect(context.settlementFacet.connect(hedger.getSigner).crossSettleUpnl(settlementSig,[updatePrice],await user.getAddress(),await hedger.getAddress(),1)).not.to.be.reverted
		expect((await context.viewFacet.getQuote(quote2ShortOpened.id)).openedPrice).to.be.eq(updatePrice)
		const settledAmount = unDecimal((updatePrice - quote2ShortOpened.openedPrice) * quote2ShortOpened.quantity)
		
		const balanceInfoSettlementMasterSettledB = await hedger.getBalanceInfo(ethers.ZeroAddress)
		expect(balanceInfoSettlementMasterSettledB.allocatedBalances - balanceInfoMasterAfterB.allocatedBalances).to.be.equal(settledAmount)
		

		// await user.forceClosePosition(quote1LongOpened.id, highLowSig)
		// expect((await context.viewFacet.getQuote(quote1LongOpened.id)).quoteStatus).to.be.eq(QuoteStatus.CLOSED)
	})
}
