import { task } from "hardhat/config"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { ArgumentType } from "hardhat/types/arguments"

import {FacetCutAction, getSelectors} from "../utils/diamondCut"
import {writeData} from "../utils/fs"
import {generateGasReport} from "../utils/gas"
import {DEPLOYMENT_LOG_FILE, FacetNames} from "./constants"
import {SignerWithAddress} from "@nomicfoundation/hardhat-ethers/signers"
import {ContractTransactionReceipt} from "ethers"

// Define which facets need which external libraries (based on compiled artifacts)
const FacetLibraryDependencies: Record<string, string[]> = {
	"PartyAFacet": ["LibQuoteClose"],
	"PartyBPositionActionsFacet": ["LibQuoteClose", "LibQuoteFunding"],
	"PartyBBatchActionsFacet": ["LibQuoteClose", "LibQuoteFunding"],
	"PartyBQuoteActionsFacet": ["LibQuoteClose"],
	"ForceActionsFacet": ["LibQuoteClose"],
	"ViewFacetSymbol": ["LibQuoteFunding"],
	"FundingRateFacet": ["LibQuoteFunding"],
	"LiquidationFacet": ["LibQuoteFunding"]
}

function chunkArray<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = []
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size))
	}
	return chunks
}

export async function deployDiamond(
	hre: HardhatRuntimeEnvironment,
	{ logData = true, reportGas = true, genABI = false }: { logData?: boolean; reportGas?: boolean; genABI?: boolean } = {},
) {
	const { ethers } = hre
	const signers: SignerWithAddress[] = await ethers.getSigners()
	const owner: SignerWithAddress = signers[0]
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
		facetAddress: string;
		action: FacetCutAction;
		functionSelectors: string[];
	}> = []

	const deployedFacets: Array<{
		name: string;
		address: string;
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

	const cutChunks = chunkArray(
		cut,
		8, // chunk to stay under per-tx gas caps
	)

	for (let i = 0; i < cutChunks.length; i++) {
		const actions = cutChunks[i]
		const isFirst = i === 0
		const callData = isFirst ? diamondInit.interface.encodeFunctionData("init") : "0x"
		const target = isFirst ? await diamondInit.getAddress() : ethers.ZeroAddress

		const tx = await diamondCut.diamondCut(actions, target, callData)
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

task("deploy:diamond", "Deploys the Diamond contract")
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.addOption({ name: "reportGas", description: "Report gas consumption and costs", type: ArgumentType.BOOLEAN, defaultValue: true })
	.addOption({ name: "genABI", description: "Generate ABI artifacts (ignored)", type: ArgumentType.BOOLEAN, defaultValue: false })
	.setAction(async (taskArgs, hre) => deployDiamond(hre, taskArgs))
