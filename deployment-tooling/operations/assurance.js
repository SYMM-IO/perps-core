import { validateStatusReport } from "../../cli/commands/status.js";
import { assessChecklist } from "./checklist.js";
import { sanitizeEvidence } from "./redaction.js";
import { hashSourceTree } from "./source-manifest.js";
import { keccak256 } from "ethers";
import { createHash } from "node:crypto";

export function evidenceDigest(value) {
	const stable = item =>
		Array.isArray(item)
			? item.map(stable)
			: item && typeof item === "object"
				? Object.fromEntries(
						Object.keys(item)
							.sort()
							.map(key => [key, stable(item[key])]),
					)
				: item;
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(stable(value)))
		.digest("hex")}`;
}
const hash = value => /^0x[0-9a-f]{64}$/i.test(value || "");
const digest = value => /^sha256:[0-9a-f]{64}$/.test(value || "");
const address = value => /^0x[0-9a-f]{40}$/i.test(value || "") && !/^0x0{40}$/i.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;

function validateInput(input) {
	if (input?.apiVersion !== "operations.symm.io/assurance-input-v1") throw new Error("Unknown assurance input version");
	if (!integer(input.chainId) || input.chainId === 0 || !digest(input.reportDigest) || !digest(input.sourceHash))
		throw new Error("Missing chain/report/source identity");
	if (!input.finalized || !integer(input.finalized.number) || !hash(input.finalized.hash) || !Number.isFinite(Date.parse(input.finalized.at)))
		throw new Error("Missing finalized block identity/time");
	if (input.finalityPolicy !== "owner-provided-finalized") throw new Error("Only owner-provided finalized evidence is supported");
	for (const [name, min, max] of [
		["deadlineMs", 1, 60000],
		["maxAgeMs", 1, 86400000],
	]) {
		if (!integer(input[name]) || input[name] < min || input[name] > max) throw new Error(`Invalid ${name}`);
	}
	if (!Array.isArray(input.components) || !input.components.length || input.components.length > 100)
		throw new Error("Component scope must contain 1-100 entries");
	const ids = new Set();
	for (const item of input.components) {
		if (!/^[a-z][a-z0-9.-]{0,63}$/.test(item.id || "") || ids.has(item.id) || !address(item.address) || !hash(item.codeHash))
			throw new Error("Invalid/duplicate component identity");
		if (
			!Array.isArray(item.requiredChecks) ||
			!item.requiredChecks.length ||
			item.requiredChecks.length > 100 ||
			new Set(item.requiredChecks).size !== item.requiredChecks.length ||
			item.requiredChecks.some(check => typeof check !== "string" || !check.trim() || check.length > 150)
		)
			throw new Error("Missing strict component check scope");
		ids.add(item.id);
	}
	if (
		!Array.isArray(input.journal) ||
		input.journal.length > 1000 ||
		new Set(input.journal.map(tx => tx.hash?.toLowerCase())).size !== input.journal.length ||
		input.journal.some(
			tx =>
				!hash(tx.hash) ||
				(tx.replacementHash && !hash(tx.replacementHash)) ||
				!integer(tx.nonce) ||
				!integer(tx.confirmations) ||
				tx.confirmations < 1 ||
				!address(tx.from) ||
				(tx.to !== null && !address(tx.to)) ||
				!/^0x[0-9a-f]*$/i.test(tx.data || "") ||
				!/^\d+$/.test(tx.value || ""),
		)
	)
		throw new Error("Invalid transaction scope");
}

async function bounded(action, deadline, controller) {
	if (controller.signal.aborted || Date.now() >= deadline) throw new Error("Evidence deadline exceeded");
	let timer;
	try {
		return await Promise.race([
			Promise.resolve().then(() => action(controller.signal)),
			new Promise((_, reject) => {
				timer = setTimeout(
					() => {
						controller.abort();
						reject(new Error("Evidence deadline exceeded"));
					},
					Math.max(1, deadline - Date.now()),
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

// Evidence ingestion only: this module has no RPC URL, signer, transaction sender,
// resume/cancel path or active-state writer. Reader is a bounded fixture interface.
export async function assessDeployment(input, reader, { root = process.cwd(), now = new Date() } = {}) {
	validateInput(input);
	const deadline = Date.now() + input.deadlineMs;
	const controller = new AbortController();
	const result = {
		apiVersion: "operations.symm.io/assurance-v1",
		createdAt: now.toISOString(),
		evidenceKind: "owner-provided",
		inputDigest: evidenceDigest(input),
		chainId: input.chainId,
		reportDigest: input.reportDigest,
		sourceHash: hashSourceTree(root),
		finalityPolicy: input.finalityPolicy,
		finalized: input.finalized,
		status: "incomplete",
		checks: [],
		components: [],
		transactions: [],
	};
	const check = (id, status) => result.checks.push({ id, status });
	check("source-binding", result.sourceHash === input.sourceHash ? "passed" : "failed");
	const blockAge = now.getTime() - Date.parse(input.finalized.at);
	check("block-freshness", blockAge >= 0 && blockAge <= input.maxAgeMs ? "passed" : "unknown");
	try {
		const evidence = await bounded(signal => reader.report(signal), deadline, controller);
		if (!evidence?.report) {
			check("report-validation", "unknown");
			throw new Error("Missing report evidence");
		}
		const bound = evidence.chainId === input.chainId && evidence.blockHash === input.finalized.hash && evidence.sourceHash === input.sourceHash;
		const capturedAge = now.getTime() - Date.parse(evidence.capturedAt);
		check("evidence-freshness", Number.isFinite(capturedAge) && capturedAge >= 0 && capturedAge <= input.maxAgeMs ? "passed" : "unknown");
		check("report-binding", bound && evidenceDigest(evidence.report) === input.reportDigest ? "passed" : "failed");
		validateStatusReport(evidence.report, input.chainId, { requireVerification: evidence.context?.recipe?.network?.mode === "live" });
		// Reuse the operator checklist predicates. Missing/failed doctor or strict
		// health evidence can never be converted into a successful checklist.
		const strictUnknown =
			!Array.isArray(evidence.strictResults) ||
			!evidence.strictResults.length ||
			evidence.strictResults.some(item => !["pass", "fail", "warn"].includes(item.status));
		const checklist = assessChecklist({
			...evidence,
			statusCode: !strictUnknown && evidence.strictResults.every(item => item.status === "pass") ? 0 : 1,
		});
		for (const item of checklist) {
			if (strictUnknown && [3, 4, 5, 6, 7, 8, 9, 10, 13].includes(Number(item.id.slice(6)))) item.status = "unknown";
			if (item.id === "check-13" && evidence.doctorCode === undefined) item.status = "unknown";
		}
		result.checks.push(...checklist);
	} catch (error) {
		check("report-validation", /deadline|Missing report evidence/i.test(error.message) ? "unknown" : "failed");
	}
	for (const item of input.components) {
		const observation = { id: item.id, address: item.address, status: "unknown" };
		try {
			const evidence = await bounded(signal => reader.component(item.id, signal), deadline, controller);
			if (!evidence) throw new Error("Missing component evidence");
			const bound =
				evidence.chainId === input.chainId &&
				evidence.blockHash === input.finalized.hash &&
				evidence.address?.toLowerCase() === item.address.toLowerCase();
			const codeValid = /^0x(?:[a-f0-9]{2})+$/i.test(evidence.code || "");
			const checks = Array.isArray(evidence.results) ? evidence.results : [];
			const missing = item.requiredChecks.some(
				name => checks.filter(check => check.check === name).length !== 1 || checks.find(check => check.check === name)?.status === "unknown",
			);
			observation.status =
				!bound ||
				!codeValid ||
				keccak256(evidence.code).toLowerCase() !== item.codeHash.toLowerCase() ||
				checks.some(check => check.status === "fail" || check.status === "warn")
					? "failed"
					: missing || checks.some(check => check.status !== "pass")
						? "unknown"
						: "passed";
		} catch {
			/* Missing or timed-out reads are explicitly unknown. */
		}
		result.components.push(observation);
	}
	for (const transaction of input.journal) {
		const observation = {
			hash: transaction.hash,
			...(transaction.replacementHash ? { replacementHash: transaction.replacementHash } : {}),
			status: "unknown",
		};
		try {
			const evidence = await bounded(signal => reader.transaction(transaction, signal), deadline, controller);
			if (evidence?.chainId !== input.chainId || evidence.blockHash !== input.finalized.hash) throw new Error("Unbound transaction evidence");
			// Reader uses the same intent/receipt checks as deployment reconciliation.
			if (["confirmed", "replaced", "failed"].includes(evidence.status)) observation.status = evidence.status;
		} catch {
			/* Absence never proves dropped, reusable nonce, or successful payout. */
		}
		result.transactions.push(observation);
	}
	controller.abort();
	const statuses = [...result.checks, ...result.components, ...result.transactions].map(item => item.status);
	result.status = statuses.includes("failed")
		? "failed"
		: statuses.every(status => ["passed", "confirmed", "replaced"].includes(status))
			? "complete"
			: "incomplete";
	return sanitizeEvidence(result);
}
