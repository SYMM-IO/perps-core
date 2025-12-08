import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import { expect, use } from "chai"

import {
	initializeFixture,
	initializeExternalTransferRelayerFixture,
	initializeVirtualFixture,
} from "./Initialize.fixture";
import { RunContext } from "./models/RunContext"
import { User } from "./models/User"
import { getDummySingleUpnlSig } from "./utils/SignatureUtils"
import { Hedger } from "./models/Hedger"
import { decimal, unDecimal } from "./utils/Common"
import { ethers } from "hardhat"
import { ZeroAddress } from "ethers"
import { toUtf8Bytes } from "ethers"
import type { ExternalTransferRelayer as SymmioExternalTransferRelayer, VirtualProvider } from "../src/types";
import { viewFacet } from "../src/types/contracts/facets";
import { ExternalTransferStatus } from "./models/Enums";

const SUSPENDED_FUNDS_WITHDRAWER_ROLE = ethers.keccak256(toUtf8Bytes("SUSPENDED_FUNDS_WITHDRAWER_ROLE"));

export function shouldBehaveLikeAccountFacet(): void {
	let context: RunContext, user: User, user2: User, hedger: Hedger
	let mockTarget: any, mockTarget2: any
	let targetAddress: string, targetAddress2: string
	let providerAddress: string, providerAddress2: string
	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances("500")
	})

	describe("Deposit", async function () {
		it("Should fail when accounting is paused", async function () {
			await context.controlFacet.pauseAccounting()
			await expect(context.accountFacet.connect(context.signers.user).deposit("300")).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("Should fail on low collateral", async function () {
			await expect(context.accountFacet.connect(context.signers.user2).deposit("300")).to.be.revertedWith("ERC20: insufficient allowance")
			await context.collateral.connect(context.signers.user2).approve(context.diamond, ethers.MaxUint256)
			await expect(context.accountFacet.connect(context.signers.user2).deposit("300")).to.be.revertedWith("ERC20: transfer amount exceeds balance")
		})

		it("Should deposit collateral", async function () {
			const userAddress = context.signers.user.getAddress()

			await context.accountFacet.connect(context.signers.user).deposit("300")
			expect(await context.viewFacet.balanceOf(userAddress)).to.equal("300")
			expect(await context.collateral.balanceOf(userAddress)).to.equal("200")
		})

		it("Should deposit collateral for another user", async function () {
			const userAddress = context.signers.user.getAddress()
			const user2Address = context.signers.user2.getAddress()

			await context.accountFacet.connect(context.signers.user).depositFor(user2Address, "300")
			expect(await context.viewFacet.balanceOf(userAddress)).to.equal("0")
			expect(await context.viewFacet.balanceOf(user2Address)).to.equal("300")
			expect(await context.collateral.balanceOf(userAddress)).to.equal("200")
		})

		it("Should fail to virtual deposit when accounting is paused", async function () {
			await context.controlFacet
				.connect(context.signers.admin)
				.grantRole(context.signers.admin, ethers.keccak256(toUtf8Bytes("VIRTUAL_DEPOSITOR_ROLE")))

			await context.controlFacet.pauseAccounting()
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
			const beforeBalance = await context.viewFacet.balanceOf(userAddress)
			expect(await context.accountFacet.connect(context.signers.admin).virtualDepositFor(userAddress, decimal(1n))).not.reverted
			const afterBalance = await context.viewFacet.balanceOf(userAddress)
			expect(afterBalance - beforeBalance).to.equal(decimal(1n))
		})
	})

	describe("Withdraw", async function () {
		beforeEach(async function () {
			await context.accountFacet.connect(context.signers.user).deposit("300")
		})

		it("Should fail to withdraw collateral more than deposit", async function () {
			await expect(context.accountFacet.connect(context.signers.user).withdraw("350")).to.be.reverted
		})

		it("Should fail when accounting is paused", async function () {
			await context.controlFacet.pauseAccounting()
			await expect(context.accountFacet.connect(context.signers.user).withdraw("300")).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("Should withdraw collateral", async function () {
			const userAddress = context.signers.user.getAddress()
			await context.accountFacet.connect(context.signers.user).withdraw("200")
			expect(await context.viewFacet.balanceOf(userAddress)).to.equal("100")
			expect(await context.collateral.balanceOf(userAddress)).to.equal("400")
		})

		it("Should withdraw collateral to another user", async function () {
			const userAddress = context.signers.user.getAddress()
			const user2Address = context.signers.user2.getAddress()
			await context.accountFacet.connect(context.signers.user).withdrawTo(user2Address, "50")
			expect(await context.viewFacet.balanceOf(userAddress)).to.equal("250")
			expect(await context.viewFacet.balanceOf(user2Address)).to.equal("0")
			expect(await context.collateral.balanceOf(userAddress)).to.equal("200")
			expect(await context.collateral.balanceOf(user2Address)).to.equal("50")
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
				await context.controlFacet.connect(context.signers.admin).suspendedAddress(userAddress)
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
				await context.controlFacet.connect(context.signers.admin).suspendedAddress(userAddress)

				const initialUserBalance = await context.viewFacet.balanceOf(userAddress)
				const initialRecipientBalance = await context.collateral.balanceOf(recipient)

				await context.accountFacet.connect(context.signers.admin).withdrawSuspendedUserFunds(userAddress, recipient, withdrawAmountStr)

				expect(await context.viewFacet.balanceOf(userAddress)).to.equal(initialUserBalance - withdrawAmount)
				expect(await context.collateral.balanceOf(recipient)).to.equal(initialRecipientBalance + withdrawAmount)
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
				await context.controlFacet.connect(context.signers.admin).suspendedAddress(userAddress)
				await expect(
					context.accountFacet.connect(context.signers.user).deallocateSuspendedUserFunds(userAddress, allocatedAmountStr),
				).to.be.revertedWith("Accessibility: Must has role")
			})

			it("Should fail when user is not suspended", async function () {
				await expect(
					context.accountFacet.connect(context.signers.admin).deallocateSuspendedUserFunds(userAddress, allocatedAmountStr),
				).to.be.revertedWith("Accessibility: User is not suspended")
			})

			it("Should deallocate suspended user funds and enable withdrawal", async function () {
				await context.controlFacet.connect(context.signers.admin).suspendedAddress(userAddress)

				const initialAllocated = await context.viewFacet.allocatedBalanceOfPartyA(userAddress)
				const initialBalance = await context.viewFacet.balanceOf(userAddress)
				const initialRecipientBalance = await context.collateral.balanceOf(recipient)

				await context.accountFacet.connect(context.signers.admin).deallocateSuspendedUserFunds(userAddress, allocatedAmountStr)
				expect(await context.viewFacet.allocatedBalanceOfPartyA(userAddress)).to.equal(initialAllocated - allocatedAmount)
				expect(await context.viewFacet.balanceOf(userAddress)).to.equal(initialBalance + allocatedAmount)

				await context.accountFacet.connect(context.signers.admin).withdrawSuspendedUserFunds(userAddress, recipient, allocatedAmountStr)
				expect(await context.viewFacet.balanceOf(userAddress)).to.equal(initialBalance)
				expect(await context.collateral.balanceOf(recipient)).to.equal(initialRecipientBalance + allocatedAmount)
			})
		})
	})

	describe("Allocate", async function () {
		beforeEach(async function () {
			await context.accountFacet.connect(context.signers.user).deposit("300")
		})

		it("Should fail on reaching balance limit", async function () {
			await context.controlFacet.connect(context.signers.admin).setBalanceLimitPerUser("100")
			await expect(context.accountFacet.connect(context.signers.user).allocate("300")).to.be.revertedWith(
				"AccountFacet: Allocated balance limit reached",
			)
		})

		it("Should fail when accounting is paused", async function () {
			await context.controlFacet.pauseAccounting()
			await expect(context.accountFacet.connect(context.signers.user).allocate("300")).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("Should fail on Insufficient balance", async function () {
			await expect(context.accountFacet.connect(context.signers.user).allocate("400")).to.be.revertedWith("AccountFacet: Insufficient balance")
		})

		it("Should allocate", async function () {
			const userAddress = context.signers.user.getAddress()
			await context.accountFacet.connect(context.signers.user).allocate("100")

			expect(await context.viewFacet.balanceOf(userAddress)).to.equal("200")
			expect(await context.viewFacet.allocatedBalanceOfPartyA(userAddress)).to.equal("100")
		})

		it("Should deposit and allocate collateral", async function () {
			const userAddress = context.signers.user.getAddress()

			await context.accountFacet.connect(context.signers.user).depositAndAllocate("200")
			expect(await context.viewFacet.balanceOf(userAddress)).to.equal("300")
			expect(await context.viewFacet.allocatedBalanceOfPartyA(userAddress)).to.equal("200")
			expect(await context.collateral.balanceOf(userAddress)).to.equal("0")
		})

		it("Should deposit and allocate collateral for user", async function () {
			const userAddress = context.signers.user.getAddress()

			await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(userAddress, "200")
			expect(await context.viewFacet.balanceOf(userAddress)).to.equal("300")
			expect(await context.viewFacet.allocatedBalanceOfPartyA(userAddress)).to.equal("200")
			expect(await context.collateral.balanceOf(userAddress)).to.equal("0")
		})

		describe("Deallocate", async function () {
			beforeEach(async function () {
				await context.accountFacet.connect(context.signers.user).allocate("300")
			})

			it("Should fail on insufficient allocated Balance", async function () {
				await expect(context.accountFacet.connect(context.signers.user).deallocate("400", await getDummySingleUpnlSig())).to.be.revertedWith(
					"AccountFacet: Insufficient allocated Balance",
				)
			})

			it("Should fail when accounting is paused", async function () {
				await context.controlFacet.pauseAccounting()
				await expect(context.accountFacet.connect(context.signers.user).deallocate("300", await getDummySingleUpnlSig())).to.be.revertedWith(
					"Pausable: Accounting paused",
				)
			})

			it("Should fail on available balance is lower than zero", async function () {
				await expect(context.accountFacet.connect(context.signers.user).deallocate("300", await getDummySingleUpnlSig(-350n))).to.be.revertedWith(
					"AccountFacet: Available balance is lower than zero",
				)
			})

			it("Should fail on partyA becoming liquidatable", async function () {
				await expect(context.accountFacet.connect(context.signers.user).deallocate("300", await getDummySingleUpnlSig(-50n))).to.be.revertedWith(
					"AccountFacet: partyA will be liquidatable",
				)
			})

			it("Should deallocate", async function () {
				const userAddress = context.signers.user.getAddress()
				await context.accountFacet.connect(context.signers.user).deallocate("50", await getDummySingleUpnlSig())
				expect(await context.viewFacet.balanceOf(userAddress)).to.equal("50")
				expect(await context.viewFacet.allocatedBalanceOfPartyA(userAddress)).to.equal("250")
			})

			it("Should fail to deallocate too often", async function () {
				const userAddress = context.signers.user.getAddress()
				await context.accountFacet.connect(context.signers.user).deallocate("25", await getDummySingleUpnlSig())
				await expect(context.accountFacet.connect(context.signers.user).deallocate("25", await getDummySingleUpnlSig())).to.be.revertedWith(
					"AccountFacet: Too many deallocate in a short window",
				)
				await time.increase((await context.viewFacet.getDeallocateDebounceTime()) + 1n)
				await context.accountFacet.connect(context.signers.user).deallocate("25", await getDummySingleUpnlSig())
				expect(await context.viewFacet.balanceOf(userAddress)).to.equal("50")
			})

			it("Should fail to withdraw due to cooldown", async function () {
				await context.accountFacet.connect(context.signers.user).deallocate("50", await getDummySingleUpnlSig())
				await expect(context.accountFacet.connect(context.signers.user).withdraw("50")).to.be.revertedWith("AccountFacet: Cooldown hasn't reached")
			})

			it("Should withdraw after cooldown", async function () {
				await context.accountFacet.connect(context.signers.user).deallocate("50", await getDummySingleUpnlSig())
				await time.increase(1000)
				await context.accountFacet.connect(context.signers.user).withdraw("50")
			})
		})

		describe("deallocateForPartyB", () => {
			beforeEach(async () => {
				context = await loadFixture(initializeFixture)

				user = new User(context, context.signers.user)
				await user.setup()
				await user.setBalances(decimal(500n), decimal(500n), decimal(500n))

				hedger = new Hedger(context, context.signers.hedger)
				await hedger.setup()
				await hedger.setBalances(decimal(700n), decimal(700n))

				const quoteId = await user.sendQuote()
				const quote = await context.viewFacet.getQuote(quoteId)

				const notional = unDecimal(quote.quantity * quote.requestedOpenPrice)
				await context.accountFacet.connect(context.signers.hedger).allocateForPartyB(unDecimal(notional * decimal(12n, 17)), quote.partyA)

				await context.partyBQuoteActionsFacet.connect(context.signers.hedger).lockQuote(quoteId, await getDummySingleUpnlSig(0n))
			})

			it("should failed if amount be higher than partyBAllocatedBalances", async () => {
				await expect(
					context.accountFacet
						.connect(context.signers.hedger)
						.deallocateForPartyB(decimal(210n), await user.getAddress(), await getDummySingleUpnlSig()),
				).to.be.revertedWith("AccountFacet: Insufficient allocated balance")
			})

			it("should failed if amount be higher than partyBAllocatedBalances", async () => {
				await expect(
					context.accountFacet
						.connect(context.signers.hedger)
						.deallocateForPartyB(decimal(101n), await user.getAddress(), await getDummySingleUpnlSig()),
				).to.be.revertedWith("AccountFacet: Will be liquidatable")
			})

			it("should deallocate for partyB successfully", async () => {
				expect(
					await context.accountFacet
						.connect(context.signers.hedger)
						.deallocateForPartyB(decimal(50n), await user.getAddress(), await getDummySingleUpnlSig()),
				).to.not.reverted

				const newAllocatedBalanceOfPartyB = await context.viewFacet.allocatedBalanceOfPartyB(await hedger.getAddress(), await user.getAddress())

				expect(newAllocatedBalanceOfPartyB).to.be.equal(decimal(120n) - decimal(50n))
			})
		})
	})

	describe("InternalTransfer", async function () {
		const depositAmount = "300"
		const transferAmount = "250"

		beforeEach(async () => {
			user2 = new User(context, context.signers.user2)
			await user2.setup()
			await user2.setBalances("500")

			hedger = new Hedger(context, context.signers.hedger)
			await hedger.setup()
			await hedger.setBalances("500")

			await context.accountFacet.connect(context.signers.user).deposit(depositAmount)
		})

		it("should internal transfer successfully", async () => {
			await context.accountFacet.connect(context.signers.user).internalTransfer(await user2.getAddress(), transferAmount)
			expect(await context.viewFacet.balanceOf(await user2.getAddress())).to.be.equal("0")
			expect(await context.viewFacet.allocatedBalanceOfPartyA(await user2.getAddress())).to.be.equal(transferAmount)

			const expectedRemainingBalance = (BigInt(depositAmount) - BigInt(transferAmount)).toString()
			expect(await context.viewFacet.balanceOf(await user.getAddress())).to.be.equal(expectedRemainingBalance)
		})

		it("Should fail when internal transfers are paused", async function () {
			await context.controlFacet.connect(context.signers.admin).pauseInternalTransfer()

			await expect(context.accountFacet.connect(context.signers.user).internalTransfer(await user2.getAddress(), transferAmount)).to.be.revertedWith(
				"Pausable: Internal transfer paused",
			)
		})

		it("Should fail when accounting is paused", async function () {
			await context.controlFacet.connect(context.signers.admin).pauseAccounting()

			await expect(context.accountFacet.connect(context.signers.user).internalTransfer(await user2.getAddress(), transferAmount)).to.be.revertedWith(
				"Pausable: Accounting paused",
			)
		})

		it("Should fail when global pause is active", async function () {
			await context.controlFacet.connect(context.signers.admin).pauseGlobal()

			await expect(context.accountFacet.connect(context.signers.user).internalTransfer(await user2.getAddress(), transferAmount)).to.be.revertedWith(
				"Pausable: Global paused",
			)
		})
	})

	describe("ExternalTransfer", async function () {
		let mockTarget: any
		const depositAmount = "300"
		const transferAmount = "100"
		const zeroExternalTransferAmount = "0"

		beforeEach(async function () {
			const MockExternalTransferRelayer = await ethers.getContractFactory("contracts/test/MockExternalTransferTarget.sol:ExternalTransferRelayer")
			mockTarget = await MockExternalTransferRelayer.deploy()
			await mockTarget.waitForDeployment()
			targetAddress = await mockTarget.getAddress()

			mockTarget2 = await MockExternalTransferRelayer.deploy()
			await mockTarget2.waitForDeployment()
			targetAddress2 = await mockTarget2.getAddress()

			await context.accountFacet.connect(context.signers.user).deposit(depositAmount)

			await context.controlFacet.connect(context.signers.admin).addRelayerForExternalTransferTarget(targetAddress, targetAddress)
		})

		it("Should allow authorized users to call externalTransfer", async function () {
			await expect(context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, transferAmount, targetAddress))
				.to.not.be.reverted
		})

		it("Should fail when sender is suspended", async function () {
			await context.controlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)

			await expect(
				context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, transferAmount, targetAddress),
			).to.be.revertedWith("Accessibility: Sender is Suspended")
		})

		it("Should correctly update sender balance", async function () {
			const initialBalance = await context.viewFacet.balanceOf(context.signers.user.address)

			await context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, transferAmount, targetAddress)

			const finalBalance = await context.viewFacet.balanceOf(context.signers.user.address)
			expect(finalBalance).to.equal(initialBalance - BigInt(transferAmount))
		})

		it("Should fail with insufficient balance", async function () {
			const userBalance = await context.viewFacet.balanceOf(context.signers.user.address)
			const excessiveAmount = userBalance + BigInt(transferAmount)

			await expect(
				context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, excessiveAmount.toString(), targetAddress),
			).to.be.reverted
		})

		it("Should transfer collateral to relayer", async function () {
			const initialRelayerBalance = await context.collateral.balanceOf(targetAddress)

			await context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, transferAmount, targetAddress)

			const finalRelayerBalance = await context.collateral.balanceOf(targetAddress)
			expect(finalRelayerBalance).to.equal(initialRelayerBalance + BigInt(transferAmount))
		})

		it("Should call onTransfer on relayer with correct parameters", async function () {
			const receiverAddress = context.signers.user2.address
			const senderAddress = context.signers.user.address

			await context.accountFacet.connect(context.signers.user).externalTransfer(receiverAddress, transferAmount, targetAddress)

			const lastTransfer = await mockTarget.lastTransfer()
			expect(lastTransfer.collateral).to.equal(await context.collateral.getAddress())
			expect(lastTransfer.sender).to.equal(senderAddress)
			expect(lastTransfer.receiver).to.equal(receiverAddress)
			expect(lastTransfer.amount).to.equal(transferAmount)
			expect(lastTransfer.target).to.equal(targetAddress)
		})

		it("Should fail with zero amount transfers", async function () {
			await expect(
				context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, zeroExternalTransferAmount, targetAddress),
			).to.be.revertedWith("AccountFacet: Amount is zero")
		})

		it("Should fail with zero receiver address", async function () {
			await expect(
				context.accountFacet.connect(context.signers.user).externalTransfer(ethers.ZeroAddress, transferAmount, targetAddress),
			).to.be.revertedWith("AccountFacet: Zero receiver or target")
		})

		it("Should fail with zero target address", async function () {
			await expect(
				context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, transferAmount, ethers.ZeroAddress),
			).to.be.revertedWith("AccountFacet: Zero receiver or target")
		})

		it("Should handle self-transfers", async function () {
			await expect(context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user.address, transferAmount, targetAddress))
				.to.not.be.reverted
		})

		it("Should fail when target is not whitelisted", async function () {
			await expect(
				context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, transferAmount, targetAddress2),
			).to.be.revertedWith("AccountFacet: Target not whitelisted")
		})

		it("Should fail when relayer is removed", async function () {
			await context.controlFacet.connect(context.signers.admin).removeRelayerForExternalTransferTarget(targetAddress)

			await expect(
				context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, transferAmount, targetAddress),
			).to.be.revertedWith("AccountFacet: Target not whitelisted")
		})

		it("Should handle relayer revert scenarios", async function () {
			await mockTarget.setShouldRevert(true, "Relayer error")

			await expect(
				context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, transferAmount, targetAddress),
			).to.be.revertedWith("Relayer error")
		})

		it("Should fail when external transfers are paused", async function () {
			await context.controlFacet.connect(context.signers.admin).pauseExternalTransfer()

			await expect(
				context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, transferAmount, targetAddress),
			).to.be.revertedWith("Pausable: External transfer paused")
		})

		it("Should fail when accounting is paused", async function () {
			await context.controlFacet.connect(context.signers.admin).pauseAccounting()

			await expect(
				context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, transferAmount, targetAddress),
			).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("Should fail when global pause is active", async function () {
			await context.controlFacet.connect(context.signers.admin).pauseGlobal()

			await expect(
				context.accountFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, transferAmount, targetAddress),
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
			await context.controlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)

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
			await context.controlFacet.connect(context.signers.admin).pauseExternalTransfer()

			await expect(
				context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress)
			).to.be.revertedWith("Pausable: External transfer paused")
		})

		it("Should fail when accounting is paused", async function () {
			await context.controlFacet.connect(context.signers.admin).pauseAccounting()

			await expect(
				context.accountFacet.connect(context.signers.user).virtualExternalTransfer(context.signers.user2.address, transferAmount,context.diamond, providerAddress)
			).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("Should fail when global pause is active", async function () {
			await context.controlFacet.connect(context.signers.admin).pauseGlobal()

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
		it("should failed when user suspended", async () => {
			await context.controlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)
			await expect(context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)).to.be.revertedWith(
				"Accessibility: Sender is Suspended",
			)
		})

		it("should failed when user is not partyA", async () => {
			await expect(context.accountFacet.connect(context.signers.hedger).bindToPartyB(context.signers.hedger.address)).to.be.revertedWith(
				"Accessibility: Shouldn't be partyB",
			)
		})

		it("should failed when partyB be zero address", async () => {
			await expect(context.accountFacet.connect(context.signers.user).bindToPartyB(ZeroAddress)).to.be.revertedWith("AccountFacet: Zero address")
		})

		it("should failed when bound", async () => {
			await context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			await expect(context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)).to.be.revertedWith(
				"AccountFacet: Invalid state",
			)
		})

		it("should bind successfully", async () => {
			await expect(context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)).to.not.reverted
			const bindState = await context.viewFacet.getBindState(context.signers.user.address)
			expect(bindState.partyB).to.equal(context.signers.hedger.address)
			expect(bindState.status).to.equal(1)
		})
	})

	describe("unbindFromPartyB", () => {
		it("should failed when user suspended", async () => {
			await context.controlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)
			await expect(context.accountFacet.connect(context.signers.user).requestToUnbindFromPartyB()).to.be.revertedWith(
				"Accessibility: Sender is Suspended",
			)
		})

		it("should failed when user is not partyA", async () => {
			await expect(context.accountFacet.connect(context.signers.hedger).requestToUnbindFromPartyB()).to.be.revertedWith(
				"Accessibility: Shouldn't be partyB",
			)
		})

		it("should failed when not bound", async () => {
			await expect(context.accountFacet.connect(context.signers.user).requestToUnbindFromPartyB()).to.be.revertedWith("AccountFacet: Invalid state")
		})

		it("should failed when request to unbound before", async () => {
			await context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			await context.accountFacet.connect(context.signers.user).requestToUnbindFromPartyB()
			await expect(context.accountFacet.connect(context.signers.user).requestToUnbindFromPartyB()).to.be.revertedWith("AccountFacet: Invalid state")
		})

		it("should request unbind successfully", async () => {
			await context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			await expect(context.accountFacet.connect(context.signers.user).requestToUnbindFromPartyB()).to.not.reverted
			const bindState = await context.viewFacet.getBindState(context.signers.user.address)
			expect(bindState.status).to.equal(2)
			expect(bindState.partyB).to.equal(context.signers.hedger.address)
		})
	})

	describe("cancelUnbindFromPartyB", () => {
		it("should failed when user suspended", async () => {
			await context.controlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)
			await expect(context.accountFacet.connect(context.signers.user).cancelUnbindRequest()).to.be.revertedWith("Accessibility: Sender is Suspended")
		})

		it("should failed when user is not partyA", async () => {
			await expect(context.accountFacet.connect(context.signers.hedger).cancelUnbindRequest()).to.be.revertedWith(
				"Accessibility: Shouldn't be partyB",
			)
		})

		it("should failed when not request to unbound", async () => {
			await expect(context.accountFacet.connect(context.signers.user).cancelUnbindRequest()).to.be.revertedWith("AccountFacet: Invalid state")
		})

		it("should cancel request unbind successfully", async () => {
			await context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			await context.accountFacet.connect(context.signers.user).requestToUnbindFromPartyB()
			await expect(context.accountFacet.connect(context.signers.user).cancelUnbindRequest()).to.not.reverted
			const bindState = await context.viewFacet.getBindState(context.signers.user.address)
			expect(bindState.status).to.equal(1)
			expect(bindState.partyB).to.equal(context.signers.hedger.address)
		})
	})

	describe("acceptUnbindFromPartyB", () => {
		beforeEach(async () => {
			await context.accountFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			await context.controlFacet.connect(context.signers.admin).setUnbindCooldown(100)
		})

		it("should failed when user suspended", async () => {
			await context.controlFacet.connect(context.signers.admin).suspendedAddress(context.signers.hedger.address)
			await expect(context.accountFacet.connect(context.signers.hedger).completeUnbindRequest(context.signers.user.address)).to.be.revertedWith(
				"Accessibility: Sender is Suspended",
			)
		})

		it("should failed when not request to unbound", async () => {
			await expect(context.accountFacet.connect(context.signers.hedger).completeUnbindRequest(context.signers.user.address)).to.be.revertedWith(
				"AccountFacet: Invalid state",
			)
		})

		it("should failed when the bind state partyB not same as caller", async () => {
			await context.accountFacet.connect(context.signers.user).requestToUnbindFromPartyB()
			await expect(context.accountFacet.connect(context.signers.hedger2).completeUnbindRequest(context.signers.user.address)).to.be.revertedWith(
				"AccountFacet: Cooldown not reached",
			)
		})

		it("should complete unbind successfully by partyB", async () => {
			await context.accountFacet.connect(context.signers.user).requestToUnbindFromPartyB()
			await expect(context.accountFacet.connect(context.signers.hedger).completeUnbindRequest(context.signers.user.address)).to.not.reverted
			const bindState = await context.viewFacet.getBindState(context.signers.user.address)
			expect(bindState.status).to.equal(0)
			expect(bindState.partyB).to.equal(ZeroAddress)
		})

		it("should complete unbind successfully after cooldown", async () => {
			await context.accountFacet.connect(context.signers.user).requestToUnbindFromPartyB()
			const unbindCooldown = await context.viewFacet.unbindCooldown()
			console.log(unbindCooldown)
			await time.increase(unbindCooldown + 1n)
			await expect(context.accountFacet.connect(context.signers.user2).completeUnbindRequest(context.signers.user.address)).to.not.reverted
			const bindState2 = await context.viewFacet.getBindState(context.signers.user.address)
			expect(bindState2.status).to.equal(0)
			expect(bindState2.partyB).to.equal(ZeroAddress)
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
