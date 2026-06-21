import { expect } from "chai"

import { quoteMigrationSkipReason, quoteOpenAmount, quoteRequiresMigration } from "../../scripts/upgrade/utils/migrationQuoteRules.js"

describe("Migration quote rules", function () {
	it("requires migration for pending/locked/cancel-pending quotes", function () {
		for (const quoteStatus of [0, 1, 2]) {
			expect(quoteRequiresMigration({ quoteStatus, partyA: "0x0000000000000000000000000000000000000001" })).to.equal(true)
		}
	})

	it("requires migration for active positions with non-zero open amount", function () {
		for (const quoteStatus of [4, 5, 6]) {
			const quote = { quoteStatus, partyA: "0x0000000000000000000000000000000000000001", quantity: "100", closedAmount: "40" }
			expect(quoteOpenAmount(quote)).to.equal(60n)
			expect(quoteRequiresMigration(quote)).to.equal(true)
		}
	})

	it("skips active positions with zero open amount", function () {
		for (const quoteStatus of [4, 5, 6]) {
			const quote = { quoteStatus, partyA: "0x0000000000000000000000000000000000000001", quantity: "100", closedAmount: "100" }
			expect(quoteOpenAmount(quote)).to.equal(0n)
			expect(quoteRequiresMigration(quote)).to.equal(false)
			expect(quoteMigrationSkipReason(quote)).to.contain("openAmount=0")
		}
	})

	it("skips terminal or missing quotes", function () {
		expect(quoteRequiresMigration({ quoteStatus: 7, partyA: "0x0000000000000000000000000000000000000001" })).to.equal(false)
		expect(quoteRequiresMigration({ quoteStatus: 0, partyA: "0x0000000000000000000000000000000000000000" })).to.equal(false)
	})
})
