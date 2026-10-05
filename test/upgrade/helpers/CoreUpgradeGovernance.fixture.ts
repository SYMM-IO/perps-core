import { expect } from "chai"

import { prepareCoreGovernancePayload } from "../../../tasks/deploy/coreUpgradeGovernance.js"
import { ethers } from "../../helpers/hardhat-connection.js"

export const address = (n: number) => "0x" + n.toString(16).padStart(40, "0")

export async function rejects(fn: () => Promise<any>, pattern: RegExp) {
	try {
		await fn()
	} catch (error) {
		expect(String(error)).to.match(pattern)
		return
	}
	throw new Error("Expected rejection")
}

export async function fixture() {
	const [owner, recipient] = await ethers.getSigners()
	const target = await (await ethers.getContractFactory("SymmioSymbolManager")).deploy(owner.address, owner.address)
	await target.waitForDeployment()
	const config = {
		apiVersion: "operations.symm.io/core-upgrade-input-v1",
		network: { chainId: Number((await ethers.provider.getNetwork()).chainId) },
		governance: { kind: "eoa", owner: owner.address },
		target: { core: await target.getAddress() },
		execution: { confirmations: 1 },
	}
	const actions = ["SETTER_ROLE", "SECOND_TEST_ROLE"].map(role => ({
		to: config.target.core,
		value: "0",
		data: target.interface.encodeFunctionData("grantRole", [ethers.id(role), recipient.address]),
		description: `Grant ${role}`,
	}))
	const afterBlock = await ethers.provider.getBlockNumber(),
		envelope = await prepareCoreGovernancePayload(ethers, config, actions)
	return { owner, recipient, target, config, actions, envelope, afterBlock }
}
