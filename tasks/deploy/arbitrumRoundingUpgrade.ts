import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import fs from "node:fs"

import {
	assertReleaseSource,
	assertRoundingFactoryIntent,
	digest,
	GETTER,
	LIBRARIES,
	isStageFunding,
	roundingLibraries,
	roundingSuffix,
	selectorDigest,
	planRoundingCut,
	requiresRoundingPause,
	roundingOwner,
	roundingFacets,
	roundingDeployments,
	selectorMap,
} from "../../deployment-tooling/arbitrum-rounding-upgrade.js"
import { FacetSpecs, LibrarySpecs, linkedLibrariesFor } from "../../utils/deploymentManifest.js"
import { atomicWriteFile } from "../utils/fs.js"
import { deploymentOnlyArtifact } from "./artifacts.js"
import {
	acquireCheckpointLock,
	assertCheckpointManifest,
	createCheckpoint,
	createDeploymentManifest,
	loadCheckpoint,
	saveCheckpoint,
	setCheckpointSimulated,
	type DeploymentCheckpoint,
} from "./checkpoint.js"
import { ensureCreate2Factory } from "./create2Factory.js"
import { persistSubmittedTransaction } from "./deploymentRecovery.js"
import { resolveVerificationContractName, verificationProviderForChain } from "./explorer.js"
import { completeGovernanceTransactionRequest } from "./governanceActions.js"
import { getConnection } from "./helpers.js"
import { logger } from "./logger.js"
import {
	bindDeploymentTransactionWriteAhead,
	clearDeploymentTransactionWriteAhead,
	getDeploymentTransactionJournal,
	reconcileDeploymentTransactions,
	recoverConfirmedDeployment,
	resetDeploymentTransactionJournal,
	send,
} from "./tx.js"
import { createVanityContext, deployContract } from "./vanityDeploy.js"
import { buildVanityPlan } from "./vanityPlan.js"

const PHASES = [
	"plan-roles",
	"verify-roles",
	"inspect",
	"deploy",
	"publish",
	"execute-pause",
	"execute-cut",
	"execute-unpause",
	"reconcile-governance",
	"plan-pause",
	"verify-pause",
	"plan",
	"verify",
	"plan-unpause",
	"verify-unpause",
	"reconcile",
]
const write = (file: string, value: any) => atomicWriteFile(file, JSON.stringify(value, null, 2) + "\n", 0o600)

export async function assertRoundingRuntime(ethers: any, artifact: any, address: string, libraries: Record<string, string> = {}) {
	let expected = artifact.deployedBytecode.slice(2)
	for (const [source, names] of Object.entries(artifact.deployedLinkReferences || {}) as any)
		for (const [name, references] of Object.entries(names) as any) {
			const link = libraries[`${source}:${name}`]
			if (!link) throw new Error(`Missing runtime library binding ${source}:${name}`)
			for (const ref of references)
				expected = expected.slice(0, ref.start * 2) + link.slice(2).toLowerCase() + expected.slice((ref.start + ref.length) * 2)
		}
	let actual = (await ethers.provider.getCode(address)).slice(2).toLowerCase()
	if (!actual) throw new Error(`No runtime code at ${address}`)
	for (const references of Object.values(artifact.immutableReferences || {}) as any)
		for (const ref of references) {
			expected = expected.slice(0, ref.start * 2) + "0".repeat(ref.length * 2) + expected.slice((ref.start + ref.length) * 2)
			actual = actual.slice(0, ref.start * 2) + "0".repeat(ref.length * 2) + actual.slice((ref.start + ref.length) * 2)
		}
	if (expected.toLowerCase() !== actual) throw new Error(`Runtime bytecode or linked-library mismatch at ${address}`)
}

