import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import fs from "node:fs"
import path from "node:path"

import { createDeploymentPlan } from "../../deployment/recipe.js"
import { getDataDir } from "../utils/fs.js"
import { getCheckpointPath, setCheckpointSimulated, type DeploymentCheckpoint } from "./checkpoint.js"
import {
	inspectPartyBPostState,
	computeExpressPatchDrift,
	inspectExpressProviderPostState,
	inspectGaslessLayerPostState,
	inspectSymbolManagerPostState,
	summarizeComponentHealth,
	type ComponentDeploymentReport,
	type ComponentPostStateInspection,
} from "./componentDeployment.js"
import {
	assertRecipeNetworkTarget,
	componentCheckpointScope,
	componentReportRelativePath,
	loadCoreDependencyReport,
	type CoreDependencyReport,
	type DeploymentComponentName,
} from "./deploymentRecipe.js"
import { getConnection } from "./helpers.js"
import { requireActiveDeploymentRecipe } from "./recipeRuntime.js"

type SupportedComponent = "partyB" | "symbolManager" | "expressProvider" | "gaslessLayer"

export interface ComponentStatusBinding {
	component: SupportedComponent
	recipeName: string
	recipePath: string
	recipeDigest: string
	network: string
	chainId: number
	live: boolean
	config: { admin: string; signer?: string; adlEnabled?: boolean; operator?: string }
	coreReport: CoreDependencyReport
	coreReportPath: string
}

function isRecord(value: unknown): value is Record<string, any> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function address(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
		throw new Error(`${label} must be a valid non-zero address; received ${JSON.stringify(value)}`)
	}
	return value.toLowerCase()
}

function sameAddress(actual: unknown, expected: unknown): boolean {
	try {
		return address(actual, "actual address") === address(expected, "expected address")
	} catch {
		return false
	}
}

function samePath(actual: unknown, expected: string): boolean {
	return typeof actual === "string" && actual.trim() !== "" && path.resolve(actual) === path.resolve(expected)
}

function validateManualActions(value: unknown): asserts value is ComponentDeploymentReport["manualActions"] {
	if (!Array.isArray(value)) throw new Error("component report manualActions must be an array")
	for (const [index, action] of value.entries()) {
		if (!isRecord(action)) throw new Error(`component report manualActions[${index}] must be an object`)
		address(action.to, `component report manualActions[${index}].to`)
		if (action.value !== "0") throw new Error(`component report manualActions[${index}].value must be "0"`)
		if (typeof action.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(action.data)) {
			throw new Error(`component report manualActions[${index}].data must be hexadecimal calldata`)
		}
		if (typeof action.description !== "string" || action.description.trim() === "") {
			throw new Error(`component report manualActions[${index}].description must be non-empty`)
		}
	}
}

export function assertReadOnlySignerConfiguration(mode: "local" | "fork" | "live", configuredSignerCount: number): void {
	if (mode !== "local" && configuredSignerCount !== 0) {
		throw new Error(`READ_ONLY_CONFIGURATION_ERROR: check:component expected zero configured signers, found ${configuredSignerCount}`)
	}
}

