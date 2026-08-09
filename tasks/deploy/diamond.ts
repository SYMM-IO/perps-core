import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { FacetCutAction, getSelectors } from "../utils/diamondCut.js"
import { writeData } from "../utils/fs.js"
import { deploymentOnlyArtifact } from "./artifacts.js"
import { DeploymentCheckpoint, DiamondCheckpoint, createDeployedContract, saveCheckpoint } from "./checkpoint.js"
import { DEPLOYMENT_LOG_FILE, FacetNames } from "./constants.js"
import { recoverCheckpointContractDeployments } from "./deploymentRecovery.js"
import { assertStandaloneDeploymentTaskAllowed, getConnection } from "./helpers.js"
import { logger } from "./logger.js"
import { send } from "./tx.js"
import { type VanityContext, create2Record, deployContract } from "./vanityDeploy.js"

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
	vanity?: VanityContext | null
}

/** An explicitly requested deterministic factory is a safety requirement, not a hint. */
export async function resolveCreate2FactoryAddress(ethers: any, configuredAddress: string): Promise<string> {
	if (!configuredAddress) return ""
	let address: string
	try {
		address = ethers.getAddress(configuredAddress)
	} catch (error) {
		throw new Error(
			`create2.factoryAddress is invalid: ${JSON.stringify(configuredAddress)} (${error instanceof Error ? error.message : String(error)})`,
		)
	}
	const factoryCode = await ethers.provider.getCode(address)
	if (!factoryCode || factoryCode === "0x") {
		throw new Error(
			`create2.factoryAddress ${address} was explicitly configured but has no code on this network; refusing to change the address strategy to ordinary CREATE.`,
		)
	}
	return address
}

