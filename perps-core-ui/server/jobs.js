import { HttpError, classify } from "./errors.js";
import { randomUUID } from "node:crypto";

// Reads only: stopping one leaves nothing half-done. Execute, resume and task cancellation follow the task runner's own policy.
export const CANCELLABLE = new Set(["system/scan", "system/compare", "system/rehearse", "connect", "compile", "rehearse"]);

// What the interface needs from a finished job, taken from what the adapter returned.
function summarize(value) {
	if (!value || typeof value !== "object") return undefined;
	const result = {};
	const planId = value.plan?.id || value.planId || (/^[a-f0-9]{64}$/.test(value.id || "") ? value.id : undefined);
	if (planId) result.planId = planId;
	const digest = value.digest || value.build?.digest;
	if (digest) result.digest = digest;
	if (Number.isSafeInteger(value.blockNumber)) result.blockNumber = value.blockNumber;
	if (typeof value.fingerprint === "string") result.fingerprint = value.fingerprint;
	const status = value.rehearsal?.status || (typeof value.status === "string" ? value.status : undefined);
	if (status) result.status = status;
	return Object.keys(result).length ? result : undefined;
}

/**
 * One lock for every operation that reads or changes adapter state, and a record of the last few. Each job has
 * an id the interface can follow, its own error and result, and an abort signal when it only reads.
 */
export function createJobs({ onChange = () => {}, limit = 10 } = {}) {
	const jobs = [];
	let running = null;
	const view = ({ controller, ...job }) => job;
	function record(route, extra = {}) {
		const job = { id: randomUUID(), route, state: "running", startedAt: new Date().toISOString(), ...extra };
		jobs.unshift(job);
		jobs.length = Math.min(jobs.length, limit);
		onChange();
		return job;
	}
	function end(job, state, fields = {}) {
		Object.assign(job, { state, endedAt: new Date().toISOString() }, fields);
		delete job.controller;
		if (running === job) running = null;
		onChange();
	}
	function fail(job, error) {
		const { message, code } = classify(error);
		end(job, job.controller?.signal.aborted ? "cancelled" : "failed", { error: message, code });
	}
	// A refused start is still a job: the interface sees why it did not run instead of a request that went nowhere.
	function claim(route, meta) {
		if (!running) {
			const job = record(route, meta);
			if (CANCELLABLE.has(route)) job.controller = new AbortController();
			running = job;
			return job;
		}
		const refused = record(route, meta);
		const error = new HttpError(409, "busy", "Wait for the current operation to finish");
		end(refused, "failed", { error: error.message, code: error.code });
		error.jobId = refused.id;
		throw error;
	}
	async function settle(job, action) {
		try {
			const value = await action({ signal: job.controller?.signal });
			const result = summarize(value);
			end(job, "done", result ? { result } : {});
			return value;
		} catch (error) {
			fail(job, error);
			error.jobId = job.id;
			throw error;
		}
	}
	return {
		busy: () => !!running,
		current: () => (running ? view(running) : null),
		list: () => jobs.map(view),
		/** Starts a background job and answers at once; the outcome lands on the job. */
		start(route, action, meta) {
			const job = claim(route, meta);
			settle(job, action).catch(() => {});
			return { accepted: true, jobId: job.id };
		},
		/** Runs an operation the request waits for, under the same lock and record. */
		async inline(route, action, meta) {
			const job = claim(route, meta);
			return { jobId: job.id, value: await settle(job, action) };
		},
		/** Records a refusal that happened before a job could start, such as invalid input. */
		reject(route, error, meta) {
			const job = record(route, meta);
			fail(job, error);
			return job.id;
		},
		cancel(id) {
			if (typeof id !== "string" || !id) throw new HttpError(400, "bad-input", "Name the job to cancel");
			const job = jobs.find(j => j.id === id);
			if (!job) throw new HttpError(404, "unknown-job", "That job is no longer listed");
			if (job.state !== "running") throw new HttpError(409, "not-running", "That job has already finished");
			if (!job.controller) throw new HttpError(409, "not-cancellable", "This operation follows the task's own cancellation; use Cancel task");
			job.controller.abort(new HttpError(499, "cancelled", "Cancelled by the operator"));
			onChange();
			return { accepted: true, jobId: job.id };
		},
		/** Aborts whatever can be aborted, for shutdown. */
		abortAll() {
			for (const job of jobs) job.controller?.abort(new HttpError(499, "cancelled", "The service is closing"));
		},
	};
}
