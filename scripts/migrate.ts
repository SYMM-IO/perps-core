import { ethers as eth } from "ethers"
import * as fs from "fs"

import { MigrationFacet } from "../src/types/index.js"

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
	strict: false,
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
	/** Throw error if any operation fails */
	strict?: boolean
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

export interface MigrationProgress {
	startedAt: string
	phase: "quotes" | "balances" | "complete"
	quotesProcessed: number
	partyBsProcessed: number
	lastProcessedQuoteChunk: number
	lastProcessedPartyB: number
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
	operations: OperationResult[]
	status: "success" | "partial_failure" | "failed"
}

// =============================================================================
// Main Migration Function
// =============================================================================

export async function migrate(migrationFacet: MigrationFacet, input: MigrationInput, config: MigrationConfig = {}): Promise<MigrationReport> {
	const cfg = { ...DEFAULT_CONFIG, ...config }
	const startTime = Date.now()
	const startedAt = new Date().toISOString()

	const operations: OperationResult[] = []
	let quotesMigrated = 0
	let partyBsMigrated = 0

	// Load progress if resuming
	let progress = loadProgress(cfg.progressFile)
	if (progress) {
		log("info", `Resuming migration from ${progress.phase} phase`)
		log("info", `  Quotes processed: ${progress.quotesProcessed}`)
		log("info", `  PartyBs processed: ${progress.partyBsProcessed}`)
	} else {
		progress = {
			startedAt,
			phase: "quotes",
			quotesProcessed: 0,
			partyBsProcessed: 0,
			lastProcessedQuoteChunk: -1,
			lastProcessedPartyB: -1,
		}
	}

	logHeader("SYMMIO V0.8.5 Migration")
	log("info", `Started at: ${startedAt}`)
	log("info", `Configuration:`)
	log("info", `  Chunk size: ${cfg.chunkSize}`)
	log("info", `  Max retries: ${cfg.maxRetries}`)
	log("info", `  Confirmations: ${cfg.confirmations}`)
	log("info", `  Dry run: ${cfg.dryRun ?? false}`)
	log("info", ``)
	log("info", `Input:`)
	log("info", `  Quotes to migrate: ${input.quoteIds.length}`)
	log("info", `  PartyBs to migrate: ${input.partyBTasks.length}`)

	// =========================================================================
	// Phase 1: Migrate Quotes (Aggregated Positions)
	// =========================================================================

	if (progress.phase === "quotes" || progress.phase === "balances") {
		if (progress.phase === "quotes") {
			logHeader("Phase 1: Migrating Quotes")

			const quoteChunks = chunkArray(input.quoteIds, cfg.chunkSize)
			const startChunk = progress.lastProcessedQuoteChunk + 1

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
				} else if (cfg.strict) {
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
			log("info", `  PartyAs to process: ${partyAs.length}`)

			// Check if already migrated
			if (!cfg.dryRun) {
				const alreadyMigrated = await migrationFacet.isPartyBLockedValuesMigrated(partyB)
				if (alreadyMigrated) {
					log("warn", `  Already migrated, skipping`)
					partyBsMigrated++
					progress.partyBsProcessed++
					progress.lastProcessedPartyB = i
					saveProgress(cfg.progressFile, progress)
					continue
				}
			}

			const operation = `Migrate balances for ${formatAddress(partyB)}`

			const result = await executeOperation(
				operation,
				async () => {
					if (cfg.dryRun) {
						log("info", `  [DRY RUN] Would migrate ${partyAs.length} partyA balances`)
						return null
					}
					return migrationFacet.migrateCrossLockedValues(partyB, partyAs)
				},
				cfg,
			)

			operations.push(result)

			if (result.success) {
				partyBsMigrated++
				progress.partyBsProcessed++
				progress.lastProcessedPartyB = i
				saveProgress(cfg.progressFile, progress)
			} else if (cfg.strict) {
				throw new Error(`Migration failed at ${operation}: ${result.error}`)
			}
		}

		progress.phase = "complete"
		saveProgress(cfg.progressFile, progress)
	}

	// =========================================================================
	// Generate Report
	// =========================================================================

	const finishedAt = new Date().toISOString()
	const totalDuration = Date.now() - startTime

	const successCount = operations.filter(o => o.success).length
	const failureCount = operations.filter(o => !o.success).length

	let status: MigrationReport["status"]
	if (failureCount === 0) {
		status = "success"
	} else if (successCount > 0) {
		status = "partial_failure"
	} else {
		status = "failed"
	}

	const report: MigrationReport = {
		startedAt,
		finishedAt,
		totalDuration,
		quotesTotal: input.quoteIds.length,
		quotesMigrated,
		partyBsTotal: input.partyBTasks.length,
		partyBsMigrated,
		operations,
		status,
	}

	printReport(report)

	// Clean up progress file on success
	if (status === "success" && cfg.progressFile) {
		deleteProgress(cfg.progressFile)
	}

	if (cfg.strict && status !== "success") {
		throw new Error(`Migration completed with status: ${status}`)
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

Operations:
  Total:    ${report.operations.length}
  Success:  ${report.operations.filter(o => o.success).length}
  Failed:   ${report.operations.filter(o => !o.success).length}
`)

	if (report.operations.some(o => !o.success)) {
		console.log("Failed Operations:")
		for (const op of report.operations.filter(o => !o.success)) {
			console.log(`  - ${op.operation}: ${op.error}`)
		}
		console.log("")
	}

	const statusIcon = {
		success: "✅",
		partial_failure: "⚠️",
		failed: "❌",
	}[report.status]

	console.log(`Status: ${statusIcon} ${report.status.toUpperCase()}`)
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
