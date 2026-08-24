import { ethers as ethersLib } from "ethers"
import type { TypedDataDomain, TypedDataField } from "ethers"
import { task } from "hardhat/config"
import { createRequire } from "node:module"

import { getConnection } from "./helpers.js"

const require = createRequire(import.meta.url)
const HYPEREVM_MAINNET_CHAIN_ID = 999
const HYPEREVM_TESTNET_CHAIN_ID = 998

type BigBlockSigner = {
	address?: string
	getAddress?: () => Promise<string>
	signTypedData: (domain: TypedDataDomain, types: Record<string, TypedDataField[]>, value: Record<string, unknown>) => Promise<string>
	__ledgerTransport?: unknown
	__ledgerPath?: string
}

/**
 * Minimal msgpack encoder for simple flat objects (string keys, string/boolean values).
 * Only supports fixmap, fixstr, str8, and boolean types.
 */
function msgpackEncode(obj: Record<string, string | boolean>): Uint8Array {
	const entries = Object.entries(obj)
	if (entries.length > 15) throw new Error("msgpackEncode: too many entries for fixmap")

	const parts: number[] = []
	parts.push(0x80 | entries.length) // fixmap header

	for (const [key, value] of entries) {
		// Encode string key
		encodeString(parts, key)

		// Encode value
		if (typeof value === "boolean") {
			parts.push(value ? 0xc3 : 0xc2)
		} else if (typeof value === "string") {
			encodeString(parts, value)
		} else {
			throw new Error(`msgpackEncode: unsupported value type "${typeof value}"`)
		}
	}

	return new Uint8Array(parts)
}

function encodeString(parts: number[], str: string): void {
	const bytes = new TextEncoder().encode(str)
	if (bytes.length <= 31) {
		parts.push(0xa0 | bytes.length) // fixstr
	} else if (bytes.length <= 255) {
		parts.push(0xd9, bytes.length) // str8
	} else {
		throw new Error(`msgpackEncode: string too long (${bytes.length} bytes)`)
	}
	parts.push(...bytes)
}

// EIP-712 domain for HyperCore L1 exchange API
const HYPERCORE_DOMAIN = {
	name: "Exchange",
	version: "1",
	chainId: 1337,
	verifyingContract: "0x0000000000000000000000000000000000000000",
} satisfies TypedDataDomain

const PHANTOM_AGENT_TYPES = {
	Agent: [
		{ name: "source", type: "string" },
		{ name: "connectionId", type: "bytes32" },
	],
} satisfies Record<string, TypedDataField[]>

export function isHyperEVMChainId(chainId: bigint | number): boolean {
	const normalized = Number(chainId)
	return normalized === HYPEREVM_MAINNET_CHAIN_ID || normalized === HYPEREVM_TESTNET_CHAIN_ID
}

function getHyperCoreParams(chainId: bigint | number): { apiUrl: string; source: string } {
	const normalized = Number(chainId)
	if (normalized === HYPEREVM_MAINNET_CHAIN_ID) return { apiUrl: "https://api.hyperliquid.xyz/exchange", source: "a" }
	if (normalized === HYPEREVM_TESTNET_CHAIN_ID) return { apiUrl: "https://api.hyperliquid-testnet.xyz/exchange", source: "b" }
	throw new Error(`Not a HyperEVM chain (chainId: ${chainId}). Expected 999 (mainnet) or 998 (testnet).`)
}

function apiTimeoutMs(): number {
	const raw = process.env.HYPEREVM_API_TIMEOUT_MS || "30000"
	if (!/^\d+$/.test(raw)) throw new Error(`HYPEREVM_API_TIMEOUT_MS must be a whole number; received ${JSON.stringify(raw)}.`)
	const value = Number(raw)
	if (!Number.isSafeInteger(value) || value < 1_000 || value > 120_000) {
		throw new Error(`HYPEREVM_API_TIMEOUT_MS must be between 1000 and 120000; received ${JSON.stringify(raw)}.`)
	}
	return value
}

