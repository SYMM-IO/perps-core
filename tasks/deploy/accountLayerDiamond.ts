import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { ContractTransactionReceipt } from "ethers"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { AccountLayerFacetNames, ensureLibraries, getFacetSpec, getLinkedContractFactory } from "../../utils/deploymentManifest.js"
import { FacetCutAction, getSelectors } from "../utils/diamondCut.js"
import { writeData } from "../utils/fs.js"
import { deploymentOnlyArtifact } from "./artifacts.js"
import { DeploymentCheckpoint, AccountLayerCheckpoint, createDeployedContract, saveCheckpoint } from "./checkpoint.js"
import { ACCOUNTLAYER_DEPLOYMENT_FILE } from "./constants.js"
import { checkpointDeployment, recoverCheckpointContractDeployments } from "./deploymentRecovery.js"
import { assertStandaloneDeploymentTaskAllowed, getConnection } from "./helpers.js"
import { logger } from "./logger.js"
import { confirmDeploymentWithReceipt, send } from "./tx.js"
import { type VanityContext, create2Record, deployContract } from "./vanityDeploy.js"

type DeployAccountLayerDiamondArgs = {
	admin: HardhatEthersSigner
	symmioFeeReceiver: HardhatEthersSigner
	logData?: boolean
	checkpoint?: DeploymentCheckpoint
	vanity?: VanityContext | null
}

