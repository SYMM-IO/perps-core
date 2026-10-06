export function coreInputFixture(version = 1) {
	const address = digit => "0x" + digit.repeat(40);
	const input = {
		apiVersion: "operations.symm.io/core-upgrade-input-v1",
		kind: "CoreUpgradeInput",
		name: "test-deployment",
		network: { name: "base", chainId: 8453, fork: "fork-base" },
		release: { ref: "target-release", baselineRef: "baseline-release" },
		credentials: {
			deployer: "hardhat-keystore://TEST_DEPLOYER",
			rpc: "hardhat-keystore://TEST_RPC",
			explorer: "hardhat-keystore://TEST_EXPLORER",
		},
		execution: { confirmations: 1, txTimeoutSeconds: 300, slowNoticeSeconds: 30, verify: true, logLevel: "verbose" },
		governance: { kind: "eoa", owner: address("1"), accountLayerOwner: address("1"), signerMode: "ledger", ledgerDerivation: "ledger-live" },
		target: Object.fromEntries(
			[
				"core",
				"collateral",
				"accountLayer",
				"instantLayer",
				"signatureVerifier",
				"symbolManager",
				"gaslessLayer",
				"liquidator",
				"gaslessReceiver",
				"partyB",
				"multicall",
			].map(key => [key, address("2")]),
		),
		limits: { maxQuotes: 10000, maxSymbols: 1000 },
		storage: { legacyAdjustmentWords: 15, upgradedAdjustmentWords: 17, requireEmptyAdjustments: true },
		repairAggregateFunding: true,
		allowedRemovedSelectors: ["0x12345678"],
		roleGrants: [],
	};
	if (version === 2) {
		input.apiVersion = "operations.symm.io/core-upgrade-input-v2";
		input.storage = { symbolAdjustment: input.storage };
		input.funding = { aggregate: { repair: input.repairAggregateFunding } };
		input.selectors = { core: { allowedRemovals: input.allowedRemovedSelectors } };
		delete input.repairAggregateFunding;
		delete input.allowedRemovedSelectors;
	}
	return input;
}
