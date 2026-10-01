export const CORE_UPGRADE_CONFIG: string
export const CORE_UPGRADE_RECIPE: string
export const CORE_UPGRADE_API: string
export const CUT_SELECTOR: string
export function digest(value: any): string
export function validateCoreUpgradeConfig(config: any): any
export function planCoreCut(
	baseline: Record<string, string>,
	current: Record<string, string>,
	facets: any,
	allowedRemovedSelectors: string[],
): { desired: Record<string, string>; removed: string[]; cut: any[]; calldata: string | null }
export function assertCoreEvidence(report: any, field: string, expectedDigest: string): any
