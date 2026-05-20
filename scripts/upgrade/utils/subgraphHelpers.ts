/**
 * Subgraph data fetching utilities for migration input preparation and symbol management.
 *
 * Fetches open quotes, partyB balance data, and symbols from the Goldsky stage subgraph
 * with pagination (max 1000 per request).
 */
import fs from "fs"
import path from "path"

import { log } from "./log.js"

const DEFAULT_PAGE_SIZE = 1000
const DEFAULT_MIN_PAGE_SIZE = 10
const DEFAULT_MAX_RETRIES = 5
const DEFAULT_RETRY_DELAY_MS = 2000
const DEFAULT_TIMEOUT_MS = 60000
const ACTIVE_QUOTE_STATUSES = new Set([0, 1, 2, 4, 5, 6])

export type SubgraphEndpointInput = string | string[]

class SubgraphRequestError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly retriable = false,
	) {
		super(message)
		this.name = "SubgraphRequestError"
	}
}

type SubgraphQuote = {
	quoteId: string
	globalCounter: string
	timestamp: string
	partyA: string
	partyB: string | null
	symbolId: string
	positionType: number
	quantity: string
	closedAmount: string
	quoteStatus: number
}

type PartyBBalanceEntry = {
	account: string
	counterParty: string
	allocatedBalance: string
}

export type SubgraphOpenQuotesResult = {
	quotes: SubgraphQuote[]
	partyAs: string[]
	partyBs: string[]
}

export type FetchOpenQuotesOptions = {
	pageSize?: number
	progressFile?: string
	resume?: boolean
	keepProgressOnComplete?: boolean
}

type OpenQuotesProgress = {
	version: 3
	endpointKey: string
	startedAt: string
	updatedAt: string
	lastQuoteId: string
	lastGlobalCounter: string
	page: number
	pageSize: number
	quotes: SubgraphQuote[]
}

export type SubgraphPartyBBalancesResult = {
	entries: PartyBBalanceEntry[]
	partyBs: string[]
}

