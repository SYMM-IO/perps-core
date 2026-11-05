const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

export type QuoteRoute = {
	partyA: string
	partyB: string
	partyBsWhiteList: readonly string[]
}

export type QuoteStateEnvelope = {
	quoteId: bigint
	route?: QuoteRoute
}

export type ActorRoute = {
	kind: "user" | "hedger"
	address: string
}

function sameAddress(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase()
}

export function isHedgerEligibleForQuote(quote: Pick<QuoteRoute, "partyB" | "partyBsWhiteList">, hedgerAddress: string): boolean {
	if (!sameAddress(quote.partyB, ZERO_ADDRESS)) return sameAddress(quote.partyB, hedgerAddress)
	return quote.partyBsWhiteList.length === 0 || quote.partyBsWhiteList.some(address => sameAddress(address, hedgerAddress))
}

export function shouldRouteQuoteState(envelope: QuoteStateEnvelope, actor: ActorRoute): boolean {
	if (!envelope.route) return true
	if (actor.kind === "user") return sameAddress(envelope.route.partyA, actor.address)
	return isHedgerEligibleForQuote(envelope.route, actor.address)
}
