export const TARGET: { chainId: number; core: string; recipient: string; owner: string; collateral: string; legacyAccountFacet: string }
export const ROLE: string
export const ARTIFACT: string
export const CONFIG: string
export const ABI: string[]
export const iface: import("ethers").Interface
export const SELECTOR: string
export const LEGACY_SELECTOR: string
export const SOURCE_FILES: string[]
export const REQUIRED_CHECKS: string[]
export function json(value: any): string
export function digest(value: any): string
export function sourceDigest(root: string): string
export function selectorMap(facets: any): Record<string, string>
export function sameAddress(a: any, b: any): boolean
export function validateInput(input: any, root?: string): void
export function requireRecipientConfirmation(confirmation: any): void
export function planCut(baseline: any, current: any, facet: string): any[]
export function requireRehearsal(report: any, input: any, artifact: any): void
export function recoveryEvent(receipt: any): {
	amount: string
	zeroBefore: string
	zeroAfter: string
	recipientBefore: string
	recipientAfter: string
}

export function requireValidation(report: any, input: any, artifact: any): void

export function recoveryAction(): { to: string; value: string; data: string; description: string }
