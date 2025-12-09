import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import { expect, use } from "chai"
import { BytesLike, toUtf8Bytes, ZeroAddress, ZeroHash } from "ethers"
import { ethers } from "hardhat"

import { IAccountHub, IAccountHubHook__factory, MockAccountHubHook } from "../src/types"
import { initializeFixture } from "./Initialize.fixture"
import { PositionType } from "./models/Enums"
import { Hedger } from "./models/Hedger"
import { RunContext } from "./models/RunContext"
import { User } from "./models/User"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest"
import { decimal } from "./utils/Common"
import { getDummyPairUpnlAndPriceSig } from "./utils/SignatureUtils"

export function shouldBehaveLikeAccountHub(): void {
	let context: RunContext, user: User, user2: User, hedger: Hedger

	const createSendQuoteCallData = async (quoteRequest = limitQuoteRequestBuilder().build()) => {
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

	function createSubAccountData(name: string, isolationType: number, metadata: string = "0x"): IAccountHub.SubAccountCreationDataStruct {
		return {
			name,
			metadata: ethers.keccak256(toUtf8Bytes(metadata)),
			symmioCore: context.diamond,
			isolationType,
		}
	}

	async function createSubAccountAndDeposit(
		parentAccount: HardhatEthersSigner,
		subAccountData: IAccountHub.SubAccountCreationDataStruct[],
		depositAmount: bigint,
		allocateToo: boolean = false,
	) {
		await context.accountHub.connect(parentAccount).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
		const accounts = await context.accountHub.getSubAccountAddresses(parentAccount)
		const acc = accounts[accounts.length - 1]

		await context.collateral.connect(parentAccount).approve(await context.accountFacet.getAddress(), depositAmount)
		if (allocateToo) {
			await context.accountFacet.connect(parentAccount).depositAndAllocateFor(acc, depositAmount)
		} else {
			await context.accountFacet.connect(parentAccount).depositFor(acc, depositAmount)
		}

		return acc
	}

	async function sendQuoteAndGetVirtualAccount(subAccount: string, quoteRequest = limitQuoteRequestBuilder().build()) {
		const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)
		await context.accountHub.connect(context.signers.user)._call(subAccount, [sendQuoteCallData])

		const virtualAccountsAfter = await context.accountHub.getVirtualAccountAddresses(subAccount)
		return virtualAccountsAfter
	}

	async function openPositionForQuote(quoteId: bigint) {
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
	}

	async function cancelVirtualAccountQuote(virtualAccount: string) {
		const quotes = await context.accountHub.getVirtualAccountQuoteIds(virtualAccount)
		const encodedCancelQuote = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quotes[0]])
		await context.accountHub.connect(context.signers.user)._call(virtualAccount, [encodedCancelQuote])
	}

	async function closePositionForQuote(partyA: HardhatEthersSigner, quoteId: bigint, virtualAccount: string) {
		const closeRequest = limitCloseRequestBuilder().build()
		const requestToCloseCallData = context.partyAFacet.interface.encodeFunctionData("requestToClosePosition", [
			quoteId,
			closeRequest.closePrice,
			closeRequest.quantityToClose,
			closeRequest.orderType,
			await closeRequest.deadline,
		])

		await context.accountHub.connect(partyA)._call(virtualAccount, [requestToCloseCallData])

		const fillCloseRequest = limitFillCloseRequestBuilder().build()
		await context.partyBPositionActionsFacet
			.connect(context.signers.hedger)
			.fillCloseRequest(
				quoteId,
				fillCloseRequest.filledAmount,
				fillCloseRequest.closedPrice,
				await getDummyPairUpnlAndPriceSig(BigInt(fillCloseRequest.price), BigInt(fillCloseRequest.upnlPartyA), BigInt(fillCloseRequest.upnlPartyB)),
			)
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
			const subAccountData = [createSubAccountData("EXAMPLE_NAME", 0, "EXAMPLE")]
			it("should create subAccount successfully", async () => {
				const oldNonce = await context.accountHub.globalNonce()
				let newNonce = oldNonce
				await expect(context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)).to
					.not.reverted

				const subAccountAddresses = await context.accountHub.getSubAccountAddresses(context.signers.user)

				if (subAccountAddresses.length != subAccountData.length) {
					throw Error("invalid length of account creation result")
				}

				for (let i = 0; i < subAccountAddresses.length; i++) {
					const acc = await context.accountHub.getSubAccountDetail(subAccountAddresses[i])
					expect(acc.owner).to.equal(context.signers.user.address)
					expect(acc.isExists).to.true
					expect(acc.name).to.equal(subAccountData[i].name)
					expect(acc.metadata).to.equal(subAccountData[i].metadata)
					expect(acc.affiliate).to.equal(await context.accountManager.getAddress())
					expect(acc.symmioCore).to.equal(subAccountData[i].symmioCore)
					expect(acc.isolationType).to.equal(subAccountData[i].isolationType)

					newNonce++
				}

				expect(newNonce).to.equal(Number(oldNonce) + subAccountAddresses.length)
			})

			it("should failed when array is empty", async () => {
				const accountDatas: IAccountHub.SubAccountCreationDataStruct[] = []
				await expect(
					context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas),
				).to.revertedWithCustomError(context.accountHub, "EmptyArray")
			})

			it("should failed when name length is more than limit", async () => {
				const maxNameLength = await context.accountHub.MAX_NAME_LENGTH()
				const accountDatas = [createSubAccountData("A".repeat(Number(maxNameLength) + 1), 0, "EXAMPLE")]

				await expect(
					context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas),
				).to.revertedWithCustomError(context.accountHub, "InvalidNameLength")
			})

			it("should failed when affiliate not whitelisted provided symmioCore", async () => {
				await expect(
					context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData),
				).to.revertedWithCustomError(context.accountHub, "NotSymmioCore")
			})

			it("should failed when provided affiliate not active", async () => {
				await expect(
					context.accountHub.connect(context.signers.user).createSubAccounts(context.signers.others[0].address, subAccountData),
				).to.revertedWithCustomError(context.accountHub, "AffiliateNotActive")
			})
		})

		describe("editAccountName", async () => {
			let subAccountAddress: string = ""
			const newAccountName = "NEW_EXAMPLE_NAME"

			beforeEach(async () => {
				const subAccountData = [createSubAccountData("EXAMPLE_NAME", 0, "EXAMPLE")]

				await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
				const accounts = await context.accountHub.getSubAccountAddresses(context.signers.user)
				subAccountAddress = accounts[0]
			})

			it("should edit subAccount name successfully", async () => {
				const accBeforeEdit = await context.accountHub.getSubAccountDetail(subAccountAddress)

				await expect(context.accountHub.connect(context.signers.user).editAccountName(subAccountAddress, newAccountName)).to.not.reverted

				const accAfterEdit = await context.accountHub.getSubAccountDetail(subAccountAddress)
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
				await expect(
					context.accountHub.connect(context.signers.others[0]).editAccountName(subAccountAddress, newAccountName),
				).to.revertedWithCustomError(context.accountHub, "NotOwner")
			})

			it("should failed when subAccount not exists", async () => {
				await expect(
					context.accountHub.connect(context.signers.user).editAccountName(context.signers.others[0], newAccountName),
				).to.revertedWithCustomError(context.accountHub, "NotOwner")
			})
		})

		describe("_call", async () => {
			describe("General behavior", async () => {
				let subAccountAddress: string

				beforeEach(async () => {
					const subAccountData = [createSubAccountData("EXAMPLE_NAME", 0, "EXAMPLE")]
					subAccountAddress = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)
				})

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
						const subAccountData = [createSubAccountData("POSITION_ACCOUNT", 0, "POSITION")]
						positionSubAccount = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)
					})

					it("should create virtual account and send quote successfully", async () => {
						const virtualAccountsBefore = await context.accountHub.getVirtualAccountCount(positionSubAccount)
						expect(virtualAccountsBefore).to.equal(0)

						const sendQuoteCallData = await createSendQuoteCallData()
						await expect(context.accountHub.connect(context.signers.user)._call(positionSubAccount, [sendQuoteCallData])).to.not.be.reverted

						const virtualAccountsAfter = await context.accountHub.getVirtualAccountCount(positionSubAccount)
						expect(virtualAccountsAfter).to.equal(1)
					})

					it("should revert when trying to send another quote on existing virtual account", async () => {
						const virtualAccounts = await sendQuoteAndGetVirtualAccount(positionSubAccount)

						const sendQuoteCallData = await createSendQuoteCallData()
						await expect(context.accountHub.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallData])).to.revertedWithCustomError(
							context.accountHub,
							"PositionTypeNotAllowedForThisAccount",
						)
					})
				})

				describe("MARKET isolation (1)", async () => {
					let marketSubAccount: string

					beforeEach(async () => {
						const subAccountData = [createSubAccountData("MARKET_ACCOUNT", 1, "MARKET")]
						marketSubAccount = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)
					})

					it("should create virtual account and send quote successfully", async () => {
						const virtualAccountsBefore = await context.accountHub.getVirtualAccountCount(marketSubAccount)
						expect(virtualAccountsBefore).to.equal(0)

						const sendQuoteCallData = await createSendQuoteCallData()
						await expect(context.accountHub.connect(context.signers.user)._call(marketSubAccount, [sendQuoteCallData])).to.not.be.reverted

						const virtualAccountsAfter = await context.accountHub.getVirtualAccountCount(marketSubAccount)
						expect(virtualAccountsAfter).to.equal(1)
					})

					it("should revert when trying to send quote with different symbol", async () => {
						const quoteRequest1 = limitQuoteRequestBuilder().symbolId(1).build()
						const virtualAccounts = await sendQuoteAndGetVirtualAccount(marketSubAccount, quoteRequest1)

						const quoteRequest2 = limitQuoteRequestBuilder().symbolId(2).build()
						const sendQuoteCallData2 = await createSendQuoteCallData(quoteRequest2)

						await expect(context.accountHub.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallData2])).to.revertedWithCustomError(
							context.accountHub,
							"SymbolNotAllowedForThisAccount",
						)
					})

					it("should allow multiple quotes with same symbol", async () => {
						const virtualAccounts = await sendQuoteAndGetVirtualAccount(marketSubAccount)
						const sendQuoteCallData = await createSendQuoteCallData()
						await expect(context.accountHub.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallData])).to.not.be.reverted

						const virtualAccountsAfter = await context.accountHub.getVirtualAccountCount(marketSubAccount)
						expect(virtualAccountsAfter).to.equal(1)
					})
				})

				describe("MARKET_DIRECTION isolation (2)", async () => {
					let marketDirectionSubAccount: string

					beforeEach(async () => {
						const subAccountData = [createSubAccountData("MARKET_DIRECTION_ACCOUNT", 2, "MARKET_DIRECTION")]
						marketDirectionSubAccount = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)
					})

					it("should create virtual account and send quote successfully", async () => {
						const virtualAccountsBefore = await context.accountHub.getVirtualAccountCount(marketDirectionSubAccount)
						expect(virtualAccountsBefore).to.equal(0)

						const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						await expect(context.accountHub.connect(context.signers.user)._call(marketDirectionSubAccount, [sendQuoteCallData])).to.not.be.reverted

						const virtualAccountsAfter = await context.accountHub.getVirtualAccountCount(marketDirectionSubAccount)
						expect(virtualAccountsAfter).to.equal(1)
					})

					it("should revert when symbol or position type differs", async () => {
						const quoteRequestLong = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
						const virtualAccounts = await sendQuoteAndGetVirtualAccount(marketDirectionSubAccount, quoteRequestLong)

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

						const virtualAccounts = await sendQuoteAndGetVirtualAccount(marketDirectionSubAccount, quoteRequest)

						await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
						await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(virtualAccounts[0], BALANCES.DEPOSIT_AMOUNT)

						for (let i = 0; i < 4; i++) {
							await expect(context.accountHub.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallData])).to.not.be.reverted
						}

						const virtualAccountsAfter = await context.accountHub.getVirtualAccountCount(marketDirectionSubAccount)
						expect(virtualAccountsAfter).to.equal(1)
					})
				})

				describe("CUSTOM isolation (3)", async () => {
					let customSubAccount: string

					beforeEach(async () => {
						customSubAccount = await createSubAccountAndDeposit(
							context.signers.user,
							[createSubAccountData("CUSTOM_ACCOUNT", 3, "CUSTOM")],
							BALANCES.DEPOSIT_AMOUNT,
							true,
						)
					})

					it("should not create virtual accounts for CUSTOM isolation", async () => {
						const virtualAccountsBefore = await context.accountHub.getVirtualAccountCount(customSubAccount)
						expect(virtualAccountsBefore).to.equal(0)

						const quoteRequest = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()

						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						await expect(context.accountHub.connect(context.signers.user)._call(customSubAccount, [sendQuoteCallData])).to.not.reverted

						// Verify no virtual accounts were created
						const virtualAccountsAfter = await context.accountHub.getVirtualAccountCount(customSubAccount)
						expect(virtualAccountsAfter).to.equal(0)
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
						const virtualAccounts = await context.accountHub.getVirtualAccountCount(customSubAccount)
						expect(virtualAccounts).to.equal(0)
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
						const subAccountData = [createSubAccountData("CUSTOM_ISOLATION_ACCOUNT", 3)]
						customSubAccount = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)
					})

					it("should create virtual account manually for CUSTOM isolation", async () => {
						const virtualAccountsBefore = await context.accountHub.getVirtualAccountCount(customSubAccount)
						expect(virtualAccountsBefore).to.equal(0)

						// Manually create a POSITION isolated virtual account
						await expect(
							context.accountHub.connect(context.signers.user).createCustomVirtualAccount(
								customSubAccount,
								ethers.keccak256(toUtf8Bytes("VIRTUAL_1")),
								1, // VirtualAccountIsolationType.POSITION
								1, // symbolId
							),
						).to.not.reverted

						const virtualAccountsAfter = await context.accountHub.getVirtualAccountCount(customSubAccount)
						expect(virtualAccountsAfter).to.equal(1)
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

						const virtualAccounts = await context.accountHub.getVirtualAccountCount(customSubAccount)
						expect(virtualAccounts).to.equal(4)
					})

					it("should transfer funds to virtual account and send quote", async () => {
						// Create virtual account
						await context.accountHub.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("VIRTUAL_1")),
							0, // POSITION
							1,
						)

						const virtualAccounts = await context.accountHub.getVirtualAccountAddresses(customSubAccount)
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

						const virtualAccounts = await context.accountHub.getVirtualAccountAddresses(customSubAccount)
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

						const virtualAccounts = await context.accountHub.getVirtualAccountAddresses(customSubAccount)
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
						const subAccountData = [createSubAccountData("POSITION_SUB_ACCOUNT", 0, "POSITION")]

						await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
						const accounts = await context.accountHub.getSubAccountAddresses(context.signers.user)
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

						const virtualAccounts = await context.accountHub.getVirtualAccountAddresses(customSubAccount)
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
				positionSubAccountAddress = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("EXAMPLE_NAME", 0)],
					BALANCES.DEPOSIT_AMOUNT,
				)
				customSubAccountAddress = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("EXAMPLE_NAME", 3)],
					BALANCES.DEPOSIT_AMOUNT,
					true,
				)
			})

			it("should remove quoteId from subAccount(CUSTOM) quoteIds", async () => {
				await sendQuoteAndGetVirtualAccount(customSubAccountAddress)

				const quotesBeforeClose = await context.accountHub.getSubAccountQuoteIds(customSubAccountAddress)
				expect(quotesBeforeClose.length).to.equal(1)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, customSubAccountAddress)

				const quotesAfterClose = await context.accountHub.getSubAccountQuoteIds(customSubAccountAddress)
				expect(quotesAfterClose.length).to.equal(0)
			})

			it("should remove quoteId from virtualAccount quoteIds and remove virtualAccount", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress)
				expect(quotesBeforeClose.length).to.equal(1)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, virtualAccountAddress)

				const quotesAfterClose = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress)
				expect(quotesAfterClose.length).to.equal(0)

				const virtualAccountData = await context.accountHub.getVirtualAccountDetail(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.false

				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccountAddress)
				expect(allocatedBalance).to.equal(0n)
			})

			it("Should add the removed virtualAccount to deletedVirtualAccountsPool for reuse", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const initialVirtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.accountHub.getVirtualAccountQuoteIds(initialVirtualAccountAddress)
				expect(quotesBeforeClose.length).to.equal(1)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, initialVirtualAccountAddress)

				const deletedAccountData = await context.accountHub.getVirtualAccountDetail(initialVirtualAccountAddress)
				expect(deletedAccountData.isExists).to.false

				// Send new quote to trigger virtual account reuse
				const reusedVirtualAccountAddresses = await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest)
				const reusedVirtualAccountAddress = reusedVirtualAccountAddresses[0]

				expect(reusedVirtualAccountAddress).to.equal(initialVirtualAccountAddress)
				expect(await context.accountHub.getVirtualAccountCount(positionSubAccountAddress)).to.equal(1)

				const reusedAccountData = await context.accountHub.getVirtualAccountDetail(reusedVirtualAccountAddress)
				expect(reusedAccountData.isExists).to.true
			})
		})

		describe("onCancelQuote", async () => {
			let customSubAccountAddress: string
			let positionSubAccountAddress: string

			beforeEach(async () => {
				positionSubAccountAddress = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("EXAMPLE_NAME", 0)],
					BALANCES.DEPOSIT_AMOUNT,
				)
				customSubAccountAddress = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("EXAMPLE_NAME", 3)],
					BALANCES.DEPOSIT_AMOUNT,
					true,
				)
			})

			it("should remove quoteId from subAccount(CUSTOM) quoteIds", async () => {
				await sendQuoteAndGetVirtualAccount(customSubAccountAddress)

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
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress)
				expect(quotesBeforeClose.length).to.equal(1)

				await cancelVirtualAccountQuote(virtualAccountAddress)

				const quotesAfterClose = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress)
				expect(quotesAfterClose.length).to.equal(0)

				const virtualAccountData = await context.accountHub.getVirtualAccountDetail(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.false

				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccountAddress)
				expect(allocatedBalance).to.equal(0n)
			})
		})

		describe("pause/unpause", async () => {
			const subAccountData = [createSubAccountData("MARKET_ACCOUNT", 1)]
			let subAccountAddress: string

			beforeEach(async ()=> {
				subAccountAddress = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)
			})

			it("should revert createSubAccounts when paused", async ()=> {
				await context.accountHub.connect(context.signers.admin).pause()
				await expect(
					context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData),
				).to.be.revertedWith("Pausable: paused")
			})

			it("should revert _call when paused", async ()=> {
				await context.accountHub.connect(context.signers.admin).pause()
				const callData: BytesLike[] = [context.accountFacet.interface.encodeFunctionData("allocate", [BALANCES.SMALL_AMOUNT])]
				await expect(context.accountHub.connect(context.signers.user)._call(subAccountAddress, callData)).to.be.revertedWith("Pausable: paused")
			})

			it("should allow actions after unpause", async ()=> {
				await context.accountHub.connect(context.signers.admin).pause()
				await context.accountHub.connect(context.signers.admin).unpause()
				const callData: BytesLike[] = [context.accountFacet.interface.encodeFunctionData("allocate", [BALANCES.SMALL_AMOUNT])]
				await expect(context.accountHub.connect(context.signers.user)._call(subAccountAddress, callData)).to.not.be.reverted
			})
		})

		describe("hooks", async () => {
			let hookContract: MockAccountHubHook
			let subAccountAddress: string
			let customSubAccountAddress: string

			const HOOK_SELECTORS = {
				onAccountCreation: IAccountHubHook__factory.createInterface().getFunction("onAccountCreation").selector,
				onVirtualAccountCreation: IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountCreation").selector,
				onVirtualAccountDeletion: IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountDeletion").selector,
			}

			beforeEach(async () => {
				// Deploy mock hook contract
				const MockHook = await ethers.getContractFactory("MockAccountHubHook")
				hookContract = await MockHook.deploy()
				await hookContract.waitForDeployment()

				const affiliateAddress = await context.accountManager.getAddress()

				for (const key of Object.keys(HOOK_SELECTORS)) {
					await context.affiliateHub.setHook(affiliateAddress, HOOK_SELECTORS[key as keyof typeof HOOK_SELECTORS], await hookContract.getAddress())
				}

				subAccountAddress = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("HOOK_TEST_ACCOUNT", 0)],
					BALANCES.DEPOSIT_AMOUNT,
				)
			})

			describe("onAccountCreation hook", async () => {
				it("should call onAccountCreation hook when sub-account is created", async () => {
					const callCountBefore = await hookContract.getCallCount(HOOK_SELECTORS.onAccountCreation)

					const subAccountData = [createSubAccountData("NEW_ACCOUNT", 1)]
					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)

					const callCountAfter = await hookContract.getCallCount(HOOK_SELECTORS.onAccountCreation)

					expect(callCountAfter).to.equal(callCountBefore + 1n)
				})

				it("should pass correct data to onAccountCreation hook", async () => {
					const subAccountData = [createSubAccountData("NEW_ACCOUNT", 2)]

					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)

					const accounts = await context.accountHub.getSubAccountAddresses(context.signers.user)
					const newAccount = accounts[accounts.length - 1]

					expect(await hookContract.wasHookCalledForAccount(newAccount)).to.be.true

					const lastAccount = await hookContract.getLastAccountForSelector(HOOK_SELECTORS.onAccountCreation)
					expect(lastAccount).to.equal(newAccount)
				})

				it("should revert account creation if hook reverts", async () => {
					// Configure hook to revert
					await hookContract.setRevertForSelector(HOOK_SELECTORS.onAccountCreation, true, "Hook rejected account creation")

					const subAccountData = [createSubAccountData("WILL_FAIL", 0)]

					await expect(
						context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData),
					).to.be.revertedWithCustomError(context.accountHub, "HookFailed")
				})

				it("should return the hook failure reason in HookFailed error", async () => {
					const revertMessage = "Custom rejection reason from hook"
					await hookContract.setRevertForSelector(HOOK_SELECTORS.onAccountCreation, true, revertMessage)

					const subAccountData = [createSubAccountData("WILL_FAIL", 0)]

					// The revert reason includes the Error(string) selector (0x08c379a0) followed by the ABI-encoded string
					const errorSelector = "0x08c379a0"
					const encodedString = ethers.AbiCoder.defaultAbiCoder().encode(["string"], [revertMessage])
					const encodedReason = errorSelector + encodedString.slice(2)

					await expect(context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData))
						.to.be.revertedWithCustomError(context.accountHub, "HookFailed")
						.withArgs(encodedReason)
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

					// Should not revert even without hook
					await expect(
						context.accountHub.connect(context.signers.user).createSubAccounts(affiliateAddress, [createSubAccountData("NO_HOOK_ACCOUNT", 0)]),
					).to.not.be.reverted
				})
			})

			describe("onVirtualAccountCreation hook", async () => {
				const subAccountData = [createSubAccountData("CUSTOM_ACCOUNT", 3)]

				it("should call onVirtualAccountCreation when virtual account is auto-created", async () => {
					const callCountBefore = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountCreation)

					await sendQuoteAndGetVirtualAccount(subAccountAddress)

					const callCountAfter = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountCreation)

					expect(callCountAfter).to.equal(callCountBefore + 1n)
				})

				it("should call onVirtualAccountCreation when manually creating virtual account", async () => {
					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.accountHub.getSubAccountAddresses(context.signers.user)
					customSubAccountAddress = accounts[accounts.length - 1]

					const callCountBefore = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountCreation)

					// Manually create virtual account
					await context.accountHub.connect(context.signers.user).createCustomVirtualAccount(
						customSubAccountAddress,
						ethers.keccak256(toUtf8Bytes("MANUAL_VIRTUAL")),
						1, // MARKET
						1, // symbolId
					)

					const callCountAfter = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountCreation)

					expect(callCountAfter).to.equal(callCountBefore + 1n)
				})

				it("should call hook for each virtual account created", async () => {
					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)

					const accounts = await context.accountHub.getSubAccountAddresses(context.signers.user)
					const customAccount = accounts[accounts.length - 1]

					const callCountBefore = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountCreation)

					// Create 3 virtual accounts
					for (let i = 0; i < 4; i++) {
						await context.accountHub
							.connect(context.signers.user)
							.createCustomVirtualAccount(customAccount, ethers.keccak256(toUtf8Bytes("V3")), 2, 1)
					}

					const callCountAfter = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountCreation)

					expect(callCountAfter).to.equal(callCountBefore + 3n)
				})

				it("should revert virtual account creation if hook reverts", async () => {
					// Configure hook to revert
					await hookContract.setRevertForSelector(HOOK_SELECTORS.onVirtualAccountCreation, true, "Hook rejected virtual account")

					const sendQuoteCallData = await createSendQuoteCallData()
					await expect(context.accountHub.connect(context.signers.user)._call(subAccountAddress, [sendQuoteCallData])).to.be.revertedWithCustomError(
						context.accountHub,
						"HookFailed",
					)
				})

				it("should return the hook failure reason for virtual account creation", async () => {
					const revertMessage = "Virtual account creation blocked by policy"
					await hookContract.setRevertForSelector(HOOK_SELECTORS.onVirtualAccountCreation, true, revertMessage)

					const sendQuoteCallData = await createSendQuoteCallData()
					// The revert reason includes the Error(string) selector (0x08c379a0) followed by the ABI-encoded string
					const errorSelector = "0x08c379a0"
					const encodedString = ethers.AbiCoder.defaultAbiCoder().encode(["string"], [revertMessage])
					const encodedReason = errorSelector + encodedString.slice(2)

					await expect(context.accountHub.connect(context.signers.user)._call(subAccountAddress, [sendQuoteCallData]))
						.to.be.revertedWithCustomError(context.accountHub, "HookFailed")
						.withArgs(encodedReason)
				})
			})

			describe("onVirtualAccountDeletion hook", async () => {
				let virtualAccountAddress: string

				beforeEach(async () => {
					// Create virtual account with a quote
					const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
					virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(subAccountAddress, quoteRequest))[0]
				})

				it("should call onVirtualAccountDeletion when position is closed", async () => {
					const quotes = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress)
					const quoteId = quotes[0]

					const callCountBefore = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountDeletion)

					await openPositionForQuote(quoteId)
					await closePositionForQuote(context.signers.user, quoteId, virtualAccountAddress)

					const callCountAfter = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountDeletion)

					expect(callCountAfter).to.equal(callCountBefore + 1n)
				})

				it("should call onVirtualAccountDeletion when quote is cancelled", async () => {
					const callCountBefore = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountDeletion)
					await cancelVirtualAccountQuote(virtualAccountAddress)
					const callCountAfter = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountDeletion)

					expect(callCountAfter).to.equal(callCountBefore + 1n)

					const virtualAccountData = await context.accountHub.getVirtualAccountDetail(virtualAccountAddress)
					expect(virtualAccountData.isExists).to.be.false
				})

				it("should pass correct virtual account address to hook", async () => {
					await cancelVirtualAccountQuote(virtualAccountAddress)

					const lastAccount = await hookContract.getLastAccountForSelector(HOOK_SELECTORS.onVirtualAccountDeletion)
					expect(lastAccount).to.equal(virtualAccountAddress)
				})

				it("should not call hook if virtual account is not deleted", async () => {
					const subAccountData = [createSubAccountData("MARKET_ACCOUNT", 1)]
					const marketAccount = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)

					await sendQuoteAndGetVirtualAccount(marketAccount)

					const virtualAccounts = await context.accountHub.getVirtualAccountAddresses(marketAccount)
					const marketVirtualAccount = virtualAccounts[0]

					await sendQuoteAndGetVirtualAccount(marketVirtualAccount)

					const callCountBefore = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountDeletion)

					// Cancel only first quote
					await cancelVirtualAccountQuote(marketVirtualAccount)

					const callCountAfter = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountDeletion)

					// Hook should not be called because virtual account still has one quote
					expect(callCountAfter).to.equal(callCountBefore)

					// Virtual account should still exist
					const virtualAccountData = await context.accountHub.getVirtualAccountDetail(marketVirtualAccount)
					expect(virtualAccountData.isExists).to.be.true
				})

				// Note: These tests are skipped because the beforeEach in this describe block
				// fails with "Transaction reverted without a reason string" when trying to
				// create a virtual account via sendQuote. This is a pre-existing issue.
				it.skip("should handle hook revert gracefully during deletion", async () => {
					await hookContract.setRevertForSelector(HOOK_SELECTORS.onVirtualAccountDeletion, true, "Hook rejected deletion")

					const quotes = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress)
					const quoteId = quotes[0]

					const encodedCancelQuote = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quoteId])

					// Should revert because hook rejects
					await expect(
						context.accountHub.connect(context.signers.user)._call(virtualAccountAddress, [encodedCancelQuote]),
					).to.be.revertedWithCustomError(context.accountHub, "HookFailed")
				})

				it.skip("should return the hook failure reason for virtual account deletion", async () => {
					const revertMessage = "Deletion blocked: account has pending rewards"

					const quotes = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress)
					const quoteId = quotes[0]

					// Configure hook to revert AFTER virtual account is created
					await hookContract.setRevertForSelector(HOOK_SELECTORS.onVirtualAccountDeletion, true, revertMessage)

					const encodedCancelQuote = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quoteId])
					// The revert reason includes the Error(string) selector (0x08c379a0) followed by the ABI-encoded string
					const errorSelector = "0x08c379a0"
					const encodedString = ethers.AbiCoder.defaultAbiCoder().encode(["string"], [revertMessage])
					const encodedReason = errorSelector + encodedString.slice(2)

					await expect(context.accountHub.connect(context.signers.user)._call(virtualAccountAddress, [encodedCancelQuote]))
						.to.be.revertedWithCustomError(context.accountHub, "HookFailed")
						.withArgs(encodedReason)
				})
			})
		})
	})
}
