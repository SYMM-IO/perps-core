import { expect } from "chai"
import { ZeroAddress, keccak256, toUtf8Bytes } from "ethers"

import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture } from "../helpers/network-helpers.js"
import { PositionType, QuoteStatus } from "../models/Enums.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal } from "../utils/Common.js"

const role = (name: string) => keccak256(toUtf8Bytes(name))
const SEND_QUOTE_WITH_AFFILIATE_SIGNATURE =
	"sendQuoteWithAffiliate(address[],uint256,uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,(bytes,uint256,int256,uint256,bytes,(uint256,address,address)))"

describe("Hook execution-context isolation", function () {
	it("hides InstantLayer and instant-open privileges across the real LibHook boundary", async function () {
		const harness = await (await ethers.getContractFactory("HookExecutionContextHarness")).deploy()
		const hook = await (await ethers.getContractFactory("MaliciousExecutionContextHook")).deploy()
		await Promise.all([harness.waitForDeployment(), hook.waitForDeployment()])

		await harness.runProtectedHook(await hook.getAddress())

		expect(await hook.observedCallFromInstantLayer()).to.equal(false)
		expect(await hook.observedInstantOpenMode()).to.equal(false)
		expect(await hook.malformedWriteSucceeded()).to.equal(false)
		expect(await harness.malformedLegacyWrites()).to.equal(0n)
		expect(await harness.contextRestoredAfterHook()).to.equal(true)
		expect(await harness.isCallFromInstantLayer()).to.equal(false)
		expect(await harness.isInstantOpenMode()).to.equal(false)
	})

	it("also isolates hooks reached through the legacy persistent context fallback", async function () {
		const harness = await (await ethers.getContractFactory("HookExecutionContextHarness")).deploy()
		const hook = await (await ethers.getContractFactory("MaliciousExecutionContextHook")).deploy()
		await Promise.all([harness.waitForDeployment(), hook.waitForDeployment()])

		await harness.runProtectedPersistentHook(await hook.getAddress())

		expect(await hook.observedCallFromInstantLayer()).to.equal(false)
		expect(await hook.observedInstantOpenMode()).to.equal(false)
		expect(await hook.malformedWriteSucceeded()).to.equal(false)
		expect(await harness.contextRestoredAfterHook()).to.equal(true)
		expect(await harness.isCallFromInstantLayer()).to.equal(false)
		expect(await harness.isInstantOpenMode()).to.equal(false)
	})

	it("rolls back a reverting hook and leaves no transient privilege for the next transaction", async function () {
		const harness = await (await ethers.getContractFactory("HookExecutionContextHarness")).deploy()
		const revertingHook = await (await ethers.getContractFactory("RevertingExecutionContextHook")).deploy()
		const maliciousHook = await (await ethers.getContractFactory("MaliciousExecutionContextHook")).deploy()
		await Promise.all([harness.waitForDeployment(), revertingHook.waitForDeployment(), maliciousHook.waitForDeployment()])

		await expect(harness.runRevertingHook(await revertingHook.getAddress())).to.be.reverted
		expect(await harness.isCallFromInstantLayer()).to.equal(false)
		expect(await harness.isInstantOpenMode()).to.equal(false)

		await harness.runProtectedHook(await maliciousHook.getAddress())
		expect(await maliciousHook.observedCallFromInstantLayer()).to.equal(false)
		expect(await harness.contextRestoredAfterHook()).to.equal(true)
	})

	it("rejects teardown while a transient signer is suspended rather than fully cleared", async function () {
		const harness = await (await ethers.getContractFactory("HookExecutionContextHarness")).deploy()
		await harness.waitForDeployment()

		await expect(harness.endWithSuspendedTransientSigner()).to.be.revertedWithCustomError(harness, "TransientSignerNotCleared")
		expect(await harness.isCallFromInstantLayer()).to.equal(false)
	})

	it("restores the outer core signer after a trusted hook opens and clears a nested signer scope", async function () {
		const harness = await (await ethers.getContractFactory("HookExecutionContextHarness")).deploy()
		const hook = await (await ethers.getContractFactory("NestedSignerExecutionContextHook")).deploy()
		await Promise.all([harness.waitForDeployment(), hook.waitForDeployment()])

		const outerSigner = ethers.Wallet.createRandom().address
		await harness.runProtectedNestedSignerHook(await hook.getAddress(), outerSigner)

		expect(await harness.signerActiveAfterNestedHook()).to.equal(true)
		expect(await harness.signerRestoredAfterNestedHook()).to.equal(outerSigner)
	})

	it("restores both AccountLayer signer slots after a nested trusted scope clears them", async function () {
		const probe = await (await ethers.getContractFactory("AccountLayerSignerRestoreProbe")).deploy()
		await probe.waitForDeployment()

		const outerSigner = ethers.Wallet.createRandom().address
		const nestedSigner = ethers.Wallet.createRandom().address
		await probe.run(outerSigner, nestedSigner)

		expect(await probe.signerActiveAfterNestedCall()).to.equal(true)
		expect(await probe.signerRestoredAfterNestedCall()).to.equal(outerSigner)
	})

	it("fails closed when a nested core path leaves signer authority at the boundary", async function () {
		const harness = await (await ethers.getContractFactory("HookExecutionContextHarness")).deploy()
		await harness.waitForDeployment()

		const outerSigner = ethers.Wallet.createRandom().address
		const injectedSigner = ethers.Wallet.createRandom().address
		await expect(harness.rejectTransientSignerInjectedIntoPersistentBoundary(outerSigner, injectedSigner)).to.be.revertedWithCustomError(
			harness,
			"ExternalCallSignerWasModified",
		)
		await expect(harness.rejectPersistentSignerInjectedIntoTransientBoundary(outerSigner, injectedSigner)).to.be.revertedWithCustomError(
			harness,
			"ExternalCallSignerWasModified",
		)
		await expect(harness.rejectPersistentSignerLeftInPersistentBoundary(outerSigner, injectedSigner)).to.be.revertedWithCustomError(
			harness,
			"ExternalCallSignerWasModified",
		)
		await expect(harness.rejectTransientSignerLeftInTransientBoundary(outerSigner, injectedSigner)).to.be.revertedWithCustomError(
			harness,
			"ExternalCallSignerWasModified",
		)
	})

	it("fails closed when a nested AccountLayer path leaves signer authority at the boundary", async function () {
		const probe = await (await ethers.getContractFactory("AccountLayerSignerRestoreProbe")).deploy()
		await probe.waitForDeployment()

		const outerSigner = ethers.Wallet.createRandom().address
		const injectedSigner = ethers.Wallet.createRandom().address
		await expect(probe.rejectTransientSignerInjectedIntoPersistentBoundary(outerSigner, injectedSigner)).to.be.revertedWithCustomError(
			probe,
			"ExternalCallSignerWasModified",
		)
		await expect(probe.rejectPersistentSignerInjectedIntoTransientBoundary(outerSigner, injectedSigner)).to.be.revertedWithCustomError(
			probe,
			"ExternalCallSignerWasModified",
		)
		await expect(probe.rejectPersistentSignerLeftInPersistentBoundary(outerSigner, injectedSigner)).to.be.revertedWithCustomError(
			probe,
			"ExternalCallSignerWasModified",
		)
		await expect(probe.rejectTransientSignerLeftInTransientBoundary(outerSigner, injectedSigner)).to.be.revertedWithCustomError(
			probe,
			"ExternalCallSignerWasModified",
		)
	})

	it("allows a balanced nested persistent scope while restoring an outer transient signer", async function () {
		const harness = await (await ethers.getContractFactory("HookExecutionContextHarness")).deploy()
		const probe = await (await ethers.getContractFactory("AccountLayerSignerRestoreProbe")).deploy()
		await Promise.all([harness.waitForDeployment(), probe.waitForDeployment()])

		const outerSigner = ethers.Wallet.createRandom().address
		const nestedSigner = ethers.Wallet.createRandom().address
		await harness.restoreTransientSignerAfterClearedPersistentScope(outerSigner, nestedSigner)
		expect(await harness.signerActiveAfterNestedHook()).to.equal(true)
		expect(await harness.signerRestoredAfterNestedHook()).to.equal(outerSigner)

		await probe.restoreTransientSignerAfterClearedPersistentScope(outerSigner, nestedSigner)
		expect(await probe.signerActiveAfterNestedCall()).to.equal(true)
		expect(await probe.signerRestoredAfterNestedCall()).to.equal(outerSigner)
	})
})

