export const RELEASE_TAG: string
export const PRODUCTION_RELEASE_TAG: string
export const RECIPE_PATH: string
export const TARGET_PATH: string
export const ROUNDING_PROFILES: Readonly<Record<string, { recipePath: string; targetPath: string; recipeName: string; releaseTag: string }>>
export function roundingProfile(profile?: string): { recipePath: string; targetPath: string; recipeName: string; releaseTag: string }
export function requiresRoundingPause(input: any): boolean
export function isStageFunding(input: any): boolean
export function roundingSuffix(profile?: string): string
export function roundingLibraries(profile?: string): readonly string[]
export function roundingOwner(input: any): string
export const LIBRARIES: readonly string[]
export const FACETS: readonly string[]
export const DEPLOYMENTS: readonly string[]
export const PRODUCTION_FACETS: readonly string[]
export function roundingFacets(profile?: string): readonly string[]
export function roundingDeployments(profile?: string): string[]
export const GETTER: string
export function digest(value: unknown): string
export function selectorDigest(selectors: Record<string, string>): string
export function fileDigest(file: string): string
export function validateRoundingSourceMigration(root: string, input: any, migration: any, currentCommit?: string): any
export function assertReleaseSource(root: string, input?: any, profile?: string, migration?: any): string
export function buildRoundingInput(root: string, profile?: string): any
export function assertRoundingFactoryIntent(create2: any): void
export function selectorMap(facets: any[]): Record<string, string>
export function planRoundingCut(
	baseline: Record<string, string>,
	current: Record<string, string>,
	facets: any,
	oldFacets: any,
	profile?: string,
): { desired: Record<string, string>; cut: any[]; calldata: string | null }
