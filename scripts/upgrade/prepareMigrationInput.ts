import fs from "fs"
import path from "path"

import { atomicWriteFile } from "../../tasks/utils/fs.js"
import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { loadDeployedFacetsForNetwork } from "./utils/deployedFacets.js"
import { log } from "./utils/log.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { baseNetworkName, loadUpgradeConfigShared, resolveConfigFile } from "./utils/sharedConfig.js"
import { createStepReporter } from "./utils/stepReporter.js"
import { deleteOpenQuotesProgress, fetchOpenQuotes } from "./utils/subgraphHelpers.js"

/**
 * Prepare migration input from subgraph data.
 *
 * Fetches open quotes and partyB balances from the subgraph, validates the
 * boundary against on-chain getNextQuoteId(), derives PartyB tasks from
 * paused on-chain quote fields, and writes a JSON file for runMigration.ts.
 * Operational runbooks should run this after pause; it can run before or
 * after the diamondCut.
 *
 * Critical-path script: kept short and reliable so it can run during the
 * pause window. Optional checks (on-chain balance snapshot, on-chain spot
 * checks) live in separate scripts:
 *   - snapshotBalances.ts          on-chain balance snapshot for sanity-checking totals
 *   - validateMigrationInput.ts    on-chain spot-check of quotes/balances
 *
 * Usage:
 *   ./node_modules/.bin/hardhat run scripts/upgrade/prepareMigrationInput.ts --network mantle
 *
 * Config:
 *   cp scripts/upgrade/config/samples/prepareMigration.sample.json scripts/upgrade/config/prepareMigration.json
 *   A chain-specific subgraphEndpoint/subgraphEndpoints value is required.
 *
 * Output:
 *   scripts/upgrade/output/migration-input-{network}.json
 *   (network suffix derived from --network flag, with "fork-" stripped; or NETWORK_ALIAS env var)
 */

type PrepareConfig = {
	diamondAddress?: string
	subgraphEndpoint?: string
	subgraphEndpoints?: string[]
	subgraphPageSize?: number
	subgraphProgressFile?: string
	spotCheckCount?: number
	outputFile?: string
	outputDir?: string
	deployedFacetsFile?: string
}

type StepResult = {
	name: string
	status: "ok" | "error"
	startedAt?: string
	finishedAt?: string
	durationMs?: number
	details?: Record<string, unknown>
}

type PrepareReport = {
	status: "running" | "success" | "failed"
	startedAt: string
	finishedAt?: string
	durationMs?: number
	diamondAddress?: string
	deployedFacetsFile?: string
	subgraphEndpoint?: string
	subgraphEndpoints?: string[]
	subgraphProgressFile?: string
	steps: StepResult[]
	error?: string
}

function loadConfig(networkName?: string): PrepareConfig {
	const CONFIG_FILE = resolveConfigFile("prepareMigration", networkName, process.env.PREPARE_MIGRATION_CONFIG_FILE)
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
	atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function tryWriteFailureReport(filePath: string, report: PrepareReport): void {
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

function parseOptionalPositiveInt(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`Expected positive integer, got: ${value}`)
	}
	return parsed
}

function parseStringList(value: unknown): string[] | undefined {
	if (value === undefined || value === null || value === "") return undefined
	const items = Array.isArray(value) ? value : String(value).split(",")
	const parsed = items.map(item => String(item).trim()).filter(Boolean)
	return parsed.length > 0 ? parsed : undefined
}

function requireSubgraphEndpoints(endpoints: string[] | undefined, networkName: string | undefined): string[] {
	if (!endpoints || endpoints.length === 0) {
		throw new Error(
			`No subgraph endpoint configured for network ${networkName ?? "unknown"}. ` +
				"Set SUBGRAPH_ENDPOINTS/SUBGRAPH_ENDPOINT or configure the chain-specific prepareMigration/upgrade file.",
		)
	}

	for (const endpoint of endpoints) {
		let url: URL
		try {
			url = new URL(endpoint)
		} catch {
			throw new Error(`Invalid subgraph endpoint URL: ${endpoint}`)
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			throw new Error(`Subgraph endpoint must use http or https: ${endpoint}`)
		}
	}
	return endpoints
}