/** Independently bind the on-disk report to the active recipe and pinned Core report. */
export function assertComponentStatusReportBinding(reportValue: unknown, expected: ComponentStatusBinding): ComponentDeploymentReport {
	if (!isRecord(reportValue)) throw new Error("component report must be an object")
	const report = reportValue as ComponentDeploymentReport
	if (report.schemaVersion !== 1) throw new Error(`component report schemaVersion must be 1, got ${JSON.stringify(report.schemaVersion)}`)
	if (report.component !== expected.component) {
		throw new Error(`component report is for ${JSON.stringify(report.component)}, expected ${expected.component}`)
	}
	if (report.network !== expected.network) {
		throw new Error(`component report network is ${JSON.stringify(report.network)}, expected ${expected.network}`)
	}
	if (report.chainId !== expected.chainId) {
		throw new Error(`component report chainId is ${JSON.stringify(report.chainId)}, expected ${expected.chainId}`)
	}
	const validModes = expected.component === "expressProvider" ? ["deploy", "patch"] : ["deploy"]
	if (!validModes.includes(report.mode)) {
		throw new Error(`component report mode must be one of ${validModes.join(", ")}, got ${JSON.stringify(report.mode)}`)
	}
	if (report.lifecycle !== "pending_handover" && report.lifecycle !== "complete") {
		throw new Error(`component report lifecycle is not statusable: ${JSON.stringify(report.lifecycle)}`)
	}
	if (typeof report.deploymentId !== "string" || report.deploymentId.trim() === "") throw new Error("component report is missing deploymentId")
	if (!isRecord(report.recipe)) throw new Error("component report is missing its recipe binding")
	if (report.recipe.name !== expected.recipeName) {
		throw new Error(`component report recipe name is ${JSON.stringify(report.recipe.name)}, expected ${expected.recipeName}`)
	}
	if (report.recipe.digest !== expected.recipeDigest) throw new Error("component report recipe digest does not match the active recipe")
	if (!samePath(report.recipe.path, expected.recipePath)) throw new Error("component report recipe path does not match the active recipe")
	address(report.address, "component report address")
	if (expected.component === "partyB" || expected.component === "gaslessLayer") {
		address(report.implementation, `${expected.component} component report implementation`)
	}

	if (!isRecord(report.config)) throw new Error("component report is missing public config evidence")
	if (!sameAddress(report.config.admin, expected.config.admin)) throw new Error("component report admin does not match recipe governance.admin")
	if (expected.component === "partyB") {
		if (!sameAddress(report.config.signer, expected.config.signer)) throw new Error("component report signer does not match recipe partyB.signer")
		if (report.config.adlEnabled !== expected.config.adlEnabled)
			throw new Error("component report ADL setting does not match recipe partyB.adlEnabled")
	} else if (expected.component === "symbolManager" && !sameAddress(report.config.operator, expected.config.operator)) {
		throw new Error("component report operator does not match recipe symbolManager.operator")
	} else if (expected.component === "expressProvider" && !isRecord(report.config.expressProvider)) {
		throw new Error("ExpressProvider component report is missing its resolved configuration")
	} else if (expected.component === "gaslessLayer" && !isRecord(report.config.gaslessLayer)) {
		throw new Error("GaslessLayer component report is missing its resolved configuration")
	}

	if (!isRecord(report.coreDependency)) throw new Error("component report is missing its reused-Core binding")
	if (!samePath(report.coreDependency.reportPath, expected.coreReportPath)) {
		throw new Error("component report Core dependency path does not match the recipe's pinned core.fromReport")
	}
	if (report.coreDependency.deploymentId !== expected.coreReport.deploymentId) {
		throw new Error("component report Core deploymentId does not match the pinned Core report")
	}
	if (!sameAddress(report.coreDependency.diamond, expected.coreReport.addresses.diamond)) {
		throw new Error("component report Core Diamond does not match the pinned Core report")
	}
	if (!sameAddress(report.coreDependency.instantLayer, expected.coreReport.addresses.instantLayer)) {
		throw new Error("component report InstantLayer does not match the pinned Core report")
	}
	if (expected.component === "gaslessLayer" && !sameAddress(report.coreDependency.accountLayer, expected.coreReport.addresses.accountLayerDiamond)) {
		throw new Error("component report AccountLayer does not match the pinned Core report")
	}

	if (!isRecord(report.verification) || !Array.isArray(report.verification.records)) {
		throw new Error("component report is missing verification records")
	}
	const verified = new Set(
		report.verification.records.map((record, index) => {
			if (!isRecord(record)) throw new Error(`component verification record ${index} must be an object`)
			if (typeof record.name !== "string" || record.name.trim() === "") {
				throw new Error(`component verification record ${index} must have a non-empty name`)
			}
			if (!Array.isArray(record.constructorArguments)) {
				throw new Error(`component verification record ${index} constructorArguments must be an array`)
			}
			return address(record.address, `component verification record ${index} address`)
		}),
	)
	if (report.mode === "patch") {
		if (report.verification.records.length !== 0) throw new Error("ExpressProvider patch verification records must be empty")
		if (report.verification.policy !== "not_applicable" || report.verification.status !== "skipped") {
			throw new Error("ExpressProvider patch verification must be not_applicable/skipped")
		}
	} else if (expected.live) {
		if (!verified.has(address(report.address, "component report address"))) throw new Error("verification records do not cover the component address")
		if (
			(expected.component === "partyB" || expected.component === "gaslessLayer") &&
			!verified.has(address(report.implementation, `${expected.component} implementation`))
		) {
			throw new Error(`verification records do not cover the ${expected.component} implementation`)
		}
		if (report.verification.policy !== "required" || report.verification.status !== "passed") {
			throw new Error(`live component verification is incomplete: ${report.verification.policy}/${report.verification.status}`)
		}
	} else {
		if (!verified.has(address(report.address, "component report address"))) throw new Error("verification records do not cover the component address")
		if (
			(expected.component === "partyB" || expected.component === "gaslessLayer") &&
			!verified.has(address(report.implementation, `${expected.component} implementation`))
		) {
			throw new Error(`verification records do not cover the ${expected.component} implementation`)
		}
		if (report.verification.policy !== "not_applicable" || report.verification.status !== "skipped") {
			throw new Error(`non-live component verification must be not_applicable/skipped`)
		}
	}

	if (!isRecord(report.health) || !Array.isArray(report.health.checks) || report.health.checks.length === 0) {
		throw new Error("component report is missing recorded post-state health evidence")
	}
	for (const [index, check] of report.health.checks.entries()) {
		if (!isRecord(check)) throw new Error(`component health check ${index} must be an object`)
		if (typeof check.check !== "string" || check.check.trim() === "") {
			throw new Error(`component health check ${index} must have a non-empty name`)
		}
		if (check.status !== "passed" && check.status !== "pending") {
			throw new Error(`component health check ${index} has invalid status ${JSON.stringify(check.status)}`)
		}
	}
	if (report.health.status !== "passed" && report.health.status !== "pending") {
		throw new Error(`component report health is not successful: ${JSON.stringify(report.health.status)}`)
	}
	const recordedHealth = summarizeComponentHealth(report.health.checks)
	if (recordedHealth !== report.health.status) {
		throw new Error(`component report health summary ${JSON.stringify(report.health.status)} does not match its recorded checks (${recordedHealth})`)
	}
	validateManualActions(report.manualActions)
	if (report.lifecycle === "complete" && (report.health.status !== "passed" || report.manualActions.length !== 0)) {
		throw new Error("complete component report must have passed health and no manual actions")
	}
	if (report.lifecycle === "pending_handover" && report.health.status === "passed" && report.manualActions.length === 0) {
		throw new Error("pending component report contains no pending health check or manual action")
	}
	return report
}

