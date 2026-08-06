import { verifyContract } from "@nomicfoundation/hardhat-verify/verify"

import { getDataDir, readDataIfExists, setDataScope, writeData } from "../utils/fs.js"
import {
	assertCheckpointContractsHaveCode,
	assertCheckpointManifest,
	clearCheckpoint,
	createCheckpoint,
	createDeploymentManifest,
	DeploymentCheckpoint,
	loadCheckpoint,
	saveCheckpoint,
	setCheckpointSimulated,
} from "./checkpoint.js"
import {
	assertDependencyAddressesHaveCode,
	assertRecipeNetworkTarget,
	componentCheckpointScope,
	componentReportRelativePath,
	CoreDependencyReport,
	DeploymentComponentName,
	RecipeNetworkTarget,
	SafeManualAction,
} from "./deploymentRecipe.js"
import { persistSubmittedTransaction, recoverCheckpointContractDeployments } from "./deploymentRecovery.js"
import { verificationProviderForChain } from "./explorer.js"
import { getConnection } from "./helpers.js"
import { createSymmioPartyBVerificationRecords, deploySymmioPartyB, SymmioPartyBVerificationRecord } from "./partyB.js"
import { assertMainnetDeploymentIdentitySafe } from "./safety.js"
import { deploySymbolManager } from "./symbolManager.js"
import {
	bindDeploymentTransactionWriteAhead,
	clearDeploymentTransactionWriteAhead,
	DeploymentTransactionRecord,
	getDeploymentTransactionJournal,
	reconcileDeploymentTransactions,
	resetDeploymentTransactionJournal,
	send,
} from "./tx.js"

type VerificationRecord = { name: string; address: string; constructorArguments: unknown[] }
type ComponentLifecycle = "validating" | "pending_handover" | "complete" | "failed"

export interface ComponentExecutionInput {
	recipeName: string
	recipePath: string
	recipeDigest: string
	target: RecipeNetworkTarget
	component: DeploymentComponentName
	componentConfig: Record<string, any>
	coreReport: CoreDependencyReport
	coreReportPath: string
	fresh: boolean
	verify: boolean
}

export interface ComponentHealthCheck {
	check: string
	status: "passed" | "pending" | "failed"
	expected?: string
	actual?: string
}

export interface ComponentPostStateInspection {
	checks: ComponentHealthCheck[]
	manualActions: SafeManualAction[]
}

export interface ComponentDeploymentReport {
	schemaVersion: 1
	deploymentId: string
	recipe: { name: string; path: string; digest: string }
	component: DeploymentComponentName
	network: string
	chainId: number
	mode: "deploy"
	lifecycle: ComponentLifecycle
	config: { admin: string; signer?: string; adlEnabled?: boolean; operator?: string }
	coreDependency: { reportPath: string; deploymentId: string; diamond: string; instantLayer: string }
	address?: string
	implementation?: string
	constructorArguments?: unknown[]
	verification: { policy: "required" | "not_applicable"; status: "pending" | "passed" | "skipped" | "failed"; records: VerificationRecord[] }
	health: { status: "pending" | "passed" | "failed"; checks: ComponentHealthCheck[] }
	manualActions: SafeManualAction[]
	transactions: DeploymentTransactionRecord[]
	error?: string
	startedAt: string
	updatedAt: string
}

export function summarizeComponentHealth(checks: ComponentHealthCheck[]): "passed" | "pending" | "failed" {
	if (checks.some(check => check.status === "failed")) return "failed"
	if (checks.some(check => check.status === "pending")) return "pending"
	return "passed"
}

function now(): string {
	return new Date().toISOString()
}

function mergeTransactionJournal(checkpoint: DeploymentCheckpoint): void {
	const records = [...(checkpoint.transactions || []), ...getDeploymentTransactionJournal()]
	checkpoint.transactions = [
		...new Map(records.map(record => [`${record.hash.toLowerCase()}:${record.replacementHash?.toLowerCase() || ""}`, record])).values(),
	]
	saveCheckpoint(checkpoint)
}

function writeComponentReport(report: ComponentDeploymentReport): void {
	report.updatedAt = now()
	writeData(componentReportRelativePath(report.recipe.name, report.component), report)
}

