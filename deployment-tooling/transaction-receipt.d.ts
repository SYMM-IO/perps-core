export interface ReceiptConfirmationObservation {
	hash: string
	attempt: number
	maxAttempts: number
	transactionFound: boolean | null
	receiptStatus: number | null
	blockNumber: number | null
	receiptBlockHash: string | null
	canonicalBlockHash: string | null
	confirmations: number
	requiredConfirmations: number
}
export interface ReceiptConfirmationPolicy {
	receiptAttempts?: number
	receiptIntervalMs?: number
	receiptTimeoutMs?: number
}
export function waitForCanonicalReceipt(
	options: ReceiptConfirmationPolicy & {
		provider: any
		hash: string
		confirmations?: number
		label?: string
		validateTransaction?: (transaction: any) => void | Promise<void>
		onObservation?: (observation: ReceiptConfirmationObservation) => void | Promise<void>
		onProgress?: (message: string) => void
	},
): Promise<any>
