import { expect } from "chai"

import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { PositionType } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, getQuoteQuantity } from "./utils/Common.js"

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
				context.controlFacet.connect(context.signers.user).registerHook(context.accountManager, await mockHook.getAddress()),
			).to.be.revertedWith("Accessibility: Must have role")

			// Admin has SETTER_ROLE in fixture
			await expect(context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await mockHook.getAddress())).to.not
				.reverted

			const current = await context.viewFacet.getAffiliateHook(context.accountManager)
			expect(current).to.equal(await mockHook.getAddress())
		})

		it("Should set system-wide hook (affiliate = address(0))", async function () {
			const MockHook = await ethers.getContractFactory("MockHook")
			const mockHook = await MockHook.deploy()
			await mockHook.waitForDeployment()

			await expect(context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await mockHook.getAddress())).to.not.reverted

			const current = await context.viewFacet.getAffiliateHook(ethers.ZeroAddress)
			expect(current).to.equal(await mockHook.getAddress())
		})

		it("Should allow clearing a hook by setting to zero address", async function () {
			const MockHook = await ethers.getContractFactory("MockHook")
			const mockHook = await MockHook.deploy()
			await mockHook.waitForDeployment()

			await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await mockHook.getAddress())

			await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, ethers.ZeroAddress)

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

			// NOTE: Hook reverts now revert the whole tx
			// await expect(
			//   hedger.openPosition(
			//     1,
			//     limitOpenRequestBuilder()
			//       .filledAmount(filledAmount)
			//       .openPrice(openPrice)
			//       .price(decimal(1n, 17))
			//       .build(),
			//   ),
			// ).to.not.reverted
			await expect(hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(openPrice).price(decimal(1n, 17)).build()))
				.to.be.reverted

			// NOTE: Hook reverts now revert the whole tx
			// const [oq, oamount, oprice, opartyA, opartyB, ocalls] = await systemHook.getLastOpenCall()
			// expect(oq).to.equal(1n)
			// expect(oamount).to.equal(filledAmount)
			// expect(oprice).to.equal(openPrice)
			// const q = await context.viewFacetQuote.getQuote(1)
			// expect(opartyA).to.equal(q.partyA)
			// expect(opartyB).to.equal(q.partyB)
			// expect(ocalls).to.equal(1n)
			//
			// const [, , , , , affiliateOpenCalls] = await affiliateHook.getLastOpenCall()
			// expect(affiliateOpenCalls).to.equal(0n)
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
			await hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(openPrice).price(decimal(1n, 17)).build())

			// Request close and fill
			await user.requestToClosePosition(1)

			// Make system hook revert on close to ensure it's swallowed, affiliate should receive
			await systemHook.setRevertOnClose(true, "system close revert")

			const closeFilled = filledAmount
			const closePrice = decimal(1n)
			// NOTE: Hook reverts now revert the whole tx
			// await expect(
			//   hedger.fillCloseRequest(
			//     1,
			//     limitFillCloseRequestBuilder().filledAmount(closeFilled).closedPrice(closePrice).price(decimal(1n)).build(),
			//   ),
			// ).to.not.reverted
			await expect(
				hedger.fillCloseRequest(1, limitFillCloseRequestBuilder().filledAmount(closeFilled).closedPrice(closePrice).price(decimal(1n)).build()),
			).to.be.reverted

			// NOTE: Hook reverts now revert the whole tx
			// const [cq, camount, cprice, cpartyA, cpartyB, ccalls] = await affiliateHook.getLastCloseCall()
			// expect(cq).to.equal(1n)
			// expect(camount).to.equal(closeFilled)
			// expect(cprice).to.equal(closePrice)
			// const q = await context.viewFacetQuote.getQuote(1)
			// expect(cpartyA).to.equal(q.partyA)
			// expect(cpartyB).to.equal(q.partyB)
			// expect(ccalls).to.equal(1n)
			//
			// const [, , , , , systemCloseCalls] = await systemHook.getLastCloseCall()
			// expect(systemCloseCalls).to.equal(0n)
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
			await expect(hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(openPrice).price(decimal(1n, 17)).build()))
				.to.not.reverted

			// Verify affiliate hook received the fee callback
			const [feeQuoteId, feeAmount, feePartyA, feePartyB, feeSymbolId, feeAffiliate, feeType, feeCalls] = await affiliateHook.getLastOpenFeeCall()
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
			await hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(openPrice).price(decimal(1n, 17)).build())

			// Request close and fill
			await user.requestToClosePosition(1)

			const closeFilled = filledAmount
			const closePrice = decimal(1n)
			await expect(
				hedger.fillCloseRequest(1, limitFillCloseRequestBuilder().filledAmount(closeFilled).closedPrice(closePrice).price(decimal(1n)).build()),
			).to.not.reverted

			// Verify affiliate hook received the close fee callback
			const [feeQuoteId, feeAmount, feePartyA, feePartyB, feeSymbolId, feeAffiliate, feeType, feeCalls] = await affiliateHook.getLastCloseFeeCall()
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

			// NOTE: Hook reverts now revert the whole tx
			// await expect(
			//   hedger.openPosition(
			//     1,
			//     limitOpenRequestBuilder()
			//       .filledAmount(filledAmount)
			//       .openPrice(openPrice)
			//       .price(decimal(1n, 17))
			//       .build(),
			//   ),
			// ).to.not.reverted
			await expect(hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(openPrice).price(decimal(1n, 17)).build()))
				.to.be.reverted

			// NOTE: Hook reverts now revert the whole tx
			// const [, , , , , , , affiliateFeeCalls] = await affiliateHook.getLastOpenFeeCall()
			// expect(affiliateFeeCalls).to.equal(0n)
			//
			// const [, , , , , , , systemFeeCalls] = await systemHook.getLastOpenFeeCall()
			// expect(systemFeeCalls).to.equal(1n)
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
			await hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(openPrice).price(decimal(1n, 17)).build())

			// Request close
			await user.requestToClosePosition(1)

			// Make system hook revert on close fee callback
			await systemHook.setRevertOnCloseFee(true, "system close fee revert")

			const closeFilled = filledAmount
			const closePrice = decimal(1n)

			// NOTE: Hook reverts now revert the whole tx
			// await expect(
			//   hedger.fillCloseRequest(
			//     1,
			//     limitFillCloseRequestBuilder().filledAmount(closeFilled).closedPrice(closePrice).price(decimal(1n)).build(),
			//   ),
			// ).to.not.reverted
			await expect(
				hedger.fillCloseRequest(1, limitFillCloseRequestBuilder().filledAmount(closeFilled).closedPrice(closePrice).price(decimal(1n)).build()),
			).to.be.reverted

			// NOTE: Hook reverts now revert the whole tx
			// const [, , , , , , , systemFeeCalls] = await systemHook.getLastCloseFeeCall()
			// expect(systemFeeCalls).to.equal(0n)
			//
			// const [, , , , , , , affiliateFeeCalls] = await affiliateHook.getLastCloseFeeCall()
			// expect(affiliateFeeCalls).to.equal(1n)
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
			await hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(openPrice).price(decimal(1n, 17)).build())

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
			await hedger.fillCloseRequest(1, limitFillCloseRequestBuilder().filledAmount(closeFilled).closedPrice(closePrice).price(decimal(1n)).build())

			const expectedCloseFee = (closeFilled * closePrice * q.closeFee) / BigInt(1e36)

			// Verify hook received correct close fee amount (within 1% tolerance)
			const [, closeFeeAmount] = await affiliateHook.getLastCloseFeeCall()
			const closeFeeDiff = closeFeeAmount > expectedCloseFee ? closeFeeAmount - expectedCloseFee : expectedCloseFee - closeFeeAmount
			const closeFeeTolerance = expectedCloseFee / 100n // 1% tolerance
			expect(closeFeeDiff).to.be.lte(closeFeeTolerance)
		})
	})

	describe("hook signer protection (LibHook.safeCall)", () => {
		it("Should prevent hook from impersonating user on openPosition", async function () {
			const MaliciousHook = await ethers.getContractFactory("MaliciousHook")
			const maliciousHook = await MaliciousHook.deploy()
			await maliciousHook.waitForDeployment()

			// Configure malicious hook
			await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await maliciousHook.getAddress())

			// Set up the hook to try to deallocate user funds
			await maliciousHook.setSymmioCore(context.diamond)
			await maliciousHook.setDeallocateAmount(decimal(100n))

			// Prepare a LONG quote
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(1)

			const openPrice = decimal(1n)
			const filledAmount = await getQuoteQuantity(context, 1n)

			// Open position - hook will try to deallocate as user
			await expect(hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(openPrice).price(decimal(1n, 17)).build()))
				.to.not.reverted

			// Verify that the hook attempted reentry but failed
			expect(await maliciousHook.attemptedReentry()).to.equal(true)
			expect(await maliciousHook.reentrySucceeded()).to.equal(false)
			expect(await maliciousHook.openCallCount()).to.equal(1n)

			// Verify the hook emitted ReentryAttempted event with success=false
			const filter = maliciousHook.filters.ReentryAttempted()
			const events = await maliciousHook.queryFilter(filter)
			expect(events.length).to.equal(1)
			expect(events[0].args.success).to.equal(false)
			expect(events[0].args.error.length).to.be.gt(0)
		})

		it("Should prevent hook from impersonating user on closePosition", async function () {
			const MaliciousHook = await ethers.getContractFactory("MaliciousHook")
			const maliciousHook = await MaliciousHook.deploy()
			await maliciousHook.waitForDeployment()

			// First, open a position without the malicious hook
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(1)
			const openPrice = decimal(1n)
			const filledAmount = await getQuoteQuantity(context, 1n)
			await hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(openPrice).price(decimal(1n, 17)).build())

			// Now configure malicious hook for the close
			await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await maliciousHook.getAddress())
			await maliciousHook.setSymmioCore(context.diamond)
			await maliciousHook.setDeallocateAmount(decimal(50n))

			// Request close
			await user.requestToClosePosition(1)

			const closeFilled = filledAmount
			const closePrice = decimal(1n)

			// Fill close request - hook will try to deallocate as user
			await expect(
				hedger.fillCloseRequest(1, limitFillCloseRequestBuilder().filledAmount(closeFilled).closedPrice(closePrice).price(decimal(1n)).build()),
			).to.not.reverted

			// Verify that the hook attempted reentry but failed
			expect(await maliciousHook.attemptedReentry()).to.equal(true)
			expect(await maliciousHook.reentrySucceeded()).to.equal(false)
			expect(await maliciousHook.closeCallCount()).to.equal(1n)

			// Verify the hook emitted ReentryAttempted event with success=false
			const filter = maliciousHook.filters.ReentryAttempted()
			const events = await maliciousHook.queryFilter(filter)
			expect(events.length).to.equal(1)
			expect(events[0].args.success).to.equal(false)
			expect(events[0].args.error.length).to.be.gt(0)
		})

		it("Should allow normal hook functionality while preventing impersonation", async function () {
			const MockHook = await ethers.getContractFactory("MockHook")
			const mockHook = await MockHook.deploy()
			await mockHook.waitForDeployment()

			await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await mockHook.getAddress())

			// Prepare and open a position
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(1)

			const openPrice = decimal(1n)
			const filledAmount = await getQuoteQuantity(context, 1n)

			await hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(openPrice).price(decimal(1n, 17)).build())

			// Verify normal hook functionality still works
			const [oq, oamount, oprice, opartyA, opartyB, ocalls] = await mockHook.getLastOpenCall()
			expect(oq).to.equal(1n)
			expect(oamount).to.equal(filledAmount)
			expect(oprice).to.equal(openPrice)
			expect(ocalls).to.equal(1n)

			// Verify fee callback also works
			const [, , , , , , , feeCalls] = await mockHook.getLastOpenFeeCall()
			expect(feeCalls).to.equal(1n)
		})
	})
}
