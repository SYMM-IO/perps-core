import {
	FUZZ_CORNER_OPERATIONS,
	type FuzzCornerOperation,
	type FuzzModelEvent,
	type FuzzOperationPhase,
	type FuzzRunConfig,
} from "../models/FuzzLogTypes.js"

export type FuzzOperationCounts = {
	attempted: number
	succeeded: number
	skipped: number
	failed: number
}

export type FuzzOperationCoverage = {
	totals: FuzzOperationCounts
	byOperation: Record<FuzzCornerOperation, FuzzOperationCounts>
}

export type FuzzOperationCoverageRequirement = Pick<FuzzRunConfig, "runMode" | "rootActions" | "cornerEvery">

type FuzzOperationEvent = Extract<FuzzModelEvent, { type: "operation" }>
type CountedOperationPhase = keyof FuzzOperationCounts

function emptyCounts(): FuzzOperationCounts {
	return {
		attempted: 0,
		succeeded: 0,
		skipped: 0,
		failed: 0,
	}
}

function emptyOperations(): Record<FuzzCornerOperation, FuzzOperationCounts> {
	return Object.fromEntries(FUZZ_CORNER_OPERATIONS.map(operation => [operation, emptyCounts()])) as Record<FuzzCornerOperation, FuzzOperationCounts>
}

function countedPhase(phase: FuzzOperationPhase): CountedOperationPhase {
	return phase === "started" ? "attempted" : phase
}

export class FuzzOperationCoverageTracker {
	private readonly byOperation = emptyOperations()
	private readonly totals = emptyCounts()

	public observe(event: FuzzOperationEvent): FuzzOperationCoverage {
		const operation = this.byOperation[event.operation]
		if (operation === undefined) throw new Error(`Unknown fuzz corner operation ${JSON.stringify(event.operation)}`)
		const phase = countedPhase(event.phase)
		operation[phase]++
		this.totals[phase]++
		return this.snapshot()
	}

	public snapshot(): FuzzOperationCoverage {
		return {
			totals: { ...this.totals },
			byOperation: Object.fromEntries(FUZZ_CORNER_OPERATIONS.map(operation => [operation, { ...this.byOperation[operation] }])) as Record<
				FuzzCornerOperation,
				FuzzOperationCounts
			>,
		}
	}
}

export function assertRequiredFuzzOperationCoverage(config: FuzzOperationCoverageRequirement, coverage: FuzzOperationCoverage): void {
	if (config.runMode !== "bounded" || config.cornerEvery === 0) return

	const scheduledCampaigns = Math.floor(config.rootActions / config.cornerEvery)
	if (scheduledCampaigns < FUZZ_CORNER_OPERATIONS.length) return

	const missing = FUZZ_CORNER_OPERATIONS.filter(operation => {
		const counts = coverage.byOperation[operation]
		return counts.attempted === 0 || counts.succeeded === 0
	})
	if (missing.length > 0) {
		throw new Error(`The bounded corner campaign did not successfully cover: ${missing.join(", ")}`)
	}
}
