import { expect } from "chai"

import { assertVerificationRecordsCoverReport, assertVerificationRunBinding } from "../../tasks/deploy/verify.js"

const addresses = {
	diamond: "0x1000000000000000000000000000000000000001",
	accountLayerDiamond: "0x2000000000000000000000000000000000000002",
	instantLayer: "0x3000000000000000000000000000000000000003",
	symmioPartyB: "0x4000000000000000000000000000000000000004",
	symbolManager: "0x5000000000000000000000000000000000000005",
}

describe("deployment verification binding", function () {
	it("binds the scoped report to the expected deployment and active recipe", function () {
		const active: any = {
			digest: "a".repeat(64),
			recipe: {
				name: "arbitrum-release",
				core: { mode: "deploy" },
				partyB: { mode: "deploy" },
				symbolManager: { mode: "skip" },
				expressProvider: { mode: "skip" },
			},
		}
		const report = {
			deploymentId: "deploy-1",
			network: "arbitrum",
			chainId: 42161,
			checks: { health: "passed" },
			recipe: {
				name: "arbitrum-release",
				path: "deployments/arbitrum.json",
				digest: active.digest,
				components: { core: "deploy", partyB: "deploy", symbolManager: "skip", expressProvider: "skip" },
			},
		}
		expect(
			assertVerificationRunBinding(
				report,
				{ network: "arbitrum", chainId: 42161 },
				{ deploymentId: "deploy-1", recipeDigest: active.digest },
				active,
			),
		).to.deep.equal({ deploymentId: "deploy-1", recipeDigest: active.digest })
		expect(() => assertVerificationRunBinding(report, { network: "arbitrum", chainId: 42161 }, { deploymentId: "older" }, active)).to.throw(
			"deploymentId",
		)
		expect(() => assertVerificationRunBinding(report, { network: "base", chainId: 8453 }, { deploymentId: "deploy-1" }, active)).to.throw(
			"target mismatch",
		)
	})

	it("refuses scoped verification records that do not cover the reported deployment", function () {
		const report = {
			addresses,
			config: { partyBMode: "deploy", symbolManagerMode: "deploy", collateralAddress: addresses.diamond },
		}
		const records = Object.values(addresses).map((address, index) => ({
			name: `Contract${index}`,
			address,
			constructorArguments: [],
		}))
		expect(() => assertVerificationRecordsCoverReport(records, report)).not.to.throw()
		expect(() =>
			assertVerificationRecordsCoverReport(
				records.filter(record => record.address !== addresses.symmioPartyB),
				report,
			),
		).to.throw("PartyB")
	})
})
