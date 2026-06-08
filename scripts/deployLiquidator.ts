import fs from "fs"
import { tasks } from "hardhat"
import { configVariable } from "hardhat/config"
import path from "path"
import { stdin as input, stdout as output } from "process"
import { createInterface } from "readline/promises"

import { getUpgradeAddresses } from "../tasks/deploy/helpers.js"
import { setHyperEVMBigBlocks } from "../tasks/deploy/hyperevm.js"
// Initialize the hardhat connection
import connection, { hre, ethers } from "../test/helpers/hardhat-connection.js"
import { toHumanReadableSafeTxFromIface, type SafeBatch, type SafeTransaction } from "./upgrade/utils/upgradeHelpers.js"

const HYPEREVM_CHAIN_IDS = new Set<bigint>([998n, 999n])
const DEFAULT_SAFE_TX_CREATOR_ADDRESS = "0x8A82bCDB72FFA4181a81C13d434AaCB59E7f327F"
const SAFE_SERVICE_SLUG_BY_CHAIN_ID: Record<string, string> = {
	"1": "mainnet",
	"56": "bnb",
	"146": "sonic",
	"999": "hyper",
	"5000": "mantle",
	"8453": "base",
	"42161": "arb1",
	"80094": "berachain",
	"9745": "plasma",
}

const chainId = (await ethers.provider.getNetwork()).chainId
const networkName = connection.networkName || `chain-${chainId}`
const outputSuffix = (process.env.LIQUIDATOR_OUTPUT_SUFFIX || networkName).replace(/[^a-zA-Z0-9_-]/g, "-")
const outputDir = process.env.LIQUIDATOR_OUTPUT_DIR || "scripts/output"
const reportFile = path.join(outputDir, `deploy-liquidator-report-${outputSuffix}.json`)
const liquidatorDeploymentFile = path.join(outputDir, `deploy-liquidator-deployment-${outputSuffix}.json`)
const coreRolesSafeBatchFile = path.join(outputDir, `deploy-liquidator-core-roles-safe-batch-${outputSuffix}.json`)
const coreRolesSafeProposalFile = path.join(outputDir, `deploy-liquidator-core-roles-safe-proposal-${outputSuffix}.json`)
const liquidatorConfigFile = process.env.LIQUIDATOR_CONFIG_FILE || path.join(outputDir, `deploy-liquidator-config-${outputSuffix}.json`)
const loadedLiquidatorConfig = fs.existsSync(liquidatorConfigFile)
const loadedPreviousReport = fs.existsSync(reportFile)
const loadedPreviousDeployment = fs.existsSync(liquidatorDeploymentFile)
const liquidatorConfig = loadOptionalJson(liquidatorConfigFile)
const previousReport = loadOptionalJson(reportFile)
const previousDeployment = loadOptionalJson(liquidatorDeploymentFile)

const symmioAddressRaw = firstString(
	process.env.SYMMIO_ADDRESS,
	liquidatorConfig.symmioAddress,
	liquidatorConfig.symmioCore,
	liquidatorConfig.addresses?.symmioCore,
	previousReport.addresses?.symmioCore,
)
const adminRaw = firstString(
	process.env.ADMIN_PUBLIC_KEY,
	liquidatorConfig.adminPublicKey,
	liquidatorConfig.admin,
	liquidatorConfig.finalAdmin,
	liquidatorConfig.addresses?.finalAdmin,
	previousReport.addresses?.finalAdmin,
)
const operatorsEnv =
	firstString(process.env.OPERATORS, operatorsToEnv(liquidatorConfig.operators), operatorsToEnv(previousReport.config?.operators)) || ""
const reuseLiquidator = process.env.REUSE_LIQUIDATOR === "true"
const existingLiquidatorAddress =
	firstString(
		process.env.LIQUIDATOR_ADDRESS,
		process.env.SYMMIO_LIQUIDATOR_ADDRESS,
		liquidatorConfig.liquidatorAddress,
		liquidatorConfig.symmioLiquidator,
		liquidatorConfig.addresses?.symmioLiquidator,
		previousReport.addresses?.symmioLiquidator,
		findDeploymentAddress(previousDeployment, "SymmioLiquidatorProxy"),
	) || ""
const submitSafeProposal = /^(1|true|yes)$/i.test(process.env.SUBMIT_SAFE_PROPOSAL || "")
const skipSafeSubmissionConfirmation = /^(1|true|yes)$/i.test(process.env.SKIP_SAFE_SUBMISSION_CONFIRMATION || "")
const safeNonceOverrideRaw = firstString(process.env.SAFE_NONCE, process.env.SAFE_TX_NONCE)
const safeNonceOverride = safeNonceOverrideRaw ? parseSafeNonceOverride(safeNonceOverrideRaw) : undefined
const safeServiceUrlOverride = process.env.SAFE_SERVICE_URL || ""
const safeSubmitterKeyName =
	process.env.SAFE_SUBMITTER_KEY_NAME || process.env.SAFE_SIGNER_KEY_NAME || process.env.SAFE_PROPOSER_KEY_NAME || "TEAM_PROPOSER"
const safeSubmitterPrivateKey =
	process.env.SAFE_SUBMITTER_PRIVATE_KEY ||
	process.env.SAFE_SIGNER_PRIVATE_KEY ||
	process.env.SAFE_PROPOSER_PRIVATE_KEY ||
	process.env.TEAM_PROPOSER ||
	""
const coreAdminSafeAddressRaw =
	firstString(
		process.env.CORE_ADMIN_SAFE_ADDRESS,
		process.env.SAFE_ADDRESS,
		liquidatorConfig.coreAdminSafeAddress,
		liquidatorConfig.coreAdminSafe,
		liquidatorConfig.safeAddress,
		liquidatorConfig.addresses?.coreAdminSafe,
		previousReport.addresses?.coreAdminSafe,
	) || ""
const safeTxCreatorAddress = ethers.getAddress(
	firstString(
		process.env.SAFE_TX_CREATOR_ADDRESS,
		process.env.SAFE_PROPOSER_ADDRESS,
		process.env.TEAM_PROPOSER_ADDRESS,
		liquidatorConfig.safeTxCreatorAddress,
		liquidatorConfig.safeTxCreator,
		liquidatorConfig.safeProposerAddress,
		liquidatorConfig.safeProposer,
		liquidatorConfig.addresses?.safeTxCreator,
		liquidatorConfig.addresses?.safeProposer,
		previousReport.addresses?.safeTxCreator,
		previousReport.addresses?.safeProposer,
		DEFAULT_SAFE_TX_CREATOR_ADDRESS,
	)!,
)
const safeSubmitterAddressRaw =
	firstString(
		process.env.SAFE_SUBMITTER_ADDRESS,
		process.env.SAFE_SIGNER_ADDRESS,
		liquidatorConfig.safeSubmitterAddress,
		liquidatorConfig.safeSubmitter,
		liquidatorConfig.safeSignerAddress,
		liquidatorConfig.safeSigner,
		liquidatorConfig.addresses?.safeSubmitter,
		liquidatorConfig.addresses?.safeSigner,
		previousReport.addresses?.safeSubmitter,
		previousReport.addresses?.safeSigner,
		safeTxCreatorAddress,
	) || ""
const safeMultiSendAddressRaw =
	firstString(
		process.env.SAFE_MULTISEND_ADDRESS,
		liquidatorConfig.safeMultiSendAddress,
		liquidatorConfig.multiSendAddress,
		liquidatorConfig.addresses?.safeMultiSend,
		previousReport.addresses?.safeMultiSend,
	) || ""

if (!symmioAddressRaw) throw new Error(`Missing SYMMIO_ADDRESS env var or symmioCore in ${liquidatorConfigFile}/${reportFile}`)
if (!adminRaw) throw new Error(`Missing ADMIN_PUBLIC_KEY env var or finalAdmin in ${liquidatorConfigFile}/${reportFile}`)
if (reuseLiquidator && !existingLiquidatorAddress) {
	throw new Error(`REUSE_LIQUIDATOR=true requires LIQUIDATOR_ADDRESS env var or SymmioLiquidatorProxy in ${liquidatorDeploymentFile}/${reportFile}`)
}

