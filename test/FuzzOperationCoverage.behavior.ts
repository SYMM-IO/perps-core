import { expect } from "chai"

import { FUZZ_CORNER_OPERATIONS, type FuzzModelEvent } from "./models/FuzzLogTypes.js"
import { assertRequiredFuzzOperationCoverage, FuzzOperationCoverageTracker, type FuzzOperationCoverage } from "./utils/FuzzOperationCoverage.js"

type OperationEvent = Extract<FuzzModelEvent, { type: "operation" }>

function operation(operation: OperationEvent["operation"], phase: OperationEvent["phase"], overrides: Partial<OperationEvent> = {}): OperationEvent {
	return {
		type: "operation",
		operation,
		phase,
		...overrides,
	}
}

export function shouldBehaveLikeFuzzOperationCoverage(): void {
	it("keeps every corner operation visible and zero-filled before any attempt", function () {
		expect(new FuzzOperationCoverageTracker().snapshot()).to.deep.equal({
			totals: {
				attempted: 0,
				succeeded: 0,
				skipped: 0,
				failed: 0,
			},
			byOperation: {
				FUNDING_CHARGE: { attempted: 0, succeeded: 0, skipped: 0, failed: 0 },
				SETTLE_UPNL: { attempted: 0, succeeded: 0, skipped: 0, failed: 0 },
				FORCE_CLOSE: { attempted: 0, succeeded: 0, skipped: 0, failed: 0 },
				EMERGENCY_CLOSE: { attempted: 0, succeeded: 0, skipped: 0, failed: 0 },
				EXPIRE_QUOTE: { attempted: 0, succeeded: 0, skipped: 0, failed: 0 },
				LIQUIDATE_PARTY_A: { attempted: 0, succeeded: 0, skipped: 0, failed: 0 },
				LIQUIDATE_PARTY_B: { attempted: 0, succeeded: 0, skipped: 0, failed: 0 },
			},
		})
	})

	it("counts attempts and each terminal outcome without losing optional diagnostics", function () {
		const tracker = new FuzzOperationCoverageTracker()

		tracker.observe(operation("FUNDING_CHARGE", "started", { quoteIds: [17n], actorIds: ["keeper#1"], detail: "daily charge" }))
		tracker.observe(operation("FUNDING_CHARGE", "succeeded", { quoteIds: [17n] }))
		tracker.observe(operation("SETTLE_UPNL", "started"))
		tracker.observe(operation("SETTLE_UPNL", "skipped", { detail: "nothing to settle" }))
		tracker.observe(operation("FORCE_CLOSE", "started"))
		tracker.observe(operation("FORCE_CLOSE", "failed", { actorIds: ["user#2"], detail: "cooldown", error: new Error("not ready") }))
		tracker.observe(operation("EMERGENCY_CLOSE", "succeeded"))

		const coverage = tracker.snapshot()
		expect(coverage.totals).to.deep.equal({ attempted: 3, succeeded: 2, skipped: 1, failed: 1 })
		expect(coverage.byOperation.FUNDING_CHARGE).to.deep.equal({ attempted: 1, succeeded: 1, skipped: 0, failed: 0 })
		expect(coverage.byOperation.SETTLE_UPNL).to.deep.equal({ attempted: 1, succeeded: 0, skipped: 1, failed: 0 })
		expect(coverage.byOperation.FORCE_CLOSE).to.deep.equal({ attempted: 1, succeeded: 0, skipped: 0, failed: 1 })
		expect(coverage.byOperation.EMERGENCY_CLOSE).to.deep.equal({ attempted: 0, succeeded: 1, skipped: 0, failed: 0 })
		expect(() => JSON.stringify(coverage)).not.to.throw()
	})

	it("requires a complete successful corner bag when a bounded run schedules enough campaigns", function () {
		const tracker = new FuzzOperationCoverageTracker()
		const boundedConfig = {
			runMode: "bounded" as const,
			rootActions: FUZZ_CORNER_OPERATIONS.length,
			cornerEvery: 1,
		}

		expect(() => assertRequiredFuzzOperationCoverage(boundedConfig, tracker.snapshot())).to.throw(
			"bounded corner campaign did not successfully cover",
		)

		for (const operationName of FUZZ_CORNER_OPERATIONS) {
			tracker.observe(operation(operationName, "started"))
			tracker.observe(operation(operationName, "succeeded"))
		}

		expect(() => assertRequiredFuzzOperationCoverage(boundedConfig, tracker.snapshot())).not.to.throw()
	})

	it("does not demand a complete bag when corners are disabled or too few are scheduled", function () {
		const emptyCoverage: FuzzOperationCoverage = new FuzzOperationCoverageTracker().snapshot()

		expect(() =>
			assertRequiredFuzzOperationCoverage(
				{
					runMode: "bounded",
					rootActions: FUZZ_CORNER_OPERATIONS.length - 1,
					cornerEvery: 1,
				},
				emptyCoverage,
			),
		).not.to.throw()
		expect(() =>
			assertRequiredFuzzOperationCoverage(
				{
					runMode: "bounded",
					rootActions: FUZZ_CORNER_OPERATIONS.length,
					cornerEvery: 0,
				},
				emptyCoverage,
			),
		).not.to.throw()
		expect(() =>
			assertRequiredFuzzOperationCoverage(
				{
					runMode: "continuous",
					rootActions: FUZZ_CORNER_OPERATIONS.length,
					cornerEvery: 1,
				},
				emptyCoverage,
			),
		).not.to.throw()
	})
}
