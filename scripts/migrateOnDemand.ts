import fs from "fs"

import { ethers } from "../test/helpers/hardhat-connection.js"
import { PositionType, QuoteStatus } from "../test/models/Enums.js"
import { migrate, MigrationConfig, MigrationInput } from "./migrate.js"

type PartyBTask = { partyB: string; partyAs: string[] }

/**
 * On-demand migration script for v0.8.5.
 *
 * Run:
 *   DIAMOND_ADDRESS=0x... PARTY_A_ADDRESSES=0x...,0x... npx hardhat run ./scripts/migrateOnDemand.ts --network localhost
 *
 * Config:
 *   cp scripts/config/migrateOnDemand.sample.json scripts/config/migrateOnDemand.json
 *   # edit scripts/config/migrateOnDemand.json
 *
 * Overrides:
 *   MIGRATION_CONFIG_FILE=./path/to/config.json
 *
 * Resume:
 *   Re-run the command; migration progress is stored in migrateProgressFile.
 *
 * Auto-discovery:
 *   If no PartyA list or input file is provided, the script scans all quote IDs.
 */
type MigrationConfigFile = {
	diamondAddress?: string
	partyAAddresses?: string[]
	partyBAddresses?: string[]
	migrationInputFile?: string
	migrateQuotes?: boolean
	migrateBalances?: boolean
	pauseDuringMigration?: boolean
	grantRoles?: boolean
	migrateChunkSize?: number
	dryRun?: boolean
	migrateProgressFile?: string
	migrateStrict?: boolean
}

