/**
 * Update liquidation insurance vault params on an already-upgraded diamond.
 *
 * Reads target values from upgrade-<network>.json -> newV085Parameters:
 *   - liquidationInsuranceVault
 *   - maxLiquidationProfitPerPosition
 *
 * By default this is a preview/generation script: it reads current on-chain
 * params, writes raw calldata, and writes a Safe batch when safeAddress is
 * configured. It only broadcasts the setter transaction when EXECUTE=true.
 *
 * Run:
 *   ./node_modules/.bin/hardhat run scripts/upgrade/updateLiquidationInsuranceVaultParams.ts --network <network>
 *
 * Direct execution, only for a signer that has FEE_ADMIN_ROLE:
 *   EXECUTE=true CONFIRM_CHAIN_ID=<chainId> USE_KEYSTORE=true \
 *     ./node_modules/.bin/hardhat run scripts/upgrade/updateLiquidationInsuranceVaultParams.ts --network <network>
 *
 * Env overrides:
 *   DIAMOND_ADDRESS=0x...
 *   LIQUIDATION_INSURANCE_VAULT=0x...
 *   MAX_LIQUIDATION_PROFIT_PER_POSITION=100000000000000000000
 *   SAFE_ADDRESS=0x...
 *   FEE_ADMIN_ADDRESS=0x...
 *   PROPOSE_TO_SAFE_SERVICE=1|0
 *   SUBMIT_SAFE_PROPOSAL=true
 *   CONFIRM_CHAIN_ID=<connected chain id>
 *   CONFIRM_SAFE_ADDRESS=<exact Safe address>
 *   SAFE_SERVICE_URL
 *   SAFE_SERVICE_API_KEY
 *   SAFE_SENDER_ADDRESS
 *   SAFE_ORIGIN
 *   SAFE_NONCE
 *   TEAM_PROPOSER (private key loaded by hardhat.config.ts from .env or keystore)
 *   SAFE_PROPOSER_WALLET=ledger for Ledger Safe owner/delegate signing
 *   LEDGER_CONFIG_FILE to override the shared non-secret Ledger path config
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { exactBooleanEnv, requireExecutionConfirmation, requireSafeProposalConfirmation } from "./utils/executionGuard.js"
import { resolveConfiguredSigner } from "./utils/hardwareSigner.js"
import { log } from "./utils/log.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { baseNetworkName, resolveConfigFile, type UpgradeConfigShared } from "./utils/sharedConfig.js"
import { writeTxOverrides } from "./utils/txOverrides.js"
import { toHumanReadableSafeTxFromIface, type SafeBatch } from "./utils/upgradeHelpers.js"

type ProposalConfig = {
	enabled?: boolean
	safeServiceUrl?: string
	apiKey?: string
	apiKeyEnvVar?: string
	senderAddress?: string
	origin?: string
	safeNonce?: number | string | null
	submit?: boolean
	signature?: string
	signatureEnvVar?: string
}

type UpgradeConfig = UpgradeConfigShared & {
	safeProposal?: ProposalConfig
	proposal?: ProposalConfig
}

type CurrentParams = {
	liquidationInsuranceVault: string
	maxLiquidationProfitPerPosition: string
}

type SafeProposalPayload = {
	to: string
	value: string
	data: string
	operation: number
	safeTxGas: number
	baseGas: number
	gasPrice: string
	gasToken: string | null
	refundReceiver: string | null
	nonce: number
	contractTransactionHash: string
	sender: string
	signature: string
	origin?: string
}

type SafeServiceHeaders = Record<string, string>

type SafeSimulationStatus = {
	ok: boolean
	reason?: string
}

type SafeExecutionPreflightStatus = {
	ok: boolean
	reason?: string
}

type SafeMultisigTransactionListResponse = {
	next?: string | null
	results?: Array<{ nonce?: number | string | null; isExecuted?: boolean; executed?: boolean }>
}

type SafeDelegateListResponse = {
	next?: string | null
	results?: Array<{ delegate?: string | null }>
}

type SafeServiceTransaction = {
	to: string
	value: string
	data: string
	operation: number
}

type SafeProposalResult = {
	enabled: boolean
	submitSafeProposal: boolean
	submitted: boolean
	skippedReason?: string
	file?: string
	serviceUrl?: string
	senderAddress?: string
	safeNonce?: number
	safeTxHash?: string
	nonceResolution?: {
		nonce: number
		onChainNonce: number
		queuedNonces: number[]
		source: "config" | "service" | "onchain"
	}
	executionPreflight?: SafeExecutionPreflightStatus
	simulationStatus?: SafeSimulationStatus
	submissionEligibility?: {
		ok: boolean
		reason?: string
		owners: string[]
		delegates: string[]
	}
	response?: unknown
}

const OUTPUT_DIR = "./scripts/upgrade/output"
const FEE_ADMIN_ROLE = ethers.id("FEE_ADMIN_ROLE")
const SAFE_SERVICE_SLUGS_BY_CHAIN_ID: Record<string, string> = {
	"1": "eth",
	"10": "oeth",
	"56": "bnb",
	"100": "gno",
	"146": "sonic",
	"137": "matic",
	"999": "hyper",
	"8453": "base",
	"9745": "plasma",
	"42161": "arb1",
	"43114": "avax",
	"5000": "mantle",
	"80094": "berachain",
}
const SAFE_SERVICE_SLUGS_BY_NETWORK: Record<string, string> = {
	arbitrum: "arb1",
	base: "base",
	bera: "berachain",
	berachain: "berachain",
	bsc: "bnb",
	hyperevm: "hyper",
	mantle: "mantle",
	polygon: "matic",
	plasma: "plasma",
	sonic: "sonic",
}
const DIAMOND_ABI = [
	"function getLiquidationInsuranceVaultParams() view returns (address liquidationInsuranceVault, uint256 maxLiquidationProfitPerPosition)",
	"function setLiquidationInsuranceVaultParams(address insuranceVault, uint256 maxLiquidationProfit)",
	"function hasRole(address user, bytes32 role) view returns (bool)",
]
const diamondIface = new ethers.Interface(DIAMOND_ABI)
const safeIface = new ethers.Interface([
	"function nonce() view returns (uint256)",
	"function getOwners() view returns (address[])",
	"function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
])

function parseBool(value: string | undefined): boolean {
	return /^(1|true|yes)$/i.test(value ?? "")
}

function parseOptionalNonce(value: number | string | null | undefined): number | undefined {
	if (value === undefined || value === null || value === "") return undefined
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`safe nonce must be a non-negative integer, got ${JSON.stringify(value)}`)
	}
	return parsed
}

function buildEthSignSafeSignature(rawSignature: string): string {
	const sig = ethers.Signature.from(rawSignature)
	const adjustedV = sig.v + 4
	return ethers.hexlify(ethers.concat([sig.r, sig.s, ethers.toBeHex(adjustedV, 1)]))
}

function normalizeServiceUrl(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url
}

function buildSafeServiceHeaders(apiKey: string | undefined): SafeServiceHeaders {
	const headers: SafeServiceHeaders = {
		"Content-Type": "application/json",
	}
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`
	return headers
}

function normalizeAddress(label: string, address: string | undefined): string {
	if (!address || !ethers.isAddress(address) || address === ethers.ZeroAddress) {
		throw new Error(`${label} must be a non-zero address`)
	}
	return ethers.getAddress(address)
}

function normalizeOptionalAddress(label: string, address: string | undefined): string | undefined {
	if (!address) return undefined
	if (!ethers.isAddress(address) || address === ethers.ZeroAddress) {
		throw new Error(`${label} must be a non-zero address`)
	}
	return ethers.getAddress(address)
}

function parsePositiveUint(label: string, value: string | undefined): bigint {
	if (!value) throw new Error(`${label} is required`)
	const parsed = BigInt(value)
	if (parsed <= 0n) throw new Error(`${label} must be positive`)
	return parsed
}

function loadUpgradeConfig(networkName: string): { config: UpgradeConfig; file: string } {
	const file = resolveConfigFile("upgrade", networkName, process.env.UPGRADE_CONFIG_FILE)
	if (!fs.existsSync(file)) throw new Error(`Upgrade config not found: ${file}`)
	return { config: JSON.parse(fs.readFileSync(file, "utf-8")) as UpgradeConfig, file }
}

function resolveSafeServiceUrl(chainId: string, networkSuffix: string | undefined, proposalConfig: ProposalConfig): string | undefined {
	const configuredUrl = process.env.SAFE_SERVICE_URL ?? proposalConfig.safeServiceUrl
	if (configuredUrl) return configuredUrl

	const slug = SAFE_SERVICE_SLUGS_BY_CHAIN_ID[chainId] ?? (networkSuffix ? SAFE_SERVICE_SLUGS_BY_NETWORK[networkSuffix] : undefined)
	return slug ? `https://api.safe.global/tx-service/${slug}/api/v1` : undefined
}

async function estimateSafeTransaction(
	safeServiceUrl: string,
	safe: string,
	apiKey: string | undefined,
	tx: SafeServiceTransaction,
): Promise<unknown> {
	const endpoint = `${normalizeServiceUrl(safeServiceUrl)}/safes/${safe}/multisig-transactions/estimations/`
	const response = await fetch(endpoint, {
		method: "POST",
		headers: buildSafeServiceHeaders(apiKey),
		body: JSON.stringify(tx),
	})
	const responseText = await response.text()
	if (!response.ok) {
		throw new Error(`Safe estimation failed (${response.status} ${response.statusText}): ${responseText}`)
	}
	if (!responseText.trim()) return {}
	try {
		return JSON.parse(responseText)
	} catch {
		return responseText
	}
}

async function getQueuedSafeNonces(safeServiceUrl: string, safe: string, apiKey: string | undefined): Promise<number[]> {
	const nonces: number[] = []
	let nextUrl: string | null = `${normalizeServiceUrl(safeServiceUrl)}/safes/${safe}/multisig-transactions/?executed=false&limit=100&ordering=nonce`

	while (nextUrl) {
		const response = await fetch(nextUrl, {
			method: "GET",
			headers: buildSafeServiceHeaders(apiKey),
		})
		const responseText = await response.text()
		if (!response.ok) {
			throw new Error(`Failed to read queued Safe transactions (${response.status} ${response.statusText}): ${responseText}`)
		}
		const page = JSON.parse(responseText) as SafeMultisigTransactionListResponse
		for (const tx of page.results ?? []) {
			if (tx.isExecuted === true || tx.executed === true || tx.nonce === null || tx.nonce === undefined) continue
			const nonce = Number(tx.nonce)
			if (Number.isInteger(nonce) && nonce >= 0) nonces.push(nonce)
		}
		nextUrl = page.next ?? null
	}

	return nonces
}

async function getSafeDelegates(safeServiceUrl: string, safe: string, apiKey: string | undefined): Promise<string[]> {
	const delegates: string[] = []
	let nextUrl: string | null = `${normalizeServiceUrl(safeServiceUrl)}/delegates/?safe=${safe}&limit=100`

	while (nextUrl) {
		const response = await fetch(nextUrl, {
			method: "GET",
			headers: buildSafeServiceHeaders(apiKey),
		})
		const responseText = await response.text()
		if (!response.ok) {
			throw new Error(`Failed to read Safe delegates (${response.status} ${response.statusText}): ${responseText}`)
		}
		const page = JSON.parse(responseText) as SafeDelegateListResponse
		for (const item of page.results ?? []) {
			if (item.delegate && ethers.isAddress(item.delegate)) delegates.push(ethers.getAddress(item.delegate))
		}
		nextUrl = page.next ?? null
	}

	return delegates
}

async function resolveSafeNonce(
	safeContract: { nonce(): Promise<bigint> },
	safeServiceUrl: string,
	safe: string,
	apiKey: string | undefined,
	configuredNonce: number | string | null | undefined,
): Promise<{ nonce: number; onChainNonce: number; queuedNonces: number[]; source: "config" | "service" | "onchain" }> {
	const onChainNonce = Number(await safeContract.nonce())
	const parsedConfiguredNonce = parseOptionalNonce(process.env.SAFE_NONCE ?? configuredNonce)
	if (parsedConfiguredNonce !== undefined) {
		return { nonce: parsedConfiguredNonce, onChainNonce, queuedNonces: [], source: "config" }
	}

	const queuedNonces = await getQueuedSafeNonces(safeServiceUrl, safe, apiKey)
	const relevantQueuedNonces = queuedNonces.filter(nonce => nonce >= onChainNonce)
	if (relevantQueuedNonces.length === 0) {
		return { nonce: onChainNonce, onChainNonce, queuedNonces, source: "onchain" }
	}

	return { nonce: Math.max(...relevantQueuedNonces) + 1, onChainNonce, queuedNonces, source: "service" }
}

function getSafeSimulationStatus(result: unknown): SafeSimulationStatus {
	if (typeof result !== "object" || result === null) return { ok: false, reason: "Simulation response is not a JSON object" }
	const estimate = result as Record<string, unknown>
	const booleanFailure = ["success", "isSuccessful", "transactionValid"].find(key => typeof estimate[key] === "boolean" && estimate[key] === false)
	if (booleanFailure) return { ok: false, reason: `Simulation response reported ${booleanFailure}=false` }

	const errorMessage = ["error", "detail", "exception", "revertReason", "reason"].find(key => typeof estimate[key] === "string" && estimate[key])
	if (errorMessage) return { ok: false, reason: String(estimate[errorMessage]) }

	const safeTxGas = estimate.safeTxGas
	if (typeof safeTxGas === "string" || typeof safeTxGas === "number") return { ok: true }

	return { ok: false, reason: "Simulation response did not include safeTxGas" }
}

function summarizeCallError(error: any): string {
	const candidates = [error?.shortMessage, error?.reason, error?.info?.error?.message, error?.error?.message, error?.message].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	)
	return candidates[0] ?? String(error)
}

async function checkSafeExecutionPreflight(safe: string, diamond: string, calldata: string): Promise<SafeExecutionPreflightStatus> {
	try {
		await ethers.provider.call({ from: safe, to: diamond, data: calldata })
		return { ok: true }
	} catch (error: any) {
		return {
			ok: false,
			reason: summarizeCallError(error),
		}
	}
}

async function submitSafeProposalToService(
	safeServiceUrl: string,
	safe: string,
	apiKey: string | undefined,
	payload: SafeProposalPayload,
): Promise<unknown> {
	const endpoint = `${normalizeServiceUrl(safeServiceUrl)}/safes/${safe}/multisig-transactions/`
	const response = await fetch(endpoint, {
		method: "POST",
		headers: buildSafeServiceHeaders(apiKey),
		body: JSON.stringify(payload),
	})
	const responseText = await response.text()
	if (!response.ok) {
		throw new Error(`Safe proposal failed (${response.status} ${response.statusText}): ${responseText}`)
	}
	if (!responseText.trim()) return {}
	try {
		return JSON.parse(responseText)
	} catch {
		return responseText
	}
}

function paramsMatch(current: CurrentParams, targetVault: string, targetMaxProfit: bigint): boolean {
	return (
		current.liquidationInsuranceVault.toLowerCase() === targetVault.toLowerCase() &&
		BigInt(current.maxLiquidationProfitPerPosition) === targetMaxProfit
	)
}

async function readCurrentParams(diamondAddress: string): Promise<CurrentParams> {
	const diamond = await ethers.getContractAt(DIAMOND_ABI, diamondAddress)
	try {
		const [vault, maxProfit] = await diamond.getLiquidationInsuranceVaultParams()
		return {
			liquidationInsuranceVault: ethers.getAddress(vault),
			maxLiquidationProfitPerPosition: maxProfit.toString(),
		}
	} catch (error) {
		throw new Error(`Failed to read getLiquidationInsuranceVaultParams(). Is ${diamondAddress} already upgraded? ${String(error)}`)
	}
}

async function hasFeeAdminRole(diamondAddress: string, account: string | undefined): Promise<boolean | undefined> {
	if (!account) return undefined
	const diamond = await ethers.getContractAt(DIAMOND_ABI, diamondAddress)
	return diamond.hasRole(account, FEE_ADMIN_ROLE)
}

function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

async function prepareSafeServiceProposal(args: {
	networkName: string
	configNetworkName: string
	chainId: string
	diamondAddress: string
	safeAddress?: string
	calldata: string
	targetVault: string
	targetMaxProfit: bigint
	proposalConfig: ProposalConfig
	submitSafeProposal: boolean
}): Promise<SafeProposalResult | undefined> {
	if (!args.safeAddress) {
		return {
			enabled: false,
			submitSafeProposal: false,
			submitted: false,
			skippedReason: "safeAddress is not configured",
		}
	}

	const proposeToSafeService =
		process.env.PROPOSE_TO_SAFE_SERVICE !== undefined ? parseBool(process.env.PROPOSE_TO_SAFE_SERVICE) : args.proposalConfig.enabled !== false
	const submitSafeProposal = args.submitSafeProposal

	if (!proposeToSafeService) {
		return {
			enabled: false,
			submitSafeProposal,
			submitted: false,
			skippedReason: "Safe service proposal disabled",
		}
	}

	const safeServiceUrl = resolveSafeServiceUrl(args.chainId, args.configNetworkName, args.proposalConfig)
	if (!safeServiceUrl) {
		return {
			enabled: true,
			submitSafeProposal,
			submitted: false,
			skippedReason: `No Safe Transaction Service URL mapping for ${args.configNetworkName} / chain ${args.chainId}`,
		}
	}

	const configuredSender = process.env.SAFE_SENDER_ADDRESS ?? args.proposalConfig.senderAddress
	const senderAddress = configuredSender ? ethers.getAddress(configuredSender) : ethers.getAddress((await ethers.provider.getSigner()).address)
	const apiKeyEnvVar = args.proposalConfig.apiKeyEnvVar ?? "SAFE_SERVICE_API_KEY"
	const apiKey = process.env.SAFE_SERVICE_API_KEY ?? process.env[apiKeyEnvVar] ?? args.proposalConfig.apiKey
	const safeContract = new ethers.Contract(args.safeAddress, safeIface, ethers.provider)
	const nonceResolution = await resolveSafeNonce(
		safeContract as unknown as { nonce(): Promise<bigint> },
		safeServiceUrl,
		args.safeAddress,
		apiKey,
		args.proposalConfig.safeNonce,
	)
	const safeNonce = nonceResolution.nonce
	const origin =
		process.env.SAFE_ORIGIN ??
		args.proposalConfig.origin ??
		`Symmio: setLiquidationInsuranceVaultParams(${args.targetVault}, ${args.targetMaxProfit.toString()}) on ${args.networkName}`
	const serviceTx: SafeServiceTransaction = {
		to: args.diamondAddress,
		value: "0",
		data: args.calldata,
		operation: 0,
	}

	log.info("Safe Transaction Service:")
	log.info(`  URL:                  ${normalizeServiceUrl(safeServiceUrl)}`)
	log.info(`  Sender:               ${senderAddress}`)
	log.info(`  Safe on-chain nonce:  ${nonceResolution.onChainNonce}`)
	log.info(
		`  Queued proposal nonces: ${nonceResolution.queuedNonces.length > 0 ? nonceResolution.queuedNonces.sort((a, b) => a - b).join(", ") : "(none)"}`,
	)
	log.info(`  Selected Safe nonce:  ${safeNonce} (${nonceResolution.source})`)

	log.info("\nChecking execution preflight from the Safe address...")
	const executionPreflight = await checkSafeExecutionPreflight(args.safeAddress, args.diamondAddress, args.calldata)
	if (executionPreflight.ok) {
		log.ok("Safe execution preflight passed")
	} else {
		log.warn(`Safe execution preflight failed: ${executionPreflight.reason ?? "unknown reason"}`)
	}

	const safeTxHash = (await safeContract.getTransactionHash(
		serviceTx.to,
		serviceTx.value,
		serviceTx.data,
		serviceTx.operation,
		0,
		0,
		0,
		ethers.ZeroAddress,
		ethers.ZeroAddress,
		safeNonce,
	)) as string

	log.info("\nSimulating Safe transaction via Safe Transaction Service estimation...")
	const simulationResult = await estimateSafeTransaction(safeServiceUrl, args.safeAddress, apiKey, serviceTx)
	const simulationStatus = getSafeSimulationStatus(simulationResult)
	if (simulationStatus.ok) {
		log.ok("Safe simulation passed")
	} else {
		log.warn(`Safe simulation failed: ${simulationStatus.reason ?? "unknown reason"}`)
	}

	let submissionEligibility: SafeProposalResult["submissionEligibility"]
	if (submitSafeProposal) {
		const owners = ((await safeContract.getOwners()) as string[]).map(owner => ethers.getAddress(owner))
		let delegates: string[] = []
		try {
			delegates = await getSafeDelegates(safeServiceUrl, args.safeAddress, apiKey)
		} catch (error: any) {
			log.warn(`Could not read Safe delegates before submission: ${error.message ?? error}`)
		}

		const isOwner = owners.some(owner => owner.toLowerCase() === senderAddress.toLowerCase())
		const isDelegate = delegates.some(delegate => delegate.toLowerCase() === senderAddress.toLowerCase())
		submissionEligibility = {
			ok: isOwner || isDelegate,
			reason: isOwner || isDelegate ? undefined : "Sender is not a Safe owner or registered delegate",
			owners,
			delegates,
		}

		if (!submissionEligibility.ok) {
			log.warn(`Safe proposal submission skipped: ${submissionEligibility.reason}`)
			log.info(`  Owners:    ${owners.join(", ")}`)
			log.info(`  Delegates: ${delegates.length > 0 ? delegates.join(", ") : "(none)"}`)
		}
	}

	const proposalPreview = {
		...serviceTx,
		safeTxGas: 0,
		baseGas: 0,
		gasPrice: "0",
		gasToken: null,
		refundReceiver: null,
		nonce: safeNonce,
		contractTransactionHash: safeTxHash,
		sender: senderAddress,
		origin,
	}

	let payload: SafeProposalPayload | undefined
	let submitted = false
	let response: unknown
	if (submitSafeProposal && submissionEligibility?.ok && executionPreflight.ok && simulationStatus.ok) {
		const signatureEnvVar = args.proposalConfig.signatureEnvVar ?? "SAFE_PROPOSAL_SIGNATURE"
		const configuredSignature = process.env[signatureEnvVar] ?? args.proposalConfig.signature
		let safeSignature: string
		if (configuredSignature) {
			safeSignature = configuredSignature
		} else {
			const senderSigner = await resolveConfiguredSigner({
				role: "safeProposer",
				expectedAddress: senderAddress,
				envPrefix: "SAFE_PROPOSER",
			})
			const signerAddress = ethers.getAddress(await senderSigner.getAddress())
			if (signerAddress !== senderAddress) {
				throw new Error(`Resolved signer ${signerAddress} does not match configured Safe proposal sender ${senderAddress}`)
			}
			const rawSignature = await senderSigner.signMessage(ethers.getBytes(safeTxHash))
			safeSignature = buildEthSignSafeSignature(rawSignature)
		}
		payload = {
			...proposalPreview,
			signature: safeSignature,
		}

		log.info("\nSubmitting proposal to Safe Transaction Service...")
		response = await submitSafeProposalToService(normalizeServiceUrl(safeServiceUrl), args.safeAddress, apiKey, payload)
		submitted = true
		log.ok("Safe proposal submitted successfully")
	} else if (submitSafeProposal) {
		log.warn("Safe proposal submission skipped because preflight, simulation, or owner/delegate eligibility did not pass.")
	} else {
		log.warn(
			`Safe proposal submission skipped. To submit, set SUBMIT_SAFE_PROPOSAL=true CONFIRM_CHAIN_ID=${args.chainId} CONFIRM_SAFE_ADDRESS=${args.safeAddress}.`,
		)
	}

	ensureDir(OUTPUT_DIR)
	const file = path.join(OUTPUT_DIR, `liquidation-insurance-params-safe-proposal-${args.configNetworkName}.json`)
	fs.writeFileSync(
		file,
		JSON.stringify(
			{
				network: args.networkName,
				chainId: args.chainId,
				safe: args.safeAddress,
				diamond: args.diamondAddress,
				senderAddress,
				safeNonce,
				nonceResolution,
				safeTxHash,
				serviceUrl: normalizeServiceUrl(safeServiceUrl),
				executionPreflight,
				simulationResult,
				simulationStatus,
				submissionEligibility,
				submitSafeProposal,
				submitted,
				response,
				proposal: proposalPreview,
				payload,
			},
			null,
			2,
		),
	)

	return {
		enabled: true,
		submitSafeProposal,
		submitted,
		file,
		serviceUrl: normalizeServiceUrl(safeServiceUrl),
		senderAddress,
		safeNonce,
		safeTxHash,
		nonceResolution,
		executionPreflight,
		simulationStatus,
		submissionEligibility,
		response,
	}
}

function writeOutputs(args: {
	networkName: string
	configNetworkName: string
	chainId: string
	configFile: string
	diamondAddress: string
	safeAddress?: string
	current: CurrentParams
	targetVault: string
	targetMaxProfit: bigint
	calldata: string
	matching: boolean
	executed: boolean
	txHash?: string
	roleChecks: Record<string, boolean | undefined>
	safeProposal?: SafeProposalResult
}): { reportFile: string; safeBatchFile?: string } {
	ensureDir(OUTPUT_DIR)

	const safeTx =
		args.matching && !parseBool(process.env.FORCE)
			? undefined
			: toHumanReadableSafeTxFromIface(diamondIface, args.diamondAddress, "setLiquidationInsuranceVaultParams", [
					args.targetVault,
					args.targetMaxProfit,
				])

	let safeBatchFile: string | undefined
	if (args.safeAddress && safeTx) {
		const safeBatch: SafeBatch = {
			version: "1.0",
			chainId: args.chainId,
			createdAt: Date.now(),
			meta: {
				name: "Symmio - Update Liquidation Insurance Params",
				description: "setLiquidationInsuranceVaultParams for an already-upgraded diamond",
				txBuilderVersion: "1.18.0",
				createdFromSafeAddress: args.safeAddress,
				createdFromOwnerAddress: "",
			},
			transactions: [safeTx],
		}
		safeBatchFile = path.join(OUTPUT_DIR, `liquidation-insurance-params-safe-batch-${args.configNetworkName}.json`)
		fs.writeFileSync(safeBatchFile, JSON.stringify(safeBatch, null, 2))
	}

	const reportFile = path.join(OUTPUT_DIR, `liquidation-insurance-params-report-${args.configNetworkName}.json`)
	fs.writeFileSync(
		reportFile,
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				networkName: args.networkName,
				configNetworkName: args.configNetworkName,
				chainId: args.chainId,
				configFile: args.configFile,
				diamondAddress: args.diamondAddress,
				safeAddress: args.safeAddress,
				current: args.current,
				target: {
					liquidationInsuranceVault: args.targetVault,
					maxLiquidationProfitPerPosition: args.targetMaxProfit.toString(),
				},
				matching: args.matching,
				executed: args.executed,
				txHash: args.txHash,
				calldata: args.calldata,
				safeBatchFile,
				safeProposal: args.safeProposal,
				roleChecks: args.roleChecks,
			},
			null,
			2,
		),
	)

	return { reportFile, safeBatchFile }
}

async function main() {
	const networkName = connection.networkName
	const configNetworkName = baseNetworkName(networkName) ?? networkName
	const { config, file: configFile } = loadUpgradeConfig(configNetworkName)
	const params = config.newV085Parameters ?? {}
	const proposalConfig = config.safeProposal ?? config.proposal ?? {}

	const diamondAddress = normalizeAddress("DIAMOND_ADDRESS", process.env.DIAMOND_ADDRESS ?? config.diamondAddress)
	const targetVault = normalizeAddress("LIQUIDATION_INSURANCE_VAULT", process.env.LIQUIDATION_INSURANCE_VAULT ?? params.liquidationInsuranceVault)
	const targetMaxProfit = parsePositiveUint(
		"MAX_LIQUIDATION_PROFIT_PER_POSITION",
		process.env.MAX_LIQUIDATION_PROFIT_PER_POSITION ?? params.maxLiquidationProfitPerPosition,
	)
	const safeAddress = normalizeOptionalAddress("SAFE_ADDRESS", process.env.SAFE_ADDRESS ?? config.safeAddress)
	const feeAdminAddress = normalizeOptionalAddress(
		"FEE_ADMIN_ADDRESS",
		process.env.FEE_ADMIN_ADDRESS ?? process.env.PROTOCOL_ADMIN ?? config.protocolAdmin,
	)
	await verifyRpc()
	const connectedChainId = (await ethers.provider.getNetwork()).chainId
	const chainId = String(Number(connectedChainId))
	const execute = requireExecutionConfirmation(connectedChainId)
	const force = exactBooleanEnv("FORCE")
	const submitWithoutSafe = !safeAddress && (exactBooleanEnv("SUBMIT_SAFE_PROPOSAL") || exactBooleanEnv("SAFE_PROPOSAL_SUBMIT"))
	if (submitWithoutSafe) throw new Error("SUBMIT_SAFE_PROPOSAL=true requires SAFE_ADDRESS")
	const submitSafeProposal = safeAddress ? requireSafeProposalConfirmation(connectedChainId, safeAddress) : false
	if (execute && submitSafeProposal) throw new Error("Choose one mutation path per run: EXECUTE=true or SUBMIT_SAFE_PROPOSAL=true")
	if (proposalConfig.submit === true && !submitSafeProposal) {
		log.warn("Config safeProposal.submit=true is informational only; this run will not submit without the explicit Safe submission interlocks.")
	}

	const current = await readCurrentParams(diamondAddress)
	const matching = paramsMatch(current, targetVault, targetMaxProfit)
	const calldata = diamondIface.encodeFunctionData("setLiquidationInsuranceVaultParams", [targetVault, targetMaxProfit])
	const roleChecks: Record<string, boolean | undefined> = {
		feeAdminAddress: await hasFeeAdminRole(diamondAddress, feeAdminAddress),
		safeAddress: await hasFeeAdminRole(diamondAddress, safeAddress),
	}

	log.header("Liquidation Insurance Params")
	log.kv("Network", networkName)
	log.kv("Config network", configNetworkName)
	log.kv("Config", configFile)
	log.kv("Diamond", diamondAddress)
	log.kv("Current vault", current.liquidationInsuranceVault)
	log.kv("Current max profit", current.maxLiquidationProfitPerPosition)
	log.kv("Target vault", targetVault)
	log.kv("Target max profit", targetMaxProfit.toString())
	log.kv("Safe", safeAddress ?? "(not configured)")
	log.kv("Fee admin signer", feeAdminAddress ?? "(default signer if executing)")
	if (roleChecks.feeAdminAddress !== undefined) log.kv("Fee admin signer has FEE_ADMIN_ROLE", String(roleChecks.feeAdminAddress))
	if (roleChecks.safeAddress !== undefined) log.kv("Safe has FEE_ADMIN_ROLE", String(roleChecks.safeAddress))
	log.kv("Execute", String(execute))
	log.kv("Force", String(force))
	log.blank()

	if (matching && !force) {
		log.ok("On-chain params already match target. No transaction needed.")
		const outputs = writeOutputs({
			networkName,
			configNetworkName,
			chainId,
			configFile,
			diamondAddress,
			safeAddress,
			current,
			targetVault,
			targetMaxProfit,
			calldata,
			matching,
			executed: false,
			roleChecks,
			safeProposal: {
				enabled: false,
				submitSafeProposal: false,
				submitted: false,
				skippedReason: "on-chain params already match target",
			},
		})
		log.ok(`Report: ${outputs.reportFile}`)
		return
	}

	log.info("Prepared call:")
	log.info(`  setLiquidationInsuranceVaultParams(${targetVault}, ${targetMaxProfit.toString()})`)
	log.info(`  calldata: ${calldata}`)
	log.blank()

	let txHash: string | undefined
	if (execute) {
		const signer = await resolveConfiguredSigner({
			role: process.env.FEE_ADMIN_ADDRESS ? "feeAdmin" : "protocolAdmin",
			expectedAddress: feeAdminAddress,
			envPrefix: process.env.FEE_ADMIN_ADDRESS ? "FEE_ADMIN" : feeAdminAddress ? "PROTOCOL_ADMIN" : undefined,
			allowDefault: !feeAdminAddress,
		})
		const signerAddress = ethers.getAddress(await signer.getAddress())
		if (!(await hasFeeAdminRole(diamondAddress, signerAddress))) {
			throw new Error(`${signerAddress} does not have FEE_ADMIN_ROLE on ${diamondAddress}`)
		}

		const diamond = await ethers.getContractAt(DIAMOND_ABI, diamondAddress, signer)
		log.info(`Submitting from ${signerAddress}...`)
		await diamond.setLiquidationInsuranceVaultParams.staticCall(targetVault, targetMaxProfit, writeTxOverrides())
		const tx = await diamond.setLiquidationInsuranceVaultParams(targetVault, targetMaxProfit, writeTxOverrides())
		log.info(`Tx submitted: ${tx.hash} (nonce: ${tx.nonce})`)
		const receipt = await tx.wait()
		if (!receipt?.status) throw new Error(`setLiquidationInsuranceVaultParams transaction failed: ${tx.hash}`)
		txHash = receipt.hash
		log.ok(`Tx confirmed: ${receipt.hash} (gas: ${receipt.gasUsed})`)

		const updated = await readCurrentParams(diamondAddress)
		if (!paramsMatch(updated, targetVault, targetMaxProfit)) {
			throw new Error(`Post-update verification failed: ${JSON.stringify(updated)}`)
		}
		log.ok("Post-update verification passed")
	} else {
		log.warn("Preview only. Set EXECUTE=true to broadcast directly, or import the generated Safe batch.")
	}

	const safeProposal =
		safeAddress && !execute
			? await prepareSafeServiceProposal({
					networkName,
					configNetworkName,
					chainId,
					diamondAddress,
					safeAddress,
					calldata,
					targetVault,
					targetMaxProfit,
					proposalConfig,
					submitSafeProposal,
				})
			: undefined

	const outputs = writeOutputs({
		networkName,
		configNetworkName,
		chainId,
		configFile,
		diamondAddress,
		safeAddress,
		current,
		targetVault,
		targetMaxProfit,
		calldata,
		matching,
		executed: execute,
		txHash,
		roleChecks,
		safeProposal,
	})
	log.ok(`Report: ${outputs.reportFile}`)
	if (outputs.safeBatchFile) log.ok(`Safe batch: ${outputs.safeBatchFile}`)
	if (safeProposal?.file) log.ok(`Safe proposal: ${safeProposal.file}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
