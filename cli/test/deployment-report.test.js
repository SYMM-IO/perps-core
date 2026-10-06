import { normalizeDeploymentSummary, renderDeploymentMarkdown, renderDeploymentTerminal } from "../../deployment-tooling/deployment-report.js";
import assert from "node:assert/strict";
import test from "node:test";

const A = index => `0x${String(index).padStart(40, "0")}`;

function completeReportFixture() {
	return {
		deploymentId: "complete-fixture",
		network: "arbitrum",
		chainId: 42161,
		lifecycle: "complete",
		updatedAt: "2026-08-31T00:00:00.000Z",
		recipe: { name: "arbitrum", digest: "a".repeat(64) },
		checks: { health: "passed", verification: "passed", verificationPolicy: "required" },
		transactions: [{ hash: `0x${"1".repeat(64)}` }],
		governance: { address: A(7), type: "eoa" },
		config: { admin: A(7), collateralAddress: A(2), symmioFeeReceiver: A(8), symbolManagerOperator: A(17) },
		addresses: {
			diamond: A(1),
			collateral: A(2),
			accountLayerDiamond: A(3),
			instantLayer: A(4),
			expressProvider: A(5),
			signatureVerifier: A(6),
			symbolManager: A(9),
			create2Factory: A(10),
			gaslessLayer: A(11),
			gaslessLayerImplementation: A(12),
			symmioLiquidator: A(13),
			symmioLiquidatorImplementation: A(14),
			symmioPartyB: A(15),
			symmioPartyBImplementation: A(16),
		},
		governanceActions: [],
	};
}

test("complete report contains every important address", () => {
	const summary = normalizeDeploymentSummary(completeReportFixture(), { explorer: "https://arbiscan.io" });
	const terminal = renderDeploymentTerminal(summary);
	const markdown = renderDeploymentMarkdown(summary);
	for (const label of [
		"Symmio Core",
		"Collateral",
		"AccountLayer",
		"InstantLayer",
		"ExpressProvider",
		"Signature verifier",
		"Governance admin",
		"Fee receiver",
		"SymbolManager",
		"Symbol manager operator",
		"CREATE2 factory",
		"GaslessLayer proxy",
		"GaslessLayer implementation",
		"Liquidator proxy",
		"Liquidator implementation",
		"PartyB proxy",
		"PartyB implementation",
	]) {
		assert.match(terminal, new RegExp(label));
		assert.match(markdown, new RegExp(label));
	}
	assert.match(terminal, /Governance admin \(EOA\)/);
	assert.doesNotMatch(terminal, /multisig/i);
});

test("pending report cannot look complete", () => {
	const report = completeReportFixture();
	report.lifecycle = "pending_handover";
	report.governanceActions = [
		{
			id: "ownership.core",
			method: "acceptOwnership()",
			to: A(1),
			value: "0",
			data: "0x79ba5097",
			description: "Accept Core ownership",
			expectedSigner: A(7),
			postState: { to: A(1), data: "0x893d20e8", expectedResult: "0x" },
		},
	];
	const rendered = renderDeploymentTerminal(normalizeDeploymentSummary(report, { explorer: "https://arbiscan.io" }));
	assert.match(rendered, /^HANDOVER REQUIRED/m);
	assert.match(rendered, /Accept Core ownership/);
	assert.doesNotMatch(rendered, /DEPLOYMENT COMPLETE/);
});
