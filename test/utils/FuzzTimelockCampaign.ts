import { expect } from "chai"
import { ethers } from "ethers"

import type { SignedTimelockApprovalStruct } from "../../src/types/accountLayer/facets/Timelock/TimelockFacet.js"
import { TIMELOCK_APPROVAL_TYPES } from "../helpers/accountLayerTimelock.js"
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
import { pick, randomBigNumber } from "./RandomUtils.js"
import { runTx } from "./TxUtils.js"

/** Exact-calldata schedules and approvals, inherited by VAs and routed directly or through InstantLayer. */
export async function executeFuzzTimelocks(options: FuzzAccountFeatureOptions & { contractUnlocker?: boolean }): Promise<FuzzLayerResult> {
	const { context, manager } = options
	const parent = await fundedFuzzParent(options)
	const user = await createFuzzCustomVA(options, parent)
	await parent.executeAccountLayerCall(context.alMarginFacet, "addMargin", [user.address, decimal(1_000n)])
	const quoteId = await user.sendQuote(
		limitQuoteRequestBuilder()
			.deadline(await getBlockTimestamp(100_000n))
			.build(),
	)
	await manager.observeQuoteState(quoteId)
	const allocatedBefore = await context.viewFacet.allocatedBalanceOfPartyA(user.address)
	const tl = context.alTimelockFacet
	const view = context.alViewFacet
	const contractUnlocker = options.contractUnlocker ?? pick([false, true])
	if (contractUnlocker) await runTx(context.symmioPartyB.setSigner(context.signers.hedger.address))
	const unlocker = contractUnlocker ? await context.symmioPartyB.getAddress() : context.signers.hedger.address
	const delay = randomBigNumber(601n, 300n)
	const addSelector = context.alMarginFacet.interface.getFunction("addMargin")!.selector
	const cancelSelector = context.partyAFacet.interface.getFunction("requestToCancelQuote")!.selector
	await parent.executeAccountLayerCall(tl, "setupTimelocks", [parent.address, unlocker, delay, [addSelector, cancelSelector]])
	const nonce = await view.timelockNonce(parent.address)
	expect(await view.allTimelockedBy(parent.address, unlocker, delay, [addSelector, cancelSelector])).to.equal(true)
	const amount = decimal(randomBigNumber(100n, 10n))
	const addArgs: [string, bigint] = [user.address, amount]
	const addCd = context.alMarginFacet.interface.encodeFunctionData("addMargin", addArgs)
	const addHash = ethers.keccak256(addCd)
	await expect(parent.executeAccountLayerCall(context.alMarginFacet, "addMargin", addArgs)).to.be.reverted
	expect(await context.viewFacet.allocatedBalanceOfPartyA(user.address)).to.equal(allocatedBefore)
	await parent.executeAccountLayerCall(tl, "scheduleTimelockOp", [user.address, addHash])
	expect((await view.getSchedule(parent.address, addHash)).scheduledAt).not.to.equal(0n)
	await expect(parent.executeAccountLayerCall(context.alMarginFacet, "addMargin", addArgs)).to.be.reverted
	await parent.executeAccountLayerCall(tl, "cancelTimelockOp", [user.address, addHash])
	expect((await view.getSchedule(user.address, addHash)).scheduledAt).to.equal(0n)
	await parent.executeAccountLayerCall(tl, "scheduleTimelockOp", [user.address, addHash])
	const scheduledAt = (await view.getSchedule(user.address, addHash)).scheduledAt
	await advanceFuzzTimeTo(scheduledAt + delay)
	await parent.executeAccountLayerCall(context.alMarginFacet, "addMargin", addArgs)
	expect((await view.getSchedule(user.address, addHash)).scheduledAt).to.equal(0n)
	expect(await context.viewFacet.allocatedBalanceOfPartyA(user.address)).to.equal(allocatedBefore + amount)
	await expect(parent.executeAccountLayerCall(context.alMarginFacet, "addMargin", addArgs)).to.be.reverted

	let approvalSequence = 0
	async function approvalFor(callData: string): Promise<SignedTimelockApprovalStruct> {
		const approval = {
			account: parent.address,
			unlocker,
			callDataHash: ethers.keccak256(callData),
			deadline: await getBlockTimestamp(100_000n),
			salt: ethers.id(`fuzz-timelock:${parent.address}:${++approvalSequence}:${callData}`),
		}
		const signature = await context.signers.hedger.signTypedData(
			{
				name: "SymmioAccountLayerTimelock",
				version: "1",
				chainId: (await context.instantLayer.runner!.provider!.getNetwork()).chainId,
				verifyingContract: context.accountLayerDiamond,
			},
			TIMELOCK_APPROVAL_TYPES,
			approval,
		)
		return { approval, signature }
	}
	const signed = await approvalFor(addCd)
	const digest = await view.hashTimelockApproval(signed.approval)
	const unguardedCd = view.interface.encodeFunctionData("ownerOf", [parent.address])
	await expect(parent.executeAccountLayerCall(tl, "executeTimelockOp", [[signed], unguardedCd])).to.be.reverted
	expect(await view.isApprovalUsed(digest)).to.equal(false)
	await parent.executeAccountLayerCall(tl, "executeTimelockOp", [[signed], addCd])
	expect(await view.isApprovalUsed(digest)).to.equal(true)
	expect(await context.viewFacet.allocatedBalanceOfPartyA(user.address)).to.equal(allocatedBefore + 2n * amount)
	await expect(parent.executeAccountLayerCall(tl, "executeTimelockOp", [[signed], addCd])).to.be.reverted
	expect(await context.viewFacet.allocatedBalanceOfPartyA(user.address)).to.equal(allocatedBefore + 2n * amount)

	// A VA inherits the root's inner-core selector lock. An entry approval cannot substitute for it.
	const cancelCd = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quoteId])
	const inner = context.alCoreFacet.interface.encodeFunctionData("_call", [user.address, [cancelCd]])
	const wrongApproval = await approvalFor(inner)
	await expect(parent.executeAccountLayerCall(tl, "executeTimelockOp", [[wrongApproval], inner])).to.be.reverted
	expect(await view.isApprovalUsed(await view.hashTimelockApproval(wrongApproval.approval))).to.equal(false)
	expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(BigInt(QuoteStatus.PENDING))
	const cancelApproval = await approvalFor(cancelCd)
	const nested = tl.interface.encodeFunctionData("executeTimelockOp", [[], inner])
	await parent.executeAccountLayerCall(tl, "executeTimelockOp", [[cancelApproval], nested])
	expect(await view.isApprovalUsed(await view.hashTimelockApproval(cancelApproval.approval))).to.equal(true)
	expect((await manager.observeQuoteState(quoteId)).quoteStatus).to.equal(BigInt(QuoteStatus.CANCELED))
	expect(await context.viewFacet.balanceOf(parent.address)).to.equal(decimal(10_000n))

	// Policy strengthening invalidates a scheduled clearing operation; weakening requires an approval.
	const clearCd = tl.interface.encodeFunctionData("clearTimelocks", [parent.address, [addSelector, cancelSelector]])
	const clearHash = ethers.keccak256(clearCd)
	await parent.executeAccountLayerCall(tl, "scheduleTimelockOp", [parent.address, clearHash])
	await parent.executeAccountLayerCall(tl, "setupTimelocks", [parent.address, unlocker, delay + 1n, [addSelector, cancelSelector]])
	expect(await view.timelockNonce(parent.address)).to.equal(nonce + 1n)
	expect((await view.getSchedule(parent.address, clearHash)).scheduledAt).to.equal(0n)
	await expect(parent.executeAccountLayerCall(tl, "clearTimelocks", [parent.address, [addSelector, cancelSelector]])).to.be.reverted
	const clearApproval = await approvalFor(clearCd)
	await parent.executeAccountLayerCall(tl, "executeTimelockOp", [[clearApproval], clearCd])
	expect((await view.getSelectorTimelock(parent.address, addSelector)).unlocker).to.equal(ethers.ZeroAddress)
	expect((await view.getSelectorTimelock(parent.address, cancelSelector)).unlocker).to.equal(ethers.ZeroAddress)
	expect(await view.timelockNonce(parent.address)).to.equal(nonce + 2n)
	await parent.assertExecutionContextCleared()
	return {
		quoteIds: [quoteId],
		detail: `${options.route}; ${contractUnlocker ? "EIP-1271" : "EOA"} unlocker; schedules, approval rollback/replay, VA inheritance, nested calls and policy changes`,
	}
}
