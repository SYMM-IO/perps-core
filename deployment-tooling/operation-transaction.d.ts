export function submitOperation(options: {
	provider: any
	signer?: any
	plan: any
	action: any
	report: any
	save: () => void
	completeRequest: any
	send: any
	suppliedHash?: string
	label?: string
	receiptAttempts?: number
	receiptIntervalMs?: number
	onProgress?: (message: string) => void
}): Promise<any>
