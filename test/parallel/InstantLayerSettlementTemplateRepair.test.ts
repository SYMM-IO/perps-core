import { expect } from "chai"
import { Interface } from "ethers"

import {
	SETTLEMENT_CURRENT_PRICE_OFFSET,
	SETTLEMENT_QUOTE_ID_OFFSET,
	SETTLEMENT_TEMPLATE_NAMES,
	assertSettlementTemplateRecreationComplete,
	buildSettlementTransactionOverrides,
	buildSettlementTemplateRecreationPlan,
	type InstantLayerTemplateOperation,
	type InstantLayerTemplateSnapshot,
	type SettlementTemplateRecreationAction,
} from "../../tasks/deploy/instantLayerSettlementTemplates.js"

function sourceTemplates(active = true, instantOpenMode = false): InstantLayerTemplateSnapshot[] {
	return SETTLEMENT_TEMPLATE_NAMES.map((name, index) => ({
		id: BigInt(index + 8),
		name,
		active,
		instantOpenMode,
		operations: [
			{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
			{ insertionPoints: [32n + BigInt(index)], sourceIndices: [0n], sourceOffsets: [0n] },
			{ insertionPoints: [SETTLEMENT_QUOTE_ID_OFFSET], sourceIndices: [index < 2 ? 1n : 0n], sourceOffsets: [0n] },
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

function applyPlan(templates: InstantLayerTemplateSnapshot[], actions: SettlementTemplateRecreationAction[]): InstantLayerTemplateSnapshot[] {
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

function wordAt(calldata: string, byteOffsetAfterSelector: bigint): bigint {
	const start = 10 + Number(byteOffsetAfterSelector) * 2
	return BigInt(`0x${calldata.slice(start, start + 64)}`)
}

describe("InstantLayer settlement-template recreation planning", function () {
	it("pins quoteId to byte offset 448 and currentPrice to 480 in the deployed settleUpnl ABI", function () {
		const settleUpnl = new Interface([
			"function settleUpnl((bytes reqId,uint256 timestamp,(uint256 quoteId,uint256 currentPrice,uint8 partyBUpnlIndex)[] quotesSettlementsData,int256[] upnlPartyBs,int256 upnlPartyA,bytes gatewaySignature,(uint256 signature,address owner,address nonce) sigs) settleSig,uint256[] updatedPrices,address partyA)",
		])
		const quoteId = 0x1111222233334444n
		const currentPrice = 0x5555666677778888n
		const calldata = settleUpnl.encodeFunctionData("settleUpnl", [
			{
				reqId: "0x",
				timestamp: 1n,
				quotesSettlementsData: [{ quoteId, currentPrice, partyBUpnlIndex: 0 }],
				upnlPartyBs: [0n],
				upnlPartyA: 0n,
				gatewaySignature: "0x",
				sigs: { signature: 0n, owner: "0x0000000000000000000000000000000000000001", nonce: "0x0000000000000000000000000000000000000002" },
			},
			[currentPrice],
			"0x0000000000000000000000000000000000000003",
		])

		expect(wordAt(calldata, SETTLEMENT_QUOTE_ID_OFFSET)).to.equal(quoteId)
		expect(wordAt(calldata, SETTLEMENT_CURRENT_PRICE_OFFSET)).to.equal(currentPrice)
	})

	it("builds four exact additions before deactivating the four originals", function () {
		const before = sourceTemplates()
		const plan = buildSettlementTemplateRecreationPlan(before)

		expect(plan.recreated).to.equal(false)
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
		for (const [index, action] of plan.actions.filter(action => action.kind === "addTemplate").entries()) {
			expect(action.operations).to.deep.equal(before[index].operations)
			expect(action.operations.at(-1)?.insertionPoints).to.deep.equal([SETTLEMENT_QUOTE_ID_OFFSET])
		}
		expect(plan.actions.slice(-4).map(action => (action.kind === "setTemplateActive" ? action.templateId : -1n))).to.deep.equal([8n, 9n, 10n, 11n])

		const after = applyPlan(before, plan.actions)
		expect(buildSettlementTemplateRecreationPlan(after).actions).to.deep.equal([])
		expect(() => assertSettlementTemplateRecreationComplete(after)).not.to.throw()
	})

	it("restores instant-open mode when a source template uses it", function () {
		const plan = buildSettlementTemplateRecreationPlan(sourceTemplates(true, true))
		expect(plan.actions.filter(action => action.kind === "setTemplateInstantOpenMode")).to.have.length(4)
		expect(plan.actions.filter(action => action.kind === "setTemplateInstantOpenMode").every(action => action.mode)).to.equal(true)
	})

	it("discovers the earliest exact source by name instead of assuming fixed template IDs", function () {
		const templates = sourceTemplates().map(template => ({ ...template, id: template.id + 32n }))
		const plan = buildSettlementTemplateRecreationPlan(templates)
		expect(plan.templates.map(template => template.sourceId)).to.deep.equal([40n, 41n, 42n, 43n])
		expect(plan.actions.filter(action => action.kind === "addTemplate").map(action => action.templateId)).to.deep.equal([44n, 45n, 46n, 47n])
	})

	it("reactivates an inactive exact replacement instead of creating a duplicate", function () {
		const before = sourceTemplates(false, true)
		const source = before[0]
		before.push({ ...source, id: 12n, active: false, instantOpenMode: false, operations: cloneOperations(source.operations) })

		const plan = buildSettlementTemplateRecreationPlan(before)
		const firstTemplateActions = plan.actions.filter(action => action.name === source.name)
		expect(firstTemplateActions.map(action => action.kind)).to.deep.equal(["setTemplateInstantOpenMode", "setTemplateActive"])
		expect(firstTemplateActions.every(action => action.kind !== "addTemplate")).to.equal(true)
	})

	it("replaces and retires a known unsafe copy that injects quote ID at currentPrice offset 480", function () {
		const before = sourceTemplates(false)
		const unsafe = { ...before[0], id: 12n, active: true, operations: cloneOperations(before[0].operations) }
		unsafe.operations.at(-1)!.insertionPoints[0] = SETTLEMENT_CURRENT_PRICE_OFFSET
		before.push(unsafe)

		const plan = buildSettlementTemplateRecreationPlan(before)
		const firstTemplateActions = plan.actions.filter(action => action.name === unsafe.name)
		expect(firstTemplateActions.map(action => action.kind)).to.deep.equal(["addTemplate", "setTemplateActive"])
		expect(firstTemplateActions[0].kind === "addTemplate" && firstTemplateActions[0].operations.at(-1)?.insertionPoints).to.deep.equal([
			SETTLEMENT_QUOTE_ID_OFFSET,
		])
		expect(firstTemplateActions[1].kind === "setTemplateActive" && firstTemplateActions[1].templateId).to.equal(12n)
	})

	it("refuses to infer safety from an unrecognized active same-name layout", function () {
		const templates = sourceTemplates(false)
		const unknown = { ...templates[2], id: 12n, active: true, operations: cloneOperations(templates[2].operations) }
		unknown.operations.at(-1)!.insertionPoints[0] = 512n
		templates.push(unknown)
		expect(() => buildSettlementTemplateRecreationPlan(templates)).to.throw("active unrecognized template")
	})

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
})