function loadMigrationConfigFile(): MigrationConfigFile {
	const configPath = process.env.MIGRATION_CONFIG_FILE ?? "./scripts/config/migrateOnDemand.json"
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

const configFile = loadMigrationConfigFile()
const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? configFile.diamondAddress
const PARTY_A_ADDRESSES = process.env.PARTY_A_ADDRESSES
const PARTY_B_ADDRESSES = process.env.PARTY_B_ADDRESSES
const MIGRATION_INPUT_FILE = process.env.MIGRATION_INPUT_FILE ?? configFile.migrationInputFile

const MIGRATE_QUOTES = parseBool(process.env.MIGRATE_QUOTES, configFile.migrateQuotes ?? true)
const MIGRATE_BALANCES = parseBool(process.env.MIGRATE_BALANCES, configFile.migrateBalances ?? true)
const PAUSE_DURING_MIGRATION = parseBool(process.env.PAUSE_DURING_MIGRATION, configFile.pauseDuringMigration ?? true)
const GRANT_ROLES = parseBool(process.env.GRANT_ROLES, configFile.grantRoles ?? true)

const MIGRATION_CONFIG: MigrationConfig = {
	chunkSize: Number(process.env.MIGRATE_CHUNK_SIZE ?? configFile.migrateChunkSize ?? "50"),
	dryRun: parseBool(process.env.DRY_RUN, configFile.dryRun ?? false),
	progressFile: process.env.MIGRATE_PROGRESS_FILE ?? configFile.migrateProgressFile ?? "./migration-progress.json",
	strict: parseBool(process.env.MIGRATE_STRICT, configFile.migrateStrict ?? false),
}

function parseBool(value: string | boolean | undefined, fallback: boolean): boolean {
	if (!value) return fallback
	if (typeof value === "boolean") return value
	const normalized = value.toLowerCase()
	if (normalized === "true" || normalized === "1") return true
	if (normalized === "false" || normalized === "0") return false
	throw new Error(`Invalid boolean value: ${value}`)
}

function parseAddressList(value: string | undefined, fallback: string[] = []): string[] {
	if (!value) return fallback
	return value
		.split(",")
		.map(item => item.trim())
		.filter(Boolean)
}

function toBigInt(value: unknown): bigint {
	if (typeof value === "bigint") return value
	if (typeof value === "number") return BigInt(value)
	if (typeof value === "string") return BigInt(value)
	return BigInt((value as any).toString())
}

function normalizeAddressList(value: unknown, label: string): string[] {
	if (!value) return []
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array of addresses.`)
	}
	for (const entry of value) {
		if (typeof entry !== "string") {
			throw new Error(`${label} must contain only strings.`)
		}
	}
	return value.map(item => item.trim()).filter(Boolean)
}

function validateAddressList(label: string, addresses: string[]): void {
	for (const addr of addresses) {
		if (!ethers.isAddress(addr)) {
			throw new Error(`${label} has invalid address: ${addr}`)
		}
		if (addr === ethers.ZeroAddress) {
			throw new Error(`${label} contains zero address.`)
		}
	}
}

function buildAddressList(envValue: string | undefined, configList: string[], label: string): string[] {
	const list = envValue ? parseAddressList(envValue) : configList
	validateAddressList(label, list)
	return list
}

async function fetchQuoteIds(viewFacetQuote: any, partyA: string): Promise<bigint[]> {
	const total = toBigInt(await viewFacetQuote.quotesLength(partyA))
	if (total === 0n) return []

	const ids: bigint[] = []
	const chunkSize = 100n
	let start = 0n
	while (start < total) {
		const size = total - start > chunkSize ? chunkSize : total - start
		const batch = await viewFacetQuote.quoteIdsOf(partyA, start, size)
		for (const id of batch) {
			ids.push(toBigInt(id))
		}
		start += size
	}
	return ids
}

function addQuoteToCollections(
	quote: any,
	quoteId: bigint,
	partyBFilter: Set<string> | null,
	openQuoteIdsSet: Set<bigint>,
	partyBTasks: Map<string, Set<string>>,
	expectedAggregates: Map<string, { long: bigint; short: bigint }>,
): void {
	const status = Number(quote.quoteStatus)
	if (status !== QuoteStatus.OPENED && status !== QuoteStatus.CLOSE_PENDING && status !== QuoteStatus.CANCEL_CLOSE_PENDING) {
		return
	}

	const partyB = quote.partyB
	if (partyBFilter && !partyBFilter.has(partyB)) {
		return
	}

	openQuoteIdsSet.add(quoteId)
	if (!partyBTasks.has(partyB)) {
		partyBTasks.set(partyB, new Set())
	}
	partyBTasks.get(partyB)!.add(quote.partyA)

	const symbolId = toBigInt(quote.symbolId)
	const positionType = Number(quote.positionType)
	const openAmount = toBigInt(quote.quantity) - toBigInt(quote.closedAmount)
	const key = `${partyB}-${quote.partyA}-${symbolId.toString()}`
	if (!expectedAggregates.has(key)) {
		expectedAggregates.set(key, { long: 0n, short: 0n })
	}
	const agg = expectedAggregates.get(key)!
	if (positionType === PositionType.LONG) {
		agg.long += openAmount
	} else {
		agg.short += openAmount
	}
}

async function collectOpenQuotes(viewFacetQuote: any, partyAs: string[], partyBFilter: Set<string> | null) {
	const openQuoteIdsSet: Set<bigint> = new Set()
	const partyBTasks: Map<string, Set<string>> = new Map()
	const expectedAggregates: Map<string, { long: bigint; short: bigint }> = new Map()

	for (const partyA of partyAs) {
		const quoteIds = await fetchQuoteIds(viewFacetQuote, partyA)
		for (const quoteId of quoteIds) {
			const quote = await viewFacetQuote.getQuote(quoteId)
			addQuoteToCollections(quote, toBigInt(quoteId), partyBFilter, openQuoteIdsSet, partyBTasks, expectedAggregates)
		}
	}

	return {
		openQuoteIds: [...openQuoteIdsSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
		partyBTasks: [...partyBTasks.entries()]
			.map(([partyB, partyAsSet]) => ({
				partyB,
				partyAs: [...partyAsSet].sort(),
			}))
			.sort((a, b) => a.partyB.localeCompare(b.partyB)),
		expectedAggregates,
	}
}

async function collectOpenQuotesFromAll(viewFacetQuote: any, partyBFilter: Set<string> | null) {
	const openQuoteIdsSet: Set<bigint> = new Set()
	const partyBTasks: Map<string, Set<string>> = new Map()
	const expectedAggregates: Map<string, { long: bigint; short: bigint }> = new Map()

	const lastId = toBigInt(await viewFacetQuote.getNextQuoteId())
	let id = 1n
	while (id <= lastId) {
		const quote = await viewFacetQuote.getQuote(id)
		addQuoteToCollections(quote, id, partyBFilter, openQuoteIdsSet, partyBTasks, expectedAggregates)
		id += 1n
	}

	return {
		openQuoteIds: [...openQuoteIdsSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
		partyBTasks: [...partyBTasks.entries()]
			.map(([partyB, partyAsSet]) => ({
				partyB,
				partyAs: [...partyAsSet].sort(),
			}))
			.sort((a, b) => a.partyB.localeCompare(b.partyB)),
		expectedAggregates,
	}
}

function loadMigrationInput(filePath: string): MigrationInput {
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

	return {
		quoteIds: quoteIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
		partyBTasks: partyBTasks.sort((a, b) => a.partyB.localeCompare(b.partyB)),
	}
}

async function verifyMigration(
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

async function main() {
	if (!DIAMOND_ADDRESS) {
		throw new Error("DIAMOND_ADDRESS is required.")
	}
	if (!ethers.isAddress(DIAMOND_ADDRESS) || DIAMOND_ADDRESS === ethers.ZeroAddress) {
		throw new Error(`Invalid DIAMOND_ADDRESS: ${DIAMOND_ADDRESS}`)
	}
	if (MIGRATION_INPUT_FILE && typeof MIGRATION_INPUT_FILE !== "string") {
		throw new Error("migrationInputFile must be a string path.")
	}
	if (!Number.isInteger(MIGRATION_CONFIG.chunkSize) || MIGRATION_CONFIG.chunkSize <= 0) {
		throw new Error(`Invalid migrateChunkSize: ${MIGRATION_CONFIG.chunkSize}`)
	}

	const signers = await ethers.getSigners()
	const admin = signers[0]
	const adminAddress = await admin.getAddress()

	const configPartyAs = normalizeAddressList(configFile.partyAAddresses, "partyAAddresses")
	const configPartyBs = normalizeAddressList(configFile.partyBAddresses, "partyBAddresses")
	const partyAs = [...new Set(buildAddressList(PARTY_A_ADDRESSES, configPartyAs, "PartyA addresses"))].sort()
	const partyBs = [...new Set(buildAddressList(PARTY_B_ADDRESSES, configPartyBs, "PartyB addresses"))].sort()
	const partyBFilter = partyBs.length > 0 ? new Set(partyBs) : null

	console.log(`Diamond: ${DIAMOND_ADDRESS}`)
	console.log(`Admin:   ${adminAddress}`)
	console.log(`PartyAs: ${partyAs.join(", ") || "-"}`)
	console.log(`PartyBs: ${partyBs.join(", ") || "-"}`)

	const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", DIAMOND_ADDRESS, admin)
	const pauseControlFacet = await ethers.getContractAt(
		"contracts/core/facets/PauseControl/PauseControlFacet.sol:PauseControlFacet",
		DIAMOND_ADDRESS,
		admin,
	)
	const migrationFacet = await ethers.getContractAt("contracts/core/facets/Migration/MigrationFacet.sol:MigrationFacet", DIAMOND_ADDRESS, admin)
	const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", DIAMOND_ADDRESS, admin)
	const viewFacetQuote = await ethers.getContractAt("contracts/core/facets/ViewFacetQuote/ViewFacetQuote.sol:ViewFacetQuote", DIAMOND_ADDRESS, admin)
	const viewFacetAggregate = await ethers.getContractAt(
		"contracts/core/facets/ViewFacetAggregate/ViewFacetAggregate.sol:ViewFacetAggregate",
		DIAMOND_ADDRESS,
		admin,
	)

	let pausedByScript = false
	let input: MigrationInput
	let expectedAggregates: Map<string, { long: bigint; short: bigint }> | null = null

	if (MIGRATION_INPUT_FILE) {
		if (!fs.existsSync(MIGRATION_INPUT_FILE)) {
			throw new Error(`Migration input file not found: ${MIGRATION_INPUT_FILE}`)
		}
		input = loadMigrationInput(MIGRATION_INPUT_FILE)
	} else {
		if (partyAs.length === 0) {
			console.log("No PartyA list provided; scanning all quotes to build migration input.")
		}
		const collected =
			partyAs.length > 0
				? await collectOpenQuotes(viewFacetQuote, partyAs, partyBFilter)
				: await collectOpenQuotesFromAll(viewFacetQuote, partyBFilter)
		input = { quoteIds: collected.openQuoteIds, partyBTasks: collected.partyBTasks }
		expectedAggregates = collected.expectedAggregates
	}

	if (GRANT_ROLES) {
		await (await controlFacet.grantRole(adminAddress, ethers.id("MIGRATION_ROLE"))).wait()
		if (PAUSE_DURING_MIGRATION) {
			await (await controlFacet.grantRole(adminAddress, ethers.id("PAUSER_ROLE"))).wait()
			await (await controlFacet.grantRole(adminAddress, ethers.id("UNPAUSER_ROLE"))).wait()
		}
	}

	if (PAUSE_DURING_MIGRATION) {
		const pauseState = await viewFacet.pauseState()
		if (!pauseState.globalPaused) {
			await (await pauseControlFacet.pauseGlobal()).wait()
			pausedByScript = true
		} else {
			console.log("Global pause already active; skipping pause.")
		}
	}

	if (!MIGRATE_QUOTES) {
		input.quoteIds = []
	}
	if (!MIGRATE_BALANCES) {
		input.partyBTasks = []
	}

	if (input.quoteIds.length === 0 && input.partyBTasks.length === 0) {
		console.log("No migration tasks to run.")
	} else {
		console.log(`Migrating ${input.quoteIds.length} quotes for ${input.partyBTasks.length} partyBs...`)
		await migrate(migrationFacet, input, MIGRATION_CONFIG)
	}

	if (PAUSE_DURING_MIGRATION) {
		if (pausedByScript) {
			await (await pauseControlFacet.unpauseGlobal()).wait()
		} else {
			console.log("Global pause left unchanged.")
		}
	}

	if (input.quoteIds.length > 0 || input.partyBTasks.length > 0) {
		console.log("Verifying migration results...")
		await verifyMigration(migrationFacet, viewFacet, viewFacetAggregate, input.quoteIds, input.partyBTasks, expectedAggregates)
	}

	console.log("Migration run completed successfully.")
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
