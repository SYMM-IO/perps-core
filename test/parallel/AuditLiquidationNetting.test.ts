import { expect } from "chai"

import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture } from "../helpers/network-helpers.js"
import { LiquidationType, PositionType } from "../models/Enums.js"
import { Hedger } from "../models/Hedger.js"
import { User } from "../models/User.js"
import { limitOpenRequestBuilder } from "../models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal } from "../utils/Common.js"

describe("Audit remediation: OVERDUE solver netting", function () {
	async function scenario(shortQuantity = 200n, longQuantity = 200n) {
		const context = await loadFixture(initializeFixture)
		const user = new User(context, context.signers.user)
		const flat = new Hedger(context, context.signers.hedger)
		const losing = new Hedger(context, context.signers.hedger2)
		await user.setup()
		await flat.setup()
		await losing.setup()
		await user.setBalances(decimal(10000n), decimal(5000n), decimal(1000n))
		await flat.setBalances(decimal(10000n), decimal(10000n))
		await losing.setBalances(decimal(10000n), decimal(10000n))
		const open = async (solver: Hedger, side: PositionType, quantity: bigint) => {
			const id = await user.sendQuote(
				limitQuoteRequestBuilder().partyBWhiteList([solver.address]).positionType(side).quantity(decimal(quantity)).build(),
			)
			await solver.lockQuote(id, 0n, decimal(1n))
			await solver.openPosition(id, limitOpenRequestBuilder().filledAmount(decimal(quantity)).price(decimal(1n)).build())
			return id
		}
		// At 0.5: the first solver nets 0 (or +100), the other solver receives 1500 before haircuts.
		const long = await open(flat, PositionType.LONG, longQuantity)
		const short = await open(flat, PositionType.SHORT, shortQuantity)
		const loss = await open(losing, PositionType.LONG, 3000n)
		const quoteIds = [long, short, loss]
		await user.liquidateAndSetSymbolPrices([1n], [decimal(5n, 17)], quoteIds)
		const detail = await context.viewFacet.getLiquidatedStateOfPartyA(user.address)
		expect(detail.liquidationType).to.equal(LiquidationType.OVERDUE)
		return { context, user, flat, losing, quoteIds, deficit: detail.deficit }
	}

	for (const reverse of [false, true]) {
		it(`keeps a net-flat solver at zero across quote and settlement batches (${reverse ? "reverse" : "forward"} order)`, async function () {
			const { context: c, user, flat, losing, quoteIds, deficit } = await scenario()
			const order = reverse ? [...quoteIds].reverse() : quoteIds
			await user.liquidatePositions([order[0]])
			await user.liquidatePositions(order.slice(1))
			const [flatState, lossState] = await c.viewFacet.getSettlementStates(user.address, [flat.address, losing.address])
			expect(flatState.expectedAmount).to.equal(0n)
			expect(flatState.actualAmount).to.equal(0n)
			expect(await c.viewFacet.getPartyBLiquidationSettlementReserve(flat.address)).to.equal(0n)
			expect(lossState.expectedAmount).to.equal(-decimal(1500n))
			expect(lossState.actualAmount).to.equal(-decimal(1500n) + deficit)
			const before = await c.viewFacet.allocatedBalanceOfPartyB(flat.address, user.address)
			for (const solver of reverse ? [losing, flat] : [flat, losing]) {
				await c.partyALiquidationFacet.settlePartyALiquidation(user.address, [solver.address])
			}
			expect(await c.viewFacet.allocatedBalanceOfPartyB(flat.address, user.address)).to.equal(before)
			expect(await c.viewFacet.isPartyALiquidated(user.address)).to.equal(false)
		})
	}

	it("preserves a solver's positive net payment and haircuts only the net losing bucket", async function () {
		const { context: c, user, flat, losing, quoteIds, deficit } = await scenario(400n)
		await user.liquidatePositions(quoteIds)
		const [positive, negative] = await c.viewFacet.getSettlementStates(user.address, [flat.address, losing.address])
		expect(positive.expectedAmount).to.equal(decimal(100n))
		expect(positive.actualAmount).to.equal(decimal(100n))
		expect(negative.actualAmount).to.equal(-decimal(1500n) + deficit)
	})

	it("uses the sum of net losses and rounds multiple solver payouts down", async function () {
		const { context: c, user, flat, losing, quoteIds, deficit } = await scenario(200n, 400n)
		await user.liquidatePositions([quoteIds[1]])
		await user.liquidatePositions([quoteIds[2], quoteIds[0]])
		const [first, second] = await c.viewFacet.getSettlementStates(user.address, [flat.address, losing.address])
		const totalLoss = decimal(1600n)
		const payable = totalLoss - deficit
		expect(first.expectedAmount).to.equal(-decimal(100n))
		expect(first.actualAmount).to.equal(-((decimal(100n) * payable) / totalLoss))
		expect(second.actualAmount).to.equal(-((decimal(1500n) * payable) / totalLoss))
		expect(-first.actualAmount - second.actualAmount).to.be.lte(payable)
	})

	it("keeps a dispute override when the remaining quote batch completes", async function () {
		const { context: c, user, flat, losing, quoteIds } = await scenario()
		await user.liquidatePositions([quoteIds[0]])
		await c.partyALiquidationFacet.connect(c.signers.admin).resolveLiquidationDispute(user.address, [flat.address], [decimal(7n)], false)
		await user.liquidatePositions(quoteIds.slice(1))
		const [state] = await c.viewFacet.getSettlementStates(user.address, [flat.address, losing.address])
		expect(state.expectedAmount).to.equal(0n)
		expect(state.actualAmount).to.equal(decimal(7n))
		expect(await c.viewFacet.getPartyBLiquidationSettlementReserve(flat.address)).to.equal(decimal(7n))
	})

	it("blocks settlement from the final close hook until haircuts and dispute checks complete", async function () {
		const { context: c, user, flat, losing, quoteIds, deficit } = await scenario()
		await user.liquidatePositions(quoteIds.slice(0, 2))
		const hook = await (await ethers.getContractFactory("AuditLiquidationSettlementHook")).deploy(c.diamond, [flat.address, losing.address])
		await hook.waitForDeployment()
		await c.controlFacet.connect(c.signers.admin).registerHook(ethers.ZeroAddress, await hook.getAddress())
		const before = await c.viewFacet.allocatedBalanceOfPartyB(losing.address, user.address)
		await user.liquidatePositions([quoteIds[2]])
		expect(await hook.settlementSucceeded()).to.equal(false)
		expect(ethers.AbiCoder.defaultAbiCoder().decode(["string"], ethers.dataSlice(await hook.settlementFailure(), 4))[0]).to.equal(
			"LiquidationFacet: Processing positions",
		)
		expect(await c.viewFacet.allocatedBalanceOfPartyB(losing.address, user.address)).to.equal(before)
		await c.partyALiquidationFacet.settlePartyALiquidation(user.address, [flat.address, losing.address])
		expect(await c.viewFacet.allocatedBalanceOfPartyB(losing.address, user.address)).to.equal(before + decimal(1500n) - deficit)
	})
})
