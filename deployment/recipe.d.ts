export const RECIPE_API_VERSION: "deployment.symm.io/v1"
export const DEPLOYMENT_COMPONENTS: readonly ["core", "partyB", "symbolManager", "expressProvider"]

export type ComponentMode = "deploy" | "reuse" | "skip"
export type SecretRef = `hardhat-keystore://${string}` | `env://${string}`
export type SecretMetadata = { provider: "hardhat-keystore" | "env"; key: string }
export type VanityGroup = "diamonds" | "facets" | "libraries" | "peripherals"
export type VanityPattern = { prefix?: string; suffix?: string }
export type MuonFunctionName =
	| "Trading"
	| "AccountManagement"
	| "Settlement"
	| "ForceClose"
	| "Funding"
	| "LiquidationPartyA"
	| "LiquidationPartyB"
	| "RemoveMargin"

export interface DeploymentRecipe {
	$schema?: string
	apiVersion: typeof RECIPE_API_VERSION
	kind: "DeploymentRecipe"
	name: string
	network: { name: string; chainId: number; mode: "live" | "fork" | "local" }
	secrets: { deployer?: SecretRef; rpc?: SecretRef; explorer?: SecretRef }
	execution: {
		logLevel: "silent" | "minimal" | "verbose"
		verify: boolean
		confirmations?: number
		txTimeoutSeconds?: number
		slowNoticeSeconds?: number
		forkBlockNumber?: number
	}
	governance: {
		admin: string
		feeReceiver?: string
		liquidationInsuranceVault?: string
		maxLiquidationProfitPerPosition?: string
		softLiquidationPenaltyCollector?: string
	}
	create2?: {
		factory?: { mode: "deploy" } | { mode: "reuse"; address: string }
		factoryAddress?: string
		groups?: Partial<Record<VanityGroup, VanityPattern>>
		overrides?: Record<string, VanityPattern>
		miningBudget?: number
	}
	core: {
		mode: ComponentMode
		fromReport?: string
		collateral?: { mode: "deploy" | "reuse"; address?: string }
		muon?: {
			mode: "mock" | "deploy" | "reuse"
			address?: string
			appId?: string
			upnlValidTime: string
			priceValidTime: string
			/** Per-MuonFunction UPNL validity overrides in seconds; omit a function to use the global value. */
			upnlValidTimeByFunction?: Partial<Record<MuonFunctionName, string>>
			publicKey?: { x: string; parity: 0 | 1 }
			gatewaySigners?: string[]
			permissions?: string[]
		}
		protocol?: {
			description?: string
			parameters: {
				balanceLimitPerUser: string
				maxWithdrawParts: number
				deallocateCooldown: number
				settlementCooldown: number
				deallocateDebounceTime: number
				liquidatorShare: string
				liquidationTimeout: number
				forceCloseCooldowns: [number, number]
				forceCancelCooldown: number
				forceCancelCloseCooldown: number
				pendingQuotesValidLength: number
				maxPartyAConnectionLimit: number
			}
			instantLayerTemplates: Array<{
				name: string
				instantOpenMode?: boolean
				operations: Array<{ insertionPoints: number[]; sourceIndices: number[]; sourceOffsets: number[] }>
			}>
		}
		setupInstantLayerTemplates?: boolean
		registerDummyAffiliate?: boolean
	}
	partyB: { mode: ComponentMode; address?: string; signer?: string; adlEnabled: boolean }
	symbolManager: { mode: ComponentMode; address?: string; operator?: string }
	expressProvider: ExpressProviderRecipe
}

export type ExpressRoleName =
	| "OPERATOR_ROLE"
	| "LOCKER_ROLE"
	| "SIGNER_ROLE"
	| "SETTER_ROLE"
	| "FEE_CLAIMER_ROLE"
	| "UNLOCK_ROLE"
	| "WITHDRAWER_ROLE"
	| "PAUSER_ROLE"

export interface ExpressAffiliateRecipe {
	address: string
	feeRate: string
	operatorFee: string
	/** 0 means no absolute cap. */
	maxDebt: string
	/** 0 means no percentage cap. */
	maxDebtBps: number
	minValidatorSignatures?: number
	validatorApprovalTimeout?: number
	validators?: string[]
}

export interface ExpressProviderRecipe {
	mode: ComponentMode
	address?: string
	admin?: string
	registerOnCore?: boolean
	securityWindow?: number
	tolerancePeriod?: number
	creditLine?: {
		/** "fromCore" resolves the core diamond's configured verifier at execution time. */
		signatureVerifier: string
		muonAppId: string
		muonFreshnessWindow: number
	}
	roles?: Partial<Record<ExpressRoleName, string[]>>
	affiliates?: ExpressAffiliateRecipe[]
}

export function parseSecretRef(ref: unknown, source?: string): SecretMetadata
export function validateDeploymentRecipe(value: unknown, source?: string): DeploymentRecipe
export function recipeDigest(recipe: unknown): string
export function loadDeploymentRecipe(
	recipePath: string,
	options?: { projectRoot?: string },
): {
	recipe: DeploymentRecipe
	path: string
	identityPath: string
	digest: string
	recipeOnlyDigest: string
	dependencies: { coreReport?: { path: string; identityPath: string; digest: string } }
}

export interface CoreDependencyReport {
	deploymentId: string
	network: string
	chainId: number
	lifecycle: "pending_handover" | "complete"
	checks: {
		health: "passed"
		verification: "passed" | "skipped"
		verificationPolicy: "required" | "not_applicable" | "explicitly_skipped"
	}
	deployerAddress: string
	config: { admin: string }
	addresses: {
		diamond: string
		instantLayer: string
		collateral?: string
		signatureVerifier?: string
		accountLayerDiamond?: string
	}
	sourceDigest?: string
}

export function parseCoreDependencyReport(
	value: unknown,
	expected: { network: string; chainId: number; live: boolean; source?: string },
): CoreDependencyReport
export function loadCoreDependencyReport(
	filePath: string,
	expected: { network: string; chainId: number; live: boolean; digest?: string },
): CoreDependencyReport

export function createDeploymentPlan(
	recipe: DeploymentRecipe,
	options?: { only?: (typeof DEPLOYMENT_COMPONENTS)[number] },
): {
	network: DeploymentRecipe["network"]
	only: (typeof DEPLOYMENT_COMPONENTS)[number] | null
	components: Array<{ name: (typeof DEPLOYMENT_COMPONENTS)[number]; mode: ComponentMode; dependsOn: Array<"core"> }>
}
export function recipeEnvironment(recipe: DeploymentRecipe): {
	env: Record<string, string>
	secrets: Partial<Record<"deployer" | "rpc" | "explorer", SecretMetadata>>
}
