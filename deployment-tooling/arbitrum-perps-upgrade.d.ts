export const ARBITRUM_PERPS_UPGRADE_INPUT_API_VERSION: "operations.symm.io/arbitrum-perps-upgrade-input-v2"
export const ARBITRUM_PERPS_UPGRADE_REPORT_API_VERSION: "operations.symm.io/arbitrum-perps-upgrade-report-v1"
export const ARBITRUM_PERPS_UPGRADE_SOURCE_MIGRATION_API_VERSION: "operations.symm.io/task-source-migration-v1"
export const ARBITRUM_PERPS_UPGRADE_CANARY_WAIVER_CONFIRMATION: "WAIVE PRODUCTION CANARY"
export const ARBITRUM_PERPS_UPGRADE_RUNTIME_CONFIG_API_VERSION: "operations.symm.io/arbitrum-perps-upgrade-runtime-config-v1"
export const ARBITRUM_PERPS_UPGRADE_RUNTIME_CONFIG_PATH: "tasks/config/arbitrum-perps-upgrade-42161.json"

export type UpgradeAddressKey =
	| "core"
	| "collateral"
	| "accountLayer"
	| "currentInstantLayer"
	| "expressProvider"
	| "signatureVerifier"
	| "symbolManager"
	| "feesManager"
	| "create2Factory"
	| "currentGaslessLayer"
	| "liquidatorProxy"

export interface ArbitrumPerpsUpgradeInput {
	$schema?: string
	apiVersion: typeof ARBITRUM_PERPS_UPGRADE_INPUT_API_VERSION
	kind: "ArbitrumPerpsUpgrade"
	name: string
	network: { name: "arbitrum"; chainId: 42161; mode: "live" }
	source: { commit: string; recipe: { path: string; digest: string } }
	governance: { safe: string; previousAdmin: string }
	contracts: Record<UpgradeAddressKey, string>
	instantLayer: {
		mode: "deploy"
		admin: string
		/** Required for newly prepared inputs; omitted only by upgrade inputs created before PartyB wiring became mandatory. */
		partyBs?: string[]
		templates: Array<{
			name: string
			instantOpenMode?: boolean
			operations: Array<{ insertionPoints: number[]; sourceIndices: number[]; sourceOffsets: number[] }>
		}>
	}
	gaslessLayer: {
		mode: "deploy"
		admin: string
		treasury: string
		depositFee: string
		minimumDeposit: string
		defaultSelectorFee: string
		dailyFreeOpsLimit: string
		revertWhenFreeQuotaExhausted: boolean
		dailySponsoredNativeLimit: string
		revertWhenNativeSponsorLimitExhausted: boolean
		maxNativeGasTopUpAmount: string
		nativeGasTopUpFeeBps: number
		relayers: string[]
		selectorFees: Array<{ selector: string; configured: boolean; amount: string }>
	}
	execution: {
		verify: true
		confirmations: number
		txTimeoutSeconds: number
		slowNoticeSeconds: number
		requireForkRehearsal: boolean
	}
}

export interface UpgradeAction {
	to: string
	value: string
	data: string
	description: string
}

export interface ArbitrumPerpsUpgradeReport {
	$schema?: string
	apiVersion: typeof ARBITRUM_PERPS_UPGRADE_REPORT_API_VERSION
	kind: "ArbitrumPerpsUpgradeReport"
	name: string
	inputDigest: string
	source: ArbitrumPerpsUpgradeInput["source"]
	network: ArbitrumPerpsUpgradeInput["network"]
	lifecycle: "prepared" | "in_progress" | "waiting_external" | "complete" | "failed"
	addresses: ArbitrumPerpsUpgradeInput["contracts"] & {
		newInstantLayer: string | null
		newGaslessLayer: string | null
		newGaslessLayerImplementation: string | null
	}
	stages: Record<string, Record<string, unknown>>
	safeBatches: Record<string, { status: string; actions: UpgradeAction[] }>
	externalActions: Record<string, { status: string; authority?: string; actions: UpgradeAction[] }>
	transactions: unknown[]
	checks: Array<Record<string, unknown>>
	createdAt: string
	updatedAt: string
}

