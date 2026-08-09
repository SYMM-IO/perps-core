import { ethers as eth } from "ethers"
import * as fs from "fs"
import path from "node:path"

import { MigrationFacet } from "../../src/types/index.js"
import { migrationTxOverrides } from "./utils/txOverrides.js"

// =============================================================================
// Configuration
// =============================================================================

// Library-level defaults. `progressFile` is intentionally null so callers must
// supply a network-scoped path (e.g. scripts/upgrade/output/migration-progress-base.json).
// runMigration.ts already does this; importers using migrate() directly should follow suit.
const DEFAULT_CONFIG: Required<MigrationConfig> = {
	chunkSize: 50,
	maxRetries: 3,
	retryDelayMs: 2000,
	retryBackoffMultiplier: 2,
	confirmations: 1,
	progressFile: null,
	progressContext: null,
	skipPreCheck: false,
	dryRun: false,
}

// =============================================================================
// Types
// =============================================================================

export interface MigrationConfig {
	/** Number of items per transaction batch */
	chunkSize?: number
	/** Maximum retry attempts for failed transactions */
	maxRetries?: number
	/** Initial delay between retries in milliseconds */
	retryDelayMs?: number
	/** Multiplier for exponential backoff */
	retryBackoffMultiplier?: number
	/** Number of block confirmations to wait */
	confirmations?: number
	/** File path for saving progress (enables resume) */
	progressFile?: string | null
	/** Chain and diamond identity used to bind persisted resume progress */
	progressContext?: MigrationProgressContext | null
	/** Skip pre-flight on-chain checks for already-migrated items (faster, may send no-op transactions) */
	skipPreCheck?: boolean
	/** Dry run mode - log operations without executing */
	dryRun?: boolean
}

export interface PartyBMigrationTask {
	partyB: string
	partyAs: string[]
}

export interface MigrationInput {
	/** Quote IDs to migrate for aggregated positions */
	quoteIds: bigint[]
	/** PartyB tasks for cross partyB balance migration */
	partyBTasks: PartyBMigrationTask[]
}

export interface MigrationProgressContext {
	chainId: bigint | number | string
	diamondAddress: string
	networkName: string
	forkMode: boolean
	executionDomain: string
	migrationImplementation: string
	migrationCodeHash: string
}

export interface MigrationProgressIdentity {
	chainId: string
	diamondAddress: string
	networkName: string
	forkMode: boolean
	executionDomain: string
	migrationImplementation: string
	migrationCodeHash: string
	migrationInputHash: string
	chunkSize: number
	skipPreCheck: boolean
	partyBTasksHash: string
}

export interface ActivePartyBTaskIdentity {
	index: number
	partyB: string
	taskHash: string
}

export interface MigrationProgress {
	schemaVersion: 1
	/** Null only for in-memory runs where progress persistence is disabled. */
	identity: MigrationProgressIdentity | null
	startedAt: string
	phase: "quotes" | "balances" | "complete"
	quotesProcessed: number
	partyBsProcessed: number
	partyAsProcessed: number
	lastProcessedQuoteChunk: number
	lastProcessedPartyB: number
	lastProcessedPartyAChunk: number
	activePartyBTask: ActivePartyBTaskIdentity | null
}

export interface OperationResult {
	operation: string
	success: boolean
	txHash?: string
	error?: string
	duration: number
}

export interface MigrationReport {
	startedAt: string
	finishedAt: string
	totalDuration: number
	quotesTotal: number
	quotesMigrated: number
	partyBsTotal: number
	partyBsMigrated: number
	partyAsTotal: number
	partyAsMigrated: number
	operations: OperationResult[]
	status: "success" | "failed"
}

type MigrationQuoteView = {
	quoteStatus: bigint
	partyA: string
	quantity: bigint
	closedAmount: bigint
}

const FEE_RESERVATION_STATUSES = new Set([0, 1, 2])
const ACTIVE_POSITION_STATUSES = new Set([4, 5, 6])

function quoteOpenAmount(quote: MigrationQuoteView): bigint {
	return BigInt(quote.quantity) - BigInt(quote.closedAmount)
}

function isZeroAddress(address: string): boolean {
	return eth.getAddress(address) === eth.ZeroAddress
}

function migrationSkipReason(quote: MigrationQuoteView): string | undefined {
	if (isZeroAddress(quote.partyA)) return "non-existent quote"
	const status = Number(quote.quoteStatus)
	if (FEE_RESERVATION_STATUSES.has(status)) return undefined
	if (!ACTIVE_POSITION_STATUSES.has(status)) return `status=${status}`
	if (quoteOpenAmount(quote) <= 0n) return `status=${status} with zero open amount`
	return undefined
}

// =============================================================================
// Main Migration Function
// =============================================================================

