import {
	assertRoundingFactoryIntent,
	roundingFacets,
	roundingDeployments,
	GETTER,
	planRoundingCut,
} from "../../deployment-tooling/arbitrum-rounding-upgrade.js";
import { createSafeBatch, validateSafeBatchTransport } from "../signer/safe-batch.js";
import {
	bindProductionLedger,
	createArbitrumRoundingUpgradeTask,
	ROUNDING_PLAN,
	PRODUCTION_ROUNDING_PLAN,
} from "../tasks/arbitrum-rounding-upgrade.js";
import { runLedgerPhase } from "../tasks/arbitrum-rounding-upgrade.js";
import { Interface, ZeroAddress } from "ethers";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function fixture(profile = "stage") {
	const baseline = { "0x12345678": "0x1111111111111111111111111111111111111111" };
	const facets = {},
		oldFacets = {};
	for (const [i, name] of roundingFacets(profile).entries()) {
		const old = "0x" + String(i + 2).repeat(40);
		const selector = "0x" + String(i + 2).repeat(8);
		oldFacets[name] = { address: old };
		baseline[selector] = old;
		facets[name] = { address: "0x" + (i + 6).toString(16).repeat(37) + "862", selectors: [selector, ...(name === "ViewFacet" ? [GETTER] : [])] };
	}
	return { baseline, facets, oldFacets };
}

test("rounding cut changes exactly four facets plus the new getter and preserves unrelated selectors", () => {
	const { baseline, facets, oldFacets } = fixture();
	const result = planRoundingCut(baseline, baseline, facets, oldFacets);
	assert.equal(result.desired["0x12345678"], baseline["0x12345678"]);
	assert.equal(
		result.cut.reduce((n, group) => n + group.functionSelectors.length, 0),
		5,
	);
	assert.equal(result.cut.filter(group => group.action === 0).length, 1);
	assert.equal(
		result.cut.some(group => group.action === 2),
		false,
	);
	const iface = new Interface([
		"function diamondCut((address facetAddress,uint8 action,bytes4[] functionSelectors)[] cut,address init,bytes data)",
	]);
	const decoded = iface.decodeFunctionData("diamondCut", result.calldata);
	assert.equal(decoded.init, ZeroAddress);
	assert.equal(decoded.data, "0x");
	assert.deepEqual(planRoundingCut(baseline, result.desired, facets, oldFacets).cut, []);
	const batch = createSafeBatch({
		chainId: 42161,
		safeAddress: "0x1111111111111111111111111111111111111111",
		name: "rounding",
		actions: [{ to: "0x2222222222222222222222222222222222222222", value: "0", data: result.calldata, description: "Core rounding cut" }],
	});
	validateSafeBatchTransport(batch);
	assert.equal(batch.transactionBuilder.transactions[0].data, result.calldata.toLowerCase());
});

test("rounding cut refuses unrelated or partial concurrent selector changes", () => {
	const { baseline, facets, oldFacets } = fixture();
	assert.throws(() => planRoundingCut(baseline, { ...baseline, "0x12345678": facets.ViewFacet.address }, facets, oldFacets), /changed outside/);
	assert.throws(() => planRoundingCut(baseline, { ...baseline, "0x99999999": oldFacets.ViewFacet.address }, facets, oldFacets), /changed outside/);
	facets.ViewFacet.selectors.push("0x12345678");
	assert.throws(() => planRoundingCut(baseline, baseline, facets, oldFacets), /outside the reviewed/);
});

