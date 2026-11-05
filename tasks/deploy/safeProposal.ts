import SafeApiKit from "@safe-global/api-kit"
import Safe from "@safe-global/protocol-kit"
import { OperationType, type MetaTransactionData } from "@safe-global/types-kit"
import { getAddress, isAddress } from "ethers"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { requireSafeProposalConfirmation } from "./executionGuard.js"
import { getConnection } from "./helpers.js"
import { emitTaskEvent, logger } from "./logger.js"

export const SAFE_BATCH_API_VERSION = "operations.symm.io/safe-batch-v1"

export type SafeBatchIntent = {
	apiVersion: typeof SAFE_BATCH_API_VERSION
	chainId: number
	safeAddress: string
	name: string
	description: string
	digest: string
	actions: Array<{ to: string; value: string; data: string; description: string }>
}

type ProposalDependencies = {
	protocolKit: { init(config: Record<string, unknown>): Promise<any> }
	apiKit: new (config: { chainId: bigint; apiKey: string }) => { proposeTransaction(input: Record<string, unknown>): Promise<unknown> }
	provider: { request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown> }
	ownerAddress: string
	apiKey: string
	now?: () => Date
}

function nonZeroAddress(value: unknown): value is string {
	return typeof value === "string" && isAddress(value) && !/^0x0{40}$/i.test(value)
}

function stableValue(value: unknown): unknown {
	if (typeof value === "bigint") return value.toString()
	if (value === null || typeof value !== "object") return value
	if (Array.isArray(value)) return value.map(stableValue)
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map(key => [key, stableValue((value as Record<string, unknown>)[key])]),
	)
}

export function safeIntentDigest(input: Omit<SafeBatchIntent, "digest">): string {
	return createHash("sha256")
		.update(JSON.stringify(stableValue(input)))
		.digest("hex")
}

export function validateSafeBatchIntent(value: unknown): SafeBatchIntent {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Safe proposal input must be an object")
	const input = value as Record<string, any>
	if (input.apiVersion !== SAFE_BATCH_API_VERSION) throw new Error(`Safe proposal apiVersion must be ${SAFE_BATCH_API_VERSION}`)
	if (!Number.isSafeInteger(input.chainId) || input.chainId < 1) throw new Error("Safe proposal chainId must be a positive integer")
	if (!nonZeroAddress(input.safeAddress)) throw new Error("Safe proposal safeAddress must be a non-zero address")
	if (typeof input.name !== "string" || input.name.trim() === "") throw new Error("Safe proposal name is required")
	if (typeof input.description !== "string") throw new Error("Safe proposal description must be a string")
	if (typeof input.digest !== "string" || !/^[0-9a-f]{64}$/.test(input.digest)) throw new Error("Safe proposal digest must be sha256 hex")
	if (!Array.isArray(input.actions) || input.actions.length === 0) throw new Error("Safe proposal requires at least one action")
	const actions = input.actions.map((action: any, index: number) => {
		if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error(`Safe action ${index + 1} must be an object`)
		if (!nonZeroAddress(action.to)) throw new Error(`Safe action ${index + 1} target is invalid`)
		if (typeof action.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(action.data))
			throw new Error(`Safe action ${index + 1} calldata is invalid`)
		let value: string
		try {
			value = BigInt(action.value).toString()
		} catch {
			throw new Error(`Safe action ${index + 1} value is invalid`)
		}
		if (typeof action.description !== "string" || action.description.trim() === "")
			throw new Error(`Safe action ${index + 1} description is required`)
		return { to: getAddress(action.to), value, data: action.data.toLowerCase(), description: action.description.trim() }
	})
	const normalized: SafeBatchIntent = {
		apiVersion: SAFE_BATCH_API_VERSION,
		chainId: input.chainId,
		safeAddress: getAddress(input.safeAddress),
		name: input.name.trim(),
		description: input.description,
		digest: input.digest,
		actions,
	}
	const { digest, ...intent } = normalized
	const actualDigest = safeIntentDigest(intent)
	if (actualDigest !== digest) throw new Error(`Safe proposal intent digest mismatch (${actualDigest.slice(0, 12)} != ${digest.slice(0, 12)})`)
	return normalized
}

function atomicWrite(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
		fs.renameSync(temporary, file)
	} catch (error) {
		try {
			fs.unlinkSync(temporary)
		} catch {}
		throw error
	}
}