export async function migrate(
	migrationFacet: MigrationFacet,
	viewFacetQuote: { getQuote(quoteId: bigint): Promise<MigrationQuoteView> },
	input: MigrationInput,
	config: MigrationConfig = {},
): Promise<MigrationReport> {
	const cfg = { ...DEFAULT_CONFIG, ...config }
	if (!Number.isSafeInteger(cfg.chunkSize) || cfg.chunkSize <= 0) {
		throw new Error(`Invalid migration chunkSize: ${cfg.chunkSize}`)
	}
	const progressFile = normalizeProgressFile(cfg.progressFile)
	if (progressFile && !cfg.progressContext) {
		throw new Error("Connected chain, diamond, execution-domain, and MigrationFacet identities are required when progressFile is enabled")
	}
	if (progressFile && cfg.dryRun) {
		throw new Error("Persisted migration progress is not allowed in dry-run mode")
	}
	if (progressFile && (!Number.isSafeInteger(cfg.confirmations) || cfg.confirmations < 1)) {
		throw new Error("Persisted migration progress requires at least one transaction confirmation")
	}
	const expectedProgressIdentity = progressFile ? buildMigrationProgressIdentity(input, cfg.chunkSize, cfg.skipPreCheck, cfg.progressContext!) : null
	const startTime = Date.now()
	const startedAt = new Date().toISOString()

	const operations: OperationResult[] = []

	// Load progress if resuming
	let progress = loadProgress(progressFile, expectedProgressIdentity, input)
	let quotesMigrated = progress?.quotesProcessed ?? 0
	let partyBsMigrated = progress?.partyBsProcessed ?? 0
	let partyAsMigrated = progress?.partyAsProcessed ?? 0

	const isResuming = !!progress
	if (!progress) {
		progress = {
			schemaVersion: 1,
			identity: expectedProgressIdentity,
			startedAt,
			phase: "quotes",
			quotesProcessed: 0,
			partyBsProcessed: 0,
			partyAsProcessed: 0,
			lastProcessedQuoteChunk: -1,
			lastProcessedPartyB: -1,
			lastProcessedPartyAChunk: -1,
			activePartyBTask: null,
		}
	}
	const persistProgress = (): void => saveProgress(progressFile, progress, expectedProgressIdentity, input)
	if (isResuming && !cfg.skipPreCheck) {
		// Pre-check mode is intentionally item-based, not cursor-based. Rewind the
		// local cursor so every quote and PartyB pair is revalidated on-chain; this
		// also recovers safely if a reorg or restored snapshot removed prior txs.
		progress.phase = "quotes"
		progress.quotesProcessed = 0
		progress.partyBsProcessed = 0
		progress.partyAsProcessed = 0
		progress.lastProcessedQuoteChunk = -1
		progress.lastProcessedPartyB = -1
		progress.lastProcessedPartyAChunk = -1
		progress.activePartyBTask = null
		quotesMigrated = 0
		partyBsMigrated = 0
		partyAsMigrated = 0
		persistProgress()
	} else if (!isResuming) {
		persistProgress()
	}

	const totalPartyAs = input.partyBTasks.reduce((sum, task) => sum + deduplicateAddresses(task.partyAs).length, 0)
	const totalQuoteChunks = Math.ceil(input.quoteIds.length / cfg.chunkSize)

	logHeader("SYMMIO V0.8.5 Migration")
	log("info", `Started at: ${startedAt}`)
	if (isResuming) log("info", `Resuming from: ${progress.phase} phase`)
	log("info", ``)
	log("info", `Configuration:`)
	log("info", `  Chunk size: ${cfg.chunkSize}`)
	log("info", `  Max retries: ${cfg.maxRetries}`)
	log("info", `  Confirmations: ${cfg.confirmations}`)
	log("info", `  Dry run: ${cfg.dryRun ?? false}`)
	log("info", ``)
	log("info", `Progress:`)
	log("info", `  Quotes:   ${quotesMigrated}/${input.quoteIds.length} (${progress.lastProcessedQuoteChunk + 1}/${totalQuoteChunks} chunks)`)
	log("info", `  PartyBs:  ${partyBsMigrated}/${input.partyBTasks.length}`)
	log("info", `  PartyAs:  ${partyAsMigrated}/${totalPartyAs}`)

	let migrationError: Error | null = null

	try {
		// =========================================================================
		// Phase 1: Migrate Quotes (Aggregated Positions)
		// =========================================================================

		if (progress.phase === "quotes" || progress.phase === "balances") {
			if (progress.phase === "quotes") {
				logHeader("Phase 1: Migrating Quotes")

				let quotesToMigrate = input.quoteIds
				if (!cfg.skipPreCheck) {
					// Filter out already-migrated and non-migratable quotes to avoid no-op transactions.
					// Non-migratable statuses (CANCELED=3, CLOSED=7, LIQUIDATED=8, EXPIRED=9, LIQUIDATED_PENDING=10)
					// and active-position quotes with zero open amount are correctly skipped by the contract — no need to send them.
					const pending: bigint[] = []
					let alreadyMigrated = 0
					let nonMigratable = 0
					let zeroOpenActive = 0
					for (const quoteId of input.quoteIds) {
						const migrated: boolean = await migrationFacet.isQuoteMigrated(quoteId)
						if (migrated) {
							alreadyMigrated++
						} else {
							const quote = await viewFacetQuote.getQuote(quoteId)
							const skipReason = migrationSkipReason(quote)
							if (!skipReason) {
								pending.push(quoteId)
							} else {
								nonMigratable++
								if (skipReason.includes("zero open amount")) zeroOpenActive++
							}
						}
					}
					log("info", `  ${alreadyMigrated} already migrated, ${nonMigratable} non-migratable, ${pending.length} remaining`)
					if (zeroOpenActive > 0) log("info", `  ${zeroOpenActive} active-status quote(s) skipped because openAmount=0`)
					if (alreadyMigrated > quotesMigrated) {
						quotesMigrated = alreadyMigrated
						progress.quotesProcessed = alreadyMigrated
					}
					quotesToMigrate = pending
				}

				const quoteChunks = chunkArray(quotesToMigrate, cfg.chunkSize)
				const startChunk = cfg.skipPreCheck ? progress.lastProcessedQuoteChunk + 1 : 0
				if (!cfg.skipPreCheck && isResuming && quoteChunks.length > 0) {
					log("info", `  Resume pre-check removed already-migrated quotes; continuing from the first pending chunk`)
				}

				for (let i = startChunk; i < quoteChunks.length; i++) {
					const chunk = quoteChunks[i]
					const operation = `Migrate quotes (chunk ${i + 1}/${quoteChunks.length})`

					const result = await executeOperation(
						operation,
						async () => {
							if (cfg.dryRun) {
								log("info", `  [DRY RUN] Would migrate ${chunk.length} quotes`)
								return null
							}
							return migrationFacet.migrateQuotes(chunk, migrationTxOverrides())
						},
						cfg,
					)

					operations.push(result)

					if (result.success) {
						quotesMigrated += chunk.length
						progress.quotesProcessed += chunk.length
						progress.lastProcessedQuoteChunk = i
						persistProgress()
					} else {
						throw new Error(`Migration failed at ${operation}: ${result.error}`)
					}
				}

				progress.phase = "balances"
				persistProgress()
			}

			// =====================================================================
			// Phase 2: Migrate PartyB Balances (Cross Bucket)
			// =====================================================================

			logHeader("Phase 2: Migrating PartyB Balances")

			const startPartyB = progress.lastProcessedPartyB + 1

			for (let i = startPartyB; i < input.partyBTasks.length; i++) {
				const task = input.partyBTasks[i]
				const partyB = task.partyB
				const partyAs = deduplicateAddresses(task.partyAs)
				progress.activePartyBTask = buildActivePartyBTaskIdentity(task, i)
				persistProgress()

				log("info", `\nProcessing PartyB ${i + 1}/${input.partyBTasks.length}: ${formatAddress(partyB)}`)

				let partyAsToMigrate = partyAs
				if (!cfg.skipPreCheck) {
					// Filter out already-migrated partyAs to avoid no-op transactions
					const pending: string[] = []
					for (const partyA of partyAs) {
						const migrated: boolean = await migrationFacet.isCrossLockedValuesMigrated(partyB, partyA)
						if (!migrated) pending.push(partyA)
					}
					log("info", `  PartyAs: ${partyAs.length - pending.length} already migrated, ${pending.length} remaining`)

					if (pending.length === 0) {
						partyBsMigrated++
						progress.partyBsProcessed = partyBsMigrated
						progress.lastProcessedPartyB = i
						progress.lastProcessedPartyAChunk = -1
						progress.activePartyBTask = null
						persistProgress()
						continue
					}
					partyAsToMigrate = pending
				} else {
					log("info", `  PartyAs to process: ${partyAs.length}`)
				}

				// Chunk partyAs to avoid gas/compute limits
				const partyAChunks = chunkArray(partyAsToMigrate, cfg.chunkSize)

				// Resume from last successful partyA chunk if resuming the same partyB
				const startPartyAChunk = cfg.skipPreCheck && i === startPartyB ? progress.lastProcessedPartyAChunk + 1 : 0
				if (!cfg.skipPreCheck && i === startPartyB && progress.lastProcessedPartyAChunk >= 0 && partyAChunks.length > 0) {
					log("info", `  Resume pre-check removed already-migrated PartyAs; continuing from the first pending chunk`)
				}

				for (let j = startPartyAChunk; j < partyAChunks.length; j++) {
					const partyAChunk = partyAChunks[j]
					const chunkLabel = partyAChunks.length > 1 ? ` (chunk ${j + 1}/${partyAChunks.length})` : ""
					const operation = `Migrate balances for ${formatAddress(partyB)}${chunkLabel}`

					const result = await executeOperation(
						operation,
						async () => {
							if (cfg.dryRun) {
								log("info", `  [DRY RUN] Would migrate ${partyAChunk.length} partyA balances`)
								return null
							}
							return migrationFacet.migrateCrossLockedValues(partyB, partyAChunk, migrationTxOverrides())
						},
						cfg,
					)

					operations.push(result)

					if (result.success) {
						partyAsMigrated += partyAChunk.length
						progress.partyAsProcessed = partyAsMigrated
						progress.lastProcessedPartyAChunk = j
						persistProgress()
					} else {
						throw new Error(`Migration failed at ${operation}: ${result.error}`)
					}
				}

				partyBsMigrated++
				progress.partyBsProcessed = partyBsMigrated
				progress.lastProcessedPartyB = i
				progress.lastProcessedPartyAChunk = -1
				progress.activePartyBTask = null
				persistProgress()
			}

			progress.phase = "complete"
			progress.activePartyBTask = null
			persistProgress()
		}
	} catch (error) {
		migrationError = error instanceof Error ? error : new Error(String(error))
	}

	// =========================================================================
	// Generate Report (always — even on failure)
	// =========================================================================

	const finishedAt = new Date().toISOString()
	const totalDuration = Date.now() - startTime

	const status: MigrationReport["status"] = migrationError ? "failed" : "success"

	const report: MigrationReport = {
		startedAt,
		finishedAt,
		totalDuration,
		quotesTotal: input.quoteIds.length,
		quotesMigrated,
		partyBsTotal: input.partyBTasks.length,
		partyBsMigrated,
		partyAsTotal: totalPartyAs,
		partyAsMigrated,
		operations,
		status,
	}

	printReport(report)

	if (migrationError) {
		throw migrationError
	}

	// Clean up progress file on success
	if (progressFile) {
		deleteProgress(progressFile)
	}

	return report
}