test("stage funding cut replaces only funding with suffix 863 and preserves the installed rounding getter", () => {
	const { baseline, facets, oldFacets } = fixture("production");
	baseline[GETTER] = oldFacets.ViewFacet.address;
	const funding = { FundingRateFacet: { ...facets.FundingRateFacet, address: facets.FundingRateFacet.address.replace(/862$/, "863") } };
	const result = planRoundingCut(baseline, baseline, funding, oldFacets, "stage-funding");
	assert.equal(result.cut.length, 1);
	assert.equal(result.cut[0].action, 1);
	assert.equal(result.desired[GETTER], baseline[GETTER]);
	assert.equal(Object.keys(result.desired).length, Object.keys(baseline).length);
	assert.deepEqual(planRoundingCut(baseline, result.desired, funding, oldFacets, "stage-funding").cut, []);
	assert.deepEqual(roundingDeployments("stage-funding"), ["Create2Factory", "FundingRateFacet"]);
	assert.throws(() => planRoundingCut(baseline, baseline, facets, oldFacets, "stage-funding"), /Exactly FundingRateFacet/);
	assert.throws(
		() => planRoundingCut(baseline, baseline, { FundingRateFacet: facets.FundingRateFacet }, oldFacets, "stage-funding"),
		/does not end in 863/,
	);
	const withoutGetter = { ...baseline };
	delete withoutGetter[GETTER];
	assert.throws(() => planRoundingCut(withoutGetter, withoutGetter, funding, oldFacets, "stage-funding"), /installed rounding getter/);
});

test("stage funding exports role grants and pause only after publication and verifies each before the next Safe action", () => {
	const task = createArbitrumRoundingUpgradeTask(value => value, "stage-funding");
	assert.equal(task.id, "maintenance.arbitrum-vibe-stage-funding-upgrade-863");
	assert.deepEqual(
		task.plan().map(s => s.id),
		[
			"compile",
			"inspect",
			"authorize",
			"deploy",
			"publish",
			"core-roles",
			"verify-roles",
			"core-pause",
			"verify-pause",
			"core-cut",
			"verify",
			"core-unpause",
			"verify-unpause",
		],
	);
	assert.match(task.plan().find(s => s.id === "deploy").title, /FundingRateFacet ending in 863/);
	assert.equal(task.inputs.find(i => i.id === "governanceSigner").required, true);
});

test("production replaces the funding facet alongside rounding and refuses missing or incomplete funding scope", () => {
	const { baseline, facets, oldFacets } = fixture("production");
	const fundingSelector = facets.FundingRateFacet.selectors[0];
	const result = planRoundingCut(baseline, baseline, facets, oldFacets, "production");
	assert.equal(result.desired[fundingSelector].toLowerCase(), facets.FundingRateFacet.address.toLowerCase());
	assert.equal(result.desired["0x12345678"], baseline["0x12345678"]);
	assert.equal(result.cut.filter(group => group.action === 1).length, 5);
	assert.equal(result.cut.filter(group => group.action === 0).length, 1);
	assert.deepEqual(planRoundingCut(baseline, result.desired, facets, oldFacets, "production").cut, []);
	assert.equal(roundingDeployments("production").length, 10);
	assert.equal(roundingDeployments("stage").length, 9);
	assert.throws(() => planRoundingCut(baseline, baseline, facets, oldFacets), /Exactly four/);
	const missing = structuredClone(facets);
	delete missing.FundingRateFacet;
	assert.throws(() => planRoundingCut(baseline, baseline, missing, oldFacets, "production"), /Exactly five.*FundingRateFacet/);
	const wrongSuffix = structuredClone(facets);
	wrongSuffix.FundingRateFacet.address = oldFacets.FundingRateFacet.address;
	assert.throws(() => planRoundingCut(baseline, baseline, wrongSuffix, oldFacets, "production"), /FundingRateFacet does not end in 862/);
	const omitted = structuredClone(facets);
	omitted.FundingRateFacet.selectors = [];
	assert.throws(() => planRoundingCut(baseline, baseline, omitted, oldFacets, "production"), /FundingRateFacet would omit/);
	const incompleteCut = { ...result.desired, [fundingSelector]: baseline[fundingSelector] };
	assert.throws(() => planRoundingCut(baseline, incompleteCut, facets, oldFacets, "production"), /changed outside/);
});

