import { getAddress, Interface, isAddress, isHexString, ZeroAddress } from "ethers"

import { type DeploymentCheckpoint, saveCheckpoint } from "./checkpoint.js"
import { persistSubmittedTransaction } from "./deploymentRecovery.js"
import { getConnection } from "./helpers.js"
import { logger } from "./logger.js"
import {
	bindDeploymentTransactionWriteAhead,
	clearDeploymentTransactionWriteAhead,
	getDeploymentTransactionJournal,
	resetDeploymentTransactionJournal,
	send,
} from "./tx.js"

export type GovernanceAdminType = "eoa" | "safe" | "unknown-contract"

export interface SafeManualAction {
	to: string
	value: "0"
	data: string
	description: string
}

export interface GovernanceAction extends SafeManualAction {
	id: string
	method: string
	expectedSigner: string
	postState: {
		to: string
		data: string
		expectedResult: string
	}
}

export interface GovernanceAdminClassification {
	address: string
	type: GovernanceAdminType
	safeVersion?: string
}

type GovernanceActionInput = Omit<GovernanceAction, "to" | "expectedSigner" | "postState"> & {
	to: string
	expectedSigner: string
	postState: GovernanceAction["postState"]
}

type ReadProvider = {
	getCode(address: string): Promise<string>
	call(transaction: { to: string; data: string }): Promise<string>
}

export interface GovernanceExecutionOptions {
	expectedAdmin: string
	chainId: number
	checkpoint: DeploymentCheckpoint
}

const SAFE_INTERFACE = new Interface([
	"function VERSION() view returns (string)",
	"function getOwners() view returns (address[])",
	"function getThreshold() view returns (uint256)",
	"function nonce() view returns (uint256)",
])

function nonZeroAddress(value: string, label: string): string {
	if (!isAddress(value)) throw new Error(`${label} must be a valid address`)
	const normalized = getAddress(value)
	if (normalized === ZeroAddress) throw new Error(`${label} must not be the zero address`)
	return normalized
}

function calldata(value: string, label: string, allowEmpty = false): string {
	if (!isHexString(value) || (!allowEmpty && value.length < 10)) throw new Error(`${label} must be hexadecimal calldata`)
	return value.toLowerCase()
}

export function governanceAction(input: GovernanceActionInput): GovernanceAction {
	if (input.id !== input.id.toLowerCase() || !/^[a-z0-9][a-z0-9._:-]*$/.test(input.id)) {
		throw new Error(`governance action id must be a stable lowercase machine id; received ${JSON.stringify(input.id)}`)
	}
	if (!/^[A-Za-z_][A-Za-z0-9_]*\([^)]*\)$/.test(input.method)) {
		throw new Error(`governance action method must be a decoded function signature; received ${JSON.stringify(input.method)}`)
	}
	if (input.value !== "0") throw new Error('governance action value must be "0"')
	if (!input.description.trim()) throw new Error("governance action description must be non-empty")

	return {
		id: input.id,
		method: input.method,
		expectedSigner: nonZeroAddress(input.expectedSigner, "governance action expectedSigner"),
		to: nonZeroAddress(input.to, "governance action target"),
		value: "0",
		data: calldata(input.data, "governance action data"),
		description: input.description,
		postState: {
			to: nonZeroAddress(input.postState.to, "governance action post-state target"),
			data: calldata(input.postState.data, "governance action post-state data"),
			expectedResult: calldata(input.postState.expectedResult, "governance action expected result", true),
		},
	}
}

export async function isGovernanceActionSatisfied(provider: Pick<ReadProvider, "call">, action: GovernanceAction): Promise<boolean> {
	const actual = await provider.call({ to: action.postState.to, data: action.postState.data })
	return actual.toLowerCase() === action.postState.expectedResult.toLowerCase()
}

export async function classifyGovernanceAdmin(provider: ReadProvider, value: string): Promise<GovernanceAdminClassification> {
	const address = nonZeroAddress(value, "governance admin")
	if ((await provider.getCode(address)) === "0x") return { address, type: "eoa" }

	try {
		const [versionResult, ownersResult, thresholdResult, nonceResult] = await Promise.all(
			["VERSION", "getOwners", "getThreshold", "nonce"].map(async method =>
				provider.call({ to: address, data: SAFE_INTERFACE.encodeFunctionData(method) }),
			),
		)
		const [version] = SAFE_INTERFACE.decodeFunctionResult("VERSION", versionResult) as unknown as [string]
		const [owners] = SAFE_INTERFACE.decodeFunctionResult("getOwners", ownersResult) as unknown as [string[]]
		const [threshold] = SAFE_INTERFACE.decodeFunctionResult("getThreshold", thresholdResult) as unknown as [bigint]
		SAFE_INTERFACE.decodeFunctionResult("nonce", nonceResult)
		if (!version.trim() || owners.length === 0 || threshold < 1n || threshold > BigInt(owners.length)) {
			return { address, type: "unknown-contract" }
		}
		return { address, type: "safe", safeVersion: version }
	} catch {
		return { address, type: "unknown-contract" }
	}
}

