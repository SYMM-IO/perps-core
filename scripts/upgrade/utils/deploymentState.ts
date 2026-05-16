import fs from "fs"
import path from "path"

import { ethers } from "../../../test/helpers/hardhat-connection.js"

export type DeploymentStateMetadata = {
	networkName?: string
	chainId?: number
	diamondAddress?: string
}

export type DeploymentStateContext = {
	networkName?: string
	chainId?: number
	diamondAddress?: string
}

const METADATA_KEYS = new Set(["metadata"])

export async function resolveDeploymentStateMetadata(context: DeploymentStateContext = {}): Promise<DeploymentStateMetadata> {
	const network = await ethers.provider.getNetwork()
	return normalizeDeploymentStateMetadata({
		networkName: context.networkName,
		chainId: context.chainId ?? Number(network.chainId),
		diamondAddress: context.diamondAddress,
	})
}

export function loadDeploymentState<T extends object>(filePath: string, expected?: DeploymentStateMetadata): T {
	if (!filePath || !fs.existsSync(filePath)) return {} as T
	const state = JSON.parse(fs.readFileSync(filePath, "utf-8")) as T
	validateDeploymentStateMetadata(filePath, state as Record<string, any>, expected)
	return state
}

export function saveDeploymentState<T extends object>(filePath: string, state: T, metadata?: DeploymentStateMetadata): void {
	if (!filePath) return
	const dir = path.dirname(filePath)
	if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	const nextState = metadata ? ({ ...state, metadata: normalizeDeploymentStateMetadata(metadata) } as T) : state
	fs.writeFileSync(filePath, JSON.stringify(nextState, null, 2))
}

export function validateDeploymentStateMetadata(filePath: string, state: Record<string, any>, expected?: DeploymentStateMetadata): void {
	if (!expected || !hasDeploymentPayload(state)) return

	const metadata = readMetadata(state)
	if (!metadata) {
		throw new Error(
			`Deployment state file ${filePath} is missing metadata. ` +
				`Delete it to redeploy, or add metadata.networkName, metadata.chainId, and metadata.diamondAddress before resuming.`,
		)
	}

	const normalizedExpected = normalizeDeploymentStateMetadata(expected)
	const normalizedActual = normalizeDeploymentStateMetadata(metadata)
	const problems: string[] = []

	if (normalizedExpected.networkName && normalizedActual.networkName !== normalizedExpected.networkName) {
		problems.push(`networkName expected ${normalizedExpected.networkName}, found ${normalizedActual.networkName ?? "(missing)"}`)
	}
	if (normalizedExpected.chainId !== undefined && normalizedActual.chainId !== normalizedExpected.chainId) {
		problems.push(`chainId expected ${normalizedExpected.chainId}, found ${normalizedActual.chainId ?? "(missing)"}`)
	}
	if (normalizedExpected.diamondAddress && normalizedActual.diamondAddress !== normalizedExpected.diamondAddress) {
		problems.push(`diamondAddress expected ${normalizedExpected.diamondAddress}, found ${normalizedActual.diamondAddress ?? "(missing)"}`)
	}

	if (problems.length > 0) {
		throw new Error(`Deployment state file ${filePath} does not match this run: ${problems.join("; ")}`)
	}
}

function readMetadata(state: Record<string, any>): DeploymentStateMetadata | undefined {
	if (state.metadata && typeof state.metadata === "object") return state.metadata as DeploymentStateMetadata

	const legacyMetadata: DeploymentStateMetadata = {
		networkName: typeof state.networkName === "string" ? state.networkName : typeof state.network === "string" ? state.network : undefined,
		chainId: state.chainId === undefined ? undefined : Number(state.chainId),
		diamondAddress: typeof state.diamondAddress === "string" ? state.diamondAddress : typeof state.diamond === "string" ? state.diamond : undefined,
	}
	if (legacyMetadata.networkName || legacyMetadata.chainId !== undefined || legacyMetadata.diamondAddress) return legacyMetadata
	return undefined
}

function hasDeploymentPayload(state: Record<string, any>): boolean {
	return Object.keys(state).some(key => !METADATA_KEYS.has(key))
}

function normalizeDeploymentStateMetadata(metadata: DeploymentStateMetadata): DeploymentStateMetadata {
	return {
		networkName: metadata.networkName,
		chainId: metadata.chainId === undefined ? undefined : Number(metadata.chainId),
		diamondAddress:
			metadata.diamondAddress && ethers.isAddress(metadata.diamondAddress) ? ethers.getAddress(metadata.diamondAddress) : metadata.diamondAddress,
	}
}
