import { log, Timer } from "./log.js"

/**
 * Minimum shape a report-step entry must have for the reporter to stamp it.
 * Scripts are free to add extra fields (details, name, status) alongside.
 */
export type TimestampedStep = {
	startedAt?: string
	finishedAt?: string
	durationMs?: number
}

/**
 * Bind a reporter to a script's `report.steps` array. Each call to `finish(timer)`
 * stamps ISO-8601 startedAt / finishedAt and durationMs onto the LAST entry in the
 * array, then prints the human-formatted finish line. Idempotent — won't overwrite
 * values that are already set (useful when a step pushes its entry, stamps custom
 * fields, and then calls finish).
 *
 * Usage:
 *   const stepReporter = createStepReporter(report.steps)
 *   let t = log.step("Deploy facets")
 *   report.steps.push({ name: "deploy_facets", status: "ok" })
 *   // ... do work ...
 *   stepReporter.finish(t)
 */
export function createStepReporter<TStep extends TimestampedStep>(steps: TStep[]): {
	finish: (timer: Timer) => void
} {
	return {
		finish(timer: Timer): void {
			const last = steps[steps.length - 1]
			if (last) {
				if (last.startedAt === undefined) last.startedAt = timer.startedAt()
				if (last.finishedAt === undefined) last.finishedAt = timer.nowIso()
				if (last.durationMs === undefined) last.durationMs = timer.ms()
			}
			log.stepDone(timer)
		},
	}
}
