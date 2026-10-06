import { expect } from "chai"

import { createCheckpoint } from "../../tasks/deploy/checkpoint.js"
import { executeGovernanceActions, governanceAction } from "../../tasks/deploy/governanceActions.js"
import { ethers, hre } from "../helpers/hardhat-connection.js"

async function fixture(firstActionSatisfied = false) {
	const [admin, other] = await ethers.getSigners()
	const target = await (await ethers.getContractFactory("SymmioSymbolManager")).deploy(admin.address, admin.address)
	const targetAddress = await target.getAddress()
	const roles = [ethers.id("HANDOVER_ROLE_A"), ethers.id("HANDOVER_ROLE_B")]
	const actions = roles.map((role, index) =>
		governanceAction({
			id: `test.role-${index + 1}.${other.address.toLowerCase()}`,
			method: "grantRole(bytes32,address)",
			expectedSigner: admin.address,
			to: targetAddress,
			value: "0",
			data: target.interface.encodeFunctionData("grantRole", [role, other.address]),
			description: `Grant test role ${index + 1}`,
			postState: {
				to: targetAddress,
				data: target.interface.encodeFunctionData("hasRole", [role, other.address]),
				expectedResult: target.interface.encodeFunctionResult("hasRole", [true]),
			},
		}),
	)
	if (firstActionSatisfied) await (await target.grantRole(roles[0], other.address)).wait()
	return { admin, other, target, actions, checkpoint: createCheckpoint("default", 31337, `governance-test-${Date.now()}`) }
}

describe("governance handover execution", function () {
	it("simulates, journals, executes, and verifies each action", async function () {
		const context = await fixture()
		const result = await executeGovernanceActions(hre, context.actions, {
			expectedAdmin: context.admin.address,
			chainId: 31337,
			checkpoint: context.checkpoint,
		})
		expect(result).to.deep.equal({ submitted: 2, skipped: 0, verified: 2 })
		expect(context.checkpoint.transactions).to.have.length(2)
		expect(context.checkpoint.transactions!.every(transaction => transaction.status === "confirmed")).to.equal(true)
	})

	it("skips an action whose post-state is already satisfied", async function () {
		const context = await fixture(true)
		const result = await executeGovernanceActions(hre, context.actions, {
			expectedAdmin: context.admin.address,
			chainId: 31337,
			checkpoint: context.checkpoint,
		})
		expect(result).to.deep.equal({ submitted: 1, skipped: 1, verified: 2 })
	})

	it("rejects a signer other than the configured administrator", async function () {
		const context = await fixture()
		let message = ""
		try {
			await executeGovernanceActions(hre, context.actions, {
				expectedAdmin: context.other.address,
				chainId: 31337,
				checkpoint: context.checkpoint,
			})
		} catch (error) {
			message = error instanceof Error ? error.message : String(error)
		}
		expect(message).to.match(/actual signer .* does not match governance admin/)
	})
})
