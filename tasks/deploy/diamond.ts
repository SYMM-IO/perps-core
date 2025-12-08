import {task, types} from "hardhat/config"

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
}

task("deploy:diamond", "Deploys the Diamond contract")
	.addParam("logData", "Write the deployed addresses to a data file", true, types.boolean)
	.addParam("reportGas", "Report gas consumption and costs", true, types.boolean)
	.setAction(async ({logData, reportGas}, {ethers}) => {
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
				"contracts/libraries/LibQuoteFunding.sol:LibQuoteFunding": libraryAddresses["LibQuoteFunding"]
			}
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
					libraries[`contracts/libraries/${lib}.sol:${lib}`] = libraryAddresses[lib]
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
		const tx = await diamondCut.diamondCut(cut, await diamondInit.getAddress(), call)
		receipt = (await tx.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())

		if (!receipt.status) {
			throw Error(`Diamond upgrade failed: ${tx.hash}`)
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
	})
