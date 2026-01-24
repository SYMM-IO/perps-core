import { expect } from "chai"

import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, unDecimal } from "./utils/Common.js"
import { getDummyPairUpnlAndPricesSig, getDummySingleUpnlSig } from "./utils/SignatureUtils.js"

export function shouldBehaveLikeSymmioPartyB(): void {
	let context: RunContext
	let user: User

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(2000n), decimal(1000n), decimal(500n))
	})

	const setupPartyBContract = async (): Promise<string> => {
		const partyBAddress = await context.symmioPartyB.getAddress()

		await context.controlFacet.connect(context.signers.admin).registerPartyB(partyBAddress)
		await context.symbolControlFacet.connect(context.signers.admin).whitelistSymbolType(partyBAddress, 1)
		await context.controlFacet.connect(context.signers.admin).setADLEnabled(partyBAddress, true)

		await context.collateral.connect(context.signers.admin).mint(partyBAddress, decimal(2000n))
		await context.symmioPartyB.connect(context.signers.admin)._approve(await context.collateral.getAddress(), ethers.MaxUint256)

		const collateral = await context.viewFacet.getCollateral()
		const depositCall = context.accountFacet.interface.encodeFunctionData("deposit", [decimal(1000n)])
		const depositAssuranceCall = context.accountFacet.interface.encodeFunctionData("depositAssuranceCollateral", [collateral, decimal(1000n)])
		await context.symmioPartyB.connect(context.signers.admin)._call([depositCall, depositAssuranceCall])

		return partyBAddress
	}

	const openWithPartyBContract = async (partyBAddress: string): Promise<bigint> => {
		await user.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([partyBAddress]).build())
		const quoteId = await context.viewFacetQuote.getNextQuoteId()
		const quote = await context.viewFacetQuote.getQuote(quoteId)

		const allocateCoefficient = decimal(1n) // 1.0 (ensure PartyB remains solvent across multiple open positions)
		const notional = unDecimal(BigInt(quote.quantity) * quote.requestedOpenPrice)
		const allocateAmount = unDecimal(notional * allocateCoefficient)

		const allocateCall = context.accountFacet.interface.encodeFunctionData("allocateForPartyB", [allocateAmount, await user.getAddress()])
		const lockCall = context.partyBQuoteActionsFacet.interface.encodeFunctionData("lockQuote", [quoteId, await getDummySingleUpnlSig(0n)])
		const upnlSig = await getDummyPairUpnlAndPricesSig([quote.requestedOpenPrice], [1n])
		const openCall = context.partyBBatchActionsFacet.interface.encodeFunctionData("openPositions", [
			[quoteId],
			[decimal(100n)],
			[quote.requestedOpenPrice],
			upnlSig,
		])

		await context.symmioPartyB.connect(context.signers.admin)._call([allocateCall, lockCall, openCall])
		return quoteId
	}

	describe("SymmioPartyB", function () {
		describe("_call access control", function () {
			it("rejects calls to symmio core for non-privileged caller", async function () {
				const callData = context.viewFacet.interface.encodeFunctionData("getCollateral", [])
				await expect(context.symmioPartyB.connect(context.signers.user)._call([callData])).to.be.revertedWith("SymmioPartyB: Invalid access")
			})

			it("requires MANAGER_ROLE for restricted selectors", async function () {
				const callData = context.viewFacet.interface.encodeFunctionData("getCollateral", [])
				const selector = ethers.dataSlice(callData, 0, 4)

				await context.symmioPartyB.connect(context.signers.admin).setRestrictedSelector(selector, true)
				await context.symmioPartyB
					.connect(context.signers.admin)
					.grantRole(await context.symmioPartyB.TRUSTED_ROLE(), await context.signers.user.getAddress())

				await expect(context.symmioPartyB.connect(context.signers.user)._call([callData])).to.be.reverted
			})
		})

		describe("adlCall", function () {
			it("continues processing other quotes when one ADL call reverts", async function () {
				const partyBAddress = await setupPartyBContract()

				const quoteId1 = await openWithPartyBContract(partyBAddress)
				const quoteId2 = await openWithPartyBContract(partyBAddress)

				const q1 = await context.viewFacetQuote.getQuote(quoteId1)
				const q2 = await context.viewFacetQuote.getQuote(quoteId2)

					const tx = await context.symmioPartyB
						.connect(context.signers.admin)
						.adlCall(context.diamond, [quoteId1, quoteId2], [0n, decimal(10n)], [q1.openedPrice, q2.openedPrice], { gasLimit: 30_000_000 })

				const receipt = await tx.wait()
				const events = receipt.logs
					.map((log: any) => {
						try {
							return context.symmioPartyB.interface.parseLog(log)
						} catch {
							return null
						}
					})
					.filter((e: any) => e)

					const skip1 = events.find((e: any) => e.name === "ADLSkip" && e.args.quoteId === quoteId1)
					expect(skip1).to.not.equal(undefined)
					expect(skip1!.args.reason).to.equal("ADLFacet: Invalid amount")

					const skip2 = events.find((e: any) => e.name === "ADLSkip" && e.args.quoteId === quoteId2)
					if (skip2) throw new Error(`quote2 skipped: ${skip2.args.reason}`)

					const quoteAfter2 = await context.viewFacetQuote.getQuote(quoteId2)
					expect(quoteAfter2.closedAmount).to.equal(decimal(10n))

				const quoteAfter1 = await context.viewFacetQuote.getQuote(quoteId1)
				expect(quoteAfter1.closedAmount).to.equal(0n)
			})
		})
	})
}
