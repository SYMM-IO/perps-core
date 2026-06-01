import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import type { MigrationConfig, MigrationInput, MigrationReport } from "./migrate.js"
import { migrate } from "./migrate.js"
import type { DeployedFacetsSummary } from "./utils/deployedFacets.js"
import { loadDeployedFacetsForNetwork, verifyMigrationSurfaceOnDiamond } from "./utils/deployedFacets.js"
import { getImpersonatedAdmin, impersonateAndFund } from "./utils/forkHelpers.js"
import { resolveConfiguredSigner } from "./utils/hardwareSigner.js"
import { log } from "./utils/log.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { baseNetworkName, loadUpgradeConfigShared, resolveConfigFile } from "./utils/sharedConfig.js"
import { createStepReporter } from "./utils/stepReporter.js"

// Base chain name (fork-base -> base) so progress/report/input files don't collide
// when the same workspace is used for multiple chains.
const NETWORK_SUFFIX = baseNetworkName(connection.networkName)
const withSuffix = (baseName: string): string => (NETWORK_SUFFIX ? `${baseName}-${NETWORK_SUFFIX}.json` : `${baseName}.json`)

export type PartyBTask = { partyB: string; partyAs: string[] }

type ScriptStep = {
	name: string
	status: "ok" | "error"
	startedAt?: string
	finishedAt?: string
	durationMs?: number
	details?: Record<string, unknown>
}

type MigrationOnDemandReport = {
	status: "running" | "success" | "failed"
	startedAt: string
	finishedAt?: string
	durationMs?: number
	diamondAddress?: string
	protocolAdmin?: string
	migrationInputFile?: string
	outputDir?: string
	progressFile?: string
	reportFile?: string
	deployedFacetsFile?: string
	config?: Record<string, unknown>
	deployedFacets?: DeployedFacetsSummary
	input?: {
		quoteIdsTotal: number
		partyBTasksTotal: number
		aggregateKeys: number
	}
	migrationReport?: MigrationReport
	roleChecks?: {
		migrationRole: {
			address: string
			roleHash: string
			hasRole: boolean
		}
	}
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
 *   DIAMOND_ADDRESS=0x... npx hardhat run ./scripts/upgrade/runMigration.ts --network <network>
 *
 * Defaults to scripts/upgrade/output/migration-input-{network}.json (network suffix
 * derived from --network with "fork-" stripped, or from NETWORK_ALIAS env var).
 * Override with MIGRATION_INPUT_FILE=... if needed.
 *
 * Config:
 *   cp scripts/upgrade/config/samples/migrate.sample.json scripts/upgrade/config/migrate.json
 *
 * Resume:
 *   Re-run the command; migration progress is stored in the progress file.
 */
type MigrationConfigFile = {
	diamondAddress?: string
	migrationInputFile?: string
	chunkSize?: number
	dryRun?: boolean
	fork?: boolean
	skipPreCheck?: boolean
	progressFile?: string
	reportFile?: string
	outputDir?: string
	deployedFacetsFile?: string
}

const MIGRATION_CONFIG_FILE = resolveConfigFile("migrate", NETWORK_SUFFIX, process.env.MIGRATION_CONFIG_FILE)

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
		log.error(`Failed to write migration report file: ${filePath}. ${formatError(error)}`)
	}
}

function toBigInt(value: unknown): bigint {
	if (typeof value === "bigint") return value
	if (typeof value === "number") return BigInt(value)
	if (typeof value === "string") return BigInt(value)
	return BigInt((value as any).toString())
}

function sameAddress(a: string, b: string): boolean {
	try {
		return ethers.getAddress(a) === ethers.getAddress(b)
	} catch {
		return false
	}
}

function samePath(a: string, b: string): boolean {
	return path.resolve(a) === path.resolve(b)
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
	return toBigInt(quote.quantity) - toBigInt(quote.closedAmount)
}

function isZeroAddress(address: string): boolean {
	return ethers.getAddress(address) === ethers.ZeroAddress
}

function migrationSkipReason(quote: MigrationQuoteView): string | undefined {
	if (isZeroAddress(quote.partyA)) return "non-existent quote"
	const status = Number(quote.quoteStatus)
	if (FEE_RESERVATION_STATUSES.has(status)) return undefined
	if (!ACTIVE_POSITION_STATUSES.has(status)) return `status=${status}`
	if (quoteOpenAmount(quote) <= 0n) return `status=${status} with zero open amount`
	return undefined
}

