import hre from "hardhat"
import assert from "node:assert/strict"

import { TARGET } from "../../deployment-tooling/hyperevm-zero-recovery.js"
import { artifactFor, archiveProbe, requireOperational, submitRecoveryOperation } from "../../tasks/deploy/hyperevmZeroRecovery.js"

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
