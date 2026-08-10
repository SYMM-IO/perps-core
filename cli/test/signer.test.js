import { SIGNER_MODES, dispatchSafeActions, redactSignerSecrets, selectSigner, signerEnvironment, validateSignerSelection } from "../signer/index.js";
import { createSafeBatch, safeBatchDigest, writeSafeBatch, writeSafeIntent } from "../signer/safe-batch.js";
import { Interface, Wallet } from "ethers";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PRIVATE_KEY = `0x${"42".repeat(32)}`;
const SAFE = "0x1111111111111111111111111111111111111111";
const TARGET = "0x2222222222222222222222222222222222222222";

function artifactRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-safe-batch-"));
	const artifact = path.join(root, "artifacts", "contracts", "Example.sol", "Example.json");
	fs.mkdirSync(path.dirname(artifact), { recursive: true });
	fs.writeFileSync(artifact, JSON.stringify({ contractName: "Example", abi: ["function setLimit(uint256 limit)"] }));
	return root;
}

test("Safe export is importable, ABI-decoded, and digest-bound to execution intent", () => {
	const root = artifactRoot();
	const iface = new Interface(["function setLimit(uint256 limit)"]);
	const input = {
		root,
		chainId: 42161,
		safeAddress: SAFE,
		name: "ExpressProvider patch",
		description: "Raise the reviewed limit",
		actions: [{ to: TARGET, value: "0", data: iface.encodeFunctionData("setLimit", [7n]), description: "Set limit to 7" }],
	};
	const first = createSafeBatch({ ...input, createdAt: 1 });
	const second = createSafeBatch({ ...input, createdAt: 2 });
	assert.equal(first.digest, second.digest, "UI metadata must not alter the execution digest");
	assert.equal(first.transactionBuilder.version, "1.0");
	assert.equal(first.transactionBuilder.chainId, "42161");
	assert.equal(first.transactionBuilder.transactions[0].contractMethod.name, "setLimit");
	assert.deepEqual(first.transactionBuilder.transactions[0].contractInputsValues, { limit: "7" });
	assert.equal(first.transactionBuilder.transactions[0].data, null);
	assert.equal(first.transactionBuilder.transactions[0].contractName, undefined);

	const { digest, transactionBuilder, ...intent } = first;
	assert.equal(digest, safeBatchDigest(intent));
	assert.notEqual(digest, safeBatchDigest({ ...intent, actions: [{ ...intent.actions[0], data: iface.encodeFunctionData("setLimit", [8n]) }] }));

	const builderPath = path.join(root, "out", "builder.json");
	const intentPath = path.join(root, "out", "intent.json");
	writeSafeBatch(builderPath, first);
	writeSafeIntent(intentPath, first);
	assert.equal(JSON.parse(fs.readFileSync(builderPath, "utf8")).transactions[0].contractMethod.name, "setLimit");
	assert.equal(JSON.parse(fs.readFileSync(intentPath, "utf8")).digest, digest);
});

test("private keys remain transient, are masked, and never serialize into task input", async () => {
	const ui = {
		password: async () => PRIVATE_KEY,
		note: () => {},
	};
	const selection = await selectSigner(ui, { allowedModes: [SIGNER_MODES.PRIVATE_KEY], network: "arbitrum" });
	assert.deepEqual(selection, { mode: SIGNER_MODES.PRIVATE_KEY, address: new Wallet(PRIVATE_KEY).address });
	assert.doesNotMatch(JSON.stringify(selection), new RegExp(PRIVATE_KEY.slice(2), "i"));
	assert.equal(signerEnvironment(selection).SYMMIO_EPHEMERAL_PRIVATE_KEY, PRIVATE_KEY);
	assert.equal(redactSignerSecrets(`secret=${PRIVATE_KEY}`), "secret=<redacted-signer-secret>");
});

test("keystore and Ledger selections persist only public identifiers", async () => {
	const calls = [];
	const keystore = await selectSigner(
		{
			text: async () => "DEPLOYER_X",
			confirm: async () => true,
			runInteractive: async (command, args) => {
				calls.push([command, args]);
				return 0;
			},
			note: () => {},
		},
		{ allowedModes: [SIGNER_MODES.KEYSTORE], network: "arbitrum" },
	);
	assert.deepEqual(keystore, { mode: SIGNER_MODES.KEYSTORE, key: "DEPLOYER_X" });
	assert.deepEqual(calls, [["./node_modules/.bin/hardhat", ["keystore", "set", "--force", "DEPLOYER_X"]]]);

	const ledger = await selectSigner(
		{
			text: async () => TARGET,
			select: async () => "ledger-live",
			confirm: async () => true,
			note: () => {},
		},
		{ allowedModes: [SIGNER_MODES.LEDGER], network: "arbitrum" },
	);
	assert.deepEqual(ledger, { mode: SIGNER_MODES.LEDGER, address: TARGET, derivation: "ledger-live" });
	assert.deepEqual(validateSignerSelection(ledger, { allowSafe: false }), ledger);
});