export async function inspectRoundingUpgrade(ethers: any, input: any, report: any) {
	assertRoundingFactoryIntent(input.create2)
	const block = await ethers.provider.getBlock("latest")
	const [deployer] = await ethers.getSigners()
	const view = await ethers.getContractAt(
		[
			"function getOwner() view returns(address)",
			"function hasRole(address,bytes32) view returns(bool)",
			"function getCollateral() view returns(address)",
		],
		input.target.core,
	)
	if ((await view.getOwner({ blockTag: block.number })).toLowerCase() !== roundingOwner(input).toLowerCase())
		throw new Error("The reviewed owner must own Core")
	if (!(await view.hasRole(roundingOwner(input), ethers.id("DEFAULT_ADMIN_ROLE"), { blockTag: block.number })))
		throw new Error("The reviewed owner must hold Core DEFAULT_ADMIN_ROLE")
	if (requiresRoundingPause(input) && !isStageFunding(input)) await assertRoundingPauseAuthority(ethers, input, block.number)
	if (input.target.collateral && (await view.getCollateral({ blockTag: block.number })).toLowerCase() !== input.target.collateral.toLowerCase())
		throw new Error("Production Core collateral differs from the reviewed target")
	const loupe = await ethers.getContractAt("DiamondLoupeFacet", input.target.core)
	const selectors = selectorMap(await loupe.facets({ blockTag: block.number }))
	for (const [name, entry] of Object.entries(input.target.preserveFacets || {}) as any) {
		if (
			!Object.values(selectors).some(a => a.toLowerCase() === entry.address.toLowerCase()) ||
			ethers.keccak256(await ethers.provider.getCode(entry.address, block.number)) !== entry.codeHash
		)
			throw new Error(`Preserved rounding facet changed: ${name}`)
	}
	if (isStageFunding(input)) {
		if (report.baseline && selectorDigest(report.baseline) !== input.target.baselineSelectorDigest)
			throw new Error("Saved stage selector baseline differs from the reviewed target")
		const funding = await ethers.getContractAt(["function isAccumulatedFundingActivated() view returns(bool)"], input.target.core)
		if (!(await funding.isAccumulatedFundingActivated({ blockTag: block.number }))) throw new Error("Stage accumulated funding must remain enabled")
	}
	if (!report.baseline) {
		if (isStageFunding(input)) {
			if (!selectors[GETTER] || selectorDigest(selectors) !== input.target.baselineSelectorDigest)
				throw new Error("Stage selectors differ from the reviewed installed rounding baseline")
		} else if (selectors[GETTER]) throw new Error("Rounding getter is already installed; refuse a new release run")
		for (const [name, entry] of Object.entries(input.target.facets) as any) {
			if (!Object.values(selectors).some(a => a.toLowerCase() === entry.address.toLowerCase()))
				throw new Error(`Baseline facet ${name} is not installed`)
			if (ethers.keccak256(await ethers.provider.getCode(entry.address, block.number)) !== entry.codeHash)
				throw new Error(`Baseline code mismatch for ${name}`)
		}
		report.baseline = selectors
		report.inspection = { blockNumber: block.number, blockHash: block.hash, owner: roundingOwner(input), deployer: deployer?.address }
	}
	for (const [name, entry] of Object.entries(input.target.reuseLibraries) as any) {
		if (ethers.keccak256(await ethers.provider.getCode(entry.address, block.number)) !== entry.codeHash)
			throw new Error(`Reused library mismatch for ${name}`)
	}
	return selectors
}

