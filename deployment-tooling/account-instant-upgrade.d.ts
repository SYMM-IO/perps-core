export const ACCOUNT_FACETS: readonly string[]
export const UPGRADE_DEPLOYMENTS: readonly string[]
export const BASELINE_GASLESS_LIBRARIES: readonly string[]
export const WALLET_CREATION_FEE_SLOT: number
export const FEE_QUOTE_STORAGE_NAMESPACE: string
export const GASLESS_LIBRARIES: readonly string[]
export const NEW_GASLESS_LIBRARIES: readonly string[]
export function verifyGaslessStorageLayout(baseline: any, current: any): { layoutDigest: string; baselineLayoutDigest: string }
export const POLICY: Readonly<Record<string, boolean | string>>
export const CONFIG_PATH: string
export const RECIPE_PATH: string
export const IMPLEMENTATION_SLOT: string
export const GASLESS_UINTS: readonly string[]
export const GASLESS_BOOLS: readonly string[]
export function digest(value: any): string
export function assertConfigurationParity(expected: any, actual: any): void
export function validateUpgradeConfig(value: any): any
export function upgradeRequiresForkRehearsal(config: any): boolean
export function createUpgradeRehearsalWaiver(input: any, snapshot: any, skippedAt?: string): any
export function assertUpgradeRehearsal(input: any, report: any): void
export function flowDiscovery(config: any): any
export function planAccountCut(
	baseline: Record<string, string>,
	current: Record<string, string>,
	facets: any,
): { desired: Record<string, string>; cut: any[]; calldata: string | null }
