/**
 * Apply one safe Symbol Manager daily window from a digest-bound symbol snapshot.
 * Rerun the same command/report after the daily limit resets; live state is always
 * reconciled before another transaction is considered.
 *
 * Plan only:
 *   SYMBOL_SYNC_INPUT=scripts/output/symbol-sync/hyperevm-to-arbitrum.snapshot.json \
 *     ./node_modules/.bin/hardhat run --no-compile scripts/symbols/assignSymbols.ts --network arbitrum
 *
 * Execute one resumable window:
 *   SYMBOL_SYNC_INPUT=... EXECUTE=true CONFIRM_CHAIN_ID=42161 \
 *     ./node_modules/.bin/hardhat run --no-compile scripts/symbols/assignSymbols.ts --network arbitrum
 */
import fs from "node:fs"
import path from "node:path"

import { requireExecutionConfirmation } from "../../tasks/deploy/executionGuard.js"
import { send, type DeploymentTransactionRecord } from "../../tasks/deploy/tx.js"
import { ethers } from "../../test/helpers/hardhat-connection.js"
import {
	SYMBOL_SYNC_ASSIGNMENT_API,
	SYMBOL_SYNC_SNAPSHOT_API,
	analyzeExactIdSync,
	atomicWriteJson,
	buildSymbolSyncWindow,
	parseSymbolSyncConfig,
	serializeSymbol,
	verifyDigest,
	type SerializedSymbol,
} from "../utils/symbolSync.js"

const SYMBOL_TUPLE =
	"tuple(uint256 symbolId,string name,bool isValid,uint256 minAcceptableQuoteValue,uint256 minAcceptablePortionLF,uint256 tradingFee,uint256 maxLeverage,uint256 fundingRateEpochDuration,uint256 fundingRateWindowTime,uint256 symbolType)"
const CORE_ABI = [
	`function getSymbolsWithType(uint256 start,uint256 size) view returns (${SYMBOL_TUPLE}[])`,
	"function hasRole(address user,bytes32 role) view returns (bool)",
]
const MANAGER_ABI = [
	`function addSymbolsWithType(${SYMBOL_TUPLE}[] symbolsWithType)`,
	"function activateSymbols(uint256[] symbolIds)",
	"function deactivateSymbols(uint256[] symbolIds)",
	"function symmioAddress() view returns (address)",
	"function paused() view returns (bool)",
	"function dailyLimits() view returns (uint256 symbolAddition,uint256 tradingFee,uint256 validationState,uint256 maxLeverage,uint256 acceptableValues,uint256 fundingState,uint256 forceCloseGapRatio)",
	"function dailyOperations() view returns (uint256 symbolAddition,uint256 tradingFee,uint256 validationState,uint256 maxLeverage,uint256 acceptableValues,uint256 fundingState,uint256 forceCloseGapRatio)",
	"function lastResetTimestamp() view returns (uint256)",
	"function SYMBOL_ADDER_ROLE() view returns (bytes32)",
	"function SYMBOL_REMOVER_ROLE() view returns (bytes32)",
	"function hasRole(bytes32 role,address account) view returns (bool)",
	"function getRoleMemberCount(bytes32 role) view returns (uint256)",
	"function getRoleMember(bytes32 role,uint256 index) view returns (address)",
]
const PAGE_SIZE = 200

type PlannedAction = {
	id: string
	kind: "add" | "activate" | "deactivate"
	symbolIds: string[]
	description: string
	to: string
	value: "0"
	data: string
	symbols?: SerializedSymbol[]
	simulation?: { status: "passed" | "deferred" | "not-run" | "failed"; reason?: string }
}

type AssignmentReport = {
	apiVersion: typeof SYMBOL_SYNC_ASSIGNMENT_API
	createdAt: string
	updatedAt: string
	snapshotPath: string
	snapshotDigest: string
	target: { network: string; chainId: string; core: string; symbolManager: string }
	status: string
	attempts: Array<Record<string, unknown>>
	transactions: Array<DeploymentTransactionRecord & { actionId?: string }>
	lastState?: Record<string, unknown>
	nextEligibleAt?: string
	lastError?: string
}

