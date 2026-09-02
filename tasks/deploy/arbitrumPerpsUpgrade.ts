import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import {
	ARBITRUM_PERPS_UPGRADE_TARGET,
	arbitrumPerpsUpgradeInputDigest,
	createArbitrumPerpsUpgradeReport,
	loadArbitrumPerpsUpgradeInput,
	validateArbitrumPerpsUpgradeReport,
	type ArbitrumPerpsUpgradeInput,
	type ArbitrumPerpsUpgradeReport,
	type UpgradeAction,
} from "../../deployment-tooling/arbitrum-perps-upgrade.js"
import { loadDeploymentRecipe } from "../../deployment-tooling/recipe.js"
import { FacetSpecs, LibrarySpecs, linkedLibrariesFor, type DiamondScope } from "../../utils/deploymentManifest.js"
import { atomicWriteFile } from "../utils/fs.js"
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
import { deployAndConfigureGaslessLayer, inspectGaslessLayerPostState, resolveGaslessLayerConfig } from "./componentDeployment.js"
import { persistSubmittedTransaction } from "./deploymentRecovery.js"
import { verificationProviderForChain } from "./explorer.js"
import { getConnection } from "./helpers.js"
import { deployInstantLayer } from "./instantLayer.js"
import {
	bindDeploymentTransactionWriteAhead,
	clearDeploymentTransactionWriteAhead,
	getDeploymentTransactionJournal,
	reconcileDeploymentTransactions,
	resetDeploymentTransactionJournal,
	send,
	type DeploymentTransactionRecord,
} from "./tx.js"

const PHASES = [
	"inspect",
	"rehearse",
	"execute-account-authority",
	"deploy-core-facets",
	"deploy-account-facets",
	"deploy-instant-layer",
	"deploy-gasless-layer",
	"plan",
	"publish",
	"reconcile",
	"verify-final",
] as const

type Phase = (typeof PHASES)[number]
type FacetInfo = { address: string; selectors: string[] }
type FacetDeployment = { libraries: Record<string, string>; facets: Record<string, FacetInfo>; selectorSignatures: Record<string, string> }

const ROLE = {
	DEFAULT_ADMIN_ROLE: "DEFAULT_ADMIN_ROLE",
	SETTER_ROLE: "SETTER_ROLE",
	FEE_ADMIN_ROLE: "FEE_ADMIN_ROLE",
	INSTANT_LAYER_ROLE: "INSTANT_LAYER_ROLE",
	SIGNER_SETTER_ROLE: "SIGNER_SETTER_ROLE",
	REVOKER_ROLE: "REVOKER_ROLE",
	OPERATOR_ROLE: "OPERATOR_ROLE",
} as const

function now(): string {
	return new Date().toISOString()
}

function role(ethers: any, name: string): string {
	return ethers.keccak256(ethers.toUtf8Bytes(name))
}

function action(to: string, data: string, description: string): UpgradeAction {
	return { to, value: "0", data, description }
}

function readReport(file: string, input: ArbitrumPerpsUpgradeInput): ArbitrumPerpsUpgradeReport {
	if (!fs.existsSync(file)) return createArbitrumPerpsUpgradeReport(input)
	let parsed: unknown
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"))
	} catch (error) {
		throw new Error(`Cannot read Arbitrum Perps upgrade report ${file}: ${error instanceof Error ? error.message : String(error)}`)
	}
	return validateArbitrumPerpsUpgradeReport(parsed, input, file)
}

function writeReport(file: string, input: ArbitrumPerpsUpgradeInput, report: ArbitrumPerpsUpgradeReport): void {
	report.updatedAt = now()
	validateArbitrumPerpsUpgradeReport(report, input, file)
	atomicWriteFile(file, `${JSON.stringify(report, null, 2)}\n`, 0o600)
}

function updateStage(
	report: ArbitrumPerpsUpgradeReport,
	id: string,
	status: "complete" | "required" | "waiting_external" | "failed",
	detail: Record<string, unknown> = {},
): void {
	report.stages[id] = { status, ...detail, updatedAt: now() }
	if (report.lifecycle !== "complete") report.lifecycle = status === "waiting_external" ? "waiting_external" : "in_progress"
}

function mergeTransactions(report: ArbitrumPerpsUpgradeReport, records: DeploymentTransactionRecord[]): void {
	const all = [...(report.transactions as DeploymentTransactionRecord[]), ...records]
	report.transactions = [
		...new Map(all.map(record => [`${record.hash.toLowerCase()}:${record.replacementHash?.toLowerCase() || ""}`, record])).values(),
	]
}

function facetStateFile(output: string, scope: DiamondScope): string {
	const directory = output.endsWith(".fork-rehearsal.json") ? path.join(path.dirname(output), "fork-rehearsal") : path.dirname(output)
	return path.join(directory, `${scope}-facets.json`)
}

function loadFacetState(file: string): FacetDeployment | null {
	if (!fs.existsSync(file)) return null
	const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<FacetDeployment>
	if (!parsed.libraries || !parsed.facets || !parsed.selectorSignatures) throw new Error(`Facet state ${file} is incomplete`)
	return parsed as FacetDeployment
}

