export const RELEASE_TAG: string
export const RECIPE_PATH: string
export const TARGET_PATH: string
export const ROUNDING_PROFILES: Readonly<Record<string, { recipePath: string; targetPath: string; recipeName: string }>>
export function roundingProfile(profile?: string): { recipePath: string; targetPath: string; recipeName: string }
export function requiresRoundingPause(input: any): boolean
export function roundingOwner(input: any): string
export const LIBRARIES: readonly string[]
export const FACETS: readonly string[]
export const DEPLOYMENTS: readonly string[]
export const GETTER: string
export function digest(value: unknown): string
export function fileDigest(file: string): string
export function assertReleaseSource(root: string, input?: any, profile?: string): string
export function buildRoundingInput(root: string, profile?: string): any
export function assertRoundingFactoryIntent(create2: any): void
export function selectorMap(facets: any[]): Record<string, string>
export function planRoundingCut(
	baseline: Record<string, string>,
	current: Record<string, string>,
	facets: any,
	oldFacets: any,
): { desired: Record<string, string>; cut: any[]; calldata: string | null }
