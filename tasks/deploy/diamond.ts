import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { ContractTransactionReceipt } from "ethers"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { mineCreate2Salt } from "../utils/create2Mining.js"
import { FacetCutAction, getSelectors } from "../utils/diamondCut.js"
import { writeData } from "../utils/fs.js"
import { DeploymentCheckpoint, DiamondCheckpoint, createDeployedContract, saveCheckpoint } from "./checkpoint.js"
import { DEPLOYMENT_LOG_FILE, FacetNames } from "./constants.js"
import { getConnection } from "./helpers.js"
import { logger } from "./logger.js"

// Define which facets need which external libraries (based on compiled artifacts)
const FacetLibraryDependencies: Record<string, string[]> = {
	PartyAFacet: ["LibQuoteClose"],
	PartyBPositionActionsFacet: ["LibQuoteClose", "LibQuoteFunding"],
	PartyBBatchActionsFacet: ["LibQuoteClose", "LibQuoteFunding"],
	PartyBEmergencyActionsFacet: ["LibQuoteClose"],
	PartyBQuoteActionsFacet: ["LibQuoteClose"],
	ForceActionsFacet: ["LibForceActions", "LibSettlement"],
	ForceCloseStepsFacet: ["LibForceActions", "LibSettlement"],
	ViewFacetQuote: ["LibQuoteFunding"],
	FundingRateFacet: ["LibQuoteFunding"],
	PartyALiquidationFacet: ["LibQuoteFunding"],
	ClearingHouseFacet: ["LibQuoteClose", "LibQuoteFunding"],
	SettlementFacet: ["LibSettlement"],
}

type DeployDiamondArgs = {
	genABI?: boolean
	logData?: boolean
	reportGas?: boolean
	checkpoint?: DeploymentCheckpoint
}

