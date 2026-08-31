import { expect } from "chai"

import { recipeEnvironment, validateDeploymentRecipe } from "../../deployment-tooling/recipe.js"

/**
 * Smallest recipe that still validates, so the assertions below are about the Muon
 * override field rather than about unrelated required sections.
 */
function recipe(): any {
	return {
		apiVersion: "deployment.symm.io/v1",
		kind: "DeploymentRecipe",
		name: "muon-upnl-override-fixture",
		network: { name: "arbitrum", chainId: 42161, mode: "live" },
		secrets: {
			deployer: "hardhat-keystore://DEPLOYER",
			rpc: "hardhat-keystore://RPC",
			explorer: "hardhat-keystore://EXPLORER",
		},
		execution: { logLevel: "minimal", verify: true, confirmations: 1 },
		governance: {
			admin: "0x1000000000000000000000000000000000000001",
			feeReceiver: "0x2000000000000000000000000000000000000002",
			liquidationInsuranceVault: "0x3000000000000000000000000000000000000003",
			maxLiquidationProfitPerPosition: "100000000000000000000",
			softLiquidationPenaltyCollector: "0x4000000000000000000000000000000000000004",
		},
		core: {
			mode: "deploy",
			collateral: { mode: "reuse", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
			muon: {
				mode: "deploy",
				appId: "1",
				upnlValidTime: "60",
				priceValidTime: "60",
				publicKey: { x: "2", parity: 0 },
				gatewaySigners: ["0x5000000000000000000000000000000000000005"],
				permissions: [
					"Trading",
					"AccountManagement",
					"Settlement",
					"ForceClose",
					"Funding",
					"LiquidationPartyA",
					"LiquidationPartyB",
					"RemoveMargin",
					"ExpressCredit",
				],
			},
			protocol: {
				parameters: {
					balanceLimitPerUser: "1000000000000000000000000",
					maxWithdrawParts: 10,
					deallocateCooldown: 259200,
					settlementCooldown: 300,
					deallocateDebounceTime: 0,
					liquidatorShare: "100000000000000000",
					liquidationTimeout: 100,
					forceCloseCooldowns: [300, 120],
					forceCancelCooldown: 300,
					forceCancelCloseCooldown: 300,
					pendingQuotesValidLength: 10,
					maxPartyAConnectionLimit: 5,
				},
				instantLayerTemplates: [{ name: "InstantClose", operations: [{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }] }],
			},
			setupInstantLayerTemplates: false,
			registerDummyAffiliate: false,
		},
		partyB: { mode: "skip", adlEnabled: false },
		symbolManager: { mode: "skip" },
		expressProvider: { mode: "skip" },
		gaslessLayer: { mode: "skip" },
	}
}

describe("recipe Muon UPNL validity overrides", function () {
	it("projects nothing when the recipe declares no overrides", function () {
		expect(recipeEnvironment(recipe()).env.MUON_FUNCTION_UPNL_VALID_TIMES).to.equal("")
	})

	it("projects declared overrides in canonical MuonFunction order regardless of source order", function () {
		const source = recipe()
		source.core.muon.upnlValidTimeByFunction = { RemoveMargin: "90", Trading: "30", Settlement: "120" }
		expect(recipeEnvironment(source).env.MUON_FUNCTION_UPNL_VALID_TIMES).to.equal("Trading=30,Settlement=120,RemoveMargin=90")
	})

	it("accepts overrides alongside a mock verifier, which is core state rather than verifier state", function () {
		const source = recipe()
		source.network.mode = "local"
		source.core.muon = { mode: "mock", upnlValidTime: "60", priceValidTime: "60", upnlValidTimeByFunction: { Funding: "45" } }
		expect(recipeEnvironment(source).env.MUON_FUNCTION_UPNL_VALID_TIMES).to.equal("Funding=45")
	})

	it("projects nothing when core is not being deployed", function () {
		const source = recipe()
		source.core.muon.upnlValidTimeByFunction = { Trading: "30" }
		source.core.mode = "reuse"
		source.core.fromReport = "deployment-recipes/core.json"
		expect(recipeEnvironment(source).env.MUON_FUNCTION_UPNL_VALID_TIMES).to.equal("")
	})

	it("rejects unknown functions, non-canonical integers, and the zero sentinel", function () {
		for (const [label, value] of [
			["unknown function", { RemoveFunds: "30" }],
			["ExpressCredit is not a Core UPNL function", { ExpressCredit: "30" }],
			["zero", { Trading: "0" }],
			["number instead of string", { Trading: 30 }],
			["leading zero", { Trading: "030" }],
			["array", ["Trading"]],
		] as Array<[string, unknown]>) {
			const source = recipe()
			source.core.muon.upnlValidTimeByFunction = value
			expect(() => validateDeploymentRecipe(source), label).to.throw("core.muon.upnlValidTimeByFunction")
		}
	})
})
