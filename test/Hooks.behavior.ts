import { loadFixture } from "@nomicfoundation/hardhat-network-helpers"
import { expect } from "chai"
import { ethers } from "hardhat"

import { initializeFixture } from "./Initialize.fixture"
import { Hedger } from "./models/Hedger"
import { RunContext } from "./models/RunContext"
import { User } from "./models/User"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest"
import { decimal, getQuoteQuantity } from "./utils/Common"
import { PositionType } from "./models/Enums"

export function shouldBehaveLikeHooks(): void {
  let user: User, hedger: Hedger
  let context: RunContext

  beforeEach(async function () {
    context = await loadFixture(initializeFixture)

    this.user_allocated = decimal(500n)
    this.hedger_allocated = decimal(4000n)

    user = new User(context, context.signers.user)
    await user.setup()
    await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

    hedger = new Hedger(context, context.signers.hedger)
    await hedger.setup()
    await hedger.setBalances(this.hedger_allocated, this.hedger_allocated)
  })

  describe("setHook", () => {
    it("Should set affiliate-specific hook by SETTER_ROLE and record via view", async function () {
      const MockHook = await ethers.getContractFactory("MockHook")
      const mockHook = await MockHook.deploy()
      await mockHook.waitForDeployment()

      // Only SETTER_ROLE can call setHook
      await expect(
        context.controlFacet
          .connect(context.signers.user)
          .registerHook(context.accountManager, await mockHook.getAddress()),
      ).to.be.revertedWith("Accessibility: Must has role")

      // Admin has SETTER_ROLE in fixture
      await expect(
        context.controlFacet
          .connect(context.signers.admin)
          .registerHook(context.accountManager, await mockHook.getAddress()),
      ).to.not.reverted

      const current = await context.viewFacet.getAffiliateHook(context.accountManager)
      expect(current).to.equal(await mockHook.getAddress())
    })

    it("Should set system-wide hook (affiliate = address(0))", async function () {
      const MockHook = await ethers.getContractFactory("MockHook")
      const mockHook = await MockHook.deploy()
      await mockHook.waitForDeployment()

      await expect(
        context.controlFacet
          .connect(context.signers.admin)
          .registerHook(ethers.ZeroAddress, await mockHook.getAddress()),
      ).to.not.reverted

      const current = await context.viewFacet.getAffiliateHook(ethers.ZeroAddress)
      expect(current).to.equal(await mockHook.getAddress())
    })

    it("Should allow clearing a hook by setting to zero address", async function () {
      const MockHook = await ethers.getContractFactory("MockHook")
      const mockHook = await MockHook.deploy()
      await mockHook.waitForDeployment()

      await context.controlFacet
        .connect(context.signers.admin)
        .registerHook(context.accountManager, await mockHook.getAddress())

      await context.controlFacet
        .connect(context.signers.admin)
        .registerHook(context.accountManager, ethers.ZeroAddress)

      const current = await context.viewFacet.getAffiliateHook(context.accountManager)
      expect(current).to.equal(ethers.ZeroAddress)
    })
  })

  describe("hook callbacks on open/close", () => {
    it("Should call affiliate hook and system hook on openPosition; swallow hook revert", async function () {
      const MockHook = await ethers.getContractFactory("MockHook")
      const affiliateHook = await MockHook.deploy()
      await affiliateHook.waitForDeployment()
      const systemHook = await MockHook.deploy()
      await systemHook.waitForDeployment()

      // Configure hooks
      await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await affiliateHook.getAddress())
      await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await systemHook.getAddress())

      // Prepare a LONG quote with this affiliate
      await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
      await hedger.lockQuote(1)

      const openPrice = decimal(1n)
      const filledAmount = await getQuoteQuantity(context, 1n)

      // Make affiliate hook revert to ensure it's swallowed
      await affiliateHook.setRevertOnOpen(true, "affiliate open revert")

      // Open position
      await expect(
        hedger.openPosition(
          1,
          limitOpenRequestBuilder()
            .filledAmount(filledAmount)
            .openPrice(openPrice)
            .price(decimal(1n, 17))
            .build(),
        ),
      ).to.not.reverted

      // Verify system hook received the call
      const [oq, oamount, oprice, opartyA, opartyB, ocalls] = await systemHook.getLastOpenCall()
      expect(oq).to.equal(1n)
      expect(oamount).to.equal(filledAmount)
      expect(oprice).to.equal(openPrice)
      const q = await context.viewFacetQuote.getQuote(1)
      expect(opartyA).to.equal(q.partyA)
      expect(opartyB).to.equal(q.partyB)
      expect(ocalls).to.equal(1n)

      // Affiliate hook reverted; its openCallCount should be 0 and last data default (zeros)
      const [, , , , , affiliateOpenCalls] = await affiliateHook.getLastOpenCall()
      expect(affiliateOpenCalls).to.equal(0n)
    })

    it("Should call affiliate and system hook on closePosition; swallow hook revert", async function () {
      const MockHook = await ethers.getContractFactory("MockHook")
      const affiliateHook = await MockHook.deploy()
      await affiliateHook.waitForDeployment()
      const systemHook = await MockHook.deploy()
      await systemHook.waitForDeployment()

      await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await affiliateHook.getAddress())
      await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await systemHook.getAddress())

      // Open a position first
      await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
      await hedger.lockQuote(1)
      const openPrice = decimal(1n)
      const filledAmount = await getQuoteQuantity(context, 1n)
      await hedger.openPosition(
        1,
        limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(openPrice).price(decimal(1n, 17)).build(),
      )

      // Request close and fill
      await user.requestToClosePosition(1)

      // Make system hook revert on close to ensure it's swallowed, affiliate should receive
      await systemHook.setRevertOnClose(true, "system close revert")

      const closeFilled = filledAmount
      const closePrice = decimal(1n)
      await expect(
        hedger.fillCloseRequest(
          1,
          limitFillCloseRequestBuilder().filledAmount(closeFilled).closedPrice(closePrice).price(decimal(1n)).build(),
        ),
      ).to.not.reverted

      // Verify affiliate hook received close call
      const [cq, camount, cprice, cpartyA, cpartyB, ccalls] = await affiliateHook.getLastCloseCall()
      expect(cq).to.equal(1n)
      expect(camount).to.equal(closeFilled)
      expect(cprice).to.equal(closePrice)
      const q = await context.viewFacetQuote.getQuote(1)
      expect(cpartyA).to.equal(q.partyA)
      expect(cpartyB).to.equal(q.partyB)
      expect(ccalls).to.equal(1n)

      // System hook reverted; its closeCallCount should be 0
      const [, , , , , systemCloseCalls] = await systemHook.getLastCloseCall()
      expect(systemCloseCalls).to.equal(0n)
    })
  })

  describe("onFeeCharged callback", () => {
    it("Should call onFeeCharged with OPEN fee type on openPosition", async function () {
      const MockHook = await ethers.getContractFactory("MockHook")
      const affiliateHook = await MockHook.deploy()
      await affiliateHook.waitForDeployment()
      const systemHook = await MockHook.deploy()
      await systemHook.waitForDeployment()

      // Configure hooks
      await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await affiliateHook.getAddress())
      await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await systemHook.getAddress())

      // Prepare a LONG quote
      await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
      await hedger.lockQuote(1)

      const openPrice = decimal(1n)
      const filledAmount = await getQuoteQuantity(context, 1n)

      // Open position
      await expect(
        hedger.openPosition(
          1,
          limitOpenRequestBuilder()
            .filledAmount(filledAmount)
            .openPrice(openPrice)
            .price(decimal(1n, 17))
            .build(),
        ),
      ).to.not.reverted

      // Verify affiliate hook received the fee callback
      const [feeQuoteId, feeAmount, feePartyA, feePartyB, feeSymbolId, feeAffiliate, feeType, feeCalls] =
        await affiliateHook.getLastOpenFeeCall()
      expect(feeQuoteId).to.equal(1n)
      expect(feeAmount).to.be.gt(0n) // Fee should be greater than 0
      const q = await context.viewFacetQuote.getQuote(1)
      expect(feePartyA).to.equal(q.partyA)
      expect(feePartyB).to.equal(q.partyB)
      expect(feeSymbolId).to.equal(q.symbolId)
      expect(feeAffiliate).to.equal(context.accountManager)
      expect(feeType).to.equal(0n) // TradingFeeType.OPEN = 0
      expect(feeCalls).to.equal(1n)

      // Verify system hook also received the fee callback
      const [, , , , , , , systemFeeCalls] = await systemHook.getLastOpenFeeCall()
      expect(systemFeeCalls).to.equal(1n)
    })

    it("Should call onFeeCharged with CLOSE fee type on closePosition", async function () {
      const MockHook = await ethers.getContractFactory("MockHook")
      const affiliateHook = await MockHook.deploy()
      await affiliateHook.waitForDeployment()
      const systemHook = await MockHook.deploy()
      await systemHook.waitForDeployment()

      await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await affiliateHook.getAddress())
      await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await systemHook.getAddress())

      // Open a position first
      await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
      await hedger.lockQuote(1)
      const openPrice = decimal(1n)
      const filledAmount = await getQuoteQuantity(context, 1n)
      await hedger.openPosition(
        1,
        limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(openPrice).price(decimal(1n, 17)).build(),
      )

      // Request close and fill
      await user.requestToClosePosition(1)

      const closeFilled = filledAmount
      const closePrice = decimal(1n)
      await expect(
        hedger.fillCloseRequest(
          1,
          limitFillCloseRequestBuilder().filledAmount(closeFilled).closedPrice(closePrice).price(decimal(1n)).build(),
        ),
      ).to.not.reverted

      // Verify affiliate hook received the close fee callback
      const [feeQuoteId, feeAmount, feePartyA, feePartyB, feeSymbolId, feeAffiliate, feeType, feeCalls] =
        await affiliateHook.getLastCloseFeeCall()
      expect(feeQuoteId).to.equal(1n)
      expect(feeAmount).to.be.gt(0n) // Fee should be greater than 0
      const q = await context.viewFacetQuote.getQuote(1)
      expect(feePartyA).to.equal(q.partyA)
      expect(feePartyB).to.equal(q.partyB)
      expect(feeSymbolId).to.equal(q.symbolId)
      expect(feeAffiliate).to.equal(context.accountManager)
      expect(feeType).to.equal(1n) // TradingFeeType.CLOSE = 1
      expect(feeCalls).to.equal(1n)

      // Verify system hook also received the close fee callback
      const [, , , , , , , systemFeeCalls] = await systemHook.getLastCloseFeeCall()
      expect(systemFeeCalls).to.equal(1n)
    })

    it("Should swallow onFeeCharged revert on open and not affect transaction", async function () {
      const MockHook = await ethers.getContractFactory("MockHook")
      const affiliateHook = await MockHook.deploy()
      await affiliateHook.waitForDeployment()
      const systemHook = await MockHook.deploy()
      await systemHook.waitForDeployment()

      await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await affiliateHook.getAddress())
      await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await systemHook.getAddress())

      // Prepare a LONG quote
      await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
      await hedger.lockQuote(1)

      const openPrice = decimal(1n)
      const filledAmount = await getQuoteQuantity(context, 1n)

      // Make affiliate hook revert on fee callback
      await affiliateHook.setRevertOnOpenFee(true, "affiliate open fee revert")

      // Open position should still succeed
      await expect(
        hedger.openPosition(
          1,
          limitOpenRequestBuilder()
            .filledAmount(filledAmount)
            .openPrice(openPrice)
            .price(decimal(1n, 17))
            .build(),
        ),
      ).to.not.reverted

      // Affiliate hook fee call should have reverted (count = 0)
      const [, , , , , , , affiliateFeeCalls] = await affiliateHook.getLastOpenFeeCall()
      expect(affiliateFeeCalls).to.equal(0n)

      // System hook should still have received the callback
      const [, , , , , , , systemFeeCalls] = await systemHook.getLastOpenFeeCall()
      expect(systemFeeCalls).to.equal(1n)
    })

    it("Should swallow onFeeCharged revert on close and not affect transaction", async function () {
      const MockHook = await ethers.getContractFactory("MockHook")
      const affiliateHook = await MockHook.deploy()
      await affiliateHook.waitForDeployment()
      const systemHook = await MockHook.deploy()
      await systemHook.waitForDeployment()

      await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await affiliateHook.getAddress())
      await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await systemHook.getAddress())

      // Open a position first
      await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
      await hedger.lockQuote(1)
      const openPrice = decimal(1n)
      const filledAmount = await getQuoteQuantity(context, 1n)
      await hedger.openPosition(
        1,
        limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(openPrice).price(decimal(1n, 17)).build(),
      )

      // Request close
      await user.requestToClosePosition(1)

      // Make system hook revert on close fee callback
      await systemHook.setRevertOnCloseFee(true, "system close fee revert")

      const closeFilled = filledAmount
      const closePrice = decimal(1n)

      // Close should still succeed
      await expect(
        hedger.fillCloseRequest(
          1,
          limitFillCloseRequestBuilder().filledAmount(closeFilled).closedPrice(closePrice).price(decimal(1n)).build(),
        ),
      ).to.not.reverted

      // System hook fee call should have reverted (count = 0)
      const [, , , , , , , systemFeeCalls] = await systemHook.getLastCloseFeeCall()
      expect(systemFeeCalls).to.equal(0n)

      // Affiliate hook should still have received the callback
      const [, , , , , , , affiliateFeeCalls] = await affiliateHook.getLastCloseFeeCall()
      expect(affiliateFeeCalls).to.equal(1n)
    })

    it("Should pass correct fee amount matching TradingFeeCharged event", async function () {
      const MockHook = await ethers.getContractFactory("MockHook")
      const affiliateHook = await MockHook.deploy()
      await affiliateHook.waitForDeployment()

      await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await affiliateHook.getAddress())

      // Prepare and open a position
      await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
      await hedger.lockQuote(1)

      const openPrice = decimal(1n)
      const filledAmount = await getQuoteQuantity(context, 1n)

      // Open position
      await hedger.openPosition(
        1,
        limitOpenRequestBuilder()
          .filledAmount(filledAmount)
          .openPrice(openPrice)
          .price(decimal(1n, 17))
          .build(),
      )

      // Get the quote to calculate expected fee
      const q = await context.viewFacetQuote.getQuote(1)
      const expectedOpenFee = (filledAmount * q.openedPrice * q.tradingFee) / BigInt(1e36)

      // Verify hook received correct fee amount (within 1% tolerance due to price adjustments)
      const [, feeAmount] = await affiliateHook.getLastOpenFeeCall()
      const openFeeDiff = feeAmount > expectedOpenFee ? feeAmount - expectedOpenFee : expectedOpenFee - feeAmount
      const openFeeTolerance = expectedOpenFee / 100n // 1% tolerance
      expect(openFeeDiff).to.be.lte(openFeeTolerance)

      // Now test close fee
      await user.requestToClosePosition(1)
      const closeFilled = filledAmount
      const closePrice = decimal(1n)
      await hedger.fillCloseRequest(
        1,
        limitFillCloseRequestBuilder().filledAmount(closeFilled).closedPrice(closePrice).price(decimal(1n)).build(),
      )

      const expectedCloseFee = (closeFilled * closePrice * q.closeFee) / BigInt(1e36)

      // Verify hook received correct close fee amount (within 1% tolerance)
      const [, closeFeeAmount] = await affiliateHook.getLastCloseFeeCall()
      const closeFeeDiff = closeFeeAmount > expectedCloseFee ? closeFeeAmount - expectedCloseFee : expectedCloseFee - closeFeeAmount
      const closeFeeTolerance = expectedCloseFee / 100n // 1% tolerance
      expect(closeFeeDiff).to.be.lte(closeFeeTolerance)
    })
  })
}

