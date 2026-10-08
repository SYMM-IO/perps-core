import { expect } from "chai"

import { CUT_SELECTOR } from "../../../deployment-tooling/arbitrum-core-upgrade.js"
import { assertCoreGovernanceProgress, buildCoreUpgradeActions } from "../../../tasks/deploy/arbitrumCoreUpgrade.js"
import { executeCoreGovernancePayload } from "../../../tasks/deploy/coreUpgradeGovernance.js"
import { assertCoreSnapshotPreserved, coreUpgradeABI } from "../../../tasks/deploy/coreUpgradeSnapshot.js"
import { ethers } from "../../helpers/hardhat-connection.js"
import { address, rejects, fixture } from "../helpers/CoreUpgradeGovernance.fixture.js"

describe("Generic Core governance (governance)", function () {
	it("plans an unpaused standard upgrade without pause calls and keeps paused funding maintenance separate", () => {
		const config = {
			apiVersion: "operations.symm.io/core-upgrade-input-v1",
			governance: { owner: address(2) },
			target: { core: address(1), symbolManager: address(3) },
			allowedRemovedSelectors: [],
			repairAggregateFunding: true,
		}
		const snapshot = {
			pause: [false],
			selectors: { [CUT_SELECTOR]: address(4), "0x12345678": address(5) },
			roles: { migration: false, listing: true },
			plannedRoles: [],
			funding: [],
		}
		const deployments = { facets: { f: { address: address(8), selectors: ["0x12345678"] } } }
		const plan = buildCoreUpgradeActions(ethers, { config }, snapshot, deployments)
		expect(plan.actions).to.have.length(1)
		expect(plan.actions[0].data.slice(0, 10)).to.equal(CUT_SELECTOR)
		const inconsistent = {
			...snapshot,
			funding: [{ partyA: address(6), partyB: address(7), symbolId: "1", positionType: 0, a: "1", b: "1", expected: "0" }],
		}
		expect(() => buildCoreUpgradeActions(ethers, { config }, inconsistent, deployments)).to.throw(/separate.*funding.*maintenance/i)
		expect(() => buildCoreUpgradeActions(ethers, { config }, { ...snapshot, pause: [true] }, deployments)).not.to.throw()
	})

	it("allows trading between standard EOA actions while rejecting configuration, pause and role drift", () => {
		const config = { apiVersion: "operations.symm.io/core-upgrade-input-v1", target: { symbolManager: address(3) } }
		const before = {
			muon: { configuration: { appId: "7" } },
			preserved: { getOwner: address(2) },
			wiring: {},
			code: {},
			economy: { next: 1 },
			pause: [false, false],
			selectors: { [CUT_SELECTOR]: address(4) },
			roles: { migration: false, listing: true },
			plannedRoles: [],
			funding: [],
			globals: [],
		}
		const batch = { actions: [{ data: CUT_SELECTOR }], desired: { [CUT_SELECTOR]: address(8) } }
		const after = {
			...structuredClone(before),
			selectors: batch.desired,
			economy: { next: 2 },
			funding: [{ a: "3", b: "3", expected: "3" }],
			globals: [{ stored: "3", expected: "3" }],
		}
		expect(() => assertCoreGovernanceProgress(ethers, before, after, batch, 1, config)).not.to.throw()
		for (const drift of [{ pause: [true, false] }, { wiring: { changed: true } }, { roles: { migration: true, listing: true } }])
			expect(() => assertCoreGovernanceProgress(ethers, before, { ...after, ...drift }, batch, 1, config)).to.throw(/progress changed/)
	})

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