function archivePriorComponentReport(recipeName: string, component: DeploymentComponentName, nextDeploymentId: string): void {
	const current = readDataIfExists(componentReportRelativePath(recipeName, component))
	if (current === null) return
	const deploymentId = current?.deploymentId
	if (typeof deploymentId !== "string" || !/^[A-Za-z0-9._-]+$/.test(deploymentId)) {
		throw new Error(`Cannot archive ${component} report: deploymentId is missing or unsafe (${JSON.stringify(deploymentId)})`)
	}
	if (deploymentId === nextDeploymentId) return
	writeData(`components/${recipeName}/history/${component}-${deploymentId}-report.json`, current)
}

function safeAction(to: string, data: string, description: string): SafeManualAction {
	return { to, value: "0", data, description }
}

const ERC1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"

function sameManualAction(left: SafeManualAction, right: SafeManualAction): boolean {
	return (
		left.to.toLowerCase() === right.to.toLowerCase() &&
		left.value === right.value &&
		left.data.toLowerCase() === right.data.toLowerCase() &&
		left.description === right.description
	)
}

function assertManualActionsEqual(actual: SafeManualAction[], expected: SafeManualAction[], component: DeploymentComponentName): void {
	if (actual.length !== expected.length || actual.some((action, index) => !sameManualAction(action, expected[index]))) {
		throw new Error(`Internal ${component} handover mismatch: generated Safe actions do not match the independently inspected post-state`)
	}
}

/**
 * Canonical read-only PartyB post-state probe. Deployment and status both use this
 * inspector so a later status run cannot drift from the gate that created the report.
 */
export async function inspectPartyBPostState(
	ethers: any,
	input: {
		address: string
		implementation: string
		admin: string
		signer: string
		adlEnabled: boolean
		core: string
		instantLayer: string
	},
): Promise<ComponentPostStateInspection> {
	const address = ethers.getAddress(input.address)
	const implementation = ethers.getAddress(input.implementation)
	const admin = ethers.getAddress(input.admin)
	const signer = ethers.getAddress(input.signer)
	const core = ethers.getAddress(input.core)
	const instantLayerAddress = ethers.getAddress(input.instantLayer)
	const contract = await ethers.getContractAt("SymmioPartyB", address)
	const coreView = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", core)
	const coreControl = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", core)
	const instantLayer = await ethers.getContractAt("InstantLayer", instantLayerAddress)
	const roleHash = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name))
	const defaultAdminRole = await contract.DEFAULT_ADMIN_ROLE()
	const trustedRole = roleHash("TRUSTED_ROLE")
	const localRoles = [
		defaultAdminRole,
		trustedRole,
		roleHash("MANAGER_ROLE"),
		roleHash("SETTER_ROLE"),
		roleHash("PAUSER_ROLE"),
		roleHash("UNPAUSER_ROLE"),
	]
	const [runtimeCode, implementationCode, implementationStorage, boundCore, configuredSigner, multicastWhitelisted, trusted, registered, adl] =
		await Promise.all([
			ethers.provider.getCode(address),
			ethers.provider.getCode(implementation),
			ethers.provider.getStorage(address, ERC1967_IMPLEMENTATION_SLOT),
			contract.symmioAddress(),
			contract.signer(),
			contract.multicastWhitelist(instantLayerAddress),
			contract.hasRole(trustedRole, instantLayerAddress),
			coreView.isPartyB(address),
			coreView.isADLEnabled(address),
		])
	const [instantRegistered, instantOperatorRole, ...adminRoles] = await Promise.all([
		instantLayer.registeredPartyBs(address),
		instantLayer.hasRole(await instantLayer.OPERATOR_ROLE(), address),
		...localRoles.map(role => contract.hasRole(role, admin)),
	])
	const storedImplementation = ethers.getAddress(`0x${implementationStorage.slice(-40)}`)
	const manualActions: SafeManualAction[] = []
	if (!registered) {
		manualActions.push(safeAction(core, coreControl.interface.encodeFunctionData("registerPartyB", [address]), `Register PartyB ${address} on core`))
	}
	if (adl !== input.adlEnabled) {
		manualActions.push(
			safeAction(
				core,
				coreControl.interface.encodeFunctionData("setADLEnabled", [address, input.adlEnabled]),
				`Set ADL=${input.adlEnabled} for PartyB ${address}`,
			),
		)
	}
	if (!instantRegistered) {
		manualActions.push(
			safeAction(
				instantLayerAddress,
				instantLayer.interface.encodeFunctionData("registerPartyBs", [[address]]),
				`Register PartyB ${address} on InstantLayer`,
			),
		)
	}

	const checks: ComponentHealthCheck[] = []
	const check = (name: string, pass: boolean, expected?: string, actual?: string, pending = false) =>
		checks.push({ check: name, status: pass ? "passed" : pending ? "pending" : "failed", expected, actual })
	check("runtime bytecode", runtimeCode !== "0x", "deployed bytecode", runtimeCode === "0x" ? "0x" : undefined)
	check("ERC1967 implementation bytecode", implementationCode !== "0x", "deployed bytecode", implementationCode === "0x" ? "0x" : undefined)
	check("ERC1967 implementation binding", storedImplementation === implementation, implementation, storedImplementation)
	check("core binding", ethers.getAddress(boundCore) === core, core, boundCore)
	check("signer", ethers.getAddress(configuredSigner) === signer, signer, configuredSigner)
	check("InstantLayer multicast whitelist", multicastWhitelisted, "true", String(multicastWhitelisted))
	check("InstantLayer TRUSTED_ROLE", trusted, "true", String(trusted))
	for (const [index, role] of localRoles.entries()) check(`final admin role ${role}`, adminRoles[index], "true", String(adminRoles[index]))
	check("core PartyB registration", registered, "true", String(registered), !registered)
	check("core ADL setting", adl === input.adlEnabled, String(input.adlEnabled), String(adl), adl !== input.adlEnabled)
	check("InstantLayer PartyB registration", instantRegistered, "true", String(instantRegistered), !instantRegistered)
	check("InstantLayer OPERATOR_ROLE", instantOperatorRole, "true", String(instantOperatorRole), !instantOperatorRole && !instantRegistered)
	return { checks, manualActions }
}

