import { executeCoreGovernancePayload, rehearseCoreGovernancePayload } from "../../../tasks/deploy/coreUpgradeGovernance.js"
import { ethers } from "../../helpers/hardhat-connection.js"
import { address, rejects, fixture } from "../helpers/CoreUpgradeGovernance.fixture.js"

describe("Generic Core governance (preflight)", function () {
	it("refuses stale owner nonces and impersonation outside a block-pinned fork", async () => {
		const f = await fixture()
		await (await f.owner.sendTransaction({ to: f.recipient.address, value: 0n })).wait()
		await rejects(() => executeCoreGovernancePayload(ethers, f.config, f.envelope, {}, () => {}), /nonce changed/)
		await rejects(() => rehearseCoreGovernancePayload(ethers, f.config, f.envelope, f.afterBlock), /pinned fork/)
	})
})