async function setupAccountLayerHookContextFixture() {
	const context = await initializeFixture()
	const core = context.diamond
	const accountLayer = context.accountLayerDiamond
	const user = context.signers.user

	await context.accountManager.connect(user).addAccount("hook-context")
	const accounts = await context.accountManager.getAccounts(user.address, 0, 1)
	const account = accounts[0].accountAddress

	const probe = await (await ethers.getContractFactory("AccountLayerHookContextProbe")).deploy()
	const hook = await (await ethers.getContractFactory("MaliciousAccountLayerContextHook")).deploy(core)
	await Promise.all([probe.waitForDeployment(), hook.waitForDeployment()])

	await context.controlFacet.grantRole(await probe.getAddress(), role("INSTANT_LAYER_ROLE"))
	await context.alControlFacet.grantRole(await probe.getAddress(), role("SIGNER_SETTER_ROLE"))
	const onCallSelector = ethers.id("onCall(address,bytes[])").slice(0, 10)
	await context.alAffiliateFacet.setHook(await context.accountManager.getAddress(), onCallSelector, await hook.getAddress())

	return { context, core, accountLayer, user, account, probe, hook }
}

async function setupTransientPendingCancelCleanupFixture() {
	const context = await initializeFixture()
	const core = context.diamond
	const accountLayer = context.accountLayerDiamond
	const user = context.signers.user
	const affiliate = await context.accountManager.getAddress()

	await context.controlFacet.connect(context.signers.admin).registerHook(ZeroAddress, accountLayer)
	await context.alCoreFacet.connect(user).createSubAccounts(affiliate, [
		{
			name: "transient-cleanup",
			metadata: "0x",
			symmioCore: core,
			isolationType: 0, // POSITION
			singleVAMode: false,
		},
	])
	const subAccounts = await context.alViewFacet.getUserSubAccountsAddresses(user.address, 0, 10)
	const subAccount = subAccounts[subAccounts.length - 1]

	await context.collateral.connect(user).mint(user.address, decimal(3_000n))
	await context.collateral.connect(user).approve(await context.accountFacet.getAddress(), decimal(3_000n))
	await context.accountFacet.connect(user).depositFor(subAccount, decimal(3_000n))
	await context.alMarginFacet.connect(user).addMarginToNextVA(subAccount, 0, 1, decimal(500n))

	const request = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
	const sendQuoteCall = context.partyAFacet.interface.encodeFunctionData(SEND_QUOTE_WITH_AFFILIATE_SIGNATURE, [
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
	])
	await context.alCoreFacet.connect(user)._call(subAccount, [sendQuoteCall])

	const virtualAccounts = await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(subAccount, 0, 10)
	const virtualAccount = virtualAccounts[virtualAccounts.length - 1]
	const quoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccount, 0, 10)
	const quoteId = quoteIds[0]

	const probe = await (await ethers.getContractFactory("AccountLayerHookContextProbe")).deploy()
	await probe.waitForDeployment()
	await context.controlFacet.connect(context.signers.admin).grantRole(await probe.getAddress(), role("INSTANT_LAYER_ROLE"))
	await context.alControlFacet.connect(context.signers.admin).grantRole(await probe.getAddress(), role("SIGNER_SETTER_ROLE"))

	return { context, core, accountLayer, user, subAccount, virtualAccount, quoteId, probe }
}

