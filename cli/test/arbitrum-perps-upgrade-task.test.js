import {
	ARBITRUM_PERPS_UPGRADE_PLAN,
	applyForkRehearsalWaiver,
	buildArbitrumPerpsUpgradeSourceMigrationEnvironment,
	safeDispatchStateKeyForUpgradeBatch,
} from "../tasks/arbitrum-perps-upgrade.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

test("canary waiver support preserves the active run step identity", () => {
	assert.deepEqual(
		ARBITRUM_PERPS_UPGRADE_PLAN.find(step => step.id === "canary"),
		{
			id: "canary",
			phase: "canary",
			title: "Record a successful production canary before cutover",
		},
	);
});

test("upgrade report batch ids map to independent stable Safe dispatch keys", () => {
	assert.equal(safeDispatchStateKeyForUpgradeBatch("coreCut"), "core-cut");
	assert.equal(safeDispatchStateKeyForUpgradeBatch("accountCut"), "account-cut");
	assert.equal(safeDispatchStateKeyForUpgradeBatch("authority"), "authority");
	assert.equal(safeDispatchStateKeyForUpgradeBatch("wiring"), "wiring");
	assert.equal(safeDispatchStateKeyForUpgradeBatch("instantState"), "instant-state");
	assert.equal(safeDispatchStateKeyForUpgradeBatch("gaslessState"), "gasless-state");
	assert.equal(safeDispatchStateKeyForUpgradeBatch("liquidatorState"), "liquidator-state");
	assert.equal(safeDispatchStateKeyForUpgradeBatch("cutover"), "cutover");
	assert.throws(() => safeDispatchStateKeyForUpgradeBatch("unknown"), /Unsupported Arbitrum upgrade Safe batch/);
});

test("source migration environment binds the active journal to the checked-out commit", () => {
	const sourceHash = `sha256:${"2".repeat(64)}`;
	const migrations = [
		{
			at: "2026-09-03T10:15:24.199Z",
			from: `sha256:${"1".repeat(64)}`,
			to: sourceHash,
			authorization: "operator-confirmed",
		},
	];
	const environment = buildArbitrumPerpsUpgradeSourceMigrationEnvironment(
		{ inputDigest: "input-digest", sourceCommit: "a".repeat(40) },
		{ runId: "run-1", sourceHash, sourceMigrations: migrations },
	);
	const evidence = JSON.parse(environment.SYMMIO_ARBITRUM_UPGRADE_SOURCE_MIGRATION);
	assert.equal(evidence.taskId, "maintenance.arbitrum-perps-upgrade");
	assert.equal(evidence.taskRunId, "run-1");
	assert.equal(evidence.inputDigest, "input-digest");
	assert.equal(evidence.originalCommit, "a".repeat(40));
	assert.equal(evidence.currentCommit, execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
	assert.deepEqual(evidence.migrations, migrations);
});
