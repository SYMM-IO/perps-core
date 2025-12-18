import { loadFixture, time } from "./helpers/network-helpers"
import { expect } from "chai"

import { initializeFixture } from "./Initialize.fixture"
import { PositionType, QuoteStatus } from "./models/Enums"
import { Hedger } from "./models/Hedger"
import { RunContext } from "./models/RunContext"
import { User } from "./models/User"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest"
import { LockQuoteValidator } from "./models/validators/LockQuoteValidator"
import { UnlockQuoteValidator } from "./models/validators/UnlockQuoteValidator"
import { decimal, pausePartyB } from "./utils/Common"
import { getDummyPairUpnlAndPricesSig, getDummySingleUpnlAndPriceSig, getDummySingleUpnlSig } from "./utils/SignatureUtils"
import { QuoteStruct } from "../src/types/contracts/interfaces/ISymmio"
import { ethers, toUtf8Bytes } from "ethers";

export function shouldBehaveLikeLockQuote(): void {
	let context: RunContext, user: User, hedger: Hedger, hedger2: Hedger

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
			await context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
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