test("Safe file dispatch writes fork-scoped canonical artifacts without spawning a proposal", async () => {
	const root = artifactRoot();
	const iface = new Interface(["function setLimit(uint256 limit)"]);
	const events = [];
	const ctx = {
		state: { runId: "run/unsafe chars" },
		emit: (type, detail) => events.push({ type, detail }),
	};
	const result = await dispatchSafeActions(
		ctx,
		{ mode: SIGNER_MODES.SAFE_FILE, safeAddress: SAFE },
		[{ to: TARGET, value: "0", data: iface.encodeFunctionData("setLimit", [7n]), description: "Set limit" }],
		{ root, chainId: 42161, network: "fork-arbitrum", name: "Fork review", description: "Simulation only" },
	);
	assert.match(result.builderPath, /tasks\/data\/42161-fork\/safe\//);
	assert.equal(fs.existsSync(result.builderPath), true);
	assert.equal(fs.existsSync(result.intentPath), true);
	assert.equal(events.at(-1).type, "safe.exported");
	await assert.rejects(
		dispatchSafeActions(
			{ state: { runId: "direct" }, emit: () => {} },
			{ mode: SIGNER_MODES.SAFE_SERVICE, safeAddress: SAFE },
			[{ to: TARGET, value: "0", data: "0x", description: "No-op" }],
			{ root, chainId: 42161, network: "fork-arbitrum", name: "Refused" },
		),
		/refused for local and fork/,
	);
});

test("direct Safe proposal keeps owner credentials transient and invokes the reviewed internal adapter", async () => {
	const root = artifactRoot();
	const apiKey = "safe-api-key-with-enough-entropy";
	const passwords = [PRIVATE_KEY, apiKey];
	const selection = await selectSigner(
		{
			select: async () => SIGNER_MODES.PRIVATE_KEY,
			password: async () => passwords.shift(),
			note: () => {},
		},
		{
			allowedModes: [SIGNER_MODES.SAFE_SERVICE],
			network: "arbitrum",
			chainId: 42161,
			safeAddress: SAFE,
		},
	);
	assert.deepEqual(selection, {
		mode: SIGNER_MODES.SAFE_SERVICE,
		safeAddress: SAFE,
		owner: { mode: SIGNER_MODES.PRIVATE_KEY, address: new Wallet(PRIVATE_KEY).address },
	});
	assert.doesNotMatch(JSON.stringify(selection), new RegExp(PRIVATE_KEY.slice(2), "i"));
	assert.doesNotMatch(JSON.stringify(selection), new RegExp(apiKey));
	validateSignerSelection(selection);

	let invocation;
	const ctx = {
		state: { runId: "direct-safe" },
		ui: { password: async () => assert.fail("hydrated credentials should not be requested twice") },
		emit: () => {},
		runProcess: async (command, args, options) => {
			invocation = { command, args, options };
			const output = args[args.indexOf("--output") + 1];
			const intent = JSON.parse(fs.readFileSync(args[args.indexOf("--input") + 1], "utf8"));
			fs.writeFileSync(
				output,
				JSON.stringify({
					digest: intent.digest,
					safeAddress: intent.safeAddress,
					safeTxHash: `0x${"ab".repeat(32)}`,
					proposedBy: selection.owner.address,
				}),
			);
		},
	};
	const result = await dispatchSafeActions(ctx, selection, [{ to: TARGET, value: "0", data: "0x", description: "Reviewed call" }], {
		root,
		chainId: 42161,
		network: "arbitrum",
		name: "Direct proposal",
	});
	assert.equal(invocation.command, "./node_modules/.bin/hardhat");
	assert.match(invocation.args.join(" "), /internal:propose-safe-batch/);
	assert.equal(invocation.options.env.SYMMIO_EPHEMERAL_PRIVATE_KEY, PRIVATE_KEY);
	assert.equal(invocation.options.env.SYMMIO_SAFE_API_KEY, apiKey);
	assert.equal(invocation.options.env.SYMMIO_SAFE_ACTIONS_ONLY, "false");
	assert.equal(result.status, "proposed");
	assert.equal(result.proposedBy, selection.owner.address);
	assert.doesNotMatch(JSON.stringify(ctx.state), new RegExp(PRIVATE_KEY.slice(2), "i"));
	assert.doesNotMatch(JSON.stringify(ctx.state), new RegExp(apiKey));
});
