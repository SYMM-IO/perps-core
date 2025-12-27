import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { ContractTransactionReceipt } from "ethers"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { FacetCutAction, getSelectors } from "../utils/diamondCut.js"
import { writeData } from "../utils/fs.js"
import { DEPLOYMENT_LOG_FILE, FacetNames } from "./constants.js"
import { getConnection } from "./helpers.js"

// Define which facets need which external libraries (based on compiled artifacts)
const FacetLibraryDependencies: Record<string, string[]> = {
	PartyAFacet: ["LibQuoteClose"],
	PartyBPositionActionsFacet: ["LibQuoteClose", "LibQuoteFunding"],
	PartyBBatchActionsFacet: ["LibQuoteClose", "LibQuoteFunding"],
	PartyBQuoteActionsFacet: ["LibQuoteClose"],
	ForceActionsFacet: ["LibQuoteClose"],
	ViewFacetSymbol: ["LibQuoteFunding"],
	FundingRateFacet: ["LibQuoteFunding"],
	LiquidationFacet: ["LibQuoteFunding"],
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

	// Deploy DiamondCutFacet
	const DiamondCutFacetFactory = await ethers.getContractFactory("DiamondCutFacet")
	const diamondCutFacet = await DiamondCutFacetFactory.deploy()
	await diamondCutFacet.waitForDeployment()
	receipt = (await diamondCutFacet.deploymentTransaction()!.wait())!
	totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
	console.log("DiamondCutFacet deployed:", await diamondCutFacet.getAddress())

	// Deploy Diamond
	const DiamondFactory = await ethers.getContractFactory("Diamond")
	const diamond = await DiamondFactory.deploy(owner.address, await diamondCutFacet.getAddress())
	await diamond.waitForDeployment()
	receipt = (await diamond.deploymentTransaction()!.wait())!
	totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
	console.log("Diamond deployed:", await diamond.getAddress())

	// Deploy DiamondInit
	const DiamondInit = await ethers.getContractFactory("DiamondInit")
	const diamondInit = await DiamondInit.deploy()
	await diamondInit.waitForDeployment()
	receipt = (await diamondInit.deploymentTransaction()!.wait())!
	totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
	console.log("DiamondInit deployed:", await diamondInit.getAddress())

	// Deploy external libraries first
	const libraryAddresses: Record<string, string> = {}

	// Deploy LibQuoteFunding first (no dependencies)
	const LibQuoteFundingFactory = await ethers.getContractFactory("LibQuoteFunding")
	const libQuoteFunding = await LibQuoteFundingFactory.deploy()
	await libQuoteFunding.waitForDeployment()
	receipt = (await libQuoteFunding.deploymentTransaction()!.wait())!
	totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
	libraryAddresses["LibQuoteFunding"] = await libQuoteFunding.getAddress()
	console.log("LibQuoteFunding deployed:", libraryAddresses["LibQuoteFunding"])

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
	console.log("LibQuoteClose deployed:", libraryAddresses["LibQuoteClose"])

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

	console.log("Deploying facets: ", FacetNames)
	for (const facetName of FacetNames) {
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
		console.log(`${facetName} deployed: ${await facet.getAddress()}`)
		cut.push({
			facetAddress: await facet.getAddress(),
			action: FacetCutAction.Add,
			functionSelectors: getSelectors(ethers, facet as any).selectors,
		})

		deployedFacets.push({
			name: facetName,
			address: await facet.getAddress(),
		})
	}

	// Upgrade Diamond with Facets
	const diamondCut = await ethers.getContractAt("IDiamondCut", await diamond.getAddress())

	// Call Initializer
	const call = diamondInit.interface.encodeFunctionData("init")
	const chunkSize = 6
	for (let i = 0; i < cut.length; i += chunkSize) {
		const chunk = cut.slice(i, i + chunkSize)
		const isFirst = i === 0
		const initTarget = isFirst ? await diamondInit.getAddress() : ethers.ZeroAddress
		const initCalldata = isFirst ? call : "0x"
		const tx = await diamondCut.diamondCut(chunk, initTarget, initCalldata)
		receipt = (await tx.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())

		if (!receipt.status) {
			throw Error(`Diamond upgrade failed: ${tx.hash}`)
		}
	}
	console.log("Completed Diamond Cut")

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
			...deployedFacets.map(facet => ({
				name: facet.name,
				address: facet.address,
				constructorArguments: [],
			})),
		])
		console.log("Deployed addresses written to json file")
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
