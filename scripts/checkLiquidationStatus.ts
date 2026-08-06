/**
 * Inspect a v0.8.4 PartyA liquidation without requiring a signer.
 *
 * DIAMOND_ADDRESS=0x... PARTY_A_ADDRESS=0x... EXPECTED_CHAIN_ID=8453 \
 *   ./node_modules/.bin/hardhat run scripts/checkLiquidationStatus.ts --network base
 */
import { ethers } from "../test/helpers/hardhat-connection.js"

function requiredAddress(name: string): string {
	const value = process.env[name]
	if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
		throw new Error(`${name} is required and must be a non-zero address`)
	}
	return ethers.getAddress(value)
}

const DIAMOND = requiredAddress("DIAMOND_ADDRESS")
const PARTY_A = requiredAddress("PARTY_A_ADDRESS")
const expectedChainIdRaw = process.env.EXPECTED_CHAIN_ID
const expectedChainId = expectedChainIdRaw === undefined ? undefined : Number(expectedChainIdRaw)
if (expectedChainId !== undefined && (!Number.isSafeInteger(expectedChainId) || expectedChainId < 1)) {
	throw new Error(`EXPECTED_CHAIN_ID must be a positive safe integer; received ${expectedChainIdRaw}`)
}

// ABI matching the deployed v0.8.4 contract (single ViewFacet, Quote without closeFee/data fields)
const VIEW_ABI = [
	// Account
	"function balanceOf(address user) view returns (uint256)",
	"function partyAStats(address partyA) view returns (bool, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)",
	"function balanceInfoOfPartyA(address partyA) view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)",
	"function allocatedBalanceOfPartyA(address partyA) view returns (uint256)",
	"function allocatedBalanceOfPartyB(address partyB, address partyA) view returns (uint256)",
	"function allocatedBalanceOfPartyBs(address partyA, address[] partyBs) view returns (uint256[])",
	// Liquidation
	"function isPartyALiquidated(address partyA) view returns (bool)",
	"function getLiquidatedStateOfPartyA(address partyA) view returns (tuple(bytes liquidationId, uint8 liquidationType, int256 upnl, int256 totalUnrealizedLoss, uint256 deficit, uint256 liquidationFee, uint256 timestamp, uint256 involvedPartyBCounts, int256 partyAAccumulatedUpnl, bool disputed, uint256 liquidationTimestamp))",
	"function isPartyBLiquidated(address partyB, address partyA) view returns (bool)",
	"function partyBLiquidationTimestamp(address partyB, address partyA) view returns (uint256)",
	"function getSettlementStates(address partyA, address[] partyBs) view returns (tuple(int256 actualAmount, int256 expectedAmount, uint256 cva, bool pending)[])",
	// Quotes (Quote struct matching v0.8.4 — no accumulatedPaidFunding, closeFee, data)
	"function getQuote(uint256 quoteId) view returns (tuple(uint256 id, address[] partyBsWhiteList, uint256 symbolId, uint8 positionType, uint8 orderType, uint256 openedPrice, uint256 initialOpenedPrice, uint256 requestedOpenPrice, uint256 marketPrice, uint256 quantity, uint256 closedAmount, tuple(uint256 cva, uint256 lf, uint256 partyAmm, uint256 partyBmm) initialLockedValues, tuple(uint256 cva, uint256 lf, uint256 partyAmm, uint256 partyBmm) lockedValues, uint256 maxFundingRate, address partyA, address partyB, uint8 quoteStatus, uint256 avgClosedPrice, uint256 requestedClosePrice, uint256 quantityToClose, uint256 parentId, uint256 createTimestamp, uint256 statusModifyTimestamp, uint256 lastFundingPaymentTimestamp, uint256 deadline, uint256 tradingFee, address affiliate))",
	"function getQuotes(address partyA, uint256 start, uint256 size) view returns (tuple(uint256 id, address[] partyBsWhiteList, uint256 symbolId, uint8 positionType, uint8 orderType, uint256 openedPrice, uint256 initialOpenedPrice, uint256 requestedOpenPrice, uint256 marketPrice, uint256 quantity, uint256 closedAmount, tuple(uint256 cva, uint256 lf, uint256 partyAmm, uint256 partyBmm) initialLockedValues, tuple(uint256 cva, uint256 lf, uint256 partyAmm, uint256 partyBmm) lockedValues, uint256 maxFundingRate, address partyA, address partyB, uint8 quoteStatus, uint256 avgClosedPrice, uint256 requestedClosePrice, uint256 quantityToClose, uint256 parentId, uint256 createTimestamp, uint256 statusModifyTimestamp, uint256 lastFundingPaymentTimestamp, uint256 deadline, uint256 tradingFee, address affiliate)[])",
	"function getPartyAOpenPositions(address partyA, uint256 start, uint256 size) view returns (tuple(uint256 id, address[] partyBsWhiteList, uint256 symbolId, uint8 positionType, uint8 orderType, uint256 openedPrice, uint256 initialOpenedPrice, uint256 requestedOpenPrice, uint256 marketPrice, uint256 quantity, uint256 closedAmount, tuple(uint256 cva, uint256 lf, uint256 partyAmm, uint256 partyBmm) initialLockedValues, tuple(uint256 cva, uint256 lf, uint256 partyAmm, uint256 partyBmm) lockedValues, uint256 maxFundingRate, address partyA, address partyB, uint8 quoteStatus, uint256 avgClosedPrice, uint256 requestedClosePrice, uint256 quantityToClose, uint256 parentId, uint256 createTimestamp, uint256 statusModifyTimestamp, uint256 lastFundingPaymentTimestamp, uint256 deadline, uint256 tradingFee, address affiliate)[])",
	"function getPartyAPendingQuotes(address partyA) view returns (uint256[])",
	"function quotesLength(address user) view returns (uint256)",
	"function partyAPositionsCount(address partyA) view returns (uint256)",
	"function getNextQuoteId() view returns (uint256)",
	// Protocol params
	"function liquidatorShare() view returns (uint256)",
	"function liquidationTimeout() view returns (uint256)",
]

