import {setBalance} from "../helpers/network-helpers.js"
import {BigNumberish, ethers, EventLog} from "ethers"

import { getPriceFetcher, serializeToJson, unDecimal } from "../utils/Common.js"
import { logger } from "../utils/LoggerUtils.js"
import { getPrice } from "../utils/PriceUtils.js"
import { PositionType } from "./Enums.js"
import { RunContext } from "./RunContext.js"
import { CloseRequest, limitCloseRequestBuilder } from "./requestModels/CloseRequest.js"
import {
	limitQuoteRequestBuilder,
	limitQuoteRequestWithDataBuilder,
	QuoteRequest,
	QuoteRequestWithData,
} from "./requestModels/QuoteRequest.js";
import { runTx } from "../utils/TxUtils.js"
import { getDummyLiquidationSig } from "../utils/SignatureUtils.js"
import type { LiquidationSigStruct } from "../../src/types/facets/PartyALiquidation/PartyALiquidationFacet.js"
import type { QuoteStructOutput, SettlementSigStruct } from "../../src/types/interfaces/ISymmio.js"
import type { HighLowPriceSigStruct } from "../../src/types/facets/ForceActions/ForceActionsFacet.js"
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { PartyEntity } from "./partyEntitiy.js"

export class User extends PartyEntity {
	constructor(context: RunContext, signer: HardhatEthersSigner) {
		super(context, signer)
	}

	public async setup() {
		await this.context.manager.registerUser(this)
	}

	public async setBalances(collateralAmount?: BigNumberish, depositAmount?: BigNumberish, allocatedAmount?: BigNumberish) {
		const userAddress = this.signer.getAddress()

		await runTx(this.context.collateral.connect(this.signer).approve(this.context.diamond, ethers.MaxUint256))

		if (collateralAmount) await runTx(this.context.collateral.connect(this.signer).mint(userAddress, collateralAmount))
		if (depositAmount) await runTx(this.context.accountFacet.connect(this.signer).deposit(depositAmount))
		if (allocatedAmount) await runTx(this.context.accountFacet.connect(this.signer).allocate(allocatedAmount))
	}

	public async setNativeBalance(amount: bigint) {
		await setBalance(this.signer.address, amount)
	}

	public async sendQuote(request: QuoteRequest = limitQuoteRequestBuilder().build()): Promise<bigint> {
		logger.detailedDebug(
			serializeToJson({
				request: request,
				userBalanceInfo: await this.getBalanceInfo(),
				userUpnl: await this.getUpnl(),
			}),
		)
		// Use request.affiliate if explicitly set (non-zero), otherwise fall back to accountManager
		const affiliate = request.affiliate && request.affiliate !== "0x0000000000000000000000000000000000000000"
			? request.affiliate
			: this.context.accountManager
		let tx = await this.context.partyAFacet
			.connect(this.signer)
			.sendQuoteWithAffiliate(
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
				request.maxFundingRate,
				await request.deadline,
				affiliate,
				await request.upnlSig,
			)
		const receipt = await tx.wait()

		if (receipt && receipt.logs) {
			const sendQuoteEvent = receipt.logs.find((log): log is EventLog => {
				return (log as EventLog).eventName === "SendQuote"
			})

			if (sendQuoteEvent && sendQuoteEvent.args) {
				const id = sendQuoteEvent.args.quoteId
				return id.toString()
			}
		}
		throw new Error("SendQuote event not found in transaction receipt")
	}

	public async sendQuoteWithData(request: QuoteRequestWithData = limitQuoteRequestWithDataBuilder().build()): Promise<bigint> {
		logger.detailedDebug(
			serializeToJson({
				request: request,
				userBalanceInfo: await this.getBalanceInfo(),
				userUpnl: await this.getUpnl(),
			}),
		)
		let tx = await this.context.partyAFacet
			.connect(this.signer)
			.sendQuoteWithAffiliateAndData(
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
				this.context.accountManager,
				await request.upnlSig,
				request.data
			)
		const receipt = await tx.wait()

		if (receipt && receipt.logs) {
			const sendQuoteEvent = receipt.logs.find((log): log is EventLog => {
				return (log as EventLog).eventName === "SendQuote"
			})

			if (sendQuoteEvent && sendQuoteEvent.args) {
				const id = sendQuoteEvent.args.quoteId
				return id.toString()
			}
		}
		throw new Error("SendQuote event not found in transaction receipt")
	}

	public async requestToCancelQuote(id: BigNumberish) {
		logger.detailedDebug(
			serializeToJson({
				request: "RequestToCancelQuote",
				userBalanceInfo: await this.getBalanceInfo(),
				userUpnl: await this.getUpnl(),
			}),
		)
		await runTx(this.context.partyAFacet.connect(this.signer).requestToCancelQuote(id))
	}

	public async forceCancelQuote(id: BigNumberish) {
		logger.detailedDebug(
			serializeToJson({
				request: "ForceCancelQuote",
				userBalanceInfo: await this.getBalanceInfo(),
				userUpnl: await this.getUpnl(),
			}),
		)
		await runTx(this.context.forceActionsFacet.connect(this.signer).forceCancelQuote(id))
	}

