import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai"

import { initializeFixture } from "./Initialize.fixture"
import { LiquidationType, OrderType, PositionType, QuoteStatus } from "./models/Enums"
import { Hedger } from "./models/Hedger"
import { RunContext } from "./models/RunContext"
import { BalanceInfo, User } from "./models/User"
import {
	decimal,
	getBlockTimestamp,
	getPriceFetcher,
	getTotalLockedValuesForQuoteIds,
	getTradingFeeForQuotes,
	unDecimal,
} from "./utils/Common";
import { getDummyLiquidationSig, getDummySingleUpnlSig } from "./utils/SignatureUtils"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest"
import { ethers, toUtf8Bytes } from "ethers"
import { QuoteStruct } from "../src/types/contracts/interfaces/ISymmio"
import { increase } from "@nomicfoundation/hardhat-network-helpers/dist/src/helpers/time";

export function shouldBehaveLikeLiquidationFacet(): void {
	let context: RunContext, user: User, user2: User, liquidator: User, hedger: Hedger, hedger2: Hedger
	const getFundingFee = async () => await context.viewFacetSymbol.getSumAccumulatedFundingFees([1])

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(2000n), decimal(1000n), decimal(500n))

		user2 = new User(context, context.signers.user2)
		await user2.setup()
		await user2.setBalances(decimal(2000n), decimal(1000n), decimal(500n))

		liquidator = new User(context, context.signers.liquidator)
		await liquidator.setup()

		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(2000n), decimal(1000n))

		hedger2 = new Hedger(context, context.signers.hedger2)
		await hedger2.setup()
		await hedger2.setBalances(decimal(2000n), decimal(1000n))


		await context.pauseControlFacet.enableNewFundingFee()
		await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [500])
		await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee([1], [decimal(2n, 16)], [decimal(1n, 16)], [decimal(1n)])


		// Quote1 -> opened
		await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
		await hedger.lockQuote(1)
		await hedger.openPosition(1)

		// Quote2 -> locked
		await user.sendQuote()
		await hedger.lockQuote(2)

		// Quote3 -> sent
		await user.sendQuote()

		// Quote4 -> user2 -> opened
		await user2.sendQuote()
		await hedger.lockQuote(4)
		await hedger.openPosition(4)

		// Quote5 -> locked
		await user.sendQuote()
		await hedger.lockQuote(5)

		await increase(550)
		await context.controlFacet.setMuonConfig(1000n , 1000n)

	})

	const expectConnected = async (partyA: string, partyB: string, expected: boolean) => {
		const isConn = await context.viewFacetSymbol.isConnectedPartyB(partyA, partyB)
		expect(isConn).to.equal(expected)
		const conns = await context.viewFacetSymbol.getConnectedPartyBs(partyA)
		if (expected) expect(conns).to.include(partyB)
		else expect(conns).to.not.include(partyB)
	}

	describe("Liquidate PartyA", async function () {
		it("Should fail on partyA being solvent", async function () {
			await expect(
				context.liquidationFacet.liquidatePartyA(
					context.signers.user.getAddress(),
					await getDummyLiquidationSig("0x10", 0n, [], [], 0n, (await user.getBalanceInfo()).allocatedBalances),
				),
			).to.be.revertedWith("LiquidationFacet: PartyA is solvent")
		})

		it("Should fail on partyA being solvent deferred", async function () {
			await expect(
				context.liquidationFacet.deferredLiquidatePartyA(
					context.signers.user.getAddress(),
					await getDummyLiquidationSig("0x10", 0n, [], [], 0n, (await user.getBalanceInfo()).allocatedBalances),
				),
			).to.be.revertedWith("LiquidationFacet: PartyA is solvent")
		})

		it("Should liquidate pending quotes", async function () {
			await user.liquidateAndSetSymbolPrices([1n], [decimal(8n)] , [1n])
			await user.liquidatePendingPositions()

			expect((await context.viewFacetQuote.getQuote(2)).quoteStatus).to.be.equal(QuoteStatus.LIQUIDATED_PENDING)
			expect((await context.viewFacetQuote.getQuote(3)).quoteStatus).to.be.equal(QuoteStatus.LIQUIDATED_PENDING)

			let balanceInfoOfPartyA: BalanceInfo = await user.getBalanceInfo()
			expect(balanceInfoOfPartyA.allocatedBalances).to.be.equal(decimal(500n) - (await getTradingFeeForQuotes(context, [1n, 2n, 3n, 4n])))
			expect(balanceInfoOfPartyA.totalLockedPartyA).to.be.equal(await getTotalLockedValuesForQuoteIds(context, [1n]))
			expect(balanceInfoOfPartyA.pendingLockedCva).to.be.equal("0")
			expect(balanceInfoOfPartyA.pendingLockedMmPartyA).to.be.equal("0")
			expect(balanceInfoOfPartyA.pendingLockedLf).to.be.equal("0")
			expect(balanceInfoOfPartyA.totalPendingLockedPartyA).to.be.equal("0")

			let balanceInfoOfPartyB: BalanceInfo = await hedger.getBalanceInfo(await user.getAddress())
			expect(balanceInfoOfPartyB.allocatedBalances).to.be.equal(decimal(360n).toString())
			expect(balanceInfoOfPartyB.lockedCva).to.be.equal(decimal(22n).toString())
			expect(balanceInfoOfPartyB.lockedMmPartyB).to.be.equal(decimal(40n).toString())
			expect(balanceInfoOfPartyB.lockedLf).to.be.equal(decimal(3n).toString())
			expect(balanceInfoOfPartyB.totalLockedPartyB).to.be.equal(decimal(65n).toString())
			expect(balanceInfoOfPartyB.pendingLockedCva).to.be.equal("0")
			expect(balanceInfoOfPartyB.pendingLockedMmPartyB).to.be.equal("0")
			expect(balanceInfoOfPartyB.pendingLockedLf).to.be.equal("0")
			expect(balanceInfoOfPartyB.totalPendingLockedPartyB).to.be.equal("0")
		})

		it("Should deferred liquidate pending quotes", async function () {
			await user.deferredLiquidateAndSetSymbolPrices([1n], [decimal(8n)],[1n])
			await user.liquidatePendingPositions()

			expect((await context.viewFacetQuote.getQuote(2)).quoteStatus).to.be.equal(QuoteStatus.LIQUIDATED_PENDING)
			expect((await context.viewFacetQuote.getQuote(3)).quoteStatus).to.be.equal(QuoteStatus.LIQUIDATED_PENDING)

			let balanceInfoOfPartyA: BalanceInfo = await user.getBalanceInfo()
			expect(balanceInfoOfPartyA.allocatedBalances).to.be.equal(decimal(500n) - (await getTradingFeeForQuotes(context, [1n, 2n, 3n, 4n])))
			expect(balanceInfoOfPartyA.totalLockedPartyA).to.be.equal(await getTotalLockedValuesForQuoteIds(context, [1n]))
			expect(balanceInfoOfPartyA.pendingLockedCva).to.be.equal("0")
			expect(balanceInfoOfPartyA.pendingLockedMmPartyA).to.be.equal("0")
			expect(balanceInfoOfPartyA.pendingLockedLf).to.be.equal("0")
			expect(balanceInfoOfPartyA.totalPendingLockedPartyA).to.be.equal("0")

			let balanceInfoOfPartyB: BalanceInfo = await hedger.getBalanceInfo(await user.getAddress())
			expect(balanceInfoOfPartyB.allocatedBalances).to.be.equal(decimal(360n).toString())
			expect(balanceInfoOfPartyB.lockedCva).to.be.equal(decimal(22n).toString())
			expect(balanceInfoOfPartyB.lockedMmPartyB).to.be.equal(decimal(40n).toString())
			expect(balanceInfoOfPartyB.lockedLf).to.be.equal(decimal(3n).toString())
			expect(balanceInfoOfPartyB.totalLockedPartyB).to.be.equal(decimal(65n).toString())
			expect(balanceInfoOfPartyB.pendingLockedCva).to.be.equal("0")
			expect(balanceInfoOfPartyB.pendingLockedMmPartyB).to.be.equal("0")
			expect(balanceInfoOfPartyB.pendingLockedLf).to.be.equal("0")
			expect(balanceInfoOfPartyB.totalPendingLockedPartyB).to.be.equal("0")
		})

		it("Should fail to liquidate a user twice", async function () {
			await user.liquidateAndSetSymbolPrices([1n], [decimal(8n)],[1n])
			await expect(user.liquidateAndSetSymbolPrices([1n], [decimal(8n)],[1n])).to.be.revertedWith("Accessibility: PartyA isn't solvent")
		})

		it("Should fail to deferred liquidate a user twice", async function () {
			await user.deferredLiquidateAndSetSymbolPrices([1n], [decimal(8n)],[1n])
			await expect(user.deferredLiquidateAndSetSymbolPrices([1n], [decimal(8n)],[1n])).to.be.revertedWith("Accessibility: PartyA isn't solvent")
		})

		it("Should change the insurance vault correctly", async function () {
			await context.controlFacet.connect(context.signers.admin).setLiquidationInsuranceVaultParams(context.signers.others[0].address, decimal(1n))
			const fundingFee = await getFundingFee()
			const price = decimal(572n, 16)
			await user.liquidateAndSetSymbolPrices([1n], [price],[1n])
			const liquidationState = await user.getLiquidatedStateOfPartyA()
			expect(await context.viewFacet.balanceOf(context.signers.others[0].address)).to.be.equal(decimal(1n) - fundingFee)
			await expectConnected(user.address, hedger.address, true)
			expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.NORMAL)

		})

		// We have a Long Limit Position for User2 at index 4
		// Tweak the price to get different UPNL in order to make the position liquid
		// lower the price to make the party A position in near liquidation risk
		// The Quote Price is 1**18, we set it to 25**16,
		// as we have CVA = 22, LF = 3, ==> Balance = 22 + 3 - 25 = 0 not liquidated yet
		// The Price below 25 makes the position liquidated
		it("Should change the insurance vault correctly in Normal Liquidation", async function () {
			await context.controlFacet.connect(context.signers.admin).setLiquidationInsuranceVaultParams(context.signers.others[0].address, decimal(1n))

			// Deallocate 399n so that it has 100n as allocated balance
			await context.accountFacet.connect(user2.getSigner).deallocate(decimal(399n), await getDummySingleUpnlSig())
			const allocated = await context.viewFacet.allocatedBalanceOfPartyA(user2.address)
			const allocatedBalance = (await user2.getBalanceInfo()).allocatedBalances
			const quote = await context.viewFacetQuote.getQuote(4)

			let price = decimal(25n, 16)

			let upnlTS = await user2.getUpnl(getPriceFetcher([1n], [price]))
			let totalUnrealizedLoss = await user2.getTotalUnrealisedLoss(getPriceFetcher([1n], [price]))
			let sign = await getDummyLiquidationSig("0x10", upnlTS, [1n], [price], totalUnrealizedLoss, allocatedBalance)
			let lf = quote.lockedValues.lf
			let cva = quote.lockedValues.cva

			// AllocatedBalance:100, LF: 3,  CVA: 22, Quantity:100, Price:1**18, Trading Fee:1**16
			// With the price Low enough, 24**16, we get UPNL of -76, this makes the Available Balance after calculations, to be ' -1 ',
			// ready to Liquidate the position in Normal
			// The result is negative
			let remaingLF = 0n
			let availableBalance = allocatedBalance - lf - cva + upnlTS
			if (lf > -availableBalance) remaingLF = lf + availableBalance
			let maxProfitPerPos = (await context.viewFacet.getLiquidationInsuranceVaultParams())[1]

			await expect(context.liquidationFacet.connect(context.signers.liquidator).liquidatePartyA(user2.address, sign)).to.be.revertedWith(
				"LiquidationFacet: PartyA is solvent",
			)

			// the price of 25 makes the position just before liquidation,
			// prices 24 and 23 makes it Normal Liquidated
			price = decimal(24n, 16)

			upnlTS = await user2.getUpnl(getPriceFetcher([1n], [price]))
			totalUnrealizedLoss = await user2.getTotalUnrealisedLoss(getPriceFetcher([1n], [price]))
			sign = await getDummyLiquidationSig("0x10", upnlTS, [1n], [price], totalUnrealizedLoss, allocatedBalance)
			lf = quote.lockedValues.lf
			cva = quote.lockedValues.cva

			// AllocatedBalance:100, LF: 3,  CVA: 22, Quantity:100, Price:1**18, Trading Fee:1**16
			// With the price Low enough, 24**16, we get UPNL of -76, this makes the Available Balance after calculations, to be ' -1 ',
			// ready to Liquidate the position in Normal
			// The result is negative
			remaingLF = 0n
			availableBalance = allocatedBalance - lf - cva + upnlTS
			if (lf > -availableBalance) remaingLF = lf + availableBalance
			maxProfitPerPos = (await context.viewFacet.getLiquidationInsuranceVaultParams())[1]

			await context.liquidationFacet.connect(context.signers.liquidator).liquidatePartyA(user2.address, sign)
			await context.liquidationFacet.connect(context.signers.liquidator).setSymbolsPrice(user2.address, sign)

			// its ok as there is only one position
			await expectConnected(user2.address, hedger.address, true)
			const liquidationState = await user2.getLiquidatedStateOfPartyA()
			expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.NORMAL)
			expect(await context.viewFacet.balanceOf(context.signers.others[0].address)).to.be.equal(remaingLF - maxProfitPerPos)
		})

		// We have a Long Limit Position for User2 at index 4
		// Tweak the price to get different UPNL in order to make the position liquid
		// lower the price to make the party A position in near liquidation risk
		// The Quote Price is 1**18, we set it to 25**16,
		// as we have CVA = 22, LF = 3, ==> Balance = 22 + 3 - 25 = 0 not liquidated yet
		// The Price below 25 makes the position liquidated
		it("Should Not change the insurance vault correctly in Late Liquidation", async function () {
			await context.controlFacet.connect(context.signers.admin).setLiquidationInsuranceVaultParams(context.signers.others[0].address, decimal(1n))

			// Deallocate 399n so that it has 100n as allocated balance
			await context.accountFacet.connect(user2.getSigner).deallocate(decimal(399n), await getDummySingleUpnlSig())
			const allocated = await context.viewFacet.allocatedBalanceOfPartyA(user2.address)
			const allocatedBalance = (await user2.getBalanceInfo()).allocatedBalances
			const quote = await context.viewFacetQuote.getQuote(4)

			// We have a Long Limit Position for User 2 at index 4
			// Tweak the price to get different UPNL in order to make the position liquid
			// lower the price to make the party A position in liquidation risk
			let price = decimal(25n, 16)

			let upnlTS = await user2.getUpnl(getPriceFetcher([1n], [price]))
			let totalUnrealizedLoss = await user2.getTotalUnrealisedLoss(getPriceFetcher([1n], [price]))
			let sign = await getDummyLiquidationSig("0x10", upnlTS, [1n], [price], totalUnrealizedLoss, allocatedBalance)
			let lf = quote.lockedValues.lf
			let cva = quote.lockedValues.cva

			// AllocatedBalance:100, LF: 3,  CVA: 22, Quantity:100, Price:1**18, Trading Fee:1**16
			// ready to Liquidate the position in Late
			// The result is negative
			let availableBalance = allocatedBalance - lf - cva + upnlTS
			let deficit = 0n
			if (lf + cva >= -availableBalance) deficit = -availableBalance - lf

			await expect(context.liquidationFacet.connect(context.signers.liquidator).liquidatePartyA(user2.address, sign)).to.be.revertedWith(
				"LiquidationFacet: PartyA is solvent",
			)

			// the price of 25 makes the position just before liquidation,
			// prices 24 to 22 makes it Normal Liquidated
			// and Prices below 22 makes it late liquidated
			price = decimal(2n, 16)

			upnlTS = await user2.getUpnl(getPriceFetcher([1n], [price]))
			totalUnrealizedLoss = await user2.getTotalUnrealisedLoss(getPriceFetcher([1n], [price]))
			sign = await getDummyLiquidationSig("0x10", upnlTS, [1n], [price], totalUnrealizedLoss, allocatedBalance)
			lf = quote.lockedValues.lf
			cva = quote.lockedValues.cva

			// AllocatedBalance:100, LF: 3,  CVA: 22, Quantity:100, Price:1**18, Trading Fee:1**16
			// ready to Liquidate the position in Late
			// The result is negative
			availableBalance = allocatedBalance - lf - cva + upnlTS
			deficit = 0n
			if (lf + cva >= -availableBalance) deficit = -availableBalance - lf

			await context.liquidationFacet.connect(context.signers.liquidator).liquidatePartyA(user2.address, sign)
			await context.liquidationFacet.connect(context.signers.liquidator).setSymbolsPrice(user2.address, sign)

			// its ok as there is only one position
			expect(await context.viewFacet.balanceOf(context.signers.others[0].address)).to.be.equal(0)
			await expectConnected(user2.address, hedger.address, true)
			const liquidationState = await user2.getLiquidatedStateOfPartyA()
			expect(liquidationState["deficit"]).to.be.equal(deficit)
			expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.LATE)
		})

		it("Should Not change the insurance vault correctly in OVERDUE Liquidation", async function () {
			let user3
			user3 = new User(context, context.signers.feeCollector2)
			await user3.setup()
			await user3.setBalances(decimal(2000n), decimal(1000n), decimal(500n))
			await user3.sendQuote(limitQuoteRequestBuilder().cva(decimal(20n)).deadline(getBlockTimestamp(1000n)).build())
			let lastID = await context.viewFacetQuote.getNextQuoteId()
			await hedger.lockQuote(lastID)
			await hedger.openPosition(lastID)

			await user3.sendQuote(limitQuoteRequestBuilder().cva(decimal(10n)).deadline(getBlockTimestamp(1000n)).build())
			lastID = await context.viewFacetQuote.getNextQuoteId()
			await hedger.lockQuote(lastID)
			await hedger.openPosition(lastID)

			await context.controlFacet.connect(context.signers.admin).setLiquidationInsuranceVaultParams(context.signers.others[0].address, decimal(1n))

			// Deallocate 312 so that it has enough for locking and allocating balance
			await context.accountFacet.connect(user3.getSigner).deallocate(decimal(312n), await getDummySingleUpnlSig())

			// We have a Long Limit Position for User 2 at index 4
			// Tweak the price to get different UPNL in order to make the position liquid
			// lower the price to make the party A position in liquidation risk
			const price = decimal(5n, 16)
			const quote = await context.viewFacetQuote.getQuote(lastID)

			const allocated = await context.viewFacet.allocatedBalanceOfPartyA(user3.address)
			const allocatedBalance = (await user3.getBalanceInfo()).allocatedBalances

			const upnlTS = await user3.getUpnl(getPriceFetcher([1n], [price]))
			const totalUnrealizedLoss = await user3.getTotalUnrealisedLoss(getPriceFetcher([1n], [price]))
			const sign = await getDummyLiquidationSig("0x10", upnlTS, [1n], [price], totalUnrealizedLoss, allocatedBalance)
			const lf = quote.lockedValues.lf
			const cva = quote.lockedValues.cva

			// AllocatedBalance:100, LF: 3,  CVA: 22, Quantity:100, Price:1**18, Trading Fee:1**16
			// ready to Liquidate the position in Late
			// The result is negative
			const availableBalance = allocatedBalance - lf - cva + upnlTS
			let deficit = 0n
			if (lf + cva < -availableBalance) deficit = -availableBalance - (lf + cva)

			await context.liquidationFacet.connect(context.signers.liquidator).liquidatePartyA(user3.address, sign)
			await context.liquidationFacet.connect(context.signers.liquidator).setSymbolsPrice(user3.address, sign)

			// its ok as there is only one position
			expect(await context.viewFacet.balanceOf(context.signers.others[0].address)).to.be.equal(0)
			await expectConnected(user3.address, hedger.address, true)
			const liquidationState = await user3.getLiquidatedStateOfPartyA()
			expect(liquidationState["deficit"]).to.be.equal(deficit)
			expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.OVERDUE)
		})

		it("Should change the insurance vault correctly in deferred liquidation", async function () {
			await context.controlFacet.connect(context.signers.admin).setLiquidationInsuranceVaultParams(context.signers.others[0].address, decimal(1n))
			const fundingFee = await getFundingFee()
			const price = decimal(572n, 16)
			await user.deferredLiquidateAndSetSymbolPrices([1n], [price], [1n])
			expect(await context.viewFacet.balanceOf(context.signers.others[0].address)).to.be.equal(decimal(1n)-fundingFee)
			await expectConnected(user.address, hedger.address, true)

		})

		it("Should change the insurance vault correctly in deferred liquidation", async function () {
			await context.controlFacet.connect(context.signers.admin).setLiquidationInsuranceVaultParams(context.signers.others[0].address, decimal(1n))
			await context.accountFacet.connect(user2.getSigner).deallocate(decimal(399n), await getDummySingleUpnlSig())
			// 100n as allocated balance

			// Tweak the price to get different UPNL in order to make the position liquid
			const price = decimal(24n, 16) // lower the price to make the party A position in liquidation risk
			const quote = await context.viewFacetQuote.getQuote(4)

			const allocated = await context.viewFacet.allocatedBalanceOfPartyA(user2.address)
			const allocatedBalance = (await user2.getBalanceInfo()).allocatedBalances

			const upnlTS = await user2.getUpnl(getPriceFetcher([1n], [price]))
			const totalUnrealizedLoss = await user2.getTotalUnrealisedLoss(getPriceFetcher([1n], [price]))
			const sign = await getDummyLiquidationSig("0x10", upnlTS, [1n], [price], totalUnrealizedLoss, allocatedBalance)
			const lf = quote.lockedValues.lf
			const cva = quote.lockedValues.cva
			const availableBalance = allocated - lf - cva + upnlTS // the result is negative // 100 - 3 - 22 - (.5*100)
			const remaingLF = lf > availableBalance ? lf + availableBalance : lf + cva + availableBalance
			const maxProfitPerPos = (await context.viewFacet.getLiquidationInsuranceVaultParams())[1]

			await context.liquidationFacet.connect(context.signers.liquidator).deferredLiquidatePartyA(user2.address, sign)
			await context.liquidationFacet.connect(context.signers.liquidator).deferredSetSymbolsPrice(user2.address, sign)

			// its ok as there is only one position
			expect(await context.viewFacet.balanceOf(context.signers.others[0].address)).to.be.equal(remaingLF - maxProfitPerPos)
			await expectConnected(user2.address, hedger.address, true)
			const liquidationState = await user2.getLiquidatedStateOfPartyA()
			expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.NORMAL)
		})

		describe("Test normal branch", async function () {
			const price = decimal(57198n, 14)
			beforeEach(async function () {
				await context.controlFacet.connect(context.signers.admin).grantRole(context.signers.admin, ethers.keccak256(toUtf8Bytes("SETTER_ROLE")))
				await context.controlFacet.connect(context.signers.admin).setLiquidationInsuranceVaultParams(context.signers.others[0].address, decimal(100n))
				this.signature1 = await user.liquidateAndSetSymbolPrices([1n], [price], [1n])
				const liquidationState = await user.getLiquidatedStateOfPartyA()
				expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.NORMAL)
			})

			it("Should fail on invalid state", async function () {
				await expect(user.liquidatePositions([2])).to.be.revertedWith("LiquidationFacet: Invalid state")
			})

			it("Should fail on partyA being solvent", async function () {
				let user3 = context.signers.hedger2.getAddress()
				await expect(context.liquidationFacet.connect(context.signers.liquidator).liquidatePositionsPartyA(user3, [1])).to.be.revertedWith(
					"LiquidationFacet: PartyA is solvent",
				)
			})

			it("Should fail on partyA being the liquidator himself", async function () {
				await expect(user2.liquidatePositions([2])).to.be.revertedWith("LiquidationFacet: PartyA is solvent")
			})

			it("Should liquidate positions", async function () {
				await user.liquidatePendingPositions()
				await user.liquidatePositions([1])
				expect((await context.viewFacetQuote.getQuote(1)).quoteStatus).to.be.equal(QuoteStatus.LIQUIDATED)
				await expectConnected(user.address, hedger.address, false)
			})

			describe("Settle liquidation", async function () {
				beforeEach(async function () {
					this.fundingFee = await getFundingFee()
					await user.liquidatePendingPositions()
					await user.liquidatePositions([1])
				})

				it("Should settle liquidation", async function () {
					let userAddress = await context.signers.user.getAddress()
					let hedgerAddress = await context.signers.hedger.getAddress()
					const hedgerBalance = await hedger.getBalanceInfo(await user.getAddress())
					const userBalance = await user.getBalanceInfo()

					const fundingFee = this.fundingFee as bigint
					const upnl = unDecimal((decimal(1n) - price) * decimal(100n)) - fundingFee
					const available = userBalance.allocatedBalances - userBalance.lockedCva - userBalance.lockedLf + upnl
					const diff = userBalance.lockedLf - (-available)
					const partyBAfter = hedgerBalance.allocatedBalances - upnl + userBalance.lockedCva
					await user.settleLiquidation()
					expect(await context.viewFacet.allocatedBalanceOfPartyB(hedgerAddress, userAddress)).to.be.equal(partyBAfter)
					let balanceInfoOfLiquidator = await liquidator.getBalanceInfo()
					expect(balanceInfoOfLiquidator.allocatedBalances).to.be.equal(diff)
					await expectConnected(userAddress, hedgerAddress, false)
				})
			})
		})

		describe("Test late branches", async function () {
			it("Late liquidation", async function () {
				const price = decimal(594n, 16)
				await user.liquidateAndSetSymbolPrices([1n], [price],[1n])
				const liquidationState = await user.getLiquidatedStateOfPartyA()
				expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.LATE)

				const hedgerBalance = await hedger.getBalanceInfo(await user.getAddress())
				const userBalance = await user.getBalanceInfo()
				const available = userBalance.allocatedBalances - userBalance.lockedCva
				const pnl = unDecimal(price - decimal(1n)) * decimal(100n)
				const diff = available - pnl
				const partyBAfter = hedgerBalance.allocatedBalances + pnl + userBalance.lockedCva + diff

				await user.liquidatePendingPositions()
				await user.liquidatePositions([1])
				await user.settleLiquidation()
				const fundingFee = await getFundingFee()
				expect((await hedger.getBalanceInfo(await user.getAddress())).allocatedBalances).to.be.equal(partyBAfter - fundingFee)
				let balanceInfoOfLiquidator = await liquidator.getBalanceInfo()
				expect(balanceInfoOfLiquidator.allocatedBalances).to.be.equal(decimal(0n))
			})

			it("Overdue liquidation", async function () {
				await user.liquidateAndSetSymbolPrices([1n], [decimal(599n, 16)],[1n])
				const liquidationState = await user.getLiquidatedStateOfPartyA()
				expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.OVERDUE)
				await user.liquidatePendingPositions()
				await user.liquidatePositions([1n])
				await user.settleLiquidation()

				expect(await context.viewFacet.allocatedBalanceOfPartyB(hedger.getAddress(), user.getAddress())).to.be.equal(decimal(856n))
				let balanceInfoOfLiquidator = await liquidator.getBalanceInfo()
				expect(balanceInfoOfLiquidator.allocatedBalances).to.be.equal(decimal(0n))
			})
		})
	})

	describe("Test normal branch deferred", async function () {
		const price = decimal(572n, 16)
		beforeEach(async function () {
			await context.controlFacet.connect(context.signers.admin).grantRole(context.signers.admin, ethers.keccak256(toUtf8Bytes("SETTER_ROLE")))
			await context.controlFacet.connect(context.signers.admin).setLiquidationInsuranceVaultParams(context.signers.others[0].address, decimal(100n))
			this.signature1 = await user.deferredLiquidateAndSetSymbolPrices([1n], [price],[1n])
			const liquidationState = await user.getLiquidatedStateOfPartyA()
			expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.NORMAL)
		})

		it("Should fail on invalid state deferred", async function () {
			await expect(user.liquidatePositions([2])).to.be.revertedWith("LiquidationFacet: Invalid state")
		})

		it("Should fail on partyA being solvent deferred", async function () {
			let user3 = context.signers.hedger2.getAddress()
			await expect(context.liquidationFacet.connect(context.signers.liquidator).liquidatePositionsPartyA(user3, [1])).to.be.revertedWith(
				"LiquidationFacet: PartyA is solvent",
			)
		})

		it("Should fail on partyA being the liquidator himself deferred", async function () {
			await expect(user2.liquidatePositions([2])).to.be.revertedWith("LiquidationFacet: PartyA is solvent")
		})

		it("Should liquidate positions deferred", async function () {
			await user.liquidatePendingPositions()
			await user.liquidatePositions([1])
			expect((await context.viewFacetQuote.getQuote(1)).quoteStatus).to.be.equal(QuoteStatus.LIQUIDATED)
		})

		describe("Settle liquidation deferred", async function () {
			beforeEach(async function () {
				this.fundingFee = await getFundingFee()
				await user.liquidatePendingPositions()
				await user.liquidatePositions([1])
			})

			it("Should settle liquidation deferred", async function () {
				let userAddress = context.signers.user.getAddress()
				let hedgerAddress = context.signers.hedger.getAddress()

					const hedgerBalance = await hedger.getBalanceInfo(await user.getAddress())
					const userBalance = await user.getBalanceInfo()
					const fundingFee = this.fundingFee as bigint
					const upnl = unDecimal((decimal(1n) - price) * decimal(100n)) - fundingFee
					const available = userBalance.allocatedBalances - userBalance.lockedCva - userBalance.lockedLf + upnl
					const diff = userBalance.lockedLf - (-available)
					const partyBAfter = hedgerBalance.allocatedBalances - upnl + userBalance.lockedCva

					await user.settleLiquidation()
					expect(await context.viewFacet.allocatedBalanceOfPartyB(hedgerAddress, userAddress)).to.be.equal(partyBAfter)
					let balanceInfoOfLiquidator = await liquidator.getBalanceInfo()
				expect(balanceInfoOfLiquidator.allocatedBalances).to.be.equal(diff)
			})
		})
	})

	describe("Test late branches", async function () {
		it("Late liquidation", async function () {
			const price = decimal(595n, 16)
			await user.deferredLiquidateAndSetSymbolPrices([1n], [price],[1n])
			const liquidationState = await user.getLiquidatedStateOfPartyA()
			expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.LATE)

			const hedgerBalance = await hedger.getBalanceInfo(await user.getAddress())
			const userBalance = await user.getBalanceInfo()
			const available = userBalance.allocatedBalances - userBalance.lockedCva
			const pnl = unDecimal(price - decimal(1n)) * decimal(100n)
			const diff = available - pnl
			const partyBAfter = hedgerBalance.allocatedBalances + pnl + userBalance.lockedCva + diff

			await user.liquidatePendingPositions()
			await user.liquidatePositions([1])
			await user.settleLiquidation()
			expect((await hedger.getBalanceInfo(await user.getAddress())).allocatedBalances).to.be.equal(partyBAfter)
			let balanceInfoOfLiquidator = await liquidator.getBalanceInfo()
			expect(balanceInfoOfLiquidator.allocatedBalances).to.be.equal(decimal(0n))
		})

		it("Overdue liquidation", async function () {
			await user.liquidateAndSetSymbolPrices([1n], [decimal(599n, 16)],[1n])
			const liquidationState = await user.getLiquidatedStateOfPartyA()
			expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.OVERDUE)
			await user.liquidatePendingPositions()
			await user.liquidatePositions([1])
			await user.settleLiquidation()

			expect(await context.viewFacet.allocatedBalanceOfPartyB(hedger.getAddress(), user.getAddress())).to.be.equal(decimal(856n))
			let balanceInfoOfLiquidator = await liquidator.getBalanceInfo()
			expect(balanceInfoOfLiquidator.allocatedBalances).to.be.equal(decimal(0n))
		})
	})

	describe("Liquidate PartyB", async function () {
		it("Should fail on partyB being solvent", async function () {
			await expect(
				context.liquidationFacet
					.connect(context.signers.liquidator)
					.liquidatePartyB(context.signers.hedger.getAddress(), context.signers.user.getAddress(), await getDummySingleUpnlSig()),
			).to.be.revertedWith("LiquidationFacet: partyB is solvent")
		})

		it("Should run successfully", async function () {
			let userAddress = await context.signers.user.getAddress()
			let hedgerAddress = await context.signers.hedger.getAddress()

			await context.liquidationFacet
				.connect(context.signers.liquidator)
				.liquidatePartyB(hedgerAddress, userAddress, await getDummySingleUpnlSig(decimal(-336n)))
			let balanceInfo: BalanceInfo = await hedger.getBalanceInfo(userAddress)
			expect(balanceInfo.allocatedBalances).to.be.equal("0")
			expect(balanceInfo.lockedCva).to.be.equal("0")
			expect(balanceInfo.lockedMmPartyB).to.be.equal("0")
			expect(balanceInfo.lockedLf).to.be.equal("0")
			expect(balanceInfo.totalLockedPartyB).to.be.equal("0")
			expect(balanceInfo.pendingLockedCva).to.be.equal("0")
			expect(balanceInfo.pendingLockedMmPartyB).to.be.equal("0")
			expect(balanceInfo.pendingLockedLf).to.be.equal("0")
			expect(balanceInfo.totalPendingLockedPartyB).to.be.equal("0")

			expect((await context.viewFacetQuote.getQuote(5)).quoteStatus).to.be.equal(QuoteStatus.LIQUIDATED_PENDING)
		})

		it("Should fail to liquidate a partyB twice", async function () {
			await context.liquidationFacet
				.connect(context.signers.liquidator)
				.liquidatePartyB(context.signers.hedger.getAddress(), context.signers.user.getAddress(), await getDummySingleUpnlSig(decimal(-336n)))
			await expect(
				context.liquidationFacet
					.connect(context.signers.liquidator)
					.liquidatePartyB(context.signers.hedger.getAddress(), context.signers.user.getAddress(), await getDummySingleUpnlSig(decimal(-336n))),
			).to.revertedWith("Accessibility: PartyB isn't solvent")
		})
	})
}
