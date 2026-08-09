import { expect } from "chai"

import { DEFAULT_PROTOCOL_CONFIG } from "../../tasks/deploy/protocolConfig.js"

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
