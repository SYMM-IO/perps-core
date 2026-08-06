import type { DeploymentCheckpoint } from "./checkpoint.js"
import { createDeployedContract, saveCheckpoint } from "./checkpoint.js"
import { logger } from "./logger.js"
import { recoverConfirmedDeployment, type DeploymentConfirmationOptions, type DeploymentTransactionRecord } from "./tx.js"

type RecoveryProvider = Parameters<typeof recoverConfirmedDeployment>[2]

/**
 * Persist a contract creation as soon as the transaction is broadcast. The same record
 * object remains attached to the checkpoint while send() updates its receipt outcome,
 * closing both the timeout window and the receipt-before-component-save crash window.
 */
export function checkpointDeployment(
	checkpoint: DeploymentCheckpoint | undefined,
	component: string,
	constructorArgs: unknown[] = [],
): DeploymentConfirmationOptions | undefined {
	if (!checkpoint) return undefined
	return {
		component,
		constructorArgs,
		onSubmitted: record => persistSubmittedTransaction(checkpoint, record),
	}
}

export function persistSubmittedTransaction(checkpoint: DeploymentCheckpoint, record: DeploymentTransactionRecord): void {
	checkpoint.transactions ||= []
	const existingIndex = checkpoint.transactions.findIndex(item => item.hash.toLowerCase() === record.hash.toLowerCase())
	if (existingIndex >= 0) {
		const existing = checkpoint.transactions[existingIndex]
		if (
			existing.deployment?.component !== record.deployment?.component ||
			existing.deployment?.expectedAddress.toLowerCase() !== record.deployment?.expectedAddress.toLowerCase()
		) {
			throw new Error(`Transaction ${record.hash} is already bound to a different deployment component or address`)
		}
		checkpoint.transactions[existingIndex] = record
	} else {
		checkpoint.transactions.push(record)
	}
	saveCheckpoint(checkpoint)
}

/**
 * Restore every confirmed creation record under a canonical `contracts.*` checkpoint
 * path. Each record is revalidated against the connected RPC before it can suppress a
 * factory deployment.
 */
export async function recoverCheckpointContractDeployments(
	checkpoint: DeploymentCheckpoint | undefined,
	provider: RecoveryProvider,
	componentPrefix: string,
): Promise<number> {
	if (!checkpoint?.transactions?.length) return 0
	const components = [
		...new Set(
			checkpoint.transactions
				.map(record => record.deployment?.component)
				.filter((component): component is string => Boolean(component) && matchesPrefix(component!, componentPrefix)),
		),
	]

	let recovered = 0
	for (const component of components) {
		if (!component.startsWith("contracts.")) continue
		const current = readPath(checkpoint, component)
		const address = await recoverConfirmedDeployment(checkpoint.transactions, component, provider)
		if (!address) continue
		if (current !== undefined) {
			if (!isDeployedContract(current) || current.address.toLowerCase() !== address.toLowerCase()) {
				throw new Error(`${component} checkpoint conflicts with confirmed creation address ${address}`)
			}
			continue
		}
		const record = checkpoint.transactions.find(
			item => item.deployment?.component === component && (item.status === "confirmed" || item.status === "replaced"),
		)!
		writePath(checkpoint, component, createDeployedContract(address, record.deployment?.constructorArgs))
		logger.info(`  ↻ Recovered ${component} at ${address} from confirmed creation ${record.replacementHash || record.hash}`)
		recovered++
	}

	if (recovered > 0) saveCheckpoint(checkpoint)
	return recovered
}

/** Recover a non-canonical intermediate creation, such as a proxy implementation. */
export async function recoverCheckpointDeployment(
	checkpoint: DeploymentCheckpoint | undefined,
	provider: RecoveryProvider,
	component: string,
): Promise<string | null> {
	if (!checkpoint?.transactions?.length) return null
	return recoverConfirmedDeployment(checkpoint.transactions, component, provider)
}

function matchesPrefix(component: string, prefix: string): boolean {
	return component === prefix || component.startsWith(prefix.endsWith(".") ? prefix : `${prefix}.`)
}

function isDeployedContract(value: unknown): value is { address: string } {
	return Boolean(value && typeof value === "object" && typeof (value as { address?: unknown }).address === "string")
}

function pathParts(component: string): string[] {
	if (!/^contracts\.[A-Za-z0-9_.]+$/.test(component)) throw new Error(`Unsafe deployment checkpoint path: ${JSON.stringify(component)}`)
	const parts = component.split(".")
	if (parts.some(part => ["__proto__", "constructor", "prototype"].includes(part))) {
		throw new Error(`Unsafe deployment checkpoint path: ${JSON.stringify(component)}`)
	}
	return parts
}

function readPath(root: DeploymentCheckpoint, component: string): unknown {
	let current: unknown = root
	for (const part of pathParts(component)) {
		if (!current || typeof current !== "object") return undefined
		current = (current as Record<string, unknown>)[part]
	}
	return current
}

function writePath(root: DeploymentCheckpoint, component: string, value: unknown): void {
	const parts = pathParts(component)
	let current = root as unknown as Record<string, unknown>
	for (const part of parts.slice(0, -1)) {
		const child = current[part]
		if (child === undefined) current[part] = {}
		else if (!child || typeof child !== "object" || Array.isArray(child)) {
			throw new Error(`Cannot restore ${component}; checkpoint path ${part} is not an object`)
		}
		current = current[part] as Record<string, unknown>
	}
	current[parts[parts.length - 1]] = value
}
