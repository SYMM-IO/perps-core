import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { BigNumberish, ethers } from "ethers"

import type { PairUpnlSigStructOutput } from "../../src/types/facets/FundingRate/FundingRateFacet.js"
import type { SettlementSigStructOutput, UnifiedSettlementSigStruct } from "../../src/types/facets/Settlement/SettlementFacet.js"
import type { QuoteStructOutput, SingleUpnlSigStructOutput } from "../../src/types/interfaces/ISymmio.js"
import { setBalance } from "../helpers/network-helpers.js"
import { decimal, serializeToJson, unDecimal } from "../utils/Common.js"
import { logger } from "../utils/LoggerUtils.js"
import { getPrice } from "../utils/PriceUtils.js"
import { getDummyPairUpnlAndPriceSig, getDummySettlementSig, getDummySingleUpnlSig, getDummyUnifiedSettlementSig } from "../utils/SignatureUtils.js"
import { runTx } from "../utils/TxUtils.js"
import { PositionType } from "./Enums.js"
import { RunContext } from "./RunContext.js"
import { PartyEntity } from "./partyEntitiy.js"
import { EmergencyCloseRequest, emergencyCloseRequestBuilder } from "./requestModels/EmergencyCloseRequest.js"
import { FillCloseRequest, limitFillCloseRequestBuilder } from "./requestModels/FillCloseRequest.js"
import { limitOpenRequestBuilder, OpenRequest } from "./requestModels/OpenRequest.js"

export class Hedger extends PartyEntity {
	constructor(context: RunContext, signer: HardhatEthersSigner) {
		super(context, signer)
	}

	public async setup() {
		await this.context.manager.registerHedger(this)
	}

	public async setBalances(collateralAmount?: BigNumberish, depositAmount?: BigNumberish) {
		const userAddress = await this.signer.getAddress()
		await runTx(this.context.collateral.connect(this.signer).approve(this.context.diamond, ethers.MaxUint256))

		if (collateralAmount) await runTx(this.context.collateral.connect(this.signer).mint(userAddress, collateralAmount))
		if (depositAmount) await runTx(this.context.accountFacet.connect(this.signer).deposit(depositAmount))
	}

	public async setNativeBalance(amount: bigint) {
		await setBalance(this.signer.address, amount)
	}

	public async register() {
		await runTx(this.context.controlFacet.connect(this.context.signers.admin).registerPartyB(await this.signer.getAddress()))
	}

	public async lockQuote(id: BigNumberish, upnl: bigint = 0n, allocateCoefficient: bigint | null = decimal(12n, 17)) {
		const isCrossPartyB = await this.context.viewFacet.isCrossPartyB(this.address)
		if (allocateCoefficient != null && !isCrossPartyB) {
			const quote = await this.context.viewFacetQuote.getQuote(id)
			const notional = unDecimal(BigInt(quote.quantity) * quote.requestedOpenPrice)
			await runTx(
				this.context.partyBAccountFacet.connect(this.signer).allocateForPartyB(unDecimal(notional * BigInt(allocateCoefficient)), quote.partyA),
			)
		}
		await runTx(this.context.partyBQuoteActionsFacet.connect(this.signer).lockQuote(id, await getDummySingleUpnlSig(upnl)))
	}

	public async unlockQuote(id: BigNumberish) {
		await runTx(this.context.partyBQuoteActionsFacet.connect(this.signer).unlockQuote(id))
	}

	public async openPosition(id: BigNumberish, request: OpenRequest = limitOpenRequestBuilder().build()) {
		const quote = await this.context.viewFacetQuote.getQuote(id)
		const user = this.context.manager.getUser(quote.partyA)
		logger.detailedDebug(
			serializeToJson({
				request: request,
				hedgerBalanceInfo: await this.getBalanceInfo(quote.partyA),
				hedgerUpnl: await this.getUpnl(quote.partyA),
				userBalanceInfo: await user.getBalanceInfo(),
				userUpnl: await user.getUpnl(),
			}),
		)
		await runTx(
			this.context.partyBPositionActionsFacet
				.connect(this.signer)
				.openPosition(
					id,
					request.filledAmount,
					request.openPrice,
					await getDummyPairUpnlAndPriceSig(BigInt(request.price), BigInt(request.upnlPartyA), BigInt(request.upnlPartyB)),
				),
		)
	}

	public async getBalance(): Promise<bigint> {
		return await this.context.viewFacet.balanceOf(await this.getAddress())
	}

