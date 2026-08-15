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
import { ensureCreate2Factory } from "./create2Factory.js"
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
import {
	createExpressVerificationRecords,
	deployExpressProviderDiamond,
	EXPRESS_CONTROL_FACET,
	EXPRESS_FACETS,
} from "./expressWithdrawLayerDiamond.js"
import { getConnection } from "./helpers.js"
import { logger } from "./logger.js"
import { createSymmioPartyBVerificationRecords, deploySymmioPartyB, SymmioPartyBVerificationRecord } from "./partyB.js"
import { activeDeploymentRecipe } from "./recipeRuntime.js"
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
import { type VanityContext, createVanityContext } from "./vanityDeploy.js"
import { buildVanityPlan } from "./vanityPlan.js"

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
	mode: "deploy" | "patch"
	lifecycle: ComponentLifecycle
	config: {
		admin: string
		signer?: string
		adlEnabled?: boolean
		operator?: string
		/**
		 * The exact applied intent, so a later status run re-proves the same state this run
		 * gated on. A deploy stores the full resolved config; a patch stores the baseline
		 * merged with every section it declared — the next patch computes removals from it.
		 */
		expressProvider?: ExpressStoredConfig
	}
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

export interface ExpressAffiliateConfig {
	address: string
	feeRate: string
	operatorFee: string
	maxDebt: string
	maxDebtBps: number
	minValidatorSignatures?: number
	validatorApprovalTimeout?: number
	validators?: string[]
}

export interface ExpressProviderResolvedConfig {
	address: string
	admin: string
	deployer: string
	core: string
	collateral: string
	/** Absent together when the recipe defers the creditLine section; nothing is written on-chain. */
	signatureVerifier?: string
	muonAppId?: string
	muonFreshnessWindow?: number
	securityWindow?: number
	tolerancePeriod?: number
	roles: Record<string, string[]>
	affiliates: ExpressAffiliateConfig[]
	registerOnCore: boolean
}

/** Roles Init grants to whoever it is initialized with — here, the deployer. */
const EXPRESS_INIT_ADMIN_ROLES = ["SETTER_ROLE", "FEE_CLAIMER_ROLE", "WITHDRAWER_ROLE", "PAUSER_ROLE"]

/**
 * Canonical read-only ExpressProvider post-state probe shared by deploy and status.
 *
 * This provider can pull real collateral out of core, so the health gate proves the whole
 * operating surface: core/collateral binding, credit-line Muon inputs, per-affiliate policy,
 * validator sets, every configured role holder, and that the deployer kept no privilege.
 */
