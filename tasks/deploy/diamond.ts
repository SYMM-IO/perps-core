import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { ContractTransactionReceipt } from "ethers"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { FacetCutAction, getSelectors } from "../utils/diamondCut.js"
import { writeData } from "../utils/fs.js"
import { DEPLOYMENT_LOG_FILE, FacetNames } from "./constants.js"
import { getConnection } from "./helpers.js"
import { logger } from "./logger.js"

// Define which facets need which external libraries (based on compiled artifacts)
const FacetLibraryDependencies: Record<string, string[]> = {
	PartyAFacet: ["LibQuoteClose"],
	PartyBPositionActionsFacet: ["LibQuoteClose", "LibQuoteFunding"],
	PartyBBatchActionsFacet: ["LibQuoteClose", "LibQuoteFunding"],
	ADLFacet: ["LibQuoteClose", "LibQuoteFunding"],
	PartyBQuoteActionsFacet: ["LibQuoteClose"],
	ForceActionsFacet: ["LibQuoteClose", "LibSettlement"],
	ForceActionsMasterAccountFacet: ["LibQuoteClose", "LibSettlement"],
	ViewFacetSymbol: ["LibQuoteFunding"],
	FundingRateFacet: ["LibQuoteFunding"],
	LiquidationFacet: ["LibQuoteFunding"],
	SettlementFacet: ["LibSettlement"],
}

type DeployDiamondArgs = {
	genABI?: boolean
	logData?: boolean
	reportGas?: boolean
}

