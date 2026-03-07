/**
 * Subgraph data fetching utilities for migration input preparation.
 *
 * Fetches open quotes and partyB balance data from the Goldsky stage subgraph
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
 * Fetch all open quotes (status OPENED=4, CLOSE_PENDING=6, CANCEL_CLOSE_PENDING=7)
 * with pagination.
 */
export async function fetchOpenQuotes(endpoint: string, pageSize: number = DEFAULT_PAGE_SIZE): Promise<SubgraphOpenQuotesResult> {
	const allQuotes: SubgraphQuote[] = []
	const partyASet = new Set<string>()
	const partyBSet = new Set<string>()
	let skip = 0

	while (true) {
		const query = `{
			quotes(
				first: ${pageSize}
				skip: ${skip}
				where: { quoteStatus_in: [4, 6, 7] }
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
		skip += pageSize
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
	let skip = 0

	while (true) {
		const query = `{
			latestAccountBalances(
				first: ${pageSize}
				skip: ${skip}
				where: { accountType: "PARTY_B", counterParty_not: null }
				orderBy: id
				orderDirection: asc
			) {
				account
				counterParty
				allocatedBalance
			}
		}`

		const data = await fetchGraphQL(endpoint, query)
		const entries: PartyBBalanceEntry[] = data.latestAccountBalances

		for (const entry of entries) {
			allEntries.push(entry)
			partyBSet.add(entry.account)
		}

		if (entries.length < pageSize) break
		skip += pageSize
	}

	return {
		entries: allEntries,
		partyBs: [...partyBSet].sort(),
	}
}
