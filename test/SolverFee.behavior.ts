import { expect } from "chai"
import { ethers } from "ethers"

import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, unDecimal } from "./utils/Common.js"
import { getDummyPairUpnlAndPriceSig, getDummySingleUpnlAndPriceSig, getDummySingleUpnlSig } from "./utils/SignatureUtils.js"

const SEND_QUOTE_WITH_DATA_AND_FEE_CAPS =
	"sendQuote(address[],uint256,uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,(bytes,uint256,int256,uint256,bytes,(uint256,address,address)),bytes,(uint256,uint256))"
const SEND_QUOTE_SOLVER_FEE_CAPS_EVENT =
	"event SendQuoteSolverFeeCaps(address indexed partyA,uint256 indexed quoteId,uint256 openRateCap,uint256 closeRateCap)"
const BALANCE_CHANGE_PARTY_A_EVENT = "event BalanceChangePartyA(address indexed partyA,uint256 amount,uint8 _type)"

enum SolverFeeType {
	OPEN,
	CLOSE,
}

enum BalanceChangeType {
	ALLOCATE,
	DEALLOCATE,
	PLATFORM_FEE_IN,
	PLATFORM_FEE_OUT,
	REALIZED_PNL_IN,
	REALIZED_PNL_OUT,
	CVA_IN,
	CVA_OUT,
	LF_IN,
	LF_OUT,
	FUNDING_FEE_IN,
	FUNDING_FEE_OUT,
	DEFERRED_BALANCE_IN,
	DEFERRED_BALANCE_OUT,
	REIMBURSEMENT_IN,
	OPERATIONAL_FEE_OUT,
	OPEN_SOLVER_FEE_OUT,
	CLOSE_SOLVER_FEE_OUT,
}

const encodeData = (value: string) => ethers.AbiCoder.defaultAbiCoder().encode(["string"], [value])
const sendQuoteSolverFeeCapsInterface = new ethers.Interface([SEND_QUOTE_SOLVER_FEE_CAPS_EVENT])
const partyABalanceChangeInterface = new ethers.Interface([BALANCE_CHANGE_PARTY_A_EVENT])

