import fs from "fs"
import path from "path"

import { ethers } from "../../../test/helpers/hardhat-connection.js"
import { log } from "./log.js"

/**
 * Preflight checks that should run before any upgrade/migration script starts
 * touching on-chain state. Each check is independent — the runner collects
 * failures and raises them together so the user sees everything that needs
 * fixing instead of fixing one thing, re-running, fixing the next, etc.
 *
 * Interpretation B: each check lives in one function with a comment pointing
 * to the real-world scenario it guards against. Non-obvious cases also have
 * POC entries in `tests/upgrade/preflight.test.ts`.
 */

export type PreflightContext = {
	diamondAddress?: string
	signatureVerifierAddress?: string
	subgraphEndpoint?: string
	expectedChainId?: number
	/** Paths of state files that must (if they exist) be consistent with the current run. */
	stateFiles?: string[]
	/** Skip checks that require network calls (useful for unit tests). */
	offline?: boolean
}

type CheckResult = { name: string; ok: boolean; message?: string }

const CHAIN_ID_BY_NETWORK: Record<string, number> = {
	arbitrum: 42161,
	base: 8453,
	mantle: 5000,
	bsc: 56,
	polygon: 137,
	blast: 81457,
	mode: 34443,
}

/**
 * Main entry point. Runs every configured check, prints a per-check status line,
 * and throws a single error listing all failures. No-op on individual checks
 * whose inputs are missing (e.g. no signatureVerifierAddress → skip that check).
 */
export async function runPreflight(networkName: string | undefined, ctx: PreflightContext): Promise<void> {
	log.header("Preflight Checks")
	const baseName = networkName && networkName.startsWith("fork-") ? networkName.slice("fork-".length) : networkName
	if (baseName && ctx.expectedChainId === undefined && CHAIN_ID_BY_NETWORK[baseName] !== undefined) {
		ctx.expectedChainId = CHAIN_ID_BY_NETWORK[baseName]
	}

	const results: CheckResult[] = []
	const push = (r: CheckResult): void => {
		results.push(r)
		if (r.ok) log.ok(r.name)
		else log.error(`${r.name}${r.message ? ` — ${r.message}` : ""}`)
	}

	push(checkRequiredConfigFields(ctx))
	if (!ctx.offline) {
		push(await checkChainId(ctx.expectedChainId))
		push(await checkDiamondHasCode(ctx.diamondAddress))
		push(await checkSignatureVerifierHasCode(ctx.signatureVerifierAddress))
		push(await checkSubgraphReachable(ctx.subgraphEndpoint))
	}
	push(checkStaleStateFiles(ctx.diamondAddress, ctx.stateFiles ?? []))

	const failures = results.filter(r => !r.ok)
	if (failures.length > 0) {
		const msg = failures.map(f => `  - ${f.name}${f.message ? `: ${f.message}` : ""}`).join("\n")
		throw new Error(`Preflight failed with ${failures.length} check(s):\n${msg}`)
	}
}

/**
 * Catches: operator ran a script against the wrong chain (forgot --network flag,
 * or RPC_BASE points at a wrong endpoint that still accepts requests but returns
 * a different chainId).
 */
async function checkChainId(expectedChainId: number | undefined): Promise<CheckResult> {
	if (!expectedChainId) return { name: "Chain ID", ok: true, message: "no expected chain configured — skipped" }
	try {
		const net = await ethers.provider.getNetwork()
		const actual = Number(net.chainId)
		if (actual !== expectedChainId) {
			return { name: "Chain ID", ok: false, message: `expected ${expectedChainId}, got ${actual}` }
		}
		return { name: "Chain ID", ok: true, message: `${actual}` }
	} catch (err) {
		return { name: "Chain ID", ok: false, message: (err as Error).message }
	}
}

/**
 * Catches: diamondAddress typo or stale address from a different chain (e.g.
 * using Mantle diamond on fork-base). An address with no code will pass the
 * JSON-RPC ABI decode step and revert only deep inside the first transaction.
 */
async function checkDiamondHasCode(diamondAddress?: string): Promise<CheckResult> {
	if (!diamondAddress) return { name: "Diamond has code", ok: false, message: "diamondAddress is not set" }
	try {
		const code = await ethers.provider.getCode(diamondAddress)
		if (!code || code === "0x") {
			return { name: "Diamond has code", ok: false, message: `no code at ${diamondAddress} on this chain` }
		}
		return { name: "Diamond has code", ok: true, message: diamondAddress }
	} catch (err) {
		return { name: "Diamond has code", ok: false, message: (err as Error).message }
	}
}

