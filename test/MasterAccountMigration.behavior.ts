import { loadFixture } from "./helpers/network-helpers.js"
import { expect } from "chai"
import { ZeroAddress } from "ethers"

import { initializeFixture } from "./Initialize.fixture.js"
import { RunContext } from "./models/RunContext.js"
import { Hedger } from "./models/Hedger.js"
import { User } from "./models/User.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal } from "./utils/Common.js"

export function shouldBehaveLikeMasterAccountMigration(): void {
	let context: RunContext
	let hedger: Hedger

	const BALANCES = {
		INITIAL_COLLATERAL: decimal(1000n),
		DEPOSIT_AMOUNT: decimal(600n),
		MASTER_ALLOCATE: decimal(200n),
	}

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		const partyB = await hedger.getAddress()
		if (!(await context.viewFacet.isPartyB(partyB))) {
			await hedger.register()
		}
		await hedger.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.DEPOSIT_AMOUNT)
		await context.controlFacet.connect(context.signers.admin).setMasterAccountEnabled(true)
	})

	it("Should preserve master bucket balances when initializeMasterBalances is false", async function () {
		const partyB = await hedger.getAddress()
		// Master bucket is address(0) in normal mode as well.
		await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(BALANCES.MASTER_ALLOCATE, ZeroAddress)
		const beforeBalances = await context.viewFacet.balanceInfoOfPartyBMasterAccount(partyB)

		await context.masterAccountMigrationFacet
			.connect(context.signers.admin)
			.beginMasterAccountMigration(partyB, false)

		const afterBalances = await context.viewFacet.balanceInfoOfPartyBMasterAccount(partyB)
		expect(afterBalances[0]).to.equal(beforeBalances[0])
	})

	it("Should reset master bucket balances when initializeMasterBalances is true", async function () {
		const partyB = await hedger.getAddress()
		await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(BALANCES.MASTER_ALLOCATE, ZeroAddress)
		const beforeBalances = await context.viewFacet.balanceInfoOfPartyBMasterAccount(partyB)
		expect(beforeBalances[0]).to.equal(BALANCES.MASTER_ALLOCATE)

		await context.masterAccountMigrationFacet
			.connect(context.signers.admin)
			.beginMasterAccountMigration(partyB, true)

		const afterBalances = await context.viewFacet.balanceInfoOfPartyBMasterAccount(partyB)
		expect(afterBalances[0]).to.equal(0)
	})

	it("Should only allow allocations to the master bucket after master mode", async function () {
		const partyB = await hedger.getAddress()
		await context.masterAccountMigrationFacet
			.connect(context.signers.admin)
			.beginMasterAccountMigration(partyB, true)
		await context.masterAccountMigrationFacet.connect(context.signers.admin).migrateMasterAccountQuotes(partyB, [])
		await context.masterAccountMigrationFacet.connect(context.signers.admin).finalizeMasterAccountMigration(partyB)

		await expect(
			context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(BALANCES.MASTER_ALLOCATE, context.signers.user.address)
		).to.be.revertedWith("PartyBFacet: Master account mode is active")

		await expect(
			context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(BALANCES.MASTER_ALLOCATE, ZeroAddress)
		).to.not.be.reverted
	})

	it("Should not double-count a PartyA when listed multiple times", async function () {
		const partyB = await hedger.getAddress()
		const partyA1 = context.signers.user.address
		const partyA2 = context.signers.user2.address
		const allocateA1 = decimal(200n)
		const allocateA2 = decimal(150n)
		const user1 = new User(context, context.signers.user)
		const user2 = new User(context, context.signers.user2)

		await user1.setup()
		await user2.setup()
		await user1.setBalances(decimal(2000n), decimal(1000n), decimal(300n))
		await user2.setBalances(decimal(2000n), decimal(1000n), decimal(300n))

		await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateA1, partyA1)
		await context.partyBAccountFacet.connect(context.signers.hedger).allocateForPartyB(allocateA2, partyA2)
		const quote1Id = await user1.sendQuote(limitQuoteRequestBuilder().quantity(decimal(80n)).build())
		const quote2Id = await user2.sendQuote(limitQuoteRequestBuilder().quantity(decimal(120n)).build())
		await hedger.lockQuote(quote1Id, 0n, null)
		await hedger.lockQuote(quote2Id, 0n, null)
		const quote1 = await context.viewFacetQuote.getQuote(quote1Id)
		const quote2 = await context.viewFacetQuote.getQuote(quote2Id)
		await hedger.openPosition(
			quote1Id,
			limitOpenRequestBuilder().filledAmount(quote1.quantity).openPrice(quote1.requestedOpenPrice).build(),
		)
		await hedger.openPosition(
			quote2Id,
			limitOpenRequestBuilder().filledAmount(quote2.quantity).openPrice(quote2.requestedOpenPrice).build(),
		)
		const beforePartyA1 = await hedger.getBalanceInfo(partyA1)
		const beforePartyA2 = await hedger.getBalanceInfo(partyA2)

		expect(beforePartyA1.totalLockedPartyB).to.be.gt(0)
		expect(beforePartyA2.totalLockedPartyB).to.be.gt(0)

		await context.masterAccountMigrationFacet
			.connect(context.signers.admin)
			.beginMasterAccountMigration(partyB, true)
		await context.masterAccountMigrationFacet
			.connect(context.signers.admin)
			.migrateMasterAccountQuotes(partyB, [partyA1, partyA1, partyA2])
		const afterBalances = await context.viewFacet.balanceInfoOfPartyBMasterAccount(partyB)

		expect(afterBalances[0]).to.equal(allocateA1 + allocateA2)
		expect(await context.viewFacet.allocatedBalanceOfPartyB(partyB, partyA1)).to.equal(0)
		expect(await context.viewFacet.allocatedBalanceOfPartyB(partyB, partyA2)).to.equal(0)

		const afterPartyA1 = await hedger.getBalanceInfo(partyA1)
		const afterPartyA2 = await hedger.getBalanceInfo(partyA2)
		expect(afterPartyA1.totalLockedPartyB).to.equal(beforePartyA1.totalLockedPartyB)
		expect(afterPartyA1.totalPendingLockedPartyB).to.equal(beforePartyA1.totalPendingLockedPartyB)
		expect(afterPartyA2.totalLockedPartyB).to.equal(beforePartyA2.totalLockedPartyB)
		expect(afterPartyA2.totalPendingLockedPartyB).to.equal(beforePartyA2.totalPendingLockedPartyB)
	})
}