test("rounding cut enforces suffix, exact scope, and the new getter", () => {
	const { baseline, facets, oldFacets } = fixture();
	const wrongSuffix = structuredClone(facets);
	wrongSuffix.ViewFacet.address = oldFacets.ViewFacet.address;
	assert.throws(() => planRoundingCut(baseline, baseline, wrongSuffix, oldFacets), /does not end in 862/);
	const missing = structuredClone(facets);
	delete missing.ClearingHouseFacet;
	assert.throws(() => planRoundingCut(baseline, baseline, missing, oldFacets), /Exactly four/);
	facets.ViewFacet.selectors = facets.ViewFacet.selectors.filter(s => s !== GETTER);
	assert.throws(() => planRoundingCut(baseline, baseline, facets, oldFacets), /new rounding getter/);
});

test("operator flow goes from live inspection to authorization and deployment without a fork rehearsal", () => {
	const ids = ROUNDING_PLAN.map(step => step.id);
	assert.equal(ids.includes("rehearse"), false);
	assert.equal(ids[ids.indexOf("inspect") + 1], "authorize");
	assert.equal(ids[ids.indexOf("authorize") + 1], "deploy");
	assert(ids.indexOf("authorize") < ids.indexOf("deploy"));
	assert(ids.indexOf("publish") < ids.indexOf("core-cut"));
	assert(ids.indexOf("verify") < ids.indexOf("core-unpause"));
	assert.equal(ids.at(-1), "verify-unpause");
	assert.equal(
		ids.some(id => /account|instant|gasless/.test(id)),
		false,
	);
});

test("temporary factory intent rejects the inaccessible reused factory and accepts the operator wallet", () => {
	assert.doesNotThrow(() => assertRoundingFactoryIntent({ factory: { mode: "deploy" } }));
	assert.throws(
		() => assertRoundingFactoryIntent({ factory: { mode: "reuse", address: "0x99B425BC19F99a1B922664c0E4fa8A0870CE9975" } }),
		/new temporary/,
	);
	assert.throws(() => assertRoundingFactoryIntent({ factory: { mode: "deploy", address: ZeroAddress } }), /new temporary/);
	const task = createArbitrumRoundingUpgradeTask(value => value);
	assert.equal(task.signerPolicy({}).expectedAddress, undefined);
	assert(task.version > 4);
	assert.match(ROUNDING_PLAN.find(step => step.id === "authorize").title, /nine/);
});

test("production is a separate Ledger task with only cut and verification after deployment", () => {
	const production = createArbitrumRoundingUpgradeTask(value => value, "production");
	const stage = createArbitrumRoundingUpgradeTask(value => value);
	assert.notEqual(production.id, stage.id);
	assert.match(stage.title, /stage \/ Safe/);
	assert.match(production.title, /production \/ Ledger/);
	assert.equal(stage.version, 5);
	assert.equal(production.version, 3);
	assert.match(production.title, /rounding \+ funding/);
	assert.match(production.plan().find(s => s.id === "deploy").title, /five facets ending in 862/);
	assert.match(production.plan().find(s => s.id === "publish").title, /ten/);
	assert.deepEqual(production.plan(), PRODUCTION_ROUNDING_PLAN);
	const ids = production.plan().map(s => s.id);
	assert.equal(ids.length, 7);
	assert.deepEqual(ids.slice(4), ["publish", "core-cut", "verify"]);
	assert.equal(
		stage.plan().some(s => s.id === "core-pause"),
		false,
	);
	assert.equal(production.resumePolicy.sourceDrift, "confirm");
	assert.equal(production.inputs.find(input => input.id === "governanceSigner").required, false);
	assert.match(production.inputs.find(input => input.id === "governanceSigner").label, /after publication/);
});

