import { expect } from "chai"

import { buildTemplateTransactions } from "../../scripts/upgrade/utils/peripheralHelpers.js"
import { DEFAULT_PROTOCOL_CONFIG } from "../../tasks/deploy/protocolConfig.js"

const SAMPLE_TEMPLATES_CONFIG = "scripts/upgrade/config/samples/instantLayerTemplates.sample.json"
const INSTANT_LAYER_ADDRESS = "0x0000000000000000000000000000000000000001"

describe("InstantLayer template config", function () {
	// deploy:system no longer names templates in code — setupInstantLayerTemplates iterates
	// protocolConfig.instantLayerTemplates and calls addTemplate for each entry. A chain with
	// no tasks/config/protocol-<chainId>.json gets DEFAULT_PROTOCOL_CONFIG, so that is what
	// decides which templates a fresh deployment ends up with.
	it("registers the custom VA templates in deploy:system setup", function () {
		const templates = DEFAULT_PROTOCOL_CONFIG.instantLayerTemplates

		// Order is the contract: ids are assigned in creation order and hedgers address
		// templates by id, so a reorder silently repoints every hedger integration.
		expect(templates.map(template => template.name)).to.deep.equal([
			"InstantOpen",
			"InstantClose",
			"InstantCloseWithAllocation",
			"InstantOpenWithCustomVA",
			"InstantCloseWithParentAllocation",
			"InstantOpenCompact",
		])
		expect(templates.find(template => template.name === "InstantOpenCompact")?.operations).to.deep.equal([
			{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
			{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [128] },
		])
		expect(templates.find(template => template.name === "InstantOpenCompact")?.instantOpenMode).to.equal(true)
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
