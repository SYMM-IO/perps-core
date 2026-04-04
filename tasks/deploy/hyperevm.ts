import { ethers as ethersLib } from "ethers"
import { task } from "hardhat/config"

import { getConnection } from "./helpers.js"

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
}

const PHANTOM_AGENT_TYPES = {
	Agent: [
		{ name: "source", type: "string" },
		{ name: "connectionId", type: "bytes32" },
	],
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
async function setHyperEVMBigBlocks(hre: any, enable: boolean): Promise<void> {
	const { ethers } = await getConnection(hre)
	const [signer] = await ethers.getSigners()
	const chainId = Number((await ethers.provider.getNetwork()).chainId)

	// Determine source and API URL based on chain
	let source: string
	let apiUrl: string
	if (chainId === 999) {
		source = "a" // mainnet
		apiUrl = "https://api.hyperliquid.xyz/exchange"
	} else if (chainId === 998) {
		source = "b" // testnet
		apiUrl = "https://api.hyperliquid-testnet.xyz/exchange"
	} else {
		throw new Error(`Not a HyperEVM chain (chainId: ${chainId}). Expected 999 (mainnet) or 998 (testnet).`)
	}

	const action: Record<string, string | boolean> = { type: "evmUserModify", usingBigBlocks: enable }
	const nonce = BigInt(Date.now())
	const connectionId = constructConnectionId(action, nonce)

	const phantomAgent = { source, connectionId }

	// Sign with EIP-712 phantom agent
	const signature = await signer.signTypedData(HYPERCORE_DOMAIN, PHANTOM_AGENT_TYPES, phantomAgent)

	// Verify locally to catch signing issues early
	const recovered = ethersLib.verifyTypedData(HYPERCORE_DOMAIN, PHANTOM_AGENT_TYPES, phantomAgent, signature)
	if (recovered.toLowerCase() !== signer.address.toLowerCase()) {
		console.error("EIP-712 signature verification FAILED locally!")
		console.error(`  Expected signer:    ${signer.address}`)
		console.error(`  Recovered address:  ${recovered}`)
		console.error(`  connectionId:       ${connectionId}`)
		console.error(`  msgpack(action):    ${ethersLib.hexlify(msgpackEncode(action))}`)
		console.error("This indicates a bug in the Hardhat signer's signTypedData implementation.")
		throw new Error("EIP-712 signature mismatch: recovered address does not match signer")
	}

	const { r, s, v } = ethersLib.Signature.from(signature)

	const payload = {
		action,
		nonce: Number(nonce),
		signature: { r, s, v },
		vaultAddress: null,
	}

	console.log(`${enable ? "Enabling" : "Disabling"} big blocks on HyperEVM (chain ${chainId})...`)
	console.log(`Signer: ${signer.address}`)

	const response = await fetch(apiUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	})

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
