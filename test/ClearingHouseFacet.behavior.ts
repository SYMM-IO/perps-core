
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
import { migratePartyBToMaster } from "./utils/MasterAccount.js"
import type { QuoteStructOutput } from "../src/types/interfaces/ISymmio"
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
		await context.accountFacet.connect(context.signers.hedger).allocateForPartyB(1000n, user.address)
		await context.accountFacet.connect(context.signers.hedger).allocateForPartyB(1000n, user2.address)
		await context.accountFacet.connect(context.signers.hedger).allocateForPartyB(2000n, ZeroAddress)
		await context.accountFacet.connect(context.signers.hedger2).allocateForPartyB(2000n, ZeroAddress)

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

	describe("None master account mode", async function () {
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
				).to.be.revertedWith("Accessibility: Must has role")
			})

			it("Should succeed when caller has CLEARING_HOUSE_ROLE", async function () {
				await context.controlFacet
					.connect(context.signers.admin)
					.grantRole(context.signers.user2.address, ethers.keccak256(toUtf8Bytes("CLEARING_HOUSE_ROLE")))

				// Activate master mode for hedger
				await migratePartyBToMaster(context, hedger, [1, 2, 4, 5])

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
		it("Should fail when partyB MasterMode not active", async function () {
			await expect(
				context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.getAddress(), await getDummyCrossLiquidationSig()),
			).to.be.revertedWith("ClearingHouseFacet: partyB is not using master account mode")
		})

		describe("With Master Mode Active", () => {
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

				await migratePartyBToMaster(context, hedger, [1, 2, 4, 5])
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

			await migratePartyBToMaster(context, hedger, [1, 2, 4, 5])
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
				const allocated = (await context.viewFacet.balanceInfoOfPartyBMasterAccount(context.signers.hedger))[0]
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.deallocateForCrossLiquidation(context.signers.hedger, [context.signers.user], [allocated + BigInt(10)]),
				).to.revertedWith("ClearingHouseFacet: Insufficient allocated balance")
			})

			it("should deallocated amount successfully", async () => {
				const OldAllocated = (await context.viewFacet.balanceInfoOfPartyBMasterAccount(context.signers.hedger))[0]
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.deallocateForCrossLiquidation(context.signers.hedger, [context.signers.user], [OldAllocated]),
				).to.not.reverted

				const newAllocated = (await context.viewFacet.balanceInfoOfPartyBMasterAccount(context.signers.hedger))[0]
				const d = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)
				expect(newAllocated).to.equal(0)
				expect(d.deallocateForLiquidation).to.equal(OldAllocated)
			})

			it("should deallocate for multiple partyAs in batch", async () => {
				const OldAllocatedMaster = (await context.viewFacet.balanceInfoOfPartyBMasterAccount(context.signers.hedger))[0]

				const deallocateAmount1 = OldAllocatedMaster / 4n
				const deallocateAmount2 = OldAllocatedMaster / 4n

				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.deallocateForCrossLiquidation(
							context.signers.hedger,
							[context.signers.user, context.signers.user2],
							[deallocateAmount1, deallocateAmount2],
						),
				).to.not.reverted

				const newAllocatedMaster = (await context.viewFacet.balanceInfoOfPartyBMasterAccount(context.signers.hedger))[0]
				const d = await context.viewFacet.getCrossLiquidationDetails(context.signers.hedger)

				expect(newAllocatedMaster).to.equal(OldAllocatedMaster - deallocateAmount1 - deallocateAmount2)
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
		})

		describe("Shared master bucket state", () => {
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

				await migratePartyBToMaster(context, hedger2, [quoteUser1.id, quoteUser2.id])

				await context.controlFacet
					.connect(context.signers.admin)
					.grantRole(context.signers.liquidator.address, ethers.keccak256(toUtf8Bytes("CLEARING_HOUSE_ROLE")))
			})

			it("clears shared locked/pending bucket and bumps shared nonce after full liquidation", async () => {
				const masterBucketBefore = await hedger2.getBalanceInfoMasterAccount()

				expect(masterBucketBefore.lockedCva).to.be.greaterThan(0)
				expect(masterBucketBefore.lockedLf).to.be.greaterThan(0)
				expect(masterBucketBefore.lockedMmPartyB).to.be.greaterThan(0)

				const nonceBefore = await context.viewFacet.nonceOfPartyB(await hedger2.getAddress(), ZeroAddress)

				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(await hedger2.getAddress(), await getDummyCrossLiquidationSig(undefined, -decimal(1_000_000n)))

				const priceSig = await getDummyPriceSig([quoteUser1.id, quoteUser2.id], [quoteUser1.openedPrice, quoteUser2.openedPrice])
				await context.clearingHouseFacet.connect(context.signers.liquidator).liquidatePositionsForCrossLiquidation(hedger2.address, priceSig)

				const masterBucketAfter = await hedger2.getBalanceInfoMasterAccount()

				expect(masterBucketAfter.lockedCva).to.equal(0)
				expect(masterBucketAfter.lockedLf).to.equal(0)
				expect(masterBucketAfter.lockedMmPartyB).to.equal(0)

				const nonceAfter = await context.viewFacet.nonceOfPartyB(await hedger2.getAddress(), ZeroAddress)
				expect(nonceAfter).to.be.greaterThan(nonceBefore)
			})
		})
	})

	describe("SoftLiquidation", () => {
		describe("SoftLiquidation without master account mode enabled", () => {
			it("should fail to soft liquidate without active master account mode", async () => {
				await context.controlFacet.connect(context.signers.admin).setSoftLiquidationPenaltyCollector(context.signers.liquidator)
				await context.controlFacet
					.connect(context.signers.admin)
					.grantRole(context.signers.liquidator.address, ethers.keccak256(toUtf8Bytes("SOFT_LIQUIDATOR_ROLE")))
				await expect(
					context.clearingHouseFacet
						.connect(context.signers.liquidator)
						.softPartyBLiquidation(context.signers.hedger.address, ethers.parseEther("100"), 0),
				).to.revertedWith("ClearingHouseFacet: partyB is not using master account mode")
			})
		})
		describe("SoftLiquidation with master account mode enabled", () => {
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

				await migratePartyBToMaster(context, hedger, [1, 2, 4, 5])
			})
			describe("SoftLiquidation in none master account mode", () => {
				it("should fail to soft liquidate without role", async () => {
					await context.controlFacet.connect(context.signers.admin).setSoftLiquidationPenaltyCollector(context.signers.liquidator)
					await expect(
						context.clearingHouseFacet
							.connect(context.signers.liquidator)
							.softPartyBLiquidation(context.signers.hedger.address, ethers.parseEther("100"), 0),
					).to.revertedWith("Accessibility: Must has role")
				})

				it("should fail to soft liquid if penalty is more than balance", async () => {
					await context.controlFacet.connect(context.signers.admin).setSoftLiquidationPenaltyCollector(context.signers.liquidator)
					await context.controlFacet
						.connect(context.signers.admin)
						.grantRole(context.signers.liquidator.address, ethers.keccak256(toUtf8Bytes("SOFT_LIQUIDATOR_ROLE")))
					await expect(
						context.clearingHouseFacet
							.connect(context.signers.liquidator)
							.softPartyBLiquidation(context.signers.hedger.address, ethers.parseEther("100"), ethers.parseEther("2000")),
					).to.revertedWith("ClearingHouse: Insufficient Balance")
				})

				it("should fail to soft liquid with penalty without collector", async () => {
					await context.controlFacet
						.connect(context.signers.admin)
						.grantRole(context.signers.liquidator.address, ethers.keccak256(toUtf8Bytes("SOFT_LIQUIDATOR_ROLE")))
					await expect(
						context.clearingHouseFacet
							.connect(context.signers.liquidator)
							.softPartyBLiquidation(context.signers.hedger.address, ethers.parseEther("100"), ethers.parseEther("10")),
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
							.softPartyBLiquidation(context.signers.hedger.address, ethers.parseEther("100"), 0),
					)
						.to.emit(context.clearingHouseFacet, "SoftPartyBLiquidation")
						.withArgs(context.signers.hedger.address, ethers.parseEther("100"), 0)
				})

				it("should change balance in penalty soft liquidate correctly", async () => {
					const beforeLiquidatorBalance = await context.viewFacet.balanceOf(context.signers.liquidator.address)
					const beforeAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, ethers.ZeroAddress)
					await expect(
						context.clearingHouseFacet
							.connect(context.signers.liquidator)
							.softPartyBLiquidation(context.signers.hedger.address, ethers.parseEther("100"), ethers.parseEther("10")),
					).not.reverted
					const afterLiquidatorBalance = await context.viewFacet.balanceOf(context.signers.liquidator.address)
					const afterAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyB(context.signers.hedger.address, ethers.ZeroAddress)
					expect(beforeAllocatedBalance - afterAllocatedBalance).to.equal(afterLiquidatorBalance - beforeLiquidatorBalance)
					expect(beforeAllocatedBalance - afterAllocatedBalance).to.equal(ethers.parseEther("10"))
				})
			})
		})
	})
}
