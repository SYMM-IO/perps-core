import { loadFixture, time } from "./helpers/network-helpers"
import { expect } from "chai"
import { ethers, toUtf8Bytes } from "ethers"
import { last } from "rxjs"

import type { PairUpnlAndPriceSigStruct, QuoteStructOutput } from "../src/types/interfaces/ISymmio"
import { initializeFixture } from "./Initialize.fixture"
import { PositionType, QuoteStatus } from "./models/Enums"
import { Hedger } from "./models/Hedger"
import { RunContext } from "./models/RunContext"
import { User } from "./models/User"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest"
import { FillCloseRequest, limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest"
import { limitOpenRequestBuilder, marketOpenRequestBuilder } from "./models/requestModels/OpenRequest"
import { limitQuoteRequestBuilder, marketQuoteRequestBuilder } from "./models/requestModels/QuoteRequest"
import { OpenPositionValidator } from "./models/validators/OpenPositionValidator"
import { decimal, getQuoteQuantity, pausePartyB } from "./utils/Common"
import { getDummyPairUpnlAndPriceSig, getDummyPairUpnlAndPricesSig } from "./utils/SignatureUtils"
import { migratePartyBToMaster } from "./utils/MasterAccount"

export function shouldBehaveLikeOpenPosition(): void {
	let context: RunContext, user: User, user2: User, hedger: Hedger, hedger2: Hedger
	let quoteUser1: QuoteStructOutput, quoteUser2: QuoteStructOutput, quoteUser3: QuoteStructOutput, quoteUser4: QuoteStructOutput

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		this.user_allocated = decimal(500n)
		this.hedger_allocated = decimal(4000n)

		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

		user2 = new User(context, context.signers.user2)
		await user2.setup()
		await user2.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(this.hedger_allocated, this.hedger_allocated)

		hedger2 = new Hedger(context, context.signers.hedger2)
		await hedger2.setup()
		await hedger2.setBalances(this.hedger_allocated, this.hedger_allocated)

		quoteUser1 = await context.viewFacetQuote.getQuote(await user.sendQuote())
		quoteUser2 = await context.viewFacetQuote.getQuote(await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build()))
		quoteUser3 = await context.viewFacetQuote.getQuote(await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build()))
		quoteUser4 = await context.viewFacetQuote.getQuote(await user.sendQuote(marketQuoteRequestBuilder().build()))
	})

	describe("partyB normal account mode", function () {
		beforeEach(async function () {
			await hedger.lockQuote(1)
			await hedger2.lockQuote(2)
		})
		it("Should fail on not being the correct partyB", async function () {
			await expect(hedger.openPosition(2)).to.be.revertedWith("Accessibility: Should be partyB of quote")
		})

		it("Should fail on paused partyB", async function () {
			await pausePartyB(context)
			await expect(hedger.openPosition(1)).to.be.revertedWith("Pausable: PartyB actions paused")
		})

		it("Should fail on liquidated quote", async function () {
			await hedger2.openPosition(2)
			await hedger2.lockQuote(3)
			await user.liquidateAndSetSymbolPrices([1n], [decimal(2000n)], [2n])
			await expect(hedger2.openPosition(3)).to.be.revertedWith("Accessibility: PartyA isn't solvent")
		})

		it("Should fail on invalid fill amount", async function () {
			// more than quantity
			await expect(
				hedger.openPosition(
					1,
					limitOpenRequestBuilder()
						.filledAmount((await getQuoteQuantity(context, 1n)) + decimal(1n))
						.openPrice(decimal(1n))
						.build(),
				),
			).to.be.revertedWith("PartyBFacet: Invalid filledAmount")

			// zero
			await expect(hedger.openPosition(1, limitOpenRequestBuilder().filledAmount("0").build())).to.be.revertedWith(
				"PartyBFacet: Invalid filledAmount",
			)

			// market should get fully filled
			await hedger.lockQuote(4)
			await expect(
				hedger.openPosition(
					4,
					limitOpenRequestBuilder()
						.filledAmount((await getQuoteQuantity(context, 4n)) - decimal(1n))
						.openPrice(decimal(1n))
						.build(),
				),
			).to.be.revertedWith("PartyBFacet: Invalid filledAmount")
		})

		it("Should fail on invalid open price", async function () {
			const quantity = await getQuoteQuantity(context, 1n)
			await expect(hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(quantity).openPrice(decimal(2n)).build())).to.be.revertedWith(
				"PartyBFacet: Opened price isn't valid",
			)

			await expect(hedger2.openPosition(2, limitOpenRequestBuilder().filledAmount(quantity).openPrice(decimal(5n, 17)).build())).to.be.revertedWith(
				"PartyBFacet: Opened price isn't valid",
			)
		})

		it("Should fail if PartyB will be liquidatable", async function () {
			await expect(
				hedger.openPosition(
					1,
					limitOpenRequestBuilder()
						.filledAmount(await getQuoteQuantity(context, 1n))
						.openPrice(decimal(1n))
						.price(decimal(2n))
						.build(),
				),
			).to.be.revertedWith("LibSolvency: Available balance is lower than zero")

			await expect(
				hedger2.openPosition(
					2,
					limitOpenRequestBuilder()
						.filledAmount(await getQuoteQuantity(context, 2n))
						.openPrice(decimal(1n))
						.price(decimal(1n, 17))
						.upnlPartyB(decimal(-20n))
						.build(),
				),
			).to.be.revertedWith("LibSolvency: Available balance is lower than zero")
		})

		it("Should fail if PartyA will become liquidatable", async function () {
			await expect(
				hedger.openPosition(
					1,
					limitOpenRequestBuilder()
						.filledAmount(await getQuoteQuantity(context, 1n))
						.openPrice(decimal(1n))
						.price(decimal(1n, 17))
						.upnlPartyA(decimal(-400n))
						.build(),
				),
			).to.be.revertedWith("LibSolvency: Available balance is lower than zero")
			await expect(
				hedger2.openPosition(
					2,
					limitOpenRequestBuilder()
						.filledAmount(await getQuoteQuantity(context, 2n))
						.openPrice(decimal(1n))
						.price(decimal(2n))
						.upnlPartyA(decimal(-400n))
						.build(),
				),
			).to.be.revertedWith("LibSolvency: Available balance is lower than zero")
		})

		it("Should fail partially opened position of quote value is low", async function () {
			await expect(
				hedger.openPosition(
					1,
					limitOpenRequestBuilder()
						.filledAmount((await getQuoteQuantity(context, 1n)) - decimal(1n))
						.openPrice(decimal(1n))
						.price(decimal(1n, 17))
						.build(),
				),
			).to.be.revertedWith("PartyBFacet: Quote value is low")

			await expect(
				hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(decimal(1n)).openPrice(decimal(1n)).price(decimal(1n, 17)).build()),
			).to.be.revertedWith("PartyBFacet: Quote value is low")
		})

		it("Should fail to open expired quote", async function () {
			await time.increase(1000)
			await expect(
				hedger.openPosition(
					1,
					limitOpenRequestBuilder()
						.filledAmount(await getQuoteQuantity(context, 1n))
						.openPrice(decimal(1n))
						.price(decimal(1n, 17))
						.build(),
				),
			).to.be.revertedWith("PartyBFacet: Quote is expired")
		})

		it("Should run successfully for limit", async function () {
			const validator = new OpenPositionValidator()
			const beforeOut = await validator.before(context, {
				user: user,
				hedger: hedger,
				quoteId: BigInt(1),
			})
			const openedPrice = decimal(1n)
			const filledAmount = await getQuoteQuantity(context, 1n)
			await hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(openedPrice).price(decimal(1n, 17)).build())
			await validator.after(context, {
				user: user,
				hedger: hedger,
				quoteId: BigInt(1),
				openedPrice: openedPrice,
				fillAmount: filledAmount,
				beforeOutput: beforeOut,
			})
		})

		it("Should run successfully partially for limit", async function () {
			const oldQuote = await context.viewFacetQuote.getQuote(1)
			const validator = new OpenPositionValidator()
			const beforeOut = await validator.before(context, {
				user: user,
				hedger: hedger,
				quoteId: BigInt(1),
			})
			const filledAmount = oldQuote.quantity / 4n
			const openedPrice = decimal(9n, 17)
			await hedger.openPosition(1, limitOpenRequestBuilder().filledAmount(filledAmount).openPrice(openedPrice).price(decimal(1n, 17)).build())

			await validator.after(context, {
				user: user,
				hedger: hedger,
				quoteId: BigInt(1),
				openedPrice: openedPrice,
				fillAmount: filledAmount,
				beforeOutput: beforeOut,
				newQuoteId: BigInt(5),
				newQuoteTargetStatus: QuoteStatus.PENDING,
			})
		})

		it("Should run successfully for market", async function () {
			await hedger.lockQuote(4)
			const validator = new OpenPositionValidator()
			const beforeOut = await validator.before(context, {
				user: user,
				hedger: hedger,
				quoteId: BigInt(4),
			})
			const openedPrice = decimal(1n)
			const filledAmount = await getQuoteQuantity(context, 4n)
			await hedger.openPosition(4, marketOpenRequestBuilder().filledAmount(filledAmount).openPrice(openedPrice).price(decimal(1n)).build())
			await validator.after(context, {
				user: user,
				hedger: hedger,
				quoteId: BigInt(4),
				openedPrice: openedPrice,
				fillAmount: filledAmount,
				beforeOutput: beforeOut,
			})
		})

		it("Should check sig when not bind", async function () {
			await expect(
				hedger.openPosition(
					1,
					limitOpenRequestBuilder()
						.filledAmount(await getQuoteQuantity(context, 1n))
						.openPrice(decimal(1n))
						.price(decimal(1n, 17))
						.upnlPartyB(decimal(-1000n))
						.build(),
				),
			).to.be.revertedWith("LibSolvency: Available balance is lower than zero")
		})

		it("Should skip check sig when bind", async function () {
			await user.requestToCancelQuote(2)
			await hedger2.acceptCancelRequest(2)
			await context.controlFacet
				.connect(context.signers.admin)
				.grantRole(context.signers.admin, ethers.keccak256(toUtf8Bytes("BINDABLE_SETTER_ROLE")))
			await context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address,true)
			await context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			await expect(
				hedger.openPosition(
					1,
					limitOpenRequestBuilder()
						.filledAmount(await getQuoteQuantity(context, 1n))
						.openPrice(decimal(1n))
						.price(decimal(1n, 17))
						.upnlPartyB(decimal(-1000n))
						.build(),
				),
			).to.not.reverted
		})

		describe("Connections: Is Symbol Allowed For PartyA)", function () {
			beforeEach(async function () {
				await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)
			})

			it("Baseline: with no connections, A can open with any B regardless of Bs whitelist", async function () {
				// A sends a quote targeted to B2; no connections exist yet.
				await user2.sendQuote(
					limitQuoteRequestBuilder()
						.partyBWhiteList([await hedger2.getAddress()])
						.build(),
				)
				const lastID = await context.viewFacetQuote.getNextQuoteId()

				await context.symbolControlFacet
					.connect(context.signers.admin)
					.addSymbol("BTCUSDT_wrapped", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
				await context.symbolControlFacet.connect(context.signers.admin).setSymbolTypes([2], [2])
				await context.symbolControlFacet.whitelistSymbolType(context.signers.hedger.address, 2)

				await hedger2.lockQuote(lastID)

				const q1 = await context.viewFacetQuote.getQuote(lastID)

				// Should succeed even if B2 hasn't whitelisted the symbol yet
				await expect(hedger2.openPosition(lastID)).to.not.be.reverted
			})

			it("After connecting A↔B1 on Symbol1, opening Symbol2 with B2 reverts if B1 has NOT whitelisted Symbol2", async function () {
				// await hedger.lockQuote(1)
				const q1 = await context.viewFacetQuote.getQuote(1)
				const symbol1 = q1.symbolId as bigint

				await hedger.openPosition(1)

				// 2) Try to open the SAME symbol with B2, but only B2 whitelists it (B1 does NOT)
				const symbol2 = 2
				await context.symbolControlFacet
					.connect(context.signers.admin)
					.addSymbol("BTCUSDT_wrapped", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
				await context.symbolControlFacet.connect(context.signers.admin).setSymbolTypes([symbol2], [2])
				await context.symbolControlFacet.whitelistSymbolType(context.signers.hedger2.address, 2)
				await context.symbolControlFacet.connect(context.signers.admin).whitelistSymbols(await hedger2.getAddress(), [symbol2]) // B2 ✅
				// Important: do NOT whitelist for B1 here.

				await user.sendQuote(
					limitQuoteRequestBuilder()
						.partyBWhiteList([await hedger2.getAddress()])
						.symbolId(symbol2) // ensure same symbol
						.build(),
				)
				const lastID = await context.viewFacetQuote.getNextQuoteId()

				await expect(hedger2.lockQuote(lastID)).to.be.revertedWith("PartyBFacet: Symbol not allowed due to connection restrictions")
			})

			it("After connecting A↔B1 on Symbol1, opening Symbol1 with B2 SUCCEEDS when BOTH B1 and B2 whitelist Symbol1", async function () {
				const q1 = await context.viewFacetQuote.getQuote(1n)
				const sym = q1.symbolId as bigint

				await hedger.openPosition(1)

				// Whitelist Symbol1 for BOTH B1 and B2
				const symbol2 = 2
				await context.symbolControlFacet
					.connect(context.signers.admin)
					.addSymbol("BTCUSDT_wrapped", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
				await context.symbolControlFacet.connect(context.signers.admin).setSymbolTypes([symbol2], [2])
				await context.symbolControlFacet.whitelistSymbols(context.signers.hedger.address, [2])
				await context.symbolControlFacet.whitelistSymbols(context.signers.hedger2.address, [2])

				await user.sendQuote(
					limitQuoteRequestBuilder()
						.partyBWhiteList([await hedger2.getAddress()])
						.symbolId(symbol2) // ensure same symbol
						.build(),
				)
				const lastID = await context.viewFacetQuote.getNextQuoteId()

				await expect(hedger2.lockQuote(lastID)).to.not.be.reverted
				await expect(hedger2.openPosition(lastID)).to.not.be.reverted
			})

			it("Consensus via symbol TYPE: succeeds if B1 lacks Symbol1 but HAS Symbol1's type whitelisted", async function () {
				const q1 = await context.viewFacetQuote.getQuote(1n)

				await hedger.openPosition(1)

				// Whitelist Symbol1 for BOTH B1 and B2
				const symbol2 = 2
				await context.symbolControlFacet
					.connect(context.signers.admin)
					.addSymbol("BTCUSDT_wrapped", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
				// B2 explicitly whitelists Symbol1; B1 whitelists only the type (not the symbol)
				await context.symbolControlFacet.connect(context.signers.admin).setSymbolTypes([symbol2], [2])
				await context.symbolControlFacet.connect(context.signers.admin).whitelistSymbols(await hedger.getAddress(), [symbol2]) // B2 ✅ symbol
				await context.symbolControlFacet.connect(context.signers.admin).whitelistSymbolType(await hedger2.getAddress(), 2) // B1 ✅ type

				// Try to open with B2 on Symbol1 → should pass because check allows symbol OR type per B
				await user.sendQuote(
					limitQuoteRequestBuilder()
						.partyBWhiteList([await hedger2.getAddress()])
						.symbolId(symbol2)
						.build(),
				)
				const lastID = await context.viewFacetQuote.getNextQuoteId()

				await expect(hedger2.lockQuote(lastID)).to.not.be.reverted
				await expect(hedger2.openPosition(symbol2)).to.not.be.reverted
			})

			it("If any connected B blacklists Symbol1, opening with ANY B must revert", async function () {
				await context.symbolControlFacet
					.connect(context.signers.admin)
					.addSymbol("BTCUSDT_wrapped", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
				await context.symbolControlFacet.connect(context.signers.admin).setSymbolTypes([2], [2])
				// Connect A↔B1 on Symbol1
				await user.sendQuote(limitQuoteRequestBuilder().symbolId(2).build())
				let lastID = await context.viewFacetQuote.getNextQuoteId()

				const quote1 = await context.viewFacetQuote.getQuote(lastID)
				const sym = quote1.symbolId as bigint
				await context.symbolControlFacet.connect(context.signers.admin).whitelistSymbols(await hedger.getAddress(), [sym])
				await hedger.lockQuote(lastID)
				await hedger.openPosition(lastID)

				// Whitelist Symbol1 for B2
				await context.symbolControlFacet.connect(context.signers.admin).whitelistSymbols(await hedger2.getAddress(), [sym])

				// Try to open with B2 on the same Symbol1
				await user.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([]).symbolId(sym).build())
				lastID = await context.viewFacetQuote.getNextQuoteId()
				await hedger2.lockQuote(lastID)

				// Now blacklist Symbol1 on B1 → should trump the whitelist and block
				await context.symbolControlFacet.connect(context.signers.admin).removeSymbolsFromWhitelist(await hedger.getAddress(), [sym])
				await context.symbolControlFacet.connect(context.signers.admin).blacklistSymbols(await hedger.getAddress(), [sym])

				await expect(hedger2.openPosition(lastID)).to.be.revertedWith("PartyBFacet: Symbol not allowed due to connection restrictions")
			})
		})

		describe("Connections: addConnection()", function () {
			beforeEach(async function () {
				await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)
			})

			/** Helper: open a single quote fully with a specific B */
			const openWith = async (b: Hedger) => {
				await user.sendQuote(
					limitQuoteRequestBuilder()
						.partyBWhiteList([await b.getAddress()])
						.build(),
				)
				// lock and open
				const id = await context.viewFacetQuote.getNextQuoteId() // or use running index you keep in your harness
				await b.lockQuote(id)
				await b.openPosition(id)
				return id
			}

			it("adds a connection on first successful open", async function () {
				// Allow a roomy cap to avoid incidental reverts
				await context.controlFacet.connect(context.signers.admin).setMaxPartyAConnectionLimit(10)

				await openWith(hedger)

				// Assert via view (use whatever getters your ViewFacet exposes)
				const connections = await context.viewFacetSymbol.getConnectedPartyBs(user.address) // e.g., address[]
				expect(connections).to.include(await hedger.getAddress())
				expect(connections.length).to.equal(1)

				const isConn = await context.viewFacetSymbol.isConnectedPartyB(context.signers.user.address, await hedger.getAddress())
				expect(isConn).to.equal(true)
			})

			it("is idempotent: opening again with the same B does not duplicate the connection", async function () {
				await context.controlFacet.connect(context.signers.admin).setMaxPartyAConnectionLimit(1)

				await openWith(hedger)
				// Open another position with the SAME B — should not revert and should NOT add a second entry
				await openWith(hedger)

				const connects = await context.viewFacetSymbol.getConnectedPartyBs(context.signers.user.address)
				expect(connects.length).to.equal(1) // still one unique B
				expect(connects[0]).to.equal(await hedger.getAddress())
			})

			it("enforces the max connection limit: reverts when trying to connect to a new B beyond the cap", async function () {
				// Cap connections at 1
				await context.controlFacet.connect(context.signers.admin).setMaxPartyAConnectionLimit(1)

				// First connection (A↔B1) succeeds
				await openWith(hedger)

				await expect(openWith(hedger2)).to.be.revertedWith("AccountFacet: PartyA max connection limit exceeded")
			})
		})

		describe("Connections: removeConnectionIfNoPositions()", function () {
			beforeEach(async function () {
				// Allow generous connection cap so we don't trip the limit mid-tests
				await context.controlFacet.connect(context.signers.admin).setMaxPartyAConnectionLimit(10)
				await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)
			})

			const openWith = async (b: Hedger) => {
				await user.sendQuote(
					limitQuoteRequestBuilder()
						.partyBWhiteList([await b.getAddress()])
						.build(),
				)
				// lock and open
				const id = await context.viewFacetQuote.getNextQuoteId() // or use running index you keep in your harness
				await b.lockQuote(id)
				await b.openPosition(id)
				return id
			}
			const requestAndFillClose = async (id: bigint, b: Hedger, filled: bigint) => {
				// Party A requests close (LIMIT close; price is irrelevant with dummy oracle)
				await user.requestToClosePosition(id)
				let request: FillCloseRequest = limitFillCloseRequestBuilder().build()
				await context.partyBPositionActionsFacet
					.connect(b.signer)
					.fillCloseRequest(
						id,
						filled == 100n ? request.filledAmount : filled,
						request.closedPrice,
						await getDummyPairUpnlAndPriceSig(BigInt(request.price), BigInt(request.upnlPartyA), BigInt(request.upnlPartyB)),
					)
			}

			const expectConnected = async (partyBAddr: string, expected: boolean) => {
				const isConn = await context.viewFacetSymbol.isConnectedPartyB(context.signers.user.address, partyBAddr)
				expect(isConn).to.equal(expected)

				const conns = await context.viewFacetSymbol.getConnectedPartyBs(context.signers.user.address)
				if (expected) {
					expect(conns).to.include(partyBAddr)
				} else {
					expect(conns).to.not.include(partyBAddr)
				}
			}

			it("removes connection after the last (A,B) position is fully closed", async function () {
				const id = await openWith(hedger)
				await expectConnected(await hedger.getAddress(), true) // connection created

				// Fully close (filled == 100%)
				await requestAndFillClose(id, hedger, decimal(100n))

				// Connection should be removed (positions count for (B,A) is now zero)
				await expectConnected(await hedger.getAddress(), false)
			})

			it("does NOT remove connection after a partial close", async function () {
				const id = await openWith(hedger)
				await expectConnected(await hedger.getAddress(), true)

				// Partial close (50%)
				await requestAndFillClose(id, hedger, decimal(50n))

				// Still an open remainder → connection must persist
				await expectConnected(await hedger.getAddress(), true)
			})

			it("does NOT remove connection if another (A,B) position remains open", async function () {
				// Open two positions with the same B
				const id1 = await openWith(hedger)
				const id2 = await openWith(hedger)
				await expectConnected(await hedger.getAddress(), true)

				// Fully close only the first
				await requestAndFillClose(id1, hedger, decimal(100n))

				// One position still open → connection must persist
				await expectConnected(await hedger.getAddress(), true)

				// Now close the second fully → connection should drop
				await requestAndFillClose(id2, hedger, decimal(100n))
				await expectConnected(await hedger.getAddress(), false)
			})

			it("removing B1’s connection does not affect other Bs (B2 stays connected)", async function () {
				const idB1 = await openWith(hedger)
				const idB2 = await openWith(hedger2)

				await expectConnected(await hedger.getAddress(), true)
				await expectConnected(await hedger2.getAddress(), true)

				// Fully close B1 position(s)
				await requestAndFillClose(idB1, hedger, decimal(100n))

				// B1 should be removed; B2 must still be connected
				await expectConnected(await hedger.getAddress(), false)
				await expectConnected(await hedger2.getAddress(), true)

				// Clean up: close B2 to avoid leakage across tests
				await requestAndFillClose(idB2, hedger2, decimal(100n))
				await expectConnected(await hedger2.getAddress(), false)
			})
		})
	})

	describe("Master account shared buckets", function () {
		beforeEach(async function () {
			// Refresh PartyA balances to support larger quotes
			await user.setBalances(decimal(3000n), decimal(1500n), decimal(1200n))
			await user2.setBalances(decimal(3000n), decimal(1500n), decimal(1200n))

			// Fresh quotes from distinct partyAs
			quoteUser1 = await context.viewFacetQuote.getQuote(await user.sendQuote(limitQuoteRequestBuilder().quantity(decimal(80n)).build()))
			quoteUser2 = await context.viewFacetQuote.getQuote(await user2.sendQuote(limitQuoteRequestBuilder().quantity(decimal(120n)).build()))

			// Lock both quotes
			await hedger.lockQuote(quoteUser1.id)
			await hedger.lockQuote(quoteUser2.id)

			await migratePartyBToMaster(context, hedger, [quoteUser1.id, quoteUser2.id])
		})

		it("opens quotes into the shared master account and clears individual partyA account balances", async function () {
			await hedger.openPosition(
				quoteUser1.id,
				limitOpenRequestBuilder().filledAmount(quoteUser1.quantity).openPrice(quoteUser1.requestedOpenPrice).build(),
			)
			await hedger.openPosition(
				quoteUser2.id,
				limitOpenRequestBuilder().filledAmount(quoteUser2.quantity).openPrice(quoteUser2.requestedOpenPrice).build(),
			)

			const masterBucket = await hedger.getBalanceInfoMasterAccount()
			expect(masterBucket.lockedCva).to.equal(quoteUser1.lockedValues.cva + quoteUser2.lockedValues.cva)
			expect(masterBucket.lockedLf).to.equal(quoteUser1.lockedValues.lf + quoteUser2.lockedValues.lf)
			expect(masterBucket.lockedMmPartyB).to.equal(quoteUser1.lockedValues.partyBmm + quoteUser2.lockedValues.partyBmm)
			expect(masterBucket.pendingLockedCva).to.equal(0)
			expect(masterBucket.pendingLockedLf).to.equal(0)
			expect(masterBucket.pendingLockedMmPartyB).to.equal(0)

			const partyABucket1 = await hedger.getBalanceInfo(await user.getAddress())

			expect(partyABucket1.lockedCva).to.equal(quoteUser1.lockedValues.cva)
			expect(partyABucket1.lockedLf).to.equal(quoteUser1.lockedValues.lf)
			expect(partyABucket1.lockedMmPartyB).to.equal(quoteUser1.lockedValues.partyBmm)
			expect(partyABucket1.pendingLockedCva).to.equal(0)
			expect(partyABucket1.pendingLockedLf).to.equal(0)
			expect(partyABucket1.pendingLockedMmPartyB).to.equal(0)

			const partyABucket2 = await hedger.getBalanceInfo(await user2.getAddress())
			expect(partyABucket2.lockedCva).to.equal(quoteUser2.lockedValues.cva)
			expect(partyABucket2.lockedLf).to.equal(quoteUser2.lockedValues.lf)
			expect(partyABucket2.lockedMmPartyB).to.equal(quoteUser2.lockedValues.partyBmm)
			expect(partyABucket2.pendingLockedCva).to.equal(0)
			expect(partyABucket2.pendingLockedLf).to.equal(0)
			expect(partyABucket2.pendingLockedMmPartyB).to.equal(0)
		})

		it("bumps both per-partyA and master nonces when opening in master mode", async function () {
			const partyB = await hedger.getAddress()
			const partyA1 = await user.getAddress()
			const partyA2 = await user2.getAddress()

			const beforeShared = await context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress)
			const beforeA1 = await context.viewFacet.nonceOfPartyB(partyB, partyA1)
			const beforeA2 = await context.viewFacet.nonceOfPartyB(partyB, partyA2)

			await hedger.openPosition(
				quoteUser1.id,
				limitOpenRequestBuilder().filledAmount(quoteUser1.quantity).openPrice(quoteUser1.requestedOpenPrice).build(),
			)
			await hedger.openPosition(
				quoteUser2.id,
				limitOpenRequestBuilder().filledAmount(quoteUser2.quantity).openPrice(quoteUser2.requestedOpenPrice).build(),
			)

			const afterShared = await context.viewFacet.nonceOfPartyB(partyB, ethers.ZeroAddress)
			const afterA1 = await context.viewFacet.nonceOfPartyB(partyB, partyA1)
			const afterA2 = await context.viewFacet.nonceOfPartyB(partyB, partyA2)

			expect(afterShared).to.equal(beforeShared + 2n)
			expect(afterA1).to.equal(beforeA1 + 1n)
			expect(afterA2).to.equal(beforeA2 + 1n)
		})
	})
}
