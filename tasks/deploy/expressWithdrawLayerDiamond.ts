import type { HardhatRuntimeEnvironment } from "hardhat/types/hre"
import type { NetworkConnection } from "hardhat/types/network"

import { FacetCutAction, getSelectors } from "../utils/diamondCut.js"
import { createDeployedContract, DeploymentCheckpoint, ExpressProviderCheckpoint, saveCheckpoint } from "./checkpoint.js"
import { checkpointDeployment, recoverCheckpointContractDeployments } from "./deploymentRecovery.js"
import { getConnection } from "./helpers.js"
import { logger } from "./logger.js"
import { assertStandaloneDeploymentTaskAllowed } from "./safety.js"
import { confirmDeploymentWithReceipt, send } from "./tx.js"

/** Fully qualified so an ambiguous facet name never resolves to the core/accountLayer twin. */
export const EXPRESS_FACETS: Record<string, string> = {
	DiamondLoupeFacet: "contracts/diamond/facets/DiamondLoup/DiamondLoupeFacet.sol:DiamondLoupeFacet",
	ControlFacet: "contracts/expressWithdrawLayer/facets/Control/ControlFacet.sol:ControlFacet",
	SymmioHookFacet: "contracts/expressWithdrawLayer/facets/SymmioHook/SymmioHookFacet.sol:SymmioHookFacet",
	OperatorFacet: "contracts/expressWithdrawLayer/facets/Operator/OperatorFacet.sol:OperatorFacet",
	AccelerateFacet: "contracts/expressWithdrawLayer/facets/Accelerate/AccelerateFacet.sol:AccelerateFacet",
	ViewFacet: "contracts/expressWithdrawLayer/facets/View/ViewFacet.sol:ViewFacet",
}
export const EXPRESS_INIT = "contracts/expressWithdrawLayer/Init.sol:Init"
export const EXPRESS_CONTROL_FACET = EXPRESS_FACETS.ControlFacet
export const EXPRESS_SYMMIO_INTERFACE = "contracts/expressWithdrawLayer/interfaces/ISymmio.sol:ISymmio"

export interface ExpressDiamondDeployment {
	diamond: string
	diamondCutFacet: string
	init: string
	facets: Array<{ name: string; address: string }>
}

export interface DeployExpressDiamondArgs {
	/** Diamond constructor owner. Must be the deploying signer, since only the owner may cut. */
	owner: string
	/**
	 * Recipient of the four roles Init grants (SETTER, FEE_CLAIMER, WITHDRAWER, PAUSER).
	 * Defaults to `owner`. The recipe workflow points this at the deployer so it can configure
	 * the provider, then grants the final admin and revokes the deployer.
	 */
	initAdmin?: string
	symmio: string
	collateral: string
	checkpoint?: DeploymentCheckpoint
}

/**
 * Deploy the ExpressProvider diamond with checkpointed, resumable steps.
 *
 * Every creation is journaled through confirmDeploymentWithReceipt, so an interrupted run
 * recovers the exact address instead of broadcasting a second deployment. The cut is rebuilt
 * from the live selector map rather than a "did it finish" flag, so a partially applied cut is
 * repaired rather than mistaken for a complete one.
 */