function assertSourceBinding(input: ArbitrumPerpsUpgradeInput): void {
	const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
	if (commit !== input.source.commit) throw new Error(`Upgrade input is bound to commit ${input.source.commit}, but this checkout is ${commit}`)
	const recipe = loadDeploymentRecipe(input.source.recipe.path)
	if (recipe.digest !== input.source.recipe.digest) throw new Error("Upgrade input recipe digest no longer matches its source recipe")
}

function assertInternalInvocation(phase: Phase, networkName: string | undefined, simulated: boolean, chainId: number): void {
	if (!process.env.SYMMIO_ARBITRUM_UPGRADE_RUN_ID) {
		throw new Error("internal:arbitrum-perps-upgrade is an internal adapter; start the registered ./symmio workflow")
	}
	if (chainId !== 42161) throw new Error(`Arbitrum Perps upgrade requires chain ID 42161; connected to ${chainId}`)
	if (phase === "rehearse" && !simulated) throw new Error("Fork rehearsal requires the fork-arbitrum simulated network")
	if (phase !== "rehearse" && (simulated || networkName !== "arbitrum")) {
		throw new Error(`${phase} requires the live arbitrum network; connected to ${networkName || "unknown"}`)
	}
	const mutating = !["inspect", "plan", "reconcile", "verify-final"].includes(phase)
	if (mutating && phase !== "rehearse") {
		if (process.env.SYMMIO_ARBITRUM_UPGRADE_EXECUTE !== "true") throw new Error(`${phase} requires SYMMIO_ARBITRUM_UPGRADE_EXECUTE=true`)
		if (process.env.CONFIRM_CHAIN_ID !== "42161") throw new Error(`${phase} requires CONFIRM_CHAIN_ID=42161`)
	}
}

async function withCheckpoint<T>(
	input: ArbitrumPerpsUpgradeInput,
	report: ArbitrumPerpsUpgradeReport,
	network: string,
	simulated: boolean,
	ethers: any,
	actionFn: (checkpoint: DeploymentCheckpoint) => Promise<T>,
	scopeQualifier?: string,
): Promise<T> {
	setCheckpointSimulated(simulated)
	const baseScope = `arbitrum-perps-upgrade-${arbitrumPerpsUpgradeInputDigest(input).slice(0, 16)}`
	const scope = scopeQualifier ? `${baseScope}-${scopeQualifier}` : baseScope
	const lock = acquireCheckpointLock(42161, scope)
	try {
		let checkpoint = loadCheckpoint(42161, scope)
		checkpoint ||= createCheckpoint(network, 42161, scope)
		const manifest = createDeploymentManifest(
			{ inputDigest: arbitrumPerpsUpgradeInputDigest(input), source: input.source, network: simulated ? "fork-arbitrum" : "arbitrum" },
			{ deploymentId: checkpoint.deploymentId || checkpoint.manifest?.deploymentId },
		)
		if (checkpoint.manifest) assertCheckpointManifest(checkpoint, manifest)
		checkpoint.deploymentId = manifest.deploymentId
		checkpoint.manifest = manifest
		checkpoint.deployerAddress ||= (await ethers.getSigners())[0]?.address
		if (checkpoint.transactions?.length) {
			try {
				await reconcileDeploymentTransactions(checkpoint.transactions, ethers.provider, checkpoint.deployerAddress)
			} finally {
				mergeTransactions(report, checkpoint.transactions)
				saveCheckpoint(checkpoint)
			}
		}
		resetDeploymentTransactionJournal()
		bindDeploymentTransactionWriteAhead(record => persistSubmittedTransaction(checkpoint!, record))
		try {
			return await actionFn(checkpoint)
		} finally {
			mergeTransactions(report, [...(checkpoint.transactions || []), ...getDeploymentTransactionJournal()])
			saveCheckpoint(checkpoint)
			clearDeploymentTransactionWriteAhead()
		}
	} finally {
		lock.release()
	}
}

async function contractsFor(ethers: any, input: ArbitrumPerpsUpgradeInput) {
	const coreView = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", input.contracts.core)
	const coreControl = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", input.contracts.core)
	const accountView = await ethers.getContractAt("contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet", input.contracts.accountLayer)
	const accountControl = await ethers.getContractAt(
		"contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet",
		input.contracts.accountLayer,
	)
	const expressControl = await ethers.getContractAt(
		"contracts/expressWithdrawLayer/facets/Control/ControlFacet.sol:ControlFacet",
		input.contracts.expressProvider,
	)
	const currentInstant = await ethers.getContractAt("InstantLayer", input.contracts.currentInstantLayer)
	return { coreView, coreControl, accountView, accountControl, expressControl, currentInstant }
}