const network = await ethers.provider.getNetwork()
if (expectedChainId !== undefined && network.chainId !== BigInt(expectedChainId)) {
	throw new Error(`Chain ID mismatch: connected to ${network.chainId}, expected ${expectedChainId}`)
}
if ((await ethers.provider.getCode(DIAMOND)) === "0x") throw new Error(`No Diamond code at ${DIAMOND}`)
const diamond = new ethers.Contract(DIAMOND, VIEW_ABI, ethers.provider)

const fmt = (val: bigint) => ethers.formatEther(val)
const fmtSigned = (val: bigint) => {
	const sign = val < 0n ? "-" : ""
	const abs = val < 0n ? -val : val
	return sign + ethers.formatEther(abs)
}

const LiquidationTypeNames = ["NONE", "NORMAL", "LATE", "OVERDUE"]
const QuoteStatusNames = [
	"PENDING",
	"LOCKED",
	"CANCEL_PENDING",
	"CANCELED",
	"OPENED",
	"CLOSE_PENDING",
	"CANCEL_CLOSE_PENDING",
	"CLOSED",
	"LIQUIDATED",
	"EXPIRED",
	"LIQUIDATED_PENDING",
]
const PositionTypeNames = ["LONG", "SHORT"]

// ─── Version Check ──────────────────────────────────────────────────────────

// Verify the deployed contract is v0.8.4 by checking that getConnectedPartyBs does NOT exist
// (it was added in v0.8.5). We do this by calling it and expecting a revert.
const v085Selector = ethers.id("getConnectedPartyBs(address)").slice(0, 10)
const calldata = v085Selector + ethers.AbiCoder.defaultAbiCoder().encode(["address"], [PARTY_A]).slice(2)
let detectedVersion = "0.8.4"
try {
	await ethers.provider.call({ to: DIAMOND, data: calldata })
	detectedVersion = ">=0.8.5"
} catch {
	// expected for v0.8.4
}
console.log("=".repeat(80))
console.log("LIQUIDATION STATUS CHECK")
console.log(`PartyA:   ${PARTY_A}`)
console.log(`Diamond:  ${DIAMOND}`)
console.log(`Contract: v${detectedVersion} (expected v0.8.4)`)
console.log("=".repeat(80))

if (detectedVersion !== "0.8.4") {
	console.log("\nWARNING: Contract appears to be newer than v0.8.4. Results may be incorrect.\n")
}

// ─── 1. Liquidation Overview ────────────────────────────────────────────────

console.log("\n--- 1. LIQUIDATION OVERVIEW ---")

const [isLiquidated, liquidationDetail, stats] = await Promise.all([
	diamond.isPartyALiquidated(PARTY_A),
	diamond.getLiquidatedStateOfPartyA(PARTY_A),
	diamond.partyAStats(PARTY_A),
])

console.log(`Is Liquidated:      ${isLiquidated}`)
console.log(`Liquidation Status: ${stats[0] ? "IN LIQUIDATION" : "NOT IN LIQUIDATION"}`)

