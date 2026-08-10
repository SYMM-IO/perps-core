import { expect } from "chai"

import { SAFE_BATCH_API_VERSION, proposeSafeBatch, safeIntentDigest, validateSafeBatchIntent } from "../../tasks/deploy/safeProposal.js"

describe("Safe proposal adapter", function () {
	const safeAddress = "0x1111111111111111111111111111111111111111"
	const ownerAddress = "0x2222222222222222222222222222222222222222"
	const action = {
		to: "0x3333333333333333333333333333333333333333",
		value: "0",
		data: "0x1234",
		description: "Apply reviewed setting",
	}

	function intent(overrides: Record<string, unknown> = {}) {
		const core = {
			apiVersion: SAFE_BATCH_API_VERSION,
			chainId: 42161,
			safeAddress,
			name: "SYMMIO patch",
			description: "One exact action",
			actions: [action],
			...overrides,
		}
		return { ...core, digest: safeIntentDigest(core) }
	}

	it("rejects any mutation that is not reflected in the reviewed digest", function () {
		const reviewed = intent()
		expect(() => validateSafeBatchIntent({ ...reviewed, actions: [{ ...action, value: "1" }] })).to.throw("digest mismatch")
		expect(() => validateSafeBatchIntent({ ...reviewed, chainId: 1 })).to.throw("digest mismatch")
		expect(() => validateSafeBatchIntent({ ...reviewed, safeAddress: ownerAddress })).to.throw("digest mismatch")
	})

	it("creates one official Safe batch proposal and binds the result to its owner and digest", async function () {
		let proposed: Record<string, any> | undefined
		const signature = `0x${"aa".repeat(65)}`
		const safeTxHash = `0x${"bb".repeat(32)}`
		const protocol = {
			isOwner: async (address: string) => address === ownerAddress,
			createTransaction: async ({ transactions, onlyCalls }: any) => ({ data: { transactions, onlyCalls } }),
			getTransactionHash: async () => safeTxHash,
			signHash: async () => ({ data: signature }),
		}
		class ApiKit {
			constructor(config: any) {
				expect(config).to.deep.equal({ chainId: 42161n, apiKey: "api-key" })
			}
			async proposeTransaction(input: Record<string, any>) {
				proposed = input
			}
		}
		const reviewed = intent()
		const result = await proposeSafeBatch(reviewed, {
			protocolKit: {
				init: async config => {
					expect(config.safeAddress).to.equal(safeAddress)
					expect(config.signer).to.equal(ownerAddress)
					return protocol
				},
			},
			apiKit: ApiKit,
			provider: { request: async () => null },
			ownerAddress,
			apiKey: "api-key",
			now: () => new Date("2026-08-09T00:00:00.000Z"),
		})
		expect(proposed?.safeAddress).to.equal(safeAddress)
		expect(proposed?.safeTxHash).to.equal(safeTxHash)
		expect(proposed?.senderAddress).to.equal(ownerAddress)
		expect(proposed?.senderSignature).to.equal(signature)
		expect(proposed?.safeTransactionData.transactions).to.deep.equal([{ to: action.to, value: "0", data: "0x1234", operation: 0 }])
		expect(result).to.include({ safeTxHash, proposedBy: ownerAddress, digest: reviewed.digest, actionCount: 1 })
		expect(result.proposedAt).to.equal("2026-08-09T00:00:00.000Z")
	})

	it("refuses a proposal signer that is not an owner of the selected Safe", async function () {
		await expect(
			proposeSafeBatch(intent(), {
				protocolKit: { init: async () => ({ isOwner: async () => false }) },
				apiKit: class {} as any,
				provider: { request: async () => null },
				ownerAddress,
				apiKey: "api-key",
			}),
		).to.be.rejectedWith("is not an owner")
	})
})
