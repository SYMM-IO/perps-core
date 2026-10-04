export function submitOperation(options: {
	provider: any
	signer?: any
	plan: any
	action: any
	report: any
	save: () => void
	completeRequest: any
	beforeSubmit?: () => Promise<void>
	send: any
	suppliedHash?: string
	label?: string
	receiptAttempts?: number
	receiptIntervalMs?: number
	onProgress?: (message: string) => void
}): Promise<any>
