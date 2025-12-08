import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import { expect, use } from "chai"
import { ethers } from "hardhat"
import { BytesLike, toUtf8Bytes, ZeroAddress, ZeroHash } from "ethers"

import { initializeFixture } from "./Initialize.fixture"
import { RunContext } from "./models/RunContext"
import { User } from "./models/User"
import { Hedger } from "./models/Hedger"
import { decimal } from "./utils/Common"
import { IAccountHub, IAccountHubHook__factory, MockAccountHubHook } from "../src/types"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest"
import { PositionType } from "./models/Enums"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest"
import { getDummyPairUpnlAndPriceSig } from "./utils/SignatureUtils"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest"

export function shouldBehaveLikeAccountHub(): void {
	let context: RunContext, user: User, user2: User, hedger: Hedger

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

	// Test constants
	const BALANCES = {
		INITIAL_COLLATERAL: decimal(10000n),
		DEPOSIT_AMOUNT: decimal(3000n),
		SMALL_AMOUNT: decimal(25n),
	}

	describe("AccountHub", async function () {
		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(BALANCES.INITIAL_COLLATERAL)

			hedger = new Hedger(context, context.signers.hedger)
			await hedger.setup()
			await hedger.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.INITIAL_COLLATERAL)

			await context.controlFacet.registerHook(ZeroAddress, await context.accountHub.getAddress())

			await context.symbolControlFacet
			.connect(context.signers.admin)
			.addSymbol("ETHUSDT", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
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

			it("should allowed just by the account owner", async () => {
				const newAccountName = "NEW_EXAMPLE_NAME"

				await expect(
					context.accountHub.connect(context.signers.others[0]).editAccountName(subAccountAddress, newAccountName),
				).to.revertedWithCustomError(context.accountHub, "NotOwner")
			})

			it("should failed when subAccount not exists", async () => {
				const newAccountName = "NEW_EXAMPLE_NAME"

				await expect(
					context.accountHub.connect(context.signers.user).editAccountName(context.signers.others[0], newAccountName),
				).to.revertedWithCustomError(context.accountHub, "NotOwner")
			})
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

				it("should only be callable by owner of subAccount", async () => {
					const callData: BytesLike[] = [context.accountFacet.interface.encodeFunctionData("allocate", [BALANCES.SMALL_AMOUNT])]

					await expect(context.accountHub.connect(context.signers.others[0])._call(subAccountAddress, callData)).to.revertedWithCustomError(
						context.accountHub,
						"NotOwner",
					)
				})
			})

			describe("SendQuote with isolation types", async () => {
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
						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

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
						await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(marketSubAccount, BALANCES.DEPOSIT_AMOUNT)

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

				describe("CUSTOM isolation (3)", async () => {
					let customSubAccount: string

					beforeEach(async () => {
						const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
							{
								name: "CUSTOM_ACCOUNT",
								metadata: ethers.keccak256(toUtf8Bytes("CUSTOM")),
								symmioCore: context.diamond,
								isolationType: 3,
							},
						]

						await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas)
						const accounts = await context.accountHub.getSubAccounts(context.signers.user)
						customSubAccount = accounts[accounts.length - 1]

						await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
						await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(customSubAccount, BALANCES.DEPOSIT_AMOUNT)
					})

					it("should not create virtual accounts for CUSTOM isolation", async () => {
						const virtualAccountsBefore = await context.accountHub.getVirtualAccounts(customSubAccount)
						expect(virtualAccountsBefore.length).to.equal(0)

						const quoteRequest = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()

						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						await expect(context.accountHub.connect(context.signers.user)._call(customSubAccount, [sendQuoteCallData])).to.not.reverted

						// Verify no virtual accounts were created
						const virtualAccountsAfter = await context.accountHub.getVirtualAccounts(customSubAccount)
						expect(virtualAccountsAfter.length).to.equal(0)
					})

					it("should send quote directly from sub-account without creating virtual account", async () => {
						const quoteRequest = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()

						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						await expect(context.accountHub.connect(context.signers.user)._call(customSubAccount, [sendQuoteCallData])).to.not.reverted

						// Verify quote was tracked in sub-account
						const quoteIds = await context.accountHub.getSubAccountQuoteIds(customSubAccount)
						expect(quoteIds.length).to.equal(1)
					})

					it("should allow multiple quotes with different symbols", async () => {
						// Send quote with symbol 1
						const quote1 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()

						const callData1 = await createSendQuoteCallData(quote1)

						await expect(context.accountHub.connect(context.signers.user)._call(customSubAccount, [callData1])).to.not.reverted

						// Send quote with symbol 2
						const quote2 = limitQuoteRequestBuilder().symbolId(2).positionType(PositionType.SHORT).build()

						const callData2 = await createSendQuoteCallData(quote2)

						await expect(context.accountHub.connect(context.signers.user)._call(customSubAccount, [callData2])).to.not.reverted

						// Verify both quotes were tracked
						const quoteIds = await context.accountHub.getSubAccountQuoteIds(customSubAccount)
						expect(quoteIds.length).to.equal(2)

						// Verify no virtual accounts created
						const virtualAccounts = await context.accountHub.getVirtualAccounts(customSubAccount)
						expect(virtualAccounts.length).to.equal(0)
					})

					it("should allow both LONG and SHORT positions on same symbol", async () => {
						// Send LONG quote
						const longQuote = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()

						const longCallData = await createSendQuoteCallData(longQuote)

						await expect(context.accountHub.connect(context.signers.user)._call(customSubAccount, [longCallData])).to.not.reverted

						// Send SHORT quote on same symbol
						const shortQuote = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.SHORT).build()

						const shortCallData = await createSendQuoteCallData(shortQuote)

						await expect(context.accountHub.connect(context.signers.user)._call(customSubAccount, [shortCallData])).to.not.reverted

						// Verify both quotes were tracked
						const quoteIds = await context.accountHub.getSubAccountQuoteIds(customSubAccount)
						expect(quoteIds.length).to.equal(2)
					})

					it("should track quote IDs correctly", async () => {
						const quoteIdsBefore = await context.accountHub.getSubAccountQuoteIds(customSubAccount)
						expect(quoteIdsBefore.length).to.equal(0)

						// Send first quote
						const quote1 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()

						const callData1 = await createSendQuoteCallData(quote1)

						await context.accountHub.connect(context.signers.user)._call(customSubAccount, [callData1])

						let quoteIds = await context.accountHub.getSubAccountQuoteIds(customSubAccount)
						expect(quoteIds.length).to.equal(1)

						// Send second quote
						const quote2 = limitQuoteRequestBuilder().symbolId(2).positionType(PositionType.SHORT).build()

						const callData2 = await createSendQuoteCallData(quote2)

						await context.accountHub.connect(context.signers.user)._call(customSubAccount, [callData2])

						quoteIds = await context.accountHub.getSubAccountQuoteIds(customSubAccount)
						expect(quoteIds.length).to.equal(2)
					})

					it("should not transfer funds internally for CUSTOM isolation", async () => {
						const balanceBefore = await context.viewFacet.balanceOf(customSubAccount)

						const quoteRequest = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()

						const callData = await createSendQuoteCallData(quoteRequest)

						await context.accountHub.connect(context.signers.user)._call(customSubAccount, [callData])

						const balanceAfter = await context.viewFacet.balanceOf(customSubAccount)

						// Balance should remain in the sub-account (no internal transfers to virtual accounts)
						expect(balanceAfter).to.equal(balanceBefore)
					})
				})

				describe("CUSTOM isolation (3) type with manual virtual account creation", async () => {
					let customSubAccount: string

					beforeEach(async () => {
						const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
							{
								name: "CUSTOM_ISOLATION_ACCOUNT",
								metadata: ethers.keccak256(toUtf8Bytes("CUSTOM_ISO")),
								symmioCore: context.diamond,
								isolationType: 3, // CUSTOM isolation
							},
						]

						await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas)
						const accounts = await context.accountHub.getSubAccounts(context.signers.user)
						customSubAccount = accounts[accounts.length - 1]

						await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
						await context.accountFacet.connect(context.signers.user).depositFor(customSubAccount, BALANCES.DEPOSIT_AMOUNT)
					})

					it("should create virtual account manually for CUSTOM isolation", async () => {
						const virtualAccountsBefore = await context.accountHub.getVirtualAccounts(customSubAccount)
						expect(virtualAccountsBefore.length).to.equal(0)

						// Manually create a POSITION isolated virtual account
						await expect(
							context.accountHub.connect(context.signers.user).createCustomVirtualAccount(
								customSubAccount,
								ethers.keccak256(toUtf8Bytes("VIRTUAL_1")),
								1, // VirtualAccountIsolationType.POSITION
								1, // symbolId
							),
						).to.not.reverted

						const virtualAccountsAfter = await context.accountHub.getVirtualAccounts(customSubAccount)
						expect(virtualAccountsAfter.length).to.equal(1)
					})

					it("should create multiple virtual accounts with different isolation types", async () => {
						// Create POSITION isolated virtual account
						await context.accountHub.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("POSITION_VIRTUAL")),
							1, // POSITION
							1,
						)

						// Create MARKET isolated virtual account
						await context.accountHub.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("MARKET_VIRTUAL")),
							1, // MARKET
							1,
						)

						// Create MARKET_LONG isolated virtual account
						await context.accountHub.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("MARKET_LONG_VIRTUAL")),
							3, // MARKET_LONG
							2,
						)

						// Create MARKET_SHORT isolated virtual account
						await context.accountHub.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("MARKET_SHORT_VIRTUAL")),
							3, // MARKET_SHORT
							2,
						)

						const virtualAccounts = await context.accountHub.getVirtualAccounts(customSubAccount)
						expect(virtualAccounts.length).to.equal(4)
					})

					it("should transfer funds to virtual account and send quote", async () => {
						// Create virtual account
						await context.accountHub.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("VIRTUAL_1")),
							0, // POSITION
							1,
						)

						const virtualAccounts = await context.accountHub.getVirtualAccounts(customSubAccount)
						const virtualAccount = virtualAccounts[0]

						// Transfer funds from sub-account to virtual account
						const transferAmount = decimal(100n)
						const transferCallData = context.accountFacet.interface.encodeFunctionData("internalTransfer", [virtualAccount, transferAmount])

						await expect(context.accountHub.connect(context.signers.user)._call(customSubAccount, [transferCallData])).to.not.reverted

						const virtualAccountBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)
						expect(virtualAccountBalance).to.equal(transferAmount)

						// Send quote from virtual account
						const quoteRequest = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()

						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						await expect(context.accountHub.connect(context.signers.user)._call(virtualAccount, [sendQuoteCallData])).to.not.reverted

						const quoteIds = await context.accountHub.getVirtualAccountQuoteIds(virtualAccount)
						expect(quoteIds.length).to.equal(1)
					})

					it("should enforce MARKET_LONG isolation on manually created virtual account", async () => {
						// Create MARKET_LONG virtual account
						await context.accountHub.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("MARKET_LONG")),
							2, // MARKET_LONG
							1,
						)

						const virtualAccounts = await context.accountHub.getVirtualAccounts(customSubAccount)
						const virtualAccount = virtualAccounts[0]

						// Transfer funds
						const transferCallData = context.accountFacet.interface.encodeFunctionData("internalTransfer", [virtualAccount, decimal(100n)])
						await context.accountHub.connect(context.signers.user)._call(customSubAccount, [transferCallData])

						// Try to send SHORT quote - should fail
						const shortQuote = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.SHORT).build()

						const shortCallData = await createSendQuoteCallData(shortQuote)

						await expect(context.accountHub.connect(context.signers.user)._call(virtualAccount, [shortCallData])).to.revertedWithCustomError(
							context.accountHub,
							"PositionTypeNotAllowedForThisAccount",
						)

						// Send LONG quote - should succeed
						const longQuote = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
						const longCallData = await createSendQuoteCallData(longQuote)

						await expect(context.accountHub.connect(context.signers.user)._call(virtualAccount, [longCallData])).to.not.reverted
					})

					it("should enforce MARKET isolation - only allow quotes for specified symbol", async () => {
						// Create MARKET virtual account for symbol 1
						await context.accountHub.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("MARKET_SYMBOL_1")),
							1, // MARKET
							1, // symbolId 1
						)

						const virtualAccounts = await context.accountHub.getVirtualAccounts(customSubAccount)
						const virtualAccount = virtualAccounts[0]

						// Transfer funds
						const transferCallData = context.accountFacet.interface.encodeFunctionData("internalTransfer", [virtualAccount, decimal(100n)])
						await context.accountHub.connect(context.signers.user)._call(customSubAccount, [transferCallData])

						// Try to send quote for symbol 2 - should fail
						const wrongSymbolQuote = limitQuoteRequestBuilder().symbolId(2).positionType(PositionType.LONG).build()
						const wrongSymbolCallData = await createSendQuoteCallData(wrongSymbolQuote)

						await expect(context.accountHub.connect(context.signers.user)._call(virtualAccount, [wrongSymbolCallData])).to.revertedWithCustomError(
							context.accountHub,
							"SymbolNotAllowedForThisAccount",
						)

						// Send quote for symbol 1 - should succeed
						const correctSymbolQuote = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
						const correctSymbolCallData = await createSendQuoteCallData(correctSymbolQuote)

						await expect(context.accountHub.connect(context.signers.user)._call(virtualAccount, [correctSymbolCallData])).to.not.reverted
					})

					it("should fail to create virtual account from non-CUSTOM sub-account", async () => {
						// Create a POSITION isolated sub-account
						const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
							{
								name: "POSITION_SUB_ACCOUNT",
								metadata: ethers.keccak256(toUtf8Bytes("POSITION")),
								symmioCore: context.diamond,
								isolationType: 0, // POSITION isolation
							},
						]

						await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas)
						const accounts = await context.accountHub.getSubAccounts(context.signers.user)
						const positionSubAccount = accounts[accounts.length - 1]

						// Try to manually create virtual account - should fail
						await expect(
							context.accountHub
								.connect(context.signers.user)
								.createCustomVirtualAccount(positionSubAccount, ethers.keccak256(toUtf8Bytes("VIRTUAL")), 1, 1),
						).to.revertedWithCustomError(context.accountHub, "OnlyCustomIsolationCanCreateManually")
					})

					it("should only allow owner to create virtual accounts", async () => {
						await expect(
							context.accountHub
								.connect(context.signers.others[0])
								.createCustomVirtualAccount(customSubAccount, ethers.keccak256(toUtf8Bytes("VIRTUAL")), 1, 1),
						).to.revertedWithCustomError(context.accountHub, "NotOwner")
					})

					it("should use different virtual accounts for different trading strategies", async () => {
						// Create virtual account for BTC LONG trades
						await context.accountHub.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("BTC_LONG")),
							2, // MARKET_LONG
							1, // BTC
						)

						// Create virtual account for ETH SHORT trades
						await context.accountHub.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("ETH_SHORT")),
							3, // MARKET_SHORT
							2, // ETH
						)

						const virtualAccounts = await context.accountHub.getVirtualAccounts(customSubAccount)
						expect(virtualAccounts.length).to.equal(2)

						const btcLongVirtual = virtualAccounts[0]
						const ethShortVirtual = virtualAccounts[1]

						// Transfer funds to both
						const transferToBtc = context.accountFacet.interface.encodeFunctionData("internalTransfer", [btcLongVirtual, decimal(50n)])
						const transferToEth = context.accountFacet.interface.encodeFunctionData("internalTransfer", [ethShortVirtual, decimal(50n)])

						await context.accountHub.connect(context.signers.user)._call(customSubAccount, [transferToBtc, transferToEth])

						// Send BTC LONG quote
						const btcLongQuote = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()

						const btcCallData = await createSendQuoteCallData(btcLongQuote)

						await expect(context.accountHub.connect(context.signers.user)._call(btcLongVirtual, [btcCallData])).to.not.reverted

						// Send ETH SHORT quote
						const ethShortQuote = limitQuoteRequestBuilder().symbolId(2).positionType(PositionType.SHORT).build()

						const ethCallData = await createSendQuoteCallData(ethShortQuote)

						await expect(context.accountHub.connect(context.signers.user)._call(ethShortVirtual, [ethCallData])).to.not.reverted

						// Verify quotes tracked separately
						const btcQuotes = await context.accountHub.getVirtualAccountQuoteIds(btcLongVirtual)
						const ethQuotes = await context.accountHub.getVirtualAccountQuoteIds(ethShortVirtual)

						expect(btcQuotes.length).to.equal(1)
						expect(ethQuotes.length).to.equal(1)
					})
				})
			})
		})

		describe("onClosePosition", async () => {
			let customSubAccountAddress: string
			let positionSubAccountAddress: string

			beforeEach(async () => {
				const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
					{
						name: "EXAMPLE_NAME",
						metadata: ethers.keccak256(toUtf8Bytes("EXAMPLE")),
						symmioCore: context.diamond,
						isolationType: 3,
					},
					{
						name: "EXAMPLE_NAME",
						metadata: ethers.keccak256(toUtf8Bytes("EXAMPLE")),
						symmioCore: context.diamond,
						isolationType: 0,
					},
				]

				await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas)
				const accounts = await context.accountHub.getSubAccounts(context.signers.user)
				customSubAccountAddress = accounts[0]
				positionSubAccountAddress = accounts[1]

				// Deposit funds for all tests
				await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
				await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(customSubAccountAddress, BALANCES.DEPOSIT_AMOUNT)

				await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
				await context.accountFacet.connect(context.signers.user).depositFor(positionSubAccountAddress, BALANCES.DEPOSIT_AMOUNT)
			})

			it("should remove quoteId from subAccount(CUSTOM) quoteIds", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

				await context.accountHub.connect(context.signers.user)._call(customSubAccountAddress, [sendQuoteCallData])

				const quotesBeforeClose = await context.accountHub.getSubAccountQuoteIds(customSubAccountAddress)
				expect(quotesBeforeClose.length).to.equal(1)

				const quoteId = quotesBeforeClose[0]
				await hedger.lockQuote(quoteId)

				const openRequest = limitOpenRequestBuilder().build()
				await context.partyBPositionActionsFacet
					.connect(context.signers.hedger)
					.openPosition(
						quoteId,
						openRequest.filledAmount,
						openRequest.openPrice,
						await getDummyPairUpnlAndPriceSig(BigInt(openRequest.price), BigInt(openRequest.upnlPartyA), BigInt(openRequest.upnlPartyB)),
					)

				const closeRequest = limitCloseRequestBuilder().build()
				const requestToCloseCallData = context.partyAFacet.interface.encodeFunctionData("requestToClosePosition", [
					quoteId,
					closeRequest.closePrice,
					closeRequest.quantityToClose,
					closeRequest.orderType,
					await closeRequest.deadline,
				])

				await context.accountHub.connect(context.signers.user)._call(customSubAccountAddress, [requestToCloseCallData])

				const fillCloseRequest = limitFillCloseRequestBuilder().build()
				await context.partyBPositionActionsFacet
					.connect(context.signers.hedger)
					.fillCloseRequest(
						quoteId,
						fillCloseRequest.filledAmount,
						fillCloseRequest.closedPrice,
						await getDummyPairUpnlAndPriceSig(
							BigInt(fillCloseRequest.price),
							BigInt(fillCloseRequest.upnlPartyA),
							BigInt(fillCloseRequest.upnlPartyB),
						),
					)

				const quotesAfterClose = await context.accountHub.getSubAccountQuoteIds(customSubAccountAddress)
				expect(quotesAfterClose.length).to.equal(0)
			})

			it("should remove quoteId from virtualAccount quoteIds and remove virtualAccount", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

				await context.accountHub.connect(context.signers.user)._call(positionSubAccountAddress, [sendQuoteCallData])

				const virtualAccountAddress = (await context.accountHub.getVirtualAccounts(positionSubAccountAddress))[0]

				const quotesBeforeClose = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress)
				expect(quotesBeforeClose.length).to.equal(1)

				const quoteId = quotesBeforeClose[0]
				await hedger.lockQuote(quoteId)

				const openRequest = limitOpenRequestBuilder().build()
				await context.partyBPositionActionsFacet
					.connect(context.signers.hedger)
					.openPosition(
						quoteId,
						openRequest.filledAmount,
						openRequest.openPrice,
						await getDummyPairUpnlAndPriceSig(BigInt(openRequest.price), BigInt(openRequest.upnlPartyA), BigInt(openRequest.upnlPartyB)),
					)

				const closeRequest = limitCloseRequestBuilder().build()
				const requestToCloseCallData = context.partyAFacet.interface.encodeFunctionData("requestToClosePosition", [
					quoteId,
					closeRequest.closePrice,
					closeRequest.quantityToClose,
					closeRequest.orderType,
					await closeRequest.deadline,
				])

				await context.accountHub.connect(context.signers.user)._call(virtualAccountAddress, [requestToCloseCallData])

				const fillCloseRequest = limitFillCloseRequestBuilder().build()
				await context.partyBPositionActionsFacet
					.connect(context.signers.hedger)
					.fillCloseRequest(
						quoteId,
						fillCloseRequest.filledAmount,
						fillCloseRequest.closedPrice,
						await getDummyPairUpnlAndPriceSig(
							BigInt(fillCloseRequest.price),
							BigInt(fillCloseRequest.upnlPartyA),
							BigInt(fillCloseRequest.upnlPartyB),
						),
					)

				const quotesAfterClose = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress)
				const virtualAccountData = await context.accountHub.getVirtualAccountData(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.false
				expect(quotesAfterClose.length).to.equal(0)

				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccountAddress)
				expect(allocatedBalance).to.equal(0n)
			})
		})

		describe("onCancelQuote", async () => {
			let customSubAccountAddress: string
			let positionSubAccountAddress: string

			beforeEach(async () => {
				const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
					{
						name: "EXAMPLE_NAME",
						metadata: ethers.keccak256(toUtf8Bytes("EXAMPLE")),
						symmioCore: context.diamond,
						isolationType: 3,
					},
					{
						name: "EXAMPLE_NAME",
						metadata: ethers.keccak256(toUtf8Bytes("EXAMPLE")),
						symmioCore: context.diamond,
						isolationType: 0,
					},
				]

				await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas)
				const accounts = await context.accountHub.getSubAccounts(context.signers.user)
				customSubAccountAddress = accounts[0]
				positionSubAccountAddress = accounts[1]

				// Deposit funds for all tests
				await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
				await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(customSubAccountAddress, BALANCES.DEPOSIT_AMOUNT)

				await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
				await context.accountFacet.connect(context.signers.user).depositFor(positionSubAccountAddress, BALANCES.DEPOSIT_AMOUNT)
			})

			it("should remove quoteId from subAccount(CUSTOM) quoteIds", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

				await context.accountHub.connect(context.signers.user)._call(customSubAccountAddress, [sendQuoteCallData])

				const quotesBeforeClose = await context.accountHub.getSubAccountQuoteIds(customSubAccountAddress)
				expect(quotesBeforeClose.length).to.equal(1)

				const quoteId = quotesBeforeClose[0]

				const encodedCancelQuote = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quoteId])
				await context.accountHub.connect(context.signers.user)._call(customSubAccountAddress, [encodedCancelQuote])

				const quotesAfterClose = await context.accountHub.getSubAccountQuoteIds(customSubAccountAddress)
				expect(quotesAfterClose.length).to.equal(0)
			})

			it("should remove quoteId from virtualAccount quoteIds and remove virtualAccount", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

				await context.accountHub.connect(context.signers.user)._call(positionSubAccountAddress, [sendQuoteCallData])

				const virtualAccountAddress = (await context.accountHub.getVirtualAccounts(positionSubAccountAddress))[0]

				const quotesBeforeClose = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress)
				expect(quotesBeforeClose.length).to.equal(1)

				const quoteId = quotesBeforeClose[0]
				const encodedCancelQuote = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quoteId])
				await context.accountHub.connect(context.signers.user)._call(virtualAccountAddress, [encodedCancelQuote])

				const quotesAfterClose = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress)
				const virtualAccountData = await context.accountHub.getVirtualAccountData(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.false
				expect(quotesAfterClose.length).to.equal(0)

				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccountAddress)
				expect(allocatedBalance).to.equal(0n)
			})
		})

		describe("hooks", async () => {
			let hookContract: MockAccountHubHook
			let subAccountAddress: string
			let customSubAccountAddress: string

			beforeEach(async () => {
				// Deploy mock hook contract
				const MockHook = await ethers.getContractFactory("MockAccountHubHook")
				hookContract = await MockHook.deploy()
				await hookContract.waitForDeployment()

				const affiliateAddress = await context.accountManager.getAddress()

				await context.affiliateHub.setHook(
					affiliateAddress,
					IAccountHubHook__factory.createInterface().getFunction("onAccountCreation").selector,
					await hookContract.getAddress(),
				)
				await context.affiliateHub.setHook(
					affiliateAddress,
					IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountCreation").selector,
					await hookContract.getAddress(),
				)
				await context.affiliateHub.setHook(
					affiliateAddress,
					IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountDeletion").selector,
					await hookContract.getAddress(),
				)

				const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
					{
						name: "HOOK_TEST_ACCOUNT",
						metadata: ethers.keccak256(toUtf8Bytes("HOOK_TEST")),
						symmioCore: context.diamond,
						isolationType: 0, // POSITION
					},
				]

				await context.accountHub.connect(context.signers.user).createSubAccounts(affiliateAddress, accountDatas)

				const accounts = await context.accountHub.getSubAccounts(context.signers.user)
				subAccountAddress = accounts[accounts.length - 1]

				// Deposit funds
				await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
				await context.accountFacet.connect(context.signers.user).depositFor(subAccountAddress, BALANCES.DEPOSIT_AMOUNT)
			})

			describe("onAccountCreation hook", async () => {
				it("should call onAccountCreation hook when sub-account is created", async () => {
					const callCountBefore = await hookContract.getCallCount(
						IAccountHubHook__factory.createInterface().getFunction("onAccountCreation").selector,
					)

					const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
						{
							name: "NEW_ACCOUNT",
							metadata: ethers.keccak256(toUtf8Bytes("NEW_METADATA")),
							symmioCore: context.diamond,
							isolationType: 1,
						},
					]

					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas)

					const callCountAfter = await hookContract.getCallCount(IAccountHubHook__factory.createInterface().getFunction("onAccountCreation").selector)

					expect(callCountAfter).to.equal(callCountBefore + 1n)
				})

				it("should pass correct data to onAccountCreation hook", async () => {
					const metadata = ethers.keccak256(toUtf8Bytes("TEST_METADATA"))
					const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
						{
							name: "TEST_ACCOUNT",
							metadata: metadata,
							symmioCore: context.diamond,
							isolationType: 2,
						},
					]

					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas)

					const accounts = await context.accountHub.getSubAccounts(context.signers.user)
					const newAccount = accounts[accounts.length - 1]

					expect(await hookContract.wasHookCalledForAccount(newAccount)).to.be.true

					const lastAccount = await hookContract.getLastAccountForSelector(
						IAccountHubHook__factory.createInterface().getFunction("onAccountCreation").selector,
					)
					expect(lastAccount).to.equal(newAccount)
				})

				it("should revert account creation if hook reverts", async () => {
					// Configure hook to revert
					await hookContract.setRevertForSelector(
						IAccountHubHook__factory.createInterface().getFunction("onAccountCreation").selector,
						true,
						"Hook rejected account creation",
					)

					const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
						{
							name: "WILL_FAIL",
							metadata: ethers.keccak256(toUtf8Bytes("FAIL")),
							symmioCore: context.diamond,
							isolationType: 0,
						},
					]

					await expect(
						context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas),
					).to.be.revertedWithCustomError(context.accountHub, "hookFailed")
				})

				it("should continue if no hook is registered", async () => {
					const affData = {
						name: "test affiliate 1",
						brandColor: "d69d00",
						admin: context.signers.admin.address,
						stakeholders: [
							{
								receiver: context.signers.admin.address,
								share: decimal(9n, 17),
							},
						],
						symmioShare: decimal(1n, 17),
						metadata: "0x",
						legacyMultiAccounts: [ZeroAddress],
						symmioCores: [context.diamond],
					}
					const affiliateAddress = await context.affiliateHub.requestToRegisterAffiliate.staticCall(affData)

					await context.affiliateHub.requestToRegisterAffiliate(affData)
					await context.affiliateHub.approveAffiliate(affiliateAddress)

					const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
						{
							name: "NO_HOOK_ACCOUNT",
							metadata: ethers.keccak256(toUtf8Bytes("NO_HOOK")),
							symmioCore: context.diamond,
							isolationType: 0,
						},
					]

					// Should not revert even without hook
					await expect(context.accountHub.connect(context.signers.user).createSubAccounts(affiliateAddress, accountDatas)).to.not.be.reverted
				})
			})

			describe("onVirtualAccountCreation hook", async () => {
				it("should call onVirtualAccountCreation when virtual account is auto-created", async () => {
					const callCountBefore = await hookContract.getCallCount(
						IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountCreation").selector,
					)

					// Send quote to trigger virtual account creation
					const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
					const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

					await context.accountHub.connect(context.signers.user)._call(subAccountAddress, [sendQuoteCallData])

					const callCountAfter = await hookContract.getCallCount(
						IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountCreation").selector,
					)

					expect(callCountAfter).to.equal(callCountBefore + 1n)
				})

				it("should call onVirtualAccountCreation when manually creating virtual account", async () => {
					// Create CUSTOM sub-account
					const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
						{
							name: "CUSTOM_ACCOUNT",
							metadata: ethers.keccak256(toUtf8Bytes("CUSTOM")),
							symmioCore: context.diamond,
							isolationType: 3, // CUSTOM
						},
					]

					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas)

					const accounts = await context.accountHub.getSubAccounts(context.signers.user)
					customSubAccountAddress = accounts[accounts.length - 1]

					const callCountBefore = await hookContract.getCallCount(
						IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountCreation").selector,
					)

					// Manually create virtual account
					await context.accountHub.connect(context.signers.user).createCustomVirtualAccount(
						customSubAccountAddress,
						ethers.keccak256(toUtf8Bytes("MANUAL_VIRTUAL")),
						1, // MARKET
						1, // symbolId
					)

					const callCountAfter = await hookContract.getCallCount(
						IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountCreation").selector,
					)

					expect(callCountAfter).to.equal(callCountBefore + 1n)
				})

				it("should call hook for each virtual account created", async () => {
					// Create CUSTOM account to create multiple virtual accounts
					const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
						{
							name: "CUSTOM_MULTI",
							metadata: ethers.keccak256(toUtf8Bytes("CUSTOM_MULTI")),
							symmioCore: context.diamond,
							isolationType: 3,
						},
					]

					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas)

					const accounts = await context.accountHub.getSubAccounts(context.signers.user)
					const customAccount = accounts[accounts.length - 1]

					const callCountBefore = await hookContract.getCallCount(
						IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountCreation").selector,
					)

					// Create 3 virtual accounts
					await context.accountHub.connect(context.signers.user).createCustomVirtualAccount(customAccount, ethers.keccak256(toUtf8Bytes("V1")), 1, 1)

					await context.accountHub.connect(context.signers.user).createCustomVirtualAccount(customAccount, ethers.keccak256(toUtf8Bytes("V2")), 1, 2)

					await context.accountHub.connect(context.signers.user).createCustomVirtualAccount(customAccount, ethers.keccak256(toUtf8Bytes("V3")), 2, 1)

					const callCountAfter = await hookContract.getCallCount(
						IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountCreation").selector,
					)

					expect(callCountAfter).to.equal(callCountBefore + 3n)
				})

				it("should revert virtual account creation if hook reverts", async () => {
					// Configure hook to revert
					await hookContract.setRevertForSelector(
						IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountCreation").selector,
						true,
						"Hook rejected virtual account",
					)

					const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
					const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

					await expect(context.accountHub.connect(context.signers.user)._call(subAccountAddress, [sendQuoteCallData])).to.be.revertedWithCustomError(
						context.accountHub,
						"hookFailed",
					)
				})
			})

			describe("onVirtualAccountDeletion hook", async () => {
				let virtualAccountAddress: string

				beforeEach(async () => {
					// Create virtual account with a quote
					const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
					const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

					await context.accountHub.connect(context.signers.user)._call(subAccountAddress, [sendQuoteCallData])

					const virtualAccounts = await context.accountHub.getVirtualAccounts(subAccountAddress)
					virtualAccountAddress = virtualAccounts[0]
				})

				it("should call onVirtualAccountDeletion when position is closed", async () => {
					const quotes = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress)
					const quoteId = quotes[0]

					// Lock and open position
					await hedger.lockQuote(quoteId)
					const openRequest = limitOpenRequestBuilder().build()
					await context.partyBPositionActionsFacet
						.connect(context.signers.hedger)
						.openPosition(
							quoteId,
							openRequest.filledAmount,
							openRequest.openPrice,
							await getDummyPairUpnlAndPriceSig(BigInt(openRequest.price), BigInt(openRequest.upnlPartyA), BigInt(openRequest.upnlPartyB)),
						)

					const callCountBefore = await hookContract.getCallCount(
						IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountDeletion").selector,
					)

					// Request to close
					const closeRequest = limitCloseRequestBuilder().build()
					const requestToCloseCallData = context.partyAFacet.interface.encodeFunctionData("requestToClosePosition", [
						quoteId,
						closeRequest.closePrice,
						closeRequest.quantityToClose,
						closeRequest.orderType,
						await closeRequest.deadline,
					])

					await context.accountHub.connect(context.signers.user)._call(virtualAccountAddress, [requestToCloseCallData])

					// Fill close - this should delete virtual account and trigger hook
					const fillCloseRequest = limitFillCloseRequestBuilder().build()
					await context.partyBPositionActionsFacet
						.connect(context.signers.hedger)
						.fillCloseRequest(
							quoteId,
							fillCloseRequest.filledAmount,
							fillCloseRequest.closedPrice,
							await getDummyPairUpnlAndPriceSig(
								BigInt(fillCloseRequest.price),
								BigInt(fillCloseRequest.upnlPartyA),
								BigInt(fillCloseRequest.upnlPartyB),
							),
						)

					const callCountAfter = await hookContract.getCallCount(
						IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountDeletion").selector,
					)

					expect(callCountAfter).to.equal(callCountBefore + 1n)
				})

				it("should call onVirtualAccountDeletion when quote is cancelled", async () => {
					const quotes = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress)
					const quoteId = quotes[0]

					const callCountBefore = await hookContract.getCallCount(
						IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountDeletion").selector,
					)

					const encodedCancelQuote = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quoteId])

					await context.accountHub.connect(context.signers.user)._call(virtualAccountAddress, [encodedCancelQuote])

					const callCountAfter = await hookContract.getCallCount(
						IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountDeletion").selector,
					)

					expect(callCountAfter).to.equal(callCountBefore + 1n)

					const virtualAccountData = await context.accountHub.getVirtualAccountData(virtualAccountAddress)
					expect(virtualAccountData.isExists).to.be.false
				})

				it("should pass correct virtual account address to hook", async () => {
					const quotes = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress)
					const quoteId = quotes[0]

					const encodedCancelQuote = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quoteId])

					await context.accountHub.connect(context.signers.user)._call(virtualAccountAddress, [encodedCancelQuote])

					const lastAccount = await hookContract.getLastAccountForSelector(
						IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountDeletion").selector,
					)
					expect(lastAccount).to.equal(virtualAccountAddress)
				})

				it("should not call hook if virtual account is not deleted", async () => {
					const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
						{
							name: "MARKET_ACCOUNT",
							metadata: ethers.keccak256(toUtf8Bytes("MARKET")),
							symmioCore: context.diamond,
							isolationType: 1, // MARKET
						},
					]

					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas)

					const accounts = await context.accountHub.getSubAccounts(context.signers.user)
					const marketAccount = accounts[accounts.length - 1]

					await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
					await context.accountFacet.connect(context.signers.user).depositFor(marketAccount, BALANCES.DEPOSIT_AMOUNT)

					const quoteRequest1 = limitQuoteRequestBuilder().symbolId(1).build()
					const sendQuoteCallData1 = await createSendQuoteCallData(quoteRequest1)
					await context.accountHub.connect(context.signers.user)._call(marketAccount, [sendQuoteCallData1])

					const virtualAccounts = await context.accountHub.getVirtualAccounts(marketAccount)
					const marketVirtualAccount = virtualAccounts[0]

					await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
					await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(marketVirtualAccount, BALANCES.DEPOSIT_AMOUNT)

					const quoteRequest2 = limitQuoteRequestBuilder().symbolId(1).build()
					const sendQuoteCallData2 = await createSendQuoteCallData(quoteRequest2)
					await context.accountHub.connect(context.signers.user)._call(marketVirtualAccount, [sendQuoteCallData2])

					const callCountBefore = await hookContract.getCallCount(
						IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountDeletion").selector,
					)

					// Cancel only first quote
					const quotes = await context.accountHub.getVirtualAccountQuoteIds(marketVirtualAccount)
					const encodedCancelQuote = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quotes[0]])

					await context.accountHub.connect(context.signers.user)._call(marketVirtualAccount, [encodedCancelQuote])

					const callCountAfter = await hookContract.getCallCount(
						IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountDeletion").selector,
					)

					// Hook should not be called because virtual account still has one quote
					expect(callCountAfter).to.equal(callCountBefore)

					// Virtual account should still exist
					const virtualAccountData = await context.accountHub.getVirtualAccountData(marketVirtualAccount)
					expect(virtualAccountData.isExists).to.be.true
				})

				it.skip("should handle hook revert gracefully during deletion", async () => {
					await hookContract.setRevertForSelector(
						IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountDeletion").selector,
						true,
						"Hook rejected deletion",
					)

					const quotes = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress)
					const quoteId = quotes[0]

					const encodedCancelQuote = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quoteId])

					// Should revert because hook rejects
					await expect(
						context.accountHub.connect(context.signers.user)._call(virtualAccountAddress, [encodedCancelQuote]),
					).to.be.revertedWithCustomError(context.accountHub, "hookFailed")
				})
			})

			describe("pause/unpause", function () {
				let subAccountAddress: string

				beforeEach(async function () {
					const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
						{
							name: "PAUSE_TEST",
							metadata: ethers.keccak256(toUtf8Bytes("PAUSE")),
							symmioCore: context.diamond,
							isolationType: 0,
						},
					]
					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas)
					const accounts = await context.accountHub.getSubAccounts(context.signers.user)
					subAccountAddress = accounts[0]
					await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
					await context.accountFacet.connect(context.signers.user).depositFor(subAccountAddress, BALANCES.DEPOSIT_AMOUNT)
				})

				it("should revert createSubAccounts when paused", async function () {
					await context.accountHub.connect(context.signers.admin).pause()
					const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = [
						{
							name: "PAUSED",
							metadata: ethers.keccak256(toUtf8Bytes("PAUSED")),
							symmioCore: context.diamond,
							isolationType: 0,
						},
					]
					await expect(
						context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas),
					).to.be.revertedWith("Pausable: paused")
				})

				it("should revert _call when paused", async function () {
					await context.accountHub.connect(context.signers.admin).pause()
					const callData: BytesLike[] = [context.accountFacet.interface.encodeFunctionData("allocate", [BALANCES.SMALL_AMOUNT])]
					await expect(context.accountHub.connect(context.signers.user)._call(subAccountAddress, callData)).to.be.revertedWith("Pausable: paused")
				})

				it("should allow actions after unpause", async function () {
					await context.accountHub.connect(context.signers.admin).pause()
					await context.accountHub.connect(context.signers.admin).unpause()
					const callData: BytesLike[] = [context.accountFacet.interface.encodeFunctionData("allocate", [BALANCES.SMALL_AMOUNT])]
					await expect(context.accountHub.connect(context.signers.user)._call(subAccountAddress, callData)).to.not.be.reverted
				})
			})
		})
	})
}
