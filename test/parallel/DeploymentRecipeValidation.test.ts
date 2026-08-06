import { expect } from "chai"

import { recipeAccountsForNetwork, recipeAccountsForSimulatedNetwork, recipeCredentialPolicy } from "../../hardhat.config.js"
import { assertComponentDeploymentAuthority, summarizeComponentHealth } from "../../tasks/deploy/componentDeployment.js"
import {
	assertDependencyAddressesHaveCode,
	assertExpressProviderSupported,
	assertRecipeNetworkTarget,
	componentCheckpointScope,
	componentReportRelativePath,
	parseCoreDependencyReport,
} from "../../tasks/deploy/deploymentRecipe.js"
import { ethers } from "../helpers/hardhat-connection.js"

function report(overrides: Record<string, unknown> = {}) {
	return {
		deploymentId: "deployment-1",
		deployerAddress: "0x0000000000000000000000000000000000000001",
		network: "arbitrum",
		chainId: 42161,
		lifecycle: "complete",
		checks: { health: "passed", verification: "passed", verificationPolicy: "required" },
		config: { admin: "0x0000000000000000000000000000000000000002" },
		addresses: {
			diamond: "0x0000000000000000000000000000000000000003",
			instantLayer: "0x0000000000000000000000000000000000000004",
		},
		...overrides,
	}
}

describe("deployment recipe task validation", function () {
	it("keeps normal recipe deploy/verify credentials while read-only status configures only RPC and zero accounts", function () {
		expect(recipeCredentialPolicy(false)).to.deep.equal({ deployer: true, rpc: true, explorer: true })
		expect(recipeCredentialPolicy(true)).to.deep.equal({ deployer: false, rpc: true, explorer: false })
		expect(recipeAccountsForNetwork("arbitrum", "arbitrum", "secret-key", false)).to.deep.equal(["secret-key"])
		expect(recipeAccountsForNetwork("arbitrum", "arbitrum", "secret-key", true)).to.deep.equal([])
		expect(recipeAccountsForNetwork("base", "arbitrum", "secret-key", false)).to.deep.equal([])
		expect(recipeAccountsForSimulatedNetwork(true)).to.deep.equal([])
		expect(recipeAccountsForSimulatedNetwork(false)).to.equal(undefined)
	})

	it("binds a component dependency report to network, chain, health, and live verification", function () {
		const parsed = parseCoreDependencyReport(report(), { network: "arbitrum", chainId: 42161, live: true })
		expect(parsed.addresses.diamond).to.equal("0x0000000000000000000000000000000000000003")

		for (const invalid of [
			report({ network: "base" }),
			report({ chainId: 8453 }),
			report({ lifecycle: "failed" }),
			report({ checks: { health: "failed", verification: "passed", verificationPolicy: "required" } }),
			report({ checks: { health: "passed", verification: "skipped", verificationPolicy: "explicitly_skipped" } }),
		]) {
			expect(() => parseCoreDependencyReport(invalid, { network: "arbitrum", chainId: 42161, live: true })).to.throw("DEPENDENCY_UNAVAILABLE")
		}
	})

	it("accepts a locally healthy dependency without explorer verification", function () {
		const parsed = parseCoreDependencyReport(
			report({
				network: "localhost",
				chainId: 31337,
				checks: { health: "passed", verification: "skipped", verificationPolicy: "not_applicable" },
			}),
			{ network: "localhost", chainId: 31337, live: false },
		)
		expect(parsed.checks.verification).to.equal("skipped")
	})

	it("checks dependency bytecode before deployment", async function () {
		const parsed = parseCoreDependencyReport(report(), { network: "arbitrum", chainId: 42161, live: true })
		await assertDependencyAddressesHaveCode(parsed, async () => "0x6000")
		let error: unknown
		try {
			await assertDependencyAddressesHaveCode(parsed, async address => (address === parsed.addresses.instantLayer ? "0x" : "0x6000"))
		} catch (caught) {
			error = caught
		}
		expect(String(error)).to.include("DEPENDENCY_UNAVAILABLE")
		expect(String(error)).to.include("InstantLayer")
	})

	it("rejects network name, chain id, and target-mode mismatches", function () {
		const target = { name: "arbitrum", chainId: 42161, mode: "live" as const }
		expect(() => assertRecipeNetworkTarget(target, { network: "arbitrum", chainId: 42161, simulated: false })).not.to.throw()
		expect(() => assertRecipeNetworkTarget(target, { network: "base", chainId: 42161, simulated: false })).to.throw("RECIPE_NETWORK_MISMATCH")
		expect(() => assertRecipeNetworkTarget(target, { network: "arbitrum", chainId: 8453, simulated: false })).to.throw("RECIPE_NETWORK_MISMATCH")
		expect(() => assertRecipeNetworkTarget(target, { network: "arbitrum", chainId: 42161, simulated: true })).to.throw("RECIPE_NETWORK_MISMATCH")
	})

	it("produces deterministic safe checkpoint and report scopes", function () {
		expect(componentCheckpointScope("arbitrum-v086", "partyB")).to.equal("component-arbitrum-v086-partyB")
		expect(componentReportRelativePath("arbitrum-v086", "symbolManager")).to.equal("components/arbitrum-v086/symbolManager-report.json")
		expect(() => componentReportRelativePath("../escape", "partyB")).to.throw("Invalid deployment checkpoint scope")
	})

	it("fails closed for ExpressProvider with a stable capability code", function () {
		expect(() => assertExpressProviderSupported({ name: "arbitrum", chainId: 42161, mode: "live" })).to.throw("LIVE_TARGET_UNSUPPORTED")
	})

	it("does not report pending Safe handover checks as healthy completion", function () {
		expect(summarizeComponentHealth([{ check: "core registration", status: "pending" }])).to.equal("pending")
		expect(
			summarizeComponentHealth([
				{ check: "runtime bytecode", status: "passed" },
				{ check: "core registration", status: "pending" },
			]),
		).to.equal("pending")
		expect(summarizeComponentHealth([{ check: "runtime bytecode", status: "failed" }])).to.equal("failed")
	})

	it("refuses component creation when neither deployer nor report admin can execute deferred wiring", async function () {
		const dependency = parseCoreDependencyReport(report(), { network: "arbitrum", chainId: 42161, live: true })
		const fakeEthers = {
			isAddress: ethers.isAddress,
			getAddress: ethers.getAddress,
			keccak256: ethers.keccak256,
			toUtf8Bytes: ethers.toUtf8Bytes,
			getContractAt: async (name: string) =>
				name.includes("ViewFacet")
					? { hasRole: async () => false, isRoleAdmin: async () => false }
					: { SETTER_ROLE: async () => ethers.ZeroHash, hasRole: async () => false },
		}
		let error: unknown
		try {
			await assertComponentDeploymentAuthority(fakeEthers, "partyB", dependency, "0x0000000000000000000000000000000000000005")
		} catch (caught) {
			error = caught
		}
		expect(String(error)).to.include("AUTHORITY_MISSING")
		expect(String(error)).to.include("PARTY_B_MANAGER_ROLE")
	})
})
