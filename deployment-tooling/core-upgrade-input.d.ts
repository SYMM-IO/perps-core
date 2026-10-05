export const CORE_INPUT_API: string
export function validateCoreUpgradeInput(input: any): any
export function isStandardCoreInput(config: any): boolean
export function coreUpgradeAuthority(config: any): string
export function coreUpgradeNetwork(config: any): { name: string; chainId: number; fork: string }
export function coreGovernanceKind(config: any): string
export function coreUpgradeRecipe(input: any, fork?: boolean): any
