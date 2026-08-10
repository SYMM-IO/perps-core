import { expect } from "chai"

import {
	CORRECT_SETTLEMENT_QUOTE_ID_OFFSET,
	SETTLEMENT_TEMPLATE_NAMES,
	assertSettlementTemplateRepairComplete,
	buildSettlementTransactionOverrides,
	buildSettlementTemplateRepairPlan,
	type InstantLayerTemplateOperation,
	type InstantLayerTemplateSnapshot,
	type SettlementTemplateRepairAction,
} from "../../tasks/deploy/instantLayerSettlementTemplates.js"

function legacyTemplates(instantOpenMode = false): InstantLayerTemplateSnapshot[] {
	return SETTLEMENT_TEMPLATE_NAMES.map((name, index) => ({
		id: BigInt(index + 8),
		name,
		active: true,
		instantOpenMode,
		operations: [
			{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
			{ insertionPoints: [32n + BigInt(index)], sourceIndices: [0n], sourceOffsets: [0n] },
			{ insertionPoints: [448n], sourceIndices: [index < 2 ? 1n : 0n], sourceOffsets: [0n] },
		],
	}))
}

function cloneOperations(operations: InstantLayerTemplateOperation[]): InstantLayerTemplateOperation[] {
	return operations.map(operation => ({
		insertionPoints: [...operation.insertionPoints],
		sourceIndices: [...operation.sourceIndices],
		sourceOffsets: [...operation.sourceOffsets],
	}))
}

function applyPlan(templates: InstantLayerTemplateSnapshot[], actions: SettlementTemplateRepairAction[]): InstantLayerTemplateSnapshot[] {
	const result = templates.map(template => ({ ...template, operations: cloneOperations(template.operations) }))
	for (const action of actions) {
		if (action.kind === "addTemplate") {
			result.push({
				id: action.templateId,
				name: action.name,
				active: true,
				instantOpenMode: false,
				operations: cloneOperations(action.operations),
			})
		} else if (action.kind === "setTemplateInstantOpenMode") {
			const template = result.find(candidate => candidate.id === action.templateId)
			if (!template) throw new Error(`Missing template ${action.templateId}`)
			template.instantOpenMode = action.mode
		} else {
			const template = result.find(candidate => candidate.id === action.templateId)
			if (!template) throw new Error(`Missing template ${action.templateId}`)
			template.active = action.active
		}
	}
	return result
}

describe("InstantLayer settlement-template repair planning", function () {
	it("builds complete locally-signed transaction fields with a 20 percent gas buffer", function () {
		expect(
			buildSettlementTransactionOverrides(100_001n, {
				gasPrice: 9n,
				maxFeePerGas: 7n,
				maxPriorityFeePerGas: 2n,
			}),
		).to.deep.equal({ gasLimit: 120_002n, maxFeePerGas: 7n, maxPriorityFeePerGas: 2n })
		expect(
			buildSettlementTransactionOverrides(50_000n, {
				gasPrice: 9n,
				maxFeePerGas: null,
				maxPriorityFeePerGas: null,
			}),
		).to.deep.equal({ gasLimit: 60_000n, gasPrice: 9n })
		expect(() =>
			buildSettlementTransactionOverrides(50_000n, {
				gasPrice: null,
				maxFeePerGas: null,
				maxPriorityFeePerGas: null,
			}),
		).to.throw("usable transaction fee data")
	})

	it("builds the exact eight-call live repair with all additions before any deactivation", function () {
		const before = legacyTemplates()
		const plan = buildSettlementTemplateRepairPlan(before)

		expect(plan.repaired).to.equal(false)
		expect(plan.actions.map(action => action.kind)).to.deep.equal([
			"addTemplate",
			"addTemplate",
			"addTemplate",
			"addTemplate",
			"setTemplateActive",
			"setTemplateActive",
			"setTemplateActive",
			"setTemplateActive",
		])
		expect(plan.actions.filter(action => action.kind === "addTemplate").map(action => action.templateId)).to.deep.equal([12n, 13n, 14n, 15n])
		for (const action of plan.actions.filter(action => action.kind === "addTemplate")) {
			expect(action.operations.at(-1)?.insertionPoints).to.deep.equal([CORRECT_SETTLEMENT_QUOTE_ID_OFFSET])
		}
		expect(plan.actions.slice(-4).map(action => (action.kind === "setTemplateActive" ? action.templateId : -1n))).to.deep.equal([8n, 9n, 10n, 11n])

		const after = applyPlan(before, plan.actions)
		expect(buildSettlementTemplateRepairPlan(after).actions).to.deep.equal([])
		expect(() => assertSettlementTemplateRepairComplete(after)).not.to.throw()
	})

	it("restores instant-open mode when a source template uses it", function () {
		const plan = buildSettlementTemplateRepairPlan(legacyTemplates(true))
		expect(plan.actions.filter(action => action.kind === "setTemplateInstantOpenMode")).to.have.length(4)
		expect(plan.actions.filter(action => action.kind === "setTemplateInstantOpenMode").every(action => action.mode)).to.equal(true)
	})

	it("recovers an inactive corrected copy instead of creating a duplicate", function () {
		const before = legacyTemplates(true)
		const source = before[0]
		const operations = cloneOperations(source.operations)
		operations.at(-1)!.insertionPoints[0] = CORRECT_SETTLEMENT_QUOTE_ID_OFFSET
		before.push({ ...source, id: 12n, active: false, instantOpenMode: false, operations })

		const plan = buildSettlementTemplateRepairPlan(before)
		const firstTemplateActions = plan.actions.filter(action => action.name === source.name)
		expect(firstTemplateActions.map(action => action.kind)).to.deep.equal(["setTemplateInstantOpenMode", "setTemplateActive", "setTemplateActive"])
		expect(firstTemplateActions.every(action => action.kind !== "addTemplate")).to.equal(true)
	})

	it("refuses to infer a repair from an unrecognized settlement injection layout", function () {
		const templates = legacyTemplates()
		templates[2].operations.at(-1)!.insertionPoints[0] = 512n
		expect(() => buildSettlementTemplateRepairPlan(templates)).to.throw("unrecognized operation wiring")
	})
})