export type SubgraphSymbol = {
	id: string
	symbolId: string
	name: string
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback
	const parsed = Number(value)
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function subgraphPageSize(pageSize?: number): number {
	return pageSize ?? parsePositiveInt(process.env.SUBGRAPH_PAGE_SIZE, DEFAULT_PAGE_SIZE)
}

function minSubgraphPageSize(): number {
	return parsePositiveInt(process.env.SUBGRAPH_MIN_PAGE_SIZE, DEFAULT_MIN_PAGE_SIZE)
}

function maxSubgraphRetries(): number {
	return parsePositiveInt(process.env.SUBGRAPH_MAX_RETRIES, DEFAULT_MAX_RETRIES)
}

function subgraphRetryDelayMs(): number {
	return parsePositiveInt(process.env.SUBGRAPH_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS)
}

function subgraphTimeoutMs(): number {
	return parsePositiveInt(process.env.SUBGRAPH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

function isRetriableStatus(status: number): boolean {
	return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

function isRetriableGraphQLError(errors: unknown): boolean {
	const serialized = JSON.stringify(errors).toLowerCase()
	return (
		serialized.includes("store error") ||
		serialized.includes("database unavailable") ||
		serialized.includes("connection") ||
		serialized.includes("timeout") ||
		serialized.includes("temporarily unavailable")
	)
}

function isRetriableError(error: unknown): boolean {
	if (error instanceof SubgraphRequestError) return error.retriable
	if (error instanceof Error && error.name === "AbortError") return true
	return error instanceof TypeError
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message
	return String(error)
}

function asSubgraphError(error: unknown): Error {
	if (error instanceof Error) return error
	return new Error(String(error))
}

function normalizeSubgraphEndpoints(endpointInput: SubgraphEndpointInput): string[] {
	const rawEndpoints = Array.isArray(endpointInput) ? endpointInput : endpointInput.split(",")
	const endpoints = rawEndpoints.map(endpoint => endpoint.trim()).filter(Boolean)
	if (endpoints.length === 0) throw new Error("At least one subgraph endpoint is required.")
	return endpoints
}

function endpointKey(endpointInput: SubgraphEndpointInput): string {
	return normalizeSubgraphEndpoints(endpointInput).join("|")
}

function parseFetchOpenQuotesOptions(pageSizeOrOptions?: number | FetchOpenQuotesOptions): FetchOpenQuotesOptions {
	if (typeof pageSizeOrOptions === "number") return { pageSize: pageSizeOrOptions }
	return pageSizeOrOptions ?? {}
}

function isSubgraphQuote(value: unknown): value is SubgraphQuote {
	const quote = value as Partial<SubgraphQuote>
	return (
		!!quote &&
		typeof quote === "object" &&
		typeof quote.quoteId === "string" &&
		typeof quote.globalCounter === "string" &&
		typeof quote.timestamp === "string" &&
		typeof quote.partyA === "string" &&
		(typeof quote.partyB === "string" || quote.partyB === null) &&
		typeof quote.symbolId === "string" &&
		typeof quote.positionType === "number" &&
		typeof quote.quantity === "string" &&
		typeof quote.closedAmount === "string" &&
		typeof quote.quoteStatus === "number"
	)
}

function isOpenQuotesProgress(value: unknown): value is OpenQuotesProgress {
	const progress = value as Partial<OpenQuotesProgress>
	return (
		!!progress &&
		typeof progress === "object" &&
		progress.version === 3 &&
		typeof progress.endpointKey === "string" &&
		typeof progress.startedAt === "string" &&
		typeof progress.updatedAt === "string" &&
		typeof progress.lastQuoteId === "string" &&
		typeof progress.lastGlobalCounter === "string" &&
		typeof progress.page === "number" &&
		typeof progress.pageSize === "number" &&
		Array.isArray(progress.quotes) &&
		progress.quotes.every(isSubgraphQuote)
	)
}

function ensureParentDir(filePath: string): void {
	const dir = path.dirname(filePath)
	if (dir && dir !== "." && !fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true })
	}
}

function loadOpenQuotesProgress(progressFile: string, expectedEndpointKey: string): OpenQuotesProgress | undefined {
	if (!fs.existsSync(progressFile)) return undefined
	try {
		const parsed = JSON.parse(fs.readFileSync(progressFile, "utf-8"))
		if (!isOpenQuotesProgress(parsed)) {
			log.warn(`Ignoring invalid open-quotes progress file: ${progressFile}`)
			return undefined
		}
		if (parsed.endpointKey !== expectedEndpointKey) {
			log.warn("Open-quotes progress endpoint list differs from this run; resuming from saved globalCounter cursor anyway.")
		}
		return parsed
	} catch (error) {
		log.warn(`Ignoring unreadable open-quotes progress file ${progressFile}: ${errorMessage(error)}`)
		return undefined
	}
}

function writeOpenQuotesProgress(progressFile: string, progress: OpenQuotesProgress): void {
	ensureParentDir(progressFile)
	const tempFile = `${progressFile}.tmp`
	fs.writeFileSync(tempFile, JSON.stringify(progress, null, 2))
	fs.renameSync(tempFile, progressFile)
}

export function deleteOpenQuotesProgress(progressFile: string): void {
	try {
		if (fs.existsSync(progressFile)) fs.unlinkSync(progressFile)
	} catch (error) {
		log.warn(`Failed to remove open-quotes progress file ${progressFile}: ${errorMessage(error)}`)
	}
}

async function requestGraphQL(endpoint: string, query: string): Promise<any> {
	const controller = new AbortController()
	const timeoutMs = subgraphTimeoutMs()
	const timeout = setTimeout(() => controller.abort(), timeoutMs)
	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query }),
			signal: controller.signal,
		})
		if (!response.ok) {
			throw new SubgraphRequestError(
				`Subgraph request failed: ${response.status} ${response.statusText}`,
				response.status,
				isRetriableStatus(response.status),
			)
		}
		const json = await response.json()
		if (json.errors) {
			throw new SubgraphRequestError(`Subgraph query error: ${JSON.stringify(json.errors)}`, undefined, isRetriableGraphQLError(json.errors))
		}
		return json.data
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new SubgraphRequestError(`Subgraph request timed out after ${timeoutMs}ms: ${endpoint}`, undefined, true)
		}
		if (error instanceof TypeError) {
			throw new SubgraphRequestError(`Subgraph request failed before response from ${endpoint}: ${error.message}`, undefined, true)
		}
		throw error
	} finally {
		clearTimeout(timeout)
	}
}

