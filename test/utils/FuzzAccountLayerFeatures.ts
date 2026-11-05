import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { expect } from "chai"
import { ethers } from "ethers"

import { ethers as connectedEthers } from "../helpers/hardhat-connection.js"
import { time } from "../helpers/network-helpers.js"
import { PositionType, QuoteStatus } from "../models/Enums.js"
import { FuzzLayerUser, type FuzzLayerRoute } from "../models/FuzzLayerUser.js"
import type { RunContext } from "../models/RunContext.js"
import type { TestManager } from "../models/TestManager.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp } from "./Common.js"
import { pick, randomBigNumber } from "./RandomUtils.js"
import { getDummySingleUpnlWithPendingBalanceSig } from "./SignatureUtils.js"
import { runTx } from "./TxUtils.js"

export type FuzzAccountFeatureOptions = {
	context: RunContext
	manager: TestManager
	owner: HardhatEthersSigner
	route: FuzzLayerRoute
	isolationType?: number
}

export type FuzzLayerResult = { quoteIds: bigint[]; detail: string }

export async function advanceFuzzTimeTo(timestamp: bigint): Promise<void> {
	const now = BigInt(await time.latest())
	if (timestamp > now) await time.increase(timestamp - now)
}

export async function fundedFuzzParent(options: FuzzAccountFeatureOptions, isolationType = 3, amount = decimal(10_000n)) {
	const parent = new FuzzLayerUser(options.context, options.owner, options.route, undefined, isolationType)
	await parent.setup()
	await parent.setBalances(amount, amount)
	return parent
}

export async function createFuzzCustomVA(options: FuzzAccountFeatureOptions, parent: FuzzLayerUser, isolationType = 1, symbolId = 1) {
	const { context, owner, route } = options
	const address = await context.alCoreFacet.connect(owner).createCustomVirtualAccount.staticCall(parent.address, "0x", isolationType, symbolId)
	await parent.executeAccountLayerCall(context.alCoreFacet, "createCustomVirtualAccount", [parent.address, "0x", isolationType, symbolId])
	const user = new FuzzLayerUser(context, owner, route, address)
	await user.setup()
	return user
}

