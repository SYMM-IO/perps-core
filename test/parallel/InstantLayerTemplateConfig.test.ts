import { expect } from "chai"
import fs from "fs"

import { buildTemplateTransactions } from "../../scripts/upgrade/utils/peripheralHelpers.js"

const SAMPLE_TEMPLATES_CONFIG = "scripts/upgrade/config/samples/instantLayerTemplates.sample.json"
const INSTANT_LAYER_ADDRESS = "0x0000000000000000000000000000000000000001"

describe("InstantLayer template config", function () {
	it("registers the custom VA templates in deploy:system setup", function () {
		const deployAll = fs.readFileSync("tasks/deploy/deployAll.ts", "utf-8")

		expect(deployAll).to.include('addTemplate("InstantOpenWithCustomVA"')
		expect(deployAll).to.include('addTemplate("InstantCloseWithParentAllocation"')
	})

	it("includes the custom VA templates in the normal template batch", function () {
		const txs = buildTemplateTransactions(INSTANT_LAYER_ADDRESS, SAMPLE_TEMPLATES_CONFIG)
		const templates = txs.map(tx => ({ name: tx.args[0], operations: tx.args[1] }))

		expect(templates.map(template => template.name)).to.deep.equal([
			"InstantOpen",
			"InstantClose",
			"InstantCloseWithAllocation",
			"InstantOpenWithCustomVA",
			"InstantCloseWithParentAllocation",
		])
		expect(templates.find(template => template.name === "InstantOpenWithCustomVA")?.operations).to.deep.equal([
			{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
			{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] },
			{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
			{ insertionPoints: [0], sourceIndices: [2], sourceOffsets: [0] },
			{ insertionPoints: [0], sourceIndices: [2], sourceOffsets: [0] },
		])
		expect(templates.find(template => template.name === "InstantCloseWithParentAllocation")?.operations).to.deep.equal([
			{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
			{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
			{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
			{ insertionPoints: [0], sourceIndices: [2], sourceOffsets: [0] },
		])
	})
})
