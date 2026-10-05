import { expect } from "chai"

import { planPartyBUpgrade } from "../../../tasks/deploy/accountInstantUpgrade.js"
import { ethers } from "../../helpers/hardhat-connection.js"
import { expectFailure } from "../helpers/AccountInstantUpgrade.fixture.js"

describe("Configuration-preserving AccountLayer and InstantLayer upgrade (governance)", function () {
	this.timeout(180000)
	it("plans only needed PartyB grants for a contract admin without SETTER_ROLE and resumes wiring and retirement", async () => {
		const [originalAdmin, oldInstant, newInstant, unrelated] = await ethers.getSigners()
		const safeContract = await (await ethers.getContractFactory("MockAccountLayer")).deploy()
		const authority = String(safeContract.target).toLowerCase()
		await ethers.provider.send("hardhat_impersonateAccount", [authority])
		await ethers.provider.send("hardhat_setBalance", [authority, "0x3635c9adc5dea00000"])
		try {
			const safe = await ethers.getSigner(authority)
			const impl = await (await ethers.getContractFactory("SymmioPartyB")).deploy()
			const proxy = await (
				await ethers.getContractFactory("LocalERC1967Proxy")
			).deploy(impl.target, impl.interface.encodeFunctionData("initialize", [originalAdmin.address, unrelated.address]))
			const party = await ethers.getContractAt("SymmioPartyB", proxy.target)
			const manager = ethers.id("MULTICAST_WHITELIST_ROLE"),
				trusted = ethers.id("TRUSTED_ROLE")
			await party.grantRole(ethers.ZeroHash, authority)
			await party.grantRole(trusted, oldInstant.address)
			await party.setMulticastWhitelist(oldInstant.address, true)
			const snapshot = { partyBAdmins: { [String(party.target)]: authority }, gasless: { instantLayer: oldInstant.address } }
			const report = { deployments: { InstantLayer: { address: newInstant.address } } }
			const nonce = await ethers.provider.getTransactionCount(authority)
			let actions = await planPartyBUpgrade(ethers, snapshot, report)
			expect(await ethers.provider.getTransactionCount(authority)).to.equal(nonce)
			expect(actions.map(a => party.interface.parseTransaction({ data: a.data })!.name)).to.deep.equal([
				"grantRole",
				"grantRole",
				"setMulticastWhitelist",
			])
			const first = party.interface.decodeFunctionData("grantRole", actions[0].data)
			expect(first[0]).to.equal(manager)
			expect(first[1].toLowerCase()).to.equal(authority)
			for (const action of actions) {
				expect(action.authority).to.equal(authority)
				expect(action.to).to.equal(String(party.target))
				expect(action.value).to.equal("0")
			}
			for (const remaining of [2, 1, 0]) {
				await (await safe.sendTransaction({ to: actions[0].to, data: actions[0].data })).wait()
				actions = await planPartyBUpgrade(ethers, snapshot, report)
				expect(actions).to.have.length(remaining)
			}
			expect(await party.hasRole(trusted, newInstant.address)).to.equal(true)
			expect(await party.multicastWhitelist(newInstant.address)).to.equal(true)
			expect(await party.hasRole(ethers.id("SETTER_ROLE"), authority)).to.equal(false)
			expect(await party.hasRole(trusted, authority)).to.equal(false)
			await party.revokeRole(manager, authority)
			actions = await planPartyBUpgrade(ethers, snapshot, report, true)
			expect(actions.map(a => party.interface.parseTransaction({ data: a.data })!.name)).to.deep.equal([
				"grantRole",
				"revokeRole",
				"setMulticastWhitelist",
			])
			for (const action of actions) await (await safe.sendTransaction({ to: action.to, data: action.data })).wait()
			expect(await planPartyBUpgrade(ethers, snapshot, report, true)).to.deep.equal([])
			expect(await party.hasRole(trusted, oldInstant.address)).to.equal(false)
			expect(await party.multicastWhitelist(oldInstant.address)).to.equal(false)
			expect(await party.hasRole(trusted, newInstant.address)).to.equal(true)
			expect(await party.multicastWhitelist(newInstant.address)).to.equal(true)
			for (const role of [ethers.ZeroHash, manager, trusted]) expect(await party.hasRole(role, originalAdmin.address)).to.equal(true)
			await party.revokeRole(ethers.ZeroHash, authority)
			await expectFailure(() => planPartyBUpgrade(ethers, snapshot, report), /DEFAULT_ADMIN_ROLE/)
		} finally {
			await ethers.provider.send("hardhat_stopImpersonatingAccount", [authority])
		}
	})
})
