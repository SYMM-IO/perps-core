import { expect } from "chai"

import { createSafeBatch, validateSafeBatchTransport } from "../../cli/signer/safe-batch.js"
import { planRoundingUnpause } from "../../tasks/deploy/arbitrumRoundingUpgrade.js"
import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture } from "../helpers/network-helpers.js"

describe("Arbitrum rounding release Safe unpause", function () {
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