export async function inspectExpressProviderPostState(ethers: any, input: ExpressProviderResolvedConfig): Promise<ComponentPostStateInspection> {
	const address = ethers.getAddress(input.address)
	const admin = ethers.getAddress(input.admin)
	const deployer = ethers.getAddress(input.deployer)
	const core = ethers.getAddress(input.core)
	const view = await ethers.getContractAt(EXPRESS_FACETS.ViewFacet, address)
	const control = await ethers.getContractAt(EXPRESS_CONTROL_FACET, address)
	const coreView = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", core)
	const coreControl = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", core)
	const roleHash = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name))

	const [runtimeCode, boundSymmio, boundCollateral, verifier, appId, freshness, securityWindow, tolerancePeriod, owner, pendingOwner, registered] =
		await Promise.all([
			ethers.provider.getCode(address),
			view.symmio(),
			view.collateral(),
			view.creditLineSignatureVerifier(),
			view.creditLineMuonAppId(),
			view.creditLineMuonFreshnessWindow(),
			view.securityWindow(),
			view.tolerancePeriod(),
			control.owner(),
			control.pendingOwner(),
			coreView.isExpressProviderRegistered(address),
		])

	const checks: ComponentHealthCheck[] = []
	const check = (name: string, pass: boolean, expected?: string, actual?: string, pending = false) =>
		checks.push({ check: name, status: pass ? "passed" : pending ? "pending" : "failed", expected, actual })

	check("runtime bytecode", runtimeCode !== "0x", "deployed bytecode", runtimeCode === "0x" ? "0x" : undefined)
	check("core binding", ethers.getAddress(boundSymmio) === core, core, boundSymmio)
	check("collateral binding", ethers.getAddress(boundCollateral) === ethers.getAddress(input.collateral), input.collateral, boundCollateral)
	// A deferred creditLine section has nothing to prove: no verifier was written, and reserveDebt
	// stays closed until a later patch supplies one.
	if (input.signatureVerifier !== undefined) {
		check(
			"credit line signature verifier",
			ethers.getAddress(verifier) === ethers.getAddress(input.signatureVerifier),
			input.signatureVerifier,
			verifier,
		)
		check("credit line muon app id", appId.toString() === input.muonAppId, input.muonAppId, appId.toString())
		check(
			"credit line muon freshness window",
			Number(freshness) === input.muonFreshnessWindow,
			String(input.muonFreshnessWindow),
			freshness.toString(),
		)
	}
	if (input.securityWindow !== undefined) {
		check("security window", Number(securityWindow) === input.securityWindow, String(input.securityWindow), securityWindow.toString())
	}
	if (input.tolerancePeriod !== undefined) {
		check("tolerance period", Number(tolerancePeriod) === input.tolerancePeriod, String(input.tolerancePeriod), tolerancePeriod.toString())
	}

	for (const [role, holders] of Object.entries(input.roles)) {
		const hash = roleHash(role)
		const states = await Promise.all(holders.map((holder: string) => view.hasRole(hash, ethers.getAddress(holder))))
		for (const [index, holder] of holders.entries()) {
			check(`${role} for ${ethers.getAddress(holder)}`, states[index], "true", String(states[index]))
		}
	}

	// Init grants these to the deployer. The final admin must hold them, and the deployer
	// must not, or a compromised deployer key still controls the provider's money paths.
	const adminRoleStates = await Promise.all(EXPRESS_INIT_ADMIN_ROLES.map(role => view.hasRole(roleHash(role), admin)))
	for (const [index, role] of EXPRESS_INIT_ADMIN_ROLES.entries()) {
		check(`final admin ${role}`, adminRoleStates[index], "true", String(adminRoleStates[index]))
	}
	if (admin !== deployer) {
		const deployerRoleStates = await Promise.all(EXPRESS_INIT_ADMIN_ROLES.map(role => view.hasRole(roleHash(role), deployer)))
		for (const [index, role] of EXPRESS_INIT_ADMIN_ROLES.entries()) {
			check(`deployer ${role} revoked`, !deployerRoleStates[index], "false", String(deployerRoleStates[index]))
		}
	}

	for (const affiliate of input.affiliates) {
		const target = ethers.getAddress(affiliate.address)
		const [config, protocolMaxDebt, protocolMaxDebtBps, minSignatures, approvalTimeout] = await Promise.all([
			view.affiliateConfigs(target),
			view.creditLineProtocolMaxDebt(target),
			view.creditLineProtocolMaxDebtBps(target),
			view.minValidatorSignatures(target),
			view.validatorApprovalTimeout(target),
		])
		check(`affiliate ${target} feeRate`, config[0].toString() === affiliate.feeRate, affiliate.feeRate, config[0].toString())
		check(`affiliate ${target} operatorFee`, config[1].toString() === affiliate.operatorFee, affiliate.operatorFee, config[1].toString())
		check(`affiliate ${target} protocol maxDebt`, protocolMaxDebt.toString() === affiliate.maxDebt, affiliate.maxDebt, protocolMaxDebt.toString())
		check(
			`affiliate ${target} protocol maxDebtBps`,
			Number(protocolMaxDebtBps) === affiliate.maxDebtBps,
			String(affiliate.maxDebtBps),
			protocolMaxDebtBps.toString(),
		)
		if (affiliate.minValidatorSignatures !== undefined) {
			check(
				`affiliate ${target} minValidatorSignatures`,
				Number(minSignatures) === affiliate.minValidatorSignatures,
				String(affiliate.minValidatorSignatures),
				minSignatures.toString(),
			)
		}
		if (affiliate.validatorApprovalTimeout !== undefined) {
			check(
				`affiliate ${target} validatorApprovalTimeout`,
				Number(approvalTimeout) === affiliate.validatorApprovalTimeout,
				String(affiliate.validatorApprovalTimeout),
				approvalTimeout.toString(),
			)
		}
		for (const validator of affiliate.validators || []) {
			const enabled = await view.isValidator(target, ethers.getAddress(validator))
			check(`affiliate ${target} validator ${ethers.getAddress(validator)}`, enabled, "true", String(enabled))
		}
	}

	const manualActions: SafeManualAction[] = []
	if (input.registerOnCore && !registered) {
		manualActions.push(
			safeAction(core, coreControl.interface.encodeFunctionData("registerExpressProvider", [address]), `Register ExpressProvider ${address} on core`),
		)
	}
	// Two-step ownership: the deployer initiates, the admin accepts. Until then the deployer
	// still owns the diamond, so this is reported as pending rather than healthy.
	const ownershipComplete = ethers.getAddress(owner) === admin
	if (!ownershipComplete && ethers.getAddress(pendingOwner) === admin) {
		manualActions.push(
			safeAction(address, control.interface.encodeFunctionData("acceptOwnership", []), `Accept ExpressProvider ownership at ${address}`),
		)
	}

	if (input.registerOnCore) check("core express provider registration", registered, "true", String(registered), !registered)
	check(
		"ownership handover",
		ownershipComplete,
		admin,
		ownershipComplete ? admin : `owner=${ethers.getAddress(owner)}, pending=${ethers.getAddress(pendingOwner)}`,
		ethers.getAddress(pendingOwner) === admin,
	)
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
	componentConfig: Record<string, any> = {},
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
		return
	}

	if (component === "expressProvider" && componentConfig.registerOnCore !== undefined) {
		// Without core registration the provider cannot call advanceWithdraw, so a run that can
		// neither register it nor hand a usable Safe action to someone who can is inert.
		const providerAdminRole = roleHash("PROVIDER_ADMIN_ROLE")
		const [deployerCanRegister, adminCanRegister] = await Promise.all([
			view.hasRole(deployer, providerAdminRole),
			view.hasRole(admin, providerAdminRole),
		])
		if (!deployerCanRegister && !adminCanRegister) {
			throw new Error(`AUTHORITY_MISSING: neither deployer ${deployer} nor dependency-report admin ${admin} holds core PROVIDER_ADMIN_ROLE`)
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

/**
 * Resolve every ExpressProvider input against the live core before any transaction.
 *
 * `signatureVerifier: "fromCore"` reads the core diamond's configured verifier so a standalone
 * Express run cannot drift from the core it is bound to, and the collateral always comes from
 * core because Init reverts on a mismatch.
 */
export async function resolveExpressProviderConfig(
	ethers: any,
	componentConfig: Record<string, any>,
	target: { core: string; admin: string },
	deployerAddress: string,
): Promise<Omit<ExpressProviderResolvedConfig, "address">> {
	const core = ethers.getAddress(target.core)
	const admin = await requireAddress(ethers, componentConfig.admin || target.admin, "expressProvider.admin")
	const coreView = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", core)
	const collateral = ethers.getAddress(await coreView.getCollateral())
	// An omitted creditLine section is a deferral, not a default: leave the verifier unset so
	// reserveDebt keeps reverting with CreditLineNotConfigured until a patch configures it.
	const declared = componentConfig.creditLine?.signatureVerifier
	let signatureVerifier: string | undefined
	if (declared !== undefined) {
		signatureVerifier =
			declared === "fromCore"
				? ethers.getAddress(await coreView.getSignatureVerifier())
				: await requireAddress(ethers, declared, "expressProvider.creditLine.signatureVerifier")
		if ((await ethers.provider.getCode(signatureVerifier)) === "0x") {
			throw new Error(`expressProvider.creditLine.signatureVerifier has no contract code at ${signatureVerifier}`)
		}
	}

	const roles: Record<string, string[]> = {}
	for (const [role, holders] of Object.entries(componentConfig.roles || {})) {
		roles[role] = await Promise.all((holders as string[]).map(holder => requireAddress(ethers, holder, `expressProvider.roles.${role}`)))
	}
	const affiliates: ExpressAffiliateConfig[] = []
	for (const [index, entry] of (componentConfig.affiliates || []).entries()) {
		affiliates.push({
			...entry,
			address: await requireAddress(ethers, entry.address, `expressProvider.affiliates[${index}].address`),
			validators: entry.validators
				? await Promise.all(
						(entry.validators as string[]).map((validator, position) =>
							requireAddress(ethers, validator, `expressProvider.affiliates[${index}].validators[${position}]`),
						),
					)
				: undefined,
		})
	}

	return {
		admin,
		deployer: ethers.getAddress(deployerAddress),
		core,
		collateral,
		signatureVerifier,
		muonAppId: componentConfig.creditLine?.muonAppId,
		muonFreshnessWindow: componentConfig.creditLine?.muonFreshnessWindow,
		securityWindow: componentConfig.securityWindow,
		tolerancePeriod: componentConfig.tolerancePeriod,
		roles,
		affiliates,
		registerOnCore: componentConfig.registerOnCore === true,
	}
}

/**
 * Deploy, configure, register, and hand over an ExpressProvider against an already-deployed
 * core. Shared by the standalone component workflow and the full `deploy:system` run, so both
 * produce the same on-chain state and the same health/handover evidence.
 */
export async function deployAndConfigureExpressProvider(
	hre: any,
	checkpoint: DeploymentCheckpoint,
	resolved: Omit<ExpressProviderResolvedConfig, "address">,
	deployer: any,
	vanity: VanityContext | null = null,
): Promise<{ address: string; records: VerificationRecord[]; manualActions: SafeManualAction[]; checks: ComponentHealthCheck[] }> {
	const { ethers } = await getConnection(hre)

	// The deployer is the Init admin and diamond owner solely so this run can configure the
	// provider. Both privileges are stripped before the run reports success.
	const deployment = await deployExpressProviderDiamond(hre, {
		owner: resolved.deployer,
		initAdmin: resolved.deployer,
		symmio: resolved.core,
		collateral: resolved.collateral,
		checkpoint,
		vanity,
	})
	const address = deployment.diamond
	const records = createExpressVerificationRecords(
		deployment,
		checkpoint.contracts.expressProvider?.diamond?.constructorArgs || [resolved.deployer, deployment.diamondCutFacet],
	)

	const control = await ethers.getContractAt(EXPRESS_CONTROL_FACET, address)
	const view = await ethers.getContractAt(EXPRESS_FACETS.ViewFacet, address)
	const roleHash = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name))
	const connected = control.connect(deployer)

	// Every setter is state-checked first so a resumed run repeats nothing it already proved.
	const [currentVerifier, currentAppId, currentFreshness] = await Promise.all([
		view.creditLineSignatureVerifier(),
		view.creditLineMuonAppId(),
		view.creditLineMuonFreshnessWindow(),
	])
	if (
		resolved.signatureVerifier !== undefined &&
		(ethers.getAddress(currentVerifier) !== resolved.signatureVerifier ||
			currentAppId.toString() !== resolved.muonAppId ||
			Number(currentFreshness) !== resolved.muonFreshnessWindow)
	) {
		await send(
			connected.setCreditLineMuonConfig(resolved.signatureVerifier, resolved.muonAppId, resolved.muonFreshnessWindow),
			"set ExpressProvider credit line Muon config",
		)
	}
	if (resolved.securityWindow !== undefined && Number(await view.securityWindow()) !== resolved.securityWindow) {
		await send(connected.setSecurityWindow(resolved.securityWindow), "set ExpressProvider security window")
	}
	if (resolved.tolerancePeriod !== undefined && Number(await view.tolerancePeriod()) !== resolved.tolerancePeriod) {
		await send(connected.setTolerancePeriod(resolved.tolerancePeriod), "set ExpressProvider tolerance period")
	}

	// Recipe validation lets a provider ship with any section deferred, but only while no signer
	// can make it accept anything. Name what is still missing rather than letting an inert
	// provider read as a finished one.
	const deferred = [
		resolved.signatureVerifier === undefined ? "creditLine (reserveDebt stays closed)" : undefined,
		resolved.affiliates.length === 0 ? "affiliates (an unconfigured affiliate is uncapped, not blocked)" : undefined,
		(resolved.roles.OPERATOR_ROLE?.length ?? 0) === 0 ? "roles.OPERATOR_ROLE (nothing can process an accepted withdrawal)" : undefined,
		resolved.registerOnCore ? undefined : "registerOnCore (core will not route withdrawals here)",
	].filter(Boolean)
	if (deferred.length > 0) {
		logger.warn(
			`ExpressProvider deployed with deferred setup: ${deferred.join(", ")}. Patch these in with expressProvider.mode=reuse ` +
				"before granting SIGNER_ROLE — a signer is what lets the provider accept credit offers.",
		)
	}

	for (const affiliate of resolved.affiliates) {
		const [config, maxDebt, maxDebtBps] = await Promise.all([
			view.affiliateConfigs(affiliate.address),
			view.creditLineProtocolMaxDebt(affiliate.address),
			view.creditLineProtocolMaxDebtBps(affiliate.address),
		])
		if (config[0].toString() !== affiliate.feeRate || config[1].toString() !== affiliate.operatorFee) {
			await send(
				connected.setAffiliateConfig(affiliate.address, affiliate.feeRate, affiliate.operatorFee),
				`set ExpressProvider affiliate config for ${affiliate.address}`,
			)
		}
		if (maxDebt.toString() !== affiliate.maxDebt || Number(maxDebtBps) !== affiliate.maxDebtBps) {
			await send(
				connected.setCreditLineProtocolConfig(affiliate.address, affiliate.maxDebt, affiliate.maxDebtBps),
				`set ExpressProvider protocol credit caps for ${affiliate.address}`,
			)
		}
		for (const validator of affiliate.validators || []) {
			if (await view.isValidator(affiliate.address, validator)) continue
			await send(connected.setValidator(affiliate.address, validator, true), `enable ExpressProvider validator ${validator}`)
		}
		if (
			affiliate.validatorApprovalTimeout !== undefined &&
			Number(await view.validatorApprovalTimeout(affiliate.address)) !== affiliate.validatorApprovalTimeout
		) {
			await send(
				connected.setValidatorApprovalTimeout(affiliate.address, affiliate.validatorApprovalTimeout),
				`set ExpressProvider validator approval timeout for ${affiliate.address}`,
			)
		}
		// Set the signature threshold last: raising it before the validators exist would leave a
		// window where the affiliate cannot be served.
		if (
			affiliate.minValidatorSignatures !== undefined &&
			Number(await view.minValidatorSignatures(affiliate.address)) !== affiliate.minValidatorSignatures
		) {
			await send(
				connected.setMinValidatorSignatures(affiliate.address, affiliate.minValidatorSignatures),
				`set ExpressProvider minimum validator signatures for ${affiliate.address}`,
			)
		}
	}

	for (const [role, holders] of Object.entries(resolved.roles)) {
		const hash = roleHash(role)
		for (const holder of holders) {
			if (await view.hasRole(hash, holder)) continue
			await send(connected.grantRole(hash, holder), `grant ExpressProvider ${role} to ${holder}`)
		}
	}
	for (const role of EXPRESS_INIT_ADMIN_ROLES) {
		const hash = roleHash(role)
		if (await view.hasRole(hash, resolved.admin)) continue
		await send(connected.grantRole(hash, resolved.admin), `grant ExpressProvider ${role} to final admin`)
	}

	const coreView = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", resolved.core)
	const coreControl = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", resolved.core)
	const manualActions: SafeManualAction[] = []
	if (resolved.registerOnCore && !(await coreView.isExpressProviderRegistered(address))) {
		if (await coreView.hasRole(deployer.address, roleHash("PROVIDER_ADMIN_ROLE"))) {
			await send(coreControl.connect(deployer).registerExpressProvider(address), "register ExpressProvider on core")
		} else {
			manualActions.push(
				safeAction(
					resolved.core,
					coreControl.interface.encodeFunctionData("registerExpressProvider", [address]),
					`Register ExpressProvider ${address} on core`,
				),
			)
		}
	}

	// Strip the deployer only after the final admin provably holds each role, then hand over
	// ownership. Ordering matters: revokeRole is owner-gated, so it must precede the transfer.
	if (resolved.admin !== resolved.deployer) {
		for (const role of EXPRESS_INIT_ADMIN_ROLES) {
			const hash = roleHash(role)
			if (!(await view.hasRole(hash, resolved.admin))) {
				throw new Error(`Refusing to revoke deployer ExpressProvider ${role}: final admin ${resolved.admin} does not hold it`)
			}
			if (await view.hasRole(hash, resolved.deployer)) {
				await send(connected.revokeRole(hash, resolved.deployer), `revoke deployer ExpressProvider ${role}`)
			}
		}
		const [owner, pendingOwner] = await Promise.all([control.owner(), control.pendingOwner()])
		if (ethers.getAddress(owner) !== resolved.admin && ethers.getAddress(pendingOwner) !== resolved.admin) {
			await send(connected.transferOwnership(resolved.admin), "initiate ExpressProvider ownership handover")
		}
		// Ownership is two-step: only the admin can complete it. Record that as deferred work in
		// the same order the inspector reports it, so the cross-check stays exact.
		if (ethers.getAddress(await control.owner()) !== resolved.admin) {
			manualActions.push(
				safeAction(address, control.interface.encodeFunctionData("acceptOwnership", []), `Accept ExpressProvider ownership at ${address}`),
			)
		}
	}

	const inspection = await inspectExpressProviderPostState(ethers, { ...resolved, address })
	assertManualActionsEqual(manualActions, inspection.manualActions, "expressProvider")
	return { address, records, manualActions, checks: inspection.checks }
}

