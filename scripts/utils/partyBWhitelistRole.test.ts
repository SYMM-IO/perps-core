import { id, makeError } from "ethers"
import assert from "node:assert/strict"
import { it } from "node:test"

import { partyBWhitelistRole } from "../../tasks/deploy/partyBWhitelistRole.js"

it("selects the installed split whitelist role without consulting the legacy role", async () => {
	assert.deepEqual(await partyBWhitelistRole({ MULTICAST_WHITELIST_ROLE: async () => id("MULTICAST_WHITELIST_ROLE") }), {
		name: "MULTICAST_WHITELIST_ROLE",
		role: id("MULTICAST_WHITELIST_ROLE"),
	})
})

it("supports legacy deployments only after an empty selector revert and validates their getter", async () => {
	const missing = makeError("missing selector", "CALL_EXCEPTION", {
		action: "call",
		data: "0x",
		reason: null,
		transaction: { to: null, data: "0x" },
		invocation: null,
		revert: null,
	})
	const contract = {
		MULTICAST_WHITELIST_ROLE: async () => {
			throw missing
		},
		MANAGER_ROLE: async () => id("MANAGER_ROLE"),
	}
	assert.equal((await partyBWhitelistRole(contract)).name, "MANAGER_ROLE")
	await assert.rejects(partyBWhitelistRole({ ...contract, MANAGER_ROLE: async () => id("WRONG_ROLE") }), /Unexpected PartyB/)
})

it("does not mistake transport failure, absent historical data or a custom revert for legacy code", async () => {
	for (const error of [new Error("RPC unavailable"), { code: "CALL_EXCEPTION", data: null }, { code: "CALL_EXCEPTION", data: "0xdeadbeef" }]) {
		let legacyCalled = false
		await assert.rejects(
			partyBWhitelistRole({
				MULTICAST_WHITELIST_ROLE: async () => {
					throw error
				},
				MANAGER_ROLE: async () => {
					legacyCalled = true
					return id("MANAGER_ROLE")
				},
			}),
		)
		assert.equal(legacyCalled, false)
	}
})