describe("AccountLayer hook execution-context isolation", function () {
	it("suspends core privilege only for the affiliate hook and restores the surrounding operation", async function () {
		const { context, core, accountLayer, user, account, probe, hook } = await loadFixture(setupAccountLayerHookContextFixture)
		const callData = context.viewFacet.interface.encodeFunctionData("balanceOf", [account])

		await probe.run(core, accountLayer, user.address, account, callData)

		expect(await hook.calls()).to.equal(1n)
		expect(await hook.observedCallFromInstantLayer()).to.equal(false)
		expect(await probe.contextRestoredAfterHook()).to.equal(true)
		expect(await probe.signerRestoredAfterHook()).to.equal(user.address)
		expect(await context.viewFacet.isCallFromInstantLayer()).to.equal(false)
	})

	it("rolls back a reverting affiliate hook without leaking context into the next transaction", async function () {
		const { context, core, accountLayer, user, account, probe, hook } = await loadFixture(setupAccountLayerHookContextFixture)
		const callData = context.viewFacet.interface.encodeFunctionData("balanceOf", [account])

		await hook.setShouldRevert(true)
		await expect(probe.run(core, accountLayer, user.address, account, callData)).to.be.reverted
		expect(await context.viewFacet.isCallFromInstantLayer()).to.equal(false)

		await hook.setShouldRevert(false)
		await probe.run(core, accountLayer, user.address, account, callData)
		expect(await hook.observedCallFromInstantLayer()).to.equal(false)
		expect(await probe.contextRestoredAfterHook()).to.equal(true)
		expect(await probe.signerRestoredAfterHook()).to.equal(user.address)
		expect(await context.viewFacet.isCallFromInstantLayer()).to.equal(false)
	})

	it("restores transient signer state when cancelling the last quote deletes and sweeps a virtual account", async function () {
		const { context, core, accountLayer, user, subAccount, virtualAccount, quoteId, probe } = await loadFixture(
			setupTransientPendingCancelCleanupFixture,
		)
		const parentBalanceBefore = await context.viewFacet.balanceOf(subAccount)

		expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(BigInt(QuoteStatus.PENDING))
		expect(await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)).to.be.greaterThan(0n)

		const cancelCall = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quoteId])
		await expect(probe.run(core, accountLayer, user.address, virtualAccount, cancelCall)).not.to.be.reverted

		expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(BigInt(QuoteStatus.CANCELED))
		expect((await context.alViewFacet.getVirtualAccount(virtualAccount)).isExists).to.equal(false)
		expect(await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccount, 0, 10)).to.deep.equal([])
		expect(await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)).to.equal(0n)
		expect(await context.viewFacet.balanceOf(virtualAccount)).to.equal(0n)
		expect(await context.viewFacet.balanceOf(subAccount)).to.be.greaterThan(parentBalanceBefore)
		expect(await probe.contextRestoredAfterHook()).to.equal(true)
		expect(await probe.signerRestoredAfterHook()).to.equal(user.address)
		expect(await context.viewFacet.isCallFromInstantLayer()).to.equal(false)
	})
})
