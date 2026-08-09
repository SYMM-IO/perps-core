import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { log } from "./utils/log.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { baseNetworkName, loadUpgradeConfigShared } from "./utils/sharedConfig.js"
import { fetchPartyBBalances } from "./utils/subgraphHelpers.js"

/**
 * Snapshot on-chain balances for sanity-checking total funds in the protocol.
 *
 * NOT on the migration critical path. Reads partyA addresses from the
 * migration-input.json that prepareMigrationInput.ts produced, re-fetches
 * partyB allocated totals from the subgraph, and queries on-chain deposit +
 * allocated balances. Robust to flaky RPCs (retries with backoff and bounded
 * concurrency).
 *
 * Usage:
 *   ./node_modules/.bin/hardhat run scripts/upgrade/snapshotBalances.ts --network <network>
 *
 * Env vars (all optional):
 *   MIGRATION_INPUT_FILE   Defaults to scripts/upgrade/output/migration-input.json
 *   SNAPSHOT_OUTPUT_FILE   Defaults to scripts/upgrade/output/balance-snapshot.json
 *   SNAPSHOT_CONCURRENCY   Number of in-flight RPC calls (default: 8)
 *   SNAPSHOT_MAX_RETRIES   Retries per call before giving up (default: 5)
 *
 * Output:
 *   scripts/upgrade/output/balance-snapshot.json
 */

type MigrationInputFile = {
	diamondAddress: string
	subgraphEndpoint?: string
	partyBTasks: Array<{ partyB: string; partyAs: string[] }>
}

type PartyABalance = { deposit: string; allocated: string }
type PartyBBalance = { deposit: string; allocatedTotal: string }

type BalanceSnapshot = {
	generatedAt: string
	diamondAddress: string
	source: { migrationInputFile: string; subgraphEndpoint: string }
	partyA: Record<string, PartyABalance>
	partyB: Record<string, PartyBBalance>
	summary: {
		partyA: {
			count: number
			totalDeposit: string
			totalAllocated: string
			totalFunds: string
			topDeposit: { address: string; amount: string }
			topAllocated: { address: string; amount: string }
		}
		partyB: {
			count: number
			totalDeposit: string
			totalAllocated: string
			totalFunds: string
			topDeposit: { address: string; amount: string }
			topAllocated: { address: string; amount: string }
		}
	}
}

const DEFAULT_OUTPUT_DIR = "./scripts/upgrade/output"
// Default filenames are network-suffixed so multi-chain rehearsals don't overwrite each other.
const NETWORK_SUFFIX = baseNetworkName(connection.networkName)
const defaultSuffixed = (baseName: string): string =>
	NETWORK_SUFFIX ? `${DEFAULT_OUTPUT_DIR}/${baseName}-${NETWORK_SUFFIX}.json` : `${DEFAULT_OUTPUT_DIR}/${baseName}.json`
const DEFAULT_INPUT_FILE = defaultSuffixed("migration-input")
const DEFAULT_OUTPUT_FILE = defaultSuffixed("balance-snapshot")

function ensureParentDir(filePath: string): void {
	const dir = path.dirname(filePath)
	if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function toBigInt(value: unknown): bigint {
	if (typeof value === "bigint") return value
	if (typeof value === "number") return BigInt(value)
	if (typeof value === "string") return BigInt(value)
	return BigInt((value as any).toString())
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

async function withRetry<T>(label: string, maxRetries: number, fn: () => Promise<T>): Promise<T> {
	let attempt = 0
	let delay = 500
	while (true) {
		try {
			return await fn()
		} catch (error) {
			attempt += 1
			if (attempt > maxRetries) {
				throw new Error(`${label} failed after ${maxRetries} retries: ${(error as Error).message}`)
			}
			log.warn(`${label} attempt ${attempt}/${maxRetries} failed (${(error as Error).message}); retrying in ${delay}ms`)
			await sleep(delay)
			delay = Math.min(delay * 2, 10_000)
		}
	}
}

async function runWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length)
	let nextIndex = 0
	const lanes: Promise<void>[] = []
	const lane = async () => {
		while (true) {
			const i = nextIndex++
			if (i >= items.length) return
			results[i] = await worker(items[i], i)
		}
	}
	for (let i = 0; i < Math.max(1, Math.min(concurrency, items.length)); i++) lanes.push(lane())
	await Promise.all(lanes)
	return results
}

