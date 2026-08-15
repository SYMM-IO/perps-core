import { expect } from "chai"

import { buildSymbolCopyPlan } from "../../scripts/utils/copySymbolsPlan.js"

describe("copySymbols planning", function () {
	it("deduplicates mixed-case and padded names without losing the selected id", function () {
		const result = buildSymbolCopyPlan([
			{ symbolId: 7n, name: " BTCUSD ", isValid: true },
			{ symbolId: 11n, name: "btcusd", isValid: true },
			{ symbolId: 15n, name: "BtcUsd", isValid: false },
		])

		expect(result.uniqueNameCount).to.equal(1)
		expect(result.kept.map(symbol => symbol.symbolId)).to.deep.equal([11n])
		expect(result.duplicateGroups).to.have.length(1)
		expect(result.duplicateGroups[0]).to.include({ name: "btcusd", pickedId: 11n })
	})

	it("drops normalized names whose entries are all invalid", function () {
		const result = buildSymbolCopyPlan([
			{ symbolId: 1n, name: "ETHUSD", isValid: false },
			{ symbolId: 2n, name: " ethusd ", isValid: false },
		])

		expect(result.kept).to.deep.equal([])
		expect(result.droppedNames).to.deep.equal(["ethusd"])
	})

	it("rejects an empty normalized source name", function () {
		expect(() => buildSymbolCopyPlan([{ symbolId: 1n, name: "   ", isValid: true }])).to.throw("empty normalized name")
	})
})
