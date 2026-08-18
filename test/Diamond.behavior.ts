import { assert, expect } from "chai"
import { readFileSync } from "fs"

import { FacetCutAction, getSelectors } from "../tasks/utils/diamondCut.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { RunContext } from "./models/RunContext.js"

function haveSameMembers(array1: any[], array2: any[]) {
	if (array1.length !== array2.length) {
		return false
	}

	const set1 = new Set(array1)
	const set2 = new Set(array2)

	if (set1.size !== set2.size) {
		return false
	}

	for (let item of set1) {
		if (!set2.has(item)) {
			return false
		}
	}

	return true
}

function deployedBytecodeSize(artifactPath: string) {
	const artifact = JSON.parse(readFileSync(artifactPath, "utf8"))
	return (artifact.deployedBytecode.length - 2) / 2
}

export function shouldBehaveLikeDiamond(): void {
	const addresses: string[] = []
	let selectors: string[] = []
	let result: string[] = []

	before(async function () {
		this.context = await loadFixture(initializeFixture)
	})

	it("should have 33 facets", async function () {
		const context: RunContext = this.context
		for (const address of await context.diamondLoupeFacet.facetAddresses()) {
			addresses.push(address)
		}
		assert.equal(addresses.length, 33)
	})

	it("keeps new AccountStorage snapshot fields after existing layout fields", async function () {
		const source = readFileSync("contracts/core/storages/AccountStorage.sol", "utf8")

		const lastExistingLayoutField = source.indexOf("partyBLiquidationSettlementReserve")
		const snapshotFlagField = source.indexOf("liquidationUsesPartyBSymbolSnapshots")
		const snapshotStateField = source.indexOf("liquidationPartyBSymbolSnapshots")

		expect(snapshotFlagField).to.be.greaterThan(lastExistingLayoutField)
		expect(snapshotStateField).to.be.greaterThan(lastExistingLayoutField)
	})

	it("keeps liquidation funding attribution event-only", async function () {
		const context: RunContext = this.context
		const source = readFileSync("contracts/core/storages/AccountStorage.sol", "utf8")
		const processorSelector = ethers.id("processPartyALiquidationFunding(address,address,bytes,uint256)").slice(0, 10)

		expect(source).not.to.include("LiquidationFundingBySymbol")
		expect(source).not.to.include("partyALiquidationSettlementFundingBySymbol")
		expect(await context.diamondLoupeFacet.facetAddress(processorSelector)).to.equal(ethers.ZeroAddress)
	})

	it("keeps PartyA liquidation facets comfortably below the bytecode limit", async function () {
		const partyALiquidationSize = deployedBytecodeSize(
			"artifacts/contracts/core/facets/PartyALiquidation/PartyALiquidationFacet.sol/PartyALiquidationFacet.json",
		)
		const snapshotLiquidationSize = deployedBytecodeSize(
			"artifacts/contracts/core/facets/PartyALiquidationSnapshot/PartyALiquidationSnapshotFacet.sol/PartyALiquidationSnapshotFacet.json",
		)

		expect(partyALiquidationSize).to.be.lessThan(20000)
		expect(snapshotLiquidationSize).to.be.lessThan(20000)
	})

	it("does not expose the legacy no-affiliate sendQuote selector", async function () {
		const context: RunContext = this.context
		const legacySendQuoteSelector = ethers
			.id(
				"sendQuote(address[],uint256,uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,(bytes,uint256,int256,uint256,bytes,(uint256,address,address)))",
			)
			.slice(0, 10)

		expect(await context.diamondLoupeFacet.facetAddress(legacySendQuoteSelector)).to.equal(ethers.ZeroAddress)
	})

	it("exposes only the count-free startRestatement selector", async function () {
		const context: RunContext = this.context
		const legacySelector = ethers.id("startRestatement(uint256,uint256,uint256)").slice(0, 10)
		const currentSelector = ethers.id("startRestatement(uint256)").slice(0, 10)

		expect(await context.diamondLoupeFacet.facetAddress(legacySelector)).to.equal(ethers.ZeroAddress)
		expect(await context.diamondLoupeFacet.facetAddress(currentSelector)).to.not.equal(ethers.ZeroAddress)
	})

	it("facets should have the right function selectors -- call to facetFunctionSelectors function", async function () {
		const context: RunContext = this.context
		// DiamondLoupeFacet
		selectors = getSelectors(ethers, context.diamondLoupeFacet as any).selectors
		const loupeAddress = await context.diamondLoupeFacet.facetAddress(selectors[0])
		result = await context.diamondLoupeFacet.facetFunctionSelectors(loupeAddress)
		expect(haveSameMembers(result, selectors)).to.be.true
	})

	it("should remove a function from ViewFacet -- getAccountBalance()", async function () {
		const context: RunContext = this.context
		const viewFacet = await ethers.getContractFactory("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet")
		const selectors = getSelectors(ethers, viewFacet as any).get(["balanceOf(address)"])
		const viewFacetAddress = await context.diamondLoupeFacet.facetAddress(selectors[0])

		const tx = await context.diamondCutFacet.diamondCut(
			[
				{
					facetAddress: ethers.ZeroAddress,
					action: FacetCutAction.Remove,
					functionSelectors: selectors,
				},
			],
			ethers.ZeroAddress,
			"0x",
			{ gasLimit: 800000 },
		)
		const receipt = await tx.wait()

		if (!receipt?.status) {
			throw new Error(`Diamond upgrade failed: ${tx.hash}`)
		}

		const result = await context.diamondLoupeFacet.facetFunctionSelectors(viewFacetAddress)
		expect(haveSameMembers(result, getSelectors(ethers, viewFacet as any).remove(["balanceOf(address)"]))).to.be.true
	})

	it("should add the getAccountBalance() function back", async function () {
		const context: RunContext = this.context
		const viewFacet = await ethers.getContractFactory("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet")
		const selectors = getSelectors(ethers, viewFacet as any).get(["balanceOf(address)"])
		const allSelectors = getSelectors(ethers, viewFacet as any).selectors
		const fallbackSelector = allSelectors.find(selector => selector !== selectors[0])
		const viewFacetAddress = await context.diamondLoupeFacet.facetAddress(fallbackSelector!)

		const tx = await context.diamondCutFacet.diamondCut(
			[
				{
					facetAddress: viewFacetAddress,
					action: FacetCutAction.Add,
					functionSelectors: getSelectors(ethers, viewFacet as any).get(["balanceOf(address)"]),
				},
			],
			ethers.ZeroAddress,
			"0x",
			{ gasLimit: 800000 },
		)
		const receipt = await tx.wait()

		if (!receipt?.status) {
			throw new Error(`Diamond upgrade failed: ${tx.hash}`)
		}

		const result = await context.diamondLoupeFacet.facetFunctionSelectors(viewFacetAddress)
		expect(haveSameMembers(result, getSelectors(ethers, viewFacet as any).selectors)).to.be.true
	})
}