/** Canonical read-only SymbolManager post-state probe shared by deploy and status. */
export async function inspectSymbolManagerPostState(
	ethers: any,
	input: { address: string; admin: string; operator: string; core: string },
): Promise<ComponentPostStateInspection> {
	const address = ethers.getAddress(input.address)
	const admin = ethers.getAddress(input.admin)
	const operator = ethers.getAddress(input.operator)
	const core = ethers.getAddress(input.core)
	const contract = await ethers.getContractAt("SymmioSymbolManager", address)
	const coreView = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", core)
	const coreControl = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", core)
	const roleHash = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name))
	const defaultAdminRole = await contract.DEFAULT_ADMIN_ROLE()
	const operatorRoles = [await contract.SYMBOL_ADDER_ROLE(), await contract.SYMBOL_REMOVER_ROLE()]
	const coreRoles = ["SYMBOL_MANAGER_ROLE", "FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE"]
	const [runtimeCode, boundCore, adminRole, ...roleStates] = await Promise.all([
		ethers.provider.getCode(address),
		contract.symmioAddress(),
		contract.hasRole(defaultAdminRole, admin),
		...operatorRoles.map(role => contract.hasRole(role, operator)),
		...coreRoles.map(role => coreView.hasRole(address, roleHash(role))),
	])
	const operatorRoleStates = roleStates.slice(0, operatorRoles.length)
	const coreRoleStates = roleStates.slice(operatorRoles.length)
	const manualActions: SafeManualAction[] = []
	for (const [index, role] of coreRoles.entries()) {
		if (coreRoleStates[index]) continue
		const hash = roleHash(role)
		manualActions.push(
			safeAction(core, coreControl.interface.encodeFunctionData("grantRole", [address, hash]), `Grant core ${role} to SymbolManager ${address}`),
		)
	}

	const checks: ComponentHealthCheck[] = []
	const check = (name: string, pass: boolean, expected?: string, actual?: string, pending = false) =>
		checks.push({ check: name, status: pass ? "passed" : pending ? "pending" : "failed", expected, actual })
	check("runtime bytecode", runtimeCode !== "0x", "deployed bytecode", runtimeCode === "0x" ? "0x" : undefined)
	check("constructor core binding", ethers.getAddress(boundCore) === core, core, boundCore)
	check("final admin role", adminRole, "true", String(adminRole))
	for (const [index, role] of operatorRoles.entries()) {
		check(`operator role ${role}`, operatorRoleStates[index], "true", String(operatorRoleStates[index]))
	}
	for (const [index, role] of coreRoles.entries()) {
		check(`core role ${role}`, coreRoleStates[index], "true", String(coreRoleStates[index]), !coreRoleStates[index])
	}
	return { checks, manualActions }
}

