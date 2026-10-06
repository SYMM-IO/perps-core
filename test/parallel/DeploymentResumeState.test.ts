import { expect } from "chai"

import { assertCheckpointContractsHaveCode, ensureBooleanState, resolveAffiliateRegistrationResumeAction } from "../../tasks/deploy/checkpoint.js"
import { resolveTemplateAddResumeAction, type TemplateConfig } from "../../tasks/deploy/protocolConfig.js"

describe("state-driven deployment resume", function () {
	it("does not resubmit a non-idempotent registration that already landed", async function () {
		let submitted = 0
		const result = await ensureBooleanState(
			"PartyB registration",
			async () => true,
			async () => {
				submitted++
			},
		)

		expect(result).to.equal("present")
		expect(submitted).to.equal(0)
	})

	it("submits a missing registration once and verifies the resulting state", async function () {
		let registered = false
		let submitted = 0
		const result = await ensureBooleanState(
			"PartyB registration",
			async () => registered,
			async () => {
				submitted++
				registered = true
			},
		)

		expect(result).to.equal("executed")
		expect(submitted).to.equal(1)
	})

	it("does not resubmit an affiliate request that already reached PENDING", function () {
		expect(resolveAffiliateRegistrationResumeAction(1n, false, false)).to.equal("approve")
	})

	it("does not resubmit affiliate approval that already reached ACTIVE", function () {
		expect(resolveAffiliateRegistrationResumeAction(2n, true, false)).to.equal("complete")
	})

	it("rejects contradictory or paused affiliate resume state", function () {
		expect(() => resolveAffiliateRegistrationResumeAction(0n, true, false)).to.throw("state NONE")
		expect(() => resolveAffiliateRegistrationResumeAction(1n, true, true)).to.throw("still PENDING")
		expect(() => resolveAffiliateRegistrationResumeAction(3n, true, true)).to.throw("PAUSED")
	})

	it("allows a PENDING deterministic AccountManager address without runtime code", async function () {
		let codeReads = 0
		await assertCheckpointContractsHaveCode(
			{
				contracts: { accountManager: { address: "0x0000000000000000000000000000000000000001", timestamp: new Date().toISOString() } },
			} as any,
			async () => {
				codeReads++
				return "0x"
			},
		)
		expect(codeReads).to.equal(0)
	})

	it("recovers an exact template after a successful timed-out add without adding again", function () {
		const expected: TemplateConfig = {
			name: "InstantOpen",
			operations: [{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }],
		}
		const onChain = {
			name: "InstantOpen",
			active: true,
			operations: [{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }],
		}

		expect(resolveTemplateAddResumeAction(0, 1n, onChain, expected, false)).to.equal("present")
		expect(resolveTemplateAddResumeAction(0, 0n, undefined, expected, false)).to.equal("add")
		expect(() => resolveTemplateAddResumeAction(0, 1n, { ...onChain, name: "Unexpected" }, expected, false)).to.throw(
			"unexpected InstantLayer template",
		)
	})
})