/**
 * Catches: signatureVerifierAddress in newV085Parameters points at an address
 * with no contract. If we run setSignatureVerifierAddress with this, the upgrade
 * completes but every Muon-verified action fails post-upgrade.
 */
async function checkSignatureVerifierHasCode(verifierAddress?: string): Promise<CheckResult> {
	if (!verifierAddress) return { name: "Signature verifier has code", ok: true, message: "not configured — skipped" }
	try {
		const code = await ethers.provider.getCode(verifierAddress)
		if (!code || code === "0x") {
			return { name: "Signature verifier has code", ok: false, message: `no code at ${verifierAddress}` }
		}
		return { name: "Signature verifier has code", ok: true, message: verifierAddress }
	} catch (err) {
		return { name: "Signature verifier has code", ok: false, message: (err as Error).message }
	}
}

/**
 * Catches: subgraph endpoint is down / rate-limited / wrong URL. Failing here
 * is much cheaper than failing 5 minutes into prepareMigrationInput after the
 * system is already paused.
 */
async function checkSubgraphReachable(endpoint?: string): Promise<CheckResult> {
	if (!endpoint) return { name: "Subgraph reachable", ok: true, message: "not configured — skipped" }
	try {
		const res = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "{ _meta { block { number } } }" }),
			signal: AbortSignal.timeout(10_000),
		})
		if (!res.ok) return { name: "Subgraph reachable", ok: false, message: `HTTP ${res.status}` }
		const body = (await res.json()) as any
		if (body.errors) return { name: "Subgraph reachable", ok: false, message: JSON.stringify(body.errors) }
		const block = body?.data?._meta?.block?.number
		return { name: "Subgraph reachable", ok: true, message: block ? `indexed up to block ${block}` : "responded" }
	} catch (err) {
		return { name: "Subgraph reachable", ok: false, message: (err as Error).message }
	}
}

/**
 * Catches: operator forgot to clean up output/deployed-*.json from a previous
 * run on a different chain. The resume-safe facet/peripheral deployers would
 * otherwise skip deployment and apply a cut referencing addresses that have no
 * code on the current chain (we hit exactly this during fork-arbitrum testing).
 */
function checkStaleStateFiles(diamondAddress: string | undefined, files: string[]): CheckResult {
	if (!diamondAddress) return { name: "No stale state files", ok: true, message: "no diamondAddress to check against" }
	const stale: string[] = []
	for (const file of files) {
		if (!fs.existsSync(file)) continue
		try {
			const data = JSON.parse(fs.readFileSync(file, "utf-8"))
			const recorded = (data?.diamondAddress as string | undefined) ?? (data?.diamond as string | undefined)
			if (recorded && recorded.toLowerCase() !== diamondAddress.toLowerCase()) {
				stale.push(`${path.basename(file)} references ${recorded} but current diamond is ${diamondAddress}`)
			}
		} catch {
			// File exists but isn't JSON we can validate — skip rather than error,
			// since an unreadable file may be partial/corrupt from a prior crash
			// and the running script will replace it anyway.
		}
	}
	if (stale.length > 0) {
		return {
			name: "No stale state files",
			ok: false,
			message: `${stale.length} mismatched file(s): ${stale.join("; ")}`,
		}
	}
	return { name: "No stale state files", ok: true, message: `${files.length} file(s) checked` }
}

/**
 * Catches: required config fields missing or obviously wrong (zero address,
 * malformed hex). Cheap to check; blocks later failure modes.
 */
function checkRequiredConfigFields(ctx: PreflightContext): CheckResult {
	const problems: string[] = []
	if (!ctx.diamondAddress) problems.push("diamondAddress is not set")
	else if (!ethers.isAddress(ctx.diamondAddress) || ctx.diamondAddress === ethers.ZeroAddress) {
		problems.push(`diamondAddress is invalid: ${ctx.diamondAddress}`)
	}
	if (ctx.signatureVerifierAddress && (!ethers.isAddress(ctx.signatureVerifierAddress) || ctx.signatureVerifierAddress === ethers.ZeroAddress)) {
		problems.push(`signatureVerifierAddress is invalid: ${ctx.signatureVerifierAddress}`)
	}
	if (problems.length > 0) {
		return { name: "Required config fields", ok: false, message: problems.join("; ") }
	}
	return { name: "Required config fields", ok: true }
}
