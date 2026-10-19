import { parseTestRunnerArguments } from "../../utils/test-runner-args.mjs";
import assert from "node:assert/strict";
import test from "node:test";

test("uses the default or environment worker count without consuming test flags", () => {
	assert.deepEqual(parseTestRunnerArguments([], undefined), { jobs: 8, extraArgs: [] });
	assert.deepEqual(parseTestRunnerArguments(["--grep", "atomic", "--bail"], "2"), { jobs: 2, extraArgs: ["--grep", "atomic", "--bail"] });
});

test("an explicit worker count overrides the environment and preserves following arguments", () => {
	assert.deepEqual(parseTestRunnerArguments(["4", "--grep", "12"], "2"), { jobs: 4, extraArgs: ["--grep", "12"] });
});

test("rejects zero, excessive, fractional, and unsafe worker counts", () => {
	for (const raw of ["0", "65", "-1", "1.5", "NaN", "9007199254740993"]) assert.throws(() => parseTestRunnerArguments([], raw), /parallel jobs/);
	assert.throws(() => parseTestRunnerArguments(["0"], "2"), /parallel jobs/);
});
