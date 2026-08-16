import type { BaseContract } from "ethers"

export const SETTLEMENT_QUOTE_ID_OFFSET = 448n
export const SETTLEMENT_CURRENT_PRICE_OFFSET = 480n

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

export type SettlementTemplateRecreationAction =
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

export interface SettlementTemplateRecreationPlan {
	actions: SettlementTemplateRecreationAction[]
	templates: Array<{
		name: string
		sourceId: bigint
		sourceActive: boolean
		replacementIds: bigint[]
		activeReplacementIds: bigint[]
		unsafeCurrentPriceOffsetIds: bigint[]
		activeUnsafeCurrentPriceOffsetIds: bigint[]
		instantOpenMode: boolean
	}>
	recreated: boolean
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

function settlementInjectionOffset(template: InstantLayerTemplateSnapshot): bigint | undefined {
	const operation = template.operations.at(-1)
	if (
		!operation ||
		operation.insertionPoints.length !== 1 ||
		operation.sourceIndices.length !== 1 ||
		operation.sourceOffsets.length !== 1 ||
		operation.sourceOffsets[0] !== 0n
	) {
		return undefined
	}
	return operation.insertionPoints[0]
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

function isCurrentPriceOffsetCopy(template: InstantLayerTemplateSnapshot, source: InstantLayerTemplateSnapshot): boolean {
	if (settlementInjectionOffset(template) !== SETTLEMENT_CURRENT_PRICE_OFFSET) return false
	const operations = cloneOperations(template.operations)
	operations.at(-1)!.insertionPoints[0] = SETTLEMENT_QUOTE_ID_OFFSET
	return operationsKey(operations) === operationsKey(source.operations)
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

export function buildSettlementTemplateRecreationPlan(
	templates: InstantLayerTemplateSnapshot[],
	{ deactivateOriginals = true }: { deactivateOriginals?: boolean } = {},
): SettlementTemplateRecreationPlan {
	const preparations: SettlementTemplateRecreationAction[] = []
	const deactivations: SettlementTemplateRecreationAction[] = []
	const summaries: SettlementTemplateRecreationPlan["templates"] = []
	let nextTemplateId = templates.reduce((next, template) => (template.id >= next ? template.id + 1n : next), 0n)

	for (const name of SETTLEMENT_TEMPLATE_NAMES) {
		const matching = templates.filter(template => template.name === name)
		const source = matching
			.filter(template => settlementInjectionOffset(template) === SETTLEMENT_QUOTE_ID_OFFSET)
			.sort((a, b) => Number(a.id - b.id))[0]
		if (!source) {
			throw new Error(
				`Required source template ${JSON.stringify(name)} with settleUpnl quote ID at byte offset ${SETTLEMENT_QUOTE_ID_OFFSET} is missing`,
			)
		}
		const sourceId = source.id

		const sourceKey = operationsKey(source.operations)
		const sameName = matching.filter(template => template.id !== sourceId)
		const replacements = sameName.filter(template => operationsKey(template.operations) === sourceKey)
		const unsafeCurrentPriceOffset = sameName.filter(template => isCurrentPriceOffsetCopy(template, source))
		const activeUnknown = sameName.filter(
			template => template.active && !replacements.includes(template) && !unsafeCurrentPriceOffset.includes(template),
		)
		if (activeUnknown.length > 0) {
			throw new Error(
				`${name} has active unrecognized template id(s) ${activeUnknown.map(template => template.id).join(", ")}; refusing to infer which wiring is safe`,
			)
		}

		const activeReplacements = replacements.filter(template => template.active).sort((a, b) => Number(a.id - b.id))
		let selectedReplacement = activeReplacements.find(template => template.instantOpenMode === source.instantOpenMode)
		if (!selectedReplacement) selectedReplacement = activeReplacements[0]

		if (!selectedReplacement) {
			selectedReplacement = replacements.filter(template => !template.active).sort((a, b) => Number(a.id - b.id))[0]
			if (selectedReplacement) {
				if (selectedReplacement.instantOpenMode !== source.instantOpenMode) {
					preparations.push({
						kind: "setTemplateInstantOpenMode",
						templateId: selectedReplacement.id,
						mode: source.instantOpenMode,
						name,
						description: `Restore instant-open mode ${source.instantOpenMode} on ${name} replacement ${selectedReplacement.id}`,
					})
				}
				preparations.push({
					kind: "setTemplateActive",
					templateId: selectedReplacement.id,
					active: true,
					name,
					description: `Reactivate exact ${name} replacement ${selectedReplacement.id}`,
				})
			} else {
				const replacementId = nextTemplateId++
				preparations.push({
					kind: "addTemplate",
					templateId: replacementId,
					name,
					operations: cloneOperations(source.operations),
					description: `Recreate ${name} as template ${replacementId} with exact source wiring and quote-ID offset ${SETTLEMENT_QUOTE_ID_OFFSET}`,
				})
				if (source.instantOpenMode) {
					preparations.push({
						kind: "setTemplateInstantOpenMode",
						templateId: replacementId,
						mode: true,
						name,
						description: `Restore instant-open mode true on ${name} replacement ${replacementId}`,
					})
				}
			}
		} else if (selectedReplacement.instantOpenMode !== source.instantOpenMode) {
			preparations.push({
				kind: "setTemplateInstantOpenMode",
				templateId: selectedReplacement.id,
				mode: source.instantOpenMode,
				name,
				description: `Restore instant-open mode ${source.instantOpenMode} on ${name} replacement ${selectedReplacement.id}`,
			})
		}

		if (deactivateOriginals) {
			if (source.active) {
				deactivations.push({
					kind: "setTemplateActive",
					templateId: source.id,
					active: false,
					name,
					description: `Deactivate original ${name} template ${source.id} after its exact replacement is available`,
				})
			}
			for (const template of unsafeCurrentPriceOffset.filter(template => template.active).sort((a, b) => Number(a.id - b.id))) {
				deactivations.push({
					kind: "setTemplateActive",
					templateId: template.id,
					active: false,
					name,
					description: `Deactivate unsafe ${name} template ${template.id} that injects quote ID into currentPrice offset ${SETTLEMENT_CURRENT_PRICE_OFFSET}`,
				})
			}
		}

		summaries.push({
			name,
			sourceId,
			sourceActive: source.active,
			replacementIds: replacements.map(template => template.id),
			activeReplacementIds: activeReplacements.map(template => template.id),
			unsafeCurrentPriceOffsetIds: unsafeCurrentPriceOffset.map(template => template.id),
			activeUnsafeCurrentPriceOffsetIds: unsafeCurrentPriceOffset.filter(template => template.active).map(template => template.id),
			instantOpenMode: source.instantOpenMode,
		})
	}

	const actions = [...preparations, ...deactivations]
	return { actions, templates: summaries, recreated: actions.length === 0 }
}

export function assertSettlementTemplateRecreationComplete(templates: InstantLayerTemplateSnapshot[]): void {
	const plan = buildSettlementTemplateRecreationPlan(templates)
	if (!plan.recreated) {
		throw new Error(`Settlement template recreation is incomplete; ${plan.actions.length} action(s) are still required`)
	}
	for (const template of plan.templates) {
		if (template.activeReplacementIds.length === 0) throw new Error(`${template.name} has no active exact replacement`)
		if (template.sourceActive) throw new Error(`${template.name} original template ${template.sourceId} is still active`)
		if (template.activeUnsafeCurrentPriceOffsetIds.length > 0) {
			throw new Error(`${template.name} has unsafe active template ids ${template.activeUnsafeCurrentPriceOffsetIds.join(", ")}`)
		}
	}
}
