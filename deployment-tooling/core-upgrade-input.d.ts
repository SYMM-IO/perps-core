export const CORE_INPUT_API: string
export const CORE_INPUT_API_V2: string
export interface CoreUpgradeRoleGrant {
	holder: string
	role: string
	holderRef?: string
}
export function coreUpgradeRoleGrants(config: any): CoreUpgradeRoleGrant[]
export function coreUpgradeRoleGrantReview(config: any): string
export interface CoreUpgradePolicies {
	storage: { symbolAdjustment: { legacyAdjustmentWords: number; upgradedAdjustmentWords: number; requireEmptyAdjustments: true } }
	funding: { aggregate: { repair: boolean } }
	selectors: { core: { allowedRemovals: string[] } }
}
export function coreUpgradePolicies(config: any): CoreUpgradePolicies
export function coreUpgradePolicyReview(config: any): string
export function validateCoreUpgradeInput(input: any): any
export function isStandardCoreInput(config: any): boolean
export function coreUpgradeAuthority(config: any): string
export function coreUpgradeNetwork(config: any): { name: string; chainId: number; fork: string }
export function coreGovernanceKind(config: any): string
export function coreUpgradeRecipe(input: any, fork?: boolean): any
