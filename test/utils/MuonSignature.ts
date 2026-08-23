import type { Signer } from "ethers"

import { ethers } from "../helpers/hardhat-connection.js"

export const EXPRESS_CREDIT_MUON_FUNCTION = 8

const SECP256K1_ORDER = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141")
const SECP256K1_HALF_ORDER = (SECP256K1_ORDER >> 1n) + 1n

export type DeterministicMuonKey = {
	privateKey: string
	publicKey: { x: bigint; parity: number }
	owner: string
}

function modulo(value: bigint, modulus: bigint): bigint {
	const result = value % modulus
	return result >= 0n ? result : result + modulus
}

/** Build a deterministic test-only Muon key whose x-coordinate passes the verifier constraint. */
export function deterministicMuonKey(seed = 1n): DeterministicMuonKey {
	for (let scalar = seed; scalar < SECP256K1_ORDER; scalar++) {
		const privateKey = ethers.toBeHex(scalar, 32)
		const uncompressed = ethers.SigningKey.computePublicKey(privateKey, false)
		const x = BigInt(`0x${uncompressed.slice(4, 68)}`)
		if (x >= SECP256K1_HALF_ORDER) continue

		const y = BigInt(`0x${uncompressed.slice(68)}`)
		return {
			privateKey,
			publicKey: { x, parity: Number(y & 1n) },
			owner: ethers.computeAddress(privateKey),
		}
	}

	throw new Error("Unable to derive a valid deterministic Muon key")
}

/** Produce the Schnorr shape expected by LibMuonV04ClientBase for a test hash. */
export function signMuonHash(hash: string, key: DeterministicMuonKey, nonceSeed = 10_000n) {
	const privateScalar = BigInt(key.privateKey)
	const messageHash = BigInt(hash)

	for (let nonceScalar = nonceSeed; nonceScalar < SECP256K1_ORDER; nonceScalar++) {
		const noncePrivateKey = ethers.toBeHex(nonceScalar, 32)
		const nonce = ethers.computeAddress(noncePrivateKey)
		const challenge = BigInt(
			ethers.solidityPackedKeccak256(["uint256", "uint8", "uint256", "address"], [key.publicKey.x, key.publicKey.parity, messageHash, nonce]),
		)
		const signature = modulo(nonceScalar - privateScalar * challenge, SECP256K1_ORDER)
		if (signature !== 0n) return { signature, owner: key.owner, nonce }
	}

	throw new Error("Unable to derive a non-zero deterministic Muon signature")
}

export async function buildSignedExpressCreditData(params: {
	appId: bigint
	reqId?: string
	affiliate: string
	eligibleBase: bigint
	timestamp: bigint
	chainId: bigint
	expressProvider: string
	symmio: string
	muonKey: DeterministicMuonKey
	gatewaySigner: Pick<Signer, "signMessage">
	nonceSeed?: bigint
}): Promise<{ encoded: string; hash: string }> {
	const reqId = params.reqId ?? "0x0001"
	const hash = ethers.solidityPackedKeccak256(
		["uint256", "bytes", "address", "uint256", "uint256", "uint256", "address", "address"],
		[params.appId, reqId, params.affiliate, params.eligibleBase, params.timestamp, params.chainId, params.expressProvider, params.symmio],
	)
	const sigs = signMuonHash(hash, params.muonKey, params.nonceSeed)
	const gatewaySignature = await params.gatewaySigner.signMessage(ethers.getBytes(hash))
	const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
		["tuple(bytes reqId,uint256 eligibleBase,uint256 timestamp,bytes gatewaySignature,tuple(uint256 signature,address owner,address nonce) sigs)"],
		[{ reqId, eligibleBase: params.eligibleBase, timestamp: params.timestamp, gatewaySignature, sigs }],
	)

	return { encoded, hash }
}
