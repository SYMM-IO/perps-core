import type { BaseContract } from "ethers"

export const LEGACY_SETTLEMENT_QUOTE_ID_OFFSET = 448n
export const CORRECT_SETTLEMENT_QUOTE_ID_OFFSET = 480n

export const SETTLEMENT_TEMPLATE_NAMES = Object.freeze([
	"InstantOpenAndSettleUpnl",
	"InstantOpenAndSetFundingFeeAndSettleUpnl",
	"InstantOpenNoMarginAndSettleUpnl",
	"InstantOpenNoMarginAndSetFundingFeeAndSettleUpnl",
])

export interface InstantLayerTemplateOperation {
	insertionPoints: bigint[]
	sourceIndices: bigint[]
	sourceOffsets: bigint[]
}

export interface InstantLayerTemplateSnapshot {
	id: bigint
	name: string
	active: boolean
	instantOpenMode: boolean
	operations: InstantLayerTemplateOperation[]
}

export type SettlementTemplateRepairAction =
	| {
			kind: "addTemplate"
			templateId: bigint
			name: string
			operations: InstantLayerTemplateOperation[]
			description: string
	  }
	| {
			kind: "setTemplateInstantOpenMode"
			templateId: bigint
			mode: boolean
			name: string
			description: string
	  }
	| {
			kind: "setTemplateActive"
			templateId: bigint
			active: boolean
			name: string
			description: string
	  }

export interface SettlementTemplateRepairPlan {
	actions: SettlementTemplateRepairAction[]
	templates: Array<{
		name: string
		legacyIds: bigint[]
		activeLegacyIds: bigint[]
		correctedIds: bigint[]
		activeCorrectedIds: bigint[]
		instantOpenMode: boolean
	}>
	repaired: boolean
}

export interface SettlementTransactionFeeData {
	gasPrice: bigint | null
	maxFeePerGas: bigint | null
	maxPriorityFeePerGas: bigint | null
}

export interface SettlementTransactionOverrides {
	gasLimit: bigint
	gasPrice?: bigint
	maxFeePerGas?: bigint
	maxPriorityFeePerGas?: bigint
}

export function buildSettlementTransactionOverrides(estimatedGas: bigint, feeData: SettlementTransactionFeeData): SettlementTransactionOverrides {
	if (estimatedGas <= 0n) throw new Error(`Estimated transaction gas must be positive; received ${estimatedGas}`)
	const gasLimit = (estimatedGas * 120n + 99n) / 100n
	if (feeData.maxFeePerGas !== null && feeData.maxPriorityFeePerGas !== null) {
		return { gasLimit, maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas }
	}
	if (feeData.gasPrice !== null) return { gasLimit, gasPrice: feeData.gasPrice }
	throw new Error("RPC returned no usable transaction fee data for local signing")
}

function uintArray(value: any): bigint[] {
	return Array.from(value || [], entry => BigInt(entry as string | number | bigint | boolean))
}

function normalizeOperation(value: any): InstantLayerTemplateOperation {
	return {
		insertionPoints: uintArray(value?.insertionPoints ?? value?.[0]),
		sourceIndices: uintArray(value?.sourceIndices ?? value?.[1]),
		sourceOffsets: uintArray(value?.sourceOffsets ?? value?.[2]),
	}
}

function cloneOperations(operations: InstantLayerTemplateOperation[]): InstantLayerTemplateOperation[] {
	return operations.map(operation => ({
		insertionPoints: [...operation.insertionPoints],
		sourceIndices: [...operation.sourceIndices],
		sourceOffsets: [...operation.sourceOffsets],
	}))
}

function offsetKind(template: InstantLayerTemplateSnapshot): "legacy" | "corrected" | "unknown" {
	const operation = template.operations.at(-1)
	if (
		!operation ||
		operation.insertionPoints.length !== 1 ||
		operation.sourceIndices.length !== 1 ||
		operation.sourceOffsets.length !== 1 ||
		operation.sourceOffsets[0] !== 0n
	) {
		return "unknown"
	}
	if (operation.insertionPoints[0] === LEGACY_SETTLEMENT_QUOTE_ID_OFFSET) return "legacy"
	if (operation.insertionPoints[0] === CORRECT_SETTLEMENT_QUOTE_ID_OFFSET) return "corrected"
	return "unknown"
}

function correctedOperations(template: InstantLayerTemplateSnapshot): InstantLayerTemplateOperation[] {
	const operations = cloneOperations(template.operations)
	const settlement = operations.at(-1)
	if (!settlement || offsetKind(template) === "unknown") {
		throw new Error(`Template ${template.id} (${template.name}) does not have a recognized settleUpnl result-injection operation`)
	}
	settlement.insertionPoints[0] = CORRECT_SETTLEMENT_QUOTE_ID_OFFSET
	return operations
}

function operationsKey(operations: InstantLayerTemplateOperation[]): string {
	return JSON.stringify(
		operations.map(operation => ({
			insertionPoints: operation.insertionPoints.map(String),
			sourceIndices: operation.sourceIndices.map(String),
			sourceOffsets: operation.sourceOffsets.map(String),
		})),
	)
}

export function normalizeInstantLayerTemplate(id: bigint | number, value: any): InstantLayerTemplateSnapshot {
	return {
		id: BigInt(id),
		name: String(value?.name ?? value?.[0] ?? ""),
		operations: Array.from(value?.operations ?? value?.[1] ?? [], normalizeOperation),
		active: Boolean(value?.active ?? value?.[2]),
		instantOpenMode: Boolean(value?.instantOpenMode),
	}
}