const symmioAddress = ethers.getAddress(symmioAddressRaw)
const admin = ethers.getAddress(adminRaw)
const coreAdminSafeAddress = coreAdminSafeAddressRaw ? ethers.getAddress(coreAdminSafeAddressRaw) : ""
const safeSubmitterAddress = safeSubmitterAddressRaw ? ethers.getAddress(safeSubmitterAddressRaw) : ""
const safeMultiSendAddress = safeMultiSendAddressRaw ? ethers.getAddress(safeMultiSendAddressRaw) : ""
const directCoreRoleGrantsEnabled =
	process.env.ALLOW_DIRECT_CORE_ROLE_GRANTS === undefined ? !coreAdminSafeAddress : /^(1|true|yes)$/i.test(process.env.ALLOW_DIRECT_CORE_ROLE_GRANTS)

const operators = operatorsEnv
	.split(",")
	.map(a => a.trim())
	.filter(Boolean)

function getErrorMessage(err: any): string {
	return err?.shortMessage || err?.reason || err?.message?.split("\n")[0] || String(err)
}

const [deployer] = await ethers.getSigners()
const deployerAddress = deployer.address
const finalAdmin = admin
const shouldUseTemporaryAdmin = !reuseLiquidator && operators.length > 0 && deployerAddress.toLowerCase() !== finalAdmin.toLowerCase()
const initialAdmin = shouldUseTemporaryAdmin ? deployerAddress : finalAdmin
const coreRoles = [
	["LIQUIDATOR_ROLE", ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATOR_ROLE"))],
	["PARTYB_LIQUIDATOR_ROLE", ethers.keccak256(ethers.toUtf8Bytes("PARTYB_LIQUIDATOR_ROLE"))],
] as const
const DEFAULT_ADMIN_ROLE_HASH = ethers.keccak256(ethers.toUtf8Bytes("DEFAULT_ADMIN_ROLE"))
const coreRoleIface = new ethers.Interface(["function grantRole(address user, bytes32 role)"])
const multiSendIface = new ethers.Interface(["function multiSend(bytes transactions)"])
const coreViewAbi = [
	"function owner() view returns (address)",
	"function pendingOwner() view returns (address)",
	"function hasRole(address user, bytes32 role) view returns (bool)",
	"function isRoleAdmin(address user, bytes32 role) view returns (bool)",
]
const safeIface = new ethers.Interface([
	"function nonce() view returns (uint256)",
	"function getOwners() view returns (address[])",
	"function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce) view returns (bytes32)",
])
const SAFE_TX_TYPES = {
	SafeTx: [
		{ name: "to", type: "address" },
		{ name: "value", type: "uint256" },
		{ name: "data", type: "bytes" },
		{ name: "operation", type: "uint8" },
		{ name: "safeTxGas", type: "uint256" },
		{ name: "baseGas", type: "uint256" },
		{ name: "gasPrice", type: "uint256" },
		{ name: "gasToken", type: "address" },
		{ name: "refundReceiver", type: "address" },
		{ name: "nonce", type: "uint256" },
	],
}
const isHyperEVM = HYPEREVM_CHAIN_IDS.has(chainId)
const shouldToggleHyperEVMBigBlocks = isHyperEVM && !reuseLiquidator

function loadOptionalJson(file: string): any {
	if (!fs.existsSync(file)) return {}
	return JSON.parse(fs.readFileSync(file, "utf8"))
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) return value.trim()
	}
	return undefined
}

function parseSafeNonceOverride(value: string): number {
	try {
		const parsed = BigInt(value)
		if (parsed < 0n) throw new Error("must be non-negative")
		if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`must be <= ${Number.MAX_SAFE_INTEGER}`)
		return Number(parsed)
	} catch (err: any) {
		throw new Error(`Invalid SAFE_NONCE/SAFE_TX_NONCE value '${value}': ${err.message || String(err)}`)
	}
}

function operatorsToEnv(value: unknown): string | undefined {
	if (Array.isArray(value))
		return value
			.map(v => String(v).trim())
			.filter(Boolean)
			.join(",")
	if (typeof value === "string" && value.trim()) return value.trim()
	return undefined
}

function findDeploymentAddress(deployment: unknown, name: string): string | undefined {
	if (!Array.isArray(deployment)) return undefined
	const entry = deployment.find(item => item?.name === name && typeof item?.address === "string")
	return entry?.address
}

function writeReport(report: object): void {
	fs.mkdirSync(outputDir, { recursive: true })
	fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
}

function writeJson(file: string, data: object): void {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

async function writeLiquidatorDeploymentOutput(liquidator: any, initializerAdmin: string) {
	const proxy = await liquidator.getAddress()
	const upgradeAddresses: { implementation?: string; admin?: string } = await getUpgradeAddresses((hre as any).upgrades, liquidator).catch(
		(err: any) => {
			console.log(`  ⚠ Could not resolve liquidator implementation/admin addresses: ${getErrorMessage(err)}`)
			return {}
		},
	)
	const entries: Array<{ name: string; address: string; constructorArguments: any[] }> = [
		{
			name: "SymmioLiquidatorProxy",
			address: proxy,
			constructorArguments: [initializerAdmin, symmioAddress],
		},
	]
	if (upgradeAddresses.implementation) {
		entries.push({ name: "SymmioLiquidatorImplementation", address: upgradeAddresses.implementation, constructorArguments: [] })
	}
	if (upgradeAddresses.admin) {
		entries.push({ name: "SymmioLiquidatorAdmin", address: upgradeAddresses.admin, constructorArguments: [] })
	}
	writeJson(liquidatorDeploymentFile, entries)
	return {
		file: liquidatorDeploymentFile,
		proxy,
		implementation: upgradeAddresses.implementation,
		admin: upgradeAddresses.admin,
	}
}

function getSafeServiceUrl(): string {
	if (safeServiceUrlOverride) return safeServiceUrlOverride.replace(/\/$/, "")
	const slug = SAFE_SERVICE_SLUG_BY_CHAIN_ID[chainId.toString()]
	if (!slug) throw new Error(`No Safe Transaction Service slug configured for chainId ${chainId}; set SAFE_SERVICE_URL`)
	return `https://api.safe.global/tx-service/${slug}/api/v1`
}

function getOptionalSafeServiceUrl(): string | undefined {
	if (safeServiceUrlOverride) return safeServiceUrlOverride.replace(/\/$/, "")
	const slug = SAFE_SERVICE_SLUG_BY_CHAIN_ID[chainId.toString()]
	return slug ? `https://api.safe.global/tx-service/${slug}/api/v1` : undefined
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, {
		...init,
		headers: {
			"Content-Type": "application/json",
			...(init?.headers || {}),
		},
	})
	if (!response.ok) {
		const body = await response.text().catch(() => "")
		throw new Error(`${response.status} ${response.statusText}${body ? `: ${body}` : ""}`)
	}
	return (await response.json()) as T
}

async function resolveConfigVar(name: string): Promise<string> {
	const variable = configVariable(name)
	return (hre as any).hooks.runHandlerChain("configurationVariables", "fetchValue", [variable], async (_ctx: unknown, v: { name: string }) => {
		const value = process.env[v.name]
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(`Configuration variable '${v.name}' is not set`)
		}
		return value
	})
}

async function getSafeSubmitterSigner() {
	if (!safeSubmitterAddress) {
		throw new Error("Safe Transaction Service sender address is missing")
	}

	const signers = await ethers.getSigners()
	for (const signer of signers) {
		const address = ethers.getAddress(await signer.getAddress())
		if (address.toLowerCase() === safeSubmitterAddress.toLowerCase()) return signer
	}

	const privateKey = safeSubmitterPrivateKey || (await resolveConfigVar(safeSubmitterKeyName))
	const wallet = new ethers.Wallet(privateKey, ethers.provider)
	if (wallet.address.toLowerCase() !== safeSubmitterAddress.toLowerCase()) {
		throw new Error(`Loaded Safe service sender ${wallet.address}, but expected ${safeSubmitterAddress}`)
	}
	return wallet
}

type SafeQueuedTransaction = {
	nonce?: number
	to?: string
	data?: string | null
	operation?: number
	safeTxHash?: string
	contractTransactionHash?: string
}

type SafeInfo = {
	nonce?: number
	owners?: string[]
}

type DelegateInfo = {
	delegate?: string
	delegator?: string
}

type SafeDelegatesResult = {
	delegates: string[]
	fetched: boolean
	error?: string
	skippedReason?: string
}

