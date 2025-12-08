import {loadFixture, time} from "@nomicfoundation/hardhat-network-helpers"

import {initializeFixture} from "./Initialize.fixture"
import {PositionType, QuoteStatus} from "./models/Enums"
import {Hedger} from "./models/Hedger"
import {RunContext} from "./models/RunContext"
import {User} from "./models/User"
import {limitCloseRequestBuilder} from "./models/requestModels/CloseRequest"
import {limitQuoteRequestBuilder} from "./models/requestModels/QuoteRequest"
import {decimal, getBlockTimestamp, getQuoteQuantity, unDecimal,} from "./utils/Common"
import {getDummyCrossSettlementSig, getDummyHighLowPriceSig, getDummySettlementSig, getDummySingleUpnlSig} from "./utils/SignatureUtils"
import { HighLowPriceSigStruct, QuoteStructOutput, SettlementSigStruct} from "../src/types/contracts/interfaces/ISymmio"
import {limitOpenRequestBuilder} from "./models/requestModels/OpenRequest"
import {QuoteSettlementDataStructOutput} from "../src/types/contracts/facets/Settlement/ISettlementFacet"
import {expect} from "chai"
import { ethers } from "hardhat"
import { exec } from "child_process"
import { partyA } from "../src/types/contracts/facets"
import { lock } from "ethers"
import { MasterAccountSettlementSigStruct } from "../src/types/contracts/facets/ForceActions/ForceActionsFacet"
import { CrossQuoteSettlementDataStructOutput } from "../src/types/contracts/facets/ForceActions/IForceActionsFacet"

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


		const quantityShort = decimal(75n)
		// Quote2 SHORT opened
		quote2ShortOpened = await context.viewFacet.getQuote(
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.positionType(PositionType.SHORT)
					.quantity(quantityShort)
					.build()
			)
		)
		await hedger.lockQuote(quote2ShortOpened.id)
		await hedger.openPosition(quote2ShortOpened.id, limitOpenRequestBuilder().filledAmount(quantityShort).build())

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

	it("Should settle and forceClose the quote balance check", async function () {
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

		const balanceInfoBBefore=await hedger.getBalanceInfo(await user.getAddress())
		
		await context.settlementFacet.connect(hedger.getSigner).settleUpnl(settlementSig,[updatePrice],await user.getAddress())
		expect((await context.viewFacet.getQuote(quote2ShortOpened.id)).openedPrice).to.be.eq(updatePrice)
		
		const balanceInfoBAfter = await hedger.getBalanceInfo(await user.getAddress())

		await user.forceClosePosition(quote1LongOpened.id, highLowSig)
		const settledUpnl = unDecimal((updatePrice - quote2ShortOpened.openedPrice) * quote2ShortOpened.quantity)
		expect((await context.viewFacet.getQuote(quote1LongOpened.id)).quoteStatus).to.be.eq(QuoteStatus.CLOSED)
		expect(balanceInfoBAfter.allocatedBalances - balanceInfoBBefore.allocatedBalances).to.be.equal(settledUpnl)
	})

	describe("Master Account", async function () {
		let sigTimes, highLowSig:HighLowPriceSigStruct, settlementSig:SettlementSigStruct, 
		settlementSigForceClose:MasterAccountSettlementSigStruct, updatePrice:bigint

		beforeEach(async function () {

			 sigTimes = await prepareSigTimes(100n)
			 highLowSig = await getDummyHighLowPriceSig(
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
			const settlementSig = await getDummySettlementSig(0n, [150n], [
				{
					quoteId: quote2ShortOpened.id,
					currentPrice: decimal(7n),
					partyBUpnlIndex: 0n
				} as QuoteSettlementDataStructOutput,
			])

			settlementSigForceClose = await getDummyCrossSettlementSig([0n], 0n, await hedger.getAddress(),[await user.getAddress()], [
				{
					quoteId: quote2ShortOpened.id,
					currentPrice: decimal(7n),
				}  as CrossQuoteSettlementDataStructOutput,
			])

			 updatePrice = decimal(7n)
	
			await context.controlFacet.setMasterAccountActivationMode(true)
			await context.accountFacet.connect(hedger.getSigner).activateMasterAccountMode();

			await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)
			
			
		})
		
		it("Should settle and forceClose the quote in master account mode", async function () {
			
			
			// await expect(
			// 	await context.forceActionsFacet.initializeMasterAccountForceClose(quote1LongOpened.id, highLowSig)
			// ).not.to.reverted
			
			// const balanceInfoMasterB=await hedger.getBalanceInfo(ethers.ZeroAddress)			
			// settlementSig = await getDummySettlementSig([0n], 100n, await hedger.getAddress(),[await user.getAddress()], [
			// 	{
			// 		quoteId: quote2ShortOpened.id,
			// 		currentPrice: decimal(7n),
			// 	}  as CrossQuoteSettlementDataStructOutput,
			// ])

			// //there is not enough balance in master account 
			// await expect(context.settlementFacet.connect(hedger.getSigner).settleUpnl(settlementSig,[updatePrice],await user.getAddress(),await hedger.getAddress(),1)).
			// to.be.revertedWith("LibSettlement: PartyB should be solvent");
			

			// // so not able to close --> still in initialize mode			
			// await expect(
			// 	 context.forceActionsFacet.finalizeMasterAccountForceClose(quote1LongOpened.id)
			// ).to.be.revertedWith("LibQuote: PartyA should first exit its positions that are incurring losses")


			// // At least 100n for upnlPartyB
			// const upnlPartyB = decimal(100n)
			// settlementSig = await getDummyCrossSettlementSig([0n], upnlPartyB, await hedger.getAddress(),[await user.getAddress()], [
			// 	{
			// 		quoteId: quote2ShortOpened.id,
			// 		currentPrice: decimal(7n),
			// 	}  as CrossQuoteSettlementDataStructOutput,
			// ])


			// // TODO force close ID
			// await expect(context.settlementFacet.connect(hedger.getSigner).settleUpnlMasterAccount(settlementSig,[updatePrice],await user.getAddress(),await hedger.getAddress(),1)).not.to.be.reverted

			
			// const settledAmount = unDecimal((updatePrice - quote2ShortOpened.openedPrice) * quote2ShortOpened.quantity)
			// const balanceInfoSettlementMasterSettledB = await hedger.getBalanceInfo(ethers.ZeroAddress)
			// expect(balanceInfoSettlementMasterSettledB.allocatedBalances - balanceInfoMasterB.allocatedBalances).to.be.equal(settledAmount)
			// expect((await context.viewFacet.getQuote(quote2ShortOpened.id)).openedPrice).to.be.eq(updatePrice)
			
			
			// const forceCloseSt = await context.viewFacet.getForceCloseStruct(quote1LongOpened.id)
			// const upnlLong = unDecimal(forceCloseSt.closePrice  * quote1LongOpened.quantity)
			// expect(balanceInfoSettlementMasterSettledB.allocatedBalances).to.be.greaterThanOrEqual(upnlLong)
			// console.log("upnlLong:\n",upnlLong)
			// console.log("balanceInfoSettlementMasterSettledB.allocatedBalances:\n",balanceInfoSettlementMasterSettledB.allocatedBalances)
			// // Done till here
	
			// // todo: is there any role!
			// await expect(
			// 	 context.forceActionsFacet.finalizeMasterAccountForceClose(quote1LongOpened.id)
			// ).not.to.be.reverted
			// // await user.forceClosePosition(quote1LongOpened.id, highLowSig)
	
			// const balanceInfoSettlementMasterForceCloseB = await hedger.getBalanceInfo(user.address)
			// const locked = balanceInfoSettlementMasterForceCloseB.lockedCva + balanceInfoSettlementMasterForceCloseB.lockedLf
			// const available =  balanceInfoSettlementMasterForceCloseB.allocatedBalances - locked
			// expect((await context.viewFacet.getQuote(quote1LongOpened.id)).quoteStatus).to.be.eq(QuoteStatus.CLOSED)
			// console.log("available:", available)
			// console.log("balanceInfoSettlementMasterForceCloseB.allocatedBalances:", balanceInfoSettlementMasterForceCloseB.allocatedBalances)
		})
	
		it("Should settle Allocated and forceClose the quote in master account mode", async function () {
	
	
			// await expect(
			// 	await context.forceActionsFacet.initializeMasterAccountForceClose(quote1LongOpened.id, highLowSig)
			// ).not.to.reverted
	
			
			// const balanceInfo1B=await hedger.getBalanceInfo(await user.getAddress())
			// const balanceInfoMasterB=await hedger.getBalanceInfo(ethers.ZeroAddress)
			
			
			// await expect(context.settlementFacet.connect(hedger.getSigner).settleUpnlMasterAccount(settlementSig,[updatePrice],await user.getAddress(),await hedger.getAddress(),1)).
			// to.be.revertedWith("LibSettlement: PartyB should be solvent");
			
					
			// await expect(
			// 	 context.forceActionsFacet.finalizeMasterAccountForceClose(quote1LongOpened.id)
			// ).to.be.revertedWith("LibQuote: PartyA should first exit its positions that are incurring losses")
			
			// // TODO force close ID
			// await expect(context.settlementFacet.connect(hedger.getSigner).settleUpnlMasterAccount(settlementSig,[updatePrice],await user.getAddress(),await hedger.getAddress(),1)).not.to.be.reverted
			// expect((await context.viewFacet.getQuote(quote2ShortOpened.id)).openedPrice).to.be.eq(updatePrice)
			// const settledAmount = unDecimal((updatePrice - quote2ShortOpened.openedPrice) * quote2ShortOpened.quantity)
			
			// const balanceInfoSettlementMasterSettledB = await hedger.getBalanceInfo(ethers.ZeroAddress)
			// expect(balanceInfoSettlementMasterSettledB.allocatedBalances - balanceInfoMasterB.allocatedBalances).to.be.equal(settledAmount)
			
			// const quoteValue = unDecimal(quote1LongOpened.quantity * ( settlementSig.quotesSettlementsData[0].currentPrice - quote1LongOpened.openedPrice ))
			// expect(balanceInfoSettlementMasterSettledB.allocatedBalances ).to.be.greaterThanOrEqual(quoteValue)
	
			// const sig = await getDummySingleUpnlSig(decimal(300n))		
			// await context.accountFacet.connect(hedger.getSigner).transferAllocation(balanceInfoSettlementMasterSettledB.allocatedBalances, ethers.ZeroAddress, await user.getAddress(),sig)
			
			// await user.forceClosePosition(quote1LongOpened.id, highLowSig)
			// expect((await context.viewFacet.getQuote(quote1LongOpened.id)).quoteStatus).to.be.eq(QuoteStatus.CLOSED)
		})
	
	})
}
