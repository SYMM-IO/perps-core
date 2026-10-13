import { expect } from "chai"
import { ethers } from "ethers"

import { DELEGATE_TYPES, FLEX_FILLER_AUTH_TYPES } from "../helpers/instantLayerEIP712Types.js"
import type { InstantLayer } from "../helpers/instantLayerTypes.js"
import { QuoteStatus } from "../models/Enums.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp } from "./Common.js"
import {
	advanceFuzzTimeTo,
	createFuzzCustomVA,
	fundedFuzzParent,
	type FuzzAccountFeatureOptions,
	type FuzzLayerResult,
} from "./FuzzAccountLayerFeatures.js"
import { FuzzInstantExecutor } from "./FuzzInstantExecutor.js"
import { randomBigNumber } from "./RandomUtils.js"
import { runTx } from "./TxUtils.js"

/** All three grant paths, canonical VA permissions, account confinement, cooldown revocation and expiry. */
export async function executeFuzzDelegation(options: FuzzAccountFeatureOptions): Promise<FuzzLayerResult> {
	const { context, manager, owner } = options
	const parent = await fundedFuzzParent(options)
	const user = await createFuzzCustomVA(options, parent)
	await parent.executeAccountLayerCall(context.alMarginFacet, "addMargin", [user.address, decimal(2_000n)])
	const sibling = await fundedFuzzParent(options)
	const siblingVA = await createFuzzCustomVA(options, sibling)
	const executor = new FuzzInstantExecutor(context, `delegation:${parent.address}`)
	const il = context.instantLayer
	const delegates = [context.signers.liquidator, context.signers.bridge, context.signers.bridge2]
	const sendSelector = context.partyAFacet.interface.getFunction("sendQuoteWithAffiliate")!.selector
	const cancelSelector = context.partyAFacet.interface.getFunction("requestToCancelQuote")!.selector
	const marginSelector = context.alMarginFacet.interface.getFunction("addMargin")!.selector
	const expiryTimestamp = await getBlockTimestamp(100_000n)
	const selectors = [sendSelector, cancelSelector, marginSelector]
	const info = (index: number): InstantLayer.DelegationInfoStruct => ({
		account: { addr: user.address, isPartyB: false },
		delegatedSigner: delegates[index].address,
		selectors,
		expiryTimestamp,
	})
	await runTx(il.connect(owner).grantDelegation(info(0)))
	expect(await il.isDelegationActive(parent.address, delegates[0].address, sendSelector)).to.equal(true)
	const delegationNonce = await il.delegationNonces(parent.address)
	const signedDelegation: InstantLayer.SignedDelegationStruct = {
		delegationInfo: info(1),
		replayAttackHeader: { nonce: delegationNonce + 1n, deadline: expiryTimestamp, salt: ethers.id(`fuzz-grant:${parent.address}`) },
	}
	const delegateTypes = Object.fromEntries(Object.entries(DELEGATE_TYPES).map(([name, fields]) => [name, [...fields]]))
	const delegationSignature = await owner.signTypedData(await executor.domain(), delegateTypes, signedDelegation)
	await runTx(il.grantBatchDelegationBySig(signedDelegation, delegationSignature))
	expect(await il.delegationNonces(parent.address)).to.equal(delegationNonce + 1n)
	expect(await il.usedDelegationHashes(await il.getDelegationHash(signedDelegation))).to.equal(true)
	await expect(il.grantBatchDelegationBySig(signedDelegation, delegationSignature)).to.be.reverted

	const quoteIds: bigint[] = []
	const quoteCd = await user.encodeSendQuote(limitQuoteRequestBuilder().deadline(expiryTimestamp).build())
	// A signed grant and the new delegate's trading intent execute atomically in one mixed-signer batch.
	const rootInfo = (index: number) => ({ ...info(index), account: { addr: parent.address, isPartyB: false } })
	const grant = await executor.sign(owner, parent.address, await il.getAddress(), il.interface.encodeFunctionData("grantDelegation", [rootInfo(2)]))
	const submit = await executor.sign(delegates[2], user.address, context.diamond, quoteCd)
	quoteIds.push(user.quoteIdFromLayerReceipt(await executor.execute([grant, submit])))
	await manager.observeQuoteState(quoteIds[0])
	// Exercise the signed multi-grant entry too; all grants remain scoped to the same canonical family.
	const multiGrant = await executor.sign(
		owner,
		parent.address,
		await il.getAddress(),
		il.interface.encodeFunctionData("grantDelegations", [delegates.map((_, index) => rootInfo(index))]),
	)
	await executor.execute([multiGrant])
	for (const delegate of delegates.slice(0, 2)) {
		const operation = await executor.sign(delegate, user.address, context.diamond, quoteCd)
		quoteIds.push(user.quoteIdFromLayerReceipt(await executor.execute([operation])))
		await manager.observeQuoteState(quoteIds.at(-1)!)
	}

	const beforeSibling = await context.viewFacet.allocatedBalanceOfPartyA(siblingVA.address)
	const beforeParent = await context.viewFacet.balanceOf(parent.address)
	const escape = await executor.sign(
		delegates[0],
		user.address,
		context.accountLayerDiamond,
		context.alMarginFacet.interface.encodeFunctionData("addMargin", [siblingVA.address, decimal(1n)]),
	)
	const beforeNonce = await il.nonces(user.address)
	await expect(il.executeBatch([escape.operation], [escape.signature], [[]], [[]])).to.be.revertedWithCustomError(il, "OperationFailed")
	await executor.assertUnused([escape], new Map([[user.address, beforeNonce]]))
	expect(await context.viewFacet.allocatedBalanceOfPartyA(siblingVA.address)).to.equal(beforeSibling)
	expect(await context.viewFacet.balanceOf(parent.address)).to.equal(beforeParent)
	const forbidden = await executor.sign(
		delegates[0],
		user.address,
		context.accountLayerDiamond,
		context.alCoreFacet.interface.encodeFunctionData("transferSubAccountOwnership", [parent.address, delegates[0].address]),
	)
	await expect(il.executeBatch([forbidden.operation], [forbidden.signature], [[]], [[]])).to.be.revertedWithCustomError(il, "InvalidDelegation")
	await executor.assertUnused([forbidden], new Map([[user.address, beforeNonce]]))
	expect(await context.alViewFacet.ownerOf(parent.address)).to.equal(owner.address)

	await runTx(il.connect(owner).initiateRevokeDelegation({ addr: user.address, isPartyB: false }, delegates[0].address, selectors))
	await expect(il.finalizeRevokeDelegation({ addr: parent.address, isPartyB: false }, delegates[0].address, selectors)).to.be.revertedWithCustomError(
		il,
		"RevocationCooldownNotOver",
	)
	expect(await il.isDelegationActive(parent.address, delegates[0].address, sendSelector)).to.equal(true)
	const eta = await il.pendingRevocationEta(parent.address, delegates[0].address, sendSelector)
	await advanceFuzzTimeTo(eta)
	await runTx(il.finalizeRevokeDelegation({ addr: user.address, isPartyB: false }, delegates[0].address, selectors))
	expect(await il.isDelegationActive(parent.address, delegates[0].address, sendSelector)).to.equal(false)
	const revoked = await executor.sign(delegates[0], user.address, context.diamond, quoteCd)
	await expect(il.executeBatch([revoked.operation], [revoked.signature], [[]], [[]])).to.be.revertedWithCustomError(il, "InvalidDelegation")
	await executor.assertUnused([revoked], new Map([[user.address, beforeNonce]]))
	// An otherwise valid operation cannot extend an expired selector grant.
	const expiry = await getBlockTimestamp(randomBigNumber(91n, 60n))
	await runTx(il.connect(owner).grantDelegations([{ ...info(1), expiryTimestamp: expiry }]))
	await advanceFuzzTimeTo(expiry)
	const expired = await executor.sign(delegates[1], user.address, context.diamond, quoteCd)
	await expect(il.executeBatch([expired.operation], [expired.signature], [[]], [[]])).to.be.revertedWithCustomError(il, "InvalidDelegation")
	await executor.assertUnused([expired], new Map([[user.address, beforeNonce]]))
	for (const quoteId of quoteIds) {
		await user.requestToCancelQuote(quoteId)
		expect((await manager.observeQuoteState(quoteId)).quoteStatus).to.equal(BigInt(QuoteStatus.CANCELED))
	}
	expect(await context.viewFacet.balanceOf(parent.address)).to.equal(decimal(10_000n))
	expect((await context.alViewFacet.getVirtualAccount(user.address)).isExists).to.equal(false)
	await executor.assertContextCleared()
	return { quoteIds, detail: "owner/direct, by-signature and atomic signed grants; VA normalization, selector/family guards, revocation and expiry" }
}