async function inspectAuthority(ethers: any, input: ArbitrumPerpsUpgradeInput, report: ArbitrumPerpsUpgradeReport): Promise<void> {
	const { coreView, coreControl, accountView, accountControl, expressControl, currentInstant } = await contractsFor(ethers, input)
	const safe = input.governance.safe
	const previousAdmin = input.governance.previousAdmin
	const coreDefault = role(ethers, ROLE.DEFAULT_ADMIN_ROLE)
	const coreFee = role(ethers, ROLE.FEE_ADMIN_ROLE)
	const accountDefault = role(ethers, ROLE.DEFAULT_ADMIN_ROLE)
	const accountSetter = role(ethers, ROLE.SETTER_ROLE)
	const [
		blockNumber,
		coreOwner,
		accountOwner,
		expressOwner,
		collateral,
		safeCoreDefault,
		safeCoreFee,
		previousCoreDefault,
		safeAccountDefault,
		safeAccountSetter,
		previousAccountDefault,
	] = await Promise.all([
		ethers.provider.getBlockNumber(),
		coreView.getOwner(),
		accountView.getOwner(),
		expressControl.owner(),
		coreView.getCollateral(),
		coreView.hasRole(safe, coreDefault),
		coreView.hasRole(safe, coreFee),
		coreView.hasRole(previousAdmin, coreDefault),
		accountView.hasRole(safe, accountDefault),
		accountView.hasRole(safe, accountSetter),
		accountView.hasRole(previousAdmin, accountDefault),
	])
	for (const [name, target] of Object.entries({ safe, ...input.contracts })) {
		if ((await ethers.provider.getCode(target)) === "0x") throw new Error(`${name} ${target} has no runtime bytecode`)
	}
	for (const [label, actual] of [
		["Core owner", coreOwner],
		["AccountLayer owner", accountOwner],
		["ExpressProvider owner", expressOwner],
	] as const) {
		if (ethers.getAddress(actual) !== ethers.getAddress(safe)) throw new Error(`${label} is ${actual}, expected Safe ${safe}`)
	}
	if (ethers.getAddress(collateral) !== ethers.getAddress(input.contracts.collateral)) {
		throw new Error(`Core collateral is ${collateral}, expected ${input.contracts.collateral}`)
	}
	if ((!safeAccountDefault || !safeAccountSetter) && !previousAccountDefault) {
		throw new Error(`Prior admin ${previousAdmin} cannot grant the missing AccountLayer authority`)
	}
	if ((!safeCoreDefault || !safeCoreFee) && !safeCoreDefault && !previousCoreDefault && ethers.getAddress(coreOwner) !== ethers.getAddress(safe)) {
		throw new Error("Neither the Safe nor the prior admin can establish Core authority")
	}

	const safeActions: UpgradeAction[] = []
	if (!safeCoreDefault)
		safeActions.push(
			action(input.contracts.core, coreControl.interface.encodeFunctionData("setAdmin", [safe]), `Grant Core DEFAULT_ADMIN_ROLE to Safe ${safe}`),
		)
	if (!safeCoreFee)
		safeActions.push(
			action(
				input.contracts.core,
				coreControl.interface.encodeFunctionData("grantRole", [safe, coreFee]),
				`Grant Core FEE_ADMIN_ROLE to Safe ${safe}`,
			),
		)
	const accountActions: UpgradeAction[] = []
	if (!safeAccountDefault) {
		accountActions.push(
			action(
				input.contracts.accountLayer,
				accountControl.interface.encodeFunctionData("grantRole", [safe, accountDefault]),
				`Grant AccountLayer DEFAULT_ADMIN_ROLE to Safe ${safe}`,
			),
		)
	}
	if (!safeAccountSetter) {
		accountActions.push(
			action(
				input.contracts.accountLayer,
				accountControl.interface.encodeFunctionData("grantRole", [safe, accountSetter]),
				`Grant AccountLayer SETTER_ROLE to Safe ${safe}`,
			),
		)
	}
	report.safeBatches.authority = {
		...report.safeBatches.authority,
		status: safeActions.length ? "required" : "complete",
		actions: safeActions,
	}
	report.externalActions.accountAuthority = {
		status: accountActions.length ? "required" : "complete",
		authority: previousAdmin,
		actions: accountActions,
	}
	const safeContract = new ethers.Contract(
		safe,
		[
			"function getOwners() view returns (address[])",
			"function getThreshold() view returns (uint256)",
			"function nonce() view returns (uint256)",
			"function VERSION() view returns (string)",
		],
		ethers.provider,
	)
	const [owners, threshold, nonce, version] = await Promise.all([
		safeContract.getOwners(),
		safeContract.getThreshold(),
		safeContract.nonce(),
		safeContract.VERSION(),
	])
	const oldInstantRoles = Object.fromEntries(
		await Promise.all(
			[ROLE.DEFAULT_ADMIN_ROLE, ROLE.SETTER_ROLE, ROLE.OPERATOR_ROLE, ROLE.REVOKER_ROLE].map(async name => [
				name,
				await currentInstant.hasRole(role(ethers, name), safe),
			]),
		),
	)
	updateStage(report, "inspect", "complete", {
		blockNumber,
		ownership: { core: coreOwner, accountLayer: accountOwner, expressProvider: expressOwner },
		authority: {
			core: { safeDefaultAdmin: safeCoreDefault, safeFeeAdmin: safeCoreFee, previousAdminDefault: previousCoreDefault },
			accountLayer: { safeDefaultAdmin: safeAccountDefault, safeSetter: safeAccountSetter, previousAdminDefault: previousAccountDefault },
			currentInstantLayerSafeRoles: oldInstantRoles,
		},
		safe: { version, owners, threshold: threshold.toString(), nonce: nonce.toString() },
	})
	updateStage(report, "authority", safeActions.length || accountActions.length ? "required" : "complete", {
		safeActionCount: safeActions.length,
		externalActionCount: accountActions.length,
	})
}

