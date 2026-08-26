import { expect } from "chai"
import { ethers } from "ethers"

import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { OrderType, PositionType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder, marketBestEffortCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp, unDecimal } from "./utils/Common.js"
import { getDummyPairUpnlAndPriceSig, getDummySingleUpnlAndPriceSig, getDummySingleUpnlSig } from "./utils/SignatureUtils.js"

const SEND_QUOTE_WITH_DATA_AND_FEE_CAPS =
	"sendQuote(address[],uint256,uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,(bytes,uint256,int256,uint256,bytes,(uint256,address,address)),bytes,(uint256,uint256))"
const OPEN_POSITION_WITH_SOLVER_FEE =
	"openPosition(uint256,uint256,uint256,(bytes,uint256,int256,int256,uint256,bytes,(uint256,address,address)),uint256)"
const FILL_CLOSE_WITH_SOLVER_FEE =
	"fillCloseRequest(uint256,uint256,uint256,(bytes,uint256,int256,int256,uint256,bytes,(uint256,address,address)),uint256)"
const FILL_CLOSE_TO_LIQUIDATION_BASE =
	"fillCloseRequestToLiquidation(uint256,uint256,(bytes,uint256,int256,int256,uint256,bytes,(uint256,address,address)))"
const FILL_CLOSE_TO_LIQUIDATION_WITH_SOLVER_FEE =
	"fillCloseRequestToLiquidation(uint256,uint256,(bytes,uint256,int256,int256,uint256,bytes,(uint256,address,address)),uint256)"
const FILL_CLOSE_TO_LIQUIDATION_WITH_MAX_AND_SOLVER_FEE =
	"fillCloseRequestToLiquidation(uint256,uint256,uint256,(bytes,uint256,int256,int256,uint256,bytes,(uint256,address,address)),uint256)"
const SEND_QUOTE_SOLVER_FEE_CAPS_EVENT =
	"event SendQuoteSolverFeeCaps(address indexed partyA,uint256 indexed quoteId,uint256 openRateCap,uint256 closeRateCap)"
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

