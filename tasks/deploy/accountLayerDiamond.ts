import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import { ContractTransactionReceipt } from "ethers"

import { FacetCutAction, getSelectors } from "../utils/diamondCut.js"
import { getConnection } from "./helpers.js"
import { logger } from "./logger.js"

const AccountLayerFacetNames = [
	"CoreFacet",
	"MarginFacet",
	"SymmioHookFacet",
	"ControlFacet",
	"ViewFacet",
	"AffiliateFacet",
]

// Library dependencies for AccountLayer facets
const AccountLayerFacetLibraryDependencies: Record<string, string[]> = {
	CoreFacet: ["LibQuoteParams"],
}

type DeployAccountLayerDiamondArgs = {
	admin: HardhatEthersSigner
	symmioFeeReceiver: HardhatEthersSigner
	logData?: boolean
}

export async function deployAccountLayerDiamond(
	hre: any,
	{ admin, symmioFeeReceiver, logData = false }: DeployAccountLayerDiamondArgs
) {
	const { ethers } = await getConnection(hre)
	let totalGasUsed = BigInt(0)
	let receipt: ContractTransactionReceipt

	logger.section("AccountLayer Diamond Deployment")

	// Deploy DiamondCutFacet
	logger.subsection("Core Contracts")
	const DiamondCutFacetFactory = await ethers.getContractFactory("DiamondCutFacet")
	const diamondCutFacet = await DiamondCutFacetFactory.deploy()
	await diamondCutFacet.waitForDeployment()
	receipt = (await diamondCutFacet.deploymentTransaction()!.wait())!
	totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
	logger.deployed("DiamondCutFacet", await diamondCutFacet.getAddress())

	// Deploy Diamond
	const DiamondFactory = await ethers.getContractFactory("Diamond")
	const diamond = await DiamondFactory.deploy(admin.address, await diamondCutFacet.getAddress())
	await diamond.waitForDeployment()
	receipt = (await diamond.deploymentTransaction()!.wait())!
	totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
	const diamondAddress = await diamond.getAddress()
	logger.deployed("AccountLayerDiamond", diamondAddress)

	// Deploy AccountLayerInit
	const AccountLayerInitFactory = await ethers.getContractFactory("AccountLayerInit")
	const accountLayerInit = await AccountLayerInitFactory.deploy()
	await accountLayerInit.waitForDeployment()
	receipt = (await accountLayerInit.deploymentTransaction()!.wait())!
	totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
	logger.deployed("AccountLayerInit", await accountLayerInit.getAddress())

	// Deploy external libraries
	logger.subsection("Libraries")
	const libraryAddresses: Record<string, string> = {}

	// Deploy LibQuoteParams
	const LibQuoteParamsFactory = await ethers.getContractFactory("contracts/accountLayer/libraries/LibQuoteParams.sol:LibQuoteParams")
	const libQuoteParams = await LibQuoteParamsFactory.deploy()
	await libQuoteParams.waitForDeployment()
	receipt = (await libQuoteParams.deploymentTransaction()!.wait())!
	totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
	libraryAddresses["LibQuoteParams"] = await libQuoteParams.getAddress()
	logger.deployed("LibQuoteParams", libraryAddresses["LibQuoteParams"])

	// Get AccountManager bytecode
	const AccountManagerFactory = await ethers.getContractFactory("contracts/accountLayer/AccountManager.sol:AccountManager")
	const accountManagerBytecode = AccountManagerFactory.bytecode

	// Deploy Facets
	const cut: Array<{
		facetAddress: string
		action: FacetCutAction
		functionSelectors: string[]
	}> = []

	const deployedFacets: Array<{
		name: string
		address: string
	}> = []

	logger.subsection(`Facets (${AccountLayerFacetNames.length} total)`)
	for (let i = 0; i < AccountLayerFacetNames.length; i++) {
		const facetName = AccountLayerFacetNames[i]
		const requiredLibraries = AccountLayerFacetLibraryDependencies[facetName]
		let FacetFactory

		if (requiredLibraries && requiredLibraries.length > 0) {
			const libraries: Record<string, string> = {}
			for (const lib of requiredLibraries) {
				libraries[`project/contracts/accountLayer/libraries/${lib}.sol:${lib}`] = libraryAddresses[lib]
			}
			FacetFactory = await ethers.getContractFactory(`contracts/accountLayer/facets/${facetName.replace("Facet", "")}/${facetName}.sol:${facetName}`, { libraries })
		} else {
			// Map facet names to their paths
			const facetPathMap: Record<string, string> = {
				CoreFacet: "Core",
				MarginFacet: "Margin",
				SymmioHookFacet: "SymmioHook",
				ControlFacet: "Control",
				ViewFacet: "View",
				AffiliateFacet: "Affiliate",
			}
			const path = facetPathMap[facetName]
			FacetFactory = await ethers.getContractFactory(`contracts/accountLayer/facets/${path}/${facetName}.sol:${facetName}`)
		}

		const facet = await FacetFactory.deploy()
		await facet.waitForDeployment()
		receipt = (await facet.deploymentTransaction()!.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
		const facetAddress = await facet.getAddress()
		logger.progress(i + 1, AccountLayerFacetNames.length, facetName)
		cut.push({
			facetAddress,
			action: FacetCutAction.Add,
			functionSelectors: getSelectors(ethers, facet as any).selectors,
		})

		deployedFacets.push({
			name: facetName,
			address: facetAddress,
		})
	}

	// Upgrade Diamond with Facets
	logger.subsection("Diamond Cut")
	const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress)

	// Call Initializer with params
	const call = accountLayerInit.interface.encodeFunctionData("init", [
		admin.address,
		symmioFeeReceiver.address,
		accountManagerBytecode,
	])

	const chunkSize = 3
	const totalChunks = Math.ceil(cut.length / chunkSize)
	for (let i = 0; i < cut.length; i += chunkSize) {
		const chunk = cut.slice(i, i + chunkSize)
		const chunkNum = Math.floor(i / chunkSize) + 1
		const isFirst = i === 0
		const initTarget = isFirst ? await accountLayerInit.getAddress() : ethers.ZeroAddress
		const initCalldata = isFirst ? call : "0x"
		const tx = await diamondCut.diamondCut(chunk, initTarget, initCalldata)
		receipt = (await tx.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())

		if (!receipt.status) {
			throw Error(`Diamond upgrade failed: ${tx.hash}`)
		}
		logger.progress(chunkNum, totalChunks, `Chunk ${chunkNum} (${chunk.length} facets)`)
	}

	logger.complete("AccountLayer Diamond Deployment", [
		{ name: "AccountLayerDiamond", address: diamondAddress },
		{ name: "DiamondCutFacet", address: await diamondCutFacet.getAddress() },
		{ name: "AccountLayerInit", address: await accountLayerInit.getAddress() },
	])

	return {
		diamond: diamondAddress,
		diamondCutFacet: await diamondCutFacet.getAddress(),
		accountLayerInit: await accountLayerInit.getAddress(),
		libraryAddresses,
		deployedFacets,
	}
}

export const accountLayerDiamondTask = task("deploy:accountLayer", "Deploys the AccountLayer diamond (unified AccountHub + AffiliateHub)")
	.addOption({ name: "logData", description: "Log deployment data to file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ logData }, hre) => {
			const { ethers } = await getConnection(hre)
			const [deployer] = await ethers.getSigners()

			console.log("Deploying AccountLayer Diamond...")
			console.log(`Deployer: ${deployer.address}`)

			const result = await deployAccountLayerDiamond(hre, {
				admin: deployer,
				symmioFeeReceiver: deployer,
				logData,
			})

			console.log("\nAccountLayer Diamond deployed successfully!")
			console.log(`Diamond Address: ${result.diamond}`)

			return result
		},
	}))
	.build()
