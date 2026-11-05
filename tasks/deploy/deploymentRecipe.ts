import type { CoreDependencyReport } from "../../deployment-tooling/recipe.js"
import { normalizeCheckpointScope } from "./checkpoint.js"

export { loadCoreDependencyReport, parseCoreDependencyReport, type CoreDependencyReport } from "../../deployment-tooling/recipe.js"
export type { GovernanceAction, SafeManualAction } from "./governanceActions.js"

export type DeploymentTargetMode = "live" | "fork" | "local"
export type DeploymentComponentName = "partyB" | "symbolManager" | "expressProvider" | "gaslessLayer"

export interface RecipeNetworkTarget {
	name: string
	chainId: number
	mode: DeploymentTargetMode
}

function dependencyError(message: string): never {
	throw new Error(`DEPENDENCY_UNAVAILABLE: ${message}`)
}

/** Fail before any checkpoint mutation or transaction when the recipe targets another connection. */
export function assertRecipeNetworkTarget(target: RecipeNetworkTarget, actual: { network: string; chainId: number; simulated: boolean }): void {
	if (target.name !== actual.network) {
		throw new Error(`RECIPE_NETWORK_MISMATCH: recipe selects ${target.name}, but Hardhat connected to ${actual.network}`)
	}
	if (target.chainId !== actual.chainId) {
		throw new Error(`RECIPE_NETWORK_MISMATCH: recipe chainId is ${target.chainId}, but the connected RPC reports ${actual.chainId}`)
	}
	if (target.mode === "fork" && !actual.simulated) {
		throw new Error(`RECIPE_NETWORK_MISMATCH: recipe mode is fork, but ${actual.network} is not an EDR-simulated network`)
	}
	if (target.mode === "live" && actual.simulated) {
		throw new Error(`RECIPE_NETWORK_MISMATCH: recipe mode is live, but ${actual.network} is an EDR-simulated network`)
	}
	if (target.mode === "local" && actual.chainId !== 31337) {
		throw new Error(`RECIPE_NETWORK_MISMATCH: recipe mode is local, but the connected chainId is ${actual.chainId}, not 31337`)
	}
}

export function componentCheckpointScope(recipeName: string, component: DeploymentComponentName): string {
	const scope = `component-${recipeName}-${component}`
	return normalizeCheckpointScope(scope)!
}

export function componentReportRelativePath(recipeName: string, component: DeploymentComponentName): string {
	normalizeCheckpointScope(recipeName)
	return `components/${recipeName}/${component}-report.json`
}

export async function assertDependencyAddressesHaveCode(report: CoreDependencyReport, getCode: (address: string) => Promise<string>): Promise<void> {
	for (const [label, address] of [
		["core Diamond", report.addresses.diamond],
		["InstantLayer", report.addresses.instantLayer],
	] as const) {
		let code: string
		try {
			code = await getCode(address)
		} catch (error) {
			dependencyError(`failed to read ${label} ${address}: ${error instanceof Error ? error.message : String(error)}`)
		}
		if (!code || code === "0x") dependencyError(`${label} ${address} has no code on the connected chain`)
	}
}

export async function assertGaslessLayerDependenciesHaveCode(
	report: CoreDependencyReport,
	getCode: (address: string) => Promise<string>,
): Promise<void> {
	const accountLayer = report.addresses.accountLayerDiamond
	if (!accountLayer) dependencyError("core deployment report does not include addresses.accountLayerDiamond required by GaslessLayer")
	let code: string
	try {
		code = await getCode(accountLayer)
	} catch (error) {
		dependencyError(`failed to read AccountLayer ${accountLayer}: ${error instanceof Error ? error.message : String(error)}`)
	}
	if (!code || code === "0x") dependencyError(`AccountLayer ${accountLayer} has no code on the connected chain`)
}

/**
 * A patch run reconciles a deployed provider to the recipe's declared sections. Refuse one
 * that declares nothing: an empty patch is always a mistake, not a no-op the operator wanted.
 */
export function assertExpressProviderPatchable(config: Record<string, any>): void {
	if (config.mode !== "reuse") {
		throw new Error(`LIVE_TARGET_UNSUPPORTED: an ExpressProvider patch requires mode=reuse; received ${config.mode}`)
	}
	if (typeof config.address !== "string" || config.address.length === 0) {
		throw new Error("expressProvider.address is required to patch: it names the deployed provider to reconcile")
	}
	const sections = ["registerOnCore", "securityWindow", "tolerancePeriod", "creditLine", "roles", "affiliates"]
	if (!sections.some(section => config[section] !== undefined)) {
		throw new Error(`expressProvider patch declares no changes; declare at least one of: ${sections.join(", ")}`)
	}
}

/**
 * ExpressProvider advances real collateral out of core against a credit line, but a freshly cut
 * diamond can do none of that on its own. Each setup section may therefore be deferred to a later
 * reuse patch; an omitted section is simply not configured. The one thing that makes the provider
 * live is a SIGNER_ROLE holder, because SymmioHookFacet accepts a credit offer from nobody else.
 * Declaring a signer is what makes the rest of the operating surface mandatory: without it the
 * provider cannot be operated (no operator can process what it accepts), supervised (an affiliate
 * with no config is uncapped rather than blocked), or funded (advanceWithdraw reverts at core
 * unless the provider is registered there).
 */
export function assertExpressProviderDeployable(config: Record<string, any>, target: RecipeNetworkTarget): void {
	if (config.mode !== "deploy") {
		throw new Error(`LIVE_TARGET_UNSUPPORTED: expressProvider.mode must be deploy; received ${config.mode}`)
	}
	// A declared section must still be usable; only an omitted one means "not configured yet".
	const operators: unknown = config.roles?.OPERATOR_ROLE
	const affiliates: unknown = config.affiliates
	if (affiliates !== undefined && (!Array.isArray(affiliates) || affiliates.length === 0)) {
		throw new Error("expressProvider.affiliates must configure at least one affiliate when declared; omit it entirely to defer affiliate policy")
	}
	if (operators !== undefined && (!Array.isArray(operators) || operators.length === 0)) {
		throw new Error("expressProvider.roles.OPERATOR_ROLE must name at least one operator, or accepted withdrawals can never be processed")
	}
	if (config.creditLine !== undefined && !config.creditLine.signatureVerifier) {
		throw new Error("expressProvider.creditLine.signatureVerifier is required; reserveDebt reverts with CreditLineNotConfigured until it is set")
	}

	const live = (config.roles?.SIGNER_ROLE?.length ?? 0) > 0
	if (!live) return

	if (operators === undefined) {
		throw new Error("expressProvider.roles.OPERATOR_ROLE must name at least one operator, or accepted withdrawals can never be processed")
	}
	if (config.creditLine?.signatureVerifier === undefined) {
		throw new Error("expressProvider.creditLine.signatureVerifier is required; reserveDebt reverts with CreditLineNotConfigured until it is set")
	}
	if (affiliates === undefined) {
		throw new Error(
			"expressProvider.affiliates is required once roles.SIGNER_ROLE names a signer: an affiliate with no config has an uncapped credit line",
		)
	}
	if (target.mode === "live" && config.registerOnCore !== true) {
		throw new Error(
			"expressProvider.registerOnCore must be true on a live target; an unregistered provider cannot call advanceWithdraw and the deployment would be inert",
		)
	}
}
