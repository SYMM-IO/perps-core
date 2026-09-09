export const ACCOUNT_FACETS: readonly string[]
export const UPGRADE_DEPLOYMENTS: readonly string[]
export const GASLESS_LIBRARIES: readonly string[]
export const POLICY: Readonly<Record<string, boolean>>
export const CONFIG_PATH: string
export const RECIPE_PATH: string
export const IMPLEMENTATION_SLOT: string
export const GASLESS_UINTS: readonly string[]
export const GASLESS_BOOLS: readonly string[]
export function digest(value: any): string
export function assertConfigurationParity(expected: any, actual: any): void
export function validateUpgradeConfig(value: any): any
export function planAccountCut(
	baseline: Record<string, string>,
	current: Record<string, string>,
	facets: any,
): { desired: Record<string, string>; cut: any[]; calldata: string | null }
