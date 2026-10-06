import { expect } from "chai"

import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { PositionType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp, getQuoteQuantity } from "./utils/Common.js"
import { migratePartyBToCross } from "./utils/CrossPartyB.js"
import { getDummyHighLowPriceSig, getDummySingleUpnlSig } from "./utils/SignatureUtils.js"

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

	describe("onCancelQuote callback", () => {
		it("Should call hooks on forceCancelQuote", async function () {
			const MockHook = await ethers.getContractFactory("MockHook")
			const affiliateHook = await MockHook.deploy()
			await affiliateHook.waitForDeployment()
			const systemHook = await MockHook.deploy()
			await systemHook.waitForDeployment()

			await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await affiliateHook.getAddress())
			await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await systemHook.getAddress())

			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(1)
			await user.requestToCancelQuote(1)

			const [, forceCancelCooldown] = await context.viewFacet.coolDownsOfMA()
			await time.increase(Number(forceCancelCooldown + 1n))
			await user.forceCancelQuote(1)

			const quote = await context.viewFacetQuote.getQuote(1)
			expect(quote.quoteStatus).to.equal(QuoteStatus.CANCELED)

			const [affiliateQuoteId, affiliatePartyA, affiliatePartyB, affiliateCalls] = await affiliateHook.getLastCancelCall()
			expect(affiliateQuoteId).to.equal(1n)
			expect(affiliatePartyA).to.equal(await user.getAddress())
			expect(affiliatePartyB).to.equal(await hedger.getAddress())
			expect(affiliateCalls).to.equal(1n)

			const [systemQuoteId, systemPartyA, systemPartyB, systemCalls] = await systemHook.getLastCancelCall()
			expect(systemQuoteId).to.equal(1n)
			expect(systemPartyA).to.equal(await user.getAddress())
			expect(systemPartyB).to.equal(await hedger.getAddress())
			expect(systemCalls).to.equal(1n)
		})

		it("Should call hooks on liquidatePendingPositionsPartyA", async function () {
			const MockHook = await ethers.getContractFactory("MockHook")
			const affiliateHook = await MockHook.deploy()
			await affiliateHook.waitForDeployment()
			const systemHook = await MockHook.deploy()
			await systemHook.waitForDeployment()

			await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await affiliateHook.getAddress())
			await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await systemHook.getAddress())

			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
			await hedger.lockQuote(1)
			await hedger.openPosition(1, limitOpenRequestBuilder().build())

			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(2)

			await user.liquidateAndSetSymbolPrices([1n], [decimal(8n)], [1n])
			await user.liquidatePendingPositions()

			const quote = await context.viewFacetQuote.getQuote(2)
			expect(quote.quoteStatus).to.equal(QuoteStatus.LIQUIDATED_PENDING)

			const [affiliateQuoteId, affiliatePartyA, affiliatePartyB, affiliateCalls] = await affiliateHook.getLastCancelCall()
			expect(affiliateQuoteId).to.equal(2n)
			expect(affiliatePartyA).to.equal(await user.getAddress())
			expect(affiliatePartyB).to.equal(await hedger.getAddress())
			expect(affiliateCalls).to.equal(1n)

			const [systemQuoteId, systemPartyA, systemPartyB, systemCalls] = await systemHook.getLastCancelCall()
			expect(systemQuoteId).to.equal(2n)
			expect(systemPartyA).to.equal(await user.getAddress())
			expect(systemPartyB).to.equal(await hedger.getAddress())
			expect(systemCalls).to.equal(1n)
		})

		it("Should call hooks for each pending quote on liquidatePendingPositionsPartyA", async function () {
			const MockHook = await ethers.getContractFactory("MockHook")
			const affiliateHook = await MockHook.deploy()
			await affiliateHook.waitForDeployment()
			const systemHook = await MockHook.deploy()
			await systemHook.waitForDeployment()

			await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await affiliateHook.getAddress())
			await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await systemHook.getAddress())

			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
			await hedger.lockQuote(1)
			await hedger.openPosition(1, limitOpenRequestBuilder().build())

			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(2)
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(3)

			await user.liquidateAndSetSymbolPrices([1n], [decimal(8n)], [1n])
			await user.liquidatePendingPositions()

			expect((await context.viewFacetQuote.getQuote(2)).quoteStatus).to.equal(QuoteStatus.LIQUIDATED_PENDING)
			expect((await context.viewFacetQuote.getQuote(3)).quoteStatus).to.equal(QuoteStatus.LIQUIDATED_PENDING)
			expect(await affiliateHook.cancelCallCount()).to.equal(2n)
			expect(await systemHook.cancelCallCount()).to.equal(2n)
		})

		it("Should call hooks on liquidatePartyB when pending quotes are liquidated", async function () {
			const MockHook = await ethers.getContractFactory("MockHook")
			const affiliateHook = await MockHook.deploy()
			await affiliateHook.waitForDeployment()
			const systemHook = await MockHook.deploy()
			await systemHook.waitForDeployment()

			await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await affiliateHook.getAddress())
			await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await systemHook.getAddress())

			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(1)

			await context.partyBLiquidationFacet
				.connect(context.signers.liquidator)
				.liquidatePartyB(await hedger.getAddress(), await user.getAddress(), await getDummySingleUpnlSig(decimal(-1000n)))

			const quote = await context.viewFacetQuote.getQuote(1)
			expect(quote.quoteStatus).to.equal(QuoteStatus.LIQUIDATED_PENDING)

			const [affiliateQuoteId, affiliatePartyA, affiliatePartyB, affiliateCalls] = await affiliateHook.getLastCancelCall()
			expect(affiliateQuoteId).to.equal(1n)
			expect(affiliatePartyA).to.equal(await user.getAddress())
			expect(affiliatePartyB).to.equal(await hedger.getAddress())
			expect(affiliateCalls).to.equal(1n)

			const [systemQuoteId, systemPartyA, systemPartyB, systemCalls] = await systemHook.getLastCancelCall()
			expect(systemQuoteId).to.equal(1n)
			expect(systemPartyA).to.equal(await user.getAddress())
			expect(systemPartyB).to.equal(await hedger.getAddress())
			expect(systemCalls).to.equal(1n)
		})

		it("Should call hooks for LOCKED and CANCEL_PENDING quotes on liquidatePartyB", async function () {
			const MockHook = await ethers.getContractFactory("MockHook")
			const affiliateHook = await MockHook.deploy()
			await affiliateHook.waitForDeployment()
			const systemHook = await MockHook.deploy()
			await systemHook.waitForDeployment()

			await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await affiliateHook.getAddress())
			await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await systemHook.getAddress())

			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(1)
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(2)
			await user.requestToCancelQuote(2)

			await context.partyBLiquidationFacet
				.connect(context.signers.liquidator)
				.liquidatePartyB(await hedger.getAddress(), await user.getAddress(), await getDummySingleUpnlSig(decimal(-1000n)))

			expect((await context.viewFacetQuote.getQuote(1)).quoteStatus).to.equal(QuoteStatus.LIQUIDATED_PENDING)
			expect((await context.viewFacetQuote.getQuote(2)).quoteStatus).to.equal(QuoteStatus.LIQUIDATED_PENDING)
			expect(await affiliateHook.cancelCallCount()).to.equal(2n)
			expect(await systemHook.cancelCallCount()).to.equal(2n)
		})

		it("Should call hooks on liquidatePartyB when triggered by forceClose insolvency path", async function () {
			const MockHook = await ethers.getContractFactory("MockHook")
			const affiliateHook = await MockHook.deploy()
			await affiliateHook.waitForDeployment()
			const systemHook = await MockHook.deploy()
			await systemHook.waitForDeployment()

			await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await affiliateHook.getAddress())
			await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await systemHook.getAddress())

			await context.controlFacet
				.connect(context.signers.admin)
				.grantRole(await context.signers.admin.getAddress(), ethers.keccak256(ethers.toUtf8Bytes("FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE")))
			await context.controlFacet.connect(context.signers.admin).setForceCloseMinSigPeriod(10)

			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
			await hedger.lockQuote(1)
			await hedger.openPosition(1, limitOpenRequestBuilder().build())

			const quote1 = await context.viewFacetQuote.getQuote(1)
			await context.controlFacet.connect(context.signers.admin).setForceCloseGapRatio(quote1.symbolId, decimal(1n, 17))

			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(2)

			await user.requestToClosePosition(
				1,
				limitCloseRequestBuilder()
					.quantityToClose(await getQuoteQuantity(context, 1n))
					.closePrice(decimal(1n))
					.deadline((await getBlockTimestamp()) + 1000n)
					.build(),
			)

			const [firstCooldown, secondCooldown] = await context.viewFacet.forceCloseCooldowns()
			const startTime = (await getBlockTimestamp()) + firstCooldown
			const endTime = startTime + 10n
			await time.increase(firstCooldown + 10n + secondCooldown + 1n)

			await user.forceClosePosition(1, await getDummyHighLowPriceSig(startTime, endTime, 0n, decimal(10n), decimal(7n), decimal(8n), 0n, 0n, 0n))

			expect((await context.viewFacetQuote.getQuote(2)).quoteStatus).to.equal(QuoteStatus.LIQUIDATED_PENDING)
			expect(await affiliateHook.cancelCallCount()).to.equal(1n)
			expect(await systemHook.cancelCallCount()).to.equal(1n)
		})

		it("Should call hooks for each pending quote when forceClose triggers partyB liquidation", async function () {
			const MockHook = await ethers.getContractFactory("MockHook")
			const affiliateHook = await MockHook.deploy()
			await affiliateHook.waitForDeployment()
			const systemHook = await MockHook.deploy()
			await systemHook.waitForDeployment()

			await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await affiliateHook.getAddress())
			await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await systemHook.getAddress())

			await context.controlFacet
				.connect(context.signers.admin)
				.grantRole(await context.signers.admin.getAddress(), ethers.keccak256(ethers.toUtf8Bytes("FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE")))
			await context.controlFacet.connect(context.signers.admin).setForceCloseMinSigPeriod(10)

			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
			await hedger.lockQuote(1)
			await hedger.openPosition(1, limitOpenRequestBuilder().build())

			const quote1 = await context.viewFacetQuote.getQuote(1)
			await context.controlFacet.connect(context.signers.admin).setForceCloseGapRatio(quote1.symbolId, decimal(1n, 17))

			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(2)
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(3)
			await user.requestToCancelQuote(3)

			await user.requestToClosePosition(
				1,
				limitCloseRequestBuilder()
					.quantityToClose(await getQuoteQuantity(context, 1n))
					.closePrice(decimal(1n))
					.deadline((await getBlockTimestamp()) + 1000n)
					.build(),
			)

			const [firstCooldown, secondCooldown] = await context.viewFacet.forceCloseCooldowns()
			const startTime = (await getBlockTimestamp()) + firstCooldown
			const endTime = startTime + 10n
			await time.increase(firstCooldown + 10n + secondCooldown + 1n)

			await user.forceClosePosition(1, await getDummyHighLowPriceSig(startTime, endTime, 0n, decimal(10n), decimal(7n), decimal(8n), 0n, 0n, 0n))

			expect((await context.viewFacetQuote.getQuote(2)).quoteStatus).to.equal(QuoteStatus.LIQUIDATED_PENDING)
			expect((await context.viewFacetQuote.getQuote(3)).quoteStatus).to.equal(QuoteStatus.LIQUIDATED_PENDING)
			expect(await affiliateHook.cancelCallCount()).to.equal(2n)
			expect(await systemHook.cancelCallCount()).to.equal(2n)
		})
	})

	describe("onCloseExpired callback", () => {
		it("Should call hooks on forceCancelCloseRequest", async function () {
			const MockHook = await ethers.getContractFactory("MockHook")
			const affiliateHook = await MockHook.deploy()
			await affiliateHook.waitForDeployment()
			const systemHook = await MockHook.deploy()
			await systemHook.waitForDeployment()

			await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await affiliateHook.getAddress())
			await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await systemHook.getAddress())

			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(1)
			const filledAmount = await getQuoteQuantity(context, 1n)
			await hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(decimal(1n)).price(decimal(1n)).build())

			await user.requestToClosePosition(1)
			await user.requestToCancelCloseRequest(1)

			const [, , forceCancelCloseCooldown] = await context.viewFacet.coolDownsOfMA()
			await time.increase(Number(forceCancelCloseCooldown + 1n))
			await user.forceCancelCloseRequest(1)

			const quote = await context.viewFacetQuote.getQuote(1)
			expect(quote.quoteStatus).to.equal(QuoteStatus.OPENED)

			const [affiliateQuoteId, affiliatePartyA, affiliatePartyB, affiliateCalls] = await affiliateHook.getLastCloseExpiredCall()
			expect(affiliateQuoteId).to.equal(1n)
			expect(affiliatePartyA).to.equal(await user.getAddress())
			expect(affiliatePartyB).to.equal(await hedger.getAddress())
			expect(affiliateCalls).to.equal(1n)

			const [systemQuoteId, systemPartyA, systemPartyB, systemCalls] = await systemHook.getLastCloseExpiredCall()
			expect(systemQuoteId).to.equal(1n)
			expect(systemPartyA).to.equal(await user.getAddress())
			expect(systemPartyB).to.equal(await hedger.getAddress())
			expect(systemCalls).to.equal(1n)
		})

		it("Should call hooks when CLOSE_PENDING quote expires", async function () {
			const MockHook = await ethers.getContractFactory("MockHook")
			const affiliateHook = await MockHook.deploy()
			await affiliateHook.waitForDeployment()
			const systemHook = await MockHook.deploy()
			await systemHook.waitForDeployment()

			await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await affiliateHook.getAddress())
			await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await systemHook.getAddress())

			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(1)
			const filledAmount = await getQuoteQuantity(context, 1n)
			await hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(decimal(1n)).price(decimal(1n)).build())

			const nearDeadline = BigInt(await time.latest()) + 10n
			await user.requestToClosePosition(1, limitCloseRequestBuilder().deadline(nearDeadline).build())
			await time.increase(11)
			await context.partyAFacet.connect(user.signer).expireQuote([1])

			const quote = await context.viewFacetQuote.getQuote(1)
			expect(quote.quoteStatus).to.equal(QuoteStatus.OPENED)
			expect(await affiliateHook.closeExpiredCallCount()).to.equal(1n)
			expect(await systemHook.closeExpiredCallCount()).to.equal(1n)
		})

		it("Should call hooks when CANCEL_CLOSE_PENDING quote expires", async function () {
			const MockHook = await ethers.getContractFactory("MockHook")
			const affiliateHook = await MockHook.deploy()
			await affiliateHook.waitForDeployment()
			const systemHook = await MockHook.deploy()
			await systemHook.waitForDeployment()

			await context.controlFacet.connect(context.signers.admin).registerHook(context.accountManager, await affiliateHook.getAddress())
			await context.controlFacet.connect(context.signers.admin).registerHook(ethers.ZeroAddress, await systemHook.getAddress())

			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.LONG).build())
			await hedger.lockQuote(1)
			const filledAmount = await getQuoteQuantity(context, 1n)
			await hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(decimal(1n)).price(decimal(1n)).build())

			const nearDeadline = BigInt(await time.latest()) + 10n
			await user.requestToClosePosition(1, limitCloseRequestBuilder().deadline(nearDeadline).build())
			await user.requestToCancelCloseRequest(1)
			await time.increase(11)
			await context.partyAFacet.connect(user.signer).expireQuote([1])

			const quote = await context.viewFacetQuote.getQuote(1)
			expect(quote.quoteStatus).to.equal(QuoteStatus.OPENED)
			expect(await affiliateHook.closeExpiredCallCount()).to.equal(1n)
			expect(await systemHook.closeExpiredCallCount()).to.equal(1n)
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
