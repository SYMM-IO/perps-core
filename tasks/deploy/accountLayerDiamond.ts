import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import { ContractTransactionReceipt } from "ethers"

import { FacetCutAction, getSelectors } from "../utils/diamondCut.js"
import { writeData } from "../utils/fs.js"
import { ACCOUNTLAYER_DEPLOYMENT_FILE } from "./constants.js"
import { getConnection } from "./helpers.js"
import { logger } from "./logger.js"
import {
	DeploymentCheckpoint,
	AccountLayerCheckpoint,
	createDeployedContract,
	saveCheckpoint,
} from "./checkpoint.js"

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
	checkpoint?: DeploymentCheckpoint
}

export async function deployAccountLayerDiamond(
	hre: any,
	{ admin, symmioFeeReceiver, logData = false, checkpoint }: DeployAccountLayerDiamondArgs
) {
	const { ethers } = await getConnection(hre)
	let totalGasUsed = BigInt(0)
	let receipt: ContractTransactionReceipt

	logger.section("AccountLayer Diamond Deployment")

	// Initialize or restore checkpoint data
	const alCheckpoint: AccountLayerCheckpoint = checkpoint?.contracts.accountLayerDiamond || {}
	const libraryAddresses: Record<string, string> = {}

	// Restore library addresses from checkpoint
	if (alCheckpoint.libraries) {
		for (const [name, data] of Object.entries(alCheckpoint.libraries)) {
			libraryAddresses[name] = data.address
		}
	}

	// Deploy DiamondCutFacet
	logger.subsection("Core Contracts")
	let diamondCutFacetAddress: string
	if (alCheckpoint.diamondCutFacet) {
		diamondCutFacetAddress = alCheckpoint.diamondCutFacet.address
		logger.info(`  ⏭ DiamondCutFacet already deployed at ${diamondCutFacetAddress}`)
	} else {
		const DiamondCutFacetFactory = await ethers.getContractFactory("DiamondCutFacet")
		const diamondCutFacet = await DiamondCutFacetFactory.deploy()
		await diamondCutFacet.waitForDeployment()
		receipt = (await diamondCutFacet.deploymentTransaction()!.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
		diamondCutFacetAddress = await diamondCutFacet.getAddress()
		logger.deployed("DiamondCutFacet", diamondCutFacetAddress)

		// Save checkpoint
		if (checkpoint) {
			alCheckpoint.diamondCutFacet = createDeployedContract(diamondCutFacetAddress)
			checkpoint.contracts.accountLayerDiamond = alCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	// Deploy Diamond
	let diamondAddress: string
	if (alCheckpoint.diamond) {
		diamondAddress = alCheckpoint.diamond.address
		logger.info(`  ⏭ AccountLayerDiamond already deployed at ${diamondAddress}`)
	} else {
		const DiamondFactory = await ethers.getContractFactory("Diamond")
		const diamond = await DiamondFactory.deploy(admin.address, diamondCutFacetAddress)
		await diamond.waitForDeployment()
		receipt = (await diamond.deploymentTransaction()!.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
		diamondAddress = await diamond.getAddress()
		logger.deployed("AccountLayerDiamond", diamondAddress)

		// Save checkpoint
		if (checkpoint) {
			alCheckpoint.diamond = createDeployedContract(diamondAddress, [admin.address, diamondCutFacetAddress])
			checkpoint.contracts.accountLayerDiamond = alCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	// Deploy Init
	let initAddress: string
	if (alCheckpoint.init) {
		initAddress = alCheckpoint.init.address
		logger.info(`  ⏭ Init already deployed at ${initAddress}`)
	} else {
		const InitFactory = await ethers.getContractFactory("contracts/accountLayer/Init.sol:Init")
		const init = await InitFactory.deploy()
		await init.waitForDeployment()
		receipt = (await init.deploymentTransaction()!.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
		initAddress = await init.getAddress()
		logger.deployed("Init", initAddress)

		// Save checkpoint
		if (checkpoint) {
			alCheckpoint.init = createDeployedContract(initAddress)
			checkpoint.contracts.accountLayerDiamond = alCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	// Deploy external libraries
	logger.subsection("Libraries")
	if (!alCheckpoint.libraries) {
		alCheckpoint.libraries = {}
	}

	// Deploy LibQuoteParams
	if (libraryAddresses["LibQuoteParams"]) {
		logger.info(`  ⏭ LibQuoteParams already deployed at ${libraryAddresses["LibQuoteParams"]}`)
	} else {
		const LibQuoteParamsFactory = await ethers.getContractFactory("contracts/accountLayer/libraries/LibQuoteParams.sol:LibQuoteParams")
		const libQuoteParams = await LibQuoteParamsFactory.deploy()
		await libQuoteParams.waitForDeployment()
		receipt = (await libQuoteParams.deploymentTransaction()!.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
		libraryAddresses["LibQuoteParams"] = await libQuoteParams.getAddress()
		logger.deployed("LibQuoteParams", libraryAddresses["LibQuoteParams"])

		// Save checkpoint
		if (checkpoint) {
			alCheckpoint.libraries!["LibQuoteParams"] = createDeployedContract(libraryAddresses["LibQuoteParams"])
			checkpoint.contracts.accountLayerDiamond = alCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

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

	if (!alCheckpoint.facets) {
		alCheckpoint.facets = {}
	}

	logger.subsection(`Facets (${AccountLayerFacetNames.length} total)`)
	for (let i = 0; i < AccountLayerFacetNames.length; i++) {
		const facetName = AccountLayerFacetNames[i]

		let facetAddress: string

		// Check if already deployed
		if (alCheckpoint.facets[facetName]) {
			facetAddress = alCheckpoint.facets[facetName].address
			logger.info(`  ⏭ [${i + 1}/${AccountLayerFacetNames.length}] ${facetName} already deployed at ${facetAddress}`)
		} else {
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
			facetAddress = await facet.getAddress()
			logger.deployed(`[${i + 1}/${AccountLayerFacetNames.length}] ${facetName}`, facetAddress)

			// Save checkpoint
			if (checkpoint) {
				alCheckpoint.facets![facetName] = createDeployedContract(facetAddress)
				checkpoint.contracts.accountLayerDiamond = alCheckpoint
				saveCheckpoint(checkpoint)
			}
		}

		// Get facet contract for selectors
		const facetPathMap: Record<string, string> = {
			CoreFacet: "Core",
			MarginFacet: "Margin",
			SymmioHookFacet: "SymmioHook",
			ControlFacet: "Control",
			ViewFacet: "View",
			AffiliateFacet: "Affiliate",
		}
		const path = facetPathMap[facetName]
		const facet = await ethers.getContractAt(`contracts/accountLayer/facets/${path}/${facetName}.sol:${facetName}`, facetAddress)
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

	// Upgrade Diamond with Facets (only if not already done)
	// First check on-chain if diamond cut was already done (handles case where tx succeeded but checkpoint wasn't saved)
	let diamondCutAlreadyDone = alCheckpoint.diamondCutComplete
	if (!diamondCutAlreadyDone) {
		try {
			// Try calling admin() from ControlFacet - only exists after diamond cut
			const controlFacet = await ethers.getContractAt(
				"contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet",
				diamondAddress,
			)
			await controlFacet.admin()
			// If we get here without error, the diamond cut was done
			logger.info("  ⏭ Diamond cut already complete (verified on-chain)")
			diamondCutAlreadyDone = true
			// Update checkpoint to reflect on-chain state
			if (checkpoint) {
				alCheckpoint.diamondCutComplete = true
				checkpoint.contracts.accountLayerDiamond = alCheckpoint
				saveCheckpoint(checkpoint)
			}
		} catch {
			// admin() doesn't exist yet, diamond cut not done
		}
	}

	if (!diamondCutAlreadyDone) {
		logger.subsection("Diamond Cut")
		const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress)
		const init = await ethers.getContractAt("contracts/accountLayer/Init.sol:Init", initAddress)

		// Call Initializer with params
		const call = init.interface.encodeFunctionData("init", [
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
			const initTarget = isFirst ? initAddress : ethers.ZeroAddress
			const initCalldata = isFirst ? call : "0x"
			const tx = await diamondCut.diamondCut(chunk, initTarget, initCalldata)
			receipt = (await tx.wait())!
			totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())

			if (!receipt.status) {
				throw Error(`Diamond upgrade failed: ${tx.hash}`)
			}
			logger.progress(chunkNum, totalChunks, `Chunk ${chunkNum} (${chunk.length} facets)`)
		}

		// Mark diamond cut as complete
		if (checkpoint) {
			alCheckpoint.diamondCutComplete = true
			checkpoint.contracts.accountLayerDiamond = alCheckpoint
			saveCheckpoint(checkpoint)
		}
	} else {
		logger.info("  ⏭ Diamond cut already complete")
	}

	logger.complete("AccountLayer Diamond Deployment", [
		{ name: "AccountLayerDiamond", address: diamondAddress },
		{ name: "DiamondCutFacet", address: diamondCutFacetAddress },
		{ name: "Init", address: initAddress },
	])

	// Write deployment log for verification
	if (logData) {
		const facetPathMap: Record<string, string> = {
			CoreFacet: "Core",
			MarginFacet: "Margin",
			SymmioHookFacet: "SymmioHook",
			ControlFacet: "Control",
			ViewFacet: "View",
			AffiliateFacet: "Affiliate",
		}
		writeData(ACCOUNTLAYER_DEPLOYMENT_FILE, [
			{
				name: "DiamondCutFacet",
				address: diamondCutFacetAddress,
				constructorArguments: [],
			},
			{
				name: "Diamond",
				address: diamondAddress,
				constructorArguments: [admin.address, diamondCutFacetAddress],
			},
			{
				name: "contracts/accountLayer/Init.sol:Init",
				address: initAddress,
				constructorArguments: [],
			},
			...Object.entries(libraryAddresses).map(([name, address]) => ({
				name: `contracts/accountLayer/libraries/${name}.sol:${name}`,
				address,
				constructorArguments: [],
			})),
			...deployedFacets.map(facet => ({
				name: `contracts/accountLayer/facets/${facetPathMap[facet.name] || facet.name.replace("Facet", "")}/${facet.name}.sol:${facet.name}`,
				address: facet.address,
				constructorArguments: [],
			})),
		])
	}

	return {
		diamond: diamondAddress,
		diamondCutFacet: diamondCutFacetAddress,
		init: initAddress,
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
