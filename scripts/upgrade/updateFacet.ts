import { FacetCutAction, getSelectors } from "../../tasks/utils/diamondCut.js"
import { ethers } from "../../test/helpers/hardhat-connection.js"
import { verifyRpc } from "./utils/rpcCheck.js"

/**
 * Replace a facet on the diamond.
 *
 * Run:
 *   DIAMOND_ADDRESS=0x... FACET_NAME=PartyAFacet npx hardhat run ./scripts/upgrade/updateFacet.ts --network localhost
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
	ForceActionsFacet: ["LibForceActions", "LibSettlement"],
	ForceCloseStepsFacet: ["LibForceActions", "LibSettlement"],
	ViewFacetQuote: ["LibQuoteFunding"],
	FundingRateFacet: ["LibQuoteFunding"],
	PartyALiquidationFacet: ["LibPartyALiquidationLegacySetup", "LibPartyALiquidationProcess"],
	PartyALiquidationSnapshotFacet: ["LibPartyALiquidationSnapshotSetup", "LibPartyALiquidationProcess"],
	ClearingHouseFacet: ["LibQuoteClose", "LibQuoteFunding"],
	SettlementFacet: ["LibSettlement"],
}

const LibraryLinkReferences: Record<string, string> = {
	LibQuoteFunding: "project/contracts/core/libraries/LibQuoteFunding.sol:LibQuoteFunding",
	LibQuoteClose: "project/contracts/core/libraries/LibQuoteClose.sol:LibQuoteClose",
	LibForceActions: "project/contracts/core/libraries/LibForceActions.sol:LibForceActions",
	LibSettlement: "project/contracts/core/libraries/LibSettlement.sol:LibSettlement",
	LibPartyALiquidationProcess: "project/contracts/core/libraries/liquidation/LibPartyALiquidationProcess.sol:LibPartyALiquidationProcess",
	LibPartyALiquidationSnapshotSetup:
		"project/contracts/core/libraries/liquidation/LibPartyALiquidationSnapshotSetup.sol:LibPartyALiquidationSnapshotSetup",
	LibPartyALiquidationLegacySetup: "project/contracts/core/libraries/liquidation/LibPartyALiquidationLegacySetup.sol:LibPartyALiquidationLegacySetup",
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
			[LibraryLinkReferences.LibQuoteFunding]: libraries.LibQuoteFunding,
		},
	})
	const libQuoteClose = await LibQuoteCloseFactory.deploy()
	await libQuoteClose.waitForDeployment()
	libraries.LibQuoteClose = await libQuoteClose.getAddress()

	const LibForceActionsFactory = await ethers.getContractFactory("LibForceActions", {
		libraries: {
			[LibraryLinkReferences.LibQuoteClose]: libraries.LibQuoteClose,
		},
	})
	const libForceActions = await LibForceActionsFactory.deploy()
	await libForceActions.waitForDeployment()
	libraries.LibForceActions = await libForceActions.getAddress()

	const LibSettlementFactory = await ethers.getContractFactory("LibSettlement")
	const libSettlement = await LibSettlementFactory.deploy()
	await libSettlement.waitForDeployment()
	libraries.LibSettlement = await libSettlement.getAddress()

	const LibPartyALiquidationProcessFactory = await ethers.getContractFactory("LibPartyALiquidationProcess", {
		libraries: {
			[LibraryLinkReferences.LibQuoteFunding]: libraries.LibQuoteFunding,
		},
	})
	const libPartyALiquidationProcess = await LibPartyALiquidationProcessFactory.deploy()
	await libPartyALiquidationProcess.waitForDeployment()
	libraries.LibPartyALiquidationProcess = await libPartyALiquidationProcess.getAddress()

	const LibPartyALiquidationSnapshotSetupFactory = await ethers.getContractFactory("LibPartyALiquidationSnapshotSetup")
	const libPartyALiquidationSnapshotSetup = await LibPartyALiquidationSnapshotSetupFactory.deploy()
	await libPartyALiquidationSnapshotSetup.waitForDeployment()
	libraries.LibPartyALiquidationSnapshotSetup = await libPartyALiquidationSnapshotSetup.getAddress()

	const LibPartyALiquidationLegacySetupFactory = await ethers.getContractFactory("LibPartyALiquidationLegacySetup")
	const libPartyALiquidationLegacySetup = await LibPartyALiquidationLegacySetupFactory.deploy()
	await libPartyALiquidationLegacySetup.waitForDeployment()
	libraries.LibPartyALiquidationLegacySetup = await libPartyALiquidationLegacySetup.getAddress()

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
		linked[LibraryLinkReferences[lib]] = deployed[lib]
	}
	return ethers.getContractFactory(name, { libraries: linked })
}

async function main() {
	await verifyRpc()
	const diamondAddress = validateAddress("DIAMOND_ADDRESS", DIAMOND_ADDRESS)
	if (FACET_ADDRESS && (!ethers.isAddress(FACET_ADDRESS) || FACET_ADDRESS === ethers.ZeroAddress)) {
		throw new Error(`FACET_ADDRESS is invalid: ${FACET_ADDRESS}`)
	}

	const diamondCutFacet = await ethers.getContractAt("DiamondCutFacet", diamondAddress)
	const diamondLoupeFacet = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress)
	const FacetFactory = await getFacetFactory(FACET_NAME)
	const selectors = getSelectors(ethers, FacetFactory).selectors

	let facetAddress = FACET_ADDRESS
	if (!facetAddress) {
		const facet = await FacetFactory.deploy()
		await facet.waitForDeployment()
		facetAddress = await facet.getAddress()
		console.log(`${FACET_NAME} deployed: ${facetAddress}`)
	}
	const deployedFacetAddress = validateAddress("facetAddress", facetAddress)

	const selectorsToAdd: string[] = []
	const selectorsToReplace: string[] = []
	for (const selector of selectors) {
		const currentFacetAddress = await diamondLoupeFacet.facetAddress(selector)
		if (currentFacetAddress === ethers.ZeroAddress) {
			selectorsToAdd.push(selector)
		} else {
			selectorsToReplace.push(selector)
		}
	}

	const diamondCut = [
		...(selectorsToAdd.length > 0
			? [
					{
						facetAddress: deployedFacetAddress,
						action: FacetCutAction.Add,
						functionSelectors: selectorsToAdd,
					},
				]
			: []),
		...(selectorsToReplace.length > 0
			? [
					{
						facetAddress: deployedFacetAddress,
						action: FacetCutAction.Replace,
						functionSelectors: selectorsToReplace,
					},
				]
			: []),
	]

	const tx = await diamondCutFacet.diamondCut(diamondCut, ethers.ZeroAddress, "0x")
	await tx.wait()
	console.log(`Facet updated successfully. Added ${selectorsToAdd.length}, replaced ${selectorsToReplace.length}.`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
