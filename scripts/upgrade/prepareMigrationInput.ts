import fs from "fs"
import path from "path"

import { ethers } from "../../test/helpers/hardhat-connection.js"
import { fetchOpenQuotes, fetchPartyBBalances } from "./utils/subgraphHelpers.js"

/**
 * Prepare and validate migration input from subgraph data.
 *
 * Fetches open quotes and partyB balances from the subgraph, validates
 * against on-chain state, and writes a validated JSON file for migrateOnDemand.ts.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... SUBGRAPH_ENDPOINT=https://... npx hardhat run scripts/upgrade/prepareMigrationInput.ts --network localhost
 *
 * Config:
 *   Set in scripts/upgrade/config/forkUpgrade.json or env vars.
 *
 * Output:
 *   scripts/upgrade/output/migration-input.json
 */

const DEFAULT_SUBGRAPH_ENDPOINT = "https://api.goldsky.com/api/public/project_cm1hfr4527p0f01u85mz499u8/subgraphs/arbitrum_analytics/stage/gn"

type PrepareConfig = {
	diamondAddress?: string
	subgraphEndpoint?: string
	spotCheckCount?: number
	outputFile?: string
	outputDir?: string
}

type StepResult = {
	name: string
	status: "ok" | "error"
	details?: Record<string, unknown>
}

type PrepareReport = {
	status: "running" | "success" | "failed"
	startedAt: string
	finishedAt?: string
	durationMs?: number
	diamondAddress?: string
	subgraphEndpoint?: string
	steps: StepResult[]
	error?: string
}

const CONFIG_FILE = process.env.PREPARE_CONFIG_FILE ?? "./scripts/upgrade/config/forkUpgrade.json"