async function fetchGraphQL(endpointInput: SubgraphEndpointInput, query: string): Promise<any> {
	const endpoints = normalizeSubgraphEndpoints(endpointInput)
	const maxAttempts = maxSubgraphRetries() + 1
	let lastError: unknown

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		for (let i = 0; i < endpoints.length; i++) {
			try {
				return await requestGraphQL(endpoints[i], query)
			} catch (error) {
				lastError = error
				if (!isRetriableError(error)) {
					throw asSubgraphError(error)
				}
				if (i < endpoints.length - 1) {
					log.detail(`Subgraph endpoint ${i + 1}/${endpoints.length} failed: ${errorMessage(error)}; trying next endpoint`)
				}
			}
		}

		if (attempt >= maxAttempts) throw asSubgraphError(lastError)

		const delayMs = subgraphRetryDelayMs() * attempt
		log.detail(`All subgraph endpoints failed (${attempt}/${maxAttempts - 1}): ${errorMessage(lastError)}; retrying in ${delayMs}ms`)
		await sleep(delayMs)
	}

	throw asSubgraphError(lastError)
}

function reducePageSize(currentPageSize: number): number {
	return Math.max(minSubgraphPageSize(), Math.floor(currentPageSize / 2))
}

function quoteFields(): string {
	return `
				quoteId
				globalCounter
				timestamp
				partyA
				partyB
				symbolId
				positionType
				quantity
				closedAmount
				quoteStatus`
}

async function fetchPageWithAdaptiveSize<T>(
	endpoint: SubgraphEndpointInput,
	entityName: string,
	pageSize: number,
	buildQuery: (pageSize: number) => string,
	readPage: (data: any) => T[],
): Promise<{ page: T[]; pageSize: number }> {
	let currentPageSize = pageSize
	while (true) {
		try {
			const data = await fetchGraphQL(endpoint, buildQuery(currentPageSize))
			return { page: readPage(data), pageSize: currentPageSize }
		} catch (error) {
			const nextPageSize = reducePageSize(currentPageSize)
			if (!isRetriableError(error) || nextPageSize >= currentPageSize) {
				throw error
			}
			log.warn(`${entityName} page failed at size ${currentPageSize}: ${errorMessage(error)}. Retrying with page size ${nextPageSize}.`)
			currentPageSize = nextPageSize
		}
	}
}

/**
 * Fetch all quotes that need migration with pagination.
 * Statuses: PENDING=0, LOCKED=1, CANCEL_PENDING=2 (fee reservation)
 *           OPENED=4, CLOSE_PENDING=5, CANCEL_CLOSE_PENDING=6 (aggregated positions/funding)
 *
 * The subgraph can serve globalCounter pagination and quoteStatus_lte quickly, while
 * quoteStatus_in / quoteStatus_not can be slow on some deployments. Fetch
 * status <= 6 and filter status 3 locally.
 */