async function executeActions(signer: any, actions: UpgradeAction[]): Promise<void> {
	for (const entry of actions) {
		await send(signer.sendTransaction({ to: entry.to, value: entry.value, data: entry.data }), entry.description)
	}
}

async function executeAccountAuthority(
	ethers: any,
	input: ArbitrumPerpsUpgradeInput,
	report: ArbitrumPerpsUpgradeReport,
	signer?: any,
): Promise<void> {
	await inspectAuthority(ethers, input, report)
	const actions = (report.externalActions.accountAuthority as any).actions as UpgradeAction[]
	if (actions.length === 0) return
	const authority = signer || (await ethers.getSigners())[0]
	if (ethers.getAddress(authority.address) !== ethers.getAddress(input.governance.previousAdmin)) {
		throw new Error(`AccountLayer authority signer is ${authority.address}, expected prior admin ${input.governance.previousAdmin}`)
	}
	await executeActions(authority, actions)
	await inspectAuthority(ethers, input, report)
	if ((report.externalActions.accountAuthority as any).actions.length !== 0)
		throw new Error("AccountLayer authority remains incomplete after confirmed transactions")
}

async function deployFacetScope(
	ethers: any,
	input: ArbitrumPerpsUpgradeInput,
	report: ArbitrumPerpsUpgradeReport,
	output: string,
	scope: DiamondScope,
	checkpoint: DeploymentCheckpoint,
): Promise<void> {
	const { buildDiamondCut, deployFacets } = await import("./diamondUpgrade.js")
	const file = facetStateFile(output, scope)
	const deployed = await deployFacets(file, scope, { checkpoint })
	const diamond = scope === "core" ? input.contracts.core : input.contracts.accountLayer
	const planned = await buildDiamondCut(diamond, deployed.facets, deployed.selectorSignatures)
	const batchId = scope === "core" ? "coreCut" : "accountCut"
	const contract = await ethers.getContractAt("DiamondCutFacet", diamond)
	const actions: UpgradeAction[] = []
	for (let offset = 0; offset < planned.diamondCut.length; offset += 6) {
		const chunk = planned.diamondCut.slice(offset, offset + 6)
		actions.push(
			action(
				diamond,
				contract.interface.encodeFunctionData("diamondCut", [chunk, ethers.ZeroAddress, "0x"]),
				`Apply ${scope} Diamond cut groups ${offset + 1}-${offset + chunk.length}`,
			),
		)
	}
	report.safeBatches[batchId] = { ...report.safeBatches[batchId], status: actions.length ? "required" : "complete", actions }
	updateStage(report, `${scope}Facets`, "complete", {
		stateFile: file,
		libraryCount: Object.keys(deployed.libraries).length,
		facetCount: Object.keys(deployed.facets).length,
		selectorChangeCount: planned.selectorChanges.length,
		selectorChanges: planned.selectorChanges,
	})
	updateStage(report, batchId, actions.length ? "required" : "complete", { actionCount: actions.length })
}

async function deployNewInstantLayer(
	hre: any,
	ethers: any,
	input: ArbitrumPerpsUpgradeInput,
	report: ArbitrumPerpsUpgradeReport,
	checkpoint: DeploymentCheckpoint,
): Promise<void> {
	const contract = await deployInstantLayer(hre, {
		symmioaddress: input.contracts.core,
		admin: input.governance.safe,
		logData: false,
		checkpoint,
		vanity: null,
	})
	const address = await contract.getAddress()
	if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`New InstantLayer ${address} has no runtime bytecode`)
	report.addresses.newInstantLayer = address
	updateStage(report, "instantLayerDeployment", "complete", {
		address,
		constructorArguments: [input.contracts.core, input.governance.safe],
	})
}

async function deployNewGaslessLayer(
	hre: any,
	ethers: any,
	input: ArbitrumPerpsUpgradeInput,
	report: ArbitrumPerpsUpgradeReport,
	checkpoint: DeploymentCheckpoint,
): Promise<void> {
	if (!report.addresses.newInstantLayer) throw new Error("Deploy the new InstantLayer before GaslessLayer")
	const [deployer] = await ethers.getSigners()
	const resolved = await resolveGaslessLayerConfig(
		ethers,
		input.gaslessLayer,
		{
			core: input.contracts.core,
			accountLayer: input.contracts.accountLayer,
			instantLayer: report.addresses.newInstantLayer,
			admin: input.governance.safe,
		},
		deployer.address,
	)
	const result = await deployAndConfigureGaslessLayer(hre, checkpoint, resolved, deployer, null)
	report.addresses.newGaslessLayer = result.address
	report.addresses.newGaslessLayerImplementation = result.implementation
	updateStage(report, "gaslessLayerDeployment", "complete", {
		address: result.address,
		implementation: result.implementation,
		verificationRecords: result.records,
		postStateChecks: result.checks,
		manualActions: result.manualActions,
		resolvedConfig: resolved,
	})
}

