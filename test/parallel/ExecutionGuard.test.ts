import { expect } from "chai"

import { exactBooleanEnv, requireExecutionConfirmation, requireSafeProposalConfirmation } from "../../scripts/upgrade/utils/executionGuard.js"

const GUARDED_ENV = ["EXECUTE", "DRY_RUN", "CONFIRM_CHAIN_ID", "SUBMIT_SAFE_PROPOSAL", "SAFE_PROPOSAL_SUBMIT", "CONFIRM_SAFE_ADDRESS"] as const

describe("standalone execution guards", function () {
	const original = new Map<string, string | undefined>()

	beforeEach(function () {
		for (const key of GUARDED_ENV) {
			original.set(key, process.env[key])
			delete process.env[key]
		}
	})

	afterEach(function () {
		for (const key of GUARDED_ENV) {
			const value = original.get(key)
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		original.clear()
	})

	it("is plan-only by default and rejects loose booleans", function () {
		expect(requireExecutionConfirmation(42161n)).to.equal(false)
		process.env.EXECUTE = "1"
		expect(() => exactBooleanEnv("EXECUTE")).to.throw("exactly true or false")
	})

	it("binds direct execution to the connected chain", function () {
		process.env.EXECUTE = "true"
		expect(() => requireExecutionConfirmation(42161n)).to.throw("CONFIRM_CHAIN_ID=42161")
		process.env.CONFIRM_CHAIN_ID = "8453"
		expect(() => requireExecutionConfirmation(42161n)).to.throw("CONFIRM_CHAIN_ID=42161")
		process.env.CONFIRM_CHAIN_ID = "42161"
		expect(requireExecutionConfirmation(42161n)).to.equal(true)
	})

	it("requires an explicit chain and Safe binding for Safe-service POSTs", function () {
		const safe = "0x5146C35725d9b8F11A84ebD4a3abe9845698Ada9"
		expect(requireSafeProposalConfirmation(8453n, safe)).to.equal(false)

		process.env.SUBMIT_SAFE_PROPOSAL = "true"
		expect(() => requireSafeProposalConfirmation(8453n, safe)).to.throw("CONFIRM_CHAIN_ID=8453")
		process.env.CONFIRM_CHAIN_ID = "8453"
		expect(() => requireSafeProposalConfirmation(8453n, safe)).to.throw(`CONFIRM_SAFE_ADDRESS=${safe}`)
		process.env.CONFIRM_SAFE_ADDRESS = safe.toLowerCase()
		expect(requireSafeProposalConfirmation(8453n, safe)).to.equal(true)
	})

	it("rejects conflicting Safe submission aliases", function () {
		process.env.SUBMIT_SAFE_PROPOSAL = "true"
		process.env.SAFE_PROPOSAL_SUBMIT = "false"
		expect(() => requireSafeProposalConfirmation(8453n, "0x5146C35725d9b8F11A84ebD4a3abe9845698Ada9")).to.throw("conflict")
	})
})
