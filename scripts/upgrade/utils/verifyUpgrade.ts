/**
 * Diamond upgrade verification utilities.
 *
 * Reads on-chain diamond state and compares against expected post-upgrade state.
 * Used by verifyUpgrade.ts during localhost testing -- not part of the
 * production upgrade flow.
 */
import { FacetNames } from "../../../tasks/deploy/constants.js"
import { getSelectors } from "../../../tasks/utils/diamondCut.js"
import { ethers } from "../../../test/helpers/hardhat-connection.js"
import { type FacetInfo, FacetLibraryDependencies } from "./upgradeHelpers.js"

const DIAMOND_CUT_SELECTOR = "0x1f931c1c"

/**
 * Read the current on-chain diamond state via DiamondLoupeFacet.
 * Returns a map of selector -> lowercase facet address.
 */
export async function readOnChainSelectors(diamondAddress: string): Promise<Map<string, string>> {
	const loupe = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress)
	const facets = await loupe.facets()
	const map = new Map<string, string>()
	for (const facet of facets) {
		for (const selector of facet.functionSelectors) {
			map.set(selector, facet.facetAddress.toLowerCase())
		}
	}
	return map
}

/**
 * Build the expected post-upgrade selector map from deployed facets
 * plus the diamondCut selector (which is never removed).
 */
export function buildExpectedState(currentSelectors: Map<string, string>, newFacets: Record<string, FacetInfo>): Map<string, string> {
	const expected = new Map<string, string>()
	for (const facet of Object.values(newFacets)) {
		for (const selector of facet.selectors) {
			expected.set(selector, facet.address.toLowerCase())
		}
	}
	if (currentSelectors.has(DIAMOND_CUT_SELECTOR) && !expected.has(DIAMOND_CUT_SELECTOR)) {
		expected.set(DIAMOND_CUT_SELECTOR, currentSelectors.get(DIAMOND_CUT_SELECTOR)!)
	}
	return expected
}

/**
 * Run post-cut verification: read on-chain state and compare to expected.
 * Throws on failure.
 */
export async function runPostCutVerification(
	diamondAddress: string,
	expectedState: Map<string, string>,
	selectorSignatures: Record<string, string>,
): Promise<void> {
	const postSelectors = await readOnChainSelectors(diamondAddress)
	console.log(`On-chain selectors: ${postSelectors.size}`)

	const errors: string[] = []
	for (const [selector, expectedAddr] of expectedState) {
		const actualAddr = postSelectors.get(selector)
		if (!actualAddr) {
			errors.push(`Missing: ${selector} (${selectorSignatures[selector] ?? "?"}) expected at ${expectedAddr}`)
		} else if (actualAddr !== expectedAddr) {
			errors.push(`Wrong address: ${selector} (${selectorSignatures[selector] ?? "?"}) expected ${expectedAddr}, got ${actualAddr}`)
		}
	}
	for (const [selector] of postSelectors) {
		if (!expectedState.has(selector)) {
			errors.push(`Unexpected: ${selector} (${selectorSignatures[selector] ?? "?"}) at ${postSelectors.get(selector)}`)
		}
	}

	if (errors.length > 0) {
		for (const err of errors) console.error(`  ${err}`)
		throw new Error(`Verification failed with ${errors.length} error(s).`)
	}
	console.log(`All ${expectedState.size} selectors verified on-chain. OK`)
}

/**
 * Verify on-chain diamond selectors match compiled source code artifacts.
 * Extracts selectors from every facet in FacetNames and checks that each
 * one is registered on-chain. Also flags any on-chain selectors not found
 * in the source (excluding diamondCut which is managed separately).
 * Throws on mismatch.
 */
export async function verifyAgainstArtifacts(diamondAddress: string): Promise<void> {
	const onChain = await readOnChainSelectors(diamondAddress)
	const errors: string[] = []
	const expectedSelectors = new Set<string>()
	let totalVerified = 0

	// Dummy address for library linking — only need ABI, not bytecode
	const DUMMY_LIB = "0x0000000000000000000000000000000000000001"

	for (const facetName of FacetNames) {
		const shortName = facetName.includes(":") ? facetName.split(":").pop()! : facetName
		const requiredLibs = FacetLibraryDependencies[shortName]
		let factory
		if (requiredLibs && requiredLibs.length > 0) {
			const linked: Record<string, string> = {}
			for (const lib of requiredLibs) {
				linked[`project/contracts/core/libraries/${lib}.sol:${lib}`] = DUMMY_LIB
			}
			factory = await ethers.getContractFactory(facetName, { libraries: linked })
		} else {
			factory = await ethers.getContractFactory(facetName)
		}
		const selectors: string[] = getSelectors(ethers, factory).selectors

		for (const sel of selectors) {
			expectedSelectors.add(sel)
			if (!onChain.has(sel)) {
				const sig = factory.interface.getFunction(sel)?.format("sighash") ?? sel
				errors.push(`${shortName}: selector ${sig} (${sel}) in source but missing on-chain`)
			}
		}
		totalVerified += selectors.length
	}

	// diamondCut is always present on-chain but not in FacetNames
	expectedSelectors.add(DIAMOND_CUT_SELECTOR)

	for (const [sel] of onChain) {
		if (!expectedSelectors.has(sel)) {
			errors.push(`Unexpected on-chain selector ${sel} not found in any compiled facet`)
		}
	}

	if (errors.length > 0) {
		for (const err of errors) console.error(`  ${err}`)
		throw new Error(`Artifact verification failed with ${errors.length} error(s).`)
	}
	console.log(`All ${totalVerified} selectors across ${FacetNames.length} facets verified against on-chain diamond. OK`)
}
