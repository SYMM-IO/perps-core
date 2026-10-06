import { expect } from "chai"

import { CUT_SELECTOR } from "../../../deployment-tooling/arbitrum-core-upgrade.js"
import { coreUpgradeRoleGrants, validateCoreUpgradeInput } from "../../../deployment-tooling/core-upgrade-input.js"
import { buildCoreUpgradeActions } from "../../../tasks/deploy/arbitrumCoreUpgrade.js"
import { coreUpgradeABI } from "../../../tasks/deploy/coreUpgradeSnapshot.js"
import { ethers } from "../../helpers/hardhat-connection.js"
import { coreInputFixture } from "../helpers/core-upgrade-input.fixture.js"

describe("Categorized Core policies (governance)", function () {
	it("keeps grants on Core, resolves recipients and skips roles already held", () => {
		const configs = [1, 2].map(version => {
			const config = coreInputFixture(version)
			config.roleGrants =
				version === 1
					? [
							{ holder: config.target.symbolManager, role: "SYMBOL_LISTING_ROLE" },
							{ holder: config.governance.owner, role: "GLOBAL_PAUSER_ROLE" },
						]
					: {
							core: [
								{ holderRef: "target.symbolManager", role: "SYMBOL_LISTING_ROLE" },
								{ holderRef: "governance.owner", role: "GLOBAL_PAUSER_ROLE" },
							],
						}
			return validateCoreUpgradeInput(config)
		})
		const snapshot = {
			pause: [true],
			selectors: { [CUT_SELECTOR]: "0x" + "3".repeat(40), "0x23456789": "0x" + "4".repeat(40) },
			roles: { migration: false, listing: true },
			funding: [],
		}
		const deployments = { facets: { replacement: { address: "0x" + "5".repeat(40), selectors: ["0x23456789"] } } }
		const plans = configs.map(config => {
			const plannedRoles = coreUpgradeRoleGrants(config).map((grant, i) => ({ ...grant, held: i === 0 }))
			return buildCoreUpgradeActions(ethers, { config }, { ...snapshot, plannedRoles }, deployments)
		})
		expect(plans[1].actions).to.have.length(2)
		expect(plans[1].actions.map(({ to, value, data }: any) => ({ to, value, data }))).to.deep.equal(
			plans[0].actions.map(({ to, value, data }: any) => ({ to, value, data })),
		)
		const grant = plans[1].actions[1],
			iface = new ethers.Interface(coreUpgradeABI)
		expect(grant.to).to.equal(configs[1].target.core)
		expect(iface.decodeFunctionData("grantRole", grant.data)).to.deep.equal([configs[1].governance.owner, ethers.id("GLOBAL_PAUSER_ROLE")])
		expect(grant.description).to.contain(`on Core (${configs[1].target.core})`)
		expect(grant.description).to.contain(`governance.owner (${configs[1].governance.owner})`)
	})

	it("preserves cut, funding repair and temporary-role calldata across v1 and v2", () => {
		const snapshot = {
			pause: [true],
			selectors: {
				[CUT_SELECTOR]: "0x" + "3".repeat(40),
				"0x12345678": "0x" + "4".repeat(40),
				"0x23456789": "0x" + "4".repeat(40),
			},
			plannedRoles: [],
			roles: { migration: false, listing: true },
			funding: [{ partyA: "0x" + "1".repeat(40), partyB: "0x" + "2".repeat(40), symbolId: "1", positionType: 0, a: "3", b: "4", expected: "5" }],
		}
		const deployments = { facets: { replacement: { address: "0x" + "5".repeat(40), selectors: ["0x23456789"] } } }
		const plans = [1, 2].map(version => {
			const config = validateCoreUpgradeInput(coreInputFixture(version))
			return buildCoreUpgradeActions(ethers, { config }, snapshot, deployments)
		})
		expect(plans[1]).to.deep.equal(plans[0])
		const iface = new ethers.Interface(coreUpgradeABI)
		expect(plans[1].actions[0].data.slice(0, 10)).to.equal(CUT_SELECTOR)
		expect(plans[1].actions.slice(1).map((action: any) => iface.parseTransaction({ data: action.data })?.name)).to.deep.equal([
			"grantRole",
			"resyncAggregateFunding",
			"revokeRole",
		])
		expect(iface.decodeFunctionData("resyncAggregateFunding", plans[1].actions[2].data)[0][0].slice(4)).to.deep.equal([3n, 4n, 5n])
		const disabled = coreInputFixture(2)
		disabled.funding.aggregate.repair = false
		expect(() => buildCoreUpgradeActions(ethers, { config: disabled }, snapshot, deployments)).to.throw(/funding.aggregate/)
	})
})
