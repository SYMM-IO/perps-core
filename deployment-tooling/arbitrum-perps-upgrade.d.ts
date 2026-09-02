export const ARBITRUM_PERPS_UPGRADE_INPUT_API_VERSION: "operations.symm.io/arbitrum-perps-upgrade-input-v1"
export const ARBITRUM_PERPS_UPGRADE_REPORT_API_VERSION: "operations.symm.io/arbitrum-perps-upgrade-report-v1"

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
		requireForkRehearsal: true
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
	externalActions: Record<string, { status: string; actions: UpgradeAction[] }>
	transactions: Array<Record<string, unknown>>
	checks: Array<Record<string, unknown>>
	createdAt: string
	updatedAt: string
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
export function buildArbitrumPerpsUpgradeInput(args: {
	recipe: unknown
	recipePath: string
	recipeDigest: string
	sourceCommit: string
}): ArbitrumPerpsUpgradeInput
export function loadArbitrumPerpsUpgradeInput(file: string): ArbitrumPerpsUpgradeInput
export function createArbitrumPerpsUpgradeReport(input: ArbitrumPerpsUpgradeInput, now?: string): ArbitrumPerpsUpgradeReport
export function validateArbitrumPerpsUpgradeReport(value: unknown, input: ArbitrumPerpsUpgradeInput, source?: string): ArbitrumPerpsUpgradeReport
