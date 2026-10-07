const UNCERTAIN = new Set(["submitted", "unresolved", "timed_out"]);
const EVENTS = new Map([
	["task.started", "started"],
	["task.completed", "completed"],
	["task.failed", "failed"],
	["task.paused", "paused"],
	["task.waiting", "waiting"],
	["task.cancelled", "cancelled"],
	["tx.submitted", "submitted"],
	["tx.confirmed", "confirmed"],
	["tx.failed", "failed"],
]);
const age = (at, now) => (Number.isFinite(Date.parse(at)) ? Math.max(0, now - Date.parse(at)) : null);

// No free-form messages, request payloads, endpoints, addresses, or full errors.
// IDs occur only in correlation, never in labels. Catalog-derived labels are bounded.
export function projectTelemetry(state, event, { operations = [], phases = [], chain = "unknown", provider = "unknown" } = {}) {
	const outcome = EVENTS.get(event.type);
	if (!outcome) return null;
	return {
		apiVersion: "operations.symm.io/telemetry-v1",
		id: event.eventId || `${state.runId}:${event.sequence}`,
		at: event.at,
		labels: {
			chain,
			provider,
			operation: operations.includes(state.taskId) ? state.taskId : "other",
			phase: phases.includes(state.currentPhase) ? state.currentPhase : "other",
			outcome,
			errorCategory: event.unrecoverable
				? "validation"
				: event.transaction?.status === "timed_out"
					? "timeout"
					: outcome === "failed"
						? "execution"
						: "none",
		},
		durationMs: event.type.startsWith("tx.")
			? (event.transaction?.durationMs ?? 0)
			: age(state.attemptStartedAt, Date.parse(state.attemptEndedAt || event.at)),
		correlation: {
			runId: state.runId,
			attempt: state.attempt,
			...(event.transaction?.hash ? { transactionHash: event.transaction.hash } : {}),
			...(event.transaction?.replacementHash ? { replacementHash: event.transaction.replacementHash } : {}),
		},
	};
}

export function telemetrySnapshot(state, now = new Date()) {
	const pending = (state.transactions || []).filter(transaction => UNCERTAIN.has(transaction.status));
	const ages = pending.map(transaction => age(transaction.submittedAt, now.getTime()));
	return {
		apiVersion: "operations.symm.io/telemetry-snapshot-v1",
		at: now.toISOString(),
		correlation: { runId: state.runId, attempt: state.attempt ?? null },
		status: ["prepared", "running", "paused", "waiting_external", "cancel_pending", "completed", "failed", "cancelled"].includes(state.status)
			? state.status
			: "unknown",
		unresolvedCount: pending.length,
		unresolvedAgeMs: ages.length && ages.every(value => value !== null) ? Math.max(...ages) : ages.length ? null : 0,
		governanceWaitAgeMs: state.status === "waiting_external" ? age(state.waitingSince, now.getTime()) : 0,
	};
}

export function createTelemetryPublisher(collector, labels) {
	for (const value of [labels?.chain ?? "unknown", labels?.provider ?? "unknown"]) {
		if (!/^[a-z][a-z0-9.-]{0,63}$/.test(value)) throw new Error("Telemetry requires bounded public chain/provider aliases");
	}
	const delivered = new Set();
	return (state, event) => {
		const projection = projectTelemetry(state, event, labels);
		if (!projection || delivered.has(projection.id)) return;
		delivered.add(projection.id);
		if (delivered.size > 8192) delivered.delete(delivered.values().next().value);
		// Persistence already completed. A collector is optional, best effort, and must
		// deduplicate the stable ID across restarts. It cannot affect execution/recovery.
		try {
			Promise.resolve(collector(projection)).catch(() => {});
		} catch {}
	};
}