export async function readInstantLayerTemplates(instantLayer: BaseContract): Promise<InstantLayerTemplateSnapshot[]> {
	const nextTemplateId = BigInt(await (instantLayer as any).getNextTemplateId())
	const templates: InstantLayerTemplateSnapshot[] = []
	for (let id = 0n; id < nextTemplateId; id++) {
		const template = normalizeInstantLayerTemplate(id, await (instantLayer as any).getTemplate(id))
		template.instantOpenMode = Boolean(await (instantLayer as any).templateInstantOpenMode(id))
		templates.push(template)
	}
	return templates
}

export function buildSettlementTemplateRepairPlan(
	templates: InstantLayerTemplateSnapshot[],
	{ deactivateLegacy = true }: { deactivateLegacy?: boolean } = {},
): SettlementTemplateRepairPlan {
	const preparations: SettlementTemplateRepairAction[] = []
	const deactivations: SettlementTemplateRepairAction[] = []
	const summaries: SettlementTemplateRepairPlan["templates"] = []
	let nextTemplateId = templates.reduce((next, template) => (template.id >= next ? template.id + 1n : next), 0n)

	for (const name of SETTLEMENT_TEMPLATE_NAMES) {
		const matching = templates.filter(template => template.name === name)
		if (matching.length === 0) throw new Error(`Required settlement template ${JSON.stringify(name)} is missing`)

		const unknown = matching.filter(template => offsetKind(template) === "unknown")
		if (unknown.length > 0) {
			throw new Error(
				`${name} has unrecognized operation wiring in template id(s) ${unknown.map(template => template.id).join(", ")}; refusing to infer a repair`,
			)
		}

		const canonicalKeys = new Set(matching.map(template => operationsKey(correctedOperations(template))))
		if (canonicalKeys.size !== 1) {
			throw new Error(`${name} has ${canonicalKeys.size} distinct operation layouts after offset correction; refusing to choose one`)
		}

		const legacy = matching.filter(template => offsetKind(template) === "legacy")
		const corrected = matching.filter(template => offsetKind(template) === "corrected")
		const activeLegacy = legacy.filter(template => template.active)
		const activeCorrected = corrected.filter(template => template.active)
		const canonicalSource = [...legacy, ...corrected].sort((a, b) => Number(a.id - b.id))[0]
		const expectedInstantOpenMode = canonicalSource.instantOpenMode

		if (activeCorrected.length === 0) {
			const inactiveCorrected = corrected.filter(template => !template.active).sort((a, b) => Number(a.id - b.id))[0]
			if (inactiveCorrected) {
				if (inactiveCorrected.instantOpenMode !== expectedInstantOpenMode) {
					preparations.push({
						kind: "setTemplateInstantOpenMode",
						templateId: inactiveCorrected.id,
						mode: expectedInstantOpenMode,
						name,
						description: `Restore instant-open mode ${expectedInstantOpenMode} on corrected ${name} template ${inactiveCorrected.id}`,
					})
				}
				preparations.push({
					kind: "setTemplateActive",
					templateId: inactiveCorrected.id,
					active: true,
					name,
					description: `Reactivate corrected ${name} template ${inactiveCorrected.id}`,
				})
			} else {
				const replacementId = nextTemplateId++
				preparations.push({
					kind: "addTemplate",
					templateId: replacementId,
					name,
					operations: correctedOperations(canonicalSource),
					description: `Add corrected ${name} template ${replacementId} with settleUpnl quote-id offset 480`,
				})
				if (expectedInstantOpenMode) {
					preparations.push({
						kind: "setTemplateInstantOpenMode",
						templateId: replacementId,
						mode: true,
						name,
						description: `Restore instant-open mode true on corrected ${name} template ${replacementId}`,
					})
				}
			}
		} else {
			for (const template of activeCorrected.filter(template => template.instantOpenMode !== expectedInstantOpenMode)) {
				preparations.push({
					kind: "setTemplateInstantOpenMode",
					templateId: template.id,
					mode: expectedInstantOpenMode,
					name,
					description: `Restore instant-open mode ${expectedInstantOpenMode} on corrected ${name} template ${template.id}`,
				})
			}
		}

		if (deactivateLegacy) {
			for (const template of activeLegacy.sort((a, b) => Number(a.id - b.id))) {
				deactivations.push({
					kind: "setTemplateActive",
					templateId: template.id,
					active: false,
					name,
					description: `Deactivate broken ${name} template ${template.id} with settleUpnl offset 448`,
				})
			}
		}

		summaries.push({
			name,
			legacyIds: legacy.map(template => template.id),
			activeLegacyIds: activeLegacy.map(template => template.id),
			correctedIds: corrected.map(template => template.id),
			activeCorrectedIds: activeCorrected.map(template => template.id),
			instantOpenMode: expectedInstantOpenMode,
		})
	}

	const actions = [...preparations, ...deactivations]
	return { actions, templates: summaries, repaired: actions.length === 0 }
}

export function assertSettlementTemplateRepairComplete(templates: InstantLayerTemplateSnapshot[]): void {
	const plan = buildSettlementTemplateRepairPlan(templates)
	if (!plan.repaired) {
		throw new Error(`Settlement template repair is incomplete; ${plan.actions.length} action(s) are still required`)
	}
	for (const template of plan.templates) {
		if (template.activeCorrectedIds.length === 0) throw new Error(`${template.name} has no active corrected template`)
		if (template.activeLegacyIds.length > 0)
			throw new Error(`${template.name} still has active legacy template ids ${template.activeLegacyIds.join(", ")}`)
	}
}
