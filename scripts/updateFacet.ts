import { FacetCutAction, getSelectors } from "../tasks/utils/diamondCut.js"
import { ethers } from "../test/helpers/hardhat-connection.js"

/**
 * Replace a facet on the diamond.
 *
 * Run:
 *   DIAMOND_ADDRESS=0x... FACET_NAME=PartyAFacet npx hardhat run ./scripts/updateFacet.ts --network localhost
 *
 * Optional:
 *   FACET_ADDRESS=0x...   # if you already deployed the facet
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS
const FACET_NAME = process.env.FACET_NAME ?? "PartyAFacet"
const FACET_ADDRESS = process.env.FACET_ADDRESS

const FacetLibraryDependencies: Record<string, string[]> = {
	PartyAFacet: ["LibQuoteClose"],
	PartyBPositionActionsFacet: ["LibQuoteClose", "LibQuoteFunding"],
	PartyBBatchActionsFacet: ["LibQuoteClose", "LibQuoteFunding"],
	PartyBEmergencyActionsFacet: ["LibQuoteClose"],
	PartyBQuoteActionsFacet: ["LibQuoteClose"],
	ForceActionsFacet: ["LibQuoteClose", "LibSettlement"],
	ForceCloseStepsFacet: ["LibQuoteClose", "LibSettlement"],
	ViewFacetQuote: ["LibQuoteFunding"],
	FundingRateFacet: ["LibQuoteFunding"],
	PartyALiquidationFacet: ["LibQuoteFunding"],
	SettlementFacet: ["LibSettlement"],
}

function validateAddress(label: string, value: string | undefined): string {
	if (!value) throw new Error(`${label} is required`)
	if (!ethers.isAddress(value) || value === ethers.ZeroAddress) {
		throw new Error(`${label} is invalid: ${value}`)
	}
	return value
}

async function deployLibraries(): Promise<Record<string, string>> {
	const libraries: Record<string, string> = {}

	const LibQuoteFundingFactory = await ethers.getContractFactory("LibQuoteFunding")
	const libQuoteFunding = await LibQuoteFundingFactory.deploy()
	await libQuoteFunding.waitForDeployment()
	libraries.LibQuoteFunding = await libQuoteFunding.getAddress()

	const LibQuoteCloseFactory = await ethers.getContractFactory("LibQuoteClose", {
		libraries: {
			"project/contracts/core/libraries/LibQuoteFunding.sol:LibQuoteFunding": libraries.LibQuoteFunding,
		},
	})
	const libQuoteClose = await LibQuoteCloseFactory.deploy()
	await libQuoteClose.waitForDeployment()
	libraries.LibQuoteClose = await libQuoteClose.getAddress()

	const LibSettlementFactory = await ethers.getContractFactory("LibSettlement")
	const libSettlement = await LibSettlementFactory.deploy()
	await libSettlement.waitForDeployment()
	libraries.LibSettlement = await libSettlement.getAddress()

	return libraries
}

async function getFacetFactory(name: string): Promise<any> {
	const libs = FacetLibraryDependencies[name]
	if (!libs || libs.length === 0) {
		return ethers.getContractFactory(name)
	}

	const deployed = await deployLibraries()
	const linked: Record<string, string> = {}
	for (const lib of libs) {
		linked[`project/contracts/core/libraries/${lib}.sol:${lib}`] = deployed[lib]
	}
	return ethers.getContractFactory(name, { libraries: linked })
}

async function main() {
	const diamondAddress = validateAddress("DIAMOND_ADDRESS", DIAMOND_ADDRESS)
	if (FACET_ADDRESS && (!ethers.isAddress(FACET_ADDRESS) || FACET_ADDRESS === ethers.ZeroAddress)) {
		throw new Error(`FACET_ADDRESS is invalid: ${FACET_ADDRESS}`)
	}

	const diamondCutFacet = await ethers.getContractAt("DiamondCutFacet", diamondAddress)
	const FacetFactory = await getFacetFactory(FACET_NAME)
	const selectors = getSelectors(ethers, FacetFactory).selectors

	let facetAddress = FACET_ADDRESS
	if (!facetAddress) {
		const facet = await FacetFactory.deploy()
		await facet.waitForDeployment()
		facetAddress = await facet.getAddress()
		console.log(`${FACET_NAME} deployed: ${facetAddress}`)
	}

	const tx = await diamondCutFacet.diamondCut(
		[
			{
				facetAddress,
				action: FacetCutAction.Replace,
				functionSelectors: selectors,
			},
		],
		ethers.ZeroAddress,
		"0x",
	)
	await tx.wait()
	console.log("Facet updated successfully.")
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
