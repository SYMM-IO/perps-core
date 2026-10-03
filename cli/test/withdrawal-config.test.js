import { PROJECT_ROOT } from "../lib/paths.js";
import { withdrawalEnvironment } from "../tasks/core-withdrawal.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function inspectConfig(overrides, assertions) {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !/^(SYMMIO_|KEYSTORE_|TEAM_|NEW_DEPLOYER$|USE_KEYSTORE$|RPC_|LEDGER_)/.test(name)),
	);
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			`
  import assert from 'node:assert/strict';
  import config from './hardhat.config.ts';
  ${assertions}
 `,
		],
		{ cwd: PROJECT_ROOT, env: { ...env, ...withdrawalEnvironment({ network: "base", chainId: 8453 }), ...overrides }, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
}
test("withdrawal inspection has no signer accounts while preserving keystore RPC lookup", () => {
	inspectConfig(
		{},
		`
  assert.deepEqual(config.networks.base.accounts, []);
  assert.deepEqual(config.networks.localhost.accounts, []);
  assert.equal(config.networks.base.url.name, 'RPC_BASE');
 `,
	);
});
test("private-key execution uses only the selected transient key", () => {
	const key = "0x" + "11".repeat(32);
	inspectConfig(
		{ SYMMIO_RECIPE_READ_ONLY: "false", SYMMIO_SIGNER_MODE: "private-key", SYMMIO_EPHEMERAL_PRIVATE_KEY: key },
		`
  assert.deepEqual(config.networks.base.accounts, ['${key}']);
 `,
	);
});
test("keystore execution resolves the selected signing key", () => {
	inspectConfig(
		{ SYMMIO_RECIPE_READ_ONLY: "false", SYMMIO_SIGNER_MODE: "hardhat-keystore", KEYSTORE_DEPLOYER_KEY: "WITHDRAWAL_WALLET" },
		`
  assert.equal(config.networks.base.accounts.length, 1);
  assert.equal(config.networks.base.accounts[0].name, 'WITHDRAWAL_WALLET');
 `,
	);
});
