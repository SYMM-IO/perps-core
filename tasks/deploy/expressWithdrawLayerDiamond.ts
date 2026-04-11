import type { HardhatRuntimeEnvironment } from "hardhat/types/hre"
import type { NetworkConnection } from "hardhat/types/network"

import { FacetCutAction, getSelectors } from "../utils/diamondCut.js"

export interface DeployExpressOptions {
	admin: string
	symmio: string
	collateral: string
}

/**
 * Deploy the ExpressProvider diamond with all facets.
 */
export async function deployExpressProvider(hre: HardhatRuntimeEnvironment, connection: NetworkConnection, opts: DeployExpressOptions) {
	const { ethers } = connection

	// 1. Deploy DiamondCutFacet
	const diamondCutFacet = await (await ethers.getContractFactory("DiamondCutFacet")).deploy()

	// 2. Deploy Diamond proxy
	const diamond = await (await ethers.getContractFactory("Diamond")).deploy(opts.admin, await diamondCutFacet.getAddress())
	const diamondAddress = await diamond.getAddress()

	// 3. Deploy all facets (use fully qualified names for ambiguous contracts)
	const facetNames = [
		"DiamondLoupeFacet",
		"contracts/expressWithdrawLayer/facets/Control/ControlFacet.sol:ControlFacet",
		"contracts/expressWithdrawLayer/facets/SymmioHook/SymmioHookFacet.sol:SymmioHookFacet",
		"contracts/expressWithdrawLayer/facets/Operator/OperatorFacet.sol:OperatorFacet",
		"contracts/expressWithdrawLayer/facets/Accelerate/AccelerateFacet.sol:AccelerateFacet",
		"contracts/expressWithdrawLayer/facets/View/ViewFacet.sol:ViewFacet",
	]
	const cuts = []
	const factories = []

	for (const name of facetNames) {
		const factory = await ethers.getContractFactory(name)
		const facet = await factory.deploy()
		cuts.push({
			facetAddress: await facet.getAddress(),
			action: FacetCutAction.Add,
			functionSelectors: getSelectors(ethers, facet).selectors,
		})
		factories.push(factory)
	}

	// 4. Deploy Init contract
	const initContract = await (await ethers.getContractFactory("contracts/expressWithdrawLayer/Init.sol:Init")).deploy()
	const initCalldata = initContract.interface.encodeFunctionData("init", [opts.admin, opts.symmio, opts.collateral])

	// 5. Execute diamond cut with all facets + init
	const diamondCut = await ethers.getContractAt("DiamondCutFacet", diamondAddress)
	await diamondCut.diamondCut(cuts, await initContract.getAddress(), initCalldata)

	// Return a contract instance with all facet ABIs combined
	const allAbis = [...factories.flatMap(f => f.interface.fragments), ...(await ethers.getContractFactory("DiamondCutFacet")).interface.fragments]
	return ethers.getContractAt(allAbis, diamondAddress)
}
