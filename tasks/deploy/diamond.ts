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
	PartyBPositionActionsFacet: ["PartyBPositionActionsFacetImpl", "LibQuoteClose"],
	PartyBBatchActionsFacet: ["LibQuoteClose", "LibQuoteFunding"],
	PartyBEmergencyActionsFacet: ["LibQuoteClose"],
	PartyBQuoteActionsFacet: ["LibQuoteClose"],
	ForceActionsFacet: ["LibForceActions", "LibSettlement"],
	ForceCloseStepsFacet: ["LibForceActions", "LibSettlement"],
	ViewFacetQuote: ["LibQuoteFunding"],
	FundingRateFacet: ["LibQuoteFunding"],
	PartyALiquidationFacet: ["LibPartyALiquidationLegacySetup", "LibPartyALiquidationProcess"],
	PartyALiquidationSnapshotFacet: ["LibPartyALiquidationSnapshotSetup", "LibPartyALiquidationProcess"],
	ClearingHouseFacet: ["LibQuoteClose", "LibQuoteFunding"],
	SettlementFacet: ["LibSettlement"],
	SymbolAdjustmentFacet: ["LibQuoteFunding", "LibQuoteClose"],
}

const LibraryLinkReferences: Record<string, string> = {
	PartyBPositionActionsFacetImpl:
		"project/contracts/core/facets/PartyBPositionActions/PartyBPositionActionsFacetImpl.sol:PartyBPositionActionsFacetImpl",
	LibQuoteFunding: "project/contracts/core/libraries/LibQuoteFunding.sol:LibQuoteFunding",
	LibQuoteClose: "project/contracts/core/libraries/LibQuoteClose.sol:LibQuoteClose",
	LibForceActions: "project/contracts/core/libraries/LibForceActions.sol:LibForceActions",
	LibSettlement: "project/contracts/core/libraries/LibSettlement.sol:LibSettlement",
	LibPartyALiquidationProcess: "project/contracts/core/libraries/liquidation/LibPartyALiquidationProcess.sol:LibPartyALiquidationProcess",
	LibPartyALiquidationSnapshotSetup:
		"project/contracts/core/libraries/liquidation/LibPartyALiquidationSnapshotSetup.sol:LibPartyALiquidationSnapshotSetup",
	LibPartyALiquidationLegacySetup: "project/contracts/core/libraries/liquidation/LibPartyALiquidationLegacySetup.sol:LibPartyALiquidationLegacySetup",
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

		// Bound the retry loop so a misconfigured factory or prefix fails fast.
		const MAX_SALT_COLLISIONS = 20
		let saltCollisions = 0

		while (true) {
			logger.info(`  Mining CREATE2 salt for 0x${vanityPrefix} prefix...`)
			const { salt, address: predictedAddress, attempts, elapsedMs } = mineCreate2Salt(create2FactoryAddress, initCodeHex, vanityPrefix, startNonce)
			logger.info(`  Found salt after ${attempts.toLocaleString()} attempts (${(elapsedMs / 1000).toFixed(1)}s)`)
			logger.info(`  Predicted address: ${predictedAddress}`)

			// Cheap pre-check: skip an occupied address without spending a transaction.
			if ((await ethers.provider.getCode(predictedAddress)) !== "0x") {
				logger.info(`  ${predictedAddress} already has code, trying next match...`)
				startNonce = BigInt(salt) + 1n
				saltCollisions++
				if (saltCollisions > MAX_SALT_COLLISIONS) {
					throw new Error(`Aborting CREATE2 mining after ${MAX_SALT_COLLISIONS} occupied addresses — check the factory address and vanity prefix.`)
				}
				continue
			}

			try {
				const tx = await create2Factory.deploy(salt, initCode)
				receipt = (await tx.wait())!
				totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())

				diamondAddress = predictedAddress
				diamond = await ethers.getContractAt("Diamond", diamondAddress)
				logger.deployed("Diamond (CREATE2)", diamondAddress)
				break
			} catch (err: any) {
				// Only a genuinely-taken address justifies retrying. This used to swallow
				// EVERY error as "salt already used", so an RPC outage, an out-of-gas, or an
				// underfunded deployer would spin here forever printing a misleading message.
				if ((await ethers.provider.getCode(predictedAddress)) === "0x") {
					throw err
				}
				logger.info(`  Salt already used, trying next match...`)
				startNonce = BigInt(salt) + 1n
				saltCollisions++
				if (saltCollisions > MAX_SALT_COLLISIONS) {
					throw new Error(`Aborting CREATE2 mining after ${MAX_SALT_COLLISIONS} salt collisions — check the factory address and vanity prefix.`)
				}
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
				[LibraryLinkReferences.LibQuoteFunding]: libraryAddresses["LibQuoteFunding"],
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

	// Public position implementation keeps the PartyB facet below EIP-170.
	if (libraryAddresses["PartyBPositionActionsFacetImpl"]) {
		logger.info(`  ⏭ PartyBPositionActionsFacetImpl already deployed at ${libraryAddresses["PartyBPositionActionsFacetImpl"]}`)
	} else {
		const factory = await ethers.getContractFactory("PartyBPositionActionsFacetImpl", {
			libraries: {
				[LibraryLinkReferences.LibQuoteFunding]: libraryAddresses["LibQuoteFunding"],
			},
		})
		const library = await factory.deploy()
		await library.waitForDeployment()
		receipt = (await library.deploymentTransaction()!.wait())!
		totalGasUsed += BigInt(receipt.gasUsed.toString())
		libraryAddresses["PartyBPositionActionsFacetImpl"] = await library.getAddress()
		logger.deployed("PartyBPositionActionsFacetImpl", libraryAddresses["PartyBPositionActionsFacetImpl"])
		if (checkpoint) {
			diamondCheckpoint.libraries!["PartyBPositionActionsFacetImpl"] = createDeployedContract(libraryAddresses["PartyBPositionActionsFacetImpl"])
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
				[LibraryLinkReferences.LibQuoteClose]: libraryAddresses["LibQuoteClose"],
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

	// Deploy LibPartyALiquidationProcess (depends on LibQuoteFunding)
	if (libraryAddresses["LibPartyALiquidationProcess"]) {
		logger.info(`  ⏭ LibPartyALiquidationProcess already deployed at ${libraryAddresses["LibPartyALiquidationProcess"]}`)
	} else {
		const LibPartyALiquidationProcessFactory = await ethers.getContractFactory("LibPartyALiquidationProcess", {
			libraries: {
				[LibraryLinkReferences.LibQuoteFunding]: libraryAddresses["LibQuoteFunding"],
			},
		})
		const libPartyALiquidationProcess = await LibPartyALiquidationProcessFactory.deploy()
		await libPartyALiquidationProcess.waitForDeployment()
		receipt = (await libPartyALiquidationProcess.deploymentTransaction()!.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
		libraryAddresses["LibPartyALiquidationProcess"] = await libPartyALiquidationProcess.getAddress()
		logger.deployed("LibPartyALiquidationProcess", libraryAddresses["LibPartyALiquidationProcess"])

		// Save checkpoint
		if (checkpoint) {
			diamondCheckpoint.libraries!["LibPartyALiquidationProcess"] = createDeployedContract(libraryAddresses["LibPartyALiquidationProcess"])
			checkpoint.contracts.diamond = diamondCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	// Deploy PartyA liquidation snapshot setup implementation library
	if (libraryAddresses["LibPartyALiquidationSnapshotSetup"]) {
		logger.info(`  ⏭ LibPartyALiquidationSnapshotSetup already deployed at ${libraryAddresses["LibPartyALiquidationSnapshotSetup"]}`)
	} else {
		const LibPartyALiquidationSnapshotSetupFactory = await ethers.getContractFactory("LibPartyALiquidationSnapshotSetup")
		const libPartyALiquidationSnapshotSetup = await LibPartyALiquidationSnapshotSetupFactory.deploy()
		await libPartyALiquidationSnapshotSetup.waitForDeployment()
		receipt = (await libPartyALiquidationSnapshotSetup.deploymentTransaction()!.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
		libraryAddresses["LibPartyALiquidationSnapshotSetup"] = await libPartyALiquidationSnapshotSetup.getAddress()
		logger.deployed("LibPartyALiquidationSnapshotSetup", libraryAddresses["LibPartyALiquidationSnapshotSetup"])

		// Save checkpoint
		if (checkpoint) {
			diamondCheckpoint.libraries!["LibPartyALiquidationSnapshotSetup"] = createDeployedContract(
				libraryAddresses["LibPartyALiquidationSnapshotSetup"],
			)
			checkpoint.contracts.diamond = diamondCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	// Deploy legacy PartyA liquidation setup implementation library
	if (libraryAddresses["LibPartyALiquidationLegacySetup"]) {
		logger.info(`  ⏭ LibPartyALiquidationLegacySetup already deployed at ${libraryAddresses["LibPartyALiquidationLegacySetup"]}`)
	} else {
		const LibPartyALiquidationLegacySetupFactory = await ethers.getContractFactory("LibPartyALiquidationLegacySetup")
		const libPartyALiquidationLegacySetup = await LibPartyALiquidationLegacySetupFactory.deploy()
		await libPartyALiquidationLegacySetup.waitForDeployment()
		receipt = (await libPartyALiquidationLegacySetup.deploymentTransaction()!.wait())!
		totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())
		libraryAddresses["LibPartyALiquidationLegacySetup"] = await libPartyALiquidationLegacySetup.getAddress()
		logger.deployed("LibPartyALiquidationLegacySetup", libraryAddresses["LibPartyALiquidationLegacySetup"])

		// Save checkpoint
		if (checkpoint) {
			diamondCheckpoint.libraries!["LibPartyALiquidationLegacySetup"] = createDeployedContract(libraryAddresses["LibPartyALiquidationLegacySetup"])
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
					libraries[LibraryLinkReferences[lib]] = libraryAddresses[lib]
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

	// Upgrade Diamond with Facets (only if not already done).
	//
	// Resume correctness matters here: the cut is applied in chunks, so a failure part-way
	// through leaves a diamond with SOME facets installed. Probing with `facets().length > 1`
	// used to treat any partially-cut diamond as fully cut, silently shipping a diamond
	// missing up to 19 facets. Instead, compare the installed selector set against the
	// selectors we are about to add, and re-cut only what is genuinely missing.
	//
	// Each chunk is a single atomic transaction containing whole facets, so an installed
	// facet is always complete — filtering `cut` by "are these selectors present?" is exact.
	const expectedSelectors = new Set<string>()
	for (const entry of cut) {
		for (const selector of entry.functionSelectors) expectedSelectors.add(selector.toLowerCase())
	}

	const installedSelectors = new Set<string>()
	try {
		// facets() only exists once DiamondLoupeFacet has been cut in
		const loupe = await ethers.getContractAt("IDiamondLoupe", diamondAddress)
		for (const facet of await loupe.facets()) {
			for (const selector of facet.functionSelectors) installedSelectors.add(selector.toLowerCase())
		}
	} catch {
		// Loupe not available yet — nothing has been cut in.
	}

	// A facet counts as installed only when every one of its selectors is present.
	const remainingCut = cut.filter(entry => !entry.functionSelectors.every(s => installedSelectors.has(s.toLowerCase())))
	const missingSelectorCount = [...expectedSelectors].filter(s => !installedSelectors.has(s)).length

	// Init runs inside the first chunk's transaction. If anything is installed at all, that
	// transaction landed and init() has already executed — re-running it would revert.
	const initAlreadyRan = installedSelectors.size > 0

	if (remainingCut.length === 0) {
		logger.info(`  ⏭ Diamond cut already complete (${expectedSelectors.size} selectors verified on-chain)`)
		if (checkpoint) {
			diamondCheckpoint.diamondCutComplete = true
			checkpoint.contracts.diamond = diamondCheckpoint
			saveCheckpoint(checkpoint)
		}
	} else {
		logger.subsection("Diamond Cut")
		if (initAlreadyRan) {
			logger.error(
				`  ⚠ Partial diamond cut detected: ${expectedSelectors.size - missingSelectorCount}/${expectedSelectors.size} selectors installed. ` +
					`Re-cutting the ${remainingCut.length} missing facet(s); skipping init() because it already ran.`,
			)
		}

		const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress)
		const init = await ethers.getContractAt("contracts/core/Init.sol:Init", initAddress)
		const call = init.interface.encodeFunctionData("init")

		const chunkSize = 6
		const totalChunks = Math.ceil(remainingCut.length / chunkSize)
		for (let i = 0; i < remainingCut.length; i += chunkSize) {
			const chunk = remainingCut.slice(i, i + chunkSize)
			const chunkNum = Math.floor(i / chunkSize) + 1
			const runInit = i === 0 && !initAlreadyRan
			const initTarget = runInit ? initAddress : ethers.ZeroAddress
			const initCalldata = runInit ? call : "0x"
			const tx = await diamondCut.diamondCut(chunk, initTarget, initCalldata)
			receipt = (await tx.wait())!
			totalGasUsed = totalGasUsed + BigInt(receipt.gasUsed.toString())

			if (!receipt.status) {
				throw Error(`Diamond upgrade failed: ${tx.hash}`)
			}
			logger.progress(chunkNum, totalChunks, `Chunk ${chunkNum} (${chunk.length} facets) — ${tx.hash}`)
		}

		// Assert the diamond really does expose every expected selector before recording success.
		const verifyLoupe = await ethers.getContractAt("IDiamondLoupe", diamondAddress)
		const finalSelectors = new Set<string>()
		for (const facet of await verifyLoupe.facets()) {
			for (const selector of facet.functionSelectors) finalSelectors.add(selector.toLowerCase())
		}
		const stillMissing = [...expectedSelectors].filter(s => !finalSelectors.has(s))
		if (stillMissing.length > 0) {
			throw new Error(
				`Diamond cut incomplete: ${stillMissing.length} of ${expectedSelectors.size} selectors are missing after the cut ` +
					`(e.g. ${stillMissing.slice(0, 5).join(", ")}). Refusing to mark the deployment complete.`,
			)
		}
		logger.info(`  ✓ All ${expectedSelectors.size} selectors verified on-chain`)

		if (checkpoint) {
			diamondCheckpoint.diamondCutComplete = true
			checkpoint.contracts.diamond = diamondCheckpoint
			saveCheckpoint(checkpoint)
		}
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
			{
				name: "LibPartyALiquidationProcess",
				address: libraryAddresses["LibPartyALiquidationProcess"],
				constructorArguments: [],
			},
			{
				name: "LibPartyALiquidationSnapshotSetup",
				address: libraryAddresses["LibPartyALiquidationSnapshotSetup"],
				constructorArguments: [],
			},
			{
				name: "LibPartyALiquidationLegacySetup",
				address: libraryAddresses["LibPartyALiquidationLegacySetup"],
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
