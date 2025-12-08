import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import { expect } from "chai"
import { ethers } from "hardhat"
import { ZeroAddress } from "ethers"
import { toUtf8Bytes } from "ethers"

import {
	initializeFixture,
	initializeExternalTransferRelayerFixture,
	initializeVirtualFixture,
} from "./Initialize.fixture";
import { RunContext } from "./models/RunContext"
import { User } from "./models/User"
import { Hedger } from "./models/Hedger"
import { getDummySingleUpnlSig } from "./utils/SignatureUtils"
import { decimal, getBlockTimestamp } from "./utils/Common"
import type { ExternalTransferRelayer as SymmioExternalTransferRelayer, VirtualProvider } from "../src/types";
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest"
import { ExternalTransferStatus } from "./models/Enums";

const SUSPENDED_FUNDS_WITHDRAWER_ROLE = ethers.keccak256(toUtf8Bytes("SUSPENDED_FUNDS_WITHDRAWER_ROLE"));

export function shouldBehaveLikeAccountFacet(): void {
	let context: RunContext, user: User, user2: User, hedger: Hedger
	let mockTarget: any, mockTarget2: any
	let targetAddress: string, targetAddress2: string
	let providerAddress: string, providerAddress2: string

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
			await context.pauseControlFacet.pauseAccounting()
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

			await context.pauseControlFacet.pauseAccounting()
			await expect(context.accountFacet.connect(context.signers.admin).virtualDepositFor(await user.getAddress(), decimal(1n))).to.be.revertedWith(
				"Pausable: Accounting paused",
			)
		})

		it("Should fail to virtual deposit when calling without role", async function () {
			await expect(context.accountFacet.connect(context.signers.user).virtualDepositFor(await user.getAddress(), decimal(1n))).to.be.revertedWith(
				"Accessibility: Must has role",
			)
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
			await context.pauseControlFacet.pauseAccounting()
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

		describe("withdrawSuspendedUserFunds", function () {
			let userAddress: string
			let recipient: string
			const withdrawAmount = 50n
			const withdrawAmountStr = withdrawAmount.toString()

			beforeEach(async function () {
				userAddress = await context.signers.user.getAddress()
				recipient = await context.signers.user2.getAddress()
			})

			it("Should fail when caller lacks role", async function () {
				// suspend a user
				await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(userAddress)
				// withdraw without sufficient role (as user)
				await expect(
					context.accountFacet.connect(context.signers.user).withdrawSuspendedUserFunds(userAddress, recipient, withdrawAmountStr),
				).to.be.revertedWith("Accessibility: Must has role")
			})

			it("Should fail when user is not suspended", async function () {
				// admin have SUSPENDED_FUNDS_WITHDRAWER_ROLE in initialize
				await expect(
					context.accountFacet.connect(context.signers.admin).withdrawSuspendedUserFunds(userAddress, recipient, withdrawAmountStr),
				).to.be.revertedWith("Accessibility: User is not suspended")
			})

			it("Should withdraw funds for suspended user", async function () {
				// suspend a user
				await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(userAddress)

				const initialUserBalance = await context.viewFacet.balanceOf(userAddress)
				const initialRecipientBalance = await context.viewFacet.balanceOf(recipient)

				await context.accountFacet.connect(context.signers.admin).withdrawSuspendedUserFunds(userAddress, recipient, withdrawAmountStr)

				expect(await context.viewFacet.balanceOf(userAddress)).to.equal(initialUserBalance - withdrawAmount)
				expect(await context.viewFacet.balanceOf(recipient)).to.equal(initialRecipientBalance + withdrawAmount)
			})
		})

		describe("deallocateSuspendedUserFunds", function () {
			let userAddress: string
			let recipient: string
			const allocatedAmount = 150n
			const allocatedAmountStr = allocatedAmount.toString()

			beforeEach(async function () {
				userAddress = await context.signers.user.getAddress()
				recipient = await context.signers.user2.getAddress()
				await context.accountFacet.connect(context.signers.user).allocate(allocatedAmountStr)
			})

			it("Should fail when caller lacks role", async function () {
				await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(userAddress)
				await expect(
					context.accountFacet.connect(context.signers.user).deallocateSuspendedUserFunds(userAddress, allocatedAmountStr),
				).to.be.revertedWith("Accessibility: Must has role")
			})

			it("Should fail when user is not suspended", async function () {
				await expect(
					context.accountFacet.connect(context.signers.admin).deallocateSuspendedUserFunds(userAddress, allocatedAmountStr),
				).to.be.revertedWith("Accessibility: User is not suspended")
			})

			it("Should deallocate and withdraw suspended user funds", async function () {
				await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(userAddress)

				const initialAllocated = await context.viewFacet.allocatedBalanceOfPartyA(userAddress)
				const initialBalance = await context.viewFacet.balanceOf(userAddress)
				const initialRecipientBalance = await context.viewFacet.balanceOf(recipient)

				await context.accountFacet.connect(context.signers.admin).deallocateSuspendedUserFunds(userAddress, allocatedAmountStr)
				expect(await context.viewFacet.allocatedBalanceOfPartyA(userAddress)).to.equal(initialAllocated - allocatedAmount)
				expect(await context.viewFacet.balanceOf(userAddress)).to.equal(initialBalance + allocatedAmount)

				await context.accountFacet.connect(context.signers.admin).withdrawSuspendedUserFunds(userAddress, recipient, allocatedAmountStr)
				expect(await context.viewFacet.balanceOf(userAddress)).to.equal(initialBalance)
				expect(await context.viewFacet.balanceOf(recipient)).to.equal(initialRecipientBalance + allocatedAmount)
			})
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
			await context.pauseControlFacet.pauseAccounting()
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
			console.log(await context.viewFacetQuote.getNextQuoteId())

			const quoteId = await user.sendQuote()
			const quote = await context.viewFacetQuote.getQuote(quoteId)
			console.log(await context.viewFacetQuote.getNextQuoteId())
			console.log(quote.quantity)

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
			await context.pauseControlFacet.pauseAccounting()
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
			await context.pauseControlFacet.pauseAccounting()
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

		it("should internal transfer successfully", async () => {
			await context.accountFacet.connect(context.signers.user).internalTransfer(await user2.getAddress(), BALANCES.TRANSFER_AMOUNT)
			expect(await context.viewFacet.balanceOf(await user2.getAddress())).to.be.equal("0")
			expect(await context.viewFacet.allocatedBalanceOfPartyA(await user2.getAddress())).to.be.equal(BALANCES.TRANSFER_AMOUNT)

			const expectedRemainingBalance = (BigInt(BALANCES.DEPOSIT_AMOUNT) - BigInt(BALANCES.TRANSFER_AMOUNT)).toString()
			expect(await context.viewFacet.balanceOf(await user.getAddress())).to.be.equal(expectedRemainingBalance)
		})

		it("Should fail when internal transfers are paused", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseInternalTransfer()

			await expect(context.accountFacet.connect(context.signers.user).internalTransfer(await user2.getAddress(), BALANCES.TRANSFER_AMOUNT)).to.be.revertedWith(
				"Pausable: Internal transfer paused",
			)
		})

		it("Should fail when accounting is paused", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseAccounting()

			await expect(context.accountFacet.connect(context.signers.user).internalTransfer(await user2.getAddress(), BALANCES.TRANSFER_AMOUNT)).to.be.revertedWith(
				"Pausable: Accounting paused",
			)
		})

		it("Should fail when global pause is active", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseGlobal()

			await expect(context.accountFacet.connect(context.signers.user).internalTransfer(await user2.getAddress(), BALANCES.TRANSFER_AMOUNT)).to.be.revertedWith(
				"Pausable: Global paused",
			)
		})
	})

	describe("ExternalTransfer", async function () {
		let mockTarget: any

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


			await context.controlFacet.connect(context.signers.admin).addRelayerForExternalTransferTarget(targetAddress, targetAddress)
		})

		it("Should allow authorized users to call externalTransfer", async function () {
			await expect(context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress))
				.to.not.be.reverted
		})

		it("Should fail when sender is suspended", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)

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
				context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress),
			).to.be.revertedWith("Relayer error")
		})

		it("Should fail when external transfers are paused", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseExternalTransfer()

			await expect(
				context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress),
			).to.be.revertedWith("Pausable: External transfer paused")
		})

		it("Should fail when accounting is paused", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseAccounting()

			await expect(
				context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress),
			).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("Should fail when global pause is active", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseGlobal()

			await expect(
				context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress),
			).to.be.revertedWith("Pausable: Global paused")
		})
	})

	describe("ExternalTransfer (relayer integration)", function () {
		let sourceContext: RunContext
		let targetContext: RunContext
		let relayer: SymmioExternalTransferRelayer
		let sourceUser: User
		const sourceUserInitialBalance = "1000"
		const relayerDepositAmount = "500"
		const firstExternalTransferAmount = "200"
		const secondExternalTransferAmount = "111"

		beforeEach(async function () {
			const { source, target, relayer: deployedRelayer } = await loadFixture(initializeExternalTransferRelayerFixture)
			sourceContext = source
			targetContext = target
			relayer = deployedRelayer

			sourceUser = new User(sourceContext, sourceContext.signers.user)
			await sourceUser.setup()
			await sourceUser.setBalances(sourceUserInitialBalance)
		})

		/**
		 * Scenario:
		 * 1. Source user deposits collateral into the first symmio diamond
		 * 2. The admin whitelists a new symmio diamond with its relayer contract.
		 * 3. The user performs external transfers from first symmio to second through the relayer.
		 */
		it("Should transfer funds to another diamond via relayer", async function () {
			const receiver = targetContext.signers.user2.address

			// user deposit into first symmio
			await sourceContext.accountFacet.connect(sourceContext.signers.user).deposit(relayerDepositAmount)
			// whitelist seconds symmio and its relayer for first symmio
			await sourceContext.controlFacet
				.connect(sourceContext.signers.admin)
				.addRelayerForExternalTransferTarget(targetContext.diamond, await relayer.getAddress())

			// first external transfer
			await sourceContext.accountFacet
				.connect(sourceContext.signers.user)
				.externalTransfer(receiver, firstExternalTransferAmount, targetContext.diamond)

			// check balances
			const expectedSourceBalanceAfterFirstTransfer = BigInt(relayerDepositAmount) - BigInt(firstExternalTransferAmount)
			const expectedTargetBalanceAfterFirstTransfer = BigInt(firstExternalTransferAmount)
			expect(await sourceContext.viewFacet.balanceOf(sourceContext.signers.user.address)).to.equal(expectedSourceBalanceAfterFirstTransfer.toString())
			expect(await sourceContext.collateral.balanceOf(sourceContext.diamond)).to.equal(expectedSourceBalanceAfterFirstTransfer)
			expect(await targetContext.viewFacet.balanceOf(receiver)).to.equal(firstExternalTransferAmount)
			expect(await targetContext.collateral.balanceOf(targetContext.diamond)).to.equal(expectedTargetBalanceAfterFirstTransfer)
			expect(await sourceContext.collateral.balanceOf(await relayer.getAddress())).to.equal(0n)
			expect(await sourceContext.collateral.allowance(await relayer.getAddress(), targetContext.diamond)).to.equal(0n)

			// second external transfer
			await sourceContext.accountFacet
				.connect(sourceContext.signers.user)
				.externalTransfer(receiver, secondExternalTransferAmount, targetContext.diamond)

			// check balances
			const expectedSourceBalanceAfterSecondTransfer =
				BigInt(relayerDepositAmount) - BigInt(firstExternalTransferAmount) - BigInt(secondExternalTransferAmount)
			const expectedReceiverBalanceAfterSecondTransfer = (BigInt(firstExternalTransferAmount) + BigInt(secondExternalTransferAmount)).toString()
			expect(await sourceContext.viewFacet.balanceOf(sourceContext.signers.user.address)).to.equal(
				expectedSourceBalanceAfterSecondTransfer.toString(),
			)
			expect(await sourceContext.collateral.balanceOf(sourceContext.diamond)).to.equal(expectedSourceBalanceAfterSecondTransfer)
			expect(await targetContext.viewFacet.balanceOf(receiver)).to.equal(expectedReceiverBalanceAfterSecondTransfer)
			expect(await targetContext.collateral.balanceOf(targetContext.diamond)).to.equal(BigInt(expectedReceiverBalanceAfterSecondTransfer))
			expect(await sourceContext.collateral.balanceOf(await relayer.getAddress())).to.equal(0n)
			expect(await sourceContext.collateral.allowance(await relayer.getAddress(), targetContext.diamond)).to.equal(0n)
		})
	})

	describe("Virtual ExternalTransfer Unit Test", async function () {
		let mockProvider: any, mockProvider2: any
		const depositAmount = "300"
		const transferAmount = "100"

		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			user = new User(context, context.signers.user)
			await user.setup()

			const MockVirtualProvider = await ethers.getContractFactory("contracts/test/MockVirtualProvider.sol:VirtualProvider")
			mockProvider = await MockVirtualProvider.deploy(context.diamond)
			await mockProvider.waitForDeployment()
			providerAddress = await mockProvider.getAddress()

			mockProvider2 = await MockVirtualProvider.deploy(context.diamond)
			await mockProvider2.waitForDeployment()
			providerAddress2 = await mockProvider2.getAddress()

			await context.controlFacet.connect(context.signers.admin).grantRole(providerAddress, ethers.keccak256(toUtf8Bytes("VIRTUAL_DEPOSITOR_ROLE")))
			await context.controlFacet.connect(context.signers.admin).grantRole(providerAddress2, ethers.keccak256(toUtf8Bytes("VIRTUAL_DEPOSITOR_ROLE")))

			await mockProvider.connect(context.signers.admin).virtualDepositFor(context.diamond,context.signers.user.address, depositAmount)

			await context.controlFacet.connect(context.signers.admin).registerVirtualProvider(providerAddress)
		})

		it("Should virtual external transfer correctly", async function () {
			await expect(context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress))
				.to.not.be.reverted
			const externalTransfer = await context.viewFacet.getVirtualExternalTransfer(1)
			expect(externalTransfer.status).to.equal(ExternalTransferStatus.PENDING)
		})

		it("Should accept virtual external transfer correctly", async function () {
			await context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress)
			await expect(mockProvider.acceptVirtualExternalTransfer(1)).not.reverted
			const externalTransfer = await context.viewFacet.getVirtualExternalTransfer(1)
			expect(externalTransfer.status).to.equal(ExternalTransferStatus.COMPLETED)
		})

		it("Should cancel virtual external transfer correctly", async function () {
			const beforeBalance = await context.viewFacet.balanceOf(user.address)
			await context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress)
			await expect(context.accountFacet.connect(context.signers.user).cancelVirtualExternalTransfer(1)).not.reverted
			const externalTransfer = await context.viewFacet.getVirtualExternalTransfer(1)
			expect(externalTransfer.status).to.equal(ExternalTransferStatus.CANCELED)
			const afterBalance = await context.viewFacet.balanceOf(user.address)
			expect(beforeBalance).to.equal( afterBalance)
		})

		it("Should change balance in cancel virtual external transfer correctly", async function () {
			const beforeBalance = await context.viewFacet.balanceOf(user.address)
			await context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress)
			await expect(context.accountFacet.connect(context.signers.user).cancelVirtualExternalTransfer(1)).not.reverted
			const afterBalance = await context.viewFacet.balanceOf(user.address)
			expect(afterBalance).to.equal(beforeBalance)
		})

		it("Should correctly update sender balance", async function () {
			const initialBalance = await context.viewFacet.balanceOf(context.signers.user.address)

			await context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress)

			const finalBalance = await context.viewFacet.balanceOf(context.signers.user.address)
			expect(finalBalance).to.equal(initialBalance - BigInt(transferAmount))
		})


		it("Should fail when sender is suspended", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)
			await expect(
				context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress),
			).to.be.revertedWith("Accessibility: Sender is Suspended")
		})

		it("Should fail with insufficient balance", async function () {
			const userBalance = await context.viewFacet.balanceOf(context.signers.user.address)
			const excessiveAmount = userBalance + BigInt(transferAmount)

			await expect(
				context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, excessiveAmount,context.diamond, providerAddress)
			).to.be.revertedWith("AccountFacet: Insufficient balance")
		})

		it("Should fail with zero amount transfers", async function () {
			await expect(
				context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, 0,context.diamond, providerAddress)
			).to.be.revertedWith("AccountFacet: Amount is zero")
		})

		it("Should fail with zero receiver address", async function () {
			await expect(
				context.accountFacet.connect(context.signers.user).virtualExternalTransfer(ethers.ZeroAddress, transferAmount, context.diamond,providerAddress)
			).to.be.revertedWith("AccountFacet: Zero Receiver or Zero Target")
		})

		it("Should fail with zero target address", async function () {
			await expect(
				context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount, ethers.ZeroAddress,providerAddress)
			).to.be.revertedWith("AccountFacet: Zero Receiver or Zero Target")
		})

		it("Should fail to accept virtual external transfer with invalid status", async function () {
			await context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress)
			await mockProvider.acceptVirtualExternalTransfer(1)
			await expect(mockProvider.acceptVirtualExternalTransfer(1)).to.revertedWith("AccountFacet: External transfer already processed")

			await context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress)
			await context.accountFacet.connect(context.signers.user).cancelVirtualExternalTransfer(2)
			await expect(mockProvider.acceptVirtualExternalTransfer(2)).to.revertedWith("AccountFacet: External transfer already processed")
		})

		it("Should fail to accept virtual external transfer with invalid status", async function () {
			await context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress)
			await context.controlFacet.connect(context.signers.admin).registerVirtualProvider(providerAddress2)
			await context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress2)
			await expect(mockProvider2.acceptVirtualExternalTransfer(1)).to.revertedWith("AccountFacet: Only provider can accept the transfer")
		})

		it("Should fail to cancel virtual external transfer with invalid status", async function () {
			await context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress)
			await mockProvider.acceptVirtualExternalTransfer(1)
			await expect(context.accountFacet.connect(context.signers.user).cancelVirtualExternalTransfer(1)).to.revertedWith("AccountFacet: External transfer already processed")

			await context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress)
			await context.accountFacet.connect(context.signers.user).cancelVirtualExternalTransfer(2)
			await expect(context.accountFacet.connect(context.signers.user).cancelVirtualExternalTransfer(1)).to.revertedWith("AccountFacet: External transfer already processed")
		})
		it("Should fail to cancel virtual external transfer with invalid sender", async function () {
			await context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress)
			await expect(context.accountFacet.connect(context.signers.admin).cancelVirtualExternalTransfer(1)).to.revertedWith("AccountFacet: Invalid Sender")
		})


		it("Should fail with zero provider address", async function () {
			await expect(
				context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, ethers.ZeroAddress)
			).to.be.revertedWith("AccountFacet: Invalid virtual provider")
		})

		it("Should handle self-transfers", async function () {
			await expect(context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user.address, transferAmount,context.diamond, providerAddress))
				.to.not.be.reverted
		})

		it("Should fail when provider is not registered", async function () {
			await expect(
				context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress2)
			).to.be.revertedWith("AccountFacet: Invalid virtual provider")
		})

		it("Should fail when external transfers are paused", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseExternalTransfer()

			await expect(
				context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress)
			).to.be.revertedWith("Pausable: External transfer paused")
		})

		it("Should fail when accounting is paused", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseAccounting()

			await expect(
				context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress)
			).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("Should fail when global pause is active", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseGlobal()

			await expect(
				context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress)
			).to.be.revertedWith("Pausable: Global paused")
		})
	})

	describe("VirtualExternalTransfer (Integrated Happy Path Scenario)", function () {
		let sourceContext: RunContext
		let targetContext: RunContext
		let virtualProvider: VirtualProvider
		let sourceUser: User
		const sourceUserInitialBalance = "1000"
		const virtualDepositAmount = "500"
		const firstExternalTransferAmount = "200"
		const secondExternalTransferAmount = "111"

		beforeEach(async function () {
			const { source, target, provider } = await loadFixture(initializeVirtualFixture)
			sourceContext = source
			targetContext = target
			virtualProvider = provider

			sourceUser = new User(sourceContext, sourceContext.signers.user)
			await sourceUser.setup()
			await sourceUser.setBalances(sourceUserInitialBalance)
		})

		/**
		 * Scenario:
		 * 1. Provider virtual deposits for user by collateral into the first symmio diamond
		 * 2. The admin whitelists a new symmio diamond.
		 * 3. The user performs external transfers from first symmio to second through the relayer.
		 */
		it("Should charge Funds in another diamond via relayer", async function () {
			const receiver = targetContext.signers.user2.address

			// virtual deposit for user into first symmio
			await virtualProvider.connect(sourceContext.signers.admin).virtualDepositFor(sourceContext.diamond,sourceContext.signers.user.address, virtualDepositAmount)

			// first external transfer
			await sourceContext.accountFacet
				.connect(sourceContext.signers.user)
				.virtualExternalTransfer(receiver, firstExternalTransferAmount, targetContext.diamond, await virtualProvider.getAddress())
			await virtualProvider.connect(sourceContext.signers.admin).acceptVirtualExternalTransfer(1)
			// check balances
			const expectedSourceBalanceAfterFirstTransfer = BigInt(virtualDepositAmount) - BigInt(firstExternalTransferAmount)
			expect(await sourceContext.viewFacet.balanceOf(sourceContext.signers.user.address)).to.equal(expectedSourceBalanceAfterFirstTransfer.toString())
			expect(await targetContext.viewFacet.balanceOf(receiver)).to.equal(firstExternalTransferAmount)

			// second external transfer
			await sourceContext.accountFacet
				.connect(sourceContext.signers.user)
				.virtualExternalTransfer(receiver, secondExternalTransferAmount, targetContext.diamond , await virtualProvider.getAddress())
			await virtualProvider.connect(sourceContext.signers.admin).acceptVirtualExternalTransfer(2)

			// check balances
			const expectedSourceBalanceAfterSecondTransfer =
				BigInt(virtualDepositAmount) - BigInt(firstExternalTransferAmount) - BigInt(secondExternalTransferAmount)
			const expectedReceiverBalanceAfterSecondTransfer = (BigInt(firstExternalTransferAmount) + BigInt(secondExternalTransferAmount)).toString()
			expect(await sourceContext.viewFacet.balanceOf(sourceContext.signers.user.address)).to.equal(
				expectedSourceBalanceAfterSecondTransfer.toString(),
			)
			expect(await targetContext.viewFacet.balanceOf(receiver)).to.equal(expectedReceiverBalanceAfterSecondTransfer)

		})
	})


	describe("bindToPartyB", () => {
		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			user = new User(context, context.signers.user)
			await user.setup()
		})

		it("Should fail when user suspended", async () => {
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)
			await expect(
				context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			).to.be.revertedWith("Accessibility: Sender is Suspended")
		})

		it("Should fail when user is not partyA", async () => {
			await expect(
				context.accountFacet.connect(context.signers.hedger).bindToPartyB(context.signers.hedger.address)
			).to.be.revertedWith("Accessibility: Shouldn't be partyB")
		})

		it("should failed when partyB be zero address", async () => {
			await expect(context.accountFacet.connect(context.signers.user).bindToPartyB(ZeroAddress)).to.be.revertedWith("AccountFacet: Zero address")
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
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)
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
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)
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
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(context.signers.hedger.address)
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

	describe("Master account activation gating", () => {
		it("should revert when master account activation is disabled", async () => {
			await expect(context.accountFacet.connect(context.signers.hedger).activateMasterAccountMode()).to.be.revertedWith(
				"AccountFacet: Master account activation disabled",
			)
		})

		it("should allow master account activation after enabled by admin", async () => {
			await context.controlFacet.connect(context.signers.admin).setMasterAccountActivationMode(true)
			await expect(context.accountFacet.connect(context.signers.hedger).activateMasterAccountMode())
				.to.emit(context.accountFacet, "ActivateMasterAccountMode")
				.withArgs(context.signers.hedger.address)
			expect(await context.viewFacet.isInMasterAccountMode(context.signers.hedger.address)).to.equal(true)
		})
	})
}
