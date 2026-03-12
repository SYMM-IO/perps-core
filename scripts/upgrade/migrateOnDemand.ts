import fs from "fs"
import path from "path"

import { ethers } from "../../test/helpers/hardhat-connection.js"
import { migrate, MigrationConfig, MigrationInput, MigrationReport } from "./migrate.js"
import { getImpersonatedAdmin } from "./utils/forkHelpers.js"

export type PartyBTask = { partyB: string; partyAs: string[] }

type ScriptStep = {
	name: string
	status: "ok" | "error"
	details?: Record<string, unknown>
}

type MigrationOnDemandReport = {
	status: "running" | "success" | "failed"
	startedAt: string
	finishedAt?: string
	durationMs?: number
	diamondAddress?: string
	adminAddress?: string
	migrationInputFile?: string
	outputDir?: string
	progressFile?: string
	reportFile?: string
	config?: Record<string, unknown>
	input?: {
		quoteIdsTotal: number
		partyBTasksTotal: number
		aggregateKeys: number
	}
	migrationReport?: MigrationReport
	verification?: {
		performed: boolean
		quoteChecks: number
		partyBChecks: number
		aggregateChecks: number
	}
	steps: ScriptStep[]
	error?: string
}

/**
 * Migration script for v0.8.5.
 *
 * Takes a validated migration input file (from prepareMigrationInput.ts)
 * and runs the migration + verification. Assumes:
 * - System is already paused (by multisig or fork upgrade script)
 * - Upgrade (diamondCut) is already applied
 * - Caller has MIGRATION_ROLE granted
 *
 * Run:
 *   DIAMOND_ADDRESS=0x... MIGRATION_INPUT_FILE=./scripts/upgrade/output/migration-input.json \
 *     npx hardhat run ./scripts/upgrade/migrateOnDemand.ts --network localhost
 *
 * Config:
 *   cp scripts/upgrade/config/migrate.sample.json scripts/upgrade/config/migrate.json
 *
 * Resume:
 *   Re-run the command; migration progress is stored in the progress file.
 */
type MigrationConfigFile = {
	diamondAddress?: string
	migrationInputFile?: string
	chunkSize?: number
	dryRun?: boolean
	progressFile?: string
	reportFile?: string
	outputDir?: string
	strict?: boolean
}

const MIGRATION_CONFIG_FILE = process.env.MIGRATION_CONFIG_FILE ?? "./scripts/upgrade/config/migrate.json"

function loadMigrationConfigFile(): MigrationConfigFile {
	const configPath = MIGRATION_CONFIG_FILE
	if (!fs.existsSync(configPath)) return {}
	let raw: string
	try {
		raw = fs.readFileSync(configPath, "utf-8")
	} catch (error) {
		throw new Error(`Failed to read migration config file: ${configPath}. ${String(error)}`)
	}
	try {
		const data = JSON.parse(raw)
		if (!data || typeof data !== "object") {
			throw new Error("Config must be a JSON object.")
		}
		return data as MigrationConfigFile
	} catch (error) {
		throw new Error(`Invalid migration config JSON: ${configPath}. ${String(error)}`)
	}
}

function parseBool(value: string | boolean | undefined, fallback: boolean): boolean {
	if (value === undefined || value === null || value === "") return fallback
	if (typeof value === "boolean") return value
	const normalized = value.toLowerCase()
	if (normalized === "true" || normalized === "1") return true
	if (normalized === "false" || normalized === "0") return false
	throw new Error(`Invalid boolean value: ${value}`)
}

function formatError(error: unknown): string {
	if (error instanceof Error && error.stack) return error.stack
	if (error instanceof Error && error.message) return error.message
	return String(error)
}

function ensureParentDir(filePath: string): void {
	const dir = path.dirname(filePath)
	if (dir && dir !== "." && !fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true })
	}
}

