import { ethers as ethersLib } from "ethers"

export interface VanityPattern {
	prefix?: string
	suffix?: string
}

export interface MineCreate2Result {
	salt: string
	address: string
	attempts: number
	elapsedMs: number
}

export class MiningBudgetExceeded extends Error {
	constructor(
		readonly attempts: number,
		readonly pattern: VanityPattern,
	) {
		super(`CREATE2 mining stopped after ${attempts.toLocaleString()} attempts without matching ${describePattern(pattern)}`)
		this.name = "MiningBudgetExceeded"
	}
}

export function describePattern(pattern: VanityPattern): string {
	return `0x${pattern.prefix ?? ""}…${pattern.suffix ?? ""}`
}

export function patternLength(pattern: VanityPattern): number {
	return (pattern.prefix?.length ?? 0) + (pattern.suffix?.length ?? 0)
}

/** A uniformly distributed address matches n constrained hex characters once per 16^n tries. */
export function expectedAttempts(pattern: VanityPattern): number {
	return 16 ** patternLength(pattern)
}

const MAX_NONCE = (1n << 64n) - 1n

/**
 * Mines a CREATE2 salt whose resulting address matches the requested prefix and/or suffix.
 *
 * The search always starts at nonce 0 and takes the first match, so the same factory and init
 * code produce the same salt on every chain and every re-run.
 */
export function mineCreate2Salt(
	factoryAddress: string,
	initCode: string,
	pattern: VanityPattern,
	opts: { startNonce?: bigint; maxAttempts?: number; onProgress?: (attempts: number) => void } = {},
): MineCreate2Result {
	const prefix = pattern.prefix?.toLowerCase() ?? ""
	const suffix = pattern.suffix?.toLowerCase() ?? ""
	if (!prefix && !suffix) throw new Error("mineCreate2Salt requires a prefix or a suffix")

	const initCodeHash = ethersLib.keccak256(initCode)
	const { startNonce = 0n, maxAttempts = Number.MAX_SAFE_INTEGER, onProgress } = opts

	// One preallocated 0xff ‖ factory ‖ salt ‖ initCodeHash buffer with only the salt's low
	// bytes rewritten per attempt. Hashing it directly avoids the string building and EIP-55
	// checksumming that getCreate2Address performs on every candidate.
	const buffer = new Uint8Array(85)
	buffer[0] = 0xff
	buffer.set(ethersLib.getBytes(ethersLib.getAddress(factoryAddress)), 1)
	buffer.set(ethersLib.getBytes(initCodeHash), 53)

	const start = Date.now()
	let attempts = 0

	while (attempts < maxAttempts) {
		const nonce = startNonce + BigInt(attempts)
		if (nonce > MAX_NONCE) throw new Error("CREATE2 salt search exhausted the 64-bit nonce space")
		// The salt occupies bytes 21..52. Writing the nonce big-endian into its low 8 bytes
		// keeps it identical to zeroPadValue(toBeHex(nonce), 32).
		for (let byte = 0; byte < 8; byte++) buffer[52 - byte] = Number((nonce >> BigInt(8 * byte)) & 0xffn)

		const hash = ethersLib.keccak256(buffer)
		attempts++

		// hash is "0x" plus 64 hex characters; the address body is its last 40, from index 26.
		if ((!prefix || hash.startsWith(prefix, 26)) && (!suffix || hash.endsWith(suffix))) {
			const salt = ethersLib.zeroPadValue(ethersLib.toBeHex(nonce), 32)
			return {
				salt,
				address: ethersLib.getCreate2Address(factoryAddress, salt, initCodeHash),
				attempts,
				elapsedMs: Date.now() - start,
			}
		}

		if (onProgress && attempts % 1_000_000 === 0) onProgress(attempts)
	}

	throw new MiningBudgetExceeded(attempts, pattern)
}
