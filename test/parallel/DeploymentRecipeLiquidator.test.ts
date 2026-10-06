import { expect } from "chai"

import { createDeploymentPlan, validateDeploymentRecipe } from "../../deployment-tooling/recipe.js"

/**
 * Smallest recipe that still validates, so the assertions below are about the optional
 * liquidator add-on rather than about unrelated required sections.
 */
function recipe(): any {
	return {
		apiVersion: "deployment.symm.io/v1",
		kind: "DeploymentRecipe",
		name: "liquidator-fixture",
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

describe("recipe liquidator add-on", function () {
	const operator = "0x7000000000000000000000000000000000000007"

	it("accepts a deploy-mode liquidator with a valid admin and operator", function () {
		const source = recipe()
		source.liquidator = { mode: "deploy", admin: "0x6000000000000000000000000000000000000006", operators: [operator] }
		expect(() => validateDeploymentRecipe(source)).to.not.throw()
	})

	it("rejects a malformed liquidator.admin before any transaction can run", function () {
		const source = recipe()
		source.liquidator = { mode: "deploy", admin: "not-an-address", operators: [operator] }
		expect(() => validateDeploymentRecipe(source)).to.throw("liquidator.admin")
	})

	it("requires at least one unique liquidator operator before deployment", function () {
		const missing = recipe()
		missing.liquidator = { mode: "deploy" }
		expect(() => validateDeploymentRecipe(missing)).to.throw("liquidator.operators")

		const duplicate = recipe()
		duplicate.liquidator = { mode: "deploy", operators: [operator, operator.toLowerCase()] }
		expect(() => validateDeploymentRecipe(duplicate)).to.throw("duplicates")
	})

	it("includes a declared liquidator in the full-run deployment plan", function () {
		const source = recipe()
		source.liquidator = { mode: "deploy", operators: [operator] }
		const plan = createDeploymentPlan(source)
		const component = plan.components.find((entry: any) => entry.name === "liquidator")
		expect(component, "liquidator missing from plan components").to.not.equal(undefined)
		expect(component!.mode).to.equal("deploy")
		expect(component!.dependsOn).to.deep.equal(["core"])
		expect(component!.actions).to.deep.equal([
			{ id: "deploy-proxy", target: "SymmioLiquidator", operation: "deploy" },
			{
				id: `grant-operator-${operator.toLowerCase()}`,
				target: "SymmioLiquidator",
				operation: "grantRole",
				role: "OPERATOR_ROLE",
				account: operator,
			},
			{ id: "grant-core-liquidator-role", target: "core", operation: "grantRole", role: "LIQUIDATOR_ROLE" },
			{ id: "grant-core-partyb-liquidator-role", target: "core", operation: "grantRole", role: "PARTYB_LIQUIDATOR_ROLE" },
		])
	})

	it("omits the liquidator from the plan when the recipe does not declare one", function () {
		const plan = createDeploymentPlan(recipe())
		expect(plan.components.some((entry: any) => entry.name === "liquidator")).to.equal(false)
	})

	it("rejects liquidator reuse in a full run, matching the other add-ons", function () {
		const source = recipe()
		source.liquidator = { mode: "reuse", address: operator }
		expect(() => createDeploymentPlan(source)).to.throw("TARGET_MODE_UNSUPPORTED")
	})
})
