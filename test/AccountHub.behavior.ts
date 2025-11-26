import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import { expect } from "chai"
import { ethers } from "hardhat"
import { BytesLike, toUtf8Bytes, ZeroHash } from "ethers"

import { initializeFixture } from "./Initialize.fixture"
import { RunContext } from "./models/RunContext"
import { User } from "./models/User"
import { Hedger } from "./models/Hedger"
import { decimal } from "./utils/Common"
import { IAccountHub } from "../src/types"
import { before } from "node:test"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest"
import { OrderType, PositionType } from "./models/Enums"

export function shouldBehaveLikeAccountHub(): void {
	let context: RunContext, user: User, user2: User, hedger: Hedger

	// Test constants
	const BALANCES = {
		INITIAL_COLLATERAL: decimal(5000n),
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

		describe("_call", async () => {
			let subAccountAddress: string

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

				// Deposit funds for all tests
				await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
				await context.accountFacet.connect(context.signers.user).depositFor(subAccountAddress, BALANCES.DEPOSIT_AMOUNT)
			})

			describe("General behavior", async () => {
				it("should revert when callData is empty", async () => {
					const callData: BytesLike[] = []
					await expect(context.accountHub.connect(context.signers.user)._call(subAccountAddress, callData)).to.revertedWithCustomError(
						context.accountHub,
						"EmptyArray",
					)
				})

				it("should execute non-sendQuote calls successfully", async () => {
					const callData: BytesLike[] = [context.accountFacet.interface.encodeFunctionData("allocate", [BALANCES.SMALL_AMOUNT])]

					await expect(context.accountHub.connect(context.signers.user)._call(subAccountAddress, callData)).to.not.be.reverted

					const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(subAccountAddress)
					expect(allocatedBalance).to.equal(BALANCES.SMALL_AMOUNT)
				})

				// TODO: Need legacy MultiAccount for ownership tests
				// it("should only be callable by owner of subAccount", async () => { ... })
			})

			describe("SendQuote with isolation types", async () => {
				const createSendQuoteCallData = async (quoteRequest: any) => {
					return context.partyAFacet.interface.encodeFunctionData("sendQuote", [
						quoteRequest.partyBWhiteList,
						quoteRequest.symbolId,
						quoteRequest.positionType,
						quoteRequest.orderType,
						quoteRequest.price,
						quoteRequest.quantity,
						quoteRequest.cva,
						quoteRequest.lf,
						quoteRequest.partyAmm,
						quoteRequest.partyBmm,
						quoteRequest.maxFundingRate,
						await quoteRequest.deadline,
						await quoteRequest.upnlSig,
					])
				}

				describe("POSITION isolation (0)", async () => {
					let positionSubAccount: string

					beforeEach(async () => {
						const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
							{
								name: "POSITION_ACCOUNT",
								metadata: ethers.keccak256(toUtf8Bytes("POSITION")),
								symmioCore: context.diamond,
								isolationType: 0,
							},
						]

						await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas)
						const accounts = await context.accountHub.getSubAccounts(context.signers.user)
						positionSubAccount = accounts[accounts.length - 1]

						await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
						await context.accountFacet.connect(context.signers.user).depositFor(positionSubAccount, BALANCES.DEPOSIT_AMOUNT)
					})

					it("should create virtual account and send quote successfully", async () => {
						const virtualAccountsBefore = await context.accountHub.getVirtualAccounts(positionSubAccount)
						expect(virtualAccountsBefore.length).to.equal(0)

						const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						await expect(context.accountHub.connect(context.signers.user)._call(positionSubAccount, [sendQuoteCallData])).to.not.be.reverted

						const virtualAccountsAfter = await context.accountHub.getVirtualAccounts(positionSubAccount)
						expect(virtualAccountsAfter.length).to.equal(1)
					})

					it("should revert when trying to send another quote on existing virtual account", async () => {
						const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
						const sendQuoteCallData = await await createSendQuoteCallData(quoteRequest)

						await context.accountHub.connect(context.signers.user)._call(positionSubAccount, [sendQuoteCallData])
						const virtualAccounts = await context.accountHub.getVirtualAccounts(positionSubAccount)

						await expect(context.accountHub.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallData])).to.revertedWithCustomError(
							context.accountHub,
							"PositionTypeNotAllowedForThisAccount",
						)
					})
				})

				describe("MARKET isolation (1)", async () => {
					let marketSubAccount: string

					beforeEach(async () => {
						const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
							{
								name: "MARKET_ACCOUNT",
								metadata: ethers.keccak256(toUtf8Bytes("MARKET")),
								symmioCore: context.diamond,
								isolationType: 1,
							},
						]

						await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas)
						const accounts = await context.accountHub.getSubAccounts(context.signers.user)
						marketSubAccount = accounts[accounts.length - 1]

						await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
						await context.accountFacet.connect(context.signers.user).depositFor(marketSubAccount, BALANCES.DEPOSIT_AMOUNT)
					})

					it("should create virtual account and send quote successfully", async () => {
						const virtualAccountsBefore = await context.accountHub.getVirtualAccounts(marketSubAccount)
						expect(virtualAccountsBefore.length).to.equal(0)

						const quoteRequest = limitQuoteRequestBuilder().build()
						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						await expect(context.accountHub.connect(context.signers.user)._call(marketSubAccount, [sendQuoteCallData])).to.not.be.reverted

						const virtualAccountsAfter = await context.accountHub.getVirtualAccounts(marketSubAccount)
						expect(virtualAccountsAfter.length).to.equal(1)
					})

					it("should revert when trying to send quote with different symbol", async () => {
						const quoteRequest1 = limitQuoteRequestBuilder().symbolId(1).build()
						const sendQuoteCallData1 = await createSendQuoteCallData(quoteRequest1)

						await context.accountHub.connect(context.signers.user)._call(marketSubAccount, [sendQuoteCallData1])
						const virtualAccounts = await context.accountHub.getVirtualAccounts(marketSubAccount)

						const quoteRequest2 = limitQuoteRequestBuilder().symbolId(2).build()
						const sendQuoteCallData2 = await createSendQuoteCallData(quoteRequest2)

						await expect(context.accountHub.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallData2])).to.revertedWithCustomError(
							context.accountHub,
							"SymbolNotAllowedForThisAccount",
						)
					})

					it("should allow multiple quotes with same symbol", async () => {
						const quoteRequest = limitQuoteRequestBuilder().build()
						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						await context.accountHub.connect(context.signers.user)._call(marketSubAccount, [sendQuoteCallData])
						const virtualAccounts = await context.accountHub.getVirtualAccounts(marketSubAccount)

						await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
						await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(virtualAccounts[0], BALANCES.DEPOSIT_AMOUNT)

						await expect(context.accountHub.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallData])).to.not.be.reverted

						const virtualAccountsAfter = await context.accountHub.getVirtualAccounts(marketSubAccount)
						expect(virtualAccountsAfter.length).to.equal(1)
					})
				})

				describe("MARKET_DIRECTION isolation (2)", async () => {
					let marketDirectionSubAccount: string

					beforeEach(async () => {
						const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
							{
								name: "MARKET_DIRECTION_ACCOUNT",
								metadata: ethers.keccak256(toUtf8Bytes("MARKET_DIRECTION")),
								symmioCore: context.diamond,
								isolationType: 2,
							},
						]

						await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas)
						const accounts = await context.accountHub.getSubAccounts(context.signers.user)
						marketDirectionSubAccount = accounts[accounts.length - 1]

						await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
						await context.accountFacet.connect(context.signers.user).depositFor(marketDirectionSubAccount, BALANCES.DEPOSIT_AMOUNT)
					})

					it("should create virtual account and send quote successfully", async () => {
						const virtualAccountsBefore = await context.accountHub.getVirtualAccounts(marketDirectionSubAccount)
						expect(virtualAccountsBefore.length).to.equal(0)

						const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						await expect(context.accountHub.connect(context.signers.user)._call(marketDirectionSubAccount, [sendQuoteCallData])).to.not.be.reverted

						const virtualAccountsAfter = await context.accountHub.getVirtualAccounts(marketDirectionSubAccount)
						expect(virtualAccountsAfter.length).to.equal(1)
					})

					it("should revert when symbol or position type differs", async () => {
						const quoteRequestLong = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
						const sendQuoteCallDataLong = await createSendQuoteCallData(quoteRequestLong)

						await context.accountHub.connect(context.signers.user)._call(marketDirectionSubAccount, [sendQuoteCallDataLong])
						const virtualAccounts = await context.accountHub.getVirtualAccounts(marketDirectionSubAccount)

						// Different position type (SHORT instead of LONG)
						const quoteRequestShort = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.SHORT).build()
						const sendQuoteCallDataShort = await createSendQuoteCallData(quoteRequestShort)

						await expect(
							context.accountHub.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallDataShort]),
						).to.revertedWithCustomError(context.accountHub, "PositionTypeNotAllowedForThisAccount")

						// Different symbol
						const quoteRequestDiffSymbol = limitQuoteRequestBuilder().symbolId(2).positionType(PositionType.LONG).build()
						const sendQuoteCallDataDiffSymbol = await createSendQuoteCallData(quoteRequestDiffSymbol)

						await expect(
							context.accountHub.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallDataDiffSymbol]),
						).to.revertedWithCustomError(context.accountHub, "SymbolNotAllowedForThisAccount")
					})

					it("should allow multiple quotes with same symbol and position type", async () => {
						const quoteRequest = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						await context.accountHub.connect(context.signers.user)._call(marketDirectionSubAccount, [sendQuoteCallData])
						const virtualAccounts = await context.accountHub.getVirtualAccounts(marketDirectionSubAccount)

						await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
						await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(virtualAccounts[0], BALANCES.DEPOSIT_AMOUNT)

						await expect(context.accountHub.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallData])).to.not.be.reverted
						await expect(context.accountHub.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallData])).to.not.be.reverted
						await expect(context.accountHub.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallData])).to.not.be.reverted

						const virtualAccountsAfter = await context.accountHub.getVirtualAccounts(marketDirectionSubAccount)
						expect(virtualAccountsAfter.length).to.equal(1)
					})
				})
			})
		})
	})
}


// TODO ::: legacy MultiAccount Test
// TODO ::: onClosePosition