const NO_SOLVER_FEE = 0n

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

	async function requestClose(quoteId: bigint, orderType: OrderType = OrderType.LIMIT) {
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const closeRequestBuilder = orderType === OrderType.MARKET_BEST_EFFORT ? marketBestEffortCloseRequestBuilder() : limitCloseRequestBuilder()
		await user.requestToClosePosition(quoteId, closeRequestBuilder.quantityToClose(quote.quantity - quote.closedAmount).build())
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
				const parsed = partyABalanceChangeInterface.parseLog(log)
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
		solverFee: bigint,
		filledAmount?: bigint,
		openedPrice: bigint = decimal(1n),
		upnlPartyA: bigint = 0n,
		upnlPartyB: bigint = 0n,
	) {
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const openWithFee = (context.partyBExecutionFacet.connect(hedger.signer) as any)[OPEN_POSITION_WITH_SOLVER_FEE]
		return openWithFee(
			quoteId,
			filledAmount ?? quote.quantity,
			openedPrice,
			await getDummyPairUpnlAndPriceSig(openedPrice, upnlPartyA, upnlPartyB),
			solverFee,
		)
	}

	async function fillCloseWithFees(
		quoteId: bigint,
		solverFee: bigint,
		filledAmount?: bigint,
		closedPrice: bigint = decimal(1n),
		upnlPartyA: bigint = 0n,
		upnlPartyB: bigint = 0n,
	) {
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const fillWithFee = (context.partyBExecutionFacet.connect(hedger.signer) as any)[FILL_CLOSE_WITH_SOLVER_FEE]
		return fillWithFee(
			quoteId,
			filledAmount ?? quote.quantityToClose,
			closedPrice,
			await getDummyPairUpnlAndPriceSig(closedPrice, upnlPartyA, upnlPartyB),
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
		const openRateCap = decimal(2n, 16)
		const closeRateCap = decimal(3n, 16)

		const quoteId = await sendQuoteWithSolverFeeCaps(openRateCap, "caps-data", undefined, closeRateCap)
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
		expect(state.openRateCap).to.equal(openRateCap)
		expect(state.closeRateCap).to.equal(closeRateCap)
		expect(capEvent.openRateCap).to.equal(openRateCap)
		expect(capEvent.closeRateCap).to.equal(closeRateCap)
	})

	it("charges open solver fee atomically from PartyA allocated balance into PartyB balance", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16))
		await hedger.lockQuote(quoteId)

		const partyAAllocatedBefore = (await user.getBalanceInfo()).allocatedBalances
		const partyBBalanceBefore = await context.viewFacet.balanceOf(await hedger.getAddress())
		const partyBAllocatedBefore = (await hedger.getBalanceInfo(await user.getAddress())).allocatedBalances

		const txPromise = openQuoteWithFees(quoteId, decimal(1n))
		await expect(txPromise)
			.to.emit(context.partyBQuoteActionsFacet, "OpenSolverFeeCharged")
			.withArgs(quoteId, await user.getAddress(), await hedger.getAddress(), await hedger.getAddress(), 1n, decimal(1n))
		const balanceEvents = await getPartyABalanceChangeEvents(await txPromise)

		const partyAAllocatedAfter = (await user.getBalanceInfo()).allocatedBalances
		const partyBBalanceAfter = await context.viewFacet.balanceOf(await hedger.getAddress())
		const partyBAllocatedAfter = (await hedger.getBalanceInfo(await user.getAddress())).allocatedBalances
		const state = await getSolverFeeState(quoteId)

		expect(partyAAllocatedBefore - partyAAllocatedAfter).to.equal(decimal(1n))
		expect(partyBBalanceAfter - partyBBalanceBefore).to.equal(decimal(1n))
		expect(partyBAllocatedAfter).to.equal(partyBAllocatedBefore)
		expect(state.openFeeCharged).to.equal(decimal(1n))
		const partyA = await user.getAddress()
		expect(
			balanceEvents.some(
				event => event.partyA === partyA && event.amount === decimal(1n) && event.changeType === BigInt(BalanceChangeType.OPEN_SOLVER_FEE_OUT),
			),
		).to.equal(true)
	})

	it("charges close solver fee atomically", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16))
		await openQuote(quoteId)
		await requestClose(quoteId)

		const txPromise = fillCloseWithFees(quoteId, decimal(1n))
		await expect(txPromise)
			.to.emit(context.partyBQuoteActionsFacet, "CloseSolverFeeCharged")
			.withArgs(quoteId, await user.getAddress(), await hedger.getAddress(), await hedger.getAddress(), 1n, decimal(1n))
		const balanceEvents = await getPartyABalanceChangeEvents(await txPromise)

		const state = await getSolverFeeState(quoteId)

		expect(state.closeFeeCharged).to.equal(decimal(1n))
		const partyA = await user.getAddress()
		expect(
			balanceEvents.some(
				event => event.partyA === partyA && event.amount === decimal(1n) && event.changeType === BigInt(BalanceChangeType.CLOSE_SOLVER_FEE_OUT),
			),
		).to.equal(true)
	})

	it("can batch atomic open and solver fee charging through SymmioPartyB", async function () {
		const partyBAddress = await setupPartyBContract()
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16), "party-b-batch", partyBAddress)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const notional = unDecimal(quote.quantity * quote.requestedOpenPrice)

		const allocateCall = context.partyBAccountFacet.interface.encodeFunctionData("allocateForPartyB", [notional, await user.getAddress()])
		const lockCall = context.partyBQuoteActionsFacet.interface.encodeFunctionData("lockQuote", [quoteId, await getDummySingleUpnlSig(0n)])
		const openWithFeeCall = context.partyBExecutionFacet.interface.encodeFunctionData(OPEN_POSITION_WITH_SOLVER_FEE, [
			quoteId,
			quote.quantity,
			quote.requestedOpenPrice,
			await getDummyPairUpnlAndPriceSig(quote.requestedOpenPrice, 0n, 0n),
			decimal(1n),
		])

		const partyAAllocatedBefore = (await user.getBalanceInfo()).allocatedBalances
		const partyBBalanceBefore = await context.viewFacet.balanceOf(partyBAddress)

		await expect(context.symmioPartyB.connect(context.signers.admin)._call([allocateCall, lockCall, openWithFeeCall]))
			.to.emit(context.partyBQuoteActionsFacet, "OpenSolverFeeCharged")
			.withArgs(quoteId, await user.getAddress(), partyBAddress, partyBAddress, 1n, decimal(1n))

		const partyAAllocatedAfter = (await user.getBalanceInfo()).allocatedBalances
		const partyBBalanceAfter = await context.viewFacet.balanceOf(partyBAddress)
		const state = await getSolverFeeState(quoteId)

		expect(partyAAllocatedBefore - partyAAllocatedAfter).to.equal(decimal(1n))
		expect(partyBBalanceAfter - partyBBalanceBefore).to.equal(decimal(1n) - notional)
		expect(state.openFeeCharged).to.equal(decimal(1n))
	})

	it("opens and charges solver fees atomically only when PartyA remains solvent after the fee", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(100n))
		await hedger.lockQuote(quoteId)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const upnlPartyA = await upnlForTargetAvailableAfterOpen(quoteId, decimal(2n))
		const openWithFee = (context.partyBExecutionFacet.connect(hedger.signer) as any)[OPEN_POSITION_WITH_SOLVER_FEE]

		await expect(
			openWithFee(
				quoteId,
				quote.quantity,
				quote.requestedOpenPrice,
				await getDummyPairUpnlAndPriceSig(quote.requestedOpenPrice, upnlPartyA, 0n),
				decimal(1n),
			),
		)
			.to.emit(context.partyBQuoteActionsFacet, "OpenSolverFeeCharged")
			.withArgs(quoteId, await user.getAddress(), await hedger.getAddress(), await hedger.getAddress(), 1n, decimal(1n))

		const state = await getSolverFeeState(quoteId)
		expect(state.openFeeCharged).to.equal(decimal(1n))
		expect(await partyAAvailableForLiquidation(upnlPartyA)).to.be.gte(0n)
	})

	it("rejects solver-fee-aware open when the fee would make PartyA liquidatable", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(100n))
		await hedger.lockQuote(quoteId)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const upnlPartyA = await upnlForTargetAvailableAfterOpen(quoteId, decimal(5n, 17))
		const openWithFee = (context.partyBExecutionFacet.connect(hedger.signer) as any)[OPEN_POSITION_WITH_SOLVER_FEE]

		await expect(
			openWithFee(
				quoteId,
				quote.quantity,
				quote.requestedOpenPrice,
				await getDummyPairUpnlAndPriceSig(quote.requestedOpenPrice, upnlPartyA, 0n),
				decimal(1n),
			),
		).to.be.revertedWith("SolverFee: PartyA will be insolvent after solver fee")
	})

	it("enforces open solver fee rate caps without an absolute cap", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(1n, 16))
		await hedger.lockQuote(quoteId)
		await expect(openQuoteWithFees(quoteId, decimal(1n) + 1n)).to.be.revertedWith("SolverFee: Solver fee rate cap exceeded")

		const quoteIdWithHigherRate = await sendQuoteWithSolverFeeCaps(decimal(2n, 16))
		await hedger.lockQuote(quoteIdWithHigherRate)
		await openQuoteWithFees(quoteIdWithHigherRate, decimal(15n, 17))
	})

	it("rejects unauthorized PartyB and insufficient PartyA allocated balance on fee-aware open", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(100n))
		await hedger.lockQuote(quoteId)
		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const openWithFeeAsOtherPartyB = (context.partyBExecutionFacet.connect(context.signers.hedger2) as any)[OPEN_POSITION_WITH_SOLVER_FEE]

		await expect(
			openWithFeeAsOtherPartyB(
				quoteId,
				quote.quantity,
				quote.requestedOpenPrice,
				await getDummyPairUpnlAndPriceSig(quote.requestedOpenPrice, 0n, 0n),
				1n,
			),
		).to.be.revertedWith("Accessibility: Should be partyB of quote")
		await expect(openQuoteWithFees(quoteId, decimal(2000n))).to.be.revertedWith("SolverFee: PartyA will be insolvent after solver fee")
	})

	it("uses immutable quote-time close caps for close solver fees", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(NO_SOLVER_FEE, "immutable-close-caps", undefined, decimal(2n, 16))
		await openQuote(quoteId)

		const quote = await context.viewFacetQuote.getQuote(quoteId)
		await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(quote.quantity).build())
		await fillCloseWithFees(quoteId, decimal(1n))

		const state = await getSolverFeeState(quoteId)
		expect(state.openRateCap).to.equal(0n)
		expect(state.closeRateCap).to.equal(decimal(2n, 16))
		expect(state.closeFeeCharged).to.equal(decimal(1n))
	})

	it("enforces close solver fee rate caps against cumulative closed notional", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16))
		await openQuote(quoteId)

		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const halfAmount = quote.quantity / 2n
		await requestClose(quoteId)

		await expect(fillCloseWithFees(quoteId, decimal(1n) + 1n, halfAmount)).to.be.revertedWith("SolverFee: Solver fee rate cap exceeded")
		await fillCloseWithFees(quoteId, decimal(1n), halfAmount)

		await expect(fillCloseWithFees(quoteId, decimal(1n) + 1n, halfAmount)).to.be.revertedWith("SolverFee: Solver fee rate cap exceeded")
		await fillCloseWithFees(quoteId, decimal(1n), halfAmount)
	})

	it("keeps legacy close-to-liquidation backward compatible without charging solver fees", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(100n))
		await openQuote(quoteId)
		await requestClose(quoteId)

		const closePrice = decimal(1n)
		const marketPrice = decimal(2n)
		const targetAvailable = decimal(5n, 17)
		const balanceInfo = await user.getBalanceInfo()
		const upnlPartyA = targetAvailable - (balanceInfo.allocatedBalances - balanceInfo.lockedCva - balanceInfo.lockedLf)
		const legacyFill = (context.partyBPositionActionsFacet.connect(hedger.signer) as any)[FILL_CLOSE_TO_LIQUIDATION_BASE]

		await legacyFill(quoteId, closePrice, await getDummyPairUpnlAndPriceSig(marketPrice, upnlPartyA, 0n))
		expect(await partyAAvailableForLiquidation(upnlPartyA)).to.be.gte(0n)

		const state = await getSolverFeeState(quoteId)
		expect(state.closeFeeCharged).to.equal(0n)
	})

	it("reserves room for close solver fees in solver-fee-aware close-to-liquidation", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(100n))
		await openQuote(quoteId)
		await requestClose(quoteId)

		const closePrice = decimal(1n)
		const marketPrice = decimal(2n)
		const targetAvailable = decimal(5n)
		const balanceInfo = await user.getBalanceInfo()
		const upnlPartyA = targetAvailable - (balanceInfo.allocatedBalances - balanceInfo.lockedCva - balanceInfo.lockedLf)
		const fillToLiquidationWithFee = (quoteId: any, closedPrice: any, upnlSig: any, solverFee: any) =>
			(context.partyBExecutionFacet.connect(hedger.signer) as any)[FILL_CLOSE_TO_LIQUIDATION_WITH_MAX_AND_SOLVER_FEE](
				quoteId,
				ethers.MaxUint256,
				closedPrice,
				upnlSig,
				solverFee,
			)
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

		await expect(fillToLiquidationWithFee(quoteId, closePrice, await getDummyPairUpnlAndPriceSig(marketPrice, upnlPartyA, 0n), decimal(1n)))
			.to.emit(context.partyBQuoteActionsFacet, "CloseSolverFeeCharged")
			.withArgs(quoteId, await user.getAddress(), await hedger.getAddress(), await hedger.getAddress(), 1n, decimal(1n))

		const state = await getSolverFeeState(quoteId)
		expect(state.closeFeeCharged).to.equal(decimal(1n))
		expect(await partyAAvailableForLiquidation(upnlPartyA)).to.be.gte(0n)
	})

	it("keeps legacy quote APIs at zero solver fee caps", async function () {
		const quoteId = await user.sendQuote()
		const state = await getSolverFeeState(quoteId)

		expect(state.openRateCap).to.equal(0n)
		expect(state.closeRateCap).to.equal(0n)

		await openQuote(quoteId)
		await requestClose(quoteId)
		await expect(fillCloseWithFees(quoteId, decimal(1n) + 1n)).to.be.revertedWith("SolverFee: Solver fee rate cap exceeded")
	})

	it("copies solver rate caps when a quote is partially opened", async function () {
		const openRateCap = decimal(4n, 16)
		const closeRateCap = decimal(6n, 16)
		const quoteId = await sendQuoteWithSolverFeeCaps(openRateCap, "split-caps", undefined, closeRateCap)
		const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
		const filledAmount = quoteBefore.quantity / 4n

		await openQuote(quoteId, filledAmount)

		const quoteIds = await context.viewFacetQuote.quoteIdsOf(await user.getAddress(), 0, 2)
		const childQuoteId = quoteIds[1]
		const openedState = await getSolverFeeState(quoteId)
		const childState = await getSolverFeeState(childQuoteId)

		expect(openedState.openRateCap).to.equal(openRateCap)
		expect(openedState.closeRateCap).to.equal(closeRateCap)
		expect(childState.openRateCap).to.equal(openRateCap)
		expect(childState.closeRateCap).to.equal(closeRateCap)
	})

	it("gates solver fees on open and close notional", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16))

		await hedger.lockQuote(quoteId)
		await expect(openQuoteWithFees(quoteId, decimal(2n) + 1n)).to.be.revertedWith("SolverFee: Solver fee rate cap exceeded")
	})

	it("exposes the fee-aware overloads without standalone open or close charge selectors", async function () {
		const openWithFeeSelector = ethers.id(OPEN_POSITION_WITH_SOLVER_FEE).slice(0, 10)
		const closeWithFeeSelector = ethers.id(FILL_CLOSE_WITH_SOLVER_FEE).slice(0, 10)
		const closeToLiquidationWithFeeSelector = ethers.id(FILL_CLOSE_TO_LIQUIDATION_WITH_SOLVER_FEE).slice(0, 10)
		const closeToLiquidationWithMaxAndFeeSelector = ethers.id(FILL_CLOSE_TO_LIQUIDATION_WITH_MAX_AND_SOLVER_FEE).slice(0, 10)
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
		const operationalSelectorOld = ethers.id("chargeOperationalFee(uint256,uint256)").slice(0, 10)
		const openSelector = ethers.id("chargeOpenSolverFee(uint256,uint256)").slice(0, 10)
		const closeSelector = ethers.id("chargeCloseSolverFee(uint256,uint256)").slice(0, 10)

		expect(await context.diamondLoupeFacet.facetAddress(openWithFeeSelector)).to.not.equal(ethers.ZeroAddress)
		expect(await context.diamondLoupeFacet.facetAddress(closeWithFeeSelector)).to.not.equal(ethers.ZeroAddress)
		// the no-maxQuantity fee-aware overload was removed; the maxQuantity variant is the only fee-aware close-to-liquidation
		expect(await context.diamondLoupeFacet.facetAddress(closeToLiquidationWithFeeSelector)).to.equal(ethers.ZeroAddress)
		expect(await context.diamondLoupeFacet.facetAddress(closeToLiquidationWithMaxAndFeeSelector)).to.not.equal(ethers.ZeroAddress)
		expect(await context.diamondLoupeFacet.facetAddress(legacyOpenAndChargeSelector)).to.equal(ethers.ZeroAddress)
		expect(await context.diamondLoupeFacet.facetAddress(legacyCloseAndChargeSelector)).to.equal(ethers.ZeroAddress)
		expect(await context.diamondLoupeFacet.facetAddress(legacyCloseToLiquidationAndChargeSelector)).to.equal(ethers.ZeroAddress)
		expect(await context.diamondLoupeFacet.facetAddress(operationalSelectorOld)).to.equal(ethers.ZeroAddress)
		expect(await context.diamondLoupeFacet.facetAddress(openSelector)).to.equal(ethers.ZeroAddress)
		expect(await context.diamondLoupeFacet.facetAddress(closeSelector)).to.equal(ethers.ZeroAddress)
	})

	it("rejects fee-aware close when PartyA cannot cover the solver fee and passes at the exact solvency boundary", async function () {
		const fee = decimal(1n)
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16))
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

		await expect(fillCloseWithFees(quoteId, fee, undefined, closedPrice, boundaryUpnl - 1n)).to.be.revertedWith(
			"SolverFee: PartyA will be insolvent after solver fee",
		)
		await fillCloseWithFees(quoteId, fee, undefined, closedPrice, boundaryUpnl)

		const state = await getSolverFeeState(quoteId)
		const finalQuote = await context.viewFacetQuote.getQuote(quoteId)
		expect(state.closeFeeCharged).to.equal(fee)
		expect(finalQuote.quoteStatus).to.equal(QuoteStatus.CLOSED)
	})

	it("skips fee solvency checks for bound PartyA with bindable PartyB but still requires allocated balance", async function () {
		const partyB = await hedger.getAddress()
		await context.controlFacet.connect(context.signers.admin).grantRole(context.signers.admin, ethers.id("BINDABLE_SETTER_ROLE"))
		await context.controlFacet.connect(context.signers.admin).setPartyBBindable(partyB, true)
		await context.bindingFacet.connect(user.signer).bindToPartyB(partyB)

		// A PartyA upnl this negative would fail both the open solvency check and the fee solvency check,
		// but bound mode skips them by protocol design
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16))
		await hedger.lockQuote(quoteId)
		await openQuoteWithFees(quoteId, decimal(1n), undefined, decimal(1n), decimal(-100000n))

		const state = await getSolverFeeState(quoteId)
		expect(state.openFeeCharged).to.equal(decimal(1n))

		// The raw allocated-balance guard in the fee transfer still applies even in bound mode.
		// Use a high rate cap so the rate check passes but the balance guard fires.
		const secondQuoteId = await sendQuoteWithSolverFeeCaps(decimal(100n))
		await hedger.lockQuote(secondQuoteId)
		await expect(openQuoteWithFees(secondQuoteId, decimal(2000n))).to.be.revertedWith("SolverFee: Insufficient allocated balance")
	})

	it("enforces pause gates on the fee-aware overloads", async function () {
		const admin = context.signers.admin
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16))
		await hedger.lockQuote(quoteId)

		await context.controlFacet.connect(admin).grantRole(admin, ethers.id("PAUSER_ROLE"))
		await context.controlFacet.connect(admin).grantRole(admin, ethers.id("UNPAUSER_ROLE"))

		await context.pauseControlFacet.connect(admin).pausePartyBOpenPositions()
		await expect(openQuoteWithFees(quoteId, 0n)).to.be.revertedWith("Pausable: PartyB open positions paused")
		await context.pauseControlFacet.connect(admin).unpausePartyBOpenPositions()
		await openQuoteWithFees(quoteId, 0n)

		await requestClose(quoteId)
		await context.pauseControlFacet.connect(admin).pausePartyBActions()
		await expect(fillCloseWithFees(quoteId, decimal(1n))).to.be.revertedWith("Pausable: PartyB actions paused")

		const fillToLiquidationWithFee = (quoteId: any, closedPrice: any, upnlSig: any, solverFee: any) =>
			(context.partyBExecutionFacet.connect(hedger.signer) as any)[FILL_CLOSE_TO_LIQUIDATION_WITH_MAX_AND_SOLVER_FEE](
				quoteId,
				ethers.MaxUint256,
				closedPrice,
				upnlSig,
				solverFee,
			)
		await expect(
			fillToLiquidationWithFee(quoteId, decimal(1n), await getDummyPairUpnlAndPriceSig(decimal(1n), 0n, 0n), decimal(1n)),
		).to.be.revertedWith("Pausable: PartyB actions paused")
	})

	it("emits split solver fee caps for the child quote of a partial open and enforces them independently", async function () {
		const openRateCap = decimal(4n, 16)
		const closeRateCap = decimal(6n, 16)
		const quoteId = await sendQuoteWithSolverFeeCaps(openRateCap, "child-caps", undefined, closeRateCap)
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
		expect(childCapEvents[0].openRateCap).to.equal(openRateCap)
		expect(childCapEvents[0].closeRateCap).to.equal(closeRateCap)

		// Child quote (75 units at price 1) enforces its own rate caps: open solver 75 * 4% = 3
		await hedger.lockQuote(childQuoteId)
		await expect(openQuoteWithFees(childQuoteId, decimal(3n) + 1n)).to.be.revertedWith("SolverFee: Solver fee rate cap exceeded")
		await openQuoteWithFees(childQuoteId, decimal(3n))

		const childState = await getSolverFeeState(childQuoteId)
		expect(childState.openFeeCharged).to.equal(decimal(3n))
	})

	it("shares the cumulative close solver fee cap across fill paths and fully closes to liquidation when safe", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(NO_SOLVER_FEE, "cumulative-close", undefined, decimal(2n, 16))
		await openQuote(quoteId)

		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const halfAmount = quote.quantity / 2n

		// First half via the normal fee-aware fill: closed notional 50, cap 50 * 2% = 1
		await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(halfAmount).build())
		await fillCloseWithFees(quoteId, decimal(1n), halfAmount)

		// Second half via close-to-liquidation: cumulative notional 100, cap 2, already charged 1
		await user.requestToClosePosition(quoteId, limitCloseRequestBuilder().quantityToClose(halfAmount).build())
		const fillToLiquidationWithFee = (quoteId: any, closedPrice: any, upnlSig: any, solverFee: any) =>
			(context.partyBExecutionFacet.connect(hedger.signer) as any)[FILL_CLOSE_TO_LIQUIDATION_WITH_MAX_AND_SOLVER_FEE](
				quoteId,
				ethers.MaxUint256,
				closedPrice,
				upnlSig,
				solverFee,
			)

		await expect(
			fillToLiquidationWithFee(quoteId, decimal(1n), await getDummyPairUpnlAndPriceSig(decimal(1n), 0n, 0n), decimal(1n) + 1n),
		).to.be.revertedWith("SolverFee: Solver fee rate cap exceeded")
		await expect(fillToLiquidationWithFee(quoteId, decimal(1n), await getDummyPairUpnlAndPriceSig(decimal(1n), 0n, 0n), decimal(1n)))
			.to.emit(context.partyBQuoteActionsFacet, "CloseSolverFeeCharged")
			.withArgs(quoteId, await user.getAddress(), await hedger.getAddress(), await hedger.getAddress(), 1n, decimal(1n))

		// PartyA was fully solvent, so the close-to-liquidation path closed the entire remaining amount
		const finalQuote = await context.viewFacetQuote.getQuote(quoteId)
		const state = await getSolverFeeState(quoteId)
		expect(finalQuote.quoteStatus).to.equal(QuoteStatus.CLOSED)
		expect(finalQuote.closedAmount).to.equal(quote.quantity)
		expect(state.closeFeeCharged).to.equal(decimal(2n))
	})

	it("pro-rates fee-aware close-to-liquidation solver fee by maxQuantity", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(NO_SOLVER_FEE, "max-close-to-liquidation", undefined, decimal(2n, 16))
		await openQuote(quoteId)
		await requestClose(quoteId)

		const quote = await context.viewFacetQuote.getQuote(quoteId)
		const maxQuantity = quote.quantityToClose / 4n
		const solverFee = decimal(5n, 17)
		// PartyA is solvent (upnl 0, closePrice == marketPrice) so the uncapped close would be the full quantityToClose.
		// maxQuantity caps the fill to 1/4, and the absolute solver fee is pro-rated to the amount actually closed:
		// chargedFee = solverFee * filledAmount / uncappedAmount.
		const expectedFee = (solverFee * maxQuantity) / quote.quantityToClose
		const fillToLiquidationWithMaxAndFee = (context.partyBExecutionFacet.connect(hedger.signer) as any)[
			FILL_CLOSE_TO_LIQUIDATION_WITH_MAX_AND_SOLVER_FEE
		]

		await expect(fillToLiquidationWithMaxAndFee(quoteId, maxQuantity, decimal(1n), await getDummyPairUpnlAndPriceSig(decimal(1n), 0n, 0n), solverFee))
			.to.emit(context.partyBQuoteActionsFacet, "CloseSolverFeeCharged")
			.withArgs(quoteId, await user.getAddress(), await hedger.getAddress(), await hedger.getAddress(), 1n, expectedFee)

		const finalQuote = await context.viewFacetQuote.getQuote(quoteId)
		const state = await getSolverFeeState(quoteId)
		expect(finalQuote.quoteStatus).to.equal(QuoteStatus.CLOSE_PENDING)
		expect(finalQuote.closedAmount).to.equal(maxQuantity)
		expect(finalQuote.quantityToClose).to.equal(quote.quantityToClose - maxQuantity)
		expect(expectedFee).to.be.lessThan(solverFee)
		expect(state.closeFeeCharged).to.equal(expectedFee)
	})

	it("rejects a binding maxQuantity for fee-aware best-effort closes without charging a fee", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(NO_SOLVER_FEE, "best-effort-binding-cap", undefined, decimal(100n))
		await openQuote(quoteId)
		await requestClose(quoteId, OrderType.MARKET_BEST_EFFORT)

		const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
		const fillToLiquidationWithMaxAndFee = (context.partyBExecutionFacet.connect(hedger.signer) as any)[
			FILL_CLOSE_TO_LIQUIDATION_WITH_MAX_AND_SOLVER_FEE
		]
		await expect(
			fillToLiquidationWithMaxAndFee(
				quoteId,
				quoteBefore.quantityToClose - 1n,
				decimal(1n),
				await getDummyPairUpnlAndPriceSig(decimal(1n), 0n, 0n),
				decimal(1n),
			),
		).to.be.revertedWith("PartyBFacet: maxQuantity cannot limit MARKET_BEST_EFFORT")

		const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
		const state = await getSolverFeeState(quoteId)
		expect(quoteAfter.quoteStatus).to.equal(QuoteStatus.CLOSE_PENDING)
		expect(quoteAfter.quantityToClose).to.equal(quoteBefore.quantityToClose)
		expect(state.closeFeeCharged).to.equal(0n)
	})

	it("charges the absolute fee on a liquidation-limited best-effort close and clears the remainder", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(NO_SOLVER_FEE, "best-effort-absolute-fee", undefined, decimal(100n))
		await openQuote(quoteId)
		await requestClose(quoteId, OrderType.MARKET_BEST_EFFORT)

		const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
		const closePrice = decimal(1n)
		const marketPrice = decimal(2n)
		const solverFee = decimal(1n)
		const targetAvailable = decimal(5n)
		const balanceInfo = await user.getBalanceInfo()
		const upnlPartyA = targetAvailable - (balanceInfo.allocatedBalances - balanceInfo.lockedCva - balanceInfo.lockedLf)
		const [expectedFill, canCloseAll] = await (context.viewFacet as any).getMaxCloseAmountToLiquidation(
			quoteId,
			closePrice,
			marketPrice,
			upnlPartyA,
			solverFee,
		)
		expect(canCloseAll).to.equal(false)
		expect(expectedFill).to.be.greaterThan(0n)
		expect(expectedFill).to.be.lessThan(quoteBefore.quantityToClose)

		const fillToLiquidationWithMaxAndFee = (context.partyBExecutionFacet.connect(hedger.signer) as any)[
			FILL_CLOSE_TO_LIQUIDATION_WITH_MAX_AND_SOLVER_FEE
		]
		await expect(
			fillToLiquidationWithMaxAndFee(
				quoteId,
				quoteBefore.quantityToClose,
				closePrice,
				await getDummyPairUpnlAndPriceSig(marketPrice, upnlPartyA, 0n),
				solverFee,
			),
		)
			.to.emit(context.partyBQuoteActionsFacet, "CloseSolverFeeCharged")
			.withArgs(quoteId, await user.getAddress(), await hedger.getAddress(), await hedger.getAddress(), 1n, solverFee)

		const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
		const state = await getSolverFeeState(quoteId)
		expect(quoteAfter.quoteStatus).to.equal(QuoteStatus.OPENED)
		expect(quoteAfter.closedAmount).to.equal(expectedFill)
		expect(quoteAfter.quantityToClose).to.equal(0n)
		expect(quoteAfter.requestedClosePrice).to.equal(0n)
		expect(state.closeFeeCharged).to.equal(solverFee)
	})

	it("rolls back the best-effort fee and cancellation state when the shared fill fails", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(NO_SOLVER_FEE, "best-effort-rollback", undefined, decimal(100n))
		await openQuote(quoteId)
		await requestClose(quoteId, OrderType.MARKET_BEST_EFFORT)

		const quoteBefore = await context.viewFacetQuote.getQuote(quoteId)
		const closePrice = decimal(1n)
		const marketPrice = decimal(2n)
		const solverFee = decimal(1n)
		const targetAvailable = decimal(5n)
		const balanceInfo = await user.getBalanceInfo()
		const upnlPartyA = targetAvailable - (balanceInfo.allocatedBalances - balanceInfo.lockedCva - balanceInfo.lockedLf)
		const fillToLiquidationWithMaxAndFee = (context.partyBExecutionFacet.connect(hedger.signer) as any)[
			FILL_CLOSE_TO_LIQUIDATION_WITH_MAX_AND_SOLVER_FEE
		]

		await expect(
			fillToLiquidationWithMaxAndFee(
				quoteId,
				quoteBefore.quantityToClose,
				closePrice,
				await getDummyPairUpnlAndPriceSig(marketPrice, upnlPartyA, decimal(-4000n)),
				solverFee,
			),
		).to.be.revertedWith("LibSolvency: Available balance is lower than zero")

		const quoteAfter = await context.viewFacetQuote.getQuote(quoteId)
		const state = await getSolverFeeState(quoteId)
		expect(quoteAfter.quoteStatus).to.equal(QuoteStatus.CLOSE_PENDING)
		expect(quoteAfter.closedAmount).to.equal(quoteBefore.closedAmount)
		expect(quoteAfter.quantityToClose).to.equal(quoteBefore.quantityToClose)
		expect(state.closeFeeCharged).to.equal(0n)
	})

	it("rejects fee-aware close-to-liquidation when the solver fee consumes the entire closeable balance", async function () {
		const quoteId = await sendQuoteWithSolverFeeCaps(decimal(100n))
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

		const fillToLiquidationWithFee = (quoteId: any, closedPrice: any, upnlSig: any, solverFee: any) =>
			(context.partyBExecutionFacet.connect(hedger.signer) as any)[FILL_CLOSE_TO_LIQUIDATION_WITH_MAX_AND_SOLVER_FEE](
				quoteId,
				ethers.MaxUint256,
				closedPrice,
				upnlSig,
				solverFee,
			)
		await expect(
			fillToLiquidationWithFee(quoteId, closePrice, await getDummyPairUpnlAndPriceSig(marketPrice, upnlPartyA, 0n), solverFee),
		).to.be.revertedWith("PartyBFacet: Cannot close any amount")
	})

	it("acts as a drop-in replacement for the base methods when both fees are zero", async function () {
		const quoteId = await user.sendQuote()
		await hedger.lockQuote(quoteId)

		const openTx = await openQuoteWithFees(quoteId, 0n)
		const openEvents = await getPartyABalanceChangeEvents(openTx)
		expect(
			openEvents.some(
				(event: any) =>
					event.changeType === BigInt(BalanceChangeType.OPERATIONAL_FEE_OUT) || event.changeType === BigInt(BalanceChangeType.OPEN_SOLVER_FEE_OUT),
			),
		).to.equal(false)

		await requestClose(quoteId)
		const closeTx = await fillCloseWithFees(quoteId, 0n)
		const closeEvents = await getPartyABalanceChangeEvents(closeTx)
		expect(closeEvents.some((event: any) => event.changeType === BigInt(BalanceChangeType.CLOSE_SOLVER_FEE_OUT))).to.equal(false)

		const finalQuote = await context.viewFacetQuote.getQuote(quoteId)
		const state = await getSolverFeeState(quoteId)
		expect(finalQuote.quoteStatus).to.equal(QuoteStatus.CLOSED)
		expect(state.openFeeCharged).to.equal(0n)
		expect(state.closeFeeCharged).to.equal(0n)
	})

	describe("Solver fee receiver", () => {
		it("defaults to the PartyB itself", async function () {
			expect(await (context.viewFacet as any).getSolverFeeReceiver(await hedger.getAddress())).to.equal(await hedger.getAddress())
		})

		it("lets a PartyB set its own receiver", async function () {
			const partyB = await hedger.getAddress()
			const receiver = context.signers.feeCollector.address

			await expect((context.controlFacet.connect(hedger.signer) as any).setSolverFeeReceiver(partyB, receiver))
				.to.emit(context.controlFacet, "SetSolverFeeReceiver")
				.withArgs(partyB, receiver)

			expect(await (context.viewFacet as any).getSolverFeeReceiver(partyB)).to.equal(receiver)
		})

		it("lets PARTY_B_MANAGER_ROLE set a PartyB's receiver on its behalf", async function () {
			const partyB = await hedger.getAddress()
			const receiver = context.signers.feeCollector.address

			await expect((context.controlFacet.connect(context.signers.admin) as any).setSolverFeeReceiver(partyB, receiver))
				.to.emit(context.controlFacet, "SetSolverFeeReceiver")
				.withArgs(partyB, receiver)

			expect(await (context.viewFacet as any).getSolverFeeReceiver(partyB)).to.equal(receiver)
		})

		it("rejects an unauthorized third party setting a PartyB's receiver", async function () {
			await expect(
				(context.controlFacet.connect(user.signer) as any).setSolverFeeReceiver(await hedger.getAddress(), user.signer.address),
			).to.be.revertedWith("ControlFacet: Not authorized")
		})

		it("rejects setting a receiver for an unregistered PartyB", async function () {
			await expect(
				(context.controlFacet.connect(user.signer) as any).setSolverFeeReceiver(user.signer.address, context.signers.feeCollector.address),
			).to.be.revertedWith("ControlFacet: Address is not registered")
		})

		it("resets to the PartyB itself when the receiver is cleared", async function () {
			const partyB = await hedger.getAddress()
			await (context.controlFacet.connect(hedger.signer) as any).setSolverFeeReceiver(partyB, context.signers.feeCollector.address)
			expect(await (context.viewFacet as any).getSolverFeeReceiver(partyB)).to.equal(context.signers.feeCollector.address)

			await (context.controlFacet.connect(hedger.signer) as any).setSolverFeeReceiver(partyB, ethers.ZeroAddress)
			expect(await (context.viewFacet as any).getSolverFeeReceiver(partyB)).to.equal(partyB)
		})

		it("credits the configured receiver on open; PartyB free balance stays flat", async function () {
			const partyB = await hedger.getAddress()
			const receiver = context.signers.feeCollector.address
			await (context.controlFacet.connect(hedger.signer) as any).setSolverFeeReceiver(partyB, receiver)

			const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16))
			await hedger.lockQuote(quoteId)

			const partyAAllocatedBefore = (await user.getBalanceInfo()).allocatedBalances
			const partyBBalanceBefore = await context.viewFacet.balanceOf(partyB)
			const receiverBalanceBefore = await context.viewFacet.balanceOf(receiver)

			await expect(openQuoteWithFees(quoteId, decimal(1n)))
				.to.emit(context.partyBQuoteActionsFacet, "OpenSolverFeeCharged")
				.withArgs(quoteId, await user.getAddress(), partyB, receiver, 1n, decimal(1n))

			expect(partyAAllocatedBefore - (await user.getBalanceInfo()).allocatedBalances).to.equal(decimal(1n))
			expect(await context.viewFacet.balanceOf(receiver)).to.equal(receiverBalanceBefore + decimal(1n))
			expect(await context.viewFacet.balanceOf(partyB)).to.equal(partyBBalanceBefore) // PartyB itself gets nothing
			expect((await getSolverFeeState(quoteId)).openFeeCharged).to.equal(decimal(1n))
		})

		it("credits the configured receiver on close", async function () {
			const partyB = await hedger.getAddress()
			const receiver = context.signers.feeCollector.address
			await (context.controlFacet.connect(hedger.signer) as any).setSolverFeeReceiver(partyB, receiver)

			const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16))
			await openQuote(quoteId)
			await requestClose(quoteId)

			const receiverBalanceBefore = await context.viewFacet.balanceOf(receiver)

			await expect(fillCloseWithFees(quoteId, decimal(1n)))
				.to.emit(context.partyBQuoteActionsFacet, "CloseSolverFeeCharged")
				.withArgs(quoteId, await user.getAddress(), partyB, receiver, 1n, decimal(1n))

			expect(await context.viewFacet.balanceOf(receiver)).to.equal(receiverBalanceBefore + decimal(1n))
			expect((await getSolverFeeState(quoteId)).closeFeeCharged).to.equal(decimal(1n))
		})

		it("rejects routing a solver fee back to PartyA", async function () {
			// Would move PartyA's allocated balance into free balance without setting deallocateTimestamp,
			// sidestepping the withdraw cooldown.
			const partyB = await hedger.getAddress()
			await (context.controlFacet.connect(hedger.signer) as any).setSolverFeeReceiver(partyB, await user.getAddress())

			const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16))
			await hedger.lockQuote(quoteId)

			await expect(openQuoteWithFees(quoteId, decimal(1n))).to.be.revertedWith("SolverFee: Receiver is partyA")
		})

		it("applies a receiver change only to subsequent fees", async function () {
			const partyB = await hedger.getAddress()
			const receiver = context.signers.feeCollector.address

			// First fee is charged with no receiver configured, so it lands on the PartyB itself.
			const quoteId = await sendQuoteWithSolverFeeCaps(decimal(2n, 16))
			await hedger.lockQuote(quoteId)
			const partyBBalanceBefore = await context.viewFacet.balanceOf(partyB)
			await openQuoteWithFees(quoteId, decimal(1n))
			expect(await context.viewFacet.balanceOf(partyB)).to.equal(partyBBalanceBefore + decimal(1n))

			// Redirecting afterwards leaves the collected fee alone and only affects the close fee.
			await (context.controlFacet.connect(hedger.signer) as any).setSolverFeeReceiver(partyB, receiver)
			const partyBBalanceAfterOpen = await context.viewFacet.balanceOf(partyB)
			const receiverBalanceBefore = await context.viewFacet.balanceOf(receiver)

			await requestClose(quoteId)
			await fillCloseWithFees(quoteId, decimal(1n))

			expect(await context.viewFacet.balanceOf(receiver)).to.equal(receiverBalanceBefore + decimal(1n))
			expect(await context.viewFacet.balanceOf(partyB)).to.equal(partyBBalanceAfterOpen)
		})
	})
}
