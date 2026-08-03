(() => {
	"use strict";

	const POLL_INTERVAL_MS = 1_000;
	const RUNS_INTERVAL_MS = 12_000;
	const FETCH_TIMEOUT_MS = 5_000;
	const STALE_AFTER_MS = 5_000;
	const ACTIVITY_PAGE_SIZE = 12;

	const QUOTE_STATES = [
		{ key: "PENDING", label: "Awaiting hedger", group: "waiting" },
		{ key: "LOCKED", label: "Reserved by hedger", group: "waiting" },
		{ key: "CANCEL_PENDING", label: "Cancellation requested", group: "waiting" },
		{ key: "OPENED", label: "Position open", group: "positions" },
		{ key: "CLOSE_PENDING", label: "Close requested", group: "positions" },
		{ key: "CANCEL_CLOSE_PENDING", label: "Close cancellation requested", group: "positions" },
		{ key: "CANCELED", label: "Canceled before opening", group: "outcomes" },
		{ key: "CLOSED", label: "Closed", group: "outcomes" },
		{ key: "LIQUIDATED", label: "Liquidated after opening", group: "outcomes" },
		{ key: "EXPIRED", label: "Expired", group: "outcomes" },
		{ key: "LIQUIDATED_PENDING", label: "Liquidated before opening", group: "outcomes" },
	];

	const CORNER_OPERATIONS = [
		{ key: "FUNDING_CHARGE", label: "Funding charge", short: "FUND" },
		{ key: "SETTLE_UPNL", label: "Settle unrealized PnL", short: "SETTLE" },
		{ key: "FORCE_CLOSE", label: "Force close", short: "FORCE" },
		{ key: "EMERGENCY_CLOSE", label: "Emergency close", short: "EMERG" },
		{ key: "EXPIRE_QUOTE", label: "Quote expiry", short: "EXPIRY" },
		{ key: "LIQUIDATE_PARTY_A", label: "User liquidation", short: "USER LIQ" },
		{ key: "LIQUIDATE_PARTY_B", label: "Hedger liquidation", short: "HEDGER LIQ" },
	];

	const ACTION_ORDER = [
		"SEND_QUOTE",
		"CANCEL_REQUEST",
		"ACCEPT_CANCEL_REQUEST",
		"LOCK_QUOTE",
		"UNLOCK_QUOTE",
		"OPEN_POSITION",
		"CLOSE_REQUEST",
		"CANCEL_CLOSE_REQUEST",
		"ACCEPT_CANCEL_CLOSE_REQUEST",
		"FILL_POSITION",
	];

	const dom = {};
	const chartModels = new WeakMap();
	const state = {
		report: null,
		runs: [],
		selectedRunId: "",
		following: true,
		lastSuccessAt: 0,
		lastReportAt: 0,
		lastRunsAt: 0,
		error: null,
		reportRequest: 0,
		pollTimer: null,
		statusTimer: null,
		runsTimer: null,
		resizeFrame: 0,
		chartWindow: 64,
		activityFilter: "all",
		activityVisible: ACTIVITY_PAGE_SIZE,
		detailsTab: "coverage",
		connectionState: "",
		storyAnimation: null,
		storyTimers: [],
		storyReportKey: "",
		storyPlayed: false,
	};

	function element(id) {
		return document.getElementById(id);
	}

	function cacheDom() {
		for (const id of [
			"connection-banner",
			"connection-dot",
			"connection-label",
			"connection-detail",
			"run-select",
			"follow-button",
			"follow-button-label",
			"export-report",
			"waiting-state",
			"error-banner",
			"error-message",
			"retry-button",
			"dashboard",
			"details",
			"run-status",
			"run-mode",
			"run-title",
			"run-subtitle",
			"hero-replay-button",
			"actors-value",
			"environment-value",
			"seed-value",
			"elapsed-value",
			"freshness-value",
			"trace-value",
			"technical-mode-value",
			"technical-cycle-value",
			"story-replay",
			"story-track",
			"story-token",
			"story-actors",
			"story-actor-value",
			"story-cycle-value",
			"story-job-value",
			"story-risk-value",
			"story-stage-copy",
			"story-run-note",
			"health-note",
			"kpi-strip",
			"summary-limit-note",
			"quotes-title",
			"outcome-bar",
			"outcome-strip",
			"outcome-note",
			"coverage-verdict-title",
			"coverage-status",
			"coverage-summary",
			"coverage-grid",
			"coverage-gaps",
			"confidence-limit-summary",
			"confidence-limit-list",
			"quote-chart",
			"quote-tooltip",
			"quote-chart-table",
			"pace-chart",
			"pace-tooltip",
			"pace-chart-table",
			"pace-telemetry-note",
			"queue-chart",
			"queue-tooltip",
			"queue-chart-table",
			"queue-telemetry-note",
			"lifecycle-summary",
			"lifecycle-bars",
			"action-table",
			"action-type-summary",
			"action-type-coverage",
			"corner-matrix",
			"mix-grid",
			"activity-list",
			"activity-count",
			"activity-retention-note",
			"activity-footer",
			"activity-more",
			"failure-count",
			"failure-list",
			"replay-command",
			"copy-replay-panel",
			"retention-list",
			"footer-source",
			"announcer",
		]) {
			dom[id] = element(id);
		}
	}

	function isObject(value) {
		return value !== null && typeof value === "object" && !Array.isArray(value);
	}

	function object(value) {
		return isObject(value) ? value : {};
	}

	function array(value) {
		if (Array.isArray(value)) return value;
		if (isObject(value)) return Object.values(value);
		return [];
	}

	function valueAt(source, path) {
		let value = source;
		for (const part of path.split(".")) {
			if (!isObject(value) && !Array.isArray(value)) return undefined;
			value = value[part];
		}
		return value;
	}

	function pick(source, ...paths) {
		for (const path of paths) {
			const value = typeof path === "string" ? valueAt(source, path) : path;
			if (value !== undefined && value !== null) return value;
		}
		return undefined;
	}

	function firstObject(source, ...paths) {
		for (const path of paths) {
			const value = valueAt(source, path);
			if (isObject(value)) return value;
		}
		return {};
	}

	function firstArray(source, ...paths) {
		for (const path of paths) {
			const value = valueAt(source, path);
			if (Array.isArray(value)) return value;
		}
		return [];
	}

	function numeric(value, fallback = 0) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "bigint") return Number(value);
		if (typeof value === "string" && value.trim() !== "") {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
		}
		return fallback;
	}

	function optionalNumber(...values) {
		for (const value of values) {
			if (typeof value === "number" && Number.isFinite(value)) return value;
			if (typeof value === "bigint") return Number(value);
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) return parsed;
			}
		}
		return undefined;
	}

	function boolean(value, fallback = false) {
		if (typeof value === "boolean") return value;
		if (value === 1 || value === "1" || value === "true") return true;
		if (value === 0 || value === "0" || value === "false") return false;
		return fallback;
	}

	function text(value, fallback = "—") {
		if (typeof value === "string" && value.trim() !== "") return value;
		if (typeof value === "number" || typeof value === "bigint") return String(value);
		if (typeof value === "boolean") return value ? "yes" : "no";
		if (isObject(value)) {
			const message = pick(value, "message", "reason", "detail", "name");
			if (message !== undefined) return text(message, fallback);
		}
		return fallback;
	}

	function clamp(value, minimum, maximum) {
		return Math.min(maximum, Math.max(minimum, value));
	}

	function compactNumber(value) {
		const number = numeric(value);
		const absolute = Math.abs(number);
		if (absolute < 10_000) return new Intl.NumberFormat("en-US", { maximumFractionDigits: absolute < 10 ? 1 : 0 }).format(number);
		return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(number);
	}

	function rate(value) {
		const number = optionalNumber(value);
		return number === undefined ? "—" : `${number.toFixed(number >= 10 ? 0 : 1)}/s`;
	}

	function percent(value) {
		const number = optionalNumber(value);
		if (number === undefined) return "—";
		const normalized = number > 1 ? number : number * 100;
		return `${normalized.toFixed(normalized >= 10 ? 0 : 1)}%`;
	}

	function duration(value) {
		const milliseconds = optionalNumber(value);
		if (milliseconds === undefined) return "—";
		if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
		const seconds = milliseconds / 1_000;
		if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = Math.floor(seconds % 60);
		if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
		const hours = Math.floor(minutes / 60);
		return `${hours}h ${minutes % 60}m`;
	}

	function bytes(value) {
		const size = optionalNumber(value);
		if (size === undefined) return "—";
		if (size < 1_024) return `${Math.round(size)} B`;
		if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KiB`;
		return `${(size / 1_048_576).toFixed(1)} MiB`;
	}

	function timestampNumber(value) {
		const number = optionalNumber(value);
		if (number !== undefined) {
			if (number > 0 && number < 10_000_000_000) return number * 1_000;
			return number;
		}
		if (typeof value === "string") {
			const parsed = Date.parse(value);
			if (Number.isFinite(parsed)) return parsed;
		}
		return undefined;
	}

	function clockTime(value) {
		const timestamp = timestampNumber(value);
		if (timestamp === undefined) return "";
		return new Intl.DateTimeFormat("en", {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		}).format(new Date(timestamp));
	}

	function shortDate(value) {
		const timestamp = timestampNumber(value);
		if (timestamp === undefined) return "";
		return new Intl.DateTimeFormat("en", {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}).format(new Date(timestamp));
	}

	function ago(timestamp) {
		if (!timestamp) return "waiting";
		const elapsed = Math.max(0, Date.now() - timestamp);
		if (elapsed < 1_500) return "just now";
		if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
		if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
		return shortDate(timestamp);
	}

	function humanize(value) {
		return text(value, "")
			.replace(/_/g, " ")
			.replace(/\b\w/g, character => character.toUpperCase());
	}

	function stakeholderCopy(value, fallback = "") {
		return text(value, fallback)
			.replace(/\bParty\s*A\b/gi, "user")
			.replace(/\bParty\s*B\b/gi, "hedger")
			.replace(/\bPartyA\b/gi, "user")
			.replace(/\bPartyB\b/gi, "hedger")
			.replace(/\broot actions?\b/gi, "simulation cycles")
			.replace(/\broots?\b/gi, match => (/s$/i.test(match) ? "simulation cycles" : "simulation cycle"));
	}

	function create(tag, className, content) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (content !== undefined) node.textContent = text(content, "");
		return node;
	}

	function setText(node, value, fallback = "—") {
		if (node) node.textContent = text(value, fallback);
	}

	function announce(message) {
		if (!dom.announcer) return;
		dom.announcer.textContent = "";
		window.setTimeout(() => {
			dom.announcer.textContent = message;
		}, 20);
	}

	function reportRun(report = state.report) {
		return firstObject(report || {}, "run");
	}

	function reportSetup(report = state.report) {
		return firstObject(report || {}, "setup", "run.setup");
	}

	function reportConfig(report = state.report) {
		return firstObject(report || {}, "config", "run.config");
	}

	function reportLatest(report = state.report) {
		return firstObject(report || {}, "latest");
	}

	function reportResult(report = state.report) {
		return firstObject(report || {}, "result", "run.result");
	}

	function currentQueue(report = state.report) {
		return firstObject(report || {}, "latest.queue", "latest.engine.queue", "result.queue", "run.queue", "queue");
	}

	function currentQuotes(report = state.report) {
		return firstObject(
			report || {},
			"latest.quotes",
			"latest.quoteInventory",
			"latest.inventory",
			"result.quotes",
			"result.quoteInventory",
			"quotes",
		);
	}

	function currentCorners(report = state.report) {
		return firstObject(report || {}, "latest.corners", "latest.cornerCoverage", "result.corners", "corners");
	}

	function currentAssurance(report = state.report) {
		return firstObject(report || {}, "latest.assurance", "result.assurance", "assurance");
	}

	function currentActions(report = state.report) {
		return firstObject(report || {}, "latest.actions", "latest.actionOutcomes", "result.actions", "actions");
	}

	function hasTelemetry(source, fields) {
		return isObject(source) && fields.some(field => valueAt(source, field) !== undefined);
	}

	function hasQuoteTelemetry(quotes) {
		return hasTelemetry(quotes, ["total", "active", "live", "terminal", "ended", "byStatus", "statuses", "status"]);
	}

	function quoteStatusMap(quotes) {
		return firstObject(quotes, "byStatus", "statuses", "status");
	}

	function hasQuoteStatusBreakdown(quotes) {
		const counts = quoteStatusMap(quotes);
		return QUOTE_STATES.some(item => counts[item.key] !== undefined && counts[item.key] !== null);
	}

	function hasQueueTelemetry(queue) {
		return hasTelemetry(queue, [
			"accepted",
			"totalAccepted",
			"completed",
			"settled",
			"totalCompleted",
			"outstanding",
			"pending",
			"waiting",
			"scheduled",
			"running",
			"active",
			"failures",
			"errors",
		]);
	}

	function counterValue(value) {
		if (Array.isArray(value)) return value.length;
		return optionalNumber(value);
	}

	function actionFailureSnapshot(report = state.report) {
		const actions = currentActions(report);
		const actionMap = firstObject(actions, "byAction", "actions", "by_action");
		const actionEntries = Object.values(actionMap).filter(isObject);
		const failedValue = pick(actions, "failed", "totals.failed", "outcomes.failed");
		const timedOutValue = pick(actions, "timedOut", "timed_out", "totals.timedOut", "totals.timed_out");
		const perActionFailuresAvailable = actionEntries.length > 0 && actionEntries.every(item => pick(item, "failed", "failures") !== undefined);
		const perActionTimeoutsAvailable =
			actionEntries.length > 0 && actionEntries.every(item => pick(item, "timedOut", "timed_out", "timeouts") !== undefined);
		return {
			failedAvailable: failedValue !== undefined || perActionFailuresAvailable,
			timedOutAvailable: timedOutValue !== undefined || perActionTimeoutsAvailable,
			failed:
				counterValue(failedValue) ??
				(perActionFailuresAvailable
					? actionEntries.reduce((total, item) => total + numeric(pick(item, "failed", "failures")), 0)
					: undefined),
			timedOut:
				counterValue(timedOutValue) ??
				(perActionTimeoutsAvailable
					? actionEntries.reduce((total, item) => total + numeric(pick(item, "timedOut", "timed_out", "timeouts")), 0)
					: undefined),
		};
	}

	function queueFailureSnapshot(report = state.report) {
		const queue = currentQueue(report);
		const value = pick(queue, "failures", "errors");
		return {
			available: value !== undefined,
			value: counterValue(value),
		};
	}

	function statusCounts(quotes) {
		const counts = quoteStatusMap(quotes);
		return Object.fromEntries(QUOTE_STATES.map(item => [item.key, numeric(counts[item.key])]));
	}

	function terminalCount(counts) {
		return ["CANCELED", "CLOSED", "LIQUIDATED", "EXPIRED", "LIQUIDATED_PENDING"].reduce((sum, key) => sum + numeric(counts[key]), 0);
	}

	function liveCount(counts) {
		return ["PENDING", "LOCKED", "CANCEL_PENDING", "OPENED", "CLOSE_PENDING", "CANCEL_CLOSE_PENDING"].reduce(
			(sum, key) => sum + numeric(counts[key]),
			0,
		);
	}

	function quoteTotals(quotes) {
		const counts = statusCounts(quotes);
		const rawCounts = quoteStatusMap(quotes);
		const activeKeys = ["PENDING", "LOCKED", "CANCEL_PENDING", "OPENED", "CLOSE_PENDING", "CANCEL_CLOSE_PENDING"];
		const terminalKeys = ["CANCELED", "CLOSED", "LIQUIDATED", "EXPIRED", "LIQUIDATED_PENDING"];
		const active =
			optionalNumber(quotes.active, quotes.live) ??
			(activeKeys.every(key => optionalNumber(rawCounts[key]) !== undefined) ? liveCount(counts) : undefined);
		const terminal =
			optionalNumber(quotes.terminal, quotes.ended) ??
			(terminalKeys.every(key => optionalNumber(rawCounts[key]) !== undefined) ? terminalCount(counts) : undefined);
		const total = optionalNumber(quotes.total) ?? (active !== undefined && terminal !== undefined ? active + terminal : undefined);
		return { counts, active, terminal, total };
	}

	function queueTotals(queue) {
		const accepted = numeric(pick(queue, "accepted", "totalAccepted"));
		const completed = numeric(pick(queue, "completed", "settled", "totalCompleted"));
		const outstanding = optionalNumber(queue.outstanding) ?? Math.max(0, accepted - completed);
		return {
			accepted,
			completed,
			outstanding,
			pending: numeric(pick(queue, "pending", "waiting")),
			scheduled: numeric(queue.scheduled),
			running: boolean(queue.running) ? 1 : numeric(queue.active),
			paused: boolean(queue.paused),
			failures: counterValue(pick(queue, "failures", "errors")),
		};
	}

	function countFailures(report = state.report) {
		const failures = failureRecords(report);
		const actions = actionFailureSnapshot(report);
		const queue = queueFailureSnapshot(report);
		return {
			records: failures.length,
			failedActions: actions.failed,
			timedOutActions: actions.timedOut,
			queueFailures: queue.value,
		};
	}

	function runSignalSnapshot(report = state.report) {
		const failures = countFailures(report);
		const corners = currentCorners(report);
		const cornerMap = operationMap(corners);
		const cornerEntries = Object.values(cornerMap).filter(isObject);
		const explicitCornerFailures = pick(corners, "totals.failed", "failed");
		const perCornerFailuresAvailable = cornerEntries.length > 0 && cornerEntries.every(item => pick(item, "failed", "failures") !== undefined);
		const cornerFailuresAvailable = explicitCornerFailures !== undefined || perCornerFailuresAvailable;
		const actions = actionFailureSnapshot(report);
		const queue = queueFailureSnapshot(report);
		const evidenceGaps = [
			...(!actions.failedAvailable ? ["action failures"] : []),
			...(!actions.timedOutAvailable ? ["action timeouts"] : []),
			...(!queue.available ? ["queue failures"] : []),
			...(!cornerFailuresAvailable ? ["high-risk workflow failures"] : []),
		];
		const cornerFailures =
			counterValue(explicitCornerFailures) ??
			(perCornerFailuresAvailable ? cornerEntries.reduce((total, item) => total + numeric(pick(item, "failed", "failures")), 0) : undefined);
		const retention = firstObject(report || {}, "retention");
		const storageWarning = text(retention.lastWriteError, "");
		const failureCategories = [
			failures.records > 0 ? `${compactNumber(failures.records)} boundary ${failures.records === 1 ? "record" : "records"}` : "",
			failures.failedActions > 0
				? `${compactNumber(failures.failedActions)} failed ${failures.failedActions === 1 ? "action" : "actions"}`
				: "",
			failures.timedOutActions > 0
				? `${compactNumber(failures.timedOutActions)} timed-out ${failures.timedOutActions === 1 ? "action" : "actions"}`
				: "",
			failures.queueFailures > 0
				? `${compactNumber(failures.queueFailures)} queue ${failures.queueFailures === 1 ? "failure" : "failures"}`
				: "",
			cornerFailures > 0 ? `${compactNumber(cornerFailures)} high-risk workflow ${cornerFailures === 1 ? "failure" : "failures"}` : "",
		].filter(Boolean);
		const badStatus = /(fail|error|abort|timeout)/.test(runStatus(report));
		if (badStatus && failureCategories.length === 0) failureCategories.push(`Run status: ${humanize(runStatus(report))}`);
		const categories = [...failureCategories, ...(storageWarning ? [`Storage warning: ${storageWarning}`] : [])];
		return {
			count: categories.length,
			categories,
			failureCategories,
			hasFailure: failureCategories.length > 0,
			storageWarning,
			evidenceComplete: evidenceGaps.length === 0,
			evidenceGaps,
		};
	}

	function runStatus(report = state.report) {
		const source = report || {};
		return text(
			pick(source, "run.status", "run.phase", "run.outcome", "result.status", "result.outcome", "latest.status", "status"),
			"waiting",
		).toLowerCase();
	}

	function isLiveRun(report = state.report) {
		return /(run|active|live|drain)/.test(runStatus(report));
	}

	function isTerminalRun(report = state.report) {
		return /(pass|stop|fail|complete|finished|error|abort|timeout)/.test(runStatus(report));
	}

	function statusTone(status) {
		if (/(fail|error|abort|timeout)/.test(status)) return "bad";
		if (/(pass|complete|success|finished)/.test(status)) return "good";
		if (/(drain|stop|frozen|stale)/.test(status)) return "warn";
		if (/(run|active|live|ready|start)/.test(status)) return "info";
		return "neutral";
	}

	function runOutcomeSnapshot(report = state.report) {
		const status = runStatus(report);
		const signals = runSignalSnapshot(report);
		const queueSource = currentQueue(report);
		const queue = hasQueueTelemetry(queueSource) ? queueTotals(queueSource) : undefined;
		const clean = !signals.hasFailure && signals.evidenceComplete;
		const drained = queue ? queue.outstanding === 0 : undefined;
		const operatorStopped = /(stop)/.test(status) && text(pick(report || {}, "run.signal", "signal"), "").toUpperCase() === "SIGINT";
		const stoppedCleanly = /(stop)/.test(status) && clean && drained === true;
		const label = signals.hasFailure
			? "Needs attention"
			: stoppedCleanly
				? "Stopped cleanly"
				: /(drain)/.test(status)
					? "Finishing current work"
					: /(run|active|live)/.test(status)
						? "Simulation running"
						: /(pass|complete|success|finished)/.test(status) && clean
							? "Completed cleanly"
							: humanize(status);
		return { status, signals, queue, clean, drained, operatorStopped, stoppedCleanly, label };
	}

	function renderRunStatus(report, connectionState = state.connectionState) {
		const outcome = runOutcomeSnapshot(report);
		const snapshot = connectionState === "stale" || connectionState === "frozen" || connectionState === "error";
		setText(dom["run-status"], `${snapshot ? "Last reported: " : ""}${outcome.label}`.toUpperCase());
		const tone = outcome.stoppedCleanly ? "good" : statusTone(outcome.status);
		dom["run-status"].dataset.tone = snapshot && tone !== "bad" ? "warn" : tone;
	}

	function rootCount(report = state.report) {
		const source = report || {};
		return (
			optionalNumber(
				pick(source, "latest.root.completed", "latest.root.index", "latest.rootIndex", "latest.roots", "latest.rootActions"),
				pick(source, "counters.roots.completed", "run.result.rootActions", "result.rootActions", "run.rootActions", "run.roots"),
			) ?? 0
		);
	}

	function elapsedMs(report = state.report) {
		const source = report || {};
		const explicit = optionalNumber(
			pick(source, "latest.elapsedMs", "run.elapsedMs", "run.result.durationMs", "result.durationMs", "latest.durationMs"),
		);
		if (explicit !== undefined) return explicit;
		const startedAt = timestampNumber(pick(source, "run.startedAt", "run.started_at", "startedAt"));
		if (startedAt === undefined) return undefined;
		const finishedAt = timestampNumber(
			pick(source, "run.finishedAt", "run.finished_at", "result.finishedAt", "result.finished_at", "finishedAt"),
		);
		if (finishedAt !== undefined) return Math.max(0, finishedAt - startedAt);
		const currentFreshView =
			state.report === source &&
			state.following &&
			!state.selectedRunId &&
			isLiveRun(source) &&
			state.lastReportAt > 0 &&
			Date.now() - state.lastReportAt <= STALE_AFTER_MS;
		const reportedAt =
			timestampNumber(pick(source, "generatedAt", "updatedAt", "run.updatedAt", "run.updated_at", "latest.at", "latest.timestamp")) ??
			(state.report === source ? state.lastReportAt : undefined);
		const endpoint = currentFreshView ? Date.now() : reportedAt;
		return endpoint === undefined ? undefined : Math.max(0, endpoint - startedAt);
	}

	function paceSnapshot(report = state.report) {
		const source = report || {};
		const latestPace = firstObject(source, "latest.pace", "latest.performance", "result.pace");
		const elapsed = elapsedMs(source);
		const roots = rootCount(source);
		const queueSource = currentQueue(source);
		const queueAvailable = hasQueueTelemetry(queueSource);
		const queue = queueAvailable ? queueTotals(queueSource) : undefined;
		const rootSummary = firstObject(source, "latest.root", "counters.roots");
		const timeline = timelineCandidates(source, ["pace", "throughput", "roots", "snapshots", "buckets", "points"]);
		const durations = timeline.map(point => optionalNumber(pick(object(point), "durationMs"))).filter(value => value !== undefined);
		const lastPoint = object(timeline.at(-1));
		const previousPoint = object(timeline.at(-Math.min(17, timeline.length)));
		const timelineRate = (() => {
			const completed = optionalNumber(pick(lastPoint, "roots.completed", "root"));
			const previousCompleted = optionalNumber(pick(previousPoint, "roots.completed", "root"));
			const at = optionalNumber(lastPoint.elapsedMs);
			const previousAt = optionalNumber(previousPoint.elapsedMs);
			if (completed !== undefined && previousCompleted !== undefined && at !== undefined && previousAt !== undefined && at > previousAt) {
				return ((completed - previousCompleted) * 1_000) / (at - previousAt);
			}
			if (completed !== undefined && at !== undefined && at > 0) return (completed * 1_000) / at;
			return undefined;
		})();
		const exactWindow = optionalNumber(pick(latestPace, "window", "sampleSize", "n"));
		const fallbackWindow = durations.length ? Math.min(64, durations.length) : undefined;
		const explicitRootRate = optionalNumber(
			pick(latestPace, "rootsPerSecond", "rootsPerSec", "rootRate", "throughput"),
			pick(source, "latest.rootsPerSecond"),
		);
		const aggregateRootRate = elapsed && elapsed > 0 ? roots / (elapsed / 1_000) : undefined;
		return {
			rootsPerSecond: explicitRootRate ?? (isTerminalRun(source) ? (aggregateRootRate ?? timelineRate) : (timelineRate ?? aggregateRootRate)),
			actionsPerSecond:
				optionalNumber(pick(latestPace, "actionsPerSecond", "actionsPerSec", "actionRate")) ??
				(elapsed && elapsed > 0 && queue ? queue.completed / (elapsed / 1_000) : undefined),
			p50:
				optionalNumber(pick(latestPace, "rootP50Ms", "p50Ms", "p50", "latencyP50Ms")) ??
				(durations.length ? percentile(durations.slice(-64), 0.5) : undefined),
			p95:
				optionalNumber(pick(latestPace, "rootP95Ms", "p95Ms", "p95", "latencyP95Ms")) ??
				(durations.length ? percentile(durations.slice(-64), 0.95) : undefined),
			inputYield:
				optionalNumber(pick(latestPace, "inputYield", "yield", "yieldRate")) ??
				(numeric(rootSummary.completed) > 0 ? numeric(rootSummary.sent) / numeric(rootSummary.completed) : undefined),
			window: exactWindow ?? fallbackWindow,
			windowLabel:
				exactWindow !== undefined
					? `${compactNumber(exactWindow)}-cycle rolling window`
					: fallbackWindow !== undefined
						? `${compactNumber(fallbackWindow)} retained checkpoints`
						: "Latency sample unavailable",
		};
	}

	function percentile(values, quantile) {
		if (values.length === 0) return undefined;
		const ordered = values.map(value => numeric(value)).sort((left, right) => left - right);
		const index = clamp(Math.ceil(quantile * ordered.length) - 1, 0, ordered.length - 1);
		return ordered[index];
	}

	function operationMap(corners) {
		return firstObject(corners, "byOperation", "operations", "by_operation");
	}

	function cornerCounts(corners, key) {
		const source = object(operationMap(corners)[key]);
		const attempted = numeric(pick(source, "attempted", "started", "tries"));
		const succeeded = numeric(pick(source, "succeeded", "passed", "verified"));
		const skipped = numeric(source.skipped);
		const failed = numeric(source.failed);
		const unresolved = optionalNumber(source.running, source.inProgress) ?? Math.max(0, attempted - succeeded - skipped - failed);
		return {
			attempted,
			succeeded,
			skipped,
			failed,
			unresolved,
			detail: text(pick(source, "detail", "last.detail", "message"), ""),
		};
	}

	function cornerState(counts) {
		if (counts.succeeded > 0 && counts.failed > 0) return "verified-with-failures";
		if (counts.failed > 0) return "failed";
		if (counts.unresolved > 0) return "unresolved";
		if (counts.succeeded > 0) return "passed";
		if (counts.skipped > 0) return "skipped";
		return "unseen";
	}

	function verifiedCornerCount(corners) {
		return CORNER_OPERATIONS.filter(operation => cornerCounts(corners, operation.key).succeeded > 0).length;
	}

	function coverageSnapshot(report = state.report) {
		const assurance = currentAssurance(report);
		const milestones = firstObject(report || {}, "milestones.quoteStates");
		const observedValue = pick(assurance, "observedQuoteStatuses", "lifecycle.observedStatuses");
		const lifecycleAvailable = Array.isArray(observedValue) || Object.keys(milestones).length > 0;
		const observedStates = new Set(array(observedValue).map(value => text(value, "")));
		for (const item of QUOTE_STATES) if (isObject(milestones[item.key])) observedStates.add(item.key);
		const observedStateCount = QUOTE_STATES.filter(item => observedStates.has(item.key)).length;
		const missingStates = lifecycleAvailable ? QUOTE_STATES.filter(item => !observedStates.has(item.key)) : [];

		const confirmedValue = pick(assurance, "confirmedActionTypes");
		const validatorsAvailable = Array.isArray(confirmedValue);
		const confirmedActions = new Set(array(confirmedValue).map(value => text(value, "")));
		const missingActions = validatorsAvailable ? ACTION_ORDER.filter(action => !confirmedActions.has(action)) : [];

		const corners = currentCorners(report);
		const cornerMap = operationMap(corners);
		const cornersAvailable = Object.keys(cornerMap).length > 0;
		const missingCorners = cornersAvailable ? CORNER_OPERATIONS.filter(operation => cornerCounts(corners, operation.key).succeeded === 0) : [];
		const signals = runSignalSnapshot(report);
		const coverageAvailable = lifecycleAvailable && validatorsAvailable && cornersAvailable;
		const complete = coverageAvailable && missingStates.length === 0 && missingActions.length === 0 && missingCorners.length === 0;
		const status = runStatus(report);
		const terminal = /(pass|stop|fail|complete|finished)/.test(status);
		const tone = signals.hasFailure
			? "bad"
			: signals.storageWarning || !coverageAvailable || !signals.evidenceComplete
				? "warn"
				: complete
					? "good"
					: terminal
						? "warn"
						: "info";
		const gapCount = missingStates.length + missingActions.length + missingCorners.length;
		const summary = signals.hasFailure
			? `${complete ? "Every configured run target was reached, but " : ""}${signals.failureCategories.join(
					"; ",
				)}. Review these signals before trusting this run.`
			: signals.storageWarning
				? `${complete ? "Every configured run target was reached, but dashboard" : "Dashboard"} persistence reported a storage warning. The protocol run may be clean, but this report needs review.`
				: !coverageAvailable
					? "Historical target evidence is unavailable in this report; the current quote snapshot is not treated as proof."
					: !signals.evidenceComplete
						? `${complete ? "Every configured run target was reached, but issue" : "Issue"} telemetry is incomplete: ${signals.evidenceGaps.join(
								", ",
							)} unavailable.`
						: complete
							? "Every configured target was reached: all quote states, supported action types, and high-risk workflows have evidence. This is not exhaustive protocol coverage."
							: terminal
								? `The run ended with ${compactNumber(gapCount)} configured ${gapCount === 1 ? "target" : "targets"} still unverified.`
								: `Evidence is still building; ${compactNumber(gapCount)} configured ${gapCount === 1 ? "target remains" : "targets remain"}.`;
		return {
			tone,
			title: signals.hasFailure
				? "Review needed"
				: signals.storageWarning
					? "Storage warning"
					: !coverageAvailable
						? "Coverage unavailable"
						: !signals.evidenceComplete
							? "Telemetry incomplete"
							: complete
								? "Configured targets met"
								: terminal
									? `${compactNumber(gapCount)} configured ${gapCount === 1 ? "target" : "targets"} missing`
									: "Building coverage",
			label: signals.hasFailure
				? complete
					? "REVIEW"
					: "ATTENTION"
				: signals.storageWarning
					? complete
						? "WARNING"
						: "STORAGE WARNING"
					: !coverageAvailable
						? "UNAVAILABLE"
						: !signals.evidenceComplete
							? complete
								? "TELEMETRY"
								: "TELEMETRY GAPS"
							: complete
								? "TARGETS MET"
								: terminal
									? "GAPS"
									: "BUILDING",
			summary,
			cards: [
				{
					label: "Quote states",
					value: lifecycleAvailable ? `${observedStateCount}/${QUOTE_STATES.length}` : "—",
					detail: !lifecycleAvailable
						? "Historical target evidence unavailable"
						: missingStates.length
							? `${terminal ? "Not observed in this run" : "Not observed yet"}: ${missingStates.map(item => item.label).join(", ")}`
							: "All configured quote states reached",
					tone: !lifecycleAvailable ? "warn" : missingStates.length ? "warn" : "good",
				},
				{
					label: "Actions checked",
					value: validatorsAvailable ? `${ACTION_ORDER.length - missingActions.length}/${ACTION_ORDER.length}` : "—",
					detail: !validatorsAvailable
						? "Confirmed action-type data unavailable"
						: missingActions.length
							? `${terminal ? "Not confirmed in this run" : "Not confirmed yet"}: ${missingActions.map(humanize).join(", ")}`
							: "Every supported action type independently checked",
					tone: !validatorsAvailable ? "warn" : missingActions.length ? "warn" : "good",
				},
				{
					label: "High-risk checks",
					value: cornersAvailable ? `${CORNER_OPERATIONS.length - missingCorners.length}/${CORNER_OPERATIONS.length}` : "—",
					detail: !cornersAvailable
						? "High-risk workflow data unavailable"
						: missingCorners.length
							? `${terminal ? "Not verified in this run" : "Not verified yet"}: ${missingCorners.map(item => item.label).join(", ")}`
							: "Every configured workflow passed",
					tone: !cornersAvailable ? "warn" : missingCorners.length ? "warn" : "good",
				},
				{
					label: "Problems",
					value:
						signals.hasFailure || signals.storageWarning
							? signals.hasFailure
								? "FOUND"
								: "WARNING"
							: signals.evidenceComplete
								? "0"
								: "—",
					detail:
						signals.categories.length > 0
							? `${signals.categories.slice(0, 2).join(" · ")}${signals.categories.length > 2 ? ` · +${signals.categories.length - 2} more` : ""}`
							: signals.evidenceComplete
								? "No failures, timeouts, or storage warnings"
								: `Unavailable: ${signals.evidenceGaps.join(", ")}`,
					tone: signals.hasFailure ? "bad" : signals.storageWarning || !signals.evidenceComplete ? "warn" : "good",
				},
			],
			gaps: [
				...(!lifecycleAvailable ? [{ label: "Lifecycle coverage data unavailable", tone: "warn" }] : []),
				...(!validatorsAvailable ? [{ label: "Independent state-check data unavailable", tone: "warn" }] : []),
				...(!cornersAvailable ? [{ label: "High-risk workflow data unavailable", tone: "warn" }] : []),
				...missingStates.map(item => ({ label: `State not observed · ${item.label}`, tone: "warn" })),
				...missingActions.map(action => ({ label: `Action type not checked · ${humanize(action)}`, tone: "warn" })),
				...missingCorners.map(operation => ({ label: `Workflow not verified · ${operation.label}`, tone: "warn" })),
				...signals.failureCategories.map(label => ({ label, tone: "bad" })),
				...(signals.storageWarning ? [{ label: `Storage · ${signals.storageWarning}`, tone: "warn" }] : []),
				...(!signals.evidenceComplete
					? [{ label: `Run-signal telemetry unavailable · ${signals.evidenceGaps.join(", ")}`, tone: "warn" }]
					: []),
				...(complete && signals.count === 0 && signals.evidenceComplete
					? [{ label: "All configured run targets reached", tone: "good" }]
					: []),
			],
		};
	}

	function renderCoverageVerdict(report) {
		const coverage = coverageSnapshot(report);
		const container = dom["coverage-status"].closest(".coverage-verdict");
		if (container) container.dataset.tone = coverage.tone;
		setText(dom["coverage-verdict-title"], coverage.title);
		setText(dom["coverage-status"], coverage.label);
		dom["coverage-status"].dataset.tone = coverage.tone;
		setText(dom["coverage-summary"], coverage.summary);
		dom["coverage-grid"].replaceChildren(
			...coverage.cards.map(card => {
				const node = create("article", "coverage-card");
				node.dataset.tone = card.tone;
				const header = create("div", "coverage-card__header");
				header.append(create("p", "coverage-card__label", card.label), create("p", "coverage-card__value", card.value));
				node.append(header, create("p", "coverage-card__detail", card.detail));
				return node;
			}),
		);
		dom["coverage-gaps"].replaceChildren(
			...coverage.gaps.map(gap => {
				const node = create("span", "coverage-gap", gap.label);
				node.dataset.tone = gap.tone;
				node.setAttribute("role", "listitem");
				return node;
			}),
		);
	}

	function timelineCandidates(report, names) {
		const timeline = pick(report || {}, "timeline");
		if (Array.isArray(timeline)) return timeline;
		if (!isObject(timeline)) return [];
		for (const name of names) {
			if (Array.isArray(timeline[name])) return timeline[name];
		}
		return [];
	}

	function pointLabel(point, index) {
		const explicit = pick(point, "label", "bucketLabel", "name");
		if (explicit !== undefined) return text(explicit, `#${index + 1}`);
		const root = optionalNumber(pick(point, "root", "rootIndex", "index", "roots"));
		if (root !== undefined) return `cycle ${compactNumber(root)}`;
		const at = pick(point, "at", "timestamp", "emittedAt", "time");
		const time = clockTime(at);
		if (time) return time;
		const elapsed = optionalNumber(pick(point, "elapsedMs", "elapsed"));
		if (elapsed !== undefined) return duration(elapsed);
		return `#${index + 1}`;
	}

	function windowedTimeline(points) {
		if (state.chartWindow === "all") return points;
		return points.slice(-Math.max(1, numeric(state.chartWindow, 64)));
	}

	function timelineWindowCaption(label, visible, total) {
		if (visible >= total) return `${label} across all ${compactNumber(total)} retained checkpoints`;
		return `${label}; latest ${compactNumber(visible)} of ${compactNumber(total)} retained checkpoints`;
	}

	function quoteTimeline(report = state.report) {
		const points = timelineCandidates(report, ["quoteStock", "quotes", "inventory", "snapshots", "buckets", "points"]);
		const normalized = points
			.map((raw, index) => {
				const point = object(raw);
				const quotes = firstObject(point, "quotes", "quoteInventory", "inventory", "stock");
				const source = hasQuoteTelemetry(quotes) ? quotes : hasQuoteTelemetry(point) ? point : undefined;
				if (!source) return undefined;
				const totals = quoteTotals(source);
				const live = optionalNumber(point.live, point.active) ?? totals.active;
				const ended = optionalNumber(point.ended, point.terminal) ?? totals.terminal;
				if (live === undefined || ended === undefined) return undefined;
				return {
					label: pointLabel(point, index),
					live,
					ended,
				};
			})
			.filter(Boolean);
		if (normalized.length > 0) return normalized;
		const quotes = currentQuotes(report);
		if (!hasQuoteTelemetry(quotes)) return [];
		const totals = quoteTotals(quotes);
		if (totals.active === undefined || totals.terminal === undefined) return [];
		return [{ label: `cycle ${compactNumber(rootCount(report))}`, live: totals.active, ended: totals.terminal }];
	}

	function paceTimeline(report = state.report) {
		const points = timelineCandidates(report, ["pace", "throughput", "roots", "snapshots", "buckets", "points"]);
		const normalized = points.map((raw, index) => {
			const point = object(raw);
			const pace = firstObject(point, "pace", "performance");
			return {
				label: pointLabel(point, index),
				rate: optionalNumber(
					pick(point, "rootsPerSecond", "rootsPerSec", "rootRate", "throughput"),
					pick(pace, "rootsPerSecond", "rootsPerSec", "rootRate"),
				),
				p50: optionalNumber(pick(point, "rootP50Ms", "p50Ms", "p50"), pick(pace, "rootP50Ms", "p50Ms", "p50")),
				p95: optionalNumber(pick(point, "rootP95Ms", "p95Ms", "p95"), pick(pace, "rootP95Ms", "p95Ms", "p95")),
				durationMs: optionalNumber(point.durationMs),
				elapsedMs: optionalNumber(point.elapsedMs),
				completed: optionalNumber(pick(point, "roots.completed", "root")),
				exact: hasTelemetry(pace, ["rootP50Ms", "rootP95Ms", "window"]),
			};
		});
		for (let index = 0; index < normalized.length; index++) {
			const point = normalized[index];
			const previous = normalized[Math.max(0, index - 16)];
			if (point.rate === undefined && point.completed !== undefined && point.elapsedMs !== undefined) {
				if (previous?.completed !== undefined && previous.elapsedMs !== undefined && point.elapsedMs > previous.elapsedMs) {
					point.rate = ((point.completed - previous.completed) * 1_000) / (point.elapsedMs - previous.elapsedMs);
				} else if (point.elapsedMs > 0) {
					point.rate = (point.completed * 1_000) / point.elapsedMs;
				}
			}
			const rollingDurations = normalized
				.slice(Math.max(0, index - 63), index + 1)
				.map(candidate => candidate.durationMs)
				.filter(value => value !== undefined);
			point.p50 ??= percentile(rollingDurations, 0.5);
			point.p95 ??= percentile(rollingDurations, 0.95);
		}
		if (normalized.some(point => point.rate !== undefined || point.p50 !== undefined || point.p95 !== undefined)) return normalized;
		const pace = paceSnapshot(report);
		const exactPace = firstObject(report || {}, "latest.pace", "latest.performance", "result.pace");
		return [
			{
				label: `cycle ${compactNumber(rootCount(report))}`,
				rate: pace.rootsPerSecond,
				p50: pace.p50,
				p95: pace.p95,
				exact: hasTelemetry(exactPace, ["rootP50Ms", "rootP95Ms", "window"]),
			},
		];
	}

	function paceTelemetryMode(points) {
		if (points.length === 0) return "unavailable";
		const exactPoints = points.filter(point => point.exact).length;
		if (exactPoints === points.length) return "exact";
		if (exactPoints === 0) return "legacy";
		return "mixed";
	}

	function paceTelemetryCopy(mode) {
		if (mode === "exact") return "Whole-cycle duration uses the exact rolling window reported at each checkpoint.";
		if (mode === "legacy") return "Legacy report: whole-cycle duration is approximated from retained checkpoints.";
		if (mode === "mixed") return "Mixed report: exact rolling-cycle duration and retained-checkpoint approximations.";
		return "Simulation-speed telemetry was not reported.";
	}

	function queueTimeline(report = state.report) {
		const points = timelineCandidates(report, ["queue", "engine", "snapshots", "buckets", "points"]);
		const normalized = points
			.map((raw, index) => {
				const point = object(raw);
				const queue = firstObject(point, "queue", "engine.queue");
				const queuePeak = firstObject(point, "queuePeak", "queue.peak", "engine.queuePeak");
				const hasPeak = hasQueueTelemetry(queuePeak);
				const source = hasPeak ? queuePeak : hasQueueTelemetry(queue) ? queue : hasQueueTelemetry(point) ? point : undefined;
				if (!source) return undefined;
				const totals = queueTotals(source);
				return {
					label: pointLabel(point, index),
					outstanding: totals.outstanding,
					pending: totals.pending,
					scheduled: totals.scheduled,
					running: totals.running,
					peak: hasPeak,
				};
			})
			.filter(Boolean);
		if (normalized.length > 0) return normalized;
		const queue = currentQueue(report);
		if (!hasQueueTelemetry(queue)) return [];
		const totals = queueTotals(queue);
		return [
			{
				label: `cycle ${compactNumber(rootCount(report))}`,
				outstanding: totals.outstanding,
				pending: totals.pending,
				scheduled: totals.scheduled,
				running: totals.running,
				peak: false,
			},
		];
	}

	function queueTelemetryMode(points) {
		if (points.length === 0) return "unavailable";
		const peakPoints = points.filter(point => point.peak).length;
		if (peakPoints === points.length) return "maxima";
		if (peakPoints === 0) return "snapshots";
		return "mixed";
	}

	function queueTelemetryCopy(mode) {
		if (mode === "maxima") return "Per-metric interval maxima between retained checkpoints.";
		if (mode === "snapshots") return "Legacy report: settled queue snapshots only; interval maxima are unavailable.";
		if (mode === "mixed") return "Mixed report: some checkpoints contain interval maxima and others contain settled snapshots.";
		return "Queue telemetry was not reported.";
	}

	function table(tableNode, captionText, headers, rows) {
		const caption = create("caption", "", captionText);
		const head = document.createElement("thead");
		const headerRow = document.createElement("tr");
		for (const header of headers) {
			const cell = create("th", "", header);
			cell.scope = "col";
			headerRow.append(cell);
		}
		head.append(headerRow);
		const body = document.createElement("tbody");
		if (rows.length === 0) {
			const row = document.createElement("tr");
			const cell = create("td", "table-zero", "No data reported");
			cell.colSpan = headers.length;
			row.append(cell);
			body.append(row);
		} else {
			for (const values of rows) {
				const row = document.createElement("tr");
				for (const value of values) row.append(create("td", "", value));
				body.append(row);
			}
		}
		tableNode.replaceChildren(caption, head, body);
	}

	function cssColor(name) {
		return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	}

	function canvasContext(canvas) {
		const width = Math.max(280, Math.floor(canvas.clientWidth || canvas.parentElement?.clientWidth || 600));
		const height = Math.max(220, Math.floor(canvas.clientHeight || 280));
		const ratio = clamp(window.devicePixelRatio || 1, 1, 2);
		const nextWidth = Math.floor(width * ratio);
		const nextHeight = Math.floor(height * ratio);
		if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
			canvas.width = nextWidth;
			canvas.height = nextHeight;
		}
		const context = canvas.getContext("2d");
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, width, height);
		return { context, width, height };
	}

	function chartRect(width, height, overrides = {}) {
		return {
			left: overrides.left ?? 46,
			right: overrides.right ?? width - 13,
			top: overrides.top ?? 15,
			bottom: overrides.bottom ?? height - 29,
		};
	}

	function seriesMaximum(points, fields) {
		const values = points.flatMap(point => fields.map(field => numeric(point[field])));
		return Math.max(1, ...values);
	}

	function drawGrid(context, rect, maximum, formatter = compactNumber) {
		context.save();
		context.font = `10px ${cssColor("--mono-font") || "monospace"}`;
		context.fillStyle = cssColor("--muted");
		context.strokeStyle = cssColor("--line-soft");
		context.lineWidth = 1;
		context.textAlign = "right";
		context.textBaseline = "middle";
		for (let index = 0; index <= 4; index++) {
			const ratio = index / 4;
			const y = rect.bottom - (rect.bottom - rect.top) * ratio;
			context.beginPath();
			context.moveTo(rect.left, Math.round(y) + 0.5);
			context.lineTo(rect.right, Math.round(y) + 0.5);
			context.stroke();
			context.fillText(formatter(maximum * ratio), rect.left - 8, y);
		}
		context.restore();
	}

	function xPositions(points, rect) {
		if (points.length <= 1) return [rect.left + (rect.right - rect.left) / 2];
		return points.map((_, index) => rect.left + ((rect.right - rect.left) * index) / (points.length - 1));
	}

	function drawXAxis(context, rect, points, positions) {
		if (points.length === 0) return;
		const indexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
		context.save();
		context.fillStyle = cssColor("--muted");
		context.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
		context.textBaseline = "top";
		for (const index of indexes) {
			context.textAlign = index === 0 ? "left" : index === points.length - 1 ? "right" : "center";
			context.fillText(text(points[index].label, ""), positions[index], rect.bottom + 9);
		}
		context.restore();
	}

	function drawLine(context, points, positions, rect, field, maximum, color, fillColor) {
		const values = points.map(point => numeric(point[field]));
		const yFor = value => rect.bottom - (rect.bottom - rect.top) * (numeric(value) / maximum);
		context.save();
		if (fillColor) {
			const gradient = context.createLinearGradient(0, rect.top, 0, rect.bottom);
			gradient.addColorStop(0, fillColor);
			gradient.addColorStop(1, "rgba(0,0,0,0)");
			context.beginPath();
			context.moveTo(positions[0], rect.bottom);
			for (let index = 0; index < points.length; index++) context.lineTo(positions[index], yFor(values[index]));
			context.lineTo(positions[positions.length - 1], rect.bottom);
			context.closePath();
			context.fillStyle = gradient;
			context.fill();
		}
		context.beginPath();
		context.lineJoin = "round";
		context.lineCap = "round";
		context.lineWidth = 1.75;
		context.strokeStyle = color;
		for (let index = 0; index < points.length; index++) {
			const x = positions[index];
			const y = yFor(values[index]);
			if (index === 0) context.moveTo(x, y);
			else context.lineTo(x, y);
		}
		if (points.length === 1) {
			context.moveTo(rect.left, yFor(values[0]));
			context.lineTo(rect.right, yFor(values[0]));
		}
		context.stroke();
		context.restore();
	}

	function drawNoData(context, width, height, message) {
		context.save();
		context.fillStyle = cssColor("--muted");
		context.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
		context.textAlign = "center";
		context.textBaseline = "middle";
		context.fillText(message, width / 2, height / 2);
		context.restore();
	}

	function installTooltip(canvas, tooltip) {
		if (canvas.dataset.tooltipReady === "true") return;
		canvas.dataset.tooltipReady = "true";
		canvas.addEventListener("mousemove", event => {
			const model = chartModels.get(canvas);
			if (!model || model.points.length === 0) return;
			const bounds = canvas.getBoundingClientRect();
			const x = event.clientX - bounds.left;
			let nearest = 0;
			let distance = Number.POSITIVE_INFINITY;
			model.positions.forEach((position, index) => {
				const nextDistance = Math.abs(position - x);
				if (nextDistance < distance) {
					distance = nextDistance;
					nearest = index;
				}
			});
			tooltip.textContent = model.tooltip(model.points[nearest]);
			tooltip.hidden = false;
			const tooltipWidth = tooltip.offsetWidth || 200;
			const left = clamp(model.positions[nearest] + 12, 8, Math.max(8, bounds.width - tooltipWidth - 8));
			tooltip.style.left = `${left}px`;
			tooltip.style.top = `${Math.max(8, event.clientY - bounds.top - 20)}px`;
		});
		canvas.addEventListener("mouseleave", () => {
			tooltip.hidden = true;
		});
	}

	function drawQuoteChart(points) {
		const { context, width, height } = canvasContext(dom["quote-chart"]);
		if (!points.some(point => point.live !== undefined || point.ended !== undefined)) {
			drawNoData(context, width, height, "Quote stock has not been reported");
			chartModels.delete(dom["quote-chart"]);
			dom["quote-chart"].setAttribute("aria-label", "Quote stock telemetry has not been reported.");
			return;
		}
		const rect = chartRect(width, height);
		const maximum = seriesMaximum(points, ["live", "ended"]);
		const positions = xPositions(points, rect);
		drawGrid(context, rect, maximum);
		drawLine(context, points, positions, rect, "ended", maximum, cssColor("--violet"), "rgba(189,154,241,0.11)");
		drawLine(context, points, positions, rect, "live", maximum, cssColor("--cyan"), "rgba(103,216,210,0.12)");
		drawXAxis(context, rect, points, positions);
		chartModels.set(dom["quote-chart"], {
			points,
			positions,
			tooltip: point => `${point.label}\nLive ${compactNumber(point.live)}\nEnded ${compactNumber(point.ended)}`,
		});
		dom["quote-chart"].setAttribute(
			"aria-label",
			`Quote stock over ${points.length} timeline buckets. Latest: ${compactNumber(points.at(-1).live)} live and ${compactNumber(points.at(-1).ended)} ended.`,
		);
	}

	function drawQueueChart(points) {
		const { context, width, height } = canvasContext(dom["queue-chart"]);
		const mode = queueTelemetryMode(points);
		if (!points.length) {
			drawNoData(context, width, height, "Queue telemetry has not been reported");
			chartModels.delete(dom["queue-chart"]);
			dom["queue-chart"].setAttribute("aria-label", "Queue telemetry has not been reported.");
			return;
		}
		const observedMaximum = Math.max(...points.flatMap(point => [point.outstanding, point.pending, point.scheduled, point.running].map(numeric)));
		if (observedMaximum === 0) {
			const emptyMessage =
				mode === "maxima"
					? "No queue pressure observed in retained intervals"
					: mode === "snapshots"
						? "Legacy snapshots settled · maxima unavailable"
						: "No pressure in retained queue telemetry";
			drawNoData(context, width, height, emptyMessage);
			chartModels.delete(dom["queue-chart"]);
			dom["queue-chart"].setAttribute(
				"aria-label",
				mode === "maxima"
					? `No queue pressure was observed in the per-metric maxima for ${points.length} retained intervals.`
					: mode === "snapshots"
						? `${points.length} legacy settled queue snapshots contain no pressure; interval maxima are unavailable.`
						: `No queue pressure appears in ${points.length} mixed retained checkpoints.`,
			);
			return;
		}
		const rect = chartRect(width, height);
		const maximum = seriesMaximum(points, ["outstanding", "pending", "scheduled"]);
		const positions = xPositions(points, rect);
		drawGrid(context, rect, maximum);
		drawLine(context, points, positions, rect, "outstanding", maximum, cssColor("--amber"), "rgba(239,196,112,0.08)");
		drawLine(context, points, positions, rect, "pending", maximum, cssColor("--blue"));
		drawLine(context, points, positions, rect, "scheduled", maximum, cssColor("--cyan"));
		drawXAxis(context, rect, points, positions);
		chartModels.set(dom["queue-chart"], {
			points,
			positions,
			tooltip: point =>
				`${point.label}${point.peak ? " · per-metric interval maxima" : " · settled snapshot"}\nOutstanding ${compactNumber(
					point.outstanding,
				)}\nWaiting ${compactNumber(point.pending)}\nScheduled ${compactNumber(point.scheduled)}\nRunning ${compactNumber(point.running)}`,
		});
		const peakOutstanding = Math.max(...points.map(point => numeric(point.outstanding)));
		dom["queue-chart"].setAttribute(
			"aria-label",
			mode === "maxima"
				? `Queue per-metric interval maxima over ${points.length} retained checkpoints. Maximum outstanding: ${compactNumber(peakOutstanding)} actions.`
				: mode === "snapshots"
					? `Queue pressure across ${points.length} legacy settled snapshots. Maximum retained outstanding: ${compactNumber(
							peakOutstanding,
						)} actions; interval maxima are unavailable.`
					: `Queue pressure across ${points.length} mixed retained checkpoints. Maximum retained outstanding: ${compactNumber(
							peakOutstanding,
						)} actions.`,
		);
	}

	function drawBandLabel(context, label, x, y, color) {
		context.save();
		context.fillStyle = color;
		context.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
		context.textAlign = "left";
		context.textBaseline = "top";
		context.fillText(label, x, y);
		context.restore();
	}

	function drawPaceChart(points) {
		const { context, width, height } = canvasContext(dom["pace-chart"]);
		if (!points.some(point => point.rate !== undefined || point.p50 !== undefined || point.p95 !== undefined)) {
			drawNoData(context, width, height, "Pace telemetry has not been reported");
			chartModels.delete(dom["pace-chart"]);
			dom["pace-chart"].setAttribute("aria-label", "Pace telemetry has not been reported.");
			return;
		}
		const upper = chartRect(width, height, { top: 20, bottom: Math.floor(height * 0.43) });
		const lower = chartRect(width, height, { top: Math.floor(height * 0.59), bottom: height - 29 });
		const positions = xPositions(points, upper);
		const rateMaximum = seriesMaximum(points, ["rate"]);
		const latencyMaximum = seriesMaximum(points, ["p50", "p95"]);
		drawGrid(context, upper, rateMaximum, value => value.toFixed(value >= 10 ? 0 : 1));
		drawGrid(context, lower, latencyMaximum, value => duration(value));
		drawLine(context, points, positions, upper, "rate", rateMaximum, cssColor("--cyan"), "rgba(103,216,210,0.1)");
		drawLine(context, points, positions, lower, "p95", latencyMaximum, cssColor("--amber"), "rgba(239,196,112,0.07)");
		drawLine(context, points, positions, lower, "p50", latencyMaximum, cssColor("--blue"));
		drawBandLabel(context, "CYCLES / SECOND", upper.left, 5, cssColor("--cyan"));
		drawBandLabel(context, "WHOLE-CYCLE DURATION · P50 / P95", lower.left, lower.top - 15, cssColor("--muted"));
		drawXAxis(context, lower, points, positions);
		chartModels.set(dom["pace-chart"], {
			points,
			positions,
			tooltip: point => `${point.label}\nThroughput ${rate(point.rate)}\nP50 ${duration(point.p50)}\nP95 ${duration(point.p95)}`,
		});
		const latest = points.at(-1);
		dom["pace-chart"].setAttribute(
			"aria-label",
			`Simulation throughput and whole-cycle duration over ${points.length} timeline buckets. Latest: ${rate(
				latest.rate,
			)}, p50 ${duration(latest.p50)}, p95 ${duration(latest.p95)}.`,
		);
	}

	function renderCharts(report) {
		const allQuotePoints = quoteTimeline(report);
		const allPacePoints = paceTimeline(report);
		const allQueuePoints = queueTimeline(report);
		const quotePoints = windowedTimeline(allQuotePoints);
		const pacePoints = windowedTimeline(allPacePoints);
		const queuePoints = windowedTimeline(allQueuePoints);
		const paceMode = paceTelemetryMode(pacePoints);
		const queueMode = queueTelemetryMode(queuePoints);
		setText(dom["pace-telemetry-note"], paceTelemetryCopy(paceMode));
		dom["pace-telemetry-note"].dataset.tone = paceMode === "exact" ? "good" : paceMode === "unavailable" ? "neutral" : "warn";
		setText(dom["queue-telemetry-note"], queueTelemetryCopy(queueMode));
		dom["queue-telemetry-note"].dataset.tone = queueMode === "maxima" ? "good" : queueMode === "unavailable" ? "neutral" : "warn";
		drawQuoteChart(quotePoints);
		drawPaceChart(pacePoints);
		drawQueueChart(queuePoints);
		table(
			dom["quote-chart-table"],
			timelineWindowCaption("Quote stock", quotePoints.length, allQuotePoints.length),
			["Bucket", "Live", "Ended"],
			quotePoints.map(point => [point.label, compactNumber(point.live), compactNumber(point.ended)]),
		);
		table(
			dom["pace-chart-table"],
			timelineWindowCaption(
				paceMode === "exact"
					? "Throughput and exact rolling-cycle duration"
					: paceMode === "legacy"
						? "Throughput and retained-checkpoint whole-cycle duration approximation"
						: paceMode === "mixed"
							? "Throughput and mixed-source whole-cycle duration"
							: "Throughput and whole-cycle duration",
				pacePoints.length,
				allPacePoints.length,
			),
			["Bucket", "Cycles/s", "P50", "P95"],
			pacePoints.map(point => [point.label, rate(point.rate), duration(point.p50), duration(point.p95)]),
		);
		table(
			dom["queue-chart-table"],
			timelineWindowCaption(
				queueMode === "maxima"
					? "Queue per-metric interval maxima"
					: queueMode === "snapshots"
						? "Legacy settled queue snapshots; interval maxima unavailable"
						: queueMode === "mixed"
							? "Mixed queue maxima and snapshots"
							: "Queue telemetry",
				queuePoints.length,
				allQueuePoints.length,
			),
			["Checkpoint", "Outstanding", "Waiting", "Scheduled", "Running"],
			queuePoints.map(point => [
				`${point.label} · ${point.peak ? "per-metric maxima" : "settled snapshot"}`,
				compactNumber(point.outstanding),
				compactNumber(point.pending),
				compactNumber(point.scheduled),
				compactNumber(point.running),
			]),
		);
	}

	function participantSnapshot(report = state.report) {
		const setup = reportSetup(report);
		const config = reportConfig(report);
		const users = firstArray(setup, "users");
		const hedgers = firstArray(setup, "hedgers");
		const userCount = users.length || numeric(pick(config, "userCount", "users"));
		const hedgerCount = hedgers.length || numeric(pick(config, "hedgerCount", "hedgers"));
		return { users, hedgers, userCount, hedgerCount };
	}

	function cornerTotals(corners = currentCorners()) {
		const explicit = firstObject(corners, "totals", "total");
		const entries = CORNER_OPERATIONS.map(operation => cornerCounts(corners, operation.key));
		const aggregate = field => entries.reduce((sum, counts) => sum + numeric(counts[field]), 0);
		return {
			attempted: optionalNumber(explicit.attempted) ?? aggregate("attempted"),
			succeeded: optionalNumber(pick(explicit, "succeeded", "passed")) ?? aggregate("succeeded"),
			skipped: optionalNumber(explicit.skipped) ?? aggregate("skipped"),
			failed: optionalNumber(explicit.failed) ?? aggregate("failed"),
		};
	}

	function plural(count, singular, pluralForm = `${singular}s`) {
		return `${compactNumber(count)} ${numeric(count) === 1 ? singular : pluralForm}`;
	}

	function humanRunMode(mode) {
		const normalized = text(mode, "").toLowerCase();
		if (normalized === "continuous") return "Continuous simulation";
		if (normalized === "bounded") return "Bounded replay";
		return mode ? humanize(mode) : "Mode unavailable";
	}

	function runHeadline(report, connectionState = state.connectionState) {
		const outcome = runOutcomeSnapshot(report);
		const snapshot = connectionState === "stale" || connectionState === "frozen" || connectionState === "error";
		if (snapshot && isLiveRun(report)) {
			return connectionState === "error" ? "Last report unavailable" : "Last reported snapshot";
		}
		if (outcome.signals.hasFailure) return "Needs attention";
		if (outcome.stoppedCleanly) return "Stopped cleanly";
		if (/(drain)/.test(outcome.status)) return "Finishing…";
		if (/(run|active|live)/.test(outcome.status)) return "Simulation running";
		if (/(pass|complete|success|finished)/.test(outcome.status) && outcome.clean) return "Completed cleanly";
		return `Simulation ${humanize(outcome.status).toLowerCase()}`;
	}

	function runSummary(report) {
		const participants = participantSnapshot(report);
		const quotesSource = currentQuotes(report);
		const quotes = hasQuoteTelemetry(quotesSource) ? quoteTotals(quotesSource) : undefined;
		const cycles = rootCount(report);
		const elapsed = elapsedMs(report);
		return [
			participants.userCount || participants.hedgerCount
				? `${plural(participants.userCount, "randomized user")} · ${plural(participants.hedgerCount, "hedger")}`
				: "Actors unavailable",
			plural(cycles, "cycle"),
			quotes?.total !== undefined ? plural(quotes.total, "quote") : "Quotes unavailable",
			duration(elapsed),
		].join(" · ");
	}

	function renderRunHeader(report) {
		const run = reportRun(report);
		const config = reportConfig(report);
		const result = reportResult(report);
		const latest = reportLatest(report);
		const participants = participantSnapshot(report);
		const seed = pick(config, "seed") ?? pick(run, "seed") ?? pick(report, "seed");
		const mode = pick(config, "runMode", "mode") ?? pick(run, "mode");
		const trace = pick(result, "traceHash", "trace") ?? pick(latest, "traceHash", "trace") ?? pick(run, "traceHash");
		renderRunStatus(report);
		setText(dom["run-mode"], humanRunMode(mode));
		setText(dom["run-title"], runHeadline(report, state.connectionState));
		setText(dom["run-subtitle"], runSummary(report, state.connectionState));
		setText(
			dom["actors-value"],
			participants.userCount || participants.hedgerCount
				? `${plural(participants.userCount, "user")} · ${plural(participants.hedgerCount, "hedger")}`
				: "—",
		);
		setText(dom["environment-value"], "Local Hardhat");
		setText(dom["seed-value"], seed);
		dom["seed-value"].title = text(seed);
		setText(dom["elapsed-value"], duration(elapsedMs(report)));
		setText(dom["freshness-value"], ago(state.lastReportAt || state.lastSuccessAt));
		setText(dom["trace-value"], trace ? text(trace).slice(0, 16) : "—");
		dom["trace-value"].title = text(trace);
		setText(dom["technical-mode-value"], humanRunMode(mode));
		setText(dom["technical-cycle-value"], compactNumber(rootCount(report)));
	}

	function renderKpis(report) {
		const quoteSource = currentQuotes(report);
		const quotesAvailable = hasQuoteTelemetry(quoteSource);
		const assurance = currentAssurance(report);
		const observedValue = pick(assurance, "observedQuoteStatuses", "lifecycle.observedStatuses");
		const observedStates = new Set(array(observedValue).map(value => text(value, "")));
		const milestones = firstObject(report || {}, "milestones.quoteStates");
		for (const item of QUOTE_STATES) if (isObject(milestones[item.key])) observedStates.add(item.key);
		const lifecycleAvailable = Array.isArray(observedValue) || Object.keys(milestones).length > 0;
		const reachedStates = QUOTE_STATES.filter(item => observedStates.has(item.key)).length;
		const confirmedValue = pick(assurance, "confirmedActionTypes");
		const confirmedActions = new Set(array(confirmedValue).map(value => text(value, "")));
		const checkedActionCount = ACTION_ORDER.filter(action => confirmedActions.has(action)).length;
		const validatorsAvailable = Array.isArray(confirmedValue);
		const corners = currentCorners(report);
		const cornersAvailable = Object.keys(operationMap(corners)).length > 0;
		const cornersTotal = cornerTotals(corners);
		const cornerTypes = verifiedCornerCount(corners);
		const signals = runSignalSnapshot(report);
		const kpis = [
			{
				label: "Failures or timeouts",
				value: signals.hasFailure ? "FOUND" : signals.evidenceComplete ? "0" : "—",
				detail: signals.hasFailure
					? signals.failureCategories.slice(0, 2).join(" · ")
					: signals.evidenceComplete
						? "No test failures detected"
						: `Unavailable: ${signals.evidenceGaps.join(", ")}`,
				tone: signals.hasFailure ? "bad" : signals.evidenceComplete ? "good" : "warn",
			},
			{
				label: "Quote states reached",
				value: lifecycleAvailable ? `${reachedStates}/${QUOTE_STATES.length}` : "—",
				detail: lifecycleAvailable
					? reachedStates === QUOTE_STATES.length
						? "All configured quote states"
						: `${QUOTE_STATES.length - reachedStates} configured states not reached`
					: "Quote-state evidence unavailable",
				tone: lifecycleAvailable && reachedStates === QUOTE_STATES.length ? "good" : "warn",
			},
			{
				label: "Action types checked",
				value: validatorsAvailable ? `${checkedActionCount}/${ACTION_ORDER.length}` : "—",
				detail: validatorsAvailable ? "Each supported type checked at least once" : "State-check evidence unavailable",
				tone: validatorsAvailable && checkedActionCount === ACTION_ORDER.length ? "good" : "warn",
			},
			{
				label: "High-risk checks",
				value: cornersAvailable ? `${compactNumber(cornersTotal.succeeded)}/${compactNumber(cornersTotal.attempted)}` : "—",
				detail: cornersAvailable ? `${cornerTypes}/${CORNER_OPERATIONS.length} workflow types passed` : "Workflow evidence unavailable",
				tone: cornersAvailable && cornersTotal.failed === 0 && cornerTypes === CORNER_OPERATIONS.length ? "good" : "warn",
			},
		];
		dom["kpi-strip"].replaceChildren(
			...kpis.map(kpi => {
				const node = create("article", "kpi");
				if (kpi.tone) node.dataset.tone = kpi.tone;
				node.append(create("p", "kpi__label", kpi.label), create("p", "kpi__value", kpi.value), create("p", "kpi__detail", kpi.detail));
				return node;
			}),
		);
		setText(
			dom["health-note"],
			quotesAvailable && quoteTotals(quoteSource).total !== undefined
				? `${compactNumber(quoteTotals(quoteSource).total)} tracked quotes · configured targets, not exhaustive coverage`
				: "Configured run targets, not exhaustive protocol coverage",
		);
		const blockedProbability = optionalNumber(pick(reportConfig(report), "blockedQuoteProbability"));
		setText(
			dom["summary-limit-note"],
			`Configured targets only${
				blockedProbability === 0
					? " · blocked generation off"
					: blockedProbability !== undefined
						? ` · blocked generation ${percent(blockedProbability)}`
						: ""
			}`,
		);
	}

	function renderOutcomes(report) {
		const quotes = currentQuotes(report);
		if (!hasQuoteTelemetry(quotes)) {
			dom["outcome-bar"].replaceChildren();
			dom["outcome-bar"].setAttribute("aria-label", "Quote outcome distribution unavailable");
			setText(dom["quotes-title"], "Quote outcomes");
			dom["outcome-strip"].replaceChildren(create("p", "empty-copy", "Quote outcomes are unavailable in this report."));
			setText(dom["outcome-note"], "The report does not contain a current quote-state snapshot.");
			return;
		}
		const totals = quoteTotals(quotes);
		setText(dom["quotes-title"], totals.total === undefined ? "Quote outcomes" : `Where ${compactNumber(totals.total)} quotes ended up`);
		if (!hasQuoteStatusBreakdown(quotes)) {
			dom["outcome-bar"].replaceChildren();
			dom["outcome-bar"].setAttribute("aria-label", "Quote outcome distribution unavailable");
			dom["outcome-strip"].replaceChildren(
				create(
					"p",
					"empty-copy",
					totals.total === undefined
						? "A per-state quote outcome breakdown is unavailable."
						: `${compactNumber(totals.total)} quotes were reported, but the per-state outcome breakdown is unavailable.`,
				),
			);
			setText(dom["outcome-note"], "Unknown outcome fields are not treated as zero.");
			return;
		}
		const rawCounts = quoteStatusMap(quotes);
		const valueFor = key => optionalNumber(rawCounts[key]);
		const liveKeys = ["PENDING", "LOCKED", "CANCEL_PENDING", "OPENED", "CLOSE_PENDING", "CANCEL_CLOSE_PENDING"];
		const activeValue =
			optionalNumber(quotes.active, quotes.live) ??
			(liveKeys.every(key => optionalNumber(rawCounts[key]) !== undefined)
				? liveKeys.reduce((sum, key) => sum + numeric(rawCounts[key]), 0)
				: undefined);
		const outcomes = [
			{ label: "Closed", value: valueFor("CLOSED"), tone: "good" },
			{ label: "Canceled", value: valueFor("CANCELED"), tone: "neutral" },
			{ label: "Still active", value: activeValue, tone: "info" },
			{
				label: "Liquidated",
				value: valueFor("LIQUIDATED"),
				tone: numeric(valueFor("LIQUIDATED")) > 0 ? "warn" : "neutral",
			},
			{ label: "Expired", value: valueFor("EXPIRED"), tone: numeric(valueFor("EXPIRED")) > 0 ? "warn" : "neutral" },
			{
				label: "Liquidated before opening",
				value: valueFor("LIQUIDATED_PENDING"),
				tone: numeric(valueFor("LIQUIDATED_PENDING")) > 0 ? "warn" : "neutral",
			},
		];
		const distributionTotal = outcomes.reduce((sum, outcome) => sum + (outcome.value === undefined ? 0 : numeric(outcome.value)), 0);
		const barSegments =
			distributionTotal > 0
				? outcomes
						.filter(outcome => numeric(outcome.value) > 0)
						.map(outcome => {
							const segment = create("span", "outcome-bar__segment");
							segment.dataset.tone = outcome.tone;
							segment.style.flexBasis = `${(numeric(outcome.value) / distributionTotal) * 100}%`;
							segment.title = `${outcome.label}: ${compactNumber(outcome.value)}`;
							return segment;
						})
				: [];
		dom["outcome-bar"].replaceChildren(...barSegments);
		dom["outcome-bar"].setAttribute(
			"aria-label",
			outcomes
				.filter(outcome => outcome.value !== undefined)
				.map(outcome => `${outcome.label} ${compactNumber(outcome.value)}`)
				.join(", "),
		);
		dom["outcome-strip"].replaceChildren(
			...outcomes.map(outcome => {
				const node = create("article", "outcome-card");
				node.dataset.tone = outcome.tone;
				node.append(
					create("p", "outcome-card__value", outcome.value === undefined ? "—" : compactNumber(outcome.value)),
					create("p", "outcome-card__label", outcome.label),
				);
				return node;
			}),
		);
		if (activeValue === undefined) {
			setText(dom["outcome-note"], "The active-quote count is unavailable; unknown fields are not treated as zero.");
			return;
		}
		setText(
			dom["outcome-note"],
			isLiveRun(report)
				? `${compactNumber(activeValue)} active now`
				: text(pick(reportConfig(report), "runMode", "mode"), "").toLowerCase() === "continuous"
					? `${compactNumber(activeValue)} still active at stop · not failures`
					: `${compactNumber(activeValue)} still active in the final snapshot`,
		);
	}

	function renderConfidenceLimits(report) {
		const config = reportConfig(report);
		const assurance = currentAssurance(report);
		const target = optionalNumber(pick(config, "validationProbability"));
		const eligible = optionalNumber(pick(assurance, "observableSuccessfulTransitions", "eligibleValidatorSelections"));
		const checked = optionalNumber(pick(assurance, "confirmedValidatorTransitions", "selectedValidators"));
		const observedRate = eligible && checked !== undefined ? checked / eligible : undefined;
		setText(
			dom["confidence-limit-summary"],
			eligible !== undefined && checked !== undefined
				? `Independent validators checked ${compactNumber(checked)} of ${compactNumber(eligible)} eligible observable state changes (${percent(
						observedRate,
					)})${target !== undefined ? ` against a ${percent(target)} target` : ""}.`
				: "Validator sampling detail is unavailable in this report.",
		);
		const blockedProbability = optionalNumber(pick(config, "blockedQuoteProbability"));
		const retention = firstObject(report || {}, "retention");
		const droppedActivity = optionalNumber(pick(retention, "droppedActivity", "droppedEvents"));
		const limits = [
			blockedProbability === 0
				? "Blocked-quote generation was disabled (0%), so blocked-input behavior was not sampled by ordinary generation."
				: blockedProbability !== undefined
					? `Blocked-quote generation was configured at ${percent(blockedProbability)}.`
					: "Blocked-quote generation configuration is unavailable.",
			"All configured run targets may be reached without covering every contract path, parameter combination, or economic condition.",
			"Quote-state and action-type evidence is aggregated across many quotes; it does not describe one end-to-end user journey.",
			"Historical close-order-mode coverage is not recorded; closing-mode counts describe only live close requests.",
		];
		if (droppedActivity > 0) {
			limits.push(`${compactNumber(droppedActivity)} older raw activity events were not retained; summary counters remain authoritative.`);
		}
		dom["confidence-limit-list"].replaceChildren(...limits.map(limit => create("li", "", limit)));
	}

	function storyStages(report) {
		const participants = participantSnapshot(report);
		return [
			{
				copy: "Pick one quote user + one hedger",
			},
			{
				copy: "Try one generated quote",
			},
			{
				copy: "Wait for resulting work to settle",
			},
			{
				copy: "Run a due check with its own actors · revisit when available",
			},
			{
				participants,
			},
		];
	}

	function clearStoryMotion() {
		for (const animation of dom["story-token"]?.getAnimations?.() || []) animation.cancel();
		state.storyAnimation = null;
		for (const timer of state.storyTimers) window.clearTimeout(timer);
		state.storyTimers = [];
		if (dom["story-token"]) {
			dom["story-token"].style.opacity = "0";
			dom["story-token"].style.transform = "";
		}
		for (const step of dom["story-track"].querySelectorAll("[data-story-step]")) {
			step.classList.remove("is-active", "is-complete");
		}
	}

	function activateStoryStep(index, stages) {
		const steps = [...dom["story-track"].querySelectorAll("[data-story-step]")];
		steps.forEach((step, stepIndex) => {
			step.classList.toggle("is-active", stepIndex === index);
			step.classList.toggle("is-complete", stepIndex < index);
		});
		setText(dom["story-stage-copy"], stages[index]?.copy);
	}

	function playStory() {
		if (!state.report || !dom["story-track"]) return;
		const stages = storyStages(state.report);
		clearStoryMotion();
		const steps = [...dom["story-track"].querySelectorAll("[data-story-step]")];
		if (steps.length === 0) return;
		const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (reducedMotion || typeof dom["story-token"].animate !== "function") {
			steps.forEach(step => step.classList.add("is-complete"));
			dom["story-token"].style.opacity = "0";
			setText(dom["story-stage-copy"], "One cycle moves through all four stages before it is counted.");
			return;
		}
		const trackBounds = dom["story-track"].getBoundingClientRect();
		const tokenBounds = dom["story-token"].getBoundingClientRect();
		const coordinates = steps.map(step => {
			const bounds = step.getBoundingClientRect();
			return {
				x: bounds.left - trackBounds.left + bounds.width / 2 - tokenBounds.width / 2,
				y: bounds.top - trackBounds.top + 18 - tokenBounds.height / 2,
			};
		});
		activateStoryStep(0, stages);
		dom["story-token"].style.opacity = "1";
		state.storyAnimation = dom["story-token"].animate(
			coordinates.map((point, index) => ({
				transform: `translate(${point.x}px, ${point.y}px)`,
				offset: index / Math.max(1, coordinates.length - 1),
			})),
			{
				duration: 2_600,
				easing: "cubic-bezier(0.77, 0, 0.175, 1)",
				fill: "forwards",
			},
		);
		for (let index = 1; index < steps.length; index++) {
			state.storyTimers.push(window.setTimeout(() => activateStoryStep(index, stages), Math.round((2_600 * index) / (steps.length - 1))));
		}
		state.storyAnimation.addEventListener(
			"finish",
			() => {
				steps.forEach(step => {
					step.classList.remove("is-active");
					step.classList.add("is-complete");
				});
				setText(dom["story-stage-copy"], "Cycle settled. The next randomized cycle can now begin.");
				const finishedAnimation = state.storyAnimation;
				state.storyAnimation = null;
				if (finishedAnimation) finishedAnimation.cancel();
				dom["story-token"].style.opacity = "0";
				dom["story-token"].style.transform = "";
			},
			{ once: true },
		);
	}

	function renderStory(report) {
		const stages = storyStages(report);
		const details = stages.at(-1);
		const participants = details.participants;
		const actorNodes = [];
		for (let index = 0; index < participants.userCount; index++) {
			const node = create("span", "story-actor story-actor--user", `U${index + 1}`);
			node.title = `Simulated user ${index + 1}`;
			actorNodes.push(node);
		}
		for (let index = 0; index < participants.hedgerCount; index++) {
			const node = create("span", "story-actor story-actor--hedger", `H${index + 1}`);
			node.title = `Simulated hedger ${index + 1}`;
			actorNodes.push(node);
		}
		dom["story-actors"].replaceChildren(...actorNodes);
		setText(dom["story-actor-value"], "1 quote pair");
		setText(dom["story-cycle-value"], "1 quote");
		setText(dom["story-job-value"], "settle");
		setText(dom["story-risk-value"], "dedicated actors");
		setText(
			dom["story-run-note"],
			"Queue jobs are runner work, not transaction counts. Scheduled high-risk workflows may use dedicated actors and quotes. The report exposes completed cycles, not live internal phases.",
		);
		const seed = text(pick(reportConfig(report), "seed") ?? pick(reportRun(report), "seed"), "current");
		const storyKey = `${state.selectedRunId || seed}`;
		if (state.storyReportKey !== storyKey) {
			state.storyReportKey = storyKey;
			window.requestAnimationFrame(() => playStory());
		}
	}

	function renderLifecycle(report) {
		const quotes = currentQuotes(report);
		const breakdownAvailable = hasQuoteStatusBreakdown(quotes);
		const counts = quoteStatusMap(quotes);
		const assurance = currentAssurance(report);
		const observedValue = pick(assurance, "observedQuoteStatuses", "lifecycle.observedStatuses");
		const milestones = firstObject(report || {}, "milestones.quoteStates");
		const coverageAvailable = Array.isArray(observedValue) || Object.keys(milestones).length > 0;
		const observedStatuses = new Set(array(observedValue).map(value => text(value, "")));
		for (const item of QUOTE_STATES) if (isObject(milestones[item.key])) observedStatuses.add(item.key);
		const reached = QUOTE_STATES.filter(item => observedStatuses.has(item.key)).length;
		setText(dom["lifecycle-summary"], coverageAvailable ? `${compactNumber(reached)} / 11 observed` : "Coverage unavailable");
		const groups = [
			{ key: "waiting", label: "Waiting to open" },
			{ key: "positions", label: "Open positions" },
			{ key: "outcomes", label: "Ended outcomes" },
		];
		const groupNodes = groups.map(group => {
			const node = create("section", "lifecycle-group");
			node.append(create("h3", "lifecycle-group__title", group.label));
			for (const item of QUOTE_STATES.filter(candidate => candidate.group === group.key)) {
				const row = create("div", "lifecycle-row");
				const currentValue = optionalNumber(counts[item.key]);
				const currentAvailable = breakdownAvailable && currentValue !== undefined;
				row.dataset.group = group.key;
				row.dataset.status = item.key;
				row.dataset.current = currentAvailable ? "available" : "unknown";
				const observed = coverageAvailable ? observedStatuses.has(item.key) : undefined;
				row.dataset.observed = observed === undefined ? "unknown" : observed ? "true" : "false";
				row.setAttribute(
					"aria-label",
					`${item.label}: current count ${currentAvailable ? compactNumber(currentValue) : "unavailable"}; ${
						observed === undefined
							? "historical target evidence unavailable"
							: observed
								? "observed during this run"
								: "not observed during this run"
					}`,
				);
				const label = create("span", "lifecycle-row__label", item.label);
				const value = create("span", "lifecycle-row__value", currentAvailable ? compactNumber(currentValue) : "—");
				const history = create("span", "lifecycle-row__history", observed === undefined ? "unavailable" : observed ? "yes" : "no");
				row.append(label, value, history);
				node.append(row);
			}
			return node;
		});
		dom["lifecycle-bars"].replaceChildren(...groupNodes);
	}

	function keyedRecords(source, ...paths) {
		for (const path of paths) {
			const value = valueAt(source, path);
			if (Array.isArray(value)) {
				const result = {};
				for (const record of value) {
					if (!isObject(record)) continue;
					const key = text(pick(record, "action", "name", "key", "operation"), "");
					if (key) result[key] = record;
				}
				return result;
			}
			if (isObject(value)) return value;
		}
		return {};
	}

	function actionRecords(report) {
		const actions = currentActions(report);
		const assurance = currentAssurance(report);
		const outcomes = keyedRecords(actions, "byAction", "actions", "by_action");
		const validators = keyedRecords(assurance, "byAction", "actions", "validators", "by_action");
		const perActionKeys = [...new Set([...Object.keys(outcomes), ...Object.keys(validators)])];
		if (perActionKeys.length === 0) return [];
		const keys = new Set([...ACTION_ORDER.filter(key => perActionKeys.includes(key)), ...perActionKeys]);
		return [...keys].map(key => {
			const outcome = object(outcomes[key]);
			const validator = object(validators[key]);
			return {
				action: key,
				succeeded: numeric(pick(outcome, "succeeded", "success", "passed")),
				failed: numeric(outcome.failed),
				timedOut: numeric(pick(outcome, "timedOut", "timed_out", "timeout")),
				late: numeric(pick(outcome, "settledAfterTimeout", "settled_after_timeout", "lateSettled")),
				eligible: numeric(pick(validator, "eligible", "observed", "decisions")),
				selected: numeric(pick(validator, "selected", "validated")),
				changed: numeric(pick(validator, "changed", "changedSuccessful", "observable")),
				confirmed: numeric(pick(validator, "confirmed", "checked")),
			};
		});
	}

	function numericCell(value, tone) {
		const cell = create("td", value === 0 ? "table-zero" : tone || "", compactNumber(value));
		return cell;
	}

	function renderActions(report) {
		const records = actionRecords(report);
		const caption = create("caption", "", "Action outcomes and independent state checks");
		const head = document.createElement("thead");
		const headRow = document.createElement("tr");
		for (const label of ["Action", "OK", "Fail", "Timeout", "Late settle", "Selected", "Checked changes"]) {
			const cell = create("th", "", label);
			cell.scope = "col";
			headRow.append(cell);
		}
		head.append(headRow);
		const body = document.createElement("tbody");
		if (records.length === 0) {
			const row = document.createElement("tr");
			const cell = create(
				"td",
				"table-zero",
				"Per-action outcome telemetry unavailable; aggregate queue jobs are not shown as protocol actions.",
			);
			cell.colSpan = 7;
			row.append(cell);
			body.append(row);
		}
		for (const record of records) {
			const row = document.createElement("tr");
			row.append(create("td", "", humanize(record.action)));
			row.append(numericCell(record.succeeded, "table-good"));
			row.append(numericCell(record.failed, "table-bad"));
			row.append(numericCell(record.timedOut, "table-warn"));
			row.append(numericCell(record.late, "table-warn"));
			const selected = create(
				"td",
				record.selected > 0 ? "table-good" : "table-zero",
				`${compactNumber(record.selected)}/${compactNumber(record.eligible)}`,
			);
			selected.title = `${percent(record.eligible === 0 ? undefined : record.selected / record.eligible)} observed selection rate`;
			row.append(selected);
			const confirmed = create(
				"td",
				record.confirmed > 0 ? "table-good" : "table-zero",
				`${compactNumber(record.confirmed)}/${compactNumber(record.changed)}`,
			);
			confirmed.title = "Independently checked state changes / observable state changes";
			row.append(confirmed);
			body.append(row);
		}
		dom["action-table"].replaceChildren(caption, head, body);

		const assurance = currentAssurance(report);
		const confirmedValue = pick(assurance, "confirmedActionTypes");
		const coverageAvailable = Array.isArray(confirmedValue);
		const confirmed = new Set(array(confirmedValue).map(value => text(value, "")));
		const confirmedActions = ACTION_ORDER.filter(action => confirmed.has(action));
		setText(
			dom["action-type-summary"],
			coverageAvailable ? `${confirmedActions.length} / ${ACTION_ORDER.length} types checked` : "Evidence unavailable",
		);
		dom["action-type-coverage"].replaceChildren(
			...ACTION_ORDER.map(action => {
				const isConfirmed = confirmed.has(action);
				const chip = create("span", "action-type-chip", `${!coverageAvailable ? "—" : isConfirmed ? "✓" : "○"} ${humanize(action)}`);
				chip.dataset.state = !coverageAvailable ? "unknown" : isConfirmed ? "confirmed" : "missing";
				const meaning = !coverageAvailable
					? "confirmed action-type data unavailable"
					: isConfirmed
						? "at least one observable state change was independently checked"
						: "no independently checked state change observed yet";
				chip.title = meaning;
				chip.setAttribute("aria-label", `${humanize(action)}: ${meaning}`);
				return chip;
			}),
		);
	}

	function renderCorners(report) {
		const corners = currentCorners(report);
		const coverageAvailable = Object.keys(operationMap(corners)).length > 0;
		const matrixNodes = [];
		for (const operation of CORNER_OPERATIONS) {
			const counts = cornerCounts(corners, operation.key);
			const operationState = coverageAvailable ? cornerState(counts) : "unknown";
			const row = create("div", "corner-row");
			row.dataset.state = operationState;
			const glyph =
				operationState === "passed"
					? "✓"
					: operationState === "verified-with-failures"
						? "!"
						: operationState === "failed"
							? "×"
							: operationState === "unresolved"
								? "?"
								: operationState === "skipped"
									? "↷"
									: operationState === "unknown"
										? "?"
										: "·";
			const identity = create("div");
			identity.append(
				create("p", "corner-row__name", operation.label),
				create(
					"p",
					"corner-row__detail",
					stakeholderCopy(counts.detail) ||
						(operationState === "unknown"
							? "Coverage data unavailable"
							: operationState === "verified-with-failures"
								? "Both passes and failures recorded"
								: operationState === "unresolved"
									? `${compactNumber(counts.unresolved)} attempt${counts.unresolved === 1 ? "" : "s"} with no recorded outcome`
									: humanize(operationState)),
				),
			);
			const unresolvedCount = counts.unresolved > 0 ? `\n${compactNumber(counts.unresolved)} unresolved` : "";
			const count = create(
				"p",
				"corner-row__counts",
				`${compactNumber(counts.succeeded)} pass\n${compactNumber(counts.failed)} fail${unresolvedCount}`,
			);
			row.append(create("span", "corner-row__glyph", glyph), identity, count);
			matrixNodes.push(row);
		}
		dom["corner-matrix"].replaceChildren(...matrixNodes);
	}

	function mixBlock(label, value, detail, ratioValue, tone) {
		const node = create("div", "mix-block");
		node.append(create("p", "mix-block__label", label), create("p", "mix-block__value", value), create("p", "mix-block__detail", detail));
		if (ratioValue !== undefined) {
			const meter = create("div", "mix-meter");
			const fill = create("div", "mix-meter__fill");
			if (tone) fill.style.background = tone;
			fill.style.width = `${clamp(ratioValue * 100, 0, 100)}%`;
			meter.append(fill);
			node.append(meter);
		}
		return node;
	}

	function renderMix(report) {
		const quotes = currentQuotes(report);
		if (!hasQuoteTelemetry(quotes)) {
			dom["mix-grid"].replaceChildren(
				mixBlock("Quote execution mix", "—", "Current quote inventory unavailable"),
				mixBlock(
					"State-check target",
					percent(pick(report, "run.config.validationProbability", "config.validationProbability")),
					"Ordinary transition sampling",
				),
			);
			return;
		}
		const position = firstObject(quotes, "byPositionType", "positionType", "direction");
		const opening = firstObject(quotes, "byOpeningOrderType", "openingOrderType", "opening");
		const closing = firstObject(quotes, "byCloseOrderType", "closeOrderType", "closing");
		const partialOpen = firstObject(quotes, "partialOpen", "partial_open");
		const long = optionalNumber(position.LONG, position.long);
		const short = optionalNumber(position.SHORT, position.short);
		const openLimit = optionalNumber(opening.LIMIT, opening.limit);
		const openMarket = optionalNumber(opening.MARKET, opening.market);
		const closeLimit = optionalNumber(closing.LIMIT, closing.limit);
		const closeMarket = optionalNumber(closing.MARKET, closing.market);
		const split = optionalNumber(pick(partialOpen, "splits", "splitOpens"));
		const activeSplit = optionalNumber(pick(partialOpen, "activePositions", "active"));
		const waiting = optionalNumber(pick(partialOpen, "waitingRemainders", "remainders"));
		const partialRequests = optionalNumber(pick(quotes, "partialCloseRequested", "partialCloseRequests"));
		const partiallyClosed = optionalNumber(pick(quotes, "partiallyClosed", "partialClosed"));
		const pair = (left, right) => (left === undefined || right === undefined ? "—" : `${compactNumber(left)} / ${compactNumber(right)}`);
		const ratioOf = (left, right) => (left === undefined || right === undefined ? undefined : left + right === 0 ? 0 : left / (left + right));
		const knownNumber = value => (value === undefined ? "—" : compactNumber(value));
		dom["mix-grid"].replaceChildren(
			mixBlock("Long / short", pair(long, short), "All observed quotes", ratioOf(long, short)),
			mixBlock(
				"Opening limit / market",
				pair(openLimit, openMarket),
				"First-seen order mode",
				ratioOf(openLimit, openMarket),
				cssColor("--cyan"),
			),
			mixBlock(
				"Closing limit / market",
				pair(closeLimit, closeMarket),
				"Live close requests only",
				ratioOf(closeLimit, closeMarket),
				cssColor("--amber"),
			),
			mixBlock(
				"Split opens",
				knownNumber(split),
				activeSplit === undefined ? "Active split-position count unavailable" : `${compactNumber(activeSplit)} active split positions`,
			),
			mixBlock("Waiting remainders", knownNumber(waiting), "Pre-open split children"),
			mixBlock("Partial close requests", knownNumber(partialRequests), "Request < remaining open amount"),
			mixBlock("Partially closed", knownNumber(partiallyClosed), "0 < closed amount < quantity"),
			mixBlock(
				"State-check target",
				percent(pick(report, "run.config.validationProbability", "config.validationProbability")),
				"Ordinary transition sampling",
			),
		);
	}

	function activityRecords(report) {
		const value = pick(report || {}, "activity");
		let records = [];
		if (Array.isArray(value)) records = value;
		else if (isObject(value)) records = firstArray(value, "recent", "items", "events", "records");
		records = records
			.map(itemValue => {
				const item = object(itemValue);
				if (!isObject(item.event)) return itemValue;
				return {
					...item.event,
					root: item.root,
					elapsedMs: item.elapsedMs,
				};
			})
			.filter(item => {
				if (!isObject(item)) return true;
				const phase = text(item.phase, "").toLowerCase();
				return phase !== "queued" && phase !== "started" && item.type !== "pause";
			});
		const firstTimestamp =
			timestampNumber(pick(object(records[0]), "at", "timestamp", "emittedAt")) ?? optionalNumber(pick(object(records[0]), "elapsedMs"));
		const lastTimestamp =
			timestampNumber(pick(object(records.at(-1)), "at", "timestamp", "emittedAt")) ??
			optionalNumber(pick(object(records.at(-1)), "elapsedMs"));
		if (firstTimestamp !== undefined && lastTimestamp !== undefined && firstTimestamp < lastTimestamp) records = [...records].reverse();
		return records;
	}

	function activityTone(item) {
		const phase = text(pick(item, "phase", "status", "outcome"), "").toLowerCase();
		if (/(fail|error|timeout)/.test(phase) || pick(item, "error") !== undefined) return "bad";
		if (/(success|pass|settled|complete|verified)/.test(phase)) return "good";
		if (/(skip|stop|drain|late)/.test(phase)) return "warn";
		return "neutral";
	}

	function activityTitle(item) {
		if (!isObject(item)) return text(item);
		const explicit = pick(item, "title", "message", "summary", "label");
		if (explicit !== undefined) return stakeholderCopy(explicit);
		const type = text(item.type, "");
		if (type === "state") {
			const quoteId = text(pick(item, "quoteId", "quote.id"), "?");
			return `Quote #${quoteId} → ${text(pick(item, "quoteStatus", "status"), "state observed")}`;
		}
		if (type === "operation") return `${humanize(pick(item, "operation"))} · ${humanize(pick(item, "phase"))}`;
		if (type === "action") return `${text(pick(item, "action", "name"), "Action")} · ${humanize(pick(item, "phase"))}`;
		if (type === "root") {
			const index = text(pick(item, "index", "root"), "?");
			const outcome = text(item.status, "completed").toLowerCase();
			const outcomeCopy =
				outcome === "sent"
					? "Generated quote submitted"
					: outcome === "discarded"
						? "Generated input discarded"
						: stakeholderCopy(humanize(outcome));
			return `Simulation cycle #${index} · ${outcomeCopy}`;
		}
		return humanize(type || pick(item, "name") || "Activity");
	}

	function activityDetail(item) {
		if (!isObject(item)) return "";
		const explicit = pick(item, "detail", "description");
		if (explicit !== undefined) return stakeholderCopy(explicit, "");
		const parts = [];
		const actor = pick(item, "actorId", "actor", "userId");
		const quote = pick(item, "quoteId");
		const trigger = pick(item, "quoteStatus", "fromStatus");
		const error = pick(item, "error");
		const route =
			item.type === "root" && pick(item, "userId") !== undefined && pick(item, "hedgerId") !== undefined
				? `${text(item.userId)} → ${text(item.hedgerId)}`
				: undefined;
		if (route !== undefined) parts.push(route);
		if (actor !== undefined) parts.push(text(actor));
		if (quote !== undefined) parts.push(`quote #${text(quote)}`);
		if (trigger !== undefined) parts.push(`from ${text(trigger)}`);
		if (optionalNumber(item.durationMs) !== undefined) parts.push(duration(item.durationMs));
		if (error !== undefined) parts.push(text(error));
		return parts.join(" · ");
	}

	function activityMatchesFilter(item, filter) {
		if (filter === "all") return true;
		const type = text(pick(item, "type"), "").toLowerCase();
		if (filter === "quotes") return type === "state" || pick(item, "quoteId", "quote.id") !== undefined;
		if (filter === "actors") return type === "action" || type === "decision";
		if (filter === "corners") return type === "operation" || /^corner:/i.test(text(pick(item, "title", "name"), ""));
		if (filter === "errors") return activityTone(item) === "bad";
		return true;
	}

	function renderActivity(report) {
		const records = activityRecords(report);
		const filteredRecords = records.filter(itemValue => activityMatchesFilter(object(itemValue), state.activityFilter));
		const visibleRecords = filteredRecords.slice(0, state.activityVisible);
		const droppedActivity = numeric(pick(report || {}, "retention.droppedActivity", "retention.droppedEvents"));
		const countDetail =
			filteredRecords.length === records.length
				? `${compactNumber(records.length)} retained`
				: `${compactNumber(filteredRecords.length)}/${compactNumber(records.length)} retained`;
		setText(dom["activity-count"], countDetail);
		dom["activity-count"].title =
			`${compactNumber(visibleRecords.length)} shown${droppedActivity > 0 ? `; ${compactNumber(droppedActivity)} raw events not retained` : ""}`;
		setText(dom["activity-retention-note"], `${compactNumber(droppedActivity)} older events omitted from this view.`);
		dom["activity-retention-note"].hidden = droppedActivity <= 0;
		if (filteredRecords.length === 0) {
			const empty = create(
				"li",
				"empty-copy",
				records.length === 0 ? "No meaningful activity has been retained yet." : "No retained activity matches this filter.",
			);
			dom["activity-list"].replaceChildren(empty);
			dom["activity-more"].hidden = true;
			dom["activity-footer"].hidden = true;
			return;
		}
		const nodes = visibleRecords.map(itemValue => {
			const item = object(itemValue);
			const tone = activityTone(item);
			const row = create("li", "activity-item");
			row.dataset.tone = tone;
			const eventTime =
				clockTime(pick(item, "at", "timestamp", "emittedAt")) ||
				(optionalNumber(item.elapsedMs) !== undefined ? duration(item.elapsedMs) : "—");
			const marker = tone === "good" ? "✓" : tone === "bad" ? "×" : tone === "warn" ? "!" : "·";
			const copy = create("div", "activity-item__copy");
			copy.append(create("p", "activity-item__title", activityTitle(item)), create("p", "activity-item__detail", activityDetail(item)));
			const rawTag = text(pick(item, "type", "phase"), "");
			const tag =
				pick(item, "sequence") !== undefined
					? `#${text(item.sequence)}`
					: rawTag === "root"
						? "cycle"
						: rawTag === "operation"
							? "high-risk"
							: rawTag;
			row.append(
				create("time", "activity-item__time", eventTime),
				create("span", "activity-item__marker", marker),
				copy,
				create("span", "activity-item__tag", tag),
			);
			return row;
		});
		dom["activity-list"].replaceChildren(...nodes);
		const remaining = filteredRecords.length - visibleRecords.length;
		dom["activity-more"].hidden = remaining <= 0;
		dom["activity-footer"].hidden = remaining <= 0;
		setText(dom["activity-more"], `Show ${compactNumber(Math.min(ACTIVITY_PAGE_SIZE, remaining))} more · ${compactNumber(remaining)} remaining`);
	}

	function failureRecords(report) {
		const direct = pick(report || {}, "failures");
		if (Array.isArray(direct)) return direct;
		if (isObject(direct)) {
			const nested = firstArray(direct, "items", "records", "errors");
			if (nested.length > 0) return nested;
			return Object.entries(direct).map(([boundary, error]) => ({ boundary, error }));
		}
		const resultFailures = firstArray(report || {}, "run.failures", "result.failures", "run.result.failures");
		return resultFailures;
	}

	function renderFailures(report) {
		const failures = failureRecords(report);
		const signals = runSignalSnapshot(report);
		const aggregateFailures = signals.failureCategories;
		const hasVisibleFailureDetail = failures.length > 0 || signals.hasFailure || !signals.evidenceComplete;
		dom["failure-list"].hidden = !hasVisibleFailureDetail;
		setText(
			dom["failure-count"],
			failures.length > 0
				? `${compactNumber(failures.length)} ${failures.length === 1 ? "record" : "records"}`
				: aggregateFailures.length > 0
					? `${compactNumber(aggregateFailures.length)} ${aggregateFailures.length === 1 ? "signal" : "signals"}`
					: signals.evidenceComplete
						? "0"
						: "—",
		);
		dom["failure-count"].dataset.tone = failures.length > 0 || signals.hasFailure ? "bad" : signals.evidenceComplete ? "neutral" : "warn";
		if (failures.length === 0) {
			dom["failure-list"].replaceChildren(
				create(
					"p",
					signals.hasFailure || !signals.evidenceComplete ? "failure-summary" : "empty-copy",
					signals.hasFailure
						? `No detailed failure boundaries retained. Aggregate failure signals: ${aggregateFailures.join(" · ")}.`
						: signals.evidenceComplete
							? signals.storageWarning
								? "No fuzz failures recorded. The report storage warning is listed under Coverage and Report integrity."
								: "No failure boundaries or aggregate failure signals recorded."
							: `Aggregate failure telemetry unavailable: ${signals.evidenceGaps.join(", ")}.`,
				),
			);
			return;
		}
		const nodes = failures
			.slice(-10)
			.reverse()
			.map(itemValue => {
				const item = object(itemValue);
				const node = create("div", "failure-item");
				const boundary = stakeholderCopy(humanize(pick(item, "boundary", "type", "phase") || "Failure"));
				const message = stakeholderCopy(pick(item, "message", "error.message", "error", "detail", "reason"), "Unknown failure");
				node.append(create("p", "failure-item__boundary", boundary), create("p", "failure-item__message", message));
				return node;
			});
		if (aggregateFailures.length > 0) {
			nodes.unshift(create("p", "failure-summary", `Aggregate failure signals: ${aggregateFailures.join(" · ")}.`));
		}
		dom["failure-list"].replaceChildren(...nodes);
	}

	function replayCommand(report) {
		const value = pick(report || {}, "result.replay", "result.replayCommand", "run.replay", "latest.replay", "replay");
		if (Array.isArray(value)) return value.map(item => text(item, "")).join(" ");
		return text(value, "");
	}

	function renderReplay(report) {
		const replay = replayCommand(report);
		setText(dom["replay-command"], replay || "Replay command is not available yet.");
		dom["copy-replay-panel"].disabled = !replay;
		dom["hero-replay-button"].disabled = !replay;
	}

	function retentionEntries(report) {
		const retention = firstObject(report || {}, "retention");
		const entries = [];
		const retentionAvailable = Object.keys(retention).length > 0;
		const byteCapped = boolean(pick(retention, "capped", "truncated", "truncatedToByteCap"));
		const compacted =
			boolean(retention.degraded) ||
			numeric(retention.droppedTimeline) > 0 ||
			numeric(retention.droppedActivity) > 0 ||
			numeric(retention.droppedEvents) > 0 ||
			numeric(retention.timelineStride) > numeric(retention.timelineEveryRoots);
		const mode = !retentionAvailable
			? "Unavailable"
			: retention.lastWriteError
				? "Write error"
				: byteCapped
					? "Byte-capped"
					: compacted
						? "Compacted"
						: "Exact";
		entries.push(["Mode", mode]);
		const known = [
			["Timeline cadence", ["timelineEveryRoots"]],
			["Timeline stride", ["timelineStride"]],
			["Timeline limit", ["maxTimeline", "timelineBuckets", "buckets"]],
			["Activity limit", ["maxActivity", "activity", "activityCount"]],
			["Dropped timeline", ["droppedTimeline", "dropped"]],
			["Dropped activity", ["droppedActivity", "droppedEvents"]],
			["Coalesced", ["coalesced", "coalescedEvents"]],
			["Malformed", ["malformed", "malformedLines"]],
		];
		for (const [label, keys] of known) {
			const value = keys.map(key => retention[key]).find(candidate => candidate !== undefined && candidate !== null);
			if (value !== undefined) entries.push([label, compactNumber(value)]);
		}
		const sourceBytes = pick(retention, "sourceBytes", "bytes", "fileBytes");
		if (sourceBytes !== undefined) entries.push(["Source size", bytes(sourceBytes)]);
		if (retention.maxBytes !== undefined) entries.push(["Report byte cap", bytes(retention.maxBytes)]);
		if (retention.lastWriteAt !== undefined) entries.push(["Last write", shortDate(retention.lastWriteAt)]);
		if (retention.lastWriteError !== undefined) entries.push(["Write error", text(retention.lastWriteError)]);
		if (entries.length === 1) entries.push(["Bounds", "Not declared"]);
		return entries;
	}

	function renderRetention(report) {
		dom["retention-list"].replaceChildren(
			...retentionEntries(report).map(([label, value]) => {
				const row = create("div");
				row.append(create("dt", "", label), create("dd", "", value));
				return row;
			}),
		);
	}

	function reportTimestamp(report) {
		return (
			timestampNumber(
				pick(
					report || {},
					"generatedAt",
					"updatedAt",
					"run.updatedAt",
					"run.updated_at",
					"latest.at",
					"latest.timestamp",
					"run.finishedAt",
					"run.finished_at",
				),
			) ?? Date.now()
		);
	}

	function renderReport(report) {
		dom["waiting-state"].hidden = true;
		dom.dashboard.hidden = false;
		renderRunHeader(report);
		renderStory(report);
		renderCoverageVerdict(report);
		renderKpis(report);
		renderOutcomes(report);
		renderConfidenceLimits(report);
		renderLifecycle(report);
		renderActions(report);
		renderCorners(report);
		renderMix(report);
		renderActivity(report);
		renderFailures(report);
		renderReplay(report);
		renderRetention(report);
		dom["export-report"].disabled = false;
		setText(
			dom["footer-source"],
			state.selectedRunId ? `Source: /api/runs/${state.selectedRunId} · archived run` : "Source: /api/report · current run",
		);
		window.requestAnimationFrame(() => renderCharts(report));
	}

	function hasReportPayload(value) {
		if (!isObject(value)) return false;
		return ["run", "config", "setup", "latest", "timeline", "milestones", "activity", "failures", "result", "retention"].some(
			key => value[key] !== undefined,
		);
	}

	function unwrapReport(value) {
		if (hasReportPayload(value)) return value;
		if (isObject(value) && hasReportPayload(value.report)) return value.report;
		return null;
	}

	async function fetchJson(url) {
		const controller = new AbortController();
		const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			const response = await fetch(url, {
				cache: "no-store",
				headers: { Accept: "application/json" },
				signal: controller.signal,
			});
			if (response.status === 204) return null;
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return await response.json();
		} finally {
			window.clearTimeout(timeout);
		}
	}

	function selectedRun() {
		return state.runs.find(run => text(pick(run, "id", "runId", "key", "value"), "") === state.selectedRunId);
	}

	function reportUrl() {
		if (!state.selectedRunId) return "/api/report";
		const run = selectedRun();
		const explicit = pick(object(run), "reportUrl", "url", "href");
		if (typeof explicit === "string") {
			try {
				const url = new URL(explicit, window.location.origin);
				if (url.origin === window.location.origin) return `${url.pathname}${url.search}`;
			} catch {
				// Fall through to the fixed same-origin endpoint.
			}
		}
		return `/api/runs/${encodeURIComponent(state.selectedRunId)}`;
	}

	function showError(error) {
		state.error = error instanceof Error ? error.message : text(error, "Unknown report error");
		dom["error-banner"].hidden = false;
		setText(dom["error-message"], `${state.error}. The dashboard will retry automatically.`);
		updateConnection();
	}

	function clearError() {
		state.error = null;
		dom["error-banner"].hidden = true;
	}

	async function loadReport({ force = false } = {}) {
		if (!force && !state.following && state.report !== null) return;
		const request = ++state.reportRequest;
		try {
			const payload = await fetchJson(reportUrl());
			if (request !== state.reportRequest) return;
			state.lastSuccessAt = Date.now();
			clearError();
			const report = unwrapReport(payload);
			if (!report) {
				state.report = null;
				state.lastReportAt = 0;
				dom["export-report"].disabled = true;
				dom["waiting-state"].hidden = false;
				dom.dashboard.hidden = true;
				updateConnection();
				return;
			}
			state.report = report;
			state.lastReportAt = reportTimestamp(report);
			renderReport(report);
			updateConnection();
		} catch (error) {
			if (request !== state.reportRequest) return;
			showError(error);
		}
	}

	function runLabel(run) {
		const id = text(pick(run, "id", "runId", "key", "value"), "run");
		const seed = text(pick(run, "seed", "config.seed"), "");
		const status = text(pick(run, "status", "outcome", "phase"), "");
		const started = shortDate(pick(run, "startedAt", "started_at", "at"));
		const archiveMatch = id.match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}(?:\.\d+)?)Z-([a-f0-9]{6,})\.json$/i);
		const archiveStarted = archiveMatch ? shortDate(`${archiveMatch[1]}:${archiveMatch[2]}:${archiveMatch[3]}Z`) : "";
		const archiveHash = archiveMatch ? archiveMatch[4].slice(0, 8) : "";
		if (!status && !seed && !started && archiveMatch) return `${archiveStarted} · ${archiveHash} · archived`;
		const details = [status && humanize(status), seed && `seed ${seed}`, started].filter(Boolean);
		return details.length ? `${id} · ${details.join(" · ")}` : id;
	}

	function renderRunOptions() {
		const currentValue = state.selectedRunId;
		const options = [new Option("Current run", "")];
		for (const run of state.runs) {
			const id = text(pick(run, "id", "runId", "key", "value"), "");
			if (!id) continue;
			options.push(new Option(runLabel(run), id));
		}
		dom["run-select"].replaceChildren(...options);
		if ([...dom["run-select"].options].some(option => option.value === currentValue)) dom["run-select"].value = currentValue;
		else {
			state.selectedRunId = "";
			state.following = true;
			state.report = null;
			state.activityVisible = ACTIVITY_PAGE_SIZE;
			dom["run-select"].value = "";
			dom["waiting-state"].hidden = false;
			dom.dashboard.hidden = true;
			updateConnection();
			if (currentValue) void loadReport({ force: true });
		}
	}

	async function loadRuns() {
		try {
			const payload = await fetchJson("/api/runs");
			const runs = Array.isArray(payload) ? payload : firstArray(payload || {}, "runs", "items", "reports");
			state.runs = runs.map(item => (isObject(item) ? item : { id: item }));
			state.lastRunsAt = Date.now();
			renderRunOptions();
		} catch {
			// A missing run archive must not interrupt the current live report.
		}
	}

	function updateFollowButton() {
		const following = state.following && !state.selectedRunId;
		dom["follow-button"].setAttribute("aria-pressed", following ? "true" : "false");
		setText(dom["follow-button-label"], following ? "Pause updates" : "Follow live");
		dom["follow-button"].title = following ? "Pause automatic report updates" : "Return to the current report";
	}

	function updateConnection() {
		let connectionState = "waiting";
		let label = "Waiting for a report";
		let detail = "Polling the local runner";
		if (state.error) {
			connectionState = "error";
			label = "Report error";
			detail = state.error;
		} else if (!state.following || state.selectedRunId) {
			connectionState = "frozen";
			label = state.selectedRunId ? "Past report" : "Updates paused";
			detail = state.selectedRunId ? `Showing run ${state.selectedRunId}` : "Automatic report updates are paused";
		} else if (!state.report) {
			connectionState = "waiting";
		} else if (isLiveRun(state.report) && state.lastReportAt > 0 && Date.now() - state.lastReportAt > STALE_AFTER_MS) {
			connectionState = "stale";
			label = "Report stale";
			detail = `Last report update ${ago(state.lastReportAt)}`;
		} else if (state.lastSuccessAt > 0) {
			connectionState = "ready";
			label = "Report connected";
			detail = `Updated ${ago(state.lastReportAt || state.lastSuccessAt)}`;
		}
		dom["connection-banner"].dataset.state = connectionState;
		setText(dom["connection-label"], label);
		setText(dom["connection-detail"], detail);
		if (state.connectionState && state.connectionState !== connectionState) announce(`${label}. ${detail}.`);
		state.connectionState = connectionState;
		updateFollowButton();
		if (state.report) {
			const acceptedAt = state.lastReportAt || state.lastSuccessAt;
			const acceptedAge = ago(acceptedAt);
			renderRunStatus(state.report, connectionState);
			setText(dom["run-title"], runHeadline(state.report, connectionState));
			setText(dom["run-subtitle"], runSummary(state.report, connectionState));
			setText(dom["freshness-value"], acceptedAge);
			setText(dom["elapsed-value"], duration(elapsedMs(state.report)));
			const quoteSource = currentQuotes(state.report);
			const quoteSummary =
				hasQuoteTelemetry(quoteSource) && quoteTotals(quoteSource).total !== undefined
					? `${compactNumber(quoteTotals(quoteSource).total)} tracked quotes · configured targets, not exhaustive coverage`
					: "Configured run targets, not exhaustive protocol coverage";
			const freshnessSummary =
				connectionState === "stale"
					? `stale snapshot from ${acceptedAge}`
					: connectionState === "frozen"
						? state.selectedRunId
							? `archived snapshot from ${acceptedAge}`
							: `updates paused at ${acceptedAge}`
						: connectionState === "error"
							? `last accepted snapshot from ${acceptedAge}`
							: `updated ${acceptedAge}`;
			setText(dom["health-note"], `${quoteSummary} · ${freshnessSummary}`);
		}
	}

	async function copyReplay() {
		const replay = replayCommand(state.report);
		if (!replay) return;
		let copied = false;
		try {
			await navigator.clipboard.writeText(replay);
			copied = true;
		} catch {
			const input = document.createElement("textarea");
			input.value = replay;
			input.setAttribute("readonly", "");
			input.style.position = "fixed";
			input.style.left = "-10000px";
			document.body.append(input);
			input.select();
			copied = document.execCommand("copy");
			input.remove();
		}
		announce(copied ? "Replay command copied." : "Replay command could not be copied.");
	}

	function exportFilename(report) {
		const run = reportRun(report);
		const config = reportConfig(report);
		const source = pick(config, "seed") ?? pick(run, "seed", "id", "runId") ?? state.selectedRunId ?? "run";
		const safeSource =
			text(source, "run")
				.toLowerCase()
				.replace(/[^a-z0-9._-]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 72) || "run";
		return `symmio-fuzz-${safeSource}.json`;
	}

	function exportReport() {
		if (!state.report) return;
		try {
			const content = `${JSON.stringify(state.report, null, 2)}\n`;
			const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
			const link = document.createElement("a");
			link.href = url;
			link.download = exportFilename(state.report);
			link.hidden = true;
			document.body.append(link);
			link.click();
			link.remove();
			window.setTimeout(() => URL.revokeObjectURL(url), 0);
			announce(`Exported ${link.download}.`);
		} catch {
			announce("The current report could not be exported.");
		}
	}

	function updateChartWindowButtons() {
		for (const button of document.querySelectorAll("[data-chart-window]")) {
			const value = button.dataset.chartWindow === "all" ? "all" : numeric(button.dataset.chartWindow);
			button.setAttribute("aria-pressed", value === state.chartWindow ? "true" : "false");
		}
	}

	function updateActivityFilterButtons() {
		for (const button of document.querySelectorAll("[data-activity-filter]")) {
			button.setAttribute("aria-pressed", button.dataset.activityFilter === state.activityFilter ? "true" : "false");
		}
	}

	function activateDetailsTab(tabName, { focus = false } = {}) {
		const buttons = [...document.querySelectorAll("[data-details-tab]")];
		const selectedButton = buttons.find(button => button.dataset.detailsTab === tabName);
		if (!selectedButton) return;

		state.detailsTab = tabName;
		for (const button of buttons) {
			const selected = button === selectedButton;
			button.setAttribute("aria-selected", selected ? "true" : "false");
			button.tabIndex = selected ? 0 : -1;
		}
		for (const pane of document.querySelectorAll("[data-details-pane]")) {
			pane.hidden = pane.dataset.detailsPane !== tabName;
		}

		if (focus) selectedButton.focus();
		if (tabName === "runner") window.requestAnimationFrame(scheduleChartRender);
	}

	function handleDetailsTabKeydown(event) {
		const buttons = [...document.querySelectorAll("[data-details-tab]")];
		const currentIndex = buttons.indexOf(event.currentTarget);
		if (currentIndex < 0) return;

		let nextIndex;
		if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % buttons.length;
		else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
		else if (event.key === "Home") nextIndex = 0;
		else if (event.key === "End") nextIndex = buttons.length - 1;
		else return;

		event.preventDefault();
		activateDetailsTab(buttons[nextIndex].dataset.detailsTab, { focus: true });
	}

	function scheduleChartRender() {
		if (!state.report || state.resizeFrame) return;
		state.resizeFrame = window.requestAnimationFrame(() => {
			state.resizeFrame = 0;
			renderCharts(state.report);
		});
	}

	function bindEvents() {
		dom["follow-button"].addEventListener("click", () => {
			if (state.following && !state.selectedRunId) {
				state.following = false;
				announce("Updates paused. The displayed report will not change.");
				updateConnection();
				return;
			}
			state.selectedRunId = "";
			dom["run-select"].value = "";
			state.following = true;
			state.report = null;
			state.activityVisible = ACTIVITY_PAGE_SIZE;
			dom["waiting-state"].hidden = false;
			dom.dashboard.hidden = true;
			announce("Following the current report.");
			updateConnection();
			void loadReport({ force: true });
		});
		dom["run-select"].addEventListener("change", () => {
			state.selectedRunId = dom["run-select"].value;
			state.following = state.selectedRunId === "";
			state.report = null;
			state.activityVisible = ACTIVITY_PAGE_SIZE;
			dom["waiting-state"].hidden = false;
			dom.dashboard.hidden = true;
			updateConnection();
			void loadReport({ force: true });
		});
		dom["retry-button"].addEventListener("click", () => void loadReport({ force: true }));
		dom["copy-replay-panel"].addEventListener("click", copyReplay);
		dom["hero-replay-button"].addEventListener("click", copyReplay);
		dom["story-replay"].addEventListener("click", playStory);
		dom["export-report"].addEventListener("click", exportReport);
		dom["activity-more"].addEventListener("click", () => {
			state.activityVisible += ACTIVITY_PAGE_SIZE;
			if (state.report) renderActivity(state.report);
		});
		for (const button of document.querySelectorAll("[data-details-tab]")) {
			button.addEventListener("click", () => activateDetailsTab(button.dataset.detailsTab));
			button.addEventListener("keydown", handleDetailsTabKeydown);
		}
		dom.details.addEventListener("toggle", () => {
			if (dom.details.open && state.detailsTab === "runner") window.requestAnimationFrame(scheduleChartRender);
		});
		for (const button of document.querySelectorAll("[data-chart-window]")) {
			button.addEventListener("click", () => {
				state.chartWindow = button.dataset.chartWindow === "all" ? "all" : numeric(button.dataset.chartWindow, 64);
				updateChartWindowButtons();
				if (state.report) renderCharts(state.report);
			});
		}
		for (const button of document.querySelectorAll("[data-activity-filter]")) {
			button.addEventListener("click", () => {
				state.activityFilter = button.dataset.activityFilter || "all";
				state.activityVisible = ACTIVITY_PAGE_SIZE;
				updateActivityFilterButtons();
				if (state.report) renderActivity(state.report);
			});
		}
		for (const [canvasId, tooltipId] of [
			["quote-chart", "quote-tooltip"],
			["pace-chart", "pace-tooltip"],
			["queue-chart", "queue-tooltip"],
		]) {
			installTooltip(dom[canvasId], dom[tooltipId]);
		}
		if ("ResizeObserver" in window) {
			const observer = new ResizeObserver(scheduleChartRender);
			observer.observe(dom.dashboard);
		} else {
			window.addEventListener("resize", scheduleChartRender);
		}
		window.addEventListener("resize", () => {
			if (!state.report) return;
			clearStoryMotion();
			for (const step of dom["story-track"].querySelectorAll("[data-story-step]")) step.classList.add("is-complete");
			setText(dom["story-stage-copy"], "Cycle settled. Replay the explanation to see each stage.");
		});
	}

	function startTimers() {
		state.pollTimer = window.setInterval(() => void loadReport(), POLL_INTERVAL_MS);
		state.runsTimer = window.setInterval(() => void loadRuns(), RUNS_INTERVAL_MS);
		state.statusTimer = window.setInterval(updateConnection, 1_000);
	}

	function initialize() {
		cacheDom();
		bindEvents();
		activateDetailsTab(state.detailsTab);
		updateChartWindowButtons();
		updateActivityFilterButtons();
		updateConnection();
		void loadRuns();
		void loadReport({ force: true });
		startTimers();
	}

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
	else initialize();
})();
