/** Internal adapter for the registered ./symmio LF workflow. Direct invocation defaults to read-only. */
import hre from "hardhat"
import fs from "node:fs"
import path from "node:path"

import { requireExecutionConfirmation } from "../../tasks/deploy/executionGuard.js"
import { exportLfArtifacts, type LfPhase } from "../utils/lfArtifacts.js"
import { createLfPlan, parseLfConfig } from "../utils/lfUpdate.js"
import { inspectLf, reconcileLfReport, runLfUpdate, verifyLfUpdate } from "../utils/lfUpdateRuntime.js"
import { atomicWriteJson, verifyDigest } from "../utils/symbolSync.js"

const required = (name: string) => {
	const value = process.env[name]
	if (!value) throw new Error(`${name} is required`)
	return value
}
let outputContext: { directory: string; config: ReturnType<typeof parseLfConfig>; phase: LfPhase } | undefined
async function main() {
	const phase = process.env.LF_UPDATE_PHASE || "inspect"
	if (!["inspect", "plan", "apply", "reconcile", "verify"].includes(phase)) throw new Error("Invalid LF phase")
	const config = parseLfConfig(JSON.parse(required("LF_UPDATE_CONFIG")))
	const directory = path.resolve(required("LF_UPDATE_DIRECTORY"))
	outputContext = { directory, config, phase: phase as LfPhase }
	const connection = await hre.network.getOrCreate()
	if (connection.networkName !== config.network) throw new Error("Selected Hardhat network does not match LF configuration")
	const { ethers } = connection
	const network = await ethers.provider.getNetwork()
	if (network.chainId !== BigInt(config.chainId)) throw new Error("RPC chain ID does not match LF configuration")
	const execute = requireExecutionConfirmation(network.chainId)
	if (execute && phase !== "apply") throw new Error("Only the apply phase may execute")
	const read = (name: string) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))
	if (phase === "inspect") {
		atomicWriteJson(path.join(directory, "snapshot.json"), await inspectLf(ethers.provider, config))
		return
	}
	if (phase === "plan") {
		const snapshot = read("snapshot.json")
		if (verifyDigest(snapshot, "LF snapshot") !== required("LF_UPDATE_SNAPSHOT_DIGEST")) throw new Error("LF snapshot changed during review")
		if (JSON.stringify(snapshot.config) !== JSON.stringify(config)) throw new Error("LF snapshot configuration changed")
		const plan = createLfPlan(snapshot, process.env.LF_UPDATE_BTC_ETH_IDS || "")
		atomicWriteJson(path.join(directory, "plan.json"), plan)
		const quote = (value: unknown) => `"${String(value).replace(/"/g, '""')}"`
		fs.writeFileSync(
			path.join(directory, "preview.csv"),
			[
				"symbolId,name,isValid,minAcceptableQuoteValue,oldLF,targetLF",
				...plan.rows.map(row =>
					[row.symbolId, row.name, row.isValid, row.minAcceptableQuoteValue, row.minAcceptablePortionLF, row.targetLF].map(quote).join(","),
				),
			].join("\n") + "\n",
			{ mode: 0o600 },
		)
		return
	}
	const digest = required("LF_UPDATE_PLAN_DIGEST"),
		reportPath = path.join(directory, "report.json")
	if (phase === "reconcile") {
		await reconcileLfReport(ethers.provider, reportPath, digest, config.authority)
		return
	}
	const plan = read("plan.json")
	if (JSON.stringify(plan.snapshot.config) !== JSON.stringify(config)) throw new Error("LF plan configuration changed")
	const signer = execute
		? (await ethers.getSigners()).find(candidate => candidate.address.toLowerCase() === config.authority.toLowerCase())
		: undefined
	const options = { provider: ethers.provider, signer, plan, expectedDigest: digest, reportPath, execute }
	const report =
		phase === "verify"
			? await verifyLfUpdate(options)
			: await runLfUpdate({
					...options,
					deferFinalVerification: true,
					continueRun: process.env.LF_UPDATE_CONTINUATION === "true",
				})
	console.log(
		report.status === "complete"
			? `LF complete: ${report.completed}/${report.total} symbols verified.`
			: `LF ${report.status}: ${report.processed}/${report.total} symbols processed; final verification pending.`,
	)
}
async function run() {
	let succeeded = false
	try {
		await main()
		succeeded = true
	} finally {
		if (outputContext) {
			try {
				const output = exportLfArtifacts({ ...outputContext, succeeded })
				console.log(`LF output (${outputContext.config.chainId}): ${output.directory}`)
				for (const name of ["report.json", "verification.json"])
					if (output.files[name]) console.log(`LF ${name}: ${path.join(output.directory, output.files[name])}`)
			} catch (error) {
				if (succeeded) throw error
				// Keep the original adapter failure; never include raw RPC errors in exports.
				console.error("LF output export failed; working evidence remains in the run directory")
			}
		}
	}
}
run().catch(error => {
	// Do not serialize RPC request bodies or endpoint credentials into terminal/task output.
	console.error(
		String(error.reason || error.shortMessage || error.message || "LF operation failed").replace(/https?:\/\/\S+/g, "[redacted endpoint]"),
	)
	process.exitCode = 1
})
