/**
 * Resume or complete a single-counterparty PartyA ClearingHouse takeover.
 *
 * Config resolution:
 *   PARTY_A_TAKEOVER_CONFIG_FILE (when set)
 *   scripts/upgrade/config/partyATakeover-<network>.json
 *   scripts/upgrade/config/partyATakeover.json
 *
 * TAKEOVER_STEP:
 *   inspect (default), pending, positions, deallocate, distribute, settle, all
 *
 * Dry run is the default. Set DRY_RUN=false and USE_KEYSTORE=true to submit.
 *
 * Examples:
 *   USE_KEYSTORE=false TAKEOVER_STEP=inspect \
 *     npx hardhat run scripts/upgrade/runPartyATakeover.ts --network hyperevm
 *
 *   USE_KEYSTORE=true KEYSTORE_DEPLOYER_KEY=TEAM_DEPLOYER TAKEOVER_STEP=positions \
 *     npx hardhat run scripts/upgrade/runPartyATakeover.ts --network hyperevm
 *
 *   USE_KEYSTORE=true KEYSTORE_DEPLOYER_KEY=TEAM_DEPLOYER DRY_RUN=false TAKEOVER_STEP=all \
 *     npx hardhat run scripts/upgrade/runPartyATakeover.ts --network hyperevm
 */
import fs from "node:fs"
import path from "node:path"

import connection, { ethers, networkHelpers } from "../../test/helpers/hardhat-connection.js"
import { log } from "./utils/log.js"
import {
	calculatePositionAccounting,
	formatSigned,
	loadPartyATakeoverConfig,
	MuonPriceResult,
	parseMuonPriceResponse,
	parsePartyATakeoverStep,
	PartyATakeoverConfig,
} from "./utils/partyATakeover.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { resolveConfigFile } from "./utils/sharedConfig.js"

const CLEARING_HOUSE_ROLE = ethers.id("CLEARING_HOUSE_ROLE")
const REIMBURSEMENT_KEY = "0x0000000000000000000000000000000000000001"
const FAST_BLOCK_GAS_SAFETY_LIMIT = 1_900_000n
const DEFAULT_POSITION_BATCH_SIZE = 1
const DEFAULT_MUON_ENDPOINTS = [
	"https://muon-oracle1.rasa.capital/v1/",
	"https://muon-oracle2.rasa.capital/v1/",
	"https://muon-oracle3.rasa.capital/v1/",
	"https://muon-oracle4.rasa.capital/v1/",
]

type OpenPosition = {
	id: bigint
	positionType: bigint
	openedPrice: bigint
	quantity: bigint
	closedAmount: bigint
	partyA: string
	partyB: string
}

type PositionPlanItem = {
	quoteId: bigint
	symbol: string
	price: bigint
	fundingDebt: bigint
	pricePnl: bigint
	partyANetPnl: bigint
}

type ConfirmedPositionRecord = {
	quoteId: string
	symbol: string
	price: string
	fundingDebt: string
	pricePnl: string
	partyANetPnl: string
	oracleBlockNumber: string
	oracleTimestamp: number
	oracleEndpoint: string
	transactionHash: string
	blockNumber: number
}

type TakeoverJournal = {
	version: 1
	chainId: number
	diamondAddress: string
	partyA: string
	partyB: string
	updatedAt: string
	positions: Record<string, ConfirmedPositionRecord>
}

type TakeoverContext = {
	config: PartyATakeoverConfig
	configFile: string
	journalFile: string
	dryRun: boolean
	authorized: boolean
	usingBigBlocks: boolean | undefined
	positionBatchSize: number
	signerAddress: string
	clearingHouse: any
	view: any
	quoteView: any
}

