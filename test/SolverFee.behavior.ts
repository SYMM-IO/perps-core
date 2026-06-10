import { expect } from "chai"
import { ethers } from "ethers"

import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { OrderType, PositionType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp, unDecimal } from "./utils/Common.js"
import { getDummyPairUpnlAndPriceSig, getDummySingleUpnlAndPriceSig, getDummySingleUpnlSig } from "./utils/SignatureUtils.js"

const RICH_SEND_QUOTE =
	"sendQuote(address[],uint256,uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,(bytes,uint256,int256,uint256,bytes,(uint256,address,address)),bytes,(uint256,uint256,uint256))"
const OPEN_POSITION_WITH_FEE =
	"openPosition(uint256,uint256,uint256,(bytes,uint256,int256,int256,uint256,bytes,(uint256,address,address)),uint256,uint256)"
const FILL_CLOSE_REQUEST_WITH_FEE =
	"fillCloseRequest(uint256,uint256,uint256,(bytes,uint256,int256,int256,uint256,bytes,(uint256,address,address)),uint256,uint256)"
const FILL_CLOSE_TO_LIQUIDATION =
	"fillCloseRequestToLiquidation(uint256,uint256,(bytes,uint256,int256,int256,uint256,bytes,(uint256,address,address)))"
const FILL_CLOSE_TO_LIQUIDATION_WITH_FEE =
	"fillCloseRequestToLiquidation(uint256,uint256,(bytes,uint256,int256,int256,uint256,bytes,(uint256,address,address)),uint256,uint256)"
const SEND_QUOTE_SOLVER_FEE_CAPS_EVENT =
	"event SendQuoteSolverFeeCaps(address indexed partyA,uint256 indexed quoteId,uint256 maxOperationalFee,uint256 maxOpenSolverFeeRate,uint256 maxCloseSolverFeeRate)"
const BALANCE_CHANGE_PARTY_A_EVENT = "event BalanceChangePartyA(address indexed partyA,uint256 amount,uint8 _type)"

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

const ZERO_SOLVER_FEE_RATE = 0n

