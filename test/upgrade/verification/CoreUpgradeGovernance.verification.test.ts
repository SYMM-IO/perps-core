import { executeCoreGovernancePayload, verifyCoreGovernanceReceipt } from "../../../tasks/deploy/coreUpgradeGovernance.js"
import { ethers } from "../../helpers/hardhat-connection.js"
import { address, rejects, fixture } from "../helpers/CoreUpgradeGovernance.fixture.js"

describe("Generic Core governance (verification)", function () {
	it("rejects wrong owner, nonce, calldata, target, value, chain, failed or noncanonical EOA receipts", async () => {
		const f = await fixture(),
			journal: any = {}
		const hashes = await executeCoreGovernancePayload(ethers, f.config, f.envelope, journal, () => {})
		const hash = JSON.parse(hashes)[0],
			realReceipt = await ethers.provider.getTransactionReceipt(hash),
			realTx = await ethers.provider.getTransaction(hash)
		for (const change of [
			{ tx: { from: f.recipient.address } },
			{ tx: { nonce: realTx!.nonce + 1 } },
			{ tx: { data: "0x12345678" } },
			{ tx: { to: f.recipient.address } },
			{ tx: { value: 1n } },
			{ tx: { chainId: 8453n } },
			{ receipt: { status: 0 } },
			{ receipt: { blockNumber: f.afterBlock } },
			{ blockHash: "0x" + "b".repeat(64) },
		]) {
			const mock = {
				...ethers,
				provider: {
					getTransactionReceipt: async (h: string) => (h === hash ? { ...realReceipt, ...change.receipt } : ethers.provider.getTransactionReceipt(h)),
					getTransaction: async (h: string) => (h === hash ? { ...realTx, ...change.tx } : ethers.provider.getTransaction(h)),
					getBlock: async (n: number) => ({ ...(await ethers.provider.getBlock(n)), ...(change.blockHash ? { hash: change.blockHash } : {}) }),
					getBlockNumber: () => ethers.provider.getBlockNumber(),
				},
			}
			await rejects(() => verifyCoreGovernanceReceipt(mock, f.config, f.envelope, hashes, f.afterBlock), /differs|canonical/)
		}
		await rejects(() => verifyCoreGovernanceReceipt(ethers, f.config, f.envelope, JSON.stringify([hash]), f.afterBlock), /Every reviewed/)
		await rejects(
			() => executeCoreGovernancePayload({ ...ethers, getSigners: async () => [f.recipient] }, f.config, f.envelope, {}, () => {}),
			/signer/,
		)
		await rejects(() => executeCoreGovernancePayload(ethers, f.config, { ...f.envelope, payloadDigest: "changed" }, {}, () => {}), /envelope/)
		await rejects(
			() => verifyCoreGovernanceReceipt(ethers, { ...f.config, execution: { confirmations: 10000 } }, f.envelope, hashes, f.afterBlock),
			/confirmations/,
		)
	})
})