async function checkpointRun(ethers: any, input: any, report: any, fn: (checkpoint: DeploymentCheckpoint) => Promise<void>, governance = false) {
	const recordKey = governance ? "governanceTransactions" : "transactions"
	setCheckpointSimulated(false)
	const scope = `arbitrum-rounding-862-${governance ? "governance-" : ""}${digest(input).slice(0, 16)}`
	const lock = acquireCheckpointLock(42161, scope)
	try {
		const checkpoint = loadCheckpoint(42161, scope) || createCheckpoint("arbitrum", 42161, scope)
		const manifest = createDeploymentManifest(
			{ input, simulated: false, ...(governance ? { role: "governance" } : {}) },
			{ deploymentId: checkpoint.deploymentId || checkpoint.manifest?.deploymentId },
		)
		if (checkpoint.manifest) assertCheckpointManifest(checkpoint, manifest)
		checkpoint.manifest = manifest
		checkpoint.deploymentId = manifest.deploymentId
		const signer = (await ethers.getSigners())[0]
		const signerAddress = signer ? await signer.getAddress() : undefined
		if (signerAddress && checkpoint.deployerAddress && checkpoint.deployerAddress.toLowerCase() !== signerAddress.toLowerCase())
			throw new Error("Deployment signer changed")
		checkpoint.deployerAddress ||= signerAddress
		try {
			await reconcileDeploymentTransactions(checkpoint.transactions || [], ethers.provider, checkpoint.deployerAddress)
		} finally {
			report[recordKey] = checkpoint.transactions || []
			saveCheckpoint(checkpoint)
		}
		resetDeploymentTransactionJournal()
		bindDeploymentTransactionWriteAhead(record => persistSubmittedTransaction(checkpoint, record))
		try {
			await fn(checkpoint)
		} finally {
			report[recordKey] = [
				...new Map([...(checkpoint.transactions || []), ...getDeploymentTransactionJournal()].map(r => [r.hash.toLowerCase(), r])).values(),
			]
			saveCheckpoint(checkpoint)
			clearDeploymentTransactionWriteAhead()
		}
	} finally {
		lock.release()
	}
}

export async function assertRoundingFactory(hre: any, ethers: any, entry: any, deployer: string) {
	if (!entry || entry.artifact !== "Create2Factory" || JSON.stringify(entry.constructorArguments) !== JSON.stringify([deployer, deployer]))
		throw new Error("Temporary factory must bind both constructor roles to the deployment signer")
	await assertRoundingRuntime(ethers, await hre.artifacts.readArtifact("Create2Factory"), entry.address)
	const factory = await ethers.getContractAt("Create2Factory", entry.address)
	for (const role of [ethers.ZeroHash, ethers.id("DEPLOYER_ROLE")]) {
		if (!(await factory.hasRole(role, deployer))) throw new Error("Temporary factory deployment signer must hold admin and deployer roles")
	}
}

