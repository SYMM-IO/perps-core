import { toUtf8Bytes } from "ethers"
import fs from "fs"
import { ethers, run } from "hardhat"
import path from "path"

import { PositionType, QuoteStatus } from "../test/models/Enums"
import { Hedger } from "../test/models/Hedger"
import { createRunContext } from "../test/models/RunContext"
import { User } from "../test/models/User"
import { limitCloseRequestBuilder } from "../test/models/requestModels/CloseRequest"
import { limitFillCloseRequestBuilder } from "../test/models/requestModels/FillCloseRequest"
import { limitOpenRequestBuilder } from "../test/models/requestModels/OpenRequest"
import { limitQuoteRequestBuilder } from "../test/models/requestModels/QuoteRequest"
import { decimal, getBlockTimestamp, getQuoteQuantity } from "../test/utils/Common"
import { runTx } from "../test/utils/TxUtils"

// Note: this script is designed for v0.8.4 initialization state generation.
type SeededQuote = {
	id: bigint
	label: string
	expectedStatus: QuoteStatus
	partyA: string
	partyB: string
}

type QuoteReportRow = {
	id: string
	label: string
	partyA: string
	partyB: string
	expectedStatus: string
	actualStatus: string
}

const REPORT_FILE = process.env.INIT_UPGRADE_REPORT_FILE ?? "./scripts/output/initializeUpgradeTest-report.json"
const CREATE_LIQUIDATED_POSITION = parseBool(process.env.CREATE_LIQUIDATED_POSITION, false)

function parseBool(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value === null || value === "") return fallback
	const normalized = value.toLowerCase()
	if (normalized === "true" || normalized === "1") return true
	if (normalized === "false" || normalized === "0") return false
	throw new Error(`Invalid boolean value: ${value}`)
}

function ensureParentDir(filePath: string): void {
	const dir = path.dirname(filePath)
	if (dir && dir !== "." && !fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true })
	}
}

function quoteStatusName(status: bigint): string {
	const idx = Number(status)
	return QuoteStatus[idx] ?? `UNKNOWN_${idx}`
}

function formatError(error: unknown): string {
	if (error instanceof Error && error.stack) return error.stack
	if (error instanceof Error && error.message) return error.message
	return String(error)
}

async function lockAndOpen(context: any, hedger: Hedger, quoteId: bigint): Promise<void> {
	await hedger.lockQuote(quoteId)
	const filledAmount = await getQuoteQuantity(context, quoteId)
	await hedger.openPosition(quoteId, limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(decimal(1n)).price(decimal(1n)).build())
}

async function collectQuoteReport(
	context: any,
	seededQuotes: SeededQuote[],
): Promise<{ rows: QuoteReportRow[]; statusBuckets: Record<string, string[]> }> {
	const rows: QuoteReportRow[] = []
	const statusBuckets: Record<string, string[]> = {}

	for (const seeded of seededQuotes) {
		const quote = await context.viewFacet.getQuote(seeded.id)
		const actualStatus = quoteStatusName(BigInt(quote.quoteStatus))
		const expectedStatus = QuoteStatus[seeded.expectedStatus]
		rows.push({
			id: seeded.id.toString(),
			label: seeded.label,
			partyA: seeded.partyA,
			partyB: seeded.partyB,
			expectedStatus,
			actualStatus,
		})

		if (!statusBuckets[actualStatus]) {
			statusBuckets[actualStatus] = []
		}
		statusBuckets[actualStatus].push(seeded.id.toString())

		if (actualStatus !== expectedStatus) {
			throw new Error(`Quote ${seeded.id.toString()} (${seeded.label}) status mismatch. expected=${expectedStatus} actual=${actualStatus}`)
		}
	}

	return { rows, statusBuckets }
}

function buildConnectionMatrix(rows: QuoteReportRow[]): Record<string, Record<string, number>> {
	const matrix: Record<string, Record<string, number>> = {}
	for (const row of rows) {
		if (!matrix[row.partyA]) matrix[row.partyA] = {}
		if (!matrix[row.partyA][row.partyB]) matrix[row.partyA][row.partyB] = 0
		matrix[row.partyA][row.partyB] += 1
	}
	return matrix
}