// Find the liquidator address from LiquidatePartyA event logs.
// No view function exists for this; the liquidators[] array is only written to storage.
// Event: LiquidatePartyA(address liquidator, address partyA, uint256 allocatedBalance, int256 upnl, int256 totalUnrealizedLoss, bytes liquidationId)
const liqEventAbi = [
	"event LiquidatePartyA(address liquidator, address partyA, uint256 allocatedBalance, int256 upnl, int256 totalUnrealizedLoss, bytes liquidationId)",
]
const liqEventContract = new ethers.Contract(DIAMOND, liqEventAbi, ethers.provider)
const liqId = liquidationDetail.liquidationId

if (liqId !== "0x" && liquidationDetail.liquidationTimestamp > 0n) {
	// None of the event params are indexed, so we must fetch all events in a range.
	// To keep the range small, binary-search for the block closest to liquidationTimestamp,
	// then scan a narrow window around it (±500 blocks ≈ ~17 min on Base @ 2s/block).
	const provider = ethers.provider
	const liqUnix = Number(liquidationDetail.liquidationTimestamp)
	const currentBlock = await provider.getBlockNumber()

	// Binary search: find block whose timestamp is closest to liqUnix
	let lo = 0
	let hi = currentBlock
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2)
		const block = await provider.getBlock(mid)
		if (!block) break
		if (block.timestamp < liqUnix) {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	const fromBlock = Math.max(0, lo - 500)
	const toBlock = Math.min(currentBlock, lo + 500)

	try {
		const filter = liqEventContract.filters.LiquidatePartyA()
		const logs = await liqEventContract.queryFilter(filter, fromBlock, toBlock)
		const partyALower = PARTY_A.toLowerCase()
		const matchingLog = logs.find((log: any) => log.args.partyA.toLowerCase() === partyALower && log.args.liquidationId === liqId)
		if (matchingLog) {
			console.log(`Liquidator:         ${(matchingLog as any).args.liquidator}`)
		} else {
			// Fallback: any event for this partyA in the window
			const partyALog = logs.find((log: any) => log.args.partyA.toLowerCase() === partyALower)
			if (partyALog) {
				console.log(`Liquidator:         ${(partyALog as any).args.liquidator} (nearest event, liquidationId may differ)`)
			} else {
				console.log(`Liquidator:         (no LiquidatePartyA events found near liquidation timestamp)`)
			}
		}
	} catch (err: any) {
		console.log(`Liquidator:         (failed to query events: ${err.message?.slice(0, 80)})`)
	}
}

// ─── 2. LiquidationDetail Struct ────────────────────────────────────────────

console.log("\n--- 2. LIQUIDATION DETAIL ---")

const liqType = Number(liquidationDetail.liquidationType)
console.log(`Liquidation ID:          ${liqId === "0x" ? "(none)" : liqId}`)
console.log(`Liquidation Type:        ${LiquidationTypeNames[liqType] ?? liqType}`)
console.log(`UPnL:                    ${fmtSigned(liquidationDetail.upnl)}`)
console.log(`Total Unrealized Loss:   ${fmtSigned(liquidationDetail.totalUnrealizedLoss)}`)
console.log(`Deficit:                 ${fmt(liquidationDetail.deficit)}`)
console.log(`Liquidation Fee:         ${fmt(liquidationDetail.liquidationFee)}`)
console.log(
	`Timestamp:               ${liquidationDetail.timestamp > 0n ? new Date(Number(liquidationDetail.timestamp) * 1000).toISOString() : "(none)"}`,
)
console.log(`Involved PartyB Counts:  ${liquidationDetail.involvedPartyBCounts}`)
console.log(`PartyA Accumulated UPnL: ${fmtSigned(liquidationDetail.partyAAccumulatedUpnl)}`)
console.log(`Disputed:                ${liquidationDetail.disputed}`)
console.log(
	`Liquidation Timestamp:   ${liquidationDetail.liquidationTimestamp > 0n ? new Date(Number(liquidationDetail.liquidationTimestamp) * 1000).toISOString() : "(none)"}`,
)

// ─── 3. Account Balances ────────────────────────────────────────────────────

console.log("\n--- 3. ACCOUNT BALANCES ---")

const [balance, allocatedBalance, balanceInfo] = await Promise.all([
	diamond.balanceOf(PARTY_A),
	diamond.allocatedBalanceOfPartyA(PARTY_A),
	diamond.balanceInfoOfPartyA(PARTY_A),
])