type CoreRoleTx = {
	roleName: string
	roleHash: string
	safeTx: SafeTransaction
}

type HumanReadableCoreRoleCall = {
	roleName: string
	roleHash: string
	to: string
	value: string
	operation: number
	method: string
	contractMethod?: SafeTransaction["contractMethod"]
	contractInputsValues?: SafeTransaction["contractInputsValues"]
	user?: string
	role?: string
	data: string
}

function describeCoreRoleCall(tx: CoreRoleTx): HumanReadableCoreRoleCall {
	return {
		roleName: tx.roleName,
		roleHash: tx.roleHash,
		to: tx.safeTx.to,
		value: tx.safeTx.value,
		operation: 0,
		method: "grantRole",
		contractMethod: tx.safeTx.contractMethod,
		contractInputsValues: tx.safeTx.contractInputsValues,
		user: tx.safeTx.contractInputsValues?.user,
		role: tx.safeTx.contractInputsValues?.role,
		data: tx.safeTx.data,
	}
}

function encodeMultiSendTransactions(transactions: SafeTransaction[]): string {
	return ethers.concat(
		transactions.map(tx => {
			const data = ethers.getBytes(tx.data)
			return ethers.solidityPacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, tx.to, BigInt(tx.value), BigInt(data.length), tx.data])
		}),
	)
}

function buildSafeProposalTx(coreRoleTxs: CoreRoleTx[]): { to: string; value: string; data: string; operation: number; multiSendData?: string } {
	if (coreRoleTxs.length === 1) {
		const tx = coreRoleTxs[0].safeTx
		return { to: tx.to, value: tx.value, data: tx.data, operation: 0 }
	}
	if (!safeMultiSendAddress) {
		throw new Error("SAFE_MULTISEND_ADDRESS is required to submit multiple missing core role grants in one Safe transaction")
	}

	const multiSendData = encodeMultiSendTransactions(coreRoleTxs.map(tx => tx.safeTx))
	return {
		to: safeMultiSendAddress,
		value: "0",
		data: multiSendIface.encodeFunctionData("multiSend", [multiSendData]),
		operation: 1,
		multiSendData,
	}
}

function buildProposalDataDecoded(
	proposalTx: { to: string; value: string; data: string; operation: number; multiSendData?: string },
	humanReadableCalls: HumanReadableCoreRoleCall[],
) {
	if (proposalTx.operation === 1) {
		return {
			method: "multiSend",
			target: proposalTx.to,
			operation: describeSafeOperation(proposalTx.operation),
			transactionsData: proposalTx.multiSendData,
			innerTransactions: humanReadableCalls.map(call => ({
				to: call.to,
				value: call.value,
				operation: describeSafeOperation(call.operation),
				method: call.method,
				inputs: {
					user: call.user,
					role: call.role,
				},
				calldata: call.data,
			})),
		}
	}

	const call = humanReadableCalls[0]
	return {
		method: call.method,
		target: proposalTx.to,
		operation: describeSafeOperation(proposalTx.operation),
		inputs: {
			user: call.user,
			role: call.role,
		},
		calldata: proposalTx.data,
	}
}

async function getSafeOnChainInfo() {
	const safe = new ethers.Contract(coreAdminSafeAddress, safeIface, ethers.provider)
	const [nonce, owners] = await Promise.all([safe.nonce(), safe.getOwners()])
	return {
		nonce: Number(nonce),
		owners: (owners as string[]).map(owner => ethers.getAddress(owner)),
	}
}

async function getSafeServiceInfo(serviceUrl: string): Promise<SafeInfo | undefined> {
	try {
		return await fetchJson<SafeInfo>(`${serviceUrl}/safes/${coreAdminSafeAddress}/`)
	} catch (err) {
		console.log(`  ⚠ Could not fetch Safe info from service: ${getErrorMessage(err)}`)
		return undefined
	}
}

async function getQueuedSafeTransactions(serviceUrl: string): Promise<SafeQueuedTransaction[]> {
	try {
		const response = await fetchJson<{ results?: SafeQueuedTransaction[] }>(
			`${serviceUrl}/safes/${coreAdminSafeAddress}/multisig-transactions/?executed=false&trusted=true&limit=100`,
		)
		return response.results || []
	} catch (err) {
		console.log(`  ⚠ Could not fetch queued Safe transactions: ${getErrorMessage(err)}`)
		return []
	}
}

async function getSafeDelegates(serviceUrl: string): Promise<SafeDelegatesResult> {
	try {
		const response = await fetchJson<{ results?: DelegateInfo[] }>(`${serviceUrl}/delegates/?safe=${coreAdminSafeAddress}&limit=100`)
		const delegates = (response.results || [])
			.map(delegate => delegate.delegate)
			.filter((delegate): delegate is string => Boolean(delegate))
			.map(delegate => ethers.getAddress(delegate))
		return { delegates, fetched: true }
	} catch (err) {
		const error = getErrorMessage(err)
		console.log(`  ⚠ Could not fetch Safe delegates: ${error}`)
		return { delegates: [], fetched: false, error }
	}
}

function resolveSafeNonce(
	onChainNonce: number,
	queuedTransactions: SafeQueuedTransaction[],
	requestedNonce?: number,
): { nonce: number; queuedNonces: number[]; source: string; override?: number; warnings: string[] } {
	const queuedNonces = queuedTransactions
		.map(tx => tx.nonce)
		.filter((nonce): nonce is number => typeof nonce === "number")
		.sort((a, b) => a - b)
	const queuedSet = new Set(queuedNonces)
	const warnings: string[] = []

	if (requestedNonce !== undefined) {
		if (requestedNonce < onChainNonce) {
			warnings.push(`Requested Safe nonce ${requestedNonce} is lower than on-chain Safe nonce ${onChainNonce}`)
		}
		if (queuedSet.has(requestedNonce)) {
			warnings.push(`Requested Safe nonce ${requestedNonce} is already used by at least one queued Safe transaction`)
		}
		return { nonce: requestedNonce, queuedNonces, source: "env-override", override: requestedNonce, warnings }
	}

	let nonce = onChainNonce
	while (queuedSet.has(nonce)) nonce++
	return { nonce, queuedNonces, source: nonce === onChainNonce ? "onchain" : "first-unqueued", warnings }
}

function findMatchingQueuedProposal(
	queuedTransactions: SafeQueuedTransaction[],
	proposalTx: { to: string; data: string; operation: number },
	requestedNonce?: number,
) {
	return queuedTransactions.find(tx => {
		if (!tx.to || !tx.data) return false
		if (requestedNonce !== undefined && tx.nonce !== requestedNonce) return false
		return (
			ethers.getAddress(tx.to).toLowerCase() === proposalTx.to.toLowerCase() &&
			tx.data.toLowerCase() === proposalTx.data.toLowerCase() &&
			Number(tx.operation ?? 0) === proposalTx.operation
		)
	})
}

async function preflightCoreRoleSafeCalls(coreRoleTxs: CoreRoleTx[]) {
	const checks: { roleName: string; ok: boolean; reason?: string }[] = []
	for (const tx of coreRoleTxs) {
		try {
			await ethers.provider.call({
				from: coreAdminSafeAddress,
				to: tx.safeTx.to,
				data: tx.safeTx.data,
				value: 0n,
			})
			checks.push({ roleName: tx.roleName, ok: true })
		} catch (err) {
			checks.push({ roleName: tx.roleName, ok: false, reason: getErrorMessage(err) })
		}
	}
	return {
		ok: checks.every(check => check.ok),
		checks,
	}
}

async function getCoreAdminSafeReadiness(coreRoleTxs: CoreRoleTx[]) {
	const coreView = new ethers.Contract(symmioAddress, coreViewAbi, ethers.provider)
	const [coreOwnerRaw, corePendingOwnerRaw, coreAdminSafeHasDefaultAdminRole, roleAdminChecks] = await Promise.all([
		coreView.owner().catch(() => undefined),
		coreView.pendingOwner().catch(() => undefined),
		coreAdminSafeAddress ? coreView.hasRole(coreAdminSafeAddress, DEFAULT_ADMIN_ROLE_HASH).catch(() => false) : false,
		Promise.all(
			coreRoleTxs.map(async tx => ({
				roleName: tx.roleName,
				roleHash: tx.roleHash,
				isRoleAdmin: coreAdminSafeAddress ? await coreView.isRoleAdmin(coreAdminSafeAddress, tx.roleHash).catch(() => false) : false,
			})),
		),
	])
	const coreOwner = coreOwnerRaw ? ethers.getAddress(coreOwnerRaw) : undefined
	const corePendingOwner = corePendingOwnerRaw ? ethers.getAddress(corePendingOwnerRaw) : undefined
	const canGrantAllMissingRoles = roleAdminChecks.every(check => check.isRoleAdmin)

	return {
		coreOwner,
		corePendingOwner,
		coreAdminSafeHasDefaultAdminRole,
		roleAdminChecks,
		canGrantAllMissingRoles,
		desiredCoreRoleGrants: coreRoleTxs.map(tx => tx.safeTx),
	}
}