type TakeoverSnapshot = {
	isLiquidated: boolean
	takeoverInProgress: boolean
	deallocatedPool: bigint
	partyAAllocated: bigint
	partyBAllocated: bigint
	reimbursement: bigint
	deferredBalance: bigint
	liquidationEscrow: bigint
	openPositionsCount: bigint
	pendingQuoteIds: bigint[]
	involvedPartyBCounts: bigint
	liquidationType: number
	configuredReceiverIsPartyB: boolean
	settlementPending: boolean
	openPositions: OpenPosition[]
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined || value.trim() === "") return fallback
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer`)
	}
	return parsed
}

function isHyperEvm(chainId: number): boolean {
	return chainId === 998 || chainId === 999
}

function journalPath(config: PartyATakeoverConfig): string {
	return path.join("scripts", "upgrade", "output", `party-a-takeover-${config.chainId}-${config.partyA.toLowerCase()}.json`)
}

function newJournal(config: PartyATakeoverConfig): TakeoverJournal {
	return {
		version: 1,
		chainId: config.chainId,
		diamondAddress: config.diamondAddress,
		partyA: config.partyA,
		partyB: config.partyB,
		updatedAt: new Date().toISOString(),
		positions: {},
	}
}

function loadJournal(file: string, config: PartyATakeoverConfig): TakeoverJournal {
	if (!fs.existsSync(file)) return newJournal(config)

	let journal: TakeoverJournal
	try {
		journal = JSON.parse(fs.readFileSync(file, "utf-8")) as TakeoverJournal
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`Invalid takeover journal ${file}: ${message}`)
	}

	if (
		journal.version !== 1 ||
		journal.chainId !== config.chainId ||
		journal.diamondAddress.toLowerCase() !== config.diamondAddress.toLowerCase() ||
		journal.partyA.toLowerCase() !== config.partyA.toLowerCase() ||
		journal.partyB.toLowerCase() !== config.partyB.toLowerCase()
	) {
		throw new Error(`Takeover journal identity does not match config: ${file}`)
	}
	if (!journal.positions || typeof journal.positions !== "object" || Array.isArray(journal.positions)) {
		throw new Error(`Takeover journal positions must be an object: ${file}`)
	}
	return journal
}

function writeJournal(file: string, journal: TakeoverJournal): void {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	journal.updatedAt = new Date().toISOString()
	fs.writeFileSync(file, JSON.stringify(journal, null, 2) + "\n")
}

function confirmedPartyBClaim(journal: TakeoverJournal): bigint {
	const partyANetPnl = Object.values(journal.positions).reduce((total, position) => total + BigInt(position.partyANetPnl), 0n)
	return partyANetPnl < 0n ? -partyANetPnl : 0n
}

async function readUsingBigBlocks(config: PartyATakeoverConfig, signerAddress: string): Promise<boolean | undefined> {
	if (!isHyperEvm(config.chainId)) return undefined
	try {
		return Boolean(await ethers.provider.send("eth_usingBigBlocks", [signerAddress]))
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`Failed to query eth_usingBigBlocks for ${signerAddress}: ${message}`)
	}
}

async function readSnapshot(context: TakeoverContext): Promise<TakeoverSnapshot> {
	const { config, view, quoteView } = context
	const [
		isLiquidated,
		takeover,
		partyAAllocated,
		partyBAllocated,
		reimbursement,
		deferredBalance,
		liquidationEscrow,
		openPositionsCount,
		pendingQuoteIds,
		liquidationDetail,
		configuredReceiverIsPartyB,
		settlementStates,
	] = await Promise.all([
		view.isPartyALiquidated(config.partyA),
		view.getPartyATakeoverDetails(config.partyA),
		view.allocatedBalanceOfPartyA(config.partyA),
		view.allocatedBalanceOfPartyB(config.partyB, config.partyA),
		view.partyAReimbursement(config.partyA),
		view.getPartyADeferredBalance(config.partyA),
		view.getLiquidationEscrow(config.partyA),
		quoteView.partyAPositionsCount(config.partyA),
		quoteView.getPartyAPendingQuotes(config.partyA),
		view.getLiquidatedStateOfPartyA(config.partyA),
		view.isPartyB(config.partyB),
		view.getSettlementStates(config.partyA, [config.partyB]),
	])

	const openPositions =
		openPositionsCount > 0n ? ((await quoteView.getPartyAOpenPositions(config.partyA, 0n, openPositionsCount)) as OpenPosition[]) : []

	return {
		isLiquidated,
		takeoverInProgress: takeover.inProgress,
		deallocatedPool: takeover.deallocatedPool,
		partyAAllocated,
		partyBAllocated,
		reimbursement,
		deferredBalance,
		liquidationEscrow,
		openPositionsCount,
		pendingQuoteIds: [...pendingQuoteIds],
		involvedPartyBCounts: liquidationDetail.involvedPartyBCounts,
		liquidationType: Number(liquidationDetail.liquidationType),
		configuredReceiverIsPartyB,
		settlementPending: settlementStates[0].pending,
		openPositions,
	}
}

function assertActiveTakeover(snapshot: TakeoverSnapshot): void {
	if (!snapshot.isLiquidated || !snapshot.takeoverInProgress) {
		throw new Error("PartyA does not have an active ClearingHouse takeover")
	}
	if (snapshot.liquidationType !== 3) {
		throw new Error(`This runner only automates OVERDUE PartyA takeovers; current liquidationType is ${snapshot.liquidationType}`)
	}
	if (!snapshot.configuredReceiverIsPartyB) {
		throw new Error("Configured partyB is not registered as a PartyB")
	}
}

function assertConfiguredCounterparty(context: TakeoverContext, positions: OpenPosition[]): void {
	for (const position of positions) {
		if (position.partyA.toLowerCase() !== context.config.partyA.toLowerCase()) {
			throw new Error(`Quote ${position.id} belongs to unexpected PartyA ${position.partyA}`)
		}
		if (position.partyB.toLowerCase() !== context.config.partyB.toLowerCase()) {
			throw new Error(
				`Quote ${position.id} belongs to PartyB ${position.partyB}, not configured PartyB ${context.config.partyB}. ` +
					"This runner intentionally refuses multi-PartyB distributions.",
			)
		}
	}
}

function logSnapshot(snapshot: TakeoverSnapshot): void {
	log.stats([
		["Liquidated", String(snapshot.isLiquidated)],
		["Takeover active", String(snapshot.takeoverInProgress)],
		["Liquidation type", String(snapshot.liquidationType)],
		["Open positions", snapshot.openPositionsCount.toString()],
		["Pending quotes", snapshot.pendingQuoteIds.length],
		["PartyA allocated", ethers.formatEther(snapshot.partyAAllocated)],
		["PartyB isolated", ethers.formatEther(snapshot.partyBAllocated)],
		["Reimbursement", ethers.formatEther(snapshot.reimbursement)],
		["Deferred balance", ethers.formatEther(snapshot.deferredBalance)],
		["Liquidation escrow", ethers.formatEther(snapshot.liquidationEscrow)],
		["Takeover pool", ethers.formatEther(snapshot.deallocatedPool)],
		["Pending settlements", snapshot.involvedPartyBCounts.toString()],
	])
}

async function fetchMuonPrices(config: PartyATakeoverConfig, quoteIds: bigint[]): Promise<{ endpoint: string; result: MuonPriceResult }> {
	for (const endpoint of DEFAULT_MUON_ENDPOINTS) {
		try {
			const url = new URL(endpoint)
			url.searchParams.set("app", "symmio")
			url.searchParams.set("method", "price")
			url.searchParams.set("params[quoteIds]", JSON.stringify(quoteIds.map(quoteId => Number(quoteId))))
			url.searchParams.set("params[chainId]", String(config.chainId))
			url.searchParams.set("params[symmio]", config.diamondAddress)

			const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`)
			}
			const parsed = parseMuonPriceResponse(await response.json(), config.chainId, config.diamondAddress, quoteIds)
			return { endpoint, result: parsed }
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			log.warn(`Muon endpoint failed (${endpoint}): ${message}`)
		}
	}
	throw new Error("All configured Muon oracle endpoints failed")
}

