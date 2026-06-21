const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

export const FEE_RESERVATION_STATUSES = new Set([0, 1, 2])
export const ACTIVE_POSITION_STATUSES = new Set([4, 5, 6])

export const STATUS_NAMES: Record<number, string> = {
	0: "PENDING",
	1: "LOCKED",
	2: "CANCEL_PENDING",
	3: "CANCELED",
	4: "OPENED",
	5: "CLOSE_PENDING",
	6: "CANCEL_CLOSE_PENDING",
	7: "CLOSED",
	8: "LIQUIDATED",
	9: "EXPIRED",
	10: "LIQUIDATED_PENDING",
}

export type QuoteMigrationFields = {
	quoteStatus: unknown
	partyA?: string
	quantity?: unknown
	closedAmount?: unknown
}

export function toMigrationBigInt(value: unknown): bigint {
	if (typeof value === "bigint") return value
	if (typeof value === "number") return BigInt(value)
	if (typeof value === "string") return BigInt(value)
	return BigInt((value as any).toString())
}

export function quoteStatusNumber(quote: QuoteMigrationFields): number {
	return Number(toMigrationBigInt(quote.quoteStatus))
}

export function quoteStatusName(status: number): string {
	return STATUS_NAMES[status] ?? `UNKNOWN(${status})`
}

export function quoteOpenAmount(quote: QuoteMigrationFields): bigint | null {
	if (quote.quantity === undefined || quote.closedAmount === undefined) return null
	const quantity = toMigrationBigInt(quote.quantity)
	const closedAmount = toMigrationBigInt(quote.closedAmount)
	return quantity > closedAmount ? quantity - closedAmount : 0n
}

export function quoteRequiresMigration(quote: QuoteMigrationFields): boolean {
	if (quote.partyA && quote.partyA.toLowerCase() === ZERO_ADDRESS) return false

	const status = quoteStatusNumber(quote)
	if (FEE_RESERVATION_STATUSES.has(status)) return true

	if (ACTIVE_POSITION_STATUSES.has(status)) {
		const openAmount = quoteOpenAmount(quote)
		return openAmount === null || openAmount > 0n
	}

	return false
}

export function quoteMigrationSkipReason(quote: QuoteMigrationFields): string {
	if (quote.partyA && quote.partyA.toLowerCase() === ZERO_ADDRESS) return "non-existent quote"

	const status = quoteStatusNumber(quote)
	if (!FEE_RESERVATION_STATUSES.has(status) && !ACTIVE_POSITION_STATUSES.has(status)) {
		return `status=${quoteStatusName(status)}`
	}

	const openAmount = quoteOpenAmount(quote)
	if (ACTIVE_POSITION_STATUSES.has(status) && openAmount !== null && openAmount === 0n) {
		return `status=${quoteStatusName(status)} openAmount=0`
	}

	return "not required by MigrationFacetImpl"
}