	public async forceCancelCloseRequest(id: BigNumberish) {
		logger.detailedDebug(
			serializeToJson({
				request: "ForceCancelCloseRequest",
				userBalanceInfo: await this.getBalanceInfo(),
				userUpnl: await this.getUpnl(),
			}),
		)
		await runTx(this.context.forceActionsFacet.connect(this.signer).forceCancelCloseRequest(id))
	}

	public async getBalanceInfo(): Promise<BalanceInfo> {
		const b = await this.context.viewFacet.balanceInfoOfPartyA(await this.getAddress())
		return {
			allocatedBalances: b[0],
			lockedCva: b[1],
			lockedLf: b[2],
			lockedMmPartyA: b[3],
			lockedMmPartyB: b[4],
			totalLockedPartyA: b[1] + b[2] + b[3],
			totalLockedPartyB: b[1] + b[2] + b[4],
			pendingLockedCva: b[5],
			pendingLockedLf: b[6],
			pendingLockedMmPartyA: b[7],
			pendingLockedMmPartyB: b[8],
			totalPendingLockedPartyA: b[5] + b[6] + b[7],
			totalPendingLockedPartyB: b[5] + b[6] + b[8],
		}
	}


	public async requestToClosePosition(id: BigNumberish, request: CloseRequest = limitCloseRequestBuilder().build()) {
		logger.detailedDebug(
			serializeToJson({
				request: request,
				userBalanceInfo: await this.getBalanceInfo(),
				userUpnl: await this.getUpnl(),
			}),
		)
		await runTx(
			this.context.partyAFacet
				.connect(this.signer)
				.requestToClosePosition(id, request.closePrice, request.quantityToClose, request.orderType, await request.deadline),
		)
	}

	public async forceClosePosition(id: BigNumberish, signature: HighLowPriceSigStruct) {
		logger.detailedDebug(
			serializeToJson({
				signature: signature,
				userBalanceInfo: await this.getBalanceInfo(),
				userUpnl: await this.getUpnl(),
			}),
		)
		await runTx(this.context.forceActionsFacet.connect(this.signer).forceClosePosition(id, signature))
	}

	public async settleAndForceClosePosition(id: BigNumberish, highLowPriceSigStruct: HighLowPriceSigStruct, settleSig: SettlementSigStruct, updatedPrices: bigint[]) {
		logger.detailedDebug(
			serializeToJson({
				highLowPriceSigStruct: highLowPriceSigStruct,
				settleSig: settleSig,
				updatedPrices: updatedPrices,
				userBalanceInfo: await this.getBalanceInfo(),
				userUpnl: await this.getUpnl(),
			}),
		)
		await runTx(this.context.forceActionsFacet.connect(this.signer).settleAndForceClosePosition(id, highLowPriceSigStruct, settleSig, updatedPrices))
	}

	public async requestToCancelCloseRequest(id: BigNumberish) {
		logger.detailedDebug(
			serializeToJson({
				request: "RequestToCancelCloseRequest",
				userBalanceInfo: await this.getBalanceInfo(),
				userUpnl: await this.getUpnl(),
			}),
		)
		await runTx(this.context.partyAFacet.connect(this.signer).requestToCancelCloseRequest(id))
	}

	public getAddress() {
		return this.signer.getAddress()
	}

	public async getUpnl(
		symbolIdPriceFetcher: ((symbolId: bigint) => Promise<bigint>) | null = null,
		symbolNamePriceFetcher: (symbol: string) => Promise<bigint> = getPrice,
	): Promise<bigint> {
		let openPositions = await this.getOpenPositions()
		let upnl = 0n
		for (const pos of openPositions) {
			const priceDiff = pos.openedPrice - (
				symbolIdPriceFetcher != null
					? await symbolIdPriceFetcher(pos.symbolId)
					: await symbolNamePriceFetcher((await this.context.viewFacetSymbol.getSymbol(pos.symbolId)).name)
			)
			const amount = pos.quantity - pos.closedAmount
			upnl += unDecimal(BigInt(amount) * priceDiff) * (pos.positionType == BigInt(PositionType.LONG) ? -1n : 1n)
		}
		return upnl
	}

	public async getTotalUnrealisedLoss(
		symbolIdPriceFetcher: ((symbolId: bigint) => Promise<bigint>) | null = null,
		symbolNamePriceFetcher: (symbol: string) => Promise<bigint> = getPrice,
	): Promise<bigint> {
		let openPositions = await this.getOpenPositions()
		let upnl = 0n
		for (const pos of openPositions) {
			const priceDiff = pos.openedPrice - (
				symbolIdPriceFetcher != null
					? await symbolIdPriceFetcher(pos.symbolId)
					: await symbolNamePriceFetcher((await this.context.viewFacetSymbol.getSymbol(pos.symbolId)).name)
			)
			const amount = pos.quantity - pos.closedAmount
			upnl += unDecimal(BigInt(amount) * priceDiff) * (pos.positionType == BigInt(PositionType.LONG) ? 0n : 1n)
		}
		return upnl
	}

