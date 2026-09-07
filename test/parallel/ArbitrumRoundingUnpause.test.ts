import { expect } from "chai"

import { createSafeBatch, validateSafeBatchTransport } from "../../cli/signer/safe-batch.js"
import { selectorMap, selectorDigest, GETTER } from "../../deployment-tooling/arbitrum-rounding-upgrade.js"
import {
	planRoundingUnpause,
	planRoundingPause,
	requireRoundingPaused,
	guardRoundingCut,
	executeRoundingOwnerAction,
	planStageFundingRoles,
	verifyStageFundingRoles,
	inspectRoundingUpgrade,
} from "../../tasks/deploy/arbitrumRoundingUpgrade.js"
import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture } from "../helpers/network-helpers.js"

describe("Arbitrum rounding release Safe unpause", function () {
	it("stage Safe grants only missing roles before separate pause, cut and unpause files", async function () {
		const context = await loadFixture(initializeFixture)
		const admin = context.signers.admin
		const input = {
			profile: "stage-funding",
			release: "version_0.8.6.2-funding",
			target: { core: context.diamond, safe: admin.address, governanceMode: "safe-file" },
		}
		for (const role of ["PAUSER_ROLE", "UNPAUSER_ROLE"]) await context.controlFacet.connect(admin).revokeRole(admin.address, ethers.id(role))
		const report: any = { deployments: { Create2Factory: { published: true }, FundingRateFacet: { published: false } } }
		await expectFailure(() => planStageFundingRoles(ethers, input, report), /publication.*FundingRateFacet/)
		report.deployments.FundingRateFacet.published = true
		const nonce = await ethers.provider.getTransactionCount(admin.address)
		const roles = await planStageFundingRoles(ethers, input, report)
		expect(await ethers.provider.getTransactionCount(admin.address)).to.equal(nonce)
		const batch = createSafeBatch({ chainId: 42161, safeAddress: admin.address, name: "Stage funding roles", actions: roles.actions })
		validateSafeBatchTransport(batch)
		expect(batch.transactionBuilder.transactions).to.have.length(2)
		await expectFailure(() => verifyStageFundingRoles(ethers, input, report), /PAUSER_ROLE/)
		await expectFailure(() => planRoundingPause(ethers, input, report), /PAUSER_ROLE/)
		for (const [index, tx] of batch.transactionBuilder.transactions.entries()) {
			const decoded = context.controlFacet.interface.decodeFunctionData("grantRole", tx.data)
			expect(decoded.user).to.equal(admin.address)
			expect(decoded.role).to.equal(ethers.id(index === 0 ? "PAUSER_ROLE" : "UNPAUSER_ROLE"))
			expect(tx.value).to.equal("0")
			await (await admin.sendTransaction({ to: tx.to, data: tx.data, value: tx.value })).wait()
		}
		await verifyStageFundingRoles(ethers, input, report)
		expect(report.roles.verifiedBlock).to.be.greaterThan(0)
		expect((await planStageFundingRoles(ethers, input, report)).actions).to.deep.equal([])
		await context.pauseControlFacet.connect(admin).pauseAccounting()
		const pause = await planRoundingPause(ethers, input, report)
		const cut = new ethers.Interface(["function diamondCut((address,uint8,bytes4[])[],address,bytes)"])
		report.actions = [{ to: context.diamond, value: "0", data: cut.encodeFunctionData("diamondCut", [[], ethers.ZeroAddress, "0x"]) }]
		await expectFailure(() => guardRoundingCut(ethers, input, report), /must be globally paused/)
		await (await admin.sendTransaction(pause.actions[0])).wait()
		await requireRoundingPaused(ethers, input, report)
		await guardRoundingCut(ethers, input, report)
		await expectFailure(() => planRoundingUnpause(ethers, input, report), /Verify the installed Core cut/)
		await (await admin.sendTransaction(report.actions[0])).wait()
		report.actions = []
		report.verifiedBlock = await ethers.provider.getBlockNumber()
		const unpause = await planRoundingUnpause(ethers, input, report)
		await (await admin.sendTransaction(unpause.actions[0])).wait()
		const after = await context.viewFacet.pauseState()
		expect(after[0]).to.equal(false)
		expect(after[2]).to.equal(true)
	})

	it("stage inspection accepts installed rounding without pause roles and rejects selector or runtime drift", async function () {
		const context = await loadFixture(initializeFixture)
		const admin = context.signers.admin
		await context.pauseControlFacet.connect(admin).activateAccumulatedFunding()
		for (const role of ["PAUSER_ROLE", "UNPAUSER_ROLE"]) await context.controlFacet.connect(admin).revokeRole(admin.address, ethers.id(role))
		const loupe = await ethers.getContractAt("DiamondLoupeFacet", context.diamond)
		const selectors = selectorMap(await loupe.facets())
		const fundingAddress = selectors["0xfe9e82df"]
		const input: any = {
			profile: "stage-funding",
			create2: { factory: { mode: "deploy" } },
			target: {
				core: context.diamond,
				safe: admin.address,
				governanceMode: "safe-file",
				baselineSelectorDigest: selectorDigest(selectors),
				facets: { FundingRateFacet: { address: fundingAddress, codeHash: ethers.keccak256(await ethers.provider.getCode(fundingAddress)) } },
				preserveFacets: { ViewFacet: { address: selectors[GETTER], codeHash: ethers.keccak256(await ethers.provider.getCode(selectors[GETTER])) } },
				reuseLibraries: {},
			},
		}
		const report: any = {}
		await inspectRoundingUpgrade(ethers, input, report)
		expect(report.baseline).to.deep.equal(selectors)
		await expectFailure(
			() => inspectRoundingUpgrade(ethers, input, { baseline: { ...selectors, "0x12345678": admin.address } }),
			/Saved stage selector baseline/,
		)
		await expectFailure(
			() => inspectRoundingUpgrade(ethers, { ...input, target: { ...input.target, baselineSelectorDigest: "bad" } }, {}),
			/reviewed installed rounding baseline/,
		)
		input.target.preserveFacets.ViewFacet.codeHash = ethers.ZeroHash
		await expectFailure(() => inspectRoundingUpgrade(ethers, input, report), /Preserved rounding facet changed/)
	})
	it("production executes only a Ledger-owner cut without pause roles and preserves all pause flags", async function () {
		const context = await loadFixture(initializeFixture)
		const admin = context.signers.admin
		await context.controlFacet.connect(admin).grantRole(admin.address, ethers.id("UNPAUSER_ROLE"))
		await context.pauseControlFacet.connect(admin).pauseAccounting()
		for (const role of ["PAUSER_ROLE", "UNPAUSER_ROLE"]) await context.controlFacet.connect(admin).revokeRole(admin.address, ethers.id(role))
		const input = {
			profile: "production",
			release: "version_0.8.6.2",
			target: { core: context.diamond, owner: admin.address, governanceMode: "ledger" },
		}
		const report: any = {}
		await expectFailure(() => planRoundingPause(ethers, input, report), /requires a profile/)
		await expectFailure(() => executeRoundingOwnerAction(ethers, input, report, "execute-pause", []), /pause and unpause are disabled/)
		const before = Array.from(await context.viewFacet.pauseState())
		expect(before[0]).to.equal(false)

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
		await guardRoundingCut(ethers, input, report)
		expect(report.actions).to.have.length(1)
		expect(report.actions[0].data).to.equal(cutData)
		await expectFailure(() => planRoundingUnpause(ethers, input, report), /unpause is disabled/)
		const other = (await ethers.getSigners())[1]
		await expectFailure(
			() => executeRoundingOwnerAction({ ...ethers, getSigners: async () => [other] }, input, report, "execute-cut", report.actions),
			/signer does not match/,
		)
		const nonce = await ethers.provider.getTransactionCount(admin.address)
		await executeRoundingOwnerAction(ethers, input, report, "execute-cut", report.actions)
		expect(await ethers.provider.getTransactionCount(admin.address)).to.equal(nonce + 1)
		expect(Array.from(await context.viewFacet.pauseState())).to.deep.equal(before)
		const loupe = await ethers.getContractAt("DiamondLoupeFacet", context.diamond)
		expect(await loupe.facetAddress(ethers.id("getOwner()").slice(0, 10))).to.equal(await replacement.getAddress())
		report.actions = []
		report.verifiedBlock = await ethers.provider.getBlockNumber()
		await expectFailure(() => planRoundingUnpause(ethers, input, report), /unpause is disabled/)
		await expectFailure(() => executeRoundingOwnerAction(ethers, input, report, "execute-unpause", []), /pause and unpause are disabled/)
		const after = await context.viewFacet.pauseState()
		expect(after[0]).to.equal(false)
		expect(after[2]).to.equal(true)
	})

	it("stage still requires both pause roles and a verified pause before unpause", async function () {
		const context = await loadFixture(initializeFixture)
		const admin = context.signers.admin
		const input = { profile: "stage-funding", target: { core: context.diamond, safe: admin.address } }
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
