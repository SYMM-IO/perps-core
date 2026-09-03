import { applyForkRehearsalWaiver } from "../tasks/arbitrum-perps-upgrade.js";
import assert from "node:assert/strict";
import test from "node:test";

test("fork rehearsal waiver remains distinct from passed rehearsal evidence", () => {
	const report = { lifecycle: "failed", stages: {} };
	const result = applyForkRehearsalWaiver(report, 501269940, "2026-09-03T10:00:00.000Z");
	assert.equal(result, report);
	assert.equal(report.lifecycle, "in_progress");
	assert.deepEqual(report.stages.forkRehearsal, {
		status: "skipped",
		baseBlockNumber: 501269940,
		reason: "Explicit operator waiver bound in the standard upgrade input",
		skippedAt: "2026-09-03T10:00:00.000Z",
	});
});

test("fork rehearsal waiver requires a live inspection block", () => {
	assert.throws(() => applyForkRehearsalWaiver({ lifecycle: "prepared", stages: {} }, 0), /fork block number/);
});
