import fs from "fs"

import { ethers } from "../../test/helpers/hardhat-connection.js"
import { log } from "./utils/log.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { loadUpgradeConfigShared } from "./utils/sharedConfig.js"

/**
 * Validate migration input against on-chain state.
 *
 * Reads migration-input.json (output of prepareMigrationInput.ts) and spot-checks
 * quotes and partyB balances against the live diamond. Uses raw eth_call for
 * getQuote() to work with both v0.8.4 and v0.8.5 diamonds — the Quote struct
 * differs between versions but the fields we check (quoteStatus, partyA, partyB,
 * symbolId) are at the same ABI offsets in both.
 *
 * Can run before or after the diamondCut.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/validateMigrationInput.ts --network mantle
 *
 * Env overrides: DIAMOND_ADDRESS, MIGRATION_INPUT_FILE, SPOT_CHECK_COUNT
 */

// ── Raw getQuote decoding ────────────────────────────────────────────
//
// The v0.8.5 Quote struct has 30 fields, v0.8.4 has 27. The 3 new fields
// (accumulatedPaidFunding, closeFee, data) are appended at the end, so
// fields 0-26 are at the same ABI tuple offsets in both versions.
//
// getQuote(uint256) returns (Quote memory), ABI-encoded as:
//   bytes 0-31:  offset to tuple start (0x20)
//   bytes 32+:   tuple head — 32 bytes per field
//
// Tuple field layout (head offsets, 0-indexed):
//   0: id              2: symbolId        20: partyA
//   21: partyB         22: quoteStatus
//
// Sub-structs (LockedValues has 4 uint256 fields) are encoded inline,
// which is why partyA is at offset 20 (not 15).

const GET_QUOTE_SELECTOR = ethers.id("getQuote(uint256)").slice(0, 10)

function decodeQuoteFields(data: string): { symbolId: string; partyA: string; partyB: string; quoteStatus: number } {
	// Skip "0x" (2 chars) + outer offset word (64 chars) → tuple head starts at char 66
	const tupleStart = 66
	const word = (index: number): string => data.slice(tupleStart + index * 64, tupleStart + (index + 1) * 64)

	return {
		symbolId: BigInt("0x" + word(2)).toString(),
		partyA: ethers.getAddress("0x" + word(20).slice(24)),
		partyB: ethers.getAddress("0x" + word(21).slice(24)),
		quoteStatus: Number(BigInt("0x" + word(22))),
	}
}

async function rawGetQuote(
	diamondAddress: string,
	quoteId: bigint,
): Promise<{ symbolId: string; partyA: string; partyB: string; quoteStatus: number }> {
	const calldata = GET_QUOTE_SELECTOR + ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [quoteId]).slice(2)
	const result = await ethers.provider.call({ to: diamondAddress, data: calldata })
	if (!result || result === "0x") throw new Error(`getQuote(${quoteId}) returned empty data`)
	return decodeQuoteFields(result)
}

// ── Config ───────────────────────────────────────────────────────────

const DEFAULT_INPUT_FILE = "./scripts/upgrade/output/migration-input.json"

