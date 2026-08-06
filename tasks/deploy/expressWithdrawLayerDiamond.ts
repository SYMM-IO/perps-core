import type { HardhatRuntimeEnvironment } from "hardhat/types/hre"
import type { NetworkConnection } from "hardhat/types/network"

import { FacetCutAction, getSelectors } from "../utils/diamondCut.js"
import { assertStandaloneDeploymentTaskAllowed } from "./safety.js"

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
	const chainId = (await ethers.provider.getNetwork()).chainId
	const isSimulated = (connection as any).networkConfig?.type === "edr-simulated"
	assertStandaloneDeploymentTaskAllowed(
		"deployExpressProvider",
		chainId,
		isSimulated,
		"Post-payout credit-loss settlement and the production Express role, Muon, affiliate-policy, Core-registration, recovery, verification, and post-state workflow are not complete; use this helper only on local or simulated networks.",
	)
	const [deployer] = await ethers.getSigners()
	if (!deployer) throw new Error("ExpressProvider deployment requires a configured signer")
	const deployerAddress = ethers.getAddress(deployer.address)
	for (const [label, address] of Object.entries(opts)) {
		if (!ethers.isAddress(address) || address === ethers.ZeroAddress) throw new Error(`ExpressProvider ${label} must be a non-zero address`)
	}
	const finalAdmin = ethers.getAddress(opts.admin)
	for (const [label, address] of Object.entries({ symmio: opts.symmio, collateral: opts.collateral })) {
		if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`ExpressProvider ${label} has no contract code at ${address}`)
	}

	const confirmDeployment = async (contract: any, label: string): Promise<string> => {
		const tx = contract.deploymentTransaction()
		if (!tx) throw new Error(`${label} has no deployment transaction`)
		console.log(`  ${label} submitted: ${tx.hash} (nonce: ${tx.nonce})`)
		const receipt = await tx.wait()
		if (!receipt?.status) throw new Error(`${label} deployment failed: ${tx.hash}`)
		const address = await contract.getAddress()
		if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`${label} has no code after confirmed deployment at ${address}`)
		console.log(`  ${label} confirmed: ${address} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`)
		return address
	}

	// 1. Deploy DiamondCutFacet
	const diamondCutFacet = await (await ethers.getContractFactory("DiamondCutFacet")).deploy()
	const diamondCutFacetAddress = await confirmDeployment(diamondCutFacet, "Express DiamondCutFacet")

	// 2. Deploy Diamond proxy
	// The caller must own the bare diamond while installing facets. When governance is a
	// different account, initiate the two-step handover only after the cut is proven.
	const diamond = await (await ethers.getContractFactory("Diamond")).deploy(deployerAddress, diamondCutFacetAddress)
	const diamondAddress = await confirmDeployment(diamond, "Express Diamond")

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
		const facetAddress = await confirmDeployment(facet, `Express facet ${name.split(":").pop()}`)
		cuts.push({
			facetAddress,
			action: FacetCutAction.Add,
			functionSelectors: getSelectors(ethers, facet as any).selectors,
		})
		factories.push(factory)
	}

	// 4. Deploy Init contract
	const initContract = await (await ethers.getContractFactory("contracts/expressWithdrawLayer/Init.sol:Init")).deploy()
	const initAddress = await confirmDeployment(initContract, "Express Init")
	const initCalldata = initContract.interface.encodeFunctionData("init", [opts.admin, opts.symmio, opts.collateral])

	// 5. Execute diamond cut with all facets + init
	const diamondCut = await ethers.getContractAt("DiamondCutFacet", diamondAddress)
	await diamondCut.diamondCut.staticCall(cuts, initAddress, initCalldata)
	const cutTx = await diamondCut.diamondCut(cuts, initAddress, initCalldata)
	console.log(`  Express diamondCut submitted: ${cutTx.hash} (nonce: ${cutTx.nonce})`)
	const cutReceipt = await cutTx.wait()
	if (!cutReceipt?.status) throw new Error(`Express diamondCut failed: ${cutTx.hash}`)

	const loupe = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress)
	for (const cut of cuts) {
		for (const selector of cut.functionSelectors) {
			const installedAt = ethers.getAddress(await loupe.facetAddress(selector))
			if (installedAt !== ethers.getAddress(cut.facetAddress)) {
				throw new Error(`Express selector ${selector} maps to ${installedAt}, expected ${cut.facetAddress}`)
			}
		}
	}
	console.log(`  Express diamondCut confirmed: ${cuts.length} facets, block ${cutReceipt.blockNumber}, gas ${cutReceipt.gasUsed}`)

	if (finalAdmin !== deployerAddress) {
		const control = await ethers.getContractAt("contracts/expressWithdrawLayer/facets/Control/ControlFacet.sol:ControlFacet", diamondAddress)
		const handoverTx = await control.transferOwnership(finalAdmin)
		console.log(`  Express ownership handover submitted: ${handoverTx.hash} (nonce: ${handoverTx.nonce})`)
		const handoverReceipt = await handoverTx.wait()
		if (!handoverReceipt?.status) throw new Error(`Express ownership handover failed: ${handoverTx.hash}`)
		if (ethers.getAddress(await control.owner()) !== deployerAddress || ethers.getAddress(await control.pendingOwner()) !== finalAdmin) {
			throw new Error("Express ownership handover post-state does not match the deployer/final admin")
		}
		console.log(`  Express ownership handover pending acceptance by ${finalAdmin} (block ${handoverReceipt.blockNumber})`)
	}

	// Return a contract instance with all facet ABIs combined
	const allAbis = [...factories.flatMap(f => f.interface.fragments), ...(await ethers.getContractFactory("DiamondCutFacet")).interface.fragments]
	return ethers.getContractAt(allAbis, diamondAddress)
}
