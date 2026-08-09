import { expect } from "chai"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { deployAccountLayerDiamond } from "../../scripts/upgrade/utils/peripheralHelpers.js"
import { buildDiamondCut, type FacetInfo } from "../../scripts/upgrade/utils/upgradeHelpers.js"
import { ethers } from "../helpers/hardhat-connection.js"

describe("upgrade peripheral deployment resume", function () {
	this.timeout(120_000)

	let temporaryDirectory: string

	beforeEach(function () {
		temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-account-layer-resume-"))
	})

	afterEach(function () {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true })
	})

	it("installs and initializes AccountLayer, then reuses the verified on-chain state", async function () {
		const [protocolAdmin, feeReceiver] = await ethers.getSigners()
		const stateFile = path.join(temporaryDirectory, "peripherals.json")
		const first = await deployAccountLayerDiamond(await protocolAdmin.getAddress(), await feeReceiver.getAddress(), stateFile)
		const resumed = await deployAccountLayerDiamond(await protocolAdmin.getAddress(), await feeReceiver.getAddress(), stateFile)

		expect(resumed).to.deep.equal(first)
		const viewFacet = await ethers.getContractAt("contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet", first.diamondAddress)
		expect(await viewFacet.hasRole(await protocolAdmin.getAddress(), ethers.id("DEFAULT_ADMIN_ROLE"))).to.equal(true)
		expect(await viewFacet.symmioFeeReceiver()).to.equal(await feeReceiver.getAddress())
		expect(await viewFacet.accountManagerImplementation()).not.to.equal("0x")

		const loupe = await ethers.getContractAt("DiamondLoupeFacet", first.diamondAddress)
		const installedFacets: Record<string, FacetInfo> = {}
		for (const [name, address] of Object.entries(first.facetAddresses)) {
			installedFacets[name] = { address, selectors: [...(await loupe.facetFunctionSelectors(address))] }
		}
		const rerunCut = await buildDiamondCut(first.diamondAddress, installedFacets, {})
		expect(rerunCut.diamondCut).to.deep.equal([])
		expect(rerunCut.selectorChanges).to.deep.equal([])
	})
})