async function buildPositionPlan(
	context: TakeoverContext,
	positions: OpenPosition[],
): Promise<{ endpoint: string; oracle: MuonPriceResult; items: PositionPlanItem[]; totalPartyBClaim: bigint }> {
	assertConfiguredCounterparty(context, positions)
	const quoteIds = positions.map(position => position.id)
	const [{ endpoint, result: oracle }, fundingDebts] = await Promise.all([
		fetchMuonPrices(context.config, quoteIds),
		context.quoteView.getQuoteFundingDebts(quoteIds),
	])

	const items = positions.map((position, index) => {
		const openAmount = position.quantity - position.closedAmount
		const accounting = calculatePositionAccounting(
			Number(position.positionType),
			position.openedPrice,
			oracle.prices[index],
			openAmount,
			fundingDebts[index],
		)
		return {
			quoteId: position.id,
			symbol: oracle.symbols[index],
			price: oracle.prices[index],
			fundingDebt: fundingDebts[index],
			pricePnl: accounting.pricePnl,
			partyANetPnl: accounting.partyANetPnl,
		}
	})

	const totalPartyANetPnl = items.reduce((total, item) => total + item.partyANetPnl, 0n)
	const totalPartyBClaim = totalPartyANetPnl < 0n ? -totalPartyANetPnl : 0n
	return { endpoint, oracle, items, totalPartyBClaim }
}