// =============================================================================
// Operation Execution
// =============================================================================

async function executeOperation(
	name: string,
	fn: () => Promise<eth.TransactionResponse | null>,
	config: Required<MigrationConfig>,
): Promise<OperationResult> {
	const startTime = Date.now()

	for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
		try {
			log("info", `  ${name}...`)

			const tx = await fn()

			if (tx === null) {
				// Dry run or skipped
				return {
					operation: name,
					success: true,
					duration: Date.now() - startTime,
				}
			}

			log("info", `    Tx submitted: ${tx.hash}`)

			if (config.confirmations > 0) {
				log("info", `    Waiting for ${config.confirmations} confirmation(s)...`)
				await tx.wait(config.confirmations)
			}

			log("success", `  ✓ ${name}`)

			return {
				operation: name,
				success: true,
				txHash: tx.hash,
				duration: Date.now() - startTime,
			}
		} catch (error) {
			const errorMsg = formatError(error)
			const txHash = transactionHashFromError(error)
			const deterministicRevert = isMinedTransactionRevert(error)

			if (deterministicRevert) {
				log("error", `  ✗ ${name} - ${errorMsg}`)
				return {
					operation: name,
					success: false,
					txHash,
					error: errorMsg,
					duration: Date.now() - startTime,
				}
			}

			if (attempt < config.maxRetries) {
				const delay = config.retryDelayMs * Math.pow(config.retryBackoffMultiplier, attempt - 1)
				log("warn", `  Attempt ${attempt}/${config.maxRetries} failed: ${errorMsg}`)
				log("warn", `  Retrying in ${delay}ms...`)
				await sleep(delay)
			} else {
				log("error", `  ✗ ${name} - ${errorMsg}`)
				return {
					operation: name,
					success: false,
					txHash,
					error: errorMsg,
					duration: Date.now() - startTime,
				}
			}
		}
	}

	// Should not reach here, but TypeScript needs it
	return {
		operation: name,
		success: false,
		error: "Unknown error",
		duration: Date.now() - startTime,
	}
}

