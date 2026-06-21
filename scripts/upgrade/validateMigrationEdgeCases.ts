import fs from "fs"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { log } from "./utils/log.js"
import { quoteRequiresMigration, quoteStatusName } from "./utils/migrationQuoteRules.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { loadUpgradeConfigShared, resolveConfigFile } from "./utils/sharedConfig.js"

/**
 * Validate migration input edge cases against on-chain state.
 *
 * Targets corner cases that random spot-checks (validateMigrationInput.ts)
 * are unlikely to hit:
 *   1. Boundary quote — the quote at lastId must be included if it's active
 *   2. Fork drift — no quoteIds beyond on-chain lastId
 *   3. Gap scan — all active quotes between 1..lastId are in the input
 *   4. PartyB completeness — every partyB task has at least one partyA
 *   5. Quotes with zero-address partyB — PENDING quotes (no partyB yet) are included
 *
 * Uses raw eth_call for getQuote() to work with both v0.8.4 and v0.8.5.
 * Can run before or after the diamondCut.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/validateMigrationEdgeCases.ts --network <network>
 *
 * Env overrides:
 *   DIAMOND_ADDRESS, MIGRATION_INPUT_FILE, GAP_SCAN_RANGE (default: 50)
 */

// ── Raw getQuote decoding (same as validateMigrationInput.ts) ───────
//
// Tuple field layout (head offsets, 0-indexed):
//   0: id              2: symbolId        9: quantity
//   10: closedAmount   20: partyA         21: partyB
//   22: quoteStatus

const GET_QUOTE_SELECTOR = ethers.id("getQuote(uint256)").slice(0, 10)

function decodeQuoteFields(data: string): {
	symbolId: string
	partyA: string
	partyB: string
	quoteStatus: number
	quantity: string
	closedAmount: string
} {
	const tupleStart = 66
	const word = (index: number): string => data.slice(tupleStart + index * 64, tupleStart + (index + 1) * 64)

	return {
		symbolId: BigInt("0x" + word(2)).toString(),
		quantity: BigInt("0x" + word(9)).toString(),
		closedAmount: BigInt("0x" + word(10)).toString(),
		partyA: ethers.getAddress("0x" + word(20).slice(24)),
		partyB: ethers.getAddress("0x" + word(21).slice(24)),
		quoteStatus: Number(BigInt("0x" + word(22))),
	}
}

async function rawGetQuote(
	diamondAddress: string,
	quoteId: bigint,
): Promise<{ symbolId: string; partyA: string; partyB: string; quoteStatus: number; quantity: string; closedAmount: string }> {
	const calldata = GET_QUOTE_SELECTOR + ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [quoteId]).slice(2)
	const result = await ethers.provider.call({ to: diamondAddress, data: calldata })
	if (!result || result === "0x") throw new Error(`getQuote(${quoteId}) returned empty data`)
	return decodeQuoteFields(result)
}

function statusName(status: number): string {
	return quoteStatusName(status)
}

// ── Config ──────────────────────────────────────────────────────────

const DEFAULT_INPUT_FILE = "./scripts/upgrade/output/migration-input.json"

function loadMigrationInputFileFromConfig(networkName: string): string | undefined {
	const configFile = resolveConfigFile("migrate", networkName, process.env.MIGRATION_CONFIG_FILE)
	if (!fs.existsSync(configFile)) return undefined
	const data = JSON.parse(fs.readFileSync(configFile, "utf-8")) as { migrationInputFile?: string }
	return data.migrationInputFile
}

