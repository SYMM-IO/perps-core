import { expect } from "chai"

import { DEFAULT_PROTOCOL_CONFIG, loadProtocolConfig, templateConfigMismatches, validateProtocolConfig } from "../../tasks/deploy/protocolConfig.js"

function configCopy(): any {
	return structuredClone(DEFAULT_PROTOCOL_CONFIG)
}

describe("deployment protocol config validation", function () {
	it("accepts the built-in deployment config", function () {
		expect(() => validateProtocolConfig(configCopy(), "test config")).not.to.throw()
	})

	it("rejects unsafe numeric parameter values before deployment", function () {
		const cases: Array<[string, (config: any) => void, string]> = [
			["non-decimal balance limit", config => (config.parameters.balanceLimitPerUser = "10e18"), "balanceLimitPerUser"],
			["zero max withdraw parts", config => (config.parameters.maxWithdrawParts = 0), "maxWithdrawParts"],
			["negative debounce", config => (config.parameters.deallocateDebounceTime = -1), "deallocateDebounceTime"],
			["share above 100%", config => (config.parameters.liquidatorShare = "1000000000000000001"), "liquidatorShare"],
			["malformed force close tuple", config => (config.parameters.forceCloseCooldowns = [300]), "forceCloseCooldowns"],
		]

		for (const [label, mutate, expectedMessage] of cases) {
			const config = configCopy()
			mutate(config)
			expect(() => validateProtocolConfig(config, label)).to.throw(expectedMessage)
		}
	})

	it("rejects malformed template definitions before deployment", function () {
		const cases: Array<[string, (config: any) => void, string]> = [
			["empty template list", config => (config.instantLayerTemplates = []), "instantLayerTemplates"],
			[
				"duplicate template name",
				config => (config.instantLayerTemplates[1].name = config.instantLayerTemplates[0].name),
				"duplicates template name",
			],
			["blank template name", config => (config.instantLayerTemplates[0].name = "  "), "non-empty trimmed string"],
			["mismatched operation arrays", config => config.instantLayerTemplates[0].operations[2].sourceOffsets.push(32), "equal insertionPoints"],
			[
				"self reference",
				config => (config.instantLayerTemplates[0].operations[0] = { insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] }),
				"must reference an earlier operation",
			],
			[
				"forward reference",
				config => (config.instantLayerTemplates[0].operations[1] = { insertionPoints: [0], sourceIndices: [2], sourceOffsets: [0] }),
				"must reference an earlier operation",
			],
			["negative insertion point", config => (config.instantLayerTemplates[0].operations[2].insertionPoints[0] = -1), "must be a safe integer"],
			["invalid instant-open mode", config => (config.instantLayerTemplates[0].instantOpenMode = "true"), "must be a boolean"],
		]

		for (const [, mutate, expected] of cases) {
			const config = configCopy()
			mutate(config)
			expect(() => validateProtocolConfig(config, "test config")).to.throw(expected)
		}
	})

	it("compares the complete on-chain template shape", function () {
		const expected = configCopy().instantLayerTemplates[0]
		const actual = {
			name: expected.name,
			active: true,
			operations: expected.operations.map((operation: any) => ({
				insertionPoints: operation.insertionPoints.map((value: number) => BigInt(value)),
				sourceIndices: operation.sourceIndices.map((value: number) => BigInt(value)),
				sourceOffsets: operation.sourceOffsets.map((value: number) => BigInt(value)),
			})),
		}
		expect(templateConfigMismatches(0, actual, expected, true)).to.deep.equal([])

		actual.operations[2].sourceOffsets[0] = BigInt(32)
		actual.active = false
		const mismatches = templateConfigMismatches(0, actual, expected, false)
		expect(mismatches.some(message => message.includes("sourceOffsets"))).to.equal(true)
		expect(mismatches.some(message => message.includes("active"))).to.equal(true)
		expect(mismatches.some(message => message.includes("instantOpenMode"))).to.equal(true)
	})

	it("loads the exact four-template Arbitrum deployment profile including zero debounce", function () {
		const config = loadProtocolConfig(42161)
		expect(config.parameters.deallocateDebounceTime).to.equal(0)
		expect(config.instantLayerTemplates.map(template => template.name)).to.deep.equal([
			"InstantOpen",
			"InstantClose",
			"InstantCloseWithAllocation",
			"InstantOpenNoMargin",
		])
		expect(config.instantLayerTemplates[3].operations[1]).to.deep.equal({ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] })
	})
})
