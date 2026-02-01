import { loadFixture } from "@nomicfoundation/hardhat-network-helpers"
import { expect } from "chai"
import { ethers, upgrades } from "hardhat"

import { initializeFixture } from "./Initialize.fixture"
import { QuoteStatus } from "./models/Enums"
import { RunContext } from "./models/RunContext"
import { User } from "./models/User"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest"
import { decimal } from "./utils/Common"
import { getDummyPairUpnlAndPriceSig, getDummySingleUpnlSig } from "./utils/SignatureUtils"
import { SymmioPartyB } from "../src/types"

async function deployAndFundSymmioPartyB(context: RunContext): Promise<SymmioPartyB> {
	const SymmioPartyBFactory = await ethers.getContractFactory("SymmioPartyB")
	const symmioPartyB = (await upgrades.deployProxy(
		SymmioPartyBFactory,
		[await context.signers.hedger.getAddress(), context.diamond],
		{ initializer: "initialize" },
	)) as unknown as SymmioPartyB
	await symmioPartyB.waitForDeployment()

	await context.controlFacet.connect(context.signers.admin).registerPartyB(await symmioPartyB.getAddress())
	await context.controlFacet.connect(context.signers.admin).setADLEnabled(await symmioPartyB.getAddress(), true)

	await context.collateral.connect(context.signers.admin).mint(await symmioPartyB.getAddress(), decimal(1000000n))
	await symmioPartyB.connect(context.signers.hedger)._approve(await context.collateral.getAddress(), decimal(10000n))

	const deposit = context.accountFacet.interface.encodeFunctionData("deposit", [decimal(10000n)])
	const allocate = context.accountFacet.interface.encodeFunctionData("allocate", [decimal(10000n)])
	await symmioPartyB.connect(context.signers.hedger)._call([deposit, allocate])

	return symmioPartyB
}

async function openPositionWithSymmioPartyB(context: RunContext, user: User, symmioPartyB: SymmioPartyB): Promise<bigint> {
	const quoteId = BigInt(
		await user.sendQuote(limitQuoteRequestBuilder().partyBWhiteList([await symmioPartyB.getAddress()]).build()),
	)

	const lockQuote = context.partyBQuoteActionsFacet.interface.encodeFunctionData("lockQuote", [
		quoteId,
		await getDummySingleUpnlSig(),
	])

	const quote = await context.viewFacet.getQuote(quoteId)
	const openPosition = context.partyBPositionActionsFacet.interface.encodeFunctionData("openPosition", [
		quoteId,
		quote.quantity,
		decimal(1n),
		await getDummyPairUpnlAndPriceSig(decimal(1n)),
	])

	await symmioPartyB.connect(context.signers.hedger)._call([lockQuote, openPosition])
	expect((await context.viewFacet.getQuote(quoteId)).quoteStatus).to.equal(QuoteStatus.OPENED)

	return quoteId
}

function findEventArgs(receipt: any, iface: any, eventName: string, address?: string): any[] {
	const out: any[] = []
	for (const log of receipt.logs || []) {
		if (address && (log.address || "").toLowerCase() !== address.toLowerCase()) continue
		try {
			const parsed = iface.parseLog(log)
			if (parsed?.name === eventName) out.push(parsed.args)
		} catch {}
	}
	return out
}

export function shouldBehaveLikeADLClose(): void {
	let context: RunContext
	let user: User
	let symmioPartyB: SymmioPartyB

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)

		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(2000n), decimal(1000n), decimal(500n))

		symmioPartyB = await deployAndFundSymmioPartyB(context)
	})

	describe("ADL Close", function () {
		it("should ADL-close via SymmioPartyB and emit ADLClose", async function () {
			const quoteId = await openPositionWithSymmioPartyB(context, user, symmioPartyB)

			const closeAmount = decimal(10n)
			const closePrice = decimal(1n)
			const beforeCloseId = await context.viewFacet.getQuoteCloseId(quoteId)

			const tx = await symmioPartyB.connect(context.signers.hedger).adlClose([quoteId], [closeAmount], [closePrice])
			const receipt = await tx.wait()

			const afterCloseId = await context.viewFacet.getQuoteCloseId(quoteId)
			expect(afterCloseId).to.equal(beforeCloseId + 1n)

			const adlEvents = findEventArgs(receipt, context.partyBPositionActionsFacet.interface, "ADLClose", context.diamond)
			expect(adlEvents.length).to.equal(1)
			expect(adlEvents[0].quoteId).to.equal(quoteId)
			expect(adlEvents[0].amount).to.equal(closeAmount)
			expect(adlEvents[0].price).to.equal(closePrice)

			const q = await context.viewFacet.getQuote(quoteId)
			expect(q.closedAmount).to.equal(closeAmount)
			expect(q.quoteStatus).to.equal(QuoteStatus.OPENED)
		})

		it("should catch per-quote reverts and emit ADLSkip", async function () {
			const quoteId = await openPositionWithSymmioPartyB(context, user, symmioPartyB)

			const invalidAmount = (await context.viewFacet.getQuote(quoteId)).quantity + 1n
			const closePrice = decimal(1n)

			const tx = await symmioPartyB.connect(context.signers.hedger).adlClose([quoteId], [invalidAmount], [closePrice])
			const receipt = await tx.wait()

			const skipEvents = findEventArgs(receipt, symmioPartyB.interface, "ADLSkip", await symmioPartyB.getAddress())
			expect(skipEvents.length).to.equal(1)
			expect(skipEvents[0].quoteId).to.equal(quoteId)
			expect(skipEvents[0].amount).to.equal(invalidAmount)
			expect(skipEvents[0].price).to.equal(closePrice)
			expect(skipEvents[0].revertData).to.not.equal("0x")

			const q = await context.viewFacet.getQuote(quoteId)
			expect(q.closedAmount).to.equal(0n)
			expect(q.quoteStatus).to.equal(QuoteStatus.OPENED)
		})
	})
}