// =============================================================================
// Progress Management
// =============================================================================

type CanonicalPartyBTask = {
	partyB: string
	partyAs: string[]
}

function normalizeProgressFile(filePath: string | null | undefined): string | null {
	if (filePath === null || filePath === undefined) return null
	if (typeof filePath !== "string" || filePath.trim().length === 0) {
		throw new Error("progressFile must be a non-empty path when progress persistence is enabled")
	}
	return filePath
}

function canonicalHash(value: unknown): string {
	return eth.keccak256(eth.toUtf8Bytes(JSON.stringify(value)))
}

function canonicalPartyBTask(task: PartyBMigrationTask): CanonicalPartyBTask {
	return {
		partyB: eth.getAddress(task.partyB).toLowerCase(),
		partyAs: deduplicateAddresses(task.partyAs).map(partyA => eth.getAddress(partyA).toLowerCase()),
	}
}

function buildActivePartyBTaskIdentity(task: PartyBMigrationTask, index: number): ActivePartyBTaskIdentity {
	const canonicalTask = canonicalPartyBTask(task)
	return {
		index,
		partyB: eth.getAddress(task.partyB),
		taskHash: canonicalHash({ index, ...canonicalTask }),
	}
}

export function buildMigrationProgressIdentity(
	input: MigrationInput,
	chunkSize: number,
	skipPreCheck: boolean,
	context: MigrationProgressContext,
): MigrationProgressIdentity {
	if (context.forkMode && skipPreCheck) {
		throw new Error("Persisted fork migration requires skipPreCheck=false so every resumed item is revalidated after snapshot rollbacks")
	}
	if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
		throw new Error(`Invalid migration chunkSize: ${chunkSize}`)
	}
	if (typeof context.chainId === "number" && !Number.isSafeInteger(context.chainId)) {
		throw new Error(`Invalid migration progress chainId: ${String(context.chainId)}`)
	}
	let chainId: bigint
	try {
		chainId = BigInt(context.chainId)
	} catch {
		throw new Error(`Invalid migration progress chainId: ${String(context.chainId)}`)
	}
	if (chainId <= 0n) {
		throw new Error(`Invalid migration progress chainId: ${chainId.toString()}`)
	}

	const diamondAddress = eth.getAddress(context.diamondAddress)
	if (diamondAddress === eth.ZeroAddress) {
		throw new Error("Invalid migration progress diamondAddress: zero address")
	}
	if (typeof context.networkName !== "string" || context.networkName.trim().length === 0) {
		throw new Error("Invalid migration progress networkName: expected a non-empty string")
	}
	if (typeof context.forkMode !== "boolean") {
		throw new Error("Invalid migration progress forkMode: expected a boolean")
	}
	if (typeof context.executionDomain !== "string" || context.executionDomain.trim().length === 0) {
		throw new Error("Invalid migration progress executionDomain: expected a non-empty string")
	}
	const migrationImplementation = eth.getAddress(context.migrationImplementation)
	if (migrationImplementation === eth.ZeroAddress) {
		throw new Error("Invalid migration progress migrationImplementation: zero address")
	}
	if (!eth.isHexString(context.migrationCodeHash, 32)) {
		throw new Error("Invalid migration progress migrationCodeHash: expected a bytes32 hash")
	}

	const canonicalTasks = input.partyBTasks.map(canonicalPartyBTask)
	const partyBTaskIdentities = canonicalTasks.map((task, index) => canonicalHash({ index, ...task }))
	const canonicalInput = {
		quoteIds: input.quoteIds.map(quoteId => BigInt(quoteId).toString()),
		partyBTasks: canonicalTasks,
	}

	return {
		chainId: chainId.toString(),
		diamondAddress,
		networkName: context.networkName.trim().toLowerCase(),
		forkMode: context.forkMode,
		executionDomain: context.executionDomain.trim(),
		migrationImplementation,
		migrationCodeHash: context.migrationCodeHash.toLowerCase(),
		migrationInputHash: canonicalHash(canonicalInput),
		chunkSize,
		skipPreCheck,
		partyBTasksHash: canonicalHash(partyBTaskIdentities),
	}
}