async function verifyRecords(hre: any, chainId: number, records: VerificationRecord[]): Promise<void> {
	const provider = verificationProviderForChain(chainId)
	for (const record of records) {
		try {
			await verifyContract(
				{
					address: record.address,
					constructorArgs: record.constructorArguments,
					contract: record.name.includes(":") ? record.name : undefined,
					provider,
				},
				hre,
			)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (message.includes("Already Verified") || message.toLowerCase().includes("already verified")) continue
			throw new Error(`Explorer verification failed for ${record.name} at ${record.address}: ${message}`)
		}
	}
}

async function requireAddress(ethers: any, value: unknown, label: string): Promise<string> {
	if (typeof value !== "string" || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
		throw new Error(`${label} must be a valid non-zero address; received ${JSON.stringify(value)}`)
	}
	return ethers.getAddress(value)
}

/**
 * Prove that every possible deferred action has a real executor before a component is
 * created. A Safe-ready calldata blob is useful only when the named Safe holds the exact
 * role that authorizes it; custom core roles do not inherit from DEFAULT_ADMIN_ROLE.
 */
export async function assertComponentDeploymentAuthority(
	ethers: any,
	component: DeploymentComponentName,
	coreReport: CoreDependencyReport,
	deployerAddress: string,
): Promise<void> {
	const core = coreReport.addresses.diamond
	const admin = await requireAddress(ethers, coreReport.config.admin, "core deployment report admin")
	const deployer = await requireAddress(ethers, deployerAddress, "component deployer")
	const roleHash = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name))
	const view = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", core)

	if (component === "partyB") {
		const managerRole = roleHash("PARTY_B_MANAGER_ROLE")
		const [deployerCanManagePartyB, adminCanManagePartyB] = await Promise.all([view.hasRole(deployer, managerRole), view.hasRole(admin, managerRole)])
		if (!deployerCanManagePartyB && !adminCanManagePartyB) {
			throw new Error(`AUTHORITY_MISSING: neither deployer ${deployer} nor dependency-report admin ${admin} holds core PARTY_B_MANAGER_ROLE`)
		}
		const instantLayer = await ethers.getContractAt("InstantLayer", coreReport.addresses.instantLayer)
		const setterRole = await instantLayer.SETTER_ROLE()
		const [deployerCanSetInstant, adminCanSetInstant] = await Promise.all([
			instantLayer.hasRole(setterRole, deployer),
			instantLayer.hasRole(setterRole, admin),
		])
		if (!deployerCanSetInstant && !adminCanSetInstant) {
			throw new Error(`AUTHORITY_MISSING: neither deployer ${deployer} nor dependency-report admin ${admin} holds InstantLayer SETTER_ROLE`)
		}
		return
	}

	if (component === "symbolManager") {
		for (const role of ["SYMBOL_MANAGER_ROLE", "FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE"]) {
			const hash = roleHash(role)
			const [deployerCanAdmin, adminCanAdmin] = await Promise.all([view.isRoleAdmin(deployer, hash), view.isRoleAdmin(admin, hash)])
			if (!deployerCanAdmin && !adminCanAdmin) {
				throw new Error(`AUTHORITY_MISSING: neither deployer ${deployer} nor dependency-report admin ${admin} can administer core ${role}`)
			}
		}
	}
}

