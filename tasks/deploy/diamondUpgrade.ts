import fs from "fs"

import { ethers, hre } from "../../test/helpers/hardhat-connection.js"
import {
	FacetSpecs,
	ensureLibraries,
	getLinkedContractFactory,
	linkedLibrariesFor,
	type DeploymentSpec,
	type DiamondScope,
} from "../../utils/deploymentManifest.js"
import { FacetCutAction, getSelectors } from "../utils/diamondCut.js"
import { deploymentOnlyArtifact } from "./artifacts.js"
import type { DeploymentCheckpoint } from "./checkpoint.js"
import { recoverConfirmedDeployment } from "./tx.js"
import { deployContract } from "./vanityDeploy.js"

export type FacetInfo = {
	address: string
	selectors: string[]
}

export type SelectorChange = {
	selector: string
	action: "add" | "replace" | "remove"
	signature: string | null
	fromFacetAddress: string | null
	toFacetAddress: string | null
	toFacetName: string | null
}

type DeploymentState = {
	libraries: Record<string, string>
	facets: Record<string, FacetInfo>
	selectorSignatures: Record<string, string>
}

const IGNORE_REMOVE_SELECTORS = new Set(["0x1f931c1c"])

function loadState(filePath?: string): DeploymentState {
	if (!filePath || !fs.existsSync(filePath)) return { libraries: {}, facets: {}, selectorSignatures: {} }
	const state = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<DeploymentState>
	return {
		libraries: state.libraries ?? {},
		facets: state.facets ?? {},
		selectorSignatures: state.selectorSignatures ?? {},
	}
}

function saveState(filePath: string | undefined, state: DeploymentState): void {
	if (!filePath) return
	const separator = filePath.lastIndexOf("/")
	if (separator > 0) fs.mkdirSync(filePath.slice(0, separator), { recursive: true })
	fs.writeFileSync(filePath, JSON.stringify(state, null, 2))
}

async function getLibraryDeploymentFactory(scope: DiamondScope, spec: DeploymentSpec, addresses: Record<string, string>): Promise<any> {
	const artifact = await hre.artifacts.readArtifact(spec.artifact)
	const libraries = linkedLibrariesFor(scope, spec, addresses)
	return ethers.getContractFactoryFromArtifact(deploymentOnlyArtifact(artifact), {
		...(Object.keys(libraries).length > 0 ? { libraries } : {}),
	})
}

export async function deployFacets(
	outputFile?: string,
	scope: DiamondScope = "core",
	options: { checkpoint?: DeploymentCheckpoint } = {},
): Promise<{ libraries: Record<string, string>; facets: Record<string, FacetInfo>; selectorSignatures: Record<string, string> }> {
	const state = loadState(outputFile)
	const persist = () => saveState(outputFile, state)
	for (const [name, address] of [
		...Object.entries(state.libraries),
		...Object.entries(state.facets).map(([name, facet]) => [name, facet.address] as const),
	]) {
		if ((await ethers.provider.getCode(address)) === "0x") {
			throw new Error(`${scope} facet deployment state records ${name} at ${address}, but that address has no runtime bytecode`)
		}
	}
	const deployRegistered = async (kind: "libraries" | "facets", name: string, factory: any): Promise<string> => {
		const component = `contracts.upgrade.${scope}.${kind}.${name}`
		const recovered = options.checkpoint ? await recoverConfirmedDeployment(options.checkpoint.transactions || [], component, ethers.provider) : null
		if (recovered) return recovered
		return (
			await deployContract(null, {
				key: `${scope}/${name}`,
				component,
				label: `${scope} ${name}`,
				factory,
				checkpoint: options.checkpoint,
			})
		).address
	}

	state.libraries = await ensureLibraries({
		ethers,
		scope,
		existing: state.libraries,
		getFactory: (spec, addresses) => getLibraryDeploymentFactory(scope, spec, addresses),
		deploy: async (name, factory) => ({ address: await deployRegistered("libraries", name, factory) }),
		onDeployed: (name, address) => {
			state.libraries[name] = address
			persist()
		},
	})

	for (const spec of Object.values(FacetSpecs[scope])) {
		if (state.facets[spec.name]) continue
		const factory = await getLinkedContractFactory(ethers, scope, spec, state.libraries)
		const address = await deployRegistered("facets", spec.name, factory)
		const selectors = getSelectors(ethers, factory).selectors
		state.facets[spec.name] = { address, selectors }
		for (const fragment of factory.interface.fragments) {
			if (fragment.type !== "function") continue
			const signature = fragment.format("sighash")
			if (signature === "init(bytes)") continue
			const selector = ethers.id(signature).slice(0, 10)
			state.selectorSignatures[selector] ??= signature
		}
		persist()
	}

	return { libraries: state.libraries, facets: state.facets, selectorSignatures: state.selectorSignatures }
}