async function executeExpressProvider(
	hre: any,
	checkpoint: DeploymentCheckpoint,
	input: ComponentExecutionInput,
	deployer: any,
): Promise<{ address: string; records: VerificationRecord[]; manualActions: SafeManualAction[]; checks: ComponentHealthCheck[] }> {
	const { ethers } = await getConnection(hre)
	const resolved = await resolveExpressProviderConfig(
		ethers,
		input.componentConfig,
		{ core: input.coreReport.addresses.diamond, admin: input.coreReport.config.admin },
		deployer.address,
	)
	// A standalone `--only expressProvider` run has no outer deployment to inherit from, so it
	// builds its vanity context from the same recipe block the full run uses.
	const vanityPlan = buildVanityPlan(activeDeploymentRecipe?.recipe.create2)
	if (vanityPlan) {
		// A component run always adds to an existing deployment, which by definition already has
		// a factory to reuse — so there is no --allow-new-create2-factory escape hatch here.
		await ensureCreate2Factory(hre, vanityPlan, {
			checkpoint,
			isLive: activeDeploymentRecipe?.recipe.network.mode === "live",
			allowNewFactory: false,
			logData: false,
		})
	}
	return deployAndConfigureExpressProvider(hre, checkpoint, resolved, deployer, createVanityContext(ethers, vanityPlan))
}