/** Executor-filled and separately signed fills, empty fills, malformed regions, replay and atomic rollback. */
export async function executeFuzzFlexFields(options: FuzzAccountFeatureOptions): Promise<FuzzLayerResult> {
	const { context, manager, owner } = options
	const parent = await fundedFuzzParent(options)
	const user = await createFuzzCustomVA(options, parent)
	await parent.executeAccountLayerCall(context.alMarginFacet, "addMargin", [user.address, decimal(1_000n)])
	const quoteId = await user.sendQuote()
	await manager.observeQuoteState(quoteId)
	const executor = new FuzzInstantExecutor(context, `flex:${parent.address}`)
	const il = context.instantLayer
	const callData = context.alMarginFacet.interface.encodeFunctionData("addMargin", [user.address, decimal(1n)])
	let totalMargin = decimal(1_000n)
	const reservedFee = totalMargin - (await context.viewFacet.allocatedBalanceOfPartyA(user.address))
	for (const filler of [context.signers.admin, context.signers.bridge]) {
		const amount = decimal(randomBigNumber(100n, 10n))
		const value = ethers.toBeHex(amount, 32)
		const entry = await executor.sign(owner, parent.address, context.accountLayerDiamond, callData, {
			flexFields: [{ offset: 32, length: 32, authorizedFlexFiller: filler.address }],
		})
		const nonce = await il.nonces(parent.address)
		const signature =
			filler.address === context.signers.admin.address
				? "0x"
				: await filler.signTypedData(await executor.domain(), FLEX_FILLER_AUTH_TYPES, {
						opHash: entry.hash,
						fieldIndex: 0,
						value,
					})
		if (signature !== "0x") {
			await expect(il.executeBatch([entry.operation], [entry.signature], [[value]], [["0x"]])).to.be.revertedWithCustomError(
				il,
				"InvalidFlexFillerSignature",
			)
			await executor.assertUnused([entry], new Map([[parent.address, nonce]]))
		}
		await expect(il.executeBatch([entry.operation], [entry.signature], [["0x01"]], [[signature]])).to.be.revertedWithCustomError(
			il,
			"InvalidFlexFillValueLength",
		)
		await executor.assertUnused([entry], new Map([[parent.address, nonce]]))
		await executor.execute([entry], { fills: [[value]], fillerSignatures: [[signature]] })
		totalMargin += amount
		expect(await context.viewFacet.allocatedBalanceOfPartyA(user.address)).to.equal(totalMargin - reservedFee)
		await expect(il.executeBatch([entry.operation], [entry.signature], [[value]], [[signature]])).to.be.revertedWithCustomError(il, "MaxUsesExceeded")
	}
	const emptyFill = await executor.sign(owner, parent.address, context.accountLayerDiamond, callData, {
		flexFields: [{ offset: 32, length: 32, authorizedFlexFiller: context.signers.bridge.address }],
	})
	await executor.execute([emptyFill], { fills: [["0x"]], fillerSignatures: [["0x"]] })
	totalMargin += decimal(1n)
	expect(await context.viewFacet.allocatedBalanceOfPartyA(user.address)).to.equal(totalMargin - reservedFee)

	// Delegation follows the final inner selector after a flex fill, including timelock wrappers.
	const delegate = context.signers.liquidator
	await runTx(
		il.connect(owner).grantDelegation({
			account: { addr: parent.address, isPartyB: false },
			delegatedSigner: delegate.address,
			selectors: [context.alMarginFacet.interface.getFunction("addMargin")!.selector],
			expiryTimestamp: await getBlockTimestamp(100_000n),
		}),
	)
	const wrapper = context.alTimelockFacet.interface.encodeFunctionData("executeTimelockOp", [[], callData])
	const innerOffset = Number(BigInt(ethers.dataSlice(wrapper, 36, 68))) + 32
	const selectorFill = await executor.sign(delegate, parent.address, context.accountLayerDiamond, wrapper, {
		flexFields: [{ offset: innerOffset, length: 4, authorizedFlexFiller: context.signers.admin.address }],
	})
	const delegateNonce = await il.nonces(parent.address)
	await expect(
		il.executeBatch(
			[selectorFill.operation],
			[selectorFill.signature],
			[[context.alCoreFacet.interface.getFunction("transferSubAccountOwnership")!.selector]],
			[["0x"]],
		),
	).to.be.revertedWithCustomError(il, "InvalidDelegation")
	await executor.assertUnused([selectorFill], new Map([[parent.address, delegateNonce]]))
	expect(await context.alViewFacet.ownerOf(parent.address)).to.equal(owner.address)
	expect(await context.viewFacet.allocatedBalanceOfPartyA(user.address)).to.equal(totalMargin - reservedFee)
	await executor.execute([selectorFill], { fills: [["0x"]], fillerSignatures: [["0x"]] })
	totalMargin += decimal(1n)
	const outOfBounds = await executor.sign(owner, parent.address, context.accountLayerDiamond, callData, {
		flexFields: [{ offset: 64, length: 32, authorizedFlexFiller: context.signers.admin.address }],
	})
	const nonce = await il.nonces(parent.address)
	await expect(il.executeBatch([outOfBounds.operation], [outOfBounds.signature], [["0x"]], [["0x"]])).to.be.revertedWithCustomError(
		il,
		"FlexFieldOutOfBounds",
	)
	await executor.assertUnused([outOfBounds], new Map([[parent.address, nonce]]))

	// A later failing op must roll back a filled margin move and both account nonces/usage marks.
	const valid = await executor.sign(owner, parent.address, context.accountLayerDiamond, callData)
	const invalid = await executor.sign(
		owner,
		user.address,
		context.diamond,
		context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [999_999n]),
	)
	const userNonce = await il.nonces(user.address)
	await expect(
		il.executeBatch([valid.operation, invalid.operation], [valid.signature, invalid.signature], [[], []], [[], []]),
	).to.be.revertedWithCustomError(il, "OperationFailed")
	await executor.assertUnused(
		[valid, invalid],
		new Map([
			[parent.address, nonce],
			[user.address, userNonce],
		]),
	)
	expect(await context.viewFacet.allocatedBalanceOfPartyA(user.address)).to.equal(totalMargin - reservedFee)
	expect(await context.viewFacet.balanceOf(parent.address)).to.equal(decimal(10_000n) - totalMargin)
	await user.requestToCancelQuote(quoteId)
	await manager.observeQuoteState(quoteId)
	expect(await context.viewFacet.balanceOf(parent.address)).to.equal(decimal(10_000n))
	await executor.assertContextCleared()
	return {
		quoteIds: [quoteId],
		detail: "executor/signed/empty flex fills; final inner selector delegation, malformed fill/bounds, replay and multi-account batch rollback",
	}
}
