import { ethers as eth } from "ethers"
import * as fs from "fs"

import { MigrationFacet } from "../../src/types/index.js"
import { quoteRequiresMigration } from "./utils/migrationQuoteRules.js"

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_CONFIG: Required<MigrationConfig> = {
	chunkSize: 50,
	maxRetries: 3,
	retryDelayMs: 2000,
	retryBackoffMultiplier: 2,
	confirmations: 1,
	progressFile: "./migration-progress.json",
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

export type MigrationQuoteView = {
	getQuote(quoteId: bigint): Promise<{ quoteStatus: bigint; partyA: string; quantity?: bigint; closedAmount?: bigint }>
}

export interface MigrationProgress {
	startedAt: string
	phase: "quotes" | "balances" | "complete"
	quotesProcessed: number
	partyBsProcessed: number
	partyAsProcessed: number
	lastProcessedQuoteChunk: number
	lastProcessedPartyB: number
	lastProcessedPartyAChunk: number
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

// =============================================================================
// Main Migration Function
// =============================================================================

export async function migrate(
	migrationFacet: MigrationFacet,
	viewFacetQuote: MigrationQuoteView,
	input: MigrationInput,
	config: MigrationConfig = {},
): Promise<MigrationReport> {
	const cfg = { ...DEFAULT_CONFIG, ...config }
	const startTime = Date.now()
	const startedAt = new Date().toISOString()

	const operations: OperationResult[] = []
	let partyAsTotal = 0

	// Load progress if resuming
	let progress = loadProgress(cfg.progressFile)
	let quotesMigrated = progress?.quotesProcessed ?? 0
	let partyBsMigrated = progress?.partyBsProcessed ?? 0
	let partyAsMigrated = progress?.partyAsProcessed ?? 0

	const isResuming = !!progress
	if (!progress) {
		progress = {
			startedAt,
			phase: "quotes",
			quotesProcessed: 0,
			partyBsProcessed: 0,
			partyAsProcessed: 0,
			lastProcessedQuoteChunk: -1,
			lastProcessedPartyB: -1,
			lastProcessedPartyAChunk: -1,
		}
	}

	const totalPartyAs = input.partyBTasks.reduce((sum, t) => sum + t.partyAs.length, 0)
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
					// Filter out already-migrated and contract-skipped quotes to avoid no-op transactions.
					// MigrationFacetImpl marks pending/locked quotes and active positions with openAmount > 0.
					const pending: bigint[] = []
					let alreadyMigrated = 0
					let skippedByContract = 0
					for (const quoteId of input.quoteIds) {
						const migrated: boolean = await migrationFacet.isQuoteMigrated(quoteId)
						if (migrated) {
							alreadyMigrated++
						} else {
							const quote = await viewFacetQuote.getQuote(quoteId)
							if (quoteRequiresMigration(quote)) {
								pending.push(quoteId)
							} else {
								skippedByContract++
							}
						}
					}
					log("info", `  ${alreadyMigrated} already migrated, ${skippedByContract} skipped by contract, ${pending.length} remaining`)
					quotesToMigrate = pending
				}

				const quoteChunks = chunkArray(quotesToMigrate, cfg.chunkSize)
				const startChunk = cfg.skipPreCheck ? progress.lastProcessedQuoteChunk + 1 : 0

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
							return migrationFacet.migrateQuotes(chunk)
						},
						cfg,
					)

					operations.push(result)

					if (result.success) {
						quotesMigrated += chunk.length
						progress.quotesProcessed += chunk.length
						progress.lastProcessedQuoteChunk = i
						saveProgress(cfg.progressFile, progress)
					} else {
						throw new Error(`Migration failed at ${operation}: ${result.error}`)
					}
				}

				progress.phase = "balances"
				saveProgress(cfg.progressFile, progress)
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

				log("info", `\nProcessing PartyB ${i + 1}/${input.partyBTasks.length}: ${formatAddress(partyB)}`)
				partyAsTotal += partyAs.length

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
						saveProgress(cfg.progressFile, progress)
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
							return migrationFacet.migrateCrossLockedValues(partyB, partyAChunk)
						},
						cfg,
					)

					operations.push(result)

					if (result.success) {
						partyAsMigrated += partyAChunk.length
						progress.partyAsProcessed = partyAsMigrated
						progress.lastProcessedPartyAChunk = j
						saveProgress(cfg.progressFile, progress)
					} else {
						throw new Error(`Migration failed at ${operation}: ${result.error}`)
					}
				}

				partyBsMigrated++
				progress.partyBsProcessed = partyBsMigrated
				progress.lastProcessedPartyB = i
				progress.lastProcessedPartyAChunk = -1
				saveProgress(cfg.progressFile, progress)
			}

			progress.phase = "complete"
			saveProgress(cfg.progressFile, progress)
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
		partyAsTotal,
		partyAsMigrated,
		operations,
		status,
	}

	printReport(report)

	if (migrationError) {
		throw migrationError
	}

	// Clean up progress file on success
	if (cfg.progressFile) {
		deleteProgress(cfg.progressFile)
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

function loadProgress(filePath: string | null | undefined): MigrationProgress | null {
	if (!filePath) return null

	try {
		if (fs.existsSync(filePath)) {
			const data = fs.readFileSync(filePath, "utf-8")
			return JSON.parse(data) as MigrationProgress
		}
	} catch (error) {
		log("warn", `Could not load progress file: ${formatError(error)}`)
	}

	return null
}

function saveProgress(filePath: string | null | undefined, progress: MigrationProgress): void {
	if (!filePath) return

	try {
		fs.writeFileSync(filePath, JSON.stringify(progress, null, 2))
	} catch (error) {
		log("warn", `Could not save progress file: ${formatError(error)}`)
	}
}

function deleteProgress(filePath: string): void {
	try {
		if (fs.existsSync(filePath)) {
			fs.unlinkSync(filePath)
		}
	} catch (error) {
		log("warn", `Could not delete progress file: ${formatError(error)}`)
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