export async function deployRoundingSelection(hre: any, ethers: any, input: any, report: any, checkpoint: DeploymentCheckpoint, persist: () => void) {
	const facets = roundingFacets(input.profile)
	const librariesToDeploy = roundingLibraries(input.profile)
	assertRoundingFactoryIntent(input.create2)
	const [deployer] = await ethers.getSigners()
	if (!deployer) throw new Error("Temporary factory requires a deployment signer")
	if (checkpoint.deployerAddress && checkpoint.deployerAddress.toLowerCase() !== deployer.address.toLowerCase())
		throw new Error("Deployment signer changed")
	checkpoint.deployerAddress ||= deployer.address
	const vanityPlan = buildVanityPlan({
		factory: input.create2.factory,
		miningBudget: input.create2.miningBudget,
		overrides: Object.fromEntries(facets.map(name => [`core/${name}`, input.create2.groups.facets])),
	})
	if (!vanityPlan) throw new Error("Rounding deployment requires a CREATE2 vanity plan")
	report.deployments ||= {}
	const savedFactory = report.deployments.Create2Factory
	const recoveredFactory = await recoverConfirmedDeployment(checkpoint.transactions || [], "contracts.create2Factory", ethers.provider)
	const checkpointFactory = checkpoint.contracts.create2Factory?.address
	for (const saved of [savedFactory?.address, checkpointFactory]) {
		if (saved && !recoveredFactory) throw new Error("Temporary factory is missing its confirmed creation journal")
		if (saved && recoveredFactory && saved.toLowerCase() !== recoveredFactory.toLowerCase())
			throw new Error("Temporary factory report or checkpoint conflicts with transaction journal")
	}
	if (!recoveredFactory && Object.keys(report.deployments).length)
		throw new Error("Upgrade deployments exist without their temporary factory journal")
	const connection = await getConnection(hre)
	const { address: factoryAddress } = await ensureCreate2Factory(hre, vanityPlan, {
		checkpoint,
		isLive: connection.networkConfig?.type !== "edr-simulated",
		allowNewFactory: true,
		logData: false,
	})
	const factoryEntry = savedFactory || {
		address: factoryAddress,
		artifact: "Create2Factory",
		constructorArguments: [deployer.address, deployer.address],
		libraries: {},
		codeHash: ethers.keccak256(await ethers.provider.getCode(factoryAddress)),
	}
	await assertRoundingFactory(hre, ethers, factoryEntry, deployer.address)
	report.factoryDeployer = deployer.address
	report.deployments.Create2Factory = factoryEntry
	persist()
	const vanity = createVanityContext(ethers, vanityPlan)
	report.libraries ||= Object.fromEntries(Object.entries(input.target.reuseLibraries).map(([name, entry]: any) => [name, entry.address]))
	for (const [name, entry] of Object.entries(input.target.reuseLibraries) as any) {
		if (report.libraries[name]?.toLowerCase() !== entry.address.toLowerCase()) throw new Error(`Reused library address changed: ${name}`)
	}
	report.facets ||= {}
	for (const name of [...librariesToDeploy, ...facets]) {
		const kind = LIBRARIES.includes(name) ? "libraries" : "facets"
		const spec = kind === "libraries" ? LibrarySpecs.core[name] : FacetSpecs.core[name]
		const artifact = await hre.artifacts.readArtifact(spec.artifact)
		const libraries = linkedLibrariesFor("core", spec, report.libraries)
		const factory = await ethers.getContractFactoryFromArtifact(kind === "libraries" ? deploymentOnlyArtifact(artifact) : artifact, { libraries })
		const component = `contracts.upgrade.core.${kind}.${name}`
		const recovered = await recoverConfirmedDeployment(checkpoint.transactions || [], component, ethers.provider)
		const saved = report.deployments[name]?.address
		if (saved && !recovered) throw new Error(`${name} is missing its confirmed creation journal`)
		if (saved && recovered && saved.toLowerCase() !== recovered.toLowerCase()) throw new Error(`${name} report conflicts with transaction journal`)
		const address =
			saved ||
			recovered ||
			(await deployContract(vanity, { key: `core/${name}`, component, label: `${input.release} ${name}`, factory, checkpoint })).address
		await assertRoundingRuntime(ethers, artifact, address, libraries)
		if (kind === "facets" && !address.toLowerCase().endsWith(roundingSuffix(input.profile)))
			throw new Error(`${name}: missing ${roundingSuffix(input.profile)} suffix`)
		report.deployments[name] = { address, artifact: spec.artifact, libraries, codeHash: ethers.keccak256(await ethers.provider.getCode(address)) }
		if (kind === "libraries") report.libraries[name] = address
		else
			report.facets[name] = { address, selectors: factory.interface.fragments.filter((f: any) => f.type === "function").map((f: any) => f.selector) }
		persist()
	}
}

async function plan(hre: any, ethers: any, input: any, report: any) {
	const facets = roundingFacets(input.profile)
	const current = await inspectRoundingUpgrade(ethers, input, report)
	await assertRoundingFactory(hre, ethers, report.deployments?.Create2Factory, report.factoryDeployer)
	for (const name of [...roundingLibraries(input.profile), ...facets]) {
		const deployment = report.deployments?.[name]
		if (!deployment) throw new Error(`Missing deployment ${name}`)
		const spec = LIBRARIES.includes(name) ? LibrarySpecs.core[name] : FacetSpecs.core[name]
		if (LIBRARIES.includes(name) && deployment.address !== report.libraries[name]) throw new Error(`Library report changed: ${name}`)
		if (facets.includes(name) && deployment.address !== report.facets[name]?.address) throw new Error(`Facet report changed: ${name}`)
		const links = linkedLibrariesFor("core", spec, report.libraries)
		if (JSON.stringify(links) !== JSON.stringify(deployment.libraries)) throw new Error(`Linked library report changed: ${name}`)
		await assertRoundingRuntime(ethers, await hre.artifacts.readArtifact(spec.artifact), deployment.address, links)
	}
	const planned = planRoundingCut(report.baseline, current, report.facets, input.target.facets, input.profile)
	report.desired = planned.desired
	report.actions = planned.calldata
		? [
				{
					to: input.target.core,
					value: "0",
					data: planned.calldata,
					description: isStageFunding(input)
						? "Install stage funding facet ending in 863: replace seven selectors, no additions or initializer"
						: `Install ${input.release}: ${facets.length} facets, one new getter, no initializer`,
				},
			]
		: []
	if (planned.calldata) await ethers.provider.call({ to: input.target.core, from: roundingOwner(input), data: planned.calldata })
	return planned
}