export interface ArbitrumPerpsUpgradeSourceMigration {
	apiVersion: typeof ARBITRUM_PERPS_UPGRADE_SOURCE_MIGRATION_API_VERSION
	taskId: "maintenance.arbitrum-perps-upgrade"
	taskRunId: string
	inputDigest: string
	originalCommit: string
	currentCommit: string
	migrations: Array<{ at: string; from: string; to: string; authorization: "operator-confirmed" }>
	changedFiles: string[]
}

export const ARBITRUM_PERPS_UPGRADE_TARGET: {
	readonly chainId: 42161
	readonly network: "arbitrum"
	readonly safe: string
	readonly previousAdmin: string
	readonly contracts: Readonly<Record<UpgradeAddressKey, string>>
}

export function validateArbitrumPerpsUpgradeInput(value: unknown, source?: string): ArbitrumPerpsUpgradeInput
export function arbitrumPerpsUpgradeInputDigest(value: unknown): string
export function validateArbitrumPerpsUpgradeSourceMigration(
	input: unknown,
	migration: unknown,
	context: { currentCommit: string; changedFiles: string[]; originalCommitIsAncestor: boolean },
	source?: string,
): ArbitrumPerpsUpgradeSourceMigration
export function buildArbitrumPerpsUpgradeInput(args: {
	recipe: unknown
	recipePath: string
	recipeDigest: string
	sourceCommit: string
	partyBs: string[]
	requireForkRehearsal?: boolean
}): ArbitrumPerpsUpgradeInput
export interface ArbitrumPerpsUpgradeRuntimeConfig {
	apiVersion: typeof ARBITRUM_PERPS_UPGRADE_RUNTIME_CONFIG_API_VERSION
	chainId: 42161
	legacyGaslessLayer: { address: string; relayers: string[] }
	instantLayer: { partyBs: string[] }
}
export function validateArbitrumPerpsUpgradeRuntimeConfig(value: unknown, source?: string): ArbitrumPerpsUpgradeRuntimeConfig
export function loadArbitrumPerpsUpgradeRuntimeConfig(file: string): {
	config: ArbitrumPerpsUpgradeRuntimeConfig
	digest: string
}
export function loadArbitrumPerpsUpgradeInput(file: string): ArbitrumPerpsUpgradeInput
export function createArbitrumPerpsUpgradeReport(input: ArbitrumPerpsUpgradeInput, now?: string): ArbitrumPerpsUpgradeReport
export function recordArbitrumPerpsUpgradeCanaryWaiver(
	report: ArbitrumPerpsUpgradeReport,
	reason: string,
	skippedAt?: string,
): ArbitrumPerpsUpgradeReport
export function arbitrumPerpsUpgradeCanaryDisposition(report: ArbitrumPerpsUpgradeReport): {
	satisfied: boolean
	status: "passed" | "skipped" | "pending"
	waived: boolean
}
export function validateArbitrumPerpsUpgradeReport(value: unknown, input: ArbitrumPerpsUpgradeInput, source?: string): ArbitrumPerpsUpgradeReport
export function recordArbitrumPerpsUpgradeSafeHardeningSkip(report: ArbitrumPerpsUpgradeReport, skippedAt?: string): ArbitrumPerpsUpgradeReport
export function arbitrumPerpsUpgradeSafeHardeningDisposition(report: ArbitrumPerpsUpgradeReport): {
	threshold: number
	ownerCount: number
	hardened: boolean
	skipped: boolean
	satisfied: boolean
	status: "passed" | "skipped" | "pending"
}
export function finalizeArbitrumPerpsUpgradeReport(report: ArbitrumPerpsUpgradeReport, timestamp?: string): ArbitrumPerpsUpgradeReport