async function executePartyB(
	hre: any,
	checkpoint: DeploymentCheckpoint,
	input: ComponentExecutionInput,
	deployer: any,
): Promise<{
	address: string
	implementation: string
	records: SymmioPartyBVerificationRecord[]
	manualActions: SafeManualAction[]
	checks: ComponentHealthCheck[]
}> {
	const { ethers } = await getConnection(hre)
	const admin = await requireAddress(ethers, input.componentConfig.admin || input.coreReport.config.admin, "partyB.admin")
	const signer = await requireAddress(ethers, input.componentConfig.signer, "partyB.signer")
	const core = input.coreReport.addresses.diamond
	const instantLayerAddress = input.coreReport.addresses.instantLayer
	const adlEnabled = input.componentConfig.adlEnabled === true

	const contract = await deploySymmioPartyB(hre, {
		symmioAddress: core,
		admin: deployer.address,
		logData: false,
		checkpoint,
	})
	const address = await contract.getAddress()
	const implementation = checkpoint.contracts.symmioPartyB?.implementation
	if (!implementation) throw new Error(`SymmioPartyB ${address} has no checkpointed ERC1967 implementation`)
	const factory = await ethers.getContractFactory("SymmioPartyB")
	const records = createSymmioPartyBVerificationRecords(factory, { proxy: address, implementation }, [deployer.address, core])
	const roleHash = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name))
	const defaultAdminRole = await contract.DEFAULT_ADMIN_ROLE()

	for (const role of [
		{ name: "DEFAULT_ADMIN_ROLE", hash: defaultAdminRole },
		{ name: "TRUSTED_ROLE", hash: roleHash("TRUSTED_ROLE") },
		{ name: "MANAGER_ROLE", hash: roleHash("MANAGER_ROLE") },
		{ name: "SETTER_ROLE", hash: roleHash("SETTER_ROLE") },
		{ name: "PAUSER_ROLE", hash: roleHash("PAUSER_ROLE") },
		{ name: "UNPAUSER_ROLE", hash: roleHash("UNPAUSER_ROLE") },
	]) {
		if (!(await contract.hasRole(role.hash, admin))) {
			await send(contract.connect(deployer).grantRole(role.hash, admin), `grant SymmioPartyB ${role.name} to final admin`)
		}
	}

	const setterRole = roleHash("SETTER_ROLE")
	const currentSigner = ethers.getAddress(await contract.signer())
	if (currentSigner !== signer) {
		if (!(await contract.hasRole(setterRole, deployer.address))) {
			if (!(await contract.hasRole(defaultAdminRole, deployer.address))) {
				throw new Error(
					`AUTHORITY_MISSING: SymmioPartyB signer is ${currentSigner}, expected ${signer}, but deployer ${deployer.address} no longer holds SETTER_ROLE or DEFAULT_ADMIN_ROLE`,
				)
			}
			await send(contract.connect(deployer).grantRole(setterRole, deployer.address), "grant temporary SymmioPartyB SETTER_ROLE to deployer")
		}
		await send(contract.connect(deployer).setSigner(signer), "set SymmioPartyB signer")
	}
	if (!(await contract.multicastWhitelist(instantLayerAddress))) {
		await send(contract.connect(deployer).setMulticastWhitelist(instantLayerAddress, true), "whitelist InstantLayer on SymmioPartyB")
	}
	const trustedRole = roleHash("TRUSTED_ROLE")
	if (!(await contract.hasRole(trustedRole, instantLayerAddress))) {
		await send(contract.connect(deployer).grantRole(trustedRole, instantLayerAddress), "grant SymmioPartyB TRUSTED_ROLE to InstantLayer")
	}

	const coreView = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", core)
	const coreControl = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", core)
	const instantLayer = await ethers.getContractAt("InstantLayer", instantLayerAddress)
	const manualActions: SafeManualAction[] = []
	const partyBManagerRole = roleHash("PARTY_B_MANAGER_ROLE")
	if (!(await coreView.isPartyB(address))) {
		if (await coreView.hasRole(deployer.address, partyBManagerRole)) {
			await send(coreControl.connect(deployer).registerPartyB(address), "register standalone PartyB on core")
		} else {
			manualActions.push(
				safeAction(core, coreControl.interface.encodeFunctionData("registerPartyB", [address]), `Register PartyB ${address} on core`),
			)
		}
	}
	if ((await coreView.isADLEnabled(address)) !== adlEnabled) {
		if (await coreView.hasRole(deployer.address, partyBManagerRole)) {
			await send(coreControl.connect(deployer).setADLEnabled(address, adlEnabled), `set standalone PartyB ADL=${adlEnabled}`)
		} else {
			manualActions.push(
				safeAction(
					core,
					coreControl.interface.encodeFunctionData("setADLEnabled", [address, adlEnabled]),
					`Set ADL=${adlEnabled} for PartyB ${address}`,
				),
			)
		}
	}
	const instantSetterRole = await instantLayer.SETTER_ROLE()
	if (!(await instantLayer.registeredPartyBs(address))) {
		if (await instantLayer.hasRole(instantSetterRole, deployer.address)) {
			await send(instantLayer.connect(deployer).registerPartyBs([address]), "register standalone PartyB on InstantLayer")
		} else {
			manualActions.push(
				safeAction(
					instantLayerAddress,
					instantLayer.interface.encodeFunctionData("registerPartyBs", [[address]]),
					`Register PartyB ${address} on InstantLayer`,
				),
			)
		}
	}

	// The deployer is initial admin solely so a standalone run can finish PartyB-local
	// configuration. Strip every privilege only after the final admin roles are proven.
	if (admin.toLowerCase() !== deployer.address.toLowerCase()) {
		const rolesToRenounce = [defaultAdminRole, trustedRole, roleHash("MANAGER_ROLE"), setterRole]
		for (const role of rolesToRenounce) {
			if (!(await contract.hasRole(role, admin))) throw new Error(`Refusing to renounce deployer role ${role}: final admin ${admin} does not hold it`)
		}
		// DEFAULT_ADMIN_ROLE is deliberately last.
		for (const role of [...rolesToRenounce.slice(1), defaultAdminRole]) {
			if (await contract.hasRole(role, deployer.address)) {
				await send(contract.connect(deployer).renounceRole(role, deployer.address), `renounce deployer SymmioPartyB role ${role}`)
			}
		}
	}

	const inspection = await inspectPartyBPostState(ethers, {
		address,
		implementation,
		admin,
		signer,
		adlEnabled,
		core,
		instantLayer: instantLayerAddress,
	})
	assertManualActionsEqual(manualActions, inspection.manualActions, "partyB")
	return { address, implementation, records, manualActions, checks: inspection.checks }
}

