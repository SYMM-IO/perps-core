// Deployment checkpoint system for resumable deployments
import fs from "fs"
import { createHash, randomUUID } from "node:crypto"
import path from "path"

import { atomicWriteFile } from "../utils/fs.js"
import { logger } from "./logger.js"
import type { DeploymentTransactionRecord } from "./tx.js"

const CHECKPOINT_DIR = "./tasks/data/checkpoints"

export interface DeployedContract {
	address: string
	constructorArgs?: any[]
	timestamp: string
	/** Present only for CREATE2 deployments, so the address can be re-derived from init code. */
	salt?: string
	create2Factory?: string
}

export interface DiamondCheckpoint {
	create2Factory?: DeployedContract
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

export interface ExpressProviderCheckpoint {
	diamondCutFacet?: DeployedContract
	diamond?: DeployedContract
	init?: DeployedContract
	facets?: Record<string, DeployedContract>
	diamondCutComplete?: boolean
}

export interface GaslessLayerCheckpoint {
	proxy?: DeployedContract
	implementation?: DeployedContract
	libraries?: Record<string, DeployedContract>
}

export interface DeploymentCheckpoint {
	deploymentId?: string
	/** Optional caller-owned namespace. Component deployments must never share the system checkpoint. */
	scope?: string
	/** Original transaction signer, retained so read-only health checks need no private key. */
	deployerAddress?: string
	network: string
	chainId?: number
	startedAt: string
	updatedAt: string
	step: string
	contracts: {
		create2Factory?: DeployedContract
		collateral?: DeployedContract
		diamond?: DiamondCheckpoint
		accountLayerDiamond?: AccountLayerCheckpoint
		signatureVerifier?: DeployedContract
		instantLayer?: DeployedContract
		symmioPartyB?: DeployedContract & { implementation?: string; admin?: string }
		symmioLiquidator?: DeployedContract & { implementation?: string; admin?: string }
		accountManager?: DeployedContract
		symbolManager?: DeployedContract
		expressProvider?: ExpressProviderCheckpoint
		gaslessLayer?: GaslessLayerCheckpoint
	}
	setupComplete?: {
		systemRoles?: boolean
		instantLayerTemplates?: boolean
		dummyAffiliate?: boolean
	}
	/** Write-ahead state for deterministic addresses that do not contain code yet. */
	pending?: {
		dummyAffiliateAddress?: string
	}
	// Generic progress tracking - keys are dot-separated paths like "systemSetup.setAdmin"
	progress?: Record<string, boolean | string[]>
	/** Immutable deployment intent and source fingerprint used to reject unsafe resumes. */
	manifest?: DeploymentManifest
	/** Confirmed, replaced, failed, and timed-out transactions accumulated across resumes. */
	transactions?: DeploymentTransactionRecord[]
	/** Once requested, explorer verification remains mandatory across every resume until it passes. */
	verificationRequired?: boolean
	verificationStatus?: "pending" | "passed" | "failed"
}

export interface DeploymentManifest {
	version: 1
	deploymentId: string
	createdAt: string
	intentHash: string
	sourceHash: string
	fingerprint: string
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
			logger.info(`${indent}⏭ ${description} already done`)
		}
		return false
	}

	if (!options.skipLog) {
		logger.info(`${indent}${description}...`)
	}

	await action()
	markCompleted(checkpoint, key)
	return true
}

/**
 * Ensure a non-idempotent boolean registration from fresh state. This is deliberately
 * independent of the checkpoint bit: a receipt may have landed just after the previous
 * process timed out, or live state may have drifted after a completed checkpoint.
 */
export async function ensureBooleanState(
	description: string,
	read: () => Promise<boolean>,
	action: () => Promise<void>,
): Promise<"present" | "executed"> {
	if (await read()) return "present"
	await action()
	if (!(await read())) throw new Error(`${description} transaction confirmed, but the expected on-chain state is still false`)
	return "executed"
}

/**
 * Decide the only safe next action for the dummy-affiliate two-step lifecycle.
 * The on-chain state is authoritative because either transaction may have landed
 * immediately after the previous process stopped waiting for its receipt.
 */
