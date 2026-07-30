import { expect } from "chai"
import { keccak256, toUtf8Bytes } from "ethers"

import type { InstantLayer } from "../../src/types/index.js"
import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { cloneTypes } from "../helpers/instantLayerEIP712Types.js"
import { loadFixture } from "../helpers/network-helpers.js"

const role = (name: string) => keccak256(toUtf8Bytes(name))

async function setupTransientContextFixture() {
	const context = await initializeFixture()
	const probe = await (await ethers.getContractFactory("TransientExecutionContextProbe")).deploy()
	await probe.waitForDeployment()
	const probeAddress = await probe.getAddress()

	await context.controlFacet.grantRole(probeAddress, role("INSTANT_LAYER_ROLE"))
	await context.controlFacet.grantRole(probeAddress, role("SIGNER_ADMIN_ROLE"))
	await context.alControlFacet.grantRole(probeAddress, role("SIGNER_SETTER_ROLE"))
	await context.alControlFacet.grantRole(context.signers.admin.address, role("SIGNER_SETTER_ROLE"))

	return { context, probe }
}

describe("Transient execution context", function () {
	it("leaves the legacy and native selector sequences observably identical, and bounds the context lifetime", async function () {
		const { context, probe } = await loadFixture(setupTransientContextFixture)
		const core = context.diamond
		const accountLayer = context.accountLayerDiamond
		const owner = context.signers.user.address
		const account = context.signers.user2.address

		// No per-caller configuration exists any more: the legacy selectors route into
		// EIP-1153 state on their own, so this is the deployed-InstantLayer path verbatim.
		await probe.runPersistentContext(core, accountLayer, owner, account, 2)
		expect(await context.viewFacet.isCallFromInstantLayer()).to.equal(false)
		expect(await context.viewFacet.getSigner()).to.equal(context.signers.admin.address)
		expect(await context.alViewFacet.getSigner()).to.equal(context.signers.admin.address)

		await probe.runTransientContext(core, accountLayer, owner, account, 2)
		expect(await context.viewFacet.isCallFromInstantLayer()).to.equal(false)
		expect(await context.viewFacet.getSigner()).to.equal(context.signers.admin.address)
		expect(await context.alViewFacet.getSigner()).to.equal(context.signers.admin.address)

		await probe.beginWithoutExplicitEnd(core)
		expect(await context.viewFacet.isCallFromInstantLayer()).to.equal(false)
	})

	it("rejects nested and unmatched native lifecycle boundaries", async function () {
		const { context, probe } = await loadFixture(setupTransientContextFixture)
		const core = context.diamond
		const executionContext = await ethers.getContractAt("ExecutionContextFacet", core)

		await expect(probe.beginTwice(core)).to.be.revertedWithCustomError(executionContext, "TransientContextAlreadyActive")
		await expect(probe.endWithoutBegin(core)).to.be.revertedWithCustomError(executionContext, "TransientContextNotActive")
		expect(await context.viewFacet.isCallFromInstantLayer()).to.equal(false)
	})

	it("applies the same checked lifecycle to the legacy selectors, with no configuration step", async function () {
		const { context, probe } = await loadFixture(setupTransientContextFixture)
		const core = context.diamond
		const executionContext = await ethers.getContractAt("ExecutionContextFacet", core)

		await expect(probe.legacyBeginTwice(core)).to.be.revertedWithCustomError(executionContext, "TransientContextAlreadyActive")
		await expect(probe.legacyEndWithoutBegin(core)).to.be.revertedWithCustomError(executionContext, "TransientContextNotActive")
		expect(await context.viewFacet.isCallFromInstantLayer()).to.equal(false)
	})

	it("refuses to begin or end through an installed signer authority", async function () {
		const { context, probe } = await loadFixture(setupTransientContextFixture)
		const core = context.diamond
		const admin = context.signers.admin

		await context.controlFacet.connect(admin).setSigner(context.signers.user.address)
		await expect(probe.beginWithoutExplicitEnd(core)).to.be.revertedWith("Accessibility: Cannot call via proxy")
		await context.controlFacet.connect(admin).setSigner(ethers.ZeroAddress)

		await expect(probe.beginSetSignerThenEnd(core, context.signers.user.address)).to.be.revertedWith("Accessibility: Cannot call via proxy")
		expect(await context.viewFacet.isCallFromInstantLayer()).to.equal(false)
	})

	// The old persistent-vs-transient gas comparison is gone: these selectors no longer have a
	// persistent path to measure against. What is still worth tracking is that the deployed
	// legacy sequence costs about the same as the native one, since both now avoid the SSTOREs.
	it("costs comparable gas through the legacy selectors and the native ones", async function () {
		const { context, probe } = await loadFixture(setupTransientContextFixture)
		const args = [context.diamond, context.accountLayerDiamond, context.signers.user.address, context.signers.user2.address, 2] as const

		const legacyReceipt = await (await probe.runPersistentContext(...args)).wait()
		const nativeReceipt = await (await probe.runTransientContext(...args)).wait()
		if (!legacyReceipt || !nativeReceipt) throw new Error("Missing context benchmark receipt")

		console.log(
			`TRANSIENT_CONTEXT_GAS ${JSON.stringify({ legacySelectors: legacyReceipt.gasUsed.toString(), nativeSelectors: nativeReceipt.gasUsed.toString() })}`,
		)

		// The legacy route makes more external calls (two setters per boundary instead of one),
		// so it is expected to be slightly dearer -- but only by call overhead, never by a
		// reintroduced cold SSTORE, which would put it tens of thousands of gas above native.
		expect(legacyReceipt.gasUsed).to.be.lessThan(nativeReceipt.gasUsed + 30_000n)
		expect(await context.viewFacet.isCallFromInstantLayer()).to.equal(false)
	})

	it("keeps existing InstantLayer EIP-712 signatures valid at the same verifying address", async function () {
		const { context } = await loadFixture(setupTransientContextFixture)
		const instantLayerAddress = await context.instantLayer.getAddress()
		const user = context.signers.user

		await context.controlFacet.grantRole(instantLayerAddress, role("INSTANT_LAYER_ROLE"))
		await context.instantLayer.setAccountLayer(context.accountLayerDiamond)
		await context.instantLayer.setTransientContextEnabled(false)

		await context.accountManager.connect(user).addAccount("legacy-il-signer")
		const accounts = await context.accountManager.getAccounts(user.address, 0, 10)
		const account = accounts[0].accountAddress
		const callData = context.alViewFacet.interface.encodeFunctionData("getSigner")
		const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp)
		const operation: InstantLayer.SignedOperationStruct = {
			signer: user.address,
			target: context.accountLayerDiamond,
			callData,
			signerAccount: { addr: account, isPartyB: false },
			flexFields: [],
			maxUses: 1,
			replayAttackHeader: { nonce: 1n, deadline: now + 300n, salt: ethers.hexlify(ethers.randomBytes(32)) },
		}
		const domain = {
			name: "SymmioInstantLayer",
			version: "1",
			chainId: (await ethers.provider.getNetwork()).chainId,
			verifyingContract: instantLayerAddress,
		}
		const signature = await user.signTypedData(domain, cloneTypes(), operation)

		const staticResults = await context.instantLayer.executeBatch.staticCall([operation], [signature], [[]], [[]])
		expect(context.alViewFacet.interface.decodeFunctionResult("getSigner", staticResults[0])[0]).to.equal(user.address)
		await expect(context.instantLayer.executeBatch([operation], [signature], [[]], [[]])).not.to.be.reverted
		expect(await context.viewFacet.isCallFromInstantLayer()).to.equal(false)
		expect(await context.alViewFacet.getSigner()).to.equal(context.signers.admin.address)
	})

	it("keeps persistent and transient signer scopes mutually exclusive", async function () {
		const { context, probe } = await loadFixture(setupTransientContextFixture)
		const admin = context.signers.admin

		// Core still has a persistent signer field and the two mechanisms stay exclusive there.
		await context.controlFacet.connect(admin).setSigner(context.signers.user.address)
		await expect(context.controlFacet.connect(admin).setTransientSigner(context.signers.user2.address)).to.be.reverted
		await context.controlFacet.connect(admin).setSigner(ethers.ZeroAddress)

		// AccountLayer's setSigner now installs a transient scope rather than a persistent signer,
		// so exclusivity there is enforced against a live scope instead -- see the probe below,
		// which performs both writes inside one transaction.
		await expect(
			probe.setCoreTransientThenPersistent(context.diamond, context.signers.user.address, context.signers.user2.address),
		).to.be.revertedWith("ControlFacet: Transient signer is set")
		await expect(
			probe.setAccountLayerTransientThenPersistent(context.accountLayerDiamond, context.signers.user.address, context.signers.user2.address),
		).to.be.revertedWith("ControlFacet: Transient signer is set")
	})

	it("provides an authorized rollback to the legacy InstantLayer route", async function () {
		const { context } = await loadFixture(setupTransientContextFixture)
		expect(await context.instantLayer.transientContextEnabled()).to.equal(true)
		await expect(context.instantLayer.connect(context.signers.user).setTransientContextEnabled(false)).to.be.reverted
		await context.instantLayer.connect(context.signers.admin).setTransientContextEnabled(false)
		expect(await context.instantLayer.transientContextEnabled()).to.equal(false)
		await context.instantLayer.connect(context.signers.admin).setTransientContextEnabled(true)
		expect(await context.instantLayer.transientContextEnabled()).to.equal(true)
	})
})