function sameOperations(actual: any[], expected: any[]): boolean {
	const normalize = (operations: any[]) =>
		operations.map(operation => ({
			insertionPoints: [...operation.insertionPoints].map(String),
			sourceIndices: [...operation.sourceIndices].map(String),
			sourceOffsets: [...operation.sourceOffsets].map(String),
		}))
	return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected))
}

async function planInstantLayerActions(ethers: any, input: ArbitrumPerpsUpgradeInput, report: ArbitrumPerpsUpgradeReport): Promise<UpgradeAction[]> {
	const address = report.addresses.newInstantLayer
	if (!address) throw new Error("New InstantLayer deployment is missing")
	const instant = await ethers.getContractAt("InstantLayer", address)
	const actions: UpgradeAction[] = []
	const revokerRole = role(ethers, ROLE.REVOKER_ROLE)
	if (!(await instant.hasRole(revokerRole, input.governance.safe))) {
		actions.push(
			action(
				address,
				instant.interface.encodeFunctionData("grantRole", [revokerRole, input.governance.safe]),
				`Grant new InstantLayer REVOKER_ROLE to Safe ${input.governance.safe}`,
			),
		)
	}
	if (ethers.getAddress(await instant.accountLayer()) !== ethers.getAddress(input.contracts.accountLayer)) {
		actions.push(
			action(
				address,
				instant.interface.encodeFunctionData("setAccountLayer", [input.contracts.accountLayer]),
				`Bind new InstantLayer to AccountLayer ${input.contracts.accountLayer}`,
			),
		)
	}
	if (!(await instant.whitelistedTargets(input.contracts.accountLayer))) {
		actions.push(
			action(
				address,
				instant.interface.encodeFunctionData("setTargetWhitelist", [input.contracts.accountLayer, true]),
				`Whitelist AccountLayer ${input.contracts.accountLayer} on new InstantLayer`,
			),
		)
	}
	const nextTemplateId = Number(await instant.getNextTemplateId())
	if (nextTemplateId > input.instantLayer.templates.length) {
		throw new Error(
			`New InstantLayer already has ${nextTemplateId} templates, more than the ${input.instantLayer.templates.length} reviewed templates`,
		)
	}
	for (let index = 0; index < input.instantLayer.templates.length; index++) {
		const template = input.instantLayer.templates[index]
		if (index < nextTemplateId) {
			const [stored, operations] = await Promise.all([instant.getTemplate(index), instant.getTemplateOperations(index)])
			if (stored.name !== template.name || stored.active !== true || !sameOperations(operations, template.operations)) {
				throw new Error(`Existing new InstantLayer template ${index} conflicts with reviewed template ${template.name}`)
			}
		} else {
			actions.push(
				action(
					address,
					instant.interface.encodeFunctionData("addTemplate", [template.name, template.operations]),
					`Add new InstantLayer template ${index}: ${template.name}`,
				),
			)
		}
		const expectedMode = template.instantOpenMode === true
		const actualMode = index < nextTemplateId ? await instant.templateInstantOpenMode(index) : false
		if (actualMode !== expectedMode) {
			actions.push(
				action(
					address,
					instant.interface.encodeFunctionData("setTemplateInstantOpenMode", [index, expectedMode]),
					`Set new InstantLayer template ${index} instant-open mode to ${expectedMode}`,
				),
			)
		}
	}
	return actions
}

