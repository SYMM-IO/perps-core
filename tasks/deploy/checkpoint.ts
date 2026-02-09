// Deployment checkpoint system for resumable deployments
import fs from "fs"
import path from "path"

import { logger } from "./logger.js"

const CHECKPOINT_DIR = "./tasks/data/checkpoints"

export interface DeployedContract {
	address: string
	constructorArgs?: any[]
	timestamp: string
}

export interface DiamondCheckpoint {
	diamondCutFacet?: DeployedContract
	diamond?: DeployedContract
	init?: DeployedContract
	libraries?: Record<string, DeployedContract>
	facets?: Record<string, DeployedContract>
	diamondCutComplete?: boolean
}

export interface AccountLayerCheckpoint {
	diamondCutFacet?: DeployedContract
	diamond?: DeployedContract
	init?: DeployedContract
	libraries?: Record<string, DeployedContract>
	facets?: Record<string, DeployedContract>
	diamondCutComplete?: boolean
}

export interface DeploymentCheckpoint {
	network: string
	chainId?: number
	startedAt: string
	updatedAt: string
	step: string
	contracts: {
		collateral?: DeployedContract
		diamond?: DiamondCheckpoint
		accountLayerDiamond?: AccountLayerCheckpoint
		instantLayer?: DeployedContract
		symmioPartyB?: DeployedContract & { implementation?: string; admin?: string }
		accountManager?: DeployedContract
	}
	setupComplete?: {
		systemRoles?: boolean
		instantLayerTemplates?: boolean
		dummyAffiliate?: boolean
	}
	// Generic progress tracking - keys are dot-separated paths like "systemSetup.setAdmin"
	progress?: Record<string, boolean | string[]>
}

// ============================================================================
// Generic Checkpoint Helpers
// ============================================================================

/**
 * Check if a progress key is already completed
 */
export function isCompleted(checkpoint: DeploymentCheckpoint, key: string): boolean {
	if (!checkpoint.progress) return false
	return checkpoint.progress[key] === true
}

/**
 * Check if an item exists in a progress array (for tracking lists like role grants)
 */
export function isInProgressArray(checkpoint: DeploymentCheckpoint, key: string, item: string): boolean {
	if (!checkpoint.progress) return false
	const arr = checkpoint.progress[key]
	return Array.isArray(arr) && arr.includes(item)
}

/**
 * Mark a progress key as completed and save checkpoint
 */
export function markCompleted(checkpoint: DeploymentCheckpoint, key: string): void {
	if (!checkpoint.progress) checkpoint.progress = {}
	checkpoint.progress[key] = true
	saveCheckpoint(checkpoint)
}

/**
 * Add an item to a progress array and save checkpoint
 */
export function addToProgressArray(checkpoint: DeploymentCheckpoint, key: string, item: string): void {
	if (!checkpoint.progress) checkpoint.progress = {}
	if (!Array.isArray(checkpoint.progress[key])) {
		checkpoint.progress[key] = []
	}
	;(checkpoint.progress[key] as string[]).push(item)
	saveCheckpoint(checkpoint)
}

/**
 * Generic wrapper for a checkpointed action.
 * Skips if already completed, otherwise executes and marks as done.
 *
 * @param checkpoint - The deployment checkpoint
 * @param key - Unique key for this step (e.g., "systemSetup.setAdmin")
 * @param description - Human-readable description for logging
 * @param action - Async function to execute
 * @param options - Optional settings
 * @returns true if action was executed, false if skipped
 */
export async function checkpointedStep(
	checkpoint: DeploymentCheckpoint,
	key: string,
	description: string,
	action: () => Promise<void>,
	options: { indent?: string; skipLog?: boolean } = {},
): Promise<boolean> {
	const indent = options.indent ?? "  "

	if (isCompleted(checkpoint, key)) {
		if (!options.skipLog) {
			console.log(`${indent}⏭ ${description} already done`)
		}
		return false
	}

	if (!options.skipLog) {
		console.log(`${indent}${description}...`)
	}

	await action()
	markCompleted(checkpoint, key)
	return true
}

/**
 * Execute multiple checkpointed steps for items in an array.
 * Useful for granting multiple roles, deploying multiple contracts, etc.
 *
 * @param checkpoint - The deployment checkpoint
 * @param arrayKey - Key for tracking which items are completed
 * @param items - Array of items to process
 * @param description - Description template (use {item} for item name, {index} for index)
 * @param action - Async function to execute for each item
 * @returns Number of items that were executed (not skipped)
 */
export async function checkpointedBatch<T extends string>(
	checkpoint: DeploymentCheckpoint,
	arrayKey: string,
	items: T[],
	description: string,
	action: (item: T, index: number) => Promise<void>,
): Promise<number> {
	const remaining = items.filter(item => !isInProgressArray(checkpoint, arrayKey, item))

	if (remaining.length === 0) {
		console.log(`  ⏭ ${description.replace("{item}", "all items")} already done`)
		return 0
	}

	console.log(`  ${description.replace("{item}", `${remaining.length} items`)}...`)

	for (const item of remaining) {
		await action(item, items.indexOf(item))
		addToProgressArray(checkpoint, arrayKey, item)
	}

	return remaining.length
}

// ============================================================================
// Checkpoint File Management
// ============================================================================

function getCheckpointPath(chainId: number): string {
	return path.join(CHECKPOINT_DIR, `checkpoint-${chainId}.json`)
}

