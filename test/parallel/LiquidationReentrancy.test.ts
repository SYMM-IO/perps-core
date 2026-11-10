import { expect } from "chai"
import { ethers as ethersLib } from "ethers"

import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture } from "../helpers/network-helpers.js"
import { LiquidationType } from "../models/Enums.js"
import { Hedger } from "../models/Hedger.js"
import { User } from "../models/User.js"
import { limitOpenRequestBuilder } from "../models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal } from "../utils/Common.js"
import { conservationOracle } from "../utils/ConservationOracle.js"
import { getDummyLiquidationSig, getDummyPriceSig, getDummySingleUpnlAndPriceSig, getDummySingleUpnlSig } from "../utils/SignatureUtils.js"

type StartPath = "legacy" | "snapshot"

async function scenario(
	options: {
		path?: StartPath
		upnl?: bigint
		price?: bigint
		allocatedTarget?: bigint
		pendingQuotes?: number
		secondPosition?: boolean
		start?: boolean
	} = {},
) {
	const context = await loadFixture(initializeFixture)
	const user = new User(context, context.signers.user)
	await user.setup()
	await user.setBalances(decimal(2000n), decimal(1000n), decimal(500n))
	const hedger = new Hedger(context, context.signers.hedger)
	await hedger.setup()
	await hedger.setBalances(decimal(5000n), decimal(5000n))
	const quoteId = await user.sendQuote(
		limitQuoteRequestBuilder()
			.price(decimal(10n))
			.quantity(decimal(10n))
			.cva(decimal(40n))
			.lf(decimal(10n))
			.partyAmm(decimal(20n))
			.upnlSig(getDummySingleUpnlAndPriceSig(decimal(10n)))
			.build(),
	)
	await hedger.lockQuote(quoteId)
	await hedger.openPosition(quoteId, limitOpenRequestBuilder().filledAmount(decimal(10n)).openPrice(decimal(10n)).price(decimal(10n)).build())
	let secondQuoteId = 0n
	if (options.secondPosition) {
		secondQuoteId = await user.sendQuote(
			limitQuoteRequestBuilder()
				.price(decimal(10n))
				.quantity(decimal(1n))
				.cva(decimal(4n))
				.lf(decimal(1n))
				.partyAmm(decimal(2n))
				.upnlSig(getDummySingleUpnlAndPriceSig(decimal(10n)))
				.build(),
		)
		await hedger.lockQuote(secondQuoteId, 0n, decimal(10n))
		await hedger.openPosition(secondQuoteId, limitOpenRequestBuilder().filledAmount(decimal(1n)).openPrice(decimal(10n)).price(decimal(10n)).build())
	}
	const pendingQuoteIds: bigint[] = []
	for (let i = 0; i < (options.pendingQuotes ?? 0); i++) {
		pendingQuoteIds.push(
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.price(decimal(10n))
					.quantity(decimal(1n))
					.cva(decimal(4n))
					.lf(decimal(1n))
					.partyAmm(decimal(2n))
					.upnlSig(getDummySingleUpnlAndPriceSig(decimal(10n)))
					.build(),
			),
		)
	}
	const allocatedTarget = options.allocatedTarget ?? decimal(100n)
	const allocated = await context.viewFacet.allocatedBalanceOfPartyA(user.address)
	await context.accountFacet.connect(user.signer).deallocate(allocated - allocatedTarget, await getDummySingleUpnlSig(0n))
	const hook = await (await ethers.getContractFactory("LiquidationReentryHook")).deploy(context.diamond)
	await context.controlFacet.registerHook(await context.accountManager.getAddress(), hook.target)
	const liquidation = context.partyALiquidationFacet.connect(context.signers.liquidator)
	const snapshotLiquidation = context.partyALiquidationSnapshotFacet.connect(context.signers.liquidator)
	const price = options.price ?? decimal(2n)
	const upnl = options.upnl ?? -decimal(80n)
	const sig = await getDummyLiquidationSig("0x10", upnl, [1n], [price], upnl, allocatedTarget)
	const snapshotSig = {
		reqId: sig.reqId,
		timestamp: sig.timestamp,
		liquidationId: sig.liquidationId,
		upnl: sig.upnl,
		totalUnrealizedLoss: sig.totalUnrealizedLoss,
		states: [{ partyB: hedger.address, symbolId: 1n, price, cumulativeLongFee: 0n, cumulativeShortFee: 0n }],
		liquidationBlockNumber: sig.liquidationBlockNumber,
		liquidationTimestamp: sig.liquidationTimestamp,
		liquidationAllocatedBalance: sig.liquidationAllocatedBalance,
		gatewaySignature: sig.gatewaySignature,
		sigs: sig.sigs,
	}
	const path = options.path ?? "legacy"
	if (options.start !== false) {
		if (path === "legacy") {
			await liquidation.liquidatePartyA(user.address, sig)
			await liquidation.setSymbolsPrice(user.address, sig)
		} else {
			await snapshotLiquidation.liquidatePartyAWithSnapshot(user.address, { ...snapshotSig, states: [] })
			await snapshotLiquidation.setSymbolsPriceWithSnapshot(user.address, snapshotSig)
		}
	}
	return { context, user, hedger, hook, quoteId, secondQuoteId, pendingQuoteIds, liquidation, snapshotLiquidation }
}