test("production binds the Ledger only at the cut boundary and waits if the admin is unavailable", async () => {
	const owner = "0x77A955776Ee1dd3E9C800c3214ed489441d74b94";
	const standard = { target: { owner } };
	let bound;
	const selected = await bindProductionLedger(
		{
			ui: {
				note: () => {},
				text: async () => owner,
				select: async ({ message }) => (message.startsWith("Deployment") ? "ledger" : "ledger-live"),
				confirm: async () => true,
			},
			getSigner: () => null,
			bindSigner: (_role, selection) => (bound = selection),
			wait: () => assert.fail("Ledger is available"),
		},
		standard,
	);
	assert.equal(selected, bound);
	assert.deepEqual(bound, { mode: "ledger", address: owner, derivation: "ledger-live" });
	await assert.rejects(
		bindProductionLedger(
			{
				ui: { select: async () => "later", text: async () => assert.fail("No Ledger address is needed to wait") },
				getSigner: () => null,
				bindSigner: () => assert.fail("Ledger must not be bound"),
				wait: message => {
					throw new Error(message);
				},
			},
			standard,
		),
		/admin is available.*Continue active task/,
	);
});

test("governance subprocess binds the Ledger while preserving the deployment signer's environment", async t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rounding-ledger-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const config = path.join(directory, "recipe.json"),
		output = path.join(directory, "report.json");
	const address = "0x77A955776Ee1dd3E9C800c3214ed489441d74b94";
	fs.writeFileSync(
		config,
		JSON.stringify({
			apiVersion: "deployment.symm.io/v1",
			kind: "DeploymentRecipe",
			name: "ledger-test",
			network: { name: "arbitrum", chainId: 42161, mode: "live" },
			secrets: {
				deployer: "hardhat-keystore://TEAM_DEPLOYER",
				rpc: "hardhat-keystore://RPC_ARBITRUM",
				explorer: "hardhat-keystore://ETHERSCAN_APIKEY",
			},
			execution: { logLevel: "verbose", verify: true, confirmations: 1, txTimeoutSeconds: 300, slowNoticeSeconds: 30 },
			governance: { admin: address },
			core: { mode: "skip" },
			partyB: { mode: "skip", adlEnabled: false },
			symbolManager: { mode: "skip" },
			expressProvider: { mode: "skip" },
			gaslessLayer: { mode: "skip" },
		}),
	);
	fs.writeFileSync(output, JSON.stringify({ inputDigest: "test-bound-input" }));
	const input = {
		config,
		output,
		input: "input.json",
		inputDigest: "test-bound-input",
		governanceSigner: { mode: "ledger", address, derivation: "ledger-live" },
	};
	const before = { ...process.env };
	let captured;
	await runLedgerPhase(
		{
			runProcess: async (command, args, options) => {
				captured = { command, args, options };
			},
		},
		input,
		"execute-cut",
	);
	assert(captured.args.includes("execute-cut"));
	assert.equal(captured.options.env.SYMMIO_SIGNER_MODE, "ledger");
	assert.equal(captured.options.env.SYMMIO_EXPECTED_SIGNER, address);
	assert.equal(captured.options.env.SYMMIO_LEDGER_DERIVATION, "ledger-live");
	assert.equal(captured.options.env.CONFIRM_CHAIN_ID, "42161");
	assert.deepEqual({ ...process.env }, before);
	const { governanceSigner: boundSigner, ...deferredInput } = input;
	await runLedgerPhase(
		{
			state: { signing: { governance: boundSigner } },
			runProcess: async (_command, _args, { env }) => {
				assert.equal(env.SYMMIO_EXPECTED_SIGNER, address);
				assert.equal(env.SYMMIO_SIGNER_MODE, "ledger");
			},
		},
		deferredInput,
		"reconcile-governance",
	);
	await assert.rejects(
		runLedgerPhase({}, { ...input, governanceSigner: { mode: "hardhat-keystore", key: "TEAM_DEPLOYER" } }, "execute-cut"),
		/requires Ledger signing/,
	);
});
