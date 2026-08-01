import { expect } from "chai"
import fs from "fs"
import os from "os"
import path from "path"

import { updateFacet } from "../../scripts/upgrade/utils/facetUpdater.js"
import { applyDiamondCut, buildDiamondCut, buildRollbackDiamondCut, deployFacets } from "../../scripts/upgrade/utils/upgradeHelpers.js"
import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture } from "../helpers/network-helpers.js"

describe("AccountLayer upgrade path", function () {
	it("supports linked CoreFacet deployment, pre-deployed addresses, and idempotent reruns", async function () {
		const context = await loadFixture(initializeFixture)
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-accountlayer-upgrade-"))
		const stateFile = path.join(tempDir, "state.json")
		const loupe = await ethers.getContractAt("DiamondLoupeFacet", context.accountLayerDiamond)
		const coreSelector = context.alCoreFacet.interface.getFunction("createSubAccounts")!.selector
		const originalCoreFacet = await loupe.facetAddress(coreSelector)

		try {
			const suppliedReport = await updateFacet({
				diamondAddress: context.accountLayerDiamond,
				scope: "accountLayer",
				facetName: "CoreFacet",
				facetAddress: originalCoreFacet,
				stateFile,
				reportFile: path.join(tempDir, "supplied-report.json"),
				signer: context.signers.admin,
			})
			expect(suppliedReport.selectorsToAdd).to.deep.equal([])
			expect(suppliedReport.selectorsToReplace).to.deep.equal([])
			expect(suppliedReport.transactionHash).to.equal(null)

			const deployedReport = await updateFacet({
				diamondAddress: context.accountLayerDiamond,
				scope: "accountLayer",
				facetName: "CoreFacet",
				stateFile,
				reportFile: path.join(tempDir, "deployed-report.json"),
				signer: context.signers.admin,
			})
			expect(ethers.isAddress(deployedReport.libraries.LibQuoteParams!)).to.equal(true)
			expect(deployedReport.selectorsToReplace.length).to.be.greaterThan(0)
			expect(deployedReport.transactionHash).not.to.equal(null)
			expect(await loupe.facetAddress(coreSelector)).to.equal(deployedReport.facetAddress)

			const rerunReport = await updateFacet({
				diamondAddress: context.accountLayerDiamond,
				scope: "accountLayer",
				facetName: "CoreFacet",
				facetAddress: deployedReport.facetAddress,
				stateFile,
				reportFile: path.join(tempDir, "rerun-report.json"),
				signer: context.signers.admin,
			})
			expect(rerunReport.selectorsToAdd).to.deep.equal([])
			expect(rerunReport.selectorsToReplace).to.deep.equal([])
			expect(rerunReport.transactionHash).to.equal(null)
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	it("builds, applies, verifies, and reverses a full AccountLayer live diff", async function () {
		const context = await loadFixture(initializeFixture)
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-accountlayer-live-diff-"))
		const facetsFile = path.join(tempDir, "facets.json")
		const loupe = await ethers.getContractAt("DiamondLoupeFacet", context.accountLayerDiamond)
		const coreSelector = context.alCoreFacet.interface.getFunction("createSubAccounts")!.selector
		const originalCoreFacet = await loupe.facetAddress(coreSelector)

		try {
			const deployed = await deployFacets(facetsFile, "accountLayer")
			const forward = await buildDiamondCut(context.accountLayerDiamond, deployed.facets, deployed.selectorSignatures)
			expect(forward.selectorChanges.some(change => change.action === "replace")).to.equal(true)
			const rollback = buildRollbackDiamondCut(forward.selectorChanges)

			await applyDiamondCut(context.accountLayerDiamond, forward.diamondCut, context.signers.admin)
			expect(await loupe.facetAddress(coreSelector)).to.equal(deployed.facets.CoreFacet.address)

			const idempotent = await buildDiamondCut(context.accountLayerDiamond, deployed.facets, deployed.selectorSignatures)
			expect(idempotent.diamondCut).to.deep.equal([])
			expect(idempotent.selectorChanges).to.deep.equal([])

			await applyDiamondCut(context.accountLayerDiamond, rollback, context.signers.admin)
			expect(await loupe.facetAddress(coreSelector)).to.equal(originalCoreFacet)
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})
})
