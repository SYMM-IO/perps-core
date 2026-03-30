import type { HardhatRuntimeEnvironment } from "hardhat/types/hre"
import type { NetworkConnection } from "hardhat/types/network"

import { FacetCutAction, getSelectors } from "../utils/diamondCut.js"

export interface DeployExpressOptions {
	admin: string
	symmio: string
	collateral: string
}

export interface DeployCreditLineOptions {
	admin: string
	symmio: string
	expressProvider: string
	signatureVerifier: string
	muonAppId: bigint
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
		"contracts/expressLayer/facets/Control/ControlFacet.sol:ControlFacet",
		"contracts/expressLayer/facets/SymmioHook/SymmioHookFacet.sol:SymmioHookFacet",
		"contracts/expressLayer/facets/Operator/OperatorFacet.sol:OperatorFacet",
		"contracts/expressLayer/facets/View/ViewFacet.sol:ViewFacet",
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
	const initContract = await (await ethers.getContractFactory("contracts/expressLayer/Init.sol:Init")).deploy()
	const initCalldata = initContract.interface.encodeFunctionData("init", [opts.admin, opts.symmio, opts.collateral])

	// 5. Execute diamond cut with all facets + init
	const diamondCut = await ethers.getContractAt("DiamondCutFacet", diamondAddress)
	await diamondCut.diamondCut(cuts, await initContract.getAddress(), initCalldata)

	// Return a contract instance with all facet ABIs combined
	const allAbis = [...factories.flatMap(f => f.interface.fragments), ...(await ethers.getContractFactory("DiamondCutFacet")).interface.fragments]
	return ethers.getContractAt(allAbis, diamondAddress)
}

/**
 * Deploy CreditLineManager behind an ERC1967 proxy (UUPS pattern).
 */
export async function deployCreditLineManager(hre: HardhatRuntimeEnvironment, connection: NetworkConnection, opts: DeployCreditLineOptions) {
	const { ethers } = connection

	// Deploy implementation
	const impl = await (await ethers.getContractFactory("CreditLineManager")).deploy()
	const implAddress = await impl.getAddress()

	// Encode initializer calldata
	const initData = impl.interface.encodeFunctionData("initialize", [
		opts.admin,
		opts.symmio,
		opts.expressProvider,
		opts.signatureVerifier,
		opts.muonAppId,
	])

	// Deploy proxy pointing to implementation
	const proxy = await (await ethers.getContractFactory("LocalERC1967Proxy")).deploy(implAddress, initData)
	const proxyAddress = await proxy.getAddress()

	// Return proxy with CreditLineManager ABI
	return ethers.getContractAt("CreditLineManager", proxyAddress)
}

/**
 * Deploy the full system: ExpressProvider (Diamond) + CreditLineManager (UUPS proxy).
 */
export async function deployAll(
	hre: HardhatRuntimeEnvironment,
	connection: NetworkConnection,
	opts: {
		admin: string
		symmio: string
		collateral: string
		signatureVerifier: string
		muonAppId: bigint
	},
) {
	const diamond = await deployExpressProvider(hre, connection, opts)
	const diamondAddress = await diamond.getAddress()

	const creditLineManager = await deployCreditLineManager(hre, connection, {
		admin: opts.admin,
		symmio: opts.symmio,
		expressProvider: diamondAddress,
		signatureVerifier: opts.signatureVerifier,
		muonAppId: opts.muonAppId,
	})
	const creditLineAddress = await creditLineManager.getAddress()

	return { diamond, creditLineManager, diamondAddress, creditLineAddress }
}
