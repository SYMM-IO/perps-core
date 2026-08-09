/**
 * Generate a Safe multisig batch for ControlFacet.setMuonConfig(upnlValidTime, priceValidTime)
 * and optionally submit the same transaction to the Safe Transaction Service.
 *
 * Config resolution:
 *   1. MUON_CONFIG_FILE env override
 *   2. scripts/upgrade/config/muon/<network>.json
 *   3. scripts/upgrade/config/muon/default.json
 *
 * Address fallback:
 *   - diamondAddress and safeAddress fall back to upgrade-<network>.json via loadUpgradeConfigShared()
 *
 * Usage:
 *   ./node_modules/.bin/hardhat run scripts/upgrade/generateMuonConfigSafeBatch.ts --network arbitrum
 *
 * Optional env overrides:
 *   DIAMOND_ADDRESS, SAFE_ADDRESS,
 *   MUON_UPNL_VALID_TIME, MUON_PRICE_VALID_TIME,
 *   SAFE_NONCE,
 *   PROPOSE_TO_SAFE_SERVICE=1|0,
 *   SUBMIT_SAFE_PROPOSAL=true,
 *   CONFIRM_CHAIN_ID=<connected chain id>,
 *   CONFIRM_SAFE_ADDRESS=<exact Safe address>,
 *   SAFE_SERVICE_URL,
 *   SAFE_SERVICE_API_KEY,
 *   SAFE_SENDER_ADDRESS,
 *   SAFE_ORIGIN,
 *   TEAM_PROPOSER (private key loaded by hardhat.config.ts from .env or keystore)
 *
 * Outputs:
 *   scripts/upgrade/output/muon/<network>/safe-batch.json
 *   scripts/upgrade/output/muon/<network>/safe-proposal.json
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { requireSafeProposalConfirmation } from "./utils/executionGuard.js"
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
	multiSendAddress?: string
}

type MuonConfigFile = {
	diamondAddress?: string
	safeAddress?: string
	muonUpnlValidTime?: number | string
	muonPriceValidTime?: number | string
	grantMuonSetterRole?: boolean
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

type SafeServiceHeaders = Record<string, string>

type SafeSimulationStatus = {
	ok: boolean
	reason?: string
}

type SafeExecutionPreflightStatus = {
	ok: boolean
	checkedCall: "grantRole" | "setMuonConfig"
	reason?: string
	note?: string
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

const OUTPUT_DIR = "./scripts/upgrade/output"
const MUON_SETTER_ROLE = ethers.id("MUON_SETTER_ROLE")
const DEFAULT_SAFE_MULTISEND_CALL_ONLY_ADDRESS = "0x9641d764fc13c8b624c04430c7356c1c7c8102e2"
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
const viewFacetIface = new ethers.Interface(["function hasRole(address user, bytes32 role) view returns (bool)"])
const controlFacetIface = new ethers.Interface([
	"function grantRole(address user, bytes32 role)",
	"function setMuonConfig(uint256 upnlValidTime, uint256 priceValidTime)",
])
const multiSendIface = new ethers.Interface(["function multiSend(bytes transactions)"])
const safeIface = new ethers.Interface([
	"function nonce() view returns (uint256)",
	"function getOwners() view returns (address[])",
	"function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
])

function loadMuonConfig(networkSuffix: string | undefined): { file: string; config: MuonConfigFile } {
	const defaultFile = "./scripts/upgrade/config/muon/default.json"
	if (process.env.MUON_CONFIG_FILE) {
		const file = process.env.MUON_CONFIG_FILE
		if (!fs.existsSync(file)) {
			return { file, config: {} }
		}
		return { file, config: JSON.parse(fs.readFileSync(file, "utf-8")) as MuonConfigFile }
	}

	const networkFile = networkSuffix ? `./scripts/upgrade/config/muon/${networkSuffix}.json` : defaultFile
	const defaultConfig = fs.existsSync(defaultFile) ? (JSON.parse(fs.readFileSync(defaultFile, "utf-8")) as MuonConfigFile) : {}

	if (!networkSuffix || networkFile === defaultFile || !fs.existsSync(networkFile)) {
		return { file: networkFile, config: defaultConfig }
	}

	const networkConfig = JSON.parse(fs.readFileSync(networkFile, "utf-8")) as MuonConfigFile
	return {
		file: networkFile,
		config: {
			...defaultConfig,
			...networkConfig,
			safeProposal: {
				...(defaultConfig.safeProposal ?? defaultConfig.proposal ?? {}),
				...(networkConfig.safeProposal ?? networkConfig.proposal ?? {}),
			},
		},
	}
}

function parseRequiredSeconds(value: number | string | undefined, label: string): number {
	if (value === undefined || value === null || value === "") {
		throw new Error(`${label} is required`)
	}
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`${label} must be a non-negative integer, got ${JSON.stringify(value)}`)
	}
	return parsed
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

async function checkSafeExecutionPreflight(
	safe: string,
	diamond: string,
	includeGrantMuonSetterRole: boolean,
	grantMuonSetterRoleData: string,
	setMuonConfigData: string,
): Promise<SafeExecutionPreflightStatus> {
	const checkedCall = includeGrantMuonSetterRole ? "grantRole" : "setMuonConfig"
	const data = includeGrantMuonSetterRole ? grantMuonSetterRoleData : setMuonConfigData

	try {
		await ethers.provider.call({ from: safe, to: diamond, data })
		return {
			ok: true,
			checkedCall,
			note: includeGrantMuonSetterRole
				? "grantRole can be called from the Safe; setMuonConfig is expected to pass after the role is granted in the same batch."
				: undefined,
		}
	} catch (error: any) {
		return {
			ok: false,
			checkedCall,
			reason: summarizeCallError(error),
		}
	}
}

function encodeMultiSendTransactions(transactions: SafeServiceTransaction[]): string {
	return ethers.hexlify(
		ethers.concat(
			transactions.map(tx =>
				ethers.concat([
					ethers.toBeHex(tx.operation, 1),
					ethers.getBytes(ethers.getAddress(tx.to)),
					ethers.zeroPadValue(ethers.toBeHex(BigInt(tx.value)), 32),
					ethers.zeroPadValue(ethers.toBeHex(ethers.getBytes(tx.data).length), 32),
					ethers.getBytes(tx.data),
				]),
			),
		),
	)
}

function buildSafeServiceTransaction(transactions: SafeServiceTransaction[], proposalConfig: ProposalConfig): SafeServiceTransaction {
	if (transactions.length === 1) return transactions[0]

	const multiSendAddress = ethers.getAddress(proposalConfig.multiSendAddress ?? DEFAULT_SAFE_MULTISEND_CALL_ONLY_ADDRESS)
	return {
		to: multiSendAddress,
		value: "0",
		data: multiSendIface.encodeFunctionData("multiSend", [encodeMultiSendTransactions(transactions)]),
		operation: 1,
	}
}

async function main() {
	const networkName = connection.networkName
	const networkSuffix = baseNetworkName(networkName)
	const shared = loadUpgradeConfigShared(networkSuffix)
	const { file: muonConfigFile, config } = loadMuonConfig(networkSuffix)

	const chainId = String(Number((await ethers.provider.getNetwork()).chainId))
	const diamondRaw = process.env.DIAMOND_ADDRESS ?? config.diamondAddress ?? shared.diamondAddress
	const safeRaw = process.env.SAFE_ADDRESS ?? config.safeAddress ?? shared.safeAddress
	const upnlValidTime = parseRequiredSeconds(process.env.MUON_UPNL_VALID_TIME ?? config.muonUpnlValidTime ?? 60, "muonUpnlValidTime")
	const priceValidTime = parseRequiredSeconds(process.env.MUON_PRICE_VALID_TIME ?? config.muonPriceValidTime ?? 60, "muonPriceValidTime")

	if (!diamondRaw || !ethers.isAddress(diamondRaw)) {
		throw new Error("diamondAddress is required (muon config, upgrade config, or DIAMOND_ADDRESS env)")
	}
	if (!safeRaw || !ethers.isAddress(safeRaw)) {
		throw new Error("safeAddress is required (muon config, upgrade config, or SAFE_ADDRESS env)")
	}

	const diamond = ethers.getAddress(diamondRaw)
	const safe = ethers.getAddress(safeRaw)
	const grantMuonSetterRole = config.grantMuonSetterRole === true
	const grantMuonSetterRoleData = controlFacetIface.encodeFunctionData("grantRole", [safe, MUON_SETTER_ROLE])
	const setMuonConfigData = controlFacetIface.encodeFunctionData("setMuonConfig", [upnlValidTime, priceValidTime])

	console.log(`Network:          ${networkName}`)
	console.log(`Chain ID:         ${chainId}`)
	console.log(`Diamond:          ${diamond}`)
	console.log(`Safe:             ${safe}`)
	console.log(`UPNL valid time:  ${upnlValidTime}s`)
	console.log(`Price valid time: ${priceValidTime}s`)
	console.log(`Grant role:       ${grantMuonSetterRole ? "enabled if missing" : "disabled"}`)
	console.log(`Config:           ${muonConfigFile}${fs.existsSync(muonConfigFile) ? "" : " (not found, using fallbacks)"}`)
	console.log()

	const viewFacet = new ethers.Contract(diamond, viewFacetIface, ethers.provider)
	let hasMuonSetterRole: boolean | undefined
	try {
		hasMuonSetterRole = await viewFacet.hasRole(safe, MUON_SETTER_ROLE)
		if (!hasMuonSetterRole) {
			if (grantMuonSetterRole) {
				console.log(`  Safe ${safe} does NOT hold MUON_SETTER_ROLE on Diamond. Adding grantRole to this batch.`)
			} else {
				console.log(`  ⚠ Safe ${safe} does NOT hold MUON_SETTER_ROLE on Diamond — grant it before executing this batch.`)
			}
			console.log()
		}
	} catch {
		if (grantMuonSetterRole) {
			console.log("  ⚠ Could not verify MUON_SETTER_ROLE on the diamond. Adding grantRole because grantMuonSetterRole=true.")
		} else {
			console.log("  ⚠ Could not verify MUON_SETTER_ROLE on the diamond. Continuing with batch generation.")
		}
		console.log()
	}

	const includeGrantMuonSetterRole = grantMuonSetterRole && hasMuonSetterRole !== true
	const safeTxs = [
		...(includeGrantMuonSetterRole ? [toHumanReadableSafeTxFromIface(controlFacetIface, diamond, "grantRole", [safe, MUON_SETTER_ROLE])] : []),
		toHumanReadableSafeTxFromIface(controlFacetIface, diamond, "setMuonConfig", [upnlValidTime, priceValidTime]),
	]
	const serviceTransactions: SafeServiceTransaction[] = [
		...(includeGrantMuonSetterRole ? [{ to: diamond, value: "0", data: grantMuonSetterRoleData, operation: 0 }] : []),
		{ to: diamond, value: "0", data: setMuonConfigData, operation: 0 },
	]
	const batch: SafeBatch = {
		version: "1.0",
		chainId,
		createdAt: Date.now(),
		meta: {
			name: "Symmio — Set Muon Config",
			description: `${includeGrantMuonSetterRole ? "Grant MUON_SETTER_ROLE and set" : "Set"} Muon UPNL/price validity to ${upnlValidTime}s/${priceValidTime}s on ${diamond}`,
			txBuilderVersion: "1.18.0",
			createdFromSafeAddress: safe,
			createdFromOwnerAddress: "",
		},
		transactions: safeTxs,
	}

	const chainOutputDir = path.join(OUTPUT_DIR, "muon", networkSuffix ?? networkName)
	if (!fs.existsSync(chainOutputDir)) fs.mkdirSync(chainOutputDir, { recursive: true })
	const batchFile = path.join(chainOutputDir, "safe-batch.json")
	fs.writeFileSync(batchFile, JSON.stringify(batch, null, 2))
	console.log(`Wrote Safe batch to ${batchFile}`)

	const proposalConfig = config.safeProposal ?? config.proposal ?? {}
	const proposeToSafeService =
		process.env.PROPOSE_TO_SAFE_SERVICE !== undefined ? process.env.PROPOSE_TO_SAFE_SERVICE === "1" : proposalConfig.enabled === true
	const submitSafeProposal = requireSafeProposalConfirmation(BigInt(chainId), safe)
	if (proposalConfig.submit === true && !submitSafeProposal) {
		console.log("Config safeProposal.submit=true is informational only; this run will not submit without the explicit Safe submission interlocks.")
	}

	if (!proposeToSafeService) {
		console.log("\nSafe service proposal is disabled. Import the batch into Safe Transaction Builder when ready.")
		return
	}

	const safeServiceUrl = resolveSafeServiceUrl(chainId, networkSuffix, proposalConfig)
	if (!safeServiceUrl) {
		console.log(
			`\nSafe service proposal is enabled, but no Safe Transaction Service URL mapping exists for network ${networkName} / chain ${chainId}.`,
		)
		console.log("Safe proposal simulation/submission is skipped. Import the generated batch into Safe Transaction Builder instead.")
		console.log("If a custom Safe Transaction Service exists for this chain, set safeProposal.safeServiceUrl in the chain config.")
		return
	}

	const configuredSender = process.env.SAFE_SENDER_ADDRESS ?? proposalConfig.senderAddress
	const senderAddress = configuredSender ? ethers.getAddress(configuredSender) : ethers.getAddress((await ethers.provider.getSigner()).address)
	const apiKeyEnvVar = proposalConfig.apiKeyEnvVar ?? "SAFE_SERVICE_API_KEY"
	const apiKey = process.env.SAFE_SERVICE_API_KEY ?? process.env[apiKeyEnvVar] ?? proposalConfig.apiKey

	const safeContract = new ethers.Contract(safe, safeIface, ethers.provider)
	const nonceResolution = await resolveSafeNonce(
		safeContract as unknown as { nonce(): Promise<bigint> },
		safeServiceUrl,
		safe,
		apiKey,
		proposalConfig.safeNonce,
	)
	const safeNonce = nonceResolution.nonce
	console.log(`Safe on-chain nonce:       ${nonceResolution.onChainNonce}`)
	console.log(
		`Safe queued proposal nonces: ${nonceResolution.queuedNonces.length > 0 ? nonceResolution.queuedNonces.sort((a, b) => a - b).join(", ") : "(none)"}`,
	)
	console.log(`Selected Safe nonce:       ${safeNonce} (${nonceResolution.source})`)

	const origin = process.env.SAFE_ORIGIN ?? proposalConfig.origin ?? `Symmio: setMuonConfig(${upnlValidTime}, ${priceValidTime}) on ${networkName}`
	const serviceTx = buildSafeServiceTransaction(serviceTransactions, proposalConfig)
	if (serviceTransactions.length > 1) {
		console.log(`Safe proposal batch:       ${serviceTransactions.length} calls via MultiSend ${serviceTx.to}`)
	}

	console.log("\nChecking execution preflight from the Safe address:")
	const executionPreflight = await checkSafeExecutionPreflight(safe, diamond, includeGrantMuonSetterRole, grantMuonSetterRoleData, setMuonConfigData)
	if (executionPreflight.ok) {
		console.log(`Execution preflight passed (${executionPreflight.checkedCall}).`)
		if (executionPreflight.note) console.log(executionPreflight.note)
	} else {
		console.log(`Execution preflight failed (${executionPreflight.checkedCall}): ${executionPreflight.reason ?? "unknown reason"}`)
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

	console.log("\nSimulating Safe transaction via Safe Transaction Service estimation:")
	const simulationResult = await estimateSafeTransaction(safeServiceUrl, safe, apiKey, serviceTx)
	console.log(JSON.stringify(simulationResult, null, 2))
	const simulationStatus = getSafeSimulationStatus(simulationResult)
	if (!simulationStatus.ok) {
		console.log(`\nSafe simulation failed: ${simulationStatus.reason ?? "unknown reason"}`)
	} else {
		console.log("\nSafe simulation passed.")
	}

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
			console.log(`\nCould not read Safe delegates before submission: ${error.message ?? error}`)
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
			console.log(`\nSafe proposal submission is skipped: ${submissionEligibility.reason}.`)
			console.log(`  Sender:    ${senderAddress}`)
			console.log(`  Owners:    ${owners.join(", ")}`)
			console.log(`  Delegates: ${delegates.length > 0 ? delegates.join(", ") : "(none)"}`)
		}
	}

	const signatureEnvVar = proposalConfig.signatureEnvVar ?? "SAFE_PROPOSAL_SIGNATURE"
	const configuredSignature = process.env[signatureEnvVar] ?? proposalConfig.signature
	let payload: SafeProposalPayload | undefined
	if (submitSafeProposal && submissionEligibility?.ok && executionPreflight.ok) {
		let safeSignature: string
		if (configuredSignature) {
			safeSignature = configuredSignature
		} else {
			try {
				const senderSigner = configuredSender ? await ethers.provider.getSigner(configuredSender) : await ethers.provider.getSigner()
				const signerAddress = ethers.getAddress(await senderSigner.getAddress())
				if (signerAddress !== senderAddress) {
					throw new Error(`Resolved signer ${signerAddress} does not match configured Safe proposal sender ${senderAddress}`)
				}

				// Safe supports eth_sign signatures by storing v + 4.
				const rawSignature = await senderSigner.signMessage(ethers.getBytes(safeTxHash))
				safeSignature = buildEthSignSafeSignature(rawSignature)
			} catch (error: any) {
				throw new Error(
					`Safe proposal sender ${senderAddress} is not available for signing. ` +
						`Load the matching private key as TEAM_PROPOSER in .env, or run ` +
						`./node_modules/.bin/hardhat keystore set TEAM_PROPOSER and rerun with USE_KEYSTORE=true. ` +
						`Original error: ${error?.message ?? error}`,
				)
			}
		}
		payload = {
			...serviceTx,
			safeTxGas: 0,
			baseGas: 0,
			gasPrice: "0",
			gasToken: null,
			refundReceiver: null,
			nonce: safeNonce,
			contractTransactionHash: safeTxHash,
			sender: senderAddress,
			signature: safeSignature,
			origin,
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

	const proposalFile = path.join(chainOutputDir, "safe-proposal.json")
	fs.writeFileSync(
		proposalFile,
		JSON.stringify(
			{
				network: networkName,
				chainId,
				safe,
				diamond,
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

	if (!simulationStatus.ok) {
		console.log("\nSafe proposal submission is skipped because simulation did not pass.")
		return
	}
	if (!executionPreflight.ok) {
		console.log("\nSafe proposal submission is skipped because execution preflight did not pass.")
		return
	}

	if (!submitSafeProposal) {
		console.log(
			`\nSafe proposal submission is skipped. To submit, set SUBMIT_SAFE_PROPOSAL=true CONFIRM_CHAIN_ID=${chainId} CONFIRM_SAFE_ADDRESS=${safe}.`,
		)
		return
	}
	if (!submissionEligibility?.ok) {
		return
	}
	if (!payload) {
		throw new Error("Safe proposal payload was not built")
	}

	const endpoint = `${normalizeServiceUrl(safeServiceUrl)}/safes/${safe}/multisig-transactions/`
	const headers = buildSafeServiceHeaders(apiKey)

	console.log(`\nSubmitting proposal to Safe Transaction Service:`)
	console.log(`  URL:    ${endpoint}`)
	console.log(`  Sender: ${senderAddress}`)
	console.log(`  Nonce:  ${safeNonce}`)
	console.log(`  Hash:   ${safeTxHash}`)

	const response = await fetch(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
	})

	const responseText = await response.text()
	if (!response.ok) {
		throw new Error(`Safe proposal failed (${response.status} ${response.statusText}): ${responseText}`)
	}

	console.log("\nSafe proposal submitted successfully.")
	if (responseText.trim()) {
		console.log(responseText)
	}
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
