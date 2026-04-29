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
import { ethers } from "../../test/helpers/hardhat-connection.js"
import { log } from "./utils/log.js"

async function main() {
	const SAMPLES = Number(process.env.SAMPLES ?? 3)
	const [signer] = await ethers.getSigners()
	const to = ethers.Wallet.createRandom().address

	log.info(`Signer:  ${signer.address}`)
	log.info(`To:      ${to}`)
	log.info(`Samples: ${SAMPLES}`)
	log.info("")

	const submitTimes: number[] = []
	const confirmTimes: number[] = []

	for (let i = 0; i < SAMPLES; i++) {
		const t0 = performance.now()
		const tx = await signer.sendTransaction({ to, value: 1n })
		const tSent = performance.now()
		const receipt = await tx.wait()
		const tMined = performance.now()

		const submitMs = Math.round(tSent - t0)
		const confirmMs = Math.round(tMined - tSent)
		const totalMs = Math.round(tMined - t0)
		submitTimes.push(submitMs)
		confirmTimes.push(confirmMs)
		log.ok(`  sample ${i + 1}: submit ${submitMs}ms, confirm ${confirmMs}ms, total ${totalMs}ms (block ${receipt!.blockNumber})`)
	}

	const avgSubmit = submitTimes.reduce((a, b) => a + b, 0) / submitTimes.length
	const avgConfirm = confirmTimes.reduce((a, b) => a + b, 0) / confirmTimes.length
	const avgTotal = avgSubmit + avgConfirm

	log.info("")
	log.info("--- Results ---")
	log.info(`  avg submit:  ${Math.round(avgSubmit)}ms`)
	log.info(`  avg confirm: ${Math.round(avgConfirm)}ms`)
	log.info(`  avg total:   ${Math.round(avgTotal)}ms`)
	log.info("")
	log.info("--- Estimates (sequential) ---")
	log.info(`  50 chunks:  ${fmt(avgTotal * 50)}`)
	log.info(`  100 chunks: ${fmt(avgTotal * 100)}`)
	log.info("")
	log.info("--- Estimates (parallel, all chunks at once) ---")
	log.info(`  Any count:  ~${fmt(avgConfirm)} (single confirmation window)`)
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
