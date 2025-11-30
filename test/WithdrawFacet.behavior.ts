import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import { expect, use } from "chai";
import { initializeFixture } from "./Initialize.fixture"
import { RunContext } from "./models/RunContext"
import { User } from "./models/User"
import { Hedger } from "./models/Hedger"
import { ethers } from "hardhat"
import { WithdrawStatus } from "./models/Enums";
import { exceptions } from "winston";


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
		await context.collateral.mint(context.signers.admin.address, ethers.parseEther("10000"))
		await context.controlFacet.connect(context.signers.admin).grantRole(context.signers.admin.address, ethers.keccak256(ethers.toUtf8Bytes("WITHDRAW_SPEED_UP_ROLE")))
		await context.controlFacet.connect(context.signers.admin).grantRole(context.signers.admin.address, ethers.keccak256(ethers.toUtf8Bytes("SETTER_ROLE")))
	})

	describe("Provider Register" , async function (){
		it("Should register virtual provider", async function () {
			const MockVirtualProvider = await ethers.getContractFactory("contracts/test/MockVirtualProvider.sol:VirtualProvider")
			virtualProvider = await MockVirtualProvider.deploy(context.diamond)
			await virtualProvider.waitForDeployment()
			let virtualProviderAddress = await virtualProvider.getAddress()
			await expect(context.controlFacet.connect(context.signers.admin).registerVirtualProvider(virtualProviderAddress)).not.reverted;
			expect(await context.viewFacet.isVirtualProviderRegistered(virtualProviderAddress)).to.be.equal(true);
		})
		it("Should register express provider", async function () {
			const MockExpressProvider = await ethers.getContractFactory("contracts/test/MockExpressProvider.sol:ExpressProvider")
			expressProvider = await MockExpressProvider.deploy(context.diamond)
			await expressProvider.waitForDeployment()
			let expressProviderAddress = await expressProvider.getAddress()
			await expect(context.controlFacet.connect(context.signers.admin).registerExpressProvider(expressProviderAddress)).not.reverted;
			expect(await context.viewFacet.isExpressProviderRegistered(expressProviderAddress)).to.be.equal(true);
		})
		it("Should fail to register express provider as virtual provider", async function () {
			const MockVirtualProvider = await ethers.getContractFactory("contracts/test/MockVirtualProvider.sol:VirtualProvider")
			virtualProvider = await MockVirtualProvider.deploy(context.diamond)
			await virtualProvider.waitForDeployment()
			let virtualProviderAddress = await virtualProvider.getAddress()
			await context.controlFacet.connect(context.signers.admin).registerVirtualProvider(virtualProviderAddress);

			const MockExpressProvider = await ethers.getContractFactory("contracts/test/MockExpressProvider.sol:ExpressProvider")
			expressProvider = await MockExpressProvider.deploy(context.diamond)
			await expressProvider.waitForDeployment()
			let expressProviderAddress = await expressProvider.getAddress()
			await context.controlFacet.connect(context.signers.admin).registerExpressProvider(expressProviderAddress);

			await expect(context.controlFacet.connect(context.signers.admin).registerVirtualProvider(expressProviderAddress)).to.revertedWith("ControlFacet: Already a express provider");
			await expect(context.controlFacet.connect(context.signers.admin).registerExpressProvider(virtualProviderAddress)).to.revertedWith("ControlFacet: Already a virtual provider");
		})
	})

	describe("Suspended User", async function () {
		beforeEach(async function() {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			this.parts = [
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
		})
		it("Should not initiate withdraw for suspended user", async function () {
			await context.controlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(this.parts,false,"0x")).to.revertedWith("Accessibility: Sender is Suspended");
		})
		it("Should not finalize withdraw for suspended user", async function () {
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(this.parts,false,"0x")
			await context.controlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)
			await expect(context.withdrawFacet.connect(context.signers.user).finalizeWithdrawRequest(user.address,1)).to.revertedWith("Accessibility: Sender is Suspended");
		})
		it("Should not cancel withdraw for suspended user", async function () {
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(this.parts,false,"0x")
			await context.controlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)
			await expect(context.withdrawFacet.connect(context.signers.user).requestCancelWithdraw(1)).to.revertedWith("Accessibility: Sender is Suspended");
		})
		it("Should suspend withdraw for suspended user", async function () {
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(this.parts,false,"0x")
			await context.controlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)
			const beforeBalance = await context.viewFacet.balanceOf(user.address);
			await expect(context.withdrawFacet.connect(context.signers.user).suspendWithdrawRequest(user.address,1)).not.reverted;
			const afterBalance = await context.viewFacet.balanceOf(user.address);
			expect(afterBalance - beforeBalance).to.equal(ethers.parseUnits("70", 18))
		})

	})

	describe("Normal Withdraw", async function () {

		it("Should fail to initiate withdraw with more than 50 parts", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = []
			for (let i = 0; i < 51; i++) {
				parts.push({
					id: 1,
					amount: ethers.parseUnits("1", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: ethers.ZeroAddress,
				})
			}
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x")).to.revertedWith("Too many withdraw parts");
		})

		it("Should initiate withdraw with 50 parts", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = []
			for (let i = 0; i < 50; i++) {
				parts.push({
					id: 1,
					amount: ethers.parseUnits("1", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: ethers.ZeroAddress,
				})
			}
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x")).not.reverted;
		})

		it("Should fail to initiate withdraw with amounts more than balance", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("120", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: ethers.ZeroAddress,
				},
			]
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x")).to.revertedWith("WithdrawFacet: Insufficient balance");
		})

		it("Should initiate withdraw correctly", async function () {
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
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x")).not.to.reverted;
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.status).to.be.equal(WithdrawStatus.PENDING)
			expect(withdrawRequest.parts[0].amount + withdrawRequest.parts[1].amount).to.be.equal(ethers.parseUnits("70", 18))
		})

		it("Should fail to finalize withdraw before passing cooldown", async function () {
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
			]
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
			await expect(context.withdrawFacet.connect(context.signers.user).finalizeWithdrawRequest(user.address,1)).to.revertedWith("Withdraw cooldown not over");
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
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
			await time.increase(1000);
			const balanceBefore = await context.collateral.balanceOf(user.address);
			await expect(context.withdrawFacet.connect(context.signers.user).finalizeWithdrawRequest(user.address,1)).not.to.reverted;
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
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
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

		it("Should fail to initiate withdraw with more than 50 parts", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = []
			for (let i = 0; i < 51; i++) {
				parts.push({
					id: 1,
					amount: ethers.parseUnits("1", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: await virtualProvider.getAddress(),
					expressProvider: ethers.ZeroAddress
				})
			}
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x")).to.revertedWith("Too many withdraw parts");
		})

		it("Should initiate withdraw with 50 parts", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = []
			for (let i = 0; i < 50; i++) {
				parts.push({
					id: 1,
					amount: ethers.parseUnits("1", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: await virtualProvider.getAddress(),
					expressProvider: ethers.ZeroAddress
				})
			}
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x")).not.reverted;
		})

		it("Should fail to initiate withdraw with amounts more than balance", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("120", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: await virtualProvider.getAddress(),
					expressProvider: ethers.ZeroAddress
				},
			]
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x")).to.revertedWith("WithdrawFacet: Insufficient balance");
		})

		it("Should fail to initiate withdraw with more than one virtual provider", async function () {
			const MockVirtualProvider = await ethers.getContractFactory("contracts/test/MockVirtualProvider.sol:VirtualProvider")
			const virtualProvider2 = await MockVirtualProvider.deploy(context.diamond)
			await virtualProvider2.waitForDeployment()
			let virtualProviderAddress2 = await virtualProvider2.getAddress()

			await context.controlFacet.connect(context.signers.admin).registerVirtualProvider(virtualProviderAddress2)
			await context.collateral.transfer(virtualProviderAddress2, ethers.parseUnits("1000", 18));

			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("20", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: await virtualProvider.getAddress(),
					expressProvider: ethers.ZeroAddress
				},
				{
					id: 1,
					amount: ethers.parseUnits("20", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: await virtualProvider2.getAddress(),
					expressProvider: ethers.ZeroAddress
				},
			]
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x")).to.revertedWith("Multiple virtual providers not allowed");
		})

		it("Should initiate withdraw correctly", async function () {
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
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x")).not.to.reverted;
			const balanceAfter = await context.viewFacet.balanceOf(user.address);
			expect(balanceBefore - balanceAfter).to.be.equal(ethers.parseUnits("70",18))
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.parts[0].amount + withdrawRequest.parts[1].amount).to.be.equal(ethers.parseUnits("70", 18))
		})

		it("Should fail to finalize withdraw before passing cooldown", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: await virtualProvider.getAddress(),
					expressProvider: ethers.ZeroAddress,
				},
			]
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
			await expect(context.withdrawFacet.connect(context.signers.user).finalizeWithdrawRequest(user.address,1)).to.revertedWith("Withdraw cooldown not over");
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
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
			await expect(virtualProvider.acceptWithdrawRequest(user.address, 1)).not.to.reverted;
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.status).to.be.equal(WithdrawStatus.PROVIDER_ACCEPTED)
			await time.increase(1000)
			await expect(context.withdrawFacet.connect(context.signers.user).finalizeWithdrawRequest(user.address,1)).not.to.reverted;
			expect(await virtualProvider.withdrawnAmount()).to.be.equal(ethers.parseUnits("70", 18))
		})

		it("Should reject withdraw if provider wants", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: await virtualProvider.getAddress(),
					expressProvider: ethers.ZeroAddress,
				}
			]
			const beforeBalace = await context.viewFacet.balanceOf(user.address)
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
			await expect(virtualProvider.rejectWithdrawRequest(user.address, 1)).not.reverted;
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.status).to.be.equal(WithdrawStatus.PROVIDER_REJECTED)
			const afterBalance = await context.viewFacet.balanceOf(user.address)
			expect(afterBalance).to.be.equal(beforeBalace)
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
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
			await virtualProvider.acceptWithdrawRequest(user.address, 1);
			await expect(context.withdrawFacet.connect(context.signers.user).requestCancelWithdraw(1)).not.reverted;
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.status).to.be.equal(WithdrawStatus.CANCEL_REQUESTED)
			await expect(virtualProvider.acceptWithdrawCancelRequest(user.address, 1)).not.to.reverted;
			const updatedWithdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(updatedWithdrawRequest.status).to.be.equal(WithdrawStatus.CANCELLED)
		})

		it("Should fail to force cancel withdraw before cooldown", async function () {
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
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
			await virtualProvider.acceptWithdrawRequest(user.address, 1);
			await context.withdrawFacet.connect(context.signers.user).requestCancelWithdraw(1);
			await expect(context.withdrawFacet.connect(context.signers.user).forceCancelWithdraw(1)).to.revertedWith("Withdraw cooldown not over");
		})

		it("Should force cancel withdraw after cooldown", async function () {
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
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
			await virtualProvider.acceptWithdrawRequest(user.address, 1);
			await context.withdrawFacet.connect(context.signers.user).requestCancelWithdraw(1);
			await time.increase(1000);
			await expect(context.withdrawFacet.connect(context.signers.user).forceCancelWithdraw(1)).not.reverted;
			const updatedWithdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(updatedWithdrawRequest.status).to.be.equal(WithdrawStatus.CANCELLED)
		})
	})

	describe("Express Withdraw", async function () {

		beforeEach(async function() {
			const MockExpressProvider = await ethers.getContractFactory("contracts/test/MockExpressProvider.sol:ExpressProvider")
			expressProvider = await MockExpressProvider.deploy(context.diamond)
			await expressProvider.waitForDeployment()
			let expressProviderAddress = await expressProvider.getAddress()

			await context.controlFacet.connect(context.signers.admin).registerExpressProvider(expressProviderAddress)
			await context.collateral.transfer(expressProviderAddress, ethers.parseUnits("1000", 18));

		})

		it("Should fail to initiate withdraw with more than 50 parts", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = []
			for (let i = 0; i < 51; i++) {
				parts.push({
					id: 1,
					amount: ethers.parseUnits("1", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: await expressProvider.getAddress()
				})
			}
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x")).to.revertedWith("Too many withdraw parts");
		})

		it("Should initiate withdraw with 50 parts", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = []
			for (let i = 0; i < 50; i++) {
				parts.push({
					id: 1,
					amount: ethers.parseUnits("1", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: await expressProvider.getAddress()
				})
			}
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x")).not.reverted;
		})

		it("Should fail to initiate withdraw with amounts more than balance", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("120", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: await expressProvider.getAddress()
				},
			]
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x")).to.revertedWith("WithdrawFacet: Insufficient balance");
		})

		it("Should fail to initiate withdraw with more than one express provider", async function () {
			const MockExpressProvider = await ethers.getContractFactory("contracts/test/MockExpressProvider.sol:ExpressProvider")
			const expressProvider2 = await MockExpressProvider.deploy(context.diamond)
			await expressProvider2.waitForDeployment()
			let expressProviderAddress2 = await expressProvider2.getAddress()

			await context.controlFacet.connect(context.signers.admin).registerExpressProvider(expressProviderAddress2)
			await context.collateral.transfer(expressProviderAddress2, ethers.parseUnits("1000", 18));

			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("20", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: await expressProvider.getAddress()
				},
				{
					id: 1,
					amount: ethers.parseUnits("20", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: await expressProvider2.getAddress()
				},
			]
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x")).to.revertedWith("Multiple express providers not allowed");
		})


		it("Should initiate withdraw correctly", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let expressProviderAddress = await expressProvider.getAddress()
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressProviderAddress
				},
				{
					id: 1,
					amount: ethers.parseUnits("20", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressProviderAddress
				}
			]
			const symmioBalanceBefore = await context.viewFacet.balanceOf(user.address);
			const tokenBalanceBefore = await context.collateral.balanceOf(user.address);
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x")).not.to.reverted;
			const symmioBalanceAfter = await context.viewFacet.balanceOf(user.address);
			const tokenBalanceAfter = await context.collateral.balanceOf(user.address);
			expect(symmioBalanceBefore - symmioBalanceAfter).to.be.equal(tokenBalanceAfter - tokenBalanceBefore)
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.parts[0].amount + withdrawRequest.parts[1].amount).to.be.equal(ethers.parseUnits("70", 18))
		})

		it("Should fail to finalize withdraw before passing cooldown", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: await expressProvider.getAddress()
				},
			]
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
			await expect(context.withdrawFacet.connect(context.signers.user).finalizeWithdrawRequest(user.address,1)).to.revertedWith("Withdraw cooldown not over");
		})

		it("Should finalize withdraw", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let expressProviderAddress = await expressProvider.getAddress()
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressProviderAddress
				},
				{
					id: 1,
					amount: ethers.parseUnits("20", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressProviderAddress
				}
			]
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
			await expect(expressProvider.acceptWithdrawRequest(user.address, 1)).not.to.reverted;
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.status).to.be.equal(WithdrawStatus.PROVIDER_ACCEPTED)
			await time.increase(1000)
			const expressBalanceBefore = await context.collateral.balanceOf(expressProviderAddress);
			await expect(expressProvider.finalizeWithdrawRequest(user.address,1)).not.to.reverted;
			const expressBalanceAfter = await context.collateral.balanceOf(expressProviderAddress);
			expect(expressBalanceAfter - expressBalanceBefore).to.be.equal(ethers.parseUnits("70", 18))
		})

		it("Should reject withdraw if provider wants", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: await expressProvider.getAddress()
				}
			]
			const beforeBalace = await context.viewFacet.balanceOf(user.address)
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
			await expect(expressProvider.rejectWithdrawRequest(user.address, 1)).not.reverted;
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.status).to.be.equal(WithdrawStatus.PROVIDER_REJECTED)
			const afterBalance = await context.viewFacet.balanceOf(user.address)
			expect(afterBalance).to.be.equal(beforeBalace)
		})


		it("Should request to cancel withdraw", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let expressProviderAddress = await expressProvider.getAddress()
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressProviderAddress
				},
				{
					id: 1,
					amount: ethers.parseUnits("20", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: expressProviderAddress
				}
			]
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
			await expressProvider.acceptWithdrawRequest(user.address, 1);
			await expect(context.withdrawFacet.connect(context.signers.user).requestCancelWithdraw(1)).not.reverted;
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.status).to.be.equal(WithdrawStatus.CANCEL_REQUESTED)
			await expect(expressProvider.acceptWithdrawCancelRequest(user.address, 1)).not.to.reverted;
			const updatedWithdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(updatedWithdrawRequest.status).to.be.equal(WithdrawStatus.CANCELLED)
		})

		it("Should fail to force cancel withdraw with express provider", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: ethers.ZeroAddress,
					expressProvider: await expressProvider.getAddress(),
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
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
			await expressProvider.acceptWithdrawRequest(user.address, 1);
			await context.withdrawFacet.connect(context.signers.user).requestCancelWithdraw(1);
			time.increase(1000)
			await expect(context.withdrawFacet.connect(context.signers.user).forceCancelWithdraw(1)).to.revertedWith("Not a pure virtual withdraw");
		})
	})


	describe("Virtual Express Withdraw", async function () {

		beforeEach(async function() {
			const MockExpressProvider = await ethers.getContractFactory("contracts/test/MockExpressProvider.sol:ExpressProvider")
			expressProvider = await MockExpressProvider.deploy(context.diamond)
			await expressProvider.waitForDeployment()
			let expressProviderAddress = await expressProvider.getAddress()

			const MockVirtualProvider = await ethers.getContractFactory("contracts/test/MockVirtualProvider.sol:VirtualProvider")
			virtualProvider = await MockVirtualProvider.deploy(context.diamond)
			await virtualProvider.waitForDeployment()
			let virtualProviderAddress = await virtualProvider.getAddress()

			await context.controlFacet.connect(context.signers.admin).registerVirtualProvider(virtualProviderAddress)
			await context.controlFacet.connect(context.signers.admin).registerExpressProvider(expressProviderAddress)
			await context.collateral.transfer(expressProviderAddress, ethers.parseUnits("1000", 18));
		})

		it("Should initiate withdraw", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let expressProviderAddress = await expressProvider.getAddress()
			let virtualProviderAddress = await virtualProvider.getAddress()
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: virtualProviderAddress,
					expressProvider: expressProviderAddress
				},
				{
					id: 1,
					amount: ethers.parseUnits("20", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: virtualProviderAddress,
					expressProvider: expressProviderAddress
				}
			]
			const balanceBefore = await context.viewFacet.balanceOf(user.address);
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x")).not.to.reverted;
			const balanceAfter = await context.viewFacet.balanceOf(user.address);
			expect(balanceBefore - balanceAfter).to.be.equal(ethers.parseUnits("70",18))
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.status).to.be.equal(WithdrawStatus.PENDING)
			expect(withdrawRequest.parts[0].amount + withdrawRequest.parts[1].amount).to.be.equal(ethers.parseUnits("70", 18))
		})

		it("Should fail to finalize withdraw before passing cooldown", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: await virtualProvider.getAddress(),
					expressProvider: await expressProvider.getAddress()
				},
			]
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
			await expect(context.withdrawFacet.connect(context.signers.user).finalizeWithdrawRequest(user.address,1)).to.revertedWith("Withdraw cooldown not over");
		})

		it("Should finalize withdraw", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let expressProviderAddress = await expressProvider.getAddress()
			let virtualProviderAddress = await virtualProvider.getAddress()
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: virtualProviderAddress,
					expressProvider: expressProviderAddress
				},
				{
					id: 1,
					amount: ethers.parseUnits("20", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: virtualProviderAddress,
					expressProvider: expressProviderAddress
				}
			]
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
			await expect(expressProvider.acceptWithdrawRequest(user.address, 1)).not.to.reverted;
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.status).to.be.equal(WithdrawStatus.PROVIDER_ACCEPTED)
			await time.increase(1000)
			const expressBalanceBefore = await context.collateral.balanceOf(expressProviderAddress);
			await expect(expressProvider.finalizeWithdrawRequest(user.address,1)).not.to.reverted;
			const expressBalanceAfter = await context.collateral.balanceOf(expressProviderAddress);
			expect(expressBalanceAfter - expressBalanceBefore).to.be.equal(0)
		})

		it("Should reject withdraw if provider wants", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: await virtualProvider.getAddress(),
					expressProvider: await expressProvider.getAddress()
				}
			]
			const beforeBalace = await context.viewFacet.balanceOf(user.address)
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
			await expect(expressProvider.rejectWithdrawRequest(user.address, 1)).not.reverted;
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.status).to.be.equal(WithdrawStatus.PROVIDER_REJECTED)
			const afterBalance = await context.viewFacet.balanceOf(user.address)
			expect(afterBalance).to.be.equal(beforeBalace)
		})


		it("Should request to cancel withdraw", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let expressProviderAddress = await expressProvider.getAddress()
			let virtualProviderAddress = await virtualProvider.getAddress()
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: virtualProviderAddress,
					expressProvider: expressProviderAddress
				},
				{
					id: 1,
					amount: ethers.parseUnits("20", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: virtualProviderAddress,
					expressProvider: expressProviderAddress
				}
			]
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
			await expressProvider.acceptWithdrawRequest(user.address, 1);
			await expect(context.withdrawFacet.connect(context.signers.user).requestCancelWithdraw(1)).not.reverted;
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.status).to.be.equal(WithdrawStatus.CANCEL_REQUESTED)
			await expect(expressProvider.acceptWithdrawCancelRequest(user.address, 1)).not.to.reverted;
			const updatedWithdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(updatedWithdrawRequest.status).to.be.equal(WithdrawStatus.CANCELLED)
		})

		it("Should fail to force cancel withdraw with express provider", async function () {
			await context.accountFacet.connect(context.signers.user).deposit(ethers.parseEther("100"))
			receiver1 = context.signers.user.address;
			let virtualProviderAddress = await virtualProvider.getAddress()
			let parts = [
				{
					id: 1,
					amount: ethers.parseUnits("50", 18),
					chainId: 1,
					receiver: ethers.dataSlice(receiver1, 0, 20), // bytes20
					virtualProvider: await virtualProvider.getAddress(),
					expressProvider: await expressProvider.getAddress(),
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
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x");
			await expressProvider.acceptWithdrawRequest(user.address, 1);
			await context.withdrawFacet.connect(context.signers.user).requestCancelWithdraw(1);
			time.increase(1000)
			await expect(context.withdrawFacet.connect(context.signers.user).forceCancelWithdraw(1)).to.revertedWith("Not a pure virtual withdraw");
		})
	})

	describe("Withdraw Speed Up",async function () {
		beforeEach(async function() {
			const MockVirtualProvider = await ethers.getContractFactory("contracts/test/MockVirtualProvider.sol:VirtualProvider")
			virtualProvider = await MockVirtualProvider.deploy(context.diamond)
			await virtualProvider.waitForDeployment()
			let virtualProviderAddress = await virtualProvider.getAddress()

			await context.controlFacet.connect(context.signers.admin).registerVirtualProvider(virtualProviderAddress)
			await context.collateral.transfer(virtualProviderAddress, ethers.parseUnits("1000", 18));
		})
		it("Should fail to speed up withdraw without role", async function () {
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
				}
			]
			await context.controlFacet.connect(context.signers.admin).setSpeedUpUser(user.address)
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,true,"0x")
			await expect(context.withdrawFacet.connect(context.signers.user).acceptSpeedUpRequest(user.address,1 , 10)).to.revertedWith("Accessibility: Must has role");
		})

		it("Should speed up withdraw for classic withdrawals", async function () {
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
				}
			]
			await context.controlFacet.connect(context.signers.admin).setSpeedUpUser(user.address)
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,true,"0x")
			await expect(context.withdrawFacet.connect(context.signers.admin).acceptSpeedUpRequest(user.address,1 , 10)).not.reverted;
		})

		it("Should speed up withdraw for virtual withdrawals", async function () {

		})

		it("Should set speed up user", async function () {

		})

		it("Should unset speed up user", async function () {

		})

		it("Should fail to lower cooldown less than threshold", async function () {

		})

		it("Should unset speed up user", async function () {

		})

		it("Should fail to speed up withdraw with express", async function () {

		})


	})

}