function buildSafeProposalReadiness(proposalReport: any | undefined) {
	if (!proposalReport) return undefined

	const blockingReasons: string[] = []
	const warnings: string[] = []
	const requiredBeforeSubmission: string[] = []
	const coreReadiness = proposalReport.coreAdminSafeReadiness
	const submissionEligibility = proposalReport.submissionEligibility

	if (proposalReport.executionPreflight && !proposalReport.executionPreflight.ok) {
		blockingReasons.push("Execution preflight failed for the desired grantRole(proxy, role) call(s); Safe execution would revert")
		requiredBeforeSubmission.push("Fix the Symmio core role-admin signer/Safe before submitting this Safe proposal")
	}
	if (coreReadiness && !coreReadiness.canGrantAllMissingRoles) {
		blockingReasons.push(`${coreAdminSafeAddress} is not currently a role admin for all missing liquidator roles on Symmio core ${symmioAddress}`)
		requiredBeforeSubmission.push(`Verify ${coreAdminSafeAddress} is the Safe that should create this proposal for Symmio core ${symmioAddress}`)
	}
	if (submissionEligibility?.requested && !submissionEligibility.ok) {
		warnings.push(submissionEligibility.reason || "Safe service submitter may not be accepted by the Safe Transaction Service")
		if (submissionEligibility.submitterAddress) {
			requiredBeforeSubmission.push(
				`Confirm ${submissionEligibility.submitterAddress} is allowed to create Safe Transaction Service proposals for ${coreAdminSafeAddress}`,
			)
		} else {
			blockingReasons.push("Safe Transaction Service sender address is not configured")
			requiredBeforeSubmission.push("Set SAFE_TX_CREATOR_ADDRESS/SAFE_PROPOSER_ADDRESS or import the Safe batch/proposal manually")
		}
	}

	return {
		ready: blockingReasons.length === 0,
		blockingReasons,
		warnings,
		requiredBeforeSubmission,
		desiredCoreRoleGrants: coreReadiness?.desiredCoreRoleGrants,
	}
}

function describeSafeOperation(operation: number): string {
	return operation === 1 ? "delegatecall (MultiSend)" : "call"
}

function printSafeSubmissionOverview(proposalReport: any) {
	console.log("")
	console.log("Safe Proposal Review")
	console.log("--------------------")
	console.log("This script will only submit a Safe Transaction Service proposal.")
	console.log("It will not execute the Symmio core role grants on-chain.")
	console.log(`Network: ${connection.networkName || "unknown"} (chainId ${chainId})`)
	console.log(`Symmio core: ${symmioAddress}`)
	console.log(`SymmioLiquidator proxy: ${liquidatorAddress}`)
	console.log(`Core admin Safe: ${coreAdminSafeAddress}`)
	console.log(`Safe service URL: ${proposalReport.serviceUrl}`)
	console.log(`Safe tx creator: ${safeTxCreatorAddress}`)
	console.log(`Safe service sender: ${safeSubmitterAddress}`)
	console.log(`Safe service sender key: ${safeSubmitterKeyName}`)
	console.log(
		`Safe service sender eligibility: ${
			proposalReport.submissionEligibility.submitterIsOwner
				? "Safe owner"
				: proposalReport.submissionEligibility.submitterIsDelegate
					? "registered delegate"
					: "not owner/delegate"
		}`,
	)
	console.log(`Safe proposal count: 1`)
	console.log(`Safe nonce: ${proposalReport.safeNonce}`)
	console.log(`Safe nonce source: ${proposalReport.nonceResolution?.source || "unknown"}`)
	if (proposalReport.nonceResolution?.warnings?.length > 0) {
		console.log("Safe nonce warnings:")
		for (const warning of proposalReport.nonceResolution.warnings) console.log(`  - ${warning}`)
	}
	console.log(`Safe tx hash: ${proposalReport.safeTxHash}`)
	console.log(`Proposal target: ${proposalReport.proposal.to}`)
	console.log(`Proposal operation: ${describeSafeOperation(proposalReport.proposal.operation)}`)
	if (proposalReport.multiSend) {
		console.log(`MultiSend address: ${proposalReport.multiSend.to}`)
		console.log(`MultiSend transaction count: ${proposalReport.multiSend.txCount}`)
	}
	const readiness = proposalReport.safeProposalReadiness
	if (readiness?.warnings?.length > 0) {
		console.log("")
		console.log("Warnings:")
		for (const warning of readiness.warnings) console.log(`  - ${warning}`)
	}
	console.log("")
	console.log("Human-readable core role grant calls queued inside this Safe transaction:")
	for (const call of proposalReport.humanReadableCalls as HumanReadableCoreRoleCall[]) {
		console.log(`  - ${call.roleName}`)
		console.log(`    To: ${call.to}`)
		console.log(`    Method: grantRole(${call.user}, ${call.role})`)
		console.log(`    Calldata: ${call.data}`)
	}
	if (proposalReport.alreadyQueued) console.log("Status: matching Safe proposal already queued in Safe Transaction Service")
	console.log("")
	console.log("Safe owners:")
	for (const owner of proposalReport.submissionEligibility.owners) console.log(`  - ${owner}`)
	if (proposalReport.submissionEligibility.delegates.length > 0) {
		console.log("Safe delegates:")
		for (const delegate of proposalReport.submissionEligibility.delegates) console.log(`  - ${delegate}`)
	}
	console.log("")
}

async function confirmSafeSubmission(proposalReport: any) {
	printSafeSubmissionOverview(proposalReport)
	if (skipSafeSubmissionConfirmation) {
		console.log("Skipping interactive confirmation because SKIP_SAFE_SUBMISSION_CONFIRMATION=true.")
		return
	}
	if (!input.isTTY) {
		throw new Error(
			"Interactive confirmation is required before Safe submission; rerun in a terminal or set SKIP_SAFE_SUBMISSION_CONFIRMATION=true after reviewing the report",
		)
	}
	const rl = createInterface({ input, output })
	try {
		const answer = await rl.question("Press Enter to submit this proposal to Safe, or type anything else to abort: ")
		if (answer.trim().length > 0) throw new Error("Safe proposal submission aborted by user")
	} finally {
		rl.close()
	}
}

