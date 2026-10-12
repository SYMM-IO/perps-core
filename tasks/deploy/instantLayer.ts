import { ContractTransactionReceipt } from "ethers"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { getFacetSpec, getLinkedContractFactory, InstantLayerFacetNames } from "../../utils/deploymentManifest.js"
import { FacetCutAction, getSelectors } from "../utils/diamondCut.js"
import { writeData } from "../utils/fs.js"
import { createDeployedContract, DeploymentCheckpoint, InstantLayerDiamondCheckpoint, saveCheckpoint } from "./checkpoint.js"
import { INSTANTLAYER_DEPLOYMENT_FILE } from "./constants.js"
import { recoverCheckpointContractDeployments } from "./deploymentRecovery.js"
import { assertStandaloneDeploymentTaskAllowed, getConnection, requireArg } from "./helpers.js"
import { logger } from "./logger.js"
import { send } from "./tx.js"
import { create2Record, deployContract, type VanityContext } from "./vanityDeploy.js"

const INIT_FQN = "contracts/instantLayer/Init.sol:Init"

type DeployInstantLayerArgs = {
	symmioaddress: string
	admin: string
	/** Signer that deploys and cuts. Defaults to the first configured signer. */
	deployer?: any
	logData?: boolean
	checkpoint?: DeploymentCheckpoint
	/** Present when the owning deployment mines CREATE2 addresses; null for standalone runs. */
	vanity?: VanityContext | null
}

export async function deployInstantLayer(hre: any, args: DeployInstantLayerArgs) {
	const { ethers } = await getConnection(hre)
	const [defaultSigner] = await ethers.getSigners()
	return deployInstantLayerWith(ethers, { ...args, deployer: args.deployer ?? defaultSigner })
}

/**
 * Deploys the InstantLayer diamond with an explicit signer: DiamondCutFacet, Diamond, Init, the
 * five InstantLayer facets and DiamondLoupeFacet, then a diamondCut that runs Init.init.
 *
 * The deployer owns the diamond while it cuts. Init grants the roles to `admin`. When `admin`
 * is another address it becomes pending owner and accepts ownership later.
 */
