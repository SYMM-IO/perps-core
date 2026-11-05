import { redactSignerSecrets } from "../../cli/signer/index.js";

/** An error that knows its HTTP status and a short code the interface can act on. */
export class HttpError extends Error {
	constructor(status, code, message) {
		super(message);
		this.status = status;
		this.code = code;
	}
}
export const httpError = (status, code, message) => new HttpError(status, code, message);

/**
 * One rule for every message that can reach the browser, a log line or a saved plan. RPC URLs often carry
 * a key in their path, so the whole URL goes; key-shaped values named as such go too. Transaction and role
 * hashes are left alone: they are the useful part of most messages.
 */
export function redact(value, max = 2000) {
	return redactSignerSecrets(String(value ?? ""))
		.replace(/(?:https?|wss?):\/\/[^\s'"`<>]+/giu, "<rpc>")
		.replace(/((?:private|secret)[ _-]?key["']?\s*[:=]\s*["']?)(?:0x)?[a-fA-F0-9]{64}\b/giu, "$1<redacted>")
		.replace(/\b((?:api[ _-]?key|access[_-]?token|token|password|secret)\s*[:=]\s*)[^\s&'"`<>]+/giu, "$1<redacted>")
		.replace(/((?:^|[?&\s])key=)[^\s&'"`<>]+/giu, "$1<redacted>")
		.slice(0, max);
}

/** The text of an error the way ethers and the adapters put it, redacted. */
export const errorMessage = (error, max) =>
	redact(
		[error?.shortMessage || error?.message || String(error), error?.info?.error?.message || error?.error?.message].filter(Boolean).join(": "),
		max,
	);

// Messages the adapters raise before they tag their errors; each maps to the status and code it stands for.
const KNOWN = [
	[/already running|operation is running|current operation to finish|execution task is running/i, 409, "busy"],
	[/finish (?:or cancel )?the active|continue or cancel the active/i, 409, "task-active"],
	[/nonce changed/i, 412, "nonce-changed"],
	[/source changed|checkout inputs changed/i, 412, "stale-source"],
	[/(?:target|state|fingerprint)\b.* changed\. inspect|differs from the pinned/i, 412, "stale-fingerprint"],
	[/checksum mismatch|prepare again|prepare a new plan|does not match the plan/i, 412, "stale-plan"],
	[/differs from profile chain|rpc chain changed|chain mismatch|belongs to another workspace/i, 412, "chain-mismatch"],
];

/** Status, code and message for anything a route throws. Tagged errors keep their own; the rest are classified. */
export function classify(error) {
	const message = errorMessage(error);
	if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 600)
		return { status: error.status, code: typeof error.code === "string" ? error.code : "error", message };
	if (error?.code === "ENOENT") return { status: 404, code: "not-found", message: "Not found" };
	if (error instanceof SyntaxError) return { status: 400, code: "bad-input", message };
	for (const [pattern, status, code] of KNOWN) if (pattern.test(message)) return { status, code, message };
	// Ethers errors carry a short message and an upper-case code: the chain or the RPC said no.
	if (error?.shortMessage && /^[A-Z_]+$/.test(String(error.code || ""))) return { status: 502, code: "rpc", message };
	if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError || (error && !(error instanceof Error)))
		return { status: 500, code: "internal", message };
	// A plain Error is how the adapters refuse a request the operator can correct.
	return { status: 400, code: "bad-request", message };
}
