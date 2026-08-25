import { expect } from "chai"

import { deploymentOnlyArtifact } from "../../tasks/deploy/artifacts.js"
import { assertDeploymentRecordPolicy, parseBooleanSetting, validateDeploymentConfig } from "../../tasks/deploy/deployAll.js"
import { MUON_FUNCTION_NAMES } from "../../tasks/deploy/muonPermissions.js"
import { DEFAULT_PROTOCOL_CONFIG } from "../../tasks/deploy/protocolConfig.js"
import {
	assertMainnetDeploymentIdentitySafe,
	assertMainnetSafe,
	assertStandaloneDeploymentTaskAllowed,
	collectMainnetSafetyViolations,
} from "../../tasks/deploy/safety.js"

const ZERO_ADDRESS = `0x${"0".repeat(40)}`
const fakeEthers = {
	ZeroAddress: ZERO_ADDRESS,
	isAddress: (value: unknown) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value),
	getAddress: (value: string) => value,
	provider: { getCode: async () => "0x01" },
	getContractAt: async () => ({
		decimals: async () => 6,
		totalSupply: async () => BigInt(1),
		balanceOf: async () => BigInt(0),
		getAllPublicKeys: async () => [{ x: BigInt(1), parity: BigInt(0) }],
		getAllGatewaySigners: async () => [`0x${"9".repeat(40)}`],
		supportsMuonFunction: async () => true,
	}),
}

function deploymentConfig(): any {
	return {
		admin: `0x${"1".repeat(40)}`,
		symmioFeeReceiver: `0x${"2".repeat(40)}`,
		liquidationInsuranceVault: `0x${"6".repeat(40)}`,
		maxLiquidationProfitPerPosition: "100000000000000000000",
		softLiquidationPenaltyCollector: `0x${"7".repeat(40)}`,
		collateralAddress: "",
		deployPartyB: true,
		setAdlEnabled: false,
		deploySymbolManager: true,
		registerDummyAffiliate: false,
		partyBSigner: `0x${"5".repeat(40)}`,
		symbolManagerOperator: `0x${"4".repeat(40)}`,
		setupInstantLayerTemplates: true,
		signatureVerifierAddress: "",
		deployMockVerifier: true,
		muonAppId: "",
		muonUpnlValidTime: "300",
		muonPriceValidTime: "300",
		muonPublicKeyX: "",
		muonPublicKeyParity: "",
		muonGatewaySigners: [],
		muonFunctionPermissions: [],
		muonFunctionUpnlValidTimes: [],
	}
}

async function expectRejection(promise: Promise<unknown>, expectedMessage: string) {
	try {
		await promise
		expect.fail("expected promise to reject")
	} catch (err) {
		expect(err instanceof Error ? err.message : String(err)).to.include(expectedMessage)
	}
}