/** A single VA per isolation key, followed by switching back to independent VAs. */
export async function executeFuzzSingleVA(options: FuzzAccountFeatureOptions): Promise<FuzzLayerResult> {
	const { context, manager } = options
	if ((await context.viewFacetSymbol.getSymbol(2)).name === "") {
		await runTx(context.symbolControlFacet.addSymbol("FUZZ-SECOND-MARKET", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28_800, 900))
		await runTx(context.symbolControlFacet.setSymbolTypes([2], [1]))
	}
	const isolation = options.isolationType ?? pick([1, 2])
	const parent = await fundedFuzzParent(options, isolation)
	await parent.executeAccountLayerCall(context.alCoreFacet, "setSingleVAMode", [parent.address, true])
	expect((await context.alViewFacet.getSubAccount(parent.address)).singleVAMode).to.equal(true)
	const direction = pick([PositionType.LONG, PositionType.SHORT])
	const otherDirection = direction === PositionType.LONG ? PositionType.SHORT : PositionType.LONG
	const margin = decimal(randomBigNumber(800n, 400n))
	const quoteIds: bigint[] = []
	const accounts: string[] = []
	for (const [symbolId, positionType] of [
		[1, direction],
		[1, direction],
		[1, otherDirection],
		[2, direction],
	]) {
		const key = isolation === 1 ? 1 : positionType === PositionType.LONG ? 2 : 3
		const predicted = await context.alViewFacet.predictNextVirtualAccountAddress(parent.address, key, symbolId)
		const id = await parent.sendQuoteWithMargin(
			limitQuoteRequestBuilder()
				.symbolId(symbolId)
				.positionType(positionType)
				.deadline(await getBlockTimestamp(100_000n))
				.build(),
			key,
			margin,
		)
		const quote = await manager.observeQuoteState(id)
		expect(quote.partyA).to.equal(predicted)
		expect(await context.alViewFacet.getActiveVAByKey(parent.address, key, symbolId)).to.equal(predicted)
		quoteIds.push(id)
		accounts.push(predicted)
	}
	expect(accounts[0]).to.equal(accounts[1])
	if (isolation === 1) expect(accounts[0]).to.equal(accounts[2])
	else expect(accounts[0]).not.to.equal(accounts[2])
	expect(accounts[0]).not.to.equal(accounts[3])
	expect(await context.alViewFacet.getVirtualAccountsCountOfSubAccount(parent.address)).to.equal(isolation === 1 ? 2n : 3n)
	await expect(parent.executeAccountLayerCall(context.alCoreFacet, "setSingleVAMode", [parent.address, false])).to.be.reverted
	for (const [index, id] of quoteIds.entries()) {
		const user = new FuzzLayerUser(context, options.owner, options.route, accounts[index])
		await user.setup()
		await user.requestToCancelQuote(id)
		expect((await manager.observeQuoteState(id)).quoteStatus).to.equal(BigInt(QuoteStatus.CANCELED))
		const stillPending = quoteIds.some((_, other) => other > index && accounts[other] === accounts[index])
		expect((await context.alViewFacet.getVirtualAccount(user.address)).isExists).to.equal(stillPending)
	}
	expect(await context.viewFacet.balanceOf(parent.address)).to.equal(decimal(10_000n))
	for (const account of new Set(accounts)) {
		expect(await context.viewFacet.allocatedBalanceOfPartyA(account)).to.equal(0n)
		expect(await context.alViewFacet.getVirtualAccountQuoteIds(account, 0, 100)).to.deep.equal([])
	}
	await parent.executeAccountLayerCall(context.alCoreFacet, "setSingleVAMode", [parent.address, false])
	const independent: string[] = []
	for (let index = 0; index < 2; index++) {
		const key = isolation === 1 ? 1 : direction === PositionType.LONG ? 2 : 3
		const id = await parent.sendQuoteWithMargin(limitQuoteRequestBuilder().positionType(direction).build(), key, margin)
		independent.push((await manager.observeQuoteState(id)).partyA)
		quoteIds.push(id)
	}
	expect(independent[0]).not.to.equal(independent[1])
	for (let index = 0; index < 2; index++) {
		const user = new FuzzLayerUser(context, options.owner, options.route, independent[index])
		await user.setup()
		await user.requestToCancelQuote(quoteIds[4 + index])
		await manager.observeQuoteState(quoteIds[4 + index])
	}
	expect(await context.alViewFacet.getVirtualAccountsCountOfSubAccount(parent.address)).to.equal(0n)
	expect(await context.viewFacet.balanceOf(parent.address)).to.equal(decimal(10_000n))
	await parent.assertExecutionContextCleared()
	return { quoteIds, detail: `${options.route}; isolation=${isolation}; shared keys, separate markets/directions, mode guard, and independent VAs` }
}

/** Ownership changes while a child has a pending intent, then drains and deletes the family. */
export async function executeFuzzOwnership(options: FuzzAccountFeatureOptions): Promise<FuzzLayerResult> {
	const { context, manager, owner, route } = options
	const parent = await fundedFuzzParent(options)
	const user = await createFuzzCustomVA(options, parent)
	const margin = decimal(randomBigNumber(1_000n, 500n))
	await parent.executeAccountLayerCall(context.alMarginFacet, "addMargin", [user.address, margin])
	const quoteId = await user.sendQuote()
	await manager.observeQuoteState(quoteId)
	const newOwner = owner.address === context.signers.user2.address ? context.signers.user : context.signers.user2
	const oldCount = await context.alViewFacet.getSubAccountsCountOfUser(owner.address)
	const newCount = await context.alViewFacet.getSubAccountsCountOfUser(newOwner.address)
	await parent.executeAccountLayerCall(context.alCoreFacet, "editAccountName", [parent.address, "fuzz-transferred"])
	await parent.executeAccountLayerCall(context.alCoreFacet, "transferSubAccountOwnership", [parent.address, newOwner.address])
	expect(await context.alViewFacet.ownerOf(parent.address)).to.equal(newOwner.address)
	expect(await context.alViewFacet.ownerOf(user.address)).to.equal(newOwner.address)
	expect((await context.alViewFacet.getSubAccount(parent.address)).name).to.equal("fuzz-transferred")
	expect(await context.alViewFacet.getSubAccountsCountOfUser(owner.address)).to.equal(oldCount - 1n)
	expect(await context.alViewFacet.getSubAccountsCountOfUser(newOwner.address)).to.equal(newCount + 1n)
	await expect(user.requestToCancelQuote(quoteId)).to.be.reverted
	expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(BigInt(QuoteStatus.PENDING))
	const successor = new FuzzLayerUser(context, newOwner, route, user.address)
	await successor.setup()
	await successor.requestToCancelQuote(quoteId)
	await manager.observeQuoteState(quoteId)
	const successorParent = new FuzzLayerUser(context, newOwner, route, parent.address)
	await successorParent.setup()
	expect(await context.viewFacet.balanceOf(parent.address)).to.equal(decimal(10_000n))
	const ownerBalance = await context.collateral.balanceOf(newOwner.address)
	await advanceFuzzTimeTo(await context.viewFacet.getWithdrawableTime(parent.address))
	await successorParent.executeSymmioCall(context.accountFacet, "withdrawTo", [newOwner.address, decimal(10_000n)])
	await successorParent.executeAccountLayerCall(context.alCoreFacet, "deleteSubAccount", [parent.address])
	expect((await context.alViewFacet.getSubAccount(parent.address)).isExists).to.equal(false)
	expect(await context.alViewFacet.getSubAccountsCountOfUser(newOwner.address)).to.equal(newCount)
	expect(await context.collateral.balanceOf(newOwner.address)).to.equal(ownerBalance + decimal(10_000n))
	await successorParent.assertExecutionContextCleared()
	return { quoteIds: [quoteId], detail: `${route}; transferred live VA ownership, rejected former owner, swept collateral and deleted sub-account` }
}

