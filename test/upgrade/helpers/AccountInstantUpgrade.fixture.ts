import { expect } from "chai"

export async function expectFailure(fn: () => Promise<any>, pattern: RegExp) {
	let error: unknown
	try {
		await fn()
	} catch (e) {
		error = e
	}
	expect(String(error)).to.match(pattern)
}
