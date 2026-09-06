import { expect } from "chai"

import { createSafeBatch, validateSafeBatchTransport } from "../../cli/signer/safe-batch.js"
import {
	planRoundingUnpause,
	planRoundingPause,
	requireRoundingPaused,
	guardRoundingCut,
	executeRoundingOwnerAction,
} from "../../tasks/deploy/arbitrumRoundingUpgrade.js"
import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture } from "../helpers/network-helpers.js"

describe("Arbitrum rounding release Safe unpause", function () {
	it("requires Ledger-owner pause before a production cut and unpauses only after verification", async function () {
		const context = await loadFixture(initializeFixture)
		const admin = context.signers.admin
		await context.controlFacet.connect(admin).grantRole(admin.address, ethers.id("UNPAUSER_ROLE"))
		await context.pauseControlFacet.connect(admin).pauseAccounting()
		const input = {
			profile: "production",
			release: "version_0.8.6.2",
			target: { core: context.diamond, owner: admin.address, governanceMode: "ledger" },
		}
		const report: any = {}
		const nonce = await ethers.provider.getTransactionCount(admin.address)
		const pause = await planRoundingPause(ethers, input, report)
		expect(await ethers.provider.getTransactionCount(admin.address)).to.equal(nonce)
		expect((await context.viewFacet.pauseState())[0]).to.equal(false)
		await expectFailure(() => requireRoundingPaused(ethers, input, report), /must be globally paused/)
		await executeRoundingOwnerAction(ethers, input, report, "execute-pause", pause.actions)
		await requireRoundingPaused(ethers, input, report)
		expect((await planRoundingPause(ethers, input, report)).actions).to.deep.equal([])

		const replacement = await (await ethers.getContractFactory("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet")).deploy()
		await replacement.waitForDeployment()
		const cut = new ethers.Interface([
			"function diamondCut((address facetAddress,uint8 action,bytes4[] functionSelectors)[] cut,address init,bytes data)",
		])
		const cutData = cut.encodeFunctionData("diamondCut", [
			[{ facetAddress: await replacement.getAddress(), action: 1, functionSelectors: [ethers.id("getOwner()").slice(0, 10)] }],
			ethers.ZeroAddress,
			"0x",
		])
		report.actions = [{ to: context.diamond, value: "0", data: cutData, description: "Install test replacement facet" }]
		await context.pauseControlFacet.connect(admin).unpauseGlobal()
		await expectFailure(() => guardRoundingCut(ethers, input, report), /must be globally paused/)
		await context.pauseControlFacet.connect(admin).pauseGlobal()
		await guardRoundingCut(ethers, input, report)
		expect(report.actions).to.have.length(1)
		expect(report.actions[0].data).to.equal(cutData)
		await expectFailure(() => planRoundingUnpause(ethers, input, report), /Verify the installed Core cut/)
		// A change after planning is rechecked immediately before the owner signs the cut.
		await context.pauseControlFacet.connect(admin).unpauseGlobal()
		await expectFailure(() => executeRoundingOwnerAction(ethers, input, report, "execute-cut", report.actions), /must be globally paused/)
		await context.pauseControlFacet.connect(admin).pauseGlobal()
		const other = (await ethers.getSigners())[1]
		await expectFailure(
			() => executeRoundingOwnerAction({ ...ethers, getSigners: async () => [other] }, input, report, "execute-cut", report.actions),
			/signer does not match/,
		)
		await executeRoundingOwnerAction(ethers, input, report, "execute-cut", report.actions)
		expect((await context.viewFacet.pauseState())[0]).to.equal(true)
		const loupe = await ethers.getContractAt("DiamondLoupeFacet", context.diamond)
		expect(await loupe.facetAddress(ethers.id("getOwner()").slice(0, 10))).to.equal(await replacement.getAddress())
		report.actions = []
		report.verifiedBlock = await ethers.provider.getBlockNumber()
		const unpause = await planRoundingUnpause(ethers, input, report)
		await executeRoundingOwnerAction(ethers, input, report, "execute-unpause", unpause.actions)
		const after = await context.viewFacet.pauseState()
		expect(after[0]).to.equal(false)
		expect(after[2]).to.equal(true)
	})

	it("refuses production pause if either owner role is missing and refuses unpause without pause verification", async function () {
		const context = await loadFixture(initializeFixture)
		const admin = context.signers.admin
		const input = { profile: "production", target: { core: context.diamond, safe: admin.address } }
		await context.controlFacet.connect(admin).revokeRole(admin.address, ethers.id("UNPAUSER_ROLE"))
		await expectFailure(() => planRoundingPause(ethers, input, {}), /UNPAUSER_ROLE/)
		await context.controlFacet.connect(admin).grantRole(admin.address, ethers.id("UNPAUSER_ROLE"))
		await context.controlFacet.connect(admin).revokeRole(admin.address, ethers.id("PAUSER_ROLE"))
		await expectFailure(() => planRoundingPause(ethers, input, {}), /PAUSER_ROLE/)
		await expectFailure(() => planRoundingUnpause(ethers, input, { actions: [], verifiedBlock: 1 }), /pause verification is missing/)
	})

	it("exports one read-only planned unpause call whose execution clears only the global flag", async function () {
		const context = await loadFixture(initializeFixture)
		const admin = context.signers.admin
		await context.controlFacet.connect(admin).grantRole(admin.address, ethers.id("UNPAUSER_ROLE"))
		await context.pauseControlFacet.connect(admin).pauseGlobal()
		await context.pauseControlFacet.connect(admin).pauseAccounting()
		const input = { release: "version_0.8.6.2", target: { core: context.diamond, safe: admin.address } }
		const report = { actions: [], verifiedBlock: await ethers.provider.getBlockNumber() }
		const nonce = await ethers.provider.getTransactionCount(admin.address)
		const unpause = await planRoundingUnpause(ethers, input, report)
		expect(await ethers.provider.getTransactionCount(admin.address)).to.equal(nonce)
		expect((await context.viewFacet.pauseState())[0]).to.equal(true)
		expect(unpause.actions).to.have.length(1)
		const batch = createSafeBatch({ chainId: 42161, safeAddress: admin.address, name: "Core unpause", actions: unpause.actions })
		validateSafeBatchTransport(batch)
		const transaction = batch.transactionBuilder.transactions[0]
		expect(transaction.to).to.equal(ethers.getAddress(context.diamond))
		expect(transaction.value).to.equal("0")
		expect(transaction.data).to.equal(context.pauseControlFacet.interface.encodeFunctionData("unpauseGlobal"))
		await (await admin.sendTransaction({ to: transaction.to, value: transaction.value, data: transaction.data })).wait()
		const after = await context.viewFacet.pauseState()
		expect(after[0]).to.equal(false)
		expect(after[2]).to.equal(true)
		expect((await planRoundingUnpause(ethers, input, report)).actions).to.deep.equal([])
	})

	it("refuses an unverified cut or a multisig without the unpauser role", async function () {
		const context = await loadFixture(initializeFixture)
		await context.pauseControlFacet.connect(context.signers.admin).pauseGlobal()
		const other = (await ethers.getSigners())[1]
		const input = { release: "version_0.8.6.2", target: { core: context.diamond, safe: other.address } }
		const verifiedBlock = await ethers.provider.getBlockNumber()
		await expectFailure(() => planRoundingUnpause(ethers, input, { actions: [{}], verifiedBlock }), /Verify the installed Core cut/)
		await expectFailure(() => planRoundingUnpause(ethers, input, { actions: [] }), /Verify the installed Core cut/)
		await expectFailure(() => planRoundingUnpause(ethers, input, { actions: [], verifiedBlock }), /UNPAUSER_ROLE/)
		expect((await context.viewFacet.pauseState())[0]).to.equal(true)
	})
})

async function expectFailure(action: () => Promise<unknown>, pattern: RegExp) {
	let failure: unknown
	try {
		await action()
	} catch (error) {
		failure = error
	}
	expect(String(failure)).to.match(pattern)
}