function toBigInt(value: unknown): bigint {
	if (typeof value === "bigint") return value
	if (typeof value === "number") return BigInt(value)
	if (typeof value === "string") return BigInt(value)
	return BigInt((value as any).toString())
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
	const scriptTimer = log.timer()
	await verifyRpc()

	const networkName = connection.networkName
	const shared = loadUpgradeConfigShared(networkName)
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	const INPUT_FILE = process.env.MIGRATION_INPUT_FILE ?? loadMigrationInputFileFromConfig(networkName) ?? DEFAULT_INPUT_FILE
	// How many quotes to scan from each end (head and tail) for gap detection
	const GAP_SCAN_RANGE = Number(process.env.GAP_SCAN_RANGE ?? 50)

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS) || DIAMOND_ADDRESS === ethers.ZeroAddress) {
		throw new Error("DIAMOND_ADDRESS is required and must be a valid address.")
	}
	if (!fs.existsSync(INPUT_FILE)) {
		throw new Error(`Migration input file not found: ${INPUT_FILE}\nRun prepareMigrationInput.ts first.`)
	}

	const inputData = JSON.parse(fs.readFileSync(INPUT_FILE, "utf-8"))
	const quoteIds: string[] = inputData.quoteIds ?? []
	const partyBTasks: { partyB: string; partyAs: string[] }[] = inputData.partyBTasks ?? []
	const quoteIdSet = new Set(quoteIds.map(id => BigInt(id)))

	log.header("Validate Migration Edge Cases")
	log.kv("Diamond", log.addr(DIAMOND_ADDRESS))
	log.kv("Input file", INPUT_FILE)
	log.kv("Quotes in input", String(quoteIds.length))
	log.kv("PartyB tasks", String(partyBTasks.length))
	log.kv("Gap scan range", String(GAP_SCAN_RANGE))

	const viewFacetQuote = await ethers.getContractAt("contracts/core/facets/ViewFacetQuote/ViewFacetQuote.sol:ViewFacetQuote", DIAMOND_ADDRESS)
	// getNextQuoteId() returns the LAST assigned quote ID (not next available)
	const onChainLastQuoteId = toBigInt(await viewFacetQuote.getNextQuoteId())

	let failures = 0

	log.setSteps(6)

	// ── Check 1: Boundary quote ─────────────────────────────────────
	let t = log.step("Boundary quote (lastId)")
	log.info(`On-chain lastQuoteId = ${onChainLastQuoteId}`)

	const boundaryQuote = await rawGetQuote(DIAMOND_ADDRESS, onChainLastQuoteId)
	log.info(`Quote ${onChainLastQuoteId}: status=${statusName(boundaryQuote.quoteStatus)}, partyA=${log.truncAddr(boundaryQuote.partyA)}`)

	if (quoteRequiresMigration(boundaryQuote)) {
		if (quoteIdSet.has(onChainLastQuoteId)) {
			log.ok(`Boundary quote ${onChainLastQuoteId} is ${statusName(boundaryQuote.quoteStatus)} and IS in migration input`)
		} else {
			log.error(`Boundary quote ${onChainLastQuoteId} is ${statusName(boundaryQuote.quoteStatus)} but MISSING from migration input`)
			failures++
		}
	} else {
		log.ok(`Boundary quote ${onChainLastQuoteId} is ${statusName(boundaryQuote.quoteStatus)} — no migration needed`)
	}
	log.stepDone(t)

	// ── Check 2: Fork drift ─────────────────────────────────────────
	t = log.step("Fork drift (quoteIds beyond lastId)")
	const beyondLastId = quoteIds.filter(id => BigInt(id) > onChainLastQuoteId)
	if (beyondLastId.length > 0) {
		log.error(
			`${beyondLastId.length} quoteIds exceed on-chain lastId (${onChainLastQuoteId}): ${beyondLastId.slice(0, 5).join(", ")}${beyondLastId.length > 5 ? "..." : ""}`,
		)
		failures++
	} else {
		log.ok(`All ${quoteIds.length} quoteIds are within on-chain lastId (${onChainLastQuoteId})`)
	}
	log.stepDone(t)

	// ── Check 3: Gap scan (head + tail) ─────────────────────────────
	t = log.step(`Gap scan (first ${GAP_SCAN_RANGE} + last ${GAP_SCAN_RANGE} quotes)`)
	let gapsMissing = 0
	let gapsChecked = 0
	const missingDetails: string[] = []

	// Scan head: quotes 1..GAP_SCAN_RANGE
	const headEnd = onChainLastQuoteId < BigInt(GAP_SCAN_RANGE) ? onChainLastQuoteId : BigInt(GAP_SCAN_RANGE)
	for (let id = 1n; id <= headEnd; id++) {
		gapsChecked++
		const quote = await rawGetQuote(DIAMOND_ADDRESS, id)
		if (quoteRequiresMigration(quote) && !quoteIdSet.has(id)) {
			gapsMissing++
			missingDetails.push(`  quote ${id}: ${statusName(quote.quoteStatus)} (partyA=${log.truncAddr(quote.partyA)})`)
		}
	}

	// Scan tail: quotes (lastId - GAP_SCAN_RANGE + 1)..lastId
	const tailStart = onChainLastQuoteId > BigInt(GAP_SCAN_RANGE) ? onChainLastQuoteId - BigInt(GAP_SCAN_RANGE) + 1n : 1n
	for (let id = tailStart > headEnd ? tailStart : headEnd + 1n; id <= onChainLastQuoteId; id++) {
		gapsChecked++
		const quote = await rawGetQuote(DIAMOND_ADDRESS, id)
		if (quoteRequiresMigration(quote) && !quoteIdSet.has(id)) {
			gapsMissing++
			missingDetails.push(`  quote ${id}: ${statusName(quote.quoteStatus)} (partyA=${log.truncAddr(quote.partyA)})`)
		}
	}

	if (gapsMissing > 0) {
		log.error(`${gapsMissing} active quotes missing from migration input (out of ${gapsChecked} scanned):`)
		for (const detail of missingDetails) {
			log.info(detail)
		}
		failures++
	} else {
		log.ok(`${gapsChecked} quotes scanned — all active quotes are in migration input`)
	}
	log.stepDone(t)

	// ── Check 4: PartyB completeness ────────────────────────────────
	t = log.step("PartyB task completeness")
	let emptyPartyBs = 0
	const emptyPartyBAddresses: string[] = []
	for (const task of partyBTasks) {
		if (!task.partyAs || task.partyAs.length === 0) {
			emptyPartyBs++
			emptyPartyBAddresses.push(task.partyB)
		}
	}
	if (emptyPartyBs > 0) {
		log.error(
			`${emptyPartyBs} partyB tasks have empty partyAs arrays: ${emptyPartyBAddresses.slice(0, 3).join(", ")}${emptyPartyBAddresses.length > 3 ? "..." : ""}`,
		)
		failures++
	} else {
		log.ok(`All ${partyBTasks.length} partyB tasks have at least one partyA`)
	}

	// Check for duplicate partyBs
	const partyBAddresses = partyBTasks.map(t => t.partyB.toLowerCase())
	const partyBDupes = partyBAddresses.filter((addr, i) => partyBAddresses.indexOf(addr) !== i)
	if (partyBDupes.length > 0) {
		log.error(`Duplicate partyB entries: ${Array.from(new Set(partyBDupes)).join(", ")}`)
		failures++
	} else {
		log.ok(`No duplicate partyB entries`)
	}
	log.stepDone(t)

	// ── Check 5: PENDING quotes (zero-address partyB) ───────────────
	t = log.step("PENDING quotes with zero-address partyB")
	// PENDING quotes have partyB = address(0). They still need migration (fee reservation).
	// Sample a few from the input to verify they're genuinely pending.
	const sampleSize = Math.min(10, quoteIds.length)
	let pendingCount = 0
	let pendingWithPartyB = 0
	const checkedIds = new Set<number>()

	// Check first and last few quotes in the sorted input
	const indicesToCheck: number[] = []
	for (let i = 0; i < Math.min(sampleSize, quoteIds.length); i++) indicesToCheck.push(i)
	for (let i = Math.max(0, quoteIds.length - sampleSize); i < quoteIds.length; i++) {
		if (!indicesToCheck.includes(i)) indicesToCheck.push(i)
	}

	for (const idx of indicesToCheck) {
		if (checkedIds.has(idx)) continue
		checkedIds.add(idx)
		const quoteId = BigInt(quoteIds[idx])
		const quote = await rawGetQuote(DIAMOND_ADDRESS, quoteId)
		if (quote.quoteStatus === 0) {
			pendingCount++
			if (quote.partyB !== ethers.ZeroAddress) {
				pendingWithPartyB++
				log.warn(`Quote ${quoteId}: status=PENDING but partyB=${log.truncAddr(quote.partyB)} (expected zero address)`)
			}
		}
	}

	if (pendingWithPartyB > 0) {
		log.warn(`${pendingWithPartyB} PENDING quotes have non-zero partyB (unexpected)`)
	} else {
		log.ok(`${pendingCount} PENDING quotes checked — all have zero-address partyB as expected`)
	}
	log.stepDone(t)

	// ── Check 6: Quote-to-partyBTask consistency ───────────────────
	t = log.step("Quote-to-partyBTask consistency")
	// Every quote with a non-zero partyB must have its partyB-partyA pair in partyBTasks.
	// Otherwise migrateCrossLockedValues would miss that pair.
	const partyBTaskIndex = new Map<string, Set<string>>()
	for (const task of partyBTasks) {
		const pbKey = task.partyB.toLowerCase()
		if (!partyBTaskIndex.has(pbKey)) {
			partyBTaskIndex.set(pbKey, new Set())
		}
		for (const pa of task.partyAs) {
			partyBTaskIndex.get(pbKey)!.add(pa.toLowerCase())
		}
	}

	let missingPairs = 0
	for (const idx of indicesToCheck) {
		const quoteId = BigInt(quoteIds[idx])
		const quote = await rawGetQuote(DIAMOND_ADDRESS, quoteId)
		if (quote.partyB === ethers.ZeroAddress) continue
		const pbKey = quote.partyB.toLowerCase()
		const paKey = quote.partyA.toLowerCase()
		const partyASet = partyBTaskIndex.get(pbKey)
		if (!partyASet || !partyASet.has(paKey)) {
			log.error(`Quote ${quoteId}: partyB=${log.truncAddr(quote.partyB)} + partyA=${log.truncAddr(quote.partyA)} missing from partyBTasks`)
			missingPairs++
		}
	}
	if (missingPairs > 0) {
		log.error(`${missingPairs} quote partyB-partyA pairs missing from partyBTasks`)
		failures++
	} else {
		log.ok(`All sampled quotes have their partyB-partyA pair in partyBTasks`)
	}
	log.stepDone(t)

	// ── Summary ─────────────────────────────────────────────────────
	if (failures > 0) {
		log.failure(`Edge case validation failed — ${failures} issue(s) found`, "Fix the issues above and re-run prepareMigrationInput.ts")
		process.exitCode = 1
	} else {
		log.success("All edge case checks passed", [
			["Boundary quote", `${onChainLastQuoteId} (${statusName(boundaryQuote.quoteStatus)})`],
			["Gaps scanned", `${gapsChecked} quotes (head + tail)`],
			["PartyB tasks", `${partyBTasks.length}`],
			["Duration", scriptTimer.fmt()],
		])
	}
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