/** Preserves funded legacy balances across import and exercises trading through the imported address. */
export async function executeFuzzLegacyImport(options: FuzzAccountFeatureOptions): Promise<FuzzLayerResult> {
	const { context, owner, manager } = options
	const anchor = await fundedFuzzParent(options)
	const [legacyAddress] = await context.alViewFacet.getLegacyMultiAccounts()
	const legacy = await connectedEthers.getContractAt("MockMultiAccount", legacyAddress)
	await runTx(legacy.createMockAccount(owner.address))
	const count = await legacy.getAccountsLength(owner.address)
	const [{ accountAddress }] = await legacy.getAccounts(owner.address, count - 1n, 1)
	const deposit = decimal(randomBigNumber(3_000n, 1_000n))
	await runTx(context.collateral.mint(owner.address, deposit))
	await runTx(context.collateral.connect(owner).approve(context.diamond, ethers.MaxUint256))
	await runTx(context.accountFacet.connect(owner).depositFor(accountAddress, deposit))
	const args: [string, string, string[], { account: string; name: string; coreIndex: number }[]] = [
		legacyAddress,
		await context.accountManager.getAddress(),
		[context.diamond],
		[{ account: accountAddress, name: "fuzz-imported", coreIndex: 0 }],
	]
	await expect(context.alCoreFacet.connect(context.signers.liquidator).importLegacyAccounts(...args)).to.be.revertedWithCustomError(
		context.alCoreFacet,
		"LegacyAccountNotOwned",
	)
	await anchor.executeAccountLayerCall(context.alCoreFacet, "importLegacyAccounts", args)
	expect(await context.viewFacet.balanceOf(accountAddress)).to.equal(deposit)
	const account = await context.alViewFacet.getSubAccount(accountAddress)
	expect(account.owner).to.equal(owner.address)
	expect(account.name).to.equal("fuzz-imported")
	expect(account.isolationType).to.equal(3n)
	await expect(anchor.executeAccountLayerCall(context.alCoreFacet, "importLegacyAccounts", args)).to.be.reverted
	const user = new FuzzLayerUser(context, owner, options.route, accountAddress)
	await user.setup()
	await user.executeSymmioCall(context.accountFacet, "allocate", [deposit])
	const quoteId = await user.sendQuote()
	await manager.observeQuoteState(quoteId)
	await user.requestToCancelQuote(quoteId)
	await manager.observeQuoteState(quoteId)
	expect(await context.viewFacet.allocatedBalanceOfPartyA(accountAddress)).to.equal(deposit)
	await expect(
		user.executeAccountLayerCall(context.alTimelockFacet, "setupTimelocks", [
			accountAddress,
			context.signers.hedger.address,
			300n,
			[context.accountFacet.interface.getFunction("allocate")!.selector],
		]),
	).to.be.reverted
	await user.assertExecutionContextCleared()
	return { quoteIds: [quoteId], detail: `${options.route}; funded legacy import, ownership/double-import guards, and imported account trading` }
}

