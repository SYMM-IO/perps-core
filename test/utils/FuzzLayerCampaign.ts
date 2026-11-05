import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { expect } from "chai"

import { PositionType, QuoteStatus } from "../models/Enums.js"
import { FuzzLayerUser, type FuzzLayerRoute } from "../models/FuzzLayerUser.js"
import type { Hedger } from "../models/Hedger.js"
import type { RunContext } from "../models/RunContext.js"
import type { TestManager } from "../models/TestManager.js"
import { limitCloseRequestBuilder } from "../models/requestModels/CloseRequest.js"
import { limitOpenRequestBuilder } from "../models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { CloseRequestValidator } from "../models/validators/CloseRequestValidator.js"
import { FillCloseRequestValidator, calculateCloseFee } from "../models/validators/FillCloseRequestValidator.js"
import { OpenPositionValidator } from "../models/validators/OpenPositionValidator.js"
import { decimal, getBlockTimestamp, getTradingFeeForQuoteWithFilledAmount } from "./Common.js"
import { pick, randomBigNumber } from "./RandomUtils.js"
import { getDummySingleUpnlSig } from "./SignatureUtils.js"

export type FuzzLayerCampaignOptions = {
	context: RunContext
	manager: TestManager
	owner: HardhatEthersSigner
	hedger: Hedger
	route: FuzzLayerRoute
	isolationType?: number
	vaIsolationType?: number
	positionType?: PositionType
}