/** Bind the exact scoped checkpoint without invoking the recovery loader (which can write a corruption backup). */
export function assertComponentStatusCheckpointBinding(
	checkpointValue: unknown,
	report: ComponentDeploymentReport,
	expected: { component: SupportedComponent; scope: string; network: string; chainId: number },
): DeploymentCheckpoint {
	if (!isRecord(checkpointValue)) throw new Error("component checkpoint must be an object")
	const checkpoint = checkpointValue as DeploymentCheckpoint
	if (checkpoint.scope !== expected.scope) {
		throw new Error(`component checkpoint scope is ${JSON.stringify(checkpoint.scope)}, expected ${expected.scope}`)
	}
	if (checkpoint.network !== expected.network) {
		throw new Error(`component checkpoint network is ${JSON.stringify(checkpoint.network)}, expected ${expected.network}`)
	}
	if (checkpoint.chainId !== expected.chainId) {
		throw new Error(`component checkpoint chainId is ${JSON.stringify(checkpoint.chainId)}, expected ${expected.chainId}`)
	}
	if (checkpoint.deploymentId !== report.deploymentId) throw new Error("component checkpoint and report deploymentIds do not match; report is stale")
	if (!checkpoint.manifest || checkpoint.manifest.deploymentId !== report.deploymentId) {
		throw new Error("component checkpoint manifest does not match the report deploymentId")
	}
	if (expected.component === "partyB") {
		const deployed = checkpoint.contracts?.symmioPartyB
		if (!sameAddress(deployed?.address, report.address)) throw new Error("PartyB checkpoint address does not match the report")
		if (!sameAddress(deployed?.implementation, report.implementation)) throw new Error("PartyB checkpoint implementation does not match the report")
	} else if (expected.component === "symbolManager" && !sameAddress(checkpoint.contracts?.symbolManager?.address, report.address)) {
		throw new Error("SymbolManager checkpoint address does not match the report")
	} else if (
		expected.component === "expressProvider" &&
		report.mode === "deploy" &&
		!sameAddress(checkpoint.contracts?.expressProvider?.diamond?.address, report.address)
	) {
		throw new Error("ExpressProvider checkpoint address does not match the report")
	} else if (expected.component === "expressProvider" && report.mode === "patch" && checkpoint.contracts?.expressProvider !== undefined) {
		throw new Error("ExpressProvider patch checkpoint unexpectedly contains a deployment")
	} else if (expected.component === "gaslessLayer") {
		if (!sameAddress(checkpoint.contracts?.gaslessLayer?.proxy?.address, report.address)) {
			throw new Error("GaslessLayer checkpoint address does not match the report")
		}
		if (!sameAddress(checkpoint.contracts?.gaslessLayer?.implementation?.address, report.implementation)) {
			throw new Error("GaslessLayer checkpoint implementation does not match the report")
		}
	}
	if (checkpoint.step !== report.lifecycle) {
		throw new Error(
			`component checkpoint lifecycle ${JSON.stringify(checkpoint.step)} does not match report lifecycle ${JSON.stringify(report.lifecycle)}`,
		)
	}
	return checkpoint
}