// ═══════════════════════ ExpressProvider patch (reuse-as-reconcile) ═══════════════════════
//
// A patch recipe sets expressProvider.mode to "reuse" with the deployed address and declares
// the sections it wants enforced. Declared sections are authoritative desired state — holders
// missing on chain are granted, holders present in the last applied config but absent from the
// recipe are revoked. Omitted sections are left untouched. Every mutation the signer lacks
// authority for becomes a Safe-ready manual action, exactly like the deploy handover.

/** What a report stores as applied intent: full for a deploy, per-declared-section for a patch. */
export type ExpressStoredConfig = Partial<Omit<ExpressProviderResolvedConfig, "address" | "admin" | "deployer" | "core">> & {
	admin: string
	deployer: string
	core: string
}

export type ExpressPatchConfig = ExpressStoredConfig & { address: string }

/** Resolve a patch's inputs. Only declared sections are resolved; the rest stay undefined. */
export async function resolveExpressPatchConfig(
	ethers: any,
	componentConfig: Record<string, any>,
	target: { core: string; admin: string },
	deployerAddress: string,
): Promise<ExpressPatchConfig> {
	const core = ethers.getAddress(target.core)
	const admin = await requireAddress(ethers, componentConfig.admin || target.admin, "expressProvider.admin")
	const address = await requireAddress(ethers, componentConfig.address, "expressProvider.address")
	const resolved: ExpressPatchConfig = { address, admin, deployer: ethers.getAddress(deployerAddress), core }

	if (componentConfig.creditLine !== undefined) {
		const declared = componentConfig.creditLine.signatureVerifier
		const signatureVerifier =
			declared === "fromCore"
				? ethers.getAddress(
						await (await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", core)).getSignatureVerifier(),
					)
				: await requireAddress(ethers, declared, "expressProvider.creditLine.signatureVerifier")
		if ((await ethers.provider.getCode(signatureVerifier)) === "0x") {
			throw new Error(`expressProvider.creditLine.signatureVerifier has no contract code at ${signatureVerifier}`)
		}
		resolved.signatureVerifier = signatureVerifier
		resolved.muonAppId = componentConfig.creditLine.muonAppId
		resolved.muonFreshnessWindow = componentConfig.creditLine.muonFreshnessWindow
	}
	if (componentConfig.securityWindow !== undefined) resolved.securityWindow = componentConfig.securityWindow
	if (componentConfig.tolerancePeriod !== undefined) resolved.tolerancePeriod = componentConfig.tolerancePeriod
	if (componentConfig.registerOnCore !== undefined) resolved.registerOnCore = componentConfig.registerOnCore === true
	if (componentConfig.roles !== undefined) {
		const roles: Record<string, string[]> = {}
		for (const [role, holders] of Object.entries(componentConfig.roles)) {
			roles[role] = await Promise.all((holders as string[]).map(holder => requireAddress(ethers, holder, `expressProvider.roles.${role}`)))
		}
		resolved.roles = roles
	}
	if (componentConfig.affiliates !== undefined) {
		const affiliates: ExpressAffiliateConfig[] = []
		for (const [index, entry] of componentConfig.affiliates.entries()) {
			affiliates.push({
				...entry,
				address: await requireAddress(ethers, entry.address, `expressProvider.affiliates[${index}].address`),
				validators: entry.validators
					? await Promise.all(
							(entry.validators as string[]).map((validator: string, position: number) =>
								requireAddress(ethers, validator, `expressProvider.affiliates[${index}].validators[${position}]`),
							),
						)
					: undefined,
			})
		}
		resolved.affiliates = affiliates
	}
	return resolved
}

interface ExpressPatchItem {
	/** Stable identity for before/after comparison. */
	id: string
	description: string
	to: string
	data: string
	/** Direct-execution route when the signer is authorized. */
	method: string
	args: unknown[]
	authority: "setter" | "owner" | "providerAdmin"
}

export interface ExpressPatchDrift {
	items: ExpressPatchItem[]
	/** Affiliates present in the baseline but dropped from the recipe — never auto-cleared. */
	removedAffiliates: string[]
}

/**
 * Read-only diff between the live provider and the patch's declared sections. Run once to
 * decide what to send, and run again afterwards: anything still listed must be covered by a
 * queued Safe action, or the patch failed. Removals come from the baseline (the last applied
 * config in the component report) because on-chain role holders cannot be enumerated.
 */
export async function computeExpressPatchDrift(
	ethers: any,
	desired: ExpressPatchConfig,
	baseline: ExpressStoredConfig | null,
): Promise<ExpressPatchDrift> {
	const address = ethers.getAddress(desired.address)
	const view = await ethers.getContractAt(EXPRESS_FACETS.ViewFacet, address)
	const control = await ethers.getContractAt(EXPRESS_CONTROL_FACET, address)
	const roleHash = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name))
	const items: ExpressPatchItem[] = []
	const setter = (id: string, description: string, method: string, args: unknown[]) =>
		items.push({ id, description, to: address, data: control.interface.encodeFunctionData(method, args), method, args, authority: "setter" })

	if (desired.signatureVerifier !== undefined) {
		const [verifier, appId, freshness] = await Promise.all([
			view.creditLineSignatureVerifier(),
			view.creditLineMuonAppId(),
			view.creditLineMuonFreshnessWindow(),
		])
		if (
			ethers.getAddress(verifier) !== desired.signatureVerifier ||
			appId.toString() !== desired.muonAppId ||
			Number(freshness) !== desired.muonFreshnessWindow
		) {
			setter("creditLine", `Set credit line Muon config on ExpressProvider ${address}`, "setCreditLineMuonConfig", [
				desired.signatureVerifier,
				desired.muonAppId,
				desired.muonFreshnessWindow,
			])
		}
	}
	if (desired.securityWindow !== undefined && Number(await view.securityWindow()) !== desired.securityWindow) {
		setter("securityWindow", `Set security window to ${desired.securityWindow}s`, "setSecurityWindow", [desired.securityWindow])
	}
	if (desired.tolerancePeriod !== undefined && Number(await view.tolerancePeriod()) !== desired.tolerancePeriod) {
		setter("tolerancePeriod", `Set tolerance period to ${desired.tolerancePeriod}s`, "setTolerancePeriod", [desired.tolerancePeriod])
	}

	if (desired.roles !== undefined) {
		const wanted = new Set<string>()
		for (const [role, holders] of Object.entries(desired.roles)) {
			for (const holder of holders) {
				wanted.add(`${role}:${holder.toLowerCase()}`)
				if (!(await view.hasRole(roleHash(role), holder))) {
					items.push({
						id: `grant:${role}:${holder.toLowerCase()}`,
						description: `Grant ExpressProvider ${role} to ${holder}`,
						to: address,
						data: control.interface.encodeFunctionData("grantRole", [roleHash(role), holder]),
						method: "grantRole",
						args: [roleHash(role), holder],
						authority: "owner",
					})
				}
			}
		}
		for (const [role, holders] of Object.entries(baseline?.roles ?? {})) {
			for (const holder of holders) {
				if (wanted.has(`${role}:${holder.toLowerCase()}`)) continue
				if (!(await view.hasRole(roleHash(role), holder))) continue
				items.push({
					id: `revoke:${role}:${holder.toLowerCase()}`,
					description: `Revoke ExpressProvider ${role} from ${holder} (removed from the recipe)`,
					to: address,
					data: control.interface.encodeFunctionData("revokeRole", [roleHash(role), holder]),
					method: "revokeRole",
					args: [roleHash(role), holder],
					authority: "owner",
				})
			}
		}
	}

	const removedAffiliates: string[] = []
	if (desired.affiliates !== undefined) {
		const baselineByAddress = new Map((baseline?.affiliates ?? []).map(entry => [entry.address.toLowerCase(), entry]))
		for (const affiliate of desired.affiliates) {
			const target = ethers.getAddress(affiliate.address)
			const [config, maxDebt, maxDebtBps, approvalTimeout, minSignatures] = await Promise.all([
				view.affiliateConfigs(target),
				view.creditLineProtocolMaxDebt(target),
				view.creditLineProtocolMaxDebtBps(target),
				view.validatorApprovalTimeout(target),
				view.minValidatorSignatures(target),
			])
			if (config[0].toString() !== affiliate.feeRate || config[1].toString() !== affiliate.operatorFee) {
				setter(`affiliateConfig:${target.toLowerCase()}`, `Set fee config for affiliate ${target}`, "setAffiliateConfig", [
					target,
					affiliate.feeRate,
					affiliate.operatorFee,
				])
			}
			if (maxDebt.toString() !== affiliate.maxDebt || Number(maxDebtBps) !== affiliate.maxDebtBps) {
				setter(`credit caps:${target.toLowerCase()}`, `Set protocol credit caps for affiliate ${target}`, "setCreditLineProtocolConfig", [
					target,
					affiliate.maxDebt,
					affiliate.maxDebtBps,
				])
			}
			const wantedValidators = new Set((affiliate.validators ?? []).map(validator => validator.toLowerCase()))
			for (const validator of affiliate.validators ?? []) {
				if (!(await view.isValidator(target, validator))) {
					setter(`validator+:${target.toLowerCase()}:${validator.toLowerCase()}`, `Enable validator ${validator} for ${target}`, "setValidator", [
						target,
						validator,
						true,
					])
				}
			}
			const baselineEntry = baselineByAddress.get(target.toLowerCase())
			if (affiliate.validators !== undefined) {
				for (const validator of baselineEntry?.validators ?? []) {
					if (wantedValidators.has(validator.toLowerCase())) continue
					if (!(await view.isValidator(target, validator))) continue
					setter(
						`validator-:${target.toLowerCase()}:${validator.toLowerCase()}`,
						`Disable validator ${validator} for ${target} (removed from the recipe)`,
						"setValidator",
						[target, validator, false],
					)
				}
			}
			if (affiliate.validatorApprovalTimeout !== undefined && Number(approvalTimeout) !== affiliate.validatorApprovalTimeout) {
				setter(`validatorTimeout:${target.toLowerCase()}`, `Set validator approval timeout for ${target}`, "setValidatorApprovalTimeout", [
					target,
					affiliate.validatorApprovalTimeout,
				])
			}
			// Threshold last, so it is never raised above the validators that exist at that moment.
			if (affiliate.minValidatorSignatures !== undefined && Number(minSignatures) !== affiliate.minValidatorSignatures) {
				setter(`minSignatures:${target.toLowerCase()}`, `Set minimum validator signatures for ${target}`, "setMinValidatorSignatures", [
					target,
					affiliate.minValidatorSignatures,
				])
			}
		}
		for (const entry of baseline?.affiliates ?? []) {
			if (!desired.affiliates.some(affiliate => affiliate.address.toLowerCase() === entry.address.toLowerCase())) {
				removedAffiliates.push(entry.address)
			}
		}
	}

	if (desired.registerOnCore !== undefined) {
		const coreView = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", desired.core)
		const coreControl = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", desired.core)
		const registered: boolean = await coreView.isExpressProviderRegistered(address)
		if (registered !== desired.registerOnCore) {
			const method = desired.registerOnCore ? "registerExpressProvider" : "unregisterExpressProvider"
			items.push({
				id: `registration:${desired.registerOnCore}`,
				description: `${desired.registerOnCore ? "Register" : "Unregister"} ExpressProvider ${address} on core`,
				to: desired.core,
				data: coreControl.interface.encodeFunctionData(method, [address]),
				method,
				args: [address],
				authority: "providerAdmin",
			})
		}
	}

	return { items, removedAffiliates }
}

