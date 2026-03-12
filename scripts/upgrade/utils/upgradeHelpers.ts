/**
 * Diamond upgrade utilities — deploy facets, build diamondCut, apply it.
 * Extracted from upgradeTest.ts for use by forkUpgrade.ts.
 */
import { FacetNames } from "../../../tasks/deploy/constants.js"
import { FacetCutAction, getSelectors } from "../../../tasks/utils/diamondCut.js"
import { ethers } from "../../../test/helpers/hardhat-connection.js"

export type FacetInfo = {
	address: string
	selectors: string[]
}

export type SelectorChangeAction = "add" | "replace" | "remove"

export type SelectorChange = {
	selector: string
	action: SelectorChangeAction
	signature: string | null
	fromFacetAddress: string | null
	toFacetAddress: string | null
	toFacetName: string | null
}

const IGNORE_REMOVE_SELECTORS = new Set<string>([
	"0x1f931c1c", // diamondCut
])

// Facet => required libraries for linking
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
	ClearingHouseFacet: ["LibQuoteFunding"],
	SettlementFacet: ["LibSettlement"],
}

export async function deployLibraries(): Promise<Record<string, string>> {
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

export async function deployFacets(): Promise<{ facets: Record<string, FacetInfo>; selectorSignatures: Record<string, string> }> {
	const libraries = await deployLibraries()
	const facets: Record<string, FacetInfo> = {}
	const selectorSignatures: Record<string, string> = {}

	for (const facetName of FacetNames) {
		const shortName = facetName.includes(":") ? facetName.split(":").pop()! : facetName
		const requiredLibraries = FacetLibraryDependencies[shortName]
		let facetFactory

		if (requiredLibraries && requiredLibraries.length > 0) {
			const linked: Record<string, string> = {}
			for (const lib of requiredLibraries) {
				linked[`project/contracts/core/libraries/${lib}.sol:${lib}`] = libraries[lib]
			}
			facetFactory = await ethers.getContractFactory(facetName, { libraries: linked })
		} else {
			facetFactory = await ethers.getContractFactory(facetName)
		}

		const facet = await facetFactory.deploy()
		await facet.waitForDeployment()
		const address = await facet.getAddress()
		const selectors = getSelectors(ethers, facetFactory).selectors

		facets[shortName] = { address, selectors }
		for (const fragment of facetFactory.interface.fragments) {
			if (fragment.type !== "function") continue
			const signature = fragment.format("sighash")
			if (signature === "init(bytes)") continue
			const selector = ethers.id(signature).substring(0, 10)
			if (!selectorSignatures[selector]) {
				selectorSignatures[selector] = signature
			}
		}
		console.log(`Deployed ${shortName}: ${address}`)
	}

	return { facets, selectorSignatures }
}

export async function buildDiamondCut(
	diamondAddress: string,
	newFacets: Record<string, FacetInfo>,
	knownSelectorSignatures: Record<string, string>,
): Promise<{ diamondCut: any[]; selectorChanges: SelectorChange[] }> {
	const diamondLoupeFacet = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress)
	const facets = await diamondLoupeFacet.facets()

	const currentSelectors: Map<string, string> = new Map()
	for (const facet of facets) {
		for (const selector of facet.functionSelectors) {
			currentSelectors.set(selector, facet.facetAddress)
		}
	}

	const newSelectors: Map<string, string> = new Map()
	for (const facet of Object.values(newFacets)) {
		for (const selector of facet.selectors) {
			newSelectors.set(selector, facet.address)
		}
	}

	const facetNameByAddress: Record<string, string> = {}
	for (const [facetName, facetInfo] of Object.entries(newFacets)) {
		facetNameByAddress[facetInfo.address.toLowerCase()] = facetName
	}

	const actions: Record<string, { action: FacetCutAction; facetAddress: string }> = {}
	const selectorChanges: SelectorChange[] = []

	for (const [selector, currentFacetAddress] of currentSelectors) {
		if (newSelectors.has(selector)) {
			const toFacetAddress = newSelectors.get(selector)!
			actions[selector] = {
				action: FacetCutAction.Replace,
				facetAddress: toFacetAddress,
			}
			selectorChanges.push({
				selector,
				action: "replace",
				signature: knownSelectorSignatures[selector] ?? null,
				fromFacetAddress: currentFacetAddress,
				toFacetAddress,
				toFacetName: facetNameByAddress[toFacetAddress.toLowerCase()] ?? null,
			})
			newSelectors.delete(selector)
		} else if (!IGNORE_REMOVE_SELECTORS.has(selector)) {
			actions[selector] = {
				action: FacetCutAction.Remove,
				facetAddress: ethers.ZeroAddress,
			}
			selectorChanges.push({
				selector,
				action: "remove",
				signature: knownSelectorSignatures[selector] ?? null,
				fromFacetAddress: currentFacetAddress,
				toFacetAddress: null,
				toFacetName: null,
			})
		}
	}

	for (const [selector, facetAddress] of newSelectors) {
		actions[selector] = {
			action: FacetCutAction.Add,
			facetAddress,
		}
		selectorChanges.push({
			selector,
			action: "add",
			signature: knownSelectorSignatures[selector] ?? null,
			fromFacetAddress: null,
			toFacetAddress: facetAddress,
			toFacetName: facetNameByAddress[facetAddress.toLowerCase()] ?? null,
		})
	}

	const cutMap: Record<string, { facetAddress: string; action: FacetCutAction; selectors: string[] }> = {}
	for (const [selector, info] of Object.entries(actions)) {
		const key = `${info.facetAddress}-${info.action}`
		if (!cutMap[key]) {
			cutMap[key] = {
				facetAddress: info.facetAddress,
				action: info.action,
				selectors: [],
			}
		}
		cutMap[key].selectors.push(selector)
	}

	const diamondCut = Object.values(cutMap)
		.filter(cut => cut.selectors.length > 0)
		.map(cut => ({
			facetAddress: cut.facetAddress,
			action: cut.action,
			functionSelectors: cut.selectors,
		}))

	selectorChanges.sort((a, b) => a.selector.localeCompare(b.selector))

	return {
		diamondCut,
		selectorChanges,
	}
}

export async function applyDiamondCut(diamondAddress: string, diamondCut: any[], signer?: any, chunkSize: number = 6): Promise<void> {
	if (diamondCut.length === 0) {
		console.log("No diamond cut required")
		return
	}

	const diamondCutFacet = signer
		? await ethers.getContractAt("DiamondCutFacet", diamondAddress, signer)
		: await ethers.getContractAt("DiamondCutFacet", diamondAddress)
	const chunks: any[][] = []
	for (let i = 0; i < diamondCut.length; i += chunkSize) {
		chunks.push(diamondCut.slice(i, i + chunkSize))
	}

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i]
		const tx = await diamondCutFacet.diamondCut(chunk, ethers.ZeroAddress, "0x")
		const receipt = await tx.wait()
		if (!receipt?.status) {
			throw new Error(`Diamond cut failed in chunk ${i + 1}/${chunks.length}: ${tx.hash}`)
		}
		console.log(`Diamond cut chunk ${i + 1}/${chunks.length} applied`)
	}
}
