import { expect } from "chai"

import {
	MUON_FUNCTION_INDICES,
	MUON_FUNCTION_NAMES,
	MUON_FUNCTIONS,
	assertConfiguredMuonPermissionsAuthorized,
	assertGeneralDeploymentMuonPermissions,
	formatMuonFunctionUpnlValidTimes,
	inspectConfiguredMuonPermissions,
	parseMuonFunctionPermissions,
	parseMuonFunctionUpnlValidTimes,
	resolveMuonFunctionPermissions,
	resolveMuonFunctionUpnlValidTimes,
	type MuonAuthorizationReader,
	type MuonFunctionIndex,
	type MuonPublicKey,
} from "../../tasks/deploy/muonPermissions.js"

class FakeAuthorizationReader implements MuonAuthorizationReader {
	readonly publicKeyCalls: Array<{ key: string; index: MuonFunctionIndex }> = []
	readonly gatewayCalls: Array<{ signer: string; index: MuonFunctionIndex }> = []

	constructor(
		private readonly publicKeyAuthorizations: ReadonlySet<string>,
		private readonly gatewayAuthorizations: ReadonlySet<string>,
		private readonly failure?: { kind: "publicKey" | "gateway"; index: MuonFunctionIndex },
	) {}

	async isPublicKeyAuthorized(publicKey: MuonPublicKey, functionIndex: MuonFunctionIndex): Promise<boolean> {
		this.publicKeyCalls.push({ key: `${String(publicKey.x)}:${publicKey.parity}`, index: functionIndex })
		if (this.failure?.kind === "publicKey" && this.failure.index === functionIndex) throw new Error("RPC unavailable")
		return this.publicKeyAuthorizations.has(`${String(publicKey.x)}:${publicKey.parity}:${functionIndex}`)
	}

	async isGatewaySignerAuthorized(signer: string, functionIndex: MuonFunctionIndex): Promise<boolean> {
		this.gatewayCalls.push({ signer, index: functionIndex })
		if (this.failure?.kind === "gateway" && this.failure.index === functionIndex) throw new Error("RPC unavailable")
		return this.gatewayAuthorizations.has(`${signer.toLowerCase()}:${functionIndex}`)
	}
}

async function expectRejection(promise: Promise<unknown>, expectedMessage: string): Promise<void> {
	try {
		await promise
		expect.fail("Expected promise to reject")
	} catch (error) {
		expect(error).to.be.instanceOf(Error)
		expect((error as Error).message).to.include(expectedMessage)
	}
}

