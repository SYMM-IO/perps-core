export type SymbolCandidate = {
	symbolId: bigint
	name: string
	isValid: boolean
}

export type DuplicateSymbolGroup<T extends SymbolCandidate> = {
	name: string
	entries: T[]
	pickedId: bigint
}

export type SymbolCopyPlan<T extends SymbolCandidate> = {
	kept: T[]
	droppedNames: string[]
	duplicateGroups: Array<DuplicateSymbolGroup<T>>
	uniqueNameCount: number
}

export function symbolKey(name: string): string {
	return name.trim().toLowerCase()
}

export function buildSymbolCopyPlan<T extends SymbolCandidate>(symbols: readonly T[]): SymbolCopyPlan<T> {
	const byName = new Map<string, T[]>()
	for (const symbol of symbols) {
		const key = symbolKey(symbol.name)
		if (!key) throw new Error(`Source symbol ${symbol.symbolId} has an empty normalized name`)
		const entries = byName.get(key) ?? []
		entries.push(symbol)
		byName.set(key, entries)
	}

	const kept: T[] = []
	const droppedNames: string[] = []
	const duplicateGroups: Array<DuplicateSymbolGroup<T>> = []
	for (const [name, entries] of byName) {
		const valid = entries.filter(entry => entry.isValid)
		if (valid.length === 0) {
			droppedNames.push(name)
			continue
		}
		valid.sort((a, b) => (a.symbolId < b.symbolId ? 1 : a.symbolId > b.symbolId ? -1 : 0))
		kept.push(valid[0])
		if (entries.length > 1) duplicateGroups.push({ name, entries, pickedId: valid[0].symbolId })
	}
	kept.sort((a, b) => (a.symbolId < b.symbolId ? -1 : a.symbolId > b.symbolId ? 1 : 0))

	return { kept, droppedNames, duplicateGroups, uniqueNameCount: byName.size }
}
