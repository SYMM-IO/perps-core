/**
 * Generate a Safe batch for granting a liquidation role and optionally submit
 * the same transaction to the Safe Transaction Service.
 *
 * Default config path:
 *   scripts/upgrade/config/grantLiquidatorRole-<network>.json
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/generateGrantLiquidatorRoleSafeProposal.ts --network base
 *
 * Useful env overrides:
 *   DIAMOND_ADDRESS=0x...
 *   SAFE_ADDRESS=0x...
 *   LIQUIDATOR_ADDRESS=0x...
 *   GRANT_ROLE=LIQUIDATOR_ROLE
 *   PROPOSE_TO_SAFE_SERVICE=1|0
 *   SUBMIT_SAFE_PROPOSAL=1|0
 *   SAFE_SENDER_ADDRESS=0x...
 *   SAFE_NONCE=123
 *   GRANT_LIQUIDATOR_OUTPUT_DIR=/tmp/grant-liquidator-role
 *   TEAM_PROPOSER=0x... (loaded by hardhat.config.ts from .env or keystore)
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { baseNetworkName, loadUpgradeConfigShared } from "./utils/sharedConfig.js"
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

type GrantLiquidatorConfig = {
	diamondAddress?: string
	safeAddress?: string
	liquidatorAddress?: string
	targetAddress?: string
	role?: string
	safeProposal?: ProposalConfig
	proposal?: ProposalConfig
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

type SafeSimulationStatus = {
	ok: boolean
	reason?: string
}

type SafeExecutionPreflightStatus = {
	ok: boolean
	reason?: string
}

const CONFIG_DIR = "./scripts/upgrade/config"
const OUTPUT_DIR = process.env.GRANT_LIQUIDATOR_OUTPUT_DIR ?? "./scripts/upgrade/output/grant-liquidator-role"
const DEFAULT_ROLE = "LIQUIDATOR_ROLE"
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/

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

const controlFacetIface = new ethers.Interface(["function grantRole(address user, bytes32 role)"])
const viewFacetIface = new ethers.Interface(["function hasRole(address user, bytes32 role) view returns (bool)"])
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

function buildSafeServiceHeaders(apiKey: string | undefined): Record<string, string> {
	const headers: Record<string, string> = {
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

function resolveRoleHash(role: string): { hash: string; display: string } {
	const trimmed = role.trim()
	if (!trimmed) throw new Error("role is required")
	if (trimmed.includes(",")) throw new Error("generateGrantLiquidatorRoleSafeProposal.ts supports exactly one role")
	if (BYTES32_RE.test(trimmed)) return { hash: trimmed.toLowerCase(), display: trimmed }
	return { hash: ethers.id(trimmed), display: trimmed }
}

function readJsonFile<T>(file: string): T | undefined {
	if (!fs.existsSync(file)) return undefined
	return JSON.parse(fs.readFileSync(file, "utf-8")) as T
}

function mergeProposalConfig(defaultConfig: GrantLiquidatorConfig, networkConfig: GrantLiquidatorConfig): GrantLiquidatorConfig {
	return {
		...defaultConfig,
		...networkConfig,
		safeProposal: {
			...(defaultConfig.safeProposal ?? defaultConfig.proposal ?? {}),
			...(networkConfig.safeProposal ?? networkConfig.proposal ?? {}),
		},
	}
}

function loadGrantLiquidatorConfig(networkSuffix: string | undefined): { file: string; config: GrantLiquidatorConfig } {
	const defaultFile = `${CONFIG_DIR}/grantLiquidatorRole.json`
	const networkFile = networkSuffix ? `${CONFIG_DIR}/grantLiquidatorRole-${networkSuffix}.json` : defaultFile
	const defaultConfig = readJsonFile<GrantLiquidatorConfig>(defaultFile) ?? {}

	if (!networkSuffix || networkFile === defaultFile || !fs.existsSync(networkFile)) {
		return { file: networkFile, config: defaultConfig }
	}

	const networkConfig = readJsonFile<GrantLiquidatorConfig>(networkFile) ?? {}
	return { file: networkFile, config: mergeProposalConfig(defaultConfig, networkConfig) }
}

function resolveSafeServiceUrl(chainId: string, networkSuffix: string | undefined, proposalConfig: ProposalConfig): string | undefined {
	const configuredUrl = process.env.SAFE_SERVICE_URL ?? proposalConfig.safeServiceUrl
	if (configuredUrl) return configuredUrl

	const slug = SAFE_SERVICE_SLUGS_BY_CHAIN_ID[chainId] ?? (networkSuffix ? SAFE_SERVICE_SLUGS_BY_NETWORK[networkSuffix] : undefined)
	return slug ? `https://api.safe.global/tx-service/${slug}/api/v1` : undefined
}

async function resolveChainId(): Promise<string> {
	if (process.env.CHAIN_ID) return process.env.CHAIN_ID
	return String(Number((await ethers.provider.getNetwork()).chainId))
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
	if (!response.ok) throw new Error(`Safe estimation failed (${response.status} ${response.statusText}): ${responseText}`)
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
		if (!response.ok) throw new Error(`Failed to read Safe delegates (${response.status} ${response.statusText}): ${responseText}`)
		const page = JSON.parse(responseText) as SafeDelegateListResponse
		for (const item of page.results ?? []) {
			if (item.delegate && ethers.isAddress(item.delegate)) delegates.push(ethers.getAddress(item.delegate))
		}
		nextUrl = page.next ?? null
	}

	return delegates
}

async function resolveSafeNonce(
	safeContract: ethers.Contract,
	safeServiceUrl: string,
	safe: string,
	apiKey: string | undefined,
	configuredNonce: number | string | null | undefined,
): Promise<{ nonce: number; onChainNonce: number; queuedNonces: number[]; source: "config" | "service" | "onchain" }> {
	const onChainNonce = Number(await safeContract.nonce())
	const parsedConfiguredNonce = parseOptionalNonce(process.env.SAFE_NONCE ?? configuredNonce)
	if (parsedConfiguredNonce !== undefined) return { nonce: parsedConfiguredNonce, onChainNonce, queuedNonces: [], source: "config" }

	const queuedNonces = await getQueuedSafeNonces(safeServiceUrl, safe, apiKey)
	const relevantQueuedNonces = queuedNonces.filter(nonce => nonce >= onChainNonce)
	if (relevantQueuedNonces.length === 0) return { nonce: onChainNonce, onChainNonce, queuedNonces, source: "onchain" }

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
		return { ok: false, reason: summarizeCallError(error) }
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
	if (!response.ok) throw new Error(`Safe proposal failed (${response.status} ${response.statusText}): ${responseText}`)
	if (!responseText.trim()) return {}
	try {
		return JSON.parse(responseText)
	} catch {
		return responseText
	}
}

function deriveSenderFromTeamProposer(): string | undefined {
	const privateKey = process.env.TEAM_PROPOSER
	if (!privateKey) return undefined
	try {
		return ethers.getAddress(new ethers.Wallet(privateKey).address)
	} catch (error: any) {
		throw new Error(`TEAM_PROPOSER is set but does not look like a usable private key: ${error?.message ?? error}`)
	}
}

function resolveSenderAddress(proposalConfig: ProposalConfig): string {
	const senderRaw = process.env.SAFE_SENDER_ADDRESS ?? proposalConfig.senderAddress ?? deriveSenderFromTeamProposer()
	if (!senderRaw) {
		throw new Error("Safe proposal sender is required. Set SAFE_SENDER_ADDRESS or safeProposal.senderAddress.")
	}
	return normalizeAddress("Safe proposal sender", senderRaw)
}

function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

async function main() {
	const networkName = connection.networkName
	const networkSuffix = baseNetworkName(networkName) ?? networkName
	const shared = loadUpgradeConfigShared(networkSuffix)
	const { file: grantConfigFile, config } = loadGrantLiquidatorConfig(networkSuffix)
	const proposalConfig = config.safeProposal ?? config.proposal ?? {}

	const diamond = normalizeAddress("diamondAddress", process.env.DIAMOND_ADDRESS ?? config.diamondAddress ?? shared.diamondAddress)
	const safe = normalizeAddress("safeAddress", process.env.SAFE_ADDRESS ?? config.safeAddress ?? shared.safeAddress)
	const liquidator = normalizeAddress(
		"liquidatorAddress",
		process.env.LIQUIDATOR_ADDRESS ?? process.env.GRANT_ROLE_TARGET ?? process.env.TARGET_ADDRESS ?? config.liquidatorAddress ?? config.targetAddress,
	)
	const role = resolveRoleHash(process.env.GRANT_ROLE ?? config.role ?? DEFAULT_ROLE)
	const chainId = await resolveChainId()
	const calldata = controlFacetIface.encodeFunctionData("grantRole", [liquidator, role.hash])

	console.log(`Network:       ${networkName}`)
	console.log(`Config suffix: ${networkSuffix}`)
	console.log(`Chain ID:      ${chainId}`)
	console.log(`Config:        ${grantConfigFile}${fs.existsSync(grantConfigFile) ? "" : " (not found, using fallbacks)"}`)
	console.log(`Diamond:       ${diamond}`)
	console.log(`Safe:          ${safe}`)
	console.log(`Liquidator:    ${liquidator}`)
	console.log(`Role:          ${role.display}`)
	console.log(`Role hash:     ${role.hash}`)
	console.log()

	const viewFacet = new ethers.Contract(diamond, viewFacetIface, ethers.provider)
	let alreadyGranted: boolean | undefined
	try {
		alreadyGranted = await viewFacet.hasRole(liquidator, role.hash)
		console.log(`Existing role: ${alreadyGranted ? "already granted" : "not granted"}`)
		if (alreadyGranted && process.env.SKIP_GRANTED === "1") {
			console.log("Nothing to grant because SKIP_GRANTED=1 and the role is already present.")
			return
		}
		console.log()
	} catch (error: any) {
		console.log(`Existing role check skipped: ${error?.message ?? error}`)
		console.log()
	}

	const safeTx = toHumanReadableSafeTxFromIface(controlFacetIface, diamond, "grantRole", [liquidator, role.hash])
	const serviceTx: SafeServiceTransaction = {
		to: diamond,
		value: "0",
		data: calldata,
		operation: 0,
	}
	const batch: SafeBatch = {
		version: "1.0",
		chainId,
		createdAt: Date.now(),
		meta: {
			name: "Symmio - grant liquidator role",
			description: `Grant ${role.display} to ${liquidator} on Symmio Diamond ${diamond}`,
			txBuilderVersion: "1.18.0",
			createdFromSafeAddress: safe,
			createdFromOwnerAddress: "",
		},
		transactions: [safeTx],
	}

	const chainOutputDir = path.join(OUTPUT_DIR, networkSuffix)
	ensureDir(chainOutputDir)
	const batchFile = path.join(chainOutputDir, "safe-batch.json")
	fs.writeFileSync(batchFile, JSON.stringify(batch, null, 2))
	console.log(`Wrote Safe batch to ${batchFile}`)

	const proposeToSafeService =
		process.env.PROPOSE_TO_SAFE_SERVICE !== undefined ? parseBool(process.env.PROPOSE_TO_SAFE_SERVICE) : proposalConfig.enabled === true
	const submitSafeProposal =
		process.env.SUBMIT_SAFE_PROPOSAL !== undefined
			? parseBool(process.env.SUBMIT_SAFE_PROPOSAL)
			: process.env.SAFE_PROPOSAL_SUBMIT !== undefined
				? parseBool(process.env.SAFE_PROPOSAL_SUBMIT)
				: proposalConfig.submit === true

	if (!proposeToSafeService) {
		console.log("Safe service proposal is disabled. Import the batch into Safe Transaction Builder when ready.")
		return
	}

	const safeServiceUrl = resolveSafeServiceUrl(chainId, networkSuffix, proposalConfig)
	if (!safeServiceUrl) {
		console.log(`No Safe Transaction Service URL mapping for network ${networkSuffix} / chain ${chainId}.`)
		console.log("Safe proposal simulation/submission is skipped. Import the generated batch into Safe Transaction Builder instead.")
		return
	}

	const senderAddress = resolveSenderAddress(proposalConfig)
	const apiKeyEnvVar = proposalConfig.apiKeyEnvVar ?? "SAFE_SERVICE_API_KEY"
	const apiKey = process.env.SAFE_SERVICE_API_KEY ?? process.env[apiKeyEnvVar] ?? proposalConfig.apiKey
	const safeContract = new ethers.Contract(safe, safeIface, ethers.provider)
	const nonceResolution = await resolveSafeNonce(safeContract, safeServiceUrl, safe, apiKey, proposalConfig.safeNonce)
	const safeNonce = nonceResolution.nonce

	console.log("Safe Transaction Service:")
	console.log(`  URL:                   ${normalizeServiceUrl(safeServiceUrl)}`)
	console.log(`  Sender:                ${senderAddress}`)
	console.log(`  Safe on-chain nonce:   ${nonceResolution.onChainNonce}`)
	console.log(
		`  Queued proposal nonces: ${nonceResolution.queuedNonces.length > 0 ? nonceResolution.queuedNonces.sort((a, b) => a - b).join(", ") : "(none)"}`,
	)
	console.log(`  Selected Safe nonce:   ${safeNonce} (${nonceResolution.source})`)

	console.log("\nChecking execution preflight from the Safe address...")
	const executionPreflight = await checkSafeExecutionPreflight(safe, diamond, calldata)
	if (executionPreflight.ok) console.log("Execution preflight passed.")
	else console.log(`Execution preflight failed: ${executionPreflight.reason ?? "unknown reason"}`)

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

	console.log("\nSimulating Safe transaction via Safe Transaction Service estimation...")
	const simulationResult = await estimateSafeTransaction(safeServiceUrl, safe, apiKey, serviceTx)
	const simulationStatus = getSafeSimulationStatus(simulationResult)
	if (simulationStatus.ok) console.log("Safe simulation passed.")
	else console.log(`Safe simulation failed: ${simulationStatus.reason ?? "unknown reason"}`)

	let submissionEligibility:
		| {
				ok: boolean
				reason?: string
				owners: string[]
				delegates: string[]
		  }
		| undefined
	if (submitSafeProposal) {
		const owners = ((await safeContract.getOwners()) as string[]).map(owner => ethers.getAddress(owner))
		let delegates: string[] = []
		try {
			delegates = await getSafeDelegates(safeServiceUrl, safe, apiKey)
		} catch (error: any) {
			console.log(`Could not read Safe delegates before submission: ${error?.message ?? error}`)
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
			console.log(`Safe proposal submission is skipped: ${submissionEligibility.reason}.`)
			console.log(`  Owners:    ${owners.join(", ")}`)
			console.log(`  Delegates: ${delegates.length > 0 ? delegates.join(", ") : "(none)"}`)
		}
	}

	const origin = process.env.SAFE_ORIGIN ?? proposalConfig.origin ?? `Symmio: grant ${role.display} to ${liquidator} on ${networkSuffix}`
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
	if (submitSafeProposal && submissionEligibility?.ok && executionPreflight.ok && simulationStatus.ok) {
		const signatureEnvVar = proposalConfig.signatureEnvVar ?? "SAFE_PROPOSAL_SIGNATURE"
		const configuredSignature = process.env[signatureEnvVar] ?? proposalConfig.signature
		let safeSignature: string
		if (configuredSignature) {
			safeSignature = configuredSignature
		} else {
			try {
				const senderSigner = await ethers.provider.getSigner(senderAddress)
				const signerAddress = ethers.getAddress(await senderSigner.getAddress())
				if (signerAddress !== senderAddress) {
					throw new Error(`Resolved signer ${signerAddress} does not match configured Safe proposal sender ${senderAddress}`)
				}
				const rawSignature = await senderSigner.signMessage(ethers.getBytes(safeTxHash))
				safeSignature = buildEthSignSafeSignature(rawSignature)
			} catch (error: any) {
				throw new Error(
					`Safe proposal sender ${senderAddress} is not available for signing. ` +
						"Load the matching private key as TEAM_PROPOSER in .env, or run " +
						"npx hardhat keystore set TEAM_PROPOSER and rerun with USE_KEYSTORE=true. " +
						`Original error: ${error?.message ?? error}`,
				)
			}
		}
		payload = {
			...proposalPreview,
			signature: safeSignature,
		}
	}

	const proposalFile = path.join(chainOutputDir, "safe-proposal.json")
	fs.writeFileSync(
		proposalFile,
		JSON.stringify(
			{
				network: networkName,
				networkSuffix,
				chainId,
				safe,
				diamond,
				liquidator,
				role,
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
				proposal: proposalPreview,
				payload,
			},
			null,
			2,
		),
	)
	console.log(`Wrote Safe proposal payload to ${proposalFile}`)

	if (!submitSafeProposal) {
		console.log("Safe proposal submission is skipped. Set SUBMIT_SAFE_PROPOSAL=1 from an environment that can sign as the Safe proposer.")
		return
	}
	if (!submissionEligibility?.ok || !executionPreflight.ok || !simulationStatus.ok) {
		console.log("Safe proposal submission is skipped because eligibility, preflight, or simulation did not pass.")
		return
	}
	if (!payload) throw new Error("Safe proposal payload was not built")

	console.log("\nSubmitting proposal to Safe Transaction Service...")
	const response = await submitSafeProposalToService(safeServiceUrl, safe, apiKey, payload)
	console.log("Safe proposal submitted successfully.")
	if (response !== undefined) console.log(JSON.stringify(response, null, 2))
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
