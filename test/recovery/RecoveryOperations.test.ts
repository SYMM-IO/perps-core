import hre from "hardhat"
import assert from "node:assert/strict"

import { TARGET, ROLE, iface, recoveryAction } from "../../deployment-tooling/hyperevm-zero-recovery.js"
import {
	artifactFor,
	archiveProbe,
	requireOperational,
	submitRecoveryOperation,
	recoveryRoleAction,
	executeLedgerRecovery,
} from "../../tasks/deploy/hyperevmZeroRecovery.js"

const hash = "0x" + "1".repeat(64),
	blockHash = "0x" + "2".repeat(64)
function fixture() {
	const intent = { from: TARGET.owner, to: TARGET.core, data: "0x12345678", value: "0", chainId: 999 }
	const receipt: any = { status: 1, hash, blockNumber: 100, index: 3, blockHash, gasUsed: 50000n }
	const tx: any = { ...intent, value: 0n, nonce: 7, hash, wait: async () => receipt }
	let broadcasts = 0
	const report: any = {},
		persisted: any[] = []
	const save = () => persisted.push(JSON.parse(JSON.stringify(report)))
	const signer = {
		getAddress: async () => intent.from,
		sendTransaction: async (request: any) => {
			broadcasts++
			assert.equal(report.operations.cut.status, "prepared")
			assert.equal(request.nonce, 7)
			return tx
		},
	}
	const provider: any = {
		getTransactionCount: async () => 7,
		estimateGas: async () => 50000n,
		getFeeData: async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }),
		getTransaction: async () => tx,
		getTransactionReceipt: async () => receipt,
		getBlock: async () => ({ hash: blockHash }),
	}
	return { intent, tx, receipt, report, persisted, save, signer, provider, broadcasts: () => broadcasts }
}
describe("recovery operator safeguards", function () {
	it("binds the artifact to the isolated compiler output and current source", async () => {
		const artifact = await artifactFor(hre)
		assert.equal(artifact.contractName, "ZeroBalanceRecoveryFacet085")
		assert.ok(artifact.deployedBytecode.length > 2)
	})
	it("persists intent before broadcast, confirms its exact receipt, and never resends on resume", async () => {
		const f = fixture()
		await submitRecoveryOperation(f.provider, f.signer, f.report, "cut", f.intent, f.save)
		assert.equal(f.persisted[0].operations.cut.status, "prepared")
		assert.equal(f.report.operations.cut.status, "confirmed")
		await submitRecoveryOperation(f.provider, f.signer, f.report, "cut", f.intent, f.save)
		assert.equal(f.broadcasts(), 1)
	})
	it("does not resend an interrupted pre-hash intent; reconciles only the matching transaction", async () => {
		const f = fixture()
		f.report.operations = { cut: { intent: f.intent, nonce: 7, status: "prepared" } }
		await assert.rejects(submitRecoveryOperation(f.provider, f.signer, f.report, "cut", f.intent, f.save), /No automatic resend/)
		assert.equal(f.broadcasts(), 0)
		await submitRecoveryOperation(f.provider, f.signer, f.report, "cut", f.intent, f.save, hash)
		assert.equal(f.report.operations.cut.status, "confirmed")
		assert.equal(f.broadcasts(), 0)
	})
	it("rejects wrong sender, destination, calldata, value, nonce or chain during reconciliation", async () => {
		for (const patch of [{ from: TARGET.recipient }, { to: TARGET.recipient }, { data: "0x12345679" }, { value: 1n }, { nonce: 8 }, { chainId: 1 }]) {
			const f = fixture()
			f.report.operations = { cut: { intent: f.intent, nonce: 7, hash, status: "submitted" } }
			Object.assign(f.tx, patch)
			await assert.rejects(submitRecoveryOperation(f.provider, f.signer, f.report, "cut", f.intent, f.save), /does not match/)
			assert.equal(f.broadcasts(), 0)
		}
	})
	it("does not accept reverted, missing or noncanonical receipts", async () => {
		for (const failure of ["reverted", "missing", "reorg"]) {
			const f = fixture()
			f.report.operations = { cut: { intent: f.intent, nonce: 7, hash, status: "submitted" } }
			if (failure === "reverted") f.receipt.status = 0
			if (failure === "missing") f.provider.getTransactionReceipt = async () => null
			if (failure === "reorg") f.provider.getBlock = async () => ({ hash })
			await assert.rejects(submitRecoveryOperation(f.provider, f.signer, f.report, "cut", f.intent, f.save), /pending, missing or reverted|canonical/)
			assert.equal(f.report.operations.cut.status, "submitted")
			assert.equal(f.broadcasts(), 0)
		}
	})
	it("does not leave an uncertain intent when pre-broadcast gas estimation fails", async () => {
		const f = fixture()
		f.provider.estimateGas = async () => {
			throw Error("Paused")
		}
		await assert.rejects(submitRecoveryOperation(f.provider, f.signer, f.report, "cut", f.intent, f.save), /Paused/)
		assert.equal(f.report.operations.cut, undefined)
		assert.equal(f.broadcasts(), 0)
	})
	it("clears an explicitly rejected signature but preserves uncertain transport failures", async () => {
		for (const code of ["ACTION_REJECTED", "NETWORK_ERROR"]) {
			const f = fixture()
			f.signer.sendTransaction = async () => {
				throw Object.assign(Error(code), { code })
			}
			await assert.rejects(submitRecoveryOperation(f.provider, f.signer, f.report, "cut", f.intent, f.save), new RegExp(code))
			assert.equal(Boolean(f.report.operations.cut), code !== "ACTION_REJECTED")
		}
	})
	it("rejects latest-only RPCs as optional fork sources", async () => {
		const provider = { getNetwork: async () => ({ chainId: 999n }), getBlock: async () => ({ hash: blockHash }), getCode: async () => "0x1234" }
		await assert.rejects(archiveProbe(provider, 100), /historical state/)
		provider.getCode = async (...args: any[]) => (args[1] === 1 ? "0x" : "0x1234")
		assert.equal((await archiveProbe(provider, 100)).hash, blockHash)
	})
	it("never automatically clears accounting/global pause or persistent signer", () => {
		const good = { globalPaused: false, accountingPaused: false, signer: "0x" + "0".repeat(40) }
		requireOperational(good)
		assert.throws(() => requireOperational({ ...good, accountingPaused: true }), /paused/)
		assert.throws(() => requireOperational({ ...good, globalPaused: true }), /paused/)
		assert.throws(() => requireOperational({ ...good, signer: TARGET.owner }), /signer/)
	})
})

