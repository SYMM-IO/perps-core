import { PROTOCOL_PARAMETER_NAMES, configPath, readProtocolParameters, templateDifferences } from "../commands/config.js";
import { PROJECT_ROOT } from "../lib/paths.js";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

test("protocol config paths stay rooted at the checkout", () => {
	assert.equal(configPath(42161), path.join(PROJECT_ROOT, "tasks", "config", "protocol-42161.json"));
	assert.equal(path.isAbsolute(configPath(42161)), true);
});

test("config diff reads all 12 protocol parameters through the intended getters at one block", async () => {
	const called = [];
	const result = value => async options => {
		called.push(options.blockTag);
		return value;
	};
	const view = {
		getBalanceLimitPerUser: result(100n),
		getMaxWithdrawParts: result(10n),
		deallocateCooldown: result(120n),
		settlementCooldown: result(300n),
		getDeallocateDebounceTime: result(0n),
		liquidatorShare: result(5n),
		liquidationTimeout: result(100n),
		coolDownsOfMA: result([120n, 301n, 302n, 303n]),
		forceCloseCooldowns: result([303n, 304n]),
		pendingQuotesValidLength: result(20n),
		maxConnectedCounterParty: result(7n),
	};

	const parameters = await readProtocolParameters(view, 987);
	assert.equal(PROTOCOL_PARAMETER_NAMES.length, 12);
	assert.deepEqual(Object.keys(parameters), PROTOCOL_PARAMETER_NAMES);
	assert.deepEqual(parameters.forceCloseCooldowns, ["303", "304"]);
	assert.equal(parameters.forceCancelCooldown, "301");
	assert.equal(parameters.forceCancelCloseCooldown, "302");
	assert.deepEqual(called, Array(11).fill(987));
});

test("template comparison detects names, activity, mode and every operation array", () => {
	const live = {
		name: "Live",
		active: false,
		operations: [{ insertionPoints: [1n], sourceIndices: [2n], sourceOffsets: [3n] }],
	};
	const configured = {
		name: "Config",
		instantOpenMode: true,
		operations: [{ insertionPoints: [1], sourceIndices: [9], sourceOffsets: [8] }],
	};
	const differences = templateDifferences(4, live, configured, false);
	assert.equal(differences.length, 5);
	assert.ok(differences.some(value => value.includes(".name")));
	assert.ok(differences.some(value => value.includes(".active")));
	assert.ok(differences.some(value => value.includes(".instantOpenMode")));
	assert.ok(differences.some(value => value.includes("sourceIndices")));
	assert.ok(differences.some(value => value.includes("sourceOffsets")));
});

test("template comparison accepts a complete deep match", () => {
	const live = {
		name: "InstantOpen",
		active: true,
		operations: [{ insertionPoints: [0n], sourceIndices: [1n], sourceOffsets: [2n] }],
	};
	const configured = {
		name: "InstantOpen",
		instantOpenMode: true,
		operations: [{ insertionPoints: [0], sourceIndices: [1], sourceOffsets: [2] }],
	};
	assert.deepEqual(templateDifferences(0, live, configured, true), []);
});
