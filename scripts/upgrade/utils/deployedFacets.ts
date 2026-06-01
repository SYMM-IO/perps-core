import fs from "fs"

import { ethers } from "../../../test/helpers/hardhat-connection.js"
import type { DeploymentStateContext, DeploymentStateMetadata } from "./deploymentState.js"
import { loadDeploymentState, resolveDeploymentStateMetadata } from "./deploymentState.js"

export type DeployedFacetInfo = {
	address: string
	selectors: string[]
}

export type DeployedFacetsState = {
	libraries?: Record<string, string>
	facets?: Record<string, DeployedFacetInfo>
	selectorSignatures?: Record<string, string>
	metadata?: DeploymentStateMetadata
}

export type DeployedFacetsSummary = {
	file: string
	exists: boolean
	networkName?: string
	chainId?: number
	diamondAddress?: string
	facetCount?: number
	selectorCount?: number
	migrationFacet?: string
}

export type LoadedDeployedFacets = {
	state: DeployedFacetsState | null
	summary: DeployedFacetsSummary
}

export const MIGRATION_SURFACE_SELECTORS: Array<{ facetName: string; signature: string }> = [
	{ facetName: "MigrationFacet", signature: "migrateQuotes(uint256[])" },
	{ facetName: "MigrationFacet", signature: "migrateCrossLockedValues(address,address[])" },
	{ facetName: "MigrationFacet", signature: "isQuoteMigrated(uint256)" },
	{ facetName: "MigrationFacet", signature: "isCrossLockedValuesMigrated(address,address)" },
	{ facetName: "ViewFacet", signature: "balanceInfoOfPartyB(address,address)" },
	{ facetName: "ViewFacet", signature: "balanceInfoOfCrossPartyB(address)" },
	{ facetName: "ViewFacetQuote", signature: "getQuote(uint256)" },
	{ facetName: "ViewFacetAggregate", signature: "getPartyBAggregatedPositionBySymbolPerPartyA(address,address,uint256)" },
]

function normalizeSelector(selector: string): string {
	return selector.toLowerCase()
}

function selectorFor(signature: string): string {
	return normalizeSelector(ethers.id(signature).slice(0, 10))
}

function normalizeAddress(address: string | undefined): string | undefined {
	if (!address || !ethers.isAddress(address)) return address
	return ethers.getAddress(address)
}

function summarizeDeployedFacets(file: string, state: DeployedFacetsState): DeployedFacetsSummary {
	const facets = state.facets ?? {}
	const selectorCount = Object.values(facets).reduce((count, facet) => count + (Array.isArray(facet.selectors) ? facet.selectors.length : 0), 0)
	const metadata = state.metadata ?? {}
	return {
		file,
		exists: true,
		networkName: metadata.networkName,
		chainId: metadata.chainId,
		diamondAddress: normalizeAddress(metadata.diamondAddress),
		facetCount: Object.keys(facets).length,
		selectorCount,
		migrationFacet: normalizeAddress(facets.MigrationFacet?.address),
	}
}

function validateFacetPayload(file: string, state: DeployedFacetsState): void {
	if (!state.facets || typeof state.facets !== "object") {
		throw new Error(`Deployed facets file ${file} is missing a facets object.`)
	}
	const problems: string[] = []
	for (const [name, facet] of Object.entries(state.facets)) {
		if (!facet || typeof facet !== "object") {
			problems.push(`${name}: invalid facet entry`)
			continue
		}
		if (!ethers.isAddress(facet.address) || ethers.getAddress(facet.address) === ethers.ZeroAddress) {
			problems.push(`${name}: invalid address ${facet.address}`)
		}
		if (!Array.isArray(facet.selectors)) {
			problems.push(`${name}: selectors must be an array`)
		}
	}
	if (problems.length > 0) {
		throw new Error(`Invalid deployed facets file ${file}: ${problems.join("; ")}`)
	}
}

function validateMigrationSurface(file: string, state: DeployedFacetsState): void {
	validateFacetPayload(file, state)
	const problems: string[] = []
	for (const required of MIGRATION_SURFACE_SELECTORS) {
		const facet = state.facets![required.facetName]
		if (!facet) {
			problems.push(`missing ${required.facetName}`)
			continue
		}
		const selector = selectorFor(required.signature)
		const selectors = new Set(facet.selectors.map(normalizeSelector))
		if (!selectors.has(selector)) {
			problems.push(`${required.facetName}: missing ${required.signature} (${selector})`)
		}
	}
	if (problems.length > 0) {
		throw new Error(`Deployed facets file ${file} does not contain the migration surface: ${problems.join("; ")}`)
	}
}

export async function loadDeployedFacetsForNetwork(
	file: string,
	context: DeploymentStateContext,
	options: { required?: boolean; validateMigrationSurface?: boolean } = {},
): Promise<LoadedDeployedFacets> {
	if (!fs.existsSync(file)) {
		if (options.required) throw new Error(`Deployed facets file not found: ${file}`)
		return { state: null, summary: { file, exists: false } }
	}

	const expectedMetadata = await resolveDeploymentStateMetadata(context)
	const state = loadDeploymentState<DeployedFacetsState>(file, expectedMetadata)
	validateFacetPayload(file, state)
	if (options.validateMigrationSurface) validateMigrationSurface(file, state)
	return { state, summary: summarizeDeployedFacets(file, state) }
}

export async function verifyMigrationSurfaceOnDiamond(diamondAddress: string, deployedFacets: DeployedFacetsState): Promise<void> {
	validateMigrationSurface("deployed facets state", deployedFacets)
	const loupe = await ethers.getContractAt(["function facetAddress(bytes4 selector) view returns (address)"], diamondAddress)
	const problems: string[] = []

	for (const required of MIGRATION_SURFACE_SELECTORS) {
		const selector = selectorFor(required.signature)
		const expected = ethers.getAddress(deployedFacets.facets![required.facetName].address)
		const actual = await loupe.facetAddress(selector)
		if (!actual || ethers.getAddress(actual) === ethers.ZeroAddress) {
			problems.push(`${required.signature} (${selector}) is not installed on the diamond`)
		} else if (ethers.getAddress(actual) !== expected) {
			problems.push(`${required.signature} (${selector}) expected ${expected}, got ${ethers.getAddress(actual)}`)
		}
	}

	if (problems.length > 0) {
		throw new Error(`Live diamond migration surface does not match deployed facets: ${problems.join("; ")}`)
	}
}
