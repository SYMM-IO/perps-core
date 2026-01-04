import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { Builder } from "builder-pattern"
import { expect } from "chai"

import type {
	MasterAccountQuoteSettlementDataStructOutput,
	QuoteSettlementDataStructOutput,
} from "../src/types/facets/Settlement/ISettlementFacet.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { OrderType, PositionType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { limitOpenRequestBuilder, OpenRequest } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder, QuoteRequest } from "./models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp, unDecimal } from "./utils/Common.js"
import {
	getDummyHighLowPriceSig,
	getDummyLiquidationSig,
	getDummyMasterAccountSettlementSig,
	getDummyPairUpnlSig,
	getDummySettlementSig,
	getDummySingleUpnlAndPriceSig,
} from "./utils/SignatureUtils.js"
import { migratePartyBToMaster } from "./utils/MasterAccount.js"

export function shouldBehaveLikeSpecificScenario(): void {
	let uSigner: HardhatEthersSigner
	beforeEach(async function () {
		this.context = await loadFixture(initializeFixture)
		uSigner = await ethers.getImpersonatedSigner(ethers.Wallet.createRandom().address)
	})

	const expectPartyBTotals = async (context: RunContext, longAmount: bigint, longAvgPrice: bigint, shortAmount: bigint, shortAvgPrice: bigint) => {
		const { longPosition, shortPosition } = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbol(context.signers.hedger.address, 1)
		expect(longPosition.aggregatedOpenAmount).to.equal(longAmount)
		expect(longPosition.avgOpenPrice).to.equal(longAvgPrice)
		expect(shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
		expect(shortPosition.avgOpenPrice).to.equal(shortAvgPrice)
	}

	const expectPartyATotals = async (context: RunContext, longAmount: bigint, longAvgPrice: bigint, shortAmount: bigint, shortAvgPrice: bigint) => {
		const { longPosition, shortPosition } = await context.viewFacetQuote.getPartyAAggregatedPositionBySymbol(context.signers.user.address, 1)
		expect(longPosition.aggregatedOpenAmount).to.equal(longAmount)
		expect(longPosition.avgOpenPrice).to.equal(longAvgPrice)
		expect(shortPosition.aggregatedOpenAmount).to.equal(shortAmount)
		expect(shortPosition.avgOpenPrice).to.equal(shortAvgPrice)
	}

	const expectPartyBTotalsByPartyA = async (
		context: RunContext,
		partyA: string,
		longAmount: bigint,
		longAvgPrice: bigint,
		shortAmount: bigint,
		shortAvgPrice: bigint,
	) => {
		const assertPosition = (position: any, amount: bigint, avg: bigint) => {
			expect(position.aggregatedOpenAmount).to.equal(amount)
			expect(position.avgOpenPrice).to.equal(avg)
		}

		const { longPosition, shortPosition } = await context.viewFacetQuote.getPartyBAggregatedPositionBySymbolPerPartyA(
			context.signers.hedger.address,
			partyA,
			1,
		)
		assertPosition(longPosition, longAmount, longAvgPrice)
		assertPosition(shortPosition, shortAmount, shortAvgPrice)

		const aggregates = await context.viewFacetQuote.getPartyBAggregatedPositionPerPartyA(context.signers.hedger.address, partyA, 0, 5)
		const findAggregate = (posType: PositionType) =>
			aggregates.find((entry: any) => BigInt(entry.symbolId) === 1n && BigInt(entry.positionType) === BigInt(posType))
		const assertAggregate = (entry: any, amount: bigint, avg: bigint) => {
			if (amount === 0n) {
				if (entry) {
					expect(entry.aggregatedOpenAmount).to.equal(0n)
					expect(entry.avgOpenPrice).to.equal(0n)
				}
				return
			}
			expect(entry).to.not.equal(undefined)
			expect(entry.aggregatedOpenAmount).to.equal(amount)
			expect(entry.avgOpenPrice).to.equal(avg)
		}

		assertAggregate(findAggregate(PositionType.LONG), longAmount, longAvgPrice)
		assertAggregate(findAggregate(PositionType.SHORT), shortAmount, shortAvgPrice)
		if (longAmount === 0n && shortAmount === 0n) {
			expect(aggregates.length).to.equal(0)
		}
	}

	const avgPrice = (amount: bigint, notional: bigint) => (amount === 0n ? 0n : notional / amount)
	it("Closing position with allocated less than quote value and with positive upnl", async function () {
		const context: RunContext = this.context

		const user = new User(context, uSigner)
		await user.setup()
		await user.setNativeBalance(100n ** 18n)

		const hSigner = await ethers.getImpersonatedSigner(ethers.Wallet.createRandom().address)
		const hedger = new Hedger(context, hSigner)
		await hedger.setNativeBalance(100n ** 18n)
		await hedger.setBalances(decimal(50000n), decimal(50000n))
		await hedger.register()

		let b = decimal(5000n)
		await user.setBalances(b, b, b)

		await user.sendQuote(
			Builder<QuoteRequest>()
				.partyBWhiteList([])
				.quantity("32000000000000000")
				.partyAmm("69706470325210735106")
				.partyBmm("69706470325210735106")
				.cva("14394116573201404621")
				.lf("8104916153486468905")
				.price("22207600000000000000000")
				.upnlSig(getDummySingleUpnlAndPriceSig(BigInt("20817400000000000000000")))
				.maxFundingRate(0)
				.symbolId(1)
				.orderType(OrderType.MARKET)
				.positionType(PositionType.SHORT)
				.deadline("100000000000000000")
				.build(),
		)
		await context.symbolControlFacet.whitelistSymbolType(await hedger.getAddress(), (await context.viewFacetSymbol.getSymbolWithType(1)).symbolType)
		await hedger.lockQuote(1)
		await hedger.openPosition(
			1,
			Builder<OpenRequest>()
				.filledAmount("32000000000000000")
				.openPrice("22207600000000000000000")
				.price("20817400000000000000000")
				.upnlPartyA(0)
				.upnlPartyB(0)
				.build(),
		)
		// await user.requestToClosePosition(
		//   1,
		//   Builder<CloseRequest>()
		//     .closePrice("22944000000000000000")
		//     .orderType(OrderType.LIMIT)
		//     .quantityToClose("197200000000000000000")
		//     .deadline("1000000000000000")
		//     .upnl(0)
		//     .build(),
		// );
		// await context.accountFacet
		//   .connect(uSigner)
		//   .deallocate("4376707987620000000000", await getDummySingleUpnlSig("0"));
		// console.log(await user.getBalanceInfo());

		// await context.partyBFacet
		//   .connect(hSigner)
		//   .deallocateForPartyB(
		//     "4746758351632000000000",
		//     await user.getAddress(),
		//     await getDummySingleUpnlSig("531317547460000000000"),
		//   );
		// console.log(await hedger.getBalanceInfo(await user.getAddress()));
		// await hedger.fillCloseRequest(
		//   1,
		//   Builder<FillCloseRequest>()
		//     .filledAmount("197200000000000000000")
		//     .closedPrice("22919000000000000000")
		//     .upnlPartyA("-513272021960000000000")
		//     .upnlPartyB("513277955708000000000")
		//     .price("22885951200000000000")
		//     .build(),
		// );
	})

	it("Tracks partyB totals across a multi-party, multi-action flow", async function () {
		const context: RunContext = this.context

		const user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(10000n), decimal(10000n), decimal(5000n))

		const user2 = new User(context, context.signers.user2)
		await user2.setup()
		await user2.setBalances(decimal(10000n), decimal(10000n), decimal(5000n))

		const hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(10000n), decimal(10000n))

		const userAddress = await user.getAddress()
		const user2Address = await user2.getAddress()

		const amount1 = decimal(10n)
		const price1 = decimal(10n)
		const amount2 = decimal(5n)
		const price2 = decimal(11n)
		const amount3 = decimal(50n)
		const price3 = decimal(20n)
		const amount4 = decimal(20n)
		const price4 = decimal(21n)
		const amount5 = decimal(30n)
		const price5 = decimal(8n)

		const quote1 = await context.viewFacetQuote.getQuote(
			await user.sendQuote(
				limitQuoteRequestBuilder().positionType(PositionType.LONG).price(price1).quantity(amount1).deadline(getBlockTimestamp(10000n)).build(),
			),
		)
		const quote2 = await context.viewFacetQuote.getQuote(
			await user2.sendQuote(
				limitQuoteRequestBuilder().positionType(PositionType.LONG).price(price2).quantity(amount2).deadline(getBlockTimestamp(10000n)).build(),
			),
		)
		const quote3 = await context.viewFacetQuote.getQuote(
			await user2.sendQuote(
				limitQuoteRequestBuilder().positionType(PositionType.SHORT).price(price3).quantity(amount3).deadline(getBlockTimestamp(10000n)).build(),
			),
		)
		const quote4 = await context.viewFacetQuote.getQuote(
			await user.sendQuote(
				limitQuoteRequestBuilder().positionType(PositionType.SHORT).price(price4).quantity(amount4).deadline(getBlockTimestamp(10000n)).build(),
			),
		)
		const quote5 = await context.viewFacetQuote.getQuote(
			await user2.sendQuote(
				limitQuoteRequestBuilder().positionType(PositionType.LONG).price(price5).quantity(amount5).deadline(getBlockTimestamp(10000n)).build(),
			),
		)

		await expectPartyBTotals(context, 0n, 0n, 0n, 0n)

		await hedger.lockQuote(quote1.id)
		await hedger.lockQuote(quote2.id)
		await hedger.lockQuote(quote3.id)
		await hedger.lockQuote(quote4.id)
		await hedger.lockQuote(quote5.id)

		await expectPartyBTotals(context, 0n, 0n, 0n, 0n)

		await hedger.openPosition(quote1.id, limitOpenRequestBuilder().filledAmount(amount1).openPrice(price1).price(price1).build())
		await expectPartyBTotals(context, decimal(10n), decimal(10n), 0n, 0n)
		expect((await context.viewFacetQuote.getQuote(quote1.id)).quoteStatus).to.equal(BigInt(QuoteStatus.OPENED))

		await hedger.openPosition(quote2.id, limitOpenRequestBuilder().filledAmount(amount2).openPrice(price2).price(price2).build())
		await expectPartyBTotals(context, decimal(15n), 10_333_333_333_333_333_333n, 0n, 0n)

		await hedger.openPosition(quote3.id, limitOpenRequestBuilder().filledAmount(amount3).openPrice(price3).price(price3).build())
		await expectPartyBTotals(context, decimal(15n), 10_333_333_333_333_333_333n, decimal(50n), decimal(20n))

		await hedger.openPosition(quote4.id, limitOpenRequestBuilder().filledAmount(amount4).openPrice(price4).price(price4).build())
		await expectPartyBTotals(context, decimal(15n), 10_333_333_333_333_333_333n, decimal(70n), 20_285_714_285_714_285_714n)

		await hedger.openPosition(quote5.id, limitOpenRequestBuilder().filledAmount(amount5).openPrice(price5).price(price5).build())
		await expectPartyBTotals(context, decimal(45n), 8_777_777_777_777_777_777n, decimal(70n), 20_285_714_285_714_285_714n)

		const user2LongAmountAfterOpen = amount2 + amount5
		const user2LongAvgAfterOpen = avgPrice(user2LongAmountAfterOpen, amount2 * price2 + amount5 * price5)
		await expectPartyBTotalsByPartyA(context, userAddress, amount1, price1, amount4, price4)
		await expectPartyBTotalsByPartyA(context, user2Address, user2LongAmountAfterOpen, user2LongAvgAfterOpen, amount3, price3)

		const close5Amount = decimal(20n)
		const close5Price = decimal(15n)
		await user2.requestToClosePosition(
			quote5.id,
			limitCloseRequestBuilder().quantityToClose(close5Amount).closePrice(close5Price).deadline(getBlockTimestamp(10000n)).build(),
		)
		await expectPartyBTotals(context, decimal(45n), 8_777_777_777_777_777_777n, decimal(70n), 20_285_714_285_714_285_714n)

		await hedger.fillCloseRequest(
			quote5.id,
			limitFillCloseRequestBuilder().filledAmount(close5Amount).closedPrice(close5Price).price(close5Price).build(),
		)
		await expectPartyBTotals(context, decimal(25n), 9_400_000_000_000_000_000n, decimal(70n), 20_285_714_285_714_285_714n)

		const user2LongAmountAfterClose5 = amount2 + (amount5 - close5Amount)
		const user2LongAvgAfterClose5 = avgPrice(user2LongAmountAfterClose5, amount2 * price2 + (amount5 - close5Amount) * price5)
		await expectPartyBTotalsByPartyA(context, userAddress, amount1, price1, amount4, price4)
		await expectPartyBTotalsByPartyA(context, user2Address, user2LongAmountAfterClose5, user2LongAvgAfterClose5, amount3, price3)

		const close4Amount = amount4
		const close4Price = decimal(15n)
		await user.requestToClosePosition(
			quote4.id,
			limitCloseRequestBuilder().quantityToClose(close4Amount).closePrice(close4Price).deadline(getBlockTimestamp(10000n)).build(),
		)
		await expectPartyBTotals(context, decimal(25n), 9_400_000_000_000_000_000n, decimal(70n), 20_285_714_285_714_285_714n)

		await hedger.fillCloseRequest(
			quote4.id,
			limitFillCloseRequestBuilder().filledAmount(close4Amount).closedPrice(close4Price).price(close4Price).build(),
		)
		await expectPartyBTotals(context, decimal(25n), 9_400_000_000_000_000_000n, decimal(50n), decimal(20n))
		expect((await context.viewFacetQuote.getQuote(quote4.id)).quoteStatus).to.equal(BigInt(QuoteStatus.CLOSED))

		await expectPartyBTotalsByPartyA(context, userAddress, amount1, price1, 0n, 0n)
		await expectPartyBTotalsByPartyA(context, user2Address, user2LongAmountAfterClose5, user2LongAvgAfterClose5, amount3, price3)

		const close2Price = decimal(12n)
		await user2.requestToClosePosition(
			quote2.id,
			limitCloseRequestBuilder().quantityToClose(amount2).closePrice(close2Price).deadline(getBlockTimestamp(10000n)).build(),
		)
		await expectPartyBTotals(context, decimal(25n), 9_400_000_000_000_000_000n, decimal(50n), decimal(20n))

		const now = await getBlockTimestamp()
		const cooldowns = await context.viewFacet.forceCloseCooldowns()
		const firstCooldown = cooldowns[0]
		const secondCooldown = cooldowns[1]
		const sigStart = firstCooldown + now
		const sigEnd = firstCooldown + now + 10n
		await time.increase(firstCooldown + 10n + secondCooldown + 1n)

		const forceCloseSig = await getDummyHighLowPriceSig(sigStart, sigEnd, decimal(10n), decimal(14n), close2Price, decimal(11n), 1n, 0n, 0n)
		await user2.forceClosePosition(quote2.id, forceCloseSig)
		await expectPartyBTotals(context, decimal(20n), decimal(9n), decimal(50n), decimal(20n))
		expect((await context.viewFacetQuote.getQuote(quote2.id)).quoteStatus).to.equal(BigInt(QuoteStatus.CLOSED))

		const user2LongAmountAfterForceClose = amount5 - close5Amount
		await expectPartyBTotalsByPartyA(context, userAddress, amount1, price1, 0n, 0n)
		await expectPartyBTotalsByPartyA(context, user2Address, user2LongAmountAfterForceClose, price5, amount3, price3)

		const updatedShortPrice = decimal(15n)
		const settlementEntry = Object.assign([quote3.id, updatedShortPrice, 0n], {
			quoteId: quote3.id,
			currentPrice: updatedShortPrice,
			partyBUpnlIndex: 0n,
		}) as QuoteSettlementDataStructOutput
		const settlementSig = await getDummySettlementSig(0n, [0n], [settlementEntry])
		await hedger.settleUpnl(user2.address, [updatedShortPrice], settlementSig)

		await expectPartyBTotals(context, decimal(20n), decimal(9n), decimal(50n), decimal(15n))

		await expectPartyBTotalsByPartyA(context, userAddress, amount1, price1, 0n, 0n)
		await expectPartyBTotalsByPartyA(context, user2Address, user2LongAmountAfterForceClose, price5, amount3, updatedShortPrice)

		const liquidator = context.signers.liquidator
		const liquidationSig = await getDummyLiquidationSig("0x10", -decimal(1_000_000n), [1n], [decimal(3n)], decimal(1_000_000n), 0n)
		await context.liquidationFacet.connect(liquidator).liquidatePartyA(user.address, liquidationSig)
		await context.liquidationFacet.connect(liquidator).setSymbolsPrice(user.address, liquidationSig)
		await context.liquidationFacet.connect(liquidator).liquidatePendingPositionsPartyA(user.address)
		await context.liquidationFacet.connect(liquidator).liquidatePositionsPartyA(user.address, [quote1.id])

		await expectPartyBTotals(context, decimal(10n), decimal(8n), decimal(50n), decimal(15n))
		expect((await context.viewFacetQuote.getQuote(quote1.id)).quoteStatus).to.equal(BigInt(QuoteStatus.LIQUIDATED))

		await expectPartyBTotalsByPartyA(context, userAddress, 0n, 0n, 0n, 0n)
		await expectPartyBTotalsByPartyA(context, user2Address, user2LongAmountAfterForceClose, price5, amount3, updatedShortPrice)
	})

	it("Updates partyB notionals after master-account settlement", async function () {
		const context: RunContext = this.context

		const user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(10000n), decimal(10000n), decimal(5000n))

		const user2 = new User(context, context.signers.user2)
		await user2.setup()
		await user2.setBalances(decimal(10000n), decimal(10000n), decimal(5000n))

		const hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(10000n), decimal(10000n))

		const amount1 = decimal(10n)
		const price1 = decimal(10n)
		const amount2 = decimal(20n)
		const price2 = decimal(12n)

		const userAddress = await user.getAddress()
		const user2Address = await user2.getAddress()

		const quote1 = await context.viewFacetQuote.getQuote(
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.positionType(PositionType.LONG)
					.price(price1)
					.quantity(amount1)
					.deadline(getBlockTimestamp(10000n))
					.build(),
			),
		)
		const quote2 = await context.viewFacetQuote.getQuote(
			await user2.sendQuote(
				limitQuoteRequestBuilder()
					.positionType(PositionType.LONG)
					.price(price2)
					.quantity(amount2)
					.deadline(getBlockTimestamp(10000n))
					.build(),
			),
		)

		await hedger.lockQuote(quote1.id)
		await hedger.lockQuote(quote2.id)

		await hedger.openPosition(quote1.id, limitOpenRequestBuilder().filledAmount(amount1).openPrice(price1).price(price1).build())
		await hedger.openPosition(quote2.id, limitOpenRequestBuilder().filledAmount(amount2).openPrice(price2).price(price2).build())

		await migratePartyBToMaster(context, hedger, [quote1.id, quote2.id])

		const totalAmount = amount1 + amount2
		const avgBefore = avgPrice(totalAmount, amount1 * price1 + amount2 * price2)
		await expectPartyBTotals(context, totalAmount, avgBefore, 0n, 0n)

		await user.requestToClosePosition(
			quote1.id,
			limitCloseRequestBuilder().quantityToClose(amount1).closePrice(decimal(11n)).deadline(getBlockTimestamp(10000n)).build(),
		)

		const now = await getBlockTimestamp()
		const cooldowns = await context.viewFacet.forceCloseCooldowns()
		const firstCooldown = cooldowns[0]
		const secondCooldown = cooldowns[1]
		const sigStart = firstCooldown + now
		const sigEnd = firstCooldown + now + 10n
		await time.increase(firstCooldown + 10n + secondCooldown + 1n)

		const highLowSig = await getDummyHighLowPriceSig(
			sigStart,
			sigEnd,
			decimal(9n),
			decimal(15n),
			decimal(13n),
			decimal(12n),
			quote1.symbolId,
			0n,
			0n,
		)
		await context.forceActionsMasterAccountFacet.initializeMasterAccountForceClose(quote1.id, highLowSig)

		const currentPrice = decimal(14n)
		const updatedPrice = decimal(13n)
		const settlementEntry = Object.assign([quote2.id, currentPrice], {
			quoteId: quote2.id,
			currentPrice: currentPrice,
		}) as MasterAccountQuoteSettlementDataStructOutput
		const settlementSig = await getDummyMasterAccountSettlementSig(
			[settlementEntry],
			await hedger.getAddress(),
			0n,
			[user2Address],
			[0n],
		)

		await context.forceActionsMasterAccountFacet.settleUpnlMasterAccount(quote1.id, settlementSig, [updatedPrice])

		const avgAfter = avgPrice(totalAmount, amount1 * price1 + amount2 * updatedPrice)
		await expectPartyBTotals(context, totalAmount, avgAfter, 0n, 0n)
		await expectPartyBTotalsByPartyA(context, userAddress, amount1, price1, 0n, 0n)
		await expectPartyBTotalsByPartyA(context, user2Address, amount2, updatedPrice, 0n, 0n)
	})

	it("Tracks partyB totals across funding epoch charge (iterative method)", async function () {
		const context: RunContext = this.context

		const user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(10000n), decimal(10000n), decimal(5000n))

		const hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(10000n), decimal(10000n))

		const amount = decimal(10n)
		const price = decimal(10n)

		const quoteId = await user.sendQuote(
			limitQuoteRequestBuilder().positionType(PositionType.LONG).price(price).quantity(amount).deadline(getBlockTimestamp(10000n)).build(),
		)
		await expectPartyBTotals(context, 0n, 0n, 0n, 0n)

		await hedger.lockQuote(quoteId)
		await expectPartyBTotals(context, 0n, 0n, 0n, 0n)

		await hedger.openPosition(quoteId, limitOpenRequestBuilder().filledAmount(amount).openPrice(price).price(price).build())
		await expectPartyBTotals(context, amount, price, 0n, 0n)

		const symbol = await context.viewFacetSymbol.getSymbol(1)
		const duration = symbol.fundingRateEpochDuration
		const window = symbol.fundingRateWindowTime
		const currentEpoch = (BigInt(await time.latest()) / duration) * duration
		const targetTime = currentEpoch + duration * 2n + window - 1n

		const rate = decimal(1n, 16)
		await time.setNextBlockTimestamp(targetTime)
		await hedger.chargeFundingRate(await user.getAddress(), [quoteId], [rate], await getDummyPairUpnlSig())

		await expectPartyBTotals(context, amount, decimal(101n, 17), 0n, 0n)
	})

	it("Tracks partyB totals across accumulated funding charge (new method)", async function () {
		const context: RunContext = this.context

		const user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(10000n), decimal(10000n), decimal(5000n))

		const hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(10000n), decimal(10000n))

		const amount = decimal(10n)
		const price = decimal(10n)

		const quoteId = await user.sendQuote(
			limitQuoteRequestBuilder().positionType(PositionType.LONG).price(price).quantity(amount).deadline(getBlockTimestamp(10000n)).build(),
		)
		await expectPartyBTotals(context, 0n, 0n, 0n, 0n)

		await hedger.lockQuote(quoteId)
		await expectPartyBTotals(context, 0n, 0n, 0n, 0n)

		await hedger.openPosition(quoteId, limitOpenRequestBuilder().filledAmount(amount).openPrice(price).price(price).build())
		await expectPartyBTotals(context, amount, price, 0n, 0n)

		await context.pauseControlFacet.connect(context.signers.admin).enableNewFundingFee()
		await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [3600])
		await context.fundingRateFacet
			.connect(context.signers.hedger)
			.updateAccumulatedFundingFee([1], [decimal(1n, 16)], [-decimal(1n, 16)], [decimal(1n)])

		await time.increase(3600)

		await context.fundingRateFacet
			.connect(context.signers.hedger)
			.chargeAccumulatedFundingFee(await user.getAddress(), await hedger.getAddress(), [quoteId], await getDummyPairUpnlSig())

		await expectPartyBTotals(context, decimal(10n), decimal(10n), 0n, 0n)
	})

	it("Tracks PartyA totals across a multi-party, multi-action flow", async function () {
		const context: RunContext = this.context

		const user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(10000n), decimal(10000n), decimal(5000n))

		const hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(10000n), decimal(10000n))

		const hedger2 = new Hedger(context, context.signers.hedger)
		await hedger2.setup()
		await hedger2.setBalances(decimal(10000n), decimal(10000n))

		const amount1 = decimal(10n)
		const price1 = decimal(10n)
		const amount2 = decimal(5n)
		const price2 = decimal(11n)
		const amount3 = decimal(50n)
		const price3 = decimal(20n)
		const amount4 = decimal(20n)
		const price4 = decimal(21n)
		const amount5 = decimal(30n)
		const price5 = decimal(8n)

		const quote1 = await context.viewFacetQuote.getQuote(
			await user.sendQuote(
				limitQuoteRequestBuilder().positionType(PositionType.LONG).price(price1).quantity(amount1).deadline(getBlockTimestamp(10000n)).build(),
			),
		)
		const quote2 = await context.viewFacetQuote.getQuote(
			await user.sendQuote(
				limitQuoteRequestBuilder().positionType(PositionType.LONG).price(price2).quantity(amount2).deadline(getBlockTimestamp(10000n)).build(),
			),
		)
		const quote3 = await context.viewFacetQuote.getQuote(
			await user.sendQuote(
				limitQuoteRequestBuilder().positionType(PositionType.SHORT).price(price3).quantity(amount3).deadline(getBlockTimestamp(10000n)).build(),
			),
		)
		const quote4 = await context.viewFacetQuote.getQuote(
			await user.sendQuote(
				limitQuoteRequestBuilder().positionType(PositionType.SHORT).price(price4).quantity(amount4).deadline(getBlockTimestamp(10000n)).build(),
			),
		)
		const quote5 = await context.viewFacetQuote.getQuote(
			await user.sendQuote(
				limitQuoteRequestBuilder().positionType(PositionType.LONG).price(price5).quantity(amount5).deadline(getBlockTimestamp(10000n)).build(),
			),
		)

		await expectPartyATotals(context, 0n, 0n, 0n, 0n)

		await hedger.lockQuote(quote1.id)
		await hedger2.lockQuote(quote2.id)
		await hedger.lockQuote(quote3.id)
		await hedger.lockQuote(quote4.id)
		await hedger2.lockQuote(quote5.id)

		await expectPartyATotals(context, 0n, 0n, 0n, 0n)

		await hedger.openPosition(quote1.id, limitOpenRequestBuilder().filledAmount(amount1).openPrice(price1).price(price1).build())
		await expectPartyATotals(context, decimal(10n), decimal(10n), 0n, 0n)
		expect((await context.viewFacetQuote.getQuote(quote1.id)).quoteStatus).to.equal(BigInt(QuoteStatus.OPENED))

		await hedger2.openPosition(quote2.id, limitOpenRequestBuilder().filledAmount(amount2).openPrice(price2).price(price2).build())
		await expectPartyATotals(context, decimal(15n), 10_333_333_333_333_333_333n, 0n, 0n)

		await hedger.openPosition(quote3.id, limitOpenRequestBuilder().filledAmount(amount3).openPrice(price3).price(price3).build())
		await expectPartyATotals(context, decimal(15n), 10_333_333_333_333_333_333n, decimal(50n), decimal(20n))

		await hedger.openPosition(quote4.id, limitOpenRequestBuilder().filledAmount(amount4).openPrice(price4).price(price4).build())
		await expectPartyATotals(context, decimal(15n), 10_333_333_333_333_333_333n, decimal(70n), 20_285_714_285_714_285_714n)

		await hedger2.openPosition(quote5.id, limitOpenRequestBuilder().filledAmount(amount5).openPrice(price5).price(price5).build())
		await expectPartyATotals(context, decimal(45n), 8_777_777_777_777_777_777n, decimal(70n), 20_285_714_285_714_285_714n)

		const close5Amount = decimal(20n)
		const close5Price = decimal(15n)
		await user.requestToClosePosition(
			quote5.id,
			limitCloseRequestBuilder().quantityToClose(close5Amount).closePrice(close5Price).deadline(getBlockTimestamp(10000n)).build(),
		)
		await expectPartyATotals(context, decimal(45n), 8_777_777_777_777_777_777n, decimal(70n), 20_285_714_285_714_285_714n)

		await hedger2.fillCloseRequest(
			quote5.id,
			limitFillCloseRequestBuilder().filledAmount(close5Amount).closedPrice(close5Price).price(close5Price).build(),
		)
		await expectPartyATotals(context, decimal(25n), 9_400_000_000_000_000_000n, decimal(70n), 20_285_714_285_714_285_714n)

		const close4Amount = amount4
		const close4Price = decimal(15n)
		await user.requestToClosePosition(
			quote4.id,
			limitCloseRequestBuilder().quantityToClose(close4Amount).closePrice(close4Price).deadline(getBlockTimestamp(10000n)).build(),
		)
		await expectPartyATotals(context, decimal(25n), 9_400_000_000_000_000_000n, decimal(70n), 20_285_714_285_714_285_714n)

		await hedger.fillCloseRequest(
			quote4.id,
			limitFillCloseRequestBuilder().filledAmount(close4Amount).closedPrice(close4Price).price(close4Price).build(),
		)
		await expectPartyATotals(context, decimal(25n), 9_400_000_000_000_000_000n, decimal(50n), decimal(20n))
		expect((await context.viewFacetQuote.getQuote(quote4.id)).quoteStatus).to.equal(BigInt(QuoteStatus.CLOSED))

		const close2Price = decimal(12n)
		await user.requestToClosePosition(
			quote2.id,
			limitCloseRequestBuilder().quantityToClose(amount2).closePrice(close2Price).deadline(getBlockTimestamp(10000n)).build(),
		)
		await expectPartyATotals(context, decimal(25n), 9_400_000_000_000_000_000n, decimal(50n), decimal(20n))

		const now = await getBlockTimestamp()
		const cooldowns = await context.viewFacet.forceCloseCooldowns()
		const firstCooldown = cooldowns[0]
		const secondCooldown = cooldowns[1]
		const sigStart = firstCooldown + now
		const sigEnd = firstCooldown + now + 10n
		await time.increase(firstCooldown + 10n + secondCooldown + 1n)

		const forceCloseSig = await getDummyHighLowPriceSig(sigStart, sigEnd, decimal(10n), decimal(14n), close2Price, decimal(11n), 1n, 0n, 0n)
		await user.forceClosePosition(quote2.id, forceCloseSig)
		await expectPartyATotals(context, decimal(20n), decimal(9n), decimal(50n), decimal(20n))
		expect((await context.viewFacetQuote.getQuote(quote2.id)).quoteStatus).to.equal(BigInt(QuoteStatus.CLOSED))

		const updatedShortPrice = decimal(15n)
		const settlementEntry = Object.assign([quote3.id, updatedShortPrice, 0n], {
			quoteId: quote3.id,
			currentPrice: updatedShortPrice,
			partyBUpnlIndex: 0n,
		}) as QuoteSettlementDataStructOutput
		const settlementSig = await getDummySettlementSig(0n, [0n], [settlementEntry])
		await hedger.settleUpnl(user.address, [updatedShortPrice], settlementSig)

		await expectPartyATotals(context, decimal(20n), decimal(9n), decimal(50n), decimal(15n))

		const liquidator = context.signers.liquidator
		const liquidationSig = await getDummyLiquidationSig("0x10", -decimal(1_000_000n), [1n], [decimal(3n)], decimal(1_000_000n), 0n)
		await context.liquidationFacet.connect(liquidator).liquidatePartyA(user.address, liquidationSig)
		await context.liquidationFacet.connect(liquidator).setSymbolsPrice(user.address, liquidationSig)
		await context.liquidationFacet.connect(liquidator).liquidatePendingPositionsPartyA(user.address)
		await context.liquidationFacet.connect(liquidator).liquidatePositionsPartyA(user.address, [quote1.id])

		await expectPartyATotals(context, decimal(10n), decimal(8n), decimal(50n), decimal(15n))
		expect((await context.viewFacetQuote.getQuote(quote1.id)).quoteStatus).to.equal(BigInt(QuoteStatus.LIQUIDATED))
	})
}