async function expectConserved(context: any, user: any, hedger: any, quoteIds: bigint[]) {
	const ledger = await conservationOracle(context, { partyAs: [user.address], partyBs: [hedger.address], quoteIds })
	expect(ledger.diff).to.equal(0n)
}

describe("PartyA liquidation callbacks", function () {
	// Close and cancel hooks run as each quote closes. The close that ends PartyA's position list fixes the
	// settlement plan before its hook runs, so a hook never sees every position closed with the plan unfinished.
	const settleCall = (liquidation: any, partyA: string, partyBs: string[]) =>
		liquidation.interface.encodeFunctionData("settlePartyALiquidation", [partyA, partyBs])
	const payoutSince = async (context: any, hedger: any, user: any, before: bigint) =>
		(await context.viewFacet.allocatedBalanceOfPartyB(hedger.address, user.address)) - before
	const errorData = (reason: string) => "0x08c379a0" + ethersLib.AbiCoder.defaultAbiCoder().encode(["string"], [reason]).slice(2)

	it("rejects PartyA liquidation against an already-liquidating PartyB without blocking PartyB completion", async function () {
		const { context, user, hedger, quoteId, liquidation } = await scenario({ start: false })
		// Positive uPNL can back legacy deallocation; a later price change leaves the isolated payer undercollateralized.
		const allocation = await context.viewFacet.allocatedBalanceOfPartyB(hedger.address, user.address)
		await context.partyBAccountFacet
			.connect(hedger.signer)
			.deallocateForPartyB(allocation - decimal(10n), user.address, await getDummySingleUpnlSig(decimal(100n)))
		const partyBLiquidation = context.partyBLiquidationFacet.connect(context.signers.liquidator)
		await partyBLiquidation.liquidatePartyB(hedger.address, user.address, await getDummySingleUpnlSig(0n))
		expect(await context.viewFacet.isPartyBLiquidated(hedger.address, user.address)).to.equal(true)
		const currentAllocation = await context.viewFacet.allocatedBalanceOfPartyA(user.address)
		const sig = await getDummyLiquidationSig("0x11", -decimal(80n), [1n], [decimal(2n)], -decimal(80n), currentAllocation)
		await expect(liquidation.liquidatePartyA(user.address, sig)).to.be.revertedWith("PartyBState: PartyB is in liquidation")
		expect(await context.viewFacet.isPartyALiquidated(user.address)).to.equal(false)
		const prices = await getDummyPriceSig([quoteId], [decimal(10n)])
		prices.timestamp = await context.viewFacet.partyBLiquidationTimestamp(hedger.address, user.address)
		await partyBLiquidation.liquidatePositionsPartyB(hedger.address, user.address, prices)
		expect(await context.viewFacet.isPartyBLiquidated(hedger.address, user.address)).to.equal(false)
		expect(await context.viewFacetQuote.partyAPositionsCount(user.address)).to.equal(0n)
		await expectConserved(context, user, hedger, [quoteId])
	})

	it("calls each close hook at its own close within a batch", async function () {
		const { context, user, hedger, hook, quoteId, secondQuoteId, liquidation } = await scenario({ secondPosition: true, upnl: -decimal(88n) })
		await hook.configure([context.viewFacetQuote.interface.encodeFunctionData("partyAPositionsCount", [user.address])], false)
		await liquidation.liquidatePositionsPartyA(user.address, [quoteId, secondQuoteId])
		// The first hook still sees the second position open; only the last close's hook sees the list empty.
		const seen = [await hook.results(0), await hook.results(1)].map(data => ethersLib.AbiCoder.defaultAbiCoder().decode(["uint256"], data)[0])
		expect(seen).to.deep.equal([1n, 0n])
		await liquidation.settlePartyALiquidation(user.address, [hedger.address])
		expect(await context.viewFacet.isPartyALiquidated(user.address)).to.equal(false)
		await expectConserved(context, user, hedger, [quoteId, secondQuoteId])
	})

	it("lets a last-close hook settle only the planned LATE amounts", async function () {
		const { context, user, hedger, hook, quoteId, liquidation } = await scenario()
		expect((await user.getLiquidatedStateOfPartyA()).liquidationType).to.equal(BigInt(LiquidationType.LATE))
		const before = await context.viewFacet.allocatedBalanceOfPartyB(hedger.address, user.address)
		await hook.configure([settleCall(liquidation, user.address, [hedger.address])], false)
		await liquidation.liquidatePositionsPartyA(user.address, [quoteId])
		expect(await hook.succeeded(0)).to.equal(true)
		// Allocation 100 after an 80 loss leaves 20 of the 40 locked CVA. The raw bucket would pay 120.
		expect(await payoutSince(context, hedger, user, before)).to.equal(decimal(100n))
		expect(await context.viewFacet.isPartyALiquidated(user.address)).to.equal(false)
		await expectConserved(context, user, hedger, [quoteId])
	})

	it("lets a last-close hook settle only the planned OVERDUE deficit share", async function () {
		const { context, user, hedger, hook, quoteId, liquidation } = await scenario({
			price: decimal(1n, 17),
			upnl: -decimal(99n),
			allocatedTarget: decimal(90n),
		})
		expect((await user.getLiquidatedStateOfPartyA()).liquidationType).to.equal(BigInt(LiquidationType.OVERDUE))
		const before = await context.viewFacet.allocatedBalanceOfPartyB(hedger.address, user.address)
		await hook.configure([settleCall(liquidation, user.address, [hedger.address])], false)
		await liquidation.liquidatePositionsPartyA(user.address, [quoteId])
		expect(await hook.succeeded(0)).to.equal(true)
		expect(await payoutSince(context, hedger, user, before)).to.equal(decimal(90n))
		expect(await context.viewFacet.isPartyALiquidated(user.address)).to.equal(false)
		await expectConserved(context, user, hedger, [quoteId])
	})

	it("keeps a disputed plan unsettleable from the last-close hook until resolution", async function () {
		const { context, user, hedger, hook, quoteId, liquidation } = await scenario({ upnl: -decimal(70n) })
		await hook.configure([settleCall(liquidation, user.address, [hedger.address])], false)
		await liquidation.liquidatePositionsPartyA(user.address, [quoteId])
		expect(await hook.succeeded(0)).to.equal(false)
		expect(await hook.results(0)).to.equal(errorData("LiquidationFacet: PartyA liquidation process get disputed"))
		expect((await user.getLiquidatedStateOfPartyA()).disputed).to.equal(true)
		const [planned] = await context.viewFacet.getSettlementStates(user.address, [hedger.address])
		expect(planned.cva).to.equal(decimal(30n))
		const before = await context.viewFacet.allocatedBalanceOfPartyB(hedger.address, user.address)
		await context.partyALiquidationFacet
			.connect(context.signers.admin)
			.resolveLiquidationDispute(user.address, [hedger.address], [-decimal(70n)], false)
		await liquidation.settlePartyALiquidation(user.address, [hedger.address])
		expect(await payoutSince(context, hedger, user, before)).to.equal(decimal(100n))
		expect(await context.viewFacet.isPartyALiquidated(user.address)).to.equal(false)
		await expectConserved(context, user, hedger, [quoteId])
	})

	for (const path of ["legacy", "snapshot"] as const) {
		it(`gives a re-entering liquidator the final plan after a ${path} last close`, async function () {
			const { context, user, hedger, hook, quoteId, liquidation, snapshotLiquidation } = await scenario({ path })
			await context.controlFacet.grantRole(hook.target, ethersLib.id("LIQUIDATOR_ROLE"))
			const family = path === "legacy" ? liquidation : snapshotLiquidation
			const liquidatePositions = path === "legacy" ? "liquidatePositionsPartyA" : "liquidatePositionsPartyAWithSnapshot"
			const before = await context.viewFacet.allocatedBalanceOfPartyB(hedger.address, user.address)
			await hook.configure(
				[
					family.interface.encodeFunctionData(liquidatePositions, [user.address, [quoteId]]),
					settleCall(liquidation, user.address, [hedger.address]),
					snapshotLiquidation.interface.encodeFunctionData("settlePartyALiquidationWithSnapshot", [user.address, [hedger.address]]),
				],
				false,
			)
			await family[liquidatePositions](user.address, [quoteId])
			// The position is already closed, the first settlement pays the plan, and the second finds nothing left.
			expect([await hook.succeeded(0), await hook.succeeded(1), await hook.succeeded(2)]).to.deep.equal([false, true, false])
			expect(await payoutSince(context, hedger, user, before)).to.equal(decimal(100n))
			expect(await context.viewFacet.isPartyALiquidated(user.address)).to.equal(false)
			await expectConserved(context, user, hedger, [quoteId])
		})
	}

	it("lets a cancellation hook settle only once the last pending quote is gone", async function () {
		const { context, user, hedger, hook, quoteId, pendingQuoteIds, liquidation } = await scenario({ pendingQuotes: 2 })
		await hook.configure([], false)
		await liquidation.liquidatePositionsPartyA(user.address, [quoteId])
		const before = await context.viewFacet.allocatedBalanceOfPartyB(hedger.address, user.address)
		await hook.configure([settleCall(liquidation, user.address, [hedger.address])], true)
		await liquidation.liquidatePendingPositionsPartyA(user.address)
		// Each callback runs as its quote is cancelled: the first still sees one pending quote, the second sees none.
		expect([await hook.succeeded(0), await hook.succeeded(1)]).to.deep.equal([false, true])
		expect(await hook.results(0)).to.equal(errorData("LiquidationFacet: PartyA has still open positions"))
		expect(await payoutSince(context, hedger, user, before)).to.equal(decimal(100n))
		expect(await context.viewFacet.isPartyALiquidated(user.address)).to.equal(false)
		await expectConserved(context, user, hedger, [quoteId, ...pendingQuoteIds])
	})

	it("runs the liquidation-settled hook after finalization", async function () {
		const { context, user, hedger, hook, quoteId, liquidation, snapshotLiquidation } = await scenario()
		await context.controlFacet.registerHook(ethers.ZeroAddress, hook.target)
		await hook.configure([], false)
		await liquidation.liquidatePositionsPartyA(user.address, [quoteId])
		await hook.configure(
			[
				settleCall(liquidation, user.address, [hedger.address]),
				snapshotLiquidation.interface.encodeFunctionData("settlePartyALiquidationWithSnapshot", [user.address, [hedger.address]]),
			],
			false,
		)
		await liquidation.settlePartyALiquidation(user.address, [hedger.address])
		for (const i of [0, 1]) {
			expect(await hook.succeeded(i)).to.equal(false)
			expect(await hook.results(i)).to.equal(errorData("LiquidationFacet: PartyA is solvent"))
		}
		expect(await context.viewFacet.isPartyALiquidated(user.address)).to.equal(false)
		await expectConserved(context, user, hedger, [quoteId])
	})
})