/** Reconcile a deployed ExpressProvider to the patch recipe. Never deploys anything. */
async function patchExpressProvider(
	hre: any,
	checkpoint: DeploymentCheckpoint,
	input: ComponentExecutionInput,
	deployer: any,
	priorReport: any,
	safeActionsOnly = false,
): Promise<{
	address: string
	records: VerificationRecord[]
	manualActions: SafeManualAction[]
	checks: ComponentHealthCheck[]
	appliedConfig: ExpressStoredConfig
}> {
	const { ethers } = await getConnection(hre)
	const resolved = await resolveExpressPatchConfig(
		ethers,
		input.componentConfig,
		{ core: input.coreReport.addresses.diamond, admin: input.coreReport.config.admin },
		deployer.address,
	)
	const address = resolved.address
	if ((await ethers.provider.getCode(address)) === "0x") {
		throw new Error(`expressProvider.address has no contract code on this chain: ${address}`)
	}
	const view = await ethers.getContractAt(EXPRESS_FACETS.ViewFacet, address)
	const control = await ethers.getContractAt(EXPRESS_CONTROL_FACET, address)
	const boundCore = ethers.getAddress(await view.symmio())
	if (boundCore !== resolved.core) {
		throw new Error(`DEPENDENCY_UNAVAILABLE: provider ${address} is bound to core ${boundCore}, not the recipe's core ${resolved.core}`)
	}

	// The baseline is the last applied config this recipe recorded for this exact provider,
	// captured by the caller before this run's report write could replace it. Without one,
	// the patch can add and update but has no evidence from which to remove.
	const baseline: ExpressStoredConfig | null =
		priorReport &&
		typeof priorReport.address === "string" &&
		ethers.getAddress(priorReport.address) === address &&
		priorReport.config?.expressProvider
			? (priorReport.config.expressProvider as ExpressStoredConfig)
			: null
	if (!baseline && (resolved.roles !== undefined || resolved.affiliates !== undefined)) {
		logger.warn("No prior applied config found for this provider under this recipe; this patch can add and update but not compute removals.")
	}

	const drift = await computeExpressPatchDrift(ethers, resolved, baseline)
	for (const affiliate of drift.removedAffiliates) {
		logger.warn(
			`Affiliate ${affiliate} was removed from the recipe but its on-chain config is left as-is: ` +
				`clearing its caps would mean "no limit". Pause or reconfigure it explicitly if you intend to retire it.`,
		)
	}

	// Prove every drift item has a real executor before sending anything: the signer directly,
	// or the admin via the Safe actions this run will print.
	const roleHash = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name))
	const coreView = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", resolved.core)
	const owner = ethers.getAddress(await control.owner())
	const ownerIsDeployer = owner === resolved.deployer
	const [deployerIsSetter, adminIsSetter] = await Promise.all([
		view.hasRole(roleHash("SETTER_ROLE"), resolved.deployer),
		view.hasRole(roleHash("SETTER_ROLE"), resolved.admin),
	])
	const needs = new Set(drift.items.map(item => item.authority))
	if (needs.has("owner") && !ownerIsDeployer && owner !== resolved.admin) {
		throw new Error(`AUTHORITY_MISSING: ExpressProvider owner is ${owner}; neither the deployer nor the recipe admin can execute role changes`)
	}
	if (needs.has("setter") && !deployerIsSetter && !adminIsSetter) {
		throw new Error(`AUTHORITY_MISSING: neither deployer ${resolved.deployer} nor admin ${resolved.admin} holds ExpressProvider SETTER_ROLE`)
	}
	if (needs.has("providerAdmin")) {
		const providerAdminRole = roleHash("PROVIDER_ADMIN_ROLE")
		const [deployerCan, adminCan] = await Promise.all([
			coreView.hasRole(resolved.deployer, providerAdminRole),
			coreView.hasRole(resolved.admin, providerAdminRole),
		])
		if (!deployerCan && !adminCan) {
			throw new Error(`AUTHORITY_MISSING: neither deployer ${resolved.deployer} nor admin ${resolved.admin} holds core PROVIDER_ADMIN_ROLE`)
		}
	}

	const canExecute: Record<ExpressPatchItem["authority"], boolean> = {
		setter: !safeActionsOnly && deployerIsSetter,
		owner: !safeActionsOnly && ownerIsDeployer,
		providerAdmin: !safeActionsOnly && (await coreView.hasRole(resolved.deployer, roleHash("PROVIDER_ADMIN_ROLE"))),
	}
	const coreControl = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", resolved.core)
	const manualActions: SafeManualAction[] = []
	for (const item of drift.items) {
		if (canExecute[item.authority]) {
			const contract = item.to === resolved.core ? coreControl : control
			await send((contract.connect(deployer) as any)[item.method](...item.args), item.description)
		} else {
			manualActions.push(safeAction(item.to, item.data, item.description))
		}
	}

	// Recompute from the chain: everything still drifting must be covered by a queued action.
	const remaining = await computeExpressPatchDrift(ethers, resolved, baseline)
	const queued = new Set(manualActions.map(action => `${action.to.toLowerCase()}:${action.data.toLowerCase()}`))
	const remainingIds = new Set(remaining.items.map(item => item.id))
	const checks: ComponentHealthCheck[] = []
	const check = (name: string, pass: boolean, pending = false) =>
		checks.push({ check: name, status: pass ? "passed" : pending ? "pending" : "failed" })
	check("runtime bytecode", true)
	checks.push({ check: "bound to the recipe's core", status: "passed", expected: resolved.core, actual: boundCore })
	if (drift.items.length === 0) check("provider already matches the recipe — nothing to change", true)
	for (const item of drift.items) {
		if (!remainingIds.has(item.id)) check(item.description, true)
		else if (queued.has(`${item.to.toLowerCase()}:${item.data.toLowerCase()}`)) check(item.description, false, true)
		else check(item.description, false)
	}

	// The next patch's baseline: previous applied state overlaid with every declared section.
	const appliedConfig: ExpressStoredConfig = { ...(baseline ?? {}), admin: resolved.admin, deployer: resolved.deployer, core: resolved.core }
	for (const key of [
		"signatureVerifier",
		"muonAppId",
		"muonFreshnessWindow",
		"securityWindow",
		"tolerancePeriod",
		"registerOnCore",
		"roles",
		"affiliates",
	] as const) {
		if (resolved[key] !== undefined) (appliedConfig as any)[key] = resolved[key]
	}

	return { address, records: [], manualActions, checks, appliedConfig }
}

