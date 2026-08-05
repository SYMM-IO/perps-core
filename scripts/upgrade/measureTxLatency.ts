/**
 * Measure transaction confirmation latency on the target network.
 *
 * Sends a minimal native-token self-transfer and reports timing.
 * Use the results to estimate total migration / setSymbolTypes duration.
 *
 * Run:
 *   USE_KEYSTORE=true npx hardhat run scripts/upgrade/measureTxLatency.ts --network <network>
 *
 *   # Custom sample count (default 3):
 *   SAMPLES=5 USE_KEYSTORE=true npx hardhat run scripts/upgrade/measureTxLatency.ts --network <network>
 */
import type { TransactionResponse } from "ethers"

import { ethers } from "../../test/helpers/hardhat-connection.js"
import { log } from "./utils/log.js"
import { writeTxOverrides } from "./utils/txOverrides.js"

async function main() {
	const SAMPLES = Number(process.env.SAMPLES ?? 3)
	const [signer] = await ethers.getSigners()
	const to = ethers.Wallet.createRandom().address

	log.info(`Signer:  ${signer.address}`)
	log.info(`To:      ${to}`)
	log.info(`Samples: ${SAMPLES}`)
	log.info("")

	// --- Sequential ---
	log.info("=== Sequential ===")
	const seqSubmitTimes: number[] = []
	const seqConfirmTimes: number[] = []

	for (let i = 0; i < SAMPLES; i++) {
		const t0 = performance.now()
		const tx = await signer.sendTransaction({ to, value: 0n, ...writeTxOverrides() })
		const tSent = performance.now()
		const receipt = await tx.wait()
		const tMined = performance.now()

		const submitMs = Math.round(tSent - t0)
		const confirmMs = Math.round(tMined - tSent)
		const totalMs = Math.round(tMined - t0)
		seqSubmitTimes.push(submitMs)
		seqConfirmTimes.push(confirmMs)
		log.ok(`  sample ${i + 1}: submit ${submitMs}ms, confirm ${confirmMs}ms, total ${totalMs}ms (block ${receipt!.blockNumber})`)
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
	const txPromises = Array.from({ length: SAMPLES }, (_, i) => signer.sendTransaction({ to, value: 0n, nonce: baseNonce + i, ...txOverrides }))
	const txs = await Promise.all(txPromises)
	const parTSent = performance.now()
	const receipts = await Promise.all(txs.map((tx: TransactionResponse) => tx.wait()))
	const parTMined = performance.now()

	const parSubmitMs = Math.round(parTSent - parT0)
	const parConfirmMs = Math.round(parTMined - parTSent)
	const parTotalMs = Math.round(parTMined - parT0)

	for (let i = 0; i < receipts.length; i++) {
		log.ok(`  sample ${i + 1}: block ${receipts[i]!.blockNumber}`)
	}

	log.info("")
	log.info("--- Parallel Results ---")
	log.info(`  submit all ${SAMPLES}:  ${parSubmitMs}ms`)
	log.info(`  confirm all ${SAMPLES}: ${parConfirmMs}ms`)
	log.info(`  total:       ${parTotalMs}ms`)
	log.info(`  per-tx avg:  ${Math.round(parTotalMs / SAMPLES)}ms`)
	log.info("")
	log.info("--- Parallel Estimates ---")
	log.info(`  50 chunks:  ${fmt((parTotalMs / SAMPLES) * 50)}`)
	log.info(`  100 chunks: ${fmt((parTotalMs / SAMPLES) * 100)}`)
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