function writeJson(filePath: string, value: unknown): void {
	if (!filePath) return
	ensureParentDir(filePath)
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function tryWriteReport(filePath: string, report: MigrationOnDemandReport): void {
	try {
		writeJson(filePath, report)
	} catch (error) {
		console.error(`Failed to write migration report file: ${filePath}. ${formatError(error)}`)
	}
}

function toBigInt(value: unknown): bigint {
	if (typeof value === "bigint") return value
	if (typeof value === "number") return BigInt(value)
	if (typeof value === "string") return BigInt(value)
	return BigInt((value as any).toString())
}

function loadMigrationInput(filePath: string): {
	input: MigrationInput
	expectedAggregates: Map<string, { long: bigint; short: bigint }> | null
} {
	let raw: string
	try {
		raw = fs.readFileSync(filePath, "utf-8")
	} catch (error) {
		throw new Error(`Failed to read migration input file: ${filePath}. ${String(error)}`)
	}
	let data: any
	try {
		data = JSON.parse(raw)
	} catch (error) {
		throw new Error(`Invalid migration input JSON: ${filePath}. ${String(error)}`)
	}
	if (!data || typeof data !== "object") {
		throw new Error("Migration input must be a JSON object.")
	}
	if (data.quoteIds && !Array.isArray(data.quoteIds)) {
		throw new Error("Migration input quoteIds must be an array.")
	}
	if (data.partyBTasks && !Array.isArray(data.partyBTasks)) {
		throw new Error("Migration input partyBTasks must be an array.")
	}

	const quoteIds = (data.quoteIds ?? []).map((id: string | number, index: number) => {
		try {
			return BigInt(id)
		} catch {
			throw new Error(`Invalid quoteId at index ${index}: ${String(id)}`)
		}
	})

	const partyBTasks = (data.partyBTasks ?? []).map((task: PartyBTask, index: number) => {
		if (!task || typeof task !== "object") {
			throw new Error(`Invalid partyBTasks entry at index ${index}`)
		}
		if (!task.partyB || typeof task.partyB !== "string") {
			throw new Error(`partyBTasks[${index}].partyB is required`)
		}
		if (!ethers.isAddress(task.partyB) || task.partyB === ethers.ZeroAddress) {
			throw new Error(`partyBTasks[${index}].partyB is invalid: ${task.partyB}`)
		}
		if (task.partyAs && !Array.isArray(task.partyAs)) {
			throw new Error(`partyBTasks[${index}].partyAs must be an array`)
		}
		for (const partyA of task.partyAs ?? []) {
			if (!ethers.isAddress(partyA) || partyA === ethers.ZeroAddress) {
				throw new Error(`partyBTasks[${index}].partyAs contains invalid address: ${partyA}`)
			}
		}
		return {
			partyB: task.partyB,
			partyAs: (task.partyAs ?? []).slice().sort(),
		}
	})

	// Load expectedAggregates if present in the input file
	let expectedAggregates: Map<string, { long: bigint; short: bigint }> | null = null
	if (data.expectedAggregates && typeof data.expectedAggregates === "object") {
		expectedAggregates = new Map()
		for (const [key, value] of Object.entries(data.expectedAggregates as Record<string, { long: string; short: string }>)) {
			expectedAggregates.set(key, {
				long: BigInt(value.long),
				short: BigInt(value.short),
			})
		}
	}

	return {
		input: {
			quoteIds: quoteIds.sort((a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0)),
			partyBTasks: partyBTasks.sort((a: PartyBTask, b: PartyBTask) => a.partyB.localeCompare(b.partyB)),
		},
		expectedAggregates,
	}
}

export async function verifyMigration(
	migrationFacet: any,
	viewFacet: any,
	viewFacetAggregate: any,
	openQuoteIds: bigint[],
	partyBTasks: PartyBTask[],
	expectedAggregates: Map<string, { long: bigint; short: bigint }> | null,
): Promise<void> {
	for (const quoteId of openQuoteIds) {
		const migrated = await migrationFacet.isQuoteMigrated(quoteId)
		if (!migrated) {
			throw new Error(`Quote ${quoteId.toString()} not migrated`)
		}
	}

	for (const task of partyBTasks) {
		const migrated = await migrationFacet.isPartyBLockedValuesMigrated(task.partyB)
		if (!migrated) {
			throw new Error(`PartyB ${task.partyB} not migrated`)
		}

		let expectedAllocated = 0n
		for (const partyA of task.partyAs) {
			expectedAllocated += toBigInt(await viewFacet.allocatedBalanceOfPartyB(task.partyB, partyA))
		}
		const masterBalance = toBigInt(await viewFacet.balanceOfCrossPartyB(task.partyB))
		if (expectedAllocated !== masterBalance) {
			throw new Error(`PartyB ${task.partyB} master balance mismatch: expected=${expectedAllocated.toString()} got=${masterBalance.toString()}`)
		}
	}

	if (!expectedAggregates) return

	for (const [key, expected] of expectedAggregates.entries()) {
		const [partyB, partyA, symbolIdRaw] = key.split("-")
		const symbolId = BigInt(symbolIdRaw)
		const [longPos, shortPos] = await viewFacetAggregate.getPartyBAggregatedPositionBySymbolPerPartyA(partyB, partyA, symbolId)

		const longAmount = toBigInt(longPos.aggregatedOpenAmount)
		const shortAmount = toBigInt(shortPos.aggregatedOpenAmount)

		if (longAmount !== expected.long) {
			throw new Error(
				`Aggregated LONG mismatch for ${partyB}/${partyA}/symbol ${symbolIdRaw}: expected=${expected.long.toString()} got=${longAmount.toString()}`,
			)
		}

		if (shortAmount !== expected.short) {
			throw new Error(
				`Aggregated SHORT mismatch for ${partyB}/${partyA}/symbol ${symbolIdRaw}: expected=${expected.short.toString()} got=${shortAmount.toString()}`,
			)
		}
	}
}

const configFile = loadMigrationConfigFile()
if (configFile.progressFile && typeof configFile.progressFile !== "string") {
	throw new Error("progressFile must be a string path.")
}
if (configFile.reportFile && typeof configFile.reportFile !== "string") {
	throw new Error("reportFile must be a string path.")
}
if (configFile.outputDir && typeof configFile.outputDir !== "string") {
	throw new Error("outputDir must be a string path.")
}

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? configFile.diamondAddress
const MIGRATION_INPUT_FILE = process.env.MIGRATION_INPUT_FILE ?? configFile.migrationInputFile

const DEFAULT_OUTPUT_DIR = "./scripts/upgrade/output"
const outputDir = process.env.MIGRATION_OUTPUT_DIR ?? configFile.outputDir ?? DEFAULT_OUTPUT_DIR
const DEFAULT_PROGRESS_FILE = `${outputDir}/migration-progress.json`
let migrateProgressFile = process.env.MIGRATE_PROGRESS_FILE ?? configFile.progressFile ?? DEFAULT_PROGRESS_FILE
const DEFAULT_REPORT_FILE = `${outputDir}/migrateOnDemand-report.json`
let migrateReportFile = process.env.MIGRATE_REPORT_FILE ?? configFile.reportFile ?? DEFAULT_REPORT_FILE

if (path.resolve(migrateProgressFile) === path.resolve(MIGRATION_CONFIG_FILE)) {
	console.warn("migrateProgressFile matches migration config file; falling back to default progress file.")
	migrateProgressFile = DEFAULT_PROGRESS_FILE
}
if (path.resolve(migrateReportFile) === path.resolve(MIGRATION_CONFIG_FILE)) {
	console.warn("migrateReportFile matches migration config file; falling back to default report file.")
	migrateReportFile = DEFAULT_REPORT_FILE
}
if (path.resolve(migrateReportFile) === path.resolve(migrateProgressFile)) {
	console.warn("migrateReportFile matches progress file; falling back to default report file.")
	migrateReportFile = DEFAULT_REPORT_FILE
}

const MIGRATION_CONFIG: MigrationConfig = {
	chunkSize: Number(process.env.MIGRATE_CHUNK_SIZE ?? configFile.chunkSize ?? "50"),
	dryRun: parseBool(process.env.DRY_RUN, configFile.dryRun ?? false),
	progressFile: migrateProgressFile,
	strict: parseBool(process.env.MIGRATE_STRICT, configFile.strict ?? false),
}

async function main() {
	const startedAtMs = Date.now()
	const report: MigrationOnDemandReport = {
		status: "running",
		startedAt: new Date(startedAtMs).toISOString(),
		migrationInputFile: MIGRATION_INPUT_FILE,
		outputDir,
		progressFile: migrateProgressFile,
		reportFile: migrateReportFile,
		config: {
			chunkSize: MIGRATION_CONFIG.chunkSize,
			dryRun: MIGRATION_CONFIG.dryRun,
			strict: MIGRATION_CONFIG.strict,
		},
		steps: [],
	}
	tryWriteReport(migrateReportFile, report)
	let currentStep: string | null = null

	try {
		// Validate inputs
		currentStep = "validate_inputs"
		if (!DIAMOND_ADDRESS) {
			throw new Error("DIAMOND_ADDRESS is required.")
		}
		if (!ethers.isAddress(DIAMOND_ADDRESS) || DIAMOND_ADDRESS === ethers.ZeroAddress) {
			throw new Error(`Invalid DIAMOND_ADDRESS: ${DIAMOND_ADDRESS}`)
		}
		if (!MIGRATION_INPUT_FILE) {
			throw new Error("MIGRATION_INPUT_FILE is required. Run prepareMigrationInput.ts first.")
		}
		if (!fs.existsSync(MIGRATION_INPUT_FILE)) {
			throw new Error(`Migration input file not found: ${MIGRATION_INPUT_FILE}`)
		}
		if (!Number.isInteger(MIGRATION_CONFIG.chunkSize) || (MIGRATION_CONFIG.chunkSize ?? 0) <= 0) {
			throw new Error(`Invalid chunkSize: ${MIGRATION_CONFIG.chunkSize}`)
		}
		report.diamondAddress = DIAMOND_ADDRESS
		report.steps.push({
			name: "validate_inputs",
			status: "ok",
			details: {
				diamondAddress: DIAMOND_ADDRESS,
				migrationInputFile: MIGRATION_INPUT_FILE,
			},
		})
		currentStep = null
		tryWriteReport(migrateReportFile, report)

		// Resolve signer — fork: impersonate diamond owner, production: use deployer (must have MIGRATION_ROLE)
		currentStep = "resolve_signer"
		const chainId = (await ethers.provider.getNetwork()).chainId
		const isFork = chainId === 31337n || chainId === 1337n
		let admin
		if (isFork) {
			admin = await getImpersonatedAdmin(DIAMOND_ADDRESS)
		} else {
			const signers = await ethers.getSigners()
			admin = signers[0]
		}
		const adminAddress = await admin.getAddress()
		report.adminAddress = adminAddress
		report.steps.push({
			name: "resolve_signer",
			status: "ok",
			details: { adminAddress },
		})
		currentStep = null
		tryWriteReport(migrateReportFile, report)

		console.log(`Diamond: ${DIAMOND_ADDRESS}`)
		console.log(`Admin:   ${adminAddress}`)
		console.log(`Input:   ${MIGRATION_INPUT_FILE}`)
		console.log(`Progress file: ${migrateProgressFile}`)
		console.log(`Report file: ${migrateReportFile}`)

		// Connect facets
		currentStep = "connect_facets"
		const migrationFacet = await ethers.getContractAt("contracts/core/facets/Migration/MigrationFacet.sol:MigrationFacet", DIAMOND_ADDRESS, admin)
		const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", DIAMOND_ADDRESS, admin)
		const viewFacetAggregate = await ethers.getContractAt(
			"contracts/core/facets/ViewFacetAggregate/ViewFacetAggregate.sol:ViewFacetAggregate",
			DIAMOND_ADDRESS,
			admin,
		)
		report.steps.push({ name: "connect_facets", status: "ok" })
		currentStep = null
		tryWriteReport(migrateReportFile, report)

		// Load validated input
		currentStep = "load_input"
		const { input, expectedAggregates } = loadMigrationInput(MIGRATION_INPUT_FILE)
		report.input = {
			quoteIdsTotal: input.quoteIds.length,
			partyBTasksTotal: input.partyBTasks.length,
			aggregateKeys: expectedAggregates?.size ?? 0,
		}
		report.steps.push({
			name: "load_input",
			status: "ok",
			details: {
				quoteIds: input.quoteIds.length,
				partyBTasks: input.partyBTasks.length,
				aggregateKeys: expectedAggregates?.size ?? 0,
			},
		})
		currentStep = null
		tryWriteReport(migrateReportFile, report)

		// Run migration
		if (input.quoteIds.length === 0 && input.partyBTasks.length === 0) {
			console.log("No migration tasks to run.")
			report.steps.push({ name: "migrate", status: "ok", details: { skipped: true } })
			tryWriteReport(migrateReportFile, report)
		} else {
			currentStep = "migrate"
			console.log(`Migrating ${input.quoteIds.length} quotes for ${input.partyBTasks.length} partyBs...`)
			const migrationReport = await migrate(migrationFacet, input, MIGRATION_CONFIG)
			report.migrationReport = migrationReport
			report.steps.push({
				name: "migrate",
				status: "ok",
				details: {
					status: migrationReport.status,
					quotesMigrated: migrationReport.quotesMigrated,
					partyBsMigrated: migrationReport.partyBsMigrated,
					operations: migrationReport.operations.length,
				},
			})
			currentStep = null
			tryWriteReport(migrateReportFile, report)
		}

		// Verify migration
		if (input.quoteIds.length > 0 || input.partyBTasks.length > 0) {
			currentStep = "verify_migration"
			console.log("Verifying migration results...")
			await verifyMigration(migrationFacet, viewFacet, viewFacetAggregate, input.quoteIds, input.partyBTasks, expectedAggregates)
			report.verification = {
				performed: true,
				quoteChecks: input.quoteIds.length,
				partyBChecks: input.partyBTasks.length,
				aggregateChecks: expectedAggregates?.size ?? 0,
			}
			report.steps.push({
				name: "verify_migration",
				status: "ok",
				details: report.verification,
			})
			currentStep = null
			tryWriteReport(migrateReportFile, report)
		} else {
			report.verification = {
				performed: false,
				quoteChecks: 0,
				partyBChecks: 0,
				aggregateChecks: 0,
			}
		}

		console.log("Migration completed successfully.")
		report.status = "success"
	} catch (error) {
		if (currentStep) {
			report.steps.push({
				name: currentStep,
				status: "error",
				details: { error: formatError(error) },
			})
			currentStep = null
		}
		report.status = "failed"
		report.error = formatError(error)
		tryWriteReport(migrateReportFile, report)
		throw error
	} finally {
		report.finishedAt = new Date().toISOString()
		report.durationMs = Date.now() - startedAtMs
		tryWriteReport(migrateReportFile, report)
	}
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