export async function deployDiamond(hre: any, { logData = true, genABI = false, reportGas = true, checkpoint }: DeployDiamondArgs = {}) {
	const { ethers } = await getConnection(hre)
	const signers: HardhatEthersSigner[] = await ethers.getSigners()
	const owner: HardhatEthersSigner = signers[0]
	let totalGasUsed = BigInt(0)
	let receipt: ContractTransactionReceipt

	logger.section("Diamond Deployment")

	// Initialize or restore checkpoint data
	const diamondCheckpoint: DiamondCheckpoint = checkpoint?.contracts.diamond || {}
	const libraryAddresses: Record<string, string> = {}

	// Restore library addresses from checkpoint
	if (diamondCheckpoint.libraries) {
		for (const [name, data] of Object.entries(diamondCheckpoint.libraries)) {
			libraryAddresses[name] = data.address
		}
	}

	// Deploy DiamondCutFacet
	logger.subsection("Core Contracts")
	let diamondCutFacetAddress: string
	if (diamondCheckpoint.diamondCutFacet) {
		diamondCutFacetAddress = diamondCheckpoint.diamondCutFacet.address
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
			diamondCheckpoint.diamondCutFacet = createDeployedContract(diamondCutFacetAddress)
			checkpoint.contracts.diamond = diamondCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	// Deploy Diamond (via CREATE2 if factory address is provided AND has code on this network, otherwise standard CREATE)
	const envCreate2FactoryAddress = process.env.CREATE2_FACTORY_ADDRESS || ""
	const vanityPrefix = process.env.DIAMOND_VANITY_PREFIX || "573310"
	let create2FactoryAddress = ""
	if (envCreate2FactoryAddress) {
		const factoryCode = await ethers.provider.getCode(envCreate2FactoryAddress)
		if (factoryCode && factoryCode !== "0x") {
			create2FactoryAddress = envCreate2FactoryAddress
		} else {
			logger.info(`  ⚠ CREATE2_FACTORY_ADDRESS ${envCreate2FactoryAddress} has no code on this network — falling back to standard deploy`)
		}
	}
	let diamondAddress: string
	let diamond: any
	if (diamondCheckpoint.diamond) {
		diamondAddress = diamondCheckpoint.diamond.address
		diamond = await ethers.getContractAt("Diamond", diamondAddress)
		logger.info(`  ⏭ Diamond already deployed at ${diamondAddress}`)
	} else if (create2FactoryAddress) {
		const DiamondFactory = await ethers.getContractFactory("Diamond")
		const constructorArgs = [owner.address, diamondCutFacetAddress]
		const initCode = ethers.concat([DiamondFactory.bytecode, DiamondFactory.interface.encodeDeploy(constructorArgs)])

		const create2Factory = await ethers.getContractAt("Create2Factory", create2FactoryAddress)
		const initCodeHex = ethers.hexlify(initCode)
		let startNonce = 0n

		while (true) {
			logger.info(`  Mining CREATE2 salt for 0x${vanityPrefix} prefix...`)
			const { salt, address: predictedAddress, attempts, elapsedMs } = mineCreate2Salt(create2FactoryAddress, initCodeHex, vanityPrefix, startNonce)
			logger.info(`  Found salt after ${attempts.toLocaleString()} attempts (${(elapsedMs / 1000).toFixed(1)}s)`)
			logger.info(`  Predicted address: ${predictedAddress}`)

			try {
				const tx = await create2Factory.deploy(salt, initCode)
				receipt = (await tx.wait())!
				totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())

				diamondAddress = predictedAddress
				diamond = await ethers.getContractAt("Diamond", diamondAddress)
				logger.deployed("Diamond (CREATE2)", diamondAddress)
				break
			} catch (err: any) {
				logger.info(`  Salt already used, trying next match...`)
				startNonce = BigInt(salt) + 1n
			}
		}

		// Save checkpoint
		if (checkpoint) {
			diamondCheckpoint.diamond = createDeployedContract(diamondAddress, constructorArgs)
			checkpoint.contracts.diamond = diamondCheckpoint
			saveCheckpoint(checkpoint)
		}
	} else {
		const DiamondFactory = await ethers.getContractFactory("Diamond")
		diamond = await DiamondFactory.deploy(owner.address, diamondCutFacetAddress)
		await diamond.waitForDeployment()
		receipt = (await diamond.deploymentTransaction()!.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
		diamondAddress = await diamond.getAddress()
		logger.deployed("Diamond", diamondAddress)

		// Save checkpoint
		if (checkpoint) {
			diamondCheckpoint.diamond = createDeployedContract(diamondAddress, [owner.address, diamondCutFacetAddress])
			checkpoint.contracts.diamond = diamondCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	// Deploy Init
	let initAddress: string
	if (diamondCheckpoint.init) {
		initAddress = diamondCheckpoint.init.address
		logger.info(`  ⏭ Init already deployed at ${initAddress}`)
	} else {
		const InitFactory = await ethers.getContractFactory("contracts/core/Init.sol:Init")
		const init = await InitFactory.deploy()
		await init.waitForDeployment()
		receipt = (await init.deploymentTransaction()!.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
		initAddress = await init.getAddress()
		logger.deployed("Init", initAddress)

		// Save checkpoint
		if (checkpoint) {
			diamondCheckpoint.init = createDeployedContract(initAddress)
			checkpoint.contracts.diamond = diamondCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	// Deploy external libraries first
	logger.subsection("Libraries")
	if (!diamondCheckpoint.libraries) {
		diamondCheckpoint.libraries = {}
	}

	// Deploy LibQuoteFunding first (no dependencies)
	if (libraryAddresses["LibQuoteFunding"]) {
		logger.info(`  ⏭ LibQuoteFunding already deployed at ${libraryAddresses["LibQuoteFunding"]}`)
	} else {
		const LibQuoteFundingFactory = await ethers.getContractFactory("LibQuoteFunding")
		const libQuoteFunding = await LibQuoteFundingFactory.deploy()
		await libQuoteFunding.waitForDeployment()
		receipt = (await libQuoteFunding.deploymentTransaction()!.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
		libraryAddresses["LibQuoteFunding"] = await libQuoteFunding.getAddress()
		logger.deployed("LibQuoteFunding", libraryAddresses["LibQuoteFunding"])

		// Save checkpoint
		if (checkpoint) {
			diamondCheckpoint.libraries!["LibQuoteFunding"] = createDeployedContract(libraryAddresses["LibQuoteFunding"])
			checkpoint.contracts.diamond = diamondCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	// Deploy LibQuoteClose (depends on LibQuoteFunding)
	if (libraryAddresses["LibQuoteClose"]) {
		logger.info(`  ⏭ LibQuoteClose already deployed at ${libraryAddresses["LibQuoteClose"]}`)
	} else {
		const LibQuoteCloseFactory = await ethers.getContractFactory("LibQuoteClose", {
			libraries: {
				"project/contracts/core/libraries/LibQuoteFunding.sol:LibQuoteFunding": libraryAddresses["LibQuoteFunding"],
			},
		})
		const libQuoteClose = await LibQuoteCloseFactory.deploy()
		await libQuoteClose.waitForDeployment()
		receipt = (await libQuoteClose.deploymentTransaction()!.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
		libraryAddresses["LibQuoteClose"] = await libQuoteClose.getAddress()
		logger.deployed("LibQuoteClose", libraryAddresses["LibQuoteClose"])

		// Save checkpoint
		if (checkpoint) {
			diamondCheckpoint.libraries!["LibQuoteClose"] = createDeployedContract(libraryAddresses["LibQuoteClose"])
			checkpoint.contracts.diamond = diamondCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	// Deploy LibForceActions (depends on LibQuoteClose)
	if (libraryAddresses["LibForceActions"]) {
		logger.info(`  ⏭ LibForceActions already deployed at ${libraryAddresses["LibForceActions"]}`)
	} else {
		const LibForceActionsFactory = await ethers.getContractFactory("LibForceActions", {
			libraries: {
				"project/contracts/core/libraries/LibQuoteClose.sol:LibQuoteClose": libraryAddresses["LibQuoteClose"],
			},
		})
		const libForceActions = await LibForceActionsFactory.deploy()
		await libForceActions.waitForDeployment()
		receipt = (await libForceActions.deploymentTransaction()!.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
		libraryAddresses["LibForceActions"] = await libForceActions.getAddress()
		logger.deployed("LibForceActions", libraryAddresses["LibForceActions"])

		// Save checkpoint
		if (checkpoint) {
			diamondCheckpoint.libraries!["LibForceActions"] = createDeployedContract(libraryAddresses["LibForceActions"])
			checkpoint.contracts.diamond = diamondCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	// Deploy LibSettlement (no dependencies)
	if (libraryAddresses["LibSettlement"]) {
		logger.info(`  ⏭ LibSettlement already deployed at ${libraryAddresses["LibSettlement"]}`)
	} else {
		const LibSettlementFactory = await ethers.getContractFactory("LibSettlement")
		const libSettlement = await LibSettlementFactory.deploy()
		await libSettlement.waitForDeployment()
		receipt = (await libSettlement.deploymentTransaction()!.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
		libraryAddresses["LibSettlement"] = await libSettlement.getAddress()
		logger.deployed("LibSettlement", libraryAddresses["LibSettlement"])

		// Save checkpoint
		if (checkpoint) {
			diamondCheckpoint.libraries!["LibSettlement"] = createDeployedContract(libraryAddresses["LibSettlement"])
			checkpoint.contracts.diamond = diamondCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

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

	if (!diamondCheckpoint.facets) {
		diamondCheckpoint.facets = {}
	}

	logger.subsection(`Facets (${FacetNames.length} total)`)
	for (let i = 0; i < FacetNames.length; i++) {
		const facetName = FacetNames[i]
		const shortName = facetName.includes(":") ? facetName.split(":").pop()! : facetName

		let facetAddress: string

		// Check if already deployed
		if (diamondCheckpoint.facets[shortName]) {
			facetAddress = diamondCheckpoint.facets[shortName].address
			logger.info(`  ⏭ [${i + 1}/${FacetNames.length}] ${shortName} already deployed at ${facetAddress}`)
		} else {
			// Check if this facet needs library linking
			const requiredLibraries = FacetLibraryDependencies[shortName]
			let FacetFactory

			if (requiredLibraries && requiredLibraries.length > 0) {
				const libraries: Record<string, string> = {}
				for (const lib of requiredLibraries) {
					libraries[`project/contracts/core/libraries/${lib}.sol:${lib}`] = libraryAddresses[lib]
				}
				FacetFactory = await ethers.getContractFactory(facetName, { libraries })
			} else {
				FacetFactory = await ethers.getContractFactory(facetName)
			}

			const facet = await FacetFactory.deploy()
			await facet.waitForDeployment()
			receipt = (await facet.deploymentTransaction()!.wait())!
			totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
			facetAddress = await facet.getAddress()
			logger.deployed(`[${i + 1}/${FacetNames.length}] ${shortName}`, facetAddress)

			// Save checkpoint
			if (checkpoint) {
				diamondCheckpoint.facets![shortName] = createDeployedContract(facetAddress)
				checkpoint.contracts.diamond = diamondCheckpoint
				saveCheckpoint(checkpoint)
			}
		}

		// Get facet contract for selectors
		const facet = await ethers.getContractAt(facetName, facetAddress)
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
	let diamondCutAlreadyDone = diamondCheckpoint.diamondCutComplete
	if (!diamondCutAlreadyDone) {
		try {
			// Try calling facets() from DiamondLoupeFacet - only exists after diamond cut
			const loupe = await ethers.getContractAt("IDiamondLoupe", diamondAddress)
			const facets = await loupe.facets()
			// If we get more than just DiamondCutFacet, the diamond cut was done
			if (facets.length > 1) {
				logger.info("  ⏭ Diamond cut already complete (verified on-chain)")
				diamondCutAlreadyDone = true
				// Update checkpoint to reflect on-chain state
				if (checkpoint) {
					diamondCheckpoint.diamondCutComplete = true
					checkpoint.contracts.diamond = diamondCheckpoint
					saveCheckpoint(checkpoint)
				}
			}
		} catch {
			// facets() doesn't exist yet, diamond cut not done
		}
	}

	if (!diamondCutAlreadyDone) {
		logger.subsection("Diamond Cut")
		const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress)
		const init = await ethers.getContractAt("contracts/core/Init.sol:Init", initAddress)

		// Call Initializer
		const call = init.interface.encodeFunctionData("init")
		const chunkSize = 6
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
			diamondCheckpoint.diamondCutComplete = true
			checkpoint.contracts.diamond = diamondCheckpoint
			saveCheckpoint(checkpoint)
		}
	} else {
		logger.info("  ⏭ Diamond cut already complete")
	}

	logger.complete("Diamond Deployment", [
		{ name: "Diamond", address: diamondAddress },
		{ name: "DiamondCutFacet", address: diamondCutFacetAddress },
		{ name: "Init", address: initAddress },
	])

	// Write addresses to JSON file for etherscan verification
	if (logData) {
		writeData(DEPLOYMENT_LOG_FILE, [
			{
				name: "DiamondCut",
				address: diamondCutFacetAddress,
				constructorArguments: [],
			},
			{
				name: "Diamond",
				address: diamondAddress,
				constructorArguments: [owner.address, diamondCutFacetAddress],
			},
			{
				name: "Init",
				address: initAddress,
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
				name: "LibForceActions",
				address: libraryAddresses["LibForceActions"],
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
