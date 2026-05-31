/**
 * Verify the generated upgrade/migrate calldata against the local repo.
 *
 * Reads the JSON batches under scripts/upgrade/output/ and reconstructs the
 * expected calldata using the same builders the generators use, then
 * byte-compares every transaction. Catches tampered or stale batches, wrong
 * addresses, missing parameters, or out-of-sync timelock chains before they
 * are ever signed by the Safe.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/verifyBatchCalldata.ts --network arbitrum
 *
 *   # Subset via env (comma-separated labels)
 *   ONLY=pause-safe-batch,safe-batch,diamondcut-calldata \
 *     npx hardhat run scripts/upgrade/verifyBatchCalldata.ts --network arbitrum
 *
 *   # Skip expensive artifact cross-check
 *   VERIFY_ARTIFACTS=false npx hardhat run scripts/upgrade/verifyBatchCalldata.ts --network arbitrum
 *
 *   # Custom config file locations
 *   VERIFY_BATCH_CONFIG_FILE=./my-verify.json \
 *     npx hardhat run scripts/upgrade/verifyBatchCalldata.ts --network arbitrum
 *
 * Config (optional): scripts/upgrade/config/verifyBatch.json
 *   {
 *     "networkName": "arbitrum",                    // override --network based file lookup
 *     "outputDir": "./scripts/upgrade/output",
 *     "configDir": "./scripts/upgrade/config",
 *     "only":  ["pause-safe-batch", "safe-batch", "diamondcut-calldata", ...],  // opt-in list
 *     "skip":  ["add-templates-safe-batch"],                                     // opt-out list
 *     "verifyFacetSelectorsAgainstArtifacts": true,
 *     "paths": {                                    // per-file overrides
 *       "safeBatch": "./custom/safe-batch.json",
 *       ...
 *     }
 *   }
 */
import fs from "fs"
import path from "path"

import connection from "../../test/helpers/hardhat-connection.js"
import {
	type FileCheck,
	loadVerifyContext,
	verifyAddTemplatesBatch,
	verifyDiamondCutCalldata,
	verifyPauseSafeBatch,
	verifyPostMigrationSafeBatch,
	verifyPostMigrationTransactions,
	verifySafeBatch,
	verifySingleRoleBatch,
	verifyTimelockBatches,
} from "./utils/batchVerifier.js"
import { log } from "./utils/log.js"

// ============================================================================
// CLI / config
// ============================================================================

type VerifyBatchConfig = {
	networkName?: string
	outputDir?: string
	configDir?: string
	only?: string[]
	skip?: string[]
	verifyFacetSelectorsAgainstArtifacts?: boolean
	paths?: Record<string, string>
}

const DEFAULT_CONFIG_FILE = "./scripts/upgrade/config/verifyBatch.json"

const ALL_LABELS = [
	"pause-safe-batch",
	"safe-batch",
	"diamondcut-calldata",
	"timelock-schedule-safe-batch",
	"timelock-execute-safe-batch",
	"post-migration-safe-batch",
	"post-migration-transactions",
	"grant-symbol-role-safe-batch",
	"revoke-symbol-role-safe-batch",
	"add-templates-safe-batch",
] as const

function loadVerifyBatchConfig(): VerifyBatchConfig {
	const file = process.env.VERIFY_BATCH_CONFIG_FILE ?? DEFAULT_CONFIG_FILE
	if (!fs.existsSync(file)) return {}
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as VerifyBatchConfig
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		throw new Error(`Failed to parse ${file}: ${msg}`)
	}
}

function parseCsvEnv(name: string): string[] | undefined {
	const raw = process.env[name]
	if (!raw) return undefined
	return raw
		.split(",")
		.map(s => s.trim())
		.filter(Boolean)
}

function pickLabels(cfg: VerifyBatchConfig): Set<string> {
	const onlyEnv = parseCsvEnv("ONLY")
	const skipEnv = parseCsvEnv("SKIP")
	const only = onlyEnv ?? cfg.only
	const skip = new Set((skipEnv ?? cfg.skip ?? []).map(l => l.toLowerCase()))

	const base = only && only.length > 0 ? new Set(only.map(l => l.toLowerCase())) : new Set(ALL_LABELS.map(l => l.toLowerCase()))
	for (const s of skip) base.delete(s)
	return base
}

