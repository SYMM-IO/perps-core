import { loadFixture, time } from "./helpers/network-helpers.js"
import { expect } from "chai"
import { ethers, toUtf8Bytes } from "ethers"

import type { QuoteStruct } from "../src/types/interfaces/ISymmio.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { PositionType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { LockQuoteValidator } from "./models/validators/LockQuoteValidator.js"
import { UnlockQuoteValidator } from "./models/validators/UnlockQuoteValidator.js"
import { decimal, pausePartyB } from "./utils/Common.js"
import { getDummyPairUpnlAndPricesSig, getDummySingleUpnlAndPriceSig, getDummySingleUpnlSig } from "./utils/SignatureUtils.js"
import { migratePartyBToMaster } from "./utils/MasterAccount.js"

export function shouldBehaveLikeLockQuote(): void {
	let context: RunContext, user: User, hedger: Hedger, hedger2: Hedger, user2: User

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		this.user_allocated = decimal(700n)
		this.hedger_allocated = decimal(4000n)

		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(this.hedger_allocated, this.hedger_allocated)

		hedger2 = new Hedger(context, context.signers.hedger2)
		await hedger2.setup()
		await hedger2.setBalances(this.hedger_allocated, this.hedger_allocated)

		await user.sendQuote()
		await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
		await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())
		await user.sendQuote(
			limitQuoteRequestBuilder()
				.partyBWhiteList([await context.signers.hedger.getAddress()])
				.build(),
		)
		await user.sendQuote()
	})

	describe("Unlock Quote", async function () {
		it("Should fail on invalid quoteId", async function () {
			await expect(hedger.lockQuote(6, 0n, null)).to.be.reverted
		})

		it("Should fail on low balance", async function () {
			await expect(hedger.lockQuote(1, 0n, null)).to.be.revertedWith("PartyBFacet: insufficient available balance")
		})

		it("Should fail on low balance (negative upnl)", async function () {
			await expect(hedger.lockQuote(1, decimal(-125n))).to.be.revertedWith("PartyBFacet: Available balance is lower than zero")
		})

		it("Should fail on invalid partyB", async function () {
			await expect(context.partyBQuoteActionsFacet.connect(context.signers.user2).lockQuote(1, await getDummySingleUpnlSig())).to.be.revertedWith(
				"Accessibility: Should be partyB",
			)
		})

		it("Should fail on invalid state", async function () {
			await hedger.lockQuote(1)
			await expect(hedger.lockQuote(1)).to.be.revertedWith("PartyBFacet: Invalid state")
		})

		it("Should fail on liquidated partyA", async function () {
			await hedger.lockQuote(2)
			await hedger.openPosition(2)
			await user.liquidateAndSetSymbolPrices([1n], [decimal(200n)],[2n])
			await expect(hedger.lockQuote(1)).to.be.revertedWith("Accessibility: PartyA isn't solvent")
		})

		it("Should fail on paused partyB", async function () {
			await pausePartyB(context)
			await expect(hedger.lockQuote(1)).to.be.revertedWith("Pausable: PartyB actions paused")
		})

		it("Should fail on paused partyB", async function () {
			await expect(hedger2.lockQuote(4)).to.be.revertedWith("PartyBFacet: Sender isn't whitelisted")
		})

		it("Should fail on expired quote", async function () {
			await time.increase(1000)
			await expect(hedger.lockQuote(1)).to.be.revertedWith("PartyBFacet: Quote is expired")
		})

		it("Should fail when symbol type is not whitelisted", async function () {
			await expect(hedger.lockQuote(1)).not.to.be.reverted
			const q1 = await context.viewFacetQuote.getQuote(1n)
			const upnlSig = await getDummyPairUpnlAndPricesSig([q1.requestedOpenPrice], [1n])
			await expect(
				context.partyBBatchActionsFacet.connect(context.signers.hedger).openPositions([1n], [decimal(100n)], [q1.requestedOpenPrice], upnlSig),
			).to.not.be.reverted
			await context.symbolControlFacet.removeSymbolTypeFromWhitelist(context.signers.hedger.address, 1)
			await context.symbolControlFacet.removeSymbolsFromWhitelist(context.signers.hedger.address, [1])
			await expect(hedger2.lockQuote(2)).to.be.revertedWith("PartyBFacet: Symbol not allowed due to connection restrictions")
		})

		it("Should run successfully", async function () {
			const validator = new LockQuoteValidator()
			const beforeOut = await validator.before(context, {
				user: user,
			})
			await hedger.lockQuote(1)
			await validator.after(context, {
				user: user,
				hedger: hedger,
				quoteId: BigInt(1),
				beforeOutput: beforeOut,
			})
		})

		it("Should check bind partyB when bound", async function () {
			// BINDABLE_SETTER_ROLE was merged into PARTY_B_MANAGER_ROLE - no separate grant needed
			await context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address, true)
			await context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			await expect(hedger2.lockQuote(1)).to.be.revertedWith("PartyBFacet: PartyB is not bounded to this partyA")
		})

		it("Should skip sig check when not bound", async function () {
			await user.sendQuote(
				limitQuoteRequestBuilder()
					.upnlSig(getDummySingleUpnlAndPriceSig(decimal(16n)))
					.build(),
			)
			await expect(hedger2.lockQuote(1, decimal(-1000n))).to.be.revertedWith("PartyBFacet: Available balance is lower than zero")
		})
	})

	describe("Master account shared buckets", function () {
		let quoteUser1: QuoteStruct, quoteUser2: QuoteStruct

		beforeEach(async function () {
			user2 = new User(context, context.signers.user2)
			await user2.setup()
			await user2.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

			quoteUser1 = await context.viewFacetQuote.getQuote(await user.sendQuote(limitQuoteRequestBuilder().quantity(decimal(80n)).build()))
			quoteUser2 = await context.viewFacetQuote.getQuote(await user2.sendQuote(limitQuoteRequestBuilder().quantity(decimal(120n)).build()))

			await hedger.lockQuote(quoteUser1.id)
			await hedger.lockQuote(quoteUser2.id)
			await migratePartyBToMaster(context, hedger, [quoteUser1.id, quoteUser2.id])

			quoteUser1 = await context.viewFacetQuote.getQuote(quoteUser1.id)
			quoteUser2 = await context.viewFacetQuote.getQuote(quoteUser2.id)
		})

		it("locks quotes into the shared master bucket instead of partyA buckets", async function () {
			const masterBucket = await hedger.getBalanceInfoMasterAccount()
			const partyABucket1 = await hedger.getBalanceInfo(await user.getAddress())
			const partyABucket2 = await hedger.getBalanceInfo(await user2.getAddress())

			let totalCVA = BigInt(quoteUser1.lockedValues.cva) + BigInt(quoteUser2.lockedValues.cva)
			let totalLF = BigInt(quoteUser1.lockedValues.lf) + BigInt(quoteUser2.lockedValues.lf)
			let totalMMPartyB = BigInt(quoteUser1.lockedValues.partyBmm) + BigInt(quoteUser2.lockedValues.partyBmm)
			let totalLockedMaster = masterBucket.pendingLockedCva + masterBucket.pendingLockedLf + masterBucket.pendingLockedMmPartyB

			expect(partyABucket1.pendingLockedCva).to.eq(quoteUser1.lockedValues.cva)
			expect(partyABucket1.pendingLockedLf).to.eq(quoteUser1.lockedValues.lf)
			expect(partyABucket1.pendingLockedMmPartyB).to.eq(quoteUser1.lockedValues.partyBmm)
			expect(partyABucket2.pendingLockedCva).to.eq(quoteUser2.lockedValues.cva)
			expect(partyABucket2.pendingLockedLf).to.eq(quoteUser2.lockedValues.lf)
			expect(partyABucket2.pendingLockedMmPartyB).to.eq(quoteUser2.lockedValues.partyBmm)

			expect(masterBucket.pendingLockedCva).to.equal(totalCVA)
			expect(masterBucket.pendingLockedLf).to.equal(totalLF)
			expect(masterBucket.pendingLockedMmPartyB).to.equal(totalMMPartyB)
			expect(masterBucket.totalPendingLockedPartyB).to.equal(totalLockedMaster)
		})
	})

	describe("Unlock Quote", async function () {
		beforeEach(async function () {
			await hedger.lockQuote(1)
		})

		it("Should liquidate on partyB being not the one", async function () {
			await expect(hedger2.unlockQuote(1)).to.be.revertedWith("Accessibility: Should be partyB of quote")
		})

		it("Should fail on paused partyB", async function () {
			await pausePartyB(context)
			await expect(hedger.unlockQuote(1)).to.be.revertedWith("Pausable: PartyB actions paused")
		})

		it("Should expire quote during unlock", async function () {
			await time.increase(1000)
			await hedger.unlockQuote(1)
			let q: QuoteStruct = await context.viewFacetQuote.getQuote(1)
			expect(q.quoteStatus).to.be.equal(QuoteStatus.EXPIRED)
		})

		it("Should run successfully", async function () {
			const validator = new UnlockQuoteValidator()
			const beforeOut = await validator.before(context, { user: user })
			await hedger.unlockQuote(1)
			await validator.after(context, {
				user: user,
				quoteId: BigInt(1),
				beforeOutput: beforeOut,
			})
		})
	})
}
