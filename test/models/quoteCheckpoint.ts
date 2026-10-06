import { QuoteStatus } from "./Enums.js"

export class QuoteCheckpoint {
	private static instance: QuoteCheckpoint | null = null
	private readonly blockedQuotes = new Set<string>()

	private constructor() {}

	public static getInstance(): QuoteCheckpoint {
		if (!QuoteCheckpoint.instance) {
			QuoteCheckpoint.instance = new QuoteCheckpoint()
		}

		return QuoteCheckpoint.instance
	}

	public addBlockedQuotes(quoteId: bigint): void {
		this.blockedQuotes.add(quoteId.toString())
	}

	public deleteBlockedQuotes(quoteId: bigint): void {
		this.blockedQuotes.delete(quoteId.toString())
	}

	public isBlockedQuote(quoteId: bigint): boolean {
		return this.blockedQuotes.has(quoteId.toString())
	}

	public observeQuoteStatus(quoteId: bigint, status: QuoteStatus): void {
		if ([QuoteStatus.CANCELED, QuoteStatus.CLOSED, QuoteStatus.EXPIRED, QuoteStatus.LIQUIDATED, QuoteStatus.LIQUIDATED_PENDING].includes(status)) {
			this.deleteBlockedQuotes(quoteId)
		}
	}

	public reset(): void {
		this.blockedQuotes.clear()
	}
}
