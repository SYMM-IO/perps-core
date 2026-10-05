import { expect } from "chai"
import fs from "fs"
import os from "os"
import path from "path"

import { applyDiamondCut, buildDiamondCut, buildRollbackDiamondCut, deployFacets } from "../../../tasks/deploy/diamondUpgrade.js"
import { initializeFixture } from "../../Initialize.fixture.js"
import { ethers } from "../../helpers/hardhat-connection.js"
import { loadFixture } from "../../helpers/network-helpers.js"

describe("AccountLayer upgrade path (governance)", function () {
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
