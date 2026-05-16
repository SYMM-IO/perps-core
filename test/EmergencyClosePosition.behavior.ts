import { expect } from "chai"

import type { QuoteStructOutput } from "../src/types/interfaces/ISymmio.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { PositionType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { emergencyCloseRequestBuilder } from "./models/requestModels/EmergencyCloseRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { EmergencyCloseRequestValidator } from "./models/validators/EmergencyCloseRequestValidator.js"
import { decimal, getBlockTimestamp, getQuoteQuantity, pausePartyB } from "./utils/Common.js"

export function shouldBehaveLikeEmergencyClosePosition(): void {
	let user: User, hedger: Hedger, hedger2: Hedger
	let context: RunContext
	let quote1LongOpened: QuoteStructOutput,
		quote2ShortOpened: QuoteStructOutput,
		quote3JustSent: QuoteStructOutput,
		quote4LongOpened: QuoteStructOutput

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		this.user_allocated = decimal(500n)
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

		// Quote1 LONG opened
		quote1LongOpened = await context.viewFacetQuote.getQuote(await user.sendQuote())
		await hedger.lockQuote(quote1LongOpened.id)
		await hedger.openPosition(quote1LongOpened.id)

		// Quote2 SHORT opened
		quote2ShortOpened = await context.viewFacetQuote.getQuote(
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build()),
		)
		await hedger.lockQuote(quote2ShortOpened.id)
		await hedger.openPosition(quote2ShortOpened.id)

		// Quote3 SHORT sent
		quote3JustSent = await context.viewFacetQuote.getQuote(await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build()))

		// Quote4 LONG sent
		quote4LongOpened = await context.viewFacetQuote.getQuote(await user.sendQuote())
		await hedger.lockQuote(quote4LongOpened.id)
		await hedger.openPosition(quote4LongOpened.id)
	})

	describe("Emergency Close", async function () {
		beforeEach(async function () {})

		it("Should fail when not emergency mode", async function () {
			await expect(hedger.emergencyClosePosition(1, emergencyCloseRequestBuilder().build())).to.be.revertedWith(
				"PartyBFacet: Operation not allowed. Either emergency mode must be active, party B must be in emergency status, or the symbol must be delisted",
			)
		})

		describe("Affiliate shutdown scheduled", async function () {
			beforeEach(async function () {
				const affiliate = await context.accountManager.getAddress()
				await context.controlFacet.connect(context.signers.admin).scheduleAffiliateShutdown(affiliate, (await getBlockTimestamp()) + 10n)
			})

			it("Should run successfully for a quote of the shutting down affiliate", async function () {
				const validator = new EmergencyCloseRequestValidator()
				const beforeOut = await validator.before(context, {
					user: user,
					hedger: hedger,
					quoteId: BigInt(1),
				})
				await hedger.emergencyClosePosition(1, emergencyCloseRequestBuilder().build())
				await validator.after(context, {
					user: user,
					hedger: hedger,
					quoteId: BigInt(1),
					price: decimal(1n),
					beforeOutput: beforeOut,
				})
			})

			it("Should stop allowing emergency close after the shutdown is cancelled", async function () {
				const affiliate = await context.accountManager.getAddress()
				await context.controlFacet.connect(context.signers.admin).cancelAffiliateShutdown(affiliate)

				await expect(hedger.emergencyClosePosition(1, emergencyCloseRequestBuilder().build())).to.be.revertedWith(
					"PartyBFacet: Operation not allowed. Either emergency mode must be active, party B must be in emergency status, or the symbol must be delisted",
				)
			})
		})

		describe("Emergency status for partyB activated", async function () {
			beforeEach(async function () {
				await context.pauseControlFacet.setPartyBEmergencyStatus([await hedger2.getAddress()], true)
				await context.pauseControlFacet.setPartyBEmergencyStatus([await hedger.getAddress()], true)
			})

			it("Should fail on invalid partyB", async function () {
				await expect(hedger2.emergencyClosePosition(1, emergencyCloseRequestBuilder().build())).to.be.revertedWith(
					"Accessibility: Should be partyB of quote",
				)
			})

			it("Should fail on paused partyB", async function () {
				await pausePartyB(context)
				await expect(hedger.emergencyClosePosition(1, emergencyCloseRequestBuilder().build())).to.be.revertedWith("Pausable: PartyB actions paused")
			})

			it("Should fail on negative balance of partyA/partyB", async function () {
				await expect(hedger.emergencyClosePosition(1, emergencyCloseRequestBuilder().upnlPartyA(decimal(-575n)).build())).to.be.revertedWith(
					"PartyBFacet: PartyA is insolvent",
				)
				await expect(hedger.emergencyClosePosition(1, emergencyCloseRequestBuilder().upnlPartyB(decimal(-410n)).build())).to.be.revertedWith(
					"PartyBFacet: PartyB should be solvent",
				)
			})

			it("Should run successfully", async function () {
				const validator = new EmergencyCloseRequestValidator()
				const beforeOut = await validator.before(context, {
					user: user,
					hedger: hedger,
					quoteId: BigInt(1),
				})
				await hedger.emergencyClosePosition(1, emergencyCloseRequestBuilder().build())
				await validator.after(context, {
					user: user,
					hedger: hedger,
					quoteId: BigInt(1),
					price: decimal(1n),
					beforeOutput: beforeOut,
				})
			})

			it("Should emergency close a SHORT position successfully", async function () {
				const quoteId = quote2ShortOpened.id
				const validator = new EmergencyCloseRequestValidator()
				const beforeOut = await validator.before(context, {
					user: user,
					hedger: hedger,
					quoteId: BigInt(quoteId),
				})
				await hedger.emergencyClosePosition(quoteId, emergencyCloseRequestBuilder().build())
				await validator.after(context, {
					user: user,
					hedger: hedger,
					quoteId: BigInt(quoteId),
					price: decimal(1n),
					beforeOutput: beforeOut,
				})
			})

			it("Should emergency close a quote that is already CLOSE_PENDING", async function () {
				// First request a normal close on quote1
				const quantity = await getQuoteQuantity(context, quote1LongOpened.id)
				await user.requestToClosePosition(
					quote1LongOpened.id,
					limitCloseRequestBuilder()
						.quantityToClose(quantity)
						.closePrice(decimal(1n))
						.deadline((await getBlockTimestamp()) + 1000n)
						.build(),
				)

				// Verify it's in CLOSE_PENDING
				const quoteBefore = await context.viewFacetQuote.getQuote(quote1LongOpened.id)
				expect(quoteBefore.quoteStatus).to.equal(QuoteStatus.CLOSE_PENDING)

				// Emergency close should still work on CLOSE_PENDING quotes
				const validator = new EmergencyCloseRequestValidator()
				const beforeOut = await validator.before(context, {
					user: user,
					hedger: hedger,
					quoteId: BigInt(quote1LongOpened.id),
				})
				await hedger.emergencyClosePosition(quote1LongOpened.id, emergencyCloseRequestBuilder().build())
				await validator.after(context, {
					user: user,
					hedger: hedger,
					quoteId: BigInt(quote1LongOpened.id),
					price: decimal(1n),
					beforeOutput: beforeOut,
				})
			})
		})

		describe("Emergency mode get activated", async function () {
			beforeEach(async function () {
				await context.pauseControlFacet.activeEmergencyMode()
			})

			it("Should run successfully", async function () {
				const validator = new EmergencyCloseRequestValidator()
				const beforeOut = await validator.before(context, {
					user: user,
					hedger: hedger,
					quoteId: BigInt(1),
				})
				await hedger.emergencyClosePosition(1, emergencyCloseRequestBuilder().build())
				await validator.after(context, {
					user: user,
					hedger: hedger,
					quoteId: BigInt(1),
					price: decimal(1n),
					beforeOutput: beforeOut,
				})
			})
		})

		describe("Symbol gets deListed", async function () {
			beforeEach(async function () {
				await context.symbolControlFacet.setSymbolValidationState((await context.viewFacetQuote.getQuote(1)).symbolId, false)
			})

			it("Should run successfully", async function () {
				const validator = new EmergencyCloseRequestValidator()
				const beforeOut = await validator.before(context, {
					user: user,
					hedger: hedger,
					quoteId: BigInt(1),
				})
				await hedger.emergencyClosePosition(1, emergencyCloseRequestBuilder().build())
				await validator.after(context, {
					user: user,
					hedger: hedger,
					quoteId: BigInt(1),
					price: decimal(1n),
					beforeOutput: beforeOut,
				})
			})
		})
	})
}
