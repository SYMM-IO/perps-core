import { expect } from "chai"

import {
	buildConfigurationMigration,
	captureConfigurationSnapshot,
	verifyConfigurationMigration,
} from "../../deployment-tooling/operations/configuration-migration.js"
import { ethers } from "../helpers/hardhat-connection.js"

describe("Configuration setter effects", function () {
	it("restores an explicitly disabled whitelist after the account setter enables it", async function () {
		const [admin, core, account] = await ethers.getSigners()
		const factory = await ethers.getContractFactory("InstantLayer"),
			source = await factory.deploy(core.address, admin.address),
			target = await factory.deploy(core.address, admin.address)
		await source.setAccountLayer(account.address)
		await source.setTargetWhitelist(account.address, false)
		const authority = {
			address: admin.address,
			read: { signature: "function hasRole(bytes32,address) view returns(bool)", args: [await source.SETTER_ROLE(), admin.address] },
		}
		const profile = {
			schemaVersion: 1,
			kind: "symmio.configuration-profile",
			chainId: Number((await ethers.provider.getNetwork()).chainId),
			source: { address: String(source.target), codeHash: ethers.keccak256(await ethers.provider.getCode(source.target)) },
			fields: [
				{
					id: "account",
					mode: "copy",
					authority,
					read: { signature: "function accountLayer() view returns(address)", args: [] },
					write: { signature: "function setAccountLayer(address)", args: [{ ref: "observed" }] },
				},
				{
					id: "account-whitelist",
					mode: "copy",
					authority,
					dependsOn: ["account"],
					read: { signature: "function whitelistedTargets(address) view returns(bool)", args: [account.address] },
					write: { signature: "function setTargetWhitelist(address,bool)", args: [account.address, { ref: "observed" }] },
				},
			],
		}
		const before = (await ethers.provider.getBlock("latest"))!,
			checkpoint = { blockNumber: before.number, blockHash: before.hash! }
		const targetBinding = { address: String(target.target), codeHash: ethers.keccak256(await ethers.provider.getCode(target.target)) }
		const snapshot = await captureConfigurationSnapshot(ethers.provider, profile, checkpoint),
			plan = await buildConfigurationMigration(ethers.provider, profile, snapshot, targetBinding, checkpoint)
		for (const action of plan.actions) await (await admin.sendTransaction({ to: action.to, data: action.data })).wait()
		const block = (await ethers.provider.getBlock("latest"))!
		await verifyConfigurationMigration(ethers.provider, plan, { blockNumber: block.number, blockHash: block.hash! })
		expect(plan.actions.map((a: any) => a.id)).to.deep.equal(["account", "account-whitelist"])
		expect(await target.whitelistedTargets(account.address)).to.equal(false)
		expect(
			(await buildConfigurationMigration(ethers.provider, profile, snapshot, targetBinding, { blockNumber: block.number, blockHash: block.hash! }))
				.actions,
		).to.deep.equal([])
	})
})
