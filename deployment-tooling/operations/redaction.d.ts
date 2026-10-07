export function registerRedactionSecrets(values: Iterable<unknown>): () => void
export function redactText(value: unknown): string
export function sanitizeEvidence<T>(value: T, field?: string): T
export function sanitizeEvidenceInPlace<T>(value: T, field?: string): T
