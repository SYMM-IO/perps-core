import {
	ARBITRUM_PERPS_UPGRADE_CANARY_WAIVER_CONFIRMATION,
	ARBITRUM_PERPS_UPGRADE_INPUT_API_VERSION,
	ARBITRUM_PERPS_UPGRADE_REPORT_API_VERSION,
	ARBITRUM_PERPS_UPGRADE_SOURCE_MIGRATION_API_VERSION,
	ARBITRUM_PERPS_UPGRADE_TARGET,
	arbitrumPerpsUpgradeInputDigest,
	arbitrumPerpsUpgradeCanaryDisposition,
	buildArbitrumPerpsUpgradeInput,
	createArbitrumPerpsUpgradeReport,
	loadArbitrumPerpsUpgradeRuntimeConfig,
	recordArbitrumPerpsUpgradeCanaryWaiver,
	recordArbitrumPerpsUpgradeSafeHardeningSkip,
	arbitrumPerpsUpgradeSafeHardeningDisposition,
	finalizeArbitrumPerpsUpgradeReport,
	validateArbitrumPerpsUpgradeInput,
	validateArbitrumPerpsUpgradeRuntimeConfig,
	validateArbitrumPerpsUpgradeReport,
	validateArbitrumPerpsUpgradeSourceMigration,
} from "../../deployment-tooling/arbitrum-perps-upgrade.js";
import { loadDeploymentRecipe } from "../../deployment-tooling/recipe.js";
import assert from "node:assert/strict";
import test from "node:test";

function input() {
	const loaded = loadDeploymentRecipe("deployment-recipes/arbitrum-vibe-production.json");
	return buildArbitrumPerpsUpgradeInput({
		recipe: loaded.recipe,
		recipePath: loaded.identityPath,
		recipeDigest: loaded.digest,
		sourceCommit: "a".repeat(40),
		partyBs: ["0x9be79D4977D86D440F9e1Ea0d468A58104B9b932"],
	});
}

function readyForHardening() {
	const report = createArbitrumPerpsUpgradeReport(input());
	report.stages.inspect = { safe: { owners: [ARBITRUM_PERPS_UPGRADE_TARGET.safe], threshold: "1" } };
	report.stages.publication = { status: "complete" };
	recordArbitrumPerpsUpgradeCanaryWaiver(report, "Already reviewed operator decision");
	return report;
}

test("optional Safe hardening can finish an otherwise verified upgrade while remaining skipped", () => {
	const report = readyForHardening();
	finalizeArbitrumPerpsUpgradeReport(report);
	assert.equal(report.lifecycle, "waiting_external");
	recordArbitrumPerpsUpgradeSafeHardeningSkip(report);
	finalizeArbitrumPerpsUpgradeReport(report);
	assert.equal(report.lifecycle, "complete");
	assert.equal(report.stages.safeHardening.status, "skipped");
	assert.equal(report.stages.finalVerification.safeHardened, false);
	assert.equal(report.stages.finalVerification.safeHardeningSkipped, true);
	assert.equal(report.checks.find(check => check.check === "Safe hardening").status, "skipped");
	finalizeArbitrumPerpsUpgradeReport(report);
	assert.equal(report.lifecycle, "complete");
});

test("skipping Safe hardening cannot bypass unresolved actions, publication, canary or invalid Safe state", () => {
	for (const change of [
		report => {
			report.safeBatches.wiring = { actions: [{}] };
		},
		report => {
			report.externalActions.accountAuthority = { actions: [{}] };
		},
		report => {
			report.stages.publication.status = "pending";
		},
		report => {
			delete report.stages.canary;
		},
		report => {
			report.stages.inspect.safe.threshold = "0";
		},
		report => {
			report.stages.safeHardening.inputDigest = "different-run";
		},
	]) {
		const report = recordArbitrumPerpsUpgradeSafeHardeningSkip(readyForHardening());
		change(report);
		assert.equal(finalizeArbitrumPerpsUpgradeReport(report).lifecycle, "waiting_external");
	}
});

test("a later hardened Safe is reported as observed, rather than skipped", () => {
	const report = recordArbitrumPerpsUpgradeSafeHardeningSkip(readyForHardening());
	report.stages.inspect.safe = { owners: [ARBITRUM_PERPS_UPGRADE_TARGET.safe, "0x1111111111111111111111111111111111111111"], threshold: "2" };
	assert.equal(arbitrumPerpsUpgradeSafeHardeningDisposition(report).status, "passed");
	assert.equal(finalizeArbitrumPerpsUpgradeReport(report).stages.safeHardening.status, "complete");
});

