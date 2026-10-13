import { Contract, ContractTransactionResponse, Fragment, Signer } from "ethers"

import { FacetCutAction, getSelectors } from "../../tasks/utils/diamondCut.js"

/**
 * Test scaffold for the InstantLayer diamond. Every later facet task extends it by passing one
 * more name in facetNames, so read these three preconditions before assuming that is enough.
 *
 * 1. Facets must have no constructor arguments and no linked libraries. Each one is deployed
 *    with a bare `getContractFactory(fqn).deploy()`. A facet that needs external libraries has
 *    to go through `getLinkedContractFactory` (see tasks/deploy/accountLayerDiamond.ts), and
 *    that is a change to this file, not just to the caller's facetNames.
 *
 * 2. Custom errors thrown from a shared library must be declared on an interface the facet
 *    inherits, as IInstantLayerErrors is today. The merged ABI below is assembled from facet
 *    fragments only; a library's own error declarations never reach it, and
 *    `revertedWithCustomError` is blind to anything missing from it.
 *
 * 3. Facets must live at contracts/instantLayer/facets/<Group>/<Name>.sol, where <Group> is the
 *    facet name without its "Facet" suffix. Anything else needs facetArtifactName widened.
 */

const INIT_FQN = "contracts/instantLayer/Init.sol:Init"

function facetArtifactName(facetName: string): string {
	const group = facetName.replace(/Facet$/, "")
	return `contracts/instantLayer/facets/${group}/${facetName}.sol:${facetName}`
}

export type InstantLayerDiamondDeployment = {
	/** The diamond, attached to the union of every cut facet's ABI (functions, events, errors). */
	diamond: Contract
	/** The diamond's address. */
	address: string
	/** Address of the deployed Init contract, for re-calling init directly. */
	initAddress: string
	/** Address of the DiamondCutFacet, for later cuts. */
	diamondCutFacetAddress: string
	/** Deployed address of each facet, keyed by the name passed in facetNames. */
	facetAddresses: Record<string, string>
	/** The diamondCut transaction that installed the facets and ran Init, so a test can assert on the events init emitted. */
	cutTx: ContractTransactionResponse
}

type FacetDeployment = {
	name: string
	address: string
	fragments: readonly Fragment[]
	selectors: string[]
}

/**
 * Deploys a fresh InstantLayer diamond: DiamondCutFacet, Diamond(admin, cutFacet), Init, then a
 * single diamondCut installing DiamondLoupeFacet plus every named InstantLayer facet with
 * Init.init(symmio, admin) as the cut's initializer.
 */
export async function deployInstantLayerDiamondForTest(
	ethers: any,
	admin: Signer,
	symmio: string,
	facetNames: string[],
): Promise<InstantLayerDiamondDeployment> {
	const adminAddress = await admin.getAddress()

	const DiamondCutFacetFactory = await ethers.getContractFactory("DiamondCutFacet")
	const diamondCutFacet = await DiamondCutFacetFactory.connect(admin).deploy()
	await diamondCutFacet.waitForDeployment()
	const diamondCutFacetAddress = await diamondCutFacet.getAddress()

	const DiamondFactory = await ethers.getContractFactory("Diamond")
	const diamond = await DiamondFactory.connect(admin).deploy(adminAddress, diamondCutFacetAddress)
	await diamond.waitForDeployment()
	const diamondAddress = await diamond.getAddress()

	const InitFactory = await ethers.getContractFactory(INIT_FQN)
	const init = await InitFactory.connect(admin).deploy()
	await init.waitForDeployment()
	const initAddress = await init.getAddress()

	const deployments: FacetDeployment[] = []
	for (const artifactName of ["DiamondLoupeFacet", ...facetNames.map(facetArtifactName)]) {
		const factory = await ethers.getContractFactory(artifactName)
		const facet = await factory.connect(admin).deploy()
		await facet.waitForDeployment()
		deployments.push({
			name: artifactName,
			address: await facet.getAddress(),
			fragments: factory.interface.fragments,
			selectors: getSelectors(ethers, facet).selectors,
		})
	}

	const cut = deployments.map(facet => ({
		facetAddress: facet.address,
		action: FacetCutAction.Add,
		functionSelectors: facet.selectors,
	}))

	const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress)
	const initCall = init.interface.encodeFunctionData("init", [symmio, adminAddress])
	const cutTx: ContractTransactionResponse = await diamondCut.connect(admin).diamondCut(cut, initAddress, initCall)
	await cutTx.wait()

	// The attached contract carries every cut facet's fragments plus the cut facet's own, so a
	// test can call any installed function and decode any event or custom error the facets
	// declare. Duplicates (shared errors, shared events) collapse to their first definition.
	const seen = new Set<string>()
	const fragments: Fragment[] = []
	for (const source of [diamondCutFacet.interface.fragments, ...deployments.map(facet => facet.fragments)]) {
		for (const fragment of source) {
			if (fragment.type === "constructor" || fragment.type === "fallback" || fragment.type === "receive") continue
			const key = `${fragment.type}:${fragment.format("sighash")}`
			if (seen.has(key)) continue
			seen.add(key)
			fragments.push(fragment)
		}
	}

	const facetAddresses: Record<string, string> = {}
	for (let i = 0; i < facetNames.length; i++) {
		// deployments[0] is the loupe; the named facets follow in the order they were passed.
		facetAddresses[facetNames[i]] = deployments[i + 1].address
	}

	return {
		diamond: new ethers.Contract(diamondAddress, fragments, admin),
		address: diamondAddress,
		initAddress,
		diamondCutFacetAddress,
		facetAddresses,
		cutTx,
	}
}