async function executeSymbolManager(
	hre: any,
	checkpoint: DeploymentCheckpoint,
	input: ComponentExecutionInput,
	deployer: any,
): Promise<{ address: string; records: VerificationRecord[]; manualActions: SafeManualAction[]; checks: ComponentHealthCheck[] }> {
	const { ethers } = await getConnection(hre)
	const admin = await requireAddress(ethers, input.componentConfig.admin || input.coreReport.config.admin, "symbolManager.admin")
	const operator = await requireAddress(ethers, input.componentConfig.operator, "symbolManager.operator")
	const core = input.coreReport.addresses.diamond
	const contract = await deploySymbolManager(hre, { symmioAddress: core, admin: deployer.address, logData: false, checkpoint })
	const address = await contract.getAddress()
	const constructorArguments = checkpoint.contracts.symbolManager?.constructorArgs || [core, deployer.address]
	const records: VerificationRecord[] = [
		{
			name: "contracts/helpers/symbolManager/SymmioSymbolManager.sol:SymmioSymbolManager",
			address,
			constructorArguments,
		},
	]
	const defaultAdminRole = await contract.DEFAULT_ADMIN_ROLE()
	const operatorRoles = [await contract.SYMBOL_ADDER_ROLE(), await contract.SYMBOL_REMOVER_ROLE()]
	for (const role of operatorRoles) {
		if (!(await contract.hasRole(role, operator))) {
			await send(contract.connect(deployer).grantRole(role, operator), `grant SymbolManager operator role ${role}`)
		}
	}
	if (!(await contract.hasRole(defaultAdminRole, admin))) {
		await send(contract.connect(deployer).grantRole(defaultAdminRole, admin), "grant SymbolManager DEFAULT_ADMIN_ROLE to final admin")
	}

	const roleHash = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name))
	const coreView = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", core)
	const coreControl = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", core)
	const coreRoles = ["SYMBOL_MANAGER_ROLE", "FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE"]
	const manualActions: SafeManualAction[] = []
	for (const role of coreRoles) {
		const hash = roleHash(role)
		if (await coreView.hasRole(address, hash)) continue
		if (await coreView.isRoleAdmin(deployer.address, hash)) {
			await send(coreControl.connect(deployer).grantRole(address, hash), `grant core ${role} to standalone SymbolManager`)
		} else {
			manualActions.push(
				safeAction(core, coreControl.interface.encodeFunctionData("grantRole", [address, hash]), `Grant core ${role} to SymbolManager ${address}`),
			)
		}
	}

	if (admin.toLowerCase() !== deployer.address.toLowerCase() && (await contract.hasRole(defaultAdminRole, deployer.address))) {
		if (!(await contract.hasRole(defaultAdminRole, admin))) {
			throw new Error(`Refusing to renounce SymbolManager admin: final admin ${admin} does not hold DEFAULT_ADMIN_ROLE`)
		}
		await send(contract.connect(deployer).renounceRole(defaultAdminRole, deployer.address), "renounce deployer SymbolManager DEFAULT_ADMIN_ROLE")
	}

	const inspection = await inspectSymbolManagerPostState(ethers, { address, admin, operator, core })
	assertManualActionsEqual(manualActions, inspection.manualActions, "symbolManager")
	return { address, records, manualActions, checks: inspection.checks }
}

