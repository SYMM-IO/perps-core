import fs from "node:fs"
import path from "node:path"

import type { LfConfig } from "./lfUpdate.js"
import { atomicWriteJson, verifyDigest } from "./symbolSync.js"

export type LfPhase = "inspect" | "plan" | "apply" | "reconcile" | "verify"

/** Export reviewable evidence without relocating the paused run's bound working files. */
export function exportLfArtifacts(options: { directory: string; config: LfConfig; phase: LfPhase; succeeded: boolean; createdAt?: string }) {
	const { directory, config, phase, succeeded } = options
	const createdAt = options.createdAt ?? new Date().toISOString()
	if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) throw new Error("Invalid LF output chain ID")
	if (new Date(createdAt).toISOString() !== createdAt) throw new Error("LF output timestamp must be an ISO UTC datetime")
	const stamp = createdAt.replace(/[-:]/g, "")
	const prefix = `${config.chainId}-${stamp}-${phase}`
	const outputDirectory = path.join(directory, "outputs", String(config.chainId), `${stamp}-${phase}`)
	const names =
		phase === "inspect"
			? ["snapshot.json"]
			: phase === "plan"
				? ["snapshot.json", "plan.json", "preview.csv"]
				: ["snapshot.json", "plan.json", "preview.csv", "report.json"]
	const existing = names.filter(name => fs.existsSync(path.join(directory, name)))
	const read = (name: string) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))
	const plan = fs.existsSync(path.join(directory, "plan.json")) ? read("plan.json") : undefined
	const snapshot = fs.existsSync(path.join(directory, "snapshot.json")) ? read("snapshot.json") : undefined
	for (const [name, value] of [
		["plan", plan],
		["snapshot", snapshot],
	] as const) {
		if (!value) continue
		verifyDigest(value, `LF ${name}`)
		const bound = name === "plan" ? value.snapshot.config : value.config
		if (
			bound.chainId !== config.chainId ||
			bound.core.toLowerCase() !== config.core.toLowerCase() ||
			bound.symbolManager.toLowerCase() !== config.symbolManager.toLowerCase()
		)
			throw new Error(`LF ${name} does not belong to this output deployment`)
	}
	const report = existing.includes("report.json") ? read("report.json") : undefined
	if (plan && snapshot && plan.snapshot.digest !== snapshot.digest) throw new Error("LF snapshot does not belong to this output plan")
	if (report && (!plan || report.planDigest !== plan.digest || report.authority.toLowerCase() !== config.authority.toLowerCase()))
		throw new Error("LF report does not belong to this output plan")
	fs.mkdirSync(path.dirname(outputDirectory), { recursive: true, mode: 0o700 })
	// A repeated timestamp must never overwrite previously exported evidence.
	fs.mkdirSync(outputDirectory, { mode: 0o700 })
	const files: Record<string, string> = {}
	for (const name of existing) {
		files[name] = `${prefix}-${name}`
		fs.copyFileSync(path.join(directory, name), path.join(outputDirectory, files[name]), fs.constants.COPYFILE_EXCL)
		fs.chmodSync(path.join(outputDirectory, files[name]), 0o600)
	}
	if (phase === "verify") {
		files["verification.json"] = `${prefix}-verification.json`
		atomicWriteJson(path.join(outputDirectory, files["verification.json"]), {
			...report?.verification,
			apiVersion: "operations.symm.io/lf-verification-v1",
			chainId: config.chainId,
			network: config.network,
			core: config.core,
			symbolManager: config.symbolManager,
			createdAt,
			planDigest: plan?.digest,
			status:
				succeeded &&
				report?.status === "complete" &&
				report.total > 0 &&
				report.pending === 0 &&
				report.verification?.symbols?.length === report.total
					? "verified"
					: "incomplete",
			total: report?.total,
			completed: report?.completed,
			pending: report?.pending,
		})
	}
	const manifest = {
		apiVersion: "operations.symm.io/lf-output-v1",
		chainId: config.chainId,
		network: config.network,
		core: config.core,
		symbolManager: config.symbolManager,
		createdAt,
		phase,
		adapterStatus: succeeded ? "succeeded" : "failed",
		planDigest: plan?.digest,
		files,
	}
	atomicWriteJson(path.join(outputDirectory, `${prefix}-manifest.json`), manifest)
	atomicWriteJson(path.join(directory, "latest-output.json"), { ...manifest, directory: outputDirectory })
	return { directory: outputDirectory, files }
}
