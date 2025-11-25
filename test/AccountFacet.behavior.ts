import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import { expect } from "chai"
import { ethers } from "hardhat"
import { ZeroAddress } from "ethers"
import { toUtf8Bytes } from "ethers"

import { initializeFixture } from "./Initialize.fixture"
import { RunContext } from "./models/RunContext"
import { User } from "./models/User"
import { Hedger } from "./models/Hedger"
import { getDummySingleUpnlSig } from "./utils/SignatureUtils"
import { decimal } from "./utils/Common"

export function shouldBehaveLikeAccountFacet(): void {
	let context: RunContext, user: User, user2: User, hedger: Hedger
	let mockTarget: any, mockTarget2: any
	let targetAddress: string, targetAddress2: string

	// Test constants
	const BALANCES = {
		INITIAL_COLLATERAL: decimal(500n),
		DEPOSIT_AMOUNT: decimal(300n),
		WITHDRAW_AMOUNT: decimal(200n),
		ALLOCATE_AMOUNT: decimal(100n),
		DEALLOCATE_AMOUNT: decimal(50n),
		TRANSFER_AMOUNT: decimal(100n),
		SMALL_AMOUNT: decimal(25n),
		LARGE_AMOUNT: decimal(700n),
		HEDGER_ALLOCATE: decimal(120n),
	}

	const LIMITS = {
		BALANCE_LIMIT: decimal(100n),
		UNBIND_COOLDOWN: 100,
		DEALLOCATE_COOLDOWN: 1000,
	}

	const UPNL_VALUES = {
		ZERO: 0n,
		NEGATIVE_SMALL: -decimal(50n),
		NEGATIVE_LARGE: -decimal(350n),
	}

	describe("Deposit", async function () {
		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(BALANCES.INITIAL_COLLATERAL)
		})

		it("Should fail when accounting is paused", async function () {
			await context.controlFacet.pauseAccounting()
			await expect(
				context.accountFacet.connect(context.signers.user).deposit(BALANCES.DEPOSIT_AMOUNT)
			).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("Should fail on low collateral", async function () {
			await expect(
				context.accountFacet.connect(context.signers.user2).deposit(BALANCES.DEPOSIT_AMOUNT)
			).to.be.revertedWith("ERC20: insufficient allowance")
			
			await context.collateral.connect(context.signers.user2).approve(context.diamond, ethers.MaxUint256)
			await expect(
				context.accountFacet.connect(context.signers.user2).deposit(BALANCES.DEPOSIT_AMOUNT)
			).to.be.revertedWith("ERC20: transfer amount exceeds balance")
		})

		it("Should deposit collateral", async function () {
			const userAddress = await context.signers.user.getAddress()
			const expectedBalance = BALANCES.DEPOSIT_AMOUNT
			const expectedCollateral = BALANCES.INITIAL_COLLATERAL - BALANCES.DEPOSIT_AMOUNT

			await context.accountFacet.connect(context.signers.user).deposit(BALANCES.DEPOSIT_AMOUNT)
			
			expect(await context.viewFacet.balanceOf(userAddress)).to.equal(expectedBalance)
			expect(await context.collateral.balanceOf(userAddress)).to.equal(expectedCollateral)
		})

		it("Should deposit collateral for another user", async function () {
			const userAddress = await context.signers.user.getAddress()
			const user2Address = await context.signers.user2.getAddress()

			await context.accountFacet.connect(context.signers.user).depositFor(user2Address, BALANCES.DEPOSIT_AMOUNT)
			
			expect(await context.viewFacet.balanceOf(userAddress)).to.equal(0)
			expect(await context.viewFacet.balanceOf(user2Address)).to.equal(BALANCES.DEPOSIT_AMOUNT)
			expect(await context.collateral.balanceOf(userAddress)).to.equal(BALANCES.INITIAL_COLLATERAL - BALANCES.DEPOSIT_AMOUNT)
		})

		it("Should fail to virtual deposit when accounting is paused", async function () {
			await context.controlFacet
				.connect(context.signers.admin)
				.grantRole(context.signers.admin, ethers.keccak256(toUtf8Bytes("VIRTUAL_DEPOSITOR_ROLE")))

			await context.controlFacet.pauseAccounting()
			
			await expect(
				context.accountFacet.connect(context.signers.admin).virtualDepositFor(await user.getAddress(), decimal(1n))
			).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("Should fail to virtual deposit when calling without role", async function () {
			await expect(
				context.accountFacet.connect(context.signers.user).virtualDepositFor(await user.getAddress(), decimal(1n))
			).to.be.revertedWith("Accessibility: Must has role")
		})

		it("Should virtual deposit for user", async function () {
			await context.controlFacet
				.connect(context.signers.admin)
				.grantRole(context.signers.admin, ethers.keccak256(toUtf8Bytes("VIRTUAL_DEPOSITOR_ROLE")))
			
			const userAddress = await user.getAddress()
			const depositAmount = decimal(1n)
			const beforeBalance = await context.viewFacet.balanceOf(userAddress)
			
			await expect(
				context.accountFacet.connect(context.signers.admin).virtualDepositFor(userAddress, depositAmount)
			).to.not.be.reverted
			
			const afterBalance = await context.viewFacet.balanceOf(userAddress)
			expect(afterBalance - beforeBalance).to.equal(depositAmount)
		})
	})

	describe("Withdraw", async function () {
		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.DEPOSIT_AMOUNT)
		})

		it("Should fail to withdraw collateral more than deposit", async function () {
			const excessiveAmount = BALANCES.DEPOSIT_AMOUNT + decimal(50n)
			await expect(
				context.accountFacet.connect(context.signers.user).withdraw(excessiveAmount)
			).to.be.reverted
		})

		it("Should fail when accounting is paused", async function () {
			await context.controlFacet.pauseAccounting()
			await expect(
				context.accountFacet.connect(context.signers.user).withdraw(BALANCES.DEPOSIT_AMOUNT)
			).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("Should withdraw collateral", async function () {
			const userAddress = await context.signers.user.getAddress()
			const expectedBalance = BALANCES.DEPOSIT_AMOUNT - BALANCES.WITHDRAW_AMOUNT
			const expectedCollateral = BALANCES.INITIAL_COLLATERAL - BALANCES.DEPOSIT_AMOUNT + BALANCES.WITHDRAW_AMOUNT

			await context.accountFacet.connect(context.signers.user).withdraw(BALANCES.WITHDRAW_AMOUNT)
			
			expect(await context.viewFacet.balanceOf(userAddress)).to.equal(expectedBalance)
			expect(await context.collateral.balanceOf(userAddress)).to.equal(expectedCollateral)
		})

		it("Should withdraw collateral to another user", async function () {
			const userAddress = await context.signers.user.getAddress()
			const user2Address = await context.signers.user2.getAddress()
			const withdrawAmount = BALANCES.DEALLOCATE_AMOUNT

			await context.accountFacet.connect(context.signers.user).withdrawTo(user2Address, withdrawAmount)
			
			expect(await context.viewFacet.balanceOf(userAddress)).to.equal(BALANCES.DEPOSIT_AMOUNT - withdrawAmount)
			expect(await context.viewFacet.balanceOf(user2Address)).to.equal(0)
			expect(await context.collateral.balanceOf(userAddress)).to.equal(BALANCES.INITIAL_COLLATERAL - BALANCES.DEPOSIT_AMOUNT)
			expect(await context.collateral.balanceOf(user2Address)).to.equal(withdrawAmount)
		})
	})

	describe("Allocate", async function () {
		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.DEPOSIT_AMOUNT)
		})

		it("Should fail on reaching balance limit", async function () {
			await context.controlFacet.connect(context.signers.admin).setBalanceLimitPerUser(LIMITS.BALANCE_LIMIT)
			await expect(
				context.accountFacet.connect(context.signers.user).allocate(BALANCES.DEPOSIT_AMOUNT)
			).to.be.revertedWith("AccountFacet: Allocated balance limit reached")
		})

		it("Should fail when accounting is paused", async function () {
			await context.controlFacet.pauseAccounting()
			await expect(
				context.accountFacet.connect(context.signers.user).allocate(BALANCES.DEPOSIT_AMOUNT)
			).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("Should fail on Insufficient balance", async function () {
			const excessiveAmount = BALANCES.DEPOSIT_AMOUNT + BALANCES.ALLOCATE_AMOUNT
			await expect(
				context.accountFacet.connect(context.signers.user).allocate(excessiveAmount)
			).to.be.revertedWith("AccountFacet: Insufficient balance")
		})

		it("Should allocate", async function () {
			const userAddress = await context.signers.user.getAddress()
			const expectedBalance = BALANCES.DEPOSIT_AMOUNT - BALANCES.ALLOCATE_AMOUNT

			await context.accountFacet.connect(context.signers.user).allocate(BALANCES.ALLOCATE_AMOUNT)

			expect(await context.viewFacet.balanceOf(userAddress)).to.equal(expectedBalance)
			expect(await context.viewFacet.allocatedBalanceOfPartyA(userAddress)).to.equal(BALANCES.ALLOCATE_AMOUNT)
		})

		it("Should deposit and allocate collateral", async function () {
			const userAddress = await context.signers.user.getAddress()
			const additionalDeposit = BALANCES.WITHDRAW_AMOUNT
			const expectedBalance = BALANCES.DEPOSIT_AMOUNT
			const expectedAllocated = additionalDeposit
			const expectedCollateral = BALANCES.INITIAL_COLLATERAL - BALANCES.DEPOSIT_AMOUNT - additionalDeposit

			await context.accountFacet.connect(context.signers.user).depositAndAllocate(additionalDeposit)
			
			expect(await context.viewFacet.balanceOf(userAddress)).to.equal(expectedBalance)
			expect(await context.viewFacet.allocatedBalanceOfPartyA(userAddress)).to.equal(expectedAllocated)
			expect(await context.collateral.balanceOf(userAddress)).to.equal(expectedCollateral)
		})

		it("Should deposit and allocate collateral for user", async function () {
			const userAddress = await context.signers.user.getAddress()
			const additionalDeposit = BALANCES.WITHDRAW_AMOUNT
			const expectedBalance = BALANCES.DEPOSIT_AMOUNT
			const expectedAllocated = additionalDeposit
			const expectedCollateral = BALANCES.INITIAL_COLLATERAL - BALANCES.DEPOSIT_AMOUNT - additionalDeposit

			await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(userAddress, additionalDeposit)
			
			expect(await context.viewFacet.balanceOf(userAddress)).to.equal(expectedBalance)
			expect(await context.viewFacet.allocatedBalanceOfPartyA(userAddress)).to.equal(expectedAllocated)
			expect(await context.collateral.balanceOf(userAddress)).to.equal(expectedCollateral)
		})
	})

	describe("deallocateForPartyB", () => {
		const QUOTE_NOTIONAL_MULTIPLIER = decimal(12n, 17)

		beforeEach(async () => {
			context = await loadFixture(initializeFixture)

			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.INITIAL_COLLATERAL, BALANCES.INITIAL_COLLATERAL)

			hedger = new Hedger(context, context.signers.hedger)
			await hedger.setup()
			await hedger.setBalances(BALANCES.LARGE_AMOUNT, BALANCES.LARGE_AMOUNT)

			const quoteId = await user.sendQuote()
			const quote = await context.viewFacet.getQuote(quoteId)

			const notional = quote.quantity * quote.requestedOpenPrice / decimal(1n)
			await context.accountFacet
				.connect(context.signers.hedger)
				.allocateForPartyB(notional * QUOTE_NOTIONAL_MULTIPLIER / decimal(1n), quote.partyA)

			await context.partyBQuoteActionsFacet
				.connect(context.signers.hedger)
				.lockQuote(quoteId, await getDummySingleUpnlSig(UPNL_VALUES.ZERO))
		})

		it("Should fail if amount be higher than partyBAllocatedBalances", async () => {
			const excessiveAmount = decimal(210n)
			await expect(
				context.accountFacet
					.connect(context.signers.hedger)
					.deallocateForPartyB(excessiveAmount, await user.getAddress(), await getDummySingleUpnlSig())
			).to.be.revertedWith("AccountFacet: Insufficient allocated balance")
		})

		it("Should fail if deallocation would make partyB liquidatable", async () => {
			const liquidatableAmount = decimal(101n)
			await expect(
				context.accountFacet
					.connect(context.signers.hedger)
					.deallocateForPartyB(liquidatableAmount, await user.getAddress(), await getDummySingleUpnlSig())
			).to.be.revertedWith("AccountFacet: Will be liquidatable")
		})

		it("Should deallocate for partyB successfully", async () => {
			const deallocateAmount = BALANCES.DEALLOCATE_AMOUNT
			const expectedAllocated = BALANCES.HEDGER_ALLOCATE - deallocateAmount

			await expect(
				context.accountFacet
					.connect(context.signers.hedger)
					.deallocateForPartyB(deallocateAmount, await user.getAddress(), await getDummySingleUpnlSig())
			).to.not.be.reverted

			const newAllocatedBalanceOfPartyB = await context.viewFacet.allocatedBalanceOfPartyB(
				await hedger.getAddress(),
				await user.getAddress()
			)

			expect(newAllocatedBalanceOfPartyB).to.be.equal(expectedAllocated)
		})
	})

	describe("Deallocate", async function () {
		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.DEPOSIT_AMOUNT, BALANCES.DEPOSIT_AMOUNT)
		})

		it("Should fail on insufficient allocated Balance", async function () {
			const excessiveAmount = BALANCES.DEPOSIT_AMOUNT + BALANCES.ALLOCATE_AMOUNT
			await expect(
				context.accountFacet.connect(context.signers.user).deallocate(excessiveAmount, await getDummySingleUpnlSig())
			).to.be.revertedWith("AccountFacet: Insufficient allocated Balance")
		})

		it("Should fail when accounting is paused", async function () {
			await context.controlFacet.pauseAccounting()
			await expect(
				context.accountFacet.connect(context.signers.user).deallocate(BALANCES.DEPOSIT_AMOUNT, await getDummySingleUpnlSig())
			).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("Should fail on available balance is lower than zero", async function () {
			await expect(
				context.accountFacet.connect(context.signers.user).deallocate(
					BALANCES.DEPOSIT_AMOUNT,
					await getDummySingleUpnlSig(UPNL_VALUES.NEGATIVE_LARGE)
				)
			).to.be.revertedWith("AccountFacet: Available balance is lower than zero")
		})

		it("Should fail on partyA becoming liquidatable", async function () {
			await expect(
				context.accountFacet.connect(context.signers.user).deallocate(
					BALANCES.DEPOSIT_AMOUNT,
					await getDummySingleUpnlSig(UPNL_VALUES.NEGATIVE_SMALL)
				)
			).to.be.revertedWith("AccountFacet: partyA will be liquidatable")
		})

		it("Should deallocate", async function () {
			const userAddress = await context.signers.user.getAddress()
			const deallocateAmount = BALANCES.DEALLOCATE_AMOUNT
			const expectedAllocated = BALANCES.DEPOSIT_AMOUNT - deallocateAmount

			await context.accountFacet.connect(context.signers.user).deallocate(deallocateAmount, await getDummySingleUpnlSig())
			
			expect(await context.viewFacet.balanceOf(userAddress)).to.equal(deallocateAmount)
			expect(await context.viewFacet.allocatedBalanceOfPartyA(userAddress)).to.equal(expectedAllocated)
		})

		it("Should fail to deallocate too often", async function () {
			const userAddress = await context.signers.user.getAddress()
			const deallocateAmount = BALANCES.SMALL_AMOUNT

			await context.accountFacet.connect(context.signers.user).deallocate(deallocateAmount, await getDummySingleUpnlSig())
			await expect(
				context.accountFacet.connect(context.signers.user).deallocate(deallocateAmount, await getDummySingleUpnlSig())
			).to.be.revertedWith("AccountFacet: Too many deallocate in a short window")
			
			await time.increase((await context.viewFacet.getDeallocateDebounceTime()) + 1n)
			await context.accountFacet.connect(context.signers.user).deallocate(deallocateAmount, await getDummySingleUpnlSig())
			
			expect(await context.viewFacet.balanceOf(userAddress)).to.equal(BALANCES.DEALLOCATE_AMOUNT)
		})

		it("Should fail to withdraw due to cooldown", async function () {
			await context.accountFacet.connect(context.signers.user).deallocate(BALANCES.DEALLOCATE_AMOUNT, await getDummySingleUpnlSig())
			await expect(
				context.accountFacet.connect(context.signers.user).withdraw(BALANCES.DEALLOCATE_AMOUNT)
			).to.be.revertedWith("AccountFacet: Cooldown hasn't reached")
		})

		it("Should withdraw after cooldown", async function () {
			await context.accountFacet.connect(context.signers.user).deallocate(BALANCES.DEALLOCATE_AMOUNT, await getDummySingleUpnlSig())
			await time.increase(LIMITS.DEALLOCATE_COOLDOWN)
			await expect(
				context.accountFacet.connect(context.signers.user).withdraw(BALANCES.DEALLOCATE_AMOUNT)
			).to.not.be.reverted
		})
	})

	describe("ZeroUpnlDeallocate", async function () {
		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.INITIAL_COLLATERAL, BALANCES.INITIAL_COLLATERAL)
		})

		it("Should fail on insufficient allocated Balance", async function () {
			const excessiveAmount = BALANCES.INITIAL_COLLATERAL + BALANCES.ALLOCATE_AMOUNT
			await expect(
				context.accountFacet.connect(context.signers.user).zeroUpnlDeallocate(excessiveAmount)
			).to.be.revertedWith("AccountFacet: Insufficient allocated Balance")
		})

		it("Should fail when accounting is paused", async function () {
			await context.controlFacet.pauseAccounting()
			await expect(
				context.accountFacet.connect(context.signers.user).zeroUpnlDeallocate(BALANCES.DEPOSIT_AMOUNT)
			).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("Should fail when partyA has Open/Pending Positions", async function () {
			await user.sendQuote()
			const deallocateAmount = decimal(250n)
			await expect(
				context.accountFacet.connect(context.signers.user).zeroUpnlDeallocate(deallocateAmount)
			).to.be.revertedWith("AccountFacet: PartyA has Open/Pending position")
		})

		it("Should ZeroUpnlDeallocate", async function () {
			const userAddress = await context.signers.user.getAddress()
			const deallocateAmount = BALANCES.DEALLOCATE_AMOUNT
			const expectedBalance = deallocateAmount
			const expectedAllocated = BALANCES.INITIAL_COLLATERAL - deallocateAmount

			await context.accountFacet.connect(context.signers.user).zeroUpnlDeallocate(deallocateAmount)
			
			expect(await context.viewFacet.balanceOf(userAddress)).to.equal(expectedBalance)
			expect(await context.viewFacet.allocatedBalanceOfPartyA(userAddress)).to.equal(expectedAllocated)
		})
	})

	describe("InternalTransfer", async function () {
		beforeEach(async () => {
			context = await loadFixture(initializeFixture)
			
			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.DEPOSIT_AMOUNT)

			user2 = new User(context, context.signers.user2)
			await user2.setup()
			await user2.setBalances(BALANCES.INITIAL_COLLATERAL)

			hedger = new Hedger(context, context.signers.hedger)
			await hedger.setup()
			await hedger.setBalances(BALANCES.INITIAL_COLLATERAL)
		})

		it("Should internal transfer successfully", async () => {
			const transferAmount = decimal(250n)

			await context.accountFacet.connect(context.signers.user).internalTransfer(await user2.getAddress(), transferAmount)
			
			expect(await context.viewFacet.balanceOf(await user2.getAddress())).to.be.equal(0)
			expect(await context.viewFacet.allocatedBalanceOfPartyA(await user2.getAddress())).to.be.equal(transferAmount)
			expect(await context.viewFacet.balanceOf(await user.getAddress())).to.be.equal(BALANCES.DEPOSIT_AMOUNT - transferAmount)
		})
	})

	describe("ExternalTransfer", async function () {
		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.DEPOSIT_AMOUNT)

			const MockExternalTransferRelayer = await ethers.getContractFactory(
				"contracts/test/MockExternalTransferTarget.sol:ExternalTransferRelayer"
			)
			mockTarget = await MockExternalTransferRelayer.deploy()
			await mockTarget.waitForDeployment()
			targetAddress = await mockTarget.getAddress()

			mockTarget2 = await MockExternalTransferRelayer.deploy()
			await mockTarget2.waitForDeployment()
			targetAddress2 = await mockTarget2.getAddress()

			await context.controlFacet
				.connect(context.signers.admin)
				.addRelayerForExternalTransferTarget(targetAddress, targetAddress)
		})

		it("Should allow authorized users to call externalTransfer", async function () {
			await expect(
				context.accountFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress)
			).to.not.be.reverted
		})

		it("Should fail when sender is suspended", async function () {
			await context.controlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)

			await expect(
				context.accountFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress)
			).to.be.revertedWith("Accessibility: Sender is Suspended")
		})

		it("Should correctly update sender balance", async function () {
			const initialBalance = await context.viewFacet.balanceOf(context.signers.user.address)
			const expectedBalance = initialBalance - BALANCES.TRANSFER_AMOUNT

			await context.accountFacet
				.connect(context.signers.user)
				.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress)

			const finalBalance = await context.viewFacet.balanceOf(context.signers.user.address)
			expect(finalBalance).to.equal(expectedBalance)
		})

		it("Should fail with insufficient balance", async function () {
			const userBalance = await context.viewFacet.balanceOf(context.signers.user.address)
			const excessiveAmount = userBalance + BALANCES.TRANSFER_AMOUNT

			await expect(
				context.accountFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user2.address, excessiveAmount, targetAddress)
			).to.be.reverted
		})

		it("Should transfer collateral to relayer", async function () {
			const initialRelayerBalance = await context.collateral.balanceOf(targetAddress)
			const expectedBalance = initialRelayerBalance + BALANCES.TRANSFER_AMOUNT

			await context.accountFacet
				.connect(context.signers.user)
				.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress)

			const finalRelayerBalance = await context.collateral.balanceOf(targetAddress)
			expect(finalRelayerBalance).to.equal(expectedBalance)
		})

		it("Should call onTransfer on relayer with correct parameters", async function () {
			const receiverAddress = context.signers.user2.address
			const senderAddress = context.signers.user.address

			await context.accountFacet
				.connect(context.signers.user)
				.externalTransfer(receiverAddress, BALANCES.TRANSFER_AMOUNT, targetAddress)

			const lastTransfer = await mockTarget.lastTransfer()
			expect(lastTransfer.collateral).to.equal(await context.collateral.getAddress())
			expect(lastTransfer.sender).to.equal(senderAddress)
			expect(lastTransfer.receiver).to.equal(receiverAddress)
			expect(lastTransfer.amount).to.equal(BALANCES.TRANSFER_AMOUNT)
			expect(lastTransfer.target).to.equal(targetAddress)
		})

		it("Should fail with zero amount transfers", async function () {
			await expect(
				context.accountFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user2.address, 0, targetAddress)
			).to.be.revertedWith("AccountFacet: Amount is zero")
		})

		it("Should fail with zero receiver address", async function () {
			await expect(
				context.accountFacet
					.connect(context.signers.user)
					.externalTransfer(ZeroAddress, BALANCES.TRANSFER_AMOUNT, targetAddress)
			).to.be.revertedWith("AccountFacet: Zero receiver or target")
		})

		it("Should fail with zero target address", async function () {
			await expect(
				context.accountFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, ZeroAddress)
			).to.be.revertedWith("AccountFacet: Zero receiver or target")
		})

		it("Should handle self-transfers", async function () {
			await expect(
				context.accountFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user.address, BALANCES.TRANSFER_AMOUNT, targetAddress)
			).to.not.be.reverted
		})

		it("Should fail when target is not whitelisted", async function () {
			await expect(
				context.accountFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress2)
			).to.be.revertedWith("AccountFacet: Target not whitelisted")
		})

		it("Should fail when relayer is removed", async function () {
			await context.controlFacet.connect(context.signers.admin).removeRelayerForExternalTransferTarget(targetAddress)

			await expect(
				context.accountFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress)
			).to.be.revertedWith("AccountFacet: Target not whitelisted")
		})

		it("Should handle relayer revert scenarios", async function () {
			const revertMessage = "Relayer error"
			await mockTarget.setShouldRevert(true, revertMessage)

			await expect(
				context.accountFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress)
			).to.be.revertedWith(revertMessage)
		})
	})

	describe("bindToPartyB", () => {
		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			user = new User(context, context.signers.user)
			await user.setup()
		})

		it("Should fail when user suspended", async () => {
			await context.controlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)
			await expect(
				context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			).to.be.revertedWith("Accessibility: Sender is Suspended")
		})

		it("Should fail when user is not partyA", async () => {
			await expect(
				context.accountFacet.connect(context.signers.hedger).bindToPartyB(context.signers.hedger.address)
			).to.be.revertedWith("Accessibility: Shouldn't be partyB")
		})

		it("Should fail when partyB be zero address", async () => {
			await expect(
				context.accountFacet.connect(context.signers.user).bindToPartyB(ZeroAddress)
			).to.be.revertedWith("AccountFacet: Zero address")
		})

		it("Should fail when bound", async () => {
			await context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			await expect(
				context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			).to.be.revertedWith("AccountFacet: Invalid state")
		})

		it("Should bind successfully", async () => {
			const BIND_STATUS = {
				UNBOUND: 0,
				BOUND: 1,
				REQUESTED_TO_UNBIND: 2,
			}

			await expect(
				context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			).to.not.be.reverted
			
			const bindState = await context.viewFacet.getBindState(context.signers.user.address)
			expect(bindState.partyB).to.equal(context.signers.hedger.address)
			expect(bindState.status).to.equal(BIND_STATUS.BOUND)
		})
	})

	describe("unbindFromPartyB", () => {
		const BIND_STATUS = {
			UNBOUND: 0,
			BOUND: 1,
			REQUESTED_TO_UNBIND: 2,
		}

		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			user = new User(context, context.signers.user)
			await user.setup()
		})

		it("Should fail when user suspended", async () => {
			await context.controlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)
			await expect(
				context.accountFacet.connect(context.signers.user).requestToUnbindFromPartyB()
			).to.be.revertedWith("Accessibility: Sender is Suspended")
		})

		it("Should fail when user is not partyA", async () => {
			await expect(
				context.accountFacet.connect(context.signers.hedger).requestToUnbindFromPartyB()
			).to.be.revertedWith("Accessibility: Shouldn't be partyB")
		})

		it("Should fail when not bound", async () => {
			await expect(
				context.accountFacet.connect(context.signers.user).requestToUnbindFromPartyB()
			).to.be.revertedWith("AccountFacet: Invalid state")
		})

		it("Should fail when request to unbound before", async () => {
			await context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			await context.accountFacet.connect(context.signers.user).requestToUnbindFromPartyB()
			await expect(
				context.accountFacet.connect(context.signers.user).requestToUnbindFromPartyB()
			).to.be.revertedWith("AccountFacet: Invalid state")
		})

		it("Should request unbind successfully", async () => {
			await context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			
			await expect(
				context.accountFacet.connect(context.signers.user).requestToUnbindFromPartyB()
			).to.not.be.reverted
			
			const bindState = await context.viewFacet.getBindState(context.signers.user.address)
			expect(bindState.status).to.equal(BIND_STATUS.REQUESTED_TO_UNBIND)
			expect(bindState.partyB).to.equal(context.signers.hedger.address)
		})
	})

	describe("cancelUnbindFromPartyB", () => {
		const BIND_STATUS = {
			UNBOUND: 0,
			BOUND: 1,
			REQUESTED_TO_UNBIND: 2,
		}

		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			user = new User(context, context.signers.user)
			await user.setup()
		})

		it("Should fail when user suspended", async () => {
			await context.controlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)
			await expect(
				context.accountFacet.connect(context.signers.user).cancelUnbindRequest()
			).to.be.revertedWith("Accessibility: Sender is Suspended")
		})

		it("Should fail when user is not partyA", async () => {
			await expect(
				context.accountFacet.connect(context.signers.hedger).cancelUnbindRequest()
			).to.be.revertedWith("Accessibility: Shouldn't be partyB")
		})

		it("Should fail when not request to unbound", async () => {
			await expect(
				context.accountFacet.connect(context.signers.user).cancelUnbindRequest()
			).to.be.revertedWith("AccountFacet: Invalid state")
		})

		it("Should cancel request unbind successfully", async () => {
			await context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			await context.accountFacet.connect(context.signers.user).requestToUnbindFromPartyB()
			
			await expect(
				context.accountFacet.connect(context.signers.user).cancelUnbindRequest()
			).to.not.be.reverted
			
			const bindState = await context.viewFacet.getBindState(context.signers.user.address)
			expect(bindState.status).to.equal(BIND_STATUS.BOUND)
			expect(bindState.partyB).to.equal(context.signers.hedger.address)
		})
	})

	describe("acceptUnbindFromPartyB", () => {
		const BIND_STATUS = {
			UNBOUND: 0,
			BOUND: 1,
			REQUESTED_TO_UNBIND: 2,
		}

		beforeEach(async () => {
			context = await loadFixture(initializeFixture)
			user = new User(context, context.signers.user)
			await user.setup()
			
			await context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			await context.controlFacet.connect(context.signers.admin).setUnbindCooldown(LIMITS.UNBIND_COOLDOWN)
		})

		it("Should fail when user suspended", async () => {
			await context.controlFacet.connect(context.signers.admin).suspendedAddress(context.signers.hedger.address)
			await expect(
				context.accountFacet.connect(context.signers.hedger).completeUnbindRequest(context.signers.user.address)
			).to.be.revertedWith("Accessibility: Sender is Suspended")
		})

		it("Should fail when not request to unbound", async () => {
			await expect(
				context.accountFacet.connect(context.signers.hedger).completeUnbindRequest(context.signers.user.address)
			).to.be.revertedWith("AccountFacet: Invalid state")
		})

		it("Should fail when the bind state partyB not same as caller", async () => {
			await context.accountFacet.connect(context.signers.user).requestToUnbindFromPartyB()
			await expect(
				context.accountFacet.connect(context.signers.hedger2).completeUnbindRequest(context.signers.user.address)
			).to.be.revertedWith("AccountFacet: Cooldown not reached")
		})

		it("Should complete unbind successfully by partyB", async () => {
			await context.accountFacet.connect(context.signers.user).requestToUnbindFromPartyB()
			
			await expect(
				context.accountFacet.connect(context.signers.hedger).completeUnbindRequest(context.signers.user.address)
			).to.not.be.reverted
			
			const bindState = await context.viewFacet.getBindState(context.signers.user.address)
			expect(bindState.status).to.equal(BIND_STATUS.UNBOUND)
			expect(bindState.partyB).to.equal(ZeroAddress)
		})

		it("Should complete unbind successfully after cooldown", async () => {
			await context.accountFacet.connect(context.signers.user).requestToUnbindFromPartyB()
			
			const unbindCooldown = await context.viewFacet.unbindCooldown()
			await time.increase(unbindCooldown + 1n)
			
			await expect(
				context.accountFacet.connect(context.signers.user2).completeUnbindRequest(context.signers.user.address)
			).to.not.be.reverted
			
			const bindState = await context.viewFacet.getBindState(context.signers.user.address)
			expect(bindState.status).to.equal(BIND_STATUS.UNBOUND)
			expect(bindState.partyB).to.equal(ZeroAddress)
		})
	})
}