async function buildCoreRoleSafeProposal(coreRoleTxs: CoreRoleTx[]) {
	if (!coreAdminSafeAddress) {
		throw new Error("CORE_ADMIN_SAFE_ADDRESS or SAFE_ADDRESS is required to build the core-role Safe proposal")
	}
	const serviceUrl = getSafeServiceUrl()
	const humanReadableCalls = coreRoleTxs.map(describeCoreRoleCall)
	const safeBatch: SafeBatch = {
		version: "1.0",
		chainId: chainId.toString(),
		createdAt: Date.now(),
		meta: {
			name: "Symmio - grant liquidator core roles",
			description: `Grant missing core liquidator role(s) to ${liquidatorAddress}`,
			txBuilderVersion: "1.18.0",
			createdFromSafeAddress: coreAdminSafeAddress,
			createdFromOwnerAddress: safeTxCreatorAddress,
		},
		transactions: coreRoleTxs.map(tx => tx.safeTx),
	}
	writeJson(coreRolesSafeBatchFile, safeBatch)

	const proposalTx = buildSafeProposalTx(coreRoleTxs)
	const delegateLookup: Promise<SafeDelegatesResult> = safeSubmitterAddress
		? getSafeDelegates(serviceUrl)
		: Promise.resolve({
				delegates: [],
				fetched: false,
				skippedReason: "Safe Transaction Service sender address not set",
			})
	const [onChainInfo, serviceInfo, queuedTransactions, delegatesResult, executionPreflight, coreAdminSafeReadiness] = await Promise.all([
		getSafeOnChainInfo(),
		getSafeServiceInfo(serviceUrl),
		getQueuedSafeTransactions(serviceUrl),
		delegateLookup,
		preflightCoreRoleSafeCalls(coreRoleTxs),
		getCoreAdminSafeReadiness(coreRoleTxs),
	])
	const owners = (serviceInfo?.owners || onChainInfo.owners).map(owner => ethers.getAddress(owner))
	const delegates = delegatesResult.delegates
	const nonceResolution = resolveSafeNonce(serviceInfo?.nonce ?? onChainInfo.nonce, queuedTransactions, safeNonceOverride)
	const existingProposal = findMatchingQueuedProposal(queuedTransactions, proposalTx, safeNonceOverride)
	const safeNonce = existingProposal?.nonce !== undefined ? Number(existingProposal.nonce) : nonceResolution.nonce
	const safe = new ethers.Contract(coreAdminSafeAddress, safeIface, ethers.provider)
	const domain = { chainId, verifyingContract: coreAdminSafeAddress }
	const safeTx = {
		to: proposalTx.to,
		value: BigInt(proposalTx.value),
		data: proposalTx.data,
		operation: proposalTx.operation,
		safeTxGas: 0n,
		baseGas: 0n,
		gasPrice: 0n,
		gasToken: ethers.ZeroAddress,
		refundReceiver: ethers.ZeroAddress,
		nonce: BigInt(safeNonce),
	}
	const computedSafeTxHash = await safe.getTransactionHash(
		safeTx.to,
		safeTx.value,
		safeTx.data,
		safeTx.operation,
		safeTx.safeTxGas,
		safeTx.baseGas,
		safeTx.gasPrice,
		safeTx.gasToken,
		safeTx.refundReceiver,
		safeTx.nonce,
	)
	const typedDataHash = ethers.TypedDataEncoder.hash(domain, SAFE_TX_TYPES, safeTx)
	if (typedDataHash.toLowerCase() !== computedSafeTxHash.toLowerCase()) {
		throw new Error(`Safe typed-data hash ${typedDataHash} did not match on-chain getTransactionHash ${computedSafeTxHash}`)
	}

	const existingSafeTxHash = existingProposal?.safeTxHash || existingProposal?.contractTransactionHash
	if (existingSafeTxHash && existingSafeTxHash.toLowerCase() !== computedSafeTxHash.toLowerCase()) {
		throw new Error(`Queued Safe tx hash ${existingSafeTxHash} did not match computed hash ${computedSafeTxHash}`)
	}
	const safeTxHash = existingSafeTxHash || computedSafeTxHash
	const origin = `Symmio: grant ${coreRoleTxs.map(tx => tx.roleName).join(", ")} to ${liquidatorAddress} on ${connection.networkName || chainId}`
	const proposal = {
		to: safeTx.to,
		value: proposalTx.value,
		data: safeTx.data,
		operation: safeTx.operation,
		safeTxGas: 0,
		baseGas: 0,
		gasPrice: "0",
		gasToken: null,
		refundReceiver: null,
		nonce: safeNonce,
		contractTransactionHash: safeTxHash,
		sender: safeSubmitterAddress || safeTxCreatorAddress,
		origin,
	}
	const submitterIsOwner = Boolean(safeSubmitterAddress && owners.some(owner => owner.toLowerCase() === safeSubmitterAddress.toLowerCase()))
	const submitterIsDelegate = Boolean(
		safeSubmitterAddress && delegates.some(delegate => delegate.toLowerCase() === safeSubmitterAddress.toLowerCase()),
	)
	const submitterCanSubmit = submitterIsOwner || submitterIsDelegate
	let submissionReason: string | undefined
	if (!safeSubmitterAddress) {
		submissionReason = "Safe Transaction Service sender address is not configured"
	} else if (!submitterCanSubmit) {
		submissionReason = delegatesResult.fetched
			? `${safeSubmitterAddress} is not a Safe owner or registered delegate`
			: `${safeSubmitterAddress} is not a Safe owner, and delegate lookup failed: ${delegatesResult.error || delegatesResult.skippedReason}`
	}
	const submissionEligibility = {
		ok: Boolean(safeSubmitterAddress && submitterCanSubmit),
		requested: submitSafeProposal,
		creatorAddress: safeTxCreatorAddress,
		submitterAddress: safeSubmitterAddress || undefined,
		submitterKeyName: safeSubmitterKeyName,
		submitterIsOwner,
		submitterIsDelegate,
		owners,
		delegates,
		delegatesFetched: delegatesResult.fetched,
		delegateFetchError: delegatesResult.error,
		delegateLookupSkippedReason: delegatesResult.skippedReason,
		reason: submissionReason,
	}
	const proposalReport: any = {
		network: connection.networkName || "unknown",
		chainId: chainId.toString(),
		safe: coreAdminSafeAddress,
		diamond: symmioAddress,
		liquidator: liquidatorAddress,
		roles: coreRoleTxs.map(tx => ({ display: tx.roleName, hash: tx.roleHash })),
		creatorAddress: safeTxCreatorAddress,
		senderAddress: safeSubmitterAddress || safeTxCreatorAddress,
		submitterAddress: safeSubmitterAddress || undefined,
		submitterKeyName: safeSubmitterKeyName,
		submissionMode: coreRoleTxs.length > 1 ? "multisend" : "direct",
		safeNonce,
		nonceResolution,
		safeTxHash,
		typedDataHash,
		serviceUrl,
		humanReadableCalls,
		dataDecoded: buildProposalDataDecoded(proposalTx, humanReadableCalls),
		multiSend:
			coreRoleTxs.length > 1
				? {
						to: safeMultiSendAddress,
						txCount: coreRoleTxs.length,
						transactionsData: proposalTx.multiSendData,
						decodedCalls: humanReadableCalls,
					}
				: undefined,
		executionPreflight,
		coreAdminSafeReadiness,
		submissionEligibility,
		submitSafeProposal,
		submitted: false,
		alreadyQueued: Boolean(existingProposal),
		allSubmittedOrQueued: Boolean(existingProposal),
		submittedCount: 0,
		alreadyQueuedCount: existingProposal ? 1 : 0,
		failedSubmissionCount: 0,
		proposal,
		safeTx: {
			...proposal,
			gasToken: ethers.ZeroAddress,
			refundReceiver: ethers.ZeroAddress,
		},
	}
	proposalReport.safeProposalReadiness = buildSafeProposalReadiness(proposalReport)

	if (proposalReport.alreadyQueued) {
		proposalReport.submissionSkippedReason = "Matching Safe proposal already queued"
		writeJson(coreRolesSafeProposalFile, proposalReport)
		return proposalReport
	}

	if (submitSafeProposal && !proposalReport.safeProposalReadiness.ready) {
		proposalReport.submissionSkippedReason = "Safe proposal submission skipped: readiness blockers must be fixed first"
		writeJson(coreRolesSafeProposalFile, proposalReport)
		return proposalReport
	}

	if (!submitSafeProposal) {
		proposalReport.submissionSkippedReason = "SUBMIT_SAFE_PROPOSAL is not true"
		writeJson(coreRolesSafeProposalFile, proposalReport)
		return proposalReport
	}

	if (!safeSubmitterAddress) {
		proposalReport.submissionSkippedReason = "Safe Transaction Service submission skipped: sender address is not configured"
		writeJson(coreRolesSafeProposalFile, proposalReport)
		return proposalReport
	}

	writeJson(coreRolesSafeProposalFile, proposalReport)
	await confirmSafeSubmission(proposalReport)
	const submitterSigner = await getSafeSubmitterSigner()
	const submitterAddress = ethers.getAddress(await submitterSigner.getAddress())
	if (submitterAddress.toLowerCase() !== safeSubmitterAddress.toLowerCase()) {
		throw new Error(`Safe service sender ${submitterAddress} does not match expected sender ${safeSubmitterAddress}`)
	}

	const signature = await submitterSigner.signTypedData(domain, SAFE_TX_TYPES, safeTx)
	const payload = {
		...proposal,
		sender: submitterAddress,
		signature,
	}
	proposalReport.payload = payload
	try {
		const submitResponse = await fetchJson(`${serviceUrl}/safes/${coreAdminSafeAddress}/multisig-transactions/`, {
			method: "POST",
			body: JSON.stringify(payload),
		})
		proposalReport.submitted = true
		proposalReport.allSubmittedOrQueued = true
		proposalReport.submittedCount = 1
		proposalReport.submitResponse = submitResponse
	} catch (err) {
		proposalReport.submitError = getErrorMessage(err)
		proposalReport.failedSubmissionCount = 1
		proposalReport.submissionSkippedReason = "Safe Transaction Service rejected the proposal submission"
	}
	writeJson(coreRolesSafeProposalFile, proposalReport)
	return proposalReport
}

