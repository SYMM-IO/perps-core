import { expect } from "chai"
import { ethers, toUtf8Bytes, ZeroAddress, type AddressLike } from "ethers"

import type { QuoteStructOutput } from "../src/types/interfaces/ISymmio.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { LiquidationType, PositionType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder, marketQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import {
	LiquidateCrossPartyBValidator,
	TakeoverPartyALiquidationValidator,
	DeallocateForCHValidator,
	DistributeForCHValidator,
	LiquidatePendingCHValidator,
	LiquidatePositionsCHValidator,
	SettlePartyATakeoverValidator,
	SettleCrossPartyBValidator,
	SoftPartyBLiquidationValidator,
} from "./models/validators/ClearingHouseValidators.js"
import { decimal, getBlockTimestamp, getPriceFetcher, getTradingFeeForQuotes } from "./utils/Common.js"
import { migratePartyBToCross } from "./utils/CrossPartyB.js"
import { getDummyLiquidationSig, getDummySingleUpnlAndPriceSig } from "./utils/SignatureUtils.js"

enum BalanceChangeType {
	ALLOCATE,
	DEALLOCATE,
	PLATFORM_FEE_IN,
	PLATFORM_FEE_OUT,
	REALIZED_PNL_IN,
	REALIZED_PNL_OUT,
	CVA_IN,
	CVA_OUT,
	LF_IN,
	LF_OUT,
	FUNDING_FEE_IN,
	FUNDING_FEE_OUT,
	DEFERRED_BALANCE_IN,
	DEFERRED_BALANCE_OUT,
	REIMBURSEMENT_IN,
	OPERATIONAL_FEE_OUT,
	OPEN_SOLVER_FEE_OUT,
	CLOSE_SOLVER_FEE_OUT,
	SETTLEMENT_PNL_IN,
	SETTLEMENT_PNL_OUT,
}

enum ReimbursementChangeType {
	CLEARING_HOUSE_IN_DEPRECATED,
	PLATFORM_FEE_IN,
	CLEARING_HOUSE_OUT_DEPRECATED,
	RELEASE_TO_ALLOCATED,
	MOVE_TO_LIQUIDATION_ESCROW,
	REALIZED_PNL_IN,
	REALIZED_PNL_OUT,
	FUNDING_FEE_IN,
	FUNDING_FEE_OUT,
	PLATFORM_FEE_OUT,
}

const balanceChangeInterface = new ethers.Interface([
	"event BalanceChangePartyA(address indexed partyA, uint256 amount, uint8 _type)",
	"event BalanceChangePartyB(address indexed partyB, address indexed partyA, uint256 amount, uint8 _type)",
])
const reimbursementChangeInterface = new ethers.Interface([
	"event PartyAReimbursementChange(address indexed partyA, uint256 amount, uint256 newBalance, uint8 _type)",
])
const explicitClearingHouseSettlementAbi = [
	"function applyClearingHouseSettlement(address subject, (address account, address allocationKey, uint256 symbolId, int256 realizedPnl, int256 funding, int256 platformFee)[] settlements)",
	"event ClearingHouseAccountSettlement(address indexed subject, address indexed account, address indexed allocationKey, int256 amount)",
	"event ClearingHouseSettlementComponent(address indexed subject, address indexed account, uint256 indexed symbolId, address allocationKey, int256 realizedPnl, int256 funding, int256 platformFee)",
]
const explicitClearingHouseSettlementInterface = new ethers.Interface(explicitClearingHouseSettlementAbi)

type EvmLog = { topics: readonly string[]; data: string }
type ClearingHouseSettlementInput = {
	account: string
	allocationKey: string
	symbolId: bigint
	realizedPnl: bigint
	funding: bigint
	platformFee: bigint
}

function sortClearingHouseSettlements<T extends ClearingHouseSettlementInput>(settlements: T[]): T[] {
	return [...settlements].sort((left, right) => {
		if (left.account !== right.account) return BigInt(left.account) < BigInt(right.account) ? -1 : 1
		if (left.allocationKey !== right.allocationKey) return BigInt(left.allocationKey) < BigInt(right.allocationKey) ? -1 : 1
		if (left.symbolId === right.symbolId) return 0
		return left.symbolId < right.symbolId ? -1 : 1
	})
}

function parsePartyAReimbursementChangeLogs(logs: readonly EvmLog[]) {
	return logs.flatMap(log => {
		try {
			const parsed = reimbursementChangeInterface.parseLog({ topics: log.topics as string[], data: log.data })
			if (parsed?.name !== "PartyAReimbursementChange") return []
			return [
				{
					partyA: parsed.args.partyA as string,
					amount: parsed.args.amount as bigint,
					newBalance: parsed.args.newBalance as bigint,
					changeType: parsed.args._type as bigint,
				},
			]
		} catch {
			return []
		}
	})
}

function parseAllocatedBalanceChangeLogs(logs: readonly EvmLog[]) {
	return logs.flatMap(log => {
		try {
			const parsed = balanceChangeInterface.parseLog({ topics: log.topics as string[], data: log.data })
			if (!parsed || (parsed.name !== "BalanceChangePartyA" && parsed.name !== "BalanceChangePartyB")) return []
			return [
				{
					name: parsed.name,
					account: (parsed.name === "BalanceChangePartyA" ? parsed.args.partyA : parsed.args.partyB) as string,
					allocationKey: parsed.name === "BalanceChangePartyB" ? (parsed.args.partyA as string) : ZeroAddress,
					amount: parsed.args.amount as bigint,
					changeType: parsed.args._type as bigint,
				},
			]
		} catch {
			return []
		}
	})
}

function parseClearingHouseSettlementLogs(logs: readonly EvmLog[]) {
	return logs.flatMap(log => {
		try {
			const parsed = explicitClearingHouseSettlementInterface.parseLog({ topics: log.topics as string[], data: log.data })
			if (!parsed) return []
			return [{ name: parsed.name, args: parsed.args }]
		} catch {
			return []
		}
	})
}