describe("deploy:system input parsing", function () {
	it("parses explicit booleans and preserves the requested default", function () {
		expect(parseBooleanSetting("true", "TEST_FLAG", false)).to.equal(true)
		expect(parseBooleanSetting("false", "TEST_FLAG", true)).to.equal(false)
		expect(parseBooleanSetting(undefined, "TEST_FLAG", true)).to.equal(true)
	})

	it("rejects every ambiguous boolean spelling", function () {
		for (const value of ["", "TRUE", "False", "1", "0", "yes", "no", " true "]) {
			expect(() => parseBooleanSetting(value, "TEST_FLAG", false)).to.throw('TEST_FLAG must be exactly "true" or "false"')
		}
	})

	it("requires durable verification records on every live deployment", function () {
		expect(() => assertDeploymentRecordPolicy(42161, false, false)).to.throw("--log-data false is refused")
		expect(() => assertDeploymentRecordPolicy(31337, false, false)).not.to.throw()
		expect(() => assertDeploymentRecordPolicy(42161, true, false)).not.to.throw()
		expect(() => assertDeploymentRecordPolicy(42161, false, true)).not.to.throw()
	})

	it("validates deployment addresses and Muon values before any transaction", async function () {
		await validateDeploymentConfig(fakeEthers, 31337, deploymentConfig(), structuredClone(DEFAULT_PROTOCOL_CONFIG))

		const zeroAdmin = deploymentConfig()
		zeroAdmin.admin = ZERO_ADDRESS
		await expectRejection(
			validateDeploymentConfig(fakeEthers, 31337, zeroAdmin, structuredClone(DEFAULT_PROTOCOL_CONFIG)),
			"must not be the zero address",
		)

		const incompletePublicKey = deploymentConfig()
		incompletePublicKey.muonPublicKeyX = "123"
		await expectRejection(
			validateDeploymentConfig(fakeEthers, 31337, incompletePublicKey, structuredClone(DEFAULT_PROTOCOL_CONFIG)),
			"must either both be set or both be omitted",
		)

		const invalidParity = deploymentConfig()
		invalidParity.muonPublicKeyX = "123"
		invalidParity.muonPublicKeyParity = "2"
		await expectRejection(
			validateDeploymentConfig(fakeEthers, 31337, invalidParity, structuredClone(DEFAULT_PROTOCOL_CONFIG)),
			'MUON_PUBLIC_KEY_PARITY must be exactly "0" or "1"',
		)

		// Zero is the on-chain "unset" sentinel, so it must never reach setMuonFunctionUpnlValidTime.
		const zeroOverride = deploymentConfig()
		zeroOverride.muonFunctionUpnlValidTimes = [{ name: "Trading", index: 0, upnlValidTime: "0" }]
		await expectRejection(
			validateDeploymentConfig(fakeEthers, 31337, zeroOverride, structuredClone(DEFAULT_PROTOCOL_CONFIG)),
			"MUON_FUNCTION_UPNL_VALID_TIMES.Trading must be >= 1",
		)
	})

	it("requires complete real-verifier inputs on a production chain", async function () {
		const config = deploymentConfig()
		config.deployMockVerifier = false
		config.collateralAddress = `0x${"3".repeat(40)}`
		await expectRejection(validateDeploymentConfig(fakeEthers, 42161, config, structuredClone(DEFAULT_PROTOCOL_CONFIG)), "MUON_APP_ID is required")
	})

	it("requires reviewed liquidation accounting on production-shaped chains", async function () {
		for (const [field, envName] of [
			["liquidationInsuranceVault", "LIQUIDATION_INSURANCE_VAULT"],
			["maxLiquidationProfitPerPosition", "MAX_LIQUIDATION_PROFIT_PER_POSITION"],
			["softLiquidationPenaltyCollector", "SOFT_LIQUIDATION_PENALTY_COLLECTOR"],
		] as const) {
			const config = deploymentConfig()
			config[field] = ""
			await expectRejection(validateDeploymentConfig(fakeEthers, 42161, config, structuredClone(DEFAULT_PROTOCOL_CONFIG)), `${envName} is required`)
		}
	})

	it("uses explicit local-only liquidation defaults and rejects invalid caps", async function () {
		const local = deploymentConfig()
		local.liquidationInsuranceVault = ""
		local.maxLiquidationProfitPerPosition = ""
		local.softLiquidationPenaltyCollector = ""
		await validateDeploymentConfig(fakeEthers, 31337, local, structuredClone(DEFAULT_PROTOCOL_CONFIG))
		expect(local.liquidationInsuranceVault).to.equal(local.admin)
		expect(local.maxLiquidationProfitPerPosition).to.equal("100000000000000000000")
		expect(local.softLiquidationPenaltyCollector).to.equal(local.admin)

		for (const value of ["0", "-1", "1.5", "abc", (1n << 256n).toString()]) {
			const invalid = deploymentConfig()
			invalid.maxLiquidationProfitPerPosition = value
			await expectRejection(
				validateDeploymentConfig(fakeEthers, 31337, invalid, structuredClone(DEFAULT_PROTOCOL_CONFIG)),
				"MAX_LIQUIDATION_PROFIT_PER_POSITION",
			)
		}
	})

	it("rejects collateral decimals the core setter cannot accept", async function () {
		const config = deploymentConfig()
		config.collateralAddress = `0x${"3".repeat(40)}`
		const ethersWithUnsupportedCollateral = {
			...fakeEthers,
			getContractAt: async () => ({
				decimals: async () => 19,
				totalSupply: async () => 1n,
				balanceOf: async () => 0n,
			}),
		}
		await expectRejection(
			validateDeploymentConfig(ethersWithUnsupportedCollateral, 31337, config, structuredClone(DEFAULT_PROTOCOL_CONFIG)),
			"invalid decimals value 19",
		)
	})

	it("requires and accepts the complete nine-category real-verifier profile on every chain", async function () {
		const incomplete = deploymentConfig()
		incomplete.deployMockVerifier = false
		incomplete.muonAppId = "1"
		incomplete.muonPublicKeyX = "123"
		incomplete.muonPublicKeyParity = "0"
		incomplete.muonGatewaySigners = [`0x${"9".repeat(40)}`]
		incomplete.muonFunctionPermissions = MUON_FUNCTION_NAMES.slice(0, -1)
		await expectRejection(validateDeploymentConfig(fakeEthers, 31337, incomplete, structuredClone(DEFAULT_PROTOCOL_CONFIG)), "missing: ExpressCredit")

		const complete = deploymentConfig()
		complete.deployMockVerifier = false
		complete.muonAppId = "1"
		complete.muonPublicKeyX = "123"
		complete.muonPublicKeyParity = "0"
		complete.muonGatewaySigners = [`0x${"9".repeat(40)}`]
		complete.muonFunctionPermissions = [...MUON_FUNCTION_NAMES]
		await validateDeploymentConfig(fakeEthers, 31337, complete, structuredClone(DEFAULT_PROTOCOL_CONFIG))
	})

	it("fails closed when an existing verifier needs permission repair and the deployer lacks SETTER_ROLE", async function () {
		const deployer = `0x${"a".repeat(40)}`
		const existingKey = { x: BigInt(123), parity: BigInt(0) }
		const existingGateway = `0x${"9".repeat(40)}`
		const existingVerifier = (deployerCanRepair: boolean) => ({
			getAllPublicKeys: async () => [existingKey],
			getAllGatewaySigners: async () => [existingGateway],
			DEFAULT_ADMIN_ROLE: async () => "default-admin",
			SETTER_ROLE: async () => "setter",
			hasRole: async (role: string, account: string) => {
				if (account.toLowerCase() === deployer.toLowerCase()) return role === "setter" && deployerCanRepair
				return account.toLowerCase() === `0x${"1".repeat(40)}`.toLowerCase()
			},
			isPublicKeyAuthorized: async () => false,
			isGatewaySignerAuthorized: async () => false,
			supportsMuonFunction: async () => true,
		})
		const ethersWithVerifier = (deployerCanRepair: boolean) => ({
			...fakeEthers,
			getSigners: async () => [{ address: deployer }],
			getContractAt: async () => existingVerifier(deployerCanRepair),
		})
		const config = deploymentConfig()
		config.deployMockVerifier = false
		config.signatureVerifierAddress = `0x${"8".repeat(40)}`
		config.muonAppId = "1"
		config.muonFunctionPermissions = [...MUON_FUNCTION_NAMES]

		await expectRejection(
			validateDeploymentConfig(ethersWithVerifier(false), 31337, structuredClone(config), structuredClone(DEFAULT_PROTOCOL_CONFIG)),
			"lacks SETTER_ROLE",
		)
		await validateDeploymentConfig(ethersWithVerifier(true), 31337, structuredClone(config), structuredClone(DEFAULT_PROTOCOL_CONFIG))
	})

	it("rejects an existing verifier that does not advertise RemoveMargin support", async function () {
		const config = deploymentConfig()
		config.deployMockVerifier = false
		config.signatureVerifierAddress = `0x${"8".repeat(40)}`

		const ethersWithIncompatibleVerifier = {
			...fakeEthers,
			getContractAt: async () => ({ supportsMuonFunction: async () => false }),
		}
		await expectRejection(
			validateDeploymentConfig(ethersWithIncompatibleVerifier, 31337, config, structuredClone(DEFAULT_PROTOCOL_CONFIG)),
			"does not support MuonFunction.RemoveMargin (index 7)",
		)
	})

	it("requires an explicit operator for every SymbolManager deployment", async function () {
		const config = deploymentConfig()
		config.symbolManagerOperator = ""
		await expectRejection(
			validateDeploymentConfig(fakeEthers, 31337, config, structuredClone(DEFAULT_PROTOCOL_CONFIG)),
			"SYMBOL_MANAGER_OPERATOR is required",
		)
	})

	it("requires an explicit signer for every PartyB deployment", async function () {
		const config = deploymentConfig()
		config.partyBSigner = ""
		await expectRejection(validateDeploymentConfig(fakeEthers, 31337, config, structuredClone(DEFAULT_PROTOCOL_CONFIG)), "PARTYB_SIGNER is required")
	})
})

