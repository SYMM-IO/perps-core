import { Wallet } from "ethers"
import assert from "node:assert/strict"
import test from "node:test"

import { isHyperEVMChainId, setHyperEVMBigBlocksForSigner } from "../../tasks/deploy/hyperevm.js"

test("HyperEVM big-block helper accepts an explicit signer", async () => {
	assert.equal(isHyperEVMChainId(999), true)
	assert.equal(isHyperEVMChainId(998n), true)
	assert.equal(isHyperEVMChainId(1), false)

	const signer = Wallet.createRandom()
	const originalFetch = globalThis.fetch
	let requestUrl = ""
	let requestBody: any

	globalThis.fetch = async (input, init) => {
		requestUrl = String(input)
		requestBody = JSON.parse(String(init?.body))
		return new Response(JSON.stringify({ status: "ok" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		})
	}

	try {
		await setHyperEVMBigBlocksForSigner(signer, 999, true)
	} finally {
		globalThis.fetch = originalFetch
	}

	assert.equal(requestUrl, "https://api.hyperliquid.xyz/exchange")
	assert.equal(requestBody.action.type, "evmUserModify")
	assert.equal(requestBody.action.usingBigBlocks, true)
	assert.equal(requestBody.vaultAddress, null)
	assert.match(requestBody.signature.r, /^0x[0-9a-f]{64}$/i)
	assert.match(requestBody.signature.s, /^0x[0-9a-f]{64}$/i)
})

test("HyperEVM big-block helper rejects other chains before signing", async () => {
	const signer = Wallet.createRandom()
	await assert.rejects(() => setHyperEVMBigBlocksForSigner(signer, 1, true), /Not a HyperEVM chain/)
})
