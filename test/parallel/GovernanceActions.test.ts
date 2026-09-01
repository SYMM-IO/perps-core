import { expect } from "chai"

import { classifyGovernanceAdmin, governanceAction, isGovernanceActionSatisfied } from "../../tasks/deploy/governanceActions.js"
import { ethers } from "../helpers/hardhat-connection.js"

describe("verified governance actions", function () {
	it("checks the exact read result that proves an action", async function () {
		const [admin] = await ethers.getSigners()
		const target = await (await ethers.getContractFactory("SymmioSymbolManager")).deploy(admin.address, admin.address)
		const role = ethers.id("SETTER_ROLE")
		const action = governanceAction({
			id: `role.${role.toLowerCase()}.${admin.address.toLowerCase()}`,
			method: "grantRole(bytes32,address)",
			expectedSigner: admin.address,
			to: await target.getAddress(),
			value: "0",
			data: target.interface.encodeFunctionData("grantRole", [role, admin.address]),
			description: "Grant SETTER_ROLE to final admin",
			postState: {
				to: await target.getAddress(),
				data: target.interface.encodeFunctionData("hasRole", [role, admin.address]),
				expectedResult: target.interface.encodeFunctionResult("hasRole", [true]),
			},
		})
		expect(await isGovernanceActionSatisfied(ethers.provider, action)).to.equal(false)
		await (await target.grantRole(role, admin.address)).wait()
		expect(await isGovernanceActionSatisfied(ethers.provider, action)).to.equal(true)
	})

	it("classifies an address without code as an EOA", async function () {
		const [, eoa] = await ethers.getSigners()
		expect(await classifyGovernanceAdmin(ethers.provider, eoa.address)).to.deep.equal({ address: eoa.address, type: "eoa" })
	})

	it("recognizes a contract only after all Safe probes succeed", async function () {
		const safeInterface = new ethers.Interface([
			"function VERSION() view returns (string)",
			"function getOwners() view returns (address[])",
			"function getThreshold() view returns (uint256)",
			"function nonce() view returns (uint256)",
		])
		const safeAddress = "0x9000000000000000000000000000000000000009"
		const responses = new Map([
			[safeInterface.getFunction("VERSION")!.selector, safeInterface.encodeFunctionResult("VERSION", ["1.4.1"])],
			[safeInterface.getFunction("getOwners")!.selector, safeInterface.encodeFunctionResult("getOwners", [[safeAddress]])],
			[safeInterface.getFunction("getThreshold")!.selector, safeInterface.encodeFunctionResult("getThreshold", [1n])],
			[safeInterface.getFunction("nonce")!.selector, safeInterface.encodeFunctionResult("nonce", [0n])],
		])
		const provider = {
			getCode: async () => "0x6001",
			call: async ({ data }: { data: string }) => responses.get(data.slice(0, 10))!,
		}
		expect(await classifyGovernanceAdmin(provider as any, safeAddress)).to.deep.equal({
			address: safeAddress,
			type: "safe",
			safeVersion: "1.4.1",
		})
	})

	it("does not call an arbitrary contract a Safe", async function () {
		const [admin] = await ethers.getSigners()
		const contract = await (await ethers.getContractFactory("SymmioSymbolManager")).deploy(admin.address, admin.address)
		expect((await classifyGovernanceAdmin(ethers.provider, await contract.getAddress())).type).to.equal("unknown-contract")
	})
})
