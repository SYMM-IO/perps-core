import { expect } from "chai"

import { executeCoreGovernancePayload, verifyCoreGovernanceReceipt } from "../../../tasks/deploy/coreUpgradeGovernance.js"
import { ethers } from "../../helpers/hardhat-connection.js"
import { address, rejects, fixture } from "../helpers/CoreUpgradeGovernance.fixture.js"

describe("Generic Core governance (recovery)", function () {
	it("verifies mined EOA actions and resumes a broadcast whose receipt wait was interrupted without resending", async () => {
		const f = await fixture(),
			journal: any = {},
			persisted: any[] = []
		let broadcasts = 0,
			failOnce = true
		const mocked = {
			...ethers,
			getSigners: async () => [
				{
					getAddress: () => f.owner.getAddress(),
					sendTransaction: async (request: any) => {
						broadcasts++
						return f.owner.sendTransaction(request)
					},
				},
			],
		}
		const persist = () => {
			persisted.push(structuredClone(journal))
			if (failOnce && journal.transactions?.length) {
				failOnce = false
				throw new Error("Interrupted after durable broadcast")
			}
		}
		await rejects(() => executeCoreGovernancePayload(mocked, f.config, f.envelope, journal, persist), /broadcast.*write-ahead/)
		expect(broadcasts).to.equal(1)
		expect(persisted.at(-1).transactions[0].hash).to.match(/^0x/)
		const hashes = await executeCoreGovernancePayload(mocked, f.config, f.envelope, journal, persist)
		expect(broadcasts).to.equal(2)
		expect(journal.transactions.every((tx: any) => tx.status === "confirmed" && tx.blockHash)).to.equal(true)
		expect((await verifyCoreGovernanceReceipt(ethers, f.config, f.envelope, hashes, f.afterBlock)).receipts).to.have.length(2)
		expect(await f.target.hasRole(ethers.id("SECOND_TEST_ROLE"), f.recipient.address)).to.equal(true)
		await executeCoreGovernancePayload(mocked, f.config, f.envelope, journal, persist)
		expect(broadcasts).to.equal(2)
	})
})