test("Arbitrum upgrade input is a fixed, digest-bound standard document", () => {
	const value = input();
	assert.equal(value.apiVersion, ARBITRUM_PERPS_UPGRADE_INPUT_API_VERSION);
	assert.equal(value.governance.safe, ARBITRUM_PERPS_UPGRADE_TARGET.safe);
	assert.equal(value.contracts.core, ARBITRUM_PERPS_UPGRADE_TARGET.contracts.core);
	assert.equal(value.instantLayer.mode, "deploy");
	assert.deepEqual(value.instantLayer.partyBs, ["0x9be79D4977D86D440F9e1Ea0d468A58104B9b932"]);
	assert.equal(value.gaslessLayer.mode, "deploy");
	assert.equal(value.execution.requireForkRehearsal, true);
	assert.match(arbitrumPerpsUpgradeInputDigest(value), /^[0-9a-f]{64}$/);
	assert.equal(arbitrumPerpsUpgradeInputDigest(value), arbitrumPerpsUpgradeInputDigest(structuredClone(value)));
});

test("Arbitrum runtime config supplies the required InstantLayer PartyB set", () => {
	const loaded = loadArbitrumPerpsUpgradeRuntimeConfig("tasks/config/arbitrum-perps-upgrade-42161.json");
	assert.match(loaded.digest, /^[0-9a-f]{64}$/);
	assert.deepEqual(loaded.config.instantLayer.partyBs, ["0x9be79D4977D86D440F9e1Ea0d468A58104B9b932"]);

	const withoutPartyB = structuredClone(loaded.config);
	delete withoutPartyB.instantLayer;
	assert.deepEqual(validateArbitrumPerpsUpgradeRuntimeConfig(withoutPartyB).instantLayer.partyBs, []);
});

test("new standard inputs require PartyB while pre-requirement inputs remain resumable", () => {
	const loaded = loadDeploymentRecipe("deployment-recipes/arbitrum-vibe-production.json");
	assert.throws(
		() =>
			buildArbitrumPerpsUpgradeInput({
				recipe: loaded.recipe,
				recipePath: loaded.identityPath,
				recipeDigest: loaded.digest,
				sourceCommit: "a".repeat(40),
			}),
		/instantLayer.partyBs/,
	);
	const legacy = input();
	delete legacy.instantLayer.partyBs;
	assert.equal(validateArbitrumPerpsUpgradeInput(legacy), legacy);
});

test("Arbitrum upgrade input refuses target, authority, source, and live-safety drift", () => {
	for (const mutate of [
		value => (value.contracts.core = "0x1111111111111111111111111111111111111111"),
		value => (value.governance.safe = "0x2222222222222222222222222222222222222222"),
		value => (value.source.commit = "not-a-commit"),
		value => (value.execution.verify = false),
		value => (value.execution.requireForkRehearsal = "no"),
		value => (value.instantLayer.partyBs = []),
	]) {
		const changed = structuredClone(input());
		mutate(changed);
		assert.throws(() => validateArbitrumPerpsUpgradeInput(changed), /must/);
	}
});

test("Arbitrum upgrade input digest binds an explicit fork rehearsal waiver", () => {
	const required = input();
	const loaded = loadDeploymentRecipe("deployment-recipes/arbitrum-vibe-production.json");
	const waived = buildArbitrumPerpsUpgradeInput({
		recipe: loaded.recipe,
		recipePath: loaded.identityPath,
		recipeDigest: loaded.digest,
		sourceCommit: "a".repeat(40),
		partyBs: ["0x9be79D4977D86D440F9e1Ea0d468A58104B9b932"],
		requireForkRehearsal: false,
	});
	assert.equal(waived.execution.requireForkRehearsal, false);
	assert.notEqual(arbitrumPerpsUpgradeInputDigest(waived), arbitrumPerpsUpgradeInputDigest(required));
});

test("Arbitrum upgrade report binds every resumable update to the exact input", () => {
	const value = input();
	const report = createArbitrumPerpsUpgradeReport(value, "2026-09-02T00:00:00.000Z");
	assert.equal(report.apiVersion, ARBITRUM_PERPS_UPGRADE_REPORT_API_VERSION);
	assert.equal(report.lifecycle, "prepared");
	assert.equal(report.addresses.newInstantLayer, null);
	assert.equal(validateArbitrumPerpsUpgradeReport(report, value), report);
	const changed = structuredClone(value);
	changed.source.commit = "b".repeat(40);
	assert.throws(() => validateArbitrumPerpsUpgradeReport(report, changed), /inputDigest must equal/);
});

