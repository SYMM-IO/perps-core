import { expect } from "chai"

import { assertEmptySymbolAdjustment, coreQuoteScanIds } from "../../../tasks/deploy/coreUpgradeSnapshot.js"

describe("Current Core upgrade safety gates (preflight)", function () {
	it("includes the last assigned quote ID, accepts empty history and refuses a truncated scan", () => {
		expect(coreQuoteScanIds(0n, 10000)).to.deep.equal([])
		expect(coreQuoteScanIds(3n, 3)).to.deep.equal([1, 2, 3])
		expect(coreQuoteScanIds(5290n, 10000).at(-1)).to.equal(5290)
		for (const value of [-1, 4, Number.MAX_SAFE_INTEGER + 1, 1.5]) expect(() => coreQuoteScanIds(value, 3)).to.throw(/no partial snapshot/)
	})

	it("refuses populated or unknown legacy adjustment layouts and accepts only the expected zero tuple", () => {
		for (const upgraded of [false, true]) {
			const words = upgraded ? 17 : 15,
				zero = "0x" + "0".repeat(words * 64)
			expect(() => assertEmptySymbolAdjustment(zero, upgraded)).not.to.throw()
			for (let i = 0; i < words; i++) {
				const populated = zero.slice(0, 2 + i * 64) + "1" + zero.slice(3 + i * 64)
				expect(() => assertEmptySymbolAdjustment(populated, upgraded)).to.throw(/storage migration/)
			}
			expect(() => assertEmptySymbolAdjustment(zero, !upgraded)).to.throw(/layout/)
		}
		expect(() => assertEmptySymbolAdjustment("0x", false)).to.throw()
	})
})