export function loadCheckpoint(chainId: number): DeploymentCheckpoint | null {
	const checkpointPath = getCheckpointPath(chainId)

	if (!fs.existsSync(checkpointPath)) {
		return null
	}

	try {
		const data = fs.readFileSync(checkpointPath, "utf8")
		const checkpoint = JSON.parse(data) as DeploymentCheckpoint

		// Verify chainId matches (primary validation)
		if (checkpoint.chainId !== chainId) {
			logger.error(`Checkpoint chainId mismatch: expected ${chainId}, got ${checkpoint.chainId}`)
			return null
		}

		return checkpoint
	} catch (err) {
		logger.error(`Failed to load checkpoint: ${err}`)
		return null
	}
}

export function saveCheckpoint(checkpoint: DeploymentCheckpoint): void {
	if (!fs.existsSync(CHECKPOINT_DIR)) {
		fs.mkdirSync(CHECKPOINT_DIR, { recursive: true })
	}

	checkpoint.updatedAt = new Date().toISOString()

	const checkpointPath = getCheckpointPath(checkpoint.chainId!)
	fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2))
}

export function createCheckpoint(network: string, chainId?: number): DeploymentCheckpoint {
	return {
		network,
		chainId,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		step: "starting",
		contracts: {},
		setupComplete: {},
	}
}

export function clearCheckpoint(chainId: number, network: string): void {
	const checkpointPath = getCheckpointPath(chainId)

	if (fs.existsSync(checkpointPath)) {
		// Move to completed checkpoints for reference
		const completedDir = path.join(CHECKPOINT_DIR, "completed")
		if (!fs.existsSync(completedDir)) {
			fs.mkdirSync(completedDir, { recursive: true })
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
		const completedPath = path.join(completedDir, `checkpoint-${chainId}-${network}-${timestamp}.json`)
		fs.renameSync(checkpointPath, completedPath)

		logger.info(`Checkpoint archived to: ${completedPath}`)
	}
}

export function createDeployedContract(address: string, constructorArgs?: any[]): DeployedContract {
	return {
		address,
		constructorArgs,
		timestamp: new Date().toISOString(),
	}
}

// Helper to check if we should skip a deployment
export function shouldSkipDeployment(checkpoint: DeploymentCheckpoint | null, contractPath: string): string | null {
	if (!checkpoint) return null

	// Navigate the path like "contracts.diamond.facets.AccountFacet"
	const parts = contractPath.split(".")
	let current: any = checkpoint

	for (const part of parts) {
		if (!current || typeof current !== "object") return null
		current = current[part]
	}

	if (current && typeof current === "object" && "address" in current) {
		return current.address
	}

	return null
}

// Display checkpoint status
export function displayCheckpointStatus(checkpoint: DeploymentCheckpoint): void {
	console.log("")
	console.log("=".repeat(80))
	console.log("RESUMING FROM CHECKPOINT")
	console.log("=".repeat(80))
	console.log(`Network: ${checkpoint.network}`)
	console.log(`Started: ${checkpoint.startedAt}`)
	console.log(`Last Update: ${checkpoint.updatedAt}`)
	console.log(`Current Step: ${checkpoint.step}`)
	console.log("")

	console.log("Already Deployed:")
	if (checkpoint.contracts.collateral) {
		console.log(`  - Collateral: ${checkpoint.contracts.collateral.address}`)
	}
	if (checkpoint.contracts.diamond?.diamond) {
		console.log(`  - Diamond: ${checkpoint.contracts.diamond.diamond.address}`)
		const facetCount = Object.keys(checkpoint.contracts.diamond.facets || {}).length
		if (facetCount > 0) {
			console.log(`    - ${facetCount} facets deployed`)
		}
		if (checkpoint.contracts.diamond.diamondCutComplete) {
			console.log(`    - Diamond cut complete`)
		}
	}
	if (checkpoint.contracts.accountLayerDiamond?.diamond) {
		console.log(`  - AccountLayerDiamond: ${checkpoint.contracts.accountLayerDiamond.diamond.address}`)
		const facetCount = Object.keys(checkpoint.contracts.accountLayerDiamond.facets || {}).length
		if (facetCount > 0) {
			console.log(`    - ${facetCount} facets deployed`)
		}
		if (checkpoint.contracts.accountLayerDiamond.diamondCutComplete) {
			console.log(`    - Diamond cut complete`)
		}
	}
	if (checkpoint.contracts.instantLayer) {
		console.log(`  - InstantLayer: ${checkpoint.contracts.instantLayer.address}`)
	}
	if (checkpoint.contracts.symmioPartyB) {
		console.log(`  - SymmioPartyB: ${checkpoint.contracts.symmioPartyB.address}`)
	}

	// Show setup progress (generic progress tracking)
	if (checkpoint.progress) {
		const progress = checkpoint.progress
		const completedSteps = Object.entries(progress).filter(([_, v]) => v === true).length
		const arraySteps = Object.entries(progress).filter(([_, v]) => Array.isArray(v))

		if (completedSteps > 0 || arraySteps.length > 0) {
			console.log(`  - Setup Progress: ${completedSteps} steps completed`)

			// Show array progress (like roles)
			for (const [key, arr] of arraySteps) {
				if (Array.isArray(arr) && arr.length > 0) {
					console.log(`    - ${key}: ${arr.length} items`)
				}
			}
		}
	}

	console.log("=".repeat(80))
	console.log("")
}
