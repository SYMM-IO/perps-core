import fs from "fs"
import path from "path"

import { FacetNames } from "../tasks/deploy/constants.js"
import { FacetCutAction, getSelectors } from "../tasks/utils/diamondCut.js"
import { ethers } from "../test/helpers/hardhat-connection.js"

/**
 * Upgrade-only verification script (v0.8.4 -> v0.8.5).
 *
 * Run:
 *   DIAMOND_ADDRESS=0x... npx hardhat run ./scripts/upgradeTest.ts --network localhost
 *
 * Config:
 *   cp scripts/config/upgradeTest.sample.json scripts/config/upgradeTest.json
 *   # edit scripts/config/upgradeTest.json
 *
 * Overrides:
 *   UPGRADE_CONFIG_FILE=./path/to/config.json
 *   UPGRADE_PROGRESS_FILE=./path/to/progress.json
 *   UPGRADE_REPORT_FILE=./path/to/report.json
 *   KEEP_PROGRESS=true
 *   VERBOSE=true
 *
 * Resume:
 *   Re-run the command; progress is saved to the progress file.
 *
 * Report:
 *   Verification output (steps + data) is always written to the report file.
 *
 * Auto-discovery:
 *   If PartyA/PartyB lists are not provided, the script scans all quote IDs.
 *   Use QUOTE_SCAN_LIMIT to cap scanning for verification-only runs.
 */

const QUOTE_ABI_V84 = [
	"function getQuote(uint256) view returns (tuple(uint256 id,address[] partyBsWhiteList,uint256 symbolId,uint8 positionType,uint8 orderType,uint256 openedPrice,uint256 initialOpenedPrice,uint256 requestedOpenPrice,uint256 marketPrice,uint256 quantity,uint256 closedAmount,tuple(uint256 cva,uint256 lf,uint256 partyAmm,uint256 partyBmm) initialLockedValues,tuple(uint256 cva,uint256 lf,uint256 partyAmm,uint256 partyBmm) lockedValues,uint256 maxFundingRate,address partyA,address partyB,uint8 quoteStatus,uint256 avgClosedPrice,uint256 requestedClosePrice,uint256 quantityToClose,uint256 parentId,uint256 createTimestamp,uint256 statusModifyTimestamp,uint256 lastFundingPaymentTimestamp,uint256 deadline,uint256 tradingFee,address affiliate))",
]
const QUOTE_ABI_V85 = [
	"function getQuote(uint256) view returns (tuple(uint256 id,address[] partyBsWhiteList,uint256 symbolId,uint8 positionType,uint8 orderType,uint256 openedPrice,uint256 initialOpenedPrice,uint256 requestedOpenPrice,uint256 marketPrice,uint256 quantity,uint256 closedAmount,tuple(uint256 cva,uint256 lf,uint256 partyAmm,uint256 partyBmm) initialLockedValues,tuple(uint256 cva,uint256 lf,uint256 partyAmm,uint256 partyBmm) lockedValues,uint256 maxFundingRate,address partyA,address partyB,uint8 quoteStatus,uint256 avgClosedPrice,uint256 requestedClosePrice,uint256 quantityToClose,uint256 parentId,uint256 createTimestamp,uint256 statusModifyTimestamp,uint256 lastFundingPaymentTimestamp,uint256 deadline,uint256 tradingFee,address affiliate,int256 accumulatedPaidFunding,uint256 closeFee,bytes data))",
]
const QuoteIfaceV84 = new ethers.Interface(QUOTE_ABI_V84)
const QuoteIfaceV85 = new ethers.Interface(QUOTE_ABI_V85)

type FacetInfo = {
	address: string
	selectors: string[]
}

type PartyAState = {
	allocatedBalance: bigint
	quotesLength: bigint
	quoteIds: bigint[]
}

type PreState = {
	nextQuoteId: bigint
	nextBridgeTransactionId: bigint
	deallocateDebounceTime: bigint
	partyAs: Record<string, PartyAState>
	partyBAllocated: Record<string, Record<string, bigint>>
}

type UpgradeConfig = {
	diamondAddress?: string
	partyAAddresses?: string[]
	partyBAddresses?: string[]
	diamondCutChunkSize?: number
	progressFile?: string
	quoteScanLimit?: number
	keepProgress?: boolean
	verbose?: boolean
	reportFile?: string
}

type UpgradeProgress = {
	preState?: PreStateSerialized
	facets?: Record<string, FacetInfo>
	diamondCutApplied?: boolean
}

type PartyAStateSerialized = {
	allocatedBalance: string
	quotesLength: string
	quoteIds: string[]
}

type PreStateSerialized = {
	nextQuoteId: string
	nextBridgeTransactionId: string
	deallocateDebounceTime: string
	partyAs: Record<string, PartyAStateSerialized>
	partyBAllocated: Record<string, Record<string, string>>
}

