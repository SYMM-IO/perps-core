import { ethers } from "ethers"

import { decimal, unDecimal } from "./Common.js"

export type RandomSeed = string | number | bigint

let randomSeed: RandomSeed | undefined
let randomCounter = 0n

function serializeSeed(seed: RandomSeed): string {
	return `${typeof seed}:${seed.toString()}`
}

function seededRandomBytes(length: number, seed: RandomSeed): Uint8Array {
	const result = new Uint8Array(length)
	let offset = 0

	while (offset < length) {
		const block = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(`${serializeSeed(seed)}:${randomCounter++}`)))
		const blockLength = Math.min(block.length, length - offset)
		result.set(block.subarray(0, blockLength), offset)
		offset += blockLength
	}

	return result
}

function randomBytes(length: number): Uint8Array {
	return randomSeed === undefined ? ethers.randomBytes(length) : seededRandomBytes(length, randomSeed)
}

function bytesToBigInt(bytes: Uint8Array): bigint {
	let result = 0n
	for (const byte of bytes) result = (result << 8n) | BigInt(byte)
	return result
}

export function setRandomSeed(seed: RandomSeed | undefined): void {
	randomSeed = seed
	randomCounter = 0n
}

export function getRandomSeed(): RandomSeed | undefined {
	return randomSeed
}

export async function withIsolatedRandomSequence<T>(operation: () => T | Promise<T>): Promise<T> {
	const savedSeed = randomSeed
	const savedCounter = randomCounter
	try {
		return await operation()
	} finally {
		randomSeed = savedSeed
		randomCounter = savedCounter
	}
}

export function randomFloat(): number {
	const random53Bits = bytesToBigInt(randomBytes(7)) >> 3n
	return Number(random53Bits) / 0x20_0000_0000_0000
}

export function pick<T>(array: readonly T[]): T {
	if (array.length === 0) throw new RangeError("Cannot pick from an empty array")
	return array[Number(randomBigNumber(BigInt(array.length)))]
}

export function randomBigNumber(max: bigint, min?: bigint): bigint {
	const lowerBound = min ?? 0n

	if (max < lowerBound) {
		throw new RangeError(`Invalid random bigint range: max (${max}) must be greater than or equal to min (${lowerBound})`)
	}
	if (max === lowerBound) return lowerBound

	const range = max - lowerBound
	if (range === 1n) return lowerBound

	const bitLength = (range - 1n).toString(2).length
	const byteLength = Math.ceil(bitLength / 8)
	const excessBits = byteLength * 8 - bitLength

	while (true) {
		const bytes = randomBytes(byteLength)
		if (excessBits > 0) bytes[0] &= 0xff >> excessBits
		const candidate = bytesToBigInt(bytes)
		if (candidate < range) return lowerBound + candidate
	}
}

export function randomBigNumberRatio(value: bigint, max: number, min?: number): bigint {
	return unDecimal(
		value * randomBigNumber(decimal(BigInt(Math.floor(max * 10000)), 14), min != null ? decimal(BigInt(Math.floor(min * 10000)), 14) : undefined),
	)
}