function progressError(filePath: string, message: string): Error {
	return new Error(`Migration progress file ${filePath} is invalid: ${message}. Refusing to resume; remove the stale file to restart.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasErrorCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code
}

function requireInteger(value: unknown, field: string, filePath: string, minimum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		throw progressError(filePath, `${field} must be a safe integer >= ${minimum}`)
	}
	return value
}

function requireHash(value: unknown, field: string, filePath: string): string {
	if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
		throw progressError(filePath, `${field} must be a bytes32 hash`)
	}
	return value
}

function requireBoolean(value: unknown, field: string, filePath: string): boolean {
	if (typeof value !== "boolean") throw progressError(filePath, `${field} must be a boolean`)
	return value
}

function validateProgress(value: unknown, filePath: string, expectedIdentity: MigrationProgressIdentity, input: MigrationInput): MigrationProgress {
	if (!isRecord(value)) throw progressError(filePath, "root value must be a JSON object")
	if (value.schemaVersion !== 1) {
		throw progressError(filePath, `unsupported or missing schemaVersion ${String(value.schemaVersion)}`)
	}
	if (!isRecord(value.identity)) throw progressError(filePath, "identity must be a JSON object")

	const identity: MigrationProgressIdentity = {
		chainId: typeof value.identity.chainId === "string" ? value.identity.chainId : "",
		diamondAddress: typeof value.identity.diamondAddress === "string" ? value.identity.diamondAddress : "",
		networkName: typeof value.identity.networkName === "string" ? value.identity.networkName : "",
		forkMode: requireBoolean(value.identity.forkMode, "identity.forkMode", filePath),
		executionDomain: typeof value.identity.executionDomain === "string" ? value.identity.executionDomain : "",
		migrationImplementation: typeof value.identity.migrationImplementation === "string" ? value.identity.migrationImplementation : "",
		migrationCodeHash: requireHash(value.identity.migrationCodeHash, "identity.migrationCodeHash", filePath),
		migrationInputHash: requireHash(value.identity.migrationInputHash, "identity.migrationInputHash", filePath),
		chunkSize: requireInteger(value.identity.chunkSize, "identity.chunkSize", filePath, 1),
		skipPreCheck: requireBoolean(value.identity.skipPreCheck, "identity.skipPreCheck", filePath),
		partyBTasksHash: requireHash(value.identity.partyBTasksHash, "identity.partyBTasksHash", filePath),
	}

	for (const field of [
		"chainId",
		"diamondAddress",
		"networkName",
		"forkMode",
		"executionDomain",
		"migrationImplementation",
		"migrationCodeHash",
		"chunkSize",
		"skipPreCheck",
		"partyBTasksHash",
		"migrationInputHash",
	] as const) {
		if (identity[field] !== expectedIdentity[field]) {
			throw progressError(filePath, `identity.${field} mismatch (saved=${String(identity[field])}, expected=${String(expectedIdentity[field])})`)
		}
	}

	if (typeof value.startedAt !== "string" || value.startedAt.length === 0 || Number.isNaN(Date.parse(value.startedAt))) {
		throw progressError(filePath, "startedAt must be a valid timestamp")
	}
	if (value.phase !== "quotes" && value.phase !== "balances" && value.phase !== "complete") {
		throw progressError(filePath, `invalid phase ${String(value.phase)}`)
	}

	const progress: MigrationProgress = {
		schemaVersion: 1,
		identity,
		startedAt: value.startedAt,
		phase: value.phase,
		quotesProcessed: requireInteger(value.quotesProcessed, "quotesProcessed", filePath, 0),
		partyBsProcessed: requireInteger(value.partyBsProcessed, "partyBsProcessed", filePath, 0),
		partyAsProcessed: requireInteger(value.partyAsProcessed, "partyAsProcessed", filePath, 0),
		lastProcessedQuoteChunk: requireInteger(value.lastProcessedQuoteChunk, "lastProcessedQuoteChunk", filePath, -1),
		lastProcessedPartyB: requireInteger(value.lastProcessedPartyB, "lastProcessedPartyB", filePath, -1),
		lastProcessedPartyAChunk: requireInteger(value.lastProcessedPartyAChunk, "lastProcessedPartyAChunk", filePath, -1),
		activePartyBTask: null,
	}

	const totalQuoteChunks = Math.ceil(input.quoteIds.length / expectedIdentity.chunkSize)
	const totalPartyAs = input.partyBTasks.reduce((sum, task) => sum + deduplicateAddresses(task.partyAs).length, 0)
	if (progress.quotesProcessed > input.quoteIds.length) {
		throw progressError(filePath, `quotesProcessed ${progress.quotesProcessed} exceeds input total ${input.quoteIds.length}`)
	}
	if (progress.partyBsProcessed > input.partyBTasks.length) {
		throw progressError(filePath, `partyBsProcessed ${progress.partyBsProcessed} exceeds input total ${input.partyBTasks.length}`)
	}
	if (progress.partyAsProcessed > totalPartyAs) {
		throw progressError(filePath, `partyAsProcessed ${progress.partyAsProcessed} exceeds canonical input total ${totalPartyAs}`)
	}
	if (progress.lastProcessedQuoteChunk >= totalQuoteChunks && progress.lastProcessedQuoteChunk !== -1) {
		throw progressError(filePath, `lastProcessedQuoteChunk ${progress.lastProcessedQuoteChunk} exceeds the input chunk range`)
	}
	if (progress.lastProcessedPartyB >= input.partyBTasks.length && progress.lastProcessedPartyB !== -1) {
		throw progressError(filePath, `lastProcessedPartyB ${progress.lastProcessedPartyB} exceeds the input task range`)
	}
	if (progress.partyBsProcessed !== progress.lastProcessedPartyB + 1) {
		throw progressError(filePath, "partyBsProcessed must equal lastProcessedPartyB + 1")
	}
	if (progress.phase === "quotes") {
		if (
			progress.partyBsProcessed !== 0 ||
			progress.partyAsProcessed !== 0 ||
			progress.lastProcessedPartyB !== -1 ||
			progress.lastProcessedPartyAChunk !== -1
		) {
			throw progressError(filePath, "quote-phase progress cannot contain processed PartyB state")
		}
	}
	if (progress.phase === "complete" && progress.partyBsProcessed !== input.partyBTasks.length) {
		throw progressError(filePath, "complete progress must include every PartyB task")
	}

	if (value.activePartyBTask !== null) {
		if (!isRecord(value.activePartyBTask)) throw progressError(filePath, "activePartyBTask must be null or a JSON object")
		const activeIndex = requireInteger(value.activePartyBTask.index, "activePartyBTask.index", filePath, 0)
		const activePartyB = typeof value.activePartyBTask.partyB === "string" ? value.activePartyBTask.partyB : ""
		const activeTaskHash = requireHash(value.activePartyBTask.taskHash, "activePartyBTask.taskHash", filePath)
		if (progress.phase !== "balances") throw progressError(filePath, "activePartyBTask is only valid during the balances phase")
		if (activeIndex !== progress.lastProcessedPartyB + 1 || activeIndex >= input.partyBTasks.length) {
			throw progressError(filePath, "activePartyBTask index does not match the next PartyB task")
		}
		const expectedActive = buildActivePartyBTaskIdentity(input.partyBTasks[activeIndex], activeIndex)
		if (activePartyB !== expectedActive.partyB || activeTaskHash !== expectedActive.taskHash) {
			throw progressError(filePath, `activePartyBTask identity mismatch at index ${activeIndex}`)
		}
		progress.activePartyBTask = {
			index: activeIndex,
			partyB: activePartyB,
			taskHash: activeTaskHash,
		}
	}

	if (progress.lastProcessedPartyAChunk >= 0) {
		if (!progress.activePartyBTask) {
			throw progressError(filePath, "partial PartyA chunk progress is missing activePartyBTask identity")
		}
		const task = input.partyBTasks[progress.activePartyBTask.index]
		const partyAChunkCount = Math.ceil(deduplicateAddresses(task.partyAs).length / expectedIdentity.chunkSize)
		if (progress.lastProcessedPartyAChunk >= partyAChunkCount) {
			throw progressError(filePath, `lastProcessedPartyAChunk ${progress.lastProcessedPartyAChunk} exceeds the active task chunk range`)
		}
	}

	if (expectedIdentity.skipPreCheck) {
		if (progress.phase === "quotes") {
			const coveredQuotes = Math.min((progress.lastProcessedQuoteChunk + 1) * expectedIdentity.chunkSize, input.quoteIds.length)
			if (progress.quotesProcessed !== coveredQuotes) {
				throw progressError(filePath, "quotesProcessed does not match lastProcessedQuoteChunk for skipPreCheck resume")
			}
		} else {
			const completedQuoteChunk = totalQuoteChunks - 1
			if (progress.quotesProcessed !== input.quoteIds.length || progress.lastProcessedQuoteChunk !== completedQuoteChunk) {
				throw progressError(filePath, "balance-phase progress does not prove every quote chunk completed")
			}
		}

		let expectedPartyAsProcessed = input.partyBTasks
			.slice(0, progress.partyBsProcessed)
			.reduce((sum, task) => sum + deduplicateAddresses(task.partyAs).length, 0)
		if (progress.activePartyBTask) {
			const activePartyAs = deduplicateAddresses(input.partyBTasks[progress.activePartyBTask.index].partyAs).length
			const coveredActivePartyAs = Math.min((progress.lastProcessedPartyAChunk + 1) * expectedIdentity.chunkSize, activePartyAs)
			expectedPartyAsProcessed += coveredActivePartyAs
		}
		if (progress.partyAsProcessed !== expectedPartyAsProcessed) {
			throw progressError(filePath, "partyAsProcessed does not match completed PartyB task chunks for skipPreCheck resume")
		}
	}

	return progress
}

function loadProgress(filePath: string | null, expectedIdentity: MigrationProgressIdentity | null, input: MigrationInput): MigrationProgress | null {
	if (!filePath) return null
	if (!expectedIdentity) throw new Error("Internal error: persisted migration progress is missing its expected identity")

	let data: string
	try {
		data = fs.readFileSync(filePath, "utf-8")
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return null
		throw progressError(filePath, `could not be read (${formatError(error)})`)
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(data)
	} catch (error) {
		throw progressError(filePath, `contains invalid JSON (${formatError(error)})`)
	}
	return validateProgress(parsed, filePath, expectedIdentity, input)
}

export function validateMigrationProgressFile(
	filePath: string | null | undefined,
	input: MigrationInput,
	chunkSize: number,
	skipPreCheck: boolean,
	context: MigrationProgressContext,
): MigrationProgress | null {
	const normalizedFile = normalizeProgressFile(filePath)
	if (!normalizedFile) return null
	const expectedIdentity = buildMigrationProgressIdentity(input, chunkSize, skipPreCheck, context)
	return loadProgress(normalizedFile, expectedIdentity, input)
}

function saveProgress(
	filePath: string | null,
	progress: MigrationProgress,
	expectedIdentity: MigrationProgressIdentity | null,
	input: MigrationInput,
): void {
	if (!filePath) return
	if (!expectedIdentity) throw new Error("Internal error: persisted migration progress is missing its expected identity")
	validateProgress(progress, filePath, expectedIdentity, input)

	const absolutePath = path.resolve(filePath)
	const directory = path.dirname(absolutePath)
	const temporaryPath = path.join(
		directory,
		`.${path.basename(absolutePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
	)
	let descriptor: number | undefined
	try {
		fs.mkdirSync(directory, { recursive: true })
		descriptor = fs.openSync(temporaryPath, "wx", 0o600)
		fs.writeFileSync(descriptor, `${JSON.stringify(progress, null, 2)}\n`, "utf-8")
		fs.fsyncSync(descriptor)
		fs.closeSync(descriptor)
		descriptor = undefined
		fs.renameSync(temporaryPath, absolutePath)

		const directoryDescriptor = fs.openSync(directory, "r")
		try {
			fs.fsyncSync(directoryDescriptor)
		} finally {
			fs.closeSync(directoryDescriptor)
		}
	} catch (error) {
		if (descriptor !== undefined) {
			try {
				fs.closeSync(descriptor)
			} catch {
				// Preserve the original persistence error.
			}
		}
		try {
			if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
		} catch {
			// Preserve the original persistence error.
		}
		throw new Error(`Failed to atomically save migration progress file ${filePath}: ${formatError(error)}`)
	}
}

function deleteProgress(filePath: string): void {
	try {
		fs.unlinkSync(filePath)
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return
		throw new Error(`Failed to delete completed migration progress file ${filePath}: ${formatError(error)}`)
	}
}

// =============================================================================
// Utility Functions
// =============================================================================

function chunkArray<T>(array: T[], size: number): T[][] {
	const chunks: T[][] = []
	for (let i = 0; i < array.length; i += size) {
		chunks.push(array.slice(i, i + size))
	}
	return chunks
}

function deduplicateAddresses(addresses: string[]): string[] {
	const seen = new Set<string>()
	const unique: string[] = []

	for (const address of addresses) {
		const normalized = address.toLowerCase()

		// Skip zero address
		if (normalized === eth.ZeroAddress.toLowerCase()) {
			continue
		}

		if (!seen.has(normalized)) {
			seen.add(normalized)
			unique.push(address)
		}
	}

	return unique
}

function formatAddress(address: string): string {
	return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		// Check for common ethers.js error properties
		const ethersError = error as any

		if (ethersError.reason) {
			return ethersError.reason
		}

		if (ethersError.shortMessage) {
			return ethersError.shortMessage
		}

		if (ethersError.error?.message) {
			return ethersError.error.message
		}

		return error.message
	}

	return String(error)
}

function isMinedTransactionRevert(error: unknown): boolean {
	const ethersError = error as { receipt?: { status?: number | string } } | undefined
	const status = ethersError?.receipt?.status
	return status === 0 || status === "0x0"
}

function transactionHashFromError(error: unknown): string | undefined {
	const ethersError = error as { receipt?: { hash?: string; transactionHash?: string }; transaction?: { hash?: string } } | undefined
	return ethersError?.receipt?.hash ?? ethersError?.receipt?.transactionHash ?? ethersError?.transaction?.hash
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
	return `${(ms / 60000).toFixed(1)}m`
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

// =============================================================================
// Logging
// =============================================================================

type LogLevel = "info" | "success" | "warn" | "error"

const LOG_COLORS = {
	info: "\x1b[0m",
	success: "\x1b[32m",
	warn: "\x1b[33m",
	error: "\x1b[31m",
	reset: "\x1b[0m",
} as const

function log(level: LogLevel, message: string): void {
	const timestamp = new Date().toISOString().split("T")[1].split(".")[0]
	const color = LOG_COLORS[level]
	const reset = LOG_COLORS.reset
	console.log(`${color}[${timestamp}] ${message}${reset}`)
}

function logHeader(title: string): void {
	console.log("\n" + "=".repeat(70))
	console.log(` ${title}`)
	console.log("=".repeat(70))
}

function printReport(report: MigrationReport): void {
	logHeader("MIGRATION REPORT")

	console.log(`
Started:    ${report.startedAt}
Finished:   ${report.finishedAt}
Duration:   ${formatDuration(report.totalDuration)}

Quotes:
  Total:    ${report.quotesTotal}
  Migrated: ${report.quotesMigrated}

PartyBs:
  Total:    ${report.partyBsTotal}
  Migrated: ${report.partyBsMigrated}

PartyAs:
  Total:    ${report.partyAsTotal}
  Migrated: ${report.partyAsMigrated}

Operations:
  Total:    ${report.operations.length}
  Success:  ${report.operations.filter(o => o.success).length}
  Failed:   ${report.operations.filter(o => !o.success).length}
`)

	if (report.status === "failed") {
		const failedOps = report.operations.filter(o => !o.success)
		if (failedOps.length > 0) {
			console.log("Failed Operations:")
			for (const op of failedOps) {
				console.log(`  - ${op.operation}: ${op.error}`)
			}
			console.log("")
		}
		console.log(`Status: ❌ FAILED`)
	} else {
		console.log(`Status: ✅ SUCCESS`)
	}
	console.log("=".repeat(70))
}

// =============================================================================
// Exports for Testing
// =============================================================================

export const _internal = {
	chunkArray,
	deduplicateAddresses,
	formatAddress,
	formatError,
	formatDuration,
}