/** Partial fills, margin movement, hook cleanup, and reuse through both layer entry paths. */
export async function executeFuzzLayerLifecycle(options: FuzzLayerCampaignOptions): Promise<{ quoteIds: bigint[]; detail: string }> {
	const { context, manager, owner, hedger, route } = options
	const isolationType = options.isolationType ?? pick([0, 1, 2, 3])
	const positionType = options.positionType ?? pick([PositionType.LONG, PositionType.SHORT])
	const directionalIsolation = positionType === PositionType.LONG ? 2 : 3
	const vaIsolation =
		isolationType === 3
			? (options.vaIsolationType ?? pick([0, 1, directionalIsolation]))
			: isolationType === 0
				? 0
				: isolationType === 2
					? directionalIsolation
					: 1
	const parent = new FuzzLayerUser(context, owner, route, undefined, isolationType)
	await parent.setup()
	const deposit = decimal(10_000n)
	const margin = decimal(randomBigNumber(1_500n, 500n))
	await parent.setBalances(deposit, deposit)
	const request = limitQuoteRequestBuilder()
		.partyBWhiteList([await hedger.getAddress()])
		.positionType(positionType)
		.deadline((await getBlockTimestamp()) + 100_000n)
		.build()

	let user: FuzzLayerUser
	let quoteId: bigint
	if (isolationType === 3) {
		const account = await context.alCoreFacet.connect(owner).createCustomVirtualAccount.staticCall(parent.address, "0x", vaIsolation, 1)
		await parent.executeAccountLayerCall(context.alCoreFacet, "createCustomVirtualAccount", [parent.address, "0x", vaIsolation, 1])
		user = new FuzzLayerUser(context, owner, route, account)
		await user.setup()
		await parent.executeAccountLayerCall(context.alMarginFacet, "addMargin", [user.address, margin])
		quoteId = await user.sendQuote(request)
	} else {
		quoteId = await parent.sendQuoteWithMargin(request, vaIsolation, margin)
		user = new FuzzLayerUser(context, owner, route, (await context.viewFacetQuote.getQuote(quoteId)).partyA)
		await user.setup()
	}
	expect(user.address).not.to.equal(owner.address)
	expect(user.address).not.to.equal(parent.address)
	expect(await context.alViewFacet.ownerOf(user.address)).to.equal(owner.address)
	expect((await context.alViewFacet.getVirtualAccount(user.address)).parentAccount).to.equal(parent.address)
	expect(await context.viewFacet.balanceOf(parent.address)).to.equal(deposit - margin)
	expect((await manager.observeQuoteState(quoteId)).quoteStatus).to.equal(BigInt(QuoteStatus.PENDING))

	// Move margin while an intent reserves funds; total family collateral must stay constant.
	const extraMargin = decimal(randomBigNumber(100n, 10n))
	const beforeMargin = await user.getBalanceInfo()
	await parent.executeAccountLayerCall(context.alMarginFacet, "addMargin", [user.address, extraMargin])
	expect((await user.getBalanceInfo()).allocatedBalances).to.equal(beforeMargin.allocatedBalances + extraMargin)
	expect(await context.viewFacet.balanceOf(parent.address)).to.equal(deposit - margin - extraMargin)
	await parent.executeAccountLayerCall(context.alMarginFacet, "removeMargin", [user.address, extraMargin, await getDummySingleUpnlSig(0n)])
	expect((await user.getBalanceInfo()).allocatedBalances).to.equal(beforeMargin.allocatedBalances)
	expect(await context.viewFacet.balanceOf(parent.address)).to.equal(deposit - margin)

	await hedger.lockQuote(quoteId)
	await manager.observeQuoteState(quoteId)
	const filled = decimal(randomBigNumber(80n, 40n))
	const remainderId = (await context.viewFacetQuote.getNextQuoteId()) + 1n
	const openValidator = new OpenPositionValidator()
	const beforeOpen = await openValidator.before(context, { user, hedger, quoteId })
	await hedger.openPosition(quoteId, limitOpenRequestBuilder().filledAmount(filled).openPrice(decimal(1n)).price(decimal(1n)).build())
	const remainderStatus = vaIsolation === 0 ? QuoteStatus.CANCELED : QuoteStatus.PENDING
	await openValidator.after(context, {
		user,
		hedger,
		quoteId,
		fillAmount: filled,
		openedPrice: decimal(1n),
		beforeOutput: beforeOpen,
		newQuoteId: remainderId,
		newQuoteTargetStatus: remainderStatus,
	})
	const opened = await manager.observeQuoteState(quoteId)
	const remainder = await manager.observeQuoteState(remainderId)
	expect(remainder.parentId).to.equal(quoteId)
	expect(remainder.partyA).to.equal(user.address)
	expect(remainder.quoteStatus).to.equal(BigInt(remainderStatus))
	expect(await context.alViewFacet.getVirtualAccountQuoteIds(user.address, 0, 100)).to.have.members(
		remainderStatus === QuoteStatus.PENDING ? [quoteId, remainderId] : [quoteId],
	)

	const closeValidator = new CloseRequestValidator()
	const fillValidator = new FillCloseRequestValidator()
	const partialClose = (filled * randomBigNumber(60n, 25n)) / 100n
	let totalCloseFees = 0n
	for (const amount of [partialClose, filled - partialClose]) {
		const beforeRequest = await closeValidator.before(context, { user, hedger, quoteId })
		await user.requestToClosePosition(
			quoteId,
			limitCloseRequestBuilder()
				.quantityToClose(amount)
				.closePrice(opened.openedPrice)
				.deadline((await getBlockTimestamp()) + 100_000n)
				.build(),
		)
		await closeValidator.after(context, {
			user,
			hedger,
			quoteId,
			closePrice: opened.openedPrice,
			quantityToClose: amount,
			beforeOutput: beforeRequest,
		})
		await manager.observeQuoteState(quoteId)
		const beforeFill = await fillValidator.before(context, { user, hedger, quoteId })
		await hedger.fillCloseRequest(quoteId, {
			filledAmount: amount,
			closedPrice: opened.openedPrice,
			price: opened.openedPrice,
			upnlPartyA: 0n,
			upnlPartyB: 0n,
		})
		totalCloseFees += calculateCloseFee(amount, opened.openedPrice, opened.closeFee)
		await manager.observeQuoteState(quoteId)
		// The final POSITION close sweeps its allocation to the parent in the same transaction.
		if ((await context.alViewFacet.getVirtualAccount(user.address)).isExists) {
			await fillValidator.after(context, {
				user,
				hedger,
				quoteId,
				closePrice: opened.openedPrice,
				fillAmount: amount,
				beforeOutput: beforeFill,
			})
		}
	}
	expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(BigInt(QuoteStatus.CLOSED))
	if (remainderStatus === QuoteStatus.PENDING) {
		expect((await context.alViewFacet.getVirtualAccount(user.address)).isExists).to.equal(true)
		expect(await context.alViewFacet.getVirtualAccountQuoteIds(user.address, 0, 100)).to.deep.equal([remainderId])
		await user.requestToCancelQuote(remainderId)
		await manager.observeQuoteState(remainderId)
	}

	expect((await context.alViewFacet.getVirtualAccount(user.address)).isExists).to.equal(false)
	expect(await context.alViewFacet.getVirtualAccountQuoteIds(user.address, 0, 100)).to.deep.equal([])
	expect(await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(parent.address, 0, 100)).to.deep.equal([])
	expect((await user.getBalanceInfo()).allocatedBalances).to.equal(0n)
	expect(await context.viewFacet.balanceOf(user.address)).to.equal(0n)
	expect(await context.viewFacetSymbol.getConnectedPartyBs(user.address)).to.deep.equal([])
	const openFee = await getTradingFeeForQuoteWithFilledAmount(context, quoteId, filled)
	const returnedBalance = deposit - openFee - totalCloseFees
	expect(await context.viewFacet.balanceOf(parent.address)).to.equal(returnedBalance)
	await user.assertExecutionContextCleared()

	// Reuse the deleted address, then cancel a fresh quote to test the other terminal hook.
	let reusedQuoteId: bigint
	if (isolationType === 3) {
		const reused = await context.alCoreFacet.connect(owner).createCustomVirtualAccount.staticCall(parent.address, "0x", vaIsolation, 1)
		expect(reused).to.equal(user.address)
		await parent.executeAccountLayerCall(context.alCoreFacet, "createCustomVirtualAccount", [parent.address, "0x", vaIsolation, 1])
		await parent.executeAccountLayerCall(context.alMarginFacet, "addMargin", [reused, margin])
		reusedQuoteId = await user.sendQuote(request)
	} else {
		reusedQuoteId = await parent.sendQuoteWithMargin(request, vaIsolation, margin)
	}
	expect((await manager.observeQuoteState(reusedQuoteId)).partyA).to.equal(user.address)
	await user.requestToCancelQuote(reusedQuoteId)
	expect((await manager.observeQuoteState(reusedQuoteId)).quoteStatus).to.equal(BigInt(QuoteStatus.CANCELED))
	expect((await context.alViewFacet.getVirtualAccount(user.address)).isExists).to.equal(false)
	expect(await context.viewFacet.balanceOf(parent.address)).to.equal(returnedBalance)
	await user.assertExecutionContextCleared()
	return {
		quoteIds: [quoteId, remainderId, reusedQuoteId],
		detail: `${route}; isolation=${isolationType}; direction=${PositionType[positionType]}; funded, partially filled/closed, swept, and reused VA ${user.address}`,
	}
}