type VerificationStep = {
	name: string
	status: "ok" | "error"
	details?: Record<string, unknown>
}

type VerificationReport = {
	status: "running" | "success" | "failed"
	startedAt: string
	finishedAt?: string
	durationMs?: number
	diamondAddress?: string
	adminAddress?: string
	partyAs?: string[]
	partyBs?: string[]
	quoteScanLimit?: number | null
	progressFile?: string
	reportFile?: string
	keepProgress?: boolean
	verbose?: boolean
	preState?: PreStateSerialized
	postState?: PreStateSerialized
	steps: VerificationStep[]
	error?: string
}

const UPGRADE_CONFIG_FILE = process.env.UPGRADE_CONFIG_FILE ?? "./scripts/config/upgradeTest.json"

function loadUpgradeConfig(): UpgradeConfig {
	const configPath = UPGRADE_CONFIG_FILE
	if (!fs.existsSync(configPath)) return {}
	let raw: string
	try {
		raw = fs.readFileSync(configPath, "utf-8")
	} catch (error) {
		throw new Error(`Failed to read upgrade config file: ${configPath}. ${String(error)}`)
	}
	try {
		const data = JSON.parse(raw)
		if (!data || typeof data !== "object") {
			throw new Error("Config must be a JSON object.")
		}
		return data as UpgradeConfig
	} catch (error) {
		throw new Error(`Invalid upgrade config JSON: ${configPath}. ${String(error)}`)
	}
}

const config = loadUpgradeConfig()
if (config.progressFile && typeof config.progressFile !== "string") {
	throw new Error("progressFile must be a string path.")
}
if (config.reportFile && typeof config.reportFile !== "string") {
	throw new Error("reportFile must be a string path.")
}
if (config.quoteScanLimit && typeof config.quoteScanLimit !== "number") {
	throw new Error("quoteScanLimit must be a number.")
}
if (config.keepProgress !== undefined && typeof config.keepProgress !== "boolean") {
	throw new Error("keepProgress must be a boolean.")
}
if (config.verbose !== undefined && typeof config.verbose !== "boolean") {
	throw new Error("verbose must be a boolean.")
}
const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
const PARTY_A_ADDRESSES = process.env.PARTY_A_ADDRESSES
const PARTY_B_ADDRESSES = process.env.PARTY_B_ADDRESSES
const DIAMOND_CUT_CHUNK_SIZE = Number(process.env.DIAMOND_CUT_CHUNK_SIZE ?? config.diamondCutChunkSize ?? "6")
const DEFAULT_PROGRESS_FILE = "./scripts/config/upgradeTest-progress.json"
let progressFile = process.env.UPGRADE_PROGRESS_FILE ?? config.progressFile ?? DEFAULT_PROGRESS_FILE
const DEFAULT_REPORT_FILE = "./scripts/config/upgradeTest-report.json"
let reportFile = process.env.UPGRADE_REPORT_FILE ?? config.reportFile ?? DEFAULT_REPORT_FILE
const QUOTE_SCAN_LIMIT = process.env.QUOTE_SCAN_LIMIT ? Number(process.env.QUOTE_SCAN_LIMIT) : (config.quoteScanLimit ?? null)
const KEEP_PROGRESS = parseBool(process.env.KEEP_PROGRESS, config.keepProgress ?? false)
const VERBOSE = parseBool(process.env.VERBOSE, config.verbose ?? false)
if (path.resolve(progressFile) === path.resolve(UPGRADE_CONFIG_FILE)) {
	console.warn("progressFile matches upgrade config file; falling back to default progress file.")
	progressFile = DEFAULT_PROGRESS_FILE
}
if (path.resolve(reportFile) === path.resolve(UPGRADE_CONFIG_FILE)) {
	console.warn("reportFile matches upgrade config file; falling back to default report file.")
	reportFile = DEFAULT_REPORT_FILE
}
if (path.resolve(reportFile) === path.resolve(progressFile)) {
	console.warn("reportFile matches progress file; falling back to default report file.")
	reportFile = DEFAULT_REPORT_FILE
}

const IGNORE_REMOVE_SELECTORS = new Set<string>([
	"0x1f931c1c", // diamondCut
])

// Facet => required libraries for linking
const FacetLibraryDependencies: Record<string, string[]> = {
	PartyAFacet: ["LibQuoteClose"],
	PartyBPositionActionsFacet: ["LibQuoteClose", "LibQuoteFunding"],
	PartyBBatchActionsFacet: ["LibQuoteClose", "LibQuoteFunding"],
	PartyBEmergencyActionsFacet: ["LibQuoteClose"],
	PartyBQuoteActionsFacet: ["LibQuoteClose"],
	ForceActionsFacet: ["LibQuoteClose", "LibSettlement"],
	ForceCloseStepsFacet: ["LibQuoteClose", "LibSettlement"],
	ViewFacetQuote: ["LibQuoteFunding"],
	FundingRateFacet: ["LibQuoteFunding"],
	PartyALiquidationFacet: ["LibQuoteFunding"],
	SettlementFacet: ["LibSettlement"],
}

