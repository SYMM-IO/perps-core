import { expect } from "chai"

import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { QuoteStatus } from "./models/Enums.js"
import { FUZZ_CORNER_OPERATIONS, type FuzzCornerOperation, type FuzzModelEvent } from "./models/FuzzLogTypes.js"
import { Hedger } from "./models/Hedger.js"
import { TestManager } from "./models/TestManager.js"
import { User } from "./models/User.js"
import { QuoteCheckpoint } from "./models/quoteCheckpoint.js"
import { decimal } from "./utils/Common.js"
import { FuzzCornerCampaign, FuzzCornerOperationPlanner } from "./utils/FuzzCornerCampaign.js"
import { FuzzQuoteInventoryTracker } from "./utils/FuzzQuoteInventory.js"

function draw(planner: FuzzCornerOperationPlanner, count: number): FuzzCornerOperation[] {
	return Array.from({ length: count }, () => planner.next())
}

export function shouldBehaveLikeFuzzCornerCampaign(): void {
	describe("seeded corner-operation planner", function () {
		it("replays the same shuffled bag for the same seed", function () {
			const first = new FuzzCornerOperationPlanner("corner-seed")
			const replay = new FuzzCornerOperationPlanner("corner-seed")

			const firstCycle = draw(first, FUZZ_CORNER_OPERATIONS.length)
			const replayCycle = draw(replay, FUZZ_CORNER_OPERATIONS.length)

			expect(firstCycle).to.deep.equal(replayCycle)
			expect(firstCycle).to.have.members([...FUZZ_CORNER_OPERATIONS])
		})

		it("refills with a newly shuffled complete bag", function () {
			const planner = new FuzzCornerOperationPlanner("refill-seed")

			const firstCycle = draw(planner, FUZZ_CORNER_OPERATIONS.length)
			const secondCycle = draw(planner, FUZZ_CORNER_OPERATIONS.length)

			expect(firstCycle).to.have.members([...FUZZ_CORNER_OPERATIONS])
			expect(secondCycle).to.have.members([...FUZZ_CORNER_OPERATIONS])
			expect(secondCycle).not.to.deep.equal(firstCycle)
		})

		it("removes PartyA liquidation from future bags only after it succeeds", function () {
			const planner = new FuzzCornerOperationPlanner("one-shot-seed")
			const firstCycle = draw(planner, FUZZ_CORNER_OPERATIONS.length)
			expect(firstCycle).to.include("LIQUIDATE_PARTY_A")

			planner.markSucceeded("LIQUIDATE_PARTY_A")
			const nextCycle = draw(planner, FUZZ_CORNER_OPERATIONS.length - 1)

			expect(nextCycle).not.to.include("LIQUIDATE_PARTY_A")
			expect(nextCycle).to.have.members(FUZZ_CORNER_OPERATIONS.filter(operation => operation !== "LIQUIDATE_PARTY_A"))
		})
	})

	it("observes expiry and terminal liquidation-pending states through real corner workflows", async function () {
		const context = await loadFixture(initializeFixture)
		const events: FuzzModelEvent[] = []
		const manager = new TestManager(context, false, "direct", event => events.push(event))
		context.manager = manager
		await manager.start()
		await context.controlFacet.connect(context.signers.admin).setBalanceLimitPerUser(decimal(10_000_000n))

		const reusableUser = new User(context, context.signers.user)
		await reusableUser.setup()
		await reusableUser.setBalances(decimal(1_000_000n), decimal(1_000_000n), decimal(1_000_000n))

		const sacrificeUser = new User(context, context.signers.user2)
		await sacrificeUser.setup()
		await sacrificeUser.setBalances(decimal(1_000_000n), decimal(1_000_000n), decimal(1_000_000n))

		const hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(5_000_000n), decimal(5_000_000n))

		const campaign = new FuzzCornerCampaign({
			context,
			manager,
			reusableUser,
			sacrificeUser,
			hedger,
			actorIds: {
				reusableUser: "corner#reusable",
				sacrificeUser: "corner#sacrifice",
				hedger: "hedger#1",
			},
			seed: "lifecycle-observation",
		})

		for (let index = 0; index < FUZZ_CORNER_OPERATIONS.length; index++) await campaign.executeNext()

		const observedStatuses = events.flatMap(event => (event.type === "state" ? [event.quoteStatus] : []))
		const missingStatuses = ["EXPIRED", "LIQUIDATED_PENDING"].filter(status => !observedStatuses.includes(status))
		expect(missingStatuses, `missing real corner state observations: ${missingStatuses.join(", ")}`).to.deep.equal([])

		for (const expected of [QuoteStatus.EXPIRED, QuoteStatus.LIQUIDATED_PENDING]) {
			const statusName = QuoteStatus[expected]
			const observation = events.find(event => event.type === "state" && event.quoteStatus === statusName)
			expect(observation, `missing ${statusName} quote observation`).not.to.equal(undefined)
			if (observation?.type === "state") {
				expect((await context.viewFacetQuote.getQuote(observation.quoteId)).quoteStatus).to.equal(expected)
			}
		}

		const liquidatedPending = events.find(event => event.type === "state" && event.quoteStatus === "LIQUIDATED_PENDING")
		expect(liquidatedPending).not.to.equal(undefined)
		if (liquidatedPending?.type === "state") {
			const inventory = new FuzzQuoteInventoryTracker().observe(liquidatedPending)
			expect({ active: inventory.active, terminal: inventory.terminal, waitingRemainders: inventory.partialOpen.waitingRemainders }).to.deep.equal({
				active: 0,
				terminal: 1,
				waitingRemainders: 0,
			})

			const checkpoint = QuoteCheckpoint.getInstance()
			checkpoint.reset()
			checkpoint.addBlockedQuotes(liquidatedPending.quoteId)
			await manager.observeQuoteState(liquidatedPending.quoteId)
			expect(checkpoint.isBlockedQuote(liquidatedPending.quoteId)).to.equal(false)
			checkpoint.reset()
		}
	})
}
