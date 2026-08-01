import { FacetNames } from "../tasks/deploy/constants.js"

export type DiamondScope = "core" | "accountLayer"

export type DeploymentSpec = {
	name: string
	artifact: string
	libraries: string[]
	linkReference?: string
}

type EthersLike = {
	getContractFactory: (name: string, options?: { libraries?: Record<string, string> }) => Promise<any>
}

type EnsureLibrariesArgs = {
	ethers: EthersLike
	scope: DiamondScope
	requiredLibraries?: string[]
	existing?: Record<string, string>
	onDeployed?: (name: string, address: string, contract: any) => Promise<void> | void
	onReused?: (name: string, address: string) => Promise<void> | void
}

const CORE_LIBRARY_SPECS: Record<string, DeploymentSpec> = {
	LibQuoteFunding: {
		name: "LibQuoteFunding",
		artifact: "contracts/core/libraries/LibQuoteFunding.sol:LibQuoteFunding",
		libraries: [],
		linkReference: "project/contracts/core/libraries/LibQuoteFunding.sol:LibQuoteFunding",
	},
	LibQuoteClose: {
		name: "LibQuoteClose",
		artifact: "contracts/core/libraries/LibQuoteClose.sol:LibQuoteClose",
		libraries: ["LibQuoteFunding"],
		linkReference: "project/contracts/core/libraries/LibQuoteClose.sol:LibQuoteClose",
	},
	PartyBPositionActionsFacetImpl: {
		name: "PartyBPositionActionsFacetImpl",
		artifact: "contracts/core/facets/PartyBPositionActions/PartyBPositionActionsFacetImpl.sol:PartyBPositionActionsFacetImpl",
		libraries: ["LibQuoteFunding"],
		linkReference: "project/contracts/core/facets/PartyBPositionActions/PartyBPositionActionsFacetImpl.sol:PartyBPositionActionsFacetImpl",
	},
	ClearingHouseFacetImpl: {
		name: "ClearingHouseFacetImpl",
		artifact: "contracts/core/facets/ClearingHouse/ClearingHouseFacetImpl.sol:ClearingHouseFacetImpl",
		libraries: ["LibQuoteClose", "LibQuoteFunding"],
		linkReference: "project/contracts/core/facets/ClearingHouse/ClearingHouseFacetImpl.sol:ClearingHouseFacetImpl",
	},
	LibForceActions: {
		name: "LibForceActions",
		artifact: "contracts/core/libraries/LibForceActions.sol:LibForceActions",
		libraries: ["LibQuoteClose"],
		linkReference: "project/contracts/core/libraries/LibForceActions.sol:LibForceActions",
	},
	LibSettlement: {
		name: "LibSettlement",
		artifact: "contracts/core/libraries/LibSettlement.sol:LibSettlement",
		libraries: [],
		linkReference: "project/contracts/core/libraries/LibSettlement.sol:LibSettlement",
	},
	LibPartyALiquidationProcess: {
		name: "LibPartyALiquidationProcess",
		artifact: "contracts/core/libraries/liquidation/LibPartyALiquidationProcess.sol:LibPartyALiquidationProcess",
		libraries: ["LibQuoteFunding"],
		linkReference: "project/contracts/core/libraries/liquidation/LibPartyALiquidationProcess.sol:LibPartyALiquidationProcess",
	},
	LibPartyALiquidationSnapshotSetup: {
		name: "LibPartyALiquidationSnapshotSetup",
		artifact: "contracts/core/libraries/liquidation/LibPartyALiquidationSnapshotSetup.sol:LibPartyALiquidationSnapshotSetup",
		libraries: [],
		linkReference: "project/contracts/core/libraries/liquidation/LibPartyALiquidationSnapshotSetup.sol:LibPartyALiquidationSnapshotSetup",
	},
	LibPartyALiquidationLegacySetup: {
		name: "LibPartyALiquidationLegacySetup",
		artifact: "contracts/core/libraries/liquidation/LibPartyALiquidationLegacySetup.sol:LibPartyALiquidationLegacySetup",
		libraries: [],
		linkReference: "project/contracts/core/libraries/liquidation/LibPartyALiquidationLegacySetup.sol:LibPartyALiquidationLegacySetup",
	},
}

const ACCOUNT_LAYER_LIBRARY_SPECS: Record<string, DeploymentSpec> = {
	LibQuoteParams: {
		name: "LibQuoteParams",
		artifact: "contracts/accountLayer/libraries/LibQuoteParams.sol:LibQuoteParams",
		libraries: [],
		linkReference: "project/contracts/accountLayer/libraries/LibQuoteParams.sol:LibQuoteParams",
	},
}

