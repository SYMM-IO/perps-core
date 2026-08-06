/**
 * Measure transaction confirmation latency on the target network.
 *
 * Sends a minimal native-token self-transfer and reports timing.
 * Use the results to estimate total migration / setSymbolTypes duration.
 *
 * Run:
 *   EXECUTE_TEST_TX=true EXPECTED_CHAIN_ID=<chain-id> USE_KEYSTORE=true \
 *     ./node_modules/.bin/hardhat run scripts/upgrade/measureTxLatency.ts --network <network>
 *
 *   # Custom sample count (default 3):
 *   SAMPLES=5 EXECUTE_TEST_TX=true EXPECTED_CHAIN_ID=<chain-id> USE_KEYSTORE=true \
 *     ./node_modules/.bin/hardhat run scripts/upgrade/measureTxLatency.ts --network <network>
 */
import type { TransactionResponse } from "ethers"

import { ethers } from "../../test/helpers/hardhat-connection.js"
import { log } from "./utils/log.js"
import { writeTxOverrides } from "./utils/txOverrides.js"

function requiredExpectedChainId(): bigint {
	const value = process.env.EXPECTED_CHAIN_ID
	if (!value || !/^[1-9]\d*$/.test(value)) {
		throw new Error("EXPECTED_CHAIN_ID must be an explicit positive integer")
	}
	return BigInt(value)
}

function parseSampleCount(): number {
	const value = process.env.SAMPLES ?? "3"
	if (!/^\d+$/.test(value)) throw new Error(`SAMPLES must be a positive integer; received ${value}`)
	const samples = Number(value)
	if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100) {
		throw new Error(`SAMPLES must be between 1 and 100; received ${value}`)
	}
	return samples
}

async function main(): Promise<void> {
	if (process.env.EXECUTE_TEST_TX !== "true") {
		throw new Error("Refusing to send test transactions. Set EXECUTE_TEST_TX=true explicitly.")
	}

	const expectedChainId = requiredExpectedChainId()
	const samples = parseSampleCount()
	const network = await ethers.provider.getNetwork()
	if (network.chainId !== expectedChainId) {
		throw new Error(`Chain mismatch: connected to ${network.chainId}, expected ${expectedChainId}`)
	}

	const [signer] = await ethers.getSigners()
	if (!signer) throw new Error("No signer is configured for this network")
	const signerAddress = await signer.getAddress()

	log.header("Transaction Latency Probe")
	log.info(`Chain:   ${network.chainId}`)
	log.info(`Signer:  ${signerAddress}`)
	log.info("Type:    zero-value self-transfer")
	log.info(`Samples: ${samples} sequential + ${samples} parallel`)
	log.info("")

	// --- Sequential ---
	log.info("=== Sequential ===")
	const seqSubmitTimes: number[] = []
	const seqConfirmTimes: number[] = []

	for (let i = 0; i < samples; i++) {
		const t0 = performance.now()
		const tx = await signer.sendTransaction({ to: signerAddress, value: 0n, ...writeTxOverrides() })
		const tSent = performance.now()
		const receipt = await tx.wait()
		const tMined = performance.now()
		if (!receipt || receipt.status !== 1) throw new Error(`Sequential test transaction failed: ${tx.hash}`)

		const submitMs = Math.round(tSent - t0)
		const confirmMs = Math.round(tMined - tSent)
		const totalMs = Math.round(tMined - t0)
		seqSubmitTimes.push(submitMs)
		seqConfirmTimes.push(confirmMs)
		log.ok(`  sample ${i + 1}: submit ${submitMs}ms, confirm ${confirmMs}ms, total ${totalMs}ms (block ${receipt.blockNumber})`)
	}

	const seqAvgSubmit = seqSubmitTimes.reduce((a, b) => a + b, 0) / seqSubmitTimes.length
	const seqAvgConfirm = seqConfirmTimes.reduce((a, b) => a + b, 0) / seqConfirmTimes.length
	const seqAvgTotal = seqAvgSubmit + seqAvgConfirm

	log.info("")
	log.info("--- Sequential Results ---")
	log.info(`  avg submit:  ${Math.round(seqAvgSubmit)}ms`)
	log.info(`  avg confirm: ${Math.round(seqAvgConfirm)}ms`)
	log.info(`  avg total:   ${Math.round(seqAvgTotal)}ms`)
	log.info("")
	log.info("--- Sequential Estimates ---")
	log.info(`  50 chunks:  ${fmt(seqAvgTotal * 50)}`)
	log.info(`  100 chunks: ${fmt(seqAvgTotal * 100)}`)

	// --- Parallel ---
	log.info("")
	log.info("=== Parallel ===")
	const baseNonce = await signer.getNonce()
	const txOverrides = writeTxOverrides()
	const parT0 = performance.now()
	const txPromises = Array.from({ length: samples }, (_, i) =>
		signer.sendTransaction({ to: signerAddress, value: 0n, nonce: baseNonce + i, ...txOverrides }),
	)
	const txs = await Promise.all(txPromises)
	const parTSent = performance.now()
	const receipts = await Promise.all(txs.map((tx: TransactionResponse) => tx.wait()))
	const parTMined = performance.now()
	for (let i = 0; i < receipts.length; i++) {
		if (!receipts[i] || receipts[i]!.status !== 1) throw new Error(`Parallel test transaction failed: ${txs[i].hash}`)
	}

	const parSubmitMs = Math.round(parTSent - parT0)
	const parConfirmMs = Math.round(parTMined - parTSent)
	const parTotalMs = Math.round(parTMined - parT0)

	for (let i = 0; i < receipts.length; i++) {
		log.ok(`  sample ${i + 1}: block ${receipts[i]!.blockNumber}`)
	}

	log.info("")
	log.info("--- Parallel Results ---")
	log.info(`  submit all ${samples}:  ${parSubmitMs}ms`)
	log.info(`  confirm all ${samples}: ${parConfirmMs}ms`)
	log.info(`  total:       ${parTotalMs}ms`)
	log.info(`  per-tx avg:  ${Math.round(parTotalMs / samples)}ms`)
	log.info("")
	log.info("--- Parallel Estimates ---")
	log.info(`  50 chunks:  ${fmt((parTotalMs / samples) * 50)}`)
	log.info(`  100 chunks: ${fmt((parTotalMs / samples) * 100)}`)
}

function fmt(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`
	const s = ms / 1000
	if (s < 60) return `${s.toFixed(1)}s`
	return `${(s / 60).toFixed(1)}min`
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