function loadMigrationInput(filePath: string): {
	input: MigrationInput
	expectedAggregates: Map<string, { long: bigint; short: bigint }> | null
	source: {
		diamondAddress?: string
		deployedFacetsFile?: string
	}
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
	if (data.diamondAddress && (typeof data.diamondAddress !== "string" || !ethers.isAddress(data.diamondAddress))) {
		throw new Error(`Migration input diamondAddress is invalid: ${data.diamondAddress}`)
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

	const deployedFacetsFile =
		typeof data.deployedFacetsFile === "string"
			? data.deployedFacetsFile
			: data.deployedFacets && typeof data.deployedFacets === "object" && typeof data.deployedFacets.file === "string"
				? data.deployedFacets.file
				: undefined

	return {
		input: {
			quoteIds: quoteIds.sort((a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0)),
			partyBTasks: partyBTasks.sort((a: PartyBTask, b: PartyBTask) => a.partyB.localeCompare(b.partyB)),
		},
		expectedAggregates,
		source: {
			diamondAddress: data.diamondAddress ? ethers.getAddress(data.diamondAddress) : undefined,
			deployedFacetsFile,
		},
	}
}

function validateMigrationInputSource(
	source: { diamondAddress?: string; deployedFacetsFile?: string },
	diamondAddress: string,
	deployedFacetsFile: string,
): void {
	if (source.diamondAddress && !sameAddress(source.diamondAddress, diamondAddress)) {
		throw new Error(
			`Migration input was prepared for diamond ${source.diamondAddress}, but runMigration resolved ${diamondAddress}. ` +
				`Regenerate the input or set DIAMOND_ADDRESS to the prepared diamond.`,
		)
	}
	if (source.deployedFacetsFile && !samePath(source.deployedFacetsFile, deployedFacetsFile)) {
		throw new Error(
			`Migration input references deployed facets ${source.deployedFacetsFile}, but runMigration resolved ${deployedFacetsFile}. ` +
				`Use the same FACETS_FILE/DEPLOYED_FACETS_FILE as prepareMigrationInput.ts or regenerate the input.`,
		)
	}
}

export async function verifyMigration(
	migrationFacet: any,
	viewFacet: any,
	viewFacetAggregate: any,
	viewFacetQuote: any,
	openQuoteIds: bigint[],
	partyBTasks: PartyBTask[],
	expectedAggregates: Map<string, { long: bigint; short: bigint }> | null,
): Promise<void> {
	for (const quoteId of openQuoteIds) {
		const migrated = await migrationFacet.isQuoteMigrated(quoteId)
		if (!migrated) {
			// Check on-chain state — the contract skips non-migratable statuses
			// and active-position quotes whose open amount is already zero.
			const quote = await viewFacetQuote.getQuote(quoteId)
			const skipReason = migrationSkipReason(quote)
			if (skipReason) {
				continue // correctly skipped by contract
			}
			throw new Error(`Quote ${quoteId.toString()} not migrated (status=${Number(quote.quoteStatus)}, openAmount=${quoteOpenAmount(quote)})`)
		}
	}

	for (const task of partyBTasks) {
		// Catches: partial migration where the first partyA succeeded but a later one
		// failed silently. The original check tested only partyAs[0]; checking every
		// (partyB, partyA) pair ensures migrateCrossLockedValues() wasn't resumed at a
		// stale chunk boundary or skipped a pair due to an error the operator missed.
		for (const partyA of task.partyAs) {
			const migrated = await migrationFacet.isCrossLockedValuesMigrated(task.partyB, partyA)
			if (!migrated) {
				throw new Error(`PartyB ${task.partyB} + PartyA ${partyA} pair not migrated`)
			}
		}

		// Verify cross locked values were correctly aggregated
		// Note: allocated balances are NOT aggregated by migration — only locked and pending locked values are
		const expectedLocked = { cva: 0n, lf: 0n, partyAmm: 0n, partyBmm: 0n }
		const expectedPendingLocked = { cva: 0n, lf: 0n, partyAmm: 0n, partyBmm: 0n }
		for (const partyA of task.partyAs) {
			const info = await viewFacet.balanceInfoOfPartyB(task.partyB, partyA)
			expectedLocked.cva += toBigInt(info[1])
			expectedLocked.lf += toBigInt(info[2])
			expectedLocked.partyAmm += toBigInt(info[3])
			expectedLocked.partyBmm += toBigInt(info[4])
			expectedPendingLocked.cva += toBigInt(info[5])
			expectedPendingLocked.lf += toBigInt(info[6])
			expectedPendingLocked.partyAmm += toBigInt(info[7])
			expectedPendingLocked.partyBmm += toBigInt(info[8])
		}
		const crossInfo = await viewFacet.balanceInfoOfCrossPartyB(task.partyB)
		const crossLocked = {
			cva: toBigInt(crossInfo[1]),
			lf: toBigInt(crossInfo[2]),
			partyAmm: toBigInt(crossInfo[3]),
			partyBmm: toBigInt(crossInfo[4]),
		}
		const crossPendingLocked = {
			cva: toBigInt(crossInfo[5]),
			lf: toBigInt(crossInfo[6]),
			partyAmm: toBigInt(crossInfo[7]),
			partyBmm: toBigInt(crossInfo[8]),
		}
		for (const field of ["cva", "lf", "partyAmm", "partyBmm"] as const) {
			if (expectedLocked[field] !== crossLocked[field]) {
				throw new Error(
					`PartyB ${task.partyB} cross locked ${field} mismatch: expected=${expectedLocked[field].toString()} got=${crossLocked[field].toString()}`,
				)
			}
			if (expectedPendingLocked[field] !== crossPendingLocked[field]) {
				throw new Error(
					`PartyB ${task.partyB} cross pending locked ${field} mismatch: expected=${expectedPendingLocked[field].toString()} got=${crossPendingLocked[field].toString()}`,
				)
			}
		}
	}

	if (!expectedAggregates) return

	for (const [key, expected] of expectedAggregates.entries()) {
		const [partyBRaw, partyARaw, symbolIdRaw] = key.split("-")
		const partyB = ethers.getAddress(partyBRaw)
		const partyA = ethers.getAddress(partyARaw)
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
if (configFile.deployedFacetsFile !== undefined && configFile.deployedFacetsFile !== "" && typeof configFile.deployedFacetsFile !== "string") {
	throw new Error("deployedFacetsFile must be a string path.")
}

const upgradeShared = loadUpgradeConfigShared(NETWORK_SUFFIX)
const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? configFile.diamondAddress ?? upgradeShared.diamondAddress
// Default to the network-suffixed migration-input file written by prepareMigrationInput.ts.
const DEFAULT_OUTPUT_DIR = "./scripts/upgrade/output"
const outputDir = process.env.MIGRATION_OUTPUT_DIR ?? configFile.outputDir ?? DEFAULT_OUTPUT_DIR
const MIGRATION_INPUT_FILE = process.env.MIGRATION_INPUT_FILE ?? configFile.migrationInputFile ?? `${outputDir}/${withSuffix("migration-input")}`
const DEPLOYED_FACETS_FILE =
	process.env.FACETS_FILE || process.env.DEPLOYED_FACETS_FILE || configFile.deployedFacetsFile || `${outputDir}/${withSuffix("deployed-facets")}`
const DRY_RUN = parseBool(process.env.DRY_RUN, configFile.dryRun ?? false)

const DEFAULT_PROGRESS_FILE = `${outputDir}/${withSuffix("migration-progress")}`
let migrateProgressFile = process.env.MIGRATE_PROGRESS_FILE ?? configFile.progressFile ?? DEFAULT_PROGRESS_FILE
const DEFAULT_REPORT_FILE = `${outputDir}/${withSuffix(DRY_RUN ? "migration-report-dry-run" : "migration-report")}`
let migrateReportFile = process.env.MIGRATE_REPORT_FILE ?? (DRY_RUN ? undefined : configFile.reportFile) ?? DEFAULT_REPORT_FILE

if (!DRY_RUN && path.resolve(migrateProgressFile) === path.resolve(MIGRATION_CONFIG_FILE)) {
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
	dryRun: DRY_RUN,
	skipPreCheck: parseBool(process.env.SKIP_PRE_CHECK, configFile.skipPreCheck ?? false),
	progressFile: DRY_RUN ? null : migrateProgressFile,
}
const MIGRATION_ROLE = ethers.id("MIGRATION_ROLE")

async function hasMigrationRole(diamondAddress: string, account: string): Promise<boolean> {
	const viewFacet = await ethers.getContractAt(["function hasRole(address user, bytes32 role) view returns (bool)"], diamondAddress)
	return viewFacet.hasRole(account, MIGRATION_ROLE)
}

async function checkMigrationRole(diamondAddress: string, account: string, required: boolean): Promise<boolean> {
	const normalized = ethers.getAddress(account)
	const hasRole = await hasMigrationRole(diamondAddress, normalized)
	log.kv("MIGRATION_ROLE", hasRole ? `yes (${log.addr(normalized)})` : `no (${log.addr(normalized)})`)
	if (!hasRole) {
		const message =
			`${normalized} does not have MIGRATION_ROLE on ${diamondAddress}. ` + `Execute the Safe role-grant batch before running migration.`
		if (required) {
			throw new Error(`${message} Set SKIP_MIGRATION_ROLE_CHECK=true only if you are intentionally bypassing this preflight.`)
		}
		log.warn(`${message} Dry run will continue because no transactions are submitted.`)
	}
	return hasRole
}

async function main() {
	const scriptTimer = log.timer()
	await verifyRpc()
	const startedAtMs = Date.now()
	const report: MigrationOnDemandReport = {
		status: "running",
		startedAt: new Date(startedAtMs).toISOString(),
		migrationInputFile: MIGRATION_INPUT_FILE,
		outputDir,
		progressFile: MIGRATION_CONFIG.progressFile ?? undefined,
		reportFile: migrateReportFile,
		deployedFacetsFile: DEPLOYED_FACETS_FILE,
		config: {
			chunkSize: MIGRATION_CONFIG.chunkSize,
			dryRun: MIGRATION_CONFIG.dryRun,
		},
		steps: [],
	}
	tryWriteReport(migrateReportFile, report)
	let currentStep: string | null = null

	const { finish: finishStep } = createStepReporter(report.steps)

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
				deployedFacetsFile: DEPLOYED_FACETS_FILE,
			},
		})
		currentStep = null
		tryWriteReport(migrateReportFile, report)

		log.header("Symmio v0.8.5 Migration")

		// Resolve signer — fork: impersonate diamond owner, production: find migrator signer (must have MIGRATION_ROLE)
		currentStep = "resolve_signer"
		const isFork = parseBool(process.env.FORK, configFile.fork ?? false)
		const skipMigrationRoleCheck = parseBool(process.env.SKIP_MIGRATION_ROLE_CHECK, false)
		let admin
		let adminAddress: string
		if (MIGRATION_CONFIG.dryRun) {
			admin = ethers.provider
			if (isFork) {
				adminAddress =
					process.env.FORK_MIGRATION_RUNNER_ADDRESS ?? process.env.MIGRATION_RUNNER_ADDRESS ?? upgradeShared.migrationRunner ?? ethers.ZeroAddress
			} else {
				const migratorAddress = upgradeShared.migrationRunner
				const signer = await resolveConfiguredSigner({
					role: "migrationRunner",
					expectedAddress: migratorAddress,
					envPrefix: "MIGRATION_RUNNER",
					allowDefault: !migratorAddress,
				})
				adminAddress = await signer.getAddress()
			}
			log.info("Dry run: resolved migrationRunner for role preflight; using provider-only contract runner")
		} else if (isFork) {
			const forkMigrationRunner = process.env.FORK_MIGRATION_RUNNER_ADDRESS ?? process.env.MIGRATION_RUNNER_ADDRESS ?? upgradeShared.migrationRunner
			if (forkMigrationRunner && ethers.isAddress(forkMigrationRunner)) {
				admin = await impersonateAndFund(forkMigrationRunner)
				adminAddress = await admin.getAddress()
				log.ok(`Fork migration runner impersonated: ${log.addr(adminAddress)}`)
			} else {
				admin = await getImpersonatedAdmin(DIAMOND_ADDRESS)
				adminAddress = await admin.getAddress()
			}
		} else {
			const migratorAddress = upgradeShared.migrationRunner
			admin = await resolveConfiguredSigner({
				role: "migrationRunner",
				expectedAddress: migratorAddress,
				envPrefix: "MIGRATION_RUNNER",
				allowDefault: !migratorAddress,
			})
			adminAddress = await admin.getAddress()
		}

		let migrationRoleOk: boolean | undefined
		if (skipMigrationRoleCheck) {
			log.warn("Skipping MIGRATION_ROLE preflight because SKIP_MIGRATION_ROLE_CHECK=true")
		} else {
			migrationRoleOk = await checkMigrationRole(DIAMOND_ADDRESS, adminAddress, !MIGRATION_CONFIG.dryRun)
			report.roleChecks = {
				migrationRole: {
					address: ethers.getAddress(adminAddress),
					roleHash: MIGRATION_ROLE,
					hasRole: migrationRoleOk,
				},
			}
		}
		report.protocolAdmin = adminAddress
		report.steps.push({
			name: "resolve_signer",
			status: "ok",
			details: { adminAddress, migrationRole: migrationRoleOk ?? "skipped" },
		})
		currentStep = null
		tryWriteReport(migrateReportFile, report)

		log.kv("Diamond", log.addr(DIAMOND_ADDRESS))
		log.kv("Admin", log.addr(adminAddress))
		log.kv("Input file", MIGRATION_INPUT_FILE!)
		log.kv("Deployed facets", DEPLOYED_FACETS_FILE)
		log.kv("Progress file", MIGRATION_CONFIG.progressFile ?? "disabled for dry run")
		log.kv("Chunk size", String(MIGRATION_CONFIG.chunkSize))
		if (MIGRATION_CONFIG.dryRun) log.kv("Mode", "DRY RUN")

		log.setSteps(5)

		// Load validated input
		let t = log.step("Load migration input")
		currentStep = "load_input"
		const { input, expectedAggregates, source } = loadMigrationInput(MIGRATION_INPUT_FILE!)
		validateMigrationInputSource(source, DIAMOND_ADDRESS, DEPLOYED_FACETS_FILE)
		log.stats([
			["Quote IDs", input.quoteIds.length],
			["PartyB tasks", input.partyBTasks.length],
			["Aggregate keys", expectedAggregates?.size ?? 0],
		])

		// Catches: operator re-running runMigration.ts against a different input file
		// than the prior (interrupted) run's progress reflects. The existing progress
		// counts would resume mid-way through a different quoteIds list, silently
		// skipping quotes. Detect this by comparing saved progress totals against the
		// current input totals. A completed phase="complete" is explicitly surfaced too.
		if (!MIGRATION_CONFIG.dryRun && fs.existsSync(migrateProgressFile)) {
			try {
				const priorProgress = JSON.parse(fs.readFileSync(migrateProgressFile, "utf-8"))
				if (priorProgress && typeof priorProgress === "object") {
					if (priorProgress.phase === "complete") {
						log.warn(`Progress file at ${migrateProgressFile} marks migration as complete. Re-running will be a no-op unless you delete it.`)
					}
					const priorQuotes = Number(priorProgress.quotesProcessed ?? 0)
					if (priorQuotes > input.quoteIds.length) {
						throw new Error(
							`Progress file reports ${priorQuotes} quotes processed but current input has only ${input.quoteIds.length}. ` +
								`Either the input file changed or the progress file is stale. Delete ${migrateProgressFile} to restart.`,
						)
					}
				}
			} catch (error) {
				// Re-throw our own validation error, swallow JSON parse errors (partial/corrupt file).
				if (error instanceof Error && error.message.includes("Progress file reports")) throw error
			}
		}

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
		finishStep(t)

		// Verify deployed facets artifact and live post-cut surface
		t = log.step("Verify deployed facets artifact")
		currentStep = "verify_deployed_facets"
		const deployedFacets = await loadDeployedFacetsForNetwork(
			DEPLOYED_FACETS_FILE,
			{ networkName: NETWORK_SUFFIX, diamondAddress: DIAMOND_ADDRESS },
			{ required: true, validateMigrationSurface: true },
		)
		await verifyMigrationSurfaceOnDiamond(DIAMOND_ADDRESS, deployedFacets.state!)
		report.deployedFacets = deployedFacets.summary
		log.ok(
			`Migration surface matches ${DEPLOYED_FACETS_FILE} (${deployedFacets.summary.facetCount} facets, ${deployedFacets.summary.selectorCount} selectors)`,
		)
		report.steps.push({
			name: "verify_deployed_facets",
			status: "ok",
			details: deployedFacets.summary as unknown as Record<string, unknown>,
		})
		currentStep = null
		tryWriteReport(migrateReportFile, report)
		finishStep(t)

		// Connect facets
		t = log.step("Connect facets")
		currentStep = "connect_facets"
		const migrationFacet = await ethers.getContractAt("contracts/core/facets/Migration/MigrationFacet.sol:MigrationFacet", DIAMOND_ADDRESS, admin)
		const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", DIAMOND_ADDRESS, admin)
		const viewFacetQuote = await ethers.getContractAt(
			"contracts/core/facets/ViewFacetQuote/ViewFacetQuote.sol:ViewFacetQuote",
			DIAMOND_ADDRESS,
			admin,
		)
		const viewFacetAggregate = await ethers.getContractAt(
			"contracts/core/facets/ViewFacetAggregate/ViewFacetAggregate.sol:ViewFacetAggregate",
			DIAMOND_ADDRESS,
			admin,
		)
		log.ok("MigrationFacet, ViewFacet, ViewFacetQuote, ViewFacetAggregate connected")
		report.steps.push({ name: "connect_facets", status: "ok" })
		currentStep = null
		tryWriteReport(migrateReportFile, report)
		finishStep(t)

		// Run migration
		t = log.step("Execute migration")
		if (input.quoteIds.length === 0 && input.partyBTasks.length === 0) {
			log.info("No migration tasks to run — skipping")
			report.steps.push({ name: "migrate", status: "ok", details: { skipped: true } })
			tryWriteReport(migrateReportFile, report)
		} else {
			currentStep = "migrate"
			log.info(`Migrating ${log.commaNumber(input.quoteIds.length)} quotes across ${input.partyBTasks.length} partyBs...`)
			const migrationReport = await migrate(migrationFacet as any, viewFacetQuote, input, MIGRATION_CONFIG)
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
		finishStep(t)

		// Verify migration
		t = log.step("Verify migration")
		if (MIGRATION_CONFIG.dryRun) {
			log.info("Skipping verification because dry run does not submit transactions")
			report.verification = {
				performed: false,
				quoteChecks: 0,
				partyBChecks: 0,
				aggregateChecks: 0,
			}
			report.steps.push({ name: "verify_migration", status: "ok", details: { skipped: true, reason: "dryRun" } })
			tryWriteReport(migrateReportFile, report)
		} else if (input.quoteIds.length > 0 || input.partyBTasks.length > 0) {
			currentStep = "verify_migration"
			log.info(
				`Verifying ${log.commaNumber(input.quoteIds.length)} quotes, ${input.partyBTasks.length} partyBs, ${log.commaNumber(expectedAggregates?.size ?? 0)} aggregates...`,
			)
			await verifyMigration(migrationFacet, viewFacet, viewFacetAggregate, viewFacetQuote, input.quoteIds, input.partyBTasks, expectedAggregates)
			log.ok("All migration checks passed")
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
			log.info("No data to verify — skipping")
			report.verification = {
				performed: false,
				quoteChecks: 0,
				partyBChecks: 0,
				aggregateChecks: 0,
			}
		}
		finishStep(t)

		report.status = "success"

		const summary: Array<[string, string]> = [["Diamond", DIAMOND_ADDRESS]]
		if (report.roleChecks?.migrationRole) {
			const roleCheck = report.roleChecks.migrationRole
			summary.push(["MIGRATION_ROLE", `${roleCheck.hasRole ? "yes" : "no"} (${log.addr(roleCheck.address)})`])
		}
		summary.push(["Duration", scriptTimer.fmt()], ["Report", migrateReportFile])

		log.success(MIGRATION_CONFIG.dryRun ? "Migration dry run completed successfully" : "Migration completed successfully", summary)
		if (MIGRATION_CONFIG.dryRun) {
			log.nextSteps(["Review the dry-run report in " + migrateReportFile, "Run again without DRY_RUN=true when ready to execute"])
		} else {
			log.nextSteps(["Verify the migration report in " + migrateReportFile, "Unpause the system when ready"])
		}
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
		log.failure("Migration failed", formatError(error))
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
