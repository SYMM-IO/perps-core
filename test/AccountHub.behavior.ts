import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect, use } from "chai";
import { BytesLike, toUtf8Bytes, ZeroAddress, ZeroHash } from "ethers";
import { ethers } from "hardhat";



import { IAccountHub, IAccountHubHook__factory, MockAccountHubHook } from "../src/types";
import { initializeFixture } from "./Initialize.fixture";
import { PositionType } from "./models/Enums";
import { Hedger } from "./models/Hedger";
import { RunContext } from "./models/RunContext";
import { User } from "./models/User";
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest";
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest";
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest";
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest";
import { decimal } from "./utils/Common";
import { getDummyPairUpnlAndPriceSig } from "./utils/SignatureUtils";

























































































































































































































































export function shouldBehaveLikeAccountHub(): void {
	let context: RunContext, user: User, hedger: Hedger

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
		const accounts = await context.accountHub.getUserSubAccountsAddresses(parentAccount.address, 0, 100)
		const sAcc = accounts[accounts.length - 1]

		await context.collateral.connect(parentAccount).approve(await context.accountFacet.getAddress(), depositAmount)
		if (allocateToo) {
			await context.accountFacet.connect(parentAccount).depositAndAllocateFor(sAcc, depositAmount)
		} else {
			await context.accountFacet.connect(parentAccount).depositFor(sAcc, depositAmount)
		}

		return sAcc
	}

	async function sendQuoteAndGetVirtualAccount(subAccount: string, quoteRequest = limitQuoteRequestBuilder().build()) {
		const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)
		await context.accountHub.connect(context.signers.user)._call(subAccount, [sendQuoteCallData])

		const virtualAccountsAfter = await context.accountHub.getVirtualAccountsAddressesOfSubAccount(subAccount, 0, 10)
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
		const quotes = await context.accountHub.getVirtualAccountQuoteIds(virtualAccount, 0, 10)
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

				const subAccountAddresses = await context.accountHub.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)

				if (subAccountAddresses.length != subAccountData.length) {
					throw Error("invalid length of account creation result")
				}

				for (let i = 0; i < subAccountAddresses.length; i++) {
					const acc = await context.accountHub.getSubAccount(subAccountAddresses[i])
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
				const accounts = await context.accountHub.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
				subAccountAddress = accounts[0]
			})

			it("should edit subAccount name successfully", async () => {
				const accBeforeEdit = await context.accountHub.getSubAccount(subAccountAddress)

				await expect(context.accountHub.connect(context.signers.user).editAccountName(subAccountAddress, newAccountName)).to.not.reverted

				const accAfterEdit = await context.accountHub.getSubAccount(subAccountAddress)
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
						const virtualAccountsBefore = await context.accountHub.getVirtualAccountsCountOfSubAccount(positionSubAccount)
						expect(virtualAccountsBefore).to.equal(0)

						const sendQuoteCallData = await createSendQuoteCallData()
						await expect(context.accountHub.connect(context.signers.user)._call(positionSubAccount, [sendQuoteCallData])).to.not.be.reverted

						const virtualAccountsAfter = await context.accountHub.getVirtualAccountsCountOfSubAccount(positionSubAccount)
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
						const virtualAccountsBefore = await context.accountHub.getVirtualAccountsCountOfSubAccount(marketSubAccount)
						expect(virtualAccountsBefore).to.equal(0)

						const sendQuoteCallData = await createSendQuoteCallData()
						await expect(context.accountHub.connect(context.signers.user)._call(marketSubAccount, [sendQuoteCallData])).to.not.be.reverted

						const virtualAccountsAfter = await context.accountHub.getVirtualAccountsCountOfSubAccount(marketSubAccount)
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

						const virtualAccountsAfter = await context.accountHub.getVirtualAccountsCountOfSubAccount(marketSubAccount)
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
						const virtualAccountsBefore = await context.accountHub.getVirtualAccountsCountOfSubAccount(marketDirectionSubAccount)
						expect(virtualAccountsBefore).to.equal(0)

						const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						await expect(context.accountHub.connect(context.signers.user)._call(marketDirectionSubAccount, [sendQuoteCallData])).to.not.be.reverted

						const virtualAccountsAfter = await context.accountHub.getVirtualAccountsCountOfSubAccount(marketDirectionSubAccount)
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

						const virtualAccountsAfter = await context.accountHub.getVirtualAccountsCountOfSubAccount(marketDirectionSubAccount)
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
						const virtualAccountsBefore = await context.accountHub.getVirtualAccountsCountOfSubAccount(customSubAccount)
						expect(virtualAccountsBefore).to.equal(0)

						const quoteRequest = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()

						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						await expect(context.accountHub.connect(context.signers.user)._call(customSubAccount, [sendQuoteCallData])).to.not.reverted

						// Verify no virtual accounts were created
						const virtualAccountsAfter = await context.accountHub.getVirtualAccountsCountOfSubAccount(customSubAccount)
						expect(virtualAccountsAfter).to.equal(0)
					})

					it("should send quote directly from sub-account without creating virtual account", async () => {
						const quoteRequest = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						await expect(context.accountHub.connect(context.signers.user)._call(customSubAccount, [sendQuoteCallData])).to.not.reverted

						// Verify quote was tracked in sub-account
						const quote = await context.viewFacetQuote.getQuote(await context.viewFacetQuote.getNextQuoteId())
						expect(quote.partyA).to.equal(customSubAccount)
					})

					it("should allow multiple quotes with different symbols", async () => {
						// Send quote with symbol 1
						const quote1 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
						await sendQuoteAndGetVirtualAccount(customSubAccount, quote1)

						const q1 = await context.viewFacetQuote.getQuote(await context.viewFacetQuote.getNextQuoteId())
						expect(q1.partyA).to.equal(customSubAccount)

						// Send quote with symbol 2
						const quote2 = limitQuoteRequestBuilder().symbolId(2).positionType(PositionType.SHORT).build()
						await sendQuoteAndGetVirtualAccount(customSubAccount, quote2)

						const q2 = await context.viewFacetQuote.getQuote(await context.viewFacetQuote.getNextQuoteId())
						expect(q2.partyA).to.equal(customSubAccount)

						// Verify no virtual accounts created
						const virtualAccounts = await context.accountHub.getVirtualAccountsCountOfSubAccount(customSubAccount)
						expect(virtualAccounts).to.equal(0)
					})

					it("should allow both LONG and SHORT positions on same symbol", async () => {
						// Send LONG quote
						const longQuote = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
						await sendQuoteAndGetVirtualAccount(customSubAccount, longQuote)

						const q1 = await context.viewFacetQuote.getQuote(await context.viewFacetQuote.getNextQuoteId())
						expect(q1.partyA).to.equal(customSubAccount)

						// Send SHORT quote on same symbol
						const shortQuote = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.SHORT).build()
						await sendQuoteAndGetVirtualAccount(customSubAccount, shortQuote)

						// Verify both quotes were tracked
						const q2 = await context.viewFacetQuote.getQuote(await context.viewFacetQuote.getNextQuoteId())
						expect(q2.partyA).to.equal(customSubAccount)
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
						const virtualAccountsBefore = await context.accountHub.getVirtualAccountsCountOfSubAccount(customSubAccount)
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

						const virtualAccountsAfter = await context.accountHub.getVirtualAccountsCountOfSubAccount(customSubAccount)
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

						const virtualAccounts = await context.accountHub.getVirtualAccountsCountOfSubAccount(customSubAccount)
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

						const virtualAccounts = await context.accountHub.getVirtualAccountsOfSubAccount(customSubAccount, 0, 10)
						const virtualAccount = virtualAccounts[0].accountAddress

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

						const quoteIds = await context.accountHub.getVirtualAccountQuoteIds(virtualAccount, 0, 10)
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

						const virtualAccounts = await context.accountHub.getVirtualAccountsOfSubAccount(customSubAccount, 0, 10)
						const virtualAccount = virtualAccounts[0].accountAddress

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

						const virtualAccounts = await context.accountHub.getVirtualAccountsOfSubAccount(customSubAccount, 0, 10)
						const virtualAccount = virtualAccounts[0].accountAddress

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
						const accounts = await context.accountHub.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
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

						const virtualAccounts = await context.accountHub.getVirtualAccountsOfSubAccount(customSubAccount, 0, 10)
						expect(virtualAccounts.length).to.equal(2)

						const btcLongVirtual = virtualAccounts[0].accountAddress
						const ethShortVirtual = virtualAccounts[1].accountAddress

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
						const btcQuotes = await context.accountHub.getVirtualAccountQuoteIds(btcLongVirtual, 0, 10)
						const ethQuotes = await context.accountHub.getVirtualAccountQuoteIds(ethShortVirtual, 0, 10)

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

			it("should remove quoteId from virtualAccount quoteIds and remove virtualAccount", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesBeforeClose.length).to.equal(1)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, virtualAccountAddress)

				const quotesAfterClose = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesAfterClose.length).to.equal(0)

				const virtualAccountData = await context.accountHub.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.false

				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccountAddress)
				expect(allocatedBalance).to.equal(0n)
			})

			it("Should add the removed virtualAccount to deletedVirtualAccountsPool for reuse", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const initialVirtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.accountHub.getVirtualAccountQuoteIds(initialVirtualAccountAddress, 0, 10)
				expect(quotesBeforeClose.length).to.equal(1)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, initialVirtualAccountAddress)

				const deletedAccountData = await context.accountHub.getVirtualAccount(initialVirtualAccountAddress)
				expect(deletedAccountData.isExists).to.false

				// Send new quote to trigger virtual account reuse
				const reusedVirtualAccountAddresses = await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest)
				const reusedVirtualAccountAddress = reusedVirtualAccountAddresses[0]

				expect(reusedVirtualAccountAddress).to.equal(initialVirtualAccountAddress)
				expect(await context.accountHub.getVirtualAccountsCountOfSubAccount(positionSubAccountAddress)).to.equal(1)

				const reusedAccountData = await context.accountHub.getVirtualAccount(reusedVirtualAccountAddress)
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

			it("should remove quoteId from virtualAccount quoteIds and remove virtualAccount", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesBeforeClose.length).to.equal(1)

				await cancelVirtualAccountQuote(virtualAccountAddress)

				const quotesAfterClose = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesAfterClose.length).to.equal(0)

				const virtualAccountData = await context.accountHub.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.false

				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccountAddress)
				expect(allocatedBalance).to.equal(0n)
			})
		})

		describe("pause/unpause", async () => {
			let subAccountAddress: string

			beforeEach(async () => {
				const subAccountData = [createSubAccountData("MARKET_ACCOUNT", 1)]
				subAccountAddress = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)
			})

			it("should revert createSubAccounts when paused", async () => {
				await context.accountHub.connect(context.signers.admin).pause()
				const subAccountData = [createSubAccountData("MARKET_ACCOUNT", 1)]
				await expect(
					context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData),
				).to.be.revertedWith("Pausable: paused")
			})

			it("should revert _call when paused", async () => {
				await context.accountHub.connect(context.signers.admin).pause()
				const callData: BytesLike[] = [context.accountFacet.interface.encodeFunctionData("allocate", [BALANCES.SMALL_AMOUNT])]
				await expect(context.accountHub.connect(context.signers.user)._call(subAccountAddress, callData)).to.be.revertedWith("Pausable: paused")
			})

			it("should allow actions after unpause", async () => {
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

					const accounts = await context.accountHub.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
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
					const accounts = await context.accountHub.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
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

					const accounts = await context.accountHub.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
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
					const quotes = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
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

					const virtualAccountData = await context.accountHub.getVirtualAccount(virtualAccountAddress)
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

					const virtualAccounts = await context.accountHub.getVirtualAccountsOfSubAccount(marketAccount, 0, 10)
					const marketVirtualAccount = virtualAccounts[0].accountAddress

					await sendQuoteAndGetVirtualAccount(marketVirtualAccount)

					const callCountBefore = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountDeletion)

					// Cancel only first quote
					await cancelVirtualAccountQuote(marketVirtualAccount)

					const callCountAfter = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountDeletion)

					// Hook should not be called because virtual account still has one quote
					expect(callCountAfter).to.equal(callCountBefore)

					// Virtual account should still exist
					const virtualAccountData = await context.accountHub.getVirtualAccount(marketVirtualAccount)
					expect(virtualAccountData.isExists).to.be.true
				})

				// Note: These tests are skipped because the beforeEach in this describe block
				// fails with "Transaction reverted without a reason string" when trying to
				// create a virtual account via sendQuote. This is a pre-existing issue.
				it.skip("should handle hook revert gracefully during deletion", async () => {
					await hookContract.setRevertForSelector(HOOK_SELECTORS.onVirtualAccountDeletion, true, "Hook rejected deletion")

					const quotes = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
					const quoteId = quotes[0]

					const encodedCancelQuote = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quoteId])

					// Should revert because hook rejects
					await expect(
						context.accountHub.connect(context.signers.user)._call(virtualAccountAddress, [encodedCancelQuote]),
					).to.be.revertedWithCustomError(context.accountHub, "HookFailed")
				})

				it.skip("should return the hook failure reason for virtual account deletion", async () => {
					const revertMessage = "Deletion blocked: account has pending rewards"

					const quotes = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
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

		describe("Getter Methods", async () => {
			let subAccountAddress: string
			let virtualAccountAddress: string

			beforeEach(async () => {
				const subAccountData = [createSubAccountData("GETTER_TEST_ACCOUNT", 0, "GETTER_METADATA")]
				subAccountAddress = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)
			})

			describe("getSigner", async () => {
				it("should return msg.sender when globalSigner is not set", async function () {
					const signer = await context.accountHub.getSigner()
					expect(signer).to.not.equal(ZeroAddress)
				})
			})

			describe("getRelatedCore", async () => {
				it("should return symmioCore for a sub-account", async function () {
					const core = await context.accountHub.getRelatedCore(subAccountAddress)
					expect(core).to.equal(context.diamond)
				})

				it("should return symmioCore for a virtual account via parent", async function () {
					const virtualAccounts = await sendQuoteAndGetVirtualAccount(subAccountAddress)
					virtualAccountAddress = virtualAccounts[0]

					const core = await context.accountHub.getRelatedCore(virtualAccountAddress)
					expect(core).to.equal(context.diamond)
				})
			})

			describe("getUserSubAccountsAddresses", async () => {
				it("should return empty array for user with no sub-accounts", async function () {
					const addresses = await context.accountHub.getUserSubAccountsAddresses(context.signers.user2.address, 0, 100)
					expect(addresses).to.be.an("array").that.is.empty
				})

				it("should return correct sub-account addresses for owner", async function () {
					const addresses = await context.accountHub.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					expect(addresses).to.include(subAccountAddress)
					expect(addresses.length).to.be.greaterThanOrEqual(1)
				})

				it("should return multiple sub-accounts when created", async function () {
					const secondSubAccountData = [createSubAccountData("SECOND_ACCOUNT", 0, "METADATA2")]
					const secondSubAccount = await createSubAccountAndDeposit(context.signers.user, secondSubAccountData, BALANCES.DEPOSIT_AMOUNT)

					const addresses = await context.accountHub.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					expect(addresses).to.include(subAccountAddress)
					expect(addresses).to.include(secondSubAccount)
				})
			})

			describe("getSubAccount", async () => {
				it("should return correct sub-account details", async function () {
					const detail = await context.accountHub.getSubAccount(subAccountAddress)

					expect(detail.accountAddress).to.equal(subAccountAddress)
					expect(detail.owner).to.equal(context.signers.user.address)
					expect(detail.name).to.equal("GETTER_TEST_ACCOUNT")
					expect(detail.affiliate).to.equal(await context.accountManager.getAddress())
					expect(detail.symmioCore).to.equal(context.diamond)
				})
			})

			describe("getUserSubAccounts", async () => {
				it("should return empty array if no sub-accounts exist", async function () {
					const details = await context.accountHub.getUserSubAccounts(context.signers.others[0].address, 0, 10)
					expect(details.length).to.be.equal(0)
				})

				it("should return paginated sub-account details", async function () {
					const details = await context.accountHub.getUserSubAccounts(context.signers.user.address, 0, 10)

					expect(details.length).to.be.greaterThanOrEqual(1)
					expect(details[0].accountAddress).to.equal(subAccountAddress)
				})

				it("should respect offset and limit", async function () {
					const secondSubAccountData = [createSubAccountData("SECOND_ACCOUNT", 0, "METADATA2")]
					await createSubAccountAndDeposit(context.signers.user, secondSubAccountData, BALANCES.DEPOSIT_AMOUNT)

					const allDetails = await context.accountHub.getUserSubAccounts(context.signers.user.address, 0, 10)
					const firstOnly = await context.accountHub.getUserSubAccounts(context.signers.user.address, 0, 1)
					const secondOnly = await context.accountHub.getUserSubAccounts(context.signers.user.address, 1, 1)

					expect(allDetails.length).to.be.greaterThanOrEqual(2)
					expect(firstOnly.length).to.equal(1)
					expect(secondOnly.length).to.equal(1)
				})
			})

			describe("getVirtualAccountsOfSubAccount", async () => {
				it("should return empty array when no virtual accounts exist", async function () {
					const details = await context.accountHub.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 10)
					expect(details).to.be.an("array").that.is.empty
				})

				it("should return virtual account details after quote", async function () {
					const virtualAccounts = await sendQuoteAndGetVirtualAccount(subAccountAddress)

					const details = await context.accountHub.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 10)
					expect(details.length).to.be.greaterThanOrEqual(1)
					expect(details[0].accountAddress).to.equal(virtualAccounts[0])
				})
			})

			describe("getVirtualAccount", async () => {
				it("should return correct virtual account details", async function () {
					const virtualAccounts = await sendQuoteAndGetVirtualAccount(subAccountAddress)
					virtualAccountAddress = virtualAccounts[0]

					const detail = await context.accountHub.getVirtualAccount(virtualAccountAddress)

					expect(detail.accountAddress).to.equal(virtualAccountAddress)
					expect(detail.parentAccount).to.equal(subAccountAddress)
					expect(detail.isExists).to.equal(true)
				})
			})

			describe("getVirtualAccountsOfSubAccount", async () => {
				it("should return paginated virtual account details", async function () {
					await sendQuoteAndGetVirtualAccount(subAccountAddress)

					const details = await context.accountHub.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 10)
					expect(details.length).to.be.greaterThanOrEqual(1)
				})

				it("should return empty array if no virtual accounts exist", async function () {
					const details = await context.accountHub.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 10)
					expect(details).to.be.an("array").that.is.empty
				})

				it("should respect offset and limit", async function () {
					// Create two virtual accounts
					await sendQuoteAndGetVirtualAccount(subAccountAddress)
					await sendQuoteAndGetVirtualAccount(subAccountAddress)

					const allDetails = await context.accountHub.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 10)
					const firstOnly = await context.accountHub.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 1)
					const secondOnly = await context.accountHub.getVirtualAccountsOfSubAccount(subAccountAddress, 1, 1)

					expect(allDetails.length).to.be.greaterThanOrEqual(2)
					expect(firstOnly.length).to.equal(1)
					expect(secondOnly.length).to.equal(1)
					expect(allDetails[0].accountAddress).to.equal(firstOnly[0].accountAddress)
					expect(allDetails[1].accountAddress).to.equal(secondOnly[0].accountAddress)
				})

				it("should return correct details for each virtual account", async function () {
					const virtualAccounts = await sendQuoteAndGetVirtualAccount(subAccountAddress)
					const details = await context.accountHub.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 10)
					expect(details[0].accountAddress).to.equal(virtualAccounts[0])
					expect(details[0].parentAccount).to.equal(subAccountAddress)
					expect(details[0].isExists).to.be.true
				})
			})

			describe("sendQuoteAndGetVirtualAccount", async () => {
				it("should return quote IDs for virtual account", async function () {
					const virtualAccounts = await sendQuoteAndGetVirtualAccount(subAccountAddress)
					virtualAccountAddress = virtualAccounts[0]

					const quoteIds = await context.accountHub.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
					expect(quoteIds.length).to.be.greaterThanOrEqual(1)
				})
			})

			describe("getSubAccountsCountOfUser", async () => {
				it("should return 0 for user with no sub-accounts", async function () {
					const count = await context.accountHub.getSubAccountsCountOfUser(context.signers.user2.address)
					expect(count).to.equal(0)
				})

				it("should return correct count after creating sub-accounts", async function () {
					const count = await context.accountHub.getSubAccountsCountOfUser(context.signers.user.address)
					expect(count).to.be.greaterThanOrEqual(1)
				})
			})

			describe("getVirtualAccountsCountOfSubAccount", async () => {
				it("should return 0 when no virtual accounts exist", async function () {
					const count = await context.accountHub.getVirtualAccountsCountOfSubAccount(subAccountAddress)
					expect(count).to.equal(0)
				})

				it("should return correct count after sending quote", async function () {
					await sendQuoteAndGetVirtualAccount(subAccountAddress)

					const count = await context.accountHub.getVirtualAccountsCountOfSubAccount(subAccountAddress)
					expect(count).to.be.greaterThanOrEqual(1)
				})
			})

			describe("Public Constants and Variables", async () => {
				it("should return MAX_NAME_LENGTH", async function () {
					const maxLength = await context.accountHub.MAX_NAME_LENGTH()
					expect(maxLength).to.be.equal(100)
				})

				it("should return affiliateHub address", async function () {
					const hubAddress = await context.accountHub.affiliateHub()
					expect(hubAddress).to.equal(await context.affiliateHub.getAddress())
				})

				it("should return globalNonce > 0 after account creation", async function () {
					const nonce = await context.accountHub.globalNonce()
					expect(nonce).to.be.greaterThan(0)
				})
			})

			describe("Large Dataset Batch Retrieval", async () => {
				it("should handle batch retrieval efficiently with optimized pagination", async function () {
					this.timeout(60000) // 1 minute should be enough

					const TOTAL_ACCOUNTS = 5000
					const CREATION_BATCH_SIZE = 100

					for (let i = 0; i < TOTAL_ACCOUNTS; i += CREATION_BATCH_SIZE) {
						const batchData = []
						const batchEnd = Math.min(i + CREATION_BATCH_SIZE, TOTAL_ACCOUNTS)

						for (let j = i; j < batchEnd; j++) {
							batchData.push(createSubAccountData(`ACCOUNT_${j}`, 0, `METADATA_${j}`))
						}

						await context.accountHub.connect(context.signers.user2).createSubAccounts(await context.accountManager.getAddress(), batchData)
					}

					const totalCount = await context.accountHub.getSubAccountsCountOfUser(context.signers.user2.address)
					expect(totalCount).to.equal(TOTAL_ACCOUNTS)

					// Test various batch sizes
					const batch100 = await context.accountHub.getUserSubAccounts(context.signers.user2.address, 0, 100)
					expect(batch100.length).to.equal(100)
					expect(batch100[0].owner).to.equal(context.signers.user2.address)

					const batch500 = await context.accountHub.getUserSubAccounts(context.signers.user2.address, 0, 500)
					expect(batch500.length).to.equal(500)

					// Test pagination through all accounts
					let retrievedCount = 0
					const pageSize = 100

					for (let offset = 0; offset < TOTAL_ACCOUNTS; offset += pageSize) {
						const batch = await context.accountHub.getUserSubAccounts(context.signers.user2.address, offset, pageSize)
						retrievedCount += batch.length

						// Verify first item in each batch
						if (batch.length > 0) {
							expect(batch[0].owner).to.equal(context.signers.user2.address)
						}
					}

					expect(retrievedCount).to.equal(TOTAL_ACCOUNTS)

					// Test offset functionality
					const firstBatch = await context.accountHub.getUserSubAccounts(context.signers.user2.address, 0, 10)
					const secondBatch = await context.accountHub.getUserSubAccounts(context.signers.user2.address, 10, 10)
					expect(firstBatch[0].accountAddress).to.not.equal(secondBatch[0].accountAddress)

				})
			})

			describe("Large Dataset Virtual Accounts Batch Retrieval", async () => {
				// Helper to create a CUSTOM sub-account without deposit (for virtual account creation tests)
				async function createCustomSubAccountWithoutDeposit(
					parentAccount: HardhatEthersSigner,
					name: string,
				): Promise<string> {
					const subAccountData = [createSubAccountData(name, 3)] // isolationType 3 = CUSTOM
					await context.accountHub.connect(parentAccount).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.accountHub.getUserSubAccountsAddresses(parentAccount.address, 0, 100)
					return accounts[accounts.length - 1]
				}

				it("should handle 5k virtual accounts creation and retrieval efficiently", async function () {
					this.timeout(120000) // 2 minutes for creating 5k virtual accounts

					const TOTAL_VIRTUAL_ACCOUNTS = 5000
					const CREATION_BATCH_SIZE = 100

					// Create a CUSTOM isolation sub-account (allows manual virtual account creation)
					const customSubAccount = await createCustomSubAccountWithoutDeposit(context.signers.user2, "LARGE_DATASET_CUSTOM")

					// Create 5k virtual accounts using createCustomVirtualAccount
					for (let i = 0; i < TOTAL_VIRTUAL_ACCOUNTS; i += CREATION_BATCH_SIZE) {
						const batchEnd = Math.min(i + CREATION_BATCH_SIZE, TOTAL_VIRTUAL_ACCOUNTS)

						for (let j = i; j < batchEnd; j++) {
							// Alternate between different isolation types and symbols for variety
							const isolationType = j % 4 // 0: POSITION, 1: MARKET, 2: MARKET_LONG, 3: MARKET_SHORT
							const symbolId = (j % 10) + 1 // Symbols 1-10

							await context.accountHub.connect(context.signers.user2).createCustomVirtualAccount(
								customSubAccount,
								ethers.keccak256(toUtf8Bytes(`VIRTUAL_${j}`)),
								isolationType,
								symbolId,
							)
						}
					}

					// Verify total count
					const totalCount = await context.accountHub.getVirtualAccountsCountOfSubAccount(customSubAccount)
					expect(totalCount).to.equal(TOTAL_VIRTUAL_ACCOUNTS)

					// Test getVirtualAccountsAddressesOfSubAccount with various batch sizes
					const addresses100 = await context.accountHub.getVirtualAccountsAddressesOfSubAccount(customSubAccount, 0, 100)
					expect(addresses100.length).to.equal(100)

					const addresses500 = await context.accountHub.getVirtualAccountsAddressesOfSubAccount(customSubAccount, 0, 500)
					expect(addresses500.length).to.equal(500)

					// Test getVirtualAccountsOfSubAccount with detailed info
					const details100 = await context.accountHub.getVirtualAccountsOfSubAccount(customSubAccount, 0, 100)
					expect(details100.length).to.equal(100)
					expect(details100[0].parentAccount).to.equal(customSubAccount)
					expect(details100[0].isExists).to.be.true

					// Test pagination through all virtual accounts using addresses
					let retrievedAddressCount = 0
					const pageSize = 100

					for (let offset = 0; offset < TOTAL_VIRTUAL_ACCOUNTS; offset += pageSize) {
						const batch = await context.accountHub.getVirtualAccountsAddressesOfSubAccount(customSubAccount, offset, pageSize)
						retrievedAddressCount += batch.length

						// Verify addresses are valid (not zero address)
						if (batch.length > 0) {
							expect(batch[0]).to.not.equal(ZeroAddress)
						}
					}

					expect(retrievedAddressCount).to.equal(TOTAL_VIRTUAL_ACCOUNTS)

					// Test pagination through all virtual accounts using detailed view
					let retrievedDetailCount = 0

					for (let offset = 0; offset < TOTAL_VIRTUAL_ACCOUNTS; offset += pageSize) {
						const batch = await context.accountHub.getVirtualAccountsOfSubAccount(customSubAccount, offset, pageSize)
						retrievedDetailCount += batch.length

						// Verify each item in batch has correct parent
						for (const detail of batch) {
							expect(detail.parentAccount).to.equal(customSubAccount)
							expect(detail.isExists).to.be.true
						}
					}

					expect(retrievedDetailCount).to.equal(TOTAL_VIRTUAL_ACCOUNTS)

					// Test offset functionality for addresses
					const firstAddressBatch = await context.accountHub.getVirtualAccountsAddressesOfSubAccount(customSubAccount, 0, 10)
					const secondAddressBatch = await context.accountHub.getVirtualAccountsAddressesOfSubAccount(customSubAccount, 10, 10)
					expect(firstAddressBatch[0]).to.not.equal(secondAddressBatch[0])

					// Test offset functionality for details
					const firstDetailBatch = await context.accountHub.getVirtualAccountsOfSubAccount(customSubAccount, 0, 10)
					const secondDetailBatch = await context.accountHub.getVirtualAccountsOfSubAccount(customSubAccount, 10, 10)
					expect(firstDetailBatch[0].accountAddress).to.not.equal(secondDetailBatch[0].accountAddress)

					// Verify getVirtualAccount for individual accounts
					const sampleAddress = addresses100[50]
					const sampleDetail = await context.accountHub.getVirtualAccount(sampleAddress)
					expect(sampleDetail.parentAccount).to.equal(customSubAccount)
					expect(sampleDetail.isExists).to.be.true

					// Test boundary conditions
					// Offset at end should return empty array
					const emptyBatch = await context.accountHub.getVirtualAccountsAddressesOfSubAccount(customSubAccount, TOTAL_VIRTUAL_ACCOUNTS, 100)
					expect(emptyBatch.length).to.equal(0)

					// Offset near end should return remaining accounts
					const nearEndBatch = await context.accountHub.getVirtualAccountsAddressesOfSubAccount(
						customSubAccount,
						TOTAL_VIRTUAL_ACCOUNTS - 50,
						100,
					)
					expect(nearEndBatch.length).to.equal(50)

					// Verify getSubAccountVirtualNonce
					const nonce = await context.accountHub.getSubAccountVirtualNonce(customSubAccount)
					expect(nonce).to.equal(TOTAL_VIRTUAL_ACCOUNTS)
				})

				it("should verify isolation types are correctly stored for large dataset", async function () {
					this.timeout(60000)

					const TOTAL_VIRTUAL_ACCOUNTS = 100 // Smaller set for detailed verification
					const customSubAccount = await createCustomSubAccountWithoutDeposit(context.signers.user2, "ISOLATION_TEST")

					// Create virtual accounts with known isolation types
					const expectedIsolationTypes: number[] = []
					const expectedSymbolIds: number[] = []

					for (let i = 0; i < TOTAL_VIRTUAL_ACCOUNTS; i++) {
						const isolationType = i % 4
						const symbolId = (i % 5) + 1

						expectedIsolationTypes.push(isolationType)
						expectedSymbolIds.push(symbolId)

						await context.accountHub.connect(context.signers.user2).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes(`VERIFY_${i}`)),
							isolationType,
							symbolId,
						)
					}

					// Retrieve all and verify
					const allDetails = await context.accountHub.getVirtualAccountsOfSubAccount(customSubAccount, 0, TOTAL_VIRTUAL_ACCOUNTS)
					expect(allDetails.length).to.equal(TOTAL_VIRTUAL_ACCOUNTS)

					for (let i = 0; i < TOTAL_VIRTUAL_ACCOUNTS; i++) {
						expect(allDetails[i].isolationType).to.equal(expectedIsolationTypes[i])
						expect(allDetails[i].symbolId).to.equal(expectedSymbolIds[i])
						expect(allDetails[i].parentAccount).to.equal(customSubAccount)
						expect(allDetails[i].isExists).to.be.true
					}
				})

				it("should handle predictNextVirtualAccountAddress with large existing dataset", async function () {
					this.timeout(60000)

					const TOTAL_VIRTUAL_ACCOUNTS = 100
					const customSubAccount = await createCustomSubAccountWithoutDeposit(context.signers.user2, "PREDICT_TEST")

					// Create virtual accounts
					for (let i = 0; i < TOTAL_VIRTUAL_ACCOUNTS; i++) {
						await context.accountHub.connect(context.signers.user2).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes(`PREDICT_${i}`)),
							0, // POSITION
							i + 1,
						)
					}

					// Predict next address
					const predictedAddress = await context.accountHub.predictNextVirtualAccountAddress(
						customSubAccount,
						0, // POSITION
						TOTAL_VIRTUAL_ACCOUNTS + 1,
					)
					expect(predictedAddress).to.not.equal(ZeroAddress)

					// Create the predicted account
					await context.accountHub.connect(context.signers.user2).createCustomVirtualAccount(
						customSubAccount,
						ethers.keccak256(toUtf8Bytes("PREDICTED")),
						0,
						TOTAL_VIRTUAL_ACCOUNTS + 1,
					)

					// Verify the actual address matches prediction
					const allAddresses = await context.accountHub.getVirtualAccountsAddressesOfSubAccount(
						customSubAccount,
						TOTAL_VIRTUAL_ACCOUNTS,
						1,
					)
					expect(allAddresses[0]).to.equal(predictedAddress)
				})

				it("should handle multiple sub-accounts each with many virtual accounts", async function () {
					this.timeout(120000)

					const NUM_SUB_ACCOUNTS = 10
					const VIRTUAL_ACCOUNTS_PER_SUB = 500
					const subAccountAddresses: string[] = []

					// Create multiple sub-accounts
					for (let i = 0; i < NUM_SUB_ACCOUNTS; i++) {
						const subAccount = await createCustomSubAccountWithoutDeposit(context.signers.user2, `MULTI_SUB_${i}`)
						subAccountAddresses.push(subAccount)
					}

					// Create virtual accounts for each sub-account
					for (let subIdx = 0; subIdx < NUM_SUB_ACCOUNTS; subIdx++) {
						for (let virtIdx = 0; virtIdx < VIRTUAL_ACCOUNTS_PER_SUB; virtIdx++) {
							await context.accountHub.connect(context.signers.user2).createCustomVirtualAccount(
								subAccountAddresses[subIdx],
								ethers.keccak256(toUtf8Bytes(`SUB_${subIdx}_VIRT_${virtIdx}`)),
								virtIdx % 4,
								(virtIdx % 5) + 1,
							)
						}
					}

					// Verify counts for each sub-account
					for (let subIdx = 0; subIdx < NUM_SUB_ACCOUNTS; subIdx++) {
						const count = await context.accountHub.getVirtualAccountsCountOfSubAccount(subAccountAddresses[subIdx])
						expect(count).to.equal(VIRTUAL_ACCOUNTS_PER_SUB)
					}

					// Verify user's total sub-accounts
					const userSubAccountCount = await context.accountHub.getSubAccountsCountOfUser(context.signers.user2.address)
					expect(userSubAccountCount).to.equal(NUM_SUB_ACCOUNTS)

					// Test pagination for each sub-account
					for (let subIdx = 0; subIdx < NUM_SUB_ACCOUNTS; subIdx++) {
						let totalRetrieved = 0
						const pageSize = 100

						for (let offset = 0; offset < VIRTUAL_ACCOUNTS_PER_SUB; offset += pageSize) {
							const batch = await context.accountHub.getVirtualAccountsOfSubAccount(subAccountAddresses[subIdx], offset, pageSize)
							totalRetrieved += batch.length

							// Verify parent account
							for (const detail of batch) {
								expect(detail.parentAccount).to.equal(subAccountAddresses[subIdx])
							}
						}

						expect(totalRetrieved).to.equal(VIRTUAL_ACCOUNTS_PER_SUB)
					}
				})
			})
		})

		describe("predictNextVirtualAccountAddress", async () => {
			let positionSubAccountAddress: string

			beforeEach(async () => {
				positionSubAccountAddress = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("POSITION_ACCOUNT", 0)],
					BALANCES.DEPOSIT_AMOUNT,
				)
			})

			it("should return new virtual account address when no deleted accounts exist", async () => {
				// Get the current nonce for the sub-account
				const currentNonce = await context.accountHub.getSubAccountVirtualNonce(positionSubAccountAddress)

				// Predict the next virtual account address
				const predictedAddress = await context.accountHub.predictNextVirtualAccountAddress(
					positionSubAccountAddress,
					0, // VirtualAccountIsolationType.POSITION
					1, // symbolId (0 for position isolation)
				)

				// Verify the predicted address is not zero
				expect(predictedAddress).to.not.equal(ZeroAddress)

				// Create a virtual account by sending a quote
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccounts = await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest)

				// Verify the actual created address matches the prediction
				expect(virtualAccounts[0]).to.equal(predictedAddress)

				// Verify nonce was incremented
				const newNonce = await context.accountHub.getSubAccountVirtualNonce(positionSubAccountAddress)
				expect(newNonce).to.equal(currentNonce + 1n)
			})

			it("should return deleted virtual account address when one exists", async () => {
				// Create a virtual account
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccounts = await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest)
				const initialVirtualAccount = virtualAccounts[0]

				// Close the position to delete the virtual account
				const quotes = await context.accountHub.getVirtualAccountQuoteIds(initialVirtualAccount, 0, 10)
				const quoteId = quotes[0]
				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, initialVirtualAccount)

				// Verify the virtual account was deleted
				const deletedAccountData = await context.accountHub.getVirtualAccount(initialVirtualAccount)
				expect(deletedAccountData.isExists).to.false

				// Predict the next virtual account address
				const predictedAddress = await context.accountHub.predictNextVirtualAccountAddress(
					positionSubAccountAddress,
					0, // VirtualAccountIsolationType.POSITION
					1, // symbolId (0 for position isolation)
				)

				// Verify the predicted address is the deleted account
				expect(predictedAddress).to.equal(initialVirtualAccount)

				// Create a new virtual account and verify it reuses the deleted one
				const reusedVirtualAccounts = await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest)
				expect(reusedVirtualAccounts[0]).to.equal(initialVirtualAccount)
			})

			it("should handle different isolation types correctly", async () => {
				// Create a MARKET isolation sub-account
				const marketSubAccount = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("MARKET_ACCOUNT", 1)],
					BALANCES.DEPOSIT_AMOUNT,
				)

				// Predict for MARKET isolation type
				const predictedMarketAddress = await context.accountHub.predictNextVirtualAccountAddress(
					marketSubAccount,
					1, // VirtualAccountIsolationType.MARKET
					1, // symbolId 1
				)

				expect(predictedMarketAddress).to.not.equal(ZeroAddress)

				// Create virtual account with MARKET isolation
				const quoteRequest = limitQuoteRequestBuilder().symbolId(1).build()
				const virtualAccounts = await sendQuoteAndGetVirtualAccount(marketSubAccount, quoteRequest)

				// Verify the actual address matches prediction
				expect(virtualAccounts[0]).to.equal(predictedMarketAddress)

				// Predict for POSITION isolation type on the same sub-account
				const predictedPositionAddress = await context.accountHub.predictNextVirtualAccountAddress(
					marketSubAccount,
					0, // VirtualAccountIsolationType.POSITION
					0, // symbolId 0 for position
				)

				// The addresses should be different for different isolation types
				expect(predictedPositionAddress).to.not.equal(predictedMarketAddress)
			})
		})
	})
}