function logPositionPlan(plan: Awaited<ReturnType<typeof buildPositionPlan>>): void {
	for (const item of plan.items) {
		log.info(`Quote ${item.quoteId} — ${item.symbol}`)
		log.detail(`Price: ${ethers.formatEther(item.price)} (${item.price})`)
		log.detail(`Price PnL for PartyA: ${formatSigned(item.pricePnl)}`)
		log.detail(`Funding debt: ${formatSigned(item.fundingDebt)}`)
		log.detail(`Net PnL for PartyA: ${formatSigned(item.partyANetPnl)}`)
	}
	log.info(`Muon block: ${plan.oracle.latestBlockNumber}`)
	log.info(`Muon time:  ${new Date(plan.oracle.timestamp * 1000).toISOString()}`)
	log.info(`PartyB claim at planned close prices: ${ethers.formatEther(plan.totalPartyBClaim)}`)
}

async function submitChecked(
	context: TakeoverContext,
	label: string,
	method: any,
	args: unknown[],
): Promise<{ hash: string; blockNumber: number; gasUsed: bigint }> {
	await method.staticCall(...args)
	const gasEstimate: bigint = await method.estimateGas(...args)
	log.info(`${label} gas estimate: ${gasEstimate}`)

	if (isHyperEvm(context.config.chainId) && context.usingBigBlocks === false && gasEstimate > FAST_BLOCK_GAS_SAFETY_LIMIT) {
		throw new Error(
			`${label} estimates ${gasEstimate} gas, above the fast-block safety limit ${FAST_BLOCK_GAS_SAFETY_LIMIT}. ` +
				"Review the batch and explicitly enable big blocks before retrying.",
		)
	}

	if (context.dryRun) {
		log.ok(`${label} static-call passed`)
		return { hash: "", blockNumber: 0, gasUsed: 0n }
	}

	const transaction = await method(...args)
	const receipt = await transaction.wait()
	if (!receipt || receipt.status !== 1) {
		throw new Error(`${label} did not return a successful receipt`)
	}
	log.ok(`${label}: ${receipt.hash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`)
	return {
		hash: receipt.hash,
		blockNumber: receipt.blockNumber,
		gasUsed: receipt.gasUsed,
	}
}

