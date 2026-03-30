import { FacetCutAction, getSelectors } from "../tasks/utils/diamondCut.js"
import { ethers } from "../test/helpers/hardhat-connection.js"

// Env:
//  DIAMOND    - target diamond address (required)
//  FACET      - facet contract path/name for ethers.getContractFactory (required)
//              e.g., contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet
//  FACET_ADDR - deployed facet address to wire into the diamond (required)
//  CUT_MODE   - "both" | "add" | "replace" (default: both)
//  ADD_NAMES  - optional comma-separated function names to limit Add selectors
//
// Usage examples:
//  DIAMOND=0x... FACET=contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet FACET_ADDR=0x... \
//    npx hardhat run scripts/diamond-upgrade-facet.ts --network base
//  CUT_MODE=replace DIAMOND=0x... FACET=... FACET_ADDR=0x... \
//    npx hardhat run scripts/diamond-upgrade-facet.ts --network base
//  CUT_MODE=add ADD_NAMES=getLastWithdrawRequestId,getWithdrawRequestsBatch,getPendingWithdrawRequests \
//    DIAMOND=0x... FACET=... FACET_ADDR=0x... \
//    npx hardhat run scripts/diamond-upgrade-facet.ts --network base

const diamondAddress = process.env.DIAMOND || ""
const facetName = process.env.FACET || ""
const newFacetAddress = process.env.FACET_ADDR || ""

async function main() {
	if (!diamondAddress) {
		throw new Error("Set DIAMOND env var to the core diamond address")
	}

	if (!facetName) {
		throw new Error("Set FACET env var to the facet contract name/path (e.g., contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet)")
	}

	if (!newFacetAddress) {
		throw new Error("Set FACET_ADDR env var to the deployed facet implementation address")
	}

	const mode = (process.env.CUT_MODE || "both").toLowerCase() // "both" | "add" | "replace"
	const addNames = (process.env.ADD_NAMES || "")
		.split(",")
		.map(s => s.trim())
		.filter(Boolean)

	const [signer] = await ethers.getSigners()
	const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress, signer)
	const loupe = await ethers.getContractAt("IDiamondLoupe", diamondAddress, signer)
	const FacetFactory = await ethers.getContractFactory(facetName)

	const selectorsAll = getSelectors(ethers, FacetFactory).selectors
	const selectorsReplace = selectorsAll.slice() // start with all; we'll remove ones not present

	// Read current selectors on diamond to avoid replacing non-existent ones
	const currentFacets = await loupe.facets()
	const currentSelectors = new Set<string>()
	for (const f of currentFacets) {
		for (const sel of f.functionSelectors) {
			currentSelectors.add(sel)
		}
	}

	// Split into replace (already present) and add (missing)
	const replaceSelectors = selectorsReplace.filter(s => currentSelectors.has(s))
	const addSelectors: string[] = []
	for (const sel of selectorsAll) {
		if (!currentSelectors.has(sel)) {
			addSelectors.push(sel)
		}
	}

	// Optionally restrict adds to specified function names
	if (addNames.length > 0) {
		const selected = getSelectors(ethers, FacetFactory).get(addNames)
		for (let i = addSelectors.length - 1; i >= 0; i--) {
			if (!selected.includes(addSelectors[i])) {
				addSelectors.splice(i, 1)
			}
		}
	}

	// Replace the selectors that already exist on the diamond, and add any that are missing
	const cut = []
	if ((mode === "both" || mode === "replace") && replaceSelectors.length > 0) {
		cut.push({
			facetAddress: newFacetAddress,
			action: FacetCutAction.Replace,
			functionSelectors: replaceSelectors,
		})
	}
	if ((mode === "both" || mode === "add") && addSelectors.length > 0) {
		cut.push({
			facetAddress: newFacetAddress,
			action: FacetCutAction.Add,
			functionSelectors: addSelectors,
		})
	}

	console.log("Diamond:", diamondAddress)
	console.log("Facet:", facetName)
	console.log("New facet address:", newFacetAddress)
	console.log("Mode:", mode)
	console.log("Replace selectors:", replaceSelectors)
	console.log("Add selectors:", addSelectors)
	console.log("Diamond cut payload:", JSON.stringify(cut, null, 2))

	const tx = await diamondCut.diamondCut(cut, ethers.ZeroAddress, "0x")
	console.log("diamondCut tx:", tx.hash)
	await tx.wait()
	console.log("✅ diamondCut executed")
}

main().catch(err => {
	console.error(err)
	process.exit(1)
})