export function resolveAffiliateRegistrationResumeAction(
	state: bigint | number,
	registrationCheckpointComplete: boolean,
	approvalCheckpointComplete: boolean,
): "request" | "approve" | "complete" {
	const normalizedState = Number(state)
	if (!Number.isSafeInteger(normalizedState) || normalizedState < 0 || normalizedState > 3) {
		throw new Error(`Unexpected affiliate state ${String(state)}`)
	}

	if (normalizedState === 0) {
		if (registrationCheckpointComplete || approvalCheckpointComplete) {
			throw new Error("Affiliate checkpoint records completed work, but the deterministic address has state NONE")
		}
		return "request"
	}
	if (normalizedState === 1) {
		if (approvalCheckpointComplete) {
			throw new Error("Affiliate approval checkpoint is complete, but the deterministic address is still PENDING")
		}
		return "approve"
	}
	if (normalizedState === 2) return "complete"

	throw new Error("The dummy affiliate is PAUSED; refusing to treat it as a completed fresh-deployment fixture")
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
		logger.info(`  ⏭ ${description.replace("{item}", "all items")} already done`)
		return 0
	}

	logger.info(`  ${description.replace("{item}", `${remaining.length} items`)}...`)

	for (const item of remaining) {
		await action(item, items.indexOf(item))
		addToProgressArray(checkpoint, arrayKey, item)
	}

	return remaining.length
}

// ============================================================================
// Checkpoint File Management
// ============================================================================

/**
 * Simulated (fork-*) networks report their upstream chainId, so fork-arbitrum and a real
 * Arbitrum deployment would otherwise share checkpoint-42161.json. A rehearsal that crashed
 * part-way would then leave a checkpoint that a subsequent REAL deploy resumes from,
 * skipping steps it never actually performed. Keep them apart.
 */
let simulatedScope = false

export function setCheckpointSimulated(simulated: boolean): void {
	simulatedScope = simulated
}

export function normalizeCheckpointScope(scope: string | undefined): string | undefined {
	if (scope === undefined || scope === "") return undefined
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(scope) || scope === "." || scope === "..") {
		throw new Error(
			`Invalid deployment checkpoint scope ${JSON.stringify(scope)}. Use 1-128 letters, numbers, dots, underscores, or hyphens; path separators are forbidden.`,
		)
	}
	return scope
}

export function getCheckpointPath(chainId: number, scope?: string): string {
	const suffix = simulatedScope ? "-fork" : ""
	const normalizedScope = normalizeCheckpointScope(scope)
	const scopeSuffix = normalizedScope ? `-${normalizedScope}` : ""
	return path.join(CHECKPOINT_DIR, `checkpoint-${chainId}${suffix}${scopeSuffix}.json`)
}

