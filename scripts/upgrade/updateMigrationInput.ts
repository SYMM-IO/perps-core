/**
 * Remove quote IDs from a migration input file when the on-chain migration
 * contract intentionally skips them, for example OPENED quotes with zero open
 * amount. Writes a backup before updating the input file.
 *
 * Usage:
 *   QUOTE_IDS=99015 ./node_modules/.bin/hardhat run scripts/upgrade/updateMigrationInput.ts --network coti
 *   QUOTE_IDS=99015 EXECUTE=true CONFIRM_CHAIN_ID=<chainId> \
 *     ./node_modules/.bin/hardhat run scripts/upgrade/updateMigrationInput.ts --network coti
 *
 * Optional:
 *   MIGRATION_INPUT_FILE=scripts/upgrade/output/migration-input-coti.json
 *   FORCE=true              Remove even if the on-chain safety check does not pass
 */
import fs from "fs"
import path from "path"

import { atomicWriteFile } from "../../tasks/utils/fs.js"
import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { exactBooleanEnv, requireExecutionConfirmation } from "./utils/executionGuard.js"
import { log } from "./utils/log.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { baseNetworkName, loadUpgradeConfigShared } from "./utils/sharedConfig.js"

const OUTPUT_DIR = "./scripts/upgrade/output"
const NETWORK_SUFFIX = baseNetworkName(connection.networkName)
const withSuffix = (baseName: string): string => (NETWORK_SUFFIX ? `${baseName}-${NETWORK_SUFFIX}.json` : `${baseName}.json`)

const ACTIVE_POSITION_STATUSES = new Set([4, 5, 6])
const STATUS_NAMES: Record<number, string> = {
	0: "PENDING",
	1: "LOCKED",
	2: "CANCEL_PENDING",
	3: "CANCELED",
	4: "OPENED",
	5: "CLOSE_PENDING",
	6: "CANCEL_CLOSE_PENDING",
	7: "CLOSED",
	8: "LIQUIDATED",
	9: "EXPIRED",
	10: "LIQUIDATED_PENDING",
}

type MigrationInputFile = {
	quoteIds?: Array<string | number>
	updatedAt?: string
	removedQuoteIds?: string[]
	[key: string]: unknown
}

type QuoteCheck = {
	quoteId: string
	presentInInput: boolean
	removed: boolean
	reason?: string
	migrated?: boolean
	status?: number
	statusName?: string
	quantity?: string
	closedAmount?: string
	openAmount?: string
}

function parseQuoteIds(): string[] {
	const raw = process.env.QUOTE_IDS ?? process.env.QUOTE_ID
	if (!raw) throw new Error("Set QUOTE_IDS, for example: QUOTE_IDS=99015")
	const ids = raw
		.split(",")
		.map(item => item.trim())
		.filter(Boolean)
	for (const id of ids) {
		if (!/^\d+$/.test(id)) throw new Error(`Invalid quote id: ${id}`)
	}
	return [...new Set(ids)]
}

function defaultInputFile(): string {
	const networkFile = path.join(OUTPUT_DIR, withSuffix("migration-input"))
	if (fs.existsSync(networkFile)) return networkFile
	return path.join(OUTPUT_DIR, "migration-input.json")
}

function backupPath(inputFile: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-")
	return `${inputFile}.bak-${stamp}`
}

function sameQuoteId(a: string | number, b: string): boolean {
	return BigInt(a) === BigInt(b)
}

async function quoteCheck(diamondAddress: string, quoteId: string): Promise<Omit<QuoteCheck, "quoteId" | "presentInInput" | "removed">> {
	const viewFacetQuote = await ethers.getContractAt("contracts/core/facets/ViewFacetQuote/ViewFacetQuote.sol:ViewFacetQuote", diamondAddress)
	const migrationFacet = new ethers.Contract(diamondAddress, ["function isQuoteMigrated(uint256 quoteId) view returns (bool)"], ethers.provider)

	const [quote, migrated] = await Promise.all([viewFacetQuote.getQuote(BigInt(quoteId)), migrationFacet.isQuoteMigrated(BigInt(quoteId))])
	const status = Number(quote.quoteStatus)
	const quantity = BigInt(quote.quantity)
	const closedAmount = BigInt(quote.closedAmount)
	const openAmount = quantity - closedAmount

	if (migrated) {
		return {
			migrated,
			status,
			statusName: STATUS_NAMES[status] ?? `UNKNOWN_${status}`,
			quantity: quantity.toString(),
			closedAmount: closedAmount.toString(),
			openAmount: openAmount.toString(),
			reason: "already migrated on-chain",
		}
	}

	if (ACTIVE_POSITION_STATUSES.has(status) && openAmount <= 0n) {
		return {
			migrated,
			status,
			statusName: STATUS_NAMES[status] ?? `UNKNOWN_${status}`,
			quantity: quantity.toString(),
			closedAmount: closedAmount.toString(),
			openAmount: openAmount.toString(),
			reason: "active-position status with zero open amount; migrateQuotes skips it",
		}
	}

	return {
		migrated,
		status,
		statusName: STATUS_NAMES[status] ?? `UNKNOWN_${status}`,
		quantity: quantity.toString(),
		closedAmount: closedAmount.toString(),
		openAmount: openAmount.toString(),
	}
}

