import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import { expect } from "chai"
import { ethers } from "hardhat"
import { toUtf8Bytes, ZeroHash } from "ethers"

import { initializeFixture } from "./Initialize.fixture"
import { RunContext } from "./models/RunContext"
import { User } from "./models/User"
import { Hedger } from "./models/Hedger"
import { decimal } from "./utils/Common"
import { IAccountHub } from "../src/types"

export function shouldBehaveLikeAccountHub(): void {
	let context: RunContext, user: User, user2: User, hedger: Hedger

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

	describe("AccountHub", async function () {
		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(BALANCES.INITIAL_COLLATERAL)
		})

		describe("initialize", async () => {
			it("should initialize successfully", async () => {
				expect(await context.accountHub.affiliateHub()).to.equal(await context.affiliateHub.getAddress())
				expect(await context.accountHub.hasRole(ZeroHash, await context.signers.admin.getAddress())).to.true
			})
		})

		describe("createSubAccounts", async () => {
			it("should create subAccount successfully", async () => {
				const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
					{
						name: "EXAMPLE_NAME",
						metadata: ethers.keccak256(toUtf8Bytes("EXAMPLE")),
						symmioCore: context.diamond,
						isolationType: 0,
					},
				]

				const oldNonce = await context.accountHub.globalNonce()
				let newNonce = oldNonce
				await expect(context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas)).to
					.not.reverted

				const accounts = await context.accountHub.getSubAccounts(context.signers.user)

				if (accounts.length != accountDatas.length) {
					throw Error("invalid length of account creation result")
				}

				for (let i = 0; i < accounts.length; i++) {
					const acc = await context.accountHub.getSubAccountData(accounts[i])
					expect(acc.owner).to.equal(context.signers.user.address)
					expect(acc.isExists).to.true
					expect(acc.name).to.equal(accountDatas[i].name)
					expect(acc.metadata).to.equal(accountDatas[i].metadata)
					expect(acc.affiliate).to.equal(await context.accountManager.getAddress())
					expect(acc.symmioCore).to.equal(accountDatas[i].symmioCore)
					expect(acc.isolationType).to.equal(accountDatas[i].isolationType)

					newNonce++
				}

				expect(newNonce).to.equal(Number(oldNonce) + accounts.length)
			})

			it("should failed when array is empty", async () => {
				const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = []
				await expect(
					context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas),
				).to.revertedWithCustomError(context.accountHub, "EmptyArray")
			})

			it("should failed when name length is more than limit", async () => {
				const maxNameLength = await context.accountHub.MAX_NAME_LENGTH()
				const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
					{
						name: "A".repeat(Number(maxNameLength) + 1),
						metadata: ethers.keccak256(toUtf8Bytes("EXAMPLE")),
						symmioCore: context.diamond,
						isolationType: 0,
					},
				]
				await expect(
					context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas),
				).to.revertedWithCustomError(context.accountHub, "InvalidNameLength")
			})

			it("should failed when affiliate not whitelisted provided symmioCore", async () => {
				const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
					{
						name: "EXAMPLE_NAME",
						metadata: ethers.keccak256(toUtf8Bytes("EXAMPLE")),
						symmioCore: context.signers.others[0],
						isolationType: 0,
					},
				]
				await expect(
					context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas),
				).to.revertedWithCustomError(context.accountHub, "NotSymmioCore")
			})

			it("should failed when provided affiliate not active", async () => {
				const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
					{
						name: "EXAMPLE_NAME",
						metadata: ethers.keccak256(toUtf8Bytes("EXAMPLE")),
						symmioCore: context.diamond,
						isolationType: 0,
					},
				]
				await expect(
					context.accountHub.connect(context.signers.user).createSubAccounts(context.signers.others[0].address, accountDatas),
				).to.revertedWithCustomError(context.accountHub, "AffiliateNotActive")
			})

			it("should call Hook successfully", async () => {
				// TODO :::
			})
		})

		describe("editAccountName", async () => {
			let subAccountAddress: string = ""
			beforeEach(async () => {
				const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
					{
						name: "EXAMPLE_NAME",
						metadata: ethers.keccak256(toUtf8Bytes("EXAMPLE")),
						symmioCore: context.diamond,
						isolationType: 0,
					},
				]

				await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas)
				const accounts = await context.accountHub.getSubAccounts(context.signers.user)
				subAccountAddress = accounts[0]
			})

			it("should edit subAccount name successfully", async () => {
				const accBeforeEdit = await context.accountHub.getSubAccountData(subAccountAddress)

				const newAccountName = "NEW_EXAMPLE_NAME"
				await expect(context.accountHub.connect(context.signers.user).editAccountName(subAccountAddress, newAccountName)).to.not.reverted

				const accAfterEdit = await context.accountHub.getSubAccountData(subAccountAddress)
				expect(accAfterEdit.owner).to.equal(context.signers.user.address)
				expect(accAfterEdit.isExists).to.true
				expect(accAfterEdit.name).to.equal(newAccountName)
				expect(accAfterEdit.metadata).to.equal(accBeforeEdit.metadata)
				expect(accAfterEdit.affiliate).to.equal(accBeforeEdit.affiliate)
				expect(accAfterEdit.symmioCore).to.equal(accBeforeEdit.symmioCore)
				expect(accAfterEdit.isolationType).to.equal(accBeforeEdit.isolationType)
			})

			it("should failed when name length is more than limit", async () => {
				const maxNameLength = await context.accountHub.MAX_NAME_LENGTH()
				const newAccountName = "A".repeat(Number(maxNameLength) + 1)

				await expect(context.accountHub.connect(context.signers.user).editAccountName(subAccountAddress, newAccountName)).to.revertedWithCustomError(
					context.accountHub,
					"InvalidNameLength",
				)
			})

			//TODO ::: Need legacy multiAccount ::: it("should allowed just by the account owner", async () => {
			// 	const newAccountName = "NEW_EXAMPLE_NAME"

			// 	await expect(
			// 		context.accountHub.connect(context.signers.others[0]).editAccountName(subAccountAddress, newAccountName),
			// 	).to.revertedWithCustomError(context.accountHub, "NotOwner")
			// })

			//TODO ::: it("should failed when subAccount not exists", async () => {
			// 	const newAccountName = "NEW_EXAMPLE_NAME"

			// 	await expect(
			// 		context.accountHub.connect(context.signers.user).editAccountName(context.signers.others[0], newAccountName),
			// 	).to.revertedWithCustomError(context.accountHub, "InvalidNameLength")
			// })
		})

		describe("depositForAccount", async () => {
			let subAccountAddress: string = ""
			beforeEach(async () => {
				const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
					{
						name: "EXAMPLE_NAME",
						metadata: ethers.keccak256(toUtf8Bytes("EXAMPLE")),
						symmioCore: context.diamond,
						isolationType: 0,
					},
				]

				await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas)
				const accounts = await context.accountHub.getSubAccounts(context.signers.user)
				subAccountAddress = accounts[0]
			})

			it("should deposit to subAccount successfully", async () => {
				await context.collateral
					.connect(context.signers.user)
					.increaseAllowance(await context.accountHub.getAddress(), decimal(BALANCES.DEPOSIT_AMOUNT))

				await expect(context.accountHub.connect(context.signers.user).depositForAccount(subAccountAddress, BALANCES.DEPOSIT_AMOUNT)).to.not.reverted

				expect(await context.viewFacet.balanceOf(subAccountAddress)).to.equal(BALANCES.DEPOSIT_AMOUNT)
			})

			it("should failed when contract paused", async () => {
				await context.accountHub.connect(context.signers.admin).pause()
				await expect(context.accountHub.connect(context.signers.user).depositForAccount(subAccountAddress, BALANCES.DEPOSIT_AMOUNT)).to.revertedWith(
					"Pausable: paused",
				)
			})
		})

		describe("allocateForAccount", async () => {
			let subAccountAddress: string = ""
			beforeEach(async () => {
				const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
					{
						name: "EXAMPLE_NAME",
						metadata: ethers.keccak256(toUtf8Bytes("EXAMPLE")),
						symmioCore: context.diamond,
						isolationType: 0,
					},
				]

				await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas)
				const accounts = await context.accountHub.getSubAccounts(context.signers.user)
				subAccountAddress = accounts[0]

				await context.collateral
					.connect(context.signers.user)
					.increaseAllowance(await context.accountHub.getAddress(), decimal(BALANCES.DEPOSIT_AMOUNT))

				await context.accountHub.connect(context.signers.user).depositForAccount(subAccountAddress, BALANCES.DEPOSIT_AMOUNT)
			})

			it("should allocate for subAccount successfully", async () => {
				await context.accountHub.setSigner(subAccountAddress)
				await expect(context.accountHub.connect(context.signers.user).allocateForAccount(subAccountAddress, BALANCES.ALLOCATE_AMOUNT)).to.not.reverted
				expect(await context.viewFacet.balanceOf(subAccountAddress)).to.equal(BALANCES.DEPOSIT_AMOUNT - BALANCES.ALLOCATE_AMOUNT)
			})

			it("should failed when contract paused", async () => {
				await context.accountHub.connect(context.signers.admin).pause()
				await expect(context.accountHub.connect(context.signers.user).depositForAccount(subAccountAddress, BALANCES.DEPOSIT_AMOUNT)).to.revertedWith(
					"Pausable: paused",
				)
			})
		})
	})
}
