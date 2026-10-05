import { expect } from "chai"

export const address = (n: number) => "0x" + n.toString(16).padStart(40, "0")

export async function rejects(fn: () => Promise<any>, pattern: RegExp) {
	try {
		await fn()
	} catch (error) {
		expect(String(error)).to.match(pattern)
		return
	}
	throw new Error("Expected rejection")
}
