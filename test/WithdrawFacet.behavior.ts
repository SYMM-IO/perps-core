import { loadFixture, time } from "./helpers/network-helpers.js";
import { expect } from "chai";
import {ethers} from "./helpers/hardhat-connection.js";

import { initializeFixture } from "./Initialize.fixture.js";
import { RunContext } from "./models/RunContext.js";
import { User } from "./models/User.js";
import { WithdrawStatus } from "./models/Enums.js";

export function shouldBehaveLikeWithdrawFacet(): void {
	let context: RunContext;
	let user: User;
	let expressProvider: any;
	let virtualProvider: any;
	let receiver1: string;

	const toBytes20 = (addr: string) => ethers.dataSlice(addr, 0, 20);

	const roleHash = (name: string) =>
		ethers.keccak256(ethers.toUtf8Bytes(name));

	async function userDeposit(amountEth = "100") {
		await context.accountFacet
			.connect(context.signers.user)
			.deposit(ethers.parseEther(amountEth));
		receiver1 = context.signers.user.address;
	}

	async function buildPart(amountEth: string, overrides: Partial<any> = {}) {
		return {
			id: 1,
			amount: ethers.parseUnits(amountEth, 18),
			chainId: (await ethers.provider.getNetwork()).chainId,
			receiver: toBytes20(receiver1),
			virtualProvider: ethers.ZeroAddress,
			expressProvider: ethers.ZeroAddress,
			...overrides,
		};
	}

	async function buildParts(
		amountsEth: string[],
		overrides: Partial<any> = {}
	): Promise<any[]> {
		return Promise.all(amountsEth.map((amt) => buildPart(amt, overrides)));
	}

	beforeEach(async function() {
		context = await loadFixture(initializeFixture);
		user = new User(context, context.signers.user);

		await context.controlFacet.setMaxWithdrawParts(50);
		await context.controlFacet.setWithdrawCooldownPeriod(12);

		await user.setup();
		await user.setBalances(ethers.parseEther("500"));
		await context.collateral.mint(
			context.signers.admin.address,
			ethers.parseEther("10000")
		);

		await context.controlFacet
			.connect(context.signers.admin)
			.grantRole(
				context.signers.admin.address,
				roleHash("WITHDRAW_SPEED_UP_ROLE")
			);
		await context.controlFacet
			.connect(context.signers.admin)
			.grantRole(
				context.signers.admin.address,
				roleHash("PROVIDER_ADMIN_ROLE")
			);
	});

	describe("Provider Register", function() {
		it("Should register virtual provider", async function() {
			const MockVirtualProvider = await ethers.getContractFactory(
				"contracts/test/MockVirtualProvider.sol:VirtualProvider"
			);
			virtualProvider = await MockVirtualProvider.deploy(context.diamond);
			await virtualProvider.waitForDeployment();
			const virtualProviderAddress = await virtualProvider.getAddress();

			await expect(
				context.controlFacet
					.connect(context.signers.admin)
					.registerVirtualProvider(virtualProviderAddress)
			).not.reverted;
			expect(
				await context.viewFacet.isVirtualProviderRegistered(
					virtualProviderAddress
				)
			).to.equal(true);
		});

		it("Should register express provider", async function() {
			const MockExpressProvider = await ethers.getContractFactory(
				"contracts/test/MockExpressProvider.sol:ExpressProvider"
			);
			expressProvider = await MockExpressProvider.deploy(context.diamond);
			await expressProvider.waitForDeployment();
			const expressProviderAddress = await expressProvider.getAddress();

			await expect(
				context.controlFacet
					.connect(context.signers.admin)
					.registerExpressProvider(expressProviderAddress)
			).not.reverted;
			expect(
				await context.viewFacet.isExpressProviderRegistered(
					expressProviderAddress
				)
			).to.equal(true);
		});

		it("Should fail to register express provider as virtual provider", async function() {
			const MockVirtualProvider = await ethers.getContractFactory(
				"contracts/test/MockVirtualProvider.sol:VirtualProvider"
			);
			virtualProvider = await MockVirtualProvider.deploy(context.diamond);
			await virtualProvider.waitForDeployment();
			const virtualProviderAddress = await virtualProvider.getAddress();

			await context.controlFacet
				.connect(context.signers.admin)
				.registerVirtualProvider(virtualProviderAddress);

			const MockExpressProvider = await ethers.getContractFactory(
				"contracts/test/MockExpressProvider.sol:ExpressProvider"
			);
			expressProvider = await MockExpressProvider.deploy(context.diamond);
			await expressProvider.waitForDeployment();
			const expressProviderAddress = await expressProvider.getAddress();

			await context.controlFacet
				.connect(context.signers.admin)
				.registerExpressProvider(expressProviderAddress);

			await expect(
				context.controlFacet
					.connect(context.signers.admin)
					.registerVirtualProvider(expressProviderAddress)
			).to.revertedWith(
				"ControlFacet: Already a express provider"
			);
			await expect(
				context.controlFacet
					.connect(context.signers.admin)
					.registerExpressProvider(virtualProviderAddress)
			).to.revertedWith(
				"ControlFacet: Already a virtual provider"
			);
		});
	});

	describe("Suspended User", function() {
		let suspendedParts: any[];

		beforeEach(async function() {
			await userDeposit("100");
			suspendedParts = await buildParts(["50", "20"]);
		});

		it("Should not initiate withdraw for suspended user", async function() {
			await context.pauseControlFacet
				.connect(context.signers.admin)
				.suspendedAddress(context.signers.user.address);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(suspendedParts, false, "0x")
			).to.revertedWith("Accessibility: Sender is Suspended");
		});

		it("Should not finalize withdraw for suspended user", async function() {
			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(suspendedParts, false, "0x");

			await context.pauseControlFacet
				.connect(context.signers.admin)
				.suspendedAddress(context.signers.user.address);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.finalizeWithdrawRequest(user.address, 1)
			).to.revertedWith("Accessibility: Sender is Suspended");
		});

		it("Should not cancel withdraw for suspended user", async function() {
			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(suspendedParts, false, "0x");

			await context.pauseControlFacet
				.connect(context.signers.admin)
				.suspendedAddress(context.signers.user.address);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.requestCancelWithdraw(1)
			).to.revertedWith("Accessibility: Sender is Suspended");
		});

		it("Should fail to suspend withdraw for non-suspended user", async function() {
			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(suspendedParts, false, "0x");

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.suspendWithdrawRequest(user.address, 1)
			).to.revertedWith("WithdrawFacet : User is not suspended");
		});

		it("Should fail to suspend withdraw with incorrect request id", async function() {
			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(suspendedParts, false, "0x");

			await context.pauseControlFacet
				.connect(context.signers.admin)
				.suspendedAddress(context.signers.user.address);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.suspendWithdrawRequest(user.address, 2)
			).to.revertedWith("WithdrawFacet : Invalid withdraw request ID")
		});

		it("Should fail to suspend withdraw with incorrect status", async function() {
			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(suspendedParts, false, "0x");

			await context.withdrawFacet
				.connect(context.signers.user)
				.requestCancelWithdraw(1);

			await context.pauseControlFacet
				.connect(context.signers.admin)
				.suspendedAddress(context.signers.user.address);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.suspendWithdrawRequest(user.address, 1)
			).to.revertedWith("WithdrawFacet : Invalid withdraw request status");
		});

		it("Should suspend withdraw for suspended user", async function() {
			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(suspendedParts, false, "0x");

			await context.pauseControlFacet
				.connect(context.signers.admin)
				.suspendedAddress(context.signers.user.address);

			const beforeBalance = await context.viewFacet.balanceOf(
				user.address
			);
			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.suspendWithdrawRequest(user.address, 1)
			).not.reverted;

			const afterBalance = await context.viewFacet.balanceOf(
				user.address
			);
			expect(afterBalance - beforeBalance).to.equal(
				ethers.parseUnits("70", 18)
			);
		});
	});

	describe("Normal Withdraw", function() {

		it("Should fail to initiate withdraw with 0 parts", async function() {
			await userDeposit("100");

			const parts: any[] = [];

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).to.revertedWith("WithdrawFacet : No withdraw parts");
		});

		it("Should fail to initiate withdraw with more than 50 parts", async function() {
			await userDeposit("100");

			const parts: any[] = [];
			for (let i = 0; i < 51; i++) {
				parts.push(await buildPart("1"));
			}

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).to.revertedWith("WithdrawFacet : Too many withdraw parts");
		});

		it("Should initiate withdraw with 50 parts", async function() {
			await userDeposit("100");

			const parts: any[] = [];
			for (let i = 0; i < 50; i++) {
				parts.push(await buildPart("1"));
			}

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).not.reverted;
		});

		it("Should fail to initiate withdraw with amounts more than balance", async function() {
			await userDeposit("100");
			const parts = [await buildPart("120")];

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).to.revertedWith("WithdrawFacet : Insufficient balance");
		});

		it("Should fail to initiate withdraw with wrong chain id", async function() {
			await userDeposit("100");
			const parts = [{
				id: 1,
				amount: ethers.parseUnits("50", 18),
				chainId: 1,
				receiver: toBytes20(receiver1),
				virtualProvider: ethers.ZeroAddress,
				expressProvider: ethers.ZeroAddress}
			];

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).to.revertedWith("WithdrawFacet : Invalid chainId for non-virtual part");
		});

		it("Should fail to initiate withdraw because of amount 0", async function() {
			await userDeposit("100");
			const parts = await buildParts(["50", "0"]);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).to.revertedWith("WithdrawFacet : Not allowed withdrawal zero amount")
		});

		it("Should initiate withdraw correctly", async function() {
			await userDeposit("100");
			const parts = await buildParts(["50", "20"]);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).not.to.reverted;

			const withdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(withdrawRequest.status).to.equal(
				WithdrawStatus.PENDING
			);
			expect(
				withdrawRequest.parts[0].amount +
				withdrawRequest.parts[1].amount
			).to.equal(ethers.parseUnits("70", 18));
		});

		it("Should fail to finalize withdraw before passing cooldown", async function() {
			await userDeposit("100");
			const parts = [await buildPart("50")];

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.finalizeWithdrawRequest(user.address, 1)
			).to.revertedWith("WithdrawFacet : Withdraw cooldown not over");
		});

		it("Should fail to finalize withdraw with wrong id", async function() {
			await userDeposit("100");
			const parts = [await buildPart("50")];

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await time.increase(1000)

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.finalizeWithdrawRequest(user.address, 2)
			).to.revertedWith("WithdrawFacet : Invalid withdraw request ID");
		});

		it("Should fail to finalize withdraw with invalid status", async function() {
			await userDeposit("100");
			const parts = [await buildPart("50")];

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await context.withdrawFacet
				.connect(context.signers.user)
				.requestCancelWithdraw(1);

			await time.increase(1000)

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.finalizeWithdrawRequest(user.address, 1)
			).to.revertedWith("WithdrawFacet : Invalid withdraw request status");
		});

		it("Should finalize withdraw", async function() {
			await userDeposit("100");
			const parts = await buildParts(["50", "20"]);

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");
			await time.increase(1000);

			const balanceBefore = await context.collateral.balanceOf(
				user.address
			);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.finalizeWithdrawRequest(user.address, 1)
			).not.to.reverted;

			const balanceAfter = await context.collateral.balanceOf(
				user.address
			);
			expect(balanceAfter - balanceBefore).be.equal(
				ethers.parseUnits("70", 18)
			);
		});

		it("Should fail to request to cancel withdraw with wrong id", async function() {
			await userDeposit("100");
			const parts = await buildParts(["50", "20"]);

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.requestCancelWithdraw(2)
			).to.revertedWith("WithdrawFacet : Invalid withdraw request ID");
		});

		it("Should fail to request to cancel withdraw with wrong status", async function() {
			await userDeposit("100");
			const parts = await buildParts(["50", "20"]);

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await context.withdrawFacet
				.connect(context.signers.user)
				.requestCancelWithdraw(1);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.requestCancelWithdraw(1)
			).to.revertedWith("WithdrawFacet : Invalid withdraw request status");
		});

		it("Should request to cancel withdraw", async function() {
			await userDeposit("100");
			const parts = await buildParts(["50", "20"]);

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.requestCancelWithdraw(1)
			).not.reverted;

			const withdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(withdrawRequest.status).to.equal(
				WithdrawStatus.CANCELLED
			);
		});
	});

	describe("Virtual Withdraw", function() {
		beforeEach(async function() {
			const MockVirtualProvider = await ethers.getContractFactory(
				"contracts/test/MockVirtualProvider.sol:VirtualProvider"
			);
			virtualProvider = await MockVirtualProvider.deploy(context.diamond);
			await virtualProvider.waitForDeployment();
			const virtualProviderAddress = await virtualProvider.getAddress();

			await context.controlFacet
				.connect(context.signers.admin)
				.registerVirtualProvider(virtualProviderAddress);
			await context.controlFacet
				.connect(context.signers.admin)
				.grantRole(
					context.signers.admin.address,
					roleHash("VIRTUAL_DEPOSITOR_ROLE")
				);
		});

		it("Should fail to initiate withdraw with more than 50 parts", async function() {
			await userDeposit("100");
			const vpAddress = await virtualProvider.getAddress();

			const parts: any[] = [];
			for (let i = 0; i < 51; i++) {
				parts.push(
					await buildPart("1", {
						virtualProvider: vpAddress,
					})
				);
			}

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).to.revertedWith("WithdrawFacet : Too many withdraw parts");
		});

		it("Should initiate withdraw with 50 parts", async function() {
			await userDeposit("100");
			const vpAddress = await virtualProvider.getAddress();

			const parts: any[] = [];
			for (let i = 0; i < 50; i++) {
				parts.push(
					await buildPart("1", {
						virtualProvider: vpAddress,
					})
				);
			}

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).not.reverted;
		});

		it("Should fail to initiate withdraw with amounts more than balance", async function() {
			await userDeposit("100");
			const vpAddress = await virtualProvider.getAddress();

			const parts = [
				await buildPart("120", {
					virtualProvider: vpAddress,
				}),
			];

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).to.revertedWith("WithdrawFacet : Insufficient balance");
		});

		it("Should fail to initiate withdraw with more than one virtual provider", async function() {
			const MockVirtualProvider = await ethers.getContractFactory(
				"contracts/test/MockVirtualProvider.sol:VirtualProvider"
			);
			const virtualProvider2 = await MockVirtualProvider.deploy(
				context.diamond
			);
			await virtualProvider2.waitForDeployment();
			const virtualProviderAddress2 =
				await virtualProvider2.getAddress();

			await context.controlFacet
				.connect(context.signers.admin)
				.registerVirtualProvider(virtualProviderAddress2);
			await context.collateral.transfer(
				virtualProviderAddress2,
				ethers.parseUnits("1000", 18)
			);

			await userDeposit("100");
			const vpAddress1 = await virtualProvider.getAddress();
			const vpAddress2 = await virtualProvider2.getAddress();

			const parts = [
				await buildPart("20", { virtualProvider: vpAddress1 }),
				await buildPart("20", { virtualProvider: vpAddress2 }),
			];

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).to.revertedWith(
				"WithdrawFacet : Multiple virtual providers not allowed"
			);
		});

		it("Should fail to initiate withdraw by a non-registered provider", async function() {
			await virtualProvider.virtualDepositFor(
				context.diamond,
				user.address,
				ethers.parseEther("100")
			);

			receiver1 = context.signers.user.address;
			const vpAddress = await virtualProvider.getAddress();
			const parts = await buildParts(["50", "20"], {
				virtualProvider: vpAddress,
			});

			await context.controlFacet.connect(context.signers.admin).unregisterVirtualProvider(vpAddress);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).to.revertedWith("WithdrawFacet : Not registered virtual provider")
		});

		it("Should initiate withdraw correctly", async function() {
			await virtualProvider.virtualDepositFor(
				context.diamond,
				user.address,
				ethers.parseEther("100")
			);

			receiver1 = context.signers.user.address;
			const vpAddress = await virtualProvider.getAddress();
			const parts = await buildParts(["50", "20"], {
				virtualProvider: vpAddress,
			});

			const balanceBefore = await context.viewFacet.balanceOf(
				user.address
			);
			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).not.to.reverted;

			const balanceAfter = await context.viewFacet.balanceOf(
				user.address
			);
			expect(balanceBefore - balanceAfter).to.equal(
				ethers.parseUnits("70", 18)
			);

			const withdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(
				withdrawRequest.parts[0].amount +
				withdrawRequest.parts[1].amount
			).to.equal(ethers.parseUnits("70", 18));
		});

		it("Should fail to finalize withdraw before passing cooldown", async function() {
			await userDeposit("100");
			const vpAddress = await virtualProvider.getAddress();
			const parts = [await buildPart("50", { virtualProvider: vpAddress })];

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.finalizeWithdrawRequest(user.address, 1)
			).to.revertedWith("WithdrawFacet : Withdraw cooldown not over");
		});

		it("Should fail to accept withdraw with wrong id", async function() {
			await userDeposit("100");
			const vpAddress = await virtualProvider.getAddress();
			const parts = [await buildPart("50", { virtualProvider: vpAddress })];

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expect(
				virtualProvider.acceptWithdrawRequest(user.address, 2)
			).to.revertedWith("WithdrawFacet : Invalid withdraw request ID");
		});

		it("Should fail to accept normal withdraw", async function() {
			await userDeposit("100");
			const vpAddress = await virtualProvider.getAddress();
			const parts = [await buildPart("50")];

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expect(
				virtualProvider.acceptWithdrawRequest(user.address, 1)
			).to.revertedWith("WithdrawFacet : Only Virtual or Express withdraw needs to accept");
		});

		it("Should fail to accept withdraw with wrong status", async function() {
			await userDeposit("100");
			const vpAddress = await virtualProvider.getAddress();
			const parts = [await buildPart("50", { virtualProvider: vpAddress })];
			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");
			await virtualProvider.acceptWithdrawRequest(user.address, 1)
			await expect(
				virtualProvider.acceptWithdrawRequest(user.address, 1)
			).to.revertedWith("WithdrawFacet : Invalid withdraw request status");
		});

		it("Should fail to accept withdraw with wrong provider", async function() {
			await userDeposit("100");
			const vpAddress = await virtualProvider.getAddress();
			const parts = [await buildPart("50", { virtualProvider: vpAddress })];
			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expect(
				context.withdrawFacet.connect(context.signers.user).acceptWithdrawRequest(user.address, 1)
			).to.revertedWith("WithdrawFacet : Not allowed to accept withdrawal");
		});

		it("Should fail to reject withdraw with wrong id", async function() {
			await userDeposit("100");
			const vpAddress = await virtualProvider.getAddress();
			const parts = [await buildPart("50", { virtualProvider: vpAddress })];

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expect(
				virtualProvider.rejectWithdrawRequest(user.address, 2)
			).to.revertedWith("WithdrawFacet : Invalid withdraw request ID");
		});

		it("Should fail to reject normal withdraw", async function() {
			await userDeposit("100");
			const vpAddress = await virtualProvider.getAddress();
			const parts = [await buildPart("50")];

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expect(
				virtualProvider.rejectWithdrawRequest(user.address, 1)
			).to.revertedWith("WithdrawFacet : Only Virtual or Express withdraw needs to accept");
		});

		it("Should fail to reject withdraw with wrong status", async function() {
			await userDeposit("100");
			const vpAddress = await virtualProvider.getAddress();
			const parts = [await buildPart("50", { virtualProvider: vpAddress })];
			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");
			await virtualProvider.acceptWithdrawRequest(user.address, 1)
			await expect(
				virtualProvider.rejectWithdrawRequest(user.address, 1)
			).to.revertedWith("WithdrawFacet : Invalid withdraw request status");
		});

		it("Should fail to reject withdraw with wrong provider", async function() {
			await userDeposit("100");
			const vpAddress = await virtualProvider.getAddress();
			const parts = [await buildPart("50", { virtualProvider: vpAddress })];
			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expect(
				context.withdrawFacet.connect(context.signers.user).rejectWithdrawRequest(user.address, 1)
			).to.revertedWith("WithdrawFacet : Not allowed to accept withdrawal");
		});

		it("Should fail to finalize withdraw with invalid status", async function() {
			await userDeposit("100");
			const vpAddress = await virtualProvider.getAddress();
			const parts = [await buildPart("50", { virtualProvider: vpAddress })];

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await time.increase(1000);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.finalizeWithdrawRequest(user.address, 1)
			).to.revertedWith("WithdrawFacet : Invalid withdraw request status");
		});

		it("Should finalize withdraw", async function() {
			await virtualProvider.virtualDepositFor(
				context.diamond,
				user.address,
				ethers.parseEther("100")
			);

			receiver1 = context.signers.user.address;
			const vpAddress = await virtualProvider.getAddress();
			const parts = await buildParts(["50", "20"], {
				virtualProvider: vpAddress,
			});

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");
			await expect(
				virtualProvider.acceptWithdrawRequest(user.address, 1)
			).not.to.reverted;

			const withdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(withdrawRequest.status).to.equal(
				WithdrawStatus.PROVIDER_ACCEPTED
			);

			await time.increase(1000);
			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.finalizeWithdrawRequest(user.address, 1)
			).not.to.reverted;

			expect(
				await virtualProvider.withdrawnAmount()
			).to.equal(ethers.parseUnits("70", 18));
		});

		it("Should reject withdraw if provider wants", async function() {
			await userDeposit("100");
			const vpAddress = await virtualProvider.getAddress();
			const parts = [await buildPart("50", { virtualProvider: vpAddress })];

			const beforeBalance =
				await context.viewFacet.balanceOf(user.address);

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expect(
				virtualProvider.rejectWithdrawRequest(user.address, 1)
			).not.reverted;

			const withdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(withdrawRequest.status).to.equal(
				WithdrawStatus.PROVIDER_REJECTED
			);

			const afterBalance = await context.viewFacet.balanceOf(
				user.address
			);
			expect(afterBalance).to.equal(beforeBalance);
		});

		it("Should request to cancel withdraw", async function() {
			await virtualProvider.virtualDepositFor(
				context.diamond,
				user.address,
				ethers.parseEther("100")
			);

			receiver1 = context.signers.user.address;
			const vpAddress = await virtualProvider.getAddress();
			const parts = await buildParts(["50", "20"], {
				virtualProvider: vpAddress,
			});

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await virtualProvider.acceptWithdrawRequest(user.address, 1);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.requestCancelWithdraw(1)
			).not.reverted;

			const withdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(withdrawRequest.status).to.equal(
				WithdrawStatus.CANCEL_REQUESTED
			);

			await expect(
				virtualProvider.acceptWithdrawCancelRequest(
					user.address,
					1
				)
			).not.to.reverted;

			const updatedWithdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(updatedWithdrawRequest.status).to.equal(
				WithdrawStatus.CANCELLED
			);
		});

		it("Should fail to force cancel withdraw before cooldown", async function() {
			await virtualProvider.virtualDepositFor(
				context.diamond,
				user.address,
				ethers.parseEther("100")
			);

			receiver1 = context.signers.user.address;
			const vpAddress = await virtualProvider.getAddress();
			const parts = await buildParts(["50", "20"], {
				virtualProvider: vpAddress,
			});

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");
			await virtualProvider.acceptWithdrawRequest(user.address, 1);
			await context.withdrawFacet
				.connect(context.signers.user)
				.requestCancelWithdraw(1);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.forceCancelWithdraw(1)
			).to.revertedWith("WithdrawFacet : Withdraw cooldown not over");
		});

		it("Should fail to force cancel withdraw with wrong request Id", async function() {
			await virtualProvider.virtualDepositFor(
				context.diamond,
				user.address,
				ethers.parseEther("100")
			);

			receiver1 = context.signers.user.address;
			const vpAddress = await virtualProvider.getAddress();
			const parts = await buildParts(["50", "20"], {
				virtualProvider: vpAddress,
			});

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");
			await virtualProvider.acceptWithdrawRequest(user.address, 1);
			await context.withdrawFacet
				.connect(context.signers.user)
				.requestCancelWithdraw(1);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.forceCancelWithdraw(2)
			).to.revertedWith("WithdrawFacet : Invalid withdraw request ID");
		});

		it("Should fail to force cancel withdraw with invalid status", async function() {
			await virtualProvider.virtualDepositFor(
				context.diamond,
				user.address,
				ethers.parseEther("100")
			);

			receiver1 = context.signers.user.address;
			const vpAddress = await virtualProvider.getAddress();
			const parts = await buildParts(["50", "20"], {
				virtualProvider: vpAddress,
			});

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");
			await virtualProvider.acceptWithdrawRequest(user.address, 1);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.forceCancelWithdraw(1)
			).to.revertedWith("WithdrawFacet : Invalid withdraw request status");
		});

		it("Should force cancel withdraw after cooldown", async function() {
			await virtualProvider.virtualDepositFor(
				context.diamond,
				user.address,
				ethers.parseEther("100")
			);

			receiver1 = context.signers.user.address;
			const vpAddress = await virtualProvider.getAddress();
			const parts = await buildParts(["50", "20"], {
				virtualProvider: vpAddress,
			});

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");
			await virtualProvider.acceptWithdrawRequest(user.address, 1);
			await context.withdrawFacet
				.connect(context.signers.user)
				.requestCancelWithdraw(1);
			await time.increase(1000);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.forceCancelWithdraw(1)
			).not.reverted;

			const updatedWithdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(updatedWithdrawRequest.status).to.equal(
				WithdrawStatus.CANCELLED
			);
		});
	});

	describe("Express Withdraw", function() {
		beforeEach(async function() {
			const MockExpressProvider = await ethers.getContractFactory(
				"contracts/test/MockExpressProvider.sol:ExpressProvider"
			);
			expressProvider = await MockExpressProvider.deploy(
				context.diamond
			);
			await expressProvider.waitForDeployment();
			const expressProviderAddress =
				await expressProvider.getAddress();

			await context.controlFacet
				.connect(context.signers.admin)
				.registerExpressProvider(expressProviderAddress);
			await context.collateral.transfer(
				expressProviderAddress,
				ethers.parseUnits("1000", 18)
			);
		});

		it("Should fail to initiate withdraw with more than 50 parts", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();

			const parts: any[] = [];
			for (let i = 0; i < 51; i++) {
				parts.push(
					await buildPart("1", {
						expressProvider: epAddress,
					})
				);
			}

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).to.revertedWith("WithdrawFacet : Too many withdraw parts");
		});

		it("Should initiate withdraw with 50 parts", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();

			const parts: any[] = [];
			for (let i = 0; i < 50; i++) {
				parts.push(
					await buildPart("1", {
						expressProvider: epAddress,
					})
				);
			}

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).not.reverted;
		});

		it("Should fail to initiate withdraw with amounts more than balance", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();

			const parts = [
				await buildPart("120", {
					expressProvider: epAddress,
				}),
			];

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).to.revertedWith("WithdrawFacet : Insufficient balance");
		});

		it("Should fail to initiate withdraw with more than one express provider", async function() {
			const MockExpressProvider = await ethers.getContractFactory(
				"contracts/test/MockExpressProvider.sol:ExpressProvider"
			);
			const expressProvider2 = await MockExpressProvider.deploy(
				context.diamond
			);
			await expressProvider2.waitForDeployment();
			const expressProviderAddress2 =
				await expressProvider2.getAddress();

			await context.controlFacet
				.connect(context.signers.admin)
				.registerExpressProvider(expressProviderAddress2);
			await context.collateral.transfer(
				expressProviderAddress2,
				ethers.parseUnits("1000", 18)
			);

			await userDeposit("100");
			const epAddress1 = await expressProvider.getAddress();
			const epAddress2 = await expressProvider2.getAddress();

			const parts = [
				await buildPart("20", { expressProvider: epAddress1 }),
				await buildPart("20", { expressProvider: epAddress2 }),
			];

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).to.revertedWith(
				"WithdrawFacet : Multiple express providers not allowed"
			);
		});


		it("Should fail to initiate withdraw with non-registered provider", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();

			const parts = await buildParts(["50", "20"], {
				expressProvider: epAddress,
			});

			await context.controlFacet.connect(context.signers.admin).unregisterExpressProvider(epAddress);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).to.revertedWith("WithdrawFacet : Not registered express provider")

		});

		it("Should initiate withdraw correctly", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();

			const parts = await buildParts(["50", "20"], {
				expressProvider: epAddress,
			});

			const symmioBalanceBefore =
				await context.viewFacet.balanceOf(user.address);
			const tokenBalanceBefore =
				await context.collateral.balanceOf(user.address);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).not.to.reverted;

			const symmioBalanceAfter =
				await context.viewFacet.balanceOf(user.address);
			const tokenBalanceAfter =
				await context.collateral.balanceOf(user.address);

			expect(
				symmioBalanceBefore - symmioBalanceAfter
			).to.equal(tokenBalanceAfter - tokenBalanceBefore);

			const withdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(
				withdrawRequest.parts[0].amount +
				withdrawRequest.parts[1].amount
			).to.equal(ethers.parseUnits("70", 18));
		});

		it("Should fail to finalize withdraw before passing cooldown", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();

			const parts = [await buildPart("50", { expressProvider: epAddress })];

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.finalizeWithdrawRequest(user.address, 1)
			).to.revertedWith("WithdrawFacet : Withdraw cooldown not over");
		});

		it("Should finalize withdraw", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();

			const parts = await buildParts(["50", "20"], {
				expressProvider: epAddress,
			});

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expect(
				expressProvider.acceptWithdrawRequest(user.address, 1)
			).not.to.reverted;

			const withdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(withdrawRequest.status).to.equal(
				WithdrawStatus.PROVIDER_ACCEPTED
			);

			await time.increase(1000);
			const expressBalanceBefore =
				await context.collateral.balanceOf(epAddress);

			await expect(
				expressProvider.finalizeWithdrawRequest(
					user.address,
					1
				)
			).not.to.reverted;

			const expressBalanceAfter =
				await context.collateral.balanceOf(epAddress);
			expect(
				expressBalanceAfter - expressBalanceBefore
			).to.equal(ethers.parseUnits("70", 18));
		});

		it("Should reject withdraw if provider wants", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();

			const parts = [await buildPart("50", { expressProvider: epAddress })];

			const beforeBalance =
				await context.viewFacet.balanceOf(user.address);

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expect(
				expressProvider.rejectWithdrawRequest(user.address, 1)
			).not.reverted;

			const withdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(withdrawRequest.status).to.equal(
				WithdrawStatus.PROVIDER_REJECTED
			);

			const afterBalance = await context.viewFacet.balanceOf(
				user.address
			);
			expect(afterBalance).to.equal(beforeBalance);
		});

		it("Should request to cancel withdraw", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();

			const parts = await buildParts(["50", "20"], {
				expressProvider: epAddress,
			});

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expressProvider.acceptWithdrawRequest(user.address, 1);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.requestCancelWithdraw(1)
			).not.reverted;

			const withdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(withdrawRequest.status).to.equal(
				WithdrawStatus.CANCEL_REQUESTED
			);

			await expect(
				expressProvider.acceptWithdrawCancelRequest(
					user.address,
					1
				)
			).not.to.reverted;

			const updatedWithdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(updatedWithdrawRequest.status).to.equal(
				WithdrawStatus.CANCELLED
			);
		});

		it("Should fail to accept cancel withdraw with invalid id", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();

			const parts = await buildParts(["50", "20"], {
				expressProvider: epAddress,
			});

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expressProvider.acceptWithdrawRequest(user.address, 1);

			await context.withdrawFacet
				.connect(context.signers.user)
				.requestCancelWithdraw(1);

			await expect(expressProvider.acceptWithdrawCancelRequest(
					user.address, 2
				)
			).to.revertedWith("WithdrawFacet : Invalid withdraw request ID");
		});

		it("Should fail to accept cancel withdraw with invalid status", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();

			const parts = await buildParts(["50", "20"], {
				expressProvider: epAddress,
			});

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expressProvider.acceptWithdrawRequest(user.address, 1);

			await expect(expressProvider.acceptWithdrawCancelRequest(
					user.address, 1
				)
			).to.revertedWith("WithdrawFacet : Invalid withdraw request status");
		});

		it("Should fail to accept cancel withdraw from non-provider", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();

			const parts = await buildParts(["50", "20"], {
				expressProvider: epAddress,
			});

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expressProvider.acceptWithdrawRequest(user.address, 1);

			await context.withdrawFacet
				.connect(context.signers.user)
				.requestCancelWithdraw(1);

			await expect(context.withdrawFacet.connect(context.signers.admin).acceptWithdrawCancelRequest(
					user.address, 1
				)
			).to.revertedWith("WithdrawFacet : Not allowed to accept cancel");
		});

		it("Should fail to force cancel withdraw with express provider", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();

			const parts = [
				await buildPart("50", {
					expressProvider: epAddress,
				}),
				await buildPart("20"),
			];

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expressProvider.acceptWithdrawRequest(user.address, 1);
			await context.withdrawFacet
				.connect(context.signers.user)
				.requestCancelWithdraw(1);
			await time.increase(1000);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.forceCancelWithdraw(1)
			).to.revertedWith("WithdrawFacet : Not a pure virtual withdraw");
		});
	});

	describe("Virtual Express Withdraw", function() {
		beforeEach(async function() {
			const MockExpressProvider = await ethers.getContractFactory(
				"contracts/test/MockExpressProvider.sol:ExpressProvider"
			);
			expressProvider = await MockExpressProvider.deploy(
				context.diamond
			);
			await expressProvider.waitForDeployment();
			const expressProviderAddress =
				await expressProvider.getAddress();

			await context.controlFacet
				.connect(context.signers.admin)
				.registerExpressProvider(expressProviderAddress);

			const MockVirtualProvider = await ethers.getContractFactory(
				"contracts/test/MockVirtualProvider.sol:VirtualProvider"
			);
			virtualProvider = await MockVirtualProvider.deploy(context.diamond);
			await virtualProvider.waitForDeployment();
			const virtualProviderAddress = await virtualProvider.getAddress();

			await context.controlFacet
				.connect(context.signers.admin)
				.registerVirtualProvider(virtualProviderAddress);
		});

		it("Should initiate withdraw correctly", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();
			const vrAddress = await virtualProvider.getAddress();
			const parts = await buildParts(["50", "20"], {
				expressProvider: epAddress, virtualProvider: vrAddress
			});

			const symmioBalanceBefore =
				await context.viewFacet.balanceOf(user.address);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.initiateWithdraw(parts, false, "0x")
			).not.to.reverted;

			const symmioBalanceAfter =
				await context.viewFacet.balanceOf(user.address);

			expect(
				symmioBalanceBefore - symmioBalanceAfter
			).to.equal(ethers.parseUnits("70", 18));

			const withdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(
				withdrawRequest.parts[0].amount +
				withdrawRequest.parts[1].amount
			).to.equal(ethers.parseUnits("70", 18));
		});

		it("Should fail to finalize withdraw before passing cooldown", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();
			const vrAddress = await virtualProvider.getAddress();

			const parts = [await buildPart("50", { expressProvider: epAddress, virtualProvider: vrAddress })];

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.finalizeWithdrawRequest(user.address, 1)
			).to.revertedWith("WithdrawFacet : Withdraw cooldown not over");
		});

		it("Should finalize withdraw", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();
			const vrAddress = await virtualProvider.getAddress();

			const parts = await buildParts(["50", "20"], {
				expressProvider: epAddress, virtualProvider: vrAddress
			});

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expect(
				expressProvider.acceptWithdrawRequest(user.address, 1)
			).not.to.reverted;

			const withdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(withdrawRequest.status).to.equal(
				WithdrawStatus.PROVIDER_ACCEPTED
			);

			await time.increase(1000);
			const expressBalanceBefore =
				await context.collateral.balanceOf(epAddress);

			await expect(
				expressProvider.finalizeWithdrawRequest(
					user.address,
					1
				)
			).not.to.reverted;

			const expressBalanceAfter =
				await context.collateral.balanceOf(epAddress);
			expect(
				expressBalanceAfter - expressBalanceBefore
			).to.equal(0);
		});
		it("Should reject withdraw if provider wants", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();
			const vrAddress = await virtualProvider.getAddress();

			const parts = [await buildPart("50", { expressProvider: epAddress, virtualProvider: vrAddress })];

			const beforeBalance =
				await context.viewFacet.balanceOf(user.address);

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expect(
				expressProvider.rejectWithdrawRequest(user.address, 1)
			).not.reverted;

			const withdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(withdrawRequest.status).to.equal(
				WithdrawStatus.PROVIDER_REJECTED
			);

			const afterBalance = await context.viewFacet.balanceOf(
				user.address
			);
			expect(afterBalance).to.equal(beforeBalance);
		});

		it("Should request to cancel withdraw", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();
			const vrAddress = await virtualProvider.getAddress();

			const parts = await buildParts(["50", "20"], {
				expressProvider: epAddress,
				virtualProvider: vrAddress
			});

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expressProvider.acceptWithdrawRequest(user.address, 1);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.requestCancelWithdraw(1)
			).not.reverted;

			const withdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(withdrawRequest.status).to.equal(
				WithdrawStatus.CANCEL_REQUESTED
			);

			await expect(
				expressProvider.acceptWithdrawCancelRequest(
					user.address,
					1
				)
			).not.to.reverted;

			const updatedWithdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(updatedWithdrawRequest.status).to.equal(
				WithdrawStatus.CANCELLED
			);
		});

		it("Should request to cancel withdraw", async function() {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();
			const vrAddress = await virtualProvider.getAddress();

			const parts = await buildParts(["50", "20"], {
				expressProvider: epAddress, virtualProvider: vrAddress
			});

			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, false, "0x");

			await expressProvider.acceptWithdrawRequest(user.address, 1);

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.requestCancelWithdraw(1)
			).not.reverted;

			const withdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(withdrawRequest.status).to.equal(
				WithdrawStatus.CANCEL_REQUESTED
			);

			await expect(
				expressProvider.acceptWithdrawCancelRequest(
					user.address,
					1
				)
			).not.to.reverted;

			const updatedWithdrawRequest =
				await context.viewFacet.getWithdrawRequests(
					user.address,
					1
				);
			expect(updatedWithdrawRequest.status).to.equal(
				WithdrawStatus.CANCELLED
			);

		});
	});

	describe("Withdraw Speed Up", function() {
		beforeEach(async function() {
			const MockVirtualProvider = await ethers.getContractFactory(
				"contracts/test/MockVirtualProvider.sol:VirtualProvider"
			);
			virtualProvider = await MockVirtualProvider.deploy(context.diamond);
			await virtualProvider.waitForDeployment();
			const virtualProviderAddress = await virtualProvider.getAddress();

			await context.controlFacet
				.connect(context.signers.admin)
				.registerVirtualProvider(virtualProviderAddress);

			const MockExpressProvider = await ethers.getContractFactory(
				"contracts/test/MockExpressProvider.sol:ExpressProvider"
			);
			expressProvider = await MockExpressProvider.deploy(context.diamond);
			await expressProvider.waitForDeployment();
			const expressProviderAddress = await expressProvider.getAddress();

			await context.controlFacet
				.connect(context.signers.admin)
				.registerExpressProvider(expressProviderAddress);

		});

		it("Should fail to speed up withdraw without role", async function() {
			await userDeposit("100");

			const parts = [await buildPart("50")];

			await context.controlFacet
				.connect(context.signers.admin)
				.setSpeedUpUser(user.address, true);
			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, true, "0x");

			await expect(
				context.withdrawFacet
					.connect(context.signers.user)
					.acceptSpeedUpRequest(user.address, 1, 10)
			).to.revertedWith("Accessibility: Must have role");
		});

		it("Should speed up withdraw for classic withdrawals", async function() {
			await userDeposit("100");

			const parts = [await buildPart("50")];

			await context.controlFacet
				.connect(context.signers.admin)
				.setSpeedUpUser(user.address, true);
			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, true, "0x");

			await expect(
				context.withdrawFacet
					.connect(context.signers.admin)
					.acceptSpeedUpRequest(user.address, 1, 10)
			).not.reverted;
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.cooldownEndTime - withdrawRequest.timestamp).to.equal(10)
		});

		it("Should speed up withdraw for virtual withdrawals", async function() {
			await userDeposit("100");
			const vrAddress = await virtualProvider.getAddress();

			const parts = [await buildPart("50" , {virtualProvider : vrAddress})];

			await context.controlFacet
				.connect(context.signers.admin)
				.setSpeedUpUser(user.address, true);
			await context.withdrawFacet
				.connect(context.signers.user)
				.initiateWithdraw(parts, true, "0x");

			await expect(
				context.withdrawFacet
					.connect(context.signers.admin)
					.acceptSpeedUpRequest(user.address, 1, 10)
			).not.reverted;
			const withdrawRequest = await context.viewFacet.getWithdrawRequests(user.address,1)
			expect(withdrawRequest.cooldownEndTime - withdrawRequest.timestamp).to.equal(10)
		});

		it("Should set speed up user", async function () {
			await expect(context.controlFacet.connect(context.signers.admin).setSpeedUpUser(user.address, true)).not.reverted;
			expect(await context.viewFacet.isSpeedUpEligible(user.address)).to.equal(true)
		})

		it("Should unset speed up user", async function () {
			await context.controlFacet.connect(context.signers.admin).setSpeedUpUser(user.address, true);
			await expect(context.controlFacet.connect(context.signers.admin).setSpeedUpUser(user.address, false)).not.reverted;
			expect(await context.viewFacet.isSpeedUpEligible(user.address)).to.equal(false)
		})

		it("Should fail to speed-up more than threshold", async function () {
			await expect(context.controlFacet.connect(context.signers.admin).setMinWithdrawCooldown(10)).not.reverted;
			await context.controlFacet.connect(context.signers.admin).setSpeedUpUser(user.address, true)
			await userDeposit("100");
			const parts = [await buildPart("50")];
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,true,"0x")
			await expect(context.withdrawFacet.connect(context.signers.admin).acceptSpeedUpRequest(user.address,1 , 5))
				.to.revertedWith("WithdrawFacet : New cooldown exceeds min cooldown");
		})

		it("Should fail to initiate speed up withdraw when not whitelisted", async function () {
			await userDeposit("100");
			const parts = [await buildPart("50")];
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,true,"0x"))
				.to.revertedWith("WithdrawFacet : Not allowed to speed up withdraw")
		})

		it("Should fail to initiate speed up withdraw with express", async function () {
			await userDeposit("100");
			const epAddress = await expressProvider.getAddress();
			const parts = [await buildPart("50" , {expressProvider: epAddress})];
			await context.controlFacet.connect(context.signers.admin).setSpeedUpUser(user.address, true)
			await expect(context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,true,"0x"))
				.to.revertedWith("WithdrawFacet : Speed up not allowed with express");
		})

		it("Should fail to speed-up with invalid id", async function () {
			await context.controlFacet.connect(context.signers.admin).setSpeedUpUser(user.address, true)
			await userDeposit("100");
			const parts = [await buildPart("50")];
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,true,"0x")
			await expect(context.withdrawFacet.connect(context.signers.admin).acceptSpeedUpRequest(user.address,2 , 5))
				.to.revertedWith("WithdrawFacet : Invalid withdraw request ID");
		})

		it("Should fail to speed-up more than one time", async function () {
			await context.controlFacet.connect(context.signers.admin).setSpeedUpUser(user.address, true)
			await userDeposit("100");
			const parts = [await buildPart("50")];
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,true,"0x")
			await context.withdrawFacet.connect(context.signers.admin).acceptSpeedUpRequest(user.address,1 , 10)
			await expect(context.withdrawFacet.connect(context.signers.admin).acceptSpeedUpRequest(user.address,1 , 5))
				.to.revertedWith("WithdrawFacet : Cooldown already modified");
		})

		it("Should fail to speed-up when user is not whitelisted", async function () {
			await context.controlFacet.connect(context.signers.admin).setSpeedUpUser(user.address, true)
			await userDeposit("100");
			const parts = [await buildPart("50")];
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,true,"0x")
			await context.controlFacet.connect(context.signers.admin).setSpeedUpUser(user.address, false)
			await expect(context.withdrawFacet.connect(context.signers.admin).acceptSpeedUpRequest(user.address,1 , 5))
				.to.revertedWith("WithdrawFacet : User not in speed up whitelist");
		})

		it("Should fail to speed-up when user is not whitelisted", async function () {
			await context.controlFacet.connect(context.signers.admin).setSpeedUpUser(user.address, true)
			await userDeposit("100");
			const parts = [await buildPart("50")];
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,true,"0x")
			await context.withdrawFacet.connect(context.signers.user).requestCancelWithdraw(1)
			await expect(context.withdrawFacet.connect(context.signers.admin).acceptSpeedUpRequest(user.address,1 , 5))
				.to.revertedWith("WithdrawFacet : Invalid withdraw request status");
		})

		it("Should fail to speed-up when request is not speed-up", async function () {
			await context.controlFacet.connect(context.signers.admin).setSpeedUpUser(user.address, true)
			await userDeposit("100");
			const parts = [await buildPart("50")];
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts,false,"0x")
			await expect(context.withdrawFacet.connect(context.signers.admin).acceptSpeedUpRequest(user.address,1 , 5))
				.to.revertedWith("WithdrawFacet : Withdraw request is not speed up");
		})

	});
}