export async function proposeSafeBatch(inputValue: unknown, dependencies: ProposalDependencies) {
	const input = validateSafeBatchIntent(inputValue)
	const ownerAddress = getAddress(dependencies.ownerAddress)
	const protocol = await dependencies.protocolKit.init({
		provider: dependencies.provider,
		signer: ownerAddress,
		safeAddress: input.safeAddress,
	})
	if (!(await protocol.isOwner(ownerAddress))) throw new Error(`${ownerAddress} is not an owner of Safe ${input.safeAddress}`)
	const transactions: MetaTransactionData[] = input.actions.map(action => ({
		to: action.to,
		value: action.value,
		data: action.data,
		operation: OperationType.Call,
	}))
	const safeTransaction = await protocol.createTransaction({ transactions, onlyCalls: true })
	const safeTxHash = await protocol.getTransactionHash(safeTransaction)
	const signature = await protocol.signHash(safeTxHash)
	const api = new dependencies.apiKit({ chainId: BigInt(input.chainId), apiKey: dependencies.apiKey })
	await api.proposeTransaction({
		safeAddress: input.safeAddress,
		safeTransactionData: safeTransaction.data,
		safeTxHash,
		senderAddress: ownerAddress,
		senderSignature: signature.data,
		origin: `SYMMIO Operator: ${input.name} (${input.digest.slice(0, 12)})`,
	})
	return {
		apiVersion: "operations.symm.io/safe-proposal-result-v1",
		chainId: input.chainId,
		safeAddress: input.safeAddress,
		digest: input.digest,
		safeTxHash,
		proposedBy: ownerAddress,
		proposedAt: (dependencies.now || (() => new Date()))().toISOString(),
		actionCount: input.actions.length,
	}
}

async function runSafeProposal(hre: any, inputPath: string, outputPath: string) {
	const input = validateSafeBatchIntent(JSON.parse(fs.readFileSync(inputPath, "utf8")))
	const connection = await getConnection(hre)
	const { ethers } = connection
	const chainId = Number((await ethers.provider.getNetwork()).chainId)
	if (chainId !== input.chainId) throw new Error(`Safe proposal connected to chain ${chainId}, but the reviewed batch targets ${input.chainId}`)
	requireSafeProposalConfirmation(chainId, input.safeAddress)
	const [owner] = await ethers.getSigners()
	if (!owner) throw new Error("Safe proposal requires one configured owner signer")
	const ownerAddress = getAddress(owner.address)
	const expected = process.env.SYMMIO_EXPECTED_SIGNER
	if (expected && getAddress(expected) !== ownerAddress) throw new Error(`Configured Safe owner is ${ownerAddress}, expected ${getAddress(expected)}`)
	const apiKey = process.env.SYMMIO_SAFE_API_KEY
	if (!apiKey) throw new Error("Safe Transaction Service API key was not provided by the operator session")
	const provider = {
		request: ({ method, params }: { method: string; params?: readonly unknown[] | object }) => {
			if (params !== undefined && !Array.isArray(params)) {
				throw new Error(`Safe SDK requested unsupported named JSON-RPC parameters for ${method}`)
			}
			return ethers.provider.send(method, params ? [...params] : [])
		},
	}
	const result = await proposeSafeBatch(input, {
		protocolKit: Safe as unknown as ProposalDependencies["protocolKit"],
		apiKit: SafeApiKit as unknown as ProposalDependencies["apiKit"],
		provider,
		ownerAddress,
		apiKey,
	})
	atomicWrite(outputPath, result)
	emitTaskEvent("safe.proposed", { safe: result })
	logger.info(`Safe proposal ${result.safeTxHash} created for ${result.safeAddress} with ${result.actionCount} action(s).`)
	return result
}

export const proposeSafeBatchTask = task("internal:propose-safe-batch", "Internal adapter for proposing a reviewed Safe action batch")
	.addOption({ name: "input", description: "Reviewed Safe intent JSON", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({ name: "output", description: "Proposal result JSON", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.setAction(async () => ({
		default: async ({ input, output }, hre) => {
			if (!input || !output) throw new Error("internal:propose-safe-batch requires --input and --output")
			return runSafeProposal(hre, path.resolve(input), path.resolve(output))
		},
	}))
	.build()
