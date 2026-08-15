import { expect } from "chai"

import {
	assertCheckpointContractsHaveCode,
	assertCheckpointManifest,
	createCheckpoint,
	createDeployedContract,
	createDeploymentManifest,
} from "../../tasks/deploy/checkpoint.js"
import { verificationProviderForChain } from "../../tasks/deploy/explorer.js"
import {
	getDeploymentTransactionJournal,
	getDeploymentTransactionSettings,
	deploymentTimeoutRecoveryHint,
	resetDeploymentTransactionJournal,
	send,
} from "../../tasks/deploy/tx.js"
import { hre } from "../helpers/hardhat-connection.js"

describe("deployment infrastructure", function () {
	it("selects Blockscout for the configured IOTA, Mode, and COTI explorers", function () {
		for (const chainId of [8822, 34443, 2632500]) expect(verificationProviderForChain(chainId)).to.equal("blockscout")
		expect(verificationProviderForChain(42161)).to.equal("etherscan")
	})

	it("resolves an explicit compatible explorer for every non-built-in verification chain", function () {
		for (const chainId of [8822, 34443, 2632500]) {
			const explorer = hre.config.chainDescriptors.get(BigInt(chainId))?.blockExplorers.blockscout
			expect(explorer?.apiUrl).to.match(/^https:\/\//)
		}
		for (const chainId of [146, 999, 1329, 5000, 9745, 80094, 81457]) {
			const explorer = hre.config.chainDescriptors.get(BigInt(chainId))?.blockExplorers.etherscan
			expect(explorer?.url).to.match(/^https:\/\//)
		}
		expect(hre.config.chainDescriptors.get(1329n)?.blockExplorers.etherscan?.url).to.equal("https://seiscan.io")
	})
	it("validates transaction timing settings instead of accepting NaN or unsafe ranges", function () {
		expect(getDeploymentTransactionSettings({})).to.deep.equal({ confirmations: 1, timeoutSeconds: 300, slowNoticeSeconds: 30 })
		expect(() => getDeploymentTransactionSettings({ DEPLOY_CONFIRMATIONS: "NaN" })).to.throw("must be a whole number")
		expect(() => getDeploymentTransactionSettings({ DEPLOY_TX_TIMEOUT: "29" })).to.throw("must be between 30")
		expect(() => getDeploymentTransactionSettings({ DEPLOY_TX_TIMEOUT: "30", DEPLOY_SLOW_TX_NOTICE: "30" })).to.throw("must be less than")
	})

	it("never tells an unjournaled standalone transaction that it is safe to rerun", function () {
		expect(deploymentTimeoutRecoveryHint(true)).to.include("write-ahead checkpointed")
		expect(deploymentTimeoutRecoveryHint(false)).to.include("No durable standalone checkpoint")
		expect(deploymentTimeoutRecoveryHint(false)).to.include("Do not broadcast this action again")
	})

	it("binds a checkpoint to public deployment intent and deployment source", function () {
		const checkpoint = createCheckpoint("default", 31337)
		const manifest = createDeploymentManifest(
			{ admin: "0x1", templates: [1, 2] },
			{ deploymentId: checkpoint.deploymentId, sourcePaths: ["package.json"] },
		)
		checkpoint.manifest = manifest

		expect(() => assertCheckpointManifest(checkpoint, { ...manifest, createdAt: new Date().toISOString() })).not.to.throw()
		const changed = createDeploymentManifest(
			{ admin: "0x2", templates: [1, 2] },
			{ deploymentId: checkpoint.deploymentId, sourcePaths: ["package.json"] },
		)
		expect(() => assertCheckpointManifest(checkpoint, changed)).to.throw("deployment configuration")
	})

	it("refuses checkpoint addresses that have no code on the connected chain", async function () {
		const checkpoint = createCheckpoint("default", 31337)
		checkpoint.contracts.signatureVerifier = createDeployedContract("0x0000000000000000000000000000000000000001")
		let failure: unknown
		try {
			await assertCheckpointContractsHaveCode(checkpoint, async () => "0x")
		} catch (error) {
			failure = error
		}
		expect(failure).to.be.instanceOf(Error)
		expect((failure as Error).message).to.include("has no code")
		await assertCheckpointContractsHaveCode(checkpoint, async () => "0x6000")
	})

	it("journals confirmed and successfully replaced transactions", async function () {
		resetDeploymentTransactionJournal()
		const receipt = {
			status: 1,
			hash: "0xconfirmed",
			blockNumber: 10,
			gasUsed: 21_000n,
			gasPrice: 2n,
		}
		await send(Promise.resolve({ hash: "0xsubmitted", nonce: 7, wait: async () => receipt } as any), "test confirmation")
		expect(getDeploymentTransactionJournal()[0]).to.include({
			hash: "0xsubmitted",
			nonce: 7,
			status: "confirmed",
			gasUsed: "21000",
			nativeCostWei: "42000",
		})

		resetDeploymentTransactionJournal()
		const replacement = { ...receipt, hash: "0xreplacement", blockNumber: 11 }
		await send(
			Promise.resolve({
				hash: "0xoriginal",
				nonce: 8,
				wait: async () => {
					throw { code: "TRANSACTION_REPLACED", cancelled: false, receipt: replacement, replacement: { hash: replacement.hash } }
				},
			} as any),
			"test replacement",
		)
		expect(getDeploymentTransactionJournal()[0]).to.include({
			hash: "0xoriginal",
			replacementHash: "0xreplacement",
			status: "replaced",
		})
	})
})
