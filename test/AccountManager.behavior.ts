import { loadFixture } from "./helpers/network-helpers.js"
import { expect } from "chai"
import { ethers } from "./helpers/hardhat-connection.js"

const symmioInterface = new ethers.Interface([
	"function depositFor(address account,uint256 amount)",
	"function depositAndAllocateFor(address account,uint256 amount)",
	"function withdrawTo(address account,uint256 amount)",
])

const coreInterface = new ethers.Interface([
	"function depositForAccountWithExpressRate(address account,uint256 amount)",
	"function depositAndAllocateForAccountWithExpressRate(address account,uint256 amount)",
])

async function accountManagerFixture() {
	const [deployer, user, user2, distributor] = await ethers.getSigners()

	const Token = await ethers.getContractFactory("MockToken")
	const token = await Token.deploy("Mock Collateral", "MCOL")

	const SymmioCore = await ethers.getContractFactory("MockSymmioCoreForAccountManager")
	const symmioCore = await SymmioCore.deploy()
	await symmioCore.setCollateral(await token.getAddress())

	const AffiliateHubMock = await ethers.getContractFactory("MockAffiliateHubForAccountManager")
	const affiliateHubMock = await AffiliateHubMock.deploy()

	const AccountHubMock = await ethers.getContractFactory("MockAccountHubForAccountManager")
	const accountHubMock = await AccountHubMock.deploy()
	// Set affiliateHub on accountHubMock so AccountManager can access it
	await accountHubMock.setAffiliateHub(await affiliateHubMock.getAddress())

	const AccountManager = await ethers.getContractFactory("AccountManager")
	const accountManager = await AccountManager.deploy(await accountHubMock.getAddress())

	await accountHubMock.setAffiliateCores(await accountManager.getAddress(), [await symmioCore.getAddress()])

	return {
		token,
		symmioCore,
		accountHubMock,
		affiliateHubMock,
		accountManager,
		signers: { deployer, user, user2, distributor },
	}
}