const encodeData = (value: string) => ethers.AbiCoder.defaultAbiCoder().encode(["string"], [value])
const sendQuoteSolverFeeCapsInterface = new ethers.Interface([SEND_QUOTE_SOLVER_FEE_CAPS_EVENT])
const balanceChangeInterface = new ethers.Interface([BALANCE_CHANGE_PARTY_A_EVENT])

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

	async function sendQuoteWithSolverFeeRates(
		maxOperationalFee: bigint,
		maxOpenSolverFeeRate: bigint,
		data: string = "solver-fee-test",
		partyBAddress?: string,
		maxCloseSolverFeeRate: bigint = maxOpenSolverFeeRate,
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
			[maxOperationalFee, maxOpenSolverFeeRate, maxCloseSolverFeeRate],
		]
		const sendQuote = (context.partyAFacet.connect(user.signer) as any)[RICH_SEND_QUOTE]
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

	async function requestClose(quoteId: bigint) {
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		await user.requestToClosePosition(
			quoteId,
			limitCloseRequestBuilder()
				.quantityToClose(quote.quantity - quote.closedAmount)
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

	async function partyAAvailableForLiquidation(upnl: bigint): Promise<bigint> {
		const balanceInfo = await user.getBalanceInfo()
		return balanceInfo.allocatedBalances - balanceInfo.lockedCva - balanceInfo.lockedLf + upnl
	}

	async function upnlForTargetAvailableAfterOpen(quoteId: bigint, targetAvailable: bigint): Promise<bigint> {
		const balanceInfo = await user.getBalanceInfo()
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		return (
			targetAvailable -
			(balanceInfo.allocatedBalances - balanceInfo.lockedCva - balanceInfo.lockedLf - quote.lockedValues.cva - quote.lockedValues.lf)
		)
	}

	async function getSolverFeeState(quoteId: bigint) {
		return (context.viewFacetQuote as any).getSolverFeeState(quoteId)
	}

	async function getPartyABalanceChangeEvents(tx: any) {
		const receipt = await tx.wait()
		return receipt.logs.flatMap((log: any) => {
			try {
				const parsed = balanceChangeInterface.parseLog(log)
				if (parsed?.name !== "BalanceChangePartyA") return []
				return [
					{
						partyA: parsed.args.partyA as string,
						amount: parsed.args.amount as bigint,
						changeType: parsed.args._type as bigint,
					},
				]
			} catch {
				return []
			}
		})
	}

	async function openQuoteWithFees(
		quoteId: bigint,
		operationalFee: bigint,
		solverFee: bigint,
		filledAmount?: bigint,
		openedPrice: bigint = decimal(1n),
		upnlPartyA: bigint = 0n,
		upnlPartyB: bigint = 0n,
	) {
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const openWithFee = (context.partyBSolverFeeActionsFacet.connect(hedger.signer) as any)[OPEN_POSITION_WITH_FEE]
		return openWithFee(
			quoteId,
			filledAmount ?? quote.quantity,
			openedPrice,
			await getDummyPairUpnlAndPriceSig(openedPrice, upnlPartyA, upnlPartyB),
			operationalFee,
			solverFee,
		)
	}

	async function fillCloseWithFees(
		quoteId: bigint,
		operationalFee: bigint,
		solverFee: bigint,
		filledAmount?: bigint,
		closedPrice: bigint = decimal(1n),
		upnlPartyA: bigint = 0n,
		upnlPartyB: bigint = 0n,
	) {
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const fillWithFee = (context.partyBSolverFeeActionsFacet.connect(hedger.signer) as any)[FILL_CLOSE_REQUEST_WITH_FEE]
		return fillWithFee(
			quoteId,
			filledAmount ?? quote.quantityToClose,
			closedPrice,
			await getDummyPairUpnlAndPriceSig(closedPrice, upnlPartyA, upnlPartyB),
			operationalFee,
			solverFee,
		)
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

	it("stores immutable open and close solver fee caps with custom data on the new sendQuote API", async function () {
		const maxOperationalFee = decimal(1n)
		const maxOpenSolverFeeRate = decimal(2n, 16)
		const maxCloseSolverFeeRate = decimal(3n, 16)

		const quoteId = await sendQuoteWithSolverFeeRates(maxOperationalFee, maxOpenSolverFeeRate, "caps-data", undefined, maxCloseSolverFeeRate)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const state = await getSolverFeeState(quoteId)
		const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["string"], quote.data)
		const sendQuoteEvents = await context.partyAFacet.queryFilter(
			context.partyAFacet.filters["SendQuote(address,uint256,address[],address,bytes,bytes)"](),
		)
		const sendQuoteEvent = sendQuoteEvents[sendQuoteEvents.length - 1].args
		const capLogs = await context.signers.user.provider.getLogs({
			address: await context.partyAFacet.getAddress(),
			topics: [sendQuoteSolverFeeCapsInterface.getEvent("SendQuoteSolverFeeCaps")!.topicHash],
		})
		const capEvent = sendQuoteSolverFeeCapsInterface.parseLog(capLogs[capLogs.length - 1])!.args
		const decodedEventParams = ethers.AbiCoder.defaultAbiCoder().decode(
			["uint256", "uint8", "uint8", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
			sendQuoteEvent.paramsData,
		)

		expect(decoded[0]).to.equal("caps-data")
		expect(sendQuoteEvent.quoteId).to.equal(quoteId)
		expect((sendQuoteEvent.paramsData.length - 2) / 64).to.equal(12)
		expect(capEvent.partyA).to.equal(await user.getAddress())
		expect(capEvent.quoteId).to.equal(quoteId)
		expect(state.maxOperationalFee).to.equal(maxOperationalFee)
		expect(state.maxOpenSolverFeeRate).to.equal(maxOpenSolverFeeRate)
		expect(state.maxCloseSolverFeeRate).to.equal(maxCloseSolverFeeRate)
		expect(capEvent.maxOperationalFee).to.equal(maxOperationalFee)
		expect(capEvent.maxOpenSolverFeeRate).to.equal(maxOpenSolverFeeRate)
		expect(capEvent.maxCloseSolverFeeRate).to.equal(maxCloseSolverFeeRate)
	})

	it("charges open operational and solver fees atomically from PartyA allocated balance into PartyB balance", async function () {
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(1n), decimal(2n, 16))
		await hedger.lockQuote(quoteId)

		const partyAAllocatedBefore = (await user.getBalanceInfo()).allocatedBalances
		const partyBBalanceBefore = await context.viewFacet.balanceOf(await hedger.getAddress())
		const partyBAllocatedBefore = (await hedger.getBalanceInfo(await user.getAddress())).allocatedBalances

		const txPromise = openQuoteWithFees(quoteId, decimal(5n, 17), decimal(1n))
		await expect(txPromise)
			.to.emit(context.partyBQuoteActionsFacet, "OperationalFeeCharged")
			.withArgs(quoteId, await user.getAddress(), await hedger.getAddress(), await hedger.getAddress(), 1n, decimal(5n, 17))
			.to.emit(context.partyBQuoteActionsFacet, "OpenSolverFeeCharged")
			.withArgs(quoteId, await user.getAddress(), await hedger.getAddress(), 1n, decimal(1n))
		const balanceEvents = await getPartyABalanceChangeEvents(await txPromise)

		const partyAAllocatedAfter = (await user.getBalanceInfo()).allocatedBalances
		const partyBBalanceAfter = await context.viewFacet.balanceOf(await hedger.getAddress())
		const partyBAllocatedAfter = (await hedger.getBalanceInfo(await user.getAddress())).allocatedBalances
		const state = await getSolverFeeState(quoteId)

		expect(partyAAllocatedBefore - partyAAllocatedAfter).to.equal(decimal(15n, 17))
		expect(partyBBalanceAfter - partyBBalanceBefore).to.equal(decimal(15n, 17))
		expect(partyBAllocatedAfter).to.equal(partyBAllocatedBefore)
		expect(state.chargedOperationalFee).to.equal(decimal(5n, 17))
		expect(state.chargedOpenSolverFee).to.equal(decimal(1n))
		const partyA = await user.getAddress()
		expect(
			balanceEvents.some(
				event => event.partyA === partyA && event.amount === decimal(5n, 17) && event.changeType === BigInt(BalanceChangeType.OPERATIONAL_FEE_OUT),
			),
		).to.equal(true)
		expect(
			balanceEvents.some(
				event => event.partyA === partyA && event.amount === decimal(1n) && event.changeType === BigInt(BalanceChangeType.OPEN_SOLVER_FEE_OUT),
			),
		).to.equal(true)
	})

	it("routes operational fees to the PartyB configured receiver and defaults back to PartyB", async function () {
		const partyB = await hedger.getAddress()
		const receiver = context.signers.feeCollector.address
		const operationalFee = decimal(5n, 17)
		const solverFee = decimal(1n)
		const setReceiver = (context.controlFacet.connect(hedger.signer) as any).setOperationalFeeReceiver
		const setReceiverAsPartyA = (context.controlFacet.connect(user.signer) as any).setOperationalFeeReceiver

		await expect(setReceiverAsPartyA(receiver)).to.be.revertedWith("Accessibility: Should be partyB")

		await expect(setReceiver(receiver)).to.emit(context.controlFacet, "SetOperationalFeeReceiver").withArgs(partyB, receiver)
		expect(await (context.viewFacet as any).getOperationalFeeReceiver(partyB)).to.equal(receiver)

		const quoteId = await sendQuoteWithSolverFeeRates(decimal(1n), decimal(2n, 16))
		await hedger.lockQuote(quoteId)

		const receiverBalanceBefore = await context.viewFacet.balanceOf(receiver)
		const partyBBalanceBefore = await context.viewFacet.balanceOf(partyB)

		await expect(openQuoteWithFees(quoteId, operationalFee, solverFee))
			.to.emit(context.partyBQuoteActionsFacet, "OperationalFeeCharged")
			.withArgs(quoteId, await user.getAddress(), partyB, receiver, 1n, operationalFee)
			.to.emit(context.partyBQuoteActionsFacet, "OpenSolverFeeCharged")
			.withArgs(quoteId, await user.getAddress(), partyB, 1n, solverFee)

		expect((await context.viewFacet.balanceOf(receiver)) - receiverBalanceBefore).to.equal(operationalFee)
		expect((await context.viewFacet.balanceOf(partyB)) - partyBBalanceBefore).to.equal(solverFee)

		await expect(setReceiver(ethers.ZeroAddress)).to.emit(context.controlFacet, "SetOperationalFeeReceiver").withArgs(partyB, ethers.ZeroAddress)
		expect(await (context.viewFacet as any).getOperationalFeeReceiver(partyB)).to.equal(partyB)

		const defaultQuoteId = await sendQuoteWithSolverFeeRates(decimal(1n), ZERO_SOLVER_FEE_RATE)
		await hedger.lockQuote(defaultQuoteId)
		const partyBBalanceBeforeDefault = await context.viewFacet.balanceOf(partyB)

		await openQuoteWithFees(defaultQuoteId, operationalFee, 0n)

		expect((await context.viewFacet.balanceOf(partyB)) - partyBBalanceBeforeDefault).to.equal(operationalFee)
	})

	it("charges close operational and solver fees atomically", async function () {
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(1n), decimal(2n, 16))
		await openQuote(quoteId)
		await requestClose(quoteId)

		const txPromise = fillCloseWithFees(quoteId, decimal(5n, 17), decimal(1n))
		await expect(txPromise)
			.to.emit(context.partyBQuoteActionsFacet, "OperationalFeeCharged")
			.withArgs(quoteId, await user.getAddress(), await hedger.getAddress(), await hedger.getAddress(), 1n, decimal(5n, 17))
			.to.emit(context.partyBQuoteActionsFacet, "CloseSolverFeeCharged")
			.withArgs(quoteId, await user.getAddress(), await hedger.getAddress(), 1n, decimal(1n))
		const balanceEvents = await getPartyABalanceChangeEvents(await txPromise)

		const state = await getSolverFeeState(quoteId)

		expect(state.chargedOperationalFee).to.equal(decimal(5n, 17))
		expect(state.chargedCloseSolverFee).to.equal(decimal(1n))
		const partyA = await user.getAddress()
		expect(
			balanceEvents.some(
				event => event.partyA === partyA && event.amount === decimal(5n, 17) && event.changeType === BigInt(BalanceChangeType.OPERATIONAL_FEE_OUT),
			),
		).to.equal(true)
		expect(
			balanceEvents.some(
				event => event.partyA === partyA && event.amount === decimal(1n) && event.changeType === BigInt(BalanceChangeType.CLOSE_SOLVER_FEE_OUT),
			),
		).to.equal(true)
	})

	it("can batch atomic open and solver fee charging through SymmioPartyB", async function () {
		const partyBAddress = await setupPartyBContract()
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(1n), decimal(2n, 16), "party-b-batch", partyBAddress)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const notional = unDecimal(quote.quantity * quote.requestedOpenPrice)

		const allocateCall = context.partyBAccountFacet.interface.encodeFunctionData("allocateForPartyB", [notional, await user.getAddress()])
		const lockCall = context.partyBQuoteActionsFacet.interface.encodeFunctionData("lockQuote", [quoteId, await getDummySingleUpnlSig(0n)])
		const openWithFeeCall = context.partyBSolverFeeActionsFacet.interface.encodeFunctionData(OPEN_POSITION_WITH_FEE, [
			quoteId,
			quote.quantity,
			quote.requestedOpenPrice,
			await getDummyPairUpnlAndPriceSig(quote.requestedOpenPrice, 0n, 0n),
			0n,
			decimal(1n),
		])

		const partyAAllocatedBefore = (await user.getBalanceInfo()).allocatedBalances
		const partyBBalanceBefore = await context.viewFacet.balanceOf(partyBAddress)

		await expect(context.symmioPartyB.connect(context.signers.admin)._call([allocateCall, lockCall, openWithFeeCall]))
			.to.emit(context.partyBQuoteActionsFacet, "OpenSolverFeeCharged")
			.withArgs(quoteId, await user.getAddress(), partyBAddress, 1n, decimal(1n))

		const partyAAllocatedAfter = (await user.getBalanceInfo()).allocatedBalances
		const partyBBalanceAfter = await context.viewFacet.balanceOf(partyBAddress)
		const state = await getSolverFeeState(quoteId)

		expect(partyAAllocatedBefore - partyAAllocatedAfter).to.equal(decimal(1n))
		expect(partyBBalanceAfter - partyBBalanceBefore).to.equal(decimal(1n) - notional)
		expect(state.chargedOpenSolverFee).to.equal(decimal(1n))
	})

	it("opens and charges solver fees atomically only when PartyA remains solvent after the fee", async function () {
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(1n), decimal(100n))
		await hedger.lockQuote(quoteId)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const upnlPartyA = await upnlForTargetAvailableAfterOpen(quoteId, decimal(2n))
		const openWithFee = (context.partyBSolverFeeActionsFacet.connect(hedger.signer) as any)[OPEN_POSITION_WITH_FEE]

		await expect(
			openWithFee(
				quoteId,
				quote.quantity,
				quote.requestedOpenPrice,
				await getDummyPairUpnlAndPriceSig(quote.requestedOpenPrice, upnlPartyA, 0n),
				0n,
				decimal(1n),
			),
		)
			.to.emit(context.partyBQuoteActionsFacet, "OpenSolverFeeCharged")
			.withArgs(quoteId, await user.getAddress(), await hedger.getAddress(), 1n, decimal(1n))

		const state = await getSolverFeeState(quoteId)
		expect(state.chargedOpenSolverFee).to.equal(decimal(1n))
		expect(await partyAAvailableForLiquidation(upnlPartyA)).to.be.gte(0n)
	})

	it("rejects solver-fee-aware open when the fee would make PartyA liquidatable", async function () {
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(1n), decimal(100n))
		await hedger.lockQuote(quoteId)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const upnlPartyA = await upnlForTargetAvailableAfterOpen(quoteId, decimal(5n, 17))
		const openWithFee = (context.partyBSolverFeeActionsFacet.connect(hedger.signer) as any)[OPEN_POSITION_WITH_FEE]

		await expect(
			openWithFee(
				quoteId,
				quote.quantity,
				quote.requestedOpenPrice,
				await getDummyPairUpnlAndPriceSig(quote.requestedOpenPrice, upnlPartyA, 0n),
				0n,
				decimal(1n),
			),
		).to.be.revertedWith("SolverFee: PartyA will be insolvent after solver fee")
	})

	it("enforces open solver fee rate caps without an absolute cap", async function () {
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(1n), decimal(1n, 16))
		await hedger.lockQuote(quoteId)
		await expect(openQuoteWithFees(quoteId, 0n, decimal(1n) + 1n)).to.be.revertedWith("SolverFee: Solver fee rate cap exceeded")

		const quoteIdWithHigherRate = await sendQuoteWithSolverFeeRates(decimal(1n), decimal(2n, 16))
		await hedger.lockQuote(quoteIdWithHigherRate)
		await openQuoteWithFees(quoteIdWithHigherRate, 0n, decimal(15n, 17))
	})

	it("enforces one cumulative operational fee cap across fee-aware execution paths", async function () {
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(1n), decimal(2n, 16))

		await hedger.lockQuote(quoteId)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		await openQuoteWithFees(quoteId, decimal(7n, 17), 0n, quote.quantity)
		const halfAmount = quote.quantity / 2n
		await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(halfAmount).build())
		await fillCloseWithFees(quoteId, decimal(3n, 17), 0n, halfAmount)
		await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(halfAmount).build())
		await expect(fillCloseWithFees(quoteId, 1n, 0n, halfAmount)).to.be.revertedWith("SolverFee: Operational fee cap exceeded")

		const state = await getSolverFeeState(quoteId)
		expect(state.chargedOperationalFee).to.equal(decimal(1n))
	})

	it("rejects unauthorized PartyB and insufficient PartyA allocated balance on fee-aware open", async function () {
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(3000n), decimal(100n))
		await hedger.lockQuote(quoteId)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const openWithFeeAsOtherPartyB = (context.partyBSolverFeeActionsFacet.connect(context.signers.hedger2) as any)[OPEN_POSITION_WITH_FEE]

		await expect(
			openWithFeeAsOtherPartyB(
				quoteId,
				quote.quantity,
				quote.requestedOpenPrice,
				await getDummyPairUpnlAndPriceSig(quote.requestedOpenPrice, 0n, 0n),
				1n,
				0n,
			),
		).to.be.revertedWith("Accessibility: Should be partyB of quote")
		await expect(openQuoteWithFees(quoteId, decimal(2000n), 0n)).to.be.revertedWith("SolverFee: PartyA will be insolvent after solver fee")
	})

	it("uses immutable quote-time close caps for close solver fees", async function () {
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(1n), ZERO_SOLVER_FEE_RATE, "immutable-close-caps", undefined, decimal(2n, 16))
		await openQuote(quoteId)

		const quote = await context.viewFacetQuote.getQuote(quoteId)
		await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(quote.quantity).build())
		await fillCloseWithFees(quoteId, 0n, decimal(1n))

		const state = await getSolverFeeState(quoteId)
		expect(state.maxOpenSolverFeeRate).to.equal(0n)
		expect(state.maxCloseSolverFeeRate).to.equal(decimal(2n, 16))
		expect(state.chargedCloseSolverFee).to.equal(decimal(1n))
	})

	it("enforces close solver fee rate caps against cumulative closed notional", async function () {
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(1n), decimal(2n, 16))
		await openQuote(quoteId)

		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const halfAmount = quote.quantity / 2n
		await requestClose(quoteId)

		await expect(fillCloseWithFees(quoteId, 0n, decimal(1n) + 1n, halfAmount)).to.be.revertedWith("SolverFee: Solver fee rate cap exceeded")
		await fillCloseWithFees(quoteId, 0n, decimal(1n), halfAmount)

		await expect(fillCloseWithFees(quoteId, 0n, decimal(1n) + 1n, halfAmount)).to.be.revertedWith("SolverFee: Solver fee rate cap exceeded")
		await fillCloseWithFees(quoteId, 0n, decimal(1n), halfAmount)
	})

	it("keeps legacy close-to-liquidation backward compatible without charging solver fees", async function () {
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(1n), decimal(100n))
		await openQuote(quoteId)
		await requestClose(quoteId)

		const closePrice = decimal(1n)
		const marketPrice = decimal(2n)
		const targetAvailable = decimal(5n, 17)
		const balanceInfo = await user.getBalanceInfo()
		const upnlPartyA = targetAvailable - (balanceInfo.allocatedBalances - balanceInfo.lockedCva - balanceInfo.lockedLf)
		const legacyFill = (context.partyBPositionActionsFacet.connect(hedger.signer) as any)[FILL_CLOSE_TO_LIQUIDATION]

		await legacyFill(quoteId, closePrice, await getDummyPairUpnlAndPriceSig(marketPrice, upnlPartyA, 0n))
		expect(await partyAAvailableForLiquidation(upnlPartyA)).to.be.gte(0n)

		const state = await getSolverFeeState(quoteId)
		expect(state.chargedCloseSolverFee).to.equal(0n)
	})

	it("reserves room for close solver fees in solver-fee-aware close-to-liquidation", async function () {
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(1n), decimal(100n))
		await openQuote(quoteId)
		await requestClose(quoteId)

		const closePrice = decimal(1n)
		const marketPrice = decimal(2n)
		const targetAvailable = decimal(5n)
		const balanceInfo = await user.getBalanceInfo()
		const upnlPartyA = targetAvailable - (balanceInfo.allocatedBalances - balanceInfo.lockedCva - balanceInfo.lockedLf)
		const fillToLiquidationWithFee = (context.partyBSolverFeeActionsFacet.connect(hedger.signer) as any)[FILL_CLOSE_TO_LIQUIDATION_WITH_FEE]
		const [legacyMaxCloseAmount] = await (context.viewFacet as any).getMaxCloseAmountToLiquidation(quoteId, closePrice, marketPrice, upnlPartyA, 0n)
		const [solverAwareMaxCloseAmount, canCloseAll] = await (context.viewFacet as any).getMaxCloseAmountToLiquidation(
			quoteId,
			closePrice,
			marketPrice,
			upnlPartyA,
			decimal(1n),
		)

		expect(canCloseAll).to.equal(false)
		expect(solverAwareMaxCloseAmount).to.be.lessThan(legacyMaxCloseAmount)

		await expect(fillToLiquidationWithFee(quoteId, closePrice, await getDummyPairUpnlAndPriceSig(marketPrice, upnlPartyA, 0n), 0n, decimal(1n)))
			.to.emit(context.partyBQuoteActionsFacet, "CloseSolverFeeCharged")
			.withArgs(quoteId, await user.getAddress(), await hedger.getAddress(), 1n, decimal(1n))

		const state = await getSolverFeeState(quoteId)
		expect(state.chargedCloseSolverFee).to.equal(decimal(1n))
		expect(await partyAAvailableForLiquidation(upnlPartyA)).to.be.gte(0n)
	})

	it("keeps legacy quote APIs at zero solver fee caps", async function () {
		const quoteId = await user.sendQuote()
		const state = await getSolverFeeState(quoteId)

		expect(state.maxOperationalFee).to.equal(0n)
		expect(state.maxOpenSolverFeeRate).to.equal(0n)
		expect(state.maxCloseSolverFeeRate).to.equal(0n)

		await openQuote(quoteId)
		await requestClose(quoteId)
		await expect(fillCloseWithFees(quoteId, 1n, 0n)).to.be.revertedWith("SolverFee: Operational fee cap exceeded")
	})

	it("splits operational cap pro-rata and copies solver rate caps when a quote is partially opened", async function () {
		const maxOperationalFee = decimal(4n)
		const maxOpenSolverFeeRate = decimal(4n, 16)
		const maxCloseSolverFeeRate = decimal(6n, 16)
		const quoteId = await sendQuoteWithSolverFeeRates(maxOperationalFee, maxOpenSolverFeeRate, "split-caps", undefined, maxCloseSolverFeeRate)
		const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
		const filledAmount = quoteBefore.quantity / 4n

		await openQuote(quoteId, filledAmount)

		const quoteIds = await context.viewFacetQuote.quoteIdsOf(await user.getAddress(), 0, 2)
		const childQuoteId = quoteIds[1]
		const openedState = await getSolverFeeState(quoteId)
		const childState = await getSolverFeeState(childQuoteId)

		expect(openedState.maxOperationalFee).to.equal(decimal(1n))
		expect(openedState.maxOpenSolverFeeRate).to.equal(maxOpenSolverFeeRate)
		expect(openedState.maxCloseSolverFeeRate).to.equal(maxCloseSolverFeeRate)
		expect(childState.maxOperationalFee).to.equal(decimal(3n))
		expect(childState.maxOpenSolverFeeRate).to.equal(maxOpenSolverFeeRate)
		expect(childState.maxCloseSolverFeeRate).to.equal(maxCloseSolverFeeRate)
	})

	it("gates solver fees on open and close notional", async function () {
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(1n), decimal(2n, 16))

		await hedger.lockQuote(quoteId)
		await expect(openQuoteWithFees(quoteId, 0n, decimal(2n) + 1n)).to.be.revertedWith("SolverFee: Solver fee rate cap exceeded")
	})

	it("exposes the fee-aware overloads without standalone open or close charge selectors", async function () {
		const openWithFeeSelector = ethers.id(OPEN_POSITION_WITH_FEE).slice(0, 10)
		const closeWithFeeSelector = ethers.id(FILL_CLOSE_REQUEST_WITH_FEE).slice(0, 10)
		const closeToLiquidationWithFeeSelector = ethers.id(FILL_CLOSE_TO_LIQUIDATION_WITH_FEE).slice(0, 10)
		const legacyOpenAndChargeSelector = ethers
			.id("openPositionAndChargeFee(uint256,uint256,uint256,(bytes,uint256,int256,int256,uint256,bytes,(uint256,address,address)),uint256,uint256)")
			.slice(0, 10)
		const legacyCloseAndChargeSelector = ethers
			.id(
				"fillCloseRequestAndChargeFee(uint256,uint256,uint256,(bytes,uint256,int256,int256,uint256,bytes,(uint256,address,address)),uint256,uint256)",
			)
			.slice(0, 10)
		const legacyCloseToLiquidationAndChargeSelector = ethers
			.id(
				"fillCloseRequestToLiquidationAndChargeFee(uint256,uint256,(bytes,uint256,int256,int256,uint256,bytes,(uint256,address,address)),uint256,uint256)",
			)
			.slice(0, 10)
		const operationalSelector = ethers.id("chargeOperationalFee(uint256,uint256)").slice(0, 10)
		const openSelector = ethers.id("chargeOpenSolverFee(uint256,uint256)").slice(0, 10)
		const closeSelector = ethers.id("chargeCloseSolverFee(uint256,uint256)").slice(0, 10)

		expect(await context.diamondLoupeFacet.facetAddress(openWithFeeSelector)).to.not.equal(ethers.ZeroAddress)
		expect(await context.diamondLoupeFacet.facetAddress(closeWithFeeSelector)).to.not.equal(ethers.ZeroAddress)
		expect(await context.diamondLoupeFacet.facetAddress(closeToLiquidationWithFeeSelector)).to.not.equal(ethers.ZeroAddress)
		expect(await context.diamondLoupeFacet.facetAddress(legacyOpenAndChargeSelector)).to.equal(ethers.ZeroAddress)
		expect(await context.diamondLoupeFacet.facetAddress(legacyCloseAndChargeSelector)).to.equal(ethers.ZeroAddress)
		expect(await context.diamondLoupeFacet.facetAddress(legacyCloseToLiquidationAndChargeSelector)).to.equal(ethers.ZeroAddress)
		expect(await context.diamondLoupeFacet.facetAddress(operationalSelector)).to.equal(ethers.ZeroAddress)
		expect(await context.diamondLoupeFacet.facetAddress(openSelector)).to.equal(ethers.ZeroAddress)
		expect(await context.diamondLoupeFacet.facetAddress(closeSelector)).to.equal(ethers.ZeroAddress)
	})

	it("rejects fee-aware close when PartyA cannot cover the solver fee and passes at the exact solvency boundary", async function () {
		const fee = decimal(1n)
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(2n), decimal(2n, 16))
		await openQuote(quoteId)
		await requestClose(quoteId)

		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const balanceInfo = await user.getBalanceInfo()
		const closedPrice = decimal(1n)
		// Full close at the open price: pnl is zero, the quote's cva+lf unlock fully and the protocol
		// close fee is deducted, so availableAfterClose = base + unlocked + upnl - closeFeeAmount
		const closeFeeAmount = (quote.quantityToClose * closedPrice * quote.closeFee) / 10n ** 36n
		const unlocked = quote.lockedValues.cva + quote.lockedValues.lf
		const base = balanceInfo.allocatedBalances - balanceInfo.lockedCva - balanceInfo.lockedLf
		const boundaryUpnl = fee + closeFeeAmount - base - unlocked

		await expect(fillCloseWithFees(quoteId, 0n, fee, undefined, closedPrice, boundaryUpnl - 1n)).to.be.revertedWith(
			"SolverFee: PartyA will be insolvent after solver fee",
		)
		await fillCloseWithFees(quoteId, 0n, fee, undefined, closedPrice, boundaryUpnl)

		const state = await getSolverFeeState(quoteId)
		const finalQuote = await context.viewFacetQuote.getQuote(quoteId)
		expect(state.chargedCloseSolverFee).to.equal(fee)
		expect(finalQuote.quoteStatus).to.equal(QuoteStatus.CLOSED)
	})

	it("skips fee solvency checks for bound PartyA with bindable PartyB but still requires allocated balance", async function () {
		const partyB = await hedger.getAddress()
		await context.controlFacet.connect(context.signers.admin).grantRole(context.signers.admin, ethers.id("BINDABLE_SETTER_ROLE"))
		await context.controlFacet.connect(context.signers.admin).setPartyBBindable(partyB, true)
		await context.bindingFacet.connect(user.signer).bindToPartyB(partyB)

		// A PartyA upnl this negative would fail both the open solvency check and the fee solvency check,
		// but bound mode skips them by protocol design
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(3000n), decimal(2n, 16))
		await hedger.lockQuote(quoteId)
		await openQuoteWithFees(quoteId, decimal(5n, 17), decimal(1n), undefined, decimal(1n), decimal(-100000n))

		const state = await getSolverFeeState(quoteId)
		expect(state.chargedOperationalFee).to.equal(decimal(5n, 17))
		expect(state.chargedOpenSolverFee).to.equal(decimal(1n))

		// The raw allocated-balance guard in the fee transfer still applies even in bound mode
		const secondQuoteId = await sendQuoteWithSolverFeeRates(decimal(3000n), ZERO_SOLVER_FEE_RATE)
		await hedger.lockQuote(secondQuoteId)
		await expect(openQuoteWithFees(secondQuoteId, decimal(2900n), 0n)).to.be.revertedWith("SolverFee: Insufficient allocated balance")
	})

	it("enforces pause gates on the fee-aware overloads", async function () {
		const admin = context.signers.admin
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(1n), decimal(2n, 16))
		await hedger.lockQuote(quoteId)

		await context.controlFacet.connect(admin).grantRole(admin, ethers.id("PAUSER_ROLE"))
		await context.controlFacet.connect(admin).grantRole(admin, ethers.id("UNPAUSER_ROLE"))

		await context.pauseControlFacet.connect(admin).pausePartyBOpenPositions()
		await expect(openQuoteWithFees(quoteId, decimal(5n, 17), 0n)).to.be.revertedWith("Pausable: PartyB open positions paused")
		await context.pauseControlFacet.connect(admin).unpausePartyBOpenPositions()
		await openQuoteWithFees(quoteId, decimal(5n, 17), 0n)

		await requestClose(quoteId)
		await context.pauseControlFacet.connect(admin).pausePartyBActions()
		await expect(fillCloseWithFees(quoteId, 0n, decimal(1n))).to.be.revertedWith("Pausable: PartyB actions paused")

		const fillToLiquidationWithFee = (context.partyBSolverFeeActionsFacet.connect(hedger.signer) as any)[FILL_CLOSE_TO_LIQUIDATION_WITH_FEE]
		await expect(
			fillToLiquidationWithFee(quoteId, decimal(1n), await getDummyPairUpnlAndPriceSig(decimal(1n), 0n, 0n), 0n, decimal(1n)),
		).to.be.revertedWith("Pausable: PartyB actions paused")
	})

	it("charges fees for a partial open against the opened quote's split caps", async function () {
		// The split happens inside the delegated openPosition BEFORE fees are charged, so a partial
		// open must be capped by the opened quote's pro-rata share, not the original caps
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(4n), decimal(2n, 16))
		await hedger.lockQuote(quoteId)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const partialAmount = quote.quantity / 4n

		// Opened quote's operational cap after split: 4 / 4 = 1
		await expect(openQuoteWithFees(quoteId, decimal(1n) + 1n, 0n, partialAmount)).to.be.revertedWith("SolverFee: Operational fee cap exceeded")
		// Opened notional: 25 * 1 = 25, open solver fee cap: 25 * 2% = 0.5
		await expect(openQuoteWithFees(quoteId, 0n, decimal(5n, 17) + 1n, partialAmount)).to.be.revertedWith("SolverFee: Solver fee rate cap exceeded")
		await openQuoteWithFees(quoteId, decimal(1n), decimal(5n, 17), partialAmount)

		const state = await getSolverFeeState(quoteId)
		expect(state.maxOperationalFee).to.equal(decimal(1n))
		expect(state.chargedOperationalFee).to.equal(decimal(1n))
		expect(state.chargedOpenSolverFee).to.equal(decimal(5n, 17))
	})

	it("emits split solver fee caps for the child quote of a partial open and enforces them independently", async function () {
		const maxOperationalFee = decimal(4n)
		const maxOpenSolverFeeRate = decimal(4n, 16)
		const maxCloseSolverFeeRate = decimal(6n, 16)
		const quoteId = await sendQuoteWithSolverFeeRates(maxOperationalFee, maxOpenSolverFeeRate, "child-caps", undefined, maxCloseSolverFeeRate)
		const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)

		await openQuote(quoteId, quoteBefore.quantity / 4n)

		const quoteIds = await context.viewFacetQuote.quoteIdsOf(await user.getAddress(), 0, 2)
		const childQuoteId = quoteIds[1]
		const capLogs = await context.signers.user.provider.getLogs({
			address: await context.partyAFacet.getAddress(),
			topics: [sendQuoteSolverFeeCapsInterface.getEvent("SendQuoteSolverFeeCaps")!.topicHash],
		})
		const childCapEvents = capLogs.map(log => sendQuoteSolverFeeCapsInterface.parseLog(log)!.args).filter(args => args.quoteId === childQuoteId)

		expect(childCapEvents.length).to.equal(1)
		expect(childCapEvents[0].partyA).to.equal(await user.getAddress())
		expect(childCapEvents[0].maxOperationalFee).to.equal(decimal(3n))
		expect(childCapEvents[0].maxOpenSolverFeeRate).to.equal(maxOpenSolverFeeRate)
		expect(childCapEvents[0].maxCloseSolverFeeRate).to.equal(maxCloseSolverFeeRate)

		// Child quote (75 units at price 1) enforces its own split caps: operational 3, open solver 75 * 4% = 3
		await hedger.lockQuote(childQuoteId)
		await expect(openQuoteWithFees(childQuoteId, decimal(3n) + 1n, 0n)).to.be.revertedWith("SolverFee: Operational fee cap exceeded")
		await expect(openQuoteWithFees(childQuoteId, 0n, decimal(3n) + 1n)).to.be.revertedWith("SolverFee: Solver fee rate cap exceeded")
		await openQuoteWithFees(childQuoteId, decimal(3n), decimal(3n))

		const childState = await getSolverFeeState(childQuoteId)
		expect(childState.chargedOperationalFee).to.equal(decimal(3n))
		expect(childState.chargedOpenSolverFee).to.equal(decimal(3n))
	})

	it("shares the cumulative close solver fee cap across fill paths and fully closes to liquidation when safe", async function () {
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(1n), ZERO_SOLVER_FEE_RATE, "cumulative-close", undefined, decimal(2n, 16))
		await openQuote(quoteId)

		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const halfAmount = quote.quantity / 2n

		// First half via the normal fee-aware fill: closed notional 50, cap 50 * 2% = 1
		await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(halfAmount).build())
		await fillCloseWithFees(quoteId, 0n, decimal(1n), halfAmount)

		// Second half via close-to-liquidation: cumulative notional 100, cap 2, already charged 1
		await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(halfAmount).build())
		const fillToLiquidationWithFee = (context.partyBSolverFeeActionsFacet.connect(hedger.signer) as any)[FILL_CLOSE_TO_LIQUIDATION_WITH_FEE]

		await expect(
			fillToLiquidationWithFee(quoteId, decimal(1n), await getDummyPairUpnlAndPriceSig(decimal(1n), 0n, 0n), 0n, decimal(1n) + 1n),
		).to.be.revertedWith("SolverFee: Solver fee rate cap exceeded")
		await expect(fillToLiquidationWithFee(quoteId, decimal(1n), await getDummyPairUpnlAndPriceSig(decimal(1n), 0n, 0n), 0n, decimal(1n)))
			.to.emit(context.partyBQuoteActionsFacet, "CloseSolverFeeCharged")
			.withArgs(quoteId, await user.getAddress(), await hedger.getAddress(), 1n, decimal(1n))

		// PartyA was fully solvent, so the close-to-liquidation path closed the entire remaining amount
		const finalQuote = await context.viewFacetQuote.getQuote(quoteId)
		const state = await getSolverFeeState(quoteId)
		expect(finalQuote.quoteStatus).to.equal(QuoteStatus.CLOSED)
		expect(finalQuote.closedAmount).to.equal(quote.quantity)
		expect(state.chargedCloseSolverFee).to.equal(decimal(2n))
	})

	it("rejects fee-aware close-to-liquidation when the solver fee consumes the entire closeable balance", async function () {
		const quoteId = await sendQuoteWithSolverFeeRates(decimal(1n), decimal(100n))
		await openQuote(quoteId)
		await requestClose(quoteId)

		// LONG closing at 1 while market is 2 makes closing harmful; leave exactly the fee as available
		// balance so the post-fee room is zero and nothing can be closed
		const closePrice = decimal(1n)
		const marketPrice = decimal(2n)
		const solverFee = decimal(1n)
		const balanceInfo = await user.getBalanceInfo()
		const upnlPartyA = solverFee - (balanceInfo.allocatedBalances - balanceInfo.lockedCva - balanceInfo.lockedLf)

		const [maxCloseAmount, canCloseAll] = await (context.viewFacet as any).getMaxCloseAmountToLiquidation(
			quoteId,
			closePrice,
			marketPrice,
			upnlPartyA,
			solverFee,
		)
		expect(maxCloseAmount).to.equal(0n)
		expect(canCloseAll).to.equal(false)

		const fillToLiquidationWithFee = (context.partyBSolverFeeActionsFacet.connect(hedger.signer) as any)[FILL_CLOSE_TO_LIQUIDATION_WITH_FEE]
		await expect(
			fillToLiquidationWithFee(quoteId, closePrice, await getDummyPairUpnlAndPriceSig(marketPrice, upnlPartyA, 0n), 0n, solverFee),
		).to.be.revertedWith("PartyBFacet: Cannot close any amount")
	})

	it("acts as a drop-in replacement for the base methods when both fees are zero", async function () {
		const quoteId = await user.sendQuote()
		await hedger.lockQuote(quoteId)

		const openTx = await openQuoteWithFees(quoteId, 0n, 0n)
		const openEvents = await getPartyABalanceChangeEvents(openTx)
		expect(
			openEvents.some(
				(event: any) =>
					event.changeType === BigInt(BalanceChangeType.OPERATIONAL_FEE_OUT) || event.changeType === BigInt(BalanceChangeType.OPEN_SOLVER_FEE_OUT),
			),
		).to.equal(false)

		await requestClose(quoteId)
		const closeTx = await fillCloseWithFees(quoteId, 0n, 0n)
		const closeEvents = await getPartyABalanceChangeEvents(closeTx)
		expect(closeEvents.some((event: any) => event.changeType === BigInt(BalanceChangeType.CLOSE_SOLVER_FEE_OUT))).to.equal(false)

		const finalQuote = await context.viewFacetQuote.getQuote(quoteId)
		const state = await getSolverFeeState(quoteId)
		expect(finalQuote.quoteStatus).to.equal(QuoteStatus.CLOSED)
		expect(state.chargedOperationalFee).to.equal(0n)
		expect(state.chargedOpenSolverFee).to.equal(0n)
		expect(state.chargedCloseSolverFee).to.equal(0n)
	})
}