if (shouldToggleHyperEVMBigBlocks) {
	console.log(`Detected HyperEVM (chainId ${chainId}) — enabling big blocks before deploy...`)
	await setHyperEVMBigBlocks(hre, true)
	console.log("")
} else if (isHyperEVM && reuseLiquidator) {
	console.log(`Detected HyperEVM (chainId ${chainId}) — reuse mode enabled, skipping big-block toggle.`)
	console.log("")
}

let liquidatorAddress: string
let registeredOperators = 0
let skippedOperators = 0
let grantedCoreRoles = 0
let skippedCoreRoles = 0
const operatorFailures: string[] = []
const coreRoleFailures: string[] = []
let liquidatorDeploymentOutput: any | undefined
let coreRoleSafeProposalReport: any | undefined
try {
	if (shouldUseTemporaryAdmin) {
		console.log(`Using deployer ${deployerAddress} as temporary SymmioLiquidator admin for setup.`)
		console.log(`Final SymmioLiquidator admin will be: ${finalAdmin}`)
		console.log("")
	}

	if (reuseLiquidator) {
		liquidatorAddress = ethers.getAddress(existingLiquidatorAddress)
		console.log(`Reusing SymmioLiquidator at: ${liquidatorAddress}`)
	} else {
		const contract = await tasks.getTask("deploy:symmioLiquidator").run({
			symmioAddress,
			admin: initialAdmin,
			logData: false,
		})
		liquidatorAddress = (await contract.getAddress?.()) || contract.address
		console.log("SymmioLiquidator deployed at:", liquidatorAddress)
	}

	const liquidator = await ethers.getContractAt("SymmioLiquidator", liquidatorAddress)
	liquidatorDeploymentOutput = await writeLiquidatorDeploymentOutput(liquidator, initialAdmin)
	console.log(`Liquidator deployment output: ${liquidatorDeploymentFile}`)
	const DEFAULT_ADMIN_ROLE = await liquidator.DEFAULT_ADMIN_ROLE()
	const MANAGER_ROLE = await liquidator.MANAGER_ROLE()
	const OPERATOR_ROLE = await liquidator.OPERATOR_ROLE()
	const signerCanManageLiquidatorRoles = await liquidator.hasRole(DEFAULT_ADMIN_ROLE, deployerAddress)

	if (operators.length === 0) {
		console.log("")
		console.log("⚠ No OPERATORS env var provided — skipping operator registration.")
		console.log("  To register operators later, set OPERATORS=0xaaa,0xbbb,0xccc and re-run,")
		console.log("  or call grantRole(OPERATOR_ROLE, <operator>) on the SymmioLiquidator.")
	} else {
		console.log("")
		console.log(`Registering ${operators.length} operator(s)...`)

		console.log("  Using signer:", deployer.address)

		// ----- 1. Grant OPERATOR_ROLE on SymmioLiquidator -----
		for (const op of operators) {
			const already = await liquidator.hasRole(OPERATOR_ROLE, op)
			if (already) {
				console.log(`  ⏭ ${op} already has OPERATOR_ROLE on SymmioLiquidator`)
				skippedOperators++
				continue
			}

			if (!signerCanManageLiquidatorRoles) {
				const message = `${op}: signer ${deployerAddress} is not DEFAULT_ADMIN_ROLE on SymmioLiquidator`
				operatorFailures.push(message)
				console.log(`  ⚠ Skipped OPERATOR_ROLE for ${op}: ${message}`)
				continue
			}

			try {
				const tx = await liquidator.grantRole(OPERATOR_ROLE, op)
				await tx.wait()
				registeredOperators++
				console.log(`  ✓ Granted OPERATOR_ROLE on SymmioLiquidator to ${op}`)
			} catch (err: any) {
				const message = `${op}: ${getErrorMessage(err)}`
				operatorFailures.push(message)
				console.log(`  ⚠ Failed to grant OPERATOR_ROLE to ${op}: ${getErrorMessage(err)}`)
			}
		}

		// ----- 2. Hand SymmioLiquidator admin/manager roles to final admin -----
		if (shouldUseTemporaryAdmin) {
			console.log("")
			console.log(`Transferring SymmioLiquidator admin to ${finalAdmin}...`)

			if (!(await liquidator.hasRole(DEFAULT_ADMIN_ROLE, finalAdmin))) {
				const tx = await liquidator.grantRole(DEFAULT_ADMIN_ROLE, finalAdmin)
				await tx.wait()
				console.log(`  ✓ Granted DEFAULT_ADMIN_ROLE to ${finalAdmin}`)
			} else {
				console.log(`  ⏭ ${finalAdmin} already has DEFAULT_ADMIN_ROLE`)
			}

			if (!(await liquidator.hasRole(MANAGER_ROLE, finalAdmin))) {
				const tx = await liquidator.grantRole(MANAGER_ROLE, finalAdmin)
				await tx.wait()
				console.log(`  ✓ Granted MANAGER_ROLE to ${finalAdmin}`)
			} else {
				console.log(`  ⏭ ${finalAdmin} already has MANAGER_ROLE`)
			}

			if (await liquidator.hasRole(MANAGER_ROLE, deployerAddress)) {
				const tx = await liquidator.revokeRole(MANAGER_ROLE, deployerAddress)
				await tx.wait()
				console.log(`  ✓ Revoked temporary MANAGER_ROLE from ${deployerAddress}`)
			}

			if (await liquidator.hasRole(DEFAULT_ADMIN_ROLE, deployerAddress)) {
				const tx = await liquidator.revokeRole(DEFAULT_ADMIN_ROLE, deployerAddress)
				await tx.wait()
				console.log(`  ✓ Revoked temporary DEFAULT_ADMIN_ROLE from ${deployerAddress}`)
			}
		}
	}

	// ----- 3. Prepare LIQUIDATOR_ROLE + PARTYB_LIQUIDATOR_ROLE on Core -----
	//       The liquidator CONTRACT is the msg.sender seen by core, so the contract
	//       address is what needs the role — not the operator EOAs.
	const view = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", symmioAddress)
	const control = directCoreRoleGrantsEnabled
		? await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", symmioAddress)
		: undefined

	console.log("")
	console.log(
		`Core role grant mode: ${
			directCoreRoleGrantsEnabled ? "direct signer grant if signer is role admin" : "Safe proposal only; direct core grants disabled"
		}`,
	)

	for (const [roleName, roleHash] of coreRoles) {
		const already = await view.hasRole(liquidatorAddress, roleHash)
		if (already) {
			console.log(`  ⏭ SymmioLiquidator already has ${roleName} on core`)
			skippedCoreRoles++
			continue
		}

		if (!directCoreRoleGrantsEnabled) {
			console.log(`  ⏭ ${roleName} missing on core; will include it in the Safe proposal`)
			continue
		}

		const canGrant = await view.isRoleAdmin(deployerAddress, roleHash)
		if (!canGrant) {
			const message = `${roleName}: signer ${deployerAddress} is not role admin on core`
			coreRoleFailures.push(message)
			console.log(`  ⚠ Skipped ${roleName} on core: ${message}`)
			continue
		}

		try {
			const tx = await control!.grantRole(liquidatorAddress, roleHash)
			await tx.wait()
			grantedCoreRoles++
			console.log(`  ✓ Granted ${roleName} on core to SymmioLiquidator (${liquidatorAddress})`)
		} catch (err: any) {
			const message = `${roleName}: ${getErrorMessage(err)}`
			coreRoleFailures.push(message)
			console.log(`  ⚠ Failed to grant ${roleName} on core: ${getErrorMessage(err)}`)
		}
	}

	const coreRolesNeedingSafe: CoreRoleTx[] = []
	for (const [roleName, roleHash] of coreRoles) {
		if (await view.hasRole(liquidatorAddress, roleHash)) continue
		coreRolesNeedingSafe.push({
			roleName,
			roleHash,
			safeTx: toHumanReadableSafeTxFromIface(coreRoleIface, symmioAddress, "grantRole", [liquidatorAddress, roleHash]),
		})
	}

	if (coreRolesNeedingSafe.length > 0) {
		console.log("")
		console.log(`Building Safe transaction for ${coreRolesNeedingSafe.length} missing core role(s)...`)
		console.log(`  Core admin Safe: ${coreAdminSafeAddress}`)
		console.log(`  Safe tx creator: ${safeTxCreatorAddress}`)
		console.log(`  Safe service sender: ${safeSubmitterAddress || "not configured"}`)
		console.log(`  Submit to Safe service: ${submitSafeProposal ? "yes" : "no"}`)

		try {
			coreRoleSafeProposalReport = await buildCoreRoleSafeProposal(coreRolesNeedingSafe)
			console.log(`  ✓ Wrote Safe batch: ${coreRolesSafeBatchFile}`)
			console.log(`  ✓ Wrote Safe proposal report: ${coreRolesSafeProposalFile}`)
			if (coreRoleSafeProposalReport.allSubmittedOrQueued) {
				const state = coreRoleSafeProposalReport.submitted ? "submitted" : "already queued"
				console.log(`  ✓ Safe proposal ${state}: ${coreRoleSafeProposalReport.safeTxHash}`)
			} else if (coreRoleSafeProposalReport.alreadyQueued) {
				console.log(`  ⏭ Matching Safe proposal already queued`)
			} else if (coreRoleSafeProposalReport.submissionSkippedReason) {
				console.log(`  ⚠ Safe proposal not submitted: ${coreRoleSafeProposalReport.submissionSkippedReason}`)
			}
		} catch (err: any) {
			const message = `Safe proposal: ${getErrorMessage(err)}`
			coreRoleFailures.push(message)
			console.log(`  ⚠ Failed to build/submit Safe proposal: ${getErrorMessage(err)}`)
		}
	}

	console.log("")
	console.log("Verifying final SymmioLiquidator admin...")
	const finalAdminHasDefaultAdmin = await liquidator.hasRole(DEFAULT_ADMIN_ROLE, finalAdmin)
	const finalAdminHasManager = await liquidator.hasRole(MANAGER_ROLE, finalAdmin)
	const deployerStillDefaultAdmin = shouldUseTemporaryAdmin && (await liquidator.hasRole(DEFAULT_ADMIN_ROLE, deployerAddress))
	const deployerStillManager = shouldUseTemporaryAdmin && (await liquidator.hasRole(MANAGER_ROLE, deployerAddress))
	const missingOperators: string[] = []
	for (const op of operators) {
		if (!(await liquidator.hasRole(OPERATOR_ROLE, op))) missingOperators.push(op)
	}
	const missingCoreRoles: string[] = []
	for (const [roleName, roleHash] of coreRoles) {
		if (!(await view.hasRole(liquidatorAddress, roleHash))) missingCoreRoles.push(roleName)
	}
	const verificationFailures: string[] = []

	if (!finalAdminHasDefaultAdmin) {
		verificationFailures.push(`ADMIN_PUBLIC_KEY ${finalAdmin} is missing DEFAULT_ADMIN_ROLE on ${liquidatorAddress}`)
	}
	if (!finalAdminHasManager) {
		verificationFailures.push(`ADMIN_PUBLIC_KEY ${finalAdmin} is missing MANAGER_ROLE on ${liquidatorAddress}`)
	}
	if (deployerStillDefaultAdmin) {
		verificationFailures.push(`temporary deployer ${deployerAddress} still has DEFAULT_ADMIN_ROLE on ${liquidatorAddress}`)
	}
	if (deployerStillManager) {
		verificationFailures.push(`temporary deployer ${deployerAddress} still has MANAGER_ROLE on ${liquidatorAddress}`)
	}
	if (missingOperators.length > 0) {
		verificationFailures.push(`${missingOperators.length} operator(s) missing OPERATOR_ROLE: ${missingOperators.join(", ")}`)
	}
	const safeProposalSubmittedOrQueued = Boolean(
		coreRoleSafeProposalReport?.allSubmittedOrQueued || coreRoleSafeProposalReport?.submitted || coreRoleSafeProposalReport?.alreadyQueued,
	)
	const safeProposalReadiness = buildSafeProposalReadiness(coreRoleSafeProposalReport)
	const safeProposalSubmissionFailed = Boolean(coreRoleSafeProposalReport?.submitError || coreRoleSafeProposalReport?.failedSubmissionCount > 0)
	const safeProposalReadyForSubmission = Boolean(
		safeProposalReadiness?.ready &&
		!safeProposalSubmissionFailed &&
		!coreRoleSafeProposalReport?.allSubmittedOrQueued &&
		!coreRoleSafeProposalReport?.submitted &&
		!coreRoleSafeProposalReport?.alreadyQueued,
	)
	const status =
		verificationFailures.length === 0 && missingCoreRoles.length === 0
			? "success"
			: verificationFailures.length === 0 && missingCoreRoles.length > 0 && safeProposalSubmittedOrQueued
				? "pending-safe-execution"
				: verificationFailures.length === 0 && missingCoreRoles.length > 0 && safeProposalReadyForSubmission
					? "pending-safe-submission"
					: "incomplete"
	const completedAt = new Date().toISOString()
	const report = {
		status,
		completedAt,
		reportFile,
		mode: reuseLiquidator ? "reuse" : "deploy",
		network: {
			name: networkName,
			chainId: chainId.toString(),
			isHyperEVM,
			toggledBigBlocks: shouldToggleHyperEVMBigBlocks,
			outputSuffix,
		},
		addresses: {
			symmioCore: symmioAddress,
			symmioLiquidator: liquidatorAddress,
			deployer: deployerAddress,
			initialAdmin,
			finalAdmin,
			coreAdminSafe: coreAdminSafeAddress,
			safeTxCreator: safeTxCreatorAddress,
			safeSubmitter: safeSubmitterAddress || undefined,
			safeMultiSend: safeMultiSendAddress,
		},
		config: {
			reuseLiquidator,
			operators,
			operatorsConfigured: operators.length,
			directCoreRoleGrantsEnabled,
			submitSafeProposal,
			skipSafeSubmissionConfirmation,
			safeSubmitterKeyName,
			safeNonceOverride,
			safeServiceUrl: getOptionalSafeServiceUrl(),
			liquidatorConfigFile,
			loadedLiquidatorConfig,
			loadedPreviousReport,
			loadedPreviousDeployment,
		},
		results: {
			finalAdminHasDefaultAdmin,
			finalAdminHasManager,
			temporaryAdminUsed: shouldUseTemporaryAdmin,
			temporaryDeployerStillDefaultAdmin: deployerStillDefaultAdmin,
			temporaryDeployerStillManager: deployerStillManager,
			operatorsGranted: registeredOperators,
			operatorsAlreadyPresent: skippedOperators,
			missingOperators,
			coreRolesGranted: grantedCoreRoles,
			coreRolesAlreadyPresent: skippedCoreRoles,
			missingCoreRoles,
			liquidatorDeployment: liquidatorDeploymentOutput,
			coreRoleSafeProposal: coreRoleSafeProposalReport
				? {
						file: coreRolesSafeProposalFile,
						batchFile: coreRolesSafeBatchFile,
						submissionMode: coreRoleSafeProposalReport.submissionMode,
						safeNonce: coreRoleSafeProposalReport.safeNonce,
						nonceResolution: coreRoleSafeProposalReport.nonceResolution,
						safeTxHash: coreRoleSafeProposalReport.safeTxHash,
						submitted: Boolean(coreRoleSafeProposalReport.submitted),
						alreadyQueued: Boolean(coreRoleSafeProposalReport.alreadyQueued),
						allSubmittedOrQueued: Boolean(coreRoleSafeProposalReport.allSubmittedOrQueued),
						submittedCount: coreRoleSafeProposalReport.submittedCount,
						alreadyQueuedCount: coreRoleSafeProposalReport.alreadyQueuedCount,
						failedSubmissionCount: coreRoleSafeProposalReport.failedSubmissionCount,
						submissionSkippedReason: coreRoleSafeProposalReport.submissionSkippedReason,
						submitError: coreRoleSafeProposalReport.submitError,
						executionPreflightOk: Boolean(coreRoleSafeProposalReport.executionPreflight?.ok),
						humanReadableCalls: coreRoleSafeProposalReport.humanReadableCalls,
						dataDecoded: coreRoleSafeProposalReport.dataDecoded,
						multiSend: coreRoleSafeProposalReport.multiSend,
						coreAdminSafeReadiness: coreRoleSafeProposalReport.coreAdminSafeReadiness,
					}
				: undefined,
		},
		safeProposalReadiness,
		failures: {
			verificationFailures,
			operatorFailures,
			coreRoleFailures,
		},
	}
	writeReport(report)

	console.log("")
	console.log("Deployment Summary")
	console.log("------------------")
	console.log(`Status: ${status}`)
	console.log(`Mode: ${reuseLiquidator ? "reuse existing liquidator" : "deploy new liquidator"}`)
	console.log(`Network name: ${networkName}`)
	console.log(`Network chainId: ${chainId}`)
	console.log(`Output suffix: ${outputSuffix}`)
	console.log(`Symmio core: ${symmioAddress}`)
	console.log(`SymmioLiquidator: ${liquidatorAddress}`)
	console.log(`Deployer: ${deployerAddress}`)
	console.log(`Initial admin: ${initialAdmin}`)
	console.log(`Final admin: ${finalAdmin}`)
	console.log(`Final admin DEFAULT_ADMIN_ROLE: ${finalAdminHasDefaultAdmin ? "yes" : "no"}`)
	console.log(`Final admin MANAGER_ROLE: ${finalAdminHasManager ? "yes" : "no"}`)
	console.log(`Temporary admin used: ${shouldUseTemporaryAdmin ? "yes" : "no"}`)
	if (shouldUseTemporaryAdmin) {
		console.log(`Temporary deployer DEFAULT_ADMIN_ROLE revoked: ${deployerStillDefaultAdmin ? "no" : "yes"}`)
		console.log(`Temporary deployer MANAGER_ROLE revoked: ${deployerStillManager ? "no" : "yes"}`)
	}
	console.log(`Operators configured: ${operators.length}`)
	console.log(`Operators granted: ${registeredOperators}`)
	console.log(`Operators already present: ${skippedOperators}`)
	console.log(`Operators missing: ${missingOperators.length > 0 ? missingOperators.length : "none"}`)
	if (operatorFailures.length > 0) {
		console.log("Operator grant failures:")
		for (const failure of operatorFailures) console.log(`  - ${failure}`)
	}
	console.log(`Core roles granted: ${grantedCoreRoles}`)
	console.log(`Core roles already present: ${skippedCoreRoles}`)
	console.log(`Core roles missing: ${missingCoreRoles.length > 0 ? missingCoreRoles.join(", ") : "none"}`)
	console.log(`Core role grant mode: ${directCoreRoleGrantsEnabled ? "direct signer grant" : "Safe proposal only"}`)
	if (missingCoreRoles.length > 0) {
		console.log(`Core admin Safe: ${coreAdminSafeAddress}`)
		console.log(`Safe tx creator: ${safeTxCreatorAddress}`)
		console.log(`Safe service sender: ${safeSubmitterAddress || "not configured"}`)
		console.log(`Safe service sender key: ${safeSubmitterKeyName}`)
		if (coreRoleSafeProposalReport) {
			console.log(`Safe batch file: ${coreRolesSafeBatchFile}`)
			console.log(`Safe proposal report: ${coreRolesSafeProposalFile}`)
			console.log(`Safe proposal mode: ${coreRoleSafeProposalReport.submissionMode || "unknown"}`)
			console.log(`Safe proposal nonce: ${coreRoleSafeProposalReport.safeNonce ?? "n/a"}`)
			console.log(`Safe proposal nonce source: ${coreRoleSafeProposalReport.nonceResolution?.source || "unknown"}`)
			if (coreRoleSafeProposalReport.nonceResolution?.warnings?.length > 0) {
				console.log("Safe proposal nonce warnings:")
				for (const warning of coreRoleSafeProposalReport.nonceResolution.warnings) console.log(`  - ${warning}`)
			}
			console.log(`Safe proposal tx hash: ${coreRoleSafeProposalReport.safeTxHash || "n/a"}`)
			if (coreRoleSafeProposalReport.multiSend) {
				console.log(`Safe proposal MultiSend: ${coreRoleSafeProposalReport.multiSend.to}`)
				console.log(`Safe proposal inner tx count: ${coreRoleSafeProposalReport.multiSend.txCount}`)
			}
			console.log(
				`Safe proposal submitted: ${
					coreRoleSafeProposalReport.allSubmittedOrQueued
						? `submitted/queued (${coreRoleSafeProposalReport.submittedCount || 0} submitted, ${coreRoleSafeProposalReport.alreadyQueuedCount || 0} already queued)`
						: "no"
				}`,
			)
			if (coreRoleSafeProposalReport.submissionSkippedReason) {
				console.log(`Safe proposal note: ${coreRoleSafeProposalReport.submissionSkippedReason}`)
			}
			if (coreRoleSafeProposalReport.submitError) {
				console.log(`Safe proposal submit error: ${coreRoleSafeProposalReport.submitError}`)
			}
			if (safeProposalReadiness?.warnings?.length > 0) {
				console.log("Safe proposal warnings:")
				for (const warning of safeProposalReadiness.warnings) console.log(`  - ${warning}`)
			}
			if (safeProposalReadiness?.desiredCoreRoleGrants?.length > 0) {
				console.log("Required Symmio core role grants:")
				for (const call of coreRoleSafeProposalReport.humanReadableCalls || []) {
					console.log(`  - ${call.roleName}`)
					console.log(`    To: ${call.to}`)
					console.log(`    Method: grantRole(${call.user}, ${call.role})`)
					console.log(`    Calldata: ${call.data}`)
				}
			}
			if (safeProposalReadiness && !safeProposalReadiness.ready) {
				console.log("Safe proposal blockers:")
				for (const reason of safeProposalReadiness.blockingReasons) console.log(`  - ${reason}`)
				if (safeProposalReadiness.requiredBeforeSubmission.length > 0) {
					console.log("Required before Safe submission:")
					for (const action of safeProposalReadiness.requiredBeforeSubmission) console.log(`  - ${action}`)
				}
			} else if (safeProposalReadiness?.requiredBeforeSubmission?.length > 0) {
				console.log("Review before Safe execution:")
				for (const action of safeProposalReadiness.requiredBeforeSubmission) console.log(`  - ${action}`)
			}
		}
	}
	if (coreRoleFailures.length > 0) {
		console.log("Core role grant failures:")
		for (const failure of coreRoleFailures) console.log(`  - ${failure}`)
	}
	if (verificationFailures.length > 0) {
		console.log("Verification failures:")
		for (const failure of verificationFailures) console.log(`  - ${failure}`)
	}
	console.log(`Liquidator deployment output: ${liquidatorDeploymentFile}`)
	console.log(`Report file: ${reportFile}`)
	console.log("")
	if (status === "pending-safe-execution") {
		console.log("✓ Liquidator setup is ready; missing core role(s) are queued for Safe execution.")
		console.log("  After the Safe executes, rerun with REUSE_LIQUIDATOR=true to verify final success.")
	} else if (status === "pending-safe-submission") {
		console.log("⚠ Liquidator setup needs a Safe submission for the missing core role(s).")
		console.log("  Re-run with SUBMIT_SAFE_PROPOSAL=true and the TEAM_PROPOSER keystore entry, or import the Safe batch file.")
		process.exitCode = 1
	} else if (status !== "success") {
		console.log("⚠ Deployment/reuse run completed, but setup is incomplete.")
		if (missingCoreRoles.length > 0) console.log("  Grant the missing core role(s) with a Symmio core role-admin signer or Safe.")
		process.exitCode = 1
	} else {
		console.log("✓ Deployment, setup, and final admin verification complete.")
	}
} finally {
	// Always restore fast blocks, even if the deploy/grants above threw
	if (shouldToggleHyperEVMBigBlocks) {
		console.log("")
		console.log("Restoring HyperEVM fast blocks...")
		try {
			await setHyperEVMBigBlocks(hre, false)
		} catch (err) {
			console.error("⚠ Failed to disable big blocks. Run manually:")
			console.error("    npx hardhat hyperevm:disable-big-blocks --network hyperevm")
			console.error(err)
		}
	}
}