test("production canary waiver is explicit, auditable, and remains distinct from a passed canary", () => {
	const report = createArbitrumPerpsUpgradeReport(input(), "2026-09-02T00:00:00.000Z");
	const waived = recordArbitrumPerpsUpgradeCanaryWaiver(
		report,
		"Operator accepted cutover risk because both components were already production validated.",
		"2026-09-03T12:30:00.000Z",
	);
	assert.equal(waived, report);
	assert.deepEqual(report.stages.canary, {
		status: "skipped",
		authorization: "operator-confirmed",
		confirmation: ARBITRUM_PERPS_UPGRADE_CANARY_WAIVER_CONFIRMATION,
		reason: "Operator accepted cutover risk because both components were already production validated.",
		skippedAt: "2026-09-03T12:30:00.000Z",
	});
	assert.deepEqual(arbitrumPerpsUpgradeCanaryDisposition(report), {
		satisfied: true,
		status: "skipped",
		waived: true,
	});

	const passed = structuredClone(report);
	passed.stages.canary = {
		status: "complete",
		evidence: "0x1234",
		recordedAt: "2026-09-03T12:31:00.000Z",
	};
	assert.deepEqual(arbitrumPerpsUpgradeCanaryDisposition(passed), {
		satisfied: true,
		status: "passed",
		waived: false,
	});
});

test("production canary waiver rejects missing reasons and malformed report evidence", () => {
	const report = createArbitrumPerpsUpgradeReport(input());
	assert.throws(() => recordArbitrumPerpsUpgradeCanaryWaiver(report, " "), /reason/);
	for (const canary of [
		{ status: "complete", evidence: "" },
		{ status: "skipped", authorization: "operator-confirmed", reason: "accepted" },
		{
			status: "skipped",
			authorization: "operator-confirmed",
			confirmation: ARBITRUM_PERPS_UPGRADE_CANARY_WAIVER_CONFIRMATION,
			reason: "accepted",
			skippedAt: "not-a-date",
		},
	]) {
		const changed = structuredClone(report);
		changed.stages.canary = canary;
		assert.deepEqual(arbitrumPerpsUpgradeCanaryDisposition(changed), {
			satisfied: false,
			status: "pending",
			waived: false,
		});
	}
});

test("Arbitrum upgrade source migration binds the task, input, commit lineage, and operational file set", () => {
	const value = input();
	const digest = arbitrumPerpsUpgradeInputDigest(value);
	const migration = {
		apiVersion: ARBITRUM_PERPS_UPGRADE_SOURCE_MIGRATION_API_VERSION,
		taskId: "maintenance.arbitrum-perps-upgrade",
		taskRunId: "run-1",
		inputDigest: digest,
		originalCommit: value.source.commit,
		currentCommit: "b".repeat(40),
		migrations: [
			{
				at: "2026-09-03T10:06:09.865Z",
				from: `sha256:${"1".repeat(64)}`,
				to: `sha256:${"2".repeat(64)}`,
				authorization: "operator-confirmed",
			},
		],
	};
	const context = {
		currentCommit: migration.currentCommit,
		changedFiles: [
			"tasks/deploy/componentDeployment.ts",
			"tasks/config/arbitrum-perps-upgrade-42161.json",
			"cli/task-runner.js",
			"cli/signer/safe-batch.js",
			"cli/test/arbitrum-perps-upgrade-task.test.js",
			"cli/test/signer.test.js",
		],
		originalCommitIsAncestor: true,
	};
	const validated = validateArbitrumPerpsUpgradeSourceMigration(value, migration, context);
	assert.equal(validated.inputDigest, digest);
	assert.deepEqual(validated.changedFiles, context.changedFiles);

	const protectedSource = structuredClone(context);
	protectedSource.changedFiles.push("contracts/core/facets/Control/ControlFacet.sol");
	assert.throws(() => validateArbitrumPerpsUpgradeSourceMigration(value, migration, protectedSource), /not an approved operational migration file/);
	assert.throws(
		() => validateArbitrumPerpsUpgradeSourceMigration(value, migration, { ...context, originalCommitIsAncestor: false }),
		/originalCommitIsAncestor must be true/,
	);
	assert.throws(
		() => validateArbitrumPerpsUpgradeSourceMigration(value, { ...migration, inputDigest: "f".repeat(64) }, context),
		/does not match the standard input/,
	);
});
