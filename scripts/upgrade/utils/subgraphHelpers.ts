/**
 * Subgraph data fetching utilities for migration input preparation and symbol management.
 *
 * Fetches open quotes, partyB balance data, and symbols from the Goldsky stage subgraph
 * with pagination (max 1000 per request).
 */

const DEFAULT_PAGE_SIZE = 1000

type SubgraphQuote = {
	quoteId: string
	partyA: string
	partyB: string
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

export type SubgraphPartyBBalancesResult = {
	entries: PartyBBalanceEntry[]
	partyBs: string[]
}

export type SubgraphSymbol = {
	id: string
	name: string
}

async function fetchGraphQL(endpoint: string, query: string): Promise<any> {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ query }),
	})
	if (!response.ok) {
		throw new Error(`Subgraph request failed: ${response.status} ${response.statusText}`)
	}
	const json = await response.json()
	if (json.errors) {
		throw new Error(`Subgraph query error: ${JSON.stringify(json.errors)}`)
	}
	return json.data
}

/**
 * Fetch all quotes that need migration with pagination.
 * Statuses: PENDING=0, LOCKED=1, CANCEL_PENDING=2 (fee reservation)
 *           OPENED=4, CLOSE_PENDING=5, CANCEL_CLOSE_PENDING=6 (aggregated positions/funding)
 */
export async function fetchOpenQuotes(endpoint: string, pageSize: number = DEFAULT_PAGE_SIZE): Promise<SubgraphOpenQuotesResult> {
	const allQuotes: SubgraphQuote[] = []
	const partyASet = new Set<string>()
	const partyBSet = new Set<string>()
	let lastQuoteId = "0"

	while (true) {
		const query = `{
			quotes(
				first: ${pageSize}
				where: { quoteStatus_in: [0, 1, 2, 4, 5, 6], quoteId_gt: "${lastQuoteId}" }
				orderBy: quoteId
				orderDirection: asc
			) {
				quoteId
				partyA
				partyB
				symbolId
				positionType
				quantity
				closedAmount
				quoteStatus
			}
		}`

		const data = await fetchGraphQL(endpoint, query)
		const quotes: SubgraphQuote[] = data.quotes

		for (const q of quotes) {
			allQuotes.push(q)
			partyASet.add(q.partyA)
			if (q.partyB) partyBSet.add(q.partyB)
		}

		if (quotes.length < pageSize) break
		lastQuoteId = quotes[quotes.length - 1].quoteId
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
export async function fetchPartyBBalances(endpoint: string, pageSize: number = DEFAULT_PAGE_SIZE): Promise<SubgraphPartyBBalancesResult> {
	const allEntries: PartyBBalanceEntry[] = []
	const partyBSet = new Set<string>()
	let lastId = ""

	while (true) {
		const whereClause = lastId
			? `{ accountType: "PARTY_B", counterParty_not: null, id_gt: "${lastId}" }`
			: `{ accountType: "PARTY_B", counterParty_not: null }`
		const query = `{
			latestAccountBalances(
				first: ${pageSize}
				where: ${whereClause}
				orderBy: id
				orderDirection: asc
			) {
				id
				account
				counterParty
				allocatedBalance
			}
		}`

		const data = await fetchGraphQL(endpoint, query)
		const entries = data.latestAccountBalances

		for (const entry of entries) {
			allEntries.push({ account: entry.account, counterParty: entry.counterParty, allocatedBalance: entry.allocatedBalance })
			partyBSet.add(entry.account)
		}

		if (entries.length < pageSize) break
		lastId = entries[entries.length - 1].id
	}

	return {
		entries: allEntries,
		partyBs: [...partyBSet].sort(),
	}
}

/**
 * Fetch all symbols from the subgraph with their types, paginated by id.
 */
export async function fetchSymbols(endpoint: string, pageSize: number = DEFAULT_PAGE_SIZE): Promise<SubgraphSymbol[]> {
	const allSymbols: SubgraphSymbol[] = []
	let lastId = "0"

	while (true) {
		const query = `{
			symbols(
				first: ${pageSize}
				where: { symbolId_gt: "${lastId}" }
				orderBy: symbolId
				orderDirection: asc
			) {
				id
				name
			}
		}`

		const data = await fetchGraphQL(endpoint, query)
		const symbols: SubgraphSymbol[] = data.symbols

		allSymbols.push(...symbols)
		if (symbols.length < pageSize) break
		lastId = symbols[symbols.length - 1].id
	}

	return allSymbols
}
