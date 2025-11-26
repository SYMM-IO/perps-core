import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import { expect, use } from "chai";
import { initializeFixture } from "./Initialize.fixture"
import { RunContext } from "./models/RunContext"
import { User } from "./models/User"
import { Hedger } from "./models/Hedger"
import { ethers } from "hardhat"
import { WithdrawStatus } from "./models/Enums";


export function shouldBehaveLikeWithdrawFacet(): void {
	let context: RunContext, user: User, user2: User, hedger: Hedger
	let expressProvider: any, virtualProvider: any
	let receiver1: string, receiver2: string


	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		user = new User(context, context.signers.user)
		await context.controlFacet.setMaxWithdrawParts(50)
		await context.controlFacet.setWithdrawCooldownPeriod(12)
		await user.setup()
		await user.setBalances(ethers.parseEther("500"))
	})

	describe("Normal Withdraw", async function () {
		it("Should initiate withdraw", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: ethers.ZeroAddress,
				},
				{
					id: 1,
					amount: ethers.parseUnits("20", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: ethers.ZeroAddress,
				}
			]
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,"0x")).not.to.reverted;
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.status).to.be.equal(WithdrawStatus.PENDING)
			expect(withdrawRequest.parts[0].amount + withdrawRequest.parts[1].amount).to.be.equal(ethers.parseUnits("70", 18))
		})

		it("Should finalize withdraw", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: ethers.ZeroAddress,
				},
				{
					id: 1,
					amount: ethers.parseUnits("20", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: ethers.ZeroAddress,
				}
			]
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,"0x");
			await time.increase(1000);
			const balanceBefore = await context.collateral.balanceOf(user.address);
			await expect(context.withdrawFacet.connect(context.signers.user).finalizeWithdrawRequest(1)).not.to.reverted;
			const balanceAfter = await context.collateral.balanceOf(user.address);
			expect(balanceAfter - balanceBefore).be.equal(ethers.parseUnits("70", 18))
		})

		it("Should request to cancel withdraw", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: ethers.ZeroAddress,
				},
				{
					id: 1,
					amount: ethers.parseUnits("20", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: ethers.ZeroAddress,
				}
			]
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,"0x");
			await expect(context.withdrawFacet.connect(context.signers.user).requestCancelWithdraw(1)).not.reverted;
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.status).to.be.equal(WithdrawStatus.CANCELLED)
		})
	})

	describe("Virtual Withdraw", async function () {

		beforeEach(async function() {
			const MockVirtualProvider = await ethers.getContractFactory("contracts/test/MockVirtualProvider.sol:VirtualProvider")
			virtualProvider = await MockVirtualProvider.deploy(context.diamond)
			await virtualProvider.waitForDeployment()
			let virtualProviderAddress = await virtualProvider.getAddress()

			await context.controlFacet.connect(context.signers.admin).registerVirtualProvider(virtualProviderAddress)
			await context.controlFacet.connect(context.signers.admin).grantRole(context.signers.admin.address, ethers.keccak256(ethers.toUtf8Bytes("VIRTUAL_DEPOSITOR_ROLE")))
		})

		it("Should initiate withdraw", async function () {
			await context.accountFacet.connect(context.signers.admin).virtualDepositFor(user.address,ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let virtualProviderAddress = await virtualProvider.getAddress()
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: virtualProviderAddress,
					expressProvider: ethers.ZeroAddress,
				},
				{
					id: 1,
					amount: ethers.parseUnits("20", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: virtualProviderAddress,
					expressProvider: ethers.ZeroAddress,
				}
			]
			const balanceBefore = await context.viewFacet.balanceOf(user.address);
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,"0x")).not.to.reverted;
			const balanceAfter = await context.viewFacet.balanceOf(user.address);
			expect(balanceBefore - balanceAfter).to.be.equal(ethers.parseUnits("70",18))
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.parts[0].amount + withdrawRequest.parts[1].amount).to.be.equal(ethers.parseUnits("70", 18))
		})

		it("Should finalize withdraw", async function () {
			await context.accountFacet.connect(context.signers.admin).virtualDepositFor(user.address,ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let virtualProviderAddress = await virtualProvider.getAddress()
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: virtualProviderAddress,
					expressProvider: ethers.ZeroAddress,
				},
				{
					id: 1,
					amount: ethers.parseUnits("20", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: virtualProviderAddress,
					expressProvider: ethers.ZeroAddress,
				}
			]
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,"0x");
			await expect(virtualProvider.acceptWithdrawRequest(user.address, 1)).not.to.reverted;
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.status).to.be.equal(WithdrawStatus.PROVIDER_ACCEPTED)
			await time.increase(1000)
			await expect(context.withdrawFacet.connect(context.signers.user).finalizeWithdrawRequest(1)).not.to.reverted;
			expect(await virtualProvider.withdrawnAmount()).to.be.equal(ethers.parseUnits("70", 18))
		})

		it("Should request to cancel withdraw", async function () {
			await context.accountFacet.connect(context.signers.admin).virtualDepositFor(user.address,ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let virtualProviderAddress = await virtualProvider.getAddress()
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: virtualProviderAddress,
					expressProvider: ethers.ZeroAddress,
				},
				{
					id: 1,
					amount: ethers.parseUnits("20", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: virtualProviderAddress,
					expressProvider: ethers.ZeroAddress,
				}
			]
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,"0x");
			await expect(context.withdrawFacet.connect(context.signers.user).requestCancelWithdraw(1)).not.reverted;
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.status).to.be.equal(WithdrawStatus.CANCEL_REQUESTED)
			await expect(virtualProvider.acceptWithdrawCancelRequest(user.address, 1)).not.to.reverted;
			const updatedWithdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(updatedWithdrawRequest.status).to.be.equal(WithdrawStatus.CANCELLED)
		})
	})

	describe("Express Withdraw", async function () {
		it("Should initiate withdraw", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: ethers.ZeroAddress,
				},
				{
					id: 1,
					amount: ethers.parseUnits("20", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: ethers.ZeroAddress,
				}
			]
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,"0x")).not.to.reverted;
		})

		it("Should finalize withdraw", async function () {

		})

		it("Should request to cancel withdraw", async function () {

		})
	})

	describe("Virtual Express Withdraw", async function () {
		it("Should initiate withdraw", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: ethers.ZeroAddress,
				},
				{
					id: 1,
					amount: ethers.parseUnits("20", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: ethers.ZeroAddress,
				}
			]
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,"0x")).not.to.reverted;
		})

		it("Should finalize withdraw", async function () {

		})

		it("Should request to cancel withdraw", async function () {

		})
	})

}
