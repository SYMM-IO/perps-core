/**
 * Send reviewed admin actions from a Ledger through Foundry's `cast send --ledger`, the path the
 * Arbitrum governance handover used for the same admin. Derivation-path discovery and receipt
 * parsing come from ledgerHandover.ts.
 */
import { getAddress } from "ethers"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import type { SafeAction } from "./instantLayerMigration.js"
import { ledgerAddressFromOutput, ledgerArguments, ledgerCandidatePaths, receiptHash } from "./ledgerHandover.js"

export interface CastLedgerOptions {
	castBin?: string
	rpcUrl: string
	chainId: bigint | number
	admin: string
	confirmations?: number
	timeoutSeconds?: number
	/** Number of standard Ledger paths to scan when the cache has no match (default 20). */
	scanCount?: number
	/** JSON file remembering which derivation path produced `admin`. */
	pathCacheFile?: string
	log?: (message: string) => void
}

export function castSendArguments(
	action: SafeAction,
	options: Pick<CastLedgerOptions, "admin" | "chainId" | "confirmations" | "timeoutSeconds">,
	derivationPath: string,
): string[] {
	if (action.value !== "0") throw new Error("cast ledger sender only handles zero-value actions")
	return [
		"send",
		getAddress(action.to),
		action.data,
		"--from",
		getAddress(options.admin),
		"--chain",
		BigInt(options.chainId).toString(),
		"--confirmations",
		String(options.confirmations ?? 1),
		"--timeout",
		String(options.timeoutSeconds ?? 300),
		"--json",
		...ledgerArguments(derivationPath),
	]
}

function runCast(castBin: string, args: string[], env: NodeJS.ProcessEnv): string {
	const result = spawnSync(castBin, args, { encoding: "utf8", env, stdio: ["inherit", "pipe", "pipe"] })
	const stderr = (result.stderr ?? "").replace(/(?:https?):\/\/[^\s'"`<>]+/giu, "<redacted-rpc-url>").trim()
	if (stderr) console.error(stderr)
	if (result.error) throw new Error(`failed to start ${castBin}: ${result.error.message}`)
	if (result.status !== 0) throw new Error(`${castBin} exited with status ${String(result.status)}`)
	return result.stdout ?? ""
}

function readCachedPath(file: string | undefined, admin: string): string | undefined {
	if (!file || !fs.existsSync(file)) return undefined
	try {
		const cache = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>
		return cache[admin.toLowerCase()]
	} catch {
		return undefined
	}
}

function writeCachedPath(file: string | undefined, admin: string, derivationPath: string): void {
	if (!file) return
	let cache: Record<string, string> = {}
	try {
		if (fs.existsSync(file)) cache = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>
	} catch {}
	cache[admin.toLowerCase()] = derivationPath
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`)
}

/** Find the derivation path on the connected Ledger that yields `admin`; cached once found. */
export function discoverLedgerPath(options: CastLedgerOptions): string {
	const castBin = options.castBin ?? "cast"
	const admin = getAddress(options.admin)
	const env = { ...process.env, ETH_RPC_URL: options.rpcUrl }
	const log = options.log ?? (() => {})
	const cached = readCachedPath(options.pathCacheFile, admin)
	const candidates = cached
		? [cached, ...ledgerCandidatePaths(options.scanCount ?? 20).filter(p => p !== cached)]
		: ledgerCandidatePaths(options.scanCount ?? 20)
	log(`scanning ${candidates.length} Ledger derivation paths for ${admin}`)
	for (const derivationPath of candidates) {
		const output = runCast(castBin, ["wallet", "address", ...ledgerArguments(derivationPath)], env)
		if (ledgerAddressFromOutput(output, derivationPath).toLowerCase() === admin.toLowerCase()) {
			writeCachedPath(options.pathCacheFile, admin, derivationPath)
			log(`Ledger path ${derivationPath} matches ${admin}`)
			return derivationPath
		}
	}
	throw new Error(`Ledger address ${admin} was not found across ${candidates.length} paths; connect the right device or raise LEDGER_SCAN_COUNT`)
}

/** Send every action from the Ledger, one device confirmation each. Returns the receipt hashes. */
export function executeActionsWithCastLedger(actions: SafeAction[], options: CastLedgerOptions): string[] {
	const castBin = options.castBin ?? "cast"
	const env = { ...process.env, ETH_RPC_URL: options.rpcUrl, ETH_FROM: getAddress(options.admin) }
	const log = options.log ?? (() => {})
	const derivationPath = discoverLedgerPath(options)
	const hashes: string[] = []
	actions.forEach((action, index) => {
		log(`[${index + 1}/${actions.length}] ${action.description} (confirm on the Ledger)`)
		const output = runCast(castBin, castSendArguments(action, options, derivationPath), env)
		const hash = receiptHash(output)
		hashes.push(hash)
		log(`confirmed ${hash}`)
	})
	return hashes
}
