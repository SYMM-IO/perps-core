import { expect } from "chai"

import { CUT_SELECTOR } from "../../../deployment-tooling/arbitrum-core-upgrade.js"
import { assertCoreGovernanceProgress, buildCoreUpgradeActions } from "../../../tasks/deploy/arbitrumCoreUpgrade.js"
import { executeCoreGovernancePayload } from "../../../tasks/deploy/coreUpgradeGovernance.js"
import { assertCoreSnapshotPreserved, coreUpgradeABI } from "../../../tasks/deploy/coreUpgradeSnapshot.js"
import { ethers } from "../../helpers/hardhat-connection.js"
import { address, rejects, fixture } from "../helpers/CoreUpgradeGovernance.fixture.js"

describe("Generic Core governance (governance)", function () {
	it("stops before the next action if a mined transaction differs from its reviewed intent", async () => {
		const f = await fixture()
		let broadcasts = 0
		const mocked = {
			...ethers,
			getSigners: async () => [
				{
					getAddress: () => f.owner.getAddress(),
					sendTransaction: async (request: any) => {
						broadcasts++
						return f.owner.sendTransaction({ ...request, data: f.actions[1].data })
					},
				},
			],
		}
		await rejects(() => executeCoreGovernancePayload(mocked, f.config, f.envelope, {}, () => {}), /differs from/)
		expect(broadcasts).to.equal(1)
	})

	it("uses only missing input role grants and refuses unrelated changes during a partial EOA cut", () => {
		const config = {
			apiVersion: "operations.symm.io/core-upgrade-input-v1",
			governance: { owner: address(2) },
			target: { core: address(1), symbolManager: address(3) },
			allowedRemovedSelectors: [],
		}
		const before: any = {
			muon: { configuration: { appId: "7" } },
			preserved: { getOwner: address(2) },
			wiring: {},
			code: {},
			economy: {},
			pause: [true, false],
			selectors: { [CUT_SELECTOR]: address(4), "0x12345678": address(5) },
			roles: { migration: false, listing: true },
			plannedRoles: [
				{ holder: address(2), role: "GLOBAL_PAUSER_ROLE", held: false },
				{ holder: address(3), role: "SYMBOL_LISTING_ROLE", held: true },
			],
			funding: [],
			globals: [],
		}
		const plan = buildCoreUpgradeActions(ethers, { config }, before, { facets: { f: { address: address(8), selectors: ["0x12345678"] } } })
		expect(plan.actions).to.have.length(2)
		const iface = new ethers.Interface(coreUpgradeABI),
			grant = iface.decodeFunctionData("grantRole", plan.actions[1].data)
		expect(grant[0].toLowerCase()).to.equal(address(2))
		expect(grant[1]).to.equal(ethers.id("GLOBAL_PAUSER_ROLE"))
		const afterCut = { ...structuredClone(before), selectors: plan.desired }
		expect(() => assertCoreGovernanceProgress(ethers, before, afterCut, plan, 1, config)).not.to.throw()
		expect(() => assertCoreGovernanceProgress(ethers, before, { ...afterCut, wiring: { changed: true } }, plan, 1, config)).to.throw(
			/progress changed/,
		)
		expect(() => assertCoreSnapshotPreserved(before, afterCut, true)).to.throw(/grants are incomplete/)
		afterCut.plannedRoles[0].held = true
		expect(() => assertCoreGovernanceProgress(ethers, before, afterCut, plan, 2, config)).not.to.throw()
	})
})
