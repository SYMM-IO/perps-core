import { expect } from "chai"

import {
	DEFAULT_MINING_BUDGET,
	MiningLedger,
	assertWithinBudget,
	buildVanityPlan,
	formatVanityPlan,
	resolveFactoryIntent,
} from "../../tasks/deploy/vanityPlan.js"

const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C"

describe("vanity plan", function () {
	it("returns null when no create2 block is configured", function () {
		expect(buildVanityPlan(undefined)).to.equal(null)
	})

	it("returns null when a create2 block declares no pattern", function () {
		expect(buildVanityPlan({ factoryAddress: FACTORY, groups: { facets: {} } })).to.equal(null)
	})

	it("resolves a group pattern for every contract in that group", function () {
		const plan = buildVanityPlan({ factoryAddress: FACTORY, groups: { facets: { suffix: "86" } } })!
		expect(plan.patternFor("core/PartyAFacet")).to.deep.equal({ suffix: "86" })
		expect(plan.patternFor("expressProvider/OperatorFacet")).to.deep.equal({ suffix: "86" })
		expect(plan.patternFor("core/Diamond")).to.equal(undefined)
	})

	it("lets an override replace its group pattern rather than merge with it", function () {
		const plan = buildVanityPlan({
			factoryAddress: FACTORY,
			groups: { facets: { suffix: "86" } },
			overrides: { "core/PartyAFacet": { prefix: "57" } },
		})!
		expect(plan.patternFor("core/PartyAFacet")).to.deep.equal({ prefix: "57" })
		expect(plan.patternFor("core/WithdrawFacet")).to.deep.equal({ suffix: "86" })
	})

	it("lets an empty override opt a contract out of its group pattern", function () {
		const plan = buildVanityPlan({
			factoryAddress: FACTORY,
			groups: { facets: { suffix: "86" } },
			overrides: { "core/PartyAFacet": {} },
		})!
		expect(plan.patternFor("core/PartyAFacet")).to.equal(undefined)
	})

	it("defaults the mining budget", function () {
		const plan = buildVanityPlan({ factoryAddress: FACTORY, groups: { facets: { suffix: "86" } } })!
		expect(plan.budget).to.equal(DEFAULT_MINING_BUDGET)
	})

	it("totals expected attempts across every matching contract", function () {
		const plan = buildVanityPlan({ factoryAddress: FACTORY, groups: { diamonds: { prefix: "573310" } } })!
		// Three diamonds at 16^6 each.
		expect(plan.total()).to.equal(3 * 16_777_216)
	})

	it("accepts a plan inside its budget", function () {
		const plan = buildVanityPlan({ factoryAddress: FACTORY, groups: { facets: { suffix: "86" } } })!
		expect(() => assertWithinBudget(plan, 100_000)).to.not.throw()
	})

	it("refuses a plan over its budget and names the offenders", function () {
		const plan = buildVanityPlan({ factoryAddress: FACTORY, groups: { facets: { prefix: "573310" } }, miningBudget: 1000 })!
		expect(() => assertWithinBudget(plan, 100_000)).to.throw(/exceeds the configured mining budget/)
	})

	it("renders a table naming each pattern", function () {
		const plan = buildVanityPlan({ factoryAddress: FACTORY, groups: { diamonds: { prefix: "573310" } } })!
		const table = formatVanityPlan(plan, 100_000)
		expect(table).to.contain("core/Diamond")
		expect(table).to.contain("16,777,216")
	})
})

describe("create2 factory intent", function () {
	it("normalizes the legacy factoryAddress spelling to reuse", function () {
		expect(resolveFactoryIntent({ factoryAddress: FACTORY })).to.deep.equal({ mode: "reuse", address: FACTORY })
	})

	it("normalizes an explicit reuse block", function () {
		expect(resolveFactoryIntent({ factory: { mode: "reuse", address: FACTORY } })).to.deep.equal({ mode: "reuse", address: FACTORY })
	})

	it("normalizes an explicit deploy block", function () {
		expect(resolveFactoryIntent({ factory: { mode: "deploy" } })).to.deep.equal({ mode: "deploy" })
	})

	it("returns null when no factory is declared at all", function () {
		expect(resolveFactoryIntent({ groups: { facets: { suffix: "86" } } })).to.equal(null)
		expect(resolveFactoryIntent(undefined)).to.equal(null)
	})

	it("builds a plan in deploy mode with no address", function () {
		const plan = buildVanityPlan({ factory: { mode: "deploy" }, groups: { facets: { suffix: "86" } } })!
		expect(plan.factoryIntent).to.deep.equal({ mode: "deploy" })
	})

	it("refuses to read the factory address before it is bound", function () {
		const plan = buildVanityPlan({ factory: { mode: "deploy" }, groups: { facets: { suffix: "86" } } })!
		expect(() => plan.factoryAddress).to.throw(/before ensureCreate2Factory bound it/)
	})

	it("reads the address after binding", function () {
		const plan = buildVanityPlan({ factory: { mode: "deploy" }, groups: { facets: { suffix: "86" } } })!
		plan.bindFactory(FACTORY)
		expect(plan.factoryAddress).to.equal(FACTORY)
	})

	it("binds a reuse address at construction", function () {
		const plan = buildVanityPlan({ factory: { mode: "reuse", address: FACTORY }, groups: { facets: { suffix: "86" } } })!
		expect(plan.factoryAddress).to.equal(FACTORY)
	})

	it("accepts rebinding the same address and refuses a different one", function () {
		const plan = buildVanityPlan({ factory: { mode: "deploy" }, groups: { facets: { suffix: "86" } } })!
		plan.bindFactory(FACTORY)
		expect(() => plan.bindFactory(FACTORY.toLowerCase())).to.not.throw()
		expect(() => plan.bindFactory("0x1111111111111111111111111111111111111111")).to.throw(/Refusing to rebind/)
	})

	it("still refuses a declared pattern with no factory of either spelling", function () {
		expect(() => buildVanityPlan({ groups: { facets: { suffix: "86" } } })).to.throw(/no factory/)
	})
})

describe("mining ledger", function () {
	it("caps a search at ten times expected while budget allows", function () {
		const ledger = new MiningLedger(1_000_000)
		expect(ledger.capFor(256)).to.equal(2_560)
	})

	it("caps a search at the remaining budget when that is smaller", function () {
		const ledger = new MiningLedger(1_000)
		expect(ledger.capFor(10_000)).to.equal(1_000)
	})

	it("refuses to start a search with no budget left", function () {
		const ledger = new MiningLedger(100)
		ledger.spend(100)
		expect(() => ledger.capFor(256)).to.throw(/mining budget/)
	})
})