function parseAddressList(value: string | undefined, fallback: string[] = []): string[] {
	if (!value) return fallback
	return value
		.split(",")
		.map(item => item.trim())
		.filter(Boolean)
}

function parseBool(value: string | boolean | undefined, fallback: boolean): boolean {
	if (value === undefined || value === null || value === "") return fallback
	if (typeof value === "boolean") return value
	const normalized = value.toLowerCase()
	if (normalized === "true" || normalized === "1") return true
	if (normalized === "false" || normalized === "0") return false
	throw new Error(`Invalid boolean value: ${value}`)
}

function formatError(error: unknown): string {
	if (error instanceof Error && error.stack) return error.stack
	if (error instanceof Error && error.message) return error.message
	return String(error)
}

function writeReport(filePath: string, report: VerificationReport): void {
	if (!filePath) return
	const dir = path.dirname(filePath)
	if (dir && dir !== "." && !fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true })
	}
	fs.writeFileSync(filePath, JSON.stringify(report, null, 2))
}

function tryWriteReport(filePath: string, report: VerificationReport): void {
	try {
		writeReport(filePath, report)
	} catch (error) {
		console.error(`Failed to write report file: ${filePath}. ${formatError(error)}`)
	}
}

function toBigInt(value: unknown): bigint {
	if (typeof value === "bigint") return value
	if (typeof value === "number") return BigInt(value)
	if (typeof value === "string") return BigInt(value)
	return BigInt((value as any).toString())
}

async function getQuoteCompat(provider: any, diamondAddress: string, quoteId: bigint): Promise<any> {
	const data = QuoteIfaceV85.encodeFunctionData("getQuote", [quoteId])
	const result = await provider.call({ to: diamondAddress, data })
	try {
		const decoded = QuoteIfaceV85.decodeFunctionResult("getQuote", result)
		return decoded[0]
	} catch {
		const decoded = QuoteIfaceV84.decodeFunctionResult("getQuote", result)
		return decoded[0]
	}
}