export async function deployDiamond(hre: any, { logData = true, genABI = false, reportGas = true }: DeployDiamondArgs = {}) {
	const { ethers } = await getConnection(hre)
	const signers: HardhatEthersSigner[] = await ethers.getSigners()
	const owner: HardhatEthersSigner = signers[0]
	let totalGasUsed = BigInt(0)
	let receipt: ContractTransactionReceipt

	logger.section("Diamond Deployment")

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
	const diamond = await DiamondFactory.deploy(owner.address, await diamondCutFacet.getAddress())
	await diamond.waitForDeployment()
	receipt = (await diamond.deploymentTransaction()!.wait())!
	totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
	logger.deployed("Diamond", await diamond.getAddress())

	// Deploy DiamondInit
	const DiamondInit = await ethers.getContractFactory("DiamondInit")
	const diamondInit = await DiamondInit.deploy()
	await diamondInit.waitForDeployment()
	receipt = (await diamondInit.deploymentTransaction()!.wait())!
	totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
	logger.deployed("DiamondInit", await diamondInit.getAddress())

	// Deploy external libraries first
	logger.subsection("Libraries")
	const libraryAddresses: Record<string, string> = {}

	// Deploy LibQuoteFunding first (no dependencies)
	const LibQuoteFundingFactory = await ethers.getContractFactory("LibQuoteFunding")
	const libQuoteFunding = await LibQuoteFundingFactory.deploy()
	await libQuoteFunding.waitForDeployment()
	receipt = (await libQuoteFunding.deploymentTransaction()!.wait())!
	totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
	libraryAddresses["LibQuoteFunding"] = await libQuoteFunding.getAddress()
	logger.deployed("LibQuoteFunding", libraryAddresses["LibQuoteFunding"])

	// Deploy LibQuoteClose (depends on LibQuoteFunding)
	const LibQuoteCloseFactory = await ethers.getContractFactory("LibQuoteClose", {
		libraries: {
			"project/contracts/libraries/LibQuoteFunding.sol:LibQuoteFunding": libraryAddresses["LibQuoteFunding"],
		},
	})
	const libQuoteClose = await LibQuoteCloseFactory.deploy()
	await libQuoteClose.waitForDeployment()
	receipt = (await libQuoteClose.deploymentTransaction()!.wait())!
	totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
	libraryAddresses["LibQuoteClose"] = await libQuoteClose.getAddress()
	logger.deployed("LibQuoteClose", libraryAddresses["LibQuoteClose"])

	// Deploy LibSettlement (no dependencies)
	const LibSettlementFactory = await ethers.getContractFactory("LibSettlement")
	const libSettlement = await LibSettlementFactory.deploy()
	await libSettlement.waitForDeployment()
	receipt = (await libSettlement.deploymentTransaction()!.wait())!
	totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
	libraryAddresses["LibSettlement"] = await libSettlement.getAddress()
	logger.deployed("LibSettlement", libraryAddresses["LibSettlement"])

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

	logger.subsection(`Facets (${FacetNames.length} total)`)
	for (let i = 0; i < FacetNames.length; i++) {
		const facetName = FacetNames[i]
		// Check if this facet needs library linking
		const requiredLibraries = FacetLibraryDependencies[facetName]
		let FacetFactory

		if (requiredLibraries && requiredLibraries.length > 0) {
			const libraries: Record<string, string> = {}
			for (const lib of requiredLibraries) {
				libraries[`project/contracts/libraries/${lib}.sol:${lib}`] = libraryAddresses[lib]
			}
			FacetFactory = await ethers.getContractFactory(facetName, { libraries })
		} else {
			FacetFactory = await ethers.getContractFactory(facetName)
		}

		const facet = await FacetFactory.deploy()
		await facet.waitForDeployment()
		receipt = (await facet.deploymentTransaction()!.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
		const facetAddress = await facet.getAddress()
		logger.progress(i + 1, FacetNames.length, facetName)
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
	const diamondCut = await ethers.getContractAt("IDiamondCut", await diamond.getAddress())

	// Call Initializer
	const call = diamondInit.interface.encodeFunctionData("init")
	const chunkSize = 6
	const totalChunks = Math.ceil(cut.length / chunkSize)
	for (let i = 0; i < cut.length; i += chunkSize) {
		const chunk = cut.slice(i, i + chunkSize)
		const chunkNum = Math.floor(i / chunkSize) + 1
		const isFirst = i === 0
		const initTarget = isFirst ? await diamondInit.getAddress() : ethers.ZeroAddress
		const initCalldata = isFirst ? call : "0x"
		const tx = await diamondCut.diamondCut(chunk, initTarget, initCalldata)
		receipt = (await tx.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())

		if (!receipt.status) {
			throw Error(`Diamond upgrade failed: ${tx.hash}`)
		}
		logger.progress(chunkNum, totalChunks, `Chunk ${chunkNum} (${chunk.length} facets)`)
	}

	logger.complete("Diamond Deployment", [
		{ name: "Diamond", address: await diamond.getAddress() },
		{ name: "DiamondCutFacet", address: await diamondCutFacet.getAddress() },
		{ name: "DiamondInit", address: await diamondInit.getAddress() },
	])

	// if (reportGas) { //FIXME
	// 	await generateGasReport(ethers.provider as any, totalGasUsed)
	// }

	// Write addresses to JSON file for etherscan verification
	if (logData) {
		writeData(DEPLOYMENT_LOG_FILE, [
			{
				name: "DiamondCut",
				address: await diamondCutFacet.getAddress(),
				constructorArguments: [],
			},
			{
				name: "Diamond",
				address: await diamond.getAddress(),
				constructorArguments: [owner.address, await diamondCutFacet.getAddress()],
			},
			{
				name: "DiamondInit",
				address: await diamondInit.getAddress(),
				constructorArguments: [],
			},
			{
				name: "LibQuoteClose",
				address: libraryAddresses["LibQuoteClose"],
				constructorArguments: [],
			},
			{
				name: "LibQuoteFunding",
				address: libraryAddresses["LibQuoteFunding"],
				constructorArguments: [],
			},
			{
				name: "LibSettlement",
				address: libraryAddresses["LibSettlement"],
				constructorArguments: [],
			},
			...deployedFacets.map(facet => ({
				name: facet.name,
				address: facet.address,
				constructorArguments: [],
			})),
		])
	}

	return diamond
}

export const diamondTask = task("deploy:diamond", "Deploys the Diamond contract")
	.addOption({ name: "genABI", description: "Generate ABI artifacts", type: ArgumentType.BOOLEAN, defaultValue: false })
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.addOption({ name: "reportGas", description: "Report gas consumption and costs", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ logData, genABI, reportGas }, hre) => {
			return deployDiamond(hre, { logData, genABI, reportGas })
		},
	}))
	.build()
