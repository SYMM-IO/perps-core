import { expect } from "chai"

import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture } from "../helpers/network-helpers.js"

describe("Audit remediation: global relayer source boundary", function () {
	it("transfers real collateral through a configured legacy account manager and restores the cooldown", async function () {
		const c = await loadFixture(initializeFixture)
		const factory = await ethers.getContractFactory("SymmioGlobalRelayer")
		const implementation = await factory.deploy()
		const proxy = await (
			await ethers.getContractFactory("LocalERC1967Proxy")
		).deploy(await implementation.getAddress(), factory.interface.encodeFunctionData("initialize", [c.signers.admin.address]))
		const relayer = factory.attach(await proxy.getAddress()) as any
		const managerFactory = await ethers.getContractFactory("MultiAccount")
		const managerImplementation = await managerFactory.deploy()
		const managerProxy = await (
			await ethers.getContractFactory("LocalERC1967Proxy")
		).deploy(
			await managerImplementation.getAddress(),
			managerFactory.interface.encodeFunctionData("initialize", [
				c.signers.admin.address,
				c.diamond,
				(await ethers.getContractFactory("SymmioPartyA")).bytecode,
			]),
		)
		const manager = managerFactory.attach(await managerProxy.getAddress()) as any
		await manager.connect(c.signers.user).addAccount("relayer collateral")
		const account = (await manager.getAccounts(c.signers.user.address, 0, 1))[0].accountAddress
		const amount = ethers.parseEther("10")
		await c.collateral.mint(c.signers.user.address, amount)
		await c.collateral.connect(c.signers.user).approve(await manager.getAddress(), amount)
		await manager.connect(c.signers.user).depositForAccount(account, amount)
		await manager.connect(c.signers.user).delegateAccess(account, await relayer.getAddress(), ethers.id("withdrawTo(address,uint256)").slice(0, 10))
		await c.controlFacet.grantRole(await relayer.getAddress(), ethers.id("COOLDOWN_ADMIN_ROLE"))
		await relayer.setWhitelistedTargets([c.diamond], [true])
		await relayer.setSourceMultiAccount(c.diamond, await manager.getAddress())
		const cooldown = (await c.viewFacet.coolDownsOfMA())[0]
		const recipient = c.signers.user2.address
		const before = await c.viewFacet.balanceOf(recipient)
		await relayer.connect(c.signers.user).transfer(account, recipient, amount, c.diamond, await manager.getAddress(), c.diamond)
		expect(await c.viewFacet.balanceOf(account)).to.equal(0n)
		expect(await c.viewFacet.balanceOf(recipient)).to.equal(before + amount)
		expect(await c.collateral.balanceOf(await relayer.getAddress())).to.equal(0n)
		expect((await c.viewFacet.coolDownsOfMA())[0]).to.equal(cooldown)
	})

	it("rejects an owner-spoofing account manager before zeroing the real core cooldown", async function () {
		const context = await loadFixture(initializeFixture)
		const factory = await ethers.getContractFactory("SymmioGlobalRelayer")
		const implementation = await factory.deploy()
		const proxy = await (
			await ethers.getContractFactory("LocalERC1967Proxy")
		).deploy(await implementation.getAddress(), factory.interface.encodeFunctionData("initialize", [context.signers.admin.address]))
		const relayer = factory.attach(await proxy.getAddress()) as any
		await context.controlFacet.grantRole(await proxy.getAddress(), ethers.id("COOLDOWN_ADMIN_ROLE"))
		await relayer.setWhitelistedTargets([context.diamond], [true])
		const fake = await (await ethers.getContractFactory("AuditSourceMultiAccount")).deploy(context.signers.user.address)
		const cooldown = (await context.viewFacet.coolDownsOfMA())[0]
		const transfer = () =>
			relayer
				.connect(context.signers.user)
				.transfer(context.signers.user.address, context.signers.user.address, 0, context.diamond, fake.getAddress(), context.diamond)
		await expect(transfer()).to.be.revertedWithCustomError(relayer, "UntrustedSource")
		expect(await fake.called()).to.equal(false)
		expect((await context.viewFacet.coolDownsOfMA())[0]).to.equal(cooldown)
		await expect(relayer.connect(context.signers.user).setSourceMultiAccount(context.diamond, await fake.getAddress())).to.be.reverted
		await relayer.setSourceMultiAccount(context.diamond, await fake.getAddress())
		await transfer()
		expect(await fake.called()).to.equal(true)
		expect((await context.viewFacet.coolDownsOfMA())[0]).to.equal(cooldown)
		await relayer.setSourceMultiAccount(context.diamond, ethers.ZeroAddress)
		await expect(transfer()).to.be.revertedWithCustomError(relayer, "UntrustedSource")
	})
})