/** Execute one safely resumable product component against a previously proven core. */
export async function executeComponentDeployment(hre: any, input: ComponentExecutionInput) {
	if (input.component !== "partyB" && input.component !== "symbolManager" && input.component !== "expressProvider") {
		throw new Error(`LIVE_TARGET_UNSUPPORTED: component ${input.component} has no complete safe deployment workflow`)
	}
	const isPatch = input.component === "expressProvider" && input.componentConfig.mode === "reuse"
	if (input.componentConfig.mode !== "deploy" && !isPatch) {
		throw new Error(`LIVE_TARGET_UNSUPPORTED: deploy:component requires ${input.component}.mode=deploy; received ${input.componentConfig.mode}`)
	}

	const connection = await getConnection(hre)
	const { ethers } = connection
	const safeActionsOnlyValue = process.env.SYMMIO_SAFE_ACTIONS_ONLY
	if (safeActionsOnlyValue !== undefined && safeActionsOnlyValue !== "true" && safeActionsOnlyValue !== "false") {
		throw new Error(`SYMMIO_SAFE_ACTIONS_ONLY must be exactly true or false; received ${JSON.stringify(safeActionsOnlyValue)}`)
	}
	const safeActionsOnly = safeActionsOnlyValue === "true"
	if (safeActionsOnly && !isPatch) {
		throw new Error("Safe transaction intent mode cannot deploy contracts; use a keystore, private-key, Ledger, or local-node signer")
	}
	const [configuredSigner] = await ethers.getSigners()
	let deployer: any = configuredSigner
	if (safeActionsOnly) {
		const safeAddress = process.env.SYMMIO_SAFE_ADDRESS
		if (!safeAddress || !ethers.isAddress(safeAddress) || /^0x0{40}$/i.test(safeAddress)) {
			throw new Error("Safe action-only patching requires a non-zero SYMMIO_SAFE_ADDRESS")
		}
		deployer = { address: ethers.getAddress(safeAddress) }
	}
	if (!deployer) throw new Error("No deployment signer is configured for deploy:component")
	const chainId = Number((await ethers.provider.getNetwork()).chainId)
	const network = connection.networkName || "unknown"
	const simulated = connection.networkConfig?.type === "edr-simulated"
	assertRecipeNetworkTarget(input.target, { network, chainId, simulated })
	if (!safeActionsOnly) {
		assertMainnetDeploymentIdentitySafe(chainId, deployer.address, input.componentConfig.admin || input.coreReport.config.admin, simulated)
	}
	await assertDependencyAddressesHaveCode(input.coreReport, address => ethers.provider.getCode(address))
	// Validate component-local inputs and every external authority before checkpoint
	// mutation or contract creation. Later helpers normalize the same values again.
	await requireAddress(ethers, input.componentConfig.admin || input.coreReport.config.admin, `${input.component}.admin`)
	if (input.component === "partyB") await requireAddress(ethers, input.componentConfig.signer, "partyB.signer")
	if (input.component === "symbolManager") await requireAddress(ethers, input.componentConfig.operator, "symbolManager.operator")
	if (input.component === "partyB" && typeof input.componentConfig.adlEnabled !== "boolean") {
		throw new Error(`partyB.adlEnabled must be a boolean; received ${JSON.stringify(input.componentConfig.adlEnabled)}`)
	}
	await assertComponentDeploymentAuthority(ethers, input.component, input.coreReport, deployer.address, input.componentConfig)
	const componentAdmin = ethers.getAddress(input.componentConfig.admin || input.coreReport.config.admin)
	if (safeActionsOnly && componentAdmin !== deployer.address) {
		throw new Error(`Selected Safe ${deployer.address} does not match the patch admin ${componentAdmin}`)
	}
	let publicConfig: ComponentDeploymentReport["config"]
	if (input.component === "partyB") {
		publicConfig = {
			admin: componentAdmin,
			signer: ethers.getAddress(input.componentConfig.signer),
			adlEnabled: input.componentConfig.adlEnabled as boolean,
		}
	} else if (input.component === "symbolManager") {
		publicConfig = { admin: componentAdmin, operator: ethers.getAddress(input.componentConfig.operator) }
	} else if (isPatch) {
		const resolved = await resolveExpressPatchConfig(
			ethers,
			input.componentConfig,
			{ core: input.coreReport.addresses.diamond, admin: input.coreReport.config.admin },
			deployer.address,
		)
		publicConfig = { admin: componentAdmin, expressProvider: resolved }
	} else {
		const resolved = await resolveExpressProviderConfig(
			ethers,
			input.componentConfig,
			{ core: input.coreReport.addresses.diamond, admin: input.coreReport.config.admin },
			deployer.address,
		)
		publicConfig = { admin: componentAdmin, expressProvider: resolved }
	}

	const live = input.target.mode === "live"
	if (live && !input.verify && !isPatch) {
		throw new Error("Explorer verification is mandatory for live component deployments; --verify=false is refused")
	}
	setDataScope(chainId, { simulated })
	setCheckpointSimulated(simulated)
	const scope = componentCheckpointScope(input.recipeName, input.component)
	// Capture the last applied config BEFORE this run writes anything: a patch computes its
	// removals against it, and the initial report write below would otherwise destroy it.
	const priorComponentReport = isPatch ? readDataIfExists(componentReportRelativePath(input.recipeName, input.component)) : null
	const existingCheckpoint = loadCheckpoint(chainId, scope)
	if (input.fresh && existingCheckpoint) {
		clearCheckpoint(chainId, network, existingCheckpoint.step === "complete" ? "completed" : "abandoned", scope)
	}
	let checkpoint = input.fresh ? null : existingCheckpoint
	let isResume = checkpoint !== null
	checkpoint ||= createCheckpoint(network, chainId, scope)
	const manifestIntent = {
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
	}
	let manifest = createDeploymentManifest(manifestIntent, { deploymentId: checkpoint.deploymentId || checkpoint.manifest?.deploymentId })
	if (isResume) {
		try {
			assertCheckpointManifest(checkpoint, manifest)
		} catch (error) {
			// A COMPLETED attempt is durable history, not a lock: new intent — a patch after a
			// deploy, or a second patch with different settings — starts its own attempt and
			// archives the finished checkpoint, exactly as --fresh would. An unfinished attempt
			// still binds; finish or explicitly abandon it first.
			if (checkpoint.step !== "complete") throw error
			clearCheckpoint(chainId, network, "completed", scope)
			checkpoint = createCheckpoint(network, chainId, scope)
			isResume = false
			manifest = createDeploymentManifest(manifestIntent, {})
		}
	}
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
		mode: isPatch ? "patch" : "deploy",
		lifecycle: "validating",
		config: publicConfig,
		coreDependency: {
			reportPath: input.coreReportPath,
			deploymentId: input.coreReport.deploymentId,
			diamond: input.coreReport.addresses.diamond,
			instantLayer: input.coreReport.addresses.instantLayer,
		},
		// A patch creates no contracts, so there is nothing for an explorer to verify.
		verification: {
			policy: live && !isPatch ? "required" : "not_applicable",
			status: live && !isPatch ? "pending" : "skipped",
			records: [],
		},
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
				: input.component === "symbolManager"
					? await executeSymbolManager(hre, checkpoint, input, deployer)
					: isPatch
						? await patchExpressProvider(hre, checkpoint, input, deployer, priorComponentReport, safeActionsOnly)
						: await executeExpressProvider(hre, checkpoint, input, deployer)
		report.address = result.address
		report.implementation = (result as { implementation?: string }).implementation
		report.constructorArguments = result.records[result.records.length - 1]?.constructorArguments
		// A patch stores baseline-plus-declared-sections so the NEXT patch can compute removals.
		const appliedConfig = (result as { appliedConfig?: ExpressStoredConfig }).appliedConfig
		if (appliedConfig) report.config.expressProvider = appliedConfig
		report.manualActions = result.manualActions
		report.health.checks = result.checks
		report.health.status = summarizeComponentHealth(result.checks)
		const failedChecks = result.checks.filter(check => check.status === "failed")
		if (failedChecks.length > 0) throw new Error(`Component post-state health failed: ${failedChecks.map(check => check.check).join(", ")}`)
		report.verification.records = result.records
		if (live && !isPatch) {
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
