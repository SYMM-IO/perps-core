import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { expect } from "chai"

import { initializeFixture } from "./Initialize.fixture.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { BridgeTransactionStatus } from "./models/Enums.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { TransferToBridgeValidator } from "./models/validators/TransferToBridgeValidator.js"
import { WithdrawLockedTransactionValidator } from "./models/validators/WithdrawLockedTransactionValidator.js"
import { decimal, pauseAccounting, suspendAddress } from "./utils/Common.js"

export function shouldBehaveLikeBridgeFacet(): void {
	let context: RunContext, user: User, user2: User
	let bridge: HardhatEthersSigner, bridge2: HardhatEthersSigner

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		bridge = context.signers.bridge // regular bridge
		bridge2 = context.signers.bridge2 // additional regular bridge
		user = new User(context, context.signers.user)
		user2 = new User(context, context.signers.user2)

		await user.setup()
		await user.setBalances(decimal(5000n), decimal(5000n), decimal(1000n))
		await user2.setup()
		await user2.setBalances(decimal(3000n), decimal(3000n), decimal(500n))

		// Setup bridges
		await context.controlFacet.addBridge(await bridge.getAddress())
		await context.controlFacet.addBridge(await bridge2.getAddress())
	})

	describe("transferToBridge", async function () {
		it("Should fail when bridge is not registered", async function () {
			const unregisteredBridge = context.signers.user2
			await expect(
				context.bridgeFacet.connect(context.signers.user).transferToBridge(decimal(100n), await unregisteredBridge.getAddress()),
			).to.be.revertedWith("BridgeFacet: Invalid bridge")
		})

		it("Should fail when amount exceeds user balance", async function () {
			await expect(context.bridgeFacet.connect(context.signers.user).transferToBridge(decimal(7000n), await bridge.getAddress())).to.be.revertedWith(
				"BridgeFacet: Insufficient balance",
			)
		})

		it("Should fail when bridge and user are the same address", async function () {
			await expect(context.bridgeFacet.connect(context.signers.bridge).transferToBridge(decimal(100n), await bridge.getAddress())).to.be.revertedWith(
				"BridgeFacet: Bridge and user can't be the same",
			)
		})

		it("Should fail when accounting is paused", async function () {
			await pauseAccounting(context)
			await expect(context.bridgeFacet.connect(context.signers.user).transferToBridge(decimal(100n), await bridge.getAddress())).to.be.revertedWith(
				"Pausable: Accounting paused",
			)
		})

		it("Should fail when user is suspended", async function () {
			await suspendAddress(context, await context.signers.user.getAddress())
			await expect(context.bridgeFacet.connect(context.signers.user).transferToBridge(decimal(100n), await bridge.getAddress())).to.be.revertedWith(
				"Accessibility: Sender is Suspended",
			)
		})

		it("Should transfer to bridge successfully", async function () {
			const id = await context.viewFacet.getNextBridgeTransactionId()

			const validator = new TransferToBridgeValidator()
			const beforeOut = await validator.before(context, {
				user: user,
				transactionId: id + 1n,
				bridge: await bridge.getAddress(),
			})

			await expect(context.bridgeFacet.connect(context.signers.user).transferToBridge(decimal(100n), await bridge.getAddress()))
				.to.emit(context.bridgeFacet, "TransferToBridge")
				.withArgs(user.address, decimal(100n), await bridge.getAddress(), id + 1n)

			await validator.after(context, {
				user: user,
				amount: decimal(100n),
				transactionId: id + 1n,
				beforeOutput: beforeOut,
			})
		})

		it("Should handle multiple transfers correctly", async function () {
			const amount1 = decimal(100n)
			const amount2 = decimal(200n)

			await context.bridgeFacet.connect(context.signers.user).transferToBridge(amount1, await bridge.getAddress())
			await context.bridgeFacet.connect(context.signers.user).transferToBridge(amount2, await bridge2.getAddress())

			const transaction1 = await context.viewFacet.getBridgeTransaction(1)
			const transaction2 = await context.viewFacet.getBridgeTransaction(2)

			expect(transaction1.amount).to.equal(amount1)
			expect(transaction1.bridge).to.equal(await bridge.getAddress())
			expect(transaction2.amount).to.equal(amount2)
			expect(transaction2.bridge).to.equal(await bridge2.getAddress())
		})
	})

	describe("suspendBridgeTransaction", async function () {
		beforeEach(async function () {
			// Create test transactions
			await context.bridgeFacet.connect(context.signers.user).transferToBridge(decimal(100n), await bridge.getAddress())
			await context.bridgeFacet.connect(context.signers.user).transferToBridge(decimal(200n), await bridge2.getAddress())
		})

		it("Should fail with invalid transaction ID", async function () {
			await expect(context.bridgeFacet.connect(context.signers.admin).suspendBridgeTransaction(999)).to.be.revertedWith(
				"BridgeFacet: Invalid transactionId",
			)
		})

		it("Should fail when transaction is already withdrawn", async function () {
			await time.increase(43250) // 12h cooldown
			await context.bridgeFacet.connect(context.signers.bridge).withdrawReceivedBridgeValue(1)

			await expect(context.bridgeFacet.connect(context.signers.admin).suspendBridgeTransaction(1)).to.be.revertedWith("BridgeFacet: Invalid status")
		})

		it("Should fail when caller lacks SUSPENDER_ROLE", async function () {
			await expect(context.bridgeFacet.connect(context.signers.user).suspendBridgeTransaction(1)).to.be.revertedWith("Accessibility: Must have role")
		})

		it("Should suspend transaction successfully", async function () {
			const userBalanceBefore = await context.viewFacet.balanceOf(user.address)

			await expect(context.bridgeFacet.connect(context.signers.admin).suspendBridgeTransaction(1))
				.to.emit(context.bridgeFacet, "SuspendBridgeTransaction")
				.withArgs(1)

			const transaction = await context.viewFacet.getBridgeTransaction(1)
			expect(transaction.status).to.equal(BridgeTransactionStatus.SUSPENDED)

			// User balance should not change during suspend
			const userBalanceAfter = await context.viewFacet.balanceOf(user.address)
			expect(userBalanceAfter).to.equal(userBalanceBefore)
		})
	})

	describe("restoreBridgeTransaction", async function () {
		beforeEach(async function () {
			// Create and suspend a transaction
			await context.bridgeFacet.connect(context.signers.user).transferToBridge(decimal(100n), await bridge.getAddress())
			await context.bridgeFacet.connect(context.signers.admin).suspendBridgeTransaction(1)
		})

		it("Should fail with invalid transaction ID", async function () {
			await expect(context.bridgeFacet.connect(context.signers.admin).restoreBridgeTransaction(999, decimal(50n))).to.be.revertedWith(
				"BridgeFacet: Invalid status",
			)
		})

		it("Should fail when transaction is not suspended", async function () {
			await context.bridgeFacet.connect(context.signers.user).transferToBridge(decimal(100n), await bridge.getAddress())

			await expect(context.bridgeFacet.connect(context.signers.admin).restoreBridgeTransaction(2, decimal(50n))).to.be.revertedWith(
				"BridgeFacet: Invalid status",
			)
		})

		it("Should fail when valid amount exceeds original amount", async function () {
			const transaction = await context.viewFacet.getBridgeTransaction(1)

			await expect(context.bridgeFacet.connect(context.signers.admin).restoreBridgeTransaction(1, transaction.amount + 1n)).to.be.revertedWith(
				"BridgeFacet: High valid amount",
			)
		})

		it("Should fail when caller lacks DISPUTE_ROLE", async function () {
			await expect(context.bridgeFacet.connect(context.signers.user).restoreBridgeTransaction(1, decimal(50n))).to.be.revertedWith(
				"Accessibility: Must have role",
			)
		})

		it("Should restore transaction successfully", async function () {
			const originalTransaction = await context.viewFacet.getBridgeTransaction(1)
			const validAmount = originalTransaction.amount / 2n
			const invalidAmount = originalTransaction.amount - validAmount
			const withdrawLockedBalanceBefore = await context.viewFacet.getWithdrawLockedBalance()

			// invalidBridgedAmountsPool is set to feeCollector in the fixture
			const poolBalanceBefore = await context.viewFacet.balanceOf(context.signers.feeCollector.address)

			await expect(context.bridgeFacet.connect(context.signers.admin).restoreBridgeTransaction(1, validAmount)).to.not.reverted

			const restoredTransaction = await context.viewFacet.getBridgeTransaction(1)
			expect(restoredTransaction.status).to.equal(BridgeTransactionStatus.RECEIVED)
			expect(restoredTransaction.amount).to.equal(validAmount)

			// Verify the invalid portion was credited to the pool
			// BridgeTransaction.amount is in collateral decimals (18 for FakeStablecoin), same as balanceOf
			const poolBalanceAfter = await context.viewFacet.balanceOf(context.signers.feeCollector.address)
			expect(poolBalanceAfter - poolBalanceBefore).to.equal(invalidAmount)

			const withdrawLockedBalanceAfter = await context.viewFacet.getWithdrawLockedBalance()
			expect(withdrawLockedBalanceAfter).to.equal(withdrawLockedBalanceBefore - invalidAmount)
		})
	})

	describe("withdrawReceivedBridgeValue", async function () {
		beforeEach(async function () {
			// Create test transactions
			await context.bridgeFacet.connect(context.signers.user).transferToBridge(decimal(100n), await bridge.getAddress())
			await context.bridgeFacet.connect(context.signers.user).transferToBridge(decimal(200n), await bridge2.getAddress())
		})

		it("Should fail with invalid transaction ID", async function () {
			await time.increase(43250) // 12h cooldown
			await expect(context.bridgeFacet.connect(context.signers.bridge).withdrawReceivedBridgeValue(999)).to.be.revertedWith(
				"BridgeFacet: Invalid transactionId",
			)
		})

		it("Should fail when sender is not the transaction's bridge", async function () {
			await time.increase(43250) // 12h cooldown
			await expect(context.bridgeFacet.connect(context.signers.bridge2).withdrawReceivedBridgeValue(1)).to.be.revertedWith(
				"BridgeFacet: Sender is not the transaction's bridge",
			)
		})

		it("Should fail when cooldown period hasn't elapsed", async function () {
			await expect(context.bridgeFacet.connect(context.signers.bridge).withdrawReceivedBridgeValue(1)).to.be.revertedWith(
				"BridgeFacet: Cooldown hasn't reached",
			)
		})

		it("Should fail when transaction is already withdrawn", async function () {
			await time.increase(43250) // 12h cooldown
			await context.bridgeFacet.connect(context.signers.bridge).withdrawReceivedBridgeValue(1)

			await expect(context.bridgeFacet.connect(context.signers.bridge).withdrawReceivedBridgeValue(1)).to.be.revertedWith(
				"BridgeFacet: Already withdrawn",
			)
		})

		it("Should fail when accounting is paused", async function () {
			await time.increase(43250) // 12h cooldown
			await pauseAccounting(context)

			await expect(context.bridgeFacet.connect(context.signers.bridge).withdrawReceivedBridgeValue(1)).to.be.revertedWith(
				"Pausable: Accounting paused",
			)
		})

		it("Should fail when bridge is suspended", async function () {
			await time.increase(43250) // 12h cooldown
			await suspendAddress(context, await bridge.getAddress())

			await expect(context.bridgeFacet.connect(context.signers.bridge).withdrawReceivedBridgeValue(1)).to.be.revertedWith(
				"Accessibility: Sender is Suspended",
			)
		})

		it("Should withdraw successfully", async function () {
			await time.increase(43250) // 12h cooldown

			const validator = new WithdrawLockedTransactionValidator()
			const beforeOut = await validator.before(context, {
				transactionId: 1n,
				bridge: await bridge.getAddress(),
			})

			await expect(context.bridgeFacet.connect(context.signers.bridge).withdrawReceivedBridgeValue(1))
				.to.emit(context.bridgeFacet, "WithdrawReceivedBridgeValue")
				.withArgs(1)

			await validator.after(context, {
				transactionId: 1n,
				beforeOutput: beforeOut,
			})

			const transaction = await context.viewFacet.getBridgeTransaction(1)
			expect(transaction.status).to.equal(BridgeTransactionStatus.WITHDRAWN)
		})
	})

	describe("withdrawReceivedBridgeValues", async function () {
		beforeEach(async function () {
			// Create multiple test transactions for the same bridge
			await context.bridgeFacet.connect(context.signers.user).transferToBridge(decimal(100n), await bridge.getAddress())
			await context.bridgeFacet.connect(context.signers.user).transferToBridge(decimal(200n), await bridge.getAddress())
			await context.bridgeFacet.connect(context.signers.user).transferToBridge(decimal(150n), await bridge.getAddress())
		})

		it("Should handle empty transaction IDs array", async function () {
			await time.increase(43250) // 12h cooldown
			// Empty array should succeed but transfer 0 amount
			await expect(context.bridgeFacet.connect(context.signers.bridge).withdrawReceivedBridgeValues([])).to.not.be.reverted
		})

		it("Should fail with invalid transaction ID", async function () {
			await time.increase(43250) // 12h cooldown
			await expect(context.bridgeFacet.connect(context.signers.bridge).withdrawReceivedBridgeValues([1, 999])).to.be.revertedWith(
				"BridgeFacet: Invalid transactionId",
			)
		})

		it("Should fail when sender is not the transaction's bridge", async function () {
			await time.increase(43250) // 12h cooldown
			await expect(context.bridgeFacet.connect(context.signers.bridge2).withdrawReceivedBridgeValues([1, 2])).to.be.revertedWith(
				"BridgeFacet: Sender is not the transaction's bridge",
			)
		})

		it("Should fail when cooldown period hasn't elapsed", async function () {
			await expect(context.bridgeFacet.connect(context.signers.bridge).withdrawReceivedBridgeValues([1, 2])).to.be.revertedWith(
				"BridgeFacet: Cooldown hasn't reached",
			)
		})

		it("Should fail when any transaction is already withdrawn", async function () {
			await time.increase(43250) // 12h cooldown
			await context.bridgeFacet.connect(context.signers.bridge).withdrawReceivedBridgeValue(1)

			await expect(context.bridgeFacet.connect(context.signers.bridge).withdrawReceivedBridgeValues([1, 2])).to.be.revertedWith(
				"BridgeFacet: Already withdrawn",
			)
		})

		it("Should withdraw multiple transactions successfully", async function () {
			await time.increase(43250) // 12h cooldown
			const transactionIds = [1, 3]

			const bridgeAddress = await bridge.getAddress()
			const collateralBefore = await context.collateral.balanceOf(bridgeAddress)

			await expect(context.bridgeFacet.connect(context.signers.bridge).withdrawReceivedBridgeValues(transactionIds)).to.not.reverted

			for (const id of transactionIds) {
				const transaction = await context.viewFacet.getBridgeTransaction(id)
				expect(transaction.status).to.equal(BridgeTransactionStatus.WITHDRAWN)
			}

			// Verify collateral was transferred (tx1=100 + tx3=150 = 250)
			const collateralAfter = await context.collateral.balanceOf(bridgeAddress)
			expect(collateralAfter - collateralBefore).to.equal(decimal(250n))
		})
	})

	describe("restoreBridgeTransaction edge cases", async function () {
		beforeEach(async function () {
			await context.bridgeFacet.connect(context.signers.user).transferToBridge(decimal(100n), await bridge.getAddress())
			await context.bridgeFacet.connect(context.signers.admin).suspendBridgeTransaction(1)
		})

		it("Should restore with full valid amount (no invalid portion)", async function () {
			const originalTransaction = await context.viewFacet.getBridgeTransaction(1)
			const withdrawLockedBalanceBefore = await context.viewFacet.getWithdrawLockedBalance()

			await expect(context.bridgeFacet.connect(context.signers.admin).restoreBridgeTransaction(1, originalTransaction.amount)).to.not.reverted

			const restoredTransaction = await context.viewFacet.getBridgeTransaction(1)
			expect(restoredTransaction.status).to.equal(BridgeTransactionStatus.RECEIVED)
			expect(restoredTransaction.amount).to.equal(originalTransaction.amount)

			const withdrawLockedBalanceAfter = await context.viewFacet.getWithdrawLockedBalance()
			expect(withdrawLockedBalanceAfter).to.equal(withdrawLockedBalanceBefore)
		})

		it("Should allow bridge to withdraw after restore", async function () {
			const originalTransaction = await context.viewFacet.getBridgeTransaction(1)

			await context.bridgeFacet.connect(context.signers.admin).restoreBridgeTransaction(1, originalTransaction.amount)

			await time.increase(43250) // 12h cooldown

			const bridgeAddress = await bridge.getAddress()
			const collateralBefore = await context.collateral.balanceOf(bridgeAddress)

			await expect(context.bridgeFacet.connect(context.signers.bridge).withdrawReceivedBridgeValue(1)).to.not.reverted

			const collateralAfter = await context.collateral.balanceOf(bridgeAddress)
			expect(collateralAfter - collateralBefore).to.equal(originalTransaction.amount)

			const transaction = await context.viewFacet.getBridgeTransaction(1)
			expect(transaction.status).to.equal(BridgeTransactionStatus.WITHDRAWN)
		})

		it("Should reduce lock by full amount when restored valid amount is zero", async function () {
			const originalTransaction = await context.viewFacet.getBridgeTransaction(1)
			const withdrawLockedBalanceBefore = await context.viewFacet.getWithdrawLockedBalance()

			await expect(context.bridgeFacet.connect(context.signers.admin).restoreBridgeTransaction(1, 0)).to.not.reverted

			const restoredTransaction = await context.viewFacet.getBridgeTransaction(1)
			expect(restoredTransaction.status).to.equal(BridgeTransactionStatus.RECEIVED)
			expect(restoredTransaction.amount).to.equal(0)

			const withdrawLockedBalanceAfterRestore = await context.viewFacet.getWithdrawLockedBalance()
			expect(withdrawLockedBalanceAfterRestore).to.equal(withdrawLockedBalanceBefore - originalTransaction.amount)

			await time.increase(43250) // 12h cooldown
			await expect(context.bridgeFacet.connect(context.signers.bridge).withdrawReceivedBridgeValue(1)).to.not.reverted

			const withdrawLockedBalanceAfterWithdraw = await context.viewFacet.getWithdrawLockedBalance()
			expect(withdrawLockedBalanceAfterWithdraw).to.equal(withdrawLockedBalanceAfterRestore)
		})

		it("Should keep global withdraw lock equal to sum of received transaction amounts after partial restore", async function () {
			await context.bridgeFacet.connect(context.signers.user).transferToBridge(decimal(200n), await bridge.getAddress())

			await context.bridgeFacet.connect(context.signers.admin).restoreBridgeTransaction(1, decimal(40n))

			const tx1 = await context.viewFacet.getBridgeTransaction(1)
			const tx2 = await context.viewFacet.getBridgeTransaction(2)
			const withdrawLockedBalance = await context.viewFacet.getWithdrawLockedBalance()

			expect(tx1.status).to.equal(BridgeTransactionStatus.RECEIVED)
			expect(tx2.status).to.equal(BridgeTransactionStatus.RECEIVED)
			expect(withdrawLockedBalance).to.equal(tx1.amount + tx2.amount)
		})

		it("Should fail to restore a non-suspended transaction", async function () {
			// Restore first to make it RECEIVED again
			const originalTransaction = await context.viewFacet.getBridgeTransaction(1)
			await context.bridgeFacet.connect(context.signers.admin).restoreBridgeTransaction(1, originalTransaction.amount)

			// Try restoring again - should fail since it's now RECEIVED
			await expect(context.bridgeFacet.connect(context.signers.admin).restoreBridgeTransaction(1, originalTransaction.amount)).to.be.revertedWith(
				"BridgeFacet: Invalid status",
			)
		})
	})
}
