import { expect } from "chai"

import type { DeploymentRecipe } from "../../deployment-tooling/recipe.js"
import { deploymentConfigFromSource, resolveDeploymentProtocolConfig } from "../../tasks/deploy/deployAll.js"
import { DEFAULT_PROTOCOL_CONFIG } from "../../tasks/deploy/protocolConfig.js"
import { assertExpectedRecipeDigest } from "../../tasks/deploy/recipeRuntime.js"

function recipe(): DeploymentRecipe {
	return {
		name: "task-mapping-test",
		core: { protocol: structuredClone(DEFAULT_PROTOCOL_CONFIG) },
		partyB: { mode: "deploy" },
		symbolManager: { mode: "skip" },
		expressProvider: { mode: "skip" },
		gaslessLayer: { mode: "skip" },
	} as unknown as DeploymentRecipe
}

describe("deploy:system recipe mapping", function () {
	it("requires the CLI-confirmed digest at the Hardhat process boundary", function () {
		const digest = "a".repeat(64)
		expect(() => assertExpectedRecipeDigest(digest, undefined)).to.throw("digest is not pinned")
		expect(() => assertExpectedRecipeDigest(digest, "not-a-digest")).to.throw("Invalid SYMMIO_DEPLOYMENT_RECIPE_DIGEST")
		expect(() => assertExpectedRecipeDigest(digest, "b".repeat(64))).to.throw("changed after confirmation")
		expect(() => assertExpectedRecipeDigest(digest, digest)).not.to.throw()
	})

	it("uses only the supplied recipe projection and ignores ambient public overrides", function () {
		const deploymentRecipe = recipe()
		const originalAmbientAdmin = process.env.ADMIN_PUBLIC_KEY
		process.env.ADMIN_PUBLIC_KEY = "0x9999999999999999999999999999999999999999"
		try {
			const config = deploymentConfigFromSource(
				{
					ADMIN_PUBLIC_KEY: "0x1000000000000000000000000000000000000001",
					SYMMIO_FEE_RECEIVER: "0x2000000000000000000000000000000000000002",
					LIQUIDATION_INSURANCE_VAULT: "0x3000000000000000000000000000000000000003",
					MAX_LIQUIDATION_PROFIT_PER_POSITION: "1",
					SOFT_LIQUIDATION_PENALTY_COLLECTOR: "0x4000000000000000000000000000000000000004",
					COLLATERAL_ADDRESS: "0x5000000000000000000000000000000000000005",
					DEPLOY_PARTYB: "true",
					SET_ADL_ENABLED: "true",
					PARTYB_SIGNER: "0x6000000000000000000000000000000000000006",
					DEPLOY_SYMBOL_MANAGER: "false",
					REGISTER_DUMMY_AFFILIATE: "false",
					SETUP_INSTANT_LAYER_TEMPLATES: "true",
					DEPLOY_MOCK_VERIFIER: "true",
					MUON_UPNL_VALID_TIME: "300",
					MUON_PRICE_VALID_TIME: "300",
				},
				"0x7000000000000000000000000000000000000007",
				deploymentRecipe,
			)
			expect(config.admin).to.equal("0x1000000000000000000000000000000000000001")
			expect(config.adminWasExplicit).to.equal(true)
			expect(config.deployPartyB).to.equal(true)
			expect(config.partyBMode).to.equal("deploy")
			expect(config.deploySymbolManager).to.equal(false)
			expect(config.symbolManagerMode).to.equal("skip")
		} finally {
			if (originalAmbientAdmin === undefined) delete process.env.ADMIN_PUBLIC_KEY
			else process.env.ADMIN_PUBLIC_KEY = originalAmbientAdmin
		}
	})

	it("takes protocol parameters and ordered templates from the inline recipe", function () {
		const deploymentRecipe = recipe()
		deploymentRecipe.core.protocol!.description = "inline sentinel"
		const resolved = resolveDeploymentProtocolConfig(42161, deploymentRecipe)
		expect(resolved).to.equal(deploymentRecipe.core.protocol)
		expect(resolved.description).to.equal("inline sentinel")
	})

	it("validates inline protocol before deployment", function () {
		const deploymentRecipe = recipe()
		deploymentRecipe.core.protocol!.parameters.maxWithdrawParts = 0
		expect(() => resolveDeploymentProtocolConfig(42161, deploymentRecipe)).to.throw("inline protocol config")
	})

	it("maps per-function UPNL validity overrides into canonical enum order", function () {
		const config = deploymentConfigFromSource(
			{
				ADMIN_PUBLIC_KEY: "0x1000000000000000000000000000000000000001",
				MUON_UPNL_VALID_TIME: "300",
				MUON_PRICE_VALID_TIME: "300",
				MUON_FUNCTION_UPNL_VALID_TIMES: "LiquidationPartyA=600,Trading=30",
			},
			"0x7000000000000000000000000000000000000007",
			recipe(),
		)
		expect(config.muonFunctionUpnlValidTimes).to.deep.equal([
			{ name: "Trading", index: 0, upnlValidTime: "30" },
			{ name: "LiquidationPartyA", index: 5, upnlValidTime: "600" },
		])
	})

	it("leaves per-function UPNL validity empty when the recipe declares no overrides", function () {
		const config = deploymentConfigFromSource(
			{
				ADMIN_PUBLIC_KEY: "0x1000000000000000000000000000000000000001",
				MUON_UPNL_VALID_TIME: "300",
				MUON_PRICE_VALID_TIME: "300",
				MUON_FUNCTION_UPNL_VALID_TIMES: "",
			},
			"0x7000000000000000000000000000000000000007",
			recipe(),
		)
		expect(config.muonFunctionUpnlValidTimes).to.deep.equal([])
	})
})
