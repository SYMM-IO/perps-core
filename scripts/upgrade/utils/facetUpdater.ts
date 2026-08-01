import fs from "fs"
import path from "path"

import { FacetCutAction, getSelectors } from "../../../tasks/utils/diamondCut.js"
import { ethers } from "../../../test/helpers/hardhat-connection.js"
import { ensureLibraries, getFacetSpec, getLinkedContractFactory, type DiamondScope } from "../../../utils/deploymentManifest.js"

export type FacetUpdateArgs = {
	diamondAddress: string
	scope: DiamondScope
	facetName: string
	facetAddress?: string
	stateFile: string
	reportFile: string
	signer?: any
}

type UpdateState = {
	libraries: Record<string, string>
	facets: Record<string, string>
}

export type FacetUpdateReport = {
	scope: DiamondScope
	diamondAddress: string
	facetName: string
	facetArtifact: string
	facetAddress: string
	libraries: Record<string, string | null>
	selectorsToAdd: string[]
	selectorsToReplace: string[]
	selectorsToRemove: string[]
	transactionHash: string | null
}

export function validateAddress(label: string, value: string | undefined): string {
	if (!value) throw new Error(`${label} is required`)
	if (!ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(`${label} is invalid: ${value}`)
	return value
}

export function parseDiamondScope(value: string | undefined): DiamondScope {
	const scope = value ?? "core"
	if (scope !== "core" && scope !== "accountLayer") {
		throw new Error(`DIAMOND_SCOPE must be "core" or "accountLayer", received: ${scope}`)
	}
	return scope
}

function loadState(filePath: string): UpdateState {
	if (!fs.existsSync(filePath)) return { libraries: {}, facets: {} }
	const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<UpdateState>
	return { libraries: parsed.libraries ?? {}, facets: parsed.facets ?? {} }
}

function writeJson(filePath: string, value: unknown): void {
	const directory = path.dirname(filePath)
	if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true })
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

export async function updateFacet(args: FacetUpdateArgs): Promise<FacetUpdateReport> {
	const diamondAddress = validateAddress("diamondAddress", args.diamondAddress)
	if (args.facetAddress) validateAddress("facetAddress", args.facetAddress)
	const spec = getFacetSpec(args.scope, args.facetName)
	const state = loadState(args.stateFile)

	const diamondCutFacet = await ethers.getContractAt("DiamondCutFacet", diamondAddress, args.signer)
	const diamondLoupeFacet = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress)

	// Selector discovery only needs the ABI. This deliberately avoids constructing
	// an unlinked deployment factory when a pre-deployed facet was supplied.
	const facetInterface = await ethers.getContractAt(spec.artifact, diamondAddress)
	const selectors = getSelectors(ethers, facetInterface as any).selectors

	let facetAddress = args.facetAddress
	if (!facetAddress) {
		state.libraries = await ensureLibraries({
			ethers,
			scope: args.scope,
			requiredLibraries: spec.libraries,
			existing: state.libraries,
			onDeployed: (name, address) => {
				state.libraries[name] = address
				writeJson(args.stateFile, state)
			},
		})
		const facetFactory = await getLinkedContractFactory(ethers, args.scope, spec, state.libraries)
		const facet = await facetFactory.deploy()
		await facet.waitForDeployment()
		const deployedAddress: string = await facet.getAddress()
		facetAddress = deployedAddress
		state.facets[spec.name] = deployedAddress
		writeJson(args.stateFile, state)
	}
	const deployedFacetAddress = validateAddress("facetAddress", facetAddress)

	const selectorsToAdd: string[] = []
	const selectorsToReplace: string[] = []
	const currentFacetAddresses = new Set<string>()
	for (const selector of selectors) {
		const currentFacetAddress = await diamondLoupeFacet.facetAddress(selector)
		if (currentFacetAddress === ethers.ZeroAddress) selectorsToAdd.push(selector)
		else if (currentFacetAddress.toLowerCase() !== deployedFacetAddress.toLowerCase()) {
			selectorsToReplace.push(selector)
			currentFacetAddresses.add(currentFacetAddress.toLowerCase())
		}
	}

	// Selectors the new facet version dropped must be removed from the diamond, or the
	// old facet keeps serving them after the upgrade.
	const newSelectorSet = new Set(selectors.map((selector: string) => selector.toLowerCase()))
	const selectorsToRemove = new Set<string>()
	for (const currentFacetAddress of currentFacetAddresses) {
		const currentFacetSelectors: string[] = await diamondLoupeFacet.facetFunctionSelectors(currentFacetAddress)
		for (const selector of currentFacetSelectors) {
			if (!newSelectorSet.has(selector.toLowerCase())) selectorsToRemove.add(selector)
		}
	}

	const diamondCut = [
		...(selectorsToAdd.length > 0 ? [{ facetAddress: deployedFacetAddress, action: FacetCutAction.Add, functionSelectors: selectorsToAdd }] : []),
		...(selectorsToReplace.length > 0
			? [{ facetAddress: deployedFacetAddress, action: FacetCutAction.Replace, functionSelectors: selectorsToReplace }]
			: []),
		...(selectorsToRemove.size > 0
			? [{ facetAddress: ethers.ZeroAddress, action: FacetCutAction.Remove, functionSelectors: Array.from(selectorsToRemove) }]
			: []),
	]

	let transactionHash: string | null = null
	if (diamondCut.length > 0) {
		const tx = await diamondCutFacet.diamondCut(diamondCut, ethers.ZeroAddress, "0x")
		await tx.wait()
		transactionHash = tx.hash
	}

	const report: FacetUpdateReport = {
		scope: args.scope,
		diamondAddress,
		facetName: spec.name,
		facetArtifact: spec.artifact,
		facetAddress: deployedFacetAddress,
		libraries: Object.fromEntries(spec.libraries.map(name => [name, state.libraries[name] ?? null])),
		selectorsToAdd,
		selectorsToReplace,
		selectorsToRemove: Array.from(selectorsToRemove),
		transactionHash,
	}
	writeJson(args.reportFile, report)
	return report
}
