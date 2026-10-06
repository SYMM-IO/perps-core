import { expect } from "chai"

import { CUT_SELECTOR } from "../../../deployment-tooling/arbitrum-core-upgrade.js"
import { buildCoreUpgradeActions } from "../../../tasks/deploy/arbitrumCoreUpgrade.js"
import { coreUpgradeABI } from "../../../tasks/deploy/coreUpgradeSnapshot.js"
import { ethers } from "../../helpers/hardhat-connection.js"
import { address } from "../helpers/CoreUpgrade.fixture.js"

describe("Current Core upgrade safety gates (governance)", function () {
	it("puts the complete cut, listing grant and checked funding repair/role cleanup in one ordered batch", () => {
		const input = {
			config: {
				target: { core: address(1), safe: address(2), symbolManager: address(3) },
				allowedRemovedSelectors: [],
				repairAggregateFunding: true,
			},
		}
		const snapshot = {
			pause: [true],
			selectors: { [CUT_SELECTOR]: address(4), "0x12345678": address(5) },
			roles: { listing: false, migration: false },
			funding: [{ partyA: address(6), partyB: address(7), symbolId: "1", positionType: 0, a: "-1", b: "-1", expected: "0" }],
		}
		const deployed = { facets: { f: { address: address(8), selectors: ["0x12345678"] } } }
		const plan = buildCoreUpgradeActions(ethers, input, snapshot, deployed)
		const iface = new ethers.Interface(coreUpgradeABI)
		expect(plan.actions[0].data.slice(0, 10)).to.equal(CUT_SELECTOR)
		expect(plan.actions.slice(1).map(a => iface.parseTransaction({ data: a.data })!.name)).to.deep.equal([
			"grantRole",
			"grantRole",
			"resyncAggregateFunding",
			"revokeRole",
		])
		expect(iface.decodeFunctionData("resyncAggregateFunding", plan.actions[3].data)[0][0].expectedPartyBFunding).to.equal(-1n)
		snapshot.roles.migration = true
		expect(buildCoreUpgradeActions(ethers, input, snapshot, deployed).actions.length).to.equal(3)
		snapshot.pause[0] = false
		expect(() => buildCoreUpgradeActions(ethers, input, snapshot, deployed)).to.throw(/global pause/)
	})
})