export async function deployExpressProviderDiamond(
	hre: HardhatRuntimeEnvironment,
	{ owner, initAdmin, symmio, collateral, checkpoint }: DeployExpressDiamondArgs,
): Promise<ExpressDiamondDeployment> {
	const { ethers } = await getConnection(hre)
	const roleRecipient = initAdmin || owner
	await recoverCheckpointContractDeployments(checkpoint, ethers.provider, "contracts.expressProvider")
	const epCheckpoint: ExpressProviderCheckpoint = checkpoint?.contracts.expressProvider || {}
	const persist = () => {
		if (!checkpoint) return
		checkpoint.contracts.expressProvider = epCheckpoint
		saveCheckpoint(checkpoint)
	}

	logger.section("ExpressProvider Diamond Deployment")

	// Init reverts unless the collateral matches what core reports, so prove it before gas.
	const core = await ethers.getContractAt(EXPRESS_SYMMIO_INTERFACE, symmio)
	const coreCollateral = ethers.getAddress(await core.getCollateral())
	if (coreCollateral !== ethers.getAddress(collateral)) {
		throw new Error(`ExpressProvider collateral ${collateral} does not match core ${symmio} collateral ${coreCollateral}`)
	}

	logger.subsection("Core Contracts")
	let diamondCutFacetAddress: string
	if (epCheckpoint.diamondCutFacet) {
		diamondCutFacetAddress = epCheckpoint.diamondCutFacet.address
		logger.info(`  ⏭ DiamondCutFacet already deployed at ${diamondCutFacetAddress}`)
	} else {
		const factory = await ethers.getContractFactory("DiamondCutFacet")
		const deployment = await confirmDeploymentWithReceipt(
			await factory.deploy(),
			"Express DiamondCutFacet",
			checkpointDeployment(checkpoint, "contracts.expressProvider.diamondCutFacet"),
		)
		diamondCutFacetAddress = deployment.address
		epCheckpoint.diamondCutFacet = createDeployedContract(diamondCutFacetAddress)
		persist()
		logger.deployed("DiamondCutFacet", diamondCutFacetAddress)
	}

	let diamondAddress: string
	if (epCheckpoint.diamond) {
		diamondAddress = epCheckpoint.diamond.address
		logger.info(`  ⏭ ExpressProvider Diamond already deployed at ${diamondAddress}`)
	} else {
		const factory = await ethers.getContractFactory("Diamond")
		const deployment = await confirmDeploymentWithReceipt(
			await factory.deploy(owner, diamondCutFacetAddress),
			"Express Diamond",
			checkpointDeployment(checkpoint, "contracts.expressProvider.diamond", [owner, diamondCutFacetAddress]),
		)
		diamondAddress = deployment.address
		epCheckpoint.diamond = createDeployedContract(diamondAddress, [owner, diamondCutFacetAddress])
		persist()
		logger.deployed("ExpressProvider Diamond", diamondAddress)
	}

	let initAddress: string
	if (epCheckpoint.init) {
		initAddress = epCheckpoint.init.address
		logger.info(`  ⏭ Init already deployed at ${initAddress}`)
	} else {
		const factory = await ethers.getContractFactory(EXPRESS_INIT)
		const deployment = await confirmDeploymentWithReceipt(
			await factory.deploy(),
			"Express Init",
			checkpointDeployment(checkpoint, "contracts.expressProvider.init"),
		)
		initAddress = deployment.address
		epCheckpoint.init = createDeployedContract(initAddress)
		persist()
		logger.deployed("Init", initAddress)
	}

	epCheckpoint.facets ||= {}
	const facetNames = Object.keys(EXPRESS_FACETS)
	const cut: Array<{ facetAddress: string; action: FacetCutAction; functionSelectors: string[] }> = []
	const deployedFacets: Array<{ name: string; address: string }> = []

	logger.subsection(`Facets (${facetNames.length} total)`)
	for (const [index, name] of facetNames.entries()) {
		const qualified = EXPRESS_FACETS[name]
		let facetAddress: string
		if (epCheckpoint.facets[name]) {
			facetAddress = epCheckpoint.facets[name].address
			logger.info(`  ⏭ [${index + 1}/${facetNames.length}] ${name} already deployed at ${facetAddress}`)
		} else {
			const factory = await ethers.getContractFactory(qualified)
			const deployment = await confirmDeploymentWithReceipt(
				await factory.deploy(),
				`Express ${name}`,
				checkpointDeployment(checkpoint, `contracts.expressProvider.facets.${name}`),
			)
			facetAddress = deployment.address
			epCheckpoint.facets[name] = createDeployedContract(facetAddress)
			persist()
			logger.deployed(`[${index + 1}/${facetNames.length}] ${name}`, facetAddress)
		}
		const facet = await ethers.getContractAt(qualified, facetAddress)
		cut.push({ facetAddress, action: FacetCutAction.Add, functionSelectors: getSelectors(ethers, facet as any).selectors })
		deployedFacets.push({ name, address: facetAddress })
	}

	// Rebuild the outstanding work from the live selector map. A resume after a timed-out cut
	// must distinguish "never added" from "added, pointing at an older facet".
	const diamondStoragePosition = ethers.keccak256(ethers.toUtf8Bytes("diamond.standard.diamond.storage"))
	const abiCoder = ethers.AbiCoder.defaultAbiCoder()
	const installedFacetFor = async (selector: string): Promise<string> => {
		const slot = ethers.keccak256(abiCoder.encode(["bytes4", "bytes32"], [selector, diamondStoragePosition]))
		return ethers.getAddress(`0x${(await ethers.provider.getStorage(diamondAddress, slot)).slice(-40)}`)
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
			logger.info(`  ⚠ Partial Express cut detected; recovering ${recoveryCut.length} missing or mismatched selector group(s).`)
		}
		const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress)
		const init = await ethers.getContractAt(EXPRESS_INIT, initAddress)
		const call = init.interface.encodeFunctionData("init", [roleRecipient, symmio, collateral])
		// Init reverts with AlreadyInitialized on a second run, so attach it only when no
		// expected selector is installed yet.
		const initAlreadyRan = installedExpectedSelectors > 0
		const chunkSize = 3
		const totalChunks = Math.ceil(recoveryCut.length / chunkSize)
		for (let i = 0; i < recoveryCut.length; i += chunkSize) {
			const chunk = recoveryCut.slice(i, i + chunkSize)
			const chunkNum = Math.floor(i / chunkSize) + 1
			const runInit = i === 0 && !initAlreadyRan
			const receipt = await send(
				diamondCut.diamondCut(chunk, runInit ? initAddress : ethers.ZeroAddress, runInit ? call : "0x"),
				`Express diamondCut chunk ${chunkNum}/${totalChunks}`,
			)
			logger.progress(chunkNum, totalChunks, `Chunk ${chunkNum}/${totalChunks} (${chunk.length} selector groups) — ${receipt.hash}`)
		}
	}

	// Exact final assertion: every expected selector maps to its expected facet, and nothing
	// unexpected slipped in.
	const diamondCutFacet = await ethers.getContractAt("DiamondCutFacet", diamondCutFacetAddress)
	const expectedOwnerBySelector = new Map<string, string>()
	for (const selector of getSelectors(ethers, diamondCutFacet as any).selectors) {
		expectedOwnerBySelector.set(selector.toLowerCase(), diamondCutFacetAddress.toLowerCase())
	}
	for (const entry of cut) {
		for (const selector of entry.functionSelectors) {
			const key = selector.toLowerCase()
			const prior = expectedOwnerBySelector.get(key)
			if (prior && prior !== entry.facetAddress.toLowerCase()) throw new Error(`Duplicate Express selector ${selector} across expected facets`)
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
		const sample = missing
			.slice(0, 5)
			.map(([selector]) => selector)
			.join(", ")
		throw new Error(
			`Express selector verification failed: ${missing.length} missing/mismatched, ${unexpected.length} unexpected` +
				(missing.length > 0 ? ` (e.g. ${sample})` : ""),
		)
	}
	logger.info(`  ✓ Express selector set verified exactly (${expectedOwnerBySelector.size} selectors)`)

	epCheckpoint.diamondCutComplete = true
	persist()

	return { diamond: diamondAddress, diamondCutFacet: diamondCutFacetAddress, init: initAddress, facets: deployedFacets }
}

