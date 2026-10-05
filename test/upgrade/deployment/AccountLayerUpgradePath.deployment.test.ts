import { expect } from "chai"
import fs from "fs"
import os from "os"
import path from "path"

import { updateFacet } from "../../../tasks/deploy/facetUpdater.js"
import { initializeFixture } from "../../Initialize.fixture.js"
import { ethers } from "../../helpers/hardhat-connection.js"
import { loadFixture } from "../../helpers/network-helpers.js"

describe("AccountLayer upgrade path (deployment)", function () {
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
})