/** Recovers both allocated and deposited orphan funds, and respects pending/funding retention on safe margin removal. */
export async function executeFuzzMarginRecovery(options: FuzzAccountFeatureOptions): Promise<FuzzLayerResult> {
	const { context, manager, owner } = options
	const parent = await fundedFuzzParent(options)
	const orphan = await context.alViewFacet.predictNextVirtualAccountAddress(parent.address, 0, 1)
	const allocated = decimal(randomBigNumber(600n, 200n))
	const deposited = decimal(randomBigNumber(300n, 100n))
	await parent.executeSymmioCall(context.accountFacet, "internalTransfer", [orphan, allocated])
	await runTx(context.collateral.mint(owner.address, deposited))
	await runTx(context.accountFacet.connect(owner).depositFor(orphan, deposited))
	expect((await context.alViewFacet.getVirtualAccount(orphan)).isExists).to.equal(false)
	await expect(context.alMarginFacet.connect(context.signers.liquidator).emergencyRecoverMargin(parent.address, 1)).to.be.revertedWithCustomError(
		context.alMarginFacet,
		"NotOwner",
	)
	await parent.executeAccountLayerCall(context.alMarginFacet, "emergencyRecoverMargin", [parent.address, 1])
	expect(await context.viewFacet.balanceOf(orphan)).to.equal(0n)
	expect(await context.viewFacet.allocatedBalanceOfPartyA(orphan)).to.equal(0n)
	expect(await context.viewFacet.balanceOf(parent.address)).to.equal(decimal(10_000n) + deposited)
	const user = await createFuzzCustomVA(options, parent)
	const margin = decimal(1_000n)
	await parent.executeAccountLayerCall(context.alMarginFacet, "addMargin", [user.address, margin])
	const quoteId = await user.sendQuote()
	await manager.observeQuoteState(quoteId)
	const pendingReserve = decimal(randomBigNumber(200n, 50n))
	const scaledLocked = decimal(200n)
	const fundingDebt = decimal(25n)
	const before = await user.getBalanceInfo()
	const beforeParent = await context.viewFacet.balanceOf(parent.address)
	const sig = await getDummySingleUpnlWithPendingBalanceSig(0n, pendingReserve, scaledLocked, fundingDebt)
	await advanceFuzzTimeTo((await context.viewFacet.withdrawCooldownOf(user.address)) + (await context.viewFacet.getDeallocateDebounceTime()))
	const blocked = [
		{
			signature: await getDummySingleUpnlWithPendingBalanceSig(0n, before.allocatedBalances),
			reason: "AccountFacet: Insufficient balance considering pending allocations",
		},
		{
			signature: await getDummySingleUpnlWithPendingBalanceSig(0n, 0n, before.allocatedBalances - decimal(100n), decimal(101n)),
			reason: "AccountFacet: Locked balance and funding debt must remain allocated",
		},
	]
	for (const { signature, reason } of blocked) {
		const attempt = parent.executeAccountLayerCall(context.alMarginFacet, "safeRemoveMargin", [user.address, decimal(1n), signature])
		if (options.route === "account-layer") await expect(attempt).to.be.revertedWith(reason)
		else
			await expect(attempt)
				.to.be.revertedWithCustomError(context.instantLayer, "OperationFailed")
				.withArgs(0n, ethers.concat(["0x08c379a0", ethers.AbiCoder.defaultAbiCoder().encode(["string"], [reason])]))
	}
	expect(await user.getBalanceInfo()).to.deep.equal(before)
	expect(await context.viewFacet.balanceOf(parent.address)).to.equal(beforeParent)
	const amount = decimal(randomBigNumber(100n, 10n))
	await parent.executeAccountLayerCall(context.alMarginFacet, "safeRemoveMargin", [user.address, amount, sig])
	expect((await user.getBalanceInfo()).allocatedBalances).to.equal(before.allocatedBalances - amount)
	expect(await context.viewFacet.balanceOf(parent.address)).to.equal(beforeParent + amount)
	await user.requestToCancelQuote(quoteId)
	await manager.observeQuoteState(quoteId)
	expect(await context.viewFacet.balanceOf(parent.address)).to.equal(decimal(10_000n) + deposited)
	expect(await context.viewFacet.allocatedBalanceOfPartyA(user.address)).to.equal(0n)
	await user.assertExecutionContextCleared()
	return {
		quoteIds: [quoteId],
		detail: `${options.route}; recovered orphan allocation/balance and enforced safe margin pending/funding reserves for ${owner.address}`,
	}
}
