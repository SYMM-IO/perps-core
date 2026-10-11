import { expect } from "chai"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

const INSTANT_LAYER_SLOTS = [
	"diamond.standard.storage.instantlayer.global",
	"diamond.standard.storage.instantlayer.delegation",
	"diamond.standard.storage.instantlayer.template",
]

function solidityFiles(dir: string): string[] {
	return readdirSync(dir).flatMap(entry => {
		const full = path.join(dir, entry)
		if (statSync(full).isDirectory()) return solidityFiles(full)
		return full.endsWith(".sol") ? [full] : []
	})
}

// Every keccak256("...") string literal in the contracts tree, with the files that contain it.
function keccakLiterals(): Map<string, string[]> {
	const found = new Map<string, string[]>()
	for (const file of solidityFiles("contracts")) {
		for (const match of readFileSync(file, "utf8").matchAll(/keccak256\(\s*"([^"]+)"\s*\)/g)) {
			found.set(match[1], [...(found.get(match[1]) ?? []), file])
		}
	}
	return found
}

describe("InstantLayer storage slots", function () {
	it("declares each slot string in exactly one file of the repo", function () {
		const literals = keccakLiterals()
		for (const slot of INSTANT_LAYER_SLOTS) {
			expect(literals.get(slot), slot).to.have.lengthOf(1)
		}
	})

	it("puts each slot in its own storage library", function () {
		const literals = keccakLiterals()
		expect(literals.get(INSTANT_LAYER_SLOTS[0])![0]).to.match(/storages\/InstantLayerStorage\.sol$/)
		expect(literals.get(INSTANT_LAYER_SLOTS[1])![0]).to.match(/storages\/DelegationStorage\.sol$/)
		expect(literals.get(INSTANT_LAYER_SLOTS[2])![0]).to.match(/storages\/TemplateStorage\.sol$/)
	})
})