export async function completeGovernanceTransactionRequest(
	provider: any,
	request: { from: string; to: string; data: string; value: bigint },
): Promise<Record<string, unknown>> {
	const [estimatedGas, feeData] = await Promise.all([provider.estimateGas(request), provider.getFeeData()])
	const gasLimit = (BigInt(estimatedGas) * 120n + 99n) / 100n
	if (feeData.maxFeePerGas !== null && feeData.maxPriorityFeePerGas !== null) {
		return {
			to: request.to,
			data: request.data,
			value: request.value,
			gasLimit,
			maxFeePerGas: feeData.maxFeePerGas,
			maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
			type: 2,
		}
	}
	if (feeData.gasPrice !== null) {
		return { to: request.to, data: request.data, value: request.value, gasLimit, gasPrice: feeData.gasPrice }
	}
	throw new Error("Unable to prepare governance transaction: provider returned no complete fee fields")
}

function emitGovernancePreview(action: GovernanceAction, request: Record<string, any>): void {
	const fees =
		request.gasPrice !== undefined
			? `gasPrice=${request.gasPrice}`
			: `maxFeePerGas=${request.maxFeePerGas}, maxPriorityFeePerGas=${request.maxPriorityFeePerGas}`
	logger.info(`Governance action ${action.id}`)
	logger.info(`  target: ${action.to}`)
	logger.info(`  method: ${action.method}`)
	logger.info(`  purpose: ${action.description}`)
	logger.info(`  value: ${action.value}`)
	logger.info(`  gasLimit: ${request.gasLimit}; ${fees}`)
}

export async function executeGovernanceActions(
	hre: any,
	actions: GovernanceAction[],
	options: GovernanceExecutionOptions,
): Promise<{ submitted: number; skipped: number; verified: number }> {
	const { ethers } = await getConnection(hre)
	const connectedChainId = Number((await ethers.provider.getNetwork()).chainId)
	if (connectedChainId !== options.chainId) {
		throw new Error(`Governance handover connected to chainId ${connectedChainId}; expected ${options.chainId}`)
	}
	const expectedAdmin = nonZeroAddress(options.expectedAdmin, "governance admin")
	const [signer] = await ethers.getSigners()
	if (!signer) throw new Error(`No transaction signer is configured for governance admin ${expectedAdmin}`)
	const actualSigner = getAddress(await signer.getAddress())
	if (actualSigner !== expectedAdmin) {
		throw new Error(`actual signer ${actualSigner} does not match governance admin ${expectedAdmin}`)
	}

	let submitted = 0
	let skipped = 0
	let verified = 0
	resetDeploymentTransactionJournal()
	bindDeploymentTransactionWriteAhead(record => persistSubmittedTransaction(options.checkpoint, record))
	try {
		for (const rawAction of actions) {
			const action = governanceAction(rawAction)
			if (action.expectedSigner !== expectedAdmin) {
				throw new Error(`Action ${action.id} expects signer ${action.expectedSigner}, not governance admin ${expectedAdmin}`)
			}
			if (await isGovernanceActionSatisfied(ethers.provider, action)) {
				skipped++
				verified++
				continue
			}
			if ((await ethers.provider.getCode(action.to)) === "0x") throw new Error(`Action ${action.id} target has no contract code`)
			await ethers.provider.call({ from: expectedAdmin, to: action.to, data: action.data, value: BigInt(action.value) })
			const request = await completeGovernanceTransactionRequest(ethers.provider, {
				from: expectedAdmin,
				to: action.to,
				data: action.data,
				value: BigInt(action.value),
			})
			emitGovernancePreview(action, request)
			await send(signer.sendTransaction(request), action.description)
			submitted++
			if (!(await isGovernanceActionSatisfied(ethers.provider, action))) {
				throw new Error(`Action ${action.id} receipt succeeded but post-state is not satisfied`)
			}
			verified++
		}
		return { submitted, skipped, verified }
	} finally {
		const records = [...(options.checkpoint.transactions || []), ...getDeploymentTransactionJournal()]
		options.checkpoint.transactions = [
			...new Map(records.map(record => [`${record.hash.toLowerCase()}:${record.replacementHash?.toLowerCase() || ""}`, record])).values(),
		]
		clearDeploymentTransactionWriteAhead()
		saveCheckpoint(options.checkpoint)
	}
}