async function main() {
	const scriptTimer = log.timer()
	await verifyRpc()
	const shared = loadUpgradeConfigShared(NETWORK_SUFFIX)

	const inputFile = process.env.MIGRATION_INPUT_FILE ?? DEFAULT_INPUT_FILE
	const outputFile = process.env.SNAPSHOT_OUTPUT_FILE ?? DEFAULT_OUTPUT_FILE
	const concurrency = Math.max(1, Number(process.env.SNAPSHOT_CONCURRENCY ?? 8))
	const maxRetries = Math.max(0, Number(process.env.SNAPSHOT_MAX_RETRIES ?? 5))

	if (!fs.existsSync(inputFile)) {
		throw new Error(`Migration input file not found: ${inputFile}\nRun prepareMigrationInput.ts first or set MIGRATION_INPUT_FILE.`)
	}
	const input = JSON.parse(fs.readFileSync(inputFile, "utf-8")) as MigrationInputFile
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? input.diamondAddress ?? shared.diamondAddress
	const SUBGRAPH_ENDPOINT = process.env.SUBGRAPH_ENDPOINT ?? input.subgraphEndpoint ?? shared.subgraphEndpoint
	if (!DIAMOND_ADDRESS || !ethers.isAddress(DIAMOND_ADDRESS)) {
		throw new Error("DIAMOND_ADDRESS could not be resolved (env, input file, or shared config)")
	}
	if (!SUBGRAPH_ENDPOINT) {
		throw new Error("SUBGRAPH_ENDPOINT could not be resolved (env, input file, or shared config)")
	}

	log.header("Snapshot On-Chain Balances")
	log.kv("Diamond", log.addr(DIAMOND_ADDRESS))
	log.kv("Subgraph", SUBGRAPH_ENDPOINT)
	log.kv("Input", inputFile)
	log.kv("Output", outputFile)
	log.kv("Concurrency", String(concurrency))
	log.kv("Max retries", String(maxRetries))

	log.setSteps(4)

	// Step 1: Collect partyA list from migration input
	let t = log.step("Collect partyA list from migration input")
	const partyASet = new Set<string>()
	for (const task of input.partyBTasks) {
		for (const partyA of task.partyAs) partyASet.add(partyA)
	}
	const partyAList = [...partyASet].sort()
	log.stats([["Unique partyAs", partyAList.length]])
	log.stepDone(t)

	// Step 2: Re-fetch partyB allocated totals from subgraph
	t = log.step("Fetch partyB balances from subgraph")
	const balancesResult = await fetchPartyBBalances(SUBGRAPH_ENDPOINT)
	const partyBAllocatedSums = new Map<string, bigint>()
	for (const e of balancesResult.entries) {
		partyBAllocatedSums.set(e.account, (partyBAllocatedSums.get(e.account) ?? 0n) + BigInt(e.allocatedBalance))
	}
	const partyBList = [...new Set(balancesResult.entries.map(e => e.account))].sort()
	log.stats([
		["Balance entries", balancesResult.entries.length],
		["Distinct partyBs", partyBList.length],
	])
	log.stepDone(t)

	// Step 3: Snapshot partyA balances on-chain
	t = log.step(`Snapshot ${partyAList.length} partyA balances`)
	const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", DIAMOND_ADDRESS)
	const partyABalances: Record<string, PartyABalance> = {}
	let partyADone = 0
	const partyAResults = await runWithConcurrency(partyAList, concurrency, async partyA => {
		const deposit = await withRetry(`balanceOf(${partyA})`, maxRetries, () => viewFacet.balanceOf(partyA).then(toBigInt))
		const allocated = await withRetry(`allocatedBalanceOfPartyA(${partyA})`, maxRetries, () =>
			viewFacet.allocatedBalanceOfPartyA(partyA).then(toBigInt),
		)
		partyADone += 1
		if (partyADone % 50 === 0 || partyADone === partyAList.length) {
			log.info(`  ${partyADone}/${partyAList.length} partyAs snapshotted`)
		}
		return { partyA, deposit, allocated }
	})
	for (const r of partyAResults) {
		partyABalances[r.partyA] = { deposit: r.deposit.toString(), allocated: r.allocated.toString() }
	}
	log.stepDone(t)

	// Step 4: Snapshot partyB balances on-chain
	t = log.step(`Snapshot ${partyBList.length} partyB balances`)
	const partyBBalances: Record<string, PartyBBalance> = {}
	const partyBResults = await runWithConcurrency(partyBList, concurrency, async partyB => {
		const deposit = await withRetry(`balanceOf(${partyB})`, maxRetries, () => viewFacet.balanceOf(partyB).then(toBigInt))
		return { partyB, deposit }
	})
	for (const r of partyBResults) {
		partyBBalances[r.partyB] = {
			deposit: r.deposit.toString(),
			allocatedTotal: (partyBAllocatedSums.get(r.partyB) ?? 0n).toString(),
		}
	}
	log.stepDone(t)

	// Compute summaries
	let partyATotalDeposit = 0n
	let partyATotalAllocated = 0n
	let partyATopDeposit = { address: "", amount: 0n }
	let partyATopAllocated = { address: "", amount: 0n }
	for (const [addr, bal] of Object.entries(partyABalances)) {
		const dep = BigInt(bal.deposit)
		const alloc = BigInt(bal.allocated)
		partyATotalDeposit += dep
		partyATotalAllocated += alloc
		if (dep > partyATopDeposit.amount) partyATopDeposit = { address: addr, amount: dep }
		if (alloc > partyATopAllocated.amount) partyATopAllocated = { address: addr, amount: alloc }
	}

	let partyBTotalDeposit = 0n
	let partyBTotalAllocated = 0n
	let partyBTopDeposit = { address: "", amount: 0n }
	let partyBTopAllocated = { address: "", amount: 0n }
	for (const [addr, bal] of Object.entries(partyBBalances)) {
		const dep = BigInt(bal.deposit)
		const alloc = BigInt(bal.allocatedTotal)
		partyBTotalDeposit += dep
		partyBTotalAllocated += alloc
		if (dep > partyBTopDeposit.amount) partyBTopDeposit = { address: addr, amount: dep }
		if (alloc > partyBTopAllocated.amount) partyBTopAllocated = { address: addr, amount: alloc }
	}

	const snapshot: BalanceSnapshot = {
		generatedAt: new Date().toISOString(),
		diamondAddress: DIAMOND_ADDRESS,
		source: { migrationInputFile: inputFile, subgraphEndpoint: SUBGRAPH_ENDPOINT },
		partyA: partyABalances,
		partyB: partyBBalances,
		summary: {
			partyA: {
				count: partyAList.length,
				totalDeposit: partyATotalDeposit.toString(),
				totalAllocated: partyATotalAllocated.toString(),
				totalFunds: (partyATotalDeposit + partyATotalAllocated).toString(),
				topDeposit: { address: partyATopDeposit.address, amount: partyATopDeposit.amount.toString() },
				topAllocated: { address: partyATopAllocated.address, amount: partyATopAllocated.amount.toString() },
			},
			partyB: {
				count: partyBList.length,
				totalDeposit: partyBTotalDeposit.toString(),
				totalAllocated: partyBTotalAllocated.toString(),
				totalFunds: (partyBTotalDeposit + partyBTotalAllocated).toString(),
				topDeposit: { address: partyBTopDeposit.address, amount: partyBTopDeposit.amount.toString() },
				topAllocated: { address: partyBTopAllocated.address, amount: partyBTopAllocated.amount.toString() },
			},
		},
	}

	ensureParentDir(outputFile)
	fs.writeFileSync(outputFile, JSON.stringify(snapshot, null, 2))

	log.stats([
		["PartyA total funds", `deposit=${partyATotalDeposit} + allocated=${partyATotalAllocated}`],
		["PartyA top deposit", `${log.truncAddr(partyATopDeposit.address)} = ${partyATopDeposit.amount}`],
		["PartyA top allocated", `${log.truncAddr(partyATopAllocated.address)} = ${partyATopAllocated.amount}`],
		["PartyB total funds", `deposit=${partyBTotalDeposit} + allocated=${partyBTotalAllocated}`],
		["PartyB top deposit", `${log.truncAddr(partyBTopDeposit.address)} = ${partyBTopDeposit.amount}`],
		["PartyB top allocated", `${log.truncAddr(partyBTopAllocated.address)} = ${partyBTopAllocated.amount}`],
	])

	log.success("Balance snapshot completed", [
		["Output", outputFile],
		["Duration", scriptTimer.fmt()],
	])
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