export async function assertRoundingPauseAuthority(ethers: any, input: any, blockNumber: number) {
	const view = await ethers.getContractAt(["function hasRole(address,bytes32) view returns(bool)"], input.target.core)
	for (const role of ["PAUSER_ROLE", "UNPAUSER_ROLE"])
		if (!(await view.hasRole(roundingOwner(input), ethers.id(role), { blockTag: blockNumber })))
			throw new Error(`Core owner ${roundingOwner(input)} must hold ${role} for the pause/cut/unpause workflow`)
}

export async function planStageFundingRoles(ethers: any, input: any, report: any) {
	if (!isStageFunding(input) || input.target.governanceMode !== "safe-file") throw new Error("Role grants belong to the stage funding Safe profile")
	assertRoundingPublication(input, report)
	const blockNumber = await ethers.provider.getBlockNumber()
	const owner = roundingOwner(input)
	const view = await ethers.getContractAt(
		["function getOwner() view returns(address)", "function hasRole(address,bytes32) view returns(bool)"],
		input.target.core,
	)
	if (
		(await view.getOwner({ blockTag: blockNumber })).toLowerCase() !== owner.toLowerCase() ||
		!(await view.hasRole(owner, ethers.id("DEFAULT_ADMIN_ROLE"), { blockTag: blockNumber }))
	)
		throw new Error("Reviewed stage Safe must own Core and hold DEFAULT_ADMIN_ROLE before role grants")
	const iface = new ethers.Interface(["function grantRole(address user,bytes32 role)"])
	const actions = []
	for (const role of ["PAUSER_ROLE", "UNPAUSER_ROLE"]) {
		if (await view.hasRole(owner, ethers.id(role), { blockTag: blockNumber })) continue
		const action = {
			to: input.target.core,
			value: "0",
			data: iface.encodeFunctionData("grantRole", [owner, ethers.id(role)]),
			description: `Grant ${role} to the Core owner Safe for the stage funding upgrade`,
		}
		await ethers.provider.call({ to: action.to, from: owner, data: action.data, blockTag: blockNumber })
		actions.push(action)
	}
	report.roles = { ...report.roles, blockNumber, actions }
	return report.roles
}

export async function verifyStageFundingRoles(ethers: any, input: any, report: any) {
	if (!isStageFunding(input)) throw new Error("Role verification belongs to the stage funding profile")
	const blockNumber = await ethers.provider.getBlockNumber()
	await assertRoundingPauseAuthority(ethers, input, blockNumber)
	report.roles = { ...report.roles, actions: [], verifiedBlock: blockNumber }
}

export async function requireRoundingPaused(ethers: any, input: any, report: any) {
	const blockNumber = await ethers.provider.getBlockNumber()
	const view = await ethers.getContractAt(FacetSpecs.core.ViewFacet.artifact, input.target.core)
	const pauseState = Array.from(await view.pauseState({ blockTag: blockNumber }))
	if (!pauseState[0]) throw new Error("Core must be globally paused before executing or verifying the cut; execute the Core pause first")
	report.pause = {
		...report.pause,
		globalPaused: true,
		pauseState,
		verifiedBlock: report.pause?.verifiedBlock || blockNumber,
		lastCheckedBlock: blockNumber,
	}
	return report.pause
}

