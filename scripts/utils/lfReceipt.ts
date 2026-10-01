import { ZeroHash } from "ethers"
import { setTimeout as delay } from "node:timers/promises"

import type { LfReadRetry } from "./lfReadRetry.js"

export type LfReceiptEvidence = { hash: string; blockNumber: number; blockHash: string; status: number }
export type LfReceiptBlock = { number: number; hash: string; timestamp: string }

/** Accept state only when this exact transaction's receipt and containing block agree. */
export async function verifyLfReceiptState<T>(options: {
	provider: any
	hash: string
	initialReceipt?: any
	readState: (block: LfReceiptBlock) => Promise<T>
	onReceipt: (receipt: LfReceiptEvidence) => void
	retry?: LfReadRetry
}): Promise<{ receipt: LfReceiptEvidence; block: LfReceiptBlock; state: T }> {
	const { provider, hash, readState, onReceipt } = options
	const { maxAttempts = 16, delayMs = 2000 } = options.retry ?? {}
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || !Number.isFinite(delayMs) || delayMs < 0)
		throw new Error("Invalid LF receipt retry settings")
	let receipt = options.initialReceipt ?? (await provider.getTransactionReceipt(hash))
	for (let attempt = 1; ; attempt++) {
		if (receipt) {
			if (receipt.hash?.toLowerCase() !== hash.toLowerCase()) throw new Error("LF receipt belongs to a different transaction")
			const observed: LfReceiptEvidence = {
				hash,
				blockNumber: Number(receipt.blockNumber),
				blockHash: receipt.blockHash,
				status: Number(receipt.status),
			}
			onReceipt(observed)
			if (!Number.isSafeInteger(observed.blockNumber) || observed.blockNumber < 0) throw new Error("LF receipt has an invalid block number")
			if (observed.status !== 1) throw new Error(`LF transaction ${hash} no longer has a successful receipt; stop before another write`)
			if (observed.blockHash && observed.blockHash !== ZeroHash) {
				const raw = await provider.getBlock(observed.blockNumber)
				if (raw?.number !== observed.blockNumber) throw new Error(`RPC returned the wrong LF receipt block for ${hash}`)
				const included = raw.transactions?.some((tx: any) => (typeof tx === "string" ? tx : tx.hash)?.toLowerCase() === hash.toLowerCase())
				if (raw.hash === observed.blockHash && included) {
					const block = { number: raw.number, hash: raw.hash, timestamp: String(raw.timestamp) }
					const state = await readState(block)
					const after = await provider.getBlock(block.number)
					if (after?.number === block.number && after.hash === block.hash) return { receipt: observed, block, state }
				}
			}
		}
		if (attempt >= maxAttempts)
			throw new Error(`LF receipt block ${receipt?.blockNumber ?? "unknown"} changed or remains inconsistent for ${hash}; resume after RPC agreement`)
		console.log(`LF waiting for receipt/block agreement for ${hash}; retrying in ${delayMs / 1000}s (${attempt + 1}/${maxAttempts})`)
		await delay(delayMs)
		// Refresh only this unsettled transaction. Never replay confirmed history or submit again here.
		receipt = await provider.getTransactionReceipt(hash)
	}
}
