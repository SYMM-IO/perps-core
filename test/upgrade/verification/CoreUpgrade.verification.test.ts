import { expect } from "chai"

import { digest } from "../../../deployment-tooling/arbitrum-core-upgrade.js"
import { SAFE_EXECUTION_ABI, verifyCoreSafeReceipt } from "../../../tasks/deploy/coreUpgradeSafe.js"
import { assertCoreSnapshotPreserved } from "../../../tasks/deploy/coreUpgradeSnapshot.js"
import { ethers } from "../../helpers/hardhat-connection.js"
import { address, rejects } from "../helpers/CoreUpgrade.fixture.js"

describe("Current Core upgrade safety gates (verification)", function () {
	it("refuses economic, peripheral, pause, role and funding drift even after a successful receipt", () => {
		const before = {
			muon: { configuration: { appId: "7" } },
			preserved: { owner: address(1) },
			wiring: {},
			code: {},
			economy: { quote: "123" },
			pause: [true, false],
			roles: { migration: false, listing: false },
		}
		const after = {
			...structuredClone(before),
			roles: { migration: false, listing: true },
			funding: [{ a: "0", b: "0", expected: "0" }],
			globals: [{ stored: "0", expected: "0" }],
		}
		expect(() => assertCoreSnapshotPreserved(before, after, true)).not.to.throw()
		for (const mutate of [
			(s: any) => (s.muon.configuration.appId = "8"),
			(s: any) => delete s.muon,
			(s: any) => (s.economy.quote = "124"),
			(s: any) => (s.code.new = "different"),
			(s: any) => (s.roles.migration = true),
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
