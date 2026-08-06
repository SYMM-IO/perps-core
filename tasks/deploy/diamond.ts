import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { mineCreate2Salt } from "../utils/create2Mining.js"
import { FacetCutAction, getSelectors } from "../utils/diamondCut.js"
import { writeData } from "../utils/fs.js"
import { deploymentOnlyArtifact } from "./artifacts.js"
import { DeploymentCheckpoint, DiamondCheckpoint, createDeployedContract, saveCheckpoint } from "./checkpoint.js"
import { DEPLOYMENT_LOG_FILE, FacetNames } from "./constants.js"
import { checkpointDeployment, persistSubmittedTransaction, recoverCheckpointContractDeployments } from "./deploymentRecovery.js"
import { assertStandaloneDeploymentTaskAllowed, getConnection } from "./helpers.js"
import { logger } from "./logger.js"
import { DEFAULT_CONFIRMATIONS, confirmDeploymentWithReceipt, getDeploymentTransactionJournal, recoverConfirmedDeployment, send } from "./tx.js"

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
	PartyALiquidationFacet: ["LibPartyALiquidationLegacySetup", "LibPartyALiquidationProcess"],
	PartyALiquidationSnapshotFacet: ["LibPartyALiquidationSnapshotSetup", "LibPartyALiquidationProcess"],
	ClearingHouseFacet: ["LibQuoteClose", "LibQuoteFunding"],
	SettlementFacet: ["LibSettlement"],
	SymbolAdjustmentFacet: ["LibQuoteFunding", "LibQuoteClose"],
}