export async function fetchOpenQuotes(
	endpoint: SubgraphEndpointInput,
	pageSizeOrOptions?: number | FetchOpenQuotesOptions,
): Promise<SubgraphOpenQuotesResult> {
	const options = parseFetchOpenQuotesOptions(pageSizeOrOptions)
	const allQuotes: SubgraphQuote[] = []
	const quoteIdSet = new Set<string>()
	const partyASet = new Set<string>()
	const partyBSet = new Set<string>()
	const key = endpointKey(endpoint)
	let startedAt = new Date().toISOString()
	let lastQuoteId = "0"
	let lastGlobalCounter = "0"
	let currentPageSize = subgraphPageSize(options.pageSize)
	let page = 0
	if (options.progressFile && options.resume !== false) {
		const progress = loadOpenQuotesProgress(options.progressFile, key)
		if (progress) {
			allQuotes.push(...progress.quotes)
			for (const quote of progress.quotes) {
				quoteIdSet.add(quote.quoteId)
				partyASet.add(quote.partyA)
				if (quote.partyB) partyBSet.add(quote.partyB)
			}
			startedAt = progress.startedAt
			lastQuoteId = progress.lastQuoteId
			lastGlobalCounter = progress.lastGlobalCounter
			currentPageSize = Math.min(currentPageSize, progress.pageSize)
			page = progress.page
			log.detail(`Resuming quotes fetch from globalCounter>${lastGlobalCounter} (last quoteId=${lastQuoteId}) with ${allQuotes.length} kept quotes`)
		}
	}

	while (true) {
		page++
		const pageStart = Date.now()
		const cursor = lastGlobalCounter
		log.detail(`quotes page ${page}: requesting globalCounter>${cursor}, pageSize=${currentPageSize}, timeout=${subgraphTimeoutMs()}ms`)
		const { page: pageQuotes, pageSize: usedPageSize } = await fetchPageWithAdaptiveSize<SubgraphQuote>(
			endpoint,
			"quotes",
			currentPageSize,
			size => `{
			quotes(
				first: ${size}
				where: { globalCounter_gt: "${lastGlobalCounter}", quoteStatus_lte: 6 }
				orderBy: globalCounter
				orderDirection: asc
			) {
				${quoteFields()}
			}
		}`,
			data => data.quotes,
		)
		currentPageSize = usedPageSize

		const keepQuote = (q: SubgraphQuote): boolean => {
			if (!ACTIVE_QUOTE_STATUSES.has(q.quoteStatus) || quoteIdSet.has(q.quoteId)) return false
			quoteIdSet.add(q.quoteId)
			allQuotes.push(q)
			partyASet.add(q.partyA)
			if (q.partyB) partyBSet.add(q.partyB)
			return true
		}

		let kept = 0
		for (const q of pageQuotes) {
			if (keepQuote(q)) kept++
		}
		const nextQuoteId = pageQuotes.length > 0 ? pageQuotes[pageQuotes.length - 1].quoteId : lastQuoteId
		const nextGlobalCounter = pageQuotes.length > 0 ? pageQuotes[pageQuotes.length - 1].globalCounter : lastGlobalCounter
		log.detail(
			`quotes page ${page}: globalCounter>${cursor}, fetched=${pageQuotes.length}, kept=${kept}, totalKept=${allQuotes.length}, nextGlobalCounter=${nextGlobalCounter}, nextQuoteId=${nextQuoteId}, ${Date.now() - pageStart}ms`,
		)

		lastQuoteId = nextQuoteId
		lastGlobalCounter = nextGlobalCounter
		if (options.progressFile) {
			writeOpenQuotesProgress(options.progressFile, {
				version: 3,
				endpointKey: key,
				startedAt,
				updatedAt: new Date().toISOString(),
				lastQuoteId,
				lastGlobalCounter,
				page,
				pageSize: currentPageSize,
				quotes: allQuotes,
			})
		}

		if (pageQuotes.length < currentPageSize) break
	}

	if (options.progressFile && !options.keepProgressOnComplete) {
		deleteOpenQuotesProgress(options.progressFile)
	}

	return {
		quotes: allQuotes,
		partyAs: [...partyASet].sort(),
		partyBs: [...partyBSet].sort(),
	}
}

