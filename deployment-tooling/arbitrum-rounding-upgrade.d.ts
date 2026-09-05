export const RELEASE_TAG: string
export const RECIPE_PATH: string
export const TARGET_PATH: string
export const LIBRARIES: readonly string[]
export const FACETS: readonly string[]
export const DEPLOYMENTS: readonly string[]
export const GETTER: string
export function digest(value: unknown): string
export function fileDigest(file: string): string
export function assertReleaseSource(root: string, input?: any): string
export function buildRoundingInput(root: string): any
export function assertRoundingFactoryIntent(create2: any): void
export function selectorMap(facets: any[]): Record<string, string>
export function planRoundingCut(
	baseline: Record<string, string>,
	current: Record<string, string>,
	facets: any,
	oldFacets: any,
): { desired: Record<string, string>; cut: any[]; calldata: string | null }