	public async getAvailableBalanceForQuote(upnl: bigint): Promise<bigint> {
		const balanceInfo = await this.getBalanceInfo()
		let available: bigint
		if (upnl > 0n) {
			available = balanceInfo.allocatedBalances + upnl - (balanceInfo.totalLockedPartyA + balanceInfo.totalPendingLockedPartyA)
		} else {
			let mm = balanceInfo.lockedMmPartyA
			let mUpnl = -upnl
			let considering_mm = mUpnl > mm ? mUpnl : mm
			available = balanceInfo.allocatedBalances
				- (balanceInfo.lockedCva + balanceInfo.lockedLf + balanceInfo.totalPendingLockedPartyA)
				- considering_mm
		}
		return available
	}

	public async liquidateAndSetSymbolPrices(
		symbolIds: bigint[],
		prices: bigint[],
		quoteIds: bigint[],
		liquidator: HardhatEthersSigner = this.context.signers.liquidator,
	): Promise<LiquidationSigStruct> {
		const upnl = await this.getUpnl(getPriceFetcher(symbolIds, prices)) - (await this.context.viewFacetQuote.getSumQuoteFundingDebts(quoteIds))
		const totalUnrealizedLoss = await this.getTotalUnrealisedLoss(getPriceFetcher(symbolIds, prices)) - (await this.context.viewFacetQuote.getSumQuoteFundingDebts(quoteIds))
		const allocatedBalance = (await this.getBalanceInfo()).allocatedBalances
		const sign = await getDummyLiquidationSig("0x10", upnl, symbolIds, prices, totalUnrealizedLoss, allocatedBalance)
		await this.context.partyALiquidationFacet.connect(liquidator).liquidatePartyA(this.getAddress(), sign)
		await this.context.partyALiquidationFacet.connect(liquidator).setSymbolsPrice(this.getAddress(), sign)
		return sign
	}

	public async deferredLiquidateAndSetSymbolPrices(
		symbolIds: bigint[],
		prices: bigint[],
		quoteIds: bigint[],
		liquidator: HardhatEthersSigner = this.context.signers.liquidator,
	): Promise<LiquidationSigStruct> {
		const upnl = await this.getUpnl(getPriceFetcher(symbolIds, prices)) - (await this.context.viewFacetQuote.getSumQuoteFundingDebts(quoteIds))
		const totalUnrealizedLoss = await this.getTotalUnrealisedLoss(getPriceFetcher(symbolIds, prices)) - (await this.context.viewFacetQuote.getSumQuoteFundingDebts(quoteIds))
		const allocatedBalance = (await this.getBalanceInfo()).allocatedBalances
		const sign = await getDummyLiquidationSig("0x10", upnl, symbolIds, prices, totalUnrealizedLoss, allocatedBalance)
		await this.context.partyALiquidationFacet.connect(liquidator).deferredLiquidatePartyA(this.getAddress(), sign)
		await this.context.partyALiquidationFacet.connect(liquidator).deferredSetSymbolsPrice(this.getAddress(), sign)
		return sign
	}

	public async liquidatePendingPositions(liquidator: HardhatEthersSigner = this.context.signers.liquidator) {
		await this.context.partyALiquidationFacet.connect(liquidator).liquidatePendingPositionsPartyA(this.getAddress())
	}

	public async liquidatePositions(positions: BigNumberish[] = [], liquidator: HardhatEthersSigner = this.context.signers.liquidator) {
		if (positions.length == 0) positions = (await this.getOpenPositions()).map(value => value.id)
		await this.context.partyALiquidationFacet.connect(liquidator).liquidatePositionsPartyA(this.getAddress(), positions)
	}

	public async getOpenPositions(): Promise<QuoteStructOutput[]> {
		let openPositions: QuoteStructOutput[] = []
		const pageSize = 30
		let last = 0
		while (true) {
			let page = await this.context.viewFacetQuote.getPartyAOpenPositions(this.getAddress(), last, pageSize)
			openPositions.push(...page)
			if (page.length < pageSize) break
		}
		return openPositions
	}

	public async settleLiquidation(
		partyB: HardhatEthersSigner = this.context.signers.hedger,
		liquidator: HardhatEthersSigner = this.context.signers.liquidator,
	): Promise<void> {
		await this.context.partyALiquidationFacet.connect(liquidator).settlePartyALiquidation(await this.getAddress(), [await partyB.getAddress()])
	}

	public async getLiquidatedStateOfPartyA() {
		return this.context.viewFacet.getLiquidatedStateOfPartyA(await this.getAddress())
	}
}

export interface BalanceInfo {
	allocatedBalances: bigint
	lockedCva: bigint
	lockedMmPartyA: bigint
	lockedMmPartyB: bigint
	lockedLf: bigint
	totalLockedPartyA: bigint
	totalLockedPartyB: bigint
	pendingLockedCva: bigint
	pendingLockedMmPartyA: bigint
	pendingLockedMmPartyB: bigint
	pendingLockedLf: bigint
	totalPendingLockedPartyA: bigint
	totalPendingLockedPartyB: bigint
}