async function inspect(context: TakeoverContext): Promise<TakeoverSnapshot> {
	const snapshot = await readSnapshot(context)
	logSnapshot(snapshot)

	if (!snapshot.takeoverInProgress && !snapshot.isLiquidated) {
		log.ok("PartyA takeover is already settled")
		return snapshot
	}
	assertActiveTakeover(snapshot)
	assertConfiguredCounterparty(context, snapshot.openPositions)

	if (snapshot.openPositions.length > 0) {
		const plan = await buildPositionPlan(context, snapshot.openPositions)
		logPositionPlan(plan)
		const recoverable = snapshot.partyAAllocated + snapshot.reimbursement + snapshot.deallocatedPool
		log.info(`Currently recoverable PartyA funds: ${ethers.formatEther(recoverable)}`)
		if (plan.totalPartyBClaim < recoverable) {
			log.warn("PartyB claim is smaller than currently recoverable funds; automatic full-pool distribution will be refused")
		}
	}
	return snapshot
}

async function processPending(context: TakeoverContext): Promise<void> {
	const snapshot = await readSnapshot(context)
	assertActiveTakeover(snapshot)
	if (snapshot.pendingQuoteIds.length === 0) {
		log.ok("No pending quotes; step skipped")
		return
	}

	await submitChecked(
		context,
		`Liquidate ${snapshot.pendingQuoteIds.length} pending quote(s)`,
		context.clearingHouse.liquidatePendingPositionsForClearingHouse,
		[context.config.partyA, []],
	)
	if (!context.dryRun) {
		const after = await readSnapshot(context)
		if (after.pendingQuoteIds.length !== 0) {
			throw new Error(`Pending quote verification failed: ${after.pendingQuoteIds.length} remain`)
		}
	}
}

async function processPositions(context: TakeoverContext): Promise<void> {
	const snapshot = await readSnapshot(context)
	assertActiveTakeover(snapshot)
	if (snapshot.pendingQuoteIds.length > 0) {
		throw new Error("Pending quotes must be processed before open positions")
	}
	if (snapshot.openPositions.length === 0) {
		log.ok("No open positions; step skipped")
		return
	}

	const plan = await buildPositionPlan(context, snapshot.openPositions)
	logPositionPlan(plan)
	if (plan.totalPartyBClaim === 0n) {
		throw new Error("Configured PartyB has no net claim at the planned close prices; automatic recovery routing is not safe")
	}

	for (let start = 0; start < plan.items.length; start += context.positionBatchSize) {
		const batch = plan.items.slice(start, start + context.positionBatchSize)
		const receipt = await submitChecked(
			context,
			`Close quote batch ${Math.floor(start / context.positionBatchSize) + 1}`,
			context.clearingHouse.liquidatePositionsForClearingHouse,
			[context.config.partyA, batch.map(item => item.quoteId), batch.map(item => item.price)],
		)

		if (!context.dryRun) {
			const journal = loadJournal(context.journalFile, context.config)
			for (const item of batch) {
				journal.positions[item.quoteId.toString()] = {
					quoteId: item.quoteId.toString(),
					symbol: item.symbol,
					price: item.price.toString(),
					fundingDebt: item.fundingDebt.toString(),
					pricePnl: item.pricePnl.toString(),
					partyANetPnl: item.partyANetPnl.toString(),
					oracleBlockNumber: plan.oracle.latestBlockNumber,
					oracleTimestamp: plan.oracle.timestamp,
					oracleEndpoint: plan.endpoint,
					transactionHash: receipt.hash,
					blockNumber: receipt.blockNumber,
				}
			}
			writeJournal(context.journalFile, journal)
		}
	}

	if (!context.dryRun) {
		const after = await readSnapshot(context)
		if (after.openPositionsCount !== 0n) {
			throw new Error(`Open-position verification failed: ${after.openPositionsCount} remain`)
		}
	}
}