async function planGovernance(ethers: any, input: ArbitrumPerpsUpgradeInput, report: ArbitrumPerpsUpgradeReport, output: string): Promise<void> {
	const { buildDiamondCut } = await import("./diamondUpgrade.js")
	await inspectAuthority(ethers, input, report)
	for (const scope of ["core", "accountLayer"] as const) {
		const state = loadFacetState(facetStateFile(output, scope))
		if (!state) continue
		const diamond = scope === "core" ? input.contracts.core : input.contracts.accountLayer
		const planned = await buildDiamondCut(diamond, state.facets, state.selectorSignatures)
		const batchId = scope === "core" ? "coreCut" : "accountCut"
		const contract = await ethers.getContractAt("DiamondCutFacet", diamond)
		const actions: UpgradeAction[] = []
		for (let offset = 0; offset < planned.diamondCut.length; offset += 6) {
			const chunk = planned.diamondCut.slice(offset, offset + 6)
			actions.push(
				action(
					diamond,
					contract.interface.encodeFunctionData("diamondCut", [chunk, ethers.ZeroAddress, "0x"]),
					`Apply ${scope} Diamond cut groups ${offset + 1}-${offset + chunk.length}`,
				),
			)
		}
		report.safeBatches[batchId] = { ...report.safeBatches[batchId], status: actions.length ? "required" : "complete", actions }
		updateStage(report, batchId, actions.length ? "required" : "complete", {
			actionCount: actions.length,
			selectorChangeCount: planned.selectorChanges.length,
		})
	}

	if (!report.addresses.newInstantLayer || !report.addresses.newGaslessLayer || !report.addresses.newGaslessLayerImplementation) return
	const { coreView, coreControl, accountView, accountControl } = await contractsFor(ethers, input)
	const newInstant = report.addresses.newInstantLayer
	const wiring = await planInstantLayerActions(ethers, input, report)
	const instantRole = role(ethers, ROLE.INSTANT_LAYER_ROLE)
	if (!(await coreView.hasRole(newInstant, instantRole))) {
		wiring.push(
			action(
				input.contracts.core,
				coreControl.interface.encodeFunctionData("grantRole", [newInstant, instantRole]),
				`Grant Core INSTANT_LAYER_ROLE to new InstantLayer ${newInstant}`,
			),
		)
	}
	const signerSetterRole = role(ethers, ROLE.SIGNER_SETTER_ROLE)
	if (!(await accountView.hasRole(newInstant, signerSetterRole))) {
		wiring.push(
			action(
				input.contracts.accountLayer,
				accountControl.interface.encodeFunctionData("grantRole", [newInstant, signerSetterRole]),
				`Grant AccountLayer SIGNER_SETTER_ROLE to new InstantLayer ${newInstant}`,
			),
		)
	}
	const resolved = (report.stages.gaslessLayerDeployment as any)?.resolvedConfig
	if (!resolved) throw new Error("GaslessLayer resolved deployment config is missing from the standard report")
	const gaslessState = await inspectGaslessLayerPostState(ethers, {
		...resolved,
		address: report.addresses.newGaslessLayer,
		implementation: report.addresses.newGaslessLayerImplementation,
	})
	wiring.push(...gaslessState.manualActions)
	report.safeBatches.wiring = { ...report.safeBatches.wiring, status: wiring.length ? "required" : "complete", actions: wiring }
	updateStage(report, "wiring", wiring.length ? "required" : "complete", {
		actionCount: wiring.length,
		gaslessChecks: gaslessState.checks,
	})

	const cutover: UpgradeAction[] = []
	if (wiring.length === 0) {
		if (await coreView.hasRole(input.contracts.currentInstantLayer, instantRole)) {
			cutover.push(
				action(
					input.contracts.core,
					coreControl.interface.encodeFunctionData("revokeRole", [input.contracts.currentInstantLayer, instantRole]),
					`Revoke Core INSTANT_LAYER_ROLE from old InstantLayer ${input.contracts.currentInstantLayer}`,
				),
			)
		}
		if (await accountView.hasRole(input.contracts.currentInstantLayer, signerSetterRole)) {
			cutover.push(
				action(
					input.contracts.accountLayer,
					accountControl.interface.encodeFunctionData("revokeRole", [input.contracts.currentInstantLayer, signerSetterRole]),
					`Revoke AccountLayer SIGNER_SETTER_ROLE from old InstantLayer ${input.contracts.currentInstantLayer}`,
				),
			)
		}
	}
	report.safeBatches.cutover = {
		...report.safeBatches.cutover,
		status: cutover.length ? "required" : wiring.length ? "blocked" : "complete",
		actions: cutover,
	}
	updateStage(report, "cutover", wiring.length ? "waiting_external" : cutover.length ? "required" : "complete", {
		actionCount: cutover.length,
		blockedBy: wiring.length ? "wiring" : null,
	})
}

async function publishDeployments(hre: any, input: ArbitrumPerpsUpgradeInput, report: ArbitrumPerpsUpgradeReport, output: string): Promise<void> {
	const records: Array<{ name: string; address: string; constructorArguments: unknown[]; libraries?: Record<string, string> }> = []
	for (const scope of ["core", "accountLayer"] as const) {
		const state = loadFacetState(facetStateFile(output, scope))
		if (!state) throw new Error(`${scope} facet state is missing; cannot publish deployed bytecode`)
		for (const spec of Object.values(LibrarySpecs[scope])) {
			records.push({
				name: spec.artifact,
				address: state.libraries[spec.name],
				constructorArguments: [],
				...(spec.libraries.length ? { libraries: linkedLibrariesFor(scope, spec, state.libraries) } : {}),
			})
		}
		for (const spec of Object.values(FacetSpecs[scope])) {
			records.push({
				name: spec.artifact,
				address: state.facets[spec.name].address,
				constructorArguments: [],
				...(spec.libraries.length ? { libraries: linkedLibrariesFor(scope, spec, state.libraries) } : {}),
			})
		}
	}
	if (!report.addresses.newInstantLayer) throw new Error("New InstantLayer address is missing")
	records.push({
		name: "contracts/instantLayer/InstantLayer.sol:InstantLayer",
		address: report.addresses.newInstantLayer,
		constructorArguments: [input.contracts.core, input.governance.safe],
	})
	records.push(...(((report.stages.gaslessLayerDeployment as any)?.verificationRecords || []) as any[]))
	for (const record of records) {
		try {
			await verifyContract(
				{
					address: record.address,
					constructorArgs: record.constructorArguments,
					contract: record.name,
					libraries: record.libraries,
					provider: verificationProviderForChain(42161),
				},
				hre,
			)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (!message.toLowerCase().includes("already verified")) throw error
		}
	}
	updateStage(report, "publication", "complete", { recordCount: records.length, records })
}

