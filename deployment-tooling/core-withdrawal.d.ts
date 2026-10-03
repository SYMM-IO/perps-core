export const coreInterface: any
export const tokenInterface: any
export const SOURCE_FILES: string[]
export function json(value: any): string
export function digest(value: any): string
export function sourceDigest(root: string): string
export function validateWithdrawalInput(input: any): void
export function buildWithdrawalPlan(input: any, snapshot: any): any
export function verifyWithdrawalPlan(plan: any, input: any): void
export function readWithdrawalSnapshot(provider: any, input: any): Promise<any>
export function withdrawalPreview(plan: any): string
export function withdrawalReadiness(plan: any, snapshot: any, request?: any): any
export function mapMuonSignature(response: any, input: any, snapshot: any): any
export function fetchMuon(input: any, fetchImpl?: any): Promise<any>
export function verifyWithdrawalReceipt(plan: any, phase: string, receipt: any): any
export function runWithdrawalPhase(options: any): Promise<any>
