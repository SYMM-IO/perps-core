import {
	allowsLocalDummyDeployer,
	assertCoreDependencyAdmin,
	assertDoctorSelectionSupported,
	checkpointDisposition,
	doctorCheckpointScope,
	componentPreflightSummary,
	deploymentAccountingProblems,
	deploymentComponentProblems,
	deploymentComponentProblemsForSelection,
	isPartialAddonPreflight,
	isMainnetAdminDeployer,
	parseRpcChainId,
	resolveDoctorRecipeContext,
	verifierRepairAuthorityVerdict,
} from "../commands/doctor.js";
import assert from "node:assert/strict";
import test from "node:test";

test("doctor parses the actual eth_chainId wire response", () => {
	assert.equal(parseRpcChainId("0xa4b1"), 42161);
	assert.equal(parseRpcChainId("8453"), 8453);
	assert.throws(() => parseRpcChainId("not-a-chain"), /invalid eth_chainId response/);
	assert.throws(() => parseRpcChainId("0x0"), /out of range/);
});

test("doctor blocks a deployer-admin pair on mainnet", () => {
	const address = "0x0000000000000000000000000000000000000001";
	assert.equal(isMainnetAdminDeployer(address, address.toUpperCase().replace("0X", "0x"), true), true);
	assert.equal(isMainnetAdminDeployer(address, address, false), false);
});

test("doctor mirrors PartyB and SymbolManager component requirements", () => {
	const valid = "0x0000000000000000000000000000000000000001";
	assert.deepEqual(deploymentComponentProblems({ PARTYB_SIGNER: valid, SYMBOL_MANAGER_OPERATOR: valid }).problems, []);
	const missing = deploymentComponentProblems({});
	assert.equal(missing.deployPartyB, true);
	assert.equal(missing.deploySymbolManager, true);
	assert.ok(missing.problems.some(([message]) => message.includes("PARTYB_SIGNER is required")));
	assert.ok(missing.problems.some(([message]) => message.includes("SYMBOL_MANAGER_OPERATOR is required")));

	const contradictory = deploymentComponentProblems({
		DEPLOY_PARTYB: "false",
		PARTYB_SIGNER: valid,
		SET_ADL_ENABLED: "true",
		DEPLOY_SYMBOL_MANAGER: "false",
		SYMBOL_MANAGER_OPERATOR: valid,
	});
	assert.equal(contradictory.problems.length, 3);
});

test("doctor requires and validates liquidation accounting for production-shaped runs", () => {
	const vault = "0x0000000000000000000000000000000000000006";
	const collector = "0x0000000000000000000000000000000000000007";
	assert.equal(deploymentAccountingProblems({}, { productionShape: true }).length, 3);
	assert.deepEqual(
		deploymentAccountingProblems(
			{
				LIQUIDATION_INSURANCE_VAULT: vault,
				MAX_LIQUIDATION_PROFIT_PER_POSITION: "100000000000000000000",
				SOFT_LIQUIDATION_PENALTY_COLLECTOR: collector,
			},
			{ productionShape: true },
		),
		[],
	);
	assert.ok(deploymentAccountingProblems({ LIQUIDATION_INSURANCE_VAULT: "0x0" }).some(([message]) => message.includes("valid non-zero address")));
	assert.ok(
		deploymentAccountingProblems({ MAX_LIQUIDATION_PROFIT_PER_POSITION: (1n << 256n).toString() }).some(([message]) =>
			message.includes("fit in uint256"),
		),
	);
});

test("doctor defers unknown keystore verifier authority instead of claiming the signer lacks it", () => {
	const repairItems = ["gateway signer missing Trading"];
	assert.equal(verifierRepairAuthorityVerdict([], null, undefined), "ok");
	assert.equal(verifierRepairAuthorityVerdict(repairItems, null, undefined), "deferred");
	assert.equal(verifierRepairAuthorityVerdict(repairItems, "0x0000000000000000000000000000000000000001", true), "repairable");
	assert.equal(verifierRepairAuthorityVerdict(repairItems, "0x0000000000000000000000000000000000000001", false), "blocked");
});

