import { expect } from "chai"
import { readFileSync } from "node:fs"

import { shouldBehaveLikeInstantLayer } from "../InstantLayer.behavior.js"

describe("InstantLayer", async function () {
	shouldBehaveLikeInstantLayer()
})

describe("InstantLayer bytecode budget", function () {
	it("keeps the contract deployable under the EIP-170 size limit", function () {
		const artifact = JSON.parse(readFileSync("artifacts/contracts/instantLayer/InstantLayer.sol/InstantLayer.json", "utf8"))
		const deployedBytes = (artifact.deployedBytecode.length - 2) / 2
		expect(deployedBytes).to.be.lessThanOrEqual(24576)
	})
})