/**
 * Construct the connectionId for the EIP-712 phantom agent signature.
 *
 * Layout: msgpack(action) || nonce(8 bytes BE) || vaultMarker(1 byte)
 *
 * Vault marker: 0x00 if no vault, 0x01 + address(20 bytes) if vault is set.
 * See: https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/master/hyperliquid/utils/signing.py
 */
function constructConnectionId(action: Record<string, string | boolean>, nonce: bigint): string {
	const actionBytes = msgpackEncode(action)

	// Total: msgpack + 8 (nonce) + 1 (vault marker 0x00)
	const combined = new Uint8Array(actionBytes.length + 8 + 1)
	combined.set(actionBytes, 0)

	// Nonce: 8 bytes big-endian
	const view = new DataView(combined.buffer, combined.byteOffset)
	view.setBigUint64(actionBytes.length, nonce, false)

	// Vault marker: 0x00 = no vault
	combined[actionBytes.length + 8] = 0x00

	return ethersLib.keccak256(combined)
}

async function getSignerAddress(signer: BigBlockSigner): Promise<string> {
	const address = signer.address ?? (await signer.getAddress?.())
	if (!address) throw new Error("Big-block signer does not expose an address or getAddress().")
	return ethersLib.getAddress(address)
}

function prefixedHex(value: string): string {
	return value.startsWith("0x") ? value : `0x${value}`
}

function ledgerVToNumber(value: string | number): number {
	if (typeof value === "number") return value
	return Number.parseInt(value.startsWith("0x") ? value.slice(2) : value, 16)
}

function normalizeTypedDataSignatureForSigner(
	signature: string,
	domain: TypedDataDomain,
	types: Record<string, TypedDataField[]>,
	value: Record<string, unknown>,
	signerAddress: string,
): string {
	const recovered = ethersLib.verifyTypedData(domain, types, value, signature)
	if (recovered.toLowerCase() === signerAddress.toLowerCase()) return signature

	const parsed = ethersLib.Signature.from(signature)
	const flipped = ethersLib.Signature.from({ r: parsed.r, s: parsed.s, yParity: (parsed.yParity ^ 1) as 0 | 1 }).serialized
	const flippedRecovered = ethersLib.verifyTypedData(domain, types, value, flipped)
	if (flippedRecovered.toLowerCase() === signerAddress.toLowerCase()) {
		console.warn("Ledger EIP-712 signature recovered with alternate y-parity; using normalized signature.")
		return flipped
	}

	throw new Error(`EIP-712 signature mismatch: expected ${signerAddress}, recovered ${recovered}, alternate parity recovered ${flippedRecovered}`)
}

async function signTypedDataForHyperCore(
	signer: BigBlockSigner,
	domain: TypedDataDomain,
	types: Record<string, TypedDataField[]>,
	value: Record<string, unknown>,
	signerAddress: string,
): Promise<string> {
	if (signer.__ledgerTransport && signer.__ledgerPath !== undefined) {
		const { default: Eth } = require("@ledgerhq/hw-app-eth")
		const domainHash = ethersLib.TypedDataEncoder.hashDomain(domain)
		const valueHash = ethersLib.TypedDataEncoder.from(types).hash(value)
		const signed = await new Eth(signer.__ledgerTransport).signEIP712HashedMessage(signer.__ledgerPath, domainHash.slice(2), valueHash.slice(2))
		const signature = ethersLib.Signature.from({
			r: prefixedHex(signed.r),
			s: prefixedHex(signed.s),
			v: ledgerVToNumber(signed.v),
		}).serialized
		return normalizeTypedDataSignatureForSigner(signature, domain, types, value, signerAddress)
	}

	return normalizeTypedDataSignatureForSigner(await signer.signTypedData(domain, types, value), domain, types, value, signerAddress)
}