console.log(`Withdrawable Balance:    ${fmt(balance)}`)
console.log(`Allocated Balance:       ${fmt(allocatedBalance)}`)
console.log()
console.log("Balance Info:")
console.log(`  Allocated:             ${fmt(balanceInfo[0])}`)
console.log(`  Locked CVA:            ${fmt(balanceInfo[1])}`)
console.log(`  Locked LF:             ${fmt(balanceInfo[2])}`)
console.log(`  Locked PartyAmm:       ${fmt(balanceInfo[3])}`)
console.log(`  Locked PartyBmm:       ${fmt(balanceInfo[4])}`)
console.log(`  Pending CVA:           ${fmt(balanceInfo[5])}`)
console.log(`  Pending LF:            ${fmt(balanceInfo[6])}`)
console.log(`  Pending PartyAmm:      ${fmt(balanceInfo[7])}`)
console.log(`  Pending PartyBmm:      ${fmt(balanceInfo[8])}`)

console.log()
console.log("PartyA Stats (full):")
console.log(`  Liquidation Status:    ${stats[0]}`)
console.log(`  Allocated Balance:     ${fmt(stats[1])}`)
console.log(`  Locked CVA:            ${fmt(stats[2])}`)
console.log(`  Locked LF:             ${fmt(stats[3])}`)
console.log(`  Locked PartyAmm:       ${fmt(stats[4])}`)
console.log(`  Locked PartyBmm:       ${fmt(stats[5])}`)
console.log(`  Pending CVA:           ${fmt(stats[6])}`)
console.log(`  Pending LF:            ${fmt(stats[7])}`)
console.log(`  Pending PartyAmm:      ${fmt(stats[8])}`)
console.log(`  Pending PartyBmm:      ${fmt(stats[9])}`)
console.log(`  Positions Count:       ${stats[10]}`)
console.log(`  Pending Quotes Count:  ${stats[11]}`)
console.log(`  Nonce:                 ${stats[12]}`)
console.log(`  Total Quotes Length:   ${stats[13]}`)

// ─── 4. PartyBs & Settlement ────────────────────────────────────────────────
// getConnectedPartyBs does not exist in v0.8.4, so we derive unique PartyBs from open positions.

console.log("\n--- 4. PARTY Bs & SETTLEMENT ---")

const positionsCount: bigint = await diamond.partyAPositionsCount(PARTY_A)
let openPositions: any[] = []
if (positionsCount > 0n) {
	openPositions = await diamond.getPartyAOpenPositions(PARTY_A, 0, positionsCount)
}

// Extract unique PartyB addresses from open positions
const partyBSet = new Set<string>()
for (const q of openPositions) {
	if (q.partyB !== ethers.ZeroAddress) {
		partyBSet.add(q.partyB)
	}
}
const connectedPartyBs = Array.from(partyBSet)
console.log(`PartyBs (from open positions): ${connectedPartyBs.length}`)

if (connectedPartyBs.length > 0) {
	const [settlementStates, allocatedBalances] = await Promise.all([
		diamond.getSettlementStates(PARTY_A, connectedPartyBs),
		diamond.allocatedBalanceOfPartyBs(PARTY_A, connectedPartyBs),
	])

	for (let i = 0; i < connectedPartyBs.length; i++) {
		const partyB = connectedPartyBs[i]
		const [isPartyBLiq, partyBLiqTs] = await Promise.all([
			diamond.isPartyBLiquidated(partyB, PARTY_A),
			diamond.partyBLiquidationTimestamp(partyB, PARTY_A),
		])
		const settlement = settlementStates[i]

		console.log(`\n  PartyB: ${partyB}`)
		console.log(`    Allocated Balance:   ${fmt(allocatedBalances[i])}`)
		console.log(`    Is Liquidated:       ${isPartyBLiq}`)
		console.log(`    Liq Timestamp:       ${partyBLiqTs > 0n ? new Date(Number(partyBLiqTs) * 1000).toISOString() : "(none)"}`)
		console.log(`    Settlement:`)
		console.log(`      Actual Amount:     ${fmtSigned(settlement.actualAmount)}`)
		console.log(`      Expected Amount:   ${fmtSigned(settlement.expectedAmount)}`)
		console.log(`      CVA:               ${fmt(settlement.cva)}`)
		console.log(`      Pending:           ${settlement.pending}`)
	}
}

// ─── 5. Open Positions ─────────────────────────────────────────────────────

console.log("\n--- 5. OPEN POSITIONS ---")
console.log(`Open Positions Count: ${positionsCount}`)

