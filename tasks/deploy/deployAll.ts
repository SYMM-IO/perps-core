import type { ContractTransactionResponse } from "ethers"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { createDeploymentPlan, type ComponentMode, type DeploymentRecipe } from "../../deployment/recipe.js"
import { ControlFacet } from "../../src/types/index.js"
import { getDataDir, setDataScope, writeData } from "../utils/fs.js"
import { deployAccountLayerDiamond } from "./accountLayerDiamond.js"
import {
	loadCheckpoint,
	saveCheckpoint,
	createCheckpoint,
	clearCheckpoint,
	displayCheckpointStatus,
	DeploymentCheckpoint,
	createDeployedContract,
	checkpointedStep,
	checkpointedBatch,
	ensureBooleanState,
	resolveAffiliateRegistrationResumeAction,
	isCompleted,
	markCompleted,
	setCheckpointSimulated,
	createDeploymentManifest,
	assertCheckpointManifest,
	assertCheckpointContractsHaveCode,
} from "./checkpoint.js"
import {
	deployAndConfigureExpressProvider,
	resolveExpressProviderConfig,
	type ComponentHealthCheck,
	type ExpressProviderResolvedConfig,
} from "./componentDeployment.js"
import { EXPRESSPROVIDER_DEPLOYMENT_FILE } from "./constants.js"
import { ensureCreate2Factory, formatFactoryPinHint } from "./create2Factory.js"
import { assertExpressProviderDeployable, assertRecipeNetworkTarget, type SafeManualAction } from "./deploymentRecipe.js"
import { checkpointDeployment, persistSubmittedTransaction, recoverCheckpointContractDeployments } from "./deploymentRecovery.js"
import { deployDiamond } from "./diamond.js"
import { getConnection } from "./helpers.js"
import { setHyperEVMBigBlocks } from "./hyperevm.js"
import { deployInstantLayer } from "./instantLayer.js"
import { logger } from "./logger.js"
import {
	assertConfiguredMuonPermissionsAuthorized,
	assertGeneralDeploymentMuonPermissions,
	assertMuonFunctionSupported,
	inspectConfiguredMuonPermissions,
	parseMuonFunctionPermissions,
	parseMuonFunctionUpnlValidTimes,
	REMOVE_MARGIN_MUON_FUNCTION,
} from "./muonPermissions.js"
import { deploySymmioPartyB } from "./partyB.js"
import {
	ProtocolConfig,
	hasChainProtocolConfig,
	loadProtocolConfig,
	resolveTemplateAddResumeAction,
	templateConfigMismatches,
	validateProtocolConfig,
} from "./protocolConfig.js"
import { activeDeploymentRecipe } from "./recipeRuntime.js"
import { assertMainnetSafe, isKnownMainnet } from "./safety.js"
import { deploySignatureVerifier } from "./signatureVerifier.js"
import { deployStablecoin } from "./stablecoin.js"
import { deploySymbolManager, grantSymbolManagerDiamondRoles, grantSymbolManagerOperatorRoles } from "./symbolManager.js"
import {
	bindDeploymentTransactionWriteAhead,
	clearDeploymentTransactionWriteAhead,
	DeploymentTransactionRecord,
	confirmDeploymentWithReceipt,
	getDeploymentTransactionJournal,
	reconcileDeploymentTransactions,
	resetDeploymentTransactionJournal,
	send,
} from "./tx.js"
import { createVanityContext } from "./vanityDeploy.js"
import { assertWithinBudget, buildVanityPlan, calibrateHashRate, formatVanityPlan } from "./vanityPlan.js"

interface DeploymentResult {
	contract: string
	address: string
	status: "success" | "failed" | "skipped"
	error?: string
	timestamp: string
}

interface SystemDeploymentReport {
	deploymentId: string
	deployerAddress: string
	network: string
	chainId: number
	manifestFingerprint: string
	recipe?: {
		name: string
		path: string
		digest: string
		components: { core: ComponentMode; partyB: ComponentMode; symbolManager: ComponentMode; expressProvider: ComponentMode }
	}
	lifecycle: "validating" | "pending_handover" | "complete" | "failed"
	checks: {
		health: "pending" | "passed" | "failed"
		verification: "pending" | "passed" | "failed" | "skipped"
		verificationPolicy: "required" | "explicitly_skipped" | "not_applicable"
		healthError?: string
		verificationError?: string
	}
	transactions: DeploymentTransactionRecord[]
	deployments: DeploymentResult[]
	config: {
		admin: string
		symmioFeeReceiver: string
		liquidationInsuranceVault: string
		maxLiquidationProfitPerPosition: string
		softLiquidationPenaltyCollector: string
		collateralAddress: string
		deployPartyB: boolean
		setAdlEnabled: boolean
		deploySymbolManager: boolean
		symbolManagerOperator: string
		registerDummyAffiliate: boolean
		setupInstantLayerTemplates: boolean
		signatureVerifierAddress: string
		deployMockVerifier: boolean
		muonAppId: string
		muonUpnlValidTime: string
		muonPriceValidTime: string
		muonFunctionUpnlValidTimes: Array<{ name: string; index: number; upnlValidTime: string }>
		muonPublicKeyX: string
		muonPublicKeyParity: string
		muonGatewaySigners: string[]
		muonFunctionPermissions: string[]
		partyBMode?: ComponentMode
		symbolManagerMode?: ComponentMode
		expressProviderMode?: ComponentMode
	}
	summary: {
		totalDeploymentGroups: number
		successfulDeploymentGroups: number
		failedDeploymentGroups: number
		skippedOrReusedDeploymentGroups: number
	}
	ownershipHandover?: {
		status: "pending_handover" | "complete"
		targets: Array<{ label: string; address: string; owner: string; pendingOwner: string }>
	}
	manualActions?: string[]
	safeActions?: SafeManualAction[]
	timestamp: string
	updatedAt: string
}

/**
 * Roles the deployer must hold on the core Diamond to complete setup.
 *
 * Accessibility.onlyRole checks the role EXACTLY (LibAccessibility.hasRole), so holding
 * DEFAULT_ADMIN_ROLE grants none of these — that only satisfies onlyRoleAdmin. Granted
 * right after setAdmin and revoked again by revokeDeployerPrivileges.
 *
 * Derived from the onlyRole modifiers on the ControlFacet functions setup calls:
 *   PROTOCOL_CONFIG_ROLE   balanceLimitPerUser, maxWithdrawParts, liquidatorShare,
 *                          pendingQuotesValidLength, maxPartyAConnectionLimit
 *   COOLDOWN_ADMIN_ROLE    deallocate/settlement/forceClose/forceCancel cooldowns,
 *                          deallocateDebounceTime, liquidationTimeout
 *   FEE_ADMIN_ROLE         setInvalidBridgedAmountsPool, setDefaultFeeCollector,
 *                          liquidation insurance and soft-liquidation receivers
 *   INTEGRATION_ADMIN_ROLE registerHook
 *   PARTY_B_MANAGER_ROLE   registerPartyB, setADLEnabled
 *   MUON_SETTER_ROLE       setMuonIds, setMuonConfig
 */
export const DEPLOYER_SETUP_ROLES = [
	"PROTOCOL_CONFIG_ROLE",
	"COOLDOWN_ADMIN_ROLE",
	"FEE_ADMIN_ROLE",
	"INTEGRATION_ADMIN_ROLE",
	"PARTY_B_MANAGER_ROLE",
	"MUON_SETTER_ROLE",
]

/**
 * Same problem on the AccountLayer: AccountLayerAccessibility.onlyRole is also an exact
 * check, and the AccountLayer's roles are granted to config.admin.
 *   SETTER_ROLE    setWhitelistedSymmioCore, setSymmioFeeReceiver
 *   APPROVER_ROLE  approveAffiliate
 */
export const ACCOUNTLAYER_DEPLOYER_SETUP_ROLES = ["SETTER_ROLE", "APPROVER_ROLE", "PAUSER_ROLE", "UNPAUSER_ROLE"]

interface DeployedContracts {
	create2Factory?: string
	collateral?: string
	diamond?: string
	signatureVerifier?: string
	accountLayerDiamond?: string
	instantLayer?: string
	symmioPartyB?: string
	accountManager?: string
	symbolManager?: string
	expressProvider?: string
}

type ExpressProviderStepResult = {
	address: string
	records: Array<{ name: string; address: string; constructorArguments: unknown[] }>
	manualActions: SafeManualAction[]
	checks: ComponentHealthCheck[]
}

export function parseBooleanSetting(value: string | undefined, name: string, defaultValue: boolean): boolean {
	if (value === undefined) return defaultValue
	if (value === "true") return true
	if (value === "false") return false
	throw new Error(`${name} must be exactly "true" or "false"; received ${JSON.stringify(value)}`)
}

export function assertDeploymentRecordPolicy(chainId: number | bigint, isSimulated: boolean, logData: boolean): void {
	if (!isSimulated && Number(chainId) !== 31337 && !logData) {
		throw new Error(
			"--log-data false is refused on live deployments: explorer verification and disaster recovery require durable chain-scoped records.",
		)
	}
}

function requireAddress(ethers: any, value: string, name: string): string {
	if (!value || !ethers.isAddress(value)) throw new Error(`${name} must be a valid non-zero address; received ${JSON.stringify(value)}`)
	const normalized = ethers.getAddress(value)
	if (normalized === ethers.ZeroAddress) throw new Error(`${name} must not be the zero address`)
	return normalized
}

function requireDecimalUint(value: string, name: string, minimum: bigint = BigInt(0)): string {
	if (!/^\d+$/.test(value)) throw new Error(`${name} must be an unsigned base-10 integer; received ${JSON.stringify(value)}`)
	const parsed = BigInt(value)
	if (parsed < minimum) throw new Error(`${name} must be >= ${minimum}; received ${value}`)
	const uint256Max = (BigInt(1) << BigInt(256)) - BigInt(1)
	if (parsed > uint256Max) throw new Error(`${name} must fit in uint256; received ${value}`)
	return parsed.toString()
}

export function deploymentConfigFromSource(source: Record<string, string | undefined>, deployerAddress: string, recipe?: DeploymentRecipe) {
	// Local deployments may default to the deployer. Real mainnets reject that default in
	// assertMainnetSafe: production administration must be an explicitly configured multisig.
	const adminWasExplicit = recipe ? true : Boolean(source.ADMIN_PUBLIC_KEY)
	const admin = source.ADMIN_PUBLIC_KEY || deployerAddress
	const symmioFeeReceiver = source.SYMMIO_FEE_RECEIVER || admin
	const liquidationInsuranceVault = source.LIQUIDATION_INSURANCE_VAULT || ""
	const maxLiquidationProfitPerPosition = source.MAX_LIQUIDATION_PROFIT_PER_POSITION || ""
	const softLiquidationPenaltyCollector = source.SOFT_LIQUIDATION_PENALTY_COLLECTOR || ""
	const collateralAddress = source.COLLATERAL_ADDRESS || ""
	const deployPartyB = parseBooleanSetting(source.DEPLOY_PARTYB, "DEPLOY_PARTYB", true)
	// Enable ADL for the deployed SymmioPartyB (only applied when DEPLOY_PARTYB is true). Default: false.
	const setAdlEnabled = parseBooleanSetting(source.SET_ADL_ENABLED, "SET_ADL_ENABLED", false)
	const deploySymbolManagerFlag = parseBooleanSetting(source.DEPLOY_SYMBOL_MANAGER, "DEPLOY_SYMBOL_MANAGER", true)
	const registerDummyAffiliate = parseBooleanSetting(source.REGISTER_DUMMY_AFFILIATE, "REGISTER_DUMMY_AFFILIATE", false)
	// Optional signer address for SymmioPartyB (ERC-1271 signature verification)
	const partyBSigner = source.PARTYB_SIGNER || ""
	// Optional operator address that will receive SYMBOL_ADDER_ROLE + SYMBOL_REMOVER_ROLE on the SymbolManager
	const symbolManagerOperator = source.SYMBOL_MANAGER_OPERATOR || ""
	// Setup InstantLayer templates (default: true, set to "false" to skip)
	const setupInstantLayerTemplates = parseBooleanSetting(source.SETUP_INSTANT_LAYER_TEMPLATES, "SETUP_INSTANT_LAYER_TEMPLATES", true)
	// Optional: use existing MuonSignatureVerifier address instead of deploying
	const signatureVerifierAddress = source.MUON_SIGNATURE_VERIFIER_ADDRESS || ""
	// Deploy MockMuonSignatureVerifier (accepts all signatures) instead of MuonSignatureVerifier
	const deployMockVerifier = parseBooleanSetting(source.DEPLOY_MOCK_VERIFIER, "DEPLOY_MOCK_VERIFIER", false)
	// Muon runtime config (defaults: 300s validity for both)
	const muonAppId = source.MUON_APP_ID || ""
	const muonUpnlValidTime = source.MUON_UPNL_VALID_TIME || "300"
	const muonPriceValidTime = source.MUON_PRICE_VALID_TIME || "300"
	const muonPublicKeyX = source.MUON_PUBLIC_KEY_X || ""
	const muonPublicKeyParity = source.MUON_PUBLIC_KEY_PARITY ?? ""
	const muonGatewaySigners = (source.MUON_GATEWAY_SIGNERS || "")
		.split(",")
		.map(s => s.trim())
		.filter(Boolean)
	const muonFunctionPermissions = source.MUON_FUNCTION_PERMISSIONS
		? parseMuonFunctionPermissions(source.MUON_FUNCTION_PERMISSIONS).map(({ name }) => name)
		: []
	// Per-function UPNL validity overrides; an absent function keeps the global window.
	const muonFunctionUpnlValidTimes = parseMuonFunctionUpnlValidTimes(source.MUON_FUNCTION_UPNL_VALID_TIMES ?? "").map(
		({ name, index, upnlValidTime }) => ({ name: name as string, index: index as number, upnlValidTime }),
	)

	return {
		admin,
		adminWasExplicit,
		symmioFeeReceiver,
		liquidationInsuranceVault,
		maxLiquidationProfitPerPosition,
		softLiquidationPenaltyCollector,
		collateralAddress,
		deployPartyB,
		setAdlEnabled,
		deploySymbolManager: deploySymbolManagerFlag,
		symbolManagerOperator,
		registerDummyAffiliate,
		partyBSigner,
		setupInstantLayerTemplates,
		signatureVerifierAddress,
		deployMockVerifier,
		muonAppId,
		muonUpnlValidTime,
		muonPriceValidTime,
		muonFunctionUpnlValidTimes,
		muonPublicKeyX,
		muonPublicKeyParity,
		muonGatewaySigners,
		muonFunctionPermissions,
		partyBMode: recipe?.partyB.mode,
		symbolManagerMode: recipe?.symbolManager.mode,
		expressProviderMode: recipe?.expressProvider.mode,
	}
}

export function resolveDeploymentProtocolConfig(chainId: number | bigint, recipe?: DeploymentRecipe): ProtocolConfig {
	if (recipe) {
		if (!recipe.core.protocol) throw new Error("Recipe core.protocol is required for deploy:system")
		validateProtocolConfig(recipe.core.protocol, `inline protocol config from recipe ${recipe.name}`)
		return recipe.core.protocol
	}
	return loadProtocolConfig(chainId)
}

async function getEnvConfig(hre: any, recipe?: DeploymentRecipe) {
	const { ethers } = await getConnection(hre)
	const [deployer] = await ethers.getSigners()
	if (!deployer) {
		throw new Error("No deployment signer is configured. Set NEW_DEPLOYER/TEAM_DEPLOYER or enable the named Hardhat keystore deployer account.")
	}
	const source: Record<string, string | undefined> = recipe ? activeDeploymentRecipe!.env : process.env
	return deploymentConfigFromSource(source, deployer.address, recipe)
}

/**
 * Validate and normalize every external deployment input before the first transaction.
 * Contract-code checks are reads, so a bad token/verifier address fails without spending
 * gas or creating a checkpoint that looks resumable.
 */