async function inspectFinalState(ethers: any, input: ArbitrumPerpsUpgradeInput, report: ArbitrumPerpsUpgradeReport, output: string): Promise<void> {
	await planGovernance(ethers, input, report, output)
	const requiredBatches = ["authority", "coreCut", "accountCut", "wiring", "cutover"].filter(
		id => (report.safeBatches[id] as any)?.actions?.length > 0,
	)
	const external = Object.entries(report.externalActions)
		.filter(([, entry]: any) => entry.actions?.length > 0)
		.map(([id]) => id)
	const safeState = (report.stages.inspect as any)?.safe
	const threshold = Number(safeState?.threshold || 0)
	const ownerCount = Array.isArray(safeState?.owners) ? safeState.owners.length : 0
	const safeHardened = threshold > 1 && ownerCount >= threshold
	updateStage(report, "safeHardening", safeHardened ? "complete" : "waiting_external", {
		threshold,
		ownerCount,
		requirement: "Add the production owners and raise the Safe threshold above 1 after wiring and canary completion",
	})
	const canaryComplete = (report.stages.canary as any)?.status === "complete"
	const publicationComplete = (report.stages.publication as any)?.status === "complete"
	const complete = requiredBatches.length === 0 && external.length === 0 && safeHardened && canaryComplete && publicationComplete
	report.checks = [
		{
			check: "governance actions",
			status: requiredBatches.length === 0 && external.length === 0 ? "passed" : "pending",
			pendingSafeBatches: requiredBatches,
			pendingExternalActions: external,
		},
		{ check: "explorer publication", status: publicationComplete ? "passed" : "pending" },
		{ check: "operator canary", status: canaryComplete ? "passed" : "pending" },
		{ check: "Safe hardening", status: safeHardened ? "passed" : "pending", threshold, ownerCount },
	]
	report.lifecycle = complete ? "complete" : "waiting_external"
	updateStage(report, "finalVerification", complete ? "complete" : "waiting_external", {
		pendingSafeBatches: requiredBatches,
		pendingExternalActions: external,
		publicationComplete,
		canaryComplete,
		safeHardened,
	})
	if (complete) report.lifecycle = "complete"
}

async function fundAndImpersonate(ethers: any, address: string): Promise<any> {
	await ethers.provider.send("hardhat_setBalance", [address, "0x3635c9adc5dea00000"])
	await ethers.provider.send("hardhat_impersonateAccount", [address])
	return ethers.getSigner(address)
}

async function runForkRehearsal(
	hre: any,
	ethers: any,
	input: ArbitrumPerpsUpgradeInput,
	liveReport: ArbitrumPerpsUpgradeReport,
	output: string,
): Promise<void> {
	const baseBlockNumber = await ethers.provider.getBlockNumber()
	// A new Hardhat invocation creates a new ephemeral chain. Keep each attempt in
	// its own namespace so an interrupted rehearsal can be retried without treating
	// addresses from the discarded fork as deployments on the new fork.
	const attemptId = `${baseBlockNumber}-${Date.now()}-${process.pid}`
	const forkOutput = path.join(path.dirname(output), "fork-rehearsal", `attempt-${attemptId}`, "report.json")
	const forkReport = createArbitrumPerpsUpgradeReport(input)
	const [deployer] = await ethers.getSigners()
	await ethers.provider.send("hardhat_setBalance", [deployer.address, "0x3635c9adc5dea00000"])
	const previousAdmin = await fundAndImpersonate(ethers, input.governance.previousAdmin)
	const safe = await fundAndImpersonate(ethers, input.governance.safe)
	try {
		await withCheckpoint(
			input,
			forkReport,
			"fork-arbitrum",
			true,
			ethers,
			async checkpoint => {
				await inspectAuthority(ethers, input, forkReport)
				await executeAccountAuthority(ethers, input, forkReport, previousAdmin)
				await executeActions(safe, (forkReport.safeBatches.authority as any).actions)
				await inspectAuthority(ethers, input, forkReport)
				if ((forkReport.safeBatches.authority as any).actions.length) throw new Error("Fork authority bootstrap did not reach its post-state")
				await deployFacetScope(ethers, input, forkReport, forkOutput, "core", checkpoint)
				await deployFacetScope(ethers, input, forkReport, forkOutput, "accountLayer", checkpoint)
				await deployNewInstantLayer(hre, ethers, input, forkReport, checkpoint)
				await deployNewGaslessLayer(hre, ethers, input, forkReport, checkpoint)
				await planGovernance(ethers, input, forkReport, forkOutput)
				await executeActions(safe, (forkReport.safeBatches.coreCut as any).actions)
				await planGovernance(ethers, input, forkReport, forkOutput)
				await executeActions(safe, (forkReport.safeBatches.accountCut as any).actions)
				await planGovernance(ethers, input, forkReport, forkOutput)
				await executeActions(safe, (forkReport.safeBatches.wiring as any).actions)
				await planGovernance(ethers, input, forkReport, forkOutput)
				if ((forkReport.safeBatches.wiring as any).actions.length) throw new Error("Fork wiring did not reach its post-state")
				await executeActions(safe, (forkReport.safeBatches.cutover as any).actions)
				await planGovernance(ethers, input, forkReport, forkOutput)
				if ((forkReport.safeBatches.cutover as any).actions.length) throw new Error("Fork cutover did not reach its post-state")
			},
			`fork-${attemptId}`,
		)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		forkReport.lifecycle = "failed"
		updateStage(forkReport, "forkRehearsal", "failed", { baseBlockNumber, error: message })
		writeReport(forkOutput, input, forkReport)
		updateStage(liveReport, "forkRehearsal", "failed", {
			baseBlockNumber,
			evidence: forkOutput,
			transactionCount: forkReport.transactions.length,
			error: message,
		})
		throw error
	}
	forkReport.lifecycle = "complete"
	writeReport(forkOutput, input, forkReport)
	const blockNumber = await ethers.provider.getBlockNumber()
	updateStage(liveReport, "forkRehearsal", "complete", {
		baseBlockNumber,
		blockNumber,
		evidence: forkOutput,
		newInstantLayer: forkReport.addresses.newInstantLayer,
		newGaslessLayer: forkReport.addresses.newGaslessLayer,
		coreSelectorChanges: (forkReport.stages.coreFacets as any)?.selectorChangeCount,
		accountSelectorChanges: (forkReport.stages.accountLayerFacets as any)?.selectorChangeCount,
	})
}