function normalizedAction(action: ComponentDeploymentReport["manualActions"][number]): string {
	return JSON.stringify({
		to: action.to.toLowerCase(),
		value: action.value,
		data: action.data.toLowerCase(),
		description: action.description,
	})
}

export function assertCurrentManualActions(
	recorded: ComponentDeploymentReport["manualActions"],
	current: ComponentDeploymentReport["manualActions"],
): void {
	if (recorded.length !== current.length || recorded.some((action, index) => normalizedAction(action) !== normalizedAction(current[index]))) {
		throw new Error("component report Safe actions no longer match current on-chain state; rerun the identical component deployment to refresh it")
	}
}

/** Re-probe all critical component state. This function never requests a signer or sends a transaction. */
export async function inspectComponentStatus(
	ethers: any,
	component: SupportedComponent,
	report: ComponentDeploymentReport,
	coreReport: CoreDependencyReport,
): Promise<ComponentPostStateInspection> {
	if (component === "partyB") {
		return inspectPartyBPostState(ethers, {
			address: report.address!,
			implementation: report.implementation!,
			admin: report.config.admin,
			signer: report.config.signer!,
			adlEnabled: report.config.adlEnabled!,
			core: coreReport.addresses.diamond,
			instantLayer: coreReport.addresses.instantLayer,
		})
	}
	if (component === "symbolManager") {
		return inspectSymbolManagerPostState(ethers, {
			address: report.address!,
			admin: report.config.admin,
			operator: report.config.operator!,
			core: coreReport.addresses.diamond,
		})
	}
	if (component === "gaslessLayer") {
		const config = report.config.gaslessLayer
		if (!config) throw new Error("GaslessLayer report is missing its resolved config; cannot re-prove the deployed state")
		return inspectGaslessLayerPostState(ethers, { ...config, address: report.address!, implementation: report.implementation! })
	}
	const expressConfig = report.config.expressProvider
	if (!expressConfig) throw new Error("ExpressProvider report is missing its resolved config; cannot re-prove the deployed state")

	// A patch report may carry only the sections its recipe declared, so status re-runs the
	// same read-only drift the patch gated on: zero remaining drift means the applied intent
	// still holds; anything left must match a recorded Safe action, i.e. pending, not failed.
	if (report.mode === "patch") {
		const desired = { ...expressConfig, address: report.address! }
		const drift = await computeExpressPatchDrift(ethers, desired, expressConfig)
		const queued = new Set((report.manualActions || []).map(action => `${action.to.toLowerCase()}:${action.data.toLowerCase()}`))
		const checks: ComponentPostStateInspection["checks"] = [
			{ check: "applied settings still hold", status: drift.items.length === 0 ? "passed" : "pending" },
		]
		const manualActions: ComponentPostStateInspection["manualActions"] = []
		for (const item of drift.items) {
			const covered = queued.has(`${item.to.toLowerCase()}:${item.data.toLowerCase()}`)
			checks.push({ check: item.description, status: covered ? "pending" : "failed" })
			if (covered) manualActions.push({ to: item.to, value: "0", data: item.data, description: item.description })
		}
		return { checks, manualActions }
	}

	const full = expressConfig as Omit<import("./componentDeployment.js").ExpressProviderResolvedConfig, "address">
	// The credit-line trio is absent whenever the recipe deferred that section, so it is not
	// required here; AccountLayer, roles, and affiliates are always recorded.
	for (const key of ["accountLayer", "roles", "affiliates"] as const) {
		if (full[key] === undefined) throw new Error(`ExpressProvider deploy report config is missing ${key}; cannot re-prove the deployed state`)
	}
	return inspectExpressProviderPostState(ethers, { ...full, address: report.address! })
}

