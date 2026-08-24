import { expect } from "chai"
import fs from "fs"
import os from "os"
import path from "path"

import { deployFacets } from "../../tasks/deploy/diamondUpgrade.js"
import { ethers } from "../helpers/hardhat-connection.js"

type DeploymentOutput = {
	libraries: Record<string, string>
	facets: Record<string, { address: string; selectors: string[] }>
}

describe("upgrade facet deployment", function () {
	it("deploys and resumes the complete linked core and AccountLayer graphs", async function () {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-upgrade-facets-"))
		const coreFile = path.join(tempDir, "core.json")
		const accountLayerFile = path.join(tempDir, "account-layer.json")

		try {
			const firstCore = await deployFacets(coreFile, "core")
			const coreOutput = JSON.parse(fs.readFileSync(coreFile, "utf-8")) as DeploymentOutput
			for (const library of [
				"LibQuoteFunding",
				"LibQuoteClose",
				"LibForceActions",
				"LibPartyALiquidationProcess",
				"PartyBPositionActionsFacetImpl",
				"ClearingHouseFacetImpl",
			]) {
				expect(ethers.isAddress(coreOutput.libraries[library]), library).to.equal(true)
			}
			for (const facet of [
				"PartyAFacet",
				"PartyBPositionActionsFacet",
				"PartyBBatchActionsFacet",
				"PartyBEmergencyActionsFacet",
				"PartyBQuoteActionsFacet",
				"ForceActionsFacet",
				"ForceCloseStepsFacet",
				"PartyALiquidationFacet",
				"PartyALiquidationSnapshotFacet",
				"PartyBLiquidationFacet",
				"ClearingHouseFacet",
				"SymbolAdjustmentFacet",
				"ViewFacetSymbol",
			]) {
				expect(firstCore.facets[facet].selectors.length, facet).to.be.greaterThan(0)
			}

			const resumedCore = await deployFacets(coreFile, "core")
			expect(resumedCore.facets.PartyBPositionActionsFacet.address).to.equal(firstCore.facets.PartyBPositionActionsFacet.address)
			expect(resumedCore.facets.ClearingHouseFacet.address).to.equal(firstCore.facets.ClearingHouseFacet.address)

			const accountLayer = await deployFacets(accountLayerFile, "accountLayer")
			const accountLayerOutput = JSON.parse(fs.readFileSync(accountLayerFile, "utf-8")) as DeploymentOutput
			expect(ethers.isAddress(accountLayerOutput.libraries.LibQuoteParams)).to.equal(true)
			expect(accountLayer.facets.CoreFacet.selectors.length).to.be.greaterThan(0)
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})
})
