import { Contract, Interface, ZeroAddress, id, keccak256 } from "ethers"
import fs from "node:fs"

import { emitTaskEvent } from "../../tasks/deploy/logger.js"
import { reconcileDeploymentTransactions, send, type DeploymentTransactionRecord } from "../../tasks/deploy/tx.js"
import { retryLfReads, type LfReadRetry } from "./lfReadRetry.js"
import { verifyLfReceiptState, type LfReceiptEvidence } from "./lfReceipt.js"
import {
	LF_CORE_ABI,
	LF_MANAGER_ABI,
	LF_ROLE_NAME,
	analyzeLfState,
	assertLfCatalog,
	buildLfAction,
	classifyLfSymbols,
	createLfPlan,
	lfCapacity,
	lfTarget,
	parseLfConfig,
	serializeLfSymbol,
	type LfConfig,
	type LfPlan,
	type LfSymbol,
} from "./lfUpdate.js"
import { atomicWriteJson, verifyDigest, withDigest } from "./symbolSync.js"

const PAGE_SIZE = 200
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const coreInterface = new Interface(LF_CORE_ABI)

async function blockAt(provider: any, tag: "latest" | number, expectedHash?: string) {
	const block = await provider.getBlock(tag)
	if (!block?.hash) throw new Error(`LF verification block ${tag} is unavailable; resume when the RPC can serve it`)
	if (typeof tag === "number" && block.number !== tag)
		throw new Error(`RPC returned block ${block.number} instead of LF verification block ${tag}; reconcile before continuing`)
	if (expectedHash && block.hash !== expectedHash) throw new Error(`LF receipt block ${tag} changed; reconcile before continuing`)
	return { number: block.number, hash: block.hash, timestamp: String(block.timestamp) }
}
async function latestBlock(provider: any, minimumBlock = 0) {
	const block = await blockAt(provider, "latest")
	// A load-balanced RPC can expose a receipt before its latest-block read catches up.
	// Never interpret a pre-transaction catalog as pending work, including on resume.
	return block.number < minimumBlock ? blockAt(provider, minimumBlock) : block
}
async function identityAt(provider: any, config: LfConfig, block: number) {
	const core = new Contract(config.core, LF_CORE_ABI, provider)
	const identity: Record<string, string> = {}
	for (const [name, address] of [
		["core", config.core],
		["manager", config.symbolManager],
	]) {
		const code = await provider.getCode(address, block)
		if (code === "0x") throw new Error(`No ${name} bytecode; stop and escalate this deployment`)
		identity[name] = keccak256(code)
	}
	for (const method of ["getSymbols", "getSymbolsWithType", "setSymbolAcceptableValues"]) {
		const address = await core.facetAddress(coreInterface.getFunction(method)!.selector, { blockTag: block })
		if (address === ZeroAddress && method === "getSymbolsWithType") continue
		if (address === ZeroAddress) throw new Error(`Missing ${method}; stop and escalate this deployment for contract review`)
		const code = await provider.getCode(address, block)
		if (code === "0x") throw new Error(`Missing ${method} implementation bytecode`)
		identity[method] = `${address.toLowerCase()}:${keccak256(code)}`
	}
	return identity
}
async function readCatalog(
	provider: any,
	config: LfConfig,
	identity: Record<string, string>,
	block: number,
	start = 0,
	size?: number,
): Promise<LfSymbol[]> {
	const core = new Contract(config.core, LF_CORE_ABI, provider)
	const method = identity.getSymbolsWithType ? "getSymbolsWithType" : "getSymbols"
	const symbols: LfSymbol[] = []
	for (let offset = start; ; offset += PAGE_SIZE) {
		const count = size === undefined ? PAGE_SIZE : Math.min(PAGE_SIZE, size - symbols.length)
		if (count <= 0) break
		const page = await core[method](offset, count, { blockTag: block })
		symbols.push(...page.map(serializeLfSymbol))
		if (page.length < count) break
		if (symbols.length > 100_000) throw new Error("Unexpected catalog size; stop for review")
	}
	return symbols
}
async function managerState(provider: any, config: LfConfig, block: { number: number; timestamp: string }) {
	const manager = new Contract(config.symbolManager, LF_MANAGER_ABI, provider),
		core = new Contract(config.core, LF_CORE_ABI, provider)
	const overrides = { blockTag: block.number }
	const [wiring, paused, role, allowed, coreRole, limits, used, lastReset] = await Promise.all([
		manager.symmioAddress(overrides),
		manager.paused(overrides),
		manager[LF_ROLE_NAME](overrides),
		manager.hasRole(id(LF_ROLE_NAME), config.authority, overrides),
		core.hasRole(config.symbolManager, id("SYMBOL_MANAGER_ROLE"), overrides),
		manager.dailyLimits(overrides),
		manager.dailyOperations(overrides),
		manager.lastResetTimestamp(overrides),
	])
	if (!same(wiring, config.core)) throw new Error("Symbol Manager points to a different Core")
	if (role !== id(LF_ROLE_NAME)) throw new Error("Unsupported LF role; escalate this manager deployment")
	if (!coreRole) throw new Error("Symbol Manager lacks its Core SYMBOL_MANAGER_ROLE")
	if (!allowed) throw new Error(`Operator ${config.authority} lacks ${LF_ROLE_NAME}`)
	if (paused) throw new Error("Symbol Manager is paused")
	return {
		limit: String(limits.acceptableValues),
		used: String(used.acceptableValues),
		lastReset: String(lastReset),
		...lfCapacity(String(limits.acceptableValues), String(used.acceptableValues), String(lastReset), block.timestamp),
	}
}
export async function inspectLf(provider: any, rawConfig: unknown) {
	const config = parseLfConfig(rawConfig)
	if ((await provider.getNetwork()).chainId !== BigInt(config.chainId)) throw new Error("Connected chain does not match LF configuration")
	const block = await latestBlock(provider),
		identity = await identityAt(provider, config, block.number)
	const state = await managerState(provider, config, block)
	const symbols = await readCatalog(provider, config, identity, block.number)
	assertLfCatalog(symbols)
	console.log(`LF inventory: ${symbols.length} symbols at block ${block.number}; available updates ${state.remaining}`)
	return withDigest({
		apiVersion: "operations.symm.io/lf-snapshot-v1",
		config,
		block,
		identity,
		manager: state,
		symbols,
		classification: classifyLfSymbols(symbols),
	})
}
export function validateLfPlan(plan: LfPlan, expectedDigest?: string): void {
	const digest = verifyDigest(plan, "LF plan")
	if (!expectedDigest || expectedDigest !== digest) throw new Error("LF plan is not bound to the reviewed digest")
	if (plan.apiVersion !== "operations.symm.io/lf-plan-v1") throw new Error("Unsupported LF plan")
	const rebuilt = createLfPlan(plan.snapshot, plan.btcEthIds.join(","))
	if (rebuilt.digest !== digest) throw new Error("LF plan does not match its snapshot and reviewed classification")
}
type LfTransaction = DeploymentTransactionRecord & {
	actionId?: string
	symbolIds?: string[]
	receiptObservations?: LfReceiptEvidence[]
	// Retained when resuming reports written by the earlier per-batch verifier.
	postState?: { block: Awaited<ReturnType<typeof blockAt>>; symbols: LfSymbol[]; pendingSymbolIds: string[] }
}
export type LfReport = {
	apiVersion: string
	planDigest: string
	authority: string
	status: string
	transactions: LfTransaction[]
	updatedAt?: string
	block?: any
	capacity?: any
	completed?: number
	processed?: number
	observedTargetIds?: string[]
	total?: number
	nextEligibleAt?: string
	verification?: { block: any; symbols: LfSymbol[] }
	pending?: number
}
function saveReport(file: string, report: LfReport) {
	report.updatedAt = new Date().toISOString()
	// RPC error payloads can carry endpoint credentials. Persist public transaction evidence only.
	const sanitized = {
		...report,
		transactions: report.transactions.map(tx => ({
			...tx,
			...(tx.error ? { error: "Transaction did not confirm successfully; reconcile its recorded hash and inspect the task log." } : {}),
		})),
	}
	atomicWriteJson(file, sanitized)
}
export async function reconcileLfReport(provider: any, file: string, expectedDigest: string, authority: string): Promise<LfReport> {
	const report: LfReport = fs.existsSync(file)
		? JSON.parse(fs.readFileSync(file, "utf8"))
		: {
				apiVersion: "operations.symm.io/lf-report-v1",
				planDigest: expectedDigest,
				authority,
				status: "prepared",
				transactions: [],
			}
	if (
		report.apiVersion !== "operations.symm.io/lf-report-v1" ||
		report.planDigest !== expectedDigest ||
		!same(report.authority, authority) ||
		!Array.isArray(report.transactions)
	)
		throw new Error("LF report binding mismatch")
	const uncertain = report.transactions.filter(tx => tx.status === "unresolved" || tx.status === "timed_out")
	if (!uncertain.length) return report
	try {
		await reconcileDeploymentTransactions(uncertain, provider, authority)
	} finally {
		for (const transaction of uncertain) {
			emitTaskEvent(transaction.status === "confirmed" || transaction.status === "replaced" ? "tx.confirmed" : "tx.failed", { transaction })
		}
		saveReport(file, report)
	}
	return report
}
async function checkIdentity(provider: any, plan: LfPlan, block: number) {
	const observed = await identityAt(provider, plan.snapshot.config, block)
	if (JSON.stringify(observed) !== JSON.stringify(plan.snapshot.identity))
		throw new Error("Contract implementation changed; stop and escalate before continuing")
}
async function simulate(provider: any, config: LfConfig, action: ReturnType<typeof buildLfAction>) {
	await provider.call({ to: action.to, from: config.authority, data: action.data, value: 0n })
	return provider.estimateGas({ to: action.to, from: config.authority, data: action.data, value: 0n })
}
function confirmedTransactions(report: LfReport) {
	return report.transactions.filter(tx => tx.status === "confirmed" || tx.status === "replaced")
}
function confirmedFloor(plan: LfPlan, report: LfReport) {
	return confirmedTransactions(report).reduce((minimum, tx) => Math.max(minimum, tx.blockNumber ?? 0), plan.snapshot.block.number)
}
function confirmedSymbolIds(plan: LfPlan, report: LfReport): Set<string> {
	const result = new Set<string>()
	for (const transaction of confirmedTransactions(report)) {
		const config = plan.snapshot.config
		const decoded = new Interface(LF_MANAGER_ABI).decodeFunctionData("setSymbolAcceptableValuesBatch", transaction.data!)
		const ids: string[] = decoded[0].map(String)
		if (
			!ids.length ||
			new Set(ids).size !== ids.length ||
			ids.some((id, i) => !plan.snapshot.symbols[Number(id) - 1] || (i > 0 && BigInt(id) <= BigInt(ids[i - 1])))
		)
			throw new Error("Recorded LF transaction contains invalid symbol IDs")
		const expected = buildLfAction(
			config.symbolManager,
			ids.map(id => plan.snapshot.symbols[Number(id) - 1]),
			plan.btcEthIds,
		)
		if (
			!same(transaction.from ?? "", config.authority) ||
			!same(transaction.to ?? "", config.symbolManager) ||
			transaction.value !== "0" ||
			transaction.data !== expected.data
		)
			throw new Error("Recorded LF transaction does not match the reviewed plan")
		transaction.symbolIds = ids
		ids.forEach(id => result.add(id))
	}
	return result
}
function observeReceipt(transaction: LfTransaction, receipt: LfReceiptEvidence) {
	transaction.receiptObservations ??= []
	if (!transaction.receiptObservations.some(observed => JSON.stringify(observed) === JSON.stringify(receipt)))
		transaction.receiptObservations.push(receipt)
}
type LfVerificationOptions = {
	provider: any
	plan: LfPlan
	expectedDigest: string
	reportPath: string
	readRetry?: LfReadRetry
}
/** Read-only final proof. A failed proof can be retried without executing the apply step. */
export async function verifyLfUpdate(options: LfVerificationOptions): Promise<LfReport> {
	const { plan, expectedDigest, reportPath } = options
	const provider = retryLfReads(options.provider, options.readRetry)
	validateLfPlan(plan, expectedDigest)
	if ((await provider.getNetwork()).chainId !== BigInt(plan.snapshot.config.chainId)) throw new Error("Wrong chain for LF plan")
	const report = await reconcileLfReport(provider, reportPath, expectedDigest, plan.snapshot.config.authority)
	confirmedSymbolIds(plan, report)
	report.status = "verification-pending"
	delete report.verification
	saveReport(reportPath, report)
	const readFinal = async (minimumBlock: number) => {
		const block = await latestBlock(provider, minimumBlock)
		await checkIdentity(provider, plan, block.number)
		const symbols = await readCatalog(provider, plan.snapshot.config, plan.snapshot.identity, block.number)
		await blockAt(provider, block.number, block.hash)
		return { block, symbols }
	}
	try {
		const last = confirmedTransactions(report).at(-1)
		let verification: { block: Awaited<ReturnType<typeof blockAt>>; symbols: LfSymbol[] }
		if (last) {
			const result = await verifyLfReceiptState({
				provider,
				hash: last.replacementHash ?? last.hash,
				initialReceipt: last.receiptObservations?.at(-1),
				retry: options.readRetry,
				readState: block => readFinal(Math.max(block.number, confirmedFloor(plan, report))),
				onReceipt: receipt => {
					observeReceipt(last, receipt)
					saveReport(reportPath, report)
				},
			})
			last.blockNumber = result.block.number
			verification = result.state
		} else verification = await readFinal(plan.snapshot.block.number)
		report.verification = verification
		const analysis = analyzeLfState(plan.snapshot.symbols, verification.symbols, plan.btcEthIds)
		Object.assign(report, {
			block: verification.block,
			completed: analysis.complete,
			total: verification.symbols.length,
			pending: analysis.pending.length,
		})
		if (analysis.pending.length) throw new Error(`LF final verification failed: ${analysis.pending.length} symbols do not match their targets`)
		report.status = "complete"
		return report
	} catch (error) {
		report.status = "verification-failed"
		throw error
	} finally {
		saveReport(reportPath, report)
	}
}
/** One bounded window. All signer writes go through send() and its persistent write-ahead hook. */
export async function runLfUpdate(options: {
	provider: any
	signer?: any
	plan: LfPlan
	expectedDigest: string
	reportPath: string
	execute: boolean
	maxBatches?: number
	readRetry?: LfReadRetry
	continueRun?: boolean
	deferFinalVerification?: boolean
}): Promise<LfReport> {
	const { signer, plan, expectedDigest, reportPath, execute } = options
	const provider = retryLfReads(options.provider, options.readRetry)
	validateLfPlan(plan, expectedDigest)
	const config = parseLfConfig(plan.snapshot.config)
	if ((await provider.getNetwork()).chainId !== BigInt(config.chainId)) throw new Error("Wrong chain for LF plan")
	if (execute && (!signer || !same(await signer.getAddress(), config.authority)))
		throw new Error("Selected signer does not match the reviewed LF operator")
	const snapshotBlock = await provider.getBlock(plan.snapshot.block.number)
	if (snapshotBlock?.hash !== plan.snapshot.block.hash) throw new Error("Snapshot block changed or is unavailable; review a new plan")
	const report = await reconcileLfReport(provider, reportPath, expectedDigest, config.authority)
	const confirmedIds = confirmedSymbolIds(plan, report)
	let block = await latestBlock(provider, confirmedFloor(plan, report))
	await checkIdentity(provider, plan, block.number)
	let current: LfSymbol[]
	if (options.continueRun) {
		if (!execute || report.status !== "ready" || !report.observedTargetIds) throw new Error("LF continuation requires a successful preceding window")
		const expectedIds = new Set([...report.observedTargetIds, ...confirmedIds])
		if ([...expectedIds].some(id => plan.snapshot.symbols[Number(id) - 1]?.symbolId !== id)) throw new Error("Invalid LF continuation symbol IDs")
		current = plan.snapshot.symbols.map((symbol: LfSymbol) => ({
			...symbol,
			minAcceptablePortionLF: expectedIds.has(symbol.symbolId) ? lfTarget(symbol.symbolId, plan.btcEthIds) : symbol.minAcceptablePortionLF,
		}))
	} else {
		// Starting or resuming always observes the whole catalog. Continuous windows reuse receipt-backed progress.
		current = await readCatalog(provider, config, plan.snapshot.identity, block.number)
		const observed = analyzeLfState(plan.snapshot.symbols, current, plan.btcEthIds)
		if (observed.pending.some(symbol => confirmedIds.has(symbol.symbolId)))
			throw new Error("A previously confirmed LF update is no longer at target; inspect its receipt and current state before another write")
		report.completed = observed.complete
		report.observedTargetIds = current
			.filter(symbol => symbol.minAcceptablePortionLF === lfTarget(symbol.symbolId, plan.btcEthIds))
			.map(symbol => symbol.symbolId)
	}
	delete report.verification
	let analysis = analyzeLfState(plan.snapshot.symbols, current, plan.btcEthIds)
	let sent = 0
	while (analysis.pending.length) {
		block = await latestBlock(provider, Math.max(block.number, confirmedFloor(plan, report)))
		await checkIdentity(provider, plan, block.number)
		const capacity = await managerState(provider, config, block)
		Object.assign(report, { block, capacity, processed: analysis.complete, total: current.length, pending: analysis.pending.length })
		if (!capacity.remaining) {
			report.status = "waiting-daily-limit"
			report.nextEligibleAt = capacity.resetDue
				? "Ask the Symbol Manager administrator to increase the acceptableValues quota"
				: new Date(Number(capacity.resetAt) * 1000).toISOString()
			break
		}
		if (execute && Number(block.timestamp) * 1000 < Date.parse(config.enforcementAt)) {
			report.status = "waiting-enforcement"
			report.nextEligibleAt = config.enforcementAt
			break
		}
		const selected = analysis.pending.slice(0, Math.min(config.batchSize, capacity.remaining))
		// Re-read the selected span immediately before each write. Never restore stale quote minima.
		const start = Number(selected[0].symbolId) - 1,
			end = Number(selected.at(-1)!.symbolId)
		const fresh = await readCatalog(provider, config, plan.snapshot.identity, block.number, start, end - start)
		analyzeLfState(plan.snapshot.symbols.slice(start, end), fresh, plan.btcEthIds)
		current.splice(start, fresh.length, ...fresh)
		analysis = analyzeLfState(plan.snapshot.symbols, current, plan.btcEthIds)
		const stillPending = selected.filter(symbol => analysis.pending.some(pending => pending.symbolId === symbol.symbolId))
		if (!stillPending.length) continue
		const action = buildLfAction(config.symbolManager, stillPending, plan.btcEthIds)
		const gas = await simulate(provider, config, action)
		console.log(`LF batch ${action.symbolIds[0]}–${action.symbolIds.at(-1)}: ${action.symbolIds.length} updates; estimated gas ${gas}`)
		if (!execute) {
			report.status = "ready"
			break
		}
		const fee = await provider.getFeeData()
		const fees =
			fee.maxFeePerGas != null && fee.maxPriorityFeePerGas != null
				? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
				: { gasPrice: fee.gasPrice }
		if (fees.gasPrice === null) throw new Error("RPC returned no usable transaction fee estimate")
		let receipt: Awaited<ReturnType<typeof send>>
		try {
			receipt = await send(
				signer.sendTransaction({ to: action.to, data: action.data, value: 0n, gasLimit: (gas * 120n) / 100n, ...fees }),
				`Update LF for symbol IDs ${action.symbolIds.join(",")}`,
				undefined,
				{
					onSubmitted: record => {
						report.transactions.push(Object.assign(record, { actionId: action.id, symbolIds: action.symbolIds }))
						report.status = "transaction-submitted"
						saveReport(reportPath, report)
					},
				},
			)
		} finally {
			saveReport(reportPath, report)
		}
		const transaction = report.transactions.at(-1)!
		observeReceipt(transaction, {
			hash: receipt.hash,
			blockNumber: receipt.blockNumber,
			blockHash: receipt.blockHash,
			status: Number(receipt.status),
		})
		// Successful receipts advance expected progress. Symbol state is proved once, after all batches.
		for (const symbolId of action.symbolIds) current[Number(symbolId) - 1].minAcceptablePortionLF = lfTarget(symbolId, plan.btcEthIds)
		analysis = analyzeLfState(plan.snapshot.symbols, current, plan.btcEthIds)
		report.status = "batch-confirmed"
		saveReport(reportPath, report)
		sent++
		console.log(`LF progress: ${analysis.complete}/${current.length} symbols processed; receipt confirmed, final verification pending`)
		if (sent >= (options.maxBatches ?? 5)) {
			report.status = "ready"
			break
		}
	}
	Object.assign(report, { block, processed: analysis.complete, total: current.length, pending: analysis.pending.length })
	if (!analysis.pending.length) report.status = "submitted"
	saveReport(reportPath, report)
	if (report.status === "submitted" && !options.deferFinalVerification) return verifyLfUpdate(options)
	return report
}
