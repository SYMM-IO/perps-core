import { expect } from "chai"
import { ethers, toUtf8Bytes, ZeroAddress } from "ethers"

import type { QuoteStructOutput } from "../src/types/interfaces/ISymmio.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { PositionType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
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
import { decimal, getPriceFetcher } from "./utils/Common.js"
import { migratePartyBToCross } from "./utils/CrossPartyB.js"
import { getDummyCrossLiquidationSig, getDummyLiquidationSig } from "./utils/SignatureUtils.js"

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
						.liquidateCrossPartyB(context.signers.hedger.address, await getDummyCrossLiquidationSig()),
				).to.be.revertedWith("Accessibility: Must have role")
			})

			it("Should succeed when caller has CLEARING_HOUSE_ROLE", async function () {
				await context.controlFacet
					.connect(context.signers.admin)
					.grantRole(context.signers.user2.address, ethers.keccak256(toUtf8Bytes("CLEARING_HOUSE_ROLE")))

				// Activate cross mode for hedger
				await migratePartyBToCross(context, hedger, [1, 2, 4, 5])

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.user2)
						.liquidateCrossPartyB(
							context.signers.hedger.address,
							await getDummyCrossLiquidationSig(undefined, BigInt("-999999999999999999999999999999")),
						),
				).to.not.be.reverted
			})

			it("Should fail when liquidation is paused", async function () {
				await context.pauseControlFacet.connect(context.signers.admin).pauseLiquidation()

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidateCrossPartyB(context.signers.hedger.address, await getDummyCrossLiquidationSig()),
				).to.be.revertedWith("Pausable: Liquidation paused")
			})

			it("Should fail when globally paused", async function () {
				await context.pauseControlFacet.connect(context.signers.admin).pauseGlobal()

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidateCrossPartyB(context.signers.hedger.address, await getDummyCrossLiquidationSig()),
				).to.be.revertedWith("Pausable: Global paused")
			})
		})
	})

	describe("liquidateCrossPartyB", async function () {
		it("Should fail when partyB CrossMode not active", async function () {
			await expect(
				context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.getAddress(), await getDummyCrossLiquidationSig()),
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
						.liquidateCrossPartyB(await context.signers.hedger.getAddress(), await getDummyCrossLiquidationSig(undefined, decimal(1000n))),
				).to.be.revertedWith("ClearingHouseFacet: partyB is solvent")
			})

			it("Should cross liquidate partyB successfully", async function () {
				const validator = new LiquidateCrossPartyBValidator()
				const upnl = BigInt("-999999999999999999999999999999")
				const beforeOut = await validator.before(context, { hedger })
				const liquidationSig = await getDummyCrossLiquidationSig(undefined, upnl)

				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).liquidateCrossPartyB(context.signers.hedger.getAddress(), liquidationSig),
				).to.not.reverted

				await validator.after(context, { hedger, upnl, beforeOutput: beforeOut })

				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger)).to.equal(true)
				const details = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)

				expect(details.liquidationId).to.equal("0x")
				expect(details.upnl).to.equal(upnl)
				expect(details.deallocatedPool).to.equal(0)
			})

			it("Should fail to cross liquidate a partyB twice", async function () {
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(
						context.signers.hedger.getAddress(),
						await getDummyCrossLiquidationSig(undefined, BigInt("-999999999999999999999999999999")),
					)

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidateCrossPartyB(
							context.signers.hedger.getAddress(),
							await getDummyCrossLiquidationSig(undefined, BigInt("-999999999999999999999999999999")),
						),
				).to.revertedWith("Accessibility: PartyB isn't solvent")
			})
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
			await expect(
				context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.deallocateForClearingHouse(context.signers.hedger, [context.signers.hedger], [ZeroAddress], [100n]),
			).to.revertedWith("ClearingHouseFacet: No active liquidation")
		})

		describe("After PartyB Liquidation", () => {
			beforeEach(async () => {
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(
						context.signers.hedger.getAddress(),
						await getDummyCrossLiquidationSig(undefined, BigInt("-999999999999999999999999999999")),
					)
			})

			it("should fail when deallocated amount be more than partyB allocation", async () => {
				const allocated = (await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger))[0]
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.deallocateForClearingHouse(context.signers.hedger, [context.signers.hedger], [ZeroAddress], [allocated + BigInt(10)]),
				).to.revertedWith("ClearingHouseFacet: Insufficient allocated balance")
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

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.deallocateForClearingHouse(context.signers.hedger, [context.signers.hedger], [ZeroAddress], [OldAllocated]),
				).to.not.reverted

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

			it("should deallocate for multiple partyAs in batch", async () => {
				const OldAllocatedCross = (await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger))[0]

				const deallocateAmount1 = OldAllocatedCross / 4n
				const deallocateAmount2 = OldAllocatedCross / 4n

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.deallocateForClearingHouse(
							context.signers.hedger,
							[context.signers.hedger, context.signers.hedger],
							[ZeroAddress, ZeroAddress],
							[deallocateAmount1, deallocateAmount2],
						),
				).to.not.reverted

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
					.liquidateCrossPartyB(
						context.signers.hedger.getAddress(),
						await getDummyCrossLiquidationSig(undefined, BigInt("-999999999999999999999999999999")),
					)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.deallocateForClearingHouse(context.signers.hedger, [context.signers.hedger], [ZeroAddress], [1000n])
			})

			it("should fail when amount be more than deallocated for liquidation", async () => {
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.distributeForClearingHouse(context.signers.hedger, [context.signers.user], [ZeroAddress], [1001n]),
				).to.revertedWith("ClearingHouseFacet: Insufficient deallocated balance")
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

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.distributeForClearingHouse(context.signers.hedger, [context.signers.user], [ZeroAddress], [transferAmount]),
				).to.not.reverted

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

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.distributeForClearingHouse(context.signers.hedger, [context.signers.user], [ZeroAddress], [partialAmount])

				const detailsAfter = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)
				expect(detailsAfter.deallocatedPool).to.equal(detailsBefore.deallocatedPool - partialAmount)
			})

			it("should fail when partyB is not liquidated", async () => {
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.distributeForClearingHouse(context.signers.hedger2, [context.signers.user], [ZeroAddress], [1n]),
				).to.be.revertedWith("ClearingHouseFacet: No active liquidation")
			})
		})

		describe("liquidatePendingPositionsForClearingHouse (Cross PartyB)", () => {
			beforeEach(async () => {
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(
						context.signers.hedger.getAddress(),
						await getDummyCrossLiquidationSig(undefined, BigInt("-999999999999999999999999999999")),
					)
			})

			it("should liquidate pending quotes successfully", async () => {
				const hedgerAddress = await hedger.getAddress()
				const userAddress = await user.getAddress()
				const oldUserPendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(context.signers.user)
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
				).to.not.reverted

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
			})

			it("should liquidate pending quotes for multiple partyAs in batch", async () => {
				const oldUserPendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(context.signers.user)
				const oldUser2PendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(context.signers.user2)

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidatePendingPositionsForClearingHouse(context.signers.hedger, [context.signers.user, context.signers.user2]),
				).to.not.reverted

				const newUserPendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(context.signers.user)
				const newUser2PendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(context.signers.user2)

				expect(newUserPendingQuotes.length).to.be.lessThanOrEqual(oldUserPendingQuotes.length)
				expect(newUser2PendingQuotes.length).to.be.lessThanOrEqual(oldUser2PendingQuotes.length)
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
					.liquidateCrossPartyB(
						context.signers.hedger.getAddress(),
						await getDummyCrossLiquidationSig(undefined, BigInt("-999999999999999999999999999999")),
					)
			})

			it("should liquidate cross positions successfully", async () => {
				const hedgerAddress = await hedger.getAddress()
				const validator = new LiquidatePositionsCHValidator()
				const beforeOut = await validator.before(context, {
					subject: hedgerAddress,
					quoteIds: [1n],
				})

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidatePositionsForClearingHouse(context.signers.hedger, [1n], [decimal(1n)]),
				).to.not.reverted

				await validator.after(context, {
					subject: hedgerAddress,
					quoteIds: [1n],
					prices: [decimal(1n)],
					beforeOutput: beforeOut,
				})

				const quote1: QuoteStructOutput = await context.viewFacetQuote.getQuote(1)

				expect(quote1.quoteStatus).to.equal(QuoteStatus.LIQUIDATED)
			})

			it("should fail when partyB is not liquidated", async () => {
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidatePositionsForClearingHouse(context.signers.hedger2, [1n], [decimal(1n)]),
				).to.be.revertedWith("ClearingHouseFacet: No active liquidation")
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
					.liquidateCrossPartyB(await hedger2.getAddress(), await getDummyCrossLiquidationSig(undefined, -decimal(1_000_000n)))

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(hedger2.address, [quoteUser1.id, quoteUser2.id], [quoteUser1.openedPrice, quoteUser2.openedPrice])

				// Use validator to verify settle cross partyB
				const settleValidator = new SettleCrossPartyBValidator()
				const settleBeforeOut = await settleValidator.before(context, { hedger: hedger2 })

				// Explicitly settle the cross partyB liquidation
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.settleCrossPartyBLiquidation(hedger2.address)

				await settleValidator.after(context, { hedger: hedger2, beforeOutput: settleBeforeOut })

				const crossBucketAfter = await hedger2.getBalanceInfoCrossPartyB()

				expect(crossBucketAfter.lockedCva).to.equal(0)
				expect(crossBucketAfter.lockedLf).to.equal(0)
				expect(crossBucketAfter.lockedMmPartyB).to.equal(0)

				const nonceAfter = await context.viewFacet.nonceOfPartyB(await hedger2.getAddress(), ZeroAddress)
				expect(nonceAfter).to.be.greaterThan(nonceBefore)
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

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.deallocateForClearingHouse(context.signers.user.address, [context.signers.user.address], [ZeroAddress], [pullAmount])

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

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.deallocateForClearingHouse(context.signers.user.address, [context.signers.hedger.address], [context.signers.user.address], [pullAmount])

				const isolatedBalanceAfter = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)
				expect(isolatedBalanceAfter).to.equal(isolatedBalanceBefore - pullAmount)
			})

			it("should fail with insufficient allocated balance", async () => {
				const balance = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user.address)
				const excessiveAmount = balance + 1n

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.deallocateForClearingHouse(context.signers.user.address, [context.signers.user.address], [ZeroAddress], [excessiveAmount]),
				).to.be.revertedWith("ClearingHouseFacet: Insufficient allocated balance")
			})

			it("should fail with invalid allocation key for partyA", async () => {
				// address(0) = allocatedBalances, address(1) = partyAReimbursement, anything else is invalid
				const invalidKey = "0x0000000000000000000000000000000000000002"

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.deallocateForClearingHouse(context.signers.user.address, [context.signers.user.address], [invalidKey], [100n]),
				).to.be.revertedWith("ClearingHouseFacet: Invalid allocation key for partyA")
			})

			it("should pull from multiple sources in batch", async () => {
				const partyABalanceBefore = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user.address)
				const partyBIsolatedBefore = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)

				const amountFromPartyA = 50n
				const amountFromPartyB = 100n

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.deallocateForClearingHouse(
						context.signers.user.address,
						[context.signers.user.address, context.signers.hedger.address],
						[ZeroAddress, context.signers.user.address],
						[amountFromPartyA, amountFromPartyB],
					)

				const partyABalanceAfter = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user.address)
				const partyBIsolatedAfter = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)

				expect(partyABalanceAfter).to.equal(partyABalanceBefore - amountFromPartyA)
				expect(partyBIsolatedAfter).to.equal(partyBIsolatedBefore - amountFromPartyB)
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
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.deallocateForClearingHouse(context.signers.user.address, [context.signers.hedger.address], [context.signers.user.address], [1000n])
			})

			it("should distribute to receivers successfully", async () => {
				const receiverBalanceBefore = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user2.address)
				const distributeAmount = 500n

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.distributeForClearingHouse(context.signers.user.address, [context.signers.user2.address], [ZeroAddress], [distributeAmount])

				const receiverBalanceAfter = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user2.address)
				expect(receiverBalanceAfter).to.equal(receiverBalanceBefore + distributeAmount)
			})

			it("should fail when distributing more than deallocated pool", async () => {
				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).distributeForClearingHouse(
						context.signers.user.address,
						[context.signers.user2.address],
						[ZeroAddress],
						[2000n], // More than what was deallocated
					),
				).to.be.revertedWith("ClearingHouseFacet: Insufficient deallocated balance")
			})

			it("should distribute to multiple receivers", async () => {
				const receiver1Before = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user2.address)
				// hedger is a partyB, so check their partyB allocated balance (isolated with user)
				const receiver2Before = await context.viewFacet.allocatedBalanceOfPartyB(
					context.signers.hedger.address,
					context.signers.user.address,
				)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.distributeForClearingHouse(
						context.signers.user.address,
						[context.signers.user2.address, context.signers.hedger.address],
						[ZeroAddress, context.signers.user.address], // user2 is partyA (key ignored), hedger is partyB (isolated with user)
						[300n, 400n],
					)

				const receiver1After = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user2.address)
				const receiver2After = await context.viewFacet.allocatedBalanceOfPartyB(
					context.signers.hedger.address,
					context.signers.user.address,
				)

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

				const validator = new LiquidatePendingCHValidator()
				const beforeOut = await validator.before(context, {
					subject: userAddress,
					counterparties: [],
					isCrossPartyB: false,
				})

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.user.address, []) // counterparties ignored for partyA takeover

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

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.user.address, [1n], [decimal(25n)])

				await validator.after(context, {
					subject: userAddress,
					quoteIds: [1n],
					prices: [decimal(25n)],
					beforeOutput: beforeOut,
				})

				const quote1After = await context.viewFacetQuote.getQuote(1)
				expect(quote1After.quoteStatus).to.equal(QuoteStatus.LIQUIDATED)
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
					.liquidateCrossPartyB(
						context.signers.hedger.address,
						await getDummyCrossLiquidationSig(undefined, BigInt("-999999999999999999999999999999")),
					)

				// Now try to liquidate positions - should fail since partyB is in cross liquidation
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidatePositionsForClearingHouse(context.signers.user.address, [1n], [decimal(25n)]),
				).to.be.revertedWith("ClearingHouseFacet: PartyB is in cross liquidation process")
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
					await context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.deallocateForClearingHouse(
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

				await context.clearingHouseFacet.connect(context.signers.liquidator).settlePartyATakeover(context.signers.user.address, [])

				await validator.after(context, { user, settledPartyBs: [], beforeOutput: beforeOut })

				const statusAfter = await context.viewFacet.isPartyALiquidated(context.signers.user.address)
				expect(statusAfter).to.equal(false)
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
					await context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.deallocateForClearingHouse(
							context.signers.user.address,
							[context.signers.hedger.address],
							[context.signers.user.address],
							[partyBIsolated],
						)

					// Step 6: Distribute ALL funds to receivers (must distribute everything before settle)
					await context.clearingHouseFacet.connect(context.signers.liquidator).distributeForClearingHouse(
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
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.softPartyBLiquidation(context.signers.hedger.address, context.signers.user.address, 0, 0),
				).not.to.be.reverted
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
}
