import { expect } from "chai"

import { DEPLOYABLE_CONTRACTS, VANITY_GROUPS, deployableGroup } from "../../deployment-tooling/deployableContracts.js"
import { FacetNames } from "../../tasks/deploy/constants.js"

const shortName = (name: string) => (name.includes(":") ? name.split(":").pop()! : name)

describe("vanity deployable contract registry", function () {
	it("registers every core facet the deployment actually deploys", function () {
		const missing = FacetNames.map(shortName).filter(name => !Object.hasOwn(DEPLOYABLE_CONTRACTS, `core/${name}`))
		expect(missing, `unregistered core facets: ${missing.join(", ")}`).to.deep.equal([])
	})

	it("registers the core DiamondCutFacet, Diamond, and Init", function () {
		for (const key of ["core/Diamond", "core/DiamondCutFacet", "core/Init"]) {
			expect(Object.hasOwn(DEPLOYABLE_CONTRACTS, key), `${key} is not registered`).to.be.true
		}
	})

	it("registers every manifest-driven core library", function () {
		for (const name of ["LibQuoteFunding", "LibQuoteClose", "PartyBPositionActionsFacetImpl", "ClearingHouseFacetImpl"]) {
			expect(Object.hasOwn(DEPLOYABLE_CONTRACTS, `core/${name}`), `core/${name} is not registered`).to.be.true
		}
	})

	it("no longer registers the monolith InstantLayer as a peripheral", function () {
		expect(Object.hasOwn(DEPLOYABLE_CONTRACTS, "peripherals/InstantLayer")).to.be.false
	})

	it("registers every InstantLayer facet the diamond deployment actually deploys", function () {
		for (const name of ["DiamondCutFacet", "DiamondLoupeFacet", "ControlFacet", "ExecutionFacet", "DelegationFacet", "ViewFacet"]) {
			expect(Object.hasOwn(DEPLOYABLE_CONTRACTS, `instantLayer/${name}`), `instantLayer/${name} is not registered`).to.be.true
			expect(deployableGroup(`instantLayer/${name}`)).to.equal("facets")
		}
	})

	it("registers the InstantLayer Diamond and Init", function () {
		expect(Object.hasOwn(DEPLOYABLE_CONTRACTS, "instantLayer/Diamond"), "instantLayer/Diamond is not registered").to.be.true
		expect(deployableGroup("instantLayer/Diamond")).to.equal("diamonds")
		expect(Object.hasOwn(DEPLOYABLE_CONTRACTS, "instantLayer/Init"), "instantLayer/Init is not registered").to.be.true
		expect(deployableGroup("instantLayer/Init")).to.equal("peripherals")
	})

	it("classifies every entry into a known group", function () {
		for (const [key, group] of Object.entries(DEPLOYABLE_CONTRACTS)) {
			expect(VANITY_GROUPS, `${key} has group ${group}`).to.include(group)
		}
	})

	it("uses qualified keys only", function () {
		for (const key of Object.keys(DEPLOYABLE_CONTRACTS)) {
			expect(key, `${key} must be qualified as component/Contract`).to.match(
				/^(core|accountLayer|expressProvider|gaslessLayer|instantLayer|peripherals)\/[A-Za-z0-9]+$/,
			)
		}
	})

	it("resolves a group for a registered key and undefined otherwise", function () {
		expect(deployableGroup("core/PartyAFacet")).to.equal("facets")
		expect(deployableGroup("core/Diamond")).to.equal("diamonds")
		expect(deployableGroup("ControlFacet")).to.equal(undefined)
	})
})