/**
 * Fetch all partyB-per-partyA balance entries from latestAccountBalances.
 */
export async function fetchPartyBBalances(endpoint: SubgraphEndpointInput, pageSize?: number): Promise<SubgraphPartyBBalancesResult> {
	const allEntries: PartyBBalanceEntry[] = []
	const partyBSet = new Set<string>()
	let lastId = ""
	let currentPageSize = subgraphPageSize(pageSize)
	let page = 0

	while (true) {
		page++
		const pageStart = Date.now()
		const cursor = lastId || "<start>"
		const whereClause = lastId
			? `{ accountType: "PARTY_B", counterParty_not: null, id_gt: "${lastId}" }`
			: `{ accountType: "PARTY_B", counterParty_not: null }`
		log.detail(`latestAccountBalances page ${page}: requesting cursor>${cursor}, pageSize=${currentPageSize}, timeout=${subgraphTimeoutMs()}ms`)
		const { page: entries, pageSize: usedPageSize } = await fetchPageWithAdaptiveSize<any>(
			endpoint,
			"latestAccountBalances",
			currentPageSize,
			size => `{
			latestAccountBalances(
				first: ${size}
				where: ${whereClause}
				orderBy: id
				orderDirection: asc
			) {
				id
				account
				counterParty
				allocatedBalance
			}
		}`,
			data => data.latestAccountBalances,
		)
		currentPageSize = usedPageSize

		for (const entry of entries) {
			allEntries.push({ account: entry.account, counterParty: entry.counterParty, allocatedBalance: entry.allocatedBalance })
			partyBSet.add(entry.account)
		}
		const nextCursor = entries.length > 0 ? entries[entries.length - 1].id : cursor
		log.detail(
			`latestAccountBalances page ${page}: cursor>${cursor}, fetched=${entries.length}, total=${allEntries.length}, nextCursor=${nextCursor}, ${Date.now() - pageStart}ms`,
		)

		if (entries.length < currentPageSize) break
		lastId = nextCursor
	}

	return {
		entries: allEntries,
		partyBs: [...partyBSet].sort(),
	}
}

/**
 * Fetch all symbols from the subgraph with their types, paginated by id.
 */
export async function fetchSymbols(endpoint: SubgraphEndpointInput, pageSize?: number): Promise<SubgraphSymbol[]> {
	const allSymbols: SubgraphSymbol[] = []
	let lastId = ""
	let currentPageSize = subgraphPageSize(pageSize)
	let page = 0

	while (true) {
		page++
		const pageStart = Date.now()
		const cursor = lastId || "<start>"
		const whereClause = lastId ? `{ id_gt: "${lastId}" }` : `{}`
		log.detail(`symbols page ${page}: requesting cursor>${cursor}, pageSize=${currentPageSize}, timeout=${subgraphTimeoutMs()}ms`)
		const { page: symbols, pageSize: usedPageSize } = await fetchPageWithAdaptiveSize<SubgraphSymbol>(
			endpoint,
			"symbols",
			currentPageSize,
			size => `{
			symbols(
				first: ${size}
				where: ${whereClause}
				orderBy: id
				orderDirection: asc
			) {
				id
				symbolId
				name
			}
		}`,
			data => data.symbols,
		)
		currentPageSize = usedPageSize

		allSymbols.push(...symbols)
		const nextCursor = symbols.length > 0 ? symbols[symbols.length - 1].id : cursor
		log.detail(
			`symbols page ${page}: cursor>${cursor}, fetched=${symbols.length}, total=${allSymbols.length}, nextCursor=${nextCursor}, ${Date.now() - pageStart}ms`,
		)
		if (symbols.length < currentPageSize) break
		lastId = nextCursor
	}

	return allSymbols
}