export function shouldBehaveLikeClearingHouseFacet(): void {
	let context: RunContext, user: User, user2: User, liquidator: User, hedger: Hedger, hedger2: Hedger

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(2000n), decimal(2000n), decimal(2000n))

		user2 = new User(context, context.signers.user2)
		await user2.setup()
		await user2.setBalances(decimal(2000n), decimal(1000n), decimal(500n))

		liquidator = new User(context, context.signers.liquidator)
		await liquidator.setup()

		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(2000n), decimal(1000n))

		hedger2 = new Hedger(context, context.signers.hedger2)
		await hedger2.setup()
		await hedger2.setBalances(decimal(2000n), decimal(1000n))

		await hedger.setBalances(decimal(2000n), decimal(2000n))
		await hedger2.setBalances(decimal(2000n), decimal(2000n))
		await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(1000n, user.address)
		await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(1000n, user2.address)
		await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(2000n, ZeroAddress)
		await context.partyBAccountFacet.connect(context.signers.hedger2).allocateForPartyB(2000n, ZeroAddress)

		// Quote1 -> sent
		await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())

		// Quote2 -> sent
		await user.sendQuote()

		// Quote3 -> sent
		await user.sendQuote()

		// Quote4 -> sent
		await user.sendQuote()

		// Quote5 -> sent
		await user.sendQuote()

		await context.controlFacet.grantRole(context.signers.liquidator.address, ethers.keccak256(toUtf8Bytes("CLEARING_HOUSE_ROLE")))
	})

	const applyClearingHousePnl = async (
		subject: AddressLike,
		accounts: AddressLike[],
		allocationKeys: AddressLike[],
		amounts: bigint[],
		direction: 1n | -1n,
	) => {
		const settlements = await Promise.all(
			accounts.map(async (account, index) => ({
				account: await ethers.resolveAddress(account),
				allocationKey: await ethers.resolveAddress(allocationKeys[index]),
				symbolId: 1n,
				realizedPnl: direction * amounts[index],
				funding: 0n,
				platformFee: 0n,
			})),
		)
		return context.clearingHouseFacet
			.connect(context.signers.liquidator)
			.applyClearingHouseSettlement(subject, sortClearingHouseSettlements(settlements))
	}

	const applyClearingHousePnlDebits = (subject: AddressLike, accounts: AddressLike[], allocationKeys: AddressLike[], amounts: bigint[]) =>
		applyClearingHousePnl(subject, accounts, allocationKeys, amounts, -1n)

	const applyClearingHousePnlCredits = (subject: AddressLike, accounts: AddressLike[], allocationKeys: AddressLike[], amounts: bigint[]) =>
		applyClearingHousePnl(subject, accounts, allocationKeys, amounts, 1n)

	// ============================================
	// CROSS PARTYB LIQUIDATION TESTS (UPDATED)
	// ============================================

	describe("None cross partyB mode", async function () {
		beforeEach(async function () {
			// Quote1 -> opened
			await hedger.lockQuote(1)
			await hedger.openPosition(1)

			// Quote2 -> locked
			await hedger.lockQuote(2)

			// Quote4 -> opened
			await hedger.lockQuote(4)
			await hedger.openPosition(4)

			// Quote5 -> locked
			await hedger.lockQuote(5)
		})
		describe("Access Control", async function () {
			it("Should fail when caller doesn't have CLEARING_HOUSE_ROLE", async function () {
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.user)
						.liquidateCrossPartyB(context.signers.hedger.address, "0x", 0n, await getBlockTimestamp()),
				).to.be.revertedWith("Accessibility: Must have role")
			})

			it("Should succeed when caller has CLEARING_HOUSE_ROLE", async function () {
				await context.controlFacet
					.connect(context.signers.admin)
					.grantRole(context.signers.user2.address, ethers.keccak256(toUtf8Bytes("CLEARING_HOUSE_ROLE")))

				// Activate cross mode for hedger
				await migratePartyBToCross(context, hedger, [1, 2, 4, 5])

				const upnl = BigInt("-999999999999999999999999999999")
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.user2)
						.liquidateCrossPartyB(context.signers.hedger.address, "0x", upnl, await getBlockTimestamp()),
				).to.not.be.reverted

				// Verify cross liquidation was actually initiated
				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger)).to.equal(true)
				const details = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)
				expect(details.inProgress).to.equal(true)
				expect(details.upnl).to.equal(upnl)
			})

			it("Should fail when liquidation is paused", async function () {
				await context.pauseControlFacet.connect(context.signers.admin).pauseLiquidation()

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidateCrossPartyB(context.signers.hedger.address, "0x", 0n, await getBlockTimestamp()),
				).to.be.revertedWith("Pausable: Liquidation paused")
			})

			it("Should fail when globally paused", async function () {
				await context.pauseControlFacet.connect(context.signers.admin).pauseGlobal()

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidateCrossPartyB(context.signers.hedger.address, "0x", 0n, await getBlockTimestamp()),
				).to.be.revertedWith("Pausable: Global paused")
			})
		})
	})

	describe("liquidateCrossPartyB", async function () {
		it("Should fail when partyB CrossMode not active", async function () {
			await expect(
				context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.getAddress(), "0x", 0n, await getBlockTimestamp()),
			).to.be.revertedWith("ClearingHouseFacet: partyB is not using cross mode")
		})

		describe("With Cross Mode Active", () => {
			beforeEach(async () => {
				// Quote1 -> opened
				await hedger.lockQuote(1)
				await hedger.openPosition(1)

				// Quote2 -> locked
				await hedger.lockQuote(2)

				// Quote4 -> opened
				await hedger.lockQuote(4)
				await hedger.openPosition(4)

				// Quote5 -> locked
				await hedger.lockQuote(5)

				await migratePartyBToCross(context, hedger, [1, 2, 4, 5])
			})

			it("Should fail on partyB being solvent", async function () {
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidateCrossPartyB(await context.signers.hedger.getAddress(), "0x", decimal(1000n), await getBlockTimestamp()),
				).to.be.revertedWith("ClearingHouseFacet: partyB is solvent")
			})

			it("Should cross liquidate partyB successfully", async function () {
				const validator = new LiquidateCrossPartyBValidator()
				const upnl = BigInt("-999999999999999999999999999999")
				const timestamp = await getBlockTimestamp()
				const beforeOut = await validator.before(context, { hedger })
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidateCrossPartyB(context.signers.hedger.getAddress(), "0x", upnl, timestamp),
				)
					.to.emit(context.clearingHouseFacet, "LiquidateCrossPartyB")
					.withArgs(context.signers.liquidator.address, context.signers.hedger.address, "0x", upnl, timestamp)

				await validator.after(context, { hedger, upnl, beforeOutput: beforeOut })

				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger)).to.equal(true)
				const details = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)

				expect(details.liquidationId).to.equal("0x")
				expect(details.upnl).to.equal(upnl)
				expect(details.deallocatedPool).to.equal(0)
				expect(details.inProgress).to.equal(true)
				expect(Number(details.timestamp)).to.be.greaterThan(0)
			})

			it("Should fail to cross liquidate a partyB twice", async function () {
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.getAddress(), "0x", BigInt("-999999999999999999999999999999"), await getBlockTimestamp())

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidateCrossPartyB(context.signers.hedger.getAddress(), "0x", BigInt("-999999999999999999999999999999"), await getBlockTimestamp()),
				).to.revertedWith("PartyBState: PartyB is in cross liquidation")
			})
		})
	})

	describe("closeAffiliatePositions", async function () {
		const scheduleAffiliateShutdown = async (affiliate: string): Promise<bigint> => {
			const shutdownAt = (await getBlockTimestamp()) + 10n
			await context.controlFacet.connect(context.signers.admin).scheduleAffiliateShutdown(affiliate, shutdownAt)
			return shutdownAt
		}

		it("Should allow Clearing House to close positions after the affiliate shutdown date", async function () {
			await hedger.lockQuote(1)
			await hedger.openPosition(1)

			const affiliate = await context.accountManager.getAddress()
			const shutdownAt = await scheduleAffiliateShutdown(affiliate)
			await time.setNextBlockTimestamp(shutdownAt)

			const quoteBefore = await context.viewFacetQuote.getQuote(1)
			const closePrice = quoteBefore.openedPrice

			await expect(context.clearingHouseFacet.connect(context.signers.liquidator).closeAffiliatePositions(affiliate, [1], [closePrice]))
				.to.emit(context.clearingHouseFacet, "CloseAffiliatePositions")
				.withArgs(affiliate, [1], [quoteBefore.quantity - quoteBefore.closedAmount], [closePrice])

			const quoteAfter = await context.viewFacetQuote.getQuote(1)
			expect(quoteAfter.quoteStatus).to.equal(QuoteStatus.CLOSED)
			expect(quoteAfter.closedAmount).to.equal(quoteAfter.quantity)
		})

		it("Should reject affiliate position close before the shutdown date", async function () {
			await hedger.lockQuote(1)
			await hedger.openPosition(1)

			const affiliate = await context.accountManager.getAddress()
			await scheduleAffiliateShutdown(affiliate)

			const quoteBefore = await context.viewFacetQuote.getQuote(1)
			await expect(
				context.clearingHouseFacet.connect(context.signers.liquidator).closeAffiliatePositions(affiliate, [1], [quoteBefore.openedPrice]),
			).to.be.revertedWith("ClearingHouseFacet: Affiliate shutdown date not reached")
		})

		it("Should reject affiliate position close when shutdown is not scheduled", async function () {
			await hedger.lockQuote(1)
			await hedger.openPosition(1)

			const affiliate = await context.accountManager.getAddress()
			const quoteBefore = await context.viewFacetQuote.getQuote(1)

			await expect(
				context.clearingHouseFacet.connect(context.signers.liquidator).closeAffiliatePositions(affiliate, [1], [quoteBefore.openedPrice]),
			).to.be.revertedWith("ClearingHouseFacet: Affiliate shutdown not scheduled")
		})

		it("Should reject affiliate position close when the symbol is frozen for adjustment", async function () {
			await hedger.lockQuote(1)
			await hedger.openPosition(1)

			const affiliate = await context.accountManager.getAddress()
			const quoteBefore = await context.viewFacetQuote.getQuote(1)

			const shutdownAt = await scheduleAffiliateShutdown(affiliate)
			const now = await getBlockTimestamp()
			await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(quoteBefore.symbolId, decimal(4n), now - 1n)
			await time.setNextBlockTimestamp(shutdownAt)

			await expect(
				context.clearingHouseFacet.connect(context.signers.liquidator).closeAffiliatePositions(affiliate, [1], [quoteBefore.openedPrice]),
			).to.be.revertedWith("LibSymbolAdjustment: Symbol is frozen")
		})

		it("Should reject affiliate position close when partyB is in cross liquidation", async function () {
			await hedger.lockQuote(1)
			await hedger.openPosition(1)

			const affiliate = await context.accountManager.getAddress()
			const shutdownAt = await scheduleAffiliateShutdown(affiliate)
			await time.setNextBlockTimestamp(shutdownAt)
			await migratePartyBToCross(context, hedger, [1])
			await context.clearingHouseFacet
				.connect(context.signers.liquidator)
				.liquidateCrossPartyB(context.signers.hedger.getAddress(), "0x", BigInt("-999999999999999999999999999999"), await getBlockTimestamp())

			const quoteBefore = await context.viewFacetQuote.getQuote(1)
			await expect(
				context.clearingHouseFacet.connect(context.signers.liquidator).closeAffiliatePositions(affiliate, [1], [quoteBefore.openedPrice]),
			).to.be.revertedWith("PartyBState: PartyB is in liquidation")
		})
	})

	describe("Cross liquidation (pending-only)", () => {
		beforeEach(async () => {
			// Create a pending quote for hedger without opening any positions
			await hedger.lockQuote(1)

			await migratePartyBToCross(context, hedger, [1])
			await context.clearingHouseFacet
				.connect(context.signers.liquidator)
				.liquidateCrossPartyB(context.signers.hedger.getAddress(), "0x", BigInt("-999999999999999999999999999999"), await getBlockTimestamp())
		})

		it("should clear cross liquidation after pending cleanup when there are no open positions", async () => {
			// no open positions exist for partyB
			expect((await context.viewFacetQuote.getPartyBOpenPositions(context.signers.hedger, context.signers.user, 0, 10)).length).to.equal(0)
			expect((await context.viewFacetQuote.getPartyBOpenPositions(context.signers.hedger, context.signers.user2, 0, 10)).length).to.equal(0)
			expect(await context.viewFacetQuote.partyBPositionsCount(context.signers.hedger, ZeroAddress)).to.equal(0)
			expect((await context.viewFacetQuote.getPartyBPendingQuotes(context.signers.hedger, context.signers.user)).length).to.be.greaterThan(0)
			expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger)).to.equal(true)

			// on cross liquidation is actived, partyB operations should not allowed
			await expect(hedger.lockQuote(2, decimal(1_000_000n))).to.be.revertedWith("PartyBState: PartyB is in liquidation")

			// Liquidate pending quotes
			await context.clearingHouseFacet
				.connect(context.signers.liquidator)
				.liquidatePendingPositionsForClearingHouse(context.signers.hedger, [context.signers.user])

			// cross liquidation is only cleared via settlement
			expect((await context.viewFacetQuote.getPartyBPendingQuotes(context.signers.hedger, context.signers.user)).length).to.equal(0)
			expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger)).to.equal(true)

			await expect(context.clearingHouseFacet.connect(context.signers.liquidator).settleCrossPartyBLiquidation(context.signers.hedger, [], true))
				.to.emit(context.clearingHouseFacet, "SettleCrossPartyBLiquidation")
				.withArgs(context.signers.hedger.address)
			expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger)).to.equal(false)
			const detailsAfterSettle = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)
			expect(detailsAfterSettle.inProgress).to.equal(false)
			expect(detailsAfterSettle.timestamp).to.equal(0)

			// PartyB should be able to resume normal operations
			await hedger.lockQuote(2, decimal(1_000_000n))

			// Once cleared a pending cleanup should be rejected
			await expect(
				context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.hedger, [context.signers.user]),
			).to.be.revertedWith("ClearingHouseFacet: No active liquidation")
		})
	})

	describe("deallocateForClearingHouse (Cross PartyB)", () => {
		beforeEach(async () => {
			// Quote1 -> opened
			await hedger.lockQuote(1)
			await hedger.openPosition(1)

			// Quote2 -> locked
			await hedger.lockQuote(2)

			// Quote4 -> opened
			await hedger.lockQuote(4)
			await hedger.openPosition(4)

			// Quote5 -> locked
			await hedger.lockQuote(5)

			await migratePartyBToCross(context, hedger, [1, 2, 4, 5])
		})

		it("should fail when partyB not marked as cross liquidated", async () => {
			await expect(applyClearingHousePnlDebits(context.signers.hedger, [context.signers.hedger], [ZeroAddress], [100n])).to.revertedWith(
				"ClearingHouseFacet: No active liquidation",
			)
		})

		describe("After PartyB Liquidation", () => {
			beforeEach(async () => {
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.getAddress(), "0x", BigInt("-999999999999999999999999999999"), await getBlockTimestamp())
			})

			it("should fail when deallocated amount be more than partyB allocation", async () => {
				const allocated = (await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger))[0]
				await expect(
					applyClearingHousePnlDebits(context.signers.hedger, [context.signers.hedger], [ZeroAddress], [allocated + BigInt(10)]),
				).to.revertedWith("ClearingHouseFacet: Insufficient allocated balance")
			})

			it("should disable the legacy unclassified transfer selectors", async () => {
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.deallocateForClearingHouse(context.signers.hedger, [context.signers.hedger], [ZeroAddress], [1n]),
				).to.be.revertedWith("ClearingHouseFacet: Use explicit settlement")
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.distributeForClearingHouse(context.signers.hedger, [context.signers.user], [ZeroAddress], [1n]),
				).to.be.revertedWith("ClearingHouseFacet: Use explicit settlement")
			})

			it("should expose signed funding and PnL per market while applying only their exact net", async () => {
				const explicitClearingHouse = new ethers.Contract(context.diamond, explicitClearingHouseSettlementAbi, context.signers.liquidator)
				const account = context.signers.hedger.address
				const allocationBefore = (await context.viewFacet.balanceInfoOfCrossPartyB(account))[0]
				const settlement = {
					account,
					allocationKey: ZeroAddress,
					symbolId: 1n,
					realizedPnl: -100n,
					funding: 40n,
					platformFee: 0n,
				}

				const tx = await explicitClearingHouse.applyClearingHouseSettlement(account, [settlement])
				const receipt = await tx.wait()
				const allocationAfter = (await context.viewFacet.balanceInfoOfCrossPartyB(account))[0]
				const details = await context.viewFacet.getCrossLiquidationDetails(account)

				expect(allocationAfter).to.equal(allocationBefore - 60n)
				expect(details.deallocatedPool).to.equal(60n)
				const events = parseClearingHouseSettlementLogs(receipt?.logs ?? [])
				expect(events.map(event => [event.name, [...event.args]])).to.deep.equal([
					["ClearingHouseSettlementComponent", [account, account, 1n, ZeroAddress, -100n, 40n, 0n]],
					["ClearingHouseAccountSettlement", [account, account, ZeroAddress, -60n]],
				])
				expect(
					parseAllocatedBalanceChangeLogs(receipt?.logs ?? []).filter(event => event.account.toLowerCase() === account.toLowerCase()),
				).to.deep.equal([
					{
						name: "BalanceChangePartyB",
						account,
						allocationKey: ZeroAddress,
						amount: 40n,
						changeType: BigInt(BalanceChangeType.FUNDING_FEE_IN),
					},
					{
						name: "BalanceChangePartyB",
						account,
						allocationKey: ZeroAddress,
						amount: 100n,
						changeType: BigInt(BalanceChangeType.REALIZED_PNL_OUT),
					},
				])
			})

			it("should classify the opposite PnL and funding directions for partyA", async () => {
				const subject = context.signers.hedger.address
				const account = context.signers.user.address
				const balanceBefore = await context.viewFacet.allocatedBalanceOfPartyA(account)
				const tx = await context.clearingHouseFacet.connect(context.signers.liquidator).applyClearingHouseSettlement(subject, [
					{
						account,
						allocationKey: ZeroAddress,
						symbolId: 1n,
						realizedPnl: 20n,
						funding: -50n,
						platformFee: 0n,
					},
				])
				const receipt = await tx.wait()

				expect(await context.viewFacet.allocatedBalanceOfPartyA(account)).to.equal(balanceBefore - 30n)
				expect(
					parseAllocatedBalanceChangeLogs(receipt?.logs ?? []).filter(event => event.account.toLowerCase() === account.toLowerCase()),
				).to.deep.equal([
					{
						name: "BalanceChangePartyA",
						account,
						allocationKey: ZeroAddress,
						amount: 20n,
						changeType: BigInt(BalanceChangeType.REALIZED_PNL_IN),
					},
					{
						name: "BalanceChangePartyA",
						account,
						allocationKey: ZeroAddress,
						amount: 50n,
						changeType: BigInt(BalanceChangeType.FUNDING_FEE_OUT),
					},
				])
			})

			it("should preserve platform-fee classification in both balance directions", async () => {
				const subject = context.signers.hedger.address
				const partyA = context.signers.user.address
				const platformFee = 12n
				const solverBalanceBefore = (await context.viewFacet.balanceInfoOfCrossPartyB(subject))[0]
				const partyABalanceBefore = await context.viewFacet.allocatedBalanceOfPartyA(partyA)
				const poolBefore = (await context.viewFacet.getCrossLiquidationDetails(subject)).deallocatedPool
				const settlements = sortClearingHouseSettlements([
					{
						account: partyA,
						allocationKey: ZeroAddress,
						symbolId: 1n,
						realizedPnl: 0n,
						funding: 0n,
						platformFee: -platformFee,
					},
					{
						account: subject,
						allocationKey: ZeroAddress,
						symbolId: 1n,
						realizedPnl: 0n,
						funding: 0n,
						platformFee,
					},
				])

				const tx = await context.clearingHouseFacet.connect(context.signers.liquidator).applyClearingHouseSettlement(subject, settlements)
				const receipt = await tx.wait()

				expect((await context.viewFacet.balanceInfoOfCrossPartyB(subject))[0]).to.equal(solverBalanceBefore + platformFee)
				expect(await context.viewFacet.allocatedBalanceOfPartyA(partyA)).to.equal(partyABalanceBefore - platformFee)
				expect((await context.viewFacet.getCrossLiquidationDetails(subject)).deallocatedPool).to.equal(poolBefore)

				const componentEvents = parseClearingHouseSettlementLogs(receipt?.logs ?? []).filter(
					event => event.name === "ClearingHouseSettlementComponent",
				)
				expect(componentEvents.map(event => [event.args.account, event.args.platformFee])).to.deep.equal(
					settlements.map(settlement => [settlement.account, settlement.platformFee]),
				)
				expect(
					parseAllocatedBalanceChangeLogs(receipt?.logs ?? []).filter(event => event.account.toLowerCase() === partyA.toLowerCase()),
				).to.deep.equal([
					{
						name: "BalanceChangePartyA",
						account: partyA,
						allocationKey: ZeroAddress,
						amount: platformFee,
						changeType: BigInt(BalanceChangeType.PLATFORM_FEE_OUT),
					},
				])
				expect(
					parseAllocatedBalanceChangeLogs(receipt?.logs ?? []).filter(event => event.account.toLowerCase() === subject.toLowerCase()),
				).to.deep.equal([
					{
						name: "BalanceChangePartyB",
						account: subject,
						allocationKey: ZeroAddress,
						amount: platformFee,
						changeType: BigInt(BalanceChangeType.PLATFORM_FEE_IN),
					},
				])
			})

			it("should preserve a solver's positive and negative funding per market after account netting", async () => {
				await context.symbolControlFacet
					.connect(context.signers.admin)
					.addSymbol("SECOND_MARKET", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)

				const subject = context.signers.hedger.address
				const partyA = context.signers.user.address
				const solverBalanceBefore = (await context.viewFacet.balanceInfoOfCrossPartyB(subject))[0]
				const partyABalanceBefore = await context.viewFacet.allocatedBalanceOfPartyA(partyA)
				const settlements = [
					{
						account: partyA,
						allocationKey: ZeroAddress,
						symbolId: 1n,
						realizedPnl: 20n,
						funding: -70n,
						platformFee: 0n,
					},
					{
						account: partyA,
						allocationKey: ZeroAddress,
						symbolId: 2n,
						realizedPnl: 0n,
						funding: 30n,
						platformFee: 0n,
					},
					{
						account: subject,
						allocationKey: ZeroAddress,
						symbolId: 1n,
						realizedPnl: -20n,
						funding: 70n,
						platformFee: 0n,
					},
					{
						account: subject,
						allocationKey: ZeroAddress,
						symbolId: 2n,
						realizedPnl: 0n,
						funding: -30n,
						platformFee: 0n,
					},
				]

				const tx = await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.applyClearingHouseSettlement(subject, sortClearingHouseSettlements(settlements))
				const receipt = await tx.wait()

				expect((await context.viewFacet.balanceInfoOfCrossPartyB(subject))[0]).to.equal(solverBalanceBefore + 20n)
				expect(await context.viewFacet.allocatedBalanceOfPartyA(partyA)).to.equal(partyABalanceBefore - 20n)
				expect((await context.viewFacet.getCrossLiquidationDetails(subject)).deallocatedPool).to.equal(0n)

				const componentEvents = parseClearingHouseSettlementLogs(receipt?.logs ?? []).filter(
					event => event.name === "ClearingHouseSettlementComponent" && event.args.account === subject,
				)
				expect(componentEvents.map(event => [event.args.symbolId, event.args.realizedPnl, event.args.funding])).to.deep.equal([
					[1n, -20n, 70n],
					[2n, 0n, -30n],
				])
				expect(componentEvents.reduce((sum, event) => sum + (event.args.funding as bigint), 0n)).to.equal(40n)
				expect(
					parseAllocatedBalanceChangeLogs(receipt?.logs ?? []).filter(event => event.account.toLowerCase() === subject.toLowerCase()),
				).to.deep.equal([
					{
						name: "BalanceChangePartyB",
						account: subject,
						allocationKey: ZeroAddress,
						amount: 40n,
						changeType: BigInt(BalanceChangeType.FUNDING_FEE_IN),
					},
					{
						name: "BalanceChangePartyB",
						account: subject,
						allocationKey: ZeroAddress,
						amount: 20n,
						changeType: BigInt(BalanceChangeType.REALIZED_PNL_OUT),
					},
				])
			})

			it("should atomically fund an earlier credit with a later debit", async () => {
				const subject = context.signers.hedger.address
				const accounts = [context.signers.user.address, context.signers.user2.address].sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : 1))
				const [receiver, payer] = accounts
				const amount = 40n
				const receiverBefore = await context.viewFacet.allocatedBalanceOfPartyA(receiver)
				const payerBefore = await context.viewFacet.allocatedBalanceOfPartyA(payer)
				const poolBefore = (await context.viewFacet.getCrossLiquidationDetails(subject)).deallocatedPool

				await context.clearingHouseFacet.connect(context.signers.liquidator).applyClearingHouseSettlement(subject, [
					{
						account: receiver,
						allocationKey: ZeroAddress,
						symbolId: 1n,
						realizedPnl: 0n,
						funding: amount,
						platformFee: 0n,
					},
					{
						account: payer,
						allocationKey: ZeroAddress,
						symbolId: 1n,
						realizedPnl: 0n,
						funding: -amount,
						platformFee: 0n,
					},
				])

				expect(await context.viewFacet.allocatedBalanceOfPartyA(receiver)).to.equal(receiverBefore + amount)
				expect(await context.viewFacet.allocatedBalanceOfPartyA(payer)).to.equal(payerBefore - amount)
				expect((await context.viewFacet.getCrossLiquidationDetails(subject)).deallocatedPool).to.equal(poolBefore)
			})

			it("should preserve funding and PnL attribution when their account net is zero", async () => {
				const subject = context.signers.hedger.address
				const allocationBefore = (await context.viewFacet.balanceInfoOfCrossPartyB(subject))[0]
				const poolBefore = (await context.viewFacet.getCrossLiquidationDetails(subject)).deallocatedPool

				const tx = await context.clearingHouseFacet.connect(context.signers.liquidator).applyClearingHouseSettlement(subject, [
					{
						account: subject,
						allocationKey: ZeroAddress,
						symbolId: 1n,
						realizedPnl: -40n,
						funding: 40n,
						platformFee: 0n,
					},
				])
				const receipt = await tx.wait()

				expect((await context.viewFacet.balanceInfoOfCrossPartyB(subject))[0]).to.equal(allocationBefore)
				expect((await context.viewFacet.getCrossLiquidationDetails(subject)).deallocatedPool).to.equal(poolBefore)
				const events = parseClearingHouseSettlementLogs(receipt?.logs ?? [])
				expect(events.map(event => [event.name, [...event.args]])).to.deep.equal([
					["ClearingHouseSettlementComponent", [subject, subject, 1n, ZeroAddress, -40n, 40n, 0n]],
					["ClearingHouseAccountSettlement", [subject, subject, ZeroAddress, 0n]],
				])
				expect(
					parseAllocatedBalanceChangeLogs(receipt?.logs ?? []).filter(event => event.account.toLowerCase() === subject.toLowerCase()),
				).to.deep.equal([
					{
						name: "BalanceChangePartyB",
						account: subject,
						allocationKey: ZeroAddress,
						amount: 40n,
						changeType: BigInt(BalanceChangeType.FUNDING_FEE_IN),
					},
					{
						name: "BalanceChangePartyB",
						account: subject,
						allocationKey: ZeroAddress,
						amount: 40n,
						changeType: BigInt(BalanceChangeType.REALIZED_PNL_OUT),
					},
				])
			})

			it("should reverse realized PnL with the same component and opposite sign", async () => {
				const subject = context.signers.hedger.address
				const amount = 25n
				const balanceBefore = (await context.viewFacet.balanceInfoOfCrossPartyB(subject))[0]
				const debitReceipt = await (await applyClearingHousePnlDebits(subject, [subject], [ZeroAddress], [amount])).wait()
				const creditReceipt = await (await applyClearingHousePnlCredits(subject, [subject], [ZeroAddress], [amount])).wait()

				expect(
					parseAllocatedBalanceChangeLogs(debitReceipt?.logs ?? []).filter(event => event.account.toLowerCase() === subject.toLowerCase()),
				).to.deep.equal([
					{
						name: "BalanceChangePartyB",
						account: subject,
						allocationKey: ZeroAddress,
						amount,
						changeType: BigInt(BalanceChangeType.REALIZED_PNL_OUT),
					},
				])
				expect(
					parseAllocatedBalanceChangeLogs(creditReceipt?.logs ?? []).filter(event => event.account.toLowerCase() === subject.toLowerCase()),
				).to.deep.equal([
					{
						name: "BalanceChangePartyB",
						account: subject,
						allocationKey: ZeroAddress,
						amount,
						changeType: BigInt(BalanceChangeType.REALIZED_PNL_IN),
					},
				])
				expect((await context.viewFacet.balanceInfoOfCrossPartyB(subject))[0]).to.equal(balanceBefore)
				expect((await context.viewFacet.getCrossLiquidationDetails(subject)).deallocatedPool).to.equal(0n)
				expect(
					[debitReceipt, creditReceipt].flatMap(receipt =>
						parseClearingHouseSettlementLogs(receipt?.logs ?? [])
							.filter(event => event.name === "ClearingHouseSettlementComponent")
							.map(event => [event.args.symbolId, event.args.realizedPnl]),
					),
				).to.deep.equal([
					[1n, -amount],
					[1n, amount],
				])
			})

			it("should reject missing, invalid, duplicate, or empty attribution", async () => {
				const subject = context.signers.hedger.address
				const base = {
					account: subject,
					allocationKey: ZeroAddress,
					symbolId: 1n,
					realizedPnl: 0n,
					funding: 1n,
					platformFee: 0n,
				}

				await expect(context.clearingHouseFacet.connect(context.signers.liquidator).applyClearingHouseSettlement(subject, [])).to.be.revertedWith(
					"ClearingHouseFacet: Empty settlement",
				)
				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).applyClearingHouseSettlement(subject, [{ ...base, account: ZeroAddress }]),
				).to.be.revertedWith("ClearingHouseFacet: Zero account")
				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).applyClearingHouseSettlement(subject, [{ ...base, symbolId: 0n }]),
				).to.be.revertedWith("ClearingHouseFacet: Missing market")
				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).applyClearingHouseSettlement(subject, [{ ...base, symbolId: 2n }]),
				).to.be.revertedWith("ClearingHouseFacet: Invalid symbol")
				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).applyClearingHouseSettlement(subject, [base, base]),
				).to.be.revertedWith("ClearingHouseFacet: Duplicate market")
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.applyClearingHouseSettlement(subject, [{ ...base, realizedPnl: 0n, funding: 0n, platformFee: 0n }]),
				).to.be.revertedWith("ClearingHouseFacet: Empty component")
			})

			it("should reject noncanonical settlement order", async () => {
				const subject = context.signers.hedger.address
				const settlement = {
					account: subject,
					allocationKey: ZeroAddress,
					symbolId: 1n,
					realizedPnl: 0n,
					funding: 1n,
					platformFee: 0n,
				}
				const unsorted = sortClearingHouseSettlements([settlement, { ...settlement, account: context.signers.user.address }]).reverse()

				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).applyClearingHouseSettlement(subject, unsorted),
				).to.be.revertedWith("ClearingHouseFacet: Unsorted settlement")
			})

			it("should deallocate from partyA allocated balance in cross liquidation", async () => {
				const partyAOldAllocated = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user)
				const amountToDeallocate = 100n
				expect(partyAOldAllocated).to.be.gte(amountToDeallocate)

				await expect(applyClearingHousePnlDebits(context.signers.hedger, [context.signers.user], [ZeroAddress], [amountToDeallocate]))
					.to.emit(context.clearingHouseFacet, "ClearingHouseAccountSettlement")
					.withArgs(context.signers.hedger.address, context.signers.user.address, ZeroAddress, -amountToDeallocate)

				const partyANewAllocated = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user)
				const details = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)
				expect(partyANewAllocated).to.equal(partyAOldAllocated - amountToDeallocate)
				expect(details.deallocatedPool).to.equal(amountToDeallocate)
			})

			it("should fail when deallocating from partyA with invalid allocation key in cross liquidation", async () => {
				await expect(
					applyClearingHousePnlDebits(context.signers.hedger, [context.signers.user], [context.signers.hedger], [100n]),
				).to.be.revertedWith("ClearingHouseFacet: Invalid allocation key for partyA")
			})

			it("should deallocate from partyB cross bucket and partyA allocated balance in one call", async () => {
				const partyBOldAllocated = (await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger))[0]
				const partyAOldAllocated = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user)

				const partyBAmount = partyBOldAllocated / 10n
				const partyAAmount = partyAOldAllocated / 10n
				expect(partyBAmount).to.be.gt(0)
				expect(partyAAmount).to.be.gt(0)

				await applyClearingHousePnlDebits(
					context.signers.hedger,
					[context.signers.hedger, context.signers.user],
					[ZeroAddress, ZeroAddress],
					[partyBAmount, partyAAmount],
				)

				const partyBNewAllocated = (await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger))[0]
				const partyANewAllocated = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user)
				const details = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)

				expect(partyBNewAllocated).to.equal(partyBOldAllocated - partyBAmount)
				expect(partyANewAllocated).to.equal(partyAOldAllocated - partyAAmount)
				expect(details.deallocatedPool).to.equal(partyBAmount + partyAAmount)
			})

			it("should deallocate amount successfully", async () => {
				const OldAllocated = (await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger))[0]
				const hedgerAddress = await hedger.getAddress()
				const validator = new DeallocateForCHValidator()
				const beforeOut = await validator.before(context, {
					subject: hedgerAddress,
					parties: [hedgerAddress],
					allocationKeys: [ZeroAddress],
					amounts: [OldAllocated],
				})

				await expect(applyClearingHousePnlDebits(context.signers.hedger, [context.signers.hedger], [ZeroAddress], [OldAllocated]))
					.to.emit(context.clearingHouseFacet, "ClearingHouseAccountSettlement")
					.withArgs(context.signers.hedger.address, context.signers.hedger.address, ZeroAddress, -OldAllocated)

				await validator.after(context, {
					subject: hedgerAddress,
					parties: [hedgerAddress],
					allocationKeys: [ZeroAddress],
					amounts: [OldAllocated],
					beforeOutput: beforeOut,
				})

				const newAllocated = (await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger))[0]
				const d = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)
				expect(newAllocated).to.equal(0)
				expect(d.deallocatedPool).to.equal(OldAllocated)
			})

			it("should deallocate a combined realized PnL debit", async () => {
				const OldAllocatedCross = (await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger))[0]

				const deallocateAmount1 = OldAllocatedCross / 4n
				const deallocateAmount2 = OldAllocatedCross / 4n

				const combinedAmount = deallocateAmount1 + deallocateAmount2
				await expect(applyClearingHousePnlDebits(context.signers.hedger, [context.signers.hedger], [ZeroAddress], [combinedAmount]))
					.to.emit(context.clearingHouseFacet, "ClearingHouseAccountSettlement")
					.withArgs(context.signers.hedger.address, context.signers.hedger.address, ZeroAddress, -combinedAmount)

				const newAllocatedCross = (await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger))[0]
				const d = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)

				expect(newAllocatedCross).to.equal(OldAllocatedCross - deallocateAmount1 - deallocateAmount2)
				expect(d.deallocatedPool).to.equal(deallocateAmount1 + deallocateAmount2)
			})
		})

		describe("distributeForClearingHouse (Cross PartyB)", () => {
			beforeEach(async () => {
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.getAddress(), "0x", BigInt("-999999999999999999999999999999"), await getBlockTimestamp())

				await applyClearingHousePnlDebits(context.signers.hedger, [context.signers.hedger], [ZeroAddress], [1000n])
			})

			it("should fail when amount be more than deallocated for liquidation", async () => {
				const receiverBalanceBefore = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user)
				const poolBefore = (await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)).deallocatedPool

				await expect(applyClearingHousePnlCredits(context.signers.hedger, [context.signers.user], [ZeroAddress], [1001n])).to.be.revertedWith(
					"ClearingHouseFacet: Insufficient pool balance",
				)
				expect(await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user)).to.equal(receiverBalanceBefore)
				expect((await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)).deallocatedPool).to.equal(poolBefore)
			})

			it("should distribute to receiver successfully", async () => {
				const oldAllocation = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user)
				const hedgerAddress = await hedger.getAddress()
				const userAddress = await user.getAddress()
				const transferAmount = 1000n

				const validator = new DistributeForCHValidator()
				const beforeOut = await validator.before(context, {
					subject: hedgerAddress,
					receivers: [userAddress],
					allocationKeys: [ZeroAddress],
					amounts: [transferAmount],
				})

				await expect(applyClearingHousePnlCredits(context.signers.hedger, [context.signers.user], [ZeroAddress], [transferAmount]))
					.to.emit(context.clearingHouseFacet, "ClearingHouseAccountSettlement")
					.withArgs(context.signers.hedger.address, context.signers.user.address, ZeroAddress, transferAmount)

				await validator.after(context, {
					subject: hedgerAddress,
					receivers: [userAddress],
					allocationKeys: [ZeroAddress],
					amounts: [transferAmount],
					beforeOutput: beforeOut,
				})

				const details = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)
				const newAllocation = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user)

				expect(details.deallocatedPool).to.equal(0)
				expect(newAllocation).to.equal(oldAllocation + transferAmount)
			})

			it("should handle partial distributions correctly", async () => {
				const partialAmount = 500n
				const detailsBefore = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)
				const receiverBalanceBefore = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user)

				await applyClearingHousePnlCredits(context.signers.hedger, [context.signers.user], [ZeroAddress], [partialAmount])

				const detailsAfter = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)
				expect(detailsAfter.deallocatedPool).to.equal(detailsBefore.deallocatedPool - partialAmount)

				const receiverBalanceAfter = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user)
				expect(receiverBalanceAfter).to.equal(receiverBalanceBefore + partialAmount)
			})

			it("should fail when partyB is not liquidated", async () => {
				await expect(applyClearingHousePnlCredits(context.signers.hedger2, [context.signers.user], [ZeroAddress], [1n])).to.be.revertedWith(
					"ClearingHouseFacet: No active liquidation",
				)
			})
		})

		describe("liquidatePendingPositionsForClearingHouse (Cross PartyB)", () => {
			beforeEach(async () => {
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.getAddress(), "0x", BigInt("-999999999999999999999999999999"), await getBlockTimestamp())
			})

			it("should keep cross liquidation active when positions remain after pending cleanup", async () => {
				expect(await context.viewFacetQuote.partyBPositionsCount(context.signers.hedger, ZeroAddress)).to.be.greaterThan(0)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.hedger, [context.signers.user])

				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger)).to.equal(true)
			})

			it("should liquidate pending quotes successfully", async () => {
				const hedgerAddress = await hedger.getAddress()
				const userAddress = await user.getAddress()
				const oldUserPendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(context.signers.user)
				const pendingBefore = (await user.getBalanceInfo()).totalPendingLockedPartyA
				const targetedQuotes: QuoteStructOutput[] = []

				for await (const qId of oldUserPendingQuotes) {
					const q = await context.viewFacetQuote.getQuote(qId)
					if (
						q.partyB == context.signers.hedger.address &&
						(q.quoteStatus == BigInt(QuoteStatus.LOCKED) || q.quoteStatus == BigInt(QuoteStatus.CANCEL_PENDING))
					) {
						targetedQuotes.push(q)
					}
				}

				const validator = new LiquidatePendingCHValidator()
				const beforeOut = await validator.before(context, {
					subject: hedgerAddress,
					counterparties: [userAddress],
					isCrossPartyB: true,
				})

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidatePendingPositionsForClearingHouse(context.signers.hedger, [context.signers.user]),
				)
					.to.emit(context.clearingHouseFacet, "LiquidatePendingPositionsForClearingHouse")
					.withArgs(context.signers.hedger.address, [context.signers.user.address], [])

				await validator.after(context, {
					subject: hedgerAddress,
					counterparties: [userAddress],
					isCrossPartyB: true,
					beforeOutput: beforeOut,
				})

				const newUserPendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(context.signers.user)

				for await (const q of targetedQuotes) {
					const qq = await context.viewFacetQuote.getQuote(q.id)
					expect(qq.quoteStatus).to.equal(QuoteStatus.LIQUIDATED_PENDING)
					expect(newUserPendingQuotes.indexOf(qq.id)).to.equal(-1)
				}

				let expectedDelta = 0n
				for (const q of targetedQuotes) {
					expectedDelta += q.lockedValues.cva + q.lockedValues.lf + q.lockedValues.partyAmm
				}
				const pendingAfter = (await user.getBalanceInfo()).totalPendingLockedPartyA
				expect(pendingAfter).to.equal(pendingBefore - expectedDelta)
			})

			it("should liquidate pending quotes for multiple partyAs in batch", async () => {
				const oldUserPendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(context.signers.user)
				const oldUser2PendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(context.signers.user2)

				// Count how many pending quotes belong to hedger for each partyA
				let hedgerPendingForUser = 0
				for (const qId of oldUserPendingQuotes) {
					const q = await context.viewFacetQuote.getQuote(qId)
					if (
						q.partyB == context.signers.hedger.address &&
						(q.quoteStatus == BigInt(QuoteStatus.LOCKED) || q.quoteStatus == BigInt(QuoteStatus.CANCEL_PENDING))
					) {
						hedgerPendingForUser++
					}
				}
				let hedgerPendingForUser2 = 0
				for (const qId of oldUser2PendingQuotes) {
					const q = await context.viewFacetQuote.getQuote(qId)
					if (
						q.partyB == context.signers.hedger.address &&
						(q.quoteStatus == BigInt(QuoteStatus.LOCKED) || q.quoteStatus == BigInt(QuoteStatus.CANCEL_PENDING))
					) {
						hedgerPendingForUser2++
					}
				}

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.hedger, [context.signers.user, context.signers.user2])

				const newUserPendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(context.signers.user)
				const newUser2PendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(context.signers.user2)

				// Exact count: old pending minus hedger's pending quotes should equal new pending
				expect(newUserPendingQuotes.length).to.equal(oldUserPendingQuotes.length - hedgerPendingForUser)
				expect(newUser2PendingQuotes.length).to.equal(oldUser2PendingQuotes.length - hedgerPendingForUser2)

				// Verify none of the remaining pending quotes belong to hedger
				for (const qId of newUserPendingQuotes) {
					const q = await context.viewFacetQuote.getQuote(qId)
					expect(q.partyB).to.not.equal(context.signers.hedger.address)
				}
				for (const qId of newUser2PendingQuotes) {
					const q = await context.viewFacetQuote.getQuote(qId)
					expect(q.partyB).to.not.equal(context.signers.hedger.address)
				}
			})

			it("should fail when partyB is not liquidated", async () => {
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidatePendingPositionsForClearingHouse(context.signers.hedger2, [context.signers.user]),
				).to.be.revertedWith("ClearingHouseFacet: No active liquidation")
			})
		})

		describe("liquidatePositionsForClearingHouse (Cross PartyB)", () => {
			beforeEach(async () => {
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.getAddress(), "0x", BigInt("-999999999999999999999999999999"), await getBlockTimestamp())
			})

			it("should liquidate cross positions successfully", async () => {
				const hedgerAddress = await hedger.getAddress()
				const validator = new LiquidatePositionsCHValidator()
				const beforeOut = await validator.before(context, {
					subject: hedgerAddress,
					quoteIds: [1n],
				})

				const liquidationTx = context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.hedger, [1n], [decimal(1n)])
				await expect(liquidationTx).to.emit(context.clearingHouseFacet, "LiquidatePositionsForClearingHouse")
				await expect(liquidationTx).to.not.emit(context.partyBExecutionFacet, "SolverFeeCharged")

				await validator.after(context, {
					subject: hedgerAddress,
					quoteIds: [1n],
					prices: [decimal(1n)],
					beforeOutput: beforeOut,
				})

				const quote1: QuoteStructOutput = await context.viewFacetQuote.getQuote(1)

				expect(quote1.quoteStatus).to.equal(QuoteStatus.LIQUIDATED)
				expect(quote1.closedAmount).to.equal(quote1.quantity)
				expect((await context.viewFacetQuote.getSolverFeeState(1n)).closeFeeCharged).to.equal(0n)
			})

			it("should sync accumulated funding before cross liquidation close", async () => {
				const epochDuration = 3600
				await context.pauseControlFacet.connect(context.signers.admin).activateAccumulatedFunding()
				await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [epochDuration])
				await context.fundingRateFacet
					.connect(context.signers.hedger)
					.updateAccumulatedFundingFee([1], [decimal(1n, 16)], [-decimal(1n, 16)], [decimal(1n)])
				await time.increase(epochDuration * 2)

				const quoteBefore = await context.viewFacetQuote.getQuote(1)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.hedger, [1n], [decimal(1n)])

				const quoteAfter = await context.viewFacetQuote.getQuote(1)
				expect(quoteAfter.accumulatedPaidFunding).to.not.equal(quoteBefore.accumulatedPaidFunding)
				expect(quoteAfter.lastFundingPaymentTimestamp).to.be.gt(quoteBefore.lastFundingPaymentTimestamp)
			})

			it("should not revert cross liquidation when accrued funding exceeds balances", async () => {
				await context.pauseControlFacet.connect(context.signers.admin).activateAccumulatedFunding()
				await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [1])
				await context.fundingRateFacet.connect(context.signers.hedger).updateAccumulatedFundingFee([1], [decimal(1n)], [-decimal(1n)], [decimal(1n)])
				await time.increase(5000)

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidatePositionsForClearingHouse(context.signers.hedger, [1n], [decimal(1n)]),
				).to.not.be.reverted
			})

			it("should fail when partyB is not liquidated", async () => {
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidatePositionsForClearingHouse(context.signers.hedger2, [1n], [decimal(1n)]),
				).to.be.revertedWith("ClearingHouseFacet: No active liquidation")
			})

			it("should fail when the symbol is frozen for adjustment", async () => {
				const quote = await context.viewFacetQuote.getQuote(1)
				const now = await getBlockTimestamp()
				await context.symbolAdjustmentFacet.connect(context.signers.admin).scheduleAdjustment(quote.symbolId, decimal(4n), now - 1n)
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidatePositionsForClearingHouse(context.signers.hedger, [1n], [decimal(1n)]),
				).to.be.revertedWith("LibSymbolAdjustment: Symbol is frozen")
			})

			it("should update position statuses correctly", async () => {
				const quote1Before: QuoteStructOutput = await context.viewFacetQuote.getQuote(1)
				const quote4Before: QuoteStructOutput = await context.viewFacetQuote.getQuote(4)

				expect(quote1Before.quoteStatus).to.equal(QuoteStatus.OPENED)
				expect(quote4Before.quoteStatus).to.equal(QuoteStatus.OPENED)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.hedger, [1n, 4n], [decimal(1n), decimal(1n)])

				const quote1After: QuoteStructOutput = await context.viewFacetQuote.getQuote(1)
				const quote4After: QuoteStructOutput = await context.viewFacetQuote.getQuote(4)

				expect(quote1After.quoteStatus).to.equal(QuoteStatus.LIQUIDATED)
				expect(quote4After.quoteStatus).to.equal(QuoteStatus.LIQUIDATED)
			})

			it("should increment partyA nonce for each cross-liquidated position", async () => {
				const partyA = context.signers.user.address
				const partyB = context.signers.hedger.address
				const partyANonceBefore = await context.viewFacet.nonceOfPartyA(partyA)
				const partyBNonceBefore = await context.viewFacet.nonceOfPartyB(partyB, partyA)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.hedger, [1n, 4n], [decimal(1n), decimal(1n)])

				const partyANonceAfter = await context.viewFacet.nonceOfPartyA(partyA)
				const partyBNonceAfter = await context.viewFacet.nonceOfPartyB(partyB, partyA)
				expect(partyANonceAfter).to.equal(partyANonceBefore + 2n)
				expect(partyBNonceAfter).to.equal(partyBNonceBefore + 2n)
			})

			it("should keep cross liquidation active while pending quotes remain", async () => {
				expect((await context.viewFacetQuote.getPartyBPendingQuotes(context.signers.hedger, context.signers.user)).length).to.be.greaterThan(0)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.hedger, [1n, 4n], [decimal(1n), decimal(1n)])

				expect(await context.viewFacetQuote.partyBPositionsCount(context.signers.hedger, ZeroAddress)).to.equal(0)
				expect((await context.viewFacetQuote.getPartyBPendingQuotes(context.signers.hedger, context.signers.user)).length).to.be.greaterThan(0)
				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger)).to.equal(true)
			})

			it("should clear cross liquidation only after positions and pending are cleared", async () => {
				const balancesBefore = await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger)
				const pendingBefore = balancesBefore[5] + balancesBefore[6] + balancesBefore[7] + balancesBefore[8]
				expect(pendingBefore).to.be.greaterThan(0)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.hedger, [1n, 4n], [decimal(1n), decimal(1n)])
				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger)).to.equal(true)
				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).settleCrossPartyBLiquidation(context.signers.hedger, [], true),
				).to.be.revertedWith("ClearingHouseFacet: PartyB has pending quotes")

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.hedger, [context.signers.user])

				const balancesAfter = await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger)
				const pendingAfter = balancesAfter[5] + balancesAfter[6] + balancesAfter[7] + balancesAfter[8]
				expect(pendingAfter).to.equal(0)
				await expect(context.clearingHouseFacet.connect(context.signers.liquidator).settleCrossPartyBLiquidation(context.signers.hedger, [], true))
					.to.emit(context.clearingHouseFacet, "SettleCrossPartyBLiquidation")
					.withArgs(context.signers.hedger.address)
				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger)).to.equal(false)
			})

			it("should fail to settle when open positions remain", async () => {
				// Liquidate pending but not positions
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.hedger, [context.signers.user])

				// Verify positions still exist
				expect(await context.viewFacetQuote.partyBPositionsCount(context.signers.hedger, ZeroAddress)).to.be.greaterThan(0)

				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).settleCrossPartyBLiquidation(context.signers.hedger, [], true),
				).to.be.revertedWith("ClearingHouseFacet: PartyB has still open positions")
			})

			it("should fail to settle when deallocated pool has undistributed funds", async () => {
				// Deallocate some funds
				const crossAllocated = (await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger))[0]
				expect(crossAllocated).to.be.greaterThan(0)
				await applyClearingHousePnlDebits(context.signers.hedger, [context.signers.hedger], [ZeroAddress], [crossAllocated])

				// Liquidate all positions and pending
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.hedger, [1n, 4n], [decimal(1n), decimal(1n)])
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.hedger, [context.signers.user])

				// Verify pool has undistributed funds
				const details = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)
				expect(details.deallocatedPool).to.be.greaterThan(0)

				// Settlement should fail
				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).settleCrossPartyBLiquidation(context.signers.hedger, [], true),
				).to.be.revertedWith("ClearingHouseFacet: Undistributed funds in deallocated pool")
			})

			it("should clear the Party A to B connection after the final position is cross-liquidated", async () => {
				expect(await context.viewFacetSymbol.isConnectedPartyB(user.address, hedger.address)).to.equal(true)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.hedger, [1n], [decimal(1n)])

				expect(await context.viewFacetSymbol.isConnectedPartyB(user.address, hedger.address)).to.equal(true)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.hedger, [4n], [decimal(1n)])

				// Clear pending quotes (B,A) so connection can be removed (MED-21: requires no open + no pending)
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.hedger, [context.signers.user])

				expect(await context.viewFacetSymbol.isConnectedPartyB(user.address, hedger.address)).to.equal(false)
			})
		})

		describe("Shared cross bucket state", () => {
			let quoteUser1: QuoteStructOutput, quoteUser2: QuoteStructOutput

			beforeEach(async () => {
				// second partyA
				await user2.setBalances(decimal(2000n), decimal(1000n), decimal(500n))

				quoteUser1 = await context.viewFacetQuote.getQuote(await user.sendQuote(limitQuoteRequestBuilder().quantity(decimal(80n)).build()))
				quoteUser2 = await context.viewFacetQuote.getQuote(await user2.sendQuote(limitQuoteRequestBuilder().quantity(decimal(120n)).build()))

				await hedger2.lockQuote(quoteUser1.id)
				await hedger2.openPosition(quoteUser1.id, limitOpenRequestBuilder().filledAmount(quoteUser1.quantity).build())

				await hedger2.lockQuote(quoteUser2.id)
				await hedger2.openPosition(quoteUser2.id, limitOpenRequestBuilder().filledAmount(quoteUser2.quantity).build())

				await migratePartyBToCross(context, hedger2, [quoteUser1.id, quoteUser2.id])

				await context.controlFacet
					.connect(context.signers.admin)
					.grantRole(context.signers.liquidator.address, ethers.keccak256(toUtf8Bytes("CLEARING_HOUSE_ROLE")))
			})

			it("clears shared locked/pending bucket and bumps shared nonce after full liquidation", async () => {
				const crossBucketBefore = await hedger2.getBalanceInfoCrossPartyB()

				expect(crossBucketBefore.lockedCva).to.be.greaterThan(0)
				expect(crossBucketBefore.lockedLf).to.be.greaterThan(0)
				expect(crossBucketBefore.lockedMmPartyB).to.be.greaterThan(0)

				const nonceBefore = await context.viewFacet.nonceOfPartyB(await hedger2.getAddress(), ZeroAddress)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(await hedger2.getAddress(), "0x", -decimal(1_000_000n), await getBlockTimestamp())

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(hedger2.address, [quoteUser1.id, quoteUser2.id], [quoteUser1.openedPrice, quoteUser2.openedPrice])

				// Use validator to verify settle cross partyB
				const settleValidator = new SettleCrossPartyBValidator()
				const settleBeforeOut = await settleValidator.before(context, { hedger: hedger2 })

				// Explicitly settle the cross partyB liquidation
				await context.clearingHouseFacet.connect(context.signers.liquidator).settleCrossPartyBLiquidation(hedger2.address, [], true)

				await settleValidator.after(context, { hedger: hedger2, beforeOutput: settleBeforeOut })

				const crossBucketAfter = await hedger2.getBalanceInfoCrossPartyB()

				expect(crossBucketAfter.lockedCva).to.equal(0)
				expect(crossBucketAfter.lockedLf).to.equal(0)
				expect(crossBucketAfter.lockedMmPartyB).to.equal(0)

				const nonceAfter = await context.viewFacet.nonceOfPartyB(await hedger2.getAddress(), ZeroAddress)
				expect(nonceAfter).to.be.greaterThan(nonceBefore)
			})

			it("increments partyA nonce for each partyA in cross liquidation", async () => {
				const partyA1 = await user.getAddress()
				const partyA2 = await user2.getAddress()
				const partyB = await hedger2.getAddress()

				const partyANonceBefore1 = await context.viewFacet.nonceOfPartyA(partyA1)
				const partyANonceBefore2 = await context.viewFacet.nonceOfPartyA(partyA2)
				const partyBNonceBefore1 = await context.viewFacet.nonceOfPartyB(partyB, partyA1)
				const partyBNonceBefore2 = await context.viewFacet.nonceOfPartyB(partyB, partyA2)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(partyB, "0x", -decimal(1_000_000n), await getBlockTimestamp())
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(partyB, [quoteUser1.id, quoteUser2.id], [quoteUser1.openedPrice, quoteUser2.openedPrice])

				const partyANonceAfter1 = await context.viewFacet.nonceOfPartyA(partyA1)
				const partyANonceAfter2 = await context.viewFacet.nonceOfPartyA(partyA2)
				const partyBNonceAfter1 = await context.viewFacet.nonceOfPartyB(partyB, partyA1)
				const partyBNonceAfter2 = await context.viewFacet.nonceOfPartyB(partyB, partyA2)

				expect(partyANonceAfter1).to.equal(partyANonceBefore1 + 1n)
				expect(partyANonceAfter2).to.equal(partyANonceBefore2 + 1n)
				expect(partyBNonceAfter1).to.equal(partyBNonceBefore1 + 1n)
				expect(partyBNonceAfter2).to.equal(partyBNonceBefore2 + 1n)
			})
		})
	})

	// ============================================
	// PARTYA TAKEOVER TESTS (NEW)
	// ============================================

	describe("PartyA Takeover Flow", () => {
		beforeEach(async () => {
			// Quote1 -> opened (SHORT - already SHORT from parent beforeEach)
			await hedger.lockQuote(1)
			await hedger.openPosition(1)

			// Quote2 -> locked (pending)
			await hedger.lockQuote(2)

			// Quote3 -> sent (pending)
			// (already sent in parent beforeEach)

			// Quote4 -> opened (this is LONG by default, but we need it to not offset Quote1)
			// Skip quote 4 to avoid UPNL offset between SHORT and LONG positions
			// await hedger.lockQuote(4)
			// await hedger.openPosition(4)

			// Quote5 -> locked (pending)
			await hedger.lockQuote(5)

			// Allocate more for partyB to isolated buckets
			await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(decimal(500n), user.address)
		})

		it("should keep the reserved-fee basis for pending market quotes during takeover", async () => {
			const marketQuoteId = BigInt(
				await user.sendQuote(
					marketQuoteRequestBuilder()
						.upnlSig(getDummySingleUpnlAndPriceSig(decimal(9n, 17)))
						.build(),
				),
			)
			const pendingQuoteIds = await context.viewFacetQuote.getPartyAPendingQuotes(context.signers.user.address)
			expect(pendingQuoteIds).to.include(marketQuoteId)
			const expectedReservedFees = await getTradingFeeForQuotes(context, pendingQuoteIds)

			await user.liquidateAndSetSymbolPrices([1n], [decimal(25n)], [1n])
			await context.clearingHouseFacet.connect(context.signers.liquidator).takeoverPartyALiquidation(context.signers.user.address)

			const reimbursementBefore = await context.viewFacet.partyAReimbursement(context.signers.user.address)
			await context.clearingHouseFacet.connect(context.signers.liquidator).liquidatePendingPositionsForClearingHouse(context.signers.user.address, [])

			const reimbursementAfter = await context.viewFacet.partyAReimbursement(context.signers.user.address)
			expect(reimbursementAfter - reimbursementBefore).to.equal(expectedReservedFees)
			expect((await context.viewFacetQuote.getQuote(marketQuoteId)).quoteStatus).to.equal(QuoteStatus.LIQUIDATED_PENDING)
		})

		describe("takeoverPartyALiquidation", () => {
			it("should fail if partyA is not being liquidated", async () => {
				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).takeoverPartyALiquidation(context.signers.user.address),
				).to.be.revertedWith("ClearingHouseFacet: PartyA is not being liquidated")
			})

			it("should fail if caller doesn't have CLEARING_HOUSE_ROLE", async () => {
				// First liquidate partyA normally - use high price to cause insolvency on SHORT
				const symbolIds = [1n]
				const prices = [decimal(25n)] // Price 25 causes UPNL = (1-25)*100 = -2400 loss on SHORT
				await user.liquidateAndSetSymbolPrices(symbolIds, prices, [1n])

				await expect(
					context.clearingHouseFacet.connect(context.signers.user2).takeoverPartyALiquidation(context.signers.user.address),
				).to.be.revertedWith("Accessibility: Must have role")
			})

			it("should succeed when partyA is already being liquidated", async () => {
				// First liquidate partyA normally
				const symbolIds = [1n]
				const prices = [decimal(25n)]
				await user.liquidateAndSetSymbolPrices(symbolIds, prices, [1n])

				const validator = new TakeoverPartyALiquidationValidator()
				const beforeOut = await validator.before(context, { user })

				// Now takeover the liquidation
				await expect(context.clearingHouseFacet.connect(context.signers.liquidator).takeoverPartyALiquidation(context.signers.user.address)).to.not.be
					.reverted

				await validator.after(context, { user, beforeOutput: beforeOut })
			})

			it("should emit TakeoverPartyALiquidation event", async () => {
				const symbolIds = [1n]
				const prices = [decimal(25n)]
				await user.liquidateAndSetSymbolPrices(symbolIds, prices, [1n])

				await expect(context.clearingHouseFacet.connect(context.signers.liquidator).takeoverPartyALiquidation(context.signers.user.address)).to.emit(
					context.clearingHouseFacet,
					"TakeoverPartyALiquidation",
				)
			})

			it("should fail if takeover is already in progress", async () => {
				const symbolIds = [1n]
				const prices = [decimal(25n)]
				await user.liquidateAndSetSymbolPrices(symbolIds, prices, [1n])

				// First takeover
				await context.clearingHouseFacet.connect(context.signers.liquidator).takeoverPartyALiquidation(context.signers.user.address)

				// Second takeover should fail
				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).takeoverPartyALiquidation(context.signers.user.address),
				).to.be.revertedWith("ClearingHouseFacet: Takeover already in progress")
			})

			it("should block normal liquidation functions after takeover", async () => {
				const symbolIds = [1n]
				const prices = [decimal(25n)]
				const liquidationSig = await user.liquidateAndSetSymbolPrices(symbolIds, prices, [1n])

				// Takeover
				await context.clearingHouseFacet.connect(context.signers.liquidator).takeoverPartyALiquidation(context.signers.user.address)

				// Try to use normal liquidation functions - should fail
				await expect(
					context.partyALiquidationFacet.connect(context.signers.liquidator).setSymbolsPrice(context.signers.user.address, liquidationSig),
				).to.be.revertedWith("LiquidationFacet: Takeover in progress")

				await expect(
					context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePendingPositionsPartyA(context.signers.user.address),
				).to.be.revertedWith("LiquidationFacet: Takeover in progress")

				await expect(
					context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePositionsPartyA(context.signers.user.address, [1n]),
				).to.be.revertedWith("LiquidationFacet: Takeover in progress")

				await expect(
					context.partyALiquidationFacet
						.connect(context.signers.liquidator)
						.settlePartyALiquidation(context.signers.user.address, [context.signers.hedger.address]),
				).to.be.revertedWith("LiquidationFacet: Takeover in progress")
			})

			it("should clear disputed flag and liquidation fee after takeover", async () => {
				const symbolIds = [1n]
				const prices = [decimal(25n)]
				await user.liquidateAndSetSymbolPrices(symbolIds, prices, [1n])

				// PartyA should be liquidated
				const isLiquidated = await context.viewFacet.isPartyALiquidated(context.signers.user.address)
				expect(isLiquidated).to.equal(true)

				// Takeover
				await context.clearingHouseFacet.connect(context.signers.liquidator).takeoverPartyALiquidation(context.signers.user.address)

				// Check liquidation details after takeover
				const detailsAfter = await context.viewFacet.getLiquidatedStateOfPartyA(context.signers.user.address)
				expect(detailsAfter.liquidationFee).to.equal(0)
				expect(detailsAfter.disputed).to.equal(false)

				// PartyA should still be in liquidation (but now controlled by clearing house)
				const stillLiquidated = await context.viewFacet.isPartyALiquidated(context.signers.user.address)
				expect(stillLiquidated).to.equal(true)
			})
		})

		describe("deallocateForClearingHouse (PartyA Takeover)", () => {
			beforeEach(async () => {
				const symbolIds = [1n]
				const prices = [decimal(25n)]
				await user.liquidateAndSetSymbolPrices(symbolIds, prices, [1n])

				// Takeover the liquidation
				await context.clearingHouseFacet.connect(context.signers.liquidator).takeoverPartyALiquidation(context.signers.user.address)
			})

			it("should pull from partyA allocatedBalances using key=address(0)", async () => {
				const userAddress = await user.getAddress()
				const balanceBefore = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user.address)
				const pullAmount = 100n

				const validator = new DeallocateForCHValidator()
				const beforeOut = await validator.before(context, {
					subject: userAddress,
					parties: [userAddress],
					allocationKeys: [ZeroAddress],
					amounts: [pullAmount],
				})

				await applyClearingHousePnlDebits(context.signers.user.address, [context.signers.user.address], [ZeroAddress], [pullAmount])

				await validator.after(context, {
					subject: userAddress,
					parties: [userAddress],
					allocationKeys: [ZeroAddress],
					amounts: [pullAmount],
					beforeOutput: beforeOut,
				})

				const balanceAfter = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user.address)
				expect(balanceAfter).to.equal(balanceBefore - pullAmount)
			})

			it("should pull from partyB isolated allocation using key=partyA", async () => {
				const isolatedBalanceBefore = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)
				const pullAmount = 100n

				await applyClearingHousePnlDebits(
					context.signers.user.address,
					[context.signers.hedger.address],
					[context.signers.user.address],
					[pullAmount],
				)

				const isolatedBalanceAfter = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)
				expect(isolatedBalanceAfter).to.equal(isolatedBalanceBefore - pullAmount)
			})

			it("should fail with insufficient allocated balance", async () => {
				const balance = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user.address)
				const excessiveAmount = balance + 1n

				await expect(
					applyClearingHousePnlDebits(context.signers.user.address, [context.signers.user.address], [ZeroAddress], [excessiveAmount]),
				).to.be.revertedWith("ClearingHouseFacet: Insufficient allocated balance")
			})

			it("should fail with invalid allocation key for partyA", async () => {
				// address(0) = allocatedBalances, address(1) = partyAReimbursement, anything else is invalid
				const invalidKey = "0x0000000000000000000000000000000000000002"

				await expect(
					applyClearingHousePnlDebits(context.signers.user.address, [context.signers.user.address], [invalidKey], [100n]),
				).to.be.revertedWith("ClearingHouseFacet: Invalid allocation key for partyA")
			})

			it("should pull from multiple sources in batch", async () => {
				const partyABalanceBefore = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user.address)
				const partyBIsolatedBefore = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)
				const poolBefore = (await context.viewFacet.getPartyATakeoverDetails(context.signers.user.address)).deallocatedPool

				const amountFromPartyA = 50n
				const amountFromPartyB = 100n

				await applyClearingHousePnlDebits(
					context.signers.user.address,
					[context.signers.user.address, context.signers.hedger.address],
					[ZeroAddress, context.signers.user.address],
					[amountFromPartyA, amountFromPartyB],
				)

				const partyABalanceAfter = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user.address)
				const partyBIsolatedAfter = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)

				expect(partyABalanceAfter).to.equal(partyABalanceBefore - amountFromPartyA)
				expect(partyBIsolatedAfter).to.equal(partyBIsolatedBefore - amountFromPartyB)

				// Verify deallocated pool increased by total amount
				const poolAfter = (await context.viewFacet.getPartyATakeoverDetails(context.signers.user.address)).deallocatedPool
				expect(poolAfter).to.equal(poolBefore + amountFromPartyA + amountFromPartyB)
			})
		})

		describe("distributeForClearingHouse (PartyA Takeover)", () => {
			beforeEach(async () => {
				const symbolIds = [1n]
				const prices = [decimal(25n)]
				await user.liquidateAndSetSymbolPrices(symbolIds, prices, [1n])

				// Takeover
				await context.clearingHouseFacet.connect(context.signers.liquidator).takeoverPartyALiquidation(context.signers.user.address)

				// Deallocate some funds first
				await applyClearingHousePnlDebits(context.signers.user.address, [context.signers.hedger.address], [context.signers.user.address], [1000n])
			})

			it("should distribute to receivers successfully", async () => {
				const receiverBalanceBefore = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user2.address)
				const poolBefore = (await context.viewFacet.getPartyATakeoverDetails(context.signers.user.address)).deallocatedPool
				const distributeAmount = 500n

				await expect(applyClearingHousePnlCredits(context.signers.user.address, [context.signers.user2.address], [ZeroAddress], [distributeAmount]))
					.to.emit(context.clearingHouseFacet, "ClearingHouseAccountSettlement")
					.withArgs(context.signers.user.address, context.signers.user2.address, ZeroAddress, distributeAmount)

				const receiverBalanceAfter = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user2.address)
				expect(receiverBalanceAfter).to.equal(receiverBalanceBefore + distributeAmount)

				const poolAfter = (await context.viewFacet.getPartyATakeoverDetails(context.signers.user.address)).deallocatedPool
				expect(poolAfter).to.equal(poolBefore - distributeAmount)
			})

			it("should expose the solver's funding and PnL when PartyA takeover credits its isolated bucket", async () => {
				const subject = context.signers.user.address
				const solver = context.signers.hedger.address
				const allocationBefore = await context.viewFacet.allocatedBalanceOfPartyB(solver, subject)
				const settlement = {
					account: solver,
					allocationKey: subject,
					symbolId: 1n,
					realizedPnl: -20n,
					funding: 70n,
					platformFee: 0n,
				}

				const tx = await context.clearingHouseFacet.connect(context.signers.liquidator).applyClearingHouseSettlement(subject, [settlement])
				const receipt = await tx.wait()

				expect(await context.viewFacet.allocatedBalanceOfPartyB(solver, subject)).to.equal(allocationBefore + 50n)
				const componentEvents = parseClearingHouseSettlementLogs(receipt?.logs ?? []).filter(
					event => event.name === "ClearingHouseSettlementComponent",
				)
				expect(componentEvents.map(event => [...event.args])).to.deep.equal([[subject, solver, 1n, subject, -20n, 70n, 0n]])
				expect(
					parseAllocatedBalanceChangeLogs(receipt?.logs ?? []).filter(event => event.account.toLowerCase() === solver.toLowerCase()),
				).to.deep.equal([
					{
						name: "BalanceChangePartyB",
						account: solver,
						allocationKey: subject,
						amount: 70n,
						changeType: BigInt(BalanceChangeType.FUNDING_FEE_IN),
					},
					{
						name: "BalanceChangePartyB",
						account: solver,
						allocationKey: subject,
						amount: 20n,
						changeType: BigInt(BalanceChangeType.REALIZED_PNL_OUT),
					},
				])
			})

			it("should fail when distributing more than deallocated pool", async () => {
				await expect(
					applyClearingHousePnlCredits(context.signers.user.address, [context.signers.user2.address], [ZeroAddress], [2000n]),
				).to.be.revertedWith("ClearingHouseFacet: Insufficient pool balance")
			})

			it("should distribute to multiple receivers", async () => {
				const receiver1Before = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user2.address)
				// hedger is a partyB, so check their partyB allocated balance (isolated with user)
				const receiver2Before = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)

				await applyClearingHousePnlCredits(
					context.signers.user.address,
					[context.signers.user2.address, context.signers.hedger.address],
					[ZeroAddress, context.signers.user.address], // user2 is partyA (key ignored), hedger is partyB (isolated with user)
					[300n, 400n],
				)

				const receiver1After = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user2.address)
				const receiver2After = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)

				expect(receiver1After).to.equal(receiver1Before + 300n)
				expect(receiver2After).to.equal(receiver2Before + 400n)
			})
		})

		describe("liquidatePendingPositionsForClearingHouse (PartyA Takeover)", () => {
			beforeEach(async () => {
				const symbolIds = [1n]
				const prices = [decimal(25n)]
				await user.liquidateAndSetSymbolPrices(symbolIds, prices, [1n])

				// Takeover
				await context.clearingHouseFacet.connect(context.signers.liquidator).takeoverPartyALiquidation(context.signers.user.address)
			})

			it("should liquidate all pending quotes for partyA", async () => {
				const userAddress = await user.getAddress()
				const pendingBefore = await context.viewFacetQuote.getPartyAPendingQuotes(context.signers.user.address)
				expect(pendingBefore.length).to.be.greaterThan(0)
				const expectedReturnedFees = await getTradingFeeForQuotes(context, pendingBefore)

				const validator = new LiquidatePendingCHValidator()
				const beforeOut = await validator.before(context, {
					subject: userAddress,
					counterparties: [],
					isCrossPartyB: false,
				})

				const pendingLiquidationTx = await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.user.address, []) // counterparties ignored for partyA takeover
				const pendingLiquidationReceipt = await pendingLiquidationTx.wait()
				const partyABalanceEvents = (pendingLiquidationReceipt?.logs ?? []).flatMap(log => {
					try {
						const parsed = balanceChangeInterface.parseLog({ topics: log.topics as string[], data: log.data })
						return parsed?.name === "BalanceChangePartyA" ? [parsed] : []
					} catch {
						return []
					}
				})
				const reimbursementEvents = parsePartyAReimbursementChangeLogs(pendingLiquidationReceipt?.logs ?? []).filter(
					event => event.partyA.toLowerCase() === userAddress.toLowerCase(),
				)
				expect(partyABalanceEvents).to.have.length(0)
				expect(reimbursementEvents.every(event => event.changeType === BigInt(ReimbursementChangeType.PLATFORM_FEE_IN))).to.equal(true)
				expect(reimbursementEvents.reduce((sum, event) => sum + event.amount, 0n)).to.equal(expectedReturnedFees)
				expect(reimbursementEvents.at(-1)?.newBalance).to.equal(beforeOut.reimbursement + expectedReturnedFees)

				await validator.after(context, {
					subject: userAddress,
					counterparties: [],
					isCrossPartyB: false,
					beforeOutput: beforeOut,
				})

				const pendingAfter = await context.viewFacetQuote.getPartyAPendingQuotes(context.signers.user.address)
				expect(pendingAfter.length).to.equal(0)
			})

			it("should update quote statuses to LIQUIDATED_PENDING", async () => {
				// Quote 2 and 5 are locked (pending)
				const quote2Before = await context.viewFacetQuote.getQuote(2)
				const quote5Before = await context.viewFacetQuote.getQuote(5)
				expect(quote2Before.quoteStatus).to.equal(QuoteStatus.LOCKED)
				expect(quote5Before.quoteStatus).to.equal(QuoteStatus.LOCKED)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.user.address, [])

				const quote2After = await context.viewFacetQuote.getQuote(2)
				const quote5After = await context.viewFacetQuote.getQuote(5)
				expect(quote2After.quoteStatus).to.equal(QuoteStatus.LIQUIDATED_PENDING)
				expect(quote5After.quoteStatus).to.equal(QuoteStatus.LIQUIDATED_PENDING)
			})

			it("should emit event with liquidated amounts", async () => {
				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).liquidatePendingPositionsForClearingHouse(context.signers.user.address, []),
				).to.emit(context.clearingHouseFacet, "LiquidatePendingPositionsForClearingHouse")
			})
		})

		describe("liquidatePositionsForClearingHouse (PartyA Takeover)", () => {
			beforeEach(async () => {
				const symbolIds = [1n]
				const prices = [decimal(25n)]
				await user.liquidateAndSetSymbolPrices(symbolIds, prices, [1n])

				// Takeover
				await context.clearingHouseFacet.connect(context.signers.liquidator).takeoverPartyALiquidation(context.signers.user.address)
			})

			it("should liquidate open positions with given prices", async () => {
				const userAddress = await user.getAddress()
				const quote1Before = await context.viewFacetQuote.getQuote(1)
				expect(quote1Before.quoteStatus).to.equal(QuoteStatus.OPENED)

				const validator = new LiquidatePositionsCHValidator()
				const beforeOut = await validator.before(context, {
					subject: userAddress,
					quoteIds: [1n],
				})

				const liquidationTx = context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.user.address, [1n], [decimal(25n)])
				await expect(liquidationTx).to.not.emit(context.partyBExecutionFacet, "SolverFeeCharged")

				await validator.after(context, {
					subject: userAddress,
					quoteIds: [1n],
					prices: [decimal(25n)],
					beforeOutput: beforeOut,
				})

				const quote1After = await context.viewFacetQuote.getQuote(1)
				expect(quote1After.quoteStatus).to.equal(QuoteStatus.LIQUIDATED)
				expect((await context.viewFacetQuote.getSolverFeeState(1n)).closeFeeCharged).to.equal(0n)
			})

			it("should sync accumulated funding before partyA takeover liquidation close", async () => {
				const epochDuration = 3600
				await context.pauseControlFacet.connect(context.signers.admin).activateAccumulatedFunding()
				await context.fundingRateFacet.connect(context.signers.hedger).setEpochDurations([1], [epochDuration])
				await context.fundingRateFacet
					.connect(context.signers.hedger)
					.updateAccumulatedFundingFee([1], [decimal(1n, 16)], [-decimal(1n, 16)], [decimal(1n)])
				await time.increase(epochDuration * 2)

				const quoteBefore = await context.viewFacetQuote.getQuote(1)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.user.address, [1n], [decimal(25n)])

				const quoteAfter = await context.viewFacetQuote.getQuote(1)
				expect(quoteAfter.accumulatedPaidFunding).to.not.equal(quoteBefore.accumulatedPaidFunding)
				expect(quoteAfter.lastFundingPaymentTimestamp).to.be.gt(quoteBefore.lastFundingPaymentTimestamp)
			})

			it("should emit LiquidatePositionsForClearingHouse event", async () => {
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidatePositionsForClearingHouse(context.signers.user.address, [1n], [decimal(25n)]),
				).to.emit(context.clearingHouseFacet, "LiquidatePositionsForClearingHouse")
			})

			it("should fail if quote doesn't belong to the partyA being liquidated", async () => {
				// Quote 1 belongs to user, not user2
				// This would fail because user2 is not in takeover
				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).liquidatePositionsForClearingHouse(
						context.signers.user2.address, // Different partyA
						[1n],
						[decimal(25n)],
					),
				).to.be.revertedWith("ClearingHouseFacet: No active liquidation")
			})

			it("should fail if partyB is in liquidation process", async () => {
				// First put hedger in liquidation
				await migratePartyBToCross(context, hedger, [1])
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.address, "0x", BigInt("-999999999999999999999999999999"), await getBlockTimestamp())

				// Now try to liquidate positions - should fail since partyB is in cross liquidation
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidatePositionsForClearingHouse(context.signers.user.address, [1n], [decimal(25n)]),
				).to.be.revertedWith("PartyBState: PartyB is in liquidation")
			})

			it("should not increment partyA nonce during partyA takeover position liquidation", async () => {
				const partyA = context.signers.user.address
				const partyB = context.signers.hedger.address
				const partyANonceBefore = await context.viewFacet.nonceOfPartyA(partyA)
				const partyBNonceBefore = await context.viewFacet.nonceOfPartyB(partyB, partyA)

				await context.clearingHouseFacet.connect(context.signers.liquidator).liquidatePositionsForClearingHouse(partyA, [1n], [decimal(25n)])

				const partyANonceAfter = await context.viewFacet.nonceOfPartyA(partyA)
				const partyBNonceAfter = await context.viewFacet.nonceOfPartyB(partyB, partyA)
				expect(partyANonceAfter).to.equal(partyANonceBefore)
				expect(partyBNonceAfter).to.equal(partyBNonceBefore + 1n)
			})
		})

		describe("settlePartyATakeover", () => {
			beforeEach(async () => {
				const symbolIds = [1n]
				const prices = [decimal(25n)]
				await user.liquidateAndSetSymbolPrices(symbolIds, prices, [1n])

				// Takeover
				await context.clearingHouseFacet.connect(context.signers.liquidator).takeoverPartyALiquidation(context.signers.user.address)

				// Liquidate pending positions
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.user.address, [])

				// Liquidate open positions (only quote 1 is open)
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.user.address, [1n], [decimal(25n)])
			})

			it("should fail if takeover is not in progress", async () => {
				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).settlePartyATakeover(context.signers.user2.address, []),
				).to.be.revertedWith("ClearingHouseFacet: Takeover not in progress")
			})

			it("should fail if deallocated pool has undistributed funds", async () => {
				// Deallocate some funds but don't distribute them
				const partyBIsolated = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)
				if (partyBIsolated > 0n) {
					await applyClearingHousePnlDebits(
						context.signers.user.address,
						[context.signers.hedger.address],
						[context.signers.user.address],
						[partyBIsolated],
					)
				}

				// Try to settle without distributing - should fail
				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).settlePartyATakeover(context.signers.user.address, []),
				).to.be.revertedWith("ClearingHouseFacet: Undistributed funds in deallocated pool")
			})

			it("should clear liquidation status", async () => {
				const statusBefore = await context.viewFacet.isPartyALiquidated(context.signers.user.address)
				expect(statusBefore).to.equal(true)

				const validator = new SettlePartyATakeoverValidator()
				const beforeOut = await validator.before(context, { user })

				await expect(context.clearingHouseFacet.connect(context.signers.liquidator).settlePartyATakeover(context.signers.user.address, []))
					.to.emit(context.clearingHouseFacet, "SettlePartyATakeover")
					.withArgs(context.signers.user.address, "0x10")

				await validator.after(context, { user, settledPartyBs: [], beforeOutput: beforeOut })

				const statusAfter = await context.viewFacet.isPartyALiquidated(context.signers.user.address)
				expect(statusAfter).to.equal(false)

				// Verify takeover details cleared
				const takeoverDetails = await context.viewFacet.getPartyATakeoverDetails(context.signers.user.address)
				expect(takeoverDetails.inProgress).to.equal(false)
				expect(takeoverDetails.deallocatedPool).to.equal(0)
			})

			it("should not burn partyA reimbursement escrow on settlement", async () => {
				let partyBIsolated = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)
				if (partyBIsolated == 0n) {
					await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(1n, context.signers.user.address)
					partyBIsolated = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)
				}

				expect(partyBIsolated).to.be.greaterThan(0n)

				await applyClearingHousePnlDebits(context.signers.user.address, [context.signers.hedger.address], [context.signers.user.address], [1n])

				await applyClearingHousePnlCredits(context.signers.user.address, [context.signers.user.address], [ZeroAddress], [1n])

				const validator = new SettlePartyATakeoverValidator()
				const beforeOut = await validator.before(context, { user })
				expect(beforeOut.reimbursement).to.be.greaterThan(0n)

				const settleTx = await context.clearingHouseFacet.connect(context.signers.liquidator).settlePartyATakeover(context.signers.user.address, [])
				const settleReceipt = await settleTx.wait()
				const reimbursementBucketEvents = parsePartyAReimbursementChangeLogs(settleReceipt?.logs ?? []).filter(
					event => event.partyA.toLowerCase() === context.signers.user.address.toLowerCase(),
				)
				const releaseEvents = (settleReceipt?.logs ?? []).flatMap(log => {
					try {
						const parsed = balanceChangeInterface.parseLog({ topics: log.topics as string[], data: log.data })
						if (parsed?.name !== "BalanceChangePartyA" || parsed.args.partyA.toLowerCase() !== context.signers.user.address.toLowerCase()) return []
						return [{ amount: parsed.args.amount as bigint, changeType: parsed.args._type as bigint }]
					} catch {
						return []
					}
				})
				const reimbursementEvents = releaseEvents.filter(event => event.changeType === BigInt(BalanceChangeType.REIMBURSEMENT_IN))
				const deferredEvents = releaseEvents.filter(event => event.changeType === BigInt(BalanceChangeType.DEFERRED_BALANCE_IN))
				expect(reimbursementEvents.reduce((sum, event) => sum + event.amount, 0n)).to.equal(beforeOut.reimbursement)
				expect(deferredEvents.reduce((sum, event) => sum + event.amount, 0n)).to.equal(beforeOut.deferredBalance)
				expect(reimbursementBucketEvents).to.deep.equal([
					{
						partyA: context.signers.user.address,
						amount: beforeOut.reimbursement,
						newBalance: 0n,
						changeType: BigInt(ReimbursementChangeType.RELEASE_TO_ALLOCATED),
					},
				])

				await validator.after(context, { user, settledPartyBs: [], beforeOutput: beforeOut })
			})

			it("should classify platform-fee debits from partyA reimbursement", async () => {
				const subject = context.signers.user.address
				const solver = context.signers.hedger.address
				const platformFee = 3n
				const isolatedBalance = await context.viewFacet.allocatedBalanceOfPartyB(solver, subject)
				expect(isolatedBalance).to.be.gte(platformFee)

				await applyClearingHousePnlDebits(subject, [solver], [subject], [platformFee])
				await applyClearingHousePnlCredits(subject, [subject], [ZeroAddress], [platformFee])
				const reimbursementBefore = await context.viewFacet.partyAReimbursement(subject)
				const REIMBURSEMENT_KEY = "0x0000000000000000000000000000000000000001"

				const tx = await context.clearingHouseFacet.connect(context.signers.liquidator).applyClearingHouseSettlement(subject, [
					{
						account: subject,
						allocationKey: REIMBURSEMENT_KEY,
						symbolId: 0n,
						realizedPnl: 0n,
						funding: 0n,
						platformFee: -platformFee,
					},
				])
				const receipt = await tx.wait()

				expect(await context.viewFacet.partyAReimbursement(subject)).to.equal(reimbursementBefore - platformFee)
				expect(parsePartyAReimbursementChangeLogs(receipt?.logs ?? [])).to.deep.equal([
					{
						partyA: subject,
						amount: platformFee,
						newBalance: reimbursementBefore - platformFee,
						changeType: BigInt(ReimbursementChangeType.PLATFORM_FEE_OUT),
					},
				])
			})

			it("should not change partyA allocated balance when reimbursement was already distributed away", async () => {
				let reimbursementToDrain = await context.viewFacet.partyAReimbursement(context.signers.user.address)
				if (reimbursementToDrain == 0n) {
					let partyBIsolated = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)
					if (partyBIsolated == 0n) {
						await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(1n, context.signers.user.address)
						partyBIsolated = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)
					}
					expect(partyBIsolated).to.be.greaterThan(0n)

					await applyClearingHousePnlDebits(context.signers.user.address, [context.signers.hedger.address], [context.signers.user.address], [1n])
					await applyClearingHousePnlCredits(context.signers.user.address, [context.signers.user.address], [ZeroAddress], [1n])

					reimbursementToDrain = await context.viewFacet.partyAReimbursement(context.signers.user.address)
				}

				expect(reimbursementToDrain).to.be.greaterThan(0n)

				const REIMBURSEMENT_KEY = "0x0000000000000000000000000000000000000001"
				const reimbursementDeallocationTx = await applyClearingHousePnlDebits(
					context.signers.user.address,
					[context.signers.user.address],
					[REIMBURSEMENT_KEY],
					[reimbursementToDrain],
				)
				const reimbursementDeallocationReceipt = await reimbursementDeallocationTx.wait()
				const reimbursementBucketEvents = parsePartyAReimbursementChangeLogs(reimbursementDeallocationReceipt?.logs ?? []).filter(
					event => event.partyA.toLowerCase() === context.signers.user.address.toLowerCase(),
				)
				expect(reimbursementBucketEvents).to.deep.equal([
					{
						partyA: context.signers.user.address,
						amount: reimbursementToDrain,
						newBalance: 0n,
						changeType: BigInt(ReimbursementChangeType.REALIZED_PNL_OUT),
					},
				])
				await applyClearingHousePnlCredits(context.signers.user.address, [context.signers.admin.address], [ZeroAddress], [reimbursementToDrain])

				const reimbursementBefore = await context.viewFacet.partyAReimbursement(context.signers.user.address)
				expect(reimbursementBefore).to.equal(0n)

				const allocatedBefore = (await user.getBalanceInfo()).allocatedBalances
				await context.clearingHouseFacet.connect(context.signers.liquidator).settlePartyATakeover(context.signers.user.address, [])
				const allocatedAfter = (await user.getBalanceInfo()).allocatedBalances

				expect(allocatedAfter).to.equal(allocatedBefore)
			})

			it("should increment partyA nonce", async () => {
				const nonceBefore = await context.viewFacet.nonceOfPartyA(context.signers.user.address)

				await context.clearingHouseFacet.connect(context.signers.liquidator).settlePartyATakeover(context.signers.user.address, [])

				const nonceAfter = await context.viewFacet.nonceOfPartyA(context.signers.user.address)
				expect(nonceAfter).to.equal(nonceBefore + 1n)
			})

			it("should emit SettlePartyATakeover event", async () => {
				await expect(context.clearingHouseFacet.connect(context.signers.liquidator).settlePartyATakeover(context.signers.user.address, []))
					.to.emit(context.clearingHouseFacet, "SettlePartyATakeover")
					.withArgs(context.signers.user.address, "0x10")
			})

			it("should allow partyA to trade again after settlement", async () => {
				await context.clearingHouseFacet.connect(context.signers.liquidator).settlePartyATakeover(context.signers.user.address, [])

				// PartyA should be able to send new quotes (sendQuote returns quote ID, not tx)
				const quoteId = await user.sendQuote(limitQuoteRequestBuilder().build())
				expect(quoteId).to.be.greaterThan(0n)
			})
		})

		describe("Full PartyA Takeover Flow", () => {
			it("should complete full takeover flow end-to-end", async () => {
				// Step 1: PartyA gets liquidated normally
				const symbolIds = [1n]
				const prices = [decimal(25n)]
				await user.liquidateAndSetSymbolPrices(symbolIds, prices, [1n])

				// Step 2: Clearing house takes over
				await context.clearingHouseFacet.connect(context.signers.liquidator).takeoverPartyALiquidation(context.signers.user.address)

				// Step 3: Liquidate pending positions
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.user.address, [])

				// Step 4: Liquidate open positions (only quote 1 is open)
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.user.address, [1n], [decimal(25n)])

				// Step 5: Deallocate funds from partyB
				const partyBIsolated = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)
				if (partyBIsolated > 0n) {
					await applyClearingHousePnlDebits(
						context.signers.user.address,
						[context.signers.hedger.address],
						[context.signers.user.address],
						[partyBIsolated],
					)

					// Step 6: Distribute ALL funds to receivers (must distribute everything before settle)
					await applyClearingHousePnlCredits(
						context.signers.user.address,
						[context.signers.admin.address],
						[ZeroAddress], // admin is not a partyB, key ignored
						[partyBIsolated], // Distribute all, not half
					)
				}

				// Step 7: Settle
				await context.clearingHouseFacet.connect(context.signers.liquidator).settlePartyATakeover(context.signers.user.address, [])

				// Verify final state
				const liquidationStatus = await context.viewFacet.isPartyALiquidated(context.signers.user.address)
				expect(liquidationStatus).to.equal(false)

				const positionsCount = await context.viewFacetQuote.partyAPositionsCount(context.signers.user.address)
				expect(positionsCount).to.equal(0)

				const pendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(context.signers.user.address)
				expect(pendingQuotes.length).to.equal(0)
			})
		})
	})

	// ============================================
	// SIMULTANEOUS PARTYA + CROSS PARTYB LIQUIDATION
	// ============================================

	describe("Simultaneous PartyA + Cross PartyB Liquidation", () => {
		beforeEach(async () => {
			// Quote1 -> opened (SHORT)
			await hedger.lockQuote(1)
			await hedger.openPosition(1)

			// Quote2 -> locked (pending)
			await hedger.lockQuote(2)

			// Quote5 -> locked (pending)
			await hedger.lockQuote(5)

			// Migrate hedger to cross mode (only quotes 1, 2, 5 — skip quote 4 to avoid offsetting UPNL)
			await migratePartyBToCross(context, hedger, [1, 2, 5])
		})

		describe("Auto-takeover via liquidatePositionsForClearingHouse", () => {
			beforeEach(async () => {
				// Liquidate partyA normally first
				const symbolIds = [1n]
				const prices = [decimal(25n)]
				await user.liquidateAndSetSymbolPrices(symbolIds, prices, [1n])

				// Start cross partyB liquidation
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.getAddress(), "0x", BigInt("-999999999999999999999999999999"), await getBlockTimestamp())
			})

			it("should auto-takeover partyA liquidation when processing positions", async () => {
				// Before: no takeover
				const detailsBefore = await context.viewFacet.getPartyATakeoverDetails(context.signers.user.address)
				expect(detailsBefore.inProgress).to.equal(false)

				// Liquidate positions — should trigger auto-takeover
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidatePositionsForClearingHouse(context.signers.hedger.address, [1n], [decimal(1n)]),
				)
					.to.emit(context.clearingHouseFacet, "AutoTakeoverPartyALiquidation")
					.withArgs(context.signers.user.address, "0x10")

				// After: takeover in progress
				const detailsAfter = await context.viewFacet.getPartyATakeoverDetails(context.signers.user.address)
				expect(detailsAfter.inProgress).to.equal(true)
			})

			it("should not emit AutoTakeoverPartyALiquidation on subsequent calls for same partyA", async () => {
				// Liquidate pending first (triggers auto-takeover for user)
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.hedger.address, [context.signers.user.address])

				// Now liquidate positions — takeover already happened, should NOT emit again
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidatePositionsForClearingHouse(context.signers.hedger.address, [1n], [decimal(1n)]),
				).to.not.emit(context.clearingHouseFacet, "AutoTakeoverPartyALiquidation")
			})

			it("should increment partyA nonce even when auto-takeover is triggered", async () => {
				const partyA = context.signers.user.address
				const partyB = context.signers.hedger.address
				const partyANonceBefore = await context.viewFacet.nonceOfPartyA(partyA)
				const partyBNonceBefore = await context.viewFacet.nonceOfPartyB(partyB, partyA)

				await context.clearingHouseFacet.connect(context.signers.liquidator).liquidatePositionsForClearingHouse(partyB, [1n], [decimal(1n)])

				const partyANonceAfter = await context.viewFacet.nonceOfPartyA(partyA)
				const partyBNonceAfter = await context.viewFacet.nonceOfPartyB(partyB, partyA)
				expect(partyANonceAfter).to.equal(partyANonceBefore + 1n)
				expect(partyBNonceAfter).to.equal(partyBNonceBefore + 1n)
			})
		})

		describe("Auto-takeover via liquidatePendingPositionsForClearingHouse", () => {
			beforeEach(async () => {
				// Liquidate partyA normally first
				const symbolIds = [1n]
				const prices = [decimal(25n)]
				await user.liquidateAndSetSymbolPrices(symbolIds, prices, [1n])

				// Start cross partyB liquidation
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.getAddress(), "0x", BigInt("-999999999999999999999999999999"), await getBlockTimestamp())
			})

			it("should auto-takeover partyA when processing pending quotes", async () => {
				const detailsBefore = await context.viewFacet.getPartyATakeoverDetails(context.signers.user.address)
				expect(detailsBefore.inProgress).to.equal(false)
				const reimbursementBefore = await context.viewFacet.partyAReimbursement(context.signers.user.address)
				const expectedReturnedFees = await getTradingFeeForQuotes(context, [2n, 5n])

				const pendingLiquidationTx = await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.hedger.address, [context.signers.user.address])
				await expect(pendingLiquidationTx)
					.to.emit(context.clearingHouseFacet, "AutoTakeoverPartyALiquidation")
					.withArgs(context.signers.user.address, "0x10")
				const pendingLiquidationReceipt = await pendingLiquidationTx.wait()
				const partyABalanceEvents = (pendingLiquidationReceipt?.logs ?? []).flatMap(log => {
					try {
						const parsed = balanceChangeInterface.parseLog({ topics: log.topics as string[], data: log.data })
						return parsed?.name === "BalanceChangePartyA" ? [parsed] : []
					} catch {
						return []
					}
				})
				const reimbursementEvents = parsePartyAReimbursementChangeLogs(pendingLiquidationReceipt?.logs ?? []).filter(
					event => event.partyA.toLowerCase() === context.signers.user.address.toLowerCase(),
				)
				expect(partyABalanceEvents).to.have.length(0)
				expect(reimbursementEvents.every(event => event.changeType === BigInt(ReimbursementChangeType.PLATFORM_FEE_IN))).to.equal(true)
				expect(reimbursementEvents.reduce((sum, event) => sum + event.amount, 0n)).to.equal(expectedReturnedFees)
				expect(reimbursementEvents.at(-1)?.newBalance).to.equal(reimbursementBefore + expectedReturnedFees)

				const detailsAfter = await context.viewFacet.getPartyATakeoverDetails(context.signers.user.address)
				expect(detailsAfter.inProgress).to.equal(true)
			})
		})

		describe("settlePartyALiquidation blocked by cross partyB", () => {
			it("should revert when settling partyA with a partyB in cross liquidation", async () => {
				// Liquidate partyA (only has quote 1 SHORT with cross hedger)
				const symbolIds = [1n]
				const prices = [decimal(25n)]
				await user.liquidateAndSetSymbolPrices(symbolIds, prices, [1n])

				// Start cross partyB liquidation for hedger
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.getAddress(), "0x", BigInt("-999999999999999999999999999999"), await getBlockTimestamp())

				// Liquidate pending positions (triggers auto-takeover)
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.hedger.address, [context.signers.user.address])

				// Liquidate open positions via clearing house
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.hedger.address, [1n], [decimal(1n)])

				// All positions are closed now, but hedger is still in cross liquidation.
				// The normal liquidation flow's settlePartyALiquidation should be blocked
				// because it has a settlement state for a cross-liquidated partyB.
				// However, since auto-takeover kicked in, settlePartyALiquidation is blocked
				// by "Takeover in progress" check. Let's verify the cross liquidation guard
				// by checking that the normal `liquidatePositionsPartyA` is blocked for cross partyBs.
				// We test the guard directly by attempting to settle with the cross partyB.

				// The takeover guard fires first, but if we were to bypass it (hypothetically),
				// the cross liquidation guard would also block. Verify the takeover is in progress:
				const takeoverDetails = await context.viewFacet.getPartyATakeoverDetails(context.signers.user.address)
				expect(takeoverDetails.inProgress).to.equal(true)

				// settlePartyALiquidation is blocked by takeover
				await expect(
					context.partyALiquidationFacet
						.connect(context.signers.liquidator)
						.settlePartyALiquidation(context.signers.user.address, [context.signers.hedger.address]),
				).to.be.revertedWith("LiquidationFacet: Takeover in progress")
			})

			it("should block normal liquidatePositionsPartyA for cross-liquidated partyB", async () => {
				// Liquidate partyA
				const symbolIds = [1n]
				const prices = [decimal(25n)]
				await user.liquidateAndSetSymbolPrices(symbolIds, prices, [1n])

				// Start cross partyB liquidation
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.getAddress(), "0x", BigInt("-999999999999999999999999999999"), await getBlockTimestamp())

				// Normal liquidatePositionsPartyA should fail for cross-liquidated partyB
				await expect(
					context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePositionsPartyA(context.signers.user.address, [1n]),
				).to.be.revertedWith("PartyBState: PartyB is in liquidation")
			})
		})

		describe("distributeForClearingHouse routes to reimbursement for liquidated partyA", () => {
			beforeEach(async () => {
				// Liquidate partyA
				const symbolIds = [1n]
				const prices = [decimal(25n)]
				await user.liquidateAndSetSymbolPrices(symbolIds, prices, [1n])

				// Start cross partyB liquidation
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.getAddress(), "0x", BigInt("-999999999999999999999999999999"), await getBlockTimestamp())

				// Deallocate some funds from cross partyB
				const crossAllocated = (await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger))[0]
				if (crossAllocated > 0n) {
					await applyClearingHousePnlDebits(context.signers.hedger.address, [context.signers.hedger.address], [ZeroAddress], [crossAllocated])
				}
			})

			it("should route funding to partyAReimbursement with its funding classification", async () => {
				const crossDetails = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger.address)
				const distributeAmount = crossDetails.deallocatedPool > 0n ? crossDetails.deallocatedPool : 0n
				expect(distributeAmount).to.be.greaterThan(0n)

				const reimbursementBefore = await context.viewFacet.partyAReimbursement(context.signers.user.address)

				const distributeTx = await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.applyClearingHouseSettlement(context.signers.hedger.address, [
						{
							account: context.signers.user.address,
							allocationKey: ZeroAddress,
							symbolId: 1n,
							realizedPnl: 0n,
							funding: distributeAmount,
							platformFee: 0n,
						},
					])
				const receipt = await distributeTx.wait()
				const partyAEvents = (receipt?.logs ?? []).flatMap(log => {
					try {
						const parsed = balanceChangeInterface.parseLog({ topics: log.topics as string[], data: log.data })
						if (parsed?.name !== "BalanceChangePartyA") return []
						return [
							{
								partyA: parsed.args.partyA as string,
								amount: parsed.args.amount as bigint,
								changeType: parsed.args._type as bigint,
							},
						]
					} catch {
						return []
					}
				})

				const reimbursementAfter = await context.viewFacet.partyAReimbursement(context.signers.user.address)
				const reimbursementEvents = parsePartyAReimbursementChangeLogs(receipt?.logs ?? []).filter(
					event => event.partyA.toLowerCase() === context.signers.user.address.toLowerCase(),
				)
				expect(reimbursementAfter).to.equal(reimbursementBefore + distributeAmount)
				expect(partyAEvents.filter(event => event.partyA.toLowerCase() === context.signers.user.address.toLowerCase())).to.have.length(0)
				expect(reimbursementEvents).to.deep.equal([
					{
						partyA: context.signers.user.address,
						amount: distributeAmount,
						newBalance: reimbursementAfter,
						changeType: BigInt(ReimbursementChangeType.FUNDING_FEE_IN),
					},
				])
			})

			it("should route a non-market platform fee to reimbursement with its exact classification", async () => {
				const subject = context.signers.hedger.address
				const partyA = context.signers.user.address
				const platformFee = 3n
				const reimbursementBefore = await context.viewFacet.partyAReimbursement(partyA)

				const tx = await context.clearingHouseFacet.connect(context.signers.liquidator).applyClearingHouseSettlement(subject, [
					{
						account: partyA,
						allocationKey: ZeroAddress,
						symbolId: 0n,
						realizedPnl: 0n,
						funding: 0n,
						platformFee,
					},
				])
				const receipt = await tx.wait()

				expect(await context.viewFacet.partyAReimbursement(partyA)).to.equal(reimbursementBefore + platformFee)
				expect(parsePartyAReimbursementChangeLogs(receipt?.logs ?? [])).to.deep.equal([
					{
						partyA,
						amount: platformFee,
						newBalance: reimbursementBefore + platformFee,
						changeType: BigInt(ReimbursementChangeType.PLATFORM_FEE_IN),
					},
				])
				const components = parseClearingHouseSettlementLogs(receipt?.logs ?? []).filter(event => event.name === "ClearingHouseSettlementComponent")
				expect(components.map(event => [event.args.symbolId, event.args.platformFee])).to.deep.equal([[0n, platformFee]])
			})
		})

		describe("Full end-to-end simultaneous liquidation", () => {
			it("should complete both liquidations", async () => {
				// Step 1: Liquidate partyA normally
				const symbolIds = [1n]
				const prices = [decimal(25n)]
				await user.liquidateAndSetSymbolPrices(symbolIds, prices, [1n])

				// Step 2: Start cross partyB liquidation
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.getAddress(), "0x", BigInt("-999999999999999999999999999999"), await getBlockTimestamp())

				// Step 3: Deallocate from cross partyB
				const crossAllocated = (await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger))[0]
				if (crossAllocated > 0n) {
					await applyClearingHousePnlDebits(context.signers.hedger.address, [context.signers.hedger.address], [ZeroAddress], [crossAllocated])
				}

				// Step 4: Liquidate hedger's pending positions for user (triggers auto-takeover)
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.hedger.address, [context.signers.user.address])

				// Verify auto-takeover happened
				const takeoverDetails = await context.viewFacet.getPartyATakeoverDetails(context.signers.user.address)
				expect(takeoverDetails.inProgress).to.equal(true)

				// Step 5: Liquidate open positions (cross partyB flow)
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.hedger.address, [1n], [decimal(1n)])

				// Step 6: Distribute cross partyB pool (if any)
				const crossDetails = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger.address)
				if (crossDetails.deallocatedPool > 0n) {
					await applyClearingHousePnlCredits(
						context.signers.hedger.address,
						[context.signers.user.address],
						[ZeroAddress],
						[crossDetails.deallocatedPool],
					)
				}

				// Step 7: Settle cross partyB
				await context.clearingHouseFacet.connect(context.signers.liquidator).settleCrossPartyBLiquidation(context.signers.hedger.address, [], true)

				// Step 8: Process remaining partyA pending quotes (quotes 3, 4 are SENT, no partyB assigned)
				// These weren't handled by cross partyB flow. Use takeover flow to clear them.
				const remainingPending = await context.viewFacetQuote.getPartyAPendingQuotes(context.signers.user.address)
				if (remainingPending.length > 0) {
					await context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidatePendingPositionsForClearingHouse(context.signers.user.address, [])
				}

				// Step 9: Deallocate and distribute for partyA takeover
				const partyAAllocated = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user.address)
				const reimbursement = await context.viewFacet.partyAReimbursement(context.signers.user.address)
				if (partyAAllocated > 0n) {
					await applyClearingHousePnlDebits(context.signers.user.address, [context.signers.user.address], [ZeroAddress], [partyAAllocated])
					await applyClearingHousePnlCredits(context.signers.user.address, [context.signers.admin.address], [ZeroAddress], [partyAAllocated])
				}
				if (reimbursement > 0n) {
					const REIMBURSEMENT_KEY = "0x0000000000000000000000000000000000000001"
					await applyClearingHousePnlDebits(context.signers.user.address, [context.signers.user.address], [REIMBURSEMENT_KEY], [reimbursement])
					await applyClearingHousePnlCredits(context.signers.user.address, [context.signers.admin.address], [ZeroAddress], [reimbursement])
				}

				// Step 10: Settle partyA takeover
				await context.clearingHouseFacet.connect(context.signers.liquidator).settlePartyATakeover(context.signers.user.address, [])

				// Verify final state
				const liquidationStatus = await context.viewFacet.isPartyALiquidated(context.signers.user.address)
				expect(liquidationStatus).to.equal(false)

				const positionsCount = await context.viewFacetQuote.partyAPositionsCount(context.signers.user.address)
				expect(positionsCount).to.equal(0)

				const pendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(context.signers.user.address)
				expect(pendingQuotes.length).to.equal(0)

				// PartyA can trade again after depositing fresh funds
				await user.setBalances(decimal(2000n), decimal(2000n), decimal(2000n))
				const quoteId = await user.sendQuote(limitQuoteRequestBuilder().build())
				expect(quoteId).to.be.greaterThan(0n)
			})
		})
	})

	// ============================================
	// SOFT LIQUIDATION TESTS
	// ============================================

	describe("SoftLiquidation", () => {
		describe("SoftLiquidation without cross partyB mode enabled", () => {
			beforeEach(async () => {
				await context.controlFacet.connect(context.signers.admin).setSoftLiquidationPenaltyCollector(context.signers.liquidator)
				await context.controlFacet
					.connect(context.signers.admin)
					.grantRole(context.signers.liquidator.address, ethers.keccak256(toUtf8Bytes("SOFT_LIQUIDATOR_ROLE")))
				// Allocate more for non-cross mode tests
				await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(decimal(500n), context.signers.user.address)
				await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(decimal(500n), context.signers.user2.address)
			})

			it("should soft liquidate without penalty", async () => {
				const allocatedBefore = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)
				const hedgerBalanceBefore = await context.viewFacet.balanceOf(context.signers.hedger.address)
				const collectorBalanceBefore = await context.viewFacet.balanceOf(context.signers.liquidator.address)

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.softPartyBLiquidation(context.signers.hedger.address, context.signers.user.address, 0, 0),
				)
					.to.emit(context.clearingHouseFacet, "SoftPartyBLiquidation")
					.withArgs(context.signers.hedger.address, context.signers.user.address, 0, 0)

				// Verify no balances changed when penalty is zero
				expect(await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)).to.equal(
					allocatedBefore,
				)
				expect(await context.viewFacet.balanceOf(context.signers.hedger.address)).to.equal(hedgerBalanceBefore)
				expect(await context.viewFacet.balanceOf(context.signers.liquidator.address)).to.equal(collectorBalanceBefore)
			})

			it("should deduct from partyB allocated balance for specific partyA", async () => {
				const userAddress = await user.getAddress()
				const penaltyFromAllocated = decimal(200n)

				const validator = new SoftPartyBLiquidationValidator()
				const beforeOut = await validator.before(context, {
					hedger,
					partyA: userAddress,
					penaltyFromAllocated,
					penaltyFromBalance: 0n,
				})

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.softPartyBLiquidation(context.signers.hedger.address, context.signers.user.address, penaltyFromAllocated, 0)

				await validator.after(context, {
					hedger,
					partyA: userAddress,
					penaltyFromAllocated,
					penaltyFromBalance: 0n,
					beforeOutput: beforeOut,
				})
			})

			it("should not affect other partyA allocations when deducting from one", async () => {
				const beforeUser2Allocation = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user2.address)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.softPartyBLiquidation(context.signers.hedger.address, context.signers.user.address, decimal(200n), 0)

				const afterUser2Allocation = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user2.address)

				expect(beforeUser2Allocation).to.equal(afterUser2Allocation)
			})

			it("should deduct from both allocated and balance for non-cross partyB", async () => {
				const beforeCollectorBalance = await context.viewFacet.balanceOf(context.signers.liquidator.address)
				const beforeAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)
				const beforeHedgerBalance = await context.viewFacet.balanceOf(context.signers.hedger.address)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.softPartyBLiquidation(context.signers.hedger.address, context.signers.user.address, decimal(100n), decimal(100n))

				const afterCollectorBalance = await context.viewFacet.balanceOf(context.signers.liquidator.address)
				const afterAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)
				const afterHedgerBalance = await context.viewFacet.balanceOf(context.signers.hedger.address)

				expect(beforeAllocatedBalance - afterAllocatedBalance).to.equal(decimal(100n))
				expect(beforeHedgerBalance - afterHedgerBalance).to.equal(decimal(100n))
				expect(afterCollectorBalance - beforeCollectorBalance).to.equal(decimal(200n))
			})

			it("should fail if penalty from allocated exceeds partyA specific allocation", async () => {
				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.softPartyBLiquidation(context.signers.hedger.address, context.signers.user.address, allocatedBalance + 1n, 0),
				).to.be.revertedWith("ClearingHouse: Insufficient Allocated Balance")
			})

			it("should emit event with correct partyA", async () => {
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.softPartyBLiquidation(context.signers.hedger.address, context.signers.user.address, decimal(50n), decimal(50n)),
				)
					.to.emit(context.clearingHouseFacet, "SoftPartyBLiquidation")
					.withArgs(context.signers.hedger.address, context.signers.user.address, decimal(50n), decimal(50n))
			})
		})
		describe("SoftLiquidation with cross partyB mode enabled", () => {
			beforeEach(async () => {
				// Quote1 -> opened
				await hedger.lockQuote(1)
				await hedger.openPosition(1)

				// Quote2 -> locked
				await hedger.lockQuote(2)

				// Quote4 -> opened
				await hedger.lockQuote(4)
				await hedger.openPosition(4)

				// Quote5 -> locked
				await hedger.lockQuote(5)

				await migratePartyBToCross(context, hedger, [1, 2, 4, 5])
			})
			describe("SoftLiquidation in cross partyB mode validation", () => {
				it("should fail to soft liquidate without role", async () => {
					await context.controlFacet.connect(context.signers.admin).setSoftLiquidationPenaltyCollector(context.signers.liquidator)
					await expect(
						context.clearingHouseFacet
							.connect(context.signers.liquidator)
							.softPartyBLiquidation(context.signers.hedger.address, ethers.ZeroAddress, 0, 0),
					).to.revertedWith("Accessibility: Must have role")
				})

				it("should fail to soft liquidate if penalty from allocated is more than allocated balance", async () => {
					await context.controlFacet.connect(context.signers.admin).setSoftLiquidationPenaltyCollector(context.signers.liquidator)
					await context.controlFacet
						.connect(context.signers.admin)
						.grantRole(context.signers.liquidator.address, ethers.keccak256(toUtf8Bytes("SOFT_LIQUIDATOR_ROLE")))
					await expect(
						context.clearingHouseFacet
							.connect(context.signers.liquidator)
							.softPartyBLiquidation(context.signers.hedger.address, ethers.ZeroAddress, ethers.parseEther("3000"), 0),
					).to.revertedWith("ClearingHouse: Insufficient Allocated Balance")
				})

				it("should fail to soft liquidate if penalty from balance is more than balance", async () => {
					await context.controlFacet.connect(context.signers.admin).setSoftLiquidationPenaltyCollector(context.signers.liquidator)
					await context.controlFacet
						.connect(context.signers.admin)
						.grantRole(context.signers.liquidator.address, ethers.keccak256(toUtf8Bytes("SOFT_LIQUIDATOR_ROLE")))
					await expect(
						context.clearingHouseFacet
							.connect(context.signers.liquidator)
							.softPartyBLiquidation(context.signers.hedger.address, ethers.ZeroAddress, 0, ethers.parseEther("3000")),
					).to.revertedWith("ClearingHouse: Insufficient Balance")
				})

				it("should fail to soft liquidate with penalty without collector", async () => {
					await context.controlFacet
						.connect(context.signers.admin)
						.grantRole(context.signers.liquidator.address, ethers.keccak256(toUtf8Bytes("SOFT_LIQUIDATOR_ROLE")))
					await expect(
						context.clearingHouseFacet
							.connect(context.signers.liquidator)
							.softPartyBLiquidation(context.signers.hedger.address, ethers.ZeroAddress, ethers.parseEther("10"), 0),
					).to.revertedWith("ClearingHouse: No Penalty Collector")
				})
			})

			describe("SoftLiquidation happy path", () => {
				beforeEach(async () => {
					await context.controlFacet.connect(context.signers.admin).setSoftLiquidationPenaltyCollector(context.signers.liquidator)
					await context.controlFacet
						.connect(context.signers.admin)
						.grantRole(context.signers.liquidator.address, ethers.keccak256(toUtf8Bytes("SOFT_LIQUIDATOR_ROLE")))
				})

				it("should soft liquidate and emit event correctly", async () => {
					await expect(
						context.clearingHouseFacet
							.connect(context.signers.liquidator)
							.softPartyBLiquidation(context.signers.hedger.address, ethers.ZeroAddress, 0, 0),
					)
						.to.emit(context.clearingHouseFacet, "SoftPartyBLiquidation")
						.withArgs(context.signers.hedger.address, ethers.ZeroAddress, 0, 0)
				})

				it("should change allocated balance in penalty soft liquidate correctly", async () => {
					const beforeLiquidatorBalance = await context.viewFacet.balanceOf(context.signers.liquidator.address)
					const beforeAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, ethers.ZeroAddress)
					await expect(
						context.clearingHouseFacet
							.connect(context.signers.liquidator)
							.softPartyBLiquidation(context.signers.hedger.address, ethers.ZeroAddress, ethers.parseEther("10"), 0),
					).not.reverted
					const afterLiquidatorBalance = await context.viewFacet.balanceOf(context.signers.liquidator.address)
					const afterAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, ethers.ZeroAddress)
					expect(beforeAllocatedBalance - afterAllocatedBalance).to.equal(afterLiquidatorBalance - beforeLiquidatorBalance)
					expect(beforeAllocatedBalance - afterAllocatedBalance).to.equal(ethers.parseEther("10"))
				})

				it("should change balance in penalty soft liquidate correctly", async () => {
					const beforeLiquidatorBalance = await context.viewFacet.balanceOf(context.signers.liquidator.address)
					const beforeHedgerBalance = await context.viewFacet.balanceOf(context.signers.hedger.address)
					await expect(
						context.clearingHouseFacet
							.connect(context.signers.liquidator)
							.softPartyBLiquidation(context.signers.hedger.address, ethers.ZeroAddress, 0, ethers.parseEther("10")),
					).not.reverted
					const afterLiquidatorBalance = await context.viewFacet.balanceOf(context.signers.liquidator.address)
					const afterHedgerBalance = await context.viewFacet.balanceOf(context.signers.hedger.address)
					expect(beforeHedgerBalance - afterHedgerBalance).to.equal(afterLiquidatorBalance - beforeLiquidatorBalance)
					expect(beforeHedgerBalance - afterHedgerBalance).to.equal(ethers.parseEther("10"))
				})

				it("should change both allocated and balance in penalty soft liquidate correctly", async () => {
					const beforeLiquidatorBalance = await context.viewFacet.balanceOf(context.signers.liquidator.address)
					const beforeAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, ethers.ZeroAddress)
					const beforeHedgerBalance = await context.viewFacet.balanceOf(context.signers.hedger.address)
					await expect(
						context.clearingHouseFacet
							.connect(context.signers.liquidator)
							.softPartyBLiquidation(context.signers.hedger.address, ethers.ZeroAddress, ethers.parseEther("5"), ethers.parseEther("5")),
					).not.reverted
					const afterLiquidatorBalance = await context.viewFacet.balanceOf(context.signers.liquidator.address)
					const afterAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, ethers.ZeroAddress)
					const afterHedgerBalance = await context.viewFacet.balanceOf(context.signers.hedger.address)
					expect(beforeAllocatedBalance - afterAllocatedBalance).to.equal(ethers.parseEther("5"))
					expect(beforeHedgerBalance - afterHedgerBalance).to.equal(ethers.parseEther("5"))
					expect(afterLiquidatorBalance - beforeLiquidatorBalance).to.equal(ethers.parseEther("10"))
				})
			})
		})
	})

	/**
	 * DISTRIBUTE FROM LIQUIDATION ESCROW TESTS
	 *
	 * After a LATE/OVERDUE PartyA liquidation settles, pending fees are held in
	 * the liquidation escrow. The clearing house can then distribute these funds
	 * to partyA, partyB, or split between them.
	 */
	it("should escrow pending market fees at the reserved basis", async function () {
		await hedger.lockQuote(1)
		await hedger.openPosition(1)
		await hedger.lockQuote(2)
		await hedger.lockQuote(5)

		const signedMarketPrice = decimal(9n, 17)
		await user.requestToCancelQuote(3)
		const marketQuoteId = await user.sendQuote(marketQuoteRequestBuilder().upnlSig(getDummySingleUpnlAndPriceSig(signedMarketPrice)).build())
		const expectedFeesWithMarket = await getTradingFeeForQuotes(context, [2n, 4n, 5n, marketQuoteId])

		await user.liquidateAndSetSymbolPrices([1n], [decimal(22n)], [1n])
		await user.liquidatePendingPositions()
		await user.liquidatePositions([1])
		await user.settleLiquidation()

		const userAddress = await context.signers.user.getAddress()
		expect(await context.viewFacet.getLiquidationEscrow(userAddress)).to.be.equal(expectedFeesWithMarket)
	})

	describe("Distribute From Liquidation Escrow", async function () {
		let escrowAmount: bigint
		let expectedFees: bigint
		const CLEARING_HOUSE_ROLE = ethers.keccak256(toUtf8Bytes("CLEARING_HOUSE_ROLE"))

		beforeEach(async function () {
			// Lock and open quote 1 (SHORT at price 1, qty 100)
			await hedger.lockQuote(1)
			await hedger.openPosition(1)
			// Lock quotes 2 and 5 (pending positions that generate fees on liquidation)
			await hedger.lockQuote(2)
			await hedger.lockQuote(5)

			// Compute expected fees before liquidation (quotes 2,3,4,5 are pending)
			expectedFees = await getTradingFeeForQuotes(context, [2n, 3n, 4n, 5n])

			// User has 2000 allocated. SHORT at price 1, qty 100.
			// Price 22 on SHORT → UPNL=(1-22)*100=-2100 → solidly OVERDUE
			await user.liquidateAndSetSymbolPrices([1n], [decimal(22n)], [1n])
			expect((await user.getLiquidatedStateOfPartyA())["liquidationType"]).to.be.equal(LiquidationType.OVERDUE)

			await user.liquidatePendingPositions()
			await user.liquidatePositions([1])

			const userAddress = await context.signers.user.getAddress()

			await user.settleLiquidation()

			escrowAmount = await context.viewFacet.getLiquidationEscrow(userAddress)
		})

		it("should have escrow after OVERDUE settlement", async function () {
			const userAddress = await context.signers.user.getAddress()
			expect(escrowAmount).to.be.equal(expectedFees)
			expect(await context.viewFacet.getLiquidationEscrow(userAddress)).to.be.equal(expectedFees)
		})

		it("should distribute escrow to partyA", async function () {
			const userAddress = await context.signers.user.getAddress()
			const balanceBefore = (await user.getBalanceInfo()).allocatedBalances

			await context.clearingHouseFacet
				.connect(context.signers.liquidator)
				.distributeFromLiquidationEscrow(userAddress, [userAddress], [ZeroAddress], [escrowAmount])

			const balanceAfter = (await user.getBalanceInfo()).allocatedBalances
			expect(balanceAfter - balanceBefore).to.be.equal(escrowAmount)
			expect(await context.viewFacet.getLiquidationEscrow(userAddress)).to.be.equal(0n)
		})

		it("should distribute escrow to partyB", async function () {
			const userAddress = await context.signers.user.getAddress()
			const hedgerAddress = await context.signers.hedger.getAddress()
			const balanceBefore = await context.viewFacet.allocatedBalanceOfPartyB(hedgerAddress, userAddress)

			await context.clearingHouseFacet
				.connect(context.signers.liquidator)
				.distributeFromLiquidationEscrow(userAddress, [hedgerAddress], [userAddress], [escrowAmount])

			const balanceAfter = await context.viewFacet.allocatedBalanceOfPartyB(hedgerAddress, userAddress)
			expect(balanceAfter - balanceBefore).to.be.equal(escrowAmount)
			expect(await context.viewFacet.getLiquidationEscrow(userAddress)).to.be.equal(0n)
		})

		it("should distribute escrow to multiple receivers", async function () {
			const userAddress = await context.signers.user.getAddress()
			const hedgerAddress = await context.signers.hedger.getAddress()
			const half = escrowAmount / 2n
			const remainder = escrowAmount - half

			const userBalanceBefore = (await user.getBalanceInfo()).allocatedBalances
			const hedgerBalanceBefore = await context.viewFacet.allocatedBalanceOfPartyB(hedgerAddress, userAddress)

			await context.clearingHouseFacet
				.connect(context.signers.liquidator)
				.distributeFromLiquidationEscrow(userAddress, [userAddress, hedgerAddress], [ZeroAddress, userAddress], [half, remainder])

			expect((await user.getBalanceInfo()).allocatedBalances - userBalanceBefore).to.be.equal(half)
			expect((await context.viewFacet.allocatedBalanceOfPartyB(hedgerAddress, userAddress)) - hedgerBalanceBefore).to.be.equal(remainder)
			expect(await context.viewFacet.getLiquidationEscrow(userAddress)).to.be.equal(0n)
		})

		it("should fail without CLEARING_HOUSE_ROLE", async function () {
			const userAddress = await context.signers.user.getAddress()
			await expect(
				context.clearingHouseFacet
					.connect(context.signers.user)
					.distributeFromLiquidationEscrow(userAddress, [userAddress], [ZeroAddress], [escrowAmount]),
			).to.be.revertedWith("Accessibility: Must have role")
		})

		it("should fail when distributing more than escrow balance", async function () {
			const userAddress = await context.signers.user.getAddress()
			await expect(
				context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.distributeFromLiquidationEscrow(userAddress, [userAddress], [ZeroAddress], [escrowAmount + 1n]),
			).to.be.revertedWith("ClearingHouseFacet: Insufficient pool balance")
		})

		it("should emit DistributeFromLiquidationEscrow event", async function () {
			const userAddress = await context.signers.user.getAddress()
			await expect(
				context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.distributeFromLiquidationEscrow(userAddress, [userAddress], [ZeroAddress], [escrowAmount]),
			).to.emit(context.clearingHouseFacet, "DistributeFromLiquidationEscrow")
		})
	})
}