async function main() {
	log.header("Verify batch calldata against local repo")

	const cfg = loadVerifyBatchConfig()
	const networkName = process.env.NETWORK_NAME ?? cfg.networkName ?? connection.networkName
	const outputDir = path.resolve(process.env.OUTPUT_DIR ?? cfg.outputDir ?? "./scripts/upgrade/output")
	const configDir = path.resolve(cfg.configDir ?? "./scripts/upgrade/config")
	const verifyArtifacts = (process.env.VERIFY_ARTIFACTS ?? String(cfg.verifyFacetSelectorsAgainstArtifacts ?? true)).toLowerCase() !== "false"

	log.kv("Network", networkName)
	log.kv("Output dir", outputDir)
	log.kv("Config dir", configDir)
	log.kv("Artifact cross-check", String(verifyArtifacts))

	// Map user-facing "paths" keys to the camelCased keys of LoadedContext.paths
	const pathOverrides = cfg.paths ? Object.fromEntries(Object.entries(cfg.paths).map(([k, v]) => [k, path.resolve(v)])) : {}

	const ctx = await loadVerifyContext({
		networkName,
		outputDir,
		configDir,
		paths: pathOverrides,
		verifyFacetSelectorsAgainstArtifacts: verifyArtifacts,
	})

	log.kv("Diamond", ctx.diamondAddress)
	log.kv("Safe", ctx.safeAddress || "(unset)")
	log.kv("Protocol admin", ctx.protocolAdmin)
	log.kv("Migration runner", ctx.migrationRunner)
	log.kv("Timelock", ctx.timelockAddress ?? "(unset)")
	log.kv("AccountLayer", ctx.accountLayerAddress ?? "(unset)")
	log.kv("InstantLayer", ctx.instantLayerAddress ?? "(unset)")
	log.kv("SymbolManager", ctx.symbolManagerAddress ?? "(unset)")
	log.kv("Signature verifier", ctx.signatureVerifierAddress ?? "(unset)")
	log.kv("PartyBs to register", String(ctx.partyBsToRegister.length))
	log.kv("Templates", String(ctx.templates.length))
	log.kv("Deployed facets", String(Object.keys(ctx.deployedFacets).length))
	log.blank()

	const labels = pickLabels(cfg)
	log.info(`Running checks: ${[...labels].join(", ")}`)
	log.blank()

	const checks: FileCheck[] = []

	const run = async (label: string, runner: () => Promise<FileCheck> | FileCheck): Promise<void> => {
		if (!labels.has(label)) return
		const result = await runner()
		checks.push(result)
		printCheck(result)
	}

	await run("pause-safe-batch", () => verifyPauseSafeBatch(ctx))
	await run("safe-batch", () => verifySafeBatch(ctx))
	await run("diamondcut-calldata", () => verifyDiamondCutCalldata(ctx, { verifySelectorsAgainstArtifacts: verifyArtifacts }))
	await run("timelock-schedule-safe-batch", () => verifyTimelockBatches(ctx, "schedule", {}))
	await run("timelock-execute-safe-batch", () => verifyTimelockBatches(ctx, "execute", {}))
	await run("post-migration-safe-batch", () => verifyPostMigrationSafeBatch(ctx))
	await run("post-migration-transactions", () => verifyPostMigrationTransactions(ctx))
	await run("grant-symbol-role-safe-batch", () => verifySingleRoleBatch(ctx, "grant"))
	await run("revoke-symbol-role-safe-batch", () => verifySingleRoleBatch(ctx, "revoke"))
	await run("add-templates-safe-batch", () => verifyAddTemplatesBatch(ctx))

	// Summary
	log.blank()
	const passed = checks.filter(c => c.ok && !c.skipped).length
	const failed = checks.filter(c => !c.ok)
	const skipped = checks.filter(c => c.skipped)
	const totalIssues = failed.reduce((sum, c) => sum + c.issues.length, 0)

	if (failed.length === 0) {
		log.success("Batch calldata verification passed", [
			["Files checked", String(checks.length - skipped.length)],
			["Skipped", String(skipped.length)],
		])
		return
	}

	log.failure(
		`Batch calldata verification failed (${failed.length} file(s), ${totalIssues} issue(s))`,
		failed.map(c => `${c.label}: ${c.issues.length} issue(s)`).join("\n  "),
	)
	log.blank()
	log.info(`Passed:  ${passed}`)
	log.info(`Skipped: ${skipped.length}`)
	log.info(`Failed:  ${failed.length}`)
	process.exitCode = 1
}

function printCheck(check: FileCheck): void {
	const summary = (check as FileCheck & { summary?: string }).summary
	if (check.skipped) {
		log.warn(`${check.label} — skipped (${check.skipReason ?? "unknown"})`)
		return
	}
	if (check.ok) {
		log.ok(`${check.label}${summary ? ` (${summary})` : ""}`)
		return
	}
	log.error(`${check.label} — ${check.issues.length} issue(s)`)
	for (const issue of check.issues) {
		log.detail(issue)
	}
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