async function deallocate(context: TakeoverContext): Promise<void> {
	const snapshot = await readSnapshot(context)
	assertActiveTakeover(snapshot)
	if (snapshot.openPositionsCount !== 0n || snapshot.pendingQuoteIds.length !== 0) {
		throw new Error("Close all open and pending positions before deallocating PartyA funds")
	}

	const parties: string[] = []
	const allocationKeys: string[] = []
	const amounts: bigint[] = []
	if (snapshot.partyAAllocated > 0n) {
		parties.push(context.config.partyA)
		allocationKeys.push(ethers.ZeroAddress)
		amounts.push(snapshot.partyAAllocated)
	}
	if (snapshot.reimbursement > 0n) {
		parties.push(context.config.partyA)
		allocationKeys.push(REIMBURSEMENT_KEY)
		amounts.push(snapshot.reimbursement)
	}
	if (amounts.length === 0) {
		log.ok("No PartyA allocation or reimbursement to deallocate; step skipped")
		return
	}

	const expectedPool = snapshot.deallocatedPool + amounts.reduce((total, amount) => total + amount, 0n)
	await submitChecked(context, "Deallocate PartyA recovery", context.clearingHouse.deallocateForClearingHouse, [
		context.config.partyA,
		parties,
		allocationKeys,
		amounts,
	])

	if (!context.dryRun) {
		const after = await readSnapshot(context)
		if (after.partyAAllocated !== 0n || after.reimbursement !== 0n || after.deallocatedPool !== expectedPool) {
			throw new Error("Deallocation post-state verification failed")
		}
	}
}

async function distribute(context: TakeoverContext): Promise<void> {
	const snapshot = await readSnapshot(context)
	assertActiveTakeover(snapshot)
	if (snapshot.openPositionsCount !== 0n || snapshot.pendingQuoteIds.length !== 0) {
		throw new Error("Close all open and pending positions before distributing recovery")
	}
	if (snapshot.deallocatedPool === 0n) {
		log.ok("Takeover pool is empty; step skipped")
		return
	}

	const journal = loadJournal(context.journalFile, context.config)
	const partyBClaim = confirmedPartyBClaim(journal)
	if (partyBClaim === 0n) {
		throw new Error(
			`No confirmed PartyB claim found in ${context.journalFile}. ` + "Run the positions step through this runner before distributing funds.",
		)
	}
	if (partyBClaim < snapshot.deallocatedPool) {
		throw new Error(
			`Confirmed PartyB claim ${partyBClaim} is smaller than takeover pool ${snapshot.deallocatedPool}; ` + "manual split distribution is required.",
		)
	}

	const partyBBefore = snapshot.partyBAllocated
	await submitChecked(context, "Distribute recovery to PartyB", context.clearingHouse.distributeForClearingHouse, [
		context.config.partyA,
		[context.config.partyB],
		[context.config.partyA],
		[snapshot.deallocatedPool],
	])

	if (!context.dryRun) {
		const after = await readSnapshot(context)
		if (after.deallocatedPool !== 0n || after.partyBAllocated !== partyBBefore + snapshot.deallocatedPool) {
			throw new Error("Distribution post-state verification failed")
		}
	}
}

async function settle(context: TakeoverContext): Promise<void> {
	const snapshot = await readSnapshot(context)
	if (!snapshot.takeoverInProgress && !snapshot.isLiquidated) {
		log.ok("PartyA takeover is already settled; step skipped")
		return
	}
	assertActiveTakeover(snapshot)
	if (snapshot.openPositionsCount !== 0n || snapshot.pendingQuoteIds.length !== 0) {
		throw new Error("PartyA still has open or pending positions")
	}
	if (snapshot.deallocatedPool !== 0n) {
		throw new Error("Takeover pool still contains undistributed funds")
	}
	if (snapshot.partyAAllocated !== 0n || snapshot.reimbursement !== 0n) {
		throw new Error("PartyA still has recoverable allocation or reimbursement; run deallocate and distribute first")
	}

	let settledPartyBs: string[]
	if (snapshot.involvedPartyBCounts === 0n) {
		if (snapshot.settlementPending) {
			throw new Error("Configured PartyB has a pending settlement but involvedPartyBCounts is zero")
		}
		settledPartyBs = []
	} else if (snapshot.involvedPartyBCounts === 1n && snapshot.settlementPending) {
		settledPartyBs = [context.config.partyB]
	} else {
		throw new Error(
			`Cannot safely derive settlement cleanup: involvedPartyBCounts=${snapshot.involvedPartyBCounts}, ` +
				`configured PartyB pending=${snapshot.settlementPending}`,
		)
	}

	await submitChecked(context, "Settle PartyA takeover", context.clearingHouse.settlePartyATakeover, [context.config.partyA, settledPartyBs])

	if (!context.dryRun) {
		const after = await readSnapshot(context)
		if (after.isLiquidated || after.takeoverInProgress || after.openPositionsCount !== 0n || after.pendingQuoteIds.length !== 0) {
			throw new Error("Settlement post-state verification failed")
		}
	}
}