export async function buildDiamondCut(
	diamondAddress: string,
	newFacets: Record<string, FacetInfo>,
	knownSelectorSignatures: Record<string, string>,
): Promise<{ diamondCut: any[]; selectorChanges: SelectorChange[] }> {
	const loupe = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress)
	const currentSelectors = new Map<string, string>()
	for (const facet of await loupe.facets()) {
		for (const selector of facet.functionSelectors) currentSelectors.set(selector, facet.facetAddress)
	}

	const newSelectors = new Map<string, string>()
	const facetNameByAddress: Record<string, string> = {}
	for (const [name, facet] of Object.entries(newFacets)) {
		facetNameByAddress[facet.address.toLowerCase()] = name
		for (const selector of facet.selectors) newSelectors.set(selector, facet.address)
	}

	const actions = new Map<string, { action: FacetCutAction; facetAddress: string }>()
	const selectorChanges: SelectorChange[] = []
	for (const [selector, currentFacetAddress] of currentSelectors) {
		const nextFacetAddress = newSelectors.get(selector)
		if (nextFacetAddress) {
			newSelectors.delete(selector)
			if (currentFacetAddress.toLowerCase() === nextFacetAddress.toLowerCase()) continue
			actions.set(selector, { action: FacetCutAction.Replace, facetAddress: nextFacetAddress })
			selectorChanges.push({
				selector,
				action: "replace",
				signature: knownSelectorSignatures[selector] ?? null,
				fromFacetAddress: currentFacetAddress,
				toFacetAddress: nextFacetAddress,
				toFacetName: facetNameByAddress[nextFacetAddress.toLowerCase()] ?? null,
			})
		} else if (!IGNORE_REMOVE_SELECTORS.has(selector)) {
			actions.set(selector, { action: FacetCutAction.Remove, facetAddress: ethers.ZeroAddress })
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
		actions.set(selector, { action: FacetCutAction.Add, facetAddress })
		selectorChanges.push({
			selector,
			action: "add",
			signature: knownSelectorSignatures[selector] ?? null,
			fromFacetAddress: null,
			toFacetAddress: facetAddress,
			toFacetName: facetNameByAddress[facetAddress.toLowerCase()] ?? null,
		})
	}

	const grouped = new Map<string, { facetAddress: string; action: FacetCutAction; functionSelectors: string[] }>()
	for (const [selector, action] of actions) {
		const key = `${action.action}:${action.facetAddress.toLowerCase()}`
		const cut = grouped.get(key) ?? { ...action, functionSelectors: [] }
		cut.functionSelectors.push(selector)
		grouped.set(key, cut)
	}
	selectorChanges.sort((a, b) => a.selector.localeCompare(b.selector))
	return { diamondCut: [...grouped.values()], selectorChanges }
}

export async function applyDiamondCut(diamondAddress: string, diamondCut: any[], signer?: any, chunkSize = 6): Promise<void> {
	if (diamondCut.length === 0) return
	const contract = await ethers.getContractAt("DiamondCutFacet", diamondAddress, signer)
	for (let offset = 0; offset < diamondCut.length; offset += chunkSize) {
		const tx = await contract.diamondCut(diamondCut.slice(offset, offset + chunkSize), ethers.ZeroAddress, "0x")
		const receipt = await tx.wait()
		if (!receipt?.status) throw new Error(`Diamond cut failed: ${tx.hash}`)
	}
}

export function buildRollbackDiamondCut(
	selectorChanges: SelectorChange[],
): Array<{ facetAddress: string; action: FacetCutAction; functionSelectors: string[] }> {
	const grouped = new Map<string, { facetAddress: string; action: FacetCutAction; functionSelectors: string[] }>()
	for (const change of selectorChanges) {
		const action = change.action === "add" ? FacetCutAction.Remove : change.action === "replace" ? FacetCutAction.Replace : FacetCutAction.Add
		const facetAddress = change.action === "add" ? ethers.ZeroAddress : change.fromFacetAddress
		if (!facetAddress) throw new Error(`Cannot roll back ${change.action} of ${change.selector}: missing original facet`)
		const key = `${action}:${facetAddress.toLowerCase()}`
		const cut = grouped.get(key) ?? { facetAddress, action, functionSelectors: [] }
		cut.functionSelectors.push(change.selector)
		grouped.set(key, cut)
	}
	return [...grouped.values()]
}