const FEE_RESERVATION_STATUSES = new Set([0, 1, 2])
const ACTIVE_POSITION_STATUSES = new Set([4, 5, 6])
const GET_QUOTE_SELECTOR = ethers.id("getQuote(uint256)").slice(0, 10)

type MigrationQuoteFields = {
	quoteId: string
	partyA: string
	partyB: string
	symbolId: string
	positionType: number
	quantity: string
	closedAmount: string
	quoteStatus: number
}

function quoteOpenAmount(quote: { quantity: string; closedAmount: string }): bigint {
	return BigInt(quote.quantity) - BigInt(quote.closedAmount)
}

function shouldIncludeQuoteForMigration(quote: { quoteStatus: number; quantity: string; closedAmount: string }): boolean {
	if (FEE_RESERVATION_STATUSES.has(quote.quoteStatus)) return true
	if (!ACTIVE_POSITION_STATUSES.has(quote.quoteStatus)) return false
	return quoteOpenAmount(quote) > 0n
}

function decodeQuoteFields(quoteId: string, data: string): MigrationQuoteFields {
	const tupleStart = 66
	const word = (index: number): string => data.slice(tupleStart + index * 64, tupleStart + (index + 1) * 64)
	const wordBig = (index: number): bigint => BigInt("0x" + word(index))

	return {
		quoteId,
		symbolId: wordBig(2).toString(),
		positionType: Number(wordBig(3)),
		quantity: wordBig(9).toString(),
		closedAmount: wordBig(10).toString(),
		partyA: ethers.getAddress("0x" + word(20).slice(24)),
		partyB: ethers.getAddress("0x" + word(21).slice(24)),
		quoteStatus: Number(wordBig(22)),
	}
}

async function rawGetQuote(diamondAddress: string, quoteId: string): Promise<MigrationQuoteFields> {
	const calldata =
		GET_QUOTE_SELECTOR +
		ethers.AbiCoder.defaultAbiCoder()
			.encode(["uint256"], [BigInt(quoteId)])
			.slice(2)
	const result = await ethers.provider.call({ to: diamondAddress, data: calldata })
	if (!result || result === "0x") throw new Error(`getQuote(${quoteId}) returned empty data`)
	return decodeQuoteFields(quoteId, result)
}

async function loadOnChainQuoteFields(diamondAddress: string, quoteIds: string[]): Promise<MigrationQuoteFields[]> {
	const quotes: MigrationQuoteFields[] = []
	for (let i = 0; i < quoteIds.length; i++) {
		quotes.push(await rawGetQuote(diamondAddress, quoteIds[i]))
		if ((i + 1) % 50 === 0 || i + 1 === quoteIds.length) {
			log.detail(`on-chain quote fields: ${i + 1}/${quoteIds.length}`)
		}
	}
	return quotes
}

function countSubgraphPairMismatches(subgraphQuotes: MigrationQuoteFields[], onChainQuotes: MigrationQuoteFields[]): number {
	const subgraphById = new Map(subgraphQuotes.map(q => [q.quoteId, q]))
	let mismatches = 0
	for (const onChain of onChainQuotes) {
		const subgraph = subgraphById.get(onChain.quoteId)
		if (!subgraph) continue
		const subgraphPartyA = ethers.isAddress(subgraph.partyA) ? ethers.getAddress(subgraph.partyA) : subgraph.partyA
		const subgraphPartyB =
			subgraph.partyB && ethers.isAddress(subgraph.partyB) ? ethers.getAddress(subgraph.partyB) : (subgraph.partyB ?? ethers.ZeroAddress)
		if (subgraphPartyA !== onChain.partyA || subgraphPartyB !== onChain.partyB) mismatches++
	}
	return mismatches
}