export async function deployAccountLayerDiamond(
	hre: any,
	{ admin, symmioFeeReceiver, logData = false, checkpoint, vanity = null }: DeployAccountLayerDiamondArgs,
) {
	const { ethers } = await getConnection(hre)
	await recoverCheckpointContractDeployments(checkpoint, ethers.provider, "contracts.accountLayerDiamond")
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
		const result = await deployContract(vanity, {
			key: "accountLayer/DiamondCutFacet",
			component: "contracts.accountLayerDiamond.diamondCutFacet",
			label: "AccountLayer DiamondCutFacet",
			factory: DiamondCutFacetFactory,
			checkpoint,
		})
		totalGasUsed += result.gasUsed
		diamondCutFacetAddress = result.address
		logger.deployed("DiamondCutFacet", diamondCutFacetAddress)

		// Save checkpoint
		if (checkpoint) {
			alCheckpoint.diamondCutFacet = createDeployedContract(diamondCutFacetAddress, undefined, create2Record(result))
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
		const result = await deployContract(vanity, {
			key: "accountLayer/Diamond",
			component: "contracts.accountLayerDiamond.diamond",
			label: "AccountLayer Diamond",
			factory: DiamondFactory,
			constructorArgs: [admin.address, diamondCutFacetAddress],
			checkpoint,
		})
		totalGasUsed += result.gasUsed
		diamondAddress = result.address
		logger.deployed("AccountLayerDiamond", diamondAddress)

		// Save checkpoint
		if (checkpoint) {
			alCheckpoint.diamond = createDeployedContract(diamondAddress, [admin.address, diamondCutFacetAddress], create2Record(result))
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
		const result = await deployContract(vanity, {
			key: "accountLayer/Init",
			component: "contracts.accountLayerDiamond.init",
			label: "AccountLayer Init",
			factory: InitFactory,
			checkpoint,
		})
		totalGasUsed += result.gasUsed
		initAddress = result.address
		logger.deployed("Init", initAddress)

		// Save checkpoint
		if (checkpoint) {
			alCheckpoint.init = createDeployedContract(initAddress, undefined, create2Record(result))
			checkpoint.contracts.accountLayerDiamond = alCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	// Deploy external libraries through the same graph used by upgrades.
	logger.subsection("Libraries")
	if (!alCheckpoint.libraries) {
		alCheckpoint.libraries = {}
	}
	const ensuredLibraries = await ensureLibraries({
		ethers,
		scope: "accountLayer",
		existing: libraryAddresses,
		onReused: (name, address) => logger.info(`  ⏭ ${name} already deployed at ${address}`),
		getFactory: async spec => {
			const artifact = await hre.artifacts.readArtifact(spec.artifact)
			return ethers.getContractFactoryFromArtifact(deploymentOnlyArtifact(artifact))
		},
		deploy: async (name, factory) => {
			const result = await deployContract(vanity, {
				key: `accountLayer/${name}`,
				component: `contracts.accountLayerDiamond.libraries.${name}`,
				label: `AccountLayer ${name}`,
				factory,
				checkpoint,
			})
			totalGasUsed += result.gasUsed
			logger.deployed(name, result.address)
			if (checkpoint) {
				alCheckpoint.libraries![name] = createDeployedContract(result.address, undefined, create2Record(result))
				checkpoint.contracts.accountLayerDiamond = alCheckpoint
				saveCheckpoint(checkpoint)
			}
			return { address: result.address }
		},
	})
	Object.assign(libraryAddresses, ensuredLibraries)

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
			const FacetFactory = await getLinkedContractFactory(ethers, "accountLayer", getFacetSpec("accountLayer", facetName), libraryAddresses)

			const result = await deployContract(vanity, {
				key: `accountLayer/${facetName}`,
				component: `contracts.accountLayerDiamond.facets.${facetName}`,
				label: `AccountLayer ${facetName}`,
				factory: FacetFactory,
				checkpoint,
			})
			totalGasUsed += result.gasUsed
			facetAddress = result.address
			logger.deployed(`[${i + 1}/${AccountLayerFacetNames.length}] ${facetName}`, facetAddress)

			// Save checkpoint
			if (checkpoint) {
				alCheckpoint.facets![facetName] = createDeployedContract(facetAddress, undefined, create2Record(result))
				checkpoint.contracts.accountLayerDiamond = alCheckpoint
				saveCheckpoint(checkpoint)
			}
		}

		// Get facet contract for selectors without rebuilding link options.
		const facet = await ethers.getContractAt(getFacetSpec("accountLayer", facetName).artifact, facetAddress)
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

	// Build a recovery cut from the selector mapping itself. Checking one convenient
	// ControlFacet function is not enough: ControlFacet lands in chunk 2, so a failure before
	// chunk 3 used to make a partial AccountLayer look complete forever.
	const diamondStoragePosition = ethers.keccak256(ethers.toUtf8Bytes("diamond.standard.diamond.storage"))
	const abiCoder = ethers.AbiCoder.defaultAbiCoder()
	const installedFacetFor = async (selector: string): Promise<string> => {
		const storageSlot = ethers.keccak256(abiCoder.encode(["bytes4", "bytes32"], [selector, diamondStoragePosition]))
		const raw = await ethers.provider.getStorage(diamondAddress, storageSlot)
		return ethers.getAddress(`0x${raw.slice(-40)}`)
	}

	const recoveryCut: typeof cut = []
	let installedExpectedSelectors = 0
	for (const entry of cut) {
		const add: string[] = []
		const replace: string[] = []
		for (const selector of entry.functionSelectors) {
			const installed = await installedFacetFor(selector)
			if (installed === ethers.ZeroAddress) {
				add.push(selector)
			} else {
				installedExpectedSelectors++
				if (installed.toLowerCase() !== entry.facetAddress.toLowerCase()) replace.push(selector)
			}
		}
		if (add.length > 0) recoveryCut.push({ facetAddress: entry.facetAddress, action: FacetCutAction.Add, functionSelectors: add })
		if (replace.length > 0) recoveryCut.push({ facetAddress: entry.facetAddress, action: FacetCutAction.Replace, functionSelectors: replace })
	}

	if (recoveryCut.length > 0) {
		logger.subsection("Diamond Cut")
		if (installedExpectedSelectors > 0) {
			logger.info(`  ⚠ Partial AccountLayer cut detected; recovering ${recoveryCut.length} missing or mismatched facet selector group(s).`)
		}

		const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress)
		const init = await ethers.getContractAt("contracts/accountLayer/Init.sol:Init", initAddress)
		const call = init.interface.encodeFunctionData("init", [admin.address, symmioFeeReceiver.address, accountManagerBytecode])
		const initAlreadyRan = installedExpectedSelectors > 0

		const chunkSize = 3
		const totalChunks = Math.ceil(recoveryCut.length / chunkSize)
		for (let i = 0; i < recoveryCut.length; i += chunkSize) {
			const chunk = recoveryCut.slice(i, i + chunkSize)
			const chunkNum = Math.floor(i / chunkSize) + 1
			const runInit = i === 0 && !initAlreadyRan
			receipt = await send(
				diamondCut.diamondCut(chunk, runInit ? initAddress : ethers.ZeroAddress, runInit ? call : "0x"),
				`AccountLayer diamondCut chunk ${chunkNum}/${totalChunks}`,
			)
			totalGasUsed += receipt.gasUsed
			logger.progress(chunkNum, totalChunks, `Chunk ${chunkNum}/${totalChunks} (${chunk.length} selector groups) — ${receipt.hash}`)
		}
	}

	// Exact final assertion: no expected selector may be absent or mapped to a different
	// facet, and no extra selector may have slipped into this fresh deployment.
	const diamondCutFacet = await ethers.getContractAt("DiamondCutFacet", diamondCutFacetAddress)
	const expectedOwnerBySelector = new Map<string, string>()
	for (const selector of getSelectors(ethers, diamondCutFacet as any).selectors) {
		expectedOwnerBySelector.set(selector.toLowerCase(), diamondCutFacetAddress.toLowerCase())
	}
	for (const entry of cut) {
		for (const selector of entry.functionSelectors) {
			const key = selector.toLowerCase()
			const prior = expectedOwnerBySelector.get(key)
			if (prior && prior !== entry.facetAddress.toLowerCase()) throw new Error(`Duplicate AccountLayer selector ${selector} across expected facets`)
			expectedOwnerBySelector.set(key, entry.facetAddress.toLowerCase())
		}
	}

	const loupe = await ethers.getContractAt("IDiamondLoupe", diamondAddress)
	const actualOwnerBySelector = new Map<string, string>()
	for (const facet of await loupe.facets()) {
		for (const selector of facet.functionSelectors) actualOwnerBySelector.set(selector.toLowerCase(), facet.facetAddress.toLowerCase())
	}
	const missing = [...expectedOwnerBySelector].filter(([selector, owner]) => actualOwnerBySelector.get(selector) !== owner)
	const unexpected = [...actualOwnerBySelector.keys()].filter(selector => !expectedOwnerBySelector.has(selector))
	if (missing.length > 0 || unexpected.length > 0) {
		throw new Error(
			`AccountLayer selector verification failed: ${missing.length} missing/mismatched, ${unexpected.length} unexpected` +
				(missing.length > 0
					? ` (e.g. ${missing
							.slice(0, 5)
							.map(([selector]) => selector)
							.join(", ")})`
					: ""),
		)
	}
	logger.info(`  ✓ AccountLayer selector set verified exactly (${expectedOwnerBySelector.size} selectors)`)

	if (checkpoint) {
		alCheckpoint.diamondCutComplete = true
		checkpoint.contracts.accountLayerDiamond = alCheckpoint
		saveCheckpoint(checkpoint)
	}

	logger.complete("AccountLayer Diamond Deployment", [
		{ name: "AccountLayerDiamond", address: diamondAddress },
		{ name: "DiamondCutFacet", address: diamondCutFacetAddress },
		{ name: "Init", address: initAddress },
	])

	// Write deployment log for verification
	if (logData) {
		// Map facet names to their full contract paths for verification
		const facetVerificationMap: Record<string, string> = {
			CoreFacet: "contracts/accountLayer/facets/Core/CoreFacet.sol:CoreFacet",
			MarginFacet: "contracts/accountLayer/facets/Margin/MarginFacet.sol:MarginFacet",
			SymmioHookFacet: "contracts/accountLayer/facets/SymmioHook/SymmioHookFacet.sol:SymmioHookFacet",
			ControlFacet: "contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet",
			ViewFacet: "contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet",
			AffiliateFacet: "contracts/accountLayer/facets/Affiliate/AffiliateFacet.sol:AffiliateFacet",
			DiamondLoupeFacet: "contracts/diamond/facets/DiamondLoup/DiamondLoupeFacet.sol:DiamondLoupeFacet",
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
				name: facetVerificationMap[facet.name] || `contracts/accountLayer/facets/${facet.name.replace("Facet", "")}/${facet.name}.sol:${facet.name}`,
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

export const accountLayerDiamondTask = task("deploy:accountLayer", "Deploys the AccountLayer diamond (unified account and affiliate management)")
	.addOption({ name: "logData", description: "Log deployment data to file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ logData }, hre) => {
			await assertStandaloneDeploymentTaskAllowed(hre, "deploy:accountLayer")
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