async function main() {
	const networkName = connection.networkName
	const forkImpersonateAddress = process.env.FORK_IMPERSONATE_CLEARING_HOUSE
	const isForkImpersonation = Boolean(forkImpersonateAddress)
	if (isForkImpersonation && !networkName.startsWith("fork-")) {
		throw new Error("FORK_IMPERSONATE_CLEARING_HOUSE is only allowed on a network whose name starts with fork-")
	}
	const configFile = resolveConfigFile("partyATakeover", networkName, process.env.PARTY_A_TAKEOVER_CONFIG_FILE)
	const config = loadPartyATakeoverConfig(configFile)
	const step = parsePartyATakeoverStep(process.env.TAKEOVER_STEP)
	const dryRun = process.env.DRY_RUN !== "false"
	const positionBatchSize = parsePositiveInteger(process.env.POSITION_BATCH_SIZE, DEFAULT_POSITION_BATCH_SIZE, "POSITION_BATCH_SIZE")

	log.header("Symmio PartyA ClearingHouse Takeover")
	log.setSteps(step === "inspect" ? 2 : step === "all" ? (dryRun ? 4 : 7) : 3)

	const rpcTimer = log.step("Verify RPC and configuration")
	await verifyRpc(config.chainId)
	const code = await ethers.provider.getCode(config.diamondAddress)
	if (code === "0x") {
		throw new Error(`No contract deployed at diamondAddress ${config.diamondAddress}`)
	}

	let [signer] = await ethers.getSigners()
	if (!signer) throw new Error("No signer configured")
	if (forkImpersonateAddress) {
		if (!ethers.isAddress(forkImpersonateAddress) || forkImpersonateAddress === ethers.ZeroAddress) {
			throw new Error(`Invalid FORK_IMPERSONATE_CLEARING_HOUSE: ${forkImpersonateAddress}`)
		}
		const impersonatedAddress = ethers.getAddress(forkImpersonateAddress)
		await networkHelpers.impersonateAccount(impersonatedAddress)
		await networkHelpers.setBalance(impersonatedAddress, ethers.parseEther("100"))
		signer = await ethers.getImpersonatedSigner(impersonatedAddress)
	}
	const signerAddress = await signer.getAddress()
	const access = new ethers.Contract(config.diamondAddress, ["function hasRole(address user, bytes32 role) view returns (bool)"], signer)
	const authorized = await access.hasRole(signerAddress, CLEARING_HOUSE_ROLE)
	const usingBigBlocks = isForkImpersonation ? undefined : await readUsingBigBlocks(config, signerAddress)

	log.kv("Network", `${networkName} (${config.chainId})`)
	log.kv("Config", configFile)
	log.kv("Diamond", config.diamondAddress)
	log.kv("PartyA", config.partyA)
	log.kv("PartyB receiver", config.partyB)
	log.kv("Signer", signerAddress)
	log.kv("ClearingHouse role", String(authorized))
	log.kv("Dry run", String(dryRun))
	log.kv("Selected step", step)
	log.kv("Position batch size", String(positionBatchSize))
	if (usingBigBlocks !== undefined) log.kv("Using big blocks", String(usingBigBlocks))
	log.stepDone(rpcTimer)

	if (!dryRun) {
		if (process.env.USE_KEYSTORE !== "true" && !isForkImpersonation) {
			throw new Error("Live takeover execution requires USE_KEYSTORE=true")
		}
		if (!authorized) {
			throw new Error(`Signer ${signerAddress} does not have CLEARING_HOUSE_ROLE`)
		}
		if (usingBigBlocks === true && process.env.ALLOW_BIG_BLOCKS !== "true") {
			throw new Error("Signer is configured for HyperEVM big blocks. Disable big blocks first, or explicitly set ALLOW_BIG_BLOCKS=true after review.")
		}
	}

	const context: TakeoverContext = {
		config,
		configFile,
		journalFile: process.env.PARTY_A_TAKEOVER_JOURNAL_FILE || journalPath(config),
		dryRun,
		authorized,
		usingBigBlocks,
		positionBatchSize,
		signerAddress,
		clearingHouse: await ethers.getContractAt(
			"contracts/core/facets/ClearingHouse/ClearingHouseFacet.sol:ClearingHouseFacet",
			config.diamondAddress,
			signer,
		),
		view: await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", config.diamondAddress, signer),
		quoteView: await ethers.getContractAt("contracts/core/facets/ViewFacetQuote/ViewFacetQuote.sol:ViewFacetQuote", config.diamondAddress, signer),
	}

	const inspectTimer = log.step("Inspect current takeover state")
	const initial = await inspect(context)
	log.stepDone(inspectTimer)
	if (step === "inspect" || (!initial.takeoverInProgress && !initial.isLiquidated)) {
		return
	}

	if (dryRun && !authorized) {
		log.warn("Signer lacks CLEARING_HOUSE_ROLE, so mutation static-calls cannot be authenticated")
		log.info("Re-run with USE_KEYSTORE=true for an authenticated dry run")
		return
	}
	if (dryRun && step === "all") {
		log.warn("DRY RUN — dependent later steps cannot be statefully simulated against a live RPC")
		log.info("The current pending and positions calls will be static-called; no transactions will be submitted")
		const pendingTimer = log.step("Preflight pending quotes")
		await processPending(context)
		log.stepDone(pendingTimer)
		const positionsTimer = log.step("Preflight open positions")
		await processPositions(context)
		log.stepDone(positionsTimer)
		return
	}

	const actions =
		step === "all"
			? ([
					["Process pending quotes", processPending],
					["Close open positions", processPositions],
					["Deallocate PartyA recovery", deallocate],
					["Distribute recovery", distribute],
					["Settle takeover", settle],
				] as const)
			: ([
					[
						{
							pending: "Process pending quotes",
							positions: "Close open positions",
							deallocate: "Deallocate PartyA recovery",
							distribute: "Distribute recovery",
							settle: "Settle takeover",
						}[step],
						{
							pending: processPending,
							positions: processPositions,
							deallocate,
							distribute,
							settle,
						}[step],
					],
				] as const)

	for (const [title, action] of actions) {
		const timer = log.step(title)
		await action(context)
		log.stepDone(timer)
	}

	const finalSnapshot = await readSnapshot(context)
	if (step === "all" && !dryRun) {
		log.success("PartyA takeover completed", [
			["PartyA", config.partyA],
			["PartyB receiver", config.partyB],
			["Liquidated", String(finalSnapshot.isLiquidated)],
			["Takeover active", String(finalSnapshot.takeoverInProgress)],
			["Open positions", finalSnapshot.openPositionsCount.toString()],
			["Pending quotes", String(finalSnapshot.pendingQuoteIds.length)],
			["PartyB isolated", ethers.formatEther(finalSnapshot.partyBAllocated)],
			["Journal", context.journalFile],
		])
	} else if (dryRun) {
		log.warn("DRY RUN — no transactions submitted")
	}
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