async function main() {
	const scriptTimer = log.timer()
	await verifyRpc()
	const startedAtMs = Date.now()
	// Base chain name (fork-base -> base) so artifacts don't collide across networks.
	const networkSuffix = baseNetworkName(connection.networkName)
	const withSuffix = (baseName: string): string => (networkSuffix ? `${baseName}-${networkSuffix}.json` : `${baseName}.json`)

	const config = loadConfig(networkSuffix)
	if (config.deployedFacetsFile !== undefined && config.deployedFacetsFile !== "" && typeof config.deployedFacetsFile !== "string") {
		throw new Error("deployedFacetsFile must be a string path.")
	}
	const shared = loadUpgradeConfigShared(networkSuffix)
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress ?? shared.diamondAddress
	const SUBGRAPH_ENDPOINTS = requireSubgraphEndpoints(
		parseStringList(process.env.SUBGRAPH_ENDPOINTS) ??
			parseStringList(process.env.SUBGRAPH_ENDPOINT) ??
			parseStringList(config.subgraphEndpoints) ??
			parseStringList(config.subgraphEndpoint) ??
			parseStringList(shared.subgraphEndpoints) ??
			parseStringList(shared.subgraphEndpoint),
		networkSuffix,
	)
	const SUBGRAPH_PAGE_SIZE = parseOptionalPositiveInt(process.env.SUBGRAPH_PAGE_SIZE ?? config.subgraphPageSize)
	const outputDir = process.env.PREPARE_OUTPUT_DIR ?? config.outputDir ?? "./scripts/upgrade/output"
	const outputFile = process.env.PREPARE_OUTPUT_FILE ?? config.outputFile ?? `${outputDir}/${withSuffix("migration-input")}`
	const deployedFacetsFile =
		process.env.FACETS_FILE || process.env.DEPLOYED_FACETS_FILE || config.deployedFacetsFile || `${outputDir}/${withSuffix("deployed-facets")}`
	const reportFile = `${outputDir}/${withSuffix("prepareMigrationInput-report")}`
	const resumeSubgraphFetch = process.env.SUBGRAPH_RESUME !== "false"
	const openQuotesProgressFile =
		process.env.SUBGRAPH_PROGRESS_FILE ?? config.subgraphProgressFile ?? `${outputDir}/${withSuffix("prepareMigrationInput-openQuotes-progress")}`

	const report: PrepareReport = {
		status: "running",
		startedAt: new Date(startedAtMs).toISOString(),
		steps: [],
	}
	writeJson(reportFile, report)
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
		report.diamondAddress = DIAMOND_ADDRESS
		report.deployedFacetsFile = deployedFacetsFile
		report.subgraphEndpoint = SUBGRAPH_ENDPOINTS[0]
		report.subgraphEndpoints = SUBGRAPH_ENDPOINTS
		report.subgraphProgressFile = openQuotesProgressFile
		report.steps.push({ name: "validate_inputs", status: "ok", details: { diamondAddress: DIAMOND_ADDRESS } })
		currentStep = null
		writeJson(reportFile, report)

		log.header("Prepare Migration Input")
		log.kv("Diamond", log.addr(DIAMOND_ADDRESS))
		if (SUBGRAPH_ENDPOINTS.length === 1) {
			log.kv("Subgraph", SUBGRAPH_ENDPOINTS[0])
		} else {
			log.kv("Subgraphs", `${SUBGRAPH_ENDPOINTS.length} endpoints`)
			SUBGRAPH_ENDPOINTS.forEach((endpoint, i) => log.detail(`${i + 1}. ${endpoint}`))
		}
		if (SUBGRAPH_PAGE_SIZE) log.kv("Subgraph page size", String(SUBGRAPH_PAGE_SIZE))
		log.kv("Subgraph resume", resumeSubgraphFetch ? "enabled" : "disabled")
		if (resumeSubgraphFetch) log.kv("Progress file", openQuotesProgressFile)
		log.kv("Deployed facets", deployedFacetsFile)

		log.setSteps(3)

		// Step 1: Fetch open quotes from subgraph
		let t = log.step("Fetch open quotes from subgraph")
		currentStep = "fetch_open_quotes"
		const quotesResult = await fetchOpenQuotes(SUBGRAPH_ENDPOINTS, {
			pageSize: SUBGRAPH_PAGE_SIZE,
			progressFile: openQuotesProgressFile,
			resume: resumeSubgraphFetch,
			keepProgressOnComplete: true,
		})
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
				pageSize: SUBGRAPH_PAGE_SIZE ?? "default",
				endpointsCount: SUBGRAPH_ENDPOINTS.length,
				progressFile: openQuotesProgressFile,
				resume: resumeSubgraphFetch,
			},
		})
		currentStep = null
		writeJson(reportFile, report)
		finishStep(t)

		// Step 2: Validate against on-chain -- boundary check
		t = log.step("Validate boundary against on-chain")
		currentStep = "validate_boundary"
		const viewFacetQuote = await ethers.getContractAt("contracts/core/facets/ViewFacetQuote/ViewFacetQuote.sol:ViewFacetQuote", DIAMOND_ADDRESS)
		// getNextQuoteId() returns the LAST assigned quote ID (not next available) — see QuoteStorage.lastId
		const onChainLastQuoteId = toBigInt(await viewFacetQuote.getNextQuoteId())
		const maxSubgraphQuoteId = quotesResult.quotes.reduce((max, q) => {
			const id = BigInt(q.quoteId)
			return id > max ? id : max
		}, 0n)

		if (maxSubgraphQuoteId > onChainLastQuoteId) {
			const before = quotesResult.quotes.length
			quotesResult.quotes = quotesResult.quotes.filter(q => BigInt(q.quoteId) <= onChainLastQuoteId)
			const dropped = before - quotesResult.quotes.length
			log.warn(
				`Subgraph has quotes beyond on-chain lastId (max=${maxSubgraphQuoteId}, lastId=${onChainLastQuoteId}). Likely a fork — filtered ${dropped} quotes.`,
			)
		} else {
			log.ok(`Boundary check passed — on-chain lastQuoteId=${onChainLastQuoteId}, subgraph max=${maxSubgraphQuoteId}`)
		}
		report.steps.push({
			name: "validate_boundary",
			status: "ok",
			details: {
				onChainLastQuoteId: onChainLastQuoteId.toString(),
				maxSubgraphQuoteId: maxSubgraphQuoteId.toString(),
			},
		})
		currentStep = null
		writeJson(reportFile, report)
		finishStep(t)

		// Step 3: Build migration input
		t = log.step("Build migration input")
		currentStep = "build_input"
		const deployedFacets = await loadDeployedFacetsForNetwork(
			deployedFacetsFile,
			{ networkName: networkSuffix, diamondAddress: DIAMOND_ADDRESS },
			{ required: false, validateMigrationSurface: true },
		)
		if (deployedFacets.summary.exists) {
			log.ok(`Deployed facets artifact found (${deployedFacets.summary.facetCount} facets, ${deployedFacets.summary.selectorCount} selectors)`)
		} else {
			log.warn(`Deployed facets artifact not found yet: ${deployedFacetsFile}`)
		}

		// Quote IDs
		const zeroOpenActiveQuotes = quotesResult.quotes.filter(q => ACTIVE_POSITION_STATUSES.has(q.quoteStatus) && quoteOpenAmount(q) <= 0n)
		if (zeroOpenActiveQuotes.length > 0) {
			log.warn(
				`Skipping ${zeroOpenActiveQuotes.length} active-status quote(s) with zero open amount: ` +
					`${zeroOpenActiveQuotes
						.slice(0, 10)
						.map(q => q.quoteId)
						.join(", ")}${zeroOpenActiveQuotes.length > 10 ? "..." : ""}`,
			)
		}
		const subgraphQuotesForMigration = quotesResult.quotes.filter(shouldIncludeQuoteForMigration)
		const candidateQuoteIds = subgraphQuotesForMigration
			.map(q => q.quoteId)
			.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))

		// The subgraph is used to discover candidate quote IDs, but the paused
		// diamond is the source of truth for partyA/partyB pairs and aggregate
		// fields. This prevents stale subgraph fields from producing incomplete
		// partyBTasks during fork rehearsals or live pause windows.
		log.info(`Reading ${candidateQuoteIds.length} selected quote(s) from on-chain getQuote()...`)
		const onChainCandidateQuotes = await loadOnChainQuoteFields(DIAMOND_ADDRESS, candidateQuoteIds)
		const subgraphPairMismatches = countSubgraphPairMismatches(
			subgraphQuotesForMigration.map(q => ({
				...q,
				partyB: q.partyB ?? ethers.ZeroAddress,
			})),
			onChainCandidateQuotes,
		)
		if (subgraphPairMismatches > 0) {
			log.warn(`${subgraphPairMismatches} selected quote(s) had subgraph partyA/partyB drift; using on-chain fields`)
		}

		const quotesForMigration = onChainCandidateQuotes.filter(shouldIncludeQuoteForMigration)
		if (quotesForMigration.length !== onChainCandidateQuotes.length) {
			log.warn(`Filtered ${onChainCandidateQuotes.length - quotesForMigration.length} selected quote(s) after on-chain status/open-amount check`)
		}
		const quoteIds = quotesForMigration.map(q => q.quoteId).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))

		// PartyB tasks derived from active quotes (not from all historical balance entries).
		// Only partyB-partyA pairs with active quotes have non-zero locked values to migrate.
		// PENDING quotes have partyB = address(0) and don't contribute to partyB locked values.
		const partyBTaskMap = new Map<string, Set<string>>()
		for (const q of quotesForMigration) {
			if (!q.partyB || q.partyB === "0x0000000000000000000000000000000000000000") continue
			if (!partyBTaskMap.has(q.partyB)) {
				partyBTaskMap.set(q.partyB, new Set())
			}
			partyBTaskMap.get(q.partyB)!.add(q.partyA)
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
		for (const q of quotesForMigration) {
			if (q.quoteStatus !== 4 && q.quoteStatus !== 5 && q.quoteStatus !== 6) continue
			const openAmount = quoteOpenAmount(q)
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
			deployedFacetsFile,
			deployedFacets: deployedFacets.summary,
			subgraphEndpoint: SUBGRAPH_ENDPOINTS[0],
			subgraphEndpoints: SUBGRAPH_ENDPOINTS,
			validation: {
				onChainLastQuoteId: onChainLastQuoteId.toString(),
				maxSubgraphQuoteId: maxSubgraphQuoteId.toString(),
			},
			skippedQuoteIds: {
				zeroOpenActive: zeroOpenActiveQuotes.map(q => q.quoteId),
			},
			quoteIds,
			partyBTasks,
			expectedAggregates,
		}

		writeJson(outputFile, output)
		deleteOpenQuotesProgress(openQuotesProgressFile)
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
		writeJson(reportFile, report)
		finishStep(t)

		report.status = "success"
		report.finishedAt = new Date().toISOString()
		report.durationMs = Date.now() - startedAtMs
		writeJson(reportFile, report)

		log.success("Migration input preparation completed", [
			["Output", outputFile],
			["Duration", scriptTimer.fmt()],
		])
		log.nextSteps([
			"Run validateMigrationInput.ts to spot-check quotes and balances against on-chain",
			"Run validateMigrationEdgeCases.ts to verify boundary quote, fork drift, and gaps",
			"Run snapshotBalances.ts (optional) to capture on-chain balance snapshot",
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
		report.finishedAt = new Date().toISOString()
		report.durationMs = Date.now() - startedAtMs
		tryWriteFailureReport(reportFile, report)
		log.failure("Migration input preparation failed", `Step: ${currentStep ?? "unknown"}\n  ${formatError(error)}`)
		throw error
	}
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
