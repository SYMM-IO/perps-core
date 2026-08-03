export const OPEN_POSITION_PAGE_SIZE = 1000

export type OpenPositionPageReader<T> = (start: number, size: number) => Promise<readonly T[]>

export async function getAllOpenPositions<T>(readPage: OpenPositionPageReader<T>, pageSize = OPEN_POSITION_PAGE_SIZE): Promise<T[]> {
	if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
		throw new RangeError("Open-position page size must be a positive safe integer")
	}

	const positions: T[] = []
	let start = 0

	while (true) {
		const page = await readPage(start, pageSize)
		positions.push(...page)

		if (page.length < pageSize) return positions
		start += page.length
	}
}