describe("Muon deployment permissions", function () {
	it("keeps the canonical names and Solidity enum indices in exact order", function () {
		expect(MUON_FUNCTION_NAMES).to.deep.equal([
			"Trading",
			"AccountManagement",
			"Settlement",
			"ForceClose",
			"Funding",
			"LiquidationPartyA",
			"LiquidationPartyB",
			"RemoveMargin",
		])
		expect(MUON_FUNCTION_INDICES).to.deep.equal([0, 1, 2, 3, 4, 5, 6, 7])
		expect(MUON_FUNCTIONS.map(({ name, index }) => [name, index])).to.deep.equal(MUON_FUNCTION_NAMES.map((name, index) => [name, index]))
	})

	it("strictly parses a comma-separated permission list", function () {
		const parsed = parseMuonFunctionPermissions("Trading, AccountManagement,RemoveMargin")
		expect(parsed.map(({ name }) => name)).to.deep.equal(["Trading", "AccountManagement", "RemoveMargin"])
		expect(parsed.map(({ index }) => index)).to.deep.equal([0, 1, 7])
	})

	it("rejects empty, duplicate, unknown, and whitespace-padded tokenized permissions", function () {
		expect(() => parseMuonFunctionPermissions(" ")).to.throw("non-empty comma-separated list")
		expect(() => parseMuonFunctionPermissions("Trading,,Funding")).to.throw("empty entry at position 2")
		expect(() => parseMuonFunctionPermissions("Trading,Trading")).to.throw("Duplicate MuonFunction")
		expect(() => parseMuonFunctionPermissions("Trading,RemoveFunds")).to.throw("Unknown MuonFunction")
		expect(() => resolveMuonFunctionPermissions(["Trading", " Funding"])).to.throw("surrounding whitespace")
	})

	it("parses per-function UPNL validity overrides into canonical enum order", function () {
		const parsed = parseMuonFunctionUpnlValidTimes("RemoveMargin=90, Trading=30,Settlement=120")
		expect(parsed.map(({ name }) => name)).to.deep.equal(["Trading", "Settlement", "RemoveMargin"])
		expect(parsed.map(({ index }) => index)).to.deep.equal([0, 2, 7])
		expect(parsed.map(({ upnlValidTime }) => upnlValidTime)).to.deep.equal(["30", "120", "90"])
		expect(formatMuonFunctionUpnlValidTimes(parsed)).to.equal("Trading=30,Settlement=120,RemoveMargin=90")
	})

	it("treats an absent override map as no overrides rather than an error", function () {
		expect(parseMuonFunctionUpnlValidTimes("")).to.deep.equal([])
		expect(parseMuonFunctionUpnlValidTimes("   ")).to.deep.equal([])
		expect(resolveMuonFunctionUpnlValidTimes({})).to.deep.equal([])
	})

	it("rejects malformed, unknown, duplicate, and zero UPNL validity overrides", function () {
		expect(() => parseMuonFunctionUpnlValidTimes("Trading")).to.throw("must use the form MuonFunction=seconds")
		expect(() => parseMuonFunctionUpnlValidTimes("Trading=")).to.throw("must use the form MuonFunction=seconds")
		expect(() => parseMuonFunctionUpnlValidTimes("=30")).to.throw("must use the form MuonFunction=seconds")
		expect(() => parseMuonFunctionUpnlValidTimes("Trading=30,,Funding=60")).to.throw("empty entry at position 2")
		expect(() => parseMuonFunctionUpnlValidTimes("Trading=30,Trading=60")).to.throw("Duplicate MuonFunction")
		expect(() => parseMuonFunctionUpnlValidTimes("RemoveFunds=30")).to.throw("Unknown MuonFunction")
		expect(() => parseMuonFunctionUpnlValidTimes("Trading=abc")).to.throw("canonical unsigned base-10 integer")
		expect(() => parseMuonFunctionUpnlValidTimes("Trading=030")).to.throw("canonical unsigned base-10 integer")
		// Zero is the on-chain unset sentinel; omitting the entry is the only way to say "no override".
		expect(() => parseMuonFunctionUpnlValidTimes("Trading=0")).to.throw("omit the entry")
	})

	it("requires all eight permissions for a general production deployment and returns canonical order", function () {
		const shuffled = [...MUON_FUNCTION_NAMES].reverse()
		const resolved = assertGeneralDeploymentMuonPermissions(shuffled)
		expect(resolved).to.deep.equal(MUON_FUNCTIONS)

		expect(() => assertGeneralDeploymentMuonPermissions(MUON_FUNCTION_NAMES.filter(name => name !== "RemoveMargin"))).to.throw(
			"missing: RemoveMargin",
		)
	})

	it("inspects every configured key and gateway and reports missing authorization", async function () {
		const key = { x: "12345", parity: 1 }
		const gateway = "0x00000000000000000000000000000000000000A1"
		const permissions = ["Trading", "RemoveMargin"]
		const reader = new FakeAuthorizationReader(new Set(["12345:1:0", "12345:1:7"]), new Set([`${gateway.toLowerCase()}:0`]))

		const inspection = await inspectConfiguredMuonPermissions(reader, {
			publicKeys: [key],
			gatewaySigners: [gateway],
			permissionNames: permissions,
		})

		expect(reader.publicKeyCalls.map(({ index }) => index)).to.deep.equal([0, 7])
		expect(reader.gatewayCalls.map(({ index }) => index)).to.deep.equal([0, 7])
		expect(inspection.publicKeys[0].missingPermissions).to.deep.equal([])
		expect(inspection.gatewaySigners[0].missingPermissions).to.deep.equal(["RemoveMargin"])
		expect(inspection.missingAuthorizationCount).to.equal(1)
		expect(inspection.fullyAuthorized).to.equal(false)
		expect(() => assertConfiguredMuonPermissionsAuthorized(inspection)).to.throw(`gateway signer ${gateway} is missing RemoveMargin`)
	})

	it("rejects duplicate configured subjects before issuing authorization reads", async function () {
		const reader = new FakeAuthorizationReader(new Set(), new Set())
		await expectRejection(
			inspectConfiguredMuonPermissions(reader, {
				publicKeys: [
					{ x: "1", parity: 0 },
					{ x: 1n, parity: 0 },
				],
				permissionNames: ["Trading"],
			}),
			"public keys must not contain duplicates",
		)

		await expectRejection(
			inspectConfiguredMuonPermissions(reader, {
				gatewaySigners: ["0x00000000000000000000000000000000000000A1", "0x00000000000000000000000000000000000000a1"],
				permissionNames: ["Trading"],
			}),
			"gateway signers must not contain duplicate addresses",
		)
		expect(reader.publicKeyCalls).to.deep.equal([])
		expect(reader.gatewayCalls).to.deep.equal([])
	})

	it("adds subject and permission context to authorization read failures", async function () {
		const reader = new FakeAuthorizationReader(new Set(), new Set(), { kind: "publicKey", index: 7 })

		await expectRejection(
			inspectConfiguredMuonPermissions(reader, {
				publicKeys: [{ x: "987", parity: 0 }],
				permissionNames: ["RemoveMargin"],
			}),
			"public key x=987, parity=0 for RemoveMargin (7): RPC unavailable",
		)
	})
})