export function shouldBehaveLikeAccountManager(): void {
	describe("AccountManager", function () {
		describe("constructor", function () {
			it("stores the account hub reference", async function () {
				const context = await loadFixture(accountManagerFixture)
				expect(await context.accountManager.getAccountHub()).to.equal(await context.accountHubMock.getAddress())
			})
		})

		describe("addAccount", function () {
			it("creates a sub-account through AccountHub and emits events", async function () {
				const context = await loadFixture(accountManagerFixture)
				const expectedAccount = ethers.Wallet.createRandom().address
				await context.accountHubMock.resetTracking()
				await context.accountHubMock.configureNextCreateResult([expectedAccount])

				const prediction = await context.accountManager.connect(context.signers.user).addAccount.staticCall("Desk-1")
				await expect(context.accountManager.connect(context.signers.user).addAccount("Desk-1"))
					.to.emit(context.accountManager, "AddAccount")
					.withArgs(context.signers.user.address, expectedAccount, "Desk-1")

				expect(prediction[0]).to.equal(expectedAccount)
				expect(await context.accountHubMock.lastCreateAffiliate()).to.equal(await context.accountManager.getAddress())

				const createData = await context.accountHubMock.getLastCreateData()
				expect(createData.length).to.equal(1)
				expect(createData[0].name).to.equal("Desk-1")
				expect(createData[0].metadata).to.equal("0x")
				expect(createData[0].symmioCore).to.equal(await context.symmioCore.getAddress())
				expect(createData[0].isolationType).to.equal(3n)

				const signerLog = await context.accountHubMock.getSignerLog()
				expect(signerLog).to.deep.equal([context.signers.user.address, ethers.ZeroAddress])
			})

			it("always picks the first configured symmio core", async function () {
				const context = await loadFixture(accountManagerFixture)
				const coreA = ethers.Wallet.createRandom().address
				const coreB = ethers.Wallet.createRandom().address
				await context.accountHubMock.setAffiliateCores(await context.accountManager.getAddress(), [coreA, coreB])

				await context.accountHubMock.resetTracking()
				await context.accountManager.connect(context.signers.user).addAccount("Desk-2")

				const createData = await context.accountHubMock.getLastCreateData()
				expect(createData[0].symmioCore).to.equal(coreA)
			})

			it("reverts if affiliate hub has no configured cores", async function () {
				const context = await loadFixture(accountManagerFixture)
				await context.accountHubMock.setAffiliateCores(await context.accountManager.getAddress(), [])
				await expect(context.accountManager.connect(context.signers.user).addAccount("Desk-3")).to.be.revertedWith("MockAffiliateHub: no cores configured")
			})

			it("resets the signer even when createSubAccounts reverts", async function () {
				const context = await loadFixture(accountManagerFixture)
				await context.accountHubMock.resetTracking()
				await context.accountHubMock.setRevertOnCreate(true)
				await expect(context.accountManager.connect(context.signers.user).addAccount("Desk-Err")).to.be.revertedWith("MockAccountHub: create reverted")

				const signerLog = await context.accountHubMock.getSignerLog()
				expect(signerLog.length).to.equal(0)
				expect(await context.accountHubMock.signer()).to.equal(ethers.ZeroAddress)
			})
		})

		describe("depositForAccount", function () {
			it("pulls collateral, approves AccountHub, and forwards call", async function () {
				const context = await loadFixture(accountManagerFixture)
				const account = ethers.Wallet.createRandom().address
				const amount = ethers.parseUnits("250", 18)

				await context.accountHubMock.configureRelatedCore(account, await context.symmioCore.getAddress())
				await context.accountHubMock.resetTracking()

				await context.token.connect(context.signers.deployer).transfer(context.signers.user.address, amount)
				await context.token.connect(context.signers.user).approve(await context.accountManager.getAddress(), amount)

				await expect(context.accountManager.connect(context.signers.user).depositForAccount(account, amount)).to.not.be.reverted

				const allowance = await context.token.allowance(await context.accountManager.getAddress(), await context.accountHubMock.getAddress())
				expect(allowance).to.equal(amount)

				const callData = await context.accountHubMock.getLastCallData()
				expect(callData.length).to.equal(1)
				expect(callData[0]).to.equal(symmioInterface.encodeFunctionData("depositFor", [account, amount]))
				expect(await context.accountHubMock.lastCallAccount()).to.equal(account)

				const signerLog = await context.accountHubMock.getSignerLog()
				expect(signerLog).to.deep.equal([context.signers.user.address, ethers.ZeroAddress])
			})

			it("reverts when caller lacks allowance", async function () {
				const context = await loadFixture(accountManagerFixture)
				const account = ethers.Wallet.createRandom().address
				const amount = ethers.parseUnits("10", 18)
				await context.accountHubMock.configureRelatedCore(account, await context.symmioCore.getAddress())
				await context.token.connect(context.signers.deployer).transfer(context.signers.user.address, amount)
				await expect(context.accountManager.connect(context.signers.user).depositForAccount(account, amount)).to.be.revertedWith(
					"ERC20: insufficient allowance",
				)
			})

			it("increments allowance across multiple deposits", async function () {
				const context = await loadFixture(accountManagerFixture)
				const account = ethers.Wallet.createRandom().address
				const amount1 = ethers.parseUnits("5", 18)
				const amount2 = ethers.parseUnits("7", 18)
				await context.accountHubMock.configureRelatedCore(account, await context.symmioCore.getAddress())

				await context.token.connect(context.signers.deployer).transfer(context.signers.user.address, amount1 + amount2)
				await context.token.connect(context.signers.user).approve(await context.accountManager.getAddress(), amount1 + amount2)

				await context.accountManager.connect(context.signers.user).depositForAccount(account, amount1)
				await context.accountManager.connect(context.signers.user).depositForAccount(account, amount2)

				const allowance = await context.token.allowance(await context.accountManager.getAddress(), await context.accountHubMock.getAddress())
				expect(allowance).to.equal(amount1 + amount2)
			})

			it("requires the related core to be configured", async function () {
				const context = await loadFixture(accountManagerFixture)
				await context.accountHubMock.resetTracking()
				await context.accountHubMock.setRequireRelatedCore(true)
				const account = ethers.Wallet.createRandom().address
				const amount = ethers.parseUnits("1", 18)
				await context.token.connect(context.signers.deployer).transfer(context.signers.user.address, amount)
				await context.token.connect(context.signers.user).approve(await context.accountManager.getAddress(), amount)
				await expect(context.accountManager.connect(context.signers.user).depositForAccount(account, amount)).to.be.revertedWith(
					"MockAccountHub: core not set",
				)
			})
		})

		describe("depositAndAllocateForAccount", function () {
			it("routes the allocate call with the signer wrapper", async function () {
				const context = await loadFixture(accountManagerFixture)
				const account = ethers.Wallet.createRandom().address
				const amount = ethers.parseUnits("50", 18)

				await context.accountHubMock.configureRelatedCore(account, await context.symmioCore.getAddress())
				await context.accountHubMock.resetTracking()

				await context.token.connect(context.signers.deployer).transfer(context.signers.user.address, amount)
				await context.token.connect(context.signers.user).approve(await context.accountManager.getAddress(), amount)

				await expect(context.accountManager.connect(context.signers.user).depositAndAllocateForAccount(account, amount)).to.not.be.reverted

				const callData = await context.accountHubMock.getLastCallData()
				expect(callData[0]).to.equal(symmioInterface.encodeFunctionData("depositAndAllocateFor", [account, amount]))

				const signerLog = await context.accountHubMock.getSignerLog()
				expect(signerLog).to.deep.equal([context.signers.user.address, ethers.ZeroAddress])
			})

			it("resets signer when AccountHub call reverts", async function () {
				const context = await loadFixture(accountManagerFixture)
				const account = ethers.Wallet.createRandom().address
				const amount = ethers.parseUnits("25", 18)
				await context.accountHubMock.configureRelatedCore(account, await context.symmioCore.getAddress())
				await context.token.connect(context.signers.deployer).transfer(context.signers.user.address, amount)
				await context.token.connect(context.signers.user).approve(await context.accountManager.getAddress(), amount)
				await context.accountHubMock.resetTracking()
				await context.accountHubMock.setRevertOnCall(true)
				await expect(context.accountManager.connect(context.signers.user).depositAndAllocateForAccount(account, amount)).to.be.revertedWith(
					"MockAccountHub: call reverted",
				)
				const signerLog = await context.accountHubMock.getSignerLog()
				expect(signerLog.length).to.equal(0)
				expect(await context.accountHubMock.signer()).to.equal(ethers.ZeroAddress)
			})
		})

		describe("depositForAccountWithExpressRate", function () {
			it("forwards express deposit call via AccountHub", async function () {
				const context = await loadFixture(accountManagerFixture)
				const account = ethers.Wallet.createRandom().address
				const amount = ethers.parseUnits("25", 18)

				await context.accountHubMock.resetTracking()

				await context.accountManager.connect(context.signers.user).depositForAccountWithExpressRate(account, amount)

				const callData = await context.accountHubMock.getLastCallData()
				expect(callData[0]).to.equal(coreInterface.encodeFunctionData("depositForAccountWithExpressRate", [account, amount]))

				const signerLog = await context.accountHubMock.getSignerLog()
				expect(signerLog).to.deep.equal([context.signers.user.address, ethers.ZeroAddress])
			})

			it("resets signer when AccountHub call reverts", async function () {
				const context = await loadFixture(accountManagerFixture)
				const account = ethers.Wallet.createRandom().address
				const amount = ethers.parseUnits("25", 18)

				await context.accountHubMock.resetTracking()
				await context.accountHubMock.setRevertOnCall(true)

				await expect(
					context.accountManager.connect(context.signers.user).depositForAccountWithExpressRate(account, amount),
				).to.be.revertedWith("MockAccountHub: call reverted")

				const signerLog = await context.accountHubMock.getSignerLog()
				expect(signerLog.length).to.equal(0)
				expect(await context.accountHubMock.signer()).to.equal(ethers.ZeroAddress)
			})
		})

		describe("depositAndAllocateForAccountWithExpressRate", function () {
			it("forwards express deposit+allocate call via AccountHub", async function () {
				const context = await loadFixture(accountManagerFixture)
				const account = ethers.Wallet.createRandom().address
				const amount = ethers.parseUnits("40", 18)

				await context.accountHubMock.resetTracking()

				await context.accountManager.connect(context.signers.user).depositAndAllocateForAccountWithExpressRate(account, amount)

				const callData = await context.accountHubMock.getLastCallData()
				expect(callData[0]).to.equal(coreInterface.encodeFunctionData("depositAndAllocateForAccountWithExpressRate", [account, amount]))

				const signerLog = await context.accountHubMock.getSignerLog()
				expect(signerLog).to.deep.equal([context.signers.user.address, ethers.ZeroAddress])
			})

			it("resets signer when AccountHub call reverts", async function () {
				const context = await loadFixture(accountManagerFixture)
				const account = ethers.Wallet.createRandom().address
				const amount = ethers.parseUnits("40", 18)

				await context.accountHubMock.resetTracking()
				await context.accountHubMock.setRevertOnCall(true)

				await expect(
					context.accountManager.connect(context.signers.user).depositAndAllocateForAccountWithExpressRate(account, amount),
				).to.be.revertedWith("MockAccountHub: call reverted")

				const signerLog = await context.accountHubMock.getSignerLog()
				expect(signerLog.length).to.equal(0)
				expect(await context.accountHubMock.signer()).to.equal(ethers.ZeroAddress)
			})
		})

		describe("withdrawFromAccount", function () {
			it("generates the withdraw call and resets the signer", async function () {
				const context = await loadFixture(accountManagerFixture)
				const account = ethers.Wallet.createRandom().address
				const amount = ethers.parseUnits("10", 18)

				await context.accountHubMock.resetTracking()

				await expect(context.accountManager.connect(context.signers.user).withdrawFromAccount(account, amount)).to.not.be.reverted

				const callData = await context.accountHubMock.getLastCallData()
				expect(callData[0]).to.equal(symmioInterface.encodeFunctionData("withdrawTo", [account, amount]))

				const signerLog = await context.accountHubMock.getSignerLog()
				expect(signerLog).to.deep.equal([context.signers.user.address, ethers.ZeroAddress])
			})

			it("resets signer even when AccountHub._call reverts", async function () {
				const context = await loadFixture(accountManagerFixture)
				const account = ethers.Wallet.createRandom().address
				const amount = ethers.parseUnits("2", 18)
				await context.accountHubMock.resetTracking()
				await context.accountHubMock.setRevertOnCall(true)
				await expect(context.accountManager.connect(context.signers.user).withdrawFromAccount(account, amount)).to.be.revertedWith(
					"MockAccountHub: call reverted",
				)
				const signerLog = await context.accountHubMock.getSignerLog()
				expect(signerLog.length).to.equal(0)
				expect(await context.accountHubMock.signer()).to.equal(ethers.ZeroAddress)
			})
		})

		describe("_call passthrough", function () {
			it("forwards arbitrary calls via AccountHub with signer context", async function () {
				const context = await loadFixture(accountManagerFixture)
				const account = ethers.Wallet.createRandom().address
				const payload = ethers.hexlify(ethers.randomBytes(32))

				await context.accountHubMock.resetTracking()

				await context.accountManager.connect(context.signers.user)._call(account, [payload])

				expect(await context.accountHubMock.lastCallAccount()).to.equal(account)
				const storedCallData = await context.accountHubMock.getLastCallData()
				expect(storedCallData[0]).to.equal(payload)

				const signerLog = await context.accountHubMock.getSignerLog()
				expect(signerLog).to.deep.equal([context.signers.user.address, ethers.ZeroAddress])
			})

			it("resets signer when passthrough call reverts", async function () {
				const context = await loadFixture(accountManagerFixture)
				const account = ethers.Wallet.createRandom().address
				const payload = ethers.hexlify(ethers.randomBytes(32))
				await context.accountHubMock.resetTracking()
				await context.accountHubMock.setRevertOnCall(true)
				await expect(context.accountManager.connect(context.signers.user)._call(account, [payload])).to.be.revertedWith(
					"MockAccountHub: call reverted",
				)
				const signerLog = await context.accountHubMock.getSignerLog()
				expect(signerLog.length).to.equal(0)
				expect(await context.accountHubMock.signer()).to.equal(ethers.ZeroAddress)
			})
		})

		describe("view helpers", function () {
			it("exposes account hub address", async function () {
				const context = await loadFixture(accountManagerFixture)
				expect(await context.accountManager.getAccountHub()).to.equal(await context.accountHubMock.getAddress())
			})
		})
	})
}