describe("deploy:system mainnet safety", function () {
	const deployer = `0x${"a".repeat(40)}`

	it("rejects an implicit admin and deployer-as-admin on mainnet", function () {
		const violations = collectMainnetSafetyViolations(42161, deployer, {
			deployMockVerifier: false,
			collateralAddress: `0x${"3".repeat(40)}`,
			registerDummyAffiliate: false,
			adminAddress: deployer,
			adminWasExplicit: false,
		})
		expect(violations.map(violation => violation.id)).to.include.members(["missing-admin", "admin-is-deployer"])
	})

	it("requires a chain-bound second confirmation for unsafe mainnet overrides", function () {
		const config = {
			deployMockVerifier: true,
			collateralAddress: `0x${"3".repeat(40)}`,
			registerDummyAffiliate: false,
			adminAddress: `0x${"b".repeat(40)}`,
			adminWasExplicit: true,
		}
		const previous = process.env.UNSAFE_MAINNET_CONFIRM_CHAIN_ID
		delete process.env.UNSAFE_MAINNET_CONFIRM_CHAIN_ID
		try {
			expect(() => assertMainnetSafe(42161, deployer, config, true, false)).to.throw("UNSAFE_MAINNET_CONFIRM_CHAIN_ID=42161")
		} finally {
			if (previous === undefined) delete process.env.UNSAFE_MAINNET_CONFIRM_CHAIN_ID
			else process.env.UNSAFE_MAINNET_CONFIRM_CHAIN_ID = previous
		}
	})

	it("applies the production signer/admin guard to standalone component workflows", function () {
		expect(() => assertMainnetDeploymentIdentitySafe(42161, deployer, deployer)).to.throw("ADMIN_PUBLIC_KEY")
		expect(() => assertMainnetDeploymentIdentitySafe(42161, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", `0x${"b".repeat(40)}`)).to.throw(
			"publicly-known key",
		)
		expect(() => assertMainnetDeploymentIdentitySafe(42161, deployer, `0x${"b".repeat(40)}`)).not.to.throw()
	})

	it("keeps low-level component deployment tasks local or simulated only", function () {
		expect(() => assertStandaloneDeploymentTaskAllowed("deploy:diamond", 31337, false)).not.to.throw()
		expect(() => assertStandaloneDeploymentTaskAllowed("deploy:diamond", 42161, true)).not.to.throw()
		expect(() => assertStandaloneDeploymentTaskAllowed("deploy:diamond", 42161, false)).to.throw("refused on live RPC chainId 42161")
		expect(() => assertStandaloneDeploymentTaskAllowed("deploy:diamond", 11155111, false)).to.throw("no durable standalone transaction journal")
	})
})

describe("deployment ABI logging hygiene", function () {
	it("uses a non-callable deployment ABI without changing bytecode or links", function () {
		const artifact = {
			abi: [{ name: "validateForceCloseConditions", inputs: [{ internalType: "enum MuonFunction", type: "MuonFunction" }] }],
			bytecode: "0x1234",
			linkReferences: { "Lib.sol": { Lib: [{ start: 1, length: 20 }] } },
		}
		const deploymentArtifact = deploymentOnlyArtifact(artifact)
		expect(deploymentArtifact.abi).to.deep.equal([])
		expect(deploymentArtifact.bytecode).to.equal(artifact.bytecode)
		expect(deploymentArtifact.linkReferences).to.equal(artifact.linkReferences)
		expect(artifact.abi).to.have.length(1)
		expect(() => deploymentOnlyArtifact({ ...artifact, abi: [{ type: "constructor", inputs: [{ type: "address" }] }] })).to.throw(
			"only safe for contracts without constructor arguments",
		)
	})
})