test("doctor describes checkpoint handling from the requested deployment mode", () => {
	const checkpoint = { _path: "/tmp/checkpoint.json", step: "diamond" };
	assert.equal(checkpointDisposition(null).kind, "none");
	assert.equal(checkpointDisposition(checkpoint).kind, "resume");
	assert.match(
		checkpointDisposition(checkpoint, { target: "deploy:component --component partyB" }).message,
		/deploy:component --component partyB would RESUME/,
	);
	const fresh = checkpointDisposition(checkpoint, { fresh: true });
	assert.equal(fresh.kind, "archive");
	assert.match(fresh.message, /--fresh will archive it and start a new deployment/);
	assert.equal(checkpointDisposition({ ...checkpoint, _corrupt: true }, { fresh: true }).kind, "corrupt");
});

test("doctor rejects standalone Core consistently before any preflight work", () => {
	assert.throws(() => assertDoctorSelectionSupported("core"), /Core is a system bundle/);
	assert.doesNotThrow(() => assertDoctorSelectionSupported("partyB"));
});

test("doctor always requests a deployment plan, including full recipe preflight", () => {
	let received;
	const context = { plan: { only: null, components: [] } };
	const loader = (configPath, options) => {
		received = { configPath, options };
		return context;
	};
	assert.equal(resolveDoctorRecipeContext({ config: "deployment-recipes/release.json" }, {}, loader), context);
	assert.deepEqual(received, { configPath: "deployment-recipes/release.json", options: { only: undefined } });
	assert.throws(
		() => resolveDoctorRecipeContext({ config: "deployment-recipes/release.json" }, {}, () => ({ plan: null })),
		/requires a validated deployment plan/,
	);
});

test("component-only doctor uses the exact component checkpoint scope", () => {
	const context = { recipe: { name: "release-1" } };
	assert.equal(isPartialAddonPreflight(context, "partyB"), true);
	assert.equal(doctorCheckpointScope(context, "partyB"), "component-release-1-partyB");
	assert.equal(doctorCheckpointScope(context, "symbolManager"), "component-release-1-symbolManager");
	assert.equal(doctorCheckpointScope(context, "expressProvider"), "component-release-1-expressProvider");
	assert.equal(doctorCheckpointScope(context, "gaslessLayer"), "component-release-1-gaslessLayer");
	assert.equal(doctorCheckpointScope(context, undefined), undefined);
});

test("component-only doctor validates only the selected add-on inputs", () => {
	const signer = "0x0000000000000000000000000000000000000001";
	const operator = "0x0000000000000000000000000000000000000002";
	assert.deepEqual(deploymentComponentProblemsForSelection({ PARTYB_SIGNER: signer }, "partyB").problems, []);
	assert.deepEqual(deploymentComponentProblemsForSelection({ SYMBOL_MANAGER_OPERATOR: operator }, "symbolManager").problems, []);
	assert.deepEqual(deploymentComponentProblemsForSelection({}, "expressProvider").problems, []);
	assert.deepEqual(deploymentComponentProblemsForSelection({}, "gaslessLayer").problems, []);
	assert.ok(
		deploymentComponentProblemsForSelection({ SYMBOL_MANAGER_OPERATOR: operator }, "partyB").problems.some(([message]) =>
			message.includes("PARTYB_SIGNER is required"),
		),
	);
});

test("partial doctor reports dependencies from the selected plan row", () => {
	const plan = {
		components: [
			{ name: "core", mode: "reuse", dependsOn: [] },
			{ name: "partyB", mode: "deploy", dependsOn: ["core"] },
		],
	};
	assert.equal(componentPreflightSummary(plan, "partyB"), "partyB; dependencies: core");
	assert.throws(() => componentPreflightSummary(plan, "symbolManager"), /does not contain selected component/);
});

test("partial doctor binds reused Core admin to recipe governance", () => {
	const admin = "0x0000000000000000000000000000000000000001";
	assert.doesNotThrow(() => assertCoreDependencyAdmin({ config: { admin: admin.toUpperCase().replace("0X", "0x") } }, admin));
	assert.throws(
		() => assertCoreDependencyAdmin({ config: { admin: "0x0000000000000000000000000000000000000002" } }, admin),
		/governance.admin.*does not match core report config.admin/,
	);
});

test("localhost recipes use Hardhat's unlocked local signer flow", () => {
	const localhost = { key: "localhost", chainId: 31337 };
	assert.equal(allowsLocalDummyDeployer(localhost, { network: { mode: "local" } }), true);
	assert.equal(allowsLocalDummyDeployer(localhost, { network: { mode: "live" } }), false);
	assert.equal(allowsLocalDummyDeployer({ key: "arbitrum", chainId: 42161 }, { network: { mode: "live" } }), false);
});
