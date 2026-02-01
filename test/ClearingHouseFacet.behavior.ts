
import { expect } from "chai"
import { ethers, toUtf8Bytes, ZeroAddress } from "ethers"
import { initializeFixture } from "./Initialize.fixture.js"
import { PositionType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal } from "./utils/Common.js"
import { getDummyCrossLiquidationSig, getDummyPriceSig } from "./utils/SignatureUtils.js"
import { migratePartyBToCross } from "./utils/CrossPartyB.js"
import type { QuoteStructOutput } from "../src/types/interfaces/ISymmio.js"
import { loadFixture } from "./helpers/network-helpers.js"

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
				const liquidationSig = await getDummyCrossLiquidationSig(undefined, BigInt("-999999999999999999999999999999"))

				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).liquidateCrossPartyB(context.signers.hedger.getAddress(), liquidationSig),
				).to.not.reverted

				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger)).to.equal(true)
				const details = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)

				expect(details.liquidationId).to.equal("0x")
				expect(details.upnl).to.equal(BigInt("-999999999999999999999999999999"))
				expect(details.deallocateForLiquidation).to.equal(0)
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

	describe("deallocateForCrossLiquidation", () => {
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

		it("should failed when partyB not marked as cross liquid", async () => {
			await expect(
				context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.deallocateForCrossLiquidation(context.signers.hedger, [context.signers.user], [100n]),
			).to.revertedWith("ClearingHouseFacet: PartyB is solvent")
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

			it("should failed when deallocated amount be more than partyB allocation for for partyA", async () => {
				const allocated = (await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger))[0]
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.deallocateForCrossLiquidation(context.signers.hedger, [context.signers.user], [allocated + BigInt(10)]),
				).to.revertedWith("ClearingHouseFacet: Insufficient allocated balance")
			})

			it("should deallocated amount successfully", async () => {
				const OldAllocated = (await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger))[0]
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.deallocateForCrossLiquidation(context.signers.hedger, [context.signers.user], [OldAllocated]),
				).to.not.reverted

				const newAllocated = (await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger))[0]
				const d = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)
				expect(newAllocated).to.equal(0)
				expect(d.deallocateForLiquidation).to.equal(OldAllocated)
			})

			it("should deallocate for multiple partyAs in batch", async () => {
				const OldAllocatedCross = (await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger))[0]

				const deallocateAmount1 = OldAllocatedCross / 4n
				const deallocateAmount2 = OldAllocatedCross / 4n

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.deallocateForCrossLiquidation(
							context.signers.hedger,
							[context.signers.user, context.signers.user2],
							[deallocateAmount1, deallocateAmount2],
						),
				).to.not.reverted

				const newAllocatedCross = (await context.viewFacet.balanceInfoOfCrossPartyB(context.signers.hedger))[0]
				const d = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)

				expect(newAllocatedCross).to.equal(OldAllocatedCross - deallocateAmount1 - deallocateAmount2)
				expect(d.deallocateForLiquidation).to.equal(deallocateAmount1 + deallocateAmount2)
			})
		})

		describe("distribute", () => {
			beforeEach(async () => {
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(
						context.signers.hedger.getAddress(),
						await getDummyCrossLiquidationSig(undefined, BigInt("-999999999999999999999999999999")),
					)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.deallocateForCrossLiquidation(context.signers.hedger, [context.signers.user], [1000n])
			})

			it("should fail when amount be more than deallocated for liquidation", async () => {
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.distributeForCrossLiquidation(context.signers.hedger, [context.signers.user], [1001n]),
				).to.revertedWith("ClearingHouseFacet: Insufficient allocated balance")
			})

			it("should distribute to receiver successfully", async () => {
				const oldAllocation = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user)
				const transferAmount = 1000n

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.distributeForCrossLiquidation(context.signers.hedger, [context.signers.user], [transferAmount]),
				).to.not.reverted

				const details = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)
				const newAllocation = await context.viewFacet.allocatedBalanceOfPartyA(context.signers.user)

				expect(details.deallocateForLiquidation).to.equal(0)
				expect(newAllocation).to.equal(oldAllocation + transferAmount)
			})

			it("should handle partial distributions correctly", async () => {
				const partialAmount = 500n
				const detailsBefore = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.distributeForCrossLiquidation(context.signers.hedger, [context.signers.user], [partialAmount])

				const detailsAfter = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)
				expect(detailsAfter.deallocateForLiquidation).to.equal(detailsBefore.deallocateForLiquidation - partialAmount)
			})

			it("should fail when partyB is not liquidated", async () => {
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.distributeForCrossLiquidation(context.signers.hedger2, [context.signers.user], [1n]),
				).to.be.revertedWith("ClearingHouseFacet: PartyB is solvent")
			})
		})

		describe("liquidatePendingQuotes", () => {
			beforeEach(async () => {
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(
						context.signers.hedger.getAddress(),
						await getDummyCrossLiquidationSig(undefined, BigInt("-999999999999999999999999999999")),
					)
			})

			it("should liquidate pending quotes successfully", async () => {
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

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidatePendingPositionsForCrossLiquidation(context.signers.hedger, [context.signers.user]),
				).to.not.reverted

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

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.liquidatePendingPositionsForCrossLiquidation(context.signers.hedger, [context.signers.user, context.signers.user2]),
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
						.liquidatePendingPositionsForCrossLiquidation(context.signers.hedger2, [context.signers.user]),
				).to.be.revertedWith("ClearingHouseFacet: PartyB is solvent")
			})
		})

		describe("liquidateCrossPositionsPartyB", () => {
			beforeEach(async () => {
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(
						context.signers.hedger.getAddress(),
						await getDummyCrossLiquidationSig(undefined, BigInt("-999999999999999999999999999999")),
					)
			})

			it("should liquidate cross positions successfully", async () => {
				const priceSig = await getDummyPriceSig([1n], [decimal(1n)])

				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).liquidatePositionsForCrossLiquidation(context.signers.hedger, priceSig),
				).to.not.reverted

				const quote1: QuoteStructOutput = await context.viewFacetQuote.getQuote(1)

				expect(quote1.quoteStatus).to.equal(QuoteStatus.LIQUIDATED)
			})

			it("should fail when partyB is not liquidated", async () => {
				const priceSig = await getDummyPriceSig([1n], [decimal(1n)])

				await expect(
					context.clearingHouseFacet.connect(context.signers.liquidator).liquidatePositionsForCrossLiquidation(context.signers.hedger2, priceSig),
				).to.be.revertedWith("ClearingHouseFacet: PartyB is solvent")
			})

			it("should update position statuses correctly", async () => {
				const priceSig = await getDummyPriceSig([1n, 4n], [decimal(1n), decimal(1n)])

				const quote1Before: QuoteStructOutput = await context.viewFacetQuote.getQuote(1)
				const quote4Before: QuoteStructOutput = await context.viewFacetQuote.getQuote(4)

				expect(quote1Before.quoteStatus).to.equal(QuoteStatus.OPENED)
				expect(quote4Before.quoteStatus).to.equal(QuoteStatus.OPENED)

				await context.clearingHouseFacet.connect(context.signers.liquidator).liquidatePositionsForCrossLiquidation(context.signers.hedger, priceSig)

				const quote1After: QuoteStructOutput = await context.viewFacetQuote.getQuote(1)
				const quote4After: QuoteStructOutput = await context.viewFacetQuote.getQuote(4)

				expect(quote1After.quoteStatus).to.equal(QuoteStatus.LIQUIDATED)
				expect(quote4After.quoteStatus).to.equal(QuoteStatus.LIQUIDATED)
			})

			it("should clear the Party A to B connection after the final position is cross-liquidated", async () => {
				expect(await context.viewFacetSymbol.isConnectedPartyB(user.address, hedger.address)).to.equal(true)

				const priceSig1 = await getDummyPriceSig([1n], [decimal(1n)])
				await context.clearingHouseFacet.connect(context.signers.liquidator).liquidatePositionsForCrossLiquidation(context.signers.hedger, priceSig1)

				expect(await context.viewFacetSymbol.isConnectedPartyB(user.address, hedger.address)).to.equal(true)

				const priceSig2 = await getDummyPriceSig([4n], [decimal(1n)])
				await context.clearingHouseFacet.connect(context.signers.liquidator).liquidatePositionsForCrossLiquidation(context.signers.hedger, priceSig2)

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
					.liquidateCrossPartyB(await hedger2.getAddress(), await getDummyCrossLiquidationSig(undefined, -decimal(1_000_000n)))

				const priceSig = await getDummyPriceSig([quoteUser1.id, quoteUser2.id], [quoteUser1.openedPrice, quoteUser2.openedPrice])
				await context.clearingHouseFacet.connect(context.signers.liquidator).liquidatePositionsForCrossLiquidation(hedger2.address, priceSig)

				const crossBucketAfter = await hedger2.getBalanceInfoCrossPartyB()

				expect(crossBucketAfter.lockedCva).to.equal(0)
				expect(crossBucketAfter.lockedLf).to.equal(0)
				expect(crossBucketAfter.lockedMmPartyB).to.equal(0)

				const nonceAfter = await context.viewFacet.nonceOfPartyB(await hedger2.getAddress(), ZeroAddress)
				expect(nonceAfter).to.be.greaterThan(nonceBefore)
			})
		})
	})

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
				const beforeCollectorBalance = await context.viewFacet.balanceOf(context.signers.liquidator.address)
				const beforeAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.softPartyBLiquidation(context.signers.hedger.address, context.signers.user.address, decimal(200n), 0)

				const afterCollectorBalance = await context.viewFacet.balanceOf(context.signers.liquidator.address)
				const afterAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, context.signers.user.address)

				expect(beforeAllocatedBalance - afterAllocatedBalance).to.equal(decimal(200n))
				expect(afterCollectorBalance - beforeCollectorBalance).to.equal(decimal(200n))
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
