export const BATCH_SOURCE_FILES: string[]
export const REQUEST_STATUSES: string[]
export function batchSourceDigest(root: string): string
export function batchAccountInput(input: any, account: string): any
export function validateBatchInput(input: any): void
export function batchPlanDigest(report: any): string
export function readBatchRequests(provider: any, input: any, snapshot: any): Promise<any[]>
export function unresolvedBatchOperations(report: any): any[]
export function runBatchAccount(options: any): Promise<any>
export function batchSummary(report: any): string
