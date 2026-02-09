import { expect } from "chai"
import { ZeroAddress } from "ethers"
import { toUtf8Bytes } from "ethers"

import type { ExternalTransferRelayer as SymmioExternalTransferRelayer, VirtualProvider } from "../src/types/index.js"
import { initializeFixture, initializeExternalTransferRelayerFixture, initializeVirtualFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { ExternalTransferStatus } from "./models/Enums.js"
import { PositionType } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder, marketQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp } from "./utils/Common.js"
import { migratePartyBToCross } from "./utils/CrossPartyB.js"
import { getDummySingleUpnlSig, getDummySingleUpnlWithPendingBalanceSig } from "./utils/SignatureUtils.js"

const SUSPENDED_FUNDS_WITHDRAWER_ROLE = ethers.keccak256(toUtf8Bytes("SUSPENDED_FUNDS_WITHDRAWER_ROLE"))

export function shouldBehaveLikeAccountFacet(): void {
	let context: RunContext, user: User, user2: User, hedger: Hedger, hedger2: Hedger
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
			await expect(context.accountFacet.connect(context.signers.user).deposit(BALANCES.DEPOSIT_AMOUNT)).to.be.revertedWith(
				"Pausable: Accounting paused",
			)
		})

		it("Should fail on low collateral", async function () {
			await expect(context.accountFacet.connect(context.signers.user2).deposit(BALANCES.DEPOSIT_AMOUNT)).to.be.revertedWith(
				"ERC20: insufficient allowance",
			)

			await context.collateral.connect(context.signers.user2).approve(context.diamond, ethers.MaxUint256)
			await expect(context.accountFacet.connect(context.signers.user2).deposit(BALANCES.DEPOSIT_AMOUNT)).to.be.revertedWith(
				"ERC20: transfer amount exceeds balance",
			)
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

		it("Should fail to virtual deposit when calling from non-registered provider", async function () {
			await expect(context.accountFacet.connect(context.signers.user).virtualDepositFor(await user.getAddress(), decimal(1n))).to.be.revertedWith(
				"AccountFacet : msg.sender not registered as virtual provider",
			)
		})

		it("Should virtual deposit for user", async function () {
			await context.controlFacet.connect(context.signers.admin).registerVirtualProvider(context.signers.admin.address)

			const userAddress = await user.getAddress()
			const depositAmount = decimal(1n)
			const beforeBalance = await context.viewFacet.balanceOf(userAddress)

			await expect(context.accountFacet.connect(context.signers.admin).virtualDepositFor(userAddress, depositAmount)).to.not.be.reverted

			const afterBalance = await context.viewFacet.balanceOf(userAddress)
			expect(afterBalance - beforeBalance).to.equal(depositAmount)
		})

		it("Should transfer funds with depositVirtualFunds", async function () {
			const provider = context.signers.admin
			await context.controlFacet.connect(provider).registerVirtualProvider(provider.address)

			const amount = decimal(2n)
			await context.collateral.mint(provider.address, amount)
			await context.collateral.connect(provider).approve(context.diamond, amount)

			const contractBalanceBefore = await context.collateral.balanceOf(context.diamond)
			const providerBalanceBefore = await context.collateral.balanceOf(provider.address)
			const providerSymmioBalanceBefore = await context.viewFacet.balanceOf(provider.address)

			await expect(context.accountFacet.connect(provider).depositVirtualFunds(amount))
				.to.emit(context.accountFacet, "DepositVirtualFunds")
				.withArgs(provider.address, amount)

			const contractBalanceAfter = await context.collateral.balanceOf(context.diamond)
			const providerBalanceAfter = await context.collateral.balanceOf(provider.address)
			const providerSymmioBalanceAfter = await context.viewFacet.balanceOf(provider.address)

			expect(contractBalanceAfter - contractBalanceBefore).to.equal(amount)
			expect(providerBalanceBefore - providerBalanceAfter).to.equal(amount)
			expect(providerSymmioBalanceAfter).to.equal(providerSymmioBalanceBefore)
		})

		it("Should fail depositVirtualFunds for non-registered provider", async function () {
			await expect(context.accountFacet.connect(context.signers.user).depositVirtualFunds(decimal(1n))).to.be.revertedWith(
				"AccountFacet: signer not registered as virtual provider",
			)
		})

		it("Should rely on msg.sender for depositVirtualFunds", async function () {
			const provider = context.signers.admin
			await context.controlFacet.connect(provider).registerVirtualProvider(provider.address)
			await context.controlFacet.connect(provider).setSigner(provider.address)

			await expect(context.accountFacet.connect(context.signers.user).depositVirtualFunds(decimal(1n))).to.be.revertedWith(
				"AccountFacet: signer not registered as virtual provider",
			)

			await context.controlFacet.connect(provider).setSigner(ZeroAddress)
		})
	})

	describe("Pledge collateral", function () {
		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			hedger = new Hedger(context, context.signers.hedger)
			await hedger.setup()
			await hedger.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.INITIAL_COLLATERAL)
			await context.collateral.connect(context.signers.hedger).mint(await hedger.getAddress(), decimal(1000n))
			await context.collateral.connect(context.signers.hedger).approve(context.diamond, ethers.MaxUint256)
		})

		it("reverts pledge collateral actions when accounting is paused", async function () {
			const amount = decimal(1n)
			await context.pauseControlFacet.pauseAccounting()

			await expect(context.pledgeFacet.connect(hedger.signer).depositPledge(await context.collateral.getAddress(), amount)).to.be.revertedWith(
				"Pausable: Accounting paused",
			)

			await expect(
				context.pledgeFacet.connect(hedger.signer).requestPledgeWithdraw(await context.collateral.getAddress(), amount, context.signers.user.address),
			).to.be.revertedWith("Pausable: Accounting paused")

			await expect(context.pledgeFacet.connect(hedger.signer).cancelPledgeWithdraw()).to.be.revertedWith("Pausable: Accounting paused")

			await expect(
				context.pledgeFacet.acceptPledgeWithdraw(await hedger.getAddress(), amount, await context.collateral.getAddress()),
			).to.be.revertedWith("Pausable: Accounting paused")

			await expect(
				context.pledgeFacet.slashPledge(await hedger.getAddress(), await context.collateral.getAddress(), amount, context.signers.user.address),
			).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("reverts pledge collateral actions for suspended user", async function () {
			const amount = decimal(1n)
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(await hedger.getAddress())

			await expect(context.pledgeFacet.connect(hedger.signer).depositPledge(await context.collateral.getAddress(), amount)).to.be.revertedWith(
				"Accessibility: Sender is Suspended",
			)

			await expect(
				context.pledgeFacet.connect(hedger.signer).requestPledgeWithdraw(await context.collateral.getAddress(), amount, context.signers.user.address),
			).to.be.revertedWith("Accessibility: Sender is Suspended")

			await expect(context.pledgeFacet.connect(hedger.signer).cancelPledgeWithdraw()).to.be.revertedWith("Accessibility: Sender is Suspended")
		})

		it("validates depositPledge require checks", async function () {
			await expect(context.pledgeFacet.connect(hedger.signer).depositPledge(await context.collateral.getAddress(), 0n)).to.be.revertedWith(
				"AccountFacet: invalid amount",
			)
		})

		it("validates requestPledgeWithdraw require checks", async function () {
			const token = await context.collateral.getAddress()
			const recipient = context.signers.user.address

			await expect(context.pledgeFacet.connect(hedger.signer).requestPledgeWithdraw(token, 0n, recipient)).to.be.revertedWith(
				"AccountFacet: invalid amount",
			)

			await expect(context.pledgeFacet.connect(hedger.signer).requestPledgeWithdraw(token, decimal(1n), ZeroAddress)).to.be.revertedWith(
				"AccountFacet: invalid recipient",
			)

			await context.pledgeFacet.connect(hedger.signer).depositPledge(token, decimal(10n))
			await expect(context.pledgeFacet.connect(hedger.signer).requestPledgeWithdraw(token, decimal(11n), recipient)).to.be.revertedWith(
				"AccountFacet: insufficient Pledge collateral",
			)

			await expect(context.pledgeFacet.connect(hedger.signer).requestPledgeWithdraw(token, decimal(5n), recipient)).to.not.be.reverted
			await expect(context.pledgeFacet.connect(hedger.signer).requestPledgeWithdraw(token, decimal(1n), recipient)).to.be.revertedWith(
				"AccountFacet: withdraw pending",
			)
		})

		it("validates cancelPledgeWithdraw require checks", async function () {
			await expect(context.pledgeFacet.connect(hedger.signer).cancelPledgeWithdraw()).to.be.revertedWith("AccountFacet: no pending Pledge withdraw")
		})

		it("validates acceptPledgeWithdraw require checks", async function () {
			const token = await context.collateral.getAddress()
			const amount = decimal(10n)
			const recipient = context.signers.user.address

			// role check
			await expect(
				context.pledgeFacet.connect(context.signers.user).acceptPledgeWithdraw(await hedger.getAddress(), amount, token),
			).to.be.revertedWith("Accessibility: Must have role")

			// pending check
			await expect(context.pledgeFacet.acceptPledgeWithdraw(await hedger.getAddress(), amount, token)).to.be.revertedWith(
				"AccountFacet: no pending Pledge withdraw",
			)

			// params mismatch
			await context.pledgeFacet.connect(hedger.signer).depositPledge(token, amount)
			await context.pledgeFacet.connect(hedger.signer).requestPledgeWithdraw(token, amount, recipient)
			await expect(context.pledgeFacet.acceptPledgeWithdraw(await hedger.getAddress(), amount, ZeroAddress)).to.be.revertedWith(
				"AccountFacet: params mismatch",
			)

			// amount mismatch
			await expect(context.pledgeFacet.acceptPledgeWithdraw(await hedger.getAddress(), amount + 1n, token)).to.be.revertedWith(
				"AccountFacet: params mismatch",
			)
		})

		it("reverts acceptPledgeWithdraw when approved amount exceeds requested amount", async function () {
			const token = await context.collateral.getAddress()
			const recipient = context.signers.user.address
			const depositAmount = decimal(1000n)
			const requestedWithdrawAmount = decimal(500n)

			// Deposit 1000 pledge collateral
			await context.pledgeFacet.connect(hedger.signer).depositPledge(token, depositAmount)

			// Request to withdraw 500
			await context.pledgeFacet.connect(hedger.signer).requestPledgeWithdraw(token, requestedWithdrawAmount, recipient)

			// Try to accept with 501 (more than requested) - should fail with params mismatch
			await expect(context.pledgeFacet.acceptPledgeWithdraw(await hedger.getAddress(), requestedWithdrawAmount + 1n, token)).to.be.revertedWith(
				"AccountFacet: params mismatch",
			)

			// Try to accept with 1000 (full deposit, but more than requested) - should fail with params mismatch
			await expect(context.pledgeFacet.acceptPledgeWithdraw(await hedger.getAddress(), depositAmount, token)).to.be.revertedWith(
				"AccountFacet: params mismatch",
			)

			// Accept with exact requested amount - should succeed
			await expect(context.pledgeFacet.acceptPledgeWithdraw(await hedger.getAddress(), requestedWithdrawAmount, token)).to.not.be.reverted
		})

		it("allows partial approval of pledge withdrawal up to requested amount", async function () {
			const token = await context.collateral.getAddress()
			const recipient = context.signers.user.address
			const depositAmount = decimal(1000n)
			const requestedWithdrawAmount = decimal(500n)
			const partialApprovalAmount = decimal(300n)

			// Deposit 1000 pledge collateral
			await context.pledgeFacet.connect(hedger.signer).depositPledge(token, depositAmount)

			// Request to withdraw 500
			await context.pledgeFacet.connect(hedger.signer).requestPledgeWithdraw(token, requestedWithdrawAmount, recipient)

			const recipientBalanceBefore = await context.collateral.balanceOf(recipient)

			// Accept with 300 (less than requested) - should succeed (partial approval allowed)
			await expect(context.pledgeFacet.acceptPledgeWithdraw(await hedger.getAddress(), partialApprovalAmount, token)).to.not.be.reverted

			// Verify recipient received the partial amount
			const recipientBalanceAfter = await context.collateral.balanceOf(recipient)
			expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(partialApprovalAmount)
		})

		it("validates acceptPledgeWithdraw requester mismatch check (corrupted storage)", async function () {
			const token = await context.collateral.getAddress()
			const amount = decimal(10n)
			const recipient = context.signers.user.address
			const partyB = await hedger.getAddress()

			await context.pledgeFacet.connect(hedger.signer).depositPledge(token, amount)
			await context.pledgeFacet.connect(hedger.signer).requestPledgeWithdraw(token, amount, recipient)

			// Corrupt `pledgeWithdrawalRequests[partyB].requester` in diamond storage to hit the `requester mismatch` require.
			// pledgeWithdrawalRequests is in PledgeStorage at slot 1 (after pledgeDeposit mapping)
			const pledgeStorageBaseSlot = BigInt(ethers.keccak256(toUtf8Bytes("diamond.standard.storage.pledge")))
			const pledgeWithdrawalRequestsSlot = pledgeStorageBaseSlot + 1n
			const entryBase = BigInt(
				ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [partyB, pledgeWithdrawalRequestsSlot])),
			)
			const requesterAndStatusSlot = ethers.toBeHex(entryBase + 3n, 32)
			const packedRequesterAndStatus = ethers.toBeHex(0n + (1n << 160n), 32) // requester=0x0, status=PENDING(1)

			await ethers.provider.send("hardhat_setStorageAt", [context.diamond, requesterAndStatusSlot, packedRequesterAndStatus])
			await ethers.provider.send("hardhat_mine", ["0x1"])

			await expect(context.pledgeFacet.acceptPledgeWithdraw(partyB, amount, token)).to.be.revertedWith("AccountFacet: requester mismatch")
		})

		it("validates slashPledge require checks", async function () {
			const token = await context.collateral.getAddress()
			const recipient = context.signers.user.address

			await expect(context.pledgeFacet.connect(context.signers.user).slashPledge(await hedger.getAddress(), token, 1n, recipient)).to.be.revertedWith(
				"Accessibility: Must have role",
			)

			await expect(context.pledgeFacet.slashPledge(await hedger.getAddress(), token, 0n, recipient)).to.be.revertedWith(
				"AccountFacet: invalid penalty",
			)

			await expect(context.pledgeFacet.slashPledge(await hedger.getAddress(), token, 1n, recipient)).to.be.revertedWith(
				"AccountFacet: insufficient Pledge collateral",
			)
		})

		it("deposits pledge collateral", async function () {
			const amount = decimal(200n)
			const beforeDiamond = await context.collateral.balanceOf(context.diamond)
			await expect(context.pledgeFacet.connect(hedger.signer).depositPledge(await context.collateral.getAddress(), amount))
				.to.emit(context.pledgeFacet, "PledgeCollateralDeposited")
				.withArgs(await hedger.getAddress(), await context.collateral.getAddress(), amount)
			const afterDiamond = await context.collateral.balanceOf(context.diamond)
			expect(afterDiamond - beforeDiamond).to.equal(amount)
		})

		it("requests and cancels pledge withdraw", async function () {
			const amount = decimal(150n)
			const recipient = context.signers.user.address
			await context.pledgeFacet.connect(hedger.signer).depositPledge(await context.collateral.getAddress(), amount)
			await expect(context.pledgeFacet.connect(hedger.signer).requestPledgeWithdraw(await context.collateral.getAddress(), amount, recipient))
				.to.emit(context.pledgeFacet, "PledgeWithdrawRequested")
				.withArgs(await hedger.getAddress(), await context.collateral.getAddress(), amount, recipient)

			await expect(context.pledgeFacet.connect(hedger.signer).cancelPledgeWithdraw())
				.to.emit(context.pledgeFacet, "PledgeWithdrawCancelled")
				.withArgs(await hedger.getAddress(), await context.collateral.getAddress(), amount)

			// can request again after cancel
			await expect(context.pledgeFacet.connect(hedger.signer).requestPledgeWithdraw(await context.collateral.getAddress(), amount, recipient)).to.not
				.be.reverted
		})

		it("approves pledge withdraw and transfers to recipient", async function () {
			const amount = decimal(180n)
			const recipient = context.signers.user.address
			await context.pledgeFacet.connect(hedger.signer).depositPledge(await context.collateral.getAddress(), amount)
			await context.pledgeFacet.connect(hedger.signer).requestPledgeWithdraw(await context.collateral.getAddress(), amount, recipient)
			const beforeRecipient = await context.collateral.balanceOf(recipient)
			const beforeDiamond = await context.collateral.balanceOf(context.diamond)

			await expect(context.pledgeFacet.acceptPledgeWithdraw(await hedger.getAddress(), amount, await context.collateral.getAddress()))
				.to.emit(context.pledgeFacet, "PledgeWithdrawApproved")
				.withArgs(await hedger.getAddress(), await context.collateral.getAddress(), amount)

			const afterRecipient = await context.collateral.balanceOf(recipient)
			const afterDiamond = await context.collateral.balanceOf(context.diamond)
			expect(afterRecipient - beforeRecipient).to.equal(amount)
			expect(beforeDiamond - afterDiamond).to.equal(amount)
		})

		it("slashes pledge from user", async function () {
			const amount = decimal(120n)
			const recipient = context.signers.user.address
			await context.pledgeFacet.connect(hedger.signer).depositPledge(await context.collateral.getAddress(), amount)
			const beforeRecipient = await context.collateral.balanceOf(recipient)
			const beforeDiamond = await context.collateral.balanceOf(context.diamond)

			await expect(context.pledgeFacet.slashPledge(await hedger.getAddress(), await context.collateral.getAddress(), amount, recipient))
				.to.emit(context.pledgeFacet, "UserSlashed")
				.withArgs(await hedger.getAddress(), await context.collateral.getAddress(), amount, recipient)

			const afterRecipient = await context.collateral.balanceOf(recipient)
			const afterDiamond = await context.collateral.balanceOf(context.diamond)
			expect(afterRecipient - beforeRecipient).to.equal(amount)
			expect(beforeDiamond - afterDiamond).to.equal(amount)
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
			await expect(context.accountFacet.connect(context.signers.user).withdraw(excessiveAmount)).to.be.reverted
		})

		it("Should fail when accounting is paused", async function () {
			await context.pauseControlFacet.pauseAccounting()
			await expect(context.accountFacet.connect(context.signers.user).withdraw(BALANCES.DEPOSIT_AMOUNT)).to.be.revertedWith(
				"Pausable: Accounting paused",
			)
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

		it("Should not allow legacy withdraw to bypass locked collateral", async function () {
			user2 = new User(context, context.signers.user2)
			await user2.setup()

			await context.controlFacet.connect(context.signers.admin).registerVirtualProvider(context.signers.admin.address)
			const user2Address = await context.signers.user2.getAddress()
			const virtualBalance = decimal(150n)
			await context.accountFacet.connect(context.signers.admin).virtualDepositFor(user2Address, virtualBalance)

			const receiver = ethers.dataSlice(await context.signers.user.getAddress(), 0, 20)
			const chainId = (await ethers.provider.getNetwork()).chainId
			const parts = [
				{
					id: 1,
					amount: BALANCES.WITHDRAW_AMOUNT,
					chainId,
					receiver,
					virtualProvider: ZeroAddress,
					expressProvider: ZeroAddress,
				},
			]

			await context.controlFacet.connect(context.signers.admin).setMaxWithdrawParts(10)
			await context.withdrawFacet.connect(context.signers.user).initiateWithdraw(parts, false, "0x")

			await time.increase(200)
			await expect(context.accountFacet.connect(context.signers.user2).withdraw(virtualBalance)).to.be.revertedWith(
				"AccountFacet: Insufficient contract collateral",
			)
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
				).to.be.revertedWith("Accessibility: Must have role")
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
				).to.be.revertedWith("Accessibility: Must have role")
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
			await expect(context.accountFacet.connect(context.signers.user).allocate(BALANCES.DEPOSIT_AMOUNT)).to.be.revertedWith(
				"AccountFacet: Allocated balance limit reached",
			)
		})

		it("Should fail when accounting is paused", async function () {
			await context.pauseControlFacet.pauseAccounting()
			await expect(context.accountFacet.connect(context.signers.user).allocate(BALANCES.DEPOSIT_AMOUNT)).to.be.revertedWith(
				"Pausable: Accounting paused",
			)
		})

		it("Should fail on Insufficient balance", async function () {
			const excessiveAmount = BALANCES.DEPOSIT_AMOUNT + BALANCES.ALLOCATE_AMOUNT
			await expect(context.accountFacet.connect(context.signers.user).allocate(excessiveAmount)).to.be.revertedWith(
				"AccountFacet: Insufficient balance",
			)
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
			const quote = await context.viewFacetQuote.getQuote(quoteId)

			const notional = (quote.quantity * quote.requestedOpenPrice) / decimal(1n)
			await context.partyBAccountFacet
				.connect(context.signers.hedger)
				.allocateForPartyB((notional * QUOTE_NOTIONAL_MULTIPLIER) / decimal(1n), quote.partyA)

			await context.partyBQuoteActionsFacet.connect(context.signers.hedger).lockQuote(quoteId, await getDummySingleUpnlSig(UPNL_VALUES.ZERO))
		})

		it("Should fail if amount be higher than partyBAllocatedBalances", async () => {
			const excessiveAmount = decimal(210n)
			await expect(
				context.partyBAccountFacet
					.connect(context.signers.hedger)
					.deallocateForPartyB(excessiveAmount, await user.getAddress(), await getDummySingleUpnlSig()),
			).to.be.revertedWith("AccountFacet: Insufficient allocated balance")
		})

		it("Should fail if deallocation would make partyB liquidatable", async () => {
			const liquidatableAmount = decimal(101n)
			await expect(
				context.partyBAccountFacet
					.connect(context.signers.hedger)
					.deallocateForPartyB(liquidatableAmount, await user.getAddress(), await getDummySingleUpnlSig()),
			).to.be.revertedWith("AccountFacet: Will be liquidatable")
		})

		it("Should deallocate for partyB successfully", async () => {
			const deallocateAmount = BALANCES.DEALLOCATE_AMOUNT
			const expectedAllocated = BALANCES.HEDGER_ALLOCATE - deallocateAmount

			await expect(
				context.partyBAccountFacet
					.connect(context.signers.hedger)
					.deallocateForPartyB(deallocateAmount, await user.getAddress(), await getDummySingleUpnlSig()),
			).to.not.be.reverted

			const newAllocatedBalanceOfPartyB = await context.viewFacet.allocatedBalanceOfPartyB(await hedger.getAddress(), await user.getAddress())

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
			await expect(context.accountFacet.connect(context.signers.user).deallocate(excessiveAmount, await getDummySingleUpnlSig())).to.be.revertedWith(
				"AccountFacet: Insufficient allocated Balance",
			)
		})

		it("Should fail when accounting is paused", async function () {
			await context.pauseControlFacet.pauseAccounting()
			await expect(
				context.accountFacet.connect(context.signers.user).deallocate(BALANCES.DEPOSIT_AMOUNT, await getDummySingleUpnlSig()),
			).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("Should fail on available balance is lower than zero", async function () {
			await expect(
				context.accountFacet
					.connect(context.signers.user)
					.deallocate(BALANCES.DEPOSIT_AMOUNT, await getDummySingleUpnlSig(UPNL_VALUES.NEGATIVE_LARGE)),
			).to.be.revertedWith("AccountFacet: Available balance is lower than zero")
		})

		it("Should fail on partyA becoming liquidatable", async function () {
			await expect(
				context.accountFacet
					.connect(context.signers.user)
					.deallocate(BALANCES.DEPOSIT_AMOUNT, await getDummySingleUpnlSig(UPNL_VALUES.NEGATIVE_SMALL)),
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
			await expect(context.accountFacet.connect(context.signers.user).deallocate(deallocateAmount, await getDummySingleUpnlSig())).to.be.revertedWith(
				"AccountFacet: Too many deallocate in a short window",
			)

			await time.increase((await context.viewFacet.getDeallocateDebounceTime()) + 1n)
			await context.accountFacet.connect(context.signers.user).deallocate(deallocateAmount, await getDummySingleUpnlSig())

			expect(await context.viewFacet.balanceOf(userAddress)).to.equal(BALANCES.DEALLOCATE_AMOUNT)
		})

		it("Should fail to withdraw due to cooldown", async function () {
			await context.accountFacet.connect(context.signers.user).deallocate(BALANCES.DEALLOCATE_AMOUNT, await getDummySingleUpnlSig())
			await expect(context.accountFacet.connect(context.signers.user).withdraw(BALANCES.DEALLOCATE_AMOUNT)).to.be.revertedWith(
				"AccountFacet: Cooldown hasn't reached",
			)
		})

		it("Should withdraw after cooldown", async function () {
			await context.accountFacet.connect(context.signers.user).deallocate(BALANCES.DEALLOCATE_AMOUNT, await getDummySingleUpnlSig())
			await time.increase(LIMITS.DEALLOCATE_COOLDOWN)
			await expect(context.accountFacet.connect(context.signers.user).withdraw(BALANCES.DEALLOCATE_AMOUNT)).to.not.be.reverted
		})
	})

	describe("SafeDeallocate", async function () {
		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.DEPOSIT_AMOUNT, BALANCES.DEPOSIT_AMOUNT)
		})

		it("Should fail on insufficient allocated Balance", async function () {
			const excessiveAmount = BALANCES.DEPOSIT_AMOUNT + BALANCES.ALLOCATE_AMOUNT
			await expect(
				context.accountFacet.connect(context.signers.user).safeDeallocate(excessiveAmount, await getDummySingleUpnlWithPendingBalanceSig()),
			).to.be.revertedWith("AccountFacet: Insufficient allocated Balance")
		})

		it("Should fail when accounting is paused", async function () {
			await context.pauseControlFacet.pauseAccounting()
			await expect(
				context.accountFacet.connect(context.signers.user).safeDeallocate(BALANCES.DEPOSIT_AMOUNT, await getDummySingleUpnlWithPendingBalanceSig()),
			).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("Should fail on available balance is lower than zero", async function () {
			await expect(
				context.accountFacet
					.connect(context.signers.user)
					.safeDeallocate(BALANCES.DEPOSIT_AMOUNT, await getDummySingleUpnlWithPendingBalanceSig(UPNL_VALUES.NEGATIVE_LARGE)),
			).to.be.revertedWith("AccountFacet: Available balance is lower than zero")
		})

		it("Should fail on partyA becoming liquidatable", async function () {
			await expect(
				context.accountFacet
					.connect(context.signers.user)
					.safeDeallocate(BALANCES.DEPOSIT_AMOUNT, await getDummySingleUpnlWithPendingBalanceSig(UPNL_VALUES.NEGATIVE_SMALL)),
			).to.be.revertedWith("AccountFacet: Insufficient balance considering pending allocations")
		})

		it("Should fail when pendingBalance makes partyA liquidatable", async function () {
			// With pendingBalance of 200, user can only deallocate up to (300 - 200) = 100
			// Trying to deallocate 150 should fail
			const pendingBalance = decimal(200n)
			const deallocateAmount = decimal(150n)
			await expect(
				context.accountFacet
					.connect(context.signers.user)
					.safeDeallocate(deallocateAmount, await getDummySingleUpnlWithPendingBalanceSig(UPNL_VALUES.ZERO, pendingBalance)),
			).to.be.revertedWith("AccountFacet: Insufficient balance considering pending allocations")
		})

		it("Should safeDeallocate with zero pending balance", async function () {
			const userAddress = await context.signers.user.getAddress()
			const deallocateAmount = BALANCES.DEALLOCATE_AMOUNT
			const expectedAllocated = BALANCES.DEPOSIT_AMOUNT - deallocateAmount

			await context.accountFacet.connect(context.signers.user).safeDeallocate(deallocateAmount, await getDummySingleUpnlWithPendingBalanceSig())

			expect(await context.viewFacet.balanceOf(userAddress)).to.equal(deallocateAmount)
			expect(await context.viewFacet.allocatedBalanceOfPartyA(userAddress)).to.equal(expectedAllocated)
		})

		it("Should safeDeallocate with pending balance when enough available", async function () {
			const userAddress = await context.signers.user.getAddress()
			// Allocated: 300, pendingBalance: 100, deallocate: 50
			// Available after: 300 - 100 - 50 = 150 >= 0, should succeed
			const pendingBalance = decimal(100n)
			const deallocateAmount = BALANCES.DEALLOCATE_AMOUNT
			const expectedAllocated = BALANCES.DEPOSIT_AMOUNT - deallocateAmount

			await context.accountFacet
				.connect(context.signers.user)
				.safeDeallocate(deallocateAmount, await getDummySingleUpnlWithPendingBalanceSig(UPNL_VALUES.ZERO, pendingBalance))

			expect(await context.viewFacet.balanceOf(userAddress)).to.equal(deallocateAmount)
			expect(await context.viewFacet.allocatedBalanceOfPartyA(userAddress)).to.equal(expectedAllocated)
		})

		it("Should fail to safeDeallocate too often", async function () {
			const deallocateAmount = BALANCES.SMALL_AMOUNT

			await context.accountFacet.connect(context.signers.user).safeDeallocate(deallocateAmount, await getDummySingleUpnlWithPendingBalanceSig())
			await expect(
				context.accountFacet.connect(context.signers.user).safeDeallocate(deallocateAmount, await getDummySingleUpnlWithPendingBalanceSig()),
			).to.be.revertedWith("AccountFacet: Too many deallocate in a short window")
		})
	})

	describe("Legacy Deallocate Disabling", async function () {
		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.DEPOSIT_AMOUNT, BALANCES.DEPOSIT_AMOUNT)
		})

		it("Should allow legacy deallocate when not disabled", async function () {
			expect(await context.viewFacet.isLegacyDeallocateDeprecated()).to.equal(false)
			await expect(context.accountFacet.connect(context.signers.user).deallocate(BALANCES.DEALLOCATE_AMOUNT, await getDummySingleUpnlSig())).to.not.be
				.reverted
		})

		it("Should block legacy deallocate when disabled", async function () {
			await context.controlFacet.connect(context.signers.admin).setLegacyDeallocateDeprecated(true)
			expect(await context.viewFacet.isLegacyDeallocateDeprecated()).to.equal(true)
			await expect(
				context.accountFacet.connect(context.signers.user).deallocate(BALANCES.DEALLOCATE_AMOUNT, await getDummySingleUpnlSig()),
			).to.be.revertedWith("AccountFacet: Legacy deallocate is disabled")
		})

		it("Should allow safeDeallocate when legacy is disabled", async function () {
			await context.controlFacet.connect(context.signers.admin).setLegacyDeallocateDeprecated(true)
			await expect(
				context.accountFacet
					.connect(context.signers.user)
					.safeDeallocate(BALANCES.DEALLOCATE_AMOUNT, await getDummySingleUpnlWithPendingBalanceSig()),
			).to.not.be.reverted
		})

		it("Should re-enable legacy deallocate", async function () {
			await context.controlFacet.connect(context.signers.admin).setLegacyDeallocateDeprecated(true)
			await context.controlFacet.connect(context.signers.admin).setLegacyDeallocateDeprecated(false)
			expect(await context.viewFacet.isLegacyDeallocateDeprecated()).to.equal(false)
			await expect(context.accountFacet.connect(context.signers.user).deallocate(BALANCES.DEALLOCATE_AMOUNT, await getDummySingleUpnlSig())).to.not.be
				.reverted
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
			await expect(context.accountFacet.connect(context.signers.user).zeroUpnlDeallocate(excessiveAmount)).to.be.revertedWith(
				"AccountFacet: Insufficient allocated Balance",
			)
		})

		it("Should fail when accounting is paused", async function () {
			await context.pauseControlFacet.pauseAccounting()
			await expect(context.accountFacet.connect(context.signers.user).zeroUpnlDeallocate(BALANCES.DEPOSIT_AMOUNT)).to.be.revertedWith(
				"Pausable: Accounting paused",
			)
		})

		it("Should fail when partyA has pending quote", async function () {
			await user.sendQuote()
			const deallocateAmount = decimal(250n)
			await expect(context.accountFacet.connect(context.signers.user).zeroUpnlDeallocate(deallocateAmount)).to.be.revertedWith(
				"AccountFacet: PartyA has Open/Pending position",
			)
		})

		it("Should fail when partyA has open position", async function () {
			// Setup hedger
			hedger = new Hedger(context, context.signers.hedger)
			await hedger.setup()
			await hedger.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.INITIAL_COLLATERAL)

			// Send quote and open position
			await user.sendQuote()
			await hedger.lockQuote(1n)
			await hedger.openPosition(1n)

			const deallocateAmount = decimal(50n)
			await expect(context.accountFacet.connect(context.signers.user).zeroUpnlDeallocate(deallocateAmount)).to.be.revertedWith(
				"AccountFacet: PartyA has Open/Pending position",
			)
		})

		it("Should fail when partyA has locked quote", async function () {
			// Setup hedger
			hedger = new Hedger(context, context.signers.hedger)
			await hedger.setup()
			await hedger.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.INITIAL_COLLATERAL)

			// Send quote and lock it (but don't open)
			await user.sendQuote()
			await hedger.lockQuote(1n)

			const deallocateAmount = decimal(50n)
			await expect(context.accountFacet.connect(context.signers.user).zeroUpnlDeallocate(deallocateAmount)).to.be.revertedWith(
				"AccountFacet: PartyA has Open/Pending position",
			)
		})

		it("Should succeed after all positions are closed", async function () {
			const userAddress = await context.signers.user.getAddress()

			// Setup hedger
			hedger = new Hedger(context, context.signers.hedger)
			await hedger.setup()
			await hedger.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.INITIAL_COLLATERAL)

			// Send quote, open position
			await user.sendQuote()
			await hedger.lockQuote(1n)
			await hedger.openPosition(1n)

			// User requests to close, hedger fills the close request
			await user.requestToClosePosition(1n)
			await hedger.fillCloseRequest(1n)

			// Now zeroUpnlDeallocate should succeed
			const deallocateAmount = decimal(50n)
			await expect(context.accountFacet.connect(context.signers.user).zeroUpnlDeallocate(deallocateAmount)).to.not.be.reverted

			// Verify balances updated correctly
			const balance = await context.viewFacet.balanceOf(userAddress)
			expect(balance).to.be.gt(0n)
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

		it("Should set withdrawCooldown when deallocating", async function () {
			const userAddress = await context.signers.user.getAddress()
			const deallocateAmount = BALANCES.DEALLOCATE_AMOUNT

			// Check cooldown before
			const cooldownBefore = await context.viewFacet.withdrawCooldownOf(userAddress)

			await context.accountFacet.connect(context.signers.user).zeroUpnlDeallocate(deallocateAmount)

			// Check cooldown after - should be set to current block timestamp
			const cooldownAfter = await context.viewFacet.withdrawCooldownOf(userAddress)
			expect(cooldownAfter).to.be.gt(cooldownBefore)
		})

		it("Should emit DeallocatePartyA event", async function () {
			const userAddress = await context.signers.user.getAddress()
			const deallocateAmount = BALANCES.DEALLOCATE_AMOUNT
			const expectedAllocated = BALANCES.INITIAL_COLLATERAL - deallocateAmount

			await expect(context.accountFacet.connect(context.signers.user).zeroUpnlDeallocate(deallocateAmount))
				.to.emit(context.accountFacet, "DeallocatePartyA")
				.withArgs(userAddress, deallocateAmount, expectedAllocated)
		})

		it("Should fail when global pause is active", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseGlobal()

			await expect(context.accountFacet.connect(context.signers.user).zeroUpnlDeallocate(BALANCES.DEALLOCATE_AMOUNT)).to.be.revertedWith(
				"Pausable: Global paused",
			)
		})

		it("Should allow multiple deallocations in sequence", async function () {
			const userAddress = await context.signers.user.getAddress()
			const firstDeallocate = BALANCES.DEALLOCATE_AMOUNT
			const secondDeallocate = BALANCES.DEALLOCATE_AMOUNT

			// First deallocation
			await context.accountFacet.connect(context.signers.user).zeroUpnlDeallocate(firstDeallocate)

			const balanceAfterFirst = await context.viewFacet.balanceOf(userAddress)
			const allocatedAfterFirst = await context.viewFacet.allocatedBalanceOfPartyA(userAddress)

			expect(balanceAfterFirst).to.equal(firstDeallocate)
			expect(allocatedAfterFirst).to.equal(BALANCES.INITIAL_COLLATERAL - firstDeallocate)

			// Second deallocation
			await context.accountFacet.connect(context.signers.user).zeroUpnlDeallocate(secondDeallocate)

			const balanceAfterSecond = await context.viewFacet.balanceOf(userAddress)
			const allocatedAfterSecond = await context.viewFacet.allocatedBalanceOfPartyA(userAddress)

			expect(balanceAfterSecond).to.equal(firstDeallocate + secondDeallocate)
			expect(allocatedAfterSecond).to.equal(BALANCES.INITIAL_COLLATERAL - firstDeallocate - secondDeallocate)
		})

		it("Should deallocate entire allocated balance", async function () {
			const userAddress = await context.signers.user.getAddress()

			await context.accountFacet.connect(context.signers.user).zeroUpnlDeallocate(BALANCES.INITIAL_COLLATERAL)

			expect(await context.viewFacet.balanceOf(userAddress)).to.equal(BALANCES.INITIAL_COLLATERAL)
			expect(await context.viewFacet.allocatedBalanceOfPartyA(userAddress)).to.equal(0n)
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

			await expect(
				context.accountFacet.connect(context.signers.user).internalTransfer(await user2.getAddress(), BALANCES.TRANSFER_AMOUNT),
			).to.be.revertedWith("Pausable: Internal transfer paused")
		})

		it("Should fail when accounting is paused", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseAccounting()

			await expect(
				context.accountFacet.connect(context.signers.user).internalTransfer(await user2.getAddress(), BALANCES.TRANSFER_AMOUNT),
			).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("Should fail when global pause is active", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseGlobal()

			await expect(
				context.accountFacet.connect(context.signers.user).internalTransfer(await user2.getAddress(), BALANCES.TRANSFER_AMOUNT),
			).to.be.revertedWith("Pausable: Global paused")
		})
	})

	describe("InternalTransferToBalance", async function () {
		const INTERNAL_TRANSFER_TO_BALANCE_ROLE = ethers.keccak256(toUtf8Bytes("INTERNAL_TRANSFER_TO_BALANCE_ROLE"))

		beforeEach(async () => {
			context = await loadFixture(initializeFixture)

			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.DEPOSIT_AMOUNT)

			user2 = new User(context, context.signers.user2)
			await user2.setup()
			await user2.setBalances(BALANCES.INITIAL_COLLATERAL)
		})

		it("Should fail when caller does not have INTERNAL_TRANSFER_TO_BALANCE_ROLE", async () => {
			await expect(
				context.accountFacet.connect(context.signers.user).internalTransferToBalance(await user2.getAddress(), BALANCES.TRANSFER_AMOUNT),
			).to.be.revertedWith("Accessibility: Must have role")
		})

		it("Should transfer to balance (not allocatedBalance) when caller has role", async () => {
			// Grant role to user
			await context.controlFacet.connect(context.signers.admin).grantRole(await context.signers.user.getAddress(), INTERNAL_TRANSFER_TO_BALANCE_ROLE)

			const user2Address = await user2.getAddress()
			const userAddress = await user.getAddress()

			const initialUser2Balance = await context.viewFacet.balanceOf(user2Address)
			const initialUserBalance = await context.viewFacet.balanceOf(userAddress)

			await context.accountFacet.connect(context.signers.user).internalTransferToBalance(user2Address, BALANCES.TRANSFER_AMOUNT)

			// Funds should go to balance, NOT allocatedBalance
			expect(await context.viewFacet.balanceOf(user2Address)).to.equal(initialUser2Balance + BALANCES.TRANSFER_AMOUNT)
			expect(await context.viewFacet.allocatedBalanceOfPartyA(user2Address)).to.equal(0n)

			// Sender's balance should decrease
			expect(await context.viewFacet.balanceOf(userAddress)).to.equal(initialUserBalance - BALANCES.TRANSFER_AMOUNT)
		})

		it("Should set withdrawCooldown on recipient", async () => {
			// Grant role to user
			await context.controlFacet.connect(context.signers.admin).grantRole(await context.signers.user.getAddress(), INTERNAL_TRANSFER_TO_BALANCE_ROLE)

			const user2Address = await user2.getAddress()

			await context.accountFacet.connect(context.signers.user).internalTransferToBalance(user2Address, BALANCES.TRANSFER_AMOUNT)

			// Check that withdrawCooldown was set (recipient can't withdraw immediately with old withdraw)
			const cooldown = await context.viewFacet.withdrawCooldownOf(user2Address)
			expect(cooldown).to.be.gt(0n)
		})

		it("Should emit InternalTransferToBalance event", async () => {
			// Grant role to user
			await context.controlFacet.connect(context.signers.admin).grantRole(await context.signers.user.getAddress(), INTERNAL_TRANSFER_TO_BALANCE_ROLE)

			const user2Address = await user2.getAddress()
			const userAddress = await user.getAddress()
			const expectedNewBalance = BALANCES.TRANSFER_AMOUNT // user2 starts with 0 balance

			await expect(context.accountFacet.connect(context.signers.user).internalTransferToBalance(user2Address, BALANCES.TRANSFER_AMOUNT))
				.to.emit(context.accountFacet, "InternalTransferToBalance")
				.withArgs(userAddress, user2Address, expectedNewBalance, BALANCES.TRANSFER_AMOUNT)
		})

		it("Should fail when sender has insufficient balance", async () => {
			// Grant role to user
			await context.controlFacet.connect(context.signers.admin).grantRole(await context.signers.user.getAddress(), INTERNAL_TRANSFER_TO_BALANCE_ROLE)

			const user2Address = await user2.getAddress()

			await expect(
				context.accountFacet.connect(context.signers.user).internalTransferToBalance(user2Address, BALANCES.LARGE_AMOUNT),
			).to.be.revertedWith("AccountFacet: Insufficient balance")
		})

		it("Should fail when internal transfers are paused", async () => {
			// Grant role to user
			await context.controlFacet.connect(context.signers.admin).grantRole(await context.signers.user.getAddress(), INTERNAL_TRANSFER_TO_BALANCE_ROLE)

			await context.pauseControlFacet.connect(context.signers.admin).pauseInternalTransfer()

			await expect(
				context.accountFacet.connect(context.signers.user).internalTransferToBalance(await user2.getAddress(), BALANCES.TRANSFER_AMOUNT),
			).to.be.revertedWith("Pausable: Internal transfer paused")
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
				"contracts/core/test/MockExternalTransferTarget.sol:ExternalTransferRelayer",
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
			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress),
			).to.not.be.reverted
		})

		it("Should fail when sender is suspended", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)

			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress),
			).to.be.revertedWith("Accessibility: Sender is Suspended")
		})

		it("Should correctly update sender balance", async function () {
			const initialBalance = await context.viewFacet.balanceOf(context.signers.user.address)
			const expectedBalance = initialBalance - BALANCES.TRANSFER_AMOUNT

			await context.externalTransferFacet
				.connect(context.signers.user)
				.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress)

			const finalBalance = await context.viewFacet.balanceOf(context.signers.user.address)
			expect(finalBalance).to.equal(expectedBalance)
		})

		it("Should fail with insufficient balance", async function () {
			const userBalance = await context.viewFacet.balanceOf(context.signers.user.address)
			const excessiveAmount = userBalance + BALANCES.TRANSFER_AMOUNT

			await expect(
				context.externalTransferFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, excessiveAmount, targetAddress),
			).to.be.reverted
		})

		it("Should transfer collateral to relayer", async function () {
			const initialRelayerBalance = await context.collateral.balanceOf(targetAddress)
			const expectedBalance = initialRelayerBalance + BALANCES.TRANSFER_AMOUNT

			await context.externalTransferFacet
				.connect(context.signers.user)
				.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress)

			const finalRelayerBalance = await context.collateral.balanceOf(targetAddress)
			expect(finalRelayerBalance).to.equal(expectedBalance)
		})

		it("Should call onTransfer on relayer with correct parameters", async function () {
			const receiverAddress = context.signers.user2.address
			const senderAddress = context.signers.user.address

			await context.externalTransferFacet.connect(context.signers.user).externalTransfer(receiverAddress, BALANCES.TRANSFER_AMOUNT, targetAddress)

			const lastTransfer = await mockTarget.lastTransfer()
			expect(lastTransfer.collateral).to.equal(await context.collateral.getAddress())
			expect(lastTransfer.sender).to.equal(senderAddress)
			expect(lastTransfer.receiver).to.equal(receiverAddress)
			expect(lastTransfer.amount).to.equal(BALANCES.TRANSFER_AMOUNT)
			expect(lastTransfer.target).to.equal(targetAddress)
		})

		it("Should fail with zero amount transfers", async function () {
			await expect(
				context.externalTransferFacet.connect(context.signers.user).externalTransfer(context.signers.user2.address, 0, targetAddress),
			).to.be.revertedWith("AccountFacet: Amount is zero")
		})

		it("Should fail with zero receiver address", async function () {
			await expect(
				context.externalTransferFacet.connect(context.signers.user).externalTransfer(ZeroAddress, BALANCES.TRANSFER_AMOUNT, targetAddress),
			).to.be.revertedWith("AccountFacet: Zero receiver or target")
		})

		it("Should fail with zero target address", async function () {
			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, ZeroAddress),
			).to.be.revertedWith("AccountFacet: Zero receiver or target")
		})

		it("Should handle self-transfers", async function () {
			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user.address, BALANCES.TRANSFER_AMOUNT, targetAddress),
			).to.not.be.reverted
		})

		it("Should fail when target is not whitelisted", async function () {
			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress2),
			).to.be.revertedWith("AccountFacet: Target not whitelisted")
		})

		it("Should fail when relayer is removed", async function () {
			await context.controlFacet.connect(context.signers.admin).removeRelayerForExternalTransferTarget(targetAddress)

			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress),
			).to.be.revertedWith("AccountFacet: Target not whitelisted")
		})

		it("Should handle relayer revert scenarios", async function () {
			const revertMessage = "Relayer error"
			await mockTarget.setShouldRevert(true, revertMessage)

			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress),
			).to.be.revertedWith("Relayer error")
		})

		it("Should fail when external transfers are paused", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseExternalTransfer()

			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress),
			).to.be.revertedWith("Pausable: External transfer paused")
		})

		it("Should fail when accounting is paused", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseAccounting()

			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress),
			).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("Should fail when global pause is active", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseGlobal()

			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.externalTransfer(context.signers.user2.address, BALANCES.TRANSFER_AMOUNT, targetAddress),
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
			await sourceContext.externalTransferFacet
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
			await sourceContext.externalTransferFacet
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

			const MockVirtualProvider = await ethers.getContractFactory("contracts/core/test/MockVirtualProvider.sol:VirtualProvider")
			mockProvider = await MockVirtualProvider.deploy(context.diamond)
			await mockProvider.waitForDeployment()
			providerAddress = await mockProvider.getAddress()

			mockProvider2 = await MockVirtualProvider.deploy(context.diamond)
			await mockProvider2.waitForDeployment()
			providerAddress2 = await mockProvider2.getAddress()

			await context.controlFacet.connect(context.signers.admin).registerVirtualProvider(providerAddress)
			await mockProvider.connect(context.signers.admin).virtualDepositFor(context.diamond, context.signers.user.address, depositAmount)
		})

		it("Should virtual external transfer correctly", async function () {
			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.virtualExternalTransfer(context.signers.user2.address, transferAmount, context.diamond, providerAddress),
			).to.not.be.reverted
			const externalTransfer = await context.viewFacet.getVirtualExternalTransfer(1)
			expect(externalTransfer.status).to.equal(ExternalTransferStatus.PENDING)
		})

		it("Should accept virtual external transfer correctly", async function () {
			await context.externalTransferFacet
				.connect(context.signers.user)
				.virtualExternalTransfer(context.signers.user2.address, transferAmount, context.diamond, providerAddress)
			await expect(mockProvider.acceptVirtualExternalTransfer(1)).not.reverted
			const externalTransfer = await context.viewFacet.getVirtualExternalTransfer(1)
			expect(externalTransfer.status).to.equal(ExternalTransferStatus.COMPLETED)
		})

		it("Should cancel virtual external transfer correctly", async function () {
			const beforeBalance = await context.viewFacet.balanceOf(user.address)
			await context.externalTransferFacet
				.connect(context.signers.user)
				.virtualExternalTransfer(context.signers.user2.address, transferAmount, context.diamond, providerAddress)
			await expect(context.externalTransferFacet.connect(context.signers.user).cancelVirtualExternalTransfer(1)).not.reverted
			const externalTransfer = await context.viewFacet.getVirtualExternalTransfer(1)
			expect(externalTransfer.status).to.equal(ExternalTransferStatus.CANCELED)
			const afterBalance = await context.viewFacet.balanceOf(user.address)
			expect(beforeBalance).to.equal(afterBalance)
		})

		it("Should change balance in cancel virtual external transfer correctly", async function () {
			const beforeBalance = await context.viewFacet.balanceOf(user.address)
			await context.externalTransferFacet
				.connect(context.signers.user)
				.virtualExternalTransfer(context.signers.user2.address, transferAmount, context.diamond, providerAddress)
			await expect(context.externalTransferFacet.connect(context.signers.user).cancelVirtualExternalTransfer(1)).not.reverted
			const afterBalance = await context.viewFacet.balanceOf(user.address)
			expect(afterBalance).to.equal(beforeBalance)
		})

		it("Should correctly update sender balance", async function () {
			const initialBalance = await context.viewFacet.balanceOf(context.signers.user.address)

			await context.externalTransferFacet
				.connect(context.signers.user)
				.virtualExternalTransfer(context.signers.user2.address, transferAmount, context.diamond, providerAddress)

			const finalBalance = await context.viewFacet.balanceOf(context.signers.user.address)
			expect(finalBalance).to.equal(initialBalance - BigInt(transferAmount))
		})

		it("Should fail when sender is suspended", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)
			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.virtualExternalTransfer(context.signers.user2.address, transferAmount, context.diamond, providerAddress),
			).to.be.revertedWith("Accessibility: Sender is Suspended")
		})

		it("Should fail with insufficient balance", async function () {
			const userBalance = await context.viewFacet.balanceOf(context.signers.user.address)
			const excessiveAmount = userBalance + BigInt(transferAmount)

			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.virtualExternalTransfer(context.signers.user2.address, excessiveAmount, context.diamond, providerAddress),
			).to.be.revertedWith("AccountFacet: Insufficient balance")
		})

		it("Should fail with zero amount transfers", async function () {
			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.virtualExternalTransfer(context.signers.user2.address, 0, context.diamond, providerAddress),
			).to.be.revertedWith("AccountFacet: Amount is zero")
		})

		it("Should fail with zero receiver address", async function () {
			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.virtualExternalTransfer(ethers.ZeroAddress, transferAmount, context.diamond, providerAddress),
			).to.be.revertedWith("AccountFacet: Zero Receiver or Zero Target")
		})

		it("Should fail with zero target address", async function () {
			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.virtualExternalTransfer(context.signers.user2.address, transferAmount, ethers.ZeroAddress, providerAddress),
			).to.be.revertedWith("AccountFacet: Zero Receiver or Zero Target")
		})

		it("Should fail to accept virtual external transfer with invalid status", async function () {
			await context.externalTransferFacet
				.connect(context.signers.user)
				.virtualExternalTransfer(context.signers.user2.address, transferAmount, context.diamond, providerAddress)
			await mockProvider.acceptVirtualExternalTransfer(1)
			await expect(mockProvider.acceptVirtualExternalTransfer(1)).to.revertedWith("AccountFacet: External transfer already processed")

			await context.externalTransferFacet
				.connect(context.signers.user)
				.virtualExternalTransfer(context.signers.user2.address, transferAmount, context.diamond, providerAddress)
			await context.externalTransferFacet.connect(context.signers.user).cancelVirtualExternalTransfer(2)
			await expect(mockProvider.acceptVirtualExternalTransfer(2)).to.revertedWith("AccountFacet: External transfer already processed")
		})

		it("Should fail to accept virtual external transfer with invalid status", async function () {
			await context.externalTransferFacet
				.connect(context.signers.user)
				.virtualExternalTransfer(context.signers.user2.address, transferAmount, context.diamond, providerAddress)
			await context.controlFacet.connect(context.signers.admin).registerVirtualProvider(providerAddress2)
			await context.externalTransferFacet
				.connect(context.signers.user)
				.virtualExternalTransfer(context.signers.user2.address, transferAmount, context.diamond, providerAddress2)
			await expect(mockProvider2.acceptVirtualExternalTransfer(1)).to.revertedWith("AccountFacet: Only provider can accept the transfer")
		})

		it("Should fail to cancel virtual external transfer with invalid status", async function () {
			await context.externalTransferFacet
				.connect(context.signers.user)
				.virtualExternalTransfer(context.signers.user2.address, transferAmount, context.diamond, providerAddress)
			await mockProvider.acceptVirtualExternalTransfer(1)
			await expect(context.externalTransferFacet.connect(context.signers.user).cancelVirtualExternalTransfer(1)).to.revertedWith(
				"AccountFacet: External transfer already processed",
			)

			await context.externalTransferFacet
				.connect(context.signers.user)
				.virtualExternalTransfer(context.signers.user2.address, transferAmount, context.diamond, providerAddress)
			await context.externalTransferFacet.connect(context.signers.user).cancelVirtualExternalTransfer(2)
			await expect(context.externalTransferFacet.connect(context.signers.user).cancelVirtualExternalTransfer(1)).to.revertedWith(
				"AccountFacet: External transfer already processed",
			)
		})
		it("Should fail to cancel virtual external transfer with invalid sender", async function () {
			await context.externalTransferFacet
				.connect(context.signers.user)
				.virtualExternalTransfer(context.signers.user2.address, transferAmount, context.diamond, providerAddress)
			await expect(context.externalTransferFacet.connect(context.signers.admin).cancelVirtualExternalTransfer(1)).to.revertedWith(
				"AccountFacet: Invalid Sender",
			)
		})

		it("Should fail with zero provider address", async function () {
			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.virtualExternalTransfer(context.signers.user2.address, transferAmount, context.diamond, ethers.ZeroAddress),
			).to.be.revertedWith("AccountFacet: Invalid virtual provider")
		})

		it("Should handle self-transfers", async function () {
			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.virtualExternalTransfer(context.signers.user.address, transferAmount, context.diamond, providerAddress),
			).to.not.be.reverted
		})

		it("Should fail when provider is not registered", async function () {
			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.virtualExternalTransfer(context.signers.user2.address, transferAmount, context.diamond, providerAddress2),
			).to.be.revertedWith("AccountFacet: Invalid virtual provider")
		})

		it("Should fail when external transfers are paused", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseExternalTransfer()

			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.virtualExternalTransfer(context.signers.user2.address, transferAmount, context.diamond, providerAddress),
			).to.be.revertedWith("Pausable: External transfer paused")
		})

		it("Should fail when accounting is paused", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseAccounting()

			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.virtualExternalTransfer(context.signers.user2.address, transferAmount, context.diamond, providerAddress),
			).to.be.revertedWith("Pausable: Accounting paused")
		})

		it("Should fail when global pause is active", async function () {
			await context.pauseControlFacet.connect(context.signers.admin).pauseGlobal()

			await expect(
				context.externalTransferFacet
					.connect(context.signers.user)
					.virtualExternalTransfer(context.signers.user2.address, transferAmount, context.diamond, providerAddress),
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
			await virtualProvider
				.connect(sourceContext.signers.admin)
				.virtualDepositFor(sourceContext.diamond, sourceContext.signers.user.address, virtualDepositAmount)

			// first external transfer
			await sourceContext.externalTransferFacet
				.connect(sourceContext.signers.user)
				.virtualExternalTransfer(receiver, firstExternalTransferAmount, targetContext.diamond, await virtualProvider.getAddress())
			await virtualProvider.connect(sourceContext.signers.admin).acceptVirtualExternalTransfer(1)
			// check balances
			const expectedSourceBalanceAfterFirstTransfer = BigInt(virtualDepositAmount) - BigInt(firstExternalTransferAmount)
			expect(await sourceContext.viewFacet.balanceOf(sourceContext.signers.user.address)).to.equal(expectedSourceBalanceAfterFirstTransfer.toString())
			expect(await targetContext.viewFacet.balanceOf(receiver)).to.equal(firstExternalTransferAmount)

			// second external transfer
			await sourceContext.externalTransferFacet
				.connect(sourceContext.signers.user)
				.virtualExternalTransfer(receiver, secondExternalTransferAmount, targetContext.diamond, await virtualProvider.getAddress())
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
			this.user_allocated = decimal(500n)
			this.hedger_allocated = decimal(4000n)

			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(decimal(2000n), decimal(1000n), this.user_allocated)

			hedger = new Hedger(context, context.signers.hedger)
			await hedger.setup()
			await hedger.setBalances(this.hedger_allocated, this.hedger_allocated)

			hedger2 = new Hedger(context, context.signers.hedger2)
			await hedger2.setup()
			await hedger2.setBalances(this.hedger_allocated, this.hedger_allocated)

			await user.sendQuote()
			await user.sendQuote(limitQuoteRequestBuilder().positionType(PositionType.SHORT).build())

			// BINDABLE_SETTER_ROLE was merged into PARTY_B_MANAGER_ROLE - no separate grant needed
			await context.controlFacet.connect(context.signers.admin).setPartyBBindable(hedger.address, true)
		})

		it("Should fail when user suspended", async () => {
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)
			await expect(context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)).to.be.revertedWith(
				"Accessibility: Sender is Suspended",
			)
		})

		it("Should fail when user is not partyA", async () => {
			await expect(context.bindingFacet.connect(context.signers.hedger).bindToPartyB(context.signers.hedger.address)).to.be.revertedWith(
				"Accessibility: Shouldn't be partyB",
			)
		})

		it("should failed when partyB be zero address", async () => {
			await expect(context.bindingFacet.connect(context.signers.user).bindToPartyB(ZeroAddress)).to.be.revertedWith("AccountFacet: Zero address")
		})

		it("Should fail when bound", async () => {
			// First clear pending quotes
			await time.increase(1000)
			await context.partyAFacet.connect(context.signers.user).expireQuote([1, 2])

			await context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			await expect(context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)).to.be.revertedWith(
				"AccountFacet: Invalid state",
			)
		})

		it("Should fail to bind when have pending quotes", async function () {
			// Quote 1 and 2 are pending (sent in beforeEach)
			await expect(context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)).to.revertedWith(
				"AccountFacet: Have pending quotes",
			)
		})

		it("Should fail to bind when have locked quote even with the same hedger", async function () {
			// Lock quote 1 first (while still valid)
			await hedger.lockQuote(1)

			// Expire quote 2
			await time.increase(1000)
			await context.partyAFacet.connect(context.signers.user).expireQuote([2])

			// Even though the locked quote is with the same hedger, binding should fail
			await expect(context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)).to.revertedWith(
				"AccountFacet: Have pending quotes",
			)
		})

		it("Should fail to bind to hedger when have open position quote with another hedger", async function () {
			await hedger.lockQuote(1)
			await hedger2.lockQuote(2)
			await hedger.openPosition(1)
			await hedger2.openPosition(2)
			await expect(context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)).to.revertedWith(
				"AccountFacet : Have Open Positions with Other Party B",
			)
		})

		it("Should fail to bind to a non-bindable party B", async () => {
			// First clear pending quotes
			await time.increase(1000)
			await context.partyAFacet.connect(context.signers.user).expireQuote([1, 2])

			await context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address, false)
			await expect(context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)).to.be.revertedWith(
				"AccountFacet: Not Bindable",
			)
		})

		it("Should allow binding after all pending quotes are fully opened", async () => {
			// Open both pending quotes fully
			await hedger.lockQuote(1)
			await hedger.openPosition(1)
			await hedger.lockQuote(2)
			await hedger.openPosition(2)

			// User should be able to bind (no more pending quotes)
			await expect(context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)).to.not.be.reverted
		})

		it("Should allow binding after all pending quotes expire", async () => {
			// expire both quotes
			await time.increase(1000)
			await context.partyAFacet.connect(context.signers.user).expireQuote([1, 2])

			// User should be able to bind
			await expect(context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)).to.not.be.reverted
		})

		it("Should allow binding after locked quotes are cancelled", async () => {
			// Lock quote 1
			await hedger.lockQuote(1)

			// PartyA requests cancel
			await user.requestToCancelQuote(1)

			// PartyB accepts cancel
			await hedger.acceptCancelRequest(1)

			// Expire quote 2
			await time.increase(1000)
			await context.partyAFacet.connect(context.signers.user).expireQuote([2])

			// User should be able to bind
			await expect(context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)).to.not.be.reverted
		})

		it("Should bind successfully", async () => {
			const BIND_STATUS = {
				UNBOUND: 0,
				BOUND: 1,
				REQUESTED_TO_UNBIND: 2,
			}

			// First clear pending quotes
			await time.increase(1000)
			await context.partyAFacet.connect(context.signers.user).expireQuote([1, 2])

			await expect(context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)).to.not.be.reverted

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

			// BINDABLE_SETTER_ROLE was merged into PARTY_B_MANAGER_ROLE - no separate grant needed
			await context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address, true)
		})

		it("Should fail when user suspended", async () => {
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)
			await expect(context.bindingFacet.connect(context.signers.user).requestToUnbindFromPartyB()).to.be.revertedWith(
				"Accessibility: Sender is Suspended",
			)
		})

		it("Should fail when not bound", async () => {
			await expect(context.bindingFacet.connect(context.signers.user).requestToUnbindFromPartyB()).to.be.revertedWith("AccountFacet: Invalid state")
		})

		it("Should fail when request to unbound before", async () => {
			await context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			await context.bindingFacet.connect(context.signers.user).requestToUnbindFromPartyB()
			await expect(context.bindingFacet.connect(context.signers.user).requestToUnbindFromPartyB()).to.be.revertedWith("AccountFacet: Invalid state")
		})

		it("Should request unbind successfully", async () => {
			await context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)

			await expect(context.bindingFacet.connect(context.signers.user).requestToUnbindFromPartyB()).to.not.be.reverted

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

			// BINDABLE_SETTER_ROLE was merged into PARTY_B_MANAGER_ROLE - no separate grant needed
			await context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address, true)
		})

		it("Should fail when user suspended", async () => {
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(context.signers.user.address)
			await expect(context.bindingFacet.connect(context.signers.user).cancelUnbindRequest()).to.be.revertedWith("Accessibility: Sender is Suspended")
		})

		it("Should fail when not request to unbound", async () => {
			await expect(context.bindingFacet.connect(context.signers.user).cancelUnbindRequest()).to.be.revertedWith("AccountFacet: Invalid state")
		})

		it("Should cancel request unbind successfully", async () => {
			await context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			await context.bindingFacet.connect(context.signers.user).requestToUnbindFromPartyB()

			await expect(context.bindingFacet.connect(context.signers.user).cancelUnbindRequest()).to.not.be.reverted

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
			// BINDABLE_SETTER_ROLE was merged into PARTY_B_MANAGER_ROLE - no separate grant needed
			await context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address, true)

			await context.bindingFacet.connect(context.signers.user).bindToPartyB(context.signers.hedger.address)
			await context.controlFacet.connect(context.signers.admin).setUnbindCooldown(LIMITS.UNBIND_COOLDOWN)
		})

		it("Should fail when user suspended", async () => {
			await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(context.signers.hedger.address)
			await expect(context.bindingFacet.connect(context.signers.hedger).completeUnbindRequest(context.signers.user.address)).to.be.revertedWith(
				"Accessibility: Sender is Suspended",
			)
		})

		it("Should fail when not request to unbound", async () => {
			await expect(context.bindingFacet.connect(context.signers.hedger).completeUnbindRequest(context.signers.user.address)).to.be.revertedWith(
				"AccountFacet: Invalid state",
			)
		})

		it("Should fail when the bind state partyB not same as caller", async () => {
			await context.bindingFacet.connect(context.signers.user).requestToUnbindFromPartyB()
			await expect(context.bindingFacet.connect(context.signers.hedger2).completeUnbindRequest(context.signers.user.address)).to.be.revertedWith(
				"AccountFacet: Cooldown not reached",
			)
		})

		it("Should complete unbind successfully by partyB", async () => {
			await context.bindingFacet.connect(context.signers.user).requestToUnbindFromPartyB()

			await expect(context.bindingFacet.connect(context.signers.hedger).completeUnbindRequest(context.signers.user.address)).to.not.be.reverted

			const bindState = await context.viewFacet.getBindState(context.signers.user.address)
			expect(bindState.status).to.equal(BIND_STATUS.UNBOUND)
			expect(bindState.partyB).to.equal(ZeroAddress)
		})

		it("Should complete unbind successfully after cooldown", async () => {
			await context.bindingFacet.connect(context.signers.user).requestToUnbindFromPartyB()

			const unbindCooldown = await context.viewFacet.unbindCooldown()
			await time.increase(unbindCooldown + 1n)

			await expect(context.bindingFacet.connect(context.signers.user2).completeUnbindRequest(context.signers.user.address)).to.not.be.reverted

			const bindState = await context.viewFacet.getBindState(context.signers.user.address)
			expect(bindState.status).to.equal(BIND_STATUS.UNBOUND)
			expect(bindState.partyB).to.equal(ZeroAddress)
		})
	})

	describe("Cross partyB activation gating", () => {
		beforeEach(async () => {
			context = await loadFixture(initializeFixture)
		})
		it("should revert when cross partyB activation is disabled", async () => {
			await expect(context.partyBAccountFacet.connect(context.signers.hedger).activateCrossPartyB()).to.be.revertedWith(
				"AccountFacet: Cross disabled",
			)
		})

		it("should allow cross partyB activation after enabled by admin", async () => {
			await context.controlFacet.connect(context.signers.admin).setCrossPartyBModeActivated(true)
			await migratePartyBToCross(context, hedger, [])
			expect(await context.viewFacet.isCrossPartyB(context.signers.hedger.address)).to.equal(true)
		})
	})
}
