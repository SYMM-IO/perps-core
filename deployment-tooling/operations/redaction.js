// Presentation fields may contain provider errors or credentials. Recovery bytes are
// deliberately retained: redaction must never change transaction intent or bound plans.
const secrets = new Set();
const sensitiveField = /^(?:private[_-]?key|password|passphrase|secret|token|api[_-]?key|authorization|credential|rpc[_-]?url)$/i;
function preserve(field, value) {
	if (field === "constructorArgs") return true;
	if (["data", "calldata", "initCode"].includes(field) && typeof value === "string" && /^0x[0-9a-f]*$/i.test(value)) return true;
	if (/hash$/i.test(field) && typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value)) return true;
	return (
		["from", "to", "address", "signer", "expectedAddress", "factoryAddress"].includes(field) &&
		typeof value === "string" &&
		/^0x[0-9a-f]{40}$/i.test(value)
	);
}

export function registerRedactionSecrets(values) {
	const registered = [];
	for (const value of values) {
		if (((typeof value === "string" && value) || Buffer.isBuffer(value)) && !secrets.has(value)) {
			secrets.add(value);
			registered.push(value);
		}
	}
	return () => {
		for (const value of registered) secrets.delete(value);
	};
}

export function redactText(value) {
	let text = String(value);
	for (const value of secrets) {
		if (Buffer.isBuffer(value) && value.every(byte => byte === 0)) continue;
		const secret = typeof value === "string" ? value : value.toString("utf8").replace(/[\r\n]+$/, "");
		if (secret) text = text.split(secret).join("<redacted-secret>");
	}
	// Child adapters also need process-local signer values before journal persistence.
	for (const name of ["SYMMIO_EPHEMERAL_PRIVATE_KEY", "SYMMIO_SAFE_API_KEY", "PRIVATE_KEY", "NEW_DEPLOYER"]) {
		const secret = process.env[name];
		if (secret && secret.length >= 16) text = text.split(secret).join("<redacted-secret>");
	}
	return text
		.replace(/(?:https?|wss?):\/\/[^\s'"`<>]+/giu, "<redacted-url>")
		.replace(/((?:private|secret)[ _-]?key["']?\s*[:=]\s*["']?)0x[a-fA-F0-9]{64}/giu, "$1<redacted-private-key>")
		.replace(
			/((?:password|passphrase|secret|token|api[ _-]?key|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|Bearer\s+[^\s,}"']+|[^\s,}"']+)/giu,
			"$1<redacted>",
		);
}

export function sanitizeEvidence(value, field = "") {
	if (field === "authorization" && value === "operator-confirmed") return value;
	if (sensitiveField.test(field)) return "<redacted>";
	if (preserve(field, value)) return value;
	if (typeof value === "string") return redactText(value);
	if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
	if (Array.isArray(value)) return value.map(item => sanitizeEvidence(item));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeEvidence(item, key)]));
	return value;
}

// Retain object identity for active handler references (e.g. pending Safe dispatch).
export function sanitizeEvidenceInPlace(value, field = "", depth = 0) {
	// Only the runner's bound root intent is exempt. An error object's nested
	// `input`/`plan` fields are untrusted presentation and must still be sanitized.
	if (depth === 1 && ["input", "plan"].includes(field)) return value;
	if (preserve(field, value)) return value;
	if (value && typeof value === "object" && !(value instanceof Error) && !sensitiveField.test(field)) {
		for (const key of Object.keys(value)) value[key] = sanitizeEvidenceInPlace(value[key], key, depth + 1);
		return value;
	}
	return sanitizeEvidence(value, field);
}
