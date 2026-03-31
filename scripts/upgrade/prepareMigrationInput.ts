import fs from "fs"
import path from "path"

import { ethers } from "../../test/helpers/hardhat-connection.js"
import { log } from "./utils/log.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { loadUpgradeConfigShared } from "./utils/sharedConfig.js"
import { fetchOpenQuotes, fetchPartyBBalances } from "./utils/subgraphHelpers.js"

/**
 * Prepare migration input from subgraph data.
 *
 * Fetches open quotes and partyB balances from the subgraph, validates the
 * boundary against on-chain getNextQuoteId(), and writes a JSON file for
 * runMigration.ts. Can run before or after the diamondCut.
 *
 * For on-chain spot-check validation, run validateMigrationInput.ts separately.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/prepareMigrationInput.ts --network mantle
 *
 * Config:
 *   cp scripts/upgrade/config/samples/prepareMigration.sample.json scripts/upgrade/config/prepareMigration.json
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
	balanceSnapshot?: {
		partyA: Record<string, { deposit: string; allocated: string }>
		partyB: Record<string, { deposit: string; allocatedTotal: string }>
		summary: {
			partyA: {
				count: number
				totalDeposit: string
				totalAllocated: string
				totalFunds: string
				topDeposit: { address: string; amount: string }
				topAllocated: { address: string; amount: string }
			}
			partyB: {
				count: number
				totalDeposit: string
				totalAllocated: string
				totalFunds: string
				topDeposit: { address: string; amount: string }
				topAllocated: { address: string; amount: string }
			}
		}
	}
	error?: string
}

const CONFIG_FILE = process.env.PREPARE_MIGRATION_CONFIG_FILE ?? "./scripts/upgrade/config/prepareMigration.json"

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
		log.error(`Failed to write report: ${formatError(error)}`)
	}
}

function toBigInt(value: unknown): bigint {
	if (typeof value === "bigint") return value
	if (typeof value === "number") return BigInt(value)
	if (typeof value === "string") return BigInt(value)
	return BigInt((value as any).toString())
}

async function main() {
	const scriptTimer = log.timer()
	await verifyRpc()
	const startedAtMs = Date.now()
	const config = loadConfig()

	const shared = loadUpgradeConfigShared()
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress ?? shared.diamondAddress
	const SUBGRAPH_ENDPOINT = process.env.SUBGRAPH_ENDPOINT || config.subgraphEndpoint || shared.subgraphEndpoint || DEFAULT_SUBGRAPH_ENDPOINT
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

		log.header("Prepare Migration Input")
		log.kv("Diamond", log.addr(DIAMOND_ADDRESS))
		log.kv("Subgraph", SUBGRAPH_ENDPOINT)

		log.setSteps(5)

		// Step 1: Fetch open quotes from subgraph
		let t = log.step("Fetch open quotes from subgraph")
		currentStep = "fetch_open_quotes"
		const quotesResult = await fetchOpenQuotes(SUBGRAPH_ENDPOINT)
		log.stats([
			["Open quotes", quotesResult.quotes.length],
			["Unique partyAs", quotesResult.partyAs.length],
			["Unique partyBs", quotesResult.partyBs.length],
		])
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
		log.stepDone(t)

		// Step 2: Fetch partyB balances from subgraph
		t = log.step("Fetch partyB balances from subgraph")
		currentStep = "fetch_partyb_balances"
		const balancesResult = await fetchPartyBBalances(SUBGRAPH_ENDPOINT)
		log.stats([
			["Balance entries", balancesResult.entries.length],
			["Distinct partyBs", balancesResult.partyBs.length],
		])
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
		log.stepDone(t)

		// Step 3: Validate against on-chain -- boundary check
		t = log.step("Validate boundary against on-chain")
		currentStep = "validate_boundary"
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
			log.warn(`Subgraph ahead of on-chain (max=${maxSubgraphQuoteId}, nextQuoteId=${onChainNextQuoteId}). Filtered ${dropped} quotes.`)
		} else {
			log.ok(`Boundary check passed — on-chain nextQuoteId=${onChainNextQuoteId}, subgraph max=${maxSubgraphQuoteId}`)
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
		log.stepDone(t)

		// Step 4: Build migration input
		t = log.step("Build migration input")
		currentStep = "build_input"

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
		// Only OPENED(4), CLOSE_PENDING(5), CANCEL_CLOSE_PENDING(6) get aggregated positions.
		// PENDING(0), LOCKED(1), CANCEL_PENDING(2) only get fee reservation — no aggregated positions.
		const expectedAggregates: Record<string, { long: string; short: string }> = {}
		for (const q of quotesResult.quotes) {
			if (q.quoteStatus !== 4 && q.quoteStatus !== 5 && q.quoteStatus !== 6) continue
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
			},
			quoteIds,
			partyBTasks,
			expectedAggregates,
		}

		writeJson(outputFile, output)
		log.ok(`Written to ${outputFile}`)
		log.stats([
			["Quote IDs", quoteIds.length],
			["PartyB tasks", partyBTasks.length],
			["Aggregate keys", Object.keys(expectedAggregates).length],
		])
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
		log.stepDone(t)

		// Step 5: Snapshot on-chain balances (report-only)
		t = log.step("Snapshot on-chain balances")
		currentStep = "snapshot_balances"

		const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", DIAMOND_ADDRESS)

		// Collect unique partyAs from quotes + balance entries
		const allPartyAs = new Set<string>()
		for (const q of quotesResult.quotes) allPartyAs.add(q.partyA)
		for (const e of balancesResult.entries) allPartyAs.add(e.counterParty)
		const partyAList = [...allPartyAs].sort()

		// PartyA balances: deposit + allocated
		const partyABalances: Record<string, { deposit: string; allocated: string }> = {}
		log.info(`Fetching balances for ${partyAList.length} partyAs...`)
		for (const partyA of partyAList) {
			const [deposit, allocated] = await Promise.all([
				viewFacet.balanceOf(partyA).then(toBigInt),
				viewFacet.allocatedBalanceOfPartyA(partyA).then(toBigInt),
			])
			partyABalances[partyA] = { deposit: deposit.toString(), allocated: allocated.toString() }
		}

		// PartyB balances: deposit + total allocated (sum from subgraph entries)
		const partyBList = [...new Set(balancesResult.entries.map(e => e.account))].sort()
		const partyBAllocatedSums = new Map<string, bigint>()
		for (const e of balancesResult.entries) {
			partyBAllocatedSums.set(e.account, (partyBAllocatedSums.get(e.account) ?? 0n) + BigInt(e.allocatedBalance))
		}

		const partyBBalances: Record<string, { deposit: string; allocatedTotal: string }> = {}
		log.info(`Fetching balances for ${partyBList.length} partyBs...`)
		for (const partyB of partyBList) {
			const deposit = toBigInt(await viewFacet.balanceOf(partyB))
			partyBBalances[partyB] = {
				deposit: deposit.toString(),
				allocatedTotal: (partyBAllocatedSums.get(partyB) ?? 0n).toString(),
			}
		}

		// Compute summaries
		let partyATotalDeposit = 0n
		let partyATotalAllocated = 0n
		let partyATopDeposit = { address: "", amount: 0n }
		let partyATopAllocated = { address: "", amount: 0n }
		for (const [addr, bal] of Object.entries(partyABalances)) {
			const dep = BigInt(bal.deposit)
			const alloc = BigInt(bal.allocated)
			partyATotalDeposit += dep
			partyATotalAllocated += alloc
			if (dep > partyATopDeposit.amount) partyATopDeposit = { address: addr, amount: dep }
			if (alloc > partyATopAllocated.amount) partyATopAllocated = { address: addr, amount: alloc }
		}

		let partyBTotalDeposit = 0n
		let partyBTotalAllocated = 0n
		let partyBTopDeposit = { address: "", amount: 0n }
		let partyBTopAllocated = { address: "", amount: 0n }
		for (const [addr, bal] of Object.entries(partyBBalances)) {
			const dep = BigInt(bal.deposit)
			const alloc = BigInt(bal.allocatedTotal)
			partyBTotalDeposit += dep
			partyBTotalAllocated += alloc
			if (dep > partyBTopDeposit.amount) partyBTopDeposit = { address: addr, amount: dep }
			if (alloc > partyBTopAllocated.amount) partyBTopAllocated = { address: addr, amount: alloc }
		}

		const balanceSummary = {
			partyA: {
				count: partyAList.length,
				totalDeposit: partyATotalDeposit.toString(),
				totalAllocated: partyATotalAllocated.toString(),
				totalFunds: (partyATotalDeposit + partyATotalAllocated).toString(),
				topDeposit: { address: partyATopDeposit.address, amount: partyATopDeposit.amount.toString() },
				topAllocated: { address: partyATopAllocated.address, amount: partyATopAllocated.amount.toString() },
			},
			partyB: {
				count: partyBList.length,
				totalDeposit: partyBTotalDeposit.toString(),
				totalAllocated: partyBTotalAllocated.toString(),
				totalFunds: (partyBTotalDeposit + partyBTotalAllocated).toString(),
				topDeposit: { address: partyBTopDeposit.address, amount: partyBTopDeposit.amount.toString() },
				topAllocated: { address: partyBTopAllocated.address, amount: partyBTopAllocated.amount.toString() },
			},
		}

		log.ok(`${partyAList.length} partyAs, ${partyBList.length} partyBs snapshotted`)
		log.stats([
			["PartyA total funds", `deposit=${partyATotalDeposit} + allocated=${partyATotalAllocated}`],
			["PartyA top deposit", `${log.truncAddr(partyATopDeposit.address)} = ${partyATopDeposit.amount}`],
			["PartyA top allocated", `${log.truncAddr(partyATopAllocated.address)} = ${partyATopAllocated.amount}`],
			["PartyB total funds", `deposit=${partyBTotalDeposit} + allocated=${partyBTotalAllocated}`],
			["PartyB top deposit", `${log.truncAddr(partyBTopDeposit.address)} = ${partyBTopDeposit.amount}`],
			["PartyB top allocated", `${log.truncAddr(partyBTopAllocated.address)} = ${partyBTopAllocated.amount}`],
		])
		report.steps.push({
			name: "snapshot_balances",
			status: "ok",
			details: { partyACount: partyAList.length, partyBCount: partyBList.length },
		})
		report.balanceSnapshot = { partyA: partyABalances, partyB: partyBBalances, summary: balanceSummary }
		currentStep = null
		tryWriteReport(reportFile, report)
		log.stepDone(t)

		report.status = "success"

		log.success("Migration input preparation completed", [
			["Output", outputFile],
			["Duration", scriptTimer.fmt()],
		])
		log.nextSteps([
			"Run validateMigrationInput.ts to spot-check against on-chain (works on v0.8.4 and v0.8.5)",
			"Run runMigration.ts after the diamondCut is applied",
		])
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
		log.failure("Migration input preparation failed", `Step: ${currentStep ?? "unknown"}\n  ${formatError(error)}`)
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