	public async getBalanceInfo(partyA: string): Promise<BalanceInfo> {
		const b = await this.context.viewFacet.balanceInfoOfPartyB(await this.getAddress(), partyA)

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

	public async getBalanceInfoCrossPartyB(): Promise<BalanceInfo> {
		const b = await this.context.viewFacet.balanceInfoOfCrossPartyB(await this.getAddress())

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

	public async acceptCancelRequest(id: BigNumberish) {
		await runTx(this.context.partyBQuoteActionsFacet.connect(this.signer).acceptCancelRequest(id))
	}

	public async fillCloseRequest(id: BigNumberish, request: FillCloseRequest = limitFillCloseRequestBuilder().build()) {
		const quote = await this.context.viewFacetQuote.getQuote(id)
		const user = this.context.manager.getUser(quote.partyA)
		logger.detailedDebug(
			serializeToJson({
				request: request,
				hedgerBalanceInfo: await this.getBalanceInfo(quote.partyA),
				hedgerUpnl: await this.getUpnl(quote.partyA),
				userBalanceInfo: await user.getBalanceInfo(),
				userUpnl: await user.getUpnl(),
			}),
		)
		await runTx(
			this.context.partyBPositionActionsFacet
				.connect(this.signer)
				.fillCloseRequest(
					id,
					request.filledAmount,
					request.closedPrice,
					await getDummyPairUpnlAndPriceSig(BigInt(request.price), BigInt(request.upnlPartyA), BigInt(request.upnlPartyB)),
				),
		)
	}

	public async chargeFundingRate(partyA: string, quoteIds: BigNumberish[], rates: BigNumberish[], signature: PairUpnlSigStructOutput) {
		await this.context.fundingRateFacet.connect(this.signer).chargeFundingRate(partyA, quoteIds, rates, signature)
	}

	public async acceptCancelCloseRequest(id: BigNumberish) {
		await runTx(this.context.partyBPositionActionsFacet.connect(this.signer).acceptCancelCloseRequest(id))
	}

	public async fillCloseRequestToLiquidation(id: BigNumberish, request: FillCloseRequest = limitFillCloseRequestBuilder().build()): Promise<bigint> {
		const quote = await this.context.viewFacetQuote.getQuote(id)
		const user = this.context.manager.getUser(quote.partyA)
		logger.detailedDebug(
			serializeToJson({
				request: request,
				hedgerBalanceInfo: await this.getBalanceInfo(quote.partyA),
				hedgerUpnl: await this.getUpnl(quote.partyA),
				userBalanceInfo: await user.getBalanceInfo(),
				userUpnl: await user.getUpnl(),
			}),
		)
		// runTx already returns the receipt (calls .wait() internally)
		const receipt = await runTx(
			this.context.partyBPositionActionsFacet
				.connect(this.signer)
				.fillCloseRequestToLiquidation(
					id,
					request.closedPrice,
					await getDummyPairUpnlAndPriceSig(BigInt(request.price), BigInt(request.upnlPartyA), BigInt(request.upnlPartyB)),
				),
		)
		// Parse the FillCloseRequest event to get the filled amount
		const iface = this.context.partyBPositionActionsFacet.interface
		for (const log of receipt?.logs || []) {
			try {
				const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data })
				if (parsed?.name === "FillCloseRequest") {
					return parsed.args.filledAmount
				}
			} catch {
				// Not this event, continue
			}
		}
		return 0n
	}

	public async liquidate(partyA: string, sig: SingleUpnlSigStructOutput | Promise<SingleUpnlSigStructOutput> = getDummySingleUpnlSig()) {
		let signature = sig instanceof Promise ? await sig : sig
		await runTx(
			this.context.partyBLiquidationFacet.connect(this.context.signers.liquidator).liquidatePartyB(await this.signer.getAddress(), partyA, signature),
		)
	}

	public async emergencyClosePosition(id: BigNumberish, request: EmergencyCloseRequest = emergencyCloseRequestBuilder().build()) {
		const quote = await this.context.viewFacetQuote.getQuote(id)
		const user = this.context.manager.getUser(quote.partyA)
		logger.detailedDebug(
			serializeToJson({
				request: request,
				hedgerBalanceInfo: await this.getBalanceInfo(quote.partyA),
				hedgerUpnl: await this.getUpnl(quote.partyA),
				userBalanceInfo: await user.getBalanceInfo(),
				userUpnl: await user.getUpnl(),
			}),
		)
		await runTx(
			this.context.partyBEmergencyActionsFacet
				.connect(this.signer)
				.emergencyClosePosition(id, await getDummyPairUpnlAndPriceSig(BigInt(request.price), BigInt(request.upnlPartyA), BigInt(request.upnlPartyB))),
		)
	}

	public async settleUpnl(
		partyA: string,
		updatedPrices: bigint[],
		sig: Promise<SettlementSigStructOutput> | SettlementSigStructOutput = getDummySettlementSig(),
	) {
		let signature = sig instanceof Promise ? await sig : sig

		const user = this.context.manager.getUser(partyA)
		logger.detailedDebug(
			serializeToJson({
				partyA: partyA,
				updatedPrices: updatedPrices,
				sig: sig,
				userBalanceInfo: await user.getBalanceInfo(),
				userUpnl: await user.getUpnl(),
			}),
		)
		await runTx(this.context.settlementFacet.connect(this.signer).settleUpnl(signature, updatedPrices, partyA))
	}

	public async settleUpnlUnified(
		updatedPrices: bigint[],
		sig: Promise<UnifiedSettlementSigStruct> | UnifiedSettlementSigStruct = getDummyUnifiedSettlementSig(),
	) {
		let signature = sig instanceof Promise ? await sig : sig

		logger.detailedDebug(
			serializeToJson({
				partyB: signature.partyB,
				partyAs: signature.partyAs,
				updatedPrices: updatedPrices,
				sig: sig,
			}),
		)
		await runTx(this.context.settlementFacet.connect(this.signer).settleUpnlUnified(signature, updatedPrices))
	}

	public async getAddress() {
		return await this.signer.getAddress()
	}

	public async getUpnl(partyA: string): Promise<bigint> {
		let openPositions: QuoteStructOutput[] = []
		const pageSize = 30
		let last = 0
		while (true) {
			const page = await this.context.viewFacetQuote.getPartyBOpenPositions(await this.getAddress(), partyA, last, pageSize)
			openPositions.push(...page)
			if (page.length < pageSize) break
		}

		let upnl = 0n
		for (const pos of openPositions) {
			const priceDiff = pos.openedPrice - (await getPrice())
			const amount = pos.quantity - pos.closedAmount
			upnl += unDecimal(amount * priceDiff) * (pos.positionType === BigInt(PositionType.LONG) ? -1n : 1n)
		}
		return upnl
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