export async function validateDeploymentConfig(
	ethers: any,
	chainId: number | bigint,
	config: Awaited<ReturnType<typeof getEnvConfig>>,
	protocolConfig: ProtocolConfig,
	options: { isSimulated?: boolean } = {},
): Promise<void> {
	validateProtocolConfig(protocolConfig, `protocol config for chainId ${Number(chainId)}`)

	config.admin = requireAddress(ethers, config.admin, "ADMIN_PUBLIC_KEY")
	config.symmioFeeReceiver = requireAddress(ethers, config.symmioFeeReceiver, "SYMMIO_FEE_RECEIVER")
	// These settings are economically active: a zero insurance vault credits excess
	// liquidation funds to the zero-address ledger, and a zero soft-penalty collector
	// makes non-zero soft liquidations revert. Known-mainnet deployments and their fork
	// rehearsals must therefore supply reviewed values explicitly. Local/test networks use
	// the admin and the cross-chain reviewed 100e18 cap as convenient fixture defaults.
	if (isKnownMainnet(chainId)) {
		if (!config.liquidationInsuranceVault) throw new Error("LIQUIDATION_INSURANCE_VAULT is required for known-mainnet deployments and rehearsals")
		if (!config.maxLiquidationProfitPerPosition) {
			throw new Error("MAX_LIQUIDATION_PROFIT_PER_POSITION is required for known-mainnet deployments and rehearsals")
		}
		if (!config.softLiquidationPenaltyCollector) {
			throw new Error("SOFT_LIQUIDATION_PENALTY_COLLECTOR is required for known-mainnet deployments and rehearsals")
		}
	} else {
		config.liquidationInsuranceVault ||= config.admin
		config.maxLiquidationProfitPerPosition ||= "100000000000000000000"
		config.softLiquidationPenaltyCollector ||= config.admin
	}
	config.liquidationInsuranceVault = requireAddress(ethers, config.liquidationInsuranceVault, "LIQUIDATION_INSURANCE_VAULT")
	config.maxLiquidationProfitPerPosition = requireDecimalUint(
		config.maxLiquidationProfitPerPosition,
		"MAX_LIQUIDATION_PROFIT_PER_POSITION",
		BigInt(1),
	)
	config.softLiquidationPenaltyCollector = requireAddress(ethers, config.softLiquidationPenaltyCollector, "SOFT_LIQUIDATION_PENALTY_COLLECTOR")
	if (config.collateralAddress) config.collateralAddress = requireAddress(ethers, config.collateralAddress, "COLLATERAL_ADDRESS")
	if (config.signatureVerifierAddress) {
		config.signatureVerifierAddress = requireAddress(ethers, config.signatureVerifierAddress, "MUON_SIGNATURE_VERIFIER_ADDRESS")
	}
	if (config.partyBSigner) config.partyBSigner = requireAddress(ethers, config.partyBSigner, "PARTYB_SIGNER")
	if (config.deployPartyB && !config.partyBSigner) {
		throw new Error("PARTYB_SIGNER is required when DEPLOY_PARTYB=true; refusing to deploy a PartyB that cannot validate operational signatures")
	}
	if (!config.deployPartyB && config.partyBSigner) {
		throw new Error("PARTYB_SIGNER is set while DEPLOY_PARTYB=false; remove it or enable PartyB explicitly")
	}
	if (config.symbolManagerOperator) {
		config.symbolManagerOperator = requireAddress(ethers, config.symbolManagerOperator, "SYMBOL_MANAGER_OPERATOR")
	}
	if (config.deploySymbolManager && !config.symbolManagerOperator) {
		throw new Error("SYMBOL_MANAGER_OPERATOR is required when DEPLOY_SYMBOL_MANAGER=true; refusing to deploy an inoperable SymbolManager")
	}
	if (!config.deploySymbolManager && config.symbolManagerOperator) {
		throw new Error("SYMBOL_MANAGER_OPERATOR is set while DEPLOY_SYMBOL_MANAGER=false; remove it or enable the SymbolManager explicitly")
	}

	if (config.signatureVerifierAddress && config.deployMockVerifier) {
		throw new Error("MUON_SIGNATURE_VERIFIER_ADDRESS and DEPLOY_MOCK_VERIFIER=true are mutually exclusive")
	}

	config.muonUpnlValidTime = requireDecimalUint(config.muonUpnlValidTime, "MUON_UPNL_VALID_TIME", BigInt(1))
	config.muonPriceValidTime = requireDecimalUint(config.muonPriceValidTime, "MUON_PRICE_VALID_TIME", BigInt(1))
	for (const override of config.muonFunctionUpnlValidTimes) {
		// Zero is the on-chain "unset" sentinel; the parser already rejects it, but the deploy
		// path re-checks so a hand-set env var cannot silently clear an override.
		override.upnlValidTime = requireDecimalUint(override.upnlValidTime, `MUON_FUNCTION_UPNL_VALID_TIMES.${override.name}`, BigInt(1))
	}
	if (config.muonAppId) config.muonAppId = requireDecimalUint(config.muonAppId, "MUON_APP_ID", BigInt(1))

	const hasPublicKeyX = config.muonPublicKeyX !== ""
	const hasPublicKeyParity = config.muonPublicKeyParity !== ""
	if (hasPublicKeyX !== hasPublicKeyParity) {
		throw new Error("MUON_PUBLIC_KEY_X and MUON_PUBLIC_KEY_PARITY must either both be set or both be omitted")
	}
	if (hasPublicKeyX) {
		if (!/^(?:0x[0-9a-fA-F]+|\d+)$/.test(config.muonPublicKeyX)) {
			throw new Error(`MUON_PUBLIC_KEY_X must be an unsigned integer; received ${JSON.stringify(config.muonPublicKeyX)}`)
		}
		const publicKeyX = BigInt(config.muonPublicKeyX)
		const maxUint256 = (BigInt(1) << BigInt(256)) - BigInt(1)
		if (publicKeyX <= BigInt(0) || publicKeyX > maxUint256) throw new Error("MUON_PUBLIC_KEY_X must be in the uint256 range 1..2^256-1")
		config.muonPublicKeyX = publicKeyX.toString()
		if (config.muonPublicKeyParity !== "0" && config.muonPublicKeyParity !== "1") {
			throw new Error(`MUON_PUBLIC_KEY_PARITY must be exactly "0" or "1"; received ${JSON.stringify(config.muonPublicKeyParity)}`)
		}
	}

	const gatewaySigners = config.muonGatewaySigners.map((signer, index) => requireAddress(ethers, signer, `MUON_GATEWAY_SIGNERS[${index}]`))
	if (new Set(gatewaySigners.map(signer => signer.toLowerCase())).size !== gatewaySigners.length) {
		throw new Error("MUON_GATEWAY_SIGNERS must not contain duplicate addresses")
	}
	config.muonGatewaySigners = gatewaySigners

	if (config.collateralAddress) {
		const code = await ethers.provider.getCode(config.collateralAddress)
		if (code === "0x") throw new Error(`COLLATERAL_ADDRESS has no contract code on chainId ${Number(chainId)}: ${config.collateralAddress}`)
		try {
			const collateral = await ethers.getContractAt(
				[
					"function decimals() view returns (uint8)",
					"function totalSupply() view returns (uint256)",
					"function balanceOf(address) view returns (uint256)",
				],
				config.collateralAddress,
			)
			const [decimals] = await Promise.all([collateral.decimals(), collateral.totalSupply(), collateral.balanceOf(config.admin)])
			const normalizedDecimals = Number(decimals)
			if (!Number.isSafeInteger(normalizedDecimals) || normalizedDecimals < 0 || normalizedDecimals > 18) {
				throw new Error(`invalid decimals value ${String(decimals)}`)
			}
		} catch (err) {
			throw new Error(
				`COLLATERAL_ADDRESS ${config.collateralAddress} failed required ERC-20 probes (decimals, totalSupply, balanceOf): ` +
					`${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}
	if (config.signatureVerifierAddress) {
		await assertMuonFunctionSupported(
			ethers,
			config.signatureVerifierAddress,
			REMOVE_MARGIN_MUON_FUNCTION,
			"MUON_SIGNATURE_VERIFIER_ADDRESS",
		)
	}

	// A real verifier is unusable unless every normal protocol operation has both a
	// registered TSS key and gateway signer authorized for its MuonFunction category.
	// Apply this on every network so a rehearsal exercises the exact production profile.
	if (!config.deployMockVerifier) {
		if (!config.muonAppId) throw new Error("MUON_APP_ID is required when DEPLOY_MOCK_VERIFIER=false")
		assertGeneralDeploymentMuonPermissions(config.muonFunctionPermissions, "MUON_FUNCTION_PERMISSIONS")

		if (!config.signatureVerifierAddress) {
			if (!hasPublicKeyX) {
				throw new Error("MUON_PUBLIC_KEY_X and MUON_PUBLIC_KEY_PARITY are required when deploying a new MuonSignatureVerifier")
			}
			if (config.muonGatewaySigners.length === 0) {
				throw new Error("At least one MUON_GATEWAY_SIGNERS address is required when deploying a new MuonSignatureVerifier")
			}
		} else {
			try {
				const verifier = await ethers.getContractAt("MuonSignatureVerifier", config.signatureVerifierAddress)
				const [existingKeysRaw, existingGatewaySignersRaw, defaultAdminRole, setterRole, signers] = await Promise.all([
					verifier.getAllPublicKeys(),
					verifier.getAllGatewaySigners(),
					verifier.DEFAULT_ADMIN_ROLE(),
					verifier.SETTER_ROLE(),
					ethers.getSigners(),
				])
				const existingKeys = existingKeysRaw.map((key: { x: bigint; parity: bigint | number }) => ({
					x: key.x.toString(),
					parity: Number(key.parity),
				}))
				const existingGatewaySigners = existingGatewaySignersRaw.map((signer: string) => ethers.getAddress(signer))
				const targetKeys = hasPublicKeyX ? [{ x: config.muonPublicKeyX, parity: Number(config.muonPublicKeyParity) }] : existingKeys
				const targetGatewaySigners = config.muonGatewaySigners.length > 0 ? config.muonGatewaySigners : existingGatewaySigners

				if (targetKeys.length === 0) throw new Error("Existing MuonSignatureVerifier has no public keys configured")
				if (targetGatewaySigners.length === 0) throw new Error("Existing MuonSignatureVerifier has no gateway signers configured")

				const deployer = signers[0]
				if (!deployer) throw new Error("No deployment signer is configured for existing MuonSignatureVerifier preflight")
				const [deployerIsAdmin, deployerIsSetter, adminIsAdmin, adminIsSetter] = await Promise.all([
					verifier.hasRole(defaultAdminRole, deployer.address),
					verifier.hasRole(setterRole, deployer.address),
					verifier.hasRole(defaultAdminRole, config.admin),
					verifier.hasRole(setterRole, config.admin),
				])
				if (!adminIsAdmin && !deployerIsAdmin) {
					throw new Error(`ADMIN_PUBLIC_KEY lacks DEFAULT_ADMIN_ROLE on existing MuonSignatureVerifier ${config.signatureVerifierAddress}`)
				}
				if (!adminIsSetter && !deployerIsAdmin) {
					throw new Error(`ADMIN_PUBLIC_KEY lacks SETTER_ROLE on existing MuonSignatureVerifier ${config.signatureVerifierAddress}`)
				}

				const registeredKeyIds = new Set(existingKeys.map((key: { x: string; parity: number }) => `${key.x}:${key.parity}`))
				const registeredGatewaySigners = new Set(existingGatewaySigners.map((signer: string) => signer.toLowerCase()))
				const missingRegistration = [
					...targetKeys
						.filter((key: { x: string; parity: number }) => !registeredKeyIds.has(`${key.x}:${key.parity}`))
						.map((key: { x: string; parity: number }) => `public key x=${key.x}, parity=${key.parity}`),
					...targetGatewaySigners
						.filter((signer: string) => !registeredGatewaySigners.has(signer.toLowerCase()))
						.map((signer: string) => `gateway signer ${signer}`),
				]
				const inspection = await inspectConfiguredMuonPermissions(verifier, {
					publicKeys: targetKeys,
					gatewaySigners: targetGatewaySigners,
					permissionNames: config.muonFunctionPermissions,
				})
				if ((missingRegistration.length > 0 || !inspection.fullyAuthorized) && !deployerIsSetter) {
					const permissionProblems = [
						...inspection.publicKeys
							.filter(result => !result.fullyAuthorized)
							.map(
								result =>
									`public key x=${String(result.publicKey.x)}, parity=${result.publicKey.parity} missing ${result.missingPermissions.join(", ")}`,
							),
						...inspection.gatewaySigners
							.filter(result => !result.fullyAuthorized)
							.map(result => `gateway signer ${result.signer} missing ${result.missingPermissions.join(", ")}`),
					]
					throw new Error(
						`Existing MuonSignatureVerifier requires repair, but deployer ${deployer.address} lacks SETTER_ROLE:\n  - ${[
							...missingRegistration.map(item => `${item} is not registered`),
							...permissionProblems,
						].join("\n  - ")}`,
					)
				}
			} catch (err) {
				throw new Error(
					`Unable to validate existing Muon verifier ${config.signatureVerifierAddress}: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}
	}
}

type DeploymentStep = {
	id: string
	title: string
	order: number
	run: () => Promise<void>
}

async function runDeploymentStep(checkpoint: DeploymentCheckpoint, step: DeploymentStep): Promise<void> {
	checkpoint.step = step.id
	saveCheckpoint(checkpoint)
	logger.info(`Step ${step.order}: ${step.title}...`)
	try {
		await step.run()
	} finally {
		// Preserve transaction evidence even when a step fails. getDeploymentTransactionJournal
		// contains this process's complete run, so merge by immutable submission outcome.
		const combined = [...(checkpoint.transactions || []), ...getDeploymentTransactionJournal()]
		checkpoint.transactions = [
			...new Map(combined.map(record => [`${record.hash}:${record.replacementHash || ""}:${record.status}`, record])).values(),
		]
		saveCheckpoint(checkpoint)
	}
}

export const deployAllTask = task("deploy:system", "Deploys all system contracts and sets up the complete environment")
	.addOption({
		name: "verify",
		description: "Verify contracts after deployment (defaults true on non-local live networks)",
		type: ArgumentType.BOOLEAN,
		defaultValue: true,
	})
	.addOption({ name: "logData", description: "Write deployment addresses to data files", type: ArgumentType.BOOLEAN, defaultValue: true })
	.addOption({ name: "fresh", description: "Ignore checkpoint and start fresh deployment", type: ArgumentType.BOOLEAN, defaultValue: false })
	.addOption({
		name: "deployFakeStablecoin",
		description: "Deploy FakeStablecoin as collateral (overrides COLLATERAL_ADDRESS env)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "deployPartyb",
		description: "Deploy SymmioPartyB (overrides DEPLOY_PARTYB env)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "setAdlEnabled",
		description: "Enable ADL for the deployed SymmioPartyB (overrides SET_ADL_ENABLED env)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "deploySymbolManager",
		description: "Deploy SymmioSymbolManager (overrides DEPLOY_SYMBOL_MANAGER env)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "symbolManagerOperator",
		description: "Address to grant SYMBOL_ADDER_ROLE + SYMBOL_REMOVER_ROLE on SymbolManager (overrides SYMBOL_MANAGER_OPERATOR env)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "deployMockVerifier",
		description: "Deploy MockMuonSignatureVerifier instead of real verifier (overrides DEPLOY_MOCK_VERIFIER env)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "registerDummyAffiliate",
		description: "Register a dummy affiliate for testing (overrides REGISTER_DUMMY_AFFILIATE env)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "setupInstantLayerTemplates",
		description: "Setup InstantLayer templates (overrides SETUP_INSTANT_LAYER_TEMPLATES env)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "allowUnsafeMainnet",
		description: "Proceed despite mainnet safety violations; also requires UNSAFE_MAINNET_CONFIRM_CHAIN_ID to equal the connected chain id",
		type: ArgumentType.BOOLEAN,
		defaultValue: false,
	})
	.addOption({
		name: "allowNewCreate2Factory",
		description: "Permit deploying a CREATE2 factory even though a previous deployment report for this chain already names one",
		type: ArgumentType.BOOLEAN,
		defaultValue: false,
	})
	.setAction(async () => ({
		default: async (
			{
				verify,
				logData,
				fresh,
				deployFakeStablecoin,
				deployPartyb,
				setAdlEnabled: setAdlEnabledFlag,
				deploySymbolManager: deploySymbolManagerFlag,
				symbolManagerOperator: symbolManagerOperatorFlag,
				deployMockVerifier,
				registerDummyAffiliate: registerDummyAffiliateFlag,
				setupInstantLayerTemplates: setupIlTemplatesFlag,
				allowUnsafeMainnet,
				allowNewCreate2Factory,
			},
			hre,
		) => {
			const recipeRuntime = activeDeploymentRecipe
			const recipe = recipeRuntime?.recipe
			if (recipe) {
				// The shared planner is the single executable-mode contract used by doctor,
				// the CLI preview, standalone components, and this direct task entry point.
				createDeploymentPlan(recipe)
				const legacyOverrides = [
					["--deploy-fake-stablecoin", deployFakeStablecoin],
					["--deploy-partyb", deployPartyb],
					["--set-adl-enabled", setAdlEnabledFlag],
					["--deploy-symbol-manager", deploySymbolManagerFlag],
					["--symbol-manager-operator", symbolManagerOperatorFlag],
					["--deploy-mock-verifier", deployMockVerifier],
					["--register-dummy-affiliate", registerDummyAffiliateFlag],
					["--setup-instant-layer-templates", setupIlTemplatesFlag],
				].filter(([, value]) => value !== undefined)
				if (legacyOverrides.length > 0 || allowUnsafeMainnet) {
					throw new Error(
						`Recipe mode refuses public command-line overrides (${legacyOverrides.map(([name]) => name).join(", ") || "--allow-unsafe-mainnet"}). ` +
							`Edit and review ${recipeRuntime.path}; the JSON recipe is the sole deployment intent.`,
					)
				}
				if (recipe.core.mode !== "deploy") {
					throw new Error(`LIVE_TARGET_UNSUPPORTED: deploy:system requires core.mode=deploy; received ${recipe.core.mode}`)
				}
				if (recipe.expressProvider.mode === "deploy") assertExpressProviderDeployable(recipe.expressProvider, recipe.network)
				if (recipe.partyB.mode === "reuse" || recipe.symbolManager.mode === "reuse") {
					throw new Error(
						"LIVE_TARGET_UNSUPPORTED: deploy:system cannot safely reuse PartyB or SymbolManager while deploying a brand-new core, because their core binding cannot be proven before the new core address exists. Use mode=deploy/skip, or deploy the add-on separately against core.fromReport.",
					)
				}
				verify = recipe.execution.verify
				logData = true
			}
			const connection = await getConnection(hre)
			const { ethers } = connection
			const [deployer] = await ethers.getSigners()
			if (!deployer) {
				throw new Error("No deployment signer is configured. Set NEW_DEPLOYER/TEAM_DEPLOYER or enable the named Hardhat keystore deployer account.")
			}
			const deployerAddress = deployer.address
			const config = await getEnvConfig(hre, recipe)

			// CLI flags override env vars when explicitly provided
			if (deployFakeStablecoin !== undefined && parseBooleanSetting(deployFakeStablecoin, "--deploy-fake-stablecoin", false)) {
				config.collateralAddress = ""
			}
			if (deployPartyb !== undefined) config.deployPartyB = parseBooleanSetting(deployPartyb, "--deploy-partyb", config.deployPartyB)
			if (setAdlEnabledFlag !== undefined) {
				config.setAdlEnabled = parseBooleanSetting(setAdlEnabledFlag, "--set-adl-enabled", config.setAdlEnabled)
			}
			if (deploySymbolManagerFlag !== undefined) {
				config.deploySymbolManager = parseBooleanSetting(deploySymbolManagerFlag, "--deploy-symbol-manager", config.deploySymbolManager)
			}
			if (symbolManagerOperatorFlag !== undefined) config.symbolManagerOperator = symbolManagerOperatorFlag
			if (deployMockVerifier !== undefined) {
				config.deployMockVerifier = parseBooleanSetting(deployMockVerifier, "--deploy-mock-verifier", config.deployMockVerifier)
			}
			if (registerDummyAffiliateFlag !== undefined) {
				config.registerDummyAffiliate = parseBooleanSetting(registerDummyAffiliateFlag, "--register-dummy-affiliate", config.registerDummyAffiliate)
			}
			if (setupIlTemplatesFlag !== undefined) {
				config.setupInstantLayerTemplates = parseBooleanSetting(
					setupIlTemplatesFlag,
					"--setup-instant-layer-templates",
					config.setupInstantLayerTemplates,
				)
			}
			const network = connection.networkName || "unknown"
			const chainId = (await ethers.provider.getNetwork()).chainId
			// An edr-simulated network (the fork-* entries) reports its upstream chainId, so
			// fork-arbitrum looks like chainId 42161. Scope its records and checkpoint
			// separately, or a rehearsal overwrites the real Arbitrum ones.
			const isSimulatedNetwork = (connection as any).networkConfig?.type === "edr-simulated"
			if (recipe) {
				assertRecipeNetworkTarget(recipe.network, {
					network,
					chainId: Number(chainId),
					simulated: isSimulatedNetwork,
				})
			}
			const verificationApplicable = !isSimulatedNetwork && Number(chainId) !== 31337
			if (verificationApplicable && !verify) {
				throw new Error("--verify=false is refused on non-local deployments; explorer verification is a required deployment gate")
			}
			setDataScope(chainId, { simulated: isSimulatedNetwork })
			setCheckpointSimulated(isSimulatedNetwork)
			assertDeploymentRecordPolicy(chainId, isSimulatedNetwork, logData)

			// A production chain must have an explicit, reviewed config. Built-in defaults are
			// retained only for local development: silently applying them to a live chain is not
			// a safe deployment mode. Fork rehearsals enforce the same requirement.
			if (!recipe && isKnownMainnet(chainId) && !hasChainProtocolConfig(chainId)) {
				throw new Error(
					`Missing required protocol config tasks/config/protocol-${Number(chainId)}.json for mainnet chainId ${Number(chainId)}. ` +
						"Create and review the chain-specific parameters and InstantLayer templates before deploying or rehearsing.",
				)
			}

			// Load and validate all configuration before checkpoint mutation or the first tx.
			const protocolConfig = resolveDeploymentProtocolConfig(chainId, recipe)
			assertMainnetSafe(
				chainId,
				deployerAddress,
				{
					deployMockVerifier: config.deployMockVerifier,
					collateralAddress: config.collateralAddress,
					registerDummyAffiliate: config.registerDummyAffiliate,
					adminAddress: config.admin,
					adminWasExplicit: config.adminWasExplicit,
				},
				allowUnsafeMainnet,
				isSimulatedNetwork,
			)
			await validateDeploymentConfig(ethers, chainId, config, protocolConfig, { isSimulated: isSimulatedNetwork })
			const manifestIntent = {
				recipe: recipeRuntime
					? {
							name: recipeRuntime.recipe.name,
							path: recipeRuntime.identityPath,
							digest: recipeRuntime.digest,
							components: {
								core: recipeRuntime.recipe.core.mode,
								partyB: recipeRuntime.recipe.partyB.mode,
								symbolManager: recipeRuntime.recipe.symbolManager.mode,
								expressProvider: recipeRuntime.recipe.expressProvider.mode,
							},
						}
					: undefined,
				network,
				chainId: Number(chainId),
				simulated: isSimulatedNetwork,
				deployer: deployerAddress,
				create2: recipe?.create2 ?? null,
				config,
				protocolConfig,
			}

			// Check for existing checkpoint (using chainId as primary identifier)
			let checkpoint: DeploymentCheckpoint | null = null
			if (!fresh) {
				checkpoint = loadCheckpoint(Number(chainId))
				if (checkpoint) {
					displayCheckpointStatus(checkpoint)
					logger.info("Resuming deployment from checkpoint...")
					logger.info("Use --fresh=true flag to start a new deployment.\n")
				}
			} else {
				// --fresh used to silently overwrite the existing checkpoint on the next
				// save, destroying the record of contracts already deployed on this chain.
				// Archive it under checkpoints/abandoned/ instead.
				if (loadCheckpoint(Number(chainId))) {
					logger.info("--fresh: archiving the existing checkpoint before starting over...")
					clearCheckpoint(Number(chainId), network, "abandoned")
					logger.info()
				}
			}

			const isResume = checkpoint !== null
			// Create new checkpoint if none exists
			if (!checkpoint) {
				checkpoint = createCheckpoint(network, Number(chainId))
			}

			// Resolve vanity intent before any component deploys. assertWithinBudget reads pattern
			// lengths only, never the address, so an unaffordable plan still stops the run while
			// nothing has been broadcast. ensureCreate2Factory is the only step here that can send
			// a transaction, and it runs with the checkpoint so its creation is journalled.
			const vanityPlan = buildVanityPlan(recipe?.create2)
			let create2FactoryDeployed = false
			if (vanityPlan) {
				const hashRate = calibrateHashRate()
				assertWithinBudget(vanityPlan, hashRate)
				logger.info(formatVanityPlan(vanityPlan, hashRate))
				const factory = await ensureCreate2Factory(hre, vanityPlan, {
					checkpoint,
					isLive: recipe?.network.mode === "live",
					allowNewFactory: allowNewCreate2Factory,
					logData,
				})
				create2FactoryDeployed = factory.deployed
			}
			const vanity = createVanityContext(ethers, vanityPlan)

			const currentManifest = createDeploymentManifest(manifestIntent, {
				deploymentId: checkpoint.deploymentId || checkpoint.manifest?.deploymentId,
			})
			if (isResume) {
				assertCheckpointManifest(checkpoint, currentManifest)
			}
			checkpoint.deploymentId = currentManifest.deploymentId
			checkpoint.deployerAddress = deployerAddress
			checkpoint.manifest = currentManifest
			// Explorer publication is meaningless for an ephemeral fork/local node, and is
			// mandatory by default everywhere else. Once requested on a live deployment it
			// remains sticky across resumes until it passes.
			checkpoint.verificationRequired = verificationApplicable && Boolean(checkpoint.verificationRequired || verify)
			if (checkpoint.verificationRequired && !checkpoint.verificationStatus) checkpoint.verificationStatus = "pending"
			const verificationRequired = checkpoint.verificationRequired
			const verificationPolicy: SystemDeploymentReport["checks"]["verificationPolicy"] = verificationRequired
				? "required"
				: verificationApplicable
					? "explicitly_skipped"
					: "not_applicable"
			if (isResume) {
				let reconciled = 0
				try {
					reconciled = await reconcileDeploymentTransactions(checkpoint.transactions || [], ethers.provider, checkpoint.deployerAddress)
				} finally {
					// Persist any records resolved before a later unresolved hash blocked the resume.
					saveCheckpoint(checkpoint)
				}
				if (reconciled > 0) logger.info(`Reconciled ${reconciled} previously unresolved deployment transaction(s).`)
			}
			await recoverCheckpointContractDeployments(checkpoint, ethers.provider, "contracts")
			await assertCheckpointContractsHaveCode(checkpoint, address => ethers.provider.getCode(address))
			resetDeploymentTransactionJournal()
			saveCheckpoint(checkpoint)

			logger.info("=".repeat(80))
			logger.info("SYSTEM DEPLOYMENT STARTED")
			logger.info("=".repeat(80))
			logger.info(`Network: ${network}`)
			logger.info(`Chain ID: ${chainId}`)
			logger.info(`Deployer: ${deployer.address}`)
			logger.info(`Admin: ${config.admin}`)
			logger.info(`Symmio Fee Receiver: ${config.symmioFeeReceiver}`)
			logger.info(`Liquidation Insurance Vault: ${config.liquidationInsuranceVault}`)
			logger.info(`Max Liquidation Profit Per Position: ${config.maxLiquidationProfitPerPosition}`)
			logger.info(`Soft Liquidation Penalty Collector: ${config.softLiquidationPenaltyCollector}`)
			logger.info(`Collateral Address: ${config.collateralAddress || "(will deploy FakeStablecoin)"}`)
			logger.info(`Deploy PartyB: ${config.deployPartyB}`)
			logger.info(`Set ADL Enabled: ${config.setAdlEnabled}`)
			logger.info(`PartyB Signer: ${config.partyBSigner || "(not set)"}`)
			logger.info(`Deploy SymbolManager: ${config.deploySymbolManager}`)
			logger.info(`SymbolManager Operator: ${config.symbolManagerOperator || "(not set)"}`)
			logger.info(`Register Dummy Affiliate: ${config.registerDummyAffiliate}`)
			logger.info(`Setup InstantLayer Templates: ${config.setupInstantLayerTemplates}`)
			logger.info(
				`Signature Verifier Address: ${config.signatureVerifierAddress || (config.deployMockVerifier ? "(will deploy MockMuonSignatureVerifier)" : "(will deploy MuonSignatureVerifier)")}`,
			)
			logger.info(`Muon App ID: ${config.muonAppId || "(not set)"}`)
			logger.info(`Muon UPNL Valid Time: ${config.muonUpnlValidTime}${process.env.MUON_UPNL_VALID_TIME ? "" : " (default)"}`)
			logger.info(`Muon Price Valid Time: ${config.muonPriceValidTime}${process.env.MUON_PRICE_VALID_TIME ? "" : " (default)"}`)
			if (config.muonFunctionUpnlValidTimes.length > 0) {
				const overrides = config.muonFunctionUpnlValidTimes.map(({ name, upnlValidTime }) => `${name}=${upnlValidTime}`).join(", ")
				logger.info(`Muon UPNL Valid Time Overrides: ${overrides}`)
			}
			logger.info(`Muon Public Key X: ${config.muonPublicKeyX || "(not set)"}`)
			logger.info(`Muon Public Key Parity: ${config.muonPublicKeyParity || "(not set)"}`)
			logger.info(`Muon Gateway Signers: ${config.muonGatewaySigners.length > 0 ? config.muonGatewaySigners.join(",") : "(not set)"}`)
			logger.info(
				`Muon Function Permissions: ${config.muonFunctionPermissions.length > 0 ? config.muonFunctionPermissions.join(",") : config.deployMockVerifier ? "(not applicable to mock verifier)" : "(not set)"}`,
			)
			logger.info("=".repeat(80))
			logger.info()

			const deploymentResults: DeploymentResult[] = []
			// The factory is bound above, before any component deploys, so it is safe to read here.
			const deployedContracts: DeployedContracts = vanityPlan ? { create2Factory: vanityPlan.factoryAddress } : {}
			let expressProviderResult: ExpressProviderStepResult | undefined

			// HyperEVM (chainId 999 mainnet, 998 testnet) requires big blocks for facet deployment
			const isHyperEVM = !isSimulatedNetwork && (Number(chainId) === 999 || Number(chainId) === 998)
			let bigBlocksEnabled = false
			let deploymentError: unknown
			let deploymentStepOrder = 0
			bindDeploymentTransactionWriteAhead(record => persistSubmittedTransaction(checkpoint, record))
			try {
				if (isHyperEVM) {
					logger.info("HyperEVM detected — enabling big blocks for contract deployment...")
					// Mark cleanup required before the API call so even a partial/ambiguous
					// enable failure triggers a best-effort disable in finally.
					bigBlocksEnabled = true
					await setHyperEVMBigBlocks(hre, true)
					logger.info()
				}

				await runDeploymentStep(checkpoint, {
					id: "collateral",
					title: "Setting up Collateral",
					order: ++deploymentStepOrder,
					run: async () => {
						if (config.collateralAddress) {
							logger.info(`Using existing collateral at: ${config.collateralAddress}`)
							deployedContracts.collateral = config.collateralAddress
							// Save to checkpoint for reference
							if (!checkpoint.contracts.collateral) {
								checkpoint.contracts.collateral = createDeployedContract(config.collateralAddress)
								saveCheckpoint(checkpoint)
							}
							deploymentResults.push({
								contract: "Collateral (existing)",
								address: config.collateralAddress,
								status: "skipped",
								timestamp: new Date().toISOString(),
							})
						} else {
							try {
								const wasAlreadyDeployed = !!checkpoint.contracts.collateral
								logger.info(wasAlreadyDeployed ? "Resuming FakeStablecoin..." : "Deploying FakeStablecoin...")
								const stablecoin = await deployStablecoin(hre, { logData, checkpoint })
								deployedContracts.collateral = await stablecoin.getAddress()
								logger.info(`FakeStablecoin deployed at: ${deployedContracts.collateral}`)
								deploymentResults.push({
									contract: "FakeStablecoin",
									address: deployedContracts.collateral!,
									status: wasAlreadyDeployed ? "skipped" : "success",
									timestamp: new Date().toISOString(),
								})
							} catch (err: any) {
								logger.error(`Failed to deploy FakeStablecoin: ${err.message}`)
								deploymentResults.push({
									contract: "FakeStablecoin",
									address: "N/A",
									status: "failed",
									error: err.message,
									timestamp: new Date().toISOString(),
								})
								throw err
							}
						}
						logger.info()
					},
				})

				await runDeploymentStep(checkpoint, {
					id: "diamond",
					title: "Deploying Diamond",
					order: ++deploymentStepOrder,
					run: async () => {
						try {
							const wasAlreadyComplete = !!checkpoint.contracts.diamond?.diamondCutComplete
							const diamond = await deployDiamond(hre, { logData, genABI: false, reportGas: false, checkpoint, vanity })
							deployedContracts.diamond = await diamond.getAddress()
							logger.info(`Diamond deployed at: ${deployedContracts.diamond}`)
							deploymentResults.push({
								contract: "Diamond",
								address: deployedContracts.diamond!,
								status: wasAlreadyComplete ? "skipped" : "success",
								timestamp: new Date().toISOString(),
							})
						} catch (err: any) {
							logger.error(`Failed to deploy Diamond: ${err.message}`)
							deploymentResults.push({
								contract: "Diamond",
								address: "N/A",
								status: "failed",
								error: err.message,
								timestamp: new Date().toISOString(),
							})
							throw err
						}
						logger.info()
					},
				})

				await runDeploymentStep(checkpoint, {
					id: "signatureVerifier",
					title: config.deployMockVerifier ? "Setting up MockMuonSignatureVerifier" : "Setting up MuonSignatureVerifier",
					order: ++deploymentStepOrder,
					run: async () => {
						if (config.signatureVerifierAddress) {
							logger.info(`Using existing MuonSignatureVerifier at: ${config.signatureVerifierAddress}`)
							deployedContracts.signatureVerifier = config.signatureVerifierAddress
							if (!checkpoint.contracts.signatureVerifier) {
								checkpoint.contracts.signatureVerifier = createDeployedContract(config.signatureVerifierAddress)
								saveCheckpoint(checkpoint)
							}
							deploymentResults.push({
								contract: "MuonSignatureVerifier (existing)",
								address: config.signatureVerifierAddress,
								status: "skipped",
								timestamp: new Date().toISOString(),
							})
						} else if (config.deployMockVerifier) {
							try {
								const wasAlreadyDeployed = !!checkpoint.contracts.signatureVerifier
								if (wasAlreadyDeployed) {
									const address = checkpoint.contracts.signatureVerifier!.address
									logger.info(`Resuming MockMuonSignatureVerifier at ${address}...`)
									deployedContracts.signatureVerifier = address
								} else {
									logger.info("Deploying MockMuonSignatureVerifier...")
									const factory = await ethers.getContractFactory("MockMuonSignatureVerifier")
									const mock = await factory.connect(deployer).deploy()
									const deployment = await confirmDeploymentWithReceipt(
										mock,
										"MockMuonSignatureVerifier",
										checkpointDeployment(checkpoint, "contracts.signatureVerifier"),
									)
									deployedContracts.signatureVerifier = deployment.address
									checkpoint.contracts.signatureVerifier = createDeployedContract(deployedContracts.signatureVerifier!)
									saveCheckpoint(checkpoint)
								}
								logger.info(`MockMuonSignatureVerifier deployed at: ${deployedContracts.signatureVerifier}`)
								deploymentResults.push({
									contract: "MockMuonSignatureVerifier",
									address: deployedContracts.signatureVerifier!,
									status: wasAlreadyDeployed ? "skipped" : "success",
									timestamp: new Date().toISOString(),
								})
							} catch (err: any) {
								logger.error(`Failed to deploy MockMuonSignatureVerifier: ${err.message}`)
								deploymentResults.push({
									contract: "MockMuonSignatureVerifier",
									address: "N/A",
									status: "failed",
									error: err.message,
									timestamp: new Date().toISOString(),
								})
								throw err
							}
						} else {
							try {
								const wasAlreadyDeployed = !!checkpoint.contracts.signatureVerifier
								logger.info(wasAlreadyDeployed ? "Resuming MuonSignatureVerifier..." : "Deploying MuonSignatureVerifier...")
								const signatureVerifier = await deploySignatureVerifier(hre, {
									admin: deployerAddress,
									logData,
									checkpoint,
								})
								deployedContracts.signatureVerifier = await signatureVerifier.getAddress()
								logger.info(`MuonSignatureVerifier deployed at: ${deployedContracts.signatureVerifier}`)
								deploymentResults.push({
									contract: "MuonSignatureVerifier",
									address: deployedContracts.signatureVerifier!,
									status: wasAlreadyDeployed ? "skipped" : "success",
									timestamp: new Date().toISOString(),
								})
							} catch (err: any) {
								logger.error(`Failed to deploy MuonSignatureVerifier: ${err.message}`)
								deploymentResults.push({
									contract: "MuonSignatureVerifier",
									address: "N/A",
									status: "failed",
									error: err.message,
									timestamp: new Date().toISOString(),
								})
								throw err
							}
						}
						logger.info()
					},
				})

				await runDeploymentStep(checkpoint, {
					id: "accountLayerDiamond",
					title: "Deploying AccountLayer Diamond",
					order: ++deploymentStepOrder,
					run: async () => {
						try {
							const wasAlreadyComplete = !!checkpoint.contracts.accountLayerDiamond?.diamondCutComplete
							const accountLayerResult = await deployAccountLayerDiamond(hre, {
								admin: deployer,
								symmioFeeReceiver: deployer,
								logData,
								checkpoint,
								vanity,
							})
							deployedContracts.accountLayerDiamond = accountLayerResult.diamond
							logger.info(`AccountLayerDiamond deployed at: ${deployedContracts.accountLayerDiamond}`)
							deploymentResults.push({
								contract: "AccountLayerDiamond",
								address: deployedContracts.accountLayerDiamond,
								status: wasAlreadyComplete ? "skipped" : "success",
								timestamp: new Date().toISOString(),
							})
						} catch (err: any) {
							logger.error(`Failed to deploy AccountLayerDiamond: ${err.message}`)
							deploymentResults.push({
								contract: "AccountLayerDiamond",
								address: "N/A",
								status: "failed",
								error: err.message,
								timestamp: new Date().toISOString(),
							})
							throw err
						}
						logger.info()
					},
				})

				await runDeploymentStep(checkpoint, {
					id: "instantLayer",
					title: "Deploying InstantLayer",
					order: ++deploymentStepOrder,
					run: async () => {
						try {
							const wasAlreadyDeployed = !!checkpoint.contracts.instantLayer
							const instantLayer = await deployInstantLayer(hre, {
								symmioaddress: deployedContracts.diamond!,
								admin: deployerAddress,
								logData,
								checkpoint,
							})
							deployedContracts.instantLayer = await instantLayer.getAddress()
							logger.info(`InstantLayer deployed at: ${deployedContracts.instantLayer}`)
							deploymentResults.push({
								contract: "InstantLayer",
								address: deployedContracts.instantLayer!,
								status: wasAlreadyDeployed ? "skipped" : "success",
								timestamp: new Date().toISOString(),
							})
						} catch (err: any) {
							logger.error(`Failed to deploy InstantLayer: ${err.message}`)
							deploymentResults.push({
								contract: "InstantLayer",
								address: "N/A",
								status: "failed",
								error: err.message,
								timestamp: new Date().toISOString(),
							})
							throw err
						}
						logger.info()
					},
				})

				if (config.deployPartyB) {
					await runDeploymentStep(checkpoint, {
						id: "symmioPartyB",
						title: "Deploying SymmioPartyB",
						order: ++deploymentStepOrder,
						run: async () => {
							try {
								const wasAlreadyDeployed = !!checkpoint.contracts.symmioPartyB
								const symmioPartyB = await deploySymmioPartyB(hre, {
									symmioAddress: deployedContracts.diamond!,
									admin: deployerAddress,
									logData,
									checkpoint,
								})
								deployedContracts.symmioPartyB = await symmioPartyB.getAddress()
								logger.info(`SymmioPartyB deployed at: ${deployedContracts.symmioPartyB}`)
								deploymentResults.push({
									contract: "SymmioPartyB",
									address: deployedContracts.symmioPartyB!,
									status: wasAlreadyDeployed ? "skipped" : "success",
									timestamp: new Date().toISOString(),
								})
							} catch (err: any) {
								logger.error(`Failed to deploy SymmioPartyB: ${err.message}`)
								deploymentResults.push({
									contract: "SymmioPartyB",
									address: "N/A",
									status: "failed",
									error: err.message,
									timestamp: new Date().toISOString(),
								})
								throw err
							}
							logger.info()
						},
					})
				}

				if (config.deploySymbolManager) {
					await runDeploymentStep(checkpoint, {
						id: "symbolManager",
						title: "Deploying SymmioSymbolManager",
						order: ++deploymentStepOrder,
						run: async () => {
							try {
								const wasAlreadyDeployed = !!checkpoint.contracts.symbolManager
								const symbolManager = await deploySymbolManager(hre, {
									symmioAddress: deployedContracts.diamond!,
									admin: config.admin,
									logData,
									checkpoint,
								})
								deployedContracts.symbolManager = await symbolManager.getAddress()
								logger.info(`SymmioSymbolManager deployed at: ${deployedContracts.symbolManager}`)
								deploymentResults.push({
									contract: "SymmioSymbolManager",
									address: deployedContracts.symbolManager!,
									status: wasAlreadyDeployed ? "skipped" : "success",
									timestamp: new Date().toISOString(),
								})
							} catch (err: any) {
								logger.error(`Failed to deploy SymmioSymbolManager: ${err.message}`)
								deploymentResults.push({
									contract: "SymmioSymbolManager",
									address: "N/A",
									status: "failed",
									error: err.message,
									timestamp: new Date().toISOString(),
								})
								throw err
							}
							logger.info()
						},
					})
				}

				// All contracts are deployed — switch back to fast blocks for setup/config calls
				if (bigBlocksEnabled) {
					logger.info("Contract deployment complete — disabling big blocks for setup phase...")
					await setHyperEVMBigBlocks(hre, false)
					bigBlocksEnabled = false
					logger.info()
				}

				await runDeploymentStep(checkpoint, {
					id: "systemSetup",
					title: "Setting up system roles and connections",
					order: ++deploymentStepOrder,
					run: async () => {
						if (!checkpoint.setupComplete?.systemRoles) {
							await setupSystem(hre, deployedContracts, config, checkpoint, protocolConfig)
							const pendingAdminActions = checkpoint.progress?.["pending.smOperatorRoles"]
							if (!Array.isArray(pendingAdminActions) || pendingAdminActions.length === 0) {
								checkpoint.setupComplete = checkpoint.setupComplete || {}
								checkpoint.setupComplete.systemRoles = true
								saveCheckpoint(checkpoint)
							} else {
								logger.warn(`System setup awaits ${pendingAdminActions.length} SymbolManager operator role grant(s) from the admin`)
							}
						} else {
							logger.info("  ⏭ System roles already configured")
						}
						logger.info()
					},
				})

				if (config.setupInstantLayerTemplates) {
					await runDeploymentStep(checkpoint, {
						id: "instantLayerTemplates",
						title: "Setting up InstantLayer templates",
						order: ++deploymentStepOrder,
						run: async () => {
							if (!checkpoint.setupComplete?.instantLayerTemplates) {
								await setupInstantLayerTemplates(hre, deployedContracts, checkpoint, protocolConfig)
								checkpoint.setupComplete = checkpoint.setupComplete || {}
								checkpoint.setupComplete.instantLayerTemplates = true
								saveCheckpoint(checkpoint)
							} else {
								logger.info("  ⏭ InstantLayer templates already configured")
							}
							logger.info()
						},
					})
				}

				if (config.registerDummyAffiliate) {
					await runDeploymentStep(checkpoint, {
						id: "dummyAffiliate",
						title: "Registering dummy affiliate",
						order: ++deploymentStepOrder,
						run: async () => {
							if (!checkpoint.setupComplete?.dummyAffiliate) {
								const accountManagerAddress = await registerDummyAffiliate(hre, deployedContracts, config, checkpoint)
								if (accountManagerAddress) {
									deployedContracts.accountManager = accountManagerAddress
									checkpoint.contracts.accountManager = createDeployedContract(accountManagerAddress)
									checkpoint.setupComplete = checkpoint.setupComplete || {}
									checkpoint.setupComplete.dummyAffiliate = true
									saveCheckpoint(checkpoint)
									deploymentResults.push({
										contract: "AccountManager (Dummy Affiliate)",
										address: accountManagerAddress,
										status: "success",
										timestamp: new Date().toISOString(),
									})
								}
							} else {
								logger.info("  ⏭ Dummy affiliate already registered")
								if (checkpoint.contracts.accountManager) {
									deployedContracts.accountManager = checkpoint.contracts.accountManager.address
									deploymentResults.push({
										contract: "AccountManager (Dummy Affiliate)",
										address: checkpoint.contracts.accountManager.address,
										status: "skipped",
										timestamp: new Date().toISOString(),
									})
								}
							}
							logger.info()
						},
					})
				}

				if (recipe?.expressProvider.mode === "deploy") {
					await runDeploymentStep(checkpoint, {
						id: "expressProvider",
						title: "Deploying ExpressProvider",
						order: ++deploymentStepOrder,
						run: async () => {
							try {
								const wasAlreadyDeployed = !!checkpoint.contracts.expressProvider?.diamondCutComplete
								const resolved = await resolveExpressProviderConfig(
									ethers,
									recipe.expressProvider,
									{ core: deployedContracts.diamond!, admin: config.admin },
									deployerAddress,
								)
								const result = await deployAndConfigureExpressProvider(hre, checkpoint, resolved, deployer, vanity)
								deployedContracts.expressProvider = result.address
								expressProviderResult = result
								// verify:all reads this file, so write it before the health gate can throw.
								if (logData) writeData(EXPRESSPROVIDER_DEPLOYMENT_FILE, result.records)
								logger.info(`ExpressProvider deployed at: ${result.address}`)
								const failed = result.checks.filter(check => check.status === "failed")
								if (failed.length > 0) {
									throw new Error(`ExpressProvider post-state health failed: ${failed.map(check => check.check).join(", ")}`)
								}
								deploymentResults.push({
									contract: "ExpressProvider",
									address: result.address,
									status: wasAlreadyDeployed ? "skipped" : "success",
									timestamp: new Date().toISOString(),
								})
							} catch (err: any) {
								logger.error(`Failed to deploy ExpressProvider: ${err.message}`)
								deploymentResults.push({
									contract: "ExpressProvider",
									address: "N/A",
									status: "failed",
									error: err.message,
									timestamp: new Date().toISOString(),
								})
								throw err
							}
							logger.info()
						},
					})
				}

				await runDeploymentStep(checkpoint, {
					id: "transferOwnership",
					title: "Transferring Diamond ownership to admin",
					order: ++deploymentStepOrder,
					run: async () => {
						// Both diamonds must be handed over. Only the core Diamond used to be
						// transferred, leaving the deploy wallet as permanent owner of the
						// AccountLayer — and owner is what authorises diamondCut, so a hot wallet
						// kept the ability to upgrade the AccountLayer arbitrarily. Revoking roles
						// (step 11) does not cover Ownable ownership.
						const owned: Array<{ label: string; address: string; control: any; view: any }> = [
							{
								label: "Diamond",
								address: deployedContracts.diamond!,
								control: await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", deployedContracts.diamond!),
								view: await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", deployedContracts.diamond!),
							},
						]
						if (deployedContracts.accountLayerDiamond) {
							owned.push({
								label: "AccountLayerDiamond",
								address: deployedContracts.accountLayerDiamond,
								control: await ethers.getContractAt(
									"contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet",
									deployedContracts.accountLayerDiamond,
								),
								view: await ethers.getContractAt("contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet", deployedContracts.accountLayerDiamond),
							})
						}

						for (const { label, address, control, view } of owned) {
							const owner = await view.getOwner()
							const pendingOwner = await view.pendingOwner()
							if (owner.toLowerCase() === config.admin.toLowerCase()) {
								logger.info(`  ✓ ${label} ownership already accepted by admin`)
								if (!isCompleted(checkpoint, `setup.transferOwnership.${label}`)) markCompleted(checkpoint, `setup.transferOwnership.${label}`)
								continue
							}
							if (owner.toLowerCase() !== deployerAddress.toLowerCase()) {
								throw new Error(`${label} owner is ${owner}; expected deployer ${deployerAddress} or admin ${config.admin}`)
							}
							if (pendingOwner !== ethers.ZeroAddress && pendingOwner.toLowerCase() !== config.admin.toLowerCase()) {
								throw new Error(`${label} has unexpected pending owner ${pendingOwner}; expected ${config.admin}`)
							}
							if (pendingOwner === ethers.ZeroAddress) {
								logger.info(`  Transferring ${label} ownership to admin...`)
								await send(control.connect(deployer).transferOwnership(config.admin), `transferOwnership(${label})`)
								const updatedPendingOwner = await view.pendingOwner()
								if (updatedPendingOwner.toLowerCase() !== config.admin.toLowerCase()) {
									throw new Error(`${label} pending owner is ${updatedPendingOwner} after transfer; expected ${config.admin}`)
								}
							} else {
								logger.info(`  ⏭ ${label} ownership transfer is already pending for ${config.admin}`)
							}
							if (!isCompleted(checkpoint, `setup.transferOwnership.${label}`)) markCompleted(checkpoint, `setup.transferOwnership.${label}`)
							logger.info(`      Admin must call acceptOwnership() on ${label}: ${address}`)
						}
						logger.info()
					},
				})

				await runDeploymentStep(checkpoint, {
					id: "revokeDeployerPrivileges",
					title: "Revoking deployer privileges",
					order: ++deploymentStepOrder,
					run: async () => {
						await revokeDeployerPrivileges(hre, deployedContracts, config, checkpoint, deployerAddress)
					},
				})

				const ownershipTargets = [
					{
						label: "Diamond",
						address: deployedContracts.diamond!,
						viewName: "contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet",
					},
					{
						label: "AccountLayerDiamond",
						address: deployedContracts.accountLayerDiamond!,
						viewName: "contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet",
					},
				]
				const ownershipStates: Array<{ label: string; address: string; owner: string; pendingOwner: string }> = []
				const pendingOwnership: Array<{ label: string; address: string; owner: string; pendingOwner: string }> = []
				for (const target of ownershipTargets) {
					const view = await ethers.getContractAt(target.viewName, target.address)
					const owner = await view.getOwner()
					const pendingOwner = await view.pendingOwner()
					ownershipStates.push({ label: target.label, address: target.address, owner, pendingOwner })
					if (owner.toLowerCase() === config.admin.toLowerCase()) continue
					if (owner.toLowerCase() !== deployerAddress.toLowerCase() || pendingOwner.toLowerCase() !== config.admin.toLowerCase()) {
						throw new Error(
							`${target.label} ownership is unsafe: owner=${owner}, pendingOwner=${pendingOwner}, expected owner=${config.admin} ` +
								`or owner=${deployerAddress} with pendingOwner=${config.admin}`,
						)
					}
					pendingOwnership.push({ ...target, owner, pendingOwner })
				}

				const pendingSymbolManagerRoles = Array.isArray(checkpoint.progress?.["pending.smOperatorRoles"])
					? (checkpoint.progress!["pending.smOperatorRoles"] as string[])
					: []
				const manualActions = pendingOwnership.map(target => `${config.admin} calls acceptOwnership() on ${target.label} ${target.address}`)
				const ownershipInterface = new ethers.Interface(["function acceptOwnership()"])
				const roleInterface = new ethers.Interface(["function grantRole(bytes32 role,address account)"])
				const safeActions: SafeManualAction[] = pendingOwnership.map(target => ({
					to: target.address,
					value: "0",
					data: ownershipInterface.encodeFunctionData("acceptOwnership"),
					description: `Accept ${target.label} ownership`,
				}))
				if (pendingSymbolManagerRoles.length > 0 && deployedContracts.symbolManager && config.symbolManagerOperator) {
					manualActions.push(
						`${config.admin} grants ${pendingSymbolManagerRoles.join(", ")} on SymbolManager ${deployedContracts.symbolManager} to ${config.symbolManagerOperator}`,
					)
					for (const role of pendingSymbolManagerRoles) {
						safeActions.push({
							to: deployedContracts.symbolManager,
							value: "0",
							data: roleInterface.encodeFunctionData("grantRole", [ethers.keccak256(ethers.toUtf8Bytes(role)), config.symbolManagerOperator]),
							description: `Grant ${role} on SymbolManager to ${config.symbolManagerOperator}`,
						})
					}
				}

				// The ExpressProvider carries its own handover: core registration when the deployer
				// lacks PROVIDER_ADMIN_ROLE, plus acceptOwnership on its diamond. Both must keep the
				// run in pending_handover, or a provider that cannot advance would report complete.
				for (const action of expressProviderResult?.manualActions || []) {
					manualActions.push(`${config.admin} executes: ${action.description} (to ${action.to}, data ${action.data})`)
					safeActions.push(action)
				}
				for (const check of expressProviderResult?.checks || []) {
					if (check.status === "pending") manualActions.push(`ExpressProvider check still pending: ${check.check}`)
				}

				const handoverPending = manualActions.length > 0
				checkpoint.step = handoverPending ? "pending_handover" : "complete"
				saveCheckpoint(checkpoint)

				// Generate and display report
				logger.info()
				logger.info("=".repeat(80))
				logger.info("DEPLOYMENT REPORT")
				logger.info("=".repeat(80))
				logger.info()

				const report = generateReport(deploymentResults, config, {
					checkpoint,
					deployerAddress,
					network,
					chainId: Number(chainId),
					verificationRequired,
					verificationPolicy,
					recipe: recipeRuntime
						? {
								name: recipeRuntime.recipe.name,
								path: recipeRuntime.identityPath,
								digest: recipeRuntime.digest,
								components: {
									core: recipeRuntime.recipe.core.mode,
									partyB: recipeRuntime.recipe.partyB.mode,
									symbolManager: recipeRuntime.recipe.symbolManager.mode,
									expressProvider: recipeRuntime.recipe.expressProvider.mode,
								},
							}
						: undefined,
				})
				report.ownershipHandover = {
					status: pendingOwnership.length > 0 ? "pending_handover" : "complete",
					targets: ownershipStates,
				}
				report.manualActions = manualActions
				report.safeActions = safeActions
				// Persist a validating report before either gate runs. Any interruption now leaves
				// an explicitly incomplete artifact rather than a durable false-green summary.
				saveReport(report, deployedContracts)

				// Run the health task in this same process against the report we just wrote. During
				// automated deployment, owner=deployer/pending=admin is the one allowed warning;
				// a later resume after both accepts uses strict ownership and archives the checkpoint.
				logger.info()
				logger.info("Running scoped deployment health check...")
				try {
					await hre.tasks.getTask("check:deployment").run({
						fromReport: true,
						allowPendingOwnership: pendingOwnership.length > 0,
						allowPendingAdminActions: pendingSymbolManagerRoles.length > 0,
					})
					report.checks.health = "passed"
					report.updatedAt = new Date().toISOString()
					saveReport(report, deployedContracts)
				} catch (err) {
					report.lifecycle = "failed"
					report.checks.health = "failed"
					report.checks.healthError = err instanceof Error ? err.message : String(err)
					report.updatedAt = new Date().toISOString()
					report.transactions = checkpoint.transactions || []
					saveReport(report, deployedContracts)
					throw err
				}

				// --verify used to be declared and destructured but never acted on, so an
				// operator passing it shipped an entirely unverified deployment while the
				// summary still looked green. Run the real verification task.
				if (verificationRequired && checkpoint.verificationStatus !== "passed") {
					logger.info()
					logger.info("Running required block-explorer verification...")
					try {
						await hre.tasks.getTask("verify:all").run({ skip: 0, retryFailed: false })
						checkpoint.verificationStatus = "passed"
						saveCheckpoint(checkpoint)
						report.checks.verification = "passed"
						report.updatedAt = new Date().toISOString()
						saveReport(report, deployedContracts)
					} catch (err) {
						checkpoint.verificationStatus = "failed"
						saveCheckpoint(checkpoint)
						report.lifecycle = "failed"
						report.checks.verification = "failed"
						report.checks.verificationError = err instanceof Error ? err.message : String(err)
						report.updatedAt = new Date().toISOString()
						report.transactions = checkpoint.transactions || []
						saveReport(report, deployedContracts)
						logger.error()
						logger.error("=".repeat(80))
						logger.error("DEPLOYMENT SUCCEEDED, BUT BLOCK-EXPLORER VERIFICATION FAILED")
						logger.error("=".repeat(80))
						logger.error(err instanceof Error ? err.message : String(err))
						logger.error(
							recipeRuntime
								? `Retry through ./symmio: choose Explorer verification retry for ${recipeRuntime.identityPath}`
								: `Retry with: ./node_modules/.bin/hardhat verify:all --retry-failed --network ${network}`,
						)
						logger.error("Then continue the active operator task; its checkpoint keeps verification mandatory until this gate passes.")
						throw err
					}
				} else if (verificationRequired) {
					report.checks.verification = "passed"
					logger.info("Block-explorer verification already passed for this checkpoint.")
				}

				report.lifecycle = handoverPending ? "pending_handover" : "complete"
				report.updatedAt = new Date().toISOString()
				report.transactions = checkpoint.transactions || []
				displayReport(report, deployedContracts, config)
				if (create2FactoryDeployed) logger.info(formatFactoryPinHint(deployedContracts.create2Factory!))
				saveReport(report, deployedContracts)

				if (handoverPending) {
					logger.info()
					logger.info("=".repeat(80))
					logger.info("AUTOMATED DEPLOYMENT COMPLETE — ADMIN ACTIONS REQUIRED")
					logger.info("=".repeat(80))
					for (const target of pendingOwnership) {
						logger.info(`${target.label}: ${target.address}`)
						logger.info(`  owner:        ${target.owner}`)
						logger.info(`  pendingOwner: ${target.pendingOwner}`)
						logger.info(`  action:       ${config.admin} calls acceptOwnership()`)
					}
					if (pendingSymbolManagerRoles.length > 0 && deployedContracts.symbolManager) {
						logger.info(`SymbolManager: ${deployedContracts.symbolManager}`)
						logger.info(`  operator: ${config.symbolManagerOperator}`)
						logger.info(`  roles:    ${pendingSymbolManagerRoles.join(", ")}`)
						logger.info("  action:   admin runs symbolManager:grantOperatorRoles, then reruns deploy:system")
					}
					logger.info(
						"Checkpoint retained at step pending_handover. Complete every action above, then rerun deploy:system; it will run strict health checks and archive it.",
					)
				} else {
					clearCheckpoint(Number(chainId), network)
					logger.info("Checkpoint archived - deployment and ownership handover complete!")
				}

				return {
					deployments: deployedContracts,
					report,
					handoverPending,
				}
			} catch (error) {
				deploymentError = error
				throw error
			} finally {
				clearDeploymentTransactionWriteAhead()
				if (bigBlocksEnabled) {
					try {
						logger.info("Cleaning up HyperEVM big-block mode after an interrupted deployment...")
						await setHyperEVMBigBlocks(hre, false)
						bigBlocksEnabled = false
					} catch (cleanupError) {
						logger.error(
							`Failed to disable HyperEVM big blocks during cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
						)
						logger.error("Run './node_modules/.bin/hardhat hyperevm:disable-big-blocks --network hyperevm' manually.")
						if (!deploymentError) throw cleanupError
					}
				}
			}
		},
	}))
	.build()

async function setupSystem(
	hre: any,
	deployedContracts: DeployedContracts,
	config: Awaited<ReturnType<typeof getEnvConfig>>,
	checkpoint: DeploymentCheckpoint,
	protocolConfig: ProtocolConfig,
) {
	const { ethers } = await getConnection(hre)
	const [deployer] = await ethers.getSigners()
	const deployerAddress = deployer.address

	// IControlFacet is the compatibility ABI spanning ControlFacet and the
	// size-isolated transient selectors in ExecutionContextFacet at the same diamond address.
	const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/IControlFacet.sol:IControlFacet", deployedContracts.diamond!)
	const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", deployedContracts.diamond!)
	const alControlFacet = await ethers.getContractAt(
		"contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet",
		deployedContracts.accountLayerDiamond!,
	)
	const instantLayer = await ethers.getContractAt("InstantLayer", deployedContracts.instantLayer!)
	const isMockVerifier = !!(config as any).deployMockVerifier
	const signatureVerifier = deployedContracts.signatureVerifier
		? await ethers.getContractAt(isMockVerifier ? "MockMuonSignatureVerifier" : "MuonSignatureVerifier", deployedContracts.signatureVerifier)
		: null
	const roleHash = (role: string) => ethers.keccak256(ethers.toUtf8Bytes(role))
	const instantLayerDefaultAdminRole = await instantLayer.DEFAULT_ADMIN_ROLE()
	const requireMuonSetterOnVerifier = (hasSetterRole: boolean) => {
		if (!hasSetterRole) {
			throw new Error("Cannot seed MuonSignatureVerifier: deployer does not have SETTER_ROLE on the verifier")
		}
	}

	// Diamond admin setup
	await checkpointedStep(checkpoint, "setup.setDeployerAdmin", "Granting DEFAULT_ADMIN_ROLE to deployer on Diamond", async () => {
		await send(controlFacet.connect(deployer).setAdmin(deployerAddress), "setAdmin")
	})

	await checkpointedStep(checkpoint, "setup.setAdmin", "Setting admin on Diamond", async () => {
		await send(controlFacet.connect(deployer).setAdmin(config.admin), "setAdmin")
	})

	// The deployer needs these roles to run the rest of setup. Accessibility.onlyRole is an
	// EXACT check — unlike onlyRoleAdmin, DEFAULT_ADMIN_ROLE does not imply any of them — and
	// the batch below grants roles to config.admin, not to the deployer. So whenever
	// ADMIN_PUBLIC_KEY differs from the deployer (i.e. any production deployment) setup used
	// to revert at registerHook and again at every parameter setter. Only MUON_SETTER_ROLE
	// had been patched around.
	//
	// Every role granted here is revoked again by revokeDeployerPrivileges (step 11).
	await checkpointedBatch(checkpoint, "setup.deployerSetupRoles", DEPLOYER_SETUP_ROLES, "Granting setup roles to deployer on Diamond", async role => {
		await send(controlFacet.connect(deployer).grantRole(deployerAddress, roleHash(role)), `grantRole(deployer ${role})`)
	})

	// Grant roles to admin on Diamond (batch)
	const diamondRoles = [
		"SYMBOL_MANAGER_ROLE",
		"PAUSER_ROLE",
		"UNPAUSER_ROLE",
		"PARTY_B_MANAGER_ROLE",
		"SUSPENDER_ROLE",
		"DISPUTE_ROLE",
		"AFFILIATE_MANAGER_ROLE",
		"MUON_SETTER_ROLE",
		"LIQUIDATOR_ROLE",
		"PARTYB_LIQUIDATOR_ROLE",
		"DEALLOCATE_COOLDOWN_SETTER_ROLE",
		"INSTANT_LAYER_ROLE",
		"PROTOCOL_CONFIG_ROLE",
		"FEE_ADMIN_ROLE",
		"COOLDOWN_ADMIN_ROLE",
		"PROVIDER_ADMIN_ROLE",
		"INTEGRATION_ADMIN_ROLE",
		"BRIDGE_MANAGER_ROLE",
		"SIGNER_ADMIN_ROLE",
		"EMERGENCY_ADMIN_ROLE",
		"UNSUSPENDER_ROLE",
		"MIGRATION_ROLE",
		"SUSPENDED_FUNDS_WITHDRAWER_ROLE",
		"FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE",
	]
	await checkpointedBatch(checkpoint, "setup.diamondRoles", diamondRoles, "Granting roles to admin on Diamond", async role => {
		await send(controlFacet.connect(deployer).grantRole(config.admin, roleHash(role)), "grantRole")
	})

	// AccountLayerDiamond roles on Diamond
	await checkpointedStep(checkpoint, "setup.alRolesOnDiamond", "Granting roles to AccountLayerDiamond on Diamond", async () => {
		await send(controlFacet.connect(deployer).grantRole(deployedContracts.accountLayerDiamond!, roleHash("SIGNER_ADMIN_ROLE")), "grantRole")
		await send(controlFacet.connect(deployer).grantRole(deployedContracts.accountLayerDiamond!, roleHash("AFFILIATE_MANAGER_ROLE")), "grantRole")
		await send(controlFacet.connect(deployer).grantRole(deployedContracts.accountLayerDiamond!, roleHash("BALANCE_SETTLER_ROLE")), "grantRole")
	})

	// Register AccountLayer as system hook on Diamond
	await checkpointedStep(checkpoint, "setup.registerHook", "Registering AccountLayer as system hook on Diamond", async () => {
		await send(controlFacet.connect(deployer).registerHook(ethers.ZeroAddress, deployedContracts.accountLayerDiamond!), "registerHook")
	})

	// InstantLayer role on Diamond
	await checkpointedStep(checkpoint, "setup.ilRoleOnDiamond", "Granting INSTANT_LAYER_ROLE to InstantLayer on Diamond", async () => {
		await send(controlFacet.connect(deployer).grantRole(deployedContracts.instantLayer!, roleHash("INSTANT_LAYER_ROLE")), "grantRole")
	})

	// AccountLayerDiamond admin roles
	await checkpointedStep(checkpoint, "setup.alDefaultAdmin", "Granting DEFAULT_ADMIN_ROLE on AccountLayerDiamond to admin", async () => {
		await send(alControlFacet.connect(deployer).grantRole(config.admin, roleHash("DEFAULT_ADMIN_ROLE")), "grantRole")
	})

	await checkpointedStep(checkpoint, "setup.alAdminRoles", "Setting up AccountLayerDiamond admin roles", async () => {
		await send(alControlFacet.connect(deployer).grantRole(config.admin, roleHash("SETTER_ROLE")), "grantRole")
		await send(alControlFacet.connect(deployer).grantRole(config.admin, roleHash("APPROVER_ROLE")), "grantRole")
		await send(alControlFacet.connect(deployer).grantRole(config.admin, roleHash("PAUSER_ROLE")), "grantRole")
		await send(alControlFacet.connect(deployer).grantRole(config.admin, roleHash("UNPAUSER_ROLE")), "grantRole")
	})

	// The deployer needs these to finish AccountLayer setup, for the same reason as on the
	// core Diamond: onlyRole is an exact check and the roles above went to config.admin.
	// Revoked again by revokeDeployerPrivileges (step 11).
	await checkpointedBatch(
		checkpoint,
		"setup.alDeployerSetupRoles",
		ACCOUNTLAYER_DEPLOYER_SETUP_ROLES,
		"Granting setup roles to deployer on AccountLayerDiamond",
		async role => {
			await send(alControlFacet.connect(deployer).grantRole(deployerAddress, roleHash(role)), `grantRole(deployer AL ${role})`)
		},
	)

	// The AccountLayer is initialised with the deployer as symmioFeeReceiver, because the
	// deployer must hold admin during setup. That left SYMMIO_FEE_RECEIVER silently ignored
	// and protocol fees accruing to the deploy wallet. Correct it here.
	if (config.symmioFeeReceiver && config.symmioFeeReceiver.toLowerCase() !== deployerAddress.toLowerCase()) {
		const alViewFacet = await ethers.getContractAt(
			"contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet",
			deployedContracts.accountLayerDiamond!,
		)
		const currentReceiver = (await alViewFacet.symmioFeeReceiver()).toLowerCase()

		if (currentReceiver !== config.symmioFeeReceiver.toLowerCase()) {
			await checkpointedStep(checkpoint, "setup.alFeeReceiver", `Setting AccountLayer symmioFeeReceiver to ${config.symmioFeeReceiver}`, async () => {
				await send(alControlFacet.connect(deployer).setSymmioFeeReceiver(config.symmioFeeReceiver), "setSymmioFeeReceiver")
			})

			const updated = (await alViewFacet.symmioFeeReceiver()).toLowerCase()
			if (updated !== config.symmioFeeReceiver.toLowerCase()) {
				throw new Error(`AccountLayer symmioFeeReceiver is ${updated}, expected ${config.symmioFeeReceiver.toLowerCase()}`)
			}
		}
	}

	// InstantLayer SIGNER_SETTER_ROLE on AccountLayerDiamond (allows InstantLayer to call setSigner)
	await checkpointedStep(checkpoint, "setup.ilRoleOnAL", "Granting SIGNER_SETTER_ROLE on AccountLayerDiamond", async () => {
		await send(alControlFacet.connect(deployer).grantRole(deployedContracts.instantLayer!, roleHash("SIGNER_SETTER_ROLE")), "grantRole")
	})

	// No transient-context configuration step: the legacy setCallFromInstantLayer /
	// setInstantOpenMode / setSigner selectors route into EIP-1153 state unconditionally,
	// so deployed and newly deployed callers already share one mechanism.

	// Whitelist Symmio Core
	await checkpointedStep(checkpoint, "setup.alWhitelistSymmio", "Whitelisting Symmio Core on AccountLayerDiamond", async () => {
		await send(alControlFacet.connect(deployer).setWhitelistedSymmioCore(deployedContracts.diamond!, true), "setWhitelistedSymmioCore")
	})

	// InstantLayer AccountLayer
	await checkpointedStep(checkpoint, "setup.ilSetAccountLayer", "Setting AccountLayer on InstantLayer", async () => {
		await send(instantLayer.connect(deployer).setAccountLayer(deployedContracts.accountLayerDiamond!), "setAccountLayer")
	})

	// MuonSignatureVerifier setup
	if (signatureVerifier) {
		if (isMockVerifier) {
			// MockMuonSignatureVerifier has no AccessControl roles - just set the address on Diamond
			logger.info("  Using MockMuonSignatureVerifier (no role grants needed)")

			await checkpointedStep(checkpoint, "setup.setSignatureVerifier", "Setting MockMuonSignatureVerifier on Diamond", async () => {
				await send(controlFacet.connect(deployer).setSignatureVerifierAddress(deployedContracts.signatureVerifier!), "setSignatureVerifierAddress")
			})
		} else {
			const muonPermissions = assertGeneralDeploymentMuonPermissions(config.muonFunctionPermissions, "MUON_FUNCTION_PERMISSIONS")
			const signatureVerifierDefaultAdminRole = await signatureVerifier.DEFAULT_ADMIN_ROLE()
			const signatureVerifierSetterRole = await signatureVerifier.SETTER_ROLE()
			const deployerIsVerifierAdmin = await signatureVerifier.hasRole(signatureVerifierDefaultAdminRole, deployerAddress)
			const deployerIsVerifierSetter = await signatureVerifier.hasRole(signatureVerifierSetterRole, deployerAddress)

			if (deployerIsVerifierAdmin) {
				await checkpointedStep(checkpoint, "setup.msvDefaultAdmin", "Granting DEFAULT_ADMIN_ROLE on MuonSignatureVerifier to admin", async () => {
					await send(signatureVerifier.connect(deployer).grantRole(signatureVerifierDefaultAdminRole, config.admin), "grantRole")
				})

				await checkpointedStep(checkpoint, "setup.msvSetterRole", "Granting SETTER_ROLE on MuonSignatureVerifier to admin", async () => {
					await send(signatureVerifier.connect(deployer).grantRole(signatureVerifierSetterRole, config.admin), "grantRole")
				})
			} else {
				logger.warn("Skipping verifier role grants: deployer is not DEFAULT_ADMIN_ROLE on MuonSignatureVerifier")
			}

			await checkpointedStep(checkpoint, "setup.setSignatureVerifier", "Setting MuonSignatureVerifier on Diamond", async () => {
				await send(controlFacet.connect(deployer).setSignatureVerifierAddress(deployedContracts.signatureVerifier!), "setSignatureVerifierAddress")
			})

			const shouldSeedPublicKey = !!config.muonPublicKeyX || !!config.muonPublicKeyParity
			if (shouldSeedPublicKey) {
				const parity = Number(config.muonPublicKeyParity)
				const existingKeys = await signatureVerifier.getAllPublicKeys()
				const exists = existingKeys.some(
					(key: { x: bigint; parity: bigint | number }) => key.x.toString() === config.muonPublicKeyX && Number(key.parity) === parity,
				)
				if (!exists) requireMuonSetterOnVerifier(deployerIsVerifierSetter)
				await checkpointedStep(checkpoint, "setup.msvPublicKey", "Adding Muon public key on MuonSignatureVerifier", async () => {
					if (exists) {
						logger.info("  ⏭ Muon public key already present on MuonSignatureVerifier")
						return
					}
					await send(
						signatureVerifier.connect(deployer).addPublicKey({
							x: config.muonPublicKeyX,
							parity,
						}),
						"addPublicKey",
					)
				})
			}

			if (config.muonGatewaySigners.length > 0) {
				await checkpointedBatch(
					checkpoint,
					"setup.msvGatewaySigners",
					config.muonGatewaySigners,
					"Adding gateway signers on MuonSignatureVerifier",
					async signer => {
						const existingSigners = (await signatureVerifier.getAllGatewaySigners()).map((s: string) => s.toLowerCase())
						if (existingSigners.includes(signer.toLowerCase())) return
						requireMuonSetterOnVerifier(deployerIsVerifierSetter)
						await send(signatureVerifier.connect(deployer).addGatewaySigner(signer), "addGatewaySigner")
					},
				)
			}

			// Permission writes are deliberately driven by fresh reads rather than a sticky
			// checkpoint bit. If a transaction was mined just before a crash, the next run sees
			// it and sends nothing; if permissions were later removed, a resume repairs them.
			const registeredKeys = (await signatureVerifier.getAllPublicKeys()).map((key: { x: bigint; parity: bigint | number }) => ({
				x: key.x.toString(),
				parity: Number(key.parity),
			}))
			const registeredGatewaySigners = (await signatureVerifier.getAllGatewaySigners()).map((signer: string) => ethers.getAddress(signer))
			const targetKeys = config.muonPublicKeyX ? [{ x: config.muonPublicKeyX, parity: Number(config.muonPublicKeyParity) }] : registeredKeys
			const targetGatewaySigners = config.muonGatewaySigners.length > 0 ? config.muonGatewaySigners : registeredGatewaySigners
			if (targetKeys.length === 0 || targetGatewaySigners.length === 0) {
				throw new Error("MuonSignatureVerifier must have at least one registered public key and gateway signer")
			}

			const inspection = await inspectConfiguredMuonPermissions(signatureVerifier, {
				publicKeys: targetKeys,
				gatewaySigners: targetGatewaySigners,
				permissionNames: config.muonFunctionPermissions,
			})
			for (const keyResult of inspection.publicKeys.filter(result => !result.fullyAuthorized)) {
				requireMuonSetterOnVerifier(deployerIsVerifierSetter)
				const missingIndices = keyResult.permissions.filter(permission => !permission.authorized).map(permission => permission.index)
				await send(
					signatureVerifier.connect(deployer).setPublicKeyPermissions(keyResult.publicKey, missingIndices, true),
					`setPublicKeyPermissions(${missingIndices.join(",")})`,
				)
			}
			for (const signerResult of inspection.gatewaySigners.filter(result => !result.fullyAuthorized)) {
				requireMuonSetterOnVerifier(deployerIsVerifierSetter)
				const missingIndices = signerResult.permissions.filter(permission => !permission.authorized).map(permission => permission.index)
				await send(
					signatureVerifier.connect(deployer).setGatewaySignerPermissions(signerResult.signer, missingIndices, true),
					`setGatewaySignerPermissions(${signerResult.signer},${missingIndices.join(",")})`,
				)
			}

			const verifiedPermissions = await inspectConfiguredMuonPermissions(signatureVerifier, {
				publicKeys: targetKeys,
				gatewaySigners: targetGatewaySigners,
				permissionNames: muonPermissions.map(({ name }) => name),
			})
			assertConfiguredMuonPermissionsAuthorized(verifiedPermissions)
			logger.info(
				`  ✓ Muon permissions verified for ${targetKeys.length} public key(s), ${targetGatewaySigners.length} gateway signer(s), and ${muonPermissions.length} function categories.`,
			)
		}
	}

	// Muon runtime configuration on Diamond.
	// MUON_SETTER_ROLE is granted up front with the rest of DEPLOYER_SETUP_ROLES, so the
	// one-off conditional grant that used to live here is no longer needed.
	const shouldConfigureMuonIds = !!config.muonAppId

	if (shouldConfigureMuonIds) {
		await checkpointedStep(checkpoint, "setup.setMuonIds", "Setting Muon app ID on Diamond", async () => {
			await send(controlFacet.connect(deployer).setMuonIds(config.muonAppId), "setMuonIds")
		})
	}

	await checkpointedStep(checkpoint, "setup.setMuonConfig", "Setting Muon validity config on Diamond", async () => {
		await send(controlFacet.connect(deployer).setMuonConfig(config.muonUpnlValidTime, config.muonPriceValidTime), "setMuonConfig")
	})

	// Per-function overrides are written after the global config so a partial run always leaves
	// the diamond on the global window rather than on a stale override.
	for (const { name, index, upnlValidTime } of config.muonFunctionUpnlValidTimes) {
		await checkpointedStep(
			checkpoint,
			`setup.setMuonFunctionUpnlValidTime.${name}`,
			`Setting Muon UPNL validity override for ${name} (${upnlValidTime}s)`,
			async () => {
				await send(controlFacet.connect(deployer).setMuonFunctionUpnlValidTime(index, upnlValidTime), `setMuonFunctionUpnlValidTime(${name})`)
			},
		)
	}

	// Overrides are core Diamond state, not verifier state, so they are read back whether or not
	// this run deployed a verifier.
	if (config.muonFunctionUpnlValidTimes.length > 0) {
		await checkpointedStep(checkpoint, "setup.verifyMuonFunctionUpnlValidTimes", "Verifying Muon UPNL validity overrides", async () => {
			for (const { name, index, upnlValidTime } of config.muonFunctionUpnlValidTimes) {
				const [actual, isOverridden] = await viewFacet.getMuonFunctionUpnlValidTime(index)
				if (!isOverridden || actual.toString() !== upnlValidTime) {
					throw new Error(
						`Muon UPNL validity override mismatch for ${name}: expected ${upnlValidTime} (overridden), got ${actual.toString()} (overridden=${isOverridden})`,
					)
				}
			}
		})
	}

	// Muon verification via view/read calls
	if (signatureVerifier && deployedContracts.signatureVerifier) {
		await checkpointedStep(checkpoint, "setup.verifyMuonViews", "Verifying Muon configuration via view calls", async () => {
			const configuredVerifier = (await viewFacet.getSignatureVerifier()).toLowerCase()
			const expectedVerifier = deployedContracts.signatureVerifier!.toLowerCase()
			if (configuredVerifier !== expectedVerifier) {
				throw new Error(`Muon verifier mismatch: expected ${expectedVerifier}, got ${configuredVerifier}`)
			}

			if (config.muonAppId) {
				const muonAppId = await viewFacet.getMuonIds()
				if (muonAppId.toString() !== config.muonAppId) {
					throw new Error(`Muon app ID mismatch: expected ${config.muonAppId}, got ${muonAppId.toString()}`)
				}
			}

			{
				const muonConfig = await viewFacet.getMuonConfig()
				const upnlValidTime = muonConfig[0]
				const priceValidTime = muonConfig[1]
				if (upnlValidTime.toString() !== config.muonUpnlValidTime || priceValidTime.toString() !== config.muonPriceValidTime) {
					throw new Error(
						`Muon validity mismatch: expected (${config.muonUpnlValidTime}, ${config.muonPriceValidTime}), got (${upnlValidTime.toString()}, ${priceValidTime.toString()})`,
					)
				}
			}

			if (config.muonPublicKeyX && config.muonPublicKeyParity) {
				const parity = Number(config.muonPublicKeyParity)
				const keys = await signatureVerifier.getAllPublicKeys()
				const found = keys.some(
					(key: { x: bigint; parity: bigint | number }) => key.x.toString() === config.muonPublicKeyX && Number(key.parity) === parity,
				)
				if (!found) {
					throw new Error("Expected Muon public key is not present on MuonSignatureVerifier")
				}
			}

			if (config.muonGatewaySigners.length > 0) {
				const existingSigners = (await signatureVerifier.getAllGatewaySigners()).map((s: string) => s.toLowerCase())
				for (const signer of config.muonGatewaySigners) {
					if (!existingSigners.includes(signer.toLowerCase())) {
						throw new Error(`Expected Muon gateway signer is missing: ${signer}`)
					}
				}
			}
		})
	}

	// Diamond system parameters
	logger.info("  Configuring Diamond system parameters...")
	const params = protocolConfig.parameters
	const parameterSetters: Array<{ key: string; name: string; action: () => Promise<ContractTransactionResponse> }> = [
		{ key: "setup.setCollateral", name: "setCollateral", action: () => controlFacet.connect(deployer).setCollateral(deployedContracts.collateral!) },
		{
			key: "setup.setBalanceLimitPerUser",
			name: "setBalanceLimitPerUser",
			action: () => controlFacet.connect(deployer).setBalanceLimitPerUser(BigInt(params.balanceLimitPerUser)),
		},
		{
			key: "setup.setMaxWithdrawParts",
			name: "setMaxWithdrawParts",
			action: () => controlFacet.connect(deployer).setMaxWithdrawParts(params.maxWithdrawParts),
		},
		{
			key: "setup.setDeallocateCooldown",
			name: "setDeallocateCooldown",
			action: () => controlFacet.connect(deployer).setDeallocateCooldown(params.deallocateCooldown),
		},
		{
			key: "setup.setSettlementCooldown",
			name: "setSettlementCooldown",
			action: () => controlFacet.connect(deployer).setSettlementCooldown(params.settlementCooldown),
		},
		{
			key: "setup.setDeallocateDebounceTime",
			name: "setDeallocateDebounceTime",
			action: () => controlFacet.connect(deployer).setDeallocateDebounceTime(params.deallocateDebounceTime),
		},
		{
			key: "setup.setLiquidatorShare",
			name: "setLiquidatorShare",
			action: () => controlFacet.connect(deployer).setLiquidatorShare(BigInt(params.liquidatorShare)),
		},
		{
			key: "setup.setLiquidationTimeout",
			name: "setLiquidationTimeout",
			action: () => controlFacet.connect(deployer).setLiquidationTimeout(params.liquidationTimeout),
		},
		{
			key: "setup.setForceCloseCooldowns",
			name: "setForceCloseCooldowns",
			action: () => controlFacet.connect(deployer).setForceCloseCooldowns(params.forceCloseCooldowns[0], params.forceCloseCooldowns[1]),
		},
		{
			key: "setup.setForceCancelCooldown",
			name: "setForceCancelCooldown",
			action: () => controlFacet.connect(deployer).setForceCancelCooldown(params.forceCancelCooldown),
		},
		{
			key: "setup.setForceCancelCloseCooldown",
			name: "setForceCancelCloseCooldown",
			action: () => controlFacet.connect(deployer).setForceCancelCloseCooldown(params.forceCancelCloseCooldown),
		},
		{
			key: "setup.setPendingQuotesValidLength",
			name: "setPendingQuotesValidLength",
			action: () => controlFacet.connect(deployer).setPendingQuotesValidLength(params.pendingQuotesValidLength),
		},
		{
			key: "setup.setMaxPartyAConnectionLimit",
			name: "setMaxPartyAConnectionLimit",
			action: () => controlFacet.connect(deployer).setMaxPartyAConnectionLimit(params.maxPartyAConnectionLimit),
		},
		{
			key: "setup.setInvalidBridgedAmountsPool",
			name: "setInvalidBridgedAmountsPool",
			action: () => controlFacet.connect(deployer).setInvalidBridgedAmountsPool(config.admin),
		},
		{
			key: "setup.setDefaultFeeCollector",
			name: "setDefaultFeeCollector",
			action: () => controlFacet.connect(deployer).setDefaultFeeCollector(config.symmioFeeReceiver),
		},
		{
			key: "setup.setLiquidationInsuranceVaultParams",
			name: "setLiquidationInsuranceVaultParams",
			action: () =>
				controlFacet
					.connect(deployer)
					.setLiquidationInsuranceVaultParams(config.liquidationInsuranceVault, BigInt(config.maxLiquidationProfitPerPosition)),
		},
		{
			key: "setup.setSoftLiquidationPenaltyCollector",
			name: "setSoftLiquidationPenaltyCollector",
			action: () => controlFacet.connect(deployer).setSoftLiquidationPenaltyCollector(config.softLiquidationPenaltyCollector),
		},
	]
	for (const { key, name, action } of parameterSetters) {
		// send() awaits the receipt, so the checkpoint only records the step once the
		// parameter is actually set on-chain — and it logs the hash and gas itself.
		await checkpointedStep(checkpoint, key, name, () => send(action(), name).then(() => undefined), { indent: "    ", skipLog: true })
	}

	// InstantLayer roles and whitelist
	await checkpointedStep(checkpoint, "setup.ilDefaultAdmin", "Granting DEFAULT_ADMIN_ROLE on InstantLayer to admin", async () => {
		await send(instantLayer.connect(deployer).grantRole(instantLayerDefaultAdminRole, config.admin), "grantRole")
	})

	await checkpointedStep(checkpoint, "setup.ilGrantSetterRole", "Granting SETTER_ROLE on InstantLayer to admin", async () => {
		await send(instantLayer.connect(deployer).grantRole(roleHash("SETTER_ROLE"), config.admin), "grantRole")
	})

	await checkpointedStep(checkpoint, "setup.ilGrantOperatorRole", "Granting OPERATOR_ROLE on InstantLayer to admin", async () => {
		await send(instantLayer.connect(deployer).grantRole(roleHash("OPERATOR_ROLE"), config.admin), "grantRole")
	})

	await checkpointedStep(checkpoint, "setup.ilGrantRevokerRole", "Granting REVOKER_ROLE on InstantLayer to admin", async () => {
		await send(instantLayer.connect(deployer).grantRole(roleHash("REVOKER_ROLE"), config.admin), "grantRole")
	})

	await checkpointedStep(checkpoint, "setup.ilWhitelistDiamond", "Whitelisting Symmio (Diamond) on InstantLayer", async () => {
		await send(instantLayer.connect(deployer).setTargetWhitelist(deployedContracts.diamond!, true), "setTargetWhitelist")
	})

	await checkpointedStep(checkpoint, "setup.ilWhitelistAL", "Whitelisting AccountLayerDiamond on InstantLayer", async () => {
		await send(instantLayer.connect(deployer).setTargetWhitelist(deployedContracts.accountLayerDiamond!, true), "setTargetWhitelist")
	})

	// PartyB setup (if deployed)
	if (deployedContracts.symmioPartyB) {
		const coreRegistrationKey = "setup.registerPartyB"
		const coreRegistration = await ensureBooleanState(
			"SymmioPartyB core registration",
			() => viewFacet.isPartyB(deployedContracts.symmioPartyB!),
			async () => {
				await controlFacet.connect(deployer).registerPartyB.staticCall(deployedContracts.symmioPartyB!)
				await send(controlFacet.connect(deployer).registerPartyB(deployedContracts.symmioPartyB!), "registerPartyB")
			},
		)
		if (!isCompleted(checkpoint, coreRegistrationKey)) {
			if (coreRegistration === "present") logger.warn("Recovered SymmioPartyB core registration from exact on-chain state.")
			markCompleted(checkpoint, coreRegistrationKey)
		}

		if (config.setAdlEnabled) {
			await checkpointedStep(checkpoint, "setup.setAdlEnabled", "Enabling ADL for SymmioPartyB on Diamond", async () => {
				await send(controlFacet.connect(deployer).setADLEnabled(deployedContracts.symmioPartyB!, true), "setADLEnabled")
			})
		}

		const symmioPartyB = await ethers.getContractAt("SymmioPartyB", deployedContracts.symmioPartyB)
		const partyBDefaultAdminRole = await symmioPartyB.DEFAULT_ADMIN_ROLE()

		await checkpointedStep(checkpoint, "setup.pbDefaultAdmin", "Granting DEFAULT_ADMIN_ROLE to admin on SymmioPartyB", async () => {
			await send(symmioPartyB.connect(deployer).grantRole(partyBDefaultAdminRole, config.admin), "grantRole")
		})

		await checkpointedStep(checkpoint, "setup.pbTrustedRole", "Granting TRUSTED_ROLE to InstantLayer on SymmioPartyB", async () => {
			await send(symmioPartyB.connect(deployer).grantRole(roleHash("TRUSTED_ROLE"), deployedContracts.instantLayer!), "grantRole")
		})

		await checkpointedStep(checkpoint, "setup.pbAdminTrustedRole", "Granting TRUSTED_ROLE to admin on SymmioPartyB", async () => {
			await send(symmioPartyB.connect(deployer).grantRole(roleHash("TRUSTED_ROLE"), config.admin), "grantRole")
		})

		await checkpointedStep(checkpoint, "setup.pbManagerRole", "Granting MANAGER_ROLE to admin on SymmioPartyB", async () => {
			await send(symmioPartyB.connect(deployer).grantRole(roleHash("MANAGER_ROLE"), config.admin), "grantRole")
		})

		await checkpointedStep(checkpoint, "setup.pbSetterRole", "Granting SETTER_ROLE to admin on SymmioPartyB", async () => {
			await send(symmioPartyB.connect(deployer).grantRole(roleHash("SETTER_ROLE"), config.admin), "grantRole")
		})

		await checkpointedStep(checkpoint, "setup.pbPauserRole", "Granting PAUSER_ROLE to admin on SymmioPartyB", async () => {
			await send(symmioPartyB.connect(deployer).grantRole(roleHash("PAUSER_ROLE"), config.admin), "grantRole")
		})

		await checkpointedStep(checkpoint, "setup.pbUnpauserRole", "Granting UNPAUSER_ROLE to admin on SymmioPartyB", async () => {
			await send(symmioPartyB.connect(deployer).grantRole(roleHash("UNPAUSER_ROLE"), config.admin), "grantRole")
		})

		await checkpointedStep(checkpoint, "setup.pbMulticastWhitelist", "Setting multicastWhitelist for InstantLayer on SymmioPartyB", async () => {
			await send(symmioPartyB.connect(deployer).setMulticastWhitelist(deployedContracts.instantLayer!, true), "setMulticastWhitelist")
		})

		if (config.partyBSigner) {
			// SymmioPartyB initializes the deployer with MANAGER/TRUSTED but not SETTER.
			// setSigner would otherwise revert whenever PARTYB_SIGNER is configured. This
			// temporary role is included in the final deployer-revocation inventory.
			await checkpointedStep(checkpoint, "setup.pbDeployerSetterRole", "Granting temporary SETTER_ROLE to deployer on SymmioPartyB", async () => {
				await send(symmioPartyB.connect(deployer).grantRole(roleHash("SETTER_ROLE"), deployerAddress), "grantRole")
			})
			await checkpointedStep(checkpoint, "setup.pbSetSigner", "Setting signer on SymmioPartyB", async () => {
				await send(symmioPartyB.connect(deployer).setSigner(config.partyBSigner), "setSigner")
			})
		}

		const instantLayerRegistrationKey = "setup.ilRegisterPartyB"
		const instantLayerRegistration = await ensureBooleanState(
			"SymmioPartyB InstantLayer registration",
			() => instantLayer.registeredPartyBs(deployedContracts.symmioPartyB!),
			async () => {
				await instantLayer.connect(deployer).registerPartyBs.staticCall([deployedContracts.symmioPartyB!])
				await send(instantLayer.connect(deployer).registerPartyBs([deployedContracts.symmioPartyB!]), "registerPartyBs")
			},
		)
		if (!isCompleted(checkpoint, instantLayerRegistrationKey)) {
			if (instantLayerRegistration === "present") logger.warn("Recovered SymmioPartyB InstantLayer registration from exact on-chain state.")
			markCompleted(checkpoint, instantLayerRegistrationKey)
		}
	}

	// SymbolManager setup (if deployed)
	if (deployedContracts.symbolManager) {
		await checkpointedStep(checkpoint, "setup.smGrantSymbolManagerRole", "Granting SYMBOL_MANAGER_ROLE to SymbolManager on Diamond", async () => {
			await send(controlFacet.connect(deployer).grantRole(deployedContracts.symbolManager!, roleHash("SYMBOL_MANAGER_ROLE")), "grantRole")
		})

		await checkpointedStep(
			checkpoint,
			"setup.smGrantForceCloseGapRatioRole",
			"Granting FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE to SymbolManager on Diamond",
			async () => {
				await send(
					controlFacet.connect(deployer).grantRole(deployedContracts.symbolManager!, roleHash("FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE")),
					"grantRole",
				)
			},
		)

		if (config.symbolManagerOperator) {
			// Delegate to the shared helper rather than duplicating the grants inline. It
			// checks first whether the deployer actually holds DEFAULT_ADMIN_ROLE on the
			// SymbolManager — the constructor grants it to `admin` only, so on any deploy
			// where ADMIN_PUBLIC_KEY differs from the deployer these grants revert. The
			// helper prints the exact command for the admin to run instead of failing the
			// whole deployment at its last step.
			if (isCompleted(checkpoint, "setup.smOperatorRoles")) {
				logger.info("  ⏭ SymbolManager operator roles already verified")
			} else {
				logger.info("  Granting or checking operator roles on SymbolManager...")
				const result = await grantSymbolManagerOperatorRoles(hre, {
					symbolManagerAddress: deployedContracts.symbolManager!,
					operator: config.symbolManagerOperator,
				})
				checkpoint.progress = checkpoint.progress || {}
				if (result.deferred > 0) {
					checkpoint.progress["pending.smOperatorRoles"] = result.missingRoles
					saveCheckpoint(checkpoint)
				} else {
					delete checkpoint.progress["pending.smOperatorRoles"]
					markCompleted(checkpoint, "setup.smOperatorRoles")
				}
			}
		}
	}

	logger.info("  System setup complete!")
}

async function registerDummyAffiliate(
	hre: any,
	deployedContracts: DeployedContracts,
	config: Awaited<ReturnType<typeof getEnvConfig>>,
	checkpoint: DeploymentCheckpoint,
): Promise<string | null> {
	const { ethers } = await getConnection(hre)
	const [deployer] = await ethers.getSigners()

	const alAffiliateFacet = await ethers.getContractAt(
		"contracts/accountLayer/facets/Affiliate/AffiliateFacet.sol:AffiliateFacet",
		deployedContracts.accountLayerDiamond!,
	)
	const alViewFacet = await ethers.getContractAt("contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet", deployedContracts.accountLayerDiamond!)

	const affiliateData = {
		name: "Test Affiliate",
		brandColor: "d69d00",
		admin: config.admin,
		stakeholders: [{ receiver: config.admin, share: ethers.parseEther("0.9") }],
		symmioShare: ethers.parseEther("0.1"),
		metadata: "0x",
		legacyMultiAccounts: [],
		symmioCores: [deployedContracts.diamond!],
	}

	const assertExpectedAffiliate = async (accountManagerAddress: string): Promise<void> => {
		const [actualAdmin, actualCores, actualStakeholders, actualSymmioShare] = await Promise.all([
			alViewFacet.getAffiliateAdmin(accountManagerAddress),
			alViewFacet.getAffiliateSymmioCores(accountManagerAddress),
			alViewFacet.getAffiliateStakeholders(accountManagerAddress),
			alViewFacet.getAffiliateSymmioShare(accountManagerAddress),
		])
		const mismatches: string[] = []
		if (ethers.getAddress(actualAdmin) !== ethers.getAddress(affiliateData.admin)) {
			mismatches.push(`admin is ${actualAdmin}, expected ${affiliateData.admin}`)
		}
		if (
			actualCores.length !== affiliateData.symmioCores.length ||
			actualCores.some((core: string, index: number) => ethers.getAddress(core) !== ethers.getAddress(affiliateData.symmioCores[index]))
		) {
			mismatches.push(`Symmio cores are [${actualCores.join(", ")}], expected [${affiliateData.symmioCores.join(", ")}]`)
		}
		if (
			actualStakeholders.length !== affiliateData.stakeholders.length ||
			actualStakeholders.some(
				(stakeholder: any, index: number) =>
					ethers.getAddress(stakeholder.receiver) !== ethers.getAddress(affiliateData.stakeholders[index].receiver) ||
					BigInt(stakeholder.share) !== affiliateData.stakeholders[index].share,
			)
		) {
			mismatches.push("stakeholder receivers or shares differ from the reviewed dummy-affiliate configuration")
		}
		if (BigInt(actualSymmioShare) !== affiliateData.symmioShare) {
			mismatches.push(`Symmio share is ${actualSymmioShare}, expected ${affiliateData.symmioShare}`)
		}
		if (mismatches.length > 0) {
			throw new Error(`Refusing to resume an unexpected dummy affiliate at ${accountManagerAddress}:\n- ${mismatches.join("\n- ")}`)
		}
	}

	// Persist the deterministic address before the first broadcast. AccountManager
	// bytecode is deployed only during approval, so it deliberately lives outside
	// checkpoint.contracts until the affiliate reaches ACTIVE.
	let accountManagerAddress = checkpoint.pending?.dummyAffiliateAddress ?? checkpoint.contracts.accountManager?.address
	if (!accountManagerAddress) {
		accountManagerAddress = ethers.getAddress(await alAffiliateFacet.connect(deployer).requestToRegisterAffiliate.staticCall(affiliateData))
		checkpoint.pending = checkpoint.pending || {}
		checkpoint.pending.dummyAffiliateAddress = accountManagerAddress
		saveCheckpoint(checkpoint)
	} else {
		accountManagerAddress = ethers.getAddress(accountManagerAddress)
		checkpoint.pending = checkpoint.pending || {}
		checkpoint.pending.dummyAffiliateAddress = accountManagerAddress
		// Older checkpoints stored the PENDING address as if it already contained
		// deployed code. Move it into the write-ahead field before continuing.
		if (!checkpoint.setupComplete?.dummyAffiliate) delete checkpoint.contracts.accountManager
		saveCheckpoint(checkpoint)
	}
	if (!accountManagerAddress) throw new Error("Failed to resolve the deterministic dummy-affiliate address")
	const resolvedAccountManagerAddress = accountManagerAddress

	let affiliateState = BigInt(await alViewFacet.getAffiliateState(resolvedAccountManagerAddress))
	let action = resolveAffiliateRegistrationResumeAction(
		affiliateState,
		isCompleted(checkpoint, "affiliate.register"),
		isCompleted(checkpoint, "affiliate.approve"),
	)

	if (action === "request") {
		const currentPrediction = ethers.getAddress(await alAffiliateFacet.connect(deployer).requestToRegisterAffiliate.staticCall(affiliateData))
		if (currentPrediction !== resolvedAccountManagerAddress) {
			throw new Error(
				`Dummy-affiliate address drifted before registration: checkpoint has ${resolvedAccountManagerAddress}, current prediction is ${currentPrediction}`,
			)
		}
		logger.info("  Registering dummy affiliate...")
		await send(alAffiliateFacet.connect(deployer).requestToRegisterAffiliate(affiliateData), "requestToRegisterAffiliate")
		affiliateState = BigInt(await alViewFacet.getAffiliateState(resolvedAccountManagerAddress))
		if (affiliateState !== 1n) throw new Error(`Dummy-affiliate registration confirmed, but state is ${affiliateState}; expected PENDING`)
		await assertExpectedAffiliate(resolvedAccountManagerAddress)
		markCompleted(checkpoint, "affiliate.register")
		action = "approve"
	} else {
		await assertExpectedAffiliate(resolvedAccountManagerAddress)
		if (!isCompleted(checkpoint, "affiliate.register")) {
			logger.warn("Recovered dummy-affiliate registration from exact on-chain state after an interrupted submission.")
			markCompleted(checkpoint, "affiliate.register")
		}
	}

	if (action === "approve") {
		logger.info("  Approving dummy affiliate...")
		await alAffiliateFacet.connect(deployer).approveAffiliate.staticCall(resolvedAccountManagerAddress)
		await send(alAffiliateFacet.connect(deployer).approveAffiliate(resolvedAccountManagerAddress), "approveAffiliate")
		affiliateState = BigInt(await alViewFacet.getAffiliateState(resolvedAccountManagerAddress))
		if (affiliateState !== 2n) throw new Error(`Dummy-affiliate approval confirmed, but state is ${affiliateState}; expected ACTIVE`)
		await assertExpectedAffiliate(resolvedAccountManagerAddress)
		markCompleted(checkpoint, "affiliate.approve")
	} else if (!isCompleted(checkpoint, "affiliate.approve")) {
		logger.warn("Recovered dummy-affiliate approval from exact on-chain state after an interrupted submission.")
		markCompleted(checkpoint, "affiliate.approve")
	}

	const accountManagerCode = await ethers.provider.getCode(resolvedAccountManagerAddress)
	if (!accountManagerCode || accountManagerCode === "0x") {
		throw new Error(`Dummy affiliate is ACTIVE, but AccountManager ${resolvedAccountManagerAddress} has no runtime bytecode`)
	}
	checkpoint.contracts.accountManager = createDeployedContract(resolvedAccountManagerAddress)
	delete checkpoint.pending?.dummyAffiliateAddress
	if (checkpoint.pending && Object.keys(checkpoint.pending).length === 0) delete checkpoint.pending
	saveCheckpoint(checkpoint)

	logger.info(`  Dummy affiliate registered! AccountManager: ${resolvedAccountManagerAddress}`)

	return resolvedAccountManagerAddress
}

/**
 * Sets up InstantLayer templates for standard and custom-VA open/close flows.
 */
async function setupInstantLayerTemplates(
	hre: any,
	deployedContracts: DeployedContracts,
	checkpoint: DeploymentCheckpoint,
	protocolConfig: ProtocolConfig,
): Promise<void> {
	const { ethers } = await getConnection(hre)
	const [deployer] = await ethers.getSigners()
	const instantLayer = await ethers.getContractAt("InstantLayer", deployedContracts.instantLayer!)

	const templates = protocolConfig.instantLayerTemplates
	logger.info(`  Setting up ${templates.length} InstantLayer template(s)...`)

	// Template ids are assigned in creation order and hedgers address templates BY ID, so
	// the array order in the config is part of the contract with off-chain services.
	for (const [templateId, template] of templates.entries()) {
		const progressKey = `templates.add.${templateId}`
		const nextTemplateId = BigInt(await instantLayer.nextTemplateId())
		const existing = nextTemplateId > BigInt(templateId) ? await instantLayer.getTemplate(templateId) : undefined
		const resumeAction = resolveTemplateAddResumeAction(templateId, nextTemplateId, existing, template, isCompleted(checkpoint, progressKey))

		if (resumeAction === "present") {
			if (!isCompleted(checkpoint, progressKey)) {
				logger.warn(`Recovered template ${templateId}: ${template.name} from exact on-chain state after an interrupted submission.`)
				markCompleted(checkpoint, progressKey)
			}
		} else {
			await checkpointedStep(checkpoint, progressKey, `Adding template ${templateId}: ${template.name}`, async () => {
				await instantLayer.connect(deployer).addTemplate.staticCall(template.name, template.operations)
				await send(instantLayer.connect(deployer).addTemplate(template.name, template.operations), `addTemplate(${template.name})`)
				const countAfter = BigInt(await instantLayer.nextTemplateId())
				if (countAfter !== BigInt(templateId + 1)) {
					throw new Error(`addTemplate(${template.name}) confirmed but nextTemplateId is ${countAfter}, expected ${templateId + 1}`)
				}
				const added = await instantLayer.getTemplate(templateId)
				const mismatches = templateConfigMismatches(templateId, added, template)
				if (mismatches.length > 0) throw new Error(`Added InstantLayer template failed post-check:\n- ${mismatches.join("\n- ")}`)
			})
		}

		const expectedInstantOpenMode = Boolean(template.instantOpenMode)
		if ((await instantLayer.templateInstantOpenMode(templateId)) !== expectedInstantOpenMode) {
			await checkpointedStep(
				checkpoint,
				`templates.instantOpenMode.${templateId}`,
				`Setting instantOpenMode=${expectedInstantOpenMode} on template ${templateId}`,
				async () => {
					await send(instantLayer.connect(deployer).setTemplateInstantOpenMode(templateId, expectedInstantOpenMode), "setTemplateInstantOpenMode")
				},
			)
		}
	}

	// Assert the on-chain result matches the config — a template at the wrong id silently
	// breaks every hedger that references it.
	const onChain = await instantLayer.getTemplates(0, templates.length + 10)
	if (onChain.length !== templates.length) {
		throw new Error(`InstantLayer has ${onChain.length} templates, expected ${templates.length}`)
	}
	for (const [templateId, template] of templates.entries()) {
		const instantOpenMode = await instantLayer.templateInstantOpenMode(templateId)
		const mismatches = templateConfigMismatches(templateId, onChain[templateId], template, instantOpenMode)
		if (mismatches.length > 0) throw new Error(`InstantLayer template verification failed:\n- ${mismatches.join("\n- ")}`)
	}

	logger.info(`  InstantLayer templates setup complete — ${templates.length} verified on-chain.`)
}

/** Minimal OpenZeppelin AccessControl surface, used for the peripheral contracts. */
const ACCESS_CONTROL_ABI = [
	"function hasRole(bytes32 role, address account) view returns (bool)",
	"function renounceRole(bytes32 role, address callerConfirmation)",
]

/**
 * Hand every administrative privilege to config.admin and strip the deployer's.
 *
 * ControlFacet.setAdmin is purely additive — it sets hasRole[user][DEFAULT_ADMIN_ROLE]
 * and revokes nothing — and LibAccessibility.isRoleAdmin treats ANY DEFAULT_ADMIN_ROLE
 * holder as admin of every role. Without this step the deploy hot wallet keeps full
 * control of the protocol indefinitely: it could grant itself LIQUIDATOR_ROLE, change the
 * collateral, or add its own Muon public key and forge attestations. The same applies to
 * the OpenZeppelin peripherals, where the deployer is the initial admin.
 *
 * Safety rule enforced throughout: never revoke a deployer role without first confirming
 * on-chain that config.admin holds the equivalent role. Getting that backwards would
 * leave the contract with no administrator at all.
 */
async function revokeDeployerPrivileges(
	hre: any,
	deployedContracts: DeployedContracts,
	config: Awaited<ReturnType<typeof getEnvConfig>>,
	checkpoint: DeploymentCheckpoint,
	deployerAddress: string,
): Promise<void> {
	const { ethers } = await getConnection(hre)
	const [deployer] = await ethers.getSigners()
	const roleHash = (role: string) => ethers.keccak256(ethers.toUtf8Bytes(role))

	if (config.admin.toLowerCase() === deployerAddress.toLowerCase()) {
		logger.info("  ⏭ ADMIN_PUBLIC_KEY is the deployer — no handover to perform.")
		logger.warn("The deploy wallet remains protocol admin. For production, set ADMIN_PUBLIC_KEY to the multisig and rerun the handover.")
		return
	}

	logger.info(`  Handing administrative control to ${config.admin} and revoking the deployer's.`)

	// ---- Core Diamond (custom role storage) --------------------------------------
	const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", deployedContracts.diamond!)
	const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", deployedContracts.diamond!)

	if (!(await viewFacet.hasRole(config.admin, roleHash("DEFAULT_ADMIN_ROLE")))) {
		throw new Error(
			`Refusing to revoke the deployer's DEFAULT_ADMIN_ROLE: ${config.admin} does not hold it on the Diamond. ` +
				`Revoking now would leave the protocol with no administrator.`,
		)
	}

	// Narrower roles first — DEFAULT_ADMIN_ROLE is what authorises these revocations,
	// so it has to be the last thing the deployer gives up.
	for (const role of [...DEPLOYER_SETUP_ROLES, "DEFAULT_ADMIN_ROLE"]) {
		const hash = roleHash(role)
		if (!(await viewFacet.hasRole(deployerAddress, hash))) {
			logger.info(`    ⏭ Deployer does not hold ${role} on the Diamond`)
			continue
		}
		await checkpointedStep(checkpoint, `revoke.core.${role}`, `Revoking ${role} from deployer on Diamond`, async () => {
			await send(controlFacet.connect(deployer).revokeRole(deployerAddress, hash), `revokeRole(${role})`)
		})
		if (await viewFacet.hasRole(deployerAddress, hash)) {
			throw new Error(`${role} is still held by the deployer on the Diamond after revocation`)
		}
	}

	// ---- AccountLayer Diamond (same custom role storage) --------------------------
	if (deployedContracts.accountLayerDiamond) {
		const alControl = await ethers.getContractAt(
			"contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet",
			deployedContracts.accountLayerDiamond,
		)
		const alView = await ethers.getContractAt("contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet", deployedContracts.accountLayerDiamond)
		if (!(await alView.hasRole(config.admin, roleHash("DEFAULT_ADMIN_ROLE")))) {
			throw new Error(`Refusing to revoke deployer admin on the AccountLayer: ${config.admin} does not hold DEFAULT_ADMIN_ROLE there.`)
		}

		// Setup roles first, DEFAULT_ADMIN_ROLE last — it authorises the revocations.
		for (const role of [...ACCOUNTLAYER_DEPLOYER_SETUP_ROLES, "DEFAULT_ADMIN_ROLE"]) {
			const hash = roleHash(role)
			if (!(await alView.hasRole(deployerAddress, hash))) {
				logger.info(`    ⏭ Deployer does not hold ${role} on the AccountLayer`)
				continue
			}
			await checkpointedStep(checkpoint, `revoke.accountLayer.${role}`, `Revoking ${role} from deployer on AccountLayer`, async () => {
				await send(alControl.connect(deployer).revokeRole(deployerAddress, hash), `revokeRole(AccountLayer ${role})`)
			})
			if (await alView.hasRole(deployerAddress, hash)) {
				throw new Error(`${role} is still held by the deployer on the AccountLayer after revocation`)
			}
		}
	}

	// ---- OpenZeppelin AccessControl peripherals -----------------------------------
	// The mock verifier has no roles at all, so it is skipped.
	const ozTargets: Array<{ label: string; address?: string; roles: string[] }> = [
		{
			label: "MuonSignatureVerifier",
			address: config.deployMockVerifier ? undefined : deployedContracts.signatureVerifier,
			roles: ["DEFAULT_ADMIN_ROLE", "SETTER_ROLE"],
		},
		{
			label: "InstantLayer",
			address: deployedContracts.instantLayer,
			roles: ["DEFAULT_ADMIN_ROLE", "SETTER_ROLE", "OPERATOR_ROLE"],
		},
		{
			label: "SymmioPartyB",
			address: deployedContracts.symmioPartyB,
			roles: ["DEFAULT_ADMIN_ROLE", "TRUSTED_ROLE", "MANAGER_ROLE", "SETTER_ROLE"],
		},
	]

	for (const target of ozTargets) {
		if (!target.address) continue
		const contract = new ethers.Contract(target.address, ACCESS_CONTROL_ABI, deployer)

		for (const role of target.roles) {
			// OZ's DEFAULT_ADMIN_ROLE is bytes32(0); the named roles are keccak hashes.
			const hash = role === "DEFAULT_ADMIN_ROLE" ? ethers.ZeroHash : roleHash(role)

			let deployerHas: boolean
			let adminHas: boolean
			try {
				deployerHas = await contract.hasRole(hash, deployerAddress)
				adminHas = await contract.hasRole(hash, config.admin)
			} catch {
				// Contract does not implement this role — nothing to do.
				continue
			}

			if (!deployerHas) continue
			if (!adminHas) {
				throw new Error(
					`Refusing to renounce ${role} on ${target.label}: ${config.admin} does not hold it, which would leave the contract unmanaged.`,
				)
			}

			await checkpointedStep(checkpoint, `revoke.${target.label}.${role}`, `Renouncing ${role} on ${target.label}`, async () => {
				await send(contract.renounceRole(hash, deployerAddress), `renounceRole(${target.label}.${role})`)
			})
			if (await contract.hasRole(hash, deployerAddress)) {
				throw new Error(`${role} is still held by the deployer on ${target.label} after renouncing`)
			}
		}
	}

	logger.info(`  ✓ Deployer privileges revoked; ${config.admin} is now the sole administrator.`)
}

function generateReport(
	deployments: DeploymentResult[],
	config: Awaited<ReturnType<typeof getEnvConfig>>,
	context: {
		checkpoint: DeploymentCheckpoint
		deployerAddress: string
		network: string
		chainId: number
		verificationRequired: boolean
		verificationPolicy: SystemDeploymentReport["checks"]["verificationPolicy"]
		recipe?: NonNullable<SystemDeploymentReport["recipe"]>
	},
): SystemDeploymentReport {
	const successfulDeploymentGroups = deployments.filter(d => d.status === "success").length
	const failedDeploymentGroups = deployments.filter(d => d.status === "failed").length
	const skippedOrReusedDeploymentGroups = deployments.filter(d => d.status === "skipped").length
	if (!context.checkpoint.deploymentId || !context.checkpoint.manifest) {
		throw new Error("Cannot generate deployment report without a deployment id and validated manifest")
	}
	const now = new Date().toISOString()

	return {
		deploymentId: context.checkpoint.deploymentId,
		deployerAddress: context.deployerAddress,
		network: context.network,
		chainId: context.chainId,
		manifestFingerprint: context.checkpoint.manifest.fingerprint,
		recipe: context.recipe,
		lifecycle: "validating",
		checks: {
			health: "pending",
			verification: context.verificationRequired ? (context.checkpoint.verificationStatus === "passed" ? "passed" : "pending") : "skipped",
			verificationPolicy: context.verificationPolicy,
		},
		transactions: context.checkpoint.transactions || [],
		deployments,
		config: {
			admin: config.admin,
			symmioFeeReceiver: config.symmioFeeReceiver,
			liquidationInsuranceVault: config.liquidationInsuranceVault,
			maxLiquidationProfitPerPosition: config.maxLiquidationProfitPerPosition,
			softLiquidationPenaltyCollector: config.softLiquidationPenaltyCollector,
			collateralAddress: config.collateralAddress,
			deployPartyB: config.deployPartyB,
			setAdlEnabled: config.setAdlEnabled,
			deploySymbolManager: config.deploySymbolManager,
			symbolManagerOperator: config.symbolManagerOperator,
			registerDummyAffiliate: config.registerDummyAffiliate,
			setupInstantLayerTemplates: config.setupInstantLayerTemplates,
			signatureVerifierAddress: config.signatureVerifierAddress,
			deployMockVerifier: config.deployMockVerifier,
			muonAppId: config.muonAppId,
			muonUpnlValidTime: config.muonUpnlValidTime,
			muonPriceValidTime: config.muonPriceValidTime,
			muonFunctionUpnlValidTimes: config.muonFunctionUpnlValidTimes,
			muonPublicKeyX: config.muonPublicKeyX,
			muonPublicKeyParity: config.muonPublicKeyParity,
			muonGatewaySigners: config.muonGatewaySigners,
			muonFunctionPermissions: config.muonFunctionPermissions,
			partyBMode: config.partyBMode,
			symbolManagerMode: config.symbolManagerMode,
			expressProviderMode: config.expressProviderMode,
		},
		summary: {
			totalDeploymentGroups: deployments.length,
			successfulDeploymentGroups,
			failedDeploymentGroups,
			skippedOrReusedDeploymentGroups,
		},
		timestamp: now,
		updatedAt: now,
	}
}

function displayReport(report: SystemDeploymentReport, deployedContracts: DeployedContracts, config?: { deployMockVerifier?: boolean }): void {
	logger.info("DEPLOYMENT SUMMARY")
	logger.info("-".repeat(80))
	logger.info(`Deployment ID: ${report.deploymentId}`)
	logger.info(`Lifecycle: ${report.lifecycle}`)
	logger.info(`Health Check: ${report.checks.health}`)
	logger.info(`Explorer Verification: ${report.checks.verification} (${report.checks.verificationPolicy})`)
	logger.info(`Confirmed/Recorded Transactions: ${report.transactions.length}`)
	logger.info(`Deployment Groups: ${report.summary.totalDeploymentGroups}`)
	logger.info(`Successful Groups: ${report.summary.successfulDeploymentGroups}`)
	logger.info(`Skipped/Reused Groups: ${report.summary.skippedOrReusedDeploymentGroups}`)
	logger.info(`Failed Groups: ${report.summary.failedDeploymentGroups}`)
	logger.info()

	logger.info("DEPLOYED ADDRESSES")
	logger.info("-".repeat(80))
	if (deployedContracts.create2Factory) logger.info(`Create2Factory:       ${deployedContracts.create2Factory}`)
	if (deployedContracts.collateral) logger.info(`Collateral:           ${deployedContracts.collateral}`)
	if (deployedContracts.diamond) logger.info(`Diamond:              ${deployedContracts.diamond}`)
	if (deployedContracts.signatureVerifier)
		logger.info(`${config?.deployMockVerifier ? "MockMuonSigVerifier" : "MuonSignatureVerifier"}: ${deployedContracts.signatureVerifier}`)
	if (deployedContracts.accountLayerDiamond) logger.info(`AccountLayerDiamond:  ${deployedContracts.accountLayerDiamond}`)
	if (deployedContracts.instantLayer) logger.info(`InstantLayer:         ${deployedContracts.instantLayer}`)
	if (deployedContracts.symmioPartyB) logger.info(`SymmioPartyB:         ${deployedContracts.symmioPartyB}`)
	if (deployedContracts.symbolManager) logger.info(`SymbolManager:        ${deployedContracts.symbolManager}`)
	if (deployedContracts.accountManager) logger.info(`AccountManager:       ${deployedContracts.accountManager}`)
	logger.info()

	logger.info("CONFIGURATION")
	logger.info("-".repeat(80))
	logger.info(`Admin:                       ${report.config.admin}`)
	logger.info(`Symmio Fee Receiver:         ${report.config.symmioFeeReceiver}`)
	logger.info(`Liquidation Insurance Vault: ${report.config.liquidationInsuranceVault}`)
	logger.info(`Max Liquidation Profit:      ${report.config.maxLiquidationProfitPerPosition}`)
	logger.info(`Soft Penalty Collector:      ${report.config.softLiquidationPenaltyCollector}`)
	logger.info(`Deploy PartyB:               ${report.config.deployPartyB}`)
	logger.info(`Set ADL Enabled:             ${report.config.setAdlEnabled}`)
	logger.info(`Deploy SymbolManager:        ${report.config.deploySymbolManager}`)
	logger.info(`SymbolManager Operator:      ${report.config.symbolManagerOperator || "(not set)"}`)
	logger.info(`Register Dummy Affiliate:    ${report.config.registerDummyAffiliate}`)
	logger.info(`Setup InstantLayer Templates: ${report.config.setupInstantLayerTemplates}`)
	logger.info(`Muon Verifier Mode:           ${report.config.deployMockVerifier ? "mock (local/test only)" : "real"}`)
	logger.info(`Muon App ID:                 ${report.config.muonAppId || "(not set)"}`)
	logger.info(`Muon UPNL Valid Time:        ${report.config.muonUpnlValidTime || "(not set)"}`)
	logger.info(`Muon Price Valid Time:       ${report.config.muonPriceValidTime || "(not set)"}`)
	logger.info(
		`Muon UPNL Overrides:         ${
			(report.config.muonFunctionUpnlValidTimes ?? []).map(({ name, upnlValidTime }) => `${name}=${upnlValidTime}`).join(", ") || "(none)"
		}`,
	)
	logger.info(`Muon Public Key X:           ${report.config.muonPublicKeyX || "(not set)"}`)
	logger.info(`Muon Public Key Parity:      ${report.config.muonPublicKeyParity || "(not set)"}`)
	logger.info(
		`Muon Gateway Signers:        ${report.config.muonGatewaySigners.length > 0 ? report.config.muonGatewaySigners.join(",") : "(not set)"}`,
	)
	logger.info(
		`Muon Function Permissions:   ${report.config.muonFunctionPermissions.length > 0 ? report.config.muonFunctionPermissions.join(",") : report.config.deployMockVerifier ? "(not applicable)" : "(not set)"}`,
	)
	logger.info()

	logger.info("=".repeat(80))
	logger.info(`Report generated at: ${report.timestamp}`)
	logger.info("=".repeat(80))
}

function saveReport(report: SystemDeploymentReport, deployedContracts: DeployedContracts): void {
	const filename = "deployment-report.json"
	const fullReport = {
		...report,
		addresses: deployedContracts,
	}

	writeData(filename, fullReport)

	logger.info()
	logger.info(`Full report saved to: ${getDataDir()}/${filename}`)
}