const CORE_FACET_LIBRARIES: Record<string, string[]> = {
	PartyAFacet: ["LibQuoteClose"],
	PartyBPositionActionsFacet: ["PartyBPositionActionsFacetImpl", "LibQuoteClose"],
	PartyBBatchActionsFacet: ["LibQuoteClose", "LibQuoteFunding"],
	PartyBEmergencyActionsFacet: ["LibQuoteClose"],
	PartyBQuoteActionsFacet: ["LibQuoteClose"],
	ForceActionsFacet: ["LibForceActions", "LibSettlement"],
	ForceCloseStepsFacet: ["LibForceActions", "LibSettlement"],
	ViewFacetQuote: ["LibQuoteFunding"],
	FundingRateFacet: ["LibQuoteFunding"],
	PartyALiquidationFacet: ["LibPartyALiquidationLegacySetup", "LibPartyALiquidationProcess"],
	PartyALiquidationSnapshotFacet: ["LibPartyALiquidationSnapshotSetup", "LibPartyALiquidationProcess"],
	ClearingHouseFacet: ["ClearingHouseFacetImpl"],
	SettlementFacet: ["LibSettlement"],
	SymbolAdjustmentFacet: ["LibQuoteFunding", "LibQuoteClose"],
}

const CORE_FACET_ARTIFACT_OVERRIDES: Record<string, string> = {
	PartyAFacet: "contracts/core/facets/PartyA/PartyAFacet.sol:PartyAFacet",
	PartyBPositionActionsFacet: "contracts/core/facets/PartyBPositionActions/PartyBPositionActionsFacet.sol:PartyBPositionActionsFacet",
	PartyBBatchActionsFacet: "contracts/core/facets/PartyBBatchActions/PartyBBatchActionsFacet.sol:PartyBBatchActionsFacet",
	PartyBEmergencyActionsFacet: "contracts/core/facets/PartyBEmergencyActions/PartyBEmergencyActionsFacet.sol:PartyBEmergencyActionsFacet",
	PartyBQuoteActionsFacet: "contracts/core/facets/PartyBQuoteActions/PartyBQuoteActionsFacet.sol:PartyBQuoteActionsFacet",
	ForceActionsFacet: "contracts/core/facets/ForceActions/ForceActionsFacet.sol:ForceActionsFacet",
	ForceCloseStepsFacet: "contracts/core/facets/ForceCloseSteps/ForceCloseStepsFacet.sol:ForceCloseStepsFacet",
	ViewFacetQuote: "contracts/core/facets/ViewFacetQuote/ViewFacetQuote.sol:ViewFacetQuote",
	FundingRateFacet: "contracts/core/facets/FundingRate/FundingRateFacet.sol:FundingRateFacet",
	PartyALiquidationFacet: "contracts/core/facets/PartyALiquidation/PartyALiquidationFacet.sol:PartyALiquidationFacet",
	PartyALiquidationSnapshotFacet: "contracts/core/facets/PartyALiquidationSnapshot/PartyALiquidationSnapshotFacet.sol:PartyALiquidationSnapshotFacet",
	ClearingHouseFacet: "contracts/core/facets/ClearingHouse/ClearingHouseFacet.sol:ClearingHouseFacet",
	SettlementFacet: "contracts/core/facets/Settlement/SettlementFacet.sol:SettlementFacet",
	SymbolAdjustmentFacet: "contracts/core/facets/SymbolAdjustment/SymbolAdjustmentFacet.sol:SymbolAdjustmentFacet",
}

export const AccountLayerFacetNames = [
	"CoreFacet",
	"MarginFacet",
	"SymmioHookFacet",
	"ControlFacet",
	"ViewFacet",
	"AffiliateFacet",
	"DiamondLoupeFacet",
] as const

const ACCOUNT_LAYER_FACET_ARTIFACTS: Record<(typeof AccountLayerFacetNames)[number], string> = {
	CoreFacet: "contracts/accountLayer/facets/Core/CoreFacet.sol:CoreFacet",
	MarginFacet: "contracts/accountLayer/facets/Margin/MarginFacet.sol:MarginFacet",
	SymmioHookFacet: "contracts/accountLayer/facets/SymmioHook/SymmioHookFacet.sol:SymmioHookFacet",
	ControlFacet: "contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet",
	ViewFacet: "contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet",
	AffiliateFacet: "contracts/accountLayer/facets/Affiliate/AffiliateFacet.sol:AffiliateFacet",
	DiamondLoupeFacet: "DiamondLoupeFacet",
}

function shortName(artifact: string): string {
	return artifact.includes(":") ? artifact.split(":").pop()! : artifact
}