/**
 * Call the HyperCore L1 exchange API to enable or disable big blocks for the signer's address.
 *
 * HyperEVM has a dual-block architecture:
 * - Fast blocks: ~2M gas limit, ~1s finality
 * - Large blocks: ~30M gas limit, ~1min finality
 *
 * By default, transactions target the fast block. Deploying large contracts (e.g., facets)
 * requires opting into large blocks via the HyperCore L1 exchange API.
 *
 * Prerequisites:
 * - The signer address must exist on HyperCore L1 (must have deposited USDC via Hyperliquid bridge)
 */
export async function setHyperEVMBigBlocksForSigner(signer: BigBlockSigner, chainId: bigint | number, enable: boolean): Promise<void> {
	const signerAddress = await getSignerAddress(signer)
	const { source, apiUrl } = getHyperCoreParams(chainId)
	const action: Record<string, string | boolean> = { type: "evmUserModify", usingBigBlocks: enable }
	const nonce = BigInt(Date.now())
	const connectionId = constructConnectionId(action, nonce)
	const phantomAgent = { source, connectionId }
	const signature = await signTypedDataForHyperCore(signer, HYPERCORE_DOMAIN, PHANTOM_AGENT_TYPES, phantomAgent, signerAddress)
	const { r, s, v } = ethersLib.Signature.from(signature)
	const payload = {
		action,
		nonce: Number(nonce),
		signature: { r, s, v },
		vaultAddress: null,
	}

	console.log(`${enable ? "Enabling" : "Disabling"} big blocks on HyperEVM (chain ${chainId})...`)
	console.log(`Signer: ${signerAddress}`)

	let response: Response
	const timeoutMs = apiTimeoutMs()
	try {
		response = await fetch(apiUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(timeoutMs),
		})
	} catch (error) {
		throw new Error(
			`Hyperliquid big-block API request failed after at most ${timeoutMs}ms: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	const contentType = response.headers.get("content-type") || ""
	if (!contentType.includes("application/json")) {
		const text = await response.text()
		throw new Error(
			`API returned non-JSON response (status ${response.status}, content-type: ${contentType}).\n` +
				`This usually means the Hyperliquid API endpoint is temporarily down or unreachable.\n` +
				`URL: ${apiUrl}\n` +
				`Response body (first 500 chars): ${text.slice(0, 500)}`,
		)
	}

	const result = await response.json()

	if (response.ok && result.status === "ok") {
		console.log(`Big blocks ${enable ? "enabled" : "disabled"} successfully!`)
		if (enable) {
			console.log("You can now deploy contracts that exceed the fast block gas limit.")
			console.log("Remember to run hyperevm:disable-big-blocks after deployment.")
		}
	} else {
		console.error("API response:", JSON.stringify(result, null, 2))
		const errorMsg = typeof result.response === "string" ? result.response : ""
		if (errorMsg.includes("does not exist")) {
			console.error("")
			console.error("Your address must exist on HyperCore L1 before calling evmUserModify.")
			console.error("To activate your address, deposit USDC to Hyperliquid via the bridge:")
			console.error("  https://app.hyperliquid.xyz/portfolio")
		}
		throw new Error(`Failed to ${enable ? "enable" : "disable"} big blocks`)
	}
}

export async function setHyperEVMBigBlocks(hre: any, enable: boolean): Promise<void> {
	const { ethers } = await getConnection(hre)
	const [signer] = await ethers.getSigners()
	const chainId = (await ethers.provider.getNetwork()).chainId
	await setHyperEVMBigBlocksForSigner(signer, chainId, enable)
}

export const enableBigBlocksTask = task("hyperevm:enable-big-blocks", "Enable big blocks on HyperEVM (required before deploying large contracts)")
	.setAction(async () => ({
		default: async (_args: unknown, hre: any) => setHyperEVMBigBlocks(hre, true),
	}))
	.build()

export const disableBigBlocksTask = task("hyperevm:disable-big-blocks", "Disable big blocks on HyperEVM (run after deployment)")
	.setAction(async () => ({
		default: async (_args: unknown, hre: any) => setHyperEVMBigBlocks(hre, false),
	}))
	.build()