export async function planRoundingPause(ethers: any, input: any, report: any) {
	if (!requiresRoundingPause(input)) throw new Error("Core pause requires a profile with the pause/cut/unpause workflow")
	const blockNumber = await ethers.provider.getBlockNumber()
	await assertRoundingPauseAuthority(ethers, input, blockNumber)
	const view = await ethers.getContractAt(FacetSpecs.core.ViewFacet.artifact, input.target.core)
	const pauseState = Array.from(await view.pauseState({ blockTag: blockNumber }))
	report.pause = {
		...report.pause,
		initialBlock: report.pause?.initialBlock || blockNumber,
		initialPauseState: report.pause?.initialPauseState || pauseState,
		blockNumber,
		globalPaused: pauseState[0],
		pauseState,
		actions: [],
	}
	if (pauseState[0]) return report.pause
	const iface = new ethers.Interface(["function pauseGlobal()"])
	const action = {
		to: input.target.core,
		value: "0",
		data: iface.encodeFunctionData("pauseGlobal"),
		description: "Pause Core globally before the verified upgrade cut",
	}
	await ethers.provider.call({ to: action.to, from: roundingOwner(input), data: action.data, blockTag: blockNumber })
	report.pause.actions = [action]
	return report.pause
}

export async function guardRoundingCut(ethers: any, input: any, report: any) {
	if (!requiresRoundingPause(input) || !report.actions?.length) return
	await requireRoundingPaused(ethers, input, report)
	if (
		report.actions.length !== 1 ||
		report.actions[0].to.toLowerCase() !== input.target.core.toLowerCase() ||
		!report.actions[0].data.startsWith("0x1f931c1c")
	)
		throw new Error("Expected exactly one Core diamondCut for the upgrade")
}

export async function planRoundingUnpause(ethers: any, input: any, report: any) {
	if (report.actions?.length !== 0 || !report.verifiedBlock) throw new Error("Verify the installed Core cut before planning unpause")
	if (requiresRoundingPause(input) && !report.pause?.verifiedBlock) throw new Error("Core pause verification is missing")
	const blockNumber = await ethers.provider.getBlockNumber()
	const view = await ethers.getContractAt(FacetSpecs.core.ViewFacet.artifact, input.target.core)
	const pauseState = await view.pauseState({ blockTag: blockNumber })
	const unpause: any = { blockNumber, globalPaused: pauseState[0], pauseState: Array.from(pauseState), actions: [] }
	report.unpause = unpause
	if (!unpause.globalPaused) return unpause
	if (!(await view.hasRole(roundingOwner(input), ethers.id("UNPAUSER_ROLE"), { blockTag: blockNumber })))
		throw new Error(`Core owner ${roundingOwner(input)} must hold UNPAUSER_ROLE before exporting unpause`)
	const iface = new ethers.Interface(["function unpauseGlobal()"])
	const action = {
		to: input.target.core,
		value: "0",
		data: iface.encodeFunctionData("unpauseGlobal"),
		description: `Unpause Core globally after the verified ${input.release} cut; preserve other pause flags`,
	}
	await ethers.provider.call({ to: action.to, from: roundingOwner(input), data: action.data, blockTag: blockNumber })
	unpause.actions = [action]
	return unpause
}

