import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import fs from "node:fs"

import {
	assertReleaseSource,
	assertRoundingFactoryIntent,
	DEPLOYMENTS,
	digest,
	FACETS,
	GETTER,
	LIBRARIES,
	planRoundingCut,
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
import { getConnection } from "./helpers.js"
import {
	bindDeploymentTransactionWriteAhead,
	clearDeploymentTransactionWriteAhead,
	getDeploymentTransactionJournal,
	reconcileDeploymentTransactions,
	recoverConfirmedDeployment,
	resetDeploymentTransactionJournal,
} from "./tx.js"
import { createVanityContext, deployContract } from "./vanityDeploy.js"
import { buildVanityPlan } from "./vanityPlan.js"

const PHASES = ["inspect", "deploy", "publish", "plan", "verify", "plan-unpause", "verify-unpause", "reconcile"]
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

async function inspect(ethers: any, input: any, report: any) {
	assertRoundingFactoryIntent(input.create2)
	const block = await ethers.provider.getBlock("latest")
	const [deployer] = await ethers.getSigners()
	const view = await ethers.getContractAt(
		["function getOwner() view returns(address)", "function hasRole(address,bytes32) view returns(bool)"],
		input.target.core,
	)
	if ((await view.getOwner({ blockTag: block.number })).toLowerCase() !== input.target.safe.toLowerCase())
		throw new Error("The reviewed Safe must own Core")
	if (!(await view.hasRole(input.target.safe, ethers.id("DEFAULT_ADMIN_ROLE"), { blockTag: block.number })))
		throw new Error("The reviewed Safe must hold Core DEFAULT_ADMIN_ROLE")
	const loupe = await ethers.getContractAt("DiamondLoupeFacet", input.target.core)
	const selectors = selectorMap(await loupe.facets({ blockTag: block.number }))
	if (!report.baseline) {
		if (selectors[GETTER]) throw new Error("Rounding getter is already installed; refuse a new release run")
		for (const [name, entry] of Object.entries(input.target.facets) as any) {
			if (!Object.values(selectors).some(a => a.toLowerCase() === entry.address.toLowerCase()))
				throw new Error(`Baseline facet ${name} is not installed`)
			if (ethers.keccak256(await ethers.provider.getCode(entry.address, block.number)) !== entry.codeHash)
				throw new Error(`Baseline code mismatch for ${name}`)
		}
		report.baseline = selectors
		report.inspection = { blockNumber: block.number, blockHash: block.hash, owner: input.target.safe, deployer: deployer?.address }
	}
	for (const [name, entry] of Object.entries(input.target.reuseLibraries) as any) {
		if (ethers.keccak256(await ethers.provider.getCode(entry.address, block.number)) !== entry.codeHash)
			throw new Error(`Reused library mismatch for ${name}`)
	}
	return selectors
}

async function checkpointRun(ethers: any, input: any, report: any, fn: (checkpoint: DeploymentCheckpoint) => Promise<void>) {
	setCheckpointSimulated(false)
	const scope = `arbitrum-rounding-862-${digest(input).slice(0, 16)}`
	const lock = acquireCheckpointLock(42161, scope)
	try {
		const checkpoint = loadCheckpoint(42161, scope) || createCheckpoint("arbitrum", 42161, scope)
		const manifest = createDeploymentManifest(
			{ input, simulated: false },
			{ deploymentId: checkpoint.deploymentId || checkpoint.manifest?.deploymentId },
		)
		if (checkpoint.manifest) assertCheckpointManifest(checkpoint, manifest)
		checkpoint.manifest = manifest
		checkpoint.deploymentId = manifest.deploymentId
		const signer = (await ethers.getSigners())[0]
		if (signer && checkpoint.deployerAddress && checkpoint.deployerAddress.toLowerCase() !== signer.address.toLowerCase())
			throw new Error("Deployment signer changed")
		checkpoint.deployerAddress ||= signer?.address
		try {
			await reconcileDeploymentTransactions(checkpoint.transactions || [], ethers.provider, checkpoint.deployerAddress)
		} finally {
			report.transactions = checkpoint.transactions || []
			saveCheckpoint(checkpoint)
		}
		resetDeploymentTransactionJournal()
		bindDeploymentTransactionWriteAhead(record => persistSubmittedTransaction(checkpoint, record))
		try {
			await fn(checkpoint)
		} finally {
			report.transactions = [
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
	assertRoundingFactoryIntent(input.create2)
	const [deployer] = await ethers.getSigners()
	if (!deployer) throw new Error("Temporary factory requires a deployment signer")
	if (checkpoint.deployerAddress && checkpoint.deployerAddress.toLowerCase() !== deployer.address.toLowerCase())
		throw new Error("Deployment signer changed")
	checkpoint.deployerAddress ||= deployer.address
	const vanityPlan = buildVanityPlan({
		factory: input.create2.factory,
		miningBudget: input.create2.miningBudget,
		overrides: Object.fromEntries(FACETS.map(name => [`core/${name}`, input.create2.groups.facets])),
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
	for (const name of [...LIBRARIES, ...FACETS]) {
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
		if (kind === "facets" && !address.toLowerCase().endsWith("862")) throw new Error(`${name}: missing 862 suffix`)
		report.deployments[name] = { address, artifact: spec.artifact, libraries, codeHash: ethers.keccak256(await ethers.provider.getCode(address)) }
		if (kind === "libraries") report.libraries[name] = address
		else
			report.facets[name] = { address, selectors: factory.interface.fragments.filter((f: any) => f.type === "function").map((f: any) => f.selector) }
		persist()
	}
}

async function plan(hre: any, ethers: any, input: any, report: any) {
	const current = await inspect(ethers, input, report)
	await assertRoundingFactory(hre, ethers, report.deployments?.Create2Factory, report.factoryDeployer)
	for (const name of [...LIBRARIES, ...FACETS]) {
		const deployment = report.deployments?.[name]
		if (!deployment) throw new Error(`Missing deployment ${name}`)
		const spec = LIBRARIES.includes(name) ? LibrarySpecs.core[name] : FacetSpecs.core[name]
		if (LIBRARIES.includes(name) && deployment.address !== report.libraries[name]) throw new Error(`Library report changed: ${name}`)
		if (FACETS.includes(name) && deployment.address !== report.facets[name]?.address) throw new Error(`Facet report changed: ${name}`)
		const links = linkedLibrariesFor("core", spec, report.libraries)
		if (JSON.stringify(links) !== JSON.stringify(deployment.libraries)) throw new Error(`Linked library report changed: ${name}`)
		await assertRoundingRuntime(ethers, await hre.artifacts.readArtifact(spec.artifact), deployment.address, links)
	}
	const planned = planRoundingCut(report.baseline, current, report.facets, input.target.facets)
	report.desired = planned.desired
	report.actions = planned.calldata
		? [
				{
					to: input.target.core,
					value: "0",
					data: planned.calldata,
					description: `Install ${input.release} rounding fix: four facets, one new getter, no initializer`,
				},
			]
		: []
	if (planned.calldata) await ethers.provider.call({ to: input.target.core, from: input.target.safe, data: planned.calldata })
	return planned
}

export async function planRoundingUnpause(ethers: any, input: any, report: any) {
	if (report.actions?.length !== 0 || !report.verifiedBlock) throw new Error("Verify the installed Core cut before planning unpause")
	const blockNumber = await ethers.provider.getBlockNumber()
	const view = await ethers.getContractAt(FacetSpecs.core.ViewFacet.artifact, input.target.core)
	const pauseState = await view.pauseState({ blockTag: blockNumber })
	const unpause: any = { blockNumber, globalPaused: pauseState[0], pauseState: Array.from(pauseState), actions: [] }
	report.unpause = unpause
	if (!unpause.globalPaused) return unpause
	if (!(await view.hasRole(input.target.safe, ethers.id("UNPAUSER_ROLE"), { blockTag: blockNumber })))
		throw new Error(`Core multisig ${input.target.safe} must hold UNPAUSER_ROLE before exporting unpause`)
	const iface = new ethers.Interface(["function unpauseGlobal()"])
	const action = {
		to: input.target.core,
		value: "0",
		data: iface.encodeFunctionData("unpauseGlobal"),
		description: `Unpause Core globally after the verified ${input.release} cut; preserve other pause flags`,
	}
	await ethers.provider.call({ to: action.to, from: input.target.safe, data: action.data, blockTag: blockNumber })
	unpause.actions = [action]
	return unpause
}

export const arbitrumRoundingUpgradeTask = task("internal:arbitrum-rounding-upgrade", "Adapter for the Arbitrum rounding-only Solidity release")
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
				["deploy", "publish"].includes(phase) &&
				(process.env.SYMMIO_ROUNDING_UPGRADE_EXECUTE !== "true" || process.env.CONFIRM_CHAIN_ID !== "42161")
			)
				throw new Error("Live deployment requires explicit chain authorization")
			const report = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : { inputDigest, release: input.release }
			if (report.inputDigest !== inputDigest) throw new Error("Upgrade report input mismatch")
			const persist = () => write(output, report)
			try {
				if (phase === "inspect") await inspect(ethers, input, report)
				if (phase === "deploy") {
					if (!report.inspection || !report.baseline) throw new Error("Inspect the live baseline before authorizing deployment")
					const current = await inspect(ethers, input, report)
					if (
						Object.keys(current).length !== Object.keys(report.baseline).length ||
						Object.entries(current).some(([s, a]) => a.toLowerCase() !== report.baseline[s]?.toLowerCase())
					)
						throw new Error("Core baseline changed before deployment")
					await checkpointRun(ethers, input, report, checkpoint => deployRoundingSelection(hre, ethers, input, report, checkpoint, persist))
				}
				if (phase === "reconcile") await checkpointRun(ethers, input, report, async () => {})
				if (["publish", "plan", "verify", "plan-unpause", "verify-unpause"].includes(phase)) await plan(hre, ethers, input, report)
				if (phase === "publish") {
					for (const name of DEPLOYMENTS) {
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
					if (DEPLOYMENTS.some(name => !report.deployments[name]?.published)) throw new Error("Explorer publication remains incomplete")
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
					if (pauseState[0]) throw new Error("Core remains globally paused; execute the separate Safe unpause transaction")
					report.unpause = { ...(report.unpause || {}), globalPaused: false, pauseState: Array.from(pauseState), verifiedBlock: blockNumber }
					report.status = "complete"
				}
			} finally {
				persist()
			}
		},
	}))
	.build()
