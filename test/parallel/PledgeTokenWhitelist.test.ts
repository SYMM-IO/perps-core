import { expect } from "chai"

import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture } from "../helpers/network-helpers.js"
import { RunContext } from "../models/RunContext.js"

describe("Pledge token whitelist", function () {
	let context: RunContext

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
	})

	it("blocks an unknown token before any token interaction", async function () {
		const probe = await (await ethers.getContractFactory("MockPledgeTokenProbe")).deploy()
		const token = await probe.getAddress()
		expect(await context.pledgeFacet.isPledgeTokenWhitelisted(token)).to.equal(false)

		await expect(context.pledgeFacet.connect(context.signers.user).depositPledge(token, 1n)).to.be.revertedWith(
			"PledgeFacet: Token is not whitelisted",
		)

		// Positive control: the same deposit reaches token code once the manager approves it.
		await context.pledgeFacet.setPledgeTokenWhitelist(token, true)
		await expect(context.pledgeFacet.connect(context.signers.user).depositPledge(token, 1n)).to.be.revertedWithCustomError(
			probe,
			"UnexpectedTokenCall",
		)
	})

	it("requires the dedicated token manager role for both approval and removal", async function () {
		const token = await context.collateral.getAddress()
		const manager = context.signers.user
		const role = ethers.id("PLEDGE_TOKEN_MANAGER_ROLE")
		await context.controlFacet.grantRole(manager.address, ethers.id("PARTY_B_MANAGER_ROLE"))

		for (const whitelisted of [true, false]) {
			await expect(context.pledgeFacet.connect(manager).setPledgeTokenWhitelist(token, whitelisted)).to.be.revertedWith(
				"Accessibility: Must have role",
			)
		}

		await context.controlFacet.grantRole(manager.address, role)
		for (const whitelisted of [false, true]) {
			await expect(context.pledgeFacet.connect(manager).setPledgeTokenWhitelist(token, whitelisted))
				.to.emit(context.pledgeFacet, "PledgeTokenWhitelistUpdated")
				.withArgs(token, whitelisted)
			expect(await context.pledgeFacet.isPledgeTokenWhitelisted(token)).to.equal(whitelisted)
		}

		await context.controlFacet.revokeRole(manager.address, role)
		await expect(context.pledgeFacet.connect(manager).setPledgeTokenWhitelist(token, false)).to.be.revertedWith("Accessibility: Must have role")
	})

	it("keeps token whitelisting separate from withdrawal approval and slashing", async function () {
		const token = await context.collateral.getAddress()
		const depositor = context.signers.user
		const tokenManager = context.signers.user2
		const fundsManager = context.signers.hedger
		await context.controlFacet.grantRole(tokenManager.address, ethers.id("PLEDGE_TOKEN_MANAGER_ROLE"))
		await context.controlFacet.grantRole(fundsManager.address, ethers.id("PARTY_B_MANAGER_ROLE"))
		await context.collateral.mint(depositor.address, 100n)
		await context.collateral.connect(depositor).approve(context.diamond, 100n)
		await context.pledgeFacet.connect(depositor).depositPledge(token, 100n)
		await context.pledgeFacet.connect(depositor).requestPledgeWithdraw(token, 60n, depositor.address)

		await context.pledgeFacet.connect(tokenManager).setPledgeTokenWhitelist(token, false)
		await expect(context.pledgeFacet.connect(tokenManager).acceptPledgeWithdraw(depositor.address, 60n, token)).to.be.revertedWith(
			"Accessibility: Must have role",
		)
		await expect(context.pledgeFacet.connect(tokenManager).slashPledge(depositor.address, token, 40n, depositor.address)).to.be.revertedWith(
			"Accessibility: Must have role",
		)
		await expect(context.pledgeFacet.connect(fundsManager).setPledgeTokenWhitelist(token, true)).to.be.revertedWith("Accessibility: Must have role")

		await context.pledgeFacet.connect(fundsManager).acceptPledgeWithdraw(depositor.address, 60n, token)
		await context.pledgeFacet.connect(fundsManager).slashPledge(depositor.address, token, 40n, depositor.address)
		expect(await context.collateral.balanceOf(depositor.address)).to.equal(100n)
	})

	it("rejects whitelist management through a configured signer context", async function () {
		const token = await context.collateral.getAddress()
		await context.controlFacet.setSigner(context.signers.user.address)
		await expect(context.pledgeFacet.setPledgeTokenWhitelist(token, false)).to.be.revertedWith("Accessibility: Cannot call via proxy")
		await context.controlFacet.setSigner(ethers.ZeroAddress)
		expect(await context.pledgeFacet.isPledgeTokenWhitelisted(token)).to.equal(true)
	})

	it("rejects zero addresses and approval of addresses without code", async function () {
		await expect(context.pledgeFacet.setPledgeTokenWhitelist(ethers.ZeroAddress, true)).to.be.revertedWith("PledgeFacet: Zero address")
		await expect(context.pledgeFacet.setPledgeTokenWhitelist(context.signers.user.address, true)).to.be.revertedWith("PledgeFacet: Token has no code")
	})

	it("allows managers to remove tokens while accounting is paused", async function () {
		const token = await context.collateral.getAddress()
		await context.pauseControlFacet.pauseAccounting()
		await context.pledgeFacet.setPledgeTokenWhitelist(token, false)
		expect(await context.pledgeFacet.isPledgeTokenWhitelisted(token)).to.equal(false)
	})

	it("requires explicit approval and preserves raw token amounts for unregistered depositors", async function () {
		const tokenContract = await (await ethers.getContractFactory("MockERC20")).deploy("Pledge USD", "PUSD", 6)
		const token = await tokenContract.getAddress()
		const user = context.signers.user
		const amount = 1_500_001n
		await tokenContract.mint(user.address, amount)
		await tokenContract.connect(user).approve(context.diamond, amount)
		expect(await context.viewFacet.isPartyB(user.address)).to.equal(false)
		expect(await context.pledgeFacet.isPledgeTokenWhitelisted(token)).to.equal(false)

		await expect(context.pledgeFacet.connect(user).depositPledge(token, amount)).to.be.revertedWith("PledgeFacet: Token is not whitelisted")
		expect(await tokenContract.balanceOf(user.address)).to.equal(amount)
		expect(await tokenContract.balanceOf(context.diamond)).to.equal(0n)
		await expect(context.pledgeFacet.connect(user).requestPledgeWithdraw(token, amount, user.address)).to.be.revertedWith(
			"AccountFacet: insufficient Pledge collateral",
		)

		await context.pledgeFacet.setPledgeTokenWhitelist(token, true)
		await expect(context.pledgeFacet.connect(user).depositPledge(token, amount))
			.to.emit(context.pledgeFacet, "PledgeCollateralDeposited")
			.withArgs(user.address, token, amount)
		expect(await tokenContract.balanceOf(context.diamond)).to.equal(amount)
		await context.pledgeFacet.connect(user).requestPledgeWithdraw(token, amount, user.address)
		await context.pledgeFacet.acceptPledgeWithdraw(user.address, amount, token)
		expect(await tokenContract.balanceOf(user.address)).to.equal(amount)
	})

	it("uses the effective signer as the token owner and pledge account", async function () {
		const token = await context.collateral.getAddress()
		const user = context.signers.user
		const amount = 100n
		await context.collateral.mint(user.address, amount)
		await context.collateral.connect(user).approve(context.diamond, amount)
		await context.controlFacet.setSigner(user.address)
		await expect(context.pledgeFacet.depositPledge(token, amount))
			.to.emit(context.pledgeFacet, "PledgeCollateralDeposited")
			.withArgs(user.address, token, amount)
		await context.controlFacet.setSigner(ethers.ZeroAddress)

		expect(await context.collateral.balanceOf(user.address)).to.equal(0n)
		await context.pledgeFacet.connect(user).requestPledgeWithdraw(token, amount, user.address)
		await context.pledgeFacet.acceptPledgeWithdraw(user.address, amount, token)
		expect(await context.collateral.balanceOf(user.address)).to.equal(amount)
	})

	it("blocks further deposits after removal while preserving cancellation, withdrawal and slashing", async function () {
		const token = await context.collateral.getAddress()
		const user = context.signers.user
		const recipient = context.signers.user2.address
		await context.collateral.mint(user.address, 101n)
		await context.collateral.connect(user).approve(context.diamond, 101n)
		await context.pledgeFacet.connect(user).depositPledge(token, 100n)
		await context.pledgeFacet.connect(user).requestPledgeWithdraw(token, 70n, recipient)

		await context.pledgeFacet.setPledgeTokenWhitelist(token, false)
		await expect(context.pledgeFacet.connect(user).depositPledge(token, 1n)).to.be.revertedWith("PledgeFacet: Token is not whitelisted")
		expect(await context.collateral.balanceOf(user.address)).to.equal(1n)
		await context.pledgeFacet.connect(user).cancelPledgeWithdraw()
		await context.pledgeFacet.connect(user).requestPledgeWithdraw(token, 70n, recipient)
		await context.pledgeFacet.acceptPledgeWithdraw(user.address, 30n, token)
		await context.pledgeFacet.slashPledge(user.address, token, 70n, recipient)
		expect(await context.collateral.balanceOf(recipient)).to.equal(100n)
		await expect(context.pledgeFacet.connect(user).requestPledgeWithdraw(token, 1n, recipient)).to.be.revertedWith(
			"AccountFacet: insufficient Pledge collateral",
		)

		await context.pledgeFacet.setPledgeTokenWhitelist(token, true)
		await context.pledgeFacet.connect(user).depositPledge(token, 1n)
		expect(await context.collateral.balanceOf(user.address)).to.equal(0n)
	})
})