export async function executeRoundingOwnerAction(ethers: any, input: any, report: any, phase: string, actions: any[]) {
	if (!requiresRoundingPause(input) || input.target.governanceMode !== "ledger")
		throw new Error("Production governance requires the reviewed Ledger owner")
	const methods: Record<string, string> = {
		"execute-pause": "pauseGlobal()",
		"execute-cut": "diamondCut((address,uint8,bytes4[])[],address,bytes)",
		"execute-unpause": "unpauseGlobal()",
	}
	const method = methods[phase]
	if (!method) throw new Error("Unsupported production governance phase")
	const [signer] = await ethers.getSigners()
	if (!signer || ethers.getAddress(await signer.getAddress()) !== roundingOwner(input))
		throw new Error("Governance signer does not match the reviewed Core owner")
	if (actions.length === 0) return
	if (actions.length !== 1) throw new Error("Each Ledger governance phase must contain exactly one transaction")
	const action = actions[0]
	if (
		action.to.toLowerCase() !== input.target.core.toLowerCase() ||
		action.value !== "0" ||
		action.data.slice(0, 10) !== ethers.id(method).slice(0, 10)
	)
		throw new Error("Governance action differs from its reviewed phase or Core target")
	if (phase === "execute-cut") await requireRoundingPaused(ethers, input, report)
	if (phase === "execute-unpause" && (!report.verifiedBlock || !report.pause?.verifiedBlock || report.actions?.length !== 0))
		throw new Error("Verify the paused production cut before unpausing")
	await ethers.provider.call({ from: roundingOwner(input), to: action.to, data: action.data, value: 0n })
	const request = await completeGovernanceTransactionRequest(ethers.provider, {
		from: roundingOwner(input),
		to: action.to,
		data: action.data,
		value: 0n,
	})
	if (phase === "execute-cut") await requireRoundingPaused(ethers, input, report)
	logger.info(`Ledger governance: ${method}; Core ${action.to}; owner ${roundingOwner(input)}; value 0; gas limit ${request.gasLimit}`)
	report.governancePreviews ||= {}
	report.governancePreviews[phase] = { to: action.to, value: "0", data: action.data, method, owner: roundingOwner(input) }
	await send(signer.sendTransaction(request), `${input.release} production ${method}`)
}

export function assertRoundingPublication(input: any, report: any) {
	const missing = roundingDeployments(input.profile).filter(name => !report.deployments?.[name]?.published)
	if (missing.length) throw new Error(`Explorer publication remains incomplete: ${missing.join(", ")}`)
}