export async function deployInstantLayerWith(
	ethers: any,
	{ symmioaddress, admin, deployer, logData = true, checkpoint, vanity = null }: DeployInstantLayerArgs & { deployer: any },
) {
	const deploySigner = deployer
	const deployerAddress = ethers.getAddress(await deploySigner.getAddress())

	await recoverCheckpointContractDeployments(checkpoint, ethers.provider, "contracts.instantLayerDiamond")
	let totalGasUsed = BigInt(0)
	let receipt: ContractTransactionReceipt

	logger.section("InstantLayer Diamond Deployment")

	// Initialize or restore checkpoint data
	const ilCheckpoint: InstantLayerDiamondCheckpoint = checkpoint?.contracts.instantLayerDiamond || {}

	// Deploy DiamondCutFacet
	logger.subsection("Core Contracts")
	let diamondCutFacetAddress: string
	if (ilCheckpoint.diamondCutFacet) {
		diamondCutFacetAddress = ilCheckpoint.diamondCutFacet.address
		logger.reused("DiamondCutFacet", diamondCutFacetAddress)
	} else {
		const DiamondCutFacetFactory = (await ethers.getContractFactory("DiamondCutFacet")).connect(deploySigner)
		const result = await deployContract(vanity, {
			key: "instantLayer/DiamondCutFacet",
			component: "contracts.instantLayerDiamond.diamondCutFacet",
			label: "InstantLayer DiamondCutFacet",
			factory: DiamondCutFacetFactory,
			checkpoint,
		})
		totalGasUsed += result.gasUsed
		diamondCutFacetAddress = result.address
		logger.deployed("DiamondCutFacet", diamondCutFacetAddress)

		if (checkpoint) {
			ilCheckpoint.diamondCutFacet = createDeployedContract(diamondCutFacetAddress, undefined, create2Record(result))
			checkpoint.contracts.instantLayerDiamond = ilCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	// Deploy Diamond
	// The deployer owns the diamond so it can cut; ownership moves to admin after the cut.
	let diamondAddress: string
	if (ilCheckpoint.diamond) {
		diamondAddress = ilCheckpoint.diamond.address
		logger.reused("InstantLayerDiamond", diamondAddress)
	} else {
		const DiamondFactory = (await ethers.getContractFactory("Diamond")).connect(deploySigner)
		const result = await deployContract(vanity, {
			key: "instantLayer/Diamond",
			component: "contracts.instantLayerDiamond.diamond",
			label: "InstantLayer Diamond",
			factory: DiamondFactory,
			constructorArgs: [deployerAddress, diamondCutFacetAddress],
			checkpoint,
		})
		totalGasUsed += result.gasUsed
		diamondAddress = result.address
		logger.deployed("InstantLayerDiamond", diamondAddress)

		if (checkpoint) {
			ilCheckpoint.diamond = createDeployedContract(diamondAddress, [deployerAddress, diamondCutFacetAddress], create2Record(result))
			checkpoint.contracts.instantLayerDiamond = ilCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	// Deploy Init
	let initAddress: string
	if (ilCheckpoint.init) {
		initAddress = ilCheckpoint.init.address
		logger.reused("Init", initAddress)
	} else {
		const InitFactory = (await ethers.getContractFactory(INIT_FQN)).connect(deploySigner)
		const result = await deployContract(vanity, {
			key: "instantLayer/Init",
			component: "contracts.instantLayerDiamond.init",
			label: "InstantLayer Init",
			factory: InitFactory,
			checkpoint,
		})
		totalGasUsed += result.gasUsed
		initAddress = result.address
		logger.deployed("Init", initAddress)

		if (checkpoint) {
			ilCheckpoint.init = createDeployedContract(initAddress, undefined, create2Record(result))
			checkpoint.contracts.instantLayerDiamond = ilCheckpoint
			saveCheckpoint(checkpoint)
		}
	}

	// InstantLayer facets have no constructor arguments and no linked external libraries: the
	// shared libraries they use are internal and the compiler inlines them. Unlike AccountLayer,
	// there is no library-deployment stage here.
	const cut: Array<{
		facetAddress: string
		action: FacetCutAction
		functionSelectors: string[]
	}> = []

	const deployedFacets: Array<{
		name: string
		address: string
	}> = []

	if (!ilCheckpoint.facets) {
		ilCheckpoint.facets = {}
	}

	logger.subsection(`Facets (${InstantLayerFacetNames.length} total)`)
	for (let i = 0; i < InstantLayerFacetNames.length; i++) {
		const facetName = InstantLayerFacetNames[i]

		let facetAddress: string

		// Check if already deployed
		if (ilCheckpoint.facets[facetName]) {
			facetAddress = ilCheckpoint.facets[facetName].address
			logger.reused(`[${i + 1}/${InstantLayerFacetNames.length}] ${facetName}`, facetAddress)
		} else {
			const FacetFactory = (await getLinkedContractFactory(ethers, "instantLayer", getFacetSpec("instantLayer", facetName), {})).connect(deploySigner)

			const result = await deployContract(vanity, {
				key: `instantLayer/${facetName}`,
				component: `contracts.instantLayerDiamond.facets.${facetName}`,
				label: `InstantLayer ${facetName}`,
				factory: FacetFactory,
				checkpoint,
			})
			totalGasUsed += result.gasUsed
			facetAddress = result.address
			logger.deployed(`[${i + 1}/${InstantLayerFacetNames.length}] ${facetName}`, facetAddress)

			// Save checkpoint
			if (checkpoint) {
				ilCheckpoint.facets![facetName] = createDeployedContract(facetAddress, undefined, create2Record(result))
				checkpoint.contracts.instantLayerDiamond = ilCheckpoint
				saveCheckpoint(checkpoint)
			}
		}

		// Get facet contract for selectors and ABI fragments without rebuilding link options.
		const facet = await ethers.getContractAt(getFacetSpec("instantLayer", facetName).artifact, facetAddress)
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

	// Build a recovery cut from the selector mapping itself, the same approach
	// accountLayerDiamond.ts uses: one convenient function check is not enough to confirm the cut
	// is complete, because a failure partway through the chunked diamondCut below would otherwise
	// leave a partial InstantLayer diamond that this function has no way to detect on resume.
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
			logger.info(`  ⚠ Partial InstantLayer cut detected; recovering ${recoveryCut.length} missing or mismatched facet selector group(s).`)
		}

		const diamondCut = (await ethers.getContractAt("IDiamondCut", diamondAddress)).connect(deploySigner)
		const init = await ethers.getContractAt(INIT_FQN, initAddress)
		const call = init.interface.encodeFunctionData("init", [symmioaddress, admin])
		const initAlreadyRan = installedExpectedSelectors > 0

		const chunkSize = 3
		const totalChunks = Math.ceil(recoveryCut.length / chunkSize)
		for (let i = 0; i < recoveryCut.length; i += chunkSize) {
			const chunk = recoveryCut.slice(i, i + chunkSize)
			const chunkNum = Math.floor(i / chunkSize) + 1
			const runInit = i === 0 && !initAlreadyRan
			receipt = await send(
				diamondCut.diamondCut(chunk, runInit ? initAddress : ethers.ZeroAddress, runInit ? call : "0x"),
				`InstantLayer diamondCut chunk ${chunkNum}/${totalChunks}`,
			)
			totalGasUsed += receipt.gasUsed
			logger.progress(chunkNum, totalChunks, `Chunk ${chunkNum}/${totalChunks} (${chunk.length} selector groups) — ${receipt.hash}`)
		}
	}

	// Exact final assertion: no expected selector may be absent or mapped to a different facet,
	// and no extra selector may have slipped into this fresh deployment.
	const diamondCutFacet = await ethers.getContractAt("DiamondCutFacet", diamondCutFacetAddress)
	const expectedOwnerBySelector = new Map<string, string>()
	for (const selector of getSelectors(ethers, diamondCutFacet as any).selectors) {
		expectedOwnerBySelector.set(selector.toLowerCase(), diamondCutFacetAddress.toLowerCase())
	}
	for (const entry of cut) {
		for (const selector of entry.functionSelectors) {
			const key = selector.toLowerCase()
			const prior = expectedOwnerBySelector.get(key)
			if (prior && prior !== entry.facetAddress.toLowerCase()) throw new Error(`Duplicate InstantLayer selector ${selector} across expected facets`)
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
			`InstantLayer selector verification failed: ${missing.length} missing/mismatched, ${unexpected.length} unexpected` +
				(missing.length > 0
					? ` (e.g. ${missing
							.slice(0, 5)
							.map(([selector]) => selector)
							.join(", ")})`
					: ""),
		)
	}
	logger.info(`  ✓ InstantLayer selector set verified exactly (${expectedOwnerBySelector.size} selectors)`)

	if (checkpoint) {
		ilCheckpoint.diamondCutComplete = true
		checkpoint.contracts.instantLayerDiamond = ilCheckpoint
		saveCheckpoint(checkpoint)
	}

	const adminAddress = ethers.getAddress(admin)
	const owned = (await ethers.getContractAt("IInstantLayerDiamond", diamondAddress)).connect(deploySigner)
	let owner = ethers.getAddress(await owned.getOwner())
	let pendingOwner = ethers.getAddress(await owned.pendingOwner())
	if (adminAddress !== deployerAddress && owner === deployerAddress && pendingOwner !== adminAddress) {
		receipt = await send(owned.transferOwnership(admin), "InstantLayer transferOwnership to admin")
		totalGasUsed += receipt.gasUsed
		owner = ethers.getAddress(await owned.getOwner())
		pendingOwner = ethers.getAddress(await owned.pendingOwner())
	}
	// Ownership may already have moved on: deploy:system hands the diamond to governance after this
	// step and then resumes through it. Callers that know the intended final owner assert it.
	if (pendingOwner === adminAddress) {
		logger.info(`  Admin ${adminAddress} must call acceptOwnership() on InstantLayer: ${diamondAddress}`)
	} else if (owner !== adminAddress) {
		logger.info(`  InstantLayer ${diamondAddress} is owned by ${owner}; admin ${adminAddress} is neither owner nor pending owner`)
	}

	logger.complete("InstantLayer Diamond Deployment", [
		{ name: "InstantLayerDiamond", address: diamondAddress },
		{ name: "DiamondCutFacet", address: diamondCutFacetAddress },
		{ name: "Init", address: initAddress },
	])

	// Write deployment log for verification
	if (logData) {
		writeData(INSTANTLAYER_DEPLOYMENT_FILE, [
			{
				name: "DiamondCutFacet",
				address: diamondCutFacetAddress,
				constructorArguments: [],
			},
			{
				name: "Diamond",
				address: diamondAddress,
				constructorArguments: [deployerAddress, diamondCutFacetAddress],
			},
			{
				name: INIT_FQN,
				address: initAddress,
				constructorArguments: [],
			},
			...deployedFacets.map(facet => ({
				name: getFacetSpec("instantLayer", facet.name).artifact,
				address: facet.address,
				constructorArguments: [],
			})),
		])
	}

	return (await ethers.getContractAt("IInstantLayerDiamond", diamondAddress)).connect(deploySigner)
}

export const instantLayerTask = task("deploy:InstantLayer", "Deploys the InstantLayer diamond")
	.addOption({
		name: "symmioaddress",
		description: "The address of the Symmio contract",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({ name: "admin", description: "The admin address", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ symmioaddress, admin, logData }, hre) => {
			await assertStandaloneDeploymentTaskAllowed(hre, "deploy:InstantLayer")
			return deployInstantLayer(hre, {
				symmioaddress: requireArg(symmioaddress, "symmioaddress"),
				admin: requireArg(admin, "admin"),
				logData,
			})
		},
	}))
	.build()
