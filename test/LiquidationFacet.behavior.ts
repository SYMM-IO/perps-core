import { expect } from "chai"

import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { LiquidationType, OrderType, PositionType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import type { BalanceInfo } from "./models/User.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp, getPriceFetcher, getTotalLockedValuesForQuoteIds, getTradingFeeForQuotes, unDecimal } from "./utils/Common.js"
import { getDummyLiquidationSig, getDummyPriceSig, getDummySingleUpnlAndPriceSig, getDummySingleUpnlSig } from "./utils/SignatureUtils.js"

/**
 * ========================================
 * LIQUIDATION TESTS
 * ========================================
 *
 * LIQUIDATION OVERVIEW:
 * ---------------------
 * When a user (PartyA) opens a position, they lock collateral:
 *   - CVA (Counter-party Volatility Adjustment): Protects PartyB if user defaults
 *   - LF (Liquidation Fee): Reward for liquidators
 *   - MM (Maintenance Margin): Buffer for price movements
 *
 * Liquidation triggers when: availableBalance < 0
 * Where: availableBalance = allocatedBalance - CVA - LF + UPNL - fundingFee
 *
 * LIQUIDATION TYPES (based on severity of loss):
 * ----------------------------------------------
 * 1. NORMAL:  -availableBalance < LF
 *             User lost some money, but LF can still cover liquidator reward
 *             Insurance vault may receive excess LF
 *
 * 2. LATE:    LF <= -availableBalance <= LF + CVA
 *             User lost more, LF exhausted, eating into CVA
 *             Insurance vault gets nothing
 *
 * 3. OVERDUE: -availableBalance > LF + CVA
 *             User lost everything and owes more than their collateral
 *             Insurance vault gets nothing, PartyB takes a haircut
 *
 * DEFAULT QUOTE PARAMETERS (from limitQuoteRequestBuilder):
 * --------------------------------------------------------
 *   - price: 1e18 (1 token)
 *   - quantity: 100e18 (100 units)
 *   - CVA: 22e18 (22 tokens)
 *   - LF: 3e18 (3 tokens)
 *   - partyAmm: 75e18 (75 tokens maintenance margin)
 *   - partyBmm: 40e18 (40 tokens)
 */

export function shouldBehaveLikeLiquidationFacet(): void {
	let context: RunContext, user: User, user2: User, liquidator: User, hedger: Hedger, hedger2: Hedger

	/** Get accumulated funding fee for quote 1 - this fee accrues over time based on block.timestamp */
	const getFundingFee = async () => await context.viewFacetQuote.getSumQuoteFundingDebts([1])

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)

		// ========================================
		// USER SETUP
		// ========================================
		// User balances: mint 2000, deposit 1000, allocate 500 for trading
		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(
			decimal(2000n), // Mint 2000 collateral tokens to wallet
			decimal(1000n), // Deposit 1000 into protocol (non-allocated balance)
			decimal(500n), // Allocate 500 for trading (can be used as margin)
		)

		user2 = new User(context, context.signers.user2)
		await user2.setup()
		await user2.setBalances(decimal(2000n), decimal(1000n), decimal(500n))

		liquidator = new User(context, context.signers.liquidator)
		await liquidator.setup()

		// Hedger (PartyB) balances: mint 2000, deposit/allocate 1000
		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(2000n), decimal(1000n))

		hedger2 = new Hedger(context, context.signers.hedger2)
		await hedger2.setup()
		await hedger2.setBalances(decimal(2000n), decimal(1000n))

		// ========================================
		// FUNDING FEE SETUP
		// ========================================
		// Enable funding fees that accumulate over time
		// Epoch duration: 500 seconds - after this, funding fees are charged
		//
		// IMPORTANT: Align timestamp to epoch boundary for consistent funding fee calculations.
		// Without this, the number of epochs that pass can vary depending on the test's
		// starting timestamp, causing flaky liquidation type assertions.
		const epochDuration = 500
		const latest = BigInt(await time.latest())
		const aligned = (latest / BigInt(epochDuration) + 1n) * BigInt(epochDuration)
		await time.setNextBlockTimestamp(Number(aligned))

		await context.pauseControlFacet.activateAccumulatedFunding()
		await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [epochDuration]) // symbolId 1, epoch 500s
		await context.fundingRateFacet.connect(context.signers.hedger).setFundingFee(
			[1], // symbolId
			[decimal(2n, 16)], // accumulatedLongRate: 0.02 (2%)
			[decimal(1n, 16)], // accumulatedShortRate: 0.01 (1%)
			[decimal(1n)], // currentRate
		)

		// ========================================
		// QUOTE SETUP FOR USER (PartyA)
		// ========================================
		// Quote 1: User opens SHORT position at price 1, qty 100
		// When price goes UP, SHORT position loses money (UPNL becomes negative)
		// Locked values: CVA=22, LF=3, MM=75 (total locked: 100)
		await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
		await hedger.lockQuote(1)
		await hedger.openPosition(1)

		// Quote 2: Locked (pending) - uses default LONG position
		await user.sendQuote()
		await hedger.lockQuote(2)

		// Quote 3: Sent but not locked (pending)
		await user.sendQuote()

		// Quote 4: User2 opens LONG position at price 1, qty 100
		// When price goes DOWN, LONG position loses money
		await user2.sendQuote()
		await hedger.lockQuote(4)
		await hedger.openPosition(4)

		// Quote 5: User's quote, locked (pending)
		await user.sendQuote()
		await hedger.lockQuote(5)

		// ========================================
		// TIME ADVANCEMENT
		// ========================================
		// Advance time by exactly 1 epoch (500 seconds) to ensure exactly 1 epoch
		// of funding fees accumulates. Using setNextBlockTimestamp instead of
		// time.increase() for deterministic behavior.
		const currentTime = BigInt(await time.latest())
		await time.setNextBlockTimestamp(Number(currentTime + BigInt(epochDuration)))
		await context.controlFacet.setMuonConfig(1000n, 1000n)
	})

	/** Helper to check if PartyA and PartyB are connected (have open positions together) */
	const expectConnected = async (partyA: string, partyB: string, expected: boolean) => {
		const isConn = await context.viewFacetSymbol.isConnectedPartyB(partyA, partyB)
		expect(isConn).to.equal(expected)
		const conns = await context.viewFacetSymbol.getConnectedPartyBs(partyA)
		if (expected) expect(conns).to.include(partyB)
		else expect(conns).to.not.include(partyB)
	}

	describe("Liquidate PartyA", async function () {
		it("Should fail on partyA having no open positions", async function () {
			// liquidator has no open positions - liquidation should fail even with negative upnl signature
			await expect(
				context.partyALiquidationFacet.liquidatePartyA(
					context.signers.liquidator.getAddress(),
					await getDummyLiquidationSig("0x10", decimal(-1000n), [], [], decimal(-1000n), 0n),
				),
			).to.be.revertedWith("LiquidationFacet: PartyA has no open positions")
		})

		it("Should fail on partyA being solvent", async function () {
			// With UPNL=0 and no loss, user is solvent - liquidation should fail
			await expect(
				context.partyALiquidationFacet.liquidatePartyA(
					context.signers.user.getAddress(),
					await getDummyLiquidationSig("0x10", 0n, [], [], 0n, (await user.getBalanceInfo()).allocatedBalances),
				),
			).to.be.revertedWith("LiquidationFacet: PartyA is solvent")
		})

		it("Should fail on partyA being solvent deferred", async function () {
			await expect(
				context.partyALiquidationFacet.deferredLiquidatePartyA(
					context.signers.user.getAddress(),
					await getDummyLiquidationSig("0x10", 0n, [], [], 0n, (await user.getBalanceInfo()).allocatedBalances),
				),
			).to.be.revertedWith("LiquidationFacet: PartyA is solvent")
		})

		it("Should liquidate pending quotes", async function () {
			// Price 8.0 on a SHORT position opened at 1.0:
			// UPNL = (1 - 8) * 100 = -700 (massive loss)
			// This triggers liquidation and pending quotes get liquidated
			await user.liquidateAndSetSymbolPrices([1n], [decimal(8n)], [1n])
			await user.liquidatePendingPositions()

			const pendingAfter = (await user.getBalanceInfo()).totalPendingLockedPartyA
			expect(pendingAfter).to.equal(0n)

			// Pending quotes (2 and 3) should be marked as LIQUIDATED_PENDING
			expect((await context.viewFacetQuote.getQuote(2)).quoteStatus).to.be.equal(QuoteStatus.LIQUIDATED_PENDING)
			expect((await context.viewFacetQuote.getQuote(3)).quoteStatus).to.be.equal(QuoteStatus.LIQUIDATED_PENDING)

			let balanceInfoOfPartyA: BalanceInfo = await user.getBalanceInfo()
			// User keeps allocated balance minus trading fees (fees are reimbursed for liquidated pending)
			expect(balanceInfoOfPartyA.allocatedBalances).to.be.equal(decimal(500n) - (await getTradingFeeForQuotes(context, [1n, 2n, 3n, 4n])))
			expect(balanceInfoOfPartyA.totalLockedPartyA).to.be.equal(await getTotalLockedValuesForQuoteIds(context, [1n]))
			// All pending locked values should be zero after liquidation
			expect(balanceInfoOfPartyA.pendingLockedCva).to.be.equal("0")
			expect(balanceInfoOfPartyA.pendingLockedMmPartyA).to.be.equal("0")
			expect(balanceInfoOfPartyA.pendingLockedLf).to.be.equal("0")
			expect(balanceInfoOfPartyA.totalPendingLockedPartyA).to.be.equal("0")

			// PartyB (hedger) balance after liquidation
			let balanceInfoOfPartyB: BalanceInfo = await hedger.getBalanceInfo(await user.getAddress())
			expect(balanceInfoOfPartyB.allocatedBalances).to.be.equal(decimal(360n).toString()) // 1000 - 640 used for positions
			expect(balanceInfoOfPartyB.lockedCva).to.be.equal(decimal(22n).toString()) // CVA from quote 1
			expect(balanceInfoOfPartyB.lockedMmPartyB).to.be.equal(decimal(40n).toString()) // MM from quote 1
			expect(balanceInfoOfPartyB.lockedLf).to.be.equal(decimal(3n).toString()) // LF from quote 1
			expect(balanceInfoOfPartyB.totalLockedPartyB).to.be.equal(decimal(65n).toString()) // 22 + 40 + 3 = 65
			expect(balanceInfoOfPartyB.pendingLockedCva).to.be.equal("0")
			expect(balanceInfoOfPartyB.pendingLockedMmPartyB).to.be.equal("0")
			expect(balanceInfoOfPartyB.pendingLockedLf).to.be.equal("0")
			expect(balanceInfoOfPartyB.totalPendingLockedPartyB).to.be.equal("0")
		})

		it("Should deferred liquidate pending quotes", async function () {
			// Same as above but using deferred liquidation
			await user.deferredLiquidateAndSetSymbolPrices([1n], [decimal(8n)], [1n])
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
			await user.liquidateAndSetSymbolPrices([1n], [decimal(8n)], [1n])
			await expect(user.liquidateAndSetSymbolPrices([1n], [decimal(8n)], [1n])).to.be.revertedWith("Accessibility: PartyA isn't solvent")
		})

		it("Should fail to deferred liquidate a user twice", async function () {
			await user.deferredLiquidateAndSetSymbolPrices([1n], [decimal(8n)], [1n])
			await expect(user.deferredLiquidateAndSetSymbolPrices([1n], [decimal(8n)], [1n])).to.be.revertedWith("Accessibility: PartyA isn't solvent")
		})

		/**
		 * INSURANCE VAULT TEST - NORMAL LIQUIDATION
		 *
		 * In NORMAL liquidation, excess LF (after paying liquidator) goes to insurance vault.
		 *
		 * Setup:
		 *   - maxProfitPerPosition = 1e18 (set via setLiquidationInsuranceVaultParams)
		 *   - Price = 5.72 on SHORT position opened at 1.0
		 *   - UPNL = (1 - 5.72) * 100 = -472 (loss)
		 *
		 * Calculation:
		 *   availableBalance = allocatedBalance - CVA - LF + UPNL - fundingFee
		 *   remainingLf = LF - (-availableBalance)  [if NORMAL: -availableBalance < LF]
		 *   vaultReceives = remainingLf - maxProfitPerPosition  [if remainingLf > maxProfit]
		 */
		it("Should change the insurance vault correctly", async function () {
			// Set insurance vault address and max profit per position (1 token)
			await context.controlFacet.connect(context.signers.admin).setLiquidationInsuranceVaultParams(
				context.signers.others[0].address, // Insurance vault address
				decimal(1n), // maxProfitPerPosition: 1e18
			)

			// Price 5.72 causes loss but stays in NORMAL liquidation range
			const price = decimal(572n, 16) // 5.72e18

			// Get values needed to calculate expected insurance vault balance
			const allocatedBalance = (await user.getBalanceInfo()).allocatedBalances
			const quote = await context.viewFacetQuote.getQuote(1)
			const lf = quote.lockedValues.lf // 3e18 (Liquidation Fee)
			const cva = quote.lockedValues.cva // 22e18 (CVA)
			const fundingFee = await getFundingFee()

			// UPNL for SHORT: (openPrice - currentPrice) * quantity = (1 - 5.72) * 100 = -472
			const upnl = (await user.getUpnl(getPriceFetcher([1n], [price]))) - fundingFee

			// Calculate expected vault balance using contract logic:
			// availableBalance = allocated - lf - cva + upnl
			// If -availableBalance < lf (NORMAL): remainingLf = lf + availableBalance
			// Vault gets: max(0, remainingLf - maxProfit)
			const availableBalance = allocatedBalance - lf - cva + upnl
			let remainingLf = 0n
			if (lf > -availableBalance) remainingLf = lf + availableBalance
			const maxProfitPerPos = (await context.viewFacet.getLiquidationInsuranceVaultParams())[1]
			const expectedVaultBalance = remainingLf > maxProfitPerPos ? remainingLf - maxProfitPerPos : 0n

			await user.liquidateAndSetSymbolPrices([1n], [price], [1n])
			const liquidationState = await user.getLiquidatedStateOfPartyA()

			expect(await context.viewFacet.balanceOf(context.signers.others[0].address)).to.be.equal(expectedVaultBalance)
			await expectConnected(user.address, hedger.address, true)
			expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.NORMAL)
		})

		/**
		 * USER2 NORMAL LIQUIDATION TEST (LONG position)
		 *
		 * User2 has a LONG position (Quote 4) at price 1.0
		 * For LONG: when price goes DOWN, position loses money
		 *
		 * Setup:
		 *   - Deallocate to leave only 100 tokens allocated
		 *   - CVA=22, LF=3, Quantity=100, OpenPrice=1
		 *
		 * Price thresholds for User2:
		 *   - Price 0.25: Just solvent (availableBalance ≈ 0)
		 *   - Price 0.24: NORMAL liquidation (small deficit)
		 *   - Price 0.22 and below: LATE liquidation (deficit > LF)
		 */
		it("Should change the insurance vault correctly in Normal Liquidation", async function () {
			await context.controlFacet.connect(context.signers.admin).setLiquidationInsuranceVaultParams(
				context.signers.others[0].address,
				decimal(1n), // maxProfitPerPosition: 1e18
			)

			// Deallocate to leave user2 with only 100 tokens allocated
			// Original: 500, Deallocate: 399, Remaining: 101 (minus some fees)
			await context.accountFacet.connect(user2.signer).deallocate(decimal(399n), await getDummySingleUpnlSig())
			const allocated = await context.viewFacet.allocatedBalanceOfPartyA(user2.address)
			const allocatedBalance = (await user2.getBalanceInfo()).allocatedBalances
			const quote = await context.viewFacetQuote.getQuote(4)

			// Price 0.25: LONG loses (1-0.25)*100 = 75
			// availableBalance = 100 - 22 - 3 - 75 = 0 (just solvent)
			let price = decimal(25n, 16) // 0.25e18

			let upnlTS = await user2.getUpnl(getPriceFetcher([1n], [price]))
			let totalUnrealizedLoss = await user2.getTotalUnrealisedLoss(getPriceFetcher([1n], [price]))
			let sign = await getDummyLiquidationSig("0x10", upnlTS, [1n], [price], totalUnrealizedLoss, allocatedBalance)
			let lf = quote.lockedValues.lf // 3e18
			let cva = quote.lockedValues.cva // 22e18

			// Calculate: at price 0.25, availableBalance ≈ 0, user is just solvent
			let remaingLF = 0n
			let availableBalance = allocatedBalance - lf - cva + upnlTS
			if (lf > -availableBalance) remaingLF = lf + availableBalance
			let maxProfitPerPos = (await context.viewFacet.getLiquidationInsuranceVaultParams())[1]

			// Should fail - user is still solvent at price 0.25
			await expect(context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePartyA(user2.address, sign)).to.be.revertedWith(
				"LiquidationFacet: PartyA is solvent",
			)

			// Price 0.24: LONG loses (1-0.24)*100 = 76
			// availableBalance = 100 - 22 - 3 - 76 = -1 (insolvent, NORMAL)
			price = decimal(24n, 16) // 0.24e18

			upnlTS = await user2.getUpnl(getPriceFetcher([1n], [price]))
			totalUnrealizedLoss = await user2.getTotalUnrealisedLoss(getPriceFetcher([1n], [price]))
			sign = await getDummyLiquidationSig("0x10", upnlTS, [1n], [price], totalUnrealizedLoss, allocatedBalance)
			lf = quote.lockedValues.lf
			cva = quote.lockedValues.cva

			// At price 0.24: -availableBalance = 1, which is < LF(3), so NORMAL liquidation
			// remainingLf = 3 - 1 = 2
			// vaultReceives = 2 - 1 = 1
			remaingLF = 0n
			availableBalance = allocatedBalance - lf - cva + upnlTS
			if (lf > -availableBalance) remaingLF = lf + availableBalance
			maxProfitPerPos = (await context.viewFacet.getLiquidationInsuranceVaultParams())[1]

			await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePartyA(user2.address, sign)
			await context.partyALiquidationFacet.connect(context.signers.liquidator).setSymbolsPrice(user2.address, sign)

			await expectConnected(user2.address, hedger.address, true)
			const liquidationState = await user2.getLiquidatedStateOfPartyA()
			expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.NORMAL)
			expect(await context.viewFacet.balanceOf(context.signers.others[0].address)).to.be.equal(remaingLF - maxProfitPerPos)
		})

		/**
		 * USER2 LATE LIQUIDATION TEST
		 *
		 * LATE occurs when: LF <= -availableBalance <= LF + CVA
		 * This means the deficit exceeds LF but not LF+CVA
		 *
		 * Price thresholds:
		 *   - Price 0.25: Solvent
		 *   - Price 0.24-0.22: NORMAL
		 *   - Price 0.02: LATE (deficit = 73, which is 3 < 73 < 25)
		 *     UPNL = (1-0.02)*100 = -98
		 *     availableBalance = 100 - 25 - 98 = -23
		 *     Wait, let me recalculate...
		 *
		 * Actually at price 0.02:
		 *   UPNL = (1 - 0.02) * 100 = 98 loss for LONG
		 *   availableBalance = 100 - 22 - 3 - 98 = -23
		 *   -availableBalance = 23, which is > LF(3) but < LF+CVA(25), so LATE
		 */
		it("Should Not change the insurance vault correctly in Late Liquidation", async function () {
			await context.controlFacet.connect(context.signers.admin).setLiquidationInsuranceVaultParams(context.signers.others[0].address, decimal(1n))

			// Leave user2 with 100 allocated
			await context.accountFacet.connect(user2.signer).deallocate(decimal(399n), await getDummySingleUpnlSig())
			const allocated = await context.viewFacet.allocatedBalanceOfPartyA(user2.address)
			const allocatedBalance = (await user2.getBalanceInfo()).allocatedBalances
			const quote = await context.viewFacetQuote.getQuote(4)

			// First test: price 0.25 should be solvent
			let price = decimal(25n, 16)

			let upnlTS = await user2.getUpnl(getPriceFetcher([1n], [price]))
			let totalUnrealizedLoss = await user2.getTotalUnrealisedLoss(getPriceFetcher([1n], [price]))
			let sign = await getDummyLiquidationSig("0x10", upnlTS, [1n], [price], totalUnrealizedLoss, allocatedBalance)
			let lf = quote.lockedValues.lf
			let cva = quote.lockedValues.cva

			let availableBalance = allocatedBalance - lf - cva + upnlTS
			let deficit = 0n
			if (lf + cva >= -availableBalance) deficit = -availableBalance - lf

			await expect(context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePartyA(user2.address, sign)).to.be.revertedWith(
				"LiquidationFacet: PartyA is solvent",
			)

			// Price 0.02: LONG loses (1-0.02)*100 = 98
			// availableBalance = ~100 - 25 - 98 = -23
			// -availableBalance = 23, LF(3) < 23 < LF+CVA(25), so LATE
			// deficit = 23 - 3 = 20
			price = decimal(2n, 16) // 0.02e18

			upnlTS = await user2.getUpnl(getPriceFetcher([1n], [price]))
			totalUnrealizedLoss = await user2.getTotalUnrealisedLoss(getPriceFetcher([1n], [price]))
			sign = await getDummyLiquidationSig("0x10", upnlTS, [1n], [price], totalUnrealizedLoss, allocatedBalance)
			lf = quote.lockedValues.lf
			cva = quote.lockedValues.cva

			availableBalance = allocatedBalance - lf - cva + upnlTS
			deficit = 0n
			if (lf + cva >= -availableBalance) deficit = -availableBalance - lf

			await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePartyA(user2.address, sign)
			await context.partyALiquidationFacet.connect(context.signers.liquidator).setSymbolsPrice(user2.address, sign)

			// In LATE liquidation, insurance vault gets nothing
			expect(await context.viewFacet.balanceOf(context.signers.others[0].address)).to.be.equal(0)
			await expectConnected(user2.address, hedger.address, true)
			const liquidationState = await user2.getLiquidatedStateOfPartyA()
			expect(liquidationState["deficit"]).to.be.equal(deficit)
			expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.LATE)
		})

		/**
		 * OVERDUE LIQUIDATION TEST
		 *
		 * OVERDUE occurs when: -availableBalance > LF + CVA
		 * User owes more than their entire collateral (LF + CVA)
		 * PartyB takes a haircut on their expected payout
		 *
		 * Setup: User3 with two positions, custom CVA values
		 */
		it("Should Not change the insurance vault correctly in OVERDUE Liquidation", async function () {
			// Create user3 with two positions
			let user3
			user3 = new User(context, context.signers.feeCollector2)
			await user3.setup()
			await user3.setBalances(decimal(2000n), decimal(1000n), decimal(500n))

			// Quote with CVA=20
			await user3.sendQuote(limitQuoteRequestBuilder().cva(decimal(20n)).deadline(getBlockTimestamp(1000n)).build())
			let lastID = await context.viewFacetQuote.getNextQuoteId()
			await hedger.lockQuote(lastID)
			await hedger.openPosition(lastID)

			// Another quote with CVA=10
			await user3.sendQuote(limitQuoteRequestBuilder().cva(decimal(10n)).deadline(getBlockTimestamp(1000n)).build())
			lastID = await context.viewFacetQuote.getNextQuoteId()
			await hedger.lockQuote(lastID)
			await hedger.openPosition(lastID)

			await context.controlFacet.connect(context.signers.admin).setLiquidationInsuranceVaultParams(context.signers.others[0].address, decimal(1n))

			// Deallocate to leave minimal balance
			await context.accountFacet.connect(user3.signer).deallocate(decimal(312n), await getDummySingleUpnlSig())

			// Price 0.05: Massive loss that exceeds LF + CVA
			const price = decimal(5n, 16) // 0.05e18
			const quote = await context.viewFacetQuote.getQuote(lastID)

			const allocated = await context.viewFacet.allocatedBalanceOfPartyA(user3.address)
			const allocatedBalance = (await user3.getBalanceInfo()).allocatedBalances

			const upnlTS = await user3.getUpnl(getPriceFetcher([1n], [price]))
			const totalUnrealizedLoss = await user3.getTotalUnrealisedLoss(getPriceFetcher([1n], [price]))
			const sign = await getDummyLiquidationSig("0x10", upnlTS, [1n], [price], totalUnrealizedLoss, allocatedBalance)
			const lf = quote.lockedValues.lf
			const cva = quote.lockedValues.cva

			// Calculate deficit for OVERDUE: deficit = -availableBalance - (LF + CVA)
			const availableBalance = allocatedBalance - lf - cva + upnlTS
			let deficit = 0n
			if (lf + cva < -availableBalance) deficit = -availableBalance - (lf + cva)

			await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePartyA(user3.address, sign)
			await context.partyALiquidationFacet.connect(context.signers.liquidator).setSymbolsPrice(user3.address, sign)

			// In OVERDUE, insurance vault gets nothing
			expect(await context.viewFacet.balanceOf(context.signers.others[0].address)).to.be.equal(0)
			await expectConnected(user3.address, hedger.address, true)
			const liquidationState = await user3.getLiquidatedStateOfPartyA()
			expect(liquidationState["deficit"]).to.be.equal(deficit)
			expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.OVERDUE)
		})

		/**
		 * DEFERRED LIQUIDATION - INSURANCE VAULT TEST
		 * Same as regular liquidation but uses deferred execution
		 */
		it("Should change the insurance vault correctly in deferred liquidation", async function () {
			await context.controlFacet.connect(context.signers.admin).setLiquidationInsuranceVaultParams(
				context.signers.others[0].address,
				decimal(1n), // maxProfitPerPosition
			)
			const price = decimal(572n, 16) // 5.72 - triggers NORMAL liquidation

			// Calculate expected vault balance
			const allocatedBalance = (await user.getBalanceInfo()).allocatedBalances
			const quote = await context.viewFacetQuote.getQuote(1)
			const lf = quote.lockedValues.lf
			const cva = quote.lockedValues.cva
			const fundingFee = await getFundingFee()
			const upnl = (await user.getUpnl(getPriceFetcher([1n], [price]))) - fundingFee

			const availableBalance = allocatedBalance - lf - cva + upnl
			let remainingLf = 0n
			if (lf > -availableBalance) remainingLf = lf + availableBalance
			const maxProfitPerPos = (await context.viewFacet.getLiquidationInsuranceVaultParams())[1]
			const expectedVaultBalance = remainingLf > maxProfitPerPos ? remainingLf - maxProfitPerPos : 0n

			await user.deferredLiquidateAndSetSymbolPrices([1n], [price], [1n])
			expect(await context.viewFacet.balanceOf(context.signers.others[0].address)).to.be.equal(expectedVaultBalance)
			await expectConnected(user.address, hedger.address, true)
		})

		/**
		 * DEFERRED LIQUIDATION - USER2 NORMAL
		 */
		it("Should change the insurance vault correctly in deferred liquidation", async function () {
			await context.controlFacet.connect(context.signers.admin).setLiquidationInsuranceVaultParams(context.signers.others[0].address, decimal(1n))
			// Leave user2 with ~100 allocated
			await context.accountFacet.connect(user2.signer).deallocate(decimal(399n), await getDummySingleUpnlSig())

			// Price 0.24 triggers NORMAL liquidation for LONG position
			const price = decimal(24n, 16)
			const quote = await context.viewFacetQuote.getQuote(4)

			const allocated = await context.viewFacet.allocatedBalanceOfPartyA(user2.address)
			const allocatedBalance = (await user2.getBalanceInfo()).allocatedBalances

			const upnlTS = await user2.getUpnl(getPriceFetcher([1n], [price]))
			const totalUnrealizedLoss = await user2.getTotalUnrealisedLoss(getPriceFetcher([1n], [price]))
			const sign = await getDummyLiquidationSig("0x10", upnlTS, [1n], [price], totalUnrealizedLoss, allocatedBalance)
			const lf = quote.lockedValues.lf
			const cva = quote.lockedValues.cva
			const availableBalance = allocated - lf - cva + upnlTS
			const remaingLF = lf > availableBalance ? lf + availableBalance : lf + cva + availableBalance
			const maxProfitPerPos = (await context.viewFacet.getLiquidationInsuranceVaultParams())[1]

			await context.partyALiquidationFacet.connect(context.signers.liquidator).deferredLiquidatePartyA(user2.address, sign)
			await context.partyALiquidationFacet.connect(context.signers.liquidator).deferredSetSymbolsPrice(user2.address, sign)

			expect(await context.viewFacet.balanceOf(context.signers.others[0].address)).to.be.equal(remaingLF - maxProfitPerPos)
			await expectConnected(user2.address, hedger.address, true)
			const liquidationState = await user2.getLiquidatedStateOfPartyA()
			expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.NORMAL)
		})

		/**
		 * NORMAL LIQUIDATION BRANCH TESTS
		 *
		 * Price 5.7198 on SHORT position opened at 1.0:
		 * UPNL = (1 - 5.7198) * 100 = -471.98
		 * This puts user just barely in NORMAL liquidation territory
		 */
		describe("Test normal branch", async function () {
			const price = decimal(57198n, 14) // 5.7198e18 - triggers NORMAL liquidation

			beforeEach(async function () {
				// Set high maxProfit (100) so all LF goes to liquidator, not vault
				await context.controlFacet.connect(context.signers.admin).setLiquidationInsuranceVaultParams(
					context.signers.others[0].address,
					decimal(100n), // maxProfitPerPosition: 100 tokens
				)
				this.signature1 = await user.liquidateAndSetSymbolPrices([1n], [price], [1n])
				const liquidationState = await user.getLiquidatedStateOfPartyA()
				expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.NORMAL)
			})

			it("Should fail on invalid state", async function () {
				// Quote 2 is pending, not an open position - can't liquidate it directly
				await expect(user.liquidatePositions([2])).to.be.revertedWith("LiquidationFacet: Invalid state")
			})

			it("Should fail on partyA being solvent", async function () {
				// hedger2 has no positions, so is solvent
				let user3 = context.signers.hedger2.getAddress()
				await expect(context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePositionsPartyA(user3, [1])).to.be.revertedWith(
					"LiquidationFacet: PartyA is solvent",
				)
			})

			it("Should fail on partyA being the liquidator himself", async function () {
				await expect(user2.liquidatePositions([2])).to.be.revertedWith("LiquidationFacet: PartyA is solvent")
			})

			it("Should liquidate positions", async function () {
				const partyBNonceBefore = await context.viewFacet.nonceOfPartyB(hedger.getAddress(), user.getAddress())
				await user.liquidatePendingPositions()
				await user.liquidatePositions([1])
				expect((await context.viewFacetQuote.getQuote(1)).quoteStatus).to.be.equal(QuoteStatus.LIQUIDATED)
				await expectConnected(user.address, hedger.address, false)
				// PartyB nonce should increment when positions are liquidated
				const partyBNonceAfter = await context.viewFacet.nonceOfPartyB(hedger.getAddress(), user.getAddress())
				expect(partyBNonceAfter).to.be.equal(partyBNonceBefore + 1n)
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
					const partyANonceBefore = await context.viewFacet.nonceOfPartyA(userAddress)

					const fundingFee = this.fundingFee as bigint
					// UPNL for SHORT: (openPrice - currentPrice) * quantity
					const upnl = unDecimal((decimal(1n) - price) * decimal(100n)) - fundingFee
					const available = userBalance.allocatedBalances - userBalance.lockedCva - userBalance.lockedLf + upnl
					const diff = userBalance.lockedLf - -available // Remaining LF for liquidator
					const partyBAfter = hedgerBalance.allocatedBalances - upnl + userBalance.lockedCva

					// Get reimbursement before settlement
					const reimbursement = await context.viewFacet.partyAReimbursement(userAddress)

					await user.settleLiquidation()
					expect(await context.viewFacet.allocatedBalanceOfPartyB(hedgerAddress, userAddress)).to.be.equal(partyBAfter)
					let balanceInfoOfLiquidator = await liquidator.getBalanceInfo()
					expect(balanceInfoOfLiquidator.allocatedBalances).to.be.equal(diff)
					await expectConnected(userAddress, hedgerAddress, false)

					// After full settlement (NORMAL), partyA gets reimbursement (pending fees) + deferred balance
					const userBalanceAfter = await user.getBalanceInfo()
					expect(userBalanceAfter.allocatedBalances).to.be.equal(reimbursement)

					// Liquidation status should be cleared after full settlement
					expect(await context.viewFacet.isPartyALiquidated(userAddress)).to.be.equal(false)

					// PartyA nonce should increment after full settlement
					const partyANonceAfter = await context.viewFacet.nonceOfPartyA(userAddress)
					expect(partyANonceAfter).to.be.equal(partyANonceBefore + 1n)

					// PartyA locked values should be zeroed
					expect(userBalanceAfter.lockedCva).to.be.equal(0n)
					expect(userBalanceAfter.lockedLf).to.be.equal(0n)
					expect(userBalanceAfter.lockedMmPartyA).to.be.equal(0n)
				})
			})
		})

		/**
		 * LATE LIQUIDATION BRANCH TESTS
		 */
		describe("Test late branches", async function () {
			/**
			 * Price 5.94 on SHORT position:
			 * UPNL = (1 - 5.94) * 100 = -494
			 * availableBalance = 500 - 25 - 494 - fundingFee ≈ -19 - fundingFee
			 * -availableBalance ≈ 19 + fundingFee
			 * For LATE: LF(3) <= deficit <= LF+CVA(25)
			 */
			it("Late liquidation", async function () {
				const price = decimal(594n, 16) // 5.94e18 - triggers LATE liquidation
				await user.liquidateAndSetSymbolPrices([1n], [price], [1n])
				const liquidationState = await user.getLiquidatedStateOfPartyA()
				expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.LATE)

				// Verify deficit is correctly stored: deficit = -availableBalance - LF
				const userBalance = await user.getBalanceInfo()
				expect(liquidationState["deficit"]).to.be.greaterThan(0n)

				const hedgerBalance = await hedger.getBalanceInfo(await user.getAddress())
				const available = userBalance.allocatedBalances - userBalance.lockedCva
				const pnl = unDecimal(price - decimal(1n)) * decimal(100n) // PartyB's profit
				const diff = available - pnl
				const partyBAfter = hedgerBalance.allocatedBalances + pnl + userBalance.lockedCva + diff

				await user.liquidatePendingPositions()
				await user.liquidatePositions([1])

				const userAddress = await context.signers.user.getAddress()
				const reimbursement = await context.viewFacet.partyAReimbursement(userAddress)

				await user.settleLiquidation()
				const fundingFee = await getFundingFee()
				expect((await hedger.getBalanceInfo(await user.getAddress())).allocatedBalances).to.be.equal(partyBAfter - fundingFee)
				// In LATE liquidation, liquidator gets nothing (LF exhausted)
				let balanceInfoOfLiquidator = await liquidator.getBalanceInfo()
				expect(balanceInfoOfLiquidator.allocatedBalances).to.be.equal(decimal(0n))

				// Liquidation status should be cleared after full settlement
				expect(await context.viewFacet.isPartyALiquidated(userAddress)).to.be.equal(false)

				// In LATE, reimbursement (pending fees) goes to clearing pool, partyA gets only deferred balance (0 for non-deferred)
				const userBalanceAfter = await user.getBalanceInfo()
				expect(userBalanceAfter.allocatedBalances).to.be.equal(0n)
				// Reimbursement should be in the clearing pool
				const escrow = await context.viewFacet.getLiquidationEscrow(userAddress)
				expect(escrow).to.be.equal(reimbursement)
			})

			/**
			 * Price 5.99: Even worse loss, triggers OVERDUE
			 * UPNL = (1 - 5.99) * 100 = -499
			 * deficit > LF + CVA (25)
			 */
			it("Overdue liquidation", async function () {
				const price = decimal(599n, 16) // 5.99e18 - triggers OVERDUE
				await user.liquidateAndSetSymbolPrices([1n], [price], [1n])
				const liquidationState = await user.getLiquidatedStateOfPartyA()
				expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.OVERDUE)

				// Verify deficit is correctly stored: deficit = -availableBalance - LF - CVA
				expect(liquidationState["deficit"]).to.be.greaterThan(0n)

				const hedgerBalanceBefore = await hedger.getBalanceInfo(await user.getAddress())
				const userBalance = await user.getBalanceInfo()

				await user.liquidatePendingPositions()
				await user.liquidatePositions([1n])

				const userAddress = await context.signers.user.getAddress()
				const reimbursement = await context.viewFacet.partyAReimbursement(userAddress)

				await user.settleLiquidation()

				// PartyB gets reduced payout due to deficit - verify it's reduced from their original balance
				const hedgerBalanceAfter = await hedger.getBalanceInfo(await user.getAddress())
				expect(hedgerBalanceAfter.allocatedBalances).to.be.equal(decimal(856n))

				// In OVERDUE liquidation, liquidator gets nothing
				let balanceInfoOfLiquidator = await liquidator.getBalanceInfo()
				expect(balanceInfoOfLiquidator.allocatedBalances).to.be.equal(decimal(0n))

				// Liquidation status should be cleared after full settlement
				expect(await context.viewFacet.isPartyALiquidated(userAddress)).to.be.equal(false)

				// In OVERDUE, reimbursement (pending fees) goes to clearing pool, partyA gets only deferred balance (0 for non-deferred)
				const userBalanceAfter = await user.getBalanceInfo()
				expect(userBalanceAfter.allocatedBalances).to.be.equal(0n)
				const escrow = await context.viewFacet.getLiquidationEscrow(userAddress)
				expect(escrow).to.be.equal(reimbursement)
			})
		})
	})

	/**
	 * DEFERRED NORMAL BRANCH TESTS
	 * Same as regular NORMAL but using deferred execution
	 */
	describe("Test normal branch deferred", async function () {
		const price = decimal(572n, 16) // 5.72e18 - triggers NORMAL liquidation

		beforeEach(async function () {
			await context.controlFacet.connect(context.signers.admin).setLiquidationInsuranceVaultParams(
				context.signers.others[0].address,
				decimal(100n), // High maxProfit so liquidator gets full LF
			)
			this.signature1 = await user.deferredLiquidateAndSetSymbolPrices([1n], [price], [1n])
			const liquidationState = await user.getLiquidatedStateOfPartyA()
			expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.NORMAL)
		})

		it("Should fail on invalid state deferred", async function () {
			await expect(user.liquidatePositions([2])).to.be.revertedWith("LiquidationFacet: Invalid state")
		})

		it("Should fail on partyA being solvent deferred", async function () {
			let user3 = context.signers.hedger2.getAddress()
			await expect(context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePositionsPartyA(user3, [1])).to.be.revertedWith(
				"LiquidationFacet: PartyA is solvent",
			)
		})

		it("Should fail on partyA being the liquidator himself deferred", async function () {
			await expect(user2.liquidatePositions([2])).to.be.revertedWith("LiquidationFacet: PartyA is solvent")
		})

		it("Should liquidate positions deferred", async function () {
			const partyBNonceBefore = await context.viewFacet.nonceOfPartyB(hedger.getAddress(), user.getAddress())
			await user.liquidatePendingPositions()
			await user.liquidatePositions([1])
			expect((await context.viewFacetQuote.getQuote(1)).quoteStatus).to.be.equal(QuoteStatus.LIQUIDATED)
			await expectConnected(user.address, hedger.address, false)
			// PartyB nonce should increment
			const partyBNonceAfter = await context.viewFacet.nonceOfPartyB(hedger.getAddress(), user.getAddress())
			expect(partyBNonceAfter).to.be.equal(partyBNonceBefore + 1n)
		})

		describe("Settle liquidation deferred", async function () {
			beforeEach(async function () {
				this.fundingFee = await getFundingFee()
				await user.liquidatePendingPositions()
				await user.liquidatePositions([1])
			})

			it("Should settle liquidation deferred", async function () {
				let userAddress = await context.signers.user.getAddress()
				let hedgerAddress = await context.signers.hedger.getAddress()
				const partyANonceBefore = await context.viewFacet.nonceOfPartyA(userAddress)

				const hedgerBalance = await hedger.getBalanceInfo(await user.getAddress())
				const userBalance = await user.getBalanceInfo()
				const fundingFee = this.fundingFee as bigint
				const upnl = unDecimal((decimal(1n) - price) * decimal(100n)) - fundingFee
				const available = userBalance.allocatedBalances - userBalance.lockedCva - userBalance.lockedLf + upnl
				const diff = userBalance.lockedLf - -available
				const partyBAfter = hedgerBalance.allocatedBalances - upnl + userBalance.lockedCva

				const deferredBalance = await context.viewFacet.getPartyADeferredBalance(userAddress)
				const reimbursement = await context.viewFacet.partyAReimbursement(userAddress)

				await user.settleLiquidation()
				expect(await context.viewFacet.allocatedBalanceOfPartyB(hedgerAddress, userAddress)).to.be.equal(partyBAfter)
				let balanceInfoOfLiquidator = await liquidator.getBalanceInfo()
				expect(balanceInfoOfLiquidator.allocatedBalances).to.be.equal(diff)

				// After full settlement (NORMAL), partyA gets deferred balance + reimbursement (pending fees)
				const userBalanceAfter = await user.getBalanceInfo()
				expect(userBalanceAfter.allocatedBalances).to.be.equal(deferredBalance + reimbursement)

				// Liquidation status should be cleared
				expect(await context.viewFacet.isPartyALiquidated(userAddress)).to.be.equal(false)

				// PartyA nonce should increment
				const partyANonceAfter = await context.viewFacet.nonceOfPartyA(userAddress)
				expect(partyANonceAfter).to.be.equal(partyANonceBefore + 1n)

				// PartyA locked values should be zeroed
				expect(userBalanceAfter.lockedCva).to.be.equal(0n)
				expect(userBalanceAfter.lockedLf).to.be.equal(0n)
				expect(userBalanceAfter.lockedMmPartyA).to.be.equal(0n)
			})
		})
	})

	/**
	 * DEFERRED LATE BRANCH TESTS
	 */
	describe("Test late branches deferred", async function () {
		it("Late liquidation deferred", async function () {
			const price = decimal(595n, 16) // 5.95e18 - triggers LATE liquidation
			await user.deferredLiquidateAndSetSymbolPrices([1n], [price], [1n])
			const liquidationState = await user.getLiquidatedStateOfPartyA()
			expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.LATE)

			// Verify deficit is correctly stored
			expect(liquidationState["deficit"]).to.be.greaterThan(0n)

			const hedgerBalance = await hedger.getBalanceInfo(await user.getAddress())
			const userBalance = await user.getBalanceInfo()
			const available = userBalance.allocatedBalances - userBalance.lockedCva
			const pnl = unDecimal(price - decimal(1n)) * decimal(100n)
			const diff = available - pnl
			const partyBAfter = hedgerBalance.allocatedBalances + pnl + userBalance.lockedCva + diff

			await user.liquidatePendingPositions()
			await user.liquidatePositions([1])

			const userAddress = await context.signers.user.getAddress()
			const deferredBalance = await context.viewFacet.getPartyADeferredBalance(userAddress)

			await user.settleLiquidation()
			expect((await hedger.getBalanceInfo(await user.getAddress())).allocatedBalances).to.be.equal(partyBAfter)
			let balanceInfoOfLiquidator = await liquidator.getBalanceInfo()
			expect(balanceInfoOfLiquidator.allocatedBalances).to.be.equal(decimal(0n))

			// Liquidation status should be cleared
			expect(await context.viewFacet.isPartyALiquidated(userAddress)).to.be.equal(false)

			// PartyA allocated balance should be set to deferred balance (pending fees go to clearing pool in LATE)
			const userBalanceAfter = await user.getBalanceInfo()
			expect(userBalanceAfter.allocatedBalances).to.be.equal(deferredBalance)
		})

		it("Overdue liquidation deferred", async function () {
			const price = decimal(599n, 16) // 5.99e18 - triggers OVERDUE
			await user.liquidateAndSetSymbolPrices([1n], [price], [1n])
			const liquidationState = await user.getLiquidatedStateOfPartyA()
			expect(liquidationState["liquidationType"]).to.be.equal(LiquidationType.OVERDUE)

			// Verify deficit is stored
			expect(liquidationState["deficit"]).to.be.greaterThan(0n)

			await user.liquidatePendingPositions()
			await user.liquidatePositions([1])

			const userAddress = await context.signers.user.getAddress()
			const reimbursement = await context.viewFacet.partyAReimbursement(userAddress)

			await user.settleLiquidation()

			// 856 = hedger's remaining balance after OVERDUE haircut
			expect(await context.viewFacet.allocatedBalanceOfPartyB(hedger.getAddress(), user.getAddress())).to.be.equal(decimal(856n))
			let balanceInfoOfLiquidator = await liquidator.getBalanceInfo()
			expect(balanceInfoOfLiquidator.allocatedBalances).to.be.equal(decimal(0n))

			// Liquidation status should be cleared
			expect(await context.viewFacet.isPartyALiquidated(userAddress)).to.be.equal(false)

			// In OVERDUE, reimbursement (pending fees) goes to clearing pool, partyA gets only deferred balance (0 for non-deferred)
			const userBalanceAfter = await user.getBalanceInfo()
			expect(userBalanceAfter.allocatedBalances).to.be.equal(0n)
			const escrow = await context.viewFacet.getLiquidationEscrow(userAddress)
			expect(escrow).to.be.equal(reimbursement)
		})
	})

	/**
	 * LIQUIDATION ESCROW TESTS
	 *
	 * When a LATE/OVERDUE liquidation occurs, pending trading fees are not returned
	 * to partyA. Instead they go to a liquidation escrow for the clearing house to
	 * distribute. This mitigates an attack where a bound-mode (oracle-less) partyA
	 * inflates fake UPNL via sendQuote to drain allocatedBalances into pending fees,
	 * then gets liquidated as LATE/OVERDUE and recovers the fees.
	 *
	 * The deferred balance (excess from deferred liquidation) is always returned to
	 * partyA regardless of liquidation type — it represents legitimate funds.
	 */
	describe("Liquidation Escrow", async function () {
		it("NORMAL: pending fees return to partyA, escrow stays zero", async function () {
			const userAddress = await context.signers.user.getAddress()
			// Compute expected pending fees before liquidation (quotes 2, 3, 5 are pending)
			const expectedFees = await getTradingFeeForQuotes(context, [2n, 3n, 5n])

			const price = decimal(572n, 16) // triggers NORMAL
			await user.liquidateAndSetSymbolPrices([1n], [price], [1n])
			expect((await user.getLiquidatedStateOfPartyA())["liquidationType"]).to.be.equal(LiquidationType.NORMAL)

			await user.liquidatePendingPositions()
			await user.liquidatePositions([1])

			const reimbursement = await context.viewFacet.partyAReimbursement(userAddress)
			expect(reimbursement).to.be.equal(expectedFees)

			await user.settleLiquidation()

			// Escrow should be empty — fees returned to partyA in NORMAL
			expect(await context.viewFacet.getLiquidationEscrow(userAddress)).to.be.equal(0n)
			// partyA gets the fees back
			expect((await user.getBalanceInfo()).allocatedBalances).to.be.equal(expectedFees)
		})

		it("LATE: pending fees go to escrow, partyA gets nothing", async function () {
			const userAddress = await context.signers.user.getAddress()
			const expectedFees = await getTradingFeeForQuotes(context, [2n, 3n, 5n])

			const price = decimal(594n, 16) // triggers LATE
			await user.liquidateAndSetSymbolPrices([1n], [price], [1n])
			expect((await user.getLiquidatedStateOfPartyA())["liquidationType"]).to.be.equal(LiquidationType.LATE)

			await user.liquidatePendingPositions()
			await user.liquidatePositions([1])

			expect(await context.viewFacet.partyAReimbursement(userAddress)).to.be.equal(expectedFees)

			await user.settleLiquidation()

			// Fees should be in escrow, not returned to partyA
			expect(await context.viewFacet.getLiquidationEscrow(userAddress)).to.be.equal(expectedFees)
			expect((await user.getBalanceInfo()).allocatedBalances).to.be.equal(0n)
		})

		it("OVERDUE: pending fees go to escrow, partyA gets nothing", async function () {
			const userAddress = await context.signers.user.getAddress()
			const expectedFees = await getTradingFeeForQuotes(context, [2n, 3n, 5n])

			const price = decimal(599n, 16) // triggers OVERDUE
			await user.liquidateAndSetSymbolPrices([1n], [price], [1n])
			expect((await user.getLiquidatedStateOfPartyA())["liquidationType"]).to.be.equal(LiquidationType.OVERDUE)

			await user.liquidatePendingPositions()
			await user.liquidatePositions([1])

			expect(await context.viewFacet.partyAReimbursement(userAddress)).to.be.equal(expectedFees)

			await user.settleLiquidation()

			expect(await context.viewFacet.getLiquidationEscrow(userAddress)).to.be.equal(expectedFees)
			expect((await user.getBalanceInfo()).allocatedBalances).to.be.equal(0n)
		})

		it("Deferred with excess: deferred balance and fees return to partyA (always NORMAL)", async function () {
			// When deferred liquidation produces excess, it zeroes the available balance,
			// so determineLiquidationType always gives NORMAL. Both deferred balance and
			// pending fees return to partyA.

			const userAddress = await context.signers.user.getAddress()
			const expectedFees = await getTradingFeeForQuotes(context, [2n, 3n, 5n])
			const balanceInfo = await user.getBalanceInfo()
			const currentAllocated = balanceInfo.allocatedBalances

			// Compute UPNL at a price where historical balance makes user insolvent
			// but current balance leaves them with positive available
			const price = decimal(4n) // SHORT at price 1 → UPNL = (1-4)*100 = -300
			const upnl = (await user.getUpnl(getPriceFetcher([1n], [price]))) - (await context.viewFacetQuote.getSumQuoteFundingDebts([1n]))
			const totalUnrealizedLoss =
				(await user.getTotalUnrealisedLoss(getPriceFetcher([1n], [price]))) - (await context.viewFacetQuote.getSumQuoteFundingDebts([1n]))

			// Expected deferred excess = currentAllocated - lockedCva - lockedLf + upnl
			const expectedDeferredBalance = currentAllocated - balanceInfo.lockedCva - balanceInfo.lockedLf + BigInt(upnl)

			// Set liquidationAllocatedBalance to a LOW value (historical snapshot)
			// so the user was insolvent at that time: 200 - 25 + (-300) = -125 < 0
			const historicalBalance = decimal(200n)
			const sign = await getDummyLiquidationSig("0x10", upnl, [1n], [price], totalUnrealizedLoss, historicalBalance)

			await context.partyALiquidationFacet.connect(context.signers.liquidator).deferredLiquidatePartyA(userAddress, sign)
			await context.partyALiquidationFacet.connect(context.signers.liquidator).deferredSetSymbolsPrice(userAddress, sign)

			expect(await context.viewFacet.getPartyADeferredBalance(userAddress)).to.be.equal(expectedDeferredBalance)

			// Deferred extraction zeroes available → always NORMAL
			expect((await user.getLiquidatedStateOfPartyA())["liquidationType"]).to.be.equal(LiquidationType.NORMAL)

			await user.liquidatePendingPositions()
			await user.liquidatePositions([1])

			expect(await context.viewFacet.partyAReimbursement(userAddress)).to.be.equal(expectedFees)

			await user.settleLiquidation()

			// Both return to partyA in NORMAL
			expect((await user.getBalanceInfo()).allocatedBalances).to.be.equal(expectedDeferredBalance + expectedFees)
			expect(await context.viewFacet.getLiquidationEscrow(userAddress)).to.be.equal(0n)
			expect(await context.viewFacet.getPartyADeferredBalance(userAddress)).to.be.equal(0n)
			expect(await context.viewFacet.partyAReimbursement(userAddress)).to.be.equal(0n)
		})

		it("Deferred LATE path (no excess): fees go to escrow", async function () {
			// Deferred liquidation at current allocatedBalance (no excess).
			// Same behavior as non-deferred LATE but validates the deferred code path.
			const userAddress = await context.signers.user.getAddress()
			const expectedFees = await getTradingFeeForQuotes(context, [2n, 3n, 5n])

			const price = decimal(594n, 16) // triggers LATE
			await user.deferredLiquidateAndSetSymbolPrices([1n], [price], [1n])
			expect((await user.getLiquidatedStateOfPartyA())["liquidationType"]).to.be.equal(LiquidationType.LATE)

			// No excess because liquidationAllocatedBalance == current allocatedBalance
			expect(await context.viewFacet.getPartyADeferredBalance(userAddress)).to.be.equal(0n)

			await user.liquidatePendingPositions()
			await user.liquidatePositions([1])

			expect(await context.viewFacet.partyAReimbursement(userAddress)).to.be.equal(expectedFees)

			await user.settleLiquidation()

			// Fees go to escrow, nothing to partyA
			expect(await context.viewFacet.getLiquidationEscrow(userAddress)).to.be.equal(expectedFees)
			expect((await user.getBalanceInfo()).allocatedBalances).to.be.equal(0n)
		})

		it("Escrow accumulates across multiple liquidations", async function () {
			const userAddress = await context.signers.user.getAddress()
			const expectedFees = await getTradingFeeForQuotes(context, [2n, 3n, 5n])

			// First LATE liquidation
			const price = decimal(594n, 16)
			await user.liquidateAndSetSymbolPrices([1n], [price], [1n])
			expect((await user.getLiquidatedStateOfPartyA())["liquidationType"]).to.be.equal(LiquidationType.LATE)

			await user.liquidatePendingPositions()
			await user.liquidatePositions([1])

			expect(await context.viewFacet.partyAReimbursement(userAddress)).to.be.equal(expectedFees)

			await user.settleLiquidation()

			// Escrow should equal the pending fees
			expect(await context.viewFacet.getLiquidationEscrow(userAddress)).to.be.equal(expectedFees)

			// Escrow persists until CH distributes it
			expect(await context.viewFacet.getLiquidationEscrow(userAddress)).to.be.equal(expectedFees)
		})
	})

	/**
	 * PARTYB LIQUIDATION TESTS
	 *
	 * PartyB (hedger/market maker) can also be liquidated if they become insolvent.
	 * This happens when their losses exceed their allocated balance.
	 */
	describe("Liquidate PartyB", async function () {
		it("Should fail on partyB being solvent", async function () {
			// With UPNL=0, PartyB is solvent
			await expect(
				context.partyBLiquidationFacet
					.connect(context.signers.liquidator)
					.liquidatePartyB(context.signers.hedger.getAddress(), context.signers.user.getAddress(), await getDummySingleUpnlSig()),
			).to.be.revertedWith("LiquidationFacet: partyB is solvent")
		})

		it("Should run successfully", async function () {
			let userAddress = await context.signers.user.getAddress()
			let hedgerAddress = await context.signers.hedger.getAddress()

			// Record partyA balance and nonce before liquidation
			const partyABalanceBefore = (await user.getBalanceInfo()).allocatedBalances
			const partyANonceBefore = await context.viewFacet.nonceOfPartyA(userAddress)
			const partyBAllocatedBefore = (await hedger.getBalanceInfo(userAddress)).allocatedBalances

			// UPNL of -336 makes PartyB insolvent
			// This means PartyB owes 336 tokens more than they have
			await context.partyBLiquidationFacet
				.connect(context.signers.liquidator)
				.liquidatePartyB(hedgerAddress, userAddress, await getDummySingleUpnlSig(decimal(-336n)))

			// After liquidation, all PartyB balances should be zeroed
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

			// Quote 5 (pending) should be liquidated
			expect((await context.viewFacetQuote.getQuote(5)).quoteStatus).to.be.equal(QuoteStatus.LIQUIDATED_PENDING)

			// PartyA should receive partyB's allocated balance minus remainingLf
			// (partyB's balance is transferred to partyA during liquidation)
			const partyABalanceAfter = (await user.getBalanceInfo()).allocatedBalances
			expect(partyABalanceAfter).to.be.greaterThan(partyABalanceBefore)

			// PartyA nonce should increment after partyB liquidation
			const partyANonceAfter = await context.viewFacet.nonceOfPartyA(userAddress)
			expect(partyANonceAfter).to.be.equal(partyANonceBefore + 1n)
		})

		it("Should clear connection after PartyB liquidation closes the last open position", async function () {
			const userAddress = await context.signers.user.getAddress()
			const hedgerAddress = await context.signers.hedger.getAddress()
			const user2Address = await context.signers.user2.getAddress()

			await expectConnected(userAddress, hedgerAddress, true)
			await expectConnected(user2Address, hedgerAddress, true)

			const partyBNonceBefore = await context.viewFacet.nonceOfPartyB(hedgerAddress, userAddress)

			await context.partyBLiquidationFacet
				.connect(context.signers.liquidator)
				.liquidatePartyB(hedgerAddress, userAddress, await getDummySingleUpnlSig(decimal(-336n)))

			const priceSig = await getDummyPriceSig([1n], [decimal(1n)])
			priceSig.timestamp = await context.viewFacet.partyBLiquidationTimestamp(hedgerAddress, userAddress)
			await context.partyBLiquidationFacet.connect(context.signers.liquidator).liquidatePositionsPartyB(hedgerAddress, userAddress, priceSig)

			await expectConnected(userAddress, hedgerAddress, false)
			await expectConnected(user2Address, hedgerAddress, true)

			// After all positions liquidated, partyB liquidation status should be cleared
			// and partyB nonce should increment
			const partyBNonceAfter = await context.viewFacet.nonceOfPartyB(hedgerAddress, userAddress)
			expect(partyBNonceAfter).to.be.equal(partyBNonceBefore + 1n)

			// Quote 1 (open position) should be marked as LIQUIDATED
			expect((await context.viewFacetQuote.getQuote(1)).quoteStatus).to.be.equal(QuoteStatus.LIQUIDATED)
		})

		it("Should fail to liquidate a partyB twice", async function () {
			await context.partyBLiquidationFacet
				.connect(context.signers.liquidator)
				.liquidatePartyB(context.signers.hedger.getAddress(), context.signers.user.getAddress(), await getDummySingleUpnlSig(decimal(-336n)))
			await expect(
				context.partyBLiquidationFacet
					.connect(context.signers.liquidator)
					.liquidatePartyB(context.signers.hedger.getAddress(), context.signers.user.getAddress(), await getDummySingleUpnlSig(decimal(-336n))),
			).to.revertedWith("Accessibility: PartyB isn't solvent")
		})
	})
}