const LibraryLinkReferences: Record<string, string> = {
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

/** An explicitly requested deterministic factory is a safety requirement, not a hint. */
export async function resolveCreate2FactoryAddress(ethers: any, configuredAddress: string): Promise<string> {
	if (!configuredAddress) return ""
	let address: string
	try {
		address = ethers.getAddress(configuredAddress)
	} catch (error) {
		throw new Error(
			`CREATE2_FACTORY_ADDRESS is invalid: ${JSON.stringify(configuredAddress)} (${error instanceof Error ? error.message : String(error)})`,
		)
	}
	const factoryCode = await ethers.provider.getCode(address)
	if (!factoryCode || factoryCode === "0x") {
		throw new Error(
			`CREATE2_FACTORY_ADDRESS ${address} was explicitly configured but has no code on this network; refusing to change the Diamond address strategy to ordinary CREATE.`,
		)
	}
	return address
}

export async function deployDiamond(hre: any, { logData = true, genABI = false, reportGas = true, checkpoint }: DeployDiamondArgs = {}) {
	const { ethers } = await getConnection(hre)
	await recoverCheckpointContractDeployments(checkpoint, ethers.provider, "contracts.diamond")
	const signers: HardhatEthersSigner[] = await ethers.getSigners()
	const owner: HardhatEthersSigner = signers[0]
	let totalGasUsed = BigInt(0)
	const confirmAndCount = async (contract: any, label: string, component: string, constructorArgs: unknown[] = []): Promise<string> => {
		const { address, receipt } = await confirmDeploymentWithReceipt(contract, label, checkpointDeployment(checkpoint, component, constructorArgs))
		totalGasUsed += receipt.gasUsed
		return address
	}

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
		diamondCutFacetAddress = await confirmAndCount(diamondCutFacet, "DiamondCutFacet", "contracts.diamond.diamondCutFacet")
		logger.deployed("DiamondCutFacet", diamondCutFacetAddress)

		// Save checkpoint
		if (checkpoint) {
			diamondCheckpoint.diamondCutFacet = createDeployedContract(diamondCutFacetAddress)
			checkpoint.contracts.diamond = diamondCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	// Deploy via CREATE2 when explicitly configured; ordinary CREATE is only an intentional no-factory mode.
	const envCreate2FactoryAddress = process.env.CREATE2_FACTORY_ADDRESS || ""
	const vanityPrefix = process.env.DIAMOND_VANITY_PREFIX || "573310"
	const create2FactoryAddress = await resolveCreate2FactoryAddress(ethers, envCreate2FactoryAddress)
	if (!create2FactoryAddress) logger.info("  CREATE2_FACTORY_ADDRESS is not configured; using ordinary CREATE for Diamond")
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
				const deployment = {
					kind: "create2" as const,
					component: "contracts.diamond.diamond",
					expectedAddress: predictedAddress,
					factoryAddress: create2FactoryAddress,
					salt,
					initCodeHash: ethers.keccak256(initCodeHex),
					factoryCallDataHash: ethers.keccak256(create2Factory.interface.encodeFunctionData("deploy", [salt, initCode])),
					constructorArgs,
				}
				const receipt = await send(create2Factory.deploy(salt, initCode), "deploy Diamond via CREATE2", DEFAULT_CONFIRMATIONS, {
					deployment,
					onSubmitted: checkpoint ? record => persistSubmittedTransaction(checkpoint, record) : undefined,
				})
				totalGasUsed += receipt.gasUsed
				await recoverConfirmedDeployment(getDeploymentTransactionJournal(), deployment.component, ethers.provider)

				diamondAddress = predictedAddress
				diamond = await ethers.getContractAt("Diamond", diamondAddress)
				logger.deployed("Diamond (CREATE2)", diamondAddress)
				break
			} catch (err: any) {
				// The address was empty immediately before broadcast. If code appeared while
				// receipt waiting failed, it may be this exact transaction; retrying another
				// salt would orphan it. The transaction journal must reconcile it first.
				throw new Error(
					`CREATE2 Diamond broadcast for ${predictedAddress} did not confirm; refusing to mine or deploy another salt until resume reconciliation proves its outcome. ` +
						(err instanceof Error ? err.message : String(err)),
				)
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
		diamondAddress = await confirmAndCount(diamond, "Diamond", "contracts.diamond.diamond", [owner.address, diamondCutFacetAddress])
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
		initAddress = await confirmAndCount(init, "Init", "contracts.diamond.init")
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
		libraryAddresses["LibQuoteFunding"] = await confirmAndCount(libQuoteFunding, "LibQuoteFunding", "contracts.diamond.libraries.LibQuoteFunding")
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
		libraryAddresses["LibQuoteClose"] = await confirmAndCount(libQuoteClose, "LibQuoteClose", "contracts.diamond.libraries.LibQuoteClose")
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
		// Ethers cannot parse the named enum/struct types emitted in this public
		// library's 0.8.18 ABI. The factory is deployment-only, so avoid inventing a
		// callable interface while keeping compiler bytecode/link references intact.
		const artifact = await hre.artifacts.readArtifact("LibForceActions")
		const LibForceActionsFactory = await ethers.getContractFactoryFromArtifact(deploymentOnlyArtifact(artifact), {
			libraries: {
				[LibraryLinkReferences.LibQuoteClose]: libraryAddresses["LibQuoteClose"],
			},
		})
		const libForceActions = await LibForceActionsFactory.deploy()
		libraryAddresses["LibForceActions"] = await confirmAndCount(libForceActions, "LibForceActions", "contracts.diamond.libraries.LibForceActions")
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
		libraryAddresses["LibSettlement"] = await confirmAndCount(libSettlement, "LibSettlement", "contracts.diamond.libraries.LibSettlement")
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
		libraryAddresses["LibPartyALiquidationProcess"] = await confirmAndCount(
			libPartyALiquidationProcess,
			"LibPartyALiquidationProcess",
			"contracts.diamond.libraries.LibPartyALiquidationProcess",
		)
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
		libraryAddresses["LibPartyALiquidationSnapshotSetup"] = await confirmAndCount(
			libPartyALiquidationSnapshotSetup,
			"LibPartyALiquidationSnapshotSetup",
			"contracts.diamond.libraries.LibPartyALiquidationSnapshotSetup",
		)
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
		libraryAddresses["LibPartyALiquidationLegacySetup"] = await confirmAndCount(
			libPartyALiquidationLegacySetup,
			"LibPartyALiquidationLegacySetup",
			"contracts.diamond.libraries.LibPartyALiquidationLegacySetup",
		)
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
			facetAddress = await confirmAndCount(facet, shortName, `contracts.diamond.facets.${shortName}`)
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

	// Upgrade Diamond with Facets (only if not already done). Resume and repair decisions
	// must compare selector OWNERS, not only selector presence: a complete selector set that
	// points at stale facet implementations is still a broken deployment.
	const expectedOwnerBySelector = new Map<string, string>()
	for (const entry of cut) {
		for (const selector of entry.functionSelectors) {
			const normalizedSelector = selector.toLowerCase()
			const priorOwner = expectedOwnerBySelector.get(normalizedSelector)
			if (priorOwner && priorOwner !== entry.facetAddress.toLowerCase()) {
				throw new Error(`Selector ${selector} is produced by more than one deployed facet (${priorOwner} and ${entry.facetAddress})`)
			}
			expectedOwnerBySelector.set(normalizedSelector, entry.facetAddress.toLowerCase())
		}
	}

	const installedOwnerBySelector = new Map<string, string>()
	const loupeIndex = FacetNames.findIndex(name => (name.includes(":") ? name.split(":").pop() : name) === "DiamondLoupeFacet")
	if (loupeIndex < 0) throw new Error("DiamondLoupeFacet is missing from the deployment facet list")
	const loupeEntry = cut[loupeIndex]
	const loupeSelectors = new Set(loupeEntry.functionSelectors.map(selector => selector.toLowerCase()))
	let loupeAvailable = true
	try {
		// facets() only exists once DiamondLoupeFacet has been cut in.
		const loupe = await ethers.getContractAt("IDiamondLoupe", diamondAddress)
		for (const facet of await loupe.facets()) {
			for (const selector of facet.functionSelectors) installedOwnerBySelector.set(selector.toLowerCase(), facet.facetAddress.toLowerCase())
		}
	} catch {
		loupeAvailable = false
	}

	if (!loupeAvailable) {
		// Bootstrap the loupe in its own no-init transaction. This makes an interruption
		// before the old second chunk recoverable: we can now discover selectors installed
		// by an earlier first chunk instead of blindly re-adding and reverting on duplicates.
		logger.info("  DiamondLoupeFacet is not available — bootstrapping it for exact resume inspection...")
		const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress)
		const receipt = await send(
			diamondCut.diamondCut([{ ...loupeEntry, action: FacetCutAction.Add }], ethers.ZeroAddress, "0x"),
			"bootstrap DiamondLoupeFacet",
		)
		totalGasUsed += receipt.gasUsed
		const loupe = await ethers.getContractAt("IDiamondLoupe", diamondAddress)
		for (const facet of await loupe.facets()) {
			for (const selector of facet.functionSelectors) installedOwnerBySelector.set(selector.toLowerCase(), facet.facetAddress.toLowerCase())
		}
	}

	const remainingCut: typeof cut = []
	for (const entry of cut) {
		const addSelectors: string[] = []
		const replaceSelectors: string[] = []
		for (const selector of entry.functionSelectors) {
			const currentOwner = installedOwnerBySelector.get(selector.toLowerCase())
			if (!currentOwner) addSelectors.push(selector)
			else if (currentOwner !== entry.facetAddress.toLowerCase()) replaceSelectors.push(selector)
		}
		if (addSelectors.length > 0) remainingCut.push({ ...entry, action: FacetCutAction.Add, functionSelectors: addSelectors })
		if (replaceSelectors.length > 0) remainingCut.push({ ...entry, action: FacetCutAction.Replace, functionSelectors: replaceSelectors })
	}

	const missingSelectorCount = [...expectedOwnerBySelector].filter(([selector]) => !installedOwnerBySelector.has(selector)).length
	const staleSelectorCount = [...expectedOwnerBySelector].filter(
		([selector, expectedOwner]) => installedOwnerBySelector.has(selector) && installedOwnerBySelector.get(selector) !== expectedOwner,
	).length

	// Init runs inside the first successful application-facet cut. If any expected selector
	// is installed, that transaction landed and init() has already executed.
	const initAlreadyRan = [...expectedOwnerBySelector.keys()].some(selector => !loupeSelectors.has(selector) && installedOwnerBySelector.has(selector))

	if (remainingCut.length === 0) {
		logger.info(`  ⏭ Diamond cut already complete (${expectedOwnerBySelector.size} selector owners verified on-chain)`)
		if (checkpoint) {
			diamondCheckpoint.diamondCutComplete = true
			checkpoint.contracts.diamond = diamondCheckpoint
			saveCheckpoint(checkpoint)
		}
	} else {
		logger.subsection("Diamond Cut")
		if (initAlreadyRan) {
			logger.error(
				`  ⚠ Incomplete/stale diamond cut detected: ${missingSelectorCount} missing and ${staleSelectorCount} misowned ` +
					`of ${expectedOwnerBySelector.size} selectors. Applying ${remainingCut.length} corrective cut entr${remainingCut.length === 1 ? "y" : "ies"}; ` +
					"skipping init() because it already ran.",
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
			const receipt = await send(diamondCut.diamondCut(chunk, initTarget, initCalldata), `apply diamond cut chunk ${chunkNum}/${totalChunks}`)
			totalGasUsed += receipt.gasUsed
			logger.progress(chunkNum, totalChunks, `Chunk ${chunkNum} (${chunk.length} facets) — ${receipt.hash}`)
		}

		// Assert every selector is mapped to the exact intended facet before recording success.
		const verifyLoupe = await ethers.getContractAt("IDiamondLoupe", diamondAddress)
		const finalOwnerBySelector = new Map<string, string>()
		for (const facet of await verifyLoupe.facets()) {
			for (const selector of facet.functionSelectors) finalOwnerBySelector.set(selector.toLowerCase(), facet.facetAddress.toLowerCase())
		}
		const mismatches = [...expectedOwnerBySelector].filter(([selector, ownerAddress]) => finalOwnerBySelector.get(selector) !== ownerAddress)
		if (mismatches.length > 0) {
			throw new Error(
				`Diamond cut verification failed: ${mismatches.length} of ${expectedOwnerBySelector.size} selectors have the wrong owner after the cut ` +
					`(e.g. ${mismatches
						.slice(0, 5)
						.map(([selector, ownerAddress]) => `${selector} expected ${ownerAddress}, got ${finalOwnerBySelector.get(selector) || "missing"}`)
						.join("; ")}). Refusing to mark the deployment complete.`,
			)
		}
		logger.info(`  ✓ All ${expectedOwnerBySelector.size} selector owners verified on-chain`)

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
	if (reportGas) logger.info(`  Total diamond deployment gas: ${totalGasUsed.toLocaleString("en-US")}`)
	if (genABI) logger.info("  ABI artifacts are generated by Hardhat during compilation; no additional ABI step is required.")

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
	.addOption({
		name: "genABI",
		description: "Confirm compile-generated ABI artifacts are available",
		type: ArgumentType.BOOLEAN,
		defaultValue: false,
	})
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.addOption({ name: "reportGas", description: "Report gas consumption and costs", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ logData, genABI, reportGas }, hre) => {
			await assertStandaloneDeploymentTaskAllowed(hre, "deploy:diamond")
			return deployDiamond(hre, { logData, genABI, reportGas })
		},
	}))
	.build()