describe("single Ledger recovery flow", () => {
	const snapshot = {
		operatorRole: true,
		safeRole: false,
		zero: "200981026302519456100",
		recipient: "1",
		globalPaused: false,
		accountingPaused: false,
		signer: "0x" + "0".repeat(40),
	}
	it("simulates from the Ledger and credits the separate multisig recipient", async () => {
		const report: any = {}
		const provider = {
			call: async (tx: any) => {
				assert.equal(tx.from, TARGET.owner)
				assert.equal(iface.decodeFunctionData("recoverZeroAddressBalance", tx.data)[0], TARGET.recipient)
				return iface.encodeFunctionResult("recoverZeroAddressBalance", [BigInt(snapshot.zero)])
			},
		}
		let sends = 0
		await executeLedgerRecovery(provider, report, snapshot, async (label, tx) => {
			sends++
			assert.equal(label, "recovery")
			assert.deepEqual(tx, recoveryAction())
		})
		assert.equal(sends, 1)
		assert.equal(report.preview.operator, TARGET.owner)
	})
	it("reconciles an existing recovery before checking emptied balances or removed roles", async () => {
		const f = fixture()
		f.intent.data = recoveryAction().data
		f.tx.data = f.intent.data
		f.report.operations = { recovery: { intent: f.intent, nonce: 7, hash, status: "submitted" } }
		await executeLedgerRecovery(f.provider, f.report, { ...snapshot, zero: "0", operatorRole: false }, (label, tx) =>
			submitRecoveryOperation(f.provider, f.signer, f.report, label, tx, f.save),
		)
		assert.equal(f.report.operations.recovery.status, "confirmed")
		assert.equal(f.broadcasts(), 0)
	})
	it("rejects new recovery when unauthorized, paused, empty or already exported for Safe", async () => {
		for (const patch of [{ operatorRole: false }, { accountingPaused: true }, { globalPaused: true }, { zero: "0" }])
			await assert.rejects(executeLedgerRecovery({}, {}, { ...snapshot, ...patch }, async () => assert.fail("must not send")))
		await assert.rejects(
			executeLedgerRecovery({}, { safeDelivery: {} }, snapshot, async () => assert.fail("must not send")),
			/Safe export/,
		)
	})
	it("grants and removes only the Ledger role, preserving both accounts' preexisting roles", () => {
		for (const safeRole of [false, true]) {
			const before = { ...snapshot, operatorRole: false, safeRole }
			const report: any = { baseline: before }
			const grant = recoveryRoleAction(report, before, "grant")!
			assert.deepEqual([...iface.decodeFunctionData("grantRole", grant.data)], [TARGET.owner, ROLE])
			report.temporaryRole = true
			report.recovery = { transactionHash: hash }
			report.operations = { grant: { status: "confirmed", intent: { ...grant, from: TARGET.owner } } }
			const revoke = recoveryRoleAction(report, { ...before, operatorRole: true }, "cleanup")!
			assert.deepEqual([...iface.decodeFunctionData("revokeRole", revoke.data)], [TARGET.owner, ROLE])
			assert.equal(recoveryRoleAction({ baseline: { ...before, operatorRole: true } }, { ...before, operatorRole: true }, "grant"), null)
			assert.equal(
				recoveryRoleAction({ baseline: { ...before, operatorRole: true }, recovery: {} }, { ...before, operatorRole: true }, "cleanup"),
				null,
			)
			assert.throws(() => recoveryRoleAction(report, { ...before, safeRole: !safeRole }, "cleanup"), /Recipient/)
			report.operations.grant.intent.data = iface.encodeFunctionData("grantRole", [TARGET.recipient, ROLE])
			assert.throws(() => recoveryRoleAction(report, { ...before, operatorRole: true }, "cleanup"), /did not temporarily grant/)
		}
	})
	it("refuses missing baseline or unrelated grants instead of taking ownership of those roles", () => {
		assert.throws(() => recoveryRoleAction({ baseline: { safeRole: false } }, snapshot, "grant"), /baseline/)
		assert.throws(() => recoveryRoleAction({ baseline: { safeRole: false, operatorRole: false } }, snapshot, "grant"), /outside/)
	})
})
