import { expect } from "chai"

import { initializeFixture } from "../Initialize.fixture.js"
import { loadFixture } from "../helpers/network-helpers.js"
import { FUZZ_LIQUIDATION_OPERATIONS } from "../models/FuzzLogTypes.js"
import { Hedger } from "../models/Hedger.js"
import { TestManager } from "../models/TestManager.js"
import { User } from "../models/User.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal } from "../utils/Common.js"
import { conservationOracle } from "../utils/ConservationOracle.js"
import { FuzzCornerCampaign } from "../utils/FuzzCornerCampaign.js"
import { executeLiquidationScenario } from "../utils/FuzzLiquidationScenarios.js"

describe("exact conservation oracle", function () {
	this.timeout(180000)
	async function fixture() {
		const context = await loadFixture(initializeFixture)
		const manager = new TestManager(context, false, "direct")
		context.manager = manager
		manager.conservationSeed = process.env.FUZZ_SEED ?? "oracle-1"
		const user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(decimal(2000n), decimal(500n), decimal(500n))
		const hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(20000n), decimal(20000n))
		return { context, manager, user, hedger }
	}
	it("counts pending and locked fees once with duplicate address and quote inputs", async function () {
		const { context, manager, user, hedger } = await fixture()
		const id = await user.sendQuote(limitQuoteRequestBuilder().build())
		await manager.assertConservation("pending")
		await hedger.lockQuote(id)
		const result = await conservationOracle(context, {
			partyAs: [user.address, user.address.toLowerCase()],
			partyBs: [hedger.address, hedger.address],
			quoteIds: [id, id],
		})
		expect(result.diff).to.equal(0n)
		expect(result.breakdown[`reservedOpenFee:${id}`]).to.be.greaterThan(0n)
	})
	it("rejects a one-wei token surplus through the queue with replay diagnostics", async function () {
		const { context, manager } = await fixture()
		manager.enqueueAction({
			title: "inject-token-surplus",
			action: async () => {
				await context.collateral.mint(context.diamond, 1n)
			},
		})
		try {
			await manager.waitForIdle()
			expect.fail("oracle accepted surplus")
		} catch (error) {
			expect(String(error)).to.include("Money conservation violation").and.include("oracle-1").and.include('"diff":"-1"').and.include("actionIndex=")
		}
	})
	if (process.env.FUZZ_LIQUIDATION_SCENARIOS === "all") {
		for (const operation of FUZZ_LIQUIDATION_OPERATIONS) {
			it(`${operation} conserves every step`, async function () {
				const { context, manager, user, hedger } = await fixture()
				if (operation === "LIQUIDATE_PARTY_B_WITH_ORACLE") {
					const campaign = new FuzzCornerCampaign({
						context,
						manager,
						hedger,
						reusableUser: user,
						sacrificeUser: user,
						seed: manager.conservationSeed!,
						actorIds: { reusableUser: "user", sacrificeUser: "user", hedger: "hedger" },
					})
					await campaign.execute(operation)
					await manager.assertConservation(operation)
				} else await executeLiquidationScenario(context, manager, operation)
			})
		}
	}
})