/** Execute one safely resumable product component against a previously proven core. */
export async function executeComponentDeployment(hre: any, input: ComponentExecutionInput) {
	if (input.component !== "partyB" && input.component !== "symbolManager") {
		throw new Error(`LIVE_TARGET_UNSUPPORTED: component ${input.component} has no complete safe deployment workflow`)
	}
	if (input.componentConfig.mode !== "deploy") {
		throw new Error(`LIVE_TARGET_UNSUPPORTED: deploy:component requires ${input.component}.mode=deploy; received ${input.componentConfig.mode}`)
	}

	const connection = await getConnection(hre)
	const { ethers } = connection
	const [deployer] = await ethers.getSigners()
	if (!deployer) throw new Error("No deployment signer is configured for deploy:component")
	const chainId = Number((await ethers.provider.getNetwork()).chainId)
	const network = connection.networkName || "unknown"
	const simulated = connection.networkConfig?.type === "edr-simulated"
	assertRecipeNetworkTarget(input.target, { network, chainId, simulated })
	assertMainnetDeploymentIdentitySafe(chainId, deployer.address, input.componentConfig.admin || input.coreReport.config.admin, simulated)
	await assertDependencyAddressesHaveCode(input.coreReport, address => ethers.provider.getCode(address))
	// Validate component-local inputs and every external authority before checkpoint
	// mutation or contract creation. Later helpers normalize the same values again.
	await requireAddress(ethers, input.componentConfig.admin || input.coreReport.config.admin, `${input.component}.admin`)
	if (input.component === "partyB") await requireAddress(ethers, input.componentConfig.signer, "partyB.signer")
	if (input.component === "symbolManager") await requireAddress(ethers, input.componentConfig.operator, "symbolManager.operator")
	if (input.component === "partyB" && typeof input.componentConfig.adlEnabled !== "boolean") {
		throw new Error(`partyB.adlEnabled must be a boolean; received ${JSON.stringify(input.componentConfig.adlEnabled)}`)
	}
	await assertComponentDeploymentAuthority(ethers, input.component, input.coreReport, deployer.address)
	const publicConfig =
		input.component === "partyB"
			? {
					admin: ethers.getAddress(input.componentConfig.admin || input.coreReport.config.admin),
					signer: ethers.getAddress(input.componentConfig.signer),
					adlEnabled: input.componentConfig.adlEnabled as boolean,
				}
			: {
					admin: ethers.getAddress(input.componentConfig.admin || input.coreReport.config.admin),
					operator: ethers.getAddress(input.componentConfig.operator),
				}

	const live = input.target.mode === "live"
	if (live && !input.verify) throw new Error("Explorer verification is mandatory for live component deployments; --verify=false is refused")
	setDataScope(chainId, { simulated })
	setCheckpointSimulated(simulated)
	const scope = componentCheckpointScope(input.recipeName, input.component)
	const existingCheckpoint = loadCheckpoint(chainId, scope)
	if (input.fresh && existingCheckpoint) {
		clearCheckpoint(chainId, network, existingCheckpoint.step === "complete" ? "completed" : "abandoned", scope)
	}
	let checkpoint = input.fresh ? null : existingCheckpoint
	const isResume = checkpoint !== null
	checkpoint ||= createCheckpoint(network, chainId, scope)
	const manifest = createDeploymentManifest(
		{
			recipe: { name: input.recipeName, path: input.recipePath, digest: input.recipeDigest },
			component: input.component,
			componentConfig: input.componentConfig,
			coreDependency: {
				deploymentId: input.coreReport.deploymentId,
				diamond: input.coreReport.addresses.diamond,
				instantLayer: input.coreReport.addresses.instantLayer,
			},
			deployer: deployer.address,
			network: input.target,
		},
		{ deploymentId: checkpoint.deploymentId || checkpoint.manifest?.deploymentId },
	)
	if (isResume) assertCheckpointManifest(checkpoint, manifest)
	archivePriorComponentReport(input.recipeName, input.component, manifest.deploymentId)
	checkpoint.deploymentId = manifest.deploymentId
	checkpoint.deployerAddress = deployer.address
	checkpoint.manifest = manifest
	checkpoint.verificationRequired = live
	if (isResume) {
		try {
			await reconcileDeploymentTransactions(checkpoint.transactions || [], ethers.provider, checkpoint.deployerAddress)
		} finally {
			saveCheckpoint(checkpoint)
		}
	}
	await recoverCheckpointContractDeployments(checkpoint, ethers.provider, "contracts")
	await assertCheckpointContractsHaveCode(checkpoint, address => ethers.provider.getCode(address))
	saveCheckpoint(checkpoint)

	const report: ComponentDeploymentReport = {
		schemaVersion: 1,
		deploymentId: manifest.deploymentId,
		recipe: { name: input.recipeName, path: input.recipePath, digest: input.recipeDigest },
		component: input.component,
		network,
		chainId,
		mode: "deploy",
		lifecycle: "validating",
		config: publicConfig,
		coreDependency: {
			reportPath: input.coreReportPath,
			deploymentId: input.coreReport.deploymentId,
			diamond: input.coreReport.addresses.diamond,
			instantLayer: input.coreReport.addresses.instantLayer,
		},
		verification: { policy: live ? "required" : "not_applicable", status: live ? "pending" : "skipped", records: [] },
		health: { status: "pending", checks: [] },
		manualActions: [],
		transactions: checkpoint.transactions || [],
		startedAt: checkpoint.startedAt,
		updatedAt: now(),
	}
	writeComponentReport(report)

	resetDeploymentTransactionJournal()
	bindDeploymentTransactionWriteAhead(record => persistSubmittedTransaction(checkpoint!, record))
	try {
		const result =
			input.component === "partyB"
				? await executePartyB(hre, checkpoint, input, deployer)
				: await executeSymbolManager(hre, checkpoint, input, deployer)
		report.address = result.address
		report.implementation = (result as { implementation?: string }).implementation
		report.constructorArguments = result.records[result.records.length - 1]?.constructorArguments
		report.manualActions = result.manualActions
		report.health.checks = result.checks
		report.health.status = summarizeComponentHealth(result.checks)
		const failedChecks = result.checks.filter(check => check.status === "failed")
		if (failedChecks.length > 0) throw new Error(`Component post-state health failed: ${failedChecks.map(check => check.check).join(", ")}`)
		report.verification.records = result.records
		if (live) {
			await verifyRecords(hre, chainId, result.records)
			checkpoint.verificationStatus = "passed"
			report.verification.status = "passed"
		}
		report.lifecycle = report.manualActions.length > 0 || report.health.status === "pending" ? "pending_handover" : "complete"
		checkpoint.step = report.lifecycle
		return { report, reportPath: `${getDataDir()}/${componentReportRelativePath(input.recipeName, input.component)}` }
	} catch (error) {
		report.lifecycle = "failed"
		report.health.status = report.health.status === "passed" ? "passed" : "failed"
		if (live && report.verification.status === "pending") report.verification.status = "failed"
		report.error = error instanceof Error ? error.message : String(error)
		checkpoint.step = "failed"
		throw error
	} finally {
		clearDeploymentTransactionWriteAhead()
		mergeTransactionJournal(checkpoint)
		report.transactions = checkpoint.transactions || []
		saveCheckpoint(checkpoint)
		writeComponentReport(report)
	}
}