async function executePhase(hre: any, phase: Phase, inputFile: string, outputFile: string): Promise<void> {
	const input = loadArbitrumPerpsUpgradeInput(inputFile)
	assertSourceBinding(input)
	const connection = await getConnection(hre)
	const { ethers } = connection
	const chainId = Number((await ethers.provider.getNetwork()).chainId)
	const simulated = connection.networkConfig?.type === "edr-simulated"
	assertInternalInvocation(phase, connection.networkName, simulated, chainId)
	const report = readReport(outputFile, input)
	try {
		switch (phase) {
			case "inspect":
				await inspectAuthority(ethers, input, report)
				break
			case "rehearse":
				await runForkRehearsal(hre, ethers, input, report, outputFile)
				break
			case "execute-account-authority":
				await withCheckpoint(input, report, "arbitrum", false, ethers, async () => executeAccountAuthority(ethers, input, report))
				break
			case "deploy-core-facets":
				await withCheckpoint(input, report, "arbitrum", false, ethers, checkpoint =>
					deployFacetScope(ethers, input, report, outputFile, "core", checkpoint),
				)
				break
			case "deploy-account-facets":
				await withCheckpoint(input, report, "arbitrum", false, ethers, checkpoint =>
					deployFacetScope(ethers, input, report, outputFile, "accountLayer", checkpoint),
				)
				break
			case "deploy-instant-layer":
				await withCheckpoint(input, report, "arbitrum", false, ethers, checkpoint => deployNewInstantLayer(hre, ethers, input, report, checkpoint))
				break
			case "deploy-gasless-layer":
				await withCheckpoint(input, report, "arbitrum", false, ethers, checkpoint => deployNewGaslessLayer(hre, ethers, input, report, checkpoint))
				break
			case "plan":
				await planGovernance(ethers, input, report, outputFile)
				break
			case "publish":
				await publishDeployments(hre, input, report, outputFile)
				break
			case "reconcile":
				await withCheckpoint(input, report, "arbitrum", false, ethers, async () => undefined)
				updateStage(report, "reconciliation", "complete", { transactionCount: report.transactions.length })
				break
			case "verify-final":
				await inspectFinalState(ethers, input, report, outputFile)
				break
		}
		writeReport(outputFile, input, report)
	} catch (error) {
		updateStage(report, phase, "failed", { error: error instanceof Error ? error.message : String(error) })
		report.lifecycle = "failed"
		writeReport(outputFile, input, report)
		throw error
	}
}

export const arbitrumPerpsUpgradeTask = task(
	"internal:arbitrum-perps-upgrade",
	"Internal resumable adapter for the registered Arbitrum Perps upgrade workflow",
)
	.addOption({
		name: "phase",
		description: `Independent phase: ${PHASES.join(", ")}`,
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({ name: "input", description: "Standard upgrade input JSON", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({ name: "output", description: "Standard upgrade report JSON", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.setAction(async () => ({
		default: async ({ phase, input, output }, hre) => {
			if (!PHASES.includes(phase as Phase)) throw new Error(`Unknown Arbitrum Perps upgrade phase ${JSON.stringify(phase)}`)
			if (!input || !output) throw new Error("Both --input and --output are required")
			await executePhase(hre, phase as Phase, input, output)
		},
	}))
	.build()
