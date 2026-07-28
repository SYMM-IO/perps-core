import { expect } from "chai"

import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture } from "../helpers/network-helpers.js"

describe("ExecutionContextFacet deployment", function () {
	it("routes the focused execution ABI to one dedicated EIP-170-safe facet", async function () {
		const context = await loadFixture(initializeFixture)
		const core = context.diamond
		const executionContext = await ethers.getContractAt("IExecutionContextFacet", core)

		const legacySelector = context.controlFacet.interface.getFunction("setCallFromInstantLayer")!.selector
		const pauseSelector = context.pauseControlFacet.interface.getFunction("pauseGlobal")!.selector
		const nativeFunctions = [
			"setLegacyExecutionContextAdapter",
			"legacyExecutionContextAdapterEnabled",
			"beginInstantLayerExecution",
			"endInstantLayerExecution",
			"suspendExecutionContextForExternalCall",
			"restoreExecutionContextAfterExternalCall",
			"setTransientSigner",
		] as const
		const nativeSelectors = nativeFunctions.map(name => executionContext.interface.getFunction(name)!.selector)
		const legacyFacetAddress = await context.diamondLoupeFacet.facetAddress(legacySelector)
		const pauseFacetAddress = await context.diamondLoupeFacet.facetAddress(pauseSelector)
		const executionFacetAddress = await context.diamondLoupeFacet.facetAddress(nativeSelectors[0])

		expect(legacyFacetAddress).not.to.equal(ethers.ZeroAddress)
		expect(pauseFacetAddress).not.to.equal(ethers.ZeroAddress)
		expect(executionFacetAddress).not.to.equal(ethers.ZeroAddress)
		expect(executionFacetAddress).not.to.equal(legacyFacetAddress)
		expect(executionFacetAddress).not.to.equal(pauseFacetAddress)
		for (const selector of nativeSelectors) {
			expect(await context.diamondLoupeFacet.facetAddress(selector)).to.equal(executionFacetAddress)
		}

		const legacySize = (await ethers.provider.getCode(legacyFacetAddress)).length / 2 - 1
		const executionSize = (await ethers.provider.getCode(executionFacetAddress)).length / 2 - 1
		expect(legacySize).to.be.lessThanOrEqual(24_576)
		expect(executionSize).to.be.lessThanOrEqual(24_576)

		const focusedEvents = executionContext.interface.fragments.filter(fragment => fragment.type === "event").map(fragment => fragment.name)
		expect(focusedEvents).to.have.members(["LegacyExecutionContextAdapterUpdated", "SignerSet"])
		expect(focusedEvents).to.have.length(2)

		const caller = context.signers.others[0].address
		await expect(context.controlFacet.setLegacyExecutionContextAdapter(caller, true))
			.to.emit(executionContext, "LegacyExecutionContextAdapterUpdated")
			.withArgs(caller, true)
		expect(await context.controlFacet.legacyExecutionContextAdapterEnabled(caller)).to.equal(true)
		await context.controlFacet.setLegacyExecutionContextAdapter(caller, false)
		expect(await context.controlFacet.legacyExecutionContextAdapterEnabled(caller)).to.equal(false)
	})
})