function requiredPath(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`${name} is required`)
	return path.resolve(value)
}

function readJson(file: string, label: string): Record<string, any> {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8"))
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object")
		return value
	} catch (error) {
		throw new Error(`Failed to read ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function readSnapshot(file: string): { snapshot: Record<string, any>; digest: string; desired: SerializedSymbol[]; config: any } {
	const snapshot = readJson(file, "symbol snapshot")
	if (snapshot.apiVersion !== SYMBOL_SYNC_SNAPSHOT_API) throw new Error(`Snapshot apiVersion must be ${SYMBOL_SYNC_SNAPSHOT_API}`)
	const digest = verifyDigest(snapshot, "Symbol snapshot")
	const config = parseSymbolSyncConfig(snapshot.config)
	if (!snapshot.source || !Array.isArray(snapshot.source.symbols)) throw new Error("Snapshot source.symbols is missing")
	const desired = snapshot.source.symbols.map(serializeSymbol)
	return { snapshot, digest, desired, config }
}

function loadReport(file: string, snapshotPath: string, snapshotDigest: string, config: any): AssignmentReport {
	if (!fs.existsSync(file)) {
		const now = new Date().toISOString()
		return {
			apiVersion: SYMBOL_SYNC_ASSIGNMENT_API,
			createdAt: now,
			updatedAt: now,
			snapshotPath: path.relative(process.cwd(), snapshotPath),
			snapshotDigest,
			target: {
				network: config.target.network,
				chainId: config.target.chainId,
				core: config.target.core,
				symbolManager: config.target.symbolManager,
			},
			status: "prepared",
			attempts: [],
			transactions: [],
		}
	}
	const report = readJson(file, "assignment report") as AssignmentReport
	if (report.apiVersion !== SYMBOL_SYNC_ASSIGNMENT_API) throw new Error(`Assignment report apiVersion must be ${SYMBOL_SYNC_ASSIGNMENT_API}`)
	if (report.snapshotDigest !== snapshotDigest) {
		throw new Error(`Assignment report is bound to ${report.snapshotDigest}, not input snapshot ${snapshotDigest}`)
	}
	for (const field of ["chainId", "core", "symbolManager"] as const) {
		if (String(report.target?.[field]).toLowerCase() !== String(config.target[field]).toLowerCase()) {
			throw new Error(`Assignment report target.${field} does not match the input snapshot`)
		}
	}
	if (!Array.isArray(report.attempts) || !Array.isArray(report.transactions)) throw new Error("Assignment report history is malformed")
	return report
}

function saveReport(file: string, report: AssignmentReport): void {
	report.updatedAt = new Date().toISOString()
	atomicWriteJson(file, report)
}

async function readCatalog(core: any, blockNumber: number): Promise<SerializedSymbol[]> {
	const result: SerializedSymbol[] = []
	for (let start = 0; ; start += PAGE_SIZE) {
		const page = await core.getSymbolsWithType(start, PAGE_SIZE, { blockTag: blockNumber })
		for (const symbol of page) result.push(serializeSymbol(symbol))
		if (page.length < PAGE_SIZE) break
	}
	return result
}

async function members(manager: any, role: string, blockNumber: number): Promise<string[]> {
	const count = await manager.getRoleMemberCount(role, { blockTag: blockNumber })
	const result: string[] = []
	for (let index = 0n; index < count; index++) result.push(await manager.getRoleMember(role, index, { blockTag: blockNumber }))
	return result
}

async function readTargetState(config: any, desired: SerializedSymbol[], authority?: string): Promise<Record<string, any>> {
	const blockNumber = await ethers.provider.getBlockNumber()
	const block = await ethers.provider.getBlock(blockNumber)
	if (!block) throw new Error(`Target block ${blockNumber} is unavailable`)
	if ((await ethers.provider.getCode(config.target.core, blockNumber)) === "0x") throw new Error(`No Core bytecode at ${config.target.core}`)
	if ((await ethers.provider.getCode(config.target.symbolManager, blockNumber)) === "0x") {
		throw new Error(`No Symbol Manager bytecode at ${config.target.symbolManager}`)
	}
	const core = new ethers.Contract(config.target.core, CORE_ABI, ethers.provider)
	const manager = new ethers.Contract(config.target.symbolManager, MANAGER_ABI, ethers.provider)
	const [symbols, symmioAddress, paused, limits, operations, lastResetTimestamp, adderRole, removerRole] = await Promise.all([
		readCatalog(core, blockNumber),
		manager.symmioAddress({ blockTag: blockNumber }),
		manager.paused({ blockTag: blockNumber }),
		manager.dailyLimits({ blockTag: blockNumber }),
		manager.dailyOperations({ blockTag: blockNumber }),
		manager.lastResetTimestamp({ blockTag: blockNumber }),
		manager.SYMBOL_ADDER_ROLE({ blockTag: blockNumber }),
		manager.SYMBOL_REMOVER_ROLE({ blockTag: blockNumber }),
	])
	if (ethers.getAddress(symmioAddress) !== ethers.getAddress(config.target.core)) {
		throw new Error(`Symbol Manager points to ${symmioAddress}, not configured Core ${config.target.core}`)
	}
	if (paused) throw new Error(`Symbol Manager ${config.target.symbolManager} is paused`)
	const symbolManagerRole = ethers.id("SYMBOL_MANAGER_ROLE")
	if (!(await core.hasRole(config.target.symbolManager, symbolManagerRole, { blockTag: blockNumber }))) {
		throw new Error(`Symbol Manager ${config.target.symbolManager} lacks SYMBOL_MANAGER_ROLE on Core ${config.target.core}`)
	}
	const [adderMembers, removerMembers, authorityHasAdder, authorityHasRemover] = await Promise.all([
		members(manager, adderRole, blockNumber),
		members(manager, removerRole, blockNumber),
		authority ? manager.hasRole(adderRole, authority, { blockTag: blockNumber }) : Promise.resolve(undefined),
		authority ? manager.hasRole(removerRole, authority, { blockTag: blockNumber }) : Promise.resolve(undefined),
	])
	const analysis = analyzeExactIdSync(desired, symbols)
	const window =
		analysis.status === "blocked"
			? null
			: buildSymbolSyncWindow(
					analysis,
					{ symbolAddition: BigInt(limits.symbolAddition), validationState: BigInt(limits.validationState) },
					{ symbolAddition: BigInt(operations.symbolAddition), validationState: BigInt(operations.validationState) },
					BigInt(lastResetTimestamp),
					BigInt(block.timestamp),
					config.execution.batchSize,
				)
	return {
		blockNumber,
		blockTimestamp: String(block.timestamp),
		symbols,
		analysis,
		window,
		manager: {
			paused,
			lastResetTimestamp: BigInt(lastResetTimestamp).toString(),
			dailyLimits: { symbolAddition: BigInt(limits.symbolAddition).toString(), validationState: BigInt(limits.validationState).toString() },
			dailyOperations: {
				symbolAddition: BigInt(operations.symbolAddition).toString(),
				validationState: BigInt(operations.validationState).toString(),
			},
			roles: {
				SYMBOL_ADDER_ROLE: { hash: adderRole, members: adderMembers },
				SYMBOL_REMOVER_ROLE: { hash: removerRole, members: removerMembers },
			},
		},
		authority: authority ? { address: authority, hasAdderRole: authorityHasAdder, hasRemoverRole: authorityHasRemover } : null,
	}
}

function symbolTuple(symbol: SerializedSymbol): unknown[] {
	return [
		BigInt(symbol.symbolId),
		symbol.name,
		symbol.isValid,
		BigInt(symbol.minAcceptableQuoteValue),
		BigInt(symbol.minAcceptablePortionLF),
		BigInt(symbol.tradingFee),
		BigInt(symbol.maxLeverage),
		BigInt(symbol.fundingRateEpochDuration),
		BigInt(symbol.fundingRateWindowTime),
		BigInt(symbol.symbolType),
	]
}

function actionId(kind: string, symbols: SerializedSymbol[]): string {
	return `${kind}-${symbols[0].symbolId}-${symbols.at(-1)?.symbolId}`
}

function buildActions(managerAddress: string, window: any): PlannedAction[] {
	if (!window) return []
	const iface = new ethers.Interface(MANAGER_ABI)
	const result: PlannedAction[] = []
	const validationAction = (kind: "activate" | "deactivate", symbols: SerializedSymbol[], suffix: string): void => {
		if (!symbols.length) return
		const ids = symbols.map(symbol => symbol.symbolId)
		const method = kind === "activate" ? "activateSymbols" : "deactivateSymbols"
		result.push({
			id: `${actionId(kind, symbols)}-${suffix}`,
			kind,
			symbolIds: ids,
			description: `${kind === "activate" ? "Activate" : "Deactivate"} symbol IDs ${ids.join(", ")}`,
			to: managerAddress,
			value: "0",
			data: iface.encodeFunctionData(method, [ids]),
		})
	}
	validationAction("deactivate", window.deactivateExisting, "existing")
	validationAction("activate", window.activateExisting, "existing")
	if (window.additions.length) {
		const ids = window.additions.map((symbol: SerializedSymbol) => symbol.symbolId)
		result.push({
			id: actionId("add", window.additions),
			kind: "add",
			symbolIds: ids,
			description: `Add ordered symbol IDs ${ids[0]} through ${ids.at(-1)}`,
			to: managerAddress,
			value: "0",
			data: iface.encodeFunctionData("addSymbolsWithType", [window.additions.map(symbolTuple)]),
			symbols: window.additions,
		})
	}
	validationAction("deactivate", window.deactivateAdded, "added")
	return result
}

async function simulateActions(actions: PlannedAction[], authority: string | undefined, targetSymbolCount: number): Promise<void> {
	for (const action of actions) {
		if (!authority) {
			action.simulation = { status: "not-run", reason: "No authority address was supplied" }
			continue
		}
		if (action.kind !== "add" && action.symbolIds.some(symbolId => BigInt(symbolId) > BigInt(targetSymbolCount))) {
			action.simulation = { status: "deferred", reason: "The IDs are created by the preceding addition action" }
			continue
		}
		try {
			await ethers.provider.call({ to: action.to, from: authority, data: action.data, value: 0n })
			action.simulation = { status: "passed" }
		} catch (error: any) {
			action.simulation = {
				status: "failed",
				reason: error?.reason || error?.shortMessage || (error instanceof Error ? error.message : String(error)),
			}
		}
	}
}

async function resolveAuthority(execute: boolean): Promise<{ address?: string; signer?: any; safe: boolean }> {
	const safeAddress = process.env.SYMMIO_SAFE_ADDRESS
	if (safeAddress) {
		if (!ethers.isAddress(safeAddress) || ethers.getAddress(safeAddress) === ethers.ZeroAddress) {
			throw new Error("SYMMIO_SAFE_ADDRESS must be a non-zero EVM address")
		}
		if (execute) throw new Error("Safe mode cannot broadcast directly; use the generated actions through the SYMMIO operator task")
		return { address: ethers.getAddress(safeAddress), safe: true }
	}
	const explicit = process.env.SYMBOL_SYNC_AUTHORITY || process.env.SYMMIO_EXPECTED_SIGNER
	if (explicit && (!ethers.isAddress(explicit) || ethers.getAddress(explicit) === ethers.ZeroAddress)) {
		throw new Error("Configured symbol-sync authority must be a non-zero EVM address")
	}
	if (!execute && !process.env.SYMMIO_SIGNER_MODE && !explicit) return { safe: false }
	const signers = await ethers.getSigners()
	let signer: (typeof signers)[number] | undefined = signers[0]
	if (explicit) signer = signers.find(candidate => candidate.address.toLowerCase() === explicit.toLowerCase())
	if (execute && !signer) throw new Error(`No configured signer matches ${explicit || "the target network"}`)
	return { address: signer ? ethers.getAddress(await signer.getAddress()) : ethers.getAddress(explicit!), signer, safe: false }
}

async function reconcileTransactions(report: AssignmentReport, reportPath: string): Promise<void> {
	for (const transaction of report.transactions) {
		if (!new Set(["submitted", "unresolved", "timed_out"]).has(transaction.status)) continue
		const hash = transaction.replacementHash || transaction.hash
		const receipt = await ethers.provider.getTransactionReceipt(hash)
		if (!receipt) {
			report.status = "blocked-unresolved-transaction"
			report.lastError = `Transaction ${hash} has no receipt; refusing to rebroadcast its action`
			saveReport(reportPath, report)
			throw new Error(report.lastError)
		}
		transaction.status = receipt.status === 1 ? "confirmed" : "failed"
		transaction.confirmedAt = new Date().toISOString()
		transaction.blockNumber = receipt.blockNumber
		transaction.gasUsed = receipt.gasUsed.toString()
		if (receipt.status !== 1) transaction.error = `Transaction reverted in block ${receipt.blockNumber}`
	}
	saveReport(reportPath, report)
}

function needsRoles(state: Record<string, any>): { adder: boolean; remover: boolean } {
	const analysis = state.analysis
	return {
		adder: analysis.additions.length > 0 || analysis.activate.length > 0,
		remover: analysis.deactivate.length > 0 || analysis.additions.some((symbol: SerializedSymbol) => !symbol.isValid),
	}
}

function reportState(state: Record<string, any>, actions: PlannedAction[]): Record<string, unknown> {
	return {
		blockNumber: state.blockNumber,
		blockTimestamp: state.blockTimestamp,
		targetSymbolCount: state.symbols.length,
		analysis: state.analysis,
		capacity: state.window?.capacity,
		authority: state.authority,
		manager: state.manager,
		plannedActions: actions,
	}
}

function statusFor(state: Record<string, any>, actions: PlannedAction[]): { status: string; nextEligibleAt?: string } {
	if (state.analysis.status === "blocked") return { status: "blocked-conflict" }
	if (state.analysis.status === "complete") return { status: "complete" }
	if (actions.length > 0) return { status: "ready" }
	const resetAt = BigInt(state.manager.lastResetTimestamp) + 86_400n
	return { status: "waiting-daily-limit", nextEligibleAt: new Date(Number(resetAt) * 1000).toISOString() }
}

async function executeAction(manager: any, action: PlannedAction, report: AssignmentReport, reportPath: string): Promise<void> {
	let transactionPromise: Promise<any>
	if (action.kind === "add") {
		const symbols = action.symbols!.map(symbolTuple)
		await manager.addSymbolsWithType.staticCall(symbols)
		transactionPromise = manager.addSymbolsWithType(symbols)
	} else if (action.kind === "activate") {
		await manager.activateSymbols.staticCall(action.symbolIds)
		transactionPromise = manager.activateSymbols(action.symbolIds)
	} else {
		await manager.deactivateSymbols.staticCall(action.symbolIds)
		transactionPromise = manager.deactivateSymbols(action.symbolIds)
	}
	try {
		await send(transactionPromise, action.description, undefined, {
			onSubmitted: record => {
				const bound = record as DeploymentTransactionRecord & { actionId?: string }
				bound.actionId = action.id
				report.transactions.push(bound)
				report.status = "transaction-submitted"
				saveReport(reportPath, report)
			},
		})
		saveReport(reportPath, report)
	} catch (error) {
		report.status = "execution-error"
		report.lastError = error instanceof Error ? error.message : String(error)
		saveReport(reportPath, report)
		throw error
	}
}

async function main(): Promise<void> {
	const snapshotPath = requiredPath("SYMBOL_SYNC_INPUT")
	const { digest, desired, config } = readSnapshot(snapshotPath)
	const network = await ethers.provider.getNetwork()
	if (network.chainId !== BigInt(config.target.chainId)) {
		throw new Error(`Connected chainId ${network.chainId} does not match snapshot target ${config.target.chainId}`)
	}
	const execute = requireExecutionConfirmation(network.chainId)
	const authority = await resolveAuthority(execute)
	const reportPath = path.resolve(process.env.SYMBOL_SYNC_REPORT || config.output.assignmentReport)
	const report = loadReport(reportPath, snapshotPath, digest, config)
	await reconcileTransactions(report, reportPath)

	let state = await readTargetState(config, desired, authority.address)
	let actions = buildActions(config.target.symbolManager, state.window)
	await simulateActions(actions, authority.address, state.symbols.length)
	const requiredRoles = needsRoles(state)
	const missingRoles = [
		requiredRoles.adder && authority.address && !state.authority?.hasAdderRole ? "SYMBOL_ADDER_ROLE" : null,
		requiredRoles.remover && authority.address && !state.authority?.hasRemoverRole ? "SYMBOL_REMOVER_ROLE" : null,
	].filter(Boolean)
	const attempt: Record<string, unknown> = {
		id: report.attempts.length + 1,
		startedAt: new Date().toISOString(),
		mode: execute ? "execute" : "plan",
		authority: authority.address,
		startBlock: state.blockNumber,
		plannedActionIds: actions.map(action => action.id),
	}
	report.attempts.push(attempt)
	report.lastState = reportState(state, actions)
	delete report.lastError

	console.log("Exact-ID symbol assignment")
	console.log(`  Snapshot: ${snapshotPath}`)
	console.log(`  Digest: ${digest}`)
	console.log(`  Target: chain ${config.target.chainId}, Core ${config.target.core}, Manager ${config.target.symbolManager}`)
	console.log(`  Authority: ${authority.address || "not supplied (role check deferred)"}`)
	console.log(`  Mode: ${execute ? "EXECUTE" : "PLAN ONLY"}`)
	console.log(
		`  State: ${state.symbols.length}/${desired.length} symbols; add ${state.analysis.additions.length}, activate ${state.analysis.activate.length}, deactivate ${state.analysis.deactivate.length}`,
	)
	for (const action of actions) console.log(`  ${action.id}: ${action.description} [simulation: ${action.simulation?.status}]`)

	if (state.analysis.conflicts.length) {
		report.status = "blocked-conflict"
		report.lastError = state.analysis.conflicts.join("; ")
		attempt.status = report.status
		attempt.completedAt = new Date().toISOString()
		saveReport(reportPath, report)
		throw new Error(`Exact-ID assignment is blocked: ${report.lastError}`)
	}
	if (missingRoles.length) {
		report.status = "blocked-authority"
		report.lastError = `Authority ${authority.address} is missing ${missingRoles.join(" and ")}`
		attempt.status = report.status
		attempt.completedAt = new Date().toISOString()
		saveReport(reportPath, report)
		throw new Error(report.lastError)
	}
	const failedSimulation = actions.find(action => action.simulation?.status === "failed")
	if (failedSimulation) {
		report.status = "blocked-simulation"
		report.lastError = `${failedSimulation.id} simulation failed: ${failedSimulation.simulation?.reason}`
		attempt.status = report.status
		attempt.completedAt = new Date().toISOString()
		saveReport(reportPath, report)
		throw new Error(report.lastError)
	}
	if (execute && !authority.signer) throw new Error("Execution requires an EOA signer available through the selected Hardhat signer mode")
	if (execute) {
		const manager = new ethers.Contract(config.target.symbolManager, MANAGER_ABI, authority.signer)
		for (const action of actions) await executeAction(manager, action, report, reportPath)
		state = await readTargetState(config, desired, authority.address)
		actions = buildActions(config.target.symbolManager, state.window)
		await simulateActions(actions, authority.address, state.symbols.length)
		report.lastState = reportState(state, actions)
	}

	const result = statusFor(state, actions)
	report.status = result.status
	if (result.nextEligibleAt) report.nextEligibleAt = result.nextEligibleAt
	else delete report.nextEligibleAt
	attempt.status = report.status
	attempt.completedAt = new Date().toISOString()
	saveReport(reportPath, report)
	console.log(`  Result: ${report.status}`)
	if (report.nextEligibleAt) console.log(`  Next eligible window: ${report.nextEligibleAt}`)
	console.log(`  Report: ${reportPath}`)
	if (!execute && actions.length)
		console.log(`\nPlan complete. Review the JSON actions, then rerun with EXECUTE=true CONFIRM_CHAIN_ID=${network.chainId}.`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
