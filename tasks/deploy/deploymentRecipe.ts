import type { CoreDependencyReport } from "../../deployment/recipe.js"
import { normalizeCheckpointScope } from "./checkpoint.js"

export { loadCoreDependencyReport, parseCoreDependencyReport, type CoreDependencyReport } from "../../deployment/recipe.js"

export type DeploymentTargetMode = "live" | "fork" | "local"
export type DeploymentComponentName = "partyB" | "symbolManager" | "expressProvider"

export interface RecipeNetworkTarget {
	name: string
	chainId: number
	mode: DeploymentTargetMode
}

export interface SafeManualAction {
	to: string
	value: "0"
	data: string
	description: string
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

export function assertExpressProviderSupported(target: RecipeNetworkTarget): never {
	const detail = `ExpressProvider recipe deployment is not enabled for ${target.mode} targets because post-payout credit-loss settlement is unresolved and production role, Muon, affiliate-policy, core-registration, recovery, verification, and post-state workflows are not yet represented safely; no transaction was sent`
	throw new Error(`LIVE_TARGET_UNSUPPORTED: ${detail}`)
}
