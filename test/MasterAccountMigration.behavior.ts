import { loadFixture } from "@nomicfoundation/hardhat-network-helpers"
import { expect } from "chai"
import { ZeroAddress } from "ethers"

import { initializeFixture } from "./Initialize.fixture"
import { RunContext } from "./models/RunContext"
import { Hedger } from "./models/Hedger"
import { decimal } from "./utils/Common"

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
		await context.accountFacet.connect(context.signers.hedger).allocateForPartyB(BALANCES.MASTER_ALLOCATE, ZeroAddress)
		const beforeBalances = await context.viewFacet.balanceInfoOfPartyBMasterAccount(partyB)

		await context.masterAccountMigrationFacet
			.connect(context.signers.admin)
			.beginMasterAccountMigration(partyB, false)

		const afterBalances = await context.viewFacet.balanceInfoOfPartyBMasterAccount(partyB)
		expect(afterBalances[0]).to.equal(beforeBalances[0])
	})

	it("Should reset master bucket balances when initializeMasterBalances is true", async function () {
		const partyB = await hedger.getAddress()
		await context.accountFacet.connect(context.signers.hedger).allocateForPartyB(BALANCES.MASTER_ALLOCATE, ZeroAddress)
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
			context.accountFacet.connect(context.signers.hedger).allocateForPartyB(BALANCES.MASTER_ALLOCATE, context.signers.user.address)
		).to.be.revertedWith("AccountFacet: Master account mode is active")

		await expect(
			context.accountFacet.connect(context.signers.hedger).allocateForPartyB(BALANCES.MASTER_ALLOCATE, ZeroAddress)
		).to.not.be.reverted
	})

	it("Should not double-count a PartyA when listed multiple times", async function () {
		const partyB = await hedger.getAddress()
		const partyA1 = context.signers.user.address
		const partyA2 = context.signers.user2.address
		const allocateA1 = decimal(100n)
		const allocateA2 = decimal(50n)

		await context.accountFacet.connect(context.signers.hedger).allocateForPartyB(allocateA1, partyA1)
		await context.accountFacet.connect(context.signers.hedger).allocateForPartyB(allocateA2, partyA2)

		await context.masterAccountMigrationFacet
			.connect(context.signers.admin)
			.beginMasterAccountMigration(partyB, true)
		await context.masterAccountMigrationFacet
			.connect(context.signers.admin)
			.migrateMasterAccountQuotes(partyB, [partyA1, partyA1, partyA2])
		const afterBalances = await context.viewFacet.balanceInfoOfPartyBMasterAccount(partyB)

		expect(afterBalances[0]).to.equal(allocateA1 + allocateA2)
	})
}