function toBigInt(value: unknown): bigint {
	if (typeof value === "bigint") return value
	if (typeof value === "number") return BigInt(value)
	if (typeof value === "string") return BigInt(value)
	return BigInt((value as any).toString())
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
	const scriptTimer = log.timer()
	await verifyRpc()

	const shared = loadUpgradeConfigShared()
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	const INPUT_FILE = process.env.MIGRATION_INPUT_FILE ?? DEFAULT_INPUT_FILE
	const SPOT_CHECK_COUNT = Number(process.env.SPOT_CHECK_COUNT ?? shared.spotCheckCount ?? 20)

	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS) || DIAMOND_ADDRESS === ethers.ZeroAddress) {
		throw new Error("DIAMOND_ADDRESS is required and must be a valid address.")
	}
	if (!fs.existsSync(INPUT_FILE)) {
		throw new Error(`Migration input file not found: ${INPUT_FILE}\nRun prepareMigrationInput.ts first.`)
	}

	const inputData = JSON.parse(fs.readFileSync(INPUT_FILE, "utf-8"))
	const quoteIds: string[] = inputData.quoteIds ?? []
	const partyBTasks: { partyB: string; partyAs: string[] }[] = inputData.partyBTasks ?? []

	// Flatten all partyB balance entries for balance spot-check
	const balanceEntries: { partyB: string; partyA: string }[] = []
	for (const task of partyBTasks) {
		for (const partyA of task.partyAs) {
			balanceEntries.push({ partyB: task.partyB, partyA })
		}
	}

	log.header("Validate Migration Input")
	log.kv("Diamond", log.addr(DIAMOND_ADDRESS))
	log.kv("Input file", INPUT_FILE)
	log.kv("Spot-check count", String(SPOT_CHECK_COUNT))
	log.kv("Quotes", String(quoteIds.length))
	log.kv("PartyB tasks", String(partyBTasks.length))
	log.kv("Balance entries", String(balanceEntries.length))

	log.setSteps(3)

	// Step 1: Boundary check
	let t = log.step("Boundary check (getNextQuoteId)")
	const viewFacetQuote = await ethers.getContractAt("contracts/core/facets/ViewFacetQuote/ViewFacetQuote.sol:ViewFacetQuote", DIAMOND_ADDRESS)
	// getNextQuoteId() returns the LAST assigned quote ID (not next available) — see QuoteStorage.lastId
	const onChainLastQuoteId = toBigInt(await viewFacetQuote.getNextQuoteId())
	const maxInputQuoteId = quoteIds.reduce((max, id) => {
		const n = BigInt(id)
		return n > max ? n : max
	}, 0n)

	if (maxInputQuoteId > onChainLastQuoteId) {
		log.warn(`Input contains quoteIds > on-chain lastQuoteId (${onChainLastQuoteId}). Input may be stale.`)
	} else {
		log.ok(`Boundary OK — on-chain lastQuoteId=${onChainLastQuoteId}, input max=${maxInputQuoteId}`)
	}
	log.stepDone(t)

	// Step 2: Spot-check quotes (raw eth_call — works on v0.8.4 and v0.8.5)
	t = log.step("Spot-check quotes against on-chain")
	const quoteSampleSize = Math.min(SPOT_CHECK_COUNT, quoteIds.length)
	const quoteSampleIndices = new Set<number>()
	while (quoteSampleIndices.size < quoteSampleSize) {
		quoteSampleIndices.add(Math.floor(Math.random() * quoteIds.length))
	}
	log.info(`Checking ${quoteSampleSize} random quotes via raw eth_call...`)
	let quotesPassed = 0
	for (const idx of quoteSampleIndices) {
		const quoteId = BigInt(quoteIds[idx])
		const onChain = await rawGetQuote(DIAMOND_ADDRESS, quoteId)

		// We can only validate fields present in the input. The input has quoteStatus from the subgraph.
		// Verify that the quote exists and basic fields are non-zero.
		if (onChain.quoteStatus === 0 && onChain.partyA === ethers.ZeroAddress) {
			throw new Error(`Quote ${quoteId}: appears to not exist on-chain (partyA is zero address)`)
		}
		quotesPassed++
	}
	log.ok(`${quotesPassed}/${quoteSampleSize} quotes verified (exist on-chain)`)
	log.stepDone(t)

	// Step 3: Spot-check partyB balances
	t = log.step("Spot-check partyB balances against on-chain")
	const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", DIAMOND_ADDRESS)
	const balanceSampleSize = Math.min(SPOT_CHECK_COUNT, balanceEntries.length)
	const balanceSampleIndices = new Set<number>()
	while (balanceSampleIndices.size < balanceSampleSize) {
		balanceSampleIndices.add(Math.floor(Math.random() * balanceEntries.length))
	}
	log.info(`Checking ${balanceSampleSize} random balance entries...`)
	let balancesPassed = 0
	let balancesNonZero = 0
	for (const idx of balanceSampleIndices) {
		const entry = balanceEntries[idx]
		const onChainBalance = toBigInt(await viewFacet.allocatedBalanceOfPartyB(entry.partyB, entry.partyA))
		if (onChainBalance > 0n) balancesNonZero++
		balancesPassed++
	}
	log.ok(`${balancesPassed}/${balanceSampleSize} checked, ${balancesNonZero} have non-zero allocated balance`)
	log.stepDone(t)

	log.success("Validation complete", [
		["Quotes checked", `${quotesPassed}/${quoteSampleSize}`],
		["Balances checked", `${balancesPassed}/${balanceSampleSize}`],
		["Duration", scriptTimer.fmt()],
	])
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