export function shouldBehaveLikeSolverFee(): void {
	let context: RunContext, user: User, hedger: Hedger

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)

		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(3000n), decimal(2000n), decimal(1500n))

		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(4000n), decimal(4000n))
	})

	async function sendQuoteWithSolverFeeCaps(
		openRateCap: bigint,
		data: string = "solver-fee-test",
		partyBAddress?: string,
		closeRateCap: bigint = openRateCap,
	): Promise<bigint> {
		const request = limitQuoteRequestBuilder()
			.partyBWhiteList([partyBAddress ?? (await hedger.getAddress())])
			.upnlSig(getDummySingleUpnlAndPriceSig(decimal(1n)))
			.build()
		const args = [
			request.partyBWhiteList,
			request.symbolId,
			request.positionType,
			request.orderType,
			request.price,
			request.quantity,
			request.cva,
			request.lf,
			request.partyAmm,
			request.partyBmm,
			await request.deadline,
			await context.accountManager.getAddress(),
			await request.upnlSig,
			encodeData(data),
			[openRateCap, closeRateCap],
		]
		const sendQuote = (context.partyAFacet.connect(user.signer) as any)[SEND_QUOTE_WITH_DATA_AND_FEE_CAPS]
		const quoteId = await sendQuote.staticCall(...args)
		await sendQuote(...args)
		return quoteId
	}

	async function openQuote(quoteId: bigint, filledAmount?: bigint, openedPrice: bigint = decimal(1n)) {
		await hedger.lockQuote(quoteId)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		await hedger.openPosition(
			quoteId,
			limitOpenRequestBuilder()
				.filledAmount(filledAmount ?? quote.quantity)
				.openPrice(openedPrice)
				.price(openedPrice)
				.build(),
		)
	}

	async function requestClose(quoteId: bigint, quantityToClose?: bigint, closePrice: bigint = decimal(1n)) {
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		await user.requestToClosePosition(
			quoteId,
			limitCloseRequestBuilder()
				.quantityToClose(quantityToClose ?? quote.quantity - quote.closedAmount)
				.closePrice(closePrice)
				.build(),
		)
	}

	async function fillClose(quoteId: bigint, amount?: bigint, closedPrice: bigint = decimal(1n)) {
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		await hedger.fillCloseRequest(
			quoteId,
			limitFillCloseRequestBuilder()
				.filledAmount(amount ?? quote.quantityToClose)
				.closedPrice(closedPrice)
				.price(closedPrice)
				.build(),
		)
	}

	function chargeSolverFee(quoteId: bigint, feeType: SolverFeeType, amount: bigint, tag: string, signer = hedger.signer) {
		return (context.partyBExecutionFacet.connect(signer) as any).chargeSolverFee(quoteId, feeType, amount, tag)
	}

	async function getSolverFeeState(quoteId: bigint) {
		return (context.viewFacetQuote as any).getSolverFeeState(quoteId)
	}

	async function getPartyABalanceChangeEvents(tx: any) {
		const receipt = await tx.wait()
		return receipt.logs.flatMap((log: any) => {
			try {
				const parsed = partyABalanceChangeInterface.parseLog(log)
				if (parsed?.name !== "BalanceChangePartyA") return []
				return [{ partyA: parsed.args.partyA as string, amount: parsed.args.amount as bigint, changeType: parsed.args._type as bigint }]
			} catch {
				return []
			}
		})
	}

	async function setupPartyBContract(): Promise<string> {
		const partyBAddress = await context.symmioPartyB.getAddress()

		await context.controlFacet.connect(context.signers.admin).registerPartyB(partyBAddress)
		await context.symbolControlFacet.connect(context.signers.admin).whitelistSymbolType(partyBAddress, 1)
		await context.collateral.connect(context.signers.admin).mint(partyBAddress, decimal(8000n))
		await context.symmioPartyB.connect(context.signers.admin)._approve(await context.collateral.getAddress(), ethers.MaxUint256)

		const collateral = await context.viewFacet.getCollateral()
		const depositCall = context.accountFacet.interface.encodeFunctionData("deposit", [decimal(4000n)])
		const pledgeCall = context.pledgeFacet.interface.encodeFunctionData("depositPledge", [collateral, decimal(4000n)])
		await context.symmioPartyB.connect(context.signers.admin)._call([depositCall, pledgeCall])

		return partyBAddress
	}

	it("stores immutable open and close caps with the quote data", async function () {
		const openRateCap = decimal(2n, 16)
		const closeRateCap = decimal(3n, 16)
		const quoteId = await sendQuoteWithSolverFeeCaps(openRateCap, "caps-data", undefined, closeRateCap)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const state = await getSolverFeeState(quoteId)
		const capLogs = await context.signers.user.provider.getLogs({
			address: await context.partyAFacet.getAddress(),
			topics: [sendQuoteSolverFeeCapsInterface.getEvent("SendQuoteSolverFeeCaps")!.topicHash],
		})
		const capEvent = sendQuoteSolverFeeCapsInterface.parseLog(capLogs[capLogs.length - 1])!.args

		expect(ethers.AbiCoder.defaultAbiCoder().decode(["string"], quote.data)[0]).to.equal("caps-data")
		expect(state.openRateCap).to.equal(openRateCap)
		expect(state.closeRateCap).to.equal(closeRateCap)
		expect(capEvent.partyA).to.equal(await user.getAddress())
		expect(capEvent.quoteId).to.equal(quoteId)
		expect(capEvent.openRateCap).to.equal(openRateCap)
		expect(capEvent.closeRateCap).to.equal(closeRateCap)
	})

	it("charges an OPEN fee as a separate tagged balance draw", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16))
		await openQuote(quoteId)
		const tag = ethers.hexlify(ethers.toUtf8Bytes("rfq/open/v1"))
		const partyA = await user.getAddress()
		const partyB = await hedger.getAddress()
		const partyAAllocatedBefore = (await user.getBalanceInfo()).allocatedBalances
		const partyBBalanceBefore = await context.viewFacet.balanceOf(partyB)

		const txPromise = chargeSolverFee(quoteId, SolverFeeType.OPEN, decimal(1n), tag)
		await expect(txPromise)
			.to.emit(context.partyBExecutionFacet, "SolverFeeCharged")
			.withArgs(quoteId, partyA, partyB, partyB, 1n, SolverFeeType.OPEN, decimal(1n), tag)
		const balanceEvents = await getPartyABalanceChangeEvents(await txPromise)

		expect(partyAAllocatedBefore - (await user.getBalanceInfo()).allocatedBalances).to.equal(decimal(1n))
		expect((await context.viewFacet.balanceOf(partyB)) - partyBBalanceBefore).to.equal(decimal(1n))
		expect((await getSolverFeeState(quoteId)).openFeeCharged).to.equal(decimal(1n))
		expect(
			balanceEvents.some(
				(event: any) => event.partyA === partyA && event.amount === decimal(1n) && event.changeType === BigInt(BalanceChangeType.OPEN_SOLVER_FEE_OUT),
			),
		).to.equal(true)
	})

	it("does not ask Muon for a signature or preserve post-fee solvency", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(100n))
		await openQuote(quoteId)
		const before = await user.getBalanceInfo()
		const availableBefore = before.allocatedBalances - before.lockedCva - before.lockedLf
		const fee = availableBefore + 1n
		expect(fee).to.be.lessThanOrEqual(before.allocatedBalances)

		await context.controlFacet.connect(context.signers.admin).setSignatureVerifierAddress(ethers.ZeroAddress)
		await expect(chargeSolverFee(quoteId, SolverFeeType.OPEN, fee, "0x")).to.not.be.reverted

		const after = await user.getBalanceInfo()
		expect(after.allocatedBalances - after.lockedCva - after.lockedLf).to.be.lessThan(0n)
	})

	it("shares the cumulative OPEN cap across tags and rejects zero-cap quotes", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16))
		await openQuote(quoteId)

		await chargeSolverFee(quoteId, SolverFeeType.OPEN, decimal(1n), "0x01")
		await chargeSolverFee(quoteId, SolverFeeType.OPEN, decimal(1n), "0x02")
		await expect(chargeSolverFee(quoteId, SolverFeeType.OPEN, 1n, "0x03")).to.be.revertedWith("SolverFee: Solver fee rate cap exceeded")

		const noFeeQuoteId = await sendQuoteWithSolverFeeCaps(0n)
		await openQuote(noFeeQuoteId)
		await expect(chargeSolverFee(noFeeQuoteId, SolverFeeType.OPEN, 1n, "0x")).to.be.revertedWith("SolverFee: Solver fee rate cap exceeded")
	})

	it("uses only the live close request notional and must be charged before the fill", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(0n, "close-cap", undefined, decimal(2n, 16))
		await openQuote(quoteId)
		await expect(chargeSolverFee(quoteId, SolverFeeType.CLOSE, decimal(1n), "0x11")).to.be.revertedWith("SolverFee: No pending close request")
		await requestClose(quoteId)
		await chargeSolverFee(quoteId, SolverFeeType.CLOSE, decimal(1n), "0x22")
		await chargeSolverFee(quoteId, SolverFeeType.CLOSE, decimal(1n), "0x33")
		await expect(chargeSolverFee(quoteId, SolverFeeType.CLOSE, 1n, "0x33")).to.be.revertedWith("SolverFee: Solver fee rate cap exceeded")

		await fillClose(quoteId)
		const finalQuote = await context.viewFacetQuote.getQuote(quoteId)
		expect(finalQuote.quoteStatus).to.equal(QuoteStatus.CLOSED)
		expect((await getSolverFeeState(quoteId)).closeFeeCharged).to.equal(decimal(2n))
		await expect(chargeSolverFee(quoteId, SolverFeeType.CLOSE, 1n, "0x44")).to.be.revertedWith("Accessibility: Invalid state")
	})

	it("gives each close request its own cap while keeping the quote lifetime total", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(0n, "per-request-close-cap", undefined, decimal(2n, 16))
		await openQuote(quoteId)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		await requestClose(quoteId, quote.quantity / 2n)
		await chargeSolverFee(quoteId, SolverFeeType.CLOSE, decimal(1n), "0x01")
		await fillClose(quoteId)

		expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(QuoteStatus.OPENED)
		await requestClose(quoteId, quote.quantity / 2n)
		await chargeSolverFee(quoteId, SolverFeeType.CLOSE, decimal(1n), "0x02")
		await expect(chargeSolverFee(quoteId, SolverFeeType.CLOSE, 1n, "0x03")).to.be.revertedWith("SolverFee: Solver fee rate cap exceeded")
		expect((await getSolverFeeState(quoteId)).closeFeeCharged).to.equal(decimal(2n))
	})

	it("does not count already closed notional toward a later close request cap", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(0n, "pending-only-close-cap", undefined, decimal(2n, 16))
		await openQuote(quoteId)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const half = quote.quantity / 2n

		await requestClose(quoteId, half)
		await fillClose(quoteId)
		await requestClose(quoteId, half)

		await expect(chargeSolverFee(quoteId, SolverFeeType.CLOSE, decimal(1n) + 1n, "0x01")).to.be.revertedWith(
			"SolverFee: Solver fee rate cap exceeded",
		)
		await expect(chargeSolverFee(quoteId, SolverFeeType.CLOSE, decimal(1n), "0x02")).to.not.be.reverted
	})

	it("requires positive amount, the matching PartyB, enough allocation, and fee-side lifecycle", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(100n))
		await hedger.lockQuote(quoteId)
		await expect(chargeSolverFee(quoteId, SolverFeeType.OPEN, 1n, "0x")).to.be.revertedWith("SolverFee: Quote is not opened")
		await hedger.openPosition(quoteId, limitOpenRequestBuilder().build())
		await expect(chargeSolverFee(quoteId, SolverFeeType.OPEN, 0n, "0x")).to.be.revertedWith("SolverFee: Zero amount")
		await expect(chargeSolverFee(quoteId, SolverFeeType.OPEN, 1n, "0x", context.signers.hedger2)).to.be.revertedWith(
			"Accessibility: Should be partyB of quote",
		)
		const allocated = (await user.getBalanceInfo()).allocatedBalances
		await expect(chargeSolverFee(quoteId, SolverFeeType.OPEN, allocated + 1n, "0x")).to.be.revertedWith("SolverFee: Insufficient allocated balance")
		await expect(chargeSolverFee(quoteId, SolverFeeType.CLOSE, 1n, "0x")).to.be.revertedWith("SolverFee: No pending close request")
	})

	it("rejects OPEN and CLOSE fees while PartyA is suspended", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16))
		await openQuote(quoteId)
		await requestClose(quoteId)
		await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(await user.getAddress())

		const partyAAllocatedBefore = (await user.getBalanceInfo()).allocatedBalances
		const partyBBalanceBefore = await context.viewFacet.balanceOf(await hedger.getAddress())
		await expect(chargeSolverFee(quoteId, SolverFeeType.OPEN, decimal(1n), "0x01")).to.be.revertedWith("SolverFee: Payer suspended")
		await expect(chargeSolverFee(quoteId, SolverFeeType.CLOSE, decimal(1n), "0x02")).to.be.revertedWith("SolverFee: Payer suspended")

		const state = await getSolverFeeState(quoteId)
		expect(state.openFeeCharged).to.equal(0n)
		expect(state.closeFeeCharged).to.equal(0n)
		expect((await user.getBalanceInfo()).allocatedBalances).to.equal(partyAAllocatedBefore)
		expect(await context.viewFacet.balanceOf(await hedger.getAddress())).to.equal(partyBBalanceBefore)
	})

	it("rejects a CLOSE fee after the close request deadline", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(0n, "expiring-close", undefined, decimal(2n, 16))
		await openQuote(quoteId)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const deadline = BigInt(await time.latest()) + 2n
		await user.requestToClosePosition(
			quoteId,
			limitCloseRequestBuilder().quantityToClose(quote.quantity).closePrice(decimal(1n)).deadline(deadline).build(),
		)
		await time.increase(3n)

		const partyAAllocatedBefore = (await user.getBalanceInfo()).allocatedBalances
		const partyBBalanceBefore = await context.viewFacet.balanceOf(await hedger.getAddress())
		await expect(chargeSolverFee(quoteId, SolverFeeType.CLOSE, decimal(1n), "0x01")).to.be.revertedWith("SolverFee: Close request expired")
		await expect(fillClose(quoteId)).to.be.revertedWith("PartyBFacet: Quote is expired")

		expect((await getSolverFeeState(quoteId)).closeFeeCharged).to.equal(0n)
		expect((await user.getBalanceInfo()).allocatedBalances).to.equal(partyAAllocatedBefore)
		expect(await context.viewFacet.balanceOf(await hedger.getAddress())).to.equal(partyBBalanceBefore)
	})

	it("allows a CLOSE fee at the exact close request deadline", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(0n, "deadline-boundary", undefined, decimal(2n, 16))
		await openQuote(quoteId)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const deadline = BigInt(await time.latest()) + 2n
		await user.requestToClosePosition(
			quoteId,
			limitCloseRequestBuilder().quantityToClose(quote.quantity).closePrice(decimal(1n)).deadline(deadline).build(),
		)
		await time.setNextBlockTimestamp(deadline)

		await expect(chargeSolverFee(quoteId, SolverFeeType.CLOSE, decimal(1n), "0x01")).to.not.be.reverted
		expect((await getSolverFeeState(quoteId)).closeFeeCharged).to.equal(decimal(1n))
	})

	it("ignores the open-position pause but respects the general PartyB-actions pause", async function () {
		const admin = context.signers.admin
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16))
		await openQuote(quoteId)
		await context.controlFacet.connect(admin).grantRole(admin, ethers.id("PAUSER_ROLE"))
		await context.controlFacet.connect(admin).grantRole(admin, ethers.id("UNPAUSER_ROLE"))

		await context.pauseControlFacet.connect(admin).pausePartyBOpenPositions()
		await expect(chargeSolverFee(quoteId, SolverFeeType.OPEN, decimal(1n), "0x")).to.not.be.reverted
		await context.pauseControlFacet.connect(admin).pausePartyBActions()
		await expect(chargeSolverFee(quoteId, SolverFeeType.OPEN, decimal(1n), "0x")).to.be.revertedWith("Pausable: PartyB actions paused")
	})

	it("supports separate open and charge operations in one SymmioPartyB batch", async function () {
		const partyBAddress = await setupPartyBContract()
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16), "party-b-batch", partyBAddress)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const notional = unDecimal(quote.quantity * quote.requestedOpenPrice)
		const tag = ethers.hexlify(ethers.toUtf8Bytes("batch/open"))

		const allocateCall = context.partyBAccountFacet.interface.encodeFunctionData("allocateForPartyB", [notional, await user.getAddress()])
		const lockCall = context.partyBQuoteActionsFacet.interface.encodeFunctionData("lockQuote", [quoteId, await getDummySingleUpnlSig(0n)])
		const openCall = context.partyBPositionActionsFacet.interface.encodeFunctionData("openPosition", [
			quoteId,
			quote.quantity,
			quote.requestedOpenPrice,
			await getDummyPairUpnlAndPriceSig(quote.requestedOpenPrice, 0n, 0n),
		])
		const chargeCall = context.partyBExecutionFacet.interface.encodeFunctionData("chargeSolverFee", [quoteId, SolverFeeType.OPEN, decimal(1n), tag])

		await expect(context.symmioPartyB.connect(context.signers.admin)._call([allocateCall, lockCall, openCall, chargeCall]))
			.to.emit(context.partyBExecutionFacet, "SolverFeeCharged")
			.withArgs(quoteId, await user.getAddress(), partyBAddress, partyBAddress, 1n, SolverFeeType.OPEN, decimal(1n), tag)
		expect((await getSolverFeeState(quoteId)).openFeeCharged).to.equal(decimal(1n))
	})

	it("copies both caps to a child quote created by a partial open", async function () {
		const openRateCap = decimal(4n, 16)
		const closeRateCap = decimal(6n, 16)
		const quoteId = await sendQuoteWithSolverFeeCaps(openRateCap, "child-caps", undefined, closeRateCap)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		await openQuote(quoteId, quote.quantity / 4n)

		const quoteIds = await context.viewFacetQuote.quoteIdsOf(await user.getAddress(), 0, 2)
		const childState = await getSolverFeeState(quoteIds[1])
		expect(childState.openRateCap).to.equal(openRateCap)
		expect(childState.closeRateCap).to.equal(closeRateCap)
	})

	it("installs only the standalone charge and fee-less combined-open selectors", async function () {
		const installed = async (signature: string) =>
			(await context.diamondLoupeFacet.facetAddress(ethers.id(signature).slice(0, 10))) !== ethers.ZeroAddress
		const pairSig = "(bytes,uint256,int256,int256,uint256,bytes,(uint256,address,address))"
		const singleSig = "(bytes,uint256,int256,bytes,(uint256,address,address))"

		expect(await installed("chargeSolverFee(uint256,uint8,uint256,bytes)")).to.equal(true)
		expect(await installed(`lockAndOpenPosition(uint256,uint256,uint256,${singleSig},${pairSig})`)).to.equal(true)
		expect(await installed(`openPosition(uint256,uint256,uint256,${pairSig},uint256)`)).to.equal(false)
		expect(await installed(`fillCloseRequest(uint256,uint256,uint256,${pairSig},uint256)`)).to.equal(false)
		expect(await installed(`fillCloseRequestToLiquidation(uint256,uint256,uint256,${pairSig},uint256)`)).to.equal(false)
		expect(await installed(`lockAndOpenPosition(uint256,uint256,uint256,${singleSig},${pairSig},uint256)`)).to.equal(false)
		expect(await installed(`fillCloseRequestToLiquidation(uint256,uint256,${pairSig})`)).to.equal(true)
		expect(await installed("liquidatePositionsForClearingHouse(address,uint256[],uint256[])")).to.equal(true)
		expect(await installed("liquidatePositionsForClearingHouse(address,uint256[],uint256[],uint256[])")).to.equal(false)
	})

	describe("tagged receiver routing", function () {
		it("falls back from tag receiver to the default receiver and then PartyB", async function () {
			const partyB = await hedger.getAddress()
			const tag = ethers.hexlify(ethers.toUtf8Bytes("affiliate/desk-7"))
			expect(await (context.viewFacet as any).getSolverFeeReceiverForTag(partyB, tag)).to.equal(partyB)

			await (context.controlFacet.connect(hedger.signer) as any).setSolverFeeReceiver(partyB, context.signers.feeCollector.address)
			expect(await (context.viewFacet as any).getSolverFeeReceiverForTag(partyB, tag)).to.equal(context.signers.feeCollector.address)

			await expect((context.controlFacet.connect(hedger.signer) as any).setSolverFeeReceiverForTag(partyB, tag, context.signers.liquidator.address))
				.to.emit(context.controlFacet, "SetSolverFeeReceiverForTag")
				.withArgs(partyB, context.signers.liquidator.address, tag)
			expect(await (context.viewFacet as any).getSolverFeeReceiverForTag(partyB, tag)).to.equal(context.signers.liquidator.address)

			await (context.controlFacet.connect(hedger.signer) as any).setSolverFeeReceiverForTag(partyB, tag, ethers.ZeroAddress)
			expect(await (context.viewFacet as any).getSolverFeeReceiverForTag(partyB, tag)).to.equal(context.signers.feeCollector.address)
		})

		it("routes each tag independently while keeping one cumulative cap", async function () {
			const partyB = await hedger.getAddress()
			const tagA = "0xaabb"
			const tagB = "0xccdd"
			await (context.controlFacet.connect(hedger.signer) as any).setSolverFeeReceiverForTag(partyB, tagA, context.signers.feeCollector.address)
			await (context.controlFacet.connect(hedger.signer) as any).setSolverFeeReceiverForTag(partyB, tagB, context.signers.liquidator.address)
			const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16))
			await openQuote(quoteId)
			const receiverABefore = await context.viewFacet.balanceOf(context.signers.feeCollector.address)
			const receiverBBefore = await context.viewFacet.balanceOf(context.signers.liquidator.address)

			await chargeSolverFee(quoteId, SolverFeeType.OPEN, decimal(1n), tagA)
			await chargeSolverFee(quoteId, SolverFeeType.OPEN, decimal(1n), tagB)

			expect(await context.viewFacet.balanceOf(context.signers.feeCollector.address)).to.equal(receiverABefore + decimal(1n))
			expect(await context.viewFacet.balanceOf(context.signers.liquidator.address)).to.equal(receiverBBefore + decimal(1n))
			expect((await getSolverFeeState(quoteId)).openFeeCharged).to.equal(decimal(2n))
		})

		it("lets PartyB manager configure a tag and rejects unrelated callers", async function () {
			const partyB = await hedger.getAddress()
			const tag = "0x123456"
			await expect(
				(context.controlFacet.connect(context.signers.admin) as any).setSolverFeeReceiverForTag(partyB, tag, context.signers.feeCollector.address),
			).to.not.be.reverted
			await expect(
				(context.controlFacet.connect(user.signer) as any).setSolverFeeReceiverForTag(partyB, tag, context.signers.liquidator.address),
			).to.be.revertedWith("ControlFacet: Not authorized")
		})

		it("rejects a tagged receiver that routes the fee back to PartyA", async function () {
			const partyB = await hedger.getAddress()
			const tag = "0x99"
			await (context.controlFacet.connect(hedger.signer) as any).setSolverFeeReceiverForTag(partyB, tag, await user.getAddress())
			const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16))
			await openQuote(quoteId)
			await expect(chargeSolverFee(quoteId, SolverFeeType.OPEN, decimal(1n), tag)).to.be.revertedWith("SolverFee: Receiver is partyA")
		})
	})
}
