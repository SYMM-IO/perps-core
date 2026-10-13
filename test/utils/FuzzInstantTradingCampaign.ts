import { expect } from "chai"
import { ethers } from "ethers"

import { OrderType, PositionType, QuoteStatus } from "../models/Enums.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { calculateCloseFee } from "../models/validators/FillCloseRequestValidator.js"
import { decimal, getBlockTimestamp, getTradingFeeForQuoteWithFilledAmount } from "./Common.js"
import { createFuzzCustomVA, fundedFuzzParent, type FuzzAccountFeatureOptions, type FuzzLayerResult } from "./FuzzAccountLayerFeatures.js"
import { FuzzInstantExecutor, type FuzzSignedOperation } from "./FuzzInstantExecutor.js"
import { pick, randomBigNumber } from "./RandomUtils.js"
import { getDummyPairUpnlAndPriceSig, getDummySingleUpnlSig } from "./SignatureUtils.js"
import { runTx } from "./TxUtils.js"

/** Atomic send/lock/open, then mixed PartyA/PartyB partial and final close batches. */
export async function executeFuzzInstantTrading(
	options: FuzzAccountFeatureOptions & { execution?: "template" | "batch"; instantOpen?: boolean; nativeContext?: boolean },
): Promise<FuzzLayerResult> {
	const { context, manager, owner } = options
	const execution = options.execution ?? "template"
	const instantOpen = execution === "template" && (options.instantOpen ?? pick([true, false]))
	const nativeContext = options.nativeContext ?? pick([true, false])
	const previousContext = await context.instantLayer.transientContextEnabled()
	await runTx(context.instantLayer.setTransientContextEnabled(nativeContext))
	try {
		const parent = await fundedFuzzParent(options)
		const user = await createFuzzCustomVA(options, parent)
		const margin = decimal(randomBigNumber(2_000n, 1_000n))
		await parent.executeAccountLayerCall(context.alMarginFacet, "addMargin", [user.address, margin])
		const partyB = await context.symmioPartyB.getAddress()
		const il = context.instantLayer
		if (!(await context.viewFacet.isPartyB(partyB))) await runTx(context.controlFacet.registerPartyB(partyB))
		if (!(await il.isPartyBRegistered(partyB))) await runTx(il.registerPartyBs([partyB]))
		await runTx(context.controlFacet.setPartyBBindable(partyB, true))
		await runTx(context.symmioPartyB.setSigner(context.signers.hedger.address))
		await runTx(context.symbolControlFacet.whitelistSymbolType(partyB, 1))
		await user.executeSymmioCall(context.bindingFacet, "bindToPartyB", [partyB])
		await runTx(context.collateral.mint(context.signers.admin.address, decimal(5_000n)))
		await runTx(context.collateral.approve(context.diamond, ethers.MaxUint256))
		await runTx(context.accountFacet.depositFor(partyB, decimal(5_000n)))
		await runTx(
			context.symmioPartyB._call([context.partyBAccountFacet.interface.encodeFunctionData("allocateForPartyB", [decimal(500n), user.address])]),
		)
		const executor = new FuzzInstantExecutor(context, `trading:${parent.address}`)
		const direction = pick([PositionType.LONG, PositionType.SHORT])
		const quantity = decimal(randomBigNumber(101n, 50n))
		const price = decimal(1n)
		const request = limitQuoteRequestBuilder()
			.partyBWhiteList([partyB])
			.positionType(direction)
			.quantity(quantity)
			.deadline(await getBlockTimestamp(100_000n))
			.build()
		const sendCd = await user.encodeSendQuote(request)
		const nextQuote = (await context.viewFacetQuote.getNextQuoteId()) + 1n
		const placeholder = execution === "template" ? 0n : nextQuote
		const lockCd = context.partyBQuoteActionsFacet.interface.encodeFunctionData("lockQuote", [placeholder, await getDummySingleUpnlSig(0n)])
		const openCd = (amount: bigint) =>
			context.partyBPositionActionsFacet.interface.encodeFunctionData("openPosition", [placeholder, amount, price, pairSig])
		const pairSig = await getDummyPairUpnlAndPriceSig(price, 0n, 0n)
		let templateId: bigint | undefined
		if (execution === "template") {
			templateId = await il.getNextTemplateId()
			await runTx(
				il.addTemplate(`fuzz-open-${parent.address}`, [
					{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
					{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] },
					{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] },
				]),
			)
			await runTx(il.setTemplateInstantOpenMode(templateId, instantOpen))
		}
		const partyBNonce = await il.nonces(partyB)
		async function signedOpen(amount: bigint): Promise<FuzzSignedOperation[]> {
			return [
				await executor.sign(owner, user.address, context.diamond, sendCd),
				await executor.sign(context.signers.hedger, partyB, context.diamond, lockCd, { isPartyB: true, nonce: partyBNonce + 1n }),
				await executor.sign(context.signers.hedger, partyB, context.diamond, openCd(amount), { isPartyB: true, nonce: partyBNonce + 2n }),
			]
		}
		const failedOps = await signedOpen(quantity + decimal(1n))
		const beforeNonce = await il.nonces(user.address)
		const beforeBalance = await user.getBalanceInfo()
		const beforePartyB = await context.viewFacet.balanceInfoOfPartyB(partyB, user.address)
		const failedArgs = [
			failedOps.map(entry => entry.operation),
			failedOps.map(entry => entry.signature),
			failedOps.map(() => []),
			failedOps.map(() => []),
		] as const
		await expect(
			templateId === undefined ? il.executeBatch(...failedArgs) : il.executeTemplate(templateId, ...failedArgs),
		).to.be.revertedWithCustomError(il, "OperationFailed")
		await executor.assertUnused(
			failedOps,
			new Map([
				[user.address, beforeNonce],
				[partyB, partyBNonce],
			]),
		)
		expect(await user.getBalanceInfo()).to.deep.equal(beforeBalance)
		expect(await context.viewFacet.balanceInfoOfPartyB(partyB, user.address)).to.deep.equal(beforePartyB)
		expect(await context.viewFacetQuote.getNextQuoteId()).to.equal(nextQuote - 1n)
		expect(await context.alViewFacet.getVirtualAccountQuoteIds(user.address, 0, 100)).to.deep.equal([])
		const operations = await signedOpen(quantity)
		if (templateId !== undefined) {
			await runTx(il.setTemplateActive(templateId, false))
			await expect(
				il.executeTemplate(
					templateId,
					operations.map(entry => entry.operation),
					operations.map(entry => entry.signature),
					operations.map(() => []),
					operations.map(() => []),
				),
			).to.be.revertedWithCustomError(il, "TemplateNotActive")
			await executor.assertUnused(
				operations,
				new Map([
					[user.address, beforeNonce],
					[partyB, partyBNonce],
				]),
			)
			await runTx(il.setTemplateActive(templateId, true))
		}
		const quoteId = user.quoteIdFromLayerReceipt(await executor.execute(operations, { templateId }))
		expect(quoteId).to.equal(nextQuote)
		const opened = await manager.observeQuoteState(quoteId)
		expect(opened.quoteStatus).to.equal(BigInt(QuoteStatus.OPENED))
		expect(opened.partyA).to.equal(user.address)
		expect(opened.partyB).to.equal(partyB)
		expect(opened.quantity).to.equal(quantity)
		expect(opened.openedPrice).to.equal(price)
		const openFees = await getTradingFeeForQuoteWithFilledAmount(context, quoteId, quantity)
		const balance = await user.getBalanceInfo()
		expect(balance.totalPendingLockedPartyA).to.equal(0n)
		expect(balance.totalLockedPartyA).to.equal(opened.lockedValues.cva + opened.lockedValues.lf + opened.lockedValues.partyAmm)
		expect(balance.allocatedBalances).to.equal(margin - openFees)
		expect(await context.alViewFacet.getVirtualAccountQuoteIds(user.address, 0, 100)).to.deep.equal([quoteId])
		expect(await context.viewFacetSymbol.getConnectedPartyBs(user.address)).to.include(partyB)

		const partial = (quantity * randomBigNumber(61n, 25n)) / 100n
		let totalCloseFees = 0n
		for (const [index, amount] of [partial, quantity - partial].entries()) {
			const requestCd = context.partyAFacet.interface.encodeFunctionData("requestToClosePosition", [
				quoteId,
				price,
				amount,
				OrderType.LIMIT,
				await getBlockTimestamp(100_000n),
			])
			const fillCd = context.partyBPositionActionsFacet.interface.encodeFunctionData("fillCloseRequest", [
				quoteId,
				amount,
				price,
				await getDummyPairUpnlAndPriceSig(price, 0n, 0n),
			])
			await executor.execute([
				await executor.sign(owner, user.address, context.diamond, requestCd),
				await executor.sign(context.signers.hedger, partyB, context.diamond, fillCd, { isPartyB: true }),
			])
			totalCloseFees += calculateCloseFee(amount, price, opened.closeFee)
			await manager.observeQuoteState(quoteId)
			if (index === 0) {
				expect((await context.viewFacetQuote.getQuote(quoteId)).closedAmount).to.equal(partial)
				expect((await context.alViewFacet.getVirtualAccount(user.address)).isExists).to.equal(true)
			}
		}
		expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(BigInt(QuoteStatus.CLOSED))
		expect((await context.alViewFacet.getVirtualAccount(user.address)).isExists).to.equal(false)
		expect(await context.alViewFacet.getVirtualAccountsCountOfSubAccount(parent.address)).to.equal(0n)
		expect(await context.alViewFacet.getVirtualAccountQuoteIds(user.address, 0, 100)).to.deep.equal([])
		expect(await context.viewFacet.allocatedBalanceOfPartyA(user.address)).to.equal(0n)
		expect(await context.viewFacet.balanceOf(parent.address)).to.equal(decimal(10_000n) - openFees - totalCloseFees)
		expect(await context.viewFacetSymbol.getConnectedPartyBs(user.address)).not.to.include(partyB)
		await executor.assertContextCleared()
		return {
			quoteIds: [quoteId],
			detail: `${execution}; instantOpen=${instantOpen}; nativeContext=${nativeContext}; EIP-1271 PartyB send/lock/open, atomic rollback and partial/final close`,
		}
	} finally {
		await runTx(context.instantLayer.setTransientContextEnabled(previousContext))
	}
}
