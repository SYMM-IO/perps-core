import { setTimeout as delay } from "node:timers/promises"

export type LfReadRetry = { maxAttempts?: number; delayMs?: number }

class MissingLfBlock extends Error {}

function unavailableState(error: any): boolean {
	if (error instanceof MissingLfBlock) return true
	// A decoded contract revert is a real failure, even if its text mentions a block.
	if (error?.code === "CALL_EXCEPTION" && (error.reason || (typeof error.data === "string" && error.data !== "0x"))) return false
	const messages = [error?.message, error?.shortMessage, error?.error?.message, error?.info?.error?.message]
	return messages.some(
		message =>
			typeof message === "string" &&
			!/execution reverted|reverted with/i.test(message) &&
			/header not found|unknown block|block (?:\S+ )?not found|block (?:\S+ )?(?:is )?(?:not available|unavailable)|state (?:for .* )?(?:is )?(?:not available|unavailable)|missing trie node|historical state.*unavailable/i.test(
				message,
			),
	)
}

/** Retry only unavailable block/state reads. Never retry signing, submission, or simulation reverts. */
export function retryLfReads(provider: any, options: LfReadRetry = {}) {
	const { maxAttempts = 16, delayMs = 2000 } = options
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || !Number.isFinite(delayMs) || delayMs < 0) throw new Error("Invalid LF read retry settings")
	return new Proxy(provider, {
		get(target, property) {
			const value = Reflect.get(target, property)
			if (typeof value !== "function") return value
			if (!["getBlock", "getCode", "call"].includes(String(property))) return value.bind(target)
			return async (...args: any[]) => {
				const tag = property === "getBlock" ? args[0] : property === "getCode" ? args[1] : args[0]?.blockTag
				const label = `${property === "getBlock" ? "verification block" : "state at block"} ${tag ?? "latest"}`
				for (let attempt = 1; ; attempt++) {
					try {
						const result = await value.apply(target, args)
						if (property === "getBlock" && !result?.hash) throw new MissingLfBlock()
						return result
					} catch (error) {
						if (!unavailableState(error)) throw error
						if (attempt >= maxAttempts) throw new Error(`LF ${label} is unavailable after ${maxAttempts} reads; resume when the RPC can serve it`)
						console.log(`LF ${label} is not available yet; retrying in ${delayMs / 1000}s (${attempt + 1}/${maxAttempts})`)
						await delay(delayMs)
					}
				}
			}
		},
	})
}