export const arbitrumRoundingUpgradeTask = task(
	"internal:arbitrum-rounding-upgrade",
	"Adapter for the Arbitrum rounding and production funding releases",
)
	.addOption({ name: "phase", type: ArgumentType.STRING, defaultValue: "inspect" })
	.addOption({ name: "input", type: ArgumentType.STRING, defaultValue: "" })
	.addOption({ name: "output", type: ArgumentType.STRING, defaultValue: "" })
	.setAction(async () => ({
		default: async ({ phase, input: inputFile, output }, hre) => {
			if (!PHASES.includes(phase)) throw new Error("Unknown rounding upgrade phase")
			const input = JSON.parse(fs.readFileSync(inputFile, "utf8"))
			assertReleaseSource(process.cwd(), input)
			const inputDigest = digest(input)
			if (process.env.SYMMIO_ROUNDING_UPGRADE_RUN_ID !== inputDigest) throw new Error("Start this adapter from ./symmio")
			const connection = await getConnection(hre)
			const { ethers } = connection
			const simulated = connection.networkConfig?.type === "edr-simulated"
			if (Number((await ethers.provider.getNetwork()).chainId) !== 42161) throw new Error("Rounding upgrade requires Arbitrum chain 42161")
			if (simulated || connection.networkName !== "arbitrum") throw new Error("Incorrect network for upgrade phase")
			if (
				["deploy", "publish", "execute-pause", "execute-cut", "execute-unpause"].includes(phase) &&
				(process.env.SYMMIO_ROUNDING_UPGRADE_EXECUTE !== "true" || process.env.CONFIRM_CHAIN_ID !== "42161")
			)
				throw new Error("Live deployment requires explicit chain authorization")
			if (
				["execute-pause", "execute-cut", "execute-unpause", "reconcile-governance"].includes(phase) &&
				(!requiresRoundingPause(input) || input.target.governanceMode !== "ledger" || process.env.SYMMIO_SIGNER_MODE !== "ledger")
			)
				throw new Error("Production governance must run with its selected Ledger signer")
			const report = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : { inputDigest, release: input.release }
			if (report.inputDigest !== inputDigest) throw new Error("Upgrade report input mismatch")
			const persist = () => write(output, report)
			try {
				if (phase === "inspect") await inspectRoundingUpgrade(ethers, input, report)
				if (phase === "deploy") {
					if (!report.inspection || !report.baseline) throw new Error("Inspect the live baseline before authorizing deployment")
					const current = await inspectRoundingUpgrade(ethers, input, report)
					if (
						Object.keys(current).length !== Object.keys(report.baseline).length ||
						Object.entries(current).some(([s, a]) => a.toLowerCase() !== report.baseline[s]?.toLowerCase())
					)
						throw new Error("Core baseline changed before deployment")
					await checkpointRun(ethers, input, report, checkpoint => deployRoundingSelection(hre, ethers, input, report, checkpoint, persist))
				}
				if (phase === "reconcile") await checkpointRun(ethers, input, report, async () => {})
				if (phase === "reconcile-governance") await checkpointRun(ethers, input, report, async () => {}, true)
				if (["execute-pause", "execute-cut", "execute-unpause"].includes(phase)) {
					await checkpointRun(
						ethers,
						input,
						report,
						async () => {
							await plan(hre, ethers, input, report)
							assertRoundingPublication(input, report)
							let actions = report.actions
							if (phase === "execute-pause") actions = (await planRoundingPause(ethers, input, report)).actions
							if (phase === "execute-cut") await guardRoundingCut(ethers, input, report)
							if (phase === "execute-unpause") actions = (await planRoundingUnpause(ethers, input, report)).actions
							await executeRoundingOwnerAction(ethers, input, report, phase, actions)
						},
						true,
					)
				}
				if (
					["publish", "plan-roles", "verify-roles", "plan-pause", "verify-pause", "plan", "verify", "plan-unpause", "verify-unpause"].includes(phase)
				)
					await plan(hre, ethers, input, report)
				if (phase === "plan-roles") await planStageFundingRoles(ethers, input, report)
				if (phase === "verify-roles") await verifyStageFundingRoles(ethers, input, report)
				if (phase === "plan-pause") {
					assertRoundingPublication(input, report)
					await planRoundingPause(ethers, input, report)
				}
				if (phase === "verify-pause") await requireRoundingPaused(ethers, input, report)
				if (phase === "plan") {
					assertRoundingPublication(input, report)
					await guardRoundingCut(ethers, input, report)
				}
				if (phase === "publish") {
					for (const name of roundingDeployments(input.profile)) {
						const entry = report.deployments[name]
						if (entry.published) continue
						try {
							await verifyContract(
								{
									address: entry.address,
									constructorArgs: entry.constructorArguments || [],
									contract: await resolveVerificationContractName(hre.artifacts, entry.artifact),
									libraries: entry.libraries,
									provider: verificationProviderForChain(42161),
								},
								hre,
							)
						} catch (error) {
							if (!(error instanceof Error) || !error.message.toLowerCase().includes("already verified")) throw error
						}
						entry.published = true
						persist()
					}
				}
				if (["verify", "plan-unpause", "verify-unpause"].includes(phase)) {
					if (report.actions.length) throw new Error("Core cut has not been executed yet")
					if (requiresRoundingPause(input) && phase === "verify") await requireRoundingPaused(ethers, input, report)
					assertRoundingPublication(input, report)
					const view = await ethers.getContractAt(["function liquidationStartPositionCount(address) view returns(uint256)"], input.target.core)
					if ((await view.liquidationStartPositionCount(ethers.ZeroAddress)) !== 0n) throw new Error("New getter failed zero-address check")
					report.status = "upgrade_verified"
					report.verifiedBlock = await ethers.provider.getBlockNumber()
				}
				if (phase === "plan-unpause") await planRoundingUnpause(ethers, input, report)
				if (phase === "verify-unpause") {
					const view = await ethers.getContractAt(FacetSpecs.core.ViewFacet.artifact, input.target.core)
					const blockNumber = await ethers.provider.getBlockNumber()
					const pauseState = await view.pauseState({ blockTag: blockNumber })
					if (pauseState[0]) throw new Error("Core remains globally paused; execute the separate owner unpause transaction")
					report.unpause = { ...(report.unpause || {}), globalPaused: false, pauseState: Array.from(pauseState), verifiedBlock: blockNumber }
					report.status = "complete"
				}
			} finally {
				persist()
			}
		},
	}))
	.build()