export async function initializeAndDeposit(): Promise<void> {
	const collateral = await run("deploy:stablecoin")
	const diamond = await run("deploy:diamond", {
		logData: false,
		genABI: false,
		reportGas: true,
	})
	if (process.env.DEPLOY_MULTICALL == "true") {
		await run("deploy:multicall")
	}

	const multiAccount = await run("deploy:multiAccount", {
		symmioAddress: await diamond.getAddress(),
		admin: process.env.ADMIN_PUBLIC_KEY,
	})
	const multiAccount2 = await run("deploy:multiAccount", {
		symmioAddress: await diamond.getAddress(),
		admin: process.env.ADMIN_PUBLIC_KEY,
	})

	const context = await createRunContext(
		await diamond.getAddress(),
		await collateral.getAddress(),
		await multiAccount.getAddress(),
		await multiAccount2.getAddress(),
		true,
	)

	const adminAddress = await context.signers.admin.getAddress()
	await runTx(context.controlFacet.connect(context.signers.admin).setAdmin(adminAddress))
	await runTx(context.controlFacet.connect(context.signers.admin).setCollateral(await context.collateral.getAddress()))

	const roleNames = [
		"SYMBOL_MANAGER_ROLE",
		"SETTER_ROLE",
		"PAUSER_ROLE",
		"PARTY_B_MANAGER_ROLE",
		"SUSPENDER_ROLE",
		"DISPUTE_ROLE",
		"AFFILIATE_MANAGER_ROLE",
		"LIQUIDATOR_ROLE",
	]
	for (const roleName of roleNames) {
		await runTx(context.controlFacet.connect(context.signers.admin).grantRole(adminAddress, ethers.keccak256(toUtf8Bytes(roleName))))
	}

	await runTx(
		context.controlFacet
			.connect(context.signers.admin)
			.grantRole(await context.signers.liquidator.getAddress(), ethers.keccak256(toUtf8Bytes("LIQUIDATOR_ROLE"))),
	)

	await runTx(
		context.controlFacet
			.connect(context.signers.admin)
			.addSymbol("BTCUSDT", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900),
	)

	await runTx(context.controlFacet.connect(context.signers.admin).setPendingQuotesValidLength(10))
	await runTx(context.controlFacet.connect(context.signers.admin).setLiquidatorShare(decimal(1n, 17)))
	await runTx(context.controlFacet.connect(context.signers.admin).setLiquidationTimeout(100))
	await runTx(context.controlFacet.connect(context.signers.admin).setDeallocateCooldown(120))
	await runTx(context.controlFacet.connect(context.signers.admin).setSettlementCooldown(300))
	await runTx(context.controlFacet.connect(context.signers.admin).setDeallocateDebounceTime(120))
	await runTx(context.controlFacet.connect(context.signers.admin).setBalanceLimitPerUser(decimal(10000n)))
	await runTx(context.controlFacet.connect(context.signers.admin).setForceCloseCooldowns(300, 120))
	await runTx(context.controlFacet.connect(context.signers.admin).setForceCancelCooldown(300))
	await runTx(context.controlFacet.connect(context.signers.admin).setForceCancelCloseCooldown(300))
	await runTx(context.controlFacet.connect(context.signers.admin).setInvalidBridgedAmountsPool(context.signers.feeCollector.getAddress()))
	await runTx(context.controlFacet.connect(context.signers.admin).registerPartyB(context.signers.hedger.getAddress()))
	await runTx(context.controlFacet.connect(context.signers.admin).registerPartyB(context.signers.hedger2.getAddress()))
	await runTx(context.controlFacet.connect(context.signers.admin).registerAffiliate(context.multiAccount))
	await runTx(context.controlFacet.connect(context.signers.admin).registerAffiliate(context.multiAccount2!))
	await runTx(context.controlFacet.connect(context.signers.admin).setFeeCollector(context.multiAccount, context.signers.feeCollector.address))
	await runTx(context.controlFacet.connect(context.signers.admin).setFeeCollector(context.multiAccount2!, context.signers.feeCollector2.address))

	const userA1 = new User(context, context.signers.user)
	const userA2 = new User(context, context.signers.user2)
	await userA1.setup()
	await userA2.setup()
	await userA1.setBalances(decimal(6000n), decimal(4200n), decimal(2300n))
	await userA2.setBalances(decimal(6000n), decimal(3800n), decimal(1300n))

	const hedgerB1 = new Hedger(context, context.signers.hedger)
	const hedgerB2 = new Hedger(context, context.signers.hedger2)
	await hedgerB1.setup()
	await hedgerB2.setup()
	await hedgerB1.setBalances(decimal(25000n), decimal(17000n))
	await hedgerB2.setBalances(decimal(25000n), decimal(17000n))

	const partyA1 = await userA1.getAddress()
	const partyA2 = await userA2.getAddress()
	const partyB1 = await hedgerB1.getAddress()
	const partyB2 = await hedgerB2.getAddress()

	const seededQuotes: SeededQuote[] = []

	const pendingA1B1 = await userA1.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB1]).deadline(getBlockTimestamp(86400n)).build())
	seededQuotes.push({ id: pendingA1B1, label: "pending_A1_B1", expectedStatus: QuoteStatus.PENDING, partyA: partyA1, partyB: partyB1 })

	const lockedA1B2 = await userA1.sendQuote(
		limitQuoteRequestBuilder().partyBWhiteList([partyB2]).positionType(PositionType.SHORT).deadline(getBlockTimestamp(86400n)).build(),
	)
	await hedgerB2.lockQuote(lockedA1B2)
	seededQuotes.push({ id: lockedA1B2, label: "locked_A1_B2", expectedStatus: QuoteStatus.LOCKED, partyA: partyA1, partyB: partyB2 })

	const openA2B1 = await userA2.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB1]).deadline(getBlockTimestamp(86400n)).build())
	await lockAndOpen(context, hedgerB1, openA2B1)
	const openA2B1Seed: SeededQuote = {
		id: openA2B1,
		label: "open_A2_B1",
		expectedStatus: QuoteStatus.OPENED,
		partyA: partyA2,
		partyB: partyB1,
	}
	seededQuotes.push(openA2B1Seed)

	const closePendingA1B1 = await userA1.sendQuote(
		limitQuoteRequestBuilder().partyBWhiteList([partyB1]).positionType(PositionType.SHORT).deadline(getBlockTimestamp(86400n)).build(),
	)
	await lockAndOpen(context, hedgerB1, closePendingA1B1)
	await userA1.requestToClosePosition(closePendingA1B1, limitCloseRequestBuilder().deadline(getBlockTimestamp(86400n)).build())
	seededQuotes.push({
		id: closePendingA1B1,
		label: "close_pending_A1_B1",
		expectedStatus: QuoteStatus.CLOSE_PENDING,
		partyA: partyA1,
		partyB: partyB1,
	})

	const closedA2B2 = await userA2.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyB2]).deadline(getBlockTimestamp(86400n)).build())
	await lockAndOpen(context, hedgerB2, closedA2B2)
	await userA2.requestToClosePosition(closedA2B2, limitCloseRequestBuilder().deadline(getBlockTimestamp(86400n)).build())
	await hedgerB2.fillCloseRequest(closedA2B2, limitFillCloseRequestBuilder().build())
	seededQuotes.push({ id: closedA2B2, label: "closed_A2_B2", expectedStatus: QuoteStatus.CLOSED, partyA: partyA2, partyB: partyB2 })

	const liquidatableA2B1 = await userA2.sendQuote(
		limitQuoteRequestBuilder()
			.partyBWhiteList([partyB1])
			.quantity(decimal(2000n))
			.positionType(PositionType.LONG)
			.deadline(getBlockTimestamp(86400n))
			.build(),
	)
	await lockAndOpen(context, hedgerB1, liquidatableA2B1)
	const liquidatableA2B1Seed: SeededQuote = {
		id: liquidatableA2B1,
		label: "liquidatable_A2_B1",
		expectedStatus: QuoteStatus.OPENED,
		partyA: partyA2,
		partyB: partyB1,
	}
	seededQuotes.push(liquidatableA2B1Seed)

	let liquidationAttemptError: string | null = null
	if (CREATE_LIQUIDATED_POSITION) {
		try {
			await userA2.liquidateAndSetSymbolPrices([1n], [decimal(1n, 17)], context.signers.liquidator)
			await userA2.liquidatePendingPositions(context.signers.liquidator)
			await userA2.liquidatePositions([], context.signers.liquidator)
			openA2B1Seed.expectedStatus = QuoteStatus.LIQUIDATED
			liquidatableA2B1Seed.expectedStatus = QuoteStatus.LIQUIDATED
		} catch (error) {
			liquidationAttemptError = formatError(error)
			console.warn("Liquidation attempt failed. Keeping expected statuses as OPENED.")
			console.warn(liquidationAttemptError)
		}
	}

	const { rows, statusBuckets } = await collectQuoteReport(context, seededQuotes)
	const connectionMatrix = buildConnectionMatrix(rows)

	const report = {
		generatedAt: new Date().toISOString(),
		createLiquidatedPosition: CREATE_LIQUIDATED_POSITION,
		liquidationAttemptError,
		addresses: {
			diamond: context.diamond,
			collateral: await context.collateral.getAddress(),
			multiAccount: context.multiAccount,
			multiAccount2: context.multiAccount2,
			admin: await context.signers.admin.getAddress(),
			liquidator: await context.signers.liquidator.getAddress(),
			partyAs: [partyA1, partyA2],
			partyBs: [partyB1, partyB2],
		},
		quotes: rows,
		statusBuckets,
		connectionMatrix,
	}

	ensureParentDir(REPORT_FILE)
	fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2))

	console.log("Initialized and seeded upgrade dataset.")
	console.log("Status buckets:", JSON.stringify(statusBuckets))
	console.log("Connection matrix:", JSON.stringify(connectionMatrix))
	console.log("Address report:")
	console.log("  diamond:", context.diamond)
	console.log("  collateral:", await context.collateral.getAddress())
	console.log("  multiAccount:", context.multiAccount)
	console.log("  multiAccount2:", context.multiAccount2)
	console.log("  admin:", await context.signers.admin.getAddress())
	console.log("  partyA1:", partyA1)
	console.log("  partyA2:", partyA2)
	console.log("  partyB1:", partyB1)
	console.log("  partyB2:", partyB2)
	console.log("  liquidator:", await context.signers.liquidator.getAddress())
	console.log("Initialization report:", REPORT_FILE)
}

async function main() {
	await initializeAndDeposit()
	console.log("Initialized and deposited successfully")
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