export function loadCheckpoint(chainId: number, scope?: string): DeploymentCheckpoint | null {
	const normalizedScope = normalizeCheckpointScope(scope)
	const checkpointPath = getCheckpointPath(chainId, normalizedScope)

	if (!fs.existsSync(checkpointPath)) {
		return null
	}

	try {
		const data = fs.readFileSync(checkpointPath, "utf8")
		const checkpoint = JSON.parse(data) as DeploymentCheckpoint

		// Verify chainId matches (primary validation)
		if (checkpoint.chainId !== chainId) {
			throw new Error(`Checkpoint chainId mismatch: expected ${chainId}, got ${checkpoint.chainId}`)
		}
		if (checkpoint.scope !== normalizedScope) {
			throw new Error(
				`Checkpoint scope mismatch: expected ${JSON.stringify(normalizedScope)}, got ${JSON.stringify(checkpoint.scope)}. ` +
					"Refusing to resume deployment state from another component.",
			)
		}

		return checkpoint
	} catch (err) {
		// Returning null makes the caller start a fresh checkpoint, which then overwrites
		// this file on the next save — destroying the only record of what was already
		// deployed. Preserve the original before that can happen.
		logger.error(`Failed to load checkpoint: ${err}`)
		try {
			const backupPath = `${checkpointPath}.corrupt-${Date.now()}`
			fs.copyFileSync(checkpointPath, backupPath)
			logger.error(`Preserved the unreadable checkpoint at: ${backupPath}`)
			logger.error(`It may still contain deployed contract addresses — inspect it before re-running.`)
		} catch (backupErr) {
			logger.error(`Could not back up the unreadable checkpoint: ${backupErr}`)
		}
		throw new Error(
			`Deployment checkpoint ${checkpointPath} is unreadable. Refusing to start a new deployment that could overwrite recovery data. ` +
				`Cause: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
}

export function saveCheckpoint(checkpoint: DeploymentCheckpoint): void {
	if (!fs.existsSync(CHECKPOINT_DIR)) {
		fs.mkdirSync(CHECKPOINT_DIR, { recursive: true })
	}

	checkpoint.updatedAt = new Date().toISOString()

	const checkpointPath = getCheckpointPath(checkpoint.chainId!, checkpoint.scope)
	atomicWriteFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`)
}

export function createCheckpoint(network: string, chainId?: number, scope?: string): DeploymentCheckpoint {
	const deploymentId = randomUUID()
	return {
		deploymentId,
		scope: normalizeCheckpointScope(scope),
		network,
		chainId,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		step: "starting",
		contracts: {},
		setupComplete: {},
	}
}

/**
 * Build a deterministic manifest for the values and source code that define a deployment.
 * Secrets are deliberately not accepted here; callers pass only public intent (addresses,
 * flags, protocol parameters, template data, and deployer identity).
 */
export function createDeploymentManifest(intent: unknown, options: { deploymentId?: string; sourcePaths?: string[] } = {}): DeploymentManifest {
	const deploymentId = options.deploymentId || randomUUID()
	const intentHash = sha256(stableSerialize(intent))
	const sourceHash = hashSourceTree(
		options.sourcePaths || ["contracts", "tasks/deploy", "tasks/utils/diamondCut.ts", "hardhat.config.ts", "package.json", "package-lock.json"],
	)
	return {
		version: 1,
		deploymentId,
		createdAt: new Date().toISOString(),
		intentHash,
		sourceHash,
		fingerprint: sha256(`${intentHash}:${sourceHash}`),
	}
}

/** Refuse to resume when public configuration or the deploy/build source changed. */
export function assertCheckpointManifest(checkpoint: DeploymentCheckpoint, current: DeploymentManifest): void {
	if (!checkpoint.manifest) {
		throw new Error(
			"RESUME_MANIFEST_MISMATCH: existing deployment checkpoint predates manifest binding. Refusing an ambiguous resume; inspect/archive it and use --fresh only after confirming its addresses.",
		)
	}
	if (checkpoint.manifest.fingerprint !== current.fingerprint) {
		const changes = [
			checkpoint.manifest.intentHash !== current.intentHash ? "deployment configuration" : null,
			checkpoint.manifest.sourceHash !== current.sourceHash ? "contract/deployment source" : null,
		].filter(Boolean)
		throw new Error(
			`RESUME_MANIFEST_MISMATCH: deployment checkpoint does not match the current ${changes.join(" and ") || "manifest"}. ` +
				`Checkpoint ${checkpoint.manifest.fingerprint.slice(0, 12)}, current ${current.fingerprint.slice(0, 12)}. ` +
				"Resume with the original checkout/config, or review the archived addresses and deliberately start --fresh.",
		)
	}
}

function hashSourceTree(entries: string[]): string {
	const hash = createHash("sha256")
	const files: string[] = []
	const visit = (entry: string) => {
		if (!fs.existsSync(entry)) throw new Error(`Deployment manifest source is missing: ${entry}`)
		const stat = fs.statSync(entry)
		if (stat.isDirectory()) {
			for (const child of fs.readdirSync(entry).sort()) visit(path.join(entry, child))
		} else if (stat.isFile()) {
			files.push(entry)
		}
	}
	for (const entry of entries) visit(entry)
	for (const file of files.sort()) {
		hash.update(path.relative(process.cwd(), file))
		hash.update("\0")
		hash.update(fs.readFileSync(file))
		hash.update("\0")
	}
	return `sha256:${hash.digest("hex")}`
}

function stableSerialize(value: unknown): string {
	if (value === undefined) return '"[undefined]"'
	if (typeof value === "bigint") return JSON.stringify(value.toString())
	if (value === null || typeof value !== "object") return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`
	const record = value as Record<string, unknown>
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
		.join(",")}}`
}

function sha256(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

export function clearCheckpoint(chainId: number, network: string, outcome: "completed" | "abandoned" = "completed", scope?: string): void {
	const normalizedScope = normalizeCheckpointScope(scope)
	const checkpointPath = getCheckpointPath(chainId, normalizedScope)

	if (fs.existsSync(checkpointPath)) {
		if (outcome === "abandoned") {
			const existing = JSON.parse(fs.readFileSync(checkpointPath, "utf8")) as DeploymentCheckpoint
			const uncertain = (existing.transactions || []).filter(record => record.status === "timed_out" || record.status === "unresolved")
			if (uncertain.length > 0) {
				throw new Error(
					`--fresh cannot abandon checkpoint ${checkpointPath} while ${uncertain.length} broadcast(s) have an unknown outcome: ${uncertain
						.map(record => `${record.hash} (${record.deployment?.component || record.label})`)
						.join(", ")}. Resume normally to reconcile these transactions before starting a fresh deployment.`,
				)
			}
		}
		// A deliberate --fresh restart is not a completed deployment. Keep abandoned
		// evidence in its own archive so health checks never select it as production state.
		const archiveDir = path.join(CHECKPOINT_DIR, outcome)
		if (!fs.existsSync(archiveDir)) {
			fs.mkdirSync(archiveDir, { recursive: true })
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
		const scopeSuffix = normalizedScope ? `-${normalizedScope}` : ""
		const archivePath = path.join(archiveDir, `checkpoint-${chainId}-${network}${scopeSuffix}-${timestamp}.json`)
		fs.renameSync(checkpointPath, archivePath)

		logger.info(`Checkpoint archived as ${outcome}: ${archivePath}`)
	}
}

export function createDeployedContract(
	address: string,
	constructorArgs?: any[],
	create2?: { salt: string; factoryAddress: string },
): DeployedContract {
	return {
		address,
		constructorArgs,
		timestamp: new Date().toISOString(),
		salt: create2?.salt,
		create2Factory: create2?.factoryAddress,
	}
}

/**
 * A checkpoint is only a hint until every recorded contract address is proven to
 * contain code on the connected chain. This prevents a stale/wrong-RPC checkpoint
 * from silently skipping deployment steps.
 */
export async function assertCheckpointContractsHaveCode(
	checkpoint: DeploymentCheckpoint,
	getCode: (address: string) => Promise<string>,
): Promise<void> {
	const recorded = new Map<string, string>()
	const visit = (value: unknown, label: string) => {
		if (!value || typeof value !== "object") return
		const record = value as Record<string, unknown>
		if (typeof record.address === "string" && typeof record.timestamp === "string") {
			recorded.set(record.address, label)
			return
		}
		for (const [key, child] of Object.entries(record)) visit(child, label ? `${label}.${key}` : key)
	}
	visit(checkpoint.contracts, "contracts")

	for (const [address, label] of recorded) {
		// A deterministic AccountManager has no bytecode while its affiliate is
		// PENDING. The state-driven affiliate resume path validates it and requires
		// bytecode as soon as the approval reaches ACTIVE.
		if (label === "contracts.accountManager" && !checkpoint.setupComplete?.dummyAffiliate) continue
		const code = await getCode(address)
		if (!code || code === "0x") {
			throw new Error(
				`Checkpoint entry ${label} points to ${address}, but that address has no code on the connected chain. ` +
					"Check the RPC/network and checkpoint scope before resuming.",
			)
		}
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
	logger.info("")
	logger.info("=".repeat(80))
	logger.info("RESUMING FROM CHECKPOINT")
	logger.info("=".repeat(80))
	logger.info(`Network: ${checkpoint.network}`)
	logger.info(`Started: ${checkpoint.startedAt}`)
	logger.info(`Last Update: ${checkpoint.updatedAt}`)
	logger.info(`Current Step: ${checkpoint.step}`)
	logger.info("")

	logger.info("Already Deployed:")
	if (checkpoint.contracts.collateral) {
		logger.info(`  - Collateral: ${checkpoint.contracts.collateral.address}`)
	}
	if (checkpoint.contracts.diamond?.diamond) {
		logger.info(`  - Diamond: ${checkpoint.contracts.diamond.diamond.address}`)
		const facetCount = Object.keys(checkpoint.contracts.diamond.facets || {}).length
		if (facetCount > 0) {
			logger.info(`    - ${facetCount} facets deployed`)
		}
		if (checkpoint.contracts.diamond.diamondCutComplete) {
			logger.info(`    - Diamond cut complete`)
		}
	}
	if (checkpoint.contracts.accountLayerDiamond?.diamond) {
		logger.info(`  - AccountLayerDiamond: ${checkpoint.contracts.accountLayerDiamond.diamond.address}`)
		const facetCount = Object.keys(checkpoint.contracts.accountLayerDiamond.facets || {}).length
		if (facetCount > 0) {
			logger.info(`    - ${facetCount} facets deployed`)
		}
		if (checkpoint.contracts.accountLayerDiamond.diamondCutComplete) {
			logger.info(`    - Diamond cut complete`)
		}
	}
	if (checkpoint.contracts.instantLayer) {
		logger.info(`  - InstantLayer: ${checkpoint.contracts.instantLayer.address}`)
	}
	if (checkpoint.contracts.signatureVerifier) {
		logger.info(`  - MuonSignatureVerifier: ${checkpoint.contracts.signatureVerifier.address}`)
	}
	if (checkpoint.contracts.symmioPartyB) {
		logger.info(`  - SymmioPartyB: ${checkpoint.contracts.symmioPartyB.address}`)
	}
	if (checkpoint.contracts.symbolManager) {
		logger.info(`  - SymmioSymbolManager: ${checkpoint.contracts.symbolManager.address}`)
	}

	// Show setup progress (generic progress tracking)
	if (checkpoint.progress) {
		const progress = checkpoint.progress
		const completedSteps = Object.entries(progress).filter(([_, v]) => v === true).length
		const arraySteps = Object.entries(progress).filter(([_, v]) => Array.isArray(v))

		if (completedSteps > 0 || arraySteps.length > 0) {
			logger.info(`  - Setup Progress: ${completedSteps} steps completed`)

			// Show array progress (like roles)
			for (const [key, arr] of arraySteps) {
				if (Array.isArray(arr) && arr.length > 0) {
					logger.info(`    - ${key}: ${arr.length} items`)
				}
			}
		}
	}

	logger.info("=".repeat(80))
	logger.info("")
}

/**
 * Cross-process lock for one chain's checkpoint.
 *
 * Two `deploy:system` runs against the same chain interleave last-wins atomic writes while
 * both broadcast transactions, and neither notices. The operator CLI holds its own runner
 * lock, but the Hardhat task is also reachable directly, so the guard belongs next to the
 * checkpoint it protects. A lock whose owner is gone is reclaimed, so a killed run does not
 * strand the chain.
 */
export interface CheckpointLockHandle {
	release: () => void
}

function checkpointLockPath(chainId: number, scope?: string): string {
	return `${getCheckpointPath(chainId, scope)}.lock`
}

function lockOwnerAlive(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		// EPERM means the pid exists but belongs to another user: still alive.
		return (error as NodeJS.ErrnoException)?.code === "EPERM"
	}
}

export function acquireCheckpointLock(chainId: number, scope?: string): CheckpointLockHandle {
	const lockPath = checkpointLockPath(chainId, scope)
	fs.mkdirSync(path.dirname(lockPath), { recursive: true })
	const record = { pid: process.pid, chainId, scope: normalizeCheckpointScope(scope) || null, startedAt: new Date().toISOString() }

	const claim = () => fs.writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" })
	try {
		claim()
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error
		let existing: { pid?: unknown; startedAt?: unknown } = {}
		try {
			existing = JSON.parse(fs.readFileSync(lockPath, "utf8"))
		} catch {
			// An unreadable lock is treated as stale: its owner could not have written it well.
		}
		if (lockOwnerAlive(existing.pid)) {
			throw new Error(
				`Another deployment is already running for chainId ${chainId} (pid ${existing.pid}, started ${String(existing.startedAt)}). ` +
					"Wait for it to finish, or stop it and rerun so its transactions are reconciled first.",
			)
		}
		logger.warn(`Reclaiming a stale deployment lock left by pid ${String(existing.pid)} for chainId ${chainId}.`)
		fs.rmSync(lockPath, { force: true })
		claim()
	}

	let released = false
	return {
		release: () => {
			if (released) return
			released = true
			try {
				const current = JSON.parse(fs.readFileSync(lockPath, "utf8"))
				if (current?.pid !== process.pid) return
			} catch {
				return
			}
			fs.rmSync(lockPath, { force: true })
		},
	}
}