export const CoreFacetSpecs: Record<string, DeploymentSpec> = Object.fromEntries(
	FacetNames.map(artifact => {
		const name = shortName(artifact)
		return [name, { name, artifact: CORE_FACET_ARTIFACT_OVERRIDES[name] ?? artifact, libraries: CORE_FACET_LIBRARIES[name] ?? [] }]
	}),
)

export const AccountLayerFacetSpecs: Record<string, DeploymentSpec> = Object.fromEntries(
	AccountLayerFacetNames.map(name => [
		name,
		{
			name,
			artifact: ACCOUNT_LAYER_FACET_ARTIFACTS[name],
			libraries: name === "CoreFacet" ? ["LibQuoteParams"] : [],
		},
	]),
)

export const LibrarySpecs: Record<DiamondScope, Record<string, DeploymentSpec>> = {
	core: CORE_LIBRARY_SPECS,
	accountLayer: ACCOUNT_LAYER_LIBRARY_SPECS,
}

export const FacetSpecs: Record<DiamondScope, Record<string, DeploymentSpec>> = {
	core: CoreFacetSpecs,
	accountLayer: AccountLayerFacetSpecs,
}

export function getFacetSpec(scope: DiamondScope, name: string): DeploymentSpec {
	const spec = FacetSpecs[scope][shortName(name)]
	if (!spec) throw new Error(`Unknown ${scope} facet: ${name}`)
	return spec
}

export function getLibrarySpec(scope: DiamondScope, name: string): DeploymentSpec {
	const spec = LibrarySpecs[scope][name]
	if (!spec) throw new Error(`Unknown ${scope} library: ${name}`)
	return spec
}

export function getLibraryLinkReferences(scope: DiamondScope): Record<string, string> {
	return Object.fromEntries(
		Object.values(LibrarySpecs[scope]).map(spec => {
			if (!spec.linkReference) throw new Error(`Library ${spec.name} is missing its link reference`)
			return [spec.name, spec.linkReference]
		}),
	)
}

export function getFacetLibraryDependencies(scope: DiamondScope): Record<string, string[]> {
	return Object.fromEntries(
		Object.values(FacetSpecs[scope])
			.filter(spec => spec.libraries.length > 0)
			.map(spec => [spec.name, spec.libraries]),
	)
}

function dependencyClosure(scope: DiamondScope, roots: string[]): string[] {
	const ordered: string[] = []
	const visiting = new Set<string>()
	const visited = new Set<string>()

	const visit = (name: string) => {
		if (visited.has(name)) return
		if (visiting.has(name)) throw new Error(`Circular ${scope} library dependency at ${name}`)
		visiting.add(name)
		const spec = getLibrarySpec(scope, name)
		for (const dependency of spec.libraries) visit(dependency)
		visiting.delete(name)
		visited.add(name)
		ordered.push(name)
	}

	for (const root of roots) visit(root)
	return ordered
}

export function requiredLibraryOrder(scope: DiamondScope, roots?: string[]): string[] {
	return dependencyClosure(scope, roots ?? Object.keys(LibrarySpecs[scope]))
}

export function linkedLibrariesFor(scope: DiamondScope, spec: DeploymentSpec, addresses: Record<string, string>): Record<string, string> {
	const linked: Record<string, string> = {}
	for (const name of spec.libraries) {
		const address = addresses[name]
		if (!address) throw new Error(`${spec.name} requires ${scope} library ${name}, but no deployed address was provided`)
		const dependency = getLibrarySpec(scope, name)
		if (!dependency.linkReference) throw new Error(`${scope} library ${name} has no link reference`)
		linked[dependency.linkReference] = address
	}
	return linked
}

export async function getLinkedContractFactory(
	ethers: EthersLike,
	scope: DiamondScope,
	spec: DeploymentSpec,
	addresses: Record<string, string>,
): Promise<any> {
	if (spec.libraries.length === 0) return ethers.getContractFactory(spec.artifact)
	return ethers.getContractFactory(spec.artifact, { libraries: linkedLibrariesFor(scope, spec, addresses) })
}

export async function ensureLibraries({
	ethers,
	scope,
	requiredLibraries,
	existing = {},
	onDeployed,
	onReused,
}: EnsureLibrariesArgs): Promise<Record<string, string>> {
	const addresses = { ...existing }
	for (const name of requiredLibraryOrder(scope, requiredLibraries)) {
		if (addresses[name]) {
			await onReused?.(name, addresses[name])
			continue
		}
		const spec = getLibrarySpec(scope, name)
		const factory = await getLinkedContractFactory(ethers, scope, spec, addresses)
		const contract = await factory.deploy()
		await contract.waitForDeployment()
		const address = await contract.getAddress()
		addresses[name] = address
		await onDeployed?.(name, address, contract)
	}
	return addresses
}
