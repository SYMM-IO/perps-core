import assert from "node:assert/strict"
import test from "node:test"

import { resolveHttpRpcUrl } from "./resolveHttpRpcUrl.js"

test("resolves Hardhat's lazy ResolvedConfigurationVariable URL", async () => {
	let calls = 0
	const resolvedConfigurationVariable = {
		_type: "ResolvedConfigurationVariable",
		async getUrl() {
			calls++
			return "https://rpc.example.invalid"
		},
	}

	assert.equal(await resolveHttpRpcUrl(resolvedConfigurationVariable), "https://rpc.example.invalid")
	assert.equal(calls, 1)
})

test("keeps compatibility with a directly configured HTTP URL", async () => {
	assert.equal(await resolveHttpRpcUrl("https://rpc.example.invalid"), "https://rpc.example.invalid")
})