async function main() {
	await verifyRpc()

	const shared = loadUpgradeConfigShared(NETWORK_SUFFIX)
	const diamondAddress = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	const inputFile = process.env.MIGRATION_INPUT_FILE ?? defaultInputFile()
	const connectedChainId = (await ethers.provider.getNetwork()).chainId
	const execute = requireExecutionConfirmation(connectedChainId)
	const force = exactBooleanEnv("FORCE")
	const quoteIds = parseQuoteIds()

	if (!diamondAddress || !ethers.isAddress(diamondAddress)) {
		throw new Error("DIAMOND_ADDRESS is required in env or upgrade config")
	}
	if (!fs.existsSync(inputFile)) {
		throw new Error(`Migration input file not found: ${inputFile}`)
	}

	const input = JSON.parse(fs.readFileSync(inputFile, "utf-8")) as MigrationInputFile
	if (!Array.isArray(input.quoteIds)) throw new Error(`Migration input has no quoteIds array: ${inputFile}`)

	log.header("Update Migration Input")
	log.kv("Diamond", diamondAddress)
	log.kv("Input", inputFile)
	log.kv("Quote IDs", quoteIds.join(", "))
	log.kv("Mode", execute ? "EXECUTE" : "PLAN ONLY")
	log.kv("Chain ID", connectedChainId.toString())
	log.kv("Force", String(force))

	const checks: QuoteCheck[] = []
	const removable = new Set<string>()
	for (const quoteId of quoteIds) {
		const presentInInput = input.quoteIds.some(id => sameQuoteId(id, quoteId))
		const check = await quoteCheck(diamondAddress, quoteId)
		const canRemove = presentInInput && (force || check.reason !== undefined)
		checks.push({
			quoteId,
			presentInInput,
			removed: canRemove,
			...check,
		})
		if (canRemove) removable.add(quoteId)
	}

	for (const check of checks) {
		const status = check.statusName ? `${check.statusName}(${check.status})` : "(unknown)"
		log.info(
			`Quote ${check.quoteId}: present=${check.presentInInput}, migrated=${check.migrated}, status=${status}, openAmount=${check.openAmount ?? "(unknown)"}`,
		)
		if (check.removed) log.ok(`  remove: ${check.reason ?? "FORCE=true"}`)
		else log.warn(`  keep: ${check.reason ? "not present in input" : "safety check did not allow removal"}`)
	}

	if (removable.size === 0) {
		log.warn("No quote IDs removed.")
		return
	}

	const before = input.quoteIds.length
	input.quoteIds = input.quoteIds.filter(id => !removable.has(BigInt(id).toString()))
	const after = input.quoteIds.length
	const removedQuoteIds = [...removable].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))
	input.updatedAt = new Date().toISOString()
	input.removedQuoteIds = [...new Set([...(input.removedQuoteIds ?? []), ...removedQuoteIds])]

	if (!execute) {
		log.warn(`PLAN ONLY: would remove ${before - after} quote id(s): ${removedQuoteIds.join(", ")}`)
		log.warn(`Re-run with EXECUTE=true CONFIRM_CHAIN_ID=${connectedChainId} after reviewing the quote checks.`)
		return
	}

	const backup = backupPath(inputFile)
	fs.copyFileSync(inputFile, backup)
	atomicWriteFile(inputFile, `${JSON.stringify(input, null, 2)}\n`)

	log.ok(`Removed ${before - after} quote id(s): ${removedQuoteIds.join(", ")}`)
	log.ok(`Backup: ${backup}`)
	log.ok(`Updated: ${inputFile}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
