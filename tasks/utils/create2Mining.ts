import { ethers as ethersLib } from "ethers"

export interface MineCreate2Result {
	salt: string
	address: string
	attempts: number
	elapsedMs: number
}

/**
 * Mines a CREATE2 salt that produces an address with the desired prefix.
 *
 * @param factoryAddress - Address of the deployed Create2Factory
 * @param initCode - Full init code (bytecode + ABI-encoded constructor args)
 * @param prefix - Desired hex prefix (without 0x), e.g. "573310"
 * @param startNonce - Optional starting nonce for the salt search (default 0)
 * @returns The salt, predicted address, and mining stats
 */
export function mineCreate2Salt(factoryAddress: string, initCode: string, prefix: string, startNonce: bigint = 0n): MineCreate2Result {
	const initCodeHash = ethersLib.keccak256(initCode)
	const targetPrefix = prefix.toLowerCase()
	const start = Date.now()
	let attempts = 0

	while (true) {
		const salt = ethersLib.zeroPadValue(ethersLib.toBeHex(startNonce + BigInt(attempts)), 32)
		const addr = ethersLib.getCreate2Address(factoryAddress, salt, initCodeHash)
		attempts++

		if (addr.toLowerCase().startsWith("0x" + targetPrefix)) {
			return {
				salt,
				address: addr,
				attempts,
				elapsedMs: Date.now() - start,
			}
		}

		if (attempts % 1_000_000 === 0) {
			const elapsed = ((Date.now() - start) / 1000).toFixed(1)
			const rate = (attempts / ((Date.now() - start) / 1000)).toFixed(0)
			console.log(`  Mining: ${attempts.toLocaleString()} attempts, ${elapsed}s elapsed, ~${rate} hashes/sec`)
		}
	}
}
