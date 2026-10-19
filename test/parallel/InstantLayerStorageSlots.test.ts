import { expect } from "chai"
import { AbiCoder, Contract, keccak256, toBeHex, toUtf8Bytes, zeroPadValue } from "ethers"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

import { ethers } from "../helpers/hardhat-connection.js"
import { deployInstantLayerDiamondForTest } from "../utils/InstantLayerDiamond.js"

const INSTANT_LAYER_SLOTS = [
	"diamond.standard.storage.instantlayer.global",
	"diamond.standard.storage.instantlayer.execution",
	"diamond.standard.storage.instantlayer.delegation",
	"diamond.standard.storage.instantlayer.template",
]

const DEFAULT_ADMIN_ROLE = keccak256(toUtf8Bytes("DEFAULT_ADMIN_ROLE"))
const SETTER_ROLE = keccak256(toUtf8Bytes("SETTER_ROLE"))

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
		for (const [index, file] of ["InstantLayerStorage.sol", "ExecutionStorage.sol", "DelegationStorage.sol", "TemplateStorage.sol"].entries()) {
			expect(literals.get(INSTANT_LAYER_SLOTS[index])![0]).to.equal(path.join("contracts", "instantLayer", "storages", file))
		}
	})
})

// Reads raw storage at offsets counted by hand from each Layout struct. A live diamond keeps its
// state across facet cuts, so a field that moves here is a field read from the wrong slot there.
// The two replay mappings of the execution slot need a real batch and are pinned in
// InstantLayerDiamondExecution.test.ts.
describe("InstantLayer storage layout", function () {
	const coder = AbiCoder.defaultAbiCoder()
	const base = (name: string) => BigInt(keccak256(toUtf8Bytes(`diamond.standard.storage.instantlayer.${name}`)))
	const entry = (keyType: string, key: string, slot: bigint) => BigInt(keccak256(coder.encode([keyType, "uint256"], [key, slot])))
	const word = (value: bigint) => toBeHex(value, 32)

	let adminAddress: string
	let symmio: string
	let accountLayer: string
	let partyB: string
	let roleAdmin: string
	let diamond: Contract
	let read: (slot: bigint) => Promise<string>

	beforeEach(async function () {
		const signers = await ethers.getSigners()
		adminAddress = await signers[0].getAddress()
		// Nothing here calls out of the layer, so EOAs stand in for the contracts it is wired to.
		symmio = await signers[1].getAddress()
		accountLayer = await signers[2].getAddress()
		partyB = await signers[3].getAddress()
		roleAdmin = await signers[4].getAddress()

		const deployment = await deployInstantLayerDiamondForTest(ethers, signers[0], symmio, ["ControlFacet"])
		diamond = deployment.diamond
		read = slot => ethers.provider.getStorage(deployment.address, slot)
	})

	it("keeps config and roles in the global slot", async function () {
		const global = base("global")
		await diamond.setAccountLayer(accountLayer)
		await diamond.setTransientContextEnabled(false)
		await diamond.registerPartyBs([partyB])
		await diamond.setRoleAdmin(roleAdmin, SETTER_ROLE, true)

		expect(await read(global), "symmio").to.equal(zeroPadValue(symmio, 32))
		// accountLayer fills the low 20 bytes; above it sit transientContextEnabled (cleared
		// above, so the two flags are told apart) and then initialized.
		expect(await read(global + 1n), "accountLayer and flags").to.equal(`0x${"00".repeat(10)}0100${accountLayer.slice(2).toLowerCase()}`)
		expect(await read(entry("address", symmio, global + 2n)), "whitelistedTargets").to.equal(word(1n))
		expect(await read(entry("address", partyB, global + 3n)), "registeredPartyBs").to.equal(word(1n))
		expect(await read(entry("bytes32", DEFAULT_ADMIN_ROLE, entry("address", adminAddress, global + 4n))), "hasRole").to.equal(word(1n))
		expect(await read(entry("address", roleAdmin, entry("bytes32", SETTER_ROLE, global + 5n))), "roleAdmins").to.equal(word(1n))
	})

	it("keeps the reentrancy flag at the head of the execution slot", async function () {
		// Init seeds the flag to its not-entered value, 1.
		expect(await read(base("execution"))).to.equal(word(1n))
	})

	it("keeps the revocation cooldown after the four delegation mappings", async function () {
		// Init sets the cooldown to 10 minutes.
		expect(await read(base("delegation") + 4n)).to.equal(word(600n))
	})

	it("keeps the template counter after the two template mappings", async function () {
		await diamond.addTemplate("layout", [{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }])
		expect(await read(base("template") + 2n)).to.equal(word(1n))
	})
})