/** Explorer records for every created contract. All have empty constructors except the Diamond. */
export function createExpressVerificationRecords(
	deployment: ExpressDiamondDeployment,
	diamondConstructorArgs: unknown[],
): Array<{ name: string; address: string; constructorArguments: unknown[] }> {
	return [
		{
			name: "contracts/diamond/facets/DiamondCut/DiamondCutFacet.sol:DiamondCutFacet",
			address: deployment.diamondCutFacet,
			constructorArguments: [],
		},
		{ name: "contracts/diamond/Diamond.sol:Diamond", address: deployment.diamond, constructorArguments: diamondConstructorArgs },
		{ name: EXPRESS_INIT, address: deployment.init, constructorArguments: [] },
		...deployment.facets.map(facet => ({ name: EXPRESS_FACETS[facet.name], address: facet.address, constructorArguments: [] })),
	]
}

export interface DeployExpressOptions {
	admin: string
	symmio: string
	collateral: string
}

/**
 * Local/fork test helper: deploys the diamond and hands ownership to `admin`, returning a
 * combined-ABI instance. Live deployments use the recipe component workflow, which owns the
 * durable checkpoint, role configuration, core registration, and explorer verification.
 */
export async function deployExpressProvider(hre: HardhatRuntimeEnvironment, connection: NetworkConnection, opts: DeployExpressOptions) {
	const { ethers } = connection
	const chainId = (await ethers.provider.getNetwork()).chainId
	const isSimulated = (connection as any).networkConfig?.type === "edr-simulated"
	assertStandaloneDeploymentTaskAllowed(
		"deployExpressProvider",
		chainId,
		isSimulated,
		"This ad-hoc helper has no durable checkpoint, role configuration, or explorer verification; use the recipe workflow (deploy --only expressProvider) for a live provider.",
	)
	const [deployer] = await ethers.getSigners()
	if (!deployer) throw new Error("ExpressProvider deployment requires a configured signer")
	const deployerAddress = ethers.getAddress(deployer.address)
	for (const [label, address] of Object.entries(opts)) {
		if (!ethers.isAddress(address) || address === ethers.ZeroAddress) throw new Error(`ExpressProvider ${label} must be a non-zero address`)
	}
	const finalAdmin = ethers.getAddress(opts.admin)
	for (const [label, address] of Object.entries({ symmio: opts.symmio, collateral: opts.collateral })) {
		if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`ExpressProvider ${label} has no contract code at ${address}`)
	}

	// The deployer must own the bare diamond to install facets, but the Init-granted roles go
	// straight to the final admin: this helper does no post-cut configuration of its own.
	const deployment = await deployExpressProviderDiamond(hre, {
		owner: deployerAddress,
		initAdmin: finalAdmin,
		symmio: ethers.getAddress(opts.symmio),
		collateral: ethers.getAddress(opts.collateral),
	})

	if (finalAdmin !== deployerAddress) {
		const control = await ethers.getContractAt(EXPRESS_CONTROL_FACET, deployment.diamond)
		await send(control.transferOwnership(finalAdmin), "Express ownership handover")
		if (ethers.getAddress(await control.owner()) !== deployerAddress || ethers.getAddress(await control.pendingOwner()) !== finalAdmin) {
			throw new Error("Express ownership handover post-state does not match the deployer/final admin")
		}
	}

	const fragments: any[] = []
	for (const qualified of Object.values(EXPRESS_FACETS)) {
		fragments.push(...(await ethers.getContractFactory(qualified)).interface.fragments)
	}
	fragments.push(...(await ethers.getContractFactory("DiamondCutFacet")).interface.fragments)
	return ethers.getContractAt(fragments, deployment.diamond)
}