function loadConfig(): PrepareConfig {
	if (!fs.existsSync(CONFIG_FILE)) return {}
	const raw = fs.readFileSync(CONFIG_FILE, "utf-8")
	const data = JSON.parse(raw)
	if (!data || typeof data !== "object") throw new Error("Config must be a JSON object.")
	return data as PrepareConfig
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

function tryWriteReport(filePath: string, report: PrepareReport): void {
	try {
		writeJson(filePath, report)
	} catch (error) {
		console.error(`Failed to write report: ${formatError(error)}`)
	}
}

function toBigInt(value: unknown): bigint {
	if (typeof value === "bigint") return value
	if (typeof value === "number") return BigInt(value)
	if (typeof value === "string") return BigInt(value)
	return BigInt((value as any).toString())
}

async function main() {
	const startedAtMs = Date.now()
	const config = loadConfig()

	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
	const SUBGRAPH_ENDPOINT = process.env.SUBGRAPH_ENDPOINT ?? config.subgraphEndpoint ?? DEFAULT_SUBGRAPH_ENDPOINT
	const SPOT_CHECK_COUNT = Number(process.env.SPOT_CHECK_COUNT ?? config.spotCheckCount ?? 20)
	const outputDir = process.env.PREPARE_OUTPUT_DIR ?? config.outputDir ?? "./scripts/upgrade/output"
	const outputFile = process.env.PREPARE_OUTPUT_FILE ?? config.outputFile ?? `${outputDir}/migration-input.json`
	const reportFile = `${outputDir}/prepareMigrationInput-report.json`

	const report: PrepareReport = {
		status: "running",
		startedAt: new Date(startedAtMs).toISOString(),
		steps: [],
	}
	tryWriteReport(reportFile, report)
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
		report.diamondAddress = DIAMOND_ADDRESS
		report.subgraphEndpoint = SUBGRAPH_ENDPOINT
		report.steps.push({ name: "validate_inputs", status: "ok", details: { diamondAddress: DIAMOND_ADDRESS } })
		currentStep = null
		tryWriteReport(reportFile, report)

		console.log(`Diamond: ${DIAMOND_ADDRESS}`)
		console.log(`Subgraph: ${SUBGRAPH_ENDPOINT}`)
		console.log(`Spot-check count: ${SPOT_CHECK_COUNT}`)

		// Step 1: Fetch open quotes from subgraph
		currentStep = "fetch_open_quotes"
		console.log("\nFetching open quotes from subgraph...")
		const quotesResult = await fetchOpenQuotes(SUBGRAPH_ENDPOINT)
		console.log(`  ${quotesResult.quotes.length} open quotes, ${quotesResult.partyAs.length} partyAs, ${quotesResult.partyBs.length} partyBs`)
		report.steps.push({
			name: "fetch_open_quotes",
			status: "ok",
			details: {
				quotesCount: quotesResult.quotes.length,
				partyAsCount: quotesResult.partyAs.length,
				partyBsCount: quotesResult.partyBs.length,
			},
		})
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 2: Fetch partyB balances from subgraph
		currentStep = "fetch_partyb_balances"
		console.log("Fetching partyB balances from subgraph...")
		const balancesResult = await fetchPartyBBalances(SUBGRAPH_ENDPOINT)
		console.log(`  ${balancesResult.entries.length} partyB-partyA balance entries, ${balancesResult.partyBs.length} distinct partyBs`)
		report.steps.push({
			name: "fetch_partyb_balances",
			status: "ok",
			details: {
				entriesCount: balancesResult.entries.length,
				partyBsCount: balancesResult.partyBs.length,
			},
		})
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 3: Validate against on-chain -- boundary check
		currentStep = "validate_boundary"
		console.log("\nValidating against on-chain state...")
		const viewFacetQuote = await ethers.getContractAt("contracts/core/facets/ViewFacetQuote/ViewFacetQuote.sol:ViewFacetQuote", DIAMOND_ADDRESS)
		const onChainNextQuoteId = toBigInt(await viewFacetQuote.getNextQuoteId())
		const maxSubgraphQuoteId = quotesResult.quotes.reduce((max, q) => {
			const id = BigInt(q.quoteId)
			return id > max ? id : max
		}, 0n)

		if (maxSubgraphQuoteId >= onChainNextQuoteId) {
			const before = quotesResult.quotes.length
			quotesResult.quotes = quotesResult.quotes.filter(q => BigInt(q.quoteId) < onChainNextQuoteId)
			const dropped = before - quotesResult.quotes.length
			console.log(`  Subgraph ahead of on-chain (max quoteId=${maxSubgraphQuoteId}, nextQuoteId=${onChainNextQuoteId}). Filtered ${dropped} quotes.`)
		} else {
			console.log(`  Boundary check: on-chain nextQuoteId=${onChainNextQuoteId}, subgraph max quoteId=${maxSubgraphQuoteId} -- OK`)
		}
		report.steps.push({
			name: "validate_boundary",
			status: "ok",
			details: {
				onChainNextQuoteId: onChainNextQuoteId.toString(),
				maxSubgraphQuoteId: maxSubgraphQuoteId.toString(),
			},
		})
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 4: Validate against on-chain -- spot-check quotes
		currentStep = "validate_spot_check"
		const sampleSize = Math.min(SPOT_CHECK_COUNT, quotesResult.quotes.length)
		const sampleIndices = new Set<number>()
		while (sampleIndices.size < sampleSize) {
			sampleIndices.add(Math.floor(Math.random() * quotesResult.quotes.length))
		}
		console.log(`  Spot-checking ${sampleSize} quotes against on-chain...`)
		let spotCheckPassed = 0
		for (const idx of sampleIndices) {
			const subgraphQuote = quotesResult.quotes[idx]
			const quoteId = BigInt(subgraphQuote.quoteId)
			const onChainQuote = await viewFacetQuote.getQuote(quoteId)

			const onChainStatus = Number(onChainQuote.quoteStatus)
			const onChainPartyA = onChainQuote.partyA.toLowerCase()
			const onChainPartyB = onChainQuote.partyB.toLowerCase()
			const onChainSymbolId = toBigInt(onChainQuote.symbolId).toString()

			if (onChainStatus !== subgraphQuote.quoteStatus) {
				throw new Error(
					`Quote ${quoteId}: quoteStatus mismatch. On-chain=${onChainStatus}, subgraph=${subgraphQuote.quoteStatus}. Subgraph may not be synced.`,
				)
			}
			if (onChainPartyA !== subgraphQuote.partyA.toLowerCase()) {
				throw new Error(`Quote ${quoteId}: partyA mismatch. On-chain=${onChainPartyA}, subgraph=${subgraphQuote.partyA}`)
			}
			if (onChainPartyB !== subgraphQuote.partyB.toLowerCase()) {
				throw new Error(`Quote ${quoteId}: partyB mismatch. On-chain=${onChainPartyB}, subgraph=${subgraphQuote.partyB}`)
			}
			if (onChainSymbolId !== subgraphQuote.symbolId) {
				throw new Error(`Quote ${quoteId}: symbolId mismatch. On-chain=${onChainSymbolId}, subgraph=${subgraphQuote.symbolId}`)
			}
			spotCheckPassed++
		}
		console.log(`  Spot-check: ${spotCheckPassed}/${sampleSize} quotes verified -- OK`)
		report.steps.push({
			name: "validate_spot_check",
			status: "ok",
			details: { checked: spotCheckPassed, total: sampleSize },
		})
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 5: Validate partyB allocated balances against on-chain
		currentStep = "validate_partyb_balances"
		const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", DIAMOND_ADDRESS)
		const balanceSampleSize = Math.min(SPOT_CHECK_COUNT, balancesResult.entries.length)
		const balanceSampleIndices = new Set<number>()
		while (balanceSampleIndices.size < balanceSampleSize) {
			balanceSampleIndices.add(Math.floor(Math.random() * balancesResult.entries.length))
		}
		console.log(`  Spot-checking ${balanceSampleSize} partyB allocated balances against on-chain...`)
		let balanceCheckPassed = 0
		for (const idx of balanceSampleIndices) {
			const entry = balancesResult.entries[idx]
			const onChainBalance = toBigInt(await viewFacet.allocatedBalanceOfPartyB(entry.account, entry.counterParty))
			const subgraphBalance = BigInt(entry.allocatedBalance)
			if (onChainBalance !== subgraphBalance) {
				throw new Error(
					`PartyB ${entry.account} / PartyA ${entry.counterParty}: allocatedBalance mismatch. On-chain=${onChainBalance}, subgraph=${subgraphBalance}. Subgraph may not be synced.`,
				)
			}
			balanceCheckPassed++
		}
		console.log(`  Balance spot-check: ${balanceCheckPassed}/${balanceSampleSize} entries verified -- OK`)
		report.steps.push({
			name: "validate_partyb_balances",
			status: "ok",
			details: { checked: balanceCheckPassed, total: balanceSampleSize },
		})
		currentStep = null
		tryWriteReport(reportFile, report)

		// Step 6: Build migration input
		currentStep = "build_input"
		console.log("\nBuilding migration input...")

		// Quote IDs
		const quoteIds = quotesResult.quotes.map(q => q.quoteId).sort((a, b) => Number(BigInt(a) - BigInt(b)))

		// PartyB tasks from subgraph balances
		const partyBTaskMap = new Map<string, Set<string>>()
		for (const entry of balancesResult.entries) {
			if (!partyBTaskMap.has(entry.account)) {
				partyBTaskMap.set(entry.account, new Set())
			}
			partyBTaskMap.get(entry.account)!.add(entry.counterParty)
		}
		const partyBTasks = [...partyBTaskMap.entries()]
			.map(([partyB, partyAsSet]) => ({
				partyB,
				partyAs: [...partyAsSet].sort(),
			}))
			.sort((a, b) => a.partyB.localeCompare(b.partyB))

		// Expected aggregates for verification
		const expectedAggregates: Record<string, { long: string; short: string }> = {}
		for (const q of quotesResult.quotes) {
			const openAmount = BigInt(q.quantity) - BigInt(q.closedAmount)
			if (openAmount <= 0n) continue
			const key = `${q.partyB}-${q.partyA}-${q.symbolId}`
			if (!expectedAggregates[key]) {
				expectedAggregates[key] = { long: "0", short: "0" }
			}
			if (q.positionType === 0) {
				expectedAggregates[key].long = (BigInt(expectedAggregates[key].long) + openAmount).toString()
			} else {
				expectedAggregates[key].short = (BigInt(expectedAggregates[key].short) + openAmount).toString()
			}
		}

		const output = {
			generatedAt: new Date().toISOString(),
			diamondAddress: DIAMOND_ADDRESS,
			subgraphEndpoint: SUBGRAPH_ENDPOINT,
			validation: {
				onChainNextQuoteId: onChainNextQuoteId.toString(),
				maxSubgraphQuoteId: maxSubgraphQuoteId.toString(),
				quoteSpotChecks: spotCheckPassed,
				balanceSpotChecks: balanceCheckPassed,
			},
			quoteIds,
			partyBTasks,
			expectedAggregates,
		}

		writeJson(outputFile, output)
		console.log(`\nMigration input written to: ${outputFile}`)
		console.log(`  ${quoteIds.length} quote IDs`)
		console.log(`  ${partyBTasks.length} partyB tasks`)
		console.log(`  ${Object.keys(expectedAggregates).length} aggregate keys`)
		report.steps.push({
			name: "build_input",
			status: "ok",
			details: {
				outputFile,
				quoteIds: quoteIds.length,
				partyBTasks: partyBTasks.length,
				aggregateKeys: Object.keys(expectedAggregates).length,
			},
		})
		currentStep = null

		console.log("\nMigration input preparation completed successfully.")
		report.status = "success"
	} catch (error) {
		if (currentStep) {
			report.steps.push({
				name: currentStep,
				status: "error",
				details: { error: formatError(error) },
			})
		}
		report.status = "failed"
		report.error = formatError(error)
		tryWriteReport(reportFile, report)
		throw error
	} finally {
		report.finishedAt = new Date().toISOString()
		report.durationMs = Date.now() - startedAtMs
		tryWriteReport(reportFile, report)
	}
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