export async function deployDiamond(
	hre: any,
	{ logData = true, genABI = false, reportGas = true, checkpoint, vanity = null }: DeployDiamondArgs = {},
) {
	const { ethers } = await getConnection(hre)
	await recoverCheckpointContractDeployments(checkpoint, ethers.provider, "contracts.diamond")
	const signers: HardhatEthersSigner[] = await ethers.getSigners()
	const owner: HardhatEthersSigner = signers[0]
	let totalGasUsed = BigInt(0)

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
		const result = await deployContract(vanity, {
			key: "core/DiamondCutFacet",
			component: "contracts.diamond.diamondCutFacet",
			label: "DiamondCutFacet",
			factory: DiamondCutFacetFactory,
			checkpoint,
		})
		totalGasUsed += result.gasUsed
		diamondCutFacetAddress = result.address
		logger.deployed("DiamondCutFacet", diamondCutFacetAddress)

		// Save checkpoint
		if (checkpoint) {
			diamondCheckpoint.diamondCutFacet = createDeployedContract(diamondCutFacetAddress, undefined, create2Record(result))
			checkpoint.contracts.diamond = diamondCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	let diamondAddress: string
	let diamond: any
	const diamondArgs = [owner.address, diamondCutFacetAddress]
	if (diamondCheckpoint.diamond) {
		diamondAddress = diamondCheckpoint.diamond.address
		diamond = await ethers.getContractAt("Diamond", diamondAddress)
		logger.info(`  ⏭ Diamond already deployed at ${diamondAddress}`)
	} else {
		const DiamondFactory = await ethers.getContractFactory("Diamond")
		const result = await deployContract(vanity, {
			key: "core/Diamond",
			component: "contracts.diamond.diamond",
			label: "Diamond",
			factory: DiamondFactory,
			constructorArgs: diamondArgs,
			checkpoint,
		})
		totalGasUsed += result.gasUsed
		diamondAddress = result.address
		diamond = await ethers.getContractAt("Diamond", diamondAddress)
		logger.deployed("Diamond", diamondAddress)

		// Save checkpoint
		if (checkpoint) {
			diamondCheckpoint.diamond = createDeployedContract(diamondAddress, diamondArgs, create2Record(result))
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
		const result = await deployContract(vanity, {
			key: "core/Init",
			component: "contracts.diamond.init",
			label: "Init",
			factory: InitFactory,
			checkpoint,
		})
		totalGasUsed += result.gasUsed
		initAddress = result.address
		logger.deployed("Init", initAddress)

		// Save checkpoint
		if (checkpoint) {
			diamondCheckpoint.init = createDeployedContract(initAddress, undefined, create2Record(result))
			checkpoint.contracts.diamond = diamondCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	// Deploy external libraries first
	logger.subsection("Libraries")
	if (!diamondCheckpoint.libraries) {
		diamondCheckpoint.libraries = {}
	}

	// Libraries differ only in name and how their factory is built, so the deploy, gas
	// accounting, and checkpoint write are shared rather than repeated seven times.
	const deployLibrary = async (name: string, buildFactory: () => Promise<any>): Promise<void> => {
		if (libraryAddresses[name]) {
			logger.info(`  ⏭ ${name} already deployed at ${libraryAddresses[name]}`)
			return
		}
		const result = await deployContract(vanity, {
			key: `core/${name}`,
			component: `contracts.diamond.libraries.${name}`,
			label: name,
			factory: await buildFactory(),
			checkpoint,
		})
		totalGasUsed += result.gasUsed
		libraryAddresses[name] = result.address
		logger.deployed(name, result.address)

		if (checkpoint) {
			diamondCheckpoint.libraries![name] = createDeployedContract(result.address, undefined, create2Record(result))
			checkpoint.contracts.diamond = diamondCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	// LibQuoteFunding has no dependencies; each later library links against those above it.
	await deployLibrary("LibQuoteFunding", () => ethers.getContractFactory("LibQuoteFunding"))

	await deployLibrary("LibQuoteClose", () =>
		ethers.getContractFactory("LibQuoteClose", {
			libraries: {
				[LibraryLinkReferences.LibQuoteFunding]: libraryAddresses["LibQuoteFunding"],
			},
		}),
	)

	await deployLibrary("LibForceActions", async () => {
		// Ethers cannot parse the named enum/struct types emitted in this public
		// library's 0.8.18 ABI. The factory is deployment-only, so avoid inventing a
		// callable interface while keeping compiler bytecode/link references intact.
		const artifact = await hre.artifacts.readArtifact("LibForceActions")
		return ethers.getContractFactoryFromArtifact(deploymentOnlyArtifact(artifact), {
			libraries: {
				[LibraryLinkReferences.LibQuoteClose]: libraryAddresses["LibQuoteClose"],
			},
		})
	})

	await deployLibrary("LibSettlement", () => ethers.getContractFactory("LibSettlement"))

	await deployLibrary("LibPartyALiquidationProcess", () =>
		ethers.getContractFactory("LibPartyALiquidationProcess", {
			libraries: {
				[LibraryLinkReferences.LibQuoteFunding]: libraryAddresses["LibQuoteFunding"],
			},
		}),
	)

	await deployLibrary("LibPartyALiquidationSnapshotSetup", () => ethers.getContractFactory("LibPartyALiquidationSnapshotSetup"))

	await deployLibrary("LibPartyALiquidationLegacySetup", () => ethers.getContractFactory("LibPartyALiquidationLegacySetup"))

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

			const result = await deployContract(vanity, {
				key: `core/${shortName}`,
				component: `contracts.diamond.facets.${shortName}`,
				label: shortName,
				factory: FacetFactory,
				checkpoint,
			})
			totalGasUsed += result.gasUsed
			facetAddress = result.address
			logger.deployed(`[${i + 1}/${FacetNames.length}] ${shortName}`, facetAddress)

			// Save checkpoint
			if (checkpoint) {
				diamondCheckpoint.facets![shortName] = createDeployedContract(facetAddress, undefined, create2Record(result))
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