function readJsonExact(filePath: string, label: string): unknown {
	let contents: string
	try {
		contents = fs.readFileSync(filePath, "utf8")
	} catch (error) {
		throw new Error(`${label} is unavailable at ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
	}
	try {
		return JSON.parse(contents)
	} catch (error) {
		throw new Error(`${label} is unreadable at ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function displayInspection(
	report: ComponentDeploymentReport,
	reportPath: string,
	checkpointPath: string,
	inspection: ComponentPostStateInspection,
): void {
	console.log("")
	console.log(`Component: ${report.component}`)
	console.log(`Address: ${report.address}`)
	if (report.implementation) console.log(`Implementation: ${report.implementation}`)
	console.log(`Report: ${reportPath}`)
	console.log(`Checkpoint: ${checkpointPath}`)
	console.log("")
	for (const check of inspection.checks) {
		const marker = check.status === "passed" ? "PASS" : check.status === "pending" ? "PENDING" : "FAIL"
		const detail = check.actual === undefined ? "" : ` (expected ${check.expected}, actual ${check.actual})`
		console.log(`[${marker}] ${check.check}${detail}`)
	}
}

async function checkComponent(hre: any, recipePath: string, rawComponent: string): Promise<void> {
	if (rawComponent !== "partyB" && rawComponent !== "symbolManager" && rawComponent !== "expressProvider" && rawComponent !== "gaslessLayer") {
		throw new Error(`check:component supports only partyB, symbolManager, expressProvider, or gaslessLayer; received ${JSON.stringify(rawComponent)}`)
	}
	const component: SupportedComponent = rawComponent
	const active = requireActiveDeploymentRecipe(recipePath)
	createDeploymentPlan(active.recipe, { only: component })
	const dependencyBinding = active.dependencies.coreReport
	if (!dependencyBinding || active.recipe.core.mode !== "reuse" || !active.recipe.core.fromReport) {
		throw new Error(`DEPENDENCY_UNAVAILABLE: component status requires core.mode=reuse and a pinned core.fromReport`)
	}
	const connection = await getConnection(hre)
	const { ethers } = connection
	const configuredSigners = await ethers.getSigners()
	assertReadOnlySignerConfiguration(active.recipe.network.mode, configuredSigners.length)
	const network = connection.networkName || "unknown"
	const chainId = Number((await ethers.provider.getNetwork()).chainId)
	const simulated = connection.networkConfig?.type === "edr-simulated"
	assertRecipeNetworkTarget(active.recipe.network, { network, chainId, simulated })
	const coreReport = loadCoreDependencyReport(dependencyBinding.identityPath, {
		network: active.recipe.network.name,
		chainId: active.recipe.network.chainId,
		live: active.recipe.network.mode === "live",
		digest: dependencyBinding.digest,
	})
	if (!sameAddress(coreReport.config.admin, active.recipe.governance.admin)) {
		throw new Error("DEPENDENCY_UNAVAILABLE: recipe governance.admin does not match the pinned Core report admin")
	}

	const reportPath = path.resolve(getDataDir(), componentReportRelativePath(active.recipe.name, component))
	const expectedConfig =
		component === "partyB"
			? {
					admin: active.recipe.governance.admin,
					signer: active.recipe.partyB.signer,
					adlEnabled: active.recipe.partyB.adlEnabled,
				}
			: component === "symbolManager"
				? { admin: active.recipe.governance.admin, operator: active.recipe.symbolManager.operator }
				: {
						admin: (active.recipe[component] as { admin?: string }).admin || active.recipe.governance.admin,
					}
	const report = assertComponentStatusReportBinding(readJsonExact(reportPath, "component report"), {
		component,
		recipeName: active.recipe.name,
		recipePath: active.identityPath,
		recipeDigest: active.digest,
		network,
		chainId,
		live: active.recipe.network.mode === "live",
		config: expectedConfig,
		coreReport,
		coreReportPath: dependencyBinding.identityPath,
	})

	const scope = componentCheckpointScope(active.recipe.name, component as DeploymentComponentName)
	setCheckpointSimulated(simulated)
	const checkpointPath = path.resolve(getCheckpointPath(chainId, scope))
	const checkpoint = assertComponentStatusCheckpointBinding(readJsonExact(checkpointPath, "component checkpoint"), report, {
		component,
		scope,
		network,
		chainId,
	})
	const inspection = await inspectComponentStatus(ethers, component, report, coreReport)
	displayInspection(report, reportPath, checkpointPath, inspection)
	assertCurrentManualActions(report.manualActions, inspection.manualActions)
	const currentHealth = summarizeComponentHealth(inspection.checks)
	if (currentHealth !== "passed" || report.lifecycle !== "complete" || checkpoint.step !== "complete") {
		const incomplete = inspection.checks.filter(check => check.status !== "passed").map(check => check.check)
		throw new Error(
			`Component status is incomplete: lifecycle=${report.lifecycle}, health=${currentHealth}` +
				`${incomplete.length ? `, checks=${incomplete.join(", ")}` : ""}. ` +
				`After Safe actions confirm, launch ./symmio and continue the active ${component} task bound to ${active.identityPath}.`,
		)
	}
	console.log("")
	console.log(`Canonical ${component} component health check passed.`)
}

export const checkComponentTask = task("check:component", "Read-only canonical health check for one recipe-deployed component")
	.addOption({
		name: "recipe",
		description: "Path to the active component deployment recipe",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "component",
		description: "Component to inspect: partyB, symbolManager, expressProvider or gaslessLayer",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.setAction(async () => ({
		default: async ({ recipe, component }, hre) => {
			if (!recipe) throw new Error("Missing required option --recipe")
			if (!component) throw new Error("Missing required option --component")
			await checkComponent(hre, recipe, component)
		},
	}))
	.build()
