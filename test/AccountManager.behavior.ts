import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs"
import { expect } from "chai"

import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { loadFixture } from "./helpers/network-helpers.js"

const symmioInterface = new ethers.Interface([
	"function depositFor(address account,uint256 amount)",
	"function depositAndAllocateFor(address account,uint256 amount)",
	"function withdrawTo(address account,uint256 amount)",
])

const coreInterface = new ethers.Interface([
	"function depositForAccount(address account,uint256 amount)",
	"function depositAndAllocateForAccount(address account,uint256 amount)",
	"function depositForAccountWithExpressRate(address account,uint256 amount)",
	"function depositAndAllocateForAccountWithExpressRate(address account,uint256 amount)",
])

async function accountManagerFixture() {
	const context = await initializeFixture()
	return {
		...context,
		token: context.collateral,
		signers: {
			deployer: context.signers.admin,
			user: context.signers.user,
			user2: context.signers.user2,
			distributor: context.signers.feeCollector,
		},
	}
}

export function shouldBehaveLikeAccountManager(): void {
	describe("AccountManager", function () {
		describe("constructor", function () {
			it("stores the account layer reference", async function () {
				const context = await loadFixture(accountManagerFixture)
				expect(await context.accountManager.getAccountHub()).to.equal(context.accountLayerDiamond)
			})
		})

		describe("addAccount", function () {
			it("creates a sub-account through AccountLayer and emits events", async function () {
				const context = await loadFixture(accountManagerFixture)
				const prediction = await context.accountManager.connect(context.signers.user).addAccount.staticCall("Trading account")
				await expect(context.accountManager.connect(context.signers.user).addAccount("Trading account"))
					.to.emit(context.accountManager, "AddAccount")
					.withArgs(context.signers.user.address, prediction[0], "Trading account")

				expect(prediction[0]).to.not.equal(ethers.ZeroAddress)

				const details = await context.alViewFacet.getUserSubAccounts(context.signers.user.address, 0, 10)
				expect(details.length).to.equal(1)
				expect(details[0].accountAddress).to.equal(prediction[0])
				expect(details[0].owner).to.equal(context.signers.user.address)
				expect(details[0].affiliate).to.equal(await context.accountManager.getAddress())
				expect(details[0].name).to.equal("Trading account")
				expect(details[0].metadata).to.equal("0x")
				expect(details[0].symmioCore).to.equal(context.diamond)
				expect(details[0].isolationType).to.equal(3n)

				expect(await context.alViewFacet.connect(context.signers.deployer).getSigner()).to.equal(context.signers.deployer.address)
			})

			it("always picks the first configured symmio core", async function () {
				const context = await loadFixture(accountManagerFixture)
				const MockSymmioCore = await ethers.getContractFactory("MockAffiliateHub")
				const coreA = await MockSymmioCore.deploy()
				await coreA.setCollateral(await context.token.getAddress())
				await context.alControlFacet.connect(context.signers.deployer).setWhitelistedSymmioCore(await coreA.getAddress(), true)

				const affiliateData = {
					name: "test affiliate multi core",
					brandColor: "d69d00",
					admin: context.signers.deployer.address,
					stakeholders: [
						{
							receiver: context.signers.deployer.address,
							share: 900000000000000000n,
						},
					],
					symmioShare: 100000000000000000n,
					metadata: "0x",
					legacyMultiAccounts: [],
					symmioCores: [await coreA.getAddress(), context.diamond],
				}

				const affiliateAddress = await context.alAffiliateFacet.connect(context.signers.deployer).requestToRegisterAffiliate.staticCall(affiliateData)
				await context.alAffiliateFacet.connect(context.signers.deployer).requestToRegisterAffiliate(affiliateData)
				await context.alAffiliateFacet.connect(context.signers.deployer).approveAffiliate(affiliateAddress)

				const accManager = await ethers.getContractAt("contracts/accountLayer/AccountManager.sol:AccountManager", affiliateAddress)

				const prediction = await accManager.connect(context.signers.user).addAccount.staticCall("Trading account")
				await accManager.connect(context.signers.user).addAccount("Trading account")

				const details = await context.alViewFacet.getUserSubAccounts(context.signers.user.address, 0, 10)
				expect(details.length).to.equal(1)
				expect(details[0].accountAddress).to.equal(prediction[0])
				expect(details[0].symmioCore).to.equal(await coreA.getAddress())
			})

			it("reverts if affiliate has no configured cores", async function () {
				const context = await loadFixture(accountManagerFixture)
				const affiliateData = {
					name: "test affiliate no cores",
					brandColor: "d69d00",
					admin: context.signers.deployer.address,
					stakeholders: [
						{
							receiver: context.signers.deployer.address,
							share: 900000000000000000n,
						},
					],
					symmioShare: 100000000000000000n,
					metadata: "0x",
					legacyMultiAccounts: [],
					symmioCores: [],
				}

				const affiliateAddress = await context.alAffiliateFacet.connect(context.signers.deployer).requestToRegisterAffiliate.staticCall(affiliateData)
				await context.alAffiliateFacet.connect(context.signers.deployer).requestToRegisterAffiliate(affiliateData)
				await context.alAffiliateFacet.connect(context.signers.deployer).approveAffiliate(affiliateAddress)

				const accManager = await ethers.getContractAt("contracts/accountLayer/AccountManager.sol:AccountManager", affiliateAddress)
				await expect(accManager.connect(context.signers.user).addAccount("Trading account")).to.be.reverted
			})

			it("resets the signer even when createSubAccounts reverts", async function () {
				const context = await loadFixture(accountManagerFixture)
				await expect(context.accountManager.connect(context.signers.user).addAccount("")).to.be.revertedWithCustomError(
					context.alCoreFacet,
					"InvalidNameLength",
				)
				expect(await context.alViewFacet.connect(context.signers.deployer).getSigner()).to.equal(context.signers.deployer.address)
			})
		})

		describe("depositForAccount", function () {
			it("forwards the deposit call via AccountLayer with signer wrapper", async function () {
				const context = await loadFixture(accountManagerFixture)
				const accountPrediction = await context.accountManager.connect(context.signers.user).addAccount.staticCall("Deposit account")
				await context.accountManager.connect(context.signers.user).addAccount("Deposit account")
				const account = accountPrediction[0]
				const amount = ethers.parseUnits("250", 18)

				await context.token.mint(context.signers.user.address, amount)
				await context.token.connect(context.signers.user).approve(context.diamond, amount)

				const userBalanceBefore = await context.token.balanceOf(context.signers.user.address)
				const hubBalanceBefore = await context.token.balanceOf(context.accountLayerDiamond)
				const managerBalanceBefore = await context.token.balanceOf(await context.accountManager.getAddress())
				const coreBalanceBefore = await context.token.balanceOf(context.diamond)
				const balanceBefore = await context.viewFacet.balanceOf(account)

				await expect(context.accountManager.connect(context.signers.user).depositForAccount(account, amount)).to.not.be.reverted

				const userBalanceAfter = await context.token.balanceOf(context.signers.user.address)
				const hubBalanceAfter = await context.token.balanceOf(context.accountLayerDiamond)
				const managerBalanceAfter = await context.token.balanceOf(await context.accountManager.getAddress())
				const coreBalanceAfter = await context.token.balanceOf(context.diamond)
				const balanceAfter = await context.viewFacet.balanceOf(account)

				expect(userBalanceBefore - userBalanceAfter).to.equal(amount)
				expect(hubBalanceAfter - hubBalanceBefore).to.equal(0n)
				expect(managerBalanceAfter - managerBalanceBefore).to.equal(0n)
				expect(coreBalanceAfter - coreBalanceBefore).to.equal(amount)
				expect(balanceAfter - balanceBefore).to.equal(amount)

				expect(await context.alViewFacet.connect(context.signers.deployer).getSigner()).to.equal(context.signers.deployer.address)
			})

			it("resets signer when AccountLayer call reverts", async function () {
				const context = await loadFixture(accountManagerFixture)
				const accountPrediction = await context.accountManager.connect(context.signers.user).addAccount.staticCall("Deposit account")
				await context.accountManager.connect(context.signers.user).addAccount("Deposit account")
				const account = accountPrediction[0]

				await expect(context.accountManager.connect(context.signers.user).depositForAccount(account, 0)).to.be.revertedWithCustomError(
					context.alCoreFacet,
					"ZeroAmount",
				)
				expect(await context.alViewFacet.connect(context.signers.deployer).getSigner()).to.equal(context.signers.deployer.address)
			})
		})

		describe("depositAndAllocateForAccount", function () {
			it("forwards the deposit+allocate call via AccountLayer with signer wrapper", async function () {
				const context = await loadFixture(accountManagerFixture)
				const accountPrediction = await context.accountManager.connect(context.signers.user).addAccount.staticCall("Deposit and allocate account")
				await context.accountManager.connect(context.signers.user).addAccount("Deposit and allocate account")
				const account = accountPrediction[0]
				const amount = ethers.parseUnits("50", 18)

				await context.token.mint(context.signers.user.address, amount)
				await context.token.connect(context.signers.user).approve(context.diamond, amount)

				const userBalanceBefore = await context.token.balanceOf(context.signers.user.address)
				const hubBalanceBefore = await context.token.balanceOf(context.accountLayerDiamond)
				const managerBalanceBefore = await context.token.balanceOf(await context.accountManager.getAddress())
				const coreBalanceBefore = await context.token.balanceOf(context.diamond)
				const balanceBefore = await context.viewFacet.balanceOf(account)
				const allocatedBefore = await context.viewFacet.allocatedBalanceOfPartyA(account)

				await expect(context.accountManager.connect(context.signers.user).depositAndAllocateForAccount(account, amount)).to.not.be.reverted

				const userBalanceAfter = await context.token.balanceOf(context.signers.user.address)
				const hubBalanceAfter = await context.token.balanceOf(context.accountLayerDiamond)
				const managerBalanceAfter = await context.token.balanceOf(await context.accountManager.getAddress())
				const coreBalanceAfter = await context.token.balanceOf(context.diamond)
				const balanceAfter = await context.viewFacet.balanceOf(account)
				const allocatedAfter = await context.viewFacet.allocatedBalanceOfPartyA(account)

				expect(userBalanceBefore - userBalanceAfter).to.equal(amount)
				expect(hubBalanceAfter - hubBalanceBefore).to.equal(0n)
				expect(managerBalanceAfter - managerBalanceBefore).to.equal(0n)
				expect(coreBalanceAfter - coreBalanceBefore).to.equal(amount)
				expect(balanceAfter - balanceBefore).to.equal(0n)
				expect(allocatedAfter - allocatedBefore).to.equal(amount)

				expect(await context.alViewFacet.connect(context.signers.deployer).getSigner()).to.equal(context.signers.deployer.address)
			})

			it("resets signer when AccountLayer call reverts", async function () {
				const context = await loadFixture(accountManagerFixture)
				const accountPrediction = await context.accountManager.connect(context.signers.user).addAccount.staticCall("Deposit and allocate account")
				await context.accountManager.connect(context.signers.user).addAccount("Deposit and allocate account")
				const account = accountPrediction[0]

				await expect(context.accountManager.connect(context.signers.user).depositAndAllocateForAccount(account, 0)).to.be.revertedWithCustomError(
					context.alCoreFacet,
					"ZeroAmount",
				)

				expect(await context.alViewFacet.connect(context.signers.deployer).getSigner()).to.equal(context.signers.deployer.address)
			})
		})

		describe("depositForAccountWithExpressRate", function () {
			it("forwards express deposit call via AccountLayer", async function () {
				const context = await loadFixture(accountManagerFixture)
				const accountPrediction = await context.accountManager.connect(context.signers.user).addAccount.staticCall("Express deposit account")
				await context.accountManager.connect(context.signers.user).addAccount("Express deposit account")
				const account = accountPrediction[0]
				const amount = ethers.parseUnits("25", 18)

				await context.token.mint(context.signers.user.address, amount)
				await context.token.connect(context.signers.user).approve(context.accountLayerDiamond, amount)

				const userBalanceBefore = await context.token.balanceOf(context.signers.user.address)
				const hubBalanceBefore = await context.token.balanceOf(context.accountLayerDiamond)
				const managerBalanceBefore = await context.token.balanceOf(await context.accountManager.getAddress())
				const coreBalanceBefore = await context.token.balanceOf(context.diamond)
				const balanceBefore = await context.viewFacet.balanceOf(account)

				await expect(context.accountManager.connect(context.signers.user).depositForAccountWithExpressRate(account, amount)).to.not.be.reverted

				const userBalanceAfter = await context.token.balanceOf(context.signers.user.address)
				const hubBalanceAfter = await context.token.balanceOf(context.accountLayerDiamond)
				const managerBalanceAfter = await context.token.balanceOf(await context.accountManager.getAddress())
				const coreBalanceAfter = await context.token.balanceOf(context.diamond)
				const balanceAfter = await context.viewFacet.balanceOf(account)

				expect(userBalanceBefore - userBalanceAfter).to.equal(amount)
				expect(hubBalanceAfter - hubBalanceBefore).to.equal(0n)
				expect(managerBalanceAfter - managerBalanceBefore).to.equal(0n)
				expect(coreBalanceAfter - coreBalanceBefore).to.equal(amount)
				expect(balanceAfter - balanceBefore).to.equal(amount)

				expect(await context.alViewFacet.connect(context.signers.deployer).getSigner()).to.equal(context.signers.deployer.address)
			})

			it("resets signer when AccountLayer call reverts", async function () {
				const context = await loadFixture(accountManagerFixture)
				const accountPrediction = await context.accountManager.connect(context.signers.user).addAccount.staticCall("Express deposit account")
				await context.accountManager.connect(context.signers.user).addAccount("Express deposit account")
				const account = accountPrediction[0]

				await expect(context.accountManager.connect(context.signers.user).depositForAccountWithExpressRate(account, 0)).to.be.revertedWithCustomError(
					context.alCoreFacet,
					"ZeroAmount",
				)

				expect(await context.alViewFacet.connect(context.signers.deployer).getSigner()).to.equal(context.signers.deployer.address)
			})
		})

		describe("depositAndAllocateForAccountWithExpressRate", function () {
			it("forwards express deposit+allocate call via AccountLayer", async function () {
				const context = await loadFixture(accountManagerFixture)
				const accountPrediction = await context.accountManager
					.connect(context.signers.user)
					.addAccount.staticCall("Express deposit and allocate account")
				await context.accountManager.connect(context.signers.user).addAccount("Express deposit and allocate account")
				const account = accountPrediction[0]
				const amount = ethers.parseUnits("40", 18)

				await context.token.mint(context.signers.user.address, amount)
				await context.token.connect(context.signers.user).approve(context.accountLayerDiamond, amount)

				const userBalanceBefore = await context.token.balanceOf(context.signers.user.address)
				const hubBalanceBefore = await context.token.balanceOf(context.accountLayerDiamond)
				const managerBalanceBefore = await context.token.balanceOf(await context.accountManager.getAddress())
				const coreBalanceBefore = await context.token.balanceOf(context.diamond)
				const balanceBefore = await context.viewFacet.balanceOf(account)
				const allocatedBefore = await context.viewFacet.allocatedBalanceOfPartyA(account)

				await expect(context.accountManager.connect(context.signers.user).depositAndAllocateForAccountWithExpressRate(account, amount)).to.not.be
					.reverted

				const userBalanceAfter = await context.token.balanceOf(context.signers.user.address)
				const hubBalanceAfter = await context.token.balanceOf(context.accountLayerDiamond)
				const managerBalanceAfter = await context.token.balanceOf(await context.accountManager.getAddress())
				const coreBalanceAfter = await context.token.balanceOf(context.diamond)
				const balanceAfter = await context.viewFacet.balanceOf(account)
				const allocatedAfter = await context.viewFacet.allocatedBalanceOfPartyA(account)

				expect(userBalanceBefore - userBalanceAfter).to.equal(amount)
				expect(hubBalanceAfter - hubBalanceBefore).to.equal(0n)
				expect(managerBalanceAfter - managerBalanceBefore).to.equal(0n)
				expect(coreBalanceAfter - coreBalanceBefore).to.equal(amount)
				expect(balanceAfter - balanceBefore).to.equal(0n)
				expect(allocatedAfter - allocatedBefore).to.equal(amount)

				expect(await context.alViewFacet.connect(context.signers.deployer).getSigner()).to.equal(context.signers.deployer.address)
			})

			it("resets signer when AccountLayer call reverts", async function () {
				const context = await loadFixture(accountManagerFixture)
				const accountPrediction = await context.accountManager
					.connect(context.signers.user)
					.addAccount.staticCall("Express deposit and allocate account")
				await context.accountManager.connect(context.signers.user).addAccount("Express deposit and allocate account")
				const account = accountPrediction[0]

				await expect(
					context.accountManager.connect(context.signers.user).depositAndAllocateForAccountWithExpressRate(account, 0),
				).to.be.revertedWithCustomError(context.alCoreFacet, "ZeroAmount")

				expect(await context.alViewFacet.connect(context.signers.deployer).getSigner()).to.equal(context.signers.deployer.address)
			})
		})

		describe("withdrawFromAccount", function () {
			it("generates the withdraw call and resets the signer", async function () {
				const context = await loadFixture(accountManagerFixture)
				const accountPrediction = await context.accountManager.connect(context.signers.user).addAccount.staticCall("Withdraw account")
				await context.accountManager.connect(context.signers.user).addAccount("Withdraw account")
				const account = accountPrediction[0]
				const amount = ethers.parseUnits("10", 18)

				await context.token.mint(context.signers.user.address, amount)
				await context.token.connect(context.signers.user).approve(context.diamond, amount)
				await context.accountManager.connect(context.signers.user).depositForAccount(account, amount)

				const withdrawCallData = symmioInterface.encodeFunctionData("withdrawTo", [context.signers.user.address, amount])
				await expect(context.accountManager.connect(context.signers.user).withdrawFromAccount(account, amount))
					.to.emit(context.alCoreFacet, "Call")
					.withArgs(context.signers.user.address, account, withdrawCallData, true, anyValue)

				expect(await context.alViewFacet.connect(context.signers.deployer).getSigner()).to.equal(context.signers.deployer.address)
			})

			it("allows withdrawing to a custom recipient", async function () {
				const context = await loadFixture(accountManagerFixture)
				const accountPrediction = await context.accountManager.connect(context.signers.user).addAccount.staticCall("Withdraw to recipient")
				await context.accountManager.connect(context.signers.user).addAccount("Withdraw to recipient")
				const account = accountPrediction[0]
				const amount = ethers.parseUnits("10", 18)
				const recipient = context.signers.user2.address

				await context.token.mint(context.signers.user.address, amount)
				await context.token.connect(context.signers.user).approve(context.diamond, amount)
				await context.accountManager.connect(context.signers.user).depositForAccount(account, amount)

				const withdrawCallData = symmioInterface.encodeFunctionData("withdrawTo", [recipient, amount])
				await expect(context.accountManager.connect(context.signers.user).withdrawFromAccountTo(account, recipient, amount))
					.to.emit(context.alCoreFacet, "Call")
					.withArgs(context.signers.user.address, account, withdrawCallData, true, anyValue)

				expect(await context.alViewFacet.connect(context.signers.deployer).getSigner()).to.equal(context.signers.deployer.address)
			})

			it("resets signer even when AccountLayer._call reverts", async function () {
				const context = await loadFixture(accountManagerFixture)
				const accountPrediction = await context.accountManager.connect(context.signers.user).addAccount.staticCall("Withdraw account")
				await context.accountManager.connect(context.signers.user).addAccount("Withdraw account")
				const account = accountPrediction[0]
				const amount = ethers.parseUnits("2", 18)
				await expect(context.accountManager.connect(context.signers.user).withdrawFromAccount(account, amount)).to.be.reverted
				expect(await context.alViewFacet.connect(context.signers.deployer).getSigner()).to.equal(context.signers.deployer.address)
			})
		})

		describe("_call passthrough", function () {
			it("forwards arbitrary calls via AccountLayer with signer context", async function () {
				const context = await loadFixture(accountManagerFixture)
				const accountPrediction = await context.accountManager.connect(context.signers.user).addAccount.staticCall("Call account")
				await context.accountManager.connect(context.signers.user).addAccount("Call account")
				const account = accountPrediction[0]
				const payload = context.viewFacet.interface.encodeFunctionData("balanceOf", [account])

				await expect(context.accountManager.connect(context.signers.user)._call(account, [payload]))
					.to.emit(context.alCoreFacet, "Call")
					.withArgs(context.signers.user.address, account, payload, true, anyValue)

				expect(await context.alViewFacet.connect(context.signers.deployer).getSigner()).to.equal(context.signers.deployer.address)
			})

			it("resets signer when passthrough call reverts", async function () {
				const context = await loadFixture(accountManagerFixture)
				const accountPrediction = await context.accountManager.connect(context.signers.user).addAccount.staticCall("Call account")
				await context.accountManager.connect(context.signers.user).addAccount("Call account")
				const account = accountPrediction[0]
				const payload = ethers.hexlify(ethers.randomBytes(32))
				await expect(context.accountManager.connect(context.signers.user)._call(account, [payload])).to.be.reverted
				expect(await context.alViewFacet.connect(context.signers.deployer).getSigner()).to.equal(context.signers.deployer.address)
			})
		})

		describe("view helpers", function () {
			it("exposes account layer address", async function () {
				const context = await loadFixture(accountManagerFixture)
				expect(await context.accountManager.getAccountHub()).to.equal(context.accountLayerDiamond)
			})
		})
	})
}