function normalizeAddressList(value: unknown, label: string): string[] {
	if (!value) return []
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array of addresses.`)
	}
	for (const entry of value) {
		if (typeof entry !== "string") {
			throw new Error(`${label} must contain only strings.`)
		}
	}
	return value.map(item => item.trim()).filter(Boolean)
}

function validateAddressList(label: string, addresses: string[]): void {
	for (const addr of addresses) {
		if (!ethers.isAddress(addr)) {
			throw new Error(`${label} has invalid address: ${addr}`)
		}
		if (addr === ethers.ZeroAddress) {
			throw new Error(`${label} contains zero address.`)
		}
	}
}

async function discoverPartiesFromQuotes(
	viewFacetQuote: any,
	diamondAddress: string,
	quoteScanLimit: number | null,
): Promise<{ partyAs: string[]; partyBs: string[] }> {
	const partyAs = new Set<string>()
	const partyBs = new Set<string>()
	const provider = viewFacetQuote.runner?.provider ?? viewFacetQuote.provider
	const lastId = toBigInt(await viewFacetQuote.getNextQuoteId())

	let maxId = lastId
	if (quoteScanLimit !== null) {
		if (!Number.isInteger(quoteScanLimit) || quoteScanLimit <= 0) {
			throw new Error(`Invalid QUOTE_SCAN_LIMIT: ${quoteScanLimit}`)
		}
		maxId = BigInt(quoteScanLimit)
		if (maxId > lastId) {
			maxId = lastId
		}
	}

	let id = 1n
	while (id <= maxId) {
		const quote = await getQuoteCompat(provider, diamondAddress, id)
		if (quote.partyA && quote.partyA !== ethers.ZeroAddress) {
			partyAs.add(quote.partyA)
		}
		if (quote.partyB && quote.partyB !== ethers.ZeroAddress) {
			partyBs.add(quote.partyB)
		}
		id += 1n
	}

	return {
		partyAs: [...partyAs],
		partyBs: [...partyBs],
	}
}

function assertEqual(label: string, pre: bigint, post: bigint): void {
	if (pre !== post) {
		throw new Error(`${label} mismatch: pre=${pre.toString()} post=${post.toString()}`)
	}
}

function assertEqualArray(label: string, pre: bigint[], post: bigint[]): void {
	if (pre.length !== post.length) {
		throw new Error(`${label} length mismatch: pre=${pre.length} post=${post.length}`)
	}
	for (let i = 0; i < pre.length; i++) {
		if (pre[i] !== post[i]) {
			throw new Error(`${label} mismatch at ${i}: pre=${pre[i].toString()} post=${post[i].toString()}`)
		}
	}
}

function serializePreState(state: PreState): PreStateSerialized {
	const partyAs: Record<string, PartyAStateSerialized> = {}
	for (const [addr, info] of Object.entries(state.partyAs)) {
		partyAs[addr] = {
			allocatedBalance: info.allocatedBalance.toString(),
			quotesLength: info.quotesLength.toString(),
			quoteIds: info.quoteIds.map(id => id.toString()),
		}
	}

	const partyBAllocated: Record<string, Record<string, string>> = {}
	for (const [partyB, entries] of Object.entries(state.partyBAllocated)) {
		partyBAllocated[partyB] = {}
		for (const [partyA, value] of Object.entries(entries)) {
			partyBAllocated[partyB][partyA] = value.toString()
		}
	}

	return {
		nextQuoteId: state.nextQuoteId.toString(),
		nextBridgeTransactionId: state.nextBridgeTransactionId.toString(),
		deallocateDebounceTime: state.deallocateDebounceTime.toString(),
		partyAs,
		partyBAllocated,
	}
}

function deserializePreState(data: PreStateSerialized): PreState {
	const partyAs: Record<string, PartyAState> = {}
	for (const [addr, info] of Object.entries(data.partyAs ?? {})) {
		partyAs[addr] = {
			allocatedBalance: BigInt(info.allocatedBalance),
			quotesLength: BigInt(info.quotesLength),
			quoteIds: info.quoteIds.map(id => BigInt(id)),
		}
	}

	const partyBAllocated: Record<string, Record<string, bigint>> = {}
	for (const [partyB, entries] of Object.entries(data.partyBAllocated ?? {})) {
		partyBAllocated[partyB] = {}
		for (const [partyA, value] of Object.entries(entries)) {
			partyBAllocated[partyB][partyA] = BigInt(value)
		}
	}

	return {
		nextQuoteId: BigInt(data.nextQuoteId),
		nextBridgeTransactionId: BigInt(data.nextBridgeTransactionId),
		deallocateDebounceTime: BigInt(data.deallocateDebounceTime),
		partyAs,
		partyBAllocated,
	}
}

function loadProgress(filePath: string): UpgradeProgress | null {
	if (!filePath || !fs.existsSync(filePath)) return null
	let raw: string
	try {
		raw = fs.readFileSync(filePath, "utf-8")
	} catch (error) {
		throw new Error(`Failed to read progress file: ${filePath}. ${String(error)}`)
	}
	try {
		const parsed = JSON.parse(raw) as UpgradeProgress
		if (parsed?.preState) {
			parsed.preState = parsed.preState
		}
		return parsed
	} catch (error) {
		throw new Error(`Invalid progress file JSON: ${filePath}. ${String(error)}`)
	}
}

function saveProgress(filePath: string, progress: UpgradeProgress): void {
	if (!filePath) return
	const toSave: UpgradeProgress = { ...progress }
	if (progress.preState) {
		toSave.preState = progress.preState
	}
	fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2))
}

function deleteProgress(filePath: string): void {
	if (!filePath || !fs.existsSync(filePath)) return
	fs.unlinkSync(filePath)
}

async function fetchQuoteIds(viewFacetQuote: any, partyA: string): Promise<bigint[]> {
	const total = toBigInt(await viewFacetQuote.quotesLength(partyA))
	if (total === 0n) return []

	const ids: bigint[] = []
	const chunkSize = 100n
	let start = 0n
	while (start < total) {
		const size = total - start > chunkSize ? chunkSize : total - start
		const batch = await viewFacetQuote.quoteIdsOf(partyA, start, size)
		for (const id of batch) {
			ids.push(toBigInt(id))
		}
		start += size
	}
	return ids
}

async function captureState(viewFacet: any, viewFacetQuote: any, partyAs: string[], partyBs: string[]): Promise<PreState> {
	const state: PreState = {
		nextQuoteId: toBigInt(await viewFacetQuote.getNextQuoteId()),
		nextBridgeTransactionId: toBigInt(await viewFacet.getNextBridgeTransactionId()),
		deallocateDebounceTime: toBigInt(await viewFacet.getDeallocateDebounceTime()),
		partyAs: {},
		partyBAllocated: {},
	}

	for (const partyA of partyAs) {
		const quoteIds = await fetchQuoteIds(viewFacetQuote, partyA)
		state.partyAs[partyA] = {
			allocatedBalance: toBigInt(await viewFacet.allocatedBalanceOfPartyA(partyA)),
			quotesLength: toBigInt(await viewFacetQuote.quotesLength(partyA)),
			quoteIds,
		}
	}

	for (const partyB of partyBs) {
		state.partyBAllocated[partyB] = {}
		for (const partyA of partyAs) {
			state.partyBAllocated[partyB][partyA] = toBigInt(await viewFacet.allocatedBalanceOfPartyB(partyB, partyA))
		}
	}

	return state
}

function compareStates(pre: PreState, post: PreState): void {
	if (VERBOSE) {
		console.log("Verifying invariant fields...")
	}
	assertEqual("nextQuoteId", pre.nextQuoteId, post.nextQuoteId)
	assertEqual("nextBridgeTransactionId", pre.nextBridgeTransactionId, post.nextBridgeTransactionId)
	assertEqual("deallocateDebounceTime", pre.deallocateDebounceTime, post.deallocateDebounceTime)

	const prePartyAs = Object.keys(pre.partyAs)
	for (const partyA of prePartyAs) {
		const preState = pre.partyAs[partyA]
		const postState = post.partyAs[partyA]
		assertEqual(`allocatedBalanceOfPartyA(${partyA})`, preState.allocatedBalance, postState.allocatedBalance)
		assertEqual(`quotesLength(${partyA})`, preState.quotesLength, postState.quotesLength)
		assertEqualArray(`quoteIdsOf(${partyA})`, preState.quoteIds, postState.quoteIds)
		if (VERBOSE) {
			console.log(`Verified PartyA ${partyA}: quotes=${preState.quoteIds.length}`)
		}
	}

	const prePartyBs = Object.keys(pre.partyBAllocated)
	for (const partyB of prePartyBs) {
		const prePartyAEntries = pre.partyBAllocated[partyB]
		const postPartyAEntries = post.partyBAllocated[partyB]
		for (const partyA of Object.keys(prePartyAEntries)) {
			assertEqual(`allocatedBalanceOfPartyB(${partyB},${partyA})`, prePartyAEntries[partyA], postPartyAEntries[partyA])
		}
		if (VERBOSE) {
			console.log(`Verified PartyB ${partyB}: allocations=${Object.keys(prePartyAEntries).length}`)
		}
	}
	if (VERBOSE) {
		console.log("Verification checks completed.")
	}
}

function summarizeState(state: PreState): Record<string, unknown> {
	const partyAs = Object.keys(state.partyAs)
	const partyBs = Object.keys(state.partyBAllocated)
	let totalQuoteIds = 0
	for (const entry of Object.values(state.partyAs)) {
		totalQuoteIds += entry.quoteIds.length
	}
	return {
		partyAsCount: partyAs.length,
		partyBsCount: partyBs.length,
		totalQuoteIds,
	}
}

function summarizeFacets(facets: Record<string, FacetInfo>): Record<string, string> {
	const summary: Record<string, string> = {}
	for (const [name, info] of Object.entries(facets)) {
		summary[name] = info.address
	}
	return summary
}

async function deployLibraries(): Promise<Record<string, string>> {
	const libraries: Record<string, string> = {}

	const LibQuoteFundingFactory = await ethers.getContractFactory("LibQuoteFunding")
	const libQuoteFunding = await LibQuoteFundingFactory.deploy()
	await libQuoteFunding.waitForDeployment()
	libraries.LibQuoteFunding = await libQuoteFunding.getAddress()

	const LibQuoteCloseFactory = await ethers.getContractFactory("LibQuoteClose", {
		libraries: {
			"project/contracts/core/libraries/LibQuoteFunding.sol:LibQuoteFunding": libraries.LibQuoteFunding,
		},
	})
	const libQuoteClose = await LibQuoteCloseFactory.deploy()
	await libQuoteClose.waitForDeployment()
	libraries.LibQuoteClose = await libQuoteClose.getAddress()

	const LibSettlementFactory = await ethers.getContractFactory("LibSettlement")
	const libSettlement = await LibSettlementFactory.deploy()
	await libSettlement.waitForDeployment()
	libraries.LibSettlement = await libSettlement.getAddress()

	return libraries
}

async function deployFacets(): Promise<Record<string, FacetInfo>> {
	const libraries = await deployLibraries()
	const facets: Record<string, FacetInfo> = {}

	for (const facetName of FacetNames) {
		const shortName = facetName.includes(":") ? facetName.split(":").pop()! : facetName
		const requiredLibraries = FacetLibraryDependencies[shortName]
		let facetFactory

		if (requiredLibraries && requiredLibraries.length > 0) {
			const linked: Record<string, string> = {}
			for (const lib of requiredLibraries) {
				linked[`project/contracts/core/libraries/${lib}.sol:${lib}`] = libraries[lib]
			}
			facetFactory = await ethers.getContractFactory(facetName, { libraries: linked })
		} else {
			facetFactory = await ethers.getContractFactory(facetName)
		}

		const facet = await facetFactory.deploy()
		await facet.waitForDeployment()
		const address = await facet.getAddress()
		const selectors = getSelectors(ethers, facetFactory).selectors

		facets[shortName] = { address, selectors }
		console.log(`Deployed ${shortName}: ${address}`)
	}

	return facets
}

async function buildDiamondCut(diamondAddress: string, newFacets: Record<string, FacetInfo>): Promise<any[]> {
	const diamondLoupeFacet = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress)
	const facets = await diamondLoupeFacet.facets()

	const currentSelectors: Map<string, string> = new Map()
	for (const facet of facets) {
		for (const selector of facet.functionSelectors) {
			currentSelectors.set(selector, facet.facetAddress)
		}
	}

	const newSelectors: Map<string, string> = new Map()
	for (const facet of Object.values(newFacets)) {
		for (const selector of facet.selectors) {
			newSelectors.set(selector, facet.address)
		}
	}

	const actions: Record<string, { action: FacetCutAction; facetAddress: string }> = {}

	for (const [selector, _] of currentSelectors) {
		if (newSelectors.has(selector)) {
			actions[selector] = {
				action: FacetCutAction.Replace,
				facetAddress: newSelectors.get(selector)!,
			}
			newSelectors.delete(selector)
		} else if (!IGNORE_REMOVE_SELECTORS.has(selector)) {
			actions[selector] = {
				action: FacetCutAction.Remove,
				facetAddress: ethers.ZeroAddress,
			}
		}
	}

	for (const [selector, facetAddress] of newSelectors) {
		actions[selector] = {
			action: FacetCutAction.Add,
			facetAddress,
		}
	}

	const cutMap: Record<string, { facetAddress: string; action: FacetCutAction; selectors: string[] }> = {}
	for (const [selector, info] of Object.entries(actions)) {
		const key = `${info.facetAddress}-${info.action}`
		if (!cutMap[key]) {
			cutMap[key] = {
				facetAddress: info.facetAddress,
				action: info.action,
				selectors: [],
			}
		}
		cutMap[key].selectors.push(selector)
	}

	return Object.values(cutMap)
		.filter(cut => cut.selectors.length > 0)
		.map(cut => ({
			facetAddress: cut.facetAddress,
			action: cut.action,
			functionSelectors: cut.selectors,
		}))
}

async function applyDiamondCut(diamondAddress: string, diamondCut: any[]): Promise<void> {
	if (diamondCut.length === 0) {
		console.log("No diamond cut required")
		return
	}

	const diamondCutFacet = await ethers.getContractAt("DiamondCutFacet", diamondAddress)
	const chunks: any[][] = []
	for (let i = 0; i < diamondCut.length; i += DIAMOND_CUT_CHUNK_SIZE) {
		chunks.push(diamondCut.slice(i, i + DIAMOND_CUT_CHUNK_SIZE))
	}

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i]
		const tx = await diamondCutFacet.diamondCut(chunk, ethers.ZeroAddress, "0x")
		const receipt = await tx.wait()
		if (!receipt?.status) {
			throw new Error(`Diamond cut failed in chunk ${i + 1}/${chunks.length}: ${tx.hash}`)
		}
		console.log(`Diamond cut chunk ${i + 1}/${chunks.length} applied`)
	}
}

async function main() {
	const startedAtMs = Date.now()
	const report: VerificationReport = {
		status: "running",
		startedAt: new Date(startedAtMs).toISOString(),
		steps: [],
		quoteScanLimit: QUOTE_SCAN_LIMIT,
		progressFile,
		reportFile,
		keepProgress: KEEP_PROGRESS,
		verbose: VERBOSE,
	}
	writeReport(reportFile, report)
	let currentStep: string | null = null

	let preState: PreState | null = null
	let postState: PreState | null = null

	try {
		currentStep = "validate_inputs"
		if (!DIAMOND_ADDRESS) {
			throw new Error("DIAMOND_ADDRESS is required (use the v0.8.4 diamond address).")
		}
		if (!ethers.isAddress(DIAMOND_ADDRESS) || DIAMOND_ADDRESS === ethers.ZeroAddress) {
			throw new Error(`Invalid DIAMOND_ADDRESS: ${DIAMOND_ADDRESS}`)
		}
		if (!Number.isInteger(DIAMOND_CUT_CHUNK_SIZE) || DIAMOND_CUT_CHUNK_SIZE <= 0) {
			throw new Error(`Invalid DIAMOND_CUT_CHUNK_SIZE: ${DIAMOND_CUT_CHUNK_SIZE}`)
		}
		report.steps.push({
			name: "validate_inputs",
			status: "ok",
			details: {
				diamondAddress: DIAMOND_ADDRESS,
				diamondCutChunkSize: DIAMOND_CUT_CHUNK_SIZE,
			},
		})
		currentStep = null
		tryWriteReport(reportFile, report)

		const signers = await ethers.getSigners()
		const admin = signers[0]
		const adminAddress = await admin.getAddress()
		report.diamondAddress = DIAMOND_ADDRESS
		report.adminAddress = adminAddress

		const viewFacet = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", DIAMOND_ADDRESS, admin)
		const viewFacetQuote = await ethers.getContractAt(
			"contracts/core/facets/ViewFacetQuote/ViewFacetQuote.sol:ViewFacetQuote",
			DIAMOND_ADDRESS,
			admin,
		)

		const configPartyAs = normalizeAddressList(config.partyAAddresses, "partyAAddresses")
		const configPartyBs = normalizeAddressList(config.partyBAddresses, "partyBAddresses")
		let partyAs = PARTY_A_ADDRESSES ? parseAddressList(PARTY_A_ADDRESSES) : configPartyAs
		let partyBs = PARTY_B_ADDRESSES ? parseAddressList(PARTY_B_ADDRESSES) : configPartyBs

		let partyASource = PARTY_A_ADDRESSES ? "env" : configPartyAs.length > 0 ? "config" : "discovery"
		let partyBSource = PARTY_B_ADDRESSES ? "env" : configPartyBs.length > 0 ? "config" : "discovery"

		if (partyAs.length === 0 || partyBs.length === 0) {
			console.log("Discovering PartyA/PartyB addresses from existing quotes...")
			currentStep = "discover_parties"
			const discovered = await discoverPartiesFromQuotes(viewFacetQuote, DIAMOND_ADDRESS, QUOTE_SCAN_LIMIT)
			if (partyAs.length === 0) {
				partyAs = discovered.partyAs
				partyASource = "discovery"
			}
			if (partyBs.length === 0) {
				partyBs = discovered.partyBs
				partyBSource = "discovery"
			}
			report.steps.push({
				name: "discover_parties",
				status: "ok",
				details: {
					partyAsCount: partyAs.length,
					partyBsCount: partyBs.length,
				},
			})
			currentStep = null
			tryWriteReport(reportFile, report)
		}

		partyAs = [...new Set(partyAs)].sort()
		partyBs = [...new Set(partyBs)].sort()

		validateAddressList("PartyA addresses", partyAs)
		validateAddressList("PartyB addresses", partyBs)

		report.partyAs = partyAs
		report.partyBs = partyBs
		report.steps.push({
			name: "resolve_parties",
			status: "ok",
			details: {
				partyAsCount: partyAs.length,
				partyBsCount: partyBs.length,
				partyASource,
				partyBSource,
			},
		})
		tryWriteReport(reportFile, report)

		console.log(`Diamond: ${DIAMOND_ADDRESS}`)
		console.log(`Admin:   ${adminAddress}`)
		console.log(`PartyAs: ${partyAs.join(", ") || "-"}`)
		console.log(`PartyBs: ${partyBs.join(", ") || "-"}`)
		console.log(`Progress file: ${progressFile}`)
		console.log(`Report file: ${reportFile}`)
		if (QUOTE_SCAN_LIMIT !== null) {
			console.log(`Quote scan limit: ${QUOTE_SCAN_LIMIT} (verification-only)`)
		}
		if (VERBOSE) {
			console.log("Verbose logging enabled.")
		}

		const progress = loadProgress(progressFile) ?? {}

		if (progress.preState) {
			currentStep = "load_pre_state"
			preState = deserializePreState(progress.preState)
			const progressPartyAs = Object.keys(preState.partyAs).sort()
			const progressPartyBs = Object.keys(preState.partyBAllocated).sort()
			const currentPartyAs = [...partyAs].sort()
			const currentPartyBs = [...partyBs].sort()
			if (progressPartyAs.join(",") !== currentPartyAs.join(",")) {
				throw new Error("Progress file partyA list mismatch. Delete progress file and rerun.")
			}
			if (progressPartyBs.join(",") !== currentPartyBs.join(",")) {
				throw new Error("Progress file partyB list mismatch. Delete progress file and rerun.")
			}
			report.preState = progress.preState
			report.steps.push({
				name: "load_pre_state",
				status: "ok",
				details: {
					source: "progress",
					...summarizeState(preState),
				},
			})
			currentStep = null
			tryWriteReport(reportFile, report)
			console.log("Loaded pre-upgrade state from progress file.")
		} else {
			currentStep = "capture_pre_state"
			console.log("Capturing pre-upgrade state...")
			preState = await captureState(viewFacet, viewFacetQuote, partyAs, partyBs)
			const serialized = serializePreState(preState)
			report.preState = serialized
			progress.preState = serialized
			saveProgress(progressFile, progress)
			report.steps.push({
				name: "capture_pre_state",
				status: "ok",
				details: {
					source: "fresh",
					...summarizeState(preState),
				},
			})
			currentStep = null
			tryWriteReport(reportFile, report)
		}

		let newFacets: Record<string, FacetInfo> | null = null
		if (progress.facets) {
			currentStep = "load_facets"
			newFacets = progress.facets
			report.steps.push({
				name: "load_facets",
				status: "ok",
				details: {
					source: "progress",
					facetCount: Object.keys(newFacets).length,
					facets: summarizeFacets(newFacets),
				},
			})
			currentStep = null
			tryWriteReport(reportFile, report)
			console.log("Loaded deployed facets from progress file.")
		} else {
			currentStep = "deploy_facets"
			console.log("Deploying v0.8.5 facets...")
			newFacets = await deployFacets()
			progress.facets = newFacets
			saveProgress(progressFile, progress)
			report.steps.push({
				name: "deploy_facets",
				status: "ok",
				details: {
					facetCount: Object.keys(newFacets).length,
					facets: summarizeFacets(newFacets),
				},
			})
			currentStep = null
			tryWriteReport(reportFile, report)
		}

		if (!progress.diamondCutApplied) {
			currentStep = "build_diamond_cut"
			console.log("Preparing diamond cut...")
			const diamondCut = await buildDiamondCut(DIAMOND_ADDRESS, newFacets)

			const actionCounts = { add: 0, replace: 0, remove: 0 }
			let totalSelectors = 0
			for (const cut of diamondCut) {
				totalSelectors += cut.functionSelectors.length
				if (cut.action === FacetCutAction.Add) actionCounts.add += 1
				else if (cut.action === FacetCutAction.Replace) actionCounts.replace += 1
				else if (cut.action === FacetCutAction.Remove) actionCounts.remove += 1
			}
			report.steps.push({
				name: "build_diamond_cut",
				status: "ok",
				details: {
					cutCount: diamondCut.length,
					totalSelectors,
					actionCounts,
				},
			})
			currentStep = null
			tryWriteReport(reportFile, report)

			currentStep = "apply_diamond_cut"
			console.log("Applying diamond cut...")
			await applyDiamondCut(DIAMOND_ADDRESS, diamondCut)
			progress.diamondCutApplied = true
			saveProgress(progressFile, progress)
			report.steps.push({
				name: "apply_diamond_cut",
				status: "ok",
				details: {
					chunkSize: DIAMOND_CUT_CHUNK_SIZE,
					cutCount: diamondCut.length,
					totalSelectors,
				},
			})
			currentStep = null
			tryWriteReport(reportFile, report)
		} else {
			report.steps.push({
				name: "apply_diamond_cut",
				status: "ok",
				details: {
					skipped: true,
				},
			})
			tryWriteReport(reportFile, report)
			console.log("Diamond cut already applied (from progress).")
		}

		currentStep = "capture_post_state"
		console.log("Capturing post-upgrade state...")
		postState = await captureState(viewFacet, viewFacetQuote, partyAs, partyBs)
		report.postState = serializePreState(postState)
		report.steps.push({
			name: "capture_post_state",
			status: "ok",
			details: summarizeState(postState),
		})
		currentStep = null
		tryWriteReport(reportFile, report)

		if (!preState) {
			throw new Error("Missing pre-upgrade state. Delete progress file and rerun.")
		}
		currentStep = "compare_states"
		compareStates(preState, postState)
		report.steps.push({
			name: "compare_states",
			status: "ok",
			details: {
				partyAsCount: Object.keys(preState.partyAs).length,
				partyBsCount: Object.keys(preState.partyBAllocated).length,
			},
		})
		currentStep = null
		tryWriteReport(reportFile, report)

		console.log("Upgrade verification completed successfully.")
		if (KEEP_PROGRESS) {
			console.log("Keeping progress file for inspection.")
			report.steps.push({
				name: "cleanup_progress",
				status: "ok",
				details: {
					kept: true,
					progressFile,
				},
			})
		} else {
			deleteProgress(progressFile)
			report.steps.push({
				name: "cleanup_progress",
				status: "ok",
				details: {
					kept: false,
					progressFile,
				},
			})
		}
		tryWriteReport(reportFile, report)
		report.status = "success"
	} catch (error) {
		if (currentStep) {
			report.steps.push({
				name: currentStep,
				status: "error",
				details: {
					error: formatError(error),
				},
			})
			currentStep = null
		}
		report.status = "failed"
		report.error = formatError(error)
		tryWriteReport(reportFile, report)
		throw error
	} finally {
		report.finishedAt = new Date().toISOString()
		report.durationMs = Date.now() - startedAtMs
		tryWriteReport(reportFile, report)
	}
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
