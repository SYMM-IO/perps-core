import { expect } from "chai"

import { digest, CUT_SELECTOR } from "../../deployment-tooling/arbitrum-core-upgrade.js"
import { buildCoreUpgradeActions, assertCoreDeployments, assertCoreUpgradeExecution } from "../../tasks/deploy/arbitrumCoreUpgrade.js"
import { SAFE_EXECUTION_ABI, verifyCoreSafeReceipt } from "../../tasks/deploy/coreUpgradeSafe.js"
import { assertCoreSnapshotPreserved, assertEmptySymbolAdjustment, coreUpgradeABI } from "../../tasks/deploy/coreUpgradeSnapshot.js"
import { ethers, hre } from "../helpers/hardhat-connection.js"

const address = (n: number) => "0x" + n.toString(16).padStart(40, "0")
async function rejects(fn: () => Promise<any>, pattern: RegExp) {
	try {
		await fn()
	} catch (error) {
		expect(String(error)).to.match(pattern)
		return
	}
	throw new Error("Expected rejection")
}

describe("Current Core upgrade safety gates", () => {
	it("refuses live rehearsals and deployment without both execution and chain authorization", () => {
		const live = { networkName: "arbitrum", networkConfig: { type: "http" } }
		const fork = { networkName: "fork-arbitrum", networkConfig: { type: "edr-simulated" } }
		expect(() => assertCoreUpgradeExecution("inspect", live, 42161, {})).not.to.throw()
		expect(() => assertCoreUpgradeExecution("deploy", live, 42161, {})).to.throw(/authorization/)
		expect(() => assertCoreUpgradeExecution("deploy", live, 42161, { SYMMIO_CORE_UPGRADE_EXECUTE: "true", CONFIRM_CHAIN_ID: "1" })).to.throw()
		expect(() => assertCoreUpgradeExecution("rehearse-cut", live, 42161, {})).to.throw(/network/)
		expect(() => assertCoreUpgradeExecution("deploy", fork, 42161, { SYMMIO_CORE_UPGRADE_EXECUTE: "true", CONFIRM_CHAIN_ID: "42161" })).to.throw(
			/network/,
		)
		expect(() => assertCoreUpgradeExecution("rehearse-cut", fork, 42161, {})).not.to.throw()
		expect(() => assertCoreUpgradeExecution("deploy", live, 42161, { SYMMIO_CORE_UPGRADE_EXECUTE: "true", CONFIRM_CHAIN_ID: "42161" })).not.to.throw()
	})
	it("refuses populated or unknown legacy adjustment layouts and accepts only the expected zero tuple", () => {
		for (const upgraded of [false, true]) {
			const words = upgraded ? 17 : 15,
				zero = "0x" + "0".repeat(words * 64)
			expect(() => assertEmptySymbolAdjustment(zero, upgraded)).not.to.throw()
			for (let i = 0; i < words; i++) {
				const populated = zero.slice(0, 2 + i * 64) + "1" + zero.slice(3 + i * 64)
				expect(() => assertEmptySymbolAdjustment(populated, upgraded)).to.throw(/storage migration/)
			}
			expect(() => assertEmptySymbolAdjustment(zero, !upgraded)).to.throw(/layout/)
		}
		expect(() => assertEmptySymbolAdjustment("0x", false)).to.throw()
	})

	it("puts the complete cut, listing grant and checked funding repair/role cleanup in one ordered batch", () => {
		const input = {
			config: {
				target: { core: address(1), safe: address(2), symbolManager: address(3) },
				allowedRemovedSelectors: [],
				pledgeTokens: [] as string[],
			},
		}
		const snapshot = {
			pause: [true],
			selectors: { [CUT_SELECTOR]: address(4), "0x12345678": address(5) },
			roles: { listing: false, migration: false, pledgeTokenManager: false },
			funding: [{ partyA: address(6), partyB: address(7), symbolId: "1", positionType: 0, a: "-1", b: "-1", expected: "0" }],
		}
		const deployed = { facets: { f: { address: address(8), selectors: ["0x12345678"] } } }
		const plan = buildCoreUpgradeActions(ethers, input, snapshot, deployed)
		const iface = new ethers.Interface(coreUpgradeABI)
		expect(plan.actions[0].data.slice(0, 10)).to.equal(CUT_SELECTOR)
		expect(plan.actions.slice(1).map(a => iface.parseTransaction({ data: a.data })!.name)).to.deep.equal([
			"grantRole",
			"grantRole",
			"resyncAggregateFunding",
			"revokeRole",
		])
		expect(iface.decodeFunctionData("resyncAggregateFunding", plan.actions[3].data)[0][0].expectedPartyBFunding).to.equal(-1n)
		snapshot.roles.migration = true
		expect(buildCoreUpgradeActions(ethers, input, snapshot, deployed).actions.length).to.equal(3)
		input.config.pledgeTokens = [address(9)]
		const withPledge = buildCoreUpgradeActions(ethers, input, snapshot, deployed).actions
		expect(withPledge.slice(1, 4).map(a => iface.parseTransaction({ data: a.data })!.name)).to.deep.equal([
			"grantRole",
			"setPledgeTokenWhitelist",
			"revokeRole",
		])
		expect(iface.decodeFunctionData("setPledgeTokenWhitelist", withPledge[2].data)[0]).to.equal(address(9))
		expect(iface.decodeFunctionData("grantRole", withPledge[1].data)[1]).to.equal(ethers.id("PLEDGE_TOKEN_MANAGER_ROLE"))
		expect(iface.decodeFunctionData("revokeRole", withPledge[3].data)[1]).to.equal(ethers.id("PLEDGE_TOKEN_MANAGER_ROLE"))
		snapshot.roles.pledgeTokenManager = true
		const alreadyAuthorized = buildCoreUpgradeActions(ethers, input, snapshot, deployed).actions
		expect(alreadyAuthorized.slice(1).map(a => iface.parseTransaction({ data: a.data })!.name)).to.deep.equal([
			"setPledgeTokenWhitelist",
			"grantRole",
			"resyncAggregateFunding",
		])
		snapshot.pause[0] = false
		expect(() => buildCoreUpgradeActions(ethers, input, snapshot, deployed)).to.throw(/global pause/)
	})

	it("refuses economic, peripheral, pause, role and funding drift even after a successful receipt", () => {
		const before = {
			preserved: { owner: address(1) },
			wiring: {},
			code: {},
			economy: { quote: "123" },
			pause: [true, false],
			roles: { migration: false, listing: false, pledgeTokenManager: false },
		}
		const after = {
			...structuredClone(before),
			roles: { migration: false, listing: true, pledgeTokenManager: false },
			funding: [{ a: "0", b: "0", expected: "0" }],
			globals: [{ stored: "0", expected: "0" }],
		}
		expect(() => assertCoreSnapshotPreserved(before, after, true)).not.to.throw()
		for (const mutate of [
			(s: any) => (s.economy.quote = "124"),
			(s: any) => (s.code.new = "different"),
			(s: any) => (s.roles.migration = true),
			(s: any) => (s.roles.pledgeTokenManager = true),
			(s: any) => (s.roles.listing = false),
			(s: any) => (s.pause[1] = true),
			(s: any) => (s.funding[0].b = "1"),
			(s: any) => (s.globals[0].stored = "1"),
		]) {
			const wrong = structuredClone(after)
			mutate(wrong)
			expect(() => assertCoreSnapshotPreserved(before, wrong, true)).to.throw()
		}
	})

	it("requires the full deployment manifest and rejects reused or missing artifact evidence", async () => {
		await rejects(() => assertCoreDeployments(hre, ethers, undefined), /missing/)
		await rejects(() => assertCoreDeployments(hre, ethers, { libraries: {}, facets: {} }), /complete current manifest/)
	})

	it("distinguishes receipt success from exact successful Safe execution and refuses changed calldata", async () => {
		const iface = new ethers.Interface(SAFE_EXECUTION_ABI),
			hash = "0x" + "a".repeat(64),
			safeHash = "0x" + "b".repeat(64)
		const payload = {
			to: address(2),
			value: "0",
			data: "0x12345678",
			operation: 0,
			safeTxGas: "0",
			baseGas: "0",
			gasPrice: "0",
			gasToken: ethers.ZeroAddress,
			refundReceiver: ethers.ZeroAddress,
			nonce: 1,
		}
		const envelope = { payload, payloadDigest: digest(payload), safeTxHash: safeHash }
		const execution = iface.encodeFunctionData("execTransaction", [
			payload.to,
			payload.value,
			payload.data,
			0,
			0,
			0,
			0,
			ethers.ZeroAddress,
			ethers.ZeroAddress,
			"0x",
		])
		const log = iface.encodeEventLog(iface.getEvent("ExecutionSuccess")!, [safeHash, 0])
		const receipt: any = { to: address(1), status: 1, blockNumber: 101, blockHash: hash, logs: [{ address: address(1), ...log }] }
		const mocked = {
			...ethers,
			provider: {
				getTransactionReceipt: async () => receipt,
				getTransaction: async () => ({ data: execution, value: 0 }),
				getBlock: async () => ({ hash }),
			},
		}
		expect((await verifyCoreSafeReceipt(mocked, address(1), envelope, hash, 100)).safeTxHash).to.equal(safeHash)
		receipt.logs = []
		await rejects(() => verifyCoreSafeReceipt(mocked, address(1), envelope, hash, 100), /does not prove/)
		receipt.logs = [{ address: address(1), ...log }]
		await rejects(() => verifyCoreSafeReceipt(mocked, address(1), { ...envelope, safeTxHash: hash }, hash, 100), /does not prove/)
		await rejects(() => verifyCoreSafeReceipt(mocked, address(1), envelope, hash, 101), /predates/)
		const changed = { ...payload, data: "0x87654321" }
		await rejects(
			() => verifyCoreSafeReceipt(mocked, address(1), { ...envelope, payload: changed, payloadDigest: digest(changed) }, hash, 100),
			/differs from rehearsed/,
		)
	})
})