for (const q of openPositions) {
	console.log(`\n  Quote #${q.id} | Symbol: ${q.symbolId} | ${PositionTypeNames[Number(q.positionType)] ?? q.positionType}`)
	console.log(`    Status:          ${QuoteStatusNames[Number(q.quoteStatus)] ?? q.quoteStatus}`)
	console.log(`    Opened Price:    ${fmt(q.openedPrice)}`)
	console.log(`    Quantity:        ${fmt(q.quantity)}`)
	console.log(`    Closed Amount:   ${fmt(q.closedAmount)}`)
	console.log(`    Avg Close Price: ${fmt(q.avgClosedPrice)}`)
	console.log(`    PartyB:          ${q.partyB}`)
	console.log(`    Trading Fee:     ${fmt(q.tradingFee)}`)
	console.log(
		`    Locked: CVA=${fmt(q.lockedValues.cva)} LF=${fmt(q.lockedValues.lf)} PartyAmm=${fmt(q.lockedValues.partyAmm)} PartyBmm=${fmt(q.lockedValues.partyBmm)}`,
	)
}

// ─── 6. Last Liquidation Positions ──────────────────────────────────────────
// liquidationTimestamp from LiquidationDetail marks when the last liquidation was initiated.
// Quotes liquidated as part of it have statusModifyTimestamp >= that value.
// Previous liquidations fully settle before a new one can start, so there's no overlap.

console.log("\n--- 6. LAST LIQUIDATION POSITIONS ---")

const liqTs = liquidationDetail.liquidationTimestamp
if (liqTs === 0n) {
	console.log("No liquidation on record (liquidationTimestamp = 0).")
} else {
	console.log(`Liquidation Timestamp: ${new Date(Number(liqTs) * 1000).toISOString()}`)

	const totalQuotes: bigint = await diamond.quotesLength(PARTY_A)
	console.log(`Total Quotes Ever: ${totalQuotes}`)

	const BATCH_SIZE = 50n
	let lastLiqQuotes: any[] = []

	for (let start = 0n; start < totalQuotes; start += BATCH_SIZE) {
		const size = start + BATCH_SIZE > totalQuotes ? totalQuotes - start : BATCH_SIZE
		const batch = await diamond.getQuotes(PARTY_A, start, size)
		for (const q of batch) {
			const status = Number(q.quoteStatus)
			if ((status === 8 || status === 10) && q.statusModifyTimestamp >= liqTs) {
				lastLiqQuotes.push(q)
			}
		}
	}

	console.log(`Quotes in last liquidation: ${lastLiqQuotes.length}`)
	for (const q of lastLiqQuotes) {
		console.log(`\n  Quote #${q.id} | Symbol: ${q.symbolId} | ${PositionTypeNames[Number(q.positionType)] ?? q.positionType}`)
		console.log(`    Status:          ${QuoteStatusNames[Number(q.quoteStatus)] ?? q.quoteStatus}`)
		console.log(`    Opened Price:    ${fmt(q.openedPrice)}`)
		console.log(`    Quantity:        ${fmt(q.quantity)}`)
		console.log(`    Closed Amount:   ${fmt(q.closedAmount)}`)
		console.log(`    Avg Close Price: ${fmt(q.avgClosedPrice)}`)
		console.log(`    PartyB:          ${q.partyB}`)
		console.log(`    Modified:        ${new Date(Number(q.statusModifyTimestamp) * 1000).toISOString()}`)
	}
}

// ─── 7. Pending Quotes ──────────────────────────────────────────────────────

console.log("\n--- 7. PENDING QUOTES ---")

const pendingQuoteIds: bigint[] = await diamond.getPartyAPendingQuotes(PARTY_A)
console.log(`Pending Quote IDs: ${pendingQuoteIds.length}`)

for (const qid of pendingQuoteIds) {
	const q = await diamond.getQuote(qid)
	console.log(`\n  Quote #${q.id} | Symbol: ${q.symbolId} | ${PositionTypeNames[Number(q.positionType)] ?? q.positionType}`)
	console.log(`    Status:          ${QuoteStatusNames[Number(q.quoteStatus)] ?? q.quoteStatus}`)
	console.log(`    Requested Price: ${fmt(q.requestedOpenPrice)}`)
	console.log(`    Quantity:        ${fmt(q.quantity)}`)
	console.log(`    PartyB:          ${q.partyB}`)
	console.log(`    Deadline:        ${new Date(Number(q.deadline) * 1000).toISOString()}`)
}

// ─── 8. Protocol Parameters ─────────────────────────────────────────────────

console.log("\n--- 8. PROTOCOL PARAMETERS ---")

const [liquidatorShare, liquidationTimeout] = await Promise.all([diamond.liquidatorShare(), diamond.liquidationTimeout()])

console.log(`Liquidator Share:    ${fmt(liquidatorShare)}`)
console.log(`Liquidation Timeout: ${liquidationTimeout} seconds`)

console.log("\n" + "=".repeat(80))
console.log("DONE")
console.log("=".repeat(80))
